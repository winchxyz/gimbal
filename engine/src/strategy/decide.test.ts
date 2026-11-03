// decide(): every entry, exit and rotation rule, the sizing, the counters and the wait journal rule.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOP_RULES, NO_COUNTERS, decide, entryFailure, journalWait, sizeFor, skipAct } from './decide.ts';
import type { Decision } from './decide.ts';
import { HOUR, STRATEGY, T0, held, hours, input, win } from './test-helpers.ts';

const XLM = 'xlm-hyperliquid-phoenix';
const actions = (ds: readonly Decision[]) => ds.map((d) => d.decision.action);

// ---- entry ----

test('enters a window only after it passed the entry rules for 3 hourly checks in a row', () => {
  const ds = hours(input(), 3, () => [win(XLM, { netAprPct: 14.2 })]);
  assert.deepEqual(actions(ds), ['wait', 'wait', 'enter']);
  assert.equal(ds[0]!.decision.reason, 'XLM 14.2 % net, 1 of 3 hours above 10 %');
  assert.equal(ds[1]!.decision.reason, 'XLM 14.2 % net, 2 of 3 hours above 10 %');
  assert.equal(ds[1]!.decision.windowId, XLM);
  for (const d of ds.slice(0, 2)) assert.equal(d.act, null);
  const e = ds[2]!;
  // Phoenix has no live rescue: 1.5x, under the 2x asked.
  assert.deepEqual(e.act, { kind: 'enter', windowId: XLM, legUsd: 12, leverage: 1.5 });
  assert.equal(e.vetoCandidate, XLM);
  assert.match(e.decision.reason, /^Enter XLM \(long Hyperliquid, short Phoenix\): 14\.2 % net, 3 of 3 hours above 10 %/);
  assert.match(e.decision.reason, /\$12\.00 a leg at 1\.5x$/);
});

test('scan events never move the counters; an hourly check within half an hour of the last counts as a scan event', () => {
  const w = [win(XLM)];
  let d = decide(input({ windows: w }));
  assert.equal(d.counters.aboveByWindow[XLM], 1);
  d = decide(input({ windows: w, hourly: false, now: T0 + 10 * 60_000, counters: d.counters }));
  assert.equal(d.counters.aboveByWindow[XLM], 1);
  d = decide(input({ windows: w, hourly: true, now: T0 + 20 * 60_000, counters: d.counters }));
  assert.equal(d.counters.aboveByWindow[XLM], 1, 'a second hourly flag 20 min later');
  assert.equal(d.counters.lastHourlyAt, T0);
  d = decide(input({ windows: w, hourly: true, now: T0 + HOUR, counters: d.counters }));
  assert.equal(d.counters.aboveByWindow[XLM], 2);
  // Once the count is reached, a scan event may act on it.
  d = decide(input({ windows: w, hourly: true, now: T0 + 2 * HOUR, counters: { ...d.counters, aboveByWindow: { [XLM]: 2 } } }));
  assert.equal(d.decision.action, 'enter');
  const counted = d.counters;
  d = decide(input({ windows: w, hourly: false, now: T0 + 2 * HOUR + 5_000, counters: { ...counted } }));
  assert.equal(d.decision.action, 'enter');
});

test('one failing hour, or a gap of more than 2 h between hourly checks, starts the count again', () => {
  const ds = hours(input(), 5, (h) => [win(XLM, { netAprPct: h === 2 ? 9 : 14 })]);
  assert.deepEqual(actions(ds), ['wait', 'wait', 'wait', 'wait', 'wait']);
  assert.equal(ds[2]!.decision.reason, 'No window clears the entry rules; best XLM 9.0 % net: 9.0 % net, under your 10 % minimum');
  assert.equal(ds[4]!.counters.aboveByWindow[XLM], 2);
  const gap = decide(input({ windows: [win(XLM)], now: T0 + 3 * HOUR, counters: { ...NO_COUNTERS, aboveByWindow: { [XLM]: 2 }, lastHourlyAt: T0 } }));
  assert.equal(gap.counters.aboveByWindow[XLM], 1);
  assert.equal(gap.decision.action, 'wait');
});

