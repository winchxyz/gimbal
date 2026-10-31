import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../ui/cx.ts';
import type { SecurityData } from './load.ts';

/** A placeholder bar where a figure goes. */
export function Sk({ w, h, className, style }: { w: number | string; h: number; className?: string; style?: CSSProperties }) {
  return <i className={cx('s-sk', className)} style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

/**
 * What a section can show. `loading` draws placeholder bars, `replay` says why there is nothing to read (a recording has
 * no contract), `ready` has the contract's own answers.
 */
export type Reading = { kind: 'loading' } | { kind: 'replay' } | { kind: 'ready'; data: SecurityData };

/** The data of a reading, or null while it is not there. */
export const dataOf = (r: Reading): SecurityData | null => (r.kind === 'ready' ? r.data : null);

/** A placeholder bar while loading, the text once read, and `replay` text for a recording. */
export function Figure({ r, w, h = 16, children, replay }: { r: Reading; w: number; h?: number; children: (d: SecurityData) => ReactNode; replay?: ReactNode }) {
  if (r.kind === 'ready') return <>{children(r.data)}</>;
  if (r.kind === 'replay') return <>{replay ?? '—'}</>;
  return <Sk w={w} h={h} />;
}

/** Why a section has nothing to show in a replay. */
export function ReplayNote({ what }: { what: string }) {
  return (
    <p className="s-note g">
      A replay plays a recording, and a recording has no contract, so there is no {what} to read. Start the engine in testnet or mainnet mode to see yours.
    </p>
  );
}
