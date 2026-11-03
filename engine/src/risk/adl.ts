// ADL: a leg whose position shrank without an order of ours (auto-deleveraging, or a partial liquidation; the venue's
// account read cannot tell them apart, and both leave the pair unhedged by the same amount).
//
// The rule (day 10, the human's decision, in place of a re-hedge that had four bugs in review): on a confirmed ADL the
// pair is paused and both legs are unwound reduce-only. Never a partial re-hedge.
//
// Detection. A leg is compared with its baseline: what the pair trader's last open, close or adoption left it meaning
// to hold (PairTrader.baseline). A watch check of the trader (a replayed copy reconciled, an order with no answer that
// ran) never moves the baseline, so nothing but the trader's own results can make a shrunk leg look expected. It is
// compared only while nothing of ours can be moving it: the trader idle (`busy` false), the leg not watched (no
// replay window) and with no unsettled order, and the baseline known. The positions are read twice, CONFIRM_MS apart,
// and both reads must agree: one bad read (a Hyperliquid answer that leaves the coin out reads as 0) must not unwind a
// pair. Shrank means: the same side as the baseline (or flat), smaller in size. A leg that grew or flipped is not ADL
// (no venue deleverages past zero or adds size), and neither is a shrink on a pair whose baselines did not offset each
// other (it was unhedged before): both are journaled once for the owner, and nothing is traded.
//
// The response. A confirmed ADL becomes the pair's event: the baselines and the two reads, kept until both legs read
// flat twice alike. From then on the pair is paused (`paused`: the trader opens nothing) and each attempt is one
// reduce-only close of both legs to zero through the pair trader. Attempts come from one budget per pair,
// ADL_ATTEMPTS in all, not per event: each one is taken off the budget and saved (onChange) before any order goes
// out, so neither a new reading of the legs nor a restart can refill it. Attempts are RETRY_MS apart, doubling. When
// the budget is spent the owner alert is raised (`gaveUp`, an `error` line in the journal) and nothing more is sent.
//
// The event ends only on two agreeing reads of both legs at zero: after an attempt, or later (a late fill, the owner
// closing by hand). Neither the trader adopting the positions a failed close left nor anything else drops it. When it
// ends, the trader adopts the flat legs, which clears the unhedged alert this watch raised; while it lasts the alert
// says why the pair is exposed. Every end is journaled: the event confirmed and its first attempt, every attempt's
// result, the budget spent, the end.
//
// Without trading (serve's trader not live), a confirmed ADL is journaled with the owner alert and the event is kept
// so it is not reported again; it ends the same way, when both legs read flat. While `hold` says why a shrink may be
// an order of ours whose result was never saved (serve restarted with orders in flight), a shrink starts no event at
// all: it is journaled once for the owner, and nothing is traded until a close result or adopt sets the baselines
// (or serve settles those orders from the venues once they can no longer run: trade/protected-pair.ts).
//
// A clamped close (serve's: a rescue's reduce whose targets, computed before another close ran ahead of it, are
// brought between 0 and the legs as read when it runs) can leave the legs not offsetting each other: its result sets
// the baselines there and the trader's net to their sum, so the pair counts as not hedged before, and a shrink is
// alerted to the owner, not unwound, until a close result offsets the legs again (serve's `open:` lines say so).
// That is kept on purpose: the legs really do not offset then, and an unwind on such a pair is the owner's call.
//
// The pause stops opens only (the pair trader's open). It does not stop a rescue (its transfers, or its reduce, which
// is reduce-only like the unwind and queues behind it in the trader) or panic_close.
//
// stop() is final: a check in flight sends nothing after it (the flag is read after every wait).

import type { JournalEntry, TxRef } from '@gimbal/shared';
import type { TradeLeg } from '../trade/legs.ts';
import { abs, qtyString, signedQtyString } from '../trade/lots.ts';
import type { PairResult } from '../trade/pair.ts';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';

/** The second read that confirms a change comes this long after the first. */
export const CONFIRM_MS = 3_000;
/** Unwind attempts per pair, over every ADL event it has: each one is at least one signed order per leg. */
export const ADL_ATTEMPTS = 3;
/** An unwind that did not close both legs is tried again after this, doubling each time, up to RETRY_MAX_MS. */
export const RETRY_MS = 60_000;
export const RETRY_MAX_MS = 10 * 60_000;

