// What a desk window is expected to earn over the planned hold, set against what entering and leaving it costs.
// The current hour's rate says little about a hold of days: funding flips sign hour to hour on quiet markets, so a
// desk window is listed in the direction its multi-day spread pays (its 7- and 14-day means agreeing in sign), ranked
// on that spread over the hold minus the round trip, and gated on what that nets over the hold against the owner's
// minimum. Pure: the averages and costs come in as arguments.
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

/**
 * What a desk pair's multi-day spread says in one direction (APR, > 0 means it pays):
 * - `none`: under 7 days of history on a leg;
 * - `loading`: the 7 days are in, the week before them is still being read;
 * - `mixed`: the 7- and 14-day means point opposite ways, so the spread is not steady in either direction;
 * - `known`: the smaller of the two means in magnitude, with their common sign (a decaying spread is judged on what is
 *   left of it), or the 7-day mean alone when the 14 days cannot be had (the read failed for good, or the market is
 *   younger than 14 days).
 */
export type MultiDay =
  | { state: 'none' }
  | { state: 'loading'; d7AprPct: number }
  | { state: 'mixed'; d7AprPct: number; d14AprPct: number }
  | { state: 'known'; basis: '14d' | '7d'; aprPct: number };

/** A 7-day mean under this (APR points, either sign) counts as 0. */
export const DEAD_BAND_APR_PCT = 0.5;

/**
 * The multi-day figure from the 7- and 14-day means; `fortnightPending` while a leg's older read is still due.
 * 7 d 5.11, 14 d 10.95: known, 5.11 on 7 d. 7 d 5.11, 14 d -2: mixed. 7 d 5.11, no 14 d, pending: loading. 7 d 0.3: as 0.
 */
export function multiDay(d7Raw: number | null, d14AprPct: number | null, fortnightPending: boolean): MultiDay {
  if (d7Raw === null) return { state: 'none' };
  // A 7-day mean this close to zero has no direction: as 0, so a pair does not flicker in and out of the list.
  const d7AprPct = Math.abs(d7Raw) < DEAD_BAND_APR_PCT ? 0 : d7Raw;
  if (d14AprPct === null) return fortnightPending ? { state: 'loading', d7AprPct } : { state: 'known', basis: '7d', aprPct: d7AprPct };
  if (d7AprPct * d14AprPct < 0) return { state: 'mixed', d7AprPct, d14AprPct };
  const basis = Math.abs(d14AprPct) < Math.abs(d7AprPct) ? '14d' : '7d';
  return { state: 'known', basis, aprPct: basis === '14d' ? d14AprPct : d7AprPct };
}

/**
 * The APR a desk pair is listed on in this direction, or null when its history says nothing yet (`none`: it is
 * listed on this hour) or says it is not steady (`mixed`: not listed). While the older week loads, the 7 days decide.
 */
export function listingApr(m: MultiDay): number | null {
  switch (m.state) {
    case 'none': return null;
    case 'loading': return m.d7AprPct;
    case 'mixed': return null;
    case 'known': return m.aprPct;
  }
}

export interface CarryEstimate {
  legUsd: number;
  holdHours: number;
  /** The window's gross in this direction: the current hour, and the 7- and 14-day means (null until known). */
  gross: { nowAprPct: number; d7AprPct: number | null; d14AprPct: number | null };
  /** What the history says (see MultiDay); only `known` gives an estimate. */
  state: MultiDay['state'];
  /** Which mean the estimate uses (the smaller of the two, or the 7 days alone); null when not `known`. */
  basis: '14d' | '7d' | null;
  expectedAprPct: number | null;
  /** The spread expected over the hold at legUsd, USD. */
  expectedUsd: number | null;
  roundTrip: RoundTrip;
  /** expectedUsd − the round trip: what ranks desk windows. */
  netUsd: number | null;
  /** netUsd as APR on one leg over the hold: what the gate holds against the owner's minimum. */
  netAprPct: number | null;
  /** StrategyConfig.minNetAprPct. */
  minNetAprPct: number;
  /** Days of the expected spread that pay the round trip. */
  breakevenDays: number | null;
  /** The gate: the expected spread over the hold pays the round trip and nets at least the owner's minimum. */
  ok: boolean;
}

