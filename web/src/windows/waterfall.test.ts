import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepValue, waterfall } from './waterfall.ts';
import { win } from './testing.ts';

test('gross, four costs, net: in that order, with the engine numbers', () => {
  const wf = waterfall(win({ grossAprPct: 11.9, netAprPct: 8.6 }), 1200);
  assert.deepEqual(wf.steps.map((s) => s.key), ['gross', 'fees', 'slippage', 'basis', 'reserve', 'net']);
  assert.deepEqual(wf.steps.map((s) => s.value), [11.9, 1.6, 0.6, 0.3, 0.8, 8.6]);
  assert.equal(wf.steps[2]?.label, 'Slippage at $1,200');
  assert.ok(Math.abs(wf.gap) < 1e-9, 'gross - costs = net');
});

test('both bars share one scale and the second adds up to the first', () => {
  const wf = waterfall(win({ grossAprPct: 11.9, netAprPct: 8.6 }), 1200);
  assert.equal(wf.grossWidth, 100);
  const total = wf.parts.reduce((sum, p) => sum + p.width, 0);
  assert.ok(Math.abs(total - 100) < 1e-9);
  assert.equal(wf.parts[0]?.key, 'net');
});

test('costs above the gross leave no net to draw, and the gross bar is the shorter one', () => {
  const wf = waterfall(
    win({ grossAprPct: 1.6, netAprPct: -2.4, costs: { feesPct: 1.6, slippagePct: 0.4, basisPct: 0.3, rescueReservePct: 1.7 } }),
    1200,
  );
  assert.ok(wf.parts.every((p) => p.key !== 'net'));
  assert.ok(wf.grossWidth < 100);
  assert.ok(Math.abs(wf.parts.reduce((s, p) => s + p.width, 0) - 100) < 1e-9);
});

test('zero costs are left out of the bar, and the label names no size until the strategy is known', () => {
  const wf = waterfall(win({ costs: { feesPct: 1, slippagePct: 0, basisPct: 0, rescueReservePct: 0 }, grossAprPct: 4, netAprPct: 3 }), null);
  assert.deepEqual(wf.parts.map((p) => p.key), ['net', 'fees']);
  assert.equal(wf.steps[2]?.label, 'Slippage');
});

test('step values show one sign: a negative gross is not "+−"', () => {
  assert.equal(stepValue('gross', 18.4), '+18.4%');
  assert.equal(stepValue('gross', -194.3), '−194.3%');
  assert.equal(stepValue('gross', 0), '0.0%');
  assert.equal(stepValue('fees', 1.9), '−1.9%'); // a cost
  assert.equal(stepValue('basis', -0.7), '+0.7%'); // a cost that came out negative is a gain
  assert.equal(stepValue('reserve', 0), '0.0%');
  assert.equal(stepValue('net', -3.2), '−3.2%');
  assert.equal(stepValue('net', 13.8), '13.8%');
});
