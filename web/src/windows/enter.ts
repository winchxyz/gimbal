// The public live view owner's entry (`POST /rotate` with `demo`, engine/src/strategy/loop.ts): which windows offer it,
// why one cannot, and the confirm text that says in plain words what will happen. Pure, so every wording is tested.
//
// What a demo entry waives and what it never does (the engine's own check, rotateRefusal): the window's profit checks
// (the carry gate, break-even) are waived; it must still be tradable, not refused by the contract, not stale, not
// refused or held out by the NEAR AI risk check, pass every other check and the policy's markets, be sized within the
// leg size, free margin and the policy's cap, and its round trip may cost at most `maxLossUsd`. The desk must be flat:
// a demo entry never closes a held pair. Auto must be on (the engine says so when it is not). Every order is still
// checked by the contract against the owner's policy before the MPC network signs it.
import type { Window as FundingWindow } from '@gimbal/shared';
import { capital } from './format.ts';
import { heldWindow, isNoDesk } from './model.ts';

/** The most an owner entry accepts as its round trip's cost, USD: the engine's cap (engine/src/scanner/carry.ts DEMO_MAX_LOSS_USD). */
export const OWNER_MAX_LOSS_USD = 1;

export type EnterState =
  /** Not offered at all: a watch-only window, or the one held now. */
  | { kind: 'none' }
  /** Offered but disabled, with the reason shown next to it. */
  | { kind: 'blocked'; reason: string }
  | { kind: 'open' };

/** Whether the owner can ask to enter `w` now, as far as the page can tell (the engine checks again and answers). */
export function enterState(w: FundingWindow, windows: readonly FundingWindow[]): EnterState {
  if (!w.tradable || w.held) return { kind: 'none' };
  const held = heldWindow(windows);
  if (held !== null) return { kind: 'blocked', reason: `${held.symbol} is held. An owner entry opens from flat only: close ${held.symbol} first.` };
  if (isNoDesk(w)) return { kind: 'blocked', reason: 'There is no desk to trade it with.' };
  if (w.refused) return { kind: 'blocked', reason: `The contract would refuse it (${w.refused.code}): ${capital(w.refused.reason)}` };
  if (w.stale) return { kind: 'blocked', reason: 'Its numbers are stale: a venue it needs did not answer.' };
  if (w.veto?.verdict === 'veto') return { kind: 'blocked', reason: 'The NEAR AI risk check refused it.' };
  return { kind: 'open' };
}

const money = (n: number): string => `$${n.toFixed(2)}`;
const whole = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * The confirm step: the two legs and their venues, the size per leg, the most the round trip may cost, that the contract
 * still checks every order, and that it opens from flat (a held pair is never closed by it).
 */
export function enterConfirmText(w: FundingWindow, venue: (id: string) => string, legUsd: number | null, maxLossUsd = OWNER_MAX_LOSS_USD): string {
  const size = legUsd === null
    ? 'at the engine rules’ leg size'
    : `up to ${whole(legUsd)} a leg (the engine rules’ leg size; it sizes again on free margin and the policy’s cap)`;
  return [
    `Enter ${w.symbol}: long on ${venue(w.longVenue)} and short on ${venue(w.shortVenue)}, ${size}.`,
    `An owner entry skips the profit checks only; it is refused if the round trip would cost more than ${money(maxLossUsd)}, and every other check still runs, the NEAR AI risk check included.`,
    'The contract checks every order against your policy before it is signed.',
    'It opens from flat only: a held pair is never closed by it.',
  ].join(' ');
}
