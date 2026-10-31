// One pair priced as a Window: gross, every cost term, net, breakeven, capacity, and the checks the engine ran.
// Pure: the books, the oracle prices and the time come in as arguments.

import type { ContractPolicy, StrategyConfig, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { venueName, venueNames } from '../venues/names.ts';
import type { Book } from '../venues/venue.ts';
import type { CostParams } from './config.ts';
import {
  HOURS_PER_YEAR, aprPct, basisCostUsd, breakevenHours, fillFeeBps, fundingTimingUsd, hoursUntil, legSlippage,
  marginRoundTripUsd, oneOffAprPct, paymentPeriodHours, rescueAmountUsd, rescueCostUsd, takerFeesUsd,
} from './costs.ts';
import type { LegSlippage } from './costs.ts';
import { round } from './history.ts';
import type { Pair, ScanLeg } from './pairs.ts';
import { isDeskVenue } from './pairs.ts';

export interface BookRead {
  book: Book;
  readAt: number;                // ms, when the read answered
  stale: boolean;                // the last read failed: this is an older book
}

/** An oracle price as the contract stores it for one policy symbol: USD per unit of that symbol, and when. */
export interface OraclePrice {
  px: number;
  at: number;                    // ms
}

/**
 * Where the scanner learns the contract's stored oracle prices. The contract refuses a priced order unless its price
 * for that symbol is at most policy.oracle_max_age_s old, so a leg passes only on a price and its time from here.
 * The engine's contract client fills this in; until then there is no source and every priced desk leg is refused
 * E_ORACLE_STALE, which is what the contract would answer.
 */
export interface OracleSource {
  price(venue: VenueId, symbol: string): OraclePrice | null;
}

/**
 * How far ahead of the engine's clock an oracle price may be dated and still count (NEAR block time against this
 * machine's clock). Beyond it the price is counted as stale: a future date would otherwise read as 0 s old.
 */
export const ORACLE_MAX_SKEW_MS = 5_000;

export interface PricingContext {
  now: number;
  strategy: StrategyConfig;
  costs: CostParams;
  policy: ContractPolicy | null;
  oracle: OracleSource | null;
  /** The latest book of a desk leg, or null when none was ever read. */
  book(leg: ScanLeg): BookRead | null;
  /** Desk venues that already hold the desk's margin: entering there moves nothing in or out. Default: none. */
  marginHeldAt?: ReadonlySet<VenueId>;
  /** The quality findings of a watch-only pair's legs (quality.ts), as failing checks. Default: none. */
  quality?: (pair: Pair) => FundingWindow['checks'];
}

/** What one fill of a leg costs, USD: its taker fee plus the slippage of that side on today's book. */
export interface LegFills {
  openUsd: number;
  closeUsd: number;
}

/** The terms behind a window's costs, USD, at strategy.legUsd. null where a term is not priced (watch-only legs). */
export interface CostBreakdown {
  feesUsd: number | null;        // taker fees on the 4 fills
  transferUsd: number | null;    // both legs' margin moved in and back out (1Click and venue fees); counted in feesPct
  slippageUsd: number | null;    // of what the books could fill: a thin book fails a check instead
  basisUsd: number | null;
  timingUsd: number;             // funding lost to 4 h / 8 h payment schedules; counted in basisPct
  rescueUsd: number | null;
}

export interface PricedWindow {
  pair: Pair;
  /** held, switchCostUsd, intervalsAbove and grossApr7dPct are filled by the scanner, which keeps the history. */
  window: FundingWindow;
  costsApr: number;              // the sum of the four cost fields, APR points
  breakdown: CostBreakdown;
  fills: { long: LegFills; short: LegFills } | null;
  /** A watch-only window with a quality finding: it ranks after the clean watch windows. */
  flagged: boolean;
}

export type PriceResult = { ok: true; priced: PricedWindow } | { ok: false; reason: 'no-book' | 'empty-book'; venue: VenueId };

/** Money for a check line: cents under $100, whole dollars to $10k, then k and M. */
export function usd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `$${Math.round(n / 1e3)}k`;
  if (a >= 100) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Whether the desk could enter this window now: both legs on desk venues, nothing the contract would refuse, numbers
 * from this scan, every engine check passed, and no NEAR AI veto.
 */
export function isEnterable(w: FundingWindow): boolean {
  return w.tradable && w.refused === undefined && !w.stale && w.checks.every((c) => c.ok) && w.veto?.verdict !== 'veto';
}

/**
 * Prices one pair at the strategy's leg size. A desk pair (both legs on desk venues) needs both books: without one
 * ever read it is not priced (`no-book`), so a missing book never shows as zero slippage. A book too thin for the leg
 * prices the slippage of what it fills and fails a check, so the window is never enterable or ranked as if filled.
 * A watch-only pair is priced from what the scanner can know (gross, basis between marks, funding timing); its fees,
 * slippage and rescue reserve are not priced and its checks say so, followed by its legs' quality findings.
 */
export function priceWindow(pair: Pair, ctx: PricingContext): PriceResult {
  const { long, short } = pair;
  const L = ctx.strategy.legUsd;
  const hold = ctx.costs.holdHours;
  const grossAprPct = round(aprPct(pair.grossPerHour), 3);

  const timingUsd = fundingTimingUsd(-long.ratePerHour * L, paymentPeriodHours(long.settlement), hold)
    + fundingTimingUsd(short.shortRatePerHour * L, paymentPeriodHours(short.settlement), hold);
  const basisUsd = long.markPx !== null && short.markPx !== null ? basisCostUsd(long.markPx, short.markPx, L) : null;

  let breakdown: CostBreakdown;
  let fills: PricedWindow['fills'] = null;
  const checks: FundingWindow['checks'] = [];
  const staleVenues = [long, short].filter((l) => l.stale).map((l) => l.venue);
  let oldest = Math.min(long.readAt, short.readAt);

  if (pair.desk) {
    const lv = long.venue as VenueId;
    const sv = short.venue as VenueId;
    const lb = ctx.book(long);
    const sb = ctx.book(short);
    if (lb === null) return { ok: false, reason: 'no-book', venue: lv };
    if (sb === null) return { ok: false, reason: 'no-book', venue: sv };
    const ls = legSlippage(lb.book, L, 'long');
    const ss = legSlippage(sb.book, L, 'short');
    if (ls === null) return { ok: false, reason: 'empty-book', venue: lv };
    if (ss === null) return { ok: false, reason: 'empty-book', venue: sv };
    for (const [leg, b] of [[long, lb], [short, sb]] as const) {
      if (b.stale) {
        if (!staleVenues.includes(leg.venue)) staleVenues.push(leg.venue);
        oldest = Math.min(oldest, b.readAt);
      }
    }
    const longBps = fillFeeBps(ctx.costs.fees[lv]);
    const shortBps = fillFeeBps(ctx.costs.fees[sv]);
    const amount = rescueAmountUsd(L, ctx.strategy.risk.watchDistancePct, ctx.strategy.risk.rescueDistancePct);
    const margin = L / ctx.strategy.maxLeverage;
    // The desk keeps its money in the reserve between holds, so entering means moving each leg's margin onto its
    // venue and leaving means moving it back: both trips are part of what the window costs.
    const moving = [lv, sv].filter((v) => !(ctx.marginHeldAt?.has(v) ?? false));
    const transferUsd = moving.reduce((s, v) => s + marginRoundTripUsd(v, margin, ctx.costs.reserveAt, ctx.costs.transfers), 0);
    breakdown = {
      feesUsd: takerFeesUsd(L, longBps, shortBps),
      transferUsd,
      slippageUsd: ls.openUsd + ls.closeUsd + ss.openUsd + ss.closeUsd,
      basisUsd,
      timingUsd,
      rescueUsd: rescueCostUsd(lv, sv, amount, ctx.costs.rescuesPerHold, ctx.costs.reserveAt, ctx.costs.transfers),
    };
    fills = {
      long: { openUsd: (L * longBps) / 1e4 + ls.openUsd, closeUsd: (L * longBps) / 1e4 + ls.closeUsd },
      short: { openUsd: (L * shortBps) / 1e4 + ss.openUsd, closeUsd: (L * shortBps) / 1e4 + ss.closeUsd },
    };
    const thin = ([[long, ls, lb], [short, ss, sb]] as [ScanLeg, LegSlippage, BookRead][]).filter(([, s]) => s.exhausted);
    for (const [leg, s, b] of thin) {
      const levels = Math.min(b.book.bids.length, b.book.asks.length);
      checks.push({ ok: false, text: `The ${venueName(leg.venue)} book fills only ${usd(s.filledUsd)} of ${usd(L)} within the ${levels} level${levels === 1 ? '' : 's'} read: slippage counts the filled part only` });
    }
    if (thin.length === 0) {
      const bookAge = Math.max(0, Math.round((ctx.now - Math.min(lb.readAt, sb.readAt)) / 1000));
      checks.push({ ok: true, text: `Books ${bookAge} s old: slippage ${usd(breakdown.slippageUsd!)} on 4 fills at ${usd(L)} a leg` });
    }
    checks.push(moving.length === 0
      ? { ok: true, text: 'Margin already sits on both venues: nothing to move in or out' }
      : { ok: true, text: `Moving ${usd(margin)} of margin a leg onto ${venueNames(moving)} and back costs ${usd(transferUsd)}` });
  } else {
    breakdown = { feesUsd: null, transferUsd: null, slippageUsd: null, basisUsd, timingUsd, rescueUsd: null };
  }

  const feesPct = round(breakdown.feesUsd === null ? 0 : oneOffAprPct(breakdown.feesUsd + (breakdown.transferUsd ?? 0), L, hold), 3);
  const slippagePct = round(breakdown.slippageUsd === null ? 0 : oneOffAprPct(breakdown.slippageUsd, L, hold), 3);
  const basisPct = round(oneOffAprPct((basisUsd ?? 0) + timingUsd, L, hold), 3);
  const rescueReservePct = round(breakdown.rescueUsd === null ? 0 : oneOffAprPct(breakdown.rescueUsd, L, hold), 3);
  const costsApr = round(feesPct + slippagePct + basisPct + rescueReservePct, 3);
  const netAprPct = round(grossAprPct - costsApr, 3);

  const oneOffUsd = (breakdown.feesUsd ?? 0) + (breakdown.transferUsd ?? 0) + (breakdown.slippageUsd ?? 0) + (basisUsd ?? 0) + timingUsd;
  const be = breakevenHours(oneOffUsd, [
    schedule(long, -long.ratePerHour * L, ctx.now),
    schedule(short, short.shortRatePerHour * L, ctx.now),
  ]);
  const ois = [long.oiUsd, short.oiUsd].filter((x): x is number => x !== null);
  const depthUsd = ois.length > 0 ? Math.round(Math.min(...ois)) : 0;

  const verdict = pair.desk ? deskVerdict(pair, ctx) : watchVerdict(pair);
  const quality = pair.desk ? [] : (ctx.quality?.(pair) ?? []);
  const head: FundingWindow['checks'] = [];
  if (staleVenues.length > 0) {
    head.push({ ok: false, text: `${venueNames(staleVenues)} did not answer: numbers from ${Math.max(0, Math.round((ctx.now - oldest) / 1000))} s ago` });
  }
  const tail: FundingWindow['checks'] = [];
  for (const leg of [long, short]) {
    if (leg.heldOnly !== undefined) tail.push({ ok: false, text: `Kept only because the desk holds it: ${venueName(leg.venue)} ${leg.symbol} ${leg.heldOnly}` });
  }
  if (be === null) tail.push({ ok: false, text: 'Does not break even within a year at today\'s rates' });
  if (basisUsd === null) {
    const missing = [long, short].filter((l) => l.markPx === null).map((l) => l.venue);
    tail.push({ ok: false, text: `No mark on ${venueNames(missing)}: basis not priced` });
  }
  if (pair.desk) {
    const amount = rescueAmountUsd(L, ctx.strategy.risk.watchDistancePct, ctx.strategy.risk.rescueDistancePct);
    tail.push({ ok: true, text: `Rescue of ${usd(amount)} from the reserve costs up to ${usd(breakdown.rescueUsd! / Math.max(1, ctx.costs.rescuesPerHold))} a move` });
  }
  const noOi = [long, short].filter((l) => l.oiUsd === null).map((l) => l.venue);
  tail.push(noOi.length === 0
    ? { ok: true, text: `Capacity ${usd(depthUsd)}: the smaller leg's open interest` }
    : { ok: false, text: `Capacity ${usd(depthUsd)} is one leg's only: ${venueNames(noOi)} publishes no open interest` });

  const window: FundingWindow = {
    id: pair.id,
    symbol: pair.base,
    longVenue: long.venue,
    shortVenue: short.venue,
    grossAprPct,
    grossApr7dPct: null,
    costs: { feesPct, slippagePct, basisPct, rescueReservePct },
    netAprPct,
    usdPerDayPer1k: round((netAprPct / 100 / 365) * 1000, 4),
    breakevenHours: be === null ? HOURS_PER_YEAR : round(be, 1),
    depthUsd,
    intervalsAbove: 0,
    updatedAt: oldest,
    // Structural only: both legs on desk venues. What the contract would refuse goes in `refused`.
    tradable: pair.desk,
    ...(verdict.refused === undefined ? {} : { refused: verdict.refused }),
    held: null,
    checks: [...head, ...verdict.checks, ...quality, ...checks, ...tail],
    switchCostUsd: null,
    stale: staleVenues.length > 0,
  };
  return { ok: true, priced: { pair, window, costsApr, breakdown, fills, flagged: quality.length > 0 } };
}

function schedule(leg: ScanLeg, incomePerHourUsd: number, now: number) {
  const periodHours = paymentPeriodHours(leg.settlement);
  return { incomePerHourUsd, periodHours, firstInHours: hoursUntil(leg.nextAt, now, periodHours) };
}

interface Verdict {
  refused?: { code: string; reason: string };
  checks: FundingWindow['checks'];
}

function inVenuePolicy(policy: ContractPolicy, leg: ScanLeg): boolean {
  switch (leg.venue as VenueId) {
    case 'hyperliquid': return policy.hl_assets.some((a) => a.symbol === leg.symbol);
    case 'phoenix': return policy.phoenix_markets.some((m) => m.symbol === leg.symbol);
    case 'orderly': return policy.orderly_symbols.includes(leg.symbol);
  }
}

/**
 * What the contract would answer to a desk pair's orders, leg by leg, each on its own venue symbol. The first
 * refusal found is the one reported; every leg still gets its check line.
 * - no policy (no desk yet): E_NO_DESK;
 * - a leg outside the policy's list for its venue: E_ASSET;
 * - a leg in policy.unpriced needs no oracle, but its size in the venue's own units (legUsd at the venue mark) must
 *   fit its own max_sz, and its notional the unpriced cap (E_SIZE; a leg without a mark cannot be sized: E_SIZE);
 * - any other leg needs an oracle price no older than policy.oracle_max_age_s, and dated no more than
 *   ORACLE_MAX_SKEW_MS ahead of now (E_ORACLE_STALE);
 * - the notional the contract values, up to legUsd × (1 + price_band_bps / 10⁴) at a limit price inside the band,
 *   must fit max_notional_usd, or the unpriced cap when a leg is unpriced (E_SIZE).
 */
export function deskVerdict(pair: Pair, ctx: Pick<PricingContext, 'strategy' | 'policy' | 'oracle' | 'now'>): Verdict {
  const L = ctx.strategy.legUsd;
  const policy = ctx.policy;
  const checks: FundingWindow['checks'] = [];
  if (policy === null) {
    checks.push({ ok: false, text: 'No desk policy loaded yet: nothing can be entered' });
    return { refused: { code: 'E_NO_DESK', reason: 'no desk policy loaded yet' }, checks };
  }
  let refused: Verdict['refused'];
  const refuse = (code: string, reason: string) => {
    refused ??= { code, reason };
  };
  const legs = [pair.long, pair.short];
  for (const leg of legs) {
    if (!inVenuePolicy(policy, leg)) {
      checks.push({ ok: false, text: `${leg.symbol} is not in the desk policy on ${venueName(leg.venue)}` });
      refuse('E_ASSET', `${leg.symbol} not in policy on ${leg.venue}`);
    }
  }
  if (refused !== undefined) return { refused, checks };

  const atBand = L * (1 + policy.price_band_bps / 1e4);
  let cap = policy.max_notional_usd;
  for (const leg of legs) {
    // Checks are read by the owner (venue names); refusal reasons are logged and matched (venue ids).
    const where = `${leg.symbol} on ${venueName(leg.venue)}`;
    const whereId = `${leg.symbol} on ${leg.venue}`;
    const unpriced = policy.unpriced.find((u) => u.symbol === leg.symbol);
    if (unpriced !== undefined) {
      cap = Math.min(cap, policy.unpriced_max_notional_usd);
      if (leg.venueMarkPx === null) {
        checks.push({ ok: false, text: `${where} is unpriced and has no mark: its size cannot be checked against max_sz ${unpriced.max_sz}` });
        refuse('E_SIZE', `no mark to size ${whereId}`);
        continue;
      }
      // The order's size in the venue's own units (kPEPE, PERP_1000PEPE_USDC), which is what max_sz counts.
      const sz = L / leg.venueMarkPx;
      const size = `${Number(sz.toPrecision(6))} ${leg.symbol}`;
      if (sz > Number(unpriced.max_sz)) {
        checks.push({ ok: false, text: `${where} is unpriced: a ${usd(L)} leg is ${size}, over its max_sz ${unpriced.max_sz}` });
        refuse('E_SIZE', `${whereId} over max_sz ${unpriced.max_sz}`);
      } else {
        checks.push({ ok: true, text: `${where} is unpriced, no price protection: a ${usd(L)} leg is ${size}, within its max_sz ${unpriced.max_sz}` });
      }
      continue;
    }
    const raw = ctx.oracle?.price(leg.venue as VenueId, leg.symbol) ?? null;
    const o = raw !== null && Number.isFinite(raw.px) && raw.px > 0 && Number.isFinite(raw.at) ? raw : null;
    const age = o === null ? null : Math.max(0, (ctx.now - o.at) / 1000);
    if (o === null || age === null) {
      checks.push({ ok: false, text: `No oracle price for ${where}: the contract refuses its orders` });
      refuse('E_ORACLE_STALE', `no oracle price for ${whereId}`);
    } else if (o.at > ctx.now + ORACLE_MAX_SKEW_MS) {
      // A price dated ahead of now would count as 0 s old however old it really is: one clock is wrong, and which
      // one cannot be told from here.
      const ahead = Math.round((o.at - ctx.now) / 1000);
      checks.push({ ok: false, text: `The oracle price for ${where} is dated ${ahead} s ahead of the engine's clock, past the ${ORACLE_MAX_SKEW_MS / 1000} s skew allowed: counted as stale` });
      refuse('E_ORACLE_STALE', `oracle price for ${whereId} dated ${ahead} s ahead`);
    } else if (age > policy.oracle_max_age_s) {
      checks.push({ ok: false, text: `The oracle price for ${where} is ${Math.round(age)} s old, over the ${policy.oracle_max_age_s} s limit: the contract refuses its orders` });
      refuse('E_ORACLE_STALE', `oracle price for ${whereId} ${Math.round(age)} s old`);
    } else {
      checks.push({ ok: true, text: `The oracle price for ${where} is ${Math.round(age)} s old, within the ${policy.oracle_max_age_s} s limit` });
    }
  }
  if (atBand > cap) {
    checks.push({ ok: false, text: `A ${usd(L)} leg is up to ${usd(atBand)} at the edge of the price band, over the ${usd(cap)} cap` });
    refuse('E_SIZE', `leg over the ${usd(cap)} cap`);
  } else {
    checks.push({ ok: true, text: `A ${usd(L)} leg (up to ${usd(atBand)} at the edge of the price band) fits the ${usd(cap)} cap` });
  }
  return refused === undefined ? { checks } : { refused, checks };
}

function watchVerdict(pair: Pair): Verdict {
  const watch = [pair.long, pair.short].filter((l) => !isDeskVenue(l.venue));
  const cex = watch.filter((l) => l.kind === 'cex').map((l) => l.venue);
  const dex = watch.filter((l) => l.kind !== 'cex').map((l) => l.venue);
  const who = [...(dex.length > 0 ? [`${venueNames(dex)} cannot be traded by the desk`] : []), ...(cex.length > 0 ? [`${venueNames(cex)} is a CEX, reference only`] : [])];
  return { checks: [{ ok: false, text: `Watch-only: ${who.join('; ')}. Fees, slippage and the rescue reserve are not priced` }] };
}

/**
 * What it costs to rotate from the held window into another at the same leg size, USD: close the held legs that
 * change and open the new ones (taker fee and slippage of each of those fills). A leg that stays (same venue, market
 * and side) costs nothing.
 *
 * Margin moves are not in it. Each window's feesPct already counts moving its margin onto its venues and back
 * (none where marginHeldAt says the desk's margin already sits), so a rotation judged on the next window's net APR
 * plus this cost would pay for the same move twice. Moving margin from the venue the desk leaves rather than from
 * the reserve costs about the same, and the held window's own trip back is saved.
 */
export function switchCostUsd(held: PricedWindow, next: PricedWindow): number | null {
  if (held.fills === null || next.fills === null) return null;
  let total = 0;
  for (const side of ['long', 'short'] as const) {
    const a = held.pair[side];
    const b = next.pair[side];
    if (a.venue === b.venue && a.symbol === b.symbol) continue;
    total += held.fills[side].closeUsd + next.fills[side].openUsd;
  }
  return round(total, 4);
}
