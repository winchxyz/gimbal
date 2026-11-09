// The public live view's parts (live-host.ts runs them), kept apart so they are tested without a live engine:
//   liveConfigFromEnv()   GIMBAL_LIVE_URL (the live engine's read-only view) and GIMBAL_VIEW_TOKEN, or why the host
//                         has no live engine (it then serves the page with a "not configured" state);
//   liveRoute()           what the public port answers: an allowlist of the reads the dashboard needs; every write is
//                         refused here and never forwarded; any other API path is 404;
//   publicState() & co.   what the public sees of the engine's payloads: a field allowlist per shared type (a field
//                         the page does not read is not published), then the host's cut on every string (IPs, e-mail
//                         addresses, local paths, private Railway names, referral codes, its own token and engine
//                         address), on top of the engine's own redaction (engine/src/view/view-redact.ts);
//   LiveUpstream          the host's only link to the live engine: the token is added here, server-side; GETs are
//                         cached (stale kept), shared while in flight, and the reads a page asks for by id are held to
//                         ids the engine has listed, under a budget per client and in all; ONE event stream,
//                         reconnected with backoff and jitter;
//   createLiveHostServer  the public HTTP server: the built dashboard and the reads on one origin, the one upstream
//                         stream fanned out to every visitor, with caps on visitor streams and on unread bytes.
//
// No visitor header reaches the engine: every upstream request is built here from nothing but the path, `accept` and
// the host's own `authorization`. The token is never in a response, a URL or a log line.
//
// Owner writes (opt in: GIMBAL_OWNER_WRITES=1 on the host, ownerWritesFromEnv): a request that carries the owner header
// (`x-gimbal-owner`) for GET /owner, POST /rotate, POST /close or PUT /strategy is forwarded to the engine's view with
// the host's view token and that header passed through unchanged, and nothing else of the visitor's. A write must come
// from this site's own page (its Origin is this site, against CSRF), with a JSON body of at most
// OWNER_MAX_BODY_BYTES; a few a minute per visitor. The engine checks the owner token (and locks out after wrong ones)
// and its routes check everything else. The host never stores, caches or logs the owner token: its log line names the
// method, the path and the status. Without the opt-in, or without the header, every write is refused exactly as before.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type {
  DeskState, EngineState, JournalEntry, Leg, RescueFailure, RescueProgress, ScanStatus, SetupProgress, StrategyConfig, StrategyDecision, TxRef,
  VenueAccount, Window, WindowHistory,
} from '@gimbal/shared';
import { MAX_STREAMS_PER_CLIENT } from './replay-host-lib.ts';
import { OWNER_HEADER, OWNER_MAX_BODY_BYTES } from '../view/view-server.ts';

export { OWNER_HEADER };

export const HEALTH_PATH = '/healthz';

/** What the hosted-live build writes into index.html (web/vite.config.ts, VITE_HOSTED_LIVE=1). */
export const LIVE_BUILD_MARKER = '<meta name="gimbal-build" content="hosted-live">';

export function isLiveBuild(indexHtml: string): boolean {
  return indexHtml.includes(LIVE_BUILD_MARKER);
}

export const LIVE_READ_ONLY_REASON = 'This is the public view of the live mainnet desk, and it is read-only for visitors: they cannot change the rules, '
  + 'enter, rotate, close, pause or stress it. The host refuses every write from a visitor and never forwards one to the engine; '
  + 'only the owner, with the owner token, can unlock entering, closing and the engine rules.';

export const NOT_CONFIGURED_REASON = 'The live engine is not configured on this site: the host has no engine address or view token, so there is no desk to show.';

// ---------- configuration ----------

export interface LiveConfig {
  /** The live engine's view, `https://host[:port]`, no path. */
  base: string;
  token: string;
}

const isLoopbackHost = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/**
 * The live engine's view address and token, or why there is none. The reason names variables only, never a value, so
 * it can be logged and shown on the page.
 */
