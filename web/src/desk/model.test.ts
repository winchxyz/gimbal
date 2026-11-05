import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState, JournalEntry, Leg, StrategyConfig } from '@gimbal/shared';
import { unprotectedText } from '../journal/entry.ts';
import { STRATEGY, win } from '../windows/testing.ts';
import {
  distanceText,
  exposureOf,
  hoursLeftText,
  LATEST_TEXT_MAX,
  lastClose,
  latestEvents,
  legNotional,
  legRows,
  lotLimit,
  moveText,
  nextBest,
  nextFunding,
  paybackOf,
  placeLegs,
  pnlRows,
  sizeText,
  splitSummary,
  dayRate,
  thresholdText,
  valueGaps,
  whenLabel,
} from './model.ts';

const leg = (overrides: Partial<Leg> = {}): Leg => ({
  venue: 'hyperliquid',
  symbol: 'DOGE',
  side: 'short',
  size: 6040,
  entry: 0.19861,
  mark: 0.19842,
  liqPx: 0.26314,
  marginUsd: 482.1,
  marginRatio: 0.31,
  distanceToLiqPct: 32.6,
  fundingEarnedUsd: 0.31,
  unsettledFundingUsd: 0,
  feesUsd: -0.48,
  lotSize: 1,
  unpriced: false,
  ...overrides,
});

const SHORT = leg();
const LONG = leg({ venue: 'phoenix', side: 'long', entry: 0.19873, mark: 0.19846, liqPx: 0.13512, marginUsd: 476.5, marginRatio: 0.33, distanceToLiqPct: 31.9, fundingEarnedUsd: 1.05, unsettledFundingUsd: 0.011 });

test('the short sits on the left and the long on the right, whatever the order', () => {
  assert.deepEqual(placeLegs([SHORT, LONG]), { left: SHORT, right: LONG });
  assert.deepEqual(placeLegs([LONG, SHORT]), { left: SHORT, right: LONG });
  assert.deepEqual(placeLegs([LONG]), { left: null, right: LONG });
  assert.deepEqual(placeLegs([]), { left: null, right: null });
});

test('the distance sentence names the price move and where it ends, as in the mockup', () => {
  assert.equal(distanceText(SHORT), '32.6%');
  assert.equal(moveText(SHORT), 'to liquidation · DOGE has to rise 32.6% to 0.2631');
  assert.equal(moveText(LONG), 'to liquidation · DOGE has to fall 31.9% to 0.1351');
  assert.equal(distanceText(leg({ distanceToLiqPct: null, liqPx: null })), '—');
  assert.match(moveText(leg({ distanceToLiqPct: null, liqPx: null })), /no liquidation price/);
  assert.equal(sizeText(SHORT), 'Short 6,040 DOGE');
  assert.equal(sizeText(LONG), 'Long 6,040 DOGE');
});

test('the rows of a leg: entry and mark, margin ratio, funding earned, fees paid, what is unsettled, the next funding', () => {
  const now = Date.UTC(2026, 9, 27, 14, 37, 0);
  const rows = legRows(SHORT, now);
  assert.deepEqual(
    rows.map((r) => [r.key, r.label, r.value, r.tone, r.only]),
    [
      ['entry', 'Entry · mark', '0.19861 · 0.19842', null, 'desktop'],
      ['margin', 'Margin', '$482.10 · ratio 31%', null, 'phone'],
      ['ratio', 'Margin ratio', '31%', null, 'desktop'],
      ['funding', 'Funding earned', '+$0.31', 'pos', null],
      ['fees', 'Fees paid', '−$0.48', null, null],
      ['unsettled', 'Unsettled funding', '$0.000', null, null],
      ['next', 'Next funding', 'in 23 min', null, null],
    ],
  );
  const phoenix = legRows(LONG, now);
  assert.equal(phoenix.find((r) => r.key === 'unsettled')?.value, '+$0.011');
  assert.equal(phoenix.find((r) => r.key === 'next')?.value, 'accrues hourly · settles 00:00');
  assert.equal(legRows(leg({ fundingEarnedUsd: -0.2 }), now).find((r) => r.key === 'funding')?.tone, 'neg');
});

