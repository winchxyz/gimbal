// The contract's order checks (gimbal-core hl.rs check_order, limits.rs check_value), ported for
// ReplayContractClient: the same order of checks and the same refusal codes, on the same 1e-8 integer arithmetic,
// so the demo and the tests refuse what the contract would refuse.

import type { ContractPolicy } from '@gimbal/shared';
import type { HlOrder } from './types.ts';
import { ContractRefusal } from './types.ts';
import { unpricedBySymbol, unpricedCapUsd } from './unpriced.ts';

const DECIMALS = 8;
const E8 = 10n ** 8n;
const NOTIONAL_UNIT = 10n ** 16n;          // 1 USD of notional in price (1e-8) × size (1e-8)
const PX_MAX_DECIMALS = 6;
const PX_MAX_SIG_FIGS = 5;
const USDC_DECIMALS = 6;
export const REASON_MAX_CHARS = 280;
const DESK_ID = /^[a-z0-9-]{1,32}$/;

/** A canonical decimal string in units of 1e-8 (decimal.rs parse_e8); E_DECIMAL otherwise. Zero is accepted. */
export function parseE8(field: string, s: string): bigint {
  const refuse = (why: string): never => {
    throw new ContractRefusal('E_DECIMAL', `${field} ${JSON.stringify(s)} ${why}`);
  };
  if (s === '') refuse('is empty');
  if (/^[+-]/.test(s)) refuse('has a sign');
  const [int, frac, ...rest] = s.split('.');
  if (rest.length > 0 || !/^[0-9]*$/.test(int!) || (frac !== undefined && !/^[0-9]*$/.test(frac))) {
    refuse('has a character other than ASCII digits and one dot');
  }
  if (int === '' || frac === '') refuse('has an empty integer or fraction part');
  if (int!.length > 1 && int!.startsWith('0')) refuse('has a leading zero');
  const f = frac ?? '';
  if (f.length > DECIMALS) refuse('has more than 8 decimals');
  if (f.endsWith('0')) refuse('has a trailing zero after the dot');
  return BigInt(int!) * E8 + BigInt(f.padEnd(DECIMALS, '0') || '0');
}

const decimalsOf = (s: string): number => (s.includes('.') ? s.split('.')[1]!.length : 0);
const significantFigures = (s: string): number => s.replace('.', '').replace(/^0+/, '').length;

