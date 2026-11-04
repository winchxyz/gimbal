// What the read-only view listener cuts out of everything it serves. Nothing secret is meant to be in the engine's
// state, journal or events, but their free text (journal summaries, setup details, decision reasons, rescue
// failures, window checks) is written from error messages, and client libraries quote URLs and keys in those. A
// viewer is someone outside the container, so every string in a payload goes through this before it is sent:
// - the value of every environment variable whose name says it is a secret (…_KEY, …_SECRET, …_TOKEN, …PRIVATE…),
//   also without its `ed25519:` / `secp256k1:` prefix, a hex key with or without 0x in any case, and each of these
//   URL-encoded or JSON-escaped;
// - the parts of every URL in the environment that can hold an API key (path segments long enough to be one, the
//   query, credentials), the URL itself shown only as its origin (redact.ts rpcLabel);
// - by shape, whatever the environment does not name: NEAR keys (`ed25519:` and 43 or more base58 characters, which
//   takes public keys too), and the value of URL query parameters named like a key (api-key, apikey, key, token,
//   secret, auth, sig, signature).
// Then the accounts are masked to first 4 + "…" + last 4: the owner's and the operator's (OWNER_ACCOUNT_ID,
// OPERATOR_ACCOUNT_ID) wherever they stand as a whole account id (DeskState.owner, paused.by, text, explorer URLs),
// and any 64-hex NEAR implicit account. The contract id and the desk id stay, and so do transaction hashes (0x-prefixed
// on the EVM chains, base58 on NEAR and Solana) and their links: they are the proof.

import { rpcLabel } from '../redact.ts';

/** A variable named like this holds a secret: its whole value is cut wherever it appears. */
const SECRET_NAME = /(^|_)(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|MNEMONIC|SEED)$|PRIVATE/i;
/** Shorter values are not cut by name: "1" or "true" would cut every digit or word out of the payload. */
const MIN_SECRET_LENGTH = 8;
/** A URL path segment at least this long may be an API key (…/v2/<key>); shorter ones are words such as "mainnet". */
const MIN_PATH_KEY_LENGTH = 16;
/** A query value (or a URL's user name or password) at least this long is cut. */
const MIN_QUERY_VALUE_LENGTH = 6;
const CUT = '…';
const KEY_PREFIX = /^(ed25519|secp256k1):/i;
const HEX_KEY = /^(0x)?([0-9a-f]{64})$/i;
/** `ed25519:` and 43+ base58 characters: a NEAR secret key (about 88) or its 32-byte seed or public key (43-44). */
const NEAR_KEY = /ed25519:[1-9A-HJ-NP-Za-km-z]{43,}/g;
const KEY_QUERY = /([?&](?:api[-_]?key|apikey|access[-_]?token|token|key|secret|auth|sig|signature)=)[^&#\s"'<>]+/gi;
/** A NEAR implicit account: 64 lowercase hex, not part of a longer word (so not a 0x… EVM hash). */
const IMPLICIT_ACCOUNT = /(?<![0-9A-Za-z])[0-9a-f]{64}(?![0-9A-Za-z])/g;
/** Variables naming the accounts that are masked (never the contract's own id). */
const ACCOUNT_VARS = ['OWNER_ACCOUNT_ID', 'OPERATOR_ACCOUNT_ID'];

export type Redactor = <T>(value: T) => T;

interface Cut {
  re: RegExp;
  instead: string | ((match: string) => string);
}

/** An account id as the view shows it. */
export function maskAccount(id: string): string {
  return id.length > 9 ? `${id.slice(0, 4)}…${id.slice(-4)}` : CUT;
}

/** Pairs of (text to cut, what to put instead), longest first, from the environment's secret and URL values. */
export function viewSecrets(env: Readonly<Record<string, string | undefined>>): [string, string][] {
  const cuts = new Map<string, string>();
  const add = (secret: string, instead: string) => {
    for (const v of variants(secret)) if (v !== '' && !cuts.has(v)) cuts.set(v, instead);
  };
  for (const [name, raw] of Object.entries(env)) {
    const value = raw?.trim();
    if (value === undefined || value === '') continue;
    if (SECRET_NAME.test(name) && value.length >= MIN_SECRET_LENGTH) {
      add(value, CUT);
      const bare = value.replace(KEY_PREFIX, '');
      if (bare !== value && bare.length >= 32) add(bare, CUT);
    }
    for (const [secret, instead] of urlSecrets(value)) add(secret, instead);
  }
  return [...cuts.entries()].sort((a, b) => b[0].length - a[0].length);
}

/** The text itself, URL-encoded, and JSON-escaped (quotes and backslashes, and `/` as `\/`). */
function variants(s: string): string[] {
  const json = JSON.stringify(s).slice(1, -1);
  return [...new Set([s, encodeURIComponent(s), encodeURI(s), json, json.replaceAll('/', '\\/')])];
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every cut, in the order it runs: literal secrets, hex keys in any case, key shapes, then the account masks. */
export function viewCuts(env: Readonly<Record<string, string | undefined>>): Cut[] {
  const cuts: Cut[] = viewSecrets(env).map(([s, instead]) => ({ re: new RegExp(escapeRe(s), 'g'), instead }));
  for (const [name, raw] of Object.entries(env)) {
    const m = HEX_KEY.exec(raw?.trim() ?? '');
    if (m !== null && SECRET_NAME.test(name)) cuts.push({ re: new RegExp(`(?:0x)?${m[2]}`, 'gi'), instead: CUT });
  }
  cuts.push({ re: NEAR_KEY, instead: `ed25519:${CUT}` }, { re: KEY_QUERY, instead: (m) => `${m.slice(0, m.indexOf('=') + 1)}${CUT}` });
  const contract = env.GIMBAL_CONTRACT_ID?.trim();
  for (const name of ACCOUNT_VARS) {
    const id = env[name]?.trim();
    if (id === undefined || id === '' || id === contract) continue;
    // Only as a whole account id: "desk.<owner>" (a sub-account, such as the contract) is another account and stays.
    cuts.push({ re: new RegExp(`(?<![A-Za-z0-9_.-])${escapeRe(id)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, 'g'), instead: maskAccount(id) });
  }
  cuts.push({ re: IMPLICIT_ACCOUNT, instead: maskAccount });
  return cuts;
}

/** One string, cut. */
export function redactText(text: string, cuts: readonly Cut[]): string {
  let out = text;
  for (const { re, instead } of cuts) {
    re.lastIndex = 0;
    out = typeof instead === 'string' ? out.replace(re, () => instead) : out.replace(re, instead);
  }
  return out;
}

/**
 * A redactor over the environment as it is now: a copy of any JSON value with every string in it cut (object keys
 * are field names and stay). Numbers, booleans and null pass as they are.
 */
export function viewRedactor(env: Readonly<Record<string, string | undefined>>): Redactor {
  const cuts = viewCuts(env);
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactText(value, cuts);
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
