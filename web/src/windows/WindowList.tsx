import { useMemo, type ReactNode } from 'react';
import type { Window as FundingWindow } from '@gimbal/shared';
import { Flash } from '../ui/Flash.tsx';
import { cx } from '../ui/cx.ts';
import { ago, useNow } from '../ui/useNow.ts';
import type { Alert, Reached } from './alerts.ts';
import { depth, pct, rate, signedPct, venueName } from './format.ts';
import { isBelow, isNoDesk, rowStatus, type FailedScan } from './model.ts';
import { hashForWindow } from './route.ts';
import {
  countdown, everyText, everyWords, kindText, netScale, pairNextAt,
  type AssetRow, type AssetSort, type AssetSortKey, type LegView, type NetScale, type PairRow, type Sort, type SortKey, type VenueRow, type VenueSort, type VenueSortKey,
} from './scanner.ts';

const group = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** "2 s ago", ticking: a component of its own so the list does not re-render every second. */
export function Ago({ at }: { at: number }) {
  return <>{ago(at, useNow())}</>;
}

const NONE = <span className="none">—</span>;

// ---------- notices under the top ----------

interface NoticesProps {
  /** No desk is loaded, so the engine refuses every desk window (E_NO_DESK). */
  noDesk: boolean;
  failed: FailedScan | null;
  held: FundingWindow | null;
  reached: Reached[];
  onClearAlert(alert: Alert): void;
  strategyError: string | null;
}

