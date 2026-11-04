// The numbers a carry open is judged on before anything is signed (pair-mainnet open): short one venue, long the
// other, each leg `legUsd` of notional.
//
//   net rate (per hour) = what the short receives − what the long pays = shortRate − longRate (> 0 longs pay shorts);
//   gross APR = net × 8760, now and over the last 7 days;
//   expected spread over the hold = legUsd × net(7-day mean) × 24 × holdDays (scanner/carry.ts spreadOverHoldUsd);
//   round trip = scanner/carry.ts deskRoundTrip, the same function the scanner's gate prices a desk window with:
//     each venue's fee on all 4 fills (open and close, both legs), each fill walked through that venue's book now at
//     legUsd (half the spread plus any impact), the adverse gap between the two books' mids at entry, funding lost to
//     payment schedules, and a basis buffer of `basisBufferBps` for the gap moving by the exit;
//   liquidation distance per leg = (equity − maintenance already used − legUsd × maintenance rate) / legUsd: how far
//     the price may move against the new leg before the venue's maintenance is reached, with the leg's cross equity
//     as it is now (approximate: other positions are held still).
//   effective leverage per leg = (notional the account already holds + legUsd) / equity.
// The open is refused when the spread does not cover the round trip (or a book cannot price it: one side empty, or
// too thin to fill legUsd within the levels read), a leg's distance is 40 % or less, the asked leverage is over
// MAX_LEVERAGE, or a leg's effective leverage is over the asked leverage or its venue's cap (venueMaxLeverage).
//
// Every fill is priced as a taker fill, though serve's opens and closes put the Hyperliquid leg first as a post-only
// order (maker fee, no spread crossed): its partner is hedged only once it fills, after the price came to it, so the
// maker saving is not counted, as the scanner does not count it either.

import type { BookLevel } from '../venues/venue.ts';
import { aprPct, fundingTimingUsd } from '../scanner/costs.ts';
import type { RoundTrip } from '../scanner/carry.ts';
import { deskRoundTrip, spreadOverHoldUsd } from '../scanner/carry.ts';

export const MIN_LIQUIDATION_DISTANCE = 0.4;
/** The most leverage any leg may run at, whatever is asked. */
export const MAX_LEVERAGE = 2;
/** The cap of a leg on a venue without a live rescue. */
export const NO_RESCUE_MAX_LEVERAGE = 1.5;
/**
 * Whether the contract can rescue a venue's collateral to the other leg's venue in an emergency. A venue without a
 * live rescue is held to NO_RESCUE_MAX_LEVERAGE: Phoenix until the Phoenix -> Hyperliquid rescue merges, Orderly after
 * it. Flip an entry to true when its rescue is live on the contract the desk runs.
 */
export const LIVE_RESCUE: Record<string, boolean> = { hyperliquid: true, phoenix: false, orderly: false };

/** The most leverage a leg on `venue` may run at. */
export function venueMaxLeverage(venue: string): number {
  return LIVE_RESCUE[venue] === true ? MAX_LEVERAGE : NO_RESCUE_MAX_LEVERAGE;
}
const HOURS_PER_YEAR = 8760;

export interface CarryLegInput {
  venue: string;
  /** Funding now and the 7-day mean, fraction per hour, > 0 when longs pay shorts. */
  ratePerHour: number;
  rate7dPerHour: number;
  /** One fill's fee in bps of notional: the venue's taker fee plus what rides on every order (builder fee). */
  feeBps: number;
  /** The venue's book now (the levels read): every fill of the round trip is walked through it. */
  book: { bids: readonly BookLevel[]; asks: readonly BookLevel[] };
  /** Hours one funding payment covers on this venue (scanner/costs.ts paymentPeriodHours); absent: hourly. */
  periodHours?: number;
  /** The venue account's equity and the maintenance margin its positions use now, USD. */
  equityUsd: number;
  maintenanceUsd: number;
  /** The notional of every position the account holds now, USD (its effective leverage counts them). */
  notionalUsd: number;
  /** Maintenance margin as a fraction of notional for this market (Hyperliquid: 1 / (2 × max leverage)). */
  maintenanceRate: number;
}

