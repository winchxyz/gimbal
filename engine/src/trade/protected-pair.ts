// serve's pair: the open carry pair the engine protects next to it, 24/7. What it sends are the protections' closes,
// all reduce-only, through the PairTrader (its legging guard, its unsettled-order watch):
//   - panic_close (rescue/closing.ts): both legs to zero;
//   - a rescue's reduce (rescue/rescuer.ts): both legs smaller by the same size;
//   - an ADL unwind (risk/adl.ts): both legs to zero;
// and the strategy loop's own operations (strategy/loop.ts through serve-pair.ts, pair-mainnet's code in pair-ops.ts):
// its exit (a close, reduce-only like the others) and its open (openInChunks, and the residual hedge after it).
//
// GuardedLeg wraps each venue leg: an order that is not reduce-only is refused before anything is signed unless it
// comes from the strategy loop's open on this pair (ProtectedPair.openInChunks, or a hedge it allows to open: the
// work inside its OPEN_SCOPE token, open-scope.ts; a watch check between two parts is not), so no protection can open or
// grow a position (a PairTrader close re-hedges by reopening a leg unless reduceOnly is set; every close here sets it,
// and the leg refuses one anyway). While the pair does not trade (alert only) every order is refused the same way. Before an order is signed it is added to the InFlightBook and the state is saved
// (trader-state.ts); a save that fails refuses the order, so no order goes out that the state on disk does not name.
//
// An order leaves the book only once the trader has recorded its outcome and that is saved, in one write: a close's
// orders when the close returns a result that set the baselines (an order with no answer is then in the trader's
// unsettled list), a watch check's orders with the check's report, every order when the trader adopts the legs. Each
// order is its own entry, so the two legs of a close (sent at once) never share one. A close that throws leaves its
// orders in the book (and on disk) until a later close result or adopt.
//
// ProtectedPair runs each close: the Hyperliquid post-only orders a maker order left unsettled are cancelled by their
// ids first, the stored price is refreshed when it would not outlive the IOC and its retry (pair-mainnet-lib.ts
// ensureFresh, the 300 s life of a fresh price at oracle_max_age_s 900), then the trader closes reduce-only, each
// target clamped between 0 and the position the trader reads when the close runs (a rescue's target computed before
// another close queued ahead of it cannot ask a leg to grow), and the state is saved. What stays open afterwards (an
// order with no answer, an order whose result was never saved, a post-only order not settled, legs that do not offset)
// comes out as `open:` lines, as pair-mainnet prints them.
//
// startPlan decides at start what the trader holds: the saved state, or the venues' positions (adopted). A missing or
// unusable state file is never a fresh start unless GIMBAL_TRADER_FRESH names this contract and desk; a usable file is
// always used (GIMBAL_TRADER_FRESH is then ignored, with a line saying to remove it), and a saved pair whose legs now
// read smaller is restored, not adopted, so the ADL watch sees the shrink (two agreeing reads, then the unwind).
//
// Orders in flight. When the saved state still holds orders in flight, the legs may have moved by our own order: ADL
// then only alerts (the `adlHold`) until a close result or an adopt sets the baselines again, or until the orders are
// resolved from the venues. An order cannot run longer than IN_FLIGHT_LIFE_MS after it was signed (a Hyperliquid IOC
// answers at once; a Phoenix transaction's blockhash lasts about 2 min), so once every one is that old, two agreeing
// reads of the legs settle them (settleInFlight): when each leg reads its saved baseline moved by some of those orders
// (none, some or all of them, each in full) and the reads offset each other as the pair's net, they are adopted and the
// hold ends; explained leg by leg but not offsetting (a leg that moved alone: an ADL looks the same as an order of ours
// that never went out), the hold ends and the saved baselines stay, so the ADL watch takes the shrink; otherwise the
// hold stays and says what to run (reconcileHow). Nothing is adopted while a leg has an order with no answer (its
// result set the intent the trader watches). Every outcome but an adopt is journaled for the owner. startPlan does
// this at start; serve calls resolveInFlight when the youngest order passes that age.
//
// stop() (serve's shutdown, before its lock is released) is final: every order and close is refused after it.

import type { VenueId } from '@gimbal/shared';
import type { AdlState } from '../risk/adl.ts';
import { ADL_ATTEMPTS, newAdlState } from '../risk/adl.ts';
import type { LegOutcome, LegRef, LegSide, PendingMakerOrder, TradeLeg } from './legs.ts';
import { LegCheckError } from './legs.ts';
import { qtyString, signedQtyString, toQty } from './lots.ts';
import type { MakerFirst, PairResult, PairTrader, PairTraderState } from './pair.ts';
import type { InFlightOrder, LoadedTraderState } from './trader-state.ts';
import { savedShape } from './trader-state.ts';
import type { OpenToken } from './open-scope.ts';
import { OPEN_SCOPE } from './open-scope.ts';
import type { PairShape } from './pair-shape.ts';
import { defaultShape, sameShape, shapeText } from './pair-shape.ts';

/** The legs' venues of short Hyperliquid / long Phoenix, in the trader's order: what a text names when given none. */
const DEFAULT_VENUES: readonly VenueId[] = ['hyperliquid', 'phoenix'];

