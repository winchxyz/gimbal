// The Journal's waiting rows. The strategy loop journals a `wait` whenever its reason changes, which on a quiet
// desk is about once a minute; they would bury the real events. Consecutive waits fold into one row that shows the
// latest reason, a quiet "since 09:07, 12 checks" line, and opens to the individual entries. Anything else in the
// feed (an entry, a refusal, a rescue, an error, funding) ends a run. Pure, so it is tested without a browser.
import type { JournalEntry } from '@gimbal/shared';
import { waitCopy, type WaitCopy } from '../ui/waitCopy.ts';
import { clock, numberOf } from './entry.ts';

export type FeedItem =
  | { type: 'entry'; entry: JournalEntry }
  /** `entries` newest first, at least one. `id` is the oldest one's, so a row keeps its identity while the run grows. */
  | { type: 'waits'; id: string; entries: JournalEntry[] };

export const isWait = (entry: Pick<JournalEntry, 'kind'>): boolean => entry.kind === 'wait';

/** Folds each run of consecutive wait entries (one or more) (the list is newest first) into one item. */
export function collapseWaits(entries: readonly JournalEntry[]): FeedItem[] {
  const items: FeedItem[] = [];
  let run: JournalEntry[] = [];
  const flush = () => {
    if (run.length > 0) items.push({ type: 'waits', id: run[run.length - 1]!.id, entries: run });
    run = [];
  };
  for (const entry of entries) {
    if (isWait(entry)) {
      run.push(entry);
    } else {
      flush();
      items.push({ type: 'entry', entry });
    }
  }
  flush();
  return items;
}

/** A wait entry's reason in plain words; the owner's minimum comes from the entry itself (`numbers.minNetAprPct`). */
export function waitText(entry: JournalEntry): WaitCopy {
  return waitCopy(entry.summary, { minNetAprPct: numberOf(entry, 'minNetAprPct') });
}

export interface WaitsView {
  /** The latest reason, in plain words. */
  latest: WaitCopy;
  /** `Since 09:07, 12 checks`; null for a single check, whose time is already in the row. */
  since: string | null;
  /** `12 checks` */
  count: number;
}

/** What the folded row shows: the newest entry's reason, and how long and how often the desk has been waiting. */
export function waitsView(entries: readonly JournalEntry[]): WaitsView {
  const newest = entries[0]!;
  const oldest = entries[entries.length - 1]!;
  return {
    latest: waitText(newest),
    since: entries.length === 1 ? null : `Since ${clock(oldest.t)}, ${entries.length} checks`,
    count: entries.length,
  };
}
