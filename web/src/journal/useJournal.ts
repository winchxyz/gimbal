// The Journal's entries: what the engine already holds (`GET /state`, through `engineApi()`) merged with what has
// arrived on the stream since. The stream carries only new entries, so without the read a page opened an hour
// after the desk started would show an empty journal. The read goes through the same seam as the other screens,
// so the fake and the engine look alike here.
import type { JournalEntry } from '@gimbal/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createStore, useStream } from '../stream/hub.ts';
import { engineApi } from '../stream/start.ts';
import { INITIAL_LOAD, reduceLoad, type LoadState } from './load.ts';
import { mergeEntries } from './model.ts';

const loadStore = createStore(reduceLoad, INITIAL_LOAD);
let reading = false;

/** Reads the journal now. Two callers at once (the page opening and the stream connecting) make one request. */
export async function readJournal(): Promise<void> {
  if (reading) return;
  reading = true;
  loadStore.dispatch({ kind: 'start' });
  try {
    loadStore.dispatch({ kind: 'ready', entries: await (await engineApi()).journal() });
  } catch (error) {
    loadStore.dispatch({ kind: 'error', error: error instanceof Error ? error.message : String(error), at: Date.now() });
  } finally {
    reading = false;
  }
}

export interface JournalData {
  status: LoadState['status'];
  /** Newest first, one per id. */
  entries: JournalEntry[];
  error: string | null;
  failedAt: number | null;
  retry(): void;
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
  return { status: load.status, entries, error: load.error, failedAt: load.failedAt, retry: () => void readJournal() };
}
