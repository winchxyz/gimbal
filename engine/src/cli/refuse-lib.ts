// pair-mainnet refuse-band / refuse-notional: one real Hyperliquid order for the desk that the contract must refuse,
// sent to hl_order so the failed transaction is on chain (nearblocks) with the contract's own error. And cancel-hl, the
// way to cancel a Hyperliquid order by its oid or cloid should one of those ever be signed and posted.
//
//   refuse-band <SYMBOL>      a post-only buy at the stored price plus twice price_band_bps, sized under the notional
//                             cap: the band is the only check it fails (E_PRICE_BAND)
//   refuse-notional <SYMBOL>  a post-only buy inside the band (at 0.9 of it above the stored price), sized one lot over
//                             max_notional_usd: the cap is the only check it fails (E_SIZE)
//
// Every other check hl_order runs before these passes by construction: the desk runs (not paused, not closing), the
// asset is in policy.hl_assets and not in policy.unpriced, tif Alo with a fresh cloid, canonical px and sz in
// Hyperliquid's decimals, a nonzero size, and a stored price fresh for at least PRICE_STALE_MARGIN_S more seconds
// (--send refreshes it first, through ensureFresh, when it is not).
//
// Safety, whatever the contract answers:
// - nothing here can reach a venue: the only contract call is NearContractClient.hlOrder, which returns the signed
//   action to its caller and posts nothing; this module and refuse-cli.ts build no relayer and no venue submitter
//   (refuse-lib.test.ts checks their imports). A signature the contract returns anyway is printed with a loud warning
//   and dropped (exit code 4).
// - a signature, should one ever exist, is public in the NEAR transaction and anyone may post it. The contract signs
//   every order with expiresAfter = block time + 60 s, which bounds when Hyperliquid takes the action, not how long a
//   posted order lives. So the order is a post-only buy priced at least max(25 bps, half the band) above the best ask,
//   read twice (before planning, and again right before hl_order): posted inside those 60 s, Hyperliquid refuses it as
//   crossing unless the ask rose by that margin first. Were it to rest anyway, it rests until filled or cancelled:
//   exit 4 names its cloid and the cancel (cancel-hl).
// - one NEAR call at a time, no trader lock, no venue order: safe while serve trades the desk with the same operator
//   key. A nonce clash on that shared key (InvalidNonce) is retried with a fresh nonce by the transport. --send refuses
//   when the key's account or allowance has less than two call reserves, so serve's own budget never runs out.
//
// Exit codes: 0 refused as expected; 1 sent and refused for another reason (its gas is spent); 3 sent with no proven
// outcome; 4 signed (must never happen); 5 nothing sent (a precondition, a dry run that would not send, any error
// before hl_order went out). A usage error stays 2, as for every pair-mainnet command.

import type { TxRef } from '@gimbal/shared';
import { DEFAULT_CALL_TGAS, formatNear, reserveFor } from '../contract/budget.ts';
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

export const EXIT_REFUSED = 0;
export const EXIT_OTHER_REFUSAL = 1;
export const EXIT_UNKNOWN = 3;
export const EXIT_SIGNED = 4;
export const EXIT_NOT_SENT = 5;

/** The least the order's price must sit above the best ask, bps; half the band when that is more. */
export const MIN_ASK_MARGIN_BPS = 25;
/** --send needs room for this many 300 TGas reserves, so serve on the same key keeps at least one. */
export const RESERVES_NEEDED = 2;

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

/** How far above the ask a post-only buy must be priced: max(MIN_ASK_MARGIN_BPS, band / 2), bps. */
export function askMarginBps(bandBps: number): number {
  return Math.max(MIN_ASK_MARGIN_BPS, bandBps / 2);
}

/** Whether px is at least the margin above the ask (px >= ask x (1 + margin)). */
export function clearsAsk(px: number, ask: number, bandBps: number): boolean {
  return px >= ask * (1 + askMarginBps(bandBps) / 10_000);
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
  /** (px - oracle) / oracle, in bps. */
  distanceBps: number;
  /** Why the contract refuses it, in one line. */
  why: string;
}

/**
 * The order of `kind`, checked here against the same arithmetic the contract runs: for `band` outside the band and
 * within the cap, for `notional` inside the band and just over the cap (the fewest whole lots that reach it, plus
 * one). Throws when the policy leaves no such order.
 */
