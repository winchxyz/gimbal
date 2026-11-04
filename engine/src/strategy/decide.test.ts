// decide(): every entry, exit and rotation rule, the sizing, the counters, the veto hold and the wait journal rule.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOP_RULES, NO_COUNTERS, decide, entryFailure, heldForwardAprPct, journalWait, sizeFor, skipAct } from './decide.ts';import type { Decision, LoopCounters } from './decide.ts';
import { HOUR, STRATEGY, T0, held, hours, input, win } from './test-helpers.ts';

const XLM = 'xlm-hyperliquid-phoenix';
const SOL = 'sol-hyperliquid-phoenix';
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
  // Phoenix has no live rescue: 1.5x, under the 2x asked. 12 USD at 1 USD in lots of 0.01: 12 base units.
  assert.deepEqual(e.act, { kind: 'enter', windowId: XLM, legUsd: 12, leverage: 1.5, qty: '12' });
  assert.equal(e.vetoCandidate, XLM);
  assert.match(e.decision.reason, /^Enter XLM \(long Hyperliquid, short Phoenix\): 14\.2 % net, 3 of 3 hours above 10 %/);
  assert.match(e.decision.reason, /\$12\.00 a leg at 1\.5x$/);
});

test('a window whose stored price the open refreshes is counted and entered, its note on every why line', () => {
  const note = 'stored XLM price missing: refreshed at open';
  const ds = hours(input(), 3, () => [win(XLM, { netAprPct: 14.2, note })]);
  assert.deepEqual(actions(ds), ['wait', 'wait', 'enter'], 'the hourly checks count it like any enterable window');
  assert.equal(ds[0]!.decision.reason, `XLM 14.2 % net, 1 of 3 hours above 10 %; ${note}`);
  assert.equal(ds[1]!.decision.reason, `XLM 14.2 % net, 2 of 3 hours above 10 %; ${note}`);
  assert.deepEqual(ds[2]!.act, { kind: 'enter', windowId: XLM, legUsd: 12, leverage: 1.5, qty: '12' });
  assert.match(ds[2]!.decision.reason, /\$12\.00 a leg at 1\.5x; stored XLM price missing: refreshed at open$/);
  assert.doesNotMatch(ds.map((d) => d.decision.reason).join('\n'), /refused|E_ORACLE_STALE/);
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
  assert.equal(entryFailure(win(XLM, { veto: { verdict: 'veto', reasons: ['a spike'], model: 'm', at: T0 } }), s), 'refused by the NEAR AI risk check: a spike');
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

// ---- free margin and the hands on entry ----

const ETH_OR = 'eth-orderly-phoenix';
/** The way serve opens it: long Phoenix, short Hyperliquid. */
const XLM_PH = 'xlm-phoenix-hyperliquid';
/** Free margin on the mainnet desk today. */
const TODAY = { hyperliquid: 7.68, phoenix: 9.75 };
/** XLM in whole coins (Hyperliquid sz_decimals 0) at the 0.25 USD a stored XLM price reads in the pair tests. */
const XLM_LOTS = { [XLM_PH]: { longLot: 1, shortLot: 1, px: 0.25 } };
/** What serve-loop.ts windowSymbol says of a window in the other direction. */
const WRONG_WAY = `serve opens short hyperliquid, long phoenix only (as pair-mainnet open); ${XLM} is long hyperliquid, short phoenix`;

test('margin: the same window passes with free margin on both venues and is refused where none opens a 10 USD leg', () => {
  const s = { strategy: STRATEGY, freeMarginUsd: { orderly: 50, phoenix: 50 }, liveRescue: { hyperliquid: true } };
  assert.equal(entryFailure(win(ETH_OR), s), null);
  // The loop never moves margin to open: no cost makes up for it, the window is refused outright.
  assert.equal(entryFailure(win(ETH_OR), { ...s, freeMarginUsd: { orderly: 0, phoenix: 50 } }),
    '$0.00 free margin on Orderly at 1.5x opens $0.00 a leg in whole lots, under the $10.00 minimum: the loop does not move margin to open');
  // Some margin is enough: sizeFor sizes the leg down to it. 6.67 USD at 1.5x opens 10 USD; 6.6 opens 9.90.
  assert.equal(entryFailure(win(ETH_OR), { ...s, freeMarginUsd: { orderly: 6.67, phoenix: 50 } }), null);
  assert.match(entryFailure(win(ETH_OR), { ...s, freeMarginUsd: { orderly: 6.6, phoenix: 50 } })!, /^\$6\.60 free margin on Orderly at 1\.5x opens \$9\.90 a leg/);
  // What a close frees first counts there (a rotation).
  assert.equal(entryFailure(win(ETH_OR), { ...s, freeMarginUsd: { orderly: 0, phoenix: 50 }, freedMarginUsd: { orderly: 8 } }), null);
  // A venue not read this check is skipped: sizeFor waits on it, the gate does not refuse on a read failure.
  assert.equal(entryFailure(win(ETH_OR), { ...s, freeMarginUsd: { phoenix: 50 } }), null);
  // Outside decide() (no free margin given) nothing is judged.
  assert.equal(entryFailure(win(ETH_OR), { strategy: STRATEGY }), null);
});

test('margin: the gate rounds to whole lots as sizeFor does, so the two agree', () => {
  // 7 USD at 1.5x is 10.50, but in lots of 1 at 3 USD that is 3 lots, 9.00: refused by both.
  const lots = { [XLM_PH]: { longLot: 1, shortLot: 1, px: 3 } };
  const short = input({ freeMarginUsd: { hyperliquid: 7, phoenix: 50 }, lots });
  assert.match(entryFailure(win(XLM_PH), short)!, /^\$7\.00 free margin on Hyperliquid at 1\.5x opens \$9\.00 a leg in whole lots/);
  const size = sizeFor(win(XLM_PH), short);
  assert.equal(size.ok, false);
  assert.match(!size.ok ? size.why : '', /sizes a leg at \$9\.00 in whole lots, under the \$10\.00 minimum/);
  // 8 USD: 12.00 a leg capped by the 12 USD leg, 4 lots: both pass.
  const enough = input({ freeMarginUsd: { hyperliquid: 8, phoenix: 50 }, lots });
  assert.equal(entryFailure(win(XLM_PH), enough), null);
  assert.deepEqual(sizeFor(win(XLM_PH), enough), { ok: true, legUsd: 12, leverage: 1.5, qty: '4' });
});

test('margin: XLM at 2 of 3 hours keeps its count when a free-margin read fails, waits to size, then enters', () => {
  const at2 = { ...NO_COUNTERS, aboveByWindow: { [XLM_PH]: 2 }, lastHourlyAt: T0 - HOUR };
  const failed = decide(input({ windows: [win(XLM_PH)], counters: at2, freeMarginUsd: { phoenix: 9.75 }, lots: XLM_LOTS }));
  assert.equal(failed.counters.aboveByWindow[XLM_PH], 3, 'the count stays: a read failure is not a reason the window failed');
  assert.equal(failed.act, null);
  assert.match(failed.decision.reason, /^XLM 15\.0 % net is ready, but \$0\.00 free margin on Hyperliquid at 1\.5x leaves nothing to open$/);
  const next = decide(input({ windows: [win(XLM_PH)], now: T0 + HOUR, counters: failed.counters, freeMarginUsd: TODAY, lots: XLM_LOTS }));
  assert.equal(next.act?.kind, 'enter');
  // A read that answers 0 is a refusal, and the count starts again.
  const zero = decide(input({ windows: [win(XLM_PH)], counters: at2, freeMarginUsd: { hyperliquid: 0, phoenix: 9.75 }, lots: XLM_LOTS }));
  assert.equal(zero.counters.aboveByWindow[XLM_PH], undefined);
});

test('today: Hyperliquid 7.68 and Phoenix 9.75 free, XLM long Phoenix / short Hyperliquid passes and is entered', () => {
  const today = input({ freeMarginUsd: TODAY, lots: XLM_LOTS });
  assert.equal(entryFailure(win(XLM_PH), today), null);
  const ds = hours(today, 3, () => [win(XLM_PH)]);
  assert.deepEqual(actions(ds), ['wait', 'wait', 'enter']);
  // Phoenix has no live rescue: 1.5x. Hyperliquid binds: 7.68 x 1.5 = 11.52, 46 XLM at 0.25 = 11.50.
  assert.deepEqual(ds[2]!.act, { kind: 'enter', windowId: XLM_PH, legUsd: 11.5, leverage: 1.5, qty: '46' });
});

test('hands: a window the hands cannot open, ranked above XLM, is passed over; XLM is the one counted and entered', () => {
  const ranked = () => [win(XLM, { netAprPct: 30 }), win(ETH_OR, { netAprPct: 25 }), win(XLM_PH, { netAprPct: 14.2 })];
  const unopenable = { [XLM]: WRONG_WAY, [ETH_OR]: 'serve opens short hyperliquid, long phoenix only' };
  const ds = hours(input({ freeMarginUsd: TODAY, lots: XLM_LOTS, unopenable }), 3, ranked);
  assert.deepEqual(actions(ds), ['wait', 'wait', 'enter']);
  assert.equal(ds[0]!.decision.reason, 'XLM 14.2 % net, 1 of 3 hours above 10 %');
  assert.equal(ds[1]!.counters.aboveByWindow[XLM_PH], 2);
  assert.equal(ds[1]!.counters.aboveByWindow[XLM], undefined);
  assert.equal(ds[2]!.act?.kind === 'enter' && ds[2]!.act.windowId, XLM_PH);
  assert.equal(entryFailure(win(XLM), { strategy: STRATEGY, unopenable }), WRONG_WAY);
  // Without the list the top window stalls the desk: it is the one waited on, and it cannot be opened.
  const stalled = hours(input({ freeMarginUsd: TODAY, lots: XLM_LOTS }), 3, ranked);
  assert.equal(stalled[2]!.decision.windowId, XLM);
  assert.equal(stalled[2]!.act?.kind === 'enter' && stalled[2]!.act.windowId, false);
});

test('hands: a rotation challenger the hands cannot open is never counted as better', () => {
  const windows = () => [win(XLM, { netAprPct: 40, switchCostUsd: 0.1 }), win(XLM_PH, { netAprPct: 14 })];
  const base = input({ held: held(XLM_PH), lots: XLM_LOTS });
  const counted = hours(base, 5, windows);
  assert.ok((counted[4]!.counters.betterByWindow[XLM] ?? 0) > 0, 'without the list it counts');
  const ds = hours({ ...base, unopenable: { [XLM]: WRONG_WAY } }, 5, windows);
  assert.equal(ds[4]!.counters.betterByWindow[XLM], undefined);
  assert.ok(ds.every((d) => d.act === null), JSON.stringify(ds.map((d) => d.decision.reason)));
});

test('a number the gate reads that is not finite fails the gate with a reason', () => {
  const s = { strategy: STRATEGY };
  assert.equal(entryFailure(win(XLM, { netAprPct: NaN }), s), 'its net APR is not a number (NaN)');
  assert.equal(entryFailure(win(XLM, { grossAprPct: NaN }), s), 'its gross APR this hour is not a number (NaN)');
  assert.equal(entryFailure(win(XLM, { depthUsd: Infinity }), s), 'its capacity is not a number (Infinity)');
  assert.equal(entryFailure(win(XLM, { grossApr7dPct: NaN }), s), 'its 7-day spread is not a number (NaN)');
  assert.equal(entryFailure(win(XLM), { ...s, gross14dAprPct: { [XLM]: NaN } }), 'its 14-day spread is not a number (NaN)');
  assert.equal(entryFailure(win(XLM), { strategy: { ...STRATEGY, minNetAprPct: NaN } }), 'your minimum is not a number (NaN)');
  assert.equal(entryFailure(win(XLM), { strategy: { ...STRATEGY, legUsd: NaN } }), 'your leg size is not a number (NaN)');
  // Never counted, never entered.
  const ds = hours(input(), 4, () => [win(XLM, { netAprPct: NaN })]);
  assert.deepEqual(actions(ds), ['wait', 'wait', 'wait', 'wait']);
  assert.equal(ds[3]!.decision.reason, 'No window clears the entry rules; best XLM NaN net: its net APR is not a number (NaN)');
  assert.equal(ds[3]!.counters.aboveByWindow[XLM], undefined);
});

test('enters the top of the scanner\'s ranked list among the windows the rules allow, whatever nets more', () => {
  // The scanner ranks by expected carry over the hold, not by net APR: its order decides.
  const windows = [win('btc-hyperliquid-orderly', { netAprPct: 20, depthUsd: 10 }), win(SOL, { netAprPct: 12 }), win(XLM, { netAprPct: 16 })];
  const ds = hours(input(), 3, () => windows);
  assert.deepEqual(ds[2]!.act, { kind: 'enter', windowId: SOL, legUsd: 12, leverage: 1.5, qty: '12' });
  assert.equal(ds[0]!.decision.reason, 'SOL 12.0 % net, 1 of 3 hours above 10 %');
});

test('only the top passing window is entered: while it warms up, a lower window with its hours is not', () => {
  // SOL is ranked first but passes only from hour 2; XLM has passed since hour 0.
  const ds = hours(input(), 5, (h) => [win(SOL, { netAprPct: h < 2 ? 5 : 20 }), win(XLM)]);
  assert.deepEqual(actions(ds), ['wait', 'wait', 'wait', 'wait', 'enter']);
  assert.equal(ds[2]!.counters.aboveByWindow[XLM], 3);
  assert.equal(ds[2]!.decision.reason, 'SOL 20.0 % net, 1 of 3 hours above 10 %');
  assert.equal(ds[2]!.decision.windowId, SOL);
  assert.equal(ds[3]!.decision.reason, 'SOL 20.0 % net, 2 of 3 hours above 10 %');
  assert.equal((ds[4]!.act as { windowId: string }).windowId, SOL);
});

test('size: legUsd capped by max_notional_usd less the band and by free margin at the leverage', () => {
  const base = input();
  const both = win('xlm-hyperliquid-orderly');
  assert.deepEqual(sizeFor(win(XLM), base), { ok: true, legUsd: 12, leverage: 1.5, qty: '12' });
  // pair-mainnet's rule: 20 USD cap, 100 bps band -> 19.80.
  assert.deepEqual(sizeFor(win(XLM), { ...base, strategy: { ...STRATEGY, legUsd: 25 } }), { ok: true, legUsd: 19.8, leverage: 1.5, qty: '19.8' });
  assert.deepEqual(sizeFor(win(XLM), { ...base, strategy: { ...STRATEGY, legUsd: 25 }, priceBandBps: 200 }), { ok: true, legUsd: 19.6, leverage: 1.5, qty: '19.6' });
  assert.deepEqual(sizeFor(win(XLM), { ...base, strategy: { ...STRATEGY, legUsd: 25 }, priceBandBps: undefined }), { ok: true, legUsd: 19.8, leverage: 1.5, qty: '19.8' });
  // Both legs with a live rescue: the asked leverage, at most 2x.
  const live = { ...base, liveRescue: { hyperliquid: true, orderly: true } };
  assert.deepEqual(sizeFor(both, { ...live, strategy: { ...STRATEGY, maxLeverage: 3 } }), { ok: true, legUsd: 12, leverage: 2, qty: '12' });
  assert.deepEqual(sizeFor(both, { ...live, strategy: { ...STRATEGY, maxLeverage: 1.2 } }), { ok: true, legUsd: 12, leverage: 1.2, qty: '12' });
  assert.deepEqual(sizeFor(both, base), { ok: true, legUsd: 12, leverage: 1.5, qty: '12' }, 'Orderly has no live rescue');
  // Free margin: 10 USD on Hyperliquid at 1.5x is 15; 7.5 on Phoenix is 11.25; 6 on Phoenix is 9, under 10.
  assert.deepEqual(sizeFor(win(XLM), { ...base, freeMarginUsd: { hyperliquid: 10, phoenix: 7.5 } }), { ok: true, legUsd: 11.25, leverage: 1.5, qty: '11.25' });
  assert.deepEqual(sizeFor(win(XLM), { ...base, freeMarginUsd: { hyperliquid: 10, phoenix: 6 } }),
    { ok: false, code: 'margin:phoenix', why: '$6.00 free margin on Phoenix at 1.5x sizes a leg at $9.00 in whole lots, under the $10.00 minimum' });
  assert.equal(sizeFor(win(XLM), { ...base, freeMarginUsd: { hyperliquid: 10 } }).ok, false, 'no margin on Phoenix at all');
  // Depth on both legs: at most 2 % of the smaller leg's open interest.
  assert.deepEqual(sizeFor(win(XLM, { depthUsd: 550 }), base), { ok: true, legUsd: 11, leverage: 1.5, qty: '11' });
});

test('size: a cap that is not a finite number, or is <= 0, sizes nothing (never its absolute value)', () => {
  const base = input();
  assert.deepEqual(sizeFor(win(XLM), { ...base, maxNotionalUsd: NaN }),
    { ok: false, code: 'numbers', why: 'the policy\'s NaN cap less the 100 bps band is not a number' });
  assert.deepEqual(sizeFor(win(XLM), { ...base, maxNotionalUsd: -20 }),
    { ok: false, code: 'policy', why: 'the policy\'s -$20.00 cap less the 100 bps band leaves nothing to open' });
  assert.deepEqual(sizeFor(win(XLM), { ...base, maxNotionalUsd: 0 }).ok, false);
  assert.deepEqual(sizeFor(win(XLM), { ...base, strategy: { ...STRATEGY, legUsd: -12 } }),
    { ok: false, code: 'leg', why: 'your -$12.00 leg leaves nothing to open' });
  assert.deepEqual(sizeFor(win(XLM), { ...base, freeMarginUsd: { hyperliquid: -30, phoenix: 50 } }),
    { ok: false, code: 'margin:hyperliquid', why: '-$30.00 free margin on Hyperliquid at 1.5x leaves nothing to open' });
  assert.equal(sizeFor(win(XLM), { ...base, freeMarginUsd: { hyperliquid: NaN, phoenix: 50 } }).ok, false);
  assert.equal(sizeFor(win(XLM, { depthUsd: NaN }), base).ok, false);
  assert.equal(sizeFor(win(XLM), { ...base, strategy: { ...STRATEGY, maxLeverage: NaN } }).ok, false);
  assert.equal(sizeFor(win(XLM), { ...base, priceBandBps: NaN }).ok, false);
  assert.equal(sizeFor(win(XLM), input({ lots: { [XLM]: { longLot: 1, shortLot: 1, px: NaN } } })).ok, false);
  assert.equal(sizeFor(win(XLM), input({ lots: { [XLM]: { longLot: 1, shortLot: 1, px: -1 } } })).ok, false);
});

test('size: rounded down to whole common lots of the two venues, as pair-mainnet rounds it', () => {
  const at = (longLot: number | string, shortLot: number | string, px: number) => sizeFor(win(XLM), input({ lots: { [XLM]: { longLot, shortLot, px } } }));
  // 12 USD at 3 USD is 4 lots of 1: 12. At 5 USD: 2 lots, 10. Lots 0.1 and 0.3 at 2.6 USD: 4.615 base is 15 common
  // lots of 0.3, 4.5 base, 11.70. Lots 1 and 3 at 2.5 USD: 4.8 base is 1 common lot of 3, 7.50.
  assert.deepEqual(at(1, 1, 3), { ok: true, legUsd: 12, leverage: 1.5, qty: '4' });
  assert.deepEqual(at(1, 1, 5), { ok: true, legUsd: 10, leverage: 1.5, qty: '2' });
  assert.deepEqual(at('0.1', '0.3', 2.6), { ok: true, legUsd: 11.7, leverage: 1.5, qty: '4.5' });
  assert.deepEqual(at(1, 3, 2.5), { ok: false, code: 'leg', why: 'your $12.00 leg sizes a leg at $7.50 in whole lots, under the $10.00 minimum' });
  assert.deepEqual(at(1, 1, 20), { ok: false, code: 'leg', why: 'your $12.00 leg sizes a leg at $12.00, under one common lot (1 XLM at 20)' });
  assert.deepEqual(sizeFor(win(XLM), input({ lots: {} })), { ok: false, code: 'lots', why: 'no lot sizes for XLM: its size cannot be rounded to whole lots' });
});

test('the top window that cannot be sized is waited on with the reason, not swapped for the next one', () => {
  const SOL_HO = 'sol-hyperliquid-orderly';
  const lots = { [SOL_HO]: { longLot: 0.01, shortLot: 0.01, px: 1 } };
  const two = hours(input({ lots }), 3, () => [win(XLM, { netAprPct: 16 }), win(SOL_HO, { netAprPct: 12 })]);
  assert.equal(two[2]!.decision.action, 'wait');
  assert.equal(two[2]!.decision.windowId, XLM);
  assert.equal(two[2]!.decision.reason, 'XLM 16.0 % net is ready, but no lot sizes for XLM: its size cannot be rounded to whole lots');
  // Free margin that cannot open a 10 USD leg is not a size to wait on: the loop never moves margin there, so the
  // gate refuses the window and the next one is counted and entered.
  const free = { hyperliquid: 50, phoenix: 2, orderly: 50 };
  const lone = hours(input({ freeMarginUsd: free }), 3, () => [win(XLM, { netAprPct: 16 })]);
  assert.equal(lone[2]!.decision.action, 'wait');
  assert.equal(lone[2]!.decision.reason, 'No window clears the entry rules; best XLM 16.0 % net: $2.00 free margin on Phoenix at 1.5x opens $3.00 a leg in whole lots, under the $10.00 minimum: the loop does not move margin to open');
  assert.equal(lone[2]!.counters.lastWaitReason, `blocked:${XLM}:margin`);
  const past = hours(input({ freeMarginUsd: free }), 3, () => [win(XLM, { netAprPct: 16 }), win(SOL_HO, { netAprPct: 12 })]);
  assert.equal(past[2]!.act?.kind === 'enter' && past[2]!.act.windowId, SOL_HO);
  const noLots = hours(input({ lots: {} }), 3, () => [win(XLM)]);
  assert.equal(noLots[2]!.decision.reason, 'XLM 15.0 % net is ready, but no lot sizes for XLM: its size cannot be rounded to whole lots');
  assert.equal(noLots[2]!.counters.lastWaitReason, `size:${XLM}:lots`);
});

test('the wait journal key carries the failure category, not only the window', () => {
  const minimum = decide(input({ windows: [win(XLM, { netAprPct: 9 })] }));
  assert.equal(minimum.counters.lastWaitReason, `blocked:${XLM}:minimum`);
  const depth = decide(input({ now: T0 + HOUR, windows: [win(XLM, { depthUsd: 100 })], counters: minimum.counters }));
  assert.equal(depth.counters.lastWaitReason, `blocked:${XLM}:depth`);
  assert.equal(journalWait(minimum.counters, depth), true, 'another reason on the same window is journaled');
  const again = decide(input({ now: T0 + 2 * HOUR, windows: [win(XLM, { depthUsd: 200 })], counters: depth.counters }));
  assert.equal(journalWait(depth.counters, again), false, 'the same reason with other numbers is not');
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

test('a held pair is judged from here: its gross less a constant exit, the open sunk', () => {
  // 9 % net is 12 % gross less 3 % of costs. The exit still to pay is half the 2 % fees and 0.5 % slippage plus the
  // 0.5 % basis buffer: 1.75 points, the same on day 1 and day 13.
  assert.equal(heldForwardAprPct(win(XLM, { netAprPct: 9 })), 10.25);
  assert.equal(heldForwardAprPct(win(XLM)), 16.25);
});

test('a steady window entered on day 0 holds every hourly check until the day-14 time stop', () => {
  for (const netAprPct of [15, 9]) {
    // 15 % net (18 % gross) is 16.25 % held; 9 % net, under the 10 % minimum for an entry, is 10.25 % held.
    const ds = hours(input({ held: held(XLM) }), 14 * 24 + 1, () => [win(XLM, { netAprPct })]);
    const exits = ds.flatMap((d, h) => (d.decision.action === 'exit' ? [h] : []));
    assert.deepEqual(exits, [14 * 24], `${netAprPct} % net exits only at the time stop`);
    assert.ok(ds.slice(0, 14 * 24).every((d) => d.decision.action === 'hold' && d.counters.badChecks === 0));
    assert.equal(ds[14 * 24]!.decision.reason, 'Exit XLM: held 14.0 days, the 14-day time stop');
    assert.match(ds[14 * 24 - 1]!.decision.reason, /^Hold XLM: 1\d\.\d % net of the exit, at least your 10 % minimum; day 14 of 14$/);
  }
});

test('a real drop in funding still compresses, late in the hold as early', () => {
  // On day 12 the gross falls from 18 % to 10 %: 8.25 % held, under the minimum for 6 hours: exit.
  const since = T0 - 11 * 24 * HOUR;
  const ds = hours(input({ held: held(XLM, { since }) }), 7, (h) => [win(XLM, { netAprPct: h === 0 ? 15 : 7 })]);
  assert.deepEqual(actions(ds), ['hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'exit']);
  assert.equal(ds[1]!.decision.reason, 'Hold XLM: 8.3 % net of the exit, under your 10 % minimum, 1 of 6 hours before exit; day 12 of 14');
  assert.equal(ds[6]!.decision.reason, 'Exit XLM: 8.3 % net of the exit, under your 10 % minimum, 6 of 6 hours in a row');
});

test('a since in the future (clock skew) never gives more than the whole hold', () => {
  const windows = () => [win(XLM, { netAprPct: 15, costs: { feesPct: 0, slippagePct: 0, basisPct: 0, rescueReservePct: 0 } }), win('zec-phoenix-hyperliquid', { netAprPct: 19, switchCostUsd: 0.03 })];
  const ds = hours(input({ held: held(XLM, { since: T0 + 300 * HOUR }) }), 5, windows);
  assert.ok(ds.every((d) => d.decision.action === 'hold'));
  assert.match(ds[4]!.decision.reason, /^Hold XLM: 15\.0 % net of the exit, at least your 10 % minimum; day 1 of 14; /);
  assert.match(ds[4]!.decision.reason, /the \$0\.03 switch takes 22\.8 days to pay back, 14\.0 are left$/);
});

test('exit after 6 hourly checks in a row under the minimum (the default), not 3; a good hour in between starts the count again', () => {
  // From here: 10.25 % and 14.75 % gross less the 1.75 points of exit: 8.5 % and 13 %.
  const ds = hours(input({ held: held(XLM) }), 9, (h) => [win(XLM, { netAprPct: h === 1 ? 11.75 : 7.25 })], (h) => (h <= 7 ? held(XLM) : null));
  assert.deepEqual(actions(ds), ['hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'exit', 'wait']);
  assert.equal(ds[0]!.decision.reason, 'Hold XLM: 8.5 % net of the exit, under your 10 % minimum, 1 of 6 hours before exit; day 1 of 14');
  assert.equal(ds[1]!.decision.reason, 'Hold XLM: 13.0 % net of the exit, at least your 10 % minimum; day 1 of 14');
  assert.equal(ds[4]!.decision.reason, 'Hold XLM: 8.5 % net of the exit, under your 10 % minimum, 3 of 6 hours before exit; day 1 of 14', 'the third bad hour no longer exits');
  assert.equal(ds[4]!.act, null);
  assert.equal(ds[7]!.decision.reason, 'Exit XLM: 8.5 % net of the exit, under your 10 % minimum, 6 of 6 hours in a row');
  assert.deepEqual(ds[7]!.act, { kind: 'exit', reason: ds[7]!.decision.reason });
  assert.equal(ds[7]!.vetoCandidate, null);
  assert.equal(ds[7]!.counters.lastExitAt, T0 + 7 * HOUR);
  assert.equal(ds[7]!.counters.badChecks, 0);
});

test('the owner\'s counts: rules set the exit and the entry; the defaults are enter 3, exit 6', () => {
  assert.equal(LOOP_RULES.enterAfterChecks, 3);
  assert.equal(LOOP_RULES.exitAfterChecks, 6);
  assert.equal(STRATEGY.enterAfterChecks, LOOP_RULES.enterAfterChecks);
  assert.equal(STRATEGY.exitAfterChecks, LOOP_RULES.exitAfterChecks);
  const bad = () => [win(XLM, { netAprPct: 7.25 })];
  const three = hours(input({ held: held(XLM), rules: { exitAfterChecks: 3 } }), 3, bad);
  assert.deepEqual(actions(three), ['hold', 'hold', 'exit']);
  assert.equal(three[2]!.decision.reason, 'Exit XLM: 8.5 % net of the exit, under your 10 % minimum, 3 of 3 hours in a row');
  const enter = hours(input({ rules: { enterAfterChecks: 5 } }), 5, () => [win(XLM)]);
  assert.deepEqual(actions(enter), ['wait', 'wait', 'wait', 'wait', 'enter']);
  assert.equal(enter[3]!.decision.reason, 'XLM 15.0 % net, 4 of 5 hours above 10 %');
  // The default entry count stays 3 while the exit count is 6.
  assert.deepEqual(actions(hours(input(), 3, () => [win(XLM)])), ['wait', 'wait', 'enter']);
});

test('a changed count never resets a count in progress: raising it does not exit early, lowering it acts on the count reached', () => {
  const bad = () => [win(XLM, { netAprPct: 7.25 })];
  // Two bad hours under exit 3, then the owner raises it to 6: the third bad hour is 3 of 6, no exit; the sixth exits.
  const before = hours(input({ held: held(XLM), rules: { exitAfterChecks: 3 } }), 2, bad);
  assert.equal(before[1]!.counters.badChecks, 2);
  const after = hours(input({ held: held(XLM), now: T0 + 2 * HOUR, counters: before[1]!.counters, rules: { exitAfterChecks: 6 } }), 4, bad);
  assert.deepEqual(actions(after), ['hold', 'hold', 'hold', 'exit']);
  assert.match(after[0]!.decision.reason, /, 3 of 6 hours before exit; /);
  // Lowering 6 to 3 with 4 bad hours counted: the next check, a scan event too, acts on the count already reached.
  const four = hours(input({ held: held(XLM) }), 4, bad);
  assert.equal(four[3]!.counters.badChecks, 4);
  assert.equal(four[3]!.decision.action, 'hold');
  const lowered = decide(input({ held: held(XLM), hourly: false, now: T0 + 3 * HOUR + 5_000, windows: bad(), counters: four[3]!.counters, rules: { exitAfterChecks: 3 } }));
  assert.equal(lowered.decision.action, 'exit');
  // The entry count: two hours counted under 3, raised to 5: no entry at the third, the count goes on to 5.
  const seen = hours(input(), 2, () => [win(XLM)]);
  assert.equal(seen[1]!.counters.aboveByWindow[XLM], 2);
  const raised = hours(input({ now: T0 + 2 * HOUR, counters: seen[1]!.counters, rules: { enterAfterChecks: 5 } }), 3, () => [win(XLM)]);
  assert.deepEqual(actions(raised), ['wait', 'wait', 'enter']);
  assert.equal(raised[0]!.counters.aboveByWindow[XLM], 3);
  assert.equal(raised[0]!.decision.reason, 'XLM 15.0 % net, 3 of 5 hours above 10 %');
});

test('exit when the rest of the hold nets below zero, or the spread flipped this hour or over 7 or 14 days', () => {
  const neg = hours(input({ held: held(XLM) }), 6, () => [win(XLM, { netAprPct: -5 })]);
  assert.equal(neg[5]!.decision.reason, 'Exit XLM: -3.8 % net of the exit, under your 10 % minimum, 6 of 6 hours in a row');
  const flip = hours(input({ held: held(XLM) }), 6, () => [win(XLM, { grossAprPct: -6 })]);
  assert.equal(flip[5]!.decision.reason, 'Exit XLM: the spread flipped: this hour pays -6.0 %, 6 of 6 hours in a row');
  const d7 = hours(input({ held: held(XLM) }), 6, () => [win(XLM, { grossApr7dPct: -1 })]);
  assert.equal(d7[5]!.decision.action, 'exit');
  const d14 = hours(input({ held: held(XLM), gross14dAprPct: { [XLM]: -2 } }), 6, () => [win(XLM)]);
  assert.equal(d14[5]!.decision.reason, 'Exit XLM: the spread flipped: the 14-day spread is -2.0 %, 6 of 6 hours in a row');
});

test('the time stop and the drawdown stop exit at once, on any check; drawdown is P&L against the leg', () => {
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

test('held pair numbers unknown: no act, a wait that says so, never counted healthy', () => {
  const counters = { ...NO_COUNTERS, badChecks: 2, lastHourlyAt: T0 - HOUR };
  const check = (h: ReturnType<typeof held>, windows = [win(XLM)], strategy = STRATEGY) => {
    const d = decide(input({ held: h, windows, counters, strategy }));
    assert.equal(d.decision.action, 'wait');
    assert.equal(d.act, null);
    assert.equal(d.vetoCandidate, null);
    assert.equal(d.counters.badChecks, 2, 'a healthy hour would reset this to 0');
    assert.equal(d.counters.lastWaitReason, `held-unknown:${XLM}`);
    return d.decision.reason;
  };
  assert.equal(check(held(XLM, { pnlUsd: NaN })), 'Held pair numbers unknown: XLM P&L is not a number (NaN); nothing is decided on XLM');
  // An unknown P&L never trips the drawdown stop, a known one far down would.
  assert.match(check(held(XLM, { pnlUsd: -Infinity })), /XLM P&L is not a number \(-Infinity\)/);
  assert.match(check(held(XLM, { legUsd: 0 })), /XLM leg size is not a positive number \(0\)/);
  assert.match(check(held(XLM, { legUsd: -12 })), /XLM leg size is not a positive number \(-12\)/);
  assert.match(check(held(XLM, { legUsd: NaN })), /XLM leg size is not a positive number \(NaN\)/);
  assert.match(check(held(XLM), [win(XLM, { netAprPct: NaN })]), /XLM net APR is not a number \(NaN\)/);
  assert.match(check(held(XLM), [win(XLM, { grossAprPct: NaN })]), /XLM gross APR this hour is not a number/);
  assert.match(check(held(XLM), [win(XLM, { costs: { feesPct: NaN, slippagePct: 0.5, basisPct: 0.5, rescueReservePct: 0 } })]), /XLM fees is not a number/);
  assert.match(check(held(XLM), [win(XLM)], { ...STRATEGY, stopDrawdownPct: NaN }), /your drawdown stop is not a number/);
  // No rotation either, whatever beats it.
  const better = [win(XLM, { netAprPct: NaN }), win('zec-phoenix-hyperliquid', { netAprPct: 40, switchCostUsd: 0.01 })];
  const ds = hours(input({ held: held(XLM) }), 5, () => better);
  assert.ok(ds.every((d) => d.decision.action === 'wait' && d.act === null));
  assert.deepEqual(ds[4]!.counters.betterByWindow, {});
});

test('the stops come first: no unknown number keeps a losing or overdue pair open', () => {
  const nanFees = win(XLM, { costs: { feesPct: NaN, slippagePct: 0.5, basisPct: 0.5, rescueReservePct: 0 } });
  // P&L -3 on a 12 USD leg, 10 % stop, a NaN in the scan: the drawdown stop exits.
  const down = decide(input({ held: held(XLM, { pnlUsd: -3 }), windows: [nanFees] }));
  assert.equal(down.decision.action, 'exit');
  assert.equal(down.decision.reason, 'Exit XLM: down $3.00, 25.0 % of the $12.00 leg, at your 10 % stop');
  assert.deepEqual(down.act, { kind: 'exit', reason: down.decision.reason });
  // An unknown P&L held 20 days: the time stop exits.
  const old = decide(input({ held: held(XLM, { pnlUsd: NaN, since: T0 - 20 * 24 * HOUR }), windows: [win(XLM)] }));
  assert.equal(old.decision.action, 'exit');
  assert.equal(old.decision.reason, 'Exit XLM: held 20.0 days, the 14-day time stop');
  // The same with an unknown minimum, 7-day spread or net in the scan.
  const noMin = { ...STRATEGY, minNetAprPct: NaN };
  assert.equal(decide(input({ held: held(XLM, { pnlUsd: -3 }), windows: [win(XLM)], strategy: noMin })).decision.action, 'exit');
  assert.equal(decide(input({ held: held(XLM, { since: T0 - 15 * 24 * HOUR }), windows: [win(XLM, { grossApr7dPct: NaN })] })).decision.action, 'exit');
  assert.equal(decide(input({ held: held(XLM, { pnlUsd: -3 }), windows: [win(XLM, { netAprPct: NaN })] })).decision.action, 'exit');
  // Each stop needs only its own numbers: an unknown P&L does not stop the time stop, an unknown entry time does
  // not stop the drawdown stop.
  assert.equal(decide(input({ held: held(XLM, { pnlUsd: -3, since: NaN }), windows: [win(XLM)] })).decision.action, 'exit');
  // Short of both stops, the unknown number is a wait.
  assert.equal(decide(input({ held: held(XLM, { pnlUsd: -1 }), windows: [nanFees] })).decision.action, 'wait');
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
/** The held XLM window with no costs: held, it nets its netAprPct, so the gains below read plainly. */
const heldWin = (netAprPct: number) => win(XLM, { netAprPct, costs: { feesPct: 0, slippagePct: 0, basisPct: 0, rescueReservePct: 0 } });

test('a challenger\'s gain is over the held window as compression measures it', () => {
  // XLM at 15 % net with costs is 16.25 % from here (the open is sunk); ZEC at 18.5 % beats the 15 by 3.5 pts
  // but the held figure by under 3: no rotation, not even a count.
  const ds = hours(input({ held: held(XLM) }), 5, () => [win(XLM, { netAprPct: 15 }), win(ZEC, { netAprPct: 18.5, switchCostUsd: 0.001 })]);
  assert.ok(ds.every((d) => d.decision.action === 'hold'));
  assert.deepEqual(ds[4]!.counters.betterByWindow, {});
  // At 20 % it beats the held figure by 3.75 pts and rotates; the line names the held window's figure.
  const r = hours(input({ held: held(XLM) }), 4, () => [win(XLM, { netAprPct: 15 }), win(ZEC, { netAprPct: 20, switchCostUsd: 0.001 })]);
  assert.equal(r[3]!.decision.action, 'rotate');
  assert.match(r[3]!.decision.reason, /20\.0 % net vs 16\.3 % held, \+3\.8 pts for 4 of 4 hours/);
});

test('rotate once another window beat the held one by 3 pts for 4 hourly checks and the switch pays back', () => {
  // +10 pts on 12 USD is 0.000137 USD an hour: a 0.01 USD switch pays back in 73 h.
  const ds = hours(input({ held: held(XLM) }), 5, () => [heldWin(15), win(ZEC, { netAprPct: 25, switchCostUsd: 0.01 })]);
  assert.deepEqual(actions(ds), ['hold', 'hold', 'hold', 'rotate', 'hold']);
  assert.equal(ds[2]!.decision.reason, 'Hold XLM: 15.0 % net of the exit, at least your 10 % minimum; day 1 of 14; ZEC beats it by 10.0 pts, 3 of 4 hours');
  const r = ds[3]!;
  assert.deepEqual(r.act, { kind: 'rotate', fromId: XLM, toId: ZEC, legUsd: 12, leverage: 1.5, qty: '12' });
  assert.equal(r.vetoCandidate, ZEC);
  assert.equal(r.decision.windowId, ZEC);
  assert.equal(r.decision.heldId, XLM);
  assert.equal(r.decision.reason, 'Rotate XLM -> ZEC (long Phoenix, short Hyperliquid): 25.0 % net vs 15.0 % held, +10.0 pts for 4 of 4 hours; '
    + 'the $0.01 switch pays back in 3.0 of the 13.9 days left; $12.00 a leg at 1.5x');
  assert.deepEqual(r.counters.rotationsAt, [T0 + 3 * HOUR]);
  assert.deepEqual(r.counters.betterByWindow, {});
});

test('a gain under minGainPts, or a switch that does not pay back within the rest of the hold, does not rotate', () => {
  const small = hours(input({ held: held(XLM) }), 6, () => [heldWin(15), win(ZEC, { netAprPct: 17.9, switchCostUsd: 0.01 })]);
  assert.ok(small.every((d) => d.decision.action === 'hold'));
  assert.deepEqual(small[5]!.counters.betterByWindow, {});
  // +4 pts on 12 USD over 13.9 days pays 0.0183 USD: a 0.03 USD switch does not pay back.
  const slow = hours(input({ held: held(XLM) }), 5, () => [heldWin(15), win(ZEC, { netAprPct: 19, switchCostUsd: 0.03 })]);
  assert.ok(slow.every((d) => d.decision.action === 'hold'));
  assert.equal(slow[4]!.decision.reason, 'Hold XLM: 15.0 % net of the exit, at least your 10 % minimum; day 1 of 14; '
    + 'ZEC beats it by 4.0 pts, but the $0.03 switch takes 22.8 days to pay back, 13.8 are left');
  const unknown = hours(input({ held: held(XLM) }), 5, () => [heldWin(15), win(ZEC, { netAprPct: 30 })]);
  assert.match(unknown[4]!.decision.reason, /ZEC beats it by 15\.0 pts, but its switch cost is not known$/);
});

test('payback is the gain on the leg actually sized; the switch cost is not scaled down with it', () => {
  const windows = (cost: number) => () => [heldWin(15), win(ZEC, { netAprPct: 25, switchCostUsd: cost })];
  // 7 USD free on each venue at 1.5x sizes 10.50: +10 pts on 10.50 is 0.000120 USD an hour.
  const free = { hyperliquid: 7, phoenix: 7 };
  const small = hours(input({ held: held(XLM), freeMarginUsd: free }), 4, windows(0.01));
  assert.deepEqual(small[3]!.act, { kind: 'rotate', fromId: XLM, toId: ZEC, legUsd: 10.5, leverage: 1.5, qty: '10.5' });
  assert.match(small[3]!.decision.reason, /the \$0\.01 switch pays back in 3\.5 of the 13\.9 days left; \$10\.50 a leg at 1\.5x$/);
  // 0.042 USD pays back in 12.8 days on a 12 USD leg, but in 14.6 on the 10.50 one: 13.9 days are left.
  assert.equal(hours(input({ held: held(XLM) }), 4, windows(0.042))[3]!.decision.action, 'rotate');
  const slow = hours(input({ held: held(XLM), freeMarginUsd: free }), 4, windows(0.042));
  assert.equal(slow[3]!.decision.action, 'hold');
  assert.match(slow[3]!.decision.reason, /ZEC beats it by 10\.0 pts, but the \$0\.04 switch takes 14\.6 days to pay back, 13\.9 are left$/);
});

test('prefers a window on the venues that hold the margin; a cross-venue switch must pay its transfers', () => {
  // SOL long Orderly / short Phoenix nets more, but moving margin onto Orderly makes its switch 1.60 USD.
  const windows = [heldWin(12), win(ZEC, { netAprPct: 24, switchCostUsd: 0.04 }), win(SOL_X, { netAprPct: 30, switchCostUsd: 1.6 })];
  const ds = hours(input({ held: held(XLM) }), 4, () => windows);
  assert.deepEqual(ds[3]!.act, { kind: 'rotate', fromId: XLM, toId: ZEC, legUsd: 12, leverage: 1.5, qty: '12' });
  // Even when the cross-venue switch would pay back, the same venues come first.
  const cheap = [heldWin(12), win(ZEC, { netAprPct: 24, switchCostUsd: 0.04 }), win(SOL_X, { netAprPct: 30, switchCostUsd: 0.05 })];
  assert.deepEqual(hours(input({ held: held(XLM) }), 4, () => cheap)[3]!.act, { kind: 'rotate', fromId: XLM, toId: ZEC, legUsd: 12, leverage: 1.5, qty: '12' });
  // Alone, the cross-venue one rotates only when its transfers pay back.
  const alone = hours(input({ held: held(XLM) }), 4, () => [heldWin(12), win(SOL_X, { netAprPct: 30, switchCostUsd: 1.6 })]);
  assert.equal(alone[3]!.decision.action, 'hold');
  assert.match(alone[3]!.decision.reason, /SOL beats it by 18\.0 pts, but the \$1\.60 switch takes 270\.4 days to pay back/);
  const paid = hours(input({ held: held(XLM) }), 4, () => [heldWin(12), win(SOL_X, { netAprPct: 30, switchCostUsd: 0.05 })]);
  assert.deepEqual(paid[3]!.act, { kind: 'rotate', fromId: XLM, toId: SOL_X, legUsd: 12, leverage: 1.5, qty: '12' });
});

test('at most 2 rotations in 24 h', () => {
  const windows = [heldWin(12), win(ZEC, { netAprPct: 30, switchCostUsd: 0.04 })];
  const counters = { ...NO_COUNTERS, rotationsAt: [T0 - 20 * HOUR, T0 - 2 * HOUR] };
  const ds = hours(input({ held: held(XLM), counters }), 6, () => windows);
  assert.deepEqual(actions(ds), ['hold', 'hold', 'hold', 'hold', 'rotate', 'hold']);
  assert.match(ds[3]!.decision.reason, /ZEC beats it by 18\.0 pts, but 2 rotations in 24 h is the most$/);
  // At hour 4 the first rotation is 24 h old: one slot is free again.
  assert.deepEqual(ds[4]!.counters.rotationsAt, [T0 - 2 * HOUR, T0 + 4 * HOUR]);
});

test('a rotation sizes the new legs with the margin loop.ts says the held legs free, and none when it does not say', () => {
  const windows = [heldWin(12), win(ZEC, { netAprPct: 30, switchCostUsd: 0.04 })];
  const free = { hyperliquid: 3, phoenix: 3 };
  // 3 USD free on each venue plus 6 USD freed is 9 USD: 13.50 at 1.5x, capped at 12.
  const ds = hours(input({ held: held(XLM), freeMarginUsd: free, freedMarginUsd: { hyperliquid: 6, phoenix: 6 } }), 4, () => windows);
  assert.deepEqual(ds[3]!.act, { kind: 'rotate', fromId: XLM, toId: ZEC, legUsd: 12, leverage: 1.5, qty: '12' });
  // Freed on one venue only: Phoenix's 3 USD at 1.5x is 4.50, so ZEC fails the gate and is never counted better.
  const oneFreed = input({ held: held(XLM), freeMarginUsd: free, freedMarginUsd: { hyperliquid: 6 } });
  const one = hours(oneFreed, 4, () => windows);
  assert.equal(one[3]!.decision.action, 'hold');
  assert.equal(one[3]!.counters.betterByWindow[ZEC], undefined);
  assert.match(entryFailure(win(ZEC), oneFreed)!, /^\$3\.00 free margin on Phoenix at 1\.5x opens \$4\.50 a leg in whole lots, under the \$10\.00 minimum/);
  // Absent: no freed margin is guessed from the held leg.
  const none = hours(input({ held: held(XLM), freeMarginUsd: free }), 4, () => windows);
  assert.equal(none[3]!.decision.action, 'hold');
  assert.equal(none[3]!.counters.betterByWindow[ZEC], undefined);
});

test('rotation comes before a counted exit: a better window replaces a compressed one without a cooldown', () => {
  // XLM at 6.5 % is 7.75 % held: under the minimum.
  const both = () => [win(XLM, { netAprPct: 6.5 }), win(ZEC, { netAprPct: 20, switchCostUsd: 0.04 })];
  // 4 better hours come before 6 bad ones: rotate.
  const ds = hours(input({ held: held(XLM) }), 4, both);
  assert.deepEqual(actions(ds), ['hold', 'hold', 'hold', 'rotate']);
  assert.equal(ds[3]!.counters.lastExitAt, null);
  // With an exit count of 3 the exit comes first (3 bad hours before 4 better ones): the counts are what they are.
  const early = hours(input({ held: held(XLM), rules: { exitAfterChecks: 3 } }), 4, both, (h) => (h <= 2 ? held(XLM) : null));
  assert.deepEqual(actions(early), ['hold', 'hold', 'exit', 'wait']);
  const quick = hours(input({ held: held(XLM), rules: { exitAfterChecks: 3 }, strategy: { ...STRATEGY, rotate: { minGainPts: 3, forHours: 3 } } }), 3, both);
  assert.equal(quick[2]!.decision.action, 'rotate');
  assert.equal(quick[2]!.counters.lastExitAt, null);
});

// ---- veto, failures and the journal rule ----

test('skipAct: a failed act leaves this check\'s counts and none of the act\'s marks', () => {
  const ds = hours(input({ held: held(XLM) }), 6, () => [win(XLM, { netAprPct: 7 })]);
  const lastIn = input({ held: held(XLM), now: T0 + 5 * HOUR, windows: [win(XLM, { netAprPct: 7 })], counters: ds[4]!.counters });
  const exit = ds[5]!;
  assert.equal(exit.counters.lastExitAt, T0 + 5 * HOUR);
  const failed = skipAct(lastIn, exit);
  assert.equal(failed.lastExitAt, null);
  assert.equal(failed.badChecks, 6, 'the exit is tried again on the next check');
  const retry = decide({ ...lastIn, hourly: false, now: lastIn.now + 5_000, counters: failed });
  assert.equal(retry.decision.action, 'exit');

  const windows = [heldWin(12), win(ZEC, { netAprPct: 30, switchCostUsd: 0.04 })];
  const rs = hours(input({ held: held(XLM) }), 4, () => windows);
  const rIn = input({ held: held(XLM), now: T0 + 3 * HOUR, windows, counters: rs[2]!.counters });
  const notDone = skipAct(rIn, rs[3]!);
  assert.deepEqual(notDone.rotationsAt, []);
  assert.equal(notDone.betterByWindow[ZEC], 4);
  assert.deepEqual(notDone.vetoedUntil, {});
  const w = decide(input({ windows: [win(XLM)] }));
  assert.equal(skipAct(input({ windows: [win(XLM)] }), w), w.counters);
});

test('a vetoed entry holds that window out for 6 h, says so, and its count starts again after', () => {
  const ds = hours(input(), 3, () => [win(XLM)]);
  assert.equal(ds[2]!.decision.action, 'enter');
  const at = T0 + 2 * HOUR;
  const vetoed = skipAct(input({ now: at, windows: [win(XLM)], counters: ds[1]!.counters }), ds[2]!, { vetoed: true });
  assert.equal(LOOP_RULES.vetoHoldHours, 6);
  assert.deepEqual(vetoed.vetoedUntil, { [XLM]: at + 6 * HOUR });
  assert.equal(vetoed.aboveByWindow[XLM], undefined);
  // The next scan event and the next hours: no enter, no new veto question; the wait names the veto.
  const scan = decide(input({ hourly: false, now: at + 5_000, windows: [win(XLM)], counters: vetoed }));
  assert.equal(scan.decision.action, 'wait');
  assert.equal(scan.vetoCandidate, null);
  const after = hours(input({ now: at + HOUR, counters: vetoed }), 8, () => [win(XLM)]);
  assert.deepEqual(actions(after), ['wait', 'wait', 'wait', 'wait', 'wait', 'wait', 'wait', 'enter']);
  assert.equal(after[0]!.decision.reason, 'No window clears the entry rules; best XLM 15.0 % net: refused by the NEAR AI risk check, held out for 5.0 h more');
  assert.equal(after[0]!.counters.lastWaitReason, `blocked:${XLM}:vetoed`);
  assert.equal(entryFailure(win(XLM), { strategy: STRATEGY, now: at + HOUR, counters: vetoed }), 'refused by the NEAR AI risk check, held out for 5.0 h more');
  // At 6 h the hold is over and the count starts from 1.
  assert.equal(after[5]!.decision.reason, 'XLM 15.0 % net, 1 of 3 hours above 10 %');
  assert.deepEqual(after[5]!.counters.vetoedUntil, {});
});

test('a vetoed window drops out: the next one in the scanner\'s rank is entered, and the wait names the veto', () => {
  const windows = () => [win(XLM), win(SOL, { netAprPct: 12 })];
  const ds = hours(input(), 3, windows);
  assert.deepEqual(ds[2]!.act, { kind: 'enter', windowId: XLM, legUsd: 12, leverage: 1.5, qty: '12' });
  const vetoed = skipAct(input({ now: T0 + 2 * HOUR, windows: windows(), counters: ds[1]!.counters }), ds[2]!, { vetoed: true });
  assert.equal(vetoed.aboveByWindow[SOL], 3, 'only the vetoed window\'s count goes');
  const next = decide(input({ now: T0 + 3 * HOUR, windows: windows(), counters: vetoed }));
  assert.deepEqual(next.act, { kind: 'enter', windowId: SOL, legUsd: 12, leverage: 1.5, qty: '12' });
  // While the next one warms up, its wait names the veto above it.
  const fresh = skipAct(input({ now: T0 + 2 * HOUR, windows: windows(), counters: ds[1]!.counters }), ds[2]!, { vetoed: true });
  const warming = decide(input({ now: T0 + 3 * HOUR, windows: windows(), counters: { ...fresh, aboveByWindow: {} } }));
  assert.equal(warming.decision.reason, 'SOL 12.0 % net, 1 of 3 hours above 10 %; XLM refused by the NEAR AI risk check, held out for 5.0 h more');
  assert.equal(warming.counters.lastWaitReason, `warming:${SOL}:1:veto:${XLM}`);
});

test('a vetoed rotation target is not rotated into again for 6 h', () => {
  const windows = [heldWin(12), win(ZEC, { netAprPct: 30, switchCostUsd: 0.04 })];
  const rs = hours(input({ held: held(XLM) }), 4, () => windows);
  assert.equal(rs[3]!.decision.action, 'rotate');
  const rIn = input({ held: held(XLM), now: T0 + 3 * HOUR, windows, counters: rs[2]!.counters });
  const vetoed = skipAct(rIn, rs[3]!, { vetoed: true });
  assert.equal(vetoed.betterByWindow[ZEC], undefined);
  assert.deepEqual(vetoed.vetoedUntil, { [ZEC]: T0 + 9 * HOUR });
  const after = hours(input({ held: held(XLM), now: T0 + 4 * HOUR, counters: vetoed }), 10, () => windows);
  // Held out until hour 9, then 4 fresh hours of beating it: hours 9, 10, 11, 12.
  assert.deepEqual(actions(after), ['hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'rotate', 'hold']);
  assert.equal(after[4]!.counters.betterByWindow[ZEC], undefined);
});

test('saved counters from before vetoedUntil existed are read as none vetoed', () => {
  const { vetoedUntil: _, ...old } = NO_COUNTERS;
  const legacy = old as LoopCounters;
  const d = decide(input({ windows: [win(XLM)], counters: legacy }));
  assert.deepEqual(d.counters.vetoedUntil, {});
  assert.equal(d.counters.aboveByWindow[XLM], 1);
  const ds = hours(input({ counters: legacy }), 3, () => [win(XLM)]);
  assert.equal(ds[2]!.decision.action, 'enter');
  const v = skipAct(input({ now: T0 + 2 * HOUR, windows: [win(XLM)], counters: legacy }), ds[2]!, { vetoed: true });
  assert.deepEqual(v.vetoedUntil, { [XLM]: T0 + 8 * HOUR });
  assert.equal(entryFailure(win(XLM), { strategy: STRATEGY, now: T0, counters: legacy }), null);
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
    decide(input({ held: held(XLM, { pnlUsd: NaN }), windows: [win(XLM)] })),
  ];
  for (const d of all) {
    assert.ok(['wait', 'hold', 'off'].includes(d.decision.action));
    assert.equal(d.act, null);
    assert.equal(d.vetoCandidate, null);
    assert.ok(d.decision.reason.length > 0 && !d.decision.reason.includes('\n'));
  }
});
