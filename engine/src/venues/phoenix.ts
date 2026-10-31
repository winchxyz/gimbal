// Phoenix reader over the public HTTP API (perp-api.phoenix.trade), through the typed clients of the official SDK
// (@ellipsis-labs/rise): its zod schemas parse every answer, and its margin engine prices the account. No keys.
//
// Units are Phoenix's own integers until the last step (phoenix-units.ts): quote lots of 1e-6 USDC, base lots of
// 10^-baseLotsDecimals, price ticks. Funding is booked hourly per market and settles into collateral when the
// position changes (the snapshot's unsettled funding equals the sum of the history rows booked since then).

import {
  PhoenixHttpError, api, buildTraderMarginInputsFromSnapshot, createMarginCalculator, createPhoenixClient, priceUsdToTicks,
} from '@ellipsis-labs/rise';
import type {
  ExchangeMarketConfig, FundingHourlyEvent, FundingOverviewResponse, FundingOverviewSeries, HttpTransport,
  LatestMarketsStatsResponse, MarketParams, OrderbookView, PhoenixClient, QueryParams, RequestOptions,
  TraderStateSnapshotResponse,
} from '@ellipsis-labs/rise';
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

/** A Phoenix market, with what the desk's policy and fee model need on top of the shared shape. */
export interface PhoenixMarket extends Market {
  orderbook: string;             // the market account (policy.phoenix_markets[].orderbook)
  takerFee: number;              // fraction of notional (0.00035 = 3.5 bps)
  makerFee: number;
}

/** A Phoenix position, with the subaccount it lives in: 0 is the cross-margin account, others are isolated. */
export interface PhoenixPosition extends Position {
  subaccountIndex: number;
}

export interface PhoenixReaderOptions {
  apiUrl?: string;
  /** Only the SDK client uses it, for its RPC side; reads here are HTTP. Default SOLANA_RPC_URL, then public mainnet. */
  rpcUrl?: string;
  /** Requests go through this fetch (tests, capture) instead of the SDK's own HTTP client. */
  fetch?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;            // per request, with `fetch` only
  traderPdaIndex?: number;       // which trader account of an authority; 0 unless the desk registers more
}

export class PhoenixReader implements VenueReader, FundingHistorySource, MarketHistorySource {
  readonly id = 'phoenix' as const;
  readonly apiUrl: string;
  readonly #rpcUrl: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #traderPdaIndex: number;
  #sdk: PhoenixClient | null = null;
  #clients: Clients | null = null;
  #configs: { at: number; value: Promise<ExchangeMarketConfig[]> } | null = null;

  constructor(options: PhoenixReaderOptions = {}) {
    this.apiUrl = (options.apiUrl ?? PHOENIX_API_URL).replace(/\/+$/, '');
    this.#rpcUrl = options.rpcUrl ?? process.env.SOLANA_RPC_URL ?? SOLANA_MAINNET_RPC_URL;
    this.#fetch = options.fetch;
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#traderPdaIndex = options.traderPdaIndex ?? 0;
  }

