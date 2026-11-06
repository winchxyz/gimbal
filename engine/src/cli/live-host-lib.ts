// The public live view's parts (live-host.ts runs them), kept apart so they are tested without a live engine:
//   liveConfigFromEnv()   GIMBAL_LIVE_URL (the live engine's read-only view) and GIMBAL_VIEW_TOKEN, or why the host
//                         has no live engine (it then serves the page with a "not configured" state);
//   liveRoute()           what the public port answers: an allowlist of the reads the dashboard needs; every write is
//                         refused here and never forwarded; any other API path is 404;
//   publicCutter()        what the host cuts on top of the engine's own redaction (engine/src/view/view-redact.ts):
//                         IP addresses, e-mail addresses, local paths, private Railway host names, referral codes,
//                         the venue set-up details, and the host's own token and engine address, should either appear;
//   LiveUpstream          the host's only link to the live engine: the token is added here, server-side; GETs are
//                         cached, shared while in flight and rate-limited; ONE event stream, reconnected with backoff;
//   createLiveHostServer  the public HTTP server: the built dashboard and the reads on one origin, the one upstream
//                         stream fanned out to every visitor, with a cap on visitor streams.
//
// No visitor header reaches the engine: every upstream request is built here from nothing but the path, `accept` and
// the host's own `authorization`. The token is never in a response, a URL or a log line.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { MAX_STREAMS_PER_CLIENT, MAX_UNREAD_BYTES, clientKey } from './replay-host-lib.ts';

export const HEALTH_PATH = '/healthz';

/** What the hosted-live build writes into index.html (web/vite.config.ts, VITE_HOSTED_LIVE=1). */
export const LIVE_BUILD_MARKER = '<meta name="gimbal-build" content="hosted-live">';

export function isLiveBuild(indexHtml: string): boolean {
  return indexHtml.includes(LIVE_BUILD_MARKER);
}

export const LIVE_READ_ONLY_REASON = 'This is the public view of the live mainnet desk, and it is read-only: visitors cannot change the rules, '
  + 'enter, rotate, close, pause or stress it. The host refuses every write and never forwards one to the engine.';

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
  | { kind: 'refuse'; status: number; body: { ok: false; error: string; reason: string } };

const refuse = (status: number, error: string, reason: string): LiveRoute => ({ kind: 'refuse', status, body: { ok: false, error, reason } });

export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * What the public port does with `method` `path`?`search`. Only GET and HEAD of the reads the dashboard needs reach the
 * engine; every other method is refused here (POST /rotate, /close, /stress, /pause, PUT /strategy and the rest), and
 * so is every GET of an API path that is not on the list.
 */
export function liveRoute(method: string, rawPath: string, search: URLSearchParams = new URLSearchParams()): LiveRoute {
  const path = rawPath.replace(/\/+$/, '') || '/';
  const read = method === 'GET' || method === 'HEAD';
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

// ---------- what the public must not see ----------

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

/** Every string in a JSON value through `cut` (object keys are field names and stay). */
export function cutJson(value: unknown, cut: (text: string) => string): unknown {
  if (typeof value === 'string') return cut(value);
  if (Array.isArray(value)) return value.map((v) => cutJson(v, cut));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cutJson(v, cut);
    return out;
  }
  return value;
}

/**
 * The venue set-up as the public sees it: each step's name, status and transactions, without its detail. The details
 * name referral codes, the desk's Orderly IP list, its venue account ids and its key's expiry: the owner's, not the
 * public's. The transactions are on chain already.
 */
export function publicSetup(setup: unknown): unknown {
  if (setup === null || typeof setup !== 'object' || Array.isArray(setup)) return setup;
  const s = setup as { steps?: unknown };
  if (!Array.isArray(s.steps)) return setup;
  return {
    ...setup,
    steps: s.steps.map((step: unknown) => {
      if (step === null || typeof step !== 'object') return step;
      const { detail: _detail, ...rest } = step as Record<string, unknown>;
      return rest;
    }),
  };
}

/** The fields of GET /state the page reads (shared EngineState): a field an engine adds later is not published by default. */
export const STATE_FIELDS = ['mode', 'windows', 'scan', 'strategy', 'desk', 'journal', 'rescue', 'setup', 'health', 'decision', 'at'] as const;
/** The event types the page reads (shared StreamEvent). */
export const EVENT_TYPES = ['windows', 'scan', 'desk', 'journal', 'rescue', 'setup', 'health', 'decision'] as const;
/** The types whose latest value a new visitor's stream starts with, in the engine's order (view-server.ts). */
export const SNAPSHOT_TYPES = ['scan', 'windows', 'desk', 'health', 'setup', 'rescue', 'decision'] as const;