test('fees paid are a cost: negative on the leg, shown with the minus and no colour; none yet reads $0.00', () => {
  const now = Date.UTC(2026, 9, 27, 14, 37, 0);
  const fees = (l: Leg) => legRows(l, now).find((r) => r.key === 'fees');
  assert.deepEqual(fees(LONG)?.value, '−$0.48');
  assert.equal(fees(leg({ feesUsd: -1234.5 }))?.value, '−$1,234.50');
  assert.equal(fees(leg({ feesUsd: 0 }))?.value, '$0.00');
  assert.equal(fees(leg({ feesUsd: -0.99 }))?.tone, null);
});

test('the rescue and warning distances are the owner’s own numbers, and the line waits for them', () => {
  assert.equal(thresholdText({ watchDistancePct: 15, rescueDistancePct: 8 }), 'Rescue starts at 8%, a warning at 15%.');
  assert.equal(thresholdText({ watchDistancePct: 12.5, rescueDistancePct: 6 }), 'Rescue starts at 6%, a warning at 12.5%.');
  assert.equal(thresholdText({ watchDistancePct: 20, rescueDistancePct: 7.5 }), 'Rescue starts at 7.5%, a warning at 20%.');
  assert.equal(thresholdText(null), null);
  assert.equal(thresholdText(undefined), null);
});

test('next funding follows each venue’s schedule', () => {
  const at = (m: number, s = 0) => Date.UTC(2026, 9, 27, 14, m, s);
  assert.equal(nextFunding('hyperliquid', at(37)), 'in 23 min');
  assert.equal(nextFunding('hyperliquid', at(59, 30)), 'in 1 min');
  assert.equal(nextFunding('hyperliquid', at(0)), 'in 60 min');
  assert.equal(nextFunding('phoenix', at(0)), 'accrues hourly · settles 00:00');
  assert.equal(nextFunding('orderly', at(0)), 'every 8 h');
});

test('net exposure drifts when the legs differ by more than one lot, and not before', () => {
  const level = exposureOf({ legs: [SHORT, LONG], netDelta: 0 });
  assert.deepEqual(level, {
    text: '0 DOGE',
    drift: false,
    explain: 'Both legs are the same size, so a DOGE price move adds to one and takes the same from the other.',
  });
  // one lot is level, the next step is not
  assert.equal(exposureOf({ legs: [SHORT, LONG], netDelta: 1 }).drift, false);
  assert.equal(exposureOf({ legs: [SHORT, LONG], netDelta: -1 }).drift, false);
  assert.equal(exposureOf({ legs: [SHORT, LONG], netDelta: 2 }).drift, true);
  const drift = exposureOf({ legs: [SHORT, leg({ side: 'long', size: 6160 })], netDelta: 120 });
  assert.equal(drift.drift, true);
  assert.equal(drift.text, '+120 DOGE');
  assert.match(drift.explain, /The legs differ by 120 DOGE.*The desk is rebalancing\.$/);
  assert.equal(exposureOf({ legs: [SHORT], netDelta: -6040 }).text, '−6,040 DOGE');
});

test('the lot is the coarser venue’s: a hedge cannot be more exact than the venue with the bigger lot', () => {
  const fine = leg({ lotSize: 0.1 });
  const coarse = leg({ venue: 'phoenix', side: 'long', lotSize: 10 });
  assert.equal(lotLimit([fine, coarse]), 10);
  assert.equal(exposureOf({ legs: [fine, coarse], netDelta: 10 }).drift, false);
  assert.equal(exposureOf({ legs: [fine, coarse], netDelta: 10.1 }).drift, true);
  assert.equal(exposureOf({ legs: [fine, fine], netDelta: 0.1 }).drift, false);
  // a size sum that is one lot plus a rounding error is still one lot
  assert.equal(exposureOf({ legs: [fine, fine], netDelta: 0.30000000000000004 - 0.2 }).drift, false);
  assert.equal(exposureOf({ legs: [fine, fine], netDelta: 0.2 }).drift, true);
  assert.equal(lotLimit([]), 0);
  assert.equal(exposureOf({ legs: [], netDelta: 0 }).drift, false);
});

