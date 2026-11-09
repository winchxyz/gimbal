// The carry plan's arithmetic: net rate and APR, the spread over the hold against the round trip (the scanner's own
// deskRoundTrip), the liquidation distance per leg, and each refusal.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_MAX_LOSS_USD, deskRoundTrip } from '../scanner/carry.ts';
import { CARRY_BASIS_BUFFER_BPS, CARRY_HOLD_HOURS, DEFAULT_SCANNER_CONFIG, HL_BUILDER_TENTH_BPS, MAINNET_COSTS, hlFillFeeBps, withBuilderFee } from '../scanner/config.ts';
import { fillFeeBps } from '../scanner/costs.ts';
import type { CarryInput } from './carry-plan.ts';
import { LIVE_RESCUE, MIN_LIQUIDATION_DISTANCE, carryPlan, halfSpreadBps, meanRatePerHour, venueMaxLeverage } from './carry-plan.ts';

/** A book around `mid` with half its spread `halfBps`, deep enough for any leg here. */
function book(mid: number, halfBps: number) {
  const d = mid * halfBps / 1e4;
  return { bids: [{ px: mid - d, sz: 1e6 }], asks: [{ px: mid + d, sz: 1e6 }] };
}

const base: CarryInput = {
  symbol: 'ETH', legUsd: 15, leverage: 2, holdDays: 7, basisBufferBps: 10,
  short: { venue: 'hyperliquid', ratePerHour: 0.00002, rate7dPerHour: 0.00003, feeBps: 5.5, book: book(100, 1), equityUsd: 20, maintenanceUsd: 0, notionalUsd: 0, maintenanceRate: 0.01 },
  long: { venue: 'phoenix', ratePerHour: -0.00001, rate7dPerHour: -0.000005, feeBps: 3.5, book: book(100, 0.5), equityUsd: 20, maintenanceUsd: 0, notionalUsd: 0, maintenanceRate: 0.02 },
};

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('a carry that pays: net = short rate - long rate, the spread over 7 days covers the round trip', () => {
  const p = carryPlan(base);
  near(p.netPerHourNow, 0.00003, 1e-15);
  near(p.grossApr7d, 0.000035 * 8760, 1e-12);
  // 15 x 0.000035 x 24 x 7 = 0.0882 USD.
  near(p.expectedSpreadUsd, 0.0882, 1e-12);
  // Fees 15 x 2 x 9 / 1e4 = 0.027; the 4 fills cross half the spread: 2 x (1 + 0.5) bps = 3 bps = 0.0045 (a hair
  // off: each fill's units are its notional at the touch); buffer 10 bps = 0.015. 31 bps, 0.0465.
  near(p.roundTrip!.feesUsd, 0.027, 1e-12);
  near(p.roundTrip!.slippageUsd, 0.0045, 1e-8);
  near(p.roundTrip!.basisBufferUsd, 0.015, 1e-12);
  near(p.roundTripBps, 31, 1e-4);
  assert.equal(p.roundTripUsd, p.roundTrip!.totalUsd);
  // Hyperliquid: (20 - 0 - 15 x 0.01) / 15 = 1.3233; Phoenix (20 - 0.3) / 15.
  near(p.legs[0].liquidationDistance, 19.85 / 15, 1e-12);
  assert.deepEqual(p.refusals, []);
  assert.equal(p.costRefusal, null);
});

test('the round trip is the scanner\'s: deskRoundTrip on the same books, fees and buffer, the adverse gap of the mids included', () => {
  // Phoenix (long) a bp dearer than Hyperliquid (short): the long pays that gap when the two converge.
  const gap = { ...base, long: { ...base.long, book: book(100.01, 0.5) } };
  const p = carryPlan(gap);
  const same = deskRoundTrip(15, { feeBps: 3.5, book: gap.long.book, px: 100.01 }, { feeBps: 5.5, book: gap.short.book, px: 100 }, 0, 10);
  assert.ok(same.ok);
  assert.deepEqual(p.roundTrip, same.roundTrip);
  near(same.basisUsd!, (0.01 / 100.005) * 15, 1e-12);
  // The other way round the gap is not booked as income.
  const cheap = carryPlan({ ...base, long: { ...base.long, book: book(99.99, 0.5) } });
  near(cheap.roundTrip!.basisBufferUsd, 0.015, 1e-12);
});

