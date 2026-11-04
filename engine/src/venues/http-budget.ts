// A request budget per API host, shared by every reader of that host in one process: a rate cap (token bucket), a
// small concurrency limit, priorities, and a cool-down after HTTP 429. Built for Phoenix's public API (PHOENIX_BUDGET
// below says what it allows).
//
// Two kinds of caller share a host. The scanner reads funding, books and history every few seconds; it can serve its
// last good value when a read is skipped, so its reads wait little, never retry, and stand aside after a 429. Every
// other read (an account or trader state for the risk engine, a rescue or the pair trader, a trader's book before a
// close) is critical: it goes first, keeps tokens and a slot no scanner read may take, waits out a cool-down and is
// retried after a 429. The scanner marks its reads by running them inside scanRead(); a read outside it is critical.
// The scanner's own classes leave more of the bucket the less they matter: funding keeps criticalReserve tokens for
// critical reads, books and history (classReserve) more, so history only spends what the bucket has to spare.
// A caller with a deadline of its own (the risk engine's account read) runs inside readBy(): its reads wait for the
// budget and run at most until then. A Retry-After longer than retryAfterMaxMs is cut to it, so a host that asks for
// an hour cannot lock critical reads out: they probe it again after the capped wait. With `adaptive`, a 429 also
// cuts the rate (the host is shared with someone, or allows less than thought) and empties the bucket; the rate
// climbs back a step a minute while no 429 comes. With `criticalFloor`, critical reads also have a bucket of their
// own that no 429 cuts or empties: they take a token from the shared bucket while it has one, else from theirs, so
// the desk's own account reads keep that rate through a storm of 429s; and they wait out only the server's
// Retry-After, never the budget's own backoff (which holds the scanner's reads).

import { AsyncLocalStorage } from 'node:async_hooks';

/** What a reader asks for; the scanner's context turns it into a queue class (critical outside the scanner). */
export type ReadKind = 'account' | 'funding' | 'book' | 'history';

/** Queue order: critical first, then the scanner's funding, books, history. */
export type ReadClass = 'critical' | 'funding' | 'book' | 'history';

const RANK: Record<ReadClass, number> = { critical: 0, funding: 1, book: 2, history: 3 };

/**
 * A read the budget did not send: `cooling` while the host is in a cool-down after a 429 (a scanner read never adds
 * to it), `budget` when no token or slot came free within the read's wait. Nothing reached the venue.
 */
export class ReadSkipped extends Error {
  readonly reason: 'cooling' | 'budget';
  /** ms: when the cool-down ends (cooling), else null. */
  readonly retryAt: number | null;

  constructor(host: string, readClass: ReadClass, reason: 'cooling' | 'budget', retryAt: number | null, now: number) {
    super(reason === 'cooling'
      ? `${host} ${readClass} read skipped: rate-limit cool-down for ${Math.max(0, Math.ceil(((retryAt ?? now) - now) / 1000))} s more`
      : `${host} ${readClass} read skipped: request budget spent`);
    this.name = 'ReadSkipped';
    this.reason = reason;
    this.retryAt = retryAt;
  }
}

export function isReadSkipped(err: unknown): err is ReadSkipped {
  return err instanceof ReadSkipped;
}

const scanReads = new AsyncLocalStorage<true>();

/** Runs `fn` as the scanner: every budgeted read it starts is a scanner read (lower priority, skipped not retried). */
export function scanRead<T>(fn: () => Promise<T>): Promise<T> {
  return scanReads.run(true, fn);
}

const deadlines = new AsyncLocalStorage<number>();

/**
 * Runs `fn` with a deadline (ms on the system clock): a budgeted read started in it waits for a token and a slot, and
 * for a cool-down to end, at most until then, is not retried past it, and its request times out then (a transport
 * that asks requestTimeoutMs). A deadline inside another keeps the earlier.
 */
export function readBy<T>(deadline: number, fn: () => Promise<T>): Promise<T> {
  const outer = deadlines.getStore();
  return deadlines.run(outer === undefined ? deadline : Math.min(outer, deadline), fn);
}

/**
 * Runs `fn` as the scanner with no caller's deadline: for a read started from a timer that a deadlined read armed
 * (a timer runs in the context it was set in, so it would inherit that deadline, long past by then).
 */
