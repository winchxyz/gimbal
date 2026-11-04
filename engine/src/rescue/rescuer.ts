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
//   - sent, and not settled by 1Click in time, or settled but not yet seen in the ledger: held until its deposit
//     address reaches a final 1Click status and, on SUCCESS, the delivery is found (journaled late). INCOMPLETE_DEPOSIT
//     is not final here: part of the money is at 1Click, which may still refund it, so it stays held;
//   - not known to be sent (the send failed, a crash, or an OutcomeUnknown while signing or sending): its signature
//     may be public and usable, so it is held until 1Click settles it, or until the chain proves it can never run
//     (#canNeverRun). Only chain facts count, never how long ago it was asked: a congested NEAR call stays valid for
//     about a day and may land long after the engine gave up on it. The bound is the quote's: the contract signs it
//     only before payableUntilMs (the earlier of its deadline and an hour after 1Click signed it), whenever the call
//     lands. Otherwise, per method:
//       never signed, any method (released at once): the deposit ring of that method (get_desk_counters' for the
//         rescues, the fund_venue record read from the contract state for fund_venue), read at a final NEAR block
//         whose time is past payableUntilMs + CHAIN_MARGIN_S, does not hold the deposit address, and still has a slot
//         empty or older than the hold (so it was not pushed out by 32 later payments);
//       fund_venue: the contract sends the USDC in a later receipt, which can run long after the call under
//         congestion, so time never releases it. With its NEAR transaction known and final (every receipt executed):
//         released at once only on positive proof it paid nothing (the call failed, its USDC ft_transfer receipt
//         failed, or on_fund_venue returned false); a transfer to the deposit address in it, of any amount, is paid,
//         held until 1Click settles it; neither: held for the owner (a missing log is no proof). In the ring with no
//         transaction known: held until the owner reconciles it;
//       evm_usdc_to_intents: a USDC Transfer from the desk to the deposit address since the block before signing
//         proves it ran (held until 1Click settles it). Dead (released once 1Click, UNUSED_GRACE_MS later and with
//         the chain read again, still saw no deposit): a signed authorization the rescuer has, with the Arbitrum head
//         past its validBefore + CHAIN_MARGIN_S and authorizationState there false; or the ring holds it, paid at P
//         (valid until P + 300 s), with the head (whose logs were read) past that plus CHAIN_MARGIN_S; or, without
//         the view or with a ring that turned over, the head past payableUntilMs + NO_VIEW_SETTLE_MS (the 300 s
//         validity, the MPC network's answer and margin). Without the authorization, every nonce from the counter
//         read before signing up to eip3009_next must also be unused at that head (authorizationState), so a release
//         never rests on the logs alone;
//       sol_sign_rescue: its message's lastValidBlockHeight is saved before signing. Dead once Solana's finalized
//         height is past it (no later block can include it) and the cluster does not know its signature; with no
//         signature known it is held until the owner reconciles it;
//   - an OutcomeUnknown of an hl_withdraw or of a Phoenix credit: held until the owner reconciles it and clears
//     `unknown` in the state file (MANUAL_CLEAR) and restarts.
// A hold still open after RECONCILE_AFTER_MS is journaled once as "reconcile needed" with its deposit address,
// amounts, 1Click status and how to clear it by hand, and stays held.
//
// The Hyperliquid route spends only Arbitrum USDC it can attribute to itself: a withdraw counts as arrived only by a
// USDC Transfer log from Hyperliquid's Bridge2 to the desk address of exactly the amount it expects (each log counted
// once), so no other flow's USDC (an Orderly money-out, the owner's return, a 1Click refund) is ever taken for it. What
// its own withdraws brought and it has not bridged is set aside when a bridge is signed and given back only if that
// payment can never run; the count never exceeds the address's balance, read at the same block as the logs. A
// withdraw only tops up what is there, so no amount left on Arbitrum blocks a withdraw. A withdraw accepted but not
// yet seen holds new withdraws (not bridges of what is there) until it arrives or WITHDRAW_IN_FLIGHT_MS after it was
// accepted; then it is journaled once as "reconcile needed" (with its Hyperliquid transactions) and no longer taken as
// on its way. A Bridge2 Transfer names no withdraw, so for EXPIRED_KEPT_MS no new withdraw brings the exact amount of
// one that never showed (it takes a cent more): a late Transfer of the old one is never taken for the new one.
// Arbitrum that cannot be read stops the Hyperliquid source. Logs are read only past the last block read (per hold
// and per withdraw), so a long wait does not read the same range again.
//
// With a state store (mainnet) the holds, the OutcomeUnknown, the Arbitrum USDC and the withdraws, the cap meter and
// the matched ledger entries and logs are saved (state.ts) after every change and loaded at start; each loaded hold is
// read again at 1Click and on chain before any new plan. The save before a signature or a withdraw must succeed or
// neither is asked for; a later save that fails is logged, and what it held stays held in memory. A missing state
// file is never a first run: like an unusable one, every transfer is then held (reduces still run) and the cap starts
// full, until the owner reconciles and starts once with `fresh` (GIMBAL_RESCUE_FRESH=<contract>/<desk>, refused by
// serve while the contract counted a rescue or a fund_venue of the desk, or the state directory shows a trace of
// one of its rescuers, in the last 65 min), which writes an empty state. The state
// belongs to one desk EVM address: when get_desk names another one mid-run, every transfer is held until a restart.
// The cap meter is this process's: when nothing is loaded (or without a store, on mainnet) it starts as if the whole
// hourly cap were used just before the engine started, and the first line of the run says so.
//
// The rescue sizes each route takes at the desk's policy (plan.ts rescueSizes) are logged at the first rescue and
// named in the journal when a rescue ends in a reduce or in nothing. At the final mainnet policy (a 50 USD cap) with a
// 1Click key: from 2.86 USD into Hyperliquid, 10.39 to 24.31 USD out of Hyperliquid (none at a 20 USD cap).
//
// One rescue runs at a time: a trigger that comes while one runs ends at once as failed (tried again after the
// backoff); runningId tells the risk engine not to count a running rescue as lapsed. A desk that is closing
// (panic_close) starts no rescue.

import type { ContractPolicy, Leg, Mode, RescueFailure, RescueProgress, StreamEvent, TxRef, VenueId } from '@gimbal/shared';
import { OutcomeUnknown } from '../contract/types.ts';
import type { RescueTrigger } from '../risk/engine.ts';
import type { PairResult } from '../trade/pair.ts';
import type { TradeLeg } from '../trade/legs.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import { abs, floorToLot, qtyString } from '../trade/lots.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';
import type { ArbitrumHead, ArbitrumReads } from './arbitrum-chain.ts';
import { HL_BRIDGE2 } from './arbitrum-chain.ts';
import { eip3009Nonce } from '../contract/replay-client.ts';
import type { NearDeskCounters, NearRead, NearTxFacts } from './near-chain.ts';
import { depositKey, ringEntry, ringHolds } from './near-chain.ts';
import type { SolanaReads } from './solana-chain.ts';
import type { DeskAddresses, OneClickApi, QuoteRequest, QuotedMethod, QuoteResponse, VerifiedQuote } from './oneclick.ts';
import { ASSETS, FINAL_STATUSES, deliveryHashes, e8Text, payableUntilMs, unitsOf, verifyQuote } from './oneclick.ts';
import type { Plan, Source } from './plan.ts';
import { CapLedger, HL_WITHDRAW_FEE_USD, SLIPPAGE_BPS, planRescue, rescueSizes, sizeText } from './plan.ts';
import type { Eip3009Ref, RescueSnapshot, RescueState, RescueStateStore, SavedWithdraw } from './state.ts';
import { MANUAL_CLEAR, RESCUE_STATE_VERSION, loadQuote, saveQuote } from './state.ts';

/** How often 1Click's status, the Arbitrum logs and the target's ledger are read while a rescue waits. */
export const POLL_MS = 5_000;
/** A 1Click transfer not SUCCESS after this is failed and held (measured 45–95 s; the quote's estimate was half that). */
export const TRANSFER_TIMEOUT_MS = 10 * 60_000;
/** hl_withdraw's USDC not on Arbitrum after this is failed (measured 231 s). */
export const WITHDRAW_TIMEOUT_MS = 15 * 60_000;
/** The delivery not in the target's ledger after 1Click's SUCCESS within this is failed and held (Orderly: 1–2 min). */
export const LANDING_TIMEOUT_MS = 5 * 60_000;
/** How long the owner line waits for the desk wallet's balance (desk read plus one RPC call): it never holds up a stop. */
export const WALLET_READ_MS = 10_000;
/** A signed payment with no validity of its own is said to be usable this long (a 1Click deposit address lives 30 min). */
export const SIGNED_USABLE_MS = 35 * 60_000;
/** After a signed payment can no longer run, 1Click gets this long to index a deposit before PENDING_DEPOSIT is final. */
export const UNUSED_GRACE_MS = 10 * 60_000;
/** A hold still open after this is journaled once as "reconcile needed" (it stays held). */
export const RECONCILE_AFTER_MS = 30 * 60_000;
/** An hl_withdraw that did not arrive in time is taken as still on its way for this long after it was accepted. */
export const WITHDRAW_IN_FLIGHT_MS = 30 * 60_000;
/** The state file keeps this many matched ledger entries and logs (the newest). */
export const SEEN_KEPT = 500;
/** The contract's EIP-3009 authorization is valid until its signing block's time plus this, s. */
export const EIP3009_VALIDITY_S = 300;
/** At most this many EIP-3009 nonces (pre-sign counter up to eip3009_next) are read before a release; more: held. */
export const NONCES_READ = 32n;
/** 1Click statuses that settle a deposit: INCOMPLETE_DEPOSIT is final at 1Click but leaves money there to refund. */
const SETTLED_STATUSES = FINAL_STATUSES.filter((s) => s !== 'INCOMPLETE_DEPOSIT');
/**
 * With no ring to read: past the quote's payableUntilMs by this, on Arbitrum (EIP-3009) or NEAR time, a signature
 * the contract made just before then can no longer run (validBefore is its block time + 300 s, then the MPC
 * network's answer and margin).
 */
