// serve's pair trader on mainnet (trade/protected-pair.ts): the legs pair-mainnet trades (HlLeg, PhoenixLeg, the
// relayer), built the same way and with the same guards (pair-mainnet-lib.ts: the stored price refreshed when it would
// not outlive an IOC and its retry, the 300 s life of a fresh price; the policy cap less the band; the Phoenix
// exchange and market checked against the pinned accounts), adopted from the venues at start, and run by a PairTrader
// whose protections' orders are all reduce-only IOCs. It feeds panic_close and a rescue's reduce (the `reducer`) and
// the ADL watch.
//
// Trading is opt-in: GIMBAL_TRADE=1 takes the per-desk trader lock first (the one pair-mainnet --send takes), loads the
// operator key by name (never printed) and builds the signing relayer; it refuses in a linked git worktree, as
// pair-mainnet --send does. `serve --once` never trades. Without it the pair is alert only: the legs are read, ADL and
// the liquidation alert are journaled, and nothing is signed; the lock is released as soon as the pair is found not
// to trade, so pair-mainnet can run. The trader's state is kept in GIMBAL_STATE_DIR (default the per-user state
// directory), trader-mainnet-<contract>-<desk>-<evm>.json (trade/trader-state.ts); a missing file is not a fresh start:
// GIMBAL_TRADER_FRESH=<contract>/<desk> asks for one when the file is missing or unusable, and is ignored over a usable
// file (trade/protected-pair.ts startPlan). Orders saved in flight that could still run at start are settled from the
// venues once they cannot (a timer: ProtectedPair.resolveInFlight). stop() turns trading off before anything else: a
// rescue between its read and its reduce, or a cancel, signs nothing once the lock is being released.
//
// The pair: the one symbol in both policy.hl_assets and policy.phoenix_markets that either venue holds; with both legs
// flat, GIMBAL_PAIR_SYMBOL (exactly as the policy spells it: kPEPE), else the saved state's, else the only symbol in
// both lists. Two open pairs are refused (serve protects one). Hyperliquid positions outside the policy's pair are
// named, not protected. With both legs flat and no symbol to name, a trading serve holds no pair yet but keeps the lock
// (when the trader state allows trading): the strategy loop may open one.
//
// The strategy loop's hands (`hands`, strategy/loop.ts): open and close run pair-mainnet's own code (pair-ops.ts:
// planOpen's refusals, then maker first through the pair's ProtectedPair; planClose, then a maker-first close,
// reduce-only), one at a time. An owner demo entry's open (the loop's POST /rotate with demo) alone adds a taker
// fallback (SERVE_DEMO_TAKER_FALLBACK): after the maker window, what the post-only part did not fill goes as an IOC on
// the maker leg within the band, the caps, SERVE_SLIPPAGE_BPS past the touch and the same of the mark, and its partner
// hedges what filled; the loop's own entries and a plain rotate stay maker only. An open on another symbol than the pair held (flat) builds that symbol's pair the way
// the start does (the legs, the Phoenix market check, resting orders, two agreeing reads, startPlan on the same state
// file) and only then replaces the flat one; a new pair that would not trade is dropped and the open refused. From
// then on the new pair is held and protected exactly as an adopted one: the reducer, panic_close, the ADL watch (which
// follows the pair held now) and the trader state.
//
// Resting orders: the Phoenix leg sends IOCs only, so only Hyperliquid can hold one (a post-only order of an earlier
// pair-mainnet run). One resting on the pair's coin at start makes the pair alert only (it could fill under the trader,
// and the ADL watch would read the fill as a shrink or a growth of ours), with a line naming it; cancel it, reconcile
// and start again. panic_close cancels every resting order on the policy's Hyperliquid coins first (cancelResting).
//
// A start that cannot read what it needs (review S1: Hyperliquid info, the Phoenix API, Solana's slot, NEAR RPC, or
// a Phoenix snapshot that stays behind the chain's confirmed slot) does not stop serve: the pair starts alert only
// with its legs unknown (nothing adopted, `unconfirmed` says why, the hands refuse every act), the reads are tried
// again on a timer with backoff up to START_RETRY_MAX_MS, and the pair goes live once both legs, synced to their
// chains, read twice alike. The transitions are journaled and the venue's health says slow or down meanwhile. Only
// a ConfigError (a bad env, a contract on another network) stops the start. The trader lock is part of the start:
// one held by a live other process degrades the pair the same way and is tried again (never an exit, which would
// crash-loop under the host's restart policy), and a stale one (its process gone, an earlier boot, or this pid with no
// heartbeat for LOCK_STALE_MS: a killed container) is taken over and journaled. The holder's lock beats until stop(). While the start is not confirmed a pair may be open with nothing protecting it:
// serve's monitor asks `monitor()` every 30 min for the "pair unprotected" line, journaled at most hourly.
//
// Orderly pairs (GIMBAL_ORDERLY_PAIRS=1 only; trade/pair-shape.ts): a pair is any two of Hyperliquid, Orderly and
// Phoenix, its legs and which is long saved in the trader state. Without the flag nothing here changes: the pair is
// short Hyperliquid / long Phoenix, Orderly is never read, and an open on another pair is refused. With it, the start
// also reads the desk's Orderly positions (serve's Orderly session, ServePairInput.orderly), a held symbol takes the
// saved pair's legs, and a symbol held on a venue that is not one of those legs is not protected (named, nothing
// adopted). An Orderly leg needs that session: without one an Orderly pair is refused with that reason. Hyperliquid,
// when it is a leg, goes first post-only; Orderly takes IOCs only, so Orderly and Phoenix go as two IOCs at once
// (pair-ops.ts).

