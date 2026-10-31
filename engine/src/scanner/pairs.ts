// From every venue's funding rows to the legs worth pairing, and the pairs themselves. Pure: no reads, no clock.

import type { ScanVenueId, VenueId } from '@gimbal/shared';
import type { MarketFunding } from '../venues/venue.ts';
import { grossPerHour } from './costs.ts';

export const DESK_VENUES: readonly VenueId[] = ['hyperliquid', 'phoenix', 'orderly'];

export function isDeskVenue(venue: ScanVenueId): venue is VenueId {
  return (DESK_VENUES as readonly string[]).includes(venue);
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
  readAt: number;                // ms, when this venue's funding was read
  stale: boolean;                // the venue did not answer this scan: this is its last good read
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
    readAt,
    stale,
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
 * 1. one leg per venue and base: a venue listing the same base twice keeps the one with more open interest;
 * 2. a leg without a mark cannot be checked against the others or priced: dropped, except a CEX leg (reference only);
 * 3. a leg whose mark is more than `maxMarkDeviation` from the median mark of the same base on the other venues is
 *    another asset under the same name, or a wrong multiplier: dropped (with two venues that disagree, both go);
 * 4. a leg under the open-interest floor is dropped. Open interest that is unknown (null: Aster, Binance, Bybit
 *    publish none) is not zero: a watch-only leg without it stays as a rate reference, but it cannot pass the floor on
 *    its own (pairLegs never pairs two such legs). A desk leg without it cannot be sized: dropped.
 */
export function filterLegs(legs: readonly ScanLeg[], options: FilterOptions): { kept: ScanLeg[]; dropped: LegDrop[] } {
  const dropped: LegDrop[] = [];
  const drop = (l: ScanLeg, reason: DropReason) => dropped.push({ venue: l.venue, symbol: l.symbol, reason });

  const best = new Map<string, ScanLeg>();
  for (const leg of legs) {
    const key = `${leg.venue}\u0000${leg.base}`;
    const held = best.get(key);
    if (held === undefined) {
      best.set(key, leg);
      continue;
    }
    const better = (leg.oiUsd ?? -1) > (held.oiUsd ?? -1) || ((leg.oiUsd ?? -1) === (held.oiUsd ?? -1) && leg.symbol < held.symbol);
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
    if (leg.markPx === null) {
      if (leg.kind !== 'cex') {
        drop(leg, 'no-mark');
        continue;
      }
    } else {
      const others = (marksByBase.get(leg.base) ?? []).filter((o) => o !== leg).map((o) => o.markPx!);
      if (others.length > 0 && Math.abs(leg.markPx / nearestMedian(others, leg.markPx) - 1) > options.maxMarkDeviation) {
        drop(leg, 'mark-outlier');
        continue;
      }
    }
    if (leg.oiUsd === null) {
      if (leg.kind === 'desk') {
        drop(leg, 'no-oi');
        continue;
      }
    } else if (leg.oiUsd < options.oiFloorUsd) {
      drop(leg, 'under-oi-floor');
      continue;
    }
    kept.push(leg);
  }
  return { kept, dropped };
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
 * passed the floor, and the window would have no capacity to show).
 */
export function pairLegs(legs: readonly ScanLeg[]): Pair[] {
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
        if (long.oiUsd === null && short.oiUsd === null) continue;
        out.push({
          id: windowId(base, long.venue, short.venue),
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
