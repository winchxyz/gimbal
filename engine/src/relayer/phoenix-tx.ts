// The desk's Phoenix messages for `sol_sign`, beside the withdrawal in phoenix-withdraw.ts: the deposit (create the
// desk PhUSD account, Ember wrap USDC -> PhUSD, Phoenix deposit_funds, in one message as vectors/solana.json "deposit
// 15 USDC" pins it), an IOC order (place_market_order, variant 2) and cancel_all. Each starts with the compute budget:
// a unit limit and a price, which the contract caps at 600,000 units and 1,000,000 µlamports per unit with a fee of
// at most 600,000 lamports (phoenix.rs MAX_*). An order measured 532k units on mainnet (2026-11-03), so orders take
// the whole 600k limit; deposits and withdrawals fit the 400k default.
//
// The IOC packet is the SDK's market-order packet with a price limit: minBaseLotsToFill = numBaseLots (all or
// nothing), minQuoteLotsToFill 1, no self-trade or client id, and the one flag the contract accepts, reduce-only
// (0x80). The vectors decode to exactly these fields.
//
// The exchange's accounts are pinned (PHOENIX_MAINNET, the contract's vectors use the same) and checked against the
// live /v1/exchange/snapshot before anything is signed (exchangeMismatches): a changed account means stop, not adapt.

import {
  buildCancelAllIxResolved, buildDepositIxsResolved, buildPlaceMarketOrderIxResolved, getPhoenixSplineCollectionAddress,
} from '@ellipsis-labs/rise';
import type { BuildCancelAllIxResolvedInput, BuildDepositIxsResolvedInput, BuildPlaceMarketOrderIxResolvedInput } from '@ellipsis-labs/rise';
import type { DeskSolanaAccounts, PhoenixExchangeAccounts } from './phoenix-withdraw.ts';
import type { SolInstruction } from './solana-message.ts';
import { asSolInstructions, compileLegacyMessage } from './solana-message.ts';
import { computeBudgetInstructions } from './solana.ts';

/** Phoenix's and Ember's mainnet accounts (contract/core/tests/vectors/solana.json uses the same ones). */
export const PHOENIX_MAINNET: PhoenixExchangeAccounts = {
  phoenixProgram: 'EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih',
  logAuthority: 'GdxfTLSsdSY37G6fZoYtdGDSfgFnbT2EmRpuePZxWShS',
  globalConfiguration: '2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ',
  canonicalMint: 'PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  perpAssetMap: '2nHGAaEw3D5dd4hVueaUNoygkQFmoeKqRQWnSPqSMFUC',
  globalVault: 'csZXgw2G58hbiWc9ndxaxrQVYVvqdXgQzYLuznEzHJu',
  withdrawQueue: '3c3NTwpg7yW91FxijkHBXwVH1xUifun3Z8TC5eW5Si3K',
  globalTraderIndex: ['HCrPXLByGqRh2szQi3gj7oRdRVBNi1gccAyn4CQCT3HK'],
  activeTraderBuffer: ['2U32rSzzrQS3eVmGHsnbw5kcqKF3wQXpHGd3hMq5YJok'],
  emberState: '6ur7v6AXNpnHeEb6xuk7PyezvZ1i5GrgYyWZkNCpzbRz',
  emberVault: 'FKcEb4TdPDTRuMnQDpSEPQBcrm15S73xiUD6Qf8ZLUkq',
};

/** The unit limit and price an order message sets: the contract's caps on the limit, 60,000 lamports of fee. */
export const ORDER_COMPUTE_UNITS = 600_000;
export const ORDER_PRIORITY_MICROLAMPORTS = 100_000;
/** The highest unit price the engine sets: the contract's cap drops to 200,000 µlamports in C10. */
export const MAX_PRIORITY_MICROLAMPORTS = 200_000;
/** A simulated order over this many units is refused: measured 532k on mainnet, and the limit is 600k. */
export const ORDER_UNITS_REFUSE_ABOVE = 560_000;
/** Deposits and withdrawals: computeBudgetInstructions()'s defaults (400k units, 100,000 µlamports). */
export const MONEY_COMPUTE_UNITS = 400_000;

