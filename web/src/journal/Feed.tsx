import { Fragment, memo, useState } from 'react';
import type { JournalEntry } from '@gimbal/shared';
import { signedUsd } from '../desk/format.ts';
import { Flash } from '../ui/Flash.tsx';
import { oneLegCopy, refusedCopy } from '../ui/waitCopy.ts';
import { cx } from '../ui/cx.ts';
import { useStream } from '../stream/hub.ts';
import { clock } from './entry.ts';
import { rowOf, type DayGroup } from './model.ts';
import { moneyTone } from '../desk/answer.ts';
import type { HoldItem, PeriodFact } from './period.ts';
import { smallUsd, type StoryItem } from './story.ts';
import { waitsView } from './waits.ts';

/** Lines longer than this show their start, with the rest behind "Show all". */
const LONG = 180;

function Long({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= LONG) return <>{text}</>;
  return (
    <>
      {open ? text : `${text.slice(0, LONG).replace(/\s+\S*$/, '')}…`}
      <button type="button" className="j-wait-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Show less' : 'Show all'}
      </button>
    </>
  );
}

/** One entry: when, what kind, the engine's one line, the reason, the money, and the links that prove it. */
const Entry = memo(function Entry({ entry }: { entry: JournalEntry }) {
  // A replay signs nothing: its rescue rows show no signature time.
  const replay = useStream((s) => (s.desk?.mode ?? s.mode) === 'replay');
  const row = rowOf(entry, { replay });
  // A refused open (cost, the pair's venues, a rotation out of an Orderly leg) and the close of a lone leg say so in
  // plain words; the engine's line stays under it.
  const refused = entry.kind === 'refused' ? refusedCopy(entry.summary) : entry.kind === 'error' ? oneLegCopy(entry.summary) : null;
  return (
    <article className="j-evt" data-kind={row.kind}>
      <span className="j-lead">
        <time className="t" dateTime={new Date(entry.t).toISOString()} title={row.timeTitle}>
          {row.time}
        </time>
        <span className="sep" aria-hidden="true"> · </span>
        <span className={cx('k', row.tone)}>{row.label}</span>
      </span>
      <div className="what">
        {refused ? refused.text : <Long text={row.summary} />}
        {refused ? <span className="why">{refused.raw}</span> : null}
        {row.steps ? (
          <div className="j-steps">
            {row.steps.map((step) => (
              <span key={step}>{step}</span>
            ))}
          </div>
        ) : null}
        {row.why ? (
          <span className="why">
            {row.why.prefix ? `${row.why.prefix}: ` : ''}
            {row.why.text}
          </span>
        ) : null}
        {row.flag ? <span className="why flag">{row.flag}</span> : null}
      </div>
      <div className="amt">
        {row.amount ? <span className={row.amount.positive ? 'pos' : undefined}>{row.amount.text}</span> : null}
        {row.note ? <span className="note">{row.note}</span> : null}
      </div>
      <div className="proof">
        {row.proofs.map((p, i) => (
          <Fragment key={`${p.chain}-${i}`}>
            {i > 0 ? <span className="sep" aria-hidden="true">·</span> : null}
            <a href={p.href} target="_blank" rel="noreferrer noopener" aria-label={`${p.label} transaction ${p.short}, opens in a new tab`}>
              {p.label} ↗ <span className="hash">{p.short}</span>
            </a>
          </Fragment>
        ))}
      </div>
    </article>
  );
});

/**
 * The desk waiting: one row for a run of waits, updated in place as new checks arrive. It shows the latest reason in
 * plain words and, quietly, since when and how many checks; opening it lists the entries with the engine's own words.
 */
