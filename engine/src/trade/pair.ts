// Two-leg open and close. Both legs go out at once; the targets are absolute positions (the start read from each
// venue, plus or minus the size), so every later step compares the venue's own state with a target.
//
// Legging guard (open): a leg that did not reach its target is retried once for what is missing; if it still falls
// short, both legs go back to their start with reduce-only orders, so a failed open ends where it began. Close
// mirrors it: a leg that did not close is retried once; if it stays open, the leg that closed is reopened against it,
// so the desk is left hedged (and the pair reported stuck), never with one leg alone.
//
// Outcome unknown: a leg whose order did not prove what it did is read back from the venue before anything else is
// sent for it. If that read fails too, the pair stops: nothing more is sent for either leg, and the result says why.
//
// Replays (Orderly): a signed order is public and can be sent again inside Orderly's 300 s window. After every order
// on a replayable leg the position is read and any excess over the target is closed reduce-only; watch() keeps doing
// that on every position push until the window of the last order has passed. A deficit is reported, never "fixed".

import type { TxRef, VenueId } from '@gimbal/shared';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import type { LegOutcome, LegRef, LegSide, TradeLeg } from './legs.ts';
import { LegCheckError } from './legs.ts';
import { abs, commonLot, floorToLot, qtyString, signedQtyString, toQty } from './lots.ts';

/** Orderly takes a signed request until 300 s after its timestamp; a little more covers clock skew. */
export const REPLAY_WINDOW_MS = 310_000;

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
  purpose: 'open' | 'retry' | 'unwind' | 'close' | 'rehedge' | 'excess';
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

export interface PairTraderOptions {
  legs: [TradeLeg, TradeLeg];
  clock?: Clock;
  log?: (line: string) => void;
}

interface LegRun {
  leg: TradeLeg;
  start: bigint;
  target: bigint;
  pos: bigint | null;
  report: LegReport;
}

export class PairTrader {
  readonly legs: [TradeLeg, TradeLeg];
  readonly lot: bigint;
  readonly #clock: Clock;
  readonly #log: (line: string) => void;
  #queue: Promise<unknown> = Promise.resolve();
  /** Replayable legs under watch: the target each must hold, until when. */
  readonly #watch = new Map<TradeLeg, { target: bigint; until: number }>();

