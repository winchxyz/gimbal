// The engine's HTTP side (docs/interfaces.md §2), on ENGINE_PORT (8790):
//   GET /events                  SSE, one StreamEvent per message ("data: <json>")
//   GET /state                   EngineState: the latest of each event type
//   GET /windows/history?id=     WindowHistory of one window (404 when the last scan did not list it)
//   GET /strategy, PUT /strategy StrategyConfig (PUT takes the whole config, checked, and answers the new one)
//   GET /journal?before=<id>     JournalEntry[]: up to 100 entries older than that id, newest first ([] past the
//                                oldest, and for an id not in memory); without `before`, the newest 100
// The scanner feeds it: every scan publishes a `scan` and a `windows` event; the risk engine (src/risk/) publishes
// `desk`, `health`, `journal` and `rescue`, and answers POST /stress (testnet and replay only). The strategy loop
// (src/strategy/loop.ts) publishes `decision` and answers POST /rotate {windowId} and POST /close in their own
// { ok, reason } shape: accepted (200) or refused with the reason (400 bad body, 409 refused, 503 no loop) at once,
// the progress coming as journal and desk events.
//
// Only this machine's dashboard may use it. PUT /strategy changes what the desk trades, and a web page on any other
// site could otherwise reach a local server (a cross-site form post, or DNS rebinding a name onto 127.0.0.1), so:
// - it listens on 127.0.0.1 unless told otherwise (GIMBAL_HOST);
// - a Host header that does not name this machine (localhost, 127.0.0.1, [::1], or the address it was told to bind)
//   is refused, which stops DNS rebinding; the dashboard's dev proxy rewrites Host to the engine's, so it passes;
// - an Origin header other than the dashboard's own (dev and preview, on localhost) is refused;
// - POST and PUT need a JSON content type, which a cross-site form cannot send without a CORS preflight, and the
//   engine answers no preflight.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ContractPolicy, DeskState, EngineState, HealthMap, JournalEntry, Mode, RescueProgress, ScanStatus, SetupProgress,
  StrategyConfig, StrategyDecision, StreamEvent, Window as FundingWindow,
} from '@gimbal/shared';
import { errorMessage } from './venues/recorder.ts';
import { policyDraftRoute } from './nearai/draft-route.ts';
import type { PolicyDrafter } from './nearai/draft-route.ts';
import { setupRoute } from './setup/route.ts';
import type { SetupStarter } from './setup/route.ts';
import { parseStrategyConfig } from './scanner/config.ts';
import type { ScanResult, Scanner } from './scanner/scanner.ts';
import type { RiskEngine } from './risk/engine.ts';
import { stressRoute } from './risk/stress-route.ts';

export const DEFAULT_ENGINE_PORT = 8790;
export const DEFAULT_ENGINE_HOST = '127.0.0.1';
/** The dashboard's origins: Vite dev and preview both serve it on port 5190 (web/vite.config.ts). */
export const DEFAULT_WEB_ORIGINS: readonly string[] = ['http://localhost:5190', 'http://127.0.0.1:5190', 'http://[::1]:5190'];
/** Names a Host header may carry for this machine, with or without a port. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Journal entries per page: GET /state's newest and each GET /journal?before= page. */
const JOURNAL_PAGE = 100;
/** Entries kept in memory for paging back; older ones are not served (the journal is not persisted yet). */
const JOURNAL_KEEP = 5_000;
const HEARTBEAT_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;
/**
 * An SSE client with more than this queued and unread is dropped: a stalled tab would otherwise make the engine
 * hold every event since it stalled. EventSource reconnects on its own and gets the latest state first.
 */
const SSE_MAX_BUFFER_BYTES = 1024 * 1024;
/**
 * A refused request is logged at most once this often per kind of refusal (Host, Origin, content type), with a count
 * of the ones left out: a page retrying, or something probing the port, would otherwise write a line per request.
 * The count is logged when the next line of its kind is, or when the period ends, whichever comes first.
 */
const REFUSED_LOG_EVERY_MS = 60_000;

