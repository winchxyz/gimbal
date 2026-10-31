import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatE8, isCanonical, maxSzForUsd, parseE8, usdForSz } from './decimal.ts';

test('decimals parse to 1e-8 units and print canonically', () => {
  assert.equal(parseE8('12.5'), 1_250_000_000n);
  assert.equal(parseE8('0.00000001'), 1n);
  assert.equal(parseE8('0.000000001'), null);
  assert.equal(parseE8('-1'), null);
  assert.equal(parseE8('1e3'), null);
  assert.equal(parseE8(''), null);
  assert.equal(formatE8(1_250_000_000n), '12.5');
  assert.equal(formatE8(0n), '0');
  assert.equal(formatE8(1n), '0.00000001');
  assert.equal(formatE8(100_000_000n), '1');
});

test('canonical means no leading or trailing zeros and at most 8 decimals', () => {
  for (const ok of ['0', '1', '10', '0.5', '16260.1626', '0.00000001']) assert.equal(isCanonical(ok), true, ok);
  for (const bad of ['', '01', '1.50', '1.', '.5', '-1', '0.000000001', '1e5', ' 1', '0.0']) assert.equal(isCanonical(bad), false, bad);
});

test('a USD cap becomes a size cap at the mark, rounded down, canonical', () => {
  assert.equal(maxSzForUsd(200, 0.0123), '16260.16260162');
  assert.equal(maxSzForUsd('200', '0.0123'), '16260.16260162');
  assert.equal(maxSzForUsd(100, 2), '50');
  assert.equal(maxSzForUsd(100, 3), '33.33333333');
  assert.equal(maxSzForUsd(1, 100_000), '0.00001');
  // never more than the dollar cap: the size times the mark stays at or under it
  const sz = maxSzForUsd(100, 3)!;
  assert.ok(Number(sz) * 3 <= 100);
  assert.ok(isCanonical(sz));
});

test('a cap that cannot be priced is refused, not guessed', () => {
  assert.equal(maxSzForUsd(0, 1), null);
  assert.equal(maxSzForUsd(-5, 1), null);
  assert.equal(maxSzForUsd(100, 0), null);
  assert.equal(maxSzForUsd(100, Number.NaN), null);
  assert.equal(maxSzForUsd(Number.POSITIVE_INFINITY, 1), null);
  assert.equal(maxSzForUsd('abc', 1), null);
  assert.equal(maxSzForUsd(0.000001, 1_000_000), null, 'under one unit at 8 decimals');
  assert.equal(maxSzForUsd(1e15, 1e-9), null, 'over 2^53 base units');
});

test('a size cap shows what it is worth at the mark, to the cent, rounded down', () => {
  assert.equal(usdForSz('16260.16260162', 0.0123), 199.99);
  assert.equal(usdForSz('50', 2), 100);
  assert.equal(usdForSz('x', 2), null);
});
