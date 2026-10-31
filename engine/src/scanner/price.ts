// One pair priced as a Window: gross, every cost term, net, breakeven, capacity, and the checks the engine ran.
// Pure: the books and the time come in as arguments.

import type { ContractPolicy, StrategyConfig, VenueId, Window as FundingWindow } from '@gimbal/shared';
import type { Book } from '../venues/venue.ts';
import type { CostParams } from './config.ts';
import {
  HOURS_PER_YEAR, aprPct, basisCostUsd, breakevenHours, fillFeeBps, fundingTimingUsd, hoursUntil, legSlippage, moveCostUsd,
  oneOffAprPct, paymentPeriodHours, rescueAmountUsd, rescueCostUsd, takerFeesUsd,
} from './costs.ts';
import { round } from './history.ts';
import type { Pair, ScanLeg } from './pairs.ts';
import { isDeskVenue } from './pairs.ts';

export interface BookRead {
  book: Book;
  readAt: number;                // ms, when it was read
  stale: boolean;                // the last read failed: this is an older book
}

export interface PricingContext {
  now: number;
  strategy: StrategyConfig;
  costs: CostParams;
  policy: ContractPolicy | null;
  oracleSymbols: ReadonlySet<string>;
  /** The latest book of a desk leg, or null when none was ever read. */
  book(leg: ScanLeg): BookRead | null;
}

/** What one fill of a leg costs, USD: its taker fee plus the slippage of that side on today's book. */
export interface LegFills {
  openUsd: number;
  closeUsd: number;
}

/** The terms behind a window's costs, USD, at strategy.legUsd. null where a term is not priced (watch-only legs). */
export interface CostBreakdown {
  feesUsd: number | null;
  slippageUsd: number | null;
  basisUsd: number | null;
  timingUsd: number;
  rescueUsd: number | null;
}

