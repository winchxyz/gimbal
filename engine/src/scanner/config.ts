// The scanner's settings and their defaults. Every number here is either measured (with the date it was measured)
// or a stated assumption the owner can change; the strategy defaults are the engine rules a new desk starts with.

import type { ContractPolicy, StrategyConfig, VenueId } from '@gimbal/shared';
import type { FillFee, Place, TransferCosts } from './costs.ts';

export interface CostParams {
  /** Hours a window is expected to be held: one-off costs (fills, slippage, basis, rescues) are spread over it. */
  holdHours: number;
  /** Cost of one taker fill per desk venue. */
  fees: Record<VenueId, FillFee>;
  transfers: TransferCosts;
  /** Rescues expected per hold; each moves rescueAmountUsd from the reserve into the squeezed leg's venue. */
  rescuesPerHold: number;
  /** Where the rescue reserve sits. */
  reserveAt: Place;
}

export interface ScannerConfig {
  costs: CostParams;
  /** A leg whose open interest is under this many USD is not ranked; the smaller leg's open interest is the capacity. */
  oiFloorUsd: number;
  /** A leg whose mark (÷ multiplier) is further than this fraction from the median of the same base elsewhere is dropped. */
  maxMarkDeviation: number;
  /** Watch-only windows are many; at most this many (best gross first) are sent. Desk windows are never cut. */
  maxWatchWindows: number;
  /** The contract's policy for the desk, as get_desk returns it; null until a desk exists (nothing can be entered). */
  policy: ContractPolicy | null;
  /** Base symbols the contract can price through its oracle (an asset without one is tradable only via policy.unpriced). */
  oracleSymbols: readonly string[];
  intervalMs: number;
  /** A desk venue's book is read again once it is this old. */
  bookTtlMs: number;
  bookDepth: number;
  /** A watch-only venue's funding is read again once its last answer is this old (desk venues: every scan). */
  watchIntervalMs: number;
  /** A funding read that takes longer than this counts as "did not answer" for this scan. */
  readTimeoutMs: number;
  /** The same for a book: longer, because Orderly's first book also opens its public WebSocket. */
  bookTimeoutMs: number;
  /** A venue that has not answered for this long drops out: its last good read is too old to show. */
  dropAfterMs: number;
  /** Public funding-history reads per scan (7-day gross APR and window history); each is one market. */
  historyPerScan: number;
  /** A failed history read waits this long before it is tried again. */
  historyRetryMs: number;
}

/**
 * Assets OutLayer's price-oracle.near lists in get_assets (checked on mainnet 2026-10-22), as base symbols: BTC (nBTC,
 * WBTC), ETH, SOL, NEAR, ZEC, and DOGE, XRP, ADA, XLM, LTC, whose reports were still empty then. Stablecoins and
 * NEAR-only tokens (REF, AURORA) have no perp. Replace with the contract's own list once the contract client exists.
 */
export const DEFAULT_ORACLE_SYMBOLS: readonly string[] = ['BTC', 'ETH', 'SOL', 'NEAR', 'ZEC', 'DOGE', 'XRP', 'ADA', 'XLM', 'LTC'];

export const DEFAULT_COSTS: CostParams = {
  holdHours: 168,
  fees: {
    // Hyperliquid tier-0 taker 4.5 bps, plus the treasury builder fee on every order (FeeConfig.hl_builder_tenth_bps
    // 10 = 1 bp). The referral discount is not counted.
    hyperliquid: { takerBps: 4.5, extraBps: 1 },
    // Phoenix: 3.5 bps taker on every market (its market config, 2026-10-31).
    phoenix: { takerBps: 3.5, extraBps: 0 },
    // Orderly: 3 bps base taker plus the broker's markup; 1.5 bps is an assumption until the desk's broker is fixed.
    orderly: { takerBps: 3, extraBps: 1.5 },
  },
  transfers: {
    // Measured on mainnet 2026-10-27: Phoenix -> Hyperliquid 0.32 USD on 4 USD; Hyperliquid -> 1Click 0.21 USD. From
    // Arbitrum (Orderly) nothing is measured yet: the Solana figure stands in.
    oneClickFlatUsd: { solana: 0.32, hypercore: 0.21, arbitrum: 0.32 },
    oneClickBps: 20,             // no 1Click API key: +0.2 %
    hlActivationUsd: 1,
    orderlyWithdrawUsd: 1,
    orderlyMinDepositUsd: 6,
  },
  rescuesPerHold: 1,
  reserveAt: 'reserve',
};

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  costs: DEFAULT_COSTS,
  oiFloorUsd: 500_000,
  maxMarkDeviation: 0.1,
  maxWatchWindows: 150,
  policy: null,
  oracleSymbols: DEFAULT_ORACLE_SYMBOLS,
  intervalMs: 5_000,
  bookTtlMs: 30_000,
  bookDepth: 20,
  // Variational answered HTTP 429 to a 5 s poll on 2026-10-31.
  watchIntervalMs: 30_000,
  readTimeoutMs: 4_000,
  bookTimeoutMs: 8_000,
  dropAfterMs: 10 * 60_000,
  historyPerScan: 4,
  historyRetryMs: 60_000,
};

