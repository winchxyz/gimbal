// Gate (CEX, reference only): USDT-margined perps. `contracts` has rates, intervals, rate limits, marks and open
// interest; `tickers` the 24 h volume.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, collect, list, num, optNum, optPrice } from './http.ts';
import { baseFields } from './symbols.ts';
import { fundingLimitsPerHour, gateRatePerHour, nextAtOr, settlementForHours } from './units.ts';

export const GATE_API_URL = 'https://api.gateio.ws/api/v4/futures/usdt';

export class GateReader implements WatchReader {
  readonly id = 'gate';
  readonly kind = 'cex' as const;
  readonly #http: WatchHttp;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
  }

  async funding(): Promise<MarketFunding[]> {
    const [contracts, tickers] = await Promise.all([
      this.#http.get(`${GATE_API_URL}/contracts`),
      this.#http.get(`${GATE_API_URL}/tickers`),
    ]);
    return parseGate(contracts, tickers, this.#http.clock.now());
  }
}

interface GateContract {
  name: string; status: string; in_delisting: boolean; funding_rate: string; funding_interval: number; funding_next_apply: number;
  mark_price: string; index_price: string; position_size: number; quanto_multiplier: string; funding_rate_limit?: string;
}
interface GateTicker { contract: string; volume_24h_quote: string }

/**
 * Open interest in base coins is `position_size` (contracts, the long side) x `quanto_multiplier` (coins per
 * contract). The tickers' `total_size` counts both sides (exactly twice position_size on 2026-10-31).
 * `funding_rate_limit` is the rate's limit both ways, per `funding_interval`: five markets of the recorded sweep sit
 * exactly on it (AGRIPPA_USDT at 0.02 per 4 h, VOLX_USDT at -0.005 per 8 h).
 */
export function parseGate(contracts: unknown, tickers: unknown, now: number): MarketFunding[] {
  const volume = new Map(list<GateTicker>('gate', tickers, 'tickers').map((t) => [t.contract, t.volume_24h_quote]));
  return collect('gate', list<GateContract>('gate', contracts, 'contracts'), (c) => {
    const m = /^([A-Za-z0-9]+)_USDT$/.exec(c.name ?? '');
    if (m === null || c.in_delisting === true || c.status !== 'trading') return null;
    const hours = num(c.funding_interval, 'funding_interval') / 3600;
    const next = optNum(c.funding_next_apply);
    const size = optNum(c.position_size);
    const perContract = optNum(c.quanto_multiplier);
    const limit = optNum(c.funding_rate_limit);
    return {
      venue: 'gate',
      symbol: c.name,
      ratePerHour: gateRatePerHour(c.funding_rate, c.funding_interval),
      settlement: settlementForHours(hours),
      nextAt: nextAtOr(next === null ? null : next * 1000, now, hours),
      markPx: optPrice(c.mark_price),
      oraclePx: optPrice(c.index_price),
      openInterest: size === null || perContract === null ? null : size * perContract,
      volume24hUsd: optNum(volume.get(c.name)),
      ...baseFields(m[1]!),
      ...(limit === null ? {} : fundingLimitsPerHour(limit, -limit, hours)),
    };
  });
}
