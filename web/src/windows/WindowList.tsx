import { useMemo } from 'react';
import type { Window as FundingWindow } from '@gimbal/shared';
import { Flash } from '../ui/Flash.tsx';
import { cx } from '../ui/cx.ts';
import { ago, useNow } from '../ui/useNow.ts';
import { writeControls } from '../remote/readonly.ts';
import { useManualSend } from '../ui/useManualSend.ts';
import type { Alert, Reached } from './alerts.ts';
import { sparkline } from './chart.ts';
import { depth, hours, pct, plain, usd, venueName } from './format.ts';
import type { ClosedGroup, MarketsAnswer } from './markets.ts';
import type { HistoryEntry } from './history.ts';
import { confirmText } from './manual.ts';
import { isEnterable, isNoDesk, rowStatus, totalCosts, venuePair, type FailedScan } from './model.ts';
import { OwnerEnter } from './OwnerEnter.tsx';

/** "2 s ago", ticking: a component of its own so the list does not re-render every second. */
export function Ago({ at }: { at: number }) {
  return <>{ago(at, useNow())}</>;
}

// ---------- header ----------

interface HeadProps {
  answer: MarketsAnswer;
  /** Markets open to the desk now. */
  open: number;
  /** Venues the last scan read, and how many of them the desk cannot trade. */
  venues: number | null;
  watchVenues: number | null;
}

/** The sentence (the best market open to the desk), then what the list holds, quietly. */
export function ListHead({ answer, open, venues, watchVenues }: HeadProps) {
  return (
    <div className="w-head">
      <h1 className="answer w-answer" data-testid="markets-answer">
        {answer.lead}
        {answer.rate === null ? null : <span className={answer.tone ?? undefined}>{answer.rate}</span>}
        {answer.rest}
      </h1>
      <p className="w-sub g">
        {open} {open === 1 ? 'market' : 'markets'} open to the desk
        {venues === null ? '' : `, from ${venues} venues read${watchVenues ? ` (${watchVenues} watch-only)` : ''}`} · net a year after costs, best first
      </p>
    </div>
  );
}

/** Everything the desk may not trade now, folded: one line per plain reason, the coins under it; a coin opens its detail. */
export function Closed({ groups, onSelect }: { groups: readonly ClosedGroup[]; onSelect(id: string): void }) {
  const count = groups.reduce((n, g) => n + g.windows.length, 0);
  if (count === 0) return null;
  return (
    <details className="w-closed">
      <summary>
        <span>Not open to the desk · {count}</span>
        <i className="chev" aria-hidden="true" />
      </summary>
      {groups.map((g) => (
        <div key={g.key} className="gr">
          <b>
            {g.reason} · {g.windows.length}
          </b>
          <span>
            {g.windows.slice(0, CLOSED_SHOWN).map((w, i) => (
              <span key={w.id}>
                {i === 0 ? '' : ', '}
                <button type="button" className="coin" onClick={() => onSelect(w.id)} title={`${w.symbol}: long ${venueName(w.longVenue)}, short ${venueName(w.shortVenue)}`}>
                  {w.symbol}
                </button>
              </span>
            ))}
            {g.windows.length > CLOSED_SHOWN ? ` and ${g.windows.length - CLOSED_SHOWN} more` : ''}
          </span>
        </div>
      ))}
    </details>
  );
}

/** Coins named under a reason before the rest is counted. */
const CLOSED_SHOWN = 24;

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
            The scanner is reading funding, but no desk is loaded, so nothing here can be entered. These are the markets a desk could trade;
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
  /** Every window and the engine rules' leg size: the owner's entry (unlocked live view) reads them. */
  windows?: readonly FundingWindow[];
  legUsd?: number | null;
  auto?: boolean | null;
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

export function Row({ w, selected, below, history, held, windows, legUsd, auto, onSelect }: RowProps) {
  const status = rowStatus(w);
  const watch = !w.tradable;
  const costs = totalCosts(w);
  const seven = w.grossApr7dPct === null ? '—' : plain(w.grossApr7dPct);
  const rotateFrom = selected && held !== null && !w.held && isEnterable(w) && writeControls().rotate ? held : null;
  // The live view's owner, unlocked: the selected row offers an entry from flat (a held pair offers Rotate instead).
  const ownerEnter = selected && rotateFrom === null && held === null && writeControls().enter && windows !== undefined;
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
      {ownerEnter ? <OwnerEnter w={w} windows={windows} legUsd={legUsd ?? null} auto={auto ?? null} place="row" /> : null}
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

