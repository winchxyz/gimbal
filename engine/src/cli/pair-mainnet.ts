// The carry pair on mainnet: short Hyperliquid, long Phoenix, every order signed by the contract (hl_order and
// sol_sign), and the Phoenix money moves that go with it. A dry run by default: it reads everything, builds and
// simulates what it would sign, prints the plan, and signs nothing. --send acts; it refuses in a linked git worktree.
//
//   node --env-file=<engine env file> engine/src/cli/pair-mainnet.ts <command> [--send]
//     status
//     fund-phoenix <usdc>                   desk USDC account -> Ember wrap -> Phoenix deposit (one sol_sign)
//     defund-phoenix <usdc|all>             Phoenix withdraw -> Ember unwrap -> desk USDC account (one sol_sign)
//     open <symbol> <legUsd> --short hyperliquid --long phoenix [--leverage 2] [--hold-days 7] [--basis-bps 10]
//          [--slippage-bps 50] [--reprice-s 10] [--maker-timeout-s 60] [--no-taker-fallback]
//     close <symbol> [--reprice-s 10] [--maker-timeout-s 60] [--no-taker-fallback]
//
// The env file holds the engine's names (GIMBAL_CONTRACT_ID, DESK_ID, OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY,
// NEAR_RPC_URL, HL_API_URL, PHOENIX_API_URL, SOLANA_RPC_URL); values are never printed, and the key is read only
// with --send. Open goes maker first: the Hyperliquid short as post-only limits at the touch (repriced every
// --reprice-s, an IOC for the rest after --maker-timeout-s unless --no-taker-fallback), then the Phoenix long as one
// IOC for what filled; a pair over policy.max_notional_usd is split into whole pairs. Close mirrors it, reduce-only.
// Before an open the plan prints both legs' funding now and over 7 days, the gross APR, the spread expected over the
// hold against the round trip (taker fees, half spreads, basis buffer), the size, leverage and liquidation distance
// per leg; it refuses when the spread does not cover the round trip or a leg's distance is 40 % or less.
//
// Hyperliquid leverage: the contract has no update-leverage action (its Hyperliquid actions are hl_order, hl_cancel,
// hl_set_referrer, hl_approve_builder_fee, hl_usd_class_transfer, hl_withdraw, hl_send_to_intents), so the desk
// trades at the leverage its Hyperliquid account already has for the coin (cross by default); --leverage is the
// collateral each leg must hold (legUsd / leverage), checked, not set.
//
// An outcome that cannot be proven ends with `open:` lines naming what to reconcile and by which ids; exit code 3.

