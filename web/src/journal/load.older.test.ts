// Paging the Journal back: `GET /state` gave the newest 100, and `GET /journal?before=<id>` gives each older page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '@gimbal/shared';
import { JOURNAL_PAGE } from '../stream/api.ts';
import { INITIAL_LOAD, hasMore, reduceLoad, type LoadState } from './load.ts';

const entry = (i: number): JournalEntry => ({ id: `e${i}`, t: 1_000_000 - i, kind: 'funding', summary: `entry ${i}`, numbers: {}, tx: [] });
/** `count` entries, newest first, starting at number `from`. */
const page = (from: number, count: number): JournalEntry[] => Array.from({ length: count }, (_, i) => entry(from + i));

const ready = (entries: JournalEntry[]): LoadState => reduceLoad(INITIAL_LOAD, { kind: 'ready', entries });
const loading = (state: LoadState): LoadState => reduceLoad(state, { kind: 'older-start' });

test('the engine’s page size is 100, and only a full page may be followed by another', () => {
  assert.equal(JOURNAL_PAGE, 100);
  assert.equal(hasMore(page(0, 100)), true);
  assert.equal(hasMore(page(0, 99)), false);
  assert.equal(hasMore([]), false);
  assert.equal(ready(page(0, 100)).more, true);
  assert.equal(ready(page(0, 12)).more, false);
  assert.equal(INITIAL_LOAD.more, false);
});

test('an older page is added after the entries held, in the engine’s order, and shows another may follow', () => {
  let s = ready(page(0, 100));
  s = loading(s);
  assert.equal(s.older.status, 'loading');
  s = reduceLoad(s, { kind: 'older-ready', entries: page(100, 100) });
  assert.equal(s.entries.length, 200);
  assert.equal(s.entries[100]?.id, 'e100');
  assert.equal(s.entries.at(-1)?.id, 'e199');
  assert.deepEqual([s.older.status, s.older.paged, s.more], ['idle', true, true]);

  // a short page is the last: nothing older is left
  s = reduceLoad(loading(s), { kind: 'older-ready', entries: page(200, 37) });
  assert.equal(s.entries.length, 237);
  assert.deepEqual([s.older.paged, s.more], [true, false]);
  // and with nothing more, asking again changes nothing
  assert.equal(loading(s), s);
});

test('an empty page ends it, and an entry already held is not listed twice', () => {
  let s = reduceLoad(loading(ready(page(0, 100))), { kind: 'older-ready', entries: [] });
  assert.deepEqual([s.entries.length, s.more, s.older.paged], [100, false, true]);

  s = reduceLoad(loading(ready(page(0, 100))), { kind: 'older-ready', entries: [entry(98), entry(99), entry(100)] });
  assert.deepEqual(s.entries.map((e) => e.id).slice(97), ['e97', 'e98', 'e99', 'e100']);
});

test('a page that fails changes nothing shown, says why, and can be asked for again', () => {
  const held = ready(page(0, 100));
  let s = reduceLoad(loading(held), { kind: 'older-error', error: 'GET /journal: 503' });
  assert.equal(s.entries, held.entries);
  assert.deepEqual([s.older.status, s.older.error, s.more], ['error', 'GET /journal: 503', true]);
  s = loading(s);
  assert.deepEqual([s.older.status, s.older.error], ['loading', null]);
  s = reduceLoad(s, { kind: 'older-ready', entries: page(100, 5) });
  assert.deepEqual([s.older.status, s.entries.length, s.more], ['idle', 105, false]);
});

test('only one page is on its way at a time, and a page nobody asked for is dropped', () => {
  const s = loading(ready(page(0, 100)));
  assert.equal(loading(s), s);
  const idle = ready(page(0, 100));
  assert.equal(reduceLoad(idle, { kind: 'older-ready', entries: page(100, 100) }), idle);
  assert.equal(reduceLoad(idle, { kind: 'older-error', error: 'x' }), idle);
  // nothing to page before the first read has worked
  assert.equal(loading(INITIAL_LOAD), INITIAL_LOAD);
});

test('reading the newest entries again starts the paging over: a restarted engine does not hold the old pages', () => {
  const paged = reduceLoad(loading(ready(page(0, 100))), { kind: 'older-ready', entries: page(100, 100) });
  const again = reduceLoad(paged, { kind: 'ready', entries: page(1000, 100) });
  assert.equal(again.entries.length, 100);
  assert.deepEqual([again.older.paged, again.older.status, again.more], [false, 'idle', true]);
  // a page that was on its way when that happened has nowhere to land
  const midway = loading(ready(page(0, 100)));
  const reread = reduceLoad(midway, { kind: 'ready', entries: page(1000, 100) });
  assert.equal(reduceLoad(reread, { kind: 'older-ready', entries: page(100, 100) }), reread);
});