import type { ContractPolicy, Mode, StreamEvent, TxRef, VenueId } from '@gimbal/shared';
import type { NearTransport } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport } from '../contract/near-transport.ts';
import { oraclePriced } from '../contract/oracle-assets.ts';
import type { DeskView } from '../contract/types.ts';
import { anyLegPriced, legCaps, unpricedBySymbol, unpricedEntry } from '../contract/unpriced.ts';
import { HyperliquidSubmitter } from '../relayer/hyperliquid.ts';
import type { SolanaChain } from '../relayer/phoenix-money.ts';
import { solanaChain } from '../relayer/phoenix-money.ts';
import { ORDER_PRIORITY_MICROLAMPORTS, exchangeMismatches, marketMismatches, splineOf } from '../relayer/phoenix-tx.ts';
import type { DeskSolanaAccounts } from '../relayer/phoenix-withdraw.ts';
import { Relayer } from '../relayer/relayer.ts';
import { SolanaSubmitter } from '../relayer/solana.ts';
import type { Reducer } from '../rescue/rescuer.ts';
import type { AdlState } from '../risk/adl.ts';
import { ADL_ATTEMPTS, AdlWatch, newAdlState } from '../risk/adl.ts';
import { MAINNET_COSTS, ORDERLY_BROKERS, hlFillFeeBps } from '../scanner/config.ts';
import type { LegSide, MakerSettings, TakerFallback, TradeLeg } from '../trade/legs.ts';
import { DEMO_TAKER_FALLBACK_BPS } from '../scanner/carry.ts';
import { DEFAULT_MAKER, HlLeg } from '../trade/legs.ts';
import { signedQtyString } from '../trade/lots.ts';
import type { PairResult } from '../trade/pair.ts';
import { PairTrader, REPLAY_WINDOW_MS } from '../trade/pair.ts';
import { PhoenixLeg, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import type { PairShape } from '../trade/pair-shape.ts';
import {
  PAIR_VENUES, defaultShape, isDefaultShape, longLeg, makerIndexOf, orderlyPairsOn, pairShape, pairSymbols, policyLists, sameShape, shapeRefusal, shapeText, shortLeg,
} from '../trade/pair-shape.ts';
import type { ProtectionCloseReport } from '../trade/protected-pair.ts';
import { GuardedLeg, InFlightBook, ProtectedPair, inFlightEnds, reconcileHow, startPlan } from '../trade/protected-pair.ts';
import type { TraderFileState, TraderLock } from '../trade/trader-state.ts';
import { TRADER_STATE_VERSION, TraderStateStore, acquireTraderLock, savedShape, traderLockPath, traderStateFile, userStateDir } from '../trade/trader-state.ts';
import { HL_MAINNET_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import type { HostBudget } from '../venues/http-budget.ts';
import { OrderlyReader, orderlyBaseSymbol } from '../venues/orderly.ts';
import { PHOENIX_API_URL, PhoenixReader, SOLANA_MAINNET_RPC_URL, phoenixGet } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { AccountState, Clock } from '../venues/venue.ts';
import { isSessionStarting } from '../venues/venue.ts';
import type { PriceDeps, StoredPrice } from './pair-mainnet-lib.ts';
import { PRICE_MARGIN_S, ensureFresh, newPriceState, oraclePxOf, priceFitRefusal, priceLifeS, refreshLanded, refreshReachedChain } from './pair-mainnet-lib.ts';
import type { OpsCtx, OrderlyLegSpec, OrderlyOps, PairRunner } from './pair-ops.ts';
import { counting, pairOf, planClose, planOpen, recheckOpenSize, refreshForOpen, sendClose, sendOpen, venueName } from './pair-ops.ts';
import { OrderlySweep, panicReducer } from './orderly-sweep.ts';
import type { ContractSide } from './serve-contract.ts';
import { checkContractNetwork, contractEnv } from './serve-contract.ts';
import { ConfigError, START_RETRY_MAX_MS, startBackoffMs } from './start-errors.ts';

/** The IOC slippage of serve's closes, as pair-mainnet's default. */
export const SERVE_SLIPPAGE_BPS = 50;
/** serve's maker settings: pair-mainnet's defaults (--reprice-s 30, --maker-timeout-s 120, --max-orders 6, no taker fallback). */
export const SERVE_MAKER: MakerSettings = { ...DEFAULT_MAKER, timeoutMs: 120_000 };
/**
 * An owner demo entry's taker fallback (the only open serve sends one for): the IOC after the maker window is held
 * within SERVE_SLIPPAGE_BPS of Hyperliquid's mark as well as of the touch, the band and the caps. The same 50 bps every
 * serve IOC may go past the touch, measured from the mark too: for an unpriced symbol (no stored price, so no band) it
 * is what keeps a thin book whose touch ran away from the mark from pulling the fill past it, and it is the margin the
 * demo's cost bound adds (carry-plan.ts takerFallbackUsd), so the worst fill stays inside what the owner accepted.
 */
export const SERVE_DEMO_TAKER_FALLBACK: TakerFallback = { markBps: DEMO_TAKER_FALLBACK_BPS };
/** What the demo's cost bound adds per USD of leg: the farther of the two limits past the touch and the mark. */
const DEMO_FALLBACK_COST_BPS = Math.max(SERVE_SLIPPAGE_BPS, DEMO_TAKER_FALLBACK_BPS);
/**
 * The strategy loop's open, for what StrategyConfig does not set: the hold and the basis buffer the scanner's gate
 * prices a desk window on (MAINNET_COSTS), so a window shown as enterable is judged on the same numbers here.
 */
export const SERVE_HOLD_DAYS = MAINNET_COSTS.holdHours / 24;
export const SERVE_BASIS_BPS = MAINNET_COSTS.basisBufferBps;
/** At start both legs are read twice this far apart, and must agree; up to START_READ_TRIES times. */
const START_CONFIRM_MS = 3_000;
const START_READ_TRIES = 3;
/** Orders in flight from before the restart that could not be settled now are tried again this much later. */
const SETTLE_RETRY_MS = 60_000;

/** The Hyperliquid leg as serve needs it (HlLeg; tests pass their own). */
export type PairHlLeg = TradeLeg & Pick<HlLeg, 'adoptPending' | 'pendingMakerOrders' | 'cancelPending'>;

/** A pair's legs as a slot holds them. */
export interface SlotLegs {
  /** The legs' venues and markets, and which is long; absent: short Hyperliquid / long Phoenix. */
  shape?: PairShape;
  /** The venue legs in the trader's order; absent: [hl, phoenix]. */
  legs?: [TradeLeg, TradeLeg];
  /** Hyperliquid's leg when it is one (its post-only orders), else null. */
  hl: PairHlLeg | null;
  /** Phoenix's leg when it is one, else null. */
  phoenix: TradeLeg | null;
  /** A leg is priced (not in policy.unpriced by its venue's policy symbol): the stored price must be fresh. */
  priced: boolean;
}

/** What buildLegs returns: the legs, and the venue markets against the pinned accounts (one line each). */
export interface BuiltLegs extends SlotLegs {
  mismatches: string[];
}

/** SlotLegs with the shape and the legs filled in. */
export type FullLegs = SlotLegs & { shape: PairShape; legs: [TradeLeg, TradeLeg] };

/** `l` with its shape and legs filled in (absent: short Hyperliquid / long Phoenix on [hl, phoenix]); throws when they do not add up. */
export function fullLegs<T extends SlotLegs>(symbol: string, l: T): T & FullLegs {
  const shape = l.shape ?? defaultShape(symbol);
  let legs = l.legs;
  if (legs === undefined) {
    if (l.hl === null || l.phoenix === null) throw new Error(`the ${symbol} legs name no pair: a Hyperliquid and a Phoenix leg, or a shape and its legs`);
    legs = [l.hl, l.phoenix];
  }
  for (const i of [0, 1] as const) {
    if (legs[i].venue !== shape.legs[i].venue) throw new Error(`the ${symbol} leg ${i} is on ${legs[i].venue}, but the pair (${shapeText(shape)}) has ${shape.legs[i].venue} there`);
  }
  return { ...l, shape, legs };
}

/**
 * The desk's Orderly side, from serve's Orderly session (cli/serve.ts: the private stream and the signing client):
 * the pair trader's Orderly leg and the account read. Absent: no Orderly pair is built or opened here.
 */
export interface ServeOrderly {
  /**
   * The desk's Orderly leg on `spec.symbol` (IOC only, its price checked against `spec.oraclePx`, which refreshes the
   * stored price first once trading, a reduce-only close included), or null while the session is not up.
   */
  leg(spec: OrderlyLegSpec): TradeLeg | null;
  /** The desk's Orderly account over the session (equity, maintenance, positions); throws when it is not known. */
  account(): Promise<AccountState>;
  /** Before leg(): the session up and the market's lot known (read now when it is not); why not, or null. */
  ready?(symbol: string): Promise<string | null>;
  /** The session's position pushes (and seed reads): an Orderly leg's replay watch (PairTrader.positionPushed). */
  onPositions?(fn: (rows: { symbol: string; qty: bigint }[]) => void): () => void;
}

/** Where an open's or a close's lines go: `say` its plan and results, `open` what the owner must reconcile. */
export interface CarryOut {
  say(line: string): void;
  open(line: string): void;
}

/** What one open or close of the strategy loop did on a pair's legs (pair-ops.ts). */
export interface CarryResult {
  /** pair-mainnet's refusals: nothing was signed when this is not empty. */
  refusals: string[];
  /** The open's refusal for cost (CarryPlan.costRefusal, one of `refusals`), when the plan had one. */
  costRefused?: string;
  results: PairResult[];
  /** The open sent refresh_prices (refreshForOpen), paid whatever came of it. */
  refreshed?: boolean;
}

/** What an open may spend on the stored price (the strategy loop's daily cap). */
export interface RefreshAllowance {
  /** Why no refresh_prices may be sent for it (the day's refreshes of the symbol are used); absent: one may. */
  noRefresh?: string;
  /** Called for each refresh_prices sent for it (paid): its own, and any before the size check or a part. */
  onPaidRefresh?: () => void;
}

/**
 * An owner demo entry's open (the strategy loop's POST /rotate with demo): the trader waives its refusal for the
 * spread not covering the round trip, and refuses a round trip over maxLossUsd instead (carry-plan.ts carryPlan).
 */
export interface DemoOpen {
  maxLossUsd: number;
}

/** pair-mainnet's open and close (pair-ops.ts) on one pair's legs, sending through its ProtectedPair. */
export interface SlotCarry {
  /** `gate`: why nothing may be sent now (a rescue, an ADL unwind or panic_close running), checked again before each part. */
  open(request: { legUsd: number; leverage: number; reason: string; qty?: string; gate?: () => string | null; demo?: DemoOpen } & RefreshAllowance, out: CarryOut): Promise<CarryResult>;
  close(request: { reason: string }, out: CarryOut): Promise<CarryResult>;
}

/** What a pair's carry is built from. */
export interface CarryInput {
  symbol: string;
  legs: SlotLegs;
  trader: PairTrader;
  pair: ProtectedPair;
  client: NearContractClient;
  relayer: Relayer | null;
  prices: PriceDeps;
  /**
   * While on, the legs price with the stored price as it is (planOpen's estimate where none is stored): their reads
   * send no refresh_prices before the open's refusals pass. The open's own refresh (refreshForOpen) comes after them.
   */
  planning(on: boolean): void;
}

/** What servePair reads and builds; the defaults are the mainnet venues and contract, tests pass their own. */
export interface ServePairDeps {
  /** The coins the desk's Hyperliquid account holds (size not 0). */
  hlHeld(evm: string): Promise<string[]>;
  /** The symbols the desk's Phoenix trader holds, every subaccount; none when it is not registered. */
  phoenixHeld(authority: string): Promise<string[]>;
  /** Hyperliquid /info openOrders for the desk, as answered. */
  openOrders(evm: string): Promise<unknown>;
  /** The signing contract client and relayer (GIMBAL_TRADE=1 only): the operator key is loaded here. */
  signing(): Promise<{ client: NearContractClient; relayer: Relayer }>;
  /** The legs of `symbol` on `shape`'s venues (buildLiveShapeLegs). */
  buildLegs(p: { symbol: string; shape: PairShape; client: NearContractClient; relayer: Relayer | null; prices: PriceDeps; trading: () => boolean }): Promise<BuiltLegs>;
  /** pair-mainnet's open and close on a pair's legs (liveCarry). */
  carry(p: CarryInput): SlotCarry;
  close(): void;
}

export interface ServePairInput {
  mode: Mode;
  env: (name: string) => string | undefined;
  side: ContractSide;
  deskId: string;
  clock: Clock;
  log: (line: string) => void;
  publish: (event: StreamEvent) => void;
  /** --state-dir or GIMBAL_STATE_DIR when set; default: the per-user state directory. */
  stateDir?: string;
  /** This checkout is a linked git worktree: GIMBAL_TRADE=1 refuses there. */
  linkedWorktree: boolean;
  /** serve --once: alert only, whatever GIMBAL_TRADE says (it exits after one read, maybe in the middle of a close). */
  once?: boolean;
  sleep?: (ms: number) => Promise<void>;
  deps?: Partial<ServePairDeps>;
  /** What the start could read of each venue it needs (serve's health map): slow or down until the start is confirmed. */
  health?: (venue: StartReadVenue, status: 'ok' | 'slow' | 'down', detail: string | null) => void;
  /** A protection's close (panic_close, a rescue's reduce, an ADL unwind) as it ended: serve's position book takes it. */
  onProtectionClose?: (report: ProtectionCloseReport) => void;
  /**
   * The contract client on the operator key that serve's Orderly session signs with (GIMBAL_ORDERLY_PAIRS=1 only): the
   * pair's relayer signs through the same one (one transport, one nonce). Absent: the pair builds its own.
   */
  operator?: () => Promise<NearContractClient>;
  /** serve's Orderly session (GIMBAL_ORDERLY_PAIRS=1 only): absent, no Orderly pair is built or opened. */
  orderly?: ServeOrderly;
}

/** What panic_close's cancel did (rescue/closing.ts cancelResting). */
export interface CancelResult {
  cancelled: number;
  tx: TxRef[];
  notes: string[];
}

/** The ADL watch of the pair held now (the risk engine keeps this one object while the pair under it changes). */
export interface PairAdl {
  check(): ReturnType<AdlWatch['check']>;
  stop(): void;
  readonly state: AdlState;
  /** An unwind attempt runs now (AdlWatch.unwinding). */
  readonly unwinding: boolean;
  /** A check is confirming a leg off its baseline (AdlWatch.confirming). */
  readonly confirming: boolean;
}

/** What an open or a close of the strategy loop did. */
export interface HandsResult {
  ok: boolean;
  /** One line: what happened, or why nothing was sent. */
  reason: string;
  results: PairResult[];
  /** The plan and result lines (pair-mainnet's output). */
  lines: string[];
  /** What the owner must reconcile (`open:` lines without the prefix). */
  open: string[];
  tx: TxRef[];
  /** The fills' fees, USD: what the venues charged, > 0 for a cost (< 0 a maker rebate). */
  feeUsd: number;
  /**
   * Orders went out (or may have): set when the operation threw after the trader recorded a fill or the pair holds
   * a position; absent = judge by `results` and `tx`.
   */
  sent?: boolean;
  /** refresh_prices was sent for it (paid), whatever came of it. */
  refreshed?: boolean;
  /** How many refresh_prices were sent for it (with `refreshed`); absent: one. */
  refreshes?: number;
  /** An open refused for its cost (CarryPlan.costRefusal): why. The strategy loop holds the window out for the hour. */
  costRefused?: string;
}

/** The strategy loop's hands on the desk's pair (strategy/loop.ts). */
export interface PairHands {
  /** The pair symbols the policy allows (in both policy.hl_assets and policy.phoenix_markets). */
  readonly symbols: readonly string[];
  /**
   * GIMBAL_ORDERLY_PAIRS=1 only (absent otherwise): the symbols a pair long `long` / short `short` may open on (both
   * venues list it; an Orderly leg only with serve's Orderly session).
   */
  pairSymbols?(long: VenueId, short: VenueId): readonly string[];
  /** GIMBAL_ORDERLY_PAIRS=1 only: the long and short venues of the pair the trader has now (held or flat), or null. */
  heldPair?(): { long: VenueId; short: VenueId } | null;
  /**
   * GIMBAL_ORDERLY_PAIRS=1 only: why no rotation may leave the pair held (an Orderly leg: its close arms the replay
   * watch), or null; prepareOpen refuses in the same words. The loop asks it before its risk check.
   */
  rotateOutRefused?(): string | null;
  /** Why nothing can be opened or closed now, or null. */
  blocked(): string | null;
  /**
   * Whether an open could be sent now: blocked() without its "an open or close is running" term, so a scan that runs
   * during the loop's own open or close still sees it (the scanner's oracleRefreshAtOpen). False before the start is
   * confirmed, once stopped, while alert only, and while a protection's close or an ADL event runs.
   */
  canOpen(): boolean;
  /**
   * A rotate's first step, before the held pair is closed: the stored price of `symbol` refreshed when it would not
   * live an open's first part (serve's maker), so a refresh that fails keeps the held pair instead of leaving the desk
   * flat. ok: the price lives it, or `symbol` has no stored price to keep (unpriced).
   */
  prepareOpen(request: { symbol: string } & Pick<RefreshAllowance, 'noRefresh'>): Promise<HandsResult>;
  /** The symbol the trader holds open (a leg not flat, or unknown), or null when flat or no pair. */
  heldSymbol(): string | null;
  /** Each leg's venue and position the trader holds (its baseline), signed; null = not known; none when no pair. */
  heldLegs(): { venue: string; qty: bigint | null }[];
  /**
   * pair-mainnet open on `symbol`, short `short` and long `long` (default short Hyperliquid and long Phoenix; any other
   * pair only with GIMBAL_ORDERLY_PAIRS=1, an Orderly leg only with serve's Orderly session): refusals first, then
   * maker first (or two IOCs at once without a Hyperliquid leg). `gate` is asked again right before the first order and
   * before each later part: a reason refuses (or stops) the open there.
   */
  open(request: { symbol: string; long?: VenueId; short?: VenueId; legUsd: number; leverage: number; reason: string; qty?: string; gate?: () => string | null; demo?: DemoOpen } & Pick<RefreshAllowance, 'noRefresh'>): Promise<HandsResult>;
  /**
   * The trader's record against its last live reads (reconcileWithVenues): when they disagree on one leg or flat, two
   * agreeing venue reads that confirm it are adopted as the record. The line says what changed; null: nothing did.
   */
  reconcile(): Promise<string | null>;
  /** pair-mainnet close of the pair held, reduce-only, maker first. */
  close(request: { reason: string }): Promise<HandsResult>;
}

export interface ServePair {
  /** The pair held now (it changes when the strategy loop opens one on another symbol). */
  readonly pair: ProtectedPair | null;
  adl: PairAdl | undefined;
  /** The rescue's and panic_close's reducer: the pair when it trades, else null (they then say nothing traded). */
  reducer(): Reducer | null;
  /** Why nothing is traded here (panic_close says so), or null when the pair trades. */
  notTrading(): string | null;
  /** panic_close: cancels the desk's resting Hyperliquid orders (live only; undefined otherwise). */
  cancelResting?: () => Promise<CancelResult>;
  /** The strategy loop's hands: undefined when this serve does not trade. */
  hands?: PairHands;
  /** What serve's start says about the pair, one line each. */
  lines: string[];
  /** Waits up to `timeoutMs` for a close or an open in flight to end; true when none runs (serve's shutdown, before stop()). */
  drain(timeoutMs: number): Promise<boolean>;
  /** Settles the orders in flight from before the restart from the venues (serve runs it on a timer; tests call it). */
  settleInFlight?: () => Promise<string | null>;
  /** Why the start is not confirmed (a read it needs failed; the legs are unknown, nothing trades), or null once it is. */
  unconfirmed?(): string | null;
  /** Tries the start again now while it is not confirmed (serve runs it on a timer; tests call it); the line when it was. */
  retryStart?: () => Promise<string | null>;
  /**
   * serve's monitor (every 30 min): "pair unprotected: legs unknown since T, N tries" while the start is not confirmed
   * (a pair may be open with no trader, ADL or reduce on it), journaled again at most every UNPROTECTED_REMIND_MS; null
   * once the legs are known.
   */
  monitor?(): string | null;
  /** Turns trading off first (every order and close refused from then on), then stops the watch and the trader, closes the readers and releases the lock. */
  stop(): void;
}

/**
 * The scanner's oracleRefreshAtOpen for serve's pair: whether an open sent now would refresh a missing or stale stored
 * price (refreshForOpen). Only while the hands can open (PairHands.canOpen): not before the start is confirmed, after
 * stop(), or while the pair is alert only; true during the loop's own open or close.
 */
export function pairRefreshesAtOpen(pair: Pick<ServePair, 'hands'> | null | undefined): boolean {
  return pair?.hands?.canOpen() === true;
}

const none = (lines: string[], why: string, stop: () => void = () => {}): ServePair => ({
  pair: null, adl: undefined, reducer: () => null, notTrading: () => why, lines, drain: async () => true, stop,
});

/** What a start reads from: the two venues and NEAR (the signing client): serve's health keys. */
export type StartVenue = 'hyperliquid' | 'phoenix' | 'near';
/** A start read's venue: Orderly too (an Orderly pair's; serve's health map keys it with GIMBAL_ORDERLY_PAIRS=1). */
export type StartReadVenue = StartVenue | 'orderly';

/** A start read that failed (a timeout, an HTTP error, a lagging snapshot): tried again, never a reason to exit. */
export class StartReadError extends Error {
  readonly venue: StartReadVenue;
  /** What it says of the venue's health; null: nothing (two reads that differ). */
  readonly status: 'slow' | 'down' | null;
  constructor(venue: StartReadVenue, status: 'slow' | 'down' | null, message: string) {
    super(message);
    this.name = 'StartReadError';
    this.venue = venue;
    this.status = status;
  }
}

/** `run`, its failure a StartReadError of `venue` (a ConfigError or a StartReadError is passed on as it is). */
async function startRead<T>(venue: StartReadVenue, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ConfigError || err instanceof StartReadError) throw err;
    throw new StartReadError(venue, 'down', `${venue}: ${errorMessage(err)}`);
  }
}

/** Resting Hyperliquid orders of `coin` in an openOrders answer; a string when the answer cannot be read. */
export function restingOn(raw: unknown, coin: string): { side: LegSide | string; sz: string; oid: unknown }[] | string {
  if (!Array.isArray(raw)) return `the Hyperliquid open orders cannot be read (${(typeof raw === 'string' ? raw : JSON.stringify(raw) ?? 'nothing').slice(0, 80)})`;
  return (raw as { coin?: unknown; side?: unknown; sz?: unknown; oid?: unknown }[])
    .filter((o) => o?.coin === coin)
    .map((o) => ({ side: o.side === 'B' ? 'BUY' : o.side === 'A' ? 'SELL' : String(o.side), sz: String(o.sz), oid: o.oid }));
}

