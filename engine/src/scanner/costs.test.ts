// The net-carry cost terms on hand-computed cases. Units as in costs.ts: rates are fractions of notional per hour,
// money is USD at a 1000 USD leg unless said otherwise, APR is percentage points a year on one leg's notional.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aprPct, basisCostUsd, bookMid, breakevenHours, fillFeeBps, fundingTimingUsd, grossPerHour, hoursUntil, legSlippage,
  moveCostUsd, oneClickCostUsd, oneOffAprPct, paymentPeriodHours, rescueAmountUsd, rescueCostUsd, takerFeesUsd, walkBook,
} from './costs.ts';
import type { TransferCosts } from './costs.ts';

const near = (actual: number | null, expected: number, eps = 1e-9) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

const TRANSFERS: TransferCosts = {
  oneClickFlatUsd: { solana: 0.32, hypercore: 0.21, arbitrum: 0.32 },
  oneClickBps: 20,
  hlActivationUsd: 1,
  orderlyWithdrawUsd: 1,
  orderlyMinDepositUsd: 6,
};

test('APR: 0.0001 per hour is 87.6 % a year; gross is what the short receives minus what the long pays', () => {
  near(aprPct(0.0001), 87.6);
  // Long at 0.00001/h, short receives 0.00005/h: 0.00004/h = 35.04 % APR.
  near(grossPerHour(0.00001, 0.00005), 0.00004, 1e-15);
  near(aprPct(grossPerHour(0.00001, 0.00005)), 35.04);
  // A negative long rate is income for the long: long at -0.00002, short at 0.00001 = 0.00003/h.
  near(grossPerHour(-0.00002, 0.00001), 0.00003, 1e-15);
});

test('a one-off cost as APR: 1.20 USD on a 1000 USD leg held 168 h is 6.257 % a year', () => {
  // 1.2 / 1000 = 0.12 % of notional per week; 8760 / 168 = 52.142857 weeks a year.
  near(oneOffAprPct(1.2, 1000, 168), 6.257142857142857);
  near(oneOffAprPct(0, 1000, 168), 0);
  assert.throws(() => oneOffAprPct(1, 0, 168), RangeError);
  assert.throws(() => oneOffAprPct(1, 1000, 0), RangeError);
});

test('taker fees on the 4 fills: 1000 USD × 2 × (5.5 + 3.5) bps = 1.80 USD', () => {
  assert.equal(fillFeeBps({ takerBps: 4.5, extraBps: 1 }), 5.5);
  near(takerFeesUsd(1000, 5.5, 3.5), 1.8);
  near(takerFeesUsd(250, 3, 3), 0.3);
});

test('walking a book: a 1000 USD buy on asks 100.1 × 5 and 100.2 × 10 with mid 100 costs 1.497 USD', () => {
  // 500.5 USD fills at 100.1 (5 units, 0.10 over mid each: 0.50), 499.5 USD at 100.2 (4.98503 units: 0.99701).
  const w = walkBook([{ px: 100.1, sz: 5 }, { px: 100.2, sz: 10 }], 100, 1000, 'buy');
  near(w.costUsd, 0.5 + (0.2 * 499.5) / 100.2);
  near(w.filledUsd, 1000);
  near(w.avgPx!, 1000 / (5 + 499.5 / 100.2));
  assert.equal(w.exhausted, false);

  // A sell hits the bids: 1000 USD at 99.9 is 10.01 units, 0.10 under mid each = 1.001 USD.
  near(walkBook([{ px: 99.9, sz: 20 }], 100, 1000, 'sell').costUsd, 100 / 99.9);

  // Levels run out: 100.1 USD of the 1000 fills, and the walk says so.
  const thin = walkBook([{ px: 100.1, sz: 1 }], 100, 1000, 'buy');
  near(thin.filledUsd, 100.1);
  near(thin.costUsd, 0.1);
  assert.equal(thin.exhausted, true);

  // Empty and broken levels fill nothing.
  const none = walkBook([{ px: 0, sz: 5 }, { px: 100.1, sz: 0 }], 100, 1000, 'buy');
  assert.equal(none.filledUsd, 0);
  assert.equal(none.avgPx, null);
  assert.equal(none.exhausted, true);
  assert.throws(() => walkBook([], 0, 1000, 'buy'), RangeError);
  assert.throws(() => walkBook([], 100, 0, 'buy'), RangeError);
});

