import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState, JournalEntry, Leg } from '@gimbal/shared';
import { incidentsText, journalHeadline, periodFacts, type HoldItem } from './period.ts';
import { heldSymbolOf, latestOf, storyOf } from './story.ts';

const at = (hhmm: string): number => Date.parse(`2026-11-09T${hhmm}:00Z`);
const OPEN = at('03:08');
const NOW = at('05:21');
const W = 'mon-phoenix-hyperliquid';

let n = 0;
const entry = (t: number, kind: JournalEntry['kind'], summary: string, numbers: JournalEntry['numbers'] = {}): JournalEntry => ({
  id: `p${(n += 1)}`, t, kind, summary, numbers, tx: [],
});
const hold = (hhmm: string, net: number, bad = 0): JournalEntry =>
  entry(at(hhmm), 'wait', 'Hold MON: 49.0 % net of the exit; day 1 of 14', {
    action: 'hold', window: W, hoursHeld: Number(((at(hhmm) - OPEN) / 3_600_000).toFixed(2)), heldNetAprPct: net, badChecks: bad, exitAfterChecks: 6, pnlUsd: -0.0002,
  });
const down = (hhmm: string, s: number) => entry(at(hhmm), 'error', `hyperliquid not answering for ${s} s`, { venue: 'hyperliquid', downS: s });
const back = (hhmm: string) => entry(at(hhmm), 'wait', 'hyperliquid answering again after 60 s unreadable', { venue: 'hyperliquid', downS: 60 });
const newestFirst = (entries: JournalEntry[]): JournalEntry[] => [...entries].sort((a, b) => b.t - a.t);

const leg = (side: 'long' | 'short', venue: Leg['venue']): Leg => ({
  venue, symbol: 'MON', side, size: 716, lotSize: 1, entry: 0.0167, mark: 0.0167, liqPx: null, marginUsd: 4, marginRatio: 0.1,
  distanceToLiqPct: 50, fundingEarnedUsd: 0, unsettledFundingUsd: 0, feesUsd: 0, unpriced: false,
});
const desk: Pick<DeskState, 'legs' | 'pnl'> = {
  legs: [leg('short', 'hyperliquid'), leg('long', 'phoenix')],
  pnl: { fundingUsd: 0.0031, feesUsd: -0.0068, priceUsd: 0.0036, netUsd: -0.0001 },
};

test('the Journal opens with the period: since when, the funding, the outages and their recovery', () => {
  const entries = newestFirst([hold('03:56', 42.2), down('04:18', 31), back('04:19'), down('04:23', 33), back('04:24'), hold('05:19', 109.2)]);
  const story = storyOf(entries, W);
  assert.equal(journalHeadline(story, 0.0031, NOW), 'Holding MON since 03:08. Funding paid +$0.0031; Hyperliquid did not answer twice and came back.');
  // Funding that rounds to nothing and no outage: the sentence is the period alone.
  assert.equal(journalHeadline(storyOf([hold('05:19', 50)], W), 0.00001, NOW), 'Holding MON since 03:08.');
  // A pair held since an earlier day says the day.
  assert.equal(journalHeadline(storyOf([hold('05:19', 50)], W), null, NOW + 86_400_000), 'Holding MON since 9 Nov 03:08.');
  // Nothing held now: no period sentence; the screen says what the contract signed instead.
  assert.equal(journalHeadline(storyOf([hold('05:19', 50)], null), 0.0031, NOW), null);
});

test('an outage with no recovery yet is said as it is, not as "came back"', () => {
  const story = storyOf(newestFirst([down('04:23', 33)]));
  const incidents = story.filter((i) => i.type === 'incident');
  assert.equal(incidentsText(incidents), 'Hyperliquid did not answer at 04:23');
  assert.equal(incidentsText([]), null);
});

test('the period unfolds to its facts; money is coloured, fees stay neutral', () => {
  const attest = entry(at('04:40'), 'wait', 'NEAR AI attestation of the model: verified TDX quote, not debug', { stage: 'attestation' });
  const entries = newestFirst([hold('03:56', 42.2), hold('04:56', 109.2, 1), hold('05:19', 80), attest]);
  const item = storyOf(entries, W).find((i): i is HoldItem => i.type === 'hold')!;
  const facts = periodFacts(item, { entries, desk, now: NOW });
  assert.deepEqual(
    facts.map((f) => [f.label, f.value, f.tone]),
    [
      ['Short Hyperliquid, long Phoenix', '716 MON a leg', null],
      ['Held for', '2 h so far', null],
      ['Checks', '3 since 03:56, each one held', null],
      ['Net a year at those checks', '42.2% to 109.2%', null],
      ['Checks against it', '0 of the 6 in a row that would close it', null],
      ['Funding paid', '+$0.0031', 'up'],
      ['Fees', '−$0.0068', null],
      ['Net so far, after fees and price', '−$0.0001', 'down'],
      ['Risk model attested', '1 time, a verified TDX quote', null],
    ],
  );
});

