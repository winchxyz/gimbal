import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, perDayOnLegs } from './decision.ts';
import { STRATEGY, net, win } from './testing.ts';

const NOW = Date.UTC(2026, 9, 27, 14, 0);
const heldSince = NOW - (2 * 24 + 14) * 3_600_000;
const doge = net('DOGE', 13.8, { held: { since: heldSince }, usdPerDayPer1k: 0.38 });
const sol = net('SOL', 8.6, { switchCostUsd: 1.1, usdPerDayPer1k: 0.24 });

test('a lower window than the held one: auto keeps the held one and says what switching costs', () => {
  const d = decide({ selected: sol, windows: [doge, sol], strategy: STRATEGY, now: NOW });
  assert.equal(d.text, 'Auto keeps DOGE: SOL is 5.2 points lower. Switching now costs about $1.10.');
  assert.equal(d.rotate?.to.symbol, 'SOL');
  assert.equal(d.rotate?.costUsd, 1.1);
  assert.equal(d.alert?.over.symbol, 'DOGE');
  assert.equal(d.close, false);
});

test('the held window: since when, for how long, and Close position', () => {
  const d = decide({ selected: doge, windows: [doge, sol], strategy: STRATEGY, now: NOW });
  assert.equal(
    d.text,
    'Held since 25 Oct 00:00 UTC · 2 d 14 h. Auto moves out of it when another window beats it by 3 points of net APR for 4 hours in a row, and exits after 6 hourly checks in a row under your minimum or with the spread flipped.',
  );
  assert.equal(d.close, true);
  assert.equal(d.rotate, null);
  assert.equal(d.alert, null);
});

test('a window above the held one: the numbers, the payback, and whether it clears auto’s rotation rule', () => {
  const better = net('NEAR', 15.8, { switchCostUsd: 1.1, usdPerDayPer1k: 0.43 });
  const d = decide({ selected: better, windows: [doge, better], strategy: STRATEGY, now: NOW });
  // 2.0 points above; extra $0.05 per $1k = $0.06 a day on $1,200 legs; $1.10 / $0.06 is about 18 days
  assert.match(d.text, /^NEAR is 2\.0 points above DOGE\. Switching now costs about \$1\.10\. The extra \$0\.06 a day earns that back in \d+ days\./);
  assert.match(d.text, / That is under auto’s rule of 3 points of net APR for 4 hours in a row, so it stays in DOGE\.$/);
  assert.equal(d.alert, null);
  assert.ok(d.rotate);
  const enough = net('NEAR', 17.8, { switchCostUsd: 1.1, usdPerDayPer1k: 0.5 });
  assert.match(
    decide({ selected: enough, windows: [doge, enough], strategy: STRATEGY, now: NOW }).text,
    / That clears auto’s rule of 3 points of net APR for 4 hours in a row, so it rotates if the gap holds\.$/,
  );
  const half = { ...STRATEGY, rotate: { minGainPts: 2.5, forHours: 1 } };
  assert.match(decide({ selected: enough, windows: [doge, enough], strategy: half, now: NOW }).text, /rule of 2\.5 points of net APR for 1 hour in a row/);
  const noStrategy = decide({ selected: better, windows: [doge, better], strategy: null, now: NOW });
  assert.equal(noStrategy.text, 'NEAR is 2.0 points above DOGE. Switching now costs about $1.10.');
  const noCost = decide({ selected: { ...better, switchCostUsd: null }, windows: [doge, better], strategy: STRATEGY, now: NOW });
  assert.equal(noCost.text, 'NEAR is 2.0 points above DOGE. That is under auto’s rule of 3 points of net APR for 4 hours in a row, so it stays in DOGE.');
});