/** The parts of the pair trader the ADL watch reads and drives. */
export interface AdlTrader {
  readonly legs: readonly [TradeLeg, TradeLeg];
  readonly busy: boolean;
  readonly net: bigint;
  /** The pair trader's unhedged alert: set while an event is not unwound. */
  unhedged: string | null;
  watching(leg: TradeLeg): boolean;
  unsettled(leg: TradeLeg): unknown;
  /** What the last open, close or adoption left the leg meaning to hold (PairTrader.baseline). */
  baseline(leg: TradeLeg): bigint | null | undefined;
  /** The legs as they are now become the pair (PairTrader.adopt): used when an event ends with both legs flat. */
  adopt(positions: readonly [bigint, bigint]): void;
  close(request: { reason: string; targets?: [bigint, bigint]; reduceOnly?: boolean }): Promise<PairResult>;
}

/** A confirmed ADL that has not ended (both legs not yet read flat twice alike). */
export interface AdlEvent {
  at: number;
  /** The baselines the legs shrank from. */
  reference: [bigint, bigint];
  /** The two agreeing reads that confirmed it. */
  seen: [bigint, bigint];
  /** Unwind attempts made on this event. */
  attempts: number;
  /** No attempt before this (local ms); null: the next one may go now. */
  nextAt: number | null;
  /** The owner alert was raised (alert only, or the budget spent): it is not journaled again. */
  alerted: boolean;
}

/** What the watch keeps across restarts (trade/trader-state.ts saves it with the trader). */
export interface AdlState {
  /** Unwind attempts left for this pair (ADL_ATTEMPTS for a new pair). */
  attemptsLeft: number;
  /** Why the pair is paused since an ADL (null: not paused); it stays after the unwind, until a new pair. */
  paused: string | null;
  event: AdlEvent | null;
}

export function newAdlState(): AdlState {
  return { attemptsLeft: ADL_ATTEMPTS, paused: null, event: null };
}

export type LegChange = 'same' | 'shrank' | 'grew' | 'flipped';

/** How a position compares with the baseline. */
export function legChange(baseline: bigint, pos: bigint): LegChange {
  if (pos === baseline) return 'same';
  if (baseline === 0n) return 'grew';
  if (pos !== 0n && (pos > 0n) !== (baseline > 0n)) return 'flipped';
  return abs(pos) < abs(baseline) ? 'shrank' : 'grew';
}

export interface AdlFinding {
  index: 0 | 1;
  leg: TradeLeg;
  baseline: bigint;
  pos: bigint;
  change: Exclude<LegChange, 'same'>;
}

export interface AdlReport {
  /**
   *   unwound   an attempt closed both legs (two agreeing reads at zero): the event ended
   *   flat      both legs read flat with no attempt of this watch (closed elsewhere, a late fill): the event ended
   *   failed    an attempt did not close both legs; the next one waits its backoff
   *   gave-up   the budget is spent: no more orders, only the owner can act
   *   alert     a confirmed ADL while the trader does not trade: the owner must unwind
   *   not-adl   a leg off its baseline that is not ADL (grew, flipped, or the pair was unhedged before): nothing traded
   */
  stage: 'unwound' | 'flat' | 'failed' | 'gave-up' | 'alert' | 'not-adl';
  summary: string;
  findings: AdlFinding[];
  result: PairResult | null;
  tx: TxRef[];
  /** The attempt this report is about (1..ADL_ATTEMPTS), 0 when none was made. */
  attempt: number;
  attemptsLeft: number;
  /** Only the owner can act now: journaled as an `error` too. */
  ownerAlert: boolean;
}

export interface AdlWatchOptions {
  /** The saved state (attempts left, pause, an event in progress); default a new pair's. */
  state?: AdlState;
  /** Called after every change to the state, before any order of an attempt: it must save it or throw. */
  onChange?: (state: AdlState) => void;
  /** false: confirmed ADL is only alerted (serve's trader not live). */
  trade?: boolean;
  /**
   * Why a shrink cannot be told from an order of ours now (serve: orders were in flight when the engine stopped, and
   * no close result or adopt has set the baselines since), or null. While it says why, a confirmed shrink starts no
   * event: it is alerted to the owner once and nothing is traded. An event already in progress goes on.
   */
  hold?: () => string | null;
  log?: (line: string) => void;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  confirmMs?: number;
}

