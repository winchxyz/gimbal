// The net-carry model: every cost term of a window as a small pure function, each with its units. This decides what
// the desk trades with real money, so nothing here guesses: a term the inputs cannot price is reported as missing by
// the caller, never as 0.
//
// Units used throughout:
// - rates: fraction of notional per hour, > 0 means longs pay shorts (FundingRate.ratePerHour);
// - money: USD (USDC), per window at `legUsd` notional on each leg;
// - APR: percentage points per year on ONE leg's notional (the desk holds `legUsd` long and `legUsd` short and earns
//   the difference of the two rates on that notional), 365-day year;
// - fees: basis points (1 bp = 0.01 % of notional).

import type { VenueId } from '@gimbal/shared';
import type { BookLevel } from '../venues/venue.ts';

export const HOURS_PER_YEAR = 365 * 24;
const HOUR_MS = 3_600_000;

/** A fraction per hour as APR percentage points: 0.0001 per hour -> 87.6 % a year. */
export function aprPct(fractionPerHour: number): number {
  return fractionPerHour * HOURS_PER_YEAR * 100;
}

/**
 * Gross carry per hour, as a fraction of one leg's notional: the short leg receives `shortReceivesPerHour`, the long
 * leg pays `longRatePerHour` (both > 0 = income for the short side). Long A at 0.00001, short B at 0.00005:
 * 0.00004 per hour = 35.04 % APR.
 */
export function grossPerHour(longRatePerHour: number, shortReceivesPerHour: number): number {
  return shortReceivesPerHour - longRatePerHour;
}

/**
 * A one-off cost in USD spread over the hold, as APR points on one leg's notional:
 * 1.2 USD on a 1000 USD leg held 168 h = 0.12 % of notional per week = 6.257 % APR.
 */
export function oneOffAprPct(costUsd: number, legUsd: number, holdHours: number): number {
  if (!(legUsd > 0)) throw new RangeError(`legUsd must be > 0, got ${legUsd}`);
  if (!(holdHours > 0)) throw new RangeError(`holdHours must be > 0, got ${holdHours}`);
  return (costUsd / legUsd) * (HOURS_PER_YEAR / holdHours) * 100;
}

// ---------- fees ----------

/** A venue's cost per taker fill in bps: its taker fee plus what rides on every order there (builder fee, broker markup). */
export interface FillFee {
  takerBps: number;
  extraBps: number;              // Hyperliquid: the treasury builder fee (FeeConfig.hl_builder_tenth_bps / 10); Orderly: broker markup
}

export function fillFeeBps(fee: FillFee): number {
  return fee.takerBps + fee.extraBps;
}

/**
 * Taker fees on the 4 fills of a window (open and close the long leg, open and close the short leg), USD:
 * legUsd × 2 × (long venue bps + short venue bps) / 10⁴. 1000 USD, 5.5 bps and 3.5 bps: 1000 × 2 × 9 / 10⁴ = 1.80 USD.
 */
export function takerFeesUsd(legUsd: number, longFeeBps: number, shortFeeBps: number): number {
  return (legUsd * 2 * (longFeeBps + shortFeeBps)) / 1e4;
}

// ---------- slippage ----------

export interface BookWalk {
  // A walk that runs out of levels prices only what it filled: the caller must not rank that as a full fill.
  filledUsd: number;             // notional the levels could fill, ≤ the notional asked for
  avgPx: number | null;          // USD per venue unit; null when nothing filled
  costUsd: number;               // what the fill pays against the mid, USD (half the spread plus impact), ≥ 0
  exhausted: boolean;            // the levels ran out before the notional was filled
}

/**
 * A market order of `notionalUsd` walked through one side of a book, best level first: a buy takes the asks, a sell
 * hits the bids. The cost is measured against the mid ((best bid + best ask) / 2), so it includes half the spread.
 * Prices are USD per venue unit and sizes venue units, so the multiplier plays no part.
 * Buy 1000 USD on asks [100.1 × 5, 100.2 × 10] with mid 100: 500.5 USD at 100.1 (cost 0.5), then 499.5 USD at 100.2
 * (4.985 units, cost 0.997): 1.497 USD.
 */
