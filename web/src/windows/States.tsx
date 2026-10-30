import type { ReactNode } from 'react';
import type { ScanStatus, Window as FundingWindow } from '@gimbal/shared';
import { pct } from './format.ts';
import { Ago, ListSkeleton } from './WindowList.tsx';

/** Nothing open to the desk clears the owner's minimum (design/HANDOFF.md, Windows: Empty). */
export function EmptyState({
  minimum,
  best,
  scan,
  notices,
  onShowBelow,
}: {
  minimum: number;
  best: FundingWindow | null;
  scan: ScanStatus | null;
  notices: ReactNode;
  onShowBelow(): void;
}) {
  return (
    <div className="w-state">
      {notices}
      <div className="w-state-msg">
        <div className="lab">Windows</div>
        <h1>Nothing clears your {minimum % 1 === 0 ? minimum.toFixed(0) : minimum.toFixed(1)}% right now</h1>
        <p>
          {scan ? <>The scanner read {scan.venues} venues <Ago at={scan.at} />. </> : null}
          {best ? (
            <>
              The best window you allow is <b>{best.symbol} at {pct(best.netAprPct)} net</b>.
            </>
          ) : (
            <>No window is open to you at the moment.</>
          )}{' '}
          The desk holds nothing rather than pay fees for less than your minimum.
        </p>
        <div className="go">
          <button type="button" className="btn" onClick={onShowBelow}>Show windows below my minimum</button>
        </div>
      </div>
    </div>
  );
}

/** Loading: the same frame with placeholder bars where the figures go (design/HANDOFF.md, Windows: Loading). */
export function LoadingView() {
  return (
    <div className="w-split" aria-busy="true" aria-label="Loading windows">
      <section className="w-list">
        <div className="w-head" aria-hidden="true">
          <h1 className="w-title">Windows</h1>
          <div className="w-tabs">
            <i className="sk" style={{ width: 64, height: 16 }} />
            <i className="sk" style={{ width: 138, height: 16 }} />
          </div>
          <i className="sk w-live-sk" style={{ width: 240, height: 16 }} />
        </div>
        <ListSkeleton />
      </section>
      <section className="w-detail w-detail-sk" aria-hidden="true">
        <div className="w-dtop">
          <div>
            <i className="sk" style={{ width: 200, height: 56 }} />
            <i className="sk" style={{ width: 300, height: 18, marginTop: 20 }} />
          </div>
          <div className="n">
            <i className="sk" style={{ width: 220, height: 56, marginLeft: 'auto' }} />
            <i className="sk" style={{ width: 240, height: 18, marginTop: 24, marginLeft: 'auto' }} />
          </div>
        </div>
        <div className="w-chart"><i className="sk" style={{ width: '100%', height: 190 }} /></div>
        <div className="w-cols2">
          <i className="sk" style={{ width: '100%', height: 200 }} />
          <i className="sk" style={{ width: '100%', height: 200 }} />
        </div>
      </section>
    </div>
  );
}
