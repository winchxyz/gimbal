// The live Phoenix routes of the rescue on mainnet (E9): Phoenix as a source (sol_sign_rescue) and Phoenix as a target
// (the delivered Solana USDC deposited into Phoenix with a plain sol_sign).
//
// Phoenix as a source (PhoenixRescuePayer): one Solana transaction out of the desk to the verified 1Click deposit
// address, paid in Solana USDC for HyperCore (or any target 1Click quotes from Solana USDC). prepare() reads the desk's
// Solana accounts and Phoenix, builds one of three messages (relayer/phoenix-withdraw.ts) and simulates it unsigned:
//   spare     the desk's USDC account already holds amountIn: the deposit owner's account and the TransferChecked;
//   withdraw  Phoenix withdraw_funds + Ember unwrap of what the account lacks, then the transfer and the Revoke;
//   paused    a paused desk's lean rescue (no create of a desk account, frees no more than amountIn).
// A message that is refused (no SOL for the fee and the deposit owner's account rent, Phoenix lets less be withdrawn,
// a failed simulation) is never signed. sign() asks sol_sign_rescue for exactly that message and never builds another:
// the contract counts the quote's deposit address once (the deposit ring), so a second message could never be signed,
// and the first stays held until Solana shows it can never land (the rescuer's hold rule, solana-chain.ts).
//
// Phoenix as a target (PhoenixDeskCredit): 1Click delivers Solana USDC to the desk authority (fund_venue from the
// reserve, or any source); credit() confirms that delivery (1Click's destination transaction on Solana, and the
// desk's USDC account holding the amount), then deposits it into Phoenix with sol_sign (relayer/phoenix-money.ts
// planDeposit: the PhUSD wrap and deposit_funds). That deposit is not a rescue: the contract caps its priority price at
// 200,000 µlamports per unit (phoenix.rs MAX_COMPUTE_UNIT_PRICE); it is built at 100,000 and checked before signing.
// The landing is the confirmed deposit transaction (PhoenixDepositLanding). ready() says before anything is paid
// whether a deposit could follow at all (a registered trader, a running desk, SOL for the fee).

import { getAssociatedTokenAccountAddress } from '@ellipsis-labs/rise';
import type { TxRef, VenueId } from '@gimbal/shared';
import type { SignedQuote, SolSignedAction } from '../contract/types.ts';
import { MpcTimeoutError, OutcomeUnknown, solMessageDigest } from '../contract/types.ts';
import type { MoneyContext, Simulation, SolanaChain } from '../relayer/phoenix-money.ts';
import {
  MONEY_TX_LAMPORTS, SIGNATURE_FEE_LAMPORTS, planDeposit, sendPlan, solNeeded, solText, txCostLamports, usdcText,
} from '../relayer/phoenix-money.ts';
import { MAX_PRIORITY_MICROLAMPORTS, PHOENIX_MAINNET } from '../relayer/phoenix-tx.ts';
import type { DeskSolanaAccounts, PhoenixExchangeAccounts, RescueDeposit } from '../relayer/phoenix-withdraw.ts';
import { pausedRescueMessage, rescueMessage, spareRescueMessage } from '../relayer/phoenix-withdraw.ts';
import type { SolanaMessageBuilder } from '../relayer/relayer.ts';
import type { SolanaSendOptions } from '../relayer/solana.ts';
import { SOLANA_COMPUTE_UNITS, SOLANA_PRIORITY_MICROLAMPORTS, SolanaSubmitter, parseMessage } from '../relayer/solana.ts';
import type { ChainNetwork } from '../relayer/tx.ts';
import { solanaTxRef } from '../relayer/tx.ts';
import { asDeskAct } from '../venues/desk-acts.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';
import type { VerifiedQuote } from './oneclick.ts';
import type { CreditOptions, CreditPort, LandingPort, LedgerEntry, Payer, PreparedPayment, SignedPayment } from './rescuer.ts';

/** Solana's largest transaction, bytes: one signature (65) and the message. */
const MAX_TX_BYTES = 1232;
/** A spare-USDC rescue's compute-unit limit: the deposit owner's account create and one transfer use about 30k. */
export const SPARE_RESCUE_UNITS = 100_000;

/** The desk as the Phoenix routes read it: its Solana accounts (get_desk) and whether it is paused. */
export interface PhoenixDesk {
  accounts: DeskSolanaAccounts;
  paused: boolean;
}

