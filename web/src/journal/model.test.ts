import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState, JournalEntry } from '@gimbal/shared';
import { JOURNAL_LIMIT } from '../stream/store.ts';
import { win } from '../windows/testing.ts';
import { KINDS, filterLabel, inFilter } from './kinds.ts';
import {
  actionsText,
  attributionOf,
  costsUsd,
  countsOf,
  dayLabel,
  dayRange,
  entriesIn,
  filterCounts,
  foldOlder,
  groupByDay,
  mergeEntries,
  pnlOf,
  rowOf,
  sinceLabel,
  sinceNote,
  stepsOf,
  visibleFeed,
  whyOf,
} from './model.ts';

const NOW = Date.UTC(2026, 9, 27, 14, 2);
const at = (day: number, hh: number, mm = 0) => Date.UTC(2026, 9, day, hh, mm);

let n = 0;
const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  id: `e${++n}`,
  t: NOW,
  kind: 'funding',
  summary: 'Funding paid',
  numbers: {},
  tx: [],
  ...overrides,
});

// The mockup's four days (design/screens/desktop/journal.html), as the engine would send them.
const NEAR = (id: string) => ({ chain: 'near' as const, id, url: `https://nearblocks.io/txns/${id}` });
const MOCKUP: JournalEntry[] = [
  entry({ id: 'f1', t: at(27, 14), kind: 'funding', summary: 'Funding paid on both legs', numbers: { usd: 0.03 } }),
  entry({ id: 'v1', t: at(27, 9, 12), kind: 'veto', summary: 'Skipped AVAX', why: 'one 8-hour spike' }),
  entry({ id: 'x1', t: at(27, 6, 30), kind: 'refused', summary: 'Contract refused to open ZRO', why: 'No trusted oracle price for ZRO.' }),
  entry({ id: 'r1', t: at(26, 18, 44), kind: 'rescue', summary: 'Moved $120.00 to Hyperliquid margin', numbers: { usd: -0.31, from: 'reserve', signedS: 6.1, landedS: 52 } }),
  entry({ id: 'f2', t: at(26, 0), kind: 'funding', summary: 'Phoenix daily settlement', numbers: { usd: 0.52 } }),
  entry({ id: 'w1', t: at(25, 16, 20), kind: 'withdraw', summary: '$50.00 sent', numbers: { usd: -50, feeUsd: -0.14 } }),
  entry({ id: 'f3', t: at(25, 0), kind: 'funding', summary: 'Phoenix daily settlement', numbers: { usd: 0.06 } }),
  entry({ id: 'o1', t: at(24, 23, 41), kind: 'enter', summary: 'Opened DOGE', why: 'spread held', numbers: { usd: -1.47 }, tx: [NEAR('Jd5c')] }),
  entry({ id: 'ro1', t: at(24, 23, 39), kind: 'rotate', summary: 'Closed LTC', numbers: { usd: 1.12, unpriced: 1, venue: 'phoenix' } }),
];

test('every kind is described, and each filter lists the kinds the mockup puts under it', () => {
  const under = (filter: Parameters<typeof inFilter>[1]) => Object.keys(KINDS).filter((k) => inFilter(k as JournalEntry['kind'], filter));
  assert.deepEqual(under('trades'), ['enter', 'exit', 'rotate', 'adl']);
  assert.deepEqual(under('funding'), ['funding']);
  assert.deepEqual(under('money'), ['deposit', 'withdraw', 'fee']);
  assert.deepEqual(under('rescue'), ['rescue']);
  assert.deepEqual(under('refused'), ['refused', 'veto']);
  assert.equal(under('all').length, Object.keys(KINDS).length);
  assert.equal(filterLabel('money'), 'Money in and out');
});

