import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsed, price, qty, ratioPct, signedQty, signedUsd, splitUsd } from './format.ts';

test('signed money has a plus or the real minus, and zero has neither', () => {
  assert.equal(signedUsd(1.36), '+$1.36');
  assert.equal(signedUsd(-0.48), '−$0.48');
  assert.equal(signedUsd(0), '$0.00');
  assert.equal(signedUsd(-0.004), '$0.00');
  assert.equal(signedUsd(0.011, 3), '+$0.011');
  assert.equal(signedUsd(-1234.5), '−$1,234.50');
});

test('the desk value splits into dollars and cents', () => {
  assert.deepEqual(splitUsd(999.41), { dollars: '$999', cents: '.41' });
  assert.deepEqual(splitUsd(1050), { dollars: '$1,050', cents: '.00' });
  assert.deepEqual(splitUsd(0.5), { dollars: '$0', cents: '.50' });
});

test('prices keep the digits that tell an entry from a mark', () => {
  assert.equal(price(0.19861), '0.19861');
  assert.equal(price(0.26314, 4), '0.2631');
  assert.equal(price(61.214), '61.214');
  assert.equal(price(5.5), '5.5000');
  assert.equal(price(2500.5), '2,500.50');
  assert.equal(price(65000.123), '65,000.12');
  assert.equal(price(0), '0');
  assert.equal(price(Number.NaN), '—');
});

test('sizes are base units without trailing zeros', () => {
  assert.equal(qty(6040), '6,040');
  assert.equal(qty(0.0215), '0.0215');
  assert.equal(qty(-6), '−6');
  assert.equal(qty(0.00001), '0');
  assert.equal(signedQty(120), '+120');
  assert.equal(signedQty(-6), '−6');
  assert.equal(signedQty(0), '0');
});

test('ratios and elapsed times', () => {
  assert.equal(ratioPct(0.31), '31%');
  assert.equal(ratioPct(0.334), '33%');
  assert.equal(elapsed(2000), '2 s');
  assert.equal(elapsed(-500), '0 s');
  assert.equal(elapsed(180_000), '3 min');
  assert.equal(elapsed(7_200_000), '2 h');
});