test('the entry rules: enterable, net at the minimum, this hour, 7 and 14 days of one sign, capacity for the leg', () => {
  const s = { strategy: STRATEGY };
  assert.equal(entryFailure(win(XLM), s), null);
  assert.equal(entryFailure(win(XLM, { netAprPct: 10 }), s), null, 'at the minimum is enough');
  assert.equal(entryFailure(win(XLM, { netAprPct: 9.99 }), s), '10.0 % net, under your 10 % minimum');
  assert.equal(entryFailure(win(XLM, { tradable: false }), s), 'watch only');
  assert.equal(entryFailure(win(XLM, { refused: { code: 'E_ORACLE_STALE', reason: 'no oracle price for XLM on phoenix' } }), s),
    'refused E_ORACLE_STALE: no oracle price for XLM on phoenix');
  assert.equal(entryFailure(win(XLM, { stale: true }), s), 'its numbers are stale');
  assert.equal(entryFailure(win(XLM, { veto: { verdict: 'veto', reasons: ['a spike'], model: 'm', at: T0 } }), s), 'vetoed by NEAR AI: a spike');
  assert.equal(entryFailure(win(XLM, { veto: { verdict: 'pass', reasons: [], model: 'm', at: T0 } }), s), null);
  assert.equal(entryFailure(win(XLM, { checks: [{ ok: true, text: 'a' }, { ok: false, text: 'The Phoenix book fills only $5.00' }] }), s), 'The Phoenix book fills only $5.00');
  assert.match(entryFailure(win(XLM, { grossAprPct: -3 }), s)!, /this hour pays -3\.0 %/);
  assert.match(entryFailure(win(XLM, { grossAprPct: 0 }), s)!, /this hour pays 0\.0 %/);
  assert.equal(entryFailure(win(XLM, { grossApr7dPct: null }), s), 'no 7-day spread yet');
  assert.equal(entryFailure(win(XLM, { grossApr7dPct: 0 }), s), 'the 7-day spread is 0.0 %');
  assert.equal(entryFailure(win(XLM), { ...s, gross14dAprPct: { [XLM]: -4 } }), 'the 14-day spread is -4.0 %');
  assert.equal(entryFailure(win(XLM), { ...s, gross14dAprPct: { [XLM]: 6 } }), null);
  assert.equal(entryFailure(win(XLM), { ...s, gross14dAprPct: { [XLM]: null } }), null, 'an unknown 14 days is the scanner\'s call');
  // A 12 USD leg may be at most 2 % of a leg market's open interest: 600 USD.
  assert.equal(entryFailure(win(XLM, { depthUsd: 599 }), s), 'capacity $599.00, under the $600.00 a $12.00 leg needs');
  assert.equal(entryFailure(win(XLM, { depthUsd: 600 }), s), null);
});

test('enters the top of the scanner\'s ranked list among the windows the rules allow, whatever nets more', () => {
  // The scanner ranks by expected carry over the hold, not by net APR: its order decides.
  const windows = [win('btc-hyperliquid-orderly', { netAprPct: 20, depthUsd: 10 }), win('sol-hyperliquid-phoenix', { netAprPct: 12 }), win(XLM, { netAprPct: 16 })];
  const ds = hours(input(), 3, () => windows);
  assert.deepEqual(ds[2]!.act, { kind: 'enter', windowId: 'sol-hyperliquid-phoenix', legUsd: 12, leverage: 1.5 });
  assert.equal(ds[0]!.decision.reason, 'SOL 12.0 % net, 1 of 3 hours above 10 %');
});