export function backgroundScanRead<T>(fn: () => Promise<T>): Promise<T> {
  return deadlines.exit(() => scanReads.run(true, fn));
}

/** ms left before the deadline of the readBy() this runs in (0 once past); null outside one. */
export function readTimeLeft(): number | null {
  const d = deadlines.getStore();
  return d === undefined ? null : Math.max(0, d - Date.now());
}

/** A request's timeout: `ms`, or less inside readBy() when the caller's deadline comes first (at least 1 ms). */
export function requestTimeoutMs(ms: number): number {
  const left = readTimeLeft();
  return Math.max(1, left === null ? ms : Math.min(ms, left));
}

/** The queue class of a read of `kind` started here. */
export function readClass(kind: ReadKind): ReadClass {
  if (scanReads.getStore() !== true) return 'critical';
  return kind === 'account' ? 'funding' : kind;
}

export interface HostBudgetOptions {
  /** Requests a second, sustained (token refill). */
  ratePerSec: number;
  /** Tokens the bucket holds: the largest burst. */
  burst: number;
  /** Requests in flight at once. */
  maxInFlight: number;
  /** Requests in flight at once for scanner reads: the rest is kept for critical reads. */
  scanMaxInFlight: number;
  /** Tokens a scanner read must leave in the bucket, kept for critical reads. */
  criticalReserve: number;
  /** Tokens a scanner read of this class must leave instead (default criticalReserve); at most burst - 1 is used. */
  classReserve?: Partial<Record<Exclude<ReadClass, 'critical'>, number>>;
  /** A 429 cuts the rate to `cut` of itself, down to minRatePerSec; it climbs back by recoverStep every recoverEveryMs. */
  adaptive?: AdaptiveRate | null;
  /**
   * Critical reads' own bucket, never cut or emptied by a 429: the rate they keep whatever the shared bucket does.
   * With it, critical reads wait only for the server's Retry-After after a 429, not for the backoff without one.
   */
  criticalFloor?: { ratePerSec: number; burst: number } | null;
  /** How long a read may wait for a token and a slot, by class; past it a scanner read is skipped. */
  maxWaitMs: Record<ReadClass, number>;
  /** 429 retries by class (the first request not counted). */
  retries: Record<ReadClass, number>;
  /** The wait after a 429 without Retry-After: base doubling per 429 in a row, up to max, with jitter. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** A Retry-After longer than this is cut to it: below maxWaitMs.critical, so a waiting critical read probes after it. */
  retryAfterMaxMs: number;
  /** After a 429 scanner books and history stand aside at least this long, doubling per 429 in a row, up to max. */
  quietBaseMs: number;
  quietMaxMs: number;
  /** Clock, timers and randomness, for tests. */
  now?: () => number;
  timers?: BudgetTimers;
  random?: () => number;
}

export interface AdaptiveRate {
  /** The rate after a 429: this fraction of the rate before it. */
  cut: number;
  minRatePerSec: number;
  recoverEveryMs: number;
  /** Requests a second added back each recoverEveryMs without a 429, up to ratePerSec. */
  recoverStep: number;
}

export interface BudgetTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: BudgetTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Phoenix documents no numbers (docs.phoenix.trade, "WS/API best practices": authenticated sessions get higher limits;
 * back off on 429 and retry after the server's delay). Measured from one IP on 2026-11-04, unauthenticated: one token
 * bucket per IP across endpoints, about 1 request a second sustained with a burst of about 20, then 429
 * {"error":"rate_limited"} with Retry-After: 2 (at 3 a second the first 429 came after 29 requests, then 10 of every
 * 30 passed; at 1.5 a second the first after 38 s, then 1 a second passed; 1 a second for 90 s all passed). So 0.75 a
 * second with a burst of 10: our load alone never empties the host's bucket, and a 429 (someone else on the same
 * egress IP, as on a shared cloud host, or a second process here) halves the rate until quiet minutes step it back.
 * Critical reads keep 2 tokens of the shared bucket (books leave 3, history 5) and have 0.45 a second of their own
 * that no 429 cuts: a risk tick is one request every 5 s (the trader snapshot; the marks come from a cache of at most
 * 5 s that a scanner-class read refreshes between ticks, phoenix.ts), two when that refresh was skipped, so even at
 * the cut floor and after Retry-After: 2 the risk read is answered well inside its 7 s deadline
 * (risk/sources.ts ACCOUNT_READ_DEADLINE_MS).
 */