/** One symbol's pair: its legs, trader, protections and carry. */
interface Slot {
  symbol: string;
  /** The pair's legs and which is long. */
  shape: PairShape;
  pp: ProtectedPair;
  adl: AdlWatch;
  trader: PairTrader;
  carry: SlotCarry;
  /** Whether it trades now (false while suspended or stopped). */
  live(): boolean;
  /** Why it does not trade (empty when it does). */
  why: string[];
  /** What its start said, one line each. */
  lines: string[];
  settle(): Promise<string | null>;
  /** Legs flat and nothing of ours left that could move them: it may be replaced by another symbol's pair. */
  /**
   * Why a new pair cannot open next to this slot now, or null. `replacing` (default true): the open builds another slot
   * in its place, so a replayable leg still watched counts too (the same slot keeps its trader and its watch).
   */
  quiet(replacing?: boolean): string | null;
  /** While a new pair is built: nothing signed or saved; `false` resumes. */
  suspend(on: boolean): void;
  /** After an open: legs moved outside the trader (finish()'s residual hedge) are adopted when they offset. */
  readopt(): Promise<string | null>;
  /** The trader's record against its last live reads; see PairHands.reconcile. */
  reconcile(): Promise<string | null>;
  /** Orders added to the in-flight book since the pair started (a throw is judged by it moving). */
  signedOrders(): number;
  /** Ends this pair's trader, watch and timers (the lock and readers stay with serve). */
  end(): void;
}

/** How often the "pair unprotected" alert is journaled again while the start is not confirmed (at most hourly). */
export const UNPROTECTED_REMIND_MS = 60 * 60_000;

