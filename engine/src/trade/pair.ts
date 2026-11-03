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
// more is sent for either leg, and the result says why. A position that cannot be read counts as open: the pair is
// unhedged until it reads again. An open's other leg is not unwound then (it may hedge a fill that cannot be read);
// when the leg reads again unmoved, its order had not run, and the other leg goes back as a first read would have
// sent it.
//
// Unsettled orders: such an order (no answer, no expiry, not run when read, or not read at all) can still run until
// Hyperliquid's nonce window ends, 2 days after it was signed. Its leg stays watched until then, whatever the leg
// holds meanwhile: read every 15 s (nothing pushes Hyperliquid positions), and a move away from where the order left
// it means the order ran, after which the leg is reconciled against the pair's intent like a replayed copy. The pair
// means that leg to offset its partner. A move that stops with one leg not offset (a close whose Orderly leg is flat
// while the Hyperliquid reduce-only has no answer) is unhedged: the result says so and `unhedged` is set; the watch
// clears it once the order runs and the pair offsets again. When the window ends the leg is read once more (a
// landing in its last seconds is reconciled like any other); then the alert is raised again (the legs do not offset,
// or the leg cannot be read) or cleared (they offset). While an order is unsettled, open is refused, and so is any
// order on its leg that is not reduce-only: either could double it. A reduce-only close still goes out (it cannot
// double anything), and the old order stays watched until its own window ends.
//
// Replays (Orderly): every signed order is public and can be sent again inside Orderly's 300 s window, a refused or
// unfilled one too. Every order that got a signature arms the leg's watch for that window; a position push during it
// is checked against the pair's final intent (what the last open or close left each leg holding). An excess is closed
// reduce-only; a deficit (a copy of a reducing order) leaves the pair unhedged, so the partner is closed reduce-only
// by the same amount.
//
// Reduce-only moves are split into orders under the policy's notional cap; a close never needs one order larger than
// the open it undoes, but a position grown by copies can. Each order prices itself again when it goes out, and the cap
// is valued at max(price, oracle) ≤ oracle × (1 + band), so a chunk sized at the cap now could be over it after an
// uptick: chunks are cap × 10^4 / (10^4 + band), which fits at any price inside the band. A close that would take
// more than MAX_CLOSE_ORDERS such orders on a leg is refused before anything is sent, rather than stopped half way.

import type { TxRef, VenueId } from '@gimbal/shared';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import type { LegOutcome, LegRef, LegSide, TradeLeg } from './legs.ts';
import { HL_EXPIRY_MARGIN_MS, HL_NONCE_WINDOW_MS, LegCheckError, ORDERLY_REPLAY_MS, wasSigned } from './legs.ts';
import { abs, commonLot, floorToLot, qtyString, signedQtyString, toQty } from './lots.ts';
import { outsideOpen } from './open-scope.ts';

/** Orderly takes a signed request until 300 s after its timestamp; a little more covers clock skew. */
export const REPLAY_WINDOW_MS = ORDERLY_REPLAY_MS;
/** How long an unsettled order (no answer, no expiry) can still run after it was sent: Hyperliquid's nonce window. */
export const UNSETTLED_WATCH_MS = HL_NONCE_WINDOW_MS + HL_EXPIRY_MARGIN_MS;
/** How often a leg with an unsettled order is read while it is watched. */
export const UNSETTLED_POLL_MS = 15_000;
/** A close that needs more reduce-only orders than this on one leg, at today's cap, is refused before it starts. */
export const MAX_CLOSE_ORDERS = 40;
/** A split reduce-only move stops after this many orders (room for copies and price moves past the close's count). */
const MAX_MOVE_ORDERS = 50;

export type PairStatus =
  | 'open'        // both legs at their open targets
  | 'closed'      // both legs at their close targets
  | 'flat'        // an open that did not happen: both legs back at their start
  | 'stuck'       // a leg could not reach its target, or the request was refused; the desk is hedged (see notes)
  | 'unhedged';   // one leg is exposed alone, or a position cannot be read: the owner must act

export interface LegOrderRecord {
  ref: LegRef;
  outcome: LegOutcome['kind'];
  filled: string | null;         // canonical, when the venue said
  avgPx: number | null;
  /** What the venue charged for this fill, USD; null when it did not say (or nothing filled). */
  fee: number | null;
  error: string | null;
  purpose: 'open' | 'retry' | 'unwind' | 'close' | 'rehedge' | 'excess' | 'deficit';
  /** One part of a maker order (a post-only limit, or the IOC after its timeout). */
  maker?: true;
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
  /** The fees of every fill of this open or close, USD, as the venues reported them. */
  feeUsd: number;
  /** Fills whose fee the venue did not report (not in feeUsd). */
  feeUnknown: number;
}

/** Maker first: leg `index` goes first as a maker order (TradeLeg.makerOrder), its partner after it as an IOC. */
export interface MakerFirst {
  index: 0 | 1;
}

/** PairTrader.close's request (see there). */
export interface CloseRequest {
  reason: string;
  targets?: [bigint, bigint];
  reduceOnly?: boolean;
  maker?: MakerFirst;
  clampTargets?: boolean;
}

/** What one push check did: the watched leg first, then its partner when a deficit moved it. */
export interface WatchReport {
  status:
    | 'reconciled'   // an excess was closed: the leg holds its intent again
    | 'rehedged'     // a deficit, matched by closing the partner by as much: hedged again, at a smaller size
    | 'settled'      // an unsettled order ran and left its leg at its intent, or its leg reads again: the legs offset
    | 'lapsed'       // an unsettled order's window ended without it running, and the legs offset each other
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
  /**
   * Every push check that found the leg off its intent, and every change an unsettled order's watch saw: an
   * 'unhedged' report is an alert for the owner.
   */
  onWatch?: (report: WatchReport) => void;
  /**
   * How often a leg with an unsettled order is read (default UNSETTLED_POLL_MS); null: only positionPushed feeds it.
   * The poll sleeps on `sleep` when one is given, else on an unref'd timer that stop() ends.
   */
  unsettledPollMs?: number | null;
  /** Why no open may go out now (a desk closing after panic_close), or null; read before every open. */
  openBlocked?: () => string | null;
}

/**
 * What a trader keeps across a restart (trade/trader-state.ts writes it to disk): what each leg should hold and what
 * the last open, close or adoption left it meaning to hold (the ADL baseline), where it last knew each leg to be, the
 * pair's net, the alert, and every order with no answer that may still run. Index 0 and 1 are `legs`.
 */
export interface PairTraderState {
  intents: [bigint | null, bigint | null];
  baselines: [bigint | null, bigint | null];
  known: [bigint | null, bigint | null];
  net: bigint;
  unhedged: string | null;
  unsettled: { index: 0 | 1; refs: LegRef[]; until: number; from: bigint; unwind: { to: bigint; reason: string; failed: boolean } | null }[];
}

/**
 * The unsettled orders on a leg (`ref` the latest of `refs`): one can still run until `until` (local ms); `from` is the
 * leg's position before the latest. `unwind`: an open stopped by a read that failed; when the leg reads again unmoved,
 * the other leg goes back to `to`.
 */
interface Unsettled {
  ref: LegRef;
  refs: LegRef[];
  until: number;
  from: bigint;
  unwind: Unwind | null;
}

