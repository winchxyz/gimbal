// Orderly reader. Markets, funding and funding-rate history over public REST; the order book over the public
// WebSocket only (Orderly serves no REST book to the public); the account over the desk's private WebSocket session
// (orderly-stream.ts, one signature per session); the desk's own funding history over a signed REST read
// (orderly-actions.ts). Without a desk, account() and userFunding() refuse: nothing here signs.
//
// Orderly lists every broker's own markets (PERP_X_USDC_<broker>) next to the shared ones (PERP_X_USDC). A desk can
// trade the shared ones and its own broker's only, so markets() and funding() return just those; a broker market
// keeps its full symbol and never maps to the shared base symbol (orderlyBaseSymbol).

import type {
  AccountState, Book, BookLevel, Clock, FundingHistorySource, FundingPayment, Market, MarketFunding, MarketHistorySource,
  Position, VenueReader,
} from './venue.ts';
import { systemClock, trimBook } from './venue.ts';
import { baseFields } from './base-symbol.ts';
import type { OrderlyEndpoints, OrderlyNetwork } from './orderly-http.ts';
import { ORDERLY_ENDPOINTS, normalizeAccountId, readOrderlyData } from './orderly-http.ts';
import type { OrderlyFundingFeePage, OrderlyFundingFeeRow } from './orderly-actions.ts';
import type { OrderlyAccountSnapshot } from './orderly-stream.ts';
import {
  maxLeverageFromImr, positionImr, positionMmr, ratePerHourFromPeriod, settlementForPeriod, stepDecimals,
  unsettledFundingUsd, unsettledPnlUsd,
} from './orderly-units.ts';
import type { WsRequester } from './ws.ts';
import { WsRequestClient } from './ws.ts';

// Static market parameters change only with a listing; funding() and account() reuse them this long.
const INFO_TTL_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
/** account() refuses stream state the server has not confirmed for this long (the stream's own watchdog is 30 s too). */
export const ORDERLY_MAX_STATE_AGE_MS = 30_000;
const FUNDING_FEE_PAGE_ROWS = 500;
const FUNDING_FEE_MAX_PAGES = 200;
const RATE_HISTORY_PAGE_ROWS = 500;
const RATE_HISTORY_MAX_PAGES = 100;

// Wire shapes, only the fields the reader uses.
export interface OrderlyInfoRow {
  symbol: string;
  broker_id: string | null;
  status: string;
  base_tick: number;
  quote_tick: number;
  base_min: number;
  min_notional: number;
  base_imr: number;
  base_mmr: number;
  imr_factor: number;
  funding_period: number;        // hours
}

export interface OrderlyFuturesRow {
  symbol: string;
  status: string;
  index_price: number;
  mark_price: number;
  sum_unitary_funding: number;
  est_funding_rate: number;      // per funding period, for the period ending at next_funding_time
  last_funding_rate: number;
  next_funding_time: number;     // ms
  open_interest: number;         // base units
  '24h_amount': number;          // USD
}

export interface OrderlyRateHistoryRow {
  symbol: string;
  funding_rate: number;          // per funding period
  funding_rate_timestamp: number;   // ms
  next_funding_time?: number;    // ms; with funding_rate_timestamp it gives the row's own period
}

interface OrderlyPageMeta {
  total?: number;
  records_per_page?: number;
  current_page?: number;
}

/** The desk's Orderly account, with the age of what the private stream pushed. `time` is when the server last spoke. */
export interface OrderlyAccountState extends AccountState {
  positionsPushedAt: number;     // venue ms of the last position push (local ms of the session's seed read before one)
  balancesPushedAt: number;      // venue ms of the last balance push (likewise)
  /**
   * Symbols whose fundingSinceOpenUsd is not known: their row comes from the session's seed read, which carries no
   * accrued funding fee, and they have not pushed since. Their fundingSinceOpenUsd reads 0 and must not be shown.
   */
  fundingUnknown: string[];
}

/** An Orderly market, with what sizing and the broker split need on top of the shared shape. */
export interface OrderlyMarket extends Market {
  brokerId: string | null;       // a broker's own market (PERP_X_USDC_<broker>), null for the shared ones
  baseMin: number;
  minNotional: number;
  fundingPeriodHours: number;
  baseImr: number;
  baseMmr: number;
  imrFactor: number;
}