export function walkBook(levels: readonly BookLevel[], mid: number, notionalUsd: number, side: 'buy' | 'sell'): BookWalk {
  if (!(mid > 0)) throw new RangeError(`mid must be > 0, got ${mid}`);
  if (!(notionalUsd > 0)) throw new RangeError(`notional must be > 0, got ${notionalUsd}`);
  let left = notionalUsd;
  let units = 0;
  let cost = 0;
  for (const level of levels) {
    if (!(level.px > 0) || !(level.sz > 0)) continue;
    const take = Math.min(left, level.px * level.sz);
    const sz = take / level.px;
    units += sz;
    cost += side === 'buy' ? (level.px - mid) * sz : (mid - level.px) * sz;
    left -= take;
    if (left <= notionalUsd * 1e-12) {
      left = 0;
      break;
    }
  }
  const filled = notionalUsd - left;
  return { filledUsd: filled, avgPx: units > 0 ? filled / units : null, costUsd: Math.max(0, cost), exhausted: left > 0 };
}

/** Mid of a book from its best levels; null when a side is empty. */
export function bookMid(bids: readonly BookLevel[], asks: readonly BookLevel[]): number | null {
  const bid = bids[0]?.px;
  const ask = asks[0]?.px;
  if (bid === undefined || ask === undefined || !(bid > 0) || !(ask >= bid)) return null;
  return (bid + ask) / 2;
}

export interface LegSlippage {
  openUsd: number;               // the opening fill: a buy for the long leg, a sell for the short leg
  closeUsd: number;              // the closing fill on today's book: the other side
  filledUsd: number;             // the smaller of the two fills
  exhausted: boolean;            // either side ran out of levels before legUsd
}

/**
 * Slippage of one leg's two fills at `legUsd` on its current book: the long leg buys to open and sells to close,
 * the short leg sells to open and buys to close. Today's book stands in for the closing book.
 */
export function legSlippage(book: { bids: readonly BookLevel[]; asks: readonly BookLevel[] }, legUsd: number, side: 'long' | 'short'): LegSlippage | null {
  const mid = bookMid(book.bids, book.asks);
  if (mid === null) return null;
  const buy = walkBook(book.asks, mid, legUsd, 'buy');
  const sell = walkBook(book.bids, mid, legUsd, 'sell');
  const [open, close] = side === 'long' ? [buy, sell] : [sell, buy];
  return {
    openUsd: open.costUsd,
    closeUsd: close.costUsd,
    filledUsd: Math.min(buy.filledUsd, sell.filledUsd),
    exhausted: buy.exhausted || sell.exhausted,
  };
}

// ---------- basis ----------

/**
 * Basis between the two marks (USD per base unit, after the multiplier), as a one-off cost in USD: a long leg opened
 * where the price is higher than where the short is opened loses that gap when the marks converge. Only the adverse
 * side counts; a long on the cheaper venue is not booked as income. Long mark 100.2, short 100.0, 1000 USD leg:
 * 0.2 / 100.1 × 1000 = 1.998 USD.
 */
export function basisCostUsd(longMark: number, shortMark: number, legUsd: number): number {
  if (!(longMark > 0) || !(shortMark > 0)) throw new RangeError(`marks must be > 0, got ${longMark}, ${shortMark}`);
  const mid = (longMark + shortMark) / 2;
  return Math.max(0, (longMark - shortMark) / mid) * legUsd;
}

// ---------- funding timing (interval mismatch) ----------

/**
 * Hours one funding payment covers, for the timing model: Orderly pays every 8 h (4 h on some markets) to whoever
 * holds at that moment; Hyperliquid pays hourly; Phoenix accrues hourly and only settles daily (an exit settles what
 * accrued), so it counts as hourly; continuous funding accrues every block.
 */
export function paymentPeriodHours(settlement: 'hourly' | '2h' | '4h' | '8h' | 'daily' | 'continuous'): number {
  switch (settlement) {
    case '2h': return 2;
    case '4h': return 4;
    case '8h': return 8;
    default: return 1;
  }
}

