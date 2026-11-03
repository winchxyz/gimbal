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
//   Hyperliquid -> X         the USDC the rescuer's own earlier withdraws left on the desk's Arbitrum address first;
//                            when short, an hl_withdraw to that address tops it up (no deposit; counts against the cap)
//                            and the rescuer waits for it there; then evm_usdc_to_intents (EIP-3009 via the relayer)
//                            -> 1Click
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
// run) until it is settled. A payment is held from just before it is signed (so a crash while signing leaves it held):
//   - a payment signed but not sent (its signature is public and stays usable: an EIP-3009 authorization until its
//     validBefore): held until 1Click settles it, or until the payment reads as one that can never run
//     (SignedPayment.neverRuns: past validBefore and authorizationState false) and 1Click, UNUSED_GRACE_MS after
//     that, still saw no deposit. A payer that cannot tell (no neverRuns) is held until 1Click settles it;
//   - sent and not settled by 1Click in time, or settled but not yet seen in the ledger: held until its deposit
//     address reaches a final 1Click status and, on SUCCESS, the delivery is found (journaled late);
//   - an OutcomeUnknown (the send or a signature may have run): held until the owner reconciles and clears `unknown`
//     in the state file (or removes the file) and restarts.
// A hold still open after RECONCILE_AFTER_MS is journaled once as "reconcile needed" with its deposit address,
// amounts and 1Click status, and stays held.
//
// The Hyperliquid route spends only Arbitrum USDC it can attribute to itself: what its own hl_withdraws brought there
// and it has not bridged (set aside when a bridge is signed, given back only if that payment expires unused). Any
// other USDC on the address (an Orderly money-out, a return started by the owner's tool, a 1Click refund) is never
// spent here, and the count never exceeds the address's balance. A withdraw only tops up what is there, so no amount
// left on Arbitrum blocks a withdraw. A withdraw accepted but not yet seen there holds new withdraws (not bridges of
// what is there) until it arrives or WITHDRAW_IN_FLIGHT_MS after it was accepted; then it is journaled once as
// "reconcile needed" and no longer taken as on its way. An Arbitrum balance that cannot be read stops the Hyperliquid
// source.
//
// With a state store (mainnet) the holds, the OutcomeUnknown, the Arbitrum USDC and the withdraw in flight, the cap
// meter and the matched ledger entries are saved in GIMBAL_STATE_DIR (state.ts) before every signature or withdraw and
// after every change, and loaded at start; each loaded hold is read again at 1Click and on chain before any new plan.
// The cap meter is this process's: with no state file (or without a store, on mainnet) it starts as if the whole
// hourly cap were used just before the engine started (the contract's counters have no view), the conservative bound
// of what the contract may still count, and the first line of the run says so. A state file that cannot be used is
// never taken as "no holds": every transfer is held and the cap starts full, until the owner repairs or removes it.
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
import { ASSETS, FINAL_STATUSES, deliveryHashes, e8Text, unitsOf, verifyQuote } from './oneclick.ts';
import type { Plan, Source } from './plan.ts';
import { CapLedger, HL_WITHDRAW_FEE_USD, SLIPPAGE_BPS, planRescue } from './plan.ts';
import type { Eip3009Ref, RescueState, RescueStateStore } from './state.ts';
import { RESCUE_STATE_VERSION, loadQuote, saveQuote } from './state.ts';

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
/** After a signed payment can no longer run, 1Click gets this long to index a deposit before PENDING_DEPOSIT is final. */
export const UNUSED_GRACE_MS = 10 * 60_000;
/** A hold still open after this is journaled once as "reconcile needed" (it stays held). */
export const RECONCILE_AFTER_MS = 30 * 60_000;
/** An hl_withdraw that did not arrive in time is taken as still on its way for this long after it was accepted. */
export const WITHDRAW_IN_FLIGHT_MS = 30 * 60_000;
/** The state file keeps this many matched ledger entries (the newest). */
export const SEEN_KEPT = 500;

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
  /**
   * True once no copy of this payment can ever run (EIP-3009: past validBefore and authorizationState still false).
   * Absent: the payer cannot tell, and a payment that failed to send stays held until 1Click settles it.
   */
  neverRuns?: () => Promise<boolean>;
  /** The EIP-3009 authorization signed (saved with the hold, so a restarted rescuer can still tell when it is dead). */
  authorization?: Eip3009Ref;
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
  /**
   * The entry that is this delivery: on `venue`, booked since `sinceMs`, at least minAmountOut, not one of `seen`;
   * the one whose hash is among `deliveryTx` (1Click's destinationChainTxHashes) first, when 1Click names it.
   */
  find(venue: VenueId, q: VerifiedQuote, sinceMs: number, seen: ReadonlySet<string>, deliveryTx?: readonly string[]): Promise<LedgerEntry | null>;
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
  /** Start the cap meter as if the whole cap were used at start (see the header); default: on mainnet with no saved state. */
  seedCap?: boolean;
  /** Where the holds and counters are kept across restarts (see the header); absent: in memory only. */
  store?: RescueStateStore;
  /** Whether a saved EIP-3009 authorization can never run any more (a loaded hold's neverRuns). */
  authorizationNeverRuns?: (a: Eip3009Ref) => Promise<boolean>;
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
}

