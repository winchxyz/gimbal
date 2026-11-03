// The fake Journal must show what the mockup shows, and every entry must pass the engine's own parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '@gimbal/shared';
import { proofLinks } from '../journal/entry.ts';
import { KINDS } from '../journal/kinds.ts';
import { DAYS_SHOWN, countsOf, filterCounts, foldOlder, groupByDay, mergeEntries, pageCounts, rowOf, visibleFeed } from '../journal/model.ts';
import { parseJournal } from './api.ts';
import { fakeDesk, fakeLatest } from './fake-desk.ts';
import { fakeTx } from './fake-explorer.ts';
import { fakeJournal, fakeJournalRead } from './fake-journal.ts';
import { startFakeStream } from './fake.ts';
import { initialStreamState, reduceStream, type StreamAction } from './store.ts';

// the mockup's own clock: 27 Oct 14:02
const T0 = Date.UTC(2026, 9, 27, 14, 2);
const cents = (n: number) => Math.round(n * 100) / 100;

test('the mockup’s four days and their totals, then the eleven earlier events folded into one line', () => {
  const groups = groupByDay(fakeJournal(T0, 'mainnet'), T0);
  assert.deepEqual(groups.slice(0, DAYS_SHOWN).map((g) => [g.label, cents(g.totalUsd), g.entries.length]), [
    ['Today · 27 Oct', 0.03, 3],
    ['26 Oct', 0.21, 2],
    ['25 Oct', -0.08, 2],
    ['24 Oct', -0.35, 2],
  ]);
  const { fold } = foldOlder(groups);
  assert.equal(fold?.range, '21–23 Oct');
  assert.equal(fold?.count, 11);
  assert.equal(fold?.summary, '11 earlier events: 1 deposit, 1 open, 9 funding payments');
});

test('every kind the mockup shows is there, with its reason, steps, flag and links', () => {
  const entries = fakeJournal(T0, 'mainnet');
  const by = (id: string): JournalEntry => entries.find((e) => e.id === id) as JournalEntry;
  assert.equal(rowOf(by('fake-j-veto')).why?.prefix, 'NEAR AI');
  assert.equal(rowOf(by('fake-j-refused')).why?.prefix, null);
  assert.deepEqual(rowOf(by('fake-j-rescue')).steps, ['detected', 'source: reserve', 'quote ✓', 'signed 6.1 s', 'landed 52 s']);
  assert.equal(rowOf(by('fake-latest-rotate')).flag, 'Phoenix leg sent without price protection');
  assert.equal(rowOf(by('fake-j-withdraw')).note, 'fee −$0.14');
  assert.deepEqual(rowOf(by('fake-latest-open')).proofs.map((p) => p.label), ['NEAR', 'Hyperliquid', 'Solscan']);
  assert.equal(rowOf(by('fake-latest-funding')).amount?.text, '+$0.03');
  const counts = filterCounts(entries);
  assert.deepEqual(counts, { all: 20, trades: 3, funding: 12, money: 2, rescue: 1, refused: 2 });
  assert.deepEqual(countsOf(entries), { signed: 6, refused: 1, vetoed: 1 });
});

test('funding adds up to what the fake desk reports as funding received', () => {
  const funding = fakeJournal(T0, 'mainnet')
    .filter((e) => e.kind === 'funding')
    .reduce((sum, e) => sum + Number(e.numbers.usd), 0);
  assert.equal(cents(funding), fakeDesk(T0, 0, { mode: 'mainnet', scenario: 'level', drift: false }).pnl.fundingUsd);
});

test('the newest three are the ones the Desk shows, and nothing is listed twice', () => {
  const entries = fakeJournal(T0, 'mainnet');
  assert.deepEqual(entries.slice(0, 3).map((e) => e.id), ['fake-latest-funding', 'fake-j-veto', 'fake-j-refused']);
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
  for (const latest of fakeLatest(T0, 'level')) assert.ok(entries.some((e) => e.id === latest.id));
  assert.deepEqual(entries.map((e) => e.t), [...entries.map((e) => e.t)].sort((a, b) => b - a));
});

