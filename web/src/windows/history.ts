// The 7-day histories the Windows screen has fetched: one entry per window id. The reducer is pure, so the
// retry and refresh rules are tested; useHistory.ts connects it to the engine API.
import type { WindowHistory } from '@gimbal/shared';

export interface HistoryEntry {
  status: 'loading' | 'ready' | 'error';
  history: WindowHistory | null;   // the last good one stays while a refresh runs or fails
  at: number;                      // when this entry last changed state, ms
  error: string | null;
}

export type HistoryState = Readonly<Record<string, HistoryEntry>>;

export type HistoryAction =
  | { kind: 'start'; id: string; at: number }
  | { kind: 'ready'; id: string; history: WindowHistory; at: number }
  | { kind: 'error'; id: string; error: string; at: number };

/** Hourly points change once an hour, so five minutes is a fresh enough chart. */
export const HISTORY_TTL_MS = 5 * 60_000;
/** After a failure, ask again after this long. */
export const HISTORY_RETRY_MS = 30_000;

export function reduceHistory(state: HistoryState, action: HistoryAction): HistoryState {
  const before = state[action.id];
  switch (action.kind) {
    case 'start':
      return { ...state, [action.id]: { status: 'loading', history: before?.history ?? null, at: action.at, error: null } };
    case 'ready':
      return { ...state, [action.id]: { status: 'ready', history: action.history, at: action.at, error: null } };
    case 'error':
      return { ...state, [action.id]: { status: 'error', history: before?.history ?? null, at: action.at, error: action.error } };
  }
}

/** Whether the id should be fetched now: never fetched, stale, or failed long enough ago. */
export function needsHistory(entry: HistoryEntry | undefined, now: number): boolean {
  if (!entry) return true;
  if (entry.status === 'loading') return false;
  return now - entry.at >= (entry.status === 'error' ? HISTORY_RETRY_MS : HISTORY_TTL_MS);
}
