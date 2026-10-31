// MEXC (CEX, reference only): USDT-margined perps. `funding_rate` has every rate, interval and mark, `ticker` the
// open interest (in contracts) and volume; `detail` (cached) the contract sizes and which contracts are enabled.

import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { LISTING_TTL_MS, TtlCache, WatchHttp, WatchVenueError, collect, list, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { mexcRatePerHour, nextAtOr, settlementForHours } from './units.ts';

export const MEXC_API_URL = 'https://contract.mexc.com/api/v1/contract';

export class MexcReader implements WatchReader {
  readonly id = 'mexc';
  readonly kind = 'cex' as const;
  readonly #http: WatchHttp;
  readonly #detail: TtlCache<unknown>;

  constructor(options: WatchReaderOptions = {}) {
    this.#http = new WatchHttp(this.id, options);
    this.#detail = new TtlCache(LISTING_TTL_MS, this.#http.clock);
  }

  async funding(): Promise<MarketFunding[]> {
    const [rates, ticker, detail] = await Promise.all([
      this.#http.get(`${MEXC_API_URL}/funding_rate`),
      this.#http.get(`${MEXC_API_URL}/ticker`),
      this.#detail.get(() => this.#http.get(`${MEXC_API_URL}/detail`)),
    ]);
    return parseMexc(rates, ticker, detail, this.#http.clock.now());
  }
}

interface MexcRate { symbol: string; fundingRate: number; collectCycle: number; nextSettleTime: number; fairPrice: number; idxPrice: number }
interface MexcTicker { symbol: string; holdVol: number; amount24: number }
interface MexcDetail { symbol: string; baseCoin: string; quoteCoin: string; contractSize: number; state: number }

function mexcData(answer: unknown, what: string): unknown {
  const o = record('mexc', answer, what);
  if (o.success !== true) throw new WatchVenueError('mexc', `${what}: success is not true, code ${JSON.stringify(o.code)}`);
  return o.data;
}

/**
 * Enabled (state 0) `_USDT` contracts only. Open interest in base coins is `holdVol` (contracts) x `contractSize`;
 * the mark is `fairPrice`. Equities carry a `STOCK` suffix on the base, dropped by the normaliser.
 */
export function parseMexc(rates: unknown, ticker: unknown, detail: unknown, now: number): MarketFunding[] {
  const contracts = new Map(list<MexcDetail>('mexc', mexcData(detail, 'detail'), 'detail data').map((d) => [d.symbol, d]));
  const tick = new Map(list<MexcTicker>('mexc', mexcData(ticker, 'ticker'), 'ticker data').map((t) => [t.symbol, t]));
  return collect('mexc', list<MexcRate>('mexc', mexcData(rates, 'funding_rate'), 'funding_rate data'), (r) => {
    const d = contracts.get(r.symbol);
    if (d === undefined || d.state !== 0 || d.quoteCoin !== 'USDT' || !/_USDT$/.test(r.symbol)) return null;
    const hours = r.collectCycle;
    const t = tick.get(r.symbol);
    const held = optNum(t?.holdVol);
    const size = optNum(d.contractSize);
    return {
      venue: 'mexc',
      symbol: r.symbol,
      ratePerHour: mexcRatePerHour(r.fundingRate, hours),
      settlement: settlementForHours(hours),
      nextAt: nextAtOr(optNum(r.nextSettleTime), now, hours),
      markPx: optPrice(r.fairPrice),
      oraclePx: optPrice(r.idxPrice),
      openInterest: held === null || size === null ? null : held * size,
      volume24hUsd: optNum(t?.amount24),
      ...baseFields(d.baseCoin),
    };
  });
}