test('kind colours: Rescue and Risk check amber, Refused red, Open and Rotate in ink, the rest grey', () => {
  const tone = (kind: JournalEntry['kind']) => KINDS[kind].tone;
  assert.equal(tone('rescue'), 'watch');
  assert.equal(tone('veto'), 'watch');
  assert.equal(tone('refused'), 'danger');
  assert.equal(tone('enter'), 'ink');
  assert.equal(tone('rotate'), 'ink');
  for (const k of ['funding', 'deposit', 'withdraw', 'fee', 'window', 'error', 'adl'] as const) assert.equal(tone(k), null, k);
  assert.equal(KINDS.enter.label, 'Open');
});

test('filter counts: each kind is listed once, and All is every entry', () => {
  const counts = filterCounts([...MOCKUP, entry({ kind: 'window' }), entry({ kind: 'error' })]);
  assert.deepEqual(counts, { all: 11, trades: 2, funding: 3, money: 1, rescue: 1, refused: 2 });
  assert.deepEqual(entriesIn(MOCKUP, 'refused').map((e) => e.id), ['v1', 'x1']);
  assert.deepEqual(entriesIn(MOCKUP, 'all').map((e) => e.id), MOCKUP.map((e) => e.id));
  assert.deepEqual(entriesIn([], 'trades'), []);
});

test('day totals are P&L only: a withdrawal counts its fee, not its principal (the mockup’s four totals)', () => {
  const groups = groupByDay(MOCKUP, NOW);
  assert.deepEqual(groups.map((g) => g.label), ['Today · 27 Oct', '26 Oct', '25 Oct', '24 Oct']);
  assert.deepEqual(groups.map((g) => Math.round(g.totalUsd * 100) / 100), [0.03, 0.21, -0.08, -0.35]);
  assert.deepEqual(groups.map((g) => g.entries.length), [3, 2, 2, 2]);
  assert.equal(pnlOf(entry({ kind: 'deposit', numbers: { usd: 1050 } })), 0);
  assert.equal(pnlOf(entry({ kind: 'withdraw', numbers: { usd: -50, feeUsd: -0.14 } })), -0.14);
  assert.equal(pnlOf(entry({ kind: 'funding', numbers: { usd: '0.52' } })), 0.52);
  assert.equal(pnlOf(entry({ kind: 'veto' })), 0);
  assert.deepEqual(groupByDay([], NOW), []);
});

test('a day label says Today for today and names the year only when it is another one', () => {
  assert.equal(dayLabel(at(27, 3), NOW), 'Today · 27 Oct');
  assert.equal(dayLabel(at(26, 23), NOW), '26 Oct');
  assert.equal(dayLabel(Date.UTC(2025, 11, 31, 23), NOW), '31 Dec 2025');
});

test('older days fold into one line that counts what happened, and everything shows after Show', () => {
  const day = (d: number, kind: JournalEntry['kind'], count: number) =>
    Array.from({ length: count }, (_, i) => entry({ id: `d${d}-${kind}-${i}`, t: at(d, 20 - i), kind }));
  const entries = [...MOCKUP, ...day(23, 'funding', 3), ...day(22, 'funding', 6),
    entry({ id: 'd21-open', t: at(21, 10), kind: 'enter' }),
    entry({ id: 'd21-deposit', t: at(21, 9), kind: 'deposit' }),
  ];
  const groups = groupByDay(entries, NOW);
  assert.equal(groups.length, 7);
  const { shown, fold } = foldOlder(groups);
  assert.deepEqual(shown.map((g) => g.label), ['Today · 27 Oct', '26 Oct', '25 Oct', '24 Oct']);
  assert.ok(fold);
  assert.equal(fold.range, '21–23 Oct');
  assert.equal(fold.count, 11);
  assert.equal(fold.summary, '11 earlier events: 1 deposit, 1 open, 9 funding payments');
  assert.equal(fold.groups.length, 3);
  // four days or fewer fold nothing
  assert.equal(foldOlder(groups.slice(0, 4)).fold, null);
  assert.equal(foldOlder([]).fold, null);
  assert.equal(foldOlder(groups, 7).fold, null);
  assert.equal(foldOlder(groups, 6).fold?.summary, '2 earlier events: 1 deposit, 1 open');
});