test('an ended period gives its own numbers, never the desk P&L of another pair', () => {
  const entries = newestFirst([hold('03:56', 42.2), hold('05:19', 80)]);
  const item = storyOf(entries, null).find((i): i is HoldItem => i.type === 'hold')!;
  const facts = periodFacts(item, { entries, desk, now: NOW });
  assert.ok(!facts.some((f) => f.label === 'Funding paid' || f.label.startsWith('Short ')));
  assert.deepEqual(facts.find((f) => f.label === 'Held for')?.value, '2 h');
  assert.deepEqual(facts.at(-1), { label: 'Net at the last check', value: '−$0.0002', tone: 'down' });
});

test('right after an engine restart (windows not read yet) the open legs keep the period "Holding", not "Held … to …"', () => {
  const entries = newestFirst([hold('03:56', 42.2), hold('05:19', 50)]);
  const holdOf = (s: ReturnType<typeof storyOf>) => s.find((i): i is HoldItem => i.type === 'hold')!;
  // No window and no legs: the page cannot tell, so the period reads as ended (as before).
  assert.equal(holdOf(storyOf(entries, null, null)).text, 'Held MON from 03:08 to 05:19, checked 2 times since 03:56');
  // No window yet, but the desk's legs are MON: still held.
  assert.equal(holdOf(storyOf(entries, null, 'MON')).text, 'Holding MON since 03:08, checked 2 times since 03:56');
  // Legs of another symbol: the MON period ended.
  assert.equal(holdOf(storyOf(entries, null, 'XPL')).ongoing, false);
  // Once the windows are read, the window wins over the symbol.
  assert.equal(holdOf(storyOf(entries, 'xpl-phoenix-hyperliquid', 'MON')).ongoing, false);
});

test("the Desk's Latest leaves out the NEAR AI attestation line; the Journal keeps it", () => {
  const att = entry(at('05:20'), 'wait', 'NEAR AI attestation of a model: verified TDX quote', { stage: 'attestation' });
  const story = storyOf(newestFirst([hold('05:19', 50), down('04:23', 33), back('04:24'), att]), W, 'MON');
  assert.ok(story.some((i) => i.type === 'entry' && i.entry.id === att.id));
  const latest = latestOf(story);
  assert.equal(latest.some((i) => i.type === 'entry' && i.entry.id === att.id), false);
  assert.deepEqual(latest.map((i) => i.type), ['hold', 'incident']);
  // A failed attestation is an error the Desk still shows.
  const failed = entry(at('05:21'), 'error', 'NEAR AI attestation failed: quote not verified', { stage: 'attestation' });
  const withFailed = latestOf(storyOf(newestFirst([hold('05:19', 50), failed]), W, 'MON'));
  assert.ok(withFailed.some((i) => i.type === 'entry' && i.entry.id === failed.id));
});

test("the Desk's Latest leaves out the engine's start-up notes; the Journal keeps them, and errors stay", () => {
  const session = entry(at('05:20'), 'wait', 'orderly session starting: its account is read once the session is up', { venue: 'orderly' });
  const waitsSession = entry(at('05:21'), 'wait', 'pair start waits for the Orderly session, which is still opening', { stage: 'start', venue: 'orderly' });
  const confirmed = entry(at('05:22'), 'wait', 'pair start confirmed after 1 failed attempt(s): both legs synced', { stage: 'start' });
  const all = newestFirst([down('04:23', 33), back('04:24'), hold('05:19', 50), session, waitsSession, confirmed]);
  const story = storyOf(all, W, 'MON');
  const shownIds = (items: ReturnType<typeof storyOf>) => items.flatMap((i) => (i.type === 'waits' ? i.entries.map((e) => e.id) : 'entry' in i && i.entry ? [i.entry.id] : []));
  // The Journal keeps every note.
  for (const e of [session, waitsSession, confirmed]) assert.ok(shownIds(story).includes(e.id));
  // The Desk shows the period and the incident, none of the notes.
  const latest = latestOf(story);
  assert.deepEqual(latest.map((i) => i.type), ['hold', 'incident']);
  // A pair start that failed is an error: it stays on the Desk.
  const refused = entry(at('05:23'), 'error', 'pair start refused: the legs differ', { stage: 'start' });
  assert.ok(latestOf(storyOf(newestFirst([...all, refused]), W, 'MON')).some((i) => i.type === 'entry' && i.entry.id === refused.id));
  // A venue answering again is not a note: it is the incident's recovery.
  assert.ok(latest.some((i) => i.type === 'incident'));
  // On a flat desk a run of waits mixes notes and real waits: the line is read from the real waits only.
  const quiet = entry(at('05:10'), 'wait', 'No market pays your 5 % minimum', { action: 'wait' });
  const run = latestOf(storyOf(newestFirst([quiet, session, confirmed]), null, null));
  assert.equal(run.length, 1);
  assert.ok(run[0]!.type === 'waits' && run[0]!.entries.length === 1 && run[0]!.entries[0]!.id === quiet.id);
  // That shortened run shows its own time and sits in time order, under a newer hold check.
  const ordered = latestOf(storyOf(newestFirst([quiet, hold('05:19', 50), session]), null, 'MON'));
  assert.deepEqual(ordered.map((i) => i.t), [at('05:19'), at('05:10')]);
});

