// The expected carry of a desk window by hand: round trip, spread over the hold, break-even, the gate and its lines.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakevenDays, carryChecks, carryEstimate, holdLabel, listingApr, money, multiDay, roundTrip, spreadOverHoldUsd } from './carry.ts';

const near = (actual: number | null, expected: number, eps = 1e-9) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

test('round trip: fees on 4 fills + slippage + basis buffer (adverse gap, timing, buffer bps), and its bps of a leg', () => {
  // 20 USD on Hyperliquid (5.5 bps) and Phoenix (3.5 bps): 20 × 2 × 9 / 10⁴ = 0.036 fees; 5 bps buffer = 0.01.
  const rt = roundTrip(20, 0.036, 0.004, 0, 0, 5);
  near(rt.basisBufferUsd, 0.01);
  near(rt.totalUsd, 0.05);
  near(rt.bps, 25);
  // An adverse gap of 0.007 at entry and 0.002 lost to an 8 h schedule ride on the buffer.
  near(roundTrip(20, 0.036, 0.004, 0.007, 0.002, 5).basisBufferUsd, 0.019);
  assert.throws(() => roundTrip(0, 0, 0, 0, 0, 5), RangeError);
});

test('spread over the hold and break-even days', () => {
  // 10.95 % a year on 20 USD for 240 h: 0.1095 × 20 × 240 / 8760 = 0.06 USD.
  near(spreadOverHoldUsd(10.95, 20, 240), 0.06);
  // 0.05 USD at 10.95 % on 20 USD: 0.006 USD a day, 8.33 days.
  near(breakevenDays(0.05, 10.95, 20), 0.05 / (0.1095 * 20 / 365));
  assert.equal(breakevenDays(0.05, 0, 20), null);
  assert.equal(breakevenDays(0.05, -3, 20), null);
});

test('the multi-day figure: both means of one sign, the smaller of them; the 7 days while the week before loads or alone when it cannot', () => {
  assert.deepEqual(multiDay(5.1, 10.9, false), { state: 'known', basis: '7d', aprPct: 5.1 });
  assert.deepEqual(multiDay(12, 10.9, false), { state: 'known', basis: '14d', aprPct: 10.9 });
  // A decaying spread is judged on what is left of it, a flipped one is not steady in either direction.
  assert.deepEqual(multiDay(-3, -8, false), { state: 'known', basis: '7d', aprPct: -3 });
  assert.deepEqual(multiDay(5.1, -2, false), { state: 'mixed', d7AprPct: 5.1, d14AprPct: -2 });
  assert.deepEqual(multiDay(-5.1, 2, true), { state: 'mixed', d7AprPct: -5.1, d14AprPct: 2 });
  // No 14 days: loading while a leg's older read may still answer, else the 7 days alone.
  assert.deepEqual(multiDay(5.1, null, true), { state: 'loading', d7AprPct: 5.1 });
  assert.deepEqual(multiDay(5.1, null, false), { state: 'known', basis: '7d', aprPct: 5.1 });
  assert.deepEqual(multiDay(null, null, true), { state: 'none' });
  assert.deepEqual(multiDay(null, 3, false), { state: 'none' });
  // Listed on: the figure when known, the 7 days while loading; mixed and none say nothing (none goes by this hour).
  assert.equal(listingApr(multiDay(12, 10.9, false)), 10.9);
  assert.equal(listingApr(multiDay(5.1, null, true)), 5.1);
  assert.equal(listingApr(multiDay(5.1, -2, false)), null);
  assert.equal(listingApr(multiDay(null, null, true)), null);
});

const RT = roundTrip(20, 0.036, 0.004, 0, 0, 5);
const estimate = (d7: number | null, d14: number | null, pending: boolean, minNetAprPct = 0, now = -1.21) =>
  carryEstimate({ legUsd: 20, holdHours: 240, grossNowAprPct: now, gross7dAprPct: d7, gross14dAprPct: d14, multiDay: multiDay(d7, d14, pending), roundTrip: RT, minNetAprPct });
const RT_TEXT = '$0.05 round trip (4 fills $0.04, slippage $0.0040, basis buffer $0.01; 25.0 bps)';