/** The engine rules a desk starts with. auto is off: the engine only watches until the owner turns it on. */
export const DEFAULT_STRATEGY: StrategyConfig = {
  auto: false,
  minNetAprPct: 5,
  legUsd: 1000,
  maxLeverage: 3,
  stopDrawdownPct: 10,
  rotate: { minGainPts: 3, forHours: 4 },
  risk: { watchDistancePct: 15, rescueDistancePct: 8 },
};

/**
 * Bounds PUT /strategy enforces on top of the policy. They are the engine's own sanity limits, not the contract's:
 * the contract caps every order at policy.max_notional_usd whatever the engine is told.
 */
export const STRATEGY_LIMITS = {
  maxLegUsd: 100_000,
  maxLeverage: 10,
  maxMinNetAprPct: 1_000,
  maxRotateGainPts: 1_000,
  maxRotateHours: 24 * 30,
} as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const between = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi;

/**
 * Checks a StrategyConfig from PUT /strategy and returns a clean copy, or throws with the first thing wrong.
 * Unknown fields are refused, so a misspelt rule is never silently ignored; every number must be finite and inside
 * STRATEGY_LIMITS (and legUsd inside the policy's cap when one is loaded).
 */
export function parseStrategyConfig(value: unknown, policy: ContractPolicy | null = null): StrategyConfig {
  if (!isObject(value)) throw new Error('strategy: not an object');
  const known = ['auto', 'minNetAprPct', 'legUsd', 'maxLeverage', 'stopDrawdownPct', 'rotate', 'risk'];
  const extra = Object.keys(value).filter((k) => !known.includes(k));
  if (extra.length > 0) throw new Error(`strategy: unknown field ${extra[0]}`);
  const { auto, minNetAprPct, legUsd, maxLeverage, stopDrawdownPct, rotate, risk } = value;
  const L = STRATEGY_LIMITS;
  if (typeof auto !== 'boolean') throw new Error('strategy: auto must be a boolean');
  if (!between(minNetAprPct, 0, L.maxMinNetAprPct)) throw new Error(`strategy: minNetAprPct must be a number from 0 to ${L.maxMinNetAprPct}`);
  if (!isNum(legUsd) || !(legUsd > 0) || legUsd > L.maxLegUsd) throw new Error(`strategy: legUsd must be a number > 0 and <= ${L.maxLegUsd}`);
  if (policy !== null && legUsd > policy.max_notional_usd) {
    throw new Error(`strategy: legUsd ${legUsd} is over the policy cap of ${policy.max_notional_usd} USD per leg`);
  }
  if (!between(maxLeverage, 1, L.maxLeverage)) throw new Error(`strategy: maxLeverage must be a number from 1 to ${L.maxLeverage}`);
  if (stopDrawdownPct !== null && (!isNum(stopDrawdownPct) || !(stopDrawdownPct > 0 && stopDrawdownPct <= 100))) {
    throw new Error('strategy: stopDrawdownPct must be null or a percentage in (0, 100]');
  }
  if (!isObject(rotate) || !between(rotate.minGainPts, 0, L.maxRotateGainPts) || !between(rotate.forHours, 0, L.maxRotateHours)) {
    throw new Error(`strategy: rotate needs minGainPts from 0 to ${L.maxRotateGainPts} and forHours from 0 to ${L.maxRotateHours}`);
  }
  const extraRotate = Object.keys(rotate).filter((k) => k !== 'minGainPts' && k !== 'forHours');
  if (extraRotate.length > 0) throw new Error(`strategy: unknown field rotate.${extraRotate[0]}`);
  if (!isObject(risk) || !isNum(risk.watchDistancePct) || !isNum(risk.rescueDistancePct)) {
    throw new Error('strategy: risk needs watchDistancePct and rescueDistancePct');
  }
  const extraRisk = Object.keys(risk).filter((k) => k !== 'watchDistancePct' && k !== 'rescueDistancePct');
  if (extraRisk.length > 0) throw new Error(`strategy: unknown field risk.${extraRisk[0]}`);
  if (!(risk.rescueDistancePct > 0 && risk.rescueDistancePct < risk.watchDistancePct && risk.watchDistancePct < 100)) {
    throw new Error('strategy: risk needs 0 < rescueDistancePct < watchDistancePct < 100');
  }
  return {
    auto, minNetAprPct, legUsd, maxLeverage, stopDrawdownPct,
    rotate: { minGainPts: rotate.minGainPts, forHours: rotate.forHours },
    risk: { watchDistancePct: risk.watchDistancePct, rescueDistancePct: risk.rescueDistancePct },
  };
}
