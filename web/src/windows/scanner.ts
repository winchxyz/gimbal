// The scanner on Markets: every pair the engine lists with both of its sides, each asset across the venues that list
// it, and the venues the scan reads. Pure functions over the shared types, so the scopes, the sorting, the search and
// every figure are tested without a browser. A pair's sides (`Window.legs`) and the venues (`ScanStatus.sources`) are
// optional in the payload: an engine from before them still draws, with those columns empty.
import type { ScanSource, ScanStatus, Window as FundingWindow, WindowLeg } from '@gimbal/shared';
import { venueName } from './format.ts';
import { isOpenToDesk } from './markets.ts';
import { hasHistory, isEnterable, TRADABLE_VENUES } from './model.ts';

const HOUR = 3_600_000;
const HOURS_A_YEAR = 8760;

/** A venue's hourly funding rate stated as a year, in percent: the figure every venue's own page shows. */
export const aprOfHourly = (ratePerHour: number): number => ratePerHour * HOURS_A_YEAR * 100;

type Settlement = WindowLeg['settlement'];

const PERIOD_MS: Readonly<Record<Settlement, number>> = { hourly: HOUR, '2h': 2 * HOUR, '4h': 4 * HOUR, '8h': 8 * HOUR, daily: 24 * HOUR, continuous: 0 };

/** How often a venue pays funding: `1 h`, `8 h`, `24 h`; `live` where it accrues with every block. */
export const everyText = (s: Settlement): string => (s === 'continuous' ? 'live' : `${PERIOD_MS[s] / HOUR} h`);

/** The same in a sentence: `every hour`, `every 8 hours`, `once a day`, `continuously`. */
export function everyWords(s: Settlement): string {
  if (s === 'continuous') return 'continuously';
  if (s === 'hourly') return 'every hour';
  if (s === 'daily') return 'once a day';
  return `every ${PERIOD_MS[s] / HOUR} hours`;
}

/**
 * When a leg is next paid: the venue's own time when it is still ahead, else rolled forward by its period (a reading
 * a few minutes old may name a payment that has passed). Null where funding accrues continuously.
 */
export function nextPayment(leg: Pick<WindowLeg, 'settlement' | 'nextAt'>, now: number): number | null {
  const period = PERIOD_MS[leg.settlement];
  if (period === 0) return null;
  if (leg.nextAt > now) return leg.nextAt;
  return leg.nextAt + (Math.floor((now - leg.nextAt) / period) + 1) * period;
}

/** `under 1 min`, `12 min`, `1 h 05`, `7 h 41`: the time left until a payment. */
export function countdown(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

export type VenueKind = ScanSource['kind'];

/** One side of a pair as the scanner shows it. */
export interface LegView {
  venue: string;
  name: string;
  /** The venue's own name for the market: `PERP_SOL_USDC`. */
  symbol: string;
  /** Funding this hour, stated as a year, percent. Positive: longs pay shorts. */
  aprPct: number;
  /** Its mean over 7 days, the same way; null when the week is not read (watch-only venues). */
  apr7dPct: number | null;
  settlement: Settlement;
  nextAt: number;
  markPx: number | null;
  oiUsd: number | null;
  volume24hUsd: number | null;
  move24hPct: number | null;
  readAt: number;
}

const legView = (venue: string, leg: WindowLeg): LegView => ({
  venue,
  name: venueName(venue),
  symbol: leg.symbol,
  aprPct: aprOfHourly(leg.ratePerHour),
  apr7dPct: leg.apr7dPct,
  settlement: leg.settlement,
  nextAt: leg.nextAt,
  markPx: leg.markPx,
  oiUsd: leg.oiUsd,
  volume24hUsd: leg.volume24hUsd,
  move24hPct: leg.move24hPct,
  readAt: leg.readAt,
});

/** A pair on the scanner: the engine's window, with what is worked out from its two sides. */
export interface PairRow {
  w: FundingWindow;
  /** Null when the engine sent no sides (an engine from before `Window.legs`). */
  long: LegView | null;
  short: LegView | null;
  /** The short's mark over the long's, percent: above zero the pair opens selling the dearer side. */
  gapPct: number | null;
  /** 24-hour volume on the quieter side. */
  volumeUsd: number | null;
  /** After costs, a year; null for a watch-only pair, whose costs are not priced. */
  netPct: number | null;
  open: boolean;
}

/** The short side's mark over the long side's, in percent of the long's. */
export function priceGapPct(longPx: number | null, shortPx: number | null): number | null {
  if (longPx === null || shortPx === null || !(longPx > 0) || !(shortPx > 0)) return null;
  return (shortPx / longPx - 1) * 100;
}

const least = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : Math.min(a, b));

