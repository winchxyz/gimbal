// Small builders for the scanner's tests: funding rows, legs, books and a fixed strategy. Not used outside tests.

import type { ScanVenueId, VenueId } from '@gimbal/shared';
import type { Book, MarketFunding } from '../venues/venue.ts';
import type { LegKind, ScanLeg } from './pairs.ts';
import { toLeg } from './pairs.ts';

export const T0 = Date.UTC(2026, 9, 31, 10, 30);        // 10:30 UTC: the next hourly payment is 0.5 h away

export function row(venue: ScanVenueId, symbol: string, fields: Partial<MarketFunding> = {}): MarketFunding {
  return {
    venue, symbol, ratePerHour: 0.00001, settlement: 'hourly', nextAt: Date.UTC(2026, 9, 31, 11),
    markPx: 100, oraclePx: 100, openInterest: 50_000, volume24hUsd: null, ...fields,
  };
}

export function leg(venue: ScanVenueId, symbol: string, fields: Partial<MarketFunding> = {}, kind?: LegKind, readAt = T0, stale = false): ScanLeg {
  const k: LegKind = kind ?? (['hyperliquid', 'phoenix', 'orderly'].includes(venue) ? 'desk' : 'dex');
  const l = toLeg(row(venue, symbol, fields), k, readAt, stale);
  if (l === null) throw new Error(`test leg ${venue} ${symbol} is not valid`);
  return l;
}

/** A book one level deep on each side: bid at mid × (1 − halfSpread), ask at mid × (1 + halfSpread), `units` each. */
export function book(venue: VenueId, symbol: string, bid: number, ask: number, units = 1000): Book {
  return { venue, symbol, time: T0, bids: [{ px: bid, sz: units }], asks: [{ px: ask, sz: units }] };
}
