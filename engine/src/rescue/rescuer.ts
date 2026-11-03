// The rescue executor (E9): the risk engine's `rescuer`. It takes a RescueTrigger, plans where the margin comes from
// (plan.ts), runs it, and tells the risk engine how it ended with rescueEnded(id, landed), exactly once per trigger.
//
// A transfer, for each hop: quote -> verify (1Click's signature and the contract's field rules, oneclick.ts) -> sign
// (the contract has the MPC network sign the payment) -> deposit (the payment is sent, then POST /deposit/submit) ->
// 1Click's status until SUCCESS -> the delivery found in the target venue's ledger (LandingPort) -> landed. A landing
// is never judged on equity: equity moves with the mark, and a real delivery on a losing leg could look like none.
// Routes:
//   reserve  -> X            fund_venue (USDC on NEAR to the 1Click deposit address; the contract pays it itself)
//   Phoenix  -> X            sol_sign_rescue (Phoenix withdraw + Ember unwrap + the transfer, one Solana transaction)
//   Hyperliquid -> X         USDC already on the desk's Arbitrum address first; else hl_withdraw to it (no deposit;
//                            counts against the cap) and wait for the USDC there; then evm_usdc_to_intents (EIP-3009
//                            via the relayer) -> 1Click
//   reduce                   both legs reduce-only by the same size (the pair trader's close with targets)
// Into Hyperliquid the USDC lands in perps; into Orderly it goes to the pinned exclusive receiver (at least 6 USDC
// out) and Orderly credits it 1–2 min after arrival; into Phoenix it lands as USDC on the desk's Solana account and a
// credit port (a Phoenix deposit) must move it into margin, so without one that target takes no transfer. A target
// whose landing the LandingPort cannot confirm takes no transfer either.
//
// Every step publishes a RescueProgress (`rescue` event) with the seconds since the trigger and the transactions so
// far; the journal gets the start, each source used, and landed or failed with the reason. A failure sets the desk's
// rescueFailure (the risk engine clears it once the desk is out of rescue) and ends the rescue as failed, so the risk
// engine tries again after its backoff while the leg stays in rescue.
//
// Paying twice is the failure this guards against. Money that may still move holds every later transfer (only reduces
// run) until it is settled:
//   - a payment signed but not sent (its signature is public and stays usable: an EIP-3009 authorization until its
//     validBefore), or sent and not settled by 1Click in time, or settled but not yet seen in the ledger: held until
//     its deposit address reaches a final 1Click status and, on SUCCESS, the delivery is found (journaled late);
//   - an OutcomeUnknown: held until the owner restarts the engine after reconciling.
// A Hyperliquid withdraw whose USDC was not bridged holds new withdraws (not the Arbitrum USDC, which goes first),
// until a bridge from Arbitrum lands. The cap meter is this process's: on mainnet it starts as if the whole hourly cap
// were used just before the engine started (the contract's counters have no view), the conservative bound of what
// the contract may still count.
//
// One rescue runs at a time: a trigger that comes while one runs ends at once as failed (tried again after the
// backoff); runningId tells the risk engine not to count a running rescue as lapsed. A desk that is closing
// (panic_close) starts no rescue.

import type { ContractPolicy, Leg, Mode, RescueFailure, RescueProgress, StreamEvent, TxRef, VenueId } from '@gimbal/shared';
import { OutcomeUnknown } from '../contract/types.ts';
import type { RescueTrigger } from '../risk/engine.ts';
import type { PairResult } from '../trade/pair.ts';
import type { TradeLeg } from '../trade/legs.ts';
import { abs, floorToLot, qtyString } from '../trade/lots.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';
import type { DeskAddresses, OneClickApi, QuoteRequest, QuotedMethod, QuoteResponse, VerifiedQuote } from './oneclick.ts';
import { ASSETS, FINAL_STATUSES, e8Text, unitsOf, verifyQuote } from './oneclick.ts';
import type { Plan, Source } from './plan.ts';
import { CapLedger, HL_WITHDRAW_FEE_USD, SLIPPAGE_BPS, planRescue } from './plan.ts';

/** How often 1Click's status, the Arbitrum balance and the target's ledger are read while a rescue waits. */
export const POLL_MS = 5_000;
/** A 1Click transfer not SUCCESS after this is failed and held (measured 45–95 s; the quote's estimate was half that). */
export const TRANSFER_TIMEOUT_MS = 10 * 60_000;
/** hl_withdraw's USDC not on Arbitrum after this is failed (measured 231 s). */
export const WITHDRAW_TIMEOUT_MS = 15 * 60_000;
/** The delivery not in the target's ledger after 1Click's SUCCESS within this is failed and held (Orderly: 1–2 min). */
export const LANDING_TIMEOUT_MS = 5 * 60_000;
/** A signed payment with no validity of its own is taken as usable this long (a 1Click deposit address lives 30 min). */
export const SIGNED_USABLE_MS = 35 * 60_000;

export type RescueStep = RescueProgress['step'];

/** The desk as a rescue needs it: where quotes may deliver, its limits and its state on NEAR. */
export interface RescueDesk {
  addresses: DeskAddresses;
  policy: Pick<ContractPolicy, 'rescue_cap_usd_per_hour' | 'max_transfer_cost_bps' | 'max_transfer_cost_flat_e6'>;
  reserveUsd: number;
  closing: boolean;
}

