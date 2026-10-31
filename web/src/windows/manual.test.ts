import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeOf, reasonText } from './manual.ts';

const rotate = { kind: 'rotate', from: 'DOGE', to: 'NEAR', windowId: 'near-phoenix-orderly' } as const;
const close = { kind: 'close', symbol: 'DOGE' } as const;

test('the engine’s reason is shown as a sentence', () => {
  assert.equal(reasonText('the strategy engine is not running yet: nothing is entered or closed'), 'The strategy engine is not running yet: nothing is entered or closed.');
  assert.equal(reasonText('  switch costs more than it earns. '), 'Switch costs more than it earns.');
  assert.equal(reasonText('Already closed!'), 'Already closed!');
});

test('a refusal says what the engine said and that nothing changed', () => {
  const refused = outcomeOf(rotate, { ok: false, reason: 'NEAR is vetoed' });
  assert.deepEqual(refused, { tone: 'refused', title: 'Not sent', text: 'The engine refused it. NEAR is vetoed. DOGE is still held.' });
  assert.equal(outcomeOf(close, { ok: false, reason: 'nothing is held' }).text, 'The engine refused it. Nothing is held. Both DOGE legs are still open.');
  assert.equal(outcomeOf({ kind: 'close', symbol: null }, { ok: false, reason: 'paused' }).text, 'The engine refused it. Paused. Both legs are still open.');
});

test('an accepted request says where the rest of it shows up', () => {
  assert.deepEqual(outcomeOf(rotate, { ok: true }), {
    tone: 'sent',
    title: 'Sent',
    text: 'The engine checks the rotation again, then closes DOGE and opens NEAR. Follow it in the Journal.',
  });
  assert.equal(outcomeOf(close, { ok: true }).text, 'The engine closes both legs with reduce-only orders. Follow it in the Journal.');
});

test('no answer at all does not claim either way', () => {
  const unknown = outcomeOf(close, new Error('POST /close: the engine did not answer'));
  assert.equal(unknown.tone, 'unknown');
  assert.equal(unknown.title, 'No answer');
  assert.match(unknown.text, /cannot tell whether it was sent\. Check the Journal before you try again\.$/);
});
