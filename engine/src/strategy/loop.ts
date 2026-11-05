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
// flat and the journal says so. Before an enter or a rotate the window goes to the NEAR AI risk check (veto.ts
// checkVeto), with the facts serve adds (riskFacts: book depth at the size, the 24 h move, the listing age); a refusal
// saves skipAct(…, { vetoed: true, why }), whose counters hold the window out (vetoedUntil, vetoWhy), writes a `veto`
// entry and signs nothing; the verdict is shown on the window (Window.veto, republished). Every check is booked in the
// risk check ledger (book/risk-ledger.ts), and the decision, the act's journal entry and any refusal after it carry
// its why line (riskCheckWhy, with the attestation label); a refusal before it says RISK_NOT_ASKED. An act refused before anything was
// sent is journaled and not tried again for RETRY_AFTER_MS; one that sent orders, or was refused for a passing reason
// (a rescue running, a close in flight), is tried again on the next check. An open that needs the stored price
// refreshed pays for one refresh_prices only after its other refusals pass (pair-ops.ts refreshForOpen); one refused
// after that payment holds its window REFRESH_HOLD_MS (saved, so a restart keeps it), and the opens send at most
// MAX_OPEN_REFRESHES_PER_DAY per symbol and MAX_OPEN_REFRESHES_PER_DAY_ALL over all symbols per UTC day (counted in
// the saved state, journaled when hit). A rotate refreshes the target's price before
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
// An owner demo entry (POST /rotate { windowId, demo: { maxLossUsd } }, to show one small real trade): the window's
// profit checks (scanner/price.ts WindowCheck.kind: the carry gate on a spread that pays, and break-even) are waived and
// nothing else is: a spread not known yet, two weeks that disagree, or one of 0 or less over the hold (funding against
// the position) stay safety checks. It must still be tradable, not refused, not stale, not refused or held out by the
// NEAR AI risk check, pass every other check, the policy's markets and the direction rule (symbolOf), and be sized
// (sizeFor); the desk must be flat. Its round-trip cost estimate is bounded: maxLossUsd above 0 and at most
// DEMO_MAX_LOSS_USD, and the window's round trip in USD (the one its checks print, WindowFacts.roundTripUsd) at most
// maxLossUsd, else refused with the number; funding during the hold is expected positive and is not part of the bound;
// the trader's open holds its own round trip to it again (carry-plan.ts). The risk check is asked as for any manual act, told it is a
// demonstration entry with the profit checks waived and the cost accepted. A held demo pair is decided on as any held
// pair: under the demo rules (a 1000 % minimum, exit after 24 checks) its counted exit comes on the 24th hourly check
// in a row; the stops, the one-leg close and POST /close at any time.
//
// On disk: the counters, the held record and the day's refresh count next to the trader state (GIMBAL_STATE_DIR), one JSON file per mode,
// contract and desk, written atomically (temporary file, fsync, rename, directory fsync) after every check. A missing
// file starts from NO_COUNTERS; an unusable one too, but with the cooldown and the day's rotations taken as used.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContractPolicy, JournalEntry, Mode, StrategyConfig, StrategyDecision, StreamEvent, TxRef, Window as FundingWindow } from '@gimbal/shared';
import { isEnterable, isEnterableButForProfit, isProfitCheck } from '../scanner/price.ts';
import { DEMO_MAX_LOSS_USD, money } from '../scanner/carry.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';
import type { CheckRules, DecideInput, Decision, HeldPair, LoopCounters } from './decide.ts';
import { LOOP_RULES, NO_COUNTERS, decide as defaultDecide, heldForwardAprPct, journalWait, sizeFor, skipAct } from './decide.ts';
import type { Veto, VetoLegFacts, VetoResult, VetoSource } from './veto.ts';
import { checkVeto, replyText, riskCheckWhy, vetoFacts, vetoJournalNumbers } from './veto.ts';
import type { RiskLedgerSink } from '../book/risk-ledger.ts';
import { roundTripUsd } from '../book/risk-ledger.ts';
import { positionIdOf } from '../book/derive.ts';
import { DEFAULT_SCANNER_CONFIG } from '../scanner/config.ts';

const HOUR_MS = 3_600_000;
/** Hyperliquid pays funding at the top of the hour: the hourly check is the first scan this long after it. */
export const HOUR_GRACE_MS = 60_000;
/** A NEAR AI pass stays shown on its window this long (a veto: as long as counters.vetoedUntil holds it out). */
export const VERDICT_SHOWN_MS = HOUR_MS;
/** An act refused before anything was sent is not tried again for the same target before this. */
export const RETRY_AFTER_MS = 15 * 60_000;
/**
 * A single leg's close that failed is tried again after this, doubling on each failure that sent orders up to
 * ONE_LEG_RETRY_MAX_MS; one refused before anything was signed is tried again after this, undoubled.
 */
export const ONE_LEG_RETRY_MS = 5_000;
export const ONE_LEG_RETRY_MAX_MS = 2 * 60_000;
/**
 * An enter or rotate refused after the open paid for a refresh_prices (refreshForOpen) is not tried again for its
 * window before this: each try would pay again (a fresh price lives 5 minutes, a retry comes after 15).
 */
export const REFRESH_HOLD_MS = 6 * HOUR_MS;
/**
 * At most this many refresh_prices an open of the loop sends per symbol per UTC day (the day's count is saved).
 * Soft caps, this one and the next: they are checked only before an open starts (its noRefresh), so one open may
 * spend its own refresh, the size recheck's and one before each part past them; a part, an unwind or a hedge is
 * never refused for a cap. Every refresh that reached the chain is counted, so the next open sees the overrun.
 */
export const MAX_OPEN_REFRESHES_PER_DAY = 12;
/** And at most this many per UTC day over all symbols (the sum of the day's per-symbol counts, saved with them). */
export const MAX_OPEN_REFRESHES_PER_DAY_ALL = 24;
export const LOOP_STATE_VERSION = 1;
/** The most an owner demo entry may accept as its maxLossUsd, USD (scanner/carry.ts, one place for the loop and the trader). */
export { DEMO_MAX_LOSS_USD };

/** An owner demo entry (POST /rotate with demo): the profit checks waived, the round trip at most maxLossUsd. */
export interface DemoEntry {
  maxLossUsd: number;
}

/** POST /rotate's `demo`, checked; or why it is refused. */
export function parseDemo(v: unknown): DemoEntry | { refused: string } {
  const shape = `"demo": { "maxLossUsd": <USD above 0, at most ${DEMO_MAX_LOSS_USD}> }`;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { refused: `POST /rotate's demo must be ${shape}` };
  const extra = Object.keys(v).filter((k) => k !== 'maxLossUsd');
  if (extra.length > 0) return { refused: `POST /rotate's demo has an unknown field ${JSON.stringify(extra[0])}: ${shape}` };
  const m = (v as { maxLossUsd?: unknown }).maxLossUsd;
  if (m === undefined) return { refused: `a demo entry needs maxLossUsd, the most its round trip may cost: ${shape}` };
  if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) return { refused: `demo maxLossUsd ${typeof m === 'number' ? String(m) : JSON.stringify(m)} is not a number above 0: ${shape}` };
  if (m > DEMO_MAX_LOSS_USD) return { refused: `demo maxLossUsd ${m} is over the ${money(DEMO_MAX_LOSS_USD)} a demo entry may accept` };
  return { maxLossUsd: m };
}

/** A demo entry as it is carried out: what the owner accepted, and the window's round trip it was held to. */
interface DemoCost {
  maxLossUsd: number;
  roundTripUsd: number;
}

/** A refusal before the risk check was asked says so. */
export const RISK_NOT_ASKED = 'NEAR AI risk check: not asked (refused before it)';
/**
 * The hold a refused window is priced over in the risk check ledger: the scanner's own hold (the one its net APR is
 * spread over), at most the time stop.
 */