type RefusalKind = 'host' | 'origin' | 'content-type';

/** What the refused requests of each kind had in common, for the line that counts them. */
const REFUSED_WHAT: Record<RefusalKind, string> = {
  host: 'whose Host is not this machine',
  origin: 'from an Origin other than the dashboard\'s',
  'content-type': 'without content-type application/json',
};

interface RefusedLog {
  at: number;
  skipped: number;
  /** Logs `skipped` when the period ends, if no line of this kind has by then. */
  flush?: ReturnType<typeof setTimeout>;
}

export interface EngineServerOptions {
  mode: Mode;
  scanner: Scanner;
  strategy: StrategyConfig;
  policy: ContractPolicy | null;
  /** ms between the end of one scan and the start of the next one; the scan's own time counts against it. */
  intervalMs: number;
  /** Real-time clock for EngineState.at and the refused-request log (the scanner keeps its own, virtual in replay). */
  now?: () => number;
  log?: (line: string) => void;
  /** Called after every scan, with what it produced. */
  onScan?: (result: ScanResult) => void;
  /** Origins allowed to call the engine from a browser; default DEFAULT_WEB_ORIGINS. */
  allowedOrigins?: readonly string[];
  /** Unread SSE bytes after which a client is dropped; default 1 MiB. */
  sseMaxBufferBytes?: number;
  /** POST /policy/draft (src/nearai/draft-route.ts); none = 503, drafting is unavailable. */
  drafter?: Pick<PolicyDrafter, 'draft'>;
  /** Persists a confirmed PUT /strategy before it takes effect (src/strategy-store.ts); none = memory only. */
  saveStrategy?: (strategy: StrategyConfig) => Promise<void>;
  /** POST /setup (src/setup/route.ts); none = 503, venue setup is off. */
  setup?: SetupStarter;
  /** POST /stress (src/risk/stress-route.ts); none = 503 (mainnet is refused either way). */
  stress?: Pick<RiskEngine, 'stress'>;
  /** POST /rotate and /close (src/strategy/loop.ts); none = 503, nothing is entered or closed here. */
  strategyLoop?: StrategyHands;
  /** Called after a PUT /strategy took effect (the loop checks at once, so `auto` shows without waiting a scan). */
  onStrategy?: (strategy: StrategyConfig) => void;
}

/** What POST /rotate and /close call: they answer at once, whether the act was started or why not. */
export interface StrategyHands {
  rotate(windowId: unknown): { ok: true } | { ok: false; reason: string };
  close(): { ok: true } | { ok: false; reason: string };
}

type Latest = {
  windows: FundingWindow[] | null;
  scan: ScanStatus | null;
  desk: DeskState | null;
  rescue: RescueProgress | null;
  setup: SetupProgress | null;
  health: HealthMap | null;
  decision: StrategyDecision | null;
};

export class EngineServer {
  readonly #options: EngineServerOptions;
  readonly #server: Server;
  readonly #clients = new Set<ServerResponse>();
  readonly #latest: Latest = { windows: null, scan: null, desk: null, rescue: null, setup: null, health: null, decision: null };
  readonly #journal: JournalEntry[] = [];
  #strategy: StrategyConfig;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #scanning: Promise<void> | null = null;
  #hostnames = new Set(LOCAL_HOSTNAMES);
  readonly #origins: ReadonlySet<string>;
  readonly #refusedLogged = new Map<RefusalKind, RefusedLog>();

