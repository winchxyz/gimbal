// Development only: the Windows screen's fake data, shaped exactly like the shared types. It feeds the fake
// stream (windows and scan events) and the fake `EngineApi` (strategy and 7-day history), so the screen reads
// the same seams it will read from the engine. The numbers follow design/screens/shared/data.js and are made up.
import type { ScanSource, ScanStatus, StrategyConfig, Window as FundingWindow, WindowHistory, WindowLeg } from '@gimbal/shared';
import type { EngineApi } from './api.ts';
import { requestFakeStress } from './fake-rescue.ts';
import { isEnterable } from '../windows/model.ts';

/**
 * What the fake shows, chosen with `?state=` in development:
 * - normal: the mockup's list, with a held, a risk-check-refused and a refused window and five watch-only ones.
 * - loading: no windows event is ever sent.
 * - empty: nothing open to the desk clears the minimum.
 * - error: three venues did not answer, and the windows that need them are stale.
 */
export type Scenario = 'normal' | 'loading' | 'empty' | 'error';

export const FAKE_STRATEGY: StrategyConfig = {
  auto: true,
  minNetAprPct: 5,
  legUsd: 1200,
  maxLeverage: 3,
  stopDrawdownPct: 10,
  rotate: { minGainPts: 3, forHours: 4 },
  risk: { watchDistancePct: 15, rescueDistancePct: 8 },
  enterAfterChecks: 3,
  exitAfterChecks: 6,
};
export const FAKE_FAILED_VENUES = ['phoenix', 'lighter', 'paradex'];

/** The venues the fake scanner reads, the desk's three first, with what a venue of that size answers. Made up. */
const SOURCES: readonly { id: string; kind: ScanSource['kind']; markets: number; oiM: number | null; volM: number | null }[] = [
  { id: 'hyperliquid', kind: 'desk', markets: 229, oiM: 9_140, volM: 7_310 },
  { id: 'phoenix', kind: 'desk', markets: 41, oiM: 62, volM: 118 },
  { id: 'orderly', kind: 'desk', markets: 106, oiM: 284, volM: 612 },
  { id: 'lighter', kind: 'dex', markets: 124, oiM: 1_720, volM: 4_980 },
  { id: 'extended', kind: 'dex', markets: 88, oiM: 196, volM: 540 },
  { id: 'aster', kind: 'dex', markets: 172, oiM: null, volM: 2_260 },
  { id: 'paradex', kind: 'dex', markets: 97, oiM: 415, volM: 730 },
  { id: 'gmx', kind: 'dex', markets: 74, oiM: 338, volM: 291 },
  { id: 'dydx', kind: 'dex', markets: 183, oiM: 251, volM: 402 },
  { id: 'pacifica', kind: 'dex', markets: 52, oiM: 71, volM: 164 },
  { id: 'binance', kind: 'cex', markets: 506, oiM: 28_400, volM: 61_200 },
  { id: 'bybit', kind: 'cex', markets: 548, oiM: 14_900, volM: 23_800 },
  { id: 'okx', kind: 'cex', markets: 291, oiM: 11_300, volM: 19_500 },
  { id: 'kraken', kind: 'cex', markets: 318, oiM: null, volM: 1_140 },
];
export const FAKE_VENUE_COUNT = SOURCES.length;

const HOUR = 3_600_000;
const HELD_FOR_MS = (2 * 24 + 14) * HOUR;
const STALE_FOR_MS = 62_000;
const MODEL = 'Qwen/Qwen3-VL-30B-A3B-Instruct';

export interface Spec {
  symbol: string;
  long: string;
  short: string;
  gross: number;
  gross7: number | null;               // null: the history is not loaded yet
  costs: readonly [fees: number, slippage: number, basis: number, reserve: number];
  depth: number;
  spark?: readonly number[];           // shape of the week, for the history
  watchOnly?: true;
  held?: true;
  veto?: readonly string[];
  refused?: { code: string; reason: string };
  note?: string;                       // NEAR AI's one line when it passes the window
  phase: number;                       // where the fake rate is in its swing
  px: number;                          // the coin's price, USD
}

