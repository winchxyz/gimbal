// Every watch venue's funding unit, one small function each, so a unit slip is visible in one place and each
// has a test stating the unit with a real recorded value (units.test.ts). The result is always a fraction of
// notional per hour, > 0 when longs pay shorts (Hyperliquid's sign).
//
// Units differ a lot: per hour, per 8 h, per funding interval (1/2/4/8/24 h, given in hours, minutes, seconds or
// ms), a 24 h rate paid hourly, an annualised fraction, and GMX's x1e30 annualised fraction per side.

import type { FundingRate } from '@gimbal/shared';
import { num } from './http.ts';

export const HOUR_MS = 3_600_000;
export const HOURS_PER_YEAR = 24 * 365;

export type Settlement = FundingRate['settlement'];

/** A rate per funding period of `periodHours` to a rate per hour. */
export function perPeriodToHourly(ratePerPeriod: number, periodHours: number): number {
  if (!Number.isFinite(ratePerPeriod)) throw new Error(`funding rate is not a number: ${ratePerPeriod}`);
  if (!(periodHours > 0) || !Number.isFinite(periodHours)) throw new RangeError(`funding period must be > 0 hours, got ${periodHours}`);
  return ratePerPeriod / periodHours || 0;
}

/** How often a market pays, from its period in hours; throws for a period the shared type has no name for. */
export function settlementForHours(periodHours: number): Exclude<Settlement, 'continuous'> {
  switch (periodHours) {
    case 1: return 'hourly';
    case 2: return '2h';
    case 4: return '4h';
    case 8: return '8h';
    case 24: return 'daily';
    default: throw new RangeError(`funding period of ${periodHours} h has no settlement name`);
  }
}

/** The next multiple of the period after `now` (venues settle on UTC boundaries: hourly, 00/08/16 for 8 h). */
export function nextBoundary(now: number, periodHours: number): number {
  const ms = periodHours * HOUR_MS;
  return (Math.floor(now / ms) + 1) * ms;
}

/** A venue's own next-settlement time (ms) when it is a sane future time, else the next period boundary. */
export function nextAtOr(venueMs: number | null, now: number, periodHours: number): number {
  if (venueMs !== null && Number.isFinite(venueMs) && venueMs > now - 60_000 && venueMs <= now + periodHours * HOUR_MS + 60_000) return venueMs;
  return nextBoundary(now, periodHours);
}

/** Open interest of one side where a venue reports both (Hyperliquid counts one side: total longs). */
export function oneSide(long: number, short: number): number {
  return (long + short) / 2;
}

