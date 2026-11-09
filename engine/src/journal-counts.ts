// The journal counted by kind (EngineState.journalCounts): every entry the engine holds, plus the ones it dropped from
// memory while running, so a counter on the page ("trades", "actions signed by the contract") is true and not a count
// of the newest page. Pure.
import type { JournalCounts, JournalEntry } from '@gimbal/shared';

export const emptyCounts = (): JournalCounts => ({ entries: 0, since: null, kinds: {}, refusedHeld: 0, refusedCancelled: 0 });

/** Adds one entry to `counts` (in place). */
export function addCount(counts: JournalCounts, entry: JournalEntry): void {
  counts.entries += 1;
  counts.since = counts.since === null ? entry.t : Math.min(counts.since, entry.t);
  counts.kinds[entry.kind] = (counts.kinds[entry.kind] ?? 0) + 1;
  if (entry.kind === 'refused') {
    // The engine journals a held risk check as `refused` with `held: 1`, and an act cancelled before anything was sent
    // with `cancelled: 1`; neither is a sizing or policy refusal (web/src/journal/model.ts, countsOf).
    if (Number(entry.numbers.held) === 1) counts.refusedHeld += 1;
    else if (Number(entry.numbers.cancelled) === 1) counts.refusedCancelled += 1;
  }
}

/** `entries` counted on top of `dropped` (the entries no longer held); neither is changed. */
export function countJournal(entries: readonly JournalEntry[], dropped: JournalCounts = emptyCounts()): JournalCounts {
  const counts: JournalCounts = { ...dropped, kinds: { ...dropped.kinds } };
  for (const entry of entries) addCount(counts, entry);
  return counts;
}
