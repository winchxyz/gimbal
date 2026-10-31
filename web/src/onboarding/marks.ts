// What the rules form reads from the exchanges, because the engine serves neither: the current mark of a symbol, to turn a
// USD cap on an unpriced asset into a size cap (docs/interfaces.md §1.2), and Hyperliquid's asset list, so the owner can
// add an asset by hand with its real index and size decimals. Both are Hyperliquid's public `info` endpoint; where it
// has no answer, the owner types the mark.
import type { NearNetwork } from './wallet.ts';

export interface HlAsset {
  index: number;
  symbol: string;
  sz_decimals: number;
}

export interface VenueData {
  /** The mid price of a symbol in USD, or null when the exchange does not list it. Rejects when it cannot be read. */
  mark(symbol: string): Promise<number | null>;
  /** Hyperliquid's perpetual assets, with the index and size decimals the policy needs. Rejects when it cannot be read. */
  hlAssets(): Promise<HlAsset[]>;
}

export const HL_INFO: Record<NearNetwork, string> = {
  mainnet: 'https://api.hyperliquid.xyz/info',
  testnet: 'https://api.hyperliquid-testnet.xyz/info',
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks the body of `allMids`: a map from symbol to a decimal string. Entries that are not positive numbers are left out. */
export function parseMids(value: unknown): Map<string, number> {
  if (!isObject(value)) throw new Error('Hyperliquid allMids: not an object');
  const out = new Map<string, number>();
  for (const [symbol, price] of Object.entries(value)) {
    const n = typeof price === 'string' ? Number(price) : NaN;
    if (Number.isFinite(n) && n > 0) out.set(symbol, n);
  }
  return out;
}

/** Checks the body of `meta`: the universe's position is the asset's index. Delisted assets are left out. */
export function parseMeta(value: unknown): HlAsset[] {
  if (!isObject(value) || !Array.isArray(value.universe)) throw new Error('Hyperliquid meta: no universe');
  const out: HlAsset[] = [];
  value.universe.forEach((entry: unknown, index) => {
    if (!isObject(entry) || typeof entry.name !== 'string' || typeof entry.szDecimals !== 'number' || entry.isDelisted === true) return;
    out.push({ index, symbol: entry.name, sz_decimals: entry.szDecimals });
  });
  return out;
}

/** Hyperliquid's public data, cached for `ttlMs` so typing a symbol does not read it on every key. */
export function hyperliquidData(network: NearNetwork, fetcher: typeof fetch = fetch, now: () => number = Date.now, ttlMs = 10_000): VenueData {
  const cache = new Map<string, { at: number; value: unknown }>();
  async function info(type: 'allMids' | 'meta'): Promise<unknown> {
    const hit = cache.get(type);
    if (hit !== undefined && now() - hit.at <= ttlMs) return hit.value;
    const response = await fetcher(HL_INFO[network], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Hyperliquid ${type}: ${response.status}`);
    const value: unknown = await response.json();
    cache.set(type, { at: now(), value });
    return value;
  }
  return {
    async mark(symbol) {
      return parseMids(await info('allMids')).get(symbol) ?? null;
    },
    async hlAssets() {
      return parseMeta(await info('meta'));
    },
  };
}
