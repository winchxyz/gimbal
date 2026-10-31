import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceNotice } from './notice.ts';

test('a note shows, a new one replaces it with a new id, and clearing removes it', () => {
  const first = reduceNotice(null, { kind: 'show', text: 'Closing is not connected yet.' });
  assert.deepEqual(first, { id: 1, title: 'Not sent', text: 'Closing is not connected yet.', tone: 'warn' });
  // the same text pressed again is a new note, so its timer restarts
  assert.deepEqual(reduceNotice(first, { kind: 'show', text: 'Closing is not connected yet.' }), {
    id: 2,
    title: 'Not sent',
    text: 'Closing is not connected yet.',
    tone: 'warn',
  });
  assert.equal(reduceNotice(first, { kind: 'clear' }), null);
  assert.equal(reduceNotice(null, { kind: 'clear' }), null);
});

test('a note can carry its own title and a plain tone, for what the engine accepted', () => {
  assert.deepEqual(reduceNotice(null, { kind: 'show', text: 'The engine closes both legs.', title: 'Sent', tone: 'ok' }), {
    id: 1,
    title: 'Sent',
    text: 'The engine closes both legs.',
    tone: 'ok',
  });
});
