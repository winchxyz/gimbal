// The public live view's own state, from its host's GET /healthz (engine/src/cli/live-host-lib.ts): whether the host
// has a live engine to read at all. "Not configured" is said plainly, once, instead of an endless "not answering".
// The host answers /healthz itself, never from the engine, so asking it every half minute costs the engine nothing.
import { useEffect, useSyncExternalStore } from 'react';
import { createStore } from '../stream/hub.ts';
import { isHostedLive } from './readonly.ts';

export type HostedLive = 'unknown' | 'connected' | 'connecting' | 'down' | 'not-configured';

const STATES: readonly string[] = ['connected', 'connecting', 'down', 'not-configured'];

/** The `live` field of the host's /healthz; anything else is `unknown`. */
export function parseHostedHealth(body: unknown): HostedLive {
  const live = typeof body === 'object' && body !== null ? (body as { live?: unknown }).live : undefined;
  return typeof live === 'string' && STATES.includes(live) ? (live as HostedLive) : 'unknown';
}

export const NOT_CONFIGURED_TITLE = 'Live engine not configured';
export const NOT_CONFIGURED_TEXT = 'This site is not connected to the live engine yet (the host has no engine address or view token), so there is no desk to show.';

const hostedStore = createStore((_state: HostedLive, next: HostedLive) => next, 'unknown' as HostedLive);

/** Whether the host has owner writes on (GIMBAL_OWNER_WRITES=1): its /healthz says `owner: true` only then. */
export function parseOwnerWrites(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { owner?: unknown }).owner === true;
}

const ownerWritesStore = createStore((_state: boolean, next: boolean) => next, false);

/** The host's owner writes as last read; false until it says otherwise (so a visitor's page is as before). */
export function useHostedOwnerWrites(): boolean {
  return useSyncExternalStore(ownerWritesStore.subscribe, ownerWritesStore.getState);
}

export const POLL_MS = 30_000;

async function readHealth(): Promise<void> {
  try {
    const r = await fetch('/healthz', { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    const body: unknown = await r.json();
    hostedStore.dispatch(parseHostedHealth(body));
    ownerWritesStore.dispatch(parseOwnerWrites(body));
  } catch {
    // The host itself is unreachable: the connection bar already says the engine is not answering.
  }
}

/** The host's state as last read; `unknown` outside the hosted-live build. */
export function useHostedLive(): HostedLive {
  return useSyncExternalStore(hostedStore.subscribe, hostedStore.getState);
}

/** Reads the host's state at load and every POLL_MS while the component that calls it is shown (the bar under the header). */
export function usePollHostedLive(): HostedLive {
  useEffect(() => {
    if (!isHostedLive()) return;
    void readHealth();
    const timer = setInterval(() => void readHealth(), POLL_MS);
    return () => clearInterval(timer);
  }, []);
  return useHostedLive();
}
