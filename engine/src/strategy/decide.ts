// The strategy loop's decision (docs/interfaces.md §3 "Strategy loop"): what the desk does next, from the scan, the
// held pair and the owner's StrategyConfig. Pure: the time, the veto answer and the saved counters come in as
// arguments, and nothing here signs, sends or reads a venue. loop.ts (serve) carries the decision out.
//
// E10 fills in decide() and the counters; this file fixes the shapes both sides build against.

import type { StrategyConfig, StrategyDecision, Window as FundingWindow } from '@gimbal/shared';

/** The rules StrategyConfig does not carry: engine constants, proposed for E10 and printed at start. */
export const LOOP_RULES = {
  enterAfterChecks: 3,        // hourly checks in a row a window must hold before entry
  exitAfterChecks: 3,         // hourly checks in a row of compression or a sign flip before exit
  cooldownHours: 6,           // after an exit, no new entry for this long
  maxHoldDays: 14,            // time stop
  maxRotationsPerDay: 2,
  vetoTimeoutMs: 5_000,       // NEAR AI veto: no answer in time = pass, journaled as "no veto check"
} as const;

/** The pair the desk holds, as the loop sees it. */
export interface HeldPair {
  windowId: string;
  symbol: string;
  since: number;              // ms, when it was entered
  legUsd: number;
  entryNetAprPct: number;
  pnlUsd: number;             // open P&L of both legs plus funding received, net of fees paid, since entry
}

/** What decide() remembers between checks; loop.ts saves it to disk so a restart keeps the counts. */
export interface LoopCounters {
  aboveByWindow: Record<string, number>;   // window id -> hourly checks in a row it passed the entry rules
  badChecks: number;                       // hourly checks in a row the held window compressed or flipped
  betterByWindow: Record<string, number>;  // window id -> hourly checks in a row it beat the held one by minGainPts
  lastExitAt: number | null;               // ms
  rotationsAt: number[];                   // ms of the rotations in the last 24 h
  lastHourlyAt: number | null;             // ms of the last hourly check (counters move only on those)
  lastWaitReason: string | null;           // a wait is journaled only when this changes
}

export const NO_COUNTERS: LoopCounters = {
  aboveByWindow: {}, badChecks: 0, betterByWindow: {}, lastExitAt: null, rotationsAt: [], lastHourlyAt: null,
  lastWaitReason: null,
};

export interface DecideInput {
  now: number;                             // ms
  hourly: boolean;                         // this check is the hourly one (after a funding payment), not a scan event
  windows: readonly FundingWindow[];       // the latest scan
  held: HeldPair | null;
  strategy: StrategyConfig;
  maxNotionalUsd: number;                  // the desk policy's max_notional_usd
  freeMarginUsd: Record<string, number>;   // venue id -> free margin there now
  liveRescue: Record<string, boolean>;     // venue id -> a live rescue route covers a leg there
  counters: LoopCounters;
}

export interface Decision {
  decision: StrategyDecision;              // published as the `decision` event when it changes
  counters: LoopCounters;                  // to save
  act:                                     // what loop.ts carries out; null = nothing to sign
    | { kind: 'enter'; windowId: string; legUsd: number; leverage: number }
    | { kind: 'exit'; reason: string }
    | { kind: 'rotate'; fromId: string; toId: string; legUsd: number; leverage: number }
    | null;
  vetoCandidate: string | null;            // enter/rotate target that still needs the NEAR AI veto before `act` runs
}

/** E10 replaces this body. Until then the loop only waits. */
export function decide(input: DecideInput): Decision {
  return {
    decision: { action: 'wait', reason: 'the strategy loop is not built yet', windowId: null, heldId: input.held?.windowId ?? null, at: input.now },
    counters: input.counters,
    act: null,
    vetoCandidate: null,
  };
}
