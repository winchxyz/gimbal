// Two-leg open and close. Both legs go out at once; the targets are absolute positions (the start read from each
// venue, plus or minus the size), so every later step compares the venue's own state with a target.
//
// Legging guard (open): a leg that did not reach its target is retried once for what is missing; if it still falls
// short, both legs go back to their start with reduce-only orders, so a failed open ends where it began. Close
// mirrors it: a leg that did not close is retried once; if it stays open, the leg that closed is reopened against it,
// so the desk is left hedged (and the pair reported stuck), never with one leg alone.
//
// Outcome unknown: a leg whose order did not prove what it did is read back from the venue before anything else is
// sent for it. A Hyperliquid order is read only once no copy of it can execute any more (after the expiresAfter of
// its signed payload); one without a known expiry (C5, or an MPC timeout: no payload) may land at any time, so it is
// never retried: its partner goes back reduce-only and the pair is stuck. If a read fails, the pair stops: nothing
// more is sent for either leg, and the result says why.
//
// Unsettled orders: such an order (no answer, no expiry, not run when read) can still run until Hyperliquid's nonce
// window ends, 2 days after it was signed. Its leg stays watched until then: read every 15 s (nothing pushes
// Hyperliquid positions), and a move away from where the trader left it means the order ran, after which the leg is
// reconciled against the pair's intent like a replayed copy. The pair means that leg to offset its partner. A move
// that stops with one leg not offset (a close whose Orderly leg is flat while the Hyperliquid reduce-only has no
// answer) is unhedged: the result says so and `unhedged` is set; the watch clears it once the order runs and the
// pair offsets again, and raises it again when the window ends with the order never run.
//
// Replays (Orderly): every signed order is public and can be sent again inside Orderly's 300 s window, a refused or
// unfilled one too. Every order that got a signature arms the leg's watch for that window; a position push during it
// is checked against the pair's final intent (what the last open or close left each leg holding). An excess is closed
// reduce-only; a deficit (a copy of a reducing order) leaves the pair unhedged, so the partner is closed reduce-only
// by the same amount.
//
// Reduce-only moves are split into orders under the policy's notional cap; a close never needs one order larger than
// the open it undoes, but a position grown by copies can. Each order prices itself again when it goes out, so a
// chunk sized at the cap now could be over it after an uptick: chunks are sized under the cap by the policy's price
// band, and still fit at any price inside it.

import type { TxRef, VenueId } from '@gimbal/shared';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import type { LegOutcome, LegRef, LegSide, TradeLeg } from './legs.ts';
import { HL_EXPIRY_MARGIN_MS, HL_NONCE_WINDOW_MS, LegCheckError, ORDERLY_REPLAY_MS, wasSigned } from './legs.ts';
import { abs, commonLot, floorToLot, qtyString, signedQtyString, toQty } from './lots.ts';

/** Orderly takes a signed request until 300 s after its timestamp; a little more covers clock skew. */
export const REPLAY_WINDOW_MS = ORDERLY_REPLAY_MS;
/** How long an unsettled order (no answer, no expiry) can still run after it was sent: Hyperliquid's nonce window. */
export const UNSETTLED_WATCH_MS = HL_NONCE_WINDOW_MS + HL_EXPIRY_MARGIN_MS;
/** How often a leg with an unsettled order is read while it is watched. */
export const UNSETTLED_POLL_MS = 15_000;
/** A split reduce-only move stops after this many orders; what is left is the caller's to judge. */
const MAX_CHUNKS = 10;

export type PairStatus =
  | 'open'        // both legs at their open targets
  | 'closed'      // both legs at their close targets
  | 'flat'        // an open that did not happen: both legs back at their start
  | 'stuck'       // a leg could not reach its target; the desk is hedged or a position is unknown (see notes)
  | 'unhedged';   // one leg is exposed alone: the owner must act

export interface LegOrderRecord {
  ref: LegRef;
  outcome: LegOutcome['kind'];
  filled: string | null;         // canonical, when the venue said
  avgPx: number | null;
  error: string | null;
  purpose: 'open' | 'retry' | 'unwind' | 'close' | 'rehedge' | 'excess' | 'deficit';
}

export interface LegReport {
  venue: VenueId;
  symbol: string;
  start: string;                 // signed, canonical
  target: string;
  final: string | null;          // null: unknown (the read failed)
  orders: LegOrderRecord[];
}

export interface PairResult {
  status: PairStatus;
  size: string;
  legs: [LegReport, LegReport];
  notes: string[];
  tx: TxRef[];
}

/** What one push check did: the watched leg first, then its partner when a deficit moved it. */
export interface WatchReport {
  status:
    | 'reconciled'   // an excess was closed: the leg holds its intent again
    | 'rehedged'     // a deficit, matched by closing the partner by as much: hedged again, at a smaller size
    | 'settled'      // an unsettled order ran and left its leg at its intent: the legs offset each other again
    | 'unhedged'     // a deficit the partner could not match, or an unsettled order that never ran: the owner must act
    | 'unknown';     // a position or the intent is unknown: nothing was traded
  legs: LegReport[];
  notes: string[];
  tx: TxRef[];
}