export interface PhoenixRescueOptions {
  chain: SolanaChain;
  desk: () => Promise<PhoenixDesk>;
  /**
   * Phoenix collateral the trader may withdraw now, USDC base units (throws when the trader cannot be read). Serve
   * passes the reader's freeMarginUsd, an approximation: a withdraw it overstates fails the unsigned simulation below,
   * and a failed simulation is a refusal, so nothing is signed on it.
   */
  withdrawable: () => Promise<bigint>;
  exchange?: PhoenixExchangeAccounts;
}

/** What a Phoenix rescue would sign: the message, what it moves and why it is refused (empty: it may be signed). */
export interface PhoenixRescuePlan {
  kind: 'spare' | 'withdraw' | 'paused';
  deposit: RescueDeposit;
  /** USDC already on the desk's USDC account (null: the account does not exist). */
  spareE6: bigint | null;
  /** What Phoenix withdraws (0: none). */
  withdrawE6: bigint;
  freeE6: bigint | null;
  message: Uint8Array;
  lastValidBlockHeight: number;
  solLamports: number;
  solNeededLamports: number;
  simulation: Simulation | null;
  refusals: string[];
  notes: string[];
}

/** The deposit owner's USDC account: its associated token account for the mint. */
export async function usdcAccountOf(owner: string, mint = PHOENIX_MAINNET.usdcMint): Promise<string> {
  return await getAssociatedTokenAccountAddress(owner as Parameters<typeof getAssociatedTokenAccountAddress>[0], mint as Parameters<typeof getAssociatedTokenAccountAddress>[1]) as string;
}

/**
 * The Phoenix rescue that pays `amountIn` (USDC base units) to the 1Click deposit address `owner`, built and simulated
 * unsigned. Read-only: the dry run prints it, the payer signs it when it has no refusals.
 */
export async function planPhoenixRescue(o: PhoenixRescueOptions, owner: string, amountIn: bigint): Promise<PhoenixRescuePlan> {
  if (amountIn <= 0n) throw new Error('a rescue pays more than 0');
  const exchange = o.exchange ?? PHOENIX_MAINNET;
  const [desk, hash] = await Promise.all([o.desk(), o.chain.latestBlockhash()]);
  const acc = desk.accounts;
  const deposit: RescueDeposit = { owner, usdcAta: await usdcAccountOf(owner, exchange.usdcMint), amountIn };
  const [sol, spare, phusd, ownerAccount] = await Promise.all([
    o.chain.balance(acc.authority), o.chain.tokenBalance(acc.usdcAta), o.chain.tokenBalance(acc.phusdAta), o.chain.accountExists(deposit.usdcAta),
  ]);
  const refusals: string[] = [];
  const notes: string[] = [`desk USDC account ${acc.usdcAta}: ${spare === null ? 'does not exist' : `${usdcText(spare)} USDC`}`];
  let kind: PhoenixRescuePlan['kind'];
  let withdrawE6 = 0n;
  let freeE6: bigint | null = null;
  let message: Uint8Array;
  let units = SOLANA_COMPUTE_UNITS;
  let price = SOLANA_PRIORITY_MICROLAMPORTS;
  let creates = ownerAccount ? 0 : 1;
  if (spare !== null && spare >= amountIn) {
    kind = 'spare';
    units = SPARE_RESCUE_UNITS;
    message = spareRescueMessage(exchange, acc, deposit, hash.blockhash, units, price);
  } else {
    withdrawE6 = amountIn - (spare ?? 0n);
    try {
      freeE6 = await o.withdrawable();
      notes.push(`Phoenix withdrawable now: ${usdcText(freeE6)} USDC`);
      if (freeE6 < withdrawE6) refusals.push(`the rescue needs ${usdcText(withdrawE6)} USDC out of Phoenix, but Phoenix lets the trader withdraw ${usdcText(freeE6)} now`);
    } catch (err) {
      refusals.push(`Phoenix's withdrawable collateral could not be read (${errorMessage(err)}): nothing is signed unread`);
    }
    if (desk.paused) {
      kind = 'paused';
      price = 0;
      if (spare === null || phusd === null) refusals.push('the desk is paused, and a paused desk\'s rescue creates none of the desk\'s token accounts, which do not all exist');
      try {
        message = pausedRescueMessage(exchange, acc, withdrawE6, deposit, hash.blockhash);
      } catch (err) {
        refusals.push(errorMessage(err));
        message = rescueMessage(exchange, acc, withdrawE6, deposit, hash.blockhash);
      }
    } else {
      kind = 'withdraw';
      creates += (spare === null ? 1 : 0) + (phusd === null ? 1 : 0);
      message = rescueMessage(exchange, acc, withdrawE6, deposit, hash.blockhash);
    }
  }
  const txLamports = price === 0 ? SIGNATURE_FEE_LAMPORTS : txCostLamports({ units, microLamports: price });
  const need = solNeeded(txLamports, creates);
  if (sol < need) {
    refusals.push(`the desk authority ${acc.authority} holds ${solText(sol)}; this rescue needs ${solText(need)} (the fee${creates > 0 ? `, ${creates} token account rent` : ''} and the rent-exempt reserve): send ${solText(need - sol)} more`);
  }
  const parsed = parseMessage(message);
  if (parsed.signers !== 1 || parsed.keys[0] !== acc.authority) throw new Error('the rescue message is not signed by the desk authority alone');
  if (message.length + 65 > MAX_TX_BYTES) refusals.push(`the rescue transaction is ${message.length + 65} bytes, over Solana's ${MAX_TX_BYTES}`);
  let simulation: Simulation | null = null;
  try {
    simulation = await o.chain.simulate(message);
    if (simulation.err !== null) refusals.push(`the rescue fails in simulation (${JSON.stringify(simulation.err)}${lastLogs(simulation)})`);
  } catch (err) {
    refusals.push(`the rescue could not be simulated (${errorMessage(err)}): nothing is signed unsimulated`);
  }
  return {
    kind, deposit, spareE6: spare, withdrawE6, freeE6, message, lastValidBlockHeight: hash.lastValidBlockHeight,
    solLamports: sol, solNeededLamports: need, simulation, refusals, notes,
  };
}

