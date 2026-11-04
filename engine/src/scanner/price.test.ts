// One window priced by hand: every cost term at a 1000 USD leg held 240 h (HOLD below; the default is 7 days), the verdicts,
// and the switch cost. APR is percentage points a year on one leg's notional; a one-off cost of C USD is
// C / 1000 × (8760 / 240) × 100 = C × 3.65.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContractPolicy, VenueId } from '@gimbal/shared';
import { DEFAULT_COSTS, DEFAULT_STRATEGY } from './config.ts';
import { pairLegs } from './pairs.ts';
import type { Pair, ScanLeg } from './pairs.ts';
import type { BookRead, OracleSource, PricedWindow, PricingContext } from './price.ts';
import { ORACLE_MAX_SKEW_MS, deskVerdict, isEnterable, priceWindow, switchCostUsd, usd } from './price.ts';
import { T0, book, leg } from './test-helpers.ts';
import type { Book } from '../venues/venue.ts';

const near = (actual: number | null | undefined, expected: number, eps = 1e-9) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

const POLICY: ContractPolicy = {
  hl_assets: [
    { index: 5, symbol: 'SOL', sz_decimals: 2 }, { index: 77, symbol: 'WIF', sz_decimals: 0 },
    { index: 141, symbol: 'kPEPE', sz_decimals: 0 },
  ],
  phoenix_markets: [
    { symbol: 'SOL', orderbook: 'test-orderbook-sol', base_lot_e8: 1, tick_e8: 1 },
    { symbol: 'WIF', orderbook: 'test-orderbook-wif', base_lot_e8: 1, tick_e8: 1 },
  ],
  orderly_symbols: ['PERP_WIF_USDC', 'PERP_1000PEPE_USDC'],
  max_notional_usd: 5000, price_band_bps: 100, oracle_max_age_s: 60, rescue_cap_usd_per_hour: 500,
  unpriced: [{ symbol: 'WIF', max_sz: '5000' }], unpriced_max_notional_usd: 2000,
  max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 2_000_000,
};

/** Oracle prices the contract stored `ageS` seconds before T0, for every symbol asked about. */
function oracleAged(ageS: number, only?: (venue: VenueId, symbol: string) => boolean): OracleSource {
  return { price: (venue, symbol) => (only === undefined || only(venue, symbol) ? { px: 100, at: T0 - ageS * 1000 } : null) };
}
const FRESH = oracleAged(5);

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

/** The hold these numbers are worked out on: 10 days, so a one-off C USD is C × 3.65 APR points. */
const HOLD = { ...DEFAULT_COSTS, holdHours: 240 };

function ctx(over: Partial<PricingContext> = {}, books: Record<string, BookRead | null> = {}): PricingContext {
  return {
    now: T0,
    strategy: DEFAULT_STRATEGY,
    costs: HOLD,
    policy: null,
    oracle: null,
    book: (l) => (l.venue in books ? books[l.venue]! : BOOKS[l.venue] === undefined ? null : { book: BOOKS[l.venue]!, readAt: T0, stale: false }),
    ...over,
  };
}

function priced(long: ScanLeg, short: ScanLeg, c: PricingContext = ctx()): PricedWindow {
  const r = priceWindow(pairOf(long, short), c);
  assert.ok(r.ok, `not priced: ${JSON.stringify(r)}`);
  return r.priced;
}

const verdictCtx = (over: Partial<PricingContext> = {}) => ({ now: T0, strategy: DEFAULT_STRATEGY, policy: POLICY, oracle: null, ...over });

