// The carry plan's arithmetic: net rate and APR, the spread over the hold against the round trip, the liquidation
// distance per leg, and each refusal.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CarryInput } from './carry-plan.ts';
import { LIVE_RESCUE, MIN_LIQUIDATION_DISTANCE, carryPlan, halfSpreadBps, meanRatePerHour, venueMaxLeverage } from './carry-plan.ts';

const base: CarryInput = {
  symbol: 'ETH', legUsd: 15, leverage: 2, holdDays: 7, basisBufferBps: 10,
  short: { venue: 'hyperliquid', ratePerHour: 0.00002, rate7dPerHour: 0.00003, takerBps: 5.5, halfSpreadBps: 0.2, equityUsd: 20, maintenanceUsd: 0, notionalUsd: 0, maintenanceRate: 0.01 },
  long: { venue: 'phoenix', ratePerHour: -0.00001, rate7dPerHour: -0.000005, takerBps: 3.5, halfSpreadBps: 0.5, equityUsd: 20, maintenanceUsd: 0, notionalUsd: 0, maintenanceRate: 0.02 },
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
  assert.match(tight.refusals[0]!, /phoenix: \$0\.0000 already open plus the \$15\.0000 leg on \$6\.0000 of equity is 2\.50x, over its venue's 1\.5x cap \(no live rescue\): fund it with at least \$4\.0000 more/);
  assert.match(tight.refusals[1]!, /liquidated 38\.00 % away/);
  assert.ok(MIN_LIQUIDATION_DISTANCE === 0.4);
});

test('the 7-day mean weights each print by its hours; half spread in bps of the mid', () => {
  assert.equal(meanRatePerHour([]), null);
  assert.ok(Math.abs(meanRatePerHour([{ ratePerHour: 0.0001, periodHours: 1 }, { ratePerHour: 0.0004, periodHours: 3 }])! - 0.000325) < 1e-15);
  assert.ok(Math.abs(halfSpreadBps(99.99, 100.01) - 1) < 1e-9);
  assert.throws(() => halfSpreadBps(0, 1), /two-sided/);
});

test('leverage: at most 2x asked, 1.5x on a venue without a live rescue, counted with what the account already holds', () => {
  assert.deepEqual([venueMaxLeverage('hyperliquid'), venueMaxLeverage('phoenix'), venueMaxLeverage('orderly'), LIVE_RESCUE.phoenix], [2, 1.5, 1.5, false]);
  assert.match(carryPlan({ ...base, leverage: 3 }).refusals.join(), /--leverage 3 is over the 2x/);
  // 15 USD on 9 USD of equity is 1.67x: fine on Hyperliquid (2x), over Phoenix's 1.5x.
  const nine = carryPlan({ ...base, short: { ...base.short, equityUsd: 9 }, long: { ...base.long, equityUsd: 9 } });
  assert.deepEqual(nine.legs.map((l) => l.maxLeverage), [2, 1.5]);
  assert.equal(nine.refusals.filter((r) => /over/.test(r) && /phoenix/.test(r)).length, 1);
  assert.ok(!nine.refusals.some((r) => r.startsWith('hyperliquid: $')));
  // 10 USD already open on Hyperliquid with 12 of equity: (10 + 15) / 12 = 2.08x, over 2x.
  const busy = carryPlan({ ...base, short: { ...base.short, equityUsd: 12, notionalUsd: 10 } });
  assert.ok(Math.abs(busy.legs[0].effectiveLeverage - 25 / 12) < 1e-12);
  assert.match(busy.refusals.join(), /hyperliquid: \$10\.0000 already open .* is 2\.08x, over the 2x asked/);
});
