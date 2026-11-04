// serve's Orderly private session, behind GIMBAL_ORDERLY_PAIRS=1 (default off: serve opens nothing, signs nothing and
// logs nothing of this). With it on, serve keeps the desk's private Orderly WebSocket session open
// (venues/orderly-stream.ts): one `orderly_ws_auth` signature through the contract per session, then the `positions`
// and `holding` signed reads that seed it, as cli/pair-live.ts does on testnet. The risk engine reads the desk's Orderly
// account (equity, margin ratio, positions) from that session every 5 s, and the strategy loop reads its free margin.
//
// Fail closed: the Orderly account is unknown, never flat, whenever the session is not open and seeded. Before the
// keeper opened one, while it opens (the ws_auth signature can take 120 s), while it is down, while its positions or
// holding are not known or not usable, or when the server has not spoken for 30 s (the stream's watchdog ends that
// session; OrderlyReader.account refuses state confirmed over 30 s ago), the account read throws at once: it never
// waits on a signature. The risk engine then marks Orderly down and keeps every Orderly leg it saw at its last
// numbers, at least watched (risk/engine.ts), as it does for a venue that does not answer. The strategy loop's read
// of Orderly's free margin has the risk source's deadline too (ACCOUNT_READ_DEADLINE_MS) and logs once per error kind.
//
// Signatures: only the keeper opens a session (the reader's account() never does). The contract's C10 meters do not
// count ws_auth or the signed reads (they are reduces-risk calls, allowed on a paused desk, and no notional), but each
// one is an MPC signature and a NEAR call that holds ~0.3 NEAR of the operator key's budget while it runs. So a session
// that lived at least SESSION_STABLE_MS is reopened at once when it drops; sessions that keep dropping sooner wait
// SESSION_RETRY_MIN_MS, doubling to SESSION_RETRY_MAX_MS; failed opens and failed seed reads wait the same way, the
// wait going back to the minimum once a session is live; and two opens are never closer than SESSION_MIN_GAP_MS. A seed
// read that answered with rows the stream cannot use is not read again (it would sign two reads for the same answer):
// the account stays unknown until a push replaces them. The keeper logs once per state change, never per tick.
//
// Orderly stays a non-rescue venue (trade/carry-plan.ts LIVE_RESCUE.orderly is false) and serve opens no Orderly
// window here. For a later Orderly TradeLeg it exposes the reader, the signed client, the listeners and `legStream`,
// the keeper-guarded positions; never the raw stream, whose state() would open (and sign) a session of its own.