/**
 * Funding a leg can lose to its payment schedule over a hold of `holdHours`, worst case over when the hold starts, USD:
 * a leg that earns `incomePerHourUsd` (> 0) on a P-hour schedule is paid only for whole periods it holds through
 * (floor(hold / P) payments); a leg that pays (< 0) pays for every period it touches (ceil(hold / P)). Hourly
 * schedules lose nothing. Earning 0.12 USD/h on 8 h payments over a 100 h hold: 12 payments cover 96 h, so the
 * last 4 h (0.48 USD) can go unpaid. Over 168 h (21 payments exactly) nothing is lost.
 */
export function fundingTimingUsd(incomePerHourUsd: number, periodHours: number, holdHours: number): number {
  if (!(periodHours > 0) || !(holdHours > 0)) throw new RangeError(`period and hold must be > 0, got ${periodHours}, ${holdHours}`);
  if (periodHours <= 1 || incomePerHourUsd === 0) return 0;
  const periods = holdHours / periodHours;
  if (incomePerHourUsd > 0) return incomePerHourUsd * (holdHours - Math.floor(periods + 1e-9) * periodHours);
  return -incomePerHourUsd * (Math.ceil(periods - 1e-9) * periodHours - holdHours);
}

// ---------- moving margin (1Click) ----------

/** Where desk money can sit: a venue, or the rescue reserve (USDC in the desk's Solana wallet). */
export type Place = VenueId | 'reserve';

export interface TransferCosts {
  /** 1Click's flat cost per transfer by the chain the money leaves from, USD (measured on mainnet 2026-10-27). */
  oneClickFlatUsd: { solana: number; hypercore: number; arbitrum: number };
  /** 1Click's share of the amount, bps: 20 without a partner API key, 1 with one (USDC to USDC). */
  oneClickBps: number;
  /** Hyperliquid charges this on every sendAsset to an address it has not seen, which every 1Click deposit address is. */
  hlActivationUsd: number;
  /** Orderly's fee on a withdrawal to Arbitrum, before 1Click picks it up. */
  orderlyWithdrawUsd: number;
  /** Orderly loses deposits below 5 USDC; the contract asks for at least this much out of the quote. */
  orderlyMinDepositUsd: number;
}

function chainOf(place: Place): 'solana' | 'hypercore' | 'arbitrum' {
  if (place === 'hyperliquid') return 'hypercore';
  if (place === 'orderly') return 'arbitrum';
  return 'solana';
}

/** One 1Click transfer of `amountUsd`: flat + amount × bps / 10⁴, USD. 70 USD at 0.32 USD + 20 bps: 0.32 + 0.14 = 0.46. */
export function oneClickCostUsd(amountUsd: number, flatUsd: number, bps: number): number {
  if (!(amountUsd >= 0)) throw new RangeError(`amount must be >= 0, got ${amountUsd}`);
  return flatUsd + (amountUsd * bps) / 1e4;
}

/**
 * Moving `amountUsd` of margin from one place to another, USD. Phoenix and the reserve are the same Solana wallet
 * (a Phoenix deposit or withdrawal needs no 1Click), so moving between them costs nothing here. Everything else is
 * one 1Click transfer priced by the chain it leaves from, plus what the source charges on the way out: Hyperliquid's
 * activation fee on the sendAsset, Orderly's withdrawal fee. A transfer into Orderly is at least its minimum deposit.
 * Hyperliquid -> Phoenix, 70 USD: 1.00 + 0.21 + 0.14 = 1.35 USD.
 */
export function moveCostUsd(from: Place, to: Place, amountUsd: number, costs: TransferCosts): number {
  if (from === to) return 0;
  const solanaSide = (p: Place) => p === 'phoenix' || p === 'reserve';
  if (solanaSide(from) && solanaSide(to)) return 0;
  const amount = to === 'orderly' ? Math.max(amountUsd, costs.orderlyMinDepositUsd) : amountUsd;
  const exit = from === 'hyperliquid' ? costs.hlActivationUsd : from === 'orderly' ? costs.orderlyWithdrawUsd : 0;
  return exit + oneClickCostUsd(amount, costs.oneClickFlatUsd[chainOf(from)], costs.oneClickBps);
}

