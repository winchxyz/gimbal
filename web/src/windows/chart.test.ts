import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axes, dateLabels, domainOf, niceScale, polyline, sparkline } from './chart.ts';

test('the usual window gets the mockup grid: 0, 5, 10, 15, 20', () => {
  const s = niceScale([4, 9, 13.8, 17], 5);
  assert.deepEqual(s.ticks, [0, 5, 10, 15, 20]);
  assert.equal(s.max, 20);
  assert.equal(s.min, 0);
});

test('the grid widens for a high window and drops below zero for a negative one', () => {
  assert.deepEqual(niceScale([22, 35.2, 39.3], 5).ticks, [0, 10, 20, 30, 40]);
  assert.deepEqual(niceScale([-4, -2.4, 2], 5).ticks, [-5, 0, 5, 10, 15, 20]);
  // a flat line near zero still gets the usual grid up to 20%
  assert.deepEqual(niceScale([0.2, 0.4], null).ticks, [0, 5, 10, 15, 20]);
});

test('the minimum is always inside the grid', () => {
  const s = niceScale([1, 2], 12);
  assert.ok(s.max >= 12);
});

test('axes map time and APR into the plot, keeping the right gutter for labels', () => {
  const scale = niceScale([0, 20], 5);
  const ax = axes({ width: 688, height: 168, domain: [1000, 2000], scale, minimum: 5 });
  assert.equal(ax.plotRight, 640);
  assert.equal(ax.x(1000), 0);
  assert.equal(ax.x(2000), 640);
  assert.equal(ax.y(20), 8); // top of the plot
  assert.equal(ax.y(0), 8 + (168 - 28)); // bottom of the plot, above the date labels
  assert.equal(ax.minimumY, ax.y(5));
  assert.deepEqual(ax.grid.map((g) => g.value), [0, 5, 10, 15, 20]);
});

test('polyline and the shared time domain', () => {
  const a = { windowId: 'a', points: [{ t: 0, netAprPct: 0 }, { t: 100, netAprPct: 20 }] };
  const b = { windowId: 'b', points: [{ t: 50, netAprPct: 10 }, { t: 150, netAprPct: 10 }] };
  assert.deepEqual(domainOf(a, b), [0, 150]);
  assert.equal(domainOf(null, undefined), null);
  const ax = axes({ width: 148, height: 100, domain: [0, 100], scale: niceScale([0, 20], null), minimum: null });
  assert.equal(polyline(a.points, ax), `0.0,${ax.y(0).toFixed(1)} 100.0,${ax.y(20).toFixed(1)}`);
});

test('date labels: start, middle and now', () => {
  const t0 = Date.UTC(2026, 9, 20, 12);
  const t1 = Date.UTC(2026, 9, 27, 12);
  assert.deepEqual(dateLabels([t0, t1]), ['20 Oct', '24 Oct', 'now']);
});

test('a sparkline stays inside its box and ends at the newest value', () => {
  const points = Array.from({ length: 168 }, (_, i) => ({ netAprPct: i < 167 ? 5 : 9 }));
  const coords = sparkline(points, 88, 24).split(' ').map((p) => p.split(',').map(Number));
  assert.ok(coords.length <= 28);
  for (const [x, y] of coords) {
    assert.ok(x! >= 2 && x! <= 86, `x ${x}`);
    assert.ok(y! >= 2 && y! <= 22, `y ${y}`);
  }
  assert.equal(coords.at(-1)![1], 2); // the last value is the highest: top of the box
  assert.equal(coords[0]![1], 22);
  assert.equal(sparkline([], 88, 24), '');
});
