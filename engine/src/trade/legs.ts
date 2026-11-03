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
// `fee`: what the venue charged for the fill, USD (Hyperliquid userFills `fee`, Phoenix trades-history `fees`); null
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
   * Maker first (optional): post-only limits at the touch, repriced, then an IOC for what is left after the timeout.
   * The outcome sums every part; never throws.
   */
  makerOrder?(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome>;
}

/** How a maker order works the book: reprice at most every `repriceMs`, give up after `timeoutMs`, then IOC or not. */
export interface MakerSettings {
  repriceMs: number;
  timeoutMs: number;
  /** After the timeout, an IOC for what is left (true), or stop with what filled (false). */
  takerFallback: boolean;
  /** How often a resting order's status is read (default 1 s). */
  pollMs?: number;
}

export const DEFAULT_MAKER: MakerSettings = { repriceMs: 10_000, timeoutMs: 60_000, takerFallback: true, pollMs: 1_000 };

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
    return { kind: 'filled', filled, avgPx: result.filled === null ? null : Number(result.filled.avgPx), fee: feeOf(result.fills), ref };
  }

  /**
   * Maker first: a post-only (Alo) limit at the touch (best bid for a buy, best ask for a sell), read every pollMs,
   * cancelled and placed again at the new touch every repriceMs, until the size filled or timeoutMs passed; then an
   * IOC for the rest when takerFallback is on. An Alo that would cross is refused by Hyperliquid (nothing ran) and is
   * simply placed again. Each resting order's fill is read from orderStatus (origSz − sz) once it is no longer open,
   * its price and fee from userFills. A post-only order whose state cannot be settled (no answer and no expiry, or
   * still open after two cancels) stops the whole order as unknown with no expiry: it may still fill.
   */
  async makerOrder(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome> {
    const s = { ...DEFAULT_MAKER, ...this.#o.maker };
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const poll = s.pollMs ?? 1_000;
    const started = this.#clock.now();
    const deadline = started + s.timeoutMs;
    const parts: LegOutcome[] = [];
    let filled = 0n;
    let notional = 0;
    let fee: number | null = 0;
    let refusedInARow = 0;
    const total = (out: LegOutcome): void => {
      parts.push(out);
      if (out.kind !== 'filled') return;
      filled += out.filled;
      notional += qtyNumber(out.filled) * (out.avgPx ?? 0);
      fee = fee === null || out.fee === null || out.fee === undefined ? null : fee + out.fee;
    };
    const summary = (last: LegOutcome | undefined, unknown: LegOutcome | null): LegOutcome => {
      if (unknown !== null && !parts.includes(unknown)) parts.push(unknown);
      const ref: LegRef = {
        venue: this.venue, side, size: qtyString(size), reduceOnly, orderId: last?.ref.orderId ?? null, clientId: last?.ref.clientId ?? null,
        tx: parts.flatMap((p) => p.ref.tx), sentAt: started,
      };
      if (unknown !== null && unknown.kind === 'unknown') return { kind: 'unknown', error: unknown.error, ref, expiresAt: unknown.expiresAt, parts };
      if (filled > 0n) return { kind: 'filled', filled, avgPx: notional > 0 ? notional / qtyNumber(filled) : null, fee, ref, parts };
      const error = last !== undefined && last.kind !== 'filled' ? last.error : new NothingExecuted('hyperliquid', `the maker order ${side} ${qtyString(size)} did not fill`, ref.tx);
      return { kind: 'failed', error, ref, parts };
    };

    while (filled < size && this.#clock.now() < deadline && refusedInARow < 5) {
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
      try {
        const result = await this.#o.relayer.hlOrder(order, `${reason} (maker)`);
        ref.tx = result.tx;
        oid = result.oid;
        if (result.expiresAfter !== null) ref.expiresAfter = result.expiresAfter;
      } catch (err) {
        if (err instanceof NothingExecuted || err instanceof OutcomeUnknown) ref.tx = err.tx;
        if (provesNothingRan(err)) {
          // Most often an Alo that would have crossed: the touch moved. Placed again at the new one.
          total({ kind: 'failed', error: err as Error, ref });
          refusedInARow++;
          await sleep(poll);
          continue;
        }
        const known = await this.#statusAfterUnknown(order.cloid!, err, sleep);
        if (known === null) return summary(parts.at(-1), classify(err, ref, null));
        oid = known;
      }
      refusedInARow = 0;
      if (oid === null || !Number.isFinite(oid)) return summary(parts.at(-1), classify(new Error('hyperliquid accepted the post-only order without an oid'), ref, null));
      ref.orderId = String(oid);
      const repriceAt = Math.min(this.#clock.now() + s.repriceMs, deadline);
      let status = await this.#orderStatus(oid);
      while (status?.status === 'open' && this.#clock.now() < repriceAt) {
        await sleep(poll);
        status = await this.#orderStatus(oid);
      }
      const final = await this.#closeResting(oid, status, reason, sleep);
      if (final === null) {
        return summary(parts.at(-1), { kind: 'unknown', error: new Error(`hyperliquid post-only order ${oid} is still open after two cancels: it may still fill`), ref, expiresAt: null });
      }
      const got = final.filled;
      if (got === 0n) {
        total({ kind: 'failed', error: new NothingExecuted('hyperliquid', `post-only order ${oid} did not fill before it was cancelled`, ref.tx), ref });
        continue;
      }
      const fills = await this.#fillsOf(oid, got, sleep);
      total({ kind: 'filled', filled: got, avgPx: fills.avgPx ?? final.limitPx, fee: fills.fee, ref });
    }

    if (filled < size && s.takerFallback) {
      const out = await this.order(side, size - filled, reduceOnly, `${reason} (taker fallback)`);
      total(out);
      if (out.kind === 'unknown') return summary(out, out);
    }
    return summary(parts.at(-1), null);
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
      if (st !== null && this.#o.relayer.hlCancel !== undefined) {
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