const SPECS: readonly Spec[] = [
  { symbol: 'ZRO', long: 'hyperliquid', short: 'orderly', gross: 39.3, gross7: 31.0, costs: [1.7, 1.2, 0.5, 0.7], depth: 22_000, spark: [22, 25, 30, 28, 33, 31, 36, 34, 38, 37, 39.3], refused: { code: 'E_ORACLE_STALE', reason: 'no trusted price' }, phase: 3, px: 2.314 },
  { symbol: 'DOGE', long: 'phoenix', short: 'hyperliquid', gross: 18.4, gross7: 16.9, costs: [1.9, 0.9, 0.4, 1.4], depth: 41_000, spark: [12, 14, 13, 17, 15, 18, 16, 19, 17, 18, 18.4], held: true, note: 'Spread held for 13 straight weeks. Phoenix book is thin: keep each leg under $1,500.', phase: 0, px: 0.19861 },
  { symbol: 'AVAX', long: 'orderly', short: 'hyperliquid', gross: 12.1, gross7: 3.4, costs: [1.5, 0.5, 0.3, 0.7], depth: 264_000, spark: [1, 1, 2, 1, 1, 2, 1, 2, 1, 6, 12.1], veto: ['one-off spike', 'The 7-day median gap is 1.2%, so the window is likely to close before fees are earned back'], phase: 9, px: 28.41 },
  { symbol: 'SOL', long: 'phoenix', short: 'orderly', gross: 11.9, gross7: 10.2, costs: [1.6, 0.6, 0.3, 0.8], depth: 1_240_000, spark: [9, 10, 9, 11, 10, 10, 11, 12, 11, 12, 11.9], note: 'Deepest window on the list. Lower carry, lowest rescue risk.', phase: 5, px: 182.45 },
  { symbol: 'NEAR', long: 'phoenix', short: 'orderly', gross: 12.4, gross7: 11.1, costs: [1.8, 0.9, 0.4, 1.3], depth: 182_000, spark: [8, 9, 10, 9, 11, 12, 11, 12, 13, 12, 12.4], note: 'Both books deep enough for the cap. Funding timing matches within the hour.', phase: 11, px: 2.842 },
  { symbol: 'LTC', long: 'phoenix', short: 'hyperliquid', gross: 10.6, gross7: 9.8, costs: [1.7, 0.8, 0.4, 0.8], depth: 58_000, spark: [9, 9, 10, 10, 9, 10, 11, 10, 10, 11, 10.6], note: 'Steady for 9 weeks. Next in line if DOGE compresses.', phase: 7, px: 91.27 },
  { symbol: 'BTC', long: 'phoenix', short: 'hyperliquid', gross: 6.0, gross7: 5.2, costs: [1.6, 0.5, 0.3, 1.5], depth: 3_800_000, spark: [5, 5, 6, 5, 4, 5, 6, 5, 5, 6, 6.0], note: 'Safe but below your 5% rule after costs.', phase: 2, px: 104210 },
  { symbol: 'ETH', long: 'hyperliquid', short: 'phoenix', gross: 1.6, gross7: 1.9, costs: [1.6, 0.4, 0.3, 1.7], depth: 2_900_000, spark: [2, 2, 1, 2, 2, 1, 2, 2, 1, 2, 1.6], note: 'Costs exceed the gap.', phase: 13, px: 3412.6 },
  { symbol: 'XMR', long: 'lighter', short: 'hyperliquid', gross: 55.1, gross7: 48.7, costs: [0, 0, 0, 0], depth: 96_000, watchOnly: true, phase: 4, px: 312.8 },
  { symbol: 'NEAR', long: 'extended', short: 'hyperliquid', gross: 33.4, gross7: 29.0, costs: [0, 0, 0, 0], depth: 140_000, watchOnly: true, phase: 8, px: 2.842 },
  { symbol: 'WIF', long: 'aster', short: 'binance', gross: 27.8, gross7: 18.2, costs: [0, 0, 0, 0], depth: 410_000, watchOnly: true, phase: 1, px: 0.6142 },
  { symbol: 'TIA', long: 'paradex', short: 'bybit', gross: 21.5, gross7: 19.9, costs: [0, 0, 0, 0], depth: 230_000, watchOnly: true, phase: 6, px: 1.183 },
  { symbol: 'SUI', long: 'gmx', short: 'dydx', gross: 17.2, gross7: null, costs: [0, 0, 0, 0], depth: 75_000, watchOnly: true, phase: 10, px: 2.957 },
];

/** In the empty scenario nothing open to the desk clears the minimum: the held window and the three above it are gone. */
const GONE_WHEN_EMPTY = new Set(['DOGE', 'SOL', 'NEAR', 'LTC']);
const specsFor = (scenario: Scenario): Spec[] =>
  SPECS.filter((s) => scenario !== 'empty' || s.watchOnly || !GONE_WHEN_EMPTY.has(s.symbol));

export const specId = (s: Spec): string => `${s.symbol}-${s.long}-${s.short}`.toLowerCase();

export interface WindowsOptions {
  scenario: Scenario;
  /** When the fake started: the held window and the stale rows are dated from here. */
  startedAt: number;
  /** A slow swing in every rate, so rows re-sort now and then; off for a still picture. */
  drift: boolean;
}

/**
 * The fake windows in the engine's order (engine/src/scanner/scanner.ts, step 6): the enterable ones, then the other
 * desk windows, each by net APR (the engine ranks them by expected carry, which follows the same multi-day spread),
 * then watch-only by gross.
 */