export function publicState(state: unknown, cut: (text: string) => string): unknown {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return null;
  const s = state as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of STATE_FIELDS) if (f in s) out[f] = f === 'setup' ? publicSetup(s[f]) : s[f];
  return cutJson(out, cut);
}

/** One stream event as the public sees it, or null for a type the page does not read. */
export function publicEvent(event: unknown, cut: (text: string) => string): { type: string; data: unknown } | null {
  if (event === null || typeof event !== 'object') return null;
  const { type, data } = event as { type?: unknown; data?: unknown };
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) return null;
  return { type, data: cutJson(type === 'setup' ? publicSetup(data) : data, cut) };
}

// ---------- the upstream ----------

export interface Answer {
  status: number;
  /** JSON text, already cut. */
  body: string;
  retryAfterS?: number;
}

export type StreamStatus = 'connecting' | 'connected' | 'down';

export interface UpstreamListener {
  /** One SSE chunk (`data: …\n\n`), already cut. */
  event(chunk: string): void;
  /** The upstream stream ended: every visitor stream should end, so each page reconnects and reads /state again. */
  drop(): void;
}

export interface LiveUpstreamOptions extends LiveConfig {
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  /** GET /state and /strategy are answered from the cache this long. */
  stateTtlMs?: number;
  /** Journal pages and window histories: they change slowly. */
  pageTtlMs?: number;
  /** A failed read is answered from the cache this long, so a crowd during an outage sends one request, not many. */
  errorTtlMs?: number;
  maxCacheBytes?: number;
  /** A larger answer from the engine is refused. */
  maxBodyBytes?: number;
  /** Upstream GETs the host may start: a token bucket, `perSecond` refilled, `burst` at most. */
  rate?: { perSecond: number; burst: number };
  timeoutMs?: number;
  /** The wait before the stream is opened again, after `attempt` failures in a row (0 = the first). */
  backoff?: (attempt: number) => number;
  /** No byte from the engine's stream for this long (it pings every 15 s): the stream is taken as dead. */
  idleMs?: number;
  /** After the engine refuses the host's token (401) or origin (403), nothing is asked for this long. */
  refusedPauseMs?: number;
}

export const STATE_TTL_MS = 3_000;
export const PAGE_TTL_MS = 30_000;
export const ERROR_TTL_MS = 2_000;
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** One SSE event larger than this ends the stream: the engine never sends one near it. */
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
export const UPSTREAM_RATE = { perSecond: 3, burst: 10 } as const;
export const REFUSED_PAUSE_MS = 60_000;
const LOG_EVERY_MS = 60_000;

/** 1 s, 2 s, 4 s ... up to 30 s. */
export function upstreamBackoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

interface Cached {
  answer: Answer;
  until: number;
  bytes: number;
}

const json = (status: number, body: unknown, retryAfterS?: number): Answer => ({ status, body: JSON.stringify(body), ...(retryAfterS === undefined ? {} : { retryAfterS }) });

export const NOT_ANSWERING = 'The live engine is not answering right now. This page tries again by itself.';

/**
 * The host's one link to the live engine's read-only view. Reads are cached per path and query, one request per key
 * at a time however many visitors ask, and at most `rate` new requests a second in all; past that, the last answer
 * is served stale, or 503. The event stream is one connection, opened at start(), reconnected with backoff.
 */
export class LiveUpstream {
  readonly #o: LiveUpstreamOptions;
  readonly #cut: (text: string) => string;
  readonly #cache = new Map<string, Cached>();
  readonly #inflight = new Map<string, Promise<Answer>>();
  readonly #listeners = new Set<UpstreamListener>();
  readonly #latest = new Map<string, string>();
  readonly #logged = new Map<string, { at: number; skipped: number }>();
  #cacheBytes = 0;
  #tokens: number;
  #refilledAt: number;
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
    this.#tokens = (options.rate ?? UPSTREAM_RATE).burst;
    this.#refilledAt = this.#now();
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

  #takeToken(): boolean {
    const rate = this.#o.rate ?? UPSTREAM_RATE;
    const now = this.#now();
    this.#tokens = Math.min(rate.burst, this.#tokens + ((now - this.#refilledAt) / 1000) * rate.perSecond);
    this.#refilledAt = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  #ttl(key: string, answer: Answer): number {
    if (answer.status !== 200 && answer.status !== 404 && answer.status !== 400) return this.#o.errorTtlMs ?? ERROR_TTL_MS;
    return key === '/state' || key === '/strategy' ? (this.#o.stateTtlMs ?? STATE_TTL_MS) : (this.#o.pageTtlMs ?? PAGE_TTL_MS);
  }

