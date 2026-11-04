// Phoenix reader over the public HTTP API (perp-api.phoenix.trade), through the typed clients of the official SDK
// (@ellipsis-labs/rise): its zod schemas parse every answer, and its margin engine prices the account. No keys.
//
// Units are Phoenix's own integers until the last step (phoenix-units.ts): quote lots of 1e-6 USDC, base lots of
// 10^-baseLotsDecimals, price ticks. Funding is booked hourly per market and settles into collateral when the
// position changes (the snapshot's unsettled funding equals the sum of the history rows booked since then).

import {
  PhoenixHttpError, api, buildTraderMarginInputsFromSnapshot, createMarginCalculator, priceUsdToTicks,
} from '@ellipsis-labs/rise';
import type {
  ExchangeMarketConfig, FundingHourlyEvent, FundingOverviewResponse, FundingOverviewSeries, HttpTransport,
  LatestMarketsStatsResponse, MarketParams, OrderbookView, QueryParams, RequestOptions,
  TraderStateSnapshotResponse,
} from '@ellipsis-labs/rise';
import type { BudgetTimers, HostBudget, ReadKind } from './http-budget.ts';
import { PHOENIX_BUDGET, backgroundScanRead, hostBudget, readClass, requestTimeoutMs } from './http-budget.ts';
import type { DeskActStamp } from './desk-acts.ts';
import { deskActStamp, stillReusable } from './desk-acts.ts';
import { errorMessage } from './recorder.ts';
import type {
  AccountState, Book, Clock, FundingHistorySource, FundingPayment, Market, MarketFunding, MarketFundingPoint,
  MarketHistorySource, Position, VenueReader,
} from './venue.ts';
import { systemClock, trimBook } from './venue.ts';
import { baseFields, kiloBase } from './base-symbol.ts';
import {
  baseLotSize, baseLotsToUnits, fundingRatePerHour, percentToFraction, phoenixTimeMs, priceDecimals, quoteLotsToUsd,
  tickSizeUsd,
} from './phoenix-units.ts';

export const PHOENIX_API_URL = 'https://perp-api.phoenix.trade';
export const SOLANA_MAINNET_RPC_URL = 'https://api.mainnet-beta.solana.com';

const HOUR_MS = 3_600_000;
// funding-history answers at most 1000 events a page, newest first, and ignores any time window it is given.
const FUNDING_PAGE_ROWS = 1000;
// 200 pages = 200,000 events: far more than the venue keeps (about six months); more means paging is stuck.
const FUNDING_MAX_PAGES = 200;
// Market configs change only with a listing; account() and funding() reuse them this long.
const CONFIG_TTL_MS = 10 * 60_000;
// One overview request per history read: 31 days of hours at most, so a request stays a few hundred kB.
const HISTORY_MAX_POINTS = 31 * 24 + 2;
// The rates funding() reports are the last booked hour's: the overview behind them changes once an hour, so it is
// read again after a minute, not on every scan (the marks and open interest still are). A refresh that fails falls
// back on the last overview while it is this young: an hourly rate a few minutes old is still this hour's. Rows
// served that way carry rateReadAt (the scanner counts them stale) until a refresh is answered again.
const OVERVIEW_TTL_MS = 60_000;
const OVERVIEW_FALLBACK_MS = 10 * 60_000;
// The scanner's history reads of one window (it asks every leg for the same aligned hours) share one all-market
// overview request: one answer of about 2.3 MB for a week of 104 markets (measured 2026-11-03) instead of a request
// per market. Kept this long, so a booking that lands late in the hour is picked up by legs read later. A read from
// outside the scanner (one symbol, pair-mainnet) asks for that symbol alone.
const HISTORY_BATCH_TTL_MS = 10 * 60_000;
// The marks and open interest (markets/stats/latest) are asked for by the scanner's funding() every scan and by every
// account() (the risk engine every 5 s): under Phoenix's 1 request a second they share one read. The scanner takes
// one this young. An account read takes marks that arrived at most MARKS_MAX_AGE_MS ago, or joins a read still in
// flight or started STATS_TTL_ACCOUNT_MS ago; else it reads them itself, as a critical read. So that a risk tick is
// one critical request (the trader snapshot), an account read arms a refresh of the marks MARKS_REFRESH_IN_MS later,
// between two ticks, as a scanner-class read (it may be skipped or cut after a 429; the next account read then reads
// the marks itself). The refresh runs only while account reads keep coming (MARKS_REFRESH_WHILE_MS).
const STATS_TTL_SCAN_MS = 6_000;
const STATS_TTL_ACCOUNT_MS = 1_000;
export const MARKS_MAX_AGE_MS = 5_000;
const MARKS_REFRESH_IN_MS = 2_500;
const MARKS_REFRESH_WHILE_MS = 15_000;
// An account read started this recently, or still in flight, is joined by the next account() of the same authority.
const ACCOUNT_JOIN_MS = 1_000;
const HISTORY_BATCHES_KEPT = 2;
// The batch's newest booking must be at most this far before min(endTime, now): Phoenix books every hour, so an older
// newest point means every series came back cut short from the newest end, and none of them is trusted.
const BATCH_NEWEST_SLACK_MS = 2 * HOUR_MS;

