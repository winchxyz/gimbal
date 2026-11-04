// The strategy loop (docs/interfaces.md §3 "Strategy loop"): serve runs decide() (decide.ts) and carries its `act` out.
//
// When: after each funding payment (the hourly check: the first scan once HOUR_GRACE_MS have passed after the top of
// the hour, when Hyperliquid pays; decide.ts moves its counts only on it) and on every scan event (hourly false).
// Only with GIMBAL_TRADE=1: otherwise it publishes the decision `off` and decides nothing. With auto off decide() still
// runs (its counts move, so turning auto on does not wait out the hours again) and answers `off`; nothing is carried
// out. One decision at a time: checks, acts and the manual POST /rotate and /close run one after another. Never while
// a rescue or an ADL unwind is running: that is checked at the start of a check and again right before every close
// and every open (auto and manual), and once more inside the open, right before its first order and before each
// later part (the hands' gate); such a refusal is tried again on the next check.
//
// What decide() is fed: the last scan's windows, the held pair (the loop's own record of what it entered, or the pair
// serve adopted from the venues, matched to its desk window) with the margin a rotation would free, free margin per
// venue, liveRescue per venue (a route exists), the policy's max_notional_usd and price_band_bps, each window's 14-day
// gross and lots (`facts`), and the saved LoopCounters.
//
// How an act is carried out (the hands: serve-pair.ts, pair-mainnet's own code in pair-ops.ts): enter = open the
// exact quantity decide() sized (a maximum: held to the contract's cap at order time, never raised); exit = close both
// legs reduce-only; rotate = close the held pair, then open the new one, and when the open is refused the desk stays
// flat and the journal says so. Before an enter or a rotate the window goes to the NEAR AI veto (veto.ts checkVeto);
// a veto saves skipAct(…, { vetoed: true }), whose counters hold the window out (vetoedUntil), writes a `veto` entry
// and signs nothing; the verdict is shown on the window (Window.veto, republished). An act refused before anything was
// sent is journaled and not tried again for RETRY_AFTER_MS; one that sent orders, or was refused for a passing reason
// (a rescue running, a close in flight), is tried again on the next check. An open that needs the stored price
// refreshed pays for one refresh_prices only after its other refusals pass (pair-ops.ts refreshForOpen); one refused
// after that payment holds its window REFRESH_HOLD_MS, and the opens send at most MAX_OPEN_REFRESHES_PER_DAY per
// symbol per UTC day (counted in the saved state, journaled when hit). A rotate refreshes the target's price before
// it closes the held pair (hands.prepareOpen): a refresh that fails keeps the pair held. A single leg (only one venue
// holds a position) is never held as a pair: it is closed at once, reduce-only, and tried again every check until
// flat. Each check first asks the hands to check their record against the venues (serve-pair.ts
// reconcileWithVenues): a pair recorded while one leg or none is open is corrected from two agreeing reads, and
// journaled.
//
// Published: `decision` whenever it changes (action, reason, window or held; not the time). Journal: every enter,
// exit, rotate, refused, error and veto with numbers and tx links; `wait` when its category changes (journalWait),
// with the top window's net, the minimum, k/N checks and what blocks it; `hold` when its category changes and once per
// hourly check, with the held net, P&L, hours held and bad checks; `off` on each transition into it. JournalEntry has
// no `hold` or `off` kind: those are `wait` entries whose numbers.action says which.
//
// On disk: the counters, the held record and the day's refresh count next to the trader state (GIMBAL_STATE_DIR), one JSON file per mode,
// contract and desk, written atomically (temporary file, fsync, rename, directory fsync) after every check. A missing
// file starts from NO_COUNTERS; an unusable one too, but with the cooldown and the day's rotations taken as used.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContractPolicy, JournalEntry, Mode, StrategyConfig, StrategyDecision, StreamEvent, TxRef, Window as FundingWindow } from '@gimbal/shared';
import { isEnterable } from '../scanner/price.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';
import type { DecideInput, Decision, HeldPair, LoopCounters } from './decide.ts';
import { LOOP_RULES, NO_COUNTERS, decide as defaultDecide, heldForwardAprPct, journalWait, sizeFor, skipAct } from './decide.ts';
import type { Veto, VetoLeg, VetoResult, VetoSource } from './veto.ts';
import { checkVeto, vetoFacts, vetoJournalNumbers } from './veto.ts';

const HOUR_MS = 3_600_000;
/** Hyperliquid pays funding at the top of the hour: the hourly check is the first scan this long after it. */
export const HOUR_GRACE_MS = 60_000;
/** A NEAR AI pass stays shown on its window this long (a veto: as long as counters.vetoedUntil holds it out). */
export const VERDICT_SHOWN_MS = HOUR_MS;
/** An act refused before anything was sent is not tried again for the same target before this. */
export const RETRY_AFTER_MS = 15 * 60_000;
/**
 * An enter or rotate refused after the open paid for a refresh_prices (refreshForOpen) is not tried again for its
 * window before this: each try would pay again (a fresh price lives 5 minutes, a retry comes after 15).
 */
export const REFRESH_HOLD_MS = 6 * HOUR_MS;
/** At most this many refresh_prices an open of the loop sends per symbol per UTC day (the day's count is saved). */
export const MAX_OPEN_REFRESHES_PER_DAY = 12;
export const LOOP_STATE_VERSION = 1;

/** No NEAR AI here: checkVeto answers "no NEAR AI risk check: NEAR_AI_API_KEY is not set", a pass. */
export const NO_VETO_SOURCE: VetoSource = {
  model: 'none', configured: false,
  complete: async () => {
    throw new Error('no NEAR AI risk check source');
  },
};

/** What an open or a close did (serve-pair.ts HandsResult, as the journal needs it). */
export interface ActOutcome {
  ok: boolean;
  reason: string;
  /** Orders went out, or may have (false: refused before anything went out). */
  sent: boolean;
  tx: TxRef[];
  feeUsd: number;
  /** What the owner must reconcile, one line each. */
  open: string[];
  /** What filled, per leg (none when nothing was sent). */
  fills?: BookFill[];
  /**
   * An open only: the leg size the pair holds from it, the sum of its parts that went out and opened (canonical base
   * units). Less than the qty asked when a later part was stopped before it sent (the open's gate, a refusal).
   * Absent: as asked.
   */
  filledQty?: string;
  /** refresh_prices was sent for it (paid), whatever came of it. */
  refreshed?: boolean;
}

/** One leg's fills in an open or a close: summed size, size-weighted price, summed fee. */
export interface BookFill {
  venue: string;
  side: 'BUY' | 'SELL';
  /** Base units filled, canonical; "0" when nothing filled. */
  qty: string;
  avgPx: number | null;
  /** USD; null when a venue did not report a fill's fee. */
  feeUsd: number | null;
}

/** Margin moved between venues for an act (the loop moves none yet: always empty). */
export interface MarginMove {
  from: string;
  to: string;
  usd: number;
  feeUsd: number;
  tx: TxRef[];
}

/**
 * One carried-out enter or exit, for the position book (engine/src/book/). A rotation is an exit of
 * `rotation.fromId` then an enter of `rotation.toId`, both carrying `rotation`; a rotation whose open was refused
 * is the exit alone. `fill`: an open or close that did not end as asked but filled something (its fills and fees).
 */
export interface BookRecord {
  kind: 'enter' | 'exit' | 'fill';
  /** When the act began (before its first order): the hold starts here. */
  startedAt?: number;
  windowId: string;
  symbol: string;
  at: number;
  /** Both legs (long Phoenix, short Hyperliquid on mainnet), as filled. */
  legs: BookFill[];
  feeUsd: number;
  tx: TxRef[];
  /** The window's net APR at entry (the scanner's forecast); on an exit, the one it was entered at. */
  forecastNetAprPct: number | null;
  /** Why it was closed (exit only). */
  exitReason: string | null;
  rotation: { fromId: string; toId: string } | null;
  by: 'auto' | 'manual';
  marginMoves: MarginMove[];
}

