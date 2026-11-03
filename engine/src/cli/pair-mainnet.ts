// The carry pair on mainnet: short Hyperliquid, long Phoenix, every order signed by the contract (hl_order and
// sol_sign), and the Phoenix money moves that go with it. A dry run by default: it reads everything, builds and
// simulates what it would sign, prints the plan, and signs nothing. --send acts; it refuses in a linked git worktree.
//
//   node --env-file=<engine env file> engine/src/cli/pair-mainnet.ts <command> [--send]
//     status
//     fund-phoenix <usdc>                   desk USDC account -> Ember wrap -> Phoenix deposit (one sol_sign)
//     defund-phoenix <usdc|all>             Phoenix withdraw -> Ember unwrap -> desk USDC account (one sol_sign)
//     open <symbol> <legUsd> --short hyperliquid --long phoenix [--leverage 2] [--hold-days 7] [--basis-bps 10]
//          [--slippage-bps 50] [--reprice-s 30] [--maker-timeout-s 180] [--max-orders 6] [--taker-fallback]
//          [--priority-microlamports 100000]
//     close <symbol> [the same order options]
//
// The env file holds the engine's names (GIMBAL_CONTRACT_ID, DESK_ID, OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY,
// NEAR_RPC_URL, HL_API_URL, PHOENIX_API_URL, SOLANA_RPC_URL); values are never printed, and the key is read only
// with --send.
//
// Open goes maker first: the Hyperliquid short as post-only limits at the touch, repriced at most every --reprice-s
// (30 s or more) and at most --max-orders times (6 or fewer: from C10 the contract meters signed notional that is not
// reduce-only per rolling hour, and every reprice is signed again), for at most --maker-timeout-s; an IOC for the rest
// only with --taker-fallback. Then the Phoenix long as one IOC for what filled. Close mirrors it, reduce-only (what
// the maker leg leaves goes to the close's IOC retry). The stored price is refreshed before each part when it would
// not outlive the maker timeout plus 240 s, and whenever an order (an unwind, a close) finds it stale.
//
// Before an open the plan prints both legs' funding now and over 7 days, the gross APR, the spread expected over the
// hold against the round trip (taker fees, half spreads, basis buffer), the size, the leverage and liquidation
// distance per leg, and simulates the Phoenix IOC unsigned. It refuses when the spread does not cover the round trip,
// a leg is 40 % or less from liquidation, a leg's effective leverage ((open notional + legUsd) / equity) is over the
// asked leverage (at most 2x) or its venue's cap (1.5x without a live rescue, carry-plan.ts LIVE_RESCUE), the
// Hyperliquid coin is in isolated margin, legUsd is over the policy cap less the band, or the simulation fails.
//
// Hyperliquid leverage: the contract has no update-leverage action (its Hyperliquid actions are hl_order, hl_cancel,
// hl_set_referrer, hl_approve_builder_fee, hl_usd_class_transfer, hl_withdraw, hl_send_to_intents), so the desk
// trades at the leverage its Hyperliquid account already has for the coin; what is checked is the effective leverage.
//
// An outcome that cannot be proven ends with `open:` lines naming what to reconcile and by which ids; exit code 3.
// A post-only order left without a settled state is cancelled by its id once more before the process ends.

import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ContractPolicy, TxRef } from '@gimbal/shared';
import { formatNear } from '../contract/budget.ts';
import type { ContractConfigView, NearTransport } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport, NearViewTransport } from '../contract/near-transport.ts';
import type { DeskView } from '../contract/types.ts';
import { ContractRefusal, OutcomeUnknown } from '../contract/types.ts';
import { HyperliquidSubmitter } from '../relayer/hyperliquid.ts';
import type { MoneyContext, MoneyPlan, SolanaChain } from '../relayer/phoenix-money.ts';
import {
  MONEY_TX_LAMPORTS, SYSTEM_ACCOUNT_RENT_LAMPORTS, TOKEN_ACCOUNT_RENT_LAMPORTS, parseUsdc, planDeposit, planWithdraw, sendPlan, solanaChain, solText,
  txCostLamports, usdcText,
} from '../relayer/phoenix-money.ts';
import type { SnapshotMarket } from '../relayer/phoenix-tx.ts';
import {
  MAX_PRIORITY_MICROLAMPORTS, ORDER_COMPUTE_UNITS, ORDER_PRIORITY_MICROLAMPORTS, ORDER_UNITS_REFUSE_ABOVE, exchangeMismatches, marketMismatches,
  splineOf,
} from '../relayer/phoenix-tx.ts';
import type { DeskSolanaAccounts } from '../relayer/phoenix-withdraw.ts';
import { Relayer } from '../relayer/relayer.ts';
import { SolanaSubmitter, parseMessage } from '../relayer/solana.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import type { CarryLegInput, CarryPlan } from '../trade/carry-plan.ts';
import { MAX_LEVERAGE, carryPlan, halfSpreadBps, meanRatePerHour, pct, usd, venueMaxLeverage } from '../trade/carry-plan.ts';
import type { LegSide, MakerSettings } from '../trade/legs.ts';
import { HlLeg } from '../trade/legs.ts';
import { commonLot, floorToLot, qtyNumber, qtyString, signedQtyString, toQty } from '../trade/lots.ts';
import type { PairResult } from '../trade/pair.ts';
import { PairTrader } from '../trade/pair.ts';
import { PhoenixLeg, parseTraderSnapshot, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import { HL_MAINNET_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import { PHOENIX_API_URL, PhoenixReader, SOLANA_MAINNET_RPC_URL } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Position } from '../venues/venue.ts';
import { checkContractNetwork, contractEnv } from './serve-contract.ts';

const USAGE = `usage: node --env-file=<engine env> engine/src/cli/pair-mainnet.ts <command> [--send]
  status
  fund-phoenix <usdc>
  defund-phoenix <usdc|all>
  open <symbol> <legUsd> --short hyperliquid --long phoenix [--leverage 2] [--hold-days 7] [--basis-bps 10] [--slippage-bps 50]
       [--reprice-s 30] [--maker-timeout-s 180] [--max-orders 6] [--taker-fallback] [--priority-microlamports 100000]
  close <symbol> [--slippage-bps 50] [--reprice-s 30] [--maker-timeout-s 180] [--max-orders 6] [--taker-fallback] [--priority-microlamports 100000]`;

const FLAGS: Record<string, 'value' | 'switch'> = {
  '--send': 'switch', '--short': 'value', '--long': 'value', '--leverage': 'value', '--hold-days': 'value', '--basis-bps': 'value',
  '--slippage-bps': 'value', '--reprice-s': 'value', '--maker-timeout-s': 'value', '--max-orders': 'value', '--taker-fallback': 'switch',
  '--priority-microlamports': 'value',
};
/** Phoenix orders one pair part may take: the open, its retry, and two unwind orders. */
const ORDERS_PER_PART = 4;
const HL_TAKER_BPS = 5.5;
/** The reprice floor and the post-only order cap of one maker order (the C10 meter counts every signed reprice). */
const MIN_REPRICE_S = 30;
const MAX_MAKER_ORDERS = 6;
/** How long the stored price must still live after the maker timeout when a part starts: the IOC and an unwind. */
const PRICE_MARGIN_S = 240;
/** An order finding the stored price this close to oracle_max_age_s refreshes it first. */
const PRICE_STALE_MARGIN_S = 30;

class UsageError extends Error {}

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
  send: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const kind = FLAGS[a];
    if (kind === undefined) throw new UsageError(`unknown option ${a}`);
    if (a in flags) throw new UsageError(`${a} is given twice`);
    if (kind === 'switch') flags[a] = true;
    else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      flags[a] = v;
      i++;
    }
  }
  const command = positional.shift();
  if (command === undefined) throw new UsageError('no command');
  return { command, positional, flags, send: flags['--send'] === true };
}