  #store(key: string, answer: Answer): void {
    const old = this.#cache.get(key);
    if (old !== undefined) {
      this.#cacheBytes -= old.bytes;
      this.#cache.delete(key);
    }
    const bytes = answer.body.length + key.length;
    const max = this.#o.maxCacheBytes ?? MAX_CACHE_BYTES;
    if (bytes > max) return;
    while (this.#cacheBytes + bytes > max && this.#cache.size > 0) {
      const [oldest, entry] = this.#cache.entries().next().value!;
      this.#cacheBytes -= entry.bytes;
      this.#cache.delete(oldest);
    }
    this.#cache.set(key, { answer, until: this.#now() + this.#ttl(key, answer), bytes });
    this.#cacheBytes += bytes;
  }

  /** Forgets the cached answers for these keys: the stream says they changed. */
  #invalidate(...keys: string[]): void {
    for (const [key, entry] of this.#cache) {
      if (keys.includes(key)) {
        this.#cacheBytes -= entry.bytes;
        this.#cache.delete(key);
      }
    }
  }

  /** GET `key` (a path and query from liveRoute) of the engine, as the public may see it. */
  read(key: string): Promise<Answer> {
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.until > this.#now()) return Promise.resolve(cached.answer);
    const running = this.#inflight.get(key);
    if (running !== undefined) return running;
    if (this.#now() < this.#refusedUntil) {
      return Promise.resolve(cached?.answer ?? json(503, { ok: false, error: 'live engine refused', reason: NOT_ANSWERING }, 30));
    }
    if (!this.#takeToken()) {
      // Over the budget: the last answer, even if old, else ask the page to wait.
      return Promise.resolve(cached?.answer ?? json(503, { ok: false, error: 'busy', reason: 'Too many requests reach the live engine right now; try again in a few seconds.' }, 2));
    }
    const p = this.#get(key).then((answer) => {
      this.#store(key, answer);
      return answer;
    }).finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, p);
    return p;
  }

  async #get(key: string): Promise<Answer> {
    this.counts.requests++;
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
    if (length > max) {
      await res.body?.cancel().catch(() => undefined);
      return json(502, { ok: false, error: 'too large', reason: 'The live engine\'s answer is too large to serve.' });
    }
    let parsed: unknown;
    try {
      const text = await res.text();
      if (text.length > max) return json(502, { ok: false, error: 'too large', reason: 'The live engine\'s answer is too large to serve.' });
      parsed = JSON.parse(text);
    } catch {
      return json(502, { ok: false, error: 'live engine error', reason: 'The live engine\'s answer was not JSON.' });
    }
    if (res.status !== 200) {
      // The engine's own 400 or 404 ({ error }): its words, cut like the rest.
      return { status: res.status, body: JSON.stringify(cutJson(parsed, this.#cut)) };
    }
    const body = route === '/state' ? publicState(parsed, this.#cut) : cutJson(parsed, this.#cut);
    if (body === null) return json(502, { ok: false, error: 'live engine error', reason: 'The live engine\'s state was not an object.' });
    return { status: 200, body: JSON.stringify(body) };
  }

  #refused(status: number): void {
    this.#refusedUntil = this.#now() + (this.#o.refusedPauseMs ?? REFUSED_PAUSE_MS);
    this.#logEvery('refused', status === 401
      ? 'live: the engine refused the host\'s view token (401): check GIMBAL_VIEW_TOKEN on this service; asking nothing for a minute'
      : 'live: the engine refused this host (403): GIMBAL_VIEW_ORIGINS on the engine must not list a browser origin for a server; asking nothing for a minute');
  }

  // ---------- the one stream ----------

  subscribe(listener: UpstreamListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The latest event of each snapshot type, as chunks, for a visitor's stream to start with. */
  snapshots(): string[] {
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

  #down(): void {
    const was = this.#status;
    this.#status = 'down';
    this.#latest.clear();
    if (was === 'connected') for (const l of this.#listeners) l.drop();
  }

  async #open(): Promise<void> {
    if (this.#stopped) return;
    const backoff = this.#o.backoff ?? upstreamBackoff;
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
      this.#schedule(backoff(this.#failures++));
      return;
    }
    if (res.status !== 200 || res.body === null) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401 || res.status === 403) this.#refused(res.status);
      else this.#logEvery('stream', `live: GET /events: the engine answered ${res.status}; trying again`);
      this.#down();
      this.#schedule(Math.max(backoff(this.#failures++), this.#refusedUntil - this.#now()));
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
    this.#schedule(backoff(this.#failures++));
  }

  /** Reads the engine's SSE until it ends; resolves with why. */
  async #pump(body: ReadableStream<Uint8Array>, abort: AbortController): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
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
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
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
    const chunk = `data: ${JSON.stringify(event)}\n\n`;
    if ((SNAPSHOT_TYPES as readonly string[]).includes(event.type)) this.#latest.set(event.type, chunk);
    if (event.type === 'journal') this.#invalidate('/state', '/journal');
    for (const l of this.#listeners) l.event(chunk);
  }
}

