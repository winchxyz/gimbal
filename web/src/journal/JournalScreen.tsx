import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeskState, JournalEntry } from '@gimbal/shared';
import { signedUsd } from '../desk/format.ts';
import { useStream } from '../stream/hub.ts';
import { Flash } from '../ui/Flash.tsx';
import { SCROLLER, takeFocus } from '../ui/scroller.ts';
import { useNow } from '../ui/useNow.ts';
import { dayMonth } from '../windows/format.ts';
import { heldWindow } from '../windows/model.ts';
import { csvName, toCsv } from './csv.ts';
import { journalAnswer, trueCounts } from './counts.ts';
import { Day } from './Feed.tsx';
import { Filters } from './Filters.tsx';
import { filterLabel, type FilterId } from './kinds.ts';
import { moneyTone } from '../desk/answer.ts';
import {
  attributionOf,
  costsUsd,
  entriesIn,
  filterCounts,
  foldOlder,
  groupByDay,
  visibleFeed,
} from './model.ts';
import { heldSymbolOf, storyOf, type StoryItem } from './story.ts';
import { journalHeadline, periodFacts, type HoldItem } from './period.ts';
import { Counts, Side } from './Side.tsx';
import { JournalEmpty, JournalError, JournalLoading } from './States.tsx';
import { useJournal, type JournalData } from './useJournal.ts';
import { scrollToTop, useScrolled } from './useScrolled.ts';
import './journal.css';

/** The Journal screen: everything the desk did, as the contract recorded it, newest first. */
export function JournalScreen() {
  const journal = useJournal();
  const desk = useStream((s) => s.desk);
  const engineMode = useStream((s) => s.mode);

  if (journal.status === 'loading') return <JournalLoading />;
  if (journal.status === 'error') {
    return (
      <JournalError
        error={journal.error}
        at={journal.failedAt}
        contract={desk ? { account: desk.contract, mode: desk.mode } : null}
        onRetry={journal.retry}
      />
    );
  }
  if (journal.entries.length === 0) return <JournalEmpty mode={desk?.mode ?? engineMode} />;
  return <JournalPage entries={journal.entries} desk={desk} paging={journal} />;
}

const money = (value: number | null): string => (value === null ? '—' : signedUsd(value));

