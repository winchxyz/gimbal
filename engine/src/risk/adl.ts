// ADL detection: a leg whose position shrank without an order of ours (auto-deleveraging, or a partial liquidation;
// the venue's account read cannot tell them apart, and both leave the pair unhedged by the same amount).
//
// Our own fills never look like ADL because the pair trader is asked first. A leg is compared with what the trader
// means it to hold (its intent: the final position of its last open or close, kept up to date by its watch), and only
// while nothing of ours can be moving it:
//   - the trader is idle (`busy` false: no open, close or watch check queued or running);
//   - the leg is not watched (`watching` false: no Orderly replay window of a signed order) and has no unsettled
//     order at all (`unsettled` null: a Hyperliquid order with no answer, also one past its window that the trader
//     has not closed out yet, or one an unwind waits on);
//   - the intent is known (not null, not before the first open).
// The positions are read from the venue twice, CONFIRM_MS apart, and both reads must agree: one bad read (a
// Hyperliquid answer that leaves the coin out of assetPositions reads as 0) must not unwind a pair. The conditions
// above are checked again after each read: an open that started meanwhile makes the reads stale, and they are dropped.
// On Orderly the two reads are only as independent as its position(): on the fallback path that answers from the
// private stream's session snapshot, so a wrong snapshot is read twice; Hyperliquid and Phoenix read REST each time.
//
// Shrank means: same side as the intent (or flat), smaller in size. A position that grew, or flipped side, is not
// ADL (no venue deleverages past zero or adds size); it is reported for the owner and nothing is traded.
//
// The response is taken only when the intents offset each other (they add up to the pair's net, and that net is 0):
// a pair that was already unhedged is the owner's to fix, and sizing a re-hedge off it would grow a leg. It goes
// through the pair trader's close with `reduceOnly: true`, so every order is reduce-only and the close never reaches
// its re-hedge step: nothing this sends can open or grow a position. The size kept is floored to the pair's common
// lot (toward less exposure), so every target is one both venues can trade.
//   - re-hedge: what remains is at least UNWIND_BELOW of the intent: the partner is reduced by as much as the leg
//     lost, and the pair is level again at the smaller size;
//   - unwind: less remains (or nothing): both legs are closed. A small remnant earns little funding against two
//     takers' fees, and a leg that has been deleveraged once sits where the venue is short of counterparties.
//     It runs in two steps: first the pair is levelled at the remnant (the partner reduced, the remnant untouched),
//     and only once that is done are both legs closed. A partner that refuses its reduction so leaves the remnant in
//     place as the hedge it still is; a failed second step leaves at most the remnant open, which (being under
//     UNWIND_BELOW of the intent) is less than the exposure the ADL left.
//
// The outcome of a response is not taken from the close's answer (its own start read can be wrong too): the legs
// are read again, twice CONFIRM_MS apart, and only two agreeing reads at the targets count as reached.
//
// One event, one response: the same finding (same intents, same positions) is answered once. When the response did
// not reach its targets (refused, stuck, partly filled, a close that threw, a confirming read off the targets), the
// watch keeps it: the intents from before it (the reference), its targets, and where the legs were left. The pair
// trader adopts what the legs hold after a failed close as its new intents, so they would show nothing off; while
// a response is kept, findings are taken against the reference instead, and every answer is decided afresh from the
// confirmed positions with the same checks as a first one (shrank only, the reference hedged, unwind under
// UNWIND_BELOW). The legs where the last attempt left them are tried again after a backoff (RETRY_MS, doubling up
// to RETRY_MAX_MS); legs that moved since (a new ADL) are answered at once, as a new event. A kept response is
// dropped when two agreeing reads find the legs at its targets, or when the trader opens or closes on its own (its
// intents move off what the response left). After MAX_TRIES attempts at one event the watch stops trying, flags
// the pair unhedged and reports `gaveUp` (an `error` line in the journal: only the owner can act then; every
// attempt costs an MPC signature). Journaled: the first answer to each event (`retry` 0), one that reached its
// targets, and the give-up; a retry is logged as due only while the response is kept.
//
// stop() is final: a check in flight sends nothing after it (the flag is read after every wait).