/** One funding print of a market. */
export interface OrderlyMarketFundingPoint {
  time: number;                  // ms
  symbol: string;
  ratePerHour: number;           // > 0 means longs pay shorts
  ratePerPeriod: number;
  periodHours: number;
}

/** What the reader needs from the desk's private side; OrderlyAccountStream and OrderlyDeskClient provide it. */
export interface OrderlyAccountSource {
  readonly accountId: string;
  state(): Promise<OrderlyAccountSnapshot>;
}

export interface OrderlyFundingFeeSource {
  readonly accountId: string;
  fundingFeeHistory(startMs: number, endMs: number, page: number, size: number): Promise<OrderlyFundingFeePage>;
}

export interface OrderlyReaderOptions {
  network?: OrderlyNetwork;
  apiUrl?: string;
  publicWsUrl?: string;
  fetch?: typeof fetch;
  /** Public WebSocket request/answer (book). Default: a WsRequestClient that answers Orderly's pings. */
  wsRequest?: WsRequester;
  /**
   * A registered account id for the public stream's path: Orderly closes the public stream for an id it does not
   * know. The desk's own id once it has one; without it the reader borrows one from the public leaderboard (mainnet).
   */
  streamAccountId?: string;
  accountStream?: OrderlyAccountSource;
  fundingFees?: OrderlyFundingFeeSource;
  /** The desk's broker id: its own markets are listed next to the shared ones. Default none: shared markets only. */
  brokerId?: string | null;
  /** account() refuses stream state older than this (ms since the server's last frame); default 30 s. */
  maxStateAgeMs?: number;
  /** Where a skipped row is reported (userFunding); default console.warn. */
  onNote?: (note: string) => void;
  clock?: Clock;
  timeoutMs?: number;
}

/** Orderly's keep-alive: the server sends {"event":"ping"} every 10 s and closes a stream that does not answer. */
export function orderlyKeepAlive(msg: Record<string, unknown>): Record<string, unknown> | null {
  return msg.event === 'ping' ? { event: 'pong', ts: msg.ts } : null;
}

/** The venue's symbol for a base asset: "SOL" -> "PERP_SOL_USDC" (a shared market); a full symbol is kept as it is. */
export function orderlySymbol(base: string): string {
  return base.startsWith('PERP_') ? base : `PERP_${base}_USDC`;
}

/**
 * The base asset of a shared market: "PERP_SOL_USDC" -> "SOL". A broker's own market ("PERP_SOL_USDC_<broker>") is
 * another market with its own book and fees, so it has no shared base symbol: null.
 */
export function orderlyBaseSymbol(symbol: string): string | null {
  const m = /^PERP_([A-Za-z0-9]+)_USDC$/.exec(symbol);
  return m === null ? null : m[1]!;
}

/**
 * Orderly names that are another venue's base under a different name: marks agreed within 0.1 % with Phoenix's
 * GOLD, SILVER and WTIOIL on 2026-10-31 (XAU 3890.61 / 3888.2, XAG 49.39 / 49.407, CL 103.05 / 103.11).
 */
export const ORDERLY_ALIASES: Readonly<Record<string, string>> = { XAU: 'GOLD', XAG: 'SILVER', CL: 'WTIOIL' };

/**
 * The cross-venue key of an Orderly market: "PERP_SOL_USDC" -> SOL, "PERP_1000PEPE_USDC" -> 1000 PEPE, aliases
 * applied. A broker's own market keeps its full symbol as its key, so it never pairs with the shared one.
 */
export function orderlyBase(symbol: string): { base: string; multiplier: number } {
  const name = orderlyBaseSymbol(symbol);
  if (name === null) return { base: symbol, multiplier: 1 };
  const thousand = /^1000([A-Z0-9]+)$/.exec(name);
  if (thousand !== null) return { base: thousand[1]!, multiplier: 1000 };
  return { base: ORDERLY_ALIASES[name] ?? name, multiplier: 1 };
}

/** A market the desk can trade: a shared one, or its own broker's. */
export function tradableByBroker(row: { broker_id: string | null }, brokerId: string | null): boolean {
  return row.broker_id === null || (brokerId !== null && row.broker_id === brokerId);
}

