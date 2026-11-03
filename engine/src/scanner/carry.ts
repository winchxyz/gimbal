// What a desk window is expected to earn over the planned hold, set against what entering and leaving it costs.
// The current hour's rate says little about a hold of days: funding flips sign hour to hour on quiet markets, so a
// desk window is listed in the direction its multi-day spread pays, and ranked and gated on that spread over the
// hold minus the round trip. Pure: the averages and costs come in as arguments.
//
// Units: APR in percentage points a year on one leg's notional (as costs.ts); money in USD at `legUsd` a leg.

import type { Window as FundingWindow } from '@gimbal/shared';
import { HOURS_PER_YEAR } from './costs.ts';
import { usd } from './price.ts';

/** What one round trip of a desk window costs, USD at `legUsd`: everything paid once whatever the hold. */
export interface RoundTrip {
  feesUsd: number;               // taker fees on the 4 fills (open and close, both legs)
  slippageUsd: number;           // the 4 fills walked through today's books at the leg size
  basisBufferUsd: number;        // the adverse mark gap at entry, funding lost to payment schedules, and the exit buffer
  totalUsd: number;
  bps: number;                   // totalUsd as bps of one leg
}

/**
 * The round trip: fees + slippage + a basis buffer of (adverse gap at entry + timing loss + bufferBps of the leg).
 * 20 USD a leg, fees 0.036, slippage 0.004, no gap, 5 bps buffer: 0.036 + 0.004 + 0.01 = 0.05 USD = 25 bps.
 */
export function roundTrip(legUsd: number, feesUsd: number, slippageUsd: number, basisUsd: number, timingUsd: number, bufferBps: number): RoundTrip {
  if (!(legUsd > 0)) throw new RangeError(`legUsd must be > 0, got ${legUsd}`);
  const basisBufferUsd = basisUsd + timingUsd + (legUsd * bufferBps) / 1e4;
  const totalUsd = feesUsd + slippageUsd + basisBufferUsd;
  return { feesUsd, slippageUsd, basisBufferUsd, totalUsd, bps: (totalUsd / legUsd) * 1e4 };
}

/** A gross APR earned over `holdHours` on one leg, USD: 10.95 % on 20 USD over 240 h is 0.06 USD. */
export function spreadOverHoldUsd(aprPct: number, legUsd: number, holdHours: number): number {
  return (aprPct / 100) * legUsd * (holdHours / HOURS_PER_YEAR);
}

/** Days of `aprPct` on `legUsd` that pay `costUsd`; null when the spread does not pay (≤ 0). 0.05 USD at 10.95 % on 20 USD: 8.3 days. */
export function breakevenDays(costUsd: number, aprPct: number, legUsd: number): number | null {
  if (!(aprPct > 0)) return null;
  return costUsd / ((aprPct / 100) * legUsd / 365);
}

export interface CarryEstimate {
  legUsd: number;
  holdHours: number;
  /** The window's gross in this direction: the current hour, and the 7- and 14-day means (null until known). */
  gross: { nowAprPct: number; d7AprPct: number | null; d14AprPct: number | null };
  /** Which average the estimate uses: the 14-day mean when the store holds it, else the 7-day one; null = neither. */
  basis: '14d' | '7d' | null;
  expectedAprPct: number | null;
  /** The spread expected over the hold at legUsd, USD. */
  expectedUsd: number | null;
  roundTrip: RoundTrip;
  /** expectedUsd − the round trip: what ranks desk windows. */
  netUsd: number | null;
  /** Days of the expected spread that pay the round trip. */
  breakevenDays: number | null;
  /** The gate: the expected spread over the hold pays more than the round trip. */
  ok: boolean;
}

