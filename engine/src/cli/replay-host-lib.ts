// The hosted replay's parts (replay-host.ts runs them), kept apart so they are tested without a child engine:
//   hostedRoute()    which requests the public port answers, and how: the dashboard's files, the engine's GET routes,
//                    POST /stress through StressGate, everything else refused as read-only;
//   StressGate       POST /stress one at a time, one per run, never during a rescue, only while a pair is held;
//   ReplayCycler     starts the replay engine, and once its recorded hour has played (plus a pause on the flat desk)
//                    starts a fresh one on the other internal port, switches the proxy to it and stops the old one;
//   childEnv()       the engine's environment: an allowlist, so no variable of the host (a key, a token) reaches it;
//   createHostServer the public HTTP server: one origin for the built dashboard and the engine's read routes, with
//                    backpressure and a per-client cap on event streams.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { Agent, createServer, request } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { EngineState } from '@gimbal/shared';

/** The engine's routes, as web/vite.config.ts proxies them: everything else on the public port is the dashboard. */
export const API_PREFIXES: readonly string[] = ['/events', '/state', '/stress', '/policy', '/strategy', '/setup', '/windows', '/journal', '/rotate', '/close'];
export const HEALTH_PATH = '/healthz';

export const READ_ONLY_REASON = 'This is the hosted replay: a recorded mainnet hour played back for anyone to watch, so it is read-only. '
  + 'Visitors cannot change the rules, enter, rotate or close; the replay script does that by itself, as the owner would. '
  + 'Nothing is signed or sent. Run a stress test on Rescue while a pair is held, or run `npm run demo` for a desk of your own.';

export type HostedRoute =
  | { kind: 'static' }
  | { kind: 'health' }
  | { kind: 'proxy' }
  | { kind: 'stress' }
  | { kind: 'refuse'; status: number; body: { ok: false; reason: string; error: string } };

const refuse = (status: number, reason: string): HostedRoute => ({ kind: 'refuse', status, body: { ok: false, reason, error: reason } });

export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * What the public port does with `method` `path`. Reads (GET, HEAD) of the engine are proxied, POST /stress goes to
 * the gate, and every other write (PUT /strategy, POST /rotate, /close, /policy/draft, /setup) is refused here: it
 * never reaches the engine. The replay script drives the loop inside the engine's own process.
 */
export function hostedRoute(method: string, rawPath: string): HostedRoute {
  const path = rawPath.replace(/\/+$/, '') || '/';
  const read = method === 'GET' || method === 'HEAD';
  if (path === HEALTH_PATH) return read ? { kind: 'health' } : refuse(405, `${method} ${path}: use GET`);
  if (isApiPath(path)) {
    if (read) return { kind: 'proxy' };
    if (path === '/stress' && method === 'POST') return { kind: 'stress' };
    return refuse(403, `${method} ${path} is refused. ${READ_ONLY_REASON}`);
  }
  return read ? { kind: 'static' } : refuse(405, `${method} ${path}: this page only serves files`);
}

/** The answer a stress request gets before it reaches the engine, or null to send it on. */
export interface StressRefusal {
  status: number;
  reason: string;
  retryAfterS?: number;
}

/**
 * POST /stress for the public: the engine itself refuses one with no leg open; this also keeps it to one at a time,
 * never while a rescue runs, and one per replay run, so the realized P&L a visitor sees is the recorded hour's plus at
 * most one rescue, and a crowd of clicks cannot keep the desk in rescue.
 */
export class StressGate {
  readonly #nextRunAt: () => number | null;
  readonly #now: () => number;
  #inFlight = false;
  #used = false;

  /** `nextRunAt`: when the next run takes over (ms), for the answer to a second stress test; null when unknown. */
  constructor(options: { nextRunAt?: () => number | null; now?: () => number } = {}) {
    this.#nextRunAt = options.nextRunAt ?? (() => null);
    this.#now = options.now ?? Date.now;
  }

