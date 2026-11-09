import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '@gimbal/shared';
import { fundingText, holdText, incidentText, smallUsd, storyOf, storyTime } from './story.ts';

const at = (hhmm: string): number => Date.parse(`2026-11-09T${hhmm}:00Z`);
const OPEN = at('03:08');
const W = 'mon-phoenix-hyperliquid';

let n = 0;
const entry = (t: number, kind: JournalEntry['kind'], summary: string, numbers: JournalEntry['numbers'] = {}): JournalEntry => ({
  id: `e${(n += 1)}`, t, kind, summary, numbers, tx: [],
});
const hold = (hhmm: string, stale = false): JournalEntry =>
  entry(at(hhmm), 'wait', stale ? 'Hold MON: its numbers are stale this scan, so nothing is decided on them; day 1 of 14' : 'Hold MON: 49.0 % net of the exit, at least your 5 % minimum; day 1 of 14', {
    action: 'hold', window: W, hoursHeld: Number(((at(hhmm) - OPEN) / 3_600_000).toFixed(2)),
  });

const newestFirst = (entries: JournalEntry[]): JournalEntry[] => [...entries].sort((a, b) => b.t - a.t);

test('every hold check of one pair is one holding period, from when the pair opened', () => {
  const entries = newestFirst([
    hold('03:56'), hold('04:10', true), hold('04:30'),
    entry(at('04:05'), 'funding', 'funding MON 2026-11-09T04:00Z: hyperliquid +0.0001, phoenix +0.0014; +0.0016 USD', { usd: 0.001574, hyperliquidUsd: 0.000142, phoenixUsd: 0.001432, window: W }),
    hold('05:19'),
  ]);
  const story = storyOf(entries, W);
  const holds = story.filter((i) => i.type === 'hold');
  assert.equal(holds.length, 1);
  assert.equal(holds[0]!.text, 'Holding MON since 03:08, checked 4 times since 03:56');
  assert.ok(Math.abs(storyTime(holds[0]!) - OPEN) < 60_000, 'the line shows when the pair opened');
  // No line says the numbers were stale: a check is a check.
  assert.ok(story.every((i) => !('text' in i) || !/stale/.test(i.text)));
  assert.deepEqual(story.map((i) => i.type), ['hold', 'funding']);
});

test('a period that ended reads "Held … from … to …"; a complete one gives the count alone', () => {
  assert.equal(holdText({ symbol: 'MON', from: OPEN, firstCheck: at('03:09'), t: at('09:10'), checks: 46, ongoing: false }), 'Held MON from 03:08 to 09:10, checked 46 times');
  assert.equal(holdText({ symbol: 'MON', from: OPEN, firstCheck: at('03:09'), t: at('03:09'), checks: 1, ongoing: true }), 'Holding MON since 03:08, checked once');
  const ended = storyOf(newestFirst([hold('03:10'), hold('03:20')]), null);
  assert.equal(ended[0]!.type === 'hold' && ended[0]!.ongoing, false);
});

test('funding in words, largest leg first, with four decimals under a cent', () => {
  const e = entry(at('05:05'), 'funding', 'funding MON …', { usd: 0.001575, hyperliquidUsd: 0.000143, phoenixUsd: 0.001432, hyperliquidRatePerHour: 0.0000125 });
  assert.equal(fundingText(e), 'Funding paid +$0.0016: Phoenix +$0.0014, Hyperliquid +$0.0001');
  assert.equal(fundingText(entry(0, 'funding', 'x', { usd: -0.3, orderlyUsd: -0.3 })), 'Funding cost −$0.30: Orderly −$0.30');
  assert.equal(smallUsd(0), '$0.0000');
  assert.equal(fundingText(entry(0, 'funding', 'x', { usd: 0.0021, phoenixUsd: 0.0021, hyperliquidUsd: 0.00001 })), 'Funding paid +$0.0021: Phoenix +$0.0021');
});

test('an outage is an incident with its recovery', () => {
  const down = entry(at('04:23'), 'error', 'hyperliquid not answering for 33 s: the scan could not read it', { venue: 'hyperliquid', downS: 33 });
  const back = entry(at('04:24'), 'wait', 'hyperliquid answering again after 81 s unreadable (since 04:22:52 UTC)', { venue: 'hyperliquid', downS: 81 });
  assert.equal(incidentText(down, back), 'Hyperliquid did not answer for 33 s; read again at 04:24');
  const story = storyOf(newestFirst([down, back]));
  assert.deepEqual(story.map((i) => (i.type === 'incident' ? i.text : i.type)), ['Hyperliquid did not answer for 33 s; read again at 04:24']);
  // Its outage scrolled off the page: the recovery still says what happened.
  const alone = storyOf([back]);
  assert.equal(alone[0]!.type === 'incident' && alone[0]!.text, 'Hyperliquid answers again after 81 s');
});

test('other waits in a row still fold into one run; a trade or a refusal stays its own line', () => {
  const story = storyOf(newestFirst([
    entry(at('01:00'), 'wait', 'Wait: no window clears your 5 % minimum', { action: 'wait' }),
    entry(at('01:05'), 'wait', 'Wait: no window clears your 5 % minimum', { action: 'wait' }),
    entry(at('03:08'), 'enter', 'Opened MON', {}),
  ]));
  assert.deepEqual(story.map((i) => i.type), ['entry', 'waits']);
  assert.equal(story[1]!.type === 'waits' && story[1]!.entries.length, 2);
});