/** The lines under the top: no desk yet, venues that did not answer (amber), local alerts that fired, rules that could not be read. */
export function Notices({ noDesk, failed, held, reached, onClearAlert, strategyError }: NoticesProps) {
  if (!noDesk && failed === null && strategyError === null && reached.length === 0) return null;
  return (
    <div className="w-notes">
      {noDesk ? (
        <div className="w-notice calm" role="status">
          <b>No desk yet</b>
          <span>
            The scanner is reading funding, but no desk is loaded, so nothing here can be entered.
            <span className="wide"> These are the markets a desk could trade; they open for entry once one exists.</span>
          </span>
        </div>
      ) : null}
      {failed ? (
        <div className="w-notice" role="status">
          <b>{failed.headline}</b>
          <span>
            {failed.venues.join(', ')}.{held ? ` The desk keeps holding ${held.symbol}.` : ''}
            <span className="wide"> Pairs that need them show what was read <Ago at={failed.since} /> and are greyed. The next scan tries again on its own.</span>
          </span>
        </div>
      ) : null}
      {strategyError ? (
        <div className="w-notice" role="status">
          <b>Can’t read your minimum</b>
          <span>The engine didn’t answer for your rules, so no minimum is drawn. The pairs below are as scanned and the desk is unaffected. It asks again every 30 s.</span>
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
    </div>
  );
}

// ---------- pairs ----------

interface PairsProps {
  rows: readonly PairRow[];
  sort: Sort;
  onSort(key: SortKey): void;
  minimum: number | null;
  /** The net is drawn on a scale beside its figure: the scopes on the desk's venues, where every pair has one. */
  scale: boolean;
  now: number;
  onOpen(id: string): void;
}

/** A column head that sorts its table: the same control on the pairs, the assets and the venues. */
function Head<K extends string>({ k, sort, onSort, children, className }: { k: K; sort: { key: K; dir: 1 | -1 }; onSort(key: K): void; children: ReactNode; className?: string }) {
  const on = sort.key === k;
  return (
    <th scope="col" className={cx(className, on && 'by')} aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => onSort(k)}>
        {children}
        {on ? <i aria-hidden="true">{sort.dir === 1 ? '↑' : '↓'}</i> : null}
      </button>
    </th>
  );
}

/** A side of a pair in the table: the venue, and under it its funding this hour and how often it pays. */
function Side({ venue, leg }: { venue: string; leg: LegView | null }) {
  return (
    <td className="w l">
      {venueName(venue)}
      <small>{leg === null ? '—' : `${rate(leg.aprPct)} · ${everyText(leg.settlement)}`}</small>
    </td>
  );
}

/** The word under an asset: held, refused and why, or what the open does first. A watch-only pair says so by its empty net. */
function statusOf(w: FundingWindow): { kind: string; text: string } | null {
  const status = rowStatus(w);
  return status.kind === 'none' || status.kind === 'watch' ? null : status;
}

const pctOf = (scale: NetScale, value: number): string => `${(Math.min(1, Math.max(0, (value - scale.lo) / (scale.hi - scale.lo))) * 100).toFixed(2)}%`;

function NetCell({ row, scale, minimum }: { row: PairRow; scale: NetScale | null; minimum: number | null }) {
  const { w, netPct } = row;
  const refused = w.refused !== undefined && w.refused !== null && !isNoDesk(w);
  const figure = netPct === null
    ? <span className="none" title="Costs are not priced on venues the desk cannot trade">—</span>
    : <span className={cx(refused && 'struck', !refused && netPct < 0 && 'down')}><Flash value={netPct}>{rate(netPct)}</Flash></span>;
  if (scale === null) return <td>{figure}</td>;
  return (
    <td className="sc-net">
      <div className="sc-scale">
        <b>{figure}</b>
        <div className="sc-track" aria-hidden="true">
          <i className="zero" style={{ left: pctOf(scale, 0) }} />
          {minimum === null ? null : <i className="min" style={{ left: pctOf(scale, minimum) }} />}
          {netPct === null ? null : (
            <>
              <i className="stem" style={{ left: pctOf(scale, Math.min(0, netPct)), right: `calc(100% - ${pctOf(scale, Math.max(0, netPct))})` }} />
              <i className={cx('pt', w.held && 'held', netPct < scale.lo && 'off')} style={{ left: pctOf(scale, netPct) }} />
            </>
          )}
        </div>
      </div>
    </td>
  );
}

/** Every listed pair: both sides with their funding, when it is next paid, the spread now and over 7 days, what is left after costs. */
export function PairsTable({ rows, sort, onSort, minimum, scale, now, onOpen }: PairsProps) {
  const net = useMemo(() => (scale ? netScale(rows, minimum) : null), [scale, rows, minimum]);
  return (
    <table className="st">
      <thead>
        <tr>
          <Head k="asset" sort={sort} onSort={onSort}>Asset</Head>
          <Head k="long" sort={sort} onSort={onSort} className="l">Long on</Head>
          <Head k="short" sort={sort} onSort={onSort} className="l">Short on</Head>
          <Head k="next" sort={sort} onSort={onSort}>Next funding</Head>
          <Head k="now" sort={sort} onSort={onSort}>Spread now</Head>
          <Head k="week" sort={sort} onSort={onSort}>7 days</Head>
          <Head k="net" sort={sort} onSort={onSort} className={net ? 'l' : undefined}>
            Net a year
            {net && minimum !== null ? <span className="g"> · dotted: your {pct(minimum, minimum % 1 === 0 ? 0 : 1)} minimum</span> : null}
          </Head>
          <Head k="gap" sort={sort} onSort={onSort} className="c-gap">Price gap</Head>
          <Head k="oi" sort={sort} onSort={onSort}>Open interest</Head>
          <Head k="volume" sort={sort} onSort={onSort} className="c-vol">Volume 24 h</Head>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const { w } = row;
          const status = statusOf(w);
          const next = pairNextAt(row, now);
          return (
            <tr
              key={w.id}
              data-flip={w.id}
              className={cx('go', isBelow(w, minimum) && !w.held && 'dimmed', w.stale && 'stale')}
              onClick={(e) => {
                // A click on the asset's own link already goes there; one with a modifier opens it elsewhere.
                if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || (e.target instanceof HTMLElement && e.target.closest('a'))) return;
                onOpen(w.id);
              }}
            >
              <td className="a">
                <a href={hashForWindow(w.id)}>{w.symbol}</a>
                {status ? <small className={status.kind}>{status.text}</small> : null}
              </td>
              <Side venue={w.longVenue} leg={row.long} />
              <Side venue={w.shortVenue} leg={row.short} />
              <td>{next === null ? (row.long === null ? NONE : <span className="g">live</span>) : countdown(next - now)}</td>
              <td><Flash value={w.grossAprPct}>{rate(w.grossAprPct)}</Flash></td>
              <td>{w.grossApr7dPct === null ? NONE : rate(w.grossApr7dPct)}</td>
              <NetCell row={row} scale={net} minimum={minimum} />
              <td className="c-gap">{row.gapPct === null ? NONE : signedPct(row.gapPct, 2)}</td>
              <td>{depth(w.depthUsd)}</td>
              <td className="c-vol">{row.volumeUsd === null ? NONE : depth(row.volumeUsd)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The phone's list: a pair is three lines. The large figure is the net where there is one, else the spread this hour. */
export function PairsList({ rows, minimum, now }: Pick<PairsProps, 'rows' | 'minimum' | 'now'>) {
  return (
    <ul className="ml">
      {rows.map((row) => {
        const { w } = row;
        const status = statusOf(w);
        const next = pairNextAt(row, now);
        const bits = [
          next === null ? null : `next ${countdown(next - now)}`,
          w.grossApr7dPct === null ? null : `7 d ${rate(w.grossApr7dPct)}`,
          `OI ${depth(w.depthUsd)}`,
        ].filter((b): b is string => b !== null);
        return (
          <li key={w.id} className={cx(isBelow(w, minimum) && !w.held && 'dimmed')}>
            <a href={hashForWindow(w.id)}>
              <span className="a">
                {w.symbol}
                {status ? <small className={status.kind}>{status.text}</small> : null}
              </span>
              <span className="n">{row.netPct === null ? rate(w.grossAprPct) : <span className={cx(row.netPct < 0 && 'down')}>{rate(row.netPct)}</span>}</span>
              <span className="v">{venueName(w.longVenue)} {'→'} {venueName(w.shortVenue)}</span>
              <span className="s">{row.netPct === null ? 'spread now' : `${rate(w.grossAprPct)} now`}</span>
              <span className="x">{bits.join(' · ')}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

// ---------- assets ----------

/** An asset's venues on its own scale: a tick each, zero marked, the desk's venues brighter. */
function Ladder({ asset }: { asset: AssetRow }) {
  const rates = asset.venues.map((v) => v.aprPct);
  const lo = Math.min(0, ...rates);
  const hi = Math.max(0, ...rates);
  const at = (v: number): string => `${(((v - lo) / (hi - lo || 1)) * 100).toFixed(2)}%`;
  return (
    <div className="lad" role="img" aria-label={`${asset.venues.length} venues from ${rate(Math.min(...rates))} to ${rate(Math.max(...rates))}`}>
      <i className="z" style={{ left: at(0) }} />
      {asset.venues.map((v) => (
        <i key={v.venue} className={v.desk ? 'd' : undefined} style={{ left: at(v.aprPct) }} title={`${v.name} ${rate(v.aprPct)}`} />
      ))}
    </div>
  );
}

/** Each asset across the venues its listed pairs are on: where funding is lowest and highest, and the widest pair. */
export function AssetsTable({ assets, sort, onSort, onPick }: { assets: readonly AssetRow[]; sort: AssetSort; onSort(key: AssetSortKey): void; onPick(symbol: string): void }) {
  return (
    <table className="st">
      <thead>
        <tr>
          <Head k="asset" sort={sort} onSort={onSort}>Asset</Head>
          <Head k="venues" sort={sort} onSort={onSort}>Venues</Head>
          <th scope="col" className="l">Funding by venue, a year</th>
          <Head k="low" sort={sort} onSort={onSort} className="l">Lowest</Head>
          <Head k="high" sort={sort} onSort={onSort} className="l">Highest</Head>
          <Head k="widest" sort={sort} onSort={onSort}>Widest pair now</Head>
          <Head k="net" sort={sort} onSort={onSort}>Best after costs</Head>
          <Head k="oi" sort={sort} onSort={onSort}>Open interest</Head>
          <Head k="volume" sort={sort} onSort={onSort} className="c-vol">Volume 24 h</Head>
        </tr>
      </thead>
      <tbody>
        {assets.map((a) => {
          const low = a.venues[0];
          const high = a.venues[a.venues.length - 1];
          return (
            <tr key={a.symbol} className="go" onClick={() => onPick(a.symbol)}>
              <td className="a">
                <button type="button" onClick={(e) => { e.stopPropagation(); onPick(a.symbol); }}>{a.symbol}</button>
                <small>{a.pairs} {a.pairs === 1 ? 'pair' : 'pairs'}</small>
              </td>
              <td>{a.venues.length === 0 ? NONE : a.venues.length}</td>
              <td className="l">{a.venues.length === 0 ? NONE : <Ladder asset={a} />}</td>
              <td className="w l">{low ? <>{low.name}<small>{rate(low.aprPct)}</small></> : NONE}</td>
              <td className="w l">{high ? <>{high.name}<small>{rate(high.aprPct)}</small></> : NONE}</td>
              <td>
                {rate(a.best.grossAprPct)}
                <small>{venueName(a.best.longVenue)} {'→'} {venueName(a.best.shortVenue)}</small>
              </td>
              <td>
                {a.bestDesk === null ? NONE : (
                  <>
                    <span className={cx(a.bestDesk.netAprPct < 0 && 'down')}>{rate(a.bestDesk.netAprPct)}</span>
                    <small>{venueName(a.bestDesk.longVenue)} {'→'} {venueName(a.bestDesk.shortVenue)}</small>
                  </>
                )}
              </td>
              <td>{a.oiUsd === null ? NONE : depth(a.oiUsd)}</td>
              <td className="c-vol">{a.volumeUsd === null ? NONE : depth(a.volumeUsd)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function AssetsList({ assets, onPick }: { assets: readonly AssetRow[]; onPick(symbol: string): void }) {
  return (
    <ul className="ml">
      {assets.map((a) => {
        const low = a.venues[0];
        const high = a.venues[a.venues.length - 1];
        return (
          <li key={a.symbol}>
            <a href="#/markets" onClick={(e) => { e.preventDefault(); onPick(a.symbol); }}>
              <span className="a">{a.symbol}</span>
              <span className="n">{rate(a.best.grossAprPct)}</span>
              <span className="v">{venueName(a.best.longVenue)} {'→'} {venueName(a.best.shortVenue)}</span>
              <span className="s">widest now</span>
              <span className="x">
                {a.venues.length} venues{low && high ? ` · ${rate(low.aprPct)} to ${rate(high.aprPct)}` : ''}{a.oiUsd === null ? '' : ` · OI ${depth(a.oiUsd)}`}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

// ---------- venues ----------

/** The venues the scan reads: what the desk does there, how large each is, and what the scan lists on it. */
export function VenuesTable({ venues, sort, onSort, now, onPick }: { venues: readonly VenueRow[]; sort: VenueSort; onSort(key: VenueSortKey): void; now: number; onPick(id: string): void }) {
  return (
    <table className="st">
      <thead>
        <tr>
          <Head k="venue" sort={sort} onSort={onSort}>Venue</Head>
          <Head k="kind" sort={sort} onSort={onSort} className="l">The desk</Head>
          <th scope="col" className="l c-gap">Pays funding</th>
          <Head k="markets" sort={sort} onSort={onSort}>Markets read</Head>
          <Head k="oi" sort={sort} onSort={onSort}>Open interest</Head>
          <Head k="volume" sort={sort} onSort={onSort} className="c-vol">Volume 24 h</Head>
          <Head k="pairs" sort={sort} onSort={onSort}>Pairs listed</Head>
          <Head k="widest" sort={sort} onSort={onSort}>Widest spread now</Head>
          <th scope="col">Read</th>
        </tr>
      </thead>
      <tbody>
        {venues.map((v) => (
          <tr key={v.id} className={cx(v.pairs > 0 && 'go', !v.ok && 'stale')} onClick={v.pairs > 0 ? () => onPick(v.id) : undefined}>
            <td className="a">
              {v.pairs > 0 ? <button type="button" onClick={(e) => { e.stopPropagation(); onPick(v.id); }}>{v.name}</button> : v.name}
            </td>
            <td className="w l">{kindText(v.kind)}</td>
            <td className="w l c-gap">{v.settlement === null ? NONE : everyWords(v.settlement)}</td>
            <td>{v.markets === null || !v.ok ? NONE : group.format(v.markets)}</td>
            <td>{v.oiUsd === null ? NONE : depth(v.oiUsd)}</td>
            <td className="c-vol">{v.volume24hUsd === null ? NONE : depth(v.volume24hUsd)}</td>
            <td>
              {v.pairs === 0 ? NONE : v.pairs}
              {v.pairs > 0 ? <small>{v.assets} {v.assets === 1 ? 'asset' : 'assets'}</small> : null}
            </td>
            <td>
              {v.best === null ? NONE : (
                <>
                  {rate(v.best.grossAprPct)}
                  <small>{v.best.symbol}</small>
                </>
              )}
            </td>
            <td>{!v.ok ? <span className="watch-t">no answer</span> : v.readAt === null ? NONE : ago(v.readAt, now)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function VenuesList({ venues, now, onPick }: { venues: readonly VenueRow[]; now: number; onPick(id: string): void }) {
  return (
    <ul className="ml">
      {venues.map((v) => (
        <li key={v.id}>
          <a href="#/markets" onClick={(e) => { e.preventDefault(); if (v.pairs > 0) onPick(v.id); }}>
            <span className="a">{v.name}</span>
            <span className="n">{v.oiUsd === null ? <span className="none">—</span> : depth(v.oiUsd)}</span>
            <span className="v">{kindText(v.kind)}</span>
            <span className="s">open interest</span>
            <span className="x">
              {[v.markets === null || !v.ok ? null : `${group.format(v.markets)} markets`, v.pairs > 0 ? `${v.pairs} pairs listed` : 'no pair listed', !v.ok ? 'no answer' : v.readAt === null ? null : `read ${ago(v.readAt, now)}`]
                .filter((b): b is string => b !== null).join(' · ')}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

// ---------- loading ----------

export function TableSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="w-sk-row" key={i}>
          <i style={{ width: 64 }} />
          <i style={{ width: 120 }} />
          <i style={{ width: 120 }} />
          <i style={{ flex: 1 }} />
          <i style={{ width: 72 }} />
        </div>
      ))}
    </div>
  );
}