/** A payment that may still move: held until 1Click settles it and, on SUCCESS, the ledger shows it. */
interface DepositHold {
  why: string;
  rescueId: string;
  venue: VenueId;
  q: VerifiedQuote;
  sinceMs: number;
  heldAt: number;
  reconcileSaid: boolean;
  /** The running rescue is still paying it (a crash then leaves it held as "may have been signed or sent"). */
  paying: boolean;
  /** A payment that failed to send: what tells it can never run (null: it was sent, so wait for a final status). */
  unsent: { neverRuns: (() => Promise<boolean>) | null; deadAt: number | null } | null;
  authorization: Eip3009Ref | null;
  /** The rescuer's own Arbitrum USDC set aside for it, × 1e6: given back if it expires unused. */
  reservedE6: bigint;
  /** 1Click's last status for it. */
  status: string | null;
}

/** An hl_withdraw accepted (or perhaps sent) and not yet seen on Arbitrum. */
interface InFlight {
  rescueId: string;
  /** What arrives (the amount less Hyperliquid's fee), × 1e6. */
  amountE6: bigint;
  /** The Arbitrum balance it arrives on top of (lowered when the rescuer's own bridges or others take USDC out). */
  baseE6: bigint;
  acceptedAt: number;
  untilMs: number;
}

const usdc = (e6: bigint) => (Number(e6) / 1e6).toFixed(2);

