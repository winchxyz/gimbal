// The engine's HTTP side (docs/interfaces.md §2), on ENGINE_PORT (8790):
//   GET /events                  SSE, one StreamEvent per message ("data: <json>")
//   GET /state                   EngineState: the latest of each event type
//   GET /windows/history?id=     WindowHistory of one window (404 when the last scan did not list it)
//   GET /strategy, PUT /strategy StrategyConfig (PUT takes the whole config, checked, and answers the new one)
//   GET /journal?before=<id>     JournalEntry[]: up to 100 entries older than that id, newest first ([] past the
//                                oldest; 404 for an id not in memory); without `before`, the newest 100
// The scanner feeds it: every scan publishes a `scan` and a `windows` event. Routes other parts build later answer
// 501 for now (POST /rotate and /close in their own { ok, reason } shape).

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ContractPolicy, DeskState, EngineState, HealthMap, JournalEntry, Mode, RescueProgress, ScanStatus, SetupProgress,
  StrategyConfig, StreamEvent, Window as FundingWindow,
} from '@gimbal/shared';
import { errorMessage } from './venues/recorder.ts';
import { parseStrategyConfig } from './scanner/config.ts';
import type { ScanResult, Scanner } from './scanner/scanner.ts';

export const DEFAULT_ENGINE_PORT = 8790;
/** Journal entries per page: GET /state's newest and each GET /journal?before= page. */
const JOURNAL_PAGE = 100;
/** Entries kept in memory for paging back; older ones are not served (the journal is not persisted yet). */
const JOURNAL_KEEP = 5_000;
const HEARTBEAT_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface EngineServerOptions {
  mode: Mode;
  scanner: Scanner;
  strategy: StrategyConfig;
  policy: ContractPolicy | null;
  /** ms between the end of one scan and the start of the next one; the scan's own time counts against it. */
  intervalMs: number;
  /** Real-time clock for EngineState.at (the scanner keeps its own, virtual in replay). */
  now?: () => number;
  log?: (line: string) => void;
  /** Called after every scan, with what it produced. */
  onScan?: (result: ScanResult) => void;
}

type Latest = {
  windows: FundingWindow[] | null;
  scan: ScanStatus | null;
  desk: DeskState | null;
  rescue: RescueProgress | null;
  setup: SetupProgress | null;
  health: HealthMap | null;
};

export class EngineServer {
  readonly #options: EngineServerOptions;
  readonly #server: Server;
  readonly #clients = new Set<ServerResponse>();
  readonly #latest: Latest = { windows: null, scan: null, desk: null, rescue: null, setup: null, health: null };
  readonly #journal: JournalEntry[] = [];
  #strategy: StrategyConfig;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #scanning: Promise<void> | null = null;

  constructor(options: EngineServerOptions) {
    this.#options = options;
    this.#strategy = options.strategy;
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

  /** Listens on `port` (0 = any free port) and starts scanning; resolves with the port it listens on. */
  async start(port: number): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, () => {
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
      (err: unknown) => this.#log(`scan failed: ${errorMessage(err)}`),
    ).finally(() => {
      this.#scanning = null;
      if (!this.#running) return;
      const wait = Math.max(0, this.#options.intervalMs - (Date.now() - started));
      this.#timer = setTimeout(() => this.#loop(), wait);
    });
  }

  #write(chunk: string): void {
    for (const res of this.#clients) res.write(chunk);
  }

  #log(line: string): void {
    this.#options.log?.(line);
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://engine');
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/\/+$/, '') || '/';

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
      const at = this.#journal.findIndex((e) => e.id === before);
      if (at === -1) return json(res, 404, { error: `no journal entry ${before} in the last ${JOURNAL_KEEP}` });
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
      try {
        this.#strategy = parseStrategyConfig(body, this.#options.policy);
      } catch (err) {
        return json(res, 400, { error: errorMessage(err) });
      }
      this.#log(`strategy set: ${JSON.stringify(this.#strategy)}`);
      return json(res, 200, this.#strategy);
    }
    if (path === '/rotate' || path === '/close') {
      if (method !== 'POST') return notAllowed(res, 'POST');
      return json(res, 501, { ok: false, reason: 'the strategy engine is not running yet: nothing is entered or closed' });
    }
    if (path === '/stress' || path === '/policy/draft' || path === '/setup') {
      if (method !== 'POST') return notAllowed(res, 'POST');
      return json(res, 501, { error: `POST ${path} is not built yet` });
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
    res.write('retry: 5000\n\n');
    for (const type of ['scan', 'windows', 'desk', 'health', 'setup', 'rescue'] as const) {
      const data = this.#latest[type];
      if (data !== null) res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    }
    this.#clients.add(res);
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
