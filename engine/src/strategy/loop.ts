// The strategy loop (docs/interfaces.md §3 "Strategy loop"): serve runs decide() (decide.ts) and carries its `act` out.
//
// When: after each funding payment (the hourly check: the first scan once HOUR_GRACE_MS have passed after the top of
// the hour, when Hyperliquid pays; decide.ts moves its counts only on it) and on every scan event (hourly false).
// Only with GIMBAL_TRADE=1: otherwise it publishes the decision `off` and decides nothing. With auto off decide() still
// runs (its counts move, so turning auto on does not wait out the hours again) and answers `off`; nothing is carried
// out. One decision at a time: checks, acts and the manual POST /rotate and /close run one after another; never while
// a rescue or an ADL unwind is running (that check is skipped, an hourly one is taken at the next scan).
//
// What decide() is fed: the last scan's windows (a window NEAR AI judged in the last hour carries that verdict, so a
// vetoed one is not enterable), the held pair (the loop's own record of what it entered, or the pair serve adopted
// from the venues, matched to its desk window) with the margin a rotation would free, free margin per venue,
// liveRescue per venue (a route exists), the policy's max_notional_usd and price_band_bps, each window's 14-day
// gross and lots (`facts`), and the saved LoopCounters.
//
// How an act is carried out (the hands: serve-pair.ts, pair-mainnet's own code in pair-ops.ts): enter = open the
// exact quantity decide() sized; exit = close both legs reduce-only; rotate = close the held pair, then open the new
// one, and when the open is refused the desk stays flat and the journal says so. Before an enter or a rotate the
// window goes to the NEAR AI veto (veto.ts checkVeto); its verdict is attached to the window (Window.veto, republished
// so the web shows it) for VETO_HOLD_MS, a veto writes a `veto` entry and nothing is signed. An act the hands refuse is
// journaled once (`refused`) and not tried again for RETRY_AFTER_MS. When the veto refuses or the act is not carried
// out, skipAct()'s counters are saved instead of the decision's.
//
// Published: `decision` whenever it changes (action, reason, window or held; not the time); journal `enter`, `exit`,
// `rotate`, `veto`, `refused`, `error` with numbers and tx links, and `wait` only when journalWait() says its reason
// changed. Counters are saved after every check.
//
// On disk: the counters and the held record next to the trader state (GIMBAL_STATE_DIR), one JSON file per mode,
// contract and desk, written atomically (temporary file, fsync, rename) after every change. A missing file starts from
// NO_COUNTERS; an unusable one too, but with the cooldown and the day's rotations taken as used, and says so.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContractPolicy, JournalEntry, Mode, StrategyConfig, StrategyDecision, StreamEvent, TxRef, Window as FundingWindow } from '@gimbal/shared';
import { isEnterable } from '../scanner/price.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';
import type { DecideInput, Decision, HeldPair, LoopCounters } from './decide.ts';
import { LOOP_RULES, NO_COUNTERS, decide as defaultDecide, journalWait, sizeFor, skipAct } from './decide.ts';
import type { Veto, VetoLeg, VetoResult, VetoSource } from './veto.ts';
import { checkVeto, vetoFacts, vetoJournalNumbers } from './veto.ts';

const HOUR_MS = 3_600_000;
/** Hyperliquid pays funding at the top of the hour: the hourly check is the first scan this long after it. */
export const HOUR_GRACE_MS = 60_000;
/** A NEAR AI verdict stays on its window this long (a veto keeps it out of decide()'s entries). */
export const VETO_HOLD_MS = HOUR_MS;
/** An act the hands refused is not tried again for the same target before this. */
export const RETRY_AFTER_MS = 15 * 60_000;
export const LOOP_STATE_VERSION = 1;

/** No NEAR AI here: checkVeto answers "no veto check: NEAR_AI_API_KEY is not set", a pass. */
export const NO_VETO_SOURCE: VetoSource = {
  model: 'none', configured: false,
  complete: async () => {
    throw new Error('no veto source');
  },
};

