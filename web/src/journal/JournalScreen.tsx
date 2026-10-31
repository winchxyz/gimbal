import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeskState, JournalEntry } from '@gimbal/shared';
import { signedUsd } from '../desk/format.ts';
import { useStream } from '../stream/hub.ts';
import { Flash } from '../ui/Flash.tsx';
import { useNow } from '../ui/useNow.ts';
import { csvName, toCsv } from './csv.ts';
import { Day } from './Feed.tsx';
import { Filters } from './Filters.tsx';
import { filterLabel, type FilterId } from './kinds.ts';
import {
  actionsText,
  attributionOf,
  costsUsd,
  countsOf,
  entriesIn,
  filterCounts,
  foldOlder,
  groupByDay,
  sinceLabel,
  visibleFeed,
} from './model.ts';
import { Side } from './Side.tsx';
import { JournalEmpty, JournalError, JournalLoading } from './States.tsx';
import { useJournal } from './useJournal.ts';
import { useScrolled } from './useScrolled.ts';
import './journal.css';

/** The Journal screen: everything the desk did, as the contract recorded it, newest first. */
export function JournalScreen() {
  const journal = useJournal();
  const desk = useStream((s) => s.desk);

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
  if (journal.entries.length === 0) return <JournalEmpty mode={desk?.mode ?? null} />;
  return <JournalPage entries={journal.entries} desk={desk} />;
}

const money = (value: number | null): string => (value === null ? '—' : signedUsd(value));

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

function JournalPage({ entries, desk }: { entries: readonly JournalEntry[]; desk: DeskState | null }) {
  const windows = useStream((s) => s.windows);
  const now = useNow(30_000);
  const [filter, setFilter] = useState<FilterId>('all');
  const [expanded, setExpanded] = useState(false);

  // New entries arrive at the top, but never under a reader who has scrolled down: the page keeps the entries it
  // showed and counts the new ones ("2 new events") until the reader asks for them or scrolls back up.
  const scrolled = useScrolled();
  const ids = useRef<string[]>([]);
  ids.current = entries.map((e) => e.id);
  const [frozen, setFrozen] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    setFrozen(scrolled ? (current) => current ?? new Set(ids.current) : null);
  }, [scrolled]);

  const { shown, pending } = useMemo(() => visibleFeed(entries, frozen), [entries, frozen]);
  const counts = useMemo(() => filterCounts(shown), [shown]);
  const listed = useMemo(() => entriesIn(shown, filter), [shown, filter]);
  const groups = useMemo(() => groupByDay(listed, now), [listed, now]);
  const { shown: days, fold } = useMemo(() => (expanded ? { shown: groups, fold: null } : foldOlder(groups)), [groups, expanded]);

  const signed = countsOf(entries).signed;
  const attribution = attributionOf(desk?.pnl ?? null, entries);
  const costs = costsUsd(attribution);

  const showNew = () => {
    setFrozen(null);
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
  };

  return (
    <div>
      <section className="j-top">
        <div>
          <h1>Journal</h1>
          <p className="j-desk">
            Everything the desk did, as the contract recorded it.{' '}
            <b>
              <Flash value={signed}>{actionsText(signed)}</Flash>, 0 by a private key.
            </b>
          </p>
          <p className="j-phone">
            <Flash value={signed}>{actionsText(signed)}</Flash> by the contract. <span className="lvl">0</span> by a private key.
          </p>
        </div>
        <button
          type="button"
          className="btn j-desk"
          disabled={listed.length === 0}
          onClick={() => download(csvName(filter, Date.now()), toCsv(listed))}
          title={`Download the ${listed.length} ${listed.length === 1 ? 'entry' : 'entries'} under ${filterLabel(filter)} as a CSV file`}
        >
          Export CSV
        </button>
      </section>

      <div className="j-summary j-phone">
        <div>
          <span>{sinceLabel(entries)}</span>
          <span>{money(attribution.netUsd)}</span>
        </div>
        <div>
          <span>Funding received</span>
          <span className={attribution.fundingUsd !== null && attribution.fundingUsd > 0 ? 'pos' : undefined}>{money(attribution.fundingUsd)}</span>
        </div>
        <div>
          <span>Fees, basis, transfers</span>
          <span>{money(costs)}</span>
        </div>
      </div>

      <Filters filter={filter} counts={counts} onChange={setFilter} />

      <div className="j-grid">
        <section className="j-feed" aria-label="Journal entries">
          {pending > 0 ? (
            <div className="j-new" role="status">
              <button type="button" className="btn" onClick={showNew}>
                {pending} new {pending === 1 ? 'event' : 'events'}
              </button>
            </div>
          ) : null}
          {days.map((group) => (
            <Day key={group.day} group={group} />
          ))}
          {days.length === 0 ? <p className="j-none">Nothing under {filterLabel(filter)} yet.</p> : null}
          {fold ? (
            <button type="button" className="j-more" onClick={() => setExpanded(true)}>
              {fold.range} · {fold.summary}. <span>Show</span>
            </button>
          ) : null}
        </section>
        <Side entries={entries} desk={desk} windows={windows} />
      </div>
    </div>
  );
}
