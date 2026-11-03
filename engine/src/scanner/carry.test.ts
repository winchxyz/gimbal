// The expected carry of a desk window by hand: round trip, spread over the hold, break-even, the gate and its lines.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakevenDays, carryChecks, carryEstimate, holdLabel, money, multiDayApr, roundTrip, spreadOverHoldUsd } from './carry.ts';

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

test('the multi-day average: 14-day when known, else 7-day, else none', () => {
  assert.deepEqual(multiDayApr(5.1, 10.9), { basis: '14d', aprPct: 10.9 });
  assert.deepEqual(multiDayApr(5.1, null), { basis: '7d', aprPct: 5.1 });
  assert.deepEqual(multiDayApr(null, null), { basis: null, aprPct: null });
});

test('the gate: the spread over the hold must pay more than the round trip; the lines say what was assumed', () => {
  const rt = roundTrip(20, 0.036, 0.004, 0, 0, 5);
  // DOGE, 2026-11-03: this hour pays -1.21 % short Hyperliquid / long Phoenix, the 14 days 10.95 %.
  const e = carryEstimate({ legUsd: 20, holdHours: 240, grossNowAprPct: -1.21, gross7dAprPct: 5.11, gross14dAprPct: 10.95, roundTrip: rt });
  assert.equal(e.basis, '14d');
  near(e.expectedUsd, 0.06);
  near(e.netUsd, 0.01);
  assert.equal(e.ok, true);
  assert.deepEqual(carryChecks(e), [
    { ok: true, text: 'Over a 10-day hold (assumed: the engine rules set none), the 14-day spread of 10.95 % APR pays $0.06 at $20.00 a leg, '
      + 'more than the $0.05 round trip (4 fills $0.04, slippage $0.0040, basis buffer $0.01; 25.0 bps): even after 8.3 days' },
    { ok: true, text: 'Listed on the 14-day spread: this hour pays -1.21 % APR in this direction' },
  ]);

  // The 7 days alone (5.11 %) pay 0.028 USD: short of the 0.05 round trip.
  const short = carryEstimate({ legUsd: 20, holdHours: 240, grossNowAprPct: 3, gross7dAprPct: 5.11, gross14dAprPct: null, roundTrip: rt });
  assert.equal(short.basis, '7d');
  assert.equal(short.ok, false);
  assert.deepEqual(carryChecks(short), [{
    ok: false,
    text: 'Over a 10-day hold (assumed: the engine rules set none), the 7-day spread of 5.11 % APR pays $0.03 at $20.00 a leg, '
      + 'no more than the $0.05 round trip (4 fills $0.04, slippage $0.0040, basis buffer $0.01; 25.0 bps): it takes 17.9 days to pay it back',
  }]);

  // No history yet: not known, so the gate fails.
  const none = carryEstimate({ legUsd: 20, holdHours: 240, grossNowAprPct: 30, gross7dAprPct: null, gross14dAprPct: null, roundTrip: rt });
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