function lastLogs(s: Simulation): string {
  const tail = s.logs.slice(-3);
  return tail.length === 0 ? '' : `; last logs: ${tail.join(' | ')}`;
}

export interface PhoenixRescuePayerOptions extends PhoenixRescueOptions {
  deskId: string;
  /** The contract's sol_sign_rescue. */
  contract: { solSignRescue(deskId: string, messageB64: string, quote: SignedQuote, reason: string): Promise<SolSignedAction> };
  /** Sends the signed transaction and waits until it is confirmed, or proven never to land (SolanaSubmitter). */
  sender: { submit(signed: SolSignedAction, options: SolanaSendOptions): Promise<TxRef[]> };
  log?: (line: string) => void;
}

/** The rescuer's `phoenix` payer: sol_sign_rescue of a message built and simulated in prepare(), signed once. */
export class PhoenixRescuePayer implements Payer {
  readonly method = 'sol_sign_rescue' as const;
  readonly #o: PhoenixRescuePayerOptions;
  /** The prepared plan per deposit address; sign() takes it out, so one message is ever asked for per quote. */
  readonly #plans = new Map<string, PhoenixRescuePlan>();

  constructor(options: PhoenixRescuePayerOptions) {
    this.#o = options;
  }

  async prepare(q: VerifiedQuote): Promise<PreparedPayment> {
    const plan = await planPhoenixRescue(this.#o, q.depositAddress, q.amountIn);
    if (plan.refusals.length > 0) throw new Error(`the Phoenix rescue is refused: ${plan.refusals.join('; ')}`);
    this.#o.log?.(`rescue: Phoenix pays ${usdcText(q.amountIn)} USDC to ${q.depositAddress} (${plan.kind}${plan.withdrawE6 > 0n ? `, ${usdcText(plan.withdrawE6)} withdrawn from Phoenix` : ''}; simulated, ${plan.simulation?.unitsConsumed ?? '?'} CU)`);
    this.#plans.set(q.depositAddress, plan);
    return { solana: { lastValidBlockHeight: plan.lastValidBlockHeight } };
  }

  async sign(q: VerifiedQuote, reason: string, prepared?: PreparedPayment): Promise<SignedPayment> {
    const plan = this.#plans.get(q.depositAddress);
    this.#plans.delete(q.depositAddress);
    if (plan === undefined || prepared?.solana?.lastValidBlockHeight !== plan.lastValidBlockHeight) {
      throw new Error('no prepared Phoenix rescue message for this quote: nothing was signed');
    }
    const messageB64 = Buffer.from(plan.message).toString('base64');
    const ids = { solMessage: solMessageDigest(messageB64), solLastValidBlockHeight: plan.lastValidBlockHeight };
    let signed: SolSignedAction;
    try {
      signed = await this.#o.contract.solSignRescue(this.#o.deskId, messageB64, { quote: q.quote, quote_signature: q.signature }, reason);
    } catch (err) {
      if (err instanceof OutcomeUnknown) throw err.with(ids);
      // A late MPC signature may still be posted: held (the deposit ring takes this quote once, so no other message).
      if (err instanceof MpcTimeoutError) {
        throw new OutcomeUnknown('solana rescue', `${err.message}; this quote's message is never built again`, err.txHash === null ? ids : { ...ids, nearTx: err.txHash });
      }
      throw err;
    }
    const nearTx = signed.nearTx === undefined ? [] : [signed.nearTx];
    if (signed.payload?.message_b64 !== messageB64) {
      // Something was signed: held until it is shown never to land.
      throw new OutcomeUnknown('solana rescue', 'the contract signed a different message than the one built; nothing sent', { ...ids, ...(signed.nearTx === undefined ? {} : { nearTx: signed.nearTx.id }) }, nearTx);
    }
    const { signature } = SolanaSubmitter.transaction(signed);
    const authority = parseMessage(plan.message).keys[0]!;
    return {
      tx: nearTx,
      solanaSignature: signature,
      // A withdrawal out of Phoenix changes its margin: marked as the desk's act (venues/desk-acts.ts).
      send: () => asDeskAct(async () => {
        const tx = await this.#o.sender.submit(signed, { authority, lastValidBlockHeight: plan.lastValidBlockHeight });
        return { tx, depositTx: signature };
      }),
    };
  }
}

export interface PhoenixDeskCreditOptions {
  network: ChainNetwork;
  chain: SolanaChain;
  desk: () => Promise<PhoenixDesk>;
  /** The trader's state on Phoenix ('uninitialized' until sol_sign_register ran); null: unknown. */
  traderState?: () => Promise<string | null>;
  /** The contract's sol_sign and the send (Relayer.solSign). */
  solSign: (build: SolanaMessageBuilder, reason: string) => Promise<TxRef[]>;
  exchange?: PhoenixExchangeAccounts;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  /** How long the delivered USDC may take to show on the desk's USDC account after 1Click's SUCCESS; default 120 s. */
  deliveryTimeoutMs?: number;
  pollMs?: number;
}

/** Phoenix as a rescue target: confirms 1Click's delivery on the desk's Solana USDC account, then deposits it. */
export class PhoenixDeskCredit implements CreditPort {
  readonly #o: PhoenixDeskCreditOptions;
  /** Deposits made, by amount (USDC base units), for the landing to confirm. */
  readonly #deposits: { amountE6: bigint; entry: LedgerEntry }[] = [];

