// OKX (CEX, reference only): three bulk calls, funding (`instId=ANY` returns every swap), marks and open interest.
// USDT-margined swaps only: the coin-margined ones (BTC-USD-SWAP) repeat the same bases, and the dated
// `_UM_XPERP` products are not perpetual.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, WatchVenueError, collect, list, num, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { HOUR_MS, nextAtOr, okxRatePerHour, settlementForHours } from './units.ts';

export const OKX_API_URL = 'https://www.okx.com/api/v5';

export class OkxReader implements WatchReader {
  readonly id = 'okx';
  readonly kind = 'cex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    const [rates, marks, oi] = await Promise.all([
      this.#http.get(`${OKX_API_URL}/public/funding-rate?instId=ANY`),
      this.#http.get(`${OKX_API_URL}/public/mark-price?instType=SWAP`),
      this.#http.get(`${OKX_API_URL}/public/open-interest?instType=SWAP`),
    ]);
    return parseOkx(rates, marks, oi, this.#http.clock.now());
  }
}

interface OkxRate { instId: string; fundingRate: string; fundingTime: string; prevFundingTime?: string; nextFundingTime: string }
interface OkxMark { instId: string; markPx: string }
interface OkxOi { instId: string; oiCcy: string }

function okxData(answer: unknown, what: string): unknown {
  const o = record('okx', answer, what);
  if (o.code !== '0') throw new WatchVenueError('okx', `${what}: code ${JSON.stringify(o.code)} ${JSON.stringify(o.msg ?? '')}`);
  return o.data;
}

/**
 * `fundingRate` is the running period's, settled at `fundingTime`; the period is `fundingTime - prevFundingTime`
 * (2, 4 or 8 h). `oiCcy` is open interest in the base coin. No 24 h volume: it would take a fourth call.
 */
export function parseOkx(rates: unknown, marks: unknown, oi: unknown, now: number): MarketFunding[] {
  const mark = new Map(list<OkxMark>('okx', okxData(marks, 'mark-price'), 'mark-price data').map((m) => [m.instId, m.markPx]));
  const open = new Map(list<OkxOi>('okx', okxData(oi, 'open-interest'), 'open-interest data').map((o) => [o.instId, o.oiCcy]));
  return collect('okx', list<OkxRate>('okx', okxData(rates, 'funding-rate'), 'funding-rate data'), (r) => {
    const m = /^([A-Za-z0-9]+)-USDT-SWAP$/.exec(r.instId ?? '');
    if (m === null) return null;
    const settleAt = num(r.fundingTime, 'fundingTime');
    const prev = optNum(r.prevFundingTime);
    const periodMs = prev !== null && prev < settleAt ? settleAt - prev : num(r.nextFundingTime, 'nextFundingTime') - settleAt;
    const hours = periodMs / HOUR_MS;
    return {
      venue: 'okx',
      symbol: r.instId,
      ratePerHour: okxRatePerHour(r.fundingRate, periodMs),
      settlement: settlementForHours(hours),
      nextAt: nextAtOr(settleAt, now, hours),
      markPx: optPrice(mark.get(r.instId)),
      oraclePx: null,
      openInterest: optNum(open.get(r.instId)),
      volume24hUsd: null,
      ...baseFields(m[1]!),
    };
  });
}
