import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState, JournalEntry, RescueFailure, RescueProgress, TxRef } from '@gimbal/shared';
import {
  CHAIN_OF,
  STEPS,
  canStress,
  clockText,
  distanceNote,
  durationText,
  earlierRows,
  emptyBook,
  failText,
  failedStep,
  failureOf,
  feesText,
  movingOf,
  observe,
  stepSeconds,
  stepStates,
  stepText,
  stressOutcome,
  stressView,
  timerSeconds,
  txByStep,
  usualSeconds,
  type StepBook,
  type StepId,
} from './model.ts';

const T0 = Date.UTC(2026, 9, 27, 14, 0, 0);
const url = (chain: string, id: string): string => `https://explorer.example/${chain}/${id}`;
const tx = (chain: TxRef['chain'], id: string): TxRef => ({ chain, id, url: url(chain, id) });

const progress = (step: RescueProgress['step'], elapsedS: number, extra: Partial<RescueProgress> = {}): RescueProgress => ({
  id: 'r1',
  from: 'phoenix',
  to: 'hyperliquid',
  amountUsd: 120,
  step,
  startedAt: T0,
  elapsedS,
  tx: [],
  ...extra,
});

const states = (step: RescueProgress['step'], failedAt: StepId | null = null) => STEPS.map((id) => stepStates(step, failedAt)[id]);

// ---------- the step mapping ----------