export const PHOENIX_BUDGET: HostBudgetOptions = {
  ratePerSec: 0.75,
  burst: 10,
  maxInFlight: 4,
  scanMaxInFlight: 2,
  criticalReserve: 2,
  classReserve: { book: 3, history: 5 },
  adaptive: { cut: 0.5, minRatePerSec: 0.25, recoverEveryMs: 60_000, recoverStep: 0.1 },
  criticalFloor: { ratePerSec: 0.45, burst: 2 },
  // The scanner times out a funding read at 4 s and a book at 8 s: it hears "skipped" well before either.
  maxWaitMs: { critical: 15_000, funding: 3_000, book: 1_500, history: 1_500 },
  retries: { critical: 3, funding: 1, book: 0, history: 0 },
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  // Phoenix asks for 2 s; anything past 10 s is not believed (with the 15 % spread it still ends inside a critical
  // read's 15 s wait).
  retryAfterMaxMs: 10_000,
  quietBaseMs: 5_000,
  quietMaxMs: 60_000,
};

interface Waiter {
  cls: ReadClass;
  seq: number;
  deadline: number;
  start: () => void;
  skip: (reason: 'cooling' | 'budget') => void;
}

export interface HostBudgetState {
  /** ms: no request goes out before this (Retry-After or the backoff of the last 429). */
  retryAt: number;
  /** ms: no critical request goes out before this (with criticalFloor: the server's Retry-After only). */
  criticalRetryAt: number;
  /** Tokens in the critical floor bucket (criticalFloor), else 0. */
  floorTokens: number;
  /** ms: scanner books and history are skipped until this. */
  quietUntil: number;
  /** 429s in a row. */
  rateLimited: number;
  /** Requests a second now (below ratePerSec after a 429 when adaptive). */
  ratePerSec: number;
  inFlight: number;
  queued: number;
  sent: number;
}

