// The carry pair on mainnet: short Hyperliquid, long Phoenix, every order signed by the contract (hl_order and
// sol_sign), and the Phoenix money moves that go with it. A dry run by default: it reads everything, builds and
// simulates what it would sign, prints the plan, and signs nothing. --send acts; it refuses in a linked git worktree.
//
//   node --env-file=<engine env file> engine/src/cli/pair-mainnet.ts <command> [--send]
//     status
//     fund-phoenix <usdc>                   desk USDC account -> Ember wrap -> Phoenix deposit (one sol_sign)
//     defund-phoenix <usdc|all>             Phoenix withdraw -> Ember unwrap -> desk USDC account (one sol_sign)
//     open <symbol> <legUsd> --short hyperliquid --long phoenix [--leverage 2] [--hold-days 7] [--basis-bps 10]
//          [--slippage-bps 50] [--reprice-s 30] [--maker-timeout-s 120] [--max-orders 6] [--taker-fallback]
//          [--priority-microlamports 100000]
//     close <symbol> [the same order options]
//
// The env file holds the engine's names (GIMBAL_CONTRACT_ID, DESK_ID, OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY,
// NEAR_RPC_URL, HL_API_URL, PHOENIX_API_URL, SOLANA_RPC_URL); values are never printed, and the key is read only
// with --send.
//
// Open goes maker first: the Hyperliquid short as post-only limits at the touch, placed at most every --reprice-s
// (30 s or more, a crossing refusal included) and at most --max-orders times per open or close, over all its parts
// (6 or fewer: from C10 the contract meters signed notional that is not reduce-only per rolling hour, and every
// reprice is signed again), for at most --maker-timeout-s; an IOC for the rest only with --taker-fallback. Then the
// Phoenix long as one IOC for what filled. Close mirrors it, reduce-only (what the maker leg leaves goes to the close's
// IOC retry). A stored price is the oracle's timestamp less its 600 s recency, so one fresh from refresh_prices lives
// oracle_max_age_s - 600 s (300 s at 900): the maker timeout plus 120 s must fit that. The price is refreshed (only
// once the refusals are checked) before each part when it would not outlive that, and whenever an order (an unwind,
// a close) finds it stale; never twice within 30 s.
//
// Before an open the plan prints both legs' funding now and over 7 days, the gross APR, the spread expected over the
// hold against the round trip (taker fees, half spreads, basis buffer), the size, the leverage and liquidation
// distance per leg, and simulates the Phoenix IOC unsigned. It refuses when the spread does not cover the round trip,
// a leg is 40 % or less from liquidation, a leg's effective leverage ((open notional + legUsd) / equity) is over the
// asked leverage (at most 2x) or its venue's cap (1.5x without a live rescue, carry-plan.ts LIVE_RESCUE), the
// Hyperliquid coin is in isolated margin or has a resting order (an earlier run's could fill outside the pair), legUsd
// is over the policy cap less the band, or the simulation fails.
//
// Hyperliquid leverage: the contract has no update-leverage action (its Hyperliquid actions are hl_order, hl_cancel,
// hl_set_referrer, hl_approve_builder_fee, hl_usd_class_transfer, hl_withdraw, hl_send_to_intents), so the desk
// trades at the leverage its Hyperliquid account already has for the coin; what is checked is the effective leverage.
//
// An outcome that cannot be proven ends with `open:` lines naming what to reconcile and by which ids; exit code 3.
// A post-only order left without a settled state is cancelled by its id once more before the process ends; both legs
// are then read again, Phoenix is brought back against Hyperliquid by one IOC when a late fill left it off, and what
// stays unhedged is printed exactly.
//
// The open and close are pair-ops.ts, which serve's strategy loop runs too (serve-pair.ts).

import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TxRef } from '@gimbal/shared';
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
import { ORDER_COMPUTE_UNITS, ORDER_PRIORITY_MICROLAMPORTS } from '../relayer/phoenix-tx.ts';
import type { DeskSolanaAccounts } from '../relayer/phoenix-withdraw.ts';
import { Relayer } from '../relayer/relayer.ts';
import { SolanaSubmitter, parseMessage } from '../relayer/solana.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import { MAX_LEVERAGE, usd, venueMaxLeverage } from '../trade/carry-plan.ts';
import type { TraderLock } from '../trade/trader-state.ts';
import { acquireTraderLock, lockHolder, traderLockPath } from '../trade/trader-state.ts';
import { HL_MAINNET_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import { PHOENIX_API_URL, PhoenixReader, SOLANA_MAINNET_RPC_URL } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Args, PriceDeps } from './pair-mainnet-lib.ts';
import { UsageError, newPriceState, num, orderOptions, parseArgs, refreshLanded, withdrawKeepsLegs } from './pair-mainnet-lib.ts';
import type { OpsCtx } from './pair-ops.ts';
import {
  ORDERS_PER_PART, buildPair, hlInfo, phoenixExchange, planClose, planOpen, policyMarketMismatches, refs, sendClose, sendOpen, storedPrice, traderState,
} from './pair-ops.ts';
import { checkContractNetwork, contractEnv } from './serve-contract.ts';

