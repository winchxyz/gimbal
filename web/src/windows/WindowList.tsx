import { useMemo } from 'react';
import type { ScanStatus, Window as FundingWindow } from '@gimbal/shared';
import type { Connection } from '../stream/store.ts';
import { Flash } from '../ui/Flash.tsx';
import { cx } from '../ui/cx.ts';
import { dotColor } from '../ui/dot.ts';
import { ago, useNow } from '../ui/useNow.ts';
import { writeControls } from '../remote/readonly.ts';
import { useManualSend } from '../ui/useManualSend.ts';
import type { Alert, Reached } from './alerts.ts';
import { sparkline } from './chart.ts';
import { depth, hours, pct, plain, usd } from './format.ts';
import type { HistoryEntry } from './history.ts';
import { confirmText } from './manual.ts';
import { isEnterable, isNoDesk, rowStatus, totalCosts, venuePair, type FailedScan, type Tab } from './model.ts';

/** "2 s ago", ticking: a component of its own so the list does not re-render every second. */
export function Ago({ at }: { at: number }) {
  return <>{ago(at, useNow())}</>;
}

// ---------- header ----------

interface HeadProps {
  tab: Tab;
  onTab(tab: Tab): void;
  tradableCount: number;
  watchCount: number;
  watchVenues: number | null;
  scan: ScanStatus | null;
  newestAt: number | null;
  connection: Connection;
}

const LIVE: Record<Connection, { label: string; dot: string }> = {
  open: { label: 'Live', dot: 'var(--level)' },
  connecting: { label: 'Connecting', dot: 'var(--ink-3)' },
  retrying: { label: 'Reconnecting', dot: 'var(--watch)' },
  idle: { label: 'Not live', dot: 'var(--ink-3)' },
};

/** Tabs and the live marker. On the phone the title comes first, then the marker, then the tabs. */
export function ListHead({ tab, onTab, tradableCount, watchCount, watchVenues, scan, newestAt, connection }: HeadProps) {
  const live = LIVE[connection];
  const at = scan?.at ?? newestAt;
  return (
    <div className="w-head">
      <h1 className="w-title">Windows</h1>
      <div className="w-tabs" role="tablist" aria-label="Windows">
        <button type="button" role="tab" aria-selected={tab === 'tradable'} className={cx('w-tab', tab === 'tradable' && 'on')} onClick={() => onTab('tradable')}>
          Tradable {tradableCount}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'watch'} className={cx('w-tab', tab === 'watch' && 'on')} onClick={() => onTab('watch')}>
          Watch-only {watchVenues === null ? watchCount : `${watchVenues} venues`}
        </button>
      </div>
      <p className="w-live">
        <span className="dot" style={dotColor(live.dot)}>{live.label}</span>
        {scan ? <>{'  '}{scan.venues} venues</> : null}
        {at !== null ? <> · <Ago at={at} /></> : null}
        {' · '}
        <span className="desk-only">{tab === 'tradable' ? 'net APR ↓' : 'gross APR ↓'}</span>
        <span className="phone-only">{tab === 'tradable' ? 'net APR after costs' : 'gross APR'}</span>
      </p>
    </div>
  );
}

// ---------- notices under the header ----------

interface NoticesProps {
  /** No desk is loaded, so the engine refuses every desk window (E_NO_DESK). */
  noDesk: boolean;
  failed: FailedScan | null;
  held: FundingWindow | null;
  reached: Reached[];
  onClearAlert(alert: Alert): void;
  strategyError: string | null;
}

/** The lines under the header: no desk yet, venues that did not answer (amber), local alerts that fired, a strategy that could not be read. */
export function Notices({ noDesk, failed, held, reached, onClearAlert, strategyError }: NoticesProps) {
  return (
    <>
      {noDesk ? (
        <div className="w-notice calm" role="status">
          <b>No desk yet</b>
          <span>
            The scanner is reading funding, but no desk is loaded, so nothing here can be entered. These are the windows a desk could trade;
            they open for entry once one exists.
          </span>
        </div>
      ) : null}
      {failed ? (
        <div className="w-notice" role="status">
          <b>{failed.headline}</b>
          <span>
            {failed.venues.join(', ')}. Windows that need them use data from <Ago at={failed.since} /> and are greyed.
            {held ? ` The desk keeps holding ${held.symbol}.` : ''} The next scan tries again on its own.
          </span>
        </div>
      ) : null}
      {strategyError ? (
        <div className="w-notice" role="status">
          <b>Can’t read your minimum</b>
          <span>The engine didn’t answer for your rules, so no minimum is drawn. The windows below are as scanned and the desk is unaffected. It asks again every 30 s.</span>
        </div>
      ) : null}
      {reached.map((r) => (
        <div className="w-notice" role="status" key={r.alert.id}>
          <b>
            {r.window.symbol} passed {r.alert.overSymbol}
          </b>
          <span>
            {pct(r.window.netAprPct)} against {pct(r.overNetAprPct)}. Your alert fired once and stays until you clear it.{' '}
            <button type="button" className="btn quiet" onClick={() => onClearAlert(r.alert)}>Clear alert</button>
          </span>
        </div>
      ))}
    </>
  );
}

// ---------- rows ----------