  /** Why a stress test cannot start now, given the engine's GET /state (null: it did not answer). */
  check(state: Pick<EngineState, 'desk' | 'rescue'> | null): StressRefusal | null {
    return this.busy() ?? this.#checkState(state);
  }

  /** The refusals that need no look at the engine: one in flight, or this run's already used. */
  busy(): StressRefusal | null {
    if (this.#inFlight) return { status: 409, reason: 'A stress test request is being handled right now; watch it on Rescue.' };
    if (this.#used) {
      const at = this.#nextRunAt();
      const s = at === null ? null : Math.max(1, Math.ceil((at - this.#now()) / 1000));
      return {
        status: 409,
        reason: 'This public replay allows one stress test per run, so the realized P&L stays the recorded hour\'s plus at most one rescue, '
          + `and this run has had its stress test. The replay starts over in ${s === null ? 'a few minutes' : `${s} s`}; `
          + 'run `npm run demo` for a desk of your own.',
        ...(s === null ? {} : { retryAfterS: s }),
      };
    }
    return null;
  }

  #checkState(state: Pick<EngineState, 'desk' | 'rescue'> | null): StressRefusal | null {
    if (state === null) return { status: 503, reason: 'The replay is starting over; try again in a few seconds.' };
    const rescue = state.rescue;
    if (state.desk?.health === 'rescue' || (rescue !== null && rescue.step !== 'landed' && rescue.step !== 'failed')) {
      return { status: 409, reason: 'A rescue is running now; watch it on Rescue. One stress test at a time.' };
    }
    if (!(state.desk?.legs ?? []).some((l) => l.size > 0)) {
      return {
        status: 409,
        reason: 'No pair is held right now, so there is no margin to stress. The replay opens a pair shortly after it starts '
          + 'and holds it for most of the recorded hour; try again once the Desk shows two legs.',
      };
    }
    return null;
  }

  /** A request goes to the engine: no other until end(). */
  begin(): void {
    this.#inFlight = true;
  }

  /** The engine answered; `accepted` uses up this run's stress test. */
  end(accepted: boolean): void {
    this.#inFlight = false;
    if (accepted) this.#used = true;
  }

  /** A new run serves: it has its own stress test. */
  reset(): void {
    this.#used = false;
  }
}

/**
 * The only bodies POST /stress takes from the public: none, `{}` (what the dashboard sends) or `{"on":true}`. Null when
 * the body is one of them, else why not: turning stress off, or anything else, is not the public's.
 */
export function stressBodyProblem(text: string): string | null {
  const t = text.trim();
  if (t === '') return null;
  let body: unknown;
  try {
    body = JSON.parse(t);
  } catch {
    return 'the body is not JSON';
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'the body must be {} or {"on":true}';
  const keys = Object.keys(body);
  if (keys.length === 0) return null;
  if (keys.length === 1 && (body as { on?: unknown }).on === true) return null;
  return 'the body must be {} or {"on":true}';
}

/** One replay engine the cycler started. */
export interface ReplayEngine {
  readonly port: number;
  /** Resolves once it answers and has its rules (the replay script waits for them); rejects when it cannot. */
  readonly ready: Promise<void>;
  /** Resolves with how it ended, whenever it does. */
  readonly exited: Promise<string>;
  /** Stops it and removes what it kept; resolves once it is gone. */
  stop(): Promise<void>;
}

export interface CyclerOptions {
  /** The two internal ports, used in turn, so the next engine starts next to the one serving. */
  ports: readonly [number, number];
  start: (port: number, run: number) => ReplayEngine;
  /** Real ms one run takes to play its recording: (end - start) / speed. */
  cycleMs: number;
  /** Real ms the finished run stays up (time stopped at the recording's end, the desk flat) before the next. */
  pauseMs: number;
  /** How long a new engine may take to be ready. */
  readyTimeoutMs?: number;
  /** Runs that fail in a row (never ready, or exited) before fatal() is called. */
  maxFailures?: number;
  /** Real ms before a failed run is tried again: with no engine serving (times the failures in a row), and with one. */
  retryMs?: { idle: number; serving: number };
  /** Called after a new engine took over (its port), before the old one is stopped. */
  onSwitch?: (port: number, run: number) => void;
  /** Called when no engine can be kept running (the host should exit, so the platform restarts it). */
  fatal?: (reason: string) => void;
  log?: (line: string) => void;
}

/**
 * Plays the replay in a loop: run 1 on ports[0]; cycleMs + pauseMs after it was ready, run 2 starts on ports[1], takes
 * over once ready, and run 1 stops; and so on. A run that is never ready is stopped and tried again (the one serving
 * keeps serving meanwhile); an engine that exits while serving is replaced at once.
 */
export class ReplayCycler {
  readonly #o: CyclerOptions;
  #current: ReplayEngine | null = null;
  #run = 0;
  #serving = 0;
  #failures = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #nextAt: number | null = null;
  #stopped = false;
  #launching: Promise<void> | null = null;

  constructor(options: CyclerOptions) {
    this.#o = options;
  }

  /** The internal port the proxy sends to, or null while no engine is ready. */
  get target(): number | null {
    return this.#current?.port ?? null;
  }

  /** The run serving now (1 for the first), 0 before any. */
  get serving(): number {
    return this.#current === null ? 0 : this.#serving;
  }

  /** When the next run is due to start (ms), or null while none is scheduled. */
  get nextRunAt(): number | null {
    return this.#nextAt;
  }

  start(): Promise<void> {
    return this.#launch();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#launching?.catch(() => {});
    const current = this.#current;
    this.#current = null;
    await current?.stop();
  }

  #log(line: string): void {
    this.#o.log?.(line);
  }

  #schedule(ms: number): void {
    clearTimeout(this.#timer);
    this.#nextAt = null;
    if (this.#stopped) return;
    this.#nextAt = Date.now() + ms;
    this.#timer = setTimeout(() => void this.#launch(), ms);
    this.#timer.unref?.();
  }

  #launch(): Promise<void> {
    if (this.#stopped || this.#launching !== null) return this.#launching ?? Promise.resolve();
    this.#launching = this.#next().finally(() => {
      this.#launching = null;
    });
    return this.#launching;
  }

  async #next(): Promise<void> {
    const run = ++this.#run;
    const busy = this.#current?.port;
    const port = this.#o.ports[0] === busy ? this.#o.ports[1] : this.#o.ports[0];
    this.#log(`run ${run}: starting the replay engine on 127.0.0.1:${port}`);
    const engine = this.#o.start(port, run);
    const timeoutMs = this.#o.readyTimeoutMs ?? 120_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      engine.ready.then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err))),
      engine.exited.then((how) => `exited before it was ready (${how})`),
      new Promise<string>((r) => {
        timeout = setTimeout(() => r(`not ready within ${timeoutMs / 1000} s`), timeoutMs);
      }),
    ]);
    clearTimeout(timeout);
    if (this.#stopped) {
      await engine.stop();
      return;
    }
    if (outcome !== null) {
      await engine.stop();
      this.#fail(`run ${run}: ${outcome}`);
      return;
    }
    this.#failures = 0;
    const old = this.#current;
    this.#current = engine;
    this.#serving = run;
    this.#o.onSwitch?.(port, run);
    this.#log(`run ${run}: serving; the next run starts in ${Math.round((this.#o.cycleMs + this.#o.pauseMs) / 1000)} s`);
    void engine.exited.then((how) => {
      if (this.#stopped || this.#current !== engine) return;
      this.#current = null;
      this.#fail(`run ${run}: the engine exited while serving (${how})`);
    });
    await old?.stop();
    this.#schedule(this.#o.cycleMs + this.#o.pauseMs);
  }

