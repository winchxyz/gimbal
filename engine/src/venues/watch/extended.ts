// Extended (Starknet): one call, `info/markets`, with every market's funding, mark, open interest and volume.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, collect, list, onePerBase, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { extendedRatePerHour, nextAtOr } from './units.ts';

export const EXTENDED_API_URL = 'https://api.starknet.extended.exchange/api/v1';

export class ExtendedReader implements WatchReader {
  readonly id = 'extended';
  readonly kind = 'dex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    return parseExtended(await this.#http.get(`${EXTENDED_API_URL}/info/markets`), this.#http.clock.now());
  }
}

interface ExtendedMarket {
  name: string; type: string; status: string;
  marketStats: { fundingRate: string; nextFundingRate: number; markPrice: string; indexPrice: string; openInterestBase: string; dailyVolume: string };
}

/**
 * ACTIVE perps only (PRELISTED, REDUCE_ONLY and DELISTED cannot open a leg). `nextFundingRate` is the next
 * funding time in ms, not a rate. Equities carry a `_24_5` suffix ("TSLA_24_5-USD"), dropped from the base;
 * where an equity is listed both ways, the one with more open interest is kept.
 */
export function parseExtended(answer: unknown, now: number): MarketFunding[] {
  const rows = list<ExtendedMarket>('extended', record('extended', answer, 'info/markets').data, 'info/markets data');
  return onePerBase(collect('extended', rows, (m) => {
    if (m.type !== 'PERPETUAL' || m.status !== 'ACTIVE') return null;
    const s = m.marketStats;
    if (typeof m.name !== 'string' || !m.name.endsWith('-USD')) throw new Error(`unexpected market name ${JSON.stringify(m.name)}`);
    return {
      venue: 'extended',
      symbol: m.name,
      ratePerHour: extendedRatePerHour(s.fundingRate),
      settlement: 'hourly',
      nextAt: nextAtOr(optNum(s.nextFundingRate), now, 1),
      markPx: optPrice(s.markPrice),
      oraclePx: optPrice(s.indexPrice),
      openInterest: optNum(s.openInterestBase),      // base units (`openInterest` is the same in USD)
      volume24hUsd: optNum(s.dailyVolume),
      ...baseFields(m.name.slice(0, -'-USD'.length)),
    };
  }));
}
