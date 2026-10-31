// One window priced by hand: every cost term at a 1000 USD leg held 168 h, the verdicts, and the switch cost.
// APR is percentage points a year on one leg's notional; a one-off cost of C USD is C / 1000 × (8760 / 168) × 100.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContractPolicy } from '@gimbal/shared';
import { DEFAULT_COSTS, DEFAULT_STRATEGY } from './config.ts';
import { pairLegs } from './pairs.ts';
import type { Pair, ScanLeg } from './pairs.ts';
import type { BookRead, PricedWindow, PricingContext } from './price.ts';
import { deskVerdict, priceWindow, switchCostUsd, usd } from './price.ts';
import { T0, book, leg } from './test-helpers.ts';
import type { Book } from '../venues/venue.ts';

const near = (actual: number | null | undefined, expected: number, eps = 1e-9) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

const POLICY: ContractPolicy = {
  hl_assets: [{ index: 5, symbol: 'SOL', sz_decimals: 2 }, { index: 77, symbol: 'WIF', sz_decimals: 0 }],
  phoenix_markets: [
    { symbol: 'SOL', orderbook: 'test-orderbook-sol', base_lot_e8: 1, tick_e8: 1 },
    { symbol: 'WIF', orderbook: 'test-orderbook-wif', base_lot_e8: 1, tick_e8: 1 },
  ],
  orderly_symbols: [],
  max_notional_usd: 5000, price_band_bps: 100, oracle_max_age_s: 60, rescue_cap_usd_per_hour: 500,
  unpriced: [{ symbol: 'WIF', max_sz: '5000' }], unpriced_max_notional_usd: 2000,
  max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 2_000_000,
};

// Long Phoenix SOL paying 0.00001/h at mark 100.005; short Hyperliquid SOL receiving 0.000055/h at mark 99.995.
const LONG = leg('phoenix', 'SOL', { ratePerHour: 0.00001, markPx: 100.005, openInterest: 20_000 });
const SHORT = leg('hyperliquid', 'SOL', { ratePerHour: 0.000055, markPx: 99.995, openInterest: 50_000 });
// Every desk book: 99.99 / 100.01, 1000 units a side (about 100k USD), mid 100.
const BOOKS: Record<string, Book> = {
  phoenix: book('phoenix', 'SOL', 99.99, 100.01),
  hyperliquid: book('hyperliquid', 'SOL', 99.99, 100.01),
  orderly: book('orderly', 'PERP_SOL_USDC', 99.99, 100.01),
};

function pairOf(long: ScanLeg, short: ScanLeg): Pair {
  return pairLegs([long, short]).find((p) => p.long === long)!;
}

function ctx(over: Partial<PricingContext> = {}, books: Record<string, BookRead | null> = {}): PricingContext {
  return {
    now: T0,
    strategy: DEFAULT_STRATEGY,
    costs: DEFAULT_COSTS,
    policy: null,
    oracleSymbols: new Set(['SOL', 'BTC']),
    book: (l) => (l.venue in books ? books[l.venue]! : BOOKS[l.venue] === undefined ? null : { book: BOOKS[l.venue]!, readAt: T0, stale: false }),
    ...over,
  };
}

function priced(long: ScanLeg, short: ScanLeg, c: PricingContext = ctx()): PricedWindow {
  const r = priceWindow(pairOf(long, short), c);
  assert.ok(r.ok, `not priced: ${JSON.stringify(r)}`);
  return r.priced;
}

