// One leg of a pair on one venue: its position from the venue's own state, and one IOC that answers filled, failed
// (proof that nothing ran) or unknown. The pair trader decides what to do next; a leg never retries on its own.
//
// "Failed" is only what proves nothing ran: a local check before anything was signed, the contract's refusal (it
// signed nothing), Hyperliquid's 4xx or per-order error, Orderly's own refusal of an order, an IOC the venue answered
// with no fill. Everything else (OutcomeUnknown, an MPC timeout on an order, a lost answer, an error this file does
// not know) is unknown, and the caller reconciles from position() before it sends anything else.
//
// An unknown order can still execute later: a late MPC signature is public on NEAR, and Orderly takes a signed copy
// for 300 s. `expiresAt` says until when. Hyperliquid refuses an action after its expiresAfter (stamped by the contract
// from C6 on, block time + 60 s); without one there is no such time, and the order may still land whenever.

import type { TxRef, VenueId } from '@gimbal/shared';
import { ContractRefusal, OutcomeUnknown, SignatureBudgetError } from '../contract/types.ts';
import type { HlOrder, OutcomeIds } from '../contract/types.ts';
import { capPrice, planIoc } from '../relayer/hl-order.ts';
import type { HlSubmitResult } from '../relayer/hyperliquid.ts';
import { HlExchangeError } from '../relayer/hyperliquid.ts';
import type { OrderlyRequest, OrderlyRequestKind } from '../venues/orderly-signer.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import { OrderlyApiError } from '../venues/orderly-http.ts';
import type { OrderlyPositionsSnapshot, OrderlyStreamPosition } from '../venues/orderly-stream.ts';
import { parseRestPositions, streamNumber } from '../venues/orderly-stream.ts';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import { floorToLot, isWholeLots, qtyNumber, qtyString, signedQtyString, toQty } from './lots.ts';

export type LegSide = 'BUY' | 'SELL';

/** Orderly takes a signed request until 300 s after its timestamp; a little more covers clock skew. */
export const ORDERLY_REPLAY_MS = 310_000;
/** After an action's expiresAfter: Hyperliquid's clock and NEAR's block time against the local one. */
export const HL_EXPIRY_MARGIN_MS = 10_000;

/** What one order did, as far as the venue's answer proves it. */
export type LegOutcome =
  | { kind: 'filled'; filled: bigint; avgPx: number | null; ref: LegRef }     // filled > 0, possibly less than asked
  | { kind: 'failed'; error: Error; ref: LegRef }                             // proof that nothing ran
  // Reconcile from position() first. `expiresAt`: local ms after which no copy can execute any more; null when no
  // such time is known (a Hyperliquid order without expiresAfter may still land at any time).
  | { kind: 'unknown'; error: Error; ref: LegRef; expiresAt: number | null };

export interface LegRef {
  venue: VenueId;
  side: LegSide;
  size: string;                  // what was asked, canonical
  reduceOnly: boolean;
  orderId: string | null;        // the venue's id (HL oid, Orderly order_id)
  clientId: string | null;       // HL cloid, Orderly client_order_id
  tx: TxRef[];
  sentAt: number;                // local ms just before the order went to the contract
  /** Local ms of the venue's final word on the order (Orderly's terminal executionreport), when there was one. */
  settledAt?: number;
  /** The signed Hyperliquid action's expiresAfter (ms), when it had one and the answer showed it. */
  expiresAfter?: number;
}

