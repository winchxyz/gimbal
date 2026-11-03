// The numbers a carry open is judged on before anything is signed (pair-mainnet open): short one venue, long the
// other, each leg `legUsd` of notional.
//
//   net rate (per hour) = what the short receives − what the long pays = shortRate − longRate (> 0 longs pay shorts);
//   gross APR = net × 8760, now and over the last 7 days;
//   expected spread over the hold = legUsd × net(7-day mean) × 24 × holdDays;
//   round trip = legUsd × (both venues' taker fees, open and close
//                        + both venues' half spread, crossed on the open and on the close
//                        + a basis buffer: the two marks can drift apart while the pair is held);
//   liquidation distance per leg = (equity − maintenance already used − legUsd × maintenance rate) / legUsd: how far
//     the price may move against the new leg before the venue's maintenance is reached, with the leg's cross equity
//     as it is now (approximate: other positions are held still).
// The open is refused when the spread does not cover the round trip, a leg's distance is 40 % or less, or a leg's
// equity is under legUsd / leverage (the collateral the operator asked for).

export const MIN_LIQUIDATION_DISTANCE = 0.4;
const HOURS_PER_YEAR = 8760;

export interface CarryLegInput {
  venue: string;
  /** Funding now and the 7-day mean, fraction per hour, > 0 when longs pay shorts. */
  ratePerHour: number;
  rate7dPerHour: number;
  /** Taker fee in bps of notional, builder or referral fees included. */
  takerBps: number;
  /** Half the bid-ask spread now, bps of the mid. */
  halfSpreadBps: number;
  /** The venue account's equity and the maintenance margin its positions use now, USD. */
  equityUsd: number;
  maintenanceUsd: number;
  /** Maintenance margin as a fraction of notional for this market (Hyperliquid: 1 / (2 × max leverage)). */
  maintenanceRate: number;
}

export interface CarryInput {
  symbol: string;
  legUsd: number;
  leverage: number;
  holdDays: number;
  basisBufferBps: number;
  short: CarryLegInput;
  long: CarryLegInput;
}

export interface CarryLegPlan {
  venue: string;
  side: 'short' | 'long';
  collateralUsd: number;         // legUsd / leverage
  liquidationDistance: number;   // fraction of the price
}

export interface CarryPlan {
  netPerHourNow: number;
  netPerHour7d: number;
  grossAprNow: number;
  grossApr7d: number;
  expectedSpreadUsd: number;
  roundTripBps: number;
  roundTripUsd: number;
  legs: [CarryLegPlan, CarryLegPlan];
  refusals: string[];
}

export function carryPlan(input: CarryInput): CarryPlan {
  if (!(input.legUsd > 0) || !(input.leverage > 0) || !(input.holdDays > 0)) throw new Error('legUsd, leverage and holdDays must be above 0');
  const { short, long } = input;
  const netPerHourNow = short.ratePerHour - long.ratePerHour;
  const netPerHour7d = short.rate7dPerHour - long.rate7dPerHour;
  const expectedSpreadUsd = input.legUsd * netPerHour7d * 24 * input.holdDays;
  const roundTripBps = 2 * (short.takerBps + long.takerBps) + 2 * (short.halfSpreadBps + long.halfSpreadBps) + input.basisBufferBps;
  const roundTripUsd = (input.legUsd * roundTripBps) / 10_000;
  const leg = (l: CarryLegInput, side: 'short' | 'long'): CarryLegPlan => ({
    venue: l.venue, side, collateralUsd: input.legUsd / input.leverage,
    liquidationDistance: (l.equityUsd - l.maintenanceUsd - input.legUsd * l.maintenanceRate) / input.legUsd,
  });
  const legs: [CarryLegPlan, CarryLegPlan] = [leg(short, 'short'), leg(long, 'long')];
  const refusals: string[] = [];
  if (!(expectedSpreadUsd > roundTripUsd)) {
    refusals.push(`the expected spread over ${input.holdDays} days, ${usd(expectedSpreadUsd)}, does not cover the round trip ${usd(roundTripUsd)} (${roundTripBps.toFixed(1)} bps)`);
  }
  for (const [i, l] of legs.entries()) {
    const src = i === 0 ? short : long;
    if (src.equityUsd < l.collateralUsd) refusals.push(`${l.venue} holds ${usd(src.equityUsd)} of equity, under the ${usd(l.collateralUsd)} a ${input.leverage}x leg of ${usd(input.legUsd)} needs: fund it first`);
    if (!(l.liquidationDistance > MIN_LIQUIDATION_DISTANCE)) {
      refusals.push(`${l.venue}: the ${l.side} leg would be liquidated ${pct(l.liquidationDistance)} away, not more than ${pct(MIN_LIQUIDATION_DISTANCE)}`);
    }
  }
  return {
    netPerHourNow, netPerHour7d, grossAprNow: netPerHourNow * HOURS_PER_YEAR, grossApr7d: netPerHour7d * HOURS_PER_YEAR,
    expectedSpreadUsd, roundTripBps, roundTripUsd, legs, refusals,
  };
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