export class AdlWatch {
  readonly #trader: AdlTrader;
  readonly #log: (line: string) => void;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #confirmMs: number;
  readonly #trade: boolean;
  readonly #onChange: (state: AdlState) => void;
  readonly #hold: () => string | null;
  readonly state: AdlState;
  /** The last finding reported as not ADL: not reported again while the legs read the same. */
  #reported: string | null = null;
  /** The unhedged alert this watch set on the trader (cleared when the event ends). */
  #alert: string | null = null;
  #stopped = false;

  constructor(trader: AdlTrader, options: AdlWatchOptions = {}) {
    this.#trader = trader;
    this.#log = options.log ?? (() => {});
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#confirmMs = options.confirmMs ?? CONFIRM_MS;
    this.#trade = options.trade ?? true;
    this.#onChange = options.onChange ?? (() => {});
    this.#hold = options.hold ?? (() => null);
    this.state = options.state ?? newAdlState();
  }

  /** Final: a check in flight sends nothing after this, and no check runs again. */
  stop(): void {
    this.#stopped = true;
  }

  /** Why the pair is paused (no open), or null. */
  get paused(): string | null {
    return this.state.paused;
  }

  /** One look at both legs; a report for every end (journal it), null when there is nothing new. */
  async check(): Promise<AdlReport | null> {
    if (this.#stopped) return null;
    if (this.state.event !== null) return this.#follow();
    const first = await this.#read();
    if (first === null || this.#stopped) return null;
    const seen = findingsOf(this.#trader.legs, first.baselines, first.positions);
    if (seen.length === 0) {
      this.#reported = null;
      return null;
    }
    if (first.key === this.#reported) return null;
    await this.#sleep(this.#confirmMs);
    if (this.#stopped) return null;
    const second = await this.#read();
    if (this.#stopped) return null;
    if (second === null || second.key !== first.key) {
      this.#log(`adl: ${describe(seen)} not confirmed by a read ${this.#confirmMs / 1000} s later: nothing done`);
      return null;
    }
    const ref = second.baselines;
    const pos = second.positions;
    if (seen.some((f) => f.change !== 'shrank')) {
      this.#reported = second.key;
      return this.#report('not-adl', `position off the baseline, not ADL, nothing traded: ${seen.map((f) => `${f.leg.venue} ${f.leg.symbol} ${f.change} ${signedQtyString(f.baseline)} -> ${signedQtyString(f.pos)}`).join('; ')}; the owner must look`, seen, { ownerAlert: true });
    }
    if (this.#trader.net !== 0n || ref[0] + ref[1] !== 0n) {
      this.#reported = second.key;
      return this.#report('not-adl', `${describe(seen)} shrank without an order of ours, but the pair was not hedged before (baselines ${ref.map(signedQtyString).join(' and ')}): nothing traded, the owner must act`, seen, { ownerAlert: true });
    }
    const hold = this.#hold();
    if (hold !== null) {
      this.#reported = second.key;
      return this.#report('alert', `${describe(seen)} shrank against the baselines, not taken as ADL (${hold}): no event, nothing traded; the owner must check both legs`, seen, { ownerAlert: true });
    }
    const event: AdlEvent = { at: this.#clock.now(), reference: ref, seen: pos, attempts: 0, nextAt: null, alerted: false };
    this.state.event = event;
    this.state.paused = `ADL on ${describe(seen)} at ${iso(event.at)}`;
    this.#changed();
    const head = `ADL on ${describe(seen)} (shrank without an order of ours, two reads ${this.#confirmMs / 1000} s apart): the pair is paused`;
    this.#log(`adl: ${head}`);
    if (pos[0] === 0n && pos[1] === 0n) return this.#end('flat', `${head}; both legs read flat: nothing to unwind`, seen, null, 0);
    if (!this.#trade) {
      event.alerted = true;
      this.#raise(`adl: ${head}; this engine does not trade: unwind both legs by hand`);
      this.#changed();
      return this.#report('alert', `${head}; this engine does not trade (alert only): unwind both legs by hand`, seen, { ownerAlert: true });
    }
    if (this.state.attemptsLeft <= 0) {
      event.alerted = true;
      this.#raise(`adl: ${head}; the pair's unwind attempts are spent`);
      this.#changed();
      return this.#report('gave-up', `${head}; the pair's ${ADL_ATTEMPTS} unwind attempts were spent on an earlier event: no order goes out, only the owner can act now`, seen, { ownerAlert: true });
    }
    return this.#attempt(seen, `${head}; unwinding both legs reduce-only`);
  }

  /** An event in progress: ended when both legs read flat; else the next attempt when the budget and backoff allow. */
  async #follow(): Promise<AdlReport | null> {
    const ev = this.state.event!;
    if (this.#trader.busy) return null;
    const pos = await this.#outcome();
    if (pos === null || this.#stopped) return null;
    const findings = findingsOf(this.#trader.legs, ev.reference, pos);
    const head = `ADL of ${iso(ev.at)}`;
    if (pos[0] === 0n && pos[1] === 0n) return this.#end('flat', `${head}: both legs read flat (closed outside this watch, or a late fill): the event ends`, findings, null, 0);
    if (!this.#trade) return null;
    if (this.state.attemptsLeft <= 0) {
      if (ev.alerted) return null;
      ev.alerted = true;
      this.#raise(`adl: ${head}: the pair's unwind attempts are spent`);
      this.#changed();
      return this.#report('gave-up', `${head}: the pair's ${ADL_ATTEMPTS} unwind attempts are spent and ${legsText(this.#trader.legs, pos)} are still open: no more orders, only the owner can act now`, findings, { ownerAlert: true });
    }
    if (ev.nextAt !== null && this.#clock.now() < ev.nextAt) return null;
    return this.#attempt(findings, `${head}: ${legsText(this.#trader.legs, pos)} still open; unwinding both legs reduce-only`);
  }

  /** One unwind attempt, taken off the budget and saved before any order goes out. */
  async #attempt(findings: AdlFinding[], head: string): Promise<AdlReport | null> {
    const ev = this.state.event!;
    this.state.attemptsLeft--;
    ev.attempts++;
    const n = ADL_ATTEMPTS - this.state.attemptsLeft;
    ev.nextAt = this.#clock.now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (ev.attempts - 1));
    // A save that throws stops the attempt here: no order goes out that the budget on disk does not count.
    this.#changed();
    if (this.#stopped) return null;
    let result: PairResult | null = null;
    let error: string | null = null;
    try {
      result = await this.#trader.close({ reason: `adl: unwind both legs (attempt ${n} of ${ADL_ATTEMPTS})`, targets: [0n, 0n], reduceOnly: true });
    } catch (err) {
      error = errorText(err);
    }
    const left = await this.#outcome();
    const tx = result?.tx ?? [];
    if (left !== null && left[0] === 0n && left[1] === 0n) {
      return this.#end('unwound', `${head}: attempt ${n} of ${ADL_ATTEMPTS} closed both legs`, findings, result, n);
    }
    const why = [
      error === null ? `the close ended ${result!.status}${result!.notes.length === 0 ? '' : ` (${result!.notes.at(-1)})`}` : `the close failed: ${error}`,
      left === null ? 'the legs could not be read twice alike after it' : `${legsText(this.#trader.legs, left)} after it`,
    ].join('; ');
    this.#raise(`adl: ${head}: attempt ${n} of ${ADL_ATTEMPTS} did not close both legs: ${why}`);
    if (this.state.attemptsLeft <= 0) {
      ev.alerted = true;
      this.#changed();
      return this.#report('gave-up', `${head}: attempt ${n} of ${ADL_ATTEMPTS} did not close both legs (${why}); the pair's unwind attempts are spent: no more orders, only the owner can act now`, findings, { result, tx, attempt: n, ownerAlert: true });
    }
    this.#changed();
    return this.#report('failed', `${head}: attempt ${n} of ${ADL_ATTEMPTS} did not close both legs (${why}); ${this.state.attemptsLeft} left, the next after ${iso(ev.nextAt!)}`, findings, { result, tx, attempt: n });
  }

  /** The event ends: the flat legs become the pair, the alert this watch raised is gone; the pause stays. */
  #end(stage: 'unwound' | 'flat', summary: string, findings: AdlFinding[], result: PairResult | null, attempt: number): AdlReport {
    this.state.event = null;
    this.#trader.adopt([0n, 0n]);
    if (this.#alert !== null && this.#trader.unhedged === this.#alert) this.#trader.unhedged = null;
    this.#alert = null;
    this.#changed();
    return this.#report(stage, summary, findings, { result, tx: result?.tx ?? [], attempt });
  }

  #raise(alert: string): void {
    this.#alert = alert;
    this.#trader.unhedged = alert;
  }

  #changed(): void {
    this.#onChange(this.state);
  }

  #report(stage: AdlReport['stage'], summary: string, findings: AdlFinding[], extra: { result?: PairResult | null; tx?: TxRef[]; attempt?: number; ownerAlert?: boolean } = {}): AdlReport {
    this.#log(`adl: ${summary}`);
    return {
      stage, summary, findings, result: extra.result ?? null, tx: extra.tx ?? [], attempt: extra.attempt ?? 0,
      attemptsLeft: this.state.attemptsLeft, ownerAlert: extra.ownerAlert ?? false,
    };
  }

  /** Both legs read now and CONFIRM_MS later; the positions when the two reads agree, else null. */
  async #outcome(): Promise<[bigint, bigint] | null> {
    try {
      const a = await Promise.all(this.#trader.legs.map((leg) => leg.position()));
      await this.#sleep(this.#confirmMs);
      if (this.#stopped) return null;
      const b = await Promise.all(this.#trader.legs.map((leg) => leg.position()));
      return a[0] === b[0] && a[1] === b[1] ? [a[0]!, a[1]!] : null;
    } catch (err) {
      this.#log(`adl: the legs could not be read: ${errorText(err)}`);
      return null;
    }
  }

  /** Both legs read while nothing of ours moves them; null when that cannot be told now. */
  async #read(): Promise<Read | null> {
    const positions: bigint[] = [];
    const baselines: bigint[] = [];
    for (const index of [0, 1] as const) {
      const leg = this.#trader.legs[index];
      const base = this.#quiet(leg);
      if (base === null) return null;
      let pos: bigint;
      try {
        pos = await leg.position();
      } catch (err) {
        this.#log(`adl: ${leg.venue} ${leg.symbol}: position unread (${errorText(err)}): not checked`);
        return null;
      }
      // Our own order may have started while the read was out: its answer is stale then.
      if (this.#quiet(leg) !== base) return null;
      positions.push(pos);
      baselines.push(base);
    }
    const key = `${baselines.join(',')} ${positions.join(',')}`;
    return { positions: positions as [bigint, bigint], baselines: baselines as [bigint, bigint], key };
  }

  /** The leg's baseline when nothing of ours can be moving it; null otherwise. */
  #quiet(leg: TradeLeg): bigint | null {
    const t = this.#trader;
    if (t.busy || t.watching(leg) || t.unsettled(leg) !== null) return null;
    const base = t.baseline(leg);
    return base === undefined ? null : base;
  }
}

interface Read {
  positions: [bigint, bigint];
  baselines: [bigint, bigint];
  key: string;
}

/** The legs off the baselines `ref`. */
function findingsOf(legs: readonly [TradeLeg, TradeLeg], ref: readonly [bigint, bigint], pos: readonly [bigint, bigint]): AdlFinding[] {
  const out: AdlFinding[] = [];
  for (const index of [0, 1] as const) {
    const change = legChange(ref[index], pos[index]);
    if (change !== 'same') out.push({ index, leg: legs[index], baseline: ref[index], pos: pos[index], change });
  }
  return out;
}

function legsText(legs: readonly [TradeLeg, TradeLeg], pos: readonly [bigint, bigint]): string {
  return legs.map((l, i) => `${l.venue} ${l.symbol} ${signedQtyString(pos[i]!)}`).join(' and ');
}

function describe(findings: AdlFinding[]): string {
  return findings.map((f) => `${f.leg.venue} ${f.leg.symbol} ${signedQtyString(f.baseline)} -> ${signedQtyString(f.pos)}`).join(', ');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The journal entries of an ADL report (kind `adl`, and an `error` when only the owner can act), without ids. */
export function adlJournal(report: AdlReport, t: number): Omit<JournalEntry, 'id'>[] {
  const f = report.findings[0];
  const numbers: Record<string, number | string> = {
    stage: report.stage, attemptsLeft: report.attemptsLeft,
    ...(report.attempt > 0 ? { attempt: report.attempt } : {}),
    ...(f === undefined ? {} : { venue: f.leg.venue, before: signedQtyString(f.baseline), after: signedQtyString(f.pos), lost: qtyString(abs(f.baseline - f.pos)) }),
  };
  const out: Omit<JournalEntry, 'id'>[] = [{ t, kind: 'adl', summary: report.summary, numbers, tx: [...report.tx] }];
  if (report.ownerAlert) {
    out.push({ t, kind: 'error', summary: `owner: ${report.summary}`, numbers: { ...(f === undefined ? {} : { venue: f.leg.venue }), stage: report.stage }, tx: [] });
  }
  return out;
}