test('a start-stage error keeps its recovery on the Desk (rescue started, pair start confirmed)', () => {
  const failed = entry(at('05:20'), 'error', 'rescue: the live rescuer did not start (timeout): detect only for now', { stage: 'start' });
  const started = entry(at('05:21'), 'wait', 'rescue: the live rescuer started after 1 failed attempt(s)', { stage: 'start' });
  const notConfirmed = entry(at('05:22'), 'error', 'pair start not confirmed: hyperliquid read timed out', { stage: 'start' });
  const confirmed = entry(at('05:23'), 'wait', 'pair start confirmed after 1 failed attempt(s): both legs synced', { stage: 'start' });
  const ids = (items: ReturnType<typeof storyOf>) => items.flatMap((i) => (i.type === 'waits' ? i.entries.map((e) => e.id) : 'entry' in i && i.entry ? [i.entry.id] : []));
  const latest = ids(latestOf(storyOf(newestFirst([hold('05:19', 50), failed, started, notConfirmed, confirmed]), W, 'MON'), 4));
  for (const e of [failed, started, notConfirmed, confirmed]) assert.ok(latest.includes(e.id), e.summary);
  // The same confirmation after a plain wait (the Orderly session opening) is a note.
  const waiting = entry(at('05:22'), 'wait', 'pair start waits for the Orderly session, which is still opening', { stage: 'start', venue: 'orderly' });
  assert.equal(ids(latestOf(storyOf(newestFirst([hold('05:19', 50), waiting, confirmed]), W, 'MON'))).includes(confirmed.id), false);
});

test('a closed period never reads "Holding": not after a re-entry of the same coin, nor of the same window', () => {
  const W2 = 'mon-orderly-hyperliquid';
  const holdOn = (w: string, hhmm: string, opened: string): JournalEntry =>
    entry(at(hhmm), 'wait', 'Hold MON: 49.0 % net of the exit; day 1 of 14', { action: 'hold', window: w, hoursHeld: Number(((at(hhmm) - at(opened)) / 3_600_000).toFixed(2)) });
  const exitOf = (w: string, hhmm: string) => entry(at(hhmm), 'exit', 'Exit MON', { window: w });
  const holdsOf = (s: ReturnType<typeof storyOf>) => s.filter((i): i is HoldItem => i.type === 'hold');
  // MON closed on W at 04:05 and opened on W2 at 04:06; the engine restarts before W2's first check.
  const reentered = newestFirst([holdOn(W, '03:30', '03:08'), holdOn(W, '04:00', '03:08'), exitOf(W, '04:05')]);
  assert.match(holdsOf(storyOf(reentered, null, 'MON'))[0]!.text, /^Held MON from 03:0[78] to 04:00, checked 2 times/);
  // The same window re-entered, no check yet: the old period has ended too.
  assert.equal(holdsOf(storyOf(reentered, W, 'MON'))[0]!.ongoing, false);
  // Two MON windows, no close between: without the window, only the newest period is held.
  const two = newestFirst([holdOn(W, '03:30', '03:08'), holdOn(W2, '05:00', '04:06')]);
  const items = holdsOf(storyOf(two, null, 'MON'));
  assert.deepEqual(items.map((i) => [i.t === at('05:00'), i.ongoing]), [[true, true], [false, false]]);
});

test("the held coin comes from the legs in the hold checks' words (Orderly's PERP_MON_USDC is MON)", () => {
  assert.equal(heldSymbolOf([]), null);
  assert.equal(heldSymbolOf([{ symbol: 'PERP_MON_USDC' }]), 'MON');
  assert.equal(heldSymbolOf([{ symbol: 'MON' }, { symbol: 'PERP_MON_USDC' }]), 'MON');
  // A stray leg first: the coin two legs share wins.
  assert.equal(heldSymbolOf([{ symbol: 'XPL' }, { symbol: 'MON' }, { symbol: 'PERP_MON_USDC' }]), 'MON');
});