export function pairRow(w: FundingWindow): PairRow {
  const long = w.legs ? legView(w.longVenue, w.legs.long) : null;
  const short = w.legs ? legView(w.shortVenue, w.legs.short) : null;
  return {
    w,
    long,
    short,
    gapPct: priceGapPct(long?.markPx ?? null, short?.markPx ?? null),
    volumeUsd: least(long?.volume24hUsd ?? null, short?.volume24hUsd ?? null),
    netPct: w.tradable ? w.netAprPct : null,
    open: isOpenToDesk(w),
  };
}

export const pairRows = (windows: readonly FundingWindow[]): PairRow[] => windows.map(pairRow);

/** The sooner of a pair's two payments, or null when neither side pays on a clock. */
export function pairNextAt(row: PairRow, now: number): number | null {
  const times = [row.long, row.short].map((l) => (l ? nextPayment(l, now) : null)).filter((t): t is number => t !== null);
  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * Which pairs are listed: `open` the ones the desk may enter, `desk` every pair on the venues it trades (refused ones
 * too), `all` every pair the scan lists, watch-only venues included.
 */
export type Scope = 'open' | 'desk' | 'all';

export const SCOPES: readonly { id: Scope; label: string }[] = [
  { id: 'open', label: 'Open to the desk' },
  { id: 'desk', label: 'Desk venues' },
  { id: 'all', label: 'All venues' },
];

export const inScope = (row: PairRow, scope: Scope): boolean => (scope === 'all' ? true : scope === 'desk' ? row.w.tradable : row.open);

export function scopeCounts(rows: readonly PairRow[]): Record<Scope, number> {
  return { open: rows.filter((r) => r.open).length, desk: rows.filter((r) => r.w.tradable).length, all: rows.length };
}

/** The scope a visitor lands on: what the desk may enter; with none, its venues; with none of those, everything. */
export function defaultScope(rows: readonly PairRow[]): Scope {
  const n = scopeCounts(rows);
  return n.open > 0 ? 'open' : n.desk > 0 ? 'desk' : 'all';
}

export type SortKey = 'asset' | 'long' | 'short' | 'next' | 'now' | 'week' | 'net' | 'gap' | 'oi' | 'volume';

export interface Sort {
  key: SortKey;
  /** 1 ascending, -1 descending. */
  dir: 1 | -1;
}

/** The direction a column sorts in first: names A to Z, the next payment soonest first, every figure largest first. */
export const firstDir = (key: SortKey): 1 | -1 => (key === 'asset' || key === 'next' ? 1 : -1);

/** What a scope is ranked by before the visitor picks a column: net after costs on the desk's venues, the spread now over all. */
export const defaultSort = (scope: Scope): Sort => ({ key: scope === 'all' ? 'now' : 'net', dir: -1 });

/** A click on a column head: the column's first direction, or the other one when it already sorts. */
export const nextSort = (sort: Sort, key: SortKey): Sort => (sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: firstDir(key) });

function sortValue(row: PairRow, key: SortKey, now: number): number | string | null {
  switch (key) {
    case 'asset': return row.w.symbol;
    case 'long': return row.long?.aprPct ?? null;
    case 'short': return row.short?.aprPct ?? null;
    case 'next': return pairNextAt(row, now);
    case 'now': return row.w.grossAprPct;
    case 'week': return row.w.grossApr7dPct;
    // Without its 7 days a net is this hour stated as a year: the engine never enters on it, so it ranks with the unknown.
    case 'net': return row.netPct !== null && hasHistory(row.w) ? row.netPct : null;
    case 'gap': return row.gapPct === null ? null : Math.abs(row.gapPct);
    case 'oi': return row.w.depthUsd;
    case 'volume': return row.volumeUsd;
  }
}

/** Sorted by one column. A row with no value there goes last in both directions; ties keep one order between updates. */
export function sortPairs(rows: readonly PairRow[], sort: Sort, now: number): PairRow[] {
  // The same value: the better figure first (net, then the spread), then the name.
  return sortedBy(rows, (row) => sortValue(row, sort.key, now), sort.dir, (a, b) =>
    (b.netPct ?? -Infinity) - (a.netPct ?? -Infinity) || b.w.grossAprPct - a.w.grossAprPct || a.w.symbol.localeCompare(b.w.symbol) || a.w.id.localeCompare(b.w.id));
}