test('a range of days: one day, one month, two months', () => {
  assert.equal(dayRange(at(21, 5), at(21, 20)), '21 Oct');
  assert.equal(dayRange(at(23, 5), at(21, 5)), '21–23 Oct');
  assert.equal(dayRange(Date.UTC(2026, 8, 28), Date.UTC(2026, 9, 3)), '28 Sep – 3 Oct');
});

test('a row: time, the kind’s word and colour, the engine’s line, the reason, the amount and the links', () => {
  const row = rowOf(MOCKUP[7] as JournalEntry);
  assert.equal(row.time, '23:41');
  assert.equal(row.timeTitle, '24 Oct 23:41 UTC');
  assert.equal(row.label, 'Open');
  assert.equal(row.tone, 'ink');
  assert.deepEqual(row.why, { prefix: 'NEAR AI', text: 'spread held' });
  assert.deepEqual(row.amount, { text: '−$1.47', positive: false });
  assert.equal(row.note, 'fees');
  assert.deepEqual(row.proofs.map((p) => [p.label, p.short, p.href]), [['NEAR', 'Jd5c', 'https://nearblocks.io/txns/Jd5c']]);
  assert.equal(row.flag, null);
});

test('amounts: positive money is green, withdrawals are negative and plain, a deposit is not earning', () => {
  const amount = (e: JournalEntry) => rowOf(e).amount;
  assert.deepEqual(amount(MOCKUP[0] as JournalEntry), { text: '+$0.03', positive: true });
  assert.deepEqual(amount(MOCKUP[3] as JournalEntry), { text: '−$0.31', positive: false });
  assert.deepEqual(amount(MOCKUP[5] as JournalEntry), { text: '−$50.00', positive: false });
  assert.deepEqual(amount(entry({ kind: 'deposit', numbers: { usd: '1050.00' } })), { text: '+$1,050.00', positive: false });
  assert.equal(amount(MOCKUP[1] as JournalEntry), null);
  assert.equal(amount(entry({ numbers: { usd: 'lots' } })), null);
});

test('the small line under the amount: a fee on top, or what the number is', () => {
  const note = (e: JournalEntry) => rowOf(e).note;
  assert.equal(note(MOCKUP[5] as JournalEntry), 'fee −$0.14');
  assert.equal(note(MOCKUP[7] as JournalEntry), 'fees');
  assert.equal(note(MOCKUP[8] as JournalEntry), 'after fees');
  assert.equal(note(MOCKUP[0] as JournalEntry), null);
  // no amount, no note
  assert.equal(note(entry({ kind: 'enter' })), null);
});

test('the reason line: NEAR AI’s, except a refusal’s, which is the policy rule', () => {
  assert.deepEqual(whyOf(MOCKUP[1] as JournalEntry), { prefix: 'NEAR AI', text: 'one 8-hour spike' });
  assert.deepEqual(whyOf(MOCKUP[2] as JournalEntry), { prefix: null, text: 'No trusted oracle price for ZRO.' });
  assert.deepEqual(whyOf(entry({ kind: 'veto', why: 'NEAR AI: spike' })), { prefix: null, text: 'NEAR AI: spike' });
  assert.equal(whyOf(entry({ why: '   ' })), null);
  assert.equal(whyOf(entry()), null);
});

test('an unprotected order keeps its amber line, and the rotation row carries it', () => {
  assert.equal(rowOf(MOCKUP[8] as JournalEntry).flag, 'Phoenix leg sent without price protection');
  assert.equal(rowOf(MOCKUP[7] as JournalEntry).flag, null);
});

test('a rescue shows its steps as far as the entry says', () => {
  assert.deepEqual(stepsOf(MOCKUP[3] as JournalEntry), ['detected', 'source: reserve', 'quote ✓', 'signed 6.1 s', 'landed 52 s']);
  assert.deepEqual(stepsOf(entry({ kind: 'rescue', numbers: { from: 'phoenix', signedS: 14.2 } })), ['detected', 'source: Phoenix', 'quote ✓', 'signed 14 s']);
  assert.deepEqual(stepsOf(entry({ kind: 'rescue', numbers: { from: 'reserve' } })), ['detected', 'source: reserve']);
  assert.equal(stepsOf(entry({ kind: 'rescue' })), null);
  assert.equal(stepsOf(entry({ kind: 'funding', numbers: { from: 'reserve' } })), null);
});

