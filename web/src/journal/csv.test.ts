import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '@gimbal/shared';
import { CSV_HEADER, cell, csvName, isoTime, toCsv } from './csv.ts';
import { entriesIn } from './model.ts';

const entry = (overrides: Partial<JournalEntry>): JournalEntry => ({ id: 'e', t: Date.UTC(2026, 9, 27, 14, 0), kind: 'funding', summary: 'Funding paid', numbers: {}, tx: [], ...overrides });

test('a cell is quoted when it has a comma, a quote or a line break, and quotes are doubled', () => {
  assert.equal(cell('plain'), 'plain');
  assert.equal(cell('a, b'), '"a, b"');
  assert.equal(cell('say "hi"'), '"say ""hi"""');
  assert.equal(cell('two\nlines'), '"two\nlines"');
  assert.equal(cell(''), '');
});

test('text that a spreadsheet would run as a formula gets a leading apostrophe', () => {
  assert.equal(cell('=HYPERLINK("http://x")'), '"\'=HYPERLINK(""http://x"")"');
  assert.equal(cell('+1'), "'+1");
  assert.equal(cell('-2 now'), "'-2 now");
  assert.equal(cell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(cell('\tcmd'), "'\tcmd");
  assert.equal(cell('Funding = fine'), 'Funding = fine');
});

test('the file: a header, then one line per entry, oldest first, amounts as plain numbers', () => {
  const newer = entry({ id: 'b', t: Date.UTC(2026, 9, 27, 14, 0), summary: 'Funding paid, both legs', numbers: { usd: 0.03 }, tx: [{ chain: 'near', id: 'x', url: 'https://nearblocks.io/txns/x' }] });
  const older = entry({ id: 'a', t: Date.UTC(2026, 9, 25, 16, 20), kind: 'withdraw', summary: '$50.00 sent', numbers: { usd: -50, feeUsd: -0.14 }, why: 'owner asked' });
  const lines = toCsv([newer, older]).split('\r\n');
  assert.equal(lines[0], CSV_HEADER.join(','));
  assert.equal(lines[1], '2026-10-25T16:20:00Z,Withdraw,$50.00 sent,-50.00,owner asked,"{""usd"":-50,""feeUsd"":-0.14}",');
  assert.equal(lines[2], '2026-10-27T14:00:00Z,Funding,"Funding paid, both legs",0.03,,"{""usd"":0.03}",near:https://nearblocks.io/txns/x');
  assert.equal(lines[3], '');
  assert.equal(lines.length, 4);
  assert.equal(toCsv([]), `${CSV_HEADER.join(',')}\r\n`);
});

test('the current filter is what is exported', () => {
  const all = [entry({ id: '1', kind: 'veto' }), entry({ id: '2', kind: 'funding' }), entry({ id: '3', kind: 'refused' })];
  const rows = toCsv(entriesIn(all, 'refused')).trim().split('\r\n');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.slice(1).map((r) => r.split(',')[1]), ['Refused', 'Risk check']);
});

test('times are ISO in UTC to the second, and the file is named after the filter and the day', () => {
  assert.equal(isoTime(Date.UTC(2026, 9, 27, 14, 0, 7, 321)), '2026-10-27T14:00:07Z');
  assert.equal(csvName('funding', Date.UTC(2026, 9, 27, 23, 59)), 'gimbal-journal-funding-2026-10-27.csv');
  assert.equal(csvName('all', Date.UTC(2026, 0, 2)), 'gimbal-journal-all-2026-01-02.csv');
});
