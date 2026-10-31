// From every venue's funding rows to the legs worth pairing, and the pairs themselves. Pure: no reads, no clock.

import type { ScanVenueId, VenueId } from '@gimbal/shared';
import type { MarketFunding } from '../venues/venue.ts';
import { DESK_VENUE_IDS, isDeskVenueId } from '../venues/venue.ts';
import { grossPerHour } from './costs.ts';

export const DESK_VENUES: readonly VenueId[] = DESK_VENUE_IDS;

export function isDeskVenue(venue: ScanVenueId): venue is VenueId {
  return isDeskVenueId(venue);
}

/** What a venue is to the scanner: a desk venue (VenueReader) or a watch-only one (WatchReader.kind). */
export type LegKind = 'desk' | 'dex' | 'cex';

/** One market of one venue, in the scanner's units. */
export interface ScanLeg {
  venue: ScanVenueId;
  kind: LegKind;
  symbol: string;                // the venue's own symbol (what its book and policy entries use)
  base: string;                  // the cross-venue key
  multiplier: number;            // base units per unit of `symbol`
  ratePerHour: number;           // what a long pays per hour, fraction of notional
  shortRatePerHour: number;      // what a short receives per hour (ratePerHour unless the venue says otherwise)
  settlement: MarketFunding['settlement'];
  nextAt: number;
  venueMarkPx: number | null;    // USD per unit of `symbol`
  markPx: number | null;         // USD per base unit (venueMarkPx ÷ multiplier)
  oiUsd: number | null;          // open interest in USD
  volume24hUsd: number | null;   // traded in the last 24 h, USD; null where the venue does not say
  readAt: number;                // ms, when this venue's funding was read
  stale: boolean;                // the venue did not answer this scan: this is its last good read
  fundingCapPerHour?: number;    // the market's own funding limits from the venue's answer, per hour; absent where
  fundingFloorPerHour?: number;  // it gives none (quality.ts then falls back to the sourced FUNDING_LIMITS)
  /** Set on a leg of the held window that the filters would have dropped: why. The window fails a check for it. */
  heldOnly?: string;
}

export type DropReason = 'bad-rate' | 'duplicate' | 'no-mark' | 'mark-outlier' | 'no-oi' | 'under-oi-floor';

export interface LegDrop {
  venue: ScanVenueId;
  symbol: string;
  reason: DropReason;
}

const finitePositive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** A funding row as a leg; null when its rate is not a finite number (such a row cannot be priced at all). */
export function toLeg(f: MarketFunding, kind: LegKind, readAt: number, stale: boolean): ScanLeg | null {
  if (!Number.isFinite(f.ratePerHour)) return null;
  const multiplier = f.multiplier ?? 1;
  if (!(multiplier > 0) || !Number.isFinite(multiplier)) return null;
  const short = f.shortRatePerHour;
  const venueMarkPx = finitePositive(f.markPx) ? f.markPx : null;
  const oi = typeof f.openInterest === 'number' && Number.isFinite(f.openInterest) && f.openInterest >= 0 ? f.openInterest : null;
  return {
    venue: f.venue,
    kind,
    symbol: f.symbol,
    base: f.base ?? f.symbol,
    multiplier,
    ratePerHour: f.ratePerHour,
    shortRatePerHour: typeof short === 'number' && Number.isFinite(short) ? short : f.ratePerHour,
    settlement: f.settlement,
    nextAt: f.nextAt,
    venueMarkPx,
    markPx: venueMarkPx === null ? null : venueMarkPx / multiplier,
    // Open interest is counted in units of the venue's own symbol (kPEPE units for kPEPE), so its USD value is
    // OI × the venue's own mark; the multiplier plays no part.
    oiUsd: oi === null || venueMarkPx === null ? null : oi * venueMarkPx,
    volume24hUsd: typeof f.volume24hUsd === 'number' && Number.isFinite(f.volume24hUsd) && f.volume24hUsd >= 0 ? f.volume24hUsd : null,
    readAt,
    stale,
    // A cap at or below zero, or a floor at or above it, would put a quiet market "at the cap": not a limit.
    ...(finitePositive(f.fundingCapPerHour) ? { fundingCapPerHour: f.fundingCapPerHour } : {}),
    ...(typeof f.fundingFloorPerHour === 'number' && Number.isFinite(f.fundingFloorPerHour) && f.fundingFloorPerHour < 0
      ? { fundingFloorPerHour: f.fundingFloorPerHour } : {}),
  };
}

