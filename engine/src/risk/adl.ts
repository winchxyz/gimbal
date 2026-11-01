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
// One event, one response: the same finding (same intents, same positions) is answered once. When the response did
// not reach its targets (refused, stuck, partly filled, a close that threw), the watch keeps the response: its
// targets and the intents from before it. The pair trader adopts what the legs hold after a failed close as its new
// intents, so they would show nothing off; the kept response is tried again from where the legs are now, after a
// backoff (RETRY_MS, doubling up to RETRY_MAX_MS), until the legs reach its targets. It is dropped when the trader
// opens or closes on its own (its intents move off what the response left). Only the first attempt is journaled
// (`retry` 0), and a retry is logged as due only while the response is kept.

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

/** The parts of PairTrader the ADL watch reads and drives. */
export interface AdlTrader {
  readonly legs: [TradeLeg, TradeLeg];
  /** The pair's common lot: every size it trades is a whole number of these. */
  readonly lot: bigint;
  readonly busy: boolean;
  readonly net: bigint;
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
  /** The response brought the legs to its targets (false for action none, a refusal, a partial fill or a throw). */
  reached: boolean;
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

  constructor(trader: AdlTrader, options: { log?: (line: string) => void; clock?: Clock; sleep?: (ms: number) => Promise<void>; confirmMs?: number } = {}) {
    this.#trader = trader;
    this.#log = options.log ?? (() => {});
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#confirmMs = options.confirmMs ?? CONFIRM_MS;
  }

  /** One look at both legs; null when nothing is off, nothing can be told now, or a response waits its backoff. */
  async check(): Promise<AdlReport | null> {
    const first = await this.#read();
    if (first === null) return null;
    const pending = this.#keep(first);
    if (pending === null && first.findings.length === 0) return null;
    if (pending !== null && this.#clock.now() < pending.nextAt) return null;
    if (pending === null && first.key === this.#settled) return null;
    await this.#sleep(this.#confirmMs);
    const second = await this.#read();
    if (second === null || second.key !== first.key) {
      this.#log(`adl: ${pending === null ? describe(first.findings) : 'the retry\'s read'} not confirmed by a read ${this.#confirmMs / 1000} s later: nothing done`);
      return null;
    }
    if (pending !== null) {
      const report = await this.#respond(pending.findings, second.positions, pending.unwind, pending.tries);
      this.#after(report, pending.findings, pending.intents, pending.unwind, pending.tries + 1);
      return report;
    }
    const report = await this.#answer(second.findings, second.positions, second.intents);
    if (report.action === 'none') this.#settled = second.key;
    else this.#after(report, second.findings, second.intents, report.action === 'unwind', 1);
    return report;
  }

  /** The kept response, unless the legs reached its targets or the trader has traded on its own since (dropped). */
  #keep(read: Read): Pending | null {
    const p = this.#pending;
    if (p === null) return null;
    const reached = read.positions.every((q, i) => q === p.targets[i]);
    const moved = read.intents.some((q, i) => q !== p.adopted[i]);
    if (!reached && !moved) return p;
    this.#pending = null;
    this.#log(reached ? 'adl: the legs reached the response\'s targets' : 'adl: the pair trader traded since the response: it is dropped');
    return null;
  }

  /** After a response: kept for a retry when it did not reach its targets, else done. */
  #after(report: AdlReport, findings: AdlFinding[], intents: [bigint, bigint], unwind: boolean, tries: number): void {
    const t = this.#trader;
    if (report.reached || report.targets === null) {
      this.#pending = null;
      return;
    }
    const nextAt = this.#clock.now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (tries - 1));
    const adopted = t.legs.map((leg) => t.intent(leg) ?? null) as [bigint | null, bigint | null];
    this.#pending = { findings, intents, unwind, targets: report.targets, adopted, tries, nextAt };
    this.#log(`adl: ${report.summary}; tried ${tries}x, next try after ${iso(nextAt)}`);
  }