import type { JournalEntry } from '@gimbal/shared';
import type { TradeLeg } from '../trade/legs.ts';
import { abs, floorToLot, qtyString, signedQtyString } from '../trade/lots.ts';
import type { PairResult } from '../trade/pair.ts';
import { reducedTarget } from '../trade/pair.ts';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';

/** A leg left with less than this share of its intent is unwound with its partner instead of re-hedged. */
export const UNWIND_BELOW = 0.5;
/** The second read that confirms a change comes this long after the first. */
export const CONFIRM_MS = 3_000;
/** A response that did not bring the pair level is tried again after this, doubling each time, up to RETRY_MAX_MS. */
export const RETRY_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;
/** Attempts at one ADL event before the watch stops and leaves it to the owner. */
export const MAX_TRIES = 8;

/** The parts of PairTrader the ADL watch reads and drives. */
export interface AdlTrader {
  readonly legs: [TradeLeg, TradeLeg];
  /** The pair's common lot: every size it trades is a whole number of these. */
  readonly lot: bigint;
  readonly busy: boolean;
  readonly net: bigint;
  /** The pair trader's unhedged alert: the watch sets it when a response leaves the pair off its targets. */
  unhedged: string | null;
  watching(leg: TradeLeg): boolean;
  unsettled(leg: TradeLeg): unknown;
  intent(leg: TradeLeg): bigint | null | undefined;
  close(request: { reason: string; targets?: [bigint, bigint]; reduceOnly?: boolean }): Promise<PairResult>;
}

export type LegChange = 'same' | 'shrank' | 'grew' | 'flipped';

/** How a position compares with the intent. */
export function legChange(intent: bigint, pos: bigint): LegChange {
  if (pos === intent) return 'same';
  if (intent === 0n) return 'grew';
  if (pos !== 0n && (pos > 0n) !== (intent > 0n)) return 'flipped';
  return abs(pos) < abs(intent) ? 'shrank' : 'grew';
}

export interface AdlFinding {
  index: 0 | 1;
  leg: TradeLeg;
  intent: bigint;
  pos: bigint;
  change: Exclude<LegChange, 'same'>;
}

export interface AdlReport {
  findings: AdlFinding[];
  action: 'rehedge' | 'unwind' | 'none';
  targets: [bigint, bigint] | null;
  result: PairResult | null;
  summary: string;
  /** 0 on the first answer to this finding; n on the n-th retry after a backoff (not journaled). */
  retry: number;
  /** Two agreeing reads after the response found the legs at its targets (false for none, a refusal, a throw...). */
  reached: boolean;
  /** MAX_TRIES attempts failed: no more; only the owner can act. */
  gaveUp: boolean;
}

export class AdlWatch {
  readonly #trader: AdlTrader;
  readonly #log: (line: string) => void;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #confirmMs: number;
  /** The last finding answered for good (action none, or done): never answered again. */
  #settled: string | null = null;
  /** A response that has not reached its targets yet (see the header). */
  #pending: Pending | null = null;
  #stopped = false;

  constructor(trader: AdlTrader, options: { log?: (line: string) => void; clock?: Clock; sleep?: (ms: number) => Promise<void>; confirmMs?: number } = {}) {
    this.#trader = trader;
    this.#log = options.log ?? (() => {});
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#confirmMs = options.confirmMs ?? CONFIRM_MS;
  }

  /** Final: a check in flight sends nothing after this, and no check runs again. */
  stop(): void {
    this.#stopped = true;
  }