test('a day on these legs: the held window’s net APR on the legs’ own size', () => {
  const held = win({ symbol: 'DOGE', netAprPct: 13.8, usdPerDayPer1k: 0.378, held: { since: 0 } });
  assert.ok(Math.abs((legNotional([SHORT, LONG]) ?? 0) - 1198.5) < 1);
  const rate = dayRate(held, [SHORT, LONG]);
  assert.ok(rate && Math.abs(rate.perDayUsd - 0.453) < 0.001);
  assert.equal(rate?.netAprPct, 13.8);
  assert.equal(dayRate(null, [SHORT, LONG]), null);
  assert.equal(dayRate(held, []), null);
});

test('payback is funding over entry fees and basis, with the hours left at today’s rate', () => {
  const pnl = { fundingUsd: 1.36, feesUsd: -1.47, priceUsd: -0.48, netUsd: -0.59 };
  const p = paybackOf(pnl, 0.6);
  assert.equal(p.pct, 70);
  assert.equal(p.earnedBack, false);
  assert.ok(p.hoursLeft !== null && Math.abs(p.hoursLeft - 23.6) < 0.2);
  assert.equal(hoursLeftText(p.hoursLeft ?? 0), '~24 h left');
  // no positive rate: the bar still shows, there is no time left to name
  assert.equal(paybackOf(pnl, null).hoursLeft, null);
  assert.equal(paybackOf(pnl, -1).hoursLeft, null);
  // a gain on the price is not a cost
  assert.equal(paybackOf({ ...pnl, priceUsd: 0.3 }, 1).pct, 93);
  // earned back: at 100% the bar is replaced
  assert.deepEqual(paybackOf({ ...pnl, fundingUsd: 2 }, 1), { pct: 100, earnedBack: true, hoursLeft: 0 });
  assert.equal(paybackOf({ fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 }, 1).earnedBack, true);
  // it never reads 100% before it is earned back
  assert.equal(paybackOf({ ...pnl, fundingUsd: 1.94 }, 1).pct, 99);
  assert.equal(paybackOf({ ...pnl, fundingUsd: -0.2 }, 1).pct, 0);
});

test('the P&L split: funding, fees, price and net, with colour only on funding received and the net', () => {
  const rows = pnlRows({ fundingUsd: 1.36, feesUsd: -1.47, priceUsd: -0.48, netUsd: -0.59 });
  assert.deepEqual(
    rows.map((r) => [r.key, r.label, r.value, r.tone]),
    [
      ['funding', 'Funding', '+$1.36', 'pos'],
      ['fees', 'Fees', '−$1.47', null],
      ['price', 'Price move', '−$0.48', null],
      ['net', 'Net P&L', '−$0.59', 'neg'],
    ],
  );
  assert.equal(pnlRows({ fundingUsd: 3, feesUsd: -1, priceUsd: 0, netUsd: 2 })[3]?.tone, 'pos');
  assert.equal(pnlRows({ fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 })[3]?.tone, null);
});

const NOW = Date.UTC(2026, 9, 27, 14, 2);
const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  id: 'e1',
  t: Date.UTC(2026, 9, 27, 14, 0),
  kind: 'funding',
  summary: 'Funding paid',
  numbers: {},
  tx: [],
  ...overrides,
});

test('the three latest events: today shows the time, older ones the date', () => {
  assert.equal(whenLabel(Date.UTC(2026, 9, 27, 14, 0), NOW), 'Today 14:00');
  assert.equal(whenLabel(Date.UTC(2026, 9, 24, 23, 41), NOW), '24 Oct 23:41');
  assert.equal(whenLabel(Date.UTC(2026, 9, 26, 23, 59), NOW), '26 Oct 23:59');
  const journal = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' }), entry({ id: 'd' })];
  assert.deepEqual(latestEvents(journal, NOW).map((e) => e.id), ['a', 'b', 'c']);
  assert.deepEqual(latestEvents([], NOW), []);
});