test('a running rescue has the steps before it done, its own step now and the rest to do', () => {
  assert.deepEqual(states('detect'), ['now', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(states('sign'), ['done', 'done', 'done', 'done', 'now', 'todo', 'todo']);
  assert.deepEqual(states('deposit'), ['done', 'done', 'done', 'done', 'done', 'now', 'todo']);
});

test('a landed rescue has all seven steps done', () => {
  assert.deepEqual(states('landed'), Array(7).fill('done'));
});

test('a failed rescue shows which step failed: the ones before it done, the ones after it not started', () => {
  assert.deepEqual(states('failed', 'quote'), ['done', 'done', 'fail', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(states('failed', 'detect'), ['fail', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(states('failed', 'deposit'), ['done', 'done', 'done', 'done', 'done', 'fail', 'todo']);
});

test('a failed rescue whose step is not known claims no step: nothing is marked done or failed', () => {
  assert.deepEqual(states('failed', null), Array(7).fill('todo'));
});

test('the failed step comes from the desk first, then from the last step the page saw', () => {
  const failure: RescueFailure = { rescueId: 'r1', step: 'verify', reason: 'x', tries: 2, next: 'y', at: T0 };
  let book: StepBook = emptyBook;
  book = observe(book, progress('detect', 0));
  book = observe(book, progress('source', 0.2));
  book = observe(book, progress('quote', 0.9));
  const failed = progress('failed', 61);
  assert.equal(failedStep(failed, failure, book), 'verify');
  assert.equal(failedStep(failed, null, book), 'quote');
  assert.equal(failedStep(failed, { ...failure, rescueId: 'older' }, book), 'quote', 'a failure of another rescue is not this one');
  assert.equal(failedStep(failed, null, emptyBook), null);
  assert.equal(failedStep(progress('sign', 5), failure, book), null, 'a running rescue has no failed step');
});

test('the desk\'s failure belongs to a rescue only when the ids agree', () => {
  const failure: RescueFailure = { rescueId: 'r1', step: 'quote', reason: 'r', tries: 3, next: 'n', at: T0 };
  const desk = { rescueFailure: failure } as DeskState;
  assert.equal(failureOf(progress('failed', 9), desk), failure);
  assert.equal(failureOf(progress('failed', 9, { id: 'r2' }), desk), null);
  assert.equal(failureOf(progress('failed', 9), { rescueFailure: null } as DeskState), null);
  assert.equal(failureOf(progress('failed', 9), null), null);
});

// ---------- the time each step took ----------

test('steps seen from the start are timed: done steps by the next step\'s start, the running one by the clock', () => {
  let book: StepBook = emptyBook;
  for (const [step, at] of [['detect', 0], ['source', 0.1], ['quote', 0.5], ['verify', 1.7], ['sign', 2.0]] as const) book = observe(book, progress(step, at));
  const p = progress('sign', 2.0);
  assert.equal(stepSeconds(book, 'source', 'done', p, 6.2)?.toFixed(1), '0.4');
  assert.equal(stepSeconds(book, 'quote', 'done', p, 6.2)?.toFixed(1), '1.2');
  assert.equal(stepSeconds(book, 'verify', 'done', p, 6.2)?.toFixed(1), '0.3');
  assert.equal(stepSeconds(book, 'sign', 'now', p, 6.2)?.toFixed(1), '4.2', 'the running step counts up from where it began');
  assert.equal(stepSeconds(book, 'deposit', 'todo', p, 6.2), null);
});

test('a page opened mid-step does not time that step, nor invent a start for it when the step repeats', () => {
  let book: StepBook = emptyBook;
  book = observe(book, progress('sign', 31));
  book = observe(book, progress('sign', 33));
  assert.equal(stepSeconds(book, 'sign', 'now', progress('sign', 33), 40), null);
  book = observe(book, progress('deposit', 36));
  assert.equal(stepSeconds(book, 'sign', 'done', progress('deposit', 36), 40), null, 'its start was never seen');
  assert.equal(stepSeconds(book, 'deposit', 'now', progress('deposit', 36), 40), 4);
});

test('a skipped step is not timed from the one after it', () => {
  let book: StepBook = emptyBook;
  book = observe(book, progress('detect', 0));
  book = observe(book, progress('quote', 3));
  assert.equal(stepSeconds(book, 'detect', 'done', progress('quote', 3), 4), null, 'source was never seen, so detect alone cannot take 3 s');
});

test('a failed step is timed from its start to the failure', () => {
  let book: StepBook = emptyBook;
  book = observe(book, progress('detect', 0));
  book = observe(book, progress('source', 0));
  book = observe(book, progress('quote', 0.4));
  book = observe(book, progress('failed', 61));
  assert.equal(stepSeconds(book, 'quote', 'fail', progress('failed', 61), 61)?.toFixed(1), '60.6');
});

test('a new rescue id starts a new book', () => {
  let book: StepBook = emptyBook;
  book = observe(book, progress('detect', 0));
  book = observe(book, progress('source', 0.4));
  const next = observe(book, progress('detect', 0, { id: 'r2' }));
  assert.equal(next.id, 'r2');
  assert.deepEqual(next.starts, { detect: 0 });
});

// ---------- the timer ----------

test('the timer counts up from startedAt, once a second', () => {
  const p = progress('sign', 4);
  assert.equal(clockText(timerSeconds(p, T0 + 31_000)), '0:31');
  assert.equal(clockText(timerSeconds(p, T0 + 32_000)), '0:32');
  assert.equal(clockText(timerSeconds(p, T0 + 72_400)), '1:12');
});

test('the timer is never behind the engine\'s own count, and never negative', () => {
  assert.equal(timerSeconds(progress('sign', 12), T0 + 3_000), 12);
  assert.equal(timerSeconds(progress('detect', 0), T0 - 5_000), 0);
});

test('a rescue that ended stops the timer at the engine\'s last count, whatever the clock says', () => {
  assert.equal(clockText(timerSeconds(progress('landed', 52), T0 + 600_000)), '0:52');
  assert.equal(clockText(timerSeconds(progress('failed', 72), T0 + 600_000)), '1:12');
});

test('clock and duration text', () => {
  assert.equal(clockText(0), '0:00');
  assert.equal(clockText(59.9), '0:59');
  assert.equal(clockText(3723), '1:02:03');
  assert.equal(durationText(0.4), '0.4 s');
  assert.equal(durationText(42), '42 s');
  assert.equal(durationText(107), '1 min 47 s');
  assert.equal(durationText(120), '2 min');
});

// ---------- the words ----------

test('every step has a sentence, and the source never names a withdrawal from a venue the desk does not use', () => {
  const p = progress('sign', 5);
  for (const id of STEPS) assert.ok(stepText(id, { p, leg: null, line: 8 }).length > 0);
  assert.match(stepText('source', { p, leg: null, line: 8 }), /^Phoenix free margin pays/);
  assert.match(stepText('source', { p: progress('sign', 5, { from: 'reserve' }), leg: null, line: 8 }), /^The reserve pays/);
  assert.match(stepText('detect', { p, leg: null, line: 8 }), /8% rescue line/);
  assert.match(stepText('quote', { p, leg: null, line: null }), /\$120\.00 to Hyperliquid margin/);
});

test('a failure says why, how many tries and what the desk does next', () => {
  const failure: RescueFailure = { rescueId: 'r1', step: 'quote', reason: 'No route for $120 within 30 s', tries: 2, next: 'Trying $40 from the reserve', at: T0 };
  assert.equal(failText(failure), 'No route for $120 within 30 s.');
  assert.equal(failText(null), 'The desk did not say why it stopped.');
  assert.deepEqual(movingOf(progress('failed', 61), failure), { label: 'The desk tries next', amount: null, text: 'Trying $40 from the reserve.' });
  assert.deepEqual(movingOf(progress('sign', 5), null), {
    label: 'Moving',
    amount: '$120.00',
    text: 'Phoenix free margin → Hyperliquid margin, through NEAR Intents',
  });
  // Each label names what the engine's amount is at that step: the need, what is sent, what landed after fees.
  assert.equal(movingOf(progress('detect', 0), null).label, 'The leg needs');
  assert.equal(movingOf(progress('source', 1), null).label, 'Moving');
  assert.equal(movingOf(progress('landed', 52, { from: 'reserve' }), null).label, 'Moved');
  assert.match(movingOf(progress('sign', 5, { from: 'reserve' }), null).text, /^Reserve → Hyperliquid margin/);
});

test('the distance note compares with the owner\'s rescue line', () => {
  assert.equal(distanceNote(7.9, 8), 'inside your 8% rescue line');
  assert.equal(distanceNote(16.1, 8), 'clear of your 8% rescue line');
  assert.equal(distanceNote(7.9, null), 'to liquidation');
  assert.equal(distanceNote(null, 8), 'the venue gives no distance right now');
});

// ---------- transactions ----------

test('transactions sit at the steps they belong to, and only once that step is reached', () => {
  const near = tx('near', 'n1');
  const sol = tx('solana', 's1');
  const hl = tx('hyperliquid', 'h1');
  const ids = (p: RescueProgress) => {
    const by = txByStep(p, CHAIN_OF[p.to]);
    return STEPS.map((id) => by[id].map((l) => l.short).join(','));
  };
  assert.deepEqual(ids(progress('verify', 2)), ['', '', '', '', '', '', '']);
  assert.deepEqual(ids(progress('sign', 3, { tx: [near] })), ['', '', '', '', 'n1', '', '']);
  assert.deepEqual(ids(progress('deposit', 9, { tx: [near, sol] })), ['', '', '', '', 'n1', 's1', '']);
  assert.deepEqual(ids(progress('landed', 52, { tx: [near, sol, hl] })), ['', '', '', '', 'n1', 's1', 'h1']);
});

test('a link that is not an http address is left out', () => {
  const bad: TxRef = { chain: 'near', id: 'x', url: 'javascript:alert(1)' };
  const by = txByStep(progress('sign', 3, { tx: [bad] }), 'hyperliquid');
  assert.deepEqual(by.sign, []);
});

test('each link opens the TxRef url as it was given', () => {
  const by = txByStep(progress('sign', 3, { tx: [tx('near', 'abc')] }), 'hyperliquid');
  assert.equal(by.sign[0]?.href, url('near', 'abc'));
});

// ---------- earlier rescues ----------

const rescueEntry = (id: string, t: number, usd: number, landedS: number | null): JournalEntry => ({
  id,
  t,
  kind: 'rescue',
  summary: `Moved ${id}`,
  numbers: { usd, ...(landedS === null ? {} : { landedS }) },
  tx: [],
});

test('earlier rescues are the journal\'s, newest first, older than this one; the usual time is their median', () => {
  const journal: JournalEntry[] = [
    rescueEntry('a', T0 - 5 * 86_400_000, -0.28, 51),
    rescueEntry('b', T0 - 1 * 86_400_000, -0.32, 52),
    rescueEntry('c', T0 - 5.4 * 86_400_000, -0.21, 107),
    rescueEntry('now', T0 + 60_000, -0.3, 40),
    { id: 'f', t: T0 - 1000, kind: 'funding', summary: 's', numbers: { usd: 0.1 }, tx: [] },
  ];
  assert.deepEqual(earlierRows(journal, T0).map((r) => r.id), ['b', 'a', 'c']);
  assert.equal(usualSeconds(journal, T0), 52);
  assert.equal(usualSeconds(journal, null), 51.5, 'with this one counted the median moves');
  assert.equal(feesText(journal, T0), 'Fees were $0.21 to $0.32 each.');
  assert.equal(usualSeconds([], T0), null);
  assert.equal(feesText([], T0), null);
});

// ---------- the stress test ----------

test('Stress is hidden on mainnet: no button at all, only why', () => {
  const view = stressView('mainnet', false, false);
  assert.equal(view.button, null);
  assert.match(view.note, /mainnet/);
  assert.equal(canStress('mainnet'), false);
});

test('Stress is hidden while the network is not known: it is never assumed to be a testnet', () => {
  assert.equal(stressView(null, false, false).button, null);
  assert.equal(canStress(null), false);
});

test('Stress shows on testnet and in replay, disabled while a rescue runs or the request is out', () => {
  for (const mode of ['testnet', 'replay'] as const) {
    assert.deepEqual(stressView(mode, false, false).button, { label: 'Run a stress test', disabled: false });
    assert.equal(stressView(mode, true, false).button?.disabled, true);
    assert.match(stressView(mode, true, false).note, /rescue is running/);
    assert.deepEqual(stressView(mode, false, true).button, { label: 'Sending…', disabled: true });
    assert.equal(canStress(mode), true);
  }
});

test('the answer to POST /stress is said in the owner\'s words', () => {
  assert.equal(stressOutcome({ ok: true }).tone, 'sent');
  const refused = stressOutcome({ ok: false, reason: 'the strategy engine is not running yet' });
  assert.equal(refused.tone, 'refused');
  assert.match(refused.text, /The strategy engine is not running yet\. Nothing changed\.$/);
  assert.equal(stressOutcome(new Error('boom')).tone, 'unknown');
});
