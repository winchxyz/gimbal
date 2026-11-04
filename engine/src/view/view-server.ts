// The read-only view listener: the engine's GET side for a dashboard that is not on this machine (the demo, the
// owner watching the Railway engine). Opt in, off unless GIMBAL_VIEW_TOKEN and a port are set (view-config.ts):
//   GET /healthz                 { ok: true }, no token
//   GET /view-ticket             { ticket, expiresAt }: a short-lived, single-use ticket for GET /events?ticket=
//   GET /events                  SSE, as the engine's (src/server.ts), with Authorization or ?ticket=
//   GET /state, /journal?before=, /strategy, /windows/history?id=   as the engine's
// Everything else is 404 (another path) or 405 (another method, PUT and POST included), answered before any body is
// read. It is built on a ViewSource (EngineServer.viewSource): plain read functions and the event stream, never the
// engine server itself, so no request here can reach PUT /strategy, POST /rotate or POST /close; those stay on the
// engine's own listener, on 127.0.0.1.
//
// Auth: `Authorization: Bearer <GIMBAL_VIEW_TOKEN>`, compared in constant time (both sides hashed first, so the
// length does not leak either). EventSource cannot send headers, so /events also takes ?ticket=<t> from GET
// /view-ticket: an HMAC under a key made at start (a restart voids every ticket), valid TICKET_TTL_MS and once. The
// token itself never goes in a URL, so it is never in a proxy's or a browser's history; a ticket that is, is spent.
// At most MAX_TICKETS are outstanding: a new one retires the oldest, so whoever asks for tickets never locks the
// owner out. The credentials are checked first: a right one is always served (a shared IP's failures never refuse
// it). A client with FAIL_LIMIT failed tries in FAIL_WINDOW_MS gets 429 instead of 401 on each further failure. The
// client is the last X-Forwarded-For entry, which assumes exactly one proxy appends to that header in front of the
// view (Railway's edge); without a proxy, the socket's address.
//
// It must never hold serve's shutdown: a request has REQUEST_TIMEOUT_MS to arrive in full, stop() closes every
// connection and returns within STOP_WAIT_MS whatever a client does, and a listener error is logged, never thrown.
//
// CORS: a request whose Origin is not in GIMBAL_VIEW_ORIGINS is refused (403); a listed one gets
// Access-Control-Allow-Origin for itself, and its preflight (OPTIONS, for the Authorization header) is answered.
// A request with no Origin (curl, a server) is not a browser's and passes to the token check.
//
// Every payload goes through the redactor (view-redact.ts) before it is sent. Log lines carry the method and the
// path, never the query (a ticket) or a header (the token).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EngineState, JournalEntry, StrategyConfig, StreamEvent, WindowHistory } from '@gimbal/shared';
import type { Redactor } from './view-redact.ts';

/** What the view may read of the engine: no method here changes anything. */
export interface ViewSource {
  state(): EngineState;
  journal(before: string | null): JournalEntry[];
  history(windowId: string): WindowHistory | null;
  strategy(): StrategyConfig;
  subscribe(listener: (event: StreamEvent) => void): () => void;
}

export const TICKET_TTL_MS = 30_000;
export const FAIL_LIMIT = 10;
export const FAIL_WINDOW_MS = 60_000;
/** Clients whose failures are remembered; past this the oldest is forgotten, so the map stays bounded. */
const FAIL_CLIENTS_MAX = 10_000;
/** Unspent tickets kept; a new one past this retires the oldest. */
export const MAX_TICKETS = 8;
/** Time for a request's headers and body to arrive; a client dripping a body is cut off after it. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** stop() returns after this at the latest. */
export const STOP_WAIT_MS = 3_000;
/** SSE streams at once: a leaked token cannot make the engine hold more. */
export const MAX_STREAMS = 32;
const HEARTBEAT_MS = 15_000;
const SSE_MAX_BUFFER_BYTES = 1024 * 1024;
const LOG_EVERY_MS = 60_000;
const ROUTES = new Set(['/events', '/state', '/journal', '/strategy', '/windows/history', '/view-ticket']);
/** The engine's /events sends these first, from its latest of each; so does the view. */
const SNAPSHOT_TYPES = ['scan', 'windows', 'desk', 'health', 'setup', 'rescue', 'decision'] as const;
const COMMON_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

type LogKind = 'auth' | 'origin' | 'limited';

export interface ViewServerOptions {
  source: ViewSource;
  token: string;
  /** Browser origins allowed (CORS); others are refused. */
  origins: readonly string[];
  redact: Redactor;
  now?: () => number;
  log?: (line: string) => void;
  ticketTtlMs?: number;
  failLimit?: number;
  maxStreams?: number;
  sseMaxBufferBytes?: number;
  requestTimeoutMs?: number;
  stopWaitMs?: number;
}