import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ContractPolicy, TxRef } from '@gimbal/shared';
import { formatNear } from '../contract/budget.ts';
import type { ContractConfigView } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport, NearViewTransport } from '../contract/near-transport.ts';
import type { NearTransport } from '../contract/near-client.ts';
import type { ContractClient, DeskView } from '../contract/types.ts';
import { ContractRefusal, OutcomeUnknown } from '../contract/types.ts';
import { HyperliquidSubmitter } from '../relayer/hyperliquid.ts';
import type { MoneyContext, MoneyPlan, SolanaChain } from '../relayer/phoenix-money.ts';
import {
  LAMPORTS_PER_SOL, MONEY_TX_LAMPORTS, ORDER_TX_LAMPORTS, SYSTEM_ACCOUNT_RENT_LAMPORTS, parseUsdc, planDeposit, planWithdraw, sendPlan,
  solanaChain, solText, usdcText,
} from '../relayer/phoenix-money.ts';
import { PHOENIX_MAINNET, exchangeMismatches, splineOf } from '../relayer/phoenix-tx.ts';
import type { DeskSolanaAccounts } from '../relayer/phoenix-withdraw.ts';
import { Relayer } from '../relayer/relayer.ts';
import { SolanaSubmitter, parseMessage } from '../relayer/solana.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import type { CarryLegInput, CarryPlan } from '../trade/carry-plan.ts';
import { carryPlan, halfSpreadBps, meanRatePerHour, pct, usd } from '../trade/carry-plan.ts';
import type { LegSide, MakerSettings } from '../trade/legs.ts';
import { HlLeg } from '../trade/legs.ts';
import { commonLot, floorToLot, qtyNumber, qtyString, signedQtyString, toQty } from '../trade/lots.ts';
import type { PairResult } from '../trade/pair.ts';
import { PairTrader } from '../trade/pair.ts';
import { PhoenixLeg, parseTraderSnapshot, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import { HL_MAINNET_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import { PHOENIX_API_URL, PhoenixReader, SOLANA_MAINNET_RPC_URL } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import { checkContractNetwork, contractEnv } from './serve-contract.ts';

const USAGE = `usage: node --env-file=<engine env> engine/src/cli/pair-mainnet.ts <command> [--send]
  status
  fund-phoenix <usdc>
  defund-phoenix <usdc|all>
  open <symbol> <legUsd> --short hyperliquid --long phoenix [--leverage 2] [--hold-days 7] [--basis-bps 10] [--slippage-bps 50] [--reprice-s 10] [--maker-timeout-s 60] [--no-taker-fallback]
  close <symbol> [--reprice-s 10] [--maker-timeout-s 60] [--no-taker-fallback]`;

const FLAGS: Record<string, 'value' | 'switch'> = {
  '--send': 'switch', '--short': 'value', '--long': 'value', '--leverage': 'value', '--hold-days': 'value', '--basis-bps': 'value',
  '--slippage-bps': 'value', '--reprice-s': 'value', '--maker-timeout-s': 'value', '--no-taker-fallback': 'switch',
};
/** Phoenix orders one pair part may take: the open, its retry, and two unwind orders. */
const ORDERS_PER_PART = 4;
const HL_TAKER_BPS = 5.5;

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
function linkedWorktree(): string | null {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const git = `${root}.git`;
  return existsSync(git) && statSync(git).isFile() ? root : null;
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
  solRpcUrl: string;
  sol: DeskSolanaAccounts;
  relayer: Relayer | null;          // --send only
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
  if (args.send && tree !== null) throw new Error('this checkout is a linked git worktree: --send refuses here; run it from the main checkout');
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
  if (tree !== null) say('warning   this checkout is a linked git worktree: --send refuses here; run it from the main checkout');
  say(`desk      ${desk.paused ? 'PAUSED' : 'running'}${desk.closing === true ? ', CLOSING (panic_close)' : ''}; operator ${desk.operator ?? 'none (the owner signs)'}`);
  if (args.send) {
    const [account, allowance] = await Promise.all([transport.account(), transport.allowance()]);
    say(`signer    ${cfg.accountId}: ${formatNear(account.amount)}, allowance ${allowance === null ? 'unlimited' : formatNear(allowance)}`);
  }

  const sol: DeskSolanaAccounts = { authority: desk.solana.authority, traderAccount: desk.solana.phoenix_trader, usdcAta: desk.solana.usdc_ata, phusdAta: desk.solana.phusd_ata };
  const chain = solanaChain(solRpcUrl);
  const relayer = args.send
    ? new Relayer({
      contract: client, deskId: cfg.deskId,
      hyperliquid: new HyperliquidSubmitter({ network: 'mainnet', apiUrl: hlUrl }),
      solana: new SolanaSubmitter({ rpcUrl: solRpcUrl, network: 'mainnet' }),
    })
    : null;
  const ctx: Ctx = {
    args, client, config, desk, deskId: cfg.deskId, hlUrl, hl: new HyperliquidReader({ network: 'mainnet', url: `${hlUrl}/info` }),
    phoenix: new PhoenixReader({ apiUrl: phoenixUrl, rpcUrl: solRpcUrl }), phoenixUrl, chain, solRpcUrl, sol, relayer,
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

interface PhoenixMarketConfig {
  symbol: string;
  marketPubkey: string;
  splinePubkey?: string;
  takerFee: number;
  leverageTiers: { maxLeverage: number }[];
  riskFactors: { maintenanceBps?: number; maintenance: number };
}

async function phoenixExchange(ctx: Ctx): Promise<{ mismatches: string[]; markets: PhoenixMarketConfig[] }> {
  const snap = await phoenixGet<{ exchange: Record<string, unknown>; markets: PhoenixMarketConfig[] }>(ctx, '/v1/exchange/snapshot');
  return { mismatches: exchangeMismatches(snap.exchange), markets: snap.markets };
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

async function solReport(ctx: Ctx): Promise<number> {
  const [lamports, usdc, phusd] = await Promise.all([ctx.chain.balance(ctx.sol.authority), ctx.chain.tokenBalance(ctx.sol.usdcAta), ctx.chain.tokenBalance(ctx.sol.phusdAta)]);
  say(`solana    authority ${ctx.sol.authority}: ${solText(lamports)}`);
  say(`          USDC account ${ctx.sol.usdcAta}: ${usdc === null ? 'does not exist' : `${usdcText(usdc)} USDC`}`);
  say(`          PhUSD account ${ctx.sol.phusdAta}: ${phusd === null ? 'does not exist' : `${usdcText(phusd)} PhUSD`}`);
  return lamports;
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
  say('leverage  the contract has no update-leverage action: Hyperliquid keeps the account\'s own leverage per coin');

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

  const { mismatches } = await phoenixExchange(ctx);
  say(`phoenix   exchange accounts ${mismatches.length === 0 ? 'match the pinned ones' : `DIFFER: ${mismatches.join('; ')}`}`);
  const state = await traderState(ctx);
  say(`          trader ${ctx.sol.traderAccount}: ${state ?? 'unknown'}${state === 'uninitialized' ? ' (not registered: run the Phoenix registration, sol_sign_register, first)' : ''}`);
  if (state !== null && state !== 'uninitialized') {
    const pa = await ctx.phoenix.account(ctx.sol.authority);
    say(`          equity ${usd(pa.equityUsd)}, free ${usd(pa.freeMarginUsd)}, maintenance ${usd(pa.maintenanceMarginUsd)}`);
    for (const pos of pa.positions) say(`          ${pos.symbol} ${pos.size} at ${pos.entryPx.toFixed(4)}, liq ${pos.liqPx ?? 'none'}`);
  }
  const lamports = await solReport(ctx);
  const pairNeed = 2 * ORDERS_PER_PART * ORDER_TX_LAMPORTS + SYSTEM_ACCOUNT_RENT_LAMPORTS;
  say(`          SOL needed: a deposit ${solText(MONEY_TX_LAMPORTS + 2_039_280 + SYSTEM_ACCOUNT_RENT_LAMPORTS)} (with the PhUSD account), an open and close of one pair part ${solText(pairNeed)}`);
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
  const plan = ctx.args.command === 'fund-phoenix'
    ? await planDeposit(mctx, parseUsdc(amountText))
    : await planWithdraw(mctx, amountText === 'all' ? 'all' : parseUsdc(amountText));
  for (const m of mismatches) plan.refusals.push(`the Phoenix exchange differs from the pinned accounts: ${m}`);
  if (ctx.desk.paused && plan.kind === 'deposit') plan.refusals.push('the desk is paused: sol_sign takes no deposit');
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
}

async function buildPair(ctx: Ctx, symbol: string, slippageBps: number, maker: MakerSettings): Promise<Pair> {
  const p: ContractPolicy = ctx.desk.policy;
  const asset = p.hl_assets.find((a) => a.symbol === symbol);
  const market = p.phoenix_markets.find((m) => m.symbol === symbol);
  if (asset === undefined || market === undefined) {
    throw new Error(`${symbol} must be in both policy.hl_assets (${p.hl_assets.map((a) => a.symbol).join(', ')}) and policy.phoenix_markets (${p.phoenix_markets.map((m) => m.symbol).join(', ')})`);
  }
  const unpriced = p.unpriced.find((u) => u.symbol === symbol);
  const maxNotionalUsd = unpriced === undefined ? p.max_notional_usd : Math.min(p.max_notional_usd, p.unpriced_max_notional_usd);
  // The dry run plans with the stored price as it is; --send refreshes a stale one before anything is signed.
  const oraclePx = unpriced !== undefined ? async () => null : async (): Promise<number> => {
    const sp = await storedPrice(ctx, symbol);
    if (sp === null) throw new Error(`the contract has no stored ${symbol} price`);
    if (ctx.args.send && sp.ageS > p.oracle_max_age_s) throw new Error(`the stored ${symbol} price is ${Math.round(sp.ageS)} s old, over oracle_max_age_s ${p.oracle_max_age_s}`);
    return sp.px;
  };
  const relayer = ctx.relayer ?? dryRelayer();
  const hlBook = async (side: LegSide) => {
    const book = await ctx.hl.book(symbol, 5);
    const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
    if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on Hyperliquid ${symbol}`);
    return px;
  };
  const evm = ctx.desk.evm_address.toLowerCase();
  const hl = new HlLeg({
    relayer, info: (body) => hlInfo(ctx, body), user: evm, coin: symbol, asset: asset.index, szDecimals: asset.sz_decimals, oraclePx,
    bandBps: p.price_band_bps, maxNotionalUsd, ...(unpriced === undefined ? {} : { maxSz: unpriced.max_sz }), bestPx: hlBook, slippageBps, maker,
  });
  const submitter = new SolanaSubmitter({ rpcUrl: ctx.solRpcUrl, network: 'mainnet' });
  const phoenix = new PhoenixLeg({
    relayer, chain: ctx.chain, waitPastLastValidHeight: (h) => submitter.waitPastLastValidHeight(h), api: phoenixTraderApi(ctx.phoenixUrl), desk: ctx.sol,
    market: { symbol, orderbook: market.orderbook, spline: await splineOf(market.orderbook), baseLotE8: market.base_lot_e8, tickE8: market.tick_e8 },
    exchange: PHOENIX_MAINNET, oraclePx, bandBps: p.price_band_bps, maxNotionalUsd, ...(unpriced === undefined ? {} : { maxSz: unpriced.max_sz }),
    bestPx: async (side) => {
      const book = await ctx.phoenix.book(symbol, 5);
      const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
      if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on Phoenix ${symbol}`);
      return px;
    },
    slippageBps,
  });
  const trader = new PairTrader({
    legs: [hl, phoenix], priceBandBps: p.price_band_bps, log: (line) => say(`trade     ${line}`),
    openBlocked: () => (ctx.desk.closing === true ? 'the desk is closing (panic_close)' : null),
    onWatch: (w) => {
      if (w.status === 'unhedged') openLines.push(`open:     watch: ${w.notes.join('; ')}`);
    },
  });
  return { symbol, hl, phoenix, trader, lot: commonLot(hl.lot, phoenix.lot), bandBps: p.price_band_bps, priced: unpriced === undefined };
}

/** The dry run's relayer: anything that would sign is a bug in the dry path. */
function dryRelayer(): Relayer {
  const no = () => {
    throw new Error('dry run: nothing is signed');
  };
  return { hlOrder: no, hlCancel: no, solSign: no } as unknown as Relayer;
}

function makerSettings(args: Args): MakerSettings {
  return {
    repriceMs: num(args, '--reprice-s', 10) * 1000, timeoutMs: num(args, '--maker-timeout-s', 60) * 1000,
    takerFallback: args.flags['--no-taker-fallback'] !== true, pollMs: 1000,
  };
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
  const slippageBps = num(ctx.args, '--slippage-bps', 50);
  if (!(leverage > 0) || !(holdDays > 0)) throw new UsageError('--leverage and --hold-days must be above 0');
  const pair = await buildPair(ctx, symbol, slippageBps, makerSettings(ctx.args));
  const refusals: string[] = [];
  const since = Date.now() - 7 * 86_400_000;
  const evm = ctx.desk.evm_address.toLowerCase();

  const [hlF, pxF, hlBook, pxBook, hlAccount, exchange, state, sp, lamports] = await Promise.all([
    hlFunding(ctx, symbol, since), phoenixFunding(ctx, symbol, since), ctx.hl.book(symbol, 5), ctx.phoenix.book(symbol, 5), ctx.hl.account(evm),
    phoenixExchange(ctx), traderState(ctx), storedPrice(ctx, symbol), ctx.chain.balance(ctx.sol.authority),
  ]);
  const registered = state !== null && state !== 'uninitialized';
  const pxAccount = registered ? await ctx.phoenix.account(ctx.sol.authority) : null;
  const pxMarket = exchange.markets.find((m) => m.symbol === symbol);
  if (pxMarket === undefined) throw new Error(`Phoenix has no ${symbol} market`);
  for (const m of exchange.mismatches) refusals.push(`the Phoenix exchange differs from the pinned accounts: ${m}`);
  if (!registered) refusals.push(`the desk's Phoenix trader is not registered (${state ?? 'unknown'}): run the Phoenix registration (sol_sign_register), then fund-phoenix`);
  if (ctx.desk.paused) refusals.push('the desk is paused: no open is signed');

  const hlBid = hlBook.bids[0]?.px ?? 0;
  const hlAsk = hlBook.asks[0]?.px ?? 0;
  const pxBid = pxBook.bids[0]?.px ?? 0;
  const pxAsk = pxBook.asks[0]?.px ?? 0;
  const mid = (hlBid + hlAsk + pxBid + pxAsk) / 4;
  const builderBps = (ctx.config.fees?.hl_builder_tenth_bps ?? 0) / 10;
  const pxMaxLev = Math.max(...pxMarket.leverageTiers.map((t) => t.maxLeverage));
  const pxMaintBps = pxMarket.riskFactors.maintenanceBps ?? pxMarket.riskFactors.maintenance * 100;
  const short: CarryLegInput = {
    venue: 'hyperliquid', ratePerHour: hlF.now, rate7dPerHour: hlF.mean7d ?? hlF.now, takerBps: HL_TAKER_BPS + builderBps, halfSpreadBps: halfSpreadBps(hlBid, hlAsk),
    equityUsd: hlAccount.equityUsd, maintenanceUsd: hlAccount.maintenanceMarginUsd, maintenanceRate: 1 / (2 * hlF.maxLeverage),
  };
  const long: CarryLegInput = {
    venue: 'phoenix', ratePerHour: pxF.now ?? 0, rate7dPerHour: pxF.mean7d ?? pxF.now ?? 0, takerBps: pxMarket.takerFee * 10_000, halfSpreadBps: halfSpreadBps(pxBid, pxAsk),
    equityUsd: pxAccount?.equityUsd ?? 0, maintenanceUsd: pxAccount?.maintenanceMarginUsd ?? 0, maintenanceRate: (pxMaintBps / 10_000) / pxMaxLev,
  };
  const plan = carryPlan({ symbol, legUsd, leverage, holdDays, basisBufferBps: basisBps, short, long });
  refusals.push(...plan.refusals);

  const size = floorToLot(toQty((legUsd / mid).toFixed(8)), pair.lot);
  if (size === 0n) refusals.push(`${usd(legUsd)} at ${mid.toFixed(4)} is under one common lot ${qtyString(pair.lot)}`);
  let chunk: bigint | null = null;
  try {
    chunk = await pair.trader.openChunk(1);
  } catch (err) {
    refusals.push(`no pair fits the policy cap: ${errorMessage(err)}`);
  }
  const parts = chunk === null || size === 0n ? 0 : Number((size + chunk - 1n) / chunk);
  if (chunk !== null && size > 0n && qtyNumber(size < chunk ? size : chunk) * hlBid < 10) {
    refusals.push(`a pair part of ${qtyString(size < chunk ? size : chunk)} ${symbol} is under Hyperliquid's 10 USD order minimum`);
  }
  const solNeed = Math.max(1, parts) * ORDERS_PER_PART * ORDER_TX_LAMPORTS + SYSTEM_ACCOUNT_RENT_LAMPORTS;
  if (lamports < solNeed) refusals.push(`the desk authority holds ${solText(lamports)}; ${Math.max(1, parts)} pair part(s) need up to ${solText(solNeed)} for Phoenix fees and the rent-exempt reserve: send ${solText(solNeed - lamports)} to ${ctx.sol.authority}`);
  if (sp === null && pair.priced) refusals.push(`the contract has no stored ${symbol} price`);

  const leverageNow = await hlInfo<{ leverage?: { type?: string; value?: number } }>(ctx, { type: 'activeAssetData', user: evm, coin: symbol }).catch(() => null);
  printCarry(symbol, legUsd, leverage, holdDays, plan, short, long, { hlBid, hlAsk, pxBid, pxAsk });
  say(`size      ${qtyString(size)} ${symbol} per leg (${usd(qtyNumber(size) * mid)} at ${mid.toFixed(4)}); common lot ${qtyString(pair.lot)}`);
  say(`          ${parts} pair part(s) of at most ${chunk === null ? '?' : qtyString(chunk)} (policy max_notional_usd ${ctx.desk.policy.max_notional_usd} less the ${pair.bandBps} bps band)`);
  say(`leverage  asked ${leverage}x: each leg must hold ${usd(legUsd / leverage)} of collateral; the contract has no update-leverage action, so Hyperliquid keeps its ${symbol} setting: ${leverageNow?.leverage === undefined ? 'unknown' : `${leverageNow.leverage.type} ${leverageNow.leverage.value}x`}`);
  say(`price     stored ${symbol} ${sp === null ? 'none' : `${sp.px}, ${Math.round(sp.ageS)} s old${sp.ageS > ctx.desk.policy.oracle_max_age_s ? ' (stale: --send refreshes it first, one NEAR transaction)' : ''}`}`);
  say(`solana    authority ${solText(lamports)}; up to ${solText(solNeed)} needed`);
  say(`order     maker first: Hyperliquid SELL post-only at the ask (reprice ${num(ctx.args, '--reprice-s', 10)} s, timeout ${num(ctx.args, '--maker-timeout-s', 60)} s${ctx.args.flags['--no-taker-fallback'] === true ? ', no taker fallback' : ', then IOC'}), then Phoenix BUY IOC for what filled`);

  if (!ctx.args.send) {
    for (const r of refusals) say(`would refuse at --send: ${r}`);
    say('\ndry run: nothing was signed or sent. Add --send, from the main checkout, to open the pair.');
    if (refusals.length > 0) process.exitCode = 1;
    return;
  }
  if (refusals.length > 0) throw new Error(`open --send refused, nothing signed: ${refusals.join('; ')}`);
  await prepareSend(ctx, symbol, sp);
  const results = await pair.trader.openInChunks({ size, longIndex: 1, reason: `pair-mainnet: carry ${symbol}, short hyperliquid, long phoenix`, maker: { index: 0 } });
  for (const r of results) printResult('open', r);
  finish(pair);
}

async function close(ctx: Ctx): Promise<void> {
  const symbolArg = ctx.args.positional[0];
  if (symbolArg === undefined) throw new UsageError('close needs <symbol>');
  const symbol = symbolArg.toUpperCase();
  const pair = await buildPair(ctx, symbol, num(ctx.args, '--slippage-bps', 50), makerSettings(ctx.args));
  const [hlPos, pxPos, sp, lamports] = await Promise.all([pair.hl.position(), pair.phoenix.position(), storedPrice(ctx, symbol), ctx.chain.balance(ctx.sol.authority)]);
  say(`positions hyperliquid ${symbol} ${signedQtyString(hlPos)}, phoenix ${symbol} ${signedQtyString(pxPos)}${hlPos + pxPos === 0n ? ' (hedged)' : ' (NOT offsetting)'}`);
  say(`order     both reduce-only: Hyperliquid post-only at the touch then IOC, then Phoenix IOC for what it closed; the rest by IOC`);
  say(`price     stored ${symbol} ${sp === null ? 'none' : `${sp.px}, ${Math.round(sp.ageS)} s old`}`);
  const refusals: string[] = [];
  if (hlPos === 0n && pxPos === 0n) refusals.push('nothing to close: both legs are flat');
  const solNeed = 2 * ORDER_TX_LAMPORTS + SYSTEM_ACCOUNT_RENT_LAMPORTS;
  if (pxPos !== 0n && lamports < solNeed) refusals.push(`the desk authority holds ${solText(lamports)}; closing on Phoenix needs ${solText(solNeed)}: send ${solText(solNeed - lamports)}`);
  if (!ctx.args.send) {
    for (const r of refusals) say(`would refuse at --send: ${r}`);
    say('\ndry run: nothing was signed or sent. Add --send, from the main checkout, to close the pair.');
    if (refusals.length > 0) process.exitCode = 1;
    return;
  }
  if (refusals.length > 0) throw new Error(`close --send refused, nothing signed: ${refusals.join('; ')}`);
  await prepareSend(ctx, symbol, sp);
  printResult('close', await pair.trader.close({ reason: `pair-mainnet: close ${symbol}`, maker: { index: 0 } }));
  finish(pair);
}

/** Before the first order: a fresh stored price (refresh_prices) and the builder fee approved on Hyperliquid. */
async function prepareSend(ctx: Ctx, symbol: string, sp: { ageS: number } | null): Promise<void> {
  const maxAge = ctx.desk.policy.oracle_max_age_s;
  if (sp === null || sp.ageS > maxAge - 60) {
    say(`refresh   the stored ${symbol} price is ${sp === null ? 'missing' : `${Math.round(sp.ageS)} s old`}: refresh_prices`);
    say(`          ${refs(await ctx.client.refreshPrices([symbol], { maxAgeS: maxAge - 60 }))}`);
  }
  const builder = ctx.config.treasury?.hl_builder;
  const tenth = ctx.config.fees?.hl_builder_tenth_bps;
  if (builder !== undefined && tenth !== undefined && tenth > 0) {
    const approved = await hlInfo<number>(ctx, { type: 'maxBuilderFee', user: ctx.desk.evm_address.toLowerCase(), builder: builder.toLowerCase() });
    if (!(Number(approved) >= tenth)) {
      const r = await ctx.relayer!.hlApproveBuilderFee();
      say(`builder   fee approved: ${refs(r.tx)}`);
    }
  }
}

function printCarry(
  symbol: string, legUsd: number, leverage: number, holdDays: number, plan: CarryPlan, short: CarryLegInput, long: CarryLegInput,
  book: { hlBid: number; hlAsk: number; pxBid: number; pxAsk: number },
): void {
  const rate = (r: number) => `${(r * 100).toFixed(5)} %/h (${pct(r * 8760)} APR)`;
  say(`window    ${symbol}, ${usd(legUsd)} a leg, hold ${holdDays} d, ${leverage}x`);
  say(`          hyperliquid (short) funding now ${rate(short.ratePerHour)}, 7-day mean ${rate(short.rate7dPerHour)}; book ${book.hlBid} / ${book.hlAsk}`);
  say(`          phoenix (long)      funding now ${rate(long.ratePerHour)}, 7-day mean ${rate(long.rate7dPerHour)}; book ${book.pxBid} / ${book.pxAsk}`);
  say(`          gross APR now ${pct(plan.grossAprNow)}, 7-day ${pct(plan.grossApr7d)} (short receives, long pays)`);
  say(`spread    expected over ${holdDays} d at the 7-day mean: ${usd(plan.expectedSpreadUsd)}`);
  say(`          round trip ${plan.roundTripBps.toFixed(2)} bps = ${usd(plan.roundTripUsd)}: taker ${short.takerBps} + ${long.takerBps} bps each way, half spreads ${short.halfSpreadBps.toFixed(2)} + ${long.halfSpreadBps.toFixed(2)} bps each way, basis buffer`);
  say(`          ${plan.expectedSpreadUsd > plan.roundTripUsd ? 'covers the round trip' : 'does NOT cover the round trip'}`);
  for (const [i, l] of plan.legs.entries()) {
    const src = i === 0 ? short : long;
    say(`leg       ${l.venue} ${l.side}: collateral ${usd(l.collateralUsd)} needed, equity ${usd(src.equityUsd)}, maintenance rate ${pct(src.maintenanceRate)}, liquidation ${pct(l.liquidationDistance)} away (must be > 40 %)`);
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

/** What stays open when the process ends: an unhedged pair, or an order with no answer that may still run. */
function finish(pair: Pair): void {
  pair.trader.stop();
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

// LAMPORTS_PER_SOL and ContractClient stay imported for the types the plan prints and the relayer takes.
void LAMPORTS_PER_SOL;
export type { ContractClient };