test('size: legUsd capped by max_notional_usd less the band and by free margin at the leverage', () => {
  const base = input();
  const both = win('xlm-hyperliquid-orderly');
  assert.deepEqual(sizeFor(win(XLM), base), { ok: true, legUsd: 12, leverage: 1.5 });
  // pair-mainnet's rule: 20 USD cap, 100 bps band -> 19.80.
  assert.deepEqual(sizeFor(win(XLM), { ...base, strategy: { ...STRATEGY, legUsd: 25 } }), { ok: true, legUsd: 19.8, leverage: 1.5 });
  assert.deepEqual(sizeFor(win(XLM), { ...base, strategy: { ...STRATEGY, legUsd: 25 }, priceBandBps: 200 }), { ok: true, legUsd: 19.6, leverage: 1.5 });
  assert.deepEqual(sizeFor(win(XLM), { ...base, strategy: { ...STRATEGY, legUsd: 25 }, priceBandBps: undefined }), { ok: true, legUsd: 19.8, leverage: 1.5 });
  // Both legs with a live rescue: the asked leverage, at most 2x.
  const live = { ...base, liveRescue: { hyperliquid: true, orderly: true } };
  assert.deepEqual(sizeFor(both, { ...live, strategy: { ...STRATEGY, maxLeverage: 3 } }), { ok: true, legUsd: 12, leverage: 2 });
  assert.deepEqual(sizeFor(both, { ...live, strategy: { ...STRATEGY, maxLeverage: 1.2 } }), { ok: true, legUsd: 12, leverage: 1.2 });
  assert.deepEqual(sizeFor(both, base), { ok: true, legUsd: 12, leverage: 1.5 }, 'Orderly has no live rescue');
  // Free margin: 10 USD on Hyperliquid at 1.5x is 15; 7.5 on Phoenix is 11.25; 6 on Phoenix is 9, under 10.
  assert.deepEqual(sizeFor(win(XLM), { ...base, freeMarginUsd: { hyperliquid: 10, phoenix: 7.5 } }), { ok: true, legUsd: 11.25, leverage: 1.5 });
  assert.deepEqual(sizeFor(win(XLM), { ...base, freeMarginUsd: { hyperliquid: 10, phoenix: 6 } }),
    { ok: false, why: '$6.00 free margin on Phoenix at 1.5x sizes a leg at $9.00 in whole lots, under the $10.00 minimum' });
  assert.equal(sizeFor(win(XLM), { ...base, freeMarginUsd: { hyperliquid: 10 } }).ok, false, 'no margin on Phoenix at all');
  // Depth on both legs: at most 2 % of the smaller leg's open interest.
  assert.deepEqual(sizeFor(win(XLM, { depthUsd: 550 }), base), { ok: true, legUsd: 11, leverage: 1.5 });
});

test('size: rounded down to whole common lots of the two venues, as pair-mainnet rounds it', () => {
  const at = (longLot: number | string, shortLot: number | string, px: number) => sizeFor(win(XLM), input({ lots: { [XLM]: { longLot, shortLot, px } } }));
  // 12 USD at 3 USD is 4 lots of 1: 12. At 5 USD: 2 lots, 10. Lots 0.1 and 0.3 at 2.6 USD: 4.615 base is 15 common
  // lots of 0.3, 4.5 base, 11.70. Lots 1 and 3 at 2.5 USD: 4.8 base is 1 common lot of 3, 7.50.
  assert.deepEqual(at(1, 1, 3), { ok: true, legUsd: 12, leverage: 1.5 });
  assert.deepEqual(at(1, 1, 5), { ok: true, legUsd: 10, leverage: 1.5 });
  assert.deepEqual(at('0.1', '0.3', 2.6), { ok: true, legUsd: 11.7, leverage: 1.5 });
  assert.deepEqual(at(1, 3, 2.5), { ok: false, why: 'your $12.00 leg sizes a leg at $7.50 in whole lots, under the $10.00 minimum' });
  assert.deepEqual(at(1, 1, 20), { ok: false, why: 'your $12.00 leg sizes a leg at $12.00, under one common lot (1 XLM at 20)' });
  assert.deepEqual(sizeFor(win(XLM), input({ lots: {} })), { ok: false, why: 'no lot sizes for XLM: its size cannot be rounded to whole lots' });
});

test('the top window that cannot be sized is waited on with the reason, not swapped for the next one', () => {
  const free = { hyperliquid: 50, phoenix: 2, orderly: 50 };
  const lone = hours(input({ freeMarginUsd: free }), 3, () => [win(XLM, { netAprPct: 16 })]);
  assert.equal(lone[2]!.decision.action, 'wait');
  assert.equal(lone[2]!.decision.reason, 'XLM 16.0 % net is ready, but $2.00 free margin on Phoenix at 1.5x sizes a leg at $3.00 in whole lots, under the $10.00 minimum');
  const two = hours(input({ freeMarginUsd: free }), 3, () => [win(XLM, { netAprPct: 16 }), win('sol-hyperliquid-orderly', { netAprPct: 12 })]);
  assert.equal(two[2]!.decision.action, 'wait');
  assert.equal(two[2]!.decision.windowId, XLM);
  const noLots = hours(input({ lots: {} }), 3, () => [win(XLM)]);
  assert.equal(noLots[2]!.decision.reason, 'XLM 15.0 % net is ready, but no lot sizes for XLM: its size cannot be rounded to whole lots');
});

