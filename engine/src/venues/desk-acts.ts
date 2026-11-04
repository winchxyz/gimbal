// When the desk last acted on a venue, for the readers that reuse an account answer (phoenix.ts accountWithin and its
// joined reads): an answer read before the desk's own order, close or rescue shows the margin from before it, so it
// is never handed out after one. The relayer marks every action as it starts and again once it ends (relayer.ts):
// a read started while one was in flight may have seen either side of it. A venue's API can lag its chain, so a read
// started in the DESK_ACT_SETTLE_MS after an act's end is not reused either.

/** After an act's end, how long a venue's API may still answer from before it (Phoenix's lags the chain). */
export const DESK_ACT_SETTLE_MS = 2_000;

let epoch = 0;
let settledAt = -Infinity;
let clock: () => number = Date.now;

/** When an answer was asked for, in desk-act terms: compare it with stillReusable(). */
export interface DeskActStamp {
  epoch: number;
  at: number;
}

/** Marks that the desk acts on a venue now: every account answer read before this is too old to reuse. */
export function noteDeskAct(): void {
  epoch++;
}

/** Marks the end of the desk's act: answers read before it, or in the DESK_ACT_SETTLE_MS after it, are not reused. */
export function noteDeskActEnd(): void {
  epoch++;
  settledAt = clock() + DESK_ACT_SETTLE_MS;
}

/** A number that changes whenever the desk acts: an answer read under another number must not be reused. */
export function deskActEpoch(): number {
  return epoch;
}

/** The stamp of a read starting now. */
export function deskActStamp(): DeskActStamp {
  return { epoch, at: clock() };
}

/** Whether an answer asked for at `stamp` may be handed out now: no act since, and asked after the last one settled. */
export function stillReusable(stamp: DeskActStamp): boolean {
  return stamp.epoch === epoch && stamp.at >= settledAt;
}

/** Tests: the clock the settle is measured on (default Date.now); returns a function that puts the old one back. */
export function useDeskActClock(now: () => number): () => void {
  const before = clock;
  clock = now;
  return () => {
    clock = before;
  };
}

/** Runs `fn` (the desk's action) marked as one, at its start and at its end, whatever it returns or throws. */
export async function asDeskAct<T>(fn: () => Promise<T>): Promise<T> {
  noteDeskAct();
  try {
    return await fn();
  } finally {
    noteDeskActEnd();
  }
}