test('the serve defaults are the scanner\'s: a 7-day hold, a 10 bps buffer, Hyperliquid 4.5 bps taker plus the 1 bp builder fee once', () => {
  assert.equal(CARRY_HOLD_HOURS, 7 * 24);
  assert.equal(MAINNET_COSTS.holdHours, CARRY_HOLD_HOURS);
  assert.equal(MAINNET_COSTS.basisBufferBps, CARRY_BASIS_BUFFER_BPS);
  assert.equal(CARRY_BASIS_BUFFER_BPS, 10);
  assert.equal(fillFeeBps(MAINNET_COSTS.fees.hyperliquid), 5.5);
  assert.equal(fillFeeBps(MAINNET_COSTS.fees.phoenix), 3.5);
  // One source for Hyperliquid's fee: the trader's open (hlFillFeeBps) and the scanner (withBuilderFee) take the
  // contract's builder fee alike; one the contract would not accept is unknown to the trader and changes no scanner cost.
  assert.deepEqual([hlFillFeeBps(10), hlFillFeeBps(20), hlFillFeeBps(100)], [5.5, 6.5, 14.5]);
  assert.deepEqual([hlFillFeeBps(undefined), hlFillFeeBps(null), hlFillFeeBps(0), hlFillFeeBps(101), hlFillFeeBps(1.5)], [null, null, null, null, null]);
  const base = { ...DEFAULT_SCANNER_CONFIG, costs: MAINNET_COSTS };
  for (const tenth of [10, 20, 35]) assert.equal(fillFeeBps(withBuilderFee(base, tenth).costs.fees.hyperliquid), hlFillFeeBps(tenth));
  assert.equal(withBuilderFee(base, null), base);
  assert.equal(withBuilderFee(base, 0), base);
  assert.equal(fillFeeBps(MAINNET_COSTS.fees.hyperliquid), hlFillFeeBps(HL_BUILDER_TENTH_BPS), 'the default is the contract default');
});

test('XLM on 2026-11-04: 17.8 % over 7 days at 11.44 USD a leg does not cover the round trip, so it is refused for cost', () => {
  // The books as the refusal read them: half spreads of 2.35 bps (Hyperliquid) and 1 bp (Phoenix), no gap.
  const xlm: CarryInput = {
    symbol: 'XLM', legUsd: 11.44, leverage: 1.5, holdDays: 7, basisBufferBps: 10,
    short: { ...base.short, ratePerHour: 0.178 / 8760, rate7dPerHour: 0.178 / 8760, feeBps: 5.5, book: book(1, 2.35) },
    long: { ...base.long, ratePerHour: 0, rate7dPerHour: 0, feeBps: 3.5, book: book(1, 1) },
  };
  const p = carryPlan(xlm);
  near(p.expectedSpreadUsd, 11.44 * 0.178 * 168 / 8760, 1e-12);
  // 2 x 9 bps fees + 2 x 3.35 bps crossed + 10 bps buffer = 34.7 bps = 0.0397 USD, over the 0.0391 USD it pays.
  near(p.roundTripBps, 34.7, 1e-3);
  assert.match(p.costRefusal!, /^the expected spread over 7 days, \$0\.0391, does not cover the round trip \$0\.0397 \(34\.7 bps: 4 fills \$0\.0206, slippage \$0\.0077, basis buffer \$0\.0114\)$/);
  assert.deepEqual(p.refusals, [p.costRefusal]);
  // From about 18.1 % a year it pays: 0.0397 / (11.44 x 168 / 8760).
  const rich = carryPlan({ ...xlm, short: { ...xlm.short, rate7dPerHour: 0.19 / 8760 } });
  assert.equal(rich.costRefusal, null);
});

