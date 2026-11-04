// pair-mainnet refuse-band / refuse-notional: one real Hyperliquid order for the desk that the contract must refuse,
// sent to hl_order so the failed transaction is on chain (nearblocks) with the contract's own error.
//
//   refuse-band <SYMBOL>      a post-only buy at the stored price plus twice price_band_bps, sized under the notional
//                             cap: the band is the only check it fails (E_PRICE_BAND)
//   refuse-notional <SYMBOL>  a post-only buy inside the band (at 0.9 of it above the stored price), sized at twice
//                             max_notional_usd: the cap is the only check it fails (E_SIZE)
//
// Every other check hl_order runs before these passes by construction: the desk runs (not paused, not closing), the
// asset is in policy.hl_assets and not in policy.unpriced, tif Alo with a fresh cloid, canonical px and sz in
// Hyperliquid's decimals, a nonzero size, and a stored price fresh for at least PRICE_STALE_MARGIN_S more seconds
// (--send refreshes it first, through ensureFresh, when it is not).
//
// Safety, whatever the contract answers:
// - nothing here can reach a venue: the only contract call is NearContractClient.hlOrder, which returns the signed
//   action to its caller and posts nothing; this module has no relayer or venue submitter. A signature the contract
//   returns unexpectedly is printed with a loud warning and dropped (exit code 4).
// - should a signature ever exist, it is harmless where it is public (the NEAR transaction): the order is a post-only
//   buy priced above Hyperliquid's best ask, which Hyperliquid refuses as crossing, and the contract signs every order
//   with expiresAfter = block time + 60 s. --send checks the ask before the call and refuses when the price is not
//   above it.
// - one NEAR call at a time, no trader lock, no venue order: safe while serve trades the desk with the same operator
//   key. A nonce clash on that shared key (InvalidNonce) is retried with a fresh nonce by the transport.

import type { TxRef } from '@gimbal/shared';
import type { NearContractClient } from '../contract/near-client.ts';
import { nearTxRef } from '../contract/near-client.ts';
import type { DeskView, HlOrder } from '../contract/types.ts';
import { ContractRefusal, OutcomeUnknown } from '../contract/types.ts';
import { HL_MIN_ORDER_USD, hlPx, hlSz, newCloid } from '../relayer/hl-order.ts';
import { qtyString, toQty } from '../trade/lots.ts';
import type { PriceDeps } from './pair-mainnet-lib.ts';
import { PRICE_STALE_MARGIN_S, ensureFresh } from './pair-mainnet-lib.ts';

export type RefusalKind = 'band' | 'notional';

export const REFUSE_COMMANDS: Record<string, RefusalKind> = { 'refuse-band': 'band', 'refuse-notional': 'notional' };

/** The refusal each kind expects: its E_* code and the words of the contract's message (contract/core/src/limits.rs). */
export const EXPECTED: Record<RefusalKind, { code: string; words: RegExp }> = {
  band: { code: 'E_PRICE_BAND', words: /outside price_band_bps/ },
  notional: { code: 'E_SIZE', words: /is over max_notional_usd/ },
};

/** Exit codes: refused as expected, refused for another reason, no proven outcome, signed (must never happen). */
export const EXIT_REFUSED = 0;
export const EXIT_OTHER_REFUSAL = 1;
export const EXIT_UNKNOWN = 3;
export const EXIT_SIGNED = 4;

/** The cost line: hl_order goes out at 300 TGas; a refusal burns only the gas used up to it. */
export const COST_LINE = 'cost      one hl_order at 300 TGas that fails: it burns only the gas used up to the refusal, a few TGas, about 0.001 NEAR or less '
  + '(at most 0.03 NEAR, all 300 TGas at 0.0001 NEAR per TGas); about 0.3 NEAR of the key\'s allowance is held while it runs and comes back. '
  + 'A refresh_prices first, only when the stored price is stale: at most about 0.03 NEAR of gas, plus the oracle fee from the contract\'s balance';

const E8 = 100_000_000n;

