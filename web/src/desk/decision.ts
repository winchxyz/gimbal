// The strategy loop's latest decision as the Desk draws it: one quiet line under the status. Pure, so the wording is tested.
import type { StrategyDecision } from '@gimbal/shared';
import { ago } from '../ui/useNow.ts';

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
  /** The engine's own sentence, with its numbers; shown as sent. */
  reason: string;
  /** `3 min ago` */
  when: string;
}

/** The line for a decision, or null when the engine has not decided anything yet (nothing is drawn then). */
export function decisionLine(decision: StrategyDecision | null, now: number): DecisionLine | null {
  if (decision === null) return null;
  return { word: ACTION_WORDS[decision.action], reason: decision.reason.trim(), when: ago(decision.at, now) };
}
