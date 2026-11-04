// The carry pair's open and close as pair-mainnet runs them, as a library: `pair-mainnet open` / `close` (the CLI) and
// serve's strategy loop (serve-pair.ts, through the loop's enter, exit and rotate) call the same code. What it checks
// before an open (the refusals) and how it sends (maker first, the stored price refreshed before each part, the C10
// meter's post-only cap, finish()'s cancel and residual hedge) are pair-mainnet.ts's header; nothing here changed when
// it moved out of the CLI.
//
// The context says where output goes (`say`, and `open` for what the owner must reconcile) and how orders go out
// (Pair.run): the CLI sends through its own PairTrader and stops it when it exits; serve sends through its
// ProtectedPair, whose guarded legs save every order in flight before it is signed, and keeps the trader running.

import type { ContractPolicy, TxRef } from '@gimbal/shared';
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
import { carryPlan, halfSpreadBps, meanRatePerHour, pct, usd } from '../trade/carry-plan.ts';
import type { LegOutcome, LegSide, MakerSettings } from '../trade/legs.ts';
import { HlLeg } from '../trade/legs.ts';
import { commonLot, floorToLot, qtyNumber, qtyString, signedQtyString, toQty } from '../trade/lots.ts';
import type { CloseRequest, PairResult } from '../trade/pair.ts';
import { PairTrader } from '../trade/pair.ts';
import { PhoenixLeg, parseTraderSnapshot, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import type { HyperliquidReader } from '../venues/hyperliquid.ts';
import type { PhoenixReader } from '../venues/phoenix.ts';
import { phoenixGet } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { PriceDeps, StoredPrice } from './pair-mainnet-lib.ts';
import { OPEN_HEADROOM_S, PRICE_MARGIN_S, UsageError, ensureFresh, hlCross, oraclePxOf, phoenixCross, priceFitRefusal, priceLifeS, restingOrdersRefusal, settleResidual } from './pair-mainnet-lib.ts';

/** Phoenix orders one pair part may take: the open, its retry, and two unwind orders. */
export const ORDERS_PER_PART = 4;
export const HL_TAKER_BPS = 5.5;

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
  /** finish()'s residual Phoenix IOC (PhoenixLeg.order); never throws. */
  hedge(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome>;
  /** finish() stops the trader first (a CLI about to exit); serve's trader keeps running. */
  stopOnFinish: boolean;
}

export interface Pair {
  symbol: string;
  hl: HlLeg;
  phoenix: PhoenixLeg;
  trader: PairTrader;
  run: PairRunner;
  lot: bigint;
  bandBps: number;
  priced: boolean;
  /** The policy market against the live exchange: refused at --send when not empty. */
  mismatches: string[];
  marketConfig: PhoenixMarketConfig;
  maker: MakerSettings;
  microLamports: number;
  /**
   * The sum of the operation's targets, what finish() brings the pair back to (PairTrader.net after it): hl + px as an
   * open found them, 0 for a close (both legs to flat).
   */
  targetNet: bigint | null;
}

/** The CLI's runner: its own trader, and the raw Phoenix leg for the residual hedge. */
export function traderRunner(trader: PairTrader, phoenix: PhoenixLeg): PairRunner {
  return {
    openInChunks: (request) => trader.openInChunks(request),
    close: (request) => trader.close(request),
    hedge: (side, size, reduceOnly, reason) => phoenix.order(side, size, reduceOnly, reason),
    stopOnFinish: true,
  };
}

/** The legs, a trader on them, and the Phoenix market checked against the live exchange (pair-mainnet's buildPair). */
/** `orders` is read after the symbol is checked against the policy, as pair-mainnet always did. */
export async function buildPair(ctx: OpsCtx, symbol: string, orders: () => OrderOptions, closing = false): Promise<Pair> {
  const p: ContractPolicy = ctx.desk.policy;
  const asset = p.hl_assets.find((a) => a.symbol === symbol);
  const market = p.phoenix_markets.find((m) => m.symbol === symbol);
  if (asset === undefined || market === undefined) {
    throw new Error(`${symbol} must be in both policy.hl_assets (${p.hl_assets.map((a) => a.symbol).join(', ')}) and policy.phoenix_markets (${p.phoenix_markets.map((m) => m.symbol).join(', ')})`);
  }
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
  const hl = new HlLeg({
    relayer, info: (body) => hlInfo(ctx, body), user: evm, coin: symbol, asset: asset.index, szDecimals: asset.sz_decimals, oraclePx,
    bandBps: p.price_band_bps, maxNotionalUsd, ...(unpriced === undefined ? {} : { maxSz: unpriced.max_sz }),
    bestPx: async (side: LegSide) => {
      const book = await ctx.hl.book(symbol, 5);
      const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
      if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on Hyperliquid ${symbol}`);
      return px;
    },
    slippageBps, maker,
  });
  const spline = await splineOf(market.orderbook);
  const phoenix = new PhoenixLeg({
    relayer, chain: ctx.chain, landedSlot: (sig) => ctx.solana.landedSlot(sig), waitPastLastValidHeight: (h) => ctx.solana.waitPastLastValidHeightSlot(h),
    api: phoenixTraderApi(ctx.phoenixUrl), desk: ctx.sol,
    market: { symbol, orderbook: market.orderbook, spline, baseLotE8: market.base_lot_e8, tickE8: market.tick_e8 },
    oraclePx, bandBps: p.price_band_bps, maxNotionalUsd, ...(unpriced === undefined ? {} : { maxSz: unpriced.max_sz }),
    bestPx: async (side) => {
      const book = await ctx.phoenix.book(symbol, 5);
      const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
      if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on Phoenix ${symbol}`);
      return px;
    },
    slippageBps, microLamports,
  });
  const trader = new PairTrader({
    legs: [hl, phoenix], priceBandBps: p.price_band_bps, log: (line) => ctx.say(`trade     ${line}`),
    openBlocked: () => (ctx.desk.closing === true ? 'the desk is closing (panic_close)' : null),
    onWatch: (w) => {
      if (w.status === 'unhedged') ctx.open(`watch: ${w.notes.join('; ')}`, false);
    },
  });
  return pairOf(ctx, { symbol, hl, phoenix, trader, run: traderRunner(trader, phoenix), maker, microLamports, priced: unpriced === undefined, closing });
}

