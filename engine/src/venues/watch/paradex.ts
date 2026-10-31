// Paradex: `markets/summary` for all perps in one call (`asset_kind=PERP` keeps the ~8,900 option rows out).
// Funding accrues continuously; the rate is quoted per 8 h funding period.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, collect, list, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { paradexRatePerHour } from './units.ts';

export const PARADEX_API_URL = 'https://api.prod.paradex.trade/v1';
export const PARADEX_SUMMARY_URL = `${PARADEX_API_URL}/markets/summary?market=ALL&asset_kind=PERP`;

export class ParadexReader implements WatchReader {
  readonly id = 'paradex';
  readonly kind = 'dex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    return parseParadex(await this.#http.get(PARADEX_SUMMARY_URL), this.#http.clock.now());
  }
}

interface ParadexSummary {
  symbol: string; mark_price: string; underlying_price: string; funding_rate: string; funding_interval_minutes: number;
  open_interest_long?: string; open_interest?: string; volume_24h: string;
}

/**
 * `open_interest` counts both sides (twice `open_interest_long` on 2026-10-31), so one side is
 * `open_interest_long`. Continuous funding has no next payment: `nextAt` is the time of the read.
 */
export function parseParadex(answer: unknown, now: number): MarketFunding[] {
  const rows = list<ParadexSummary>('paradex', record('paradex', answer, 'markets/summary').results, 'markets/summary results');
  return collect('paradex', rows, (r) => {
    if (typeof r.symbol !== 'string' || !r.symbol.endsWith('-USD-PERP')) return null;
    if (r.funding_rate === '' || r.funding_rate === undefined) return null;     // listed, no funding yet
    const long = optNum(r.open_interest_long);
    const both = optNum(r.open_interest);
    return {
      venue: 'paradex',
      symbol: r.symbol,
      ratePerHour: paradexRatePerHour(r.funding_rate, r.funding_interval_minutes),
      settlement: 'continuous',
      nextAt: now,
      markPx: optPrice(r.mark_price),
      oraclePx: optPrice(r.underlying_price),
      openInterest: long ?? (both === null ? null : both / 2),
      volume24hUsd: optNum(r.volume_24h),
      ...baseFields(r.symbol.slice(0, -'-USD-PERP'.length)),
    };
  });
}
