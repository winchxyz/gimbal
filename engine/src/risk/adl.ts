// ADL detection: a leg whose position shrank without an order of ours (auto-deleveraging, or a partial liquidation;
// the venue's account read cannot tell them apart, and both leave the pair unhedged by the same amount).
//
// Our own fills never look like ADL because the pair trader is asked first. A leg is compared with what the trader
// means it to hold (its intent: the final position of its last open or close, kept up to date by its watch), and only
// while nothing of ours can be moving it:
//   - the trader is idle (`busy` false: no open, close or watch check queued or running);
//   - the leg is not watched (`watching` false: no Orderly replay window of a signed order, no Hyperliquid order with
//     no answer that may still land);
//   - the intent is known (not null, not before the first open).
// The position is read from the venue, and the three conditions are checked again after the read: an open that
// started meanwhile, or a result that moved the intent, makes the read stale and it is dropped.
//
// Shrank means: same side as the intent (or flat), smaller in size. A position that grew, or flipped side, is not
// ADL (no venue deleverages past zero or adds size); it is reported for the owner and nothing is traded.
//
// Response, through the pair trader's own reduce-only close (so the trader's intent follows the new sizes):
//   - re-hedge: what remains is at least UNWIND_BELOW of the intent: the partner is reduced by as much as the leg
//     lost, and the pair is level again at the smaller size;
//   - unwind: less remains (or nothing): both legs are closed. A small remnant earns little funding against two
//     takers' fees, and a leg that has been deleveraged once sits where the venue is short of counterparties.

import type { JournalEntry } from '@gimbal/shared';
import type { TradeLeg } from '../trade/legs.ts';
import { abs, qtyString, signedQtyString } from '../trade/lots.ts';
import type { PairResult } from '../trade/pair.ts';

/** A leg left with less than this share of its intent is unwound with its partner instead of re-hedged. */
export const UNWIND_BELOW = 0.5;

/** The parts of PairTrader the ADL watch reads and drives. */
export interface AdlTrader {
  readonly legs: [TradeLeg, TradeLeg];
  readonly busy: boolean;
  watching(leg: TradeLeg): boolean;
  intent(leg: TradeLeg): bigint | null | undefined;
  close(request: { reason: string; targets?: [bigint, bigint] }): Promise<PairResult>;
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
}

export class AdlWatch {
  readonly #trader: AdlTrader;
  readonly #log: (line: string) => void;

  constructor(trader: AdlTrader, options: { log?: (line: string) => void } = {}) {
    this.#trader = trader;
    this.#log = options.log ?? (() => {});
  }

  /** One look at both legs; null when nothing is off (or nothing can be told now). */
  async check(): Promise<AdlReport | null> {
    const findings: AdlFinding[] = [];
    const positions: (bigint | null)[] = [null, null];
    for (const index of [0, 1] as const) {
      const leg = this.#trader.legs[index];
      const intent = this.#quiet(leg);
      if (intent === null) return null;                  // the trader may be moving the legs: nothing to tell
      let pos: bigint;
      try {
        pos = await leg.position();
      } catch (err) {
        this.#log(`adl: ${leg.venue} ${leg.symbol}: position unread (${err instanceof Error ? err.message : String(err)}): not checked`);
        return null;
      }
      // Our own order may have started while the read was out: its answer is stale then.
      if (this.#quiet(leg) !== intent) return null;
      positions[index] = pos;
      const change = legChange(intent, pos);
      if (change !== 'same') findings.push({ index, leg, intent, pos, change });
    }
    if (findings.length === 0) return null;
    const odd = findings.filter((f) => f.change !== 'shrank');
    if (odd.length > 0) {
      const summary = `position off the intent, not ADL, nothing traded: ${odd.map((f) => `${f.leg.venue} ${f.leg.symbol} ${f.change} ${signedQtyString(f.intent)} -> ${signedQtyString(f.pos)}`).join('; ')}`;
      this.#log(`adl: ${summary}`);
      return { findings, action: 'none', targets: null, result: null, summary };
    }
    return this.#respond(findings, positions as [bigint, bigint]);
  }

  /** The leg's intent when nothing of ours can be moving it; null otherwise. */
  #quiet(leg: TradeLeg): bigint | null {
    if (this.#trader.busy || this.#trader.watching(leg)) return null;
    const intent = this.#trader.intent(leg);
    return intent === undefined ? null : intent;
  }

  async #respond(findings: AdlFinding[], pos: [bigint, bigint]): Promise<AdlReport> {
    const [a, b] = this.#trader.legs;
    const intents: [bigint, bigint] = [this.#trader.intent(a)!, this.#trader.intent(b)!];
    // The size both legs can still offset: what the shrunk leg (or the smaller of two) kept.
    const kept = findings.reduce((m, f) => (abs(f.pos) < m ? abs(f.pos) : m), abs(intents[0]) > abs(intents[1]) ? abs(intents[0]) : abs(intents[1]));
    const share = Number(kept) / Number(findings.reduce((m, f) => (abs(f.intent) > m ? abs(f.intent) : m), 0n));
    const unwind = kept === 0n || share < UNWIND_BELOW;
    const sign = (q: bigint) => (q < 0n ? -1n : 1n);
    const targets: [bigint, bigint] = unwind ? [0n, 0n] : [sign(intents[0]) * kept, sign(intents[1]) * kept];
    const what = findings.map((f) => `${f.leg.venue} ${f.leg.symbol} ${signedQtyString(f.intent)} -> ${signedQtyString(f.pos)}`).join(', ');
    const plan = unwind
      ? `unwinding both legs (${Math.round(share * 100)} % kept, under ${UNWIND_BELOW * 100} %)`
      : `re-hedging at ${qtyString(kept)}: ${[a, b].map((l, i) => (pos[i] === targets[i] ? null : `${l.venue} ${signedQtyString(pos[i]!)} -> ${signedQtyString(targets[i]!)}`)).filter((s) => s !== null).join(', ')}`;
    this.#log(`adl: ${what} without an order of ours; ${plan}`);
    const result = await this.#trader.close({ reason: `adl: ${what}`, targets });
    const done = result.status === 'closed' ? (unwind ? 'both legs closed' : 'level again') : `pair ${result.status}: ${result.notes.at(-1) ?? ''}`;
    return {
      findings, action: unwind ? 'unwind' : 'rehedge', targets, result,
      summary: `ADL on ${what} (shrank without an order of ours); ${plan}: ${done}`,
    };
  }
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
    },
    tx: report.result?.tx ?? [],
  };
}