export interface TradeLeg {
  readonly venue: VenueId;
  readonly symbol: string;
  /** Base units per lot on this venue, in 1e-8 units. */
  readonly lot: bigint;
  /** A signed copy of an order can be sent again by anyone inside the venue's window (Orderly, interfaces 1.4). */
  readonly replayable: boolean;
  /** Throws a LegCheckError when the venue or the policy would refuse this size; nothing is signed. */
  check(size: bigint, reduceOnly: boolean): Promise<void>;
  /** The largest order (whole lots) the policy's notional cap allows on this side now; a close is split into these. */
  maxSize(side: LegSide, reduceOnly: boolean): Promise<bigint>;
  /** The signed position (1e-8 units) from the venue's own state, newer than `after` (local ms) when given. */
  position(after?: number): Promise<bigint>;
  /** One IOC. Never throws: every error is classified into the outcome. */
  order(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome>;
}

/** A size or price a venue or the policy would refuse, caught before anything is signed. */
export class LegCheckError extends Error {
  name = 'LegCheckError';
}

/** True only for errors that prove the order did not run. */
export function provesNothingRan(err: unknown): boolean {
  return err instanceof LegCheckError || err instanceof ContractRefusal || err instanceof NothingExecuted
    || err instanceof HlExchangeError || err instanceof OrderlyApiError || err instanceof SignatureBudgetError;
}

/**
 * Whether the order got as far as a signature. Only a local check, the contract's refusal and the signature budget
 * stop it before; anything else (an IOC that did not fill, Orderly refusing the request) was signed, and a signed
 * Orderly order can be sent again by anyone for 300 s.
 */
export function wasSigned(out: LegOutcome): boolean {
  if (out.kind !== 'failed') return true;
  const e = out.error;
  return !(e instanceof LegCheckError || e instanceof ContractRefusal || e instanceof SignatureBudgetError);
}

function classify(err: unknown, ref: LegRef, expiresAt: number | null): LegOutcome {
  const error = err instanceof Error ? err : new Error(String(err));
  return provesNothingRan(err) ? { kind: 'failed', error, ref } : { kind: 'unknown', error, ref, expiresAt };
}

// ---- Hyperliquid ----

export interface HlLegOptions {
  relayer: { hlOrder(order: HlOrder, reason: string): Promise<HlSubmitResult> };
  /** POST /info on the venue's API. */
  info: (body: Record<string, unknown>) => Promise<unknown>;
  user: string;                  // the desk's EVM address
  coin: string;                  // "ETH"
  asset: number;
  szDecimals: number;
  /** The contract's stored price, or null for an asset the policy lists as unpriced (no band, max_sz instead). */
  oraclePx: () => Promise<number | null>;
  bandBps: number;
  maxNotionalUsd: number;
  maxSz?: string;
  /** Best ask for a buy, best bid for a sell. */
  bestPx: (side: LegSide) => Promise<number>;
  slippageBps?: number;
  /**
   * The contract stamps orders with expiresAfter = block time + this (60 s from C6 on). An MPC timeout returns no
   * payload to read it from; with this set, its late signature is known dead by then. Unset (C5): never known dead.
   */
  expiresAfterMs?: number;
  clock?: Clock;
}

export class HlLeg implements TradeLeg {
  readonly venue = 'hyperliquid' as const;
  readonly symbol: string;
  readonly lot: bigint;
  readonly replayable = false;     // every signed action has its own nonce: Hyperliquid takes it once
  readonly #o: HlLegOptions;
  readonly #clock: Clock;

  constructor(options: HlLegOptions) {
    this.#o = options;
    this.symbol = options.coin;
    this.lot = 10n ** BigInt(8 - options.szDecimals);
    this.#clock = options.clock ?? systemClock;
  }

  async check(size: bigint, reduceOnly: boolean): Promise<void> {
    await this.#plan('BUY', size, reduceOnly);
    await this.#plan('SELL', size, reduceOnly);
  }

