// Lighter (REST only): `funding-rates` has the current rate of every market (and Lighter's copies of Binance, Bybit
// and Hyperliquid rates, which are left out), `orderBookDetails` the marks, open interest and volume.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, collect, list, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { lighterRatePerHour, nextBoundary } from './units.ts';

export const LIGHTER_API_URL = 'https://mainnet.zklighter.elliot.ai/api/v1';

export class LighterReader implements WatchReader {
  readonly id = 'lighter';
  readonly kind = 'dex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    const [rates, details] = await Promise.all([
      this.#http.get(`${LIGHTER_API_URL}/funding-rates`),
      this.#http.get(`${LIGHTER_API_URL}/orderBookDetails`),
    ]);
    return parseLighter(rates, details, this.#http.clock.now());
  }
}

interface LighterRate { market_id: number; exchange: string; symbol: string; rate: number }
interface LighterDetail {
  symbol: string; market_id: number; market_type: string; status: string; mark_price: string; index_price: string;
  open_interest: number | string; daily_quote_token_volume: number | string;
}

/**
 * Active perps only. `open_interest` is one side in base units; `open_interest_usd` counts both sides (twice
 * open_interest x mark on 2026-10-31), so it is not used.
 */
export function parseLighter(rates: unknown, details: unknown, now: number): MarketFunding[] {
  const byId = new Map<number, LighterDetail>();
  for (const d of list<LighterDetail>('lighter', record('lighter', details, 'orderBookDetails').order_book_details, 'order_book_details')) {
    if (d.market_type === 'perp' && d.status === 'active') byId.set(d.market_id, d);
  }
  const nextAt = nextBoundary(now, 1);
  const own = list<LighterRate>('lighter', record('lighter', rates, 'funding-rates').funding_rates, 'funding_rates').filter((r) => r.exchange === 'lighter');
  return collect('lighter', own, (r) => {
    const d = byId.get(r.market_id);
    if (d === undefined) return null;
    return {
      venue: 'lighter',
      symbol: d.symbol,
      ratePerHour: lighterRatePerHour(r.rate),
      settlement: 'hourly',
      nextAt,
      markPx: optPrice(d.mark_price),
      oraclePx: optPrice(d.index_price),
      openInterest: optNum(d.open_interest),
      volume24hUsd: optNum(d.daily_quote_token_volume),
      ...baseFields(d.symbol),
    };
  });
}