export async function servePair(input: ServePairInput): Promise<ServePair> {
  const { env, log } = input;
  if (input.mode !== 'mainnet') return none([`pair      none on ${input.mode}: the pair is Hyperliquid and Phoenix, and Phoenix is mainnet only`], `no pair on ${input.mode}`);
  const asksTrade = env('GIMBAL_TRADE') === '1';
  const wantLive = asksTrade && input.once !== true;
  if (wantLive && input.linkedWorktree) throw new Error('GIMBAL_TRADE=1: this checkout is a linked git worktree, and trading refuses here (as pair-mainnet --send does); run serve from the main checkout');
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hlUrl = (env('HL_API_URL') ?? HL_MAINNET_URL).replace(/\/+$/, '').replace(/\/info$/, '');
  if (/testnet/.test(hlUrl)) throw new Error(`HL_API_URL ${hlUrl} is a testnet URL; the pair is on mainnet`);
  const phoenixUrl = (env('PHOENIX_API_URL') ?? PHOENIX_API_URL).replace(/\/+$/, '');
  const solRpcUrl = env('SOLANA_RPC_URL') ?? SOLANA_MAINNET_RPC_URL;
  const desk = input.side.desk;
  const policy: ContractPolicy = desk.policy;
  const evm = desk.evm_address.toLowerCase();
  const contractId = input.side.client.contractId;
  const deps: ServePairDeps = { ...defaultDeps({ input, hlUrl, phoenixUrl, solRpcUrl }), ...input.deps };

  // The lock first, in each start attempt (attempt() below): pair-mainnet --send cannot start between the reads and
  // the first save. One that is held is a start not confirmed (tried again), never an exit.
  let lock: TraderLock | null = null;
  // Who holds the lock: the start (an attempt, then the slot it landed: `startHolds`), and serve's own short users
  // (panic_close's Orderly sweep, its resting-order cancel: `borrowed`). It goes back once neither holds it.
  let startHolds = false;
  let borrowed = 0;
  const release = () => {
    lock?.release();
    lock = null;
  };
  /** The start lets the lock go (nothing trades): now, or when the last borrower gives it back. */
  const yieldLock = () => {
    startHolds = false;
    if (borrowed === 0) release();
  };
  const lockPath = () => traderLockPath(env, input.mode, contractId, input.deskId);
  /** A short user takes the lock (or shares the start's); why not, or null. Each borrow is given back by returnLock. */
  const borrowLock = (): string | null => {
    if (lock === null) {
      try {
        lock = acquireTraderLock(lockPath());
      } catch (err) {
        return `the trader lock is not held: ${errorMessage(err)} (pair-mainnet --send holds the same lock)`;
      }
      // A stale lock taken over is journaled as the start's attempt() journals it (GIMBAL_ORDERLY_PAIRS=1 only: with it
      // off a borrow says nothing, as before).
      const took = (lock as TraderLock).tookOver;
      if (took !== null && orderlyPairsOn(env)) {
        log(`pair      ${took}`);
        const t = input.clock.now();
        input.publish({
          type: 'journal',
          data: {
            id: `pair-lock-${t.toString(36)}`, t, kind: 'error', numbers: { stage: 'lock' }, tx: [],
            summary: `pair: ${took}. A serve or pair-mainnet that was killed (an OOM, a SIGKILL, a container restart) leaves its lock behind; nothing else trades this desk now`,
          },
        });
      }
    }
    borrowed++;
    return null;
  };
  const returnLock = () => {
    borrowed = Math.max(0, borrowed - 1);
    if (borrowed === 0 && !startHolds) release();
  };
  const stopNone = () => {
    deps.close();
    yieldLock();
  };

  try {
    const identity = { contractId, deskId: input.deskId, evm };
    const store = new TraderStateStore(traderStateFile(input.stateDir ?? userStateDir(env), input.mode, identity), identity);
    const freshWant = `${contractId}/${input.deskId}`;
    const common = policy.hl_assets.map((a) => a.symbol).filter((s) => policy.phoenix_markets.some((m) => m.symbol === s));
    // GIMBAL_ORDERLY_PAIRS=1: a symbol any two of the policy's venues list is a pair symbol, and an Orderly pair may be
    // held; without it, only the symbols in both hl_assets and phoenix_markets (Orderly is never read).
    const orderlyOn = orderlyPairsOn(env);
    const pairable = !orderlyOn ? common : [...new Set([
      ...policy.hl_assets.map((a) => a.symbol), ...policy.phoenix_markets.map((m) => m.symbol),
      ...(policy.orderly_symbols ?? []).map((m) => orderlyBaseSymbol(m)).filter((x): x is string => x !== null),
    ])].filter((sym) => PAIR_VENUES.filter((v) => policyLists(policy, v, sym)).length >= 2);
    const flatWhy = `both legs flat and no GIMBAL_PAIR_SYMBOL (policy pairs: ${common.join(', ') || 'none'})`;
    // A trader state saved for another pair than short Hyperliquid / long Phoenix (an Orderly leg) with
    // GIMBAL_ORDERLY_PAIRS off: no engine here could read or close that pair, and after Orderly's IP restriction the
    // owner's machine cannot either (pair-mainnet refuses Orderly). serve refuses to start rather than run blind.
    if (!orderlyOn) {
      const saved = store.load();
      const was = saved.kind === 'loaded' ? savedShape(saved.state) : null;
      if (saved.kind === 'loaded' && was !== null && saved.state.symbol !== null && !isDefaultShape(was, saved.state.symbol)) {
        throw new ConfigError(`the trader state ${store.path} is for the ${saved.state.symbol} pair ${shapeText(was)}, and GIMBAL_ORDERLY_PAIRS is not 1: `
          + 'no engine here could protect or close it (panic_close included). Start serve with GIMBAL_ORDERLY_PAIRS=1 and its Orderly session; '
          + `only once that pair's legs are flat on the venues, move the file aside and start once with GIMBAL_TRADER_FRESH=${freshWant}`);
      }
    }

    // ---- the signing side: loaded by the first start attempt that gets that far, then kept ----
    let relayer: Relayer | null = null;
    let client: NearContractClient = input.side.client;
    let signing = false;
    const prices: PriceDeps = {
      maxAgeS: policy.oracle_max_age_s, send: wantLive, read: (s) => storedPrice(client, s),
      refresh: (s, maxAgeS) => client.refreshPrices([s], { maxAgeS }), now: () => input.clock.now(), log: (l) => log(`pair ${l.trim()}`),
      landed: refreshLanded, reachedChain: refreshReachedChain, ...newPriceState(),
    };
    // stop() sets it first: from then on nothing is signed (its lock is being released).
    let stopped = false;
    // Orders in flight settled at start without an adopt: the owner hears of it in the journal, not only the log.
    let ownerSaid: string | null = null;
    const ownerAlert = (line: string) => {
      if (line === ownerSaid) return;
      ownerSaid = line;
      const t = input.clock.now();
      input.publish({ type: 'journal', data: { id: `pair-owner-${t.toString(36)}`, t, kind: 'error', summary: `owner: ${line}`, numbers: { stage: 'in-flight' }, tx: [] } });
    };
    const onOpen = (open: string[]) => {
      for (const line of open) log(line);
      const t = input.clock.now();
      input.publish({ type: 'journal', data: { id: `pair-${t.toString(36)}`, t, kind: 'error', summary: open.join(' | '), numbers: { venue: 'hyperliquid' }, tx: [] } });
    };

    /** `symbol`'s pair on `shape`'s legs, built and adopted as the start does (see the header). */
    const makeSlot = async (sym: string, shape: PairShape = defaultShape(sym)): Promise<Slot> => {
      let live = false;
      let suspended = false;
      let planning = false;
      // The Phoenix exchange snapshot (and the market's spline) are read here, or the Orderly leg is made over the
      // session: a failure is a start read that failed.
      const buildVenue = shape.legs.some((l) => l.venue === 'phoenix') ? 'phoenix' : shape.legs.some((l) => l.venue === 'orderly') ? 'orderly' : 'hyperliquid';
      const legs = fullLegs(sym, await startRead(buildVenue, () => deps.buildLegs({ symbol: sym, shape, client, relayer, prices, trading: () => live && !suspended && !planning })));
      if (!sameShape(legs.shape, shape)) throw new Error(`the ${sym} legs built are ${shapeText(legs.shape)}, not ${shapeText(shape)}`);
      const hlLeg = legs.hl;
      const why: string[] = [];
      why.push(...legs.mismatches);
      if (!(priceLifeS(policy.oracle_max_age_s) > PRICE_MARGIN_S)) {
        why.push(`oracle_max_age_s ${policy.oracle_max_age_s} leaves a fresh price ${priceLifeS(policy.oracle_max_age_s)} s, not more than the ${PRICE_MARGIN_S} s an IOC and its retry need`);
      }
      // Open orders that cannot be read are a read that failed (tried again), not a reason to stay alert only. Only
      // Hyperliquid's leg rests orders (post-only): a pair without it has none to look for.
      if (hlLeg !== null) {
        const resting = restingOn(await deps.openOrders(evm).catch((err: unknown) => errorMessage(err)), sym);
        if (typeof resting === 'string') {
          throw new StartReadError('hyperliquid', 'down', `${resting}: a resting ${sym} order could fill under the trader`);
        } else if (resting.length > 0) {
          const names = resting.map((o) => `${o.side} ${o.sz} (oid ${String(o.oid)})`).join(', ');
          why.push(`Hyperliquid has ${resting.length} resting ${sym} order(s) (${names}), left by an earlier pair-mainnet run: one could fill under the trader and the ADL watch would misread it; cancel it on Hyperliquid, reconcile both legs, then start serve again`);
        }
      }

      // ---- what the trader holds ----
      const read = await readTwice(legs.legs, sleep, log);
      const plan = startPlan({ symbol: sym, pair: shape, read, saved: store.load(), fresh: env('GIMBAL_TRADER_FRESH'), freshWant, path: store.path, now: input.clock.now() });
      if (!plan.stateOk && plan.why !== null) why.push(plan.why);
      if (hlLeg === null && plan.pendingMaker.length > 0) why.push(`the trader state holds ${plan.pendingMaker.length} Hyperliquid post-only order(s), but this pair has no Hyperliquid leg: cancel them on Hyperliquid and reconcile`);
      if (input.once === true) why.unshift(`serve --once is alert only${asksTrade ? ' (GIMBAL_TRADE=1 is ignored: it exits after one read, maybe in the middle of a close)' : ''}`);
      else if (!asksTrade) why.unshift('GIMBAL_TRADE is not 1');
      else if (lock === null) why.unshift('the trader lock is not held');
      live = wantLive && why.length === 0;

      const book = new InFlightBook(plan.inFlight);
      // Set once the trader and the watch exist; a save before that has nothing to write.
      let snapshot: (() => TraderFileState) | null = null;
      const trades = () => live && !suspended;
      const save = () => {
        if (!trades() || snapshot === null) return;
        store.save(snapshot());
      };
      let pp: ProtectedPair | null = null;
      let watch: AdlWatch | null = null;
      const guard = (index: 0 | 1) => ({
        index, live: trades, stopped: () => stopped, now: () => input.clock.now(), opening: () => pp?.openingHere === true,
        beforeSign: (o: Parameters<InFlightBook['add']>[0]) => book.add(o, save),
      });
      const trader = new PairTrader({
        legs: [new GuardedLeg(legs.legs[0], guard(0)), new GuardedLeg(legs.legs[1], guard(1))],
        priceBandBps: policy.price_band_bps, clock: input.clock, log: (line) => log(`pair      ${line}`),
        // Only the strategy loop's open opens (ProtectedPair.openInChunks), and never while the pair is paused after an ADL.
        openBlocked: () => (pp?.openingHere !== true ? 'serve opens a pair only through the strategy loop (auto, or POST /rotate)' : watch?.paused ?? null),
        onWatch: (w) => {
          // The check's orders are in the trader's state now: they leave the book in the same save.
          book.watchRecorded();
          try {
            save();
          } catch (err) {
            log(`pair      trader state not saved after a watch check: ${errorMessage(err)}`);
          }
          if (w.status === 'unhedged') onOpen(pp?.openLines() ?? [`open:     watch: ${w.notes.join('; ')}`]);
        },
      });
      if (plan.restore !== null) trader.importState(plan.restore);
      if (plan.adopt !== null) trader.adopt(plan.adopt);
      hlLeg?.adoptPending(plan.pendingMaker);
      pp = new ProtectedPair({
        trader, symbol: sym, live, why: live ? null : why.join('; '), inFlight: book, adlHold: plan.adlHold,
        reconcile: reconcileHow({ symbol: sym, path: store.path, freshWant }),
        ...(legs.priced ? { freshPrice: async () => { await ensureFresh(prices, sym, PRICE_MARGIN_S); } } : {}),
        pendingMaker: () => hlLeg?.pendingMakerOrders() ?? [],
        cancelPending: async (reason) => (hlLeg === null ? [] : hlLeg.cancelPending(reason)),
        save, onOpen, log: (l) => log(`pair      ${l}`), sleep, now: () => input.clock.now(),
        ...(input.onProtectionClose === undefined ? {} : { onProtectionClose: input.onProtectionClose }),
      });
      const pq = pp;
      const adl = new AdlWatch(pq, {
        state: plan.adl, trade: live, hold: () => pq.adlHold, log: (l) => log(`pair      ${l}`), clock: input.clock, sleep,
        // Throws when the save fails: an unwind attempt then sends nothing (risk/adl.ts).
        onChange: () => save(),
      });
      watch = adl;
      // An Orderly leg: the session's position pushes feed the trader's replay watch (a signed copy of an order can
      // still run for 300 s), as pair-live does on testnet.
      const orderlyIndex = trader.legs.findIndex((l) => l.venue === 'orderly');
      const unpushed = orderlyIndex === -1 || input.orderly?.onPositions === undefined ? () => {} : input.orderly.onPositions((rows) => {
        const leg = trader.legs[orderlyIndex]!;
        const mine = rows.filter((r) => r.symbol === leg.symbol);
        if (mine.length === 0 || !trades()) return;
        void trader.positionPushed(leg, mine.reduce((sum, r) => sum + r.qty, 0n));
      });
      snapshot = () => ({
        version: TRADER_STATE_VERSION, savedAt: input.clock.now(), symbol: sym, pair: shape, trader: trader.exportState(),
        pendingMaker: [...(hlLeg?.pendingMakerOrders() ?? [])], inFlight: book.orders, adl: adl.state,
      });
      save();

      const slotLines: string[] = [];
      for (const n of plan.notes) slotLines.push(`pair      ${n}`);
      for (const line of plan.owner) ownerAlert(line);
      const heldLock = lock as TraderLock | null;
      const sideOf = (q: bigint) => (q < 0n ? 'short' : q > 0n ? 'long' : 'flat');
      slotLines.push(`pair      ${sym}: ${shape.legs[0].venue} ${signedQtyString(read[0])} (${sideOf(read[0])}), ${shape.legs[1].venue} ${signedQtyString(read[1])} (${sideOf(read[1])})`
        + `${read[0] + read[1] === 0n ? '' : ' NOT offsetting'}; state ${store.path}${live ? '' : ' (read only)'}${heldLock === null || !live ? '' : `, lock ${heldLock.path}`}`);
      for (const line of pq.openLines()) slotLines.push(line);

      // Orders in flight from before the restart that could still run at start: settled from the venues once the
      // youngest can no longer run (ProtectedPair.resolveInFlight), tried again a minute later when it cannot be decided.
      let ended = false;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      const settleLater = (ms: number) => {
        if (stopped || ended || pq.adlHold === null || book.restored.length === 0) return;
        settleTimer = setTimeout(() => void settle(), Math.max(0, ms));
        settleTimer.unref?.();
      };
      const settle = async (): Promise<string | null> => {
        settleTimer = null;
        if (stopped || ended || pq.adlHold === null || book.restored.length === 0) return null;
        const epoch = trader.baselineEpoch;
        const sent = book.orders.length;
        let out: { line: string; again: boolean; owner?: boolean } | null;
        try {
          const now = await readTwice(trader.legs, sleep, log);
          // A close or a watch check of ours ran meanwhile: the reads may hold its orders, so they settle nothing.
          out = trader.baselineEpoch !== epoch || book.orders.length !== sent
            ? { line: 'orders in flight from before the restart: an order of ours went out while the legs were read; tried again in 1 min', again: true }
            : pq.resolveInFlight(now, input.clock.now());
        } catch (err) {
          out = { line: `orders in flight from before the restart: the legs could not be read to settle them (${errorMessage(err)}); tried again in 1 min`, again: true };
        }
        if (out === null) return null;
        log(`pair      ${out.line}`);
        if (out.owner === true) ownerAlert(out.line);
        if (out.again) settleLater(Math.max(SETTLE_RETRY_MS, (inFlightEnds(book.restored) ?? 0) - input.clock.now()));
        return out.line;
      };
      // Orders that could still run at start, or that wait for an order with no answer: the others were settled by
      // startPlan (adopted, the baselines kept for the ADL watch, or a hold that names what the owner runs).
      const ends = inFlightEnds(book.restored);
      const noAnswer = trader.legs.some((l) => trader.unsettled(l) !== null);
      if (live && pq.adlHold !== null && ends !== null && (ends > input.clock.now() || noAnswer)) {
        settleLater(ends > input.clock.now() ? ends - input.clock.now() + START_CONFIRM_MS : SETTLE_RETRY_MS);
      }
      const carry = deps.carry({ symbol: sym, legs, trader, pair: pq, client, relayer, prices, planning: (on) => { planning = on; } });
      return {
        symbol: sym, shape, pp: pq, adl, trader, carry, why, lines: slotLines, settle,
        live: trades,
        quiet: (replacing = true) => {
          const base = trader.legs.map((l) => trader.baseline(l));
          if (base.some((b) => b === null || b === undefined || b !== 0n)) return `the ${sym} legs are not flat (${base.map((b) => (b === null || b === undefined ? 'unknown' : signedQtyString(b))).join(' and ')})`;
          if (pq.closing) return `a close runs on ${sym}`;
          if (book.orders.length > 0) return `${book.orders.length} ${sym} order(s) are in flight with no saved result`;
          if (trader.legs.some((l) => trader.unsettled(l) !== null)) return `a ${sym} order has no answer and may still run`;
          // Orderly takes a signed copy of an order for 300 s: this pair's trader watches for one until then, and a
          // pair built in its place would not (only Orderly legs are replayable).
          const replay = replacing ? trader.legs.find((l) => l.replayable && trader.watching(l)) : undefined;
          if (replay !== undefined) return `a signed ${replay.venue} ${replay.symbol} order can still be replayed, and this pair's trader watches for it until its window ends`;
          if ((hlLeg?.pendingMakerOrders().length ?? 0) > 0) return `a ${sym} post-only order is not settled`;
          if (pq.adlHold !== null) return `ADL only alerts on ${sym}: ${pq.adlHold}`;
          if (adl.state.event !== null) return `an ADL event on ${sym} is in progress`;
          return null;
        },
        suspend: (on) => {
          suspended = on;
        },
        readopt: async () => {
          // Only orders that no trader result holds (the residual hedge) leave the book this way.
          if (book.orders.length === 0 || pq.closing || stopped) return null;
          if (trader.legs.some((l) => trader.unsettled(l) !== null) || (hlLeg?.pendingMakerOrders().length ?? 0) > 0) return null;
          const now = await readTwice(trader.legs, sleep, log).catch(() => null);
          if (now === null || now[0] + now[1] !== 0n || pq.closing) return null;
          pq.adopt(now);
          return `adopted ${signedQtyString(now[0])} and ${signedQtyString(now[1])} ${sym} after the residual hedge`;
        },
        reconcile: () => reconcileWithVenues({
          trader, symbol: sym, sleep, confirmMs: START_CONFIRM_MS,
          idle: () => (pq.closing || stopped || !trades() ? 'not idle' : book.orders.length > 0 ? 'orders in flight'
            : trader.legs.some((l) => trader.unsettled(l) !== null) || (hlLeg?.pendingMakerOrders().length ?? 0) > 0 ? 'an order may still run' : null),
          signed: () => book.signed,
          adopt: (read) => pq.adopt(read),
        }),
        signedOrders: () => book.signed,
        end: () => {
          ended = true;
          live = false;
          unpushed();
          pq.stop();
          if (settleTimer !== null) clearTimeout(settleTimer);
          settleTimer = null;
          adl.stop();
          trader.stop();
        },
      };
    };

    /** What one start attempt found: nothing to protect (`why`), or the pair (`slot` null: none held, the loop may open one). */
    type Started = { kind: 'none'; lines: string[]; why: string } | { kind: 'pair'; lines: string[]; slot: Slot | null };
    /**
     * Which pair, the signing side, then the pair's slot (its legs synced to their chains and read twice alike).
     * Throws a ConfigError (serve stops) or a read that failed (the start is not confirmed and is tried again).
     */
    const attempt = async (): Promise<Started> => {
      // A start attempt holds the lock, one a borrower holds now included (it is not let go while the start holds it).
      if (wantLive && lock === null) {
        try {
          lock = acquireTraderLock(lockPath());
        } catch (err) {
          throw new Error(`the trader lock is not held: ${errorMessage(err)} (pair-mainnet --send holds the same lock)`);
        }
        const took = (lock as TraderLock).tookOver;
        if (took !== null) {
          log(`pair      ${took}`);
          journal('error', `pair: ${took}. A serve or pair-mainnet that was killed (an OOM, a SIGKILL, a container restart) leaves its lock behind; nothing else trades this desk now`, { stage: 'lock' });
        }
      }
      if (wantLive) startHolds = true;
      const saved = store.load();
      const heldOn = new Map<VenueId, string[]>([
        ['hyperliquid', await startRead('hyperliquid', () => deps.hlHeld(evm))],
        ['phoenix', await startRead('phoenix', () => deps.phoenixHeld(desk.solana.authority))],
      ]);
      // The desk's Orderly positions, only with GIMBAL_ORDERLY_PAIRS=1 and serve's Orderly session.
      if (orderlyOn && input.orderly !== undefined) {
        const ol = input.orderly;
        heldOn.set('orderly', await startRead('orderly', async () => (await ol.account()).positions.filter((x) => x.size !== 0).map((x) => orderlyBaseSymbol(x.symbol) ?? x.symbol)));
      }
      const held = [...new Set([...heldOn.values()].flat())];
      const lines: string[] = [];
      const outside = held.filter((s) => !pairable.includes(s));
      if (outside.length > 0) lines.push(`pair      not protected (not in ${orderlyOn ? 'two' : 'both'} policy lists): ${outside.join(', ')}`);
      const open = held.filter((s) => pairable.includes(s));
      if (open.length > 1) {
        return { kind: 'none', lines: [...lines, `pair      NONE: ${open.join(' and ')} are both open; serve protects one pair: close one with pair-mainnet first`], why: 'two pairs are open: serve protects none' };
      }
      const savedSymbol = saved.kind === 'loaded' ? saved.state.symbol : null;
      const symbol = open[0] ?? env('GIMBAL_PAIR_SYMBOL')?.trim() ?? savedSymbol ?? (common.length === 1 ? common[0]! : null);
      if (symbol === null) {
        // Nothing held: a trading serve still keeps the lock when the state allows trading, so the loop may open one.
        const fresh = env('GIMBAL_TRADER_FRESH');
        const stateWhy = saved.kind === 'loaded' || fresh === freshWant ? null
          : saved.kind === 'none' ? `no trader state at ${store.path}: a missing file is not a fresh start; after checking both legs on the venues, start once with GIMBAL_TRADER_FRESH=${freshWant}`
          : `${saved.problem}; after reconciling both legs, start once with GIMBAL_TRADER_FRESH=${freshWant}`;
        if (!wantLive || stateWhy !== null || common.length === 0) {
          const why = !wantLive ? 'nothing to protect' : stateWhy ?? 'the policy lists no symbol in both hl_assets and phoenix_markets';
          return { kind: 'none', lines: [...lines, `pair      none: ${flatWhy}; ${why}`], why: 'no pair is open' };
        }
      }
      if (symbol !== null && !pairable.includes(symbol)) {
        return { kind: 'none', lines: [...lines, orderlyOn
          ? `pair      none: ${symbol} is not in two of policy.hl_assets, policy.phoenix_markets and policy.orderly_symbols (${pairable.join(', ') || 'none'})`
          : `pair      none: ${symbol} is not in both policy.hl_assets and policy.phoenix_markets (${common.join(', ') || 'none'})`], why: `${symbol} is not a policy pair` };
      }
      // The pair's legs: short Hyperliquid / long Phoenix, or with GIMBAL_ORDERLY_PAIRS=1 the saved pair of that symbol.
      // A venue holding the symbol that is not one of its legs is not protected: nothing is adopted over it.
      let shape: PairShape | null = null;
      if (symbol !== null) {
        const was = saved.kind === 'loaded' && saved.state.symbol === symbol ? savedShape(saved.state) : null;
        shape = orderlyOn && was !== null ? was : defaultShape(symbol);
        if (orderlyOn) {
          const s = shape;
          const stray = [...heldOn.entries()].filter(([v, syms]) => syms.includes(symbol) && !s.legs.some((l) => l.venue === v)).map(([v]) => v);
          if (stray.length > 0) {
            return { kind: 'none', lines: [...lines, `pair      NONE: ${symbol} is held on ${stray.join(' and ')}, which is not a leg of the pair (${shapeText(s)}): reconcile it by hand, then start serve again`], why: `${symbol} is held outside its pair's legs` };
          }
          if (!isDefaultShape(s, symbol) && input.orderly === undefined && s.legs.some((l) => l.venue === 'orderly')) {
            return { kind: 'none', lines: [...lines, `pair      NONE: the ${symbol} pair (${shapeText(s)}) has an Orderly leg, and serve has no Orderly session: nothing protects it here`], why: 'an Orderly pair needs serve\'s Orderly session' };
          }
        }
      }
      if (wantLive && !signing) {
        try {
          ({ client, relayer } = await deps.signing());
        } catch (err) {
          throw err instanceof ConfigError ? err : new StartReadError('near', 'down', `the signing contract client: ${errorMessage(err)}`);
        }
        signing = true;
      }
      if (symbol === null) {
        lines.push(`pair      none held: ${flatWhy}; the strategy loop may open one of ${common.join(', ')} (state ${store.path}, lock ${(lock as TraderLock | null)?.path ?? 'none'})`);
        return { kind: 'pair', lines, slot: null };
      }
      const slot = await makeSlot(symbol, shape ?? defaultShape(symbol));
      return { kind: 'pair', lines: [...lines, ...slot.lines], slot };
    };

    let current: Slot | null = null;

    // ---- panic_close's Orderly sweep (GIMBAL_ORDERLY_PAIRS=1, trading): orderly-sweep.ts ----
    // It may sign with no pair trader (a NONE start, a start not confirmed, a pair alert only): it borrows the trader
    // lock and takes the signing client itself; the lock goes back after when the start does not hold it.
    const sweep = !orderlyOn || !wantLive ? null : new OrderlySweep({
      session: input.orderly,
      heldKnown: () => {
        // Without the session nothing on Orderly can be read: the saved trader state is all that says what is there.
        const saved = store.load();
        if (saved.kind === 'none') return 'flat';
        if (saved.kind !== 'loaded') return 'open';
        const shape = savedShape(saved.state);
        const i = shape?.legs.findIndex((l) => l.venue === 'orderly') ?? -1;
        if (i === -1) return 'none';
        const base = saved.state.trader?.baselines[i];
        const now = input.clock.now();
        // An Orderly order signed within REPLAY_WINDOW_MS may still be replayed: the leg may be held again. Every order
        // is followed by a save, so a save within the window counts as one.
        const recent = now - saved.state.savedAt < REPLAY_WINDOW_MS;
        const pendingHere = saved.state.inFlight.some((o) => o.index === i) || (saved.state.trader?.unsettled ?? []).some((u) => u.index === i);
        return base === null || (base !== undefined && base !== 0n) || pendingHere || recent ? 'open' : 'flat';
      },
      covered: () => (current !== null && current.live() && !stopped ? current.trader.legs.filter((l) => l.venue === 'orderly').map((l) => l.symbol) : []),
      spec: (market) => {
        const base = orderlyBaseSymbol(market);
        if (base === null) return null;
        const unpriced = unpricedEntry(policy, 'orderly', market);
        return {
          symbol: market, oraclePx: unpriced !== undefined ? async () => null : oraclePxOf(prices, base, () => !stopped),
          ...legCaps(policy, 'orderly', market), slippageBps: SERVE_SLIPPAGE_BPS,
        };
      },
      begin: async () => {
        if (stopped) return 'serve is stopping: nothing is signed';
        const why = borrowLock();
        if (why !== null) return why;
        if (!signing) {
          try {
            ({ client, relayer } = await deps.signing());
            signing = true;
          } catch (err) {
            returnLock();
            return `the signing contract client: ${errorMessage(err)}`;
          }
        }
        return null;
      },
      end: returnLock,
      bandBps: policy.price_band_bps, clock: input.clock, sleep, log, publish: input.publish,
    });
    /** With no pair trader: what panic_close leaves held on Hyperliquid and Phoenix (null: nothing), read now. */
    const leftOutside = async (): Promise<string | null> => {
      try {
        const held = [
          ...(await deps.hlHeld(evm)).map((s) => `hyperliquid ${s}`),
          ...(await deps.phoenixHeld(desk.solana.authority)).map((s) => `phoenix ${s}`),
        ];
        return held.length === 0 ? null : `no pair trader holds ${held.join(', ')} here: nothing closed ${held.length === 1 ? 'it' : 'them'}; close by hand (stop serve, then pair-mainnet close --send)`;
      } catch (err) {
        return `Hyperliquid and Phoenix cannot be read (${errorMessage(err)}), and no pair trader holds a leg there: check them, and close what is held by hand (stop serve, then pair-mainnet close --send)`;
      }
    };
    /** A start attempt after a failed one found nothing to protect: no pair from then on (the readers and lock are let go). */
    let noneWhy: string | null = null;
    /** Why the start is not confirmed (review S1): a read it needs failed. Null once two synced reads agreed. */
    let pending: string | null = null;
    let failures = 0;
    /** When the start was first not confirmed, and when the owner last heard of it (a journal entry). */
    let pendingSince: number | null = null;
    let pendingSaidAt: number | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempting: Promise<string | null> | null = null;
    /** A retry found a configuration error: the start is not tried again (serve must be restarted). */
    let refused = false;
    const lines: string[] = [];
    const journal = (kind: 'error' | 'wait', summary: string, numbers: Record<string, string | number>) => {
      const t = input.clock.now();
      input.publish({ type: 'journal', data: { id: `pair-start-${t.toString(36)}-${failures}`, t, kind, summary, numbers, tx: [] } });
    };
    // Orderly is a start venue only with GIMBAL_ORDERLY_PAIRS=1 and serve's Orderly session (an Orderly pair's reads).
    const healthKeys: readonly StartReadVenue[] = orderlyOn && input.orderly !== undefined ? ['hyperliquid', 'phoenix', 'near', 'orderly'] : ['hyperliquid', 'phoenix', 'near'];
    const healthOk = () => {
      for (const key of healthKeys) input.health?.(key, 'ok', null);
    };
    /** The start's result taken: a slot that does not trade lets the lock go (pair-mainnet must be able to fix it). */
    const land = (s: Started): string[] => {
      if (s.kind === 'none') {
        noneWhy = s.why;
        stopNone();
        return s.lines;
      }
      current = s.slot;
      if (current !== null && !current.live()) yieldLock();
      return s.lines;
    };
    const unconfirmed = (): string | null => (pending === null ? null : `legs unknown, start not confirmed: ${pending}`);
    const schedule = (ms: number) => {
      if (stopped) return;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void retryStart();
      }, ms);
      retryTimer.unref?.();
    };
    const sameKind = (a: string, b: string) => a.replace(/\d+(\.\d+)?/g, '#') === b.replace(/\d+(\.\d+)?/g, '#');
    /** A start attempt failed on a read: alert only, legs unknown, tried again with backoff; the owner hears of changes. */
    const failed = (err: unknown): void => {
      failures++;
      const why = errorMessage(err);
      const read = err instanceof StartReadError ? err : null;
      // The start's own word on each venue: the one that failed slow or down, the others ok (the risk engine's reads
      // and the scan add theirs).
      for (const key of healthKeys) {
        const bad = read !== null && read.venue === key && read.status !== null;
        input.health?.(key, bad ? read.status! : 'ok', bad ? why : null);
      }
      const was = pending;
      pending = why;
      pendingSince ??= input.clock.now();
      const wait = startBackoffMs(failures);
      log(`pair      start not confirmed (try ${failures}): ${why}; alert only, legs unknown, nothing adopted; trying again in ${wait / 1000} s`);
      if (was === null || !sameKind(was, why)) {
        // Orderly's session still in its first open (serve starting, venue.ts SESSION_STARTING) is a wait, not an
        // error; the same state reached any other way (an open that failed, a session that dropped) stays an error.
        const starting = read !== null && read.venue === 'orderly' && isSessionStarting(why);
        const tail = `Alert only until two synced reads of both legs agree: the legs are unknown, nothing is adopted and the strategy loop acts on nothing; the risk engine, the liquidation monitor and panic_close's journal run, and ADL is off until the legs are known. Tried again with backoff up to ${START_RETRY_MAX_MS / 1000} s`;
        journal(starting ? 'wait' : 'error', starting ? `pair start waits for the Orderly session, which is still opening: ${why}. ${tail}` : `pair start not confirmed: ${why}. ${tail}`, {
          stage: 'start', ...(read === null ? {} : { venue: read.venue }),
        });
        pendingSaidAt = input.clock.now();
      }
      schedule(wait);
    };
    /** One more start attempt while the start is not confirmed (the timer runs it; tests call it); the line when it ended. */
    const retryStart = (): Promise<string | null> => {
      if (pending === null || stopped || refused || noneWhy !== null) return Promise.resolve(null);
      if (attempting !== null) return attempting;
      const run = async (): Promise<string | null> => {
        try {
          const s = await attempt();
          if (stopped) {
            if (s.kind === 'pair') s.slot?.end();
            return null;
          }
          const tries = failures;
          pending = null;
          failures = 0;
          pendingSince = null;
          pendingSaidAt = null;
          if (retryTimer !== null) clearTimeout(retryTimer);
          retryTimer = null;
          healthOk();
          for (const l of land(s)) log(l);
          const now = s.kind === 'none' ? `nothing to protect: ${s.why}`
            : current === null ? 'no pair held; the strategy loop may open one'
            : current.live() ? `${current.symbol} trades` : `${current.symbol} alert only: ${current.pp.why ?? 'not live'}`;
          const line = `pair start confirmed after ${tries} failed attempt(s): both legs synced to their chains and read twice alike; ${now}`;
          log(`pair      ${line}`);
          journal('wait', line, { stage: 'start' });
          return line;
        } catch (err) {
          if (!(err instanceof ConfigError)) {
            failed(err);
            return null;
          }
          // A configuration error: no retry fixes it. Alert only for good; the lock goes so pair-mainnet can run.
          refused = true;
          pending = `${errorMessage(err)} (a configuration error: fix it and restart serve; not tried again)`;
          if (retryTimer !== null) clearTimeout(retryTimer);
          retryTimer = null;
          yieldLock();
          log(`pair      start refused: ${pending}`);
          journal('error', `pair start refused: ${pending}`, { stage: 'start' });
          return null;
        }
      };
      attempting = run().finally(() => {
        attempting = null;
      });
      return attempting;
    };

    if (orderlyOn && input.orderly === undefined) {
      const line = 'GIMBAL_ORDERLY_PAIRS=1, and serve has no Orderly session: no Orderly position is read, protected or closed here, panic_close included, and pair-mainnet cannot close one either';
      lines.push(`pair      ${line}`);
      journal('error', line, { stage: 'start', venue: 'orderly' });
    }

    // ---- the first start attempt: a read that fails degrades the pair instead of stopping serve (review S1) ----
    let first: Started | null = null;
    try {
      first = await attempt();
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      failed(err);
    }
    if (first !== null) {
      healthOk();
      if (first.kind === 'none') {
        stopNone();
        const said = [...lines, ...first.lines];
        if (sweep === null) return none(said, first.why);
        // No pair trader, but panic_close still closes the desk's Orderly positions (orderly-sweep.ts).
        const s = sweep;
        return {
          ...none(said, first.why, () => {
            stopped = true;
            s.stop();
            release();
          }),
          reducer: () => (stopped ? null : panicReducer(null, s, leftOutside)),
        };
      }
      lines.push(...land(first));
    } else {
      lines.push(`pair      start NOT confirmed: ${pending ?? 'unknown'}; alert only, legs unknown, nothing adopted: serve tries again with backoff (up to ${START_RETRY_MAX_MS / 1000} s) and goes live once two synced reads of both legs agree`);
    }
    const trading = () => !stopped && lock !== null && startHolds;

    // The strategy loop's operation in flight (one at a time).
    let operation: Promise<HandsResult> | null = null;

    const cancelResting = async (): Promise<CancelResult> => {
      if (stopped) throw new Error('serve is stopping and its trader lock is released: nothing is cancelled');
      const unsure = unconfirmed() ?? noneWhy;
      if (unsure !== null || relayer === null) throw new Error(`${unsure ?? 'no signing relayer'}: nothing is cancelled`);
      // The lock for the cancels (an alert-only slot let it go): pair-mainnet --send does not start under them.
      const why = borrowLock();
      if (why !== null) throw new Error(`${why}: nothing is cancelled`);
      try {
        return await cancelAll();
      } finally {
        returnLock();
      }
    };
    const cancelAll = async (): Promise<CancelResult> => {
      const coin = current?.symbol ?? null;
      const raw = await deps.openOrders(evm);
      if (!Array.isArray(raw)) throw new Error(restingOn(raw, coin ?? '') as string);
      const out: CancelResult = { cancelled: 0, tx: [], notes: [] };
      // The pair's coin first: its resting order is the one that can fill under the close. One at a time, in order:
      // each cancel is a contract call on the desk's nonce, so they do not go out in parallel.
      const orders = (raw as { coin?: unknown; side?: unknown; sz?: unknown; oid?: unknown }[])
        .map((o, i) => ({ o, i }))
        .sort((a, b) => Number(b.o.coin === coin) - Number(a.o.coin === coin) || a.i - b.i)
        .map(({ o }) => o);
      for (const o of orders) {
        if (stopped) {
          out.notes.push('serve is stopping: the cancels left were not sent');
          break;
        }
        const name = `${String(o.coin)} ${o.side === 'B' ? 'BUY' : 'SELL'} ${String(o.sz)} (oid ${String(o.oid)})`;
        const asset = policy.hl_assets.find((a) => a.symbol === o.coin);
        if (asset === undefined) {
          out.notes.push(`${name}: not a policy coin, not cancelled here`);
          continue;
        }
        if (typeof o.oid !== 'number') {
          out.notes.push(`${name}: the order id is not a number, so it cannot be cancelled by id here; cancel it on Hyperliquid`);
          continue;
        }
        try {
          const r = await relayer!.hlCancel(asset.index, o.oid, 'panic_close: cancel a resting order');
          out.tx.push(...r.tx);
          if (r.statuses[0] === 'success') out.cancelled++;
          else out.notes.push(`${name}: Hyperliquid answered ${JSON.stringify(r.statuses[0] ?? null)} (filled or ended already?)`);
        } catch (err) {
          out.notes.push(`${name}: the cancel failed (${errorMessage(err)})`);
        }
      }
      // The pair's other legs send IOCs only (Phoenix, Orderly): nothing rests there.
      const ioc = current !== null ? current.shape.legs.map((l) => l.venue).filter((v) => v !== 'hyperliquid') : ['phoenix' as const, ...(orderlyOn ? ['orderly' as const] : [])];
      for (const v of ioc) out.notes.push(`${venueName(v)}: the leg sends IOCs only, nothing rests there`);
      return out;
    };

    // ---- the strategy loop's hands ----
    const heldSymbol = (): string | null => {
      const s = current;
      if (s === null) return null;
      const base = s.trader.legs.map((l) => s.trader.baseline(l));
      return base.every((b) => b === 0n) ? null : s.symbol;
    };
    const blockedWhy = (busyCounts: boolean): string | null => {
      if (stopped) return 'serve is stopping: nothing is signed';
      const unsure = unconfirmed();
      if (unsure !== null) return unsure;
      if (noneWhy !== null) return `no pair trader: ${noneWhy}`;
      if (!trading()) return current === null ? 'no pair trader' : `alert only: ${current.pp.why ?? 'not live'}`;
      if (busyCounts && operation !== null) return 'an open or close of the strategy loop is running';
      if (current !== null) {
        if (!current.live()) return `alert only: ${current.pp.why ?? 'not live'}`;
        // The trader is busy during the loop's own open or close too: that is the operation's term, not a protection.
        if (current.pp.closing && (busyCounts || operation === null)) return `a close runs on ${current.symbol} (panic_close, a rescue's reduce or an ADL unwind)`;
        if (current.adl.state.event !== null) return `an ADL event on ${current.symbol} is in progress`;
      }
      return null;
    };
    const blocked = (): string | null => blockedWhy(true);
    // A rotate closes the held pair before it opens the next: closing an Orderly leg arms its 300 s replay watch, and
    // no other pair opens while it runs (quiet), so the rotate would leave the desk flat. Refused before anything is
    // closed (prepareOpen; the loop asks first, before its risk check): the pair is kept and exits on its own rules.
    const rotateOutRefused = (): string | null => {
      const replayable = orderlyOn && current !== null && heldSymbol() !== null ? current.trader.legs.find((l) => l.replayable) : undefined;
      if (replayable === undefined) return null;
      return `the held ${current!.symbol} pair has an Orderly leg (${replayable.symbol}): its close arms the trader's replay watch (Orderly takes a signed copy of an order for up to 300 s), so no other pair could open after it and the rotate would leave the desk flat`;
    };
    const result = (ok: boolean, reason: string, extra: Partial<HandsResult> = {}): HandsResult => ({
      ok, reason, results: [], lines: [], open: [], tx: [], feeUsd: 0, ...extra,
    });
    const collect = () => {
      const lines: string[] = [];
      const opens: string[] = [];
      const out: CarryOut = {
        say: (l) => {
          lines.push(l);
          log(`pair      ${l}`);
        },
        open: (l) => {
          opens.push(l);
          log(`pair      open: ${l}`);
        },
      };
      return { lines, opens, out };
    };
    const summarise = (r: PairResult[]) => ({
      tx: r.flatMap((x) => x.tx),
      feeUsd: r.reduce((acc, x) => acc + x.feeUsd, 0),
    });
    const exclusive = (run: () => Promise<HandsResult>): Promise<HandsResult> => {
      const why = blocked();
      if (why !== null) return Promise.resolve(result(false, why));
      // A throw after orders went out is not "nothing signed": the trader's record moved, or the pair holds a position.
      // An order the trader signed whose result was never recorded moves the book's count, not the epoch (review S4).
      const slot = current;
      const trader = slot?.trader ?? null;
      const epoch = trader?.baselineEpoch ?? null;
      const signed = slot?.signedOrders() ?? 0;
      const heldBefore = heldSymbol();
      const op = run().catch((err: unknown) => {
        const moved = (trader !== null && trader.baselineEpoch !== epoch) || current !== slot || (slot !== null && slot.signedOrders() !== signed)
          || heldSymbol() !== heldBefore;
        return result(false, `${moved ? 'stopped with orders out' : 'not done'}: ${errorMessage(err)}`, moved ? { sent: true } : {});
      }).finally(() => {
        operation = null;
      });
      operation = op;
      return op;
    };
    const hands: PairHands = {
      symbols: common,
      ...(orderlyOn ? {
        pairSymbols: (long: VenueId, short: VenueId) => (input.orderly === undefined && (long === 'orderly' || short === 'orderly') ? [] : pairSymbols(policy, long, short)),
        heldPair: () => (current === null ? null : { long: longLeg(current.shape).venue, short: shortLeg(current.shape).venue }),
        rotateOutRefused,
      } : {}),
      blocked,
      canOpen: () => blockedWhy(false) === null,
      heldSymbol,
      heldLegs: () => {
        const s = current;
        return s === null ? [] : s.trader.legs.map((l) => {
          const b = s.trader.baseline(l);
          return { venue: l.venue, qty: b === undefined ? 0n : b };
        });
      },
      prepareOpen: (request) => {
        let paid = false;
        return exclusive(async () => {
          const sym = request.symbol;
          const out = rotateOutRefused();
          if (out !== null) return result(false, out);
          // The pair symbol is every leg's policy symbol (Hyperliquid's and Phoenix's name, Orderly's base).
          if (unpricedBySymbol(policy, sym) !== undefined) return result(true, `${sym} is unpriced: no stored price to refresh`);
          const marginS = SERVE_MAKER.timeoutMs / 1000 + PRICE_MARGIN_S;
          const sp = await prices.read(sym);
          if (sp !== null && sp.ageS <= prices.maxAgeS - marginS) return result(true, `the stored ${sym} price is ${Math.round(sp.ageS)} s old: it lives the open's ${marginS} s`);
          const was = sp === null ? 'missing' : `${Math.round(sp.ageS)} s old`;
          if (!oraclePriced(sym)) return result(false, `the stored ${sym} price is ${was} and refresh_prices cannot refresh it (${sym} is not one of the contract's oracle assets)`);
          if (request.noRefresh !== undefined) return result(false, `the stored ${sym} price is ${was} and needs refresh_prices: ${request.noRefresh}`);
          try {
            const fresh = await ensureFresh(counting(prices, () => {
              paid = true;
            }), sym, marginS);
            return result(true, `the stored ${sym} price (${was}) refreshed before the close: ${fresh.px}, ${Math.round(fresh.ageS)} s old`);
          } catch (err) {
            return result(false, `the stored ${sym} price (${was}) could not be refreshed: ${errorMessage(err)}`);
          }
        }).then((r) => (paid ? { ...r, refreshed: true } : r));
      },
      open: (request) => {
        let paid = 0;
        return exclusive(async () => {
          const sym = request.symbol;
          let shape: PairShape;
          try {
            shape = pairShape(sym, request.long ?? 'phoenix', request.short ?? 'hyperliquid');
          } catch (err) {
            return result(false, errorMessage(err));
          }
          if (isDefaultShape(shape, sym)) {
            if (!common.includes(sym)) return result(false, `${sym} is not in both policy.hl_assets and policy.phoenix_markets (${common.join(', ') || 'none'})`);
          } else {
            const refusedShape = shapeRefusal(policy, sym, shape, orderlyOn);
            if (refusedShape !== null) return result(false, refusedShape);
            if (shape.legs.some((l) => l.venue === 'orderly') && input.orderly === undefined) {
              return result(false, `${shapeText(shape)}: an Orderly pair needs serve's Orderly session (the desk's private stream and signing client), and serve has none: nothing built or sent`);
            }
          }
          const holding = heldSymbol();
          if (holding !== null) return result(false, `a ${holding} pair is held: it is closed first (exit or rotate)`);
          if (current !== null && current.adl.state.paused !== null) return result(false, `the pair is paused since an ADL (${current.adl.state.paused}): no new pair opens until the owner reconciles`);
          const off = current?.quiet(current.symbol !== sym || !sameShape(current.shape, shape)) ?? null;
          if (off !== null) return result(false, `the ${current!.symbol} pair is not settled: ${off}`);
          let slot = current;
          if (slot === null || slot.symbol !== sym || !sameShape(slot.shape, shape)) {
            const old = slot;
            old?.suspend(true);
            let next: Slot;
            try {
              next = await makeSlot(sym, shape);
            } catch (err) {
              old?.suspend(false);
              return result(false, `the ${sym} pair could not be built: ${errorMessage(err)}`);
            }
            if (!next.live() || stopped) {
              next.end();
              old?.suspend(false);
              return result(false, `the ${sym} pair would not trade: ${next.why.join('; ') || 'serve is stopping'}`, { lines: next.lines });
            }
            old?.end();
            for (const line of next.lines) log(line);
            current = next;
            slot = next;
          }
          if (!slot.live()) return result(false, `alert only: ${slot.pp.why ?? 'not live'}`);
          // The loop opens: the desk is not closing, and no panic_close sweep may watch this pair's Orderly leg.
          sweep?.endWatch();
          const { lines: said, opens, out } = collect();
          const r = await slot.carry.open({
            legUsd: request.legUsd, leverage: request.leverage, reason: request.reason,
            ...(request.qty === undefined ? {} : { qty: request.qty }), ...(request.gate === undefined ? {} : { gate: request.gate }),
            ...(request.noRefresh === undefined ? {} : { noRefresh: request.noRefresh }), ...(request.demo === undefined ? {} : { demo: request.demo }),
            onPaidRefresh: () => {
              paid++;
            },
          }, out);
          if (r.refusals.length > 0) {
            return result(false, `open refused, nothing signed: ${r.refusals.join('; ')}`, { lines: said, open: opens, ...(r.costRefused === undefined ? {} : { costRefused: r.costRefused }) });
          }
          const again = await slot.readopt().catch((err: unknown) => `not adopted after the residual hedge: ${errorMessage(err)}`);
          if (again !== null) log(`pair      ${again}`);
          const opened = r.results.filter((x) => x.status === 'open');
          const last = r.results.at(-1);
          const ok = opened.length > 0 && heldSymbol() !== null;
          // The taker fallback (an owner demo entry's open) says what it did on an open too; a failed open's notes say it.
          const fallback = r.results.flatMap((x) => x.notes.filter((n) => n.startsWith('taker fallback')));
          const reason = ok
            ? `${sym} opened: ${opened.map((x) => x.size).join(' + ')} a leg${last !== undefined && last.status !== 'open' ? ` (the last part ended ${last.status})` : ''}${fallback.length > 0 ? `; ${fallback.join('; ')}` : ''}`
            : `${sym} not opened: ${last === undefined ? 'no part was sent' : `${last.status}${last.notes.length > 0 ? ` (${last.notes.join('; ')})` : ''}`}`;
          // Orders went out when a part sent any (a part the gate stopped before its first order sent none).
          const sent = r.results.some((x) => x.legs.some((l) => l.orders.length > 0)) || heldSymbol() !== null;
          return result(ok, reason, { results: r.results, lines: said, open: opens, sent, ...summarise(r.results) });
        }).then((r) => (paid > 0 ? { ...r, refreshed: true, refreshes: paid } : r));
      },
      reconcile: async () => {
        const slot = current;
        if (slot === null || blocked() !== null) return null;
        // One at a time with the loop's open and close: nothing of the loop is sent while the legs are read.
        let line: string | null = null;
        const op = slot.reconcile().then((l) => {
          line = l;
          return result(true, l ?? 'the record and the venues agree');
        }).catch((err: unknown) => result(false, `not reconciled: ${errorMessage(err)}`)).finally(() => {
          operation = null;
        });
        operation = op;
        const r = await op;
        if (!r.ok) log(`pair      ${r.reason}`);
        if (line !== null) log(`pair      ${line}`);
        return line;
      },
      close: (request) => exclusive(async () => {
        const slot = current;
        if (slot === null || heldSymbol() === null) return result(false, 'no pair is held: nothing to close');
        if (!slot.live()) return result(false, `alert only: ${slot.pp.why ?? 'not live'}`);
        const { lines: said, opens, out } = collect();
        const r = await slot.carry.close({ reason: request.reason }, out);
        if (r.refusals.length > 0) return result(false, `close refused, nothing signed: ${r.refusals.join('; ')}`, { lines: said, open: opens });
        const again = await slot.readopt().catch((err: unknown) => `not adopted after the residual hedge: ${errorMessage(err)}`);
        if (again !== null) log(`pair      ${again}`);
        const last = r.results.at(-1);
        const ok = last?.status === 'closed' && heldSymbol() === null;
        const reason = ok ? `${slot.symbol} closed` : `${slot.symbol} not closed: ${last === undefined ? 'nothing sent' : `${last.status}${last.notes.length > 0 ? ` (${last.notes.join('; ')})` : ''}`}`;
        return result(ok, reason, { results: r.results, lines: said, open: opens, ...summarise(r.results) });
      }),
    };

    const adl: PairAdl = {
      // No check while the loop's own open or close runs: the legs move by our orders then (the trader may be idle
      // between parts and in finish()).
      check: async () => (operation !== null || current === null ? null : current.adl.check()),
      stop: () => current?.adl.stop(),
      get state() {
        return current?.adl.state ?? newAdlState();
      },
      get unwinding() {
        return current?.adl.unwinding ?? false;
      },
      get confirming() {
        return current?.adl.confirming ?? false;
      },
    };
    // A start not confirmed yet keeps the hands (they refuse until it is) and the ADL watch: it may go live later, the
    // trader lock included when another process held it at start.
    const started = current as Slot | null;       // set by land(), which TypeScript does not follow
    const live = wantLive && !stopped && (pending !== null || (lock !== null && (started === null || started.live())));
    return {
      get pair() {
        return current?.pp ?? null;
      },
      adl: current !== null || live || pending !== null ? adl : undefined,
      lines,
      reducer: () => {
        const pair = current !== null && current.live() && !stopped ? current.pp : null;
        return sweep === null || stopped ? pair : panicReducer(pair, sweep, leftOutside);
      },
      notTrading: () => {
        if (stopped) return 'serve is stopping: nothing is signed';
        const unsure = unconfirmed();
        if (unsure !== null) return unsure;
        if (noneWhy !== null) return noneWhy;
        if (current === null) return 'no pair is open';
        return current.live() ? null : `alert only: ${current.pp.why ?? 'not live'}`;
      },
      ...(live ? { cancelResting, hands } : {}),
      drain: async (timeoutMs) => {
        const until = Date.now() + timeoutMs;
        if (operation !== null) {
          const done = await Promise.race([operation.then(() => true), sleep(timeoutMs).then(() => false)]);
          if (!done) return false;
        }
        return current === null ? true : current.pp.whenIdle(Math.max(0, until - Date.now()));
      },
      settleInFlight: () => current?.settle() ?? Promise.resolve(null),
      unconfirmed,
      retryStart,
      monitor: () => {
        if (pending === null || stopped) return null;
        const now = input.clock.now();
        const since = pendingSince ?? now;
        const line = `pair unprotected: legs unknown since ${new Date(since).toISOString()}, ${failures} ${failures === 1 ? 'try' : 'tries'} (${pending}); `
          + 'no trader, ADL watch or rescue reduce acts on a pair that may be open: check both legs on the venues';
        if (pendingSaidAt === null || now - pendingSaidAt >= UNPROTECTED_REMIND_MS) {
          pendingSaidAt = now;
          journal('error', line, { stage: 'start', tries: failures });
        }
        return line;
      },
      stop: () => {
        // First: nothing is signed from here on (a rescue between its read and its reduce must not sign after the
        // lock is released), and nothing is saved.
        stopped = true;
        sweep?.stop();
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = null;
        current?.end();
        deps.close();
        release();
      },
    };
  } catch (err) {
    stopNone();
    throw err;
  }
}