export function Sparkline({ entry }: { entry: HistoryEntry | undefined }) {
  const history = entry?.history ?? null;
  const points = useMemo(() => (history ? sparkline(history.points, 88, 24) : ''), [history]);
  return (
    <svg className="w-spark" viewBox="0 0 88 24" preserveAspectRatio="none" aria-hidden="true">
      {points ? <polyline points={points} vectorEffect="non-scaling-stroke" /> : null}
    </svg>
  );
}

interface RowProps {
  w: FundingWindow;
  selected: boolean;
  below: boolean;
  history: HistoryEntry | undefined;
  /** The window the desk holds, if any: a row that could replace it offers Rotate. */
  held: FundingWindow | null;
  onSelect(id: string): void;
}

/**
 * Rotate from the held window into this row's: a confirm naming both windows, then `POST /rotate`. The engine answers at
 * once with ok or the reason a check refused; the answer stays next to the button. Offered on the selected row only, so
 * the list stays a list.
 */
function RowRotate({ from, to }: { from: FundingWindow; to: FundingWindow }) {
  const action = { kind: 'rotate', from: from.symbol, to: to.symbol, windowId: to.id } as const;
  const send = useManualSend(action);
  // The row is a button that selects it; nothing in here should do that again.
  const stop = { onClick: (e: { stopPropagation(): void }) => e.stopPropagation(), onKeyDown: (e: { stopPropagation(): void }) => e.stopPropagation() };
  return (
    <span className="rot" {...stop}>
      {send.asking ? (
        <span role="alertdialog" aria-label="Confirm" className="ask">
          <span className="ink">{confirmText(action)}</span>
          <button type="button" className="btn quiet" onClick={send.cancel}>Cancel</button>
          <button type="button" className="btn primary" onClick={send.confirm}>Rotate</button>
        </span>
      ) : (
        <>
          {send.sending ? <span className="g" role="status">Sending to the engine…</span> : null}
          {send.outcome ? (
            <span className={send.outcome.tone === 'sent' ? 'ink' : 'wt'} role="status">
              {send.outcome.title}: {send.outcome.text}
            </span>
          ) : null}
          <button type="button" className="btn" disabled={send.sending} onClick={send.ask}>Rotate to {to.symbol}</button>
        </>
      )}
    </span>
  );
}

export function Row({ w, selected, below, history, held, onSelect }: RowProps) {
  const status = rowStatus(w);
  const watch = !w.tradable;
  const costs = totalCosts(w);
  const seven = w.grossApr7dPct === null ? '—' : plain(w.grossApr7dPct);
  const rotateFrom = selected && held !== null && !w.held && isEnterable(w) && writeControls().rotate ? held : null;
  return (
    <div
      role="option"
      id={rowId(w.id)}
      data-flip={w.id}
      data-id={w.id}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={cx('w-item', selected && 'sel', below && 'below', w.stale && 'stale')}
      title={watch ? undefined : `${usd(w.usdPerDayPer1k)} a day per $1k · breakeven ${hours(w.breakevenHours)}`}
      onClick={() => onSelect(w.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(w.id);
        }
      }}
    >
      <span className="a">
        {w.symbol}
        {status.text ? (
          <span className={cx('st', status.kind)} title={status.text}>
            <span className="desk-only">{status.text}</span>
            <span className="phone-only">{status.compact}</span>
          </span>
        ) : null}
      </span>
      <Sparkline entry={watch ? undefined : history} />
      {/* No desk is a fact about the page, not about this window: its net number is real, so it is not struck out. */}
      <span className={cx('netv', !watch && w.refused && !isNoDesk(w) && 'struck', !watch && !(w.refused && !isNoDesk(w)) && w.netAprPct < 0 && 'neg', watch && 'g')}>
        {watch ? '—' : <Flash value={w.netAprPct}>{pct(w.netAprPct)}</Flash>}
      </span>
      <span className="s">
        <span>
          {venuePair(w)}
          {w.stale ? <span className="g3"> · <Ago at={w.updatedAt} /></span> : null}
        </span>
        <span>
          {plain(w.grossAprPct)} now<span className="desk-only"> · {seven} 7 d</span>
          {watch ? null : <> · {plain(-costs)}<span className="desk-only"> costs</span></>} · {depth(w.depthUsd)}
        </span>
      </span>
      {rotateFrom ? <RowRotate from={rotateFrom} to={w} /> : null}
    </div>
  );
}

export const rowId = (id: string): string => `w-row-${id}`;

/** The "Your minimum · 5%" rule between the rows that clear it and the ones that do not. */
export function MinimumRule({ minimum }: { minimum: number }) {
  return <div className="w-minline" aria-hidden="true">Your minimum · {plain(minimum, minimum % 1 === 0 ? 0 : 1)}%</div>;
}

// ---------- loading ----------

export function ListSkeleton() {
  return (
    <div className="w-rows" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div className="w-item" key={i}>
          <span className="a"><i className="sk" style={{ width: 52, height: 20 }} /></span>
          <i className="w-spark" />
          <span className="netv"><i className="sk" style={{ width: 60, height: 20, marginLeft: 'auto' }} /></span>
          <span className="s"><i className="sk" style={{ width: '100%', height: 14 }} /></span>
        </div>
      ))}
    </div>
  );
}