import type { Mode } from '@gimbal/shared';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport } from '../contract/near-transport.ts';
import type { DeskView } from '../contract/types.ts';
import { ORDERLY_BROKERS } from '../scanner/config.ts';
import { OrderlyDeskClient } from '../venues/orderly-actions.ts';
import type { OrderlyNetwork } from '../venues/orderly-http.ts';
import { normalizeAccountId } from '../venues/orderly-http.ts';
import { OrderlyReader } from '../venues/orderly.ts';
import type { OrderlySigner } from '../venues/orderly-signer.ts';
import type {
  OrderlyAccountSnapshot, OrderlyPositionsSnapshot, OrderlyStreamPosition, OrderlyStreamReadiness,
} from '../venues/orderly-stream.ts';
import { OrderlyAccountStream } from '../venues/orderly-stream.ts';
import { errorMessage } from '../venues/recorder.ts';
import { ACCOUNT_READ_DEADLINE_MS, withDeadline } from '../risk/sources.ts';
import type { AccountState, Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import type { WebSocketFactory } from '../venues/ws.ts';
import { contractEnv } from './serve-contract.ts';
import { ConfigError } from './start-errors.ts';

/** The flag: exactly "1" turns the Orderly session on; anything else (unset included) leaves serve as it was. */
export const ORDERLY_PAIRS_ENV = 'GIMBAL_ORDERLY_PAIRS';

export function orderlyPairsOn(env: (name: string) => string | undefined): boolean {
  return env(ORDERLY_PAIRS_ENV) === '1';
}

/** A session that lived this long is reopened at once when it drops (one signature per 10 min at most). */
export const SESSION_STABLE_MS = 10 * 60_000;
/** The first wait after a failed open, a short-lived session or a failed seed; doubled after each, up to the max. */
export const SESSION_RETRY_MIN_MS = 60_000;
export const SESSION_RETRY_MAX_MS = 15 * 60_000;
/** Two session opens (each one ws_auth signature) are never closer than this. */
export const SESSION_MIN_GAP_MS = 30_000;
/** How often the keeper looks at the session (it signs only when a state change calls for it). */
export const SESSION_CHECK_MS = 5_000;

/**
 * idle: never opened; opening: ws_auth and the seed reads in flight; live: open and seeded; unseeded: open, but a seed
 * read failed and no push made its topic known; down: the session ended; stopped: serve is stopping.
 */
export type OrderlySessionState = 'idle' | 'opening' | 'live' | 'unseeded' | 'down' | 'stopped';

export interface OrderlySessionStatus {
  state: OrderlySessionState;
  since: number;                 // clock ms of the last state change
  why: string | null;            // what ended or holds the session (null while live)
  nextAttemptAt: number | null;  // when the keeper opens again (down) or reads again (unseeded); null otherwise
  wsAuth: number;                // orderly_ws_auth signatures this run
  reads: number;                 // positions and holding seed reads this run (one signature each)
}

/** What the keeper needs of OrderlyAccountStream. */
export interface KeptStream {
  readonly down: Error | null;
  readonly signatures: number;
  readonly readiness: OrderlyStreamReadiness;
  start(): Promise<void>;
  state(): Promise<OrderlyAccountSnapshot>;
  positionsState(): Promise<OrderlyPositionsSnapshot>;
  reseed(): Promise<void>;
  close(): void;
}

export interface SessionTiming {
  stableMs: number;
  retryMinMs: number;
  retryMaxMs: number;
  minGapMs: number;
  checkMs: number;
}

export const SESSION_TIMING: SessionTiming = {
  stableMs: SESSION_STABLE_MS, retryMinMs: SESSION_RETRY_MIN_MS, retryMaxMs: SESSION_RETRY_MAX_MS,
  minGapMs: SESSION_MIN_GAP_MS, checkMs: SESSION_CHECK_MS,
};

export interface KeeperOptions {
  stream: KeptStream;
  clock?: Clock;
  log: (line: string) => void;
  timing?: Partial<SessionTiming>;
  /** The seed reads asked for so far (counted by serveOrderly's reads); default none counted. */
  reads?: () => number;
}

/**
 * Keeps one private session open (see the header): opens it, watches it on a timer, reopens it at the pace above, and
 * gives the reader the account only while it is open. Tests drive check() and the clock by hand.
 */
export class OrderlySessionKeeper {
  readonly #stream: KeptStream;
  readonly #clock: Clock;
  readonly #log: (line: string) => void;
  readonly #t: SessionTiming;
  readonly #reads: () => number;
  #state: OrderlySessionState = 'idle';
  #since: number;
  #why: string | null = null;
  #nextAt: number | null = null;
  /** The wait after a failed open or seed; doubled after each, back to the minimum once a session is live. */
  #retryMs: number;
  /** Sessions in a row that dropped before stableMs: the next reopen waits retryMinMs × 2^flaps (up to the max). */
  #flaps = 0;
  #lastOpenAt: number | null = null;
  #liveSince: number | null = null;
  #busy: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: KeeperOptions) {
    this.#stream = options.stream;
    this.#clock = options.clock ?? systemClock;
    this.#log = options.log;
    this.#t = { ...SESSION_TIMING, ...options.timing };
    this.#reads = options.reads ?? (() => 0);
    this.#since = this.#clock.now();
    this.#retryMs = this.#t.retryMinMs;
  }

  status(): OrderlySessionStatus {
    return {
      state: this.#state, since: this.#since, why: this.#why, nextAttemptAt: this.#nextAt,
      wsAuth: this.#stream.signatures, reads: this.#reads(),
    };
  }

  /** The open, reseed or check running now (tests wait on it); null when none runs. */
  get busy(): Promise<void> | null {
    return this.#busy;
  }

  /** Opens the first session now and checks it every checkMs. */
  start(): void {
    if (this.#state === 'stopped' || this.#timer !== null) return;
    this.check();
    this.#timer = setInterval(() => this.check(), this.#t.checkMs);
    this.#timer.unref();
  }

  /** Ends the session and the timer; nothing is signed after it. */
  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#set('stopped', 'serve is stopping', null);
    this.#stream.close();
  }

  /**
   * One look at the session: a session that ended is marked down (and logged once); a live one whose account became
   * unknown (a push it could not use) is marked unseeded, and an unseeded one that a push made known again is live; a
   * down or never opened session is opened when its time has come; an unseeded one whose seed read failed is read
   * again when its time has come (one whose read answered with rows it cannot use waits for a push: reading it again
   * would sign two reads for the same answer). Never while an open or a reseed runs.
   */
  check(): void {
    if (this.#state === 'stopped' || this.#busy !== null) return;
    const now = this.#clock.now();
    const dead = this.#stream.down;
    if ((this.#state === 'live' || this.#state === 'unseeded') && dead !== null) {
      const lived = this.#liveSince === null ? 0 : now - this.#liveSince;
      let wait: number;
      if (lived >= this.#t.stableMs) {
        // A session that held for a while is reopened at once: its drop is the network, not a pattern.
        this.#flaps = 0;
        wait = 0;
      } else {
        wait = Math.min(this.#t.retryMaxMs, this.#t.retryMinMs * 2 ** this.#flaps);
        this.#flaps++;
      }
      this.#liveSince = null;
      this.#set('down', dead.message, this.#notBefore(now + wait));
    } else if (this.#state === 'live' || this.#state === 'unseeded') {
      this.#settle(now);
    }
    if ((this.#state === 'idle' || this.#state === 'down') && (this.#nextAt === null || now >= this.#nextAt)) {
      this.#run(() => this.#open());
    } else if (this.#state === 'unseeded' && this.#nextAt !== null && now >= this.#nextAt) {
      this.#run(() => this.#reseed());
    }
  }

  /**
   * The cached account for OrderlyReader.account(). It never waits and never signs: it answers only from a session the
   * keeper opened whose positions and holding are known and usable, and throws (unknown) otherwise: before the first
   * open, while opening (the ws_auth signature can take 120 s), while down, unseeded or stopped.
   */
  async state(): Promise<OrderlyAccountSnapshot> {
    this.#readable((r) => r.why);
    return this.#stream.state();
  }

  /** The cached positions on the same terms (a later Orderly TradeLeg's `stream`): never waits, never signs. */
  async positionsState(): Promise<OrderlyPositionsSnapshot> {
    this.#readable((r) => r.positionsWhy);
    return this.#stream.positionsState();
  }

  #readable(why: (r: OrderlyStreamReadiness) => string | null): void {
    if (this.#state === 'idle' || this.#state === 'stopped' || this.#state === 'down') {
      throw new Error(`orderly account unknown: the private session is ${this.#state}${this.#why === null ? '' : ` (${this.#why})`}`);
    }
    const r = this.#stream.readiness;
    const not = why(r);
    if (not !== null) throw new Error(`orderly account unknown: the private session is ${this.#state === 'live' ? 'unseeded' : this.#state} (${not})`);
  }

  /** A logged-in session's state from what the stream holds now: live when known, else unseeded (reseed only after a failed read). */
  #settle(now: number): void {
    const r = this.#stream.readiness;
    if (r.why === null) {
      this.#live();
      return;
    }
    const keep = this.#state === 'unseeded' && this.#nextAt !== null;
    this.#set('unseeded', r.why, !r.seedFailed ? null : keep ? this.#nextAt : now + this.#backoff());
  }

  #run(fn: () => Promise<void>): void {
    const p = fn().finally(() => {
      if (this.#busy === p) this.#busy = null;
    });
    this.#busy = p;
  }

  async #open(): Promise<void> {
    const now = this.#clock.now();
    this.#lastOpenAt = now;
    this.#set('opening', null, null);
    let loggedIn = false;
    try {
      await this.#stream.start();
      loggedIn = true;
      await this.#stream.state();
      this.#live();
    } catch (err) {
      if (this.#state === 'stopped') return;
      if (loggedIn && this.#stream.down === null) {
        // Logged in, but the account is not known: a seed read failed (read again later) or answered rows it cannot
        // use (a push makes it known). The session stays either way.
        this.#liveSince = this.#clock.now();
        this.#state = 'unseeded';
        this.#nextAt = null;
        this.#why = null;
        this.#settle(this.#clock.now());
        return;
      }
      this.#set('down', errorMessage(err), this.#notBefore(this.#clock.now() + this.#backoff()));
    }
  }

  async #reseed(): Promise<void> {
    this.#log(`orderly session: reading positions and holding again (two signed reads; ${this.#why ?? 'the last seed failed'})`);
    // Its outcome is what the stream holds after it, whether the reads answered or not.
    await this.#stream.reseed().catch(() => {});
    if (this.#state === 'stopped' || this.#stream.down !== null) return;   // check() marks a dead session down
    const now = this.#clock.now();
    const r = this.#stream.readiness;
    if (r.why === null) this.#live();
    else this.#set('unseeded', r.why, r.seedFailed ? now + this.#backoff() : null);
  }

  #live(): void {
    if (this.#state === 'stopped') return;
    this.#liveSince ??= this.#clock.now();
    this.#retryMs = this.#t.retryMinMs;
    this.#set('live', null, null);
  }

  /** The wait before the next attempt, then doubled for the one after (up to retryMaxMs). */
  #backoff(): number {
    const wait = this.#retryMs;
    this.#retryMs = Math.min(this.#t.retryMaxMs, this.#retryMs * 2);
    return wait;
  }

  /** `at`, or later if that would open a session within minGapMs of the last open. */
  #notBefore(at: number): number {
    return this.#lastOpenAt === null ? at : Math.max(at, this.#lastOpenAt + this.#t.minGapMs);
  }

  #set(state: OrderlySessionState, why: string | null, nextAt: number | null): void {
    const changed = state !== this.#state || why !== this.#why;
    this.#state = state;
    this.#why = why;
    this.#nextAt = nextAt;
    if (!changed) return;
    this.#since = this.#clock.now();
    const now = this.#since;
    const count = `${this.#stream.signatures} ws_auth and ${this.#reads()} seed reads signed this run`;
    const at = (t: number | null) => (t === null ? '' : t <= now ? ', opening it again now' : `, trying again in ${Math.round((t - now) / 1000)} s`);
    switch (state) {
      case 'opening':
        this.#log(`orderly session: opening the desk's private stream (orderly_ws_auth #${this.#stream.signatures + 1} this run, then the positions and holding reads)`);
        break;
      case 'live':
        this.#log(`orderly session: live, the Orderly account is read from it (${count})`);
        break;
      case 'unseeded':
        this.#log(`orderly session: open, but the Orderly account is unknown: ${why}${at(nextAt).replace('opening it again', 'reading again')}`);
        break;
      case 'down':
        this.#log(`orderly session: down, the Orderly account is unknown: ${why}${at(nextAt)}`);
        break;
      case 'stopped':
        this.#log(`orderly session: closed (${count})`);
        break;
      case 'idle':
        break;
    }
  }
}

/**
 * What the kept session tells whoever listens (a later Orderly TradeLeg, the Orderly book). Per session, in order:
 * onUp, then onFrame for each frame and the pushes, then onDown once; a reconnect starts a new onUp. Nothing is sent
 * after serve's stop() (whose close sends the last onDown of a session that was up). A listener that throws is logged
 * and does not reach the session or the other listeners.
 */
export interface OrderlyListeners {
  executionReport?: (report: Record<string, unknown>) => void;
  positions?: (positions: OrderlyStreamPosition[], from: 'push' | 'read') => void;
  /** Logged in and every subscription acknowledged: pushes from here on are not missed until onDown. */
  onUp?: (at: number) => void;
  /** Every frame the server sends on an up session (pushes, pings, pongs, acks): a liveness tick. */
  onFrame?: (at: number) => void;
  /** The up session ended (dropped, silent, refused, or closed at stop); whatever was pushed until the next onUp is missed. */
  onDown?: (at: number) => void;
}

export interface ServeOrderlyInput {
  mode: Mode;
  env: (name: string) => string | undefined;
  deskId: string;
  /** get_desk at start: the Orderly account id, the orderly key (the desk's Solana authority) and the EVM address. */
  desk: DeskView;
  log: (line: string) => void;
  clock?: Clock;
  /** The contract's Orderly methods; default: a NearContractClient on the operator key, built at the first signature. */
  signer?: () => Promise<OrderlySigner>;
  webSocket?: WebSocketFactory;
  fetch?: typeof fetch;
  /** The stream's own timeouts (tests); default the stream's. */
  streamTiming?: { timeoutMs?: number; silenceMs?: number; seedTimeoutMs?: number };
  timing?: Partial<SessionTiming>;
  /** The loop account's deadline; default ACCOUNT_READ_DEADLINE_MS. */
  loopDeadlineMs?: number;
}

export interface ServeOrderly {
  readonly accountId: string;
  readonly orderlyKey: string;
  readonly network: OrderlyNetwork;
  /**
   * For a later Orderly TradeLeg's `stream`: the kept session's positions, guarded by the keeper (they never wait and
   * never open or sign a session). Its pushes reach listen().
   */
  readonly legStream: { positionsState(): Promise<OrderlyPositionsSnapshot> };
  /** account() over the kept session, book() over the public stream (the leg's bestPx). */
  readonly reader: OrderlyReader;
  /** Signed REST through the contract (the leg's readPositions; positions and holding seed each session). */
  readonly client: OrderlyDeskClient;
  /** The contract's Orderly methods the session signs with (a Relayer's contract for the leg's orders later). */
  readonly signer: OrderlySigner;
  readonly keeper: OrderlySessionKeeper;
  /** The risk source's Orderly account (AccountsDeskSource accounts). */
  readonly riskAccount: { reader: OrderlyReader; address: string };
  /**
   * The strategy loop's Orderly free margin (serve-loop accounts): the same account under the risk source's deadline,
   * a failed read logged once per error kind.
   */
  readonly loopAccount: { venue: string; read: () => Promise<AccountState>; logOnce: true };
  /**
   * The executionreport and position pushes (and each session's seed positions), and the session's onUp, onFrame and
   * onDown, to whoever listens (OrderlyListeners); returns the unsubscribe.
   */
  listen(listeners: OrderlyListeners): () => void;
  status(): OrderlySessionStatus;
  start(): void;
  stop(): void;
}

/**
 * The Orderly session with GIMBAL_ORDERLY_PAIRS=1 in a live mode, else null (nothing built, nothing signed). Throws a
 * ConfigError when the flag is on but the desk or the operator key cannot back it; nothing is signed until start().
 */
export function serveOrderly(input: ServeOrderlyInput): ServeOrderly | null {
  if (!orderlyPairsOn(input.env) || input.mode === 'replay') return null;
  const network: OrderlyNetwork = input.mode;
  const rawId = input.desk.orderly_account_id;
  if (rawId === undefined || rawId === '') throw new ConfigError(`${ORDERLY_PAIRS_ENV}=1: get_desk(${input.deskId}) names no orderly_account_id`);
  const accountId = normalizeAccountId(rawId);
  const orderlyKey = `ed25519:${input.desk.solana.authority}`;
  const clock = input.clock ?? systemClock;
  const signing = input.signer ?? operatorSigner(input.env, input.mode, input.log);
  // The contract's client is built at the first signature, so a NEAR RPC that is down at start delays the session
  // (retried at the keeper's pace) instead of serve's start.
  let pending: Promise<OrderlySigner> | null = null;
  const signerNow = (): Promise<OrderlySigner> => {
    if (pending === null) {
      const p = signing();
      pending = p;
      p.catch(() => {
        if (pending === p) pending = null;
      });
    }
    return pending;
  };
  const signer: OrderlySigner = {
    orderlyRequest: async (d, req, reason) => (await signerNow()).orderlyRequest(d, req, reason),
    orderlyWsAuth: async (d, timestamp) => (await signerNow()).orderlyWsAuth(d, timestamp),
    orderlyRegister: async (d, nonce) => (await signerNow()).orderlyRegister(d, nonce),
    orderlyAddKey: async (d, expirationMs) => (await signerNow()).orderlyAddKey(d, expirationMs),
    orderlySettlePnl: async (d, nonce) => (await signerNow()).orderlySettlePnl(d, nonce),
    orderlyWithdraw: async (d, amount, nonce) => (await signerNow()).orderlyWithdraw(d, amount, nonce),
  };
  const client = new OrderlyDeskClient({
    deskId: input.deskId, network, accountId, orderlyKey, evmAddress: input.desk.evm_address, referralCode: null, signer, clock,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  let reads = 0;
  const listeners = new Set<OrderlyListeners>();
  let stopped = false;
  const emit = (call: (l: OrderlyListeners) => void) => {
    if (stopped) return;
    for (const l of [...listeners]) {
      try {
        call(l);
      } catch (err) {
        input.log(`orderly session: a listener failed (${errorMessage(err)})`);
      }
    }
  };
  const stream = new OrderlyAccountStream({
    deskId: input.deskId, accountId, orderlyKey, signer, network, clock,
    reads: {
      positions: () => {
        reads++;
        return client.positions('serve: seed the Orderly private session');
      },
      holding: () => {
        reads++;
        return client.holding('serve: seed the Orderly private session');
      },
    },
    ...(input.webSocket === undefined ? {} : { webSocket: input.webSocket }),
    ...input.streamTiming,
    onExecutionReport: (report) => emit((l) => l.executionReport?.(report)),
    onPositions: (positions, from) => emit((l) => l.positions?.(positions, from)),
    onUp: (at) => emit((l) => l.onUp?.(at)),
    onFrame: (at) => emit((l) => l.onFrame?.(at)),
    onDown: (at) => emit((l) => l.onDown?.(at)),
  });
  const keeper = new OrderlySessionKeeper({ stream, clock, log: input.log, reads: () => reads, ...(input.timing === undefined ? {} : { timing: input.timing }) });
  const reader = new OrderlyReader({
    network, clock, brokerId: ORDERLY_BROKERS[network].brokerId, streamAccountId: accountId,
    accountStream: { accountId, state: () => keeper.state() },
    onNote: input.log,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return {
    accountId, orderlyKey, network, reader, client, signer, keeper,
    legStream: { positionsState: () => keeper.positionsState() },
    riskAccount: { reader, address: accountId },
    loopAccount: {
      venue: 'orderly', logOnce: true,
      read: () => withDeadline(input.loopDeadlineMs ?? ACCOUNT_READ_DEADLINE_MS, 'orderly account read', () => reader.account(accountId)),
    },
    listen: (l) => {
      if (stopped) return () => false;
      listeners.add(l);
      return () => listeners.delete(l);
    },
    status: () => keeper.status(),
    start: () => keeper.start(),
    stop: () => {
      keeper.stop();   // closes the session: a session that was up sends its onDown here
      stopped = true;
      listeners.clear();
      reader.close();
    },
  };
}

/** The risk start line's Orderly part: the words serve printed before this flag when it is off. */
export function riskOrderlyNote(orderly: Pick<ServeOrderly, 'accountId'> | null): string {
  return orderly === null
    ? '(Orderly legs need its private stream, which serve does not open)'
    : `(Orderly account ${orderly.accountId} over its private stream, ${ORDERLY_PAIRS_ENV}=1: one orderly_ws_auth signature a session; unknown while the session is down)`;
}

/** The contract client on the operator key (as serve-pair and serve-rescue build theirs); the key is never printed. */
function operatorSigner(env: (name: string) => string | undefined, mode: Mode, log: (line: string) => void): () => Promise<OrderlySigner> {
  const cfg = contractEnv(env, mode, { signing: true });
  if (cfg === null) throw new ConfigError(`${ORDERLY_PAIRS_ENV}=1 needs GIMBAL_CONTRACT_ID, DESK_ID and the operator key (it signs orderly_ws_auth)`);
  return async () => {
    const transport = new NearApiTransport({
      network: cfg.network, accountId: cfg.accountId!, privateKey: cfg.privateKey!, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }),
    });
    return new NearContractClient({ contractId: cfg.contractId, network: cfg.network, transport, onHealth: (s, d) => log(`orderly near ${s}: ${d}`) });
  };
}