/**
 * The line serve logs when the builder fee an open reads from config() is not the one the scanner has priced since the
 * start (serve.ts withBuilderFee, ContractSide.builderTenthBps): the open and the scanner's gate then price Hyperliquid
 * differently until serve restarts. null when they agree, or when the open's own fee is not usable (planOpen refuses
 * that open and says why).
 */
export function builderFeeDrift(atStart: number | null, now: number | null | undefined): string | null {
  if (hlFillFeeBps(now) === null || now === atStart) return null;
  const scanner = hlFillFeeBps(atStart);
  return `pair      the contract's builder fee is ${now} tenths of a bp now (config()), but the scanner has priced `
    + `${atStart === null || scanner === null ? `its default since the start (it read ${String(atStart)})` : `${atStart} since the start`}: `
    + `the open prices Hyperliquid at ${hlFillFeeBps(now)} bps a fill, the scanner's gate at ${scanner ?? 'its default'}, until serve restarts`;
}

/** The builder fee last logged as drifted, per contract side: each new value is logged once. */
const builderFeeLogged = new WeakMap<ContractSide, number>();

/** The readers liveCarry plans with; `orderly` the public Orderly reader (gimbal_dex's markets), for an Orderly pair. */
export interface CarryReaders {
  hl: HyperliquidReader;
  phoenix: PhoenixReader;
  solana: SolanaSubmitter;
  orderly?: OrderlyReader;
}

