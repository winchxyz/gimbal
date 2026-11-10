import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketMeans, clamp, corridor, fitText, linear, niceStep, rateExtent, stepByTime, stepPath, ticksOf } from './scale.ts';

test('a straight scale maps its domain onto pixels, and a flat domain does not divide by zero', () => {
  const x = linear([0, 50], [100, 600]);
  assert.equal(x(0), 100);
  assert.equal(x(25), 350);
  assert.equal(x(50), 600);
  assert.equal(linear([5, 5], [0, 10])(5), 0);
  assert.equal(clamp(12, 0, 10), 10);
});

test('steps are round: 1, 2, 2.5 or 5 times a power of ten', () => {
  assert.equal(niceStep(100, 5), 20);
  assert.equal(niceStep(43, 6), 10);
  assert.equal(niceStep(12, 6), 2);
  assert.equal(niceStep(1.1, 6), 0.2);
  assert.equal(niceStep(0, 6), 1);
  assert.deepEqual(ticksOf(-10, 20, 10), [-10, 0, 10, 20]);
  assert.deepEqual(ticksOf(0.1, 0.5, 0.2), [0.2, 0.4]);
  assert.deepEqual(ticksOf(5, 1, 1), []);
});

test('a scale for rates starts at zero, reaches the floor, and takes in what is under zero', () => {
  assert.deepEqual(rateExtent([3, 7]), { lo: 0, hi: 10, step: 2, ticks: [0, 2, 4, 6, 8, 10] });
  const wide = rateExtent([-12, 43]);
  assert.equal(wide.lo, -20);
  assert.equal(wide.hi, 50);
  assert.equal(wide.step, 10);
  assert.deepEqual(rateExtent([]).ticks, [0, 2, 4, 6, 8, 10]);
});

test('the first wording that fits is used; the last when none does', () => {
  const texts = ['watched from 0.01866', 'watched', 'w'];
  assert.equal(fitText(texts, 300), 0);
  assert.equal(fitText(texts, 100), 1);
  assert.equal(fitText(texts, 20), 2);
});

test('the corridor puts the watch and rescue lines where a leg would be that far from its liquidation price', () => {
  const c = corridor(80, 60, { watchDistancePct: 15, rescueDistancePct: 8 });
  assert.equal(c.lo, -80);
  assert.equal(c.hi, 60);
  // The long is liquidated 80% under now: it is 15% from that price once the coin is 76.5% down, not 65%.
  assert.equal(Number(c.longWatch.toFixed(2)), -76.47);
  assert.equal(Number(c.longRescue.toFixed(2)), -78.26);
  assert.equal(Number(c.shortWatch.toFixed(2)), 39.13);
  assert.equal(Number(c.shortRescue.toFixed(2)), 48.15);
  // A leg already inside its zone: the zone stops at now.
  const tight = corridor(10, 5, { watchDistancePct: 15, rescueDistancePct: 8 });
  assert.equal(tight.longWatch, 0);
  assert.equal(tight.shortWatch, 0);
  assert.equal(tight.shortRescue, 0);
});

test('hourly values are squeezed into buckets by their mean, and drawn as steps', () => {
  assert.deepEqual(bucketMeans([1, 3, 5, 7], 2), [2, 6]);
  assert.deepEqual(bucketMeans([1, 2], 4), [1, 2]);
  assert.equal(stepPath([1, 2], (i) => i * 10, (v) => v), 'M0.0 1.0H10.0L10.0 2.0H20.0');
  assert.equal(stepPath([1, 2, 3], (i) => i * 10, (v) => v, 1, 2), 'M10.0 2.0H20.0');
});

test('timed values step at their own times: a gap in the record is drawn as long as it lasted', () => {
  const H = 3_600_000;
  const x = (t: number): number => t / H;
  const points = [{ t: 0, v: 1 }, { t: H, v: 2 }, { t: 4 * H, v: 3 }];
  // The second value holds for the three hours until the next reading; the last one for an hour.
  assert.equal(stepByTime(points, x, (v) => v), 'M0.0 1.0H1.0L1.0 2.0H4.0L4.0 3.0H5.0');
  // Cut to a span: only the part inside it, starting and ending at its edges.
  assert.equal(stepByTime(points, x, (v) => v, 2 * H, 4.5 * H), 'M2.0 2.0H4.0L4.0 3.0H4.5');
  assert.equal(stepByTime(points, x, (v) => v, 9 * H), '');
  assert.equal(stepByTime([], x, (v) => v), '');
});
