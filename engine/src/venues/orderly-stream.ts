// The desk's private Orderly WebSocket session: one `orderly_ws_auth` signature when the session opens (never one
// per read), then the executionreport, position and balance topics, cached as they are pushed. A dropped session is
// not reopened behind the caller's back: start() again signs again, so every signature is one the engine asked for.
//
// Orderly sends no snapshot on subscribe (interfaces 1.3, orderly_ws_auth), so an idle account would never push. A
// session therefore starts with the `positions` and `holding` signed reads, sent once the subscriptions are on: what
// changes after the read is pushed, what changed before it is in the read. A topic that has pushed already keeps the
// push (it is at least as new), and the read is dropped for it. Three signatures per session, none per read after.
//
// The cache is only as good as the socket under it. Orderly pings every 10 s; a session that hears nothing from the
// server for `silenceMs` (30 s) is killed, so a half-open socket cannot keep serving old state as current. Each
// snapshot says when the server last spoke (`confirmedAt`) and when each topic last pushed or was read.
//
// A push whose required fields are missing or not numbers makes the cache unknown, never zero: state() throws until
// a well-formed push replaces it. A seed read that fails leaves its topic unknown the same way, without ending the
// session: the first push of that topic, or reseed(), makes it known.

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
  accruedFundingFee?: number;    // sign not verified yet (C5); every push has it, GET /v1/positions does not, so a
                                 // row from the session's seed read lacks it until its symbol pushes
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
  positionsAt: number;           // venue ms of the last position push (local ms of the seed read until one comes)
  balancesAt: number;            // venue ms of the last balance push (likewise)
  positionsFrom: 'push' | 'read';   // whether the positions come from a push or from the session's seed read
  positionsReceivedAt: number;   // local ms when this position list arrived (a push or the read's answer)
  balancesFrom: 'push' | 'read';
  confirmedAt: number;           // local ms of the server's last frame on this live session, pings included: the
                                 // cache is current up to here (pushes arrive in order, so nothing earlier is missing)
}

/** The positions half of a snapshot: what a leg's reconcile needs, known even while the holding is not. */
export type OrderlyPositionsSnapshot = Pick<OrderlyAccountSnapshot, 'accountId' | 'positions' | 'positionsAt' | 'positionsFrom' | 'positionsReceivedAt' | 'confirmedAt'>;

/**
 * The signed reads a session starts with (OrderlyDeskClient has both): Orderly's `data` of GET /v1/positions and
 * GET /v1/client/holding, each through `orderly_request`.
 */
export interface OrderlySessionReads {
  positions(): Promise<unknown>;
  holding(): Promise<unknown>;
}

export interface OrderlyAccountStreamOptions {
  deskId: string;
  accountId: string;
  orderlyKey: string;            // ed25519:<base58>
  signer: Pick<OrderlySigner, 'orderlyWsAuth'>;
  /** The positions and holding reads each session starts with, once its subscriptions are on. */
  reads: OrderlySessionReads;
  network?: OrderlyNetwork;
  url?: string;                  // private stream base; the account id is appended
  webSocket?: WebSocketFactory;
  clock?: Clock;
  timeoutMs?: number;            // auth answer, and the subscribe answers
  /** How long state() waits for the seed reads (each is one MPC signature, usually 5–6 s, at worst 120 s). */
  seedTimeoutMs?: number;
  silenceMs?: number;            // kill a logged-in session that hears nothing from the server this long (30 s)
  onExecutionReport?: (report: Record<string, unknown>) => void;
  /** Every new position list, pushed or read: what the engine's reconcile watches between its own reads. */
  onPositions?: (positions: OrderlyStreamPosition[], from: 'push' | 'read') => void;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
  settled: boolean;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection nobody waits for (a session that died before anyone read it) is not an unhandled one.
  promise.catch(() => {});
  const d: Deferred = {
    promise,
    settled: false,
    resolve: () => {
      d.settled = true;
      resolve();
    },
    reject: (err) => {
      d.settled = true;
      reject(err);
    },
  };
  return d;
}

