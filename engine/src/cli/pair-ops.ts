// The carry pair's open and close as pair-mainnet runs them, as a library: `pair-mainnet open` / `close` (the CLI) and
// serve's strategy loop (serve-pair.ts, through the loop's enter, exit and rotate) call the same code. What it checks
// before an open (the refusals) and how it sends (maker first, the stored price refreshed before each part, the C10
// meter's post-only cap, finish()'s cancel and residual hedge) are pair-mainnet.ts's header; nothing here changed when
// it moved out of the CLI.
//
// The pair is any two of Hyperliquid, Orderly and Phoenix (trade/pair-shape.ts; anything but short Hyperliquid / long
// Phoenix only with GIMBAL_ORDERLY_PAIRS=1). Hyperliquid, whenever it is a leg, goes first as a post-only maker order and
// its partner follows as an IOC for what it filled; Orderly takes IOC orders only (the contract allows IOC or LIMIT, no
// post-only, and a resting LIMIT could be replayed for 300 s), so Orderly and Phoenix go as two IOCs at once. finish()'s
// residual hedge goes on the IOC leg. The Phoenix checks (exchange and market pins, SOL, the simulated IOC) run only
// when Phoenix is a leg, Hyperliquid's (margin mode, resting orders, the builder fee) only when Hyperliquid is; an
// Orderly leg needs serve's Orderly session (OpsCtx.orderly: pair-mainnet has none and refuses one) and, for an open, the
// owner's IP list applied on chain.
//
// The context says where output goes (`say`, and `open` for what the owner must reconcile) and how orders go out
// (Pair.run): the CLI sends through its own PairTrader and stops it when it exits; serve sends through its
// ProtectedPair, whose guarded legs save every order in flight before it is signed, and keeps the trader running.