test('refused windows cannot be rotated into', () => {
  const refused = net('ZRO', 35.2, { refused: { code: 'E_ORACLE_STALE', reason: 'no trusted price' }, switchCostUsd: 1.1 });
  const d = decide({ selected: refused, windows: [doge, refused], strategy: STRATEGY, now: NOW });
  assert.equal(d.text, 'The contract would refuse this window under your policy: no trusted price. Auto will not enter it.');
  assert.equal(d.rotate, null);

  const vetoed = net('AVAX', 9.1, { veto: { verdict: 'veto', reasons: ['one-off spike'], model: 'm', at: 1 } });
  const v = decide({ selected: vetoed, windows: [doge, vetoed], strategy: STRATEGY, now: NOW });
  assert.equal(v.text, 'The NEAR AI risk check refused it: one-off spike. It can only remove a window, so auto will not enter it.');
  assert.equal(v.rotate, null);
  assert.equal(v.alert, null);
});

test('watch-only windows name the venues the desk cannot trade', () => {
  const w = win({ symbol: 'XMR', tradable: false, longVenue: 'lighter', shortVenue: 'hyperliquid' });
  assert.equal(
    decide({ selected: w, windows: [w], strategy: STRATEGY, now: NOW }).text,
    'Watch-only: the desk can’t trade on Lighter. It is shown so you can see where the funding is.',
  );
});

test('nothing held: auto enters the best window that clears the minimum', () => {
  const a = net('SOL', 8.6);
  const b = net('NEAR', 12);
  const c = net('BTC', 2.1);
  // In the engine's order, as the stream sends them: it ranks by the carry it expects, which can differ from net APR.
  const windows = [b, a, c];
  const carryFirst = [a, b, c];
  assert.equal(decide({ selected: b, windows: carryFirst, strategy: STRATEGY, now: NOW }).text, 'Nothing is held. Auto enters SOL first: 8.6% against 12.0% here.');
  assert.equal(decide({ selected: b, windows, strategy: STRATEGY, now: NOW }).text, 'Nothing is held. Auto enters NEAR: it is the best window that clears your 5% minimum. It enters once it has passed 3 hourly checks in a row.');
  assert.equal(decide({ selected: a, windows, strategy: STRATEGY, now: NOW }).text, 'Nothing is held. Auto enters NEAR first: 12.0% against 8.6% here.');
  assert.equal(decide({ selected: c, windows, strategy: STRATEGY, now: NOW }).text, 'Nothing is held. BTC is under your 5% minimum, so auto will not enter it.');
  assert.match(decide({ selected: a, windows, strategy: null, now: NOW }).text, /minimum could not be read/);
  // A window failing an engine check (the carry gate, the open-interest share) is never the one auto enters first,
  // whatever its net; nor is one with stale numbers.
  const gated = net('DOGE', 30, { checks: [{ ok: false, text: '14-day history loading' }] });
  const stale = net('LTC', 25, { stale: true });
  assert.equal(decide({ selected: a, windows: [gated, stale, a, c], strategy: STRATEGY, now: NOW }).text, 'Nothing is held. Auto enters SOL: it is the best window that clears your 5% minimum. It enters once it has passed 3 hourly checks in a row.');
  // Selected, such a window says why auto will not enter it, held window or not.
  assert.equal(decide({ selected: gated, windows: [gated, a], strategy: STRATEGY, now: NOW }).text, 'Nothing is held. Auto will not enter DOGE: 14-day history loading.');
  assert.equal(decide({ selected: stale, windows: [stale, a], strategy: STRATEGY, now: NOW }).text, 'Nothing is held. Auto will not enter LTC: its numbers are from an older read.');
  const holding = net('ETH', 6, { held: { since: NOW - 3_600_000 } });
  const over = decide({ selected: gated, windows: [holding, gated], strategy: STRATEGY, now: NOW });
  assert.equal(over.text, 'ETH stays: auto will not enter DOGE: 14-day history loading.');
  assert.equal(over.rotate, null);
  const none = decide({ selected: a, windows, strategy: STRATEGY, now: NOW });
  assert.equal(none.rotate, null);
  assert.equal(none.close, false);
});

test('"about $X a day on $Y legs" uses the window’s $/day per $1k at the strategy’s leg size', () => {
  assert.ok(Math.abs(perDayOnLegs(sol, 1200) - 0.288) < 1e-9);
  assert.equal(perDayOnLegs(win({ usdPerDayPer1k: 0 }), 1200), 0);
});