  /** One look at both legs; null when nothing is off, nothing can be told now, or a response waits its backoff. */
  async check(): Promise<AdlReport | null> {
    if (this.#stopped) return null;
    const first = await this.#read();
    if (first === null || this.#stopped) return null;
    let p = this.#pending;
    if (p !== null && first.intents.some((q, i) => q !== p!.adopted[i])) {
      this.#pending = p = null;
      this.#log('adl: the pair trader traded since the response: it is dropped');
    }
    const ref = p?.intents ?? first.intents;
    if (p === null) {
      if (findingsOf(this.#trader.legs, ref, first.positions).length === 0 || first.key === this.#settled) return null;
    } else if (!same(first.positions, p.targets) && same(first.positions, p.left) && this.#clock.now() < p.nextAt) {
      return null;
    }
    await this.#sleep(this.#confirmMs);
    if (this.#stopped) return null;
    const second = await this.#read();
    if (this.#stopped) return null;
    if (second === null || second.key !== first.key) {
      this.#log(`adl: ${describe(findingsOf(this.#trader.legs, ref, first.positions))} not confirmed by a read ${this.#confirmMs / 1000} s later: nothing done`);
      return null;
    }
    const findings = findingsOf(this.#trader.legs, ref, second.positions);
    if (p !== null && (same(second.positions, p.targets) || findings.length === 0)) {
      this.#pending = null;
      this.#log('adl: two reads find the legs at the response\'s targets: done');
      return null;
    }
    const retry = p === null || !same(second.positions, p.left) ? 0 : p.tries;
    const report = await this.#answer(findings, second.positions, ref, retry);
    if (report.action === 'none') {
      if (p !== null) {
        this.#pending = null;
        this.#trader.unhedged = `adl: ${report.summary}`;
      }
      this.#settled = second.key;
      return report;
    }
    if (this.#stopped) return report;
    return this.#after(report, ref, second.positions, retry + 1);
  }

  /**
   * After a response: the legs read twice; reached only when both reads agree and are at the targets. Otherwise the
   * response is kept for a retry, or, after MAX_TRIES, given up.
   */
  async #after(report: AdlReport, ref: [bigint, bigint], before: [bigint, bigint], tries: number): Promise<AdlReport> {
    const t = this.#trader;
    const targets = report.targets!;
    const left = await this.#outcome();
    const reached = report.reached && left !== null && same(left, targets);
    if (report.reached && !reached) {
      report.summary += `; but ${left === null ? 'the legs could not be read twice alike' : `the legs read ${left.map(signedQtyString).join(' and ')}`} ${this.#confirmMs / 1000} s later, not ${targets.map(signedQtyString).join(' and ')}`;
    }
    report.reached = reached;
    if (reached) {
      this.#pending = null;
      return report;
    }
    t.unhedged = `adl: ${report.summary}`;
    const at = left ?? before;
    const adopted = t.legs.map((leg) => t.intent(leg) ?? null) as [bigint | null, bigint | null];
    if (tries >= MAX_TRIES) {
      this.#pending = null;
      this.#settled = `${adopted.join(',')} ${at.join(',')}`;
      report.gaveUp = true;
      report.summary += `; ${tries} tries did not bring the pair level: no more tries, only the owner can act now`;
      this.#log(`adl: ${report.summary}`);
      return report;
    }
    const nextAt = this.#clock.now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (tries - 1));
    this.#pending = { intents: ref, targets, adopted, left: at, tries, nextAt };
    this.#log(`adl: ${report.summary}; tried ${tries}x, next try after ${iso(nextAt)}`);
    return report;
  }

  /** Both legs read now and CONFIRM_MS later; the positions when the two reads agree, else null. */
  async #outcome(): Promise<[bigint, bigint] | null> {
    try {
      const a = await Promise.all(this.#trader.legs.map((leg) => leg.position()));
      await this.#sleep(this.#confirmMs);
      const b = await Promise.all(this.#trader.legs.map((leg) => leg.position()));
      return same(a, b) ? [a[0]!, a[1]!] : null;
    } catch (err) {
      this.#log(`adl: the legs could not be read after the response: ${errorText(err)}`);
      return null;
    }
  }

  /** Both legs read while nothing of ours moves them; null when that cannot be told now. */
  async #read(): Promise<Read | null> {
    const positions: bigint[] = [];
    const intents: bigint[] = [];
    for (const index of [0, 1] as const) {
      const leg = this.#trader.legs[index];
      const intent = this.#quiet(leg);
      if (intent === null) return null;
      let pos: bigint;
      try {
        pos = await leg.position();
      } catch (err) {
        this.#log(`adl: ${leg.venue} ${leg.symbol}: position unread (${err instanceof Error ? err.message : String(err)}): not checked`);
        return null;
      }
      // Our own order may have started while the read was out: its answer is stale then.
      if (this.#quiet(leg) !== intent) return null;
      positions.push(pos);
      intents.push(intent);
    }
    const key = `${intents.join(',')} ${positions.join(',')}`;
    return { positions: positions as [bigint, bigint], intents: intents as [bigint, bigint], key };
  }

  /** The leg's intent when nothing of ours can be moving it; null otherwise. */
  #quiet(leg: TradeLeg): bigint | null {
    const t = this.#trader;
    if (t.busy || t.watching(leg) || t.unsettled(leg) !== null) return null;
    const intent = t.intent(leg);
    return intent === undefined ? null : intent;
  }

  /** The answer to findings against the reference intents `ref`, decided from the confirmed positions `pos`. */
  async #answer(findings: AdlFinding[], pos: [bigint, bigint], ref: [bigint, bigint], retry: number): Promise<AdlReport> {
    const what = describe(findings);
    const none = (summary: string): AdlReport => {
      this.#log(`adl: ${summary}`);
      return { findings, action: 'none', targets: null, result: null, summary, retry, reached: false, gaveUp: false };
    };
    if (findings.some((f) => f.change !== 'shrank')) {
      return none(`position off the intent, not ADL, nothing traded: ${findings.map((f) => `${f.leg.venue} ${f.leg.symbol} ${f.change} ${signedQtyString(f.intent)} -> ${signedQtyString(f.pos)}`).join('; ')}`);
    }
    if (this.#trader.net !== 0n || ref[0] + ref[1] !== 0n) {
      return none(`${what} shrank without an order of ours, but the pair was not hedged before (intents ${ref.map(signedQtyString).join(' and ')}): nothing traded, the owner must act`);
    }
    // The size both legs can still offset: what the shrunk leg (or the smaller of two) kept, in whole common lots.
    const t = this.#trader;
    const kept = level(pos, t.lot);
    const share = Number(kept) / Number(abs(ref[0]));
    const unwind = kept === 0n || share < UNWIND_BELOW;
    // Each leg keeps its reference's side: the legs offset (checked above), so the levelled targets do too.
    const levelled: [bigint, bigint] = [sign(ref[0]) * kept, sign(ref[1]) * kept];
    for (const i of [0, 1] as const) {
      if (pos[i] !== levelled[i] && reducedTarget(pos[i], levelled[i]) !== levelled[i]) {
        return none(`${what}: ${t.legs[i].venue} at ${signedQtyString(pos[i])} cannot reach ${signedQtyString(levelled[i])} reduce-only: nothing traded`);
      }
    }
    return this.#respond(findings, pos, levelled, unwind, share, retry);
  }

  /** Level both legs at `levelled` (reduce-only), then, for an unwind, close both. */
  async #respond(findings: AdlFinding[], pos: [bigint, bigint], levelled: [bigint, bigint], unwind: boolean, share: number, retry: number): Promise<AdlReport> {
    const what = describe(findings);
    const t = this.#trader;
    const [a, b] = t.legs;
    const kept = abs(levelled[0]);
    const targets: [bigint, bigint] = unwind ? [0n, 0n] : levelled;
    const action = unwind ? 'unwind' : 'rehedge';
    const moves = [a, b].map((l, i) => (pos[i] === levelled[i] ? null : `${l.venue} ${signedQtyString(pos[i])} -> ${signedQtyString(levelled[i])}`)).filter((x) => x !== null).join(', ');
    const plan = unwind
      ? `unwinding both legs (${Math.round(share * 100)} % kept, under ${UNWIND_BELOW * 100} %): levelling at ${qtyString(kept)} first${kept === 0n ? '' : ', then closing both'}`
      : `re-hedging at ${qtyString(kept)}: ${moves}`;
    const head = `ADL on ${what} (shrank without an order of ours)${retry > 0 ? ` (retry ${retry})` : ''}; ${plan}`;
    this.#log(`adl: ${what} without an order of ours; ${plan}`);
    let result: PairResult | null = null;
    const failed = (why: string): AdlReport => ({ findings, action, targets, result, summary: `${head} failed: ${why}`, retry, reached: false, gaveUp: false });
    try {
      if (pos.some((q, i) => q !== levelled[i])) {
        result = await t.close({ reason: `adl: ${what}${unwind ? ' (level first)' : ''}`, targets: levelled, reduceOnly: true });
      }
      if (unwind && kept > 0n && (result === null || result.status === 'closed')) {
        if (this.#stopped) return failed('the watch stopped before the second step');
        const first = result;
        result = await t.close({ reason: `adl: ${what} (unwind)`, targets: [0n, 0n], reduceOnly: true });
        if (first !== null) result = { ...result, tx: [...first.tx, ...result.tx], notes: [...first.notes, ...result.notes] };
      }
    } catch (err) {
      return failed(errorText(err));
    }
    const reached = result === null || result.status === 'closed';
    const done = reached ? (unwind ? 'both legs closed' : 'level again') : `pair ${result!.status}: ${result!.notes.at(-1) ?? ''}`;
    return { findings, action, targets, result: result ?? closedNothing(), summary: `${head}: ${done}`, retry, reached, gaveUp: false };
  }
}

interface Read {
  positions: [bigint, bigint];
  intents: [bigint, bigint];
  key: string;
}

interface Pending {
  intents: [bigint, bigint];        // the reference: the trader's intents before the first response
  targets: [bigint, bigint];        // where the last attempt meant to take the legs
  adopted: [bigint | null, bigint | null];   // the trader's intents right after it
  left: [bigint, bigint];           // where it left them (confirmed when it could be)
  tries: number;                    // attempts at this event
  nextAt: number;
}

/** The legs off the reference intents. */
function findingsOf(legs: readonly [TradeLeg, TradeLeg], ref: [bigint, bigint], pos: [bigint, bigint]): AdlFinding[] {
  const out: AdlFinding[] = [];
  for (const index of [0, 1] as const) {
    const change = legChange(ref[index], pos[index]);
    if (change !== 'same') out.push({ index, leg: legs[index], intent: ref[index], pos: pos[index], change });
  }
  return out;
}

function same(a: readonly bigint[], b: readonly bigint[]): boolean {
  return a.length === b.length && a.every((q, i) => q === b[i]);
}

/** The size both legs can offset: the smaller of the two, floored to whole lots. */
function level(pos: [bigint, bigint], lot: bigint): bigint {
  const small = abs(pos[0]) < abs(pos[1]) ? abs(pos[0]) : abs(pos[1]);
  return floorToLot(small, lot);
}

function sign(q: bigint): bigint {
  return q < 0n ? -1n : 1n;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A response with nothing to send (the legs were already at its targets). */
function closedNothing(): PairResult {
  return { status: 'closed', size: '0', legs: [] as unknown as PairResult['legs'], notes: ['both legs were already at their targets'], tx: [], feeUsd: 0, feeUnknown: 0 };
}

function describe(findings: AdlFinding[]): string {
  return findings.map((f) => `${f.leg.venue} ${f.leg.symbol} ${signedQtyString(f.intent)} -> ${signedQtyString(f.pos)}`).join(', ');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The journal entry for an ADL report (kind `adl`), without its id. */
export function adlJournal(report: AdlReport, t: number): Omit<JournalEntry, 'id'> {
  const f = report.findings[0]!;
  return {
    t,
    kind: 'adl',
    summary: report.summary,
    numbers: {
      venue: f.leg.venue,
      before: signedQtyString(f.intent),
      after: signedQtyString(f.pos),
      lost: qtyString(abs(f.intent - f.pos)),
      action: report.action,
      ...(report.retry > 0 ? { retry: report.retry } : {}),
    },
    tx: report.result?.tx ?? [],
  };
}