test('a desk window by hand: gross 39.42 %, costs 14.392 %, net 25.028 %, breakeven 51.5 h', () => {
  const { window: w, breakdown, costsApr, fills } = priced(LONG, SHORT);
  // Gross: 0.000055 − 0.00001 = 0.000045/h × 8760 × 100.
  assert.equal(w.grossAprPct, 39.42);
  // Fees: Phoenix 3.5 bps, Hyperliquid 4.5 + 1 builder = 5.5 bps: 1000 × 2 × 9 / 10⁴ = 1.80 USD -> 9.386 %.
  near(breakdown.feesUsd, 1.8);
  assert.equal(w.costs.feesPct, 9.386);
  // Slippage: each buy at 100.01 costs 0.01 × 1000 / 100.01, each sell at 99.99 costs 0.01 × 1000 / 99.99; two of
  // each over the 4 fills = 0.400000004 USD -> 2.086 %.
  near(breakdown.slippageUsd, 2 * (10 / 100.01 + 10 / 99.99));
  assert.equal(w.costs.slippagePct, 2.086);
  // Basis: long 0.01 above the short at mid 100: 0.0001 × 1000 = 0.10 USD -> 0.521 %. Both legs hourly: no timing.
  near(breakdown.basisUsd, 0.1, 1e-9);
  assert.equal(breakdown.timingUsd, 0);
  assert.equal(w.costs.basisPct, 0.521);
  // Rescue: 1000 × (15 − 8) % = 70 USD from the Solana reserve; to Phoenix free, to Hyperliquid 0.32 + 0.14 = 0.46 USD
  // -> 2.399 %.
  near(breakdown.rescueUsd, 0.46);
  assert.equal(w.costs.rescueReservePct, 2.399);
  assert.equal(costsApr, 14.392);
  assert.equal(w.netAprPct, 25.028);
  // 25.028 % a year on 1000 USD = 0.6857 USD a day.
  assert.equal(w.usdPerDayPer1k, 0.6857);
  // Breakeven on the one-off 2.300000004 USD: 0.055 − 0.01 = 0.045 USD each hour from 0.5 h: the 52nd payment,
  // 0.5 + 51 = 51.5 h.
  assert.equal(w.breakevenHours, 51.5);
  // Capacity: the smaller open interest, Phoenix 20,000 × 100.005 = 2,000,100 USD.
  assert.equal(w.depthUsd, 2_000_100);
  assert.equal(w.updatedAt, T0);
  assert.equal(w.stale, false);
  // Tradable (SOL has an oracle price), but no desk exists yet: the contract would answer E_NO_DESK.
  assert.equal(w.tradable, true);
  assert.deepEqual(w.refused, { code: 'E_NO_DESK', reason: 'no desk policy loaded yet' });
  assert.equal(w.grossApr7dPct, null);
  assert.equal(w.held, null);
  assert.equal(w.switchCostUsd, null);
  // Fills: fee + that side's slippage. Long on Phoenix: 0.35 + buy 0.09999 to open, 0.35 + sell 0.10001 to close.
  near(fills!.long.openUsd, 0.35 + 10 / 100.01);
  near(fills!.long.closeUsd, 0.35 + 10 / 99.99);
  near(fills!.short.openUsd, 0.55 + 10 / 99.99);
  near(fills!.short.closeUsd, 0.55 + 10 / 100.01);
  assert.deepEqual(w.checks, [
    { ok: true, text: 'SOL has an oracle price: orders stay inside the price band' },
    { ok: false, text: 'No desk policy loaded yet: nothing can be entered' },
    { ok: true, text: 'Books 0 s old: slippage $0.40 on 4 fills at $1,000 a leg' },
    { ok: true, text: 'Rescue of $70.00 from the reserve costs up to $0.46 a move' },
    { ok: true, text: 'Capacity $2.0M: the smaller leg\'s open interest' },
  ]);
});

test('with a policy that lists both markets, every check passes', () => {
  const { window: w } = priced(LONG, SHORT, ctx({ policy: POLICY }));
  assert.equal(w.refused, undefined);
  assert.ok(w.checks.every((c) => c.ok), JSON.stringify(w.checks));
  assert.ok(w.checks.some((c) => c.text === 'Passes the desk policy: both markets listed, a $1,000 leg under the $5,000 cap'));
});

test('funding timing on an 8 h leg is part of basisPct: 0.48 USD over a 100 h hold is 4.205 %', () => {
  // Short Orderly receives 0.00012/h on 1000 USD = 0.12 USD/h, paid every 8 h: over 100 h the last 4 h (0.48 USD)
  // can go unpaid. Same marks, so no basis: 0.48 / 1000 × (8760 / 100) × 100 = 4.2048 %.
  const long = leg('hyperliquid', 'SOL', { ratePerHour: 0.00001 });
  const short = leg('orderly', 'PERP_SOL_USDC', { base: 'SOL', ratePerHour: 0.00012, settlement: '8h', nextAt: Date.UTC(2026, 9, 31, 16) });
  const { window: w, breakdown } = priced(long, short, ctx({ costs: { ...DEFAULT_COSTS, holdHours: 100 } }));
  assert.equal(breakdown.basisUsd, 0);
  near(breakdown.timingUsd, 0.48);
  assert.equal(w.costs.basisPct, 4.205);
});

test('a desk pair without a book is not priced (never a zero slippage); an empty book neither', () => {
  assert.deepEqual(priceWindow(pairOf(LONG, SHORT), ctx({}, { phoenix: null })), { ok: false, reason: 'no-book', venue: 'phoenix' });
  const empty: BookRead = { book: { ...BOOKS.hyperliquid!, bids: [] }, readAt: T0, stale: false };
  assert.deepEqual(priceWindow(pairOf(LONG, SHORT), ctx({}, { hyperliquid: empty })), { ok: false, reason: 'empty-book', venue: 'hyperliquid' });
});

