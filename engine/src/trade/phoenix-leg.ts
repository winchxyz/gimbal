// The Phoenix leg of a pair: its position from Phoenix's trader snapshot, and one IOC (place_market_order) signed by
// `sol_sign` and sent to Solana, answered filled, failed (proof that nothing ran) or unknown, as HlLeg answers.
//
// The order: a limit at the best price past the slippage, held inside the policy band around the contract's stored
// price (95 % of it, as Hyperliquid's planIoc), on the market's tick; base lots from the policy's base_lot_e8; the
// reduce-only flag on closes. The packet fills all its lots or none (minBaseLotsToFill = numBaseLots), so a partial
// fill is not expected, but the fill is measured anyway: the position read after the transaction's slot, minus the
// one before. Price and fee come from Phoenix's trades-history row of the transaction's signature.
//
// Outcomes:
//   - a local check, the contract's refusal, the signature budget: failed, nothing signed;
//   - the transaction landed with an error, or its blockhash expired unseen (NothingExecuted): failed;
//   - an MPC timeout: unknown, with expiresAt once the chain is past the message's lastValidBlockHeight (a late
//     signature can still be posted while the blockhash lives);
//   - it landed and the position did not move, read from a snapshot at or past the slot it landed in: failed (an IOC
//     with nothing to match). Without that slot (or the chain's confirmed slot after it, a lower bound) no snapshot
//     can be proven to include it: unknown, never failed (a stale snapshot reads "did not move", and a retry would
//     double the leg);
//   - OutcomeUnknown (no proof either way): the leg waits until the chain is past the message's lastValidBlockHeight
//     (after it no copy can land), takes the slot that height was read at as the oldest snapshot it trusts, and
//     answers unknown with that time as expiresAt, so the pair reads the position once and knows; when that cannot
//     be proven, expiresAt is null and the pair treats the order as unsettled.
// A signed Solana transaction executes at most once and dies with its blockhash, so the leg is not replayable.

import type { TxRef } from '@gimbal/shared';
import { MpcTimeoutError, OutcomeUnknown } from '../contract/types.ts';
import type { SolanaMessageBuilder } from '../relayer/relayer.ts';
import type { ComputeBudget, PhoenixMarketAccounts } from '../relayer/phoenix-tx.ts';
import {
  MAX_PRIORITY_MICROLAMPORTS, ORDER_COMPUTE_UNITS, ORDER_PRIORITY_MICROLAMPORTS, PHOENIX_MAINNET, cancelAllMessage, orderMessage,
} from '../relayer/phoenix-tx.ts';
import type { DeskSolanaAccounts, PhoenixExchangeAccounts } from '../relayer/phoenix-withdraw.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import type { HostBudget } from '../venues/http-budget.ts';
import { PHOENIX_BUDGET, hostBudget, readClass, requestTimeoutMs } from '../venues/http-budget.ts';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import type { LegOutcome, LegRef, LegSide, TradeLeg } from './legs.ts';
import { LegCheckError, provesNothingRan } from './legs.ts';
import { isWholeLots, qtyNumber, qtyString, signedQtyString, toQty } from './lots.ts';

/** How far inside the policy band a limit is held: the stored price can move a little before the contract checks. */
const BAND_USE = 0.95;

/** A policy market with its spline: what the leg orders on. */
export interface PhoenixLegMarket extends PhoenixMarketAccounts {
  baseLotE8: number;             // policy base_lot_e8: base units × 1e8 per lot
  tickE8: number;                // policy tick_e8: USD × 1e8 per base unit per tick
}

/** Phoenix's HTTP reads the leg needs: the trader snapshot and its fills (raw JSON, parsed here). */
export interface PhoenixTraderApi {
  traderState(authority: string): Promise<unknown>;
  tradesHistory(authority: string, limit: number): Promise<unknown>;
}