export class ViewServer {
  readonly #o: ViewServerOptions;
  readonly #server: Server;
  readonly #origins: ReadonlySet<string>;
  readonly #tokenHash: Buffer;
  /** HMAC key for tickets: random per start, never written anywhere. */
  readonly #ticketKey = randomBytes(32);
  /** Unspent tickets: nonce -> expiry. */
  readonly #tickets = new Map<string, number>();
  readonly #fails = new Map<string, { count: number; since: number }>();
  readonly #clients = new Set<ServerResponse>();
  readonly #logged = new Map<LogKind, { at: number; skipped: number }>();
  #unsubscribe: (() => void) | null = null;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(options: ViewServerOptions) {
    this.#o = options;
    this.#origins = new Set(options.origins);
    this.#tokenHash = sha256(options.token);
    const timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#server = createServer({
      requestTimeout: timeout,
      headersTimeout: timeout,
      // Node checks those timeouts this often (default 30 s), so a 10 s limit is enforced within about a second.
      connectionsCheckingInterval: Math.min(1_000, timeout),
    }, (req, res) => {
      try {
        this.#route(req, res);
      } catch {
        // No error text: it could quote what was asked.
        this.#log(`view: ${req.method} ${pathOf(req)}: internal error`);
        if (!res.headersSent) json(res, 500, { error: 'internal error' });
        else res.destroy();
      }
    });
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** The node:http server underneath, for tests. */
  get httpServer(): Server {
    return this.#server;
  }

  /** Listens on `host`:`port` (0 = any free port); resolves with the port. */
  async start(port: number, host = '0.0.0.0'): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    // From here an error on the listener is a log line: with no listener node would throw it and stop serve.
    this.#server.on('error', (err) => this.#log(`view: listener error: ${err instanceof Error ? err.message : String(err)}`));
    this.#unsubscribe = this.#o.source.subscribe((event) => {
      if (this.#clients.size === 0) return;
      const chunk = `data: ${JSON.stringify(this.#o.redact(event))}\n\n`;
      for (const res of this.#clients) this.#send(res, chunk);
    });
    this.#heartbeat = setInterval(() => {
      for (const res of this.#clients) this.#send(res, ': ping\n\n');
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
    return (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    clearInterval(this.#heartbeat);
    for (const kind of this.#logged.keys()) this.#flushLog(kind);
    for (const res of this.#clients) res.end();
    this.#clients.clear();
    const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
    // Idle keep-alive sockets and requests still arriving (a body dripped on purpose) would hold close() open.
    this.#server.closeAllConnections();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#o.stopWaitMs ?? STOP_WAIT_MS);
      timer.unref();
    });
    await Promise.race([closed, bounded]);
    clearTimeout(timer);
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  #route(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://view');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    for (const [k, v] of Object.entries(COMMON_HEADERS)) res.setHeader(k, v);
    // No route reads a body: a request that sends one (a refused write, or a GET with a body dripped to hold the
    // socket) has the connection closed after the answer, so the unread body is neither waited for nor taken for the
    // next request on it.
    const hasBody = (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
      || req.headers['transfer-encoding'] !== undefined;
    if (hasBody || (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS')) res.setHeader('connection', 'close');

    if (path === '/healthz') {
      if (method !== 'GET' && method !== 'HEAD') return notAllowed(res);
      return json(res, 200, { ok: true });
    }
    if (!ROUTES.has(path)) return json(res, 404, { error: 'not found' });

    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!this.#origins.has(origin)) {
        this.#logRefused('origin', `view: refused ${method} ${path}: origin not in GIMBAL_VIEW_ORIGINS`);
        return json(res, 403, { error: 'origin not allowed' });
      }
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    }
    if (method === 'OPTIONS' && origin !== undefined) {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET',
        'access-control-allow-headers': 'authorization',
        'access-control-max-age': '600',
      });
      return void res.end();
    }
    if (method !== 'GET') return notAllowed(res);

    const ticket = path === '/events' ? url.searchParams.get('ticket') : null;
    // A ticket is checked here and spent only once the stream opens, so a stream refused for the cap does not cost
    // the viewer its ticket; an outsider gets 401 before the cap is looked at.
    const nonce = ticket !== null ? this.#validTicket(ticket) : null;
    const ok = ticket !== null ? nonce !== null : this.#bearerOk(req);
    if (!ok) {
      const client = clientOf(req);
      if (this.#limited(client)) {
        this.#logRefused('limited', `view: refused ${method} ${path}: too many failed tries from one client`);
        res.setHeader('retry-after', String(Math.ceil(FAIL_WINDOW_MS / 1000)));
        return json(res, 429, { error: 'too many failed tries; wait and try again' });
      }
      this.#fail(client);
      this.#logRefused('auth', `view: refused ${method} ${path}: ${ticket !== null ? 'bad or spent ticket' : 'bad or missing token'}`);
      res.setHeader('www-authenticate', 'Bearer');
      return json(res, 401, { error: ticket !== null ? 'ticket not valid: get a new one from /view-ticket' : 'unauthorized' });
    }

    if (path === '/view-ticket') return json(res, 200, this.#issueTicket());
    if (path === '/events') {
      if (this.#clients.size >= (this.#o.maxStreams ?? MAX_STREAMS)) return json(res, 503, { error: 'too many streams open' });
      if (nonce !== null) this.#tickets.delete(nonce);
      return this.#events(req, res);
    }
    if (path === '/state') return json(res, 200, this.#o.redact(this.#o.source.state()));
    if (path === '/strategy') return json(res, 200, this.#o.redact(this.#o.source.strategy()));
    if (path === '/journal') return json(res, 200, this.#o.redact(this.#o.source.journal(url.searchParams.get('before'))));
    // /windows/history
    const id = url.searchParams.get('id');
    if (id === null || id === '') return json(res, 400, { error: 'GET /windows/history needs ?id=<window id>' });
    const history = this.#o.source.history(id);
    if (history === null) return json(res, 404, { error: 'no history for that window: the last scan did not list it' });
    return json(res, 200, this.#o.redact(history));
  }

  #bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const m = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
    if (m === null) return false;
    return timingSafeEqual(sha256(m[1]!), this.#tokenHash);
  }

  #issueTicket(): { ticket: string; expiresAt: number } {
    const now = this.#now();
    this.#pruneTickets(now);
    // The oldest outstanding ticket is retired (insertion order), never the new one refused.
    while (this.#tickets.size >= MAX_TICKETS) this.#tickets.delete(this.#tickets.keys().next().value!);
    const expiresAt = now + (this.#o.ticketTtlMs ?? TICKET_TTL_MS);
    const nonce = randomBytes(16).toString('hex');
    const body = `${expiresAt}.${nonce}`;
    this.#tickets.set(nonce, expiresAt);
    return { ticket: `${body}.${this.#sign(body)}`, expiresAt };
  }

  /** The nonce of a valid, unexpired, unspent ticket (the caller spends it), else null. */
  #validTicket(ticket: string): string | null {
    const m = /^(\d{1,16})\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
    if (m === null) return null;
    const [, exp, nonce, sig] = m as unknown as [string, string, string, string];
    const want = Buffer.from(this.#sign(`${exp}.${nonce}`));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const expiresAt = this.#tickets.get(nonce);
    if (expiresAt === undefined || expiresAt !== Number(exp) || this.#now() >= expiresAt) return null;
    return nonce;
  }

  #sign(body: string): string {
    return createHmac('sha256', this.#ticketKey).update(`gimbal-view-ticket.${body}`).digest('base64url');
  }

  #pruneTickets(now: number): void {
    for (const [nonce, exp] of this.#tickets) if (exp <= now) this.#tickets.delete(nonce);
  }

  #limited(client: string): boolean {
    const f = this.#fails.get(client);
    if (f === undefined) return false;
    if (this.#now() - f.since >= FAIL_WINDOW_MS) {
      this.#fails.delete(client);
      return false;
    }
    return f.count >= (this.#o.failLimit ?? FAIL_LIMIT);
  }

  #fail(client: string): void {
    const now = this.#now();
    const f = this.#fails.get(client);
    if (f === undefined || now - f.since >= FAIL_WINDOW_MS) {
      this.#fails.delete(client);
      this.#fails.set(client, { count: 1, since: now });
      if (this.#fails.size > FAIL_CLIENTS_MAX) this.#fails.delete(this.#fails.keys().next().value!);
      return;
    }
    f.count++;
  }

  #events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.#clients.add(res);
    this.#send(res, 'retry: 5000\n\n');
    const state = this.#o.source.state();
    for (const type of SNAPSHOT_TYPES) {
      const data = state[type];
      if (data !== null && this.#clients.has(res)) this.#send(res, `data: ${JSON.stringify(this.#o.redact({ type, data }))}\n\n`);
    }
    const drop = () => this.#clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
    // A socket error on a stream drops that client; unhandled, it would be thrown.
    res.on('error', drop);
  }

  #send(res: ServerResponse, chunk: string): void {
    res.write(chunk);
    const cap = this.#o.sseMaxBufferBytes ?? SSE_MAX_BUFFER_BYTES;
    if (res.writableLength > cap) {
      this.#clients.delete(res);
      this.#log(`view: SSE client dropped: ${res.writableLength} bytes unread, over ${cap}`);
      res.destroy();
    }
  }

  #log(line: string): void {
    this.#o.log?.(line);
  }

  /** One line per kind a minute; the ones left out are counted on the next line (or at stop). */
  #logRefused(kind: LogKind, line: string): void {
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

  #flushLog(kind: LogKind): void {
    const last = this.#logged.get(kind);
    if (last === undefined || last.skipped === 0) return;
    this.#log(`view: ${last.skipped} more refused (${kind}) since the last line`);
    last.skipped = 0;
  }
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** The last X-Forwarded-For entry (added by the platform's proxy, so not the client's to choose), else the socket. */
function clientOf(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const list = (Array.isArray(fwd) ? fwd.join(',') : fwd ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return list.at(-1) ?? req.socket.remoteAddress ?? 'unknown';
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://view').pathname;
  } catch {
    return '?';
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function notAllowed(res: ServerResponse): void {
  res.setHeader('allow', 'GET');
  json(res, 405, { error: 'read-only: GET only' });
}
