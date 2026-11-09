// The owner's unlock on the public live view (docs/deploy-live-view.md, "Owner writes"). Visitors read; the owner pastes
// the owner token once and the page can then enter and close through the same host. The token:
//   - lives in sessionStorage (`gimbal.owner.token`) only: it dies with the tab, and is never written to localStorage,
//     a cookie, the page address, the history or a log line;
//   - goes in one header, `x-gimbal-owner`, on the owner's requests only (GET /owner to check it, POST /rotate and
//     POST /close), never on a read;
//   - is checked before it is kept: GET /owner answers 204 when the engine takes it, and writes nothing.
// "Lock" forgets it. Pure apart from the storage and `fetch` it is handed, so the rules are tested without a browser.
import { browserStores, type KeyStore, type Parsed } from './settings.ts';

export const OWNER_KEY = 'gimbal.owner.token';
/** The engine's view and the live host read the owner token from this header (engine/src/view/view-server.ts). */
export const OWNER_HEADER = 'x-gimbal-owner';
export const OWNER_TOKEN_MIN = 32;
const OWNER_TOKEN_MAX = 512;

/** The tab's storage, or null where there is none (a private window, blocked site data). Never localStorage. */
export const ownerStore = (): KeyStore | null => browserStores().session;

export function readOwnerToken(store: KeyStore | null): string | null {
  try {
    const value = store?.getItem(OWNER_KEY) ?? null;
    return value !== null && parseOwnerToken(value).ok ? value : null;
  } catch {
    return null;
  }
}

function writeOwnerToken(store: KeyStore | null, value: string | null): void {
  try {
    if (value === null) store?.removeItem(OWNER_KEY);
    else store?.setItem(OWNER_KEY, value);
  } catch {
    // Nothing to keep it in: the unlock lasts until the page reloads.
  }
}

/** Forgets the owner token in this tab ("Lock"). */
export function forgetOwnerToken(store: KeyStore | null): void {
  writeOwnerToken(store, null);
}

/** What was pasted, trimmed, or why it cannot be an owner token. The value is never quoted back. */
export function parseOwnerToken(text: string): Parsed {
  const value = text.trim();
  if (value === '') return { ok: false, reason: 'Paste the owner token.' };
  if (/\s/.test(value)) return { ok: false, reason: 'The owner token has no spaces in it.' };
  if (value.length < OWNER_TOKEN_MIN) return { ok: false, reason: `The owner token is at least ${OWNER_TOKEN_MIN} characters.` };
  if (value.length > OWNER_TOKEN_MAX || !/^[\x21-\x7e]+$/.test(value)) return { ok: false, reason: 'That is not an owner token.' };
  return { ok: true, value };
}

export type OwnerCheck = { ok: true } | { ok: false; reason: string };

/** How long the check waits for the site. */
export const OWNER_CHECK_MS = 10_000;

/** What GET /owner answered, in the page's words. */
export function ownerAnswer(status: number, body: unknown, retryAfter: string | null): OwnerCheck {
  if (status === 204 || status === 200) return { ok: true };
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (status === 403 && error === 'owner') return { ok: false, reason: 'The engine did not accept this owner token.' };
  if (status === 403 && error === 'owner-off') return { ok: false, reason: 'Owner writes are off on the live engine. Nothing can be unlocked.' };
  if (status === 404 || (status === 403 && error === 'read-only')) {
    return { ok: false, reason: 'Owner writes are off on this site. Nothing can be unlocked.' };
  }
  if (status === 403) return { ok: false, reason: 'The site refused the check. Open the site’s own address and try again.' };
  if (status === 429) {
    const s = Number(retryAfter);
    const minutes = Number.isFinite(s) && s > 0 ? Math.ceil(s / 60) : null;
    return { ok: false, reason: `Too many tries. Owner requests are refused for a while${minutes === null ? '' : ` (about ${minutes} min)`}; try again later.` };
  }
  if (status === 502 || status === 503) return { ok: false, reason: 'The live engine is not answering. Try again in a minute.' };
  return { ok: false, reason: `The site answered ${status}. Nothing was unlocked.` };
}

export interface OwnerDeps {
  fetch?: typeof fetch;
  /** Where a token that passed the check is kept: the tab's sessionStorage. */
  session: KeyStore | null;
}

/** Checks the pasted token with GET /owner (it writes nothing) and keeps it in this tab when the engine takes it. */
export async function unlockOwner(text: string, deps: OwnerDeps): Promise<OwnerCheck> {
  const parsed = parseOwnerToken(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  let answer: OwnerCheck;
  try {
    const r = await doFetch('/owner', {
      headers: { accept: 'application/json', [OWNER_HEADER]: parsed.value },
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(OWNER_CHECK_MS),
    });
    const body: unknown = r.status === 204 ? null : await r.json().catch(() => null);
    answer = ownerAnswer(r.status, body, r.headers.get('retry-after'));
  } catch {
    return { ok: false, reason: 'This page could not reach the site. Nothing was unlocked.' };
  }
  if (answer.ok) writeOwnerToken(deps.session, parsed.value);
  return answer;
}

let current: string | null | undefined;

/** The owner token of this tab, read once at load (an unlock or a lock reloads the page); null = locked. */
export function ownerToken(): string | null {
  if (current === undefined) current = readOwnerToken(ownerStore());
  return current;
}

/** For tests: replaces what the page read (undefined: read the storage again). */
export function setOwnerTokenForTests(token: string | null | undefined): void {
  current = token;
}