export interface PhoenixLegOptions {
  relayer: { solSign(build: SolanaMessageBuilder, reason: string): Promise<TxRef[]> };
  chain: {
    latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
    signatureSlot(signature: string): Promise<number | null>;
    /** The chain's confirmed slot now: a lower bound for a transaction already confirmed whose slot is not known. */
    currentSlot?(): Promise<number>;
  };
  /** SolanaSubmitter.landedSlot: the slot of a transaction it saw confirmed (asked first, before the RPC). */
  landedSlot?: (signature: string) => number | null;
  /**
   * SolanaSubmitter.waitPastLastValidHeightSlot: the slot at which the chain was proven past that height, or null
   * when it was not proven in time.
   */
  waitPastLastValidHeight: (lastValidBlockHeight: number) => Promise<number | null>;
  /** The orders' unit price (default 100,000 µlamports, at most 200,000); the unit limit is the 600k cap. */
  microLamports?: number;
  /** How long a landed transaction's slot is looked up before the order is answered unknown (default 15 s). */
  slotWaitMs?: number;
  api: PhoenixTraderApi;
  desk: DeskSolanaAccounts;
  market: PhoenixLegMarket;
  exchange?: PhoenixExchangeAccounts;
  /** The contract's stored price, or null for a symbol the policy lists as unpriced (no band, max_sz instead). */
  oraclePx: () => Promise<number | null>;
  bandBps: number;
  maxNotionalUsd: number;
  maxSz?: string;
  /** Best ask for a buy, best bid for a sell. */
  bestPx: (side: LegSide) => Promise<number>;
  slippageBps?: number;
  /** How long position() waits for a snapshot at or past the last transaction's slot (default 20 s). */
  settleTimeoutMs?: number;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

/** One trader snapshot, the fields the leg reads. */
export interface TraderSnapshot {
  slot: number;
  state: string | null;
  lots: bigint;                  // signed base lots of the leg's symbol, every subaccount
}

/** The planned IOC: ticks and lots on the wire, the limit in USD for the logs and the cap. */
export interface PhoenixIocPlan {
  side: LegSide;
  lots: bigint;
  ticks: bigint;
  px: number;
  reduceOnly: boolean;
}

export function parseTraderSnapshot(raw: unknown, symbol: string): TraderSnapshot {
  const r = raw as { slot?: unknown; snapshot?: { capabilities?: { state?: unknown }; subaccounts?: unknown } } | null;
  if (r === null || typeof r !== 'object' || typeof r.slot !== 'number') throw new Error(`phoenix trader state: no slot in ${JSON.stringify(raw)?.slice(0, 160)}`);
  const subs = r.snapshot?.subaccounts;
  if (subs !== undefined && !Array.isArray(subs)) throw new Error('phoenix trader state: subaccounts is not a list');
  let lots = 0n;
  for (const sub of (subs ?? []) as { positions?: { symbol?: unknown; basePositionLots?: unknown }[] }[]) {
    for (const p of sub.positions ?? []) {
      if (p.symbol !== symbol) continue;
      if (typeof p.basePositionLots !== 'string' || !/^-?\d+$/.test(p.basePositionLots)) {
        throw new Error(`phoenix trader state ${symbol}: basePositionLots is ${JSON.stringify(p.basePositionLots)}`);
      }
      lots += BigInt(p.basePositionLots);
    }
  }
  const state = r.snapshot?.capabilities?.state;
  return { slot: r.slot, state: typeof state === 'string' ? state : null, lots };
}

/** One transaction's fills on `symbol` in a trades-history answer: size (base units), average price and fees (USD). */
export function fillsOf(raw: unknown, signature: string, symbol: string): { size: number; avgPx: number; feeUsd: number } | null {
  const rows = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return null;
  let size = 0;
  let quote = 0;
  let fee = 0;
  for (const row of rows as { signature?: unknown; marketSymbol?: unknown; baseLotsDelta?: unknown; price?: unknown; fees?: unknown }[]) {
    if (row.signature !== signature || row.marketSymbol !== symbol) continue;
    // Observed on mainnet: baseLotsDelta comes in base units ("-2.04" XRP), fees and price in USD.
    const sz = Math.abs(Number(row.baseLotsDelta));
    const px = Number(row.price);
    const f = Number(row.fees);
    if (!Number.isFinite(sz) || !Number.isFinite(px) || !Number.isFinite(f)) continue;
    size += sz;
    quote += sz * px;
    fee += f;
  }
  return size > 0 ? { size, avgPx: quote / size, feeUsd: fee } : null;
}

export class PhoenixLeg implements TradeLeg {
  readonly venue = 'phoenix' as const;
  readonly symbol: string;
  readonly lot: bigint;
  readonly replayable = false;     // a signed transaction runs once and dies with its blockhash
  readonly #o: PhoenixLegOptions;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #exchange: PhoenixExchangeAccounts;
  readonly #budget: ComputeBudget;
  /** The slot of the last transaction of this leg that landed: a snapshot older than it does not show it. */
  #minSlot = 0;