export function liveConfigFromEnv(env: (name: string) => string | undefined): { config: LiveConfig } | { off: string } {
  const rawBase = env('GIMBAL_LIVE_URL')?.trim() ?? '';
  const token = env('GIMBAL_VIEW_TOKEN')?.trim() ?? '';
  const missing = [rawBase === '' ? 'GIMBAL_LIVE_URL' : null, token === '' ? 'GIMBAL_VIEW_TOKEN' : null].filter((n) => n !== null);
  if (missing.length > 0) return { off: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set` };
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    return { off: 'GIMBAL_LIVE_URL is not an address (https://host)' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    return { off: 'GIMBAL_LIVE_URL must start with https:// (plain http only for this machine): the token would cross the network in the clear' };
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname.replace(/\/+$/, '') !== '') {
    return { off: 'GIMBAL_LIVE_URL must be the engine view\'s address only (https://host), with no path, query or credentials' };
  }
  if (!/^[\x21-\x7e]{1,512}$/.test(token)) return { off: 'GIMBAL_VIEW_TOKEN has whitespace or characters a header cannot carry' };
  return { config: { base: url.origin, token } };
}

/** GIMBAL_OWNER_WRITES=1: the owner's requests (with the owner header) are forwarded; anything else: refused as before. */
export function ownerWritesFromEnv(env: (name: string) => string | undefined): boolean {
  return env('GIMBAL_OWNER_WRITES')?.trim() === '1';
}

/**
 * Whether `origin` (the request's Origin header) is this site's own: the host the request was sent to (its Host
 * header, which the edge passes through), over https (plain http only for this machine). A cross-site page sends its
 * own origin; a missing one is not this site's page.
 */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || host === undefined || host === '') return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.origin !== origin.toLowerCase().replace(/\/$/, '') || u.host !== host.toLowerCase()) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname));
}

// ---------- routes ----------

/** Paths that belong to the engine's API: GET on one that is not a read below is 404, never the page. */
const API_PREFIXES: readonly string[] = [
  '/events', '/state', '/stress', '/policy', '/strategy', '/setup', '/windows', '/journal', '/rotate', '/close', '/pause', '/resume',
  '/view-ticket', '/control',
];
/** A journal or window id: printable ASCII, no spaces. The host encodes it again before it asks the engine. */
const ID = /^[\x21-\x7e]{1,200}$/;

export type LiveRoute =
  | { kind: 'static' }
  | { kind: 'health' }
  | { kind: 'events' }
  /** A read of the engine: `key` is the path and query the host asks for, built here (never the visitor's query). */
  | { kind: 'read'; key: string }
  /** The owner's request, forwarded with the owner header (owner writes on, the header sent). */
  | { kind: 'owner'; method: 'GET' | 'POST' | 'PUT'; path: '/owner' | '/rotate' | '/close' | '/strategy' }
  | { kind: 'refuse'; status: number; body: { ok: false; error: string; reason: string } };

/** What the host may forward for the owner, and nothing else. */
const OWNER_ROUTES: Readonly<Record<string, 'GET' | 'POST' | 'PUT'>> = { '/owner': 'GET', '/rotate': 'POST', '/close': 'POST', '/strategy': 'PUT' };

export interface OwnerAsk {
  /** GIMBAL_OWNER_WRITES=1 on this host. */
  on: boolean;
  /** The request carries the owner header. */
  header: boolean;
}

const refuse = (status: number, error: string, reason: string): LiveRoute => ({ kind: 'refuse', status, body: { ok: false, error, reason } });

export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * What the public port does with `method` `path`?`search`. Only GET and HEAD of the reads the dashboard needs reach the
 * engine; every other method is refused here (POST /rotate, /close, /stress, /pause, PUT /strategy and the rest), and
 * so is every GET of an API path that is not on the list. With owner writes on (`owner.on`) and the owner header
 * sent, GET /owner, POST /rotate, POST /close and PUT /strategy are the owner's (forwarded); nothing else changes.
 */
export function liveRoute(
  method: string, rawPath: string, search: URLSearchParams = new URLSearchParams(), owner: OwnerAsk = { on: false, header: false },
): LiveRoute {
  const path = rawPath.replace(/\/+$/, '') || '/';
  const read = method === 'GET' || method === 'HEAD';
  if (owner.on) {
    const want = OWNER_ROUTES[path];
    if (owner.header && want === method) return { kind: 'owner', method: want, path: path as '/owner' | '/rotate' | '/close' | '/strategy' };
    if (path === '/owner' && method === 'GET') return refuse(403, 'owner', 'GET /owner needs the owner token');
  }
  if (!read) {
    return isApiPath(path) || path === HEALTH_PATH
      ? refuse(403, 'read-only', `${method} ${path} is refused. ${LIVE_READ_ONLY_REASON}`)
      : refuse(405, 'method', `${method} ${path}: this site only serves pages and reads`);
  }
  if (path === HEALTH_PATH) return { kind: 'health' };
  if (path === '/events') return { kind: 'events' };
  if (path === '/state' || path === '/strategy') return { kind: 'read', key: path };
  if (path === '/journal') {
    const before = search.get('before') ?? '';
    if (before === '') return { kind: 'read', key: '/journal' };
    if (!ID.test(before)) return refuse(400, 'bad request', 'GET /journal: before= is not an entry id');
    return { kind: 'read', key: `/journal?before=${encodeURIComponent(before)}` };
  }
  if (path === '/windows/history') {
    const id = search.get('id') ?? '';
    if (!ID.test(id)) return refuse(400, 'bad request', 'GET /windows/history needs ?id=<window id>');
    return { kind: 'read', key: `/windows/history?id=${encodeURIComponent(id)}` };
  }
  if (isApiPath(path)) return refuse(404, 'not found', `GET ${path} is not one of the reads this site serves`);
  return { kind: 'static' };
}

/**
 * The file under `webDir` for a GET of `urlPath`: `/` is index.html, anything else must be a file that exists there.
 * The dashboard routes by the hash, so no other path needs the page. Null: 404.
 */
export function liveStaticFile(webDir: string, urlPath: string): string | null {
  const root = resolve(webDir);
  if (urlPath === '/' || urlPath === '/index.html') return join(root, 'index.html');
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const path = resolve(root, `.${normalize(`/${decoded}`)}`);
  if (!path.startsWith(root + sep)) return null;
  return existsSync(path) && statSync(path).isFile() ? path : null;
}

/** An IP address as a header carries it (brackets and an IPv6 zone allowed), or null for anything else. */
function ipOf(value: string): string | null {
  const v = value.trim().replace(/^\[(.*)\]$/, '$1');
  if (v.length > 64) return null;
  const zone = v.indexOf('%');
  return isIP(zone >= 0 ? v.slice(0, zone) : v) !== 0 ? v : null;
}

/**
 * Who a visitor is, for the stream caps and the read budget: X-Real-IP (which the edge sets) when it is an IP address,
 * else the last X-Forwarded-For entry that is one, else the socket's address; never any other text a visitor sends,
 * so a forged header cannot mint unlimited keys. Then grouped (addressGroup).
 */
export function liveClientKey(req: { headers: IncomingMessage['headers']; socket: { remoteAddress?: string | undefined } }): string {
  const real = req.headers['x-real-ip'];
  const fromReal = typeof real === 'string' ? ipOf(real) : null;
  if (fromReal !== null) return addressGroup(fromReal);
  const xff = req.headers['x-forwarded-for'];
  const list = (typeof xff === 'string' ? xff : Array.isArray(xff) ? xff.join(',') : '').split(',');
  for (let i = list.length - 1; i >= 0; i--) {
    const ip = ipOf(list[i]!);
    if (ip !== null) return addressGroup(ip);
  }
  const socket = req.socket.remoteAddress;
  return socket === undefined ? 'unknown' : addressGroup(socket);
}

/**
 * An address as the caps count it: an IPv6 address as its /64 (one home or phone is given a whole /64, so a visitor
 * cannot open a fresh budget by picking another address in it), an IPv4-mapped address as its IPv4, an IPv4 as is.
 */
export function addressGroup(key: string): string {
  let k = key.trim().replace(/^\[(.*)\]$/, '$1');
  const zone = k.indexOf('%');
  if (zone >= 0) k = k.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(k);
  if (mapped !== null) return mapped[1]!;
  if (!k.includes(':')) return k;
  let canonical: string;
  try {
    const host = new URL(`http://[${k}]/`).hostname;
    canonical = host.slice(1, -1);
  } catch {
    return k;
  }
  const [head = '', tail] = canonical.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).join(':')}::/64`;
}

// ---------- what the public sees ----------

/** A JSON primitive (string, number, boolean, null); anything else in its place is dropped. */
type Shape = 'v' | 'record' | { list: Shape } | { fields: Readonly<Record<string, Shape>> };
const V = 'v' as const;
/** An object of primitives under any keys (the venue health map, a journal entry's numbers). */
const RECORD = 'record' as const;
const list = (of: Shape): Shape => ({ list: of });
const obj = (fields: Readonly<Record<string, Shape>>): Shape => ({ fields });

// One shape per shared type (shared/src/types.ts): `satisfies` keeps each in step with its type, so a field added
// to a type has to be added here (or the build fails) before the public sees it.
const TX = obj({ chain: V, id: V, url: V } satisfies Record<keyof TxRef, Shape>);
const LEG = obj({
  venue: V, symbol: V, side: V, size: V, lotSize: V, entry: V, mark: V, liqPx: V, marginUsd: V, marginRatio: V, distanceToLiqPct: V,
  fundingEarnedUsd: V, unsettledFundingUsd: V, feesUsd: V, feesPositionId: V, unpriced: V,
} satisfies Record<keyof Leg, Shape>);
const ACCOUNT = obj({ venue: V, equityUsd: V, at: V } satisfies Record<keyof VenueAccount, Shape>);
const RESCUE_FAILURE = obj({ rescueId: V, step: V, reason: V, tries: V, next: V, at: V } satisfies Record<keyof RescueFailure, Shape>);
const DESK = obj({
  deskId: V, owner: V, contract: V, mode: V, legs: list(LEG), netDelta: V, equityUsd: V, reserveUsd: V,
  pnl: obj({ fundingUsd: V, feesUsd: V, priceUsd: V, netUsd: V } satisfies Record<keyof DeskState['pnl'], Shape>),
  health: V, paused: obj({ by: V, at: V } satisfies Record<keyof NonNullable<DeskState['paused']>, Shape>), rescueFailure: RESCUE_FAILURE,
  updatedAt: V, accounts: list(ACCOUNT),
} satisfies Record<keyof DeskState, Shape>);
const WINDOW = obj({
  id: V, symbol: V, longVenue: V, shortVenue: V, grossAprPct: V, grossApr7dPct: V,
  costs: obj({ feesPct: V, slippagePct: V, basisPct: V, rescueReservePct: V } satisfies Record<keyof Window['costs'], Shape>),
  netAprPct: V, usdPerDayPer1k: V, breakevenHours: V, depthUsd: V, intervalsAbove: V, updatedAt: V, tradable: V,
  // The NEAR AI risk check's verdict on the window (the shared type's field name).
  veto: obj({ verdict: V, reasons: list(V), model: V, at: V } satisfies Record<keyof NonNullable<Window['veto']>, Shape>),
  refused: obj({ code: V, reason: V } satisfies Record<keyof NonNullable<Window['refused']>, Shape>),
  note: V, held: obj({ since: V } satisfies Record<keyof NonNullable<Window['held']>, Shape>),
  checks: list(obj({ ok: V, text: V } satisfies Record<keyof Window['checks'][number], Shape>)), switchCostUsd: V, stale: V,
} satisfies Record<keyof Window, Shape>);
const SCAN = obj({ venues: V, failed: list(V), at: V } satisfies Record<keyof ScanStatus, Shape>);
const STRATEGY = obj({
  auto: V, minNetAprPct: V, legUsd: V, maxLeverage: V, stopDrawdownPct: V,
  rotate: obj({ minGainPts: V, forHours: V } satisfies Record<keyof StrategyConfig['rotate'], Shape>),
  risk: obj({ watchDistancePct: V, rescueDistancePct: V } satisfies Record<keyof StrategyConfig['risk'], Shape>), enterAfterChecks: V, exitAfterChecks: V,
} satisfies Record<keyof StrategyConfig, Shape>);
const ENTRY = obj({ id: V, t: V, kind: V, summary: V, why: V, numbers: RECORD, tx: list(TX) } satisfies Record<keyof JournalEntry, Shape>);
const RESCUE = obj({
  id: V, from: V, to: V, amountUsd: V, sentUsd: V, step: V, startedAt: V, elapsedS: V, tx: list(TX),
} satisfies Record<keyof RescueProgress, Shape>);
/**
 * The venue set-up without each step's `detail`: those lines name the desk's referral codes, its Orderly IP allow-list,
 * its venue account ids and its key's expiry, the owner's business. The steps, statuses and transactions stay.
 */
const SETUP = obj({
  deskId: V, steps: list(obj({ step: V, status: V, tx: list(TX) } satisfies Record<Exclude<keyof SetupProgress['steps'][number], 'detail'>, Shape>)),
} satisfies Record<keyof SetupProgress, Shape>);
const DECISION = obj({ action: V, reason: V, windowId: V, heldId: V, at: V } satisfies Record<keyof StrategyDecision, Shape>);
const HISTORY = obj({ windowId: V, points: list(obj({ t: V, netAprPct: V })) } satisfies Record<keyof WindowHistory, Shape>);
const STATE = obj({
  mode: V, windows: list(WINDOW), scan: SCAN, strategy: STRATEGY, desk: DESK, journal: list(ENTRY), rescue: RESCUE, setup: SETUP, health: RECORD,
  decision: DECISION, at: V,
} satisfies Record<keyof EngineState, Shape>);
/** The engine's own refusal of a read ({ error }). */
const ERROR = obj({ ok: V, error: V, reason: V });

/** The event types the page reads (shared StreamEvent), each with its data's shape. */
export const EVENT_SHAPES: Readonly<Record<string, Shape>> = {
  windows: list(WINDOW), scan: SCAN, desk: DESK, journal: ENTRY, rescue: RESCUE, setup: SETUP, health: RECORD, decision: DECISION,
};
/** The types whose latest value a new visitor's stream starts with, in the engine's order (view-server.ts). */
export const SNAPSHOT_TYPES = ['scan', 'windows', 'desk', 'health', 'setup', 'rescue', 'decision'] as const;

const isPrimitive = (v: unknown): boolean => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** `value` as `shape` allows, every string through `cut`; undefined when it does not fit (the field is then left out). */
function shaped(value: unknown, shape: Shape, cut: (text: string) => string): unknown {
  if (shape === V) return isPrimitive(value) ? (typeof value === 'string' ? cut(value) : value) : undefined;
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  if (shape === RECORD) {
    if (Array.isArray(value)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (isPrimitive(v)) out[k] = typeof v === 'string' ? cut(v) : v;
    return out;
  }
  if ('list' in shape) {
    if (!Array.isArray(value)) return undefined;
    return value.map((v) => shaped(v, shape.list, cut)).filter((v) => v !== undefined);
  }
  if (Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  const from = value as Record<string, unknown>;
  for (const [k, s] of Object.entries(shape.fields)) {
    if (!Object.hasOwn(from, k)) continue;
    const v = shaped(from[k], s, cut);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const CUT = '…';
const IPV4 = /(?<![\d.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?!\.?\d)/g;
/** A run of hex groups and colons that may be an IPv6 address; isIpv6 decides. */
const IPV6_CANDIDATE = /(?<![0-9A-Za-z:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** A Unix path under a root a container or a home folder uses, not part of a URL (no host or word before the slash). */
const UNIX_PATH = /(?<![\w.:/-])\/(?:app|data|home|root|tmp|var|usr|opt|etc|Users|mnt|srv|workspace|private)\/[^\s"'<>()[\]{},;]*/g;
const WINDOWS_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>]*/g;
const FILE_URL = /file:\/\/[^\s"'<>]+/g;
/** Railway's private network names (`<service>.railway.internal`). */
const RAILWAY_INTERNAL = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.railway\.internal/gi;
/** A referral code where the engine's set-up text names one ("referred by X", "referrer set: X", "referral_code":"X"). */
const REFERRAL_TEXT = /\b(referred by|referrer set:|referral[ _-]code[:=]?)(\s*)([A-Za-z0-9_-]{2,64})/gi;
const REFERRAL_JSON = /("referral_?code"\s*:\s*")[^"]*(")/gi;

/** An IPv6 address, and not a clock time (12:00:00), which has the same shape. */
function isIpv6(text: string): boolean {
  if (/^\d{1,2}(:\d{2}){1,2}$/.test(text)) return false;
  const colons = text.split(':').length - 1;
  if (!text.includes('::') && colons !== 7) return false;
  if (!/[0-9A-Fa-f]/.test(text)) return false;
  try {
    return new URL(`http://[${text}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The host's own cut for one string, on top of the engine's: `literals` (the token, the engine's address) wherever they
 * appear, then the shapes above. Nothing here is expected in the engine's payloads; the engine writes free text from
 * error messages, and the public sees it.
 */