/** pair-mainnet's open and close (pair-ops.ts) on a live pair's legs, sending through its ProtectedPair (exported for tests). */
export function liveCarry(p: CarryInput & { input: ServePairInput; hlUrl: string; phoenixUrl: string; solRpcUrl: string; readers: () => CarryReaders }): SlotCarry {
  let full: FullLegs;
  try {
    full = fullLegs(p.symbol, p.legs);
  } catch (err) {
    const no = async (): Promise<CarryResult> => ({ refusals: [errorMessage(err)], results: [] });
    return { open: no, close: no };
  }
  const { hl, phoenix } = full;
  if ((hl !== null && !(hl instanceof HlLeg)) || (phoenix !== null && !(phoenix instanceof PhoenixLeg))) {
    const no = async (): Promise<CarryResult> => ({ refusals: ['these legs are not the live Hyperliquid and Phoenix legs'], results: [] });
    return { open: no, close: no };
  }
  // The residual hedge goes on the IOC leg: Hyperliquid's partner (index 1 for short Hyperliquid / long Phoenix).
  const iocIndex: 0 | 1 = makerIndexOf(full.shape) === 1 ? 0 : 1;
  const orderlyOps = (r: CarryReaders): OrderlyOps | null => {
    const ol = p.input.orderly;
    if (ol === undefined || r.orderly === undefined || !full.shape.legs.some((l) => l.venue === 'orderly')) return null;
    return {
      reader: r.orderly, account: () => ol.account(), leg: (spec) => ol.leg(spec),
      // get_desk_settings, read fresh before each open: the owner may have applied the IP list since the last one.
      ipsApplied: async () => (await p.client.deskSettings(p.input.deskId))?.orderly_ips_applied === true,
    };
  };
  const ctxFor = async (out: CarryOut): Promise<OpsCtx> => {
    // A fresh desk each time: paused and closing (panic_close) are refusals, and the policy may have changed.
    const [config, desk] = await Promise.all([p.client.config(), p.client.getDesk(p.input.deskId)]);
    if (desk === null) throw new Error(`get_desk(${p.input.deskId}) answered null`);
    const side = p.input.side as ContractSide | undefined;
    const now = config.fees?.hl_builder_tenth_bps;
    const drift = side === undefined ? null : builderFeeDrift(side.builderTenthBps ?? null, now);
    if (side !== undefined && drift !== null && builderFeeLogged.get(side) !== now) {
      builderFeeLogged.set(side, now!);
      p.input.log(drift);
    }
    const r = p.readers();
    return {
      client: p.client, config, desk, hlUrl: p.hlUrl, hl: r.hl, phoenix: r.phoenix, phoenixUrl: p.phoenixUrl, chain: solanaChain(p.solRpcUrl),
      solana: r.solana, sol: { authority: desk.solana.authority, traderAccount: desk.solana.phoenix_trader, usdcAta: desk.solana.usdc_ata, phusdAta: desk.solana.phusd_ata },
      relayer: p.relayer, orderly: orderlyOps(r), prices: p.prices, send: true, trading: false, say: (line = '') => out.say(line), open: (line) => out.open(line),
    };
  };
  const runner = (opening: boolean): PairRunner => ({
    openInChunks: (request) => p.pair.openInChunks(request),
    close: (request) => p.pair.close(request),
    hedge: (side, size, reduceOnly, reason, targetNet) => p.pair.hedge(iocIndex, side, size, reduceOnly, reason, opening, targetNet),
    stopOnFinish: false,
  });
  // `demo`: an owner demo entry's open, the only one with a taker fallback.
  const pairFor = (ctx: OpsCtx, opening: boolean, demo = false) => pairOf(ctx, {
    symbol: p.symbol, shape: full.shape, legs: full.legs, trader: p.trader, run: runner(opening), maker: SERVE_MAKER, microLamports: ORDER_PRIORITY_MICROLAMPORTS, priced: p.legs.priced, closing: !opening,
    ...(demo && opening ? { takerFallback: SERVE_DEMO_TAKER_FALLBACK } : {}),
  });
  return {
    open: async (request, out) => {
      const ctx = await ctxFor(out);
      const pair = await pairFor(ctx, true, request.demo !== undefined);
      p.planning(true);
      let plan: Awaited<ReturnType<typeof planOpen>>;
      try {
        plan = await planOpen(ctx, pair, {
          symbol: p.symbol, legUsd: request.legUsd, leverage: request.leverage, holdDays: SERVE_HOLD_DAYS, basisBps: SERVE_BASIS_BPS,
          ...(request.qty === undefined ? {} : { qty: request.qty }),
          ...(request.demo === undefined ? {} : { demo: { maxLossUsd: request.demo.maxLossUsd, takerFallbackBps: DEMO_FALLBACK_COST_BPS } }),
        });
      } finally {
        p.planning(false);
      }
      if (plan.carry.waived !== null) out.say(`demo      owner demo entry: waived, the ${plan.carry.waived}`);
      if (request.demo !== undefined) {
        const rt = plan.carry.roundTripUsd;
        out.say(`demo      owner demo entry: taker fallback after the ${SERVE_MAKER.timeoutMs / 1000} s maker window, within ${SERVE_SLIPPAGE_BPS} bps of the touch and ${SERVE_DEMO_TAKER_FALLBACK.markBps} bps of the mark; `
          + `round trip ${Number.isFinite(rt) ? `$${rt.toFixed(4)}` : 'not priced'} (every fill at the taker fee) + $${plan.carry.takerFallbackUsd.toFixed(4)} for the fallback's slippage, at most $${request.demo.maxLossUsd.toFixed(4)} accepted`);
      }
      // Every refusal that needs no fresh price first: the plan's (the closing desk among them), a maker timeout the
      // price cannot outlive (buildPair's), the gate, and the loop's daily cap on refreshes. Only then refresh_prices.
      const refusals = [...plan.refusals];
      const fit = p.legs.priced ? priceFitRefusal(SERVE_MAKER.timeoutMs / 1000, ctx.desk.policy.oracle_max_age_s) : null;
      if (fit !== null) refusals.push(fit);
      const early = request.gate?.() ?? null;
      if (early !== null) refusals.push(`${early}: nothing sent`);
      if (plan.refresh !== null && request.noRefresh !== undefined) {
        refusals.push(`the stored ${p.symbol} price is ${plan.refresh.was} and needs refresh_prices: ${request.noRefresh}; nothing sent`);
      }
      const cost = plan.carry.costRefusal === null ? {} : { costRefused: plan.carry.costRefusal };
      if (refusals.length > 0) return { refusals, results: [], ...cost };
      const fresh = await refreshForOpen(ctx, pair, { ...plan, refusals }, { planning: (on) => p.planning(on) });
      if (fresh.paid) request.onPaidRefresh?.();
      if (fresh.line !== null) out.say(fresh.line);
      if (fresh.refused !== null) return { refusals: [fresh.refused], results: [], refreshed: fresh.paid };
      plan = fresh.plan;
      // The exact size decide() took is a maximum: held to the cap at the prices of the moment, before either leg.
      if (request.qty !== undefined) {
        const held = await recheckOpenSize(ctx, pair, plan.size, SERVE_SLIPPAGE_BPS, request.onPaidRefresh);
        if ('refused' in held) return { refusals: [held.refused], results: [], refreshed: fresh.paid };
        out.say(held.line);
        plan = { ...plan, size: held.qty };
      }
      // Review F2: the reads and plans above take seconds after the loop's gate; a rescue that started meanwhile
      // refuses the open here, before the first order, and stops it before each later part (sendOpen's beforePart).
      const gated = request.gate?.() ?? null;
      if (gated !== null) return { refusals: [`${gated}: nothing sent`], results: [], refreshed: fresh.paid };
      const options = { ...(request.gate === undefined ? {} : { gate: request.gate }), ...(request.onPaidRefresh === undefined ? {} : { onRefresh: request.onPaidRefresh }) };
      return { refusals: [], results: await sendOpen(ctx, pair, plan, request.reason, options), refreshed: fresh.paid };
    },
    close: async (request, out) => {
      const ctx = await ctxFor(out);
      const pair = await pairFor(ctx, false);
      const { refusals } = await planClose(ctx, pair);
      if (refusals.length > 0) return { refusals, results: [] };
      return { refusals: [], results: [await sendClose(ctx, pair, { reason: request.reason, reduceOnly: true, clampTargets: true })] };
    },
  };
}

