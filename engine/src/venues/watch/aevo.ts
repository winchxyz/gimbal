// Aevo: `coingecko-statistics` has every perp's rate, interval, open interest and volume (inactive ones too);
// `markets` says which are active and carries their marks.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, collect, list, optNum, optPrice } from './http.ts';
import { baseFields } from './symbols.ts';
import { aevoRatePerHour, nextAtOr, settlementForHours } from './units.ts';

export const AEVO_API_URL = 'https://api.aevo.xyz';

export class AevoReader implements WatchReader {
  readonly id = 'aevo';
  readonly kind = 'dex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    const [markets, stats] = await Promise.all([
      this.#http.get(`${AEVO_API_URL}/markets?instrument_type=PERPETUAL`),
      this.#http.get(`${AEVO_API_URL}/coingecko-statistics`),
    ]);
    return parseAevo(markets, stats, this.#http.clock.now());
  }
}

interface AevoMarket { instrument_name: string; is_active: boolean; mark_price: string; index_price: string }
interface AevoStat {
  ticker_id: string; base_currency: string; product_type: string; funding_rate: string; funding_interval_minutes: number;
  next_funding_rate_timestamp?: string; long_open_interest: string; target_volume: string;
}

/** `open_interest` counts both sides (long + short), so one side is `long_open_interest`. */
export function parseAevo(markets: unknown, stats: unknown, now: number): MarketFunding[] {
  const active = new Map(list<AevoMarket>('aevo', markets, 'markets').filter((m) => m.is_active === true).map((m) => [m.instrument_name, m]));
  return collect('aevo', list<AevoStat>('aevo', stats, 'coingecko-statistics'), (s) => {
    const m = active.get(s.ticker_id);
    if (s.product_type !== 'Perpetual' || m === undefined) return null;
    const hours = optNum(s.funding_interval_minutes) === null ? 1 : s.funding_interval_minutes / 60;
    const next = optNum(s.next_funding_rate_timestamp);
    return {
      venue: 'aevo',
      symbol: s.ticker_id,
      ratePerHour: aevoRatePerHour(s.funding_rate, s.funding_interval_minutes),
      settlement: settlementForHours(hours),
      nextAt: nextAtOr(next === null ? null : next * 1000, now, hours),
      markPx: optPrice(m.mark_price),
      oraclePx: optPrice(m.index_price),
      openInterest: optNum(s.long_open_interest),
      volume24hUsd: optNum(s.target_volume),
      ...baseFields(s.base_currency),
    };
  });
}
