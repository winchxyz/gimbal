import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ScanStatus, StrategyConfig, Window as FundingWindow } from '@gimbal/shared';
import { useStream } from '../stream/hub.ts';
import { Readings, type Reading } from '../ui/Panel.tsx';
import { cx } from '../ui/cx.ts';
import { useNow } from '../ui/useNow.ts';
import { loadAlerts, reached, saveAlerts, toggleAlert, type Alert } from './alerts.ts';
import { Detail, Gone } from './Detail.tsx';
import { depth, pct } from './format.ts';
import { deskMissing, failedScan, heldWindow } from './model.ts';
import { marketsAnswer, marketsText } from './markets.ts';
import { hashForView, MARKETS_VIEWS, usePhone, useWindowRoute, type MarketsView } from './route.ts';
import { kept } from './kept.ts';
import {
  assetRows, defaultScope, defaultSort, firstDir, nextAssetSort, nextSort, nextVenueSort, OI_FLOORS, pairRows, scanLine, scanSummary,
  scopeCounts, SCOPES, selectAssets, selectPairs, sortVenues, venueQuery, venueRows, type PairRow, type Scope, type Sort, type SortKey,
} from './scanner.ts';
import { useFlip } from './useFlip.ts';
import { useHistories, useStrategy } from './useEngine.ts';
import { Ago, AssetsList, AssetsTable, Notices, PairsList, PairsTable, TableSkeleton, VenuesList, VenuesTable } from './WindowList.tsx';
import './windows.css';

/** Where the screen scrolls: <main> on the desktop, the document on the phone. */
const scroller = {
  get: (): number => document.querySelector<HTMLElement>('main.page')?.scrollTop || window.scrollY,
  set: (y: number): void => {
    const main = document.querySelector<HTMLElement>('main.page');
    if (main) main.scrollTop = y;
    window.scrollTo(0, y);
  },
};

/**
 * Markets: the scanner. One sentence and what the scan holds, then every listed pair with both of its sides, the
 * same pairs gathered by asset and by venue, and a page per pair.
 */
export function WindowsScreen() {
  const windows = useStream((s) => s.windows);
  const scan = useStream((s) => s.scan);
  const strategyState = useStrategy();
  const strategy = strategyState.value;
  const route = useWindowRoute();
  const [alerts, setAlerts] = useState<Alert[]>(loadAlerts);

  const all = useMemo(() => windows ?? [], [windows]);
  const held = heldWindow(all);
  // The chart of the pair that is open, and of the held one drawn behind it.
  const wanted = useMemo(() => {
    const open = route.id === null ? null : all.find((w) => w.id === route.id) ?? null;
    return [open, held].filter((w): w is FundingWindow => w !== null && w.tradable).map((w) => w.id).filter((id, i, ids) => ids.indexOf(id) === i);
  }, [all, held, route.id]);
  const histories = useHistories(wanted);

  const toggle = useCallback((alert: Alert) => {
    setAlerts((current) => {
      const next = toggleAlert(current, alert);
      saveAlerts(next);
      return next;
    });
  }, []);

  // A pair opens at its top; the list comes back where it was left.
  const onList = route.id === null;
  useLayoutEffect(() => {
    scroller.set(onList ? kept.scrollTop : 0);
  }, [onList, route.id]);

  if (windows === null || strategyState.status === 'loading') return <Loading />;

  if (route.id !== null) {
    const w = all.find((x) => x.id === route.id) ?? null;
    if (w === null) return <Gone />;
    return <Detail w={w} windows={all} strategy={strategy} histories={histories} alerts={alerts} onToggleAlert={toggle} />;
  }

  return (
    <Scanner
      all={all}
      scan={scan}
      strategy={strategy}
      strategyError={strategyState.status === 'error' && strategy === null ? strategyState.error : null}
      view={route.view}
      alerts={alerts}
      onClearAlert={toggle}
      onOpen={(id) => {
        kept.scrollTop = scroller.get();
        route.open(id);
      }}
    />
  );
}

