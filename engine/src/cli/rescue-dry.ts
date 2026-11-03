// The two live Phoenix rescue routes, dry, against a mainnet desk: keyless and read-only. For each route it prints the
// plan (what the rescuer would send for a margin need), 1Click's dry quote, the message the engine would ask the
// contract to sign (simulated unsigned on Solana) and every refusal the live rescuer would raise. Signs nothing,
// sends nothing, loads no key; a dry quote opens no deposit address.
//
//   npm run rescue-dry -w engine -- --mainnet --contract <id> --desk <id> [--need <usd>] [--env-file <file>]
//
//   Phoenix -> Hyperliquid  sol_sign_rescue: Solana USDC to 1Click for HyperCore USDC (rescue/sol-rescue.ts payer);
//   reserve -> Phoenix      fund_venue: NEAR USDC to 1Click for the desk authority's Solana USDC, then the sol_sign
//                           deposit into Phoenix (rescue/sol-rescue.ts credit).
// A dry quote has no deposit address, so the Solana message is built for a placeholder deposit owner (the contract's
// vector one); everything else is the desk's own state. Exit code 0: printed (refusals included); 2: could not read.

import { parseArgs } from 'node:util';
import { NearContractClient } from '../contract/near-client.ts';
import { NearViewTransport } from '../contract/near-transport.ts';
import type { DeskView } from '../contract/types.ts';
import type { MoneyContext } from '../relayer/phoenix-money.ts';
import { planDeposit, solText, solanaChain, usdcText } from '../relayer/phoenix-money.ts';
import { parseMessage } from '../relayer/solana.ts';
import { ASSETS, HYPERCORE_MIN_E8, HttpOneClick, unitsOf } from '../rescue/oneclick.ts';
import type { QuoteRequest } from '../rescue/oneclick.ts';
import { SLIPPAGE_BPS, amountInFor } from '../rescue/plan.ts';
import { phoenixDeskOf, routeLines } from '../rescue/serve-rescue.ts';
import { PhoenixDeskCredit, planPhoenixRescue } from '../rescue/sol-rescue.ts';
import { RpcSolanaReads } from '../rescue/solana-chain.ts';
import { parseTraderSnapshot, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import { PHOENIX_API_URL, PhoenixReader, SOLANA_MAINNET_RPC_URL } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import { checkContractNetwork } from './serve-contract.ts';

/** The contract's vector deposit owner (solana.json): a placeholder for the deposit address a dry quote does not give. */
const PLACEHOLDER_OWNER = 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf';

const say = (line: string) => console.log(line);

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`rescue-dry: ${errorMessage(err)}`);
  process.exitCode = 2;
}
setTimeout(() => process.exit(), 300).unref();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { mainnet: { type: 'boolean' }, contract: { type: 'string' }, desk: { type: 'string' }, need: { type: 'string' }, 'env-file': { type: 'string' } },
  });
  if (values.mainnet !== true) throw new Error('usage: npm run rescue-dry -w engine -- --mainnet --contract <id> --desk <id> [--need <usd>] [--env-file <file>]');
  if (values['env-file'] !== undefined) process.loadEnvFile(values['env-file']);
  const env = (name: string): string | undefined => {
    const v = process.env[name];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const contractId = values.contract ?? env('GIMBAL_CONTRACT_ID');
  const deskId = values.desk ?? env('DESK_ID');
  if (contractId === undefined || deskId === undefined) throw new Error('name the desk: --contract and --desk (or GIMBAL_CONTRACT_ID and DESK_ID)');
  const needUsd = Number(values.need ?? '5');
  if (!(needUsd > 0)) throw new Error('--need is a margin need in USD above 0');
  const nearRpc = env('NEAR_RPC_URL');
  const client = new NearContractClient({ contractId, network: 'mainnet', transport: new NearViewTransport({ network: 'mainnet', ...(nearRpc === undefined ? {} : { rpcUrl: nearRpc }) }) });
  checkContractNetwork(contractId, await client.config(), 'mainnet');
  const desk = await client.getDesk(deskId);
  if (desk === null) throw new Error(`${contractId} has no desk ${deskId}`);
  const solRpc = env('SOLANA_RPC_URL') ?? SOLANA_MAINNET_RPC_URL;
  const chain = solanaChain(solRpc);
  const phoenixApi = env('PHOENIX_API_URL') ?? PHOENIX_API_URL;
  const pd = phoenixDeskOf(desk);
  const a = pd.accounts;
  const p = desk.policy;
  const flatUsd = p.max_transfer_cost_flat_e6 / 1e6;
  say(`rescue-dry ${contractId} desk ${deskId} at ${new Date().toISOString()}: keyless, read-only, nothing signed or sent`);
  say(`desk      ${desk.paused ? 'PAUSED' : 'running'}${desk.closing === true ? ', CLOSING' : ''}; operator ${desk.operator === null ? 'none set' : 'set'}; reserve ${usdcText(BigInt(desk.ledger.idle_usdc))} USDC`);
  say(`policy    rescue cap ${p.rescue_cap_usd_per_hour} USD/h; transfer cost at most max(${p.max_transfer_cost_bps} bps, ${flatUsd.toFixed(2)} USDC)`);
  const [lamports, usdc, phusd, traderExists] = await Promise.all([chain.balance(a.authority), chain.tokenBalance(a.usdcAta), chain.tokenBalance(a.phusdAta), chain.accountExists(a.traderAccount)]);
  const state = await phoenixTraderApi(phoenixApi).traderState(a.authority).then((raw) => parseTraderSnapshot(raw, '').state, (err: unknown) => `unread (${errorMessage(err)})`);
  say(`solana    authority ${a.authority}: ${solText(lamports)}`);
  say(`          USDC account ${a.usdcAta}: ${usdc === null ? 'does not exist' : `${usdcText(usdc)} USDC`}; PhUSD account ${a.phusdAta}: ${phusd === null ? 'does not exist' : `${usdcText(phusd)} PhUSD`}`);
  say(`          Phoenix trader ${a.traderAccount}: ${traderExists ? 'account exists' : 'no account'}, state ${state ?? 'unknown'}`);
  const history = await new RpcSolanaReads({ rpcUrl: solRpc }).historyProblem();
  const rpcName = env('SOLANA_RPC_URL') === undefined ? 'public Solana mainnet RPC' : 'SOLANA_RPC_URL';
  say(`history   ${rpcName}: ${history === null ? 'serves getSignatureStatuses with transaction history (the Solana hold rule can run)' : `NO: ${history}`}`);
  for (const line of routeLines('mainnet', true, history === null ? null : `the ${rpcName} serves no history`)) say(line);
  const oneClick = new HttpOneClick({ apiKey: env('ONECLICK_API_KEY') ?? null });
  const keyed = env('ONECLICK_API_KEY') !== undefined;

  // ---- Phoenix -> Hyperliquid ----
  say('');
  say(`route     Phoenix -> Hyperliquid (sol_sign_rescue), for ${needUsd.toFixed(2)} USD of margin on Hyperliquid`);
  const inA = amountInFor('phoenix', 'hyperliquid', needUsd, keyed);
  const refusalsA: string[] = [];
  if (history !== null) refusalsA.push(`the Solana RPC serves no history: ${history}`);
  const qa = await dryQuote(oneClick, ASSETS.solanaUsdc, ASSETS.hypercoreUsdc, inA, a.authority, desk.evm_address);
  say(`plan      send ${inA.toFixed(2)} USDC from Phoenix (fees and ${SLIPPAGE_BPS} bps slippage room on top of the need)`);
  if (qa.ok) {
    say(`quote     ${qa.line}`);
    if (qa.minOutE8 < HYPERCORE_MIN_E8) refusalsA.push(`minAmountOut ${Number(qa.minOutE8) / 1e8} is under the ${Number(HYPERCORE_MIN_E8) / 1e8} USDC 1Click delivers into HyperCore`);
    costCheck(qa.costUsd, inA, p, refusalsA);
    if (inA > p.rescue_cap_usd_per_hour) refusalsA.push(`${inA.toFixed(2)} USD is over the ${p.rescue_cap_usd_per_hour} USD/h rescue cap`);
  } else {
    refusalsA.push(`1Click gives no quote: ${qa.message}`);
  }
  const reader = new PhoenixReader({ apiUrl: phoenixApi, rpcUrl: solRpc });
  try {
    const plan = await planPhoenixRescue({
      chain, desk: async () => pd,
      withdrawable: async () => {
        if (!traderExists || state === 'uninitialized') throw new Error(`the trader ${a.traderAccount} is not registered`);
        return BigInt(Math.floor((await reader.account(a.authority)).freeMarginUsd * 1e6));
      },
    }, PLACEHOLDER_OWNER, unitsOf(inA, ASSETS.solanaUsdc));
    const m = parseMessage(plan.message);
    say(`message   ${plan.kind}: ${plan.message.length + 65} bytes, ${m.instructions.length} instructions, limit ${m.computeUnitLimit ?? 'none'} CU at ${m.computeUnitPrice ?? 0n} µlamports; `
      + `withdraw ${usdcText(plan.withdrawE6)} from Phoenix, pay ${usdcText(plan.deposit.amountIn)} to the deposit owner's USDC account (placeholder owner)`);
    say(`          SOL needed ${solText(plan.solNeededLamports)}, held ${solText(plan.solLamports)}; simulation ${plan.simulation === null ? 'not run' : plan.simulation.err === null ? `ok, ${plan.simulation.unitsConsumed ?? '?'} CU` : `failed ${JSON.stringify(plan.simulation.err)}`}`);
    for (const n of plan.notes) say(`          ${n}`);
    refusalsA.push(...plan.refusals);
  } catch (err) {
    refusalsA.push(`the message could not be built: ${errorMessage(err)}`);
  } finally {
    reader.close();
  }
  verdict(refusalsA);

  // ---- reserve -> Phoenix ----
  say('');
  say(`route     reserve -> Phoenix (fund_venue, then a sol_sign deposit), for ${needUsd.toFixed(2)} USD of margin on Phoenix`);
  const inB = amountInFor('reserve', 'phoenix', needUsd, keyed);
  const refusalsB: string[] = [];
  if (history !== null) refusalsB.push(`the Solana RPC serves no history: ${history}`);
  say(`plan      fund_venue ${inB.toFixed(2)} USDC of the reserve to 1Click for the desk authority ${a.authority}`);
  if (BigInt(desk.ledger.idle_usdc) < unitsOf(inB, ASSETS.nearUsdc)) refusalsB.push(`the reserve holds ${usdcText(BigInt(desk.ledger.idle_usdc))} USDC, under ${inB.toFixed(2)}`);
  const qb = await dryQuote(oneClick, ASSETS.nearUsdc, ASSETS.solanaUsdc, inB, desk.owner, a.authority);
  let minOutE6 = unitsOf(needUsd, ASSETS.solanaUsdc);
  if (qb.ok) {
    say(`quote     ${qb.line}`);
    costCheck(qb.costUsd, inB, p, refusalsB);
    minOutE6 = qb.minOutE8 / 100n;
  } else {
    refusalsB.push(`1Click gives no quote: ${qb.message}`);
  }
  const traderState = async () => (state !== null && state.startsWith('unread') ? null : state);
  const credit = new PhoenixDeskCredit({
    network: 'mainnet', chain, desk: async () => pd, traderState, clock: { now: () => Date.now() }, sleep: async () => {},
    solSign: async () => {
      throw new Error('rescue-dry signs nothing');
    },
  });
  const ready = await credit.ready().catch((err: unknown) => `readiness unread: ${errorMessage(err)}`);
  say(`ready     ${ready === null ? 'Phoenix can take the delivery (registered trader, running desk, SOL for the deposit)' : `NO: ${ready}`}`);
  if (ready !== null) refusalsB.push(`Phoenix cannot take the delivery: ${ready}`);
  try {
    const ctx: MoneyContext = { chain, desk: a, traderState };
    const dep = await planDeposit(ctx, minOutE6);
    const m = parseMessage(dep.message);
    say(`deposit   sol_sign of ${usdcText(minOutE6)} USDC into Phoenix: limit ${m.computeUnitLimit ?? 'none'} CU at ${m.computeUnitPrice ?? 0n} µlamports (cap 200000); SOL needed ${solText(dep.solNeededLamports)}`);
    say(`          simulation now ${dep.simulation === null ? 'not run' : dep.simulation.err === null ? `ok, ${dep.simulation.unitsConsumed ?? '?'} CU` : `failed ${JSON.stringify(dep.simulation.err)} (before the delivery the USDC is not there yet)`}`);
    for (const r of dep.refusals) say(`          before the delivery: ${r}`);
  } catch (err) {
    refusalsB.push(`the deposit could not be planned: ${errorMessage(err)}`);
  }
  verdict(refusalsB);
  return 0;
}

