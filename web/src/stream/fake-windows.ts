// Development only: the Windows screen's fake data, shaped exactly like the shared types. It feeds the fake
// stream (windows and scan events) and the fake `EngineApi` (strategy and 7-day history), so the screen reads
// the same seams it will read from the engine. The numbers follow design/screens/shared/data.js and are made up.
import type { ScanStatus, StrategyConfig, Window as FundingWindow, WindowHistory } from '@gimbal/shared';
import type { EngineApi } from './api.ts';

/**
 * What the fake shows, chosen with `?state=` in development:
 * - normal: the mockup's list, with a held, a vetoed and a refused window and five watch-only ones.
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
};
export const FAKE_VENUE_COUNT = 32;
export const FAKE_FAILED_VENUES = ['phoenix', 'lighter', 'paradex'];

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
}

const SPECS: readonly Spec[] = [
  { symbol: 'ZRO', long: 'hyperliquid', short: 'orderly', gross: 39.3, gross7: 31.0, costs: [1.7, 1.2, 0.5, 0.7], depth: 22_000, spark: [22, 25, 30, 28, 33, 31, 36, 34, 38, 37, 39.3], refused: { code: 'E_ORACLE_STALE', reason: 'no trusted price' }, phase: 3 },
  { symbol: 'DOGE', long: 'phoenix', short: 'hyperliquid', gross: 18.4, gross7: 16.9, costs: [1.9, 0.9, 0.4, 1.4], depth: 41_000, spark: [12, 14, 13, 17, 15, 18, 16, 19, 17, 18, 18.4], held: true, note: 'Spread held for 13 straight weeks. Phoenix book is thin: keep each leg under $1,500.', phase: 0 },
  { symbol: 'AVAX', long: 'orderly', short: 'hyperliquid', gross: 12.1, gross7: 3.4, costs: [1.5, 0.5, 0.3, 0.7], depth: 264_000, spark: [1, 1, 2, 1, 1, 2, 1, 2, 1, 6, 12.1], veto: ['one-off spike', 'The 7-day median gap is 1.2%, so the window is likely to close before fees are earned back'], phase: 9 },
  { symbol: 'SOL', long: 'phoenix', short: 'orderly', gross: 11.9, gross7: 10.2, costs: [1.6, 0.6, 0.3, 0.8], depth: 1_240_000, spark: [9, 10, 9, 11, 10, 10, 11, 12, 11, 12, 11.9], note: 'Deepest window on the list. Lower carry, lowest rescue risk.', phase: 5 },
  { symbol: 'NEAR', long: 'phoenix', short: 'orderly', gross: 12.4, gross7: 11.1, costs: [1.8, 0.9, 0.4, 1.3], depth: 182_000, spark: [8, 9, 10, 9, 11, 12, 11, 12, 13, 12, 12.4], note: 'Both books deep enough for the cap. Funding timing matches within the hour.', phase: 11 },
  { symbol: 'LTC', long: 'phoenix', short: 'hyperliquid', gross: 10.6, gross7: 9.8, costs: [1.7, 0.8, 0.4, 0.8], depth: 58_000, spark: [9, 9, 10, 10, 9, 10, 11, 10, 10, 11, 10.6], note: 'Steady for 9 weeks. Next in line if DOGE compresses.', phase: 7 },
  { symbol: 'BTC', long: 'phoenix', short: 'hyperliquid', gross: 6.0, gross7: 5.2, costs: [1.6, 0.5, 0.3, 1.5], depth: 3_800_000, spark: [5, 5, 6, 5, 4, 5, 6, 5, 5, 6, 6.0], note: 'Safe but below your 5% rule after costs.', phase: 2 },
  { symbol: 'ETH', long: 'hyperliquid', short: 'phoenix', gross: 1.6, gross7: 1.9, costs: [1.6, 0.4, 0.3, 1.7], depth: 2_900_000, spark: [2, 2, 1, 2, 2, 1, 2, 2, 1, 2, 1.6], note: 'Costs exceed the gap.', phase: 13 },
  { symbol: 'XMR', long: 'lighter', short: 'hyperliquid', gross: 55.1, gross7: 48.7, costs: [0, 0, 0, 0], depth: 96_000, watchOnly: true, phase: 4 },
  { symbol: 'NEAR', long: 'extended', short: 'hyperliquid', gross: 33.4, gross7: 29.0, costs: [0, 0, 0, 0], depth: 140_000, watchOnly: true, phase: 8 },
  { symbol: 'WIF', long: 'aster', short: 'binance', gross: 27.8, gross7: 18.2, costs: [0, 0, 0, 0], depth: 410_000, watchOnly: true, phase: 1 },
  { symbol: 'TIA', long: 'paradex', short: 'bybit', gross: 21.5, gross7: 19.9, costs: [0, 0, 0, 0], depth: 230_000, watchOnly: true, phase: 6 },
  { symbol: 'SUI', long: 'gmx', short: 'dydx', gross: 17.2, gross7: null, costs: [0, 0, 0, 0], depth: 75_000, watchOnly: true, phase: 10 },
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

export function fakeWindows(now: number, tick: number, options: WindowsOptions): FundingWindow[] {
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

export function fakeScan(now: number, scenario: Scenario): ScanStatus {
  return { venues: FAKE_VENUE_COUNT, failed: scenario === 'error' ? [...FAKE_FAILED_VENUES] : [], at: now };
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

/** The fake engine API: the same two reads the real engine serves. */
export function fakeApi(): EngineApi {
  return {
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
