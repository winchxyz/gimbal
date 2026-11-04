// The strategy loop's latest decision as the Desk draws it: one quiet line under the status. Pure, so the wording is tested.
import type { StrategyDecision } from '@gimbal/shared';
import { ago } from '../ui/useNow.ts';
import { waitCopy, type WaitContext } from '../ui/waitCopy.ts';

/** `StrategyDecision.action` as one word. `off` is auto switched off or trading not enabled. */
export const ACTION_WORDS: Record<StrategyDecision['action'], string> = {
  off: 'Off',
  wait: 'Waiting',
  enter: 'Entering',
  hold: 'Holding',
  exit: 'Exiting',
  rotate: 'Rotating',
};

export interface DecisionLine {
  word: string;
  /** A wait, off or hold line in plain words (ui/waitCopy.ts); any other action's sentence, and one nothing knows, as sent. */
  reason: string;
  /** The engine's own sentence, with its numbers, as sent. */
  raw: string;
  /** `3 min ago` */
  when: string;
}

/** The line for a decision, or null when the engine has not decided anything yet (nothing is drawn then). */
export function decisionLine(decision: StrategyDecision | null, now: number, context: WaitContext = {}): DecisionLine | null {
  if (decision === null) return null;
  const raw = decision.reason.trim();
  const plain = decision.action === 'wait' || decision.action === 'off' || decision.action === 'hold';
  return { word: ACTION_WORDS[decision.action], reason: plain ? waitCopy(raw, context).text : raw, raw, when: ago(decision.at, now) };
}
