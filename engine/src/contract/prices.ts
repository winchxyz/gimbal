// The scanner's OracleSource from the contract's stored prices (`prices()`, docs/interfaces.md §1.3): the price and
// time the contract would check an order against, so a priced desk leg passes the scanner's E_ORACLE_STALE check
// exactly when the contract's own check would pass. The scanner asks synchronously on every scan, so the prices are
// read in the background every few seconds and served from memory.
//
// A price is stored per asset. The contract looks up an order's price by its policy symbol (the Hyperliquid asset's
// symbol, the Phoenix market's), so the venue symbol is tried first; a venue symbol with no price of its own falls
// back to its cross-venue base ("PERP_SOL_USDC" -> SOL, "kPEPE" -> 1000 PEPE), scaled by the units per symbol.

import type { VenueId } from '@gimbal/shared';
import type { OraclePrice, OracleSource } from '../scanner/price.ts';
import { kiloBase } from '../venues/base-symbol.ts';
import type { BaseKey } from '../venues/base-symbol.ts';
import { orderlyBase } from '../venues/orderly.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { ContractClient, StoredPrice } from './types.ts';

export interface ContractPriceCacheOptions {
  client: Pick<ContractClient, 'prices'>;
  /** ms between reads; default 10 s (a stored price lives up to policy.oracle_max_age_s, minutes). */
  refreshMs?: number;
  onError?: (message: string) => void;
}

/** The base key of a desk venue's symbol, as the readers pair it. */
export function venueBase(venue: VenueId, symbol: string): BaseKey {
  return venue === 'orderly' ? orderlyBase(symbol) : kiloBase(symbol);
}

/** USD per unit of a price_e8 (a JSON number or a decimal string). */
export function priceUsd(priceE8: number | string): number {
  return Number(priceE8) / 1e8;
}

export class ContractPriceCache implements OracleSource {
  readonly #client: Pick<ContractClient, 'prices'>;
  readonly #refreshMs: number;
  readonly #onError: (message: string) => void;
  #byAsset = new Map<string, OraclePrice>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #reading: Promise<void> | null = null;
  #lastError: string | null = null;

  constructor(options: ContractPriceCacheOptions) {
    this.#client = options.client;
    this.#refreshMs = options.refreshMs ?? 10_000;
    this.#onError = options.onError ?? (() => {});
  }

  /** Assets with a stored price now. */
  get size(): number {
    return this.#byAsset.size;
  }

  /** Reads prices() once; a failed read keeps the last prices (their age still counts against the limit). */
  refresh(): Promise<void> {
    if (this.#reading !== null) return this.#reading;
    this.#reading = (async () => {
      try {
        this.set(await this.#client.prices());
        this.#lastError = null;
      } catch (err) {
        const message = `contract prices(): ${errorMessage(err)}`;
        if (message !== this.#lastError) this.#onError(message);
        this.#lastError = message;
      } finally {
        this.#reading = null;
      }
    })();
    return this.#reading;
  }

  /** Replaces the cache with these rows (tests and the `prices` event feed it directly). */
  set(rows: readonly StoredPrice[]): void {
    const next = new Map<string, OraclePrice>();
    for (const r of rows) {
      const px = priceUsd(r.price_e8);
      if (Number.isFinite(px) && px > 0 && Number.isFinite(r.at_ms)) next.set(r.asset, { px, at: r.at_ms });
    }
    this.#byAsset = next;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.#refreshMs);
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  price(venue: VenueId, symbol: string): OraclePrice | null {
    const own = this.#byAsset.get(symbol);
    if (own !== undefined) return own;
    const key = venueBase(venue, symbol);
    if (key.base === symbol && key.multiplier === 1) return null;
    const base = this.#byAsset.get(key.base);
    return base === undefined ? null : { px: base.px * key.multiplier, at: base.at };
  }
}