/** Story lines by the UTC day of their newest moment, so a holding period sits under the day it was last checked. */
function byDay(items: readonly StoryItem[]): Map<number, StoryItem[]> {
  const days = new Map<number, StoryItem[]>();
  for (const item of items) {
    const day = Math.floor(item.t / 86_400_000);
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  return days;
}

/** Saves text as a file through the browser's own download: nothing leaves the page. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' })); // the BOM makes Excel read UTF-8
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function JournalPage({ entries, desk, paging }: { entries: readonly JournalEntry[]; desk: DeskState | null; paging: Pick<JournalData, 'more' | 'older' | 'loadOlder'> }) {
  const windows = useStream((s) => s.windows);
  const engineCounts = useStream((s) => s.journalCounts);
  const now = useNow(30_000);
  const [filter, setFilter] = useState<FilterId>('all');
  const [expanded, setExpanded] = useState(false);

  // New entries arrive at the top, but never under a reader who has scrolled down: the page keeps the entries it
  // showed and counts the new ones ("2 new events") until the reader asks for them or scrolls back up.
  const feed = useRef<HTMLElement>(null);
  const scrolled = useScrolled(feed);
  const feedRef = useCallback((el: HTMLElement | null) => {
    feed.current = el;
    takeFocus(el);
  }, []);
  const ids = useRef<string[]>([]);
  ids.current = entries.map((e) => e.id);
  const [frozen, setFrozen] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    setFrozen(scrolled ? (current) => current ?? new Set(ids.current) : null);
  }, [scrolled]);

  const { shown, pending } = useMemo(() => visibleFeed(entries, frozen), [entries, frozen]);
  // The sentence, the filters and the side column count every entry the engine holds (journalCounts), not the page.
  const counts = useMemo(() => trueCounts(engineCounts, shown), [engineCounts, shown]);
  const pageFilters = useMemo(() => filterCounts(shown), [shown]);
  const heldId = windows ? (heldWindow(windows)?.id ?? null) : null;
  const listed = useMemo(() => entriesIn(shown, filter), [shown, filter]);
  const groups = useMemo(() => groupByDay(listed, now), [listed, now]);
  const { shown: days, fold } = useMemo(() => (expanded ? { shown: groups, fold: null } : foldOlder(groups)), [groups, expanded]);
  // One line per holding period, funding in words, an incident with its recovery (story.ts), filed under its day.
  // Before the windows are read (right after an engine restart) the desk's open legs say what is held.
  const heldSymbol = desk ? heldSymbolOf(desk.legs) : null;
  const lines = useMemo(() => storyOf(days.flatMap((d) => d.entries), heldId, heldSymbol), [days, heldId, heldSymbol]);
  const story = useMemo(() => byDay(lines), [lines]);
  // The sentence: the period held now, its funding and outages (period.ts); without one, what the contract signed.
  const headline = useMemo(() => journalHeadline(storyOf(shown, heldId, heldSymbol), desk?.pnl.fundingUsd ?? null, now), [shown, heldId, heldSymbol, desk, now]);
  const factsOf = useCallback((item: HoldItem) => periodFacts(item, { entries: shown, desk, now }), [shown, desk, now]);

  const replay = desk?.mode === 'replay';
  const attribution = attributionOf(desk?.pnl ?? null, shown, desk?.legs ?? []);

  const showNew = () => {
    setFrozen(null);
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollToTop(feed.current, calm ? 'auto' : 'smooth');
  };

  return (
    <div className="j-page">
      <section className="j-top">
        <h1 className="answer wide" data-testid="journal-answer">
          {headline !== null && !replay ? headline : <Flash value={counts.signed}>{journalAnswer(counts, replay)}</Flash>}
        </h1>
        <p className="j-sub g">
          {replay ? 'Everything the replay desk did, on recorded mainnet prices.' : 'Everything the desk did, as the contract recorded it.'}
          {counts.since === null
            ? ''
            : ` Since ${dayMonth(counts.since)}, ${counts.filters.all.toLocaleString('en-US')} ${counts.filters.all === 1 ? 'entry' : 'entries'}${counts.complete ? '' : ' loaded'}.`}{' '}
          <button
            type="button"
            className="btn quiet j-desk"
            disabled={listed.length === 0}
            onClick={() => download(csvName(filter, Date.now()), toCsv(listed))}
            title={`Download the ${listed.length} ${listed.length === 1 ? 'entry' : 'entries'} under ${filterLabel(filter)} as a CSV file`}
          >
            Export CSV
          </button>
        </p>
      </section>

      <Counts counts={counts} replay={replay} className="j-phone" />

      <div className="j-summary j-phone">
        <div>
          <span>Net on the entries shown</span>
          <span className={moneyTone(attribution.netUsd) ?? undefined}>{money(attribution.netUsd)}</span>
        </div>
        <div>
          <span>Funding received</span>
          <span className={moneyTone(attribution.fundingUsd) ?? undefined}>{money(attribution.fundingUsd)}</span>
        </div>
        <div>
          <span>Fees, basis, transfers</span>
          <span>{money(costsUsd(attribution))}</span>
        </div>
      </div>

      {/* The filters list the loaded entries, so they count those; the totals over all history are in Counts. */}
      <Filters filter={filter} counts={pageFilters} onChange={setFilter} />

      <div className="j-grid">
        <section className="j-feed" aria-label="Journal entries" ref={feedRef} {...SCROLLER}>
          {pending > 0 ? (
            <div className="j-new" role="status">
              <button type="button" className="btn" onClick={showNew}>
                {pending} new {pending === 1 ? 'event' : 'events'}
              </button>
            </div>
          ) : null}
          {days.map((group) => (
            <Day key={group.day} group={group} items={story.get(group.day) ?? []} factsOf={factsOf} />
          ))}
          {days.length === 0 ? <p className="j-none">Nothing under {filterLabel(filter)} yet.</p> : null}
          {fold ? (
            <button type="button" className="j-more" onClick={() => setExpanded(true)}>
              {fold.range} · {fold.summary}. <span>Show</span>
            </button>
          ) : (
            <Older {...paging} />
          )}
        </section>
        <Side entries={shown} counts={counts} desk={desk} windows={windows} />
      </div>
    </div>
  );
}

/**
 * The end of the feed, once every entry held is on the page: a button for the next 100 older ones while the engine may
 * have more (`GET /journal?before=`), why a page failed, or that the engine has nothing older. A page that fails
 * changes nothing already shown.
 */
function Older({ more, older, loadOlder }: Pick<JournalData, 'more' | 'older' | 'loadOlder'>) {
  if (older.status === 'error') {
    return (
      <p className="j-none" role="status">
        Couldn’t load earlier events{older.error ? ` (${older.error})` : ''}. What is shown is unchanged, and the desk is unaffected.{' '}
        <button type="button" className="btn quiet" onClick={loadOlder}>Try again</button>
      </p>
    );
  }
  if (more) {
    return (
      <button type="button" className="j-more" disabled={older.status === 'loading'} onClick={loadOlder}>
        {older.status === 'loading' ? 'Loading earlier events…' : <span>Load earlier events</span>}
      </button>
    );
  }
  return older.paged ? <p className="j-none">That is every entry the engine holds.</p> : null;
}