test('auto off: action off, nothing to sign, the counters still move', () => {
  const ds = hours(input({ strategy: { ...STRATEGY, auto: false } }), 4, () => [win(XLM)]);
  assert.deepEqual(actions(ds), ['off', 'off', 'off', 'off']);
  for (const d of ds) assert.equal(d.act, null);
  assert.equal(ds[3]!.counters.aboveByWindow[XLM], 4);
  assert.equal(ds[3]!.decision.reason, 'Auto is off: the engine watches and you act by hand; XLM 15.0 % net, 3 of 3 hours above 10 %');
  const h = decide(input({ strategy: { ...STRATEGY, auto: false }, windows: [win(XLM, { netAprPct: 1 })], held: held(XLM) }));
  assert.equal(h.decision.action, 'off');
  assert.equal(h.decision.heldId, XLM);
});

// ---- exit ----

test('exit after 3 hourly checks in a row under the minimum; a good hour in between starts the count again', () => {
  const ds = hours(input({ held: held(XLM) }), 6, (h) => [win(XLM, { netAprPct: h === 1 ? 12 : 7.5 })], (h) => (h <= 4 ? held(XLM) : null));
  assert.deepEqual(actions(ds), ['hold', 'hold', 'hold', 'hold', 'exit', 'wait']);
  assert.equal(ds[0]!.decision.reason, 'Hold XLM: 7.5 % net, under your 10 % minimum, 1 of 3 hours before exit; day 1 of 14');
  assert.equal(ds[1]!.decision.reason, 'Hold XLM: 12.0 % net, at least your 10 % minimum; day 1 of 14');
  assert.equal(ds[4]!.decision.reason, 'Exit XLM: 7.5 % net, under your 10 % minimum, 3 of 3 hours in a row');
  assert.deepEqual(ds[4]!.act, { kind: 'exit', reason: ds[4]!.decision.reason });
  assert.equal(ds[4]!.vetoCandidate, null);
  assert.equal(ds[4]!.counters.lastExitAt, T0 + 4 * HOUR);
  assert.equal(ds[4]!.counters.badChecks, 0);
});

test('exit when the rest of the hold nets below zero, or the spread flipped this hour or over 7 or 14 days', () => {
  const neg = hours(input({ held: held(XLM) }), 3, () => [win(XLM, { netAprPct: -2 })]);
  assert.match(neg[2]!.decision.reason, /^Exit XLM: -2\.0 % net, -\$0\.01 over the 334 h left, 3 of 3 hours in a row$/);
  const flip = hours(input({ held: held(XLM) }), 3, () => [win(XLM, { grossAprPct: -6 })]);
  assert.equal(flip[2]!.decision.reason, 'Exit XLM: the spread flipped: this hour pays -6.0 %, 3 of 3 hours in a row');
  const d7 = hours(input({ held: held(XLM) }), 3, () => [win(XLM, { grossApr7dPct: -1 })]);
  assert.equal(d7[2]!.decision.action, 'exit');
  const d14 = hours(input({ held: held(XLM), gross14dAprPct: { [XLM]: -2 } }), 3, () => [win(XLM)]);
  assert.equal(d14[2]!.decision.reason, 'Exit XLM: the spread flipped: the 14-day spread is -2.0 %, 3 of 3 hours in a row');
});

test('the time stop and the drawdown stop exit at once, on any check', () => {
  const late = decide(input({ hourly: false, held: held(XLM, { since: T0 - 14 * 24 * HOUR }), windows: [win(XLM)] }));
  assert.equal(late.decision.reason, 'Exit XLM: held 14.0 days, the 14-day time stop');
  assert.equal(late.act?.kind, 'exit');
  const early = decide(input({ hourly: false, held: held(XLM, { since: T0 - 14 * 24 * HOUR + 60_000 }), windows: [win(XLM)] }));
  assert.equal(early.decision.action, 'hold');
  const down = decide(input({ hourly: false, held: held(XLM, { pnlUsd: -1.2 }), windows: [win(XLM)] }));
  assert.equal(down.decision.reason, 'Exit XLM: down $1.20, 10.0 % of the $12.00 leg, at your 10 % stop');
  assert.equal(decide(input({ held: held(XLM, { pnlUsd: -1.19 }), windows: [win(XLM)] })).decision.action, 'hold');
  assert.equal(decide(input({ held: held(XLM, { pnlUsd: -5 }), windows: [win(XLM)], strategy: { ...STRATEGY, stopDrawdownPct: null } })).decision.action, 'hold');
  // Even with the held window missing from the scan.
  assert.equal(decide(input({ held: held(XLM, { pnlUsd: -2 }), windows: [] })).decision.action, 'exit');
});

