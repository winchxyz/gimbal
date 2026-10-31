// Hyperliquid order numbers the contract accepts: prices with at most 5 significant figures (integers excepted) and
// 6 - szDecimals decimals, sizes with szDecimals decimals, both canonical decimal strings; and an IOC limit that
// crosses the book while staying inside the contract's band around its oracle price. Every order carries a cloid, so
// an order whose outcome is unknown can be looked up (orderStatus by cloid) before anything else is sent.

import { randomBytes } from 'node:crypto';
import type { HlOrder } from '../contract/types.ts';

/** A fresh Hyperliquid client order id: 0x and 16 random bytes. */
export function newCloid(): string {
  return `0x${randomBytes(16).toString('hex')}`;
}

/** Hyperliquid's minimum order value, USD. */
export const HL_MIN_ORDER_USD = 10;

/** `n / 10^decimals` as a canonical decimal: no exponent, no trailing zeros after the dot. */
function canonical(n: bigint, decimals: number): string {
  if (decimals === 0) return n.toString();
  const s = n.toString().padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  const int = s.slice(0, -decimals);
  return frac === '' ? int : `${int}.${frac}`;
}

function roundTo(value: number, decimals: number, round: 'up' | 'down'): string {
  if (!(value > 0) || !Number.isFinite(value)) throw new Error(`hyperliquid: cannot format ${value}`);
  const scaled = value * 10 ** decimals;
  const n = round === 'up' ? Math.ceil(scaled - 1e-6) : Math.floor(scaled + 1e-6);
  return canonical(BigInt(n), decimals);
}

/** A perp price Hyperliquid and the contract accept, rounded up or down. */
export function hlPx(value: number, szDecimals: number, round: 'up' | 'down'): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const magnitude = Math.floor(Math.log10(value));          // 2 for 250.5, -2 for 0.0123
  const decimals = Math.min(maxDecimals, Math.max(0, 4 - magnitude));
  return roundTo(value, decimals, round);
}

/** A size in whole lots of 10^-szDecimals. */
export function hlSz(value: number, szDecimals: number, round: 'up' | 'down'): string {
  return roundTo(value, szDecimals, round);
}

export interface IocInput {
  asset: number;
  szDecimals: number;
  side: 'buy' | 'sell';
  /** The contract's stored price for the asset, USD; null for an unpriced asset (no band, the size cap instead). */
  oraclePx: number | null;
  /** policy.price_band_bps. */
  bandBps: number;
  /** An unpriced asset's max_sz from the policy. */
  maxSz?: string;
  /** The best ask for a buy, the best bid for a sell. */
  bookPx: number;
  /** The order value to aim for; default 11 USD (Hyperliquid's minimum is 10). */
  notionalUsd?: number;
  /** policy.max_notional_usd. */
  maxNotionalUsd: number;
  /** How far past the best price the limit may go; default 50 bps. */
  slippageBps?: number;
  /** A size to trade instead of notionalUsd (closing a position). */
  sz?: string;
  reduceOnly?: boolean;
  /** Default: newCloid(). */
  cloid?: string;
}

export interface IocPlan {
  order: HlOrder;
  px: number;
  sz: number;
  notionalUsd: number;
}

/** The price the contract values an order's size cap at: max(limit, oracle), the limit alone for an unpriced asset. */
export function capPrice(limitPx: number, oraclePx: number | null): number {
  return oraclePx === null ? limitPx : Math.max(limitPx, oraclePx);
}

/**
 * An IOC that should fill now: the limit is the best price plus slippage, held to 95 % of the band around the oracle
 * so the contract's E_PRICE_BAND check passes. Throws when the book is already outside the band (it could not fill).
 */
export function planIoc(input: IocInput): IocPlan {
  const slip = (input.slippageBps ?? 50) / 10_000;
  const band = (input.bandBps * 0.95) / 10_000;
  const buy = input.side === 'buy';
  const want = buy ? input.bookPx * (1 + slip) : input.bookPx * (1 - slip);
  const oracle = input.oraclePx;
  const edge = oracle === null ? want : buy ? oracle * (1 + band) : oracle * (1 - band);
  const limit = buy ? Math.min(want, edge) : Math.max(want, edge);
  const px = hlPx(limit, input.szDecimals, buy ? 'down' : 'up');
  const pxN = Number(px);
  if (buy ? pxN < input.bookPx : pxN > input.bookPx) {
    throw new Error(`the best ${buy ? 'ask' : 'bid'} ${input.bookPx} is outside the contract's band of ${input.bandBps} bps around its oracle price ${input.oraclePx}: an IOC inside the band would not fill`);
  }
  const sz = input.sz ?? hlSz((input.notionalUsd ?? HL_MIN_ORDER_USD + 1) / pxN, input.szDecimals, 'up');
  // The contract values the size cap at the higher of the limit and its oracle price; the venue minimum at the limit.
  const capPx = capPrice(pxN, oracle);
  const notionalUsd = Number(sz) * pxN;
  const cappedUsd = Number(sz) * capPx;
  if (input.maxSz !== undefined && Number(sz) > Number(input.maxSz)) throw new Error(`${sz} is over the unpriced asset's max_sz ${input.maxSz}`);
  if (cappedUsd > input.maxNotionalUsd) throw new Error(`${sz} at ${capPx} is ${cappedUsd.toFixed(2)} USD, over policy.max_notional_usd ${input.maxNotionalUsd}`);
  if (!input.reduceOnly && notionalUsd < HL_MIN_ORDER_USD) throw new Error(`${sz} at ${px} is ${notionalUsd.toFixed(2)} USD, under Hyperliquid's ${HL_MIN_ORDER_USD} USD minimum`);
  return {
    order: { asset: input.asset, is_buy: buy, px, sz, reduce_only: input.reduceOnly ?? false, tif: 'Ioc', cloid: input.cloid ?? newCloid() },
    px: pxN, sz: Number(sz), notionalUsd,
  };
}
