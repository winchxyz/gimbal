// Variational Omni (RFQ, Arbitrum): `metadata/v2/stats` lists every listing with its funding, mark, open interest
// and volume. There is no order book (quotes are RFQ) and no oracle price in the answer.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, collect, list, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { nextAtOr, oneSide, settlementForHours, variationalRatePerHour } from './units.ts';

export const VARIATIONAL_API_URL = 'https://omni-client-api.prod.ap-northeast-1.variational.io';

export class VariationalReader implements WatchReader {
  readonly id = 'variational';
  readonly kind = 'dex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    return parseVariational(await this.#http.get(`${VARIATIONAL_API_URL}/metadata/v2/stats`), this.#http.clock.now());
  }
}

interface VariationalListing {
  ticker: string; contract_type: string; mark_price: string; volume_24h: string;
  open_interest: { long_open_interest: string; short_open_interest: string };
  funding: { next: { annualized_rate: string; interval_rate: string }; interval_seconds: number; next_timestamp: number };
}

/**
 * Open interest comes in USD per side and differs between sides (the market maker holds the rest): one side is
 * their mean, in base units at the mark.
 */
export function parseVariational(answer: unknown, now: number): MarketFunding[] {
  const listings = list<VariationalListing>('variational', record('variational', answer, 'metadata/v2/stats').listings, 'listings');
  return collect('variational', listings, (l) => {
    if (l.contract_type !== 'perpetual') return null;
    if (typeof l.ticker !== 'string' || !l.ticker.endsWith('-PERP')) throw new Error(`unexpected ticker ${JSON.stringify(l.ticker)}`);
    const seconds = optNum(l.funding?.interval_seconds);
    if (seconds === null || seconds <= 0) return null;       // a listing without funding
    const hours = seconds / 3600;
    const mark = optPrice(l.mark_price);
    const longUsd = optNum(l.open_interest?.long_open_interest);
    const shortUsd = optNum(l.open_interest?.short_open_interest);
    const next = optNum(l.funding.next_timestamp);
    return {
      venue: 'variational',
      symbol: l.ticker,
      ratePerHour: variationalRatePerHour(l.funding.next?.annualized_rate),
      settlement: settlementForHours(hours),
      nextAt: nextAtOr(next === null ? null : next * 1000, now, hours),
      markPx: mark,
      oraclePx: null,
      openInterest: mark === null || longUsd === null || shortUsd === null ? null : oneSide(longUsd, shortUsd) / mark,
      volume24hUsd: optNum(l.volume_24h),
      ...baseFields(l.ticker.slice(0, -'-PERP'.length)),
    };
  });
}
