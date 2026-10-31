// Legs and pairs: base mapping, the mark and open-interest filters, both directions, the CEX rule.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterLegs, isDeskVenue, pairLegs, toLeg, windowId } from './pairs.ts';
import { T0, leg, row } from './test-helpers.ts';

const OPTS = { oiFloorUsd: 500_000, maxMarkDeviation: 0.1 };

test('a funding row as a leg: base and multiplier, mark per base unit, open interest in USD', () => {
  // HL kPEPE at 0.012 per 1000 PEPE, 1e9 kPEPE open: mark 0.000012 per PEPE, OI 1e9 × 0.012 = 12 M USD.
  const l = toLeg(row('hyperliquid', 'kPEPE', { base: 'PEPE', multiplier: 1000, markPx: 0.012, openInterest: 1e9 }), 'desk', T0, false)!;
  assert.equal(l.base, 'PEPE');
  assert.equal(l.multiplier, 1000);
  assert.equal(l.venueMarkPx, 0.012);
  assert.ok(Math.abs(l.markPx! - 0.000012) < 1e-15);
  assert.ok(Math.abs(l.oiUsd! - 12e6) < 1e-6);
  // A short receives ratePerHour unless the venue says otherwise.
  assert.equal(l.shortRatePerHour, l.ratePerHour);
  assert.equal(toLeg(row('gmx', 'ETH', { ratePerHour: 0.00002, shortRatePerHour: 0.000015 }), 'dex', T0, false)!.shortRatePerHour, 0.000015);
  // No base: the symbol is the base.
  assert.equal(toLeg(row('phoenix', 'SOL'), 'desk', T0, false)!.base, 'SOL');
});

test('a row without a finite rate or with a bad multiplier is no leg; a bad mark leaves mark and OI missing, not 0', () => {
  assert.equal(toLeg(row('hyperliquid', 'X', { ratePerHour: Number.NaN }), 'desk', T0, false), null);
  assert.equal(toLeg(row('hyperliquid', 'X', { multiplier: 0 }), 'desk', T0, false), null);
  const noMark = toLeg(row('hyperliquid', 'X', { markPx: 0 }), 'desk', T0, false)!;
  assert.equal(noMark.markPx, null);
  assert.equal(noMark.oiUsd, null);
  assert.equal(toLeg(row('hyperliquid', 'X', { openInterest: null }), 'desk', T0, false)!.oiUsd, null);
});

test('one leg per venue and base: the one with more open interest stays', () => {
  const a = leg('orderly', 'PERP_1000X_USDC', { base: 'X', multiplier: 1000, markPx: 10, openInterest: 100_000 });
  const b = leg('orderly', 'PERP_X_USDC', { base: 'X', markPx: 0.5, openInterest: 2_000_000 });
  const { kept, dropped } = filterLegs([a, b], OPTS);
  // a: 100k × 10 = 1 M USD; b: 2 M × 0.5 = 1 M USD too: the tie goes to the smaller symbol.
  assert.deepEqual(kept.map((l) => l.symbol), ['PERP_1000X_USDC']);
  assert.deepEqual(dropped, [{ venue: 'orderly', symbol: 'PERP_X_USDC', reason: 'duplicate' }]);
  const c = leg('orderly', 'PERP_X_USDC', { base: 'X', markPx: 0.5, openInterest: 4_000_000 });
  assert.deepEqual(filterLegs([a, c], OPTS).kept.map((l) => l.symbol), ['PERP_X_USDC']);
});

test('marks: a leg more than 10 % from the median of the same base elsewhere is dropped', () => {
  // 100, 101, 130: only the 130 leg goes; the 100 leg is checked against 101 (the nearest median of 101 and 130).
  const legs = [
    leg('hyperliquid', 'X', { markPx: 100, openInterest: 10_000 }),
    leg('phoenix', 'X', { markPx: 101, openInterest: 10_000 }),
    leg('orderly', 'PERP_X_USDC', { base: 'X', markPx: 130, openInterest: 10_000 }),
  ];
  const { kept, dropped } = filterLegs(legs, OPTS);
  assert.deepEqual(kept.map((l) => l.venue), ['hyperliquid', 'phoenix']);
  assert.deepEqual(dropped, [{ venue: 'orderly', symbol: 'PERP_X_USDC', reason: 'mark-outlier' }]);
  // Two venues 30 % apart: neither can be trusted, both go.
  assert.equal(filterLegs(legs.filter((l) => l.venue !== 'phoenix'), OPTS).kept.length, 0);
  // 9 % apart is the same asset.
  assert.equal(filterLegs([legs[0]!, leg('phoenix', 'X', { markPx: 109, openInterest: 10_000 })], OPTS).kept.length, 2);
  // A multiplier the reader got wrong looks like an outlier: kPEPE read as 1 PEPE is 1000 times the others.
  const wrong = [
    leg('hyperliquid', 'kPEPE', { base: 'PEPE', markPx: 0.012, openInterest: 1e9 }),
    leg('phoenix', 'kPEPE', { base: 'PEPE', multiplier: 1000, markPx: 0.012, openInterest: 1e9 }),
    leg('orderly', 'PERP_1000PEPE_USDC', { base: 'PEPE', multiplier: 1000, markPx: 0.012, openInterest: 1e9 }),
  ];
  assert.deepEqual(filterLegs(wrong, OPTS).dropped, [{ venue: 'hyperliquid', symbol: 'kPEPE', reason: 'mark-outlier' }]);
});