// ---------- the public server ----------

export interface LiveHostOptions {
  /** The built dashboard (web/dist, the hosted-live build). */
  webDir: string;
  /** Null: not configured; the page still serves and says so. */
  upstream: LiveUpstream | null;
  /** Why there is no upstream (variable names only). */
  offReason?: string | null;
  log?: (line: string) => void;
  /** Visitor event streams at once, for everyone; more are answered 503 (the page retries). */
  maxStreams?: number;
  /** Visitor event streams at once from one address (clientKey); more are answered 429. */
  maxStreamsPerClient?: number;
  maxUnreadBytes?: number;
  heartbeatMs?: number;
}

export const MAX_VISITOR_STREAMS = 300;

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

export interface LiveHostServer extends Server {
  stats(): { visitors: number };
  /** Ends every visitor stream and stops the heartbeat (shutdown). */
  dropStreams(): void;
}

function hasBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length.trim() !== '0');
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...extra });
  res.end(text);
}

export function createLiveHostServer(o: LiveHostOptions): LiveHostServer {
  const visitors = new Set<ServerResponse>();
  const perClient = new Map<string, number>();
  const log = (line: string) => o.log?.(line);
  const maxUnread = o.maxUnreadBytes ?? MAX_UNREAD_BYTES;
  const notConfigured = { ok: false, error: 'live engine not configured', reason: NOT_CONFIGURED_REASON };

  const send = (res: ServerResponse, chunk: string): void => {
    if (!visitors.has(res)) return;
    res.write(chunk);
    if (res.writableLength > maxUnread) {
      visitors.delete(res);
      log(`visitor stream dropped: ${res.writableLength} bytes unread, over ${maxUnread}`);
      res.destroy();
    }
  };
  const unsubscribe = o.upstream?.subscribe({
    event: (chunk) => {
      for (const res of visitors) send(res, chunk);
    },
    drop: () => {
      // Each page notices, reconnects, and reads /state again once the engine is back.
      for (const res of visitors) res.end();
      visitors.clear();
    },
  });
  const heartbeat = setInterval(() => {
    for (const res of visitors) send(res, ': ping\n\n');
  }, o.heartbeatMs ?? 15_000);
  heartbeat.unref();

  const liveStatus = (): Record<string, unknown> => o.upstream === null
    ? { live: 'not-configured', reason: o.offReason ?? NOT_CONFIGURED_REASON }
    : { live: o.upstream.status };

  const events = (req: IncomingMessage, res: ServerResponse): void => {
    if (o.upstream === null) return sendJson(res, 503, notConfigured);
    if (o.upstream.status !== 'connected') return sendJson(res, 503, { ok: false, error: 'live engine not answering', reason: NOT_ANSWERING }, { 'retry-after': '5' });
    const key = clientKey(req);
    const mine = perClient.get(key) ?? 0;
    if (visitors.size >= (o.maxStreams ?? MAX_VISITOR_STREAMS)) return sendJson(res, 503, { ok: false, error: 'too many streams', reason: 'This site serves as many live streams as it allows right now; the page tries again by itself.' });
    if (mine >= (o.maxStreamsPerClient ?? MAX_STREAMS_PER_CLIENT)) {
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
    send(res, 'retry: 5000\n\n');
    for (const chunk of o.upstream.snapshots()) send(res, chunk);
    let counted = true;
    const gone = () => {
      visitors.delete(res);
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
    const route = liveRoute(method, url.pathname, url.searchParams);
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
      createReadStream(file).pipe(res);
      return;
    }
    if (route.kind === 'events') {
      if (method === 'HEAD') {
        res.writeHead(o.upstream?.status === 'connected' ? 200 : 503, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end();
      }
      return events(req, res);
    }
    // A read.
    if (o.upstream === null) return sendJson(res, 503, notConfigured);
    const answer = await o.upstream.read(route.key);
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
    unsubscribe?.();
  });
  return Object.assign(server, {
    stats: () => ({ visitors: visitors.size }),
    dropStreams(): void {
      clearInterval(heartbeat);
      for (const res of visitors) res.end();
      visitors.clear();
    },
  });
}
