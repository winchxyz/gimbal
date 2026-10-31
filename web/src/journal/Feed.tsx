import { Fragment, memo } from 'react';
import type { JournalEntry } from '@gimbal/shared';
import { signedUsd } from '../desk/format.ts';
import { Flash } from '../ui/Flash.tsx';
import { cx } from '../ui/cx.ts';
import { rowOf, type DayGroup } from './model.ts';

/** One entry: when, what kind, the engine's one line, the reason, the money, and the links that prove it. */
const Entry = memo(function Entry({ entry }: { entry: JournalEntry }) {
  const row = rowOf(entry);
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
        {row.summary}
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

/** A day: its date and P&L total, then its entries newest first. */
export function Day({ group }: { group: DayGroup }) {
  return (
    <section aria-label={group.label}>
      <div className="j-day">
        <h2>{group.label}</h2>
        <span>
          <Flash value={group.totalUsd}>{signedUsd(group.totalUsd)}</Flash>
        </span>
      </div>
      {group.entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </section>
  );
}
