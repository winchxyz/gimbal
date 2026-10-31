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

/** A desk venue with public funding history: `rate(symbol)` for every hour asked. */
class HistoryVenue extends FakeVenue {
  readonly historyCalls: [string, number, number][] = [];
  historyError: Error | 'hang' | null = null;
  readonly rate: (symbol: string) => number;

  constructor(id: VenueId, rows: MarketFunding[], rate: (symbol: string) => number) {
    super(id, rows);
    this.rate = rate;
  }

  async marketFundingHistory(symbol: string, start: number, end: number): Promise<MarketFundingPoint[]> {
    this.historyCalls.push([symbol, start, end]);
    if (this.historyError === 'hang') return new Promise(() => {});
    if (this.historyError !== null) throw this.historyError;
    const points: MarketFundingPoint[] = [];
    for (let t = Math.ceil(start / HOUR_MS) * HOUR_MS; t <= end; t += HOUR_MS) points.push({ time: t + 59, symbol, ratePerHour: this.rate(symbol), periodHours: 1 });
    return points.filter((p) => p.time <= end);
  }
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

test('watch-only windows: one with a quality finding ranks after a clean one that grosses less, and is cut first', async () => {
  const hl = new FakeVenue('hyperliquid', [row('hyperliquid', 'SOL', { ratePerHour: 0.00005, volume24hUsd: 5e7 })]);
  const watchers = [
    // Pacifica pays the most, but traded 20k USD in 24 h.
    watch('pacifica', 'dex', [row('pacifica', 'SOL', { ratePerHour: -0.0005, volume24hUsd: 20_000 })]),
    watch('lighter', 'dex', [row('lighter', 'SOL', { ratePerHour: -0.0001, volume24hUsd: 2e6 })]),
  ];
  const { scanner: s } = scanner({ venues: [hl], watch: watchers }, new VirtualClock(T0));
  const { windows } = await s.scan();
  assert.deepEqual(windows.map((w) => [w.id, w.grossAprPct]), [
    ['sol-lighter-hyperliquid', 131.4], ['sol-pacifica-hyperliquid', 481.8], ['sol-pacifica-lighter', 350.4],
  ]);
  assert.deepEqual(byId(windows, 'sol-pacifica-hyperliquid')!.checks.slice(0, 2).map((c) => c.text), [
    'Watch-only: pacifica cannot be traded by the desk. Fees, slippage and the rescue reserve are not priced',
    'Thin: pacifica SOL traded $20k in 24 h, under the $100k floor',
  ]);
  assert.ok(!byId(windows, 'sol-lighter-hyperliquid')!.checks.some((c) => c.text.startsWith('Thin:')));
  // The cut keeps the clean window.
  const { scanner: one } = scanner({ venues: [hl], watch: watchers }, new VirtualClock(T0), { maxWatchWindows: 1 });
  assert.deepEqual((await one.scan()).windows.map((w) => w.id), ['sol-lighter-hyperliquid']);
});

test('with a policy and fresh oracle prices: enterable windows first by net, ahead of a refused window that nets more', async () => {
  const { hl, phoenix, orderly, watchers } = venues();
  const { scanner: s } = scanner({ venues: [hl, phoenix, orderly], watch: watchers }, new VirtualClock(T0), { policy: POLICY }, { oracle: SOL_ORACLE });
  const r = await s.scan();
  const enterable = r.windows.filter(isEnterable);
  assert.deepEqual(enterable.map((w) => w.id), ['sol-phoenix-hyperliquid', 'sol-orderly-hyperliquid', 'sol-phoenix-orderly']);
  assert.deepEqual(r.windows.slice(0, 3), enterable);
  // WIF nets far more (78.84 % gross) but is not in the policy: it ranks after every enterable window.
  const wif = r.windows[3]!;
  assert.equal(wif.id, 'wif-phoenix-hyperliquid');
  assert.ok(wif.netAprPct > enterable[0]!.netAprPct);
  assert.deepEqual(wif.refused, { code: 'E_ASSET', reason: 'WIF not in policy on phoenix' });
  // BTC is listed but has no oracle price.
  assert.deepEqual(r.windows[4]!.refused, { code: 'E_ORACLE_STALE', reason: 'no oracle price for BTC on phoenix' });
  assert.ok(r.windows.slice(5).every((w) => !w.tradable));
  assert.match(scanLine(12, r), /, best sol-phoenix-hyperliquid -?\d+\.\d\d % net, /);
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
  assert.deepEqual(w.checks[0], { ok: false, text: 'phoenix did not answer: numbers from 5 s ago' });
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
  assert.deepEqual(w.checks[0], { ok: false, text: 'orderly did not answer: numbers from 35 s ago' });
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
  // The exact reverse of the held window closes and opens all four fills and moves no margin.
  const rev = byId(r.windows, 'sol-phoenix-hyperliquid')!;
  assert.ok(rev.switchCostUsd! > 2 && rev.switchCostUsd! < 3, String(rev.switchCostUsd));

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
  assert.equal(byId(r0.windows, 'sol-phoenix-hyperliquid'), undefined, 'dropped when not held');
  assert.equal(r0.notes.dropped['under-oi-floor'], 1);

  const { scanner: s } = scanner({ venues: [hl, phoenix, orderly] }, clock, {}, { held: () => held });
  const r = await s.scan();
  const h = byId(r.windows, 'sol-phoenix-hyperliquid')!;
  assert.deepEqual(h.held, { since: T0 - HOUR_MS });
  assert.ok(h.checks.some((c) => !c.ok && c.text === 'Kept only because the desk holds it: phoenix SOL has $40,000 of open interest, under the $500,000 floor'), JSON.stringify(h.checks));
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
  assert.equal(r2.notes.historyReads, 0);
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