function num(args: Args, flag: string, fallback: number): number {
  const v = args.flags[flag];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (typeof v !== 'string' || !Number.isFinite(n) || n < 0) throw new UsageError(`${flag} must be a number of 0 or more`);
  return n;
}

const say = (line = '') => console.log(line);
const envVar = (name: string): string | undefined => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};
const openLines: string[] = [];

/** The repo root's .git is a file in a linked worktree: --send refuses there, as the mainnet tools do. */
function linkedWorktree(): boolean {
  const git = fileURLToPath(new URL('../../../.git', import.meta.url));
  return existsSync(git) && statSync(git).isFile();
}

interface Ctx {
  args: Args;
  client: NearContractClient;
  config: ContractConfigView;
  desk: DeskView;
  deskId: string;
  hlUrl: string;
  hl: HyperliquidReader;
  phoenix: PhoenixReader;
  phoenixUrl: string;
  chain: SolanaChain;
  solana: SolanaSubmitter;
  sol: DeskSolanaAccounts;
  relayer: Relayer | null;          // --send only
  /** A refresh_prices in flight: the legs' price reads wait on it rather than send a second one. */
  refreshing: Promise<void> | null;
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`pair-mainnet: ${err.message}\n${USAGE}`);
    process.exitCode = 2;
  } else if (err instanceof OutcomeUnknown) {
    openLines.push(`open:     ${err.message}${err.tx.length > 0 ? `; ${refs(err.tx)}` : ''}`);
    process.exitCode = 3;
  } else if (err instanceof ContractRefusal) {
    console.error(`refused by the contract, nothing signed: ${err.message}`);
    process.exitCode = 1;
  } else if (err instanceof NothingExecuted) {
    console.error(`${err.message}${err.tx.length > 0 ? ` (${refs(err.tx)})` : ''}`);
    process.exitCode = 1;
  } else {
    console.error(`pair-mainnet: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
}
for (const line of openLines) console.log(line);
setTimeout(() => process.exit(), 300).unref();

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!['status', 'fund-phoenix', 'defund-phoenix', 'open', 'close'].includes(args.command)) throw new UsageError(`unknown command ${args.command}`);
  const tree = linkedWorktree();
  if (args.send && tree) throw new Error('this checkout is a linked git worktree: --send refuses here; run it from the main checkout');
  const cfg = contractEnv(envVar, 'mainnet', { signing: args.send });
  if (cfg === null) throw new Error('GIMBAL_CONTRACT_ID is not set: pass the engine env file with node --env-file');
  if (cfg.network !== 'mainnet') throw new Error('mainnet only');
  if (args.send && (cfg.privateKey === undefined || cfg.accountId === undefined)) throw new Error('--send needs OPERATOR_ACCOUNT_ID and OPERATOR_PRIVATE_KEY in the env file');
  const hlUrl = (envVar('HL_API_URL') ?? HL_MAINNET_URL).replace(/\/+$/, '').replace(/\/info$/, '');
  if (/testnet/.test(hlUrl)) throw new Error(`HL_API_URL ${hlUrl} is a testnet URL; this is the mainnet pair`);
  const phoenixUrl = (envVar('PHOENIX_API_URL') ?? PHOENIX_API_URL).replace(/\/+$/, '');
  const solRpcUrl = envVar('SOLANA_RPC_URL') ?? SOLANA_MAINNET_RPC_URL;

  const transport: NearTransport = args.send
    ? new NearApiTransport({ network: 'mainnet', accountId: cfg.accountId!, privateKey: cfg.privateKey!, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }) })
    : new NearViewTransport({ network: 'mainnet', ...(cfg.accountId === undefined ? {} : { accountId: cfg.accountId }), ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }) });
  const client = new NearContractClient({ contractId: cfg.contractId, network: 'mainnet', transport });
  const config = await client.config();
  checkContractNetwork(cfg.contractId, config, 'mainnet');
  const desk = await client.getDesk(cfg.deskId);
  if (desk === null) throw new Error(`${cfg.contractId} has no desk ${cfg.deskId}`);
  say(`gimbal pair-mainnet ${args.command}${args.positional.length > 0 ? ` ${args.positional.join(' ')}` : ''} for ${cfg.contractId} desk ${cfg.deskId}: ${args.send ? 'SEND' : 'dry run'}`);
  if (tree) say('warning   this checkout is a linked git worktree: --send refuses here; run it from the main checkout');
  say(`desk      ${desk.paused ? 'PAUSED' : 'running'}${desk.closing === true ? ', CLOSING (panic_close)' : ''}; operator ${desk.operator ?? 'none (the owner signs)'}`);
  if (args.send) {
    const [account, allowance] = await Promise.all([transport.account(), transport.allowance()]);
    say(`signer    ${cfg.accountId}: ${formatNear(account.amount)}, allowance ${allowance === null ? 'unlimited' : formatNear(allowance)}`);
  }

  const sol: DeskSolanaAccounts = { authority: desk.solana.authority, traderAccount: desk.solana.phoenix_trader, usdcAta: desk.solana.usdc_ata, phusdAta: desk.solana.phusd_ata };
  // One submitter for the relayer and the Phoenix leg: the leg reads the slot its transactions landed in from it.
  const solana = new SolanaSubmitter({ rpcUrl: solRpcUrl, network: 'mainnet' });
  const relayer = args.send
    ? new Relayer({ contract: client, deskId: cfg.deskId, hyperliquid: new HyperliquidSubmitter({ network: 'mainnet', apiUrl: hlUrl }), solana })
    : null;
  const ctx: Ctx = {
    args, client, config, desk, deskId: cfg.deskId, hlUrl, hl: new HyperliquidReader({ network: 'mainnet', url: `${hlUrl}/info` }),
    phoenix: new PhoenixReader({ apiUrl: phoenixUrl, rpcUrl: solRpcUrl }), phoenixUrl, chain: solanaChain(solRpcUrl), solana, sol, relayer, refreshing: null,
  };
  if (args.command === 'status') return status(ctx);
  if (args.command === 'fund-phoenix' || args.command === 'defund-phoenix') return money(ctx);
  if (args.command === 'open') return open(ctx);
  return close(ctx);
}

// ---- reads ----

async function hlInfo<T>(ctx: Ctx, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${ctx.hlUrl}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`hyperliquid /info ${String(body.type)}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function phoenixGet<T>(ctx: Ctx, path: string): Promise<T> {
  const res = await fetch(`${ctx.phoenixUrl}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`phoenix GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface PhoenixMarketConfig extends SnapshotMarket {
  symbol: string;
  takerFee: number;
  leverageTiers: { maxLeverage: number; maxSizeBaseLots: string }[];
  riskFactors: { maintenanceBps?: number; maintenance: number };
}

async function phoenixExchange(ctx: Ctx): Promise<{ mismatches: string[]; markets: PhoenixMarketConfig[] }> {
  const snap = await phoenixGet<{ exchange: Record<string, unknown>; markets: PhoenixMarketConfig[] }>(ctx, '/v1/exchange/snapshot');
  return { mismatches: exchangeMismatches(snap.exchange), markets: snap.markets };
}

/** Where the policy's Phoenix markets differ from the exchange's (orderbook, spline, lot, tick), one line each. */
async function policyMarketMismatches(ctx: Ctx, markets: PhoenixMarketConfig[], symbols?: string[]): Promise<string[]> {
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
function phoenixMaintenanceRate(m: PhoenixMarketConfig, lots: bigint): number {
  const tier = m.leverageTiers.find((t) => BigInt(t.maxSizeBaseLots) >= lots) ?? m.leverageTiers.at(-1);
  if (tier === undefined || !(tier.maxLeverage > 0)) throw new Error(`phoenix ${m.symbol}: no leverage tier`);
  const bps = m.riskFactors.maintenanceBps ?? m.riskFactors.maintenance * 100;
  return (bps / 10_000) / tier.maxLeverage;
}

async function traderState(ctx: Ctx): Promise<string | null> {
  const raw = await phoenixTraderApi(ctx.phoenixUrl).traderState(ctx.sol.authority);
  return parseTraderSnapshot(raw, '').state;
}

/** The contract's stored price of `symbol` and its age (s), or null. */
async function storedPrice(ctx: Ctx, symbol: string): Promise<{ px: number; ageS: number } | null> {
  const row = (await ctx.client.prices()).find((p) => p.asset === symbol);
  return row === undefined ? null : { px: Number(row.price_e8) / 1e8, ageS: (Date.now() - row.at_ms) / 1000 };
}

/**
 * refresh_prices when the stored price would be older than oracle_max_age_s - `marginS` (one NEAR transaction; --send
 * only). Concurrent callers share one refresh.
 */
async function ensureFresh(ctx: Ctx, symbol: string, marginS: number): Promise<{ px: number; ageS: number }> {
  const maxAge = ctx.desk.policy.oracle_max_age_s;
  const sp = await storedPrice(ctx, symbol);
  if (sp !== null && sp.ageS <= maxAge - marginS) return sp;
  if (!ctx.args.send || ctx.relayer === null) throw new Error(`the stored ${symbol} price is ${sp === null ? 'missing' : `${Math.round(sp.ageS)} s old`}`);
  if (ctx.refreshing === null) {
    say(`refresh   the stored ${symbol} price is ${sp === null ? 'missing' : `${Math.round(sp.ageS)} s old`}: refresh_prices`);
    ctx.refreshing = ctx.client.refreshPrices([symbol], { maxAgeS: Math.max(1, maxAge - marginS) })
      .then((tx) => say(`          ${refs(tx)}`))
      .finally(() => {
        ctx.refreshing = null;
      });
  }
  await ctx.refreshing;
  const fresh = await storedPrice(ctx, symbol);
  if (fresh === null || fresh.ageS > maxAge - PRICE_STALE_MARGIN_S) throw new Error(`refresh_prices did not leave a fresh ${symbol} price`);
  return fresh;
}

async function solReport(ctx: Ctx): Promise<number> {
  const [lamports, usdc, phusd] = await Promise.all([ctx.chain.balance(ctx.sol.authority), ctx.chain.tokenBalance(ctx.sol.usdcAta), ctx.chain.tokenBalance(ctx.sol.phusdAta)]);
  say(`solana    authority ${ctx.sol.authority}: ${solText(lamports)}`);
  say(`          USDC account ${ctx.sol.usdcAta}: ${usdc === null ? 'does not exist' : `${usdcText(usdc)} USDC`}`);
  say(`          PhUSD account ${ctx.sol.phusdAta}: ${phusd === null ? 'does not exist' : `${usdcText(phusd)} PhUSD`}`);
  return lamports;
}

function notionalAtEntry(positions: readonly Position[]): number {
  return positions.reduce((acc, p) => acc + Math.abs(p.size) * p.entryPx, 0);
}

// ---- status ----

async function status(ctx: Ctx): Promise<void> {
  const p = ctx.desk.policy;
  say(`policy    max_notional_usd ${p.max_notional_usd}, price_band_bps ${p.price_band_bps}, oracle_max_age_s ${p.oracle_max_age_s}`);
  say(`          hl_assets ${p.hl_assets.map((a) => a.symbol).join(', ') || 'none'}; phoenix_markets ${p.phoenix_markets.map((m) => m.symbol).join(', ') || 'none'}`);
  for (const symbol of new Set([...p.hl_assets.map((a) => a.symbol), ...p.phoenix_markets.map((m) => m.symbol)])) {
    const sp = await storedPrice(ctx, symbol);
    say(`price     ${symbol}: ${sp === null ? 'none stored' : `${sp.px} USD, ${Math.round(sp.ageS)} s old${sp.ageS > p.oracle_max_age_s ? ` (stale: over ${p.oracle_max_age_s} s; --send refreshes it)` : ''}`}`);
  }
  say(`leverage  no update-leverage action in the contract; legs are held to ${MAX_LEVERAGE}x effective, ${venueMaxLeverage('phoenix')}x on Phoenix (no live rescue)`);

  const evm = ctx.desk.evm_address.toLowerCase();
  const account = await ctx.hl.account(evm);
  say(`hyper     ${evm}: equity ${usd(account.equityUsd)}, free ${usd(account.freeMarginUsd)}, maintenance ${usd(account.maintenanceMarginUsd)}`);
  for (const pos of account.positions) say(`          ${pos.symbol} ${pos.size} at ${pos.entryPx}, liq ${pos.liqPx ?? 'none'}, ${pos.leverage.toFixed(2)}x`);
  const builder = ctx.config.treasury?.hl_builder;
  const tenth = ctx.config.fees?.hl_builder_tenth_bps;
  if (builder !== undefined && tenth !== undefined && tenth > 0) {
    const approved = await hlInfo<number>(ctx, { type: 'maxBuilderFee', user: evm, builder: builder.toLowerCase() });
    say(`          builder fee ${tenth / 10} bps, approved up to ${Number(approved) / 10} bps${Number(approved) >= tenth ? '' : ' (not yet: the first --send order approves it, one more signature)'}`);
  }

  const { mismatches, markets } = await phoenixExchange(ctx);
  const marketDiffs = await policyMarketMismatches(ctx, markets);
  say(`phoenix   exchange accounts ${mismatches.length === 0 ? 'match the pinned ones' : `DIFFER: ${mismatches.join('; ')}`}`);
  say(`          policy markets ${marketDiffs.length === 0 ? 'match the exchange (orderbook, spline, lot, tick)' : `DIFFER: ${marketDiffs.join('; ')}`}`);
  const state = await traderState(ctx);
  say(`          trader ${ctx.sol.traderAccount}: ${state ?? 'unknown'}${state === 'uninitialized' ? ' (not registered: run the Phoenix registration, sol_sign_register, first)' : ''}`);
  if (state !== null && state !== 'uninitialized') {
    const pa = await ctx.phoenix.account(ctx.sol.authority);
    say(`          equity ${usd(pa.equityUsd)}, free ${usd(pa.freeMarginUsd)}, maintenance ${usd(pa.maintenanceMarginUsd)}`);
    for (const pos of pa.positions) say(`          ${pos.symbol} ${pos.size} at ${pos.entryPx.toFixed(4)}, liq ${pos.liqPx ?? 'none'}`);
  }
  const lamports = await solReport(ctx);
  const orderTx = txCostLamports({ units: ORDER_COMPUTE_UNITS, microLamports: ORDER_PRIORITY_MICROLAMPORTS });
  const pairNeed = 2 * ORDERS_PER_PART * orderTx + SYSTEM_ACCOUNT_RENT_LAMPORTS;
  say(`          SOL needed: a deposit ${solText(MONEY_TX_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS + SYSTEM_ACCOUNT_RENT_LAMPORTS)} (with the PhUSD account), an open and close of one pair part ${solText(pairNeed)}`);
  if (lamports < pairNeed) say(`short     SOL: send at least ${solText(pairNeed - lamports)} to ${ctx.sol.authority} before trading on Phoenix`);
}

// ---- fund / defund ----

async function money(ctx: Ctx): Promise<void> {
  const amountText = ctx.args.positional[0];
  if (amountText === undefined) throw new UsageError(`${ctx.args.command} needs an amount`);
  const { mismatches } = await phoenixExchange(ctx);
  const mctx: MoneyContext = {
    chain: ctx.chain, desk: ctx.sol, traderState: () => traderState(ctx),
    withdrawable: async () => BigInt(Math.floor((await ctx.phoenix.account(ctx.sol.authority)).freeMarginUsd * 1e6)),
  };
  const withdraw = ctx.args.command === 'defund-phoenix';
  const plan = withdraw
    ? await planWithdraw(mctx, amountText === 'all' ? 'all' : parseUsdc(amountText))
    : await planDeposit(mctx, parseUsdc(amountText));
  for (const m of mismatches) plan.refusals.push(`the Phoenix exchange differs from the pinned accounts: ${m}`);
  if (ctx.desk.paused && plan.kind === 'deposit') plan.refusals.push('the desk is paused: sol_sign takes no deposit');
  if (withdraw) plan.refusals.push(...await withdrawKeepsLegs(ctx, amountText === 'all', plan.amount));
  printPlan(plan);
  if (!ctx.args.send) {
    for (const r of plan.refusals) say(`would refuse at --send: ${r}`);
    say('\ndry run: nothing was signed or sent. Add --send, from the main checkout, to sign it with sol_sign and send it.');
    if (plan.refusals.length > 0) process.exitCode = 1;
    return;
  }
  if (plan.refusals.length > 0) throw new Error(`${ctx.args.command} --send refused, nothing signed: ${plan.refusals.join('; ')}`);
  try {
    const tx = await sendPlan(plan, mctx, ctx.relayer!, `pair-mainnet ${ctx.args.command} ${usdcText(plan.amount)} USDC`);
    say(`sent      ${plan.kind} ${usdcText(plan.amount)} USDC: ${refs(tx)}`);
  } catch (err) {
    if (err instanceof OutcomeUnknown) {
      openLines.push(`open:     the ${plan.kind} of ${usdcText(plan.amount)} USDC has no proven outcome (${err.message}); check the desk authority's transactions and the Phoenix collateral before sending another`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }
}

/**
 * A withdrawal must leave an open Phoenix leg its collateral: `all` is refused while a position is open, and an amount
 * must leave the leg at or under Phoenix's leverage cap and more than 40 % from liquidation.
 */
async function withdrawKeepsLegs(ctx: Ctx, all: boolean, amount: bigint): Promise<string[]> {
  const state = await traderState(ctx);
  if (state === null || state === 'uninitialized') return [];
  const pa = await ctx.phoenix.account(ctx.sol.authority);
  const open = pa.positions.filter((p) => p.size !== 0);
  if (open.length === 0) return [];
  const names = open.map((p) => `${p.symbol} ${p.size}`).join(', ');
  if (all) return [`Phoenix holds ${names}: defund-phoenix all would take the leg's collateral; close the pair first, or withdraw an amount`];
  const notional = notionalAtEntry(open);
  const left = pa.equityUsd - Number(amount) / 1e6;
  const cap = venueMaxLeverage('phoenix');
  const out: string[] = [];
  if (!(left * cap >= notional)) out.push(`after it Phoenix would hold ${usd(left)} against ${usd(notional)} open (${names}): over ${cap}x; at most ${usd(Math.max(0, pa.equityUsd - notional / cap))} can go`);
  const distance = (left - pa.maintenanceMarginUsd) / notional;
  if (!(distance > 0.4)) out.push(`after it the Phoenix positions would be ${pct(distance)} from liquidation, not more than 40 %`);
  return out;
}

function printPlan(plan: MoneyPlan): void {
  const m = parseMessage(plan.message);
  say(`${plan.kind.padEnd(10)}${usdcText(plan.amount)} USDC; message ${plan.message.length} bytes, ${m.instructions.length} instructions, CU limit ${m.computeUnitLimit}, price ${m.computeUnitPrice} µlamports`);
  for (const [i, ix] of m.instructions.entries()) say(`          ${i}: ${ix.program} [${ix.accounts.length} accounts] ${Buffer.from(ix.data).toString('hex').slice(0, 48)}`);
  say(`          message (base64): ${Buffer.from(plan.message).toString('base64')}`);
  say(`          SOL ${solText(plan.solLamports)}, needed ${solText(plan.solNeededLamports)}`);
  for (const n of plan.notes) say(`          ${n}`);
  const s = plan.simulation;
  if (s !== null) {
    say(`simulate  ${s.err === null ? 'ok' : `error ${JSON.stringify(s.err)}`}, ${s.unitsConsumed ?? '?'} CU`);
    for (const l of s.logs.slice(-6)) say(`          ${l}`);
  } else {
    say('simulate  not run');
  }
}

// ---- the pair ----

interface Pair {
  symbol: string;
  hl: HlLeg;
  phoenix: PhoenixLeg;
  trader: PairTrader;
  lot: bigint;
  bandBps: number;
  priced: boolean;
  /** The policy market against the live exchange: refused at --send when not empty. */
  mismatches: string[];
  marketConfig: PhoenixMarketConfig;
  maker: MakerSettings;
  microLamports: number;
}

function orderOptions(args: Args): { maker: MakerSettings; microLamports: number; slippageBps: number } {
  const repriceS = num(args, '--reprice-s', MIN_REPRICE_S);
  const timeoutS = num(args, '--maker-timeout-s', 180);
  const maxOrders = num(args, '--max-orders', MAX_MAKER_ORDERS);
  const microLamports = num(args, '--priority-microlamports', ORDER_PRIORITY_MICROLAMPORTS);
  if (repriceS < MIN_REPRICE_S) throw new UsageError(`--reprice-s must be ${MIN_REPRICE_S} or more: every reprice is signed and metered`);
  if (!Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > MAX_MAKER_ORDERS) throw new UsageError(`--max-orders must be 1..${MAX_MAKER_ORDERS}`);
  if (!Number.isInteger(microLamports) || microLamports < 1 || microLamports > MAX_PRIORITY_MICROLAMPORTS) throw new UsageError(`--priority-microlamports must be 1..${MAX_PRIORITY_MICROLAMPORTS}`);
  return {
    maker: { repriceMs: repriceS * 1000, timeoutMs: timeoutS * 1000, takerFallback: args.flags['--taker-fallback'] === true, pollMs: 1000, maxOrders },
    microLamports, slippageBps: num(args, '--slippage-bps', 50),
  };
}

async function buildPair(ctx: Ctx, symbol: string): Promise<Pair> {
  const p: ContractPolicy = ctx.desk.policy;
  const asset = p.hl_assets.find((a) => a.symbol === symbol);
  const market = p.phoenix_markets.find((m) => m.symbol === symbol);
  if (asset === undefined || market === undefined) {
    throw new Error(`${symbol} must be in both policy.hl_assets (${p.hl_assets.map((a) => a.symbol).join(', ')}) and policy.phoenix_markets (${p.phoenix_markets.map((m) => m.symbol).join(', ')})`);
  }
  const { maker, microLamports, slippageBps } = orderOptions(ctx.args);
  if ((maker.timeoutMs / 1000) + PRICE_MARGIN_S >= p.oracle_max_age_s) {
    throw new UsageError(`--maker-timeout-s ${maker.timeoutMs / 1000} plus ${PRICE_MARGIN_S} s does not fit the policy's oracle_max_age_s ${p.oracle_max_age_s}`);
  }
  const unpriced = p.unpriced.find((u) => u.symbol === symbol);
  const maxNotionalUsd = unpriced === undefined ? p.max_notional_usd : Math.min(p.max_notional_usd, p.unpriced_max_notional_usd);
  // The dry run plans with the stored price as it is; --send refreshes one about to go stale before it prices an
  // order, so an unwind or a close is never refused for a stale price.
  const oraclePx = unpriced !== undefined ? async () => null : async (): Promise<number> => {
    if (ctx.args.send) return (await ensureFresh(ctx, symbol, PRICE_STALE_MARGIN_S)).px;
    const sp = await storedPrice(ctx, symbol);
    if (sp === null) throw new Error(`the contract has no stored ${symbol} price`);
    return sp.px;
  };
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
    legs: [hl, phoenix], priceBandBps: p.price_band_bps, log: (line) => say(`trade     ${line}`),
    openBlocked: () => (ctx.desk.closing === true ? 'the desk is closing (panic_close)' : null),
    onWatch: (w) => {
      if (w.status === 'unhedged') openLines.push(`open:     watch: ${w.notes.join('; ')}`);
    },
  });
  const { mismatches, markets } = await phoenixExchange(ctx);
  const marketConfig = markets.find((m) => m.symbol === symbol);
  if (marketConfig === undefined) throw new Error(`Phoenix has no ${symbol} market`);
  const diffs = [...mismatches.map((m) => `the Phoenix exchange differs from the pinned accounts: ${m}`), ...marketMismatches(marketConfig, market, spline)];
  return {
    symbol, hl, phoenix, trader, lot: commonLot(hl.lot, phoenix.lot), bandBps: p.price_band_bps, priced: unpriced === undefined, mismatches: diffs,
    marketConfig, maker, microLamports,
  };
}

/** The dry run's relayer: anything that would sign is a bug in the dry path. */
function dryRelayer(): Relayer {
  const no = () => {
    throw new Error('dry run: nothing is signed');
  };
  return { hlOrder: no, hlCancel: no, solSign: no } as unknown as Relayer;
}

async function hlFunding(ctx: Ctx, symbol: string, since: number): Promise<{ now: number; mean7d: number | null; maxLeverage: number }> {
  const [rates, history, markets] = await Promise.all([ctx.hl.funding(), ctx.hl.marketFundingHistory(symbol, since, Date.now()), ctx.hl.markets()]);
  const now = rates.find((r) => r.symbol === symbol)?.ratePerHour;
  if (now === undefined) throw new Error(`Hyperliquid has no funding for ${symbol}`);
  const m = markets.find((x) => x.symbol === symbol);
  if (m === undefined) throw new Error(`Hyperliquid has no ${symbol} perp`);
  return { now, mean7d: meanRatePerHour(history), maxLeverage: m.maxLeverage };
}

async function phoenixFunding(ctx: Ctx, symbol: string, since: number): Promise<{ now: number | null; mean7d: number | null }> {
  const [rates, history] = await Promise.all([ctx.phoenix.funding(), ctx.phoenix.marketFundingHistory(symbol, since, Date.now())]);
  return { now: rates.find((r) => r.symbol === symbol)?.ratePerHour ?? null, mean7d: meanRatePerHour(history) };
}

/** The Phoenix IOC of one part, built and simulated unsigned: refusals when it fails or uses too many units. */
async function simulateIoc(ctx: Ctx, pair: Pair, size: bigint): Promise<{ lines: string[]; refusals: string[] }> {
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

async function open(ctx: Ctx): Promise<void> {
  const [symbolArg, legUsdText] = ctx.args.positional;
  if (symbolArg === undefined || legUsdText === undefined) throw new UsageError('open needs <symbol> <legUsd>');
  if (ctx.args.flags['--short'] !== 'hyperliquid' || ctx.args.flags['--long'] !== 'phoenix') throw new UsageError('this pair is --short hyperliquid --long phoenix');
  const symbol = symbolArg.toUpperCase();
  const legUsd = Number(legUsdText);
  if (!(legUsd > 0)) throw new UsageError('legUsd must be a number above 0');
  const leverage = num(ctx.args, '--leverage', 2);
  const holdDays = num(ctx.args, '--hold-days', 7);
  const basisBps = num(ctx.args, '--basis-bps', 10);
  if (!(leverage > 0) || !(holdDays > 0)) throw new UsageError('--leverage and --hold-days must be above 0');
  const pair = await buildPair(ctx, symbol);
  const policy = ctx.desk.policy;
  const refusals: string[] = [...pair.mismatches];
  const since = Date.now() - 7 * 86_400_000;
  const evm = ctx.desk.evm_address.toLowerCase();

  const [hlF, pxF, hlBook, pxBook, hlAccount, state, sp, lamports, assetData] = await Promise.all([
    hlFunding(ctx, symbol, since), phoenixFunding(ctx, symbol, since), ctx.hl.book(symbol, 5), ctx.phoenix.book(symbol, 5), ctx.hl.account(evm),
    traderState(ctx), storedPrice(ctx, symbol), ctx.chain.balance(ctx.sol.authority),
    hlInfo<{ leverage?: { type?: string; value?: number } }>(ctx, { type: 'activeAssetData', user: evm, coin: symbol }).catch(() => null),
  ]);
  const registered = state !== null && state !== 'uninitialized';
  const pxAccount = registered ? await ctx.phoenix.account(ctx.sol.authority) : null;
  if (!registered) refusals.push(`the desk's Phoenix trader is not registered (${state ?? 'unknown'}): run the Phoenix registration (sol_sign_register), then fund-phoenix`);
  if (ctx.desk.paused) refusals.push('the desk is paused: no open is signed');
  // The cap is valued at max(limit, oracle), and the limit may be up to the band from the stored price.
  const legCap = policy.max_notional_usd * (1 - policy.price_band_bps / 10_000);
  if (legUsd > legCap + 1e-9) refusals.push(`legUsd ${usd(legUsd)} is over ${usd(legCap)}, the policy's ${policy.max_notional_usd} USD cap less the ${policy.price_band_bps} bps band`);
  const marginMode = assetData?.leverage?.type ?? null;
  if (marginMode !== 'cross') refusals.push(`Hyperliquid ${symbol} is in ${marginMode ?? 'an unreadable'} margin mode: only cross is planned (its liquidation is the account's); set it to cross on Hyperliquid`);

  const hlBid = hlBook.bids[0]?.px ?? 0;
  const hlAsk = hlBook.asks[0]?.px ?? 0;
  const pxBid = pxBook.bids[0]?.px ?? 0;
  const pxAsk = pxBook.asks[0]?.px ?? 0;
  const mid = (hlBid + hlAsk + pxBid + pxAsk) / 4;
  const size = floorToLot(toQty((legUsd / mid).toFixed(8)), pair.lot);
  if (size === 0n) refusals.push(`${usd(legUsd)} at ${mid.toFixed(4)} is under one common lot ${qtyString(pair.lot)}`);
  const builderBps = (ctx.config.fees?.hl_builder_tenth_bps ?? 0) / 10;
  const pxLotsAfter = (toQty(String(Math.abs(pxAccount?.positions.find((p) => p.symbol === symbol)?.size ?? 0))) + size) / pair.phoenix.lot;
  const short: CarryLegInput = {
    venue: 'hyperliquid', ratePerHour: hlF.now, rate7dPerHour: hlF.mean7d ?? hlF.now, takerBps: HL_TAKER_BPS + builderBps, halfSpreadBps: halfSpreadBps(hlBid, hlAsk),
    equityUsd: hlAccount.equityUsd, maintenanceUsd: hlAccount.maintenanceMarginUsd, notionalUsd: notionalAtEntry(hlAccount.positions), maintenanceRate: 1 / (2 * hlF.maxLeverage),
  };
  const long: CarryLegInput = {
    venue: 'phoenix', ratePerHour: pxF.now ?? 0, rate7dPerHour: pxF.mean7d ?? pxF.now ?? 0, takerBps: pair.marketConfig.takerFee * 10_000, halfSpreadBps: halfSpreadBps(pxBid, pxAsk),
    equityUsd: pxAccount?.equityUsd ?? 0, maintenanceUsd: pxAccount?.maintenanceMarginUsd ?? 0, notionalUsd: notionalAtEntry(pxAccount?.positions ?? []),
    maintenanceRate: phoenixMaintenanceRate(pair.marketConfig, pxLotsAfter),
  };
  const plan = carryPlan({ symbol, legUsd, leverage, holdDays, basisBufferBps: basisBps, short, long });
  refusals.push(...plan.refusals);

  let chunk: bigint | null = null;
  try {
    chunk = await pair.trader.openChunk(1);
  } catch (err) {
    refusals.push(`no pair fits the policy cap: ${errorMessage(err)}`);
  }
  const parts = chunk === null || size === 0n ? 0 : Number((size + chunk - 1n) / chunk);
  const first = chunk === null || size === 0n ? null : size < chunk ? size : chunk;
  if (first !== null && qtyNumber(first) * hlAsk < 10) refusals.push(`a pair part of ${qtyString(first)} ${symbol} is under Hyperliquid's 10 USD order minimum`);
  const orderTx = txCostLamports({ units: ORDER_COMPUTE_UNITS, microLamports: pair.microLamports });
  const solNeed = Math.max(1, parts) * ORDERS_PER_PART * orderTx + SYSTEM_ACCOUNT_RENT_LAMPORTS;
  if (lamports < solNeed) refusals.push(`the desk authority holds ${solText(lamports)}; ${Math.max(1, parts)} pair part(s) need up to ${solText(solNeed)} for Phoenix fees and the rent-exempt reserve: send ${solText(solNeed - lamports)} to ${ctx.sol.authority}`);
  if (sp === null && pair.priced) refusals.push(`the contract has no stored ${symbol} price`);
  const sim = first === null ? { lines: ['ioc sim   no part to simulate'], refusals: [] } : await simulateIoc(ctx, pair, first);
  refusals.push(...sim.refusals);

  printCarry(symbol, legUsd, leverage, holdDays, plan, short, long, { hlBid, hlAsk, pxBid, pxAsk });
  say(`size      ${qtyString(size)} ${symbol} per leg (${usd(qtyNumber(size) * mid)} at ${mid.toFixed(4)}); common lot ${qtyString(pair.lot)}`);
  say(`          ${parts} pair part(s) of at most ${chunk === null ? '?' : qtyString(chunk)} (policy max_notional_usd ${policy.max_notional_usd} less the ${pair.bandBps} bps band)`);
  say(`leverage  Hyperliquid ${symbol}: ${assetData?.leverage === undefined ? 'unknown' : `${assetData.leverage.type} ${assetData.leverage.value}x`} on the account (the contract cannot set it); effective leverage is what is checked`);
  say(`price     stored ${symbol} ${sp === null ? 'none' : `${sp.px}, ${Math.round(sp.ageS)} s old`}; --send refreshes it before each part when it would not live ${pair.maker.timeoutMs / 1000 + PRICE_MARGIN_S} s more (of ${policy.oracle_max_age_s})`);
  say(`solana    authority ${solText(lamports)}; up to ${solText(solNeed)} needed (unit price ${pair.microLamports} µlamports)`);
  for (const l of sim.lines) say(l);
  say(`order     maker first: Hyperliquid SELL post-only at the ask, repriced every ${pair.maker.repriceMs / 1000} s, at most ${pair.maker.maxOrders} signed post-only orders (the C10 meter counts each), for ${pair.maker.timeoutMs / 1000} s${pair.maker.takerFallback ? ', then an IOC for the rest' : ', no taker fallback (--taker-fallback to add one)'}; then Phoenix BUY IOC for what filled`);

  if (!ctx.args.send) {
    for (const r of refusals) say(`would refuse at --send: ${r}`);
    say('\ndry run: nothing was signed or sent. Add --send, from the main checkout, to open the pair.');
    if (refusals.length > 0) process.exitCode = 1;
    return;
  }
  if (refusals.length > 0) throw new Error(`open --send refused, nothing signed: ${refusals.join('; ')}`);
  await approveBuilderFee(ctx);
  try {
    const results = await pair.trader.openInChunks({
      size, longIndex: 1, reason: `pair-mainnet: carry ${symbol}, short hyperliquid, long phoenix`, maker: { index: 0 },
      beforePart: async () => {
        if (pair.priced) await ensureFresh(ctx, symbol, pair.maker.timeoutMs / 1000 + PRICE_MARGIN_S);
      },
    });
    for (const r of results) printResult('open', r);
  } finally {
    await finish(pair);
  }
}

async function close(ctx: Ctx): Promise<void> {
  const symbolArg = ctx.args.positional[0];
  if (symbolArg === undefined) throw new UsageError('close needs <symbol>');
  const symbol = symbolArg.toUpperCase();
  const pair = await buildPair(ctx, symbol);
  const [hlPos, pxPos, sp, lamports] = await Promise.all([pair.hl.position(), pair.phoenix.position(), storedPrice(ctx, symbol), ctx.chain.balance(ctx.sol.authority)]);
  say(`positions hyperliquid ${symbol} ${signedQtyString(hlPos)}, phoenix ${symbol} ${signedQtyString(pxPos)}${hlPos + pxPos === 0n ? ' (hedged)' : ' (NOT offsetting)'}`);
  say(`order     both reduce-only: Hyperliquid post-only at the touch (every ${pair.maker.repriceMs / 1000} s, at most ${pair.maker.maxOrders}, ${pair.maker.timeoutMs / 1000} s${pair.maker.takerFallback ? ', then IOC' : ''}), then Phoenix IOC for what it closed; the rest by IOC`);
  say(`price     stored ${symbol} ${sp === null ? 'none' : `${sp.px}, ${Math.round(sp.ageS)} s old`}; --send refreshes it when an order finds it stale`);
  const refusals: string[] = [...pair.mismatches];
  if (hlPos === 0n && pxPos === 0n) refusals.push('nothing to close: both legs are flat');
  const solNeed = 2 * txCostLamports({ units: ORDER_COMPUTE_UNITS, microLamports: pair.microLamports }) + SYSTEM_ACCOUNT_RENT_LAMPORTS;
  if (pxPos !== 0n && lamports < solNeed) refusals.push(`the desk authority holds ${solText(lamports)}; closing on Phoenix needs ${solText(solNeed)}: send ${solText(solNeed - lamports)}`);
  if (!ctx.args.send) {
    for (const r of refusals) say(`would refuse at --send: ${r}`);
    say('\ndry run: nothing was signed or sent. Add --send, from the main checkout, to close the pair.');
    if (refusals.length > 0) process.exitCode = 1;
    return;
  }
  if (refusals.length > 0) throw new Error(`close --send refused, nothing signed: ${refusals.join('; ')}`);
  await approveBuilderFee(ctx);
  try {
    if (pair.priced) await ensureFresh(ctx, symbol, pair.maker.timeoutMs / 1000 + PRICE_MARGIN_S);
    printResult('close', await pair.trader.close({ reason: `pair-mainnet: close ${symbol}`, maker: { index: 0 } }));
  } finally {
    await finish(pair);
  }
}

/** Before the first order: the builder fee approved on Hyperliquid (one more signature, once per desk). */
async function approveBuilderFee(ctx: Ctx): Promise<void> {
  const builder = ctx.config.treasury?.hl_builder;
  const tenth = ctx.config.fees?.hl_builder_tenth_bps;
  if (builder === undefined || tenth === undefined || tenth <= 0) return;
  const approved = await hlInfo<number>(ctx, { type: 'maxBuilderFee', user: ctx.desk.evm_address.toLowerCase(), builder: builder.toLowerCase() });
  if (Number(approved) >= tenth) return;
  const r = await ctx.relayer!.hlApproveBuilderFee();
  say(`builder   fee approved: ${refs(r.tx)}`);
}

function printCarry(
  symbol: string, legUsd: number, leverage: number, holdDays: number, plan: CarryPlan, short: CarryLegInput, long: CarryLegInput,
  book: { hlBid: number; hlAsk: number; pxBid: number; pxAsk: number },
): void {
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

function printResult(what: string, r: PairResult): void {
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
 * What stays open when the process ends: a post-only order left unsettled (cancelled by its id once more first), an
 * unhedged pair, or an order with no answer that may still run.
 */
async function finish(pair: Pair): Promise<void> {
  pair.trader.stop();
  if (pair.hl.pendingMakerOrders().length > 0) {
    for (const line of await pair.hl.cancelPending('pair-mainnet: exit')) say(`cancel    ${line}`);
    for (const p of pair.hl.pendingMakerOrders()) {
      openLines.push(`open:     hyperliquid post-only ${p.side} ${p.size} ${pair.symbol} (oid ${p.oid ?? 'unknown'}, cloid ${p.cloid}) may still rest and fill: cancel it on Hyperliquid and reconcile both legs`);
      process.exitCode = 3;
    }
  }
  if (pair.trader.unhedged !== null) {
    openLines.push(`open:     ${pair.trader.unhedged}`);
    process.exitCode = 3;
  }
  for (const leg of pair.trader.legs) {
    const u = pair.trader.unsettled(leg);
    if (u === null) continue;
    const orders = u.refs.map((ref) => `${ref.side} ${ref.size}${ref.reduceOnly ? ' reduce-only' : ''} (${ref.clientId ?? ref.orderId ?? 'no id'})`).join(' and ');
    openLines.push(`open:     ${leg.venue} ${orders} has no answer and may still run until ${new Date(u.until).toISOString()}: check ${leg.venue} ${leg.symbol} by hand until then`);
    process.exitCode = 3;
  }
}

function refs(tx: TxRef[]): string {
  return tx.length === 0 ? '(none)' : tx.map((t) => t.url).join('  ');
}