/** An order as GuardedLeg names it before it is signed (the book adds `op`). */
export type OutgoingOrder = Omit<InFlightOrder, 'op'>;

/** The orders sent whose outcome no saved result holds yet (see the header). */
export class InFlightBook {
  /** From the saved state: settled only by a close result or an adopt. */
  #restored: InFlightOrder[];
  #orders: InFlightOrder[] = [];
  #closes = 0;
  #signed = 0;

  constructor(restored: readonly InFlightOrder[] = []) {
    this.#restored = restored.map((o) => ({ ...o }));
  }

  /** The orders from the saved state still in the book (the ones the ADL hold is about). */
  get restored(): InFlightOrder[] {
    return this.#restored.map((o) => ({ ...o }));
  }

  /** Orders added since the book was made (never goes down: a caller compares it around an operation). */
  get signed(): number {
    return this.#signed;
  }

  /** Every order in the book, as it is saved. */
  get orders(): InFlightOrder[] {
    return [...this.#restored, ...this.#orders].map((o) => ({ ...o }));
  }

  /** An order about to be signed: added, then `save` runs; a save that throws takes it out again and throws. */
  add(order: OutgoingOrder, save: () => void): void {
    const o: InFlightOrder = { ...order, op: this.#closes > 0 ? 'close' : 'watch' };
    this.#orders.push(o);
    try {
      save();
    } catch (err) {
      this.#orders.splice(this.#orders.indexOf(o), 1);
      throw err;
    }
    this.#signed++;
  }

  /** A protection's close starts; the function returned ends it. Orders sent meanwhile wait for its result. */
  beginClose(): () => void {
    this.#closes++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#closes--;
    };
  }

  /** A watch check reported: the orders it sent are in the trader's state now. */
  watchRecorded(): void {
    this.#orders = this.#orders.filter((o) => o.op !== 'watch');
  }

  /** A close result or an adopt set the baselines: every order before it is accounted for. */
  allRecorded(): void {
    this.#restored = [];
    this.#orders = [];
  }
}

/**
 * How long after it was signed an order of serve's can still run: a Hyperliquid IOC answers at once, a Phoenix
 * transaction's blockhash lasts about 2 min; 10 min is a safe bound for both (see the header).
 */
export const IN_FLIGHT_LIFE_MS = 10 * 60_000;

/** When the youngest of `orders` can no longer run (IN_FLIGHT_LIFE_MS after it was signed); null for no orders. */
export function inFlightEnds(orders: readonly InFlightOrder[]): number | null {
  return orders.length === 0 ? null : Math.max(...orders.map((o) => o.at)) + IN_FLIGHT_LIFE_MS;
}

/**
 * The legs whose read the saved baselines and the orders in flight do not explain, one line each (empty: both are
 * explained). A leg is explained when it reads its baseline moved by some of its orders, each in full (BUY adds, SELL
 * takes off): none of them ran, some did, or all did. A baseline that is unknown explains nothing.
 */
export function inFlightUnexplained(orders: readonly InFlightOrder[], baselines: readonly (bigint | null)[], read: readonly [bigint, bigint]): string[] {
  const out: string[] = [];
  for (const index of [0, 1] as const) {
    const mine = orders.filter((o) => o.index === index);
    const venue = index === 0 ? 'hyperliquid' : 'phoenix';
    const base = baselines[index] ?? null;
    if (base === null) {
      out.push(`${venue} reads ${signedQtyString(read[index])} and its saved baseline is unknown`);
      continue;
    }
    // Every sum of some of the orders (each order in or out); repeated sizes keep the set small.
    let sums = new Set<bigint>([0n]);
    for (const o of mine) {
      const d = o.side === 'BUY' ? toQty(o.size) : -toQty(o.size);
      sums = new Set([...sums, ...[...sums].map((s) => s + d)]);
      if (sums.size > 4096) break;
    }
    if (!sums.has(read[index] - base)) {
      const moves = mine.length === 0 ? 'no order in flight on it' : mine.map((o) => `${o.side} ${o.size}`).join(', ');
      out.push(`${venue} reads ${signedQtyString(read[index])}, but its saved baseline ${signedQtyString(base)} with ${moves} does not reach it`);
    }
  }
  return out;
}

/**
 * How orders in flight that can no longer run are settled from two agreeing reads (see the header):
 *   adopt    every leg explained, no order with no answer, and the reads offset as the pair's net: adopted, hold ends
 *   restore  every leg explained, but the reads do not offset (one leg moved alone: an order of ours that never went
 *            out and an ADL look the same): not adopted; the hold ends and the saved baselines stay, so the ADL watch
 *            takes the shrink (two reads, then both legs unwound reduce-only; a stopped reduce is over-unwound, safely)
 *   hold     a leg the baselines and the orders do not explain, or a post-only order not settled: the hold stays and
 *            says what the owner runs
 *   wait     a leg has an order with no answer that may still run (the trader's unsettled watch): nothing is adopted
 *            over the intent its result set; tried again later
 * Every outcome but adopt is for the owner (journaled).
 */
export type InFlightSettle =
  | { kind: 'adopt'; line: string }
  | { kind: 'restore'; line: string }
  | { kind: 'hold'; hold: string; line: string }
  | { kind: 'wait'; hold: string; line: string };

export function settleInFlight(p: {
  orders: readonly InFlightOrder[];
  baselines: readonly (bigint | null)[];
  net: bigint;
  read: readonly [bigint, bigint];
  unsettled: number;
  pendingMaker: number;
  reconcile: string;
}): InFlightSettle {
  const { orders, read } = p;
  const reads = `hyperliquid ${signedQtyString(read[0])}, phoenix ${signedQtyString(read[1])}`;
  const head = `the ${orders.length} order(s) in flight when the engine stopped were signed more than ${IN_FLIGHT_LIFE_MS / 60_000} min ago and can no longer run; the venues read ${reads}`;
  const off = inFlightUnexplained(orders, p.baselines, read);
  if (p.pendingMaker > 0) off.push(`${p.pendingMaker} Hyperliquid post-only order(s) are not settled and may still fill (cancel them on Hyperliquid)`);
  if (off.length > 0) {
    const hold = holdText(orders, off, p.reconcile);
    return { kind: 'hold', hold, line: `ADL hold stays: ${hold}` };
  }
  if (p.unsettled > 0) {
    const hold = `${orders.length} order(s) were in flight when the engine stopped and can no longer run, but ${p.unsettled} leg(s) have an order with no answer that may still run: ADL only alerts until its watch ends or a close result sets the baselines; ${p.reconcile}`;
    return { kind: 'wait', hold, line: `${head}, but an order with no answer may still run: not adopted, the ADL hold stays (tried again later)` };
  }
  if (read[0] + read[1] !== p.net) {
    return { kind: 'restore', line: `${head}: each leg is explained by its baseline and those orders, but together they do not offset each other (the pair's net is ${signedQtyString(p.net)}), as a leg that moved alone would (an ADL, or an order of ours that never went out): not adopted; the ADL hold ends and the saved baselines stay, so the ADL watch takes the shrink (two reads, then both legs unwound reduce-only)` };
  }
  return { kind: 'adopt', line: `${head}, as the saved baselines and those orders explain, offsetting each other: adopted, the ADL hold ends` };
}

/** What the owner runs when orders in flight cannot be settled from the venues (the ADL hold's text ends with it). */
export function reconcileHow(p: { symbol: string; path: string; freshWant: string }): string {
  return `check both legs (npm run monitor -w engine -- --mainnet); to close them: stop serve, then pair-mainnet close ${p.symbol} --send, then start serve again; `
    + `if the legs are right as they are: stop serve, move ${p.path} aside, then start serve once with GIMBAL_TRADER_FRESH=${p.freshWant}`;
}

export interface GuardedLegOptions {
  index: 0 | 1;
  /** Whether the pair trades now; false refuses every order (alert only). */
  live: () => boolean;
  /** serve is stopping (its lock is being released): every order is refused from then on. */
  stopped?: () => boolean;
  /** The caller is the strategy loop's open on this pair (ProtectedPair.openingHere): an order that is not reduce-only may go out. */
  opening?: () => boolean;
  /** Adds the order to the book and saves it; throws when it could not (the order is then refused). */
  beforeSign: (order: OutgoingOrder) => void;
  now?: () => number;
}

export class GuardedLeg implements TradeLeg {
  readonly inner: TradeLeg;
  readonly venue: VenueId;
  readonly symbol: string;
  readonly lot: bigint;
  readonly replayable: boolean;
  readonly makerOrder?: (side: LegSide, size: bigint, reduceOnly: boolean, reason: string) => Promise<LegOutcome>;
  readonly #o: GuardedLegOptions;