  constructor(options: PhoenixLegOptions) {
    if (!Number.isSafeInteger(options.market.baseLotE8) || options.market.baseLotE8 < 1) throw new Error(`phoenix ${options.market.symbol}: bad base_lot_e8 ${options.market.baseLotE8}`);
    if (!Number.isSafeInteger(options.market.tickE8) || options.market.tickE8 < 1) throw new Error(`phoenix ${options.market.symbol}: bad tick_e8 ${options.market.tickE8}`);
    this.#o = options;
    this.symbol = options.market.symbol;
    this.lot = BigInt(options.market.baseLotE8);
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#exchange = options.exchange ?? PHOENIX_MAINNET;
    const price = options.microLamports ?? ORDER_PRIORITY_MICROLAMPORTS;
    if (!Number.isSafeInteger(price) || price < 1 || price > MAX_PRIORITY_MICROLAMPORTS) {
      throw new Error(`phoenix: the unit price ${price} µlamports is outside 1..${MAX_PRIORITY_MICROLAMPORTS}`);
    }
    this.#budget = { units: ORDER_COMPUTE_UNITS, microLamports: price };
  }

  async check(size: bigint, reduceOnly: boolean): Promise<void> {
    const snap = await this.snapshot();
    if (snap.state === 'uninitialized') throw new LegCheckError(`phoenix ${this.symbol}: the desk's trader is not registered on Phoenix (state uninitialized)`);
    await this.plan('BUY', size, reduceOnly);
    await this.plan('SELL', size, reduceOnly);
  }

