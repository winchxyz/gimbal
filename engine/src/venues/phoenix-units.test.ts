import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  QUOTE_LOTS_PER_USDC, baseLotSize, baseLotsToUnits, fundingRatePerHour, percentToFraction, phoenixTimeMs, priceDecimals,
  quoteLotsToUsd, tickSizeUsd, ticksToUsd,
} from './phoenix-units.ts';

test('quote lots to USDC: 1 quote lot = 1e-6 USDC, exact for the decimal value', () => {
  assert.equal(QUOTE_LOTS_PER_USDC, 1_000_000);
  assert.equal(quoteLotsToUsd('189647885750'), 189647.88575);        // a collateral balance, USDC
  assert.equal(quoteLotsToUsd('-672684'), -0.672684);                // a uPnL, USDC
  assert.equal(quoteLotsToUsd(1n), 0.000001);
  assert.equal(quoteLotsToUsd(0), 0);
  assert.ok(Object.is(quoteLotsToUsd('-0'), 0), 'no negative zero');
  assert.throws(() => quoteLotsToUsd('1.5'), /whole number/);
  assert.throws(() => quoteLotsToUsd(0.5), /whole number/);
});

test('base lots to base units: lots x 10^-baseLotsDecimals (SOL 0.01, ETH 0.001, BTC 0.0001 per lot)', () => {
  assert.equal(baseLotSize(2), 0.01);                                // SOL per lot
  assert.equal(baseLotSize(3), 0.001);                               // ETH per lot
  assert.equal(baseLotSize(4), 0.0001);                              // BTC per lot
  assert.equal(baseLotSize(-2), 100);                                // kPEPE: one lot is 100 units
  assert.equal(baseLotsToUnits('-324213', 2), -3242.13);             // SOL
  assert.equal(baseLotsToUnits('-137967', 3), -137.967);             // ETH
  assert.equal(baseLotsToUnits('-39340', 4), -3.934);                // BTC
  assert.equal(baseLotsToUnits(5n, -2), 500);
  assert.throws(() => baseLotSize(1.5), /small integer/);
});

test('tick size in USD per base unit = tickSize quote lots per base lot x 1e-6 x 10^baseLotsDecimals', () => {
  assert.equal(tickSizeUsd(100, 2), 0.01);                           // SOL: 100 quote lots per 0.01-SOL lot -> 0.01 USD
  assert.equal(tickSizeUsd(100, 3), 0.1);                            // ETH
  assert.equal(tickSizeUsd(100, 4), 1);                              // BTC
  assert.equal(tickSizeUsd(100, -2), 0.000001);                      // kPEPE
  assert.equal(priceDecimals(100, 2), 2);
  assert.equal(priceDecimals(100, 4), 0);
  assert.equal(priceDecimals(5, 5), 1);                              // 0.5 USD tick
  assert.equal(priceDecimals(100, -2), 6);
  assert.equal(ticksToUsd('9626', 100, 2), 96.26);                   // SOL: 9626 ticks of 0.01 USD
  assert.equal(ticksToUsd('83042', 100, 4), 83042);                  // BTC: ticks of 1 USD
  assert.throws(() => tickSizeUsd(0, 2), /positive/);
});

test('funding rate per hour = fundingAmountPerUnit (USD per base unit per hour) / mark price (USD); > 0 longs pay', () => {
  // SOL 2026-10-30 23:00: 0.0014 USD per SOL at a mark of 95.88 -> 1.46e-5 per hour (the history row says 0.001460 %).
  assert.ok(Math.abs(fundingRatePerHour('0.001400000000', '95.880000000000') - 0.0000146016) < 1e-10);
  assert.equal(fundingRatePerHour('0.000000000000', '1.258'), 0);    // coarse markets print zero: normal
  assert.ok(fundingRatePerHour('-0.002', '100') < 0);                // shorts pay longs
  assert.throws(() => fundingRatePerHour('0.1', '0'), /mark price/);
  assert.throws(() => fundingRatePerHour('x', '1'), /not a number/);
});

test('percent text to a fraction: "0.002075" (%) -> 0.00002075, without a rounding step', () => {
  assert.equal(percentToFraction('0.002075'), 0.00002075);
  assert.equal(percentToFraction('-0.007124'), -0.00007124);
  assert.equal(percentToFraction('1.5e-3'), 0.000015);
  assert.equal(percentToFraction('0'), 0);
  assert.throws(() => percentToFraction('1%'), /decimal percentage/);
});

test('Phoenix timestamps: seconds (funding overview) and ms (history, parsed from ISO) both come out as ms', () => {
  assert.equal(phoenixTimeMs(1793404800), 1793404800000);            // 2026-10-31T00:00:00Z in seconds
  assert.equal(phoenixTimeMs(1793404800000), 1793404800000);
  assert.throws(() => phoenixTimeMs(Number.NaN), /bad timestamp/);
});