export class Rescuer {
  readonly #o: RescuerOptions;
  readonly #cap = new CapLedger();
  readonly #startedAt: number;
  /** How this run started: in memory only, from a saved state, with no state file, or with an unusable one. */
  readonly #start: 'memory' | 'loaded' | 'none' | 'unusable';
  readonly #seedFull: boolean;
  #capSeeded = false;
  #running: Run | null = null;
  #unknown: string | null = null;
  /** The state file could not be used: what an earlier run held is unknown (holds every transfer). */
  #stateProblem: string | null = null;
  /** Why the last save failed (null: it did not). */
  #saveProblem: string | null = null;
  readonly #deposits: DepositHold[] = [];
  /** Arbitrum USDC the rescuer's own hl_withdraws brought and it has not bridged or set aside, × 1e6. */
  #strandedE6 = 0n;
  #inFlight: InFlight | null = null;
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
    const seed = options.seedCap ?? options.mode === 'mainnet';
    const store = options.store;
    const capLine = seed ? ' The rescue cap counts as used in full for the first hour (the contract\'s counters have no view)' : '';
    if (store === undefined) {
      this.#start = 'memory';
      this.#seedFull = seed;
      if (seed) {
        this.#log("rescuer started: holds live in memory, so any transfer held before this restart is no longer held; reconcile earlier rescues' 1Click deposits and the Hyperliquid ledger." + capLine);
      }
      return;
    }
    const loaded = store.load();
    if (loaded.kind === 'loaded') {
      this.#start = 'loaded';
      this.#seedFull = false;
      this.#restore(loaded.state);
      const s = loaded.state;
      this.#log(`rescuer state loaded from ${store.path} (saved ${new Date(s.savedAt).toISOString()}): ${this.#deposits.length} held transfer(s)`
        + `${this.#unknown === null ? '' : ', an unknown outcome'}, ${usdc(this.#strandedE6)} USDC of its own on Arbitrum`
        + `${this.#inFlight === null ? '' : `, an hl_withdraw of rescue ${this.#inFlight.rescueId} on its way`}, ${this.capUsed().toFixed(2)} USD of the rescue cap used; `
        + 'each hold is read again at 1Click and on chain before the next plan');
    } else if (loaded.kind === 'none') {
      this.#start = 'none';
      this.#seedFull = seed;
      this.#log(`rescuer started with no state file at ${store.path}: taken as a first run, so any transfer an earlier run held is not known here; reconcile earlier rescues' 1Click deposits and the Hyperliquid ledger.${capLine}`);
    } else {
      this.#start = 'unusable';
      this.#seedFull = seed;
      this.#stateProblem = loaded.problem;
      this.#log(`rescuer state unusable: ${loaded.problem}. It is not taken as "no holds": every transfer is held (only reduces run) and the file is left as it is; `
        + `reconcile earlier rescues' 1Click deposits and the Hyperliquid ledger, then repair or remove the file and restart.${capLine}`);
    }
  }

  /** What the rescues of the last hour still weigh against the cap, USD. */
  capUsed(): number {
    return this.#cap.used(this.#o.clock.now());
  }

  /** Why transfers are held, or null. */
  get held(): string | null {
    const corrupt = this.#stateProblem === null ? null
      : `the rescuer's state file could not be used (${this.#stateProblem}), so what an earlier run held is unknown; reconcile, then repair or remove it and restart`;
    const all = [corrupt, this.#unknown, ...this.#deposits.map((d) => d.why)].filter((x): x is string => x !== null);
    return all.length === 0 ? null : all.join('; ');
  }

  /** Why no new hl_withdraw may go out, or null. */
  get hlWithdrawHeld(): string | null {
    const f = this.#inFlight;
    if (f === null) return null;
    return `rescue ${f.rescueId}'s hl_withdraw (${usdc(f.amountE6)} USDC to arrive) is not yet seen on the desk's Arbitrum address; taken as on its way until ${new Date(f.untilMs).toISOString()}`;
  }

  /** Arbitrum USDC the rescuer may spend: what its own withdraws left there unbridged, USD. */
  get arbitrumOwnUsd(): number {
    return Number(this.#strandedE6) / 1e6;
  }

  /** The id of the rescue running now, or null (the risk engine does not lapse it). */
  get runningId(): string | null {
    return this.#running?.trigger.id ?? null;
  }

  /** The risk engine's rescuer: starts the rescue and returns at once. */
  take(trigger: RescueTrigger): void {
    const run: Run = { trigger, from: trigger.from, amountUsd: trigger.amountUsd, startedAt: this.#o.clock.now(), tx: [], step: 'detect', ended: false, signedS: null };
    this.#progress(run, 'detect');
    if (this.#running !== null) {
      this.#fail(run, 'source', `rescue ${this.#running.trigger.id} of ${this.#running.trigger.venue} ${this.#running.trigger.symbol} is still running; one runs at a time`, 'tried again after the backoff');
      return;
    }
    this.#running = run;
    this.current = this.#run(run).catch((err: unknown) => {
      // A payment this run was making stays held: it may have been signed or sent.
      for (const d of this.#deposits) {
        if (d.paying) this.#park(d, `rescue ${d.rescueId} stopped unexpectedly while paying ${d.q.depositAddress} (${d.q.method}): it may have been signed or sent`, { neverRuns: this.#neverRunsOf(d.authorization), deadAt: null });
      }
      this.#persist();
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
      if (this.#seedFull) {
        this.#cap.add(desk.policy.rescue_cap_usd_per_hour, this.#startedAt);
        const why = this.#start === 'memory' ? 'holds live in memory, so any held transfer of an earlier run was dropped by the restart'
          : this.#start === 'none' ? `there was no state file (${this.#o.store!.path}), so any held transfer of an earlier run is not known here`
          : 'its state file could not be used, so every transfer is held until the owner repairs or removes it';
        const note = `rescuer started at ${new Date(this.#startedAt).toISOString()}: ${why}; `
          + `reconcile earlier rescues' 1Click deposits and the Hyperliquid ledger. The rescue cap counts as used in full (${desk.policy.rescue_cap_usd_per_hour} USD), freeing over the first hour: the contract's counters have no view`;
        this.#journal(run, note, {});
        this.#persist();
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
    // null: not read. It then stops the Hyperliquid source, and never counts as an empty address.
    const balanceE6 = this.#o.hlWithdraw === undefined ? undefined : await this.#o.hlWithdraw.arbitrumUsdcE6().then((e6) => e6, () => null);
    this.#settleHl(balanceE6);
    // Only the rescuer's own USDC on that address is offered to the plan.
    const arbitrumUsd = balanceE6 === undefined || balanceE6 === null ? balanceE6 : Number(balanceE6 < this.#strandedE6 ? balanceE6 : this.#strandedE6) / 1e6;
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
      hlWithdrawHeld: this.hlWithdrawHeld,
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
      if (plan.withdrawUsd !== null) await this.#hlOut(run, plan);
      else this.#journal(run, `rescue ${t.id}: source hyperliquid, ${plan.amountInUsd.toFixed(2)} USDC already on the desk's Arbitrum address (an earlier withdraw), no new withdraw`, { from: 'hyperliquid' });
      // Only what the rescuer's own withdraws left there, whatever else the address holds.
      let amountE6 = BigInt(Math.round(plan.amountInUsd * 1e6));
      if (amountE6 > this.#strandedE6) amountE6 = this.#strandedE6;
      if (amountE6 <= 0n) throw new StepFailed('source', 'none of the USDC on the desk\'s Arbitrum address is the rescuer\'s own to bridge');
      const hop = await this.#hop(run, 'arbitrum', to, Number(amountE6) / 1e6, desk, `rescue ${t.id}: Hyperliquid -> Arbitrum -> ${to}`, since);
      return this.#landing(run, hop, since, plan);
    }
    const payer = plan.from === 'reserve' ? 'reserve' : 'phoenix';
    const hop = await this.#hop(run, payer, to, plan.amountInUsd, desk, `rescue ${t.id}: ${plan.from} -> ${to}`, since);
    return this.#landing(run, hop, since, plan);
  }

  /** Hyperliquid -> the desk's Arbitrum address: hl_withdraw, then its USDC seen there and counted as the rescuer's own. */
  async #hlOut(run: Run, plan: Extract<Plan, { kind: 'transfer' }>): Promise<void> {
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
    // On its way from now until it is seen: saved first, so a crash mid-withdraw still holds the next one.
    this.#inFlight = { rescueId: t.id, amountE6: expectE6, baseE6, acceptedAt: signStart, untilMs: signStart + WITHDRAW_IN_FLIGHT_MS };
    if (!this.#persist()) {
      this.#inFlight = null;
      throw new StepFailed('sign', `the rescuer state could not be saved, so hl_withdraw was not sent: ${this.#saveProblem ?? 'unknown'}`);
    }
    try {
      ({ tx } = await port.withdraw(amountE6, `rescue ${t.id}: Hyperliquid margin to the desk's Arbitrum address for ${t.venue}`));
      this.#o.withdrawals?.('hyperliquid', null);
    } catch (err) {
      const why = errorMessage(err);
      if (/withdraw\w*\s+(are\s+|is\s+)?(paused|disabled|suspended)/i.test(why)) this.#o.withdrawals?.('hyperliquid', why);
      if (err instanceof OutcomeUnknown) {
        // It may have gone out: it stays on its way (no second withdraw) and every transfer is held.
        this.#unknown ??= `the hl_withdraw of rescue ${t.id} may have gone out (${why}); reconcile the Hyperliquid ledger before any other transfer`;
      } else {
        this.#inFlight = null;
      }
      this.#persist();
      throw new StepFailed('sign', `hl_withdraw ${usdc(amountE6)} USDC: ${why}`);
    }
    run.signedS = (this.#o.clock.now() - signStart) / 1000;
    run.tx.push(...tx);
    const topUp = plan.arbitrumUsd > 0 ? `, topping up the ${plan.arbitrumUsd.toFixed(2)} USDC an earlier withdraw left there` : '';
    this.#journal(run, `rescue ${t.id}: source hyperliquid, hl_withdraw ${usdc(amountE6)} USDC to the desk's Arbitrum address (1 USDC fee)${topUp}`, { from: 'hyperliquid', usd: 0, feeUsd: -HL_WITHDRAW_FEE_USD, signedS: round1(run.signedS) }, tx);
    this.#progress(run, 'deposit');
    const until = this.#o.clock.now() + (this.#o.withdrawTimeoutMs ?? WITHDRAW_TIMEOUT_MS);
    for (;;) {
      const now = await port.arbitrumUsdcE6().catch(() => null);
      if (now !== null && this.#withdrawArrived(now)) {
        this.#persist();
        return;
      }
      if (this.#o.clock.now() >= until) {
        throw new StepFailed('deposit', `hl_withdraw's ${usdc(expectE6)} USDC did not reach the desk's Arbitrum address within ${Math.round((this.#o.withdrawTimeoutMs ?? WITHDRAW_TIMEOUT_MS) / 1000)} s (measured 231 s)`);
      }
      await this.#o.sleep(this.#o.pollMs ?? POLL_MS);
    }
  }

  /** One 1Click transfer of `amountInUsd` from a payer into `to`: quote, verify, sign, deposit, until 1Click's SUCCESS. */
  async #hop(run: Run, payerKey: 'reserve' | 'phoenix' | 'arbitrum', to: VenueId, amountInUsd: number, desk: RescueDesk, reason: string, since: number): Promise<{ q: VerifiedQuote; deliveryTx: string[]; hold: DepositHold }> {
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
    // From Arbitrum the rescuer spends only its own withdraws' USDC, set aside from now on.
    const reserveE6 = payer.method === 'evm_usdc_to_intents' ? q.amountIn : 0n;
    if (reserveE6 > this.#strandedE6) {
      throw new StepFailed('verify', `the quote spends ${usdc(reserveE6)} USDC of the desk's Arbitrum address, more than the ${usdc(this.#strandedE6)} the rescuer's own hl_withdraws left there`);
    }
    this.#progress(run, 'sign');
    const signStart = this.#o.clock.now();
    // The contract counts a rescue transfer once the MPC network signs, even if it is never sent.
    if (payer.method !== 'fund_venue') this.#cap.add(Number(q.amountInE8) / 1e8, signStart);
    this.#strandedE6 -= reserveE6;
    // Held from before the signature: a crash while signing or sending leaves it held after a restart.
    const hold = this.#openHold(id, to, q, since, reserveE6, `rescue ${id} is paying ${q.depositAddress} (${payer.method}); it may be signed or sent`);
    if (!this.#persist()) {
      this.#dropHold(hold);
      this.#strandedE6 += reserveE6;
      throw new StepFailed('sign', `the rescuer state could not be saved, so nothing was signed: ${this.#saveProblem ?? 'unknown'}`);
    }
    let signed: SignedPayment;
    try {
      signed = await payer.sign(q, reason);
    } catch (err) {
      this.#dropHold(hold);
      if (err instanceof OutcomeUnknown) {
        // What was set aside stays spent: the payment may have been signed.
        this.#unknown ??= `the ${payer.method} of rescue ${id} may have been signed or paid (${errorMessage(err)}); reconcile it before any other transfer`;
      } else {
        this.#strandedE6 += reserveE6;
      }
      this.#persist();
      throw new StepFailed('sign', `${payer.method}: ${errorMessage(err)}`);
    }
    hold.authorization = signed.authorization ?? null;
    hold.why = `rescue ${id}'s signed ${payer.method} to ${q.depositAddress} is being sent`;
    this.#persist();
    run.tx.push(...signed.tx);
    run.signedS = (this.#o.clock.now() - signStart) / 1000;
    this.#progress(run, 'deposit');
    let depositTx: string;
    try {
      const sent = await signed.send();
      run.tx.push(...sent.tx.filter((x) => !run.tx.some((y) => y.chain === x.chain && y.id === x.id)));
      depositTx = sent.depositTx;
    } catch (err) {
      if (err instanceof OutcomeUnknown) {
        // No receipt, or the authorization already used: the payment may have run. Only the owner can settle it.
        this.#dropHold(hold);
        this.#unknown ??= `the ${payer.method} of rescue ${id} may have paid ${q.depositAddress} (${errorMessage(err)}); reconcile it before any other transfer`;
        this.#persist();
        throw new StepFailed('deposit', `${payer.method} deposit: ${errorMessage(err)}`);
      }
      // Signed is enough to pay: the signature is public (in the NEAR receipt) and anyone may send it while it is valid.
      const until = signed.usableUntilMs ?? this.#o.clock.now() + SIGNED_USABLE_MS;
      this.#park(hold, `the signed ${payer.method} of rescue ${id} was not sent but stays usable until ${new Date(until).toISOString()}: it may still pay ${q.depositAddress}`,
        { neverRuns: signed.neverRuns ?? this.#neverRunsOf(hold.authorization), deadAt: null });
      this.#persist();
      throw new StepFailed('deposit', `${payer.method} deposit: ${errorMessage(err)}`);
    }
    hold.reservedE6 = 0n;
    // The rescuer's own send took that much off the address: a withdraw on its way now lands on a lower balance.
    if (this.#inFlight !== null && reserveE6 > 0n) this.#inFlight.baseE6 = this.#inFlight.baseE6 > reserveE6 ? this.#inFlight.baseE6 - reserveE6 : 0n;
    hold.why = `rescue ${id}'s transfer to ${q.depositAddress} was sent and 1Click has not settled it`;
    this.#persist();
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
      if (!s.status.startsWith('unread')) hold.status = s.status;
      if (s.status === 'SUCCESS') return { q, deliveryTx: deliveryHashes(s.body), hold };
      if (FINAL_STATUSES.includes(s.status)) {
        this.#dropHold(hold);
        this.#persist();
        const back = payer.method === 'fund_venue' ? 'the desk owner on NEAR'
          : payer.method === 'sol_sign_rescue' ? 'the desk\'s Solana address'
          : 'the desk\'s Arbitrum address (not counted as the rescuer\'s own to spend: the owner moves it)';
        throw new StepFailed('deposit', `1Click ended the transfer ${s.status}: the refund goes back to ${back}`);
      }
      if (this.#o.clock.now() >= until) {
        this.#park(hold, `rescue ${id}'s transfer to ${q.depositAddress} is ${last} at 1Click: it may still deliver`, null);
        this.#persist();
        throw new StepFailed('deposit', `1Click says ${last} after ${Math.round(timeout / 1000)} s: the transfer has not settled; GET /status?depositAddress=${q.depositAddress}`);
      }
      await this.#o.sleep(this.#o.pollMs ?? POLL_MS);
    }
  }

  /** After 1Click's SUCCESS: the credit (Phoenix), then the delivery found in the target's ledger. */
  async #landing(run: Run, hop: { q: VerifiedQuote; deliveryTx: string[]; hold: DepositHold }, since: number, plan: Extract<Plan, { kind: 'transfer' }>): Promise<void> {
    const { q, deliveryTx, hold } = hop;
    const to = plan.to;
    const credit = this.#o.credit?.[to];
    if (credit !== undefined) {
      try {
        const { tx } = await credit.credit(q.minAmountOut, `rescue ${run.trigger.id}: the delivered USDC into ${to} margin`);
        run.tx.push(...tx);
      } catch (err) {
        // 1Click delivered: nothing more of this payment can move.
        this.#dropHold(hold);
        if (err instanceof OutcomeUnknown) this.#unknown ??= `the ${to} credit of rescue ${run.trigger.id}: ${errorMessage(err)}`;
        this.#persist();
        throw new StepFailed('deposit', `1Click delivered, but moving it into ${to} margin failed: ${errorMessage(err)}`);
      }
    }
    const timeout = this.#o.landingTimeoutMs ?? LANDING_TIMEOUT_MS;
    const until = this.#o.clock.now() + timeout;
    for (;;) {
      const entry = await this.#o.landing.find(to, q, since, this.#seen, deliveryTx).catch(() => null);
      if (entry !== null) {
        this.#seen.add(entry.id);
        this.#dropHold(hold);
        this.#persist();
        run.tx.push(...entry.tx.filter((x) => !run.tx.some((y) => y.chain === x.chain && y.id === x.id)));
        return this.#land(run, entry.usd, q, plan);
      }
      if (this.#o.clock.now() >= until) {
        this.#park(hold, `rescue ${run.trigger.id}'s delivery is SUCCESS at 1Click but not yet in ${to}'s ledger`, null);
        this.#persist();
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

  #openHold(rescueId: string, venue: VenueId, q: VerifiedQuote, sinceMs: number, reservedE6: bigint, why: string): DepositHold {
    const hold: DepositHold = { why, rescueId, venue, q, sinceMs, heldAt: this.#o.clock.now(), reconcileSaid: false, paying: true, unsent: null, authorization: null, reservedE6, status: null };
    this.#deposits.push(hold);
    return hold;
  }

  /** The rescue no longer pays it, and it may still move: held, with why. */
  #park(hold: DepositHold, why: string, unsent: DepositHold['unsent']): void {
    hold.paying = false;
    hold.why = why;
    hold.unsent = unsent;
    hold.heldAt = this.#o.clock.now();
    hold.reconcileSaid = false;
  }

  #dropHold(hold: DepositHold): void {
    const i = this.#deposits.indexOf(hold);
    if (i !== -1) this.#deposits.splice(i, 1);
  }

  #neverRunsOf(a: Eip3009Ref | null): (() => Promise<boolean>) | null {
    const f = this.#o.authorizationNeverRuns;
    return a === null || f === undefined ? null : () => f(a);
  }

  /** The withdraw on its way has arrived when the balance is up by its amount; then it is the rescuer's own. */
  #withdrawArrived(balanceE6: bigint): boolean {
    const f = this.#inFlight;
    if (f === null) return false;
    // Someone took USDC out meanwhile: what it arrives on is lower.
    if (balanceE6 < f.baseE6) f.baseE6 = balanceE6;
    if (balanceE6 - f.baseE6 < f.amountE6) return false;
    this.#strandedE6 += f.amountE6;
    this.#inFlight = null;
    return true;
  }

  /**
   * Before a plan: what the desk's Arbitrum address holds now. The rescuer's own count never exceeds it; a withdraw on
   * its way that arrived counts as its own; one not seen WITHDRAW_IN_FLIGHT_MS after it was accepted is said once as
   * "reconcile needed" and no longer taken as on its way.
   */
  #settleHl(balanceE6: bigint | null | undefined): void {
    if (balanceE6 === null || balanceE6 === undefined) return;
    const t = this.#o.clock.now();
    let changed = false;
    if (this.#strandedE6 > balanceE6) {
      this.#journalLine(`the desk's Arbitrum address holds ${usdc(balanceE6)} USDC, less than the ${usdc(this.#strandedE6)} the rescuer counted as its own (moved by someone else): it counts ${usdc(balanceE6)} from now on`, 'hyperliquid');
      this.#strandedE6 = balanceE6;
      changed = true;
    }
    const f = this.#inFlight;
    if (f !== null) {
      if (this.#withdrawArrived(balanceE6)) {
        this.#journalLine(`rescue ${f.rescueId}'s hl_withdraw reached the desk's Arbitrum address late (${usdc(f.amountE6)} USDC): it is bridged first by the next rescue out of Hyperliquid, and withdraws may run again`, 'hyperliquid');
        changed = true;
      } else if (t >= f.untilMs) {
        this.#inFlight = null;
        const line = `reconcile needed: rescue ${f.rescueId}'s hl_withdraw (${usdc(f.amountE6)} USDC to arrive, accepted at ${new Date(f.acceptedAt).toISOString()}) is not on the desk's Arbitrum address `
          + `after ${Math.round((t - f.acceptedAt) / 60_000)} min; it is no longer taken as on its way, so Hyperliquid may be withdrawn from again. Check the Hyperliquid ledger: USDC of it that arrives later is not counted as the rescuer's own`;
        this.#log(line);
        this.#journalLine(line, 'hyperliquid');
        changed = true;
      }
    }
    if (changed) this.#persist();
  }

  /** Reads each held deposit again; drops those 1Click settled (refunded, or delivered and seen in the ledger). */
  async #settleHolds(): Promise<void> {
    if (this.#deposits.length === 0) return;
    for (const d of [...this.#deposits]) {
      const s = await this.#o.oneClick.status(d.q.depositAddress).catch(() => null);
      if (s !== null) d.status = s.status;
      let settled: string | null = null;
      if (s === null) {
        // Unread: still held.
      } else if (s.status === 'SUCCESS') {
        const entry = await this.#o.landing.find(d.venue, d.q, d.sinceMs, this.#seen, deliveryHashes(s.body)).catch(() => null);
        if (entry !== null) {
          this.#seen.add(entry.id);
          settled = `rescue ${d.rescueId}'s ${entry.usd.toFixed(2)} USD landed on ${d.venue} late (after its rescue was failed)`;
        }
      } else if (FINAL_STATUSES.includes(s.status)) {
        settled = `rescue ${d.rescueId}'s transfer ended ${s.status} at 1Click: refunded, nothing landed`
          + `${d.q.method === 'evm_usdc_to_intents' ? ' (the refund on the desk\'s Arbitrum address is not counted as the rescuer\'s own: the owner moves it)' : ''}`;
      } else if (s.status === 'PENDING_DEPOSIT' && d.unsent !== null && d.unsent.neverRuns !== null) {
        // It can never run once neverRuns reads true; 1Click then gets UNUSED_GRACE_MS to index a deposit it missed.
        const now = this.#o.clock.now();
        const unsent = d.unsent;
        if (unsent.deadAt === null && await unsent.neverRuns!().catch(() => false)) unsent.deadAt = now;
        if (unsent.deadAt !== null && now - unsent.deadAt >= UNUSED_GRACE_MS) {
          settled = `rescue ${d.rescueId}'s signed payment can no longer run and 1Click saw no deposit ${Math.round(UNUSED_GRACE_MS / 60_000)} min later: expired unused`;
          if (d.reservedE6 > 0n) {
            // Never paid: the USDC it set aside is still on Arbitrum, the rescuer's own again.
            this.#strandedE6 += d.reservedE6;
            settled += `; its ${usdc(d.reservedE6)} USDC on Arbitrum is the rescuer's to spend again`;
          }
        }
      }
      if (settled === null) {
        const t = this.#o.clock.now();
        if (!d.reconcileSaid && t - d.heldAt >= RECONCILE_AFTER_MS) {
          d.reconcileSaid = true;
          const line = `reconcile needed: rescue ${d.rescueId}'s deposit ${d.q.depositAddress} (${e8Text(d.q.amountInE8)} USDC in, at least ${e8Text(d.q.minAmountOutE8)} out to ${d.venue}) `
            + `is ${s === null ? 'unread' : s.status} at 1Click after ${Math.round((t - d.heldAt) / 60_000)} min; transfers stay held until it is settled`;
          this.#log(line);
          this.#journalLine(line, d.venue);
        }
        continue;
      }
      this.#dropHold(d);
      this.#journalLine(`${settled}; transfers are no longer held by it`, d.venue);
    }
    this.#persist();
  }

  // ---- state on disk ----

  #restore(s: RescueState): void {
    this.#unknown = s.unknown;
    for (const h of s.holds) {
      const q = loadQuote(h.quote);
      const neverRuns = this.#neverRunsOf(h.authorization);
      this.#deposits.push({
        // Still being paid when it was saved: it may have been signed or sent since.
        why: h.paying ? `rescue ${h.rescueId} was paying ${q.depositAddress} (${q.method}) when the engine stopped: it may have been signed or sent` : h.why,
        rescueId: h.rescueId, venue: h.venue, q, sinceMs: h.sinceMs, heldAt: h.heldAt, reconcileSaid: h.reconcileSaid, paying: false,
        unsent: h.paying ? { neverRuns, deadAt: null } : h.unsent === null ? null : { neverRuns, deadAt: h.unsent.deadAt },
        authorization: h.authorization, reservedE6: BigInt(h.reservedE6), status: h.status,
      });
    }
    this.#strandedE6 = BigInt(s.hl.strandedE6);
    const f = s.hl.inFlight;
    this.#inFlight = f === null ? null : { rescueId: f.rescueId, amountE6: BigInt(f.amountE6), baseE6: BigInt(f.baseE6), acceptedAt: f.acceptedAt, untilMs: f.untilMs };
    for (const c of s.cap) this.#cap.add(c.usd, c.at);
    for (const id of s.seen) this.#seen.add(id);
  }

  #snapshot(): RescueState {
    const now = this.#o.clock.now();
    const f = this.#inFlight;
    return {
      version: RESCUE_STATE_VERSION,
      savedAt: now,
      unknown: this.#unknown,
      holds: this.#deposits.map((d) => ({
        why: d.why, rescueId: d.rescueId, venue: d.venue, quote: saveQuote(d.q), sinceMs: d.sinceMs, heldAt: d.heldAt, reconcileSaid: d.reconcileSaid,
        paying: d.paying, unsent: d.unsent === null ? null : { deadAt: d.unsent.deadAt }, authorization: d.authorization, reservedE6: d.reservedE6.toString(), status: d.status,
      })),
      hl: {
        strandedE6: this.#strandedE6.toString(),
        inFlight: f === null ? null : { rescueId: f.rescueId, amountE6: f.amountE6.toString(), baseE6: f.baseE6.toString(), acceptedAt: f.acceptedAt, untilMs: f.untilMs },
      },
      cap: this.#cap.entries(now),
      seen: [...this.#seen].slice(-SEEN_KEPT),
    };
  }

  /** Saves the state (when there is a store); false when it could not, and then nothing may be signed. */
  #persist(): boolean {
    const store = this.#o.store;
    if (store === undefined) return true;
    if (this.#stateProblem !== null) {
      // The unusable file stays as it is for the owner to look at.
      this.#saveProblem = `${store.path} is unusable and left as it is`;
      return false;
    }
    try {
      store.save(this.#snapshot());
      this.#saveProblem = null;
      return true;
    } catch (err) {
      this.#saveProblem = `${store.path}: ${errorMessage(err)}`;
      this.#log(`rescuer state not saved (${this.#saveProblem}): what is held stays held here, and nothing is signed until a save succeeds`);
      return false;
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

  /** A journal line of no run (a hold settled, reconcile needed). */
  #journalLine(summary: string, venue: VenueId): void {
    const t = this.#o.clock.now();
    this.#o.publish({ type: 'journal', data: { id: `rescue-${t.toString(36)}-${++this.#seq}`, t, kind: 'rescue', summary: this.#labelled(summary), numbers: { venue }, tx: [] } });
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
    : ` (hl_withdraw ${plan.withdrawUsd.toFixed(2)} USDC to Arbitrum${plan.arbitrumUsd > 0 ? `, with the ${plan.arbitrumUsd.toFixed(2)} already there` : ''}, then evm_usdc_to_intents; ${plan.capUsd.toFixed(2)} USD of the rescue cap)`;
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
