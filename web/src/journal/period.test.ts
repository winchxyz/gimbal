import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState, JournalEntry, Leg } from '@gimbal/shared';
import { incidentsText, journalHeadline, periodFacts, type HoldItem } from './period.ts';
import { storyOf } from './story.ts';

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
  assert.equal(journalHeadline(story, 0.0031, NOW), 'Holding MON since 03:08. Funding paid +$0.0031; Hyperliquid missed two reads and came back.');
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
