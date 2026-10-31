// The oracle in replay: the contract's Mock price source, fed from the recording. Every Hyperliquid funding answer
// the replay serves carries the venue's oracle prices; they become the stored prices, dated by the replay clock. That
// is the clock the scanner runs on, so a stored price is never in the scanner's future (the wall clock would put it
// there: the recording is in the past) and it ages as replay time passes, as the contract's would between refreshes.

import type { VenueId } from '@gimbal/shared';
import type { OraclePrice, OracleSource } from '../scanner/price.ts';
import { kiloBase } from '../venues/base-symbol.ts';
import type { Clock, MarketFunding, VenueReader } from '../venues/venue.ts';
import { ContractPriceCache } from './prices.ts';
import type { StoredPrice } from './types.ts';

export class ReplayOracle implements OracleSource {
  readonly #clock: Clock;
  readonly #cache = new ContractPriceCache({ client: { prices: async () => [] } });

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Assets with a stored price now. */
  get size(): number {
    return this.#cache.size;
  }

  /** Stores the oracle prices of one funding answer, as of now on the replay clock. */
  observe(rows: readonly MarketFunding[]): void {
    const at = this.#clock.now();
    const stored = new Map<string, StoredPrice>();
    for (const r of rows) {
      if (r.oraclePx === null || !(r.oraclePx > 0)) continue;
      stored.set(r.symbol, { asset: r.symbol, price_e8: Math.round(r.oraclePx * 1e8), at_ms: at });
      // "kPEPE" is 1000 PEPE: its base gets the per-unit price, for the other venues' symbols of the same asset.
      const key = kiloBase(r.symbol);
      if (key.base !== r.symbol && !stored.has(key.base)) {
        stored.set(key.base, { asset: key.base, price_e8: Math.round((r.oraclePx / key.multiplier) * 1e8), at_ms: at });
      }
    }
    this.#cache.set([...stored.values()]);
  }

  price(venue: VenueId, symbol: string): OraclePrice | null {
    return this.#cache.price(venue, symbol);
  }

  /** The Hyperliquid reader with every funding answer observed on its way to the scanner; other venues unchanged. */
  tap(reader: VenueReader): VenueReader {
    if (reader.id !== 'hyperliquid') return reader;
    return new Proxy(reader, {
      get: (target, prop) => {
        if (prop === 'funding') {
          return async () => {
            const rows = await target.funding();
            this.observe(rows);
            return rows;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }
}