/** A Phoenix market, with what the desk's policy and fee model need on top of the shared shape. */
export interface PhoenixMarket extends Market {
  orderbook: string;             // the market account (policy.phoenix_markets[].orderbook)
  takerFee: number;              // fraction of notional (0.00035 = 3.5 bps)
  makerFee: number;
}

/** A Phoenix position, with the subaccount it lives in: 0 is the cross-margin account, others are isolated. */
export interface PhoenixPosition extends Position {
  subaccountIndex: number;
  /** Notional at the mark (USD, unsigned). */
  notionalUsd: number;
}

/** The account with the cross-margin subaccount (0) on its own: isolated collateral is tied to its position. */
export interface PhoenixAccountState extends AccountState {
  positions: PhoenixPosition[];
  cross: { equityUsd: number; maintenanceMarginUsd: number };
}

export interface PhoenixReaderOptions {
  apiUrl?: string;
  /** Kept for callers that pass it; reads here are HTTP only and no SDK client (with its RPC side) is made. */
  rpcUrl?: string;
  /** Requests go through this fetch (tests, capture); default the global fetch. */
  fetch?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;            // per request
  traderPdaIndex?: number;       // which trader account of an authority; 0 unless the desk registers more
  /**
   * The request budget (http-budget.ts). Default: the one every Phoenix reader of this API host in the process
   * shares, so the scanner, the risk engine, the pair trader and the rescuer never add up to a burst; null: none.
   */
  budget?: HostBudget | null;
  /** Timers for the marks refresh between account reads (tests); default setTimeout, unref'd. */
  timers?: BudgetTimers;
}

export class PhoenixReader implements VenueReader, FundingHistorySource, MarketHistorySource {
  readonly id = 'phoenix' as const;
  readonly apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #traderPdaIndex: number;
  readonly #budget: HostBudget | null;
  #clients = new Map<ReadKind, Clients>();
  #configs: SharedRead<ExchangeMarketConfig[]> | null = null;
  #overview: SharedRead<Dated<FundingOverviewResponse>> | null = null;
  #lastOverview: Dated<FundingOverviewResponse> | null = null;
  #historyBatches = new Map<string, SharedRead<FundingOverviewResponse>>();
  #stats: SharedRead<LatestMarketsStatsResponse> | null = null;
  #accounts = new Map<string, SharedRead<PhoenixAccountState> & { stamp: DeskActStamp }>();
  /**
   * The last account answer of each authority, when it was asked for, and the desk-act stamp it was asked under
   * (accountWithin; an answer from before the desk's own action is not reused, venues/desk-acts.ts).
   */
  #lastAccount = new Map<string, Dated<PhoenixAccountState> & { stamp: DeskActStamp }>();
  /** The last marks answer and when it arrived (an account read takes it while MARKS_MAX_AGE_MS old at most). */
  #marks: Dated<LatestMarketsStatsResponse> | null = null;
  readonly #timers: BudgetTimers;
  #marksTimer: unknown = null;
  #lastAccountAsk = -Infinity;