  async markets(): Promise<PhoenixMarket[]> {
    return parseMarkets(await this.#marketConfigs(true));
  }

  /**
   * The rate of the last hour each market booked (Phoenix publishes no forward estimate that matches what it
   * books), priced as fundingAmountPerUnit / markPrice of that hour. Markets that are not active, and markets whose
   * last booking is more than two funding intervals old (stale), are left out.
   */
  async funding(): Promise<MarketFunding[]> {
    const c = this.#api();
    const [overview, stats, configs] = await Promise.all([
      c.funding.getFundingOverview({ perMarketLimit: 1 }),
      c.markets.getLatestMarketsStats(),
      this.#marketConfigs(false),
    ]);
    return parseFunding(overview, stats, configs, this.#clock.now());
  }

  async book(symbol: string, depth?: number): Promise<Book> {
    let raw: OrderbookView;
    try {
      raw = await this.#api().orderbook.getOrderbook(symbol);
    } catch (err) {
      // An unknown symbol is a 404 with {"error":"Orderbook not found for symbol: ..."} (mainnet 2026-10-31).
      if (err instanceof PhoenixHttpError && err.status === 404) throw new Error(`phoenix orderbook: unknown symbol ${symbol}`);
      throw err;
    }
    // The venue stamps a book with a Solana slot, not a time: the time is when it arrived.
    return trimBook(parseBook(raw, this.#clock.now()), depth);
  }

  /** `address` is the trader's authority (wallet); the account read is its trader PDA `traderPdaIndex`. */
  async account(address: string): Promise<AccountState> {
    const authority = normalizeAuthority(address);
    const c = this.#api();
    const [snapshot, configs, stats] = await Promise.all([
      c.traders.getTraderStateSnapshot(authority, { traderPdaIndex: this.#traderPdaIndex }),
      this.#marketConfigs(false),
      c.markets.getLatestMarketsStats(),
    ]);
    return parseAccount(snapshot, configs, markPrices(stats), this.#clock.now());
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
    const c = this.#api();
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
    let series: FundingOverviewSeries;
    try {
      series = await this.#api().funding.getFundingOverviewBySymbol(symbol, { startTime, endTime, perMarketLimit: limit });
    } catch (err) {
      if (err instanceof PhoenixHttpError && err.status === 404) throw new Error(`phoenix funding overview: unknown symbol ${symbol}`);
      throw err;
    }
    return parseFundingSeries(series, startTime, endTime);
  }

  /** Releases the SDK client, if one was made. Reads after this make a new one. */
  close(): void {
    this.#sdk?.dispose();
    this.#sdk = null;
    this.#clients = null;
  }

  #marketConfigs(fresh: boolean): Promise<ExchangeMarketConfig[]> {
    const now = this.#clock.now();
    if (!fresh && this.#configs !== null && now - this.#configs.at < CONFIG_TTL_MS) return this.#configs.value;
    const value = this.#api().exchange.getMarkets();
    const entry = { at: now, value };
    this.#configs = entry;
    // A failed read is not kept: the next call asks again.
    value.catch(() => {
      if (this.#configs === entry) this.#configs = null;
    });
    return value;
  }

  #api(): Clients {
    if (this.#clients !== null) return this.#clients;
    let transport: HttpTransport;
    if (this.#fetch !== undefined) {
      transport = new FetchTransport(this.apiUrl, this.#fetch, this.#timeoutMs);
    } else {
      this.#sdk = createPhoenixClient({ apiUrl: this.apiUrl, rpcUrl: this.#rpcUrl, exchangeMetadata: { stream: false } });
      transport = this.#sdk.api;
    }
    this.#clients = {
      exchange: new api.V1ExchangeClient(transport),
      funding: new api.V1FundingClient(transport),
      markets: new api.V1MarketsClient(transport),
      orderbook: new api.V1OrderbookClient(transport),
      traders: new api.V1TradersClient(transport),
    };
    return this.#clients;
  }
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
 */
export class FetchTransport implements HttpTransport {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, fetchFn: typeof fetch, timeoutMs = 10_000) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetchFn;
    this.#timeoutMs = timeoutMs;
  }

  fetch(method: string, endpoint: string, options?: RequestOptions, body?: unknown): Promise<Response> {
    if (method.toUpperCase() !== 'GET' || body !== undefined) {
      return Promise.reject(new Error(`phoenix reader: ${method} ${endpoint}: only GET requests, readers never write`));
    }
    const url = new URL(`${this.#baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`);
    if (options?.params !== undefined) appendParams(url, options.params);
    return this.#fetch(url.href, {
      method: 'GET',
      headers: { accept: 'application/json', ...options?.headers },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
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
): AccountState {
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
  const positions: PhoenixPosition[] = [];
  for (const sub of margin.subaccounts) {
    equity += BigInt(sub.margin.portfolioValueQuoteLots);
    maintenance += BigInt(sub.margin.maintenanceMarginQuoteLots);
    if (sub.subaccountIndex === 0) free = BigInt(sub.margin.withdrawableQuoteCollateralQuoteLots);
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