/** The multi-day gross a desk window is judged on: 14-day when known, else 7-day, else null. */
export function multiDayApr(d7AprPct: number | null, d14AprPct: number | null): { basis: '14d' | '7d' | null; aprPct: number | null } {
  if (d14AprPct !== null) return { basis: '14d', aprPct: d14AprPct };
  if (d7AprPct !== null) return { basis: '7d', aprPct: d7AprPct };
  return { basis: null, aprPct: null };
}

export function carryEstimate(input: {
  legUsd: number; holdHours: number; grossNowAprPct: number; gross7dAprPct: number | null; gross14dAprPct: number | null; roundTrip: RoundTrip;
}): CarryEstimate {
  const { legUsd, holdHours, roundTrip: rt } = input;
  const { basis, aprPct } = multiDayApr(input.gross7dAprPct, input.gross14dAprPct);
  const expectedUsd = aprPct === null ? null : spreadOverHoldUsd(aprPct, legUsd, holdHours);
  const netUsd = expectedUsd === null ? null : expectedUsd - rt.totalUsd;
  return {
    legUsd, holdHours,
    gross: { nowAprPct: input.grossNowAprPct, d7AprPct: input.gross7dAprPct, d14AprPct: input.gross14dAprPct },
    basis, expectedAprPct: aprPct, expectedUsd, roundTrip: rt, netUsd,
    breakevenDays: aprPct === null ? null : breakevenDays(rt.totalUsd, aprPct, legUsd),
    ok: netUsd !== null && netUsd > 0,
  };
}

/** "10-day" for 240 h, "100 h" otherwise. */
export function holdLabel(holdHours: number): string {
  return holdHours % 24 === 0 ? `${holdHours / 24}-day` : `${holdHours} h`;
}

const pct = (n: number) => `${n.toFixed(2)} %`;
/** Money with the sign first, and four decimals under a cent: a 20 USD leg's costs are cents. -0.0061 -> "-$0.0061". */
export function money(n: number): string {
  const a = Math.abs(n);
  return `${n < 0 ? '-' : ''}${a < 0.01 && a !== 0 ? `$${a.toFixed(4)}` : usd(a)}`;
}

/**
 * The window's check lines for its expected carry: the gate (fails without a multi-day average, or when the spread
 * over the hold does not pay the round trip), and a note when the current hour points the other way.
 */
export function carryChecks(e: CarryEstimate): FundingWindow['checks'] {
  const hold = `a ${holdLabel(e.holdHours)} hold (assumed: the engine rules set none)`;
  const rt = e.roundTrip;
  const parts = `4 fills ${money(rt.feesUsd)}, slippage ${money(rt.slippageUsd)}, basis buffer ${money(rt.basisBufferUsd)}; ${rt.bps.toFixed(1)} bps`;
  if (e.basis === null || e.expectedAprPct === null || e.expectedUsd === null) {
    return [{ ok: false, text: `No 7-day funding history on both legs yet: the spread expected over ${hold} is not known, against a ${money(rt.totalUsd)} round trip (${parts})` }];
  }
  const label = e.basis === '14d' ? '14-day' : '7-day';
  const head = `Over ${hold}, the ${label} spread of ${pct(e.expectedAprPct)} APR pays ${money(e.expectedUsd)} at ${usd(e.legUsd)} a leg`;
  const out: FundingWindow['checks'] = [];
  if (e.ok) {
    out.push({ ok: true, text: `${head}, more than the ${money(rt.totalUsd)} round trip (${parts}): even after ${e.breakevenDays!.toFixed(1)} days` });
  } else {
    const even = e.breakevenDays === null ? 'it never pays it back' : `it takes ${e.breakevenDays.toFixed(1)} days to pay it back`;
    out.push({ ok: false, text: `${head}, no more than the ${money(rt.totalUsd)} round trip (${parts}): ${even}` });
  }
  if (e.expectedAprPct > 0 && !(e.gross.nowAprPct > 0)) {
    out.push({ ok: true, text: `Listed on the ${label} spread: this hour pays ${pct(e.gross.nowAprPct)} APR in this direction` });
  }
  return out;
}
