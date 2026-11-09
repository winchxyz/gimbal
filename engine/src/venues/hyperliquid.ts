// Hyperliquid reader over the public info endpoint. Everything here is a POST to /info; no keys.
//
// Request weight. Hyperliquid allows 1200 weight a minute per IP across its REST API (docs, "Rate limits and user
// limits"): clearinghouseState, l2Book, allMids, orderStatus, spotClearinghouseState and exchangeStatus weigh 2,
// userRole 60, every other info request 20, and the list answers (fundingHistory, userFunding, userFillsByTime, the
// ledger updates and a few more) 1 more per 20 rows they return. Every reader of the host in one process goes through
// one weight budget (http-budget.ts HL_BUDGET, which says what serve spends and why it stays under the limit): a read
// is charged its weight before it is sent (a history read: with the rows its hours should bring), and the rows an
// answer really brought once it is in.

import type { HostBudget, ReadKind } from './http-budget.ts';
import { HL_BUDGET, hostBudget, readClass, requestTimeoutMs } from './http-budget.ts';
import type { DeskActStamp } from './desk-acts.ts';
import { deskActStamp, stillReusable } from './desk-acts.ts';
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
  prevDayPx?: string;
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
  /**
   * The weight budget (http-budget.ts). Default: the one every reader of this host in the process shares, unless a
   * `fetch` is passed (tests, capture), which then goes without one; null: none.
   */
  budget?: HostBudget | null;
}

/** Info requests that weigh 2; userRole weighs 60; every other one 20. */
const LIGHT_INFO = new Set(['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus']);
/** Info answers that weigh 1 more per 20 rows (the docs' list, with the ledger read under both of its names). */
const PER_ROW_INFO = new Set([
  'recentTrades', 'historicalOrders', 'userFills', 'userFillsByTime', 'fundingHistory', 'userFunding', 'nonUserFundingUpdates',
  'userNonFundingLedgerUpdates', 'twapHistory', 'userTwapSliceFills', 'userTwapSliceFillsByTime', 'delegatorHistory',
  'delegatorRewards', 'validatorStats',
]);

/** The weight of an info request of `type` before its rows (docs, see the header). */
export function hlInfoWeight(type: string): number {
  if (LIGHT_INFO.has(type)) return 2;
  return type === 'userRole' ? 60 : 20;
}

/** The weight `rows` rows of an answer of `type` add: 1 per 20 (rounded up) for the list answers, 1 per 60 for candles. */
export function hlRowsWeight(type: string, rows: number): number {
  if (!(rows > 0)) return 0;
  if (PER_ROW_INFO.has(type)) return Math.ceil(rows / 20);
  return type === 'candleSnapshot' ? Math.ceil(rows / 60) : 0;
}

/** The rows a request should bring, charged before it is sent: a fundingHistory window's hours (500 at most). */
export function hlRowsExpected(body: { type: string } & Record<string, unknown>): number {
  if (body.type !== 'fundingHistory' || typeof body.startTime !== 'number') return 0;
  const end = typeof body.endTime === 'number' ? body.endTime : Date.now();
  return Math.min(FUNDING_PAGE_ROWS, Math.max(1, Math.ceil((end - body.startTime) / HOUR_MS)));
}

/** The budget class an info request of `type` reads as (critical outside the scanner, http-budget.ts readClass). */
export function hlReadKind(type: string): ReadKind {
  if (type === 'l2Book') return 'book';
  if (type === 'fundingHistory') return 'history';
  if (type === 'metaAndAssetCtxs' || type === 'meta' || type === 'predictedFundings') return 'funding';
  return 'account';
}

/** The budget every reader of `infoUrl`'s host shares in this process (HL_BUDGET). */
export function hlHostBudget(infoUrl: string = HL_MAINNET_INFO_URL): HostBudget {
  return hostBudget(infoUrl, HL_BUDGET);
}

