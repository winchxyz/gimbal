// serve's pair: the open carry pair the engine protects next to it, 24/7. It never opens. What it sends are the
// protections' closes, all reduce-only, through the PairTrader (its legging guard, its unsettled-order watch):
//   - panic_close (rescue/closing.ts): both legs to zero;
//   - a rescue's reduce (rescue/rescuer.ts): both legs smaller by the same size;
//   - an ADL unwind (risk/adl.ts): both legs to zero.
//
// GuardedLeg wraps each venue leg: an order that is not reduce-only is refused before anything is signed, so nothing
// serve sends can open or grow a position (a PairTrader close re-hedges by reopening a leg unless reduceOnly is set;
// every close here sets it, and the leg refuses one anyway). While the pair does not trade (alert only) every order is
// refused the same way. Before an order is signed the order in flight is saved (trader-state.ts); a save that fails
// refuses the order, so no order goes out that the state on disk does not name.
//
// ProtectedPair runs each close: the Hyperliquid post-only orders a maker order left unsettled are cancelled by their
// ids first, the stored price is refreshed when it would not outlive the IOC and its retry (pair-mainnet-lib.ts
// ensureFresh, the 300 s life of a fresh price at oracle_max_age_s 900), then the trader closes reduce-only, and the
// state is saved. What stays open afterwards (an order with no answer, a post-only order not settled, legs that do not
// offset) comes out as `open:` lines, as pair-mainnet prints them.
//
// startPlan decides at start what the trader holds: the saved state, or the venues' positions (adopted). A missing or
// unusable state file is never a fresh start unless GIMBAL_TRADER_FRESH=1 asks for one; and a saved pair whose legs
// now read smaller is restored, not adopted, so the ADL watch sees the shrink.

import type { VenueId } from '@gimbal/shared';
import type { AdlState } from '../risk/adl.ts';
import { ADL_ATTEMPTS, newAdlState } from '../risk/adl.ts';
import type { LegOutcome, LegRef, LegSide, PendingMakerOrder, TradeLeg } from './legs.ts';
import { LegCheckError } from './legs.ts';
import { qtyString, signedQtyString } from './lots.ts';
import type { PairResult, PairTrader, PairTraderState } from './pair.ts';
import type { InFlightOrder, LoadedTraderState } from './trader-state.ts';

export interface GuardedLegOptions {
  index: 0 | 1;
  /** Whether the pair trades now; false refuses every order (alert only). */
  live: () => boolean;
  /** Saves the order in flight; throws when it could not (the order is then refused). */
  beforeSign: (order: InFlightOrder) => void;
  /** The order answered (or classified): the in-flight mark is cleared. */
  afterSign: () => void;
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

  beginMakerOperation(): void {
    this.inner.beginMakerOperation?.();
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
    try {
      return await send();
    } finally {
      try {
        this.#o.afterSign();
      } catch {
        // The next save writes it; the order's outcome is in the trader already.
      }
    }
  }
}

export interface ProtectedPairOptions {
  trader: PairTrader;
  symbol: string;
  /** Whether the pair trades; false: every close is refused (alert only), and `why` says why. */
  live: boolean;
  why?: string | null;
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
}

/** The pair as the protections see it: rescue/rescuer.ts's Reducer and risk/adl.ts's AdlTrader. */
export class ProtectedPair {
  readonly trader: PairTrader;
  readonly symbol: string;
  readonly live: boolean;
  readonly why: string | null;
  readonly #o: ProtectedPairOptions;

  constructor(options: ProtectedPairOptions) {
    this.#o = options;
    this.trader = options.trader;
    this.symbol = options.symbol;
    this.live = options.live;
    this.why = options.why ?? null;
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
    this.#save();
  }