test('an event links to its proof, or to the reason, and an unprotected order keeps its amber line', () => {
  const one = { chain: 'near', id: 'x', url: 'https://explorer.invalid/x' } as const;
  const [funding, opened, rotated, plain] = latestEvents(
    [
      entry({ id: 'f', numbers: { usd: 0.03 }, tx: [one] }),
      entry({ id: 'o', summary: 'Opened DOGE', tx: [one, { ...one, chain: 'solana' }] }),
      entry({ id: 'r', summary: 'Closed LTC to rotate', why: 'DOGE pays more', numbers: { unpriced: 1, venue: 'phoenix' } }),
      entry({ id: 'p' }),
    ],
    NOW,
    4,
  );
  assert.deepEqual(funding?.proof, { label: 'on-chain ↗', href: 'https://explorer.invalid/x' });
  assert.equal(funding?.amountUsd, 0.03);
  assert.deepEqual(opened?.proof, { label: '2 transactions ↗', href: 'https://explorer.invalid/x' });
  assert.deepEqual(rotated?.proof, { label: 'Why ↗', href: '#/journal' });
  assert.equal(rotated?.unprotected, 'Phoenix leg sent without price protection');
  assert.equal(plain?.proof, null);
  assert.equal(plain?.unprotected, null);
  assert.equal(unprotectedText(entry({ numbers: { unpriced: 'true' } })), 'Sent without price protection');
  assert.equal(unprotectedText(entry({ numbers: { unpriced: 0 } })), null);
});

test('a long line shows its head, the rest behind a control; a short one stays whole', () => {
  const tees = 'gpu 0xabc mrtd 1234 rtmr3 5678 compose 9abc; '.repeat(6);
  const head = 'NEAR AI attestation of Qwen/Qwen3-VL-30B-A3B-Instruct (recorded 2026-11-04T04:55:11.490Z)';
  const long = `${head}: verified TDX quote; ${tees}`;
  const [row] = latestEvents([entry({ summary: long })], NOW);
  assert.equal(row?.text, head);
  assert.equal(row?.detail, long.slice(head.length + 2));
  // A short label before the first colon is not cut off on its own.
  const script = splitSummary(`replay script: the window before was not entered (its line says why); the next one: ${'x '.repeat(60)}`);
  assert.equal(script.text, 'replay script: the window before was not entered (its line says why)');
  assert.deepEqual(splitSummary('Opened DOGE'), { text: 'Opened DOGE', detail: null });
  // The honesty labels stay in the head: an owner demo entry's waived profit checks, a demo pair that pays funding.
  const enter = 'enter sol-phoenix-hyperliquid, SOL short hyperliquid, long phoenix, at most 0.12 SOL (12 USD) a leg at 1.5x, -15 % net (POST /rotate (manual)); '
    + 'owner demo entry: the profit checks are waived; round trip $0.02 estimated, at most $1.00 accepted; checks: x; filled 0.12 SOL';
  assert.equal(splitSummary(enter).text, enter.slice(0, enter.indexOf('waived') + 'waived'.length));
  const sol = 'replay script: SOL: this hour\'s rates pay the other way (-9.1 % APR; its 7-day spread, +0.8 %, is why it is listed in this direction), '
    + 'so in this recorded hour the pair pays funding: the demo shows the cycle, not a profit; the window before was not entered (its line says why); the next one';
  assert.equal(splitSummary(sol).text, sol.slice(0, sol.indexOf('not a profit') + 'not a profit'.length));
  const tail = `${'x '.repeat(90)}owner demo entry: the profit checks are waived and the rest`;
  assert.equal(splitSummary(tail).text, tail.slice(0, tail.indexOf('waived') + 'waived'.length));
  // And the NEAR AI risk check's: a replay-only pass, and an entry held for want of an answer.
  const replayOnly = `${enter.replace('; checks: x; filled 0.12 SOL', '')}; no recorded NEAR AI risk check reply for this prompt: passed in replay only; live, the entry would wait; opened both legs`;
  assert.equal(splitSummary(replayOnly).text, replayOnly.slice(0, replayOnly.indexOf('would wait') + 'would wait'.length));
  const heldLine = 'enter sol-phoenix-hyperliquid not carried out: the NEAR AI risk check did not answer (no answer within 15 s, asked 2 times): '
    + 'held, not passed: the act waits; nothing sent; asked again at the next hourly check (2026-11-05T11:01:00.000Z); not a refusal, so no 6 h hold-out';
  assert.equal(splitSummary(heldLine).text, heldLine.slice(0, heldLine.indexOf('act waits') + 'act waits'.length));
  // No ": " or "; " before the limit: cut at the last space.
  const words = 'word '.repeat(40).trim();
  const cut = splitSummary(words);
  assert.ok(cut.text.length <= LATEST_TEXT_MAX && cut.detail !== null && `${cut.text} ${cut.detail}` === words);
});