/** A decimal string scaled by 10^-exponent, parsed in one step (no rounding of an intermediate product). */
export function scaledDecimal(text: unknown, exponent: number, field: string): number {
  const s = typeof text === 'string' ? text.trim() : typeof text === 'number' ? String(text) : '';
  const m = /^([-+]?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(s);
  if (m === null) throw new Error(`${field} is not a decimal: ${JSON.stringify(text)}`);
  const [, sign, int, frac = '', exp = '0'] = m;
  return Number(`${sign}${int}.${frac || '0'}e${Number(exp) - exponent}`) || 0;
}

// --- one function per venue: the venue's unit in its name and doc --------------------------------------------

/** Hyperliquid HIP-3 dexes (`metaAndAssetCtxs` with `dex`): `funding` is already per hour (the current hour's estimate). */
export function hlDexRatePerHour(funding: unknown): number {
  return num(funding, 'funding');
}

/** Binance / Bybit via Hyperliquid `predictedFundings`: `fundingRate` per `fundingIntervalHours` (1, 4 or 8 h). */
export function predictedRatePerHour(fundingRate: unknown, fundingIntervalHours: unknown): number {
  return perPeriodToHourly(num(fundingRate, 'fundingRate'), num(fundingIntervalHours, 'fundingIntervalHours'));
}

/** Pacifica `info/prices`: `next_funding` is the rate for the next hourly settlement, per hour. */
export function pacificaRatePerHour(nextFunding: unknown): number {
  return num(nextFunding, 'next_funding');
}

/** Lighter `funding-rates`: `rate` is scaled to 8 h (Hyperliquid's 0.0000125 per hour appears as 0.0001); paid hourly. */
export function lighterRatePerHour(rate8h: unknown): number {
  return perPeriodToHourly(num(rate8h, 'rate'), 8);
}

/** Extended `info/markets`: `marketStats.fundingRate` is per hour (computed each minute, applied hourly). */
export function extendedRatePerHour(fundingRate: unknown): number {
  return num(fundingRate, 'fundingRate');
}

/** Paradex `markets/summary`: `funding_rate` is per `funding_interval_minutes` (480 = 8 h); funding accrues continuously. */
export function paradexRatePerHour(fundingRate: unknown, intervalMinutes: unknown): number {
  return perPeriodToHourly(num(fundingRate, 'funding_rate'), num(intervalMinutes, 'funding_interval_minutes') / 60);
}

/** Aster `premiumIndex`: `lastFundingRate` is the running period's rate, per `fundingIntervalHours` (1, 2, 4 or 8 h). */
export function asterRatePerHour(lastFundingRate: unknown, intervalHours: number): number {
  return perPeriodToHourly(num(lastFundingRate, 'lastFundingRate'), intervalHours);
}

/** dYdX v4 indexer `perpetualMarkets`: `nextFundingRate` is per hour (the same unit as its hourly funding history). */
export function dydxRatePerHour(nextFundingRate: unknown): number {
  return num(nextFundingRate, 'nextFundingRate');
}

/** Nado `v2/contracts`: `funding_rate` is a 24 h rate, paid hourly: divide by 24 (0.0003 / 24 = 0.0000125). */
export function nadoRatePerHour(rate24h: unknown): number {
  return perPeriodToHourly(num(rate24h, 'funding_rate'), 24);
}

/** Aevo `coingecko-statistics`: `funding_rate` is per `funding_interval_minutes` (60 on every perp). */
export function aevoRatePerHour(fundingRate: unknown, intervalMinutes: unknown): number {
  return perPeriodToHourly(num(fundingRate, 'funding_rate'), num(intervalMinutes, 'funding_interval_minutes') / 60);
}

/** Variational `metadata/v2/stats`: `funding.next.annualized_rate` is an annualised fraction: divide by 8760. */
export function variationalRatePerHour(annualizedRate: unknown): number {
  return perPeriodToHourly(num(annualizedRate, 'annualized_rate'), HOURS_PER_YEAR);
}

/**
 * GMX v2 `markets/info`: `netRateLong` / `netRateShort` are annualised fractions x 1e30, per side, funding plus
 * borrow, positive = that side pays. A long pays netRateLong; a short receives -netRateShort.
 */
export function gmxRatesPerHour(netRateLong: unknown, netRateShort: unknown): { ratePerHour: number; shortRatePerHour: number } {
  const long = scaledDecimal(netRateLong, 30, 'netRateLong');
  const short = scaledDecimal(netRateShort, 30, 'netRateShort');
  return { ratePerHour: long / HOURS_PER_YEAR || 0, shortRatePerHour: -short / HOURS_PER_YEAR || 0 };
}

/** OKX `public/funding-rate`: `fundingRate` is the running period's rate; the period is `fundingTime - prevFundingTime` (ms). */
export function okxRatePerHour(fundingRate: unknown, periodMs: number): number {
  return perPeriodToHourly(num(fundingRate, 'fundingRate'), periodMs / HOUR_MS);
}

/** Bitget `mix/market/tickers`: `fundingRate` per `current-fund-rate.fundingRateInterval` (hours). */
export function bitgetRatePerHour(fundingRate: unknown, intervalHours: unknown): number {
  return perPeriodToHourly(num(fundingRate, 'fundingRate'), num(intervalHours, 'fundingRateInterval'));
}

/** Gate `futures/usdt/contracts`: `funding_rate` per `funding_interval` (seconds). */
export function gateRatePerHour(fundingRate: unknown, intervalSeconds: unknown): number {
  return perPeriodToHourly(num(fundingRate, 'funding_rate'), num(intervalSeconds, 'funding_interval') / 3600);
}

/** KuCoin `contracts/active`: `fundingFeeRate` per `currentFundingRateGranularity` (ms). */
export function kucoinRatePerHour(fundingFeeRate: unknown, granularityMs: unknown): number {
  return perPeriodToHourly(num(fundingFeeRate, 'fundingFeeRate'), num(granularityMs, 'currentFundingRateGranularity') / HOUR_MS);
}

/** MEXC `contract/funding_rate`: `fundingRate` per `collectCycle` (hours). */
export function mexcRatePerHour(fundingRate: unknown, collectCycleHours: unknown): number {
  return perPeriodToHourly(num(fundingRate, 'fundingRate'), num(collectCycleHours, 'collectCycle'));
}

/**
 * Kraken Futures `tickers`: `relativeFundingRate` is per hour: the venue settles hourly, its funding history has
 * one row per hour at the same magnitude, and BTC's week of rows averages 12% APR read as hourly. `fundingRate` is
 * USD per contract, not a fraction.
 */
export function krakenRatePerHour(relativeFundingRate: unknown): number {
  return num(relativeFundingRate, 'relativeFundingRate');
}

/** Backpack `markPrices`: `fundingRate` per `markets.fundingInterval` (ms; 3600000 on every perp). */
export function backpackRatePerHour(fundingRate: unknown, intervalMs: unknown): number {
  return perPeriodToHourly(num(fundingRate, 'fundingRate'), num(intervalMs, 'fundingInterval') / HOUR_MS);
}