export function publicCutter(literals: readonly string[] = []): (text: string) => string {
  const lits = [...new Set(literals.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length).map((s) => new RegExp(escapeRe(s), 'g'));
  return (text: string): string => {
    let out = text;
    for (const re of lits) out = out.replace(re, CUT);
    out = out.replace(FILE_URL, CUT).replace(WINDOWS_PATH, CUT).replace(UNIX_PATH, CUT).replace(RAILWAY_INTERNAL, CUT);
    out = out.replace(EMAIL, `${CUT}@${CUT}`).replace(IPV4, CUT).replace(IPV6_CANDIDATE, (m) => (isIpv6(m) ? CUT : m));
    out = out.replace(REFERRAL_TEXT, (_m, head: string, gap: string) => `${head}${gap}${CUT}`).replace(REFERRAL_JSON, `$1${CUT}$2`);
    return out;
  };
}

/** The venue set-up as the public sees it (SETUP above). */
export function publicSetup(setup: unknown, cut: (text: string) => string = (s) => s): unknown {
  return shaped(setup, SETUP, cut) ?? null;
}

/** GET /state as the public sees it, or null when it is not an object. */
export function publicState(state: unknown, cut: (text: string) => string): unknown {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return null;
  return shaped(state, STATE, cut) ?? null;
}

/** The body of a read (by its route) as the public sees it; undefined when it does not fit the route's shape. */
export function publicRead(route: string, body: unknown, cut: (text: string) => string): unknown {
  if (route === '/state') return publicState(body, cut) ?? undefined;
  if (route === '/strategy') return shaped(body, STRATEGY, cut);
  if (route === '/journal') return shaped(body, list(ENTRY), cut);
  if (route === '/windows/history') return shaped(body, HISTORY, cut);
  return undefined;
}

/** One stream event as the public sees it, or null for a type the page does not read. */
export function publicEvent(event: unknown, cut: (text: string) => string): { type: string; data: unknown } | null {
  if (event === null || typeof event !== 'object') return null;
  const { type, data } = event as { type?: unknown; data?: unknown };
  if (typeof type !== 'string' || !Object.hasOwn(EVENT_SHAPES, type)) return null;
  const out = shaped(data, EVENT_SHAPES[type]!, cut);
  return out === undefined ? null : { type, data: out };
}

// ---------- the upstream ----------

export interface Answer {
  status: number;
  /** JSON text, already shaped and cut. */
  body: string;
  retryAfterS?: number;
}

export type StreamStatus = 'connecting' | 'connected' | 'down';

export interface UpstreamListener {
  /** One SSE chunk (`data: …\n\n`), already shaped and cut, encoded once for every visitor. */
  event(chunk: Buffer): void;
  /** The upstream stream ended: every visitor stream should end, so each page reconnects and reads /state again. */
  drop(): void;
}

export interface Rate {
  perSecond: number;
  burst: number;
}

export interface LiveUpstreamOptions extends LiveConfig {
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  log?: (line: string) => void;
  /** GET /state, /strategy and the newest journal page are fresh in the cache this long. */
  stateTtlMs?: number;
  /** Older journal pages and window histories: they change slowly. */
  pageTtlMs?: number;
  /** After a failed read the key is not asked again for this long (the last good answer is served meanwhile). */
  errorTtlMs?: number;
  maxCacheBytes?: number;
  /** A larger answer from the engine is refused. */
  maxBodyBytes?: number;
  /**
   * Cache misses on the reads a page asks for by id (window histories, older journal pages), in all and per client: token
   * buckets. The core reads (/state, /strategy, the newest journal page) are outside both: they are one key each,
   * fetched at most once per stateTtlMs, so no crowd can starve them.
   */
  rate?: Rate;
  clientRate?: Rate;
  timeoutMs?: number;
  /** The wait before the stream is opened again, after `attempt` failures in a row (0 = the first); jitter is added. */
  backoff?: (attempt: number) => number;
  /** No byte from the engine's stream for this long (it pings every 15 s): the stream is taken as dead. */
  idleMs?: number;
  /** After the engine refuses the host's token (401) or origin (403), nothing is asked for this long. */
  refusedPauseMs?: number;
  /**
   * A core read's last good answer is served stale for at most this long after it was read; past it, a failure is
   * answered as one (503), so the page says the engine is not answering instead of showing an old desk as current.
   */
  maxStaleMs?: number;
}

export const STATE_TTL_MS = 3_000;
export const PAGE_TTL_MS = 30_000;
export const ERROR_TTL_MS = 2_000;
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** One SSE event larger than this ends the stream: the engine never sends one near it. */
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
/** Room for a cold page's window histories (one per tradable window) and some paging, then a few a second. */
export const UPSTREAM_RATE: Rate = { perSecond: 5, burst: 120 };
export const CLIENT_RATE: Rate = { perSecond: 1, burst: 80 };
/** Clients whose read budget is remembered; past this the oldest is forgotten. */
const MAX_CLIENTS = 10_000;
/** Journal ids the host has seen (in /state, in events, in pages); `before=` must be one of them. */
const MAX_JOURNAL_IDS = 20_000;
export const REFUSED_PAUSE_MS = 60_000;
/** Longer than an engine redeploy takes, so a deploy never blanks the page; short enough that an outage shows. */
export const MAX_STALE_MS = 5 * 60_000;
const LOG_EVERY_MS = 60_000;
const CORE_KEYS: ReadonlySet<string> = new Set(['/state', '/strategy', '/journal']);

/** 1 s, 2 s, 4 s ... up to 30 s. */
export function upstreamBackoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

class Bucket {
  readonly rate: Rate;
  #tokens: number;
  #at: number;
  constructor(rate: Rate, now: number) {
    this.rate = rate;
    this.#tokens = rate.burst;
    this.#at = now;
  }

  #refill(now: number): void {
    this.#tokens = Math.min(this.rate.burst, this.#tokens + ((now - this.#at) / 1000) * this.rate.perSecond);
    this.#at = now;
  }

  has(now: number): boolean {
    this.#refill(now);
    return this.#tokens >= 1;
  }

  take(): void {
    this.#tokens -= 1;
  }
}

