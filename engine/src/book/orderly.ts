// The book's Orderly ledgers. Read only; nothing here signs.
//
// Funding: the desk's signed `funding_fee_history` read (OrderlyReader.userFunding over the desk client, one MPC
// signature per page). Only a holder of the operator key (serve) has that client, so `npm run report --sync` reads no
// Orderly funding; it reports what serve booked. Orderly pays once per funding period (8 h, 4 h on some symbols): a
// row is one exact payment standing for its period's hours (`samples`), never an estimate (derive.ts).
//
// Fills: the contract signs no fills read (no trades kind in OrderlyRequest), so the desk's fills come from the
// private session's executionreport pushes, kept here (OrderlyFillLog). The log answers only for the time it heard the
// session: a window before it started (or before what it kept), inside a time the session was down, or not yet heard
// past by ORDERLY_LATE_PUSH_MS (a socket that died silently, a push still on its way) throws, so the book holds the
// exit (or books it "fills unread") instead of taking "no fills" for an answer. Known limit: a position opened before
// serve's last restart has its close window start before the new session, so an Orderly close of it made outside the
// loop is never readable: after the book's 24 h wait it is booked "fills unread" (price and close fees estimated).
// Only a fills read kind in the contract would fix that.
//
// Symbols: the book names a position by its policy symbol (Hyperliquid's and Phoenix's names: "SOL", "kPEPE",
// "GOLD"); an Orderly row "PERP_SOL_USDC" is booked under that name (orderlyBookSymbol).

import { kiloBase } from '../venues/base-symbol.ts';
import { orderlyBase } from '../venues/orderly.ts';
import type { FundingPayment } from '../venues/venue.ts';
import { parseOrderlyReport } from '../trade/legs.ts';
import type { CloseFillQuery, FillFeeQuery } from './sync.ts';
import type { BookFill } from './types.ts';

/** An act's fills are looked for in [startedAt, at], widened by this either way (the venue's clock against ours). */
const SLACK_MS = 5_000;
/** How long the log keeps a fill: past the book's fee lookup (24 h) and its fills-unread wait (24 h). */
export const ORDERLY_FILL_KEEP_MS = 48 * 3_600_000;

/**
 * The book's name for an Orderly market: its cross-venue base as Hyperliquid and Phoenix list it ("PERP_SOL_USDC" ->
 * "SOL", "PERP_1000PEPE_USDC" -> "kPEPE", "PERP_XAU_USDC" -> "GOLD"). A broker's own market keeps its full symbol.
 */
export function orderlyBookSymbol(symbol: string): string {
  const { base, multiplier } = orderlyBase(symbol);
  return multiplier === 1000 ? `k${base}` : base;
}

/** Whether an Orderly symbol is the market a book symbol names (the book's name, or Orderly's own). */
function sameMarket(orderlySymbol: string, bookSymbol: string): boolean {
  if (orderlySymbol === bookSymbol) return true;
  const ours = orderlyBase(orderlySymbol);
  const theirs = kiloBase(bookSymbol);
  return theirs.base.toUpperCase() === ours.base.toUpperCase() && theirs.multiplier === ours.multiplier;
}

/** Every Orderly funding time (8 h and 4 h periods) falls on this UTC grid. */
export const ORDERLY_FUNDING_GRID_MS = 4 * 3_600_000;
/** A payment can show in the history this long after its funding time: a read is still made that long after one. */
export const ORDERLY_FUNDING_POST_LAG_MS = 3_600_000;

/**
 * The book's Orderly funding ledger: the reader's payments under the book's symbol names. Each read costs one MPC
 * signature per page, and Orderly pays only at funding times, so a read is made only when a funding time (plus the
 * posting lag) falls after the last read made; between them the answer is empty without asking. The first read after
 * a start always asks, and each one covers the book's whole window (its cursor less the overlap), so a payment posted
 * late is picked up by the next read.
 */
export function orderlyBookFunding(
  reader: { userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> },
  now: () => number = Date.now,
) {
  let lastTo: number | null = null;
  return {
    /** How many reads were skipped (no funding time since the last one). */
    skipped: 0,
    async userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> {
      const to = endTime ?? now();
      const due = Math.floor(to / ORDERLY_FUNDING_GRID_MS) * ORDERLY_FUNDING_GRID_MS + ORDERLY_FUNDING_POST_LAG_MS;
      if (lastTo !== null && to >= lastTo && due <= lastTo) {
        this.skipped++;
        return [];
      }
      const rows = await reader.userFunding(address, startTime, endTime);
      lastTo = Math.max(lastTo ?? to, to);
      return rows.map((r) => ({ ...r, symbol: orderlyBookSymbol(r.symbol) }));
    },
  };
}