test('new entries wait for a reader who has scrolled down, and show at once at the top', () => {
  const entries = MOCKUP.slice(0, 5);
  const seen = new Set(entries.slice(2).map((e) => e.id));
  assert.deepEqual(visibleFeed(entries, null), { shown: entries, pending: 0 });
  const held = visibleFeed(entries, seen);
  assert.deepEqual(held.shown.map((e) => e.id), ['x1', 'r1', 'f2']);
  assert.equal(held.pending, 2);
  assert.deepEqual(visibleFeed(entries, new Set(entries.map((e) => e.id))).pending, 0);
  assert.deepEqual(visibleFeed([], seen), { shown: [], pending: 0 });
});

test('an older page the reader asked for shows at once, even while newer entries wait', () => {
  const entries = MOCKUP.slice(0, 5);
  const seen = new Set(entries.slice(2, 4).map((e) => e.id)); // x1 and r1 were on screen; f2 is the older page that just arrived
  const held = visibleFeed(entries, seen);
  assert.deepEqual(held.shown.map((e) => e.id), ['x1', 'r1', 'f2']);
  assert.equal(held.pending, 2, 'f1 and v1 are newer than anything shown, so they still wait');
  assert.deepEqual(visibleFeed(entries.slice(2), seen).pending, 0);
  // nothing was on screen yet: every entry is new to the reader
  assert.deepEqual(visibleFeed(entries, new Set()), { shown: [], pending: 5 });
});

test('the read and the stream merge by id, newest first, and the stream’s copy wins', () => {
  const a = entry({ id: 'a', t: at(27, 10), summary: 'read' });
  const b = entry({ id: 'b', t: at(27, 12) });
  const aLater = entry({ id: 'a', t: at(27, 10), summary: 'stream', why: 'now with a reason' });
  const c = entry({ id: 'c', t: at(27, 13) });
  const merged = mergeEntries([a, b], [c, aLater]);
  assert.deepEqual(merged.map((e) => e.id), ['c', 'b', 'a']);
  assert.equal(merged[2]?.summary, 'stream');
  assert.deepEqual(mergeEntries([], []), []);
});

test('older pages are never cut away: a reader who asked for them keeps them', () => {
  const many = Array.from({ length: JOURNAL_LIMIT + 5 }, (_, i) => entry({ id: `m${i}`, t: i }));
  const all = mergeEntries(many, []);
  assert.equal(all.length, JOURNAL_LIMIT + 5);
  assert.equal(all[0]?.id, `m${JOURNAL_LIMIT + 4}`);
  assert.equal(all[all.length - 1]?.id, 'm0');
});

test('the counts: actions the contract signed, refusals and risk check refusals', () => {
  const counts = countsOf(MOCKUP);
  // the rescue, the withdrawal, the open and the rotation are signed; funding, refusals and risk check refusals are not
  assert.deepEqual(counts, { signed: 4, refused: 1, vetoed: 1 });
  assert.deepEqual(countsOf([]), { signed: 0, refused: 0, vetoed: 0 });
  assert.equal(actionsText(23), '23 actions signed');
  assert.equal(actionsText(1), '1 action signed');
  assert.equal(actionsText(1234), '1,234 actions signed');
  // A replay signs nothing: its actions are simulated.
  assert.equal(actionsText(2, true), '2 simulated actions');
  assert.equal(actionsText(1, true), '1 simulated action');
});