test('a desk window by hand: gross 39.42 %, costs 20.525 %, net 18.895 %, breakeven 114.5 h', () => {
  const { window: w, breakdown, costsApr, fills } = priced(LONG, SHORT);
  // Gross: 0.000055 − 0.00001 = 0.000045/h × 8760 × 100.
  assert.equal(w.grossAprPct, 39.42);
  // Fees: Phoenix 3.5 bps, Hyperliquid 4.5 + 1 builder = 5.5 bps: 1000 × 2 × 9 / 10⁴ = 1.80 USD.
  near(breakdown.feesUsd, 1.8);
  // Margin 1000 / 3 = 333.33 USD a leg, from the Solana reserve and back. Phoenix is the reserve's own wallet: free.
  // Hyperliquid in: 0.32 + 20 bps (0.6667) = 0.9867; out: 1.00 activation + 0.21 + 0.6667 = 1.8767. 2.8633 USD.
  near(breakdown.transferUsd, 0.32 + 1.0 + 0.21 + 2 * (1000 / 3) * 0.002, 1e-9);
  // feesPct carries both: 4.6633 USD -> 17.021 %.
  assert.equal(w.costs.feesPct, 17.021);
  // Slippage: each buy at 100.01 costs 0.01 × 1000 / 100.01, each sell at 99.99 costs 0.01 × 1000 / 99.99; two of
  // each over the 4 fills = 0.400000004 USD -> 1.46 %.
  near(breakdown.slippageUsd, 2 * (10 / 100.01 + 10 / 99.99));
  assert.equal(w.costs.slippagePct, 1.46);
  // Basis: long 0.01 above the short at mid 100: 0.0001 × 1000 = 0.10 USD -> 0.365 %. Both legs hourly: no timing.
  near(breakdown.basisUsd, 0.1, 1e-9);
  assert.equal(breakdown.timingUsd, 0);
  assert.equal(w.costs.basisPct, 0.365);
  // Rescue: 1000 × (15 − 8) % = 70 USD from the Solana reserve; to Phoenix free, to Hyperliquid 0.32 + 0.14 = 0.46 USD
  // -> 1.679 %.
  near(breakdown.rescueUsd, 0.46);
  assert.equal(w.costs.rescueReservePct, 1.679);
  assert.equal(costsApr, 20.525);
  assert.equal(w.netAprPct, 18.895);
  // 18.895 % a year on 1000 USD = 0.5177 USD a day.
  assert.equal(w.usdPerDayPer1k, 0.5177);
  // Breakeven on the one-off 1.80 + 2.8633 + 0.40 + 0.10 = 5.1633 USD: 0.045 USD each hour from 0.5 h, so the 115th
  // payment (5.175 USD) covers it: 0.5 + 114 = 114.5 h.
  assert.equal(w.breakevenHours, 114.5);
  // Capacity: the smaller open interest, Phoenix 20,000 × 100.005 = 2,000,100 USD.
  assert.equal(w.depthUsd, 2_000_100);
  assert.equal(w.updatedAt, T0);
  assert.equal(w.stale, false);
  // Both legs on desk venues (structural), but no desk exists yet: the contract would answer E_NO_DESK.
  assert.equal(w.tradable, true);
  assert.deepEqual(w.refused, { code: 'E_NO_DESK', reason: 'no desk policy loaded yet' });
  assert.equal(isEnterable(w), false);
  assert.equal(w.grossApr7dPct, null);
  assert.equal(w.held, null);
  assert.equal(w.switchCostUsd, null);
  // Fills: fee + that side's slippage. Long on Phoenix: 0.35 + buy 0.09999 to open, 0.35 + sell 0.10001 to close.
  near(fills!.long.openUsd, 0.35 + 10 / 100.01);
  near(fills!.long.closeUsd, 0.35 + 10 / 99.99);
  near(fills!.short.openUsd, 0.55 + 10 / 99.99);
  near(fills!.short.closeUsd, 0.55 + 10 / 100.01);
  assert.deepEqual(w.checks, [
    { ok: false, text: 'No desk policy loaded yet: nothing can be entered' },
    { ok: true, text: 'Books 0 s old: slippage $0.40 on 4 fills at $1,000 a leg' },
    { ok: true, text: 'Moving $333 of margin a leg onto Phoenix and Hyperliquid and back costs $2.86' },
    { ok: true, text: 'Rescue of $70.00 from the reserve costs up to $0.46 a move' },
    { ok: true, text: 'Capacity $2.0M: the smaller leg\'s open interest' },
  ]);
});

