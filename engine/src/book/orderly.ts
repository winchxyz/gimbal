// The book's Orderly ledgers. Read only; nothing here signs.
//
// Funding: the desk's signed `funding_fee_history` read (OrderlyReader.userFunding over the desk client, one MPC
// signature per page). Only a holder of the operator key (serve) has that client, so `npm run report --sync` reads no
// Orderly funding; it reports what serve booked. Orderly pays once per funding period (8 h, 4 h on some symbols): a
// row is one exact payment standing for its period's hours (`samples`), never an estimate (derive.ts).
//
// Fills: the contract signs no fills read (no trades kind in OrderlyRequest), so the desk's fills come from the
// private session's executionreport pushes, kept here (OrderlyFillLog). The log answers only for the time it heard the
// session: a window before it started, inside a time the session was down, or past what it kept throws, so the book
// holds the exit (or books it "fills unread") instead of taking "no fills" for an answer.
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

/** The book's Orderly funding ledger: the reader's payments under the book's symbol names. */
export function orderlyBookFunding(reader: { userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> }) {
  return {
    async userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> {
      const rows = await reader.userFunding(address, startTime, endTime);
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

/** The desk's Orderly fills as the private session pushed them (executionreport), for the book's fill reads. */
export class OrderlyFillLog {
  #since: number;
  readonly #fills: LoggedFill[] = [];
  readonly #keys = new Set<string>();
  readonly #gaps: { from: number; to: number }[] = [];
  #downSince: number | null = null;
  #latest: number;

  /** `since`: when the session's subscriptions were on (ms); nothing before it is known. */
  constructor(since: number) {
    this.#since = since;
    this.#latest = since;
  }

  /** Feed every executionreport push (OrderlyAccountStream onExecutionReport) with the local time it came. */
  onExecutionReport(raw: Record<string, unknown>, receivedAt: number): void {
    this.#latest = Math.max(this.#latest, receivedAt);
    const r = parseOrderlyReport(raw, receivedAt);
    if (r === null || r.side === null || !(r.executedQuantity > 0)) return;
    // One fill per trade id; a push without one is keyed by its order and running total (the same push twice).
    const key = r.tradeId !== null && r.tradeId !== '0' ? `t${r.tradeId}` : `o${r.orderId}|${r.totalExecutedQuantity ?? '?'}|${r.executedQuantity}`;
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    const px = r.executedPrice !== null && r.executedPrice > 0 ? r.executedPrice : null;
    this.#fills.push({ key, symbol: r.symbol, side: r.side, size: r.executedQuantity, px, fee: r.fee, time: r.time ?? receivedAt });
    this.#evict();
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
  }

  /** Why [from, to] cannot be answered, or null when the session heard all of it. */
  uncovered(from: number, to: number): string | null {
    if (from < this.#since) return `orderly: the session's fills are known from ${new Date(this.#since).toISOString()} only`;
    if (this.#downSince !== null && to >= this.#downSince) return `orderly: the session is down since ${new Date(this.#downSince).toISOString()}`;
    const gap = this.#gaps.find((g) => g.from <= to && g.to >= from);
    return gap === undefined ? null : `orderly: the session was down ${new Date(gap.from).toISOString()} .. ${new Date(gap.to).toISOString()}`;
  }

  #mine(symbol: string, side: 'BUY' | 'SELL', from: number, to: number): LoggedFill[] {
    return this.#fills.filter((f) => f.side === side && f.time >= from && f.time <= to && sameMarket(f.symbol, symbol));
  }

  /** BookSources.closeFills for Orderly: the desk's fills on a market and side in [from, to], summed; throws when unknown. */
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

  #evict(): void {
    const keepFrom = this.#latest - ORDERLY_FILL_KEEP_MS;
    while (this.#fills.length > 0 && this.#fills[0]!.time < keepFrom) {
      const f = this.#fills.shift()!;
      this.#keys.delete(f.key);
      this.#since = Math.max(this.#since, f.time + 1);
    }
    while (this.#gaps.length > 0 && this.#gaps[0]!.to < this.#since) this.#gaps.shift();
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