test('a closed pair’s realized split joins the flat desk’s P&L, so the net agrees with the day totals', () => {
  const flat: DeskState['pnl'] = { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 };
  const journal = [
    entry({ kind: 'enter', numbers: { usd: -0.011, feeUsd: -0.011 } }),
    entry({ kind: 'funding', numbers: { usd: 0.004 } }),
    entry({
      kind: 'exit',
      numbers: { usd: -0.019, feeUsd: -0.011, realizedFundingUsd: 0.005, realizedFeesUsd: -0.022, realizedPriceUsd: -0.009, realizedNetUsd: -0.026 },
    }),
  ];
  const a = attributionOf(flat, journal);
  assert.equal(Math.round((a.fundingUsd ?? 0) * 1000) / 1000, 0.005);
  assert.equal(Math.round((a.feesUsd ?? 0) * 1000) / 1000, -0.022);
  assert.equal(Math.round((a.basisUsd ?? 0) * 1000) / 1000, -0.009);
  assert.equal(Math.round((a.netUsd ?? 0) * 1000) / 1000, -0.026);
  // The same as the entries' money effects summed (what the day totals count).
  const days = journal.reduce((s, e) => s + pnlOf(e), 0);
  assert.equal(Math.round(days * 1000) / 1000, -0.026);
});

test('a rescue the engine journaled with its fee apart counts that fee once, on the line that says it landed', () => {
  const sent = entry({ kind: 'rescue', numbers: { from: 'reserve', usd: 0, feeUsd: -0.52, amountUsd: 20, signedS: 0 } });
  const landed = entry({ kind: 'rescue', numbers: { from: 'reserve', usd: 0, feeUsd: -0.52, amountUsd: 19.48, landedS: 100.9 } });
  const trigger = entry({ kind: 'rescue', numbers: { venue: 'hyperliquid', rescuePct: 87.27, amountUsd: 1.42 } });
  assert.deepEqual([pnlOf(trigger), pnlOf(sent), pnlOf(landed)], [0, 0, -0.52]);
  const flat: DeskState['pnl'] = { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 };
  assert.equal(attributionOf(flat, [trigger, sent, landed]).otherUsd, -0.52);
  // A rescue whose cost is its amount (the web's own fixtures) keeps it.
  assert.equal(pnlOf(entry({ kind: 'rescue', numbers: { usd: -0.31, landedS: 52 } })), -0.31);
  // The sent line's fee is the quote: labelled so, not counted; the landed line's is the fee.
  assert.equal(rowOf(sent).note, 'quoted fee −$0.52');
  assert.equal(rowOf(landed).note, 'fee −$0.52');
});

test('from Hyperliquid, the withdrawal fee and the 1Click fee each count once; a reduce costs nothing here', () => {
  // The rescuer's lines for a Hyperliquid source: hl_withdraw (1 USDC fee, to the desk's own Arbitrum address), the
  // 1Click send from Arbitrum (quoted), the landing (the 1Click fee); and a reduce, whose cost is in the fills.
  const started = entry({ kind: 'rescue', numbers: { venue: 'phoenix', amountUsd: 12, from: 'hyperliquid' } });
  const withdraw = entry({ kind: 'rescue', numbers: { from: 'hyperliquid', usd: 0, feeUsd: -1, signedS: 3.2 } });
  const sent = entry({ kind: 'rescue', numbers: { from: 'hyperliquid', usd: 0, feeUsd: -0.3, amountUsd: 11, signedS: 41.5 } });
  const landed = entry({ kind: 'rescue', numbers: { from: 'hyperliquid', landedS: 160.2, signedS: 41.5, usd: 0, amountUsd: 10.7, feeUsd: -0.3 } });
  const reduce = entry({ kind: 'rescue', numbers: { from: 'phoenix', usd: 0, signedS: 2 } });
  assert.deepEqual([started, withdraw, sent, landed, reduce].map(pnlOf), [0, -1, 0, -0.3, 0]);
  const flat: DeskState['pnl'] = { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 };
  assert.equal(attributionOf(flat, [started, withdraw, sent, landed, reduce]).otherUsd, -1.3);
  assert.equal(rowOf(withdraw).note, 'fee −$1.00');
  assert.equal(rowOf(sent).note, 'quoted fee −$0.30');
});