export function carryEstimate(input: {
  legUsd: number; holdHours: number; grossNowAprPct: number; gross7dAprPct: number | null; gross14dAprPct: number | null;
  multiDay: MultiDay; roundTrip: RoundTrip; minNetAprPct: number;
}): CarryEstimate {
  const { legUsd, holdHours, roundTrip: rt, multiDay: m, minNetAprPct } = input;
  const known = m.state === 'known' ? m : null;
  const aprPct = known?.aprPct ?? null;
  const expectedUsd = aprPct === null ? null : spreadOverHoldUsd(aprPct, legUsd, holdHours);
  const netUsd = expectedUsd === null ? null : expectedUsd - rt.totalUsd;
  const netAprPct = netUsd === null ? null : (netUsd / legUsd) * (HOURS_PER_YEAR / holdHours) * 100;
  return {
    legUsd, holdHours,
    gross: { nowAprPct: input.grossNowAprPct, d7AprPct: input.gross7dAprPct, d14AprPct: input.gross14dAprPct },
    state: m.state, basis: known?.basis ?? null, expectedAprPct: aprPct, expectedUsd, roundTrip: rt, netUsd, netAprPct, minNetAprPct,
    breakevenDays: aprPct === null ? null : breakevenDays(rt.totalUsd, aprPct, legUsd),
    ok: netUsd !== null && netAprPct !== null && netUsd > 0 && netAprPct >= minNetAprPct,
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

/** "5 %", "2.5 %": the owner's minimum as they set it. */
const minimum = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)} %`;

/**
 * The window's check lines for its expected carry: the gate (fails without a multi-day figure, while the older week
 * loads, when the 7 and 14 days disagree in sign, when the spread over the hold does not pay the round trip, or when
 * what it nets over the hold is under the owner's minimum), and a note when the current hour points the other way.
 */
export function carryChecks(e: CarryEstimate): FundingWindow['checks'] {
  const hold = `a ${holdLabel(e.holdHours)} hold (assumed: the engine rules set none)`;
  const rt = e.roundTrip;
  const parts = `4 fills ${money(rt.feesUsd)}, slippage ${money(rt.slippageUsd)}, basis buffer ${money(rt.basisBufferUsd)}; ${rt.bps.toFixed(1)} bps`;
  const against = `against a ${money(rt.totalUsd)} round trip (${parts})`;
  const { d7AprPct: d7, d14AprPct: d14, nowAprPct: now } = e.gross;
  if (e.state === 'none') {
    return [{ ok: false, text: `No 7-day funding history on both legs yet: the spread expected over ${hold} is not known, ${against}` }];
  }
  if (e.state === 'loading') {
    const out: FundingWindow['checks'] = [{
      ok: false,
      text: `14-day history loading: the 7-day spread of ${pct(d7!)} APR is in, the week before it is still being read; the gate waits for both, ${against}`,
    }];
    if (d7! > 0 && !(now > 0)) out.push({ ok: true, text: `Listed on the 7-day spread: this hour pays ${pct(now)} APR in this direction` });
    return out;
  }
  if (e.state === 'mixed') {
    return [{ ok: false, text: `The 7-day spread (${pct(d7!)} APR) and the 14-day spread (${pct(d14!)} APR) point opposite ways: no steady carry in this direction` }];
  }
  const label = e.basis === '14d' ? '14-day' : '7-day';
  const which = d14 === null ? 'the 14-day mean could not be had' : 'the smaller of the 7- and 14-day means';
  const head = `Over ${hold}, the ${label} spread of ${pct(e.expectedAprPct!)} APR (${which}) pays ${money(e.expectedUsd!)} at ${usd(e.legUsd)} a leg`;
  const nets = `${pct(e.netAprPct!)} APR over the hold`;
  const out: FundingWindow['checks'] = [];
  if (e.ok) {
    out.push({
      ok: true,
      text: `${head}, more than the ${money(rt.totalUsd)} round trip (${parts}): it nets ${nets}, at least your ${minimum(e.minNetAprPct)} minimum, `
        + `and pays the round trip back in ${e.breakevenDays!.toFixed(1)} days`,
    });
  } else if (e.netUsd! > 0) {
    out.push({
      ok: false,
      text: `${head}, more than the ${money(rt.totalUsd)} round trip (${parts}), but it nets only ${nets}, under your ${minimum(e.minNetAprPct)} minimum`,
    });
  } else {
    const even = e.breakevenDays === null ? 'it never pays it back' : `it takes ${e.breakevenDays.toFixed(1)} days to pay it back`;
    out.push({ ok: false, text: `${head}, no more than the ${money(rt.totalUsd)} round trip (${parts}): ${even}` });
  }
  if (e.expectedAprPct! > 0 && !(now > 0)) {
    out.push({ ok: true, text: `Listed on the ${label} spread: this hour pays ${pct(now)} APR in this direction` });
  }
  return out;
}