/** The contract's band check (limits.rs check_band): |px - oracle| x 10 000 <= band_bps x oracle, edges inside. */
export function insideBand(pxE8: bigint, oracleE8: bigint, bandBps: number): boolean {
  const diff = pxE8 > oracleE8 ? pxE8 - oracleE8 : oracleE8 - pxE8;
  return diff * 10_000n <= BigInt(bandBps) * oracleE8;
}

/** The contract's notional (limits.rs check_notional): sz x max(px, oracle), in 1e-16 USD. */
export function notionalE16(pxE8: bigint, szE8: bigint, oracleE8: bigint): bigint {
  return (pxE8 > oracleE8 ? pxE8 : oracleE8) * szE8;
}

export interface RefusalOrderInput {
  kind: RefusalKind;
  asset: { index: number; symbol: string; sz_decimals: number };
  oraclePx: number;
  bandBps: number;
  maxNotionalUsd: number;
}

export interface RefusalOrder {
  order: HlOrder;
  oracleE8: bigint;
  pxE8: bigint;
  szE8: bigint;
  /** sz x max(px, oracle), USD: what the contract values it at. */
  notionalUsd: number;
  /** |px - oracle| / oracle, in bps. */
  distanceBps: number;
  /** Why the contract refuses it, in one line. */
  why: string;
}

/**
 * The order of `kind`, checked here against the same arithmetic the contract runs: for `band` outside the band and
 * within the cap, for `notional` inside the band and over the cap. Throws when the policy leaves no such order.
 */
export function refusalOrder(i: RefusalOrderInput, cloid: string = newCloid()): RefusalOrder {
  const { sz_decimals: szDecimals } = i.asset;
  if (!(i.oraclePx > 0)) throw new Error(`no stored ${i.asset.symbol} price to price the order against`);
  if (!(i.bandBps > 0)) throw new Error(`price_band_bps is ${i.bandBps}: no band to test`);
  const oracleE8 = toQty(i.oraclePx);
  const capE16 = BigInt(Math.floor(i.maxNotionalUsd)) * E8 * E8;
  let px: string;
  let sz: string;
  if (i.kind === 'band') {
    px = hlPx(i.oraclePx * (1 + (2 * i.bandBps) / 10_000), szDecimals, 'up');
    const pxN = Number(px);
    // A real-looking order (over Hyperliquid's 10 USD minimum) with room under the cap for the rounding to a lot.
    const targetUsd = Math.min(HL_MIN_ORDER_USD + 1, 0.9 * i.maxNotionalUsd);
    sz = hlSz(targetUsd / pxN, szDecimals, 'up');
    if (notionalE16(toQty(px), toQty(sz), oracleE8) > capE16) sz = hlSz(targetUsd / pxN, szDecimals, 'down');
  } else {
    px = hlPx(i.oraclePx * (1 + (0.9 * i.bandBps) / 10_000), szDecimals, 'down');
    sz = hlSz((2 * i.maxNotionalUsd) / Number(px), szDecimals, 'up');
  }
  const pxE8 = toQty(px);
  const szE8 = toQty(sz);
  if (szE8 === 0n) throw new Error(`one lot of ${i.asset.symbol} at ${px} is over max_notional_usd ${i.maxNotionalUsd}: no order fits under the cap`);
  const notional = notionalE16(pxE8, szE8, oracleE8);
  const inside = insideBand(pxE8, oracleE8, i.bandBps);
  const distanceBps = (Number(pxE8 - oracleE8) / Number(oracleE8)) * 10_000;
  const notionalUsd = Number(notional / E8) / 1e8;
  const oracle = qtyString(oracleE8);
  let why: string;
  if (i.kind === 'band') {
    if (inside) throw new Error(`px ${px} is inside price_band_bps ${i.bandBps} of ${oracle}: the band would not refuse it`);
    if (notional > capE16) throw new Error(`${sz} x ${px} is over max_notional_usd ${i.maxNotionalUsd}: the band would not be the only refusal`);
    why = `px ${px} is ${distanceBps.toFixed(1)} bps above ${oracle}, outside price_band_bps ${i.bandBps}; its notional ${notionalUsd.toFixed(2)} USD is within max_notional_usd ${i.maxNotionalUsd}`;
  } else {
    if (!inside) throw new Error(`px ${px} is outside price_band_bps ${i.bandBps} of ${oracle}: the band, not the cap, would refuse it`);
    if (notional <= capE16) throw new Error(`${sz} x ${px} is within max_notional_usd ${i.maxNotionalUsd}: the cap would not refuse it`);
    why = `px ${px} is ${distanceBps.toFixed(1)} bps above ${oracle}, inside price_band_bps ${i.bandBps}; ${sz} x ${px} = ${notionalUsd.toFixed(2)} USD is over max_notional_usd ${i.maxNotionalUsd}`;
  }
  return {
    order: { asset: i.asset.index, is_buy: true, px, sz, reduce_only: false, tif: 'Alo', cloid },
    oracleE8, pxE8, szE8, notionalUsd, distanceBps, why,
  };
}

