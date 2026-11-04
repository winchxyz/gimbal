// The scanner on fake readers: what it ranks, what it leaves out, and how missing data stays visibly missing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContractPolicy, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { scanLine } from '../cli/serve-replay.ts';
import { VirtualClock } from '../venues/replay.ts';
import type { Book, MarketFunding, MarketFundingPoint, VenueReader, WatchReader } from '../venues/venue.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from './config.ts';
import type { ScannerConfig } from './config.ts';
import { HOUR_MS } from './history.ts';
import type { OracleSource } from './price.ts';
import { isEnterable } from './price.ts';
import { Scanner } from './scanner.ts';
import type { HeldWindow, ScannerOptions } from './scanner.ts';
import { T0, row } from './test-helpers.ts';

const CURRENT = Date.UTC(2026, 9, 31, 10);

/** A desk venue that answers from fields the test sets; every call is counted. */
class FakeVenue {
  readonly id: VenueId;
  rows: MarketFunding[] | Error | 'hang';
  readonly books = new Map<string, Book | Error>();
  readonly bookCalls: string[] = [];
  /** Runs inside every book read, before it answers (a test moves the clock there). */
  onBook: (symbol: string) => void = () => {};

  constructor(id: VenueId, rows: MarketFunding[]) {
    this.id = id;
    this.rows = rows;
  }

  async markets(): Promise<never> { throw new Error('not used by the scanner'); }
  async account(): Promise<never> { throw new Error('not used by the scanner'); }
  async userFunding(): Promise<never> { throw new Error('not used by the scanner'); }

  funding(): Promise<MarketFunding[]> {
    if (this.rows === 'hang') return new Promise(() => {});
    return this.rows instanceof Error ? Promise.reject(this.rows) : Promise.resolve(this.rows);
  }

  async book(symbol: string): Promise<Book> {
    this.bookCalls.push(symbol);
    this.onBook(symbol);
    const set = this.books.get(symbol);
    if (set instanceof Error) throw set;
    if (set !== undefined) return set;
    // A book around the row's mark: ±1 bp, a million USD a side.
    const r = (Array.isArray(this.rows) ? this.rows : []).find((x) => x.symbol === symbol);
    const mark = r?.markPx ?? 100;
    return { venue: this.id, symbol, time: T0, bids: [{ px: mark * 0.9999, sz: 1e6 / mark }], asks: [{ px: mark * 1.0001, sz: 1e6 / mark }] };
  }
}

/** A desk venue with public funding history: `rate(symbol, hour)` for every hour asked (`hour`: its start, ms). */
class HistoryVenue extends FakeVenue {
  readonly historyCalls: [string, number, number][] = [];
  historyError: Error | 'hang' | null = null;
  /** No prints before this hour: a market listed then. */
  listedAt = -Infinity;
  readonly rate: (symbol: string, hour: number) => number;

  constructor(id: VenueId, rows: MarketFunding[], rate: (symbol: string, hour: number) => number) {
    super(id, rows);
    this.rate = rate;
  }

  async marketFundingHistory(symbol: string, start: number, end: number): Promise<MarketFundingPoint[]> {
    this.historyCalls.push([symbol, start, end]);
    if (this.historyError === 'hang') return new Promise(() => {});
    if (this.historyError !== null) throw this.historyError;
    const points: MarketFundingPoint[] = [];
    for (let t = Math.max(Math.ceil(start / HOUR_MS) * HOUR_MS, this.listedAt); t <= end; t += HOUR_MS) points.push({ time: t + 59, symbol, ratePerHour: this.rate(symbol, t), periodHours: 1 });
    return points.filter((p) => p.time <= end);
  }
}

/** The same venue with public history: every hour booked at its row's current rate. */
function withHistory(v: FakeVenue): HistoryVenue {
  const rows = Array.isArray(v.rows) ? v.rows : [];
  return new HistoryVenue(v.id, rows, (symbol) => rows.find((r) => r.symbol === symbol)?.ratePerHour ?? 0);
}

const watch = (id: string, kind: 'dex' | 'cex', rows: MarketFunding[]): WatchReader & { rows: MarketFunding[] } => {
  const w = { id, kind, rows, funding: async () => w.rows };
  return w;
};

function venues() {
  const hl = new FakeVenue('hyperliquid', [
    row('hyperliquid', 'SOL', { ratePerHour: 0.00005 }),
    row('hyperliquid', 'BTC', { ratePerHour: 0.00002, markPx: 70_000, openInterest: 100 }),
    row('hyperliquid', 'WIF', { ratePerHour: 0.0001, markPx: 0.5, openInterest: 9e6 }),
    // A row naming another venue is not that venue's: skipped.
    row('phoenix', 'ETH', { ratePerHour: -0.001, markPx: 3000, openInterest: 1e4 }),
  ]);
  const phoenix = new FakeVenue('phoenix', [
    row('phoenix', 'SOL', { ratePerHour: 0.00001 }),
    row('phoenix', 'BTC', { ratePerHour: 0.00001, markPx: 70_000, openInterest: 100 }),
    row('phoenix', 'WIF', { ratePerHour: 0.00001, markPx: 0.5, openInterest: 9e6 }),
    row('phoenix', 'ETH', { ratePerHour: 0.00001, markPx: 3000, openInterest: 1e4 }),
  ]);
  const orderly = new FakeVenue('orderly', [
    row('orderly', 'PERP_SOL_USDC', { base: 'SOL', ratePerHour: 0.00002, settlement: '8h', nextAt: Date.UTC(2026, 9, 31, 16) }),
  ]);
  const watchers = [
    watch('pacifica', 'dex', [row('pacifica', 'SOL', { ratePerHour: 0.0002 })]),
    watch('okx', 'cex', [row('okx', 'SOL', { ratePerHour: 0.00003, markPx: null, openInterest: null })]),
    watch('binance', 'cex', [row('binance', 'SOL', { ratePerHour: 0.00004, markPx: null, openInterest: null })]),
  ];
  return { hl, phoenix, orderly, watchers };
}

/** SOL on all three desk venues and BTC on two; WIF is not listed. */
const POLICY: ContractPolicy = {
  hl_assets: [{ index: 5, symbol: 'SOL', sz_decimals: 2 }, { index: 0, symbol: 'BTC', sz_decimals: 5 }],
  phoenix_markets: [
    { symbol: 'SOL', orderbook: 'test-orderbook-sol', base_lot_e8: 1, tick_e8: 1 },
    { symbol: 'BTC', orderbook: 'test-orderbook-btc', base_lot_e8: 1, tick_e8: 1 },
  ],
  orderly_symbols: ['PERP_SOL_USDC'],
  max_notional_usd: 5000, price_band_bps: 100, oracle_max_age_s: 60, rescue_cap_usd_per_hour: 500,
  unpriced: [], unpriced_max_notional_usd: 0, max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 2_000_000,
};

/** Fresh oracle prices for SOL on every venue, none for anything else. */
const SOL_ORACLE: OracleSource = { price: (_venue, symbol) => (symbol.includes('SOL') ? { px: 100, at: T0 - 5_000 } : null) };

function scanner(
  readers: { venues: FakeVenue[]; watch?: WatchReader[] }, clock: { now(): number },
  config: Partial<ScannerConfig> = {}, extra: Partial<ScannerOptions> = {},
): { scanner: Scanner; notes: string[] } {
  const notes: string[] = [];
  const s = new Scanner(readers.venues as unknown as VenueReader[], readers.watch ?? [], {
    config: { ...DEFAULT_SCANNER_CONFIG, ...config },
    clock,
    strategy: () => DEFAULT_STRATEGY,
    onNote: (n) => notes.push(n),
    ...extra,
  });
  return { scanner: s, notes };
}

const byId = (ws: FundingWindow[], id: string) => ws.find((w) => w.id === id);
const totalCosts = (w: FundingWindow) => Math.round((w.costs.feesPct + w.costs.slippagePct + w.costs.basisPct + w.costs.rescueReservePct) * 1000) / 1000;