/** Parses Retry-After: seconds (fractions allowed) or an HTTP date; null when absent or unusable. */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const raw = value.trim();
  if (raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds * 1000) : null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export class HostBudget {
  readonly host: string;
  readonly #o: HostBudgetOptions;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #timers: BudgetTimers;
  #tokens: number;
  #rate: number;
  /** When the rate last changed (a cut, or a step back): the next step is due recoverEveryMs after it. */
  #rateAt: number;
  #refilledAt: number;
  #inFlight = 0;
  #scanInFlight = 0;
  #queue: Waiter[] = [];
  #seq = 0;
  #timer: unknown = null;
  #timerAt = Infinity;
  #retryAt = 0;
  /** The server's Retry-After alone: what critical reads wait for when there is a criticalFloor. */
  #serverRetryAt = 0;
  #floorTokens: number;
  #quietUntil = 0;
  #rateLimited = 0;
  #sent = 0;

  constructor(host: string, options: HostBudgetOptions) {
    if (!(options.ratePerSec > 0) || !(options.burst >= 1) || !(options.maxInFlight >= 1)) {
      throw new RangeError(`host budget ${host}: rate, burst and maxInFlight must be positive`);
    }
    this.host = host;
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#timers = options.timers ?? realTimers;
    this.#tokens = options.burst;
    this.#floorTokens = options.criticalFloor?.burst ?? 0;
    this.#rate = options.ratePerSec;
    this.#refilledAt = this.#now();
    this.#rateAt = this.#refilledAt;
  }

  state(): HostBudgetState {
    return {
      retryAt: this.#retryAt, criticalRetryAt: this.#gate('critical'), floorTokens: this.#floorTokens,
      quietUntil: this.#quietUntil, rateLimited: this.#rateLimited,
      inFlight: this.#inFlight, queued: this.#queue.length, sent: this.#sent, ratePerSec: this.#rate,
    };
  }

  /**
   * Sends one request through the budget. `send` is called when a token and a slot are free (again after a 429 the
   * class may retry); a 429 that is not retried is returned as it came, for the caller to raise. Rejects with
   * ReadSkipped when nothing was sent. Inside readBy() the wait ends at the caller's deadline when that comes first.
   */
  async run(cls: ReadClass, send: () => Promise<Response>): Promise<Response> {
    const left = readTimeLeft();
    const now = this.#now();
    if (left === 0) throw new ReadSkipped(this.host, cls, 'budget', null, now);
    const deadline = now + Math.min(this.#o.maxWaitMs[cls], left ?? Infinity);
    for (let attempt = 0; ; attempt++) {
      await this.#acquire(cls, deadline);
      let res: Response;
      try {
        res = await send();
      } finally {
        this.#release(cls);
      }
      if (res.status !== 429) {
        if (this.#now() >= this.#quietUntil) this.#rateLimited = 0;
        return res;
      }
      this.#onRateLimited(res);
      if (attempt >= this.#o.retries[cls] || this.#gate(cls) > deadline) return res;
      // The body is not read: release the connection before waiting.
      await res.body?.cancel().catch(() => {});
    }
  }

  #onRateLimited(res: Response): void {
    const now = this.#now();
    this.#rateLimited++;
    const n = this.#rateLimited;
    const given = retryAfterMs(res.headers.get('retry-after'), now);
    const said = given === null ? null : Math.min(given, this.#o.retryAfterMaxMs);
    // Retry-After is honoured as given up to retryAfterMaxMs, plus up to 15 % so that waiting callers do not all come
    // back at once; without it, an exponential backoff with jitter (half to all of the step).
    const pause = said !== null
      ? Math.round(said * (1 + 0.15 * this.#random()))
      : Math.round(Math.min(this.#o.backoffMaxMs, this.#o.backoffBaseMs * 2 ** (n - 1)) * (0.5 + 0.5 * this.#random()));
    this.#retryAt = Math.max(this.#retryAt, now + pause);
    if (said !== null) this.#serverRetryAt = Math.max(this.#serverRetryAt, this.#retryAt);
    const quiet = Math.round(Math.min(this.#o.quietMaxMs, this.#o.quietBaseMs * 2 ** (n - 1)) * (0.75 + 0.25 * this.#random()));
    this.#quietUntil = Math.max(this.#quietUntil, this.#retryAt, now + quiet);
    const a = this.#o.adaptive;
    if (a !== undefined && a !== null) {
      // The host's bucket for us is empty, and it allows less than the rate we ran at: slower, from an empty bucket.
      // The critical floor is neither cut nor emptied.
      this.#refill(now);
      this.#rate = Math.max(a.minRatePerSec, this.#rate * a.cut);
      this.#rateAt = now;
      this.#tokens = 0;
    }
    this.#pump();
  }

  #acquire(cls: ReadClass, deadline: number): Promise<void> {
    const now = this.#now();
    // Scanner books and history stand aside for the whole quiet period; any read whose wait ends before the
    // cool-down does is told at once.
    if ((cls === 'book' || cls === 'history') && now < this.#quietUntil) {
      return Promise.reject(new ReadSkipped(this.host, cls, 'cooling', this.#quietUntil, now));
    }
    if (this.#gate(cls) > deadline) return Promise.reject(new ReadSkipped(this.host, cls, 'cooling', this.#gate(cls), now));
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        cls, seq: this.#seq++, deadline,
        start: () => resolve(),
        skip: (reason) => reject(new ReadSkipped(this.host, cls, reason, reason === 'cooling' ? Math.max(this.#gate(cls), cls === 'critical' ? 0 : this.#quietUntil) : null, this.#now())),
      };
      this.#queue.push(w);
      this.#queue.sort((a, b) => RANK[a.cls] - RANK[b.cls] || a.seq - b.seq);
      this.#pump();
    });
  }

  #release(cls: ReadClass): void {
    this.#inFlight--;
    if (cls !== 'critical') this.#scanInFlight--;
    this.#pump();
  }

  /** ms: when a read of `cls` may go out after the last 429s. */
  #gate(cls: ReadClass): number {
    return cls === 'critical' && this.#o.criticalFloor ? this.#serverRetryAt : this.#retryAt;
  }

  #refill(now: number): void {
    if (now > this.#refilledAt) {
      this.#tokens = Math.min(this.#o.burst, this.#tokens + ((now - this.#refilledAt) / 1000) * this.#rate);
      const f = this.#o.criticalFloor;
      if (f) this.#floorTokens = Math.min(f.burst, this.#floorTokens + ((now - this.#refilledAt) / 1000) * f.ratePerSec);
    }
    this.#refilledAt = now;
    const a = this.#o.adaptive;
    if (a !== undefined && a !== null && this.#rate < this.#o.ratePerSec) {
      const steps = Math.floor((now - this.#rateAt) / a.recoverEveryMs);
      if (steps > 0) {
        this.#rate = Math.min(this.#o.ratePerSec, this.#rate + steps * a.recoverStep);
        this.#rateAt += steps * a.recoverEveryMs;
      }
    }
  }

  /** Tokens a read of `cls` needs in the bucket to be sent: 1, plus what a scanner class must leave. */
  #need(cls: ReadClass): number {
    if (cls === 'critical') return 1;
    const reserve = this.#o.classReserve?.[cls] ?? this.#o.criticalReserve;
    return Math.min(this.#o.burst, 1 + reserve);
  }

  /** Starts what can start, in queue order; skips what waited too long; sets one timer for the next change. */
  #pump(): void {
    const now = this.#now();
    this.#refill(now);
    let wakeAt = Infinity;
    // Expired waiters and, in a quiet period, scanner books and history leave first.
    const kept: Waiter[] = [];
    for (const w of this.#queue) {
      if ((w.cls === 'book' || w.cls === 'history') && now < this.#quietUntil) w.skip('cooling');
      else if (this.#gate(w.cls) > w.deadline) w.skip('cooling');
      else if (now >= w.deadline) w.skip('budget');
      else kept.push(w);
    }
    this.#queue = kept;
    while (this.#queue.length > 0) {
      const w = this.#queue[0]!;
      const gate = this.#gate(w.cls);
      if (now < gate) {
        wakeAt = gate;
        break;
      }
      const critical = w.cls === 'critical';
      const slots = critical ? this.#inFlight < this.#o.maxInFlight
        : this.#inFlight < this.#o.maxInFlight && this.#scanInFlight < this.#o.scanMaxInFlight;
      // A release wakes the queue again; nothing to time.
      if (!slots) break;
      const need = this.#need(w.cls);
      // A critical read takes a shared token while there is one, else one of its floor's.
      const floor = critical && this.#tokens < need && this.#floorTokens >= 1;
      if (this.#tokens < need && !floor) {
        const f = critical ? this.#o.criticalFloor : null;
        const shared = ((need - this.#tokens) / this.#rate) * 1000;
        const own = f ? ((1 - this.#floorTokens) / f.ratePerSec) * 1000 : Infinity;
        wakeAt = now + Math.ceil(Math.min(shared, own));
        break;
      }
      this.#queue.shift();
      if (floor) this.#floorTokens -= 1;
      else this.#tokens -= 1;
      this.#inFlight++;
      if (!critical) this.#scanInFlight++;
      this.#sent++;
      w.start();
    }
    for (const w of this.#queue) wakeAt = Math.min(wakeAt, w.deadline);
    this.#arm(wakeAt, now);
  }

  #arm(at: number, now: number): void {
    if (at === Infinity) {
      if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
      this.#timer = null;
      this.#timerAt = Infinity;
      return;
    }
    if (this.#timer !== null && this.#timerAt <= at) return;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timerAt = at;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      this.#timerAt = Infinity;
      this.#pump();
    }, Math.max(0, at - now));
    // Not unref'd: a CLI awaiting one critical read through a cool-down must not exit before it is sent. The timer
    // is armed only while a read waits.
  }
}

const budgets = new Map<string, HostBudget>();

/** The budget every reader of `origin` in this process shares (made with `options` the first time). */
export function hostBudget(origin: string, options: HostBudgetOptions): HostBudget {
  const host = new URL(origin).host;
  let b = budgets.get(host);
  if (b === undefined) {
    b = new HostBudget(host, options);
    budgets.set(host, b);
  }
  return b;
}