test('links have the shape of the real explorers for the network, and ids are as long as real ones', () => {
  assert.match(fakeTx('near', '9xQe', '4Ta1').url, /^https:\/\/nearblocks\.io\/txns\/9xQe\w{36}4Ta1$/);
  assert.match(fakeTx('near', '9xQe', '4Ta1', 'testnet').url, /^https:\/\/testnet\.nearblocks\.io\/txns\//);
  assert.match(fakeTx('hyperliquid', '88b2', '14d0').url, /^https:\/\/app\.hyperliquid\.xyz\/explorer\/tx\/0x88b2[0-9a-f]{56}14d0$/);
  assert.match(fakeTx('solana', '2rTq', 'kF8m').url, /^https:\/\/solscan\.io\/tx\/2rTq\w{80}kF8m$/);
  assert.match(fakeTx('solana', '2rTq', 'kF8m', 'testnet').url, /\?cluster=devnet$/);
  assert.match(fakeTx('arbitrum', 'ab12', 'cd34').url, /^https:\/\/arbiscan\.io\/tx\/0x/);
  assert.equal(fakeTx('near', '9xQe', '4Ta1').id.length, 44);
  assert.equal(fakeTx('solana', '2rTq', 'kF8m').id.length, 88);
  assert.deepEqual(fakeTx('near', '9xQe', '4Ta1'), fakeTx('near', '9xQe', '4Ta1'));
  // every entry's links open
  for (const e of fakeJournal(T0, 'testnet')) assert.equal(proofLinks(e.tx).length, e.tx.length, e.id);
});

test('the fake entries pass the parser the engine’s read goes through', async () => {
  const read = await fakeJournalRead('normal', 'mainnet')();
  assert.equal(read.length, 20);
  assert.deepEqual(parseJournal({ journal: JSON.parse(JSON.stringify(read)) }), read);
});

test('the page the fake shows (read + stream, rescues on as by default): the header counts exactly the signed entries the filters list', async () => {
  const actions: StreamAction[] = [];
  startFakeStream((a) => actions.push(a), { mode: 'mainnet', intervalMs: 60_000, drift: false, rescue: 'idle' })();
  const live = actions.reduce(reduceStream, initialStreamState()).journal;
  const page = mergeEntries(await fakeJournalRead('normal', 'mainnet')(), live);
  // The journal's $120 rescue is the stream's newest earlier rescue: listed once.
  assert.equal(page.filter((e) => e.summary.startsWith('Moved $120.00')).length, 1);
  const { shown } = visibleFeed(page, null);
  const { filters, signed } = pageCounts(shown);
  const signedIds = shown.filter((e) => KINDS[e.kind].signed).map((e) => e.id);
  assert.equal(signed, signedIds.length);
  assert.equal(filters.all, shown.length);
  assert.deepEqual([filters.all, signed], [22, 8]);
  assert.deepEqual(signedIds, [
    'fake-j-rescue', 'fake-j-withdraw', 'fake-latest-open', 'fake-latest-rotate',
    'fake-rescue-earlier-2', 'fake-rescue-earlier-3', 'fake-j-ltc-open', 'fake-j-deposit',
  ]);
  // Every signed entry sits under a filter: Trades, Money in and out or Rescue.
  assert.equal(signed, filters.trades + filters.money + filters.rescue);

  // A reader scrolled down: a new signed entry waits, and the header waits with the filters.
  const frozen = new Set(shown.map((e) => e.id));
  const open = shown.find((e) => e.id === 'fake-latest-open') as JournalEntry;
  const held = visibleFeed(mergeEntries(page, [{ ...open, id: 'fake-new-open', t: Date.now() + 60_000 }]), frozen);
  assert.equal(held.pending, 1);
  assert.deepEqual(pageCounts(held.shown), { filters, signed });
});

test('the scenarios: empty reads nothing, error fails like a timeout, loading never answers', async () => {
  assert.deepEqual(await fakeJournalRead('empty', 'mainnet')(), []);
  await assert.rejects(fakeJournalRead('error', 'mainnet')(), /GET \/state: timed out/);
  const outcome = await Promise.race([fakeJournalRead('loading', 'mainnet')().then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 20))]);
  assert.equal(outcome, 'waiting');
});

test('the stream’s three entries and the read together make the whole journal once', async () => {
  const actions: StreamAction[] = [];
  startFakeStream((a) => actions.push(a), { mode: 'mainnet', intervalMs: 60_000, drift: false })();
  const live = actions.reduce(reduceStream, initialStreamState()).journal;
  assert.equal(live.length, 3);
  const read = await fakeJournalRead('normal', 'mainnet')();
  const merged = mergeEntries(read, live);
  assert.equal(merged.length, 20);
  assert.equal(new Set(merged.map((e) => e.id)).size, 20);
});
