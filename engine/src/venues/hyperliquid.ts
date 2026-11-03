// Hyperliquid reader over the public info endpoint. Everything here is a POST to /info; no keys.

import type {
  AccountState, Book, BookLevel, Clock, FundingHistorySource, FundingPayment, Market, MarketFunding, MarketFundingPoint,
  MarketHistorySource, Position, VenueReader,
} from './venue.ts';
import { systemClock, trimBook } from './venue.ts';
import { baseFields, kiloBase } from './base-symbol.ts';

export type HlNetwork = 'mainnet' | 'testnet';

export const HL_MAINNET_URL = 'https://api.hyperliquid.xyz';
export const HL_TESTNET_URL = 'https://api.hyperliquid-testnet.xyz';
export const HL_MAINNET_INFO_URL = `${HL_MAINNET_URL}/info`;
export const HL_TESTNET_INFO_URL = `${HL_TESTNET_URL}/info`;

const HOUR_MS = 3_600_000;

// userFunding answers at most this many rows per request.
const FUNDING_PAGE_ROWS = 500;
// 100 pages = 50,000 payments, about 3 years of 15 positions: more means the paging is not advancing.
const FUNDING_MAX_PAGES = 100;

// Wire shapes, only the fields the reader uses. Numbers arrive as decimal strings.
export interface HlAssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  marginMode?: string;
  isDelisted?: boolean;
}

// The universe is ordered by asset index, and the index differs per network (ETH is 1 on mainnet, 4 on testnet).
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
      leverage: { type?: string; value: number };
      // Funding paid counts as positive here: the opposite sign to userFunding's `usdc` and to our Position.
      cumFunding: { allTime?: string; sinceOpen: string; sinceChange?: string };
    };
  }[];
}

export interface HlFundingRow {
  time: number;
  hash: string;                  // always the zero hash for funding
  delta: {
    type: string;
    coin: string;
    usdc: string;                // received > 0, paid < 0
    szi: string;
    fundingRate: string;
    nSamples: number | null;
  };
}

export interface HlFundingHistoryRow {
  coin: string;
  fundingRate: string;           // per hour
  premium: string;
  time: number;                  // ms, when the hour's payment was booked (a few ms after the top of the hour)
}

export interface HyperliquidReaderOptions {
  network?: HlNetwork;           // picks the endpoint; default mainnet
  url?: string;                  // full /info URL; overrides the endpoint `network` picks (proxies, tests)
  fetch?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;
}

/** A non-2xx answer from /info, kept apart so callers can tell an outage from a request the venue refused. */
export class HlHttpError extends Error {
  status: number;
  body: string;
  constructor(request: string, status: number, body: string) {
    super(`hyperliquid info ${request}: HTTP ${status} ${body.slice(0, 200)}`);
    this.name = 'HlHttpError';
    this.status = status;
    this.body = body;
  }
}

export class HyperliquidReader implements VenueReader, FundingHistorySource, MarketHistorySource {
  readonly id = 'hyperliquid' as const;
  readonly network: HlNetwork;
  readonly infoUrl: string;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #timeoutMs: number;