interface Entry {
  /** The last 200 (or the engine's own 400 or 404) for this key; never replaced by a failure. */
  good: Answer | null;
  /** The invalidation count when `good` was asked for: an answer asked for earlier never replaces it. */
  goodGen: number;
  /** When `good` was read. */
  goodAt: number;
  freshUntil: number;
  /** The last failure, served only while there is no good answer, until retryAt. */
  failed: Answer | null;
  retryAt: number;
  bytes: number;
}

const json = (status: number, body: unknown, retryAfterS?: number): Answer => ({ status, body: JSON.stringify(body), ...(retryAfterS === undefined ? {} : { retryAfterS }) });

const NO_HISTORY = { error: 'no history for that window: the last scan did not list it' };

export const NOT_ANSWERING ='The live engine is not answering right now. This page tries again by itself.';
const BUSY = (): Answer => json(503, { ok: false, error: 'busy', reason: 'Too many requests reach the live engine right now; try again in a few seconds.' }, 2);

/**
 * The host's one link to the live engine's read-only view. Reads are cached per path and query (a stale answer is kept
 * and served whenever a fresh one cannot be had), one request per key at a time however many visitors ask. The event
 * stream is one connection, opened at start(), reconnected with backoff.
 */
export class LiveUpstream {
  readonly #o: LiveUpstreamOptions;
  readonly #cut: (text: string) => string;
  readonly #cache = new Map<string, Entry>();
  readonly #inflight = new Map<string, { gen: number; p: Promise<Answer> }>();
  /** Bumped by an invalidation: a fetch that started before it is not stored as fresh. */
  readonly #gen = new Map<string, number>();
  readonly #listeners = new Set<UpstreamListener>();
  readonly #latest = new Map<string, Buffer>();
  readonly #logged = new Map<string, { at: number; skipped: number }>();
  readonly #clients = new Map<string, Bucket>();
  readonly #budget: Bucket;
  /** Window ids of the engine's latest list (stream or /state); a history of another id is 404 at the host. */
  #windowIds: ReadonlySet<string> | null = null;
  readonly #journalIds = new Set<string>();
  /** Windows events seen: a /state asked for before the latest one does not set the window list back. */
  #windowsEvents = 0;
  #cacheBytes = 0;
  #refusedUntil = 0;
  #status: StreamStatus = 'connecting';
  #stopped = true;
  #abort: AbortController | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #failures = 0;
  /** Upstream GETs sent, and event streams opened: for tests and the health line. */
  readonly counts = { requests: 0, streams: 0 };

  constructor(options: LiveUpstreamOptions) {
    this.#o = options;
    this.#cut = publicCutter([options.token, options.base, new URL(options.base).host]);
    this.#budget = new Bucket(options.rate ?? UPSTREAM_RATE, this.#now());
  }

  get status(): StreamStatus {
    return this.#status;
  }

  /** The cut the host applies to every string it serves. */
  get cut(): (text: string) => string {
    return this.#cut;
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  #fetch(): typeof fetch {
    return this.#o.fetch ?? fetch;
  }

