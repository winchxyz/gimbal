import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '@gimbal/shared';
import { INITIAL_LOAD, reduceLoad } from './load.ts';

const entry: JournalEntry = { id: 'a', t: 1, kind: 'funding', summary: 'Funding paid', numbers: {}, tx: [] };

test('the page is loading until the first read ends, and a read that works is ready, with or without entries', () => {
  assert.equal(INITIAL_LOAD.status, 'loading');
  const ready = reduceLoad(INITIAL_LOAD, { kind: 'ready', entries: [entry] });
  assert.deepEqual([ready.status, ready.entries, ready.error], ['ready', [entry], null]);
  assert.equal(reduceLoad(INITIAL_LOAD, { kind: 'ready', entries: [] }).status, 'ready');
});

test('a first read that fails says what failed and when; trying again goes back to loading', () => {
  const failed = reduceLoad(INITIAL_LOAD, { kind: 'error', error: 'GET /state: 503', at: 1234 });
  assert.deepEqual([failed.status, failed.error, failed.failedAt], ['error', 'GET /state: 503', 1234]);
  assert.equal(reduceLoad(failed, { kind: 'start' }).status, 'loading');
  assert.equal(reduceLoad(failed, { kind: 'start' }).error, null);
  assert.equal(reduceLoad(failed, { kind: 'ready', entries: [entry] }).status, 'ready');
});

test('a refresh that fails after one that worked keeps the entries and stays ready', () => {
  const ready = reduceLoad(INITIAL_LOAD, { kind: 'ready', entries: [entry] });
  assert.equal(reduceLoad(ready, { kind: 'error', error: 'timeout', at: 5 }), ready);
  assert.equal(reduceLoad(ready, { kind: 'start' }), ready);
  assert.equal(reduceLoad(INITIAL_LOAD, { kind: 'start' }), INITIAL_LOAD);
});
