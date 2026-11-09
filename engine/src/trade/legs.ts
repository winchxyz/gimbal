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
// from C6 on, block time + 60 s), but only the signed payload proves there is one: after an MPC timeout no payload is
// in hand, so the order counts as having no expiry, and it may still land whenever.

import type { TxRef, VenueId } from '@gimbal/shared';
import { ContractRefusal, OutcomeUnknown, SignatureBudgetError } from '../contract/types.ts';
import type { HlOrder, OutcomeIds } from '../contract/types.ts';
import { HL_MIN_ORDER_USD, capPrice, hlPx, newCloid, planIoc } from '../relayer/hl-order.ts';
import type { HlFill, HlSubmitResult } from '../relayer/hyperliquid.ts';
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
/**
 * Hyperliquid takes an action only while its nonce is inside (block time − 2 days, block time + 1 day), and the
 * contract's nonce is the block time it signed at: an order with no answer and no expiry can land that long after.
 */
export const HL_NONCE_WINDOW_MS = 2 * 86_400_000;

/** What one order did, as far as the venue's answer proves it. */
// `fee`: what the venue charged for the fill, USD (Hyperliquid userFills `fee`, Phoenix trades-history `fees`, Orderly
// executionreport `fee` / `totalFee`); null
// or absent when the venue's answer did not say. `parts`: a maker order is several orders (post-only limits, then an
// IOC); the outcome sums them, and each part is its own order record.
export type LegOutcome =
  | { kind: 'filled'; filled: bigint; avgPx: number | null; fee?: number | null; ref: LegRef; parts?: LegOutcome[] }   // filled > 0, possibly less than asked
  | { kind: 'failed'; error: Error; ref: LegRef; parts?: LegOutcome[] }                                                // proof that nothing ran
  // Reconcile from position() first. `expiresAt`: local ms after which no copy can execute any more; null when no
  // such time is known (a Hyperliquid order without expiresAfter may still land at any time).
  | { kind: 'unknown'; error: Error; ref: LegRef; expiresAt: number | null; parts?: LegOutcome[] };

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
  /** The IOC a maker order sent after its window for what the post-only part did not fill (the taker fallback). */
  takerFallback?: true;
}

/**
 * One maker order's taker fallback, asked for by its caller (an owner demo entry's open, serve-pair.ts): after the
 * maker window, an IOC for what the post-only part did not fill, its limit held within `markBps` of the venue's mark
 * as well as by the band, the caps and the slippage every IOC has. The mark must be read, else nothing is sent.
 */
export interface TakerFallback {
  markBps: number;
}

/** What one makerOrder call may add to the leg's MakerSettings. */
export interface MakerOrderOptions {
  takerFallback?: TakerFallback;
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
  /**
   * Maker first (optional): post-only limits at the touch, repriced, then an IOC for what is left after the timeout
   * when the leg's MakerSettings.takerFallback or `options.takerFallback` asks for one. The outcome sums every part;
   * never throws. `options` is required (pass undefined for none) so a wrapper (GuardedLeg) cannot drop it unseen.
   */
  makerOrder?(side: LegSide, size: bigint, reduceOnly: boolean, reason: string, options: MakerOrderOptions | undefined): Promise<LegOutcome>;
  /**
   * Starts one pair operation (an open with all its parts, or a close): until the returned function ends it, the leg's
   * maker orders share one budget of maxOrders post-only orders and one reprice floor (repriceMs between placements).
   */
  beginMakerOperation?(): () => void;
  /**
   * A venue whose state is read from a snapshot that can lag the chain (Phoenix): the chain's confirmed slot now
   * becomes the oldest snapshot position() trusts, so a read after a restart cannot show the legs as they were before
   * the last landed transaction (an older snapshot is waited for, then thrown: unknown). Throws when the chain's slot
   * cannot be read; the read that needed it is then unknown too.
   */
  syncToChain?(): Promise<void>;
}

