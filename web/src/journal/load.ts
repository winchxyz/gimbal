// The Journal's read of what the engine already holds: loading, ready or failed. Pure, so it is tested.
import type { JournalEntry } from '@gimbal/shared';

export interface LoadState {
  /** `loading`: nothing read yet. `error`: the first read failed and nothing was ever read. */
  status: 'loading' | 'ready' | 'error';
  entries: JournalEntry[];
  error: string | null;
  /** When the last failed read ended, ms. */
  failedAt: number | null;
}

export type LoadAction =
  | { kind: 'start' }
  | { kind: 'ready'; entries: JournalEntry[] }
  | { kind: 'error'; error: string; at: number };

export const INITIAL_LOAD: LoadState = { status: 'loading', entries: [], error: null, failedAt: null };

/** A read that fails after one that worked keeps the entries already read: a refresh must not blank the page. */
export function reduceLoad(state: LoadState, action: LoadAction): LoadState {
  switch (action.kind) {
    case 'start':
      return state.status === 'error' ? { ...INITIAL_LOAD } : state;
    case 'ready':
      return { status: 'ready', entries: action.entries, error: null, failedAt: null };
    case 'error':
      return state.status === 'ready' ? state : { status: 'error', entries: [], error: action.error, failedAt: action.at };
  }
}