interface ScannerProps {
  all: readonly FundingWindow[];
  scan: ScanStatus | null;
  strategy: StrategyConfig | null;
  strategyError: string | null;
  view: MarketsView;
  alerts: readonly Alert[];
  onClearAlert(alert: Alert): void;
  onOpen(id: string): void;
}

const SORT_LABELS: readonly { key: SortKey; label: string }[] = [
  { key: 'net', label: 'Net a year' },
  { key: 'now', label: 'Spread now' },
  { key: 'week', label: 'Spread, 7 days' },
  { key: 'next', label: 'Next funding' },
  { key: 'oi', label: 'Open interest' },
  { key: 'volume', label: 'Volume 24 h' },
  { key: 'gap', label: 'Price gap' },
  { key: 'asset', label: 'Asset, A to Z' },
];

function Scanner({ all, scan, strategy, strategyError, view, alerts, onClearAlert, onOpen }: ScannerProps) {
  const phone = usePhone();
  const now = useNow(20_000);
  const minimum = strategy?.minNetAprPct ?? null;
  const rows = useMemo(() => pairRows(all), [all]);
  const counts = useMemo(() => scopeCounts(rows), [rows]);

  const [scopeChosen, setScope] = useState<Scope | null>(kept.scope);
  const [sortChosen, setSort] = useState<Sort | null>(kept.sort);
  const [text, setText] = useState(kept.text);
  const [minOiUsd, setMinOi] = useState(kept.minOiUsd);
  const [assetSort, setAssetSort] = useState(kept.assetSort);
  const [venueSort, setVenueSort] = useState(kept.venueSort);
  const scope = scopeChosen ?? defaultScope(rows);
  const sort = sortChosen ?? defaultSort(text.trim() === '' ? scope : 'all');
  useEffect(() => {
    Object.assign(kept, { scope: scopeChosen, sort: sortChosen, text, minOiUsd, assetSort, venueSort });
  }, [scopeChosen, sortChosen, text, minOiUsd, assetSort, venueSort]);

  const searching = text.trim() !== '';
  const sorted = useMemo(() => selectPairs(rows, { scope, text, minOiUsd, sort }, now), [rows, scope, text, minOiUsd, sort, now]);

  // While the pointer is over the table the rows keep their order: a pair must not move out from under it between
  // two scans. The order is taken again as soon as the pointer leaves, or the visitor asks for another one.
  const [hovering, setHovering] = useState(false);
  const frozen = useRef<{ key: string; ids: string[] } | null>(null);
  const orderKey = `${scope}|${sort.key}|${sort.dir}|${text}|${minOiUsd}`;
  const shown = useMemo(() => {
    if (!hovering) {
      frozen.current = null;
      return sorted;
    }
    if (frozen.current === null || frozen.current.key !== orderKey) frozen.current = { key: orderKey, ids: sorted.map((r) => r.w.id) };
    const place = new Map(frozen.current.ids.map((id, i) => [id, i]));
    return [...sorted].sort((a, b) => (place.get(a.w.id) ?? Infinity) - (place.get(b.w.id) ?? Infinity));
  }, [sorted, hovering, orderKey]);

  const body = useRef<HTMLDivElement>(null);
  useFlip(body);

  const assets = useMemo(() => assetRows(rows), [rows]);
  const assetsShown = useMemo(() => selectAssets(assets, text, assetSort), [assets, text, assetSort]);
  const venues = useMemo(() => sortVenues(venueRows(scan, rows), venueSort), [scan, rows, venueSort]);
  const summary = scanSummary(scan, rows, minimum);
  const answer = marketsAnswer(all, minimum);
  const held = heldWindow(all);

  /** A click on an asset or a venue: the pairs it is in, over every venue. */
  const pick = (query: string) => {
    setText(query);
    setSort(null);
    kept.scrollTop = 0;
    window.location.hash = hashForView('pairs');
  };

  const readings: Reading[] = [
    {
      label: 'Venues answering',
      value: summary.venues === null ? '—' : `${summary.answering} of ${summary.venues}`,
      tone: summary.venues !== null && summary.answering !== summary.venues ? 'watch-t' : null,
    },
    { label: 'Pairs listed', value: <>{summary.pairs}<small> on {summary.assets} {summary.assets === 1 ? 'asset' : 'assets'}</small></> },
    { label: 'Open to the desk', value: summary.open },
    ...(minimum === null || summary.clearing === null ? [] : [{ label: `Pay your ${pct(minimum, minimum % 1 === 0 ? 0 : 1)} minimum now`, value: summary.clearing }]),
  ];

  const sentence = marketsText(answer);
  const viewCount: Record<MarketsView, number> = { pairs: rows.length, assets: assets.length, venues: venues.length };

  return (
    <>
      <div className="top sc-top">
        <h1 className={cx('answer', sentence.length > 54 && 'long')} data-testid="markets-answer">
          {answer.lead}
          {answer.rate === null ? null : <span className={answer.tone ?? undefined}>{answer.rate}</span>}
          {answer.rest}
        </h1>
        {/* The phone has no room for the readings above the list: it says the scan in one line, and the counts are on the views. */}
        <p className="sc-sum">{scanLine(summary, minimum)}</p>
        <Readings rows={readings} shut />
      </div>
      <Notices
        noDesk={deskMissing(all)}
        failed={failedScan(scan, all)}
        held={held}
        reached={reached(alerts, all)}
        onClearAlert={onClearAlert}
        strategyError={strategyError}
      />

      <section className="sc" aria-label="Scanner">
        <div className="sc-bar">
          <nav className="seg" aria-label="Views of the scan">
            {MARKETS_VIEWS.map((v) => (
              <a key={v.id} href={hashForView(v.id)} className={view === v.id ? 'on' : undefined} aria-current={view === v.id ? 'page' : undefined}>
                {v.label}
                <i>{viewCount[v.id]}</i>
              </a>
            ))}
          </nav>
          <span>
            <span className="wide">Funding is each venue’s rate this hour, stated as a year{scan ? ' · ' : ''}</span>
            {scan ? <>scanned <Ago at={scan.at} /></> : null}
          </span>
        </div>

        {view === 'pairs' ? (
          <>
            <div className="sc-ctl">
              <div className="seg" role="group" aria-label="Which pairs">
                {SCOPES.map((s) => (
                  <button key={s.id} type="button" className={!searching && scope === s.id ? 'on' : undefined} aria-pressed={!searching && scope === s.id}
                    onClick={() => { setScope(s.id); setSort(null); setText(''); }}>
                    {s.label}
                    <i>{counts[s.id]}</i>
                  </button>
                ))}
              </div>
              <span className="lbl">Open interest from</span>
              <div className="seg oi" role="group" aria-label="Open interest on the thinner side, at least">
                {OI_FLOORS.map((floor) => (
                  <button key={floor} type="button" className={minOiUsd === floor ? 'on' : undefined} aria-pressed={minOiUsd === floor} onClick={() => setMinOi(floor)}>
                    {floor === 0 ? 'any' : depth(floor)}
                  </button>
                ))}
              </div>
              <label className="sc-pick">
                Sort
                <select value={sort.key} onChange={(e) => setSort({ key: e.target.value as SortKey, dir: firstDir(e.target.value as SortKey) })}>
                  {SORT_LABELS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </label>
              <label className="sc-pick">
                Size
                <select value={minOiUsd} onChange={(e) => setMinOi(Number(e.target.value))}>
                  {OI_FLOORS.map((floor) => <option key={floor} value={floor}>{floor === 0 ? 'any open interest' : `${depth(floor)} and up`}</option>)}
                </select>
              </label>
              <Search value={text} onChange={(v) => { setText(v); setSort(null); }} placeholder="Asset or venue" />
            </div>
            {shown.length === 0 ? (
              <p className="sc-none">{noneText(searching, text, minOiUsd, scope)}</p>
            ) : (
              <div ref={body} onPointerEnter={(e) => e.pointerType === 'mouse' && setHovering(true)} onPointerLeave={() => setHovering(false)}>
                {phone
                  ? <PairsList rows={shown} minimum={minimum} now={now} />
                  : <PairsTable rows={shown} sort={sort} onSort={(key) => setSort(nextSort(sort, key))} minimum={minimum} scale={showScale(shown)} now={now} onOpen={onOpen} />}
              </div>
            )}
            <p className="sc-foot">
              {searching ? `${shown.length} of ${rows.length} listed pairs, over every venue. ` : ''}
              {ANNUAL}
              The spread is the short side’s funding less the long side’s: what the pair collects before costs. Net is what is left after fees,
              slippage, the price gap and the rescue reserve, on the engine’s 7 to 14 day basis; it is worked out for the venues the desk trades.
              A watch-only pair shows this hour’s spread stated as a year, not a forecast.
            </p>
          </>
        ) : view === 'assets' ? (
          <>
            <div className="sc-ctl">
              <Search value={text} onChange={setText} placeholder="Asset or venue" />
            </div>
            {assetsShown.length === 0 ? <p className="sc-none">No listed asset matches “{text.trim()}”.</p> : phone
              ? <AssetsList assets={assetsShown} onPick={pick} />
              : <AssetsTable assets={assetsShown} sort={assetSort} onSort={(key) => setAssetSort(nextAssetSort(assetSort, key))} onPick={pick} />}
            <p className="sc-foot">
              {ANNUAL}
              An asset’s venues are the ones its listed pairs are on, each a tick at its funding this hour; the brighter ticks are venues the desk
              trades. Two venues are compared only where the scan paired them, since it pairs markets whose prices agree.
            </p>
          </>
        ) : (
          <>
            <div className="sc-ctl" />
            {phone
              ? <VenuesList venues={venues} now={now} onPick={(id) => pick(venueQuery(id))} />
              : <VenuesTable venues={venues} sort={venueSort} onSort={(key) => setVenueSort(nextVenueSort(venueSort, key))} now={now} onPick={(id) => pick(venueQuery(id))} />}
            <p className="sc-foot">
              The desk opens positions on Hyperliquid, Phoenix and Orderly. Every other venue is read for its funding only: the scan ranks
              what it pays, and nothing is ever sent there.
            </p>
          </>
        )}
      </section>
    </>
  );
}

/** On the phone the line beside the views has no room for this, so the note under the list opens with it. */
const ANNUAL = <span className="narrow">Funding is each venue’s rate this hour, stated as a year. </span>;

/** The net sits on a scale when every pair shown has one: the desk's venues. A search over every venue lists figures only. */
const showScale = (rows: readonly PairRow[]): boolean => rows.length > 0 && rows.every((r) => r.netPct !== null);

function noneText(searching: boolean, text: string, minOiUsd: number, scope: Scope): string {
  const size = minOiUsd > 0 ? ` with ${depth(minOiUsd)} of open interest or more` : '';
  if (searching) return `No listed pair matches “${text.trim()}”${size}.`;
  if (scope === 'open') return `No pair is open to the desk in this scan${size}.`;
  return `No pair is listed${size}.`;
}

function Search({ value, onChange, placeholder }: { value: string; onChange(value: string): void; placeholder: string }) {
  return (
    <label className="field">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="6" cy="6" r="4.4" /><path d="M9.4 9.4 13 13" strokeLinecap="round" /></svg>
      <input type="search" value={value} placeholder={placeholder} aria-label="Search the listed pairs" autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      {value === '' ? null : <button type="button" onClick={() => onChange('')}>Clear</button>}
    </label>
  );
}

/** Loading: the same frame with still bars where the figures go. */
function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading the markets">
      <div className="top" aria-hidden="true">
        <div>
          <i className="sk" style={{ width: '82%', height: 58 }} />
          <i className="sk" style={{ width: '48%', height: 58, marginTop: 10 }} />
        </div>
        <div>
          {[0, 1, 2].map((i) => <i key={i} className="sk" style={{ width: '100%', height: 18, marginTop: 20 }} />)}
        </div>
      </div>
      <section className="sc">
        <TableSkeleton />
      </section>
    </div>
  );
}
