// The fake must produce every state the Windows screen has, shaped like the shared types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StreamEvent } from '@gimbal/shared';
import { arrange, isEmpty, rowStatus } from '../windows/model.ts';
import { totalCosts } from '../windows/model.ts';
import { FAKE_FAILED_VENUES, FAKE_STRATEGY, FAKE_VENUE_COUNT, fakeApi, fakeScan, fakeWindows, type Scenario } from './fake-windows.ts';
import { startFakeStream } from './fake.ts';
import { initialStreamState, parseStreamEvent, reduceStream, type StreamAction } from './store.ts';

const T0 = Date.UTC(2026, 9, 27, 14, 0);
const make = (scenario: Scenario, tick = 0, drift = false) => fakeWindows(T0, tick, { scenario, startedAt: T0, drift });

test('normal: a held, a risk-check-refused and a refused window, watch-only rows and a missing 7-day figure', () => {
  const ws = make('normal');
  assert.equal(ws.filter((w) => w.held).length, 1);
  assert.equal(ws.filter((w) => w.veto?.verdict === 'veto').length, 1);
  assert.equal(ws.filter((w) => w.refused).length, 1);
  assert.ok(ws.filter((w) => !w.tradable).length >= 3);
  assert.ok(ws.some((w) => w.grossApr7dPct === null));
  assert.ok(ws.every((w) => !w.stale));
  assert.equal(new Set(ws.map((w) => w.id)).size, ws.length, 'ids are unique, even for the same symbol on other venues');
  assert.equal(rowStatus(ws.find((w) => w.held)!).text, 'Held');
  assert.equal(rowStatus(ws.find((w) => w.refused)!).text, 'Refused · no trusted price');
  assert.equal(rowStatus(ws.find((w) => w.veto?.verdict === 'veto')!).text, 'Risk check · one-off spike');
});

test('normal: net is gross minus costs, rotation costs are set while something is held, and it matches the mockup order', () => {
  const ws = make('normal');
  for (const w of ws.filter((x) => x.tradable)) {
    assert.ok(Math.abs(w.grossAprPct - totalCosts(w) - w.netAprPct) < 0.051, `${w.symbol}: gross - costs = net`);
    if (w.held) assert.equal(w.switchCostUsd, null);
    else assert.equal(w.switchCostUsd, 1.1);
    assert.ok(w.checks.length > 0);
  }
  for (const w of ws.filter((x) => !x.tradable)) {
    assert.equal(w.switchCostUsd, null);
    assert.deepEqual(w.checks, []);
  }
  const rows = arrange(ws, 'tradable', FAKE_STRATEGY.minNetAprPct).rows.map((w) => w.symbol);
  assert.deepEqual(rows, ['ZRO', 'DOGE', 'AVAX', 'SOL', 'NEAR', 'LTC', 'BTC', 'ETH']);
  assert.equal(arrange(ws, 'tradable', FAKE_STRATEGY.minNetAprPct).ruleAt, 6);
  assert.equal(isEmpty(ws, FAKE_STRATEGY.minNetAprPct), false);
});

test('error: three venues did not answer and the windows that need them are stale and older', () => {
  const ws = make('error');
  const scan = fakeScan(T0, 'error');
  assert.deepEqual(scan.failed, FAKE_FAILED_VENUES);
  assert.equal(scan.venues, FAKE_VENUE_COUNT);
  const stale = ws.filter((w) => w.stale);
  assert.ok(stale.length > 0 && stale.length < ws.length);
  for (const w of ws) {
    const needsFailed = FAKE_FAILED_VENUES.includes(w.longVenue) || FAKE_FAILED_VENUES.includes(w.shortVenue);
    assert.equal(w.stale, needsFailed, w.id);
    assert.equal(w.updatedAt < T0, w.stale);
  }
  assert.deepEqual(fakeScan(T0, 'normal').failed, []);
});

test('empty: nothing open to the desk clears the minimum, and nothing is held', () => {
  const ws = make('empty');
  assert.equal(isEmpty(ws, FAKE_STRATEGY.minNetAprPct), true);
  assert.ok(ws.every((w) => !w.held));
  assert.ok(ws.every((w) => w.switchCostUsd === null));
  assert.ok(ws.some((w) => w.refused) && ws.some((w) => w.veto?.verdict === 'veto'), 'high rows that are not open to the desk are still listed');
});

test('the rates swing with the tick unless drift is off', () => {
  const a = make('normal', 0, true).map((w) => w.grossAprPct);
  const b = make('normal', 20, true).map((w) => w.grossAprPct);
  assert.notDeepEqual(a, b);
  assert.deepEqual(make('normal', 0, false).map((w) => w.grossAprPct), make('normal', 20, false).map((w) => w.grossAprPct));
});

test('the history: 168 hourly points, oldest first, the same every time, ending at the window net', async () => {
  const api = fakeApi();
  const ws = make('normal');
  const sol = ws.find((w) => w.symbol === 'SOL')!;
  const h = await api.windowHistory(sol.id);
  assert.equal(h.windowId, sol.id);
  assert.equal(h.points.length, 168);
  for (let i = 1; i < h.points.length; i++) assert.equal(h.points[i]!.t - h.points[i - 1]!.t, 3_600_000);
  assert.equal(h.points.at(-1)!.netAprPct, sol.netAprPct);
  const again = await api.windowHistory(sol.id);
  assert.deepEqual(again.points.map((p) => p.netAprPct), h.points.map((p) => p.netAprPct));
  // a watch-only or unknown window has none
  await assert.rejects(api.windowHistory(ws.find((w) => !w.tradable)!.id), /no history/);
  await assert.rejects(api.windowHistory('nope'), /no history/);
  assert.deepEqual(await api.strategy(), FAKE_STRATEGY);
});

test('every event goes through the same parser as the engine stream', () => {
  for (const scenario of ['normal', 'empty', 'error'] as const) {
    const events: StreamEvent[] = [
      { type: 'windows', data: make(scenario) },
      { type: 'scan', data: fakeScan(T0, scenario) },
    ];
    for (const e of events) assert.ok(parseStreamEvent(JSON.stringify(e)), `${scenario} ${e.type}`);
  }
});

test('the fake stream sends windows and a scan; loading sends neither', () => {
  const run = (scenario: Scenario) => {
    const actions: StreamAction[] = [];
    startFakeStream((a) => actions.push(a), { mode: 'testnet', intervalMs: 60_000, scenario })();
    return actions.reduce(reduceStream, initialStreamState());
  };
  const normal = run('normal');
  assert.equal(normal.counts.windows, 1);
  assert.equal(normal.counts.scan, 1);
  assert.equal(normal.scan?.failed.length, 0);
  assert.equal(normal.windows?.length, 13);
  assert.equal(run('error').scan?.failed.length, 3);
  const loading = run('loading');
  assert.equal(loading.windows, null);
  assert.equal(loading.scan, null);
});