test('a held window missing from the scan or stale is held, its count kept', () => {
  const counters = { ...NO_COUNTERS, badChecks: 2, lastHourlyAt: T0 - HOUR };
  const gone = decide(input({ held: held(XLM), windows: [], counters }));
  assert.equal(gone.decision.reason, 'Hold XLM: its window is not in this scan, so nothing is decided on it; day 1 of 14');
  assert.equal(gone.counters.badChecks, 2);
  const stale = decide(input({ held: held(XLM), windows: [win(XLM, { stale: true, netAprPct: 1 })], counters }));
  assert.equal(stale.decision.action, 'hold');
  assert.equal(stale.counters.badChecks, 2);
});

test('cooldown: no entry for 6 h after an exit, then the ready window is entered', () => {
  const exitAt = T0;
  const counters = { ...NO_COUNTERS, lastExitAt: exitAt, lastHourlyAt: exitAt };
  const ds = hours(input({ now: exitAt + HOUR, counters }), 6, () => [win(XLM)]);
  assert.deepEqual(actions(ds), ['wait', 'wait', 'wait', 'wait', 'wait', 'enter']);
  assert.equal(ds[0]!.decision.reason, 'Cooling down after the exit, 5.0 h left; XLM 15.0 % net, 1 of 3 hours above 10 %');
  assert.equal(ds[3]!.decision.reason, 'Cooling down after the exit, 2.0 h left; XLM 15.0 % net, 3 of 3 hours above 10 %');
  assert.equal(ds[5]!.decision.windowId, XLM);
  assert.equal(LOOP_RULES.cooldownHours, 6);
});

// ---- rotation ----

const ZEC = 'zec-phoenix-hyperliquid';
const SOL_X = 'sol-orderly-phoenix';

test('rotate once another window beat the held one by 3 pts for 4 hourly checks and the switch pays back', () => {
  // +10 pts on 12 USD is 0.000137 USD an hour: a 0.01 USD switch pays back in 73 h.
  const ds = hours(input({ held: held(XLM) }), 5, () => [win(XLM, { netAprPct: 15 }), win(ZEC, { netAprPct: 25, switchCostUsd: 0.01 })]);
  assert.deepEqual(actions(ds), ['hold', 'hold', 'hold', 'rotate', 'hold']);
  assert.equal(ds[2]!.decision.reason, 'Hold XLM: 15.0 % net, at least your 10 % minimum; day 1 of 14; ZEC beats it by 10.0 pts, 3 of 4 hours');
  const r = ds[3]!;
  assert.deepEqual(r.act, { kind: 'rotate', fromId: XLM, toId: ZEC, legUsd: 12, leverage: 1.5 });
  assert.equal(r.vetoCandidate, ZEC);
  assert.equal(r.decision.windowId, ZEC);
  assert.equal(r.decision.heldId, XLM);
  assert.equal(r.decision.reason, 'Rotate XLM -> ZEC (long Phoenix, short Hyperliquid): 25.0 % net vs 15.0 %, +10.0 pts for 4 of 4 hours; '
    + 'the $0.01 switch pays back in 3.0 of the 13.9 days left; $12.00 a leg at 1.5x');
  assert.deepEqual(r.counters.rotationsAt, [T0 + 3 * HOUR]);
  assert.deepEqual(r.counters.betterByWindow, {});
});

test('a gain under minGainPts, or a switch that does not pay back within the rest of the hold, does not rotate', () => {
  const small = hours(input({ held: held(XLM) }), 6, () => [win(XLM, { netAprPct: 15 }), win(ZEC, { netAprPct: 17.9, switchCostUsd: 0.01 })]);
  assert.ok(small.every((d) => d.decision.action === 'hold'));
  assert.deepEqual(small[5]!.counters.betterByWindow, {});
  // +4 pts on 12 USD over 13.9 days pays 0.0183 USD: a 0.03 USD switch does not pay back.
  const slow = hours(input({ held: held(XLM) }), 5, () => [win(XLM, { netAprPct: 15 }), win(ZEC, { netAprPct: 19, switchCostUsd: 0.03 })]);
  assert.ok(slow.every((d) => d.decision.action === 'hold'));
  assert.equal(slow[4]!.decision.reason, 'Hold XLM: 15.0 % net, at least your 10 % minimum; day 1 of 14; '
    + 'ZEC beats it by 4.0 pts, but the $0.03 switch takes 22.8 days to pay back, 13.8 are left');
  const unknown = hours(input({ held: held(XLM) }), 5, () => [win(XLM), win(ZEC, { netAprPct: 30 })]);
  assert.match(unknown[4]!.decision.reason, /ZEC beats it by 15\.0 pts, but its switch cost is not known$/);
});

