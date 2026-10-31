// Builders for the unit tests: a plausible Window with only the fields a test cares about changed.
import type { StrategyConfig, Window as FundingWindow } from '@gimbal/shared';

export function win(overrides: Partial<FundingWindow> & { symbol?: string } = {}): FundingWindow {
  const symbol = overrides.symbol ?? 'SOL';
  return {
    id: `${symbol.toLowerCase()}-phoenix-orderly`,
    symbol,
    longVenue: 'phoenix',
    shortVenue: 'orderly',
    grossAprPct: 11.9,
    grossApr7dPct: 10.2,
    costs: { feesPct: 1.6, slippagePct: 0.6, basisPct: 0.3, rescueReservePct: 0.8 },
    netAprPct: 8.6,
    usdPerDayPer1k: 0.24,
    breakevenHours: 17,
    depthUsd: 1_240_000,
    intervalsAbove: 9,
    updatedAt: 1_000_000,
    tradable: true,
    held: null,
    checks: [],
    switchCostUsd: null,
    stale: false,
    ...overrides,
  };
}

/** A tradable window with a given net APR (gross = net + 3.3 of costs). */
export const net = (symbol: string, netAprPct: number, overrides: Partial<FundingWindow> = {}): FundingWindow =>
  win({ symbol, netAprPct, grossAprPct: Math.round((netAprPct + 3.3) * 10) / 10, ...overrides });

export const STRATEGY: StrategyConfig = {
  auto: true,
  minNetAprPct: 5,
  legUsd: 1200,
  maxLeverage: 3,
  stopDrawdownPct: 10,
  rotate: { minGainPts: 3, forHours: 4 },
  risk: { watchDistancePct: 15, rescueDistancePct: 8 },
};
