// Alerts, histories, the engine API parsers and the route: the plain logic around the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertId, hasAlert, makeAlert, parseAlerts, reached, toggleAlert } from './alerts.ts';
import { HISTORY_RETRY_MS, HISTORY_TTL_MS, needsHistory, reduceHistory, type HistoryState } from './history.ts';
import { hashForWindow, windowIdFromHash } from './route.ts';
import { parseHistory, parseStrategy } from '../stream/api.ts';
import { net } from './testing.ts';

test('an alert fires when its window passes the one it had to pass, using the live number', () => {
  const doge = net('DOGE', 13.8);
  const sol = net('SOL', 8.6);
  const alert = makeAlert(sol, doge);
  assert.equal(alert.id, alertId(sol.id, doge.id));
  assert.deepEqual(reached([alert], [doge, sol]), []);
  const later = [net('DOGE', 13.8), net('SOL', 14.1)];
  const hit = reached([alert], later);
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.overNetAprPct, 13.8);
  // DOGE dropped: the live number is used, not the one stored when the alert was made
  assert.equal(reached([alert], [net('DOGE', 7), net('SOL', 8.6)]).length, 1);
  // DOGE is no longer listed: the stored number is used
  assert.equal(reached([alert], [net('SOL', 14.1)]).length, 1);
  assert.equal(reached([alert], [net('SOL', 13)]).length, 0);
  // its own window is gone: nothing to say
  assert.deepEqual(reached([alert], [doge]), []);
  // no 7-day spread yet: its net is one hour stated as a year, so it never fires, however high
  assert.deepEqual(reached([alert], [doge, net('SOL', 480, { grossApr7dPct: null })]), []);
});

test('alerts toggle on and off and survive a round trip through storage text', () => {
  const alert = makeAlert(net('SOL', 8.6), net('DOGE', 13.8));
  const on = toggleAlert([], alert);
  assert.equal(hasAlert(on, alert.windowId, alert.overId), true);
  assert.deepEqual(toggleAlert(on, alert), []);
  assert.deepEqual(parseAlerts(JSON.stringify(on)), on);
  assert.deepEqual(parseAlerts('not json'), []);
  assert.deepEqual(parseAlerts('{"a":1}'), []);
  assert.deepEqual(parseAlerts(null), []);
  assert.deepEqual(parseAlerts(JSON.stringify([{ id: 1 }, alert])), [alert]);
});

test('histories: a refresh keeps the last good line; fetch rules for fresh, stale and failed entries', () => {
  const history = { windowId: 'a', points: [{ t: 1, netAprPct: 2 }] };
  let state: HistoryState = {};
  assert.equal(needsHistory(state.a, 0), true);
  state = reduceHistory(state, { kind: 'start', id: 'a', at: 0 });
  assert.equal(needsHistory(state.a, 10 * HISTORY_TTL_MS), false); // in flight
  state = reduceHistory(state, { kind: 'ready', id: 'a', history, at: 100 });
  assert.equal(state.a?.status, 'ready');
  assert.equal(needsHistory(state.a, 100 + HISTORY_TTL_MS - 1), false);
  assert.equal(needsHistory(state.a, 100 + HISTORY_TTL_MS), true);
  state = reduceHistory(state, { kind: 'start', id: 'a', at: 500 });
  assert.equal(state.a?.history, history); // the old chart stays while it refreshes
  state = reduceHistory(state, { kind: 'error', id: 'a', error: 'GET /windows/history: 502', at: 600 });
  assert.equal(state.a?.status, 'error');
  assert.equal(state.a?.history, history);
  assert.equal(needsHistory(state.a, 600 + HISTORY_RETRY_MS - 1), false);
  assert.equal(needsHistory(state.a, 600 + HISTORY_RETRY_MS), true);
});

test('GET /strategy: every field or a clear error', () => {
  const rotate = { minGainPts: 3, forHours: 4 };
  const risk = { watchDistancePct: 15, rescueDistancePct: 8 };
  const base = { auto: true, minNetAprPct: 5, legUsd: 1200, maxLeverage: 3, stopDrawdownPct: null, rotate, risk };
  assert.deepEqual(parseStrategy({ ...base, extra: 1, rotate: { ...rotate, extra: 1 }, risk: { ...risk, extra: 1 } }), base);
  assert.throws(() => parseStrategy(null), /not an object/);
  assert.throws(() => parseStrategy({ ...base, auto: 'yes' }), /auto/);
  assert.throws(() => parseStrategy({ ...base, minNetAprPct: '5' }), /minNetAprPct/);
  assert.throws(() => parseStrategy({ ...base, stopDrawdownPct: undefined }), /stopDrawdownPct/);
  assert.throws(() => parseStrategy({ ...base, rotate: { minGainPts: 3 } }), /rotate/);
  assert.throws(() => parseStrategy({ ...base, risk: { watchDistancePct: 15 } }), /risk/);
});

test('GET /windows/history: points come back oldest first', () => {
  const h = parseHistory({ windowId: 'w', points: [{ t: 2, netAprPct: 1 }, { t: 1, netAprPct: 0 }] });
  assert.deepEqual(h.points.map((p) => p.t), [1, 2]);
  assert.throws(() => parseHistory({ windowId: 'w', points: [{ t: 1 }] }), /netAprPct/);
  assert.throws(() => parseHistory({ points: [] }), /windowId/);
  assert.throws(() => parseHistory([]), /points|windowId/);
});

test('#/windows/<id> names a window; the shell still reads it as Windows', () => {
  assert.equal(windowIdFromHash('#/windows/sol-phoenix-orderly'), 'sol-phoenix-orderly');
  assert.equal(windowIdFromHash('#/windows/a%2Fb%3Fc'), 'a/b?c');
  assert.equal(windowIdFromHash('#/windows'), null);
  assert.equal(windowIdFromHash('#/desk'), null);
  assert.equal(windowIdFromHash('#/windows/%E0%A4%A'), null);
  assert.equal(hashForWindow('a/b'), '#/windows/a%2Fb');
  assert.equal(hashForWindow(null), '#/windows');
  assert.equal(windowIdFromHash(hashForWindow('x y/z')), 'x y/z');
});