export function fakeWindows(now: number, tick: number, options: WindowsOptions): FundingWindow[] {
  const group = (w: FundingWindow) => (isEnterable(w) ? 0 : w.tradable ? 1 : 2);
  const rank = (w: FundingWindow) => (w.tradable ? w.netAprPct : w.grossAprPct);
  return unordered(now, tick, options).sort((a, b) => group(a) - group(b) || rank(b) - rank(a) || a.id.localeCompare(b.id));
}

function unordered(now: number, tick: number, options: WindowsOptions): FundingWindow[] {
  return specsFor(options.scenario).map((spec): FundingWindow => {
    const stale = options.scenario === 'error' && (FAKE_FAILED_VENUES.includes(spec.long) || FAKE_FAILED_VENUES.includes(spec.short));
    const swing = options.drift && !stale ? 1.2 * Math.sin((tick + spec.phase) / 9) : 0;
    const [feesPct, slippagePct, basisPct, rescueReservePct] = spec.costs;
    const costSum = feesPct + slippagePct + basisPct + rescueReservePct;
    const grossAprPct = round(spec.gross + swing, 1);
    const netAprPct = round(grossAprPct - costSum, 1);
    const held = spec.held && options.scenario !== 'empty' ? { since: options.startedAt - HELD_FOR_MS } : null;
    const heldExists = specsFor(options.scenario).some((s) => s.held);
    const tradable = !spec.watchOnly;

    return {
      id: specId(spec),
      symbol: spec.symbol,
      longVenue: spec.long,
      shortVenue: spec.short,
      grossAprPct,
      grossApr7dPct: spec.gross7,
      costs: { feesPct, slippagePct, basisPct, rescueReservePct },
      netAprPct,
      usdPerDayPer1k: (netAprPct / 100 / 365) * 1000,
      breakevenHours: tradable ? Math.round(costSum * 5) : 0,
      depthUsd: spec.depth,
      intervalsAbove: tradable ? Math.max(1, Math.round(netAprPct)) : 0,
      updatedAt: stale ? options.startedAt - STALE_FOR_MS : now,
      tradable,
      ...(spec.veto ? { veto: { verdict: 'veto' as const, reasons: [...spec.veto], model: MODEL, at: now } } : {}),
      ...(!spec.veto && spec.note ? { veto: { verdict: 'pass' as const, reasons: [spec.note], model: MODEL, at: now } } : {}),
      ...(spec.refused ? { refused: spec.refused } : {}),
      held,
      checks: tradable ? checksOf(spec) : [],
      switchCostUsd: tradable && heldExists && !held ? 1.1 : null,
      stale,
      legs: legsOf(spec, grossAprPct, stale ? options.startedAt - STALE_FOR_MS : now),
    };
  });
}

function checksOf(spec: Spec): FundingWindow['checks'] {
  return [
    { ok: true, text: `Passes your policy: ${spec.symbol} allowed, leg under $1,500, 2.5× under 3×` },
    spec.refused
      ? { ok: false, text: `No trusted oracle price for ${spec.symbol}. Unpriced assets need your opt-in` }
      : { ok: true, text: 'Oracle price 9 s old, inside the 100 bp band' },
    { ok: true, text: 'Both venues can be rescued in under a minute' },
  ];
}

/** How each fake venue pays funding, as the engine's readers report it (CLAUDE.md, venue facts). */
const SETTLEMENT: Readonly<Record<string, WindowLeg['settlement']>> = {
  hyperliquid: 'hourly', phoenix: 'daily', orderly: '8h', lighter: 'hourly', extended: 'hourly', aster: '4h', paradex: 'continuous', gmx: 'continuous',
  dydx: 'hourly', binance: '8h', bybit: '8h',
};
const PERIOD_MS: Readonly<Record<WindowLeg['settlement'], number>> = { hourly: HOUR, '2h': 2 * HOUR, '4h': 4 * HOUR, '8h': 8 * HOUR, daily: 24 * HOUR, continuous: 0 };
const TRADED = ['hyperliquid', 'phoenix', 'orderly'];

/** The venue's own name for a market, as each one spells it. */
function venueSymbol(venue: string, symbol: string): string {
  if (venue === 'orderly') return `PERP_${symbol}_USDC`;
  if (venue === 'binance' || venue === 'bybit' || venue === 'aster') return `${symbol}USDT`;
  if (venue === 'paradex' || venue === 'dydx') return `${symbol}-USD`;
  return symbol;
}

/**
 * Both sides of a fake window, as the scanner would have read them: the short's rate less the long's is the window's
 * gross, the marks sit a few basis points apart, the thinner side's open interest is the window's depth.
 */
