// Remote mode is read-only: the engine's view answers GET only, so every control that would write is left out of the
// page rather than shown and refused. Which mode the page is in is settled once, when it loads: changing the address
// or the token reloads the page, so nothing has to react to a switch.
import { browserStores, readSettings, type RemoteSettings } from './settings.ts';

let current: RemoteSettings | undefined;

/** The page's settings, read once from the browser's storages. */
export function remoteSettings(): RemoteSettings {
  current ??= readSettings(browserStores());
  return current;
}

/** For tests: replaces what the page settled on. */
export function setRemoteSettingsForTests(settings: RemoteSettings | undefined): void {
  current = settings;
}

/** An address is set: the page reads a remote engine's view and writes nothing. */
export const isReadOnly = (): boolean => remoteSettings().base !== null;

/** What the page draws that writes to the engine or to the owner's wallet. `false` = left out. */
export interface WriteControls {
  /** Close position (`POST /close`), on the Desk and in the status line. */
  close: boolean;
  /** Rotate to this window (`POST /rotate`). */
  rotate: boolean;
  /** Run a stress test (`POST /stress`). */
  stress: boolean;
  /** Auto, pause, resume, add margin: the owner's buttons in the status line. */
  owner: boolean;
  /** Add funds, Withdraw, Connect wallet, Exit replay. */
  money: boolean;
  /** The set-up flow (`POST /policy/draft`, `PUT /strategy`, `POST /setup`). */
  onboarding: boolean;
}

/**
 * The hosted replay's build (docs/deploy-replay.md): Dockerfile.replay builds the page with VITE_HOSTED_REPLAY=1. Every
 * other build (`npm run demo`, the live dashboard) leaves it unset. Under `node --test` there is no Vite env at all.
 */
export const hostedReplayFlag = (env: Readonly<Record<string, unknown>> | undefined): boolean => env?.VITE_HOSTED_REPLAY === '1';

export const isHostedReplay = (): boolean => hostedReplayFlag(import.meta.env);

/**
 * Remote: nothing writes. Hosted replay: a public page whose server refuses every write but `POST /stress`, so only the
 * stress test is drawn. Otherwise everything, as before.
 */
export const writeControlsFor = (readOnly: boolean, hosted = false): WriteControls => {
  const on = !readOnly && !hosted;
  return { close: on, rotate: on, stress: !readOnly, owner: on, money: on, onboarding: on };
};

export const writeControls = (): WriteControls => writeControlsFor(isReadOnly(), isHostedReplay());

export const READ_ONLY_LINE = 'Read-only view';
export const READ_ONLY_TEXT = 'Read-only view. This page shows the desk and cannot change anything on it.';
export const HOSTED_LINE = 'Public replay: read-only. Run it yourself with npm run demo.';