  #fail(line: string): void {
    this.#failures++;
    const max = this.#o.maxFailures ?? 5;
    this.#log(`${line} (${this.#failures} in a row)`);
    if (this.#failures >= max) {
      this.#o.fatal?.(`${this.#failures} runs in a row failed; the last: ${line}`);
      return;
    }
    // With an engine still serving, its finished hour stays up while the next one is tried; without one, soon.
    const retry = this.#o.retryMs ?? { idle: 2_000, serving: 30_000 };
    this.#schedule(this.#current === null ? retry.idle * this.#failures : retry.serving);
  }
}

/** What the replay engine inherits from the host: the system's own variables, never the host's settings or keys. */
const CHILD_ENV_KEEP = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LC_[A-Z]+|TZ)$/i;

/** The engine's environment: the allowlist above, plus replay mode with the strategy loop on the replay desk. */
export function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && CHILD_ENV_KEEP.test(k)) out[k] = v;
  return { ...out, GIMBAL_MODE: 'replay', GIMBAL_TRADE: '1' };
}

/**
 * What the hosted build writes into index.html (web/vite.config.ts, with VITE_HOSTED_REPLAY=1): the host rebuilds a
 * web/dist without it, so it never serves the normal page with its write controls.
 */
export const HOSTED_BUILD_MARKER = '<meta name="gimbal-build" content="hosted-replay">';