  /** A log line, with the token cut should any text ever quote it. */
  #log(line: string): void {
    this.#o.log?.(line.split(this.#o.token).join(CUT));
  }

  /** At most one line a minute per kind; the ones left out are counted on the next. */
  #logEvery(kind: string, line: string): void {
    const now = this.#now();
    const last = this.#logged.get(kind);
    if (last !== undefined && now - last.at < LOG_EVERY_MS) {
      last.skipped++;
      return;
    }
    const more = last === undefined || last.skipped === 0 ? '' : ` (and ${last.skipped} more like it since the last line)`;
    this.#logged.set(kind, { at: now, skipped: 0 });
    this.#log(`${line}${more}`);
  }

  #headers(accept: string): Record<string, string> {
    // Built from nothing: no visitor header (cookie, authorization, origin, forwarded-for) is ever copied in.
    return { accept, authorization: `Bearer ${this.#o.token}` };
  }

  #clientBucket(client: string): Bucket {
    let b = this.#clients.get(client);
    if (b === undefined) {
      b = new Bucket(this.#o.clientRate ?? CLIENT_RATE, this.#now());
      if (this.#clients.size >= MAX_CLIENTS) this.#clients.delete(this.#clients.keys().next().value!);
    } else {
      this.#clients.delete(client);
    }
    this.#clients.set(client, b);
    return b;
  }

  #ttl(key: string): number {
    return CORE_KEYS.has(key) ? (this.#o.stateTtlMs ?? STATE_TTL_MS) : (this.#o.pageTtlMs ?? PAGE_TTL_MS);
  }

  #store(key: string, answer: Answer, gen: number): void {
    const now = this.#now();
    const e = this.#cache.get(key) ?? { good: null, goodGen: -1, goodAt: 0, freshUntil: 0, failed: null, retryAt: 0, bytes: 0 };
    const good = answer.status === 200 || answer.status === 400 || answer.status === 404;
    // Two fetches of one key overlap only across an invalidation; the older one, landing last, changes nothing.
    if (good && e.good !== null && gen < e.goodGen) return;
    this.#cache.delete(key);
    this.#cacheBytes -= e.bytes;
    if (good) {
      e.good = answer;
      e.goodGen = gen;
      e.goodAt = now;
      // A fetch that started before an invalidation is kept, but as stale: what it read may predate the change.
      e.freshUntil = gen === (this.#gen.get(key) ?? 0) ? now + this.#ttl(key) : 0;
      e.failed = null;
      e.retryAt = 0;
    } else {
      // A failure never replaces the last good answer.
      e.failed = answer;
      e.retryAt = now + (this.#o.errorTtlMs ?? ERROR_TTL_MS);
    }
    e.bytes = (e.good?.body.length ?? 0) + (e.failed?.body.length ?? 0) + key.length;
    const max = this.#o.maxCacheBytes ?? MAX_CACHE_BYTES;
    if (e.bytes > max) return;
    while (this.#cacheBytes + e.bytes > max && this.#cache.size > 0) {
      const [oldest, entry] = this.#cache.entries().next().value!;
      this.#cacheBytes -= entry.bytes;
      this.#cache.delete(oldest);
    }
    this.#cache.set(key, e);
    this.#cacheBytes += e.bytes;
  }

  /** The stream says these keys changed: their answers are kept, but stale, and a fetch in flight is not taken as fresh. */
  #invalidate(...keys: string[]): void {
    for (const key of keys) {
      this.#gen.set(key, (this.#gen.get(key) ?? 0) + 1);
      const e = this.#cache.get(key);
      if (e !== undefined) e.freshUntil = 0;
    }
  }

  #learnJournal(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      const id = typeof e === 'object' && e !== null ? (e as { id?: unknown }).id : undefined;
      if (typeof id !== 'string') continue;
      this.#journalIds.delete(id);
      this.#journalIds.add(id);
      if (this.#journalIds.size > MAX_JOURNAL_IDS) this.#journalIds.delete(this.#journalIds.values().next().value!);
    }
  }

  #learnWindows(windows: unknown): void {
    if (!Array.isArray(windows)) return;
    this.#windowIds = new Set(windows.map((w: unknown) => (typeof w === 'object' && w !== null ? (w as { id?: unknown }).id : undefined)).filter((id) => typeof id === 'string'));
  }

  /** The last good answer for `key`, if it may still be served: a core read's for maxStaleMs after it was read. */
  #stale(key: string, now: number): Answer | null {
    const e = this.#cache.get(key);
    if (e === undefined || e.good === null) return null;
    if (CORE_KEYS.has(key) && now - e.goodAt > (this.#o.maxStaleMs ?? MAX_STALE_MS)) return null;
    return e.good;
  }

  /**
   * GET `key` (a path and query from liveRoute) of the engine, as the public may see it, for `client` (addressGroup).
   * A history is answered only for a window the engine listed; an older journal page only before an entry the host
   * has served (else `[]`, as the engine answers for an id it does not hold).
   */
  async read(key: string, client = 'unknown'): Promise<Answer> {
    const now = this.#now();
    const route = key.split('?')[0]!;
    const core = CORE_KEYS.has(key);
    if (!core) {
      const param = decodeURIComponent(key.slice(key.indexOf('=') + 1));
      if (route === '/windows/history') {
        if (this.#windowIds === null) {
          // The host has not seen a window list yet: /state brings one (or says why the engine cannot be read).
          const state = await this.read('/state', client);
          if (this.#windowIds === null) return state.status === 200 ? json(404, NO_HISTORY) : state;
        }
        if (!this.#windowIds.has(param)) return json(404, NO_HISTORY);
      } else if (route === '/journal' && !this.#journalIds.has(param)) {
        return { status: 200, body: '[]' };
      }
    }
    const e = this.#cache.get(key);
    if (e?.good && e.freshUntil > now) return e.good;
    const gen = this.#gen.get(key) ?? 0;
    const running = this.#inflight.get(key);
    if (running !== undefined && running.gen === gen) return running.p;
    const stale = this.#stale(key, now);
    if (e !== undefined && now < e.retryAt) return stale ?? e.failed ?? BUSY();
    if (now < this.#refusedUntil) return stale ?? json(503, { ok: false, error: 'live engine refused', reason: NOT_ANSWERING }, 30);
    if (!core) {
      // Over a budget: the last answer, even if old, else ask the page to wait. Nothing is spent unless both have room.
      const mine = this.#clientBucket(client);
      if (!mine.has(now) || !this.#budget.has(now)) return stale ?? BUSY();
      mine.take();
      this.#budget.take();
    }
    const p = this.#get(key).then((answer) => {
      this.#store(key, answer, gen);
      const good = answer.status === 200 || answer.status === 400 || answer.status === 404;
      // A good answer, or a newer one that landed first; a failure: the last good answer while it may be served.
      return (good ? this.#cache.get(key)?.good : this.#stale(key, this.#now())) ?? answer;
    }).finally(() => {
      if (this.#inflight.get(key)?.p === p) this.#inflight.delete(key);
    });
    this.#inflight.set(key, { gen, p });
    return p;
  }

  async #get(key: string): Promise<Answer> {
    this.counts.requests++;
    const windowsEventsBefore = this.#windowsEvents;
    let res: Response;
    try {
      res = await this.#fetch()(`${this.#o.base}${key}`, {
        headers: this.#headers('application/json'),
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 10_000),
      });
    } catch (err) {
      this.#logEvery('read', `live: GET ${key.split('?')[0]}: the engine did not answer (${err instanceof Error ? err.name : 'error'})`);
      return json(503, { ok: false, error: 'live engine not answering', reason: NOT_ANSWERING });
    }
    const route = key.split('?')[0]!;
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      this.#refused(res.status);
      return json(503, { ok: false, error: 'live engine refused', reason: NOT_ANSWERING }, 30);
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      const s = Number(res.headers.get('retry-after'));
      this.#refusedUntil = this.#now() + (Number.isFinite(s) && s > 0 ? Math.min(s, 300) : 60) * 1000;
      this.#logEvery('limited', `live: GET ${route}: the engine answered 429; asking nothing for a while`);
      return json(503, { ok: false, error: 'live engine busy', reason: NOT_ANSWERING }, 30);
    }
    if (res.status !== 200 && res.status !== 400 && res.status !== 404) {
      await res.body?.cancel().catch(() => undefined);
      this.#logEvery('read', `live: GET ${route}: the engine answered ${res.status}`);
      return json(502, { ok: false, error: 'live engine error', reason: `The live engine answered ${res.status}. This page tries again by itself.` });
    }
    const length = Number(res.headers.get('content-length') ?? '0');
    const max = this.#o.maxBodyBytes ?? MAX_BODY_BYTES;
    const tooLarge = () => json(502, { ok: false, error: 'too large', reason: 'The live engine\'s answer is too large to serve.' });
    if (length > max) {
      await res.body?.cancel().catch(() => undefined);
      return tooLarge();
    }
    let parsed: unknown;
    try {
      const text = await res.text();
      if (text.length > max) return tooLarge();
      parsed = JSON.parse(text);
    } catch {
      return json(502, { ok: false, error: 'live engine error', reason: 'The live engine\'s answer was not JSON.' });
    }
    if (res.status !== 200) return { status: res.status, body: JSON.stringify(shaped(parsed, ERROR, this.#cut) ?? {}) };
    const body = publicRead(route, parsed, this.#cut);
    if (body === undefined || body === null) return json(502, { ok: false, error: 'live engine error', reason: 'The live engine\'s answer was not what this page reads.' });
    if (route === '/state') {
      if (this.#windowsEvents === windowsEventsBefore) this.#learnWindows((body as { windows?: unknown }).windows);
      this.#learnJournal((body as { journal?: unknown }).journal);
    } else if (route === '/journal') {
      this.#learnJournal(body);
    }
    return { status: 200, body: JSON.stringify(body) };
  }

  #refused(status: number): void {
    this.#refusedUntil = this.#now() + (this.#o.refusedPauseMs ?? REFUSED_PAUSE_MS);
    this.#logEvery('refused', status === 401
      ? 'live: the engine refused the host\'s view token (401): check GIMBAL_VIEW_TOKEN on this service; asking nothing for a minute'
      : 'live: the engine refused this host (403): GIMBAL_VIEW_ORIGINS on the engine must not list a browser origin for a server; asking nothing for a minute');
  }

  /**
   * The owner's request, sent to the engine's view as it came: the host's view token, the owner header as the visitor
   * sent it, the JSON body (writes). Never cached, never retried. The answer is the route's own status and body, with
   * the fields the page reads and the host's cut (the owner token included, should anything quote it). A view without
   * owner writes (404, 405) is said so (403 owner-off); the engine refusing the host's own token is a host error (502).
   */
  async owner(method: 'GET' | 'POST' | 'PUT', path: string, ownerToken: string, body: string | null): Promise<Answer> {
    const headers: Record<string, string> = { ...this.#headers('application/json'), [OWNER_HEADER]: ownerToken };
    if (body !== null) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.#fetch()(`${this.#o.base}${path}`, {
        method, headers, ...(body === null ? {} : { body }), redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(this.#o.timeoutMs ?? 15_000),
      });
    } catch (err) {
      this.#logEvery('owner', `live: owner ${method} ${path}: the engine did not answer (${err instanceof Error ? err.name : 'error'})`);
      return json(502, { ok: false, error: 'live engine not answering', reason: 'The live engine did not answer, so this page cannot tell whether it was carried out. Check the Journal before you try again.' });
    }
    const cut = (text: string): string => this.#cut(text).split(ownerToken).join(CUT);
    const drain = () => res.body?.cancel().catch(() => undefined);
    if (res.status === 204) {
      await drain();
      return { status: 204, body: '' };
    }
    if (res.status === 401) {
      await drain();
      this.#logEvery('owner-401', 'live: owner request: the engine refused the host\'s view token (401): check GIMBAL_VIEW_TOKEN on this service');
      return json(502, { ok: false, error: 'live engine refused', reason: 'The live engine refused this site\'s view token. Nothing was sent.' });
    }
    if (res.status === 404 || res.status === 405) {
      await drain();
      return json(403, { ok: false, error: 'owner-off', reason: 'Owner writes are off on the live engine (GIMBAL_OWNER_TOKEN is not set there). Nothing was sent.' });
    }
    let parsed: unknown = null;
    try {
      const text = await res.text();
      if (text.length > 64 * 1024) return json(502, { ok: false, error: 'too large', reason: 'The live engine\'s answer is too large to serve.' });
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      return json(502, { ok: false, error: 'live engine error', reason: 'The live engine\'s answer was not JSON.' });
    }
    const shape = path === '/strategy' && res.status === 200 ? STRATEGY : ERROR;
    const s = Number(res.headers.get('retry-after'));
    return {
      status: res.status, body: JSON.stringify(shaped(parsed, shape, cut) ?? {}),
      ...(Number.isFinite(s) && s > 0 ? { retryAfterS: Math.min(Math.ceil(s), 3600) } : {}),
    };
  }

  // ---------- the one stream ----------

  subscribe(listener: UpstreamListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The latest event of each snapshot type, as chunks, for a visitor's stream to start with. */
  snapshots(): Buffer[] {
    return SNAPSHOT_TYPES.map((t) => this.#latest.get(t)).filter((c) => c !== undefined);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#open();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#abort?.abort();
    this.#abort = null;
    this.#status = 'down';
  }

  #schedule(waitMs: number): void {
    if (this.#stopped) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#open(), waitMs);
    this.#timer.unref?.();
  }

  /** The backoff for this failure, with ±25 % jitter, so hosts restarted together do not knock in step. */
  #backoff(): number {
    const base = (this.#o.backoff ?? upstreamBackoff)(this.#failures++);
    return Math.round(base * (0.75 + 0.5 * (this.#o.random ?? Math.random)()));
  }

  #down(): void {
    const was = this.#status;
    this.#status = 'down';
    this.#latest.clear();
    if (was === 'connected') for (const l of this.#listeners) l.drop();
  }

  async #open(): Promise<void> {
    if (this.#stopped) return;
    const wait = this.#refusedUntil - this.#now();
    if (wait > 0) return this.#schedule(wait);
    if (this.#status !== 'connected') this.#status = this.#failures === 0 ? 'connecting' : 'down';
    const abort = new AbortController();
    this.#abort = abort;
    let res: Response;
    try {
      this.counts.streams++;
      res = await this.#fetch()(`${this.#o.base}/events`, { headers: this.#headers('text/event-stream'), redirect: 'manual', cache: 'no-store', signal: abort.signal });
    } catch (err) {
      if (this.#stopped) return;
      this.#logEvery('stream', `live: GET /events: the engine did not answer (${err instanceof Error ? err.name : 'error'}); trying again`);
      this.#down();
      this.#schedule(this.#backoff());
      return;
    }
    if (res.status !== 200 || res.body === null) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401 || res.status === 403) this.#refused(res.status);
      else this.#logEvery('stream', `live: GET /events: the engine answered ${res.status}; trying again`);
      this.#down();
      this.#schedule(Math.max(this.#backoff(), this.#refusedUntil - this.#now()));
      return;
    }
    const openedAt = this.#now();
    this.#status = 'connected';
    // What a visitor reads next comes after this stream opened: older cached state may miss what it carries.
    this.#invalidate('/state', '/journal');
    this.#log('live: event stream open');
    const reason = await this.#pump(res.body, abort);
    if (this.#stopped) return;
    // A stream that held a while was fine: the next try is the first again.
    if (this.#now() - openedAt >= 10_000) this.#failures = 0;
    this.#logEvery('stream', `live: event stream ended (${reason}); reconnecting`);
    this.#down();
    this.#schedule(this.#backoff());
  }

  /** Reads the engine's SSE until it ends; resolves with why. Events may arrive split across any number of chunks. */
  async #pump(body: ReadableStream<Uint8Array>, abort: AbortController): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    /** A CR at the end of a chunk: whether it is a CRLF is known only with the next one. */
    let carry = '';
    let idle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, this.#o.idleMs ?? 45_000);
      idle.unref?.();
    };
    arm();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return 'closed by the engine';
        arm();
        let text = carry + decoder.decode(value, { stream: true });
        carry = '';
        if (text.endsWith('\r')) {
          carry = '\r';
          text = text.slice(0, -1);
        }
        buffer += text.replace(/\r\n?/g, '\n');
        let at: number;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          this.#block(block);
        }
        if (buffer.length > MAX_EVENT_BYTES) {
          abort.abort();
          return 'an event over the size limit';
        }
      }
    } catch {
      return timedOut ? 'no data for too long' : 'connection lost';
    } finally {
      clearTimeout(idle);
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  #block(block: string): void {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (data === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const event = publicEvent(parsed, this.#cut);
    if (event === null) return;
    const chunk = Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
    if ((SNAPSHOT_TYPES as readonly string[]).includes(event.type)) this.#latest.set(event.type, chunk);
    if (event.type === 'windows') {
      this.#windowsEvents++;
      this.#learnWindows(event.data);
    }
    if (event.type === 'journal') {
      this.#learnJournal([event.data]);
      this.#invalidate('/state', '/journal');
    }
    for (const l of this.#listeners) l.event(chunk);
  }
}

// ---------- the public server ----------

export interface LiveHostOptions {
  /** The built dashboard (web/dist-live, the hosted-live build). */
  webDir: string;
  /** Null: not configured; the page still serves and says so. */
  upstream: LiveUpstream | null;
  /** Why there is no upstream (variable names only). */
  offReason?: string | null;
  /** GIMBAL_OWNER_WRITES=1: forward the owner's requests (the owner header sent); else refuse them as every write. */
  ownerWrites?: boolean;
  /** The owner's requests per visitor (addressGroup); more are 429. */
  ownerRate?: Rate;
  log?: (line: string) => void;
  /** Visitor event streams at once, for everyone; more are answered 503 (the page retries). */
  maxStreams?: number;
  /** Visitor event streams at once from one address (addressGroup); more are answered 429. */
  maxStreamsPerClient?: number;
  /** Bytes one visitor may leave unread on its stream before it is dropped. */
  maxUnreadBytes?: number;
  /**
   * Bytes all visitors together may leave unread for longer than `unreadCheckMs`; past it the one holding most is
   * dropped first. Measured off the write path: what was just written to a reading visitor is in flight, not unread.
   */
  maxUnreadTotal?: number;
  /** How often the total above is measured (the bytes written since the last measure are left out). */
  unreadCheckMs?: number;
  heartbeatMs?: number;
}

/** The owner's requests per visitor: an unlock check and a few writes, then one every 10 s. */
export const OWNER_RATE: Rate = { perSecond: 0.1, burst: 10 };

export const MAX_VISITOR_STREAMS = 300;
/** A few of the largest events (the windows list) behind: more and the visitor reconnects and reads /state. */
export const MAX_VISITOR_UNREAD = 512 * 1024;
/** What all slow visitors together may park in the host's memory. */
export const MAX_UNREAD_TOTAL = 32 * 1024 * 1024;
/** A reading visitor takes in a scan's events (the windows list is about 120 KB) well within this. */
export const UNREAD_CHECK_MS = 5_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const COMMON_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
} as const;

const PING = Buffer.from(': ping\n\n');
const RETRY = Buffer.from('retry: 5000\n\n');

export interface LiveHostServer extends Server {
  stats(): { visitors: number; unreadBytes: number };
  /** Ends every visitor stream and stops the heartbeat (shutdown). */
  dropStreams(): void;
}

function hasBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length.trim() !== '0');
}

/** A request's body as text, or null once it passes `max` bytes (the rest is not read; the connection closes). */
function readCappedBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        req.pause();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...extra });
  res.end(text);
}