test('stale numbers say so first: the venue, and how old the oldest number is', () => {
  const staleLong = leg('phoenix', 'SOL', { ratePerHour: 0.00001, markPx: 100.005, openInterest: 20_000 }, 'desk', T0 - 30_000, true);
  const w1 = priced(staleLong, SHORT).window;
  assert.equal(w1.stale, true);
  assert.equal(w1.updatedAt, T0 - 30_000);
  assert.deepEqual(w1.checks[0], { ok: false, text: 'phoenix did not answer: numbers from 30 s ago' });
  // A book whose last read failed counts too.
  const oldBook: BookRead = { book: BOOKS.hyperliquid!, readAt: T0 - 45_000, stale: true };
  const w2 = priced(staleLong, SHORT, ctx({}, { hyperliquid: oldBook })).window;
  assert.deepEqual(w2.checks[0], { ok: false, text: 'phoenix and hyperliquid did not answer: numbers from 45 s ago' });
  assert.equal(w2.updatedAt, T0 - 45_000);
});

test('a book too thin for the leg fails a check', () => {
  // 5 units a side at about 100 USD: about 500 USD of the 1000 USD leg.
  const thin: BookRead = { book: book('hyperliquid', 'SOL', 99.99, 100.01, 5), readAt: T0, stale: false };
  const w = priced(LONG, SHORT, ctx({}, { hyperliquid: thin })).window;
  assert.ok(w.checks.some((c) => !c.ok && c.text === 'Book too thin: hyperliquid fills $500 of $1,000 within the levels read'), JSON.stringify(w.checks));
});

test('watch-only pairs: gross and basis priced, fees, slippage and reserve not, and the check says so', () => {
  const pac = leg('pacifica', 'SOL', { ratePerHour: 0.00001, markPx: 100.005, openInterest: 20_000 });
  const { window: w, breakdown, fills } = priced(pac, SHORT);
  assert.equal(w.grossAprPct, 39.42);
  assert.deepEqual(w.costs, { feesPct: 0, slippagePct: 0, basisPct: 0.521, rescueReservePct: 0 });
  assert.equal(breakdown.feesUsd, null);
  assert.equal(breakdown.slippageUsd, null);
  assert.equal(breakdown.rescueUsd, null);
  assert.equal(fills, null);
  assert.equal(w.tradable, false);
  assert.equal(w.refused, undefined);
  assert.deepEqual(w.checks[0], { ok: false, text: 'Watch-only: pacifica cannot be traded by the desk. Fees, slippage and the rescue reserve are not priced' });
  const okx = leg('okx', 'SOL', { ratePerHour: 0.00001, markPx: null, openInterest: null }, 'cex');
  const w2 = priced(okx, SHORT).window;
  assert.equal(w2.checks[0]!.text, 'Watch-only: okx is a CEX, reference only. Fees, slippage and the rescue reserve are not priced');
  assert.ok(w2.checks.some((c) => !c.ok && c.text === 'No mark on okx: basis not priced'));
  assert.equal(w2.depthUsd, 4_999_750);       // the one open interest known, and the check says so
  assert.deepEqual(w2.checks.at(-1), { ok: false, text: 'Capacity $5.0M is one leg\'s only: okx publishes no open interest' });
});