const fold = (text: string): string => text.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();

/** What a pair is found by: its asset, both venues by id and by name, and the venues' own market names. */
const haystack = (row: PairRow): string =>
  fold([row.w.symbol, row.w.longVenue, row.w.shortVenue, venueName(row.w.longVenue), venueName(row.w.shortVenue), row.long?.symbol ?? '', row.short?.symbol ?? ''].join(' '));

/** The assets and venues among the listed pairs: a search word that is one of them, whole, means that one only. */
export interface Known {
  symbols: ReadonlySet<string>;
  venues: ReadonlySet<string>;
}

export function knownOf(rows: readonly PairRow[]): Known {
  return {
    symbols: new Set(rows.map((r) => r.w.symbol.toLowerCase())),
    venues: new Set(rows.flatMap((r) => [r.w.longVenue.toLowerCase(), r.w.shortVenue.toLowerCase()])),
  };
}

/**
 * Every word of the search must be in the pair: `sol phoenix` finds SOL pairs with a Phoenix side. A word that is a
 * listed asset's whole name, or a venue's whole id, finds only that one (`sol` is SOL, not SOLV; `hyperliquid` is not
 * its builder dexes); any other word is looked for inside the names.
 */
export function matches(row: PairRow, text: string, known: Known | null = null): boolean {
  const words = text.toLowerCase().split(/\s+/).filter((t) => t !== '');
  if (words.length === 0) return true;
  const hay = haystack(row);
  return words.every((word) => {
    if (known?.venues.has(word)) return row.w.longVenue.toLowerCase() === word || row.w.shortVenue.toLowerCase() === word;
    if (known?.symbols.has(word)) return row.w.symbol.toLowerCase() === word;
    const part = fold(word);
    return part === '' || part.split(' ').every((p) => hay.includes(p));
  });
}

/** What a click on a venue writes in the search: its name where that reads as its id, else the id itself. */
export const venueQuery = (id: string): string => (venueName(id).toLowerCase() === id.toLowerCase() ? venueName(id) : id);

/** Open-interest floors a visitor can set, USD on the thinner side; 0 lists every size. */
export const OI_FLOORS: readonly number[] = [0, 100_000, 1_000_000, 10_000_000];

export interface PairQuery {
  scope: Scope;
  text: string;
  minOiUsd: number;
  sort: Sort;
}

export function selectPairs(rows: readonly PairRow[], query: PairQuery, now: number): PairRow[] {
  // A search looks through every pair the scan lists: the venue or coin typed may sit outside the scope shown.
  const searching = query.text.trim() !== '';
  const known = searching ? knownOf(rows) : null;
  const scoped = rows.filter((r) => (searching ? matches(r, query.text, known) : inScope(r, query.scope)) && r.w.depthUsd >= query.minOiUsd);
  return sortPairs(scoped, query.sort, now);
}

/** The scale the nets of a list are drawn on, in percent a year. */
export interface NetScale {
  lo: number;
  hi: number;
}

/**
 * One scale for the nets of the pairs shown, so their dots compare: from zero (or what is under it) up to the best,
 * on round tens, and never so far under zero that the paying pairs are squeezed: a pair that loses more than half the
 * best pays is drawn at the left end, hollow, with its figure beside it.
 */
export function netScale(rows: readonly PairRow[], minimum: number | null): NetScale {
  const nets = rows.map((r) => r.netPct).filter((n): n is number => n !== null);
  const hi = Math.max(10, Math.ceil(Math.max(0, minimum === null ? 0 : minimum * 2, ...nets) / 10) * 10);
  const lowest = Math.min(0, ...nets);
  const lo = Math.max(Math.floor(lowest / 10) * 10, -hi / 2);
  return { lo, hi };
}

// ---------- assets ----------

/** One venue's funding on an asset, as read for a listed pair. */
export interface VenueRate {
  venue: string;
  name: string;
  aprPct: number;
  apr7dPct: number | null;
  settlement: Settlement;
  nextAt: number;
  markPx: number | null;
  oiUsd: number | null;
  volume24hUsd: number | null;
  desk: boolean;
  readAt: number;
}