export interface PairTraderOptions {
  legs: [TradeLeg, TradeLeg];
  /** policy.price_band_bps: how far under the cap a reduce-only chunk is sized (see the header). */
  priceBandBps: number;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Every push check that found the leg off its intent, and every change an unsettled order's watch saw. */
  onWatch?: (report: WatchReport) => void;
  /** How often a leg with an unsettled order is read (default UNSETTLED_POLL_MS); null: only positionPushed feeds it. */
  unsettledPollMs?: number | null;
}

/** An unsettled order on a leg: it can still run until `until` (local ms). */
interface Unsettled {
  ref: LegRef;
  until: number;
}

interface LegRun {
  leg: TradeLeg;
  start: bigint;
  target: bigint;
  pos: bigint | null;
  /** An order with no answer and no expiry that had not run when read: it may still, so nothing more goes on this leg. */
  unsettled: LegOutcome | null;
  report: LegReport;
}

export class PairTrader {
  readonly legs: [TradeLeg, TradeLeg];
  readonly lot: bigint;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (line: string) => void;
  readonly #onWatch: (report: WatchReport) => void;
  readonly #bandBps: number;
  readonly #pollMs: number | null;
  #queue: Promise<unknown> = Promise.resolve();
  /**
   * What each leg should hold: the final position of the last open or close (null: it was unknown); for a leg with an
   * unsettled order, what offsets its partner.
   */
  readonly #intent = new Map<TradeLeg, bigint | null>();
  /** Where the trader last knew each leg to be (a result or a check); an unsettled leg that moves from it ran its order. */
  readonly #known = new Map<TradeLeg, bigint | null>();
  /** What both legs together should hold: the sum of the last open's or close's targets (0 for a plain pair). */
  #net = 0n;
  /** Replayable legs: until when (local ms) a signed copy of one of their orders can still land. */
  readonly #until = new Map<TradeLeg, number>();
  /** Legs with an unsettled order (see the header). */
  readonly #unsettled = new Map<TradeLeg, Unsettled>();
  /** Legs whose unsettled order is being read on the poll. */
  readonly #polling = new Set<TradeLeg>();
  /** One queued check per leg: a push that arrives while it waits is covered by its fresh read. */
  readonly #pending = new Map<TradeLeg, Promise<void>>();

  /** The last push check that found a leg off its intent (for logs and tests). */
  lastWatch: WatchReport | null = null;
  /**
   * Why the pair is exposed: set by an unhedged result or watch check; cleared by the next open or close, or by a watch
   * check that leaves the legs offsetting each other again.
   */
  unhedged: string | null = null;

  constructor(options: PairTraderOptions) {
    if (!Number.isFinite(options.priceBandBps) || options.priceBandBps < 0) throw new Error(`priceBandBps must be 0 or more, got ${options.priceBandBps}`);
    this.legs = options.legs;
    this.lot = commonLot(options.legs[0].lot, options.legs[1].lot);
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#log = options.log ?? (() => {});
    this.#onWatch = options.onWatch ?? (() => {});
    this.#bandBps = options.priceBandBps;
    this.#pollMs = options.unsettledPollMs === undefined ? UNSETTLED_POLL_MS : options.unsettledPollMs;
  }

  /** `size` in base units, rounded down to the coarser lot; leg `longIndex` buys, the other sells. */
  open(request: { size: bigint | number | string; longIndex: 0 | 1; reason: string }): Promise<PairResult> {
    return this.#serial(() => this.#open(request));
  }

  /** Brings both legs to `targets` (default flat) with reduce-only orders. */
  close(request: { reason: string; targets?: [bigint, bigint] }): Promise<PairResult> {
    return this.#serial(() => this.#close(request));
  }