export interface PricedWindow {
  pair: Pair;
  /** held, switchCostUsd, intervalsAbove and grossApr7dPct are filled by the scanner, which keeps the history. */
  window: FundingWindow;
  costsApr: number;              // the sum of the four cost fields, APR points
  breakdown: CostBreakdown;
  fills: { long: LegFills; short: LegFills } | null;
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
 * Prices one pair at the strategy's leg size. A desk pair (both legs on desk venues) needs both books: without one
 * ever read it is not priced (`no-book`), so a missing book never shows as zero slippage. A watch-only pair is
 * priced from what the scanner can know (gross, basis between marks, funding timing); its fees, slippage and rescue
 * reserve are not priced and its checks say so.
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
    breakdown = {
      feesUsd: takerFeesUsd(L, longBps, shortBps),
      slippageUsd: ls.openUsd + ls.closeUsd + ss.openUsd + ss.closeUsd,
      basisUsd,
      timingUsd,
      rescueUsd: rescueCostUsd(lv, sv, amount, ctx.costs.rescuesPerHold, ctx.costs.reserveAt, ctx.costs.transfers),
    };
    fills = {
      long: { openUsd: (L * longBps) / 1e4 + ls.openUsd, closeUsd: (L * longBps) / 1e4 + ls.closeUsd },
      short: { openUsd: (L * shortBps) / 1e4 + ss.openUsd, closeUsd: (L * shortBps) / 1e4 + ss.closeUsd },
    };
    const thin = [[long, ls], [short, ss]].filter(([, s]) => (s as typeof ls).exhausted) as [ScanLeg, typeof ls][];
    const bookAge = Math.round((ctx.now - Math.min(lb.readAt, sb.readAt)) / 1000);
    checks.push(thin.length > 0
      ? { ok: false, text: `Book too thin: ${thin[0]![0].venue} fills ${usd(thin[0]![1].filledUsd)} of ${usd(L)} within the levels read` }
      : { ok: true, text: `Books ${bookAge} s old: slippage ${usd(breakdown.slippageUsd!)} on 4 fills at ${usd(L)} a leg` });
  } else {
    breakdown = { feesUsd: null, slippageUsd: null, basisUsd, timingUsd, rescueUsd: null };
  }

  const feesPct = round(breakdown.feesUsd === null ? 0 : oneOffAprPct(breakdown.feesUsd, L, hold), 3);
  const slippagePct = round(breakdown.slippageUsd === null ? 0 : oneOffAprPct(breakdown.slippageUsd, L, hold), 3);
  const basisPct = round(oneOffAprPct((basisUsd ?? 0) + timingUsd, L, hold), 3);
  const rescueReservePct = round(breakdown.rescueUsd === null ? 0 : oneOffAprPct(breakdown.rescueUsd, L, hold), 3);
  const costsApr = round(feesPct + slippagePct + basisPct + rescueReservePct, 3);
  const netAprPct = round(grossAprPct - costsApr, 3);

  const oneOffUsd = (breakdown.feesUsd ?? 0) + (breakdown.slippageUsd ?? 0) + (basisUsd ?? 0) + timingUsd;
  const be = breakevenHours(oneOffUsd, [
    schedule(long, -long.ratePerHour * L, ctx.now),
    schedule(short, short.shortRatePerHour * L, ctx.now),
  ]);
  const ois = [long.oiUsd, short.oiUsd].filter((x): x is number => x !== null);
  const depthUsd = ois.length > 0 ? Math.round(Math.min(...ois)) : 0;

  const verdict = pair.desk ? deskVerdict(pair, ctx) : watchVerdict(pair);
  const head: FundingWindow['checks'] = [];
  if (staleVenues.length > 0) {
    head.push({ ok: false, text: `${staleVenues.join(' and ')} did not answer: numbers from ${Math.round((ctx.now - oldest) / 1000)} s ago` });
  }
  const tail: FundingWindow['checks'] = [];
  if (be === null) tail.push({ ok: false, text: 'Does not break even within a year at today\'s rates' });
  if (basisUsd === null) {
    const missing = [long, short].filter((l) => l.markPx === null).map((l) => l.venue);
    tail.push({ ok: false, text: `No mark on ${missing.join(' and ')}: basis not priced` });
  }
  if (pair.desk) {
    const amount = rescueAmountUsd(L, ctx.strategy.risk.watchDistancePct, ctx.strategy.risk.rescueDistancePct);
    tail.push({ ok: true, text: `Rescue of ${usd(amount)} from the reserve costs up to ${usd(breakdown.rescueUsd! / Math.max(1, ctx.costs.rescuesPerHold))} a move` });
  }
  const noOi = [long, short].filter((l) => l.oiUsd === null).map((l) => l.venue);
  tail.push(noOi.length === 0
    ? { ok: true, text: `Capacity ${usd(depthUsd)}: the smaller leg's open interest` }
    : { ok: false, text: `Capacity ${usd(depthUsd)} is one leg's only: ${noOi.join(' and ')} publishes no open interest` });

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
    tradable: verdict.tradable,
    ...(verdict.refused === undefined ? {} : { refused: verdict.refused }),
    held: null,
    checks: [...head, ...verdict.checks, ...checks, ...tail],
    switchCostUsd: null,
    stale: staleVenues.length > 0,
  };
  return { ok: true, priced: { pair, window, costsApr, breakdown, fills } };
}

function schedule(leg: ScanLeg, incomePerHourUsd: number, now: number) {
  const periodHours = paymentPeriodHours(leg.settlement);
  return { incomePerHourUsd, periodHours, firstInHours: hoursUntil(leg.nextAt, now, periodHours) };
}

