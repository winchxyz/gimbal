// The journal on disk: a restart serves what the last run journaled, a torn line is skipped, the bound holds, and
// nothing in it can stop the engine.

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { JournalEntry } from '@gimbal/shared';
import { DEFAULT_STRATEGY } from './scanner/config.ts';
import type { Scanner } from './scanner/scanner.ts';
import { EngineServer } from './server.ts';
import { JOURNAL_FILE_MAX_ENTRIES, JournalStore, journalEntryOf, journalFile, openJournal } from './journal-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'gimbal-journal-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 10, 4, 9, 0);
const DAY_MS = 86_400_000;

function entry(n: number, t = T0 + n * 1000, extra: Partial<JournalEntry> = {}): JournalEntry {
  return { id: `loop-${n}`, t, kind: 'refused', summary: `entry ${n}`, numbers: { n, venue: 'hyperliquid' }, tx: [], ...extra };
}

const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');

/** A server as serve builds it, without listening: the journal side needs no scanner. */
function serverWith(journal: ReturnType<typeof openJournal>): EngineServer {
  return new EngineServer({ mode: 'mainnet', scanner: {} as Scanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, ...journal });
}

test('one file per mode, contract and desk, next to the book; a name that is not safe is refused', () => {
  assert.equal(journalFile(dir, 'mainnet', 'gimbal.near', 'd1'), join(dir, 'journal-mainnet-gimbal.near-d1.jsonl'));
  assert.equal(journalFile(dir, 'testnet', null, null), join(dir, 'journal-testnet.jsonl'));
  assert.throws(() => journalFile(dir, 'mainnet', '../x', 'd1'), /cannot name a journal file/);
});

test('a restart round trip: what one run published, the next serves, in order, with the same ids', () => {
  const sub = join(dir, 'restart');
  const logs: string[] = [];
  const first = serverWith(openJournal('mainnet', sub, 'gimbal.near', 'd1', (l) => logs.push(l)));
  assert.deepEqual(first.state().journal, []);
  for (let n = 1; n <= 150; n++) first.publish({ type: 'journal', data: entry(n) });
  // The refusal that went missing on the redeploy, published last.
  const refusal = entry(151, T0 + 151_000, { summary: 'refused: enter xlm-phoenix-hyperliquid: open refused, nothing signed' });
  first.publish({ type: 'journal', data: refusal });
  assert.equal(lines(journalFile(sub, 'mainnet', 'gimbal.near', 'd1')).length, 151);

  const second = serverWith(openJournal('mainnet', sub, 'gimbal.near', 'd1', (l) => logs.push(l)));
  assert.ok(logs.some((l) => /^journal: 151 entries loaded from .*journal-mainnet-gimbal\.near-d1\.jsonl/.test(l)), logs.join('\n'));
  assert.deepEqual(second.state().journal, first.state().journal);
  assert.deepEqual(second.state().journal[0], refusal);
  // Paging back reaches the oldest, as before the restart.
  assert.deepEqual(second.journalPage('loop-51').map((e) => e.id), ['loop-50', ...Array.from({ length: 49 }, (_, i) => `loop-${49 - i}`)]);
  assert.deepEqual(second.journalPage('loop-1'), []);
  // The remote view reads the same pages.
  assert.deepEqual(second.viewSource().journal(null), second.state().journal);

  // An entry published again under an id it already holds replaces the older copy: one per id, in memory and on disk.
  const again = { ...entry(150), summary: 'entry 150, again' };
  second.publish({ type: 'journal', data: again });
  assert.equal(second.state().journal.filter((e) => e.id === 'loop-150').length, 1);
  assert.equal(second.state().journal[0]!.summary, 'entry 150, again');
  const third = serverWith(openJournal('mainnet', sub, 'gimbal.near', 'd1', () => {}));
  assert.deepEqual(third.state().journal, second.state().journal);
  assert.equal(lines(journalFile(sub, 'mainnet', 'gimbal.near', 'd1')).length, 151, 'the load rewrote the file to one line per id');
});

test('a torn last line (a crash in a write) is skipped, and the next append starts on a line of its own', () => {
  const path = join(dir, 'torn', 'journal-mainnet.jsonl');
  const store = new JournalStore(path, { now: () => T0 });
  store.append(entry(1));
  store.append(entry(2));
  appendFileSync(path, '{"id":"loop-3","t":1793955600000,"kind":"ref');
  const loaded = new JournalStore(path, { now: () => T0 }).load();
  assert.deepEqual(loaded.entries.map((e) => e.id), ['loop-1', 'loop-2']);
  assert.equal(loaded.skipped, 1);
  assert.equal(loaded.problem, null);
  // The load dropped it from the file; an append after it is whole.
  const after = new JournalStore(path, { now: () => T0 });
  after.load();
  after.append(entry(4));
  assert.deepEqual(lines(path).map((l) => (JSON.parse(l) as JournalEntry).id), ['loop-1', 'loop-2', 'loop-4']);

  // Even when nothing cut the torn bytes (no load since a write failed mid-line), the next entry is whole.
  appendFileSync(path, '{"id":"loop-5","t":');
  new JournalStore(path, { now: () => T0 }).append(entry(6));
  const reread = new JournalStore(path, { now: () => T0 }).load();
  assert.deepEqual(reread.entries.map((e) => e.id), ['loop-1', 'loop-2', 'loop-4', 'loop-6']);
});

