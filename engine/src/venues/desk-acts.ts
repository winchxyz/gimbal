// When the desk last acted on a venue, for the readers that reuse an account answer (phoenix.ts accountWithin and its
// joined reads): an answer read before the desk's own order, close or rescue shows the margin from before it, so it
// is never handed out after one. The relayer marks every action as it starts and again once it ends (relayer.ts):
// a read started while one was in flight may have seen either side of it.

let epoch = 0;

/** Marks that the desk acts on a venue now: every account answer read before this is too old to reuse. */
export function noteDeskAct(): void {
  epoch++;
}

/** A number that changes whenever the desk acts: an answer read under another number must not be reused. */
export function deskActEpoch(): number {
  return epoch;
}

/** Runs `fn` (the desk's action) marked as one, at its start and at its end, whatever it returns or throws. */
export async function asDeskAct<T>(fn: () => Promise<T>): Promise<T> {
  noteDeskAct();
  try {
    return await fn();
  } finally {
    noteDeskAct();
  }
}
