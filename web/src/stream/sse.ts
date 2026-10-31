// Client for the engine's `GET /events` and `GET /state` (docs/interfaces.md §2). A connection is both: the stream
// carries what happens next, and `/state` carries what the engine already holds (the journal, the mode, and the
// latest of each type), so a page that opens late, or reconnects after the engine restarted, draws at once.
import type { EngineState, StreamEvent } from '@gimbal/shared';
import { parseStreamEvent, type StreamAction } from './store.ts';

/** The part of `EventSource` the client uses, so a test can stand in for the browser's. */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface SseOptions {
  /** Reads `GET /state`; it runs each time the stream opens. */
  readState: () => Promise<EngineState>;
  url?: string;
  /** How long to wait before the next attempt, after `attempt` failures in a row (0 = the first). */
  backoff?: (attempt: number) => number;
  /** Opens the stream; the browser's `EventSource` unless a test says otherwise. */
  open?: (url: string) => EventSourceLike;
}

/** 1 s, 2 s, 4 s, 8 s, then every 15 s: the engine is on this machine, so a restart is back within seconds. */
export function backoffMs(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, attempt));
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Opens the stream and keeps it open; returns a function that closes it.
 *
 * Each attempt opens `/events` first and reads `/state` once it is open. Events that arrive meanwhile wait, and are
 * applied after the state, so nothing the engine published between the two is lost. Any failure closes the stream and
 * tries again after a growing wait; the browser's own retry is not used, because it never reads `/state` again.
 * Until the first state is in, the connection is `connecting` (or `retrying` after a failure) and never `open`.
 */
export function connectSse(dispatch: (action: StreamAction) => void, options: SseOptions): () => void {
  const url = options.url ?? '/events';
  const backoff = options.backoff ?? backoffMs;
  const openStream = options.open ?? ((target: string): EventSourceLike => new EventSource(target));
  let current: EventSourceLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failures = 0;

  const status = (connection: 'connecting' | 'open' | 'retrying' | 'idle', error?: string) =>
    dispatch({ kind: 'connection', source: 'sse', connection, ...(error === undefined ? {} : { error }) });

  const fail = (stream: EventSourceLike, error: string) => {
    if (stopped || current !== stream) return;
    stream.close();
    current = null;
    status('retrying', error);
    timer = setTimeout(connect, backoff(failures));
    failures += 1;
  };

  function connect(): void {
    if (stopped) return;
    status(failures === 0 ? 'connecting' : 'retrying');
    const stream = openStream(url);
    current = stream;
    const waiting: StreamEvent[] = [];
    let seeded = false;

    stream.onmessage = (message) => {
      if (current !== stream) return;
      const event = typeof message.data === 'string' ? parseStreamEvent(message.data) : null;
      if (!event) return dispatch({ kind: 'rejected', at: Date.now() });
      if (seeded) dispatch({ kind: 'event', event, at: Date.now() });
      else waiting.push(event);
    };
    stream.onopen = () => {
      options.readState().then(
        (state) => {
          if (current !== stream) return;
          dispatch({ kind: 'state', state, at: Date.now() });
          seeded = true;
          for (const event of waiting.splice(0)) dispatch({ kind: 'event', event, at: Date.now() });
          failures = 0;
          status('open');
        },
        (error: unknown) => fail(stream, messageOf(error)),
      );
    };
    stream.onerror = () => fail(stream, 'GET /events: the connection closed');
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    current?.close();
    current = null;
    status('idle');
  };
}
