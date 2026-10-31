import type { CSSProperties } from 'react';
import { cx } from '../ui/cx.ts';

/** A placeholder bar where a figure goes. */
function Sk({ w, h, className, style }: { w: number | string; h: number; className?: string; style?: CSSProperties }) {
  return <i className={cx('d-sk', className)} style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

// The same rows as legRows (model.ts): the phone draws margin and ratio as one row and leaves out the entry.
const ROWS: { label: string; only?: 'd-desk' | 'd-phone' }[] = [
  { label: 'Entry · mark', only: 'd-desk' },
  { label: 'Margin', only: 'd-phone' },
  { label: 'Margin ratio', only: 'd-desk' },
  { label: 'Funding earned' },
  { label: 'Fees paid' },
  { label: 'Unsettled funding' },
  { label: 'Next funding' },
];
const PNL_LABELS = ['Funding', 'Fees', 'Price move', 'Net P&L'];

/**
 * Loading (design/HANDOFF.md, Desk: Loading): the labels stay and every figure is a placeholder bar.
 * It has the same frame as the real screen, so nothing jumps when the desk arrives.
 */
export function DeskLoading() {
  return (
    <div className="d-page" aria-busy="true" aria-label="Loading the desk">
      <div className="d-grid">
        <section className="d-hero">
          <div className="lab">Desk value</div>
          <Sk w={330} h={92} className="d-sk-value" />
          <Sk w={220} h={18} className="d-sk-rate" />
          <div className="d-payback">
            <div className="t" />
            <div className="c">
              <Sk w={150} h={14} />
              <Sk w={60} h={14} />
            </div>
          </div>
        </section>

        {(['left', 'right'] as const).map((side) => (
          <LoadingHalf key={side} side={side} />
        ))}

        <section className="d-exposure">
          <div className="lab">Net exposure</div>
          <Sk w={150} h={40} className="d-sk-net" />
        </section>

        <section className="d-pnl">
          <div className="d-pnl-rows">
            {PNL_LABELS.map((label) => (
              <div key={label}>
                <span>{label}</span>
                <Sk w={64} h={16} />
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="d-bottom">
        <section className="d-latest">
          <h3>
            <span>Latest</span>
            <a href="#/journal">Journal</a>
          </h3>
          {[0, 1, 2].map((i) => (
            <div key={i} className="ev">
              <Sk w={72} h={14} />
              <Sk w={`${70 - i * 12}%`} h={14} />
            </div>
          ))}
        </section>
        <section className="d-next">
          <h3>
            <span>Next best window</span>
            <a href="#/windows">All windows</a>
          </h3>
          <Sk w={220} h={28} />
          <Sk w="80%" h={14} style={{ marginTop: 14 }} />
        </section>
      </div>
    </div>
  );
}

function LoadingHalf({ side }: { side: 'left' | 'right' }) {
  return (
    <>
      <div className={cx('d-head', side)}>
        <div className="d-title">
          <Sk w={230} h={44} className="d-sk-title" />
          <Sk w={190} h={16} className="d-sk-sub" />
        </div>
        <Sk w={150} h={40} className="d-sk-dist" />
        <Sk w={260} h={14} className="d-sk-move" />
      </div>
      <div className={cx('d-rows', side)}>
        {ROWS.map((r) => (
          <div key={r.label} className={r.only}>
            <span>{r.label}</span>
            <Sk w={96} h={16} />
          </div>
        ))}
      </div>
    </>
  );
}
