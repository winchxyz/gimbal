// Which stream the app opens. Pure, so the rule is tested without a browser.
import type { Mode } from '@gimbal/shared';
import type { Scenario } from './fake-windows.ts';
import type { Source } from './store.ts';

/**
 * Production always reads the engine. In development the fake is the default, so the shell runs
 * without an engine; `?stream=sse` reads the engine through the dev proxy instead.
 */
export function pickSource(search: string, dev: boolean): Source {
  if (!dev) return 'sse';
  return new URLSearchParams(search).get('stream') === 'sse' ? 'sse' : 'fake';
}

/** The network the fake desk reports, so each header variant can be seen: `?net=mainnet|testnet|replay`. */
export function pickFakeMode(search: string): Mode {
  const net = new URLSearchParams(search).get('net');
  return net === 'mainnet' || net === 'replay' ? net : 'testnet';
}

/**
 * What the fake Windows screen shows, as in the design mockups: `?state=loading|empty|error`.
 * Anything else is the full list. The real engine ignores it: its states come from its data.
 */
export function pickFakeScenario(search: string): Scenario {
  const state = new URLSearchParams(search).get('state');
  return state === 'loading' || state === 'empty' || state === 'error' ? state : 'normal';
}

/** `?drift=off` freezes the fake funding rates, for a still picture (screenshots). */
export function pickFakeDrift(search: string): boolean {
  return new URLSearchParams(search).get('drift') !== 'off';
}
