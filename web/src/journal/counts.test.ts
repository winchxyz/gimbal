import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalCounts, JournalEntry } from '@gimbal/shared';
import { journalAnswer, parseJournalCounts, trueCounts, withEntry } from './counts.ts';

let n = 0;
const entry = (kind: JournalEntry['kind'], t = 1_000, numbers: JournalEntry['numbers'] = {}): JournalEntry => ({ id: `c${(n += 1)}`, t, kind, summary: kind, numbers, tx: [] });

const ENGINE: JournalCounts = {
  entries: 4_812,
  since: 500,
  kinds: { enter: 3, exit: 2, funding: 64, deposit: 1, wait: 4_700, refused: 40, veto: 2, error: 3 },
  refusedHeld: 1,
  refusedCancelled: 4,
};

test('the counters are the engine’s, over every entry it holds, not the 100 on the page', () => {
  // The bug: the newest 100 entries were all hold checks, so the page said "Trades 0" and "0 actions signed".
  const page = Array.from({ length: 100 }, (_, i) => entry('wait', 10_000 - i));
  const loaded = trueCounts(null, page);
  assert.equal(loaded.filters.trades, 0);
  assert.equal(loaded.complete, false);
  const c = trueCounts(ENGINE, page);
  assert.equal(c.filters.all, 4_812);
  assert.equal(c.filters.trades, 5);
  assert.equal(c.filters.funding, 64);
  assert.equal(c.filters.money, 1);
  assert.equal(c.filters.refused, 42);
  assert.equal(c.signed, 6, 'enter, exit and the deposit were signed by the contract');
  assert.equal(c.refused, 35, 'a held risk check and a cancelled act are not policy refusals');
  assert.equal(c.vetoed, 2);
  assert.equal(c.held, 1);
  assert.equal(c.incidents, 3, 'every error the engine holds is an incident');
  assert.equal(trueCounts(null, [entry('error'), entry('wait')]).incidents, 1);
  assert.equal(c.since, 500);
  assert.equal(c.complete, true);
});

test('a new entry on the stream adds to the counts', () => {
  const next = withEntry(withEntry(ENGINE, entry('exit', 9_000)), entry('refused', 9_100, { held: 1 }));
  assert.equal(next.entries, 4_814);
  assert.equal(next.kinds.exit, 3);
  assert.equal(next.refusedHeld, 2);
  assert.equal(ENGINE.kinds.exit, 2, 'the old counts are not changed');
  assert.equal(withEntry({ entries: 0, since: null, kinds: {}, refusedHeld: 0, refusedCancelled: 0 }, entry('funding', 42)).since, 42);
});

test('counts from an engine are checked; an older engine without them gives null', () => {
  assert.deepEqual(parseJournalCounts(ENGINE), ENGINE);
  assert.equal(parseJournalCounts(undefined), null);
  assert.equal(parseJournalCounts({ ...ENGINE, entries: -1 }), null);
  assert.deepEqual(parseJournalCounts({ ...ENGINE, kinds: { enter: 2, nonsense: 9, exit: 'x' } })?.kinds, { enter: 2 });
});

test('the sentence counts what the contract signed, from the true counts', () => {
  assert.equal(journalAnswer(trueCounts(ENGINE, []), false), '6 actions signed by the contract. None by a private key.');
  assert.equal(journalAnswer({ signed: 1 }, false), '1 action signed by the contract. None by a private key.');
  assert.equal(journalAnswer({ signed: 1_204 }, true), '1,204 simulated actions. Nothing signed or sent.');
  // Counted over the loaded page only: the sentence names no total.
  assert.equal(journalAnswer(trueCounts(null, [entry('wait')]), false), 'No action of this desk was signed by a private key.');
});