/** Phoenix's reduce-only order flag (OrderFlags.ReduceOnly), the only flag the contract lets through. */
export const REDUCE_ONLY_FLAG = 0x80;

/** A market's two accounts an order names: the orderbook (a policy market) and its spline collection PDA. */
export interface PhoenixMarketAccounts {
  symbol: string;
  orderbook: string;
  spline: string;
}

/** The spline collection PDA of an orderbook: ["spline", orderbook] under the Phoenix program. */
export async function splineOf(orderbook: string, program = PHOENIX_MAINNET.phoenixProgram): Promise<string> {
  return getPhoenixSplineCollectionAddress(orderbook as never, program as never) as unknown as string;
}

export interface IocOrder {
  side: 'BUY' | 'SELL';
  priceInTicks: bigint;
  numBaseLots: bigint;
  reduceOnly: boolean;
}

export interface ComputeBudget {
  units: number;
  microLamports: number;
}

const ORDER_BUDGET: ComputeBudget = { units: ORDER_COMPUTE_UNITS, microLamports: ORDER_PRIORITY_MICROLAMPORTS };
const MONEY_BUDGET: ComputeBudget = { units: MONEY_COMPUTE_UNITS, microLamports: ORDER_PRIORITY_MICROLAMPORTS };

/** The priority fee a budget pays at most, in lamports: ceil(units × price / 1e6), as the contract counts it. */
export function priorityFeeLamports(budget: ComputeBudget): number {
  return Math.ceil((budget.units * budget.microLamports) / 1_000_000);
}

/** The IOC packet in the SDK's shape (see the header for the fixed fields). */
export function iocPacket(order: IocOrder): BuildPlaceMarketOrderIxResolvedInput['orderPacket'] {
  const u64 = (v: bigint, what: string) => {
    if (v <= 0n || v >= 1n << 64n) throw new Error(`phoenix IOC: ${what} ${v} is not a u64 above 0`);
    return v;
  };
  return {
    side: order.side === 'BUY' ? 0 : 1,
    priceInTicks: u64(order.priceInTicks, 'priceInTicks'),
    numBaseLots: u64(order.numBaseLots, 'numBaseLots'),
    numQuoteLots: null,
    minBaseLotsToFill: order.numBaseLots,
    minQuoteLotsToFill: 1n,
    selfTradeBehavior: 0,
    matchLimit: null,
    clientOrderId: 0n,
    lastValidSlot: null,
    orderFlags: order.reduceOnly ? REDUCE_ONLY_FLAG : 0,
    cancelExisting: false,
  } as unknown as BuildPlaceMarketOrderIxResolvedInput['orderPacket'];
}

function placeContext(exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, market: PhoenixMarketAccounts): BuildCancelAllIxResolvedInput {
  // The SDK's address types are branded strings; these are plain base58 strings of the same addresses.
  return {
    exchange: {
      phoenixProgramAddress: exchange.phoenixProgram,
      logAuthorityAddress: exchange.logAuthority,
      globalConfigurationAddress: exchange.globalConfiguration,
      perpAssetMap: exchange.perpAssetMap,
      globalTraderIndex: exchange.globalTraderIndex,
      activeTraderBuffer: exchange.activeTraderBuffer,
    },
    market: { marketAddress: market.orderbook, splineCollection: market.spline },
    trader: { authority: desk.authority, traderAccount: desk.traderAccount },
  } as unknown as BuildCancelAllIxResolvedInput;
}

function budgetIxs(budget: ComputeBudget): SolInstruction[] {
  return asSolInstructions(computeBudgetInstructions(budget.units, budget.microLamports));
}