export function refusalOrder(i: RefusalOrderInput, cloid: string = newCloid()): RefusalOrder {
  const { sz_decimals: szDecimals } = i.asset;
  if (!(i.oraclePx > 0)) throw new Error(`no stored ${i.asset.symbol} price to price the order against`);
  if (!(i.bandBps > 0)) throw new Error(`price_band_bps is ${i.bandBps}: no band to test`);
  const oracleE8 = toQty(i.oraclePx);
  const capE16 = BigInt(Math.floor(i.maxNotionalUsd)) * E8 * E8;
  const lotE8 = 10n ** BigInt(8 - szDecimals);
  let px: string;
  let szE8: bigint;
  if (i.kind === 'band') {
    px = hlPx(i.oraclePx * (1 + (2 * i.bandBps) / 10_000), szDecimals, 'up');
    const pxN = Number(px);
    // A real-looking order (over Hyperliquid's 10 USD minimum) with room under the cap for the rounding to a lot.
    const targetUsd = Math.min(HL_MIN_ORDER_USD + 1, 0.9 * i.maxNotionalUsd);
    szE8 = toQty(hlSz(targetUsd / pxN, szDecimals, 'up'));
    if (notionalE16(toQty(px), szE8, oracleE8) > capE16) szE8 = toQty(hlSz(targetUsd / pxN, szDecimals, 'down'));
  } else {
    px = hlPx(i.oraclePx * (1 + (0.9 * i.bandBps) / 10_000), szDecimals, 'down');
    szE8 = toQty(hlSz(i.maxNotionalUsd / Number(px), szDecimals, 'up')) + lotE8;
  }
  const pxE8 = toQty(px);
  const sz = qtyString(szE8);
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
  /** Hyperliquid's best ask for `symbol` now; read before planning and again right before hl_order. */
  bestAsk(symbol: string): Promise<number>;
  /** --send: what the signing key's account can spend and its allowance left (null: no limit), yocto. */
  room?(): Promise<{ spendable: bigint; allowance: bigint | null }>;
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

/** Why the key's room does not cover RESERVES_NEEDED call reserves, or null. */
export function roomRefusal(room: { spendable: bigint; allowance: bigint | null }): string | null {
  const need = BigInt(RESERVES_NEEDED) * reserveFor(DEFAULT_CALL_TGAS);
  const short: string[] = [];
  if (room.spendable < need) short.push(`spendable ${formatNear(room.spendable)}`);
  if (room.allowance !== null && room.allowance < need) short.push(`allowance ${formatNear(room.allowance)}`);
  return short.length === 0 ? null
    : `the signing key has ${short.join(' and ')}, under ${RESERVES_NEEDED} call reserves (${formatNear(need)}): serve shares it and would run out`;
}

class NotSent extends Error {}

/**
 * The dry run (prints the order, the stored price and its age, the band and why the contract refuses it; signs
 * nothing) or --send (refreshes a stale price, sends hl_order once, reports the refusal and its link). Returns the exit
 * code; anything that stops it before hl_order goes out is EXIT_NOT_SENT.
 */
export async function refuse(d: RefuseDeps): Promise<number> {
  let sent = false;
  try {
    return await run(d, () => {
      sent = true;
    });
  } catch (err) {
    if (sent) throw err;
    d.say(`not sent  ${err instanceof Error ? err.message : String(err)}: hl_order was not sent`);
    return EXIT_NOT_SENT;
  }
}

async function run(d: RefuseDeps, sending: () => void): Promise<number> {
  const p = d.desk.policy;
  const expected = EXPECTED[d.kind];
  if (d.prices.send !== d.send) throw new Error('refuse: the price deps and the command disagree on --send');
  const blocked = deskRefusal(d);
  if (blocked !== null) throw new NotSent(`refuse-${d.kind} ${d.symbol}: ${blocked}`);
  const asset = p.hl_assets.find((a) => a.symbol === d.symbol)!;
  d.say(`policy    price_band_bps ${p.price_band_bps}, max_notional_usd ${p.max_notional_usd}, oracle_max_age_s ${p.oracle_max_age_s}`);
  if (d.send) {
    if (d.room === undefined) throw new NotSent('--send needs the signing key\'s room');
    const room = await d.room();
    const short = roomRefusal(room);
    if (short !== null) throw new NotSent(short);
  } else {
    d.say(`room      --send needs ${formatNear(BigInt(RESERVES_NEEDED) * reserveFor(DEFAULT_CALL_TGAS))} spendable and allowance on the signing key (${RESERVES_NEEDED} call reserves, so serve keeps its own)`);
  }

  // The stored price must stay fresh until the call runs; --send refreshes it through the same path as open and close.
  const limit = p.oracle_max_age_s - PRICE_STALE_MARGIN_S;
  let stored = await d.prices.read(d.symbol);
  if (d.send) {
    stored = await ensureFresh(d.prices, d.symbol, PRICE_STALE_MARGIN_S);
  } else if (stored !== null && stored.ageS > limit) {
    d.say(`price     ${d.symbol}: ${stored.px} USD, ${Math.round(stored.ageS)} s old: stale for this (over ${limit} s); --send runs refresh_prices first and prices the order against the new one`);
  }
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
  const margin = askMarginBps(p.price_band_bps);
  const clears = clearsAsk(Number(r.order.px), ask, p.price_band_bps);
  d.say(`book      best ask ${ask}: px ${r.order.px} is ${clears ? '' : 'NOT '}at least ${margin} bps above it${clears ? ', so a post-only buy posted within its 60 s would be refused by Hyperliquid as crossing' : ''}`);
  d.say(COST_LINE);
  if (!d.send) {
    if (!clears) throw new NotSent(`the price is not ${margin} bps above the best ask; run again when the stored price is fresh (dry run)`);
    d.say('\ndry run: nothing was signed or sent. Add --send, from the main checkout, to send it to hl_order and see the contract refuse it.');
    return EXIT_REFUSED;
  }
  if (!clears) throw new NotSent(`px ${r.order.px} is not ${margin} bps above the best ask ${ask}`);
  // The ask again, right before the call: the refresh and the planning took time.
  const askNow = await d.bestAsk(d.symbol);
  if (!clearsAsk(Number(r.order.px), askNow, p.price_band_bps)) throw new NotSent(`the best ask moved to ${askNow}: px ${r.order.px} is no longer ${margin} bps above it`);

  const reason = `refusal demo: expect ${expected.code} (${d.kind === 'band' ? 'a buy outside the price band' : 'a buy over the notional cap'})`;
  d.say(`send      hl_order(${d.deskId}) once (best ask ${askNow}): ${reason}`);
  sending();
  try {
    const signed = await d.client.hlOrder(d.deskId, r.order, reason);
    const tx: TxRef[] = signed.nearTx === undefined ? [] : [signed.nearTx];
    for (const line of signedWarning(d.symbol, r.order, tx)) d.say(line);
    return EXIT_SIGNED;
  } catch (err) {
    if (err instanceof ContractRefusal) {
      const link = err.txHash === null ? 'no transaction hash' : nearTxRef('mainnet', err.txHash).url;
      const asExpected = err.code === expected.code && expected.words.test(err.message);
      d.say(`refused   ${asExpected ? 'as expected' : `NOT as expected (wanted ${expected.code}); its gas is spent`}: nothing was signed`);
      d.say(`          ${link}`);
      d.say(`error     ${err.message}`);
      return asExpected ? EXIT_REFUSED : EXIT_OTHER_REFUSAL;
    }
    if (err instanceof OutcomeUnknown) {
      d.say(`unknown   hl_order has no proven outcome: ${err.message}`);
      for (const t of err.tx) d.say(`          ${t.url}`);
      d.say(`          nothing was forwarded to any venue; read the transaction on nearblocks, and if it signed, check cloid ${r.order.cloid} with cancel-hl ${d.symbol} ${r.order.cloid}`);
      return EXIT_UNKNOWN;
    }
    // Not a refusal and not sent without an outcome: the transport or the budget stopped it before the chain.
    d.say(`not sent  hl_order failed before the chain: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_NOT_SENT;
  }
}

/** The lines printed when the contract signs an order it should have refused. Never the signature itself. */
export function signedWarning(symbol: string, order: HlOrder, tx: TxRef[]): string[] {
  const bar = '!'.repeat(100);
  return [
    bar,
    'WARNING   THE CONTRACT SIGNED AN ORDER IT SHOULD HAVE REFUSED.',
    `          ${tx.length === 0 ? 'no transaction link' : tx.map((t) => t.url).join('  ')}`,
    '          The signature was NOT forwarded to Hyperliquid or any venue, and this command stops here. It is public in',
    '          that transaction, though: anyone may post it while Hyperliquid takes it (expiresAfter, 60 s after the block).',
    `          It is a post-only BUY ${order.sz} ${symbol} at ${order.px} (cloid ${order.cloid}), priced above the ask by the margin,`,
    '          so posted in that window Hyperliquid refuses it as crossing; if the ask rose first, it would rest until filled',
    '          or cancelled. Check it now and cancel it if it rests:',
    `            pair-mainnet cancel-hl ${symbol} ${order.cloid}           (dry run: its status on Hyperliquid)`,
    `            stop serve; pair-mainnet cancel-hl ${symbol} ${order.cloid} --send; start serve   (hl_cancel by its oid)`,
    '          Then check the desk policy (price_band_bps, max_notional_usd) and the contract version before anything else.',
    bar,
  ];
}

// ---- cancel-hl ----

export interface HlOrderStatusView {
  status: string;
  oid: number;
  coin: string;
  side: string;
  sz: string;
  origSz: string;
  limitPx: string;
}

/** Hyperliquid's orderStatus answer, or null for unknownOid; anything else throws. */
export function parseHlOrderStatus(raw: unknown, id: string): HlOrderStatusView | null {
  const r = raw as { status?: unknown; order?: { status?: unknown; order?: Record<string, unknown> } } | null;
  if (r?.status === 'unknownOid') return null;
  const o = r?.order?.order;
  if (r?.status !== 'order' || typeof r.order?.status !== 'string' || o === undefined || !Number.isSafeInteger(Number(o.oid))) {
    throw new Error(`hyperliquid orderStatus ${id}: unexpected answer ${JSON.stringify(raw)?.slice(0, 160)}`);
  }
  return {
    status: r.order.status, oid: Number(o.oid), coin: String(o.coin), side: o.side === 'B' ? 'BUY' : o.side === 'A' ? 'SELL' : String(o.side),
    sz: String(o.sz), origSz: String(o.origSz), limitPx: String(o.limitPx),
  };
}

/** An order id as Hyperliquid takes it in orderStatus: a decimal oid, or a cloid (0x + 32 hex, lowercased). */
export function parseOrderId(text: string): number | string {
  if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
  if (/^0x[0-9a-fA-F]{32}$/.test(text)) return text.toLowerCase();
  throw new Error(`${text} is neither an oid (digits) nor a cloid (0x and 32 hex)`);
}

export interface CancelDeps {
  symbol: string;
  /** policy.hl_assets index of `symbol`. */
  asset: number;
  id: number | string;
  send: boolean;
  status(id: number | string): Promise<unknown>;
  /** hl_cancel through the relayer (signed by the contract, posted to Hyperliquid); --send only. */
  cancel(asset: number, oid: number, reason: string): Promise<unknown>;
  say(line?: string): void;
}

/** cancel-hl: the order's status; with --send, hl_cancel when it is open on `symbol`, and its status after. */
export async function cancelHl(d: CancelDeps): Promise<number> {
  const idText = String(d.id);
  const st = parseHlOrderStatus(await d.status(d.id), idText);
  if (st === null) {
    d.say(`order     ${idText}: Hyperliquid does not know it: nothing to cancel`);
    return 0;
  }
  d.say(`order     ${idText}: oid ${st.oid}, ${st.coin} ${st.side} ${st.sz} of ${st.origSz} at ${st.limitPx}: ${st.status}`);
  if (st.status !== 'open') {
    d.say('          not open: nothing to cancel');
    return 0;
  }
  if (st.coin !== d.symbol) throw new Error(`order ${idText} is on ${st.coin}, not ${d.symbol}`);
  if (!d.send) {
    d.say(`\ndry run: nothing was signed or sent. Add --send, from the main checkout with serve stopped, to cancel oid ${st.oid} (one hl_cancel, posted to Hyperliquid).`);
    return 0;
  }
  try {
    await d.cancel(d.asset, st.oid, `cancel-hl ${d.symbol} oid ${st.oid}`);
  } catch (err) {
    d.say(`cancel    hl_cancel ${st.oid}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const after = parseHlOrderStatus(await d.status(st.oid), String(st.oid));
  d.say(`after     oid ${st.oid}: ${after === null ? 'unknown to Hyperliquid' : `${after.status}, ${after.sz} of ${after.origSz} left`}`);
  return after?.status === 'open' ? 1 : 0;
}