export interface AssetRow {
  symbol: string;
  /** Every venue among the listed pairs, the lowest funding first. */
  venues: VenueRate[];
  /** The listed pair with the widest spread this hour. */
  best: FundingWindow;
  /** The best pair on the desk's venues after costs, when one has its 7 days in. */
  bestDesk: FundingWindow | null;
  pairs: number;
  /** Open interest over the venues that report it. */
  oiUsd: number | null;
  volumeUsd: number | null;
}

/**
 * The listed pairs gathered by asset. A venue's rate is read once per asset however many pairs use it (the freshest
 * reading wins). The spread shown is the best listed pair's: two venues are only compared where the scanner paired
 * them, since it pairs markets whose prices agree.
 */
export function assetRows(rows: readonly PairRow[]): AssetRow[] {
  const by = new Map<string, { venues: Map<string, VenueRate>; windows: FundingWindow[] }>();
  for (const row of rows) {
    const entry = by.get(row.w.symbol) ?? { venues: new Map<string, VenueRate>(), windows: [] };
    entry.windows.push(row.w);
    for (const leg of [row.long, row.short]) {
      if (leg === null) continue;
      const had = entry.venues.get(leg.venue);
      if (had && had.readAt >= leg.readAt) continue;
      entry.venues.set(leg.venue, {
        venue: leg.venue, name: leg.name, aprPct: leg.aprPct, apr7dPct: leg.apr7dPct, settlement: leg.settlement, nextAt: leg.nextAt,
        markPx: leg.markPx, oiUsd: leg.oiUsd, volume24hUsd: leg.volume24hUsd, desk: TRADABLE_VENUES.includes(leg.venue), readAt: leg.readAt,
      });
    }
    by.set(row.w.symbol, entry);
  }
  const sum = (values: (number | null)[]): number | null => {
    const known = values.filter((v): v is number => v !== null);
    return known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
  };
  const out: AssetRow[] = [];
  for (const [symbol, entry] of by) {
    const venues = [...entry.venues.values()].sort((a, b) => a.aprPct - b.aprPct || a.venue.localeCompare(b.venue));
    const best = entry.windows.reduce((a, b) => (b.grossAprPct > a.grossAprPct ? b : a));
    const desk = entry.windows.filter((w) => w.tradable && hasHistory(w));
    out.push({
      symbol,
      venues,
      best,
      bestDesk: desk.length > 0 ? desk.reduce((a, b) => (b.netAprPct > a.netAprPct ? b : a)) : null,
      pairs: entry.windows.length,
      oiUsd: sum(venues.map((v) => v.oiUsd)),
      volumeUsd: sum(venues.map((v) => v.volume24hUsd)),
    });
  }
  return out.sort((a, b) => b.best.grossAprPct - a.best.grossAprPct || a.symbol.localeCompare(b.symbol));
}

/** One column's order over any rows: a row with no value there goes last in both directions, ties fall to `tie`. */
function sortedBy<T>(rows: readonly T[], value: (row: T) => number | string | null, dir: 1 | -1, tie: (a: T, b: T) => number): T[] {
  const keyed = rows.map((row) => ({ row, v: value(row) }));
  keyed.sort((a, b) => {
    if (a.v === null || b.v === null) {
      if (a.v !== b.v) return a.v === null ? 1 : -1;
    } else if (a.v !== b.v) {
      const order = typeof a.v === 'string' || typeof b.v === 'string' ? String(a.v).localeCompare(String(b.v)) : a.v - b.v;
      if (order !== 0) return order * dir;
    }
    return tie(a.row, b.row);
  });
  return keyed.map((k) => k.row);
}

export type AssetSortKey = 'asset' | 'venues' | 'low' | 'high' | 'widest' | 'net' | 'oi' | 'volume';

export interface AssetSort {
  key: AssetSortKey;
  dir: 1 | -1;
}

export const DEFAULT_ASSET_SORT: AssetSort = { key: 'widest', dir: -1 };

/** A click on a column of the assets: names A to Z and the lowest funding lowest first, every other figure largest first. */
export const nextAssetSort = (sort: AssetSort, key: AssetSortKey): AssetSort =>
  sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: key === 'asset' || key === 'low' ? 1 : -1 };