export function isHostedBuild(indexHtml: string): boolean {
  return indexHtml.includes(HOSTED_BUILD_MARKER);
}

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
  '.map': 'application/json; charset=utf-8',
};

/**
 * The file under `webDir` a GET of `urlPath` serves: the file itself, else index.html (the dashboard routes in the
 * page). Null for a path that leaves `webDir` or names a missing asset (a file with an extension).
 */
export function staticFile(webDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const root = resolve(webDir);
  const path = resolve(root, `.${normalize(`/${decoded}`)}`);
  if (path !== root && !path.startsWith(root + sep)) return null;
  if (existsSync(path) && statSync(path).isFile()) return path;
  if (extname(path) !== '') return null;
  return join(root, 'index.html');
}

export interface HostServerOptions {
  /** The built dashboard (web/dist). */
  webDir: string;
  /** The engine's internal port now, or null while none is ready. */
  target: () => number | null;
  gate: StressGate;
  log?: (line: string) => void;
  /** Event streams open at once, for everyone; more are answered 503 (the page retries). */
  maxStreams?: number;
  /** Event streams open at once from one address (clientKey); more are answered 429. */
  maxStreamsPerClient?: number;
  /** Bytes a client may leave unread on one response before it is dropped. */
  maxUnreadBytes?: number;
  /** A line for GET /healthz while serving (which run, where in it). */
  status?: () => Record<string, unknown>;
}

/** What a request to the engine keeps of the browser's headers; Host is the engine's own, Origin is never sent. */
const FORWARD_HEADERS = ['accept', 'content-type', 'last-event-id', 'cache-control'];
/** A client that leaves more than this unread is dropped, as the engine drops its own slow SSE clients (1 MiB). */
export const MAX_UNREAD_BYTES = 1024 * 1024;
/** Event streams per client address: room for several judges' tabs behind one office or venue address. */
export const MAX_STREAMS_PER_CLIENT = 16;

/**
 * Who a request comes from, for the per-client stream cap: behind Railway's proxy X-Real-IP (the client address its
 * edge sets), else the last X-Forwarded-For entry (the one the nearest proxy appended), else the socket's address.
 * A client that forges these gains at most its own extra streams; the global cap still holds.
 */
export function clientKey(req: { headers: IncomingMessage['headers']; socket: { remoteAddress?: string | undefined } }): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim() !== '') return real.trim();
  const xff = req.headers['x-forwarded-for'];
  const list = typeof xff === 'string' ? xff : Array.isArray(xff) ? xff.join(',') : '';
  const last = list.split(',').map((s) => s.trim()).filter((s) => s !== '').at(-1);
  if (last !== undefined) return last;
  return req.socket.remoteAddress ?? 'unknown';
}

/** A request with a body where none belongs (a GET or HEAD): answered 400 and its connection closed, never forwarded. */
function hasBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length.trim() !== '0');
}

