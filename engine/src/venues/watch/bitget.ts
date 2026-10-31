// Bitget (CEX, reference only): USDT-margined perps. `tickers` has rates, marks, open interest and volume;
// `current-fund-rate` each market's interval, next settlement and funding cap and floor.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, WatchVenueError, collect, list, num, optNum, optPrice, record } from './http.ts';
import { baseFields, splitQuote } from './symbols.ts';
import { bitgetRatePerHour, fundingLimitsPerHour, nextAtOr, settlementForHours } from './units.ts';

export const BITGET_API_URL = 'https://api.bitget.com/api/v2/mix/market';

export class BitgetReader implements WatchReader {
  readonly id = 'bitget';
  readonly kind = 'cex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    const [tickers, current] = await Promise.all([
      this.#http.get(`${BITGET_API_URL}/tickers?productType=USDT-FUTURES`),
      this.#http.get(`${BITGET_API_URL}/current-fund-rate?productType=USDT-FUTURES`),
    ]);
    return parseBitget(tickers, current, this.#http.clock.now());
  }
}

interface BitgetTicker { symbol: string; fundingRate: string; markPrice: string; indexPrice: string; holdingAmount: string; usdtVolume: string; deliveryTime?: string | null }
interface BitgetCurrent { symbol: string; fundingRateInterval: string; nextUpdate: string; maxFundingRate?: string | null; minFundingRate?: string | null }

function bitgetData(answer: unknown, what: string): unknown {
  const o = record('bitget', answer, what);
  if (o.code !== '00000') throw new WatchVenueError('bitget', `${what}: code ${JSON.stringify(o.code)} ${JSON.stringify(o.msg ?? '')}`);
  return o.data;
}

/**
 * `holdingAmount` is open interest in the base coin; `usdtVolume` the 24 h volume in USDT. `current-fund-rate`'s
 * `maxFundingRate` / `minFundingRate` are per `fundingRateInterval`, like the rate; null on 27 listings of the
 * recorded sweep (no limits given), none of them in the tickers this reader keeps.
 */
export function parseBitget(tickers: unknown, current: unknown, now: number): MarketFunding[] {
  const interval = new Map(list<BitgetCurrent>('bitget', bitgetData(current, 'current-fund-rate'), 'current-fund-rate data').map((c) => [c.symbol, c]));
  return collect('bitget', list<BitgetTicker>('bitget', bitgetData(tickers, 'tickers'), 'tickers data'), (t) => {
    const q = splitQuote(t.symbol ?? '', ['USDT']);
    const c = interval.get(t.symbol);
    if (q === null || c === undefined) return null;
    const hours = num(c.fundingRateInterval, 'fundingRateInterval');
    return {
      venue: 'bitget',
      symbol: t.symbol,
      ratePerHour: bitgetRatePerHour(t.fundingRate, hours),
      settlement: settlementForHours(hours),
      nextAt: nextAtOr(optNum(c.nextUpdate), now, hours),
      markPx: optPrice(t.markPrice),
      oraclePx: optPrice(t.indexPrice),
      openInterest: optNum(t.holdingAmount),
      volume24hUsd: optNum(t.usdtVolume),
      ...baseFields(q.base, { stockSuffix: true }),
      ...fundingLimitsPerHour(c.maxFundingRate, c.minFundingRate, hours),
    };
  });
}
