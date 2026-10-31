// dYdX v4: the indexer's `perpetualMarkets` lists every market with its next hourly rate, oracle price, open
// interest and volume in one call. Most markets are in FINAL_SETTLEMENT; only ACTIVE ones count.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, collect, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { dydxRatePerHour, nextBoundary } from './units.ts';

export const DYDX_INDEXER_URL = 'https://indexer.dydx.trade/v4';

export class DydxReader implements WatchReader {
  readonly id = 'dydx';
  readonly kind = 'dex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    return parseDydx(await this.#http.get(`${DYDX_INDEXER_URL}/perpetualMarkets`), this.#http.clock.now());
  }
}

interface DydxMarket { ticker: string; status: string; oraclePrice: string; nextFundingRate: string; openInterest: string; volume24H: string }

/** dYdX margins on the oracle price: there is no separate mark, so both prices are the oracle's. */
export function parseDydx(answer: unknown, now: number): MarketFunding[] {
  const markets = record('dydx', record('dydx', answer, 'perpetualMarkets').markets, 'perpetualMarkets markets');
  const nextAt = nextBoundary(now, 1);
  return collect('dydx', Object.values(markets) as DydxMarket[], (m) => {
    if (m.status !== 'ACTIVE') return null;
    if (typeof m.ticker !== 'string' || !m.ticker.endsWith('-USD')) throw new Error(`unexpected ticker ${JSON.stringify(m.ticker)}`);
    const px = optPrice(m.oraclePrice);
    return {
      venue: 'dydx',
      symbol: m.ticker,
      ratePerHour: dydxRatePerHour(m.nextFundingRate),
      settlement: 'hourly',
      nextAt,
      markPx: px,
      oraclePx: px,
      openInterest: optNum(m.openInterest),           // base units
      volume24hUsd: optNum(m.volume24H),
      ...baseFields(m.ticker.slice(0, -'-USD'.length)),
    };
  });
}
