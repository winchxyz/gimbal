// Backpack (CEX, reference only): `markPrices` has every perp's rate and mark, `openInterest` and `tickers` the
// open interest and volume; `markets` (cached) each perp's funding interval and whether its book is open.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { LISTING_TTL_MS, TtlCache, WatchHttp, collect, list, num, optNum, optPrice } from './http.ts';
import { baseFields } from './symbols.ts';
import { HOUR_MS, backpackRatePerHour, nextAtOr, settlementForHours } from './units.ts';

export const BACKPACK_API_URL = 'https://api.backpack.exchange/api/v1';

export class BackpackReader implements WatchReader {
  readonly id = 'backpack';
  readonly kind = 'cex' as const;
  readonly #http: WatchHttp;
  readonly #markets: TtlCache<unknown>;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
    this.#markets = new TtlCache(LISTING_TTL_MS, this.#http.clock);
  }

  async funding(): Promise<MarketFunding[]> {
    const [marks, oi, tickers, markets] = await Promise.all([
      this.#http.get(`${BACKPACK_API_URL}/markPrices`),
      this.#http.get(`${BACKPACK_API_URL}/openInterest`),
      this.#http.get(`${BACKPACK_API_URL}/tickers`),
      this.#markets.get(() => this.#http.get(`${BACKPACK_API_URL}/markets`)),
    ]);
    return parseBackpack(marks, oi, tickers, markets, this.#http.clock.now());
  }
}

interface BackpackMark { symbol: string; fundingRate: string; markPrice: string; indexPrice: string; nextFundingTimestamp: number }
interface BackpackOi { symbol: string; openInterest: string }
interface BackpackTicker { symbol: string; quoteVolume: string }
interface BackpackMarket { symbol: string; baseSymbol: string; marketType: string; orderBookState: string; fundingInterval: number }

/** Open perps only; equities carry a `.US` suffix on the base ("NVDA.US"), dropped by the normaliser. */
export function parseBackpack(marks: unknown, oi: unknown, tickers: unknown, markets: unknown, now: number): MarketFunding[] {
  const perps = new Map(list<BackpackMarket>('backpack', markets, 'markets').filter((m) => m.marketType === 'PERP' && m.orderBookState === 'Open').map((m) => [m.symbol, m]));
  const open = new Map(list<BackpackOi>('backpack', oi, 'openInterest').map((o) => [o.symbol, o.openInterest]));
  const volume = new Map(list<BackpackTicker>('backpack', tickers, 'tickers').map((t) => [t.symbol, t.quoteVolume]));
  return collect('backpack', list<BackpackMark>('backpack', marks, 'markPrices'), (p) => {
    const m = perps.get(p.symbol);
    if (m === undefined) return null;
    const hours = num(m.fundingInterval, 'fundingInterval') / HOUR_MS;
    return {
      venue: 'backpack',
      symbol: p.symbol,
      ratePerHour: backpackRatePerHour(p.fundingRate, m.fundingInterval),
      settlement: settlementForHours(hours),
      nextAt: nextAtOr(optNum(p.nextFundingTimestamp), now, hours),
      markPx: optPrice(p.markPrice),
      oraclePx: optPrice(p.indexPrice),
      openInterest: optNum(open.get(p.symbol)),     // base units
      volume24hUsd: optNum(volume.get(p.symbol)),
      ...baseFields(m.baseSymbol),
    };
  });
}