export function sortAssets(assets: readonly AssetRow[], sort: AssetSort): AssetRow[] {
  const value = (a: AssetRow): number | string | null => {
    switch (sort.key) {
      case 'asset': return a.symbol;
      case 'venues': return a.venues.length;
      case 'low': return a.venues[0]?.aprPct ?? null;
      case 'high': return a.venues[a.venues.length - 1]?.aprPct ?? null;
      case 'widest': return a.best.grossAprPct;
      case 'net': return a.bestDesk?.netAprPct ?? null;
      case 'oi': return a.oiUsd;
      case 'volume': return a.volumeUsd;
    }
  };
  return sortedBy(assets, value, sort.dir, (a, b) => b.best.grossAprPct - a.best.grossAprPct || a.symbol.localeCompare(b.symbol));
}

/** Assets whose name has the search in it; an empty search keeps them all. */
export function selectAssets(assets: readonly AssetRow[], text: string, sort: AssetSort = DEFAULT_ASSET_SORT): AssetRow[] {
  const words = fold(text).split(' ').filter((t) => t !== '');
  const found = words.length === 0 ? assets : assets.filter((a) => {
    const hay = fold([a.symbol, ...a.venues.flatMap((v) => [v.venue, v.name])].join(' '));
    return words.every((word) => hay.includes(word));
  });
  return sortAssets(found, sort);
}

/** The other listed pairs on the same asset as `w`, the better figure first: what a visitor compares a pair against. */
export function siblingPairs(rows: readonly PairRow[], w: FundingWindow): PairRow[] {
  return rows
    .filter((r) => r.w.symbol === w.symbol && r.w.id !== w.id)
    .sort((a, b) => Number(b.w.tradable) - Number(a.w.tradable)
      || (a.w.tradable ? b.w.netAprPct - a.w.netAprPct : b.w.grossAprPct - a.w.grossAprPct) || a.w.id.localeCompare(b.w.id));
}

// ---------- venues ----------

export interface VenueRow {
  id: string;
  name: string;
  /** Null when the engine names no kind (an engine from before `ScanStatus.sources`). */
  kind: VenueKind | null;
  markets: number | null;
  oiUsd: number | null;
  volume24hUsd: number | null;
  readAt: number | null;
  ok: boolean;
  /** Listed pairs with a side on this venue, and the assets they are on. */
  pairs: number;
  assets: number;
  /** The widest listed spread with a side here. */
  best: FundingWindow | null;
  /** How often it pays funding, on most of its listed markets; null when no listed pair has a side here. */
  settlement: Settlement | null;
}

const KIND_ORDER: Readonly<Record<VenueKind, number>> = { desk: 0, dex: 1, cex: 2 };

export const kindText = (kind: VenueKind | null): string => (kind === 'desk' ? 'Desk trades here' : kind === 'dex' ? 'DEX, watch-only' : kind === 'cex' ? 'CEX, reference' : '—');

/** The venues the scan reads, the desk's first, then the other DEXs, then the exchanges; each group the largest first. */
export function venueRows(scan: ScanStatus | null, rows: readonly PairRow[]): VenueRow[] {
  const listed = new Map<string, { pairs: number; assets: Set<string>; best: FundingWindow | null; paid: Map<Settlement, number> }>();
  for (const { w, long, short } of rows) {
    for (const venue of new Set([w.longVenue, w.shortVenue])) {
      const entry = listed.get(venue) ?? { pairs: 0, assets: new Set<string>(), best: null, paid: new Map<Settlement, number>() };
      entry.pairs += 1;
      entry.assets.add(w.symbol);
      if (entry.best === null || w.grossAprPct > entry.best.grossAprPct) entry.best = w;
      const leg = venue === w.longVenue ? long : short;
      if (leg !== null) entry.paid.set(leg.settlement, (entry.paid.get(leg.settlement) ?? 0) + 1);
      listed.set(venue, entry);
    }
  }
  const most = (paid: Map<Settlement, number> | undefined): Settlement | null =>
    paid === undefined || paid.size === 0 ? null : [...paid].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const failed = new Set(scan?.failed ?? []);
  const sources: readonly ScanSource[] = scan?.sources
    ?? [...listed.keys()].map((id): ScanSource => ({ id, kind: TRADABLE_VENUES.includes(id) ? 'desk' : 'dex', markets: 0, oiUsd: null, volume24hUsd: null, readAt: null, ok: !failed.has(id) }));
  const known = scan?.sources !== undefined;
  const out = sources.map((s): VenueRow => {
    const entry = listed.get(s.id);
    return {
      id: s.id, name: venueName(s.id), kind: known || TRADABLE_VENUES.includes(s.id) ? s.kind : null,
      markets: known ? s.markets : null, oiUsd: s.oiUsd, volume24hUsd: s.volume24hUsd, readAt: s.readAt, ok: s.ok,
      pairs: entry?.pairs ?? 0, assets: entry?.assets.size ?? 0, best: entry?.best ?? null, settlement: most(entry?.paid),
    };
  });
  return out.sort(byKind);
}

