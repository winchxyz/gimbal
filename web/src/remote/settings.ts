// Where the dashboard reads the engine from: this machine (the dev proxy, as always) or a remote engine's read-only
// view (engine/src/view/). Two values choose it, and they live in different places on purpose:
//   the address  localStorage    (`gimbal.view.base`)   not a secret; kept so the next visit knows where to look
//   the token    sessionStorage  (`gimbal.view.token`)  a secret; it dies with the tab and is never written anywhere else
// Neither is ever read from or written to the page address, the history, a cookie or a log line. Pure apart from the
// storages it is handed, so the rules are tested without a browser.

export const TOKEN_KEY = 'gimbal.view.token';
export const BASE_KEY = 'gimbal.view.base';

/** The part of `Storage` used here. */
export type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface Stores {
  /** Where the token lives. */
  session: KeyStore | null;
  /** Where the address lives. */
  local: KeyStore | null;
}

export interface RemoteSettings {
  /** The engine's view address, `https://host` with no trailing slash; null = the local engine. */
  base: string | null;
  /** The view token; null = not entered in this tab. */
  token: string | null;
}

/** The browser's storages. Either can be missing or throw (a private window, blocked site data): then it is null. */
export function browserStores(): Stores {
  const pick = (name: 'sessionStorage' | 'localStorage'): KeyStore | null => {
    try {
      return window[name];
    } catch {
      return null;
    }
  };
  return { session: pick('sessionStorage'), local: pick('localStorage') };
}

function read(store: KeyStore | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: KeyStore | null, key: string, value: string | null): void {
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    // Nothing to keep it in: the page works for this visit and asks again the next.
  }
}

const isLoopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

export type Parsed = { ok: true; value: string } | { ok: false; reason: string };

/**
 * The address as typed -> `https://host[:port]`. Only the origin is kept: a path, a query or a fragment is refused
 * (a token pasted after `?` must not be kept as part of an address). Plain `http` is for this machine only: the token
 * would cross the network in the clear.
 */
export function parseBase(raw: string): Parsed {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'Enter the engine address.' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'That is not an address. Use the form https://host.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'The address has to start with https://.' };
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) return { ok: false, reason: 'Use https://. The token would travel unprotected over http.' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'Leave the user name and password out of the address.' };
  if (url.search !== '' || url.hash !== '' || url.pathname.replace(/\/+$/, '') !== '') {
    return { ok: false, reason: 'Enter the address only, like https://host, with no path.' };
  }
  return { ok: true, value: url.origin };
}

/** The token as typed: printable ASCII with no spaces, which is what a header can carry and the engine accepts. */
export function parseToken(raw: string): Parsed {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'Enter the view token.' };
  if (!/^[\x21-\x7e]{1,512}$/.test(text)) return { ok: false, reason: 'A view token has no spaces and no special characters.' };
  return { ok: true, value: text };
}

export function readSettings(stores: Stores): RemoteSettings {
  const base = parseBase(read(stores.local, BASE_KEY) ?? '');
  const token = parseToken(read(stores.session, TOKEN_KEY) ?? '');
  return { base: base.ok ? base.value : null, token: token.ok ? token.value : null };
}

/** Keeps the address in localStorage and the token in sessionStorage; both already checked by the parsers. */
export function saveSettings(stores: Stores, base: string, token: string): void {
  write(stores.local, BASE_KEY, base);
  write(stores.session, TOKEN_KEY, token);
}

/** Forget: the token goes; the address stays, so the next token is one field. */
export function forgetToken(stores: Stores): void {
  write(stores.session, TOKEN_KEY, null);
}

/** Back to the local engine: the address and the token both go. */
export function switchToLocal(stores: Stores): void {
  write(stores.local, BASE_KEY, null);
  write(stores.session, TOKEN_KEY, null);
}