/** A retry of the same act within this long is not booked again in the risk check ledger. */
export const LEDGER_RETRY_MS = 3_600_000;
export const LEDGER_HOLD_HOURS = Math.min(DEFAULT_SCANNER_CONFIG.costs.holdHours, LOOP_RULES.maxHoldDays * 24);

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
  /** How many refresh_prices were sent for it (with `refreshed`: its own and those before its parts); absent: one. */
  refreshes?: number;
  /**
   * An open refused for its cost, nothing sent (the trader's CarryPlan.costRefusal): why. The window is held out of
   * the entry rules until the next hourly check (DecideInput.costRefused) and its hours start again.
   */
  costRefused?: string;
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
  /** An owner demo entry's enter (POST /rotate with demo: the profit checks waived); absent otherwise. */
  demo?: true;
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
  /**
   * The held pair's long and short venues, named by hands that open more than one pair (GIMBAL_ORDERLY_PAIRS=1): the
   * loop's record must then name the same legs. Absent: long Phoenix, short Hyperliquid, and the record is matched on
   * its symbol alone, as before.
   */
  long?: string;
  short?: string;
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
   * `demo`: an owner demo entry; the trader waives its refusal for the spread not covering the round trip only, and
   * refuses a round trip over maxLossUsd on its own reads.
   */
  open(request: { window: FundingWindow; symbol: string; legUsd: number; leverage: number; qty: string; reason: string; noRefresh?: string; demo?: DemoEntry }): Promise<ActOutcome>;
  /**
   * A rotate's first step, before the held pair is closed (serve-pair.ts PairHands.prepareOpen): the target's stored
   * price refreshed when the open would need it, so a refresh that fails keeps the held pair. Absent: no such step.
   */
  prepareOpen?(request: { symbol: string; noRefresh?: string }): Promise<ActOutcome>;
  /**
   * Why no rotation may leave the pair held now, whatever the target (serve-pair.ts: an Orderly leg, whose close arms
   * the replay watch), or null. An automatic rotate is refused on it before the NEAR AI risk check is asked; a manual
   * one goes on to prepareOpen, which refuses it in the same words. Absent: never refused here.
   */
  rotateOutRefused?(): string | null;
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
  /** Each window's round trip in USD at strategy.legUsd (the scanner's carry estimate, as its checks print it). */
  roundTripUsd?: Record<string, number>;
}

/** What the loop entered, so a restart knows the window, since when and at what net. */
export interface LoopHeld {
  windowId: string;
  symbol: string;
  since: number;
  legUsd: number;
  entryNetAprPct: number;
  /** The pair's long and short venues; absent (every state saved before Orderly pairs): long Phoenix, short Hyperliquid. */
  long?: string;
  short?: string;
}

/** The pair a held record or the hands name, with the default filled in. */
function legsOf(h: { long?: string; short?: string }): { long: string; short: string } {
  return { long: h.long ?? 'phoenix', short: h.short ?? 'hyperliquid' };
}

/** A window's venues as LoopHeld keeps them: nothing for long Phoenix / short Hyperliquid (the state file as before). */
function heldVenues(long: string, short: string): { long?: string; short?: string } {
  return long === 'phoenix' && short === 'hyperliquid' ? {} : { long, short };
}

export interface LoopFileState {
  version: number;
  counters: LoopCounters;
  held: LoopHeld | null;
  /** The refresh_prices the loop's opens sent on `day` (UTC, YYYY-MM-DD), per symbol; absent: none yet. */
  refreshes?: { day: string; bySymbol: Record<string, number> };
  /**
   * `kind window` -> until when an act is held after its open was refused once it paid for refresh_prices, and the
   * line journaled (REFRESH_HOLD_MS); absent: none. A restart keeps the holds that have not ended.
   */
  holds?: Record<string, { until: number; reason: string }>;
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
  // vetoWhy is display only (the hold-out is vetoedUntil): a malformed one is dropped, never the whole state; an
  // entry that is not text is dropped alone.
  delete counters.vetoWhy;
  const why = c.vetoWhy as Record<string, unknown> | null | undefined;
  if (why !== null && typeof why === 'object' && !Array.isArray(why)) {
    counters.vetoWhy = Object.fromEntries(Object.entries(why).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  let held: LoopHeld | null = null;
  if (o.held !== null && o.held !== undefined) {
    const h = o.held as Record<string, unknown>;
    if (typeof h.windowId !== 'string' || typeof h.symbol !== 'string') throw new Error('held has no windowId or symbol');
    const n = (x: unknown, name: string): number => {
      if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`held.${name} is not a number`);
      return x;
    };
    held = { windowId: h.windowId, symbol: h.symbol, since: n(h.since, 'since'), legUsd: n(h.legUsd, 'legUsd'), entryNetAprPct: n(h.entryNetAprPct, 'entryNetAprPct') };
    if (h.long !== undefined || h.short !== undefined) {
      if (typeof h.long !== 'string' || typeof h.short !== 'string') throw new Error('held names the venue of one leg only');
      Object.assign(held, heldVenues(h.long, h.short));
    }
  }
  const out: LoopFileState = { version: LOOP_STATE_VERSION, counters, held };
  if (o.refreshes !== undefined) {
    const r = o.refreshes as Record<string, unknown> | null;
    if (r === null || typeof r !== 'object' || typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day)) throw new Error('refreshes has no day');
    out.refreshes = { day: r.day, bySymbol: record(r.bySymbol, 'refreshes.bySymbol', isCount, 'a count') };
  }
  if (o.holds !== undefined) {
    const h = o.holds as Record<string, unknown> | null;
    if (h === null || typeof h !== 'object' || Array.isArray(h)) throw new Error('holds is not an object');
    const holds: Record<string, { until: number; reason: string }> = {};
    for (const [k, v] of Object.entries(h)) {
      const x = v as { until?: unknown; reason?: unknown } | null;
      if (x === null || typeof x !== 'object' || !isTime(x.until) || typeof x.reason !== 'string') throw new Error(`holds.${k} has no until or reason`);
      holds[k] = { until: x.until as number, reason: x.reason };
    }
    out.holds = holds;
  }
  return out;
}

/** Whether two decisions say the same thing (the time aside). */
function sameDecision(a: StrategyDecision | null, b: StrategyDecision): boolean {
  return a !== null && a.action === b.action && a.reason === b.reason && a.windowId === b.windowId && a.heldId === b.heldId;
}

/**
 * Why a window is not enterable, one line (the first failing check), or null. `waiveProfit` (an owner demo entry):
 * the profit checks are passed over, every other reason stands.
 */
