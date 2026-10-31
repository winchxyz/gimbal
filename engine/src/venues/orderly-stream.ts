// The desk's private Orderly WebSocket session: one `orderly_ws_auth` signature when the session opens (never one
// per read), then the executionreport, position and balance topics, cached as they are pushed. A dropped session is
// not reopened behind the caller's back: start() again signs again, so every signature is one the engine asked for.
//
// The cache is only as good as the socket under it. Orderly pings every 10 s; a session that hears nothing from the
// server for `silenceMs` (30 s) is killed, so a half-open socket cannot keep serving old state as current. Each
// snapshot says when the server last spoke (`confirmedAt`) and when each topic last pushed.
//
// A push whose required fields are missing or not numbers makes the cache unknown, never zero: state() throws until
// a well-formed push replaces it.

import type { Clock } from './venue.ts';
import { systemClock } from './venue.ts';
import type { OrderlyNetwork } from './orderly-http.ts';
import { ORDERLY_ENDPOINTS, normalizeAccountId } from './orderly-http.ts';
import type { OrderlySigner } from './orderly-signer.ts';
import { checkWsAuthAction, ed25519SignatureBase64Url, isOrderlyKeyString } from './orderly-signer.ts';
import type { WebSocketFactory, WebSocketLike } from './ws.ts';
import { nativeWebSocket } from './ws.ts';

export const ORDERLY_PRIVATE_TOPICS = ['executionreport', 'position', 'balance'] as const;
/** The id of the login frame; Orderly echoes it in its answer. */
export const ORDERLY_AUTH_FRAME_ID = 'auth-1';

/**
 * A position as the `position` topic pushes it; only the fields the reader uses. The field names follow Orderly's
 * docs and are to be checked on the first testnet position (C5); a missing required field is an error.
 */
export interface OrderlyStreamPosition {
  symbol: string;
  positionQty: number;           // base units, signed
  costPosition: number;          // USDC
  lastSumUnitaryFunding: number;
  averageOpenPrice: number;
  estLiqPrice: number;           // 0 when there is none
  accruedFundingFee: number;     // sign not verified yet (C5)
  markPrice?: number;            // optional: the reader prices at the REST mark
  mmr?: number;                  // the venue's own rates, when it pushes them
  imr?: number;
}

export interface OrderlyStreamBalance {
  holding: number;
  frozen: number;
}