test('verdicts: no oracle price and not unpriced is not tradable (E_ORACLE_STALE); unpriced has its own caps', () => {
  const wifHl = leg('hyperliquid', 'WIF', { markPx: 0.5, openInterest: 9e6 });
  const wifPh = leg('phoenix', 'WIF', { markPx: 0.5, openInterest: 9e6 });
  const pair = pairOf(wifHl, wifPh);
  const base = { strategy: DEFAULT_STRATEGY, oracleSymbols: new Set(['SOL']) };

  const none = deskVerdict(pair, { ...base, policy: null });
  assert.equal(none.tradable, false);
  assert.deepEqual(none.refused, { code: 'E_ORACLE_STALE', reason: 'no trusted price' });

  // In policy.unpriced with max_sz 5000: a 1000 USD leg at 0.5 is 2000 WIF; the unpriced cap is 2000 USD.
  const ok = deskVerdict(pair, { ...base, policy: POLICY });
  assert.equal(ok.tradable, true);
  assert.equal(ok.refused, undefined);
  assert.equal(ok.checks[0]!.text, 'WIF has no oracle price; policy.unpriced allows up to 5000 a leg, with no price protection');
  assert.equal(ok.checks.at(-1)!.text, 'Passes the desk policy: both markets listed, a $1,000 leg under the $2,000 cap');

  // max_sz 1000 WIF: 2000 WIF is over it.
  const tight = deskVerdict(pair, { ...base, policy: { ...POLICY, unpriced: [{ symbol: 'WIF', max_sz: '1000' }] } });
  assert.deepEqual(tight.refused, { code: 'E_SIZE', reason: 'over max_sz 1000' });
  assert.equal(tight.checks.at(-1)!.text, 'A $1,000 leg is 2000 WIF on hyperliquid, over max_sz 1000');

  // The unpriced notional cap applies too: 500 USD.
  const capped = deskVerdict(pair, { ...base, policy: { ...POLICY, unpriced_max_notional_usd: 500 } });
  assert.deepEqual(capped.refused, { code: 'E_SIZE', reason: 'leg over the $500 cap' });
});

test('verdicts with a policy: a market outside it is E_ASSET, a leg over max_notional_usd is E_SIZE', () => {
  const orderly = leg('orderly', 'PERP_SOL_USDC', { base: 'SOL' });
  const asset = deskVerdict(pairOf(LONG, orderly), { strategy: DEFAULT_STRATEGY, oracleSymbols: new Set(['SOL']), policy: POLICY });
  assert.equal(asset.tradable, true);
  assert.deepEqual(asset.refused, { code: 'E_ASSET', reason: 'not in policy on orderly' });
  assert.equal(asset.checks.at(-1)!.text, 'PERP_SOL_USDC is not in the desk policy on orderly');

  const big = deskVerdict(pairOf(LONG, SHORT), { strategy: { ...DEFAULT_STRATEGY, legUsd: 6000 }, oracleSymbols: new Set(['SOL']), policy: POLICY });
  assert.deepEqual(big.refused, { code: 'E_SIZE', reason: 'leg over the $5,000 cap' });
});

test('switch cost: close the legs that change, open the new ones, move margin by the cheaper route', () => {
  const held = priced(LONG, SHORT);
  // Short moves Hyperliquid -> Orderly (4.5 bps). Fills: close the HL short 0.55 + 0.09999, open the Orderly short
  // 0.45 + 0.10001 = 1.200000002 USD. Margin 1000 / 3 = 333.33 USD from Hyperliquid to Orderly: 1.00 activation +
  // 0.21 flat + 0.6667 (20 bps) = 1.8767 USD. Total 3.0767 USD.
  const toOrderly = priced(LONG, leg('orderly', 'PERP_SOL_USDC', { base: 'SOL', ratePerHour: 0.00006 }));
  assert.equal(switchCostUsd(held, toOrderly, 1000, 3, DEFAULT_COSTS), 3.0767);
  // Long moves Phoenix -> Orderly: close 0.35 + 0.10001, open 0.45 + 0.09999 = 1.000000002 USD; margin from the
  // Solana wallet: 0.32 + 0.6667 = 0.9867 USD. Total 1.9867 USD.
  const longOrderly = priced(leg('orderly', 'PERP_SOL_USDC', { base: 'SOL', ratePerHour: 0 }), SHORT);
  assert.equal(switchCostUsd(held, longOrderly, 1000, 3, DEFAULT_COSTS), 1.9867);
  // The same two venues the other way round: all four fills, no margin moves: 0.4500 + 0.6500 + 0.6500 + 0.4500 = 2.2.
  const swapped = priced(leg('hyperliquid', 'SOL'), leg('phoenix', 'SOL', { ratePerHour: 0.0001 }));
  assert.equal(switchCostUsd(held, swapped, 1000, 3, DEFAULT_COSTS), 2.2);
  assert.equal(switchCostUsd(held, held, 1000, 3, DEFAULT_COSTS), 0);
  // A watch-only window has no fills: no switch cost.
  assert.equal(switchCostUsd(held, priced(leg('pacifica', 'SOL'), SHORT), 1000, 3, DEFAULT_COSTS), null);
});

test('money in check lines: cents under $100, whole dollars to $10k, then k and M', () => {
  assert.equal(usd(0.456), '$0.46');
  assert.equal(usd(70), '$70.00');
  assert.equal(usd(1000), '$1,000');
  assert.equal(usd(9_999.4), '$9,999');
  assert.equal(usd(12_345), '$12k');
  assert.equal(usd(2_000_100), '$2.0M');
});