test('book mid from the best levels; null for an empty side or a crossed book', () => {
  assert.equal(bookMid([{ px: 99.9, sz: 1 }], [{ px: 100.1, sz: 1 }]), 100);
  assert.equal(bookMid([], [{ px: 100.1, sz: 1 }]), null);
  assert.equal(bookMid([{ px: 100.2, sz: 1 }], [{ px: 100.1, sz: 1 }]), null);
});

test('slippage of one leg: the long buys to open and sells to close, the short the other way round', () => {
  // Bids 99.9 × 100, asks 100.1 × 100, mid 100, 1000 USD: a buy costs 0.1 × 1000 / 100.1 = 0.999 USD, a sell
  // 0.1 × 1000 / 99.9 = 1.001 USD.
  const book = { bids: [{ px: 99.9, sz: 100 }], asks: [{ px: 100.1, sz: 100 }] };
  const long = legSlippage(book, 1000, 'long')!;
  near(long.openUsd, 100 / 100.1);
  near(long.closeUsd, 100 / 99.9);
  near(long.filledUsd, 1000);
  assert.equal(long.exhausted, false);
  const short = legSlippage(book, 1000, 'short')!;
  near(short.openUsd, 100 / 99.9);
  near(short.closeUsd, 100 / 100.1);
  // A book with too little on one side is exhausted; an empty side cannot be priced at all.
  assert.equal(legSlippage({ bids: [{ px: 99.9, sz: 1 }], asks: book.asks }, 1000, 'long')!.exhausted, true);
  assert.equal(legSlippage({ bids: [], asks: book.asks }, 1000, 'long'), null);
});

test('basis: a long 0.2 above the short at mid 100.1 loses 0.2 / 100.1 of the leg, 1.998 USD; the other way costs nothing', () => {
  near(basisCostUsd(100.2, 100.0, 1000), (0.2 / 100.1) * 1000);
  assert.equal(basisCostUsd(100.0, 100.2, 1000), 0);
  assert.equal(basisCostUsd(100, 100, 1000), 0);
  assert.throws(() => basisCostUsd(0, 100, 1000), RangeError);
});

test('payment periods: Orderly 8 h and 4 h, everything that accrues hourly or continuously counts as 1 h', () => {
  assert.equal(paymentPeriodHours('8h'), 8);
  assert.equal(paymentPeriodHours('4h'), 4);
  assert.equal(paymentPeriodHours('2h'), 2);
  assert.equal(paymentPeriodHours('hourly'), 1);
  assert.equal(paymentPeriodHours('daily'), 1);       // Phoenix accrues hourly; an exit settles what accrued
  assert.equal(paymentPeriodHours('continuous'), 1);
});

test('funding timing: an 8 h leg earning 0.12 USD/h over a 100 h hold can miss the last 4 h, 0.48 USD', () => {
  // 12 payments cover 96 h; the 4 h after the last one are not paid when the hold ends.
  near(fundingTimingUsd(0.12, 8, 100), 0.48);
  // A paying leg pays for every period it touches: 13 periods = 104 h, 4 h more than held.
  near(fundingTimingUsd(-0.12, 8, 100), 0.48);
  // 168 h is 21 whole 8 h periods: nothing lost either way; hourly schedules never lose anything.
  assert.equal(fundingTimingUsd(0.12, 8, 168), 0);
  assert.equal(fundingTimingUsd(-0.12, 8, 168), 0);
  assert.equal(fundingTimingUsd(0.12, 1, 100), 0);
  assert.equal(fundingTimingUsd(0, 8, 100), 0);
  assert.throws(() => fundingTimingUsd(0.1, 0, 100), RangeError);
});

test('1Click: 0.32 USD flat + 20 bps of 70 USD = 0.46 USD', () => {
  near(oneClickCostUsd(70, 0.32, 20), 0.46);
  near(oneClickCostUsd(0, 0.21, 20), 0.21);
  assert.throws(() => oneClickCostUsd(-1, 0.32, 20), RangeError);
});