/** A payment signed by the contract, ready to send: `send` delivers it and names the transaction 1Click is told of. */
export interface SignedPayment {
  tx: TxRef[];
  send(): Promise<{ tx: TxRef[]; depositTx: string }>;
  /** Until when anyone holding the signature could still send it, ms (EIP-3009 validBefore); absent: SIGNED_USABLE_MS. */
  usableUntilMs?: number;
}

/** Pays a verified quote from one source: fund_venue, sol_sign_rescue or evm_usdc_to_intents. */
export interface Payer {
  readonly method: QuotedMethod;
  sign(quote: VerifiedQuote, reason: string): Promise<SignedPayment>;
}

/** Hyperliquid's way out: hl_withdraw to the desk's EVM address on Arbitrum, and that address's USDC. */
export interface HlWithdrawPort {
  /** Signs and posts withdraw3 of `amountE6` (USDC × 1e6); resolves once Hyperliquid accepted it. */
  withdraw(amountE6: bigint, reason: string): Promise<{ tx: TxRef[] }>;
  /** The desk EVM address's USDC on Arbitrum, × 1e6. */
  arbitrumUsdcE6(): Promise<bigint>;
}

/** After 1Click delivered to a venue's wallet: what moves it into that venue's margin (Phoenix: a deposit). */
export interface CreditPort {
  credit(amountE6: bigint, reason: string): Promise<{ tx: TxRef[] }>;
}

/** A delivery as the target venue's ledger booked it. */
export interface LedgerEntry {
  /** Unique per entry (a ledger hash), so one entry confirms one transfer only. */
  id: string;
  usd: number;
  tx: TxRef[];
}

/** Where a landing is confirmed: the target venue's ledger, never its equity. */
export interface LandingPort {
  /** Why a landing on `venue` cannot be confirmed here, or null. */
  confirms(venue: VenueId): string | null;
  /** The entry that is this delivery: on `venue`, booked since `sinceMs`, at least minAmountOut, not one of `seen`. */
  find(venue: VenueId, q: VerifiedQuote, sinceMs: number, seen: ReadonlySet<string>): Promise<LedgerEntry | null>;
}

/** The pair trader's close, as a reduce uses it. */
export interface Reducer {
  readonly legs: readonly [TradeLeg, TradeLeg];
  readonly lot: bigint;
  close(request: { reason: string; targets?: [bigint, bigint]; reduceOnly?: boolean }): Promise<PairResult>;
}

export interface RescuerOptions {
  mode: Mode;
  publish: (event: StreamEvent) => void;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  oneClick: OneClickApi;
  /** get_desk, as the rescue needs it; read fresh at the start of every rescue. */
  desk: () => Promise<RescueDesk>;
  /** The legs and free margin as the risk engine last read them. */
  view: () => { legs: readonly Leg[]; freeMargin: Partial<Record<VenueId, number>> };
  landing: LandingPort;
  payers: Partial<Record<'reserve' | 'phoenix' | 'arbitrum', Payer>>;
  hlWithdraw?: HlWithdrawPort;
  credit?: Partial<Record<VenueId, CreditPort>>;
  /** The pair trader holding both legs; absent: no reduce. */
  reducer?: () => Reducer | null;
  /** RiskEngine.rescueEnded. */
  ended: (id: string, landed: boolean) => void;
  /** RiskEngine.setRescueFailure. */
  failure?: (f: RescueFailure | null) => void;
  /** VenueHealth.withdrawals: what the withdraw step learnt. */
  withdrawals?: (venue: VenueId, paused: string | null) => void;
  /** 1Click is called with an API key. */
  keyed?: boolean;
  /** Recorded mode: the amount a recording sends on a route (plan.ts fixedAmountUsd). */
  fixedAmountUsd?: (from: Source, to: VenueId) => number | null;
  /** Start the cap meter as if the whole cap were used at start (see the header); default: on mainnet. */
  seedCap?: boolean;
  /** Said in every journal line of a rescue that moves nothing real (testnet, replay). */
  label?: string | null;
  log?: (line: string) => void;
  pollMs?: number;
  transferTimeoutMs?: number;
  withdrawTimeoutMs?: number;
  landingTimeoutMs?: number;
}

/** Ends the run of one step: the step it failed at and why. */
class StepFailed extends Error {
  readonly step: Exclude<RescueStep, 'landed' | 'failed'>;
  constructor(step: Exclude<RescueStep, 'landed' | 'failed'>, message: string) {
    super(message);
    this.step = step;
  }
}

interface Run {
  trigger: RescueTrigger;
  from: Source;
  amountUsd: number;
  startedAt: number;
  tx: TxRef[];
  step: RescueStep;
  ended: boolean;
  signedS: number | null;
  /** This run's hl_withdraw went out: a later failure leaves its USDC on Arbitrum. */
  withdrew: boolean;
}

/** A payment that may still move: held until 1Click settles it and, on SUCCESS, the ledger shows it. */
interface DepositHold {
  why: string;
  rescueId: string;
  venue: VenueId;
  q: VerifiedQuote;
  sinceMs: number;
  /** A deposit address still PENDING_DEPOSIT after this was never paid (null: it was sent, so wait for a final status). */
  unusedAfterMs: number | null;
}