test('margin already on a venue moves nothing: feesPct is the taker fees alone', () => {
  const { window: w, breakdown } = priced(LONG, SHORT, ctx({ marginHeldAt: new Set<VenueId>(['phoenix', 'hyperliquid']) }));
  assert.equal(breakdown.transferUsd, 0);
  // 1.80 USD -> 6.57 %.
  assert.equal(w.costs.feesPct, 6.57);
  assert.ok(w.checks.some((c) => c.ok && c.text === 'Margin already sits on both venues: nothing to move in or out'));
});

test('a policy that lists both markets and a fresh oracle price: every check passes and the window is enterable', () => {
  const { window: w } = priced(LONG, SHORT, ctx({ policy: POLICY, oracle: FRESH }));
  assert.equal(w.refused, undefined);
  assert.ok(w.checks.every((c) => c.ok), JSON.stringify(w.checks));
  assert.equal(isEnterable(w), true);
  assert.deepEqual(w.checks.slice(0, 3), [
    { ok: true, text: 'The oracle price for SOL on Phoenix is 5 s old, within the 60 s limit' },
    { ok: true, text: 'The oracle price for SOL on Hyperliquid is 5 s old, within the 60 s limit' },
    { ok: true, text: 'A $1,000 leg (up to $1,010 at the edge of the price band) fits the $5,000 cap' },
  ]);
  // A NEAR AI veto makes it not enterable, with nothing else changed.
  assert.equal(isEnterable({ ...w, veto: { verdict: 'veto', reasons: ['test'], model: 'test', at: T0 } }), false);
  assert.equal(isEnterable({ ...w, veto: { verdict: 'pass', reasons: [], model: 'test', at: T0 } }), true);
});

test('a priced leg passes only on a fresh oracle price: no source, or one too old, is E_ORACLE_STALE', () => {
  // No source at all (today: no contract client yet): every priced desk leg is refused, and no check says the
  // order would sit inside a price band.
  const none = priced(LONG, SHORT, ctx({ policy: POLICY })).window;
  assert.deepEqual(none.refused, { code: 'E_ORACLE_STALE', reason: 'no oracle price for SOL on phoenix' });
  assert.equal(none.tradable, true);
  assert.ok(none.checks.some((c) => !c.ok && c.text === 'No oracle price for SOL on Hyperliquid: the contract refuses its orders'));
  assert.ok(!none.checks.some((c) => c.ok && /oracle/.test(c.text)), JSON.stringify(none.checks));
  // A price 61 s old against a 60 s limit.
  const old = priced(LONG, SHORT, ctx({ policy: POLICY, oracle: oracleAged(61) })).window;
  assert.deepEqual(old.refused, { code: 'E_ORACLE_STALE', reason: 'oracle price for SOL on phoenix 61 s old' });
  assert.ok(old.checks.some((c) => !c.ok && c.text === 'The oracle price for SOL on Phoenix is 61 s old, over the 60 s limit: the contract refuses its orders'));
  // One leg fresh, the other without a price: still refused, for that leg.
  const half = priced(LONG, SHORT, ctx({ policy: POLICY, oracle: oracleAged(5, (v) => v === 'phoenix') })).window;
  assert.deepEqual(half.refused, { code: 'E_ORACLE_STALE', reason: 'no oracle price for SOL on hyperliquid' });
  // Exactly at the limit passes; a bad price does not count as one.
  assert.equal(priced(LONG, SHORT, ctx({ policy: POLICY, oracle: oracleAged(60) })).window.refused, undefined);
  const bad: OracleSource = { price: () => ({ px: Number.NaN, at: T0 }) };
  assert.equal(priced(LONG, SHORT, ctx({ policy: POLICY, oracle: bad })).window.refused?.code, 'E_ORACLE_STALE');
});