test('moving margin: by the chain it leaves from, plus the exit fee; Phoenix and the reserve share a wallet', () => {
  // Hyperliquid -> Phoenix, 70 USD: 1.00 activation + 0.21 flat + 0.14 = 1.35 USD.
  near(moveCostUsd('hyperliquid', 'phoenix', 70, TRANSFERS), 1.35);
  // Reserve (Solana) -> Hyperliquid: 0.32 + 0.14 = 0.46 USD.
  near(moveCostUsd('reserve', 'hyperliquid', 70, TRANSFERS), 0.46);
  // Orderly -> Hyperliquid: 1.00 withdrawal + 0.32 flat (Arbitrum) + 0.14 = 1.46 USD.
  near(moveCostUsd('orderly', 'hyperliquid', 70, TRANSFERS), 1.46);
  // Into Orderly at least its 6 USD minimum: 3 USD asked moves 6, 0.32 + 0.012 = 0.332 USD.
  near(moveCostUsd('reserve', 'orderly', 3, TRANSFERS), 0.332);
  assert.equal(moveCostUsd('reserve', 'phoenix', 70, TRANSFERS), 0);
  assert.equal(moveCostUsd('phoenix', 'reserve', 70, TRANSFERS), 0);
  assert.equal(moveCostUsd('orderly', 'orderly', 70, TRANSFERS), 0);
});

test('rescue: 1000 USD legs, watch 15 % and rescue 8 %, move 70 USD; priced as the dearer leg route', () => {
  near(rescueAmountUsd(1000, 15, 8), 70);
  assert.equal(rescueAmountUsd(1000, 8, 15), 0);
  // Reserve on Solana: to Phoenix 0, to Hyperliquid 0.46: one rescue costs 0.46 USD, two 0.92 USD.
  near(rescueCostUsd('hyperliquid', 'phoenix', 70, 1, 'reserve', TRANSFERS), 0.46);
  near(rescueCostUsd('hyperliquid', 'phoenix', 70, 2, 'reserve', TRANSFERS), 0.92);
  // A reserve kept on Hyperliquid: to Orderly 1.00 + 0.21 + 0.14 = 1.35 USD, to Hyperliquid itself 0.
  near(rescueCostUsd('hyperliquid', 'orderly', 70, 1, 'hyperliquid', TRANSFERS), 1.35);
});

test('breakeven: each leg pays on its own schedule; the example in costs.ts breaks even at 3.25 h', () => {
  // HL earns 0.10 USD/h paid hourly from 0.25 h; Orderly 0.20 USD/h paid every 8 h from 2 h; cost 2.00 USD.
  // 0.25 h: 0.10, 1.25 h: 0.20, 2 h: +1.60 = 1.80, 2.25 h: 1.90, 3.25 h: 2.00.
  near(breakevenHours(2, [
    { incomePerHourUsd: 0.1, periodHours: 1, firstInHours: 0.25 },
    { incomePerHourUsd: 0.2, periodHours: 8, firstInHours: 2 },
  ]), 3.25);
  // 10 USD at 0.10 USD an hour from 1 h: the 100th payment, at 100 h (floating-point sums do not push it to 101).
  near(breakevenHours(10, [{ incomePerHourUsd: 0.1, periodHours: 1, firstInHours: 1 }]), 100);
  assert.equal(breakevenHours(10, [{ incomePerHourUsd: 0.1, periodHours: 1, firstInHours: 1 }], 50), null);
  // A paying leg slows it down: 0.10 in, 0.04 out per hour = 0.06 net: 0.30 USD after 5 h.
  near(breakevenHours(0.3, [
    { incomePerHourUsd: 0.1, periodHours: 1, firstInHours: 1 },
    { incomePerHourUsd: -0.04, periodHours: 1, firstInHours: 1 },
  ]), 5);
  assert.equal(breakevenHours(0, []), 0);
  assert.equal(breakevenHours(1, []), null);
  assert.equal(breakevenHours(1, [{ incomePerHourUsd: -0.1, periodHours: 1, firstInHours: 1 }]), null);
});

test('hours until the next payment, within (0, period]', () => {
  const now = Date.UTC(2026, 9, 31, 10, 30);
  assert.equal(hoursUntil(Date.UTC(2026, 9, 31, 11), now, 1), 0.5);
  assert.equal(hoursUntil(Date.UTC(2026, 9, 31, 16), now, 8), 5.5);
  assert.equal(hoursUntil(now, now, 8), 8);
  assert.equal(hoursUntil(now - 1000, now, 1), 1);
  assert.equal(hoursUntil(Date.UTC(2026, 9, 31, 22), now, 8), 8);
});
