import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentence } from './text.ts';

test('a lower layer’s message reads as a sentence', () => {
  assert.equal(sentence('the engine did not answer'), 'The engine did not answer.');
  assert.equal(sentence('  Already a sentence.  '), 'Already a sentence.');
  assert.equal(sentence('Wallet closed?'), 'Wallet closed?');
  assert.equal(sentence(''), '');
});
