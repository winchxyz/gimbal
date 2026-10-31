// Hourly rates, the 7-day gross and intervalsAbove. Rates are fractions per hour; APR is percentage points a year.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR_MS, RateStore, grossApr7d, hourStart, hoursCovered, intervalsAbove, netAprSeries, round } from './history.ts';

const NOW = Date.UTC(2026, 9, 31, 10, 30);
const CURRENT = Date.UTC(2026, 9, 31, 10);
const LONG = 'phoenix|SOL';
const SHORT = 'hyperliquid|SOL';

/** Books `hours` hourly prints per leg before the current hour, newest first: rate(i) for the hour i hours back. */
function store(hours: number, longRate: (i: number) => number, shortRate: (i: number) => number): RateStore {
  const s = new RateStore();
  for (let i = 1; i <= hours; i++) {
    // The print for the hour starting i hours back is booked at its end, a few ms after the top of the next hour.
    const time = CURRENT - (i - 1) * HOUR_MS + 59;
    s.recordBooked(LONG, [{ time, symbol: 'SOL', ratePerHour: longRate(i), periodHours: 1 }]);
    s.recordBooked(SHORT, [{ time, symbol: 'SOL', ratePerHour: shortRate(i), periodHours: 1 }]);
  }
  return s;
}

test('hours: a print at 10:00:00.059 covers 09:00; an 8 h print at 16:00 covers 08:00 to 15:00', () => {
  assert.equal(hourStart(NOW), CURRENT);
  assert.deepEqual(hoursCovered({ time: CURRENT + 59, periodHours: 1 }), [CURRENT - HOUR_MS]);
  const eight = hoursCovered({ time: Date.UTC(2026, 9, 31, 16), periodHours: 8 });
  assert.equal(eight.length, 8);
  assert.equal(eight[0], Date.UTC(2026, 9, 31, 8));
  assert.equal(eight[7], Date.UTC(2026, 9, 31, 15));
});

test('the store: a booked rate wins over the scanner\'s own read of the same hour; old hours are pruned', () => {
  const s = new RateStore();
  s.recordLive(LONG, NOW, 0.00002);
  assert.equal(s.rate(LONG, CURRENT), 0.00002);
  s.recordBooked(LONG, [{ time: CURRENT + HOUR_MS, symbol: 'SOL', ratePerHour: 0.00003, periodHours: 1 }]);
  assert.equal(s.rate(LONG, CURRENT), 0.00003);
  s.recordLive(LONG, NOW, 0.00009);
  assert.equal(s.rate(LONG, CURRENT), 0.00003);
  assert.equal(s.rate(LONG, CURRENT - HOUR_MS), null);
  assert.equal(s.rate('nobody|X', CURRENT), null);
  s.recordLive(LONG, CURRENT - 200 * HOUR_MS, 0.1);
  s.prune(NOW);
  assert.equal(s.rate(LONG, CURRENT - 200 * HOUR_MS), null);
  assert.equal(s.rate(LONG, CURRENT), 0.00003);
});

test('7-day gross: the mean hourly gross over the 168 hours before this one; null under 90 % coverage', () => {
  // Long 0.00001, short 0.00003 every hour: 0.00002/h = 17.52 % APR.
  const full = store(168, () => 0.00001, () => 0.00003);
  assert.ok(Math.abs(grossApr7d(full, LONG, SHORT, NOW)! - 17.52) < 1e-9);
  // Half the week at 0.00002 gross and half at 0.00004: the mean, 26.28 %.
  const mixed = store(168, () => 0.00001, (i) => (i <= 84 ? 0.00003 : 0.00005));
  assert.ok(Math.abs(grossApr7d(mixed, LONG, SHORT, NOW)! - 26.28) < 1e-9);
  // 90 % of 168 is 151.2 hours, so 152 are needed: 151 is too few, 152 is enough.
  assert.equal(grossApr7d(store(151, () => 0.00001, () => 0.00003), LONG, SHORT, NOW), null);
  assert.ok(grossApr7d(store(152, () => 0.00001, () => 0.00003), LONG, SHORT, NOW) !== null);
  assert.equal(grossApr7d(new RateStore(), LONG, SHORT, NOW), null);
});

test('intervalsAbove: hours in a row, newest first, with net (that hour\'s gross minus today\'s costs) at the minimum', () => {
  // Gross 17.52 % for the last 10 hours, 0 before that; costs 5 %, minimum 5 %: net 12.52 ≥ 5 for 10 hours.
  const s = store(30, () => 0.00001, (i) => (i <= 10 ? 0.00003 : 0.00001));
  assert.equal(intervalsAbove(s, LONG, SHORT, NOW, 20, 5, 5), 11);         // the current hour plus 10
  assert.equal(intervalsAbove(s, LONG, SHORT, NOW, 9, 5, 5), 0);           // the current hour is under: 0
  assert.equal(intervalsAbove(s, LONG, SHORT, NOW, 20, 13, 5), 1);         // 17.52 − 13 = 4.52 < 5: only now
  // A missing hour stops the count.
  assert.equal(intervalsAbove(store(3, () => 0.00001, () => 0.00003), LONG, SHORT, NOW, 20, 5, 5), 4);
  // At most 168.
  assert.equal(intervalsAbove(store(200, () => 0, () => 0.00003), LONG, SHORT, NOW, 30, 0, 0), 168);
});

test('the net series: one point per hour with data, oldest first, the current hour from the live gross', () => {
  const points = netAprSeries(store(3, () => 0.00001, () => 0.00003), LONG, SHORT, NOW, 20, 5);
  assert.deepEqual(points, [
    { t: CURRENT - 3 * HOUR_MS, netAprPct: 12.52 },
    { t: CURRENT - 2 * HOUR_MS, netAprPct: 12.52 },
    { t: CURRENT - HOUR_MS, netAprPct: 12.52 },
    { t: CURRENT, netAprPct: 15 },
  ]);
  assert.equal(netAprSeries(store(300, () => 0, () => 0.00001), LONG, SHORT, NOW, 1, 0).length, 168);
});

test('round: to the given decimals, and never -0', () => {
  assert.equal(round(1.23456, 3), 1.235);
  assert.ok(Object.is(round(-0.0001, 3), 0));
});
