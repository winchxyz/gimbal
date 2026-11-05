// Builders for the strategy loop's tests: windows, a strategy, a DecideInput, a run of hourly checks, and the veto
// facts the recorded NEAR AI exchanges answer (fixtures/nearai/SYNTHETIC-veto.json). Not used outside tests.

import type { StrategyConfig, Window as FundingWindow } from '@gimbal/shared';
import { fileURLToPath } from 'node:url';
import { NO_COUNTERS, decide } from './decide.ts';
import type { DecideInput, Decision, HeldPair, LoopCounters } from './decide.ts';
import type { VetoFacts, VetoSource } from './veto.ts';

/**
 * A NEAR AI risk check that answers a readable pass with no reasons, for tests whose subject is not the check: the
 * check fails closed, so without a source (no key) every enter and rotate would be held.
 */
export const PASSING_RISK_CHECK: VetoSource = {
  model: 'test-model', configured: true,
  complete: async () => ({ content: '{"verdict":"pass","reasons":[]}', raw: { choices: [{ message: { content: '{"verdict":"pass","reasons":[]}' } }] } }),
};
/** The why line PASSING_RISK_CHECK gives when no attestation was fetched. */
export const PASSED_WHY = 'NEAR AI risk check passed (TEE not attested: no attestation fetched in this run): no red flag named';

export const T0 = Date.UTC(2026, 10, 3, 12);
export const HOUR = 3_600_000;

export const VETO_FIXTURE = fileURLToPath(new URL('../../fixtures/nearai/SYNTHETIC-veto.json', import.meta.url));

/** The mainnet desk's rules: about 12 USD a leg under a 20 USD cap, 10 % minimum. */
export const STRATEGY: StrategyConfig = {
  auto: true,
  minNetAprPct: 10,
  legUsd: 12,
  maxLeverage: 2,
  stopDrawdownPct: 10,
  rotate: { minGainPts: 3, forHours: 4 },
  risk: { watchDistancePct: 15, rescueDistancePct: 8 },
  enterAfterChecks: 3,
  exitAfterChecks: 6,
};

/** A desk window `<symbol>-<long venue>-<short venue>` that passes every entry rule unless `f` says otherwise. */
export function win(id: string, f: Partial<FundingWindow> = {}): FundingWindow {
  const [symbol, longVenue, shortVenue] = id.split('-') as [string, string, string];
  return {
    id, symbol: symbol.toUpperCase(), longVenue, shortVenue,
    grossAprPct: 20, grossApr7dPct: 18,
    costs: { feesPct: 2, slippagePct: 0.5, basisPct: 0.5, rescueReservePct: 0 },
    netAprPct: 15, usdPerDayPer1k: 0.41, breakevenHours: 40, depthUsd: 1_000_000, intervalsAbove: 6,
    updatedAt: T0, tradable: true, held: null, checks: [{ ok: true, text: 'every check passed' }],
    switchCostUsd: null, stale: false,
    ...f,
  };
}

/** Lots of 0.01 on both legs at a price of 1 USD, for any window id: whole lots never cut a size in cents. */
export const ANY_LOTS: NonNullable<DecideInput['lots']> = new Proxy({}, {
  get: (_, key) => (typeof key === 'string' ? { longLot: 0.01, shortLot: 0.01, px: 1 } : undefined),
});

export function input(f: Partial<DecideInput> = {}): DecideInput {
  return {
    now: T0, hourly: true, windows: [], held: null, strategy: STRATEGY, maxNotionalUsd: 20,
    freeMarginUsd: { hyperliquid: 50, phoenix: 50, orderly: 50 },
    liveRescue: { hyperliquid: true, phoenix: false, orderly: false },
    counters: NO_COUNTERS, priceBandBps: 100, lots: ANY_LOTS,
    ...f,
  };
}

export function held(windowId: string, f: Partial<HeldPair> = {}): HeldPair {
  return { windowId, symbol: windowId.split('-')[0]!.toUpperCase(), since: T0, legUsd: 12, entryNetAprPct: 15, pnlUsd: 0, ...f };
}

/**
 * Hourly checks from `base.now`, one an hour, each with the windows `windowsAt(h)` gives; the counters carry over.
 * Returns every decision. `heldAt` gives the held pair at hour h (default base.held throughout).
 */
export function hours(
  base: DecideInput, n: number, windowsAt: (h: number) => readonly FundingWindow[], heldAt?: (h: number) => HeldPair | null,
): Decision[] {
  const out: Decision[] = [];
  let counters: LoopCounters = base.counters;
  for (let h = 0; h < n; h++) {
    const d = decide({ ...base, now: base.now + h * HOUR, windows: windowsAt(h), held: heldAt === undefined ? base.held : heldAt(h), counters });
    out.push(d);
    counters = d.counters;
  }
  return out;
}

/** The facts the fixture's passing exchange answers: a steady NEAR spread. */
export const PASS_FACTS: VetoFacts = {
  kind: 'enter', symbol: 'NEAR', longVenue: 'hyperliquid', shortVenue: 'phoenix',
  grossAprPct: 25.81, grossApr7dPct: 19.08, grossApr14dPct: 17.4, netAprPct: 9, minNetAprPct: 5, hoursAbove: 3,
  legUsd: 12, leverage: 1.5,
  legs: [
    { venue: 'hyperliquid', side: 'long', openInterestUsd: 27_400_000, bookDepthUsd: 41_000, fillImpactBps: 1.2, priceMove24hPct: -2.1, daysSinceListing: null },
    { venue: 'phoenix', side: 'short', openInterestUsd: 1_583_197, bookDepthUsd: 6_200, fillImpactBps: 4.8, priceMove24hPct: -2.1, daysSinceListing: null },
  ],
};

/** The facts the fixture's veto answers: a one-hour spike on a market listed five days ago. */
export const VETO_FACTS: VetoFacts = {
  kind: 'enter', symbol: 'MEME', longVenue: 'phoenix', shortVenue: 'hyperliquid',
  grossAprPct: 310, grossApr7dPct: 22, grossApr14dPct: null, netAprPct: 18, minNetAprPct: 5, hoursAbove: 3,
  legUsd: 12, leverage: 1.5,
  legs: [
    { venue: 'phoenix', side: 'long', openInterestUsd: 1_200, bookDepthUsd: 300, fillImpactBps: 180, priceMove24hPct: 38.5, daysSinceListing: 5 },
    { venue: 'hyperliquid', side: 'short', openInterestUsd: 2_100_000, bookDepthUsd: 9_000, fillImpactBps: 2.5, priceMove24hPct: 38.5, daysSinceListing: null },
  ],
};