test('an oracle price dated in the future is stale past a 5 s skew: it would otherwise read as 0 s old', () => {
  // From the review: `at` an hour ahead passed as fresh. Up to the skew it is clock jitter and counts as 0 s old.
  assert.equal(ORACLE_MAX_SKEW_MS, 5_000);
  const within = priced(LONG, SHORT, ctx({ policy: POLICY, oracle: oracleAged(-5) })).window;
  assert.equal(within.refused, undefined);
  assert.ok(within.checks.some((c) => c.ok && c.text === 'The oracle price for SOL on Phoenix is 0 s old, within the 60 s limit'));
  const ahead = priced(LONG, SHORT, ctx({ policy: POLICY, oracle: oracleAged(-3600) })).window;
  assert.deepEqual(ahead.refused, { code: 'E_ORACLE_STALE', reason: 'oracle price for SOL on phoenix dated 3600 s ahead' });
  assert.ok(ahead.checks.some((c) => !c.ok && c.text === 'The oracle price for SOL on Hyperliquid is dated 3600 s ahead of the engine\'s clock, past the 5 s skew allowed: counted as stale'));
  assert.equal(isEnterable(ahead), false);
  // Just past the skew.
  assert.equal(priced(LONG, SHORT, ctx({ policy: POLICY, oracle: oracleAged(-5.001) })).window.refused?.code, 'E_ORACLE_STALE');
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
  assert.deepEqual(w1.checks[0], { ok: false, text: 'Phoenix did not answer: numbers from 30 s ago' });
  // A book whose last read failed counts too.
  const oldBook: BookRead = { book: BOOKS.hyperliquid!, readAt: T0 - 45_000, stale: true };
  const w2 = priced(staleLong, SHORT, ctx({}, { hyperliquid: oldBook })).window;
  assert.deepEqual(w2.checks[0], { ok: false, text: 'Phoenix and Hyperliquid did not answer: numbers from 45 s ago' });
  assert.equal(w2.updatedAt, T0 - 45_000);
  // Stale numbers are never enterable, even with every policy check passing.
  assert.equal(isEnterable(priced(staleLong, SHORT, ctx({ policy: POLICY, oracle: FRESH })).window), false);
});

test('a book too thin for the leg prices what it fills, fails a check, and is not enterable', () => {
  // 5 units a side at about 100 USD: about 500 USD of the 1000 USD leg.
  const thin: BookRead = { book: book('hyperliquid', 'SOL', 99.99, 100.01, 5), readAt: T0, stale: false };
  const { window: w, breakdown } = priced(LONG, SHORT, ctx({ policy: POLICY, oracle: FRESH }, { hyperliquid: thin }));
  assert.ok(w.checks.some((c) => !c.ok && c.text === 'The Hyperliquid book fills only $500 of $1,000 within the 1 level read: slippage counts the filled part only'), JSON.stringify(w.checks));
  assert.ok(!w.checks.some((c) => c.text.startsWith('Books ')), 'no "slippage on 4 fills" line for a partial fill');
  // Slippage of the filled part: Phoenix's two full fills, Hyperliquid's 5 units each way at 0.01 off the mid.
  near(breakdown.slippageUsd, 10 / 100.01 + 10 / 99.99 + 0.05 + 0.05);
  assert.equal(w.refused, undefined);
  assert.equal(isEnterable(w), false);
});

test('watch-only pairs: gross and basis priced, fees, slippage and reserve not, and the check says so', () => {
  const pac = leg('pacifica', 'SOL', { ratePerHour: 0.00001, markPx: 100.005, openInterest: 20_000 });
  const { window: w, breakdown, fills } = priced(pac, SHORT);
  assert.equal(w.grossAprPct, 39.42);
  assert.deepEqual(w.costs, { feesPct: 0, slippagePct: 0, basisPct: 0.365, rescueReservePct: 0 });
  assert.equal(breakdown.feesUsd, null);
  assert.equal(breakdown.transferUsd, null);
  assert.equal(breakdown.slippageUsd, null);
  assert.equal(breakdown.rescueUsd, null);
  assert.equal(fills, null);
  assert.equal(w.tradable, false);
  assert.equal(w.refused, undefined);
  assert.equal(isEnterable(w), false);
  assert.deepEqual(w.checks[0], { ok: false, text: 'Watch-only: Pacifica cannot be traded by the desk. Fees, slippage and the rescue reserve are not priced' });
  const okx = leg('okx', 'SOL', { ratePerHour: 0.00001, markPx: null, openInterest: null }, 'cex');
  const w2 = priced(okx, SHORT).window;
  assert.equal(w2.checks[0]!.text, 'Watch-only: OKX is a CEX, reference only. Fees, slippage and the rescue reserve are not priced');
  assert.ok(w2.checks.some((c) => !c.ok && c.text === 'No mark on OKX: basis not priced'));
  assert.equal(w2.depthUsd, 4_999_750);       // the one open interest known, and the check says so
  assert.deepEqual(w2.checks.at(-1), { ok: false, text: 'Capacity $5.0M is one leg\'s only: OKX publishes no open interest' });
});

