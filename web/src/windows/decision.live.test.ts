// The decision line once the engine's strategy and the engine's own refusals are real: auto off, and no desk loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './decision.ts';
import { STRATEGY, net } from './testing.ts';

const NOW = Date.UTC(2026, 9, 27, 14, 0);
const heldSince = NOW - (2 * 24 + 14) * 3_600_000;
const doge = net('DOGE', 13.8, { held: { since: heldSince }, usdPerDayPer1k: 0.38 });
const sol = net('SOL', 8.6, { switchCostUsd: 1.1, usdPerDayPer1k: 0.24 });
const off = { ...STRATEGY, auto: false };

test('auto off: the line says the engine will not move by itself, and the manual buttons stay', () => {
  const heldLine = decide({ selected: doge, windows: [doge, sol], strategy: off, now: NOW });
  assert.equal(heldLine.text, 'Held since 25 Oct 00:00 UTC · 2 d 14 h. Auto is off, so the engine will not exit or rotate it by itself.');
  assert.equal(heldLine.close, true);

  const lower = decide({ selected: sol, windows: [doge, sol], strategy: off, now: NOW });
  assert.equal(lower.text, 'Auto is off, so DOGE stays until you act: SOL is 5.2 points lower. Switching now costs about $1.10.');
  assert.equal(lower.rotate?.to.symbol, 'SOL');

  const better = net('NEAR', 15.8, { switchCostUsd: 1.1, usdPerDayPer1k: 0.43 });
  assert.match(decide({ selected: better, windows: [doge, better], strategy: off, now: NOW }).text, / Auto is off, so nothing rotates unless you do\.$/);

  const nothingHeld = decide({ selected: sol, windows: [sol], strategy: off, now: NOW });
  assert.equal(nothingHeld.text, 'Nothing is held. Auto is off, so the desk only watches and rescues; it enters nothing by itself.');
  assert.equal(nothingHeld.rotate, null);
});

test('no desk loaded: the line says so in plain words and offers no way to enter', () => {
  const noDesk = net('SOL', 8.6, { refused: { code: 'E_NO_DESK', reason: 'no desk policy loaded yet' } });
  const d = decide({ selected: noDesk, windows: [noDesk], strategy: STRATEGY, now: NOW });
  assert.equal(d.text, 'No desk is loaded, so nothing can be entered, by auto or by hand. Pairs open for entry once a desk exists.');
  assert.equal(d.rotate, null);
  assert.equal(d.alert, null);
  assert.equal(d.close, false);
  assert.doesNotMatch(d.text, /contract would refuse|policy/i);
});