/**
 * The median of `xs` that is nearest `x`. With an even count every value between the two middle ones is a median;
 * taking the one nearest the leg means that with three venues, one wrong mark cannot pull a good leg's reference
 * halfway toward itself (marks 100, 101, 130: the 100 leg is checked against 101, not 115.5).
 */
function nearestMedian(xs: readonly number[], x: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  if (s.length % 2 === 1) return s[mid]!;
  const lo = s[mid - 1]!;
  const hi = s[mid]!;
  return Math.abs(x - lo) <= Math.abs(x - hi) ? lo : hi;
}

export interface FilterOptions {
  oiFloorUsd: number;
  maxMarkDeviation: number;      // fraction: 0.1 = 10 %
}

/**
 * The legs worth pairing, in four steps:
 * 1. one leg per venue and base: a venue listing the same base twice keeps the one whose mark agrees with the other
 *    venues' (two assets under one name: MEXC's C_USDT is the Chainbase coin, its CSTOCK_USDT Citigroup), else the
 *    one with more open interest;
 * 2. a leg without a mark cannot be checked against the others or priced: dropped, except a CEX leg (reference only);
 * 3. a leg whose mark is more than `maxMarkDeviation` from the median mark of the same base on the other venues is
 *    another asset under the same name, or a wrong multiplier: dropped (with two venues that disagree, both go);
 * 4. a leg under the open-interest floor is dropped. Open interest that is unknown (null: Aster, Binance, Bybit
 *    publish none) is not zero: a watch-only leg without it stays as a rate reference, but it cannot pass the floor on
 *    its own (pairLegs never pairs two such legs). A desk leg without it cannot be sized: dropped.
 * A leg in `exempt` (`venue|symbol`: the legs of the window the desk holds) is never dropped by steps 2 to 4: the desk
 * must still see what it holds and what leaving costs. It is kept with `heldOnly` saying what it failed, and wins a
 * duplicate.
 */
export function filterLegs(
  legs: readonly ScanLeg[], options: FilterOptions, exempt: ReadonlySet<string> = new Set(),
): { kept: ScanLeg[]; dropped: LegDrop[] } {
  const dropped: LegDrop[] = [];
  const drop = (l: ScanLeg, reason: DropReason) => dropped.push({ venue: l.venue, symbol: l.symbol, reason });
  const isExempt = (l: ScanLeg) => exempt.has(`${l.venue}|${l.symbol}`);

  const allMarks = new Map<string, ScanLeg[]>();
  for (const leg of legs) {
    if (leg.markPx === null) continue;
    const list = allMarks.get(leg.base);
    if (list === undefined) allMarks.set(leg.base, [leg]);
    else list.push(leg);
  }
  /** Whether a leg's mark agrees with the other venues' marks of its base; false without a mark or other venues. */
  const agreesElsewhere = (l: ScanLeg): boolean => {
    if (l.markPx === null) return false;
    const others = (allMarks.get(l.base) ?? []).filter((o) => o.venue !== l.venue).map((o) => o.markPx!);
    return others.length > 0 && Math.abs(l.markPx / nearestMedian(others, l.markPx) - 1) <= options.maxMarkDeviation;
  };

  const best = new Map<string, ScanLeg>();
  for (const leg of legs) {
    const key = `${leg.venue}\u0000${leg.base}`;
    const held = best.get(key);
    if (held === undefined) {
      best.set(key, leg);
      continue;
    }
    const byOi = (leg.oiUsd ?? -1) > (held.oiUsd ?? -1) || ((leg.oiUsd ?? -1) === (held.oiUsd ?? -1) && leg.symbol < held.symbol);
    const byMark = agreesElsewhere(leg) !== agreesElsewhere(held) ? agreesElsewhere(leg) : byOi;
    const better = isExempt(leg) !== isExempt(held) ? isExempt(leg) : byMark;
    if (better) {
      drop(held, 'duplicate');
      best.set(key, leg);
    } else {
      drop(leg, 'duplicate');
    }
  }
  const unique = [...best.values()];

  const marksByBase = new Map<string, ScanLeg[]>();
  for (const leg of unique) {
    if (leg.markPx === null) continue;
    const list = marksByBase.get(leg.base);
    if (list === undefined) marksByBase.set(leg.base, [leg]);
    else list.push(leg);
  }

  const kept: ScanLeg[] = [];
  for (const leg of unique) {
    const failed = failedFilter(leg, marksByBase.get(leg.base) ?? [], options);
    if (failed === null) kept.push(leg);
    else if (isExempt(leg)) kept.push({ ...leg, heldOnly: failed.why });
    else drop(leg, failed.reason);
  }
  return { kept, dropped };
}

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** The first of steps 2 to 4 a leg fails, with a line for its check; null when it passes them all. */
function failedFilter(leg: ScanLeg, marked: readonly ScanLeg[], options: FilterOptions): { reason: DropReason; why: string } | null {
  if (leg.markPx === null) {
    if (leg.kind !== 'cex') return { reason: 'no-mark', why: 'has no mark' };
  } else {
    const others = marked.filter((o) => o !== leg).map((o) => o.markPx!);
    if (others.length > 0) {
      const ref = nearestMedian(others, leg.markPx);
      const off = leg.markPx / ref - 1;
      if (Math.abs(off) > options.maxMarkDeviation) {
        const px = (n: number) => String(Number(n.toPrecision(6)));
        return { reason: 'mark-outlier', why: `marks ${px(leg.markPx)}, ${(off * 100).toFixed(1)} % from the other venues' ${px(ref)}` };
      }
    }
  }
  if (leg.oiUsd === null) {
    if (leg.kind === 'desk') return { reason: 'no-oi', why: 'publishes no open interest' };
  } else if (leg.oiUsd < options.oiFloorUsd) {
    return { reason: 'under-oi-floor', why: `has ${money(leg.oiUsd)} of open interest, under the ${money(options.oiFloorUsd)} floor` };
  }
  return null;
}