  constructor(options: PairTraderOptions) {
    this.legs = options.legs;
    this.lot = commonLot(options.legs[0].lot, options.legs[1].lot);
    this.#clock = options.clock ?? systemClock;
    this.#log = options.log ?? (() => {});
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
   * A position the venue pushed for a replayable leg: when it holds more than its watched target, the excess is closed
   * reduce-only (after whatever the trader is doing now). Feed the leg's pushes here; resolves when handled.
   */
  positionPushed(leg: TradeLeg, position: bigint): Promise<void> {
    const w = this.#watch.get(leg);
    if (w === undefined) return Promise.resolve();
    if (this.#clock.now() > w.until) {
      this.#watch.delete(leg);
      return Promise.resolve();
    }
    if (reducedTarget(position, w.target) === null) return Promise.resolve();
    return this.#serial(async () => {
      const current = this.#watch.get(leg);
      if (current === undefined) return;
      this.#log(`${leg.venue} ${leg.symbol}: a push shows ${signedQtyString(position)} against the target ${signedQtyString(current.target)}: reconciling`);
      const report: LegReport = { venue: leg.venue, symbol: leg.symbol, start: signedQtyString(position), target: signedQtyString(current.target), final: null, orders: [] };
      const final = await this.#reconcile(leg, current.target, this.#clock.now() - 1, report, 'watch');
      report.final = final === null ? null : signedQtyString(final);
      this.lastWatch = report;
    }).then(() => undefined);
  }

  /** The last reconcile a push started (for logs and tests). */
  lastWatch: LegReport | null = null;

  /** Whether a replayable leg is still inside the replay window of its last order. */
  watching(leg: TradeLeg): boolean {
    const w = this.#watch.get(leg);
    return w !== undefined && this.#clock.now() <= w.until;
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

    await Promise.all(runs.map((r) => this.#move(r, r.target, false, request.reason, 'open')));
    if (this.#unknown(runs, notes)) return this.#result('stuck', size, runs, notes);
    if (runs.every((r) => r.pos === r.target)) return this.#result('open', size, runs, notes);
    if (runs.every((r) => r.pos === r.start)) {
      notes.push('neither leg traded: nothing to unwind');
      return this.#result('flat', size, runs, notes);
    }

    // Legging: retry what is missing, once.
    const short = runs.filter((r) => r.pos !== r.target);
    notes.push(`legging: ${short.map((r) => `${r.leg.venue} at ${signedQtyString(r.pos!)} of ${signedQtyString(r.target)}`).join(', ')}; retrying once`);
    await Promise.all(short.map((r) => this.#move(r, r.target, false, `${request.reason} (retry)`, 'retry')));
    if (this.#unknown(runs, notes)) return this.#result('stuck', size, runs, notes);
    if (runs.every((r) => r.pos === r.target)) return this.#result('open', size, runs, notes);

    // Still legged: both legs back to their start, reduce-only, with one retry each.
    notes.push(`still legged after the retry: unwinding both legs to their start`);
    for (const r of runs) r.target = r.start;
    for (let attempt = 0; attempt < 2; attempt++) {
      const off = runs.filter((r) => r.pos !== r.start);
      if (off.length === 0) break;
      await Promise.all(off.map((r) => this.#move(r, r.start, true, `${request.reason} (unwind${attempt === 0 ? '' : ' retry'})`, 'unwind')));
      if (this.#unknown(runs, notes)) return this.#result('stuck', size, runs, notes);
    }
    if (runs.every((r) => r.pos === r.start)) return this.#result('flat', size, runs, notes);
    notes.push('the unwind did not bring both legs back');
    return this.#result(hedged(runs, starts[0]! + starts[1]!) ? 'stuck' : 'unhedged', size, runs, notes);
  }

  async #close(request: { reason: string; targets?: [bigint, bigint] }): Promise<PairResult> {
    const targets = request.targets ?? [0n, 0n];
    const starts = await Promise.all(this.legs.map((leg) => leg.position()));
    const runs = this.legs.map((leg, i) => this.#run(leg, starts[i]!, targets[i]!)) as [LegRun, LegRun];
    const size = abs(starts[0]! - targets[0]!) > abs(starts[1]! - targets[1]!) ? abs(starts[0]! - targets[0]!) : abs(starts[1]! - targets[1]!);
    const notes: string[] = [];
    if (runs.every((r) => r.pos === r.target)) {
      notes.push('both legs were already at their close targets');
      return this.#result('closed', size, runs, notes);
    }
    this.#log(`close: ${runs.map((r) => `${r.leg.venue} ${r.leg.symbol} ${signedQtyString(r.start)} -> ${signedQtyString(r.target)}`).join(', ')}`);
    for (const r of runs) {
      if (crossesZero(r.start, r.target)) notes.push(`${r.leg.venue}: target ${signedQtyString(r.target)} is on the other side of zero; a reduce-only close stops at 0`);
    }

    await Promise.all(runs.filter((r) => r.pos !== r.target).map((r) => this.#move(r, r.target, true, request.reason, 'close')));
    if (this.#unknown(runs, notes)) return this.#result('stuck', size, runs, notes);
    if (runs.every((r) => r.pos === r.target)) return this.#result('closed', size, runs, notes);

    const open = runs.filter((r) => r.pos !== r.target);
    notes.push(`not closed: ${open.map((r) => `${r.leg.venue} at ${signedQtyString(r.pos!)}`).join(', ')}; retrying once`);
    await Promise.all(open.map((r) => this.#move(r, r.target, true, `${request.reason} (retry)`, 'retry')));
    if (this.#unknown(runs, notes)) return this.#result('stuck', size, runs, notes);
    if (runs.every((r) => r.pos === r.target)) return this.#result('closed', size, runs, notes);

    // One leg stays open: reopen the other against what it still holds, so neither is left alone.
    const [a, b] = runs;
    const exposure = (r: LegRun) => r.pos! - r.target;
    const residual = exposure(a) + exposure(b);   // what the pair holds net of its targets; 0 = still hedged
    if (residual === 0n) {
      notes.push('the legs that stayed open still offset each other: hedged, not closed');
      return this.#result('stuck', size, runs, notes);
    }
    const lighter = abs(exposure(a)) <= abs(exposure(b)) ? a : b;
    const hedgeTo = lighter.pos! - residual;
    notes.push(`re-hedging: ${lighter.leg.venue} back to ${signedQtyString(hedgeTo)} against the leg that stayed open`);
    lighter.target = hedgeTo;
    await this.#move(lighter, hedgeTo, false, `${request.reason} (re-hedge)`, 'rehedge');
    if (this.#unknown(runs, notes)) return this.#result('stuck', size, runs, notes);
    return this.#result(hedged(runs, targets[0] + targets[1]) ? 'stuck' : 'unhedged', size, runs, notes);
  }

  #run(leg: TradeLeg, start: bigint, target: bigint): LegRun {
    return {
      leg, start, target, pos: start,
      report: { venue: leg.venue, symbol: leg.symbol, start: signedQtyString(start), target: signedQtyString(target), final: null, orders: [] },
    };
  }

  /**
   * One order from the leg's known position toward `target`, then the leg's new position: from the fill on a leg that
   * cannot be replayed, from the venue (reconcile) on one that can or when the outcome is unknown; unchanged on proof
   * that nothing ran. null when the position could not be read.
   */
  async #move(r: LegRun, target: bigint, reduceOnly: boolean, reason: string, purpose: LegOrderRecord['purpose']): Promise<void> {
    const from = r.pos!;
    let delta = target - from;
    if (reduceOnly && crossesZero(from, target)) delta = -from;   // reduce-only stops at 0
    if (delta === 0n) return;
    const side: LegSide = delta > 0n ? 'BUY' : 'SELL';
    const out = await r.leg.order(side, abs(delta), reduceOnly, reason);
    r.report.orders.push(record(out, purpose));
    this.#log(`${r.leg.venue} ${purpose} ${side} ${qtyString(abs(delta))}${reduceOnly ? ' reduce-only' : ''}: ${describe(out)}`);
    if (r.leg.replayable && out.kind !== 'failed') this.#watch.set(r.leg, { target: r.target, until: out.ref.sentAt + REPLAY_WINDOW_MS });
    if (out.kind === 'failed') return;
    if (out.kind === 'filled' && !r.leg.replayable) {
      r.pos = from + (side === 'BUY' ? out.filled : -out.filled);
      return;
    }
    r.pos = await this.#reconcile(r.leg, r.target, out.ref.sentAt, r.report, out.kind === 'unknown' ? 'unknown' : 'after the order');
  }

  /**
   * Reads the leg's position from the venue (newer than `after`) and closes any excess over `target` reduce-only, up
   * to twice (a copy can land while the first close is out). Returns the position read last; null if unreadable.
   */
  async #reconcile(leg: TradeLeg, target: bigint, after: number, report: LegReport, why: string): Promise<bigint | null> {
    let pos: bigint;
    try {
      pos = await leg.position(after);
    } catch (err) {
      this.#log(`${leg.venue} ${leg.symbol}: position unknown (${why}): ${errorText(err)}`);
      report.final = null;
      return null;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const to = reducedTarget(pos, target);
      if (to === null) break;
      const excess = pos - to;
      const side: LegSide = excess > 0n ? 'SELL' : 'BUY';
      this.#log(`${leg.venue} ${leg.symbol}: holds ${signedQtyString(pos)}, target ${signedQtyString(target)}: closing ${qtyString(abs(excess))} reduce-only`);
      const out = await leg.order(side, abs(excess), true, `reconcile ${leg.symbol}: close ${qtyString(abs(excess))} over the target`);
      report.orders.push(record(out, 'excess'));
      if (leg.replayable && out.kind !== 'failed') this.#watch.set(leg, { target, until: out.ref.sentAt + REPLAY_WINDOW_MS });
      try {
        pos = await leg.position(out.ref.sentAt);
      } catch (err) {
        this.#log(`${leg.venue} ${leg.symbol}: position unknown after the excess close: ${errorText(err)}`);
        return null;
      }
    }
    const deficit = reducedTarget(pos, target) === null && pos !== target;
    if (deficit) this.#log(`${leg.venue} ${leg.symbol}: holds ${signedQtyString(pos)}, short of the target ${signedQtyString(target)} (reported, not traded)`);
    return pos;
  }

  /** True (with a note) when a leg's position is unknown: the pair stops there. */
  #unknown(runs: LegRun[], notes: string[]): boolean {
    const lost = runs.filter((r) => r.pos === null);
    if (lost.length === 0) return false;
    notes.push(`position unknown on ${lost.map((r) => r.leg.venue).join(' and ')} after an order whose outcome is not proven: nothing more is sent; reconcile by the ids in the orders`);
    return true;
  }

  #result(status: PairStatus, size: bigint, runs: [LegRun, LegRun], notes: string[]): PairResult {
    for (const r of runs) {
      r.report.target = signedQtyString(r.target);
      r.report.final = r.pos === null ? null : signedQtyString(r.pos);
    }
    const tx = runs.flatMap((r) => r.report.orders.flatMap((o) => o.ref.tx));
    this.#log(`${status}: ${runs.map((r) => `${r.leg.venue} ${r.report.final ?? 'unknown'}`).join(', ')}`);
    return { status, size: qtyString(size), legs: [runs[0].report, runs[1].report], notes, tx };
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * Where a reduce-only order can take `pos` toward `target`, or null when there is nothing to reduce: past the target
 * on its side of zero → the target; on the other side of zero → 0 (the rest is a deficit, reported).
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
