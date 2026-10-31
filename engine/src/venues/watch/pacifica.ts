// Pacifica (Solana): `info/prices` carries every market's funding, mark, open interest and volume in one call;
// `info` (cached) says which symbols are perps (it also lists a spot market, "SOL-USDC").

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { LISTING_TTL_MS, TtlCache, WatchHttp, WatchVenueError, collect, list, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { nextBoundary, pacificaRatePerHour } from './units.ts';

export const PACIFICA_API_URL = 'https://api.pacifica.fi/api/v1';

export class PacificaReader implements WatchReader {
  readonly id = 'pacifica';
  readonly kind = 'dex' as const;
  readonly #http: WatchHttp;
  readonly #info: TtlCache<unknown>;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
    this.#info = new TtlCache(LISTING_TTL_MS, this.#http.clock);
  }

  async funding(): Promise<MarketFunding[]> {
    const [prices, info] = await Promise.all([
      this.#http.get(`${PACIFICA_API_URL}/info/prices`),
      this.#info.get(() => this.#http.get(`${PACIFICA_API_URL}/info`)),
    ]);
    return parsePacifica(prices, info, this.#http.clock.now());
  }
}

interface PacificaPrice { symbol: string; next_funding: string; mark: string; oracle: string; open_interest: string; volume_24h: string }
interface PacificaInfo { symbol: string; instrument_type?: string }

function data(answer: unknown, what: string): unknown {
  const o = record('pacifica', answer, what);
  if (o.success !== true) throw new WatchVenueError('pacifica', `${what}: success is not true: ${JSON.stringify(o.error ?? o.code ?? null)}`);
  return o.data;
}

/** `next_funding` (the running estimate for the next hourly settlement), not `funding` (what the last hour paid). */
export function parsePacifica(prices: unknown, info: unknown, now: number): MarketFunding[] {
  const perps = new Set(list<PacificaInfo>('pacifica', data(info, 'info'), 'info data').filter((m) => m.instrument_type === 'perpetual').map((m) => m.symbol));
  const nextAt = nextBoundary(now, 1);
  return collect('pacifica', list<PacificaPrice>('pacifica', data(prices, 'info/prices'), 'info/prices data'), (p) => {
    if (!perps.has(p.symbol)) return null;
    return {
      venue: 'pacifica',
      symbol: p.symbol,
      ratePerHour: pacificaRatePerHour(p.next_funding),
      settlement: 'hourly',
      nextAt,
      markPx: optPrice(p.mark),
      oraclePx: optPrice(p.oracle),
      openInterest: optNum(p.open_interest),           // base units
      volume24hUsd: optNum(p.volume_24h),
      ...baseFields(p.symbol),
    };
  });
}
