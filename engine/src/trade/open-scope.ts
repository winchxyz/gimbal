// Which async work belongs to the strategy loop's open. ProtectedPair runs its open inside OPEN_SCOPE with a token of
// its own, and the guarded legs let an order that is not reduce-only out only from inside that token's work: the
// open's own parts, its legging guard and its residual hedge. A watch check the trader runs between two parts (a push,
// an unsettled order's poll) runs outside the scope (PairTrader leaves it with outsideOpen), so a re-hedge it sends
// cannot ride on an open that happens to be running, and nothing another pair sends can either.

import { AsyncLocalStorage } from 'node:async_hooks';

/** One open: the pair that runs it. */
export interface OpenToken {
  readonly owner: object;
}

export const OPEN_SCOPE = new AsyncLocalStorage<OpenToken>();

/** Runs `fn` (and the async work it starts) outside any open's scope. */
export function outsideOpen<T>(fn: () => T): T {
  return OPEN_SCOPE.exit(fn);
}
