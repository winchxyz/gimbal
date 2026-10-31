// Shared by the NEAR AI tests: a fetch that answers one fixed body and records what was sent, and the desk venues'
// market lists the drafts are filled from (mainnet's Hyperliquid indexes; the Phoenix markets of the testnet desk).

import { readFileSync } from 'node:fs';
import type { VenueId } from '@gimbal/shared';
import type { Market, VenueReader } from '../venues/venue.ts';
import type { DeskMarkets } from './policy-draft.ts';

export interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch whose every answer is `body` (an object is sent as JSON) with `status`; `sent` lists the requests. */
export function fixedFetch(body: unknown, status = 200): { fetch: typeof fetch; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetch: fake as typeof fetch, sent };
}

/** A chat-completions body whose assistant message is `content` (an object is sent as its JSON text). */
export function completion(content: unknown, finishReason = 'stop'): Record<string, unknown> {
  return {
    id: 'test', object: 'chat.completion', created: 0, model: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
    choices: [{ index: 0, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finishReason }],
  };
}

/** A fixture file's response body. */
export function fixtureBody(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function market(venue: VenueId, symbol: string, m: Partial<Market> & { orderbook?: string } = {}): Market {
  return {
    venue, symbol, assetIndex: null, szDecimals: 2, lotSize: 0.01, tickSize: null, maxPxDecimals: 4, maxLeverage: 20,
    isolatedOnly: false, delisted: false, ...m,
  } as Market;
}

export const ETH_BOOK = '9u7aqptdRFbsnnoHtjK13E5JkeM14EW5fAKTRPidVF88';
export const BTC_BOOK = 'AXFz1MuzMUBHi5UKJuK3FDCQ73o3rSzubGU2mPr4LLU7';
export const SOL_BOOK = '71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2';

export const MARKET_LISTS: Record<VenueId, Market[]> = {
  hyperliquid: [
    market('hyperliquid', 'BTC', { assetIndex: 0, szDecimals: 5, lotSize: 1e-5 }),
    market('hyperliquid', 'ETH', { assetIndex: 1, szDecimals: 4, lotSize: 1e-4 }),
    market('hyperliquid', 'SOL', { assetIndex: 5, szDecimals: 2, lotSize: 0.01 }),
    market('hyperliquid', 'DOGE', { assetIndex: 12, szDecimals: 0, lotSize: 1 }),
    market('hyperliquid', 'HYPE', { assetIndex: 159, szDecimals: 2, lotSize: 0.01 }),
    market('hyperliquid', 'LTC', { assetIndex: 2, szDecimals: 2, lotSize: 0.01, delisted: true }),
  ],
  phoenix: [
    market('phoenix', 'ETH', { assetIndex: 2, szDecimals: 3, lotSize: 0.001, tickSize: 0.1, orderbook: ETH_BOOK }),
    market('phoenix', 'BTC', { assetIndex: 1, szDecimals: 4, lotSize: 0.0001, tickSize: 1, orderbook: BTC_BOOK }),
    market('phoenix', 'SOL', { assetIndex: 0, szDecimals: 2, lotSize: 0.01, tickSize: 0.01, orderbook: SOL_BOOK }),
  ],
  orderly: [
    market('orderly', 'PERP_BTC_USDC', { lotSize: 1e-5, tickSize: 0.1 }),
    market('orderly', 'PERP_ETH_USDC', { lotSize: 1e-4, tickSize: 0.01 }),
    market('orderly', 'PERP_SOL_USDC', { lotSize: 0.01, tickSize: 0.001 }),
    market('orderly', 'PERP_DOGE_USDC', { lotSize: 1, tickSize: 0.00001 }),
  ],
};

export const ALL_MARKETS: DeskMarkets = { markets: MARKET_LISTS, failed: {} };

/** Readers that answer only markets(); `fail` venues throw instead, `count` counts the reads. */
export function marketReaders(fail: readonly VenueId[] = []): { readers: VenueReader[]; count: Record<string, number> } {
  const count: Record<string, number> = {};
  const readers = (Object.keys(MARKET_LISTS) as VenueId[]).map((id) => ({
    id,
    markets: async () => {
      count[id] = (count[id] ?? 0) + 1;
      if (fail.includes(id)) throw new Error(`${id} is down`);
      return MARKET_LISTS[id];
    },
  }) as unknown as VenueReader);
  return { readers, count };
}
