// The WebSocket surface the readers use, small enough for a test to fake, plus a request/answer client that
// keeps one connection per URL open while it is busy. Node 24 has a global WebSocket; nothing else is needed.

export interface WsEvent {
  data?: unknown;
  code?: number;
  reason?: string;
  message?: string;
}

export interface WebSocketLike {
  readonly readyState: number;     // 0 connecting, 1 open, 2 closing, 3 closed
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: WsEvent) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const nativeWebSocket: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

export type WsFrame = { id: string } & Record<string, unknown>;

/** Sends one request frame and resolves with the frame that answers it (same `id`). */
export type WsRequester = (url: string, frame: WsFrame) => Promise<Record<string, unknown>>;

export class WsTimeoutError extends Error {
  name = 'WsTimeoutError';
}

export interface WsRequestClientOptions {
  webSocket?: WebSocketFactory;
  timeoutMs?: number;              // per request, from the moment it is queued
  idleCloseMs?: number;            // close a connection this long after its last answer, so a process can exit
  /** A server keep-alive frame and our reply to it, or null when the frame is not one. */
  keepAlive?: (msg: Record<string, unknown>) => Record<string, unknown> | null;
}

interface Pending {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Connection {
  ws: WebSocketLike;
  queue: string[];                 // frames waiting for the socket to open
  pending: Map<string, Pending>;
  idle: ReturnType<typeof setTimeout> | null;
  /** Frames of any kind (answers, keep-alives) received so far: a connection that never hears back is dead. */
  heard: number;
}

export class WsRequestClient {
  readonly #factory: WebSocketFactory;
  readonly #timeoutMs: number;
  readonly #idleCloseMs: number;
  readonly #keepAlive: WsRequestClientOptions['keepAlive'];
  readonly #connections = new Map<string, Connection>();

  constructor(options: WsRequestClientOptions = {}) {
    this.#factory = options.webSocket ?? nativeWebSocket;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#idleCloseMs = options.idleCloseMs ?? 20_000;
    this.#keepAlive = options.keepAlive;
  }

  readonly request: WsRequester = (url, frame) => {
    const conn = this.#connection(url);
    if (conn.pending.has(frame.id)) return Promise.reject(new Error(`ws ${url}: request id ${frame.id} is already in flight`));
    if (conn.idle !== null) {
      clearTimeout(conn.idle);
      conn.idle = null;
    }
    const heardBefore = conn.heard;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(frame.id);
        const err = new WsTimeoutError(`ws ${url}: no answer to ${frame.id} within ${this.#timeoutMs} ms`);
        reject(err);
        // A socket that never opened, or has said nothing at all since this frame went out, is dead: drop it, so the
        // next request opens a new one instead of queueing behind it until the OS gives up on the connection.
        if (conn.ws.readyState !== 1 || conn.heard === heardBefore) {
          const why = conn.ws.readyState !== 1 ? 'never opened' : 'silent';
          this.#drop(url, conn, new WsTimeoutError(`ws ${url}: dropped, ${why} for ${this.#timeoutMs} ms`));
        } else {
          this.#scheduleIdle(url, conn);
        }
      }, this.#timeoutMs);
      conn.pending.set(frame.id, { resolve, reject, timer });
      const text = JSON.stringify(frame);
      if (conn.ws.readyState === 1) conn.ws.send(text);
      else conn.queue.push(text);
    });
  };

  /** Closes every connection; requests still in flight fail. */
  close(): void {
    for (const [url, conn] of this.#connections) this.#drop(url, conn, new Error(`ws ${url}: client closed`));
  }

  #connection(url: string): Connection {
    const existing = this.#connections.get(url);
    if (existing !== undefined && existing.ws.readyState <= 1) return existing;
    const ws = this.#factory(url);
    const conn: Connection = { ws, queue: [], pending: new Map(), idle: null, heard: 0 };
    this.#connections.set(url, conn);
    ws.addEventListener('open', () => {
      for (const text of conn.queue.splice(0)) ws.send(text);
    });
    ws.addEventListener('message', (ev) => {
      conn.heard++;
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;                                  // not JSON: nothing a request waits for
      }
      if (typeof msg !== 'object' || msg === null) return;
      const frame = msg as Record<string, unknown>;
      const reply = this.#keepAlive?.(frame) ?? null;
      if (reply !== null) {
        if (ws.readyState === 1) ws.send(JSON.stringify(reply));
        return;
      }
      const id = typeof frame.id === 'string' ? frame.id : null;
      const waiting = id === null ? undefined : conn.pending.get(id);
      if (id === null || waiting === undefined) return;
      clearTimeout(waiting.timer);
      conn.pending.delete(id);
      waiting.resolve(frame);
      this.#scheduleIdle(url, conn);
    });
    ws.addEventListener('close', (ev) => this.#drop(url, conn, new Error(`ws ${url}: closed (${ev.code ?? '?'}${ev.reason ? ` ${ev.reason}` : ''})`)));
    ws.addEventListener('error', (ev) => this.#drop(url, conn, new Error(`ws ${url}: error${ev.message ? ` ${ev.message}` : ''}`)));
    return conn;
  }

  #scheduleIdle(url: string, conn: Connection): void {
    if (conn.pending.size > 0 || conn.idle !== null) return;
    conn.idle = setTimeout(() => this.#drop(url, conn, new Error(`ws ${url}: idle`)), this.#idleCloseMs);
  }

  #drop(url: string, conn: Connection, err: Error): void {
    if (this.#connections.get(url) === conn) this.#connections.delete(url);
    if (conn.idle !== null) clearTimeout(conn.idle);
    conn.idle = null;
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    conn.pending.clear();
    if (conn.ws.readyState <= 1) conn.ws.close(1000);
  }
}