/** The compute budget and one IOC on `market`. */
export function orderInstructions(
  exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, market: PhoenixMarketAccounts, order: IocOrder, budget: ComputeBudget = ORDER_BUDGET,
): SolInstruction[] {
  const ix = buildPlaceMarketOrderIxResolved({ ...placeContext(exchange, desk, market), orderPacket: iocPacket(order) } as BuildPlaceMarketOrderIxResolvedInput);
  return [...budgetIxs(budget), ix as unknown as SolInstruction];
}

/** The compute budget and cancel_all on `market` (every resting order of the desk's trader there). */
export function cancelAllInstructions(
  exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, market: PhoenixMarketAccounts, budget: ComputeBudget = ORDER_BUDGET,
): SolInstruction[] {
  return [...budgetIxs(budget), buildCancelAllIxResolved(placeContext(exchange, desk, market)) as unknown as SolInstruction];
}

/**
 * A deposit of `amount` USDC base units: the idempotent create of the desk PhUSD account, the Ember wrap of `amount`
 * USDC into PhUSD (1:1), and deposit_funds of `amount` PhUSD into the desk's trader.
 */
export function depositInstructions(exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, amount: bigint, budget: ComputeBudget = MONEY_BUDGET): SolInstruction[] {
  if (amount <= 0n || amount >= 1n << 64n) throw new Error(`phoenix deposit: amount ${amount} is not a u64 above 0`);
  const input = {
    exchange: {
      phoenixProgramAddress: exchange.phoenixProgram,
      logAuthorityAddress: exchange.logAuthority,
      globalConfigurationAddress: exchange.globalConfiguration,
      canonicalMint: exchange.canonicalMint,
      usdcMint: exchange.usdcMint,
      globalVault: exchange.globalVault,
      globalTraderIndex: exchange.globalTraderIndex,
      activeTraderBuffer: exchange.activeTraderBuffer,
      emberState: exchange.emberState,
      emberVault: exchange.emberVault,
    },
    trader: { authority: desk.authority, traderAccount: desk.traderAccount, usdcTokenAccount: desk.usdcAta, phoenixTokenAccount: desk.phusdAta },
    amount,
  } as unknown as BuildDepositIxsResolvedInput;
  return [...budgetIxs(budget), ...(buildDepositIxsResolved(input).instructions as unknown as SolInstruction[])];
}

export function orderMessage(
  exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, market: PhoenixMarketAccounts, order: IocOrder, recentBlockhash: string, budget?: ComputeBudget,
): Uint8Array {
  return compileLegacyMessage(desk.authority, orderInstructions(exchange, desk, market, order, budget), recentBlockhash);
}

export function cancelAllMessage(
  exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, market: PhoenixMarketAccounts, recentBlockhash: string, budget?: ComputeBudget,
): Uint8Array {
  return compileLegacyMessage(desk.authority, cancelAllInstructions(exchange, desk, market, budget), recentBlockhash);
}

export function depositMessage(exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, amount: bigint, recentBlockhash: string, budget?: ComputeBudget): Uint8Array {
  return compileLegacyMessage(desk.authority, depositInstructions(exchange, desk, amount, budget), recentBlockhash);
}

/** The exchange part of /v1/exchange/snapshot, the fields compared with the pinned accounts. */
export interface ExchangeSnapshotAccounts {
  programId?: unknown;
  globalConfig?: unknown;
  canonicalMint?: unknown;
  usdcMint?: unknown;
  globalVault?: unknown;
  perpAssetMap?: unknown;
  globalTraderIndex?: unknown;
  activeTraderBuffer?: unknown;
  withdrawQueue?: unknown;
  active?: unknown;
  withdrawalsAvailable?: unknown;
}

/**
 * Where the live exchange differs from the pinned accounts, one line each; empty when they agree. The snapshot names
 * neither the log authority nor Ember's accounts: those are fixed by the program and the vectors.
 */
