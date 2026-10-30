// The dashboard's view of the engine: the latest of each StreamEvent type plus counters.
// Pure functions only (no DOM, no timers), so `node --test` can run them as they are.
import type {
  DeskState,
  JournalEntry,
  RescueProgress,
  ScanStatus,
  SetupProgress,
  StreamEvent,
  Window as FundingWindow,
} from '@gimbal/shared';

export type StreamType = StreamEvent['type'];
export type Health = Extract<StreamEvent, { type: 'health' }>['data'];

export const STREAM_TYPES: readonly StreamType[] = ['windows', 'scan', 'desk', 'journal', 'rescue', 'setup', 'health'];

/** Where events come from: the engine's `/events`, or the development fake. */
export type Source = 'sse' | 'fake';
/** `retrying`: the connection dropped and the client is trying again. */
export type Connection = 'idle' | 'connecting' | 'open' | 'retrying';

/** The journal keeps this many entries in memory; the Journal screen pages older ones separately. */
export const JOURNAL_LIMIT = 500;

export interface StreamState {
  source: Source | null;
  connection: Connection;
  received: number;
  rejected: number;                      // messages that were not a StreamEvent
  counts: Record<StreamType, number>;
  last: { type: StreamType; at: number } | null;
  windows: FundingWindow[] | null;
  scan: ScanStatus | null;
  desk: DeskState | null;
  journal: JournalEntry[];               // newest first
  rescue: RescueProgress | null;
  setup: SetupProgress | null;
  health: Health | null;
}

export type StreamAction =
  | { kind: 'event'; event: StreamEvent; at: number }
  | { kind: 'rejected'; at: number }
  | { kind: 'connection'; source: Source; connection: Connection };

export function initialStreamState(): StreamState {
  return {
    source: null,
    connection: 'idle',
    received: 0,
    rejected: 0,
    counts: { windows: 0, scan: 0, desk: 0, journal: 0, rescue: 0, setup: 0, health: 0 },
    last: null,
    windows: null,
    scan: null,
    desk: null,
    journal: [],
    rescue: null,
    setup: null,
    health: null,
  };
}

export function reduceStream(state: StreamState, action: StreamAction): StreamState {
  switch (action.kind) {
    case 'connection':
      if (state.source === action.source && state.connection === action.connection) return state;
      return { ...state, source: action.source, connection: action.connection };
    case 'rejected':
      return { ...state, rejected: state.rejected + 1 };
    case 'event': {
      const { event, at } = action;
      const next: StreamState = {
        ...state,
        received: state.received + 1,
        counts: { ...state.counts, [event.type]: state.counts[event.type] + 1 },
        last: { type: event.type, at },
      };
      switch (event.type) {
        case 'windows':
          return { ...next, windows: event.data };
        case 'scan':
          return { ...next, scan: event.data };
        case 'desk':
          return { ...next, desk: event.data };
        case 'journal':
          return { ...next, journal: addJournalEntry(state.journal, event.data) };
        case 'rescue':
          return { ...next, rescue: event.data };
        case 'setup':
          return { ...next, setup: event.data };
        case 'health':
          return { ...next, health: event.data };
      }
    }
  }
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
  if (typeof data !== 'object' || data === null) return null;
  if (Array.isArray(data) !== (type === 'windows')) return null;
  return value as StreamEvent;
}