  constructor(options: HyperliquidReaderOptions = {}) {
    this.network = options.network ?? 'mainnet';
    this.infoUrl = options.url ?? (this.network === 'testnet' ? HL_TESTNET_INFO_URL : HL_MAINNET_INFO_URL);
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async markets(): Promise<Market[]> {
    const meta = await this.#info<HlMeta>({ type: 'meta' });
    return parseMarkets(meta);
  }

  async funding(): Promise<MarketFunding[]> {
    const [meta, ctxs] = await this.#info<HlMetaAndAssetCtxs>({ type: 'metaAndAssetCtxs' });
    return parseFunding(meta, ctxs, this.#clock.now());
  }

  async book(symbol: string, depth?: number): Promise<Book> {
    let raw: HlL2Book | null;
    try {
      raw = await this.#info<HlL2Book | null>({ type: 'l2Book', coin: symbol });
    } catch (err) {
      // An unknown coin comes back as HTTP 500 with the body `null` (checked on mainnet and testnet 2026-10-30);
      // any other 5xx is an outage and stays one.
      if (err instanceof HlHttpError && err.status === 500 && err.body.trim() === 'null') raw = null;
      else throw err;
    }
    if (raw === null) throw new Error(`hyperliquid l2Book: unknown coin ${symbol}`);
    return trimBook(parseBook(raw), depth);
  }

  async account(address: string): Promise<AccountState> {
    const user = normalizeAddress(address);
    const raw = await this.#info<HlClearinghouseState>({ type: 'clearinghouseState', user });
    return parseAccount(user, raw);
  }

  /**
   * Funding payments of one address with `startTime <= time <= endTime` (ms), oldest first. The venue answers at
   * most 500 rows a request, so this pages through. Rows that share the last timestamp of a page can be cut
   * off by the 500-row limit (a page ended between BTC and ZEC of the same hour on mainnet), so the next page
   * starts at that timestamp itself, not after it, and rows seen twice are dropped.
   * `fundingUsd` is received > 0, paid < 0, as the venue's `usdc` is.
   */
  async userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> {
    const user = normalizeAddress(address);
    if (!Number.isInteger(startTime) || startTime < 0) throw new RangeError(`userFunding startTime must be a ms timestamp, got ${startTime}`);
    if (endTime !== undefined && (!Number.isInteger(endTime) || endTime < startTime)) {
      throw new RangeError(`userFunding endTime must be a ms timestamp >= startTime, got ${endTime}`);
    }
    const out: FundingPayment[] = [];
    const seen = new Set<string>();
    let from = startTime;
    for (let page = 0; ; page++) {
      if (page >= FUNDING_MAX_PAGES) throw new Error(`hyperliquid userFunding: still more rows after ${FUNDING_MAX_PAGES} pages`);
      const rows = await this.#info<HlFundingRow[]>({
        type: 'userFunding', user, startTime: from, ...(endTime === undefined ? {} : { endTime }),
      });
      if (!Array.isArray(rows)) throw new Error('hyperliquid userFunding: expected a list of rows');
      let fresh = 0;
      let last = from;
      for (const row of rows) {
        if (typeof row?.time !== 'number' || typeof row.delta?.coin !== 'string') {
          throw new Error(`hyperliquid userFunding: malformed row ${JSON.stringify(row).slice(0, 120)}`);
        }
        last = Math.max(last, row.time);
        const key = `${row.time}:${row.delta.coin}`;     // the hash is the zero hash on every funding row
        if (seen.has(key)) continue;
        seen.add(key);
        fresh++;
        if (row.delta.type === 'funding') out.push(parseFundingRow(row));
      }
      if (rows.length < FUNDING_PAGE_ROWS) break;
      if (fresh === 0) throw new Error(`hyperliquid userFunding: ${rows.length} rows share one timestamp (${last}); cannot page past them`);
      from = last;
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /**
   * Hourly funding prints of one market with `startTime <= time <= endTime` (ms), oldest first, from the public
   * `fundingHistory`. It answers at most 500 rows a request (about three weeks of hours), so this pages forward.
   */
  async marketFundingHistory(symbol: string, startTime: number, endTime: number, signal?: AbortSignal): Promise<MarketFundingPoint[]> {
    if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || startTime < 0 || endTime < startTime) {
      throw new RangeError(`marketFundingHistory needs ms timestamps with start <= end, got ${startTime}, ${endTime}`);
    }
    const out: MarketFundingPoint[] = [];
    const seen = new Set<number>();
    let from = startTime;
    for (let page = 0; ; page++) {
      if (page >= FUNDING_MAX_PAGES) throw new Error(`hyperliquid fundingHistory: still more rows after ${FUNDING_MAX_PAGES} pages`);
      const rows = await this.#info<HlFundingHistoryRow[]>({ type: 'fundingHistory', coin: symbol, startTime: from, endTime }, signal);
      if (!Array.isArray(rows)) throw new Error('hyperliquid fundingHistory: expected a list of rows');
      let last = from;
      let fresh = 0;
      for (const row of rows) {
        const point = parseFundingHistoryRow(row);
        last = Math.max(last, point.time);
        if (seen.has(point.time) || point.time < startTime || point.time > endTime) continue;
        seen.add(point.time);
        fresh++;
        out.push(point);
      }
      if (rows.length < FUNDING_PAGE_ROWS) break;
      if (fresh === 0) throw new Error(`hyperliquid fundingHistory: a full page added nothing at ${last}; cannot page past it`);
      from = last;
    }
    return out.sort((a, b) => a.time - b.time);
  }

  async #info<T>(body: { type: string } & Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const res = await this.#fetch(this.infoUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HlHttpError(body.type, res.status, text);
    }
    return (await res.json()) as T;
  }
}

function normalizeAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`hyperliquid: not an EVM address: ${address}`);
  return address.toLowerCase();
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
      ...baseFields(hlBase(a.name)),
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

/** The cross-venue key of a main-dex coin: "kPEPE" is 1000 PEPE; every other name is its own base. */
export function hlBase(coin: string): { base: string; multiplier: number } {
  return kiloBase(coin);
}

export function parseFundingHistoryRow(row: HlFundingHistoryRow): MarketFundingPoint {
  if (typeof row?.time !== 'number' || typeof row.coin !== 'string') {
    throw new Error(`hyperliquid fundingHistory: malformed row ${JSON.stringify(row).slice(0, 120)}`);
  }
  return { time: row.time, symbol: row.coin, ratePerHour: num(row.fundingRate, 'fundingRate'), periodHours: 1 };
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
    // cumFunding counts funding PAID as positive (a long on a positive rate shows > 0). On mainnet 2026-10-30 its
    // sinceOpen equalled minus the sum of the userFunding `usdc` rows since the open to the last digit, for a
    // long and a short (see the fixture test), so flip it to received-positive.
    fundingSinceOpenUsd: -num(p.cumFunding.sinceOpen, 'cumFunding.sinceOpen') || 0,   // `|| 0`: no negative zero
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

export function parseFundingRow(row: HlFundingRow): FundingPayment {
  return {
    time: row.time,
    symbol: row.delta.coin,       // builder-deployed markets keep their dex prefix ("xyz:NVDA")
    fundingUsd: num(row.delta.usdc, 'usdc'),
    size: num(row.delta.szi, 'szi'),
    ratePerHour: num(row.delta.fundingRate, 'fundingRate'),
    samples: row.delta.nSamples ?? null,
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
