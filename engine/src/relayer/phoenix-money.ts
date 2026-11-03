// Money in and out of Phoenix for a desk, each step one legacy message signed by `sol_sign`:
//   in:  the desk USDC account -> Ember wrap to PhUSD -> Phoenix deposit_funds   (phoenix-tx.ts depositMessage)
//   out: Phoenix withdraw_funds -> Ember unwrap -> the desk USDC account, then the Revoke (phoenix-withdraw.ts)
// A plan reads what the step needs (the trader registered, the USDC or the free collateral, the SOL for fees and
// token-account rent), builds the message on a fresh blockhash and simulates it unsigned (sigVerify off), so a dry
// run shows the exact bytes and what the chain would do without any signature. Sending goes through
// Relayer.solSign: the contract checks the message against the policy, the MPC network signs it, and it is sent and
// confirmed (or NothingExecuted / OutcomeUnknown with the signature).
//
// SOL: the desk authority pays every transaction (5,000 lamports a signature plus the priority fee) and the rent of a
// token account it creates (2,039,280 lamports each), and must keep the system account's rent-exempt minimum
// (890,880 lamports). A step whose SOL is short is refused with the amount to send.

import type { TxRef } from '@gimbal/shared';
import type { SolanaMessageBuilder } from './relayer.ts';
import type { ComputeBudget } from './phoenix-tx.ts';
import { MONEY_COMPUTE_UNITS, ORDER_COMPUTE_UNITS, ORDER_PRIORITY_MICROLAMPORTS, PHOENIX_MAINNET, depositMessage, priorityFeeLamports } from './phoenix-tx.ts';
import type { DeskSolanaAccounts, PhoenixExchangeAccounts } from './phoenix-withdraw.ts';
import { withdrawMessage } from './phoenix-withdraw.ts';
import { parseMessage } from './solana.ts';

export const LAMPORTS_PER_SOL = 1_000_000_000;
/** Solana's fee per signature; every desk message has one. */
export const SIGNATURE_FEE_LAMPORTS = 5_000;
/** Rent of an SPL token account (165 bytes), what an idempotent create costs when the account does not exist. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;
/** The rent-exempt minimum of a system account with no data: the authority must keep it. */
export const SYSTEM_ACCOUNT_RENT_LAMPORTS = 890_880;

const MONEY_BUDGET: ComputeBudget = { units: MONEY_COMPUTE_UNITS, microLamports: ORDER_PRIORITY_MICROLAMPORTS };
const ORDER_BUDGET: ComputeBudget = { units: ORDER_COMPUTE_UNITS, microLamports: ORDER_PRIORITY_MICROLAMPORTS };

/** What one message costs the authority at most: the signature and the full priority fee of its budget. */
export function txCostLamports(budget: ComputeBudget): number {
  return SIGNATURE_FEE_LAMPORTS + priorityFeeLamports(budget);
}
export const MONEY_TX_LAMPORTS = txCostLamports(MONEY_BUDGET);
export const ORDER_TX_LAMPORTS = txCostLamports(ORDER_BUDGET);

/** The Solana JSON-RPC reads the money steps and the Phoenix leg use. */
export interface SolanaChain {
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  balance(address: string): Promise<number>;
  /** A token account's balance in base units, null when the account does not exist. */
  tokenBalance(address: string): Promise<bigint | null>;
  accountExists(address: string): Promise<boolean>;
  /** The message simulated unsigned against the current state (a dry run). */
  simulate(message: Uint8Array): Promise<Simulation>;
  /** The slot a signature landed in, or null when the node has not seen it. */
  signatureSlot(signature: string): Promise<number | null>;
  /** The chain's confirmed slot now (getSlot). */
  currentSlot?(): Promise<number>;
}

export interface Simulation {
  err: unknown;
  unitsConsumed: number | null;
  logs: string[];
}

export function solanaChain(rpcUrl: string, fetchImpl: typeof fetch = fetch): SolanaChain {
  let id = 0;
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`solana ${method}: HTTP ${res.status}`);
    const body = await res.json() as { result?: T; error?: { message?: string } };
    if (body.error !== undefined || body.result === undefined) throw new Error(`solana ${method}: ${body.error?.message ?? 'no result'}`);
    return body.result;
  };
  return {
    latestBlockhash: async () => {
      const { value } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },
    balance: async (address) => (await rpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }])).value,
    tokenBalance: async (address) => {
      const info = await rpc<{ value: unknown }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
      if (info.value === null) return null;
      const { value } = await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [address, { commitment: 'confirmed' }]);
      return BigInt(value.amount);
    },
    accountExists: async (address) => (await rpc<{ value: unknown }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }])).value !== null,
    simulate: async (message) => {
      // One empty signature: with sigVerify off the node runs the message as it stands.
      const tx = Buffer.concat([Buffer.of(1), Buffer.alloc(64), Buffer.from(message)]).toString('base64');
      const { value } = await rpc<{ value: { err: unknown; logs?: string[] | null; unitsConsumed?: number } }>('simulateTransaction', [
        tx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' },
      ]);
      return { err: value.err ?? null, unitsConsumed: value.unitsConsumed ?? null, logs: value.logs ?? [] };
    },
    signatureSlot: async (signature) => {
      const { value } = await rpc<{ value: ({ slot?: number } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const slot = value[0]?.slot;
      return typeof slot === 'number' ? slot : null;
    },
    currentSlot: () => rpc<number>('getSlot', [{ commitment: 'confirmed' }]),
  };
}