test('prefers a window on the venues that hold the margin; a cross-venue switch must pay its transfers', () => {
  // SOL long Orderly / short Phoenix nets more, but moving margin onto Orderly makes its switch 1.60 USD.
  const windows = [win(XLM, { netAprPct: 12 }), win(ZEC, { netAprPct: 24, switchCostUsd: 0.04 }), win(SOL_X, { netAprPct: 30, switchCostUsd: 1.6 })];
  const ds = hours(input({ held: held(XLM) }), 4, () => windows);
  assert.deepEqual(ds[3]!.act, { kind: 'rotate', fromId: XLM, toId: ZEC, legUsd: 12, leverage: 1.5 });
  // Even when the cross-venue switch would pay back, the same venues come first.
  const cheap = [win(XLM, { netAprPct: 12 }), win(ZEC, { netAprPct: 24, switchCostUsd: 0.04 }), win(SOL_X, { netAprPct: 30, switchCostUsd: 0.05 })];
  assert.deepEqual(hours(input({ held: held(XLM) }), 4, () => cheap)[3]!.act, { kind: 'rotate', fromId: XLM, toId: ZEC, legUsd: 12, leverage: 1.5 });
  // Alone, the cross-venue one rotates only when its transfers pay back.
  const alone = hours(input({ held: held(XLM) }), 4, () => [win(XLM, { netAprPct: 12 }), win(SOL_X, { netAprPct: 30, switchCostUsd: 1.6 })]);
  assert.equal(alone[3]!.decision.action, 'hold');
  assert.match(alone[3]!.decision.reason, /SOL beats it by 18\.0 pts, but the \$1\.60 switch takes 270\.4 days to pay back/);
  const paid = hours(input({ held: held(XLM) }), 4, () => [win(XLM, { netAprPct: 12 }), win(SOL_X, { netAprPct: 30, switchCostUsd: 0.05 })]);
  assert.deepEqual(paid[3]!.act, { kind: 'rotate', fromId: XLM, toId: SOL_X, legUsd: 12, leverage: 1.5 });
});

test('at most 2 rotations in 24 h', () => {
  const windows = [win(XLM, { netAprPct: 12 }), win(ZEC, { netAprPct: 30, switchCostUsd: 0.04 })];
  const counters = { ...NO_COUNTERS, rotationsAt: [T0 - 20 * HOUR, T0 - 2 * HOUR] };
  const ds = hours(input({ held: held(XLM), counters }), 6, () => windows);
  assert.deepEqual(actions(ds), ['hold', 'hold', 'hold', 'hold', 'rotate', 'hold']);
  assert.match(ds[3]!.decision.reason, /ZEC beats it by 18\.0 pts, but 2 rotations in 24 h is the most$/);
  // At hour 4 the first rotation is 24 h old: one slot is free again.
  assert.deepEqual(ds[4]!.counters.rotationsAt, [T0 - 2 * HOUR, T0 + 4 * HOUR]);
});

test('a rotation sizes the new legs with the margin the held legs free', () => {
  const windows = [win(XLM, { netAprPct: 12 }), win(ZEC, { netAprPct: 30, switchCostUsd: 0.04 })];
  // 3 USD free on each venue plus the held 12 USD leg's margin at 2x (6 USD) is 9 USD: 13.50 at 1.5x, capped at 12.
  const ds = hours(input({ held: held(XLM), freeMarginUsd: { hyperliquid: 3, phoenix: 3 } }), 4, () => windows);
  assert.deepEqual(ds[3]!.act, { kind: 'rotate', fromId: XLM, toId: ZEC, legUsd: 12, leverage: 1.5 });
  const tight = hours(input({ held: held(XLM), freeMarginUsd: { hyperliquid: 0, phoenix: 0 } }), 4, () => windows);
  assert.equal(tight[3]!.decision.action, 'hold');
  assert.match(tight[3]!.decision.reason, /under the \$10\.00 minimum$/);
});

