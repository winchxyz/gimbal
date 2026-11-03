// The carry plan's arithmetic: net rate and APR, the spread over the hold against the round trip, the liquidation
// distance per leg, and each refusal.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CarryInput } from './carry-plan.ts';
import { MIN_LIQUIDATION_DISTANCE, carryPlan, halfSpreadBps, meanRatePerHour } from './carry-plan.ts';

const base: CarryInput = {
  symbol: 'ETH', legUsd: 15, leverage: 2, holdDays: 7, basisBufferBps: 10,
  short: { venue: 'hyperliquid', ratePerHour: 0.00002, rate7dPerHour: 0.00003, takerBps: 5.5, halfSpreadBps: 0.2, equityUsd: 20, maintenanceUsd: 0, maintenanceRate: 0.01 },
  long: { venue: 'phoenix', ratePerHour: -0.00001, rate7dPerHour: -0.000005, takerBps: 3.5, halfSpreadBps: 0.5, equityUsd: 20, maintenanceUsd: 0, maintenanceRate: 0.02 },
};

test('a carry that pays: net = short rate - long rate, the spread over 7 days covers the round trip', () => {
  const p = carryPlan(base);
  assert.ok(Math.abs(p.netPerHourNow - 0.00003) < 1e-15);
  assert.ok(Math.abs(p.grossApr7d - 0.000035 * 8760) < 1e-12);
  // 15 x 0.000035 x 24 x 7 = 0.0882 USD; round trip 2 x 9 + 2 x 0.7 + 10 = 29.4 bps = 0.0441 USD.
  assert.ok(Math.abs(p.expectedSpreadUsd - 0.0882) < 1e-12);
  assert.ok(Math.abs(p.roundTripBps - 29.4) < 1e-9);
  // Hyperliquid: (20 - 0 - 15 x 0.01) / 15 = 1.3233; Phoenix (20 - 0.3) / 15.
  assert.ok(Math.abs(p.legs[0].liquidationDistance - 19.85 / 15) < 1e-12);
  assert.deepEqual(p.refusals, []);
});

test('refused: a spread under the round trip, a leg near liquidation, a leg under its collateral', () => {
  const thin = carryPlan({ ...base, holdDays: 1 });
  assert.match(thin.refusals.join(), /does not cover the round trip/);
  const tight = carryPlan({ ...base, long: { ...base.long, equityUsd: 6 } });
  assert.equal(tight.refusals.length, 2);
  assert.match(tight.refusals[0]!, /phoenix holds \$6\.0000 of equity, under the \$7\.5000/);
  assert.match(tight.refusals[1]!, /liquidated 38\.00 % away/);
  assert.ok(MIN_LIQUIDATION_DISTANCE === 0.4);
});

test('the 7-day mean weights each print by its hours; half spread in bps of the mid', () => {
  assert.equal(meanRatePerHour([]), null);
  assert.ok(Math.abs(meanRatePerHour([{ ratePerHour: 0.0001, periodHours: 1 }, { ratePerHour: 0.0004, periodHours: 3 }])! - 0.000325) < 1e-15);
  assert.ok(Math.abs(halfSpreadBps(99.99, 100.01) - 1) < 1e-9);
  assert.throws(() => halfSpreadBps(0, 1), /two-sided/);
});
