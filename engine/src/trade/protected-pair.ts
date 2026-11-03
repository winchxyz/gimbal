// serve's pair: the open carry pair the engine protects next to it, 24/7. It never opens. What it sends are the
// protections' closes, all reduce-only, through the PairTrader (its legging guard, its unsettled-order watch):
//   - panic_close (rescue/closing.ts): both legs to zero;
//   - a rescue's reduce (rescue/rescuer.ts): both legs smaller by the same size;
//   - an ADL unwind (risk/adl.ts): both legs to zero.
//
// GuardedLeg wraps each venue leg: an order that is not reduce-only is refused before anything is signed, so nothing
// serve sends can open or grow a position (a PairTrader close re-hedges by reopening a leg unless reduceOnly is set;
// every close here sets it, and the leg refuses one anyway). While the pair does not trade (alert only) every order is
// refused the same way. Before an order is signed it is added to the InFlightBook and the state is saved
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
// unusable state file is never a fresh start unless GIMBAL_TRADER_FRESH names this contract and desk; and a saved
// pair whose legs now read smaller is restored, not adopted, so the ADL watch sees the shrink. When the saved state
// still holds orders in flight, the legs may have moved by our own order: ADL then only alerts until a close result or
// an adopt sets the baselines again (the `adlHold`).

import type { VenueId } from '@gimbal/shared';
import type { AdlState } from '../risk/adl.ts';
import { ADL_ATTEMPTS, newAdlState } from '../risk/adl.ts';
import type { LegOutcome, LegRef, LegSide, PendingMakerOrder, TradeLeg } from './legs.ts';
import { LegCheckError } from './legs.ts';
import { qtyString, signedQtyString } from './lots.ts';
import type { PairResult, PairTrader, PairTraderState } from './pair.ts';
import type { InFlightOrder, LoadedTraderFile, LoadedTraderState } from './trader-state.ts';

/** An order as GuardedLeg names it before it is signed (the book adds `op`). */
export type OutgoingOrder = Omit<InFlightOrder, 'op'>;

/** The orders sent whose outcome no saved result holds yet (see the header). */
export class InFlightBook {
  /** From the saved state: settled only by a close result or an adopt. */
  #restored: InFlightOrder[];
  #orders: InFlightOrder[] = [];
  #closes = 0;