export interface OrderlyAccountSnapshot {
  accountId: string;
  positions: OrderlyStreamPosition[];
  balances: Record<string, OrderlyStreamBalance>;
  invalidBalances: Record<string, string>;   // tokens whose last push lacked a required field: token -> what is wrong
  positionsAt: number;           // venue ms of the last position push
  balancesAt: number;            // venue ms of the last balance push
  confirmedAt: number;           // local ms of the server's last frame on this live session, pings included: the
                                 // cache is current up to here (pushes arrive in order, so nothing earlier is missing)
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
  silenceMs?: number;            // kill a logged-in session that hears nothing from the server this long (30 s)
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
  watchdog: ReturnType<typeof setTimeout> | null;
  lastFrameAt: number | null;
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
  readonly #silenceMs: number;
  readonly #onExecutionReport: OrderlyAccountStreamOptions['onExecutionReport'];
  #session: Session | null = null;
  #positions: OrderlyStreamPosition[] = [];
  #positionsError: Error | null = null;
  #balances: Record<string, OrderlyStreamBalance> = {};
  #invalidBalances: Record<string, string> = {};
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
    this.#silenceMs = options.silenceMs ?? 30_000;
    this.#onExecutionReport = options.onExecutionReport;
  }

  /** How many ws auth signatures this stream has asked for: one per session. */
  get signatures(): number {
    return this.#signatures;
  }

  /**
   * Opens and authenticates the session, then subscribes; resolves once Orderly accepts the login. Idempotent while
   * the session lives. Any failure before or after the login (signer, socket, refusal, timeout, silence) ends the
   * session, so the next start() opens a new one with a new signature.
   */
  start(): Promise<void> {
    if (this.#session !== null && this.#session.dead === null) return this.#session.ready;
    const session: Session = { ws: null, ready: Promise.resolve(), dead: null, failStart: null, watchdog: null, lastFrameAt: null };
    this.#session = session;
    this.#positions = [];
    this.#positionsError = null;
    this.#balances = {};
    this.#invalidBalances = {};
    this.#positionsAt = null;
    this.#balancesAt = null;
    session.ready = this.#open(session);
    session.ready.catch((err: unknown) => this.#kill(session, err instanceof Error ? err : new Error(String(err))));
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
    if (this.#positionsError !== null) throw this.#positionsError;
    return {
      accountId: this.accountId,
      positions: this.#positions.map((p) => ({ ...p })),
      balances: structuredClone(this.#balances),
      invalidBalances: { ...this.#invalidBalances },
      positionsAt: this.#positionsAt!,
      balancesAt: this.#balancesAt!,
      confirmedAt: current.lastFrameAt!,
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
    checkWsAuthAction(action, timestamp, this.#clock.now(), this.deskId);
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
      // A kill before the login answer (timeout, refusal, close()) rejects the start.
      session.failStart = fail;
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ id: ORDERLY_AUTH_FRAME_ID, event: 'auth', params: { orderly_key: this.orderlyKey, sign, timestamp } }));
      });
      ws.addEventListener('message', (ev) => {
        if (session.dead !== null) return;
        session.lastFrameAt = this.#clock.now();
        if (authed) this.#watch(session);
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
            this.#watch(session);
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
        this.#kill(session, new Error(`orderly private stream: closed (${ev.code ?? '?'}${ev.reason ? ` ${ev.reason}` : ''})`));
      });
      ws.addEventListener('error', (ev) => {
        this.#kill(session, new Error(`orderly private stream: error${ev.message ? ` ${ev.message}` : ''}`));
      });
    });
  }

  /** (Re)arms the silence watchdog: no frame from the server for silenceMs ends the session. */
  #watch(session: Session): void {
    if (session.watchdog !== null) clearTimeout(session.watchdog);
    session.watchdog = setTimeout(() => {
      this.#kill(session, new Error(`orderly private stream: no frame from the server for ${this.#silenceMs} ms (Orderly pings every 10 s)`));
    }, this.#silenceMs);
  }

  #push(topic: string, msg: Record<string, unknown>): void {
    const data = msg.data;
    const ts = typeof msg.ts === 'number' ? msg.ts : this.#clock.now();
    if (topic === 'position') {
      // Each push carries the whole position list; one bad row makes the whole list unknown (a leg must not vanish).
      try {
        const rows = (data as Record<string, unknown> | null)?.positions;
        if (!Array.isArray(rows)) throw new Error('data.positions is not a list');
        this.#positions = rows.map(parsePosition);
        this.#positionsError = null;
      } catch (err) {
        this.#positions = [];
        this.#positionsError = new Error(`orderly private stream: position push unusable: ${(err as Error).message}`);
      }
      this.#positionsAt = ts;
    } else if (topic === 'balance') {
      const balances = (data as Record<string, unknown> | null)?.balances;
      if (typeof balances !== 'object' || balances === null || Array.isArray(balances)) {
        this.#invalidBalances['*'] = 'data.balances is not an object';
      } else {
        delete this.#invalidBalances['*'];
        for (const [token, row] of Object.entries(balances as Record<string, unknown>)) {
          try {
            this.#balances[token] = parseBalance(row);
            delete this.#invalidBalances[token];
          } catch (err) {
            delete this.#balances[token];
            this.#invalidBalances[token] = (err as Error).message;
          }
        }
      }
      this.#balancesAt = ts;
    } else if (topic === 'executionreport') {
      if (typeof data === 'object' && data !== null) this.#onExecutionReport?.(data as Record<string, unknown>);
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
    if (session.watchdog !== null) clearTimeout(session.watchdog);
    session.watchdog = null;
    session.failStart?.(err);
    if (this.#session === session) {
      for (const w of this.#waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(err);
      }
    }
    if (session.ws !== null && session.ws.readyState <= 1) session.ws.close(1000);
  }
}

/** A finite number, or the decimal string of one; anything else is undefined (never 0). */
export function streamNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

function required(r: Record<string, unknown>, field: string, where: string): number {
  const n = streamNumber(r[field]);
  if (n === undefined) throw new Error(`${where}: ${field} is ${r[field] === undefined ? 'missing' : `not a number (${JSON.stringify(r[field])})`}`);
  return n;
}

/** One row of a position push; throws naming the first required field that is missing or not a number. */
export function parsePosition(row: unknown): OrderlyStreamPosition {
  if (typeof row !== 'object' || row === null) throw new Error(`position row is not an object: ${JSON.stringify(row)}`);
  const r = row as Record<string, unknown>;
  if (typeof r.symbol !== 'string' || r.symbol === '') throw new Error('position row has no symbol');
  const where = `position ${r.symbol}`;
  const p: OrderlyStreamPosition = {
    symbol: r.symbol,
    positionQty: required(r, 'positionQty', where),
    costPosition: required(r, 'costPosition', where),
    lastSumUnitaryFunding: required(r, 'lastSumUnitaryFunding', where),
    averageOpenPrice: required(r, 'averageOpenPrice', where),
    estLiqPrice: required(r, 'estLiqPrice', where),
    accruedFundingFee: required(r, 'accruedFundingFee', where),
  };
  for (const field of ['markPrice', 'mmr', 'imr'] as const) {
    const n = streamNumber(r[field]);
    if (n !== undefined) p[field] = n;
  }
  return p;
}

/** One token of a balance push: holding and frozen are both required. */
export function parseBalance(row: unknown): OrderlyStreamBalance {
  if (typeof row !== 'object' || row === null) throw new Error(`balance row is not an object: ${JSON.stringify(row)}`);
  const r = row as Record<string, unknown>;
  return { holding: required(r, 'holding', 'balance'), frozen: required(r, 'frozen', 'balance') };
}