/** What an open or a close did (serve-pair.ts HandsResult, as the journal needs it). */
export interface ActOutcome {
  ok: boolean;
  reason: string;
  /** Something was signed (false: refused before anything went out). */
  sent: boolean;
  tx: TxRef[];
  feeUsd: number;
  /** What the owner must reconcile, one line each. */
  open: string[];
  /** What filled, per leg (none when nothing was sent). */
  fills?: BookFill[];
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
 * One carried-out enter or exit, for the position book (engine/src/book/, built later). A rotation is an exit of
 * `rotation.fromId` then an enter of `rotation.toId`, both carrying `rotation`; a rotation whose open was refused
 * is the exit alone.
 */
export interface BookRecord {
  kind: 'enter' | 'exit';
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
  legUsd: number;
  pnlUsd: number;
  /** Venue id -> the margin closing that leg frees: its margin plus its P&L (decide's freedMarginUsd). */
  freedMarginUsd?: Record<string, number>;
}

/** The loop's hands on the desk (serve: serve-pair.ts PairHands with the desk's numbers). */
export interface LoopHands {
  /** Why nothing can be opened or closed now, or null. */
  blocked(): string | null;
  /** The pair the desk holds; null when flat. */
  held(): HandsHeld | null;
  /** The policy symbol a window trades here, or why it cannot be traded here. */
  symbolOf(window: FundingWindow): { symbol: string } | { refused: string };
  /** `qty`: the leg size exactly, whole common lots, when decide() sized it. */
  open(request: { window: FundingWindow; symbol: string; legUsd: number; leverage: number; qty?: string; reason: string }): Promise<ActOutcome>;
  close(request: { reason: string }): Promise<ActOutcome>;
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

  /** Atomic: a temporary file, fsynced, renamed over the old one. Throws when it could not. */
  save(state: LoopFileState): void {
    mkdirSync(dirname(this.path), { recursive: true });
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
  }
}

/** Counters started over after an unusable file: the cooldown and the day's rotations count as used. */
function cautious(now: number): LoopFileState {
  return {
    version: LOOP_STATE_VERSION, held: null,
    counters: { ...NO_COUNTERS, lastExitAt: now, rotationsAt: Array.from({ length: LOOP_RULES.maxRotationsPerDay }, () => now) },
  };
}

/**
 * The saved state, checked. The counters' known fields are checked; fields decide.ts adds later (it owns
 * LoopCounters) are kept as saved.
 */
export function parseLoopState(v: unknown): LoopFileState {
  const o = v as Record<string, unknown> | null;
  if (o === null || typeof o !== 'object') throw new Error('not an object');
  if (o.version !== LOOP_STATE_VERSION) throw new Error(`version ${JSON.stringify(o.version)}, not ${LOOP_STATE_VERSION}`);
  const c = o.counters as Record<string, unknown> | null;
  if (c === null || typeof c !== 'object') throw new Error('no counters');
  const counts = (x: unknown, name: string): Record<string, number> => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${name} is not an object`);
    for (const [k, n] of Object.entries(x)) if (!Number.isInteger(n) || (n as number) < 0) throw new Error(`${name}.${k} is not a count`);
    return { ...(x as Record<string, number>) };
  };
  const time = (x: unknown, name: string): number | null => {
    if (x === null) return null;
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${name} is not a time`);
    return x;
  };
  if (!Number.isInteger(c.badChecks) || (c.badChecks as number) < 0) throw new Error('badChecks is not a count');
  if (!Array.isArray(c.rotationsAt)) throw new Error('rotationsAt is not a list');
  if (c.lastWaitReason !== null && typeof c.lastWaitReason !== 'string') throw new Error('lastWaitReason is not text');
  const counters: LoopCounters = {
    ...(c as object),
    aboveByWindow: counts(c.aboveByWindow, 'aboveByWindow'), badChecks: c.badChecks as number, betterByWindow: counts(c.betterByWindow, 'betterByWindow'),
    lastExitAt: time(c.lastExitAt, 'lastExitAt'), rotationsAt: c.rotationsAt.map((t, i) => time(t, `rotationsAt[${i}]`) ?? 0),
    lastHourlyAt: time(c.lastHourlyAt, 'lastHourlyAt'), lastWaitReason: c.lastWaitReason as string | null,
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
  return { version: LOOP_STATE_VERSION, counters, held };
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
  if (w.veto?.verdict === 'veto') return `${w.id} was vetoed by NEAR AI: ${w.veto.reasons.join('; ')}`;
  const failed = w.checks.find((c) => !c.ok);
  return `${w.id} fails a check: ${failed?.text ?? 'unknown'}`;
}

