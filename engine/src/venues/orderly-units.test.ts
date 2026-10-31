import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ORDERLY_BASE_TAKER_FEE_BPS, maxLeverageFromImr, positionImr, positionMmr, ratePerHourFromPeriod, settlementForPeriod,
  stepDecimals, takerFeeRate, unsettledFundingUsd, unsettledPnlUsd,
} from './orderly-units.ts';

test('funding per period (fraction) to per hour: rate / period hours; > 0 longs pay', () => {
  assert.equal(ratePerHourFromPeriod(-0.0001611, 8), -0.0001611 / 8);   // SOL, 8 h period: -2.01375e-5 per hour
  assert.equal(ratePerHourFromPeriod(0.0004, 4), 0.0001);              // a 4 h market
  assert.equal(ratePerHourFromPeriod(0.00005, 1), 0.00005);            // a 1 h market is already per hour
  assert.ok(Object.is(ratePerHourFromPeriod(-0, 8), 0));
  assert.throws(() => ratePerHourFromPeriod(0.0001, 0), /period/);
  assert.throws(() => ratePerHourFromPeriod(Number.NaN, 8), /not a number/);
});

test('settlement names for the periods Orderly uses (hours): 1, 4, 8, 24; anything else has none', () => {
  assert.equal(settlementForPeriod(1), 'hourly');
  assert.equal(settlementForPeriod(4), '4h');
  assert.equal(settlementForPeriod(8), '8h');
  assert.equal(settlementForPeriod(24), 'daily');
  assert.equal(settlementForPeriod(2), null);
});

test('taker fee as a fraction of notional: 3 bps plus the broker markup in bps', () => {
  assert.equal(ORDERLY_BASE_TAKER_FEE_BPS, 3);
  assert.equal(takerFeeRate(0), 0.0003);
  assert.equal(takerFeeRate(2), 0.0005);
  assert.equal(takerFeeRate(0.5), 0.00035);
  assert.throws(() => takerFeeRate(-1), /markup/);
});

test('step decimals from a size or price step (base units or USD)', () => {
  assert.equal(stepDecimals(0.01), 2);
  assert.equal(stepDecimals(0.001), 3);
  assert.equal(stepDecimals(0.00001), 5);
  assert.equal(stepDecimals(1e-7), 7);
  assert.equal(stepDecimals(1), 0);
  assert.equal(stepDecimals(10), 0);
  assert.equal(stepDecimals(0.5), 1);
  assert.throws(() => stepDecimals(0), /positive/);
});

test('max leverage = floor(1 / base IMR)', () => {
  assert.equal(maxLeverageFromImr(0.01), 100);
  assert.equal(maxLeverageFromImr(0.02), 50);
  assert.equal(maxLeverageFromImr(0.1), 10);
  assert.equal(maxLeverageFromImr(0.03), 33);
  assert.throws(() => maxLeverageFromImr(0), /IMR/);
});

test('IMR and MMR rates (fractions of notional USD) follow Orderly\'s size-scaled formulas', () => {
  // SOL: base IMR 1 %, base MMR 0.6 %, imr_factor 1.0667e-6. At 10,000 USD the scaled term is 1.0667e-6 x 10000^0.8.
  const scaled = 0.0000010667 * 10_000 ** 0.8;
  assert.ok(scaled < 0.01);
  assert.equal(positionImr(10_000, 0.01, 0.0000010667), 0.01);
  assert.equal(positionMmr(10_000, 0.006, 0.01, 0.0000010667), 0.006);
  // At 10 million USD the size term wins.
  const big = 0.0000010667 * 10_000_000 ** 0.8;
  assert.equal(positionImr(-10_000_000, 0.01, 0.0000010667), big);
  assert.equal(positionMmr(10_000_000, 0.006, 0.01, 0.0000010667), (0.006 / 0.01) * big);
  // An account leverage of 10x floors the IMR at 10 %.
  assert.equal(positionImr(10_000, 0.01, 0.0000010667, 10), 0.1);
});

test('unsettled funding (USDC, received > 0) = -qty x (sum unitary funding - last sum)', () => {
  // A long of 2 SOL while the sum rose by 0.5 USD per unit: longs paid, so -1 USDC.
  assert.equal(unsettledFundingUsd(2, 65.7, 65.2), -2 * (65.7 - 65.2));
  assert.ok(unsettledFundingUsd(2, 65.7, 65.2) < 0);
  assert.ok(unsettledFundingUsd(-2, 65.7, 65.2) > 0, 'a short receives');
  assert.ok(Object.is(unsettledFundingUsd(0, 2, 1), 0));
});

test('unsettled PnL (USDC) = qty x mark - cost position - qty x (sum - last sum)', () => {
  // Long 3 at a cost of 270 USDC, mark 96, funding sum up 0.1 per unit: 288 - 270 - 0.3 = 17.7.
  assert.ok(Math.abs(unsettledPnlUsd(3, 96, 270, 1.1, 1.0) - 17.7) < 1e-9);
  // Short 3 (cost -300 USDC: it sold for 300), mark 96: -288 + 300 + 0.3 = 12.3.
  assert.ok(Math.abs(unsettledPnlUsd(-3, 96, -300, 1.1, 1.0) - 12.3) < 1e-9);
});