export class Rescuer {
  readonly #o: RescuerOptions;
  readonly #cap = new CapLedger();
  readonly #startedAt: number;
  #capSeeded = false;
  #running: Run | null = null;
  #unknown: string | null = null;
  readonly #deposits: DepositHold[] = [];
  #hlHeld: string | null = null;
  readonly #seen = new Set<string>();
  #seq = 0;
  #closingSaid = false;
  /** The run in flight (tests wait on it). */
  current: Promise<void> | null = null;

  constructor(options: RescuerOptions) {
    // 1Click has no testnet: a live 1Click off mainnet would move real mainnet money for a test desk.
    if (options.mode !== 'mainnet' && options.oneClick.source === 'live') {
      throw new Error(`the rescue runs live only on mainnet; ${options.mode} takes 1Click's answers from a recording`);
    }
    this.#o = options;
    this.#startedAt = options.clock.now();
  }

  /** What the rescues of the last hour still weigh against the cap, USD. */
  capUsed(): number {
    return this.#cap.used(this.#o.clock.now());
  }

  /** Why transfers are held, or null. */
  get held(): string | null {
    const all = [this.#unknown, ...this.#deposits.map((d) => d.why)].filter((x): x is string => x !== null);
    return all.length === 0 ? null : all.join('; ');
  }

  /** Why no new hl_withdraw may go out, or null. */
  get hlWithdrawHeld(): string | null {
    return this.#hlHeld;
  }

  /** The id of the rescue running now, or null (the risk engine does not lapse it). */
  get runningId(): string | null {
    return this.#running?.trigger.id ?? null;
  }

  /** The risk engine's rescuer: starts the rescue and returns at once. */
  take(trigger: RescueTrigger): void {
    const run: Run = { trigger, from: trigger.from, amountUsd: trigger.amountUsd, startedAt: this.#o.clock.now(), tx: [], step: 'detect', ended: false, signedS: null, withdrew: false };
    this.#progress(run, 'detect');
    if (this.#running !== null) {
      this.#fail(run, 'source', `rescue ${this.#running.trigger.id} of ${this.#running.trigger.venue} ${this.#running.trigger.symbol} is still running; one runs at a time`, 'tried again after the backoff');
      return;
    }
    this.#running = run;
    this.current = this.#run(run).catch((err: unknown) => {
      this.#fail(run, run.step === 'detect' || run.step === 'landed' || run.step === 'failed' ? 'source' : run.step, `unexpected: ${errorMessage(err)}`, 'tried again after the backoff');
    }).finally(() => {
      if (this.#running === run) this.#running = null;
    });
  }

  async #run(run: Run): Promise<void> {
    const t = run.trigger;
    let desk: RescueDesk;
    try {
      desk = await this.#o.desk();
    } catch (err) {
      return this.#fail(run, 'source', `get_desk could not be read: ${errorMessage(err)}`, 'tried again after the backoff');
    }
    if (!this.#capSeeded) {
      this.#capSeeded = true;
      if (this.#o.seedCap ?? this.#o.mode === 'mainnet') {
        this.#cap.add(desk.policy.rescue_cap_usd_per_hour, this.#startedAt);
        this.#log(`rescue cap: counted as used in full at start (${desk.policy.rescue_cap_usd_per_hour} USD), freeing over the first hour: the contract's counters have no view`);
      }
    }
    if (desk.closing) {
      const say = !this.#closingSaid;
      this.#closingSaid = true;
      return this.#fail(run, 'source', 'the desk is closing (panic_close): no rescue starts; both legs are being closed reduce-only', 'the close runs; the owner unpauses to trade again', say);
    }
    this.#closingSaid = false;
    if (!t.amountKnown) {
      return this.#fail(run, 'source', 'the amount is unknown (no mark and no entry price to size it by)', 'only the owner can act now');
    }
    if (!(t.amountUsd > 0)) {
      this.#journal(run, `rescue ${t.id}: ${t.venue} ${t.symbol} needs no margin to reach its watch line; nothing to move`, {});
      return this.#land(run, 0, null);
    }
    await this.#settleHolds();
    const arbitrumUsd = this.#o.hlWithdraw === undefined ? undefined : await this.#o.hlWithdraw.arbitrumUsdcE6().then((e6) => Number(e6) / 1e6, () => undefined);
    const view = this.#o.view();
    const leg = view.legs.find((l) => l.venue === t.venue && l.symbol === t.symbol);
    const plan = planRescue({
      target: { venue: t.venue, symbol: t.symbol, amountUsd: t.amountUsd, marginUsd: leg?.marginUsd ?? null },
      reserveUsd: desk.reserveUsd,
      freeMargin: view.freeMargin,
      legVenues: view.legs.map((l) => l.venue),
      capUsd: desk.policy.rescue_cap_usd_per_hour,
      capUsedUsd: this.capUsed(),
      route: (from, to) => this.#routeProblem(from, to, desk),
      reduce: this.#reduceProblem(),
      keyed: this.#o.keyed === true,
      maxCostBps: desk.policy.max_transfer_cost_bps,
      maxCostFlatE6: desk.policy.max_transfer_cost_flat_e6,
      transfersHeld: this.held,
      hlWithdrawHeld: this.#hlHeld,
      ...(arbitrumUsd === undefined ? {} : { arbitrumUsd }),
      ...(this.#o.fixedAmountUsd === undefined ? {} : { fixedAmountUsd: this.#o.fixedAmountUsd }),
    });
    run.from = plan.kind === 'transfer' ? plan.from : t.venue;
    this.#journal(run, `rescue ${t.id} started: ${t.venue} ${t.symbol} needs ${t.amountUsd.toFixed(2)} USD of margin; ${planText(plan)}`
      + `${plan.notes.length === 0 ? '' : ` (passed over: ${plan.notes.join('; ')})`}`, { venue: t.venue, amountUsd: t.amountUsd, from: run.from });
    if (plan.kind === 'none') {
      return this.#fail(run, 'source', `${plan.reason}${plan.notes.length === 0 ? '' : `; passed over: ${plan.notes.join('; ')}`}`, 'only the owner can act now');
    }
    this.#progress(run, 'source');
    try {
      if (plan.kind === 'reduce') await this.#reduce(run, plan.fraction);
      else await this.#transfer(run, plan, desk);
    } catch (err) {
      if (!(err instanceof StepFailed)) throw err;
      if (run.withdrew) this.#hlHeld ??= `rescue ${t.id}'s hl_withdraw left its USDC on the desk's Arbitrum address unbridged; it is spent first`;
      const next = this.held === null ? 'tried again after the backoff' : 'only reduces run until what may still move is settled';
      return this.#fail(run, err.step, err.message, next);
    }
  }