const USAGE = `usage: node --env-file=<engine env> engine/src/cli/pair-mainnet.ts <command> [--send]
  status
  fund-phoenix <usdc>
  defund-phoenix <usdc|all>
  open <symbol> <legUsd> --short hyperliquid --long phoenix [--leverage 2] [--hold-days 7] [--basis-bps 10] [--slippage-bps 50]
       [--reprice-s 30] [--maker-timeout-s 120] [--max-orders 6] [--taker-fallback] [--priority-microlamports 100000]
  close <symbol> [--slippage-bps 50] [--reprice-s 30] [--maker-timeout-s 120] [--max-orders 6] [--taker-fallback] [--priority-microlamports 100000]`;

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

/** The library's context (pair-ops.ts) plus the command line. */
interface Ctx extends OpsCtx {
  args: Args;
  client: NearContractClient;
  config: ContractConfigView;
  desk: DeskView;
  deskId: string;
  hl: HyperliquidReader;
  phoenix: PhoenixReader;
  chain: SolanaChain;
  solana: SolanaSubmitter;
  sol: DeskSolanaAccounts;
  prices: PriceDeps;
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
  // One trader per desk: --send holds the lock a serve with GIMBAL_TRADE=1 takes (trade/trader-state.ts) for its whole
  // run, so serve can neither trade next to it nor start in the middle of an open or close and adopt a half-built pair.
  let lock: TraderLock | null = null;
  if (args.send) {
    const path = traderLockPath(envVar, 'mainnet', cfg.contractId, cfg.deskId);
    try {
      lock = acquireTraderLock(path);
      if (lock.tookOver !== null) say(lock.tookOver);
    } catch (err) {
      const holder = lockHolder(path);
      throw new Error(`${holder === null ? 'the trader lock could not be taken' : `serve or another pair-mainnet --send (pid ${holder}) trades desk ${cfg.deskId}`}: ${errorMessage(err)}; stop it first, run this, then start serve again (it adopts the legs from the venues)`);
    }
  }
  try {
    await run(args, cfg, tree);
  } finally {
    lock?.release();
  }
}

async function run(args: Args, cfg: NonNullable<ReturnType<typeof contractEnv>>, tree: boolean): Promise<void> {
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
    phoenix: new PhoenixReader({ apiUrl: phoenixUrl, rpcUrl: solRpcUrl }), phoenixUrl, chain: solanaChain(solRpcUrl), solana, sol, relayer,
    prices: {
      maxAgeS: desk.policy.oracle_max_age_s, send: args.send, read: (symbol) => storedPrice(client, symbol),
      refresh: (symbol, maxAgeS) => client.refreshPrices([symbol], { maxAgeS }), now: () => Date.now(), log: say, ...newPriceState(),
      landed: refreshLanded,
    },
    send: args.send, trading: false, say,
    open: (line, alert = true) => {
      openLines.push(`open:     ${line}`);
      if (alert) process.exitCode = 3;
    },
  };
  if (args.command === 'status') return status(ctx);
  if (args.command === 'fund-phoenix' || args.command === 'defund-phoenix') return money(ctx);
  if (args.command === 'open') return open(ctx);
  return close(ctx);
}

// ---- reads ----

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
    const sp = await storedPrice(ctx.client, symbol);
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
  if (withdraw) {
    const reads = { state: () => traderState(ctx), account: () => ctx.phoenix.account(ctx.sol.authority) };
    plan.refusals.push(...await withdrawKeepsLegs(reads, amountText === 'all', Number(plan.amount) / 1e6));
  }
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
  } else {
    say('simulate  not run');
  }
}

// ---- the pair ----

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
  const pair = await buildPair(ctx, symbol, () => orderOptions(ctx.args));
  const plan = await planOpen(ctx, pair, { symbol, legUsd, leverage, holdDays, basisBps });
  const { refusals } = plan;
  if (!ctx.args.send) {
    for (const r of refusals) say(`would refuse at --send: ${r}`);
    say('\ndry run: nothing was signed or sent. Add --send, from the main checkout, to open the pair.');
    if (refusals.length > 0) process.exitCode = 1;
    return;
  }
  if (refusals.length > 0) throw new Error(`open --send refused, nothing signed: ${refusals.join('; ')}`);
  await sendOpen(ctx, pair, plan);
}

async function close(ctx: Ctx): Promise<void> {
  const symbolArg = ctx.args.positional[0];
  if (symbolArg === undefined) throw new UsageError('close needs <symbol>');
  const symbol = symbolArg.toUpperCase();
  const pair = await buildPair(ctx, symbol, () => orderOptions(ctx.args), true);
  const { refusals } = await planClose(ctx, pair);
  if (!ctx.args.send) {
    for (const r of refusals) say(`would refuse at --send: ${r}`);
    say('\ndry run: nothing was signed or sent. Add --send, from the main checkout, to close the pair.');
    if (refusals.length > 0) process.exitCode = 1;
    return;
  }
  if (refusals.length > 0) throw new Error(`close --send refused, nothing signed: ${refusals.join('; ')}`);
  await sendClose(ctx, pair);
}
