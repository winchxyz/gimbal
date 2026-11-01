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
//
// Shrank means: same side as the intent (or flat), smaller in size. A position that grew, or flipped side, is not
// ADL (no venue deleverages past zero or adds size); it is reported for the owner and nothing is traded.
//
// The response is taken only when the intents offset each other (they add up to the pair's net, and that net is 0):
// a pair that was already unhedged is the owner's to fix, and sizing a re-hedge off it would grow a leg. It goes
// through the pair trader's close with `reduceOnly: true`, so every order is reduce-only and the close never reaches
// its re-hedge step: nothing this sends can open or grow a position.
//   - re-hedge: what remains is at least UNWIND_BELOW of the intent: the partner is reduced by as much as the leg
//     lost, and the pair is level again at the smaller size;
//   - unwind: less remains (or nothing): both legs are closed. A small remnant earns little funding against two
//     takers' fees, and a leg that has been deleveraged once sits where the venue is short of counterparties.
//
// One event, one response: the same finding (same intents, same positions) is answered once. When the response did
// not bring the pair level (refused, stuck, a read that threw), it is tried again only after a backoff (RETRY_MS,
// doubling up to RETRY_MAX_MS), and only the first attempt is journaled (`retry` 0).

import type { JournalEntry } from '@gimbal/shared';
import type { TradeLeg } from '../trade/legs.ts';
import { abs, qtyString, signedQtyString } from '../trade/lots.ts';
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
}

export class AdlWatch {
  readonly #trader: AdlTrader;
  readonly #log: (line: string) => void;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #confirmMs: number;
  /** The last finding answered: its key, how often, and when it may be tried again (null: done, never again). */
  #last: { key: string; tries: number; nextAt: number | null } | null = null;

  constructor(trader: AdlTrader, options: { log?: (line: string) => void; clock?: Clock; sleep?: (ms: number) => Promise<void>; confirmMs?: number } = {}) {
    this.#trader = trader;
    this.#log = options.log ?? (() => {});
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#confirmMs = options.confirmMs ?? CONFIRM_MS;
  }

  /** One look at both legs; null when nothing is off, nothing can be told now, or this finding waits its backoff. */
  async check(): Promise<AdlReport | null> {
    const first = await this.#read();
    if (first === null || first.findings.length === 0) return null;
    await this.#sleep(this.#confirmMs);
    const second = await this.#read();
    if (second === null || second.key !== first.key) {
      this.#log(`adl: ${describe(first.findings)} not confirmed by a read ${this.#confirmMs / 1000} s later: nothing done`);
      return null;
    }
    const { findings, positions, intents, key } = second;
    const last = this.#last?.key === key ? this.#last : null;
    if (last !== null && (last.nextAt === null || this.#clock.now() < last.nextAt)) return null;
    const retry = last === null ? 0 : last.tries;
    const report = await this.#answer(findings, positions, intents, retry);
    const settled = report.result?.status === 'closed' || report.action === 'none';
    const tries = retry + 1;
    this.#last = { key, tries, nextAt: settled ? null : this.#clock.now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** retry) };
    if (!settled) this.#log(`adl: ${report.summary}; tried ${tries}x, next try after ${iso(this.#last.nextAt!)}`);
    return report;
  }

  /** Both legs read while nothing of ours moves them; null when that cannot be told now. */
  async #read(): Promise<{ findings: AdlFinding[]; positions: [bigint, bigint]; intents: [bigint, bigint]; key: string } | null> {
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

  async #answer(findings: AdlFinding[], pos: [bigint, bigint], intents: [bigint, bigint], retry: number): Promise<AdlReport> {
    const what = describe(findings);
    const none = (summary: string): AdlReport => {
      this.#log(`adl: ${summary}`);
      return { findings, action: 'none', targets: null, result: null, summary, retry };
    };
    if (findings.some((f) => f.change !== 'shrank')) {
      return none(`position off the intent, not ADL, nothing traded: ${findings.map((f) => `${f.leg.venue} ${f.leg.symbol} ${f.change} ${signedQtyString(f.intent)} -> ${signedQtyString(f.pos)}`).join('; ')}`);
    }
    const net = this.#trader.net;
    if (net !== 0n || intents[0] + intents[1] !== net) {
      return none(`${what} shrank without an order of ours, but the pair was not hedged before (intents ${intents.map(signedQtyString).join(' and ')}): nothing traded, the owner must act`);
    }
    const [a, b] = this.#trader.legs;
    // The size both legs can still offset: what the shrunk leg (or the smaller of two) kept.
    const kept = findings.reduce((m, f) => (abs(f.pos) < m ? abs(f.pos) : m), abs(intents[0]));
    const share = Number(kept) / Number(abs(intents[0]));
    const unwind = kept === 0n || share < UNWIND_BELOW;
    const sign = (q: bigint) => (q < 0n ? -1n : 1n);
    const targets: [bigint, bigint] = unwind ? [0n, 0n] : [sign(intents[0]) * kept, sign(intents[1]) * kept];
    // Every target must be reachable by reducing from where the leg is now: nothing may open or grow.
    for (const i of [0, 1] as const) {
      if (pos[i] !== targets[i] && reducedTarget(pos[i], targets[i]) !== targets[i]) {
        return none(`${what}: ${this.#trader.legs[i].venue} at ${signedQtyString(pos[i])} cannot reach ${signedQtyString(targets[i])} reduce-only: nothing traded`);
      }
    }
    const plan = unwind
      ? `unwinding both legs (${Math.round(share * 100)} % kept, under ${UNWIND_BELOW * 100} %)`
      : `re-hedging at ${qtyString(kept)}: ${[a, b].map((l, i) => (pos[i] === targets[i] ? null : `${l.venue} ${signedQtyString(pos[i])} -> ${signedQtyString(targets[i])}`)).filter((s) => s !== null).join(', ')}`;
    this.#log(`adl: ${what} without an order of ours; ${plan}`);
    let result: PairResult;
    try {
      result = await this.#trader.close({ reason: `adl: ${what}`, targets, reduceOnly: true });
    } catch (err) {
      const summary = `ADL on ${what} (shrank without an order of ours); ${plan} failed: ${err instanceof Error ? err.message : String(err)}`;
      return { findings, action: unwind ? 'unwind' : 'rehedge', targets, result: null, summary, retry };
    }
    const done = result.status === 'closed' ? (unwind ? 'both legs closed' : 'level again') : `pair ${result.status}: ${result.notes.at(-1) ?? ''}`;
    return {
      findings, action: unwind ? 'unwind' : 'rehedge', targets, result, retry,
      summary: `ADL on ${what} (shrank without an order of ours); ${plan}: ${done}`,
    };
  }
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
