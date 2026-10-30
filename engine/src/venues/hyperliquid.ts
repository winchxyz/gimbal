// Hyperliquid reader over the public info endpoint. Everything here is a POST to /info; no keys.

import type { AccountState, Book, BookLevel, Clock, Market, MarketFunding, Position, VenueReader } from './venue.ts';
import { systemClock, trimBook } from './venue.ts';

export const HL_MAINNET_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HL_TESTNET_INFO_URL = 'https://api.hyperliquid-testnet.xyz/info';

const HOUR_MS = 3_600_000;

// Wire shapes, only the fields the reader uses. Numbers arrive as decimal strings.
export interface HlAssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  marginMode?: string;
  isDelisted?: boolean;
}

export interface HlMeta {
  universe: HlAssetMeta[];
}

export interface HlAssetCtx {
  funding: string;
  openInterest: string;
  oraclePx: string;
  markPx: string;
  midPx?: string | null;
  dayNtlVlm: string;
}

export type HlMetaAndAssetCtxs = [HlMeta, HlAssetCtx[]];

export interface HlL2Book {
  coin: string;
  time: number;
  levels: [{ px: string; sz: string; n: number }[], { px: string; sz: string; n: number }[]];
}

export interface HlClearinghouseState {
  marginSummary: { accountValue: string };
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  time: number;
  assetPositions: {
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      liquidationPx: string | null;
      marginUsed: string;
      unrealizedPnl: string;
      leverage: { value: number };
      cumFunding: { sinceOpen: string };
    };
  }[];
}

export interface HyperliquidReaderOptions {
  url?: string;
  fetch?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;
}

export class HyperliquidReader implements VenueReader {
  readonly id = 'hyperliquid' as const;
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #timeoutMs: number;

  constructor(options: HyperliquidReaderOptions = {}) {
    this.#url = options.url ?? HL_MAINNET_INFO_URL;
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async markets(): Promise<Market[]> {
    const [meta] = await this.#info<HlMetaAndAssetCtxs>({ type: 'metaAndAssetCtxs' });
    return parseMarkets(meta);
  }

  async funding(): Promise<MarketFunding[]> {
    const [meta, ctxs] = await this.#info<HlMetaAndAssetCtxs>({ type: 'metaAndAssetCtxs' });
    return parseFunding(meta, ctxs, this.#clock.now());
  }

  async book(symbol: string, depth?: number): Promise<Book> {
    const raw = await this.#info<HlL2Book | null>({ type: 'l2Book', coin: symbol });
    // Hyperliquid answers an unknown coin with null rather than an HTTP error.
    if (raw === null) throw new Error(`hyperliquid l2Book: unknown coin ${symbol}`);
    return trimBook(parseBook(raw), depth);
  }

  async account(address: string): Promise<AccountState> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`hyperliquid: not an EVM address: ${address}`);
    const user = address.toLowerCase();
    const raw = await this.#info<HlClearinghouseState>({ type: 'clearinghouseState', user });
    return parseAccount(user, raw);
  }

  async #info<T>(body: { type: string } & Record<string, unknown>): Promise<T> {
    const res = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`hyperliquid info ${body.type}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}

export function parseMarkets(meta: HlMeta): Market[] {
  return meta.universe.map((a, index) => ({
    venue: 'hyperliquid',
    symbol: a.name,
    assetIndex: index,
    szDecimals: a.szDecimals,
    lotSize: Number(`1e-${a.szDecimals}`),   // parsed, so it is the double nearest the decimal step
    tickSize: null,
    maxPxDecimals: 6 - a.szDecimals,
    maxLeverage: a.maxLeverage,
    isolatedOnly: a.onlyIsolated === true || (a.marginMode !== undefined && a.marginMode !== 'normal'),
    delisted: a.isDelisted === true,
  }));
}

/** Delisted assets are left out: they still carry contexts, but nobody can open a leg there. */
export function parseFunding(meta: HlMeta, ctxs: HlAssetCtx[], now: number): MarketFunding[] {
  if (ctxs.length !== meta.universe.length) {
    throw new Error(`hyperliquid metaAndAssetCtxs: ${meta.universe.length} assets but ${ctxs.length} contexts`);
  }
  // Funding is paid at the top of every hour.
  const nextAt = (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;
  const out: MarketFunding[] = [];
  meta.universe.forEach((a, i) => {
    const c = ctxs[i];
    if (a.isDelisted === true || c === undefined) return;
    out.push({
      venue: 'hyperliquid',
      symbol: a.name,
      ratePerHour: num(c.funding, 'funding'),
      settlement: 'hourly',
      nextAt,
      markPx: optNum(c.markPx),
      oraclePx: optNum(c.oraclePx),
      openInterest: optNum(c.openInterest),
      volume24hUsd: optNum(c.dayNtlVlm),
    });
  });
  return out;
}

export function parseBook(raw: HlL2Book): Book {
  const side = (levels: { px: string; sz: string }[]): BookLevel[] =>
    levels.map((l) => ({ px: num(l.px, 'px'), sz: num(l.sz, 'sz') }));
  return { venue: 'hyperliquid', symbol: raw.coin, time: raw.time, bids: side(raw.levels[0]), asks: side(raw.levels[1]) };
}

export function parseAccount(address: string, raw: HlClearinghouseState): AccountState {
  const positions: Position[] = raw.assetPositions.map(({ position: p }) => ({
    symbol: p.coin,
    size: num(p.szi, 'szi'),
    entryPx: num(p.entryPx, 'entryPx'),
    liqPx: optNum(p.liquidationPx),
    marginUsd: num(p.marginUsed, 'marginUsed'),
    unrealizedPnlUsd: num(p.unrealizedPnl, 'unrealizedPnl'),
    leverage: p.leverage.value,
    // Hyperliquid counts cumFunding as paid (> 0 when the position paid; checked against userFunding
    // deltas on mainnet 2026-10-30), so flip it to received-positive.
    fundingSinceOpenUsd: -num(p.cumFunding.sinceOpen, 'cumFunding.sinceOpen'),
    unsettledFundingUsd: 0,
  }));
  return {
    venue: 'hyperliquid',
    address,
    time: raw.time,
    equityUsd: num(raw.marginSummary.accountValue, 'accountValue'),
    freeMarginUsd: num(raw.withdrawable, 'withdrawable'),
    // Cross positions only: isolated margin is already set aside in each position's marginUsed.
    maintenanceMarginUsd: num(raw.crossMaintenanceMarginUsed, 'crossMaintenanceMarginUsed'),
    positions,
  };
}

function num(s: string, field: string): number {
  const n = Number(s);
  if (s === '' || !Number.isFinite(n)) throw new Error(`hyperliquid: ${field} is not a number: ${JSON.stringify(s)}`);
  return n;
}

function optNum(s: string | null | undefined): number | null {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