/**
 * A Pair of legs and a trader made elsewhere (serve's, behind its ProtectedPair), with the Phoenix exchange and the
 * policy market checked as buildPair checks them.
 */
export async function pairOf(ctx: Pick<OpsCtx, 'desk' | 'phoenixUrl'>, p: {
  symbol: string; hl: HlLeg; phoenix: PhoenixLeg; trader: PairTrader; run: PairRunner; maker: MakerSettings; microLamports: number; priced: boolean; closing: boolean;
}): Promise<Pair> {
  const market = ctx.desk.policy.phoenix_markets.find((m) => m.symbol === p.symbol);
  if (market === undefined) throw new Error(`${p.symbol} is not in policy.phoenix_markets`);
  const spline = await splineOf(market.orderbook);
  const { mismatches, markets } = await phoenixExchange(ctx);
  const marketConfig = markets.find((m) => m.symbol === p.symbol);
  if (marketConfig === undefined) throw new Error(`Phoenix has no ${p.symbol} market`);
  // A close is reduce-only: a market in maintenance or suspended still takes it; the orderbook, lot and tick must match.
  const diffs = [...mismatches.map((m) => `the Phoenix exchange differs from the pinned accounts: ${m}`), ...marketMismatches(marketConfig, market, spline, { ignoreStatus: p.closing })];
  return {
    symbol: p.symbol, hl: p.hl, phoenix: p.phoenix, trader: p.trader, run: p.run, lot: commonLot(p.hl.lot, p.phoenix.lot), bandBps: ctx.desk.policy.price_band_bps,
    priced: p.priced, mismatches: diffs, marketConfig, maker: p.maker, microLamports: p.microLamports, targetNet: null,
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

/** The Phoenix IOC of one part, built and simulated unsigned: refusals when it fails or uses too many units. */
async function simulateIoc(ctx: OpsCtx, pair: Pair, size: bigint): Promise<{ lines: string[]; refusals: string[] }> {
  try {
    const plan = await pair.phoenix.plan('BUY', size, false);
    const { message } = await pair.phoenix.message(plan);
    const sim = await ctx.chain.simulate(message);
    const lines = [`ioc sim   Phoenix BUY ${qtyString(size)} ${pair.symbol} at ${plan.px.toFixed(4)} (${plan.ticks} ticks, ${plan.lots} lots): ${sim.err === null ? 'ok' : `error ${JSON.stringify(sim.err)}`}, ${sim.unitsConsumed ?? '?'} CU of ${ORDER_COMPUTE_UNITS}`];
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
 */
export async function planOpen(ctx: OpsCtx, pair: Pair, request: OpenRequest): Promise<OpenPlan> {
  const { symbol, legUsd, leverage, holdDays, basisBps } = request;
  const policy = ctx.desk.policy;
  const refusals: string[] = [...pair.mismatches];
  const since = Date.now() - 7 * 86_400_000;
  const evm = ctx.desk.evm_address.toLowerCase();

  const [hlF, pxF, hlBook, pxBook, hlState, state, spRead, lamports, assetData, hlOpen] = await Promise.all([
    hlFunding(ctx, symbol, since), phoenixFunding(ctx, symbol, since), ctx.hl.book(symbol, 5), ctx.phoenix.book(symbol, 5),
    hlInfo<unknown>(ctx, { type: 'clearinghouseState', user: evm }), traderState(ctx), storedPrice(ctx.client, symbol), ctx.chain.balance(ctx.sol.authority),
    hlInfo<{ leverage?: { type?: string; value?: number } }>(ctx, { type: 'activeAssetData', user: evm, coin: symbol }).catch(() => null),
    hlInfo<unknown>(ctx, { type: 'openOrders', user: evm }).catch((err: unknown) => errorMessage(err)),
  ]);
  const registered = state !== null && state !== 'uninitialized';
  const pxAccount = registered ? await ctx.phoenix.account(ctx.sol.authority) : null;
  if (!registered) refusals.push(`the desk's Phoenix trader is not registered (${state ?? 'unknown'}): run the Phoenix registration (sol_sign_register), then fund-phoenix`);
  if (ctx.desk.paused) refusals.push('the desk is paused: no open is signed');
  // The trader refuses an open on a closing desk too (buildPair's openBlocked); here it is judged with the rest.
  if (ctx.desk.closing === true) refusals.push('the desk is closing (panic_close)');
  // The cap is valued at max(limit, oracle), and the limit may be up to the band from the stored price.
  const legCap = policy.max_notional_usd * (1 - policy.price_band_bps / 10_000);
  if (legUsd > legCap + 1e-9) refusals.push(`legUsd ${usd(legUsd)} is over ${usd(legCap)}, the policy's ${policy.max_notional_usd} USD cap less the ${policy.price_band_bps} bps band`);
  const marginMode = assetData?.leverage?.type ?? null;
  if (marginMode !== 'cross') refusals.push(`Hyperliquid ${symbol} is in ${marginMode ?? 'an unreadable'} margin mode: only cross is planned (its liquidation is the account's); set it to cross on Hyperliquid`);
  const resting = restingOrdersRefusal(hlOpen, symbol);
  if (resting !== null) refusals.push(resting);

  const hlBid = hlBook.bids[0]?.px ?? 0;
  const hlAsk = hlBook.asks[0]?.px ?? 0;
  const pxBid = pxBook.bids[0]?.px ?? 0;
  const pxAsk = pxBook.asks[0]?.px ?? 0;
  const mid = (hlBid + hlAsk + pxBid + pxAsk) / 4;
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
  const builderBps = (ctx.config.fees?.hl_builder_tenth_bps ?? 0) / 10;
  // Cross margin on both venues, open notional at the mark: what liquidation and the effective leverage run on.
  const hlC = hlCross(hlState);
  const pxC = pxAccount === null ? { equityUsd: 0, maintenanceUsd: 0, notionalUsd: 0 } : phoenixCross(pxAccount);
  const pxLotsAfter = (toQty(String(Math.abs(pxAccount?.positions.find((p) => p.symbol === symbol)?.size ?? 0))) + size) / pair.phoenix.lot;
  const short: CarryLegInput = {
    venue: 'hyperliquid', ratePerHour: hlF.now, rate7dPerHour: hlF.mean7d ?? hlF.now, takerBps: HL_TAKER_BPS + builderBps, halfSpreadBps: halfSpreadBps(hlBid, hlAsk),
    equityUsd: hlC.equityUsd, maintenanceUsd: hlC.maintenanceUsd, notionalUsd: hlC.notionalUsd, maintenanceRate: 1 / (2 * hlF.maxLeverage),
  };
  const long: CarryLegInput = {
    venue: 'phoenix', ratePerHour: pxF.now ?? 0, rate7dPerHour: pxF.mean7d ?? pxF.now ?? 0, takerBps: pair.marketConfig.takerFee * 10_000, halfSpreadBps: halfSpreadBps(pxBid, pxAsk),
    equityUsd: pxC.equityUsd, maintenanceUsd: pxC.maintenanceUsd, notionalUsd: pxC.notionalUsd,
    maintenanceRate: phoenixMaintenanceRate(pair.marketConfig, pxLotsAfter),
  };
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
    if (first !== null && qtyNumber(first) * hlAsk < 10) refusals.push(`a pair part of ${qtyString(first)} ${symbol} is under Hyperliquid's 10 USD order minimum`);
    if (first !== null) sim = await simulateIoc(ctx, pair, first);
  } finally {
    if (estimated) ctx.prices.estimate?.delete(symbol);
  }
  const orderTx = txCostLamports({ units: ORDER_COMPUTE_UNITS, microLamports: pair.microLamports });
  const solNeed = Math.max(1, parts) * ORDERS_PER_PART * orderTx + SYSTEM_ACCOUNT_RENT_LAMPORTS;
  if (lamports < solNeed) refusals.push(`the desk authority holds ${solText(lamports)}; ${Math.max(1, parts)} pair part(s) need up to ${solText(solNeed)} for Phoenix fees and the rent-exempt reserve: send ${solText(solNeed - lamports)} to ${ctx.sol.authority}`);
  refusals.push(...sim.refusals);

  printCarry(ctx, symbol, legUsd, leverage, holdDays, plan, short, long, { hlBid, hlAsk, pxBid, pxAsk });
  ctx.say(`size      ${qtyString(size)} ${symbol} per leg (${usd(qtyNumber(size) * mid)} at ${mid.toFixed(4)}); common lot ${qtyString(pair.lot)}`);
  ctx.say(`          ${parts} pair part(s) of at most ${chunk === null ? '?' : qtyString(chunk)} (policy max_notional_usd ${policy.max_notional_usd} less the ${pair.bandBps} bps band)`);
  ctx.say(`leverage  Hyperliquid ${symbol}: ${assetData?.leverage === undefined ? 'unknown' : `${assetData.leverage.type} ${assetData.leverage.value}x`} on the account (the contract cannot set it); effective leverage is what is checked`);
  ctx.say(`price     stored ${symbol} ${sp === null ? 'none' : `${sp.px}, ${Math.round(sp.ageS)} s old`}${estimated ? ` (planned on the books' mid ${mid.toFixed(4)}${sp === null ? '' : ', the stored one is over the band from the books'})` : ''}${refresh === null ? '' : `; ${ctx.send ? 'the open refreshes it once every check above passed' : '--send refreshes it once its checks pass'}`}; --send refreshes it before each part when it would not live ${marginS} s more (a fresh one lives ${priceLifeS(policy.oracle_max_age_s)} s of the ${policy.oracle_max_age_s})`);
  ctx.say(`solana    authority ${solText(lamports)}; up to ${solText(solNeed)} needed (unit price ${pair.microLamports} µlamports)`);
  for (const l of sim.lines) ctx.say(l);
  ctx.say(`order     maker first: Hyperliquid SELL post-only at the ask, repriced every ${pair.maker.repriceMs / 1000} s, at most ${pair.maker.maxOrders} signed post-only orders for the whole open (the C10 meter counts each), for ${pair.maker.timeoutMs / 1000} s${pair.maker.takerFallback ? ', then an IOC for the rest' : ', no taker fallback (--taker-fallback to add one)'}; then Phoenix BUY IOC for what filled`);
  return { request, refusals, size, carry: plan, refresh, pricedAt };
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
  ctx: OpsCtx, pair: Pair, plan: OpenPlan, reason = `pair-mainnet: carry ${plan.request.symbol}, short hyperliquid, long phoenix`,
  options: { gate?: () => string | null; onRefresh?: () => void } = {},
): Promise<PairResult[]> {
  if (plan.refusals.length > 0) throw new Error(`open refused, nothing signed: ${plan.refusals.join('; ')}`);
  const { symbol } = plan.request;
  // The open's targets keep hl + px as they are. A fresh process reads Phoenix from slot 0, so a snapshot that lags
  // an earlier run's last IOC would set this wrong (README, the residual hedge).
  const [hlStart, pxStart] = await Promise.all([pair.hl.position(), pair.phoenix.position()]);
  pair.targetNet = hlStart + pxStart;
  ctx.trading = true;
  await approveBuilderFee(ctx);
  try {
    const results = await pair.run.openInChunks({
      size: plan.size, longIndex: 1, reason, maker: { index: 0 },
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
 * itself would) and both books. The highest price an order of the open may carry: the Phoenix buy's IOC limit
 * (the ask plus `slippageBps`, at most the band over the stored price), the Hyperliquid sell's maker price (at most
 * the ask) and the stored price itself.
 */
export async function recheckOpenSize(
  ctx: OpsCtx, pair: Pair, size: bigint, slippageBps: number, onRefresh?: () => void,
): Promise<{ qty: bigint; cut: boolean; line: string } | { refused: string }> {
  const policy = ctx.desk.policy;
  const symbol = pair.symbol;
  const sp = pair.priced ? await ensureFresh(onRefresh === undefined ? ctx.prices : counting(ctx.prices, onRefresh), symbol, pair.maker.timeoutMs / 1000 + PRICE_MARGIN_S) : null;
  const [hlBook, pxBook] = await Promise.all([ctx.hl.book(symbol, 5), ctx.phoenix.book(symbol, 5)]);
  const hlAsk = hlBook.asks[0]?.px ?? 0;
  const pxAsk = pxBook.asks[0]?.px ?? 0;
  const mid = (hlAsk + (hlBook.bids[0]?.px ?? 0) + pxAsk + (pxBook.bids[0]?.px ?? 0)) / 4;
  if (!(hlAsk > 0 && pxAsk > 0 && mid > 0)) return { refused: `no ${symbol} book to hold the size to the cap; nothing sent` };
  let buyLimit = pxAsk * (1 + slippageBps / 10_000);
  if (sp !== null) buyLimit = Math.min(buyLimit, sp.px * (1 + policy.price_band_bps / 10_000));
  const worstPx = Math.max(buyLimit, hlAsk, sp?.px ?? 0);
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
export async function planClose(ctx: OpsCtx, pair: Pair): Promise<{ refusals: string[]; hl: bigint; px: bigint }> {
  const { symbol } = pair;
  const [hlPos, pxPos, sp, lamports] = await Promise.all([pair.hl.position(), pair.phoenix.position(), storedPrice(ctx.client, symbol), ctx.chain.balance(ctx.sol.authority)]);
  ctx.say(`positions hyperliquid ${symbol} ${signedQtyString(hlPos)}, phoenix ${symbol} ${signedQtyString(pxPos)}${hlPos + pxPos === 0n ? ' (hedged)' : ' (NOT offsetting)'}`);
  ctx.say(`order     both reduce-only: Hyperliquid post-only at the touch (every ${pair.maker.repriceMs / 1000} s, at most ${pair.maker.maxOrders} for the close, ${pair.maker.timeoutMs / 1000} s${pair.maker.takerFallback ? ', then IOC' : ''}), then Phoenix IOC for what it closed; the rest by IOC`);
  ctx.say(`price     stored ${symbol} ${sp === null ? 'none' : `${sp.px}, ${Math.round(sp.ageS)} s old`}; --send refreshes it when an order finds it stale`);
  const refusals: string[] = [...pair.mismatches];
  if (hlPos === 0n && pxPos === 0n) refusals.push('nothing to close: both legs are flat');
  const solNeed = 2 * txCostLamports({ units: ORDER_COMPUTE_UNITS, microLamports: pair.microLamports }) + SYSTEM_ACCOUNT_RENT_LAMPORTS;
  if (pxPos !== 0n && lamports < solNeed) refusals.push(`the desk authority holds ${solText(lamports)}; closing on Phoenix needs ${solText(solNeed)}: send ${solText(solNeed - lamports)}`);
  return { refusals, hl: hlPos, px: pxPos };
}

/**
 * Sends a close whose refusals are empty: both legs to flat, maker first, then finish(). `options` adds to the close's
 * request (serve: reduceOnly and clampTargets, so nothing it sends can open or grow a leg).
 */
export async function sendClose(ctx: OpsCtx, pair: Pair, options: { reason?: string; reduceOnly?: boolean; clampTargets?: boolean } = {}): Promise<PairResult> {
  const { symbol } = pair;
  // The close targets flat on both legs ([0, 0], trader.net after it), whatever hl + px were: the residual hedge
  // brings Phoenix back against Hyperliquid's flat, not to an older imbalance.
  pair.targetNet = 0n;
  ctx.trading = true;
  await approveBuilderFee(ctx);
  try {
    if (pair.priced) await ensureFresh(ctx.prices, symbol, pair.maker.timeoutMs / 1000 + PRICE_MARGIN_S);
    const { reason, ...rest } = options;
    const result = await pair.run.close({ reason: reason ?? `pair-mainnet: close ${symbol}`, maker: { index: 0 }, ...rest });
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
  ctx: OpsCtx, symbol: string, legUsd: number, leverage: number, holdDays: number, plan: CarryPlan, short: CarryLegInput, long: CarryLegInput,
  book: { hlBid: number; hlAsk: number; pxBid: number; pxAsk: number },
): void {
  const say = (line: string) => ctx.say(line);
  const rate = (r: number) => `${(r * 100).toFixed(5)} %/h (${pct(r * 8760)} APR)`;
  say(`window    ${symbol}, ${usd(legUsd)} a leg, hold ${holdDays} d, ${leverage}x asked`);
  say(`          hyperliquid (short) funding now ${rate(short.ratePerHour)}, 7-day mean ${rate(short.rate7dPerHour)}; book ${book.hlBid} / ${book.hlAsk}`);
  say(`          phoenix (long)      funding now ${rate(long.ratePerHour)}, 7-day mean ${rate(long.rate7dPerHour)}; book ${book.pxBid} / ${book.pxAsk}`);
  say(`          gross APR now ${pct(plan.grossAprNow)}, 7-day ${pct(plan.grossApr7d)} (short receives, long pays)`);
  say(`spread    expected over ${holdDays} d at the 7-day mean: ${usd(plan.expectedSpreadUsd)}`);
  say(`          round trip ${plan.roundTripBps.toFixed(2)} bps = ${usd(plan.roundTripUsd)}: taker ${short.takerBps} + ${long.takerBps} bps each way, half spreads ${short.halfSpreadBps.toFixed(2)} + ${long.halfSpreadBps.toFixed(2)} bps each way, basis buffer`);
  say(`          ${plan.expectedSpreadUsd > plan.roundTripUsd ? 'covers the round trip' : 'does NOT cover the round trip'}`);
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
 * both legs are read again, and Phoenix goes back against Hyperliquid by one IOC when a late fill left it off), an
 * unhedged pair, or an order with no answer that may still run.
 */
export async function finish(ctx: OpsCtx, pair: Pair): Promise<void> {
  if (pair.run.stopOnFinish) pair.trader.stop();
  let unhedged = pair.trader.unhedged;
  if (pair.hl.pendingMakerOrders().length > 0) {
    for (const line of await pair.hl.cancelPending('pair-mainnet: exit')) ctx.say(`cancel    ${line}`);
    const left = pair.hl.pendingMakerOrders();
    for (const p of left) {
      ctx.open(`hyperliquid post-only ${p.side} ${p.size} ${pair.symbol} (oid ${p.oid ?? 'unknown'}, cloid ${p.cloid}) may still rest and fill: cancel it on Hyperliquid and reconcile both legs`);
    }
    unhedged = pair.targetNet === null
      ? `the target net is unknown: check hyperliquid and phoenix ${pair.symbol} by hand`
      : await settleResidual({
        left: left.length, phoenixUnsettled: pair.trader.unsettled(pair.phoenix) !== null || pair.trader.unsettled(pair.trader.legs[1]) !== null,
        send: ctx.send, trading: ctx.trading, lot: pair.phoenix.lot, targetNet: pair.targetNet, symbol: pair.symbol, unhedged,
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

/** Both legs' positions now, or null (with the reason printed) when either cannot be read. */
async function readLegs(ctx: Pick<OpsCtx, 'say'>, pair: Pair): Promise<{ hl: bigint; px: bigint } | null> {
  try {
    const [hl, px] = await Promise.all([pair.hl.position(), pair.phoenix.position()]);
    return { hl, px };
  } catch (err) {
    ctx.say(`positions cannot be read: ${errorMessage(err)}`);
    return null;
  }
}

export function refs(tx: TxRef[]): string {
  return tx.length === 0 ? '(none)' : tx.map((t) => t.url).join('  ');
}