interface Session {
  ws: WebSocketLike | null;
  ready: Promise<void>;
  dead: Error | null;
  failStart: ((err: Error) => void) | null;
  watchdog: ReturnType<typeof setTimeout> | null;
  lastFrameAt: number | null;
  /** Topics whose subscribe Orderly acknowledged; the seed reads wait for position and balance. */
  acked: Set<string>;
  onAck: (() => void) | null;
  /** Resolves once positions and balances are both known (pushed or read), rejects when the session dies. */
  known: Deferred;
  /** Resolves once positions are known, rejects when the session dies. */
  positionsKnown: Deferred;
  /** The running (or last) seed; settles once its reads have answered. */
  seeding: Promise<void>;
  /** Why a seed read failed, per topic still unknown. */
  seedErrors: { positions?: Error; holding?: Error };
}

/** The topics the seed reads wait for: once both are on, a change after the read is pushed. */
const SEEDED_TOPICS = ['position', 'balance'] as const;

export class OrderlyAccountStream {
  readonly deskId: string;
  readonly accountId: string;
  readonly orderlyKey: string;
  readonly #signer: Pick<OrderlySigner, 'orderlyWsAuth'>;
  readonly #reads: OrderlySessionReads;
  readonly #url: string;
  readonly #factory: WebSocketFactory;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #seedTimeoutMs: number;
  readonly #silenceMs: number;
  readonly #onExecutionReport: OrderlyAccountStreamOptions['onExecutionReport'];
  readonly #onPositions: OrderlyAccountStreamOptions['onPositions'];
  #session: Session | null = null;
  #positions: OrderlyStreamPosition[] = [];
  #positionsError: Error | null = null;
  #balances: Record<string, OrderlyStreamBalance> = {};
  #invalidBalances: Record<string, string> = {};
  #positionsAt: number | null = null;
  #balancesAt: number | null = null;
  #positionsFrom: 'push' | 'read' | null = null;
  #positionsReceivedAt: number | null = null;
  #balancesFrom: 'push' | 'read' | null = null;
  #signatures = 0;

  constructor(options: OrderlyAccountStreamOptions) {
    if (!isOrderlyKeyString(options.orderlyKey)) throw new Error(`orderly: orderly key must be ed25519:<base58>, got ${options.orderlyKey}`);
    this.deskId = options.deskId;
    this.accountId = normalizeAccountId(options.accountId);
    this.orderlyKey = options.orderlyKey;
    this.#signer = options.signer;
    this.#reads = options.reads;
    this.#url = options.url ?? ORDERLY_ENDPOINTS[options.network ?? 'mainnet'].privateWs;
    this.#factory = options.webSocket ?? nativeWebSocket;
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#seedTimeoutMs = options.seedTimeoutMs ?? 150_000;
    this.#silenceMs = options.silenceMs ?? 30_000;
    this.#onExecutionReport = options.onExecutionReport;
    this.#onPositions = options.onPositions;
  }

  /** How many ws auth signatures this stream has asked for: one per session (the seed reads are counted by the signer). */
  get signatures(): number {
    return this.#signatures;
  }