test('one scan without a desk: desk windows by net, then watch-only by gross; CEX only against something else', async () => {
  const { hl, phoenix, orderly, watchers } = venues();
  const { scanner: s } = scanner({ venues: [hl, phoenix, orderly], watch: watchers }, new VirtualClock(T0));
  const r = await s.scan();
  const { windows, scan, notes } = r;
  assert.deepEqual(scan, { venues: 6, failed: [], at: T0 });

  // tradable is structural: every desk pair with gross > 0, oracle price or not.
  const desk = windows.filter((w) => w.tradable);
  assert.deepEqual(desk.map((w) => w.id).sort(), [
    'btc-phoenix-hyperliquid', 'sol-orderly-hyperliquid', 'sol-phoenix-hyperliquid', 'sol-phoenix-orderly', 'wif-phoenix-hyperliquid',
  ]);
  // No policy: nothing is enterable, and every desk window says why.
  assert.equal(windows.filter(isEnterable).length, 0);
  for (const w of desk) assert.deepEqual(w.refused, { code: 'E_NO_DESK', reason: 'no desk policy loaded yet' });
  assert.deepEqual(windows.slice(0, 5), desk, 'desk windows come first');
  for (let i = 1; i < desk.length; i++) assert.ok(desk[i - 1]!.netAprPct >= desk[i]!.netAprPct);

  // Then the 11 watch-only SOL windows by gross.
  const rest = windows.slice(5);
  assert.equal(rest.length, 11);
  assert.ok(rest.every((w) => !w.tradable));
  for (let i = 1; i < rest.length; i++) assert.ok(rest[i - 1]!.grossAprPct >= rest[i]!.grossAprPct);
  assert.ok(byId(windows, 'sol-okx-pacifica') !== undefined);
  assert.equal(byId(windows, 'sol-okx-binance'), undefined, 'never CEX against CEX');
  assert.equal(byId(windows, 'sol-hyperliquid-phoenix'), undefined, 'gross ≤ 0 is not listed');
  assert.equal(windows.filter((w) => w.symbol === 'ETH').length, 0, 'a row naming another venue is skipped');

  assert.equal(new Set(windows.map((w) => w.id)).size, windows.length);
  for (const w of windows) {
    for (const v of [w.grossAprPct, w.netAprPct, w.usdPerDayPer1k, w.breakevenHours, w.depthUsd, ...Object.values(w.costs)]) assert.ok(Number.isFinite(v), `${w.id}: ${v}`);
    assert.equal(w.stale, false);
    assert.equal(w.updatedAt, T0);
  }
  // Books were read for the desk legs only, once each.
  assert.deepEqual(hl.bookCalls.sort(), ['BTC', 'SOL', 'WIF']);
  assert.deepEqual(orderly.bookCalls, ['PERP_SOL_USDC']);
  assert.deepEqual(notes.unpriced, []);
  assert.match(scanLine(1, r), /^scan 1: 16 windows \(5 on desk venues, 0 enterable\), failed \[\], \d+ ms, no enterable window, 0 history reads$/);

  // At most maxWatchWindows watch-only windows are sent; desk windows are never cut.
  const { scanner: few } = scanner({ venues: [hl, phoenix, orderly], watch: watchers }, new VirtualClock(T0), { maxWatchWindows: 3 });
  assert.equal((await few.scan()).windows.length, 5 + 3);
});

test('watch-only windows: one with a quality finding ranks after a clean one that grosses less; the cut is by gross', async () => {
  const hl = new FakeVenue('hyperliquid', [row('hyperliquid', 'SOL', { ratePerHour: 0.00005, volume24hUsd: 5e7 })]);
  const watchers = [
    // Pacifica pays the most, but traded 20k USD in 24 h.
    watch('pacifica', 'dex', [row('pacifica', 'SOL', { ratePerHour: -0.0005, volume24hUsd: 20_000 })]),
    watch('lighter', 'dex', [row('lighter', 'SOL', { ratePerHour: -0.0003, volume24hUsd: 2e6 })]),
  ];
  const { scanner: s } = scanner({ venues: [hl], watch: watchers }, new VirtualClock(T0));
  const { windows } = await s.scan();
  assert.deepEqual(windows.map((w) => [w.id, w.grossAprPct]), [
    ['sol-lighter-hyperliquid', 306.6], ['sol-pacifica-hyperliquid', 481.8], ['sol-pacifica-lighter', 175.2],
  ]);
  assert.deepEqual(byId(windows, 'sol-pacifica-hyperliquid')!.checks.slice(0, 2).map((c) => c.text), [
    'Watch-only: Pacifica cannot be traded by the desk. Fees, slippage and the rescue reserve are not priced',
    'Thin: Pacifica SOL traded $20k in 24 h, under the $100k floor',
  ]);
  assert.ok(!byId(windows, 'sol-lighter-hyperliquid')!.checks.some((c) => c.text.startsWith('Thin:')));
  // The cut takes the best two by gross, so the flagged 481.8 % window is still sent, after the clean one; the
  // 175.2 % window is the one cut. A finding ranks a window, it never keeps it from the reader.
  const { scanner: two } = scanner({ venues: [hl], watch: watchers }, new VirtualClock(T0), { maxWatchWindows: 2 });
  assert.deepEqual((await two.scan()).windows.map((w) => w.id), ['sol-lighter-hyperliquid', 'sol-pacifica-hyperliquid']);
  const { scanner: one } = scanner({ venues: [hl], watch: watchers }, new VirtualClock(T0), { maxWatchWindows: 1 });
  assert.deepEqual((await one.scan()).windows.map((w) => w.id), ['sol-pacifica-hyperliquid']);
});

test('with a policy and fresh oracle prices: enterable windows first by expected carry, ahead of a refused window that nets more', async () => {
  const fake = venues();
  const [hl, phoenix, orderly] = [withHistory(fake.hl), withHistory(fake.phoenix), withHistory(fake.orderly)];
  const clock = new VirtualClock(T0);
  const { scanner: s } = scanner({ venues: [hl, phoenix, orderly], watch: fake.watchers }, clock, { policy: POLICY, historyPerScan: 20 }, { oracle: SOL_ORACLE });
  // Until the legs' history is in, the spread over the hold is not known: nothing is enterable yet.
  const r0 = await s.scan();
  assert.equal(r0.windows.filter(isEnterable).length, 0);
  assert.ok(byId(r0.windows, 'sol-phoenix-hyperliquid')!.checks.some((c) => !c.ok && c.text.startsWith('No 7-day funding history on both legs yet')));
  await s.idle();
  // With the week in, the week before it is read: until it is in, the gate fails as loading.
  clock.set(T0 + 5_000);
  const loading = await s.scan();
  assert.equal(loading.windows.filter(isEnterable).length, 0);
  assert.ok(byId(loading.windows, 'sol-phoenix-hyperliquid')!.checks.some((c) => !c.ok && c.text.startsWith('14-day history loading')));
  await s.idle();
  clock.set(T0 + 10_000);
  const r = await s.scan();
  const enterable = r.windows.filter(isEnterable);
  assert.deepEqual(enterable.map((w) => w.id), ['sol-phoenix-hyperliquid', 'sol-orderly-hyperliquid']);
  assert.deepEqual(r.windows.slice(0, 2), enterable);
  // WIF nets far more (78.84 % gross) but is not in the policy: it ranks after every enterable window.
  const wif = r.windows[2]!;
  assert.equal(wif.id, 'wif-phoenix-hyperliquid');
  assert.ok(wif.netAprPct > enterable[0]!.netAprPct);
  assert.deepEqual(wif.refused, { code: 'E_ASSET', reason: 'WIF not in policy on phoenix' });
  // Long Phoenix, short Orderly passes every contract check, but its 8.76 % over 10 days at 1000 USD is 2.40 USD,
  // exactly its round trip: the gate holds it back. It ranks by that carry (0 USD net), ahead of BTC's (8.76 % too,
  // against Hyperliquid's dearer fills: 2.70 USD).
  const po = r.windows[3]!;
  assert.equal(po.id, 'sol-phoenix-orderly');
  assert.equal(po.refused, undefined);
  assert.deepEqual(po.checks.filter((c) => !c.ok).map((c) => c.text), [
    'Over a 10-day hold (assumed: the engine rules set none), the 7-day spread of 8.76 % APR (the smaller of the 7- and 14-day means) '
    + 'pays $2.40 at $1,000 a leg, no more than the $2.40 round trip (4 fills $1.50, slippage $0.40, basis buffer $0.50; 24.0 bps): '
    + 'it takes 10.0 days to pay it back',
  ]);
  // BTC is listed but has no oracle price.
  assert.deepEqual(r.windows[4]!.refused, { code: 'E_ORACLE_STALE', reason: 'no oracle price for BTC on phoenix' });
  assert.ok(r.windows.slice(5).every((w) => !w.tradable));
  assert.match(scanLine(12, r), /, best sol-phoenix-hyperliquid -?\d+\.\d\d % net, /);
});