  /** A protection's close: always reduce-only (see the header); throws, with nothing sent, when it cannot start. */
  async close(request: { reason: string; targets?: [bigint, bigint]; reduceOnly?: boolean }): Promise<PairResult> {
    if (!this.live) {
      throw new Error(`alert only (${this.why ?? 'this engine does not trade'}): nothing is signed; close the legs by hand (stop serve, then pair-mainnet close ${this.symbol} --send)`);
    }
    if ((this.#o.pendingMaker?.() ?? []).length > 0 && this.#o.cancelPending !== undefined) {
      for (const line of await this.#o.cancelPending(`${request.reason}: cancel post-only orders left unsettled`)) this.#log(`cancel    ${line}`);
      this.#save();
    }
    await this.#o.freshPrice?.();
    let result: PairResult;
    try {
      result = await this.trader.close({ ...request, reduceOnly: true });
    } finally {
      this.#save();
      const open = this.openLines();
      if (open.length > 0) this.#o.onOpen?.(open);
    }
    return result;
  }

  /** What stays open now, as pair-mainnet prints it: `open:` lines (empty when nothing). */
  openLines(): string[] {
    const out: string[] = [];
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
  /** GIMBAL_TRADER_FRESH=1: adopt the venues' positions, a new budget, whatever the file says. */
  fresh: boolean;
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
  /** What was decided, one line each. */
  notes: string[];
  /** What may still be open from before the restart (`open:` lines). */
  open: string[];
}

const flat = (p: readonly (bigint | null)[]): boolean => p.every((x) => x === 0n);
const text = (p: readonly (bigint | null)[]): string => `hyperliquid ${p[0] === null ? 'unknown' : signedQtyString(p[0]!)}, phoenix ${p[1] === null ? 'unknown' : signedQtyString(p[1]!)}`;

/** What the trader holds at start (see the header). */
export function startPlan(input: StartInput): StartPlan {
  const { read, saved, fresh, symbol } = input;
  const adopted = (stateOk: boolean, why: string | null, notes: string[], adl: AdlState = newAdlState(), pendingMaker: PendingMakerOrder[] = [], open: string[] = []): StartPlan => ({
    stateOk, why, restore: null, adopt: read, adl, pendingMaker, notes, open,
  });
  if (fresh) {
    return adopted(true, null, [`GIMBAL_TRADER_FRESH=1: adopted ${text(read)} ${symbol} as the pair${read[0] + read[1] === 0n ? '' : ' (NOT offsetting: unhedged)'}; a new ADL budget of ${ADL_ATTEMPTS} unwinds; ${input.path} is written anew`]);
  }
  if (saved.kind === 'none') {
    const why = `no trader state at ${input.path}: a missing file is not a fresh start (an order may still be in flight); after checking both legs on the venues, start once with GIMBAL_TRADER_FRESH=1`;
    return adopted(false, why, [`venues read ${text(read)} ${symbol} (held in memory only)`]);
  }
  if (saved.kind === 'unusable') return adopted(false, `${saved.problem}; after reconciling both legs, start once with GIMBAL_TRADER_FRESH=1`, [`venues read ${text(read)} ${symbol} (held in memory only)`]);

  const s = saved.state;
  const open: string[] = [];
  if (s.inFlight !== null) {
    const f = s.inFlight;
    open.push(`open:     ${f.venue} ${f.side} ${f.size} ${symbol}${f.reduceOnly ? ' reduce-only' : ''} (${f.reason}) was being sent at ${new Date(f.at).toISOString()} when the engine stopped, with no answer recorded: check ${f.venue} ${symbol} by hand`);
  }
  const t = s.trader;
  const fresh_pair = (why: string): StartPlan => adopted(true, null, [why], newAdlState(), s.pendingMaker, open);
  if (s.symbol !== null && s.symbol !== symbol) {
    const idle = t === null || (flat(t.baselines) && t.unsettled.length === 0 && s.adl.event === null);
    if (idle && s.pendingMaker.length === 0) return fresh_pair(`the saved state is for ${s.symbol}, flat; the venues hold ${text(read)} ${symbol}: adopted as a new pair, a new ADL budget of ${ADL_ATTEMPTS}`);
    return { ...adopted(false, `${input.path} is for ${s.symbol} with legs or orders open, but the venues are read for ${symbol}: reconcile ${s.symbol} by hand, then start once with GIMBAL_TRADER_FRESH=1`, [], s.adl, s.pendingMaker, open) };
  }
  if (t === null) {
    if (flat(read)) return { ...adopted(true, null, [`no pair in the saved state and both legs flat: adopted flat`], s.adl, s.pendingMaker, open) };
    return fresh_pair(`no pair in the saved state; the venues hold ${text(read)} ${symbol}: adopted as a new pair, a new ADL budget of ${ADL_ATTEMPTS}`);
  }
  const restore = (note: string): StartPlan => ({ stateOk: true, why: null, restore: t, adopt: null, adl: s.adl, pendingMaker: s.pendingMaker, notes: [note], open });
  const base = t.baselines;
  if (t.unsettled.length > 0 || s.adl.event !== null || s.pendingMaker.length > 0) {
    return restore(`restored from ${input.path}: baselines ${text(base)}, venues ${text(read)}${t.unsettled.length > 0 ? `, ${t.unsettled.length} leg(s) with an order that may still run` : ''}${s.adl.event !== null ? ', an ADL event in progress' : ''}${s.pendingMaker.length > 0 ? `, ${s.pendingMaker.length} post-only order(s) not settled` : ''}`);
  }
  if (base[0] === read[0] && base[1] === read[1]) return restore(`restored from ${input.path}: ${text(read)} ${symbol}, as saved`);
  if (base.some((b) => b === null)) return restore(`restored from ${input.path}: a saved baseline is unknown (${text(base)}), venues ${text(read)}: ADL is not checked until the next close or GIMBAL_TRADER_FRESH=1`);
  if (flat(base) && !flat(read) && read[0] + read[1] === 0n) {
    return fresh_pair(`a new pair opened since the last run (saved flat): adopted ${text(read)} ${symbol}, a new ADL budget of ${ADL_ATTEMPTS}${s.adl.paused === null ? '' : `; the ADL pause (${s.adl.paused}) ends with it`}`);
  }
  if (flat(read)) {
    return { ...adopted(true, null, [`both legs read flat (saved ${text(base)}): closed since the last run; adopted flat`], { ...s.adl, event: null }, s.pendingMaker, open) };
  }
  return restore(`restored from ${input.path}: baselines ${text(base)}, but the venues read ${text(read)}: the ADL watch compares them (a shrink is unwound; anything else is the owner's)`);
}