  constructor(options: PhoenixDeskCreditOptions) {
    this.#o = options;
  }

  /** The landing that confirms these deposits (Phoenix only). */
  landing(): LandingPort {
    return new PhoenixDepositLanding(this);
  }

  async ready(): Promise<string | null> {
    const desk = await this.#o.desk();
    if (desk.paused) return 'the desk is paused, and sol_sign takes no deposit on a paused desk';
    const a = desk.accounts;
    const [registered, state, sol, phusd] = await Promise.all([
      this.#o.chain.accountExists(a.traderAccount), this.#o.traderState?.() ?? Promise.resolve(null), this.#o.chain.balance(a.authority), this.#o.chain.tokenBalance(a.phusdAta),
    ]);
    if (!registered || state === 'uninitialized') return `the desk's Phoenix trader ${a.traderAccount} is not registered (sol_sign_register)`;
    const need = solNeeded(MONEY_TX_LAMPORTS, phusd === null ? 1 : 0);
    if (sol < need) return `the desk authority ${a.authority} holds ${solText(sol)}, under the ${solText(need)} a deposit needs`;
    return null;
  }

  /** The desk's Solana USDC now (0 when its account does not exist yet), read before a rescue's payment. */
  async baseline(): Promise<bigint> {
    const desk = await this.#o.desk();
    return (await this.#o.chain.tokenBalance(desk.accounts.usdcAta)) ?? 0n;
  }

  /** The owner's command that deposits USDC left on the desk's Solana wallet into Phoenix margin. */
  manual(amountE6: bigint): string {
    return `stop serve if it trades this desk (it holds the trader lock), then from the main checkout run pair-mainnet fund-phoenix ${usdcText(amountE6)} (dry), then again with --send`;
  }

  async credit(amountE6: bigint, reason: string, options: CreditOptions = {}): Promise<{ tx: TxRef[] }> {
    const deliveryTx = options.deliveryTx ?? [];
    // The delivery counts above what the account held before the payment (dust or an earlier delivery is not it).
    const base = options.baseE6 ?? 0n;
    const desk = await this.#o.desk();
    const a = desk.accounts;
    // 1Click's SUCCESS names the delivery on Solana: it must be there, then the USDC on the desk's account.
    const named = deliveryTx.filter((h) => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(h));
    if (named.length > 0) {
      const slots = await Promise.all(named.map((h) => this.#o.chain.signatureSlot(h).catch(() => null)));
      if (slots.every((s) => s === null)) throw new Error(`1Click's delivery ${named.join(', ')} is not on Solana: nothing was deposited`);
    }
    const until = this.#o.clock.now() + (this.#o.deliveryTimeoutMs ?? 120_000);
    for (;;) {
      const held = await this.#o.chain.tokenBalance(a.usdcAta).catch(() => null);
      if (held !== null && held >= base + amountE6) break;
      if (options.stopping?.() === true) throw new Error('the engine is stopping while the delivery was awaited: nothing was deposited');
      if (this.#o.clock.now() >= until) {
        throw new Error(`the desk USDC account ${a.usdcAta} holds ${held === null ? 'nothing (or could not be read)' : `${usdcText(held)} USDC`}, under the ${usdcText(base)} before the payment plus the ${usdcText(amountE6)} delivered: nothing was deposited`);
      }
      await this.#o.sleep(this.#o.pollMs ?? 3_000);
    }
    const ctx: MoneyContext = {
      chain: this.#o.chain, desk: a, ...(this.#o.exchange === undefined ? {} : { exchange: this.#o.exchange }),
      ...(this.#o.traderState === undefined ? {} : { traderState: this.#o.traderState }),
    };
    const plan = await planDeposit(ctx, amountE6);
    if (desk.paused) plan.refusals.push('the desk is paused: sol_sign takes no deposit');
    const price = parseMessage(plan.message).computeUnitPrice;
    if (price !== null && price > BigInt(MAX_PRIORITY_MICROLAMPORTS)) plan.refusals.push(`the deposit's priority price ${price} is over the ${MAX_PRIORITY_MICROLAMPORTS} µlamports sol_sign takes`);
    if (plan.refusals.length > 0) throw new Error(`the deposit is refused, nothing signed: ${plan.refusals.join('; ')}`);
    // The hold says the deposit may run from here on: a restart then never tells the owner to deposit it again.
    if (options.beforeSign?.() === false) throw new Error('the rescuer state could not be saved before the deposit: nothing was deposited');
    const tx = await sendPlan(plan, ctx, { solSign: this.#o.solSign }, reason);
    const sig = tx.find((x) => x.chain === 'solana')?.id;
    if (sig === undefined) throw new Error('the Phoenix deposit returned no Solana transaction');
    this.#deposits.push({ amountE6, entry: { id: `phoenix:${sig}`, usd: Number(amountE6) / 1e6, tx: [solanaTxRef(this.#o.network, sig)] } });
    return { tx };
  }

  /** The confirmed deposit of `amountE6` not yet matched, or null. */
  deposited(amountE6: bigint, seen: ReadonlySet<string>): LedgerEntry | null {
    return this.#deposits.find((d) => d.amountE6 === amountE6 && !seen.has(d.entry.id))?.entry ?? null;
  }
}

/** A landing on Phoenix: the deposit transaction PhoenixDeskCredit sent, confirmed on Solana (deposit_funds ran). */
export class PhoenixDepositLanding implements LandingPort {
  readonly #credit: PhoenixDeskCredit;

  constructor(credit: PhoenixDeskCredit) {
    this.#credit = credit;
  }

  confirms(venue: VenueId): string | null {
    return venue === 'phoenix' ? null : `a landing on ${venue} is not confirmed by the Phoenix deposit`;
  }

  async find(venue: VenueId, q: VerifiedQuote, _sinceMs: number, seen: ReadonlySet<string>): Promise<LedgerEntry | null> {
    return venue === 'phoenix' ? this.#credit.deposited(q.minAmountOut, seen) : null;
  }
}

/** One landing port over several venues; a venue none confirms is refused with its reason. */
export class VenueLandings implements LandingPort {
  readonly #by: Partial<Record<VenueId, LandingPort>>;
  readonly #refused: Partial<Record<VenueId, string>>;

  constructor(by: Partial<Record<VenueId, LandingPort>>, refused: Partial<Record<VenueId, string>> = {}) {
    this.#by = by;
    this.#refused = refused;
  }

  confirms(venue: VenueId): string | null {
    const port = this.#by[venue];
    if (port === undefined) return this.#refused[venue] ?? `a landing on ${venue} cannot be confirmed here`;
    return port.confirms(venue);
  }

  async find(venue: VenueId, q: VerifiedQuote, sinceMs: number, seen: ReadonlySet<string>, deliveryTx?: readonly string[]): Promise<LedgerEntry | null> {
    return this.#by[venue]?.find(venue, q, sinceMs, seen, deliveryTx) ?? null;
  }
}
