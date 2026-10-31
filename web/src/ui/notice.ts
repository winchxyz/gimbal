// A one-line note under the status line: "Not sent: ..." for the buttons whose wallet or engine call is not
// connected yet. One note at a time; a new one replaces the old. Pure reducer plus a tiny store, so it is tested.
import { useSyncExternalStore } from 'react';
import { createStore } from '../stream/hub.ts';

export interface Notice {
  /** Changes with every note, so a repeated press restarts the timer that hides it. */
  id: number;
  text: string;
}

export type NoticeAction = { kind: 'show'; text: string } | { kind: 'clear' };

export function reduceNotice(state: Notice | null, action: NoticeAction): Notice | null {
  if (action.kind === 'clear') return null;
  return { id: (state?.id ?? 0) + 1, text: action.text };
}

const noticeStore = createStore(reduceNotice, null);

/** Shows a note. Say what was not done and that nothing changed. */
export const notify = (text: string): void => noticeStore.dispatch({ kind: 'show', text });
export const clearNotice = (): void => noticeStore.dispatch({ kind: 'clear' });

export function useNotice(): Notice | null {
  return useSyncExternalStore(noticeStore.subscribe, noticeStore.getState);
}

/** How long a note stays when nobody dismisses it. */
export const NOTICE_MS = 9000;