test('rotation comes before a counted exit: a better window replaces a compressed one without a cooldown', () => {
  const ds = hours(input({ held: held(XLM) }), 4, () => [win(XLM, { netAprPct: 8 }), win(ZEC, { netAprPct: 20, switchCostUsd: 0.04 })], (h) => (h <= 2 ? held(XLM) : null));
  assert.deepEqual(actions(ds), ['hold', 'hold', 'exit', 'wait']);
  // Here the exit came first (3 bad hours before 4 better ones): the counts are what they are.
  const quick = hours(input({ held: held(XLM), strategy: { ...STRATEGY, rotate: { minGainPts: 3, forHours: 3 } } }), 3,
    () => [win(XLM, { netAprPct: 8 }), win(ZEC, { netAprPct: 20, switchCostUsd: 0.04 })]);
  assert.equal(quick[2]!.decision.action, 'rotate');
  assert.equal(quick[2]!.counters.lastExitAt, null);
});

// ---- veto, failures and the journal rule ----

test('skipAct: a vetoed or failed act leaves this check\'s counts and none of the act\'s marks', () => {
  const ds = hours(input({ held: held(XLM) }), 3, () => [win(XLM, { netAprPct: 7 })]);
  const lastIn = input({ held: held(XLM), now: T0 + 2 * HOUR, windows: [win(XLM, { netAprPct: 7 })], counters: ds[1]!.counters });
  const exit = ds[2]!;
  assert.equal(exit.counters.lastExitAt, T0 + 2 * HOUR);
  const failed = skipAct(lastIn, exit);
  assert.equal(failed.lastExitAt, null);
  assert.equal(failed.badChecks, 3, 'the exit is tried again on the next check');
  const retry = decide({ ...lastIn, hourly: false, now: lastIn.now + 5_000, counters: failed });
  assert.equal(retry.decision.action, 'exit');

  const windows = [win(XLM, { netAprPct: 12 }), win(ZEC, { netAprPct: 30, switchCostUsd: 0.04 })];
  const rs = hours(input({ held: held(XLM) }), 4, () => windows);
  const rIn = input({ held: held(XLM), now: T0 + 3 * HOUR, windows, counters: rs[2]!.counters });
  const vetoed = skipAct(rIn, rs[3]!);
  assert.deepEqual(vetoed.rotationsAt, []);
  assert.equal(vetoed.betterByWindow[ZEC], 4);
  const w = decide(input({ windows: [win(XLM)] }));
  assert.equal(skipAct(input({ windows: [win(XLM)] }), w), w.counters);
});

test('journalWait: a wait is journaled when its reason changes, not when only its numbers move', () => {
  const first = decide(input({ windows: [win(XLM, { netAprPct: 14.2 })] }));
  assert.equal(journalWait(NO_COUNTERS, first), true);
  // A scan event 5 s later with another net: the same wait.
  const same = decide(input({ hourly: false, now: T0 + 5_000, windows: [win(XLM, { netAprPct: 14.6 })], counters: first.counters }));
  assert.equal(same.decision.reason, 'XLM 14.6 % net, 1 of 3 hours above 10 %');
  assert.equal(journalWait(first.counters, same), false);
  const next = decide(input({ now: T0 + HOUR, windows: [win(XLM)], counters: same.counters }));
  assert.equal(journalWait(same.counters, next), true, '2 of 3 hours');
  const entered = hours(input(), 3, () => [win(XLM)])[2]!;
  assert.equal(journalWait(NO_COUNTERS, entered), false);
  assert.equal(entered.counters.lastWaitReason, null);
  // No window at all, then none again: one entry.
  const none = decide(input({ windows: [] }));
  assert.equal(none.decision.reason, 'No desk window in this scan');
  assert.equal(journalWait(none.counters, decide(input({ now: T0 + HOUR, windows: [], counters: none.counters }))), false);
});

test('wait, hold and off never carry an act or a veto candidate', () => {
  const all = [
    ...hours(input(), 2, () => [win(XLM)]),
    ...hours(input({ held: held(XLM) }), 2, () => [win(XLM)]),
    decide(input({ strategy: { ...STRATEGY, auto: false }, windows: [win(XLM)] })),
  ];
  for (const d of all) {
    assert.ok(['wait', 'hold', 'off'].includes(d.decision.action));
    assert.equal(d.act, null);
    assert.equal(d.vetoCandidate, null);
    assert.ok(d.decision.reason.length > 0 && !d.decision.reason.includes('\n'));
  }
});
