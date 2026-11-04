// What is wrong with the remote connection right now, for the line under the header: one problem at a time, gone as
// soon as a read succeeds. A tiny store like the notice bar's, so the wording and the reducer are tested.
import { useSyncExternalStore } from 'react';
import { createStore } from '../stream/hub.ts';
import { toViewError, viewErrorText, type ViewErrorKind } from './view.ts';

export interface Problem {
  kind: ViewErrorKind;
  title: string;
  text: string;
}

export type ProblemAction = { kind: 'report'; error: unknown } | { kind: 'clear' };

export function reduceProblem(state: Problem | null, action: ProblemAction): Problem | null {
  if (action.kind === 'clear') return null;
  const error = toViewError(action.error);
  const { title, text } = viewErrorText(error);
  // The same problem again changes nothing, so the line does not redraw on every retry.
  return state !== null && state.kind === error.kind && state.text === text ? state : { kind: error.kind, title, text };
}

export const problemStore = createStore(reduceProblem, null);
export const reportProblem = (error: unknown): void => problemStore.dispatch({ kind: 'report', error });
export const clearProblem = (): void => problemStore.dispatch({ kind: 'clear' });

export function useProblem(): Problem | null {
  return useSyncExternalStore(problemStore.subscribe, problemStore.getState);
}

/** The problems with their own wording in the remote bar; `status` and `unreachable` are the connection bar's ("Engine not answering"). */
export const hasOwnLine = (problem: Problem | null): problem is Problem =>
  problem !== null && problem.kind !== 'status' && problem.kind !== 'unreachable';

/** Whether the person has to act: only a missing or rejected token is theirs to fix; the rest the page retries by itself. */
export const needsToken = (problem: Problem | null): boolean => problem?.kind === 'token' || problem?.kind === 'needs-token';