interface DryQuote {
  ok: true;
  line: string;
  minOutE8: bigint;
  costUsd: number;
}

async function dryQuote(oneClick: HttpOneClick, origin: string, destination: string, amountUsd: number, refundTo: string, recipient: string): Promise<DryQuote | { ok: false; message: string }> {
  const body: QuoteRequest = {
    dry: true, swapType: 'EXACT_INPUT', slippageTolerance: SLIPPAGE_BPS, originAsset: origin, depositType: 'ORIGIN_CHAIN', destinationAsset: destination,
    amount: unitsOf(amountUsd, origin).toString(), refundTo, refundType: 'ORIGIN_CHAIN', recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const answer = await oneClick.quote(body).catch((err: unknown) => ({ ok: false as const, status: 0, message: errorMessage(err) }));
  if (!answer.ok) return { ok: false, message: `${answer.message} (HTTP ${answer.status})` };
  const q = answer.response.quote as unknown as Record<string, string | number | undefined>;
  const outDec = destination === ASSETS.hypercoreUsdc ? 8 : 6;
  const minOut = BigInt(String(q.minAmountOut));
  const minOutE8 = minOut * 10n ** BigInt(8 - outDec);
  const out = Number(q.amountOut) / 10 ** outDec;
  const costUsd = amountUsd - Number(minOutE8) / 1e8;
  return {
    ok: true, minOutE8, costUsd,
    line: `amountIn ${amountUsd.toFixed(2)}, amountOut ${out.toFixed(4)}, minAmountOut ${(Number(minOutE8) / 1e8).toFixed(4)}, cost ${costUsd.toFixed(4)} USDC, `
      + `about ${q.timeEstimate ?? '?'} s (dry: no deposit address, ${answer.response.signature === undefined || answer.response.signature === '' ? 'unsigned' : 'signed'})`,
  };
}

function costCheck(costUsd: number, amountUsd: number, p: DeskView['policy'], refusals: string[]): void {
  const bound = Math.max((amountUsd * p.max_transfer_cost_bps) / 10_000, p.max_transfer_cost_flat_e6 / 1e6);
  if (costUsd > bound) refusals.push(`the cost ${costUsd.toFixed(4)} is over the policy's ${bound.toFixed(4)} USDC`);
}

function verdict(refusals: readonly string[]): void {
  if (refusals.length === 0) say('verdict   would run: nothing in its way');
  else for (const r of refusals) say(`refused   ${r}`);
}
