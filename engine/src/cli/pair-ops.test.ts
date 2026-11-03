// The open's order-time size check (contract S2): the qty decide() sized is a maximum, held to max_notional at the
// highest price an order of the open may carry; it is only ever lowered, to whole common lots, the same on both legs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toQty } from '../trade/lots.ts';
import { MIN_ORDER_USD, capQtyAtOrder } from './pair-ops.ts';

const LOT = toQty('0.01');

test('a 2.1 % rise after decide() sized 0.2 at 100 under a 20 USD cap: cut to 0.19, whole lots, under the cap', () => {
  const r = capQtyAtOrder({ qty: toQty('0.2'), lot: LOT, worstPx: 100 * 1.021, midPx: 101, capUsd: 20 });
  assert.ok('qty' in r);
  assert.equal(r.qty, toQty('0.19'));
  assert.equal(r.cut, true);
  assert.ok(0.19 * 102.1 <= 20);
  assert.equal(r.qty % LOT, 0n, 'whole common lots');
});

test('a size that still fits is sent as sized, never raised', () => {
  const r = capQtyAtOrder({ qty: toQty('0.12'), lot: LOT, worstPx: 102.1, midPx: 101, capUsd: 20 });
  assert.deepEqual(r, { qty: toQty('0.12'), cut: false });
});

test('under one lot, or under the minimum order at the mid, after the cut: nothing is sent', () => {
  const lot = toQty('1');
  const one = capQtyAtOrder({ qty: toQty('1'), lot, worstPx: 20 * 1.021, midPx: 20.2, capUsd: 20 });
  assert.ok('refused' in one);
  assert.match(one.refused, /under one common lot 1 fits the cap.*nothing sent/);

  const small = capQtyAtOrder({ qty: toQty('0.1'), lot: LOT, worstPx: 100 * 1.021, midPx: 101, capUsd: 10 });
  assert.ok('refused' in small);
  assert.match(small.refused, new RegExp(`0\\.09 is 9\\.09 USD, under the ${MIN_ORDER_USD} USD minimum order`));
});

test('no price: refused, nothing sent', () => {
  assert.ok('refused' in capQtyAtOrder({ qty: toQty('0.1'), lot: LOT, worstPx: 0, midPx: 0, capUsd: 20 }));
  assert.ok('refused' in capQtyAtOrder({ qty: toQty('0.1'), lot: LOT, worstPx: Number.NaN, midPx: 100, capUsd: 20 }));
});