export interface CarryInput {
  symbol: string;
  legUsd: number;
  leverage: number;
  holdDays: number;
  /** Bps of the leg set aside for the gap between the marks moving by the exit (scanner config basisBufferBps). */
  basisBufferBps: number;
  short: CarryLegInput;
  long: CarryLegInput;
}

export interface CarryLegPlan {
  venue: string;
  side: 'short' | 'long';
  collateralUsd: number;         // legUsd / leverage
  liquidationDistance: number;   // fraction of the price
  effectiveLeverage: number;     // (notionalUsd + legUsd) / equity; Infinity with no equity
  maxLeverage: number;           // min(asked, the venue's cap)
}

export interface CarryPlan {
  netPerHourNow: number;
  netPerHour7d: number;
  grossAprNow: number;
  grossApr7d: number;
  expectedSpreadUsd: number;
  /** The round trip's parts (deskRoundTrip); null when a book has an empty side and it cannot be priced. */
  roundTrip: RoundTrip | null;
  roundTripBps: number;
  roundTripUsd: number;
  legs: [CarryLegPlan, CarryLegPlan];
  refusals: string[];
  /**
   * The refusal for cost (one of `refusals`): the spread over the hold does not cover the round trip, or a book
   * cannot price it. The strategy loop holds such a window out until its next hourly check; null: none.
   */
  costRefusal: string | null;
}

