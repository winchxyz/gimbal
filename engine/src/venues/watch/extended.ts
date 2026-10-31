// Extended (Starknet): one call, `info/markets`, with every market's funding, funding cap, mark, open interest and
// volume.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, collect, list, onePerBase, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { extendedRatePerHour, fundingLimitsPerHour, nextAtOr } from './units.ts';

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
  tradingConfig?: { hourlyFundingRateCap?: string };
}

/**
 * ACTIVE perps only (PRELISTED, REDUCE_ONLY and DELISTED cannot open a leg). `nextFundingRate` is the next
 * funding time in ms, not a rate. Equities carry a `_24_5` suffix ("TSLA_24_5-USD"), dropped from the base;
 * where an equity is listed both ways, the one with more open interest is kept.
 * `tradingConfig.hourlyFundingRateCap` is a percentage per hour ("1" = 1 %), the clamp both ways: Extended's docs
 * (Trading > Funding payments) state the hourly cap by market group in percent (group 1: 1 %). The recorded sweep's
 * ACTIVE perps have 0.25 to 1 (2 only on delisted ones); read as fractions they would be 25 % to 100 % per hour. No
 * market of it comes near its cap (PEARL-USD's 0.063 % per hour is the highest rate).
 */
export function parseExtended(answer: unknown, now: number): MarketFunding[] {
  const rows = list<ExtendedMarket>('extended', record('extended', answer, 'info/markets').data, 'info/markets data');
  return onePerBase(collect('extended', rows, (m) => {
    if (m.type !== 'PERPETUAL' || m.status !== 'ACTIVE') return null;
    const s = m.marketStats;
    if (typeof m.name !== 'string' || !m.name.endsWith('-USD')) throw new Error(`unexpected market name ${JSON.stringify(m.name)}`);
    const capPct = optNum(m.tradingConfig?.hourlyFundingRateCap);
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
      ...(capPct === null ? {} : fundingLimitsPerHour(capPct, -capPct, 1, 100)),
    };
  }));
}