/** The legs of the held window among `legs`, as `venue|symbol` keys for filterLegs' `exempt`. */
export function heldLegKeys(legs: readonly ScanLeg[], heldId: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (heldId === null || heldId === undefined) return out;
  const byBase = new Map<string, ScanLeg[]>();
  for (const leg of legs) {
    // Only bases that can start the id are worth pairing up.
    if (!heldId.startsWith(`${leg.base.toLowerCase()}-`)) continue;
    const list = byBase.get(leg.base);
    if (list === undefined) byBase.set(leg.base, [leg]);
    else list.push(leg);
  }
  for (const [base, list] of byBase) {
    for (const a of list) {
      for (const b of list) {
        if (a.venue !== b.venue && windowId(base, a.venue, b.venue) === heldId) {
          out.add(`${a.venue}|${a.symbol}`);
          out.add(`${b.venue}|${b.symbol}`);
        }
      }
    }
  }
  return out;
}

export interface Pair {
  id: string;
  base: string;
  long: ScanLeg;
  short: ScanLeg;
  grossPerHour: number;          // fraction of one leg's notional: short receives − long pays
  desk: boolean;                 // both legs on desk venues
}

export function windowId(base: string, longVenue: ScanVenueId, shortVenue: ScanVenueId): string {
  return `${base}-${longVenue}-${shortVenue}`.toLowerCase();
}

/**
 * Every ordered pair of legs of the same base on two different venues, both directions, except CEX against CEX
 * (reference only on both sides: nothing to rank) and two legs whose open interest are both unknown (no leg has
 * passed the floor, and the window would have no capacity to show). A leg kept only for the held window (`heldOnly`)
 * makes no pair but that one.
 */
export function pairLegs(legs: readonly ScanLeg[], heldId: string | null = null): Pair[] {
  const byBase = new Map<string, ScanLeg[]>();
  for (const leg of legs) {
    const list = byBase.get(leg.base);
    if (list === undefined) byBase.set(leg.base, [leg]);
    else list.push(leg);
  }
  const out: Pair[] = [];
  for (const [base, list] of byBase) {
    for (const long of list) {
      for (const short of list) {
        if (long.venue === short.venue) continue;
        if (long.kind === 'cex' && short.kind === 'cex') continue;
        const id = windowId(base, long.venue, short.venue);
        if ((long.heldOnly !== undefined || short.heldOnly !== undefined) && id !== heldId) continue;
        if (long.oiUsd === null && short.oiUsd === null && id !== heldId) continue;
        out.push({
          id,
          base,
          long,
          short,
          grossPerHour: grossPerHour(long.ratePerHour, short.shortRatePerHour),
          desk: long.kind === 'desk' && short.kind === 'desk',
        });
      }
    }
  }
  return out;
}