  async maxSize(side: LegSide): Promise<bigint> {
    const plan = await this.plan(side, this.lot, true);
    const oracle = await this.#o.oraclePx();
    // In integers, as the contract counts: lots × lot × max(limit, oracle) ≤ the cap, never rounded up.
    const lotUsdE16 = this.lot * maxE8(plan.ticks * BigInt(this.#o.market.tickE8), oracle);
    let lots = usdE16(this.#o.maxNotionalUsd) / lotUsdE16;
    if (this.#o.maxSz !== undefined) {
      const bySz = toQty(this.#o.maxSz) / this.lot;
      if (bySz < lots) lots = bySz;
    }
    return lots * this.lot;
  }

  async position(): Promise<bigint> {
    return (await this.snapshot()).lots * this.lot;
  }

  /** The trader snapshot at or past the slot of this leg's last landed transaction (waits up to settleTimeoutMs). */
  async snapshot(): Promise<TraderSnapshot> {
    const until = this.#clock.now() + (this.#o.settleTimeoutMs ?? 20_000);
    for (;;) {
      const snap = parseTraderSnapshot(await this.#o.api.traderState(this.#o.desk.authority), this.symbol);
      if (snap.slot >= this.#minSlot) return snap;
      if (this.#clock.now() >= until) throw new Error(`phoenix ${this.symbol}: the trader snapshot is at slot ${snap.slot}, still before the last transaction's slot ${this.#minSlot}`);
      await this.#sleep(500);
    }
  }

  /** The IOC this leg would send now (throws LegCheckError when the venue or the policy would refuse it). */
  async plan(side: LegSide, size: bigint, reduceOnly: boolean): Promise<PhoenixIocPlan> {
    const name = `phoenix ${this.symbol}`;
    if (size <= 0n || !isWholeLots(size, this.lot)) throw new LegCheckError(`${name}: ${signedQtyString(size)} is not a positive multiple of the lot ${qtyString(this.lot)}`);
    const [best, oracle] = await Promise.all([this.#o.bestPx(side), this.#o.oraclePx()]);
    if (!(best > 0)) throw new LegCheckError(`${name}: no ${side === 'BUY' ? 'ask' : 'bid'} to price against`);
    const tick = this.#o.market.tickE8 / 1e8;
    const slip = (this.#o.slippageBps ?? 50) / 10_000;
    const buy = side === 'BUY';
    // Past the best price by the slippage, never inside it, then held inside the band.
    let ticks = buy ? Math.max(Math.floor((best * (1 + slip)) / tick), Math.ceil(best / tick - 1e-9)) : Math.min(Math.ceil((best * (1 - slip)) / tick), Math.floor(best / tick + 1e-9));
    if (oracle !== null) {
      const band = (this.#o.bandBps / 10_000) * BAND_USE;
      const edge = buy ? Math.floor((oracle * (1 + band)) / tick) : Math.ceil((oracle * (1 - band)) / tick);
      ticks = buy ? Math.min(ticks, edge) : Math.max(ticks, edge);
      const bestTicks = buy ? Math.ceil(best / tick - 1e-9) : Math.floor(best / tick + 1e-9);
      if (buy ? ticks < bestTicks : ticks > bestTicks) {
        throw new LegCheckError(`${name}: the best ${buy ? 'ask' : 'bid'} ${best} is outside ${(band * 100).toFixed(2)} % of the contract's price ${oracle}: nothing to match inside the band`);
      }
      // The contract checks |limit - oracle| both ways: a buy limit far under the price (or a sell far over) is
      // refused too, so it is checked here before anything is signed.
      const far = buy ? Math.ceil((oracle * (1 - band)) / tick) : Math.floor((oracle * (1 + band)) / tick);
      if (buy ? ticks < far : ticks > far) {
        throw new LegCheckError(`${name}: the ${buy ? 'buy' : 'sell'} limit ${ticks * tick} is ${buy ? 'under' : 'over'} ${(band * 100).toFixed(2)} % of the contract's price ${oracle}`);
      }
    }
    if (ticks < 1) throw new LegCheckError(`${name}: a limit under one tick`);
    const px = ticks * tick;
    const capE8 = maxE8(BigInt(ticks) * BigInt(this.#o.market.tickE8), oracle);
    if (size * capE8 > usdE16(this.#o.maxNotionalUsd)) {
      throw new LegCheckError(`${name}: ${qtyString(size)} at ${Number(capE8) / 1e8} is ${(qtyNumber(size) * Number(capE8) / 1e8).toFixed(2)} USD, over the policy's ${this.#o.maxNotionalUsd} USD`);
    }
    if (this.#o.maxSz !== undefined && size > toQty(this.#o.maxSz)) throw new LegCheckError(`${name}: ${qtyString(size)} is over the unpriced symbol's max_sz ${this.#o.maxSz}`);
    return { side, lots: size / this.lot, ticks: BigInt(ticks), px, reduceOnly };
  }

  async order(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome> {
    const ref: LegRef = { venue: this.venue, side, size: qtyString(size), reduceOnly, orderId: null, clientId: null, tx: [], sentAt: this.#clock.now() };
    let plan: PhoenixIocPlan;
    let before: bigint;
    try {
      plan = await this.plan(side, size, reduceOnly);
      before = await this.position();
    } catch (err) {
      return { kind: 'failed', error: err instanceof LegCheckError ? err : new LegCheckError(errorText(err)), ref };
    }
    let built: { lastValidBlockHeight: number } | null = null;
    const build: SolanaMessageBuilder = async () => {
      const m = await this.message(plan);
      built = { lastValidBlockHeight: m.lastValidBlockHeight };
      return { messageB64: Buffer.from(m.message).toString('base64'), lastValidBlockHeight: m.lastValidBlockHeight };
    };
    ref.sentAt = this.#clock.now();
    let tx: TxRef[];
    try {
      tx = await this.#o.relayer.solSign(build, reason);
    } catch (err) {
      if (err instanceof NothingExecuted || err instanceof OutcomeUnknown) ref.tx = err.tx;
      if (err instanceof OutcomeUnknown) ref.orderId = err.ids.solSignature ?? null;
      if (provesNothingRan(err)) return { kind: 'failed', error: err as Error, ref };
      // The relayer hands on an MPC timeout only once the last message's blockhash is proven expired (and signs a
      // second one only after the first one's was): no signature of either can land any more.
      // A timeout is no proof: a late signature can still be posted while the blockhash lives, so the leg waits
      // until the chain is past it, as for any order with no answer.
      if (err instanceof MpcTimeoutError) {
        // No message was ever built: nothing was handed to MPC to sign, so nothing can land.
        const signed = built as { lastValidBlockHeight: number } | null;
        if (signed === null) return { kind: 'failed', error: err, ref };
        return { kind: 'unknown', error: err, ref, expiresAt: await this.#expiry(signed.lastValidBlockHeight) };
      }
      const height = err instanceof OutcomeUnknown ? err.ids.solLastValidBlockHeight ?? (built as { lastValidBlockHeight: number } | null)?.lastValidBlockHeight : undefined;
      return { kind: 'unknown', error: err instanceof Error ? err : new Error(String(err)), ref, expiresAt: await this.#expiry(height) };
    }
    ref.tx = tx;
    const signature = tx.find((t) => t.chain === 'solana')?.id ?? null;
    ref.orderId = signature;
    // Landed: the fill is what the position moved by, read from a snapshot that includes the transaction's slot.
    let slot = signature === null ? null : await this.#landedSlot(signature);
    // The transaction is confirmed, so the chain's confirmed slot now is at or past the one it landed in.
    // A bound from getSlot may come from a node behind the one that confirmed it: only a move proves anything then.
    let bounded = false;
    if (slot === null && signature !== null && this.#o.chain.currentSlot !== undefined) {
      try {
        slot = await this.#o.chain.currentSlot();
        bounded = true;
      } catch {
        // no lower bound either: unknown below
      }
    }
    if (slot === null) {
      return {
        kind: 'unknown', ref, expiresAt: null,
        error: new Error(`phoenix ${this.symbol}: the IOC ${signature ?? '(no signature)'} landed, but the slot it landed in is unknown: no snapshot can be proven to show it`),
      };
    }
    this.#minSlot = Math.max(this.#minSlot, slot);
    try {
      const after = await this.position();
      const moved = after - before;
      if (moved === 0n && bounded) {
        return {
          kind: 'unknown', ref, expiresAt: null,
          error: new Error(`phoenix ${this.symbol}: the IOC ${signature} landed, its slot is unknown, and no move shows under the chain's slot ${slot} (a node that may lag): not proven unfilled`),
        };
      }
      if (moved === 0n) return { kind: 'failed', error: new NothingExecuted('phoenix', `the IOC ${signature} landed at slot ${slot} but did not fill`, tx), ref };
      if ((side === 'BUY') !== (moved > 0n)) {
        return { kind: 'unknown', error: new Error(`phoenix ${this.symbol}: the position moved ${signedQtyString(moved)} against a ${side} (something else traded it)`), ref, expiresAt: this.#clock.now() };
      }
      const filled = moved > 0n ? moved : -moved;
      const fills = await this.#fills(signature!);
      return { kind: 'filled', filled, avgPx: fills?.avgPx ?? null, fee: fills?.feeUsd ?? null, ref };
    } catch (err) {
      // The transaction is final; only its effect is unread. The pair reads the position again (past the slot).
      return { kind: 'unknown', error: new Error(`phoenix ${this.symbol}: the IOC ${signature} landed, but the position could not be read after it: ${errorText(err)}`), ref, expiresAt: this.#clock.now() };
    }
  }

  /** The unsigned IOC message of `plan` on a fresh blockhash: what order() signs, and what a dry run simulates. */
  async message(plan: PhoenixIocPlan): Promise<{ message: Uint8Array; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await this.#o.chain.latestBlockhash();
    const order = { side: plan.side, priceInTicks: plan.ticks, numBaseLots: plan.lots, reduceOnly: plan.reduceOnly };
    return { message: orderMessage(this.#exchange, this.#o.desk, this.#o.market, order, blockhash, this.#budget), lastValidBlockHeight };
  }

  /** The slot a landed transaction is in: the submitter's confirmed status, else the RPC, polled for slotWaitMs. */
  async #landedSlot(signature: string): Promise<number | null> {
    const known = this.#o.landedSlot?.(signature) ?? null;
    if (known !== null) return known;
    const until = this.#clock.now() + (this.#o.slotWaitMs ?? 15_000);
    for (;;) {
      try {
        const slot = await this.#o.chain.signatureSlot(signature);
        if (slot !== null) return slot;
      } catch {
        // an RPC read that failed: tried again
      }
      if (this.#clock.now() >= until) return null;
      await this.#sleep(1_000);
    }
  }

  /** cancel_all on the leg's market: every resting order of the desk's trader there. */
  async cancelAll(reason: string): Promise<TxRef[]> {
    const build: SolanaMessageBuilder = async () => {
      const { blockhash, lastValidBlockHeight } = await this.#o.chain.latestBlockhash();
      return { messageB64: Buffer.from(cancelAllMessage(this.#exchange, this.#o.desk, this.#o.market, blockhash, this.#budget)).toString('base64'), lastValidBlockHeight };
    };
    return this.#o.relayer.solSign(build, reason);
  }

  /**
   * When no copy of an order with no answer can land: once the chain is proven past its lastValidBlockHeight. The
   * slot that height was read at becomes the oldest snapshot the leg trusts: one before it may miss a late landing.
   */
  async #expiry(height: number | undefined): Promise<number | null> {
    if (height === undefined) return null;
    const slot = await this.#o.waitPastLastValidHeight(height);
    if (slot === null) return null;
    this.#minSlot = Math.max(this.#minSlot, slot);
    return this.#clock.now();
  }

  /** The transaction's fills from trades-history; the API indexes a few seconds behind the chain. */
  async #fills(signature: string): Promise<{ avgPx: number; feeUsd: number } | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const found = fillsOf(await this.#o.api.tradesHistory(this.#o.desk.authority, 20), signature, this.symbol);
        if (found !== null) return found;
      } catch {
        // an index read that failed: the fill stands without its price and fee
      }
      await this.#sleep(1_500);
    }
    return null;
  }
}

/**
 * The Phoenix trader API over fetch (GET only). Every request goes through `budget`: by default the one every Phoenix
 * reader of this API host in the process shares (venues/http-budget.ts), so in serve it counts against the same host
 * limit as the scanner's reads. Called outside the scanner its reads are critical: ahead of the scanner's, never
 * skipped for them, retried after a 429 once Retry-After (capped) has passed. null: no budget.
 */
export function phoenixTraderApi(
  apiUrl: string, fetchImpl: typeof fetch = fetch, traderPdaIndex = 0, budget: HostBudget | null = hostBudget(apiUrl, PHOENIX_BUDGET),
): PhoenixTraderApi {
  const base = apiUrl.replace(/\/+$/, '');
  const get = async (path: string): Promise<unknown> => {
    const send = () => fetchImpl(`${base}${path}`, {
      method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(requestTimeoutMs(10_000)),
    });
    const res = budget === null ? await send() : await budget.run(readClass('account'), send);
    const body = await res.json().catch(() => null) as unknown;
    if (!res.ok) throw new Error(`phoenix GET ${path}: HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 160)}`);
    return body;
  };
  return {
    traderState: (authority) => get(`/v1/trader/state/${encodeURIComponent(authority)}?traderPdaIndex=${traderPdaIndex}`),
    tradesHistory: async (authority, limit) => {
      try {
        return await get(`/v1/trader/${encodeURIComponent(authority)}/trades-history?limit=${limit}&pdaIndex=${traderPdaIndex}`);
      } catch (err) {
        // A trader with no fills yet is {"error":"User not found"}: no rows.
        if (/User not found/.test(errorText(err))) return { data: [] };
        throw err;
      }
    },
  };
}

/** max(limit, oracle) in USD × 1e8: the price the contract values an order's notional at. */
function maxE8(limitE8: bigint, oracle: number | null): bigint {
  if (oracle === null) return limitE8;
  const o = BigInt(Math.round(oracle * 1e8));
  return o > limitE8 ? o : limitE8;
}

/** A USD amount in the units of size (1e-8) × price (1e-8): 1e-16 USD. */
function usdE16(usd: number): bigint {
  return BigInt(Math.round(usd * 1e8)) * 100_000_000n;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