/**
 * Sends one /info request through `budget` (none: as is): charged its weight and the rows it should bring, in the
 * class its type and the caller's context give, and once a list answer is in, the rows it really brought (a refund
 * when fewer). `send` is called when the budget lets it go. A read the budget skips rejects with ReadSkipped.
 */
export async function hlBudgetedSend(budget: HostBudget | null, body: { type: string } & Record<string, unknown>, send: () => Promise<Response>): Promise<Response> {
  if (budget === null) return send();
  const expected = hlRowsExpected(body);
  const charged = hlRowsWeight(body.type, expected);
  const res = await budget.run(readClass(hlReadKind(body.type)), send, hlInfoWeight(body.type) + charged);
  if (res.ok && (PER_ROW_INFO.has(body.type) || body.type === 'candleSnapshot')) {
    // A copy of the body: the caller reads the answer as before. Rows of an answer that cannot be read count as none.
    res.clone().json().then(
      (rows: unknown) => budget.charge(hlRowsWeight(body.type, Array.isArray(rows) ? rows.length : 0) - charged),
      () => budget.charge(-charged),
    );
  }
  return res;
}

/**
 * `inner` with every /info POST sent through `budget` (hlBudgetedSend; the request's JSON body names its type), for
 * callers that post to /info themselves (the position book's ledger reads). Anything else goes as is.
 */
export function hlBudgetedFetch(budget: HostBudget, inner: typeof fetch): typeof fetch {
  return (input, init) => {
    let body: unknown = null;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    } catch {
      body = null;
    }
    const typed = body as ({ type?: unknown } & Record<string, unknown>) | null;
    if (typed === null || typeof typed.type !== 'string') return inner(input, init);
    return hlBudgetedSend(budget, typed as { type: string } & Record<string, unknown>, () => inner(input, init));
  };
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
  readonly #budget: HostBudget | null;
  /** Each address's last account answer, when it was asked for and under which desk-act stamp (accountWithin). */
  readonly #lastAccount = new Map<string, { at: number; value: AccountState; stamp: DeskActStamp }>();

  constructor(options: HyperliquidReaderOptions = {}) {
    this.network = options.network ?? 'mainnet';
    this.infoUrl = options.url ?? (this.network === 'testnet' ? HL_TESTNET_INFO_URL : HL_MAINNET_INFO_URL);
    // Looked up when called, not bound here: a test may stub the global fetch after the reader is made.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#budget = options.budget !== undefined ? options.budget : options.fetch === undefined ? hlHostBudget(this.infoUrl) : null;
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
    const at = this.#clock.now();
    const stamp = deskActStamp();
    const raw = await this.#info<HlClearinghouseState>({ type: 'clearinghouseState', user });
    const value = parseAccount(user, raw);
    const last = this.#lastAccount.get(user);
    if (last === undefined || at >= last.at) this.#lastAccount.set(user, { at, value, stamp });
    return value;
  }

  /**
   * The account as read at most `maxAgeMs` ago by anyone in this process (the risk engine reads it every 5 s), else
   * read now: for callers that need it only roughly fresh (the strategy loop's free margin), so they add no request.
   * Never across the desk's own act (desk-acts.ts): sizing takes the margin after it.
   */
  async accountWithin(address: string, maxAgeMs: number): Promise<AccountState> {
    const user = normalizeAddress(address);
    const last = this.#lastAccount.get(user);
    const now = this.#clock.now();
    if (last !== undefined && stillReusable(last.stamp) && now >= last.at && now - last.at <= maxAgeMs) return last.value;
    return this.account(user);
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
    // The timeout runs from when the budget lets the request go, and ends at the caller's deadline (readBy) if sooner.
    const send = () => {
      const timeout = AbortSignal.timeout(requestTimeoutMs(this.#timeoutMs));
      return this.#fetch(this.infoUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      });
    };
    const res = await hlBudgetedSend(this.#budget, body, send);
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
      ...(optNum(c.prevDayPx) === null ? {} : { prevDayPx: optNum(c.prevDayPx) }),
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