test('the gate: a 14-day spread that a weaker 7 days undercut fails; the spread must pay the round trip and the owner\'s minimum', () => {
  // DOGE, 2026-11-03: this hour pays -1.21 % short Hyperliquid / long Phoenix, the 14 days 10.95 %, the last 7 only
  // 5.11 %. The spread is decaying: judged on the 7 days, 0.028 USD over 10 days, short of the 0.05 round trip.
  const doge = estimate(5.11, 10.95, false);
  assert.equal(doge.basis, '7d');
  near(doge.expectedUsd, 0.028);
  assert.equal(doge.ok, false);
  assert.deepEqual(carryChecks(doge), [
    { ok: false, text: 'Over a 10-day hold (assumed: the engine rules set none), the 7-day spread of 5.11 % APR (the smaller of the 7- and 14-day means) '
      + `pays $0.03 at $20.00 a leg, no more than the ${RT_TEXT}: it takes 17.9 days to pay it back` },
    { ok: true, text: 'Listed on the 7-day spread: this hour pays -1.21 % APR in this direction' },
  ]);

  // 12 % over 7 days and 10.95 % over 14: judged on 10.95 %, 0.06 USD over the hold, 0.01 USD net of the round trip,
  // which is 0.01 / 20 × 8760 / 240 = 1.825 % APR net over the hold.
  const steady = estimate(12, 10.95, false, 1);
  assert.equal(steady.basis, '14d');
  near(steady.expectedUsd, 0.06);
  near(steady.netUsd, 0.01);
  near(steady.netAprPct, 1.825);
  assert.equal(steady.ok, true);
  assert.deepEqual(carryChecks(steady)[0], {
    ok: true,
    text: 'Over a 10-day hold (assumed: the engine rules set none), the 14-day spread of 10.95 % APR (the smaller of the 7- and 14-day means) '
      + `pays $0.06 at $20.00 a leg, more than the ${RT_TEXT}: it nets 1.82 % APR over the hold, at least your 1 % minimum, `
      + 'and pays the round trip back in 8.3 days',
  });
  // The same window under a 5 % minimum: it pays the round trip, but not the owner's minimum.
  const under = estimate(12, 10.95, false, 5);
  assert.equal(under.ok, false);
  assert.deepEqual(carryChecks(under)[0], {
    ok: false,
    text: 'Over a 10-day hold (assumed: the engine rules set none), the 14-day spread of 10.95 % APR (the smaller of the 7- and 14-day means) '
      + `pays $0.06 at $20.00 a leg, more than the ${RT_TEXT}, but it nets only 1.82 % APR over the hold, under your 5 % minimum`,
  });

  // The 7 days alone, the older week not to be had: judged on them.
  const alone = estimate(12, null, false, 0, 3);
  assert.equal(alone.basis, '7d');
  assert.equal(alone.ok, true);
  assert.match(carryChecks(alone)[0]!.text, /the 7-day spread of 12\.00 % APR \(the 14-day mean could not be had\) pays/);
  assert.equal(carryChecks(alone).length, 1, 'this hour pays in this direction too: no note');
});

test('the gate fails while the week before loads, when the 7 and 14 days disagree, and without history', () => {
  const loading = estimate(12, null, true);
  assert.equal(loading.state, 'loading');
  assert.equal(loading.ok, false);
  assert.equal(loading.netUsd, null);
  assert.deepEqual(carryChecks(loading), [
    { ok: false, text: `14-day history loading: the 7-day spread of 12.00 % APR is in, the week before it is still being read; the gate waits for both, against a ${RT_TEXT}` },
    { ok: true, text: 'Listed on the 7-day spread: this hour pays -1.21 % APR in this direction' },
  ]);

  const mixed = estimate(5.11, -2, false);
  assert.equal(mixed.state, 'mixed');
  assert.equal(mixed.ok, false);
  assert.deepEqual(carryChecks(mixed), [
    { ok: false, text: 'The 7-day spread (5.11 % APR) and the 14-day spread (-2.00 % APR) point opposite ways: no steady carry in this direction' },
  ]);

  const none = estimate(null, null, true, 0, 30);
  assert.equal(none.ok, false);
  assert.equal(none.netUsd, null);
  assert.equal(none.breakevenDays, null);
  assert.match(carryChecks(none)[0]!.text, /^No 7-day funding history on both legs yet: the spread expected over a 10-day hold/);
  assert.equal(carryChecks(none)[0]!.ok, false);
});

test('labels: the hold in days or hours; money with the sign first and four decimals under a cent', () => {
  assert.equal(holdLabel(240), '10-day');
  assert.equal(holdLabel(100), '100 h');
  assert.equal(money(-0.0061), '-$0.0061');
  assert.equal(money(-0.02), '-$0.02');
  assert.equal(money(1234.5), '$1,235');
  assert.equal(money(0), '$0.00');
});
