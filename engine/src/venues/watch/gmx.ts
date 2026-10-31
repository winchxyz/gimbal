// GMX v2 on Arbitrum: pool markets, not an order book. `markets/info` has every market's per-side rates and open
// interest, `prices/tickers` the oracle prices; `tokens` (cached) gives the decimals those prices are scaled by.
// Each side has its own rate (funding plus borrow), so a row carries shortRatePerHour.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { LISTING_TTL_MS, TtlCache, WatchHttp, collect, list, onePerBase, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { gmxRatesPerHour, oneSide, scaledDecimal } from './units.ts';

export const GMX_ARBITRUM_API_URL = 'https://arbitrum-api.gmxinfra.io';

export class GmxReader implements WatchReader {
  readonly id = 'gmx-arbitrum';
  readonly kind = 'dex' as const;
  readonly #http: WatchHttp;
  readonly #tokens: TtlCache<unknown>;
  readonly #url: string;

  constructor(options: WatchReaderOptions & { url?: string } = {}) {
    this.#http = new WatchHttp(this.id, options);
    this.#tokens = new TtlCache(LISTING_TTL_MS, this.#http.clock);
    this.#url = options.url ?? GMX_ARBITRUM_API_URL;
  }

  async funding(): Promise<MarketFunding[]> {
    const [markets, tickers, tokens] = await Promise.all([
      this.#http.get(`${this.#url}/markets/info`),
      this.#http.get(`${this.#url}/prices/tickers`),
      this.#tokens.get(() => this.#http.get(`${this.#url}/tokens`)),
    ]);
    return parseGmx(this.id, markets, tickers, tokens, this.#http.clock.now());
  }
}

interface GmxMarket {
  name: string; indexToken: string; isListed: boolean; openInterestLong: string; openInterestShort: string;
  netRateLong: string; netRateShort: string;
}
interface GmxTicker { tokenAddress: string; minPrice: string; maxPrice: string }
interface GmxToken { address: string; decimals: number }

/**
 * Perp markets are named "<INDEX>/USD [<long>-<short>]"; swap-only and deprecated ones are left out. An index has
 * several pools ("BTC/USD [WBTC.b-USDC]", "[tBTC-tBTC]", ...): the one with the most open interest stands for it.
 * Prices: USD x 10^(30 - token decimals), mid of min and max. Open interest: USD x 1e30 per side, one side is their
 * mean. Funding accrues continuously, so `nextAt` is the time of the read.
 */
export function parseGmx(venue: string, markets: unknown, tickers: unknown, tokens: unknown, now: number): MarketFunding[] {
  const decimals = new Map(list<GmxToken>(venue, record(venue, tokens, 'tokens').tokens, 'tokens').map((t) => [t.address.toLowerCase(), t.decimals]));
  const prices = new Map(list<GmxTicker>(venue, tickers, 'prices/tickers').map((t) => [t.tokenAddress.toLowerCase(), t]));
  const rows = list<GmxMarket>(venue, record(venue, markets, 'markets/info').markets, 'markets');
  return onePerBase(collect(venue, rows, (m) => {
    const match = /^([A-Za-z0-9.]+)\/USD \[/.exec(m.name ?? '');
    if (m.isListed !== true || match === null || /deprecated/i.test(m.name)) return null;
    const index = match[1]!.replace(/\.v\d+$/, '');          // "XAUT.v2" is the current XAUT market
    const token = String(m.indexToken).toLowerCase();
    const dec = decimals.get(token);
    const t = prices.get(token);
    const markPx = dec === undefined || t === undefined
      ? null
      : (scaledDecimal(t.minPrice, 30 - dec, 'minPrice') + scaledDecimal(t.maxPrice, 30 - dec, 'maxPrice')) / 2 || null;
    const oiUsd = oneSide(scaledDecimal(m.openInterestLong, 30, 'openInterestLong'), scaledDecimal(m.openInterestShort, 30, 'openInterestShort'));
    return {
      venue,
      symbol: m.name,
      ...gmxRatesPerHour(m.netRateLong, m.netRateShort),
      settlement: 'continuous',
      nextAt: now,
      markPx,
      oraclePx: markPx,
      openInterest: markPx === null ? null : oiUsd / markPx,
      volume24hUsd: null,
      ...baseFields(index),
    };
  }));
}