const kindRank = (v: VenueRow): number => (v.kind === null ? 3 : KIND_ORDER[v.kind]);
const byKind = (a: VenueRow, b: VenueRow): number =>
  kindRank(a) - kindRank(b) || (b.oiUsd ?? -1) - (a.oiUsd ?? -1) || b.pairs - a.pairs || a.name.localeCompare(b.name);

export type VenueSortKey = 'kind' | 'venue' | 'markets' | 'oi' | 'volume' | 'pairs' | 'widest';

export interface VenueSort {
  key: VenueSortKey;
  dir: 1 | -1;
}

/** As the scan groups them: the desk's venues, the other DEXs, the exchanges. */
export const DEFAULT_VENUE_SORT: VenueSort = { key: 'kind', dir: 1 };

export const nextVenueSort = (sort: VenueSort, key: VenueSortKey): VenueSort =>
  sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: key === 'venue' || key === 'kind' ? 1 : -1 };

export function sortVenues(venues: readonly VenueRow[], sort: VenueSort): VenueRow[] {
  const value = (v: VenueRow): number | string | null => {
    switch (sort.key) {
      case 'kind': return kindRank(v);
      case 'venue': return v.name.toLowerCase();
      case 'markets': return v.ok ? v.markets : null;
      case 'oi': return v.oiUsd;
      case 'volume': return v.volume24hUsd;
      case 'pairs': return v.pairs;
      case 'widest': return v.best?.grossAprPct ?? null;
    }
  };
  return sortedBy(venues, value, sort.dir, byKind);
}

// ---------- the summary on top ----------

export interface ScanSummary {
  /** Venues the scan reads, and how many answered the last one; null before the first scan. */
  venues: number | null;
  answering: number | null;
  pairs: number;
  assets: number;
  open: number;
  /** Pairs the desk could enter now that pay the owner's minimum; null while the minimum is not known. */
  clearing: number | null;
}

export function scanSummary(scan: ScanStatus | null, rows: readonly PairRow[], minimum: number | null): ScanSummary {
  return {
    venues: scan?.venues ?? null,
    answering: scan ? Math.max(0, scan.venues - scan.failed.length) : null,
    pairs: rows.length,
    assets: new Set(rows.map((r) => r.w.symbol)).size,
    open: rows.filter((r) => r.open).length,
    clearing: minimum === null ? null : rows.filter((r) => isEnterable(r.w) && hasHistory(r.w) && r.w.netAprPct >= minimum).length,
  };
}

/**
 * The scan in one line, for the phone, where the readings beside the sentence have no room:
 * `4 of the 26 pairs open to the desk pay your 5% minimum.`
 */
export function scanLine(s: ScanSummary, minimum: number | null): string {
  const listed = `${s.pairs} ${s.pairs === 1 ? 'pair' : 'pairs'} listed on ${s.assets} ${s.assets === 1 ? 'asset' : 'assets'}`;
  if (s.open === 0) return `${listed}; none is open to the desk.`;
  if (minimum === null || s.clearing === null) return `${listed}; ${s.open} open to the desk.`;
  const min = `${Number(minimum.toFixed(1))}%`;
  if (s.open === 1) return `The one pair open to the desk pays ${s.clearing === 1 ? '' : 'less than '}your ${min} minimum.`;
  if (s.clearing === 0) return `None of the ${s.open} pairs open to the desk pays your ${min} minimum now.`;
  return `${s.clearing} of the ${s.open} pairs open to the desk ${s.clearing === 1 ? 'pays' : 'pay'} your ${min} minimum.`;
}

// ---------- what a spread pays ----------

export interface Payout {
  hour: number;
  eightHours: number;
  day: number;
  week: number;
  year: number;
}

/** What a rate a year pays on a pair with `legUsd` on each side, USD: funding is paid on one side's notional. */
export function payout(aprPct: number, legUsd: number): Payout {
  const year = (aprPct / 100) * legUsd;
  return { hour: year / HOURS_A_YEAR, eightHours: (year / HOURS_A_YEAR) * 8, day: year / 365, week: (year / 365) * 7, year };
}