/** What a step needs and has: the refusals say what is missing; empty when it can go. */
export interface MoneyPlan {
  kind: 'deposit' | 'withdraw';
  amount: bigint;                          // USDC base units (1e-6)
  message: Uint8Array;
  lastValidBlockHeight: number;
  solLamports: number;
  solNeededLamports: number;
  refusals: string[];
  notes: string[];
  simulation: Simulation | null;
}

export interface MoneyContext {
  chain: SolanaChain;
  desk: DeskSolanaAccounts;
  exchange?: PhoenixExchangeAccounts;
  /** The trader PDA's state on Phoenix ('uninitialized' until sol_sign_register ran), from the trader snapshot. */
  traderState?: () => Promise<string | null>;
  /** Phoenix collateral the trader could withdraw now, USDC base units (the cross subaccount's withdrawable). */
  withdrawable?: () => Promise<bigint>;
}

/** SOL the authority needs for one message that may create `creates` token accounts, plus the reserve. */
export function solNeeded(txLamports: number, creates: number): number {
  return txLamports + creates * TOKEN_ACCOUNT_RENT_LAMPORTS + SYSTEM_ACCOUNT_RENT_LAMPORTS;
}

export function solText(lamports: number): string {
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
}

export function usdcText(base: bigint): string {
  const neg = base < 0n;
  const v = neg ? -base : base;
  return `${neg ? '-' : ''}${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0')}`;
}

/** A USDC decimal ("15", "15.5") in base units; more than 6 decimals or not a number is refused. */
export function parseUsdc(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (m === null) throw new Error(`not a USDC amount (up to 6 decimals): ${JSON.stringify(text)}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

async function common(ctx: MoneyContext): Promise<{ sol: number; refusals: string[]; notes: string[] }> {
  const refusals: string[] = [];
  const notes: string[] = [];
  const [sol, traderExists, state] = await Promise.all([
    ctx.chain.balance(ctx.desk.authority),
    ctx.chain.accountExists(ctx.desk.traderAccount),
    ctx.traderState?.() ?? Promise.resolve(null),
  ]);
  if (!traderExists || state === 'uninitialized') {
    refusals.push(`the desk's Phoenix trader ${ctx.desk.traderAccount} is not registered${state === null ? '' : ` (state ${state})`}: run the Phoenix registration (setup/phoenix.ts, sol_sign_register) first`);
  } else if (state !== null) {
    notes.push(`Phoenix trader ${ctx.desk.traderAccount}: ${state}`);
  }
  return { sol, refusals, notes };
}

/** A deposit of `amount` USDC from the desk USDC account into Phoenix, checked and simulated (nothing signed). */
export async function planDeposit(ctx: MoneyContext, amount: bigint): Promise<MoneyPlan> {
  if (amount <= 0n) throw new Error('the deposit amount must be above 0');
  const exchange = ctx.exchange ?? PHOENIX_MAINNET;
  const { sol, refusals, notes } = await common(ctx);
  const [usdc, phusd] = await Promise.all([ctx.chain.tokenBalance(ctx.desk.usdcAta), ctx.chain.tokenBalance(ctx.desk.phusdAta)]);
  if (usdc === null) refusals.push(`the desk USDC account ${ctx.desk.usdcAta} does not exist: send USDC to the desk authority's USDC account first`);
  else if (usdc < amount) refusals.push(`the desk USDC account holds ${usdcText(usdc)} USDC, under the ${usdcText(amount)} asked`);
  else notes.push(`desk USDC account ${ctx.desk.usdcAta}: ${usdcText(usdc)} USDC`);
  const creates = phusd === null ? 1 : 0;
  const need = solNeeded(MONEY_TX_LAMPORTS, creates);
  if (sol < need) refusals.push(`the desk authority ${ctx.desk.authority} holds ${solText(sol)}; a deposit needs ${solText(need)} (fees${creates > 0 ? ', the PhUSD account rent' : ''} and the rent-exempt reserve): send ${solText(need - sol)} more`);
  const { blockhash, lastValidBlockHeight } = await ctx.chain.latestBlockhash();
  const message = depositMessage(exchange, ctx.desk, amount, blockhash);
  return finish({ kind: 'deposit', amount, message, lastValidBlockHeight, solLamports: sol, solNeededLamports: need, refusals, notes, simulation: null }, ctx);
}