  constructor(restored: readonly InFlightOrder[] = []) {
    this.#restored = restored.map((o) => ({ ...o }));
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

export interface GuardedLegOptions {
  index: 0 | 1;
  /** Whether the pair trades now; false refuses every order (alert only). */
  live: () => boolean;
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

  async #guard(side: LegSide, size: bigint, reduceOnly: boolean, reason: string, send: () => Promise<LegOutcome>): Promise<LegOutcome> {
    const at = (this.#o.now ?? Date.now)();
    const refuse = (why: string): LegOutcome => {
      const ref: LegRef = { venue: this.venue, side, size: qtyString(size), reduceOnly, orderId: null, clientId: null, tx: [], sentAt: at };
      return { kind: 'failed', error: new LegCheckError(`${this.venue} ${this.symbol}: ${why}; nothing signed`), ref };
    };
    if (!this.#o.live()) return refuse('alert only: this engine does not trade');
    if (!reduceOnly) return refuse('serve sends reduce-only orders only, and this one could open or grow a position');
    try {
      this.#o.beforeSign({ index: this.#o.index, venue: this.venue, side, size: qtyString(size), reduceOnly, reason, at });
    } catch (err) {
      return refuse(`the trader state could not be saved before the order (${err instanceof Error ? err.message : String(err)})`);
    }
    // The order stays in the book after it answers: only the trader's recorded result takes it out (see the header).
    return send();
  }
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
  /** Refreshes the stored price so the IOC and its retry fit inside its life; throws when it cannot (nothing is sent). */
  freshPrice?: () => Promise<void>;
  /** Hyperliquid post-only orders a maker order could not settle, and their cancel by id. */
  pendingMaker?: () => readonly PendingMakerOrder[];
  cancelPending?: (reason: string) => Promise<string[]>;
  /** Writes the trader state (live only); throws when it could not. */
  save: () => void;
  /** What stays open after a close: serve logs and journals it. */
  onOpen?: (lines: string[]) => void;
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

  /** A protection's close: always reduce-only (see the header); throws, with nothing sent, when it cannot start. */
  async close(request: { reason: string; targets?: [bigint, bigint]; reduceOnly?: boolean }): Promise<PairResult> {
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
  /** The legs as two agreeing reads found them: [hyperliquid, phoenix]. */
  read: [bigint, bigint];
  saved: LoadedTraderState;
  /** GIMBAL_TRADER_FRESH as set (undefined: not set). */
  fresh: string | undefined;
  /** The value that asks for a fresh start of this desk: `<contract>/<desk>`. */
  freshWant: string;
  /** Where the state lives (for the messages). */
  path: string;
}

export interface StartPlan {
  /** False: the state does not allow trading (the reason in `why`); the pair is then alert only. */
  stateOk: boolean;
  why: string | null;
  /** Import this state, or else adopt `adopt`. */
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
}

const flat = (p: readonly (bigint | null)[]): boolean => p.every((x) => x === 0n);
const text = (p: readonly (bigint | null)[]): string => `hyperliquid ${p[0] === null ? 'unknown' : signedQtyString(p[0]!)}, phoenix ${p[1] === null ? 'unknown' : signedQtyString(p[1]!)}`;

/** What in a usable saved state a fresh start would forget: each one refuses GIMBAL_TRADER_FRESH. */
export function freshBlockers(s: LoadedTraderFile): string[] {
  const out: string[] = [];
  if (s.adl.event !== null) out.push(`an ADL event in progress (since ${new Date(s.adl.event.at).toISOString()})`);
  if (s.adl.attemptsLeft < ADL_ATTEMPTS) out.push(`an ADL budget already spent in part (${s.adl.attemptsLeft} of ${ADL_ATTEMPTS} attempts left)`);
  const unsettled = s.trader?.unsettled.length ?? 0;
  if (unsettled > 0) out.push(`${unsettled} leg(s) with an order that may still run`);
  if (s.inFlight.length > 0) out.push(`${s.inFlight.length} order(s) in flight when the engine stopped`);
  return out;
}

/** What the trader holds at start (see the header). */
export function startPlan(input: StartInput): StartPlan {
  const { read, saved, symbol } = input;
  const freshNotes: string[] = [];
  let fresh = false;
  if (input.fresh !== undefined) {
    const blockers = saved.kind === 'loaded' ? freshBlockers(saved.state) : [];
    if (input.fresh !== input.freshWant) {
      freshNotes.push(`GIMBAL_TRADER_FRESH=${JSON.stringify(input.fresh)} is ignored: a fresh start names this contract and desk, GIMBAL_TRADER_FRESH=${input.freshWant}, for one start only`);
    } else if (blockers.length > 0) {
      freshNotes.push(`GIMBAL_TRADER_FRESH is refused: ${input.path} holds ${blockers.join(', ')}; the saved state is used. Remove GIMBAL_TRADER_FRESH`);
    } else {
      fresh = true;
    }
  }
  const plan = (p: Omit<StartPlan, 'notes'> & { notes: string[] }): StartPlan => ({ ...p, notes: [...freshNotes, ...p.notes] });
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
  const hold = inFlight.length === 0
    ? null
    : `${inFlight.length} order(s) were in flight when the engine stopped (${inFlight.map((f) => `${f.venue} ${f.side} ${f.size}`).join(', ')}), so a leg may have moved by our own order: ADL only alerts until a close result or an adopt sets the baselines`;
  const t = s.trader;
  const freshPair = (why: string): StartPlan => adopted(true, null, [why], newAdlState(), s.pendingMaker, inFlight, hold);
  if (s.symbol !== null && s.symbol !== symbol) {
    const idle = t === null || (flat(t.baselines) && t.unsettled.length === 0 && s.adl.event === null);
    if (idle && s.pendingMaker.length === 0 && inFlight.length === 0) return freshPair(`the saved state is for ${s.symbol}, flat; the venues hold ${text(read)} ${symbol}: adopted as a new pair, a new ADL budget of ${ADL_ATTEMPTS}`);
    return adopted(false, `${input.path} is for ${s.symbol} with legs or orders open, but the venues are read for ${symbol}: reconcile ${s.symbol} by hand, then ${how}`, [], s.adl, s.pendingMaker, inFlight, hold);
  }
  // Both legs flat: nothing is left to protect, and a reduce-only order of ours (all serve sends) cannot run on a flat leg.
  const flatAdopt = (note: string): StartPlan => adopted(true, null, [note], { ...s.adl, event: null }, s.pendingMaker, [], null);
  if (t === null) {
    if (flat(read)) return flatAdopt('no pair in the saved state and both legs flat: adopted flat');
    return freshPair(`no pair in the saved state; the venues hold ${text(read)} ${symbol}: adopted as a new pair, a new ADL budget of ${ADL_ATTEMPTS}`);
  }
  const restore = (note: string): StartPlan => plan({ stateOk: true, why: null, restore: t, adopt: null, adl: s.adl, pendingMaker: s.pendingMaker, inFlight, adlHold: hold, notes: [note] });
  const base = t.baselines;
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
