// The scanner on fake readers: what it ranks, what it leaves out, and how missing data stays visibly missing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VenueId, Window as FundingWindow } from '@gimbal/shared';
import { VirtualClock } from '../venues/replay.ts';
import type { Book, MarketFunding, MarketFundingPoint, VenueReader, WatchReader } from '../venues/venue.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from './config.ts';
import type { ScannerConfig } from './config.ts';
import { HOUR_MS } from './history.ts';
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
  historyError: Error | null = null;
  readonly rate: (symbol: string) => number;

  constructor(id: VenueId, rows: MarketFunding[], rate: (symbol: string) => number) {
    super(id, rows);
    this.rate = rate;
  }

  async marketFundingHistory(symbol: string, start: number, end: number): Promise<MarketFundingPoint[]> {
    this.historyCalls.push([symbol, start, end]);
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

test('one scan: tradable windows by net, then the rest by gross; CEX only against something else', async () => {
  const { hl, phoenix, orderly, watchers } = venues();
  const { scanner: s } = scanner({ venues: [hl, phoenix, orderly], watch: watchers }, new VirtualClock(T0));
  const { windows, scan, notes } = await s.scan();
  assert.deepEqual(scan, { venues: 6, failed: [], at: T0 });

  // Desk, oracle-priced: three SOL directions with gross > 0, and BTC Phoenix -> Hyperliquid.
  const tradable = windows.filter((w) => w.tradable);
  assert.deepEqual(tradable.map((w) => w.id).sort(), ['btc-phoenix-hyperliquid', 'sol-orderly-hyperliquid', 'sol-phoenix-hyperliquid', 'sol-phoenix-orderly']);
  assert.deepEqual(windows.slice(0, 4), tradable, 'tradable windows come first');
  for (let i = 1; i < tradable.length; i++) assert.ok(tradable[i - 1]!.netAprPct >= tradable[i]!.netAprPct);

  // The rest by gross: WIF (no oracle price) and 11 watch-only SOL windows.
  const rest = windows.slice(4);
  assert.equal(rest.length, 12);
  for (let i = 1; i < rest.length; i++) assert.ok(rest[i - 1]!.grossAprPct >= rest[i]!.grossAprPct);
  assert.deepEqual(byId(windows, 'wif-phoenix-hyperliquid')!.refused, { code: 'E_ORACLE_STALE', reason: 'no trusted price' });
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

  // At most maxWatchWindows watch-only windows are sent; desk windows are never cut.
  const { scanner: few } = scanner({ venues: [hl, phoenix, orderly], watch: watchers }, new VirtualClock(T0), { maxWatchWindows: 3 });
  assert.equal((await few.scan()).windows.length, 4 + 1 + 3);
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

test('a read that outlives its scan is not asked again: the next scan waits on the same request and uses its answer', async () => {
  const { hl, phoenix } = venues();
  let calls = 0;
  const slow = watch('pacifica', 'dex', []);
  slow.funding = () => {
    calls++;
    return new Promise((resolve) => setTimeout(() => resolve([row('pacifica', 'SOL', { ratePerHour: 0.0002 })]), 60));
  };
  const clock = new VirtualClock(T0);
  const { scanner: s } = scanner({ venues: [hl, phoenix], watch: [slow] }, clock, { readTimeoutMs: 40 });
  assert.deepEqual((await s.scan()).scan.failed, ['pacifica']);
  clock.set(T0 + 5_000);
  const r2 = await s.scan();
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
  await s.scan();
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

test('history: the 7-day gross from public history, intervalsAbove, the window history, and when it is read again', async () => {
  const { orderly } = venues();
  const hl = new HistoryVenue('hyperliquid', [row('hyperliquid', 'SOL', { ratePerHour: 0.00005 })], () => 0.00005);
  const phoenix = new HistoryVenue('phoenix', [row('phoenix', 'SOL', { ratePerHour: 0.00001 })], () => 0.00001);
  const clock = new VirtualClock(T0);
  const { scanner: s, notes } = scanner({ venues: [hl, phoenix, orderly] }, clock, { historyPerScan: 10 });
  const r1 = await s.scan();
  assert.equal(r1.notes.historyReads, 2);
  // From 176 h before this hour (8 h more than the week) to the end of this hour.
  assert.deepEqual(hl.historyCalls, [['SOL', CURRENT - 176 * HOUR_MS, CURRENT + HOUR_MS - 1]]);

  const w = byId(r1.windows, 'sol-phoenix-hyperliquid')!;
  // 0.00005 − 0.00001 = 0.00004/h every hour of the week: 35.04 % APR.
  assert.equal(w.grossApr7dPct, 35.04);
  assert.ok(w.netAprPct >= DEFAULT_STRATEGY.minNetAprPct);
  assert.equal(w.intervalsAbove, 168);
  // Orderly has no history source here: its windows show null, never a 0 that ranks.
  const o = byId(r1.windows, 'sol-orderly-hyperliquid')!;
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

  // A failed read is tried again after historyRetryMs (60 s), not every scan.
  hl.historyError = new Error('HTTP 429');
  clock.set(CURRENT + 2 * HOUR_MS + 61_000);
  await s.scan();
  const calls = hl.historyCalls.length;
  assert.ok(notes.some((n) => n.startsWith('hyperliquid history SOL failed: HTTP 429')));
  clock.set(CURRENT + 2 * HOUR_MS + 100_000);
  await s.scan();
  assert.equal(hl.historyCalls.length, calls);
  hl.historyError = null;
  clock.set(CURRENT + 2 * HOUR_MS + 125_000);
  await s.scan();
  assert.equal(hl.historyCalls.length, calls + 1);
});

test('the scanner refuses two readers for one venue, and a clock that goes back', async () => {
  const { hl } = venues();
  assert.throws(() => scanner({ venues: [hl, hl] }, new VirtualClock(T0)), /two readers for hyperliquid/);
  let t = T0;
  const { scanner: s } = scanner({ venues: [hl] }, { now: () => t });
  await s.scan();
  t = T0 - 1;
  await assert.rejects(s.scan(), /clock went back/);
});