  // ---- routes ----

  #routeProblem(from: Source, to: VenueId, desk: RescueDesk): string | null {
    if (from === 'orderly') return 'Orderly is never a source (settle, withdraw and an EIP-3009 transfer: four signatures)';
    if (to === 'orderly' && desk.addresses.orderlyReceiver === null) return 'no Orderly receiver is pinned (set_orderly_receiver)';
    if (to === 'phoenix' && this.#o.credit?.phoenix === undefined) return 'into Phoenix the USDC lands on the desk\'s Solana account, and no Phoenix deposit is wired to move it into margin';
    if (from === 'hyperliquid' && to === 'orderly') return 'Hyperliquid\'s USDC leaves through Arbitrum, and Arbitrum USDC into the Orderly receiver is the same asset, which 1Click does not quote';
    const landing = this.#o.landing.confirms(to);
    if (landing !== null) return landing;
    if (from === 'reserve' && this.#o.payers.reserve === undefined) return 'fund_venue is not wired';
    if (from === 'phoenix' && this.#o.payers.phoenix === undefined) return 'sol_sign_rescue is not wired';
    if (from === 'hyperliquid' && (this.#o.hlWithdraw === undefined || this.#o.payers.arbitrum === undefined)) return 'hl_withdraw and evm_usdc_to_intents are not wired';
    return null;
  }

  #reduceProblem(): string | null {
    const r = this.#o.reducer?.() ?? null;
    return r === null ? 'no pair trader holds the legs here' : null;
  }

  async #transfer(run: Run, plan: Extract<Plan, { kind: 'transfer' }>, desk: RescueDesk): Promise<void> {
    const t = run.trigger;
    const to = plan.to;
    const since = this.#o.clock.now();
    if (plan.from === 'hyperliquid') {
      const amountE6 = plan.withdrawUsd === null ? BigInt(Math.round(plan.amountInUsd * 1e6)) : await this.#hlOut(run, plan);
      if (plan.withdrawUsd === null) this.#journal(run, `rescue ${t.id}: source hyperliquid, ${plan.amountInUsd.toFixed(2)} USDC already on the desk's Arbitrum address (an earlier withdraw), no new withdraw`, { from: 'hyperliquid' });
      const q = await this.#hop(run, 'arbitrum', to, Number(amountE6) / 1e6, desk, `rescue ${t.id}: Hyperliquid -> Arbitrum -> ${to}`, since);
      await this.#landing(run, q, since, plan);
      // The Arbitrum USDC is bridged: Hyperliquid may be withdrawn from again.
      this.#hlHeld = null;
      return;
    }
    const payer = plan.from === 'reserve' ? 'reserve' : 'phoenix';
    const q = await this.#hop(run, payer, to, plan.amountInUsd, desk, `rescue ${t.id}: ${plan.from} -> ${to}`, since);
    return this.#landing(run, q, since, plan);
  }

  /** Hyperliquid -> the desk's Arbitrum address: hl_withdraw, then the USDC seen there. Returns what arrived (× 1e6). */
  async #hlOut(run: Run, plan: Extract<Plan, { kind: 'transfer' }>): Promise<bigint> {
    const port = this.#o.hlWithdraw!;
    const t = run.trigger;
    const amountE6 = BigInt(Math.round(plan.withdrawUsd! * 1e6));
    const expectE6 = amountE6 - BigInt(HL_WITHDRAW_FEE_USD * 1e6);
    let baseE6: bigint;
    try {
      baseE6 = await port.arbitrumUsdcE6();
    } catch (err) {
      throw new StepFailed('source', `the desk's Arbitrum USDC could not be read before hl_withdraw: ${errorMessage(err)}`);
    }
    this.#progress(run, 'sign');
    const signStart = this.#o.clock.now();
    let tx: TxRef[];
    // Counted before it is sent: the contract counts the operator's hl_withdraw whatever happens after.
    this.#cap.add(plan.withdrawUsd!, signStart);
    try {
      ({ tx } = await port.withdraw(amountE6, `rescue ${t.id}: Hyperliquid margin to the desk's Arbitrum address for ${t.venue}`));
      this.#o.withdrawals?.('hyperliquid', null);
    } catch (err) {
      const why = errorMessage(err);
      if (/withdraw\w*\s+(are\s+|is\s+)?(paused|disabled|suspended)/i.test(why)) this.#o.withdrawals?.('hyperliquid', why);
      if (err instanceof OutcomeUnknown) {
        this.#unknown ??= `the hl_withdraw of rescue ${t.id} may have gone out (${why}); reconcile the Hyperliquid ledger before any other transfer`;
      }
      throw new StepFailed('sign', `hl_withdraw ${(Number(amountE6) / 1e6).toFixed(2)} USDC: ${why}`);
    }
    run.withdrew = true;
    run.signedS = (this.#o.clock.now() - signStart) / 1000;
    run.tx.push(...tx);
    this.#journal(run, `rescue ${t.id}: source hyperliquid, hl_withdraw ${(Number(amountE6) / 1e6).toFixed(2)} USDC to the desk's Arbitrum address (1 USDC fee)`, { from: 'hyperliquid', usd: 0, feeUsd: -HL_WITHDRAW_FEE_USD, signedS: round1(run.signedS) }, tx);
    this.#progress(run, 'deposit');
    const until = this.#o.clock.now() + (this.#o.withdrawTimeoutMs ?? WITHDRAW_TIMEOUT_MS);
    for (;;) {
      const now = await port.arbitrumUsdcE6().catch(() => null);
      if (now !== null && now - baseE6 >= expectE6) return now - baseE6;
      if (this.#o.clock.now() >= until) {
        throw new StepFailed('deposit', `hl_withdraw's ${(Number(expectE6) / 1e6).toFixed(2)} USDC did not reach the desk's Arbitrum address within ${Math.round((this.#o.withdrawTimeoutMs ?? WITHDRAW_TIMEOUT_MS) / 1000)} s (measured 231 s)`);
      }
      await this.#o.sleep(this.#o.pollMs ?? POLL_MS);
    }
  }

  /** One 1Click transfer of `amountInUsd` from a payer into `to`: quote, verify, sign, deposit, until 1Click's SUCCESS. */
  async #hop(run: Run, payerKey: 'reserve' | 'phoenix' | 'arbitrum', to: VenueId, amountInUsd: number, desk: RescueDesk, reason: string, since: number): Promise<VerifiedQuote> {
    const payer = this.#o.payers[payerKey]!;
    const a = desk.addresses;
    const id = run.trigger.id;
    const origin = payer.method === 'fund_venue' ? ASSETS.nearUsdc : payer.method === 'sol_sign_rescue' ? ASSETS.solanaUsdc : ASSETS.arbitrumUsdc;
    const [destination, recipient] = to === 'hyperliquid' ? [ASSETS.hypercoreUsdc, a.evm] : to === 'orderly' ? [ASSETS.arbitrumUsdc, a.orderlyReceiver!] : [ASSETS.solanaUsdc, a.sol];
    const refundTo = payer.method === 'fund_venue' ? a.owner : payer.method === 'sol_sign_rescue' ? a.sol : a.evm;
    const body: QuoteRequest = {
      dry: false, swapType: 'EXACT_INPUT', slippageTolerance: SLIPPAGE_BPS, originAsset: origin, depositType: 'ORIGIN_CHAIN',
      destinationAsset: destination, amount: unitsOf(amountInUsd, origin).toString(), refundTo, refundType: 'ORIGIN_CHAIN',
      recipient, recipientType: 'DESTINATION_CHAIN', deadline: new Date(this.#o.clock.now() + 30 * 60_000).toISOString(),
    };
    this.#progress(run, 'quote');
    let response: QuoteResponse;
    try {
      const answer = await this.#o.oneClick.quote(body);
      if (!answer.ok) throw new StepFailed('quote', `1Click gave no quote ${run.from} -> ${to}: ${answer.message} (HTTP ${answer.status})`);
      response = answer.response;
    } catch (err) {
      if (err instanceof StepFailed) throw err;
      throw new StepFailed('quote', `1Click did not answer the quote: ${errorMessage(err)}`);
    }
    this.#progress(run, 'verify');
    let q: VerifiedQuote;
    const capLeft = Math.max(0, desk.policy.rescue_cap_usd_per_hour - this.capUsed());
    try {
      q = verifyQuote(response, payer.method, {
        desk: a,
        nowMs: this.#o.oneClick.verifyAt?.(response) ?? this.#o.clock.now(),
        maxCostBps: desk.policy.max_transfer_cost_bps,
        maxCostFlatE6: desk.policy.max_transfer_cost_flat_e6,
        remainingCapE8: payer.method === 'fund_venue' ? null : BigInt(Math.floor(capLeft * 1e8)),
        ...(this.#o.oneClick.publicKey === undefined ? {} : { publicKey: this.#o.oneClick.publicKey }),
      });
      if (q.destinationAsset !== destination || q.recipient.toLowerCase() !== recipient.toLowerCase()) {
        throw new Error(`the quote delivers ${q.destinationAsset} to ${q.recipient}, not ${destination} to ${recipient}`);
      }
      if (this.#o.fixedAmountUsd === undefined && q.amountIn.toString() !== body.amount) throw new Error(`the quote's amountIn ${q.amountIn} is not the ${body.amount} asked`);
    } catch (err) {
      throw new StepFailed('verify', `the quote was refused before signing: ${errorMessage(err)}`);
    }
    this.#progress(run, 'sign');
    const signStart = this.#o.clock.now();
    // The contract counts a rescue transfer once the MPC network signs, even if it is never sent.
    if (payer.method !== 'fund_venue') this.#cap.add(Number(q.amountInE8) / 1e8, signStart);
    let signed: SignedPayment;
    try {
      signed = await payer.sign(q, reason);
    } catch (err) {
      if (err instanceof OutcomeUnknown) {
        this.#unknown ??= `the ${payer.method} of rescue ${id} may have been signed or paid (${errorMessage(err)}); reconcile it before any other transfer`;
      }
      throw new StepFailed('sign', `${payer.method}: ${errorMessage(err)}`);
    }
    run.tx.push(...signed.tx);
    run.signedS = (this.#o.clock.now() - signStart) / 1000;
    this.#progress(run, 'deposit');
    let depositTx: string;
    try {
      const sent = await signed.send();
      run.tx.push(...sent.tx.filter((x) => !run.tx.some((y) => y.chain === x.chain && y.id === x.id)));
      depositTx = sent.depositTx;
    } catch (err) {
      // Signed is enough to pay: the signature is public (in the NEAR receipt) and anyone may send it while it is valid.
      const until = signed.usableUntilMs ?? this.#o.clock.now() + SIGNED_USABLE_MS;
      this.#holdDeposit(id, to, q, since, until, `the signed ${payer.method} of rescue ${id} was not sent but stays usable until ${new Date(until).toISOString()}: it may still pay ${q.depositAddress}`);
      throw new StepFailed('deposit', `${payer.method} deposit: ${errorMessage(err)}`);
    }
    const inUsd = Number(q.amountInE8) / 1e8;
    const outUsd = Number(q.minAmountOutE8) / 1e8;
    this.#journal(run, `rescue ${id}: source ${run.from === 'hyperliquid' ? 'hyperliquid via Arbitrum' : run.from}, ${payer.method} sent ${inUsd.toFixed(2)} USDC to 1Click for ${to} (at least ${outUsd.toFixed(2)} arrives)`,
      { from: run.from, usd: 0, feeUsd: -round2(Number(q.costE8) / 1e8), amountUsd: round2(inUsd), signedS: round1(run.signedS) }, run.tx);
    try {
      await this.#o.oneClick.submitDeposit(depositTx, q.depositAddress);
    } catch (err) {
      // 1Click finds the deposit on its own too; the submit only speeds it up.
      this.#log(`rescue ${id}: /deposit/submit failed (1Click finds the deposit on its own): ${errorMessage(err)}`);
    }
    const timeout = this.#o.transferTimeoutMs ?? TRANSFER_TIMEOUT_MS;
    const until = this.#o.clock.now() + timeout;
    let last = 'unread';
    for (;;) {
      const s = await this.#o.oneClick.status(q.depositAddress).catch((err: unknown) => ({ status: `unread (${errorMessage(err)})`, body: null }));
      last = s.status;
      if (s.status === 'SUCCESS') return q;
      if (FINAL_STATUSES.includes(s.status)) {
        throw new StepFailed('deposit', `1Click ended the transfer ${s.status}: the refund goes back to ${payer.method === 'fund_venue' ? 'the desk owner on NEAR' : `the desk's ${payer.method === 'sol_sign_rescue' ? 'Solana' : 'Arbitrum'} address`}`);
      }
      if (this.#o.clock.now() >= until) {
        this.#holdDeposit(id, to, q, since, null, `rescue ${id}'s transfer to ${q.depositAddress} is ${last} at 1Click: it may still deliver`);
        throw new StepFailed('deposit', `1Click says ${last} after ${Math.round(timeout / 1000)} s: the transfer has not settled; GET /status?depositAddress=${q.depositAddress}`);
      }
      await this.#o.sleep(this.#o.pollMs ?? POLL_MS);
    }
  }

  /** After 1Click's SUCCESS: the credit (Phoenix), then the delivery found in the target's ledger. */
  async #landing(run: Run, q: VerifiedQuote, since: number, plan: Extract<Plan, { kind: 'transfer' }>): Promise<void> {
    const to = plan.to;
    const credit = this.#o.credit?.[to];
    if (credit !== undefined) {
      try {
        const { tx } = await credit.credit(q.minAmountOut, `rescue ${run.trigger.id}: the delivered USDC into ${to} margin`);
        run.tx.push(...tx);
      } catch (err) {
        if (err instanceof OutcomeUnknown) this.#unknown ??= `the ${to} credit of rescue ${run.trigger.id}: ${errorMessage(err)}`;
        throw new StepFailed('deposit', `1Click delivered, but moving it into ${to} margin failed: ${errorMessage(err)}`);
      }
    }
    const timeout = this.#o.landingTimeoutMs ?? LANDING_TIMEOUT_MS;
    const until = this.#o.clock.now() + timeout;
    for (;;) {
      const entry = await this.#o.landing.find(to, q, since, this.#seen).catch(() => null);
      if (entry !== null) {
        this.#seen.add(entry.id);
        run.tx.push(...entry.tx.filter((x) => !run.tx.some((y) => y.chain === x.chain && y.id === x.id)));
        return this.#land(run, entry.usd, q, plan);
      }
      if (this.#o.clock.now() >= until) {
        this.#holdDeposit(run.trigger.id, to, q, since, null, `rescue ${run.trigger.id}'s delivery is SUCCESS at 1Click but not yet in ${to}'s ledger`);
        throw new StepFailed('deposit', `1Click says SUCCESS but ${to}'s ledger shows no delivery of at least ${e8Text(q.minAmountOutE8)} USDC after ${Math.round(timeout / 1000)} s`);
      }
      await this.#o.sleep(this.#o.pollMs ?? POLL_MS);
    }
  }

  /** Both legs reduce-only by the same size: the leg in rescue needs `fraction` less margin. */
  async #reduce(run: Run, fraction: number): Promise<void> {
    const t = run.trigger;
    const reducer = this.#o.reducer?.() ?? null;
    if (reducer === null) throw new StepFailed('source', 'no pair trader holds the legs here');
    const i = reducer.legs.findIndex((l) => l.venue === t.venue && l.symbol === t.symbol);
    if (i === -1) throw new StepFailed('source', `the pair trader does not hold ${t.venue} ${t.symbol}`);
    let pos: [bigint, bigint];
    try {
      pos = await Promise.all(reducer.legs.map((l) => l.position())) as [bigint, bigint];
    } catch (err) {
      throw new StepFailed('source', `the legs could not be read: ${errorMessage(err)}`);
    }
    const held = abs(pos[i]!);
    if (held === 0n) throw new StepFailed('source', `${t.venue} ${t.symbol} holds nothing to reduce`);
    // Rounded up to the pair's lot so the leg frees at least what it needs, at most what the smaller leg holds.
    const want = BigInt(Math.ceil(Number(held) * fraction));
    let cut = floorToLot(want + reducer.lot - 1n, reducer.lot);
    const smaller = abs(pos[0]) < abs(pos[1]) ? abs(pos[0]) : abs(pos[1]);
    if (cut > smaller) cut = smaller;
    if (cut === 0n) throw new StepFailed('source', `a cut of ${(fraction * 100).toFixed(1)} % is under one lot ${qtyString(reducer.lot)}`);
    const targets = pos.map((p) => (p > 0n ? p - cut : p + cut)) as [bigint, bigint];
    this.#progress(run, 'sign');
    const started = this.#o.clock.now();
    let result: PairResult;
    try {
      result = await reducer.close({ reason: `rescue ${t.id}: reduce both legs by ${qtyString(cut)} (${(fraction * 100).toFixed(1)} %)`, targets, reduceOnly: true });
    } catch (err) {
      throw new StepFailed('sign', `the reduce failed: ${errorMessage(err)}`);
    }
    run.tx.push(...result.tx);
    run.signedS = (this.#o.clock.now() - started) / 1000;
    if (result.status !== 'closed') {
      throw new StepFailed('sign', `the reduce ended ${result.status}: ${result.notes.join('; ') || 'no notes'}`);
    }
    this.#journal(run, `rescue ${t.id}: reduced both legs reduce-only by ${qtyString(cut)}: ${result.legs.map((l) => `${l.venue} ${l.start} -> ${l.final ?? '?'}`).join(', ')}`,
      { from: t.venue, usd: 0, signedS: round1(run.signedS) }, result.tx);
    this.#land(run, null, null);
  }

  // ---- holds ----

  #holdDeposit(rescueId: string, venue: VenueId, q: VerifiedQuote, sinceMs: number, unusedAfterMs: number | null, why: string): void {
    if (this.#deposits.some((d) => d.q.depositAddress === q.depositAddress && d.rescueId === rescueId)) return;
    this.#deposits.push({ why, rescueId, venue, q, sinceMs, unusedAfterMs });
  }

  /** Reads each held deposit again; drops those 1Click settled (refunded, or delivered and seen in the ledger). */
  async #settleHolds(): Promise<void> {
    for (const d of [...this.#deposits]) {
      const s = await this.#o.oneClick.status(d.q.depositAddress).catch(() => null);
      if (s === null) continue;
      let settled: string | null = null;
      if (s.status === 'SUCCESS') {
        const entry = await this.#o.landing.find(d.venue, d.q, d.sinceMs, this.#seen).catch(() => null);
        if (entry !== null) {
          this.#seen.add(entry.id);
          settled = `rescue ${d.rescueId}'s ${entry.usd.toFixed(2)} USD landed on ${d.venue} late (after its rescue was failed)`;
        }
      } else if (FINAL_STATUSES.includes(s.status)) {
        settled = `rescue ${d.rescueId}'s transfer ended ${s.status} at 1Click: refunded, nothing landed`;
      } else if (s.status === 'PENDING_DEPOSIT' && d.unusedAfterMs !== null && this.#o.clock.now() > d.unusedAfterMs) {
        settled = `rescue ${d.rescueId}'s signed payment expired unused (1Click never saw a deposit)`;
      }
      if (settled === null) continue;
      this.#deposits.splice(this.#deposits.indexOf(d), 1);
      const t = this.#o.clock.now();
      this.#o.publish({ type: 'journal', data: { id: `rescue-${t.toString(36)}-${++this.#seq}`, t, kind: 'rescue', summary: this.#labelled(`${settled}; transfers are no longer held by it`), numbers: { venue: d.venue }, tx: [] } });
    }
  }

  // ---- endings ----

  #land(run: Run, landedUsd: number | null, q: VerifiedQuote | null, plan?: Extract<Plan, { kind: 'transfer' }>): void {
    if (run.ended) return;
    run.ended = true;
    const t = run.trigger;
    const elapsed = this.#elapsed(run);
    this.#progress(run, 'landed', true);
    const what = q === null
      ? (landedUsd === 0 ? 'nothing needed' : 'the legs were reduced')
      : `${landedUsd!.toFixed(2)} USD landed on ${t.venue}${plan?.from === 'hyperliquid' ? ' (via Arbitrum)' : ''}`;
    this.#journal(run, `rescue ${t.id} landed in ${Math.round(elapsed)} s: ${what}`, {
      from: run.from, landedS: round1(elapsed), ...(run.signedS === null ? {} : { signedS: round1(run.signedS) }),
      ...(q === null ? {} : { usd: 0, amountUsd: round2(landedUsd!), feeUsd: -round2(Number(q.costE8) / 1e8) }),
    }, q === null ? [] : run.tx);
    this.#o.failure?.(null);
    this.#o.ended(t.id, true);
  }