/** Where carried-out acts go; default nothing. */
export type BookSink = (record: BookRecord) => void;

/** The pair the venues hold, as the loop needs it. */
export interface HandsHeld {
  symbol: string;
  /** Notional per leg of the held symbol's legs, USD. */
  legUsd: number;
  /** Open P&L of the held symbol's legs: price, funding and fees. */
  pnlUsd: number;
  /** Venue id -> the margin closing that leg frees: its margin plus its P&L (decide's freedMarginUsd). */
  freedMarginUsd?: Record<string, number>;
  /** Only one venue holds a position: that leg and its signed size; null when both legs are open. */
  oneLeg: { venue: string; qty: string } | null;
}

/** The loop's hands on the desk (serve: serve-pair.ts PairHands with the desk's numbers). */
export interface LoopHands {
  /** Why nothing can be opened or closed now (a rescue running, a close in flight, alert only), or null. */
  blocked(): string | null;
  /** The pair the desk holds; null when flat. */
  held(): HandsHeld | null;
  /** The policy symbol a window trades here, or why it cannot be traded here. */
  symbolOf(window: FundingWindow): { symbol: string } | { refused: string };
  /**
   * `qty`: the leg size decide() took, whole common lots; a maximum the open never exceeds. `noRefresh`: why the open
   * may not send refresh_prices (the day's MAX_OPEN_REFRESHES_PER_DAY of the symbol are used); it is refused instead.
   */
  open(request: { window: FundingWindow; symbol: string; legUsd: number; leverage: number; qty: string; reason: string; noRefresh?: string }): Promise<ActOutcome>;
  /**
   * A rotate's first step, before the held pair is closed (serve-pair.ts PairHands.prepareOpen): the target's stored
   * price refreshed when the open would need it, so a refresh that fails keeps the held pair. Absent: no such step.
   */
  prepareOpen?(request: { symbol: string; noRefresh?: string }): Promise<ActOutcome>;
  /** Both legs (or the one open) to flat, reduce-only. */
  close(request: { reason: string }): Promise<ActOutcome>;
  /**
   * The desk's record checked against the venues (serve-pair.ts reconcileWithVenues): a line when it was corrected
   * (a pair recorded while one leg or none is open), null when nothing changed.
   */
  reconcile?(): Promise<string | null>;
}

/** What decide() and the veto take that Window does not carry (serve-loop.ts: the scanner's carry, the venues' lots). */
export interface WindowFacts {
  gross14dAprPct?: Record<string, number | null>;
  lots?: DecideInput['lots'];
  /** Each leg's open interest, for the veto (null where not known). */
  openInterest?: Record<string, { longUsd: number | null; shortUsd: number | null }>;
}

/** What the loop entered, so a restart knows the window, since when and at what net. */
export interface LoopHeld {
  windowId: string;
  symbol: string;
  since: number;
  legUsd: number;
  entryNetAprPct: number;
}

export interface LoopFileState {
  version: number;
  counters: LoopCounters;
  held: LoopHeld | null;
  /** The refresh_prices the loop's opens sent on `day` (UTC, YYYY-MM-DD), per symbol; absent: none yet. */
  refreshes?: { day: string; bySymbol: Record<string, number> };
}

/** The loop's file, next to the trader state: one per mode, contract and desk. */
export function loopStateFile(dir: string, mode: Mode, contractId: string | null, deskId: string | null): string {
  const part = (v: string, what: string) => {
    if (!/^[a-z0-9._-]{1,64}$/.test(v)) throw new Error(`${what} ${JSON.stringify(v)} cannot name a state file`);
    return v;
  };
  const id = contractId === null || deskId === null ? '' : `-${part(contractId, 'contract')}-${part(deskId, 'desk')}`;
  return join(dir, `loop-${mode}${id}.json`);
}

export class LoopStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  /** The saved state; `problem` when the file exists but cannot be used (the state is then a cautious fresh one). */
  load(now: number): { state: LoopFileState; problem: string | null } {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: { version: LOOP_STATE_VERSION, counters: { ...NO_COUNTERS }, held: null }, problem: null };
      return { state: cautious(now), problem: `${this.path}: ${errorMessage(err)}` };
    }
    try {
      return { state: parseLoopState(JSON.parse(text)), problem: null };
    } catch (err) {
      return { state: cautious(now), problem: `${this.path}: ${errorMessage(err)}` };
    }
  }

  /** Atomic: a temporary file, fsynced, renamed over the old one, then the directory fsynced. Throws when it could not. */
  save(state: LoopFileState): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // the rename's error is the one to report
      }
      throw err;
    }
    // The rename itself survives a power cut once the directory is synced. Windows cannot open a directory for it.
    try {
      const d = openSync(dir, 'r');
      try {
        fsyncSync(d);
      } finally {
        closeSync(d);
      }
    } catch {
      // best effort
    }
  }
}

/** Counters started over after an unusable file: the cooldown and the day's rotations count as used. */
function cautious(now: number): LoopFileState {
  return {
    version: LOOP_STATE_VERSION, held: null,
    counters: { ...NO_COUNTERS, lastExitAt: now, rotationsAt: Array.from({ length: LOOP_RULES.maxRotationsPerDay }, () => now) },
  };
}

