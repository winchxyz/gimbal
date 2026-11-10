import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '@gimbal/shared';
import { collapseWaits, waitText, waitsView } from './waits.ts';

const at = (hh: number, mm: number) => Date.UTC(2026, 10, 4, hh, mm);
const HANDS = 'No window clears the entry rules; best BONK 14.8 % net: serve opens short hyperliquid, long phoenix only (as pair-mainnet open); bonk-orderly-hyperliquid is long orderly, short hyperliquid';

let n = 0;
const entry = (overrides: Partial<JournalEntry>): JournalEntry => ({ id: `e${++n}`, t: at(9, 0), kind: 'funding', summary: 'Funding paid', numbers: {}, tx: [], ...overrides });
const wait = (hh: number, mm: number, summary = HANDS): JournalEntry =>
  entry({ id: `w${hh}${mm}`, t: at(hh, mm), kind: 'wait', summary, numbers: { action: 'wait', minNetAprPct: 5 } });
const idOf = (i: ReturnType<typeof collapseWaits>[number]): string => (i.type === 'entry' ? i.entry.id : i.id);

test('consecutive waits fold into one item, newest first, keyed by the oldest', () => {
  const items = collapseWaits([wait(9, 12), wait(9, 11), wait(9, 10)]);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.type, 'waits');
  if (item.type === 'waits') {
    assert.deepEqual(item.entries.map((e) => e.id), ['w912', 'w911', 'w910']);
    assert.equal(item.id, 'w910');
  }
});

test('the key stays put as a run grows at the top', () => {
  const before = collapseWaits([wait(9, 11), wait(9, 10)]);
  const after = collapseWaits([wait(9, 12), wait(9, 11), wait(9, 10)]);
  assert.equal(idOf(before[0]!), idOf(after[0]!));
});

test('a real event always breaks a run, whatever its kind', () => {
  const kinds = ['enter', 'exit', 'rotate', 'rescue', 'refused', 'veto', 'adl', 'error', 'funding', 'deposit', 'withdraw', 'fee', 'window'] as const;
  for (const kind of kinds) {
    const items = collapseWaits([wait(9, 15), wait(9, 14), entry({ id: 'real', kind, t: at(9, 13) }), wait(9, 12), wait(9, 11)]);
    assert.deepEqual(items.map((i) => i.type), ['waits', 'entry', 'waits'], kind);
  }
});

test('a lone wait is still a wait item, and other entries pass through unchanged and in order', () => {
  const a = entry({ id: 'a', kind: 'enter', t: at(9, 5) });
  const b = entry({ id: 'b', kind: 'refused', t: at(9, 4) });
  const items = collapseWaits([a, wait(9, 3), b]);
  assert.deepEqual(items.map(idOf), ['a', 'w93', 'b']);
  assert.deepEqual(items.map((i) => i.type), ['entry', 'waits', 'entry']);
  assert.equal(collapseWaits([]).length, 0);
});

test('the folded row: latest reason in plain words, since and count, and the raw text kept', () => {
  const entries = [wait(9, 19), wait(9, 18, 'Cooling down after the exit, 1.0 h left; something odd'), wait(9, 7)];
  const v = waitsView(entries);
  assert.equal(v.count, 3);
  assert.equal(v.since, 'Since 09:07, 3 checks');
  assert.match(v.latest.text, /^No market pays your 5 % minimum right now\. Closest: BONK/);
  assert.equal(v.latest.raw, HANDS);
});

test('a single check says no count', () => {
  assert.equal(waitsView([wait(9, 7)]).since, null);
});

test('the owner’s minimum comes from the entry; an entry without it gets the general sentence', () => {
  assert.match(waitText(wait(9, 1)).text, /your 5 % minimum/);
  const bare = entry({ kind: 'wait', summary: HANDS, numbers: {} });
  assert.match(waitText(bare).text, /^No market passes your entry rules right now\./);
});
