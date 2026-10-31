// The Journal's entries: what the engine already holds (`GET /state`, through `engineApi()`: the newest 100) merged with
// what has arrived on the stream since, and older pages on request (`GET /journal?before=<id>`). The stream carries
// only new entries, so without the read a page opened an hour after the desk started would show an empty journal. The
// reads go through the same seam as the other screens, so the fake and the engine look alike here.
import type { JournalEntry } from '@gimbal/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createStore, useStream } from '../stream/hub.ts';
import { engineApi } from '../stream/start.ts';
import { INITIAL_LOAD, reduceLoad, type LoadState, type OlderState } from './load.ts';
import { mergeEntries } from './model.ts';

const loadStore = createStore(reduceLoad, INITIAL_LOAD);
let reading = false;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Reads the journal now. Two callers at once (the page opening and the stream connecting) make one request. */
export async function readJournal(): Promise<void> {
  if (reading) return;
  reading = true;
  loadStore.dispatch({ kind: 'start' });
  try {
    loadStore.dispatch({ kind: 'ready', entries: await (await engineApi()).journal() });
  } catch (error) {
    loadStore.dispatch({ kind: 'error', error: messageOf(error), at: Date.now() });
  } finally {
    reading = false;
  }
}

/**
 * Reads the page of entries older than the oldest one held. Nothing happens while a page is on its way, or when the
 * last page was short (the engine has nothing older). If the entries were read again meanwhile (the stream
 * reconnected), the page is dropped: it belonged to the old list.
 */
export async function readOlder(): Promise<void> {
  const { status, more, older, entries } = loadStore.getState();
  const oldest = entries[entries.length - 1];
  if (status !== 'ready' || !more || older.status === 'loading' || !oldest) return;
  loadStore.dispatch({ kind: 'older-start' });
  try {
    const page = await (await engineApi()).journalBefore(oldest.id);
    if (loadStore.getState().entries[loadStore.getState().entries.length - 1]?.id === oldest.id) {
      loadStore.dispatch({ kind: 'older-ready', entries: page });
    }
  } catch (error) {
    loadStore.dispatch({ kind: 'older-error', error: messageOf(error) });
  }
}

export interface JournalData {
  status: LoadState['status'];
  /** Newest first, one per id. */
  entries: JournalEntry[];
  error: string | null;
  failedAt: number | null;
  retry(): void;
  /** The engine may hold entries older than the last one listed. */
  more: boolean;
  older: OlderState;
  loadOlder(): void;
}

export function useJournal(): JournalData {
  const live = useStream((s) => s.journal);
  const open = useStream((s) => s.connection === 'open');
  const load = useSyncExternalStore(loadStore.subscribe, loadStore.getState);

  // Read when the page opens and each time the stream (re)connects: entries sent while it was down are not replayed.
  useEffect(() => {
    void readJournal();
  }, [open]);

  const entries = useMemo(() => mergeEntries(load.entries, live), [load.entries, live]);
  return {
    status: load.status,
    entries,
    error: load.error,
    failedAt: load.failedAt,
    retry: () => void readJournal(),
    more: load.more,
    older: load.older,
    loadOlder: () => void readOlder(),
  };
}
