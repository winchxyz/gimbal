// What the read-only view listener cuts out of everything it serves. Nothing secret is meant to be in the engine's
// state, journal or events, but their free text (journal summaries, setup details, decision reasons, rescue
// failures, window checks) is written from error messages, and client libraries quote URLs and keys in those. A
// viewer is someone outside the container, so every string in a payload goes through this before it is sent:
// - the value of every environment variable whose name says it is a secret (…_KEY, …_SECRET, …_TOKEN, …PRIVATE…);
// - the parts of every URL in the environment that can hold an API key (path segments long enough to be one, the
//   query, credentials), the URL itself shown only as its origin (redact.ts rpcLabel);
// - by shape, whatever the environment does not name: NEAR ed25519 secret keys, and the value of URL query
//   parameters named like a key (api-key, apikey, key, token, secret, auth, sig, signature).

import { rpcLabel } from '../redact.ts';

/** A variable named like this holds a secret: its whole value is cut wherever it appears. */
const SECRET_NAME = /(^|_)(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|MNEMONIC|SEED)$|PRIVATE/i;
/** Shorter values are not cut by name: "1" or "true" would cut every digit or word out of the payload. */
const MIN_SECRET_LENGTH = 8;
/** A URL path segment at least this long may be an API key (…/v2/<key>); shorter ones are words such as "mainnet". */
const MIN_PATH_KEY_LENGTH = 16;
/** A query value at least this long is cut. */
const MIN_QUERY_VALUE_LENGTH = 6;
const CUT = '…';
/** A NEAR ed25519 secret key is 64 bytes (about 88 base58 characters); a public key is 32 (about 44). */
const NEAR_SECRET_KEY = /ed25519:[1-9A-HJ-NP-Za-km-z]{70,}/g;
const KEY_QUERY = /([?&](?:api[-_]?key|apikey|access[-_]?token|token|key|secret|auth|sig|signature)=)[^&#\s"'<>]+/gi;

export type Redactor = <T>(value: T) => T;

/** Pairs of (text to cut, what to put instead), longest first, from the environment. */
export function viewSecrets(env: Readonly<Record<string, string | undefined>>): [string, string][] {
  const cuts = new Map<string, string>();
  for (const [name, raw] of Object.entries(env)) {
    const value = raw?.trim();
    if (value === undefined || value === '') continue;
    if (SECRET_NAME.test(name) && value.length >= MIN_SECRET_LENGTH) cuts.set(value, CUT);
    for (const [secret, instead] of urlSecrets(value)) if (!cuts.has(secret)) cuts.set(secret, instead);
  }
  return [...cuts.entries()].sort((a, b) => b[0].length - a[0].length);
}

/** What of a URL can hold a key; nothing when the value is not an http(s) or ws(s) URL. */
function urlSecrets(value: string): [string, string][] {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return [];
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return [];
  const label = rpcLabel(value);
  const out: [string, string][] = [];
  const keyed = u.search !== '' || u.username !== '' || u.password !== ''
    || u.pathname.split('/').some((s) => s.length >= MIN_PATH_KEY_LENGTH);
  if (!keyed) return out;
  out.push([value, label], [u.href, label], [u.href.replace(/\/+$/, ''), label]);
  // A short user name ("user") would cut that word everywhere; the whole URL is replaced above either way.
  for (const s of [u.username, u.password]) if (s.length >= MIN_QUERY_VALUE_LENGTH) out.push([s, CUT], [decodeURIComponentSafe(s), CUT]);
  if (u.search !== '') out.push([u.search, CUT], [`${u.pathname}${u.search}`, CUT]);
  for (const v of u.searchParams.values()) if (v.length >= MIN_QUERY_VALUE_LENGTH) out.push([v, CUT]);
  for (const s of u.pathname.split('/')) {
    if (s.length >= MIN_PATH_KEY_LENGTH) out.push([s, CUT], [decodeURIComponentSafe(s), CUT]);
  }
  return out.filter(([s]) => s.length >= 1 && s !== '/');
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** One string, cut. */
export function redactText(text: string, secrets: readonly [string, string][]): string {
  let out = text;
  for (const [secret, instead] of secrets) if (out.includes(secret)) out = out.split(secret).join(instead);
  return out.replace(NEAR_SECRET_KEY, `ed25519:${CUT}`).replace(KEY_QUERY, `$1${CUT}`);
}

/**
 * A redactor over the environment as it is now: a copy of any JSON value with every string in it cut (object keys
 * are field names and stay). Numbers, booleans and null pass as they are.
 */
export function viewRedactor(env: Readonly<Record<string, string | undefined>>): Redactor {
  const secrets = viewSecrets(env);
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactText(value, secrets);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return <T>(value: T) => walk(value) as T;
}
