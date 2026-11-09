// What the owner is told after Rotate or Close Position was sent to the engine (`POST /rotate`, `POST /close`).
// The engine answers `{ ok: true }` or `{ ok: false, reason }` at once; the work itself shows up as Journal and Desk
// events. Pure, so every wording is tested; useEngine.ts does the sending.
import type { ActionResult, EngineApi } from '../stream/api.ts';
import { orderlyRotateReason } from '../ui/waitCopy.ts';
import { actingText } from './enter.ts';
import { capital, sentence } from './format.ts';

/**
 * `rotate` names the symbols for the notice and the target window's id for the request; `close.symbol` is the window
 * being closed, when the page knows it; `enter` is the public live view owner's demo entry from flat (`POST /rotate`
 * with `demo: { maxLossUsd }`).
 */
export type ManualAction =
  | { kind: 'rotate'; from: string; to: string; windowId: string }
  | { kind: 'close'; symbol: string | null }
  | { kind: 'enter'; symbol: string; windowId: string; maxLossUsd: number };

export interface Outcome {
  /**
   * `sent`: the engine took it. `refused`: it said no, and nothing changed. `running`: it said no because the loop is
   * still acting (an entry sent before, for one), so nothing new was taken but something is under way. `unknown`: no
   * answer, so nobody can say.
   */
  tone: 'sent' | 'refused' | 'running' | 'unknown';
  /** The word in front of the text on the notice line. */
  title: string;
  text: string;
}

/**
 * What the loop is doing, from the engine's 409 while it acts (loop.ts #manualRefusal: `the strategy loop is acting
 * (<what>): try again when it is done`); null for any other reason.
 */
export function actingOf(reason: string): string | null {
  const m = /^the strategy loop is acting \((.+)\): try again when it is done$/.exec(reason.trim());
  return m === null ? null : m[1]!;
}

/** The engine's reason as a sentence: "the strategy engine is not running yet" becomes "The strategy engine is not running yet." */
export const reasonText = (reason: string): string => orderlyRotateReason(reason) ?? sentence(capital(reason.trim()));

const unchanged = (action: ManualAction): string =>
  action.kind === 'rotate'
    ? `${action.from} is still held.`
    : action.kind === 'enter'
      ? 'Nothing was opened.'
      : action.symbol ? `Both ${action.symbol} legs are still open.` : 'Both legs are still open.';

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
    if (action.kind === 'enter') {
      return {
        tone: 'sent',
        title: 'Entry started',
        text: `${action.symbol}, checked again with the NEAR AI risk check, then maker orders, then a taker order for what they leave, within the caps. It takes a few minutes, watch the Journal.`,
      };
    }
    return {
      tone: 'sent',
      title: 'Sent',
      text:
        action.kind === 'rotate'
          ? `The engine checks the rotation again, then closes ${action.from} and opens ${action.to}. Follow it in the Journal.`
          : 'The engine closes both legs with reduce-only orders. Follow it in the Journal.',
    };
  }
  // 409 while the loop acts: not a refusal of this request's merits. An entry sent before is still running.
  const acting = actingOf(answer.reason);
  if (acting !== null) return { tone: 'running', title: 'Still running', text: actingText(acting) };
  return { tone: 'refused', title: 'Not sent', text: `The engine refused it. ${reasonText(answer.reason)} ${unchanged(action)}` };
}

/** The question asked before a send, in the page's own words; the same for the Desk, the Windows list and the detail. */
export function confirmText(action: ManualAction): string {
  if (action.kind === 'rotate') return `Rotate ${action.from} to ${action.to}? Both ${action.from} legs close and ${action.to} opens.`;
  if (action.kind === 'enter') return `Enter ${action.symbol} now?`;
  return 'Close both legs now?';
}

/** Sends the action through `api` and says what came of it; it never throws, whatever the engine or the network does. */
export async function sendVia(api: Pick<EngineApi, 'rotate' | 'close'>, action: ManualAction): Promise<Outcome> {
  try {
    const answer = action.kind === 'rotate'
      ? await api.rotate(action.windowId)
      : action.kind === 'enter'
        ? await api.rotate(action.windowId, { maxLossUsd: action.maxLossUsd })
        : await api.close();
    return outcomeOf(action, answer);
  } catch (error) {
    return outcomeOf(action, error instanceof Error ? error : new Error(String(error)));
  }
}