function legsOf(spec: Spec, grossAprPct: number, readAt: number): NonNullable<FundingWindow['legs']> {
  const rnd = seeded(`legs:${specId(spec)}`);
  const longAprPct = round(-4 + rnd() * 9, 2);
  const perHour = (aprPct: number): number => aprPct / 100 / 8760;
  const gapPct = (rnd() - 0.4) * 0.12;
  const thinLong = rnd() < 0.6;
  const side = (venue: string, aprPct: number, long: boolean): WindowLeg => {
    const settlement = SETTLEMENT[venue] ?? 'hourly';
    const period = PERIOD_MS[settlement];
    const thin = long === thinLong;
    const oiUsd = venue === 'aster' ? null : Math.round(spec.depth * (thin ? 1 : 3 + rnd() * 20));
    const week = spec.gross7 === null || !TRADED.includes(venue) ? null : round(long ? longAprPct * 0.9 : longAprPct * 0.9 + spec.gross7, 2);
    return {
      symbol: venueSymbol(venue, spec.symbol),
      ratePerHour: perHour(aprPct),
      apr7dPct: week,
      settlement,
      nextAt: period === 0 ? readAt : (Math.floor(readAt / period) + 1) * period,
      markPx: venue === 'kraken' ? null : Number((spec.px * (1 + (long ? 0 : gapPct / 100))).toPrecision(6)),
      oiUsd,
      volume24hUsd: venue === 'gmx' ? null : Math.round((oiUsd ?? spec.depth) * (0.8 + rnd() * 4)),
      move24hPct: venue === 'paradex' ? null : round((rnd() - 0.5) * 9, 2),
      readAt,
    };
  };
  return { long: side(spec.long, longAprPct, true), short: side(spec.short, round(longAprPct + grossAprPct, 2), false) };
}

export function fakeScan(now: number, scenario: Scenario): ScanStatus {
  const failed = scenario === 'error' ? [...FAKE_FAILED_VENUES] : [];
  const sources = SOURCES.map((s): ScanSource => {
    const ok = !failed.includes(s.id);
    return {
      id: s.id, kind: s.kind, markets: s.markets,
      oiUsd: s.oiM === null ? null : s.oiM * 1e6, volume24hUsd: s.volM === null ? null : s.volM * 1e6,
      readAt: ok ? now - (s.kind === 'desk' ? 0 : 12_000) : now - STALE_FOR_MS, ok,
    };
  });
  return { venues: FAKE_VENUE_COUNT, failed, at: now, sources };
}

/**
 * Hourly net APR for the last 7 days: the shape of the week from the spec, a slow ripple and a little noise,
 * deterministic per window so a refetch draws the same line. The last point is the window's net APR at tick 0.
 */
export function fakeHistory(spec: Spec, now: number): WindowHistory {
  const costSum = spec.costs.reduce((sum, c) => sum + c, 0);
  const shape = spec.spark ?? [spec.gross, spec.gross];
  const jitter = spec.held ? 1.6 : 1.2;
  const rnd = seeded(specId(spec));
  const hour = Math.floor(now / HOUR) * HOUR;
  const points = Array.from({ length: 168 }, (_, i) => {
    const at = (i / 167) * (shape.length - 1);
    const a = Math.floor(at);
    const b = Math.min(a + 1, shape.length - 1);
    const e = at - a;
    const ease = e * e * (3 - 2 * e);
    const from = shape[a] ?? 0;
    const to = shape[b] ?? 0;
    const net = from + (to - from) * ease - costSum + Math.sin(i / 3.1) * jitter * 0.35 + (rnd() - 0.5) * jitter * 0.3;
    return { t: hour - (167 - i) * HOUR, netAprPct: round(net, 2) };
  });
  points[167] = { t: hour, netAprPct: round(spec.gross - costSum, 1) };
  return { windowId: specId(spec), points };
}

/**
 * The fake engine API: the same reads the real engine serves. The journal comes from fake-journal.ts, passed in by
 * start.ts, and it is all there at once, so there is never an older page. The manual overrides say yes: the fake
 * changes nothing, and the real refusals are seen against the engine.
 */
export function fakeApi(journal: EngineApi['journal'] = async () => []): EngineApi {
  return {
    journal,
    journalBefore: async () => [],
    rotate: async () => ({ ok: true }),
    close: async () => ({ ok: true }),
    // The fake stream starts a run of its own when asked (fake-rescue.ts).
    stress: async () => {
      requestFakeStress();
      return { ok: true };
    },
    strategy: async () => ({ ...FAKE_STRATEGY }),
    windowHistory: async (id) => {
      const spec = SPECS.find((s) => specId(s) === id);
      if (!spec || spec.watchOnly) throw new Error(`GET /windows/history: no history for ${id}`);
      return fakeHistory(spec, Date.now());
    },
  };
}

// mulberry32 over an FNV-1a hash of the id
function seeded(text: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
