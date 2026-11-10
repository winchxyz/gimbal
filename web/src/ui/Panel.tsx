import type { ReactNode } from 'react';
import { cx } from './cx.ts';

interface PanelProps {
  /** What the panel holds, as its title. */
  title: string;
  /** What it measures or where the rest is, at the title's right: text, or a link to the screen that has it all. */
  note?: ReactNode;
  /** Columns of the 12-column grid; the phone always gives a panel the full width. */
  span?: 4 | 5 | 6 | 7 | 8 | 12;
  id?: string;
  className?: string;
  children: ReactNode;
}

/** A panel: a hairline, a title and what it measures. Nothing is boxed. */
export function Panel({ title, note, span = 12, id, className, children }: PanelProps) {
  return (
    <section className={cx('pn', span !== 12 && `w${span}`, className)} aria-label={title} id={id}>
      <div className="pn-h">
        <h2>{title}</h2>
        {note === undefined || note === null ? null : typeof note === 'string' ? <span>{note}</span> : note}
      </div>
      {children}
    </section>
  );
}

export interface Reading {
  label: ReactNode;
  value: ReactNode;
  /** A state class for the value (`up`, `watch-t`, `down`); null stays neutral. */
  tone?: string | null;
  /** `tot`: a total, in the label's bold; `sub`: a part of the row above it. */
  kind?: 'tot' | 'sub';
  title?: string;
  testId?: string;
}

/** Readings: a label in the brand's type and its value in mono, a hairline between rows. */
export function Readings({ rows, shut = false, className }: { rows: readonly Reading[]; shut?: boolean; className?: string }) {
  return (
    <dl className={cx('rd', shut && 'shut', className)}>
      {rows.map((r, i) => (
        <div key={i} className={r.kind} title={r.title}>
          <dt>{r.label}</dt>
          <dd className={r.tone ?? undefined} data-testid={r.testId}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
