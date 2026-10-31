// What the owner is told after Rotate or Close Position was sent to the engine (`POST /rotate`, `POST /close`).
// The engine answers `{ ok: true }` or `{ ok: false, reason }` at once; the work itself shows up as Journal and Desk
// events. Pure, so every wording is tested; useEngine.ts does the sending.
import type { ActionResult } from '../stream/api.ts';
import { capital, sentence } from './format.ts';

/** `rotate` names the symbols for the notice and the target window's id for the request; `close.symbol` is the window being closed, when the page knows it. */
export type ManualAction =
  | { kind: 'rotate'; from: string; to: string; windowId: string }
  | { kind: 'close'; symbol: string | null };

export interface Outcome {
  /** `sent`: the engine took it. `refused`: it said no, and nothing changed. `unknown`: no answer, so nobody can say. */
  tone: 'sent' | 'refused' | 'unknown';
  /** The word in front of the text on the notice line. */
  title: string;
  text: string;
}

/** The engine's reason as a sentence: "the strategy engine is not running yet" becomes "The strategy engine is not running yet." */
export const reasonText = (reason: string): string => sentence(capital(reason.trim()));

const unchanged = (action: ManualAction): string =>
  action.kind === 'rotate' ? `${action.from} is still held.` : action.symbol ? `Both ${action.symbol} legs are still open.` : 'Both legs are still open.';

/** The result of a send: the engine's answer, or what went wrong on the way (`answer` is an `Error` when it did not answer). */
export function outcomeOf(action: ManualAction, answer: ActionResult | Error): Outcome {
  if (answer instanceof Error) {
    return {
      tone: 'unknown',
      title: 'No answer',
      text: `The engine did not answer, so this page cannot tell whether it was sent. Check the Journal before you try again.`,
    };
  }
  if (answer.ok) {
    return {
      tone: 'sent',
      title: 'Sent',
      text:
        action.kind === 'rotate'
          ? `The engine checks the rotation again, then closes ${action.from} and opens ${action.to}. Follow it in the Journal.`
          : 'The engine closes both legs with reduce-only orders. Follow it in the Journal.',
    };
  }
  return { tone: 'refused', title: 'Not sent', text: `The engine refused it. ${reasonText(answer.reason)} ${unchanged(action)}` };
}
