// KuCoin Futures (CEX, reference only): `contracts/active` has every contract's rate, interval, mark, open interest
// and volume in one call. USDT-margined linear contracts only (the USDC and inverse ones repeat the bases).

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, WatchVenueError, collect, list, num, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { HOUR_MS, kucoinRatePerHour, nextAtOr, settlementForHours } from './units.ts';

export const KUCOIN_API_URL = 'https://api-futures.kucoin.com/api/v1';

export class KucoinReader implements WatchReader {
  readonly id = 'kucoin';
  readonly kind = 'cex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    return parseKucoin(await this.#http.get(`${KUCOIN_API_URL}/contracts/active`), this.#http.clock.now());
  }
}

interface KucoinContract {
  symbol: string; baseCurrency: string; quoteCurrency: string; isInverse: boolean; status: string;
  fundingFeeRate: number | null; currentFundingRateGranularity: number | null; nextFundingRateDateTime: number;
  markPrice: number; indexPrice: number; openInterest: string; multiplier: number; turnoverOf24h: number;
}

/**
 * `openInterest` counts lots; `multiplier` is base coins per lot (XBTUSDTM: 0.001 BTC). A contract without a
 * funding granularity (pre-market) is left out. `XBT` is KuCoin's BTC.
 */
export function parseKucoin(answer: unknown, now: number): MarketFunding[] {
  const o = record('kucoin', answer, 'contracts/active');
  if (o.code !== '200000') throw new WatchVenueError('kucoin', `contracts/active: code ${JSON.stringify(o.code)} ${JSON.stringify(o.msg ?? '')}`);
  return collect('kucoin', list<KucoinContract>('kucoin', o.data, 'contracts/active data'), (c) => {
    if (c.quoteCurrency !== 'USDT' || c.isInverse !== false || c.status !== 'Open') return null;
    if (c.currentFundingRateGranularity === null || c.fundingFeeRate === null) return null;
    const hours = num(c.currentFundingRateGranularity, 'currentFundingRateGranularity') / HOUR_MS;
    const lots = optNum(c.openInterest);
    const perLot = optNum(c.multiplier);
    return {
      venue: 'kucoin',
      symbol: c.symbol,
      ratePerHour: kucoinRatePerHour(c.fundingFeeRate, c.currentFundingRateGranularity),
      settlement: settlementForHours(hours),
      nextAt: nextAtOr(optNum(c.nextFundingRateDateTime), now, hours),
      markPx: optPrice(c.markPrice),
      oraclePx: optPrice(c.indexPrice),
      openInterest: lots === null || perLot === null ? null : lots * perLot,
      volume24hUsd: optNum(c.turnoverOf24h),
      ...baseFields(c.baseCurrency),
    };
  });
}