/** decide.ts's skipAct, telling it the veto refused (it then remembers not to ask again every scan). */
const skipActAs = skipAct as (input: DecideInput, d: Decision, how?: { vetoed?: boolean }) => LoopCounters;

/** The exact quantity decide() sized an enter or a rotate at (whole common lots), when it says one. */
function actQty(act: Decision['act'] | { qty?: unknown }): string | undefined {
  const q = (act as { qty?: unknown } | null)?.qty;
  return typeof q === 'string' && q !== '' ? q : undefined;
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
  /** Why no decision may run now (a rescue or an ADL unwind is running, a close is in flight), or null. */
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
 * How an act ended: carried out; not carried out (refused, failed, not tried again yet); vetoed by NEAR AI; or a
 * rotate that closed the held pair and opened nothing.
 */
type ActEnd = 'done' | 'skipped' | 'vetoed' | 'flat';

export class StrategyLoop {
  readonly #o: StrategyLoopOptions;
  #state: LoopFileState;
  #decision: StrategyDecision | null = null;
  #queue: Promise<void> = Promise.resolve();
  /** A scan check is queued and has not started: another scan adds nothing. */
  #checkQueued = false;
  /** An act (or a manual rotate or close) runs. */
  #acting: string | null = null;
  /** A manual rotate or close was accepted and has not ended. */
  #manual: string | null = null;
  #stopped = false;
  #seq = 0;
  /** Window id -> NEAR AI's verdict and until when it stays on the window. */
  readonly #verdicts = new Map<string, { veto: Veto; until: number }>();
  /** `kind window` -> until when a refused act is not tried again, and the reason journaled. */
  readonly #refused = new Map<string, { until: number; reason: string }>();
  #lastSkip: string | null = null;
  /** The last check's facts and free margin, for a manual rotate's sizing and veto. */
  #lastFacts: WindowFacts = {};
  #lastFree: Record<string, number> = {};

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
    const rules = `enter after ${LOOP_RULES.enterAfterChecks} hourly checks, exit after ${LOOP_RULES.exitAfterChecks}, cooldown ${LOOP_RULES.cooldownHours} h, time stop ${LOOP_RULES.maxHoldDays} d, at most ${LOOP_RULES.maxRotationsPerDay} rotations a day`;
    const veto = this.#o.veto?.configured === true ? `NEAR AI veto ${this.#o.veto.model} (${(this.#o.vetoTimeoutMs ?? LOOP_RULES.vetoTimeoutMs) / 1000} s)` : 'no NEAR AI veto (NEAR_AI_API_KEY is not set: every window passes, "no veto check")';
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

  /** POST /rotate: refused at once with the reason, or started (progress in the journal). */
  rotate(windowId: unknown): { ok: true } | { ok: false; reason: string } {
    if (typeof windowId !== 'string' || windowId.trim() === '') return { ok: false, reason: 'POST /rotate needs { "windowId": "<window id>" }' };
    const pre = this.#manualRefusal();
    if (pre !== null) return { ok: false, reason: pre };
    const now = this.#o.clock.now();
    const w = this.#withVerdicts(this.#o.windows() ?? [], now).find((x) => x.id === windowId);
    if (w === undefined) return { ok: false, reason: `${windowId} is not in the last scan` };
    const hands = this.#o.hands!;
    const heldNow = hands.held();
    if (this.#state.held?.windowId === windowId && heldNow !== null) return { ok: false, reason: `${windowId} is the window held now` };
    const not = notEnterable(w);
    if (not !== null) return { ok: false, reason: not };
    const sym = hands.symbolOf(w);
    if ('refused' in sym) return { ok: false, reason: sym.refused };
    // Sized as decide() sizes an entry; a rotation frees the held legs' margin first.
    const policy = this.#o.policy();
    const size = sizeFor(w, {
      strategy: this.#o.strategy(), maxNotionalUsd: policy?.max_notional_usd ?? 0, freeMarginUsd: this.#lastFree, liveRescue: this.#o.liveRescue(),
      ...(policy === null ? {} : { priceBandBps: policy.price_band_bps }), ...(this.#lastFacts.lots === undefined ? {} : { lots: this.#lastFacts.lots }),
    }, heldNow?.freedMarginUsd ?? {});
    if (!size.ok) return { ok: false, reason: `${windowId} cannot be sized: ${size.why}` };
    const qty = actQty(size as never);
    this.#manual = `POST /rotate ${windowId}`;
    void this.#serial(async () => {
      this.#acting = this.#manual;
      try {
        const fromId = hands.held() === null ? null : (this.#state.held?.windowId ?? 'the pair held');
        const end = await this.#enterOrRotate({ fromId, w, legUsd: size.legUsd, leverage: size.leverage, ...(qty === undefined ? {} : { qty }), manual: true });
        if (end === 'done' || end === 'flat') this.#patchCounters({ badChecks: 0, betterByWindow: {}, ...(end === 'flat' ? { lastExitAt: this.#o.clock.now() } : {}) });
      } finally {
        this.#acting = null;
        this.#manual = null;
      }
    });
    return { ok: true };
  }

  /** POST /close: refused at once with the reason, or started. */
  close(): { ok: true } | { ok: false; reason: string } {
    const pre = this.#manualRefusal();
    if (pre !== null) return { ok: false, reason: pre };
    if (this.#o.hands!.held() === null) return { ok: false, reason: 'no pair is held: nothing to close' };
    this.#manual = 'POST /close';
    void this.#serial(async () => {
      this.#acting = this.#manual;
      try {
        if (await this.#exit('POST /close (manual)', true)) this.#patchCounters({ badChecks: 0, betterByWindow: {}, lastExitAt: this.#o.clock.now() });
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

  #manualRefusal(): string | null {
    if (this.#stopped) return 'serve is stopping';
    if (!this.#o.trade) return 'GIMBAL_TRADE is not 1: this engine trades nothing';
    if (this.#o.hands === null) return `no pair trader here: ${this.#o.handsWhy ?? 'nothing can be opened or closed'}`;
    const acting = this.#manual ?? this.#acting;
    if (acting !== null) return `the strategy loop is acting (${acting}): try again when it is done`;
    return this.#o.busy() ?? this.#o.hands.blocked();
  }

  #serial(task: Task): Promise<void> {
    const next = this.#queue.then(task).catch((err: unknown) => {
      this.#log(`strategy loop: ${errorMessage(err)}`);
      this.#journal('error', `strategy loop: ${errorMessage(err)}`, {});
    });
    this.#queue = next;
    return next;
  }

  async #check(): Promise<void> {
    if (this.#stopped) return;
    const now = this.#o.clock.now();
    if (!this.#o.trade) {
      const reason = 'GIMBAL_TRADE is not 1: the engine watches, rescues and journals, and trades nothing';
      this.#publishDecision({ action: 'off', reason, windowId: null, heldId: this.#state.held?.windowId ?? null, at: now });
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
    const windows = this.#withVerdicts(scanned, now);
    this.#republishVerdicts(scanned, windows);
    const strategy = this.#o.strategy();
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    const last = this.#state.counters.lastHourlyAt;
    const hourly = now - hourStart >= HOUR_GRACE_MS && (last === null || last < hourStart);
    const { held, freed } = this.#heldPair(windows, now);
    const freeMarginUsd = await this.#o.freeMargin().catch((err: unknown) => {
      this.#log(`strategy loop: free margin not read (${errorMessage(err)})`);
      return {};
    });
    const facts = await (this.#o.facts?.(windows) ?? Promise.resolve<WindowFacts>({})).catch((err: unknown): WindowFacts => {
      this.#log(`strategy loop: window facts not read (${errorMessage(err)})`);
      return {};
    });
    this.#lastFacts = facts;
    this.#lastFree = freeMarginUsd;
    const policy = this.#o.policy();
    const before = this.#state.counters;
    const input = {
      now, hourly, windows, held, strategy, maxNotionalUsd: policy?.max_notional_usd ?? 0, freeMarginUsd, liveRescue: this.#o.liveRescue(),
      counters: before, ...(policy === null ? {} : { priceBandBps: policy.price_band_bps }),
      ...(facts.gross14dAprPct === undefined ? {} : { gross14dAprPct: facts.gross14dAprPct }), ...(facts.lots === undefined ? {} : { lots: facts.lots }),
      ...(freed === undefined ? {} : { freedMarginUsd: freed }),
    } as DecideInput;
    const d = (this.#o.decide ?? defaultDecide)(input);
    if (journalWait(before, d)) {
      this.#journal('wait', d.decision.reason, { hourly: hourly ? 1 : 0, ...(d.decision.windowId === null ? {} : { window: d.decision.windowId }) });
    }
    this.#publishDecision(d.decision);
    if (d.act === null || !strategy.auto) {
      this.#saveCounters(d.counters);
      return;
    }
    // Until the act is done, the counters are those of an act not carried out.
    this.#saveCounters(skipAct(input, d));
    const end = await this.#act(d, windows, facts);
    if (end === 'done') this.#saveCounters(d.counters);
    else if (end === 'vetoed') this.#saveCounters(skipActAs(input, d, { vetoed: true }));
    else if (end === 'flat') this.#saveCounters({ ...skipAct(input, d), badChecks: 0, betterByWindow: {}, lastExitAt: this.#o.clock.now() });
  }

  async #act(d: Decision, windows: readonly FundingWindow[], facts: WindowFacts): Promise<ActEnd> {
    const act = d.act!;
    const target = act.kind === 'enter' ? act.windowId : act.kind === 'rotate' ? act.toId : (this.#state.held?.windowId ?? 'held');
    const key = `${act.kind} ${target}`;
    const now = this.#o.clock.now();
    const hands = this.#o.hands;
    const why = hands === null ? `no pair trader here: ${this.#o.handsWhy ?? 'nothing can be opened or closed'}` : hands.blocked();
    if (why !== null) {
      this.#refuse(key, `${key} not carried out: ${why}`, now);
      return 'skipped';
    }
    const waiting = this.#refused.get(key);
    if (waiting !== undefined && now < waiting.until) return 'skipped';
    this.#acting = key;
    try {
      if (act.kind === 'exit') {
        const ok = await this.#exit(act.reason, false);
        return ok ? 'done' : 'skipped';
      }
      const w = windows.find((x) => x.id === target);
      if (w === undefined) {
        this.#refuse(key, `${key} not carried out: the window is not in the last scan`, now);
        return 'skipped';
      }
      const qty = actQty(act);
      const end = await this.#enterOrRotate({
        fromId: act.kind === 'rotate' ? act.fromId : null, w, legUsd: act.legUsd, leverage: act.leverage, ...(qty === undefined ? {} : { qty }),
        manual: false, reason: d.decision.reason, key, facts,
        hoursAbove: (act.kind === 'enter' ? d.counters.aboveByWindow[w.id] : d.counters.betterByWindow[w.id]) ?? 0,
      });
      if (end === 'done') this.#refused.delete(key);
      else if (end !== 'vetoed') this.#refused.set(key, { until: this.#o.clock.now() + RETRY_AFTER_MS, reason: this.#refused.get(key)?.reason ?? '' });
      return end;
    } finally {
      this.#acting = null;
    }
  }

  /** The veto, then (rotate) the close, then the open. */
  async #enterOrRotate(p: {
    fromId: string | null; w: FundingWindow; legUsd: number; leverage: number; qty?: string; manual: boolean; reason?: string; key?: string;
    facts?: WindowFacts; hoursAbove?: number;
  }): Promise<ActEnd> {
    const hands = this.#o.hands!;
    const { w } = p;
    const kind = p.fromId === null ? 'enter' : 'rotate';
    const who = p.manual ? 'POST /rotate (manual)' : 'auto';
    const sym = hands.symbolOf(w);
    if ('refused' in sym) {
      this.#refuseOnce(p.key ?? `${kind} ${w.id}`, `${kind} ${w.id} not carried out: ${sym.refused}`);
      return 'skipped';
    }
    // NEAR AI first: it can only remove a window.
    const veto = await this.#veto(w, {
      kind, legUsd: p.legUsd, leverage: p.leverage, hoursAbove: p.hoursAbove ?? this.#state.counters.aboveByWindow[w.id] ?? 0, facts: p.facts ?? this.#lastFacts,
    });
    if (veto.veto.verdict === 'veto') return 'vetoed';
    const base = {
      window: w.id, symbol: sym.symbol, legUsd: p.legUsd, leverage: p.leverage, ...(p.qty === undefined ? {} : { qty: p.qty }),
      netAprPct: round(w.netAprPct), grossAprPct: round(w.grossAprPct), veto: veto.line, by: who,
      ...(veto.exchange === null ? {} : vetoJournalNumbers(veto.exchange)),
    };
    if (p.fromId !== null) {
      const closed = await hands.close({ reason: `strategy: rotate out of ${p.fromId} into ${w.id} (${who})` });
      this.#owner(closed.open);
      if (!closed.ok) {
        this.#journal(closed.sent ? 'error' : 'refused', `rotate ${p.fromId} -> ${w.id}: the close of ${p.fromId} ${closed.sent ? 'did not end flat' : 'was refused'}: ${closed.reason}; nothing opened`, { ...base, from: p.fromId, feeUsd: closed.feeUsd }, closed.tx);
        return 'skipped';
      }
      const fromHeld = this.#state.held;
      this.#record('exit', { windowId: p.fromId, symbol: fromHeld?.symbol ?? hands.held()?.symbol ?? '', outcome: closed, forecastNetAprPct: fromHeld?.entryNetAprPct ?? null, exitReason: `rotate into ${w.id}`, rotation: { fromId: p.fromId, toId: w.id }, manual: p.manual });
      this.#setHeld(null);
      this.#journal('exit', `rotate: ${p.fromId} closed (${who})${fromHeld === null ? '' : `, held since ${new Date(fromHeld.since).toISOString()}`}; ${closed.reason}`, { window: p.fromId, feeUsd: closed.feeUsd, by: who, stage: 'rotate' }, closed.tx);
    }
    const opened = await hands.open({
      window: w, symbol: sym.symbol, legUsd: p.legUsd, leverage: p.leverage, ...(p.qty === undefined ? {} : { qty: p.qty }), reason: `strategy: ${kind} ${w.id} (${who})`,
    });
    this.#owner(opened.open);
    if (!opened.ok) {
      const flat = p.fromId === null ? '' : `; ${p.fromId} was closed, so the desk stays flat`;
      this.#journal(opened.sent ? 'error' : 'refused', `${kind} ${w.id}: ${opened.reason}${flat}`, { ...base, feeUsd: opened.feeUsd }, opened.tx);
      return p.fromId === null ? 'skipped' : 'flat';
    }
    // Held from now: an entry's time, or the rotation's.
    const now = this.#o.clock.now();
    this.#setHeld({ windowId: w.id, symbol: sym.symbol, since: now, legUsd: p.legUsd, entryNetAprPct: w.netAprPct });
    this.#record('enter', { windowId: w.id, symbol: sym.symbol, outcome: opened, forecastNetAprPct: w.netAprPct, exitReason: null, rotation: p.fromId === null ? null : { fromId: p.fromId, toId: w.id }, manual: p.manual });
    const size = p.qty === undefined ? `${p.legUsd} USD a leg` : `${p.qty} ${sym.symbol} (${p.legUsd} USD) a leg`;
    this.#journal(kind, `${kind === 'rotate' ? `rotate ${p.fromId} -> ${w.id}` : `enter ${w.id}`}, ${sym.symbol} short hyperliquid, long phoenix, ${size} at ${p.leverage}x, ${round(w.netAprPct)} % net (${who})${p.reason === undefined ? '' : `: ${p.reason}`}; ${opened.reason}`,
      { ...base, usd: p.legUsd, feeUsd: opened.feeUsd, ...(p.fromId === null ? {} : { from: p.fromId }) }, opened.tx);
    return 'done';
  }

  /** Both legs closed reduce-only; true when the desk is flat after it. */
  async #exit(reason: string, manual: boolean): Promise<boolean> {
    const hands = this.#o.hands!;
    const held = this.#state.held;
    const id = held?.windowId ?? hands.held()?.symbol ?? 'the pair';
    const who = manual ? 'POST /close (manual)' : 'auto';
    const blocked = hands.blocked();
    if (blocked !== null) {
      this.#journal('refused', `exit ${id} not carried out: ${blocked}`, { window: id, by: who });
      return false;
    }
    const pnl = hands.held()?.pnlUsd;
    const r = await hands.close({ reason: `strategy: exit ${id} (${who}): ${reason}` });
    this.#owner(r.open);
    if (!r.ok) {
      this.#journal(r.sent ? 'error' : 'refused', `exit ${id}: ${r.reason}`, { window: id, by: who, feeUsd: r.feeUsd }, r.tx);
      return false;
    }
    this.#record('exit', { windowId: id, symbol: held?.symbol ?? '', outcome: r, forecastNetAprPct: held?.entryNetAprPct ?? null, exitReason: reason, rotation: null, manual });
    this.#setHeld(null);
    this.#journal('exit', `exit ${id}: ${reason}; ${r.reason} (${who})`, { window: id, by: who, feeUsd: r.feeUsd, ...(pnl === undefined ? {} : { pnlUsd: round(pnl) }) }, r.tx);
    return true;
  }

  /** NEAR AI's verdict (veto.ts checkVeto), kept on the window for VETO_HOLD_MS; a veto is journaled. */
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
    this.#verdicts.set(w.id, { veto: result.veto, until: now + VETO_HOLD_MS });
    const scanned = this.#o.windows();
    if (scanned !== null) this.#republishVerdicts(scanned, this.#withVerdicts(scanned, now));
    if (result.veto.verdict === 'veto') {
      this.#journal('veto', `${w.id}: ${result.line}; not entered, the window is dropped for ${VETO_HOLD_MS / 60_000} min`, {
        window: w.id, model: result.veto.model, ...(result.exchange === null ? {} : vetoJournalNumbers(result.exchange)),
      });
    }
    return result;
  }

  /** The windows with NEAR AI's verdicts in force attached (Window.veto): a vetoed one is not entered. */
  #withVerdicts(windows: readonly FundingWindow[], now: number): FundingWindow[] {
    for (const [id, v] of this.#verdicts) if (now >= v.until) this.#verdicts.delete(id);
    return windows.map((w) => {
      const v = this.#verdicts.get(w.id);
      return v === undefined ? w : { ...w, veto: v.veto };
    });
  }

  /** A `windows` event with the verdicts attached, when the last scan's windows do not carry them (the web shows them). */
  #republishVerdicts(scanned: readonly FundingWindow[], withVerdicts: readonly FundingWindow[]): void {
    if (scanned.some((w, i) => w.veto?.at !== withVerdicts[i]!.veto?.at)) this.#o.publish({ type: 'windows', data: [...withVerdicts] });
  }

  /**
   * The pair the desk holds, as decide() takes it, and the margin closing it frees: the loop's record when it names
   * the symbol the venues hold; otherwise (a pair opened by hand, or a record lost) the desk window of that symbol,
   * held from now.
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
    this.#log(`strategy loop: holds ${venues.symbol} as ${adopted.windowId} (opened outside the loop), from now`);
    this.#setHeld(adopted);
    this.#patchCounters({ badChecks: 0, betterByWindow: {} });
    return { held: { ...adopted, pnlUsd: venues.pnlUsd }, ...freed };
  }

  /** A carried-out enter or exit, to the book. Its failure is logged, never the act's. */
  #record(kind: 'enter' | 'exit', p: {
    windowId: string; symbol: string; outcome: ActOutcome; forecastNetAprPct: number | null; exitReason: string | null;
    rotation: { fromId: string; toId: string } | null; manual: boolean;
  }): void {
    if (this.#o.book === undefined) return;
    try {
      this.#o.book({
        kind, windowId: p.windowId, symbol: p.symbol, at: this.#o.clock.now(), legs: p.outcome.fills ?? [], feeUsd: p.outcome.feeUsd, tx: p.outcome.tx,
        forecastNetAprPct: p.forecastNetAprPct, exitReason: p.exitReason, rotation: p.rotation, by: p.manual ? 'manual' : 'auto', marginMoves: [],
      });
    } catch (err) {
      this.#log(`strategy loop: the book did not take the ${kind} of ${p.windowId} (${errorMessage(err)})`);
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