  constructor(inner: TradeLeg, options: GuardedLegOptions) {
    this.inner = inner;
    this.venue = inner.venue;
    this.symbol = inner.symbol;
    this.lot = inner.lot;
    this.replayable = inner.replayable;
    this.#o = options;
    const maker = inner.makerOrder;
    if (maker !== undefined) {
      this.makerOrder = (side, size, reduceOnly, reason) => this.#guard(side, size, reduceOnly, reason, () => maker.call(inner, side, size, reduceOnly, reason));
    }
  }

  check(size: bigint, reduceOnly: boolean): Promise<void> {
    return this.inner.check(size, reduceOnly);
  }

  maxSize(side: LegSide, reduceOnly: boolean): Promise<bigint> {
    return this.inner.maxSize(side, reduceOnly);
  }

  position(after?: number): Promise<bigint> {
    return this.inner.position(after);
  }

  order(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome> {
    return this.#guard(side, size, reduceOnly, reason, () => this.inner.order(side, size, reduceOnly, reason));
  }

  beginMakerOperation(): () => void {
    return this.inner.beginMakerOperation?.() ?? (() => {});
  }

  async syncToChain(): Promise<void> {
    await this.inner.syncToChain?.();
  }

  async #guard(side: LegSide, size: bigint, reduceOnly: boolean, reason: string, send: () => Promise<LegOutcome>): Promise<LegOutcome> {
    const at = (this.#o.now ?? Date.now)();
    const refuse = (why: string): LegOutcome => {
      const ref: LegRef = { venue: this.venue, side, size: qtyString(size), reduceOnly, orderId: null, clientId: null, tx: [], sentAt: at };
      return { kind: 'failed', error: new LegCheckError(`${this.venue} ${this.symbol}: ${why}; nothing signed`), ref };
    };
    if (this.#o.stopped?.() === true) return refuse('serve is stopping and its trader lock is released');
    if (!this.#o.live()) return refuse('alert only: this engine does not trade');
    if (!reduceOnly && this.#o.opening?.() !== true) return refuse('serve sends reduce-only orders only, outside the strategy loop\'s open, and this one could open or grow a position');
    try {
      this.#o.beforeSign({ index: this.#o.index, venue: this.venue, side, size: qtyString(size), reduceOnly, reason, at });
    } catch (err) {
      return refuse(`the trader state could not be saved before the order (${err instanceof Error ? err.message : String(err)})`);
    }
    // The order stays in the book after it answers: only the trader's recorded result takes it out (see the header).
    return send();
  }
}

/** The closes the protections make outside the strategy loop. */
export type ProtectionCloseBy = 'panic_close' | 'rescue reduce' | 'ADL unwind';

/** One protection's close as it ended: its result, or the error it threw (its fills then unknown). */
export interface ProtectionCloseReport {
  by: ProtectionCloseBy;
  reason: string;
  /** The pair's symbol. */
  symbol: string;
  /** ms, before its first order. */
  startedAt: number;
  at: number;
  result: PairResult | null;
  error: string | null;
}

export interface ProtectedPairOptions {
  trader: PairTrader;
  symbol: string;
  /** Whether the pair trades; false: every close is refused (alert only), and `why` says why. */
  live: boolean;
  why?: string | null;
  /** The orders in flight (shared with the guarded legs); default an empty book. */
  inFlight?: InFlightBook;
  /** Why ADL only alerts until a close result or an adopt sets the baselines (startPlan's adlHold), or null. */
  adlHold?: string | null;
  /** What the owner runs when resolveInFlight cannot settle the orders in flight (reconcileHow). */
  reconcile?: string;
  /** Refreshes the stored price so the IOC and its retry fit inside its life; throws when it cannot (nothing is sent). */
  freshPrice?: () => Promise<void>;
  /** Hyperliquid post-only orders a maker order could not settle, and their cancel by id. */
  pendingMaker?: () => readonly PendingMakerOrder[];
  cancelPending?: (reason: string) => Promise<string[]>;
  /** Writes the trader state (live only); throws when it could not. */
  save: () => void;
  /** What stays open after a close: serve logs and journals it. */
  onOpen?: (lines: string[]) => void;
  /** After a protection's close (one that names `by`), sent or failed: serve books it (book/book.ts recordOutside). */
  onProtectionClose?: (report: ProtectionCloseReport) => void;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The pair as the protections see it: rescue/rescuer.ts's Reducer and risk/adl.ts's AdlTrader. */
export class ProtectedPair {
  readonly trader: PairTrader;
  readonly symbol: string;
  readonly live: boolean;
  readonly why: string | null;
  readonly inFlight: InFlightBook;
  readonly #o: ProtectedPairOptions;
  #adlHold: string | null;
  /** Closes running now (queued in the trader or past it). */
  #running = 0;
  #stopped = false;
  /** The strategy loop's open (or the hedge it allows) runs: the guarded legs let orders that are not reduce-only out. */
  #opening = 0;
  /** The opens running now, each the OPEN_SCOPE token of its own work. */
  readonly #openTokens = new Set<OpenToken>();

  constructor(options: ProtectedPairOptions) {
    this.#o = options;
    this.trader = options.trader;
    this.symbol = options.symbol;
    this.live = options.live;
    this.why = options.why ?? null;
    this.inFlight = options.inFlight ?? new InFlightBook();
    this.#adlHold = options.adlHold ?? null;
  }

  get legs(): [TradeLeg, TradeLeg] {
    return this.trader.legs;
  }

  get lot(): bigint {
    return this.trader.lot;
  }

  get busy(): boolean {
    return this.trader.busy;
  }

  get net(): bigint {
    return this.trader.net;
  }

  get unhedged(): string | null {
    return this.trader.unhedged;
  }

  set unhedged(v: string | null) {
    this.trader.unhedged = v;
    this.#save();
  }

  /** Why ADL only alerts now (see the header), or null. */
  get adlHold(): string | null {
    return this.#adlHold;
  }

  /** A close is running, or the trader is busy (a watch check). */
  get closing(): boolean {
    return this.#running > 0 || this.trader.busy;
  }

  watching(leg: TradeLeg): boolean {
    return this.trader.watching(leg);
  }

  unsettled(leg: TradeLeg): ReturnType<PairTrader['unsettled']> {
    return this.trader.unsettled(leg);
  }

  baseline(leg: TradeLeg): bigint | null | undefined {
    return this.trader.baseline(leg);
  }

  adopt(positions: readonly [bigint, bigint]): void {
    this.trader.adopt(positions);
    this.#recorded();
    this.#save();
  }

  /** serve is stopping: final, every close is refused from now on (the guarded legs refuse every order too). */
  stop(): void {
    this.#stopped = true;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /**
   * The orders in flight from before the restart, once the youngest can no longer run (IN_FLIGHT_LIFE_MS), settled
   * from `read` (two agreeing reads of both legs) as settleInFlight decides. Null when there is nothing to settle (no
   * hold, no restored order left, or stopped); `again` true when it could not be decided now (a close runs, the trader
   * is busy, an order can still run, or one has no answer): the caller tries again later; `owner` true when the owner
   * must hear of it (anything but an adopt).
   */
  resolveInFlight(read: readonly [bigint, bigint], now: number): { line: string; again: boolean; owner: boolean } | null {
    const restored = this.inFlight.restored;
    if (this.#adlHold === null || restored.length === 0 || this.#stopped) return null;
    if (this.closing) return { line: 'orders in flight from before the restart: not settled now, a close is running (a close result settles them)', again: true, owner: false };
    const ends = inFlightEnds(restored)!;
    if (now < ends) return { line: `orders in flight from before the restart: they can run until ${new Date(ends).toISOString()}, settled from the venues then`, again: true, owner: false };
    const legs = this.trader.legs;
    const r = settleInFlight({
      orders: restored, baselines: legs.map((l) => this.trader.baseline(l) ?? null), net: this.trader.net, read,
      unsettled: legs.filter((l) => this.trader.unsettled(l) !== null).length, pendingMaker: (this.#o.pendingMaker?.() ?? []).length,
      reconcile: this.#o.reconcile ?? 'check both legs by hand',
    });
    if (r.kind === 'adopt') {
      this.adopt(read);
      return { line: r.line, again: false, owner: false };
    }
    if (r.kind === 'restore') {
      // The baselines stay as they are: the ADL watch compares the legs with them from now on.
      this.inFlight.allRecorded();
      this.#adlHold = null;
      this.#save();
      return { line: r.line, again: false, owner: true };
    }
    this.#adlHold = r.hold;
    return { line: r.line, again: r.kind === 'wait', owner: true };
  }

  /** The strategy loop's open runs now, somewhere. */
  get opening(): boolean {
    return this.#opening > 0;
  }

  /**
   * The caller runs inside the strategy loop's open of this pair (GuardedLegOptions.opening and the trader's
   * openBlocked read it): an order from anything else, a watch check between two parts included, is not part of it.
   */
  get openingHere(): boolean {
    const token = OPEN_SCOPE.getStore();
    return token !== undefined && this.#openTokens.has(token);
  }

  /**
   * The strategy loop's open (pair-ops.ts sendOpen through serve-pair.ts): the trader's openInChunks, with the guarded
   * legs letting orders that are not reduce-only out while it runs. Every order is still saved in flight before it is
   * signed, and leaves the book with the trader's result; what stays open afterwards comes out as `open:` lines. Throws,
   * with nothing sent, when the pair does not trade or serve is stopping.
   */
  async openInChunks(request: Parameters<PairTrader['openInChunks']>[0]): Promise<PairResult[]> {
    return this.#operation(true, async () => {
      const epoch = this.trader.baselineEpoch;
      try {
        return await this.trader.openInChunks(request);
      } finally {
        // Each part's result is in the trader: its orders leave the book in the same save that writes it.
        if (this.trader.baselineEpoch !== epoch) this.#recorded();
      }
    });
  }

  /**
   * One order on leg `index` outside the trader (pair-ops.ts finish()'s residual hedge after a late maker fill):
   * `allowOpen` only from the loop's open. It stays in the book (no trader result holds it) until a close result or an
   * adopt. Never throws for the order itself (a refusal comes back as a failed outcome).
   */
  async hedge(index: 0 | 1, side: LegSide, size: bigint, reduceOnly: boolean, reason: string, allowOpen: boolean): Promise<LegOutcome> {
    return this.#operation(allowOpen, () => this.trader.legs[index].order(side, size, reduceOnly, reason));
  }

  async #operation<T>(opening: boolean, run: () => Promise<T>): Promise<T> {
    if (this.#stopped) throw new Error('serve is stopping and its trader lock is released: nothing is signed');
    if (!this.live) throw new Error(`alert only (${this.why ?? 'this engine does not trade'}): nothing is signed`);
    this.#running++;
    const token: OpenToken | null = opening ? { owner: this } : null;
    if (token !== null) {
      this.#opening++;
      this.#openTokens.add(token);
    }
    const end = this.inFlight.beginClose();
    try {
      return await (token === null ? run() : OPEN_SCOPE.run(token, run));
    } finally {
      this.#save();
      const open = this.openLines();
      if (open.length > 0) this.#o.onOpen?.(open);
      if (token !== null) {
        this.#openTokens.delete(token);
        this.#opening--;
      }
      end();
      this.#running--;
    }
  }

  /** A protection's close: always reduce-only (see the header); throws, with nothing sent, when it cannot start. */
  async close(request: { reason: string; targets?: [bigint, bigint]; reduceOnly?: boolean; maker?: MakerFirst; by?: ProtectionCloseBy }): Promise<PairResult> {
    const { by, ...rest } = request;
    if (by === undefined) return this.#close(rest);
    const now = this.#o.now ?? Date.now;
    const startedAt = now();
    let result: PairResult | null = null;
    let error: string | null = null;
    try {
      result = await this.#close(rest);
      return result;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      try {
        this.#o.onProtectionClose?.({ by, reason: request.reason, symbol: this.symbol, startedAt, at: now(), result, error });
      } catch (err) {
        this.#log(`book: the ${by} close was not booked (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }

  async #close(request: { reason: string; targets?: [bigint, bigint]; reduceOnly?: boolean; maker?: MakerFirst }): Promise<PairResult> {
    if (this.#stopped) throw new Error('serve is stopping and its trader lock is released: nothing is signed');
    if (!this.live) {
      throw new Error(`alert only (${this.why ?? 'this engine does not trade'}): nothing is signed; close the legs by hand (stop serve, then pair-mainnet close ${this.symbol} --send)`);
    }
    this.#running++;
    const end = this.inFlight.beginClose();
    try {
      if ((this.#o.pendingMaker?.() ?? []).length > 0 && this.#o.cancelPending !== undefined) {
        for (const line of await this.#o.cancelPending(`${request.reason}: cancel post-only orders left unsettled`)) this.#log(`cancel    ${line}`);
        this.#save();
      }
      await this.#o.freshPrice?.();
      const epoch = this.trader.baselineEpoch;
      let result: PairResult;
      try {
        result = await this.trader.close({ ...request, reduceOnly: true, clampTargets: true });
        // The result is in the trader: its orders leave the book in the same save that writes it.
        if (this.trader.baselineEpoch !== epoch) this.#recorded();
      } finally {
        this.#save();
        const open = this.openLines();
        if (open.length > 0) this.#o.onOpen?.(open);
      }
      return result;
    } finally {
      end();
      this.#running--;
    }
  }

  /** A watch check of the trader reported (its onWatch): the orders it sent are recorded; the caller saves next. */
  watchRecorded(): void {
    this.inFlight.watchRecorded();
  }

  /**
   * Resolves true once no close runs and the trader is idle, or false after `timeoutMs` (serve's shutdown waits on it
   * before it releases the lock).
   */
  async whenIdle(timeoutMs: number): Promise<boolean> {
    const now = this.#o.now ?? Date.now;
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const until = now() + timeoutMs;
    while (this.closing) {
      if (now() >= until) return false;
      await sleep(100);
    }
    return true;
  }

  /** What stays open now, as pair-mainnet prints it: `open:` lines (empty when nothing). */
  openLines(): string[] {
    const out: string[] = [];
    for (const f of this.inFlight.orders) {
      out.push(`open:     ${f.venue} ${f.side} ${f.size} ${this.symbol}${f.reduceOnly ? ' reduce-only' : ''} (${f.reason}) was sent at ${new Date(f.at).toISOString()} and no saved result holds its outcome: check ${f.venue} ${this.symbol} by hand`);
    }
    for (const p of this.#o.pendingMaker?.() ?? []) {
      out.push(`open:     hyperliquid post-only ${p.side} ${p.size} ${this.symbol} (oid ${p.oid ?? 'unknown'}, cloid ${p.cloid}) may still rest and fill: cancel it on Hyperliquid and reconcile both legs`);
    }
    if (this.trader.unhedged !== null) out.push(`open:     ${this.trader.unhedged}`);
    else {
      const base = this.trader.legs.map((l) => this.trader.baseline(l));
      if (base.every((b) => b !== null && b !== undefined) && base[0]! + base[1]! !== 0n) {
        out.push(`open:     the legs are meant to hold hyperliquid ${signedQtyString(base[0]!)} and phoenix ${signedQtyString(base[1]!)}, which do not offset each other (a close clamped to the legs as read): ADL only alerts until a close offsets them`);
      }
    }
    for (const leg of this.trader.legs) {
      const u = this.trader.unsettled(leg);
      if (u === null) continue;
      const orders = u.refs.map((ref) => `${ref.side} ${ref.size}${ref.reduceOnly ? ' reduce-only' : ''} (${ref.clientId ?? ref.orderId ?? 'no id'})`).join(' and ');
      out.push(`open:     ${leg.venue} ${orders} has no answer and may still run until ${new Date(u.until).toISOString()}: check ${leg.venue} ${leg.symbol} by hand until then`);
    }
    return out;
  }

  /** Why the ADL watch cannot take a shrink as ADL on these baselines (unknown, or not offsetting), or null. */
  adlOff(): string | null {
    const base = this.trader.legs.map((l) => this.trader.baseline(l));
    if (base.some((b) => b === null || b === undefined)) return `a baseline is unknown (${base.map((b) => (b === null || b === undefined ? 'unknown' : signedQtyString(b))).join(' and ')}): no shrink is checked until a close result`;
    const [a, b] = base as [bigint, bigint];
    if (a + b !== 0n || this.trader.net !== 0n) return `the baselines ${signedQtyString(a)} and ${signedQtyString(b)} do not offset each other, so a shrink is not taken as ADL (the owner is alerted instead)`;
    return null;
  }

  #recorded(): void {
    this.inFlight.allRecorded();
    this.#adlHold = null;
  }

  #save(): void {
    if (!this.live) return;
    try {
      this.#o.save();
    } catch (err) {
      this.#log(`trader state not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #log(line: string): void {
    this.#o.log?.(line);
  }
}

// ---- at start ----

export interface StartInput {
  symbol: string;
  /** The legs being built, in the trader's order; absent: short Hyperliquid / long Phoenix. */
  pair?: PairShape;
  /** The legs as two agreeing reads found them, in the trader's order. */
  read: [bigint, bigint];
  saved: LoadedTraderState;
  /** GIMBAL_TRADER_FRESH as set (undefined: not set). */
  fresh: string | undefined;
  /** The value that asks for a fresh start of this desk: `<contract>/<desk>`. */
  freshWant: string;
  /** Where the state lives (for the messages). */
  path: string;
  /** Now (ms): orders in flight older than IN_FLIGHT_LIFE_MS are settled from `read`. */
  now: number;
}

export interface StartPlan {
  /** False: the state does not allow trading (the reason in `why`); the pair is then alert only. */
  stateOk: boolean;
  why: string | null;
  /** Import `restore` when set, then adopt `adopt` when set (at least one is). */
  restore: PairTraderState | null;
  adopt: [bigint, bigint] | null;
  adl: AdlState;
  pendingMaker: PendingMakerOrder[];
  /** Orders in flight from before the restart: they stay in the book until a close result or adopt. */
  inFlight: InFlightOrder[];
  /** Why ADL only alerts until a close result or adopt (orders were in flight when the engine stopped), or null. */
  adlHold: string | null;
  /** What was decided, one line each. */
  notes: string[];
  /** Lines the owner must hear of (journaled): orders in flight settled from the venues without an adopt. */
  owner: string[];
}

const flat = (p: readonly (bigint | null)[]): boolean => p.every((x) => x === 0n);
/** The two legs' positions by venue ("hyperliquid -5, phoenix 5"); `venues` default short Hyperliquid / long Phoenix's. */
const legsText = (p: readonly (bigint | null)[], venues: readonly VenueId[] = DEFAULT_VENUES): string =>
  `${venues[0]} ${p[0] === null ? 'unknown' : signedQtyString(p[0]!)}, ${venues[1]} ${p[1] === null ? 'unknown' : signedQtyString(p[1]!)}`;

/**
 * The ADL hold's text for orders in flight from before the restart: `off` null while they can still run (until
 * `ends`), else the legs the venues read that the baselines and those orders do not explain, and what to run.
 */
export function holdText(orders: readonly InFlightOrder[], off: readonly string[] | null, reconcile: string): string {
  const listed = `${orders.length} order(s) were in flight when the engine stopped (${orders.map((f) => `${f.venue} ${f.side} ${f.size}`).join(', ')})`;
  if (off === null) {
    const ends = inFlightEnds(orders);
    return `${listed}, so a leg may have moved by our own order: ADL only alerts until a close result or an adopt sets the baselines, or until they can no longer run (${ends === null ? 'now' : new Date(ends).toISOString()}) and serve settles them from the venues`;
  }
  return `${listed} and can no longer run, but ${off.join('; ')} (an ADL, a partial fill or a trade elsewhere): ADL only alerts until the owner reconciles; ${reconcile}`;
}

/** What the trader holds at start (see the header). */
export function startPlan(input: StartInput): StartPlan {
  const { read, saved, symbol } = input;
  const shape = input.pair ?? defaultShape(symbol);
  const text = (p: readonly (bigint | null)[]): string => legsText(p, shape.legs.map((l) => l.venue));
  const freshNotes: string[] = [];
  let fresh = false;
  if (input.fresh !== undefined) {
    if (saved.kind === 'loaded') {
      // A usable state is always used: a fresh start would forget what it holds (an ADL that happened while serve
      // was down among it: the restored baselines show the shrink, and the ADL watch takes it from there).
      freshNotes.push(`GIMBAL_TRADER_FRESH is ignored: ${input.path} is a usable trader state and is used as saved (a fresh start applies only when the file is missing or unusable); remove GIMBAL_TRADER_FRESH from the env`);
    } else if (input.fresh !== input.freshWant) {
      freshNotes.push(`GIMBAL_TRADER_FRESH=${JSON.stringify(input.fresh)} is ignored: a fresh start names this contract and desk, GIMBAL_TRADER_FRESH=${input.freshWant}, for one start only`);
    } else {
      fresh = true;
    }
  }
  const plan = (p: Omit<StartPlan, 'notes' | 'owner'> & { notes: string[]; owner?: string[] }): StartPlan => ({ ...p, notes: [...freshNotes, ...p.notes], owner: p.owner ?? [] });
  const adopted = (stateOk: boolean, why: string | null, notes: string[], adl: AdlState = newAdlState(), pendingMaker: PendingMakerOrder[] = [], inFlight: InFlightOrder[] = [], adlHold: string | null = null): StartPlan => plan({
    stateOk, why, restore: null, adopt: read, adl, pendingMaker, inFlight, adlHold, notes,
  });
  const how = `start once with GIMBAL_TRADER_FRESH=${input.freshWant}`;
  if (fresh) {
    return adopted(true, null, [`GIMBAL_TRADER_FRESH=${input.freshWant}: adopted ${text(read)} ${symbol} as the pair${read[0] + read[1] === 0n ? '' : ' (NOT offsetting: unhedged)'}; a new ADL budget of ${ADL_ATTEMPTS} unwinds; ${input.path} is written anew. Remove GIMBAL_TRADER_FRESH before the next start`]);
  }
  if (saved.kind === 'none') {
    const why = `no trader state at ${input.path}: a missing file is not a fresh start (an order may still be in flight); after checking both legs on the venues, ${how}`;
    return adopted(false, why, [`venues read ${text(read)} ${symbol} (held in memory only)`]);
  }
  if (saved.kind === 'unusable') return adopted(false, `${saved.problem}; after reconciling both legs, ${how}`, [`venues read ${text(read)} ${symbol} (held in memory only)`]);

  const s = saved.state;
  const inFlight = s.inFlight;
  const reconcile = reconcileHow({ symbol, path: input.path, freshWant: input.freshWant });
  const ends = inFlightEnds(inFlight);
  // Every order in flight is too old to run: the reads settle them (see the header).
  const settled = ends !== null && input.now >= ends;
  const hold = inFlight.length === 0 ? null : holdText(inFlight, null, reconcile);
  const t = s.trader;
  const settledNote = (): string => `the ${inFlight.length} order(s) in flight when the engine stopped were signed more than ${IN_FLIGHT_LIFE_MS / 60_000} min ago and can no longer run; the venues read ${text(read)}`;
  // The venues' positions become the pair: orders that can no longer run are in them.
  const freshPair = (why: string): StartPlan => adopted(true, null, settled ? [why, settledNote()] : [why], newAdlState(), s.pendingMaker, settled ? [] : inFlight, settled ? null : hold);
  // Another pair: another symbol, or the same symbol on other legs (or the other way round). Its baselines and orders
  // are of legs this trader does not hold, so they are never restored onto these.
  const was = savedShape(s);
  if (s.symbol !== null && (s.symbol !== symbol || (was !== null && !sameShape(was, shape)))) {
    const other = s.symbol !== symbol ? s.symbol : `${s.symbol} (${shapeText(was!)})`;
    const now = s.symbol !== symbol ? symbol : `${symbol} (${shapeText(shape)})`;
    const idle = t === null || (flat(t.baselines) && t.unsettled.length === 0 && s.adl.event === null);
    if (idle && s.pendingMaker.length === 0 && inFlight.length === 0) return freshPair(`the saved state is for ${other}, flat; the venues hold ${text(read)} ${now}: adopted as a new pair, a new ADL budget of ${ADL_ATTEMPTS}`);
    return adopted(false, `${input.path} is for ${other} with legs or orders open, but the venues are read for ${now}: reconcile ${other} by hand, then stop serve, move ${input.path} aside and ${how}`, [], s.adl, s.pendingMaker, inFlight, hold);
  }
  // Both legs flat: nothing is left to protect, and a reduce-only order of ours (all serve sends) cannot run on a flat leg.
  const flatAdopt = (note: string): StartPlan => adopted(true, null, [note], { ...s.adl, event: null }, s.pendingMaker, [], null);
  if (t === null) {
    if (flat(read)) return flatAdopt('no pair in the saved state and both legs flat: adopted flat');
    return freshPair(`no pair in the saved state; the venues hold ${text(read)} ${symbol}: adopted as a new pair, a new ADL budget of ${ADL_ATTEMPTS}`);
  }
  const base = t.baselines;
  const restore = (note: string): StartPlan => {
    const restored = { stateOk: true, why: null, restore: t, adl: s.adl, pendingMaker: s.pendingMaker };
    if (!settled) return plan({ ...restored, adopt: null, inFlight, adlHold: hold, notes: [note] });
    const r = settleInFlight({ orders: inFlight, baselines: base, net: t.net, read, unsettled: t.unsettled.length, pendingMaker: s.pendingMaker.length, reconcile });
    if (r.kind === 'adopt') return plan({ ...restored, adopt: read, inFlight: [], adlHold: null, notes: [note, r.line] });
    // The baselines stay as saved: the ADL watch compares the legs with them.
    if (r.kind === 'restore') return plan({ ...restored, adopt: null, inFlight: [], adlHold: null, notes: [note, r.line], owner: [r.line] });
    return plan({ ...restored, adopt: null, inFlight, adlHold: r.hold, notes: [note, r.line], owner: [r.line] });
  };
  if (t.unsettled.length > 0 || s.adl.event !== null || s.pendingMaker.length > 0) {
    return restore(`restored from ${input.path}: baselines ${text(base)}, venues ${text(read)}${t.unsettled.length > 0 ? `, ${t.unsettled.length} leg(s) with an order that may still run` : ''}${s.adl.event !== null ? ', an ADL event in progress' : ''}${s.pendingMaker.length > 0 ? `, ${s.pendingMaker.length} post-only order(s) not settled` : ''}`);
  }
  if (base[0] === read[0] && base[1] === read[1]) return restore(`restored from ${input.path}: ${text(read)} ${symbol}, as saved`);
  if (base.some((b) => b === null)) return restore(`restored from ${input.path}: a saved baseline is unknown (${text(base)}), venues ${text(read)}: ADL is not checked until the next close result`);
  if (flat(base) && !flat(read) && read[0] + read[1] === 0n) {
    return freshPair(`a new pair opened since the last run (saved flat): adopted ${text(read)} ${symbol}, a new ADL budget of ${ADL_ATTEMPTS}${s.adl.paused === null ? '' : `; the ADL pause (${s.adl.paused}) ends with it`}`);
  }
  if (flat(read)) return flatAdopt(`both legs read flat (saved ${text(base)}): closed since the last run; adopted flat`);
  return restore(`restored from ${input.path}: baselines ${text(base)}, but the venues read ${text(read)}: the ADL watch compares them (a shrink is unwound; anything else is the owner's)`);
}
