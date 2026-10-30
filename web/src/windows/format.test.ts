import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayMonth, dayMonthTime, depth, duration, hours, list, pct, plain, sentence, usd, usdWhole, venueName } from './format.ts';

test('percentages use the real minus sign and never show a negative zero', () => {
  assert.equal(pct(8.64), '8.6%');
  assert.equal(pct(-2.4), '−2.4%');
  assert.equal(pct(-0.04), '0.0%');
  assert.equal(pct(35), '35.0%');
  assert.equal(plain(39.34), '39.3');
  assert.equal(plain(-4.1), '−4.1');
});

test('dollars: cents for small amounts, whole dollars for leg sizes', () => {
  assert.equal(usd(0.2833), '$0.28');
  assert.equal(usd(1.1), '$1.10');
  assert.equal(usd(-0.07), '−$0.07');
  assert.equal(usd(-0.001), '$0.00');
  assert.equal(usd(1234.5), '$1,234.50');
  assert.equal(usdWhole(1200), '$1,200');
});

test('depth is shown in k and M like the mockup', () => {
  assert.equal(depth(22_000), '$22k');
  assert.equal(depth(41_400), '$41k');
  assert.equal(depth(1_240_000), '$1.2M');
  assert.equal(depth(3_800_000), '$3.8M');
  assert.equal(depth(850), '$850');
});

test('durations', () => {
  assert.equal(hours(23), '23 h');
  assert.equal(hours(47.4), '47 h');
  assert.equal(hours(47.6), '2 d');
  assert.equal(hours(74), '3 d 2 h');
  assert.equal(duration((2 * 24 + 14) * 3_600_000), '2 d 14 h');
  assert.equal(duration(6 * 3_600_000), '6 h');
  assert.equal(duration(35 * 60_000), '35 min');
  assert.equal(duration(48 * 3_600_000), '2 d');
});

test('dates are UTC, whatever zone the machine is in', () => {
  const t = Date.UTC(2026, 9, 24, 23, 41, 7);
  assert.equal(dayMonth(t), '24 Oct');
  assert.equal(dayMonthTime(t), '24 Oct 23:41');
});

test('venue names, lists and sentences', () => {
  assert.equal(venueName('hyperliquid'), 'Hyperliquid');
  assert.equal(venueName('dydx'), 'dYdX');
  assert.equal(venueName('lighter'), 'Lighter');
  assert.equal(list(['Phoenix']), 'Phoenix');
  assert.equal(list(['Phoenix', 'Lighter']), 'Phoenix and Lighter');
  assert.equal(list(['A', 'B', 'C']), 'A, B and C');
  assert.equal(sentence('no trusted price'), 'no trusted price.');
  assert.equal(sentence('Already a sentence.'), 'Already a sentence.');
});