/** The mainnet readers, the contract's signing side and buildLiveLegs. */
function defaultDeps(p: { input: ServePairInput; hlUrl: string; phoenixUrl: string; solRpcUrl: string }): ServePairDeps {
  const { input, hlUrl, phoenixUrl, solRpcUrl } = p;
  const desk = input.side.desk;
  // Made on first use: a test that passes every dependency opens nothing.
  let made: CarryReaders | null = null;
  // Orderly's public reader only with GIMBAL_ORDERLY_PAIRS=1 and serve's Orderly session: otherwise nothing reads Orderly.
  const orderlyReads = orderlyPairsOn(input.env) && input.orderly !== undefined;
  const r = () => (made ??= {
    hl: new HyperliquidReader({ network: 'mainnet', url: `${hlUrl}/info` }),
    phoenix: new PhoenixReader({ apiUrl: phoenixUrl, rpcUrl: solRpcUrl }),
    solana: new SolanaSubmitter({ rpcUrl: solRpcUrl, network: 'mainnet' }),
    ...(orderlyReads ? { orderly: new OrderlyReader({ network: 'mainnet', brokerId: ORDERLY_BROKERS.mainnet.brokerId }) } : {}),
  });
  return {
    hlHeld: async (evm) => (await r().hl.account(evm)).positions.filter((x) => x.size !== 0).map((x) => x.symbol),
    phoenixHeld: async (authority) => phoenixHeld(await phoenixTraderApi(phoenixUrl).traderState(authority)),
    openOrders: (evm) => hlInfo(hlUrl, { type: 'openOrders', user: evm }),
    signing: async () => {
      const cfg = contractEnv(input.env, input.mode, { signing: true });
      if (cfg === null) throw new ConfigError('GIMBAL_TRADE=1 needs GIMBAL_CONTRACT_ID, DESK_ID and the operator key');
      const transport = (): NearTransport => new NearApiTransport({ network: cfg.network, accountId: cfg.accountId!, privateKey: cfg.privateKey!, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }) });
      const client = input.operator !== undefined ? await input.operator()
        : new NearContractClient({ contractId: cfg.contractId, network: cfg.network, transport: transport(), onHealth: (s, d) => input.log(`pair near ${s}: ${d}`) });
      checkContractNetwork(cfg.contractId, await client.config(), cfg.network);
      return { client, relayer: new Relayer({ contract: client, deskId: input.deskId, hyperliquid: new HyperliquidSubmitter({ network: 'mainnet', apiUrl: hlUrl }), solana: r().solana }) };
    },
    buildLegs: ({ symbol, shape, client, relayer, prices, trading }) => buildLiveShapeLegs({
      client, desk, symbol, hlUrl, hl: r().hl, phoenix: r().phoenix, phoenixUrl, chain: solanaChain(solRpcUrl), solana: r().solana, relayer,
      prices, trading, maker: SERVE_MAKER, slippageBps: SERVE_SLIPPAGE_BPS, microLamports: ORDER_PRIORITY_MICROLAMPORTS,
    }, shape, input.orderly ?? null),
    carry: (c) => liveCarry({ ...c, input, hlUrl, phoenixUrl, solRpcUrl, readers: r }),
    close: () => {
      made?.phoenix.close();
      made?.orderly?.close();
    },
  };
}

async function hlInfo(hlUrl: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${hlUrl}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`hyperliquid /info ${String(body.type)}: HTTP ${res.status}`);
  return res.json();
}

/** The symbols the desk's Phoenix trader holds (every subaccount); none when it is not registered. */
function phoenixHeld(raw: unknown): string[] {
  const r = raw as { snapshot?: { subaccounts?: { positions?: { symbol?: unknown; basePositionLots?: unknown }[] }[] } } | null;
  const out = new Set<string>();
  for (const sub of r?.snapshot?.subaccounts ?? []) {
    for (const p of sub.positions ?? []) {
      if (typeof p.symbol === 'string' && typeof p.basePositionLots === 'string' && /^-?\d+$/.test(p.basePositionLots) && BigInt(p.basePositionLots) !== 0n) out.add(p.symbol);
    }
  }
  return [...out];
}

/** What both legs hold, in words: both flat, one leg open, both open; null when either is unknown. */
export function legsShape(a: bigint | null | undefined, b: bigint | null | undefined): 'flat' | 'one leg' | 'pair' | null {
  const x = a === undefined ? 0n : a;
  const y = b === undefined ? 0n : b;
  if (x === null || y === null) return null;
  const open = Number(x !== 0n) + Number(y !== 0n);
  return open === 0 ? 'flat' : open === 1 ? 'one leg' : 'pair';
}

/**
 * Review F1. The record (the baselines: what the last open, close or adoption left each leg meaning to hold) can say
 * "pair" while the venues hold one leg (an IOC with no answer lapses as never run, then the unwind of its partner
 * fails), or while both are flat. heldSymbol and heldLegs read the record, so such a pair would be held and never
 * closed, or every exit refused "nothing to close". When no order of ours can still move a leg, the trader's last live
 * reads (`known`) decide: when they say one leg or flat and the record does not, two venue reads a few seconds apart
 * must agree with each other and with that shape, and are then adopted as the record (the unhedged alert stays set
 * when they do not offset). Anything else (an order that may run, reads that differ, the venues holding a pair after
 * all, an order of ours meanwhile) changes nothing. Before the first read each leg is synced to its chain
 * (TradeLeg.syncToChain): after a restart a lagging Phoenix snapshot from before our last transaction would otherwise
 * read as current (Phoenix 0 while it holds the long), and the adopted single leg would be the wrong one. A sync or a
 * read that fails leaves the record as it is (thrown; the loop logs it).
 */
export async function reconcileWithVenues(p: {
  trader: PairTrader; symbol: string; sleep: (ms: number) => Promise<void>; confirmMs: number;
  /** Why the legs may move by an order of ours now (nothing is reconciled then), or null. */
  idle: () => string | null;
  /** The in-flight book's count of orders added: one sent while the legs were read voids the reads. */
  signed: () => number;
  adopt: (read: [bigint, bigint]) => void;
}): Promise<string | null> {
  const { trader } = p;
  if (p.idle() !== null || trader.busy) return null;
  const [a, b] = trader.legs;
  const record = legsShape(trader.baseline(a), trader.baseline(b));
  const live = legsShape(trader.known(a), trader.known(b));
  if (live === null || live === record || live === 'pair') return null;
  const epoch = trader.baselineEpoch;
  const signed = p.signed();
  await syncToChain(trader.legs);
  const first = await Promise.all(trader.legs.map((l) => l.position()));
  await p.sleep(p.confirmMs);
  const second = await Promise.all(trader.legs.map((l) => l.position()));
  if (first[0] !== second[0] || first[1] !== second[1]) return null;
  const read: [bigint, bigint] = [second[0]!, second[1]!];
  if (legsShape(read[0], read[1]) !== live) return null;
  // An order of ours, a result or an adopt meanwhile: the reads may hold it.
  if (p.idle() !== null || trader.busy || trader.baselineEpoch !== epoch || p.signed() !== signed) return null;
  const text = (q: readonly (bigint | null | undefined)[]) => q.map((x) => (x === null || x === undefined ? 'unknown' : signedQtyString(x))).join(' and ');
  const was = text([trader.baseline(a), trader.baseline(b)]);
  p.adopt(read);
  return `${p.symbol} record reconciled with the venues: it said ${record ?? 'unknown'} (${was}), two reads agree on ${live} (${text(read)}) and are adopted${live === 'one leg' ? '; the single leg is closed reduce-only next' : ''}`;
}