  constructor(options: PhoenixReaderOptions = {}) {
    this.apiUrl = (options.apiUrl ?? PHOENIX_API_URL).replace(/\/+$/, '');
    // The SDK's own HTTP client is not used: it retries a 429 twice and holds every later request through a shared
    // cool-down, so on a busy host the scanner's reads queued up behind each other until they timed out. The budget
    // decides instead, and a scanner read it cannot send is skipped at once.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#traderPdaIndex = options.traderPdaIndex ?? 0;
    this.#budget = options.budget === undefined ? hostBudget(this.apiUrl, PHOENIX_BUDGET) : options.budget;
    this.#timers = options.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  async markets(): Promise<PhoenixMarket[]> {
    return parseMarkets(await this.#marketConfigs(true, 'funding'));
  }

  /**
   * The rate of the last hour each market booked (Phoenix publishes no forward estimate that matches what it
   * books), priced as fundingAmountPerUnit / markPrice of that hour. Markets that are not active, and markets whose
   * last booking is more than two funding intervals old (stale), are left out.
   */
  async funding(): Promise<MarketFunding[]> {
    const [overview, stats, configs] = await Promise.all([
      this.#fundingOverview(),
      this.#marketStats(STATS_TTL_SCAN_MS, 'funding'),
      this.#marketConfigs(false, 'funding'),
    ]);
    const rows = parseFunding(overview.value, stats, configs, this.#clock.now());
    // The refresh failed and the last overview stands in: every rate says how old it is.
    return overview.failed === null ? rows : rows.map((r) => ({ ...r, rateReadAt: overview.at }));
  }

  async book(symbol: string, depth?: number): Promise<Book> {
    let raw: OrderbookView;
    try {
      raw = await this.#api('book').orderbook.getOrderbook(symbol);
    } catch (err) {
      // An unknown symbol is a 404 with {"error":"Orderbook not found for symbol: ..."} (mainnet 2026-10-31).
      if (err instanceof PhoenixHttpError && err.status === 404) throw new Error(`phoenix orderbook: unknown symbol ${symbol}`);
      throw err;
    }
    // The venue stamps a book with a Solana slot, not a time: the time is when it arrived.
    return trimBook(parseBook(raw, this.#clock.now()), depth);
  }

  /** `address` is the trader's authority (wallet); the account read is its trader PDA `traderPdaIndex`. */
  async account(address: string): Promise<PhoenixAccountState> {
    const authority = normalizeAuthority(address);
    const now = this.#clock.now();
    const joined = this.#accounts.get(authority);
    if (joined !== undefined && stillReusable(joined.stamp) && now >= joined.at && now - joined.at < ACCOUNT_JOIN_MS) {
      return shared(joined, () => this.#accountRead(authority));
    }
    return this.#accountRead(authority);
  }

  /**
   * The account as read at most `maxAgeMs` ago by anyone in this process (the risk engine reads it every 5 s), else
   * read now. For callers that only need it roughly fresh (the strategy loop's free margin), so they add no request.
   */
  async accountWithin(address: string, maxAgeMs: number): Promise<PhoenixAccountState> {
    const authority = normalizeAuthority(address);
    const last = this.#lastAccount.get(authority);
    const now = this.#clock.now();
    // Not across the desk's own action (an order, a close, a rescue): sizing takes the margin after it.
    if (last !== undefined && stillReusable(last.stamp) && now >= last.at && now - last.at <= maxAgeMs) return last.value;
    return this.account(authority);
  }

  #accountRead(authority: string): Promise<PhoenixAccountState> {
    const at = this.#clock.now();
    const stamp = deskActStamp();
    const c = this.#api('account');
    const value = Promise.all([
      c.traders.getTraderStateSnapshot(authority, { traderPdaIndex: this.#traderPdaIndex }),
      this.#marketConfigs(false, 'account'),
      this.#accountMarks(at),
    ]).then(([snapshot, configs, stats]) => parseAccount(snapshot, configs, markPrices(stats), this.#clock.now()));
    const entry = { at, value, critical: readClass('account') === 'critical', stamp };
    this.#accounts.set(authority, entry);
    this.#lastAccountAsk = at;
    this.#armMarksRefresh();
    value.then(
      (v) => {
        const last = this.#lastAccount.get(authority);
        if (last === undefined || at >= last.at) this.#lastAccount.set(authority, { at, value: v, stamp });
      },
      () => {
        if (this.#accounts.get(authority) === entry) this.#accounts.delete(authority);
      },
    );
    return value;
  }

  /** An account read's marks: an answer at most MARKS_MAX_AGE_MS old, else a read joined or made now. */
  #accountMarks(now: number): Promise<LatestMarketsStatsResponse> {
    const m = this.#marks;
    if (m !== null && now >= m.at && now - m.at <= MARKS_MAX_AGE_MS) return Promise.resolve(m.value);
    return this.#marketStats(STATS_TTL_ACCOUNT_MS, 'account');
  }

  /** Arms the marks refresh between account reads (STATS_TTL_SCAN_MS comment), once. */
  #armMarksRefresh(): void {
    if (this.#marksTimer !== null) return;
    this.#marksTimer = this.#timers.setTimeout(() => {
      this.#marksTimer = null;
      if (this.#clock.now() - this.#lastAccountAsk > MARKS_REFRESH_WHILE_MS) return;
      // A scanner-class read: it gives way to every critical read and stands aside after a 429. Outside the arming
      // read's deadline (risk/sources.ts readBy), which the timer would otherwise carry.
      backgroundScanRead(() => this.#marketStats(MARKS_REFRESH_IN_MS, 'funding')).catch(() => {});
    }, MARKS_REFRESH_IN_MS);
  }

  /** markets/stats/latest, shared while younger than `ttlMs` (see STATS_TTL_SCAN_MS). */
  #marketStats(ttlMs: number, kind: ReadKind): Promise<LatestMarketsStatsResponse> {
    const now = this.#clock.now();
    const cached = this.#stats;
    if (cached !== null && now >= cached.at && now - cached.at < ttlMs) return shared(cached, () => this.#marketStats(0, kind));
    const value = this.#api(kind).markets.getLatestMarketsStats();
    const entry = { at: now, value, critical: readClass(kind) === 'critical' };
    this.#stats = entry;
    value.then((v) => {
      const arrived = this.#clock.now();
      if (this.#marks === null || arrived >= this.#marks.at) this.#marks = { at: arrived, value: v };
    }, () => {});
    // A failed read is not kept: the next call asks again.
    value.catch(() => {
      if (this.#stats === entry) this.#stats = null;
    });
    return value;
  }

  /**
   * Funding booked to one authority's trader with `startTime <= time <= endTime` (ms), oldest first. The venue pages
   * newest to oldest and ignores time windows, so this walks back until a page reaches past `startTime`.
   * `fundingUsd` is received > 0, paid < 0, as the venue's `fundingPayment` is (checked on mainnet 2026-10-31 for
   * longs and shorts on both rate signs).
   */
  async userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> {
    const authority = normalizeAuthority(address);
    if (!Number.isInteger(startTime) || startTime < 0) throw new RangeError(`userFunding startTime must be a ms timestamp, got ${startTime}`);
    if (endTime !== undefined && (!Number.isInteger(endTime) || endTime < startTime)) {
      throw new RangeError(`userFunding endTime must be a ms timestamp >= startTime, got ${endTime}`);
    }
    const c = this.#api('account');
    const out: FundingPayment[] = [];
    // Cursor pages do not overlap; this only guards against a page repeating rows of an earlier page, keyed on the
    // whole raw row. Rows within one page are never merged: two real rows of one hour (cross and isolated
    // subaccounts) both count.
    const earlier = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= FUNDING_MAX_PAGES) throw new Error(`phoenix userFunding: still more events after ${FUNDING_MAX_PAGES} pages`);
      const res = await c.funding.getTraderFundingHistory(authority, {
        pdaIndex: this.#traderPdaIndex, limit: FUNDING_PAGE_ROWS, ...(cursor === undefined ? {} : { cursor }),
      });
      let oldest = Infinity;
      const keys: string[] = [];
      for (const event of res.events) {
        const row = parseFundingEvent(event);
        oldest = Math.min(oldest, row.time);
        const key = JSON.stringify([event.timestamp, event.symbol, event.fundingPayment, event.fundingRatePercentage, event.positionSize, event.positionSide]);
        keys.push(key);
        if (earlier.has(key)) continue;
        if (row.time < startTime || (endTime !== undefined && row.time > endTime)) continue;
        out.push(row);
      }
      for (const key of keys) earlier.add(key);
      if (!res.hasMore || res.nextCursor === null || res.events.length === 0 || oldest < startTime) break;
      if (res.nextCursor === cursor) throw new Error('phoenix userFunding: the cursor did not advance');
      cursor = res.nextCursor;
    }
    return out.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  }

  /**
   * Hourly funding prints of one market with `startTime <= time <= endTime` (ms), oldest first, from the public
   * funding overview of that symbol, priced like funding(): fundingAmountPerUnit / markPrice of each booked hour.
   */
  async marketFundingHistory(symbol: string, startTime: number, endTime: number): Promise<MarketFundingPoint[]> {
    if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || startTime < 0 || endTime < startTime) {
      throw new RangeError(`marketFundingHistory needs ms timestamps with start <= end, got ${startTime}, ${endTime}`);
    }
    const limit = Math.ceil((endTime - startTime) / HOUR_MS) + 2;
    if (limit > HISTORY_MAX_POINTS) throw new RangeError(`phoenix marketFundingHistory: ${limit} hours asked, at most ${HISTORY_MAX_POINTS}`);
    // The scanner: every market's series of these hours in one request, shared by the legs that ask for the same
    // hours. A market the batch does not carry (listed since, or left out), or carries fewer hours of than the batch's
    // newest booking says there are (cut short), is asked for on its own; so is any read from outside the scanner.
    if (readClass('history') !== 'critical') {
      const batch = await this.#historyBatch(startTime, endTime, limit);
      const found = batch.series.find((s) => s.symbol === symbol);
      if (found !== undefined && coversBatch(found, batch, startTime, endTime, this.#clock.now())) return parseFundingSeries(found, startTime, endTime);
    }
    let series: FundingOverviewSeries;
    try {
      series = await this.#api('history').funding.getFundingOverviewBySymbol(symbol, { startTime, endTime, perMarketLimit: limit });
    } catch (err) {
      if (err instanceof PhoenixHttpError && err.status === 404) throw new Error(`phoenix funding overview: unknown symbol ${symbol}`);
      throw err;
    }
    return parseFundingSeries(series, startTime, endTime);
  }

  /** Drops the cached answers; reads after this ask again. Nothing to release: every read is a plain HTTP request. */
  close(): void {
    this.#clients.clear();
    this.#configs = null;
    this.#overview = null;
    this.#historyBatches.clear();
    this.#stats = null;
    this.#marks = null;
    this.#accounts.clear();
    this.#lastAccount.clear();
    if (this.#marksTimer !== null) this.#timers.clearTimeout(this.#marksTimer);
    this.#marksTimer = null;
  }

  #marketConfigs(fresh: boolean, kind: ReadKind): Promise<ExchangeMarketConfig[]> {
    const now = this.#clock.now();
    const cached = this.#configs;
    if (!fresh && cached !== null && now - cached.at < CONFIG_TTL_MS) return shared(cached, () => this.#marketConfigs(false, kind));
    const value = this.#api(kind).exchange.getMarkets();
    const entry = { at: now, value, critical: readClass(kind) === 'critical' };
    this.#configs = entry;
    // A failed read is not kept: the next call asks again.
    value.catch(() => {
      if (this.#configs === entry) this.#configs = null;
    });
    return value;
  }

  /**
   * The last booked hour of every market, read again once OVERVIEW_TTL_MS old. A failed refresh serves the last one
   * while it is OVERVIEW_FALLBACK_MS young, saying why (`failed`).
   */
  async #fundingOverview(): Promise<Dated<FundingOverviewResponse> & { failed: string | null }> {
    try {
      return { ...(await this.#overviewRead()), failed: null };
    } catch (err) {
      const now = this.#clock.now();
      const last = this.#lastOverview;
      if (last !== null && now >= last.at && now - last.at <= OVERVIEW_FALLBACK_MS) return { ...last, failed: errorMessage(err) };
      throw err;
    }
  }

  #overviewRead(): Promise<Dated<FundingOverviewResponse>> {
    const now = this.#clock.now();
    const cached = this.#overview;
    if (cached !== null && now >= cached.at && now - cached.at < OVERVIEW_TTL_MS) return shared(cached, () => this.#overviewRead());
    const value = this.#api('funding').funding.getFundingOverview({ perMarketLimit: 1 }).then((v) => ({ at: now, value: v }));
    const entry = { at: now, value, critical: readClass('funding') === 'critical' };
    this.#overview = entry;
    value.then(
      (d) => {
        if (this.#lastOverview === null || d.at >= this.#lastOverview.at) this.#lastOverview = d;
      },
      () => {
        if (this.#overview === entry) this.#overview = null;
      },
    );
    return value;
  }

  /** The scanner's all-market history request of these hours; only scanner reads share it. */
  #historyBatch(startTime: number, endTime: number, limit: number): Promise<FundingOverviewResponse> {
    const now = this.#clock.now();
    const key = `${startTime}|${endTime}|${limit}`;
    const cached = this.#historyBatches.get(key);
    if (cached !== undefined && now >= cached.at && now - cached.at < HISTORY_BATCH_TTL_MS) return cached.value;
    const value = this.#api('history').funding.getFundingOverview({ startTime, endTime, perMarketLimit: limit });
    const entry = { at: now, value, critical: false };
    this.#historyBatches.delete(key);
    this.#historyBatches.set(key, entry);
    while (this.#historyBatches.size > HISTORY_BATCHES_KEPT) this.#historyBatches.delete(this.#historyBatches.keys().next().value!);
    // A failed read is not kept: the next leg asks again.
    value.catch(() => {
      if (this.#historyBatches.get(key) === entry) this.#historyBatches.delete(key);
    });
    return value;
  }

  /** Clients whose requests go through the budget as `kind` reads. */
  #api(kind: ReadKind): Clients {
    const made = this.#clients.get(kind);
    if (made !== undefined) return made;
    const transport = new FetchTransport(this.apiUrl, this.#fetch, this.#timeoutMs, this.#budget === null ? undefined : { budget: this.#budget, kind });
    const clients: Clients = {
      exchange: new api.V1ExchangeClient(transport),
      funding: new api.V1FundingClient(transport),
      markets: new api.V1MarketsClient(transport),
      orderbook: new api.V1OrderbookClient(transport),
      traders: new api.V1TradersClient(transport),
    };
    this.#clients.set(kind, clients);
    return clients;
  }
}

/** An answer and when it was asked for (ms). */
interface Dated<T> {
  at: number;
  value: T;
}

/** A read every caller of the reader shares while it is fresh, and whether a critical read started it. */
interface SharedRead<T> {
  at: number;
  value: Promise<T>;
  critical: boolean;
}

/**
 * `entry`'s answer for a caller here. A critical caller does not take the failure of a read the scanner started
 * (skipped by the budget, a 429 it did not retry, a timeout): it reads again as itself (`again`, which joins the
 * read of another critical caller that got there first).
 */
function shared<T>(entry: SharedRead<T>, again: () => Promise<T>): Promise<T> {
  if (entry.critical || readClass('account') !== 'critical') return entry.value;
  return entry.value.catch(() => again());
}

/**
 * Whether the all-market batch carries every hour of `series` it should. The batch's newest booking in [startTime,
 * endTime] must be within BATCH_NEWEST_SLACK_MS of min(endTime, now) (older: every series was cut short from the
 * newest end), and `series` must have as many points as there are hours from startTime to that booking (fewer: the
 * market was listed since, or its series was cut short). Otherwise the per-symbol answer is the one to trust.
 */
function coversBatch(series: FundingOverviewSeries, batch: FundingOverviewResponse, startTime: number, endTime: number, now: number): boolean {
  const inRange = (s: FundingOverviewSeries) => s.points.map((p) => phoenixTimeMs(p.timestamp)).filter((t) => t >= startTime && t <= endTime);
  let newest = -Infinity;
  for (const s of batch.series) for (const t of inRange(s)) newest = Math.max(newest, t);
  const due = Math.min(endTime, now) - BATCH_NEWEST_SLACK_MS;
  if (newest === -Infinity) return due < startTime;
  if (newest < due) return false;
  return new Set(inRange(series)).size >= Math.floor((newest - startTime) / HOUR_MS) + 1;
}

export interface PhoenixGetOptions {
  /** Default the global fetch. */
  fetch?: typeof fetch;
  /** Default the budget every Phoenix reader of this API host in the process shares; null: none. */
  budget?: HostBudget | null;
  /** Per request (from when it is sent); default 10 s. */
  timeoutMs?: number;
}

/**
 * One GET of the Phoenix API, answered as JSON, for callers outside PhoenixReader (the trader API, the exchange
 * snapshot pair-mainnet and serve check the pinned accounts against). It goes through the host's request budget as an
 * `account` read: critical outside the scanner, so ahead of the scanner's reads, never skipped for them, retried after
 * a 429 once Retry-After (capped) has passed, within the caller's deadline (readBy). A non-2xx throws
 * `phoenix GET <path>: HTTP <status> <body>`.
 */
export async function phoenixGet<T = unknown>(apiUrl: string, path: string, options: PhoenixGetOptions = {}): Promise<T> {
  const base = apiUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
  const budget = options.budget === undefined ? hostBudget(base, PHOENIX_BUDGET) : options.budget;
  const send = () => fetchImpl(`${base}${path}`, {
    method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(requestTimeoutMs(options.timeoutMs ?? 10_000)),
  });
  const res = budget === null ? await send() : await budget.run(readClass('account'), send);
  const body = await res.json().catch(() => null) as unknown;
  if (!res.ok) throw new Error(`phoenix GET ${path}: HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 160)}`);
  return body as T;
}

interface Clients {
  exchange: InstanceType<typeof api.V1ExchangeClient>;
  funding: InstanceType<typeof api.V1FundingClient>;
  markets: InstanceType<typeof api.V1MarketsClient>;
  orderbook: InstanceType<typeof api.V1OrderbookClient>;
  traders: InstanceType<typeof api.V1TradersClient>;
}

/**
 * The SDK's HTTP surface over a plain `fetch`, so tests can replay recorded answers and capture can record them.
 * GET only: a reader never writes. The query is built the way the SDK builds it (null and undefined left out).
 * With a budget, every request waits for it as a `kind` read (its class set by where it is called from, see
 * http-budget.ts); the timeout runs from when the request is sent, and ends at the caller's deadline (readBy) if sooner.
 */
export class FetchTransport implements HttpTransport {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #gate: { budget: HostBudget; kind: ReadKind } | undefined;

  constructor(baseUrl: string, fetchFn: typeof fetch, timeoutMs = 10_000, gate?: { budget: HostBudget; kind: ReadKind }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetchFn;
    this.#timeoutMs = timeoutMs;
    this.#gate = gate;
  }

  fetch(method: string, endpoint: string, options?: RequestOptions, body?: unknown): Promise<Response> {
    if (method.toUpperCase() !== 'GET' || body !== undefined) {
      return Promise.reject(new Error(`phoenix reader: ${method} ${endpoint}: only GET requests, readers never write`));
    }
    const url = new URL(`${this.#baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`);
    if (options?.params !== undefined) appendParams(url, options.params);
    const send = () => this.#fetch(url.href, {
      method: 'GET',
      headers: { accept: 'application/json', ...options?.headers },
      signal: AbortSignal.timeout(requestTimeoutMs(this.#timeoutMs)),
    });
    if (this.#gate === undefined) return send();
    return this.#gate.budget.run(readClass(this.#gate.kind), send);
  }
}

function appendParams(url: URL, params: QueryParams): void {
  if (params instanceof URLSearchParams) {
    params.forEach((value, key) => url.searchParams.append(key, value));
    return;
  }
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else url.searchParams.set(key, String(value));
  }
}

/** Solana public keys are base58, 32 bytes: 32 to 44 characters. */
function normalizeAuthority(address: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error(`phoenix: not a Solana address: ${address}`);
  return address;
}

export function parseMarkets(configs: readonly ExchangeMarketConfig[]): PhoenixMarket[] {
  return configs.map((c) => ({
    venue: 'phoenix',
    symbol: c.symbol,
    assetIndex: c.assetId,
    szDecimals: c.baseLotsDecimals,
    lotSize: baseLotSize(c.baseLotsDecimals),
    tickSize: tickSizeUsd(c.tickSize, c.baseLotsDecimals),
    maxPxDecimals: priceDecimals(c.tickSize, c.baseLotsDecimals),
    // Tiers step leverage down with size; the first tier carries the most.
    maxLeverage: Math.max(...c.leverageTiers.map((t) => t.maxLeverage)),
    isolatedOnly: c.isolatedOnly,
    // Any status but "active" means nobody can open a leg there now.
    delisted: c.marketStatus !== 'active',
    orderbook: c.marketPubkey,
    takerFee: c.takerFee,
    makerFee: c.makerFee,
  }));
}

export function parseFunding(
  overview: FundingOverviewResponse, stats: LatestMarketsStatsResponse, configs: readonly ExchangeMarketConfig[], now: number,
): MarketFunding[] {
  const configBySymbol = new Map(configs.map((c) => [c.symbol, c]));
  const statsBySymbol = new Map(stats.markets.map((s) => [s.symbol, s]));
  const out: MarketFunding[] = [];
  for (const series of overview.series) {
    const config = configBySymbol.get(series.symbol);
    if (config === undefined || config.marketStatus !== 'active') continue;
    // The overview lists points oldest first; a market listed this hour has none yet.
    const point = series.points.at(-1);
    if (point === undefined) continue;
    const intervalMs = config.fundingIntervalSeconds * 1000;
    if (!(intervalMs > 0)) throw new Error(`phoenix ${series.symbol}: funding interval ${config.fundingIntervalSeconds} s`);
    // A last booking more than two intervals old is not the current rate: left out (stale), never shown as current
    // with a fresh nextAt.
    if (now - phoenixTimeMs(point.timestamp) > 2 * intervalMs) continue;
    const s = statsBySymbol.get(series.symbol);
    out.push({
      venue: 'phoenix',
      symbol: series.symbol,
      ...baseFields(phoenixBase(series.symbol)),
      // The amount is per funding interval (one hour on every market so far); scale to one hour regardless.
      ratePerHour: (fundingRatePerHour(point.fundingAmountPerUnit, point.markPrice) * HOUR_MS) / intervalMs || 0,
      settlement: 'daily',
      nextAt: (Math.floor(now / intervalMs) + 1) * intervalMs,
      markPx: s?.mark_price ?? null,
      oraclePx: s?.oracle_price ?? null,
      openInterest: s?.open_interest ?? null,      // base units (the config counts it in base lots)
      volume24hUsd: s?.day_volume_usd ?? null,
      ...(typeof s?.prev_day_mark_price === 'number' ? { prevDayPx: s.prev_day_mark_price } : {}),
    });
  }
  return out;
}

/**
 * The cross-venue key of a Phoenix market: symbols are the asset's own name ("SOL", "NVDA"), except the per-thousand
 * coins, which Phoenix lists the way Hyperliquid does ("kBONK", "kPEPE", "kSHIB": 1000 units each, same marks).
 */
export function phoenixBase(symbol: string): { base: string; multiplier: number } {
  return kiloBase(symbol);
}

/**
 * One market's overview series as hourly history points: each booked hour priced as fundingAmountPerUnit / markPrice,
 * the same as funding(). Points outside [startTime, endTime] are dropped; one point per booked time.
 */
export function parseFundingSeries(series: FundingOverviewSeries, startTime: number, endTime: number): MarketFundingPoint[] {
  const byTime = new Map<number, MarketFundingPoint>();
  for (const p of series.points) {
    const time = phoenixTimeMs(p.timestamp);
    if (time < startTime || time > endTime) continue;
    byTime.set(time, { time, symbol: series.symbol, ratePerHour: fundingRatePerHour(p.fundingAmountPerUnit, p.markPrice), periodHours: 1 });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function parseBook(raw: OrderbookView, time: number): Book {
  // Levels are [USD price, base units], best first.
  const side = (levels: [number, number][]) => levels.map(([px, sz]) => ({ px, sz }));
  return { venue: 'phoenix', symbol: raw.symbol, time, bids: side(raw.bids), asks: side(raw.asks) };
}

/** Mark prices by symbol from the latest market stats, USD. */
export function markPrices(stats: LatestMarketsStatsResponse): Map<string, number> {
  return new Map(stats.markets.map((s) => [s.symbol, s.mark_price]));
}

/** The margin engine's view of one market (MarketParams) from the venue's config and a USD mark price. */
export function marketParams(config: ExchangeMarketConfig, markUsd: number): MarketParams {
  const units = { baseLotsDecimals: config.baseLotsDecimals, tickSizeInQuoteLotsPerBaseLot: config.tickSize };
  const rf = config.riskFactors;
  return {
    symbol: config.symbol,
    assetId: config.assetId,
    markPriceTicks: priceUsdToTicks(markUsd, units),
    tickSize: String(config.tickSize),
    baseLotDecimals: config.baseLotsDecimals,
    leverageTiers: config.leverageTiers.map((t) => ({
      upperBoundSize: String(t.maxSizeBaseLots),
      maxLeverage: String(t.maxLeverage),
      limitOrderRiskFactorBps: bps(t.limitOrderRiskFactorBps, t.limitOrderRiskFactor),
    })),
    riskFactors: {
      maintenanceMarginFactorBps: bps(rf.maintenanceBps, rf.maintenance),
      backstopMarginFactorBps: bps(rf.backstopBps, rf.backstop),
      highRiskMarginFactorBps: bps(rf.highRiskBps, rf.highRisk),
    },
    cancelOrderRiskFactorBps: bps(rf.cancelOrderBps, rf.cancelOrder),
    upnlRiskFactor: bps(rf.upnlBps, rf.upnl),
    upnlRiskFactorForWithdrawals: bps(rf.upnlForWithdrawalsBps, rf.upnlForWithdrawals),
    isolatedOnly: config.isolatedOnly,
  };
}

// Risk factors come as a percentage and, on newer servers, also in basis points; the margin engine wants bps.
function bps(basisPoints: number | undefined, percent: number): string {
  const value = basisPoints ?? percent * 100;
  const rounded = Math.round(value);
  if (!Number.isFinite(value) || value < 0 || Math.abs(rounded - value) > 1e-9) throw new Error(`phoenix: bad risk factor ${percent} %`);
  return String(rounded);
}

/**
 * The account of one trader PDA, priced by the SDK's margin engine at `marks` (USD). Every subaccount counts:
 * equity and maintenance are summed, positions are listed with their subaccount, and the free margin is what the
 * cross-margin subaccount (0) could withdraw (isolated collateral is tied to its position). Spot collateral (native
 * SOL) is not valued: the desk holds USDC only.
 */
export function parseAccount(
  snapshot: TraderStateSnapshotResponse, configs: readonly ExchangeMarketConfig[], marks: ReadonlyMap<string, number>, time: number,
): PhoenixAccountState {
  const subaccounts = snapshot.snapshot.subaccounts;
  const configBySymbol = new Map(configs.map((c) => [c.symbol, c]));
  const symbols = new Set<string>();
  for (const sub of subaccounts) {
    for (const p of sub.positions ?? []) symbols.add(p.symbol);
    for (const o of sub.orders ?? []) symbols.add(o.symbol);
  }
  const params: MarketParams[] = [];
  for (const symbol of symbols) {
    const config = configBySymbol.get(symbol);
    const mark = marks.get(symbol);
    if (config === undefined) throw new Error(`phoenix account: no market config for ${symbol}`);
    if (mark === undefined || !(mark > 0)) throw new Error(`phoenix account: no mark price for ${symbol}`);
    params.push(marketParams(config, mark));
  }
  const calculator = createMarginCalculator(params);
  const inputs = buildTraderMarginInputsFromSnapshot({
    authority: snapshot.authority,
    traderPdaIndex: snapshot.traderPdaIndex,
    messageType: 'snapshot',
    subaccounts: subaccounts.map((s) => ({
      subaccountIndex: s.subaccountIndex,
      collateral: s.collateral,
      positions: s.positions ?? [],
      orders: s.orders ?? [],
    })),
  });
  const margin = calculator.computeTraderMarginFromInputs(inputs);
  const liquidation = calculator.computeTraderLiquidationPricesFromInputs(inputs);

  // Summed in quote lots (exact integers), converted once.
  let equity = 0n;
  let maintenance = 0n;
  let free = 0n;
  let crossEquity = 0n;
  let crossMaintenance = 0n;
  const positions: PhoenixPosition[] = [];
  for (const sub of margin.subaccounts) {
    equity += BigInt(sub.margin.portfolioValueQuoteLots);
    maintenance += BigInt(sub.margin.maintenanceMarginQuoteLots);
    if (sub.subaccountIndex === 0) {
      free = BigInt(sub.margin.withdrawableQuoteCollateralQuoteLots);
      crossEquity = BigInt(sub.margin.portfolioValueQuoteLots);
      crossMaintenance = BigInt(sub.margin.maintenanceMarginQuoteLots);
    }
    const liqBySymbol = new Map(
      (liquidation.subaccounts.find((l) => l.subaccountIndex === sub.subaccountIndex)?.positions ?? [])
        .map((l) => [l.symbol, l.liquidationPriceUsd]),
    );
    for (const m of sub.marketMargins) {
      if (BigInt(m.basePositionLots) === 0n) continue;
      const config = configBySymbol.get(m.symbol)!;
      const dec = config.baseLotsDecimals;
      const marginUsd = quoteLotsToUsd(m.positionInitialMarginQuoteLots);
      const valueUsd = Math.abs(quoteLotsToUsd(m.positionValueQuoteLots));
      const size = baseLotsToUnits(m.basePositionLots, dec);
      positions.push({
        symbol: m.symbol,
        size,
        // The exact average entry: the quote paid or received over the size. entryPriceTicks is rounded to a tick
        // (ETH 2288.6 where the venue's own view says 2288.7 for 315758.410795 USDC over 137.967 ETH).
        entryPx: Math.abs(quoteLotsToUsd(m.virtualQuotePositionLots)) / Math.abs(size),
        liqPx: liqBySymbol.get(m.symbol) ?? null,
        marginUsd,
        unrealizedPnlUsd: quoteLotsToUsd(m.unrealizedPnlQuoteLots),
        // Cross margin has no set leverage: this is notional over the initial margin the tier asks for.
        leverage: marginUsd > 0 ? valueUsd / marginUsd : 0,
        // Margin-engine sign: positive raises collateral, so received > 0 as Position wants.
        fundingSinceOpenUsd: quoteLotsToUsd(m.accumulatedFundingQuoteLots),
        unsettledFundingUsd: quoteLotsToUsd(m.unsettledFundingQuoteLots),
        subaccountIndex: sub.subaccountIndex,
        notionalUsd: valueUsd,
      });
    }
  }
  return {
    venue: 'phoenix',
    address: snapshot.authority,
    time,
    equityUsd: quoteLotsToUsd(equity),
    freeMarginUsd: quoteLotsToUsd(free),
    maintenanceMarginUsd: quoteLotsToUsd(maintenance),
    positions,
    cross: { equityUsd: quoteLotsToUsd(crossEquity), maintenanceMarginUsd: quoteLotsToUsd(crossMaintenance) },
  };
}

export function parseFundingEvent(event: FundingHourlyEvent): FundingPayment {
  return {
    time: phoenixTimeMs(event.timestamp),
    symbol: event.symbol,
    fundingUsd: num(event.fundingPayment, 'fundingPayment'),
    size: num(event.positionSize, 'positionSize'),         // signed: shorts are negative
    ratePerHour: percentToFraction(event.fundingRatePercentage),
    samples: null,
  };
}

function num(s: string, field: string): number {
  const n = Number(s);
  if (s.trim() === '' || !Number.isFinite(n)) throw new Error(`phoenix: ${field} is not a number: ${JSON.stringify(s)}`);
  return n || 0;
}