/** The saved state, checked; counter fields decide.ts adds later are kept as saved. */
export function parseLoopState(v: unknown): LoopFileState {
  const o = v as Record<string, unknown> | null;
  if (o === null || typeof o !== 'object') throw new Error('not an object');
  if (o.version !== LOOP_STATE_VERSION) throw new Error(`version ${JSON.stringify(o.version)}, not ${LOOP_STATE_VERSION}`);
  const c = o.counters as Record<string, unknown> | null;
  if (c === null || typeof c !== 'object') throw new Error('no counters');
  const record = (x: unknown, name: string, ok: (n: unknown) => boolean, what: string): Record<string, number> => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${name} is not an object`);
    for (const [k, n] of Object.entries(x)) if (!ok(n)) throw new Error(`${name}.${k} is not ${what}`);
    return { ...(x as Record<string, number>) };
  };
  const isCount = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
  const isTime = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const time = (x: unknown, name: string): number | null => {
    if (x === null) return null;
    if (!isTime(x)) throw new Error(`${name} is not a time`);
    return x as number;
  };
  if (!isCount(c.badChecks)) throw new Error('badChecks is not a count');
  if (!Array.isArray(c.rotationsAt)) throw new Error('rotationsAt is not a list');
  if (c.lastWaitReason !== null && typeof c.lastWaitReason !== 'string') throw new Error('lastWaitReason is not text');
  const counters: LoopCounters = {
    ...(c as object),
    aboveByWindow: record(c.aboveByWindow, 'aboveByWindow', isCount, 'a count'), badChecks: c.badChecks as number,
    betterByWindow: record(c.betterByWindow, 'betterByWindow', isCount, 'a count'),
    lastExitAt: time(c.lastExitAt, 'lastExitAt'), rotationsAt: c.rotationsAt.map((t, i) => time(t, `rotationsAt[${i}]`) ?? 0),
    lastHourlyAt: time(c.lastHourlyAt, 'lastHourlyAt'), lastWaitReason: c.lastWaitReason as string | null,
    vetoedUntil: c.vetoedUntil === undefined ? {} : record(c.vetoedUntil, 'vetoedUntil', isTime, 'a time'),
  };
  let held: LoopHeld | null = null;
  if (o.held !== null && o.held !== undefined) {
    const h = o.held as Record<string, unknown>;
    if (typeof h.windowId !== 'string' || typeof h.symbol !== 'string') throw new Error('held has no windowId or symbol');
    const n = (x: unknown, name: string): number => {
      if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`held.${name} is not a number`);
      return x;
    };
    held = { windowId: h.windowId, symbol: h.symbol, since: n(h.since, 'since'), legUsd: n(h.legUsd, 'legUsd'), entryNetAprPct: n(h.entryNetAprPct, 'entryNetAprPct') };
  }
  if (o.refreshes === undefined) return { version: LOOP_STATE_VERSION, counters, held };
  const r = o.refreshes as Record<string, unknown> | null;
  if (r === null || typeof r !== 'object' || typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day)) throw new Error('refreshes has no day');
  return { version: LOOP_STATE_VERSION, counters, held, refreshes: { day: r.day, bySymbol: record(r.bySymbol, 'refreshes.bySymbol', isCount, 'a count') } };
}

/** Whether two decisions say the same thing (the time aside). */
function sameDecision(a: StrategyDecision | null, b: StrategyDecision): boolean {
  return a !== null && a.action === b.action && a.reason === b.reason && a.windowId === b.windowId && a.heldId === b.heldId;
}

/** Why a window is not enterable, one line (the first failing check), or null. */
export function notEnterable(w: FundingWindow): string | null {
  if (isEnterable(w)) return null;
  if (!w.tradable) return `${w.id} is watch only`;
  if (w.refused !== undefined) return `${w.id} is refused: ${w.refused.code} ${w.refused.reason}`;
  if (w.stale) return `${w.id} is stale: a venue it needs did not answer`;
  if (w.veto?.verdict === 'veto') return `${w.id} was refused by the NEAR AI risk check: ${w.veto.reasons.join('; ')}`;
  const failed = w.checks.find((c) => !c.ok);
  return `${w.id} fails a check: ${failed?.text ?? 'unknown'}`;
}

/** A reason's category: its words without the numbers (a hold or wait journals when this changes). */
export function reasonCategory(reason: string): string {
  return reason.replace(/[-+$]?\d[\d.,]*\s*%?/g, '#');
}

export interface StrategyLoopOptions {
  /** GIMBAL_TRADE=1 (never with --once). */
  trade: boolean;
  strategy: () => StrategyConfig;
  policy: () => ContractPolicy | null;
  /** The last scan's windows (null: none yet). */
  windows: () => readonly FundingWindow[] | null;
  /** The hands, or null when this serve has none (testnet, replay, alert only), with why. */
  hands: LoopHands | null;
  handsWhy?: string;
  /** Free margin per venue now (decide's freeMarginUsd); a venue that cannot be read is left out. */
  freeMargin: () => Promise<Record<string, number>>;
  /** Whether a live rescue route covers a leg on each venue (decide's liveRescue: a route exists, not one running). */
  liveRescue: () => Record<string, boolean>;
  /** decide()'s 14-day gross and lots per window, and the legs' open interest for the veto; none = not known. */
  facts?: (windows: readonly FundingWindow[]) => Promise<WindowFacts>;
  /** Why nothing may be decided or sent now (a rescue or an ADL unwind running, a close in flight), or null. */
  busy: () => string | null;
  store: LoopStore;
  publish: (event: StreamEvent) => void;
  clock: Clock;
  log: (line: string) => void;
  decide?: (input: DecideInput) => Decision;
  /** NEAR AI (NearAiClient) or a recording (RecordedVeto); none = NO_VETO_SOURCE. */
  veto?: VetoSource;
  vetoTimeoutMs?: number;
  /** Every carried-out enter and exit (the position book); default none. */
  book?: BookSink;
}

type Task = () => Promise<void>;
/**
 * How an act ended: carried out; not carried out; refused by the NEAR AI risk check; or a rotate that closed the held pair and
 * opened nothing. `sent`: orders went out (or may have). `passing`: refused for a reason that passes (a rescue
 * running, a close in flight): tried again on the next check.
 */
interface ActEnd {
  end: 'done' | 'skipped' | 'vetoed' | 'flat';
  sent: boolean;
  passing: boolean;
  /** Refused after it paid for a refresh_prices (nothing of the open sent): why. The window is held REFRESH_HOLD_MS. */
  paidRefusal?: string;
}
const SKIPPED: ActEnd = { end: 'skipped', sent: false, passing: false };

export class StrategyLoop {
  readonly #o: StrategyLoopOptions;
  #state: LoopFileState;
  #decision: StrategyDecision | null = null;
  #queue: Promise<void> = Promise.resolve();
  /** A scan check is queued and has not started: another scan adds nothing. */
  #checkQueued = false;
  /** An act (or a manual rotate or close) runs. */
  #acting: string | null = null;
  /** A manual rotate or close was accepted and has not ended: auto acts wait for it. */
  #manual: string | null = null;
  #stopped = false;
  #seq = 0;
  /** Window id -> NEAR AI's last verdict, shown on the window until `until` (display only: the hold is vetoedUntil). */
  readonly #verdicts = new Map<string, { veto: Veto; until: number }>();
  /** `kind window` -> until when an act refused with nothing sent is not tried again, and the line journaled. */
  readonly #refused = new Map<string, { until: number; reason: string }>();
  #lastSkip: string | null = null;
  /** The category of the last `hold` journaled; the last action journaled `off`. */
  #lastHoldKey: string | null = null;
  #offJournaled = false;
  /** A single leg's close: the last line journaled (it is tried every check). */
  #oneLegLine: string | null = null;

  constructor(options: StrategyLoopOptions) {
    this.#o = options;
    const loaded = options.store.load(options.clock.now());
    this.#state = loaded.state;
    if (loaded.problem !== null) options.log(`strategy loop: state not usable, counters start over with the cooldown and the day's rotations taken as used: ${loaded.problem}`);
  }

  get counters(): LoopCounters {
    return this.#state.counters;
  }

  get held(): LoopHeld | null {
    return this.#state.held;
  }

  get decision(): StrategyDecision | null {
    return this.#decision;
  }

  /** The window the desk holds and since when, for the scanner (Window.held, switchCostUsd). */
  heldWindow(): { windowId: string; since: number } | null {
    const h = this.#state.held;
    return h === null ? null : { windowId: h.windowId, since: h.since };
  }

  /** The start line: what runs and why. */
  startLine(): string {
    const rules = `enter after ${LOOP_RULES.enterAfterChecks} hourly checks, exit after ${LOOP_RULES.exitAfterChecks}, cooldown ${LOOP_RULES.cooldownHours} h, time stop ${LOOP_RULES.maxHoldDays} d, at most ${LOOP_RULES.maxRotationsPerDay} rotations a day, a NEAR AI risk check refusal holds ${LOOP_RULES.vetoHoldHours} h`;
    const veto = this.#o.veto?.configured === true ? `NEAR AI risk check ${this.#o.veto.model} (${(this.#o.vetoTimeoutMs ?? LOOP_RULES.vetoTimeoutMs) / 1000} s)` : 'no NEAR AI risk check (NEAR_AI_API_KEY is not set: every window passes)';
    const hands = this.#o.hands === null ? `no hands (${this.#o.handsWhy ?? 'nothing can be opened or closed here'}): decisions are published, acts journaled as refused` : 'acts through the pair trader (pair-mainnet open / close)';
    return `strategy loop: ${this.#o.trade ? 'GIMBAL_TRADE=1' : 'GIMBAL_TRADE is not 1 (off)'}, auto ${this.#o.strategy().auto ? 'on' : 'off'}; ${hands}; ${veto}; ${rules}; state ${this.#o.store.path}`;
  }

  /** A scan ended (or the strategy changed): one check, the hourly one when due. Coalesced while one waits. */
  onScan(): void {
    if (this.#stopped || this.#checkQueued) return;
    this.#checkQueued = true;
    void this.#serial(async () => {
      this.#checkQueued = false;
      await this.#check();
    });
  }

  /** One check now, awaited (tests). */
  check(): Promise<void> {
    return this.#serial(() => this.#check());
  }

  /**
   * POST /rotate: refused at once with the reason, or started (progress in the journal). Needs auto on: with auto off
   * nothing new is opened. It is checked and sized again when it runs.
   */
  rotate(windowId: unknown): { ok: true } | { ok: false; reason: string } {
    if (typeof windowId !== 'string' || windowId.trim() === '') return { ok: false, reason: 'POST /rotate needs { "windowId": "<window id>" }' };
    const pre = this.#manualRefusal();
    if (pre !== null) return { ok: false, reason: pre };
    if (!this.#o.strategy().auto) return { ok: false, reason: 'auto is off: nothing new is opened (PUT /strategy auto=true first; POST /close works either way)' };
    const first = this.#rotateCheck(windowId, this.#lastFree, this.#lastFacts);
    if ('reason' in first) return { ok: false, reason: first.reason };
    this.#manual = `POST /rotate ${windowId}`;
    void this.#serial(async () => {
      this.#acting = this.#manual;
      try {
        if (this.#stopped) return;
        if (!this.#o.strategy().auto) {
          this.#journal('refused', `POST /rotate ${windowId} not carried out: auto was turned off before it ran`, { window: windowId, by: 'POST /rotate (manual)' });
          return;
        }
        // Checked and sized again on the numbers of the moment.
        const scanned = this.#o.windows() ?? [];
        const [free, facts] = await Promise.all([this.#readFree(), this.#readFacts(scanned)]);
        const again = this.#rotateCheck(windowId, free, facts);
        if ('reason' in again) {
          this.#journal('refused', `POST /rotate ${windowId} not carried out: ${again.reason}`, { window: windowId, by: 'POST /rotate (manual)' });
          return;
        }
        const fromId = this.#o.hands!.held() === null ? null : (this.#state.held?.windowId ?? 'the pair held');
        const r = await this.#enterOrRotate({ fromId, w: again.w, legUsd: again.legUsd, leverage: again.leverage, qty: again.qty, manual: true, facts });
        const now = this.#o.clock.now();
        if (r.end === 'done') this.#patchCounters({ badChecks: 0, betterByWindow: {}, ...(fromId === null ? {} : { rotationsAt: [...this.#state.counters.rotationsAt, now] }) });
        else if (r.end === 'flat') this.#patchCounters({ badChecks: 0, betterByWindow: {}, lastExitAt: now });
      } finally {
        this.#acting = null;
        this.#manual = null;
      }
    });
    return { ok: true };
  }

  /** POST /close: refused at once with the reason, or started. Works with auto on or off. */
  close(): { ok: true } | { ok: false; reason: string } {
    const pre = this.#manualRefusal();
    if (pre !== null) return { ok: false, reason: pre };
    if (this.#o.hands!.held() === null) return { ok: false, reason: 'no pair is held: nothing to close' };
    this.#manual = 'POST /close';
    void this.#serial(async () => {
      this.#acting = this.#manual;
      try {
        if (this.#stopped) return;
        const r = await this.#exit('POST /close (manual)', true);
        if (r.end === 'done') this.#patchCounters({ badChecks: 0, betterByWindow: {}, lastExitAt: this.#o.clock.now() });
      } finally {
        this.#acting = null;
        this.#manual = null;
      }
    });
    return { ok: true };
  }

  /** Resolves once nothing runs, or false after `timeoutMs` (serve's shutdown). */
  async idle(timeoutMs: number): Promise<boolean> {
    return Promise.race([this.#queue.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs).unref())]);
  }

  /** No new check or act starts after this (one running ends on its own). */
  stop(): void {
    this.#stopped = true;
  }

  // ---- state kept between checks for a manual rotate ----
  #lastFacts: WindowFacts = {};
  #lastFree: Record<string, number> = {};

  #manualRefusal(): string | null {
    if (this.#stopped) return 'serve is stopping';
    if (!this.#o.trade) return 'GIMBAL_TRADE is not 1: this engine trades nothing';
    if (this.#o.hands === null) return `no pair trader here: ${this.#o.handsWhy ?? 'nothing can be opened or closed'}`;
    const acting = this.#manual ?? this.#acting;
    if (acting !== null) return `the strategy loop is acting (${acting}): try again when it is done`;
    return this.#gate();
  }

  /** Why nothing may be sent this moment: a rescue or an ADL unwind running, a close in flight, the hands' own. */
  #gate(): string | null {
    return this.#o.busy() ?? this.#o.hands?.blocked() ?? null;
  }

  /** A manual rotate's window, checked and sized as decide() sizes an entry (a rotation frees the held legs' margin first). */
  #rotateCheck(windowId: string, free: Record<string, number>, facts: WindowFacts):
    { w: FundingWindow; legUsd: number; leverage: number; qty: string } | { reason: string } {
    const now = this.#o.clock.now();
    const w = (this.#o.windows() ?? []).find((x) => x.id === windowId);
    if (w === undefined) return { reason: `${windowId} is not in the last scan` };
    const hands = this.#o.hands!;
    const heldNow = hands.held();
    if (heldNow?.oneLeg != null) return { reason: `one leg is open (${heldNow.oneLeg.venue} ${heldNow.oneLeg.qty}): it is closed first` };
    if (this.#state.held?.windowId === windowId && heldNow !== null) return { reason: `${windowId} is the window held now` };
    const until = this.#state.counters.vetoedUntil[windowId];
    if (until !== undefined && now < until) return { reason: `${windowId} was refused by the NEAR AI risk check: held out until ${new Date(until).toISOString()}` };
    const not = notEnterable(w);
    if (not !== null) return { reason: not };
    const sym = hands.symbolOf(w);
    if ('refused' in sym) return { reason: sym.refused };
    const policy = this.#o.policy();
    const size = sizeFor(w, {
      strategy: this.#o.strategy(), maxNotionalUsd: policy?.max_notional_usd ?? 0, freeMarginUsd: free, liveRescue: this.#o.liveRescue(),
      ...(policy === null ? {} : { priceBandBps: policy.price_band_bps }), ...(facts.lots === undefined ? {} : { lots: facts.lots }),
    }, heldNow?.freedMarginUsd ?? {});
    if (!size.ok) return { reason: `${windowId} cannot be sized: ${size.why}` };
    return { w, legUsd: size.legUsd, leverage: size.leverage, qty: size.qty };
  }

  #serial(task: Task): Promise<void> {
    const next = this.#queue.then(task).catch((err: unknown) => {
      this.#log(`strategy loop: ${errorMessage(err)}`);
      this.#journal('error', `strategy loop: ${errorMessage(err)}`, {});
    });
    this.#queue = next;
    return next;
  }

  async #readFree(): Promise<Record<string, number>> {
    return this.#o.freeMargin().catch((err: unknown) => {
      this.#log(`strategy loop: free margin not read (${errorMessage(err)})`);
      return {};
    });
  }

  async #readFacts(windows: readonly FundingWindow[]): Promise<WindowFacts> {
    return (this.#o.facts?.(windows) ?? Promise.resolve<WindowFacts>({})).catch((err: unknown): WindowFacts => {
      this.#log(`strategy loop: window facts not read (${errorMessage(err)})`);
      return {};
    });
  }

  async #check(): Promise<void> {
    if (this.#stopped) return;
    const now = this.#o.clock.now();
    if (!this.#o.trade) {
      const reason = 'GIMBAL_TRADE is not 1: the engine watches, rescues and journals, and trades nothing';
      this.#publishDecision({ action: 'off', reason, windowId: null, heldId: this.#state.held?.windowId ?? null, at: now });
      this.#journalOff(reason);
      return;
    }
    const busy = this.#o.busy();
    if (busy !== null) {
      this.#skip(`strategy loop: no decision now, ${busy}`);
      return;
    }
    const scanned = this.#o.windows();
    if (scanned === null) {
      this.#skip('strategy loop: no scan yet, no decision');
      return;
    }
    this.#lastSkip = null;
    this.#republishVerdicts(scanned, now);
    const strategy = this.#o.strategy();
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    const last = this.#state.counters.lastHourlyAt;
    const hourly = now - hourStart >= HOUR_GRACE_MS && (last === null || last < hourStart);

    // The record against the venues first: a pair recorded while one leg or none is open is corrected (two reads).
    if (this.#o.hands?.reconcile !== undefined && this.#manual === null) {
      const fixed = await this.#o.hands.reconcile().catch((err: unknown) => {
        this.#log(`strategy loop: the record was not checked against the venues (${errorMessage(err)})`);
        return null;
      });
      if (fixed !== null) this.#journal('error', fixed, { action: 'reconcile' });
    }
    // A single leg is never held as a pair: it is closed, reduce-only, every check until flat.
    const venues = this.#o.hands?.held() ?? null;
    if (venues?.oneLeg != null && this.#manual === null) {
      await this.#closeOneLeg(venues.oneLeg, now);
      return;
    }
    const { held, freed } = this.#heldPair(scanned, now);
    const freeMarginUsd = await this.#readFree();
    const facts = await this.#readFacts(scanned);
    this.#lastFacts = facts;
    this.#lastFree = freeMarginUsd;
    const policy = this.#o.policy();
    const before = this.#state.counters;
    const input: DecideInput = {
      now, hourly, windows: scanned, held, strategy, maxNotionalUsd: policy?.max_notional_usd ?? 0, freeMarginUsd, liveRescue: this.#o.liveRescue(),
      counters: before, ...(policy === null ? {} : { priceBandBps: policy.price_band_bps }),
      ...(facts.gross14dAprPct === undefined ? {} : { gross14dAprPct: facts.gross14dAprPct }), ...(facts.lots === undefined ? {} : { lots: facts.lots }),
      ...(freed === undefined ? {} : { freedMarginUsd: freed }),
    };
    const d = (this.#o.decide ?? defaultDecide)(input);
    this.#journalDecision(input, d, before);
    this.#publishDecision(d.decision);
    if (d.act === null || !strategy.auto) {
      this.#saveCounters(d.counters);
      return;
    }
    // A manual rotate or close is queued: it goes first, this act waits for the next check.
    if (this.#manual !== null) {
      this.#saveCounters(skipAct(input, d));
      return;
    }
    // Until the act is done, the counters are those of an act not carried out.
    this.#saveCounters(skipAct(input, d));
    const r = await this.#act(d, scanned, facts);
    if (r.end === 'done') this.#saveCounters(d.counters);
    else if (r.end === 'vetoed') this.#saveCounters(skipAct(input, d, { vetoed: true }));
    else if (r.end === 'flat') this.#saveCounters({ ...skipAct(input, d), badChecks: 0, betterByWindow: {}, lastExitAt: this.#o.clock.now() });
  }

  /** The wait, hold and off lines: on a change of category, and one hold line per hourly check, with the numbers. */
  #journalDecision(input: DecideInput, d: Decision, before: LoopCounters): void {
    const a = d.decision.action;
    if (a !== 'off') this.#offJournaled = false;
    if (a !== 'hold') this.#lastHoldKey = null;
    if (a === 'off') {
      this.#journalOff(d.decision.reason);
      return;
    }
    if (a === 'wait' && journalWait(before, d)) {
      this.#journal('wait', d.decision.reason, { action: 'wait', hourly: input.hourly ? 1 : 0, ...this.#waitNumbers(input, d) });
      return;
    }
    if (a === 'hold' && input.held !== null) {
      const key = `${input.held.windowId} ${reasonCategory(d.decision.reason)}`;
      if (key === this.#lastHoldKey && !input.hourly) return;
      this.#lastHoldKey = key;
      const w = input.windows.find((x) => x.id === input.held!.windowId);
      this.#journal('wait', d.decision.reason, {
        action: 'hold', hourly: input.hourly ? 1 : 0, window: input.held.windowId,
        ...(w === undefined ? {} : { heldNetAprPct: round(heldForwardAprPct(w)) }),
        pnlUsd: round(input.held.pnlUsd), hoursHeld: round((input.now - input.held.since) / HOUR_MS),
        badChecks: d.counters.badChecks, exitAfterChecks: LOOP_RULES.exitAfterChecks,
      });
    }
  }

  /** A wait's numbers: the top window's net, the minimum, k/N checks and what blocks it. */
  #waitNumbers(input: DecideInput, d: Decision): Record<string, number | string> {
    const desk = input.windows.filter((w) => w.tradable);
    const top = (d.decision.windowId === null ? undefined : desk.find((w) => w.id === d.decision.windowId))
      ?? [...desk].sort((a, b) => b.netAprPct - a.netAprPct)[0];
    const out: Record<string, number | string> = { minNetAprPct: input.strategy.minNetAprPct };
    if (top === undefined) return { ...out, block: 'no desk window' };
    const until = d.counters.vetoedUntil[top.id];
    const block = top.refused?.code
      ?? (until !== undefined && input.now < until ? 'vetoed' : null)
      ?? (top.stale ? 'stale' : null)
      ?? (top.checks.some((c) => !c.ok) ? 'check' : null)
      ?? (top.netAprPct < input.strategy.minNetAprPct ? 'minimum' : null)
      ?? (d.counters.lastWaitReason ?? 'rules');
    return {
      ...out, window: top.id, netAprPct: round(top.netAprPct),
      checks: `${d.counters.aboveByWindow[top.id] ?? 0}/${LOOP_RULES.enterAfterChecks}`, block,
    };
  }

  #journalOff(reason: string): void {
    if (this.#offJournaled) return;
    this.#offJournaled = true;
    this.#journal('wait', reason, { action: 'off' });
  }

  async #act(d: Decision, windows: readonly FundingWindow[], facts: WindowFacts): Promise<ActEnd> {
    const act = d.act!;
    const target = act.kind === 'enter' ? act.windowId : act.kind === 'rotate' ? act.toId : (this.#state.held?.windowId ?? 'held');
    const key = `${act.kind} ${target}`;
    const now = this.#o.clock.now();
    if (this.#o.hands === null) {
      this.#refuse(key, `${key} not carried out: no pair trader here: ${this.#o.handsWhy ?? 'nothing can be opened or closed'}`, now);
      return SKIPPED;
    }
    const waiting = this.#refused.get(key);
    if (waiting !== undefined && now < waiting.until) return SKIPPED;
    this.#acting = key;
    try {
      let r: ActEnd;
      if (act.kind === 'exit') {
        r = await this.#exit(act.reason, false);
      } else {
        const w = windows.find((x) => x.id === target);
        if (w === undefined) {
          this.#refuseOnce(key, `${key} not carried out: the window is not in the last scan`);
          return SKIPPED;
        }
        r = await this.#enterOrRotate({
          fromId: act.kind === 'rotate' ? act.fromId : null, w, legUsd: act.legUsd, leverage: act.leverage, qty: act.qty,
          manual: false, reason: d.decision.reason, key, facts,
          hoursAbove: (act.kind === 'enter' ? d.counters.aboveByWindow[w.id] : d.counters.betterByWindow[w.id]) ?? 0,
        });
      }
      // Refused after a paid refresh_prices: the window is held for hours, whichever act comes for it next (a rotate
      // that ended flat comes back as an enter), so a refusal that repeats does not pay again every retry.
      if (r.paidRefusal !== undefined && act.kind !== 'exit') {
        const until = this.#o.clock.now() + REFRESH_HOLD_MS;
        const line = `${key} held until ${new Date(until).toISOString()}: refused after the open paid for refresh_prices (${r.paidRefusal}); not tried again for ${REFRESH_HOLD_MS / HOUR_MS} h, so a refusal that repeats does not pay again`;
        for (const k of [`enter ${target}`, `rotate ${target}`]) this.#refused.set(k, { until, reason: line });
        this.#journal('refused', line, { window: target, holdHours: REFRESH_HOLD_MS / HOUR_MS });
        return r;
      }
      // Not tried again for a while only when it was refused with nothing sent, for a reason that does not pass.
      if (r.end === 'done' || r.sent || r.passing || r.end === 'vetoed') this.#refused.delete(key);
      else this.#refused.set(key, { until: this.#o.clock.now() + RETRY_AFTER_MS, reason: this.#refused.get(key)?.reason ?? '' });
      return r;
    } finally {
      this.#acting = null;
    }
  }

  /** The veto, then (rotate) the close, then the open; the gate is checked right before each. */
  async #enterOrRotate(p: {
    fromId: string | null; w: FundingWindow; legUsd: number; leverage: number; qty: string; manual: boolean; reason?: string; key?: string;
    facts?: WindowFacts; hoursAbove?: number;
  }): Promise<ActEnd> {
    const hands = this.#o.hands!;
    const { w } = p;
    const kind = p.fromId === null ? 'enter' : 'rotate';
    const who = p.manual ? 'POST /rotate (manual)' : 'auto';
    const key = p.key ?? `${kind} ${w.id}`;
    const sym = hands.symbolOf(w);
    if ('refused' in sym) {
      this.#refuseOnce(key, `${kind} ${w.id} not carried out: ${sym.refused}`);
      return SKIPPED;
    }
    // NEAR AI first: it can only remove a window.
    const veto = await this.#veto(w, {
      kind, legUsd: p.legUsd, leverage: p.leverage, hoursAbove: p.hoursAbove ?? this.#state.counters.aboveByWindow[w.id] ?? 0, facts: p.facts ?? this.#lastFacts,
    });
    if (veto.veto.verdict === 'veto') return { end: 'vetoed', sent: false, passing: false };
    const base = {
      window: w.id, symbol: sym.symbol, legUsd: p.legUsd, leverage: p.leverage, qty: p.qty,
      netAprPct: round(w.netAprPct), grossAprPct: round(w.grossAprPct), veto: veto.line, by: who,
      ...(veto.exchange === null ? {} : vetoJournalNumbers(veto.exchange)),
    };
    if (p.fromId !== null) {
      const gate = this.#gate();
      if (gate !== null) {
        this.#refuseOnce(key, `rotate ${p.fromId} -> ${w.id} not carried out: ${gate}`);
        return { ...SKIPPED, passing: true };
      }
      // The target's stored price before the held pair is closed: a refresh that fails keeps the pair held, where
      // the open after the close would leave the desk flat.
      if (hands.prepareOpen !== undefined) {
        const ready = await hands.prepareOpen({ symbol: sym.symbol, ...this.#refreshAllowance(sym.symbol) });
        if (ready.refreshed === true) this.#countRefresh(sym.symbol);
        if (!ready.ok) {
          this.#journal('refused', `rotate ${p.fromId} -> ${w.id} not carried out: ${ready.reason}; ${p.fromId} is kept, nothing closed`, { ...base, from: p.fromId });
          return { ...SKIPPED, passing: this.#gate() !== null, ...(ready.refreshed === true ? { paidRefusal: ready.reason } : {}) };
        }
      }
      const closeAt = this.#o.clock.now();
      const closed = await hands.close({ reason: `strategy: rotate out of ${p.fromId} into ${w.id} (${who})` });
      this.#owner(closed.open);
      if (!closed.ok) {
        this.#record('fill', { windowId: p.fromId, symbol: this.#state.held?.symbol ?? '', outcome: closed, forecastNetAprPct: null, exitReason: closed.reason, rotation: null, manual: p.manual, startedAt: closeAt });
        this.#journal(closed.sent ? 'error' : 'refused', `rotate ${p.fromId} -> ${w.id}: the close of ${p.fromId} ${closed.sent ? 'did not end flat' : 'was refused'}: ${closed.reason}; nothing opened`, { ...base, from: p.fromId, feeUsd: closed.feeUsd }, closed.tx);
        return { end: 'skipped', sent: closed.sent, passing: false };
      }
      const fromHeld = this.#state.held;
      this.#record('exit', { windowId: p.fromId, symbol: fromHeld?.symbol ?? '', outcome: closed, forecastNetAprPct: fromHeld?.entryNetAprPct ?? null, exitReason: `rotate into ${w.id}`, rotation: { fromId: p.fromId, toId: w.id }, manual: p.manual, startedAt: closeAt });
      this.#setHeld(null);
      this.#journal('exit', `rotate: ${p.fromId} closed (${who})${fromHeld === null ? '' : `, held since ${new Date(fromHeld.since).toISOString()}`}; ${closed.reason}`, { window: p.fromId, feeUsd: closed.feeUsd, by: who, stage: 'rotate' }, closed.tx);
    }
    const flat = p.fromId === null ? '' : `; ${p.fromId} was closed, so the desk stays flat`;
    const gate = this.#gate();
    if (gate !== null) {
      this.#journal('refused', `${kind} ${w.id} not carried out: ${gate}${flat}`, base);
      return p.fromId === null ? { ...SKIPPED, passing: true } : { end: 'flat', sent: true, passing: true };
    }
    const openAt = this.#o.clock.now();
    const opened = await hands.open({
      window: w, symbol: sym.symbol, legUsd: p.legUsd, leverage: p.leverage, qty: p.qty, reason: `strategy: ${kind} ${w.id} (${who})`, ...this.#refreshAllowance(sym.symbol),
    });
    if (opened.refreshed === true) this.#countRefresh(sym.symbol);
    this.#owner(opened.open);
    const now = this.#o.clock.now();
    if (!opened.ok) {
      const after = hands.held();
      if (opened.sent && after !== null) {
        // Orders went out and the venues hold a position: the desk holds it, the book sees the entry.
        this.#setHeld({ windowId: w.id, symbol: sym.symbol, since: now, legUsd: after.legUsd, entryNetAprPct: w.netAprPct });
        this.#record('enter', { windowId: w.id, symbol: sym.symbol, outcome: opened, forecastNetAprPct: w.netAprPct, exitReason: null, rotation: p.fromId === null ? null : { fromId: p.fromId, toId: w.id }, manual: p.manual, startedAt: openAt });
        this.#journal('error', `${kind} ${w.id}: ${opened.reason}; the venues hold ${after.symbol} (${round(after.legUsd)} USD a leg${after.oneLeg === null ? '' : `, one leg only: ${after.oneLeg.venue} ${after.oneLeg.qty}`}): held from now`, { ...base, heldLegUsd: round(after.legUsd), feeUsd: opened.feeUsd }, opened.tx);
        return { end: 'done', sent: true, passing: false };
      }
      this.#record('fill', { windowId: w.id, symbol: sym.symbol, outcome: opened, forecastNetAprPct: null, exitReason: opened.reason, rotation: null, manual: p.manual, startedAt: openAt });
      this.#journal(opened.sent ? 'error' : 'refused', `${kind} ${w.id}: ${opened.reason}${flat}`, { ...base, feeUsd: opened.feeUsd }, opened.tx);
      // Stopped by the open's own gate (a rescue that started after the check before it): tried again next check.
      const passing = this.#gate() !== null;
      const paid = opened.refreshed === true && !opened.sent ? { paidRefusal: opened.reason } : {};
      return p.fromId === null ? { end: 'skipped', sent: opened.sent, passing, ...paid } : { end: 'flat', sent: true, passing, ...paid };
    }
    // Held from now: an entry's time, or the rotation's. What filled, not what was asked: a later part its gate
    // stopped holds nothing.
    const filled = filledLeg(p, opened.filledQty);
    this.#setHeld({ windowId: w.id, symbol: sym.symbol, since: now, legUsd: filled.usd, entryNetAprPct: w.netAprPct });
    this.#record('enter', { windowId: w.id, symbol: sym.symbol, outcome: opened, forecastNetAprPct: w.netAprPct, exitReason: null, rotation: p.fromId === null ? null : { fromId: p.fromId, toId: w.id }, manual: p.manual, startedAt: openAt });
    const size = filled.partial
      ? `${filled.qty} ${sym.symbol} (${round(filled.usd)} USD) a leg filled of the ${p.qty} (${p.legUsd} USD) asked`
      : `at most ${p.qty} ${sym.symbol} (${p.legUsd} USD) a leg`;
    const sizeNumbers: Record<string, number | string> = filled.partial ? { legUsd: round(filled.usd), qty: filled.qty, usd: round(filled.usd), askedLegUsd: p.legUsd, askedQty: p.qty } : { usd: p.legUsd };
    this.#journal(kind, `${kind === 'rotate' ? `rotate ${p.fromId} -> ${w.id}` : `enter ${w.id}`}, ${sym.symbol} short hyperliquid, long phoenix, ${size} at ${p.leverage}x, ${round(w.netAprPct)} % net (${who})${p.reason === undefined ? '' : `: ${p.reason}`}; ${opened.reason}`,
      { ...base, ...sizeNumbers, feeUsd: opened.feeUsd, ...(p.fromId === null ? {} : { from: p.fromId }) }, opened.tx);
    return { end: 'done', sent: true, passing: false };
  }

  /** Both legs closed reduce-only. */
  async #exit(reason: string, manual: boolean): Promise<ActEnd> {
    const hands = this.#o.hands!;
    const held = this.#state.held;
    const id = held?.windowId ?? hands.held()?.symbol ?? 'the pair';
    const who = manual ? 'POST /close (manual)' : 'auto';
    const gate = this.#gate();
    if (gate !== null) {
      this.#refuseOnce(`exit ${id}`, `exit ${id} not carried out: ${gate}`);
      return { ...SKIPPED, passing: true };
    }
    const pnl = hands.held()?.pnlUsd;
    const closeAt = this.#o.clock.now();
    const r = await hands.close({ reason: `strategy: exit ${id} (${who}): ${reason}` });
    this.#owner(r.open);
    if (!r.ok) {
      this.#record('fill', { windowId: id, symbol: held?.symbol ?? '', outcome: r, forecastNetAprPct: null, exitReason: r.reason, rotation: null, manual, startedAt: closeAt });
      this.#journal(r.sent ? 'error' : 'refused', `exit ${id}: ${r.reason}`, { window: id, by: who, feeUsd: r.feeUsd }, r.tx);
      return { end: 'skipped', sent: r.sent, passing: false };
    }
    this.#record('exit', { windowId: id, symbol: held?.symbol ?? '', outcome: r, forecastNetAprPct: held?.entryNetAprPct ?? null, exitReason: reason, rotation: null, manual, startedAt: closeAt });
    this.#setHeld(null);
    this.#journal('exit', `exit ${id}: ${reason}; ${r.reason} (${who})`, { window: id, by: who, feeUsd: r.feeUsd, ...(pnl === undefined ? {} : { pnlUsd: round(pnl) }) }, r.tx);
    return { end: 'done', sent: true, passing: false };
  }

  /** One venue holds a position, the other none: closed at once, reduce-only, tried every check until flat. */
  async #closeOneLeg(leg: { venue: string; qty: string }, now: number): Promise<void> {
    const line = `one leg open: ${leg.venue} ${leg.qty}`;
    this.#publishDecision({ action: 'exit', reason: `${line}: closing it, reduce-only`, windowId: null, heldId: this.#state.held?.windowId ?? null, at: now });
    const say = (kind: JournalEntry['kind'], summary: string, numbers: Record<string, number | string>, tx: TxRef[] = []) => {
      if (summary === this.#oneLegLine) return;
      this.#oneLegLine = summary;
      this.#journal(kind, summary, numbers, tx);
    };
    const gate = this.#gate();
    if (gate !== null) {
      say('error', `${line}: not closed this check, ${gate}`, { venue: leg.venue, qty: leg.qty });
      return;
    }
    const closeAt = this.#o.clock.now();
    const r = await this.#o.hands!.close({ reason: `strategy: ${line}, closed reduce-only` });
    this.#owner(r.open);
    if (!r.ok) {
      this.#record('fill', { windowId: this.#state.held?.windowId ?? `${leg.venue} leg`, symbol: this.#state.held?.symbol ?? '', outcome: r, forecastNetAprPct: null, exitReason: r.reason, rotation: null, manual: false, startedAt: closeAt });
      say('error', `${line}: the close did not end flat: ${r.reason}`, { venue: leg.venue, qty: leg.qty, feeUsd: r.feeUsd }, r.tx);
      return;
    }
    const held = this.#state.held;
    this.#record('exit', { windowId: held?.windowId ?? `${leg.venue} leg`, symbol: held?.symbol ?? '', outcome: r, forecastNetAprPct: held?.entryNetAprPct ?? null, exitReason: line, rotation: null, manual: false, startedAt: closeAt });
    this.#setHeld(null);
    this.#patchCounters({ badChecks: 0, betterByWindow: {}, lastExitAt: this.#o.clock.now() });
    this.#oneLegLine = null;
    this.#journal('exit', `${line}: closed reduce-only; ${r.reason}`, { venue: leg.venue, qty: leg.qty, feeUsd: r.feeUsd }, r.tx);
  }

  /** NEAR AI's verdict (veto.ts checkVeto), shown on the window; a veto is journaled (decide's vetoedUntil holds it out). */
  async #veto(w: FundingWindow, p: { kind: 'enter' | 'rotate'; legUsd: number; leverage: number; hoursAbove: number; facts: WindowFacts }): Promise<VetoResult> {
    const now = this.#o.clock.now();
    const oi = p.facts.openInterest?.[w.id];
    const legs: { long: Partial<Pick<VetoLeg, 'openInterestUsd'>>; short: Partial<Pick<VetoLeg, 'openInterestUsd'>> } = {
      long: { openInterestUsd: oi?.longUsd ?? null }, short: { openInterestUsd: oi?.shortUsd ?? null },
    };
    // Book depth, the 24 h move and the listing age are not known here: null, never invented.
    const facts = vetoFacts(w, {
      kind: p.kind, legUsd: p.legUsd, leverage: p.leverage, minNetAprPct: this.#o.strategy().minNetAprPct, hoursAbove: p.hoursAbove,
      grossApr14dPct: p.facts.gross14dAprPct?.[w.id] ?? null, legs,
    });
    const result = await checkVeto(this.#o.veto ?? NO_VETO_SOURCE, facts, { now, timeoutMs: this.#o.vetoTimeoutMs ?? LOOP_RULES.vetoTimeoutMs });
    const shown = result.veto.verdict === 'veto' ? LOOP_RULES.vetoHoldHours * HOUR_MS : VERDICT_SHOWN_MS;
    this.#verdicts.set(w.id, { veto: result.veto, until: now + shown });
    const scanned = this.#o.windows();
    if (scanned !== null) this.#republishVerdicts(scanned, now);
    if (result.veto.verdict === 'veto') {
      this.#journal('veto', `${w.id}: ${result.line}; not entered, held out for ${LOOP_RULES.vetoHoldHours} h`, {
        window: w.id, model: result.veto.model, ...(result.exchange === null ? {} : vetoJournalNumbers(result.exchange)),
      });
    }
    return result;
  }

  /** A `windows` event with NEAR AI's verdicts shown on their windows, when the last scan's do not carry them. */
  #republishVerdicts(scanned: readonly FundingWindow[], now: number): void {
    for (const [id, v] of this.#verdicts) if (now >= v.until) this.#verdicts.delete(id);
    if (this.#verdicts.size === 0) return;
    const shown = scanned.map((w) => {
      const v = this.#verdicts.get(w.id);
      return v === undefined ? w : { ...w, veto: v.veto };
    });
    if (scanned.some((w, i) => w.veto?.at !== shown[i]!.veto?.at)) this.#o.publish({ type: 'windows', data: shown });
  }

  /**
   * The pair the desk holds, as decide() takes it, and the margin closing it frees: the loop's record when it names
   * the symbol the venues hold; otherwise (a pair opened by hand, or a record lost) the desk window of that symbol,
   * held from now, which is an assumption the journal states (no venue gives a position's open time).
   */
  #heldPair(windows: readonly FundingWindow[], now: number): { held: HeldPair | null; freed?: Record<string, number> } {
    const hands = this.#o.hands;
    const venues = hands?.held() ?? null;
    const record = this.#state.held;
    if (venues === null) {
      if (record !== null && hands !== null) {
        // Closed outside the loop (panic_close, a rescue, by hand): the cooldown starts as after an exit.
        this.#log(`strategy loop: ${record.windowId} is no longer held (closed outside the loop)`);
        this.#setHeld(null);
        this.#patchCounters({ badChecks: 0, betterByWindow: {}, lastExitAt: now });
      }
      return { held: null };
    }
    const freed = venues.freedMarginUsd === undefined ? {} : { freed: venues.freedMarginUsd };
    if (record !== null && record.symbol === venues.symbol) {
      return {
        held: { windowId: record.windowId, symbol: record.symbol, since: record.since, legUsd: venues.legUsd > 0 ? venues.legUsd : record.legUsd, entryNetAprPct: record.entryNetAprPct, pnlUsd: venues.pnlUsd },
        ...freed,
      };
    }
    const w = windows.find((x) => x.longVenue === 'phoenix' && x.shortVenue === 'hyperliquid' && symbolIs(hands!.symbolOf(x), venues.symbol));
    const adopted: LoopHeld = {
      windowId: w?.id ?? `${venues.symbol}-phoenix-hyperliquid`.toLowerCase(), symbol: venues.symbol, since: now, legUsd: venues.legUsd,
      entryNetAprPct: w?.netAprPct ?? 0,
    };
    this.#setHeld(adopted);
    this.#patchCounters({ badChecks: 0, betterByWindow: {} });
    this.#journal('wait', `held: ${venues.symbol} adopted as ${adopted.windowId} (opened outside the loop, or its record lost); held since now is an assumption: no venue gives the position's open time, so the time stop counts from here`, {
      action: 'adopt', window: adopted.windowId, legUsd: round(venues.legUsd), entryNetAprPct: round(adopted.entryNetAprPct),
    });
    return { held: { ...adopted, pnlUsd: venues.pnlUsd }, ...freed };
  }

  /** A carried-out enter or exit, to the book. Its failure is logged, never the act's. */
  #record(kind: 'enter' | 'exit' | 'fill', p: {
    windowId: string; symbol: string; outcome: ActOutcome; forecastNetAprPct: number | null; exitReason: string | null;
    rotation: { fromId: string; toId: string } | null; manual: boolean; startedAt: number;
  }): void {
    if (this.#o.book === undefined) return;
    if (kind === 'fill' && (p.outcome.fills ?? []).length === 0) return;
    try {
      this.#o.book({
        kind, windowId: p.windowId, symbol: p.symbol, at: this.#o.clock.now(), startedAt: p.startedAt, legs: p.outcome.fills ?? [], feeUsd: p.outcome.feeUsd, tx: p.outcome.tx,
        forecastNetAprPct: p.forecastNetAprPct, exitReason: p.exitReason, rotation: p.rotation, by: p.manual ? 'manual' : 'auto', marginMoves: [],
      });
    } catch (err) {
      this.#log(`strategy loop: the book did not take the ${kind} of ${p.windowId} (${errorMessage(err)})`);
    }
  }

  /** The UTC day of `t`, as LoopFileState.refreshes keeps it. */
  #day(t: number): string {
    return new Date(t).toISOString().slice(0, 10);
  }

  /** What an open of `symbol` may spend on refresh_prices today: noRefresh once MAX_OPEN_REFRESHES_PER_DAY are used. */
  #refreshAllowance(symbol: string): { noRefresh?: string } {
    const day = this.#day(this.#o.clock.now());
    const r = this.#state.refreshes;
    const used = r?.day === day ? (r.bySymbol[symbol] ?? 0) : 0;
    if (used < MAX_OPEN_REFRESHES_PER_DAY) return {};
    return { noRefresh: `the strategy loop's ${MAX_OPEN_REFRESHES_PER_DAY} refresh_prices of ${symbol} for ${day} (UTC) are used; the next may go after 00:00 UTC` };
  }

  /** One refresh_prices an open of `symbol` paid for, counted in the saved state; journaled when the day's cap is hit. */
  #countRefresh(symbol: string): void {
    const day = this.#day(this.#o.clock.now());
    const r = this.#state.refreshes;
    const bySymbol = r?.day === day ? { ...r.bySymbol } : {};
    const used = (bySymbol[symbol] ?? 0) + 1;
    bySymbol[symbol] = used;
    this.#state = { ...this.#state, refreshes: { day, bySymbol } };
    this.#save();
    if (used === MAX_OPEN_REFRESHES_PER_DAY) {
      this.#journal('refused', `refresh_prices cap: the strategy loop's opens sent ${used} refresh_prices of ${symbol} on ${day} (UTC), the most a day; no open of ${symbol} that needs one is sent before 00:00 UTC`, { symbol, refreshes: used });
    }
  }

  #setHeld(held: LoopHeld | null): void {
    this.#state = { ...this.#state, held };
    this.#save();
  }

  #saveCounters(counters: LoopCounters): void {
    this.#state = { ...this.#state, counters };
    this.#save();
  }

  #patchCounters(patch: Partial<LoopCounters>): void {
    this.#saveCounters({ ...this.#state.counters, ...patch });
  }

  #save(): void {
    try {
      this.#o.store.save(this.#state);
    } catch (err) {
      this.#log(`strategy loop: state not saved (${errorMessage(err)})`);
    }
  }

  #publishDecision(d: StrategyDecision): void {
    if (sameDecision(this.#decision, d)) return;
    this.#decision = d;
    this.#log(`decision  ${d.action}: ${d.reason}`);
    this.#o.publish({ type: 'decision', data: d });
  }

  #refuse(key: string, line: string, now: number): void {
    this.#refuseOnce(key, line);
    this.#refused.set(key, { until: now + RETRY_AFTER_MS, reason: line });
  }

  /** A refusal journaled once per reason (the same act refused again on the next check says nothing new). */
  #refuseOnce(key: string, line: string): void {
    const last = this.#refused.get(key);
    if (last !== undefined && last.reason === line) return;
    this.#refused.set(key, { until: last?.until ?? 0, reason: line });
    this.#journal('refused', line, {});
  }

  #skip(line: string): void {
    if (line === this.#lastSkip) return;
    this.#lastSkip = line;
    this.#log(line);
  }

  #owner(lines: readonly string[]): void {
    for (const line of lines) this.#journal('error', `owner: ${line}`, { stage: 'strategy' });
  }

  #journal(kind: JournalEntry['kind'], summary: string, numbers: Record<string, number | string>, tx: TxRef[] = []): void {
    const t = this.#o.clock.now();
    this.#log(`journal   ${kind}: ${summary}`);
    this.#o.publish({ type: 'journal', data: { id: `loop-${t.toString(36)}-${++this.#seq}`, t, kind, summary, numbers, tx } });
  }

  #log(line: string): void {
    this.#o.log(line);
  }
}

function symbolIs(s: { symbol: string } | { refused: string }, symbol: string): boolean {
  return 'symbol' in s && s.symbol === symbol;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * The leg an open filled: ActOutcome.filledQty, and its USD at the price the asked size was valued at (the asked USD
 * pro rata); as asked when the hands did not say, or filled all of it.
 */
export function filledLeg(asked: { legUsd: number; qty: string }, filledQty: string | undefined): { qty: string; usd: number; partial: boolean } {
  const want = Number(asked.qty);
  const got = filledQty === undefined ? want : Number(filledQty);
  if (filledQty === undefined || !Number.isFinite(got) || !(want > 0) || got === want) return { qty: asked.qty, usd: asked.legUsd, partial: false };
  return { qty: filledQty, usd: asked.legUsd * (got / want), partial: true };
}
