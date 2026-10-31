// The amber line under the header while the engine does not answer. Pure, so the wording is tested: it says what
// failed, what is still safe and what happens next (design/HANDOFF.md, Copy).
import type { Connection, Source } from '../stream/store.ts';

export interface ConnectionNotice {
  title: string;
  text: string;
}

export interface ConnectionView {
  source: Source | null;
  connection: Connection;
  /** Why the last attempt failed (`GET /state: 500`), or null. */
  error: string | null;
}

/**
 * Shown only for the engine's own stream, and only once an attempt has failed: the first connection of a page is
 * not worth a banner. `lastRead` is "12 s ago", or null when nothing has arrived since the page opened.
 */
export function connectionNotice(view: ConnectionView, lastRead: string | null): ConnectionNotice | null {
  if (view.source !== 'sse' || view.connection !== 'retrying') return null;
  const why = view.error ? ` (${view.error})` : '';
  if (lastRead === null) {
    return {
      title: 'Engine not answering',
      text: `This page cannot reach the engine${why}, so there is nothing to show yet. It keeps trying and fills in by itself.`,
    };
  }
  return {
    title: 'Engine not answering',
    text: `What you see is from ${lastRead}${why}. While the engine is down nothing new is entered or rescued, and your policy still holds on the contract. This page reconnects by itself.`,
  };
}