interface Verdict {
  tradable: boolean;
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
 * Whether the desk could open this pair, and what the contract would say. `tradable` needs both legs on desk venues
 * and a price the contract trusts: an oracle price for the base, or an entry in policy.unpriced (matched on the base
 * or a leg's own symbol). A desk pair without either is not tradable and carries the refusal the contract would
 * give (E_ORACLE_STALE). Without a policy (no desk yet) a tradable pair is refused with E_NO_DESK. With a policy
 * loaded, a tradable pair is refused for a leg outside the policy's venue lists (E_ASSET) or a leg over a cap
 * (E_SIZE: max_notional_usd; unpriced also unpriced_max_notional_usd and max_sz in the venue's own units at its mark).
 */
export function deskVerdict(pair: Pair, ctx: Pick<PricingContext, 'strategy' | 'policy' | 'oracleSymbols'>): Verdict {
  const { long, short, base } = pair;
  const L = ctx.strategy.legUsd;
  const policy = ctx.policy;
  const checks: FundingWindow['checks'] = [];
  const priced = ctx.oracleSymbols.has(base);
  const unpriced = priced ? undefined : policy?.unpriced.find((u) => u.symbol === base || u.symbol === long.symbol || u.symbol === short.symbol);
  if (!priced && unpriced === undefined) {
    const reason = 'no trusted price';
    checks.push({ ok: false, text: `No trusted oracle price for ${base}, and it is not in policy.unpriced` });
    return { tradable: false, refused: { code: 'E_ORACLE_STALE', reason }, checks };
  }
  checks.push(priced
    ? { ok: true, text: `${base} has an oracle price: orders stay inside the price band` }
    : { ok: true, text: `${base} has no oracle price; policy.unpriced allows up to ${unpriced!.max_sz} a leg, with no price protection` });
  if (policy === null) {
    // No desk yet: the contract would answer E_NO_DESK, so the window is shown but cannot be entered.
    checks.push({ ok: false, text: 'No desk policy loaded yet: nothing can be entered' });
    return { tradable: true, refused: { code: 'E_NO_DESK', reason: 'no desk policy loaded yet' }, checks };
  }
  const outside = [long, short].find((l) => !inVenuePolicy(policy, l));
  if (outside !== undefined) {
    checks.push({ ok: false, text: `${outside.symbol} is not in the desk policy on ${outside.venue}` });
    return { tradable: true, refused: { code: 'E_ASSET', reason: `not in policy on ${outside.venue}` }, checks };
  }
  const cap = unpriced === undefined ? policy.max_notional_usd : Math.min(policy.max_notional_usd, policy.unpriced_max_notional_usd);
  if (L > cap) {
    checks.push({ ok: false, text: `A ${usd(L)} leg is over the policy cap of ${usd(cap)}` });
    return { tradable: true, refused: { code: 'E_SIZE', reason: `leg over the ${usd(cap)} cap` }, checks };
  }
  if (unpriced !== undefined) {
    const maxSz = Number(unpriced.max_sz);
    const over = [long, short].find((l) => l.venueMarkPx !== null && L / l.venueMarkPx > maxSz);
    if (over !== undefined) {
      const sz = L / over.venueMarkPx!;
      checks.push({ ok: false, text: `A ${usd(L)} leg is ${sz.toPrecision(4)} ${over.symbol} on ${over.venue}, over max_sz ${unpriced.max_sz}` });
      return { tradable: true, refused: { code: 'E_SIZE', reason: `over max_sz ${unpriced.max_sz}` }, checks };
    }
  }
  checks.push({ ok: true, text: `Passes the desk policy: both markets listed, a ${usd(L)} leg under the ${usd(cap)} cap` });
  return { tradable: true, checks };
}

function watchVerdict(pair: Pair): Verdict {
  const watch = [pair.long, pair.short].filter((l) => !isDeskVenue(l.venue));
  const cex = watch.filter((l) => l.kind === 'cex').map((l) => l.venue);
  const dex = watch.filter((l) => l.kind !== 'cex').map((l) => l.venue);
  const who = [...(dex.length > 0 ? [`${dex.join(' and ')} cannot be traded by the desk`] : []), ...(cex.length > 0 ? [`${cex.join(' and ')} is a CEX, reference only`] : [])];
  return {
    tradable: false,
    checks: [{ ok: false, text: `Watch-only: ${who.join('; ')}. Fees, slippage and the rescue reserve are not priced` }],
  };
}

/**
 * What it costs to rotate from the held window into another at the same leg size, USD: close the held legs that
 * change and open the new ones (taker fee and slippage of each of those fills), plus moving each leg's margin
 * (legUsd / maxLeverage) from a venue the desk leaves to one it enters, by the cheaper pairing. A leg that stays
 * (same venue, market and side) costs nothing.
 */
export function switchCostUsd(
  held: PricedWindow, next: PricedWindow, legUsd: number, maxLeverage: number, costs: CostParams,
): number | null {
  if (held.fills === null || next.fills === null) return null;
  let total = 0;
  for (const side of ['long', 'short'] as const) {
    const a = held.pair[side];
    const b = next.pair[side];
    if (a.venue === b.venue && a.symbol === b.symbol) continue;
    total += held.fills[side].closeUsd + next.fills[side].openUsd;
  }
  const before = [held.pair.long.venue, held.pair.short.venue] as VenueId[];
  const after = [next.pair.long.venue, next.pair.short.venue] as VenueId[];
  const freed = before.filter((v) => !after.includes(v));
  const needed = after.filter((v) => !before.includes(v));
  const margin = legUsd / maxLeverage;
  const move = (from: VenueId, to: VenueId) => moveCostUsd(from, to, margin, costs.transfers);
  if (needed.length === 1) total += move(freed[0]!, needed[0]!);
  else if (needed.length === 2) {
    total += Math.min(move(freed[0]!, needed[0]!) + move(freed[1]!, needed[1]!), move(freed[0]!, needed[1]!) + move(freed[1]!, needed[0]!));
  }
  return round(total, 4);
}