interface LoggedFill {
  key: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  size: number;
  px: number | null;
  fee: number | null;
  time: number;
}

/** A fill's push may come this long after the fill: a window is answered only once the session was heard this past it. */
export const ORDERLY_LATE_PUSH_MS = 10_000;
/** How long a close read waits for the session to be heard past its window plus the late-push margin. */
export const ORDERLY_HEAR_WAIT_MS = 30_000;
/** A push whose own time is further than this from when it came has a clock not to trust: the local time is used. */
export const ORDERLY_PUSH_CLOCK_MAX_MS = 24 * 3_600_000;

/**
 * The desk's Orderly fills as the private session pushed them (executionreport), for the book's fill reads.
 * Wiring (serve, with the private session): `new OrderlyFillLog(since)` once the session's subscriptions are on;
 * `onExecutionReport(raw, receivedAt)` for every executionreport push; `heard(at)` for every frame or pong the session
 * gets (its liveness: nothing after the last one is known); `down(at)` when the session drops and `up(at)` when a new one
 * is subscribed again.
 */
export class OrderlyFillLog {
  #since: number;
  readonly #fills: LoggedFill[] = [];
  readonly #keys = new Set<string>();
  #gaps: { from: number; to: number }[] = [];
  #downSince: number | null = null;
  /** The last time the session was heard (a frame, a pong, a push). */
  #heardUntil: number;
  /** The newest time the log forgot something (a dropped fill, a dropped gap): a window reaching it is unknown. */
  #forgotUntil = -Infinity;
  /** A wait for the session timed out and nothing was heard since: later waits fail at once (one wait per silence). */
  #silent = false;

  /** `since`: when the session's subscriptions were on (ms); nothing before it is known. */
  constructor(since: number) {
    this.#since = since;
    this.#heardUntil = since;
  }

  /** When the session's subscriptions were on: nothing before it is known. */
  get since(): number {
    return this.#since;
  }

