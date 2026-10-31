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

/**
 * What the fake Desk screen shows (fake-desk.ts has the data). Here, and not next to the data, so a production
 * build that never loads the fake can still read the address.
 * - level, watch, rescuing: the desk's `health`.
 * - needs: a rescue failed and only the owner can act.
 * - paused: the owner paused the desk.
 * - waiting: no legs.
 * - down: a venue does not answer.
 * - unpriced: a leg was opened without a price band.
 * - unbalanced: the legs differ in size.
 * - loading: no desk event is sent.
 */
export const DESK_SCENARIOS = [
  'level',
  'watch',
  'rescuing',
  'needs',
  'paused',
  'waiting',
  'down',
  'unpriced',
  'unbalanced',
  'loading',
] as const;
export type DeskScenario = (typeof DESK_SCENARIOS)[number];

/** `?state=` covers every screen in the mockups: loading has no desk yet, empty has no position, error has a venue down. */
export function deskFor(scenario: Scenario): DeskScenario {
  return scenario === 'loading' ? 'loading' : scenario === 'empty' ? 'waiting' : scenario === 'error' ? 'down' : 'level';
}

/** `?desk=` picks one of the above; without it the desk follows `?state=`. */
export function pickFakeDesk(search: string, scenario: Scenario): DeskScenario {
  const desk = new URLSearchParams(search).get('desk');
  return DESK_SCENARIOS.find((s) => s === desk) ?? deskFor(scenario);
}

/** `?drift=off` freezes the fake funding rates and marks, for a still picture (screenshots). */
export function pickFakeDrift(search: string): boolean {
  return new URLSearchParams(search).get('drift') !== 'off';
}