  constructor(options: EngineServerOptions) {
    this.#options = options;
    this.#strategy = options.strategy;
    this.#origins = new Set(options.allowedOrigins ?? DEFAULT_WEB_ORIGINS);
    this.#server = createServer((req, res) => {
      this.#route(req, res).catch((err: unknown) => {
        this.#log(`${req.method} ${req.url}: ${errorMessage(err)}`);
        if (!res.headersSent) json(res, 500, { error: 'internal error' });
        else res.end();
      });
    });
  }

  /** The engine rules the scanner reads at the start of every scan. */
  get strategy(): StrategyConfig {
    return this.#strategy;
  }

  /** SSE clients connected now. */
  get clientCount(): number {
    return this.#clients.size;
  }

  /** Where it listens, once started. */
  get address(): { host: string; port: number } | null {
    const a = this.#server.address();
    return a === null || typeof a === 'string' ? null : { host: a.address, port: a.port };
  }

  /**
   * Listens on `host`:`port` (0 = any free port) and starts scanning; resolves with the port it listens on. A
   * specific address to bind is also accepted as a Host header (a wildcard such as 0.0.0.0 is not a name).
   */
  async start(port: number, host: string = DEFAULT_ENGINE_HOST): Promise<number> {
    const bound = host.includes(':') ? `[${host.toLowerCase()}]` : host.toLowerCase();
    if (host !== '0.0.0.0' && host !== '::') this.#hostnames.add(bound);
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    this.#running = true;
    this.#heartbeat = setInterval(() => this.#write(': ping\n\n'), HEARTBEAT_MS);
    this.#loop();
    return (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.#running = false;
    clearTimeout(this.#timer);
    clearInterval(this.#heartbeat);
    for (const kind of this.#refusedLogged.keys()) this.#flushRefused(kind);
    await this.#scanning;
    for (const res of this.#clients) res.end();
    this.#clients.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** Sends one event to every client and keeps it for GET /state. */
  publish(event: StreamEvent): void {
    if (event.type === 'journal') {
      this.#journal.unshift(event.data);
      this.#journal.length = Math.min(this.#journal.length, JOURNAL_KEEP);
    } else {
      (this.#latest as Record<string, unknown>)[event.type] = event.data;
    }
    this.#write(`data: ${JSON.stringify(event)}\n\n`);
  }

  state(): EngineState {
    return {
      mode: this.#options.mode,
      windows: this.#latest.windows,
      scan: this.#latest.scan,
      strategy: this.#strategy,
      desk: this.#latest.desk,
      journal: this.#journal.slice(0, JOURNAL_PAGE),
      rescue: this.#latest.rescue,
      setup: this.#latest.setup,
      health: this.#latest.health,
      decision: this.#latest.decision,
      at: (this.#options.now ?? Date.now)(),
    };
  }

  /** One scan now, published like the loop's (tests drive the server with it). */
  async scanOnce(): Promise<ScanResult> {
    const result = await this.#options.scanner.scan();
    this.publish({ type: 'scan', data: result.scan });
    this.publish({ type: 'windows', data: result.windows });
    this.#options.onScan?.(result);
    return result;
  }

  #loop(): void {
    if (!this.#running) return;
    const started = Date.now();
    this.#scanning = this.scanOnce().then(
      () => undefined,
      (err: unknown) => {
        this.#log(`scan failed: ${errorMessage(err)}`);
        // The last windows are no longer current: say so rather than serve them as fresh.
        const last = this.#latest.windows;
        if (last !== null && last.some((w) => !w.stale)) this.publish({ type: 'windows', data: last.map((w) => ({ ...w, stale: true })) });
      },
    ).finally(() => {
      this.#scanning = null;
      if (!this.#running) return;
      const wait = Math.max(0, this.#options.intervalMs - (Date.now() - started));
      this.#timer = setTimeout(() => this.#loop(), wait);
    });
  }

  #write(chunk: string): void {
    for (const res of this.#clients) this.#send(res, chunk);
  }

  /** Writes to one SSE client, and drops it once it has more queued than it reads. */
  #send(res: ServerResponse, chunk: string): void {
    res.write(chunk);
    const cap = this.#options.sseMaxBufferBytes ?? SSE_MAX_BUFFER_BYTES;
    if (res.writableLength > cap) {
      this.#clients.delete(res);
      this.#log(`SSE client dropped: ${res.writableLength} bytes unread, over ${cap}`);
      res.destroy();
    }
  }

  /** Why a request is refused before routing (see the top of this file), or null. */
  #refusal(req: IncomingMessage): { status: number; error: string; kind: RefusalKind } | null {
    const host = (req.headers.host ?? '').toLowerCase();
    const name = /^(\[[0-9a-f:.]*\]|[^:[\]]+)(:\d+)?$/.exec(host)?.[1];
    if (name === undefined || !this.#hostnames.has(name)) {
      return { status: 403, kind: 'host', error: `host ${JSON.stringify(req.headers.host ?? '')} is not this machine: the engine answers its own dashboard only` };
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !this.#origins.has(origin)) {
      return { status: 403, kind: 'origin', error: `origin ${JSON.stringify(origin)} is not the dashboard's` };
    }
    const method = req.method ?? 'GET';
    // POST /stress takes no body (`curl -X POST localhost:8790/stress`); a cross-site page still cannot reach it, a
    // browser sends its Origin with every POST and the Origin check above refuses it.
    const bodyless = req.headers['content-length'] === undefined || req.headers['content-length'] === '0';
    const noBodyStress = method === 'POST' && bodyless && req.headers['transfer-encoding'] === undefined
      && new URL(req.url ?? '/', 'http://engine').pathname.replace(/\/+$/, '') === '/stress';
    if ((method === 'POST' || method === 'PUT') && !noBodyStress) {
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') return { status: 415, kind: 'content-type', error: `${method} needs content-type application/json` };
    }
    return null;
  }

  #log(line: string): void {
    this.#options.log?.(line);
  }

  /**
   * One line per kind of refusal per REFUSED_LOG_EVERY_MS, saying how many were left out since the last one. Keyed by
   * kind, not by the Host or Origin sent, so varying those cannot grow the map or the log.
   */
  #logRefused(kind: RefusalKind, line: string): void {
    const now = (this.#options.now ?? Date.now)();
    const last = this.#refusedLogged.get(kind);
    if (last !== undefined && now >= last.at && now - last.at < REFUSED_LOG_EVERY_MS) {
      last.skipped++;
      if (last.flush === undefined) {
        // A burst that stops still has its count logged once the period is up. Unref'd: it never holds the process.
        last.flush = setTimeout(() => this.#flushRefused(kind), last.at + REFUSED_LOG_EVERY_MS - now);
        last.flush.unref();
      }
      return;
    }
    const skipped = last === undefined || last.skipped === 0 ? '' : ` (and ${last.skipped} more like it since the last line)`;
    clearTimeout(last?.flush);
    this.#refusedLogged.set(kind, { at: now, skipped: 0 });
    this.#log(`${line}${skipped}`);
  }

  /** Logs how many refusals of `kind` were left out since its last line, if any. */
  #flushRefused(kind: RefusalKind): void {
    const last = this.#refusedLogged.get(kind);
    if (last === undefined) return;
    clearTimeout(last.flush);
    delete last.flush;
    if (last.skipped === 0) return;
    this.#log(`refused ${last.skipped} more ${last.skipped === 1 ? 'request' : 'requests'} ${REFUSED_WHAT[kind]} since the last line`);
    last.skipped = 0;
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://engine');
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const refused = this.#refusal(req);
    if (refused !== null) {
      this.#logRefused(refused.kind, `refused ${method} ${path}: ${refused.error}`);
      return json(res, refused.status, { error: refused.error });
    }

    if (path === '/events') {
      if (method !== 'GET') return notAllowed(res, 'GET');
      return this.#events(req, res);
    }
    if (path === '/state') {
      if (method !== 'GET') return notAllowed(res, 'GET');
      return json(res, 200, this.state());
    }
    if (path === '/windows/history') {
      if (method !== 'GET') return notAllowed(res, 'GET');
      const id = url.searchParams.get('id');
      if (id === null || id === '') return json(res, 400, { error: 'GET /windows/history needs ?id=<window id>' });
      const history = this.#options.scanner.history(id);
      if (history === null) return json(res, 404, { error: `no history for ${id}: the last scan did not list it` });
      return json(res, 200, history);
    }
    if (path === '/journal') {
      if (method !== 'GET') return notAllowed(res, 'GET');
      const before = url.searchParams.get('before');
      if (before === null || before === '') return json(res, 200, this.#journal.slice(0, JOURNAL_PAGE));
      // An id not in memory (older than the last JOURNAL_KEEP, or never seen) has nothing older to page to.
      const at = this.#journal.findIndex((e) => e.id === before);
      if (at === -1) return json(res, 200, []);
      return json(res, 200, this.#journal.slice(at + 1, at + 1 + JOURNAL_PAGE));
    }
    if (path === '/strategy') {
      if (method === 'GET') return json(res, 200, this.#strategy);
      if (method !== 'PUT') return notAllowed(res, 'GET, PUT');
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return json(res, 400, { error: `PUT /strategy: ${errorMessage(err)}` });
      }
      let next: StrategyConfig;
      try {
        next = parseStrategyConfig(body, this.#options.policy);
      } catch (err) {
        return json(res, 400, { error: errorMessage(err) });
      }
      try {
        await this.#options.saveStrategy?.(next);
      } catch (err) {
        return json(res, 500, { error: `PUT /strategy: not saved, so nothing changed: ${errorMessage(err)}` });
      }
      this.#strategy = next;
      this.#log(`strategy set: ${JSON.stringify(this.#strategy)}`);
      this.#options.onStrategy?.(next);
      return json(res, 200, this.#strategy);
    }
    if (path === '/policy/draft') {
      if (method !== 'POST') return notAllowed(res, 'POST');
      const answer = await policyDraftRoute(() => readBody(req), this.#options.drafter ?? null, (line) => this.#log(line));
      return json(res, answer.status, answer.body);
    }
    if (path === '/setup') {
      if (method !== 'POST') return notAllowed(res, 'POST');
      const answer = await setupRoute(() => readBody(req), this.#options.setup ?? null, (p) => this.publish({ type: 'setup', data: p }));
      return json(res, answer.status, answer.body);
    }
    if (path === '/rotate' || path === '/close') {
      if (method !== 'POST') return notAllowed(res, 'POST');
      let body: unknown = {};
      try {
        const text = await readBody(req);
        if (text.trim() !== '') body = JSON.parse(text);
      } catch (err) {
        return json(res, 400, { ok: false, reason: `POST ${path}: ${errorMessage(err)}` });
      }
      const loop = this.#options.strategyLoop;
      if (loop === undefined) return json(res, 503, { ok: false, reason: 'no strategy loop in this engine: nothing is entered or closed here' });
      let answer: { ok: true } | { ok: false; reason: string };
      if (path === '/rotate') {
        const windowId = body !== null && typeof body === 'object' ? (body as { windowId?: unknown }).windowId : undefined;
        if (typeof windowId !== 'string' || windowId.trim() === '') return json(res, 400, { ok: false, reason: 'POST /rotate needs { "windowId": "<window id>" }' });
        answer = loop.rotate(windowId);
      } else {
        answer = loop.close();
      }
      this.#log(`${path === '/rotate' ? 'POST /rotate' : 'POST /close'}: ${answer.ok ? 'started' : `refused, ${answer.reason}`}`);
      return json(res, answer.ok ? 200 : 409, answer);
    }
    if (path === '/stress') {
      if (method !== 'POST') return notAllowed(res, 'POST');
      const answer = await stressRoute(this.#options.mode, () => readBody(req), this.#options.stress ?? null);
      return json(res, answer.status, answer.body);
    }
    return json(res, 404, { error: `no route ${method} ${path}` });
  }

  /** An SSE stream. A new client first gets the latest windows and scan (if any), then every event as it comes. */
  #events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.#clients.add(res);
    this.#send(res, 'retry: 5000\n\n');
    for (const type of ['scan', 'windows', 'desk', 'health', 'setup', 'rescue', 'decision'] as const) {
      const data = this.#latest[type];
      if (data !== null && this.#clients.has(res)) this.#send(res, `data: ${JSON.stringify({ type, data })}\n\n`);
    }
    const drop = () => this.#clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function notAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('allow', allow);
  json(res, 405, { error: `method not allowed; use ${allow}` });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
