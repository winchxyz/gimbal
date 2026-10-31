// Phoenix unit conversions, kept apart and small because a unit mistake here loses money.
//
// Phoenix counts in integers:
//   - quote lots: 1 quote lot = 1e-6 USDC (collateral, PnL, funding, margin are all quote lots);
//   - base lots: 1 base lot = 10^-baseLotsDecimals base units (ETH 0.001, SOL 0.01, BTC 0.0001 per lot);
//   - ticks: a price is a whole number of ticks; one tick is `tickSize` quote lots per base lot.
// Numbers are converted by parsing the decimal text ("123e-6"), so the result is the double nearest the exact
// decimal value instead of a product of two rounded doubles.

/** Quote lots in one USDC. */
export const QUOTE_LOTS_PER_USDC = 1_000_000;
const QUOTE_DECIMALS = 6;

const INTEGER = /^-?\d+$/;

function integerText(value: string | bigint | number, what: string): string {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'bigint' ? value.toString() : Number.isSafeInteger(value) ? String(value) : '';
  if (!INTEGER.test(text)) throw new Error(`phoenix: ${what} must be a whole number, got ${JSON.stringify(String(value))}`);
  return text;
}

function checkDecimals(baseLotsDecimals: number): void {
  if (!Number.isInteger(baseLotsDecimals) || Math.abs(baseLotsDecimals) > 18) {
    throw new RangeError(`phoenix: baseLotsDecimals must be a small integer, got ${baseLotsDecimals}`);
  }
}

/** Quote lots (integer, 1e-6 USDC each) to USDC. */
export function quoteLotsToUsd(quoteLots: string | bigint | number): number {
  return Number(`${integerText(quoteLots, 'quote lots')}e-${QUOTE_DECIMALS}`) || 0;   // `|| 0`: no negative zero
}

/** Size of one base lot in base units: 10^-baseLotsDecimals (SOL: 2 -> 0.01 SOL). */
export function baseLotSize(baseLotsDecimals: number): number {
  checkDecimals(baseLotsDecimals);
  return Number(`1e${-baseLotsDecimals}`);
}

/** Base lots (integer, signed) to base units: lots x 10^-baseLotsDecimals (-614 SOL lots -> -6.14 SOL). */
export function baseLotsToUnits(baseLots: string | bigint | number, baseLotsDecimals: number): number {
  checkDecimals(baseLotsDecimals);
  return Number(`${integerText(baseLots, 'base lots')}e${-baseLotsDecimals}`) || 0;
}

/**
 * One price tick in USD per base unit. A tick is `tickSize` quote lots per base lot, so
 * USD per base unit = tickSize x 1e-6 x 10^baseLotsDecimals (SOL: 100 quote lots per 0.01-SOL lot -> 0.01 USD).
 */
export function tickSizeUsd(tickSizeQuoteLotsPerBaseLot: number, baseLotsDecimals: number): number {
  checkDecimals(baseLotsDecimals);
  const tick = integerText(tickSizeQuoteLotsPerBaseLot, 'tick size');
  if (tick.startsWith('-') || /^0+$/.test(tick)) throw new RangeError(`phoenix: tick size must be positive, got ${tick}`);
  return Number(`${tick}e${baseLotsDecimals - QUOTE_DECIMALS}`);
}

/** Decimals a USD price carries on this market: the decimals of one tick (0.01 -> 2, 0.5 -> 1, 10 -> 0). */
export function priceDecimals(tickSizeQuoteLotsPerBaseLot: number, baseLotsDecimals: number): number {
  tickSizeUsd(tickSizeQuoteLotsPerBaseLot, baseLotsDecimals);   // validates
  let mantissa = BigInt(tickSizeQuoteLotsPerBaseLot);
  let exponent = baseLotsDecimals - QUOTE_DECIMALS;
  while (mantissa % 10n === 0n) {
    mantissa /= 10n;
    exponent++;
  }
  return Math.max(0, -exponent);
}

/** A tick count to USD per base unit (SOL: 9626 ticks of 0.01 -> 96.26). */
export function ticksToUsd(ticks: string | bigint | number, tickSizeQuoteLotsPerBaseLot: number, baseLotsDecimals: number): number {
  tickSizeUsd(tickSizeQuoteLotsPerBaseLot, baseLotsDecimals);
  const total = BigInt(integerText(ticks, 'ticks')) * BigInt(tickSizeQuoteLotsPerBaseLot);
  return Number(`${total}e${baseLotsDecimals - QUOTE_DECIMALS}`) || 0;
}

/**
 * Hourly funding rate as a fraction of notional, > 0 when longs pay shorts (Hyperliquid's sign).
 * `fundingAmountPerUnit` is the USD one base unit paid over the funding interval (one hour on every Phoenix
 * market); dividing by the mark price of that interval gives the fraction. Never the API's `fundingRate`: its
 * scale differs per market. Phoenix books funding in whole quote lots per base lot, so coarse markets print 0.
 */
export function fundingRatePerHour(fundingAmountPerUnit: string | number, markPrice: string | number): number {
  const amount = Number(fundingAmountPerUnit);
  const mark = Number(markPrice);
  if (!Number.isFinite(amount)) throw new Error(`phoenix: fundingAmountPerUnit is not a number: ${JSON.stringify(fundingAmountPerUnit)}`);
  if (!(mark > 0)) throw new Error(`phoenix: mark price must be > 0, got ${JSON.stringify(markPrice)}`);
  return amount / mark || 0;
}

/** A percentage as decimal text ("0.002075", meaning 0.002075 %) to a fraction (0.00002075), without a rounding step. */
export function percentToFraction(percent: string): number {
  const text = percent.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) throw new Error(`phoenix: not a decimal percentage: ${JSON.stringify(percent)}`);
  const [mantissa, exponent = '0'] = text.split(/[eE]/);
  return Number(`${mantissa}e${Number(exponent) - 2}`) || 0;
}

/** Phoenix timestamps come as ms or as seconds depending on the endpoint; anything below 1e11 is seconds. */
export function phoenixTimeMs(t: number): number {
  if (!Number.isFinite(t) || t < 0) throw new Error(`phoenix: bad timestamp ${t}`);
  return t < 1e11 ? t * 1000 : t;
}