export interface HostServer extends Server {
  /** Ends every proxied response (a switch to the next run): the page reconnects to the new one. */
  dropStreams(): void;
  /** What the server holds now: proxied responses open, event streams, bytes written and not yet read by clients. */
  stats(): { proxied: number; streams: number; unreadBytes: number };
}

/**
 * The public server. Every proxied response is written with backpressure: a client that stops reading stops the read
 * from the engine (whose own 1 MiB cap then drops that stream), and one that leaves more than maxUnreadBytes is dropped
 * here, so slow or paused clients cannot grow the host's memory. Requests to the engine use a connection each (no
 * keep-alive), so nothing one request leaves on a socket can reach the next.
 */
export function createHostServer(o: HostServerOptions): HostServer {
  const open = new Set<ServerResponse>();
  const perClient = new Map<string, number>();
  let streams = 0;
  const log = (line: string) => o.log?.(line);
  const agent = new Agent({ keepAlive: false });
  const maxUnread = o.maxUnreadBytes ?? MAX_UNREAD_BYTES;

  const proxy = (
    req: IncomingMessage, res: ServerResponse, port: number, opts: { method?: string; body?: Buffer; headOnly?: boolean } = {},
  ): Promise<{ status: number; text: string | null }> =>
    new Promise((done) => {
      const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
      for (const h of FORWARD_HEADERS) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      // Only a body actually sent is announced: a length with nothing behind it would leave the engine waiting. The
      // only body sent is the host's own JSON ({"on":true} for POST /stress), so its type is the host's too: a visitor's
      // bodyless POST carries no content-type, and copying that would get it refused 415.
      if (opts.body !== undefined) {
        headers['content-length'] = String(opts.body.length);
        headers['content-type'] = 'application/json';
      }
      const up = request({ agent, host: '127.0.0.1', port, method: opts.method ?? req.method, path: req.url, headers }, (upRes) => {
        const status = upRes.statusCode ?? 502;
        const keep: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && k !== 'connection' && k !== 'keep-alive') keep[k] = v;
        res.writeHead(status, keep);
        if (opts.headOnly === true) {
          res.end();
          upRes.destroy();
          done({ status, text: null });
          return;
        }
        open.add(res);
        const chunks: Buffer[] = [];
        let waiting = false;
        upRes.on('data', (c: Buffer) => {
          if (opts.body !== undefined) chunks.push(c);
          if (!res.write(c) && !waiting) {
            waiting = true;
            upRes.pause();
            res.once('drain', () => {
              waiting = false;
              upRes.resume();
            });
          }
          if (res.writableLength > maxUnread) {
            log(`client dropped: ${res.writableLength} bytes unread on ${req.url}, over ${maxUnread}`);
            res.destroy();
            upRes.destroy();
          }
        });
        upRes.on('end', () => {
          res.end();
          done({ status, text: opts.body === undefined ? null : Buffer.concat(chunks).toString('utf8') });
        });
        // The engine stopped mid-stream: end the browser's side too, so the page notices and reconnects.
        upRes.on('close', () => {
          open.delete(res);
          if (!res.writableEnded) res.destroy();
          done({ status, text: null });
        });
      });
      up.on('error', () => {
        if (!res.headersSent) sendJson(res, 503, { ok: false, reason: 'The replay is starting over; try again in a few seconds.', error: 'engine not answering' });
        else res.destroy();
        done({ status: 503, text: null });
      });
      res.on('close', () => {
        open.delete(res);
        up.destroy();
      });
      up.end(opts.body);
    });

  const readState = async (port: number): Promise<EngineState | null> => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(5_000) });
      return r.ok ? ((await r.json()) as EngineState) : null;
    } catch {
      return null;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://host');
    const route = hostedRoute(method, url.pathname);
    res.setHeader('x-content-type-options', 'nosniff');
    if (route.kind === 'refuse') {
      res.setHeader('connection', 'close');
      req.resume();
      return sendJson(res, route.status, route.body);
    }
    if (route.kind !== 'stress' && hasBody(req)) {
      res.setHeader('connection', 'close');
      req.resume();
      return sendJson(res, 400, { ok: false, reason: `${method} ${url.pathname} takes no body`, error: 'body' });
    }
    if (route.kind === 'health') {
      const port = o.target();
      return sendJson(res, port === null ? 503 : 200, { ok: port !== null, ...(o.status?.() ?? {}) });
    }
    if (route.kind === 'static') {
      const file = staticFile(o.webDir, url.pathname);
      if (file === null || !existsSync(file)) return sendJson(res, 404, { error: `no file ${url.pathname}` });
      const hashed = url.pathname.startsWith('/assets/');
      res.writeHead(200, {
        'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      if (method === 'HEAD') return void res.end();
      createReadStream(file).pipe(res);
      return;
    }
    const port = o.target();
    if (port === null) {
      req.resume();
      return sendJson(res, 503, { ok: false, reason: 'The replay is starting; try again in a few seconds.', error: 'engine not ready' });
    }
    if (route.kind === 'proxy') {
      const stream = url.pathname === '/events' || url.pathname.startsWith('/events/');
      // HEAD is a GET without the body: answered here for the stream, with the engine's headers for the rest.
      if (method === 'HEAD') {
        if (stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' });
          return void res.end();
        }
        await proxy(req, res, port, { method: 'GET', headOnly: true });
        return;
      }
      if (stream) {
        const key = clientKey(req);
        const mine = perClient.get(key) ?? 0;
        if (streams >= (o.maxStreams ?? 500)) return sendJson(res, 503, { error: 'too many open streams; the page retries' });
        if (mine >= (o.maxStreamsPerClient ?? MAX_STREAMS_PER_CLIENT)) {
          return sendJson(res, 429, { error: `${mine} streams are open from this address already; close a tab and the page retries` });
        }
        streams++;
        perClient.set(key, mine + 1);
        res.on('close', () => {
          streams--;
          const n = (perClient.get(key) ?? 1) - 1;
          if (n <= 0) perClient.delete(key);
          else perClient.set(key, n);
        });
      }
      await proxy(req, res, port);
      return;
    }
    // POST /stress. A cross-site page cannot fire it: an Origin, when sent, must be this page's own.
    const origin = req.headers.origin;
    if (origin !== undefined && hostOf(origin) !== (req.headers.host ?? '').toLowerCase()) {
      req.resume();
      return sendJson(res, 403, { ok: false, reason: `POST /stress from ${origin} is refused: only this page may send it`, error: 'origin' });
    }
    let body: Buffer;
    try {
      body = await readSmall(req, 1024);
    } catch (err) {
      return sendJson(res, 400, { ok: false, reason: `POST /stress: ${err instanceof Error ? err.message : String(err)}`, error: 'body' });
    }
    // Checked before the gate: a refused body does not use up the run's stress test.
    const problem = stressBodyProblem(body.toString('utf8'));
    if (problem !== null) return sendJson(res, 400, { ok: false, reason: `POST /stress: ${problem}`, error: 'body' });
    const refused = o.gate.busy() ?? o.gate.check(await readState(port));
    if (refused !== null) {
      if (refused.retryAfterS !== undefined) res.setHeader('retry-after', String(refused.retryAfterS));
      return sendJson(res, refused.status, { ok: false, reason: refused.reason, error: refused.reason });
    }
    o.gate.begin();
    let accepted = false;
    try {
      const answer = await proxy(req, res, port, { body: Buffer.from('{"on":true}') });
      accepted = answer.status === 200;
      log(`POST /stress: ${accepted ? 'started' : `refused by the engine (${answer.status}) ${answer.text ?? ''}`}`);
    } finally {
      o.gate.end(accepted);
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
  return Object.assign(server, {
    dropStreams(): void {
      for (const res of open) res.destroy();
      open.clear();
    },
    stats() {
      let unreadBytes = 0;
      for (const res of open) unreadBytes += res.writableLength;
      return { proxied: open.size, streams, unreadBytes };
    },
  });
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

function readSmall(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((ok, bad) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        bad(new Error(`body over ${max} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', bad);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