test('tradable is structural: a desk pair with no oracle price is tradable and refused E_ORACLE_STALE', () => {
  const pair = pairOf(leg('hyperliquid', 'SOL'), leg('phoenix', 'SOL', { ratePerHour: 0.0001 }));
  assert.equal(pair.desk, true);
  const v = deskVerdict(pair, verdictCtx());
  assert.deepEqual(v.refused, { code: 'E_ORACLE_STALE', reason: 'no oracle price for SOL on hyperliquid' });
  assert.equal(priced(pair.long, pair.short, ctx({ policy: POLICY })).window.tradable, true);
});

test('a trading serve: a missing or stale stored price of an oracle-priced pair is a note, enterable as when fresh', () => {
  const NOTE_MISSING = 'stored SOL price missing: refreshed at open';
  // Missing on both legs: one note for the symbol, every check ok, nothing refused.
  const missing = deskVerdict(pairOf(LONG, SHORT), verdictCtx({ oracleRefreshAtOpen: true }));
  assert.equal(missing.refused, undefined);
  assert.equal(missing.note, NOTE_MISSING);
  assert.equal(missing.checks.every((c) => c.ok), true);
  assert.match(missing.checks[0]!.text, /^The stored price for SOL on Phoenix is missing: the open refreshes it first \(refresh_prices\)/);
  // Stale (over oracle_max_age_s 60).
  const stale = deskVerdict(pairOf(LONG, SHORT), verdictCtx({ oracleRefreshAtOpen: true, oracle: oracleAged(3600) }));
  assert.equal(stale.refused, undefined);
  assert.equal(stale.note, 'stored SOL price stale: refreshed at open');
  assert.match(stale.checks[0]!.text, /is 3600 s old, over the 60 s limit: the open refreshes it first/);
  // A fresh price needs no note.
  assert.equal(deskVerdict(pairOf(LONG, SHORT), verdictCtx({ oracleRefreshAtOpen: true, oracle: FRESH })).note, undefined);
  // The window: enterable exactly as it is with a fresh price, the note on it, no refusal.
  const noted = priced(LONG, SHORT, ctx({ policy: POLICY, oracleRefreshAtOpen: true })).window;
  const fresh = priced(LONG, SHORT, ctx({ policy: POLICY, oracle: FRESH })).window;
  assert.equal(noted.refused, undefined);
  assert.equal(noted.note, NOTE_MISSING);
  assert.equal(fresh.note, undefined);
  assert.equal(isEnterable(noted), isEnterable(fresh));
  assert.equal(isEnterable(noted), true);
});

test('not a trading serve: a missing or stale stored price is still E_ORACLE_STALE, with no note', () => {
  for (const over of [{}, { oracleRefreshAtOpen: false }]) {
    const v = deskVerdict(pairOf(LONG, SHORT), verdictCtx(over));
    assert.deepEqual(v.refused, { code: 'E_ORACLE_STALE', reason: 'no oracle price for SOL on phoenix' });
    assert.equal(v.note, undefined);
  }
  const w = priced(LONG, SHORT, ctx({ policy: POLICY, oracle: oracleAged(3600) })).window;
  assert.deepEqual(w.refused, { code: 'E_ORACLE_STALE', reason: 'oracle price for SOL on phoenix 3600 s old' });
  assert.equal(w.note, undefined);
  assert.equal(isEnterable(w), false);
});

