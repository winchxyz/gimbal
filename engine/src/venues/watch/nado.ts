// Nado (Ink): the archive's `v2/contracts` lists every perp with its rate, mark, open interest and volume.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, collect, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { nadoRatePerHour, nextAtOr, settlementForHours } from './units.ts';

export const NADO_ARCHIVE_URL = 'https://archive.prod.nado.xyz';

export class NadoReader implements WatchReader {
  readonly id = 'nado';
  readonly kind = 'dex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    return parseNado(await this.#http.get(`${NADO_ARCHIVE_URL}/v2/contracts`), this.#http.clock.now());
  }
}

interface NadoContract {
  ticker_id: string; base_currency: string; product_type: string; mark_price: number; index_price: number;
  funding_rate: number; funding_interval_minutes: number; next_funding_rate_timestamp: number;
  long_open_interest: number; open_interest: number; quote_volume: number;
}

/**
 * `funding_rate` is a 24 h rate although funding settles every `funding_interval_minutes` (60): see
 * nadoRatePerHour. `open_interest` counts both sides (long + short), so one side is `long_open_interest`.
 */
export function parseNado(answer: unknown, now: number): MarketFunding[] {
  const contracts = Object.values(record('nado', answer, 'v2/contracts')) as NadoContract[];
  return collect('nado', contracts, (c) => {
    if (c.product_type !== 'perpetual') return null;
    if (typeof c.base_currency !== 'string' || !c.base_currency.endsWith('-PERP')) throw new Error(`unexpected base ${JSON.stringify(c.base_currency)}`);
    const hours = optNum(c.funding_interval_minutes) === null ? 1 : c.funding_interval_minutes / 60;
    const next = optNum(c.next_funding_rate_timestamp);
    return {
      venue: 'nado',
      symbol: c.ticker_id,
      ratePerHour: nadoRatePerHour(c.funding_rate),
      settlement: settlementForHours(hours),
      nextAt: nextAtOr(next === null ? null : next * 1000, now, hours),
      markPx: optPrice(c.mark_price),
      oraclePx: optPrice(c.index_price),
      openInterest: optNum(c.long_open_interest) ?? (optNum(c.open_interest) === null ? null : c.open_interest / 2),
      volume24hUsd: optNum(c.quote_volume),
      ...baseFields(c.base_currency.slice(0, -'-PERP'.length)),
    };
  });
}