test('open interest: under the floor is dropped; unknown OI is no zero, but only a watch-only leg may lack it', () => {
  const legs = [
    leg('hyperliquid', 'X', { markPx: 100, openInterest: 4_999 }),     // 499,900 USD: under 500k
    leg('phoenix', 'X', { markPx: 100, openInterest: 5_000 }),         // exactly 500k: kept
    leg('orderly', 'PERP_X_USDC', { base: 'X', markPx: 100, openInterest: null }),   // a desk leg must be sized
    leg('okx', 'X', { markPx: null, openInterest: null }, 'cex'),
    leg('aster', 'X', { markPx: 100.2, openInterest: null }),         // a DEX that publishes no OI: rate reference
    leg('pacifica', 'X', { markPx: null, openInterest: 9e9 }),        // a DEX leg without a mark cannot be priced
  ];
  const { kept, dropped } = filterLegs(legs, OPTS);
  assert.deepEqual(kept.map((l) => l.venue), ['phoenix', 'okx', 'aster']);
  assert.deepEqual(dropped.map((d) => [d.venue, d.reason]), [
    ['hyperliquid', 'under-oi-floor'], ['orderly', 'no-oi'], ['pacifica', 'no-mark'],
  ]);
});

test('pairs: both directions per base, never CEX against CEX; gross uses what the short receives', () => {
  const legs = [
    leg('hyperliquid', 'SOL', { ratePerHour: 0.00005 }),
    leg('phoenix', 'SOL', { ratePerHour: 0.00001 }),
    leg('okx', 'SOL', { ratePerHour: 0.00002 }, 'cex'),
    leg('binance', 'SOL', { ratePerHour: 0.00003 }, 'cex'),
    leg('gmx', 'SOL', { ratePerHour: 0.00004, shortRatePerHour: 0.00001 }),
    leg('hyperliquid', 'BTC'),
  ];
  const pairs = pairLegs(legs);
  const ids = pairs.map((p) => p.id).sort();
  // 5 SOL legs give 20 ordered pairs, less okx/binance both ways: 18. BTC has one venue: none.
  assert.equal(pairs.length, 18);
  assert.ok(!ids.includes('sol-okx-binance') && !ids.includes('sol-binance-okx'));
  assert.ok(ids.includes('sol-okx-hyperliquid') && ids.includes('sol-hyperliquid-okx'));
  const p = pairs.find((x) => x.id === 'sol-phoenix-hyperliquid')!;
  assert.ok(Math.abs(p.grossPerHour - 0.00004) < 1e-15);
  assert.equal(p.desk, true);
  // Short on GMX receives 0.00001, not its long rate 0.00004: long Phoenix 0.00001, so gross 0.
  assert.equal(pairs.find((x) => x.id === 'sol-phoenix-gmx')!.grossPerHour, 0);
  assert.equal(pairs.find((x) => x.id === 'sol-phoenix-okx')!.desk, false);

  // Two legs that both lack open interest have no capacity and no leg that passed the floor: never paired.
  const unknown = pairLegs([
    leg('aster', 'SOL', { openInterest: null }),
    leg('bybit', 'SOL', { markPx: null, openInterest: null }, 'cex'),
    leg('hyperliquid', 'SOL'),
  ]).map((p) => p.id).sort();
  assert.deepEqual(unknown, ['sol-aster-hyperliquid', 'sol-bybit-hyperliquid', 'sol-hyperliquid-aster', 'sol-hyperliquid-bybit']);
});

test('window ids are lowercase base-long-short; desk venues are the three tradable ones', () => {
  assert.equal(windowId('kPEPE', 'hyperliquid', 'phoenix'), 'kpepe-hyperliquid-phoenix');
  assert.ok(isDeskVenue('orderly'));
  assert.ok(!isDeskVenue('pacifica'));
});
