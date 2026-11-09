import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JournalEntry } from '@gimbal/shared';
import { countJournal, emptyCounts } from './journal-counts.ts';
import { DEFAULT_STRATEGY } from './scanner/config.ts';
import type { Scanner } from './scanner/scanner.ts';
import { EngineServer } from './server.ts';

let n = 0;
const entry = (kind: JournalEntry['kind'], t: number, numbers: JournalEntry['numbers'] = {}): JournalEntry => ({
  id: `e${(n += 1)}`, t, kind, summary: kind, numbers, tx: [],
});

test('counts by kind, with the oldest time, and the two refusals that are not sizing or policy apart', () => {
  const c = countJournal([
    entry('enter', 300),
    entry('funding', 200),
    entry('funding', 250),
    entry('refused', 150),
    entry('refused', 140, { held: 1 }),
    entry('refused', 130, { cancelled: '1' }),
    entry('wait', 100),
  ]);
  assert.equal(c.entries, 7);
  assert.equal(c.since, 100);
  assert.deepEqual(c.kinds, { enter: 1, funding: 2, refused: 3, wait: 1 });
  assert.equal(c.refusedHeld, 1);
  assert.equal(c.refusedCancelled, 1);
  assert.deepEqual(countJournal([]), emptyCounts());
});

test('what was dropped is added, and neither input changes', () => {
  const dropped = countJournal([entry('exit', 10)]);
  const c = countJournal([entry('exit', 50), entry('enter', 40)], dropped);
  assert.equal(c.entries, 3);
  assert.equal(c.since, 10);
  assert.deepEqual(c.kinds, { exit: 2, enter: 1 });
  assert.deepEqual(dropped.kinds, { exit: 1 });
});

test('GET /state counts every entry the server holds, not the newest page, and keeps counting what it drops', () => {
  const history = Array.from({ length: 5_100 }, (_, i) => entry(i % 2 === 0 ? 'funding' : 'enter', 1_000 + i));
  // Newest first, as the journal file hands them back.
  history.reverse();
  const server = new EngineServer({
    mode: 'replay', scanner: {} as Scanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, log: () => {}, journalHistory: [],
  });
  for (const e of [...history].reverse()) server.publish({ type: 'journal', data: e });
  const state = server.state();
  assert.equal(state.journal.length, 100, 'the page is still the newest 100');
  assert.equal(state.journalCounts?.entries, 5_100, 'the 100 entries past what memory keeps are still counted');
  assert.equal(state.journalCounts?.kinds.funding, 2_550);
  assert.equal(state.journalCounts?.kinds.enter, 2_550);
  assert.equal(state.journalCounts?.since, 1_000);
  // An entry published again under its id replaces the older copy: it is not counted twice.
  server.publish({ type: 'journal', data: history[0]! });
  assert.equal(server.state().journalCounts?.entries, 5_100);
});