test('oracleRefreshAtOpen is read every scan: while serve trades, no stored SOL price is a note; otherwise E_ORACLE_STALE', async () => {
  const fake = venues();
  const clock = new VirtualClock(T0);
  let trading = false;
  const { scanner: s } = scanner({ venues: [fake.hl, fake.phoenix, fake.orderly], watch: fake.watchers }, clock, { policy: POLICY }, { oracleRefreshAtOpen: () => trading });
  const off = byId((await s.scan()).windows, 'sol-phoenix-hyperliquid')!;
  assert.deepEqual(off.refused, { code: 'E_ORACLE_STALE', reason: 'no oracle price for SOL on phoenix' });
  assert.equal(off.note, undefined);
  trading = true;
  clock.set(T0 + 5_000);
  const r = await s.scan();
  const on = byId(r.windows, 'sol-phoenix-hyperliquid')!;
  assert.equal(on.refused, undefined);
  assert.equal(on.note, 'stored SOL price missing: refreshed at open');
  // The Orderly leg is not one serve's open refreshes: still refused.
  assert.equal(byId(r.windows, 'sol-orderly-hyperliquid')!.refused?.code, 'E_ORACLE_STALE');
});

test('a venue that does not answer: listed as failed, its last good numbers marked stale, gone after 10 minutes', async () => {
  const { hl, phoenix, orderly } = venues();
  const clock = new VirtualClock(T0);
  const { scanner: s, notes } = scanner({ venues: [hl, phoenix, orderly] }, clock);
  await s.scan();
  phoenix.rows = new Error('HTTP 502');
  clock.set(T0 + 5_000);
  const r2 = await s.scan();
  assert.deepEqual(r2.scan.failed, ['phoenix']);
  const w = byId(r2.windows, 'sol-phoenix-hyperliquid')!;
  assert.equal(w.stale, true);
  assert.equal(w.updatedAt, T0);
  assert.deepEqual(w.checks[0], { ok: false, text: 'Phoenix did not answer: numbers from 5 s ago' });
  assert.equal(byId(r2.windows, 'sol-orderly-hyperliquid')!.stale, false);
  assert.ok(notes.some((n) => n === 'phoenix funding failed: HTTP 502'));

  // Its books fall due (30 s) while its funding still fails: they are not asked for, the venue is likely down.
  const calls = phoenix.bookCalls.length;
  clock.set(T0 + 40_000);
  await s.scan();
  assert.equal(phoenix.bookCalls.length, calls);
  assert.ok(notes.includes('phoenix books not read: its funding read failed this scan'));
  assert.ok(hl.bookCalls.length > 3, 'the other venues\' books are read again');

  clock.set(T0 + 11 * 60_000);
  const r3 = await s.scan();
  assert.deepEqual(r3.scan.failed, ['phoenix']);
  assert.equal(r3.windows.filter((x) => x.longVenue === 'phoenix' || x.shortVenue === 'phoenix').length, 0);

  // A reader that hangs counts as not answering within readTimeoutMs.
  orderly.rows = 'hang';
  const { scanner: s2 } = scanner({ venues: [hl, orderly] }, new VirtualClock(T0), { readTimeoutMs: 20 });
  const r4 = await s2.scan();
  assert.deepEqual(r4.scan.failed, ['orderly']);
  assert.equal(r4.windows.length, 0);
});

test('a book is dated when it answers, not when the scan started', async () => {
  const { hl, phoenix } = venues();
  const clock = new VirtualClock(T0);
  // Phoenix's SOL book (read first) takes 2 s: every book of that scan answers at T0 + 2 s.
  phoenix.onBook = (symbol) => {
    if (symbol === 'SOL') clock.advance(2_000);
  };
  const { scanner: s } = scanner({ venues: [hl, phoenix] }, clock);
  await s.scan();
  phoenix.onBook = () => {};
  clock.set(T0 + 7_000);
  const w = byId((await s.scan()).windows, 'sol-phoenix-hyperliquid')!;
  // 5 s old at T0 + 7 s, not the 7 s since the scan that read them began.
  assert.ok(w.checks.some((c) => c.text.startsWith('Books 5 s old')), JSON.stringify(w.checks));
});