/** An unwind of the other leg that waits for this one to read again unmoved; `failed`: the other leg's read failed. */
interface Unwind {
  to: bigint;
  reason: string;
  failed: boolean;
}

interface LegRun {
  leg: TradeLeg;
  start: bigint;
  target: bigint;
  pos: bigint | null;
  /**
   * An order with no answer and no expiry that had not run when read, or whose read failed: it may still run, so
   * nothing more goes on this leg. `unsettledFrom` is the position before it.
   */
  unsettled: LegOutcome | null;
  unsettledFrom: bigint | null;
  /** The hedge of a maker leg's known fill that an order with no answer stopped: #halt does not unwind it. */
  keep?: boolean;
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
  readonly #openBlocked: () => string | null;
  readonly #pollSleep: (ms: number) => Promise<void>;
  /** stop() was called: no poll runs or starts any more. */
  #ended = false;
  /** Ends the polls' unref'd timers early (stop()). */
  readonly #wakes = new Set<() => void>();
  #queue: Promise<unknown> = Promise.resolve();
  /** Tasks queued or running on #queue. */
  #active = 0;
  /**
   * What each leg should hold: the final position of the last open or close (null: it was unknown); for a leg with an
   * unsettled order, what offsets its partner.
   */
  readonly #intent = new Map<TradeLeg, bigint | null>();
  /**
   * What the last open, close or adoption left each leg meaning to hold. Unlike #intent, a watch check (a replayed copy
   * reconciled, a deficit matched) never moves it: the ADL watch compares the venues with this, so nothing but the
   * trader's own results can make a leg that shrank look expected.
   */
  readonly #baseline = new Map<TradeLeg, bigint | null>();
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
   * Counts the times the baselines were set from the venues: every open or close result and every adopt (not a
   * refusal that sent nothing, nor importState). A caller compares it before and after an operation.
   */
  baselineEpoch = 0;
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
    this.#openBlocked = options.openBlocked ?? (() => null);
    this.#pollMs = options.unsettledPollMs === undefined ? UNSETTLED_POLL_MS : options.unsettledPollMs;
    // A watch that lasts 2 days must not keep a CLI alive: its timer is unref'd, and stop() ends it.
    this.#pollSleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.#wakes.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      timer.unref();
      this.#wakes.add(wake);
    }));
  }

  /**
   * Ends the unsettled orders' polls (a CLI calls it before it exits). What they watch stays as it was: unsettled()
   * still names each order, and open and close still refuse while one can run. A push after it (or a check queued
   * before it) trades nothing: the process is ending, and finish() reads the legs itself.
   */
  stop(): void {
    this.#ended = true;
    for (const wake of [...this.#wakes]) wake();
  }

  /**
   * `size` in base units, rounded down to the coarser lot; leg `longIndex` buys, the other sells. With `maker`, that
   * leg goes first as a maker order and its partner follows as an IOC sized to what the first actually filled
   * (rounded down to the common lot; the first leg's excess is closed reduce-only), so the pair may open smaller.
   */
  open(request: { size: bigint | number | string; longIndex: 0 | 1; reason: string; maker?: MakerFirst }): Promise<PairResult> {
    return this.#serial(async () => {
      const end = this.#beginMaker(request.maker);
      try {
        return await this.#open(request);
      } finally {
        end();
      }
    });
  }

  /**
   * An open split into pairs under the policy cap (openChunk), each one a whole open with its own legging guard. Stops
   * at the first part that does not end open, or that opened less than asked (a maker leg that did not fill).
   */
  async openInChunks(request: {
    size: bigint | number | string; longIndex: 0 | 1; reason: string; maker?: MakerFirst;
    /** Runs before each part (a CLI refreshes the stored price there); a throw stops the open before that part. */
    beforePart?: (part: number, parts: number) => Promise<void>;
  }): Promise<PairResult[]> {
    const total = floorToLot(typeof request.size === 'bigint' ? request.size : toQty(request.size), this.lot);
    if (total === 0n) throw new LegCheckError(`size ${String(request.size)} is under one common lot ${qtyString(this.lot)}`);
    const chunk = await this.openChunk(request.longIndex);
    const parts = Number((total + chunk - 1n) / chunk);
    if (parts > MAX_CLOSE_ORDERS) throw new LegCheckError(`an open of ${qtyString(total)} needs ${parts} pairs of at most ${qtyString(chunk)}, over ${MAX_CLOSE_ORDERS}`);
    const results: PairResult[] = [];
    let left = total;
    let endMaker = (): void => {};
    try {
      for (let i = 1; left > 0n; i++) {
        const size = left > chunk ? chunk : left;
        if (request.beforePart !== undefined) {
          try {
            await request.beforePart(i, parts);
          } catch (err) {
            results.push(this.#refused(size, [`part ${i} of ${parts} not sent: ${errorText(err)}`]));
            break;
          }
        }
        const part = { longIndex: request.longIndex, ...(request.maker === undefined ? {} : { maker: request.maker }), size, reason: parts === 1 ? request.reason : `${request.reason} (part ${i} of ${parts})` };
        // One maker budget for the whole open, every part and move included: begun with the first part, ended after
        // the last (the operation's own end function: a later operation's budget is not touched).
        const first = i === 1;
        const r = await this.#serial(() => {
          if (first) endMaker = this.#beginMaker(request.maker);
          return this.#open(part);
        });
        results.push(r);
        const opened = toQty(r.size);
        if (r.status !== 'open' || opened < size) break;
        left -= opened;
      }
    } finally {
      endMaker();
    }
    return results;
  }

  /**
   * The largest pair one open may send: on each leg the cap at today's price, less the band (as a reduce-only chunk,
   * see the header: the order prices itself again when it goes out), floored to the common lot.
   */
  async openChunk(longIndex: 0 | 1): Promise<bigint> {
    let chunk: bigint | null = null;
    for (const [i, leg] of this.legs.entries()) {
      const cap = abs(await leg.maxSize(i === longIndex ? 'BUY' : 'SELL', false));
      const band = BigInt(Math.ceil(this.#bandBps));
      const max = floorToLot((cap * 10_000n) / (10_000n + band), this.lot);
      if (chunk === null || max < chunk) chunk = max;
    }
    if (chunk === null || chunk === 0n) throw new LegCheckError(`the policy cap allows less than one common lot ${qtyString(this.lot)} per order`);
    return chunk;
  }

  /**
   * Brings both legs to `targets` (default flat) with reduce-only orders. A leg that stays open is normally re-hedged by
   * reopening its partner against it (not reduce-only); `reduceOnly: true` forbids that step, so nothing this close
   * sends can open or grow a position (the ADL response): the pair is then left stuck or unhedged, with the alert.
   * `clampTargets`: each target is brought between 0 and the leg's position as read when the close runs (a target
   * computed from an older read, queued behind another close, must not ask a leg to grow or cross zero).
   */
  close(request: CloseRequest): Promise<PairResult> {
    return this.#serial(async () => {
      const end = this.#beginMaker(request.maker);
      try {
        return await this.#close(request);
      } finally {
        end();
      }
    });
  }

  /**
   * A pair operation with a maker leg starts that leg's budget of post-only orders (TradeLeg.beginMakerOperation);
   * the function returned ends it.
   */
  #beginMaker(maker: MakerFirst | undefined): () => void {
    return (maker === undefined ? undefined : this.legs[maker.index].beginMakerOperation?.()) ?? (() => {});
  }

  /**
   * A position the venue pushed (or a session's seed read, or the unsettled poll's read) for a watched leg. Inside a
   * replayable leg's replay window, a position off the pair's intent queues one check (after whatever the trader is
   * doing now), which reads the venue again and closes an excess or matches a deficit on the partner. On a leg with an
   * unsettled order, a position away from where the trader left it does the same: the order ran. Resolves when
   * handled; never rejects.
   */
  positionPushed(leg: TradeLeg, position: bigint): Promise<void> {
    // A watch check is never part of an open, whatever runs when the push arrives (open-scope.ts).
    return outsideOpen(() => this.#pushed(leg, position));
  }

  #pushed(leg: TradeLeg, position: bigint): Promise<void> {
    if (this.#ended) return Promise.resolve();
    if (!this.watching(leg)) {
      this.#until.delete(leg);
      if (this.#unsettled.has(leg)) return this.#serial(() => this.#lapse(leg)).catch((err) => this.#log(`${leg.venue} ${leg.symbol}: ${errorText(err)}`));
      return Promise.resolve();
    }
    const unsettled = this.#unsettled.get(leg);
    // An unmoved push is nothing new, unless an unwind waits on it (its other leg could not be read last time).
    if (unsettled !== undefined ? this.#known.get(leg) === position && unsettled.unwind === null : this.#intent.get(leg) === position) return Promise.resolve();
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

  /** The unsettled orders on a leg (`ref` the latest), while one can still run. */
  unsettled(leg: TradeLeg): { ref: LegRef; refs: LegRef[]; until: number } | null {
    const u = this.#unsettled.get(leg);
    return u === undefined ? null : { ref: u.ref, refs: [...u.refs], until: u.until };
  }

  /** What the pair means each leg to hold now (null: unknown; undefined: no open or close yet). */
  intent(leg: TradeLeg): bigint | null | undefined {
    return this.#intent.get(leg);
  }

  /** What both legs together should hold: the sum of the last open's or close's targets (0 for a plain pair). */
  get net(): bigint {
    return this.#net;
  }

  /** Where the trader last read the leg (a result, a watch check or a lapse; null: unknown; undefined: never read). */
  known(leg: TradeLeg): bigint | null | undefined {
    return this.#known.get(leg);
  }

  /** What the last open, close or adoption left the leg meaning to hold (null: unknown; undefined: none yet). */
  baseline(leg: TradeLeg): bigint | null | undefined {
    return this.#baseline.get(leg);
  }

  /**
   * Takes the venues' positions as the pair (a trader that starts next to a pair opened elsewhere, or legs found flat):
   * intent, baseline and known position of each leg, and the net they should hold together. The alert is cleared when
   * they offset each other and set when they do not. Unsettled orders stay watched.
   */
  adopt(positions: readonly [bigint, bigint], net = 0n): void {
    this.baselineEpoch++;
    this.#net = net;
    for (const [i, leg] of this.legs.entries()) {
      this.#intent.set(leg, positions[i]!);
      this.#baseline.set(leg, positions[i]!);
      this.#known.set(leg, positions[i]!);
    }
    const off = positions[0] + positions[1] - net;
    this.unhedged = off === 0n
      ? null
      : `unhedged: adopted ${this.legs.map((l, i) => `${l.venue} ${l.symbol} ${signedQtyString(positions[i]!)}`).join(', ')}, which do not offset each other`;
    this.#log(`adopted ${this.legs.map((l, i) => `${l.venue} ${l.symbol} ${signedQtyString(positions[i]!)}`).join(', ')}${off === 0n ? '' : ' (NOT offsetting)'}`);
  }

  /** The state a restart needs (see PairTraderState). */
  exportState(): PairTraderState {
    const pair = <T>(m: Map<TradeLeg, T>): [T | null, T | null] => [m.get(this.legs[0]) ?? null, m.get(this.legs[1]) ?? null];
    const unsettled: PairTraderState['unsettled'] = [];
    for (const [i, leg] of this.legs.entries()) {
      const u = this.#unsettled.get(leg);
      if (u === undefined) continue;
      unsettled.push({ index: i as 0 | 1, refs: u.refs.map((r) => ({ ...r, tx: [...r.tx] })), until: u.until, from: u.from, unwind: u.unwind === null ? null : { ...u.unwind } });
    }
    return { intents: pair(this.#intent), baselines: pair(this.#baseline), known: pair(this.#known), net: this.#net, unhedged: this.unhedged, unsettled };
  }

  /**
   * A saved state back in a new trader, before it trades: each order with no answer is watched again until its own
   * window ends (its poll starts), and the intents are the saved ones, not what the venues hold now.
   */
  importState(s: PairTraderState): void {
    if (this.#active > 0) throw new Error('importState: the trader is busy');
    this.#net = s.net;
    for (const [i, leg] of this.legs.entries()) {
      this.#intent.set(leg, s.intents[i] ?? null);
      this.#baseline.set(leg, s.baselines[i] ?? null);
      this.#known.set(leg, s.known[i] ?? null);
    }
    this.unhedged = s.unhedged;
    for (const u of s.unsettled) {
      const leg = this.legs[u.index];
      const ref = u.refs.at(-1);
      if (ref === undefined) continue;
      this.#unsettled.set(leg, { ref, refs: [...u.refs], until: u.until, from: u.from, unwind: u.unwind });
      this.#log(`${leg.venue} ${leg.symbol}: ${u.refs.length === 1 ? 'an order' : `${u.refs.length} orders`} with no answer from before the restart (${u.refs.map(refId).join(', ')}): watched until ${iso(u.until)}`);
      this.#poll(leg);
    }
  }

  /**
   * An open, a close or a watch check is queued or running: the trader's own orders may be moving the legs now, so a
   * position that differs from the intent is not news (the risk engine's ADL check waits until this is false).
   */
  get busy(): boolean {
    return this.#active > 0;
  }

  async #open(request: { size: bigint | number | string; longIndex: 0 | 1; reason: string; maker?: MakerFirst }): Promise<PairResult> {
    const size = floorToLot(typeof request.size === 'bigint' ? request.size : toQty(request.size), this.lot);
    if (size === 0n) throw new LegCheckError(`size ${String(request.size)} is under one common lot ${qtyString(this.lot)}`);
    const closing = this.#openBlocked();
    if (closing !== null) return this.#refused(size, [`open refused, nothing sent: ${closing}`]);
    const blocked = await this.#blocked(size);
    if (blocked !== null) return blocked;
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

    let opened = size;
    if (request.maker === undefined) {
      await Promise.all(runs.map((r) => this.#move(r, r.target, false, request.reason, 'open')));
    } else {
      const hedge = await this.#makerFirstOpen(runs, request.maker.index, size, request.reason, notes);
      if (hedge === null) return this.#halt(runs, notes, size, net, request.reason);
      opened = hedge;
    }
    if (this.#stopped(runs, notes)) return this.#halt(runs, notes, opened, net, request.reason);
    if (runs.every((r) => r.pos === r.target)) return this.#result(opened === 0n ? 'flat' : 'open', opened, runs, notes, net);
    if (runs.every((r) => r.pos === r.start)) {
      notes.push('neither leg traded: nothing to unwind');
      return this.#result('flat', size, runs, notes, net);
    }

    // Legging: retry what is missing, once.
    const short = runs.filter((r) => r.pos !== r.target);
    notes.push(`legging: ${short.map((r) => `${r.leg.venue} at ${signedQtyString(r.pos!)} of ${signedQtyString(r.target)}`).join(', ')}; retrying once`);
    await Promise.all(short.map((r) => this.#move(r, r.target, false, `${request.reason} (retry)`, 'retry')));
    if (this.#stopped(runs, notes)) return this.#halt(runs, notes, opened, net, request.reason);
    if (runs.every((r) => r.pos === r.target)) return this.#result('open', opened, runs, notes, net);

    // Still legged: both legs back to their start, reduce-only, with one retry each.
    notes.push(`still legged after the retry: unwinding both legs to their start`);
    for (const r of runs) r.target = r.start;
    for (let attempt = 0; attempt < 2; attempt++) {
      const off = runs.filter((r) => r.pos !== r.start);
      if (off.length === 0) break;
      await Promise.all(off.map((r) => this.#move(r, r.start, true, `${request.reason} (unwind${attempt === 0 ? '' : ' retry'})`, 'unwind')));
      if (this.#stopped(runs, notes)) return this.#stop(opened, runs, notes, net);
    }
    if (runs.every((r) => r.pos === r.start)) return this.#result('flat', opened, runs, notes, net);
    notes.push('the unwind did not bring both legs back');
    return this.#result(hedged(runs, net) ? 'stuck' : 'unhedged', opened, runs, notes, net);
  }

  /**
   * The maker-first open: the maker leg works its order (TradeLeg.makerOrder), then its partner goes as one IOC for
   * what the maker leg actually filled, rounded down to the common lot; a fill past that (a finer lot) is closed
   * reduce-only first. Both targets are set to the hedge, so the legging guard after it works on the real size.
   * Returns the hedge size (0: nothing to hedge), or null when the maker leg stopped on an unsettled order or a lost
   * position (the caller halts). On an unsettled order, what its filled parts are known to have filled is hedged
   * first (#hedgeKnownFill), and that hedge is kept; otherwise the partner has not moved.
   */
  async #makerFirstOpen(runs: [LegRun, LegRun], index: 0 | 1, size: bigint, reason: string, notes: string[]): Promise<bigint | null> {
    const first = runs[index];
    const second = runs[index === 0 ? 1 : 0];
    if (first.leg.makerOrder === undefined) throw new Error(`${first.leg.venue} has no maker order`);
    await this.#makerMove(first, first.target, false, `${reason} (maker)`, 'open');
    if (this.#stopped([first], notes)) {
      await this.#hedgeKnownFill(first, second, false, reason, notes);
      return null;
    }
    const moved = first.pos! - first.start;
    const dir = first.target > first.start ? 1n : -1n;
    if (moved * dir < 0n) {
      // Something else traded the leg the other way: both targets back to the start; the guard after this unwinds.
      notes.push(`${first.leg.venue} moved ${signedQtyString(moved)}, against the open`);
      first.target = first.start;
      second.target = second.start;
      return 0n;
    }
    const hedge = floorToLot(abs(moved), this.lot);
    first.target = first.start + dir * hedge;
    second.target = second.start - dir * hedge;
    if (moved === 0n) {
      notes.push(`the maker leg ${first.leg.venue} did not fill: nothing to hedge, nothing opened`);
      return 0n;
    }
    if (hedge !== abs(moved)) {
      notes.push(`${first.leg.venue} filled ${qtyString(abs(moved))}, not a whole common lot ${qtyString(this.lot)}: closing ${qtyString(abs(moved) - hedge)} of it reduce-only`);
      await this.#move(first, first.target, true, `${reason} (trim to the common lot)`, 'excess');
      if (this.#stopped([first], notes)) return null;
    }
    if (hedge === 0n) return 0n;
    if (hedge < size) notes.push(`the maker leg filled ${qtyString(hedge)} of ${qtyString(size)}: the pair opens at that size`);
    await this.#move(second, second.target, false, reason, 'open');
    return hedge;
  }

  async #close(request: CloseRequest): Promise<PairResult> {
    // Not refused while an order has no answer: a reduce-only close cannot double it, and its watch stays on.
    const starts = await Promise.all(this.legs.map((leg) => leg.position()));
    const asked = request.targets ?? [0n, 0n];
    const targets: [bigint, bigint] = request.clampTargets === true ? [towardZero(starts[0]!, asked[0]), towardZero(starts[1]!, asked[1])] : asked;
    const runs = this.legs.map((leg, i) => this.#run(leg, starts[i]!, targets[i]!)) as [LegRun, LegRun];
    const size = abs(starts[0]! - targets[0]!) > abs(starts[1]! - targets[1]!) ? abs(starts[0]! - targets[0]!) : abs(starts[1]! - targets[1]!);
    const notes: string[] = [];
    for (const i of [0, 1] as const) {
      if (targets[i] !== asked[i]) notes.push(`${this.legs[i].venue} target ${signedQtyString(asked[i])} is past its position ${signedQtyString(starts[i]!)} read now (toward zero only): ${signedQtyString(targets[i])}`);
    }
    // A clamped pair of targets may not offset each other: the net is what they hold together (risk/adl.ts: the pair
    // then counts as not hedged before until a close offsets the legs again).
    const net = targets[0] + targets[1];
    if (runs.every((r) => r.pos === r.target)) {
      notes.push('both legs were already at their close targets');
      return this.#result('closed', size, runs, notes, net);
    }
    // A close that cannot finish under the cap at today's price is refused whole: stopped half way, it would leave
    // one leg closed and its partner open.
    const tooMany: string[] = [];
    for (const r of runs) {
      const delta = crossesZero(r.start, r.target) ? -r.start : r.target - r.start;
      if (delta === 0n) continue;
      const max = await this.#chunkMax(r.leg, delta > 0n ? 'BUY' : 'SELL');
      const orders = max === null ? 1n : (abs(delta) + max - 1n) / max;
      if (orders > BigInt(MAX_CLOSE_ORDERS)) {
        tooMany.push(`${r.leg.venue} needs ${orders} reduce-only orders of at most ${qtyString(max!)} (the policy cap less the ${this.#bandBps} bps band) to go from ${signedQtyString(r.start)} to ${signedQtyString(r.target)}, over ${MAX_CLOSE_ORDERS}`);
      }
    }
    if (tooMany.length > 0) return this.#refused(size, [`close refused, nothing sent: ${tooMany.join('; ')}; close in parts (targets) or raise the cap`], starts);
    this.#log(`close: ${runs.map((r) => `${r.leg.venue} ${r.leg.symbol} ${signedQtyString(r.start)} -> ${signedQtyString(r.target)}`).join(', ')}`);
    for (const r of runs) {
      if (crossesZero(r.start, r.target)) notes.push(`${r.leg.venue}: target ${signedQtyString(r.target)} is on the other side of zero; a reduce-only close stops at 0`);
    }

    // A leg left unsettled here is not retried and its partner's close stands (it only reduced): if that leaves the
    // partner closed and the unsettled leg open, the pair is unhedged until the order runs (#stop).
    if (request.maker !== undefined && runs[request.maker.index].pos !== runs[request.maker.index].target) {
      await this.#makerFirstClose(runs, request.maker.index, request.reason, notes);
    } else {
      await Promise.all(runs.filter((r) => r.pos !== r.target).map((r) => this.#move(r, r.target, true, request.reason, 'close')));
    }
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
    if (request.reduceOnly === true) {
      notes.push('not re-hedged: this close is reduce-only only, and a re-hedge would reopen a leg');
      return this.#stop(size, runs, notes, net);
    }
    const lighter = abs(exposure(a)) <= abs(exposure(b)) ? a : b;
    const hedgeTo = lighter.pos! - residual;
    // Either leg with an order that can still run: on this one, a reopen could double it; on the other, it may have
    // run since its start was read (a reduce-only refused on a leg it already closed), and this one reopened against
    // it would be open alone. Not re-hedged: unhedged, with the alert.
    const heavier = lighter === a ? b : a;
    const blocker = [lighter, heavier].find((r) => this.#pendingOn(r.leg) !== undefined);
    if (blocker !== undefined) {
      const pending = this.#pendingOn(blocker.leg)!;
      const why = blocker === lighter
        ? 'an order on it that is not reduce-only could double that'
        : `it may have run since ${blocker.leg.venue} was read, and ${lighter.leg.venue} reopened against it would then be open alone`;
      notes.push(`not re-hedged: ${blocker.leg.venue} has ${pendingText(pending)} with no answer, which may still run until ${iso(pending.until)}; ${why}`);
      return this.#stop(size, runs, notes, net);
    }
    notes.push(`re-hedging: ${lighter.leg.venue} back to ${signedQtyString(hedgeTo)} against the leg that stayed open`);
    lighter.target = hedgeTo;
    await this.#move(lighter, hedgeTo, false, `${request.reason} (re-hedge)`, 'rehedge');
    if (this.#stopped(runs, notes)) return this.#stop(size, runs, notes, net);
    return this.#result(hedged(runs, net) ? 'stuck' : 'unhedged', size, runs, notes, net);
  }

  /**
   * The maker-first close: the maker leg closes reduce-only as a maker order; then its partner closes, reduce-only and
   * as an IOC, as much as the maker leg did (all of it when the maker leg reached its target, else the same amount in
   * the partner's lots). What is left on either leg goes to the close's retry, as IOCs.
   */
  async #makerFirstClose(runs: [LegRun, LegRun], index: 0 | 1, reason: string, notes: string[]): Promise<void> {
    const first = runs[index];
    const second = runs[index === 0 ? 1 : 0];
    if (first.leg.makerOrder === undefined) throw new Error(`${first.leg.venue} has no maker order`);
    await this.#makerMove(first, first.target, true, `${reason} (maker)`, 'close');
    if (this.#stopped([first], notes)) {
      await this.#hedgeKnownFill(first, second, true, reason, notes);
      return;
    }
    if (second.pos === null || second.pos === second.target) return;
    const closed = abs(first.pos! - first.start);
    if (first.pos === first.target) {
      await this.#move(second, second.target, true, reason, 'close');
      return;
    }
    const match = floorToLot(closed, second.leg.lot);
    if (match === 0n) {
      notes.push(`the maker leg ${first.leg.venue} closed ${qtyString(closed)}, under one ${second.leg.venue} lot: ${second.leg.venue} waits for the retry`);
      return;
    }
    const dir = second.target > second.start ? 1n : -1n;
    const to = abs(second.target - second.start) <= match ? second.target : second.start + dir * match;
    notes.push(`the maker leg ${first.leg.venue} closed ${qtyString(closed)} of ${qtyString(abs(first.target - first.start))}: ${second.leg.venue} closes ${qtyString(abs(to - second.start))} to match`);
    await this.#move(second, to, true, reason, 'close');
  }

  /**
   * A maker leg stopped by an order with no answer after parts of it filled: what those parts filled is known (the
   * order with no answer can only add to it), so the partner goes as one IOC for that much, rounded down to the
   * common lot on an open (reduce-only, in the partner's lots, on a close). The order with no answer stays watched,
   * and its watch reconciles what it fills later. The hedge is marked kept: #halt does not unwind it.
   */
  async #hedgeKnownFill(first: LegRun, second: LegRun, closing: boolean, reason: string, notes: string[]): Promise<void> {
    if (first.unsettled === null || first.pos === null || first.unsettledFrom === null) return;
    if (second.pos === null || second.unsettled !== null) return;
    const known = first.unsettledFrom - first.start;
    const dir = first.target > first.start ? 1n : -1n;
    if (known * dir <= 0n) return;
    const hedge = floorToLot(abs(known), closing ? second.leg.lot : this.lot);
    if (hedge === 0n) {
      notes.push(`the maker leg ${first.leg.venue} filled ${qtyString(abs(known))} before an order with no answer, under one lot of the hedge: ${second.leg.venue} does not trade`);
      return;
    }
    let to: bigint;
    if (closing) {
      const sdir = second.target > second.start ? 1n : -1n;
      if (second.target === second.start) return;
      to = abs(second.target - second.start) <= hedge ? second.target : second.start + sdir * hedge;
    } else {
      to = second.start - dir * hedge;
      second.target = to;
    }
    second.keep = true;
    notes.push(`the maker leg ${first.leg.venue} filled ${qtyString(abs(known))} before an order with no answer: ${second.leg.venue} ${closing ? 'closes' : 'hedges'} ${qtyString(abs(to - second.start))} of it now; the order with no answer stays watched`);
    await this.#move(second, to, closing, `${reason} (hedge of the known fill)`, closing ? 'close' : 'open');
  }

  /**
   * An open stopped by an unsettled leg: the other leg goes back to its start reduce-only (twice at most). Stuck when
   * that leaves the legs offsetting each other (the unsettled order can still land; its watch then closes it back),
   * unhedged when it does not (#stop). A lost position stops all, unhedged: the other leg may be the hedge of a fill
   * that cannot be read, so it is not unwound.
   */
  async #halt(runs: [LegRun, LegRun], notes: string[], size: bigint, net: bigint, reason: string): Promise<PairResult> {
    if (runs.some((r) => r.pos === null)) {
      // When the lost leg reads again unmoved, its order had not run: the other leg goes back then (#check).
      const lost = runs.filter((r) => r.pos === null);
      const other = runs.find((r) => r.pos !== null);
      const later = lost.length === 1 && lost[0]!.unsettled !== null && other !== undefined && other.unsettled === null && other.pos !== other.start;
      if (later) notes.push(`when ${lost[0]!.leg.venue} reads again unmoved, ${other.leg.venue} goes back to its start ${signedQtyString(other.start)} reduce-only`);
      const result = this.#stop(size, runs, notes, net);
      const u = later ? this.#unsettled.get(lost[0]!.leg) : undefined;
      if (u !== undefined) u.unwind = { to: other!.start, reason, failed: false };
      return result;
    }
    const others = runs.filter((r) => r.unsettled === null && r.keep !== true);
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
   * A move that stopped on an unsettled order or a lost position. Unhedged when the positions do not offset each
   * other (one leg flat, its partner still open behind an unsettled order) or one cannot be read (it counts as open):
   * the owner is alerted, and an unsettled leg stays watched (#result). Stuck when the legs offset each other.
   */
  #stop(size: bigint, runs: [LegRun, LegRun], notes: string[], net: bigint): PairResult {
    if (!hedged(runs, net)) {
      const waiting = runs.filter((r) => r.unsettled !== null)
        .map((r) => `; the ${r.leg.venue} order with no answer (${refId(r.unsettled!.ref)}) may still run and is watched until ${iso(r.unsettled!.ref.sentAt + UNSETTLED_WATCH_MS)}`);
      const lost = runs.some((r) => r.pos === null);
      const holds = runs.map((r) => (r.pos === null ? `${r.leg.venue}'s position cannot be read` : `${r.leg.venue} holds ${signedQtyString(r.pos)}`)).join(', ');
      notes.push(`unhedged: ${holds}, ${lost ? 'and a position that cannot be read counts as open' : 'which do not offset each other'}${waiting.join('')}`);
      return this.#result('unhedged', size, runs, notes, net);
    }
    return this.#result('stuck', size, runs, notes, net);
  }

  /**
   * An open waits while an order on the pair has no answer and can still run: it would reopen a leg that the order
   * could then double, or close alone. A watch whose window ended is closed out first, outside the open's scope
   * (open-scope.ts): the lapse settles an older order, and what it sends (a reconcile, an unwind) is not part of this
   * open, so a guarded leg treats it as any watch check (reduce-only only).
   */
  async #blocked(size: bigint): Promise<PairResult | null> {
    for (const leg of this.legs) {
      const u = this.#unsettled.get(leg);
      if (u !== undefined && this.#clock.now() > u.until) await outsideOpen(() => this.#lapse(leg));
    }
    const pending = this.legs.flatMap((leg) => {
      const u = this.#unsettled.get(leg);
      if (u === undefined) return [];
      if (this.#clock.now() > u.until) return [`the ${leg.venue} ${pendingText(u)} can no longer run, but ${this.#partner(leg).venue} could not be read for the unwind that waits on it`];
      return [`the ${leg.venue} ${pendingText(u)} ${u.refs.length === 1 ? 'has' : 'have'} no answer and may still run until ${iso(u.until)}`];
    });
    if (pending.length === 0) return null;
    return this.#refused(size, [
      `open refused, nothing sent: ${pending.join('; ')}; no open goes out on this pair until it runs or can no longer (its watch reads the leg every ${Math.round((this.#pollMs ?? UNSETTLED_POLL_MS) / 1000)} s); a close still can`,
    ]);
  }

  /** A request refused before anything was signed: the pair's state is left as it was (an alert stands). */
  #refused(size: bigint, notes: string[], positions?: readonly (bigint | null)[]): PairResult {
    const report = (i: 0 | 1): LegReport => {
      const leg = this.legs[i];
      const pos = positions === undefined ? this.#known.get(leg) ?? null : positions[i] ?? null;
      const text = pos === null ? 'unknown' : signedQtyString(pos);
      return { venue: leg.venue, symbol: leg.symbol, start: text, target: text, final: pos === null ? null : text, orders: [] };
    };
    const legs: [LegReport, LegReport] = [report(0), report(1)];
    const status: PairStatus = this.unhedged === null ? 'stuck' : 'unhedged';
    this.#log(`${status}: ${notes.join('; ')}`);
    return { status, size: qtyString(size), legs, notes, tx: [], feeUsd: 0, feeUnknown: 0 };
  }

  #run(leg: TradeLeg, start: bigint, target: bigint): LegRun {
    return {
      leg, start, target, pos: start, unsettled: null, unsettledFrom: null,
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
    for (let n = 0; n < MAX_MOVE_ORDERS; n++) {
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

  /**
   * #move with maker orders (TradeLeg.makerOrder): split under the cap for a reduce-only move as #move splits. A maker
   * order is several orders, so the leg's position after it is read from the venue (the fill sum if that read fails).
   */
  async #makerMove(r: LegRun, target: bigint, reduceOnly: boolean, reason: string, purpose: LegOrderRecord['purpose']): Promise<void> {
    const leg = r.leg;
    for (let n = 0; n < MAX_MOVE_ORDERS; n++) {
      if (r.pos === null || r.unsettled !== null) return;
      const from = r.pos;
      let delta = target - from;
      if (reduceOnly && crossesZero(from, target)) delta = -from;
      if (delta === 0n) return;
      const side: LegSide = delta > 0n ? 'BUY' : 'SELL';
      const want = abs(delta);
      const size = reduceOnly ? await this.#chunk(leg, side, want) : want;
      const out = await leg.makerOrder!(side, size, reduceOnly, reason);
      r.report.orders.push(...records(out, purpose));
      this.#log(`${leg.venue} ${purpose} maker ${side} ${qtyString(size)}${reduceOnly ? ' reduce-only' : ''}: ${describe(out)}`);
      this.#arm(leg, out);
      if (out.kind === 'filled') {
        const read = await this.#read(leg, undefined, 'after a maker order');
        r.pos = read ?? from + (side === 'BUY' ? out.filled : -out.filled);
      } else {
        await this.#settle(r, from, side, out);
        // A maker order is several orders, and the one that ended with no answer and no expiry may still rest and fill
        // after the parts that did: a position that moved by those parts does not show it ran. Always unsettled, from
        // where the filled parts left the leg, so the partner is never sized past what is known and the watch sees it.
        if (out.kind === 'unknown' && out.expiresAt === null) {
          const partsFilled = (out.parts ?? []).reduce((acc, p) => acc + (p.kind === 'filled' ? p.filled : 0n), 0n);
          r.unsettled = out;
          r.unsettledFrom = from + (side === 'BUY' ? partsFilled : -partsFilled);
        }
      }
      if (size === want || out.kind !== 'filled' || out.filled !== size) return;
    }
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
   * The order size for a reduce-only move: all of it, or the most one order may be under the policy cap (#chunkMax).
   * The cap is valued at today's price, and the order prices itself again when it goes out: sized at the cap, an
   * uptick would put it over and stop the split half way.
   */
  async #chunk(leg: TradeLeg, side: LegSide, want: bigint): Promise<bigint> {
    const max = await this.#chunkMax(leg, side);
    if (max === null) {
      this.#log(`${leg.venue} ${leg.symbol}: no size cap known; sending ${qtyString(want)} whole`);
      return want;
    }
    if (want > max) {
      this.#log(`${leg.venue} ${leg.symbol}: ${qtyString(want)} reduce-only is over the policy cap: splitting into orders of ${qtyString(max)} (the cap less the ${this.#bandBps} bps band)`);
      return max;
    }
    return want;
  }

  /**
   * The largest reduce-only order that fits the policy cap at any price inside the band: the cap is valued at
   * max(price, oracle) ≤ oracle × (1 + band), so cap × 10^4 / (10^4 + band), floored to the lot; one lot when that
   * is under it (nothing smaller can be sent). Null when the cap cannot be read.
   */
  async #chunkMax(leg: TradeLeg, side: LegSide): Promise<bigint | null> {
    let cap: bigint;
    try {
      cap = abs(await leg.maxSize(side, true));
    } catch (err) {
      this.#log(`${leg.venue} ${leg.symbol}: the size cap cannot be read: ${errorText(err)}`);
      return null;
    }
    const band = BigInt(Math.ceil(this.#bandBps));
    const max = floorToLot((cap * 10_000n) / (10_000n + band), leg.lot);
    return max > 0n ? max : leg.lot;
  }

  async #send(r: LegRun, side: LegSide, size: bigint, reduceOnly: boolean, reason: string, purpose: LegOrderRecord['purpose']): Promise<LegOutcome> {
    const out = await r.leg.order(side, size, reduceOnly, reason);
    r.report.orders.push(...records(out, purpose));
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
    // No known expiry (a contract before C6, or an MPC timeout with no payload): a late signature can still execute
    // it. A position that moved shows it ran (a signed action runs once); one that did not, or that cannot be read,
    // leaves it pending: nothing more is sent on this leg, and it is watched from the position it left.
    r.pos = await this.#read(leg, undefined, 'after an order whose outcome is unknown');
    if (r.pos === from || r.pos === null) {
      r.unsettled = out;
      r.unsettledFrom = from;
    }
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
   * unsettled order, only a move away from where the order left it counts: the order ran, and the leg is then
   * reconciled like any other. A leg that could not be read reads again here: unmoved, its position is known again.
   */
  async #check(leg: TradeLeg, pushed: bigint, seenAt: number): Promise<void> {
    if (this.#ended) return;
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
      // Where the order left the leg: the last position read, or the one before the order when no read since worked.
      const known = this.#known.get(leg) ?? null;
      const was = known ?? unsettled.from;
      run.start = was;
      run.pos = pos;
      run.report.start = signedQtyString(was);
      if (pos === was && known !== null) {
        // The order has not run (the push was older than the venue's state). An unwind whose other leg could not be
        // read last time is tried again.
        if (unsettled.unwind !== null) return this.#unwindPartner(run, unsettled, notes);
        return;
      }
      if (pos === was) {
        // The leg reads again, and its order has not run (yet): its position is known again, the order still watched.
        this.#known.set(leg, pos);
        notes.push(`${leg.venue} ${leg.symbol} reads again: ${signedQtyString(pos)}, so ${unsettled.ref.side} ${unsettled.ref.size} (${refId(unsettled.ref)}) has not run; it may until ${iso(unsettled.until)}`);
        if (unsettled.unwind !== null) return this.#unwindPartner(run, unsettled, notes);
        if (this.#offsets()) return this.#watched('settled', [run], notes);
        const partner = this.#partner(leg);
        notes.push(`unhedged: ${leg.venue} holds ${signedQtyString(pos)}, ${partner.venue} holds ${knownText(this.#known.get(partner))}: the legs do not offset each other`);
        this.unhedged = notes.at(-1)!;
        return this.#watched('unhedged', [run], notes);
      }
      // A signed action runs once: the leg moved, so its order ran (in full, or in part for an IOC), and nothing on
      // this leg can land any more. With several, one ran, but which is not known: they all stay watched.
      if (unsettled.refs.length === 1) {
        this.#unsettled.delete(leg);
        notes.push(`${leg.venue} ${unsettled.ref.side} ${unsettled.ref.size} (${refId(unsettled.ref)}), which had no answer, ran: ${signedQtyString(was)} -> ${signedQtyString(pos)}`);
      } else {
        this.#known.set(leg, pos);
        notes.push(`one of the ${leg.venue} orders with no answer (${unsettled.refs.map(refId).join(', ')}) ran: ${signedQtyString(was)} -> ${signedQtyString(pos)}; the others stay watched until ${iso(unsettled.until)}`);
      }
      if (pos === intent) {
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

    // A deficit (a copy of a reducing order landed), or an excess whose close did not go through: this leg no longer
    // offsets its partner in full.
    const missing = intent - run.pos;
    const off = reducedTarget(run.pos, intent) === null ? 'short of' : 'past';
    const exposed = `unhedged: ${leg.venue} holds ${signedQtyString(run.pos)}, ${qtyString(abs(missing))} ${off} its intent ${signedQtyString(intent)}`;
    notes.push(exposed);
    this.#intent.set(leg, run.pos);
    const partner = this.#partner(leg);
    if (this.#unsettled.has(partner)) {
      // Its own order may still run: another one on it could double that. Where that order should leave it now is
      // what offsets this leg as it stands, so a landing there is seen as hedged, not trimmed back.
      this.#intent.set(partner, this.#net - run.pos);
      notes.push(`${partner.venue} has an order with no answer that may still run: not matched; it offsets this leg at ${signedQtyString(this.#net - run.pos)}`);
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

  /**
   * The leg of an open that stopped on a read that failed reads again, unmoved (`run`): its order had not run. The
   * other leg goes back to its start reduce-only (twice at most), as #halt would have sent it had the first read
   * worked; the order may still run, and the leg's intent is now what offsets the other one. When the other leg
   * cannot be read, the unwind waits: it is tried again on this leg's next read, until a later open or close.
   */
  async #unwindPartner(run: LegRun, u: Unsettled, notes: string[]): Promise<void> {
    const back = u.unwind!;
    const partner = this.#partner(run.leg);
    const from = await this.#read(partner, undefined, 'the unwind its partner waited for');
    if (from === null) {
      const waits = `${partner.venue} cannot be read, so its unwind to ${signedQtyString(back.to)} waits; it is tried again on the next read of ${run.leg.venue}`;
      if (back.failed) return this.#log(`${run.leg.venue} ${run.leg.symbol}: ${waits}`);   // alerted already
      back.failed = true;
      notes.push(waits, `unhedged: ${run.leg.venue} holds ${signedQtyString(run.pos!)}, and ${partner.venue}, which an unwind waits for, cannot be read`);
      this.unhedged = notes.at(-1)!;
      return this.#watched('unhedged', [run], notes);
    }
    u.unwind = null;
    const p = this.#run(partner, from, back.to);
    p.pos = from;
    notes.push(`as the first read would have: ${partner.venue} back to its start ${signedQtyString(back.to)} reduce-only`);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (p.pos === null || p.unsettled !== null || p.pos === back.to) break;
      await this.#move(p, back.to, true, `${back.reason} (unwind${attempt === 0 ? '' : ' retry'})`, 'unwind');
    }
    this.#intent.set(partner, p.pos);
    if (p.pos !== null) this.#intent.set(run.leg, this.#net - p.pos);
    run.target = this.#intent.get(run.leg) ?? run.target;
    if (p.pos !== null && p.pos + run.pos! === this.#net) return this.#watched('rehedged', [run, p], notes);
    notes.push(`unhedged: ${run.leg.venue} holds ${signedQtyString(run.pos!)}, ${partner.venue} holds ${knownText(p.pos)}: the unwind did not bring ${partner.venue} back`);
    this.unhedged = notes.at(-1)!;
    return this.#watched('unhedged', [run, p], notes);
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
    this.baselineEpoch++;
    this.#net = net;
    // A newer open or close decides what each leg should hold: an unwind left from an older open no longer applies.
    for (const u of this.#unsettled.values()) u.unwind = null;
    for (const r of runs) {
      r.report.target = signedQtyString(r.target);
      r.report.final = r.pos === null ? null : signedQtyString(r.pos);
      // The watch holds each leg to where this result left it: the target when it was reached, the start of a flat
      // open, the last known position when stuck or unhedged (null: unknown, and the watch trades nothing).
      // An older unsettled order keeps its watch until its own window ends, whatever the leg holds now: a reduce-only
      // one that cannot move a flat leg today can once the leg is open again.
      this.#intent.set(r.leg, r.pos);
      this.#known.set(r.leg, r.pos);
    }
    for (const [i, r] of runs.entries()) {
      if (r.unsettled === null) continue;
      // The pair means this leg to offset its partner: where its order takes it, or a reconcile once it ran (also when
      // the leg could not be read: its position is unknown, its intent is not).
      const partner = runs[i === 0 ? 1 : 0];
      if (partner.pos !== null && partner.unsettled === null) this.#intent.set(r.leg, net - partner.pos);
      this.#armUnsettled(r);
    }
    for (const r of runs) this.#baseline.set(r.leg, this.#intent.get(r.leg) ?? null);
    this.unhedged = status === 'unhedged' ? notes.at(-1) ?? 'unhedged' : null;
    const tx = runs.flatMap((r) => r.report.orders.flatMap((o) => o.ref.tx));
    const fills = runs.flatMap((r) => r.report.orders.filter((o) => o.outcome === 'filled'));
    const feeUsd = fills.reduce((sum, o) => sum + (o.fee ?? 0), 0);
    const feeUnknown = fills.filter((o) => o.fee === null).length;
    this.#log(`${status}: ${runs.map((r) => `${r.leg.venue} ${r.report.final ?? 'unknown'}`).join(', ')}`);
    return { status, size: qtyString(size), legs: [runs[0].report, runs[1].report], notes, tx, feeUsd, feeUnknown };
  }

  /**
   * Watches the leg of an unsettled order until it can no longer run, and starts its poll. An older one on the leg (a
   * reduce-only close can go out next to it) stays watched with it, until the later window ends.
   */
  #armUnsettled(r: LegRun): void {
    const ref = r.unsettled!.ref;
    const old = this.#unsettled.get(r.leg);
    const refs = old === undefined ? [ref] : old.refs.includes(ref) ? old.refs : [...old.refs, ref];
    const until = Math.max(old?.until ?? 0, ref.sentAt + UNSETTLED_WATCH_MS);
    this.#unsettled.set(r.leg, { ref, refs, until, from: r.unsettledFrom ?? r.start, unwind: old?.unwind ?? null });
    this.#log(`${r.leg.venue} ${r.leg.symbol}: ${ref.side} ${ref.size} (${refId(ref)}) has no answer and may still run: watched until ${iso(until)}`);
    this.#poll(r.leg);
  }

  /** Reads a leg with an unsettled order every #pollMs while it can still run: nothing pushes Hyperliquid positions. */
  #poll(leg: TradeLeg): void {
    const every = this.#pollMs;
    if (every === null || this.#ended || this.#polling.has(leg)) return;
    this.#polling.add(leg);
    const loop = async (): Promise<void> => {
      try {
        for (;;) {
          await this.#pollSleep(every);
          if (this.#ended) return;
          const u = this.#unsettled.get(leg);
          if (u === undefined) return;          // it ran, or its window ended
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
    // The poll outlives the open that armed it: its checks and lapses run outside that open (open-scope.ts).
    outsideOpen(() => loop().catch((err) => this.#log(`${leg.venue} ${leg.symbol}: the unsettled order's watch stopped: ${errorText(err)}`)));
  }

  /**
   * The window of an unsettled order ended: it no longer can run. The last read can be a poll's, 15 s old, so the leg
   * is read once more: moved, the order ran, and the leg is reconciled (#check). Unmoved: not offset, the alert again;
   * offset, an alert raised earlier is cleared, as a settled landing clears it; an unwind that waits on the leg goes
   * out now (#unwindPartner), and while its other leg cannot be read the entry stays, to be tried again. A read that
   * fails keeps the alert: whether the order ran is unknown, and the leg counts as open.
   */
  async #lapse(leg: TradeLeg): Promise<void> {
    const u = this.#unsettled.get(leg);
    if (u === undefined || this.#clock.now() <= u.until) return;
    const known = this.#known.get(leg) ?? null;
    const was = known ?? u.from;
    let pos = await this.#read(leg, undefined, 'at the end of the window of an order with no answer');
    if (pos !== null && pos !== was) {
      await this.#check(leg, pos, this.#clock.now());
      // It ran and #check reconciled the leg; or the reconcile's own order has no answer, and is watched anew.
      const after = this.#unsettled.get(leg);
      if (after === undefined || after.until >= this.#clock.now()) return;
      pos = this.#known.get(leg) ?? null;
    }
    this.#unsettled.delete(leg);
    const what = u.refs.length === 1
      ? `${leg.venue} ${u.ref.side} ${u.ref.size} (${refId(u.ref)}) had no answer`
      : `the ${leg.venue} orders with no answer (${u.refs.map(refId).join(', ')})`;
    const run = this.#run(leg, was, this.#intent.get(leg) ?? was);
    run.pos = pos;
    if (pos === null) {
      const exposed = `unhedged: ${what}; since ${iso(u.until)} ${u.refs.length === 1 ? 'it can no longer run' : 'none of them can run'}, but ${leg.venue} cannot be read: whether it ran is unknown, and the leg counts as open`;
      this.unhedged = exposed;
      this.#watched('unhedged', [run], [exposed]);
      return;
    }
    const note = u.refs.length === 1 ? `${what} and never ran; since ${iso(u.until)} it no longer can` : `${what} can no longer run since ${iso(u.until)}`;
    this.#known.set(leg, pos);
    if (u.unwind !== null) {
      await this.#unwindPartner(run, u, [note]);
      // The other leg could not be read: the entry stays past its window, and the next poll or push tries again.
      if (u.unwind !== null) this.#unsettled.set(leg, u);
      return;
    }
    if (this.#offsets()) {
      this.#watched('lapsed', [run], [`${note}; the legs offset each other`]);
      return;
    }
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

  /** The unsettled orders on a leg while one can still run (not an entry kept past its window for an unwind). */
  #pendingOn(leg: TradeLeg): Unsettled | undefined {
    const u = this.#unsettled.get(leg);
    return u !== undefined && this.#clock.now() <= u.until ? u : undefined;
  }

  #partner(leg: TradeLeg): TradeLeg {
    return this.legs[0] === leg ? this.legs[1] : this.legs[0];
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    this.#active++;
    const run = async (): Promise<T> => {
      try {
        return await task();
      } finally {
        this.#active--;
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

function refId(ref: LegRef): string {
  return ref.clientId ?? ref.orderId ?? 'no id';
}

/** The orders with no answer on a leg, for a note: "SELL 500000 reduce-only (id)", joined with "and". */
function pendingText(u: Unsettled): string {
  return u.refs.map((ref) => `${ref.side} ${ref.size}${ref.reduceOnly ? ' reduce-only' : ''} (${refId(ref)})`).join(' and ');
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

/** `target` brought between 0 and `pos` (both ends included): a close may only shrink the leg. */
function towardZero(pos: bigint, target: bigint): bigint {
  const lo = pos < 0n ? pos : 0n;
  const hi = pos > 0n ? pos : 0n;
  return target < lo ? lo : target > hi ? hi : target;
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
    fee: out.kind === 'filled' ? out.fee ?? null : null,
    error: out.kind === 'filled' ? null : out.error.message,
  };
}

/** The records of one outcome: one, or one per part of a maker order (each its own order on the venue). */
function records(out: LegOutcome, purpose: LegOrderRecord['purpose']): LegOrderRecord[] {
  if (out.parts === undefined || out.parts.length === 0) return [record(out, purpose)];
  return out.parts.map((p) => ({ ...record(p, purpose), maker: true as const }));
}

function describe(out: LegOutcome): string {
  const id = out.ref.orderId ?? out.ref.clientId ?? 'no id';
  if (out.kind === 'filled') return `filled ${qtyString(out.filled)}${out.avgPx === null ? '' : ` at ${out.avgPx}`} (${id})`;
  return `${out.kind} (${id}): ${out.error.message}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