  /** Both legs read while nothing of ours moves them; null when that cannot be told now. */
  async #read(): Promise<Read | null> {
    const positions: bigint[] = [];
    const intents: bigint[] = [];
    const findings: AdlFinding[] = [];
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
      const change = legChange(intent, pos);
      if (change !== 'same') findings.push({ index, leg, intent, pos, change });
    }
    const key = `${intents.join(',')} ${positions.join(',')}`;
    return { findings, positions: positions as [bigint, bigint], intents: intents as [bigint, bigint], key };
  }

  /** The leg's intent when nothing of ours can be moving it; null otherwise. */
  #quiet(leg: TradeLeg): bigint | null {
    const t = this.#trader;
    if (t.busy || t.watching(leg) || t.unsettled(leg) !== null) return null;
    const intent = t.intent(leg);
    return intent === undefined ? null : intent;
  }

  async #answer(findings: AdlFinding[], pos: [bigint, bigint], intents: [bigint, bigint]): Promise<AdlReport> {
    const what = describe(findings);
    const none = (summary: string): AdlReport => {
      this.#log(`adl: ${summary}`);
      return { findings, action: 'none', targets: null, result: null, summary, retry: 0, reached: false };
    };
    if (findings.some((f) => f.change !== 'shrank')) {
      return none(`position off the intent, not ADL, nothing traded: ${findings.map((f) => `${f.leg.venue} ${f.leg.symbol} ${f.change} ${signedQtyString(f.intent)} -> ${signedQtyString(f.pos)}`).join('; ')}`);
    }
    const net = this.#trader.net;
    if (net !== 0n || intents[0] + intents[1] !== net) {
      return none(`${what} shrank without an order of ours, but the pair was not hedged before (intents ${intents.map(signedQtyString).join(' and ')}): nothing traded, the owner must act`);
    }
    // The size both legs can still offset: what the shrunk leg (or the smaller of two) kept, in whole common lots.
    const kept = level(pos, this.#trader.lot);
    const share = Number(kept) / Number(abs(intents[0]));
    const unwind = kept === 0n || share < UNWIND_BELOW;
    return this.#respond(findings, pos, unwind, 0);
  }

  /**
   * The response from where the legs are now: level both at the smaller size (whole common lots), then, for an
   * unwind, close both. Every order reduce-only; a target that is not reachable so is refused before anything is sent.
   */
  async #respond(findings: AdlFinding[], pos: [bigint, bigint], unwind: boolean, retry: number): Promise<AdlReport> {
    const what = describe(findings);
    const t = this.#trader;
    const [a, b] = t.legs;
    const kept = level(pos, t.lot);
    const levelled: [bigint, bigint] = [sign(pos[0]) * kept, sign(pos[1]) * kept];
    const targets: [bigint, bigint] = unwind ? [0n, 0n] : levelled;
    const action = unwind ? 'unwind' : 'rehedge';
    for (const i of [0, 1] as const) {
      if (pos[i] !== levelled[i] && reducedTarget(pos[i], levelled[i]) !== levelled[i]) {
        const summary = `${what}: ${t.legs[i].venue} at ${signedQtyString(pos[i])} cannot reach ${signedQtyString(levelled[i])} reduce-only: nothing traded`;
        this.#log(`adl: ${summary}`);
        return { findings, action: 'none', targets: null, result: null, summary, retry, reached: false };
      }
    }
    const base = abs(findings[0]!.intent);
    const share = base === 0n ? 0 : Number(kept) / Number(base);
    const moves = (to: [bigint, bigint]) => [a, b].map((l, i) => (pos[i] === to[i] ? null : `${l.venue} ${signedQtyString(pos[i])} -> ${signedQtyString(to[i])}`)).filter((x) => x !== null).join(', ');
    const plan = unwind
      ? `unwinding both legs (${Math.round(share * 100)} % kept, under ${UNWIND_BELOW * 100} %): levelling at ${qtyString(kept)} first${kept === 0n ? '' : ', then closing both'}`
      : `re-hedging at ${qtyString(kept)}: ${moves(levelled)}`;
    const head = `ADL on ${what} (shrank without an order of ours)${retry > 0 ? ` (retry ${retry})` : ''}; ${plan}`;
    this.#log(`adl: ${what} without an order of ours; ${plan}`);
    let result: PairResult | null = null;
    try {
      if (pos.some((q, i) => q !== levelled[i])) {
        result = await t.close({ reason: `adl: ${what}${unwind ? ' (level first)' : ''}`, targets: levelled, reduceOnly: true });
      }
      if (unwind && kept > 0n && (result === null || result.status === 'closed')) {
        const first = result;
        result = await t.close({ reason: `adl: ${what} (unwind)`, targets: [0n, 0n], reduceOnly: true });
        if (first !== null) result = { ...result, tx: [...first.tx, ...result.tx], notes: [...first.notes, ...result.notes] };
      }
    } catch (err) {
      return { findings, action, targets, result, summary: `${head} failed: ${errorText(err)}`, retry, reached: false };
    }
    const reached = result === null || result.status === 'closed';
    const done = result === null || result.status === 'closed' ? (unwind ? 'both legs closed' : 'level again') : `pair ${result.status}: ${result.notes.at(-1) ?? ''}`;
    return { findings, action, targets, result: result ?? closedNothing(), summary: `${head}: ${done}`, retry, reached };
  }
}

interface Read {
  findings: AdlFinding[];
  positions: [bigint, bigint];
  intents: [bigint, bigint];
  key: string;
}

interface Pending {
  findings: AdlFinding[];
  intents: [bigint, bigint];        // before the response
  unwind: boolean;
  targets: [bigint, bigint];        // where the response takes the legs
  adopted: [bigint | null, bigint | null];   // the trader's intents right after it
  tries: number;
  nextAt: number;
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
  return { status: 'closed', size: '0', legs: [] as unknown as PairResult['legs'], notes: ['both legs were already at their targets'], tx: [] };
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