test('a replay rescue row shows no signature time: nothing is signed', () => {
  const landed = entry({ kind: 'rescue', numbers: { from: 'reserve', usd: 0, feeUsd: -0.52, amountUsd: 19.48, landedS: 100.9, signedS: 0 } });
  assert.deepEqual(rowOf(landed, { replay: true }).steps, ['detected', 'source: reserve', 'quote ✓', 'landed 101 s']);
  assert.deepEqual(rowOf(landed).steps, ['detected', 'source: reserve', 'quote ✓', 'signed 0.0 s', 'landed 101 s']);
});

test('where the money went: the desk’s funding, fees and price, and the journal’s cost of moving money', () => {
  const pnl: DeskState['pnl'] = { fundingUsd: 1.36, feesUsd: -1.47, priceUsd: -0.48, netUsd: -0.59 };
  const a = attributionOf(pnl, MOCKUP);
  // the rescue (−0.31) and the withdrawal's fee (−0.14); a deposit's principal and a funding payment are not counted
  assert.equal(Math.round(a.otherUsd * 100) / 100, -0.45);
  assert.equal(a.fundingUsd, 1.36);
  assert.equal(a.feesUsd, -1.47);
  assert.equal(a.basisUsd, -0.48);
  assert.equal(Math.round((a.netUsd ?? 0) * 100) / 100, -1.04);
  assert.equal(Math.round((costsUsd(a) ?? 0) * 100) / 100, -2.4);
  const none = attributionOf(null, MOCKUP);
  assert.deepEqual([none.fundingUsd, none.feesUsd, none.basisUsd, none.netUsd, costsUsd(none)], [null, null, null, null, null]);
  const small = attributionOf(pnl, [entry({ kind: 'fee', numbers: { usd: -0.2 } }), entry({ kind: 'deposit', numbers: { usd: 50, feeUsd: -0.05 } })]);
  assert.equal(Math.round(small.otherUsd * 100) / 100, -0.25);
});

test('Since names the oldest entry the page holds', () => {
  assert.equal(sinceLabel(MOCKUP), 'Since 24 Oct');
  assert.equal(sinceLabel([]), null);
});

test('the line under the net says where the held window stands against its entry costs', () => {
  const leg = (side: 'short' | 'long'): DeskState['legs'][number] => ({
    venue: side === 'short' ? 'hyperliquid' : 'phoenix',
    symbol: 'DOGE',
    side,
    size: 6040,
    lotSize: 1,
    entry: 0.19861,
    mark: 0.19842,
    liqPx: 0.26314,
    marginUsd: 482.1,
    marginRatio: 0.31,
    distanceToLiqPct: 32.6,
    fundingEarnedUsd: 0.5,
    unsettledFundingUsd: 0,
    feesUsd: -0.7,
    unpriced: false,
  });
  const desk = (pnl: DeskState['pnl'], legs: DeskState['legs']): DeskState => ({
    deskId: 'desk-07',
    owner: 'o.testnet',
    contract: '(test contract)',
    mode: 'mainnet',
    legs,
    netDelta: 0,
    equityUsd: 1000,
    reserveUsd: 40,
    pnl,
    health: 'level',
    paused: null,
    rescueFailure: null,
    updatedAt: NOW,
  });
  const held = win({ symbol: 'DOGE', netAprPct: 13.8, held: { since: 0 } });
  const legs = [leg('short'), leg('long')];
  const owing = desk({ fundingUsd: 1.36, feesUsd: -1.47, priceUsd: -0.48, netUsd: -0.59 }, legs);
  assert.match(sinceNote(owing, [held]) ?? '', /^The DOGE window paid its entry costs up front; about \d+ [dh][ \dh]* until they are earned back\.$/);
  assert.match(sinceNote(owing, null) ?? '', /they are not earned back yet\.$/);
  assert.equal(sinceNote(desk({ fundingUsd: 3, feesUsd: -1, priceUsd: 0, netUsd: 2 }, legs), [held]), 'The DOGE window’s entry costs are earned back.');
  assert.equal(sinceNote(desk({ fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 }, []), [held]), null);
});
