// A request budget per API host, shared by every reader of that host in one process: a rate cap (token bucket), a
// small concurrency limit, priorities, and a cool-down after HTTP 429. Built for Phoenix's public API, which answers
// a burst of about 15 requests with 429 {"error":"rate_limited"} and `Retry-After: 1` (measured 2026-11-03: 14 of 15
// parallel book reads passed, 20 reads at 10 a second all passed).
//
// Two kinds of caller share a host. The scanner reads funding, books and history every few seconds; it can serve its
// last good value when a read is skipped, so its reads wait little, never retry, and stand aside after a 429. Every
// other read (an account or trader state for the risk engine, a rescue or the pair trader, a trader's book before a
// close) is critical: it goes first, keeps a token and a slot no scanner read may take, waits out a cool-down and is
// retried after a 429. The scanner marks its reads by running them inside scanRead(); a read outside it is critical.

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
  /** How long a read may wait for a token and a slot, by class; past it a scanner read is skipped. */
  maxWaitMs: Record<ReadClass, number>;
  /** 429 retries by class (the first request not counted). */
  retries: Record<ReadClass, number>;
  /** The wait after a 429 without Retry-After: base doubling per 429 in a row, up to max, with jitter. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** After a 429 scanner books and history stand aside at least this long, doubling per 429 in a row, up to max. */
  quietBaseMs: number;
  quietMaxMs: number;
  /** Clock and randomness, for tests. */
  now?: () => number;
  random?: () => number;
}

/**
 * Phoenix: 5 requests a second with a burst of 5 is half of what passed in the measurement above, so a second process
 * on the same machine (pair-mainnet) has as much again; one token and one slot are always kept for critical reads.
 */
export const PHOENIX_BUDGET: HostBudgetOptions = {
  ratePerSec: 5,
  burst: 5,
  maxInFlight: 4,
  scanMaxInFlight: 3,
  criticalReserve: 1,
  // The scanner times out a funding read at 4 s and a book at 8 s: it hears "skipped" well before either.
  maxWaitMs: { critical: 15_000, funding: 3_000, book: 1_500, history: 1_500 },
  retries: { critical: 3, funding: 1, book: 0, history: 0 },
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
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
  /** ms: scanner books and history are skipped until this. */
  quietUntil: number;
  /** 429s in a row. */
  rateLimited: number;
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
  #tokens: number;
  #refilledAt: number;
  #inFlight = 0;
  #scanInFlight = 0;
  #queue: Waiter[] = [];
  #seq = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #timerAt = Infinity;
  #retryAt = 0;
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
    this.#tokens = options.burst;
    this.#refilledAt = this.#now();
  }

  state(): HostBudgetState {
    return {
      retryAt: this.#retryAt, quietUntil: this.#quietUntil, rateLimited: this.#rateLimited,
      inFlight: this.#inFlight, queued: this.#queue.length, sent: this.#sent,
    };
  }

  /**
   * Sends one request through the budget. `send` is called when a token and a slot are free (again after a 429 the
   * class may retry); a 429 that is not retried is returned as it came, for the caller to raise. Rejects with
   * ReadSkipped when nothing was sent.
   */
  async run(cls: ReadClass, send: () => Promise<Response>): Promise<Response> {
    const deadline = this.#now() + this.#o.maxWaitMs[cls];
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
      if (attempt >= this.#o.retries[cls] || this.#retryAt > deadline) return res;
      // The body is not read: release the connection before waiting.
      await res.body?.cancel().catch(() => {});
    }
  }

  #onRateLimited(res: Response): void {
    const now = this.#now();
    this.#rateLimited++;
    const n = this.#rateLimited;
    const said = retryAfterMs(res.headers.get('retry-after'), now);
    // Retry-After is honoured as given, plus up to 15 % so that waiting callers do not all come back at once; without
    // it, an exponential backoff with jitter (half to all of the step).
    const pause = said !== null
      ? Math.round(said * (1 + 0.15 * this.#random()))
      : Math.round(Math.min(this.#o.backoffMaxMs, this.#o.backoffBaseMs * 2 ** (n - 1)) * (0.5 + 0.5 * this.#random()));
    this.#retryAt = Math.max(this.#retryAt, now + pause);
    const quiet = Math.round(Math.min(this.#o.quietMaxMs, this.#o.quietBaseMs * 2 ** (n - 1)) * (0.75 + 0.25 * this.#random()));
    this.#quietUntil = Math.max(this.#quietUntil, this.#retryAt, now + quiet);
    this.#pump();
  }

  #acquire(cls: ReadClass, deadline: number): Promise<void> {
    const now = this.#now();
    // Scanner books and history stand aside for the whole quiet period; any read whose wait ends before the
    // cool-down does is told at once.
    if ((cls === 'book' || cls === 'history') && now < this.#quietUntil) {
      return Promise.reject(new ReadSkipped(this.host, cls, 'cooling', this.#quietUntil, now));
    }
    if (this.#retryAt > deadline) return Promise.reject(new ReadSkipped(this.host, cls, 'cooling', this.#retryAt, now));
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        cls, seq: this.#seq++, deadline,
        start: () => resolve(),
        skip: (reason) => reject(new ReadSkipped(this.host, cls, reason, reason === 'cooling' ? Math.max(this.#retryAt, this.#quietUntil) : null, this.#now())),
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

  #refill(now: number): void {
    if (now > this.#refilledAt) {
      this.#tokens = Math.min(this.#o.burst, this.#tokens + ((now - this.#refilledAt) / 1000) * this.#o.ratePerSec);
    }
    this.#refilledAt = now;
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
      else if (this.#retryAt > w.deadline) w.skip('cooling');
      else if (now >= w.deadline) w.skip('budget');
      else kept.push(w);
    }
    this.#queue = kept;
    while (this.#queue.length > 0) {
      const w = this.#queue[0]!;
      if (now < this.#retryAt) {
        wakeAt = this.#retryAt;
        break;
      }
      const critical = w.cls === 'critical';
      const slots = critical ? this.#inFlight < this.#o.maxInFlight
        : this.#inFlight < this.#o.maxInFlight && this.#scanInFlight < this.#o.scanMaxInFlight;
      // A release wakes the queue again; nothing to time.
      if (!slots) break;
      const need = critical ? 1 : 1 + this.#o.criticalReserve;
      if (this.#tokens < need) {
        wakeAt = now + Math.ceil(((need - this.#tokens) / this.#o.ratePerSec) * 1000);
        break;
      }
      this.#queue.shift();
      this.#tokens -= 1;
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
      if (this.#timer !== null) clearTimeout(this.#timer);
      this.#timer = null;
      this.#timerAt = Infinity;
      return;
    }
    if (this.#timer !== null && this.#timerAt <= at) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timerAt = at;
    this.#timer = setTimeout(() => {
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
