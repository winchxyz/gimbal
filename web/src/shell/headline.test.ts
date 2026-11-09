import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headline, type HeadlineInput } from './headline.ts';

const base: HeadlineInput = {
  source: 'sse',
  connection: 'open',
  mode: 'mainnet',
  checkedAt: 1_000_000,
  heardAt: 1_000_000,
  now: 1_005_000,
  pageNow: 1_005_000,
  problem: null,
  owner: false,
  readOnly: true,
};

test('live: one line with the network and how long ago the numbers were checked', () => {
  const h = headline(base);
  assert.equal(h.tone, 'live');
  assert.equal(h.text, 'Live · mainnet · checked 5 s ago');
  assert.equal(h.short, 'Live · checked 5 s ago');
  assert.match(h.more ?? '', /Read-only for visitors/);
  assert.equal(headline({ ...base, readOnly: false }).more, null);
});

test('the owner, unlocked, is named in the line', () => {
  assert.equal(headline({ ...base, owner: true }).text, 'Live · mainnet · owner · checked 5 s ago');
});

test('a replay and the fake are never called live', () => {
  assert.equal(headline({ ...base, mode: 'replay' }).text, 'Replay · recorded mainnet · checked 5 s ago');
  assert.equal(headline({ ...base, mode: 'replay' }).tone, 'wait');
  assert.equal(headline({ ...base, source: 'fake' }).text, 'Sample data, not live · checked 5 s ago');
});

test('an engine that stopped answering says when it was last read', () => {
  const h = headline({ ...base, connection: 'retrying', pageNow: 1_042_000 });
  assert.equal(h.tone, 'down');
  assert.equal(h.text, 'Engine not answering · last read 42 s ago');
  assert.equal(headline({ ...base, connection: 'retrying', heardAt: null }).text, 'Engine not answering');
});

test('a problem with its own wording wins; before the first answer the line says Connecting', () => {
  const h = headline({ ...base, problem: { title: 'Token not accepted', text: 'Enter it again.' } });
  assert.deepEqual(h, { tone: 'down', text: 'Token not accepted', short: 'Token not accepted', more: 'Enter it again.' });
  assert.equal(headline({ ...base, mode: null, connection: 'connecting' }).text, 'Connecting');
  assert.equal(headline({ ...base, checkedAt: null }).text, 'Live · mainnet');
});

test('the dot: mint live and healthy, amber degraded, coral offline or in danger, grey when nothing is live', () => {
  assert.equal(headline(base).tone, 'live');
  assert.equal(headline({ ...base, degraded: 'watch' }).tone, 'watch');
  assert.equal(headline({ ...base, degraded: 'danger' }).tone, 'down');
  assert.equal(headline({ ...base, connection: 'retrying' }).tone, 'down');
  assert.equal(headline({ ...base, mode: 'replay' }).tone, 'wait');
  assert.equal(headline({ ...base, connection: 'connecting', mode: null }).tone, 'wait');
});