import type { ContractPolicy, TxRef, VenueId } from '@gimbal/shared';
import type { ContractConfigView, NearContractClient } from '../contract/near-client.ts';
import { oraclePriced } from '../contract/oracle-assets.ts';
import type { DeskView } from '../contract/types.ts';
import type { SolanaChain } from '../relayer/phoenix-money.ts';
import { SYSTEM_ACCOUNT_RENT_LAMPORTS, solText, txCostLamports } from '../relayer/phoenix-money.ts';
import type { SnapshotMarket } from '../relayer/phoenix-tx.ts';
import { ORDER_COMPUTE_UNITS, ORDER_UNITS_REFUSE_ABOVE, exchangeMismatches, marketMismatches, splineOf } from '../relayer/phoenix-tx.ts';
import type { DeskSolanaAccounts } from '../relayer/phoenix-withdraw.ts';
import type { Relayer } from '../relayer/relayer.ts';
import type { SolanaSubmitter } from '../relayer/solana.ts';
import type { CarryLegInput, CarryPlan } from '../trade/carry-plan.ts';
import { carryPlan, meanRatePerHour, pct, usd } from '../trade/carry-plan.ts';
import { DEFAULT_SCANNER_CONFIG, MAINNET_COSTS, hlFillFeeBps } from '../scanner/config.ts';
import { bookMid } from '../scanner/costs.ts';
import type { LegOutcome, LegSide, MakerSettings, TradeLeg } from '../trade/legs.ts';
import { HlLeg } from '../trade/legs.ts';
import { commonLot, floorToLot, qtyNumber, qtyString, signedQtyString, toQty } from '../trade/lots.ts';
import type { CloseRequest, PairResult } from '../trade/pair.ts';
import { PairTrader } from '../trade/pair.ts';
import { PhoenixLeg, parseTraderSnapshot, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import type { PairLeg, PairShape } from '../trade/pair-shape.ts';
import { defaultShape, isDefaultShape, longLeg, makerIndexOf, shapeRefusal, shortLeg } from '../trade/pair-shape.ts';
import type { HyperliquidReader } from '../venues/hyperliquid.ts';
import type { OrderlyMarket, OrderlyReader } from '../venues/orderly.ts';
import type { PhoenixReader } from '../venues/phoenix.ts';
import { phoenixGet } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { AccountState, Book } from '../venues/venue.ts';
import type { PriceDeps, StoredPrice } from './pair-mainnet-lib.ts';
import { OPEN_HEADROOM_S, PRICE_MARGIN_S, UsageError, ensureFresh, hlCross, oraclePxOf, phoenixCross, priceFitRefusal, priceLifeS, restingOrdersRefusal, settleResidual } from './pair-mainnet-lib.ts';

/** Phoenix orders one pair part may take: the open, its retry, and two unwind orders. */
export const ORDERS_PER_PART = 4;

/** What the open and close read, sign with and print to. */
export interface OpsCtx {
  client: Pick<NearContractClient, 'prices'>;
  config: ContractConfigView;
  desk: DeskView;
  hlUrl: string;
  hl: Pick<HyperliquidReader, 'book' | 'funding' | 'marketFundingHistory' | 'markets' | 'account'>;
  phoenix: Pick<PhoenixReader, 'book' | 'funding' | 'marketFundingHistory' | 'account'>;
  phoenixUrl: string;
  chain: SolanaChain;
  solana: SolanaSubmitter;
  sol: DeskSolanaAccounts;
  /** The signing relayer (--send, or serve trading); null: nothing is signed. */
  relayer: Relayer | null;
  /** The desk's Orderly side (serve's Orderly session); absent or null: no Orderly leg can be built or planned. */
  orderly?: OrderlyOps | null;
  prices: PriceDeps;
  /** --send (the CLI), or serve trading. */
  send: boolean;
  /**
   * Set once an --send open or close has passed its refusals: only then may a leg's price read send refresh_prices.
   * The one exception is refreshForOpen's, at --send after planOpen's refusals passed, of a stored price that is
   * missing or too old for the first part.
   */
  trading: boolean;
  say(line?: string): void;
  /** Something the owner must reconcile (the CLI prints it as an `open:` line); `alert` false: printed, no exit code 3. */
  open(line: string, alert?: boolean): void;
}

/** What an Orderly leg is built with here; the session that owns the desk's private stream builds the leg itself. */
export interface OrderlyLegSpec {
  /** The Orderly market: PERP_<symbol>_USDC. */
  symbol: string;
  /**
   * The contract's stored price of the pair's symbol (oraclePxOf): once trading, one about to go stale is refreshed
   * before the order is priced, so a reduce-only close passes the contract's band check against it too.
   */
  oraclePx: () => Promise<number | null>;
  maxNotionalUsd: number;
  maxSz?: string;
  slippageBps: number;
}

/** The desk's Orderly side, through serve's private session (cli/serve.ts); pair-mainnet has none. */
export interface OrderlyOps {
  /** Public reads (shared and gimbal_dex markets): book, funding, its history, market info (lot, base MMR, period). */
  reader: Pick<OrderlyReader, 'book' | 'funding' | 'marketFundingHistory' | 'markets'>;
  /** The desk's Orderly account over the session: equity, maintenance, positions. Throws when it is not known. */
  account(): Promise<AccountState>;
  /** Whether the contract signed ip_restriction for the desk's current IP list (get_desk_settings orderly_ips_applied). */
  ipsApplied(): Promise<boolean>;
  /** The desk's Orderly leg on `spec.symbol` over the session; null when the session is not up. */
  leg(spec: OrderlyLegSpec): TradeLeg | null;
}

/** The order options of an open or close (pair-mainnet-lib.ts orderOptions). */
export interface OrderOptions {
  maker: MakerSettings;
  microLamports: number;
  slippageBps: number;
}

// ---- reads ----

export async function hlInfo<T>(ctx: Pick<OpsCtx, 'hlUrl'>, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${ctx.hlUrl}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`hyperliquid /info ${String(body.type)}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Through the Phoenix host's budget (venues/phoenix.ts phoenixGet): critical, retried after a 429. */
export function phoenixApiGet<T>(ctx: Pick<OpsCtx, 'phoenixUrl'>, path: string): Promise<T> {
  return phoenixGet<T>(ctx.phoenixUrl, path, { timeoutMs: 20_000 });
}

export interface PhoenixMarketConfig extends SnapshotMarket {
  symbol: string;
  takerFee: number;
  leverageTiers: { maxLeverage: number; maxSizeBaseLots: string }[];
  riskFactors: { maintenanceBps?: number; maintenance: number };
}

export async function phoenixExchange(ctx: Pick<OpsCtx, 'phoenixUrl'>): Promise<{ mismatches: string[]; markets: PhoenixMarketConfig[] }> {
  const snap = await phoenixApiGet<{ exchange: Record<string, unknown>; markets: PhoenixMarketConfig[] }>(ctx, '/v1/exchange/snapshot');
  return { mismatches: exchangeMismatches(snap.exchange), markets: snap.markets };
}

/** Where the policy's Phoenix markets differ from the exchange's (orderbook, spline, lot, tick), one line each. */
export async function policyMarketMismatches(ctx: Pick<OpsCtx, 'desk'>, markets: PhoenixMarketConfig[], symbols?: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const m of ctx.desk.policy.phoenix_markets) {
    if (symbols !== undefined && !symbols.includes(m.symbol)) continue;
    out.push(...marketMismatches(markets.find((x) => x.symbol === m.symbol), m, await splineOf(m.orderbook)));
  }
  return out;
}

/**
 * Phoenix maintenance margin as a fraction of notional for a position of `lots`: Phoenix's SDK computes it as the
 * initial margin (notional / the leverage tier's maxLeverage) times riskFactors.maintenanceBps / 1e4
 * (@ellipsis-labs/rise src/margin/compute.ts, maintenanceMarginFactorBps over initialMarginForAsset).
 */
export function phoenixMaintenanceRate(m: PhoenixMarketConfig, lots: bigint): number {
  const tier = m.leverageTiers.find((t) => BigInt(t.maxSizeBaseLots) >= lots) ?? m.leverageTiers.at(-1);
  if (tier === undefined || !(tier.maxLeverage > 0)) throw new Error(`phoenix ${m.symbol}: no leverage tier`);
  const bps = m.riskFactors.maintenanceBps ?? m.riskFactors.maintenance * 100;
  return (bps / 10_000) / tier.maxLeverage;
}

export async function traderState(ctx: Pick<OpsCtx, 'phoenixUrl' | 'sol'>): Promise<string | null> {
  const raw = await phoenixTraderApi(ctx.phoenixUrl).traderState(ctx.sol.authority);
  return parseTraderSnapshot(raw, '').state;
}

/** The contract's stored price of `symbol` and its age (s), or null. */
export async function storedPrice(client: Pick<NearContractClient, 'prices'>, symbol: string): Promise<StoredPrice | null> {
  const row = (await client.prices()).find((p) => p.asset === symbol);
  return row === undefined ? null : { px: Number(row.price_e8) / 1e8, ageS: (Date.now() - row.at_ms) / 1000 };
}

// ---- the pair ----

/** How a pair's orders go out (see the header). */
export interface PairRunner {
  openInChunks: PairTrader['openInChunks'];
  close(request: CloseRequest): Promise<PairResult>;
  /** finish()'s residual IOC on the IOC leg (the maker leg's partner); never throws. */
  hedge(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome>;
  /** finish() stops the trader first (a CLI about to exit); serve's trader keeps running. */
  stopOnFinish: boolean;
}

export interface Pair {
  symbol: string;
  /** The legs' venues and markets in the trader's order, and which is long. */
  shape: PairShape;
  /** The venue legs, in the trader's order (serve's trader holds them guarded). */
  legs: [TradeLeg, TradeLeg];
  /** Hyperliquid's leg when it is one (its post-only orders), else null. */
  hl: HlLeg | null;
  /** Phoenix's leg when it is one (the simulated IOC), else null. */
  phoenix: PhoenixLeg | null;
  /** Hyperliquid's index: it goes first, post-only; null: no maker leg, both legs IOC at once. */
  makerIndex: 0 | 1 | null;
  trader: PairTrader;
  run: PairRunner;
  lot: bigint;
  bandBps: number;
  priced: boolean;
  /** The policy market against the live exchange: refused at --send when not empty. */
  mismatches: string[];
  /** Phoenix's market config when Phoenix is a leg (taker fee, leverage tiers, maintenance). */
  marketConfig: PhoenixMarketConfig | null;
  /** Orderly's market when Orderly is a leg (base MMR, funding period, minimum notional). */
  orderlyMarket: OrderlyMarket | null;
  maker: MakerSettings;
  microLamports: number;
  /**
   * The sum of the operation's targets, what finish() brings the pair back to (PairTrader.net after it): hl + px as an
   * open found them, 0 for a close (both legs to flat).
   */
  targetNet: bigint | null;
}

/** The index of the leg the residual hedge goes on: the maker leg's partner (with no maker leg, none is ever sent). */
export function iocIndexOf(pair: Pick<Pair, 'makerIndex'>): 0 | 1 {
  return pair.makerIndex === 0 ? 1 : 0;
}

/** The capitalised venue name, as the plan lines print it. */
export function venueName(v: VenueId): string {
  return v === 'hyperliquid' ? 'Hyperliquid' : v === 'orderly' ? 'Orderly' : 'Phoenix';
}

/**
 * The CLI's runner: its own trader, and the IOC leg for the residual hedge (raw, or through the trader when the leg
 * is replayable, so its replay window is watched: PairTrader.hedge).
 */
export function traderRunner(trader: PairTrader, ioc: TradeLeg): PairRunner {
  const index: 0 | 1 = trader.legs[0] === ioc ? 0 : 1;
  return {
    openInChunks: (request) => trader.openInChunks(request),
    close: (request) => trader.close(request),
    hedge: (side, size, reduceOnly, reason) => (ioc.replayable
      ? trader.hedge(index, side, size, reduceOnly, reason)
      : ioc.order(side, size, reduceOnly, reason)),
    stopOnFinish: true,
  };
}

/**
 * The legs of `shape` (default short Hyperliquid / long Phoenix), a trader on them, and the Phoenix market checked
 * against the live exchange when Phoenix is a leg (pair-mainnet's buildPair). `orders` is read after the symbol is
 * checked against the policy, as pair-mainnet always did.
 */
export async function buildPair(ctx: OpsCtx, symbol: string, orders: () => OrderOptions, closing = false, shape: PairShape = defaultShape(symbol)): Promise<Pair> {
  const p: ContractPolicy = ctx.desk.policy;
  const asset = p.hl_assets.find((a) => a.symbol === symbol);
  const market = p.phoenix_markets.find((m) => m.symbol === symbol);
  if (isDefaultShape(shape, symbol) && (asset === undefined || market === undefined)) {
    throw new Error(`${symbol} must be in both policy.hl_assets (${p.hl_assets.map((a) => a.symbol).join(', ')}) and policy.phoenix_markets (${p.phoenix_markets.map((m) => m.symbol).join(', ')})`);
  }
  // The flag is the caller's to judge (pair-mainnet and serve refuse another pair without it): here, the policy only.
  const listed = shapeRefusal(p, symbol, shape, true);
  if (listed !== null) throw new Error(listed);
  const { maker, microLamports, slippageBps } = orders();
  const unpriced = p.unpriced.find((u) => u.symbol === symbol);
  // An unpriced symbol has no stored price to outlive (no band, max_sz instead).
  const fit = unpriced === undefined ? priceFitRefusal(maker.timeoutMs / 1000, p.oracle_max_age_s) : null;
  if (fit !== null) throw new UsageError(fit);
  const maxNotionalUsd = unpriced === undefined ? p.max_notional_usd : Math.min(p.max_notional_usd, p.unpriced_max_notional_usd);
  // Planning (a dry run, or --send before its refusals pass) prices with the stored price as it is; once trading, one
  // about to go stale is refreshed before an order is priced, so an unwind or a close is never refused for it.
  const oraclePx = unpriced !== undefined ? async () => null : oraclePxOf(ctx.prices, symbol, () => ctx.send && ctx.trading);
  const relayer = ctx.relayer ?? dryRelayer();
  const evm = ctx.desk.evm_address.toLowerCase();
  const build = async (leg: PairLeg): Promise<TradeLeg> => {
    if (leg.venue === 'hyperliquid') {
      return new HlLeg({
        relayer, info: (body) => hlInfo(ctx, body), user: evm, coin: symbol, asset: asset!.index, szDecimals: asset!.sz_decimals, oraclePx,
        bandBps: p.price_band_bps, maxNotionalUsd, ...(unpriced === undefined ? {} : { maxSz: unpriced.max_sz }),
        bestPx: async (side: LegSide) => {
          const book = await ctx.hl.book(symbol, 5);
          const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
          if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on Hyperliquid ${symbol}`);
          return px;
        },
        slippageBps, maker,
      });
    }
    if (leg.venue === 'phoenix') {
      const spline = await splineOf(market!.orderbook);
      return new PhoenixLeg({
        relayer, chain: ctx.chain, landedSlot: (sig) => ctx.solana.landedSlot(sig), waitPastLastValidHeight: (h) => ctx.solana.waitPastLastValidHeightSlot(h),
        api: phoenixTraderApi(ctx.phoenixUrl), desk: ctx.sol,
        market: { symbol, orderbook: market!.orderbook, spline, baseLotE8: market!.base_lot_e8, tickE8: market!.tick_e8 },
        oraclePx, bandBps: p.price_band_bps, maxNotionalUsd, ...(unpriced === undefined ? {} : { maxSz: unpriced.max_sz }),
        bestPx: async (side) => {
          const book = await ctx.phoenix.book(symbol, 5);
          const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
          if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on Phoenix ${symbol}`);
          return px;
        },
        slippageBps, microLamports,
      });
    }
    const made = ctx.orderly?.leg({ symbol: leg.symbol, oraclePx, maxNotionalUsd, ...(unpriced === undefined ? {} : { maxSz: unpriced.max_sz }), slippageBps }) ?? null;
    if (made === null) throw new Error(`an Orderly leg (${leg.symbol}) needs the desk's Orderly session, and ${ctx.orderly == null ? 'there is none here (pair-mainnet has none: Orderly pairs run in serve)' : 'it is not up'}: nothing is built or sent`);
    return made;
  };
  const legs: [TradeLeg, TradeLeg] = [await build(shape.legs[0]), await build(shape.legs[1])];
  const trader = new PairTrader({
    legs, priceBandBps: p.price_band_bps, log: (line) => ctx.say(`trade     ${line}`),
    openBlocked: () => (ctx.desk.closing === true ? 'the desk is closing (panic_close)' : null),
    onWatch: (w) => {
      if (w.status === 'unhedged') ctx.open(`watch: ${w.notes.join('; ')}`, false);
    },
  });
  const iocLeg = legs[makerIndexOf(shape) === 0 ? 1 : 0];
  return pairOf(ctx, { symbol, shape, legs, trader, run: traderRunner(trader, iocLeg), maker, microLamports, priced: unpriced === undefined, closing });
}

/**
 * A Pair of legs and a trader made elsewhere (serve's, behind its ProtectedPair), with the Phoenix exchange and the
 * policy market checked as buildPair checks them when Phoenix is a leg, and the Orderly market read when Orderly is.
 */
export async function pairOf(ctx: Pick<OpsCtx, 'desk' | 'phoenixUrl' | 'orderly'>, p: {
  symbol: string; shape: PairShape; legs: [TradeLeg, TradeLeg]; trader: PairTrader; run: PairRunner; maker: MakerSettings; microLamports: number; priced: boolean; closing: boolean;
}): Promise<Pair> {
  const venueOf = (i: 0 | 1) => p.shape.legs[i].venue;
  for (const i of [0, 1] as const) {
    if (p.legs[i].venue !== venueOf(i)) throw new Error(`leg ${i} is on ${p.legs[i].venue}, but the pair's leg ${i} is ${venueOf(i)}`);
  }
  const hl = p.legs.find((l) => l.venue === 'hyperliquid') ?? null;
  const phoenix = p.legs.find((l) => l.venue === 'phoenix') ?? null;
  if (hl !== null && !(hl instanceof HlLeg)) throw new Error('the Hyperliquid leg is not an HlLeg');
  if (phoenix !== null && !(phoenix instanceof PhoenixLeg)) throw new Error('the Phoenix leg is not a PhoenixLeg');
  const diffs: string[] = [];
  let marketConfig: PhoenixMarketConfig | null = null;
  if (phoenix !== null) {
    const market = ctx.desk.policy.phoenix_markets.find((m) => m.symbol === p.symbol);
    if (market === undefined) throw new Error(`${p.symbol} is not in policy.phoenix_markets`);
    const spline = await splineOf(market.orderbook);
    const { mismatches, markets } = await phoenixExchange(ctx);
    const found = markets.find((m) => m.symbol === p.symbol);
    if (found === undefined) throw new Error(`Phoenix has no ${p.symbol} market`);
    marketConfig = found;
    // A close is reduce-only: a market in maintenance or suspended still takes it; the orderbook, lot and tick must match.
    diffs.push(...mismatches.map((m) => `the Phoenix exchange differs from the pinned accounts: ${m}`), ...marketMismatches(found, market, spline, { ignoreStatus: p.closing }));
  }
  let orderlyMarket: OrderlyMarket | null = null;
  const orderlyLeg = p.shape.legs.find((l) => l.venue === 'orderly');
  if (orderlyLeg !== undefined) {
    if (ctx.orderly == null) throw new Error(`an Orderly leg (${orderlyLeg.symbol}) needs the desk's Orderly session, and there is none here`);
    // A close is reduce-only and goes whatever the market's status, a market dropped from the list (or a list that
    // cannot be read) included, as a delisted one: nothing in a close reads it. An open needs it listed and active.
    const ol = ctx.orderly;
    const markets = p.closing ? await ol.reader.markets().catch(() => null) : await ol.reader.markets();
    orderlyMarket = markets?.find((m) => m.symbol === orderlyLeg.symbol) ?? null;
    if (orderlyMarket === null && !p.closing) throw new Error(`Orderly has no ${orderlyLeg.symbol} market the desk can trade`);
    if (orderlyMarket?.delisted === true && !p.closing) diffs.push(`Orderly ${orderlyLeg.symbol} is not active`);
  }
  const makerIndex = makerIndexOf(p.shape);
  return {
    symbol: p.symbol, shape: p.shape, legs: p.legs, hl: hl as HlLeg | null, phoenix: phoenix as PhoenixLeg | null, makerIndex,
    trader: p.trader, run: p.run, lot: commonLot(p.legs[0].lot, p.legs[1].lot), bandBps: ctx.desk.policy.price_band_bps,
    priced: p.priced, mismatches: diffs, marketConfig, orderlyMarket, maker: p.maker, microLamports: p.microLamports, targetNet: null,
  };
}

/** The dry run's relayer: anything that would sign is a bug in the dry path. */
function dryRelayer(): Relayer {
  const no = () => {
    throw new Error('dry run: nothing is signed');
  };
  return { hlOrder: no, hlCancel: no, solSign: no } as unknown as Relayer;
}

async function hlFunding(ctx: OpsCtx, symbol: string, since: number): Promise<{ now: number; mean7d: number | null; maxLeverage: number }> {
  const [rates, history, markets] = await Promise.all([ctx.hl.funding(), ctx.hl.marketFundingHistory(symbol, since, Date.now()), ctx.hl.markets()]);
  const now = rates.find((r) => r.symbol === symbol)?.ratePerHour;
  if (now === undefined) throw new Error(`Hyperliquid has no funding for ${symbol}`);
  const m = markets.find((x) => x.symbol === symbol);
  if (m === undefined) throw new Error(`Hyperliquid has no ${symbol} perp`);
  return { now, mean7d: meanRatePerHour(history), maxLeverage: m.maxLeverage };
}

async function phoenixFunding(ctx: OpsCtx, symbol: string, since: number): Promise<{ now: number | null; mean7d: number | null }> {
  const [rates, history] = await Promise.all([ctx.phoenix.funding(), ctx.phoenix.marketFundingHistory(symbol, since, Date.now())]);
  return { now: rates.find((r) => r.symbol === symbol)?.ratePerHour ?? null, mean7d: meanRatePerHour(history) };
}

/** Orderly's funding of `market` (PERP_<symbol>_USDC) now and its 7-day mean; throws when Orderly has none now. */
async function orderlyFunding(o: OrderlyOps, market: string, since: number): Promise<{ now: number; mean7d: number | null }> {
  const [rates, history] = await Promise.all([o.reader.funding(), o.reader.marketFundingHistory(market, since, Date.now())]);
  const now = rates.find((r) => r.symbol === market)?.ratePerHour;
  if (now === undefined) throw new Error(`Orderly has no funding for ${market}`);
  return { now, mean7d: meanRatePerHour(history) };
}

/** A leg's book on its venue, `depth` levels. */
function legBook(ctx: OpsCtx, leg: PairLeg, depth: number): Promise<Book> {
  if (leg.venue === 'hyperliquid') return ctx.hl.book(leg.symbol, depth);
  if (leg.venue === 'phoenix') return ctx.phoenix.book(leg.symbol, depth);
  if (ctx.orderly == null) return Promise.reject(new Error(`the Orderly ${leg.symbol} book needs the desk's Orderly session, and there is none here`));
  return ctx.orderly.reader.book(leg.symbol, depth);
}

/** Cross margin of the desk's Orderly account: positions at the mark (margin × leverage is the notional). */
function orderlyCross(a: AccountState): { equityUsd: number; maintenanceUsd: number; notionalUsd: number } {
  const notional = a.positions.filter((p) => p.size !== 0).reduce((acc, p) => acc + Math.abs(p.marginUsd * p.leverage), 0);
  return { equityUsd: a.equityUsd, maintenanceUsd: a.maintenanceMarginUsd, notionalUsd: notional };
}

/** The side a leg takes to open (its index long or short). */
function openSide(pair: Pick<Pair, 'shape'>, i: 0 | 1): LegSide {
  return pair.shape.longIndex === i ? 'BUY' : 'SELL';
}

/** The Phoenix IOC of one part, built and simulated unsigned: refusals when it fails or uses too many units. */
async function simulateIoc(ctx: OpsCtx, pair: Pair, phoenix: PhoenixLeg, size: bigint): Promise<{ lines: string[]; refusals: string[] }> {
  try {
    const side = openSide(pair, pair.shape.legs[0].venue === 'phoenix' ? 0 : 1);
    const plan = await phoenix.plan(side, size, false);
    const { message } = await phoenix.message(plan);
    const sim = await ctx.chain.simulate(message);
    const lines = [`ioc sim   Phoenix ${side} ${qtyString(size)} ${pair.symbol} at ${plan.px.toFixed(4)} (${plan.ticks} ticks, ${plan.lots} lots): ${sim.err === null ? 'ok' : `error ${JSON.stringify(sim.err)}`}, ${sim.unitsConsumed ?? '?'} CU of ${ORDER_COMPUTE_UNITS}`];
    for (const l of sim.logs.slice(-3)) lines.push(`          ${l}`);
    const refusals: string[] = [];
    if (sim.err !== null) refusals.push(`the Phoenix IOC fails in simulation (${JSON.stringify(sim.err)})`);
    else if (sim.unitsConsumed === null) refusals.push('the Phoenix IOC simulation reported no compute units');
    else if (sim.unitsConsumed > ORDER_UNITS_REFUSE_ABOVE) refusals.push(`the Phoenix IOC used ${sim.unitsConsumed} CU in simulation, over ${ORDER_UNITS_REFUSE_ABOVE} of the ${ORDER_COMPUTE_UNITS} limit`);
    return { lines, refusals };
  } catch (err) {
    return { lines: [`ioc sim   not run: ${errorMessage(err)}`], refusals: [`the Phoenix IOC could not be built and simulated: ${errorMessage(err)}`] };
  }
}

/** What an open asks for (pair-mainnet open's arguments): short Hyperliquid, long Phoenix. */
export interface OpenRequest {
  symbol: string;
  legUsd: number;
  leverage: number;
  holdDays: number;
  basisBps: number;
  /**
   * The leg size exactly, whole common lots (the strategy loop: decide() sized it); absent = legUsd at the mid, rounded
   * down to whole lots (pair-mainnet open). legUsd is still held to the policy cap.
   */
  qty?: string;
}

export interface OpenPlan {
  request: OpenRequest;
  /** Why the open must not be sent; empty: it may. */
  refusals: string[];
  size: bigint;
  carry: CarryPlan;
  /**
   * The stored price this open must refresh before its first order (refreshForOpen, a real open only, after every
   * refusal passed): missing, or too old to live the first part's margin. null: none needed (or an unpriced symbol).
   */
  refresh: { marginS: number; was: string } | null;
  /**
   * The price the plan's cap, minimum and IOC were judged on: the stored one, or the books' mid where none is stored
   * or a stale one is over the band from the books; null for an unpriced symbol. refreshForOpen plans again when the
   * refreshed price is over the band from it.
   */
  pricedAt: number | null;
}

/**
 * Everything an open checks before anything is signed, printed (the window, the carry, the size, the leverage, the
 * stored price, the SOL, the simulated Phoenix IOC, the maker plan); the refusals are returned, not thrown. Read-only:
 * it never sends refresh_prices. A stored price that is missing or too old to plan with is planned on as it is (on
 * the books' mid when none is stored or it is over the band from the books), so every other refusal is judged
 * first; a real open then refreshes it once, through refreshForOpen, only when nothing refused.
 *
 * Each venue's checks run only when it is a leg: Hyperliquid's margin mode, resting orders, builder fee and 10 USD
 * minimum; Phoenix's trader registration, SOL and simulated IOC; Orderly's funding, account, minimum notional and the
 * owner's IP list applied on chain (on mainnet the contract refuses an Orderly order that is not reduce-only until it
 * is: refused here, never retried). An Orderly input that cannot be read is a refusal: the carry is never priced
 * without it.
 */
export async function planOpen(ctx: OpsCtx, pair: Pair, request: OpenRequest): Promise<OpenPlan> {
  const { symbol, legUsd, leverage, holdDays, basisBps } = request;
  const policy = ctx.desk.policy;
  const refusals: string[] = [...pair.mismatches];
  const since = Date.now() - 7 * 86_400_000;
  const evm = ctx.desk.evm_address.toLowerCase();
  const { shape } = pair;
  const hasHl = shape.legs.some((l) => l.venue === 'hyperliquid');
  const phoenix = shape.legs.some((l) => l.venue === 'phoenix') ? pair.phoenix : null;
  if (shape.legs.some((l) => l.venue === 'phoenix') && phoenix === null) throw new Error('the pair has a Phoenix leg but no PhoenixLeg');
  const orderlyLeg = shape.legs.find((l) => l.venue === 'orderly') ?? null;
  const orderly = orderlyLeg === null ? null : ctx.orderly ?? null;
  if (orderlyLeg !== null && orderly === null) throw new Error(`an Orderly leg (${orderlyLeg.symbol}) needs the desk's Orderly session, and there is none here`);
  const none = Promise.resolve(null);

  const [hlF, pxF, olF, books, hlState, state, spRead, lamports, assetData, hlOpen, olAccount, olIps] = await Promise.all([
    hasHl ? hlFunding(ctx, symbol, since) : none,
    phoenix !== null ? phoenixFunding(ctx, symbol, since) : none,
    orderly !== null ? orderlyFunding(orderly, orderlyLeg!.symbol, since).catch((err: unknown) => errorMessage(err)) : none,
    // The books at the scanner's depth: the round trip walks each fill through them as the scanner's gate does.
    Promise.all([legBook(ctx, shape.legs[0], DEFAULT_SCANNER_CONFIG.bookDepth), legBook(ctx, shape.legs[1], DEFAULT_SCANNER_CONFIG.bookDepth)]),
    hasHl ? hlInfo<unknown>(ctx, { type: 'clearinghouseState', user: evm }) : none,
    phoenix !== null ? traderState(ctx) : none,
    storedPrice(ctx.client, symbol),
    phoenix !== null ? ctx.chain.balance(ctx.sol.authority) : none,
    hasHl ? hlInfo<{ leverage?: { type?: string; value?: number } }>(ctx, { type: 'activeAssetData', user: evm, coin: symbol }).catch(() => null) : none,
    hasHl ? hlInfo<unknown>(ctx, { type: 'openOrders', user: evm }).catch((err: unknown) => errorMessage(err)) : none,
    orderly !== null ? orderly.account().catch((err: unknown) => new Error(errorMessage(err))) : none,
    orderly !== null ? orderly.ipsApplied().catch((err: unknown) => errorMessage(err)) : none,
  ]);
  let pxAccount: Awaited<ReturnType<OpsCtx['phoenix']['account']>> | null = null;
  if (phoenix !== null) {
    const registered = state !== null && state !== 'uninitialized';
    pxAccount = registered ? await ctx.phoenix.account(ctx.sol.authority) : null;
    if (!registered) refusals.push(`the desk's Phoenix trader is not registered (${state ?? 'unknown'}): run the Phoenix registration (sol_sign_register), then fund-phoenix`);
  }
  if (ctx.desk.paused) refusals.push('the desk is paused: no open is signed');
  // The trader refuses an open on a closing desk too (buildPair's openBlocked); here it is judged with the rest.
  if (ctx.desk.closing === true) refusals.push('the desk is closing (panic_close)');
  // The cap is valued at max(limit, oracle), and the limit may be up to the band from the stored price.
  const legCap = policy.max_notional_usd * (1 - policy.price_band_bps / 10_000);
  if (legUsd > legCap + 1e-9) refusals.push(`legUsd ${usd(legUsd)} is over ${usd(legCap)}, the policy's ${policy.max_notional_usd} USD cap less the ${policy.price_band_bps} bps band`);
  if (hasHl) {
    const marginMode = assetData?.leverage?.type ?? null;
    if (marginMode !== 'cross') refusals.push(`Hyperliquid ${symbol} is in ${marginMode ?? 'an unreadable'} margin mode: only cross is planned (its liquidation is the account's); set it to cross on Hyperliquid`);
    const resting = restingOrdersRefusal(hlOpen, symbol);
    if (resting !== null) refusals.push(resting);
  }
  if (orderly !== null) {
    const market = orderlyLeg!.symbol;
    if (typeof olF === 'string') refusals.push(`Orderly ${market} funding cannot be read (${olF}): the carry is not priced without it`);
    if (olAccount instanceof Error) refusals.push(`the desk's Orderly account cannot be read (${olAccount.message}): its margin is not known`);
    if (olIps !== true) {
      refusals.push(typeof olIps === 'string'
        ? `the desk's Orderly IP list could not be read from the contract (get_desk_settings: ${olIps}); nothing is sent`
        : 'the contract has not applied the desk\'s Orderly IP list (get_desk_settings orderly_ips_applied is not true): on mainnet it refuses an Orderly order that is not reduce-only until the owner runs set_orderly_ips and the contract signs ip_restriction; nothing is sent');
    }
  }

  const bid = (i: 0 | 1) => books[i].bids[0]?.px ?? 0;
  const ask = (i: 0 | 1) => books[i].asks[0]?.px ?? 0;
  const mid = (bid(0) + ask(0) + bid(1) + ask(1)) / 4;
  let size = 0n;
  if (request.qty === undefined) {
    size = floorToLot(toQty((legUsd / mid).toFixed(8)), pair.lot);
  } else {
    try {
      size = toQty(request.qty);
    } catch (err) {
      refusals.push(`qty ${request.qty} is not a size: ${errorMessage(err)}`);
    }
    if (size < 0n || size % pair.lot !== 0n) {
      refusals.push(`qty ${request.qty} is not whole common lots of ${qtyString(pair.lot)}`);
      size = 0n;
    }
  }
  if (size === 0n) refusals.push(`${usd(legUsd)} at ${mid.toFixed(4)} is under one common lot ${qtyString(pair.lot)}`);
  // Hyperliquid's taker fee plus the builder fee every order carries (the contract's FeeConfig), counted once. Fails
  // closed: a config read without the fee (or with one the contract would not accept) prices nothing, it refuses.
  const hlFeeBps = hasHl ? hlFillFeeBps(ctx.config.fees?.hl_builder_tenth_bps) : null;
  if (hasHl && hlFeeBps === null) {
    refusals.push(`the contract's config() gave no usable fees.hl_builder_tenth_bps (${String(ctx.config.fees?.hl_builder_tenth_bps)}): the Hyperliquid fee, and so the round trip, is unknown`);
  }
  // Each leg's carry input: funding now and its 7-day mean, one fill's fee, the book, and the venue account's cross
  // margin at the mark (what liquidation and the effective leverage run on).
  const legInput = (i: 0 | 1): CarryLegInput => {
    const leg = shape.legs[i];
    const book = books[i];
    if (leg.venue === 'hyperliquid') {
      const f = hlF!;
      const c = hlCross(hlState);
      return {
        venue: 'hyperliquid', ratePerHour: f.now, rate7dPerHour: f.mean7d ?? f.now, feeBps: hlFeeBps ?? Number.NaN, book,
        equityUsd: c.equityUsd, maintenanceUsd: c.maintenanceUsd, notionalUsd: c.notionalUsd, maintenanceRate: 1 / (2 * f.maxLeverage),
      };
    }
    if (leg.venue === 'phoenix') {
      const f = pxF!;
      const c = pxAccount === null ? { equityUsd: 0, maintenanceUsd: 0, notionalUsd: 0 } : phoenixCross(pxAccount);
      const lotsAfter = (toQty(String(Math.abs(pxAccount?.positions.find((p) => p.symbol === symbol)?.size ?? 0))) + size) / phoenix!.lot;
      return {
        venue: 'phoenix', ratePerHour: f.now ?? 0, rate7dPerHour: f.mean7d ?? f.now ?? 0, feeBps: pair.marketConfig!.takerFee * 10_000, book,
        equityUsd: c.equityUsd, maintenanceUsd: c.maintenanceUsd, notionalUsd: c.notionalUsd,
        maintenanceRate: phoenixMaintenanceRate(pair.marketConfig!, lotsAfter),
      };
    }
    // Orderly: the scanner's taker fee plus gimbal_dex's markup on every order; maintenance at the market's base MMR.
    // A missing read prices nothing (NaN): it is refused above, and carryPlan refuses an unknown fee too.
    const f = typeof olF === 'string' || olF === null ? null : olF;
    const c = olAccount === null || olAccount instanceof Error ? null : orderlyCross(olAccount);
    const market = pair.orderlyMarket!;
    const fee = MAINNET_COSTS.fees.orderly;
    return {
      venue: 'orderly', ratePerHour: f?.now ?? 0, rate7dPerHour: f === null ? 0 : (f.mean7d ?? f.now), feeBps: f === null || c === null ? Number.NaN : fee.takerBps + fee.extraBps, book,
      periodHours: market.fundingPeriodHours,
      equityUsd: c?.equityUsd ?? 0, maintenanceUsd: c?.maintenanceUsd ?? 0, notionalUsd: c?.notionalUsd ?? 0, maintenanceRate: market.baseMmr,
    };
  };
  const longI = shape.longIndex;
  const shortI: 0 | 1 = longI === 0 ? 1 : 0;
  const short = legInput(shortI);
  const long = legInput(longI);
  const plan = carryPlan({ symbol, legUsd, leverage, holdDays, basisBufferBps: basisBps, short, long });
  refusals.push(...plan.refusals);

  // The stored price. One missing (a contract that never had refresh_prices) or too old to live the first part is not
  // refreshed here: the cap, the minimum and the IOC below are judged on it as it is (a missing one on the books' mid),
  // and a real open refreshes it after, through refreshForOpen, only when nothing refused. refresh_prices refreshes
  // the contract's oracle assets only: another symbol's price cannot be refreshed, so it is refused here.
  const sp = spRead;
  const marginS = pair.maker.timeoutMs / 1000 + PRICE_MARGIN_S;
  const was = sp === null ? 'missing' : `${Math.round(sp.ageS)} s old`;
  let refresh: OpenPlan['refresh'] = null;
  const tooOld = pair.priced && (sp === null || sp.ageS > ctx.prices.maxAgeS - marginS);
  if (tooOld) {
    if (!oraclePriced(symbol)) {
      refusals.push(sp === null
        ? `the contract has no stored ${symbol} price`
        : `the stored ${symbol} price is ${was} and refresh_prices cannot refresh it (${symbol} is not one of the contract's oracle assets)`);
    } else if (!ctx.send && sp === null) {
      refusals.push(`the contract has no stored ${symbol} price`);
    } else {
      refresh = { marginS, was };
    }
  }
  // A stale row is good enough to judge on while it is within the band of the books; one further off (a price days
  // old), or none, is planned on the books' mid instead.
  const band = policy.price_band_bps / 10_000;
  const offBook = sp !== null && mid > 0 && Math.abs(sp.px - mid) / mid > band;
  const estimated = tooOld && mid > 0 && (sp === null || offBook);
  if (estimated) (ctx.prices.estimate ??= new Map()).set(symbol, mid);
  const pricedAt = !pair.priced ? null : estimated ? mid : (sp?.px ?? null);

  let chunk: bigint | null = null;
  let sim: { lines: string[]; refusals: string[] } = { lines: ['ioc sim   no part to simulate'], refusals: [] };
  let parts = 0;
  try {
    try {
      chunk = await pair.trader.openChunk(1);
    } catch (err) {
      refusals.push(`no pair fits the policy cap: ${errorMessage(err)}`);
    }
    parts = chunk === null || size === 0n ? 0 : Number((size + chunk - 1n) / chunk);
    const first = chunk === null || size === 0n ? null : size < chunk ? size : chunk;
    for (const i of [0, 1] as const) {
      const v = shape.legs[i].venue;
      if (first === null) break;
      if (v === 'hyperliquid' && qtyNumber(first) * ask(i) < 10) refusals.push(`a pair part of ${qtyString(first)} ${symbol} is under Hyperliquid's 10 USD order minimum`);
      const minNotional = pair.orderlyMarket?.minNotional ?? 0;
      if (v === 'orderly' && qtyNumber(first) * ask(i) < minNotional) refusals.push(`a pair part of ${qtyString(first)} ${symbol} is under Orderly's ${minNotional} USD minimum notional`);
    }
    if (first !== null && phoenix !== null) sim = await simulateIoc(ctx, pair, phoenix, first);
  } finally {
    if (estimated) ctx.prices.estimate?.delete(symbol);
  }
  const orderTx = txCostLamports({ units: ORDER_COMPUTE_UNITS, microLamports: pair.microLamports });
  const solNeed = Math.max(1, parts) * ORDERS_PER_PART * orderTx + SYSTEM_ACCOUNT_RENT_LAMPORTS;
  if (phoenix !== null && lamports! < solNeed) refusals.push(`the desk authority holds ${solText(lamports!)}; ${Math.max(1, parts)} pair part(s) need up to ${solText(solNeed)} for Phoenix fees and the rent-exempt reserve: send ${solText(solNeed - lamports!)} to ${ctx.sol.authority}`);
  refusals.push(...sim.refusals);

  printCarry(ctx, symbol, legUsd, leverage, holdDays, basisBps, plan, short, long, { shortBid: bid(shortI), shortAsk: ask(shortI), longBid: bid(longI), longAsk: ask(longI) });
  ctx.say(`size      ${qtyString(size)} ${symbol} per leg (${usd(qtyNumber(size) * mid)} at ${mid.toFixed(4)}); common lot ${qtyString(pair.lot)}`);
  ctx.say(`          ${parts} pair part(s) of at most ${chunk === null ? '?' : qtyString(chunk)} (policy max_notional_usd ${policy.max_notional_usd} less the ${pair.bandBps} bps band)`);
  if (hasHl) ctx.say(`leverage  Hyperliquid ${symbol}: ${assetData?.leverage === undefined ? 'unknown' : `${assetData.leverage.type} ${assetData.leverage.value}x`} on the account (the contract cannot set it); effective leverage is what is checked`);
  ctx.say(`price     stored ${symbol} ${sp === null ? 'none' : `${sp.px}, ${Math.round(sp.ageS)} s old`}${estimated ? ` (planned on the books' mid ${mid.toFixed(4)}${sp === null ? '' : ', the stored one is over the band from the books'})` : ''}${refresh === null ? '' : `; ${ctx.send ? 'the open refreshes it once every check above passed' : '--send refreshes it once its checks pass'}`}; --send refreshes it before each part when it would not live ${marginS} s more (a fresh one lives ${priceLifeS(policy.oracle_max_age_s)} s of the ${policy.oracle_max_age_s})`);
  if (phoenix !== null) {
    ctx.say(`solana    authority ${solText(lamports!)}; up to ${solText(solNeed)} needed (unit price ${pair.microLamports} µlamports)`);
    for (const l of sim.lines) ctx.say(l);
  }
  if (orderly !== null) ctx.say(`orderly   ${orderlyLeg!.symbol}: IP list ${olIps === true ? 'applied on chain' : 'NOT applied'}; base MMR ${pct(pair.orderlyMarket!.baseMmr)}, funding every ${pair.orderlyMarket!.fundingPeriodHours} h, minimum ${pair.orderlyMarket!.minNotional} USD`);
  ctx.say(`order     ${orderPlanLine(pair)}`);
  return { request, refusals, size, carry: plan, refresh, pricedAt };
}

/** How an open's orders go: the maker leg first and its partner by IOC for what filled, or both by IOC at once. */
function orderPlanLine(pair: Pair): string {
  const m = pair.makerIndex;
  if (m === null) {
    const [a, b] = [0, 1].map((i) => `${venueName(pair.shape.legs[i]!.venue)} ${openSide(pair, i as 0 | 1)}`);
    return `no post-only leg: ${a} and ${b} go as two IOCs at once for each part`;
  }
  const ioc = iocIndexOf(pair);
  const side = openSide(pair, m);
  return `maker first: ${venueName(pair.shape.legs[m].venue)} ${side} post-only at the ${side === 'SELL' ? 'ask' : 'bid'}, repriced every ${pair.maker.repriceMs / 1000} s, at most ${pair.maker.maxOrders} signed post-only orders for the whole open (the C10 meter counts each), for ${pair.maker.timeoutMs / 1000} s${pair.maker.takerFallback ? ', then an IOC for the rest' : ', no taker fallback (--taker-fallback to add one)'}; then ${venueName(pair.shape.legs[ioc].venue)} ${openSide(pair, ioc)} IOC for what filled`;
}

/** What refreshForOpen did: `refused` why the open must not be sent (null: it may); `paid` a refresh_prices was sent. */
export interface OpenRefresh {
  refused: string | null;
  paid: boolean;
  /** The price line to print, when it read one. */
  line: string | null;
  /** The plan to send: the one given, or planned again on the refreshed price. */
  plan: OpenPlan;
}

/**
 * The one refresh_prices of a real open whose plan needs it (OpenPlan.refresh), sent only after every refusal passed
 * (the plan's, and the caller's own before it: serve's price fit and gate): a refused open never pays for one. Through
 * ensureFresh at the first part's margin (shared with a refresh in flight, none within MIN_REFRESH_GAP_S of the last),
 * then held to OPEN_HEADROOM_S more, so the size check and the first part's own check find it fresh and send no second
 * one. When the refreshed price is over the band from the one the plan was judged on (OpenPlan.pricedAt), the
 * read-only planOpen runs again on it (`planning` on around it, serve's legs), so the part count, the SOL, the
 * Hyperliquid minimum and the IOC are checked on the new price; a refusal then is a paid one. Never throws: a refresh
 * that fails is a refusal with its reason.
 */
export async function refreshForOpen(ctx: OpsCtx, pair: Pair, plan: OpenPlan, options: { planning?: (on: boolean) => void } = {}): Promise<OpenRefresh> {
  const need = plan.refresh;
  const { symbol } = plan.request;
  if (need === null) return { refused: null, paid: false, line: null, plan };
  if (plan.refusals.length > 0) return { refused: `refused already, so the stored ${symbol} price (${need.was}) is not refreshed: ${plan.refusals.join('; ')}`, paid: false, line: null, plan };
  if (!ctx.send) return { refused: `the stored ${symbol} price is ${need.was}: a dry run does not refresh it`, paid: false, line: null, plan };
  let paid = false;
  const deps = counting(ctx.prices, () => {
    paid = true;
  });
  let sp: StoredPrice;
  try {
    sp = await ensureFresh(deps, symbol, need.marginS);
  } catch (err) {
    return { refused: `the stored ${symbol} price (${need.was}) could not be refreshed before the open: ${errorMessage(err)}`, paid, line: null, plan };
  }
  const left = ctx.prices.maxAgeS - need.marginS - sp.ageS;
  const line = `price     stored ${symbol} ${sp.px}, ${Math.round(sp.ageS)} s old${paid ? ' (refreshed for this open)' : ''}: it lives ${Math.round(left)} s past the first part's ${need.marginS} s`;
  if (left < OPEN_HEADROOM_S) {
    return { refused: `the stored ${symbol} price is ${Math.round(sp.ageS)} s old after refresh_prices: it lives ${Math.round(left)} s past the first part's ${need.marginS} s, under the ${OPEN_HEADROOM_S} s the open needs before it; nothing sent`, paid, line, plan };
  }
  const bandBps = ctx.desk.policy.price_band_bps;
  const movedBps = plan.pricedAt === null || !(plan.pricedAt > 0) ? 0 : (Math.abs(sp.px - plan.pricedAt) / plan.pricedAt) * 10_000;
  if (movedBps <= bandBps) return { refused: null, paid, line, plan };
  const moved = `the stored ${symbol} price after refresh_prices is ${sp.px}, ${Math.round(movedBps)} bps from the ${plan.pricedAt} the open was judged on (over the ${bandBps} bps band)`;
  ctx.say(`replan    ${moved}: planned again on it`);
  options.planning?.(true);
  let again: OpenPlan;
  try {
    again = await planOpen(ctx, pair, plan.request);
  } catch (err) {
    return { refused: `${moved}, and planning again failed: ${errorMessage(err)}; nothing sent`, paid, line, plan };
  } finally {
    options.planning?.(false);
  }
  const why = [...again.refusals, ...(again.refresh === null ? [] : [`the stored ${symbol} price is ${again.refresh.was} again`])];
  if (why.length > 0) return { refused: `${moved}, and planned again the open refuses: ${why.join('; ')}; nothing sent`, paid, line, plan: again };
  // Planning again takes seconds of the price's life: the headroom is checked again before anything else runs.
  const after = await ctx.prices.read(symbol);
  const leftAfter = after === null ? -Infinity : ctx.prices.maxAgeS - need.marginS - after.ageS;
  if (leftAfter < OPEN_HEADROOM_S) {
    const age = after === null ? 'missing' : `${Math.round(after.ageS)} s old`;
    return { refused: `${moved}; planned again, the stored ${symbol} price is ${age}: it lives ${Number.isFinite(leftAfter) ? Math.round(leftAfter) : 0} s past the first part's ${need.marginS} s, under the ${OPEN_HEADROOM_S} s the open needs before it; nothing sent`, paid, line, plan: again };
  }
  return { refused: null, paid, line, plan: again };
}

/**
 * `d` with each refresh_prices that reached the chain reported to `onRefresh` (it is paid for: the loop's caps count it
 * and a refusal after it holds the window): the call returned, or it threw and `d.reachedChain` (else `d.landed`) says
 * it got there, a transaction that failed or was refused on chain included, so one that keeps failing there is held and
 * capped. One that failed before the chain (an RPC or HTTP error, the prices() read) paid nothing.
 */
export function counting(d: PriceDeps, onRefresh: () => void): PriceDeps {
  return {
    ...d,
    refresh: async (s, maxAgeS) => {
      let tx: Awaited<ReturnType<PriceDeps['refresh']>>;
      try {
        tx = await d.refresh(s, maxAgeS);
      } catch (err) {
        if ((d.reachedChain ?? d.landed)?.(err) === true) onRefresh();
        throw err;
      }
      onRefresh();
      return tx;
    },
  };
}

/**
 * Sends a planned open whose refusals are empty: maker first, part by part, then finish(). `gate` (serve) is asked
 * before each part, after the price refresh (`onRefresh` hears of each refresh_prices it sends): a reason stops the
 * open there, with nothing of that part sent (the parts already sent are whole hedged pairs, each through its own
 * legging guard, and stay as they are).
 */
export async function sendOpen(
  ctx: OpsCtx, pair: Pair, plan: OpenPlan, reason = `pair-mainnet: carry ${plan.request.symbol}, short ${shortLeg(pair.shape).venue}, long ${longLeg(pair.shape).venue}`,
  options: { gate?: () => string | null; onRefresh?: () => void } = {},
): Promise<PairResult[]> {
  if (plan.refusals.length > 0) throw new Error(`open refused, nothing signed: ${plan.refusals.join('; ')}`);
  const { symbol } = plan.request;
  // The open's targets keep the legs' sum as it is. A fresh process reads Phoenix from slot 0, so a snapshot that lags
  // an earlier run's last IOC would set this wrong (README, the residual hedge).
  const [start0, start1] = await Promise.all([pair.legs[0].position(), pair.legs[1].position()]);
  pair.targetNet = start0 + start1;
  ctx.trading = true;
  if (pair.hl !== null) await approveBuilderFee(ctx);
  try {
    const results = await pair.run.openInChunks({
      size: plan.size, longIndex: pair.shape.longIndex, reason, ...(pair.makerIndex === null ? {} : { maker: { index: pair.makerIndex } }),
      beforePart: async () => {
        // Counted for the loop's caps. The legs' own read during a part (oraclePxOf, trading) may still refresh a
        // price within PRICE_STALE_MARGIN_S of going stale: not counted, on purpose. It fires only when a part outlasts
        // the margin checked here, and the price it stores lives minutes again, so it adds about one per part at
        // most, bounded per open by its parts (an unwind or a close must never be refused for a cap).
        if (pair.priced) await ensureFresh(options.onRefresh === undefined ? ctx.prices : counting(ctx.prices, options.onRefresh), symbol, pair.maker.timeoutMs / 1000 + PRICE_MARGIN_S);
        const gated = options.gate?.() ?? null;
        if (gated !== null) throw new Error(gated);
      },
    });
    for (const r of results) printResult(ctx, 'open', r);
    return results;
  } finally {
    await finish(ctx, pair);
  }
}

/** Hyperliquid refuses an order under 10 USD of value: a leg smaller than this is not sent. */
export const MIN_ORDER_USD = 10;

/**
 * The open's size held to the contract's cap at order time (review S2). The contract values an order at
 * sz × max(limit, oracle) against the policy cap (contract/core/src/hl.rs), so a price that rose after the size was
 * taken would be refused with E_SIZE, possibly after one leg filled. Before either leg is sent: when qty × worstPx is
 * over the cap, qty is rounded down to whole common lots under it, the same on both legs (it is only ever lowered);
 * under one lot, or under MIN_ORDER_USD at the mid, nothing is sent.
 */
export function capQtyAtOrder(p: { qty: bigint; lot: bigint; worstPx: number; midPx: number; capUsd: number }): { qty: bigint; cut: boolean } | { refused: string } {
  if (!(p.worstPx > 0) || !Number.isFinite(p.worstPx) || !(p.capUsd > 0)) return { refused: `no price to hold the size to the cap (worst ${p.worstPx}, cap ${p.capUsd})` };
  let qty = p.qty;
  let cut = false;
  if (qtyNumber(qty) * p.worstPx > p.capUsd) {
    const most = floorToLot(toQty((p.capUsd / p.worstPx).toFixed(8)), p.lot);
    qty = most < qty ? most : qty;
    // Rounding in toFixed must never leave it over: one lot less until it fits.
    while (qty > 0n && qtyNumber(qty) * p.worstPx > p.capUsd) qty -= p.lot;
    cut = true;
  }
  const at = `${qtyString(p.qty)} asked, ${qtyString(qty)} fits ${p.capUsd} USD at ${p.worstPx.toFixed(6)}`;
  if (qty < p.lot) return { refused: `the price moved: under one common lot ${qtyString(p.lot)} fits the cap (${at}); nothing sent` };
  if (qtyNumber(qty) * p.midPx < MIN_ORDER_USD) return { refused: `the price moved: ${qtyString(qty)} is ${(qtyNumber(qty) * p.midPx).toFixed(2)} USD, under the ${MIN_ORDER_USD} USD minimum order (${at}); nothing sent` };
  return { qty, cut };
}

/**
 * capQtyAtOrder on fresh numbers: the stored price (refreshed when it would not outlive the order, as the order
 * itself would) and both books. The highest price an order of the open may carry: the long leg's buy limit (the ask
 * plus `slippageBps`, at most the band over the stored price: Phoenix's or Orderly's IOC, or Hyperliquid's taker
 * fallback), the short leg's sell (a maker price or an IOC limit, at most the ask) and the stored price itself.
 */
export async function recheckOpenSize(
  ctx: OpsCtx, pair: Pair, size: bigint, slippageBps: number, onRefresh?: () => void,
): Promise<{ qty: bigint; cut: boolean; line: string } | { refused: string }> {
  const policy = ctx.desk.policy;
  const symbol = pair.symbol;
  const sp = pair.priced ? await ensureFresh(onRefresh === undefined ? ctx.prices : counting(ctx.prices, onRefresh), symbol, pair.maker.timeoutMs / 1000 + PRICE_MARGIN_S) : null;
  const books = await Promise.all([legBook(ctx, pair.shape.legs[0], 5), legBook(ctx, pair.shape.legs[1], 5)]);
  const ask0 = books[0].asks[0]?.px ?? 0;
  const ask1 = books[1].asks[0]?.px ?? 0;
  const mid = (ask0 + (books[0].bids[0]?.px ?? 0) + ask1 + (books[1].bids[0]?.px ?? 0)) / 4;
  if (!(ask0 > 0 && ask1 > 0 && mid > 0)) return { refused: `no ${symbol} book to hold the size to the cap; nothing sent` };
  const longAsk = pair.shape.longIndex === 0 ? ask0 : ask1;
  const shortAsk = pair.shape.longIndex === 0 ? ask1 : ask0;
  let buyLimit = longAsk * (1 + slippageBps / 10_000);
  if (sp !== null) buyLimit = Math.min(buyLimit, sp.px * (1 + policy.price_band_bps / 10_000));
  const worstPx = Math.max(buyLimit, shortAsk, sp?.px ?? 0);
  const unpriced = policy.unpriced.find((u) => u.symbol === symbol);
  const capUsd = unpriced === undefined ? policy.max_notional_usd : Math.min(policy.max_notional_usd, policy.unpriced_max_notional_usd);
  const r = capQtyAtOrder({ qty: size, lot: pair.lot, worstPx, midPx: mid, capUsd });
  if ('refused' in r) return r;
  const line = r.cut
    ? `size      ${qtyString(size)} -> ${qtyString(r.qty)} ${symbol} a leg: ${qtyString(size)} at ${worstPx.toFixed(6)} is over the ${capUsd} USD cap (the price rose since it was sized)`
    : `size      ${qtyString(r.qty)} ${symbol} a leg at ${worstPx.toFixed(6)} is within the ${capUsd} USD cap`;
  return { ...r, line };
}

/** What a close checks before anything is signed (printed); the refusals are returned, not thrown. */
export async function planClose(ctx: OpsCtx, pair: Pair): Promise<{ refusals: string[]; positions: [bigint, bigint] }> {
  const { symbol } = pair;
  const phoenixAt = pair.shape.legs.findIndex((l) => l.venue === 'phoenix');
  const [p0, p1, sp, lamports] = await Promise.all([
    pair.legs[0].position(), pair.legs[1].position(), storedPrice(ctx.client, symbol), phoenixAt < 0 ? Promise.resolve(0) : ctx.chain.balance(ctx.sol.authority),
  ]);
  const positions: [bigint, bigint] = [p0, p1];
  ctx.say(`positions ${pair.shape.legs.map((l, i) => `${l.venue} ${symbol} ${signedQtyString(positions[i]!)}`).join(', ')}${p0 + p1 === 0n ? ' (hedged)' : ' (NOT offsetting)'}`);
  const m = pair.makerIndex;
  ctx.say(m === null
    ? `order     both reduce-only: ${venueName(pair.shape.legs[0].venue)} and ${venueName(pair.shape.legs[1].venue)} IOC at once (no post-only leg); the rest by IOC`
    : `order     both reduce-only: ${venueName(pair.shape.legs[m].venue)} post-only at the touch (every ${pair.maker.repriceMs / 1000} s, at most ${pair.maker.maxOrders} for the close, ${pair.maker.timeoutMs / 1000} s${pair.maker.takerFallback ? ', then IOC' : ''}), then ${venueName(pair.shape.legs[iocIndexOf(pair)].venue)} IOC for what it closed; the rest by IOC`);
  ctx.say(`price     stored ${symbol} ${sp === null ? 'none' : `${sp.px}, ${Math.round(sp.ageS)} s old`}; --send refreshes it when an order finds it stale`);
  const refusals: string[] = [...pair.mismatches];
  if (p0 === 0n && p1 === 0n) refusals.push('nothing to close: both legs are flat');
  const solNeed = 2 * txCostLamports({ units: ORDER_COMPUTE_UNITS, microLamports: pair.microLamports }) + SYSTEM_ACCOUNT_RENT_LAMPORTS;
  if (phoenixAt >= 0 && positions[phoenixAt] !== 0n && lamports < solNeed) refusals.push(`the desk authority holds ${solText(lamports)}; closing on Phoenix needs ${solText(solNeed)}: send ${solText(solNeed - lamports)}`);
  return { refusals, positions };
}

/**
 * Sends a close whose refusals are empty: both legs to flat, maker first, then finish(). `options` adds to the close's
 * request (serve: reduceOnly and clampTargets, so nothing it sends can open or grow a leg).
 */
export async function sendClose(ctx: OpsCtx, pair: Pair, options: { reason?: string; reduceOnly?: boolean; clampTargets?: boolean } = {}): Promise<PairResult> {
  const { symbol } = pair;
  // The close targets flat on both legs ([0, 0], trader.net after it), whatever their sum was: the residual hedge
  // brings the IOC leg back against the maker leg's flat, not to an older imbalance.
  pair.targetNet = 0n;
  ctx.trading = true;
  if (pair.hl !== null) await approveBuilderFee(ctx);
  try {
    // The stored price refreshed first, as an open's is: a reduce-only Orderly or Phoenix order is checked against it
    // too (the contract's band), and each leg's own price read refreshes one about to go stale (oraclePxOf, trading).
    if (pair.priced) await ensureFresh(ctx.prices, symbol, pair.maker.timeoutMs / 1000 + PRICE_MARGIN_S);
    const { reason, ...rest } = options;
    const result = await pair.run.close({ reason: reason ?? `pair-mainnet: close ${symbol}`, ...(pair.makerIndex === null ? {} : { maker: { index: pair.makerIndex } }), ...rest });
    printResult(ctx, 'close', result);
    return result;
  } finally {
    await finish(ctx, pair);
  }
}

/** Before the first order: the builder fee approved on Hyperliquid (one more signature, once per desk). */
async function approveBuilderFee(ctx: OpsCtx): Promise<void> {
  const builder = ctx.config.treasury?.hl_builder;
  const tenth = ctx.config.fees?.hl_builder_tenth_bps;
  if (builder === undefined || tenth === undefined || tenth <= 0) return;
  const approved = await hlInfo<number>(ctx, { type: 'maxBuilderFee', user: ctx.desk.evm_address.toLowerCase(), builder: builder.toLowerCase() });
  if (Number(approved) >= tenth) return;
  const r = await ctx.relayer!.hlApproveBuilderFee();
  ctx.say(`builder   fee approved: ${refs(r.tx)}`);
}

function printCarry(
  ctx: OpsCtx, symbol: string, legUsd: number, leverage: number, holdDays: number, basisBps: number, plan: CarryPlan, short: CarryLegInput, long: CarryLegInput,
  book: { shortBid: number; shortAsk: number; longBid: number; longAsk: number },
): void {
  const say = (line: string) => ctx.say(line);
  const rate = (r: number) => `${(r * 100).toFixed(5)} %/h (${pct(r * 8760)} APR)`;
  say(`window    ${symbol}, ${usd(legUsd)} a leg, hold ${holdDays} d, ${leverage}x asked`);
  say(`          ${`${short.venue} (short)`.padEnd(20)}funding now ${rate(short.ratePerHour)}, 7-day mean ${rate(short.rate7dPerHour)}; book ${book.shortBid} / ${book.shortAsk}`);
  say(`          ${`${long.venue} (long)`.padEnd(20)}funding now ${rate(long.ratePerHour)}, 7-day mean ${rate(long.rate7dPerHour)}; book ${book.longBid} / ${book.longAsk}`);
  say(`          gross APR now ${pct(plan.grossAprNow)}, 7-day ${pct(plan.grossApr7d)} (short receives, long pays)`);
  say(`spread    expected over ${holdDays} d at the 7-day mean: ${usd(plan.expectedSpreadUsd)}`);
  const rt = plan.roundTrip;
  const mids = [bookMid(short.book.bids, short.book.asks), bookMid(long.book.bids, long.book.asks)];
  say(rt === null
    ? '          round trip not priced: a book has no two-sided touch'
    : `          round trip ${rt.bps.toFixed(2)} bps = ${usd(rt.totalUsd)}: 4 fills ${usd(rt.feesUsd)} (${short.feeBps} + ${long.feeBps} bps each way), `
      + `slippage ${usd(rt.slippageUsd)} (the books walked at ${usd(legUsd)}), basis buffer ${usd(rt.basisBufferUsd)} (adverse gap of the mids `
      + `${mids.map((m) => (m === null ? '?' : m.toString())).join(' / ')} + ${basisBps} bps)`);
  say(`          ${plan.costRefusal === null ? 'covers the round trip' : 'does NOT cover the round trip'}`);
  for (const [i, l] of plan.legs.entries()) {
    const src = i === 0 ? short : long;
    const eff = Number.isFinite(l.effectiveLeverage) ? `${l.effectiveLeverage.toFixed(2)}x` : 'no equity';
    say(`leg       ${l.venue} ${l.side}: equity ${usd(src.equityUsd)}, open ${usd(src.notionalUsd)}, effective leverage ${eff} (cap ${l.maxLeverage}x), maintenance rate ${pct(src.maintenanceRate)}, liquidation ${pct(l.liquidationDistance)} away (must be > 40 %)`);
  }
}

export function printResult(ctx: Pick<OpsCtx, 'say'>, what: string, r: PairResult): void {
  const say = (line: string) => ctx.say(line);
  say(`${what.padEnd(10)}${r.status}, size ${r.size}; fees ${usd(r.feeUsd)}${r.feeUnknown > 0 ? ` (+ ${r.feeUnknown} fill(s) with no fee reported)` : ''}`);
  for (const n of r.notes) say(`          ${n}`);
  for (const leg of r.legs) {
    say(`          ${leg.venue} ${leg.symbol}: ${leg.start} -> ${leg.target}, final ${leg.final ?? 'unknown'}`);
    for (const o of leg.orders) {
      say(`            ${o.purpose}${o.maker === true ? ' (maker part)' : ''} ${o.ref.side} ${o.ref.size}${o.ref.reduceOnly ? ' reduce-only' : ''}: ${o.outcome}`
        + `${o.filled === null ? '' : ` ${o.filled} at ${o.avgPx ?? '?'}, fee ${o.fee === null ? 'not reported' : usd(o.fee)}`} id ${o.ref.orderId ?? o.ref.clientId ?? '-'}`
        + `${o.error === null ? '' : ` (${o.error})`}${o.ref.tx.length === 0 ? '' : ` ${refs(o.ref.tx)}`}`);
    }
  }
}

/**
 * What stays open when the operation ends: a post-only order left unsettled (cancelled by its id once more first; then
 * both legs are read again, and the IOC leg, Phoenix or Orderly, goes back against Hyperliquid by one IOC when a late
 * fill left it off), an unhedged pair, or an order with no answer that may still run. Only Hyperliquid works post-only
 * orders: a pair without it has none to cancel or settle.
 */
export async function finish(ctx: OpsCtx, pair: Pair): Promise<void> {
  if (pair.run.stopOnFinish) pair.trader.stop();
  let unhedged = pair.trader.unhedged;
  if (pair.hl !== null && pair.hl.pendingMakerOrders().length > 0) {
    for (const line of await pair.hl.cancelPending('pair-mainnet: exit')) ctx.say(`cancel    ${line}`);
    const left = pair.hl.pendingMakerOrders();
    for (const p of left) {
      ctx.open(`hyperliquid post-only ${p.side} ${p.size} ${pair.symbol} (oid ${p.oid ?? 'unknown'}, cloid ${p.cloid}) may still rest and fill: cancel it on Hyperliquid and reconcile both legs`);
    }
    const iocI = iocIndexOf(pair);
    const ioc = pair.legs[iocI];
    unhedged = pair.targetNet === null
      ? `the target net is unknown: check hyperliquid and ${ioc.venue} ${pair.symbol} by hand`
      : await settleResidual({
        left: left.length, phoenixUnsettled: pair.trader.unsettled(ioc) !== null || pair.trader.unsettled(pair.trader.legs[iocI]) !== null, venue: ioc.venue,
        send: ctx.send, trading: ctx.trading, lot: ioc.lot, targetNet: pair.targetNet, symbol: pair.symbol, unhedged,
      }, {
        readLegs: () => readLegs(ctx, pair), say: (line) => ctx.say(line),
        hedge: (side, size, reduceOnly) => pair.run.hedge(side, size, reduceOnly, `pair-mainnet: hedge ${pair.symbol} after a late maker fill`),
        open: (line) => ctx.open(line),
      });
  }
  if (unhedged !== null) ctx.open(unhedged);
  for (const leg of pair.trader.legs) {
    const u = pair.trader.unsettled(leg);
    if (u === null) continue;
    const orders = u.refs.map((ref) => `${ref.side} ${ref.size}${ref.reduceOnly ? ' reduce-only' : ''} (${ref.clientId ?? ref.orderId ?? 'no id'})`).join(' and ');
    ctx.open(`${leg.venue} ${orders} has no answer and may still run until ${new Date(u.until).toISOString()}: check ${leg.venue} ${leg.symbol} by hand until then`);
  }
}

/** The maker leg's (`hl`) and the IOC leg's (`px`) positions now, or null (with the reason printed) when either cannot be read. */
async function readLegs(ctx: Pick<OpsCtx, 'say'>, pair: Pair): Promise<{ hl: bigint; px: bigint } | null> {
  try {
    const m = pair.makerIndex ?? 0;
    const [hl, px] = await Promise.all([pair.legs[m].position(), pair.legs[m === 0 ? 1 : 0].position()]);
    return { hl, px };
  } catch (err) {
    ctx.say(`positions cannot be read: ${errorMessage(err)}`);
    return null;
  }
}

export function refs(tx: TxRef[]): string {
  return tx.length === 0 ? '(none)' : tx.map((t) => t.url).join('  ');
}