export function formatE8(units: bigint): string {
  const whole = units / E8;
  const frac = (units % E8).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

export function checkDeskId(deskId: string): void {
  if (!DESK_ID.test(deskId)) throw new ContractRefusal('E_ARGS', `desk_id ${JSON.stringify(deskId)} is not [a-z0-9-]{1,32}`);
}

export function checkReason(reason: string): void {
  if ([...reason].length > REASON_MAX_CHARS) throw new ContractRefusal('E_ARGS', `reason has more than ${REASON_MAX_CHARS} characters`);
}

/** check_px: canonical, above zero, at most 6 − szDecimals decimals, and an integer or at most 5 significant figures. */
export function checkPx(px: string, szDecimals: number): bigint {
  const units = parseE8('px', px);
  if (units === 0n) throw new ContractRefusal('E_DECIMAL', `px ${px} is zero`);
  const decimals = decimalsOf(px);
  const max = Math.max(0, PX_MAX_DECIMALS - szDecimals);
  if (decimals > max) throw new ContractRefusal('E_DECIMAL', `px ${px} has ${decimals} decimals; with szDecimals ${szDecimals} Hyperliquid allows ${max}`);
  if (decimals > 0 && significantFigures(px) > PX_MAX_SIG_FIGS) {
    throw new ContractRefusal('E_DECIMAL', `px ${px} has more than ${PX_MAX_SIG_FIGS} significant figures`);
  }
  return units;
}

/** check_sz: canonical with at most szDecimals decimals, and not zero (E_SIZE). */
export function checkSz(sz: string, szDecimals: number): bigint {
  const units = parseE8('sz', sz);
  const decimals = decimalsOf(sz);
  if (decimals > szDecimals) throw new ContractRefusal('E_DECIMAL', `sz ${sz} has ${decimals} decimals; the asset's szDecimals is ${szDecimals}`);
  if (units === 0n) throw new ContractRefusal('E_SIZE', 'sz is zero');
  return units;
}

/** check_usdc_amount: canonical with at most 6 decimals, not zero. */
export function checkUsdcAmount(amount: string): bigint {
  const units = parseE8('amount', amount);
  if (decimalsOf(amount) > USDC_DECIMALS) throw new ContractRefusal('E_DECIMAL', `amount ${amount} has more than ${USDC_DECIMALS} decimals`);
  if (units === 0n) throw new ContractRefusal('E_SIZE', 'amount is zero');
  return units;
}

/** `|px − oracle| × 10 000 ≤ band_bps × oracle`, edges allowed. */
export function checkBand(pxE8: bigint, oracleE8: bigint, bandBps: number): void {
  const diff = pxE8 > oracleE8 ? pxE8 - oracleE8 : oracleE8 - pxE8;
  if (diff * 10_000n <= oracleE8 * BigInt(bandBps)) return;
  const pct = oracleE8 === 0n ? 'far' : `${(Number(diff * 1_000_000n / oracleE8) / 10_000).toFixed(4)}%`;
  throw new ContractRefusal('E_PRICE_BAND', `px ${formatE8(pxE8)} is ${pct} from oracle ${formatE8(oracleE8)}, outside price_band_bps ${bandBps}`);
}

function checkNotional(symbol: string, pxE8: bigint, oracleE8: bigint | null, szE8: bigint, cap: number, capName: string): void {
  const valuePx = oracleE8 !== null && oracleE8 > pxE8 ? oracleE8 : pxE8;
  const notional = valuePx * szE8;
  if (notional <= BigInt(cap) * NOTIONAL_UNIT) return;
  throw new ContractRefusal('E_SIZE', `${symbol} ${formatE8(valuePx)} x ${formatE8(szE8)} = ${formatE8(notional / E8)} USD is over ${capName} ${cap}`);
}

/**
 * limits.rs check_value: zero size; an unpriced symbol within its max_sz and the unpriced cap at its own price; any
 * other symbol a fresh reference price (E_ORACLE_STALE), the band (E_PRICE_BAND), sz × max(px, reference) within
 * max_notional_usd (E_SIZE). Returns the oracle price it was checked against, null for an unpriced symbol.
 * `symbol` is the policy symbol the venue's check resolved (unpriced.ts policySymbolOf: an Orderly market's base).
 */
export function checkValue(policy: ContractPolicy, symbol: string, pxE8: bigint, szE8: bigint, referenceE8: bigint | null): bigint | null {
  if (szE8 === 0n) throw new ContractRefusal('E_SIZE', `${symbol} size is zero`);
  const unpriced = unpricedBySymbol(policy, symbol);
  if (unpriced !== undefined) {
    let maxSz = 0n;
    try {
      maxSz = parseE8('max_sz', unpriced.max_sz);
    } catch {
      maxSz = 0n;
    }
    if (szE8 > maxSz) {
      throw new ContractRefusal('E_SIZE', `${symbol} size ${formatE8(szE8)} is over its max_sz ${formatE8(maxSz)} (an unpriced symbol, capped in base units)`);
    }
    const cap = unpricedCapUsd(policy);
    checkNotional(symbol, pxE8, null, szE8, cap, 'the unpriced cap, min(max_notional_usd, unpriced_max_notional_usd)');
    return null;
  }
  if (referenceE8 === null) {
    throw new ContractRefusal('E_ORACLE_STALE', `no oracle price for ${symbol} younger than ${policy.oracle_max_age_s} s, and ${symbol} is not in policy.unpriced`);
  }
  checkBand(pxE8, referenceE8, policy.price_band_bps);
  checkNotional(symbol, pxE8, referenceE8, szE8, policy.max_notional_usd, 'max_notional_usd');
  return referenceE8;
}

/** check_order: the asset in the policy (E_ASSET), tif and cloid (E_ARGS), px and sz (E_DECIMAL / E_SIZE), then value. */
export function checkHlOrder(policy: ContractPolicy, order: HlOrder, reference: (symbol: string) => bigint | null): {
  symbol: string; cloid: string | null; oracleE8: bigint | null;
} {
  const asset = policy.hl_assets.find((a) => a.index === order.asset);
  if (asset === undefined) throw new ContractRefusal('E_ASSET', `Hyperliquid asset ${order.asset} is not in the desk's policy`);
  if (!['Ioc', 'Gtc', 'Alo'].includes(order.tif)) throw new ContractRefusal('E_ARGS', `tif ${JSON.stringify(order.tif)} is not Ioc, Gtc or Alo`);
  let cloid: string | null = null;
  if (order.cloid !== null && order.cloid !== undefined) {
    if (!/^0x[0-9a-fA-F]{32}$/.test(order.cloid)) throw new ContractRefusal('E_ARGS', `cloid ${JSON.stringify(order.cloid)} is not 0x and 16 bytes of hex`);
    cloid = order.cloid.toLowerCase();
  }
  const pxE8 = checkPx(order.px, asset.sz_decimals);
  const szE8 = checkSz(order.sz, asset.sz_decimals);
  const oracleE8 = checkValue(policy, asset.symbol, pxE8, szE8, unpricedBySymbol(policy, asset.symbol) !== undefined ? null : reference(asset.symbol));
  return { symbol: asset.symbol, cloid, oracleE8 };
}