  /**
   * A position the venue pushed (or a session's seed read, or the unsettled poll's read) for a watched leg. Inside a
   * replayable leg's replay window, a position off the pair's intent queues one check (after whatever the trader is
   * doing now), which reads the venue again and closes an excess or matches a deficit on the partner. On a leg with an
   * unsettled order, a position away from where the trader left it does the same: the order ran. Resolves when
   * handled; never rejects.
   */
  positionPushed(leg: TradeLeg, position: bigint): Promise<void> {
    if (!this.watching(leg)) {
      this.#until.delete(leg);
      if (this.#unsettled.has(leg)) return this.#serial(() => this.#lapse(leg)).catch((err) => this.#log(`${leg.venue} ${leg.symbol}: ${errorText(err)}`));
      return Promise.resolve();
    }
    const unsettled = this.#unsettled.has(leg);
    if (unsettled ? this.#known.get(leg) === position : this.#intent.get(leg) === position) return Promise.resolve();
    const queued = this.#pending.get(leg);
    if (queued !== undefined) return queued;
    // The push is the newest state: the check reads from it on, not from when its turn comes.
    const seenAt = this.#clock.now() - 50;
    const task = this.#serial(async () => {
      this.#pending.delete(leg);
      if (!this.watching(leg)) return;      // the window closed while the check waited its turn
      await this.#check(leg, position, seenAt);
    }).catch((err) => this.#log(`${leg.venue} ${leg.symbol}: the push check failed: ${errorText(err)}`));
    this.#pending.set(leg, task);
    return task;
  }

  /**
   * Whether a leg is watched: a replayable leg inside the replay window of one of its signed orders, or a leg with an
   * unsettled order that can still run.
   */
  watching(leg: TradeLeg): boolean {
    const now = this.#clock.now();
    const until = this.#until.get(leg);
    const unsettled = this.#unsettled.get(leg);
    return (until !== undefined && now <= until) || (unsettled !== undefined && now <= unsettled.until);
  }

  /** The unsettled order on a leg, while it can still run. */
  unsettled(leg: TradeLeg): { ref: LegRef; until: number } | null {
    const u = this.#unsettled.get(leg);
    return u === undefined ? null : { ref: u.ref, until: u.until };
  }

  /** What the pair means each leg to hold now (null: unknown; undefined: no open or close yet). */
  intent(leg: TradeLeg): bigint | null | undefined {
    return this.#intent.get(leg);
  }

  async #open(request: { size: bigint | number | string; longIndex: 0 | 1; reason: string }): Promise<PairResult> {
    const size = floorToLot(typeof request.size === 'bigint' ? request.size : toQty(request.size), this.lot);
    if (size === 0n) throw new LegCheckError(`size ${String(request.size)} is under one common lot ${qtyString(this.lot)}`);
    // Nothing is signed until both venues and the policy accept the size and both starts are known.
    await Promise.all(this.legs.map((leg) => leg.check(size, false)));
    const starts = await Promise.all(this.legs.map((leg) => leg.position()));
    const runs = this.legs.map((leg, i) => {
      const target = starts[i]! + (i === request.longIndex ? size : -size);
      return this.#run(leg, starts[i]!, target);
    }) as [LegRun, LegRun];
    this.#log(`open ${qtyString(size)}: ${runs.map((r) => `${r.leg.venue} ${r.leg.symbol} ${signedQtyString(r.start)} -> ${signedQtyString(r.target)}`).join(', ')}`);
    const notes: string[] = [];
    const net = starts[0]! + starts[1]!;

    await Promise.all(runs.map((r) => this.#move(r, r.target, false, request.reason, 'open')));
    if (this.#stopped(runs, notes)) return this.#halt(runs, notes, size, net, request.reason);
    if (runs.every((r) => r.pos === r.target)) return this.#result('open', size, runs, notes, net);
    if (runs.every((r) => r.pos === r.start)) {
      notes.push('neither leg traded: nothing to unwind');
      return this.#result('flat', size, runs, notes, net);
    }

    // Legging: retry what is missing, once.
    const short = runs.filter((r) => r.pos !== r.target);
    notes.push(`legging: ${short.map((r) => `${r.leg.venue} at ${signedQtyString(r.pos!)} of ${signedQtyString(r.target)}`).join(', ')}; retrying once`);
    await Promise.all(short.map((r) => this.#move(r, r.target, false, `${request.reason} (retry)`, 'retry')));
    if (this.#stopped(runs, notes)) return this.#halt(runs, notes, size, net, request.reason);
    if (runs.every((r) => r.pos === r.target)) return this.#result('open', size, runs, notes, net);

    // Still legged: both legs back to their start, reduce-only, with one retry each.
    notes.push(`still legged after the retry: unwinding both legs to their start`);
    for (const r of runs) r.target = r.start;
    for (let attempt = 0; attempt < 2; attempt++) {
      const off = runs.filter((r) => r.pos !== r.start);
      if (off.length === 0) break;
      await Promise.all(off.map((r) => this.#move(r, r.start, true, `${request.reason} (unwind${attempt === 0 ? '' : ' retry'})`, 'unwind')));
      if (this.#stopped(runs, notes)) return this.#stop(size, runs, notes, net);
    }
    if (runs.every((r) => r.pos === r.start)) return this.#result('flat', size, runs, notes, net);
    notes.push('the unwind did not bring both legs back');
    return this.#result(hedged(runs, net) ? 'stuck' : 'unhedged', size, runs, notes, net);
  }

  async #close(request: { reason: string; targets?: [bigint, bigint] }): Promise<PairResult> {
    const targets = request.targets ?? [0n, 0n];
    const starts = await Promise.all(this.legs.map((leg) => leg.position()));
    const runs = this.legs.map((leg, i) => this.#run(leg, starts[i]!, targets[i]!)) as [LegRun, LegRun];
    const size = abs(starts[0]! - targets[0]!) > abs(starts[1]! - targets[1]!) ? abs(starts[0]! - targets[0]!) : abs(starts[1]! - targets[1]!);
    const notes: string[] = [];
    const net = targets[0] + targets[1];
    if (runs.every((r) => r.pos === r.target)) {
      notes.push('both legs were already at their close targets');
      return this.#result('closed', size, runs, notes, net);
    }
    this.#log(`close: ${runs.map((r) => `${r.leg.venue} ${r.leg.symbol} ${signedQtyString(r.start)} -> ${signedQtyString(r.target)}`).join(', ')}`);
    for (const r of runs) {
      if (crossesZero(r.start, r.target)) notes.push(`${r.leg.venue}: target ${signedQtyString(r.target)} is on the other side of zero; a reduce-only close stops at 0`);
    }

    // A leg left unsettled here is not retried and its partner's close stands (it only reduced): if that leaves the
    // partner closed and the unsettled leg open, the pair is unhedged until the order runs (#stop).
    await Promise.all(runs.filter((r) => r.pos !== r.target).map((r) => this.#move(r, r.target, true, request.reason, 'close')));
    if (this.#stopped(runs, notes)) return this.#stop(size, runs, notes, net);
    if (runs.every((r) => r.pos === r.target)) return this.#result('closed', size, runs, notes, net);

    const open = runs.filter((r) => r.pos !== r.target);
    notes.push(`not closed: ${open.map((r) => `${r.leg.venue} at ${signedQtyString(r.pos!)}`).join(', ')}; retrying once`);
    await Promise.all(open.map((r) => this.#move(r, r.target, true, `${request.reason} (retry)`, 'retry')));
    if (this.#stopped(runs, notes)) return this.#stop(size, runs, notes, net);
    if (runs.every((r) => r.pos === r.target)) return this.#result('closed', size, runs, notes, net);

    // One leg stays open: reopen the other against what it still holds, so neither is left alone.
    const [a, b] = runs;
    const exposure = (r: LegRun) => r.pos! - r.target;
    const residual = exposure(a) + exposure(b);   // what the pair holds net of its targets; 0 = still hedged
    if (residual === 0n) {
      notes.push('the legs that stayed open still offset each other: hedged, not closed');
      return this.#result('stuck', size, runs, notes, net);
    }
    const lighter = abs(exposure(a)) <= abs(exposure(b)) ? a : b;
    const hedgeTo = lighter.pos! - residual;
    notes.push(`re-hedging: ${lighter.leg.venue} back to ${signedQtyString(hedgeTo)} against the leg that stayed open`);
    lighter.target = hedgeTo;
    await this.#move(lighter, hedgeTo, false, `${request.reason} (re-hedge)`, 'rehedge');
    if (this.#stopped(runs, notes)) return this.#stop(size, runs, notes, net);
    return this.#result(hedged(runs, net) ? 'stuck' : 'unhedged', size, runs, notes, net);
  }

  /**
   * An open stopped by an unsettled leg: the other leg goes back to its start reduce-only (twice at most). Stuck when
   * that leaves the legs offsetting each other (the unsettled order can still land; its watch then closes it back),
   * unhedged when it does not (#stop). A lost position stops all.
   */
  async #halt(runs: [LegRun, LegRun], notes: string[], size: bigint, net: bigint, reason: string): Promise<PairResult> {
    if (runs.some((r) => r.pos === null)) return this.#result('stuck', size, runs, notes, net);
    const others = runs.filter((r) => r.unsettled === null);
    for (const r of others) r.target = r.start;
    for (let attempt = 0; attempt < 2; attempt++) {
      const off = others.filter((r) => r.pos !== null && r.pos !== r.start);
      if (off.length === 0) break;
      await Promise.all(off.map((r) => this.#move(r, r.start, true, `${reason} (unwind${attempt === 0 ? '' : ' retry'})`, 'unwind')));
    }
    if (others.some((r) => r.pos !== r.start)) notes.push(`the unwind did not bring ${others.filter((r) => r.pos !== r.start).map((r) => r.leg.venue).join(' and ')} back to its start`);
    return this.#stop(size, runs, notes, net);
  }

  /**
   * A move that stopped on an unsettled order or a lost position. With both positions known and not offsetting each
   * other (one leg flat, its partner still open behind an unsettled order) it is unhedged: the owner is alerted, and
   * the unsettled leg stays watched (#result). Otherwise stuck: hedged now, or a position is unknown.
   */
  #stop(size: bigint, runs: [LegRun, LegRun], notes: string[], net: bigint): PairResult {
    if (runs.every((r) => r.pos !== null) && !hedged(runs, net)) {
      const waiting = runs.filter((r) => r.unsettled !== null)
        .map((r) => `; the ${r.leg.venue} order with no answer (${refId(r.unsettled!.ref)}) may still run and is watched until ${iso(r.unsettled!.ref.sentAt + UNSETTLED_WATCH_MS)}`);
      notes.push(`unhedged: ${runs.map((r) => `${r.leg.venue} holds ${signedQtyString(r.pos!)}`).join(', ')}, which do not offset each other${waiting.join('')}`);
      return this.#result('unhedged', size, runs, notes, net);
    }
    return this.#result('stuck', size, runs, notes, net);
  }

  #run(leg: TradeLeg, start: bigint, target: bigint): LegRun {
    return {
      leg, start, target, pos: start, unsettled: null,
      report: { venue: leg.venue, symbol: leg.symbol, start: signedQtyString(start), target: signedQtyString(target), final: null, orders: [] },
    };
  }

  /**
   * Moves the leg from its known position toward `target`: one order, or for a reduce-only move orders split under
   * the policy cap (the next goes only when the last one filled in full). After it, a replayable leg found past the
   * target (a copy landed) is trimmed back. Stops on a lost position or an unsettled order.
   */
  async #move(r: LegRun, target: bigint, reduceOnly: boolean, reason: string, purpose: LegOrderRecord['purpose'], trim = true): Promise<void> {
    let dir = 0n;
    for (let n = 0; n < MAX_CHUNKS; n++) {
      if (r.pos === null || r.unsettled !== null) return;
      const from = r.pos;
      let delta = target - from;
      if (reduceOnly && crossesZero(from, target)) delta = -from;   // reduce-only stops at 0
      if (delta === 0n) break;
      dir = delta;
      const side: LegSide = delta > 0n ? 'BUY' : 'SELL';
      const want = abs(delta);
      const size = reduceOnly ? await this.#chunk(r.leg, side, want) : want;
      const out = await this.#send(r, side, size, reduceOnly, reason, purpose);
      await this.#settle(r, from, side, out);
      if (size === want || out.kind !== 'filled' || out.filled !== size) break;
    }
    const past = r.pos !== null && dir !== 0n && (dir > 0n ? r.pos > target : r.pos < target);
    if (trim && past && r.leg.replayable) await this.#trim(r, `reconcile ${r.leg.symbol}`);
  }

  /** Closes what a replayable leg holds past its target, reduce-only, up to twice (a copy can land meanwhile). */
  async #trim(r: LegRun, reason: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (r.pos === null || r.unsettled !== null) return;
      const to = reducedTarget(r.pos, r.target);
      if (to === null) return;
      const excess = qtyString(abs(r.pos - to));
      this.#log(`${r.leg.venue} ${r.leg.symbol}: holds ${signedQtyString(r.pos)}, target ${signedQtyString(r.target)}: closing ${excess} reduce-only`);
      await this.#move(r, to, true, `${reason}: close ${excess} over the target`, 'excess', false);
    }
  }

  /**
   * The order size for a reduce-only move: all of it, or the most the policy cap allows in one order, less the price
   * band. The cap is valued at today's price, and the order prices itself again when it goes out: sized at the cap,
   * an uptick would put it over and stop the split half way.
   */
  async #chunk(leg: TradeLeg, side: LegSide, want: bigint): Promise<bigint> {
    let max: bigint;
    try {
      const cap = await leg.maxSize(side, true);
      const keep = BigInt(Math.max(0, 10_000 - Math.ceil(this.#bandBps)));
      max = floorToLot((abs(cap) * keep) / 10_000n, leg.lot);
      // Under one lot after the band: one lot still fits at today's price, and nothing smaller can be sent.
      if (max === 0n) max = floorToLot(cap, leg.lot);
    } catch (err) {
      this.#log(`${leg.venue} ${leg.symbol}: no size cap known (${errorText(err)}); sending ${qtyString(want)} whole`);
      return want;
    }
    if (max > 0n && want > max) {
      this.#log(`${leg.venue} ${leg.symbol}: ${qtyString(want)} reduce-only is over the policy cap: splitting into orders of ${qtyString(max)} (the cap less the ${this.#bandBps} bps band)`);
      return max;
    }
    return want;
  }

  async #send(r: LegRun, side: LegSide, size: bigint, reduceOnly: boolean, reason: string, purpose: LegOrderRecord['purpose']): Promise<LegOutcome> {
    const out = await r.leg.order(side, size, reduceOnly, reason);
    r.report.orders.push(record(out, purpose));
    this.#log(`${r.leg.venue} ${purpose} ${side} ${qtyString(size)}${reduceOnly ? ' reduce-only' : ''}: ${describe(out)}`);
    this.#arm(r.leg, out);
    return out;
  }

  /** A signed order on a replayable leg can be sent again by anyone until its window ends, whatever it answered. */
  #arm(leg: TradeLeg, out: LegOutcome): void {
    if (!leg.replayable || !wasSigned(out)) return;
    const until = out.kind === 'unknown' && out.expiresAt !== null ? out.expiresAt : out.ref.sentAt + REPLAY_WINDOW_MS;
    this.#until.set(leg, Math.max(this.#until.get(leg) ?? 0, until));
  }

  /**
   * The leg's position after one order: from the fill on a leg that cannot be replayed; from the venue on one that
   * can (old position plus the fill if that read fails: the watch still covers it) or when the outcome is unknown;
   * unchanged on proof that nothing ran.
   */
  async #settle(r: LegRun, from: bigint, side: LegSide, out: LegOutcome): Promise<void> {
    const leg = r.leg;
    if (out.kind === 'failed') return;
    if (out.kind === 'filled') {
      const filledTo = from + (side === 'BUY' ? out.filled : -out.filled);
      if (!leg.replayable) {
        r.pos = filledTo;
        return;
      }
      try {
        r.pos = await leg.position(out.ref.settledAt ?? out.ref.sentAt);
      } catch (err) {
        this.#log(`${leg.venue} ${leg.symbol}: position unreadable after a fill (${errorText(err)}); counting ${signedQtyString(from)} plus the fill = ${signedQtyString(filledTo)}, the replay watch stays on`);
        r.pos = filledTo;
      }
      return;
    }
    if (leg.replayable) {
      r.pos = await this.#read(leg, out.ref.sentAt, 'after an order whose outcome is unknown');
      return;
    }
    if (out.expiresAt !== null) {
      // Before its expiresAfter the order may still execute: a read now could miss it and the retry double it.
      const wait = out.expiresAt - this.#clock.now();
      if (wait > 0) {
        this.#log(`${leg.venue} ${leg.symbol}: outcome unknown; waiting ${Math.ceil(wait / 1000)} s until the order has expired before reading the position`);
        await this.#sleep(wait);
      }
      r.pos = await this.#read(leg, undefined, 'after the order expired');
      return;
    }
    // No known expiry (a contract before C6, or an MPC timeout with no payload): a late signature can still execute it. A position that moved shows it ran (a
    // signed action runs once); one that did not leaves it pending, and nothing more is sent on this leg.
    r.pos = await this.#read(leg, undefined, 'after an order whose outcome is unknown');
    if (r.pos === from) r.unsettled = out;
  }

  async #read(leg: TradeLeg, after: number | undefined, why: string): Promise<bigint | null> {
    try {
      return await leg.position(after);
    } catch (err) {
      this.#log(`${leg.venue} ${leg.symbol}: position unknown (${why}): ${errorText(err)}`);
      return null;
    }
  }

  /**
   * One watch check: the venue's position against the pair's intent for the leg (see the header). On a leg with an
   * unsettled order, only a move away from where the trader left it counts: the order ran, and the leg is then
   * reconciled like any other.
   */
  async #check(leg: TradeLeg, pushed: bigint, seenAt: number): Promise<void> {
    const notes: string[] = [];
    const intent = this.#intent.get(leg) ?? null;
    const unsettled = this.#unsettled.get(leg);
    const run = this.#run(leg, pushed, intent ?? pushed);
    if (intent === null) {
      // Nothing can be reconciled; an unsettled leg is looked at again only once it moves from here.
      if (unsettled !== undefined) this.#known.set(leg, pushed);
      notes.push(`${leg.venue} ${leg.symbol}: a push shows ${signedQtyString(pushed)}, but the pair's last result left this leg unknown: nothing is traded`);
      return this.#watched('unknown', [run], notes);
    }
    // A leg without replays (Hyperliquid) has no copies to wait out: its position is read as it is now.
    const pos = await this.#read(leg, unsettled === undefined ? seenAt : undefined, 'push check');
    if (pos === null) {
      notes.push(`${leg.venue} ${leg.symbol}: a push shows ${signedQtyString(pushed)} against the intent ${signedQtyString(intent)}, and the venue cannot be read: nothing is traded`);
      return this.#watched('unknown', [run], notes);
    }
    if (unsettled !== undefined) {
      const was = this.#known.get(leg) ?? null;
      if (pos === was) return;                // the order has not run (the push was older than the venue's state)
      // A signed action runs once: the leg moved, so its order ran (in full, or in part for an IOC), and nothing on
      // this leg can land any more.
      this.#unsettled.delete(leg);
      notes.push(`${leg.venue} ${unsettled.ref.side} ${unsettled.ref.size} (${refId(unsettled.ref)}), which had no answer, ran: ${was === null ? 'unknown' : signedQtyString(was)} -> ${signedQtyString(pos)}`);
      if (pos === intent) {
        run.start = was ?? pos;
        run.pos = pos;
        run.report.start = signedQtyString(run.start);
        this.#known.set(leg, pos);
        if (this.#offsets()) return this.#watched('settled', [run], notes);
        const partner = this.#partner(leg);
        notes.push(`unhedged: ${leg.venue} holds ${signedQtyString(pos)}, its intent, but ${partner.venue} holds ${knownText(this.#known.get(partner))}: the legs do not offset each other`);
        this.unhedged = notes.at(-1)!;
        return this.#watched('unhedged', [run], notes);
      }
    } else if (pos === intent) {
      return;                                 // the push was older than the venue's state
    }
    run.start = pos;
    run.pos = pos;
    run.report.start = signedQtyString(pos);
    this.#log(`${leg.venue} ${leg.symbol}: holds ${signedQtyString(pos)} against the intent ${signedQtyString(intent)}: reconciling`);
    await this.#trim(run, `reconcile ${leg.symbol}`);
    if (run.pos === null) {
      notes.push(`${leg.venue} ${leg.symbol}: position unknown after the excess close`);
      this.#intent.set(leg, null);
      return this.#watched('unknown', [run], notes);
    }
    if (run.pos === intent) return this.#watched('reconciled', [run], notes);
    if (run.unsettled !== null) {
      // The excess close has no answer and no expiry: it may still run, so nothing more is sent; the watch goes on.
      notes.push(`unhedged: ${leg.venue} holds ${signedQtyString(run.pos)} against its intent ${signedQtyString(intent)}, and the reduce-only close has no answer: it may still run, and is watched`);
      this.unhedged = notes.at(-1)!;
      return this.#watched('unhedged', [run], notes);
    }

    // A deficit: a copy of a reducing order landed, and this leg no longer offsets its partner in full.
    const missing = intent - run.pos;
    const exposed = `unhedged: ${leg.venue} holds ${signedQtyString(run.pos)}, ${qtyString(abs(missing))} short of its intent ${signedQtyString(intent)}`;
    notes.push(exposed);
    this.#intent.set(leg, run.pos);
    const partner = this.#partner(leg);
    if (this.#unsettled.has(partner)) {
      // Its own order may still run: another one on it could double that.
      notes.push(`${partner.venue} has an order with no answer that may still run: not matched`);
      this.unhedged = exposed;
      return this.#watched('unhedged', [run], notes);
    }
    const partnerIntent = this.#intent.get(partner) ?? null;
    const partnerPos = partnerIntent === null ? null : await this.#read(partner, undefined, 'deficit on its partner');
    if (partnerIntent === null || partnerPos === null) {
      notes.push(`${partner.venue}: position unknown: not matched`);
      this.unhedged = exposed;
      return this.#watched('unhedged', [run], notes);
    }
    const hedgeTo = partnerIntent + missing;
    const p = this.#run(partner, partnerPos, hedgeTo);
    const to = reducedTarget(partnerPos, hedgeTo);
    if (to === null) {
      notes.push(`${partner.venue} holds ${signedQtyString(partnerPos)}: matching needs ${signedQtyString(hedgeTo)}, which a reduce-only order cannot reach`);
    } else {
      notes.push(`closing ${partner.venue} reduce-only by the deficit: ${signedQtyString(partnerPos)} -> ${signedQtyString(to)}`);
      await this.#move(p, to, true, `reconcile ${partner.symbol}: close ${qtyString(abs(missing))} its partner lost`, 'deficit');
    }
    this.#intent.set(partner, p.pos);
    const matched = p.pos !== null && p.pos + run.pos === partnerIntent + intent;
    if (!matched) this.unhedged = exposed;
    return this.#watched(matched ? 'rehedged' : 'unhedged', [run, p], notes);
  }

  #watched(status: WatchReport['status'], runs: LegRun[], notes: string[]): void {
    for (const r of runs) {
      r.report.target = signedQtyString(r.target);
      r.report.final = r.pos === null ? null : signedQtyString(r.pos);
      // An 'unknown' run holds what was pushed, not what was read: an unsettled leg must still be compared with
      // where the trader left it.
      if (status !== 'unknown') this.#known.set(r.leg, r.pos);
      if (r.unsettled !== null) this.#armUnsettled(r);
    }
    if (status !== 'unhedged' && status !== 'unknown' && this.#offsets()) this.unhedged = null;
    const report: WatchReport = { status, legs: runs.map((r) => r.report), notes, tx: runs.flatMap((r) => r.report.orders.flatMap((o) => o.ref.tx)) };
    this.lastWatch = report;
    this.#log(`watch ${status}: ${runs.map((r) => `${r.leg.venue} ${r.report.final ?? 'unknown'}`).join(', ')}${notes.length === 0 ? '' : ` (${notes.join('; ')})`}`);
    this.#onWatch(report);
  }

  /** True (with a note) when a leg's position is unknown or an order on it is unsettled: the pair stops there. */
  #stopped(runs: LegRun[], notes: string[]): boolean {
    const lost = runs.filter((r) => r.pos === null);
    if (lost.length > 0) {
      notes.push(`position unknown on ${lost.map((r) => r.leg.venue).join(' and ')} after an order whose outcome is not proven: nothing more is sent; reconcile by the ids in the orders`);
      return true;
    }
    const pending = runs.filter((r) => r.unsettled !== null);
    if (pending.length === 0) return false;
    for (const r of pending) {
      const ref = r.unsettled!.ref;
      notes.push(`${r.leg.venue} ${ref.side} ${ref.size} (${ref.clientId ?? ref.orderId ?? 'no id'}) has no answer and no expiry, and had not run when read: it may still execute, so it is not retried; reconcile by its NEAR tx`);
    }
    return true;
  }

  #result(status: PairStatus, size: bigint, runs: [LegRun, LegRun], notes: string[], net: bigint): PairResult {
    this.#net = net;
    for (const r of runs) {
      r.report.target = signedQtyString(r.target);
      r.report.final = r.pos === null ? null : signedQtyString(r.pos);
      // The watch holds each leg to where this result left it: the target when it was reached, the start of a flat
      // open, the last known position when stuck or unhedged (null: unknown, and the watch trades nothing).
      this.#intent.set(r.leg, r.pos);
      this.#known.set(r.leg, r.pos);
      // A reduce-only order cannot move a flat leg: an older unsettled one has nothing left to do there.
      if (r.unsettled === null && r.pos === 0n && this.#unsettled.get(r.leg)?.ref.reduceOnly === true) this.#unsettled.delete(r.leg);
    }
    for (const [i, r] of runs.entries()) {
      if (r.unsettled === null) continue;
      // The pair means this leg to offset its partner: where its order takes it, or a reconcile once it ran.
      const partner = runs[i === 0 ? 1 : 0];
      if (r.pos !== null && partner.pos !== null && partner.unsettled === null) this.#intent.set(r.leg, net - partner.pos);
      this.#armUnsettled(r);
    }
    this.unhedged = status === 'unhedged' ? notes.at(-1) ?? 'unhedged' : null;
    const tx = runs.flatMap((r) => r.report.orders.flatMap((o) => o.ref.tx));
    this.#log(`${status}: ${runs.map((r) => `${r.leg.venue} ${r.report.final ?? 'unknown'}`).join(', ')}`);
    return { status, size: qtyString(size), legs: [runs[0].report, runs[1].report], notes, tx };
  }

  /** Watches the leg of an unsettled order until it can no longer run, and starts its poll. */
  #armUnsettled(r: LegRun): void {
    const ref = r.unsettled!.ref;
    this.#unsettled.set(r.leg, { ref, until: ref.sentAt + UNSETTLED_WATCH_MS });
    this.#log(`${r.leg.venue} ${r.leg.symbol}: ${ref.side} ${ref.size} (${refId(ref)}) has no answer and may still run: watched until ${iso(ref.sentAt + UNSETTLED_WATCH_MS)}`);
    this.#poll(r.leg);
  }

  /** Reads a leg with an unsettled order every #pollMs while it can still run: nothing pushes Hyperliquid positions. */
  #poll(leg: TradeLeg): void {
    const every = this.#pollMs;
    if (every === null || this.#polling.has(leg)) return;
    this.#polling.add(leg);
    const loop = async (): Promise<void> => {
      try {
        for (;;) {
          await this.#sleep(every);
          const u = this.#unsettled.get(leg);
          if (u === undefined) return;          // it ran, or a result found nothing left for it to do
          if (this.#clock.now() > u.until) {
            await this.#serial(() => this.#lapse(leg));
            if (!this.#unsettled.has(leg)) return;
            continue;
          }
          let pos: bigint;
          try {
            pos = await leg.position();
          } catch (err) {
            this.#log(`${leg.venue} ${leg.symbol}: the unsettled order's watch could not read the position: ${errorText(err)}`);
            continue;
          }
          await this.positionPushed(leg, pos);
        }
      } finally {
        // In the same step as the last look at #unsettled: a watch armed after it starts a new poll.
        this.#polling.delete(leg);
      }
    };
    loop().catch((err) => this.#log(`${leg.venue} ${leg.symbol}: the unsettled order's watch stopped: ${errorText(err)}`));
  }

  /** The window of an unsettled order ended and it never ran: it no longer can. Not offset → the alert again. */
  async #lapse(leg: TradeLeg): Promise<void> {
    const u = this.#unsettled.get(leg);
    if (u === undefined || this.#clock.now() <= u.until) return;
    this.#unsettled.delete(leg);
    const note = `${leg.venue} ${u.ref.side} ${u.ref.size} (${refId(u.ref)}) had no answer and never ran; since ${iso(u.until)} it no longer can`;
    if (this.#offsets()) {
      this.#log(`${leg.venue} ${leg.symbol}: ${note}; the legs offset each other`);
      return;
    }
    const pos = this.#known.get(leg) ?? null;
    const run = this.#run(leg, pos ?? 0n, this.#intent.get(leg) ?? pos ?? 0n);
    run.pos = pos;
    const exposed = `unhedged: ${note}; ${this.legs.map((l) => `${l.venue} holds ${knownText(this.#known.get(l))}`).join(', ')}, which do not offset each other`;
    this.unhedged = exposed;
    this.#watched('unhedged', [run], [exposed]);
  }

  /** Both legs' known positions add up to what the pair should hold together. */
  #offsets(): boolean {
    const a = this.#known.get(this.legs[0]) ?? null;
    const b = this.#known.get(this.legs[1]) ?? null;
    return a !== null && b !== null && a + b === this.#net;
  }

  #partner(leg: TradeLeg): TradeLeg {
    return this.legs[0] === leg ? this.legs[1] : this.legs[0];
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

function refId(ref: LegRef): string {
  return ref.clientId ?? ref.orderId ?? 'no id';
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function knownText(q: bigint | null | undefined): string {
  return q === null || q === undefined ? 'an unknown position' : signedQtyString(q);
}

/**
 * Where a reduce-only order can take `pos` toward `target`, or null when there is nothing to reduce: past the target
 * on its side of zero → the target; on the other side of zero → 0 (the rest is a deficit).
 */
export function reducedTarget(pos: bigint, target: bigint): bigint | null {
  if (pos === target) return null;
  if (target === 0n) return 0n;
  const sameSide = (pos > 0n) === (target > 0n) && pos !== 0n;
  if (sameSide) return abs(pos) > abs(target) ? target : null;
  return pos === 0n ? null : 0n;
}

function crossesZero(from: bigint, to: bigint): boolean {
  return (from > 0n && to < 0n) || (from < 0n && to > 0n);
}

/** The legs offset each other: together they hold what the pair's targets add up to (0 for a pair). */
function hedged(runs: LegRun[], net: bigint): boolean {
  if (runs.some((r) => r.pos === null)) return false;
  return runs.reduce((s, r) => s + r.pos!, 0n) === net;
}

function record(out: LegOutcome, purpose: LegOrderRecord['purpose']): LegOrderRecord {
  return {
    ref: out.ref, outcome: out.kind, purpose,
    filled: out.kind === 'filled' ? qtyString(out.filled) : null,
    avgPx: out.kind === 'filled' ? out.avgPx : null,
    error: out.kind === 'filled' ? null : out.error.message,
  };
}

function describe(out: LegOutcome): string {
  const id = out.ref.orderId ?? out.ref.clientId ?? 'no id';
  if (out.kind === 'filled') return `filled ${qtyString(out.filled)}${out.avgPx === null ? '' : ` at ${out.avgPx}`} (${id})`;
  return `${out.kind} (${id}): ${out.error.message}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
