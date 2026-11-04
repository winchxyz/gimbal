import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StrategyDecision } from '@gimbal/shared';
import { startFakeStream } from '../stream/fake.ts';
import { fakeDecision } from '../stream/fake-desk.ts';
import { initialStreamState, reduceStream, type StreamAction } from '../stream/store.ts';
import { ACTION_WORDS, decisionLine } from './decision.ts';

const NOW = 1_000_000_000_000;
const decision = (action: StrategyDecision['action'], at = NOW - 3 * 60_000): StrategyDecision => ({
  action,
  reason: 'XLM 14.2 % net, 2 of 3 hours above 10 %',
  windowId: 'xlm',
  heldId: null,
  at,
});

test('every action has its word', () => {
  assert.deepEqual(ACTION_WORDS, {
    off: 'Off',
    wait: 'Waiting',
    enter: 'Entering',
    hold: 'Holding',
    exit: 'Exiting',
    rotate: 'Rotating',
  });
});

test('the line is the word, the engine’s reason as sent, and how long ago', () => {
  assert.deepEqual(decisionLine(decision('enter'), NOW), {
    word: 'Entering',
    reason: 'XLM 14.2 % net, 2 of 3 hours above 10 %',
    raw: 'XLM 14.2 % net, 2 of 3 hours above 10 %',
    when: '3 min ago',
  });
  assert.equal(decisionLine(decision('hold', NOW - 12_000), NOW)?.when, '12 s ago');
  assert.equal(decisionLine(decision('wait', NOW - 2 * 3_600_000), NOW)?.when, '2 h ago');
});

test('a wait or an off line is put in plain words with the engine’s string kept; other actions are shown as sent', () => {
  const raw =
    'No window clears the entry rules; best BONK 14.8 % net: serve opens short hyperliquid, long phoenix only (as pair-mainnet open); bonk-orderly-hyperliquid is long orderly, short hyperliquid';
  const wait = decisionLine({ ...decision('wait'), reason: raw }, NOW, { minNetAprPct: 5 });
  assert.match(wait?.reason ?? '', /^No window clears your 5 % minimum right now\. Closest: BONK, 14\.8 % net, but the desk can't open it/);
  assert.equal(wait?.raw, raw);
  const off = decisionLine({ ...decision('off'), reason: 'Auto is off: the engine watches and you act by hand; x' }, NOW);
  assert.equal(off?.reason, 'Auto is off, so the desk only watches and you act by hand.');
  assert.equal(decisionLine({ ...decision('hold'), reason: raw }, NOW)?.reason, raw);
  assert.equal(decisionLine({ ...decision('wait'), reason: 'something new' }, NOW)?.reason, 'something new');
});

test('no decision, no line; a time ahead of this page’s clock reads as just now', () => {
  assert.equal(decisionLine(null, NOW), null);
  assert.equal(decisionLine(decision('off', NOW + 5_000), NOW)?.when, '0 s ago');
});

test('the dev fake sends a decision the store keeps, and none while the desk is loading', () => {
  const actions: StreamAction[] = [];
  startFakeStream((a) => actions.push(a), { mode: 'mainnet', intervalMs: 60_000, drift: false })();
  const s = actions.reduce(reduceStream, initialStreamState());
  assert.equal(s.decision?.action, 'hold');
  assert.equal(s.counts.decision, 1);
  assert.equal(decisionLine(s.decision, Date.now())?.when, '14 min ago');
  assert.equal(fakeDecision(NOW, 'waiting')?.action, 'wait');
  assert.equal(fakeDecision(NOW, 'loading'), null);
});