export const NO_VIEW_SETTLE_MS = 15 * 60_000;
/** Chain times are compared with this margin (block timestamps against each other and against clocks elsewhere). */
export const CHAIN_MARGIN_S = 60;
/** The engine's clock against NEAR block time, at most: a ring slot older than a hold by this was paid before it. */
export const CLOCK_SKEW_MS = 5 * 60_000;
/** A withdraw that never showed blocks a new withdraw of its exact amount this long, and at most EXPIRED_KEPT of them. */
export const EXPIRED_KEPT_MS = 24 * 3_600_000;
export const EXPIRED_KEPT = 10;

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
  /** The EIP-3009 authorization signed: saved with the hold, so whether it can still run is read on Arbitrum. */
  authorization?: Eip3009Ref;
  /** sol_sign_rescue: the Solana transaction's signature, read on Solana while the payment is held. */
  solanaSignature?: string;
}

/** What a payer fixes before the contract signs, saved with the hold first (sol_sign_rescue: its blockhash's bound). */
export interface PreparedPayment {
  solana?: { lastValidBlockHeight: number };
}

/** Pays a verified quote from one source: fund_venue, sol_sign_rescue or evm_usdc_to_intents. */
export interface Payer {
  readonly method: QuotedMethod;
  /** sol_sign_rescue must have it: the message (and its recent blockhash) is built here, before the hold is saved. */
  prepare?(quote: VerifiedQuote): Promise<PreparedPayment>;
  sign(quote: VerifiedQuote, reason: string, prepared?: PreparedPayment): Promise<SignedPayment>;
}

/** Hyperliquid's way out: hl_withdraw to the desk's EVM address on Arbitrum (its arrival is read in ArbitrumReads). */
export interface HlWithdrawPort {
  /** Signs and posts withdraw3 of `amountE6` (USDC × 1e6); resolves once Hyperliquid accepted it. */
  withdraw(amountE6: bigint, reason: string): Promise<{ tx: TxRef[] }>;
}

/** After 1Click delivered to a venue's wallet: what moves it into that venue's margin (Phoenix: a deposit). */
export interface CreditPort {
  /**
   * Why the venue could not take the USDC into margin now (null: it can), asked before anything is paid: a transfer
   * that lands where no deposit can follow is not started.
   */
  ready?(): Promise<string | null>;
  /** What the venue's wallet holds now, x 1e6: read just before a hold opens and saved with it (the delivery counts above it). */
  baseline?(): Promise<bigint>;
  /** How the owner moves `amountE6` left waiting on the venue's wallet into margin (the rescuer never does it late). */
  manual?(amountE6: bigint): string;
  credit(amountE6: bigint, reason: string, options?: CreditOptions): Promise<{ tx: TxRef[] }>;
}

/** What a credit is told besides the amount. */
export interface CreditOptions {
  /** The delivery's transactions as 1Click's SUCCESS names them (destinationChainTxHashes). */
  deliveryTx?: readonly string[];
  /** What the venue's wallet held before the payment (null: not read): the delivery counts above it. */
  baseE6?: bigint | null;
  /** True once serve is stopping: a credit still waiting for the delivery gives up with nothing signed. */
  stopping?: () => boolean;
  /**
   * Called right before the deposit is signed, after every check that refuses it: true once the hold's "credit
   * started" marker is saved. False (the save failed): the credit signs nothing.
   */
  beforeSign?: () => boolean;
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
   * The entry that is this delivery: on `venue`, booked since `sinceMs` (when the payment's hold opened, just before
   * its signature), at least minAmountOut, not one of `seen`; the one whose hash is among `deliveryTx` (1Click's
   * destinationChainTxHashes) first, when 1Click names it.
   */
  find(venue: VenueId, q: VerifiedQuote, sinceMs: number, seen: ReadonlySet<string>, deliveryTx?: readonly string[]): Promise<LedgerEntry | null>;
}

/** The pair trader's close, as a reduce uses it. */
export interface Reducer {
  readonly legs: readonly [TradeLeg, TradeLeg];
  readonly lot: bigint;
  /** `by`: which protection closes (the book takes it as an exit or a partial fill outside the loop). */
  close(request: { reason: string; targets?: [bigint, bigint]; reduceOnly?: boolean; by?: 'panic_close' | 'rescue reduce' | 'ADL unwind' }): Promise<PairResult>;
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
  /** The desk's Arbitrum address as the Hyperliquid route and the EIP-3009 holds read it; absent: no Hyperliquid source. */
  arbitrum?: ArbitrumReads;
  /**
   * A final NEAR block's time and get_desk_counters at that block (near-chain.ts; counters null before C10). Absent
   * (the recorded worlds): the clock is NEAR time and there is no ring.
   */
  near?: () => Promise<NearRead>;
  /** A NEAR transaction's final outcome (near-chain.ts): whether a held fund_venue paid. Absent: a held fund_venue is cleared only by the ring or by hand. */
  nearTx?: (hash: string) => Promise<NearTxFacts>;
  /** Solana's finalized height and signature statuses: whether a held sol_sign_rescue can still land. Absent: held. */
  solana?: SolanaReads;
  credit?: Partial<Record<VenueId, CreditPort>>;
  /** Why a route whose parts are all wired is still not run here (mainnet: not yet dry-run end to end), or null. */
  routeLimit?: (from: Source, to: VenueId) => string | null;
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
  /** A first run (GIMBAL_RESCUE_FRESH, checked by serve): with no state file, start from an empty one. Ignored when a file exists. */
  fresh?: boolean;
  /** Said in every journal line of a rescue that moves nothing real (testnet, replay). */
  label?: string | null;
  log?: (line: string) => void;
  pollMs?: number;
  transferTimeoutMs?: number;
  withdrawTimeoutMs?: number;
  landingTimeoutMs?: number;
  /** The bound on the wallet read behind a credit venue's owner line (real time); default WALLET_READ_MS. */
  walletReadMs?: number;
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
  /** RescueProgress.amountUsd: what the leg needs, then what the planned transfer sends, then what landed. */
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
  /** When it was opened, just before the signature was asked for. */
  heldAt: number;
  reconcileSaid: boolean;
  /** The running rescue is still paying it (a crash then leaves it held as "may have been signed or sent"). */
  paying: boolean;
  /** Not known to be sent: bounded by #canNeverRun; deadAt is when the chain last began to read it as never able to run. */
  unsent: { deadAt: number | null } | null;
  authorization: Eip3009Ref | null;
  /** The Arbitrum head before signing, where a payment's Transfer log would start (EIP-3009 only). */
  arbBlock: bigint | null;
  /** The last block its Transfer logs were read up to; the next read starts after it. */
  scannedTo: bigint | null;
  /** The Transfer log of its payment, once seen: it ran, so only 1Click settles it. */
  paidLog: string | null;
  /** The rescuer's own Arbitrum USDC set aside for it, × 1e6: given back if it can never run. */
  reservedE6: bigint;
  /** 1Click's last status for it. */
  status: string | null;
  /** EIP-3009: the desk's eip3009_next before signing (null: no view). */
  counter: bigint | null;
  /** The NEAR transaction of its call, once known. */
  nearTx: string | null;
  /** sol_sign_rescue: lastValidBlockHeight of its message, and its signature once known. */
  solana: { lastValidBlockHeight: number; signature: string | null } | null;
  /** Into a venue with a credit (Phoenix): what the desk's wallet there held before the payment, x 1e6 (null: not read). */
  creditBaseE6: bigint | null;
  /** The credit's deposit was about to be signed (saved first): it may have run, whatever this run remembers. */
  creditStarted: boolean;
  /** fund_venue: the proof its transaction paid nothing, as last read (for the journal; not saved). */
  noPay?: string;
}

/** What a hold is opened with, before the signature is asked for. */
interface HoldStart {
  rescueId: string;
  venue: VenueId;
  q: VerifiedQuote;
  sinceMs: number;
  reservedE6: bigint;
  arbBlock: bigint | null;
  counter: bigint | null;
  solana: { lastValidBlockHeight: number } | null;
  creditBaseE6: bigint | null;
  why: string;
}

