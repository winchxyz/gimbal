// The dashboard's view of the engine: the latest of each StreamEvent type plus counters.
// Pure functions only (no DOM, no timers), so `node --test` can run them as they are.
import type {
  JournalCounts,
  DeskState,
  EngineState,
  JournalEntry,
  Mode,
  RescueProgress,
  ScanStatus,
  SetupProgress,
  StrategyDecision,
  StreamEvent,
  Window as FundingWindow,
} from '@gimbal/shared';
import { withEntry } from '../journal/counts.ts';

export type StreamType = StreamEvent['type'];
export type Health = Extract<StreamEvent, { type: 'health' }>['data'];

export const STREAM_TYPES: readonly StreamType[] = ['windows', 'scan', 'desk', 'journal', 'rescue', 'setup', 'health', 'decision'];

/** Where events come from: the engine's `/events`, or the development fake. */
export type Source = 'sse' | 'fake';
/** `retrying`: the connection dropped and the client is trying again. */
export type Connection = 'idle' | 'connecting' | 'open' | 'retrying';

/** The journal keeps this many entries in memory; the Journal screen pages older ones separately. */
export const JOURNAL_LIMIT = 500;

export interface StreamState {
  source: Source | null;
  connection: Connection;
  /** Why the last attempt to connect failed (`GET /state: 500`); null while it works. */
  error: string | null;
  /** The network the engine runs on, from `GET /state`: known before a desk exists. */
  mode: Mode | null;
  /** When the engine last sent anything (an event or `GET /state`), ms: "last data 2 min ago" while it is down. */
  heardAt: number | null;
  /**
   * How far the engine's timestamps run behind this page's clock, ms. A replay stamps its windows with the time of the
   * recording, so "updated 4 s ago" needs the recording's "now"; everywhere else it is 0. `useNow` takes it off.
   */
  skewMs: number;
  received: number;
  rejected: number;                      // messages that were not a StreamEvent
  counts: Record<StreamType, number>;
  last: { type: StreamType; at: number } | null;
  windows: FundingWindow[] | null;
  scan: ScanStatus | null;
  desk: DeskState | null;
  journal: JournalEntry[];               // newest first
  /** Every entry the engine holds, counted (EngineState.journalCounts), plus the new ones heard since; null from an older engine. */
  journalCounts: JournalCounts | null;
  rescue: RescueProgress | null;
  setup: SetupProgress | null;
  health: Health | null;
  decision: StrategyDecision | null;
}

export type StreamAction =
  | { kind: 'event'; event: StreamEvent; at: number }
  | { kind: 'rejected'; at: number }
  /** `GET /state`, read each time the stream (re)connects: it replaces everything the page held. */
  | { kind: 'state'; state: EngineState; at: number }
  | { kind: 'connection'; source: Source; connection: Connection; error?: string };

export function initialStreamState(): StreamState {
  return {
    source: null,
    connection: 'idle',
    error: null,
    mode: null,
    heardAt: null,
    skewMs: 0,
    received: 0,
    rejected: 0,
    counts: { windows: 0, scan: 0, desk: 0, journal: 0, rescue: 0, setup: 0, health: 0, decision: 0 },
    last: null,
    windows: null,
    scan: null,
    desk: null,
    journal: [],
    journalCounts: null,
    rescue: null,
    setup: null,
    health: null,
    decision: null,
  };
}

export function reduceStream(state: StreamState, action: StreamAction): StreamState {
  switch (action.kind) {
    case 'connection': {
      const error = action.error ?? null;
      if (state.source === action.source && state.connection === action.connection && state.error === error) return state;
      return { ...state, source: action.source, connection: action.connection, error };
    }
    case 'rejected':
      return { ...state, rejected: state.rejected + 1 };
    case 'state': {
      // The engine's own word on what it holds now, so a restarted engine does not leave the old run's numbers
      // behind. A type it has not produced yet (null) clears the page's copy of it.
      const { state: engine, at } = action;
      return {
        ...state,
        mode: engine.mode,
        heardAt: at,
        skewMs: replaySkew(engine.mode, engine.scan?.at ?? null, at),
        windows: engine.windows,
        scan: engine.scan,
        desk: engine.desk,
        journal: engine.journal.reduce<JournalEntry[]>(addJournalEntry, []),
        journalCounts: engine.journalCounts ?? null,
        rescue: engine.rescue,
        setup: engine.setup,
        health: engine.health,
        decision: engine.decision ?? null,
      };
    }
    case 'event': {
      const { event, at } = action;
      const next: StreamState = {
        ...state,
        heardAt: at,
        received: state.received + 1,
        counts: { ...state.counts, [event.type]: state.counts[event.type] + 1 },
        last: { type: event.type, at },
      };
      switch (event.type) {
        case 'windows':
          return { ...next, windows: event.data };
        case 'scan':
          return { ...next, scan: event.data, skewMs: scanSkew(state, event.data, at) };
        case 'desk':
          return { ...next, desk: event.data };
        case 'journal':
          return {
            ...next,
            journal: addJournalEntry(state.journal, event.data),
            // A new entry adds to the counts; one sent again under its id (a reconnect) was counted already.
            journalCounts:
              state.journalCounts && !state.journal.some((e) => e.id === event.data.id) ? withEntry(state.journalCounts, event.data) : state.journalCounts,
          };
        case 'rescue':
          return { ...next, rescue: event.data };
        case 'setup':
          return { ...next, setup: event.data };
        case 'health':
          return { ...next, health: event.data };
        case 'decision':
          return { ...next, decision: event.data };
      }
    }
  }
}

/** A replay's clock is the recording's: the page's `now` minus this is the recording's `now`. Live modes have no skew. */
export function replaySkew(mode: Mode, scanAt: number | null, receivedAt: number): number {
  return mode === 'replay' && scanAt !== null ? receivedAt - scanAt : 0;
}

/**
 * The skew after a scan event. A replay's time stops when the recording ends and its scans repeat the last stamp: that
 * is not a clock that restarted, so only a scan newer than the last one moves the skew, and a frozen replay shows its
 * data getting older.
 */
function scanSkew(state: StreamState, scan: ScanStatus, receivedAt: number): number {
  if (state.mode !== 'replay') return state.skewMs;
  if (state.scan !== null && scan.at <= state.scan.at) return state.skewMs;
  return replaySkew(state.mode, scan.at, receivedAt);
}

// A reconnect can resend entries the client already has: replace by id, keep newest first.
function addJournalEntry(journal: JournalEntry[], entry: JournalEntry): JournalEntry[] {
  const rest = journal.filter((e) => e.id !== entry.id);
  const at = rest.findIndex((e) => e.t < entry.t);
  const merged = at === -1 ? [...rest, entry] : [...rest.slice(0, at), entry, ...rest.slice(at)];
  return merged.length > JOURNAL_LIMIT ? merged.slice(0, JOURNAL_LIMIT) : merged;
}

/**
 * Accepts one SSE message body. The engine is typed against the same `StreamEvent`, so this checks
 * only the envelope (a known `type` and a `data` of the right kind) and drops anything else, so a
 * stray message never reaches the store.
 */
export function parseStreamEvent(raw: string): StreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { type, data } = value as { type?: unknown; data?: unknown };
  if (typeof type !== 'string' || !(STREAM_TYPES as readonly string[]).includes(type)) return null;
  if (!isStreamData(type, data)) return null;
  return value as StreamEvent;
}

/** The envelope check shared with `GET /state`: `windows` is a list, every other type is an object. */
export function isStreamData(type: string, data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  return Array.isArray(data) === (type === 'windows');
}
