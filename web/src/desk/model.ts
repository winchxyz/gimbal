// What the Desk screen shows, worked out from `DeskState` and the rest of the stream. Pure functions, so the
// rules in design/HANDOFF.md (Desk) are tested without a browser.
import type { DeskState, JournalEntry, Leg, StrategyConfig, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { VENUE_NAMES } from '../shell/status.ts';
import { amountUsd, clock, proofLinks, unprotectedText } from '../journal/entry.ts';
import { dayMonthTime, hours, pct, plain, usd } from '../windows/format.ts';
import { heldWindow, isEnterable, sortWindows, venuePair } from '../windows/model.ts';
import { perDayOnLegs } from '../windows/decision.ts';
import { price, qty, ratioPct, signedQty, signedUsd } from './format.ts';

/**
 * Where the desk warns and where it starts a rescue, in % of price from liquidation: the owner's own numbers
 * (`StrategyConfig.risk`). The mockup states them under each leg ("Rescue starts at 8%, a warning at 15%").
 * Null until the strategy has been read: the line is left out rather than showing numbers that may be wrong.
 */
export function thresholdText(risk: StrategyConfig['risk'] | null | undefined): string | null {
  if (!risk) return null;
  const at = (n: number) => pct(n, Number.isInteger(n) ? 0 : 1);
  return `Rescue starts at ${at(risk.rescueDistancePct)}, a warning at ${at(risk.watchDistancePct)}.`;
}

// ---------- the two halves ----------

export interface Halves {
  left: Leg | null;
  right: Leg | null;
}

/** The short sits on the left and the long on the right, as in the mockup, whatever order the engine lists them. */
export function placeLegs(legs: readonly Leg[]): Halves {
  return {
    left: legs.find((l) => l.side === 'short') ?? null,
    right: legs.find((l) => l.side === 'long') ?? null,
  };
}

/** `32.6%`, or a dash when the venue gives no liquidation price. */
export const distanceText = (leg: Leg): string => (leg.distanceToLiqPct === null ? '—' : `${leg.distanceToLiqPct.toFixed(1)}%`);

/** The sentence under the distance: which way the price has to move, and to where. */
export function moveText(leg: Leg): string {
  if (leg.distanceToLiqPct === null || leg.liqPx === null) return 'to liquidation · the venue gives no liquidation price right now';
  const verb = leg.side === 'short' ? 'rise' : 'fall';
  return `to liquidation · ${leg.symbol} has to ${verb} ${leg.distanceToLiqPct.toFixed(1)}% to ${price(leg.liqPx, 4)}`;
}

/** `Short 6,040 DOGE` */
export const sizeText = (leg: Leg): string => `${leg.side === 'short' ? 'Short' : 'Long'} ${qty(Math.abs(leg.size))} ${leg.symbol}`;

export interface LegRow {
  key: 'entry' | 'margin' | 'ratio' | 'funding' | 'fees' | 'unsettled' | 'next';
  label: string;
  value: string;
  tone: 'pos' | 'neg' | null;
  /** The phone draws margin and ratio in one row and leaves out the entry; the desktop draws them apart. */
  only: 'desktop' | 'phone' | null;
}

export function legRows(leg: Leg, now: number): LegRow[] {
  return [
    { key: 'entry', label: 'Entry · mark', value: `${price(leg.entry)} · ${price(leg.mark)}`, tone: null, only: 'desktop' },
    { key: 'margin', label: 'Margin', value: `${usd(leg.marginUsd)} · ratio ${ratioPct(leg.marginRatio)}`, tone: null, only: 'phone' },
    { key: 'ratio', label: 'Margin ratio', value: ratioPct(leg.marginRatio), tone: null, only: 'desktop' },
    { key: 'funding', label: 'Funding earned', value: signedUsd(leg.fundingEarnedUsd), tone: moneyTone(leg.fundingEarnedUsd), only: null },
    // `feesUsd` is a cost, so it is negative and shows as −$0.48; a cost has no colour of its own
    { key: 'fees', label: 'Fees paid', value: signedUsd(leg.feesUsd), tone: null, only: null },
    { key: 'unsettled', label: 'Unsettled funding', value: signedUsd(leg.unsettledFundingUsd, 3), tone: null, only: null },
    { key: 'next', label: 'Next funding', value: nextFunding(leg.venue, now), tone: null, only: null },
  ];
}

const moneyTone = (value: number): 'pos' | 'neg' | null => (value > 0 ? 'pos' : value < 0 ? 'neg' : null);

const HOUR_MS = 3_600_000;

/**
 * When funding next reaches the leg, from each venue's schedule (CLAUDE.md, venue facts): Hyperliquid pays on
 * the hour; Phoenix accrues hourly and settles once a day at 00:00 UTC; Orderly's periods are 8 h (4 h on some
 * markets), so it says the period and not a time.
 */
export function nextFunding(venue: VenueId, now: number): string {
  switch (venue) {
    case 'hyperliquid':
      return `in ${Math.ceil((HOUR_MS - (now % HOUR_MS)) / 60_000)} min`;
    case 'phoenix':
      return 'accrues hourly · settles 00:00';
    case 'orderly':
      return 'every 8 h';
  }
}

// ---------- net exposure ----------

export interface Exposure {
  /** `0 DOGE`, `+120 DOGE` */
  text: string;
  /** The legs differ by more than one lot: shown in --watch. */
  drift: boolean;
  explain: string;
}

/**
 * How far the legs may differ and still count as level: one lot (`Leg.lotSize`, base units). Each venue trades in
 * its own lot, so a hedge can only be as exact as the coarser one; an exact zero is not expected. Without legs
 * there is nothing to drift.
 */
export function lotLimit(legs: readonly Leg[]): number {
  return Math.max(0, ...legs.map((l) => l.lotSize));
}

export function exposureOf(desk: Pick<DeskState, 'legs' | 'netDelta'>): Exposure {
  const symbol = desk.legs[0]?.symbol ?? '';
  const limit = lotLimit(desk.legs);
  // `netDelta` is a sum of sizes in base units, so it can be a rounding error above exactly one lot
  const drift = Math.abs(desk.netDelta) > limit * (1 + 1e-9);
  return {
    text: `${signedQty(desk.netDelta)} ${symbol}`.trim(),
    drift,
    explain: drift
      ? `The legs differ by ${qty(Math.abs(desk.netDelta))} ${symbol}, so a ${symbol} price move no longer cancels out. The desk is rebalancing.`
      : `Both legs are the same size, so a ${symbol} price move adds to one and takes the same from the other.`,
  };
}

// ---------- income and payback ----------

/** The average notional of the legs: what "a day on legs this size" is worked out on. */
export function legNotional(legs: readonly Leg[]): number | null {
  if (legs.length === 0) return null;
  return legs.reduce((sum, l) => sum + Math.abs(l.size) * l.mark, 0) / legs.length;
}

export interface DayRate {
  /** Funding rate × notional, net of the amortised costs: the held window's net APR on these legs. */
  perDayUsd: number;
  netAprPct: number;
}

/** "+$0.60 a day · 13.8% a year after costs", or null while no window is held or the legs have no size. */
export function dayRate(held: FundingWindow | null, legs: readonly Leg[]): DayRate | null {
  const notional = legNotional(legs);
  if (!held || notional === null) return null;
  return { perDayUsd: perDayOnLegs(held, notional), netAprPct: held.netAprPct };
}

export interface Payback {
  /** 0 to 99 while costs remain, 100 once they are earned back. */
  pct: number;
  earnedBack: boolean;
  /** Hours until funding covers the rest at today's rate; null when there is no positive rate to divide by. */
  hoursLeft: number | null;
}

/**
 * Funding received ÷ (entry fees + basis), for the held window (design/HANDOFF.md, Payback bar). Fees and a
 * negative price result count as the cost; `pnl` parts are signed contributions, costs below zero.
 */
export function paybackOf(pnl: DeskState['pnl'], perDayUsd: number | null): Payback {
  const costs = Math.max(0, -pnl.feesUsd) + Math.max(0, -pnl.priceUsd);
  if (costs <= 0 || pnl.fundingUsd >= costs) return { pct: 100, earnedBack: true, hoursLeft: 0 };
  const earned = Math.max(0, pnl.fundingUsd);
  const hoursLeft = perDayUsd !== null && perDayUsd > 0 ? (costs - earned) / (perDayUsd / 24) : null;
  return { pct: Math.min(99, Math.round((earned / costs) * 100)), earnedBack: false, hoursLeft };
}

/** `~23 h left`, `~3 d 2 h left` */
export const hoursLeftText = (h: number): string => `~${hours(Math.ceil(h))} left`;

// ---------- profit and loss ----------

export interface PnlRow {
  key: 'funding' | 'fees' | 'price' | 'net';
  label: string;
  value: string;
  tone: 'pos' | 'neg' | null;
}

/**
 * Funding, fees, price and net, as the engine splits them. A cost has no colour of its own; only funding
 * received and the net carry one (positive in --pos, negative in --danger).
 */
export function pnlRows(pnl: DeskState['pnl']): PnlRow[] {
  return [
    { key: 'funding', label: 'Funding', value: signedUsd(pnl.fundingUsd), tone: pnl.fundingUsd > 0 ? 'pos' : null },
    { key: 'fees', label: 'Fees', value: signedUsd(pnl.feesUsd), tone: null },
    { key: 'price', label: 'Price move', value: signedUsd(pnl.priceUsd), tone: null },
    { key: 'net', label: 'Net P&L', value: signedUsd(pnl.netUsd), tone: moneyTone(pnl.netUsd) },
  ];
}

// ---------- latest events ----------

export interface EventRow {
  id: string;
  when: string;
  text: string;
  /** A signed amount for the phone's top line, when the entry carries `numbers.usd`. */
  amountUsd: number | null;
  proof: { label: string; href: string } | null;
  /** The amber line: the order went out without an oracle price band. */
  unprotected: string | null;
}

const SAME_DAY = 86_400_000;

/** `Today 14:00` for an event from today (UTC), else `24 Oct 23:41` */
export function whenLabel(t: number, now: number): string {
  const full = dayMonthTime(t);
  return Math.floor(t / SAME_DAY) === Math.floor(now / SAME_DAY) ? `Today ${clock(t)}` : full;
}

/** The most recent journal entries, newest first: the engine sends them in that order. */
export function latestEvents(journal: readonly JournalEntry[], now: number, limit = 3): EventRow[] {
  return journal.slice(0, limit).map((e) => {
    const links = proofLinks(e.tx);
    const first = links[0];
    const proof = first
      ? { label: links.length === 1 ? 'on-chain ↗' : `${links.length} transactions ↗`, href: first.href }
      : e.why
        ? { label: 'Why ↗', href: '#/journal' }
        : null;
    return { id: e.id, when: whenLabel(e.t, now), text: e.summary, amountUsd: amountUsd(e), proof, unprotected: unprotectedText(e) };
  });
}

// ---------- next best window ----------

export interface NextBest {
  symbol: string;
  pair: string;
  netAprPct: number;
  /** How it compares with the held window, and the rotation rule. */
  text: string;
}

/** The best window open to the desk that is not held, and what the desk will do about it. */
export function nextBest(windows: readonly FundingWindow[], strategy: StrategyConfig | null): NextBest | null {
  const best = sortWindows(windows.filter((w) => isEnterable(w) && !w.held))[0];
  if (!best) return null;
  const held = heldWindow(windows);
  const rule = !strategy
    ? ''
    : strategy.auto
      ? ` The desk rotates when another window beats the held one by ${plain(strategy.rotate.minGainPts, 0)} points for ${strategy.rotate.forHours} hours.`
      : ' Auto is off, so the desk does not rotate by itself.';
  let compare: string;
  if (held) {
    const gap = best.netAprPct - held.netAprPct;
    compare = gap === 0 ? `Level with ${held.symbol}.` : `${plain(Math.abs(gap))} points ${gap < 0 ? 'below' : 'above'} ${held.symbol}.`;
  } else {
    compare = 'Nothing is held.';
  }
  return { symbol: best.symbol, pair: venuePair(best), netAprPct: best.netAprPct, text: `${compare}${rule}` };
}

// ---------- the leg that cannot be read ----------

/** The legs whose venue the engine cannot read: their half is dimmed (design/HANDOFF.md, Desk: Error). */
export const isDown = (leg: Leg, down: readonly VenueId[]): boolean => down.includes(leg.venue);

export const legTitle = (leg: Leg): string => VENUE_NAMES[leg.venue];