/** A withdrawal of `amount` (or all the trader can withdraw) out of Phoenix back to the desk USDC account. */
export async function planWithdraw(ctx: MoneyContext, amount: bigint | 'all'): Promise<MoneyPlan> {
  const exchange = ctx.exchange ?? PHOENIX_MAINNET;
  const { sol, refusals, notes } = await common(ctx);
  const free = refusals.length === 0 && ctx.withdrawable !== undefined ? await ctx.withdrawable() : null;
  const want = amount === 'all' ? free ?? 0n : amount;
  if (free !== null) notes.push(`Phoenix withdrawable now: ${usdcText(free)} USDC`);
  if (want <= 0n) refusals.push(amount === 'all' ? 'nothing to withdraw: the trader has no free collateral' : 'the withdrawal amount must be above 0');
  else if (free !== null && want > free) refusals.push(`${usdcText(want)} USDC asked, but Phoenix lets the trader withdraw ${usdcText(free)} now`);
  const [usdc, phusd] = await Promise.all([ctx.chain.tokenBalance(ctx.desk.usdcAta), ctx.chain.tokenBalance(ctx.desk.phusdAta)]);
  const creates = (usdc === null ? 1 : 0) + (phusd === null ? 1 : 0);
  const need = solNeeded(MONEY_TX_LAMPORTS, creates);
  if (sol < need) refusals.push(`the desk authority ${ctx.desk.authority} holds ${solText(sol)}; a withdrawal needs ${solText(need)}: send ${solText(need - sol)} more`);
  const { blockhash, lastValidBlockHeight } = await ctx.chain.latestBlockhash();
  const message = withdrawMessage(exchange, ctx.desk, want > 0n ? want : 1n, blockhash);
  return finish({ kind: 'withdraw', amount: want, message, lastValidBlockHeight, solLamports: sol, solNeededLamports: need, refusals, notes, simulation: null }, ctx);
}

async function finish(plan: MoneyPlan, ctx: MoneyContext): Promise<MoneyPlan> {
  const m = parseMessage(plan.message);
  if (m.signers !== 1 || m.keys[0] !== ctx.desk.authority) throw new Error(`the ${plan.kind} message is not signed by the desk authority alone`);
  // A simulation of a step that is refused anyway still shows what the chain says; it never signs anything.
  // A step whose simulation fails, or could not be run, is refused: the chain would most likely fail it too, and the
  // fee would be paid for nothing.
  try {
    plan.simulation = await ctx.chain.simulate(plan.message);
  } catch (err) {
    plan.refusals.push(`the ${plan.kind} could not be simulated (${(err as Error).message}): nothing is signed unsimulated`);
  }
  if (plan.simulation !== null && plan.simulation.err !== null) {
    plan.refusals.push(`the ${plan.kind} fails in simulation (${JSON.stringify(plan.simulation.err)}): see the logs`);
  }
  return plan;
}

/** The plan's message as a SolanaMessageBuilder: built again on a fresh blockhash when the relayer asks for another. */
export function planBuilder(plan: MoneyPlan, rebuild: (blockhash: string) => Uint8Array, chain: SolanaChain): SolanaMessageBuilder {
  let first = true;
  return async () => {
    if (first) {
      first = false;
      return { messageB64: Buffer.from(plan.message).toString('base64'), lastValidBlockHeight: plan.lastValidBlockHeight };
    }
    const { blockhash, lastValidBlockHeight } = await chain.latestBlockhash();
    return { messageB64: Buffer.from(rebuild(blockhash)).toString('base64'), lastValidBlockHeight };
  };
}

/** Sends a plan with no refusals through sol_sign; the TxRefs are the NEAR signature, then the Solana transaction. */
export async function sendPlan(
  plan: MoneyPlan, ctx: MoneyContext, relayer: { solSign(build: SolanaMessageBuilder, reason: string): Promise<TxRef[]> }, reason: string,
): Promise<TxRef[]> {
  if (plan.refusals.length > 0) throw new Error(`the ${plan.kind} is refused, nothing signed: ${plan.refusals.join('; ')}`);
  const exchange = ctx.exchange ?? PHOENIX_MAINNET;
  const rebuild = plan.kind === 'deposit'
    ? (hash: string) => depositMessage(exchange, ctx.desk, plan.amount, hash)
    : (hash: string) => withdrawMessage(exchange, ctx.desk, plan.amount, hash);
  return relayer.solSign(planBuilder(plan, rebuild, ctx.chain), reason);
}
