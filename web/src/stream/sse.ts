// Client for the engine's `GET /events` (docs/interfaces.md §2): one StreamEvent per SSE message.
import { parseStreamEvent, type StreamAction } from './store.ts';

export interface SseOptions {
  url?: string;
  /** Wait before reopening after the browser gives up on the connection. */
  retryMs?: number;
}

/** Opens the stream and keeps it open; returns a function that closes it. */
export function connectSse(dispatch: (action: StreamAction) => void, options: SseOptions = {}): () => void {
  const url = options.url ?? '/events';
  const retryMs = options.retryMs ?? 5000;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    dispatch({ kind: 'connection', source: 'sse', connection: 'connecting' });
    const es = new EventSource(url);
    source = es;
    es.onopen = () => dispatch({ kind: 'connection', source: 'sse', connection: 'open' });
    es.onmessage = (message: MessageEvent<unknown>) => {
      const event = typeof message.data === 'string' ? parseStreamEvent(message.data) : null;
      dispatch(event ? { kind: 'event', event, at: Date.now() } : { kind: 'rejected', at: Date.now() });
    };
    es.onerror = () => {
      dispatch({ kind: 'connection', source: 'sse', connection: 'retrying' });
      // While CONNECTING the browser retries by itself. CLOSED (an HTTP error, a wrong content type,
      // the engine not running behind the dev proxy) is final for this EventSource, so start a new one.
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        source = null;
        timer = setTimeout(open, retryMs);
      }
    };
  };

  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
    source = null;
    dispatch({ kind: 'connection', source: 'sse', connection: 'idle' });
  };
}