export function notEnterable(w: FundingWindow, waiveProfit = false): string | null {
  if (waiveProfit ? isEnterableButForProfit(w) : isEnterable(w)) return null;
  if (!w.tradable) return `${w.id} is watch only`;
  if (w.refused !== undefined) return `${w.id} is refused: ${w.refused.code} ${w.refused.reason}`;
  if (w.stale) return `${w.id} is stale: a venue it needs did not answer`;
  if (w.veto?.verdict === 'veto') return `${w.id} was refused by the NEAR AI risk check: ${w.veto.reasons.join('; ')}`;
  const failed = w.checks.find((c) => !c.ok && !(waiveProfit && isProfitCheck(c)));
  return waiveProfit ? `${w.id} fails a check a demo entry does not waive: ${failed?.text ?? 'unknown'}` : `${w.id} fails a check: ${failed?.text ?? 'unknown'}`;
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
  /** What the hands are, for the start line; default the pair trader (pair-mainnet open / close). */
  handsLine?: string;
  /** Free margin per venue now (decide's freeMarginUsd); a venue that cannot be read is left out. */
  freeMargin: () => Promise<Record<string, number>>;
  /** Whether a live rescue route covers a leg on each venue (decide's liveRescue: a route exists, not one running). */
  liveRescue: () => Record<string, boolean>;
  /**
   * decide()'s 14-day gross and lots per window, the legs' open interest for the veto and the round trips; none = not
   * known. Lots are read for the enterable windows, and for `lotsFor` (a demo entry's window) by name.
   */
  facts?: (windows: readonly FundingWindow[], lotsFor?: readonly string[]) => Promise<WindowFacts>;
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
  /** How a reply is shown attested: Attestor.label() ("TEE attested <date> UTC" or "TEE not attested: <why>"); none = not fetched. */
  attestation?: () => string;
  /** The risk check's facts a window does not carry: each leg's book at the leg's size, 24 h move, listing age. */
  riskFacts?: (w: FundingWindow, legUsd: number) => Promise<{ long?: VetoLegFacts; short?: VetoLegFacts }>;
  /** Every risk check outcome (book/risk-ledger.ts); default none. */
  ledger?: RiskLedgerSink;
  /** The scanner's grossHours, for the ledger's hourly pricing of refused windows. */
  grossHours?: (windowId: string, fromMs: number, toMs: number) => { t: number; grossAprPct: number }[] | null;
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
  /** The NEAR AI risk check's why line: on every outcome after it was asked (a refusal keeps it with the hold-out). */
  why?: string;
  /** What the act came to, for the risk check ledger: the book's position id it opened, else why it did not open. */
  positionId?: string | null;
  result?: string;
  /** Refused after it paid for a refresh_prices (nothing of the open sent): why. The window is held REFRESH_HOLD_MS. */
  paidRefusal?: string;
  /** The open was refused for its cost (ActOutcome.costRefused), nothing sent: why. */
  costRefused?: string;
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
  /** Window id -> its last booked risk check (for a retry of the same act: not booked again). */
  #checkSeq = 0;
  readonly #lastChecks = new Map<string, { id: string; kind: 'enter' | 'rotate'; by: 'auto' | 'manual'; demo: boolean; verdict: string; at: number; opened: boolean }>();
  /** `kind window` -> until when an act refused with nothing sent is not tried again, and the line journaled. */
  readonly #refused = new Map<string, { until: number; reason: string }>();
  /** Window id -> until when (the next hourly check) its open stays refused for cost, and the trader's why. */
  readonly #costRefused = new Map<string, { until: number; reason: string }>();
  #lastSkip: string | null = null;
  /** The category of the last `hold` journaled; the last action journaled `off`. */
  #lastHoldKey: string | null = null;
  #offJournaled = false;
  /** A single leg's close: the last line journaled (it is tried every check, past its backoff). */
  #oneLegLine: string | null = null;
  /**
   * A single leg's close that failed: not tried again before `at`; `ms` is the wait that set it (ONE_LEG_RETRY_MS
   * doubling to ONE_LEG_RETRY_MAX_MS). `key` names the leg and its size: another leg or size starts over.
   */
  #oneLegRetry: { key: string; at: number; ms: number } | null = null;

  constructor(options: StrategyLoopOptions) {
    this.#o = options;
    const loaded = options.store.load(options.clock.now());
    this.#state = loaded.state;
    // The holds of a paid refusal that have not ended: a restart must not pay again for the same refusal.
    const now = options.clock.now();
    // A hold is never longer than REFRESH_HOLD_MS from now (a clock that jumped, or a hand-edited file). A clamped one
    // is saved so: otherwise each restart would clamp it again from its own now, and it would never end.
    let clamped = false;
    const holds: Record<string, { until: number; reason: string }> = {};
    for (const [k, h] of Object.entries(loaded.state.holds ?? {})) {
      if (h.until <= now) continue;
      const until = Math.min(h.until, now + REFRESH_HOLD_MS);
      if (until !== h.until) clamped = true;
      holds[k] = { ...h, until };
      this.#refused.set(k, holds[k]);
    }
    if (loaded.problem !== null) options.log(`strategy loop: state not usable, counters start over with the cooldown and the day's rotations taken as used: ${loaded.problem}`);
    if (clamped) {
      this.#state = { ...this.#state, holds };
      this.#save();
    }
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
    const counts = checkRulesOf(this.#o.strategy());
    const rules = `enter after ${counts.enterAfterChecks} hourly checks in a row, exit after ${counts.exitAfterChecks} (owner settings), cooldown ${LOOP_RULES.cooldownHours} h, time stop ${LOOP_RULES.maxHoldDays} d, at most ${LOOP_RULES.maxRotationsPerDay} rotations a day, a NEAR AI risk check refusal holds ${LOOP_RULES.vetoHoldHours} h`;
    const veto = this.#o.veto?.configured === true ? `NEAR AI risk check ${this.#o.veto.model} (${(this.#o.vetoTimeoutMs ?? LOOP_RULES.vetoTimeoutMs) / 1000} s)` : 'no NEAR AI risk check (NEAR_AI_API_KEY is not set: every window passes)';
    const hands = this.#o.hands === null ? `no hands (${this.#o.handsWhy ?? 'nothing can be opened or closed here'}): decisions are published, acts journaled as refused` : (this.#o.handsLine ?? 'acts through the pair trader (pair-mainnet open / close)');
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
   * nothing new is opened. It is checked and sized again when it runs. `demoAsk` (POST /rotate's demo, parseDemo): an
   * owner demo entry, the window's profit checks waived and its round trip held to demo.maxLossUsd.
   */
  rotate(windowId: unknown, demoAsk?: unknown): { ok: true } | { ok: false; reason: string } {
    if (typeof windowId !== 'string' || windowId.trim() === '') return { ok: false, reason: 'POST /rotate needs { "windowId": "<window id>" }' };
    let demo: DemoEntry | undefined;
    if (demoAsk !== undefined) {
      const parsed = parseDemo(demoAsk);
      if ('refused' in parsed) return { ok: false, reason: parsed.refused };
      demo = parsed;
    }
    const pre = this.#manualRefusal();
    if (pre !== null) return { ok: false, reason: pre };
    if (!this.#o.strategy().auto) return { ok: false, reason: 'auto is off: nothing new is opened (PUT /strategy auto=true first; POST /close works either way)' };
    const first = this.#rotateCheck(windowId, this.#lastFree, this.#lastFacts, demo, true);
    if ('reason' in first) return { ok: false, reason: first.reason };
    const what = demo === undefined ? `POST /rotate ${windowId}` : `POST /rotate ${windowId} (owner demo entry, at most ${money(demo.maxLossUsd)})`;
    // A refusal line keeps the lead it has without demo; the demo tag comes after it.
    const notDone = `POST /rotate ${windowId} not carried out: ${demo === undefined ? '' : `(owner demo entry, at most ${money(demo.maxLossUsd)}) `}`;
    const refusedNumbers = { window: windowId, by: 'POST /rotate (manual)', ...(demo === undefined ? {} : { demo: 1, maxLossUsd: demo.maxLossUsd }) };
    this.#manual = what;
    void this.#serial(async () => {
      this.#acting = this.#manual;
      try {
        if (this.#stopped) return;
        if (!this.#o.strategy().auto) {
          this.#journal('refused', `${notDone}auto was turned off before it ran`, refusedNumbers);
          return;
        }
        // Checked and sized again on the numbers of the moment (a demo entry's window: its lots read by name).
        const scanned = this.#o.windows() ?? [];
        const [free, facts] = await Promise.all([this.#readFree(), this.#readFacts(scanned, demo === undefined ? undefined : [windowId])]);
        const again = this.#rotateCheck(windowId, free, facts, demo);
        if ('reason' in again) {
          this.#journal('refused', `${notDone}${again.reason}`, refusedNumbers);
          return;
        }
        const fromId = this.#o.hands!.held() === null ? null : (this.#state.held?.windowId ?? 'the pair held');
        const r = await this.#enterOrRotate({
          fromId, w: again.w, legUsd: again.legUsd, leverage: again.leverage, qty: again.qty, manual: true, facts, ...(again.demo === undefined ? {} : { demo: again.demo }),
        });
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
  #checked = 0;

  /**
   * Checks so far that read a scan's windows and the free margin (what a manual rotate's first check is sized on).
   * GIMBAL_CONTROL's /rotate and /close wait for the first (serve-control.ts).
   */
  get checked(): number {
    return this.#checked;
  }

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

  /**
   * A manual rotate's window, checked and sized as decide() sizes an entry (a rotation frees the held legs' margin
   * first). `demo`: the profit checks waived, the desk flat, and the window's round trip at most maxLossUsd. `first`:
   * the check POST /rotate answers on, on the last check's facts.
   */
  #rotateCheck(windowId: string, free: Record<string, number>, facts: WindowFacts, demo?: DemoEntry, first = false):
    { w: FundingWindow; legUsd: number; leverage: number; qty: string; demo?: DemoCost } | { reason: string } {
    const now = this.#o.clock.now();
    const w = (this.#o.windows() ?? []).find((x) => x.id === windowId);
    if (w === undefined) return { reason: `${windowId} is not in the last scan` };
    const hands = this.#o.hands!;
    const heldNow = hands.held();
    if (heldNow?.oneLeg != null) return { reason: `one leg is open (${heldNow.oneLeg.venue} ${heldNow.oneLeg.qty}): it is closed first` };
    // From flat only: a rotation would add the held pair's close to the cost the owner accepted.
    if (demo !== undefined && heldNow !== null) {
      return { reason: `a pair is held (${this.#state.held?.windowId ?? heldNow.symbol}): a demo entry opens from flat only, so its cost is its own round trip; POST /close first` };
    }
    if (this.#state.held?.windowId === windowId && heldNow !== null) return { reason: `${windowId} is the window held now` };
    const until = this.#state.counters.vetoedUntil[windowId];
    if (until !== undefined && now < until) return { reason: `${windowId} was refused by the NEAR AI risk check: held out until ${new Date(until).toISOString()}` };
    const not = notEnterable(w, demo !== undefined);
    if (not !== null) return { reason: not };
    const sym = hands.symbolOf(w);
    if ('refused' in sym) return { reason: sym.refused };
    let cost: DemoCost | undefined;
    if (demo !== undefined) {
      const rt = facts.roundTripUsd?.[windowId];
      if (rt === undefined || !Number.isFinite(rt) || rt < 0) {
        return { reason: `${windowId}: its round trip in USD is not known, so a demo entry cannot be held to its ${money(demo.maxLossUsd)} maxLossUsd` };
      }
      if (rt > demo.maxLossUsd) return { reason: `${windowId}: its round trip, ${money(rt)}, is over the ${money(demo.maxLossUsd)} the demo entry accepts (maxLossUsd)` };
      cost = { maxLossUsd: demo.maxLossUsd, roundTripUsd: rt };
    }
    const policy = this.#o.policy();
    const size = sizeFor(w, {
      strategy: this.#o.strategy(), maxNotionalUsd: policy?.max_notional_usd ?? 0, freeMarginUsd: free, liveRescue: this.#o.liveRescue(),
      ...(policy === null ? {} : { priceBandBps: policy.price_band_bps }), ...(facts.lots === undefined ? {} : { lots: facts.lots }),
    }, heldNow?.freedMarginUsd ?? {});
    // The last check read lots for enterable windows only: a demo entry's window gets its lots read when it runs, and
    // is sized on them then. Every cap before the lots (leg, policy, margin, depth) is still checked here.
    if (!size.ok && first && demo !== undefined && size.code === 'lots' && facts.lots?.[windowId] === undefined) {
      return { w, legUsd: 0, leverage: 0, qty: '0', ...(cost === undefined ? {} : { demo: cost }) };
    }
    if (!size.ok) return { reason: `${windowId} cannot be sized: ${size.why}` };
    return { w, legUsd: size.legUsd, leverage: size.leverage, qty: size.qty, ...(cost === undefined ? {} : { demo: cost }) };
  }

  #serial(task: Task): Promise<void> {
    const next = this.#queue.then(task).catch((err: unknown) => {
      this.#log(`strategy loop: ${errorMessage(err)}`);
      this.#journal('error', `strategy loop: ${errorMessage(err)}`, {});
    });
    this.#queue = next;
    return next;
  }

  /**
   * decide()'s unopenable: the tradable windows the hands refuse (LoopHands.symbolOf: serve's direction rule and the
   * policy's markets), so the gate passes over them to one the hands can open. No hands: nothing is opened anyway.
   */
  #unopenable(windows: readonly FundingWindow[]): Pick<DecideInput, 'unopenable'> {
    const hands = this.#o.hands;
    if (hands === undefined || hands === null) return {};
    const out: Record<string, string> = {};
    for (const w of windows) {
      if (!w.tradable) continue;
      const sym = hands.symbolOf(w);
      if ('refused' in sym) out[w.id] = sym.refused;
    }
    return { unopenable: out };
  }

  async #readFree(): Promise<Record<string, number>> {
    return this.#o.freeMargin().catch((err: unknown) => {
      this.#log(`strategy loop: free margin not read (${errorMessage(err)})`);
      return {};
    });
  }

  async #readFacts(windows: readonly FundingWindow[], lotsFor?: readonly string[]): Promise<WindowFacts> {
    return (this.#o.facts?.(windows, ...(lotsFor === undefined ? [] : [lotsFor])) ?? Promise.resolve<WindowFacts>({})).catch((err: unknown): WindowFacts => {
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
    if (hourly && this.#o.ledger !== undefined && this.#o.grossHours !== undefined) {
      try {
        this.#o.ledger.hourly(now, this.#o.grossHours);
      } catch (err) {
        this.#log(`strategy loop: the refused windows' hours were not booked (${errorMessage(err)})`);
      }
    }

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
    if (venues?.oneLeg == null) this.#oneLegRetry = null;
    const { held, freed } = this.#heldPair(scanned, now);
    const freeMarginUsd = await this.#readFree();
    const facts = await this.#readFacts(scanned);
    this.#lastFacts = facts;
    this.#lastFree = freeMarginUsd;
    this.#checked++;
    const policy = this.#o.policy();
    const before = this.#state.counters;
    const input: DecideInput = {
      now, hourly, windows: scanned, held, strategy, rules: checkRulesOf(strategy), maxNotionalUsd: policy?.max_notional_usd ?? 0, freeMarginUsd, liveRescue: this.#o.liveRescue(),
      counters: before, ...(policy === null ? {} : { priceBandBps: policy.price_band_bps }),
      ...(facts.gross14dAprPct === undefined ? {} : { gross14dAprPct: facts.gross14dAprPct }), ...(facts.lots === undefined ? {} : { lots: facts.lots }),
      ...(freed === undefined ? {} : { freedMarginUsd: freed }),
      ...this.#unopenable(scanned),
      ...this.#costHeld(now),
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
    // Refused for cost: the window's hours start again (skipAct), and until the next hourly check it fails the entry
    // rules (#costHeld), so the next check falls through to the window below it.
    const cost = r.costRefused === undefined ? {} : { costRefused: true };
    if (r.end === 'done') this.#saveCounters(d.counters);
    else if (r.end === 'vetoed') this.#saveCounters(skipAct(input, d, { vetoed: true, ...(r.why === undefined ? {} : { why: r.why }) }));
    else if (r.end === 'flat') this.#saveCounters({ ...skipAct(input, d, cost), badChecks: 0, betterByWindow: {}, lastExitAt: this.#o.clock.now() });
    else if (r.costRefused !== undefined) this.#saveCounters(skipAct(input, d, cost));
  }

  /**
   * decide()'s costRefused: the windows the pair trader refused for cost, until the next hourly check after the
   * refusal (the books and the 7-day means it priced them on are read again then). Ended ones are dropped.
   */
  #costHeld(now: number): Pick<DecideInput, 'costRefused'> {
    const out: Record<string, string> = {};
    for (const [id, h] of this.#costRefused) {
      if (now < h.until) out[id] = h.reason;
      else this.#costRefused.delete(id);
    }
    return Object.keys(out).length === 0 ? {} : { costRefused: out };
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
        badChecks: d.counters.badChecks, exitAfterChecks: checkRulesOf(input.strategy).exitAfterChecks,
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
      checks: `${d.counters.aboveByWindow[top.id] ?? 0}/${checkRulesOf(input.strategy).enterAfterChecks}`, block,
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
      this.#refuse(key, `${key} not carried out: no pair trader here: ${this.#o.handsWhy ?? 'nothing can be opened or closed'}${act.kind === 'exit' ? '' : `; ${RISK_NOT_ASKED}`}`, now);
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
          this.#refuseOnce(key, `${key} not carried out: the window is not in the last scan; ${RISK_NOT_ASKED}`);
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
        const line = `${key} held until ${new Date(until).toISOString()}: refused after the open paid for refresh_prices (${r.paidRefusal}); not tried again for ${REFRESH_HOLD_MS / HOUR_MS} h, so a refusal that repeats does not pay again${r.why === undefined ? '' : `; ${r.why}`}`;
        const now = this.#o.clock.now();
        const holds = Object.fromEntries(Object.entries(this.#state.holds ?? {}).filter(([, h]) => h.until > now));
        for (const k of [`enter ${target}`, `rotate ${target}`]) {
          this.#refused.set(k, { until, reason: line });
          holds[k] = { until, reason: line };
        }
        this.#state = { ...this.#state, holds };
        this.#save();
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

  /**
   * The NEAR AI risk check, then (rotate) the target's price (prepareOpen, which may pay for a refresh), the close and
   * the open; the gate is checked right before each. A refusal never costs a refresh. Every outcome after the check
   * carries its why line, and the act's end is booked against the check in the risk check ledger.
   */
  async #enterOrRotate(p: {
    fromId: string | null; w: FundingWindow; legUsd: number; leverage: number; qty: string; manual: boolean; reason?: string; key?: string;
    facts?: WindowFacts; hoursAbove?: number; demo?: DemoCost;
  }): Promise<ActEnd> {
    let checked: { checkId: string | null; fresh: boolean; why: string } | null = null;
    const r = await this.#enterOrRotateChecked(p, (c) => {
      checked = c;
    });
    const c = checked as { checkId: string | null; fresh: boolean; why: string } | null;
    if (c === null) return r;
    if (r.end !== 'vetoed') this.#bookAct(c.checkId, c.fresh, r);
    return { ...r, why: c.why };
  }

  async #enterOrRotateChecked(p: {
    fromId: string | null; w: FundingWindow; legUsd: number; leverage: number; qty: string; manual: boolean; reason?: string; key?: string;
    facts?: WindowFacts; hoursAbove?: number; demo?: DemoCost;
  }, onChecked: (c: { checkId: string | null; fresh: boolean; why: string }) => void): Promise<ActEnd> {
    const hands = this.#o.hands!;
    const { w } = p;
    const kind = p.fromId === null ? 'enter' : 'rotate';
    const who = p.manual ? 'POST /rotate (manual)' : 'auto';
    const key = p.key ?? `${kind} ${w.id}`;
    const sym = hands.symbolOf(w);
    if ('refused' in sym) {
      this.#refuseOnce(key, `${kind} ${w.id} not carried out: ${sym.refused}; ${RISK_NOT_ASKED}`);
      return SKIPPED;
    }
    // A rotation the hands refuse for the pair held, whatever the target, is not worth a risk check (paid, asked again
    // at every retry); a manual rotate still goes the whole way and is refused by prepareOpen after its check.
    const out = p.fromId === null || p.manual ? null : hands.rotateOutRefused?.() ?? null;
    if (out !== null) {
      this.#refuseOnce(key, `rotate ${p.fromId} -> ${w.id} not carried out: ${out}; ${p.fromId} is kept, nothing closed; ${RISK_NOT_ASKED}`);
      return SKIPPED;
    }
    // NEAR AI first: it can only remove a window.
    const check = await this.#veto(w, {
      kind, legUsd: p.legUsd, leverage: p.leverage, hoursAbove: p.hoursAbove ?? this.#state.counters.aboveByWindow[w.id] ?? 0, facts: p.facts ?? this.#lastFacts,
      manual: p.manual, ...(p.demo === undefined ? {} : { demo: p.demo }),
    });
    onChecked({ checkId: check.checkId, fresh: check.fresh, why: check.why });
    if (check.result.veto.verdict === 'veto') return { end: 'vetoed', sent: false, passing: false, why: check.why };
    const why = check.why;
    const base = {
      window: w.id, symbol: sym.symbol, legUsd: p.legUsd, leverage: p.leverage, qty: p.qty,
      netAprPct: round(w.netAprPct), grossAprPct: round(w.grossAprPct), veto: check.result.line, by: who, ...check.numbers,
      ...(p.demo === undefined ? {} : { demo: 1, maxLossUsd: p.demo.maxLossUsd, roundTripUsd: round4(p.demo.roundTripUsd) }),
    };
    // An owner demo entry says so on every line after its risk check, with the cost the owner accepted: after the
    // line's own lead (`enter ID not carried out: `, `enter ID: `), which stays as without demo (web waitCopy.ts reads it).
    const tag = p.demo === undefined ? '' : `(${demoText(p.demo)}) `;
    if (p.fromId !== null) {
      const gate = this.#gate();
      if (gate !== null) {
        this.#refuseOnce(key, `rotate ${p.fromId} -> ${w.id} not carried out: ${gate}; ${why}`);
        return { ...SKIPPED, passing: true, result: `not rotated: ${gate}` };
      }
      // The target's stored price before the held pair is closed: a refresh that fails keeps the pair held, where
      // the open after the close would leave the desk flat.
      if (hands.prepareOpen !== undefined) {
        const ready = await hands.prepareOpen({ symbol: sym.symbol, ...this.#refreshAllowance(sym.symbol) });
        if (ready.refreshed === true) this.#countRefresh(sym.symbol);
        if (!ready.ok) {
          this.#journal('refused', `rotate ${p.fromId} -> ${w.id} not carried out: ${ready.reason}; ${p.fromId} is kept, nothing closed; ${why}`, { ...base, from: p.fromId });
          return { ...SKIPPED, passing: this.#gate() !== null, result: `not rotated: ${ready.reason}`, ...(ready.refreshed === true ? { paidRefusal: ready.reason } : {}) };
        }
      }
      const closeAt = this.#o.clock.now();
      const closed = await hands.close({ reason: `strategy: rotate out of ${p.fromId} into ${w.id} (${who})` });
      this.#owner(closed.open);
      if (!closed.ok) {
        this.#record('fill', { windowId: p.fromId, symbol: this.#state.held?.symbol ?? '', outcome: closed, forecastNetAprPct: null, exitReason: closed.reason, rotation: null, manual: p.manual, startedAt: closeAt });
        this.#journal(closed.sent ? 'error' : 'refused', `rotate ${p.fromId} -> ${w.id}: the close of ${p.fromId} ${closed.sent ? 'did not end flat' : 'was refused'}: ${closed.reason}; nothing opened; ${why}`, { ...base, from: p.fromId, feeUsd: closed.feeUsd }, closed.tx);
        return { end: 'skipped', sent: closed.sent, passing: false, result: `not rotated: the close of ${p.fromId} failed: ${closed.reason}` };
      }
      const fromHeld = this.#state.held;
      this.#record('exit', { windowId: p.fromId, symbol: fromHeld?.symbol ?? '', outcome: closed, forecastNetAprPct: fromHeld?.entryNetAprPct ?? null, exitReason: `rotate into ${w.id}`, rotation: { fromId: p.fromId, toId: w.id }, manual: p.manual, startedAt: closeAt });
      this.#setHeld(null);
      this.#journal('exit', `rotate: ${p.fromId} closed (${who})${fromHeld === null ? '' : `, held since ${new Date(fromHeld.since).toISOString()}`}; ${closed.reason}`, { window: p.fromId, feeUsd: closed.feeUsd, by: who, stage: 'rotate' }, closed.tx);
    }
    const flat = p.fromId === null ? '' : `; ${p.fromId} was closed, so the desk stays flat`;
    const gate = this.#gate();
    if (gate !== null) {
      this.#journal('refused', `${kind} ${w.id} not carried out: ${tag}${gate}${flat}; ${why}`, base);
      return p.fromId === null ? { ...SKIPPED, passing: true, result: `not opened: ${gate}` } : { end: 'flat', sent: true, passing: true, result: `not opened: ${gate}` };
    }
    const openAt = this.#o.clock.now();
    const opened = await hands.open({
      window: w, symbol: sym.symbol, legUsd: p.legUsd, leverage: p.leverage, qty: p.qty,
      reason: `strategy: ${kind} ${w.id} (${who}${p.demo === undefined ? '' : ', owner demo entry'})`, ...this.#refreshAllowance(sym.symbol),
      ...(p.demo === undefined ? {} : { demo: { maxLossUsd: p.demo.maxLossUsd } }),
    });
    if (opened.refreshed === true) this.#countRefresh(sym.symbol, opened.refreshes ?? 1);
    this.#owner(opened.open);
    const now = this.#o.clock.now();
    if (!opened.ok) {
      const after = hands.held();
      if (opened.sent && after !== null) {
        // Orders went out and the venues hold a position: the desk holds it, the book sees the entry.
        this.#setHeld({ windowId: w.id, symbol: sym.symbol, since: now, legUsd: after.legUsd, entryNetAprPct: w.netAprPct, ...heldVenues(w.longVenue, w.shortVenue) });
        const bookedAt = this.#record('enter', { windowId: w.id, symbol: sym.symbol, outcome: opened, forecastNetAprPct: w.netAprPct, exitReason: null, rotation: p.fromId === null ? null : { fromId: p.fromId, toId: w.id }, manual: p.manual, startedAt: openAt, demo: p.demo !== undefined });
        this.#journal('error', `${kind} ${w.id}: ${tag}${opened.reason}; the venues hold ${after.symbol} (${round(after.legUsd)} USD a leg${after.oneLeg === null ? '' : `, one leg only: ${after.oneLeg.venue} ${after.oneLeg.qty}`}): held from now; ${why}`, { ...base, heldLegUsd: round(after.legUsd), feeUsd: opened.feeUsd }, opened.tx);
        return { end: 'done', sent: true, passing: false, positionId: bookedAt === null ? null : positionIdOf(w.id, bookedAt), result: `opened, partly: ${opened.reason}` };
      }
      this.#record('fill', { windowId: w.id, symbol: sym.symbol, outcome: opened, forecastNetAprPct: null, exitReason: opened.reason, rotation: null, manual: p.manual, startedAt: openAt, demo: p.demo !== undefined });
      // Refused for cost with nothing sent: held out of the entry rules until the next hourly check, its hours reset.
      const costRefused = !opened.sent && opened.costRefused !== undefined ? opened.costRefused : undefined;
      let held = '';
      if (costRefused !== undefined) {
        const until = nextHourlyCheck(now);
        this.#costRefused.set(w.id, { until, reason: costRefused });
        held = `; ${w.id} is held out of the entry rules until the hourly check at ${new Date(until).toISOString()} and its hours start again`;
      }
      this.#journal(opened.sent ? 'error' : 'refused', `${kind} ${w.id}: ${tag}${opened.reason}${flat}${held}; ${why}`, { ...base, feeUsd: opened.feeUsd }, opened.tx);
      // Stopped by the open's own gate (a rescue that started after the check before it): tried again next check.
      const passing = this.#gate() !== null;
      const paid = opened.refreshed === true && !opened.sent ? { paidRefusal: opened.reason } : {};
      const cost = costRefused === undefined ? {} : { costRefused };
      const result = `not opened: ${opened.reason}`;
      return p.fromId === null ? { end: 'skipped', sent: opened.sent, passing, result, ...paid, ...cost } : { end: 'flat', sent: true, passing, result, ...paid, ...cost };
    }
    // Held from now: an entry's time, or the rotation's. What filled, not what was asked: a later part its gate
    // stopped holds nothing.
    const filled = filledLeg(p, opened.filledQty);
    this.#setHeld({ windowId: w.id, symbol: sym.symbol, since: now, legUsd: filled.usd, entryNetAprPct: w.netAprPct, ...heldVenues(w.longVenue, w.shortVenue) });
    const enteredAt = this.#record('enter', { windowId: w.id, symbol: sym.symbol, outcome: opened, forecastNetAprPct: w.netAprPct, exitReason: null, rotation: p.fromId === null ? null : { fromId: p.fromId, toId: w.id }, manual: p.manual, startedAt: openAt, demo: p.demo !== undefined });
    const size = filled.partial
      ? `${filled.qty} ${sym.symbol} (${round(filled.usd)} USD) a leg filled of the ${p.qty} (${p.legUsd} USD) asked`
      : `at most ${p.qty} ${sym.symbol} (${p.legUsd} USD) a leg`;
    const sizeNumbers: Record<string, number | string> = filled.partial ? { legUsd: round(filled.usd), qty: filled.qty, usd: round(filled.usd), askedLegUsd: p.legUsd, askedQty: p.qty } : { usd: p.legUsd };
    this.#journal(kind, `${kind === 'rotate' ? `rotate ${p.fromId} -> ${w.id}` : `enter ${w.id}`}, ${sym.symbol} short ${w.shortVenue}, long ${w.longVenue}, ${size} at ${p.leverage}x, ${round(w.netAprPct)} % net (${who})${p.demo === undefined ? '' : `; ${demoText(p.demo)}`}${p.reason === undefined ? '' : `: ${p.reason}`}; ${why}; ${opened.reason}`,
      { ...base, ...sizeNumbers, feeUsd: opened.feeUsd, ...(p.fromId === null ? {} : { from: p.fromId }) }, opened.tx);
    return { end: 'done', sent: true, passing: false, positionId: enteredAt === null ? null : positionIdOf(w.id, enteredAt), result: `opened: ${opened.reason}` };
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

  /**
   * One venue holds a position, the other none: closed at once, reduce-only, tried on the checks until flat. A close
   * that fails is tried again after ONE_LEG_RETRY_MS, doubling up to ONE_LEG_RETRY_MAX_MS while its tries send orders
   * (each signs NEAR calls, whose gas a refusal that repeats every check could make larger than the leg); one refused
   * before anything was signed waits ONE_LEG_RETRY_MS. A close that ends flat, or another leg or size, starts over.
   * Each wait is journaled once, with its length.
   */
  async #closeOneLeg(leg: { venue: string; qty: string }, now: number): Promise<void> {
    const line = `one leg open: ${leg.venue} ${leg.qty}`;
    const retry = this.#oneLegRetry?.key === line ? this.#oneLegRetry : null;
    if (retry !== null && now < retry.at) {
      this.#publishDecision({ action: 'exit', reason: `${line}: closing it, reduce-only; the last close failed, next try at ${new Date(retry.at).toISOString()}`, windowId: null, heldId: this.#state.held?.windowId ?? null, at: now });
      return;
    }
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
      // Only a close that signed something backs off: one refused before signing (a price refresh or an RPC that
      // failed, alert only) costs no gas, and the leg must not sit naked longer once its cause clears.
      const ms = retry === null || !r.sent ? ONE_LEG_RETRY_MS : Math.min(retry.ms * 2, ONE_LEG_RETRY_MAX_MS);
      this.#oneLegRetry = { key: line, at: this.#o.clock.now() + ms, ms };
      say('error', `${line}: the close did not end flat: ${r.reason}; tried again in ${waitText(ms)}`, { venue: leg.venue, qty: leg.qty, feeUsd: r.feeUsd, retryMs: ms }, r.tx);
      return;
    }
    this.#oneLegRetry = null;
    const held = this.#state.held;
    this.#record('exit', { windowId: held?.windowId ?? `${leg.venue} leg`, symbol: held?.symbol ?? '', outcome: r, forecastNetAprPct: held?.entryNetAprPct ?? null, exitReason: line, rotation: null, manual: false, startedAt: closeAt });
    this.#setHeld(null);
    this.#patchCounters({ badChecks: 0, betterByWindow: {}, lastExitAt: this.#o.clock.now() });
    this.#oneLegLine = null;
    this.#journal('exit', `${line}: closed reduce-only; ${r.reason}`, { venue: leg.venue, qty: leg.qty, feeUsd: r.feeUsd }, r.tx);
  }

  /**
   * NEAR AI's verdict (veto.ts checkVeto), shown on the window and booked in the risk check ledger; a refusal is
   * journaled (decide's vetoedUntil holds it out). `why` is the line every decision after it carries.
   */
  async #veto(w: FundingWindow, p: { kind: 'enter' | 'rotate'; legUsd: number; leverage: number; hoursAbove: number; facts: WindowFacts; manual: boolean; demo?: DemoCost }): Promise<{
    result: VetoResult; why: string; numbers: Record<string, number | string>; checkId: string | null; fresh: boolean;
  }> {
    const now = this.#o.clock.now();
    const oi = p.facts.openInterest?.[w.id];
    // Book depth at the leg's size, the 24 h move and the listing age come from riskFacts where a venue gives them;
    // anything it cannot get stays null (unknown), never invented.
    // No reads for a check that will not be asked (no key): nothing would be sent.
    const asks = this.#o.veto?.configured === true;
    const extra = await ((asks ? this.#o.riskFacts?.(w, p.legUsd) : undefined) ?? Promise.resolve({})).catch((err: unknown) => {
      this.#log(`strategy loop: risk check facts for ${w.id} not read (${errorMessage(err)})`);
      return {};
    }) as { long?: VetoLegFacts; short?: VetoLegFacts };
    const facts = vetoFacts(w, {
      kind: p.kind, legUsd: p.legUsd, leverage: p.leverage, minNetAprPct: this.#o.strategy().minNetAprPct, hoursAbove: p.hoursAbove,
      grossApr14dPct: p.facts.gross14dAprPct?.[w.id] ?? null, manual: p.manual, ...(p.demo === undefined ? {} : { demo: p.demo }),
      legs: { long: { ...extra.long, openInterestUsd: oi?.longUsd ?? null }, short: { ...extra.short, openInterestUsd: oi?.shortUsd ?? null } },
    });
    const result = await checkVeto(this.#o.veto ?? NO_VETO_SOURCE, facts, { now, timeoutMs: this.#o.vetoTimeoutMs ?? LOOP_RULES.vetoTimeoutMs });
    // The attestation is shown only for a reply that came: an unchecked window has nothing to attest.
    const attestation = result.exchange?.response == null ? null : (this.#o.attestation?.() ?? 'TEE not attested: no attestation fetched in this run');
    const why = riskCheckWhy(result, attestation ?? '');
    const numbers: Record<string, number | string> = {
      riskCheck: why, riskCheckOutcome: result.outcome, ...(attestation === null ? {} : { attestation }),
      ...(result.exchange === null ? {} : vetoJournalNumbers(result.exchange)),
    };
    const booked = this.#bookCheck(w, p, result, why, attestation, now);
    const shown = result.veto.verdict === 'veto' ? LOOP_RULES.vetoHoldHours * HOUR_MS : VERDICT_SHOWN_MS;
    this.#verdicts.set(w.id, { veto: result.veto, until: now + shown });
    const scanned = this.#o.windows();
    if (scanned !== null) this.#republishVerdicts(scanned, now);
    // The decision that asked carries the verdict from here.
    const d = this.#decision;
    if (!p.manual && d !== null && d.windowId === w.id && (d.action === 'enter' || d.action === 'rotate')) {
      const tail = result.veto.verdict === 'veto' ? `; ${why}: not ${d.action === 'enter' ? 'entered' : 'rotated'}` : `; ${why}`;
      this.#publishDecision({ ...d, reason: `${d.reason}${tail}`, at: now });
    }
    if (result.veto.verdict === 'veto') {
      this.#journal('veto', `${w.id}${p.demo === undefined ? '' : ` (${demoText(p.demo)})`}: ${why}; not ${p.kind === 'enter' ? 'entered' : 'rotated into'}, held out for ${LOOP_RULES.vetoHoldHours} h`, {
        window: w.id, model: result.veto.model, ...numbers, ...(p.demo === undefined ? {} : { demo: 1, maxLossUsd: p.demo.maxLossUsd, roundTripUsd: round4(p.demo.roundTripUsd) }),
      });
    }
    return { result, why, numbers, ...booked };
  }

  /**
   * The check, to the risk check ledger, with its id. The same act asked again (a retry after a refusal that passes:
   * the same window, kind, verdict, asker (auto or manual) and demo flag, its earlier act not opened, within
   * LEDGER_RETRY_MS) is not booked again: the earlier check stands for it (`fresh` false). So a demo open is never booked
   * against a plain or auto check, nor the reverse. Its failure is logged, never the act's.
   */
  #bookCheck(w: FundingWindow, p: { kind: 'enter' | 'rotate'; legUsd: number; leverage: number; manual: boolean; demo?: DemoCost }, r: VetoResult, why: string, attestation: string | null, now: number): { checkId: string | null; fresh: boolean } {
    if (this.#o.ledger === undefined) return { checkId: null, fresh: false };
    const verdict = r.veto.verdict === 'veto' ? 'refused' : r.checked ? 'passed' : 'unchecked';
    const by = p.manual ? 'manual' : 'auto';
    const demo = p.demo !== undefined;
    const last = this.#lastChecks.get(w.id);
    if (last !== undefined && last.kind === p.kind && last.by === by && last.demo === demo && last.verdict === verdict && !last.opened && now - last.at < LEDGER_RETRY_MS) {
      return { checkId: last.id, fresh: false };
    }
    // A second check on the window in the same millisecond (a demo after a plain one): its own id all the same.
    const base = `${now}-${w.id}`;
    const id = last === undefined || (last.id !== base && !last.id.startsWith(`${base}-`)) ? base : `${base}-${++this.#checkSeq}`;
    try {
      const holdHours = LEDGER_HOLD_HOURS;
      this.#o.ledger.check({
        v: 1, type: 'check', id, at: now, kind: p.kind, by, ...(demo ? { demo: true as const } : {}), windowId: w.id, symbol: w.symbol,
        outcome: r.outcome, verdict, reason: r.reason, why, attestation,
        model: r.veto.model, prompt: r.exchange?.messages ?? null, reply: r.exchange === null ? '' : replyText(r.exchange), latencyMs: r.latencyMs,
        legUsd: p.legUsd, leverage: p.leverage, forecastNetAprPct: w.netAprPct, roundTripCostUsd: roundTripUsd(w.costs, p.legUsd, DEFAULT_SCANNER_CONFIG.costs.holdHours), holdHours,
      });
    } catch (err) {
      this.#log(`strategy loop: the risk check on ${w.id} was not booked (${errorMessage(err)})`);
      return { checkId: null, fresh: false };
    }
    this.#lastChecks.set(w.id, { id, kind: p.kind, by, demo, verdict, at: now, opened: false });
    for (const [k, v] of this.#lastChecks) if (now - v.at >= LEDGER_RETRY_MS) this.#lastChecks.delete(k);
    return { checkId: id, fresh: true };
  }

  /** How the act after a check ended, to the ledger: once per check, and again for a retry only when it opened. */
  #bookAct(checkId: string | null, fresh: boolean, r: ActEnd): void {
    const ledger = this.#o.ledger;
    if (checkId === null || ledger?.act === undefined) return;
    const opened = r.end === 'done';
    if (!fresh && !opened) return;
    for (const v of this.#lastChecks.values()) if (v.id === checkId && opened) v.opened = true;
    try {
      ledger.act({ v: 1, type: 'act', at: this.#o.clock.now(), checkId, opened, positionId: opened ? r.positionId ?? null : null, result: r.result ?? r.end });
    } catch (err) {
      this.#log(`strategy loop: the end of the act after ${checkId} was not booked (${errorMessage(err)})`);
    }
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
    // The record is the pair the venues hold when it names its symbol, and its legs when the hands name theirs
    // (absent legs on the record: long Phoenix, short Hyperliquid).
    const legs = legsOf(venues);
    const named = venues.long !== undefined || venues.short !== undefined;
    const sameLegs = record === null || !named || (legsOf(record).long === legs.long && legsOf(record).short === legs.short);
    if (record !== null && record.symbol === venues.symbol && sameLegs) {
      return {
        held: { windowId: record.windowId, symbol: record.symbol, since: record.since, legUsd: venues.legUsd > 0 ? venues.legUsd : record.legUsd, entryNetAprPct: record.entryNetAprPct, pnlUsd: venues.pnlUsd },
        ...freed,
      };
    }
    const w = windows.find((x) => x.longVenue === legs.long && x.shortVenue === legs.short && symbolIs(hands!.symbolOf(x), venues.symbol));
    const adopted: LoopHeld = {
      windowId: w?.id ?? `${venues.symbol}-${legs.long}-${legs.short}`.toLowerCase(), symbol: venues.symbol, since: now, legUsd: venues.legUsd,
      entryNetAprPct: w?.netAprPct ?? 0, ...heldVenues(legs.long, legs.short),
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
    rotation: { fromId: string; toId: string } | null; manual: boolean; startedAt: number; demo?: boolean;
  }): number | null {
    if (this.#o.book === undefined) return null;
    if (kind === 'fill' && (p.outcome.fills ?? []).length === 0) return null;
    const at = this.#o.clock.now();
    try {
      this.#o.book({
        kind, windowId: p.windowId, symbol: p.symbol, at, startedAt: p.startedAt, legs: p.outcome.fills ?? [], feeUsd: p.outcome.feeUsd, tx: p.outcome.tx,
        forecastNetAprPct: p.forecastNetAprPct, exitReason: p.exitReason, rotation: p.rotation, by: p.manual ? 'manual' : 'auto',
        ...(p.demo === true ? { demo: true as const } : {}), marginMoves: [],
      });
    } catch (err) {
      this.#log(`strategy loop: the book did not take the ${kind} of ${p.windowId} (${errorMessage(err)})`);
      return null;
    }
    return at;
  }

  /** The UTC day of `t`, as LoopFileState.refreshes keeps it. */
  #day(t: number): string {
    return new Date(t).toISOString().slice(0, 10);
  }

  /**
   * What an open of `symbol` may spend on refresh_prices today: noRefresh once MAX_OPEN_REFRESHES_PER_DAY of the
   * symbol, or MAX_OPEN_REFRESHES_PER_DAY_ALL over all symbols, are used.
   */
  #refreshAllowance(symbol: string): { noRefresh?: string } {
    const day = this.#day(this.#o.clock.now());
    const r = this.#state.refreshes;
    const bySymbol = r?.day === day ? r.bySymbol : {};
    const all = Object.values(bySymbol).reduce((a, n) => a + n, 0);
    if (all >= MAX_OPEN_REFRESHES_PER_DAY_ALL) {
      return { noRefresh: `the strategy loop's ${MAX_OPEN_REFRESHES_PER_DAY_ALL} refresh_prices for ${day} (UTC), all symbols, are used; the next may go after 00:00 UTC` };
    }
    if ((bySymbol[symbol] ?? 0) < MAX_OPEN_REFRESHES_PER_DAY) return {};
    return { noRefresh: `the strategy loop's ${MAX_OPEN_REFRESHES_PER_DAY} refresh_prices of ${symbol} for ${day} (UTC) are used; the next may go after 00:00 UTC` };
  }

  /** `n` refresh_prices an open of `symbol` paid for, counted in the saved state; journaled when a day's cap is hit. */
  #countRefresh(symbol: string, n = 1): void {
    const day = this.#day(this.#o.clock.now());
    const r = this.#state.refreshes;
    const bySymbol = r?.day === day ? { ...r.bySymbol } : {};
    const before = bySymbol[symbol] ?? 0;
    const allBefore = Object.values(bySymbol).reduce((a, x) => a + x, 0);
    const used = before + n;
    bySymbol[symbol] = used;
    this.#state = { ...this.#state, refreshes: { day, bySymbol } };
    this.#save();
    if (before < MAX_OPEN_REFRESHES_PER_DAY && used >= MAX_OPEN_REFRESHES_PER_DAY) {
      this.#journal('refused', `refresh_prices cap: the strategy loop's opens sent ${used} refresh_prices of ${symbol} on ${day} (UTC), the most a day; no open of ${symbol} that needs one is sent before 00:00 UTC`, { symbol, refreshes: used });
    }
    const all = allBefore + n;
    if (allBefore < MAX_OPEN_REFRESHES_PER_DAY_ALL && all >= MAX_OPEN_REFRESHES_PER_DAY_ALL) {
      this.#journal('refused', `refresh_prices cap: the strategy loop's opens sent ${all} refresh_prices on ${day} (UTC) over all symbols, the most a day; no open that needs one is sent before 00:00 UTC`, { refreshes: all });
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

/** When the hourly check after `now` runs: HOUR_GRACE_MS past the next top of the hour, or this hour's when not yet run. */
export function nextHourlyCheck(now: number): number {
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  return now - hourStart >= HOUR_GRACE_MS ? hourStart + HOUR_MS + HOUR_GRACE_MS : hourStart + HOUR_GRACE_MS;
}

function symbolIs(s: { symbol: string } | { refused: string }, symbol: string): boolean {
  return 'symbol' in s && s.symbol === symbol;
}

/** The owner's hourly-check counts, as decide() takes them; a config read before the settings existed gets LOOP_RULES'. */
export function checkRulesOf(s: StrategyConfig): CheckRules {
  return {
    enterAfterChecks: s.enterAfterChecks ?? LOOP_RULES.enterAfterChecks,
    exitAfterChecks: s.exitAfterChecks ?? LOOP_RULES.exitAfterChecks,
  };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** How a demo entry's journal lines name it: the profit checks waived, the round trip estimated and the most accepted. */
function demoText(d: DemoCost): string {
  return `owner demo entry: the profit checks are waived; round trip ${money(d.roundTripUsd)} estimated, at most ${money(d.maxLossUsd)} accepted`;
}

/** A wait as a journal line says it: "5 s", "2 min 40 s", "10 min". */
function waitText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`;
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