test('a trading serve still refuses what a refresh cannot fix: a symbol the contract does not price, an Orderly leg, a wrong clock, the cap', () => {
  // HYPE is in both venue lists and not unpriced, but refresh_prices cannot store a HYPE price.
  const hypePolicy: ContractPolicy = {
    ...POLICY,
    hl_assets: [...POLICY.hl_assets, { index: 159, symbol: 'HYPE', sz_decimals: 2 }],
    phoenix_markets: [...POLICY.phoenix_markets, { symbol: 'HYPE', orderbook: 'test-orderbook-hype', base_lot_e8: 1, tick_e8: 1 }],
  };
  const hype = deskVerdict(pairOf(leg('phoenix', 'HYPE'), leg('hyperliquid', 'HYPE', { ratePerHour: 0.0001 })), verdictCtx({ policy: hypePolicy, oracleRefreshAtOpen: true }));
  assert.deepEqual(hype.refused, { code: 'E_ORACLE_STALE', reason: 'no oracle price for HYPE on phoenix' });
  assert.equal(hype.note, undefined);
  // serve's open is Hyperliquid and Phoenix only: an Orderly leg's price is not refreshed by it.
  const orderlyPolicy: ContractPolicy = { ...POLICY, orderly_symbols: [...POLICY.orderly_symbols, 'PERP_SOL_USDC'] };
  const orderly = deskVerdict(pairOf(leg('orderly', 'PERP_SOL_USDC', { base: 'SOL' }), SHORT), verdictCtx({ policy: orderlyPolicy, oracleRefreshAtOpen: true }));
  assert.deepEqual(orderly.refused, { code: 'E_ORACLE_STALE', reason: 'no oracle price for PERP_SOL_USDC on orderly' });
  // A price dated ahead of the clock is a clock problem, not a stale price.
  const ahead = deskVerdict(pairOf(LONG, SHORT), verdictCtx({ oracleRefreshAtOpen: true, oracle: oracleAged(-(ORACLE_MAX_SKEW_MS / 1000 + 60)) }));
  assert.equal(ahead.refused?.code, 'E_ORACLE_STALE');
  assert.equal(ahead.note, undefined);
  // Any other refusal stays, and drops the note.
  const big = deskVerdict(pairOf(LONG, SHORT), verdictCtx({ oracleRefreshAtOpen: true, strategy: { ...DEFAULT_STRATEGY, legUsd: 4990 } }));
  assert.deepEqual(big.refused, { code: 'E_SIZE', reason: 'leg over the $5,000 cap' });
  assert.equal(big.note, undefined);
});

test('unpriced is per leg: WIF on Hyperliquid is unpriced, PERP_WIF_USDC on Orderly is not', () => {
  const wifHl = leg('hyperliquid', 'WIF', { markPx: 0.5, openInterest: 9e6 });
  const wifOrderly = leg('orderly', 'PERP_WIF_USDC', { base: 'WIF', markPx: 0.5, openInterest: 9e6 });
  const pair = pairOf(wifHl, wifOrderly);
  // Only the Hyperliquid symbol is in policy.unpriced: the Orderly leg still needs an oracle price, and has none.
  const half = deskVerdict(pair, verdictCtx());
  assert.deepEqual(half.refused, { code: 'E_ORACLE_STALE', reason: 'no oracle price for PERP_WIF_USDC on orderly' });
  assert.deepEqual(half.checks.slice(0, 2), [
    { ok: true, text: 'WIF on Hyperliquid is unpriced, no price protection: a $1,000 leg is 2000 WIF, within its max_sz 5000' },
    { ok: false, text: 'No oracle price for PERP_WIF_USDC on Orderly: the contract refuses its orders' },
  ]);
  // A fresh oracle price for the Orderly leg covers it: one leg unpriced, one priced, both covered.
  const mixed = deskVerdict(pair, verdictCtx({ oracle: oracleAged(5, (v) => v === 'orderly') }));
  assert.equal(mixed.refused, undefined);
  // The unpriced cap (2000 USD) applies to the window, since one of its legs is unpriced.
  assert.equal(mixed.checks.at(-1)!.text, 'A $1,000 leg (up to $1,010 at the edge of the price band) fits the $2,000 cap');
  // Both symbols listed as unpriced: no oracle needed at all.
  const both = deskVerdict(pair, verdictCtx({ policy: { ...POLICY, unpriced: [{ symbol: 'WIF', max_sz: '5000' }, { symbol: 'PERP_WIF_USDC', max_sz: '5000' }] } }));
  assert.equal(both.refused, undefined);
  // The unpriced notional cap: 500 USD.
  const capped = deskVerdict(pair, verdictCtx({ oracle: FRESH, policy: { ...POLICY, unpriced_max_notional_usd: 500 } }));
  assert.deepEqual(capped.refused, { code: 'E_SIZE', reason: 'leg over the $500 cap' });
});

