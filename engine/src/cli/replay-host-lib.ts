// The hosted replay's parts (replay-host.ts runs them), kept apart so they are tested without a child engine:
//   hostedRoute()    which requests the public port answers, and how: the dashboard's files, the engine's GET routes,
//                    POST /stress through StressGate, everything else refused as read-only;
//   StressGate       POST /stress one at a time, at most one a minute for all visitors, only while a pair is held;
//   ReplayCycler     starts the replay engine, and once its recorded hour has played (plus a pause on the flat desk)
//                    starts a fresh one on the other internal port, switches the proxy to it and stops the old one;
//   childEnv()       the engine's environment: an allowlist, so no variable of the host (a key, a token) reaches it;
//   createHostServer the public HTTP server: one origin for the built dashboard and the engine's read routes.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
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

/** Real ms between two stress tests the engine accepted, for everyone together. */
export const STRESS_COOLDOWN_MS = 60_000;

/**
 * POST /stress for the public: the engine itself refuses one with no leg open; this also keeps it to one at a time,
 * one a minute for all visitors, and never while a rescue runs, so a crowd of clicks cannot keep the desk in rescue.
 */
export class StressGate {
  readonly #cooldownMs: number;
  readonly #now: () => number;
  #inFlight = false;
  #lastAccepted: number | null = null;

  constructor(options: { cooldownMs?: number; now?: () => number } = {}) {
    this.#cooldownMs = options.cooldownMs ?? STRESS_COOLDOWN_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Why a stress test cannot start now, given the engine's GET /state (null: it did not answer). */
  check(state: Pick<EngineState, 'desk' | 'rescue'> | null): StressRefusal | null {
    if (this.#inFlight) return { status: 409, reason: 'A stress test request is being handled right now; watch it on Rescue.' };
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
    if (this.#lastAccepted !== null) {
      const left = this.#lastAccepted + this.#cooldownMs - this.#now();
      if (left > 0) {
        const s = Math.ceil(left / 1000);
        return { status: 429, reason: `One stress test a minute for all visitors; the next one in ${s} s.`, retryAfterS: s };
      }
    }
    return null;
  }

  /** A request goes to the engine: no other until end(). */
  begin(): void {
    this.#inFlight = true;
  }

  /** The engine answered; `accepted` starts the cooldown. */
  end(accepted: boolean): void {
    this.#inFlight = false;
    if (accepted) this.#lastAccepted = this.#now();
  }

  /** A new replay starts: the last one's cooldown does not carry over. */
  reset(): void {
    this.#lastAccepted = null;
  }
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
    if (this.#stopped) return;
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
  /** A line for GET /healthz while serving (which run, where in it). */
  status?: () => Record<string, unknown>;
}

/** What a request to the engine keeps of the browser's headers; Host is the engine's own, Origin is never sent. */
const FORWARD_HEADERS = ['accept', 'content-type', 'content-length', 'last-event-id', 'cache-control'];

/**
 * The public server. Requests proxied to the engine are tracked, so a switch to the next run ends them (dropStreams):
 * the page sees its stream close, reconnects, and reads the new run's GET /state.
 */
export function createHostServer(o: HostServerOptions): Server & { dropStreams(): void } {
  const open = new Set<ServerResponse>();
  let streams = 0;
  const log = (line: string) => o.log?.(line);

  const proxy = (req: IncomingMessage, res: ServerResponse, port: number, body?: Buffer): Promise<{ status: number; text: string | null }> =>
    new Promise((done) => {
      const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
      for (const h of FORWARD_HEADERS) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      if (body !== undefined) headers['content-length'] = String(body.length);
      const up = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (upRes) => {
        const status = upRes.statusCode ?? 502;
        const keep: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && k !== 'connection') keep[k] = v;
        res.writeHead(status, keep);
        open.add(res);
        const chunks: Buffer[] = [];
        upRes.on('data', (c: Buffer) => {
          if (body !== undefined) chunks.push(c);
          res.write(c);
        });
        upRes.on('end', () => {
          res.end();
          done({ status, text: body === undefined ? null : Buffer.concat(chunks).toString('utf8') });
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
      up.end(body);
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
      req.resume();
      return sendJson(res, route.status, route.body);
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
      const stream = url.pathname.startsWith('/events');
      if (stream) {
        if (streams >= (o.maxStreams ?? 500)) return sendJson(res, 503, { error: 'too many open streams; the page retries' });
        streams++;
        res.on('close', () => streams--);
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
    const refused = o.gate.check(await readState(port));
    if (refused !== null) {
      if (refused.retryAfterS !== undefined) res.setHeader('retry-after', String(refused.retryAfterS));
      return sendJson(res, refused.status, { ok: false, reason: refused.reason, error: refused.reason });
    }
    o.gate.begin();
    let accepted = false;
    try {
      const answer = await proxy(req, res, port, body);
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
