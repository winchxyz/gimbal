// Lot math: venue numbers become exact 1e-8 quantities, sizes round down to the coarser of two lots, and what the
// contract receives is a canonical decimal string.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commonLot, floorToLot, isWholeLots, lotQty, qtyString, signedQtyString, toQty } from './lots.ts';

test('toQty reads strings and floats exactly to 1e-8, rounding the 9th decimal', () => {
  assert.equal(toQty('0.0045'), 450_000n);
  assert.equal(toQty('-0.0045'), -450_000n);
  assert.equal(toQty(0.1 + 0.2), 30_000_000n, 'float noise below 1e-8 is gone');
  assert.equal(toQty('12'), 1_200_000_000n);
  assert.equal(toQty('.5'), 50_000_000n);
  assert.equal(toQty('0.000000015'), 2n, 'half away from zero');
  assert.equal(toQty(-0), 0n);
  assert.throws(() => toQty('1e-3'), /not a decimal quantity/);
  assert.throws(() => toQty(Number.NaN), /not a finite quantity/);
  assert.throws(() => toQty(''), /not a decimal quantity/);
});

test('qtyString is canonical: no sign, no leading or trailing zeros, at most 8 decimals', () => {
  assert.equal(qtyString(450_000n), '0.0045');
  assert.equal(qtyString(-450_000n), '0.0045');
  assert.equal(qtyString(100_000_000n), '1');
  assert.equal(qtyString(0n), '0');
  assert.equal(qtyString(1n), '0.00000001');
  assert.equal(signedQtyString(-1_250_000_000n), '-12.5');
});

test('lots: HL szDecimals, Orderly base_tick, the common lot, and rounding down', () => {
  assert.equal(lotQty(4), 10_000n, 'HL ETH szDecimals 4 = 0.0001');
  assert.equal(lotQty('0.0001'), 10_000n, 'Orderly PERP_ETH_USDC base_tick');
  assert.equal(lotQty(0), 100_000_000n);
  assert.throws(() => lotQty('0.000000001'), /finer than 1e-8/);
  assert.throws(() => lotQty(9), /lot decimals/);
  assert.equal(commonLot(10_000n, 10_000n), 10_000n);
  assert.equal(commonLot(lotQty('0.001'), lotQty('0.0004')), lotQty('0.002'), 'least common multiple, not the max');
  assert.equal(commonLot(lotQty(2), lotQty('0.05')), lotQty('0.05'));
  const lot = commonLot(lotQty(4), lotQty('0.0001'));
  assert.equal(qtyString(floorToLot(toQty('0.00456789'), lot)), '0.0045', 'down, never up: a capped size stays under its cap');
  assert.equal(floorToLot(toQty('-0.00456'), lot), 450_000n, 'the magnitude');
  assert.equal(floorToLot(toQty('0.00009'), lot), 0n);
  assert.ok(isWholeLots(450_000n, lot));
  assert.ok(!isWholeLots(450_001n, lot));
});