/** Each leg's oldest trusted snapshot raised to its chain's confirmed slot now (TradeLeg.syncToChain); throws. */
async function syncToChain(legs: readonly TradeLeg[]): Promise<void> {
  await Promise.all(legs.map((l) => l.syncToChain?.()));
}

/**
 * Both legs read twice START_CONFIRM_MS apart until two reads agree (START_READ_TRIES at most); throws otherwise.
 * Each try first syncs the legs to their chains: the start plan (and the settles after it) must not adopt a lagging
 * snapshot from before the last transaction of the run that stopped. The error says which venue failed and how (a
 * StartReadError): the chain's slot not read is down, a snapshot that stays behind it slow, any other read down.
 */
async function readTwice(legs: [TradeLeg, TradeLeg], sleep: (ms: number) => Promise<void>, log: (line: string) => void): Promise<[bigint, bigint]> {
  let last: StartReadError | null = null;
  const venueOf = (l: TradeLeg): StartReadVenue => (l.venue === 'phoenix' ? 'phoenix' : l.venue === 'orderly' ? 'orderly' : 'hyperliquid');
  const read = () => Promise.all(legs.map((l) => l.position().catch((err: unknown) => {
    const text = errorMessage(err);
    throw new StartReadError(venueOf(l), /still before slot/.test(text) ? 'slow' : 'down', text);
  })));
  for (let i = 0; i < START_READ_TRIES; i++) {
    try {
      await Promise.all(legs.map((l) => (l.syncToChain?.() ?? Promise.resolve()).catch((err: unknown) => {
        throw new StartReadError(venueOf(l), 'down', `${l.venue} ${l.symbol}: the chain's confirmed slot was not read (${errorMessage(err)}), so no snapshot can be proven current`);
      })));
      const a = await read();
      await sleep(START_CONFIRM_MS);
      const b = await read();
      if (a[0] === b[0] && a[1] === b[1]) return [a[0]!, a[1]!];
      last = new StartReadError(venueOf(legs[a[0] === b[0] ? 1 : 0]), null, `two reads differ: ${a.map(String).join(',')} then ${b.map(String).join(',')}`);
    } catch (err) {
      last = err instanceof StartReadError ? err : new StartReadError('phoenix', 'down', errorMessage(err));
    }
    log(`pair      the legs could not be read twice alike at start (${last.message}); trying again`);
    await sleep(START_CONFIRM_MS);
  }
  throw new StartReadError(last!.venue, last!.status, `the legs could not be read twice alike (${last!.message}); nothing is adopted`);
}

/** The contract's stored price of `symbol` and its age (s), or null. */
async function storedPrice(client: NearContractClient, symbol: string): Promise<StoredPrice | null> {
  const row = (await client.prices()).find((p) => p.asset === symbol);
  return row === undefined ? null : { px: Number(row.price_e8) / 1e8, ageS: (Date.now() - row.at_ms) / 1000 };
}

export interface LiveLegsInput {
  client: NearContractClient;
  desk: DeskView;
  symbol: string;
  hlUrl: string;
  hl: Pick<HyperliquidReader, 'book'>;
  phoenix: Pick<PhoenixReader, 'book'>;
  phoenixUrl: string;
  chain: SolanaChain;
  solana: SolanaSubmitter;
  /** The signing relayer; null: a relayer that refuses everything (nothing is signed). */
  relayer: Relayer | null;
  prices: PriceDeps;
  /** Once true, an order finding the stored price about to go stale refreshes it first (oraclePxOf). */
  trading: () => boolean;
  maker: MakerSettings;
  slippageBps: number;
  microLamports: number;
  /** Phoenix API requests (tests); default the global fetch, through the host's shared budget. */
  phoenixFetch?: typeof fetch;
  /** Default the budget every Phoenix reader of this API host in the process shares. */
  phoenixBudget?: HostBudget | null;
}

export interface LiveLegs {
  hl: HlLeg;
  phoenix: PhoenixLeg;
  /** A leg is priced (not in policy.unpriced by its venue's policy symbol): the stored price must be fresh. */
  priced: boolean;
  /** The Phoenix exchange and the policy market against the pinned accounts (status ignored: closes are reduce-only). */
  mismatches: string[];
}

/** The two legs of short Hyperliquid / long Phoenix as pair-mainnet builds them (buildPair), for `symbol`. */
export async function buildLiveLegs(input: LiveLegsInput): Promise<LiveLegs> {
  const built = await buildLiveShapeLegs(input, defaultShape(input.symbol), null);
  return { hl: built.hl!, phoenix: built.phoenix!, priced: built.priced, mismatches: built.mismatches };
}

/** The legs of any pair, in the trader's order: LiveLegs' legs where they are legs, and Orderly's. */
export interface LiveShapeLegs extends BuiltLegs {
  shape: PairShape;
  legs: [TradeLeg, TradeLeg];
  hl: HlLeg | null;
  phoenix: PhoenixLeg | null;
}

/**
 * The legs of `shape` for `symbol` as pair-mainnet builds them (buildPair): Hyperliquid's and Phoenix's here, and the
 * Phoenix exchange and market checked against the pinned accounts when Phoenix is a leg; an Orderly leg from serve's
 * Orderly session, priced against the stored price (oraclePxOf: refreshed first once trading, closes included). An
 * Orderly leg with no session, or a session not up, throws.
 */
export async function buildLiveShapeLegs(input: LiveLegsInput, shape: PairShape, orderly: ServeOrderly | null): Promise<LiveShapeLegs> {
  const { symbol, desk } = input;
  const p = desk.policy;
  const asset = p.hl_assets.find((a) => a.symbol === symbol);
  const market = p.phoenix_markets.find((m) => m.symbol === symbol);
  if (isDefaultShape(shape, symbol)) {
    if (asset === undefined || market === undefined) throw new Error(`${symbol} must be in both policy.hl_assets and policy.phoenix_markets`);
  } else {
    const listed = shapeRefusal(p, symbol, shape, true);
    if (listed !== null) throw new Error(listed);
  }
  // Each leg capped as the contract checks it, by its own venue's policy symbol (contract/unpriced.ts: an Orderly
  // PERP_<symbol>_USDC leg by its base): an unpriced leg gets the unpriced cap and its max_sz, and no stored price.
  const storedPx = oraclePxOf(input.prices, symbol, input.trading);
  const capsOf = (venue: VenueId, venueSymbol: string) => ({
    oraclePx: unpricedEntry(p, venue, venueSymbol) !== undefined ? async () => null : storedPx,
    ...legCaps(p, venue, venueSymbol),
  });
  const relayer = input.relayer ?? refusingRelayer();
  const best = (book: { bids: { px: number }[]; asks: { px: number }[] }, side: LegSide, venue: string): number => {
    const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
    if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on ${venue} ${symbol}`);
    return px;
  };
  const has = (v: VenueId) => shape.legs.some((l) => l.venue === v);
  const hl = !has('hyperliquid') ? null : new HlLeg({
    relayer, info: (body) => hlInfo(input.hlUrl, body), user: desk.evm_address.toLowerCase(), coin: symbol, asset: asset!.index, szDecimals: asset!.sz_decimals,
    bandBps: p.price_band_bps, ...capsOf('hyperliquid', symbol),
    bestPx: async (side) => best(await input.hl.book(symbol, 5), side, 'Hyperliquid'),
    slippageBps: input.slippageBps, maker: input.maker,
  });
  let phoenix: PhoenixLeg | null = null;
  const mismatches: string[] = [];
  if (has('phoenix')) {
    const spline = await splineOf(market!.orderbook);
    const sol: DeskSolanaAccounts = { authority: desk.solana.authority, traderAccount: desk.solana.phoenix_trader, usdcAta: desk.solana.usdc_ata, phusdAta: desk.solana.phusd_ata };
    phoenix = new PhoenixLeg({
      relayer, chain: input.chain, landedSlot: (sig) => input.solana.landedSlot(sig), waitPastLastValidHeight: (h) => input.solana.waitPastLastValidHeightSlot(h),
      api: phoenixTraderApi(input.phoenixUrl, input.phoenixFetch, 0, input.phoenixBudget),
      desk: sol,
      market: { symbol, orderbook: market!.orderbook, spline, baseLotE8: market!.base_lot_e8, tickE8: market!.tick_e8 },
      bandBps: p.price_band_bps, ...capsOf('phoenix', symbol),
      bestPx: async (side) => best(await input.phoenix.book(symbol, 5), side, 'Phoenix'),
      slippageBps: input.slippageBps, microLamports: input.microLamports,
    });
    // Through the host's budget, retried after a 429: serve reads it once at startup, and a failure there stops serve.
    const snap = await phoenixGet<{ exchange: Parameters<typeof exchangeMismatches>[0]; markets: (Parameters<typeof marketMismatches>[0] & { symbol: string })[] }>(
      input.phoenixUrl, '/v1/exchange/snapshot', {
        timeoutMs: 20_000, ...(input.phoenixFetch === undefined ? {} : { fetch: input.phoenixFetch }), ...(input.phoenixBudget === undefined ? {} : { budget: input.phoenixBudget }),
      },
    );
    mismatches.push(
      ...exchangeMismatches(snap.exchange).map((m) => `the Phoenix exchange differs from the pinned accounts: ${m}`),
      ...marketMismatches(snap.markets.find((m) => m.symbol === symbol), market!, spline, { ignoreStatus: true }),
    );
  }
  let orderlyLeg: TradeLeg | null = null;
  const ol = shape.legs.find((l) => l.venue === 'orderly');
  if (ol !== undefined) {
    if (orderly === null) throw new Error(`an Orderly leg (${ol.symbol}) needs serve's Orderly session, and serve has none`);
    const notReady = (await orderly.ready?.(ol.symbol)) ?? null;
    if (notReady !== null) throw new Error(`the Orderly leg (${ol.symbol}) cannot be made: ${notReady}`);
    orderlyLeg = orderly.leg({ symbol: ol.symbol, ...capsOf('orderly', ol.symbol), slippageBps: input.slippageBps });
    if (orderlyLeg === null) throw new Error(`the Orderly leg (${ol.symbol}) cannot be made: serve's Orderly session is not up`);
    if (orderlyLeg.venue !== 'orderly') throw new Error(`the Orderly session made a ${orderlyLeg.venue} leg for ${ol.symbol}`);
  }
  const byVenue = (v: VenueId): TradeLeg => (v === 'hyperliquid' ? hl! : v === 'phoenix' ? phoenix! : orderlyLeg!);
  const legs: [TradeLeg, TradeLeg] = [byVenue(shape.legs[0].venue), byVenue(shape.legs[1].venue)];
  return { shape, legs, hl, phoenix, priced: anyLegPriced(p, shape.legs), mismatches };
}

/** The relayer of a pair that does not trade: anything that would sign is refused (a bug if reached: legs refuse first). */
function refusingRelayer(): Relayer {
  const no = () => {
    throw new Error('serve does not trade (GIMBAL_TRADE is not 1): nothing is signed');
  };
  return { hlOrder: no, hlCancel: no, solSign: no } as unknown as Relayer;
}

/**
 * The start lines: what is live. `rescue` is serve-rescue's summary; `rescueLive` whether its live rescuer runs.
 * Every protection is named as trading or only alerting.
 */
export function liveLines(p: { pair: ServePair; rescueSummary: string; rescueLive: boolean; mode: Mode; alertPct: number; monitorMin: number }): string[] {
  const pp = p.pair.pair;
  const out: string[] = [...p.pair.lines];
  const tradeVia = 'reduce-only IOCs through the PairTrader (legging guard, price refreshed before each close, open: lines)';
  const adlWhy = pp === null ? null : pp.adlHold ?? pp.adlOff();
  const unconfirmed = p.pair.unconfirmed?.() ?? null;
  if (unconfirmed !== null) {
    out.push(`live      trades: NOTHING yet, ${unconfirmed}; the start is tried again and goes live once two synced reads of both legs agree`);
  } else if (pp === null) {
    out.push('live      trades: nothing (no pair trader)');
  } else if (pp.live) {
    const adl = adlWhy === null
      ? `ADL -> pair paused, both legs unwound (${p.pair.adl?.state.attemptsLeft ?? ADL_ATTEMPTS} of ${ADL_ATTEMPTS} attempts left)`
      : `ADL -> alert only: ${adlWhy}`;
    out.push(`live      TRADES (GIMBAL_TRADE=1), ${tradeVia}: panic_close -> resting Hyperliquid orders cancelled, both legs closed; ${adl}`
      + `${p.rescueLive ? '; rescue reduce -> both legs smaller' : ''}`);
  } else {
    out.push(`live      trades: NOTHING, alert only: ${pp.why ?? 'not live'}`);
  }
  const alerts = [
    `liquidation under ${p.alertPct} % (journal + console; monitor lines every ${p.monitorMin} min)`,
    'risk watch and rescue lines (journal, rescue trigger)',
    ...(pp !== null && !pp.live ? ['ADL (journaled, the owner unwinds)', 'panic_close (journaled, nothing cancelled or closed)'] : []),
    ...(pp !== null && pp.live && adlWhy !== null ? [`ADL (journaled for the owner: ${adlWhy})`] : []),
    ...(pp !== null && pp.live && !p.rescueLive ? ['a rescue reduce (no live rescuer: GIMBAL_RESCUE is not 1)'] : []),
    'venue, 1Click and NEAR health',
  ];
  out.push(`live      alerts only: ${alerts.join('; ')}`);
  out.push(`live      rescue: ${p.rescueSummary.replace(/^rescue: /, '')}`);
  if (p.mode === 'mainnet') {
    out.push(`live      rescue routes on mainnet: ${p.rescueLive
      ? `reserve -> Hyperliquid (fund_venue), Hyperliquid -> Arbitrum -> 1Click (hl_withdraw, evm_usdc_to_intents)${pp?.live === true ? ', reduce both legs' : ''}; Phoenix as a source or a target is not wired`
      : 'none live (GIMBAL_RESCUE is not 1): triggers are published at detect, the owner acts'}`);
  }
  return out;
}