export function exchangeMismatches(live: ExchangeSnapshotAccounts, pinned: PhoenixExchangeAccounts = PHOENIX_MAINNET): string[] {
  const out: string[] = [];
  const same = (name: string, got: unknown, want: string | readonly string[]) => {
    const text = (v: unknown) => (Array.isArray(v) ? v.join(',') : String(v));
    if (text(got) !== text(want)) out.push(`${name}: the exchange says ${text(got)}, pinned ${text(want)}`);
  };
  same('programId', live.programId, pinned.phoenixProgram);
  same('globalConfig', live.globalConfig, pinned.globalConfiguration);
  same('canonicalMint', live.canonicalMint, pinned.canonicalMint);
  same('usdcMint', live.usdcMint, pinned.usdcMint);
  same('globalVault', live.globalVault, pinned.globalVault);
  same('perpAssetMap', live.perpAssetMap, pinned.perpAssetMap);
  same('globalTraderIndex', live.globalTraderIndex, pinned.globalTraderIndex);
  same('activeTraderBuffer', live.activeTraderBuffer, pinned.activeTraderBuffer);
  same('withdrawQueue', live.withdrawQueue, pinned.withdrawQueue);
  if (live.active !== true) out.push(`the exchange is not active (active ${String(live.active)})`);
  return out;
}

/** One market of /v1/exchange/snapshot, the fields an order's lots and ticks come from. */
export interface SnapshotMarket {
  symbol?: unknown;
  marketPubkey?: unknown;
  splinePubkey?: unknown;
  tickSize?: unknown;
  baseLotsDecimals?: unknown;
  marketStatus?: unknown;
}

/**
 * Where a policy market differs from the live exchange's: its orderbook and spline, and its lot and tick. Phoenix
 * prices in quote lots of 1e-6 USD per base lot of 10^-baseLotsDecimals units, so base_lot_e8 must be
 * 10^(8 - baseLotsDecimals) and tick_e8 (USD x 1e8 per base unit per tick) tickSize x 10^(baseLotsDecimals + 2):
 * ETH, 3 decimals and tickSize 100, is 0.001 ETH a lot and 0.1 USD a tick. Empty when they agree.
 */
export function marketMismatches(
  live: SnapshotMarket | undefined, policy: { symbol: string; orderbook: string; base_lot_e8: number; tick_e8: number }, spline?: string,
): string[] {
  const name = `phoenix ${policy.symbol}`;
  if (live === undefined) return [`${name}: the exchange lists no such market`];
  const out: string[] = [];
  if (live.marketPubkey !== policy.orderbook) out.push(`${name}: the exchange's orderbook is ${String(live.marketPubkey)}, the policy's ${policy.orderbook}`);
  if (spline !== undefined && live.splinePubkey !== undefined && live.splinePubkey !== spline) out.push(`${name}: the exchange's spline is ${String(live.splinePubkey)}, derived ${spline}`);
  const decimals = live.baseLotsDecimals;
  const tickSize = live.tickSize;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 8 || typeof tickSize !== 'number' || !Number.isInteger(tickSize) || tickSize < 1) {
    out.push(`${name}: the exchange's baseLotsDecimals ${String(decimals)} or tickSize ${String(tickSize)} cannot be read`);
    return out;
  }
  const lotE8 = 10 ** (8 - decimals);
  const tickE8 = tickSize * 10 ** (decimals + 2);
  if (policy.base_lot_e8 !== lotE8) out.push(`${name}: the policy's base_lot_e8 is ${policy.base_lot_e8}, the exchange's lot ${lotE8}`);
  if (policy.tick_e8 !== tickE8) out.push(`${name}: the policy's tick_e8 is ${policy.tick_e8}, the exchange's tick ${tickE8}`);
  if (live.marketStatus !== undefined && live.marketStatus !== 'active') out.push(`${name}: the market is ${String(live.marketStatus)}`);
  return out;
}