/** An hl_withdraw accepted (or perhaps sent) and not yet seen on Arbitrum. */
interface InFlight {
  rescueId: string;
  /** What arrives (the amount less Hyperliquid's fee), × 1e6: the exact value of its Bridge2 Transfer. */
  amountE6: bigint;
  /** The Arbitrum head before it was sent: its Transfer log is looked for from here. */
  fromBlock: bigint;
  acceptedAt: number;
  untilMs: number;
  /** The last block its Bridge2 Transfer was looked for up to. */
  scannedTo: bigint | null;
  /** Its Hyperliquid transactions, for the owner's reconcile. */
  tx: TxRef[];
}

/** The desk's Arbitrum address at one block. */
interface ArbitrumRead {
  head: ArbitrumHead;
  balanceE6: bigint;
}

type Start = 'memory' | 'loaded' | 'fresh' | 'missing' | 'unusable';

const usdc = (e6: bigint) => (Number(e6) / 1e6).toFixed(2);

/**
 * The least USDC × 1e6 the operator's hl_withdraw may move (contract/src/rescue.rs operator_min_withdraw_e8):
 * max(10 × the policy's max_transfer_cost_flat_e6, 10 USDC). The contract refuses less with E_SIZE.
 */
export function operatorMinWithdrawE6(maxTransferCostFlatE6: number): bigint {
  const tenFlats = 10n * BigInt(maxTransferCostFlatE6);
  return tenFlats > 10_000_000n ? tenFlats : 10_000_000n;
}

export class Rescuer {
  readonly #o: RescuerOptions;
  readonly #cap = new CapLedger();
  readonly #startedAt: number;
  /** How this run started: in memory only, from a saved state, a first run, or with no or an unusable state file. */
  readonly #start: Start;
  readonly #seedFull: boolean;
  #capSeeded = false;
  #running: Run | null = null;
  #unknown: string | null = null;
  /** The state file is missing or could not be used: what an earlier run held is unknown (holds every transfer). */
  #stateProblem: string | null = null;
  /** Why the last save failed (null: it did not). */
  #saveProblem: string | null = null;
  readonly #deposits: DepositHold[] = [];
  /** Arbitrum USDC the rescuer's own hl_withdraws brought and it has not bridged or set aside, × 1e6. */
  #strandedE6 = 0n;
  #inFlight: InFlight | null = null;
  /** Withdraws that never showed (newest last): no new withdraw brings one's exact amount (see the header). */
  #expired: InFlight[] = [];
  /** The desk EVM address the Arbitrum state belongs to: the state file's, else the first get_desk's. */
  #evm: string | null;
  /** The desk id the EIP-3009 nonces are derived from: the state file's, else get_desk's. */
  #deskId: string | null;
  /** get_desk named another EVM address: every transfer is held until a restart. */
  #evmProblem: string | null = null;
  #minimumsSaid = false;
  /** Ledger entry ids and Arbitrum log ids (`arb:` + id) already matched. */
  readonly #seen = new Set<string>();
  #seq = 0;
  #closingSaid = false;
  /** The run in flight (tests and serve's shutdown wait on it). */
  current: Promise<void> | null = null;
  /** serve is shutting down (stop): no rescue starts and nothing new is signed. */
  #stopping = false;

