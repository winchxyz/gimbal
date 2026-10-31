// Orderly reader. Markets, funding and funding-rate history over public REST; the order book over the public
// WebSocket only (Orderly serves no REST book to the public); the account over the desk's private WebSocket session
// (orderly-stream.ts, one signature per session); the desk's own funding history over a signed REST read
// (orderly-actions.ts). Without a desk, account() and userFunding() refuse: nothing here signs.

import type {
  AccountState, Book, BookLevel, Clock, FundingHistorySource, FundingPayment, Market, MarketFunding, Position, VenueReader,
} from './venue.ts';
import { systemClock, trimBook } from './venue.ts';
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
  clock?: Clock;
  timeoutMs?: number;
}

/** Orderly's keep-alive: the server sends {"event":"ping"} every 10 s and closes a stream that does not answer. */
export function orderlyKeepAlive(msg: Record<string, unknown>): Record<string, unknown> | null {
  return msg.event === 'ping' ? { event: 'pong', ts: msg.ts } : null;
}

/** The venue's symbol for a base asset: "SOL" -> "PERP_SOL_USDC"; a full symbol is kept as it is. */
export function orderlySymbol(base: string): string {
  return base.startsWith('PERP_') ? base : `PERP_${base}_USDC`;
}

export class OrderlyReader implements VenueReader, FundingHistorySource {
  readonly id = 'orderly' as const;
  readonly network: OrderlyNetwork;
  readonly apiUrl: string;
  readonly #endpoints: OrderlyEndpoints;
  readonly #publicWs: string;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #accountStream: OrderlyAccountSource | undefined;
  readonly #fundingFees: OrderlyFundingFeeSource | undefined;
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
    this.#accountStream = options.accountStream;
    this.#fundingFees = options.fundingFees;
    this.#wsRequest = options.wsRequest ?? null;
    this.#streamId = options.streamAccountId === undefined ? null : Promise.resolve(normalizeAccountId(options.streamAccountId));
  }

  async markets(): Promise<OrderlyMarket[]> {
    return parseMarkets(await this.#infoRows(true));
  }

  /** The estimated rate of the running period (what is paid at next_funding_time), per hour. Inactive markets left out. */
  async funding(): Promise<MarketFunding[]> {
    const [futures, info] = await Promise.all([this.#futures(), this.#infoRows(false)]);
    return parseFunding(futures, info);
  }

  async book(symbol: string, depth?: number): Promise<Book> {
    const url = `${this.#publicWs}${await this.#streamAccountId()}`;
    const answer = await this.#ws()(url, { id: `book-${++this.#requests}`, event: 'request', params: { type: 'orderbook', symbol } });
    return trimBook(parseBookAnswer(symbol, answer), depth);
  }

  /** `address` is the desk's Orderly account id; the state comes from its private stream session. */
  async account(address: string): Promise<AccountState> {
    const accountId = normalizeAccountId(address);
    const stream = this.#accountStream;
    if (stream === undefined) throw new Error('orderly account: needs the desk\'s private stream session (accountStream)');
    if (stream.accountId !== accountId) throw new Error(`orderly account: the stream is for ${stream.accountId}, not ${accountId}`);
    const [snapshot, futures, info] = await Promise.all([stream.state(), this.#futures(), this.#infoRows(false)]);
    return parseAccount(snapshot, futures, info, this.#clock.now());
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
    const periods = periodsBySymbol(await this.#infoRows(false));
    const rows: OrderlyFundingFeeRow[] = [];
    for (let page = 1; ; page++) {
      if (page > FUNDING_FEE_MAX_PAGES) throw new Error(`orderly userFunding: still more rows after ${FUNDING_FEE_MAX_PAGES} pages`);
      const res = await source.fundingFeeHistory(startTime, end, page, FUNDING_FEE_PAGE_ROWS);
      rows.push(...res.rows);
      if (!morePages(res.rows.length, FUNDING_FEE_PAGE_ROWS, page, res.meta?.total)) break;
    }
    const out: FundingPayment[] = [];
    for (const row of rows) {
      if (row.created_time < startTime || row.created_time > end) continue;
      const period = periods.get(row.symbol);
      if (period === undefined) throw new Error(`orderly userFunding: no funding period for ${row.symbol}`);
      out.push(parseFundingFeeRow(row, period));
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
      const res = await this.#get<{ rows: OrderlyRateHistoryRow[]; meta?: { total?: number } }>(`/v1/public/funding_rate_history?${q}`, 'funding_rate_history');
      rows.push(...res.rows);
      if (!morePages(res.rows.length, RATE_HISTORY_PAGE_ROWS, page, res.meta?.total)) break;
    }
    return rows
      .filter((r) => r.funding_rate_timestamp >= startTime && r.funding_rate_timestamp <= endTime)
      .map((r) => ({
        time: r.funding_rate_timestamp,
        symbol: r.symbol,
        ratePerHour: ratePerHourFromPeriod(r.funding_rate, info.funding_period),
        ratePerPeriod: r.funding_rate,
        periodHours: info.funding_period,
      }))
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

function morePages(got: number, size: number, page: number, total: number | undefined): boolean {
  if (total !== undefined) return page * size < total && got > 0;
  return got >= size;
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

/** Markets that are not active, or whose funding period has no shared name, are left out. */
export function parseFunding(futures: readonly OrderlyFuturesRow[], info: readonly OrderlyInfoRow[]): MarketFunding[] {
  const periods = periodsBySymbol(info);
  const out: MarketFunding[] = [];
  for (const f of futures) {
    if (f.status !== 'ACTIVE') continue;
    const period = periods.get(f.symbol);
    if (period === undefined) continue;
    const settlement = settlementForPeriod(period);
    if (settlement === null) continue;
    out.push({
      venue: 'orderly',
      symbol: f.symbol,
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
 */
export function parseAccount(
  snapshot: OrderlyAccountSnapshot, futures: readonly OrderlyFuturesRow[], info: readonly OrderlyInfoRow[], time: number,
): AccountState {
  const futuresBySymbol = new Map(futures.map((f) => [f.symbol, f]));
  const infoBySymbol = new Map(info.map((r) => [r.symbol, r]));
  const usdc = snapshot.balances.USDC ?? { holding: 0, frozen: 0 };
  let equity = usdc.holding;
  let initial = 0;
  let maintenance = 0;
  const positions: Position[] = [];
  for (const p of snapshot.positions) {
    if (p.positionQty === 0) continue;
    const f = futuresBySymbol.get(p.symbol);
    const i = infoBySymbol.get(p.symbol);
    if (i === undefined) throw new Error(`orderly account: no market info for ${p.symbol}`);
    const mark = f?.mark_price ?? p.markPrice;
    if (mark === undefined || !(mark > 0)) throw new Error(`orderly account: no mark price for ${p.symbol}`);
    const suf = f?.sum_unitary_funding ?? p.lastSumUnitaryFunding;
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
      liqPx: p.estLiqPrice !== undefined && p.estLiqPrice > 0 ? p.estLiqPrice : null,
      marginUsd,
      unrealizedPnlUsd: p.positionQty * (mark - p.averageOpenPrice) || 0,
      leverage: 1 / imr,
      // Assumed paid > 0 like Hyperliquid's cumFunding, so flipped; to verify on the first testnet position (C5).
      fundingSinceOpenUsd: p.accruedFundingFee === undefined ? 0 : -p.accruedFundingFee || 0,
      unsettledFundingUsd: unsettledFundingUsd(p.positionQty, suf, p.lastSumUnitaryFunding),
    });
  }
  return {
    venue: 'orderly',
    address: snapshot.accountId,
    time,
    equityUsd: equity,
    freeMarginUsd: Math.max(0, equity - initial - usdc.frozen),
    maintenanceMarginUsd: maintenance,
    positions,
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
