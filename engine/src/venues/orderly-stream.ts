// The desk's private Orderly WebSocket session: one `orderly_ws_auth` signature when the session opens (never one
// per read), then the executionreport, position and balance topics, cached as they are pushed. A dropped session is
// not reopened behind the caller's back: start() again signs again, so every signature is one the engine asked for.

import type { Clock } from './venue.ts';
import { systemClock } from './venue.ts';
import type { OrderlyNetwork } from './orderly-http.ts';
import { ORDERLY_ENDPOINTS, normalizeAccountId } from './orderly-http.ts';
import type { OrderlySigner } from './orderly-signer.ts';
import { checkWsAuthAction, ed25519SignatureBase64Url, isOrderlyKeyString } from './orderly-signer.ts';
import type { WebSocketFactory, WebSocketLike } from './ws.ts';
import { nativeWebSocket } from './ws.ts';

export const ORDERLY_PRIVATE_TOPICS = ['executionreport', 'position', 'balance'] as const;

/** A position as the `position` topic pushes it; only the fields the reader uses. */
export interface OrderlyStreamPosition {
  symbol: string;
  positionQty: number;           // base units, signed
  costPosition: number;          // USDC
  lastSumUnitaryFunding: number;
  averageOpenPrice: number;
  markPrice?: number;
  estLiqPrice?: number;          // 0 when there is none
  mmr?: number;                  // the venue's own rates, when it pushes them
  imr?: number;
  accruedFundingFee?: number;    // sign not verified yet (C5)
}

export interface OrderlyStreamBalance {
  holding: number;
  frozen: number;
}

export interface OrderlyAccountSnapshot {
  accountId: string;
  positions: OrderlyStreamPosition[];
  balances: Record<string, OrderlyStreamBalance>;
  positionsAt: number;           // venue ms of the last position push
  balancesAt: number;
}

export interface OrderlyAccountStreamOptions {
  deskId: string;
  accountId: string;
  orderlyKey: string;            // ed25519:<base58>
  signer: Pick<OrderlySigner, 'orderlyWsAuth'>;
  network?: OrderlyNetwork;
  url?: string;                  // private stream base; the account id is appended
  webSocket?: WebSocketFactory;
  clock?: Clock;
  timeoutMs?: number;            // auth answer, and the first position and balance pushes
  onExecutionReport?: (report: Record<string, unknown>) => void;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  ws: WebSocketLike | null;
  ready: Promise<void>;
  dead: Error | null;
  failStart: ((err: Error) => void) | null;
}

export class OrderlyAccountStream {
  readonly deskId: string;
  readonly accountId: string;
  readonly orderlyKey: string;
  readonly #signer: Pick<OrderlySigner, 'orderlyWsAuth'>;
  readonly #url: string;
  readonly #factory: WebSocketFactory;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #onExecutionReport: OrderlyAccountStreamOptions['onExecutionReport'];
  #session: Session | null = null;
  #positions = new Map<string, OrderlyStreamPosition>();
  #balances: Record<string, OrderlyStreamBalance> = {};
  #positionsAt: number | null = null;
  #balancesAt: number | null = null;
  #waiters: Waiter[] = [];
  #signatures = 0;

  constructor(options: OrderlyAccountStreamOptions) {
    if (!isOrderlyKeyString(options.orderlyKey)) throw new Error(`orderly: orderly key must be ed25519:<base58>, got ${options.orderlyKey}`);
    this.deskId = options.deskId;
    this.accountId = normalizeAccountId(options.accountId);
    this.orderlyKey = options.orderlyKey;
    this.#signer = options.signer;
    this.#url = options.url ?? ORDERLY_ENDPOINTS[options.network ?? 'mainnet'].privateWs;
    this.#factory = options.webSocket ?? nativeWebSocket;
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#onExecutionReport = options.onExecutionReport;
  }

  /** How many ws auth signatures this stream has asked for: one per session. */
  get signatures(): number {
    return this.#signatures;
  }

