// Orderly unit conversions and margin formulas, small and pure so each can be tested on its own numbers.
//
// Orderly quotes funding per funding period (8 h on most markets, 4 h or 1 h on some), as a fraction of notional,
// > 0 when longs pay shorts. Sizes are base units, prices USD per base unit, money USDC. A position's unpaid
// funding is not a field: it is qty x (sum_unitary_funding now - the position's lastSumUnitaryFunding).

import type { FundingRate } from '@gimbal/shared';

/** Orderly's own taker fee on every market, before a broker's markup: 3 bps. */
export const ORDERLY_BASE_TAKER_FEE_BPS = 3;

/** A rate per funding period (fraction) to a rate per hour: rate / periodHours (8 h: -0.0001611 -> -0.0000201375). */
export function ratePerHourFromPeriod(ratePerPeriod: number, periodHours: number): number {
  if (!Number.isFinite(ratePerPeriod)) throw new Error(`orderly: funding rate is not a number: ${ratePerPeriod}`);
  if (!(periodHours > 0)) throw new RangeError(`orderly: funding period must be > 0 hours, got ${periodHours}`);
  return ratePerPeriod / periodHours || 0;
}

/** How often a market pays, from its funding period in hours; null for a period the shared type has no name for. */
export function settlementForPeriod(periodHours: number): FundingRate['settlement'] | null {
  switch (periodHours) {
    case 1: return 'hourly';
    case 4: return '4h';
    case 8: return '8h';
    case 24: return 'daily';
    default: return null;
  }
}

/** Taker fee as a fraction of notional: Orderly's 3 bps plus the broker's markup in bps (markup 2 -> 0.0005). */
export function takerFeeRate(brokerMarkupBps: number): number {
  if (!(brokerMarkupBps >= 0)) throw new RangeError(`orderly: broker markup must be >= 0 bps, got ${brokerMarkupBps}`);
  return Number(`${ORDERLY_BASE_TAKER_FEE_BPS + brokerMarkupBps}e-4`);
}

/** Decimals of a size or price step given as a number (0.01 -> 2, 0.001 -> 3, 1 -> 0, 1e-7 -> 7, 5 -> 0). */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) throw new RangeError(`orderly: a step must be a positive number, got ${step}`);
  const [mantissa, exponent = '0'] = String(step).toLowerCase().split('e');
  const fraction = mantissa!.split('.')[1] ?? '';
  return Math.max(0, fraction.length - Number(exponent));
}

/** The most leverage a market allows: floor(1 / base IMR) (0.01 -> 100x, 0.03 -> 33x). */
export function maxLeverageFromImr(baseImr: number): number {
  if (!(baseImr > 0 && baseImr <= 1)) throw new RangeError(`orderly: base IMR must be in (0, 1], got ${baseImr}`);
  return Math.floor(1 / baseImr + 1e-9);
}

/**
 * Initial margin rate of a position (fraction of notional), Orderly's formula:
 * max(1 / accountLeverage, baseImr, imrFactor x |notional USD|^(4/5)). Without an account leverage the term is left out.
 */
export function positionImr(notionalUsd: number, baseImr: number, imrFactor: number, accountLeverage?: number): number {
  const scaled = imrFactor * Math.abs(notionalUsd) ** 0.8;
  return Math.max(accountLeverage !== undefined && accountLeverage > 0 ? 1 / accountLeverage : 0, baseImr, scaled);
}

/** Maintenance margin rate: max(baseMmr, baseMmr / baseImr x imrFactor x |notional USD|^(4/5)). */
export function positionMmr(notionalUsd: number, baseMmr: number, baseImr: number, imrFactor: number): number {
  return Math.max(baseMmr, (baseMmr / baseImr) * imrFactor * Math.abs(notionalUsd) ** 0.8);
}

/**
 * Funding a position has accrued but not settled, USDC, received > 0 and paid < 0:
 * -qty x (sumUnitaryFunding - lastSumUnitaryFunding). The sum grows while longs pay, so a long (qty > 0) pays.
 */
export function unsettledFundingUsd(qty: number, sumUnitaryFunding: number, lastSumUnitaryFunding: number): number {
  return -qty * (sumUnitaryFunding - lastSumUnitaryFunding) || 0;
}

/**
 * A position's unsettled PnL, USDC, as Orderly defines it: qty x mark - costPosition - qty x (sum - last sum).
 * It holds price PnL and unsettled funding together; settling moves it into the USDC holding.
 */
export function unsettledPnlUsd(qty: number, markPx: number, costPosition: number, sumUnitaryFunding: number, lastSumUnitaryFunding: number): number {
  return qty * markPx - costPosition + unsettledFundingUsd(qty, sumUnitaryFunding, lastSumUnitaryFunding) || 0;
}