const WaitRun = memo(function WaitRun({ entries }: { entries: JournalEntry[] }) {
  const [open, setOpen] = useState(false);
  const view = waitsView(entries);
  const newest = entries[0]!;
  const row = rowOf(newest);
  const expandable = entries.length > 1 || view.latest.text !== view.latest.raw;
  return (
    <article className="j-evt j-wait" data-kind="wait">
      <span className="j-lead">
        <time className="t" dateTime={new Date(newest.t).toISOString()} title={row.timeTitle}>
          {row.time}
        </time>
        <span className="sep" aria-hidden="true"> · </span>
        <span className={cx('k', row.tone)}>{row.label}</span>
      </span>
      <div className="what">
        {view.latest.text}
        {view.since ? <span className="why">{view.since}</span> : null}
        {expandable ? (
          <button type="button" className="j-wait-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : entries.length > 1 ? `Show all ${entries.length} checks` : 'Show the engine’s wording'}
          </button>
        ) : null}
        {open ? (
          <ul className="j-wait-list">
            {entries.map((e) => {
              const text = waitsView([e]).latest;
              return (
                <li key={e.id}>
                  <time className="t" dateTime={new Date(e.t).toISOString()}>{rowOf(e).time}</time>
                  <span>
                    {text.text}
                    {text.text !== text.raw ? <span className="raw">{text.raw}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <div className="amt" />
      <div className="proof" />
    </article>
  );
});

/** The desk's own line on a venue it could not read: it holds, and decides nothing on it (UX, Journal). */
const HELD_NOTE = 'The desk held; it decides nothing on a venue it cannot read.';

/** Funding in words, or an incident with its recovery: one line with its time and, for funding, the amount. */
function Line({ item }: { item: Extract<StoryItem, { type: 'funding' } | { type: 'incident' }> }) {
  const usd = item.type === 'funding' ? item.usd : null;
  return (
    <article className="j-line" data-kind={item.type}>
      <time className="t" dateTime={new Date(item.t).toISOString()}>
        {clock(item.t)}
      </time>
      <span className="what">
        {item.text}
        {item.type === 'incident' && item.entry.kind === 'error' ? <small>{HELD_NOTE}</small> : null}
      </span>
      <span className={cx('amt', moneyTone(usd, 4))}>{usd === null ? '' : smallUsd(usd)}</span>
    </article>
  );
}

/**
 * A holding period: one line (when it began, the pair, how many checks), unfolded on tap to its facts (period.ts). An
 * ongoing period starts unfolded on the desktop and folded on the phone, as the book draws them.
 */
function Period({ item, facts }: { item: HoldItem; facts: readonly PeriodFact[] }) {
  // null until the reader taps: the default follows the period (it may turn ongoing once the windows are read).
  const [tapped, setOpen] = useState<boolean | null>(null);
  const open = tapped ?? (item.ongoing && typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);
  const id = `pd-${item.id}`;
  return (
    <article className="j-per" data-kind="hold">
      <button type="button" className="j-per-row" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <time className="t" dateTime={new Date(item.from).toISOString()}>
          {clock(item.from)}
        </time>
        <b>{item.text}</b>
        <span className="r">
          {item.ongoing ? 'Still held' : 'Ended'}
          <i className={cx('chev', open && 'u')} aria-hidden="true" />
        </span>
      </button>
      <div className={cx('j-pd', !open && 'shut')} id={id} hidden={!open}>
        {facts.map((f) => (
          <div className="kv" key={f.label}>
            <span>{f.label}</span>
            <span className={f.tone ?? undefined}>{f.value}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

/** A day: its date and P&L total, then what happened, as story lines, newest first. */
export function Day({ group, items, factsOf }: { group: DayGroup; items: readonly StoryItem[]; factsOf: (item: HoldItem) => PeriodFact[] }) {
  return (
    <section aria-label={group.label}>
      <div className="j-day">
        <h2>{group.label}</h2>
        <span>
          <Flash value={group.totalUsd}>{signedUsd(group.totalUsd)}</Flash>
        </span>
      </div>
      {items.map((item) =>
        item.type === 'waits' ? (
          <WaitRun key={item.id} entries={item.entries} />
        ) : item.type === 'entry' ? (
          <Entry key={item.id} entry={item.entry} />
        ) : item.type === 'hold' ? (
          <Period key={item.id} item={item} facts={factsOf(item)} />
        ) : (
          <Line key={item.id} item={item} />
        ),
      )}
    </section>
  );
}