  /** Opens and authenticates the session, then subscribes; resolves once Orderly accepts the login. Idempotent. */
  start(): Promise<void> {
    if (this.#session !== null && this.#session.dead === null) return this.#session.ready;
    const session: Session = { ws: null, ready: Promise.resolve(), dead: null, failStart: null };
    this.#session = session;
    this.#positions = new Map();
    this.#balances = {};
    this.#positionsAt = null;
    this.#balancesAt = null;
    session.ready = this.#open(session);
    session.ready.catch(() => {});
    return session.ready;
  }

  /**
   * The cached account, after the first position and balance pushes of this session (waits up to timeoutMs). The
   * first call opens the session; once a session has died, this throws its error until start() is called again.
   */
  async state(): Promise<OrderlyAccountSnapshot> {
    if (this.#session === null) this.start();
    const current = this.#session!;
    if (current.dead !== null) throw current.dead;
    await current.ready;
    if (current.dead !== null) throw current.dead;
    if (this.#positionsAt === null || this.#balancesAt === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#waiters = this.#waiters.filter((w) => w.timer !== timer);
          const missing = [this.#positionsAt === null ? 'position' : null, this.#balancesAt === null ? 'balance' : null].filter((x) => x !== null);
          reject(new Error(`orderly private stream: no ${missing.join(' or ')} push within ${this.#timeoutMs} ms`));
        }, this.#timeoutMs);
        this.#waiters.push({ resolve, reject, timer });
      });
    }
    if (current.dead !== null) throw current.dead;
    return {
      accountId: this.accountId,
      positions: [...this.#positions.values()].map((p) => ({ ...p })),
      balances: structuredClone(this.#balances),
      positionsAt: this.#positionsAt!,
      balancesAt: this.#balancesAt!,
    };
  }

  close(): void {
    const session = this.#session;
    if (session === null) return;
    this.#kill(session, new Error('orderly private stream: closed'));
  }

  async #open(session: Session): Promise<void> {
    const timestamp = this.#clock.now();
    this.#signatures++;
    const action = await this.#signer.orderlyWsAuth(this.deskId, timestamp);
    checkWsAuthAction(action, timestamp, this.#clock.now());
    const sign = ed25519SignatureBase64Url(action.signature);
    if (session.dead !== null) throw session.dead;
    const ws = this.#factory(`${this.#url}${this.accountId}`);
    session.ws = ws;
    return new Promise<void>((resolve, reject) => {
      let authed = false;
      const timer = setTimeout(() => {
        if (!authed) this.#kill(session, new Error(`orderly private stream: no auth answer within ${this.#timeoutMs} ms`));
      }, this.#timeoutMs);
      const fail = (err: Error) => {
        clearTimeout(timer);
        if (!authed) reject(err);
      };
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ id: 'auth', event: 'auth', params: { orderly_key: this.orderlyKey, sign, timestamp } }));
      });
      ws.addEventListener('message', (ev) => {
        let msg: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(String(ev.data));
          if (typeof parsed !== 'object' || parsed === null) return;
          msg = parsed as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.event === 'ping') {
          if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'pong', ts: msg.ts ?? this.#clock.now() }));
          return;
        }
        if (msg.event === 'auth') {
          if (msg.success === true) {
            authed = true;
            clearTimeout(timer);
            for (const topic of ORDERLY_PRIVATE_TOPICS) ws.send(JSON.stringify({ id: `sub-${topic}`, event: 'subscribe', topic }));
            resolve();
          } else {
            this.#kill(session, new Error(`orderly private stream: login refused: ${String(msg.errorMsg ?? 'no reason given')}`));
          }
          return;
        }
        if (msg.event === 'subscribe' && msg.success === false) {
          this.#kill(session, new Error(`orderly private stream: subscribe ${String(msg.id)} refused: ${String(msg.errorMsg ?? '')}`));
          return;
        }
        if (typeof msg.topic === 'string') this.#push(msg.topic, msg);
      });
      ws.addEventListener('close', (ev) => {
        const err = new Error(`orderly private stream: closed (${ev.code ?? '?'}${ev.reason ? ` ${ev.reason}` : ''})`);
        fail(err);
        this.#kill(session, err);
      });
      ws.addEventListener('error', (ev) => {
        const err = new Error(`orderly private stream: error${ev.message ? ` ${ev.message}` : ''}`);
        fail(err);
        this.#kill(session, err);
      });
      // A kill before the login answer (timeout, refusal, close()) rejects the start.
      session.failStart = fail;
    });
  }

  #push(topic: string, msg: Record<string, unknown>): void {
    const data = (msg.data ?? {}) as Record<string, unknown>;
    const ts = typeof msg.ts === 'number' ? msg.ts : this.#clock.now();
    if (topic === 'position') {
      const rows = Array.isArray(data.positions) ? data.positions : [];
      // Each push carries the whole position list.
      const next = new Map<string, OrderlyStreamPosition>();
      for (const row of rows) {
        const p = parsePosition(row);
        if (p !== null) next.set(p.symbol, p);
      }
      this.#positions = next;
      this.#positionsAt = ts;
    } else if (topic === 'balance') {
      const balances = (data.balances ?? {}) as Record<string, Record<string, unknown>>;
      for (const [token, b] of Object.entries(balances)) {
        this.#balances[token] = { holding: numOr(b.holding, 0), frozen: numOr(b.frozen, 0) };
      }
      this.#balancesAt = ts;
    } else if (topic === 'executionreport') {
      this.#onExecutionReport?.(data);
    }
    if (this.#positionsAt !== null && this.#balancesAt !== null) {
      for (const w of this.#waiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  }

  #kill(session: Session, err: Error): void {
    if (session.dead !== null) return;
    session.dead = err;
    session.failStart?.(err);
    for (const w of this.#waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    if (session.ws !== null && session.ws.readyState <= 1) session.ws.close(1000);
  }
}

function parsePosition(row: unknown): OrderlyStreamPosition | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.symbol !== 'string') return null;
  const opt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    symbol: r.symbol,
    positionQty: numOr(r.positionQty, 0),
    costPosition: numOr(r.costPosition, 0),
    lastSumUnitaryFunding: numOr(r.lastSumUnitaryFunding, 0),
    averageOpenPrice: numOr(r.averageOpenPrice, 0),
    ...(opt(r.markPrice) === undefined ? {} : { markPrice: opt(r.markPrice)! }),
    ...(opt(r.estLiqPrice) === undefined ? {} : { estLiqPrice: opt(r.estLiqPrice)! }),
    ...(opt(r.mmr) === undefined ? {} : { mmr: opt(r.mmr)! }),
    ...(opt(r.imr) === undefined ? {} : { imr: opt(r.imr)! }),
    ...(opt(r.accruedFundingFee) === undefined ? {} : { accruedFundingFee: opt(r.accruedFundingFee)! }),
  };
}

function numOr(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}