test('max_sz is per leg, in each venue\'s own units: kPEPE on Hyperliquid against PERP_1000PEPE_USDC on Orderly', () => {
  // Both count 1000 PEPE a unit at 0.01 USD: a 1000 USD leg is 100,000 units on each venue.
  const kpepe = leg('hyperliquid', 'kPEPE', { base: 'PEPE', multiplier: 1000, markPx: 0.01, openInterest: 1e9 });
  const pepe1000 = leg('orderly', 'PERP_1000PEPE_USDC', { base: 'PEPE', multiplier: 1000, markPx: 0.01, openInterest: 1e9 });
  const pair = pairOf(kpepe, pepe1000);
  const policy = (hl: string, orderly: string): ContractPolicy => ({
    ...POLICY, unpriced: [{ symbol: 'kPEPE', max_sz: hl }, { symbol: 'PERP_1000PEPE_USDC', max_sz: orderly }],
  });
  assert.equal(deskVerdict(pair, verdictCtx({ policy: policy('200000', '200000') })).refused, undefined);
  // Orderly's own max_sz is the tighter one: that leg is refused, the Hyperliquid leg passes.
  const orderlyOver = deskVerdict(pair, verdictCtx({ policy: policy('200000', '50000') }));
  assert.deepEqual(orderlyOver.refused, { code: 'E_SIZE', reason: 'PERP_1000PEPE_USDC on orderly over max_sz 50000' });
  assert.deepEqual(orderlyOver.checks.slice(0, 2), [
    { ok: true, text: 'kPEPE on Hyperliquid is unpriced, no price protection: a $1,000 leg is 100000 kPEPE, within its max_sz 200000' },
    { ok: false, text: 'PERP_1000PEPE_USDC on Orderly is unpriced: a $1,000 leg is 100000 PERP_1000PEPE_USDC, over its max_sz 50000' },
  ]);
  // And the other way round.
  assert.deepEqual(deskVerdict(pair, verdictCtx({ policy: policy('50000', '200000') })).refused, { code: 'E_SIZE', reason: 'kPEPE on hyperliquid over max_sz 50000' });
});

test('E_SIZE counts the price band: a 4990 USD leg is up to 5039.90 USD inside a 100 bps band, over a 5000 USD cap', () => {
  const at = (legUsd: number) => deskVerdict(pairOf(LONG, SHORT), verdictCtx({ oracle: FRESH, strategy: { ...DEFAULT_STRATEGY, legUsd } }));
  const over = at(4990);
  assert.deepEqual(over.refused, { code: 'E_SIZE', reason: 'leg over the $5,000 cap' });
  assert.equal(over.checks.at(-1)!.text, 'A $4,990 leg is up to $5,040 at the edge of the price band, over the $5,000 cap');
  // 4950 × 1.01 = 4999.50: fits.
  assert.equal(at(4950).refused, undefined);
});

test('verdicts with a policy: a market outside it is E_ASSET, before any oracle or size check', () => {
  const orderly = leg('orderly', 'PERP_SOL_USDC', { base: 'SOL' });
  const asset = deskVerdict(pairOf(LONG, orderly), verdictCtx());
  assert.deepEqual(asset.refused, { code: 'E_ASSET', reason: 'PERP_SOL_USDC not in policy on orderly' });
  assert.deepEqual(asset.checks, [{ ok: false, text: 'PERP_SOL_USDC is not in the desk policy on Orderly' }]);
  // No policy at all: E_NO_DESK.
  assert.deepEqual(deskVerdict(pairOf(LONG, SHORT), verdictCtx({ policy: null })).refused, { code: 'E_NO_DESK', reason: 'no desk policy loaded yet' });
});