export function createLiveHostServer(o: LiveHostOptions): LiveHostServer {
  const visitors = new Set<ServerResponse>();
  const perClient = new Map<string, number>();
  const logged = new Map<string, number>();
  const log = (line: string) => o.log?.(line);
  const logEvery = (kind: string, line: string) => {
    const now = Date.now();
    if (now - (logged.get(kind) ?? 0) < LOG_EVERY_MS) return;
    logged.set(kind, now);
    log(line);
  };
  const maxUnread = o.maxUnreadBytes ?? MAX_VISITOR_UNREAD;
  const maxTotal = o.maxUnreadTotal ?? MAX_UNREAD_TOTAL;
  const notConfigured = { ok: false, error: 'live engine not configured', reason: NOT_CONFIGURED_REASON };

  /** Bytes written to each visitor since the last measure of the total. */
  const recent = new Map<ServerResponse, number>();
  const drop = (res: ServerResponse, why: string): void => {
    visitors.delete(res);
    recent.delete(res);
    logEvery(`drop-${why}`, `visitor stream dropped: ${res.writableLength} bytes unread (${why})`);
    res.destroy();
  };
  const send = (res: ServerResponse, chunk: Buffer): void => {
    if (!visitors.has(res)) return;
    res.write(chunk);
    recent.set(res, (recent.get(res) ?? 0) + chunk.length);
    if (res.writableLength > maxUnread) drop(res, `over ${maxUnread} for one visitor`);
  };
  /**
   * Every unreadCheckMs: the bytes each visitor has left unread since before the last measure (its unread bytes less
   * what was written since); while those add up to more than maxTotal, the visitor holding most goes. A fan-out to many
   * reading visitors writes far more than maxTotal at once, and none of it counts here.
   */
  const measureUnread = (): void => {
    const old = new Map<ServerResponse, number>();
    let total = 0;
    for (const res of visitors) {
      const n = Math.max(0, res.writableLength - (recent.get(res) ?? 0));
      old.set(res, n);
      total += n;
    }
    recent.clear();
    if (total <= maxTotal) return;
    for (const [res, n] of [...old].sort((a, b) => b[1] - a[1])) {
      if (total <= maxTotal) break;
      total -= n;
      drop(res, `over ${maxTotal} for all visitors`);
    }
  };
  const unreadCheck = setInterval(measureUnread, o.unreadCheckMs ?? UNREAD_CHECK_MS);
  unreadCheck.unref();
  const unsubscribe = o.upstream?.subscribe({
    event: (chunk) => {
      for (const res of visitors) send(res, chunk);
    },
    drop: () => {
      // Each page notices, reconnects, and reads /state again once the engine is back.
      for (const res of visitors) res.end();
      visitors.clear();
      recent.clear();
    },
  });
  const heartbeat = setInterval(() => {
    for (const res of visitors) send(res, PING);
  }, o.heartbeatMs ?? 15_000);
  heartbeat.unref();

  const ownerBuckets = new Map<string, Bucket>();
  /**
   * The owner's request (liveRoute kind `owner`): the header checked for shape only (the engine checks the token), a
   * write from this site's own page only, with a JSON body under the cap; then forwarded as it came. Logged as method,
   * path and status: never the header or the body.
   */
  const owner = async (req: IncomingMessage, res: ServerResponse, route: Extract<LiveRoute, { kind: 'owner' }>, client: string): Promise<void> => {
    const header = req.headers[OWNER_HEADER];
    const refuseOwner = (status: number, error: string, reason: string, extra: Record<string, string> = {}): void => {
      res.setHeader('connection', 'close');
      return sendJson(res, status, { ok: false, error, reason }, extra);
    };
    if (typeof header !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(header)) return refuseOwner(400, 'owner', 'The owner token must be one header of printable characters.');
    if (o.upstream === null) return refuseOwner(503, 'live engine not configured', NOT_CONFIGURED_REASON);
    const write = route.method !== 'GET';
    const origin = req.headers.origin;
    if (write ? !sameOrigin(origin, req.headers.host) : origin !== undefined && !sameOrigin(origin, req.headers.host)) {
      logEvery('owner-origin', `owner: ${route.method} ${route.path} refused: not from this site's own page`);
      return refuseOwner(403, 'origin', 'Owner requests are taken from this site\'s own page only.');
    }
    const now = Date.now();
    let bucket = ownerBuckets.get(client);
    if (bucket === undefined) {
      bucket = new Bucket(o.ownerRate ?? OWNER_RATE, now);
      if (ownerBuckets.size >= MAX_CLIENTS) ownerBuckets.delete(ownerBuckets.keys().next().value!);
      ownerBuckets.set(client, bucket);
    }
    if (!bucket.has(now)) return refuseOwner(429, 'busy', 'Too many owner requests from this address; wait a few seconds.', { 'retry-after': '10' });
    bucket.take();
    let body: string | null = null;
    if (!write) {
      if (hasBody(req)) return refuseOwner(400, 'body', 'GET /owner takes no body');
    } else {
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') return refuseOwner(415, 'content-type', `${route.method} ${route.path} needs content-type application/json`);
      const declared = Number(req.headers['content-length'] ?? '0');
      if (Number.isFinite(declared) && declared > OWNER_MAX_BODY_BYTES) return refuseOwner(413, 'body', `The body is over ${OWNER_MAX_BODY_BYTES} bytes.`);
      const text = await readCappedBody(req, OWNER_MAX_BODY_BYTES);
      if (text === null) return refuseOwner(413, 'body', `The body is over ${OWNER_MAX_BODY_BYTES} bytes.`);
      body = text.trim() === '' ? '{}' : text;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return refuseOwner(400, 'body', 'The body is not JSON.');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return refuseOwner(400, 'body', 'The body must be a JSON object.');
    }
    const answer = await o.upstream.owner(route.method, route.path, header, body);
    if (write) log(`owner: ${route.method} ${route.path}: ${answer.status}`);
    if (answer.status === 204) {
      res.writeHead(204, { 'cache-control': 'no-store' });
      return void res.end();
    }
    return sendJson(res, answer.status, answer.body, answer.retryAfterS === undefined ? {} : { 'retry-after': String(answer.retryAfterS) });
  };

  const liveStatus = (): Record<string, unknown> => o.upstream === null
    ? { live: 'not-configured', reason: o.offReason ?? NOT_CONFIGURED_REASON }
    : { live: o.upstream.status };

  const events = (req: IncomingMessage, res: ServerResponse, key: string): void => {
    if (o.upstream === null) return sendJson(res, 503, notConfigured);
    if (o.upstream.status !== 'connected') return sendJson(res, 503, { ok: false, error: 'live engine not answering', reason: NOT_ANSWERING }, { 'retry-after': '5' });
    const mine = perClient.get(key) ?? 0;
    if (visitors.size >= (o.maxStreams ?? MAX_VISITOR_STREAMS)) return sendJson(res, 503, { ok: false, error: 'too many streams', reason: 'This site serves as many live streams as it allows right now; the page tries again by itself.' });
    const cap = o.maxStreamsPerClient ?? MAX_STREAMS_PER_CLIENT;
    if (mine >= cap) {
      // The address the cap counted, for the post-deploy check (docs/deploy-live-view.md): the edge's, never one a visitor forged.
      // The key came from a header: printable characters only, and short, in the log.
      logEvery('per-client', `visitor streams: ${mine} open from ${key.replace(/[^!-~]/g, '?').slice(0, 64)}, the cap of ${cap}; refused (429)`);
      return sendJson(res, 429, { ok: false, error: 'too many streams', reason: `${mine} streams are open from this address already; close a tab and the page tries again.` });
    }
    perClient.set(key, mine + 1);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    visitors.add(res);
    send(res, RETRY);
    for (const chunk of o.upstream.snapshots()) send(res, chunk);
    let counted = true;
    const gone = () => {
      visitors.delete(res);
      recent.delete(res);
      if (!counted) return;
      counted = false;
      const n = (perClient.get(key) ?? 1) - 1;
      if (n <= 0) perClient.delete(key);
      else perClient.set(key, n);
    };
    req.on('close', gone);
    res.on('close', gone);
    res.on('error', gone);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://host');
    } catch {
      res.setHeader('connection', 'close');
      return sendJson(res, 400, { ok: false, error: 'bad request', reason: 'that is not a path' });
    }
    for (const [k, v] of Object.entries(COMMON_HEADERS)) res.setHeader(k, v);
    const route = liveRoute(method, url.pathname, url.searchParams, { on: o.ownerWrites === true, header: req.headers[OWNER_HEADER] !== undefined });
    if (route.kind === 'owner') return owner(req, res, route, liveClientKey(req));
    if (route.kind === 'refuse') {
      // The body is never read: the connection closes after the answer.
      res.setHeader('connection', 'close');
      if (route.status === 405 || route.status === 403) res.setHeader('allow', 'GET, HEAD');
      return sendJson(res, route.status, route.body);
    }
    if (hasBody(req)) {
      res.setHeader('connection', 'close');
      return sendJson(res, 400, { ok: false, error: 'body', reason: `${method} ${url.pathname} takes no body` });
    }
    if (route.kind === 'health') return sendJson(res, 200, { ok: true, ...liveStatus(), visitors: visitors.size });
    if (route.kind === 'static') {
      const file = liveStaticFile(o.webDir, url.pathname);
      if (file === null || !existsSync(file)) return sendJson(res, 404, { ok: false, error: 'not found', reason: `no file ${url.pathname}` });
      res.writeHead(200, {
        'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      if (method === 'HEAD') return void res.end();
      const stream = createReadStream(file);
      // A file that cannot be read (removed by a rebuild, a disk error) ends this response, never the host.
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }
    const key = liveClientKey(req);
    if (route.kind === 'events') {
      if (method === 'HEAD') {
        res.writeHead(o.upstream?.status === 'connected' ? 200 : 503, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end();
      }
      return events(req, res, key);
    }
    // A read.
    if (o.upstream === null) return sendJson(res, 503, notConfigured);
    const answer = await o.upstream.read(route.key, key);
    const extra: Record<string, string> = answer.retryAfterS === undefined ? {} : { 'retry-after': String(answer.retryAfterS) };
    if (method === 'HEAD') {
      res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(answer.body), 'cache-control': 'no-store', ...extra });
      return void res.end();
    }
    return sendJson(res, answer.status, answer.body, extra);
  };

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch(() => {
      // No error text: it could quote what was asked.
      log(`${req.method} ${new URL(req.url ?? '/', 'http://host').pathname}: internal error`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      else res.destroy();
    });
  });
  server.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(unreadCheck);
    unsubscribe?.();
  });
  return Object.assign(server, {
    stats: () => {
      let unreadBytes = 0;
      for (const res of visitors) unreadBytes += res.writableLength;
      return { visitors: visitors.size, unreadBytes };
    },
    dropStreams(): void {
      clearInterval(heartbeat);
      clearInterval(unreadCheck);
      for (const res of visitors) res.end();
      visitors.clear();
    },
  });
}