test('the flat desk names the pair it closed last and its realized net', () => {
  const t = Date.UTC(2026, 9, 27, 17, 5);
  const journal = [entry({ kind: 'wait' }), entry({ kind: 'exit', t, numbers: { usd: -0.02, realizedNetUsd: -0.026 } }), entry({ kind: 'enter' })];
  assert.deepEqual(lastClose(journal, NOW), { when: 'Today 17:05', netUsd: -0.026 });
  assert.equal(lastClose([entry({ kind: 'exit', numbers: { usd: 1 } })], NOW), null);
});

test('the next best window: the best open one that is not held, against the held one, with the rotation rule', () => {
  const held = win({ symbol: 'DOGE', netAprPct: 13.8, held: { since: 0 } });
  const sol = win({ symbol: 'SOL', netAprPct: 8.6 });
  const veto = win({ symbol: 'AVAX', netAprPct: 9.1, veto: { verdict: 'veto', reasons: ['spike'], model: 'm', at: 0 } });
  const refused = win({ symbol: 'ZRO', netAprPct: 35.2, refused: { code: 'E_ORACLE_STALE', reason: 'no price' } });
  const watch = win({ symbol: 'XMR', netAprPct: 0, grossAprPct: 55, tradable: false });
  const next = nextBest([held, sol, veto, refused, watch], STRATEGY);
  assert.deepEqual(next, {
    symbol: 'SOL',
    pair: 'Phoenix / Orderly',
    netAprPct: 8.6,
    text: '5.2 points below DOGE. The desk rotates when another window beats the held one by 3 points for 4 hours.',
  });
  assert.equal(nextBest([held, win({ symbol: 'SOL', netAprPct: 15 })], STRATEGY)?.text.startsWith('1.2 points above DOGE.'), true);
  assert.equal(nextBest([held, win({ symbol: 'SOL', netAprPct: 13.8 })], null)?.text, 'Level with DOGE.');
  const off: StrategyConfig = { ...STRATEGY, auto: false };
  assert.match(nextBest([held, sol], off)?.text ?? '', /Auto is off, so the desk does not rotate by itself\.$/);
  assert.equal(nextBest([sol], STRATEGY)?.text.startsWith('Nothing is held.'), true);
  assert.equal(nextBest([held, veto, refused, watch], STRATEGY), null);
  assert.equal(nextBest([], STRATEGY), null);
});

test('the pieces take a whole DeskState', () => {
  const state: Pick<DeskState, 'legs' | 'netDelta' | 'pnl'> = { legs: [SHORT, LONG], netDelta: 0, pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 } };
  assert.equal(exposureOf(state).drift, false);
  assert.equal(pnlRows(state.pnl).length, 4);
});

test('the desk value says which venue accounts it leaves out or holds old, and nothing when all are fresh', () => {
  const at = 1_000_000;
  const fresh = { venue: 'hyperliquid' as const, equityUsd: 7.68, at };
  assert.equal(valueGaps({ updatedAt: at, accounts: [fresh, { venue: 'phoenix', equityUsd: 0, at }, { venue: 'orderly', equityUsd: 13, at }] }), null);
  // An engine that does not list its accounts: nothing to say.
  assert.equal(valueGaps({ updatedAt: at }), null);
  assert.equal(
    valueGaps({ updatedAt: at, accounts: [fresh, { venue: 'phoenix', equityUsd: null, at: null }, { venue: 'orderly', equityUsd: null, at: null }] }),
    'Phoenix and Orderly not read yet, so not counted.',
  );
  assert.equal(
    valueGaps({ updatedAt: at, accounts: [{ venue: 'hyperliquid', equityUsd: null, at: null }, { venue: 'orderly', equityUsd: 13, at: at - 3 * 60_000 }] }),
    'Hyperliquid not read yet, so not counted. Orderly as last read 3 min ago.',
  );
});