test('switch cost: close the legs that change and open the new ones, and move margin onto the new venues', () => {
  // The desk holds long Phoenix / short Hyperliquid, so its margin sits on those two venues.
  const heldAt = ctx({ marginHeldAt: new Set<VenueId>(['phoenix', 'hyperliquid']) });
  const held = priced(LONG, SHORT, heldAt);
  // Short moves Hyperliquid -> Orderly (4 bps under gimbal_dex). Fills: close the HL short 0.55 + 0.09999, open the
  // Orderly short 0.40 + 0.10001 = 1.150000002 USD.
  const toOrderly = priced(LONG, leg('orderly', 'PERP_SOL_USDC', { base: 'SOL', ratePerHour: 0.00006 }), heldAt);
  // Plus moving the 333.33 USD of margin onto Orderly and back, 0.32 + 0.6667 in and 1.00 + 0.32 + 0.6667 out =
  // 2.9733 USD: a desk window's net APR leaves its margin moves out, so the rotation pays for them here.
  near(toOrderly.breakdown.transferUsd, 0.32 + 1.0 + 0.32 + 2 * (1000 / 3) * 0.002, 1e-9);
  assert.equal(switchCostUsd(held, toOrderly), Math.round((1.150000002 + toOrderly.breakdown.transferUsd!) * 1e4) / 1e4);
  assert.equal(switchCostUsd(held, toOrderly), 4.1233);
  assert.ok(toOrderly.window.checks.some((c) => c.text === 'Moving $333 of margin a leg onto Orderly and back costs $2.97'), JSON.stringify(toOrderly.window.checks));
  // Long moves Phoenix -> Orderly: close 0.35 + 0.10001, open 0.40 + 0.09999 = 0.950000002 USD, and the same move.
  const longOrderly = priced(leg('orderly', 'PERP_SOL_USDC', { base: 'SOL', ratePerHour: 0 }), SHORT, heldAt);
  assert.equal(switchCostUsd(held, longOrderly), Math.round((0.950000002 + longOrderly.breakdown.transferUsd!) * 1e4) / 1e4);
  // The same two venues the other way round: all four fills, and no margin moves in either window:
  // 0.4500 + 0.6500 + 0.6500 + 0.4500 = 2.2.
  const swapped = priced(leg('hyperliquid', 'SOL'), leg('phoenix', 'SOL', { ratePerHour: 0.0001 }), heldAt);
  assert.equal(switchCostUsd(held, swapped), 2.2);
  assert.equal(swapped.breakdown.transferUsd, 0);
  assert.equal(switchCostUsd(held, held), 0);
  // A watch-only window has no fills: no switch cost.
  assert.equal(switchCostUsd(held, priced(leg('pacifica', 'SOL'), SHORT)), null);
});

test('a leg kept only for the held window fails a check that says why', () => {
  const kept: ScanLeg = { ...LONG, heldOnly: 'has $40,000 of open interest, under the $500,000 floor' };
  const r = priceWindow({ ...pairOf(LONG, SHORT), long: kept }, ctx({ policy: POLICY, oracle: FRESH }));
  assert.ok(r.ok);
  const w = r.priced.window;
  assert.ok(w.checks.some((c) => !c.ok && c.text === 'Kept only because the desk holds it: Phoenix SOL has $40,000 of open interest, under the $500,000 floor'));
  assert.equal(isEnterable(w), false);
});

test('money in check lines: cents under $100, whole dollars to $10k, then k and M', () => {
  assert.equal(usd(0.456), '$0.46');
  assert.equal(usd(70), '$70.00');
  assert.equal(usd(1000), '$1,000');
  assert.equal(usd(9_999.4), '$9,999');
  assert.equal(usd(12_345), '$12k');
  assert.equal(usd(2_000_100), '$2.0M');
});