/** What the command reads and calls. No relayer and no venue submitter, by design: nothing here can post an order. */
export interface RefuseDeps {
  kind: RefusalKind;
  symbol: string;
  send: boolean;
  deskId: string;
  desk: Pick<DeskView, 'paused' | 'closing' | 'policy'>;
  /** hlOrder is called only with --send, once. */
  client: Pick<NearContractClient, 'hlOrder'>;
  /** The stored price reads and refresh (pair-mainnet's ensureFresh deps); `send` there must equal `send` here. */
  prices: PriceDeps;
  /** Hyperliquid's best ask for `symbol` now. */
  bestAsk(symbol: string): Promise<number>;
  say(line?: string): void;
  cloid?: string;
}

/** Why a desk or symbol cannot show this refusal (another check would refuse first), or null. */
export function deskRefusal(d: Pick<RefuseDeps, 'desk' | 'symbol'>): string | null {
  const p = d.desk.policy;
  if (d.desk.paused) return 'the desk is paused: hl_order would refuse E_PAUSED before the band or the cap';
  if (d.desk.closing === true) return 'the desk is closing (panic_close pauses it): hl_order would refuse E_PAUSED before the band or the cap';
  if (!p.hl_assets.some((a) => a.symbol === d.symbol)) return `${d.symbol} is not in policy.hl_assets (${p.hl_assets.map((a) => a.symbol).join(', ')}): hl_order would refuse E_ASSET`;
  if (p.unpriced.some((u) => u.symbol === d.symbol)) return `${d.symbol} is in policy.unpriced: it has no price band`;
  return null;
}

/**
 * The dry run (prints the order, the stored price and its age, the band and why the contract refuses it; signs
 * nothing) or --send (refreshes a stale price, sends hl_order once, reports the refusal and its link). Returns the exit
 * code.
 */