test('a read that outlives its scan is not asked again: the next scan waits on the same request and uses its answer', async () => {
  const { hl, phoenix } = venues();
  let calls = 0;
  let answer: (rows: MarketFunding[]) => void = () => {};
  const slow = watch('pacifica', 'dex', []);
  slow.funding = () => {
    calls++;
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  const clock = new VirtualClock(T0);
  const { scanner: s } = scanner({ venues: [hl, phoenix], watch: [slow] }, clock, { readTimeoutMs: 40 });
  assert.deepEqual((await s.scan()).scan.failed, ['pacifica']);
  clock.set(T0 + 5_000);
  // The second scan joins the read still out; it answers while that scan waits.
  const second = s.scan();
  answer([row('pacifica', 'SOL', { ratePerHour: 0.0002 })]);
  const r2 = await second;
  assert.equal(calls, 1);
  assert.deepEqual(r2.scan.failed, []);
  assert.ok(byId(r2.windows, 'sol-phoenix-pacifica') !== undefined);
  // A watch-only venue is read every 30 s: its answer stands until then, dated when it came, and is not stale.
  clock.set(T0 + 30_000);
  const r3 = await s.scan();
  assert.equal(calls, 1);
  const w = byId(r3.windows, 'sol-phoenix-pacifica')!;
  assert.equal(w.stale, false);
  assert.equal(w.updatedAt, T0 + 5_000);
  clock.set(T0 + 35_000);
  const third = s.scan();
  answer([row('pacifica', 'SOL', { ratePerHour: 0.0002 })]);
  await third;
  assert.equal(calls, 2);
});

test('a desk pair whose book was never read is left out, not shown with zero slippage; a later failure keeps the old book, stale', async () => {
  const { hl, phoenix, orderly } = venues();
  orderly.books.set('PERP_SOL_USDC', new Error('socket closed'));
  const clock = new VirtualClock(T0);
  const { scanner: s } = scanner({ venues: [hl, phoenix, orderly] }, clock);
  const r1 = await s.scan();
  assert.deepEqual(r1.scan.failed, ['orderly']);
  assert.equal(r1.windows.filter((w) => w.longVenue === 'orderly' || w.shortVenue === 'orderly').length, 0);
  assert.deepEqual(r1.notes.unpriced.map((u) => u.reason), ['no-book on orderly', 'no-book on orderly']);

  // The book answers next time (a missing book is asked for again at once).
  orderly.books.delete('PERP_SOL_USDC');
  clock.set(T0 + 5_000);
  const r2 = await s.scan();
  assert.deepEqual(r2.scan.failed, []);
  assert.equal(byId(r2.windows, 'sol-phoenix-orderly')!.stale, false);

  // Once it is due again (30 s) and fails, the old book is used and the window says it is stale.
  orderly.books.set('PERP_SOL_USDC', new Error('socket closed'));
  clock.set(T0 + 40_000);
  const r3 = await s.scan();
  assert.deepEqual(r3.scan.failed, ['orderly']);
  const w = byId(r3.windows, 'sol-phoenix-orderly')!;
  assert.equal(w.stale, true);
  assert.equal(w.updatedAt, T0 + 5_000);
  assert.deepEqual(w.checks[0], { ok: false, text: 'Orderly did not answer: numbers from 35 s ago' });
});

test('the held window is marked and kept whatever its gross; the others carry the cost of switching to them', async () => {
  const { hl, phoenix, orderly, watchers } = venues();
  let held: HeldWindow | null = { windowId: 'sol-hyperliquid-phoenix', since: T0 - HOUR_MS };
  const { scanner: s } = scanner({ venues: [hl, phoenix, orderly], watch: watchers }, new VirtualClock(T0), {}, { held: () => held });
  const r = await s.scan();
  const h = byId(r.windows, 'sol-hyperliquid-phoenix')!;
  assert.ok(h.grossAprPct < 0);
  assert.deepEqual(h.held, { since: T0 - HOUR_MS });
  assert.equal(h.switchCostUsd, null);
  for (const w of r.windows.filter((x) => x !== h)) {
    assert.equal(w.held, null);
    const desk = ['hyperliquid', 'phoenix', 'orderly'];
    if (desk.includes(w.longVenue) && desk.includes(w.shortVenue)) assert.ok(typeof w.switchCostUsd === 'number' && w.switchCostUsd > 0, w.id);
    else assert.equal(w.switchCostUsd, null, w.id);
  }
  // The exact reverse of the held window closes and opens all four fills (about 2.1 USD); no margin is held anywhere
  // here (no marginHeldAt), so moving it onto both venues and back counts too.
  const rev = byId(r.windows, 'sol-phoenix-hyperliquid')!;
  const moves = s.carry(rev.id)!.breakdown.transferUsd!;
  assert.ok(moves > 0);
  assert.ok(rev.switchCostUsd! - moves > 2 && rev.switchCostUsd! - moves < 3, String(rev.switchCostUsd));

  held = null;
  const r2 = await s.scan();
  assert.ok(r2.windows.every((w) => w.held === null && w.switchCostUsd === null));
  assert.equal(byId(r2.windows, 'sol-hyperliquid-phoenix'), undefined);
});

test('the held window survives the filters: its legs fail a check instead of being dropped, and switch costs stay', async () => {
  const { hl, phoenix, orderly } = venues();
  // Phoenix SOL falls to 400 SOL open (40,000 USD), under the 500k floor.
  phoenix.rows = (phoenix.rows as MarketFunding[]).map((r) => (r.symbol === 'SOL' ? { ...r, openInterest: 400 } : r));
  const clock = new VirtualClock(T0);
  const held: HeldWindow = { windowId: 'sol-phoenix-hyperliquid', since: T0 - HOUR_MS };
  const { scanner: free } = scanner({ venues: [hl, phoenix, orderly] }, clock);
  const r0 = await free.scan();
  // Not held, the leg (2.5 % of its open interest) is kept for desk pairs, but without a multi-day spread (no history
  // here) none is listed.
  assert.equal(byId(r0.windows, 'sol-phoenix-hyperliquid'), undefined, 'not listed when not held');
  assert.equal(r0.notes.dropped['under-oi-floor'], undefined);

  const { scanner: s } = scanner({ venues: [hl, phoenix, orderly] }, clock, {}, { held: () => held });
  const r = await s.scan();
  const h = byId(r.windows, 'sol-phoenix-hyperliquid')!;
  assert.deepEqual(h.held, { since: T0 - HOUR_MS });
  assert.ok(h.checks.some((c) => !c.ok && c.text === 'Kept only because the desk holds it: Phoenix SOL has $40,000 of open interest: a $1,000 leg is 2.5 % of it, over the 2 % limit'), JSON.stringify(h.checks));
  assert.equal(isEnterable(h), false);
  assert.equal(r.notes.dropped['under-oi-floor'], undefined);
  // The low-OI leg makes no other window, and the others still know what leaving the held one costs.
  assert.equal(byId(r.windows, 'sol-phoenix-orderly'), undefined);
  const other = byId(r.windows, 'sol-orderly-hyperliquid')!;
  assert.ok(typeof other.switchCostUsd === 'number' && other.switchCostUsd > 0);
});

test('history: read in the background, then the 7-day gross, intervalsAbove, the window history, and when it is read again', async () => {
  const { orderly } = venues();
  const hl = new HistoryVenue('hyperliquid', [row('hyperliquid', 'SOL', { ratePerHour: 0.00005 })], () => 0.00005);
  const phoenix = new HistoryVenue('phoenix', [row('phoenix', 'SOL', { ratePerHour: 0.00001 })], () => 0.00001);
  const clock = new VirtualClock(T0);
  const { scanner: s, notes } = scanner({ venues: [hl, phoenix, orderly] }, clock, { historyPerScan: 10 });
  const r1 = await s.scan();
  assert.equal(r1.notes.historyReads, 2);
  // From 176 h before this hour (8 h more than the week) to the end of this hour.
  assert.deepEqual(hl.historyCalls, [['SOL', CURRENT - 176 * HOUR_MS, CURRENT + HOUR_MS - 1]]);
  // The scan did not wait for it: no 7-day figure yet.
  assert.equal(byId(r1.windows, 'sol-phoenix-hyperliquid')!.grossApr7dPct, null);
  await s.idle();

  clock.set(T0 + 5_000);
  const r2 = await s.scan();
  // With the week in, the week before it is read once per desk leg, for the 14-day average.
  assert.equal(r2.notes.historyReads, 2);
  assert.deepEqual(hl.historyCalls[1], ['SOL', CURRENT - 344 * HOUR_MS, CURRENT - 168 * HOUR_MS]);
  await s.idle();
  const w = byId(r2.windows, 'sol-phoenix-hyperliquid')!;
  // 0.00005 − 0.00001 = 0.00004/h every hour of the week: 35.04 % APR.
  assert.equal(w.grossApr7dPct, 35.04);
  assert.ok(w.netAprPct >= DEFAULT_STRATEGY.minNetAprPct);
  assert.equal(w.intervalsAbove, 168);
  // Orderly has no history source here: its windows show null, never a 0 that ranks.
  const o = byId(r2.windows, 'sol-orderly-hyperliquid')!;
  assert.equal(o.grossApr7dPct, null);
  assert.ok(o.intervalsAbove <= 1);

  const hist = s.history('sol-phoenix-hyperliquid')!;
  assert.equal(hist.windowId, 'sol-phoenix-hyperliquid');
  assert.equal(hist.points.length, 168);
  assert.equal(hist.points.at(-1)!.t, CURRENT);
  assert.equal(hist.points.at(-1)!.netAprPct, w.netAprPct);
  for (let i = 1; i < hist.points.length; i++) assert.equal(hist.points[i]!.t - hist.points[i - 1]!.t, HOUR_MS);
  assert.equal(s.history('sol-nowhere-hyperliquid'), null);

  // Same hour: not read again. Half a minute into the next hour: still not (the venue may not have booked it).
  clock.set(CURRENT + HOUR_MS + 30_000);
  assert.equal((await s.scan()).notes.historyReads, 0);
  // A minute in: read again, for the new hour.
  clock.set(CURRENT + HOUR_MS + 61_000);
  assert.equal((await s.scan()).notes.historyReads, 2);
  assert.deepEqual(hl.historyCalls.at(-1), ['SOL', CURRENT + HOUR_MS - 176 * HOUR_MS, CURRENT + 2 * HOUR_MS - 1]);
  await s.idle();

  // A failed read is tried again after historyRetryMs (60 s), not every scan.
  hl.historyError = new Error('HTTP 429');
  clock.set(CURRENT + 2 * HOUR_MS + 61_000);
  await s.scan();
  await s.idle();
  const calls = hl.historyCalls.length;
  assert.ok(notes.some((n) => n.startsWith('hyperliquid history SOL failed: HTTP 429')));
  clock.set(CURRENT + 2 * HOUR_MS + 100_000);
  await s.scan();
  await s.idle();
  assert.equal(hl.historyCalls.length, calls);
  hl.historyError = null;
  clock.set(CURRENT + 2 * HOUR_MS + 125_000);
  await s.scan();
  await s.idle();
  assert.equal(hl.historyCalls.length, calls + 1);
});

test('a history read that hangs never holds a scan up, and no second batch starts while it is out', async () => {
  const hl = new HistoryVenue('hyperliquid', [row('hyperliquid', 'SOL', { ratePerHour: 0.00005 })], () => 0.00005);
  const phoenix = new HistoryVenue('phoenix', [row('phoenix', 'SOL', { ratePerHour: 0.00001 })], () => 0.00001);
  hl.historyError = 'hang';
  phoenix.historyError = 'hang';
  const clock = new VirtualClock(T0);
  // History reads time out after 2 × readTimeoutMs = 100 ms.
  const { scanner: s, notes } = scanner({ venues: [hl, phoenix] }, clock, { historyPerScan: 10, readTimeoutMs: 50 });
  const r1 = await s.scan();
  assert.equal(r1.notes.historyReads, 2);
  assert.ok(r1.windows.length > 0);
  clock.set(T0 + 5_000);
  assert.equal((await s.scan()).notes.historyReads, 0, 'the first batch is still out');
  assert.equal(hl.historyCalls.length, 1);
  await s.idle();
  assert.ok(notes.some((n) => n.startsWith('hyperliquid history SOL failed: hyperliquid history SOL: no answer within 100 ms')));
});

test('the short side keeps its own rate history: GMX shorts receive less than longs pay', async () => {
  const { phoenix } = venues();
  const gmx = watch('gmx', 'dex', [row('gmx', 'SOL', { ratePerHour: 0.0002, shortRatePerHour: 0.00005 })]);
  const clock = new VirtualClock(T0);
  const { scanner: s } = scanner({ venues: [phoenix], watch: [gmx] }, clock);
  await s.scan();
  clock.set(T0 + HOUR_MS);
  await s.scan();
  // Long Phoenix pays 0.00001, short GMX receives 0.00005: 0.00004/h = 35.04 % in the hour before, as now.
  // (Its long rate, 0.0002, would make that hour 166.44 %.) Watch-only, same marks, hourly: no costs priced.
  const hist = s.history('sol-phoenix-gmx')!;
  assert.deepEqual(hist.points.slice(-2), [{ t: CURRENT, netAprPct: 35.04 }, { t: CURRENT + HOUR_MS, netAprPct: 35.04 }]);
});

test('two readers for one venue are refused; a clock that steps back is survived, not thrown on', async () => {
  const { hl, phoenix } = venues();
  assert.throws(() => scanner({ venues: [hl, hl] }, new VirtualClock(T0)), /two readers for hyperliquid/);
  let t = T0;
  const pac = watch('pacifica', 'dex', [row('pacifica', 'SOL', { ratePerHour: 0.0002 })]);
  let watchCalls = 0;
  pac.funding = async () => {
    watchCalls++;
    return pac.rows;
  };
  const { scanner: s, notes } = scanner({ venues: [hl, phoenix], watch: [pac] }, { now: () => t });
  await s.scan();
  const books = hl.bookCalls.length;
  t = T0 - 60_000;
  const r = await s.scan();
  assert.ok(notes.some((n) => n.startsWith('the clock went back 60000 ms')));
  // Books and the watch venue were read at "T0", now in the future: read again rather than aged negative.
  assert.ok(hl.bookCalls.length > books);
  assert.equal(watchCalls, 2);
  assert.equal(r.scan.at, T0 - 60_000);
  for (const w of r.windows) {
    assert.equal(w.stale, false);
    assert.equal(w.updatedAt, T0 - 60_000);
  }
  // And the scans after it go on as usual.
  t = T0 - 55_000;
  assert.ok((await s.scan()).windows.length > 0);
});

// Hyperliquid and Phoenix DOGE as both answered on mainnet, 2026-11-03: Phoenix's open interest is 41k USD (under
// the watch floor of 500k), and this hour Phoenix's rate is the higher one, so short Hyperliquid / long Phoenix loses
// now.
const DOGE_HL = row('hyperliquid', 'DOGE', { ratePerHour: 0.0000121183, markPx: 0.074232, oraclePx: 0.074232, openInterest: 1010709058 });
const DOGE_PH = row('phoenix', 'DOGE', { ratePerHour: 0.00001349600518246599, markPx: 0.074257, oraclePx: 0.074257, openInterest: 555491 });
const LEG_20 = { ...DEFAULT_STRATEGY, legUsd: 20 };
/** The same with no minimum: the gate is the round trip alone. */
const LEG_20_ANY = { ...LEG_20, minNetAprPct: 0 };
const DOGE_POLICY: ContractPolicy = {
  ...POLICY,
  hl_assets: [...POLICY.hl_assets, { index: 12, symbol: 'DOGE', sz_decimals: 0 }],
  phoenix_markets: [...POLICY.phoenix_markets, { symbol: 'DOGE', orderbook: 'test-orderbook-doge', base_lot_e8: 1, tick_e8: 1 }],
};
const DOGE_ORACLE: OracleSource = { price: (_venue, symbol) => (symbol === 'DOGE' ? { px: 0.0742, at: T0 - 5_000 } : null) };

/** Fresh DOGE oracle prices whenever asked: 5 s old on `clock`. */
const dogeOracle = (clock: { now(): number }): OracleSource => ({ price: (_venue, symbol) => (symbol === 'DOGE' ? { px: 0.0742, at: clock.now() - 5_000 } : null) });

test('a desk pair whose hour is reversed: listed in the direction the week paid, loading until the week before is in, then entered', async () => {
  // The history: Hyperliquid 0.000026/h, Phoenix 0.0000125/h every hour, so short HL / long PH has paid 11.826 % APR.
  const hl = new HistoryVenue('hyperliquid', [DOGE_HL], () => 0.000026);
  const phoenix = new HistoryVenue('phoenix', [DOGE_PH], () => 0.0000125);
  const clock = new VirtualClock(T0);
  let strategy = LEG_20_ANY;
  const { scanner: s } = scanner({ venues: [hl, phoenix] }, clock, { policy: DOGE_POLICY }, { strategy: () => strategy, oracle: DOGE_ORACLE });
  const r1 = await s.scan();
  // A 20 USD leg is 0.048 % of Phoenix's 41k USD: well inside the 2 % share. Before its history is in, this hour
  // decides the direction, as for any desk pair; the gate is not passed yet.
  assert.deepEqual(r1.windows.map((w) => w.id), ['doge-hyperliquid-phoenix']);
  assert.equal(isEnterable(r1.windows[0]!), false);
  assert.equal(r1.notes.historyReads, 2);
  await s.idle();

  clock.set(T0 + 5_000);
  const r2 = await s.scan();
  // Listed in the direction the week paid, though this hour pays the other way; the reverse is not listed. The week
  // before is read now, and until it is in the gate fails as loading.
  assert.deepEqual(r2.windows.map((w) => w.id), ['doge-phoenix-hyperliquid']);
  const w2 = r2.windows[0]!;
  assert.equal(w2.grossAprPct, -1.207);
  assert.equal(w2.grossApr7dPct, 11.826);
  assert.equal(isEnterable(w2), false);
  assert.equal(s.carry(w2.id)!.estimate.state, 'loading');
  assert.ok(w2.checks.some((c) => !c.ok && c.text.startsWith('14-day history loading: the 7-day spread of 11.83 % APR is in')), JSON.stringify(w2.checks));
  assert.equal(r2.notes.historyReads, 2);
  assert.deepEqual(hl.historyCalls[1], ['DOGE', CURRENT - 344 * HOUR_MS, CURRENT - 168 * HOUR_MS]);
  await s.idle();

  clock.set(T0 + 10_000);
  const r3 = await s.scan();
  assert.deepEqual(r3.windows.map((w) => w.id), ['doge-phoenix-hyperliquid']);
  const w = r3.windows[0]!;
  assert.equal(w.depthUsd, 41249);
  // Every check passes: the break-even is judged on the multi-day spread too, not on this hour's -1.21 %.
  assert.deepEqual(w.checks.filter((c) => !c.ok), []);
  assert.equal(isEnterable(w), true);
  const carry = s.carry(w.id)!;
  assert.equal(carry.estimate.state, 'known');
  assert.equal(carry.estimate.gross.d14AprPct, 11.826);
  assert.equal(carry.estimate.ok, true);
  // The window's net APR is the multi-day spread minus its costs, not this hour's.
  assert.equal(w.netAprPct, Math.round((11.826 - totalCosts(w)) * 1000) / 1000);
  assert.equal(w.breakevenHours, Math.round(carry.estimate.breakevenDays! * 24 * 10) / 10);
  assert.ok(w.breakevenHours < 240, String(w.breakevenHours));
  assert.deepEqual([carry.short.venue, carry.short.d7AprPct, carry.long.venue, carry.long.d7AprPct], ['hyperliquid', 22.776, 'phoenix', 10.95]);
  assert.equal(carry.long.oiUsd, 555491 * 0.074257);
  const lines = w.checks.map((c) => c.text);
  assert.ok(lines.some((t) => t.startsWith('Over a 10-day hold (assumed: the engine rules set none), the 7-day spread of 11.83 % APR '
    + '(the smaller of the 7- and 14-day means) pays $0.06 at $20.00 a leg, more than the $0.06 round trip')), JSON.stringify(lines));
  assert.ok(lines.includes('Listed on the 7-day spread: this hour pays -1.21 % APR in this direction'));
  assert.equal(r3.notes.historyReads, 0);

  // Under the default 5 % minimum it is not entered: a few cents over the round trip are well under 5 % a year.
  strategy = LEG_20;
  clock.set(T0 + 15_000);
  const r4 = await s.scan();
  const w4 = r4.windows[0]!;
  assert.equal(isEnterable(w4), false);
  assert.deepEqual(w4.checks.filter((c) => !c.ok).map((c) => c.text.replace(/^.*, but /, '')), [
    `it nets only ${s.carry(w4.id)!.estimate.netAprPct!.toFixed(2)} % APR over the hold, under your 5 % minimum`,
  ]);
});

/** A venue's HTTP error, as the readers throw them: the status on the error. */
const httpError = (status: number, text: string) => Object.assign(new Error(`HTTP ${status} ${text}`), { status });

test('an older read the venue refuses: loading for an hour, then the 7 days alone, then the 14 days; any other failure waits 24 h', async () => {
  const setup = async () => {
    const hl = new HistoryVenue('hyperliquid', [DOGE_HL], () => 0.000026);
    const phoenix = new HistoryVenue('phoenix', [DOGE_PH], () => 0.0000125);
    const clock = new VirtualClock(T0);
    const { scanner: s, notes } = scanner({ venues: [hl, phoenix] }, clock, { policy: DOGE_POLICY }, { strategy: () => LEG_20_ANY, oracle: dogeOracle(clock) });
    await s.scan();
    await s.idle();
    const at = async (t: number) => {
      clock.set(T0 + t);
      const r = await s.scan();
      await s.idle();
      const w = byId(r.windows, 'doge-phoenix-hyperliquid')!;
      return { w, e: s.carry(w.id)!.estimate };
    };
    return { hl, notes, at };
  };
  const MIN = 60_000;

  // The weeks are in; Hyperliquid refuses every read from now on, the week before included.
  const refused = await setup();
  refused.hl.historyError = httpError(404, 'not found');
  // Tried again after 60 s, then 120, 240 ... up to 15 min: inside the hour from its first refusal, still loading.
  for (const t of [5_000, 70_000, 30 * MIN, 59 * MIN]) {
    const { w, e } = await refused.at(t);
    assert.equal(e.state, 'loading', `${t / MIN} min`);
    assert.equal(isEnterable(w), false);
  }
  // Refused again an hour after the first time: it has failed for good, and the window is judged on its 7 days alone.
  await refused.at(68 * MIN);
  const fallback = await refused.at(69 * MIN);
  assert.equal(fallback.e.state, 'known');
  assert.equal(fallback.e.basis, '7d');
  // (The hour's live rates have joined the 7 days by now, so the mean has moved off 11.83 %.)
  assert.ok(fallback.w.checks.some((c) => c.ok
    && /the 7-day spread of 11\.\d\d % APR \(no 14-day mean: Hyperliquid has refused the week before for an hour\)/.test(c.text)), JSON.stringify(fallback.w.checks));
  assert.equal(isEnterable(fallback.w), true);
  assert.ok(refused.notes.some((n) => n.startsWith('hyperliquid older history DOGE failed: HTTP 404 not found')));
  // Still tried (every 15 min by then): once it answers, the 14 days count.
  refused.hl.historyError = null;
  await refused.at(84 * MIN);   // the new hour's own week read first
  await refused.at(85 * MIN);   // then the week before
  const later = await refused.at(86 * MIN);
  assert.equal(later.e.state, 'known');
  assert.ok(later.e.gross.d14AprPct !== null);
  assert.ok(later.w.checks.some((c) => c.ok && c.text.includes('(the smaller of the 7- and 14-day means)')));

  // A rate limit is not the venue saying no: through hours of 429s the window waits for its 14 days, until they have
  // gone on for 24 h; then it is judged on its 7 days, and says why.
  const limited = await setup();
  limited.hl.historyError = httpError(429, 'Too Many Requests');
  let gaveUpAt: number | null = null;
  for (let t = 5_000; t <= 26 * 60 * MIN && gaveUpAt === null; t += 50 * MIN) {
    const { w, e } = await limited.at(t);
    if (e.state === 'loading') {
      assert.equal(isEnterable(w), false);
      continue;
    }
    gaveUpAt = t;
    assert.equal(e.state, 'known');
    // (Its gate line passes or not on the 7 days, by now a day of this hour's -1.21 % in them.)
    assert.ok(w.checks.some((c) => c.text.includes('(no 14-day mean: reading the week before from Hyperliquid has failed for 24 h)')), JSON.stringify(w.checks));
  }
  assert.ok(gaveUpAt !== null && gaveUpAt > 24 * 60 * MIN, String(gaveUpAt));

  // A 5xx is no refusal either, and a refusal clock runs only through refusals: 404s with a 503 between them never
  // span the hour.
  const mixed = await setup();
  for (const [t, err] of [[5_000, httpError(404, 'x')], [40 * MIN, httpError(503, 'down')], [70 * MIN, httpError(404, 'x')], [100 * MIN, httpError(404, 'x')]] as const) {
    mixed.hl.historyError = err;
    assert.equal((await mixed.at(t)).e.state, 'loading', `${t / MIN} min`);
  }
});

test('a clock that jumps an hour forward starts the older reads\' give-up clocks again', async () => {
  const hl = new HistoryVenue('hyperliquid', [DOGE_HL], () => 0.000026);
  const phoenix = new HistoryVenue('phoenix', [DOGE_PH], () => 0.0000125);
  const clock = new VirtualClock(T0);
  const { scanner: s, notes } = scanner({ venues: [hl, phoenix] }, clock, {}, { strategy: () => LEG_20_ANY });
  await s.scan();
  await s.idle();
  hl.historyError = httpError(404, 'not found');
  for (const t of [5_000, 30 * 60_000]) {
    clock.set(T0 + t);
    await s.scan();
    await s.idle();
  }
  // Two hours asleep: the refusals before it do not count towards the hour.
  clock.set(T0 + 150 * 60_000);
  await s.scan();
  await s.idle();
  assert.ok(notes.some((n) => n.startsWith('the clock went forward 120 min')), JSON.stringify(notes));
  clock.set(T0 + 155 * 60_000);
  await s.scan();
  assert.equal(s.carry('doge-phoenix-hyperliquid')!.estimate.state, 'loading');
});

test('a decaying spread of one sign is judged on its 7 days: 4.38 % against 10.91 % over 14 does not pay the round trip', async () => {
  // Hyperliquid paid 0.000005/h this week and 0.00002/h the week before; Phoenix nothing. Short HL / long PH: 4.38 %
  // over 7 days, (169 × 4.38 + 167 × 17.52) / 336 = 10.91 % over 14.
  const weekAgo = CURRENT - 168 * HOUR_MS;
  const hl = new HistoryVenue('hyperliquid', [DOGE_HL], (_s, t) => (t >= weekAgo ? 0.000005 : 0.00002));
  const phoenix = new HistoryVenue('phoenix', [DOGE_PH], () => 0);
  const clock = new VirtualClock(T0);
  const { scanner: s } = scanner({ venues: [hl, phoenix] }, clock, { policy: DOGE_POLICY }, { strategy: () => LEG_20_ANY, oracle: DOGE_ORACLE });
  for (const t of [0, 5_000]) {
    clock.set(T0 + t);
    await s.scan();
    await s.idle();
  }
  clock.set(T0 + 10_000);
  const r = await s.scan();
  const w = byId(r.windows, 'doge-phoenix-hyperliquid')!;
  const e = s.carry(w.id)!.estimate;
  assert.equal(e.state, 'known');
  assert.equal(e.basis, '7d');
  assert.equal(e.expectedAprPct, 4.38);
  assert.equal(e.gross.d14AprPct, 10.911);
  assert.equal(e.ok, false);
  assert.ok(w.checks.some((c) => !c.ok && c.text.includes('the 7-day spread of 4.38 % APR (the smaller of the 7- and 14-day means)')
    && c.text.includes('no more than the')), JSON.stringify(w.checks));
  assert.equal(isEnterable(w), false);
});

test('a market younger than 14 days: judged on its 7 days once the week before answers empty, on 14 once it has 303 hours', async () => {
  // Hyperliquid DOGE listed 167 hours before this hour: the week read has its 168 prints, the older read none.
  const listedAt = CURRENT - 167 * HOUR_MS;
  const hl = new HistoryVenue('hyperliquid', [DOGE_HL], () => 0.000026);
  hl.listedAt = listedAt;
  const phoenix = new HistoryVenue('phoenix', [DOGE_PH], () => 0.0000125);
  const clock = new VirtualClock(T0);
  const { scanner: s, notes } = scanner({ venues: [hl, phoenix] }, clock, {}, { strategy: () => LEG_20_ANY });
  for (const t of [0, 5_000]) {
    clock.set(T0 + t);
    await s.scan();
    await s.idle();
  }
  assert.ok(notes.includes('hyperliquid older history DOGE: 0 prints against 168 for the week after it: a market younger than 14 days'), JSON.stringify(notes));
  clock.set(T0 + 10_000);
  await s.scan();
  const young = s.carry('doge-phoenix-hyperliquid')!.estimate;
  assert.deepEqual([young.state, young.basis, young.gross.d14AprPct], ['known', '7d', null]);
  assert.equal(young.noFortnightWhy, 'Hyperliquid DOGE is younger than 14 days');
  // An hour at a time, each hour's week read adding to the store: the 14 days count once 90 % of them (303) are in.
  let upgradedAtAge: number | null = null;
  for (let k = 1; k <= 140 && upgradedAtAge === null; k++) {
    const now = CURRENT + k * HOUR_MS + 61_000;
    clock.set(now);
    await s.scan();
    await s.idle();
    const e = s.carry('doge-phoenix-hyperliquid')!.estimate;
    if (e.gross.d14AprPct !== null) {
      assert.equal(e.state, 'known');
      upgradedAtAge = (CURRENT + k * HOUR_MS - listedAt) / HOUR_MS;
    } else {
      assert.equal(e.state, 'known', `hour ${k}: judged on 7 days until then, never loading`);
    }
  }
  assert.ok(upgradedAtAge !== null && Math.abs(upgradedAtAge - 303) <= 2, String(upgradedAtAge));
});

test('a desk pair whose 7 and 14 days disagree in sign is listed in neither direction; held, it keeps its direction and fails', async () => {
  // This week Hyperliquid paid 0.000026/h and Phoenix 0.0000125/h; the week before, Hyperliquid nothing and Phoenix
  // 0.00004/h. Short HL / long PH: 11.826 % APR over 7 days, -11.47 % over 14 (a print books the hour before it, so
  // 169 of the 336 hours carry this week's rates: (169 × 11.826 - 167 × 35.04) / 336).
  const weekAgo = CURRENT - 168 * HOUR_MS;
  const rates = () => ({
    hl: new HistoryVenue('hyperliquid', [DOGE_HL], (_s, t) => (t >= weekAgo ? 0.000026 : 0)),
    phoenix: new HistoryVenue('phoenix', [DOGE_PH], (_s, t) => (t >= weekAgo ? 0.0000125 : 0.00004)),
  });
  const thirdScan = async (held: HeldWindow | null) => {
    const { hl, phoenix } = rates();
    const clock = new VirtualClock(T0);
    const { scanner: s } = scanner({ venues: [hl, phoenix] }, clock, {}, { strategy: () => LEG_20_ANY, held: () => held });
    await s.scan();
    await s.idle();
    clock.set(T0 + 5_000);
    const loading = await s.scan();
    await s.idle();
    clock.set(T0 + 10_000);
    return { s, loading, r: await s.scan() };
  };
  const free = await thirdScan(null);
  // While the week before loads, the 7 days decide; once it is in, the spread has flipped: neither direction is listed.
  assert.deepEqual(free.loading.windows.map((w) => w.id), ['doge-phoenix-hyperliquid']);
  assert.deepEqual(free.r.windows.map((w) => w.id), []);

  const held = await thirdScan({ windowId: 'doge-phoenix-hyperliquid', since: T0 - HOUR_MS });
  assert.deepEqual(held.r.windows.map((w) => w.id), ['doge-phoenix-hyperliquid']);
  const w = held.r.windows[0]!;
  assert.equal(held.s.carry(w.id)!.estimate.state, 'mixed');
  assert.ok(w.checks.some((c) => !c.ok && c.text === 'The 7-day spread (11.83 % APR) and the 14-day spread (-11.47 % APR) point opposite ways: '
    + 'no steady carry in this direction'), JSON.stringify(w.checks));
  // Its net APR is its 7 days minus the round trip, not this hour's swing; the margin moves and the rescue reserve
  // are not in its costs.
  assert.equal(w.netAprPct, Math.round((11.826 - totalCosts(w)) * 1000) / 1000);
  assert.equal(w.costs.rescueReservePct, 0);
});

test('a desk leg over 2 % of its open interest: listed only on a multi-day spread that pays, with a failing check naming the share', async () => {
  // At the default 1000 USD leg, Phoenix's 41k USD of DOGE is 2.4 % a leg.
  const hl = new HistoryVenue('hyperliquid', [DOGE_HL], () => 0.000026);
  const phoenix = new HistoryVenue('phoenix', [DOGE_PH], () => 0.0000125);
  const clock = new VirtualClock(T0);
  const { scanner: s } = scanner({ venues: [hl, phoenix] }, clock);
  const r1 = await s.scan();
  // Before its history is in: listed in neither direction and no book read, but its legs' history is asked for.
  assert.deepEqual(r1.windows.map((w) => w.id), []);
  assert.equal(r1.notes.historyReads, 2);
  assert.deepEqual(r1.notes.dropped, {});
  assert.deepEqual(hl.bookCalls, []);
  await s.idle();
  clock.set(T0 + 5_000);
  const r2 = await s.scan();
  assert.deepEqual(r2.windows.map((w) => w.id), ['doge-phoenix-hyperliquid']);
  const w = r2.windows[0]!;
  assert.ok(w.checks.some((c) => !c.ok && c.text === 'Shown for its multi-day spread, not entered: Phoenix DOGE has $41,249 of open interest: a $1,000 leg is 2.4 % of it, over the 2 % limit'), JSON.stringify(w.checks));
  assert.equal(isEnterable(w), false);
});

test('a desk pair: listed by this hour until its history is in, then in the direction the week paid', async () => {
  const thick = { ...DOGE_PH, openInterest: 555491e3 };
  // This hour favours short Phoenix / long Hyperliquid, and so did the week: nothing changes.
  const hl = new HistoryVenue('hyperliquid', [DOGE_HL], () => 0.00001);
  const ph = new HistoryVenue('phoenix', [thick], () => 0.00003);
  const clock = new VirtualClock(T0);
  const { scanner: s } = scanner({ venues: [hl, ph] }, clock, {}, { strategy: () => LEG_20 });
  assert.deepEqual((await s.scan()).windows.map((x) => x.id), ['doge-hyperliquid-phoenix']);
  await s.idle();
  clock.set(T0 + 5_000);
  const same = await s.scan();
  assert.deepEqual(same.windows.map((x) => x.id), ['doge-hyperliquid-phoenix']);
  assert.equal(same.windows[0]!.grossApr7dPct, 17.52);
  // This hour favours short Phoenix / long Hyperliquid, but the week paid short Hyperliquid / long Phoenix: once the
  // history is in, only that direction is listed.
  const hl2 = new HistoryVenue('hyperliquid', [{ ...DOGE_HL, ratePerHour: 0.00001 }], () => 0.00003);
  const ph2 = new HistoryVenue('phoenix', [{ ...thick, ratePerHour: 0.00003 }], () => 0.00001);
  const clock2 = new VirtualClock(T0);
  const { scanner: s2 } = scanner({ venues: [hl2, ph2] }, clock2, {}, { strategy: () => LEG_20 });
  assert.deepEqual((await s2.scan()).windows.map((x) => x.id), ['doge-hyperliquid-phoenix']);
  await s2.idle();
  clock2.set(T0 + 5_000);
  const flipped = await s2.scan();
  assert.deepEqual(flipped.windows.map((x) => x.id), ['doge-phoenix-hyperliquid']);
  assert.ok(flipped.windows[0]!.grossAprPct < 0);
  assert.equal(flipped.windows[0]!.grossApr7dPct, 17.52);
});

test('a small desk leg before its history is in: the same costs as after, not the margin moves annualised', async () => {
  // At 20 USD a leg the margin moves (flat 1Click fees) and the rescue reserve annualise to hundreds of APR points
  // over the hold; once the week is in they are shown apart. Before it, the list used them, so a window read -605 %
  // and then about -1.5 % a scan later.
  const thick = { ...DOGE_PH, openInterest: 555491e3 };
  const hl = new HistoryVenue('hyperliquid', [DOGE_HL], () => 0.00001);
  const ph = new HistoryVenue('phoenix', [thick], () => 0.00003);
  const clock = new VirtualClock(T0);
  // A desk loaded and no minimum: only the missing history can keep the window shut.
  const { scanner: s } = scanner({ venues: [hl, ph] }, clock, { policy: DOGE_POLICY }, { strategy: () => LEG_20_ANY, oracle: dogeOracle(clock) });
  const before = (await s.scan()).windows[0]!;
  assert.equal(before.grossApr7dPct, null);
  assert.ok(before.grossAprPct > 0, `this hour pays: ${before.grossAprPct}`);
  assert.equal(before.refused, undefined);
  assert.equal(isEnterable(before), false, 'not entered on one hour, however it pays');
  assert.ok(before.checks.some((c) => /^Moving \$\d+\.\d\d of margin a leg onto .* and back costs/.test(c.text)), 'the moves are still shown');
  assert.equal(before.costs.rescueReservePct, 0);
  const costs = before.costs.feesPct + before.costs.slippagePct + before.costs.basisPct;
  assert.ok(costs < 30, `costs ${costs} APR points`);
  assert.equal(before.netAprPct, Math.round((before.grossAprPct - costs) * 1000) / 1000);
  await s.idle();
  clock.set(T0 + 5_000);
  const after = (await s.scan()).windows[0]!;
  assert.equal(after.grossApr7dPct, 17.52);
  assert.deepEqual(after.costs, before.costs);
});

test('a desk pair over the open-interest share whose multi-day spread cannot pay its fees is not listed, its books never read', async () => {
  // A 1000 USD leg is 2.4 % of Phoenix's 41k USD. 0.0000005/h apart: 0.44 % APR, 0.12 USD over 10 days, against
  // 1.80 USD of fees.
  const hl = new HistoryVenue('hyperliquid', [DOGE_HL], () => 0.0000125);
  const phoenix = new HistoryVenue('phoenix', [DOGE_PH], () => 0.000012);
  const clock = new VirtualClock(T0);
  const { scanner: s } = scanner({ venues: [hl, phoenix] }, clock);
  await s.scan();
  await s.idle();
  clock.set(T0 + 5_000);
  assert.deepEqual((await s.scan()).windows, []);
  assert.deepEqual([...hl.bookCalls, ...phoenix.bookCalls], []);
});

test('desk windows rank by the spread expected over the hold net of the round trip, not by this hour; without history after', async () => {
  // SOL pays 78.84 % this hour but 8.76 % over the week; ETH 8.76 % now and 35.04 % over the week.
  const hl = new HistoryVenue('hyperliquid', [
    row('hyperliquid', 'SOL', { ratePerHour: 0.0001 }), row('hyperliquid', 'ETH', { ratePerHour: 0.00002, markPx: 3000, openInterest: 1e4 }),
  ], (symbol) => (symbol === 'SOL' ? 0.00002 : 0.00005));
  const phoenix = new HistoryVenue('phoenix', [
    row('phoenix', 'SOL', { ratePerHour: 0.00001 }), row('phoenix', 'ETH', { ratePerHour: 0.00001, markPx: 3000, openInterest: 1e4 }),
  ], () => 0.00001);
  // Orderly publishes no history here: its windows have no multi-day figure, whatever their net.
  const orderly = new FakeVenue('orderly', [row('orderly', 'PERP_SOL_USDC', { base: 'SOL', ratePerHour: -0.0002 })]);
  const clock = new VirtualClock(T0);
  const { scanner: s } = scanner({ venues: [hl, phoenix, orderly] }, clock, { historyPerScan: 20 });
  const r1 = await s.scan();
  // Before any history, by net APR: SOL's hour ahead of ETH's.
  const before = r1.windows.map((w) => w.id);
  assert.ok(before.indexOf('sol-phoenix-hyperliquid') < before.indexOf('eth-phoenix-hyperliquid'));
  await s.idle();
  clock.set(T0 + 5_000);
  await s.scan();
  await s.idle();
  clock.set(T0 + 10_000);
  const r2 = await s.scan();
  const ids = r2.windows.map((w) => w.id);
  assert.deepEqual(ids.slice(0, 2), ['eth-phoenix-hyperliquid', 'sol-phoenix-hyperliquid']);
  const [eth, sol] = [r2.windows[0]!, r2.windows[1]!];
  assert.ok(sol.grossAprPct > eth.grossAprPct, 'SOL pays more this hour');
  assert.ok(s.carry(eth.id)!.estimate.netUsd! > s.carry(sol.id)!.estimate.netUsd!);
  // Their net APR is the multi-day spread minus costs: ETH's is the higher, as the web ranks and rotates on it.
  assert.ok(eth.netAprPct > sol.netAprPct);
  for (const w of [eth, sol]) assert.equal(w.netAprPct, Math.round((w.grossApr7dPct! - totalCosts(w)) * 1000) / 1000);
  // The Orderly window has no 7-day figure: it follows, though it nets far more this hour.
  const at = ids.indexOf('sol-orderly-hyperliquid');
  assert.ok(at > 1, ids.join(','));
  assert.equal(s.carry('sol-orderly-hyperliquid')!.estimate.basis, null);
  assert.ok(r2.windows[at]!.netAprPct > eth.netAprPct);
});