export class OrderlyReader implements VenueReader, FundingHistorySource, MarketHistorySource {
  readonly id = 'orderly' as const;
  readonly network: OrderlyNetwork;
  readonly apiUrl: string;
  readonly #endpoints: OrderlyEndpoints;
  readonly #publicWs: string;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly brokerId: string | null;
  readonly #accountStream: OrderlyAccountSource | undefined;
  readonly #fundingFees: OrderlyFundingFeeSource | undefined;
  readonly #maxStateAgeMs: number;
  readonly #note: (note: string) => void;
  #wsRequest: WsRequester | null;
  #ownWs: WsRequestClient | null = null;
  #streamId: Promise<string> | null;
  #info: { at: number; value: Promise<OrderlyInfoRow[]> } | null = null;
  #requests = 0;

  constructor(options: OrderlyReaderOptions = {}) {
    this.network = options.network ?? 'mainnet';
    this.#endpoints = ORDERLY_ENDPOINTS[this.network];
    this.apiUrl = (options.apiUrl ?? this.#endpoints.api).replace(/\/+$/, '');
    this.#publicWs = options.publicWsUrl ?? this.#endpoints.publicWs;
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.brokerId = options.brokerId ?? null;
    this.#accountStream = options.accountStream;
    this.#fundingFees = options.fundingFees;
    this.#maxStateAgeMs = options.maxStateAgeMs ?? ORDERLY_MAX_STATE_AGE_MS;
    this.#note = options.onNote ?? ((note) => console.warn(note));
    this.#wsRequest = options.wsRequest ?? null;
    this.#streamId = options.streamAccountId === undefined ? null : Promise.resolve(normalizeAccountId(options.streamAccountId));
  }

  /** The shared markets and the desk's own broker's. */
  async markets(): Promise<OrderlyMarket[]> {
    return parseMarkets((await this.#infoRows(true)).filter((r) => tradableByBroker(r, this.brokerId)));
  }

  /**
   * The estimated rate of the running period (what is paid at next_funding_time), per hour, for the markets the desk
   * can trade. Inactive markets, and markets whose period has not rolled for two periods (stale), are left out.
   */
  async funding(): Promise<MarketFunding[]> {
    const [futures, info] = await Promise.all([this.#futures(), this.#infoRows(false)]);
    return parseFunding(futures, info, this.#clock.now(), this.brokerId);
  }

  async book(symbol: string, depth?: number): Promise<Book> {
    // The public stream's path needs an account id, borrowed once over REST: a failure says it was that step, not
    // the book request, which the WebSocket answers in well under a second.
    let accountId: string;
    try {
      accountId = await this.#streamAccountId();
    } catch (err) {
      throw new Error(`orderly book ${symbol}: no public stream account id: ${(err as Error).message}`);
    }
    const url = `${this.#publicWs}${accountId}`;
    const answer = await this.#ws()(url, { id: `book-${++this.#requests}`, event: 'request', params: { type: 'orderbook', symbol } });
    return trimBook(parseBookAnswer(symbol, answer), depth);
  }

  /**
   * `address` is the desk's Orderly account id; the state comes from its private stream session, priced at the
   * current REST mark. `time` is when the server last confirmed the stream; older than maxStateAgeMs throws.
   */
  async account(address: string): Promise<OrderlyAccountState> {
    const accountId = normalizeAccountId(address);
    const stream = this.#accountStream;
    if (stream === undefined) throw new Error('orderly account: needs the desk\'s private stream session (accountStream)');
    if (stream.accountId !== accountId) throw new Error(`orderly account: the stream is for ${stream.accountId}, not ${accountId}`);
    const [snapshot, futures, info] = await Promise.all([stream.state(), this.#futures(), this.#infoRows(false)]);
    return parseAccount(snapshot, futures, info, this.#clock.now(), this.#maxStateAgeMs);
  }

  /**
   * The desk's funding payments with `startTime <= time <= endTime` (ms), oldest first, over a signed read (one
   * signature per page). `fundingUsd` is received > 0, paid < 0, from Orderly's payment_type.
   */
  async userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> {
    const accountId = normalizeAccountId(address);
    const source = this.#fundingFees;
    if (source === undefined) throw new Error('orderly userFunding: needs the desk\'s signed client (fundingFees)');
    if (source.accountId !== accountId) throw new Error(`orderly userFunding: the client is for ${source.accountId}, not ${accountId}`);
    if (!Number.isInteger(startTime) || startTime < 0) throw new RangeError(`userFunding startTime must be a ms timestamp, got ${startTime}`);
    const end = endTime ?? this.#clock.now();
    if (!Number.isInteger(end) || end < startTime) throw new RangeError(`userFunding endTime must be a ms timestamp >= startTime, got ${endTime}`);
    // The fee rows carry no period of their own (row fields: verify on day 5), so it comes from /v1/public/info.
    const periods = periodsBySymbol(await this.#infoRows(false));
    const rows: OrderlyFundingFeeRow[] = [];
    for (let page = 1; ; page++) {
      if (page > FUNDING_FEE_MAX_PAGES) throw new Error(`orderly userFunding: still more rows after ${FUNDING_FEE_MAX_PAGES} pages`);
      const res = await source.fundingFeeHistory(startTime, end, page, FUNDING_FEE_PAGE_ROWS);
      rows.push(...res.rows);
      if (!morePages(res.rows.length, FUNDING_FEE_PAGE_ROWS, rows.length, res.meta)) break;
    }
    const out: FundingPayment[] = [];
    const skipped = new Map<string, number>();
    for (const row of rows) {
      if (row.created_time < startTime || row.created_time > end) continue;
      const period = periods.get(row.symbol);
      if (period === undefined) {
        skipped.set(row.symbol, (skipped.get(row.symbol) ?? 0) + 1);
        continue;
      }
      out.push(parseFundingFeeRow(row, period));
    }
    for (const [symbol, n] of skipped) {
      this.#note(`orderly userFunding: skipped ${n} payment(s) on ${symbol}: no funding period (not in /v1/public/info)`);
    }
    return out.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  }

  /** Funding prints of one market with `startTime <= time <= endTime` (ms), oldest first, from public REST. */
  async marketFundingHistory(symbol: string, startTime: number, endTime: number): Promise<OrderlyMarketFundingPoint[]> {
    if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || endTime < startTime) {
      throw new RangeError(`marketFundingHistory needs ms timestamps with start <= end, got ${startTime}, ${endTime}`);
    }
    const info = await this.#get<OrderlyInfoRow>(`/v1/public/info/${encodeURIComponent(symbol)}`, 'public/info');
    const rows: OrderlyRateHistoryRow[] = [];
    for (let page = 1; ; page++) {
      if (page > RATE_HISTORY_MAX_PAGES) throw new Error(`orderly funding_rate_history: still more rows after ${RATE_HISTORY_MAX_PAGES} pages`);
      const q = new URLSearchParams({
        symbol, start_t: String(startTime), end_t: String(endTime), page: String(page), size: String(RATE_HISTORY_PAGE_ROWS),
      });
      const res = await this.#get<{ rows: OrderlyRateHistoryRow[]; meta?: OrderlyPageMeta }>(`/v1/public/funding_rate_history?${q}`, 'funding_rate_history');
      rows.push(...res.rows);
      if (!morePages(res.rows.length, RATE_HISTORY_PAGE_ROWS, rows.length, res.meta)) break;
    }
    return rows
      .filter((r) => r.funding_rate_timestamp >= startTime && r.funding_rate_timestamp <= endTime)
      .map((r) => {
        // A market's period can change; a row that names its next funding time says which period it covered.
        const periodHours = rowPeriodHours(r) ?? info.funding_period;
        return {
          time: r.funding_rate_timestamp,
          symbol: r.symbol,
          ratePerHour: ratePerHourFromPeriod(r.funding_rate, periodHours),
          ratePerPeriod: r.funding_rate,
          periodHours,
        };
      })
      .sort((a, b) => a.time - b.time);
  }

  /** Closes the reader's own public WebSocket, if it made one. */
  close(): void {
    this.#ownWs?.close();
  }

  #ws(): WsRequester {
    if (this.#wsRequest === null) {
      this.#ownWs = new WsRequestClient({ keepAlive: orderlyKeepAlive, timeoutMs: this.#timeoutMs });
      this.#wsRequest = this.#ownWs.request;
    }
    return this.#wsRequest;
  }

  #streamAccountId(): Promise<string> {
    if (this.#streamId === null) {
      const p = this.#borrowStreamId();
      this.#streamId = p;
      p.catch(() => {
        if (this.#streamId === p) this.#streamId = null;
      });
    }
    return this.#streamId;
  }

  /**
   * A registered account id from the public leaderboard: the most active EVM trader of SOL (the public stream is
   * the EVM one; the leaderboard also lists Solana wallets). Public data only.
   */
  async #borrowStreamId(): Promise<string> {
    const res = await this.#fetch(`${this.apiUrl}/v1/public/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'topAddresses', symbol: 'PERP_SOL_USDC', sort_by: 'volume_7d', limit: 20 }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    let top: { rows?: { address: string; broker_id: string }[] };
    try {
      top = await readOrderlyData<{ rows?: { address: string; broker_id: string }[] }>(res, 'public/query topAddresses');
    } catch (err) {
      throw new Error(`orderly book: no account id for the public stream (set streamAccountId): ${(err as Error).message}`);
    }
    const row = top.rows?.find((r) => /^0x[0-9a-fA-F]{40}$/.test(r.address));
    if (row === undefined) throw new Error('orderly book: no EVM trader on the leaderboard; set streamAccountId');
    const q = new URLSearchParams({ address: row.address, broker_id: row.broker_id, chain_type: 'EVM' });
    const account = await this.#get<{ account_id: string }>(`/v1/get_account?${q}`, 'get_account');
    return normalizeAccountId(account.account_id);
  }

  #futures(): Promise<OrderlyFuturesRow[]> {
    return this.#get<{ rows: OrderlyFuturesRow[] }>('/v1/public/futures', 'public/futures').then((d) => d.rows);
  }

  #infoRows(fresh: boolean): Promise<OrderlyInfoRow[]> {
    const now = this.#clock.now();
    if (!fresh && this.#info !== null && now - this.#info.at < INFO_TTL_MS) return this.#info.value;
    const value = this.#get<{ rows: OrderlyInfoRow[] }>('/v1/public/info', 'public/info').then((d) => d.rows);
    const entry = { at: now, value };
    this.#info = entry;
    value.catch(() => {
      if (this.#info === entry) this.#info = null;
    });
    return value;
  }

  async #get<T>(path: string, what: string): Promise<T> {
    const res = await this.#fetch(`${this.apiUrl}${path}`, { method: 'GET', signal: AbortSignal.timeout(this.#timeoutMs) });
    return readOrderlyData<T>(res, what);
  }
}

/**
 * Whether to ask for the next page, after one that returned `got` rows (`seen` in all so far) when `requested` were
 * asked for. The venue may cap a page below the size asked for: a short page is measured against its
 * records_per_page when it says, and `total` (when given) ends the walk once every row is in.
 */
export function morePages(got: number, requested: number, seen: number, meta: OrderlyPageMeta | undefined): boolean {
  if (got === 0) return false;
  const total = meta?.total;
  if (total !== undefined && seen >= total) return false;
  const perPage = meta?.records_per_page;
  if (perPage !== undefined && perPage > 0) return got >= perPage;
  if (total !== undefined) return true;
  return got >= requested;
}

/** A history row's own period in whole hours, from its timestamp and next funding time; null when it does not say. */
function rowPeriodHours(r: OrderlyRateHistoryRow): number | null {
  if (r.next_funding_time === undefined) return null;
  const hours = (r.next_funding_time - r.funding_rate_timestamp) / HOUR_MS;
  return Number.isInteger(hours) && hours > 0 ? hours : null;
}

function periodsBySymbol(info: readonly OrderlyInfoRow[]): Map<string, number> {
  return new Map(info.map((r) => [r.symbol, r.funding_period]));
}

export function parseMarkets(info: readonly OrderlyInfoRow[]): OrderlyMarket[] {
  return info.map((r) => ({
    venue: 'orderly',
    symbol: r.symbol,
    assetIndex: null,
    szDecimals: stepDecimals(r.base_tick),
    lotSize: r.base_tick,
    tickSize: r.quote_tick,
    maxPxDecimals: stepDecimals(r.quote_tick),
    maxLeverage: maxLeverageFromImr(r.base_imr),
    isolatedOnly: false,
    delisted: r.status !== 'ACTIVE',
    brokerId: r.broker_id,
    baseMin: r.base_min,
    minNotional: r.min_notional,
    fundingPeriodHours: r.funding_period,
    baseImr: r.base_imr,
    baseMmr: r.base_mmr,
    imrFactor: r.imr_factor,
  }));
}

/**
 * The running period's estimate per hour. Left out: markets that are not active, other brokers' markets, periods the
 * shared type cannot name, and stale rows: a next_funding_time more than one period in the past means the last
 * booking is over two periods old, so the estimate is not current.
 */
export function parseFunding(
  futures: readonly OrderlyFuturesRow[], info: readonly OrderlyInfoRow[], now: number, brokerId: string | null = null,
): MarketFunding[] {
  const infoBySymbol = new Map(info.map((r) => [r.symbol, r]));
  const out: MarketFunding[] = [];
  for (const f of futures) {
    if (f.status !== 'ACTIVE') continue;
    const i = infoBySymbol.get(f.symbol);
    if (i === undefined || !tradableByBroker(i, brokerId)) continue;
    const period = i.funding_period;
    const settlement = settlementForPeriod(period);
    if (settlement === null) continue;
    if (!Number.isFinite(f.next_funding_time) || f.next_funding_time < now - period * HOUR_MS) continue;
    out.push({
      venue: 'orderly',
      symbol: f.symbol,
      ...baseFields(orderlyBase(f.symbol)),
      ratePerHour: ratePerHourFromPeriod(f.est_funding_rate, period),
      settlement,
      nextAt: f.next_funding_time,
      markPx: finiteOrNull(f.mark_price),
      oraclePx: finiteOrNull(f.index_price),
      openInterest: finiteOrNull(f.open_interest),
      volume24hUsd: finiteOrNull(f['24h_amount']),
    });
  }
  return out;
}

/** The answer to a public-stream orderbook request: {success, data: {symbol, ts, asks, bids}} or {success: false, errorMsg}. */
export function parseBookAnswer(symbol: string, answer: Record<string, unknown>): Book {
  if (answer.success !== true) {
    const reason = String(answer.errorMsg ?? 'no reason given');
    if (/invalid symbol/i.test(reason)) throw new Error(`orderly orderbook: unknown symbol ${symbol}`);
    throw new Error(`orderly orderbook ${symbol}: ${reason}`);
  }
  const data = answer.data as { symbol: string; ts: number; asks: [number, number][]; bids: [number, number][] };
  const side = (levels: [number, number][]): BookLevel[] => levels.map(([px, sz]) => ({ px, sz }));
  return { venue: 'orderly', symbol: data.symbol, time: data.ts, bids: side(data.bids), asks: side(data.asks) };
}

/**
 * The desk's account from its stream cache, re-priced at the current mark and sum_unitary_funding (REST):
 * equity = USDC holding + every position's unsettled PnL (price PnL and unsettled funding); maintenance and
 * initial margin from Orderly's IMR/MMR formulas (or the rates the stream pushed); free = equity - initial - frozen.
 * Nothing missing is read as zero: no USDC balance, no REST mark or funding sum for a held symbol, or stream state the
 * server last confirmed more than `maxAgeMs` before `now` all throw. `time` is that confirmation, not `now`.
 */
export function parseAccount(
  snapshot: OrderlyAccountSnapshot, futures: readonly OrderlyFuturesRow[], info: readonly OrderlyInfoRow[], now: number,
  maxAgeMs: number = ORDERLY_MAX_STATE_AGE_MS,
): OrderlyAccountState {
  const age = now - snapshot.confirmedAt;
  if (age > maxAgeMs) {
    throw new Error(`orderly account: stale: the private stream last heard from the server ${age} ms ago (limit ${maxAgeMs} ms)`);
  }
  const futuresBySymbol = new Map(futures.map((f) => [f.symbol, f]));
  const infoBySymbol = new Map(info.map((r) => [r.symbol, r]));
  const badUsdc = snapshot.invalidBalances.USDC ?? snapshot.invalidBalances['*'];
  if (badUsdc !== undefined) throw new Error(`orderly account: the USDC balance push is unusable: ${badUsdc}`);
  const usdc = snapshot.balances.USDC;
  if (usdc === undefined) throw new Error('orderly account: the private stream pushed no USDC balance');
  let equity = usdc.holding;
  let initial = 0;
  let maintenance = 0;
  const positions: Position[] = [];
  const fundingUnknown: string[] = [];
  for (const p of snapshot.positions) {
    if (p.positionQty === 0) continue;
    if (p.accruedFundingFee === undefined) fundingUnknown.push(p.symbol);
    const f = futuresBySymbol.get(p.symbol);
    const i = infoBySymbol.get(p.symbol);
    if (i === undefined) throw new Error(`orderly account: no market info for ${p.symbol} in /v1/public/info`);
    if (f === undefined) throw new Error(`orderly account: no ${p.symbol} row in /v1/public/futures (mark price and funding sum missing)`);
    const mark = f.mark_price;
    const suf = f.sum_unitary_funding;
    if (!(typeof mark === 'number' && mark > 0)) throw new Error(`orderly account: no usable mark price for ${p.symbol}: ${JSON.stringify(mark)}`);
    if (!(typeof suf === 'number' && Number.isFinite(suf))) throw new Error(`orderly account: no usable sum_unitary_funding for ${p.symbol}: ${JSON.stringify(suf)}`);
    const notional = Math.abs(p.positionQty) * mark;
    const imr = p.imr ?? positionImr(notional, i.base_imr, i.imr_factor);
    const mmr = p.mmr ?? positionMmr(notional, i.base_mmr, i.base_imr, i.imr_factor);
    const marginUsd = notional * imr;
    equity += unsettledPnlUsd(p.positionQty, mark, p.costPosition, suf, p.lastSumUnitaryFunding);
    initial += marginUsd;
    maintenance += notional * mmr;
    positions.push({
      symbol: p.symbol,
      size: p.positionQty,
      entryPx: p.averageOpenPrice,
      liqPx: p.estLiqPrice > 0 ? p.estLiqPrice : null,          // Orderly sends 0 when there is none
      marginUsd,
      unrealizedPnlUsd: p.positionQty * (mark - p.averageOpenPrice) || 0,
      leverage: 1 / imr,
      // ASSUMPTION: accruedFundingFee is paid > 0 like Hyperliquid's cumFunding, so it is flipped. Verify the sign
      // on the first testnet position (C5).
      fundingSinceOpenUsd: p.accruedFundingFee === undefined ? 0 : -p.accruedFundingFee || 0,
      unsettledFundingUsd: unsettledFundingUsd(p.positionQty, suf, p.lastSumUnitaryFunding),
    });
  }
  return {
    venue: 'orderly',
    address: snapshot.accountId,
    time: snapshot.confirmedAt,
    equityUsd: equity,
    freeMarginUsd: Math.max(0, equity - initial - usdc.frozen),
    maintenanceMarginUsd: maintenance,
    positions,
    positionsPushedAt: snapshot.positionsAt,
    balancesPushedAt: snapshot.balancesAt,
    fundingUnknown,
  };
}

/**
 * One funding fee row. Orderly gives the amount unsigned with payment_type Pay or Receive, and no position size:
 * the size is recovered as fee / (rate x mark), long when a positive rate was paid. `samples` is the hours the
 * payment covers (its funding period), as an aggregated Hyperliquid row counts its hourly payments.
 */
export function parseFundingFeeRow(row: OrderlyFundingFeeRow, periodHours: number): FundingPayment {
  const fee = Math.abs(row.funding_fee);
  const received = /^receive/i.test(row.payment_type);
  if (!received && !/^pay/i.test(row.payment_type)) throw new Error(`orderly funding fee: unknown payment_type ${row.payment_type}`);
  const fundingUsd = received ? fee : -fee;
  let size = 0;
  if (row.funding_rate !== 0 && row.mark_price > 0) {
    const units = fee / (Math.abs(row.funding_rate) * row.mark_price);
    // Longs pay a positive rate: paying on a positive rate (or receiving on a negative one) means long.
    const long = (row.funding_rate > 0) !== received;
    size = long ? units : -units;
  }
  return {
    time: row.created_time,
    symbol: row.symbol,
    fundingUsd: fundingUsd || 0,
    size,
    ratePerHour: ratePerHourFromPeriod(row.funding_rate, periodHours),
    samples: periodHours,
  };
}

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
