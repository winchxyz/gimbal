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

export const writeControlsFor = (readOnly: boolean): WriteControls => {
  const on = !readOnly;
  return { close: on, rotate: on, stress: on, owner: on, money: on, onboarding: on };
};

export const writeControls = (): WriteControls => writeControlsFor(isReadOnly());

export const READ_ONLY_LINE = 'Read-only view';
export const READ_ONLY_TEXT = 'Read-only view. This page shows the desk and cannot change anything on it.';
