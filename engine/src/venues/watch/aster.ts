// Aster (BNB Chain, Binance-compatible API): `premiumIndex` has every market's rate and mark, `ticker/24hr` the
// volume; `exchangeInfo` (which markets trade) and `fundingInfo` (each market's interval) are listing data, cached.
// Open interest is only served per symbol, so it is left null rather than fanned out.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { LISTING_TTL_MS, TtlCache, WatchHttp, collect, list, onePerBase, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { asterRatePerHour, nextAtOr, settlementForHours } from './units.ts';

export const ASTER_API_URL = 'https://fapi.asterdex.com/fapi/v1';

/** Binance's default where `fundingInfo` has no row for a symbol. */
const DEFAULT_INTERVAL_HOURS = 8;
/** One market per base: the USDT one where there are several. */
const QUOTE_RANK: Readonly<Record<string, number>> = { USDT: 0, USDC: 1, USD1: 2, USD: 3 };

export class AsterReader implements WatchReader {
  readonly id = 'aster';
  readonly kind = 'dex' as const;
  readonly #http: WatchHttp;
  readonly #listing: TtlCache<[unknown, unknown]>;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
    this.#listing = new TtlCache(LISTING_TTL_MS, this.#http.clock);
  }

  async funding(): Promise<MarketFunding[]> {
    const [premium, ticker, [exchangeInfo, fundingInfo]] = await Promise.all([
      this.#http.get(`${ASTER_API_URL}/premiumIndex`),
      this.#http.get(`${ASTER_API_URL}/ticker/24hr`),
      this.#listing.get(() => Promise.all([this.#http.get(`${ASTER_API_URL}/exchangeInfo`), this.#http.get(`${ASTER_API_URL}/fundingInfo`)])),
    ]);
    return parseAster(premium, ticker, exchangeInfo, fundingInfo, this.#http.clock.now());
  }
}

interface AsterPremium { symbol: string; markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number }
interface AsterSymbol { symbol: string; status: string; contractType: string; baseAsset: string; quoteAsset: string }
interface AsterFundingInfo { symbol: string; fundingIntervalHours: number }
interface AsterTicker { symbol: string; quoteVolume: string }

/**
 * TRADING perpetuals only: `premiumIndex` also lists about 200 symbols that settled, wait to open or are not in
 * `exchangeInfo` at all, with stale marks.
 */
export function parseAster(premium: unknown, ticker: unknown, exchangeInfo: unknown, fundingInfo: unknown, now: number): MarketFunding[] {
  const symbols = new Map<string, AsterSymbol>();
  for (const s of list<AsterSymbol>('aster', record('aster', exchangeInfo, 'exchangeInfo').symbols, 'exchangeInfo symbols')) {
    if (s.status === 'TRADING' && s.contractType === 'PERPETUAL') symbols.set(s.symbol, s);
  }
  const hours = new Map(list<AsterFundingInfo>('aster', fundingInfo, 'fundingInfo').map((f) => [f.symbol, f.fundingIntervalHours]));
  const volume = new Map(list<AsterTicker>('aster', ticker, 'ticker/24hr').map((t) => [t.symbol, t.quoteVolume]));
  const rows = collect('aster', list<AsterPremium>('aster', premium, 'premiumIndex'), (p) => {
    const s = symbols.get(p.symbol);
    if (s === undefined) return null;
    const h = hours.get(p.symbol) ?? DEFAULT_INTERVAL_HOURS;
    return {
      venue: 'aster',
      symbol: p.symbol,
      ratePerHour: asterRatePerHour(p.lastFundingRate, h),
      settlement: settlementForHours(h),
      nextAt: nextAtOr(optNum(p.nextFundingTime), now, h),
      markPx: optPrice(p.markPrice),
      oraclePx: optPrice(p.indexPrice),
      openInterest: null,
      volume24hUsd: optNum(volume.get(p.symbol)),
      ...baseFields(s.baseAsset),
    };
  });
  const quoteOf = new Map([...symbols.values()].map((s) => [s.symbol, s.quoteAsset]));
  return onePerBase(rows, (f) => QUOTE_RANK[quoteOf.get(f.symbol) ?? ''] ?? 9);
}