  constructor(options: RescuerOptions) {
    // 1Click has no testnet: a live 1Click off mainnet would move real mainnet money for a test desk.
    if (options.mode !== 'mainnet' && options.oneClick.source === 'live') {
      throw new Error(`the rescue runs live only on mainnet; ${options.mode} takes 1Click's answers from a recording`);
    }
    this.#o = options;
    this.#startedAt = options.clock.now();
    this.#evm = options.store?.identity.evm ?? null;
    this.#deskId = options.store?.identity.deskId ?? null;
    const seed = options.seedCap ?? options.mode === 'mainnet';
    const store = options.store;
    const capLine = seed ? ' The rescue cap counts as used in full for the first hour (the contract\'s counters have no view)' : '';
    const reconcile = "reconcile earlier rescues' 1Click deposits, the desk's Arbitrum address and the Hyperliquid ledger";
    if (store === undefined) {
      this.#start = 'memory';
      this.#seedFull = seed;
      if (seed) this.#log(`rescuer started: holds live in memory, so any transfer held before this restart is no longer held; ${reconcile}.${capLine}`);
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
        + 'each hold is read again at 1Click and on chain before the next plan'
        + `${options.fresh === true ? '. GIMBAL_RESCUE_FRESH is ignored: a state file exists' : ''}`);
    } else if (loaded.kind === 'none' && options.fresh === true) {
      this.#start = 'fresh';
      this.#seedFull = seed;
      this.#log(`rescuer first run (GIMBAL_RESCUE_FRESH): there is no state file at ${store.path}, so an empty one is written now; anything an earlier run held is not known here.${capLine}`);
      this.#persist();
    } else {
      this.#start = loaded.kind === 'none' ? 'missing' : 'unusable';
      this.#seedFull = seed;
      this.#stateProblem = loaded.kind === 'none' ? `there is no state file at ${store.path}` : loaded.problem;
      const what = loaded.kind === 'none'
        ? `rescuer state missing: there is no file at ${store.path}. A missing file is not taken as a first run (another checkout, a cleaned directory or a lost file may hide a parked payment)`
        : `rescuer state unusable: ${loaded.problem}. It is not taken as "no holds"`;
      const fix = loaded.kind === 'none'
        ? `then start once with ${this.#freshEnv()} to begin with an empty state`
        : `then repair the file, or move it aside and start once with ${this.#freshEnv()}`;
      this.#log(`${what}: every transfer is held (only reduces run) and nothing is written there; ${reconcile}, ${fix}.${capLine}`);
    }
  }

  /** What the rescues of the last hour still weigh against the cap, USD. */
  capUsed(): number {
    return this.#cap.used(this.#o.clock.now());
  }

  /** Why transfers are held, or null. */
  get held(): string | null {
    const state = this.#stateProblem === null ? null
      : `the rescuer's state file could not be used (${this.#stateProblem}), so what an earlier run held is unknown; reconcile, then repair it or start once with ${this.#freshEnv()}`;
    const all = [state, this.#evmProblem, this.#unknown, ...this.#deposits.map((d) => d.why)].filter((x): x is string => x !== null);
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

  /**
   * serve's shutdown: no rescue starts from now on, a running one signs nothing new, and one whose payment is already
   * signed or sent stops waiting for 1Click and the ledger once that payment is saved (its hold keeps it for the next
   * start, which reads it again at 1Click and on chain). Resolves when the running rescue has ended; never rejects.
   */
  stop(): Promise<void> {
    this.#stopping = true;
    return this.#running === null ? Promise.resolve() : (this.current ?? Promise.resolve());
  }

  /** The risk engine's rescuer: starts the rescue and returns at once. */
  take(trigger: RescueTrigger): void {
    const run: Run = { trigger, from: trigger.from, amountUsd: trigger.amountUsd, startedAt: this.#o.clock.now(), tx: [], step: 'detect', ended: false, signedS: null };
    this.#progress(run, 'detect');
    if (this.#stopping) {
      this.#fail(run, 'source', 'the engine is stopping: no rescue starts', 'tried again after the next start');
      return;
    }
    if (this.#running !== null) {
      this.#fail(run, 'source', `rescue ${this.#running.trigger.id} of ${this.#running.trigger.venue} ${this.#running.trigger.symbol} is still running; one runs at a time`, 'tried again after the backoff');
      return;
    }
    this.#running = run;
    this.current = this.#run(run).catch((err: unknown) => {
      // A payment this run was making stays held: it may have been signed or sent.
      for (const d of this.#deposits) {
        if (d.paying) this.#park(d, `rescue ${d.rescueId} stopped unexpectedly while paying ${d.q.depositAddress} (${d.q.method}): it may have been signed or sent`, { deadAt: null });
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
          : this.#start === 'fresh' ? `a first run (${this.#freshEnv()}), so any held transfer of an earlier run is not known here`
          : this.#start === 'missing' ? `there is no state file (${this.#o.store!.path}), so every transfer is held until the owner starts once with ${this.#freshEnv()}`
          : 'its state file could not be used, so every transfer is held until the owner repairs it';
        const note = `rescuer started at ${new Date(this.#startedAt).toISOString()}: ${why}; `
          + `reconcile earlier rescues' 1Click deposits and the Hyperliquid ledger. The rescue cap counts as used in full (${desk.policy.rescue_cap_usd_per_hour} USD), freeing over the first hour: the contract's counters have no view`;
        this.#journal(run, note, {});
        this.#persist();
      }
    }
    if (!this.#minimumsSaid) {
      this.#minimumsSaid = true;
      this.#log(`rescue sizes at this desk's policy (${desk.policy.rescue_cap_usd_per_hour} USD an hour, ${desk.policy.max_transfer_cost_bps} bps, `
        + `${(desk.policy.max_transfer_cost_flat_e6 / 1e6).toFixed(2)} USD flat): ${minimumsText(desk.policy, this.#o.keyed === true)}; a smaller rescue reduces both legs instead`);
    }
    // The Arbitrum state (the rescuer's own USDC, the withdraws, the holds' logs) belongs to one desk address.
    const evmNow = desk.addresses.evm.toLowerCase();
    if (this.#evm === null) this.#evm = evmNow;
    this.#deskId ??= desk.addresses.deskId;
    if (evmNow !== this.#evm && this.#evmProblem === null) {
      this.#evmProblem = `get_desk names the desk EVM address ${evmNow}, not ${this.#evm} that this rescuer's Arbitrum state belongs to; every transfer is held until the engine is restarted (a new address starts a new state file)`;
      this.#log(this.#evmProblem);
      this.#journal(run, this.#evmProblem, {});
    }
    const evm = this.#evm;
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
    await this.#settleHolds(evm);
    // undefined: no Hyperliquid route here; null: not read. Unread stops the Hyperliquid source, never counts as empty.
    let read: ArbitrumRead | null | undefined;
    if (this.#o.hlWithdraw !== undefined && this.#o.arbitrum !== undefined) {
      read = await this.#readArbitrum(evm).catch(() => null);
      await this.#settleHl(read, evm);
    }
    // Only the rescuer's own USDC on that address is offered to the plan.
    const arbitrumUsd = read === undefined || read === null ? read : Number(read.balanceE6 < this.#strandedE6 ? read.balanceE6 : this.#strandedE6) / 1e6;
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
    // From here the screen shows what this transfer sends, not what the leg needed: a capped or fixed-size move
    // (the recorded 20 USDC) is smaller, and the rest comes from the next rescue.
    if (plan.kind === 'transfer') run.amountUsd = round2(plan.amountInUsd);
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
    const limited = this.#o.routeLimit?.(from, to) ?? null;
    if (limited !== null) return limited;
    if (to === 'orderly' && desk.addresses.orderlyReceiver === null) return 'no Orderly receiver is pinned (set_orderly_receiver)';
    if (to === 'phoenix' && this.#o.credit?.phoenix === undefined) return 'into Phoenix the USDC lands on the desk\'s Solana account, and no Phoenix deposit is wired to move it into margin';
    if (from === 'hyperliquid' && to === 'orderly') return 'Hyperliquid\'s USDC leaves through Arbitrum, and Arbitrum USDC into the Orderly receiver is the same asset, which 1Click does not quote';
    const landing = this.#o.landing.confirms(to);
    if (landing !== null) return landing;
    if (from === 'reserve' && this.#o.payers.reserve === undefined) return 'fund_venue is not wired';
    if (from === 'phoenix' && this.#o.payers.phoenix === undefined) return 'sol_sign_rescue is not wired';
    if (from === 'hyperliquid' && (this.#o.hlWithdraw === undefined || this.#o.payers.arbitrum === undefined || this.#o.arbitrum === undefined)) {
      return 'hl_withdraw, evm_usdc_to_intents and the Arbitrum reads are not wired';
    }
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
    // A venue that cannot take the delivery into margin (Phoenix: no registered trader, no SOL, a paused desk) is
    // found out before anything is paid, not after 1Click delivered.
    const credit = this.#o.credit?.[to];
    if (credit?.ready !== undefined) {
      const why = await credit.ready().catch((err: unknown) => `its readiness could not be read (${errorMessage(err)})`);
      if (why !== null) throw new StepFailed('source', `${to} cannot take the USDC into margin now, so nothing was paid: ${why}`);
    }
    if (plan.from === 'hyperliquid') {
      if (plan.withdrawUsd !== null) await this.#hlOut(run, plan, desk);
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

  /** Hyperliquid -> the desk's Arbitrum address: hl_withdraw, then its Bridge2 Transfer seen there, counted as the rescuer's own. */
  async #hlOut(run: Run, plan: Extract<Plan, { kind: 'transfer' }>, desk: RescueDesk): Promise<void> {
    const port = this.#o.hlWithdraw!;
    const arb = this.#o.arbitrum!;
    const evm = desk.addresses.evm;
    const t = run.trigger;
    const feeE6 = BigInt(HL_WITHDRAW_FEE_USD * 1e6);
    const planned = BigInt(Math.round(plan.withdrawUsd! * 1e6));
    let amountE6 = planned;
    // A Bridge2 Transfer names no withdraw: never the exact amount of one that never showed. A cent more while the
    // plan's room under the rescue cap allows it (the withdraw counts against the cap), else a cent less, but never
    // under the contract's operator minimum (operatorMinWithdrawE6), which would refuse it.
    const taken = (x: bigint) => this.#expired.some((e) => e.amountE6 === x - feeE6);
    if (taken(amountE6)) {
      const roomE6 = BigInt(Math.floor(Math.max(0, desk.policy.rescue_cap_usd_per_hour - this.capUsed() - plan.capUsd) * 1e6));
      const minE6 = operatorMinWithdrawE6(desk.policy.max_transfer_cost_flat_e6);
      let up = amountE6;
      while (taken(up)) up += 10_000n;
      let down = amountE6;
      while (taken(down)) down -= 10_000n;
      if (up - planned <= roomE6) {
        amountE6 = up;
      } else if (down >= minE6 && down > feeE6) {
        amountE6 = down;
      } else {
        const why = `no hl_withdraw near ${usdc(planned)} USDC both fits the rescue cap and differs from a withdraw that never showed: `
          + `${usdc(up)} is over the cap's room and ${usdc(down)} is under the operator's minimum of ${usdc(minE6)} USDC, so it is not bumped down`;
        this.#log(`rescue ${t.id}: ${why}`);
        throw new StepFailed('source', why);
      }
    }
    const expectE6 = amountE6 - feeE6;
    const withdrawUsd = Number(amountE6) / 1e6;
    let fromBlock: bigint;
    try {
      fromBlock = (await arb.head()).number;
    } catch (err) {
      throw new StepFailed('source', `the Arbitrum head could not be read before hl_withdraw: ${errorMessage(err)}`);
    }
    if (this.#stopping) throw new StepFailed('sign', 'the engine is stopping: hl_withdraw was not signed');
    this.#progress(run, 'sign');
    const signStart = this.#o.clock.now();
    let tx: TxRef[];
    // Counted before it is sent: the contract counts the operator's hl_withdraw whatever happens after.
    this.#cap.add(withdrawUsd, signStart);
    // On its way from now until it is seen: saved first, so a crash mid-withdraw still holds the next one.
    this.#inFlight = { rescueId: t.id, amountE6: expectE6, fromBlock, acceptedAt: signStart, untilMs: signStart + WITHDRAW_IN_FLIGHT_MS, scannedTo: null, tx: [] };
    if (!this.#persist()) {
      this.#inFlight = null;
      throw new StepFailed('sign', `the rescuer state could not be saved, so hl_withdraw was not sent: ${this.#saveProblem ?? 'unknown'}`);
    }
    try {
      ({ tx } = await port.withdraw(amountE6, `rescue ${t.id}: Hyperliquid margin to the desk's Arbitrum address for ${t.venue}`));
      this.#o.withdrawals?.('hyperliquid', null);
      if (this.#inFlight !== null) this.#inFlight.tx = [...tx];
    } catch (err) {
      const why = errorMessage(err);
      if (/withdraw\w*\s+(are\s+|is\s+)?(paused|disabled|suspended)/i.test(why)) this.#o.withdrawals?.('hyperliquid', why);
      if (err instanceof OutcomeUnknown) {
        // It may have gone out: it stays on its way (no second withdraw) and every transfer is held.
        this.#unknown ??= `the hl_withdraw of rescue ${t.id} may have gone out (${why}); reconcile the Hyperliquid ledger before any other transfer, then ${this.#clearHow()}`;
      } else {
        this.#inFlight = null;
      }
      this.#persist();
      throw new StepFailed('sign', `hl_withdraw ${usdc(amountE6)} USDC: ${why}`);
    }
    run.signedS = (this.#o.clock.now() - signStart) / 1000;
    run.tx.push(...tx);
    this.#persist();
    const topUp = plan.arbitrumUsd > 0 ? `, topping up the ${plan.arbitrumUsd.toFixed(2)} USDC an earlier withdraw left there` : '';
    this.#journal(run, `rescue ${t.id}: source hyperliquid, hl_withdraw ${usdc(amountE6)} USDC to the desk's Arbitrum address (1 USDC fee)${topUp}`, { from: 'hyperliquid', usd: 0, feeUsd: -HL_WITHDRAW_FEE_USD, signedS: round1(run.signedS) }, tx);
    this.#progress(run, 'deposit');
    const until = this.#o.clock.now() + (this.#o.withdrawTimeoutMs ?? WITHDRAW_TIMEOUT_MS);
    for (;;) {
      const head = await arb.head().catch(() => null);
      if (head !== null && await this.#withdrawArrived(evm, head).catch(() => false)) {
        this.#persist();
        return;
      }
      if (this.#stopping) {
        throw new StepFailed('deposit', `the engine is stopping: hl_withdraw's ${usdc(expectE6)} USDC is not yet on the desk's Arbitrum address; it stays on its way (saved) and the next start looks for it`);
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
    const eip3009 = payer.method === 'evm_usdc_to_intents';
    // From Arbitrum the rescuer spends only its own withdraws' USDC, set aside from now on.
    const reserveE6 = eip3009 ? q.amountIn : 0n;
    if (reserveE6 > this.#strandedE6) {
      throw new StepFailed('verify', `the quote spends ${usdc(reserveE6)} USDC of the desk's Arbitrum address, more than the ${usdc(this.#strandedE6)} the rescuer's own hl_withdraws left there`);
    }
    // What tells later whether a signature that may exist ran, read before signing: where a payment's Transfer log
    // would start on Arbitrum and the desk's EIP-3009 counter (EIP-3009); the message's blockhash bound (Solana).
    let arbBlock: bigint | null = null;
    let counter: bigint | null = null;
    if (eip3009) {
      try {
        arbBlock = (await this.#o.arbitrum!.head()).number;
        counter = (await this.#readNear()).counters?.eip3009Next ?? null;
      } catch (err) {
        throw new StepFailed('sign', `the Arbitrum head or the desk's counters on NEAR could not be read before signing, so nothing was signed: ${errorMessage(err)}`);
      }
    }
    if (this.#stopping) throw new StepFailed('sign', 'the engine is stopping: nothing was signed');
    let prepared: PreparedPayment | undefined;
    if (payer.method === 'sol_sign_rescue') {
      try {
        prepared = await payer.prepare?.(q);
      } catch (err) {
        throw new StepFailed('sign', `the Solana message could not be built, so nothing was signed: ${errorMessage(err)}`);
      }
      // Without its blockhash's bound a signed Solana payment could never be shown dead: never signed then.
      if (prepared?.solana === undefined) throw new StepFailed('sign', 'sol_sign_rescue gives no lastValidBlockHeight before signing, so nothing was signed');
    }
    // Into a venue with a credit, the delivery is counted above what the desk's wallet there holds now (USDC already
    // on it is not the delivery). Saved with the hold, so it survives a restart.
    let creditBaseE6: bigint | null = null;
    const credit = this.#o.credit?.[to];
    if (credit?.baseline !== undefined) {
      try {
        creditBaseE6 = await credit.baseline();
      } catch (err) {
        throw new StepFailed('sign', `the desk's ${to} wallet could not be read before signing, so nothing was signed: ${errorMessage(err)}`);
      }
    }
    // Read again after the awaits above: nothing is held or signed once the engine is stopping.
    if (this.#stopping) throw new StepFailed('sign', 'the engine is stopping: nothing was signed');
    this.#progress(run, 'sign');
    const signStart = this.#o.clock.now();
    // The contract counts a rescue transfer once the MPC network signs, even if it is never sent.
    if (payer.method !== 'fund_venue') this.#cap.add(Number(q.amountInE8) / 1e8, signStart);
    this.#strandedE6 -= reserveE6;
    // Held from before the signature: a crash while signing or sending leaves it held after a restart.
    const hold = this.#openHold({
      rescueId: id, venue: to, q, sinceMs: since, reservedE6: reserveE6, arbBlock, counter, solana: prepared?.solana ?? null, creditBaseE6,
      why: `rescue ${id} is paying ${q.depositAddress} (${payer.method}); it may be signed or sent`,
    });
    if (!this.#persist()) {
      this.#dropHold(hold);
      this.#strandedE6 += reserveE6;
      throw new StepFailed('sign', `the rescuer state could not be saved, so nothing was signed: ${this.#saveProblem ?? 'unknown'}`);
    }
    let signed: SignedPayment;
    try {
      signed = await payer.sign(q, reason, prepared);
    } catch (err) {
      if (err instanceof OutcomeUnknown) {
        // It may have been signed: held, with what was set aside, until the chain shows it can never run.
        hold.nearTx = err.tx.find((x) => x.chain === 'near')?.id ?? err.ids.nearTx ?? null;
        if (hold.solana !== null) hold.solana.signature = err.ids.solSignature ?? null;
        this.#park(hold, `the ${payer.method} of rescue ${id} may have been signed or paid (${errorMessage(err)}); held until it is shown never to run or 1Click settles it`, { deadAt: null });
      } else {
        this.#dropHold(hold);
        this.#strandedE6 += reserveE6;
      }
      this.#persist();
      throw new StepFailed('sign', `${payer.method}: ${errorMessage(err)}`);
    }
    hold.authorization = signed.authorization ?? null;
    hold.nearTx = signed.tx.find((x) => x.chain === 'near')?.id ?? null;
    if (hold.solana !== null) hold.solana.signature = signed.solanaSignature ?? null;
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
        // No receipt, or the authorization already used: it may have run. Settled by 1Click, or once the chain shows
        // it never ran (an EIP-3009 authorization unused past validBefore).
        if (hold.solana !== null) hold.solana.signature ??= err.ids.solSignature ?? null;
        this.#park(hold, `the ${payer.method} of rescue ${id} may have paid ${q.depositAddress} (${errorMessage(err)}); held until 1Click settles it or it is shown never to run`, { deadAt: null });
        this.#persist();
        throw new StepFailed('deposit', `${payer.method} deposit: ${errorMessage(err)}`);
      }
      if (err instanceof NothingExecuted && payer.method === 'sol_sign_rescue') {
        // The submitter's proof: the transaction landed and failed, or its blockhash expired with the signature not on
        // chain. That signed message can never run again, and the deposit ring takes the quote once: released.
        this.#dropHold(hold);
        this.#persist();
        throw new StepFailed('deposit', `${payer.method} can never pay ${q.depositAddress} (${errorMessage(err)}): its hold is released`);
      }
      // Signed is enough to pay: the signature is public (in the NEAR receipt) and anyone may send it while it is valid.
      const until = signed.usableUntilMs ?? this.#o.clock.now() + SIGNED_USABLE_MS;
      this.#park(hold, `the signed ${payer.method} of rescue ${id} was not sent but stays usable until ${new Date(until).toISOString()}: it may still pay ${q.depositAddress}`, { deadAt: null });
      this.#persist();
      throw new StepFailed('deposit', `${payer.method} deposit: ${errorMessage(err)}`);
    }
    hold.paying = false;
    hold.reservedE6 = 0n;
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
      if (s.status === 'INCOMPLETE_DEPOSIT') {
        // Part of the money is at 1Click, which refunds it or waits for the rest: held until it settles.
        this.#park(hold, `rescue ${id}'s deposit ${q.depositAddress} is INCOMPLETE_DEPOSIT at 1Click: what arrived is held there until 1Click refunds it`, null);
        this.#persist();
        throw new StepFailed('deposit', `1Click says INCOMPLETE_DEPOSIT: less than the quote's ${e8Text(q.amountInE8)} USDC reached ${q.depositAddress}; held until 1Click refunds it`);
      }
      if (SETTLED_STATUSES.includes(s.status)) {
        this.#dropHold(hold);
        this.#persist();
        const back = payer.method === 'fund_venue' ? 'the desk owner on NEAR'
          : payer.method === 'sol_sign_rescue' ? 'the desk\'s Solana address'
          : 'the desk\'s Arbitrum address (not counted as the rescuer\'s own to spend: the owner moves it)';
        throw new StepFailed('deposit', `1Click ended the transfer ${s.status}: the refund goes back to ${back}`);
      }
      if (this.#stopping) {
        this.#park(hold, `rescue ${id}'s transfer to ${q.depositAddress} was sent and is ${last} at 1Click; the engine stopped before it settled`, null);
        this.#persist();
        throw new StepFailed('deposit', `the engine is stopping: the transfer to ${q.depositAddress} was sent and saved as held (${last} at 1Click); the next start reads it again`);
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
    if (credit !== undefined && this.#stopping) {
      // Signing the deposit now could be cut off by the exit: the USDC waits on the venue's wallet instead. The wallet
      // is read (bounded) before the hold is dropped, so an exit during the read leaves the hold, not a silent gap.
      const read = await this.#walletRead(hold);
      this.#dropHold(hold);
      const saved = this.#persist();
      this.#ownerLine(this.#walletLine(hold, 'the engine stopped before the deposit', read, saved), to);
      throw new StepFailed('deposit', `the engine is stopping: 1Click delivered at least ${e8Text(q.minAmountOutE8)} USDC to the desk's ${to} wallet, not moved into margin (a deposit moves it)`);
    }
    if (credit !== undefined) {
      try {
        const { tx } = await credit.credit(q.minAmountOut, `rescue ${run.trigger.id}: the delivered USDC into ${to} margin`, {
          deliveryTx, baseE6: hold.creditBaseE6, stopping: () => this.#stopping,
          beforeSign: () => {
            hold.creditStarted = true;
            const ok = this.#persist();
            // Not saved: the credit signs nothing, so the marker is not true either.
            if (!ok) hold.creditStarted = false;
            return ok;
          },
        });
        run.tx.push(...tx);
      } catch (err) {
        // 1Click delivered: nothing more of this payment can move. The wallet is read first (bounded), then the hold
        // is dropped and saved, then the owner line says what the save allows.
        const unknown = err instanceof OutcomeUnknown;
        const read = unknown ? null : await this.#walletRead(hold);
        this.#dropHold(hold);
        if (unknown) this.#unknown ??= `the ${to} credit of rescue ${run.trigger.id}: ${errorMessage(err)}; reconcile it, then ${this.#clearHow()}`;
        const saved = this.#persist();
        if (read !== null) {
          const proved = err instanceof NothingExecuted;
          const why = `the deposit ${hold.creditStarted && !proved ? 'failed once its signing began' : 'did not run'}: ${errorMessage(err)}`;
          this.#ownerLine(this.#walletLine(hold, why, read, saved, proved), to);
        }
        throw new StepFailed('deposit', `1Click delivered, but moving it into ${to} margin failed: ${errorMessage(err)}`);
      }
    }
    const timeout = this.#o.landingTimeoutMs ?? LANDING_TIMEOUT_MS;
    const until = this.#o.clock.now() + timeout;
    for (;;) {
      const entry = await this.#o.landing.find(to, q, hold.heldAt, this.#seen, deliveryTx).catch(() => null);
      if (entry !== null) {
        this.#seen.add(entry.id);
        this.#dropHold(hold);
        this.#persist();
        run.tx.push(...entry.tx.filter((x) => !run.tx.some((y) => y.chain === x.chain && y.id === x.id)));
        return this.#land(run, entry.usd, q, plan);
      }
      if (this.#o.clock.now() >= until || this.#stopping) {
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
      result = await reducer.close({ reason: `rescue ${t.id}: reduce both legs by ${qtyString(cut)} (${(fraction * 100).toFixed(1)} %)`, targets, reduceOnly: true, by: 'rescue reduce' });
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

  #openHold(h: HoldStart): DepositHold {
    const hold: DepositHold = {
      why: h.why, rescueId: h.rescueId, venue: h.venue, q: h.q, sinceMs: h.sinceMs, heldAt: this.#o.clock.now(), reconcileSaid: false, paying: true,
      unsent: null, authorization: null, arbBlock: h.arbBlock, scannedTo: null, paidLog: null, reservedE6: h.reservedE6, status: null,
      counter: h.counter, nearTx: null, solana: h.solana === null ? null : { lastValidBlockHeight: h.solana.lastValidBlockHeight, signature: null },
      creditBaseE6: h.creditBaseE6, creditStarted: false,
    };
    this.#deposits.push(hold);
    return hold;
  }

  /** The rescue no longer pays it, and it may still move: held, with why. */
  #park(hold: DepositHold, why: string, unsent: DepositHold['unsent']): void {
    hold.paying = false;
    hold.why = why;
    hold.unsent = unsent;
    hold.reconcileSaid = false;
  }

  #dropHold(hold: DepositHold): void {
    const i = this.#deposits.indexOf(hold);
    if (i !== -1) this.#deposits.splice(i, 1);
  }

  /** A final NEAR block's time and the desk's counters there; without a reader, the clock and no ring. */
  async #readNear(): Promise<NearRead> {
    const f = this.#o.near;
    return f === undefined ? { height: 0, timeMs: this.#o.clock.now(), counters: null, fund: null, fundError: 'no NEAR reader here' } : f();
  }

  /**
   * Whether the payment of a hold ran: a USDC Transfer from the desk to its deposit address since the block before
   * signing. Reads only the blocks after the last read, up to `head`, and keeps the log once seen.
   */
  async #paid(d: DepositHold, evm: string, head: ArbitrumHead): Promise<boolean> {
    if (d.paidLog !== null) return true;
    if (d.arbBlock === null) return false;
    const from = d.scannedTo === null ? d.arbBlock : d.scannedTo + 1n;
    if (from <= head.number) {
      const logs = await this.#o.arbitrum!.transfers(evm, d.q.depositAddress, from, head.number);
      d.scannedTo = head.number;
      if (logs.length > 0) d.paidLog = logs[0]!.id;
    }
    return d.paidLog !== null;
  }

  /**
   * Whether a payment not known to be sent can never run, read on chain now (see the header): 'never-signed' (the
   * contract never counted it and no longer can), 'never-paid' (its NEAR transaction is final and paid nothing),
   * 'dead' (it was or may have been signed, and can no longer run), or null (it may still run, or ran, or the chain
   * could not tell). Time alone never answers.
   */
  async #canNeverRun(d: DepositHold, evm: string): Promise<'never-signed' | 'never-paid' | 'dead' | null> {
    const payable = payableUntilMs(d.q);
    const method = d.q.method;
    // fund_venue: its transaction, known and found, decides only on positive proof. Any transfer to the deposit
    // address (whatever the amount) is a payment; released only when the call failed, its USDC ft_transfer receipt
    // failed or on_fund_venue returned false. Final with neither: held for the owner. Not found (never included, or
    // the RPC cannot tell): the ring below, which releases only what was never counted.
    if (method === 'fund_venue' && d.nearTx !== null && this.#o.nearTx !== undefined) {
      const f = await this.#o.nearTx(d.nearTx).catch(() => null);
      if (f !== null) {
        if (!f.final || f.paidTo.includes(d.q.depositAddress) || f.noPay === null) return null;
        d.noPay = f.noPay;
        return 'never-paid';
      }
    }
    const near = await this.#readNear();
    // Each method's own ring, which answers only while it cannot have pushed this address out.
    const c = method === 'fund_venue' ? near.fund : near.counters;
    const ring = c !== null && ringHolds(c, d.heldAt - CLOCK_SKEW_MS) ? c : null;
    const entry = ring === null ? null : ringEntry(ring, depositKey(method, d.q.depositAddress));
    if (ring !== null && entry === null) return near.timeMs >= payable + CHAIN_MARGIN_S * 1000 ? 'never-signed' : null;
    if (method === 'fund_venue') {
      // Counted (or not known not to be), with no transaction to read: its transfer may run late. Held for the owner.
      return null;
    }
    if (method === 'sol_sign_rescue') return this.#solanaDead(d);
    if (method !== 'evm_usdc_to_intents') return null;
    const arb = this.#o.arbitrum;
    if (arb === undefined) return null;
    const head = await arb.head();
    if (await this.#paid(d, evm, head)) return null;
    const a = d.authorization;
    if (a !== null) {
      if (head.timestampS < a.validBefore + CHAIN_MARGIN_S) return null;
      return (await arb.authorizationUsed(a.from, a.nonce, head.number)) ? null : 'dead';
    }
    // Neither a Transfer since the block before signing nor a time it could still run proves nothing without both.
    if (d.arbBlock === null) return null;
    const past = entry !== null
      ? head.timestampS >= Math.floor(entry.paidMs / 1000) + EIP3009_VALIDITY_S + CHAIN_MARGIN_S
      : head.timestampS * 1000 >= payable + NO_VIEW_SETTLE_MS;
    if (!past) return null;
    return (await this.#noncesUnused(near.counters, d, evm, head)) ? 'dead' : null;
  }

  /**
   * An EIP-3009 hold with no authorization in hand: every nonce the contract may have signed since the counter read
   * before signing (up to eip3009_next) is unused at `head`, so no authorization of it ran whatever the logs show.
   * True with nothing to read (no counter or no view: the bound alone); false with too many to read or no desk id.
   */
  async #noncesUnused(c: NearDeskCounters | null, d: DepositHold, evm: string, head: ArbitrumHead): Promise<boolean> {
    if (d.counter === null || c === null) return true;
    if (this.#deskId === null || c.eip3009Next - d.counter > NONCES_READ) return false;
    for (let n = d.counter; n < c.eip3009Next; n++) {
      if (await this.#o.arbitrum!.authorizationUsed(evm, eip3009Nonce(this.#deskId, n), head.number)) return false;
    }
    return true;
  }

  /**
   * A sol_sign_rescue that may be signed: dead once Solana's finalized height is past its blockhash's and its signature
   * is unknown there, or once its transaction is finalized with an error (it ran, paid nothing, and the same signature
   * can never run again), whatever the height.
   */
  async #solanaDead(d: DepositHold): Promise<'dead' | null> {
    const s = d.solana;
    const sol = this.#o.solana;
    // No bound or no signature to look for: only the owner can tell.
    if (s === null || s.signature === null || sol === undefined) return null;
    // Height first: past it, no later block can include the transaction, so a status read after is the last word, if
    // its node had reached the slot the height was read at (a lagging node's "unknown" proves nothing). The same slot
    // rule holds for a failed status.
    const f = await sol.finalized();
    const st = await sol.signatureStatus(s.signature);
    if (st.slot === null || st.slot < f.slot) return null;
    if (st.known) return st.failed ? 'dead' : null;
    return f.height > s.lastValidBlockHeight ? 'dead' : null;
  }

  /** The desk's Arbitrum address at the latest block: the head, then the balance at that block. */
  async #readArbitrum(evm: string): Promise<ArbitrumRead> {
    const arb = this.#o.arbitrum!;
    const head = await arb.head();
    return { head, balanceE6: await arb.usdcBalance(evm, head.number) };
  }

  /** The withdraw on its way arrived when a Bridge2 Transfer of exactly its amount to the desk shows; then it is the rescuer's own. */
  async #withdrawArrived(evm: string, head: ArbitrumHead): Promise<boolean> {
    const f = this.#inFlight;
    if (f === null) return false;
    const hit = await this.#bridgeLog(f, evm, head);
    if (hit === null) return false;
    this.#strandedE6 += f.amountE6;
    this.#inFlight = null;
    return true;
  }

  /**
   * A Bridge2 Transfer of exactly a withdraw's amount to the desk, not matched before, in the blocks after the last
   * read up to `head`; marked seen when found.
   */
  async #bridgeLog(f: InFlight, evm: string, head: ArbitrumHead): Promise<string | null> {
    const from = f.scannedTo === null ? f.fromBlock : f.scannedTo + 1n;
    if (from > head.number) return null;
    const logs = await this.#o.arbitrum!.transfers(HL_BRIDGE2, evm, from, head.number);
    f.scannedTo = head.number;
    const hit = logs.find((l) => l.value === f.amountE6 && !this.#seen.has(`arb:${l.id}`));
    if (hit === undefined) return null;
    this.#seen.add(`arb:${hit.id}`);
    return hit.id;
  }

  /**
   * Before a plan, with the address read at one block: a withdraw on its way whose Transfer shows counts as the
   * rescuer's own; one not seen WITHDRAW_IN_FLIGHT_MS after it was accepted is said once as "reconcile needed" and no
   * longer taken as on its way; and the rescuer's own count never exceeds the balance.
   */
  async #settleHl(read: ArbitrumRead | null, evm: string): Promise<void> {
    if (read === null) return;
    const t = this.#o.clock.now();
    let changed = false;
    const f = this.#inFlight;
    if (f !== null) {
      if (await this.#withdrawArrived(evm, read.head).catch(() => false)) {
        this.#journalLine(`rescue ${f.rescueId}'s hl_withdraw reached the desk's Arbitrum address late (${usdc(f.amountE6)} USDC): it is bridged first by the next rescue out of Hyperliquid, and withdraws may run again`, 'hyperliquid');
        changed = true;
      } else if (t >= f.untilMs) {
        this.#inFlight = null;
        this.#expired.push(f);
        const line = `reconcile needed: rescue ${f.rescueId}'s hl_withdraw (${usdc(f.amountE6)} USDC to arrive, accepted at ${new Date(f.acceptedAt).toISOString()}${txText(f.tx)}) is not on the desk's Arbitrum address `
          + `after ${Math.round((t - f.acceptedAt) / 60_000)} min; it is no longer taken as on its way, so Hyperliquid may be withdrawn from again. Check the Hyperliquid ledger: USDC of it that arrives later is not counted as the rescuer's own, `
          + `and for ${Math.round(EXPIRED_KEPT_MS / 3_600_000)} h no new withdraw brings that exact amount`;
        this.#log(line);
        this.#journalLine(line, 'hyperliquid');
        changed = true;
      }
    }
    // Withdraws that never showed: one that shows now is said once and no longer reserves its amount.
    for (const e of [...this.#expired]) {
      if (t - e.acceptedAt >= EXPIRED_KEPT_MS) {
        this.#expired.splice(this.#expired.indexOf(e), 1);
        changed = true;
        continue;
      }
      const before = e.scannedTo;
      const hit = await this.#bridgeLog(e, evm, read.head).catch(() => null);
      if (e.scannedTo !== before) changed = true;
      if (hit === null) continue;
      this.#expired.splice(this.#expired.indexOf(e), 1);
      this.#journalLine(`rescue ${e.rescueId}'s hl_withdraw (${usdc(e.amountE6)} USDC) reached the desk's Arbitrum address after it was given up (log ${hit}): not counted as the rescuer's own; the owner moves it`, 'hyperliquid');
    }
    while (this.#expired.length > EXPIRED_KEPT) {
      this.#expired.shift();
      changed = true;
    }
    if (this.#strandedE6 > read.balanceE6) {
      this.#journalLine(`the desk's Arbitrum address holds ${usdc(read.balanceE6)} USDC, less than the ${usdc(this.#strandedE6)} the rescuer counted as its own (moved by someone else): it counts ${usdc(read.balanceE6)} from now on`, 'hyperliquid');
      this.#strandedE6 = read.balanceE6;
      changed = true;
    }
    if (changed) this.#persist();
  }

  /** Reads each held deposit again; drops those settled (refunded, delivered and seen, or shown never to run). */
  async #settleHolds(evm: string): Promise<void> {
    if (this.#deposits.length === 0) return;
    for (const d of [...this.#deposits]) {
      const s = await this.#o.oneClick.status(d.q.depositAddress).catch(() => null);
      if (s !== null) d.status = s.status;
      let settled: string | null = null;
      let giveBack = false;
      if (s === null) {
        // Unread: still held.
      } else if (s.status === 'SUCCESS') {
        const entry = await this.#o.landing.find(d.venue, d.q, d.heldAt, this.#seen, deliveryHashes(s.body)).catch(() => null);
        if (entry !== null) {
          this.#seen.add(entry.id);
          settled = `rescue ${d.rescueId}'s ${entry.usd.toFixed(2)} USD landed on ${d.venue} late (after its rescue was failed)`;
        } else if (this.#o.credit?.[d.venue] !== undefined) {
          // A venue with a credit (Phoenix): 1Click delivered to the desk's wallet there and the rescue that paid it
          // stopped, timed out or was cut off by a restart before its deposit. Settled here, never deposited late:
          // the wallet is read (bounded), the hold dropped and saved, then the owner line says what the save allows.
          const read = await this.#walletRead(d);
          this.#dropHold(d);
          const saved = this.#persist();
          const line = this.#walletLine(d, '1Click says SUCCESS and no deposit of it was made by this run', read, saved);
          this.#log(line);
          this.#journalLine(`${line}; transfers are no longer held by it`, d.venue);
          continue;
        }
      } else if (SETTLED_STATUSES.includes(s.status)) {
        settled = `rescue ${d.rescueId}'s transfer ended ${s.status} at 1Click: refunded, nothing landed`
          + `${d.q.method === 'evm_usdc_to_intents' ? ' (the refund on the desk\'s Arbitrum address is not counted as the rescuer\'s own: the owner moves it)' : ''}`;
      } else if (s.status === 'PENDING_DEPOSIT' && d.unsent !== null) {
        // Read on chain at every pass: dead only while the chain still says so, and 1Click then gets UNUSED_GRACE_MS
        // to index a deposit it missed.
        const verdict = await this.#canNeverRun(d, evm).catch(() => null);
        const now = this.#o.clock.now();
        if (verdict === 'never-signed') {
          settled = `rescue ${d.rescueId}'s ${d.q.method} was never signed: the desk's ${d.q.method === 'fund_venue' ? 'fund_venue' : 'deposit'} ring on NEAR does not hold ${d.q.depositAddress}, `
            + `and the contract signs that quote only until ${new Date(payableUntilMs(d.q)).toISOString()}, so nothing can pay it`;
          giveBack = true;
        } else if (verdict === 'never-paid') {
          settled = `rescue ${d.rescueId}'s fund_venue transaction ${d.nearTx} is final and paid nothing to ${d.q.depositAddress} (${d.noPay ?? 'proof read'}): `
            + 'nothing can pay it (any USDC it took is back in the desk\'s idle USDC)';
          giveBack = true;
        } else if (verdict === null) {
          d.unsent.deadAt = null;
        } else if (d.unsent.deadAt === null) {
          d.unsent.deadAt = now;
        } else if (now - d.unsent.deadAt >= UNUSED_GRACE_MS) {
          settled = `rescue ${d.rescueId}'s signed payment can no longer run and 1Click saw no deposit ${Math.round(UNUSED_GRACE_MS / 60_000)} min later: expired unused`;
          giveBack = true;
        }
      }
      if (settled !== null && giveBack && d.reservedE6 > 0n) {
        // Never paid: the USDC it set aside is still on Arbitrum, the rescuer's own again.
        this.#strandedE6 += d.reservedE6;
        settled += `; its ${usdc(d.reservedE6)} USDC on Arbitrum is the rescuer's to spend again`;
      }
      if (settled === null) {
        const t = this.#o.clock.now();
        if (!d.reconcileSaid && t - d.heldAt >= RECONCILE_AFTER_MS) {
          d.reconcileSaid = true;
          const ids = `${d.nearTx === null ? '' : `, NEAR tx ${d.nearTx}`}${d.solana?.signature == null ? '' : `, Solana signature ${d.solana.signature}`}`;
          const line = `reconcile needed: rescue ${d.rescueId}'s deposit ${d.q.depositAddress} (${d.q.method}, ${e8Text(d.q.amountInE8)} USDC in, at least ${e8Text(d.q.minAmountOutE8)} out to ${d.venue}${ids}) `
            + `is ${s === null ? 'unread' : s.status} at 1Click after ${Math.round((t - d.heldAt) / 60_000)} min; transfers stay held until it is settled. To clear it by hand once reconciled: ${this.#clearHow()}`;
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

  /** The setting that starts a first run of this desk's state (it names the desk, so one left in an env file never re-arms). */
  #freshEnv(): string {
    const id = this.#o.store?.identity;
    return id === undefined ? 'GIMBAL_RESCUE_FRESH' : `GIMBAL_RESCUE_FRESH=${id.contractId}/${id.deskId}`;
  }

  /** How a hold or an unknown outcome is cleared by hand. */
  #clearHow(): string {
    const store = this.#o.store;
    return store === undefined ? 'holds live in memory here, so a restart clears them' : `${MANUAL_CLEAR} (${store.path})`;
  }

  // ---- state on disk ----

  #restore(s: RescueState): void {
    this.#unknown = s.unknown;
    for (const h of s.holds) {
      const q = loadQuote(h.quote);
      this.#deposits.push({
        // Still being paid when it was saved: it may have been signed or sent since.
        why: h.paying ? `rescue ${h.rescueId} was paying ${q.depositAddress} (${q.method}) when the engine stopped: it may have been signed or sent` : h.why,
        rescueId: h.rescueId, venue: h.venue, q, sinceMs: h.sinceMs, heldAt: h.heldAt, reconcileSaid: h.reconcileSaid, paying: false,
        unsent: h.paying ? { deadAt: null } : h.unsent === null ? null : { deadAt: h.unsent.deadAt },
        authorization: h.authorization, arbBlock: h.arbBlock === null ? null : BigInt(h.arbBlock), scannedTo: h.scannedTo === null ? null : BigInt(h.scannedTo),
        paidLog: h.paidLog, reservedE6: BigInt(h.reservedE6), status: h.status,
        counter: h.counter === null ? null : BigInt(h.counter), nearTx: h.nearTx, solana: h.solana === null ? null : { ...h.solana },
        creditBaseE6: h.creditBaseE6 == null ? null : BigInt(h.creditBaseE6), creditStarted: h.creditStarted === true,
      });
    }
    this.#strandedE6 = BigInt(s.hl.strandedE6);
    this.#inFlight = s.hl.inFlight === null ? null : loadWithdraw(s.hl.inFlight);
    this.#expired = s.hl.expired.map(loadWithdraw);
    for (const c of s.cap) this.#cap.add(c.usd, c.at);
    for (const id of s.seen) this.#seen.add(id);
  }

  #snapshot(): RescueSnapshot {
    const now = this.#o.clock.now();
    const f = this.#inFlight;
    return {
      version: RESCUE_STATE_VERSION,
      savedAt: now,
      unknown: this.#unknown,
      holds: this.#deposits.map((d) => ({
        why: d.why, rescueId: d.rescueId, venue: d.venue, quote: saveQuote(d.q), sinceMs: d.sinceMs, heldAt: d.heldAt, reconcileSaid: d.reconcileSaid,
        paying: d.paying, unsent: d.unsent === null ? null : { deadAt: d.unsent.deadAt }, authorization: d.authorization,
        arbBlock: d.arbBlock === null ? null : d.arbBlock.toString(), scannedTo: d.scannedTo === null ? null : d.scannedTo.toString(), paidLog: d.paidLog,
        reservedE6: d.reservedE6.toString(), status: d.status,
        counter: d.counter === null ? null : d.counter.toString(), nearTx: d.nearTx, solana: d.solana === null ? null : { ...d.solana },
        creditBaseE6: d.creditBaseE6 === null ? null : d.creditBaseE6.toString(), creditStarted: d.creditStarted,
      })),
      hl: { strandedE6: this.#strandedE6.toString(), inFlight: f === null ? null : saveWithdraw(f), expired: this.#expired.map(saveWithdraw) },
      cap: this.#cap.entries(now),
      seen: [...this.#seen].slice(-SEEN_KEPT),
    };
  }

  /** Saves the state (when there is a store); false when it could not (then no signature or withdraw is asked for). */
  #persist(): boolean {
    const store = this.#o.store;
    if (store === undefined) return true;
    if (this.#stateProblem !== null) {
      // The missing or unusable file is left as it is for the owner to look at.
      this.#saveProblem = `${this.#stateProblem}; nothing is written there until the owner repairs it or starts with ${this.#freshEnv()}`;
      return false;
    }
    try {
      store.save(this.#snapshot());
      this.#saveProblem = null;
      return true;
    } catch (err) {
      this.#saveProblem = `${store.path}: ${errorMessage(err)}`;
      this.#log(`rescuer state not saved (${this.#saveProblem}): what is held stays held in memory, and no signature or withdraw is asked for until a save before it succeeds`);
      return false;
    }
  }

  // ---- endings ----

  #land(run: Run, landedUsd: number | null, q: VerifiedQuote | null, plan?: Extract<Plan, { kind: 'transfer' }>): void {
    if (run.ended) return;
    run.ended = true;
    const t = run.trigger;
    const elapsed = this.#elapsed(run);
    // What reached the margin, after 1Click's fees: the number the screen's "Moved" shows.
    if (q !== null && landedUsd !== null) run.amountUsd = round2(landedUsd);
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

  /** The desk wallet's balance on a credit venue, read with a real-time bound; null with the reason when not read. */
  async #walletRead(d: DepositHold): Promise<{ held: bigint | null; problem: string | null }> {
    const credit = this.#o.credit?.[d.venue];
    if (credit?.baseline === undefined) return { held: null, problem: 'no wallet read is wired' };
    const ms = this.#o.walletReadMs ?? WALLET_READ_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
      timer.unref?.();
    });
    try {
      return { held: await Promise.race([credit.baseline(), late]), problem: null };
    } catch (err) {
      return { held: null, problem: errorMessage(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The owner's line for a delivery to a venue's wallet that this run did not see moved into margin. The deposit
   * command is given only when no deposit was ever about to be signed (`creditStarted` unset, or `proved`: the
   * deposit is shown to have run nothing), the hold's drop was saved (else a restart settles it again), and the wallet
   * still holds the delivery above its saved baseline. Otherwise the owner checks first.
   */
  #walletLine(d: DepositHold, why: string, read: { held: bigint | null; problem: string | null }, saved: boolean, proved = false): string {
    const lead = `owner: rescue ${d.rescueId}'s delivery of at least ${e8Text(d.q.minAmountOutE8)} USDC to the desk's ${d.venue} wallet is not seen in margin (${why})`;
    const margin = `${d.venue} margin`;
    if (d.creditStarted && !proved) {
      return `${lead}: the deposit may have run (it was about to be signed): check ${margin} (and the desk's Solana transactions) before depositing`;
    }
    if (!saved) {
      return `${lead}: the engine deposited nothing, but the rescuer state could not be saved (${this.#saveProblem ?? 'unknown'}), so a restart may read this hold again: `
        + `check the wallet, then ${margin}, before depositing`;
    }
    const { held } = read;
    if (held === null) {
      return `${lead}: the engine deposited nothing; the wallet could not be read (${read.problem ?? 'unknown'}): check the wallet, then ${margin}, before depositing`;
    }
    if (d.creditBaseE6 === null) {
      return `${lead}: the engine deposited nothing; no baseline was saved with this hold, so the delivery cannot be told from other USDC on the wallet `
        + `(it holds ${usdc(held)} USDC): check the wallet, then ${margin}, before depositing`;
    }
    if (held < d.creditBaseE6 + d.q.minAmountOut) {
      return `${lead}: the delivery is not on the wallet yet (it holds ${usdc(held)} USDC, ${usdc(d.creditBaseE6)} before the payment) and the engine deposited nothing: `
        + `check the wallet, then ${margin}, before depositing`;
    }
    const how = this.#o.credit?.[d.venue]?.manual?.(d.q.minAmountOut) ?? `deposit it into ${margin} by hand`;
    return `${lead}: it waits on the wallet, not in margin; to move it: ${how}`;
  }

  /** An owner line, in the log and the journal. */
  #ownerLine(line: string, venue: VenueId): void {
    this.#log(line);
    this.#journalLine(line, venue);
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

/** The smallest (and, where the cap bounds it, the largest) rescue each route takes, for the log. */
function minimumsText(policy: RescueDesk['policy'], keyed: boolean): string {
  return rescueSizes(policy, keyed).map((r) => `${r.from} -> ${r.to} ${sizeText(r)}`).join(', ');
}

function loadWithdraw(f: SavedWithdraw): InFlight {
  return {
    rescueId: f.rescueId, amountE6: BigInt(f.amountE6), fromBlock: BigInt(f.fromBlock), acceptedAt: f.acceptedAt, untilMs: f.untilMs,
    scannedTo: f.scannedTo === null ? null : BigInt(f.scannedTo), tx: [...f.tx],
  };
}

function saveWithdraw(f: InFlight): SavedWithdraw {
  return {
    rescueId: f.rescueId, amountE6: f.amountE6.toString(), fromBlock: f.fromBlock.toString(), acceptedAt: f.acceptedAt, untilMs: f.untilMs,
    scannedTo: f.scannedTo === null ? null : f.scannedTo.toString(), tx: [...f.tx],
  };
}

/** A withdraw's Hyperliquid transactions, for a reconcile line. */
function txText(tx: readonly TxRef[]): string {
  return tx.length === 0 ? '' : `, Hyperliquid tx ${tx.map((x) => x.id).join(', ')}`;
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
