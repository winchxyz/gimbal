// Small pieces every onboarding step uses: the page frame with its bottom bar, a labelled field, an error line.
import type { ReactNode } from 'react';
import { cx } from '../ui/cx.ts';
import type { StepView } from './flow.ts';

/** One mistake, in words, under the action that made it. */
export function Err({ text, id }: { text?: string | undefined; id?: string }) {
  return text ? (
    <p className="ob-err" role="alert" id={id}>
      {text}
    </p>
  ) : null;
}

export function Field({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="ob-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <p className="ob-hint">{hint}</p> : null}
    </div>
  );
}

/** A list of label and value rows, as the design's `.rows`. */
export function Rows({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <div className="ob-rows">
      {rows.map((r) => (
        <div key={r.label}>
          <span>{r.label}</span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export const Mono = ({ children }: { children: ReactNode }) => <span className="ob-mono">{children}</span>;

/** The frame of one step: the phone's "Step N of M", the heading, the copy, the content and the bar at the bottom. */
export function Page({
  steps,
  title,
  lead,
  children,
  note,
  end,
}: {
  steps: StepView[];
  title: string;
  lead: ReactNode;
  children: ReactNode;
  /** The sentence at the left of the bar. */
  note?: ReactNode;
  /** The buttons at the right of the bar. */
  end?: ReactNode;
}) {
  // The last page (everything done) has no step in progress: it is the last step, not the first.
  const now = steps.findIndex((s) => s.status === 'now');
  const index = now === -1 ? Math.max(0, steps.length - 1) : now;
  return (
    <section className="obmain">
      <div className="ob-step lab">
        Step {index + 1} of {steps.length}
      </div>
      <h1>{title}</h1>
      <p className="ob-lead">{lead}</p>
      {children}
      {note || end ? (
        <div className="obbar">
          <span className="ob-note">{note}</span>
          <span className="end">{end}</span>
        </div>
      ) : null}
    </section>
  );
}

/** A button that says it is waiting while its action runs; every other button is off meanwhile. */
export function Act({
  busy,
  mine,
  onClick,
  children,
  waiting,
  primary,
  quiet,
  disabled,
}: {
  /** The action in flight anywhere on the page. */
  busy: string | null;
  /** The action this button starts. */
  mine: string;
  onClick: () => void;
  children: ReactNode;
  waiting?: string;
  primary?: boolean;
  quiet?: boolean;
  disabled?: boolean;
}) {
  const working = busy === mine;
  return (
    <button type="button" className={cx('btn', primary && 'primary', quiet && 'quiet', 'big')} disabled={disabled || (busy !== null && !working)} aria-busy={working} onClick={onClick}>
      {working ? (waiting ?? 'Waiting for your wallet…') : children}
    </button>
  );
}