  async maxSize(side: LegSide): Promise<bigint> {
    // The limit price of an order on this side now (one lot, so no venue minimum applies to the probe).
    const plan = await this.#plan(side, this.lot, true);
    const capPx = capPrice(plan.px, await this.#o.oraclePx());
    let max = floorToLot(toQty((this.#o.maxNotionalUsd / capPx).toFixed(8)), this.lot);
    if (this.#o.maxSz !== undefined) max = minQ(max, floorToLot(toQty(this.#o.maxSz), this.lot));
    return max;
  }

  async position(): Promise<bigint> {
    const state = await this.#o.info({ type: 'clearinghouseState', user: this.#o.user.toLowerCase() }) as { assetPositions?: unknown };
    if (!Array.isArray(state?.assetPositions)) throw new Error(`hyperliquid clearinghouseState for ${this.#o.user}: no assetPositions list`);
    let q = 0n;
    for (const row of state.assetPositions as { position?: { coin?: unknown; szi?: unknown } }[]) {
      if (row?.position?.coin !== this.symbol) continue;
      const szi = row.position.szi;
      if (typeof szi !== 'string' && typeof szi !== 'number') throw new Error(`hyperliquid position ${this.symbol}: szi is ${JSON.stringify(szi)}`);
      q += toQty(szi);
    }
    return q;
  }

  async order(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome> {
    const ref: LegRef = { venue: this.venue, side, size: qtyString(size), reduceOnly, orderId: null, clientId: null, tx: [], sentAt: this.#clock.now() };
    let order: HlOrder;
    try {
      order = (await this.#plan(side, size, reduceOnly)).order;
    } catch (err) {
      return classify(err instanceof LegCheckError ? err : new LegCheckError(errorText(err)), ref, null);
    }
    ref.clientId = order.cloid ?? null;
    ref.sentAt = this.#clock.now();
    let result: HlSubmitResult;
    try {
      result = await this.#o.relayer.hlOrder(order, reason);
    } catch (err) {
      if (err instanceof NothingExecuted || err instanceof OutcomeUnknown) ref.tx = err.tx;
      if (err instanceof OutcomeUnknown && err.ids.hlExpiresAfter !== undefined) ref.expiresAfter = err.ids.hlExpiresAfter;
      return classify(err, ref, this.#expiresAt(err));
    }
    ref.tx = result.tx;
    ref.orderId = result.oid === null ? null : String(result.oid);
    if (result.expiresAfter !== null) ref.expiresAfter = result.expiresAfter;
    const filled = result.filled === null ? 0n : toQty(result.filled.totalSz);
    if (filled === 0n) return { kind: 'failed', error: new NothingExecuted('hyperliquid', `the IOC ${ref.clientId} did not fill`, result.tx), ref };
    return { kind: 'filled', filled, avgPx: result.filled === null ? null : Number(result.filled.avgPx), ref };
  }

  /**
   * When no copy of an order whose outcome is unknown can execute any more: its signed expiresAfter when the payload
   * was seen (a lost /exchange answer), else, after an MPC timeout, now + the contract's window (the block that asked
   * for the signature is not later than now); null without either.
   */
  #expiresAt(err: unknown): number | null {
    const signed = err instanceof OutcomeUnknown ? err.ids.hlExpiresAfter : undefined;
    if (signed !== undefined) return signed + HL_EXPIRY_MARGIN_MS;
    if (this.#o.expiresAfterMs !== undefined) return this.#clock.now() + this.#o.expiresAfterMs + HL_EXPIRY_MARGIN_MS;
    return null;
  }

  async #plan(side: LegSide, size: bigint, reduceOnly: boolean): Promise<{ order: HlOrder; px: number }> {
    if (size <= 0n || !isWholeLots(size, this.lot)) throw new LegCheckError(`hyperliquid ${this.symbol}: ${signedQtyString(size)} is not a positive multiple of the lot ${qtyString(this.lot)}`);
    const [bookPx, oraclePx] = await Promise.all([this.#o.bestPx(side), this.#o.oraclePx()]);
    try {
      const plan = planIoc({
        asset: this.#o.asset, szDecimals: this.#o.szDecimals, side: side === 'BUY' ? 'buy' : 'sell', oraclePx, bandBps: this.#o.bandBps,
        bookPx, maxNotionalUsd: this.#o.maxNotionalUsd, sz: qtyString(size), reduceOnly,
        ...(this.#o.maxSz === undefined ? {} : { maxSz: this.#o.maxSz }),
        ...(this.#o.slippageBps === undefined ? {} : { slippageBps: this.#o.slippageBps }),
      });
      return { order: plan.order, px: plan.px };
    } catch (err) {
      throw new LegCheckError(`hyperliquid ${this.symbol}: ${errorText(err)}`);
    }
  }
}

// ---- Orderly ----

/** One executionreport push, the fields the leg uses (Orderly's v2 private stream names, camelCase). */
export interface OrderlyReport {
  symbol: string;
  orderId: string;
  clientOrderId: string | null;
  side: LegSide | null;
  status: string;                // NEW | PARTIAL_FILLED | FILLED | CANCELLED | REJECTED
  executedQuantity: number;      // this report's fill (0 on a status change without a fill)
  totalExecutedQuantity: number | null;
  avgPrice: number | null;
  receivedAt: number;            // local ms
}

const TERMINAL = new Set(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']);

export function parseOrderlyReport(r: Record<string, unknown>, receivedAt: number): OrderlyReport | null {
  const orderId = r.orderId ?? r.order_id;
  if (typeof r.symbol !== 'string' || (typeof orderId !== 'number' && typeof orderId !== 'string') || typeof r.status !== 'string') return null;
  const side = r.side === 'BUY' || r.side === 'SELL' ? r.side : null;
  const clientOrderId = r.clientOrderId ?? r.client_order_id;
  return {
    symbol: r.symbol, orderId: String(orderId), clientOrderId: typeof clientOrderId === 'string' && clientOrderId !== '' ? clientOrderId : null, side,
    status: r.status, executedQuantity: streamNumber(r.executedQuantity) ?? 0, totalExecutedQuantity: streamNumber(r.totalExecutedQuantity) ?? null,
    avgPrice: streamNumber(r.avgPrice) ?? null, receivedAt,
  };
}

export interface OrderlyLegOptions {
  relayer: { orderlyRequest<T = unknown>(kind: OrderlyRequestKind, fields: Partial<OrderlyRequest>, reason: string): Promise<{ data: T; tx: TxRef[]; clientOrderId: string | null }> };
  /** The signed `positions` read (OrderlyDeskClient.positions); refused by a contract without the read kinds. */
  readPositions: () => Promise<unknown>;
  /** The desk's private session: its pushes are the fallback when the read is refused. */
  stream: { positionsState(): Promise<OrderlyPositionsSnapshot> };
  symbol: string;                // "PERP_ETH_USDC"
  lot: bigint;                   // base_tick
  baseMin: bigint;
  quoteTick: number;
  minNotional: number;
  maxNotionalUsd: number;
  /** The contract's stored price of the base asset, null when the policy lists it as unpriced; default null. */
  oraclePx?: () => Promise<number | null>;
  maxSz?: string;                // the policy's unpriced max_sz for the base asset
  bestPx: (side: LegSide) => Promise<number>;
  slippageBps?: number;
  /** How long an order waits for its terminal executionreport (an IOC ends at once; default 15 s). */
  reportTimeoutMs?: number;
  /** How long position() waits for a push when the read is refused (default 8 s), and settles after a report. */
  pushWaitMs?: number;
  settleMs?: number;
  /**
   * A contract without the `positions` read kind (round-1 code) and an idle account leave the start position
   * unknown. A start the operator asserts, used only then, and checked on every later snapshot against the fills
   * the session saw: a mismatch makes position() throw from then on.
   */
  assumedStart?: bigint;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export class OrderlyLeg implements TradeLeg {
  readonly venue = 'orderly' as const;
  readonly symbol: string;
  readonly lot: bigint;
  readonly replayable = true;
  readonly #o: OrderlyLegOptions;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #reports: OrderlyReport[] = [];
  readonly #waiters = new Set<() => void>();
  #sessionFills = 0n;            // signed fills on this symbol since the leg started listening
  #startAssumed = false;
  #startWrong: Error | null = null;
  #readRefused: Error | null = null;
  /** The newest terminal report an order of this leg waited for: a push before it may predate the fill. */
  #lastSettledAt = 0;

  constructor(options: OrderlyLegOptions) {
    this.#o = options;
    this.symbol = options.symbol;
    this.lot = options.lot;
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Feed every executionreport push here (OrderlyAccountStream onExecutionReport). */
  onExecutionReport(raw: Record<string, unknown>): void {
    const report = parseOrderlyReport(raw, this.#clock.now());
    if (report === null || report.symbol !== this.symbol) return;
    if (report.executedQuantity > 0 && report.side !== null) {
      const q = toQty(report.executedQuantity);
      this.#sessionFills += report.side === 'BUY' ? q : -q;
    }
    this.#reports.push(report);
    if (this.#reports.length > 500) this.#reports.shift();
    for (const wake of this.#waiters) wake();
  }

  /** Every report seen for an order id, oldest first. */
  reportsFor(orderId: string): OrderlyReport[] {
    return this.#reports.filter((r) => r.orderId === orderId);
  }

  async check(size: bigint, reduceOnly: boolean): Promise<void> {
    this.#checkSize(size, reduceOnly);
    const oracle = await this.#oracle();
    for (const side of ['BUY', 'SELL'] as const) this.#checkNotional(size, this.#price(side, await this.#o.bestPx(side)), oracle, reduceOnly);
  }

  async maxSize(side: LegSide): Promise<bigint> {
    const capPx = capPrice(this.#price(side, await this.#o.bestPx(side)), await this.#oracle());
    let max = floorToLot(toQty((this.#o.maxNotionalUsd / capPx).toFixed(8)), this.lot);
    if (this.#o.maxSz !== undefined) max = minQ(max, floorToLot(toQty(this.#o.maxSz), this.lot));
    return max;
  }

  async position(after?: number): Promise<bigint> {
    if (this.#startWrong !== null) throw this.#startWrong;
    // 1. The signed REST read: Orderly's own answer, always newer than `after`.
    if (this.#readRefused === null) {
      try {
        return qtyOf(parseRestPositions(await this.#o.readPositions()), this.symbol);
      } catch (err) {
        if (!(err instanceof ContractRefusal)) throw err;
        this.#readRefused = err;
        this.#o.log?.(`orderly ${this.symbol}: the positions read is refused (${err.message}); positions come from the private session's pushes`);
      }
    }
    // 2. The session's state: a seed read, or a push received after `after` and after the newest terminal report.
    const snap = await this.#snapshot(after === undefined ? undefined : Math.max(after, this.#lastSettledAt));
    if (snap !== null) return this.#checkedAgainstStart(qtyOf(snap.positions, this.symbol));
    // 3. Nothing known, before any order: the asserted start, if there is one.
    if (after === undefined && this.#o.assumedStart !== undefined && !this.#startAssumed) {
      this.#startAssumed = true;
      this.#o.log?.(`orderly ${this.symbol}: no position known (no read kind, no push); using the asserted start ${signedQtyString(this.#o.assumedStart)}, checked on every later push`);
      return this.#o.assumedStart;
    }
    throw new Error(`orderly ${this.symbol}: position unknown: the positions read is refused (${this.#readRefused?.message}) and no push came after the order`);
  }

  async order(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome> {
    const ref: LegRef = { venue: this.venue, side, size: qtyString(size), reduceOnly, orderId: null, clientId: null, tx: [], sentAt: this.#clock.now() };
    let price: string;
    try {
      this.#checkSize(size, reduceOnly);
      const px = this.#price(side, await this.#o.bestPx(side));
      this.#checkNotional(size, px, await this.#oracle(), reduceOnly);
      price = String(px);
    } catch (err) {
      return classify(err instanceof LegCheckError ? err : new LegCheckError(errorText(err)), ref, null);
    }
    ref.sentAt = this.#clock.now();
    const expiresAt = ref.sentAt + ORDERLY_REPLAY_MS;
    let answer: { data: { order_id?: unknown; client_order_id?: unknown }; tx: TxRef[]; clientOrderId: string | null };
    try {
      answer = await this.#o.relayer.orderlyRequest<{ order_id?: unknown; client_order_id?: unknown }>('order', {
        symbol: this.symbol, side, order_type: 'IOC', price: canonicalPrice(price), quantity: qtyString(size), reduce_only: reduceOnly,
      }, reason);
    } catch (err) {
      if (err instanceof OutcomeUnknown) {
        ref.tx = err.tx;
        ref.clientId = err.ids.orderlyClientOrderId ?? null;
      }
      return classify(err, ref, expiresAt);
    }
    ref.tx = answer.tx;
    ref.clientId = answer.clientOrderId;
    const orderId = answer.data?.order_id;
    if (typeof orderId !== 'number' && typeof orderId !== 'string') {
      return { kind: 'unknown', error: this.#unknown(ref, `Orderly accepted the order without an order_id (${JSON.stringify(answer.data)})`), ref, expiresAt };
    }
    ref.orderId = String(orderId);
    const end = await this.#terminal(ref.orderId);
    if (end === null) return { kind: 'unknown', error: this.#unknown(ref, `no final executionreport for order ${ref.orderId} within ${this.#o.reportTimeoutMs ?? 15_000} ms`), ref, expiresAt };
    ref.settledAt = end.receivedAt;
    this.#lastSettledAt = Math.max(this.#lastSettledAt, end.receivedAt);
    if (end.status === 'REJECTED') return { kind: 'failed', error: new OrderlyApiError('order', 200, null, `order ${ref.orderId} rejected`, JSON.stringify(end)), ref };
    const executed = end.totalExecutedQuantity ?? this.reportsFor(ref.orderId).reduce((s, r) => s + r.executedQuantity, 0);
    const filled = toQty(executed);
    if (filled === 0n) return { kind: 'failed', error: new NothingExecuted('orderly', `the IOC ${ref.orderId} did not fill (${end.status})`, ref.tx), ref };
    return { kind: 'filled', filled, avgPx: end.avgPrice, ref };
  }

  #oracle(): Promise<number | null> {
    return this.#o.oraclePx?.() ?? Promise.resolve(null);
  }

  #unknown(ref: LegRef, detail: string): OutcomeUnknown {
    const ids: OutcomeIds = {};
    if (ref.clientId !== null) ids.orderlyClientOrderId = ref.clientId;
    const near = ref.tx.find((t) => t.chain === 'near');
    if (near !== undefined) ids.nearTx = near.id;
    return new OutcomeUnknown(`orderly order ${this.symbol}`, detail, ids, ref.tx);
  }

  /** The order's final report (FILLED, CANCELLED, REJECTED), from the reports already seen or the next ones. */
  async #terminal(orderId: string): Promise<OrderlyReport | null> {
    const deadline = this.#clock.now() + (this.#o.reportTimeoutMs ?? 15_000);
    for (;;) {
      const end = this.reportsFor(orderId).find((r) => TERMINAL.has(r.status));
      if (end !== undefined) return end;
      const left = deadline - this.#clock.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.#waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, Math.min(left, 500));
        this.#waiters.add(wake);
      });
    }
  }

  /** The session's state when it says something newer than `after`; null when it knows nothing usable. */
  async #snapshot(after: number | undefined): Promise<OrderlyPositionsSnapshot | null> {
    const wait = this.#o.pushWaitMs ?? 8_000;
    const deadline = this.#clock.now() + (after === undefined ? 0 : wait);
    if (after !== undefined) await this.#sleep(this.#o.settleMs ?? 1_500);   // the pushes of one IOC come together
    for (;;) {
      try {
        const snap = await this.#o.stream.positionsState();
        if (after === undefined || snap.positionsReceivedAt >= after) return snap;
      } catch {
        // not known yet (no seed, no push): wait for a push below
      }
      if (this.#clock.now() >= deadline) return null;
      await this.#sleep(250);
    }
  }

  #checkedAgainstStart(q: bigint): bigint {
    if (this.#startAssumed) {
      const expected = this.#o.assumedStart! + this.#sessionFills;
      if (q !== expected) {
        this.#startWrong = new Error(`orderly ${this.symbol}: the asserted start ${signedQtyString(this.#o.assumedStart!)} was wrong: the venue shows ${signedQtyString(q)}, the start plus the session's fills is ${signedQtyString(expected)}`);
        throw this.#startWrong;
      }
    }
    return q;
  }

  #checkSize(size: bigint, reduceOnly: boolean): void {
    if (size <= 0n || !isWholeLots(size, this.lot)) throw new LegCheckError(`orderly ${this.symbol}: ${signedQtyString(size)} is not a positive multiple of base_tick ${qtyString(this.lot)}`);
    if (!reduceOnly && size < this.#o.baseMin) throw new LegCheckError(`orderly ${this.symbol}: ${qtyString(size)} is under base_min ${qtyString(this.#o.baseMin)}`);
    if (this.#o.maxSz !== undefined && size > toQty(this.#o.maxSz)) throw new LegCheckError(`orderly ${this.symbol}: ${qtyString(size)} is over the unpriced asset's max_sz ${this.#o.maxSz}`);
  }

  /** The policy cap at max(limit, oracle), as the contract values it; Orderly's minimum at the limit. */
  #checkNotional(size: bigint, px: number, oracle: number | null, reduceOnly: boolean): void {
    const capPx = capPrice(px, oracle);
    const capped = qtyNumber(size) * capPx;
    if (capped > this.#o.maxNotionalUsd) throw new LegCheckError(`orderly ${this.symbol}: ${qtyString(size)} at ${capPx} is ${capped.toFixed(2)} USD, over the policy's ${this.#o.maxNotionalUsd} USD`);
    const notional = qtyNumber(size) * px;
    if (!reduceOnly && notional < this.#o.minNotional) throw new LegCheckError(`orderly ${this.symbol}: ${qtyString(size)} at ${px} is ${notional.toFixed(2)} USD, under Orderly's min_notional ${this.#o.minNotional}`);
  }

  /** The IOC limit: past the best price by the slippage, on the quote tick, never inside the best price. */
  #price(side: LegSide, best: number): number {
    if (!(best > 0)) throw new LegCheckError(`orderly ${this.symbol}: no ${side === 'BUY' ? 'ask' : 'bid'} to price against`);
    const slip = (this.#o.slippageBps ?? 50) / 10_000;
    const tick = this.#o.quoteTick;
    const ticks = side === 'BUY' ? Math.floor((best * (1 + slip)) / tick) : Math.ceil((best * (1 - slip)) / tick);
    const bestTicks = side === 'BUY' ? Math.ceil(best / tick - 1e-9) : Math.floor(best / tick + 1e-9);
    const n = side === 'BUY' ? Math.max(ticks, bestTicks) : Math.min(ticks, bestTicks);
    return Number((n * tick).toFixed(decimalsOf(tick)));
  }
}

function qtyOf(positions: OrderlyStreamPosition[], symbol: string): bigint {
  return positions.filter((p) => p.symbol === symbol).reduce((s, p) => s + toQty(p.positionQty), 0n);
}

function minQ(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function decimalsOf(tick: number): number {
  const text = tick.toString();
  return text.includes('e-') ? Number(text.split('e-')[1]) : (text.split('.')[1] ?? '').length;
}

/** A price as the contract takes it: a canonical decimal string. */
function canonicalPrice(price: string): string {
  return qtyString(toQty(price));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