  /** The session was heard at `at` (any frame or pong): it was alive up to then. */
  heard(at: number): void {
    if (this.#downSince !== null) return;
    if (at > this.#heardUntil) {
      this.#heardUntil = at;
      this.#silent = false;
    }
    this.#evict();
    for (const w of [...this.#waiters]) if (w.target <= this.#heardUntil) w.done(true);
  }

  readonly #waiters = new Set<{ target: number; done: (ok: boolean) => void }>();

  /**
   * Resolves true once the session is heard at or after `target` (a read up to now waits for the late-push margin
   * to pass), false after `timeoutMs` (a session that went silent: the read then fails as unheard). After a wait that
   * timed out, the next ones fail at once until the session is heard again, so a silent session costs one wait.
   */
  whenHeard(target: number, timeoutMs: number): Promise<boolean> {
    if (this.#heardUntil >= target) return Promise.resolve(true);
    if (this.#silent) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const w = {
        target,
        done: (ok: boolean) => {
          clearTimeout(timer);
          this.#waiters.delete(w);
          if (!ok && this.#heardUntil < target) this.#silent = true;
          resolve(ok);
        },
      };
      const timer = setTimeout(() => w.done(false), timeoutMs);
      timer.unref?.();
      this.#waiters.add(w);
    });
  }

  /** Feed every executionreport push (OrderlyAccountStream onExecutionReport) with the local time it came. */
  onExecutionReport(raw: Record<string, unknown>, receivedAt: number): void {
    this.heard(receivedAt);
    const r = parseOrderlyReport(raw, receivedAt);
    if (r === null || r.side === null || !(r.executedQuantity > 0)) return;
    // One fill per trade id; a push without one is keyed by its order and running total (the same push twice).
    const key = r.tradeId !== null && r.tradeId !== '0' ? `t${r.tradeId}` : `o${r.orderId}|${r.totalExecutedQuantity ?? '?'}|${r.executedQuantity}`;
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    const px = r.executedPrice !== null && r.executedPrice > 0 ? r.executedPrice : null;
    const time = r.time !== null && Math.abs(r.time - receivedAt) <= ORDERLY_PUSH_CLOCK_MAX_MS ? r.time : receivedAt;
    this.#fills.push({ key, symbol: r.symbol, side: r.side, size: r.executedQuantity, px, fee: r.fee, time });
  }

  /** The session dropped at `at`: until up(), what it missed is unknown. */
  down(at: number): void {
    if (this.#downSince === null) this.#downSince = at;
  }

  /** A new session is logged in and subscribed at `at`: the time it was down stays unknown. */
  up(at: number): void {
    if (this.#downSince === null) return;
    this.#gaps.push({ from: this.#downSince, to: at });
    this.#downSince = null;
    this.heard(at);
  }

  /** Why [from, to] cannot be answered, or null when the session heard all of it (and late pushes for it). */
  uncovered(from: number, to: number): string | null {
    if (from < this.#since) return `orderly: the session's fills are known from ${new Date(this.#since).toISOString()} only`;
    if (from <= this.#forgotUntil) return `orderly: what the session heard up to ${new Date(this.#forgotUntil).toISOString()} is no longer kept`;
    if (this.#downSince !== null && to >= this.#downSince) return `orderly: the session is down since ${new Date(this.#downSince).toISOString()}`;
    const gap = this.#gaps.find((g) => g.from <= to && g.to >= from);
    if (gap !== undefined) return `orderly: the session was down ${new Date(gap.from).toISOString()} .. ${new Date(gap.to).toISOString()}`;
    // A socket that died without a close, or a push still on its way: nothing is known past the last frame heard.
    if (to > this.#heardUntil - ORDERLY_LATE_PUSH_MS) return `orderly: the session was last heard ${new Date(this.#heardUntil).toISOString()}`;
    return null;
  }

  #mine(symbol: string, side: 'BUY' | 'SELL', from: number, to: number): LoggedFill[] {
    return this.#fills.filter((f) => f.side === side && f.time >= from && f.time <= to && sameMarket(f.symbol, symbol));
  }

  /**
   * BookSources.closeFills for Orderly: closeFills once the session is heard past the window and the late-push margin
   * (a window up to now waits that long), or after `waitMs` with nothing heard, the read fails.
   */
  async readCloseFills(q: CloseFillQuery, waitMs = ORDERLY_HEAR_WAIT_MS): Promise<{ fill: BookFill; at: number } | null> {
    await this.whenHeard(q.to + ORDERLY_LATE_PUSH_MS, waitMs);
    return this.closeFills(q);
  }

  /** The desk's fills on a market and side in [from, to], summed; throws when the window is not known. */
  closeFills(q: CloseFillQuery): { fill: BookFill; at: number } | null {
    const why = this.uncovered(q.from, q.to);
    if (why !== null) throw new Error(why);
    return sumOrderlyFills(q.side, this.#mine(q.symbol, q.side, q.from, q.to));
  }

  /** BookSources.fillFee for Orderly: what the act's fills on one side were charged; null when it cannot say. */
  fillFee(q: FillFeeQuery): number | null {
    if (q.startedAt === null || !(q.startedAt <= q.at)) return null;
    const lo = q.startedAt - SLACK_MS;
    const hi = q.at + SLACK_MS;
    if (this.uncovered(lo, hi) !== null) return null;
    const mine = this.#mine(q.symbol, q.side, lo, hi);
    if (mine.length === 0 || mine.some((f) => f.fee === null)) return null;
    return mine.reduce((s, f) => s + f.fee!, 0);
  }

  /**
   * Drops fills and gaps older than the keep time. Only a window reaching back to the newest thing dropped is unknown
   * afterwards: a long hold with no fill since its open still reads its close (the open's fill is before the window).
   */
  #evict(): void {
    const keepFrom = this.#heardUntil - ORDERLY_FILL_KEEP_MS;
    for (let i = this.#fills.length - 1; i >= 0; i--) {
      const f = this.#fills[i]!;
      if (f.time >= keepFrom) continue;
      this.#forgotUntil = Math.max(this.#forgotUntil, f.time);
      this.#keys.delete(f.key);
      this.#fills.splice(i, 1);
    }
    if (this.#gaps.some((g) => g.to < keepFrom)) {
      for (const g of this.#gaps) if (g.to < keepFrom) this.#forgotUntil = Math.max(this.#forgotUntil, g.to);
      this.#gaps = this.#gaps.filter((g) => g.to >= keepFrom);
    }
  }
}

/** Fills summed into one BookFill (size-weighted price; the fee null when one is missing) and the last one's time. */
function sumOrderlyFills(side: 'BUY' | 'SELL', rows: readonly LoggedFill[]): { fill: BookFill; at: number } | null {
  let qty = 0;
  let notional = 0;
  let priced = 0;
  let fee: number | null = 0;
  let at = 0;
  for (const r of rows) {
    qty += r.size;
    if (r.px !== null) {
      notional += r.size * r.px;
      priced += r.size;
    }
    fee = fee === null || r.fee === null ? null : fee + r.fee;
    at = Math.max(at, r.time);
  }
  if (qty === 0) return null;
  return { fill: { venue: 'orderly', side, qty: String(Number(qty.toPrecision(12))), avgPx: priced > 0 ? notional / priced : null, feeUsd: fee }, at };
}
