// Remote mode is read-only: the engine's view answers GET only, so every control that would write is left out of the
// page rather than shown and refused. Which mode the page is in is settled once, when it loads: changing the address
// or the token reloads the page, so nothing has to react to a switch.
import { ownerToken } from './owner.ts';
import { browserStores, readSettings, type RemoteSettings } from './settings.ts';

let current: RemoteSettings | undefined;
let hostedLiveForTests: boolean | undefined;

/**
 * The public live view's build (docs/deploy-live-view.md): engine/src/cli/live-host.ts builds the page with
 * VITE_HOSTED_LIVE=1. The page then reads the live desk from its own origin, through the host, read-only, with no
 * Settings step. Every other build leaves it unset. Under `node --test` there is no Vite env at all.
 */
export const hostedLiveFlag = (env: Readonly<Record<string, unknown>> | undefined): boolean => env?.VITE_HOSTED_LIVE === '1';

/**
 * One Vite variable, read by its full name (`import.meta.env.VITE_X`), so the build inlines that value alone and not
 * the whole env object. Under `node --test` `import.meta.env` is undefined and the read throws: no value.
 */
const viteValue = (read: () => unknown): unknown => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

export const isHostedLive = (): boolean => hostedLiveForTests ?? hostedLiveFlag({ VITE_HOSTED_LIVE: viteValue(() => import.meta.env.VITE_HOSTED_LIVE) });

/** For tests: makes the page the hosted-live build, or not (undefined: back to the build's own flag). */
export function setHostedLiveForTests(on: boolean | undefined): void {
  hostedLiveForTests = on;
}

/**
 * The page's settings, read once from the browser's storages. The hosted-live build reads its own origin only: an
 * address a visitor once saved in Settings is not used there.
 */
export function remoteSettings(): RemoteSettings {
  current ??= isHostedLive() ? { base: null, token: null } : readSettings(browserStores());
  return current;
}

/** For tests: replaces what the page settled on. */
export function setRemoteSettingsForTests(settings: RemoteSettings | undefined): void {
  current = settings;
}

/** An address is set in Settings: the page reads a remote engine's view with a token the visitor entered. */
export const isRemote = (): boolean => remoteSettings().base !== null;

/** The page writes nothing: a remote engine's view, or the public live view. Both show the engine's masked ids. */
export const isReadOnly = (): boolean => isRemote() || isHostedLive();

/** What the page draws that writes to the engine or to the owner's wallet. `false` = left out. */
export interface WriteControls {
  /** Close position (`POST /close`), on the Desk and in the status line. */
  close: boolean;
  /** Rotate to this window (`POST /rotate`). */
  rotate: boolean;
  /**
   * Enter this window as an owner demo entry (`POST /rotate` with `demo`, from flat): the public live view's owner,
   * unlocked in this tab, only.
   */
  enter: boolean;
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

export const isHostedReplay = (): boolean => hostedReplayFlag({ VITE_HOSTED_REPLAY: viteValue(() => import.meta.env.VITE_HOSTED_REPLAY) });

/**
 * Remote and the public live view: nothing writes, unless the live view's owner unlocked this tab. Hosted replay: a public page whose server refuses every write but
 * `POST /stress`, so only the stress test is drawn. Otherwise everything, as before.
 */
export const writeControlsFor = (readOnly: boolean, hosted = false, ownerUnlocked = false): WriteControls => {
  // The public live view with the owner token in this tab: close and the owner's entry (a demo entry, from flat, at
  // most OWNER_MAX_LOSS_USD) go through the host to the engine's own routes. Not rotate: a plain POST /rotate closes
  // the held pair and opens another with no loss cap. Nothing else (no stress, no wallet, no set-up, no Auto or pause).
  if (ownerUnlocked) return { close: true, rotate: false, enter: true, stress: false, owner: false, money: false, onboarding: false };
  const on = !readOnly && !hosted;
  return { close: on, rotate: on, enter: false, stress: !readOnly, owner: on, money: on, onboarding: on };
};

/** The public live view, unlocked with the owner token in this tab (remote/owner.ts). */
export const isOwnerUnlocked = (): boolean => isHostedLive() && ownerToken() !== null;

export const writeControls = (): WriteControls => writeControlsFor(isReadOnly(), isHostedReplay(), isOwnerUnlocked());

export const READ_ONLY_LINE = 'Read-only view';
export const READ_ONLY_TEXT = 'Read-only view. This page shows the desk and cannot change anything on it.';
export const HOSTED_LINE = 'Public replay: read-only. Run it yourself with npm run demo.';

/**
 * The public live view's line, from the network the engine itself reports (GET /state `mode`), so live data is never
 * called a replay and a replay is never called live. Null: the engine has not said yet. Visitors cannot change
 * anything; `unlocked`: the owner unlocked this tab with the owner token (remote/owner.ts), and the line says so.
 * `ownerWrites`: the host has owner writes on (its /healthz); off, the line is exactly as it was before owner writes.
 */
export function hostedLiveLine(mode: 'mainnet' | 'testnet' | 'replay' | null, unlocked = false, ownerWrites = false): string {
  if (unlocked) {
    const what = mode === 'mainnet' ? 'Live mainnet desk' : mode === 'testnet' ? 'Live testnet desk, test money' : mode === 'replay' ? 'Replay, not the live desk' : 'Waiting for the engine';
    return `${what}. Owner unlocked in this tab: you can enter and close; the contract checks every order.`;
  }
  switch (mode) {
    case 'mainnet':
      return ownerWrites
        ? 'Live mainnet desk, read-only for visitors: the real desk as it trades now. Nothing a visitor does here can change it. For the recorded replay, run npm run demo.'
        : 'Live mainnet desk, read-only: the real desk as it trades now. Nothing on this page can change it. For the recorded replay, run npm run demo.';
    case 'testnet':
      return ownerWrites
        ? 'Live testnet desk, read-only for visitors: test money, not the mainnet desk. Nothing a visitor does here can change it.'
        : 'Live testnet desk, read-only: test money, not the mainnet desk. Nothing on this page can change it.';
    case 'replay':
      return 'Replay, read-only: this engine plays recorded mainnet data back. It is not the live desk.';
    case null:
      return 'Read-only view. Waiting for the engine to answer.';
  }
}
