// The Journal's read of what the engine already holds: loading, ready or failed, and then older pages one at a time.
// Pure, so it is tested.
import type { JournalEntry } from '@gimbal/shared';
import { JOURNAL_PAGE } from '../stream/api.ts';

/** Reading one older page (`GET /journal?before=`). `paged`: at least one has been read since the entries were loaded. */
export interface OlderState {
  status: 'idle' | 'loading' | 'error';
  error: string | null;
  paged: boolean;
}

export interface LoadState {
  /** `loading`: nothing read yet. `error`: the first read failed and nothing was ever read. */
  status: 'loading' | 'ready' | 'error';
  /** The engine's own order, newest first: the newest page, then each older page after it. */
  entries: JournalEntry[];
  error: string | null;
  /** When the last failed read ended, ms. */
  failedAt: number | null;
  /** The engine may hold entries older than the last one here: a full page came back, so another may follow. */
  more: boolean;
  older: OlderState;
}

export type LoadAction =
  | { kind: 'start' }
  | { kind: 'ready'; entries: JournalEntry[] }
  | { kind: 'error'; error: string; at: number }
  | { kind: 'older-start' }
  | { kind: 'older-ready'; entries: JournalEntry[] }
  | { kind: 'older-error'; error: string };

const IDLE: OlderState = { status: 'idle', error: null, paged: false };

export const INITIAL_LOAD: LoadState = { status: 'loading', entries: [], error: null, failedAt: null, more: false, older: IDLE };

/** A page shorter than the engine's page size is the last one; an empty one is the end for sure. */
export const hasMore = (page: readonly unknown[]): boolean => page.length >= JOURNAL_PAGE;

/** A read that fails after one that worked keeps the entries already read: a refresh must not blank the page. */
export function reduceLoad(state: LoadState, action: LoadAction): LoadState {
  switch (action.kind) {
    case 'start':
      return state.status === 'error' ? { ...INITIAL_LOAD } : state;
    case 'ready':
      // A fresh read replaces everything, older pages too: a restarted engine does not hold the old run's entries.
      return { status: 'ready', entries: action.entries, error: null, failedAt: null, more: hasMore(action.entries), older: IDLE };
    case 'error':
      return state.status === 'ready' ? state : { ...INITIAL_LOAD, status: 'error', error: action.error, failedAt: action.at };
    case 'older-start':
      return state.status === 'ready' && state.more && state.older.status !== 'loading'
        ? { ...state, older: { status: 'loading', error: null, paged: state.older.paged } }
        : state;
    case 'older-ready': {
      if (state.older.status !== 'loading') return state;
      const known = new Set(state.entries.map((e) => e.id));
      return {
        ...state,
        entries: [...state.entries, ...action.entries.filter((e) => !known.has(e.id))],
        more: hasMore(action.entries),
        older: { status: 'idle', error: null, paged: true },
      };
    }
    case 'older-error':
      return state.older.status === 'loading' ? { ...state, older: { status: 'error', error: action.error, paged: state.older.paged } } : state;
  }
}
