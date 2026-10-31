// A one-line note under the status line: "Not sent: ..." for the buttons whose wallet call is not connected yet, and
// what the engine answered to Close. One note at a time; a new one replaces the old. Pure reducer plus a tiny store,
// so it is tested.
import { useSyncExternalStore } from 'react';
import { createStore } from '../stream/hub.ts';

export interface Notice {
  /** Changes with every note, so a repeated press restarts the timer that hides it. */
  id: number;
  /** The word in front of the text. */
  title: string;
  text: string;
  /** `warn` is amber (something was not done); `ok` is plain (the engine took it). */
  tone: 'warn' | 'ok';
}

export type NoticeAction = { kind: 'show'; text: string; title?: string; tone?: Notice['tone'] } | { kind: 'clear' };

export function reduceNotice(state: Notice | null, action: NoticeAction): Notice | null {
  if (action.kind === 'clear') return null;
  return { id: (state?.id ?? 0) + 1, title: action.title ?? 'Not sent', text: action.text, tone: action.tone ?? 'warn' };
}

const noticeStore = createStore(reduceNotice, null);

/** Shows a note. Say what was not done and that nothing changed. */
export const notify = (text: string, title?: string, tone?: Notice['tone']): void =>
  noticeStore.dispatch({ kind: 'show', text, ...(title === undefined ? {} : { title }), ...(tone === undefined ? {} : { tone }) });
export const clearNotice = (): void => noticeStore.dispatch({ kind: 'clear' });

export function useNotice(): Notice | null {
  return useSyncExternalStore(noticeStore.subscribe, noticeStore.getState);
}

/** How long a note stays when nobody dismisses it. */
export const NOTICE_MS = 9000;