export async function refuse(d: RefuseDeps): Promise<number> {
  const p = d.desk.policy;
  const expected = EXPECTED[d.kind];
  if (d.prices.send !== d.send) throw new Error('refuse: the price deps and the command disagree on --send');
  const blocked = deskRefusal(d);
  if (blocked !== null) throw new Error(`refuse-${d.kind} ${d.symbol}: ${blocked}`);
  const asset = p.hl_assets.find((a) => a.symbol === d.symbol)!;
  d.say(`policy    price_band_bps ${p.price_band_bps}, max_notional_usd ${p.max_notional_usd}, oracle_max_age_s ${p.oracle_max_age_s}`);

  // The stored price must stay fresh until the call runs; --send refreshes it through the same path as open and close.
  const limit = p.oracle_max_age_s - PRICE_STALE_MARGIN_S;
  let stored = await d.prices.read(d.symbol);
  if (d.send) {
    stored = await ensureFresh(d.prices, d.symbol, PRICE_STALE_MARGIN_S);
  } else if (stored !== null && stored.ageS > limit) {
    d.say(`price     ${d.symbol}: ${stored.px} USD, ${Math.round(stored.ageS)} s old: stale for this (over ${limit} s); --send runs refresh_prices first and prices the order against the new one`);
  }
  // If a signature ever existed it would be public: priced above the ask, Hyperliquid refuses the post-only buy.
  const ask = await d.bestAsk(d.symbol);
  let reference: number;
  if (stored !== null) {
    d.say(`price     ${d.symbol}: ${stored.px} USD stored, ${Math.round(stored.ageS)} s old (fresh up to ${p.oracle_max_age_s} s)`);
    reference = stored.px;
  } else {
    // Only a dry run gets here (ensureFresh throws when --send finds no price after the refresh).
    d.say(`price     ${d.symbol}: none stored; the order below is priced against Hyperliquid's ask ${ask} as a stand-in; --send runs refresh_prices first and prices it against the price stored then`);
    reference = ask;
  }

  const r = refusalOrder({ kind: d.kind, asset, oraclePx: reference, bandBps: p.price_band_bps, maxNotionalUsd: p.max_notional_usd }, d.cloid);
  d.say(`order     hyperliquid ${d.symbol} (asset ${asset.index}) BUY ${r.order.sz} at ${r.order.px}, post-only (Alo), not reduce-only, cloid ${r.order.cloid}`);
  d.say(`          hl_order ${JSON.stringify({ desk_id: d.deskId, order: r.order })}`);
  d.say(`refusal   expected ${expected.code}: ${r.why}`);
  const crosses = Number(r.order.px) > ask;
  d.say(`book      best ask ${ask}: ${crosses ? `px ${r.order.px} is above it, so Hyperliquid would refuse this post-only buy as crossing even if it were ever signed` : `px ${r.order.px} is NOT above it: signed, this post-only buy could rest on the book`}`);
  d.say(COST_LINE);
  if (!d.send) {
    if (!crosses) d.say('would refuse at --send: the price is not above the best ask; run again when the stored price is fresh');
    d.say('\ndry run: nothing was signed or sent. Add --send, from the main checkout, to send it to hl_order and see the contract refuse it.');
    return crosses ? EXIT_REFUSED : EXIT_OTHER_REFUSAL;
  }
  if (!crosses) throw new Error(`refuse-${d.kind} --send refused, nothing sent: px ${r.order.px} is not above the best ask ${ask}`);

  const reason = `refusal demo: expect ${expected.code} (${d.kind === 'band' ? 'a buy outside the price band' : 'a buy over the notional cap'})`;
  d.say(`send      hl_order(${d.deskId}) once: ${reason}`);
  try {
    const signed = await d.client.hlOrder(d.deskId, r.order, reason);
    const tx: TxRef[] = signed.nearTx === undefined ? [] : [signed.nearTx];
    for (const line of signedWarning(r.order, tx)) d.say(line);
    return EXIT_SIGNED;
  } catch (err) {
    if (err instanceof ContractRefusal) {
      const link = err.txHash === null ? 'no transaction hash' : nearTxRef('mainnet', err.txHash).url;
      const asExpected = err.code === expected.code && expected.words.test(err.message);
      d.say(`refused   ${asExpected ? 'as expected' : `NOT as expected (wanted ${expected.code})`}: nothing was signed`);
      d.say(`          ${link}`);
      d.say(`error     ${err.message}`);
      return asExpected ? EXIT_REFUSED : EXIT_OTHER_REFUSAL;
    }
    if (err instanceof OutcomeUnknown) {
      d.say(`unknown   hl_order has no proven outcome: ${err.message}`);
      for (const t of err.tx) d.say(`          ${t.url}`);
      d.say('          nothing was forwarded to any venue; read the transaction on nearblocks');
      return EXIT_UNKNOWN;
    }
    throw err;
  }
}

/** The lines printed when the contract signs an order it should have refused. */
export function signedWarning(order: HlOrder, tx: TxRef[]): string[] {
  const bar = '!'.repeat(100);
  return [
    bar,
    'WARNING   THE CONTRACT SIGNED AN ORDER IT SHOULD HAVE REFUSED.',
    `          ${tx.length === 0 ? 'no transaction link' : tx.map((t) => t.url).join('  ')}`,
    '          The signature was NOT forwarded to Hyperliquid or any venue, and this command stops here.',
    `          It is public in that transaction: a post-only BUY ${order.sz} at ${order.px} (cloid ${order.cloid}), priced above the`,
    '          ask when sent, so Hyperliquid refuses it as crossing; it expires 60 s after the block (expiresAfter).',
    '          Check the desk policy (price_band_bps, max_notional_usd) and the contract version before anything else.',
    bar,
  ];
}