test('a line that is JSON but not an entry is skipped too; every field the web reads is checked', () => {
  assert.equal(journalEntryOf(entry(1)) !== null, true);
  for (const bad of [null, [], 'x', { ...entry(1), id: '' }, { ...entry(1), t: 'now' }, { ...entry(1), kind: 'party' },
    { ...entry(1), summary: 1 }, { ...entry(1), numbers: [] }, { ...entry(1), numbers: { a: null } }, { ...entry(1), tx: {} }, { ...entry(1), why: 2 }]) {
    assert.equal(journalEntryOf(bad), null, JSON.stringify(bad));
  }
  const path = join(dir, 'mixed', 'journal-testnet.jsonl');
  mkdirSync(join(dir, 'mixed'));
  writeFileSync(path, `${JSON.stringify(entry(1))}\nnot json\n{"id":"x"}\n\n${JSON.stringify(entry(2))}\n`);
  const loaded = new JournalStore(path, { now: () => T0 }).load();
  assert.deepEqual(loaded.entries.map((e) => e.id), ['loop-1', 'loop-2']);
  assert.equal(loaded.skipped, 2);
});

test('the cap holds: the file is rewritten to the newest entries once past cap + slack, and a load keeps the newest', () => {
  assert.equal(JOURNAL_FILE_MAX_ENTRIES, 5_000);
  const path = join(dir, 'cap', 'journal-mainnet.jsonl');
  const store = new JournalStore(path, { now: () => T0, maxEntries: 10, slack: 5 });
  let most = 0;
  for (let n = 1; n <= 40; n++) {
    store.append(entry(n));
    most = Math.max(most, lines(path).length);
  }
  assert.equal(most, 15, 'never more than cap + slack lines');
  const loaded = new JournalStore(path, { now: () => T0, maxEntries: 10, slack: 5 }).load();
  assert.deepEqual(loaded.entries.map((e) => e.id), Array.from({ length: 10 }, (_, i) => `loop-${31 + i}`));
  // No temporary file is left from the rewrites.
  assert.deepEqual(readdirSync(join(dir, 'cap')), ['journal-mainnet.jsonl']);
});

test('the age bound: entries older than 30 days are dropped at load, and the file with them', () => {
  const path = join(dir, 'age', 'journal-mainnet.jsonl');
  const store = new JournalStore(path, { now: () => T0 });
  store.append(entry(1, T0 - 31 * DAY_MS));
  store.append(entry(2, T0 - 29 * DAY_MS));
  store.append(entry(3, T0));
  const loaded = new JournalStore(path, { now: () => T0 }).load();
  assert.deepEqual(loaded.entries.map((e) => e.id), ['loop-2', 'loop-3']);
  assert.equal(loaded.dropped, 1);
  assert.equal(lines(path).length, 2);
});

test('a file that cannot be read starts the journal empty and says why; replay keeps nothing on disk', () => {
  // A directory where the file should be: not readable as a file, and appends fail; neither throws.
  const blocked = journalFile(join(dir, 'blocked'), 'mainnet', 'gimbal.near', 'd1');
  mkdirSync(blocked, { recursive: true });
  const logs: string[] = [];
  const journal = openJournal('mainnet', join(dir, 'blocked'), 'gimbal.near', 'd1', (l) => logs.push(l));
  assert.deepEqual(journal.journalHistory, []);
  assert.ok(logs.some((l) => /^journal: starting empty, .* not read/.test(l)), logs.join('\n'));
  const server = new EngineServer({
    mode: 'mainnet', scanner: {} as Scanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, log: (l) => logs.push(l), ...journal,
  });
  server.publish({ type: 'journal', data: entry(1) });
  server.publish({ type: 'journal', data: entry(2) });
  assert.deepEqual(server.state().journal.map((e) => e.id), ['loop-2', 'loop-1'], 'the entries stay in memory');
  assert.equal(logs.filter((l) => /not written to/.test(l)).length, 1, 'a failing disk is logged once a minute, not per entry');

  const replayLogs: string[] = [];
  assert.deepEqual(openJournal('replay', join(dir, 'replay'), null, null, (l) => replayLogs.push(l)), {});
  assert.throws(() => readdirSync(join(dir, 'replay')), /ENOENT/);
  assert.match(replayLogs[0]!, /memory only in replay/);
  // A contract id that cannot name a file: logged, memory only.
  const unsafe: string[] = [];
  assert.deepEqual(openJournal('mainnet', dir, 'Bad/Id', 'd1', (l) => unsafe.push(l)), {});
  assert.match(unsafe[0]!, /NOT kept on disk/);
});
