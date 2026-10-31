import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceNotice } from './notice.ts';

test('a note shows, a new one replaces it with a new id, and clearing removes it', () => {
  const first = reduceNotice(null, { kind: 'show', text: 'Closing is not connected yet.' });
  assert.deepEqual(first, { id: 1, text: 'Closing is not connected yet.' });
  // the same text pressed again is a new note, so its timer restarts
  assert.deepEqual(reduceNotice(first, { kind: 'show', text: 'Closing is not connected yet.' }), { id: 2, text: 'Closing is not connected yet.' });
  assert.equal(reduceNotice(first, { kind: 'clear' }), null);
  assert.equal(reduceNotice(null, { kind: 'clear' }), null);
});
