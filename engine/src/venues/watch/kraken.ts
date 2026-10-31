// Kraken Futures (CEX, reference only): `tickers` has every contract in one call. Multi-collateral perpetuals
// (`PF_<BASE>USD`) only; `XBT` is Kraken's BTC.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, WatchVenueError, collect, list, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { krakenRatePerHour, nextBoundary } from './units.ts';

export const KRAKEN_FUTURES_URL = 'https://futures.kraken.com/derivatives/api/v3';

export class KrakenReader implements WatchReader {
  readonly id = 'kraken';
  readonly kind = 'cex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    return parseKraken(await this.#http.get(`${KRAKEN_FUTURES_URL}/tickers`), this.#http.clock.now());
  }
}

interface KrakenTicker {
  symbol: string; tag: string; suspended: boolean; relativeFundingRate?: number;
  markPrice: number; indexPrice: number; openInterest: number; volumeQuote: number;
}

/**
 * The rate is the last settled hour's `relativeFundingRate`: `relativeFundingRatePrediction` extrapolates the
 * minutes of the running hour seen so far and swings more. `openInterest` is in base coins on PF_ contracts;
 * `volumeQuote` is the 24 h volume in USD.
 */
export function parseKraken(answer: unknown, now: number): MarketFunding[] {
  const o = record('kraken', answer, 'tickers');
  if (o.result !== 'success') throw new WatchVenueError('kraken', `tickers: result ${JSON.stringify(o.result)} ${JSON.stringify(o.error ?? '')}`);
  const nextAt = nextBoundary(now, 1);
  return collect('kraken', list<KrakenTicker>('kraken', o.tickers, 'tickers'), (t) => {
    const m = /^PF_([A-Z0-9]+)USD$/.exec(t.symbol ?? '');
    if (m === null || t.tag !== 'perpetual' || t.suspended === true) return null;
    return {
      venue: 'kraken',
      symbol: t.symbol,
      ratePerHour: krakenRatePerHour(t.relativeFundingRate),
      settlement: 'hourly',
      nextAt,
      markPx: optPrice(t.markPrice),
      oraclePx: optPrice(t.indexPrice),
      openInterest: optNum(t.openInterest),
      volume24hUsd: optNum(t.volumeQuote),
      ...baseFields(m[1]!),
    };
  });
}