/**
 * Moving one leg's margin onto its venue for a hold and back afterwards, USD: in from the reserve, out to it.
 * Margin 333.33 USD (1000 USD at 3×) on Hyperliquid: in 0.32 + 0.6667 = 0.9867, out 1.00 + 0.21 + 0.6667 = 1.8767,
 * 2.8633 USD in all. On Phoenix (the reserve's own wallet) it costs nothing.
 */
export function marginRoundTripUsd(venue: VenueId, marginUsd: number, reserveAt: Place, costs: TransferCosts): number {
  return moveCostUsd(reserveAt, venue, marginUsd, costs) + moveCostUsd(venue, reserveAt, marginUsd, costs);
}

/**
 * The margin one rescue moves: enough to take a leg from the rescue distance back to the watch distance, which for a
 * leg of `legUsd` is about legUsd × (watch − rescue) / 100 (1000 USD, 15 % and 8 %: 70 USD).
 */
export function rescueAmountUsd(legUsd: number, watchDistancePct: number, rescueDistancePct: number): number {
  return Math.max(0, (legUsd * (watchDistancePct - rescueDistancePct)) / 100);
}

/**
 * Expected rescue cost over one hold, USD: `rescuesPerHold` rescues, each priced as the dearer of the two legs'
 * routes from the reserve (either leg can be the one squeezed). Reserve on Solana, HL and Phoenix legs, 70 USD,
 * one rescue: max(0.46, 0) = 0.46 USD.
 */
export function rescueCostUsd(
  longVenue: VenueId, shortVenue: VenueId, amountUsd: number, rescuesPerHold: number, reserveAt: Place, costs: TransferCosts,
): number {
  const perRescue = Math.max(moveCostUsd(reserveAt, longVenue, amountUsd, costs), moveCostUsd(reserveAt, shortVenue, amountUsd, costs));
  return rescuesPerHold * perRescue;
}

// ---------- breakeven ----------

export interface PaymentSchedule {
  incomePerHourUsd: number;      // what this leg earns per hour (< 0 when it pays)
  periodHours: number;           // hours per payment (paymentPeriodHours)
  firstInHours: number;          // hours from now to its next payment (0 < x ≤ periodHours)
}

/**
 * Hours from now until the funding received covers `costUsd`, with each leg paid on its own schedule: an 8 h leg
 * pays 8 hours of income at once, at its next payment time. Returns null when it does not happen within
 * `horizonHours`. HL leg 0.10 USD/h paid in 0.25 h, Orderly leg 0.20 USD/h every 8 h in 2 h, cost 2.00 USD: HL alone
 * reaches 0.20 by 1.25 h, the Orderly lump of 1.60 USD at 2 h makes 1.80, and HL's payments at 2.25 h and 3.25 h
 * reach 2.00: 3.25 h.
 */
export function breakevenHours(costUsd: number, legs: readonly PaymentSchedule[], horizonHours = HOURS_PER_YEAR): number | null {
  if (!(costUsd > 0)) return 0;
  const next = legs.map((l) => Math.max(0, l.firstInHours));
  let paid = 0;
  for (let guard = 0; guard < 1_000_000; guard++) {
    let k = -1;
    for (let i = 0; i < legs.length; i++) if (k === -1 || next[i]! < next[k]!) k = i;
    if (k === -1) return null;
    const t = next[k]!;
    if (t > horizonHours) return null;
    // Every leg due at this same moment pays before the total is compared.
    for (let i = 0; i < legs.length; i++) {
      if (Math.abs(next[i]! - t) < 1e-9) {
        paid += legs[i]!.incomePerHourUsd * legs[i]!.periodHours;
        next[i] = next[i]! + legs[i]!.periodHours;
      }
    }
    // A relative tolerance: a hundred 0.10 payments add up to 9.99999999999998 in floating point, not 10.
    if (paid >= costUsd * (1 - 1e-9)) return t;
  }
  return null;
}

/**
 * Hours from `now` to `nextAt`, kept within (0, periodHours]. A payment time at or before `now` has just been paid
 * (the reader's nextAt can lag a scan), so the next one is a whole period away.
 */
export function hoursUntil(nextAt: number, now: number, periodHours: number): number {
  const h = (nextAt - now) / HOUR_MS;
  if (!(h > 0)) return periodHours;
  return Math.min(h, periodHours);
}