/** How a maker order works the book: reprice at most every `repriceMs`, give up after `timeoutMs`, then IOC or not. */
export interface MakerSettings {
  repriceMs: number;
  timeoutMs: number;
  /** After the timeout, an IOC for what is left (true), or stop with what filled (false). An explicit opt-in. */
  takerFallback: boolean;
  /** How often a resting order's status is read (default 1 s). */
  pollMs?: number;
  /**
   * The most post-only orders signed per pair operation (default 6; per maker order when no operation was begun), a
   * crossing refusal included: from C10 the contract meters signed notional that is not reduce-only per rolling hour,
   * and every reprice is signed again. Two placements are always at least repriceMs apart, after a refusal too.
   */
  maxOrders?: number;
}

export const DEFAULT_MAKER: MakerSettings = { repriceMs: 30_000, timeoutMs: 180_000, takerFallback: false, pollMs: 1_000, maxOrders: 6 };

/** A post-only order a maker order left without a settled state: it may still rest and fill. */
export interface PendingMakerOrder {
  cloid: string;
  oid: number | null;
  side: LegSide;
  size: string;
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
  relayer: {
    hlOrder(order: HlOrder, reason: string): Promise<HlSubmitResult>;
    /** Needed by makerOrder only: a resting post-only order is cancelled before it is repriced. */
    hlCancel?(asset: number, oid: number, reason: string): Promise<HlSubmitResult>;
  };
  /**
   * POST /info on the venue's API (clearinghouseState, orderStatus, userFills, the taker fallback's metaAndAssetCtxs).
   * On the network it must be charged to the host's weight budget without waiting for it (cli/pair-ops.ts and
   * serve-pair.ts hlInfo: venues/hyperliquid.ts hlTradeFetch), so a trade near the scanner's busiest minute does not
   * take the IP past Hyperliquid's limit, and is never held up by it.
   */
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
   * The venue's mark price now (a taker fallback's limit is held within TakerFallback.markBps of it). Default: read
   * from `info` (metaAndAssetCtxs, the coin's markPx); null or a throw: not known, and no fallback is sent.
   */
  markPx?: () => Promise<number | null>;
  /** How makerOrder works the book (default DEFAULT_MAKER). */
  maker?: MakerSettings;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

export class HlLeg implements TradeLeg {
  readonly venue = 'hyperliquid' as const;
  readonly symbol: string;
  readonly lot: bigint;
  readonly replayable = false;     // every signed action has its own nonce: Hyperliquid takes it once
  readonly #o: HlLegOptions;
  readonly #clock: Clock;
  /** Post-only orders whose state a maker order could not settle (cancelPending tries them again). */
  readonly #pending: PendingMakerOrder[] = [];
  /**
   * The pair operation in progress (null: none begun, maxOrders and the reprice floor per call): the post-only orders
   * it may still sign, and when it placed its last one.
   */
  #op: { left: number; lastPlacedAt: number | null } | null = null;

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
    return this.#ioc(side, size, reduceOnly, reason, null);
  }

  /** One IOC; `markBps`: its limit also held within that many bps of the mark (a taker fallback), refused unread. */
  async #ioc(side: LegSide, size: bigint, reduceOnly: boolean, reason: string, markBps: number | null): Promise<LegOutcome> {
    const ref: LegRef = { venue: this.venue, side, size: qtyString(size), reduceOnly, orderId: null, clientId: null, tx: [], sentAt: this.#clock.now() };
    let order: HlOrder;
    try {
      order = (await this.#plan(side, size, reduceOnly, markBps)).order;
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
    return { kind: 'filled', filled, avgPx: result.filled === null ? null : Number(result.filled.avgPx), fee: feeOf(result.fills), ref };
  }

  /**
   * Maker first: a post-only (Alo) limit at the touch (best bid for a buy, best ask for a sell), read every pollMs,
   * cancelled and placed again at the new touch every repriceMs, until the size filled or timeoutMs passed; then an
   * IOC for the rest when takerFallback is on (the leg's MakerSettings, or `options.takerFallback`, whose IOC limit is
   * also held within markBps of the mark; that IOC's ref says takerFallback). An Alo that would cross is refused by Hyperliquid (nothing ran) and is
   * placed again repriceMs after it. Each resting order's fill is read from orderStatus (origSz − sz) once it is no longer open,
   * its price and fee from userFills. A post-only order whose state cannot be settled (no answer and no expiry, still
   * open after two cancels, or a status read that keeps failing) stops the whole order as unknown with no expiry: it
   * may still fill, and it is kept for cancelPending. At most maxOrders post-only orders are signed (per pair
   * operation once beginMakerOperation was called), each at least repriceMs after the one before. Never throws.
   */
  async makerOrder(side: LegSide, size: bigint, reduceOnly: boolean, reason: string, options: MakerOrderOptions = {}): Promise<LegOutcome> {
    const s = { ...DEFAULT_MAKER, ...this.#o.maker };
    const fallback = options.takerFallback;
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const poll = s.pollMs ?? 1_000;
    const maxOrders = s.maxOrders ?? 6;
    const started = this.#clock.now();
    const deadline = started + s.timeoutMs;
    const parts: LegOutcome[] = [];
    let filled = 0n;
    let notional = 0;
    let fee: number | null = 0;
    let refusedInARow = 0;
    let placed = 0;
    const op = this.#op;
    let lastPlacedAt: number | null = op?.lastPlacedAt ?? null;
    const budget = (): boolean => placed < maxOrders && (op === null || op.left > 0);
    let spent = false;
    /** The post-only order out now, until its final state is read. */
    let resting: { cloid: string; oid: number | null; size: string } | null = null;
    const stuck = (cloid: string, oid: number | null, sz: string): void => {
      this.#pending.push({ cloid, oid: oid !== null && oid >= 0 ? oid : null, side, size: sz });
    };
    const total = (out: LegOutcome): void => {
      parts.push(out);
      if (out.kind !== 'filled') return;
      filled += out.filled;
      notional += qtyNumber(out.filled) * (out.avgPx ?? 0);
      fee = fee === null || out.fee === null || out.fee === undefined ? null : fee + out.fee;
    };
    const summary = (last: LegOutcome | undefined, unknown: LegOutcome | null): LegOutcome => {
      if (unknown !== null && !parts.includes(unknown)) parts.push(unknown);
      // The ids of the order with no answer when there is one: it is the one to reconcile.
      const named = unknown ?? last;
      const ref: LegRef = {
        venue: this.venue, side, size: qtyString(size), reduceOnly, orderId: named?.ref.orderId ?? null, clientId: named?.ref.clientId ?? null,
        tx: parts.flatMap((p) => p.ref.tx), sentAt: started,
      };
      if (unknown !== null && unknown.kind === 'unknown') return { kind: 'unknown', error: unknown.error, ref, expiresAt: unknown.expiresAt, parts };
      if (filled > 0n) return { kind: 'filled', filled, avgPx: notional > 0 ? notional / qtyNumber(filled) : null, fee, ref, parts };
      const error = spent
        ? new NothingExecuted('hyperliquid', `the maker order ${side} ${qtyString(size)} did not fill: the budget of ${maxOrders} post-only orders ${op === null ? 'per maker order' : 'for this open or close'} is spent`, ref.tx)
        : last !== undefined && last.kind !== 'filled' ? last.error : new NothingExecuted('hyperliquid', `the maker order ${side} ${qtyString(size)} did not fill`, ref.tx);
      return { kind: 'failed', error, ref, parts };
    };

    try {
      while (filled < size && this.#clock.now() < deadline && refusedInARow < 5 && budget()) {
        // Never two placements less than repriceMs apart (a crossing refusal or an early cancel included): each one
        // is signed and metered.
        if (lastPlacedAt !== null) {
          const next = lastPlacedAt + s.repriceMs;
          if (next >= deadline) break;
          if (this.#clock.now() < next) await sleep(next - this.#clock.now());
        }
        const left = size - filled;
        const ref: LegRef = { venue: this.venue, side, size: qtyString(left), reduceOnly, orderId: null, clientId: null, tx: [], sentAt: this.#clock.now() };
        let order: HlOrder;
        try {
          order = await this.#makerPlan(side, left, reduceOnly);
        } catch (err) {
          total({ kind: 'failed', error: err instanceof LegCheckError ? err : new LegCheckError(errorText(err)), ref });
          break;      // the rest goes to the IOC, which checks it again
        }
        ref.clientId = order.cloid ?? null;
        let oid: number | null = null;
        placed++;
        lastPlacedAt = this.#clock.now();
        if (op !== null) {
          op.left--;
          op.lastPlacedAt = lastPlacedAt;
        }
        resting = { cloid: order.cloid!, oid: null, size: order.sz };
        try {
          const result = await this.#o.relayer.hlOrder(order, `${reason} (maker)`);
          ref.tx = result.tx;
          oid = result.oid;
          if (result.expiresAfter !== null) ref.expiresAfter = result.expiresAfter;
        } catch (err) {
          if (err instanceof NothingExecuted || err instanceof OutcomeUnknown) ref.tx = err.tx;
          if (provesNothingRan(err)) {
            // Most often an Alo that would have crossed: the touch moved. Placed again at the new one.
            resting = null;
            total({ kind: 'failed', error: err as Error, ref });
            refusedInARow++;
            continue;
          }
          const known = await this.#statusAfterUnknown(order.cloid!, err, sleep);
          if (known === null) {
            stuck(order.cloid!, null, order.sz);
            resting = null;
            return summary(parts.at(-1), classify(err, ref, null));
          }
          oid = known;
        }
        refusedInARow = 0;
        if (oid === null || !Number.isFinite(oid)) {
          stuck(order.cloid!, null, order.sz);
          resting = null;
          return summary(parts.at(-1), classify(new Error('hyperliquid accepted the post-only order without an oid'), ref, null));
        }
        resting.oid = oid;
        ref.orderId = String(oid);
        const repriceAt = Math.min(this.#clock.now() + s.repriceMs, deadline);
        // A status read that fails (a 429, a 5xx, an answer this code does not know) ends the wait: the order is
        // cancelled and read again below, never left resting behind a throw.
        let status: HlOrderStatus | null = null;
        try {
          status = await this.#orderStatus(oid);
          while (status?.status === 'open' && this.#clock.now() < repriceAt) {
            await sleep(poll);
            status = await this.#orderStatus(oid);
          }
        } catch {
          status = null;
        }
        const final = await this.#closeResting(oid, status, reason, sleep);
        if (final === null) {
          stuck(order.cloid!, oid, order.sz);
          resting = null;
          return summary(parts.at(-1), { kind: 'unknown', error: new Error(`hyperliquid post-only order ${oid} (${order.cloid}) could not be settled after two cancels: it may still rest and fill`), ref, expiresAt: null });
        }
        resting = null;
        const got = final.filled;
        if (got === 0n) {
          total({ kind: 'failed', error: new NothingExecuted('hyperliquid', `post-only order ${oid} did not fill before it was cancelled`, ref.tx), ref });
          continue;
        }
        const fills = await this.#fillsOf(oid, got, sleep);
        total({ kind: 'filled', filled: got, avgPx: fills.avgPx ?? final.limitPx, fee: fills.fee, ref });
      }

      spent = filled < size && !budget();
      if (filled < size && (s.takerFallback || fallback !== undefined)) {
        const out = await this.#ioc(side, size - filled, reduceOnly, `${reason} (taker fallback)`, fallback?.markBps ?? null);
        out.ref.takerFallback = true;
        total(out);
        if (out.kind === 'unknown') return summary(out, out);
        // Nothing filled at all: the fallback's own refusal or miss is the reason, not the spent post-only budget.
        spent = false;
      }
      return summary(parts.at(-1), null);
    } catch (err) {
      // Nothing above should throw; if something does, the order out now (if any) may still rest.
      const left: string = resting === null ? qtyString(size - filled) : resting.size;
      if (resting !== null) stuck(resting.cloid, resting.oid, resting.size);
      const ref: LegRef = { venue: this.venue, side, size: left, reduceOnly, orderId: resting?.oid === null || resting === null ? null : String(resting.oid), clientId: resting?.cloid ?? null, tx: [], sentAt: this.#clock.now() };
      return summary(parts.at(-1), { kind: 'unknown', error: new Error(`hyperliquid maker order: ${errorText(err)}`), ref, expiresAt: resting === null ? this.#clock.now() : null });
    }
  }

  beginMakerOperation(): () => void {
    const op = { left: { ...DEFAULT_MAKER, ...this.#o.maker }.maxOrders ?? 6, lastPlacedAt: null };
    this.#op = op;
    return () => {
      if (this.#op === op) this.#op = null;
    };
  }

  /** Post-only orders a maker order could not settle; they may still rest and fill. */
  pendingMakerOrders(): readonly PendingMakerOrder[] {
    return this.#pending;
  }

  /** Post-only orders an earlier process could not settle (a saved state): cancelPending tries them like its own. */
  adoptPending(orders: readonly PendingMakerOrder[]): void {
    for (const p of orders) if (!this.#pending.some((x) => x.cloid === p.cloid)) this.#pending.push({ ...p });
  }

  /**
   * Tries each post-only order a maker order could not settle once more: its status by oid (or cloid), a cancel while
   * it rests, and what it filled. One line each; an order whose state is settled here leaves the list. Never throws.
   */
  async cancelPending(reason: string): Promise<string[]> {
    const lines: string[] = [];
    for (const p of [...this.#pending]) {
      const name = `hyperliquid ${p.side} ${p.size} post-only ${p.oid ?? '(no oid)'} cloid ${p.cloid}`;
      try {
        let st = await this.#orderStatus(p.oid ?? p.cloid);
        if (st === null) {
          lines.push(`${name}: Hyperliquid does not know it (yet); it may still land`);
          continue;
        }
        if (st.status === 'open' && this.#o.relayer.hlCancel !== undefined) {
          try {
            await this.#o.relayer.hlCancel(this.#o.asset, st.oid, `${reason} (cancel a post-only order left resting)`);
          } catch {
            // refused (it filled or ended) or no answer: the status read decides
          }
          st = await this.#orderStatus(st.oid);
        }
        if (st === null || st.status === 'open') {
          lines.push(`${name}: still resting; cancel it on Hyperliquid by hand`);
          continue;
        }
        lines.push(`${name}: ${st.status}, filled ${qtyString(st.origSz - st.sz)} of ${qtyString(st.origSz)}`);
        this.#pending.splice(this.#pending.indexOf(p), 1);
      } catch (err) {
        lines.push(`${name}: its status cannot be read (${errorText(err)}); check it on Hyperliquid by hand`);
      }
    }
    return lines;
  }

  /** A post-only limit at the touch, inside 95 % of the band, under the cap, over Hyperliquid's minimum. */
  async #makerPlan(side: LegSide, size: bigint, reduceOnly: boolean): Promise<HlOrder> {
    const name = `hyperliquid ${this.symbol}`;
    if (size <= 0n || !isWholeLots(size, this.lot)) throw new LegCheckError(`${name}: ${signedQtyString(size)} is not a positive multiple of the lot ${qtyString(this.lot)}`);
    const buy = side === 'BUY';
    // The passive side of the book: a buy rests at the best bid (what a sell would take), a sell at the best ask.
    const [touch, oracle] = await Promise.all([this.#o.bestPx(buy ? 'SELL' : 'BUY'), this.#o.oraclePx()]);
    if (!(touch > 0)) throw new LegCheckError(`${name}: no ${buy ? 'bid' : 'ask'} to rest at`);
    const px = hlPx(touch, this.#o.szDecimals, buy ? 'down' : 'up');
    const pxN = Number(px);
    if (oracle !== null && Math.abs(pxN - oracle) * 10_000 > this.#o.bandBps * 0.95 * oracle) {
      throw new LegCheckError(`${name}: the touch ${px} is outside 95 % of the ${this.#o.bandBps} bps band around the contract's price ${oracle}`);
    }
    const capped = qtyNumber(size) * capPrice(pxN, oracle);
    if (capped > this.#o.maxNotionalUsd) throw new LegCheckError(`${name}: ${qtyString(size)} at ${capPrice(pxN, oracle)} is ${capped.toFixed(2)} USD, over the policy's ${this.#o.maxNotionalUsd} USD`);
    if (this.#o.maxSz !== undefined && size > toQty(this.#o.maxSz)) throw new LegCheckError(`${name}: ${qtyString(size)} is over the unpriced asset's max_sz ${this.#o.maxSz}`);
    if (!reduceOnly && qtyNumber(size) * pxN < HL_MIN_ORDER_USD) throw new LegCheckError(`${name}: ${qtyString(size)} at ${px} is under Hyperliquid's ${HL_MIN_ORDER_USD} USD minimum`);
    return { asset: this.#o.asset, is_buy: buy, px, sz: qtyString(size), reduce_only: reduceOnly, tif: 'Alo', cloid: newCloid() };
  }

  /** orderStatus by oid or cloid: the order's status and sizes, or null when Hyperliquid does not know it (unknownOid). */
  async #orderStatus(id: number | string): Promise<HlOrderStatus | null> {
    const r = await this.#o.info({ type: 'orderStatus', user: this.#o.user.toLowerCase(), oid: id }) as {
      status?: unknown; order?: { status?: unknown; order?: { oid?: unknown; sz?: unknown; origSz?: unknown; limitPx?: unknown } };
    };
    if (r?.status === 'unknownOid') return null;
    const o = r?.order?.order;
    if (r?.status !== 'order' || typeof r.order?.status !== 'string' || o === undefined) throw new Error(`hyperliquid orderStatus ${id}: unexpected answer ${JSON.stringify(r)?.slice(0, 160)}`);
    return {
      status: r.order.status, oid: Number(o.oid), sz: toQty(String(o.sz)), origSz: toQty(String(o.origSz)), limitPx: Number(o.limitPx),
    };
  }

  /**
   * A post-only order whose submission has no answer: its oid from orderStatus by cloid. Not known yet: once its
   * signed action expired (expiresAfter), still not known means it never ran (null is returned then only when no
   * expiry is known, i.e. it may still land). Returns the oid, or -1 for "never ran".
   */
  async #statusAfterUnknown(cloid: string, err: unknown, sleep: (ms: number) => Promise<void>): Promise<number | null> {
    const expiresAt = this.#expiresAt(err);
    try {
      const now = await this.#orderStatus(cloid);
      if (now !== null) return now.oid;
      if (expiresAt === null) return null;
      const wait = expiresAt - this.#clock.now();
      if (wait > 0) await sleep(wait);
      const later = await this.#orderStatus(cloid);
      return later === null ? -1 : later.oid;
    } catch {
      return null;
    }
  }

  /**
   * Ends a resting post-only order: cancelled while open (a cancel refused because it filled or ended is fine), then
   * read until it is no longer open. Null when it stays open after two cancels.
   */
  async #closeResting(oid: number, status: HlOrderStatus | null, reason: string, sleep: (ms: number) => Promise<void>): Promise<{ filled: bigint; limitPx: number } | null> {
    if (oid === -1) return { filled: 0n, limitPx: 0 };
    let st = status;
    for (let attempt = 0; attempt < 2 && (st === null || st.status === 'open'); attempt++) {
      // Cancelled whenever it is not known to be closed: an unread status may be an order still resting.
      if (this.#o.relayer.hlCancel !== undefined) {
        try {
          await this.#o.relayer.hlCancel(this.#o.asset, oid, `${reason} (reprice)`);
        } catch {
          // refused (it filled or ended meanwhile) or no answer: the status read below decides
        }
      }
      for (let i = 0; i < 10; i++) {
        try {
          st = await this.#orderStatus(oid);
        } catch {
          st = null;
        }
        if (st !== null && st.status !== 'open') break;
        await sleep(500);
      }
    }
    if (st === null || st.status === 'open') return null;
    return { filled: st.origSz - st.sz, limitPx: st.limitPx };
  }

  /** The fills of `oid` in userFills (price and fee), once they add up to `size`; a few tries. */
  async #fillsOf(oid: number, size: bigint, sleep: (ms: number) => Promise<void>): Promise<{ avgPx: number | null; fee: number | null }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const rows = await this.#o.info({ type: 'userFills', user: this.#o.user.toLowerCase() }) as HlFill[];
        const mine = (Array.isArray(rows) ? rows : []).filter((f) => Number(f.oid) === oid);
        const sz = mine.reduce((acc, f) => acc + toQty(f.sz), 0n);
        if (mine.length > 0 && sz >= size) {
          const px = mine.reduce((acc, f) => acc + Number(f.sz) * Number(f.px), 0) / qtyNumber(sz);
          return { avgPx: px, fee: feeOf(mine) };
        }
      } catch {
        // userFills not read: tried again
      }
      await sleep(1_000);
    }
    return { avgPx: null, fee: null };
  }

  /**
   * When no copy of an order whose outcome is unknown can execute any more: the signed payload's expiresAfter (a lost
   * /exchange answer), plus a margin. Nothing else counts: after an MPC timeout no payload is in hand, and a window
   * assumed from settings would be wrong on a contract that stamps none (C5), so the answer is null (no expiry).
   */
  #expiresAt(err: unknown): number | null {
    const signed = err instanceof OutcomeUnknown ? err.ids.hlExpiresAfter : undefined;
    return signed === undefined ? null : signed + HL_EXPIRY_MARGIN_MS;
  }

  /** `markBps` (a taker fallback): the limit also held within that many bps of the mark, which must be read. */
  async #plan(side: LegSide, size: bigint, reduceOnly: boolean, markBps: number | null = null): Promise<{ order: HlOrder; px: number }> {
    if (size <= 0n || !isWholeLots(size, this.lot)) throw new LegCheckError(`hyperliquid ${this.symbol}: ${signedQtyString(size)} is not a positive multiple of the lot ${qtyString(this.lot)}`);
    const [bookPx, oraclePx, markPx] = await Promise.all([
      this.#o.bestPx(side), this.#o.oraclePx(), markBps === null ? Promise.resolve(null) : this.#markPx().catch(() => null),
    ]);
    if (markBps !== null && (markPx === null || !(markPx > 0) || !Number.isFinite(markPx))) {
      throw new LegCheckError(`hyperliquid ${this.symbol}: the mark price cannot be read, so the taker fallback's limit cannot be held within ${markBps} bps of it: nothing sent`);
    }
    try {
      const plan = planIoc({
        asset: this.#o.asset, szDecimals: this.#o.szDecimals, side: side === 'BUY' ? 'buy' : 'sell', oraclePx, bandBps: this.#o.bandBps,
        bookPx, maxNotionalUsd: this.#o.maxNotionalUsd, sz: qtyString(size), reduceOnly,
        ...(this.#o.maxSz === undefined ? {} : { maxSz: this.#o.maxSz }),
        ...(this.#o.slippageBps === undefined ? {} : { slippageBps: this.#o.slippageBps }),
        ...(markBps === null || markPx === null ? {} : { mark: { px: markPx, bps: markBps } }),
      });
      return { order: plan.order, px: plan.px };
    } catch (err) {
      throw new LegCheckError(`hyperliquid ${this.symbol}: ${errorText(err)}`);
    }
  }

  /** The coin's mark: the option's, else metaAndAssetCtxs (a builder-deployed "dex:COIN" asks that dex). Null: none. */
  async #markPx(): Promise<number | null> {
    if (this.#o.markPx !== undefined) return this.#o.markPx();
    const colon = this.symbol.indexOf(':');
    const r = await this.#o.info({ type: 'metaAndAssetCtxs', ...(colon > 0 ? { dex: this.symbol.slice(0, colon) } : {}) });
    if (!Array.isArray(r) || r.length < 2) return null;
    const [meta, ctxs] = r as [{ universe?: { name?: unknown }[] }, { markPx?: unknown }[]];
    const i = meta?.universe?.findIndex((u) => u?.name === this.symbol) ?? -1;
    const px = i >= 0 && Array.isArray(ctxs) ? Number(ctxs[i]?.markPx) : NaN;
    return px > 0 && Number.isFinite(px) ? px : null;
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
  /**
   * What Orderly charged, USD: `fee` for this report's execution, `totalFee` for the order so far (> 0 a cost, < 0 a
   * maker rebate, as Orderly's fee rates are signed). Null when absent, or when `feeAsset` is not USDC.
   */
  fee: number | null;
  totalFee: number | null;
  executedPrice: number | null;  // this report's fill price (0 on a report without a fill)
  tradeId: string | null;        // this report's fill ("0" on a report without a fill)
  time: number | null;           // the venue's event time (`timestamp`), ms
  receivedAt: number;            // local ms
}

const TERMINAL = new Set(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']);

// Field names as Orderly's private executionreport sends them (a testnet push of 2026-10-27 carried fee 0, feeAsset
// "USDC", totalFee 0, executedPrice, tradeId, timestamp; Orderly's docs list the same names).
export function parseOrderlyReport(r: Record<string, unknown>, receivedAt: number): OrderlyReport | null {
  const orderId = r.orderId ?? r.order_id;
  if (typeof r.symbol !== 'string' || (typeof orderId !== 'number' && typeof orderId !== 'string') || typeof r.status !== 'string') return null;
  const side = r.side === 'BUY' || r.side === 'SELL' ? r.side : null;
  const clientOrderId = r.clientOrderId ?? r.client_order_id;
  const usdFee = r.feeAsset === undefined || r.feeAsset === 'USDC';
  const tradeId = r.tradeId;
  const time = streamNumber(r.timestamp);
  return {
    symbol: r.symbol, orderId: String(orderId), clientOrderId: typeof clientOrderId === 'string' && clientOrderId !== '' ? clientOrderId : null, side,
    status: r.status, executedQuantity: streamNumber(r.executedQuantity) ?? 0, totalExecutedQuantity: streamNumber(r.totalExecutedQuantity) ?? null,
    avgPrice: streamNumber(r.avgPrice) ?? null,
    fee: usdFee ? streamNumber(r.fee) ?? null : null, totalFee: usdFee ? streamNumber(r.totalFee) ?? null : null,
    executedPrice: streamNumber(r.executedPrice) ?? null,
    tradeId: (typeof tradeId === 'number' || typeof tradeId === 'string') && String(tradeId) !== '' ? String(tradeId) : null,
    time: time !== undefined && time > 0 ? time : null, receivedAt,
  };
}

/** How far the fills' fee sum and the final report's totalFee may differ before it is a disagreement, USD. */
export const ORDERLY_FEE_TOLERANCE_USD = 2e-6;

/**
 * What Orderly charged for one order: the sum of its fill reports' `fee` when every fill report seen has one and they
 * add up to the order's executed total, else its final report's `totalFee`; null when neither says. When both are
 * known and differ, `onDisagree` hears it (the sum is kept).
 */
export function orderlyOrderFee(end: OrderlyReport, reports: readonly OrderlyReport[], onDisagree?: (note: string) => void): number | null {
  const fills = reports.filter((r) => r.executedQuantity > 0);
  const executed = fills.reduce((s, r) => s + r.executedQuantity, 0);
  const whole = fills.length > 0 && fills.every((r) => r.fee !== null)
    && (end.totalExecutedQuantity === null || Math.abs(executed - end.totalExecutedQuantity) <= 1e-9 * Math.max(1, executed));
  const sum = whole ? fills.reduce((s, r) => s + r.fee!, 0) : null;
  if (sum === null) return end.totalFee;
  // Orderly rounds each fee to 1e-6 USDC: a difference within that is the rounding, not a disagreement.
  if (end.totalFee !== null && Math.abs(sum - end.totalFee) > ORDERLY_FEE_TOLERANCE_USD) {
    onDisagree?.(`orderly order ${end.orderId}: the fills' fees add up to ${sum}, its final report says totalFee ${end.totalFee}; booked ${sum}`);
  }
  return sum;
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
  /** A fee disagreement between the fills and the final report was logged (once per leg). */
  #feeNoted = false;

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
    const fee = orderlyOrderFee(end, this.reportsFor(ref.orderId), (note) => {
      if (this.#feeNoted) return;
      this.#feeNoted = true;
      this.#o.log?.(`${note} (said once)`);
    });
    return { kind: 'filled', filled, avgPx: end.avgPrice, fee, ref };
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

/** orderStatus's answer, the fields a maker order reads (sizes in 1e-8 units; `sz` is what is left). */
interface HlOrderStatus {
  status: string;                // open | filled | canceled | marginCanceled | rejected | ...
  oid: number;
  sz: bigint;
  origSz: bigint;
  limitPx: number;
}

/** The fee of some Hyperliquid fills, USD (userFills `fee`, the builder's share included); null when one has none. */
function feeOf(fills: readonly HlFill[]): number | null {
  if (fills.length === 0 || fills.some((f) => f.fee === undefined)) return null;
  return fills.reduce((s, f) => s + Number(f.fee), 0);
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