export function carryPlan(input: CarryInput): CarryPlan {
  if (!(input.legUsd > 0) || !(input.leverage > 0) || !(input.holdDays > 0)) throw new Error('legUsd, leverage and holdDays must be above 0');
  const { short, long, legUsd } = input;
  const holdHours = input.holdDays * 24;
  const netPerHourNow = short.ratePerHour - long.ratePerHour;
  const netPerHour7d = short.rate7dPerHour - long.rate7dPerHour;
  const expectedSpreadUsd = spreadOverHoldUsd(aprPct(netPerHour7d), legUsd, holdHours);
  // As the scanner prices it (price.ts): the long leg pays its rate, the short receives its own, each on its schedule.
  const timingUsd = fundingTimingUsd(-long.ratePerHour * legUsd, long.periodHours ?? 1, holdHours)
    + fundingTimingUsd(short.ratePerHour * legUsd, short.periodHours ?? 1, holdHours);
  const priced = deskRoundTrip(
    legUsd, { feeBps: long.feeBps, book: long.book, px: bookMid(long.book) }, { feeBps: short.feeBps, book: short.book, px: bookMid(short.book) },
    timingUsd, input.basisBufferBps,
  );
  const leg = (l: CarryLegInput, side: 'short' | 'long'): CarryLegPlan => ({
    venue: l.venue, side, collateralUsd: legUsd / input.leverage,
    liquidationDistance: (l.equityUsd - l.maintenanceUsd - legUsd * l.maintenanceRate) / legUsd,
    effectiveLeverage: l.equityUsd > 0 ? (l.notionalUsd + legUsd) / l.equityUsd : Infinity,
    maxLeverage: Math.min(input.leverage, venueMaxLeverage(l.venue)),
  });
  const legs: [CarryLegPlan, CarryLegPlan] = [leg(short, 'short'), leg(long, 'long')];
  const refusals: string[] = [];
  let costRefusal: string | null = null;
  // A fee that is not known (the caller's fee read failed) prices nothing: refused, and not for cost (the window's
  // spread was never judged).
  const unknownFee = ([short, long] as const).filter((l) => !(Number.isFinite(l.feeBps) && l.feeBps >= 0));
  if (unknownFee.length > 0) {
    refusals.push(`${unknownFee.map((l) => `the ${l.venue} fee a fill is not known (${l.feeBps})`).join('; ')}: the round trip cannot be priced`);
  } else if (!priced.ok) {
    costRefusal = `the ${(priced.side === 'long' ? long : short).venue} book has no two-sided touch: the round trip cannot be priced`;
  } else {
    const rt = priced.roundTrip;
    const thin = ([[long, priced.long], [short, priced.short]] as const).filter(([, f]) => f.exhausted);
    if (thin.length > 0) {
      costRefusal = `${thin.map(([l, f]) => `the ${l.venue} book fills only ${usd(f.filledUsd)} of ${usd(legUsd)} within the levels read`).join('; ')}: the round trip cannot be priced`;
    } else if (!(expectedSpreadUsd > rt.totalUsd)) {
      costRefusal = `the expected spread over ${input.holdDays} days, ${usd(expectedSpreadUsd)}, does not cover the round trip ${usd(rt.totalUsd)} `
        + `(${rt.bps.toFixed(1)} bps: 4 fills ${usd(rt.feesUsd)}, slippage ${usd(rt.slippageUsd)}, basis buffer ${usd(rt.basisBufferUsd)})`;
    }
  }
  if (costRefusal !== null) refusals.push(costRefusal);
  if (input.leverage > MAX_LEVERAGE) refusals.push(`--leverage ${input.leverage} is over the ${MAX_LEVERAGE}x every leg is held to`);
  for (const [i, l] of legs.entries()) {
    const src = i === 0 ? short : long;
    if (!(l.effectiveLeverage <= l.maxLeverage)) {
      const cap = l.maxLeverage < input.leverage ? `its venue's ${l.maxLeverage}x cap (${LIVE_RESCUE[l.venue] === true ? 'live rescue' : 'no live rescue'})` : `the ${input.leverage}x asked`;
      refusals.push(`${l.venue}: ${usd(src.notionalUsd)} already open plus the ${usd(input.legUsd)} leg on ${usd(src.equityUsd)} of equity is ${Number.isFinite(l.effectiveLeverage) ? `${l.effectiveLeverage.toFixed(2)}x` : 'unbounded (no equity)'}, over ${cap}: fund it with at least ${usd((src.notionalUsd + input.legUsd) / l.maxLeverage - src.equityUsd)} more`);
    }
    if (!(l.liquidationDistance > MIN_LIQUIDATION_DISTANCE)) {
      refusals.push(`${l.venue}: the ${l.side} leg would be liquidated ${pct(l.liquidationDistance)} away, not more than ${pct(MIN_LIQUIDATION_DISTANCE)}`);
    }
  }
  const roundTrip = priced.ok && unknownFee.length === 0 ? priced.roundTrip : null;
  return {
    netPerHourNow, netPerHour7d, grossAprNow: netPerHourNow * HOURS_PER_YEAR, grossApr7d: netPerHour7d * HOURS_PER_YEAR,
    expectedSpreadUsd, roundTrip, roundTripBps: roundTrip?.bps ?? NaN, roundTripUsd: roundTrip?.totalUsd ?? NaN, legs, refusals, costRefusal,
  };
}

/** A book's mid from its touch; null without both sides. */
function bookMid(book: { bids: readonly BookLevel[]; asks: readonly BookLevel[] }): number | null {
  const bid = book.bids[0]?.px;
  const ask = book.asks[0]?.px;
  return bid !== undefined && ask !== undefined && bid > 0 && ask >= bid ? (bid + ask) / 2 : null;
}

/** The mean hourly rate of funding prints (each weighted by the hours it covers); null when there are none. */
export function meanRatePerHour(points: readonly { ratePerHour: number; periodHours: number }[]): number | null {
  const hours = points.reduce((s, p) => s + p.periodHours, 0);
  return hours > 0 ? points.reduce((s, p) => s + p.ratePerHour * p.periodHours, 0) / hours : null;
}

/** Half the spread of a book's touch, bps of its mid. */
export function halfSpreadBps(bid: number, ask: number): number {
  if (!(bid > 0) || !(ask >= bid)) throw new Error(`no two-sided book (bid ${bid}, ask ${ask})`);
  return ((ask - bid) / 2 / ((ask + bid) / 2)) * 10_000;
}

export function usd(v: number): string {
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(4)}`;
}

export function pct(v: number): string {
  return `${(v * 100).toFixed(2)} %`;
}