  #fail(run: Run, step: Exclude<RescueStep, 'landed' | 'failed'>, reason: string, next: string, journal = true): void {
    if (run.ended) return;
    run.ended = true;
    const t = run.trigger;
    this.#progress(run, 'failed', true);
    if (journal) this.#journal(run, `rescue ${t.id} failed at ${step}: ${reason}; ${next}`, { venue: t.venue, from: run.from, step, ...(t.attempt > 0 ? { attempt: t.attempt + 1 } : {}) });
    this.#o.failure?.({ rescueId: t.id, step, reason, tries: t.attempt + 1, next, at: this.#o.clock.now() });
    this.#log(`rescue ${t.id} failed at ${step}: ${reason}`);
    this.#o.ended(t.id, false);
  }

  // ---- events ----

  #elapsed(run: Run): number {
    return Math.max(0, (this.#o.clock.now() - run.startedAt) / 1000);
  }

  #progress(run: Run, step: RescueStep, final = false): void {
    if (run.ended && !final) return;
    run.step = step;
    const p: RescueProgress = {
      id: run.trigger.id, from: run.from, to: run.trigger.venue, amountUsd: run.amountUsd, step,
      startedAt: run.startedAt, elapsedS: round1(this.#elapsed(run)), tx: [...run.tx],
    };
    this.#o.publish({ type: 'rescue', data: p });
  }

  #labelled(summary: string): string {
    const label = this.#o.label ?? null;
    return label === null ? summary : `${summary} [${label}]`;
  }

  #journal(run: Run, summary: string, numbers: Record<string, number | string>, tx: TxRef[] = []): void {
    const t = this.#o.clock.now();
    void run;
    this.#o.publish({
      type: 'journal',
      data: { id: `rescue-${t.toString(36)}-${++this.#seq}`, t, kind: 'rescue', summary: this.#labelled(summary), numbers, tx: [...tx] },
    });
  }

  #log(line: string): void {
    this.#o.log?.(line);
  }
}

function planText(plan: Plan): string {
  if (plan.kind === 'none') return `nothing can pay: ${plan.reason}`;
  if (plan.kind === 'reduce') return `no transfer can pay, so both legs are reduced reduce-only by ${(plan.fraction * 100).toFixed(1)} %`;
  const via = plan.from !== 'hyperliquid' ? ''
    : plan.withdrawUsd === null ? ` (the USDC already on the desk's Arbitrum address, then evm_usdc_to_intents; ${plan.capUsd.toFixed(2)} USD of the rescue cap)`
    : ` (hl_withdraw ${plan.withdrawUsd.toFixed(2)} USDC to Arbitrum, then evm_usdc_to_intents; ${plan.capUsd.toFixed(2)} USD of the rescue cap)`;
  return `from ${plan.from}: ${plan.amountInUsd.toFixed(2)} USD, about ${plan.feeUsd.toFixed(2)} USD in fees${via}`;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** The quote's amounts as text, for logs. */
export function quoteText(q: VerifiedQuote): string {
  return `amountIn ${e8Text(q.amountInE8)}, minAmountOut ${e8Text(q.minAmountOutE8)}, cost ${e8Text(q.costE8)}, deposit ${q.depositAddress}`;
}
