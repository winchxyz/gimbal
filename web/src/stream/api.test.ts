import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJournal } from './api.ts';

const entry = {
  id: 'e1',
  t: 1_000,
  kind: 'enter',
  summary: 'Opened DOGE',
  why: 'spread held',
  numbers: { usd: -1.47, symbol: 'DOGE' },
  tx: [{ chain: 'near', id: 'x', url: 'https://nearblocks.io/txns/x' }],
};

test('the journal of GET /state is read entry by entry, and an optional reason may be missing', () => {
  const { why: _why, ...bare } = entry;
  assert.deepEqual(parseJournal({ journal: [entry, bare] }), [entry, bare]);
  assert.deepEqual(parseJournal({ mode: 'replay', journal: [], at: 1 }), []);
});

test('anything that is not an entry is named, so the screen can say what was wrong', () => {
  assert.throws(() => parseJournal(null), /not an object/);
  assert.throws(() => parseJournal({}), /journal is not an array/);
  assert.throws(() => parseJournal({ journal: [1] }), /journal\[0\] is not an object/);
  assert.throws(() => parseJournal({ journal: [{ ...entry, id: '' }] }), /has no id/);
  assert.throws(() => parseJournal({ journal: [{ ...entry, t: 'yesterday' }] }), /has no time/);
  assert.throws(() => parseJournal({ journal: [{ ...entry, kind: 'teleport' }] }), /unknown kind/);
  assert.throws(() => parseJournal({ journal: [{ ...entry, kind: 'toString' }] }), /unknown kind/);
  assert.throws(() => parseJournal({ journal: [{ ...entry, summary: 4 }] }), /no summary/);
  assert.throws(() => parseJournal({ journal: [{ ...entry, why: 4 }] }), /why that is not text/);
  assert.throws(() => parseJournal({ journal: [{ ...entry, numbers: null }] }), /no numbers/);
  assert.throws(() => parseJournal({ journal: [{ ...entry, numbers: { usd: true } }] }), /number named usd/);
  assert.throws(() => parseJournal({ journal: [entry, { ...entry, tx: 'x' }] }), /journal\[1\] has no transactions list/);
  assert.throws(() => parseJournal({ journal: [{ ...entry, tx: [{ chain: 'ethereum', id: 'x', url: 'https://x' }] }] }), /without chain, id and url/);
  assert.throws(() => parseJournal({ journal: [{ ...entry, tx: [{ chain: 'near', id: 'x' }] }] }), /without chain, id and url/);
});

test('every kind the shared type lists is accepted', () => {
  for (const kind of ['window', 'enter', 'exit', 'rotate', 'rescue', 'refused', 'veto', 'adl', 'error', 'funding', 'deposit', 'withdraw', 'fee']) {
    assert.equal(parseJournal({ journal: [{ ...entry, kind }] })[0]?.kind, kind);
  }
});
