import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { JournalEntry, StrategyConfig, StrategyDecision } from '@gimbal/shared';
import { net } from '../windows/testing.ts';
import { COOLDOWN_HOURS, conditionsOf, coolDownOf, hhmm, marketsNote, marketsPlot, spanText } from './flat.ts';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 10, 2, 0, 0);

const cooling = (at: number, left: string, rest = 'MON 26.5 % net, 3 of 3 hours above 5 %'): StrategyDecision => ({
  action: 'wait',
  reason: `Cooling down after the exit, ${left} h left; ${rest}`,
  windowId: 'mon-phoenix-hyperliquid',
  heldId: null,
  at,
});
const entry = (t: number, kind: JournalEntry['kind'], summary: string): JournalEntry => ({ id: `${kind}-${t}`, t, kind, summary, numbers: {}, tx: [] });
const STRATEGY = { auto: true, minNetAprPct: 5, enterAfterChecks: 3 } as StrategyConfig;

test('the cool-down the web draws is the engine’s own rule', () => {
  const source = readFileSync(new URL('../../../engine/src/strategy/decide.ts', import.meta.url), 'utf8');
  assert.match(source, new RegExp(`cooldownHours:\\s*${COOLDOWN_HOURS}\\b`));
  assert.match(source, /Cooling down after the exit, \$\{left\.toFixed\(1\)\} h left/);
});

test('one cooling line places the end within minutes; the exit is the cool-down before it', () => {
  const cool = coolDownOf(cooling(T0, '1.8'), [], T0)!;
  assert.equal(cool.until, T0 + 1.8 * HOUR);
  assert.equal(cool.exitAt, cool.until - COOLDOWN_HOURS * HOUR);
  assert.equal(cool.exact, false);
});

test('the journal’s cooling lines narrow the end, and its exit line gives the start to the second', () => {
  const exitAt = T0 - 4.2 * HOUR;
  const journal = [
    entry(T0 - 6 * 60_000, 'wait', 'Cooling down after the exit, 1.9 h left; MON 26.5 % net'),
    entry(T0 - 12 * HOUR, 'wait', 'Cooling down after the exit, 1.9 h left; an older exit'),
    entry(exitAt, 'exit', 'Closed MON'),
  ];
  const cool = coolDownOf(cooling(T0, '1.8'), journal, T0)!;
  // 1.8 h at T0 gives 1.75 to 1.85 h; 1.9 h six minutes before gives 1.75 to 1.85 h from T0 as well: no wider.
  assert.ok(Math.abs(cool.until - (T0 + 1.8 * HOUR)) <= 0.05 * HOUR);
  assert.equal(cool.exitAt, exitAt);
  assert.equal(cool.exact, true);
});

test('no cool-down: another reason, a held pair, or one that has run out', () => {
  assert.equal(coolDownOf(null, [], T0), null);
  assert.equal(coolDownOf({ ...cooling(T0, '1.8'), reason: 'no window clears the entry rules' }, [], T0), null);
  assert.equal(coolDownOf({ ...cooling(T0, '1.8'), action: 'hold' }, [], T0), null);
  assert.equal(coolDownOf(cooling(T0, '0.1'), [], T0 + HOUR), null);
});

test('time is said in full', () => {
  assert.equal(spanText(1.8 * HOUR), '1 h 48 min');
  assert.equal(spanText(40 * 60_000), '40 min');
  assert.equal(spanText(2 * HOUR), '2 h');
  assert.equal(spanText(-5), '0 min');
  assert.equal(hhmm(T0 + 94 * 60_000), '03:34');
});

test('the conditions: a market above the minimum, its checks, and the cool-down while one runs', () => {
  const windows = [net('MON', 25.6, { id: 'mon-phoenix-hyperliquid' }), net('BTC', 2)];
  const decision = cooling(T0, '1.8');
  const cool = coolDownOf(decision, [], T0);
  const conds = conditionsOf({ decision, windows, strategy: STRATEGY, cool, now: T0 });
  assert.deepEqual(conds, [
    { done: true, value: 'MON, 25.6% a year after costs', text: 'A market pays more than your 5% minimum' },
    { done: true, value: '3 of 3', text: 'It stays there for 3 hourly checks in a row' },
    { done: false, value: '1 h 48 min left, until 03:48 UTC', text: 'The 6-hour cool-down after the last exit is over' },
  ]);
});

test('with Auto off that comes first; with nothing above the minimum the best open market is shown as not there yet', () => {
  const conds = conditionsOf({ decision: null, windows: [net('BTC', 2)], strategy: { ...STRATEGY, auto: false }, cool: null, now: T0 });
  assert.equal(conds[0]!.value, 'Auto is off');
  assert.deepEqual(conds[1], { done: false, value: 'BTC, 2.0% a year after costs', text: 'A market pays more than your 5% minimum' });
  assert.deepEqual(conds[2], { done: false, value: '0 of 3', text: 'It stays there for 3 hourly checks in a row' });
  assert.equal(conditionsOf({ decision: null, windows: [], strategy: STRATEGY, cool: null, now: T0 })[0]!.value, 'None open to the desk');
});

test('the dot plot takes the open markets with their week in, best first, and always keeps the held one', () => {
  const windows = [
    net('A', 12),
    net('B', 9),
    net('C', 3),
    net('D', 2, { held: { since: T0, pnlUsd: 0 } as never }),
    net('NEW', 480, { grossApr7dPct: null }),
    net('X', 40, { tradable: false }),
  ];
  const plot = marketsPlot(windows, 5, 3);
  assert.deepEqual(plot.rows.map((r) => r.symbol), ['A', 'B', 'D']);
  assert.deepEqual(plot.rows.map((r) => r.under), [false, false, true]);
  assert.equal(plot.rows[2]!.held, true);
  assert.equal(plot.open, 4);
  assert.equal(plot.above, 2);
  assert.equal(marketsNote(plot, 5), '2 of 4 open markets pay more than 5%');
  assert.equal(marketsNote(marketsPlot([], 5), 5), 'no market is open to the desk');
  assert.equal(marketsNote(marketsPlot(windows, null), null), '4 open to the desk');
});