  /**
   * Opens and authenticates the session, then subscribes and starts the seed reads; resolves once Orderly accepts
   * the login. Idempotent while the session lives. Any failure before or after the login (signer, socket, refusal,
   * timeout, silence) ends the session, so the next start() opens a new one with a new signature; a failed seed read
   * does not (see #seed).
   */
  start(): Promise<void> {
    if (this.#session !== null && this.#session.dead === null) return this.#session.ready;
    const session: Session = {
      ws: null, ready: Promise.resolve(), dead: null, failStart: null, watchdog: null, lastFrameAt: null,
      acked: new Set(), onAck: null, known: deferred(), positionsKnown: deferred(), seeding: Promise.resolve(), seedErrors: {},
    };
    this.#session = session;
    this.#positions = [];
    this.#positionsError = null;
    this.#balances = {};
    this.#invalidBalances = {};
    this.#positionsAt = null;
    this.#balancesAt = null;
    this.#positionsFrom = null;
    this.#positionsReceivedAt = null;
    this.#balancesFrom = null;
    session.ready = this.#open(session);
    session.ready.catch((err: unknown) => this.#kill(session, err instanceof Error ? err : new Error(String(err))));
    session.seeding = session.ready.then(() => this.#seed(session)).catch((err: unknown) => {
      if (session.dead === null) this.#kill(session, err instanceof Error ? err : new Error(String(err)));
    });
    return session.ready;
  }

  /**
   * The cached account, once positions and balances are known: from this session's seed reads, or from a push that
   * came first. An idle account that never pushes is served from the reads. The first call opens the session; once
   * a session has died, this throws its error until start() is called again.
   */
  async state(): Promise<OrderlyAccountSnapshot> {
    if (this.#session === null) this.start();
    const current = this.#session!;
    if (current.dead !== null) throw current.dead;
    await current.ready;
    if (current.dead !== null) throw current.dead;
    if (!current.known.settled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const missing = [this.#positionsAt === null ? 'positions' : null, this.#balancesAt === null ? 'holding' : null].filter((x) => x !== null);
          reject(new Error(`orderly private stream: no ${missing.join(' or ')} within ${this.#seedTimeoutMs} ms (neither the seed read nor a push)`));
        }, this.#seedTimeoutMs);
      });
      try {
        // Known, or the seed answered and left a topic unknown (its read failed and nothing pushed): no more waiting.
        await Promise.race([current.known.promise, current.seeding, late]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (current.dead !== null) throw current.dead;
    if (this.#positionsAt === null) throw current.seedErrors.positions ?? new Error('orderly private stream: positions not known yet');
    if (this.#balancesAt === null) throw current.seedErrors.holding ?? new Error('orderly private stream: holding not known yet');
    if (this.#positionsError !== null) throw this.#positionsError;
    return {
      accountId: this.accountId,
      positions: this.#positions.map((p) => ({ ...p })),
      balances: structuredClone(this.#balances),
      invalidBalances: { ...this.#invalidBalances },
      positionsAt: this.#positionsAt!,
      balancesAt: this.#balancesAt!,
      positionsFrom: this.#positionsFrom!,
      positionsReceivedAt: this.#positionsReceivedAt!,
      balancesFrom: this.#balancesFrom!,
      confirmedAt: current.lastFrameAt!,
    };
  }

  /**
   * The cached positions alone, once they are known (seed read or push), whether or not the holding is: a contract
   * without the `holding` read kind and an account with no balance push still have usable positions after a fill.
   */
  async positionsState(): Promise<OrderlyPositionsSnapshot> {
    if (this.#session === null) this.start();
    const current = this.#session!;
    if (current.dead !== null) throw current.dead;
    await current.ready;
    if (current.dead !== null) throw current.dead;
    if (!current.positionsKnown.settled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`orderly private stream: no positions within ${this.#seedTimeoutMs} ms (neither the seed read nor a push)`)), this.#seedTimeoutMs);
      });
      try {
        await Promise.race([current.positionsKnown.promise, current.seeding, late]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (current.dead !== null) throw current.dead;
    if (this.#positionsAt === null) throw current.seedErrors.positions ?? new Error('orderly private stream: positions not known yet');
    if (this.#positionsError !== null) throw this.#positionsError;
    return {
      accountId: this.accountId,
      positions: this.#positions.map((p) => ({ ...p })),
      positionsAt: this.#positionsAt,
      positionsFrom: this.#positionsFrom!,
      positionsReceivedAt: this.#positionsReceivedAt!,
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
        if (msg.event === 'subscribe') {
          if (msg.success === false) {
            this.#kill(session, new Error(`orderly private stream: subscribe ${String(msg.id)} refused: ${String(msg.errorMsg ?? '')}`));
            return;
          }
          const topic = typeof msg.id === 'string' && msg.id.startsWith('sub-') ? msg.id.slice(4) : null;
          if (topic !== null) {
            session.acked.add(topic);
            session.onAck?.();
          }
          return;
        }
        if (typeof msg.topic === 'string') this.#push(session, msg.topic, msg);
      });
      ws.addEventListener('close', (ev) => {
        this.#kill(session, new Error(`orderly private stream: closed (${ev.code ?? '?'}${ev.reason ? ` ${ev.reason}` : ''})`));
      });
      ws.addEventListener('error', (ev) => {
        this.#kill(session, new Error(`orderly private stream: error${ev.message ? ` ${ev.message}` : ''}`));
      });
    });
  }

  /**
   * The session's seed: once the position and balance subscriptions are acknowledged (or timeoutMs has passed with
   * the subscribe frames sent on the open socket), the positions and holding reads. A topic that pushed meanwhile
   * keeps its push. A failed read leaves its topic unknown (state() throws the failure) without ending the session:
   * pushes keep coming, the first one makes the topic known, and reseed() reads again on the same login.
   */
  async #seed(session: Session): Promise<void> {
    await this.#subscribed(session);
    if (session.dead !== null) return;
    const [positions, holding] = await Promise.allSettled([this.#reads.positions(), this.#reads.holding()]);
    if (session.dead !== null || this.#session !== session) return;
    const at = this.#clock.now();
    if (this.#positionsFrom === null) {
      if (positions.status === 'rejected') session.seedErrors.positions = new Error(`orderly private stream: the positions read that seeds the session failed: ${errorText(positions.reason)}`);
      else this.#setPositions(() => parseRestPositions(positions.value), at, 'read');
    }
    if (this.#balancesFrom === null) {
      if (holding.status === 'rejected') session.seedErrors.holding = new Error(`orderly private stream: the holding read that seeds the session failed: ${errorText(holding.reason)}`);
      else this.#setBalances(() => parseRestHolding(holding.value), at, 'read');
    } else if (holding.status === 'fulfilled') {
      // A balance push may carry one token only: the read fills in the tokens no push has named yet.
      let rows: [string, unknown][] = [];
      try {
        rows = parseRestHolding(holding.value);
      } catch {
        // The pushes already make the balances known; an unusable read adds nothing to them.
      }
      for (const [token, row] of rows) {
        if (token in this.#balances || token in this.#invalidBalances) continue;
        try {
          this.#balances[token] = parseBalance(row);
        } catch (err) {
          this.#invalidBalances[token] = (err as Error).message;
        }
      }
    }
    this.#checkKnown(session);
  }

  /** The seed reads again on the live session, for topics still unknown (after a failed read). */
  async reseed(): Promise<void> {
    const session = this.#session;
    if (session === null || session.dead !== null) throw session?.dead ?? new Error('orderly private stream: not started');
    await session.ready;
    session.seedErrors = {};
    session.seeding = this.#seed(session);
    await session.seeding;
  }

  /** Waits for Orderly's subscribe answers of the seeded topics, at most timeoutMs. */
  #subscribed(session: Session): Promise<void> {
    const done = () => SEEDED_TOPICS.every((t) => session.acked.has(t));
    if (done()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(finish, this.#timeoutMs);
      function finish(): void {
        clearTimeout(timer);
        session.onAck = null;
        resolve();
      }
      session.onAck = () => {
        if (done() || session.dead !== null) finish();
      };
      session.known.promise.catch(finish);
    });
  }

  /** (Re)arms the silence watchdog: no frame from the server for silenceMs ends the session. */
  #watch(session: Session): void {
    if (session.watchdog !== null) clearTimeout(session.watchdog);
    session.watchdog = setTimeout(() => {
      this.#kill(session, new Error(`orderly private stream: no frame from the server for ${this.#silenceMs} ms (Orderly pings every 10 s)`));
    }, this.#silenceMs);
  }

  #push(session: Session, topic: string, msg: Record<string, unknown>): void {
    const data = msg.data;
    const ts = typeof msg.ts === 'number' ? msg.ts : this.#clock.now();
    if (topic === 'position') {
      // Each push carries the whole position list; one bad row makes the whole list unknown (a leg must not vanish).
      this.#setPositions(() => {
        const rows = (data as Record<string, unknown> | null)?.positions;
        if (!Array.isArray(rows)) throw new Error('data.positions is not a list');
        return rows.map(parsePosition);
      }, ts, 'push');
    } else if (topic === 'balance') {
      this.#setBalances(() => {
        const balances = (data as Record<string, unknown> | null)?.balances;
        if (typeof balances !== 'object' || balances === null || Array.isArray(balances)) throw new Error('data.balances is not an object');
        return Object.entries(balances as Record<string, unknown>);
      }, ts, 'push');
    } else if (topic === 'executionreport') {
      if (typeof data === 'object' && data !== null) this.#onExecutionReport?.(data as Record<string, unknown>);
    }
    this.#checkKnown(session);
  }

  #setPositions(parse: () => OrderlyStreamPosition[], at: number, from: 'push' | 'read'): void {
    try {
      this.#positions = parse();
      this.#positionsError = null;
    } catch (err) {
      this.#positions = [];
      this.#positionsError = new Error(`orderly private stream: position ${from === 'push' ? 'push' : 'read'} unusable: ${(err as Error).message}`);
    }
    this.#positionsAt = at;
    this.#positionsFrom = from;
    this.#positionsReceivedAt = this.#clock.now();
    const session = this.#session;
    if (session !== null && !session.positionsKnown.settled) session.positionsKnown.resolve();
    if (this.#positionsError === null) this.#onPositions?.(this.#positions.map((p) => ({ ...p })), from);
  }

  /** Balances merge per token (a push may carry one token); a row missing a field marks that token invalid. */
  #setBalances(rows: () => [string, unknown][], at: number, from: 'push' | 'read'): void {
    let entries: [string, unknown][];
    try {
      entries = rows();
      delete this.#invalidBalances['*'];
    } catch (err) {
      this.#invalidBalances['*'] = (err as Error).message;
      entries = [];
    }
    for (const [token, row] of entries) {
      try {
        this.#balances[token] = parseBalance(row);
        delete this.#invalidBalances[token];
      } catch (err) {
        delete this.#balances[token];
        this.#invalidBalances[token] = (err as Error).message;
      }
    }
    this.#balancesAt = at;
    this.#balancesFrom = from;
  }

  #checkKnown(session: Session): void {
    if (this.#session === session && this.#positionsAt !== null && this.#balancesAt !== null && !session.known.settled) session.known.resolve();
  }

  #kill(session: Session, err: Error): void {
    if (session.dead !== null) return;
    session.dead = err;
    if (session.watchdog !== null) clearTimeout(session.watchdog);
    session.watchdog = null;
    session.failStart?.(err);
    if (!session.known.settled) session.known.reject(err);
    if (!session.positionsKnown.settled) session.positionsKnown.reject(err);
    session.onAck?.();
    if (session.ws !== null && session.ws.readyState <= 1) session.ws.close(1000);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/**
 * GET /v1/positions `data` (Orderly's REST names, snake_case) as the push's rows. The REST rows carry no accrued
 * funding fee, so a seeded row has none (accruedFundingFee undefined) until the symbol's first push.
 */
export function parseRestPositions(data: unknown): OrderlyStreamPosition[] {
  const rows = (data as Record<string, unknown> | null)?.rows;
  if (!Array.isArray(rows)) throw new Error('data.rows is not a list');
  return rows.map(parseRestPosition);
}

/** One row of GET /v1/positions; throws naming the first required field that is missing or not a number. */
export function parseRestPosition(row: unknown): OrderlyStreamPosition {
  if (typeof row !== 'object' || row === null) throw new Error(`position row is not an object: ${JSON.stringify(row)}`);
  const r = row as Record<string, unknown>;
  if (typeof r.symbol !== 'string' || r.symbol === '') throw new Error('position row has no symbol');
  const where = `position ${r.symbol}`;
  const p: OrderlyStreamPosition = {
    symbol: r.symbol,
    positionQty: required(r, 'position_qty', where),
    costPosition: required(r, 'cost_position', where),
    lastSumUnitaryFunding: required(r, 'last_sum_unitary_funding', where),
    averageOpenPrice: required(r, 'average_open_price', where),
    estLiqPrice: required(r, 'est_liq_price', where),
  };
  const accrued = streamNumber(r.accrued_funding_fee ?? r.accruedFundingFee);
  if (accrued !== undefined) p.accruedFundingFee = accrued;
  for (const [field, name] of [['markPrice', 'mark_price'], ['mmr', 'mmr'], ['imr', 'imr']] as const) {
    const n = streamNumber(r[name]);
    if (n !== undefined) p[field] = n;
  }
  return p;
}

/** GET /v1/client/holding `data`: `holding` rows of { token, holding, frozen }, as [token, balance] pairs. */
export function parseRestHolding(data: unknown): [string, unknown][] {
  const rows = (data as Record<string, unknown> | null)?.holding;
  if (!Array.isArray(rows)) throw new Error('data.holding is not a list');
  return rows.map((row: unknown) => {
    const token = (row as Record<string, unknown> | null)?.token;
    if (typeof token !== 'string' || token === '') throw new Error(`holding row has no token: ${JSON.stringify(row)}`);
    return [token, row];
  });
}
