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
// reduce-only), one at a time. An open on another symbol than the pair held (flat) builds that symbol's pair the way
// the start does (the legs, the Phoenix market check, resting orders, two agreeing reads, startPlan on the same state
// file) and only then replaces the flat one; a new pair that would not trade is dropped and the open refused. From
// then on the new pair is held and protected exactly as an adopted one: the reducer, panic_close, the ADL watch (which
// follows the pair held now) and the trader state.
//
// Resting orders: the Phoenix leg sends IOCs only, so only Hyperliquid can hold one (a post-only order of an earlier
// pair-mainnet run). One resting on the pair's coin at start makes the pair alert only (it could fill under the trader,
// and the ADL watch would read the fill as a shrink or a growth of ours), with a line naming it; cancel it, reconcile
// and start again. panic_close cancels every resting order on the policy's Hyperliquid coins first (cancelResting).

import type { ContractPolicy, Mode, StreamEvent, TxRef } from '@gimbal/shared';
import type { NearTransport } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport } from '../contract/near-transport.ts';
import type { DeskView } from '../contract/types.ts';
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
import type { LegSide, MakerSettings, TradeLeg } from '../trade/legs.ts';
import { DEFAULT_MAKER, HlLeg } from '../trade/legs.ts';
import { signedQtyString } from '../trade/lots.ts';
import type { PairResult } from '../trade/pair.ts';
import { PairTrader } from '../trade/pair.ts';
import { PhoenixLeg, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import { GuardedLeg, InFlightBook, ProtectedPair, inFlightEnds, reconcileHow, startPlan } from '../trade/protected-pair.ts';
import type { TraderFileState, TraderLock } from '../trade/trader-state.ts';
import { TRADER_STATE_VERSION, TraderStateStore, acquireTraderLock, traderLockPath, traderStateFile, userStateDir } from '../trade/trader-state.ts';
import { HL_MAINNET_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import type { HostBudget } from '../venues/http-budget.ts';
import { PHOENIX_API_URL, PhoenixReader, SOLANA_MAINNET_RPC_URL, phoenixGet } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';
import type { PriceDeps, StoredPrice } from './pair-mainnet-lib.ts';
import { PRICE_MARGIN_S, ensureFresh, newPriceState, oraclePxOf, priceFitRefusal, priceLifeS, refreshLanded } from './pair-mainnet-lib.ts';
import type { OpsCtx, PairRunner } from './pair-ops.ts';
import { pairOf, planClose, planOpen, sendClose, sendOpen } from './pair-ops.ts';
import type { ContractSide } from './serve-contract.ts';
import { checkContractNetwork, contractEnv } from './serve-contract.ts';

/** The IOC slippage of serve's closes, as pair-mainnet's default. */
export const SERVE_SLIPPAGE_BPS = 50;
/** serve's maker settings: pair-mainnet's defaults (--reprice-s 30, --maker-timeout-s 120, --max-orders 6, no taker fallback). */
export const SERVE_MAKER: MakerSettings = { ...DEFAULT_MAKER, timeoutMs: 120_000 };
/** The strategy loop's open: pair-mainnet open's defaults for what StrategyConfig does not set. */
export const SERVE_HOLD_DAYS = 7;
export const SERVE_BASIS_BPS = 10;
/** At start both legs are read twice this far apart, and must agree; up to START_READ_TRIES times. */
const START_CONFIRM_MS = 3_000;
const START_READ_TRIES = 3;
/** Orders in flight from before the restart that could not be settled now are tried again this much later. */
const SETTLE_RETRY_MS = 60_000;

/** The Hyperliquid leg as serve needs it (HlLeg; tests pass their own). */
export type PairHlLeg = TradeLeg & Pick<HlLeg, 'adoptPending' | 'pendingMakerOrders' | 'cancelPending'>;

/** Where an open's or a close's lines go: `say` its plan and results, `open` what the owner must reconcile. */
export interface CarryOut {
  say(line: string): void;
  open(line: string): void;
}

/** What one open or close of the strategy loop did on a pair's legs (pair-ops.ts). */
export interface CarryResult {
  /** pair-mainnet's refusals: nothing was signed when this is not empty. */
  refusals: string[];
  results: PairResult[];
}

/** pair-mainnet's open and close (pair-ops.ts) on one pair's legs, sending through its ProtectedPair. */
export interface SlotCarry {
  open(request: { legUsd: number; leverage: number; reason: string; qty?: string }, out: CarryOut): Promise<CarryResult>;
  close(request: { reason: string }, out: CarryOut): Promise<CarryResult>;
}

/** What a pair's carry is built from. */
export interface CarryInput {
  symbol: string;
  legs: { hl: PairHlLeg; phoenix: TradeLeg; priced: boolean };
  trader: PairTrader;
  pair: ProtectedPair;
  client: NearContractClient;
  relayer: Relayer | null;
  prices: PriceDeps;
  /** While on, the legs price with the stored price as it is: no refresh_prices before the open's refusals pass. */
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
  /** The legs of `symbol` (buildLiveLegs). */
  buildLegs(p: { symbol: string; client: NearContractClient; relayer: Relayer | null; prices: PriceDeps; trading: () => boolean }): Promise<{ hl: PairHlLeg; phoenix: TradeLeg; priced: boolean; mismatches: string[] }>;
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
  /** The fills' fees, USD (≤ 0 as the journal counts costs). */
  feeUsd: number;
}

/** The strategy loop's hands on the desk's pair (strategy/loop.ts). */
export interface PairHands {
  /** The pair symbols the policy allows (in both policy.hl_assets and policy.phoenix_markets). */
  readonly symbols: readonly string[];
  /** Why nothing can be opened or closed now, or null. */
  blocked(): string | null;
  /** The symbol the trader holds open (a leg not flat, or unknown), or null when flat or no pair. */
  heldSymbol(): string | null;
  /** pair-mainnet open on `symbol`, short Hyperliquid and long Phoenix: refusals first, then maker first. */
  open(request: { symbol: string; legUsd: number; leverage: number; reason: string; qty?: string }): Promise<HandsResult>;
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
  /** Turns trading off first (every order and close refused from then on), then stops the watch and the trader, closes the readers and releases the lock. */
  stop(): void;
}

const none = (lines: string[], why: string, stop: () => void = () => {}): ServePair => ({
  pair: null, adl: undefined, reducer: () => null, notTrading: () => why, lines, drain: async () => true, stop,
});

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
  quiet(): string | null;
  /** While a new pair is built: nothing signed or saved; `false` resumes. */
  suspend(on: boolean): void;
  /** After an open: legs moved outside the trader (finish()'s residual hedge) are adopted when they offset. */
  readopt(): Promise<string | null>;
  /** Ends this pair's trader, watch and timers (the lock and readers stay with serve). */
  end(): void;
}

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

  // The lock first: pair-mainnet --send cannot start between the reads below and the first save.
  let lock: TraderLock | null = null;
  const release = () => {
    lock?.release();
    lock = null;
  };
  if (wantLive) {
    try {
      lock = acquireTraderLock(traderLockPath(env, input.mode, contractId, input.deskId));
    } catch (err) {
      deps.close();
      throw new Error(`GIMBAL_TRADE=1: ${errorMessage(err)} (pair-mainnet --send holds the same lock)`);
    }
  }
  const stopNone = () => {
    deps.close();
    release();
  };

  try {
    const identity = { contractId, deskId: input.deskId, evm };
    const store = new TraderStateStore(traderStateFile(input.stateDir ?? userStateDir(env), input.mode, identity), identity);
    const saved = store.load();
    const freshWant = `${contractId}/${input.deskId}`;

    // ---- which pair ----
    const common = policy.hl_assets.map((a) => a.symbol).filter((s) => policy.phoenix_markets.some((m) => m.symbol === s));
    const held = [...new Set([...(await deps.hlHeld(evm)), ...(await deps.phoenixHeld(desk.solana.authority))])];
    const lines: string[] = [];
    const outside = held.filter((s) => !common.includes(s));
    if (outside.length > 0) lines.push(`pair      not protected (not in both policy lists): ${outside.join(', ')}`);
    const open = held.filter((s) => common.includes(s));
    if (open.length > 1) {
      stopNone();
      return none([...lines, `pair      NONE: ${open.join(' and ')} are both open; serve protects one pair: close one with pair-mainnet first`], 'two pairs are open: serve protects none');
    }
    const savedSymbol = saved.kind === 'loaded' ? saved.state.symbol : null;
    const symbol = open[0] ?? env('GIMBAL_PAIR_SYMBOL')?.trim() ?? savedSymbol ?? (common.length === 1 ? common[0]! : null);
    const flatWhy = `both legs flat and no GIMBAL_PAIR_SYMBOL (policy pairs: ${common.join(', ') || 'none'})`;
    if (symbol === null) {
      // Nothing held: a trading serve still keeps the lock when the state allows trading, so the loop may open one.
      const fresh = env('GIMBAL_TRADER_FRESH');
      const stateWhy = saved.kind === 'loaded' || fresh === freshWant ? null
        : saved.kind === 'none' ? `no trader state at ${store.path}: a missing file is not a fresh start; after checking both legs on the venues, start once with GIMBAL_TRADER_FRESH=${freshWant}`
        : `${saved.problem}; after reconciling both legs, start once with GIMBAL_TRADER_FRESH=${freshWant}`;
      if (!wantLive || stateWhy !== null || common.length === 0) {
        stopNone();
        const why = !wantLive ? 'nothing to protect' : stateWhy ?? 'the policy lists no symbol in both hl_assets and phoenix_markets';
        return none([...lines, `pair      none: ${flatWhy}; ${why}`], 'no pair is open');
      }
    }
    if (symbol !== null && !common.includes(symbol)) {
      stopNone();
      return none([...lines, `pair      none: ${symbol} is not in both policy.hl_assets and policy.phoenix_markets (${common.join(', ') || 'none'})`], `${symbol} is not a policy pair`);
    }

    // ---- the signing side ----
    let relayer: Relayer | null = null;
    let client: NearContractClient = input.side.client;
    if (wantLive) ({ client, relayer } = await deps.signing());
    const prices: PriceDeps = {
      maxAgeS: policy.oracle_max_age_s, send: wantLive, read: (s) => storedPrice(client, s),
      refresh: (s, maxAgeS) => client.refreshPrices([s], { maxAgeS }), now: () => input.clock.now(), log: (l) => log(`pair ${l.trim()}`),
      landed: refreshLanded, ...newPriceState(),
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

    /** `symbol`'s pair, built and adopted as the start does (see the header); `start` false: a later open's new pair. */
    const makeSlot = async (sym: string, start: boolean): Promise<Slot> => {
      let live = false;
      let suspended = false;
      let planning = false;
      const legs = await deps.buildLegs({ symbol: sym, client, relayer, prices, trading: () => live && !suspended && !planning });
      const why: string[] = [];
      why.push(...legs.mismatches);
      if (!(priceLifeS(policy.oracle_max_age_s) > PRICE_MARGIN_S)) {
        why.push(`oracle_max_age_s ${policy.oracle_max_age_s} leaves a fresh price ${priceLifeS(policy.oracle_max_age_s)} s, not more than the ${PRICE_MARGIN_S} s an IOC and its retry need`);
      }
      const resting = restingOn(await deps.openOrders(evm).catch((err: unknown) => errorMessage(err)), sym);
      if (typeof resting === 'string') {
        why.push(`${resting}: a resting ${sym} order could fill under the trader`);
      } else if (resting.length > 0) {
        const names = resting.map((o) => `${o.side} ${o.sz} (oid ${String(o.oid)})`).join(', ');
        why.push(`Hyperliquid has ${resting.length} resting ${sym} order(s) (${names}), left by an earlier pair-mainnet run: one could fill under the trader and the ADL watch would misread it; cancel it on Hyperliquid, reconcile both legs, then start serve again`);
      }

      // ---- what the trader holds ----
      const read = await readTwice([legs.hl, legs.phoenix], sleep, log);
      const plan = startPlan({ symbol: sym, read, saved: start ? saved : store.load(), fresh: env('GIMBAL_TRADER_FRESH'), freshWant, path: store.path, now: input.clock.now() });
      if (!plan.stateOk && plan.why !== null) why.push(plan.why);
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
        index, live: trades, stopped: () => stopped, now: () => input.clock.now(), opening: () => pp?.opening === true,
        beforeSign: (o: Parameters<InFlightBook['add']>[0]) => book.add(o, save),
      });
      const trader = new PairTrader({
        legs: [new GuardedLeg(legs.hl, guard(0)), new GuardedLeg(legs.phoenix, guard(1))],
        priceBandBps: policy.price_band_bps, clock: input.clock, log: (line) => log(`pair      ${line}`),
        // Only the strategy loop's open opens (ProtectedPair.openInChunks), and never while the pair is paused after an ADL.
        openBlocked: () => (pp?.opening !== true ? 'serve opens a pair only through the strategy loop (auto, or POST /rotate)' : watch?.paused ?? null),
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
      legs.hl.adoptPending(plan.pendingMaker);
      pp = new ProtectedPair({
        trader, symbol: sym, live, why: live ? null : why.join('; '), inFlight: book, adlHold: plan.adlHold,
        reconcile: reconcileHow({ symbol: sym, path: store.path, freshWant }),
        ...(legs.priced ? { freshPrice: async () => { await ensureFresh(prices, sym, PRICE_MARGIN_S); } } : {}),
        pendingMaker: () => legs.hl.pendingMakerOrders(),
        cancelPending: (reason) => legs.hl.cancelPending(reason),
        save, onOpen, log: (l) => log(`pair      ${l}`), sleep,
      });
      const pq = pp;
      const adl = new AdlWatch(pq, {
        state: plan.adl, trade: live, hold: () => pq.adlHold, log: (l) => log(`pair      ${l}`), clock: input.clock, sleep,
        // Throws when the save fails: an unwind attempt then sends nothing (risk/adl.ts).
        onChange: () => save(),
      });
      watch = adl;
      snapshot = () => ({
        version: TRADER_STATE_VERSION, savedAt: input.clock.now(), symbol: sym, trader: trader.exportState(),
        pendingMaker: [...legs.hl.pendingMakerOrders()], inFlight: book.orders, adl: adl.state,
      });
      save();

      const slotLines: string[] = [];
      for (const n of plan.notes) slotLines.push(`pair      ${n}`);
      for (const line of plan.owner) ownerAlert(line);
      const heldLock = lock as TraderLock | null;
      slotLines.push(`pair      ${sym}: hyperliquid ${signedQtyString(read[0])} (${read[0] < 0n ? 'short' : read[0] > 0n ? 'long' : 'flat'}), phoenix ${signedQtyString(read[1])} (${read[1] > 0n ? 'long' : read[1] < 0n ? 'short' : 'flat'})`
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
        symbol: sym, pp: pq, adl, trader, carry, why, lines: slotLines, settle,
        live: trades,
        quiet: () => {
          const base = trader.legs.map((l) => trader.baseline(l));
          if (base.some((b) => b === null || b === undefined || b !== 0n)) return `the ${sym} legs are not flat (${base.map((b) => (b === null || b === undefined ? 'unknown' : signedQtyString(b))).join(' and ')})`;
          if (pq.closing) return `a close runs on ${sym}`;
          if (book.orders.length > 0) return `${book.orders.length} ${sym} order(s) are in flight with no saved result`;
          if (trader.legs.some((l) => trader.unsettled(l) !== null)) return `a ${sym} order has no answer and may still run`;
          if (legs.hl.pendingMakerOrders().length > 0) return `a ${sym} post-only order is not settled`;
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
          if (trader.legs.some((l) => trader.unsettled(l) !== null) || legs.hl.pendingMakerOrders().length > 0) return null;
          const now = await readTwice(trader.legs, sleep, log).catch(() => null);
          if (now === null || now[0] + now[1] !== 0n || pq.closing) return null;
          pq.adopt(now);
          return `adopted ${signedQtyString(now[0])} and ${signedQtyString(now[1])} ${sym} after the residual hedge`;
        },
        end: () => {
          ended = true;
          live = false;
          pq.stop();
          if (settleTimer !== null) clearTimeout(settleTimer);
          settleTimer = null;
          adl.stop();
          trader.stop();
        },
      };
    };

    let current: Slot | null = null;
    if (symbol !== null) {
      current = await makeSlot(symbol, true);
      lines.push(...current.lines);
    } else {
      lines.push(`pair      none held: ${flatWhy}; the strategy loop may open one of ${common.join(', ')} (state ${store.path}, lock ${(lock as TraderLock | null)?.path ?? 'none'})`);
    }
    // An alert-only pair holds no lock: pair-mainnet must be able to fix what made it alert only.
    if (current !== null && !current.live()) release();
    const trading = () => !stopped && lock !== null;

    // The strategy loop's operation in flight (one at a time).
    let operation: Promise<HandsResult> | null = null;

    const cancelResting = async (): Promise<CancelResult> => {
      if (stopped) throw new Error('serve is stopping and its trader lock is released: nothing is cancelled');
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
      out.notes.push('Phoenix: the leg sends IOCs only, nothing rests there');
      return out;
    };

    // ---- the strategy loop's hands ----
    const heldSymbol = (): string | null => {
      const s = current;
      if (s === null) return null;
      const base = s.trader.legs.map((l) => s.trader.baseline(l));
      return base.every((b) => b === 0n) ? null : s.symbol;
    };
    const blocked = (): string | null => {
      if (stopped) return 'serve is stopping: nothing is signed';
      if (!trading()) return current === null ? 'no pair trader' : `alert only: ${current.pp.why ?? 'not live'}`;
      if (operation !== null) return 'an open or close of the strategy loop is running';
      if (current !== null) {
        if (!current.live()) return `alert only: ${current.pp.why ?? 'not live'}`;
        if (current.pp.closing) return `a close runs on ${current.symbol} (panic_close, a rescue's reduce or an ADL unwind)`;
        if (current.adl.state.event !== null) return `an ADL event on ${current.symbol} is in progress`;
      }
      return null;
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
      const op = run().catch((err: unknown) => result(false, `not done: ${errorMessage(err)}`)).finally(() => {
        operation = null;
      });
      operation = op;
      return op;
    };
    const hands: PairHands = {
      symbols: common,
      blocked,
      heldSymbol,
      open: (request) => exclusive(async () => {
        const sym = request.symbol;
        if (!common.includes(sym)) return result(false, `${sym} is not in both policy.hl_assets and policy.phoenix_markets (${common.join(', ') || 'none'})`);
        const holding = heldSymbol();
        if (holding !== null) return result(false, `a ${holding} pair is held: it is closed first (exit or rotate)`);
        if (current !== null && current.adl.state.paused !== null) return result(false, `the pair is paused since an ADL (${current.adl.state.paused}): no new pair opens until the owner reconciles`);
        const off = current?.quiet() ?? null;
        if (off !== null) return result(false, `the ${current!.symbol} pair is not settled: ${off}`);
        let slot = current;
        if (slot === null || slot.symbol !== sym) {
          const old = slot;
          old?.suspend(true);
          let next: Slot;
          try {
            next = await makeSlot(sym, false);
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
        const { lines: said, opens, out } = collect();
        const r = await slot.carry.open({ legUsd: request.legUsd, leverage: request.leverage, reason: request.reason, ...(request.qty === undefined ? {} : { qty: request.qty }) }, out);
        if (r.refusals.length > 0) return result(false, `open refused, nothing signed: ${r.refusals.join('; ')}`, { lines: said, open: opens });
        const again = await slot.readopt().catch((err: unknown) => `not adopted after the residual hedge: ${errorMessage(err)}`);
        if (again !== null) log(`pair      ${again}`);
        const opened = r.results.filter((x) => x.status === 'open');
        const last = r.results.at(-1);
        const ok = opened.length > 0 && heldSymbol() !== null;
        const reason = ok
          ? `${sym} opened: ${opened.map((x) => x.size).join(' + ')} a leg${last !== undefined && last.status !== 'open' ? ` (the last part ended ${last.status})` : ''}`
          : `${sym} not opened: ${last === undefined ? 'no part was sent' : `${last.status}${last.notes.length > 0 ? ` (${last.notes.join('; ')})` : ''}`}`;
        return result(ok, reason, { results: r.results, lines: said, open: opens, ...summarise(r.results) });
      }),
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
    };
    const live = trading() && (current === null || current.live());
    return {
      get pair() {
        return current?.pp ?? null;
      },
      adl: current !== null || live ? adl : undefined,
      lines,
      reducer: () => (current !== null && current.live() && !stopped ? current.pp : null),
      notTrading: () => {
        if (stopped) return 'serve is stopping: nothing is signed';
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
      stop: () => {
        // First: nothing is signed from here on (a rescue between its read and its reduce must not sign after the
        // lock is released), and nothing is saved.
        stopped = true;
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

/** pair-mainnet's open and close (pair-ops.ts) on a live pair's legs, sending through its ProtectedPair. */
function liveCarry(p: CarryInput & { input: ServePairInput; hlUrl: string; phoenixUrl: string; solRpcUrl: string; readers: () => { hl: HyperliquidReader; phoenix: PhoenixReader; solana: SolanaSubmitter } }): SlotCarry {
  const { hl, phoenix } = p.legs;
  if (!(hl instanceof HlLeg) || !(phoenix instanceof PhoenixLeg)) {
    const no = async (): Promise<CarryResult> => ({ refusals: ['these legs are not the live Hyperliquid and Phoenix legs'], results: [] });
    return { open: no, close: no };
  }
  const ctxFor = async (out: CarryOut): Promise<OpsCtx> => {
    // A fresh desk each time: paused and closing (panic_close) are refusals, and the policy may have changed.
    const [config, desk] = await Promise.all([p.client.config(), p.client.getDesk(p.input.deskId)]);
    if (desk === null) throw new Error(`get_desk(${p.input.deskId}) answered null`);
    const r = p.readers();
    return {
      client: p.client, config, desk, hlUrl: p.hlUrl, hl: r.hl, phoenix: r.phoenix, phoenixUrl: p.phoenixUrl, chain: solanaChain(p.solRpcUrl),
      solana: r.solana, sol: { authority: desk.solana.authority, traderAccount: desk.solana.phoenix_trader, usdcAta: desk.solana.usdc_ata, phusdAta: desk.solana.phusd_ata },
      relayer: p.relayer, prices: p.prices, send: true, trading: false, say: (line = '') => out.say(line), open: (line) => out.open(line),
    };
  };
  const runner = (opening: boolean): PairRunner => ({
    openInChunks: (request) => p.pair.openInChunks(request),
    close: (request) => p.pair.close(request),
    hedge: (side, size, reduceOnly, reason) => p.pair.hedge(1, side, size, reduceOnly, reason, opening),
    stopOnFinish: false,
  });
  const pairFor = (ctx: OpsCtx, opening: boolean) => pairOf(ctx, {
    symbol: p.symbol, hl, phoenix, trader: p.trader, run: runner(opening), maker: SERVE_MAKER, microLamports: ORDER_PRIORITY_MICROLAMPORTS, priced: p.legs.priced, closing: !opening,
  });
  return {
    open: async (request, out) => {
      const ctx = await ctxFor(out);
      const pair = await pairFor(ctx, true);
      p.planning(true);
      let plan: Awaited<ReturnType<typeof planOpen>>;
      try {
        plan = await planOpen(ctx, pair, {
          symbol: p.symbol, legUsd: request.legUsd, leverage: request.leverage, holdDays: SERVE_HOLD_DAYS, basisBps: SERVE_BASIS_BPS,
          ...(request.qty === undefined ? {} : { qty: request.qty }),
        });
      } finally {
        p.planning(false);
      }
      const refusals = [...plan.refusals];
      // pair-mainnet's trader refuses an open on a closing desk, and buildPair a maker timeout the price cannot outlive.
      if (ctx.desk.closing === true) refusals.push('the desk is closing (panic_close)');
      const fit = p.legs.priced ? priceFitRefusal(SERVE_MAKER.timeoutMs / 1000, ctx.desk.policy.oracle_max_age_s) : null;
      if (fit !== null) refusals.push(fit);
      if (refusals.length > 0) return { refusals, results: [] };
      return { refusals: [], results: await sendOpen(ctx, pair, plan, request.reason) };
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
  let made: { hl: HyperliquidReader; phoenix: PhoenixReader; solana: SolanaSubmitter } | null = null;
  const r = () => (made ??= {
    hl: new HyperliquidReader({ network: 'mainnet', url: `${hlUrl}/info` }),
    phoenix: new PhoenixReader({ apiUrl: phoenixUrl, rpcUrl: solRpcUrl }),
    solana: new SolanaSubmitter({ rpcUrl: solRpcUrl, network: 'mainnet' }),
  });
  return {
    hlHeld: async (evm) => (await r().hl.account(evm)).positions.filter((x) => x.size !== 0).map((x) => x.symbol),
    phoenixHeld: async (authority) => phoenixHeld(await phoenixTraderApi(phoenixUrl).traderState(authority)),
    openOrders: (evm) => hlInfo(hlUrl, { type: 'openOrders', user: evm }),
    signing: async () => {
      const cfg = contractEnv(input.env, input.mode, { signing: true });
      if (cfg === null) throw new Error('GIMBAL_TRADE=1 needs GIMBAL_CONTRACT_ID, DESK_ID and the operator key');
      const transport: NearTransport = new NearApiTransport({ network: cfg.network, accountId: cfg.accountId!, privateKey: cfg.privateKey!, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }) });
      const client = new NearContractClient({ contractId: cfg.contractId, network: cfg.network, transport, onHealth: (s, d) => input.log(`pair near ${s}: ${d}`) });
      checkContractNetwork(cfg.contractId, await client.config(), cfg.network);
      return { client, relayer: new Relayer({ contract: client, deskId: input.deskId, hyperliquid: new HyperliquidSubmitter({ network: 'mainnet', apiUrl: hlUrl }), solana: r().solana }) };
    },
    buildLegs: ({ symbol, client, relayer, prices, trading }) => buildLiveLegs({
      client, desk, symbol, hlUrl, hl: r().hl, phoenix: r().phoenix, phoenixUrl, chain: solanaChain(solRpcUrl), solana: r().solana, relayer,
      prices, trading, maker: SERVE_MAKER, slippageBps: SERVE_SLIPPAGE_BPS, microLamports: ORDER_PRIORITY_MICROLAMPORTS,
    }),
    carry: (c) => liveCarry({ ...c, input, hlUrl, phoenixUrl, solRpcUrl, readers: r }),
    close: () => made?.phoenix.close(),
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

/** Both legs read twice START_CONFIRM_MS apart until two reads agree (START_READ_TRIES at most); throws otherwise. */
async function readTwice(legs: [TradeLeg, TradeLeg], sleep: (ms: number) => Promise<void>, log: (line: string) => void): Promise<[bigint, bigint]> {
  let last = '';
  for (let i = 0; i < START_READ_TRIES; i++) {
    try {
      const a = await Promise.all(legs.map((l) => l.position()));
      await sleep(START_CONFIRM_MS);
      const b = await Promise.all(legs.map((l) => l.position()));
      if (a[0] === b[0] && a[1] === b[1]) return [a[0]!, a[1]!];
      last = `two reads differ: ${a.map(String).join(',')} then ${b.map(String).join(',')}`;
    } catch (err) {
      last = errorMessage(err);
    }
    log(`pair      the legs could not be read twice alike at start (${last}); trying again`);
    await sleep(START_CONFIRM_MS);
  }
  throw new Error(`pair: the legs could not be read twice alike at start (${last}); nothing is adopted`);
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
  /** The symbol has a stored price (not in policy.unpriced). */
  priced: boolean;
  /** The Phoenix exchange and the policy market against the pinned accounts (status ignored: closes are reduce-only). */
  mismatches: string[];
}

/** The two legs of the pair as pair-mainnet builds them (buildPair), for `symbol`. */
export async function buildLiveLegs(input: LiveLegsInput): Promise<LiveLegs> {
  const { symbol, desk } = input;
  const p = desk.policy;
  const asset = p.hl_assets.find((a) => a.symbol === symbol);
  const market = p.phoenix_markets.find((m) => m.symbol === symbol);
  if (asset === undefined || market === undefined) throw new Error(`${symbol} must be in both policy.hl_assets and policy.phoenix_markets`);
  const unpriced = p.unpriced.find((u) => u.symbol === symbol);
  const maxNotionalUsd = unpriced === undefined ? p.max_notional_usd : Math.min(p.max_notional_usd, p.unpriced_max_notional_usd);
  const oraclePx = unpriced !== undefined ? async () => null : oraclePxOf(input.prices, symbol, input.trading);
  const relayer = input.relayer ?? refusingRelayer();
  const best = (book: { bids: { px: number }[]; asks: { px: number }[] }, side: LegSide, venue: string): number => {
    const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
    if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on ${venue} ${symbol}`);
    return px;
  };
  const hl = new HlLeg({
    relayer, info: (body) => hlInfo(input.hlUrl, body), user: desk.evm_address.toLowerCase(), coin: symbol, asset: asset.index, szDecimals: asset.sz_decimals, oraclePx,
    bandBps: p.price_band_bps, maxNotionalUsd, ...(unpriced === undefined ? {} : { maxSz: unpriced.max_sz }),
    bestPx: async (side) => best(await input.hl.book(symbol, 5), side, 'Hyperliquid'),
    slippageBps: input.slippageBps, maker: input.maker,
  });
  const spline = await splineOf(market.orderbook);
  const sol: DeskSolanaAccounts = { authority: desk.solana.authority, traderAccount: desk.solana.phoenix_trader, usdcAta: desk.solana.usdc_ata, phusdAta: desk.solana.phusd_ata };
  const phoenix = new PhoenixLeg({
    relayer, chain: input.chain, landedSlot: (sig) => input.solana.landedSlot(sig), waitPastLastValidHeight: (h) => input.solana.waitPastLastValidHeightSlot(h),
    api: phoenixTraderApi(input.phoenixUrl, input.phoenixFetch, 0, input.phoenixBudget),
    desk: sol,
    market: { symbol, orderbook: market.orderbook, spline, baseLotE8: market.base_lot_e8, tickE8: market.tick_e8 },
    oraclePx, bandBps: p.price_band_bps, maxNotionalUsd, ...(unpriced === undefined ? {} : { maxSz: unpriced.max_sz }),
    bestPx: async (side) => best(await input.phoenix.book(symbol, 5), side, 'Phoenix'),
    slippageBps: input.slippageBps, microLamports: input.microLamports,
  });
  // Through the host's budget, retried after a 429: serve reads it once at startup, and a failure there stops serve.
  const snap = await phoenixGet<{ exchange: Parameters<typeof exchangeMismatches>[0]; markets: (Parameters<typeof marketMismatches>[0] & { symbol: string })[] }>(
    input.phoenixUrl, '/v1/exchange/snapshot', {
      timeoutMs: 20_000, ...(input.phoenixFetch === undefined ? {} : { fetch: input.phoenixFetch }), ...(input.phoenixBudget === undefined ? {} : { budget: input.phoenixBudget }),
    },
  );
  const mismatches = [
    ...exchangeMismatches(snap.exchange).map((m) => `the Phoenix exchange differs from the pinned accounts: ${m}`),
    ...marketMismatches(snap.markets.find((m) => m.symbol === symbol), market, spline, { ignoreStatus: true }),
  ];
  return { hl, phoenix, priced: unpriced === undefined, mismatches };
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
  if (pp === null) {
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