test('refused: a spread under the round trip, a leg near liquidation, a leg under its collateral', () => {
  const thin = carryPlan({ ...base, holdDays: 1 });
  assert.match(thin.refusals.join(), /does not cover the round trip/);
  assert.equal(thin.costRefusal, thin.refusals[0]);
  const tight = carryPlan({ ...base, long: { ...base.long, equityUsd: 6 } });
  assert.equal(tight.refusals.length, 2);
  assert.equal(tight.costRefusal, null, 'a refusal for margin is not one for cost');
  assert.match(tight.refusals[0]!, /phoenix: \$0\.0000 already open plus the \$15\.0000 leg on \$6\.0000 of equity is 2\.50x, over its venue's 1\.5x cap \(no live rescue\): fund it with at least \$4\.0000 more/);
  assert.match(tight.refusals[1]!, /liquidated 38\.00 % away/);
  assert.ok(MIN_LIQUIDATION_DISTANCE === 0.4);
});

test('refused for cost when a book cannot price the round trip: one side empty, or too thin for the leg', () => {
  const empty = carryPlan({ ...base, long: { ...base.long, book: { bids: [], asks: [{ px: 100, sz: 1 }] } } });
  assert.equal(empty.roundTrip, null);
  assert.equal(empty.costRefusal, 'the phoenix book has no two-sided touch: the round trip cannot be priced');
  const shallow = carryPlan({ ...base, short: { ...base.short, book: { bids: [{ px: 99.99, sz: 0.05 }], asks: [{ px: 100.01, sz: 1 }] } } });
  assert.match(shallow.costRefusal!, /^the hyperliquid book fills only \$4\.9995 of \$15\.0000 within the levels read: the round trip cannot be priced$/);
});

test('an owner demo entry: the spread not covering the round trip is waived and said; a round trip over maxLossUsd and every other refusal stand', () => {
  // XLM as refused for cost above (0.0397 USD round trip): with demo it is waived, nothing refused.
  const xlm: CarryInput = {
    symbol: 'XLM', legUsd: 11.44, leverage: 1.5, holdDays: 7, basisBufferBps: 10,
    short: { ...base.short, ratePerHour: 0.178 / 8760, rate7dPerHour: 0.178 / 8760, feeBps: 5.5, book: book(1, 2.35) },
    long: { ...base.long, ratePerHour: 0, rate7dPerHour: 0, feeBps: 3.5, book: book(1, 1) },
  };
  const demo = carryPlan({ ...xlm, demo: { maxLossUsd: 0.25 } });
  assert.equal(demo.costRefusal, null);
  assert.match(demo.waived!, /^the expected spread over 7 days, \$0\.0391, does not cover the round trip \$0\.0397/);
  assert.deepEqual(demo.refusals, []);
  assert.equal(carryPlan(xlm).waived, null, 'without demo nothing is waived');
  // The round trip over what the owner accepted: refused, with both numbers; not a refusal for cost (no hold-out).
  const over = carryPlan({ ...xlm, demo: { maxLossUsd: 0.03 } });
  assert.deepEqual(over.refusals, ['owner demo entry: the round trip $0.0397 on this open\'s books is over the $0.0300 the owner accepted (maxLossUsd)']);
  assert.equal(over.costRefusal, null);
  // A book that cannot price it, margin and liquidation: refused as without demo.
  const empty = carryPlan({ ...xlm, demo: { maxLossUsd: 0.25 }, long: { ...xlm.long, book: { bids: [], asks: [{ px: 1, sz: 1 }] } } });
  assert.equal(empty.costRefusal, 'the phoenix book has no two-sided touch: the round trip cannot be priced');
  assert.equal(empty.waived, null);
  const tight = carryPlan({ ...base, holdDays: 1, demo: { maxLossUsd: 0.25 }, long: { ...base.long, equityUsd: 6 } });
  assert.notEqual(tight.waived, null);
  assert.equal(tight.refusals.length, 2);
  assert.match(tight.refusals.join(' | '), /1\.5x cap .* \| .*liquidated 38\.00 % away/);
});

test('an owner demo entry never waives funding against the position, and checks maxLossUsd again', () => {
  const xlm: CarryInput = {
    symbol: 'XLM', legUsd: 11.44, leverage: 1.5, holdDays: 7, basisBufferBps: 10,
    short: { ...base.short, ratePerHour: 0.178 / 8760, rate7dPerHour: 0.178 / 8760, feeBps: 5.5, book: book(1, 2.35) },
    long: { ...base.long, ratePerHour: 0, rate7dPerHour: 0, feeBps: 3.5, book: book(1, 1) },
  };
  // A 7-day spread of 0 or less: funding runs against the position, refused for cost as without demo.
  for (const rate7d of [0, -0.1 / 8760]) {
    const against = carryPlan({ ...xlm, demo: { maxLossUsd: 0.25 }, short: { ...xlm.short, rate7dPerHour: rate7d } });
    assert.ok(!(against.expectedSpreadUsd > 0));
    assert.equal(against.waived, null);
    assert.match(against.costRefusal!, /^the expected spread over 7 days, (\$0\.0000|-\$0\.0219), does not cover the round trip/);
    assert.ok(against.refusals.includes(against.costRefusal!));
  }
  // maxLossUsd not above 0, not finite, over DEMO_MAX_LOSS_USD or not a number: refused, and nothing is waived.
  for (const m of [0, -1, Number.NaN, Infinity, DEMO_MAX_LOSS_USD + 0.01, '0.25' as unknown as number]) {
    const bad = carryPlan({ ...xlm, demo: { maxLossUsd: m } });
    assert.equal(bad.waived, null, String(m));
    assert.ok(bad.refusals.some((r) => r.startsWith(`owner demo entry: maxLossUsd ${String(m)} is not a number above 0 and at most $1.0000`)), JSON.stringify(bad.refusals));
    assert.notEqual(bad.costRefusal, null);
  }
  assert.deepEqual(carryPlan({ ...xlm, demo: { maxLossUsd: DEMO_MAX_LOSS_USD } }).refusals, []);
});

test('an owner demo entry with a taker fallback: its fill is priced at the taker fee, and its slippage is held to maxLossUsd too', () => {
  const xlm: CarryInput = {
    symbol: 'XLM', legUsd: 11.44, leverage: 1.5, holdDays: 7, basisBufferBps: 10,
    short: { ...base.short, ratePerHour: 0.178 / 8760, rate7dPerHour: 0.178 / 8760, feeBps: 5.5, book: book(1, 2.35) },
    long: { ...base.long, ratePerHour: 0, rate7dPerHour: 0, feeBps: 3.5, book: book(1, 1) },
  };
  const plain = carryPlan({ ...xlm, demo: { maxLossUsd: 0.25 } });
  const taker = carryPlan({ ...xlm, demo: { maxLossUsd: 0.25, takerFallbackBps: 50 } });
  // Every fill of the round trip, the maker leg's open (which the fallback may take) included, at its taker fee.
  near(taker.roundTrip!.feesUsd, 2 * 11.44 * (5.5 + 3.5) / 10_000);
  near(taker.roundTripUsd, plain.roundTripUsd);
  near(taker.takerFallbackUsd, 11.44 * 50 / 10_000);
  assert.equal(plain.takerFallbackUsd, 0);
  assert.deepEqual(taker.refusals, [], '0.0397 + 0.0572 is under 0.25');
  // Between the round trip and the round trip with the fallback: refused, with the numbers (the waiver hides nothing).
  const between = carryPlan({ ...xlm, demo: { maxLossUsd: 0.05, takerFallbackBps: 50 } });
  assert.deepEqual(carryPlan({ ...xlm, demo: { maxLossUsd: 0.05 } }).refusals, [], 'without the fallback 0.0397 fits 0.05');
  assert.deepEqual(between.refusals, [
    'owner demo entry: the round trip $0.0397 on this open\'s books plus the taker fallback\'s 50 bps past the touch ($0.0572), $0.0969, is over the $0.0500 the owner accepted (maxLossUsd)',
  ]);
  assert.notEqual(between.waived, null, 'the spread not covering it is still the only check waived');
  // A takerFallbackBps that is not a number of 0 or more: refused.
  assert.ok(carryPlan({ ...xlm, demo: { maxLossUsd: 0.25, takerFallbackBps: -1 } }).refusals.some((r) => /takerFallbackBps -1 is not a number of 0 or more/.test(r)));
});

test('the 7-day mean weights each print by its hours; half spread in bps of the mid', () => {
  assert.equal(meanRatePerHour([]), null);
  near(meanRatePerHour([{ ratePerHour: 0.0001, periodHours: 1 }, { ratePerHour: 0.0004, periodHours: 3 }])!, 0.000325, 1e-15);
  near(halfSpreadBps(99.99, 100.01), 1);
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
  near(busy.legs[0].effectiveLeverage, 25 / 12, 1e-12);
  assert.match(busy.refusals.join(), /hyperliquid: \$10\.0000 already open .* is 2\.08x, over the 2x asked/);
});
