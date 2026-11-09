// The scanner when a venue's request budget says no: books asked for in priority order, a skipped read stops the
// venue's other books for the scan, cool-down skips count as failed and budget skips do not, either way a due book
// left unread is stale; rates a venue could not refresh are stale; and a scan on a Phoenix reader that answers 429 to
// everything resolves with stale windows instead of throwing.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ContractPolicy, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { HostBudget, PHOENIX_BUDGET, ReadSkipped } from '../venues/http-budget.ts';
import { PhoenixReader } from '../venues/phoenix.ts';
import { VirtualClock, readWireRecording } from '../venues/replay.ts';
import type { Book, MarketFunding, VenueReader } from '../venues/venue.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from './config.ts';
import type { HeldWindow } from './scanner.ts';
import { Scanner } from './scanner.ts';
import { T0, row } from './test-helpers.ts';

/** A desk venue whose book reads go through `gate` (a test makes it skip or fail); every book asked is counted. */
class GatedVenue {
  readonly id: VenueId;
  rows: MarketFunding[];
  readonly bookCalls: string[] = [];
  gate: (symbol: string) => Error | null = () => null;

  constructor(id: VenueId, rows: MarketFunding[]) {
    this.id = id;
    this.rows = rows;
  }

  async markets(): Promise<never> { throw new Error('not used by the scanner'); }
  async account(): Promise<never> { throw new Error('not used by the scanner'); }
  async userFunding(): Promise<never> { throw new Error('not used by the scanner'); }
  async funding(): Promise<MarketFunding[]> { return this.rows; }

  async book(symbol: string): Promise<Book> {
    const refused = this.gate(symbol);
    if (refused !== null) throw refused;
    this.bookCalls.push(symbol);
    const mark = this.rows.find((r) => r.symbol === symbol)?.markPx ?? 100;
    return { venue: this.id, symbol, time: T0, bids: [{ px: mark * 0.9999, sz: 1e6 / mark }], asks: [{ px: mark * 1.0001, sz: 1e6 / mark }] };
  }
}

/** Phoenix pays 0.001 % an hour on each base; Hyperliquid more, by base, so the gross of each pair differs. */
function venues() {
  const hlRates: Record<string, number> = { SOL: 0.0001, ETH: 0.00005, BTC: 0.00002, WIF: 0.00003 };
  const hl = new GatedVenue('hyperliquid', Object.entries(hlRates).map(([s, r]) => row('hyperliquid', s, { ratePerHour: r })));
  const phoenix = new GatedVenue('phoenix', Object.keys(hlRates).map((s) => row('phoenix', s, { ratePerHour: 0.00001 })));
  return { hl, phoenix };
}

const POLICY: ContractPolicy = {
  hl_assets: [],
  phoenix_markets: [{ symbol: 'BTC', orderbook: 'test-orderbook-btc', base_lot_e8: 1, tick_e8: 1 }],
  orderly_symbols: [],
  max_notional_usd: 5000, price_band_bps: 100, oracle_max_age_s: 60, rescue_cap_usd_per_hour: 500,
  unpriced: [], unpriced_max_notional_usd: 0, max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 2_000_000,
};

function scanner(vs: GatedVenue[], clock: VirtualClock, held: HeldWindow | null = null, policy: ContractPolicy | null = null) {
  const notes: string[] = [];
  const s = new Scanner(vs as unknown as VenueReader[], [], {
    // Off-desk books at the desk's age too: these tests are about skips, not about how often each tier is read.
    config: { ...DEFAULT_SCANNER_CONFIG, offDeskBookTtlMs: DEFAULT_SCANNER_CONFIG.bookTtlMs, policy },
    clock,
    strategy: () => DEFAULT_STRATEGY,
    held: () => held,
    onNote: (n) => notes.push(n),
  });
  return { scanner: s, notes };
}

const phoenixWindows = (ws: FundingWindow[]) => ws.filter((w) => w.longVenue === 'phoenix' || w.shortVenue === 'phoenix');
const skip = (reason: 'cooling' | 'budget') => new ReadSkipped('perp-api.phoenix.trade', 'book', reason, reason === 'cooling' ? T0 + 60_000 : null, T0);

test('books are asked for in order: the held window\'s legs, then the policy\'s markets, then by gross funding', async () => {
  const { hl, phoenix } = venues();
  const held = { windowId: 'wif-phoenix-hyperliquid', since: T0 - 3_600_000 };
  const { scanner: s } = scanner([hl, phoenix], new VirtualClock(T0), held, POLICY);
  await s.scan();
  // WIF held, BTC in the policy, then SOL (0.009 %/h gross) before ETH (0.004 %/h).
  assert.deepEqual(phoenix.bookCalls, ['WIF', 'BTC', 'SOL', 'ETH']);
});

test('a cool-down skip: the venue\'s other books are not asked for, it is failed, its windows stale with the last good book; no throw', async () => {
  const { hl, phoenix } = venues();
  const clock = new VirtualClock(T0);
  const { scanner: s, notes } = scanner([hl, phoenix], clock, null, POLICY);
  const r1 = await s.scan();
  assert.deepEqual(r1.scan.failed, []);
  assert.ok(phoenixWindows(r1.windows).length >= 4);
  const asked = phoenix.bookCalls.length;

  // 40 s on, every book is due; the first Phoenix read is skipped for a cool-down after a 429.
  let gated = 0;
  phoenix.gate = () => {
    gated++;
    return skip('cooling');
  };
  clock.set(T0 + 40_000);
  const r2 = await s.scan();
  // Six reads run at once across venues: the Phoenix ones already started hear the same skip; one started after the
  // first skip is not asked for at all.
  assert.ok(gated < 4, `${gated} Phoenix books asked for`);
  assert.equal(phoenix.bookCalls.length, asked);
  assert.deepEqual(r2.scan.failed, ['phoenix']);
  const ws = phoenixWindows(r2.windows);
  assert.equal(ws.length, phoenixWindows(r1.windows).length, 'the windows stay, on their last good books');
  for (const w of ws) {
    assert.equal(w.stale, true, w.id);
    assert.deepEqual(w.checks[0], { ok: false, text: 'Phoenix did not answer: numbers from 40 s ago' });
  }
  assert.ok(notes.some((n) => n.startsWith('phoenix books: 4 not read this scan (perp-api.phoenix.trade book read skipped: rate-limit cool-down')), notes.join('\n'));
  // Hyperliquid's books were read as ever.
  assert.ok(hl.bookCalls.length >= 8);

  // The cool-down over, the books are read again and the windows are fresh.
  phoenix.gate = () => null;
  clock.set(T0 + 45_000);
  const r3 = await s.scan();
  assert.deepEqual(r3.scan.failed, []);
  assert.ok(phoenixWindows(r3.windows).every((w) => !w.stale));
});

test('a budget skip: the venue is not failed, but a due book it could not read is stale at once, so its windows cannot be entered', async () => {
  const { hl, phoenix } = venues();
  const clock = new VirtualClock(T0);
  const { scanner: s, notes } = scanner([hl, phoenix], clock, null, POLICY);
  await s.scan();
  // Only the first book of each scan is answered: the budget is spent after it.
  let answered = 0;
  phoenix.gate = () => (answered++ === 0 ? null : skip('budget'));
  clock.set(T0 + 40_000);
  const r2 = await s.scan();
  assert.deepEqual(r2.scan.failed, []);
  const staleBases = (ws: FundingWindow[]) => [...new Set(ws.filter((w) => w.stale).map((w) => w.symbol))].sort();
  // BTC (the policy market) was read; SOL, ETH and WIF were due and not read: their 40 s old books are stale.
  assert.deepEqual(staleBases(phoenixWindows(r2.windows)), ['ETH', 'SOL', 'WIF']);
  for (const w of phoenixWindows(r2.windows).filter((x) => x.stale)) {
    assert.deepEqual(w.checks[0], { ok: false, text: 'Phoenix did not answer: numbers from 40 s ago' }, w.id);
  }
  assert.ok(phoenixWindows(r2.windows).some((w) => w.symbol === 'BTC' && !w.stale));
  assert.ok(notes.some((n) => n.startsWith('phoenix books: 3 not read this scan (perp-api.phoenix.trade book read skipped: request budget spent')), notes.join('\n'));

  // A scan later the best by gross of the stale ones (SOL) is read; BTC is 25 s old, not due; ETH and WIF stay stale.
  answered = 0;
  clock.set(T0 + 65_000);
  const r3 = await s.scan();
  assert.deepEqual(r3.scan.failed, []);
  assert.deepEqual(staleBases(phoenixWindows(r3.windows)), ['ETH', 'WIF']);
});

test('rates a venue could not refresh (rateReadAt): its legs are stale, dated that read, noted; the venue is not failed and its books are read', async () => {
  const { hl, phoenix } = venues();
  const clock = new VirtualClock(T0);
  const { scanner: s, notes } = scanner([hl, phoenix], clock, null, POLICY);
  const r1 = await s.scan();
  assert.ok(phoenixWindows(r1.windows).every((w) => !w.stale));
  const asked = phoenix.bookCalls.length;

  clock.set(T0 + 40_000);
  const fresh = phoenix.rows;
  phoenix.rows = fresh.map((r) => ({ ...r, rateReadAt: T0 - 20_000 }));
  const r2 = await s.scan();
  assert.deepEqual(r2.scan.failed, []);
  const ws = phoenixWindows(r2.windows);
  assert.equal(ws.length, phoenixWindows(r1.windows).length);
  for (const w of ws) {
    assert.equal(w.stale, true, w.id);
    assert.deepEqual(w.checks[0], { ok: false, text: 'Phoenix did not answer: numbers from 60 s ago' });
  }
  assert.ok(notes.includes('phoenix funding: the rates are from 60 s ago, its refresh of them failed'), notes.join('\n'));
  assert.ok(phoenix.bookCalls.length > asked, 'its books are still read');

  // Refreshed again: fresh windows.
  phoenix.rows = fresh;
  clock.set(T0 + 45_000);
  const r3 = await s.scan();
  assert.ok(phoenixWindows(r3.windows).every((w) => !w.stale));
});

test('a scan on a Phoenix reader that answers 429 to everything resolves: failed [phoenix], its windows stale with the last good numbers', async () => {
  const lines = readWireRecording(join(fileURLToPath(new URL('../../fixtures/phoenix-wire/', import.meta.url)), 'phoenix-mainnet-2026-10-31.jsonl.gz'));
  const at = lines[0]!.t;
  let limited = false;
  let requests = 0;
  const f = (async (input: string | URL | Request) => {
    requests++;
    const url = new URL(String(input));
    if (limited) return new Response('{"error":"rate_limited"}', { status: 429, headers: { 'retry-after': '0.2' } });
    // History is not part of this test: it fails, and the windows are listed on this hour's rates.
    if (url.searchParams.has('startTime')) return new Response('{}', { status: 503 });
    const line = lines.find((l) => l.url === url.href);
    if (line !== undefined) return new Response(JSON.stringify(line.response), { status: line.status });
    // Books of markets the recording lacks: one level each side around 100.
    if (url.pathname.startsWith('/v1/view/orderbook/')) {
      const symbol = decodeURIComponent(url.pathname.split('/').at(-1)!);
      return new Response(JSON.stringify({ symbol, bids: [[99.99, 1e5]], asks: [[100.01, 1e5]] }), { status: 200 });
    }
    return new Response('{"error":"not recorded"}', { status: 404 });
  }) as typeof fetch;
  const budget = new HostBudget('phoenix-test', { ...PHOENIX_BUDGET, ratePerSec: 200, burst: 50, random: () => 0 });
  // The reader on the scanner's clock: its shared reads (the marks, the overview) age as the scans go on.
  const clock = new VirtualClock(at);
  const phoenix = new PhoenixReader({ fetch: f, clock, budget });
  // Hyperliquid quotes the recording's SOL, ETH and BTC at Phoenix's marks, paying more.
  const funding = await phoenix.funding();
  const hl = new GatedVenue('hyperliquid', ['SOL', 'ETH', 'BTC'].map((s) => {
    const p = funding.find((x) => x.symbol === s)!;
    return row('hyperliquid', s, { ratePerHour: p.ratePerHour + 0.0001, markPx: p.markPx, oraclePx: p.markPx, openInterest: 1e9 / p.markPx! });
  }));
  const s = new Scanner([hl, phoenix] as unknown as VenueReader[], [], {
    config: DEFAULT_SCANNER_CONFIG, clock, strategy: () => DEFAULT_STRATEGY,
  });
  const r1 = await s.scan();
  await s.idle();
  assert.deepEqual(r1.scan.failed, []);
  const before = phoenixWindows(r1.windows);
  assert.ok(before.length >= 1, 'a Phoenix window is listed');
  assert.ok(before.every((w) => !w.stale));

  limited = true;
  const sent = requests;
  clock.set(at + 40_000);
  const r2 = await s.scan();
  assert.deepEqual(r2.scan.failed, ['phoenix']);
  const after = phoenixWindows(r2.windows);
  assert.deepEqual(after.map((w) => w.id).sort(), before.map((w) => w.id).sort());
  for (const w of after) {
    assert.equal(w.stale, true);
    assert.equal(w.updatedAt, at);
    assert.equal(w.grossAprPct, before.find((b) => b.id === w.id)!.grossAprPct);
  }
  // The marks read once and retried once after Retry-After; the overview from 40 s ago still stands; no book was asked.
  assert.equal(requests - sent, 2);

  // Still limited a scan later: no throw, the same stale windows.
  clock.set(at + 45_000);
  const r3 = await s.scan();
  assert.deepEqual(r3.scan.failed, ['phoenix']);
  assert.ok(phoenixWindows(r3.windows).every((w) => w.stale));
  await s.idle();
});

test('off-desk books are read again once 5 min old, the held window\'s and the policy\'s once 30 s old', async () => {
  const { hl, phoenix } = venues();
  const clock = new VirtualClock(T0);
  const s = new Scanner([hl, phoenix] as unknown as VenueReader[], [], {
    config: { ...DEFAULT_SCANNER_CONFIG, policy: POLICY }, clock, strategy: () => DEFAULT_STRATEGY,
  });
  await s.scan();
  assert.deepEqual([...phoenix.bookCalls].sort(), ['BTC', 'ETH', 'SOL', 'WIF']);
  phoenix.bookCalls.length = 0;
  clock.set(T0 + 40_000);
  const r2 = await s.scan();
  assert.deepEqual(phoenix.bookCalls, ['BTC'], 'only the policy market: the others are 40 s old, under 5 min');
  assert.ok(phoenixWindows(r2.windows).every((w) => !w.stale), 'a book under its age is fresh, not stale');
  phoenix.bookCalls.length = 0;
  clock.set(T0 + 5 * 60_000);
  await s.scan();
  assert.deepEqual([...phoenix.bookCalls].sort(), ['BTC', 'ETH', 'SOL', 'WIF']);
  // Without a policy (no desk yet) every leg counts as the desk's: read once 30 s old.
  const { hl: hl2, phoenix: px2 } = venues();
  const clock2 = new VirtualClock(T0);
  const { scanner: none } = scanner([hl2, px2], clock2, null, null);
  await none.scan();
  px2.bookCalls.length = 0;
  clock2.set(T0 + 40_000);
  await none.scan();
  assert.equal(px2.bookCalls.length, 4);
});

test('history reads the budget skips: one note for the venue, no failure, and they come back a scan apart', async () => {
  const { hl, phoenix } = venues();
  const asked: { symbol: string; at: number }[] = [];
  let skipping = true;
  const clock = new VirtualClock(T0);
  const px = Object.assign(phoenix, {
    marketFundingHistory: async (symbol: string, _start: number, end: number) => {
      // The week's reads only: once a week is in, the week before is read too.
      if (end > clock.now() - 86_400_000) asked.push({ symbol, at: clock.now() });
      if (skipping) throw new ReadSkipped('perp-api.phoenix.trade', 'history', 'budget', null, clock.now());
      return [];
    },
  });
  const { scanner: s, notes } = scanner([hl, px], clock, null, POLICY);
  await s.scan();
  await s.idle();
  const first = asked.length;
  assert.ok(first >= 2, `${first} history reads`);
  assert.ok(!notes.some((n) => /phoenix history .* failed/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n) => n.startsWith(`phoenix history: ${first} read(s) not sent, tried again over the next scans (perp-api.phoenix.trade history read skipped: request budget spent)`)), notes.join('\n'));
  // A minute on, one is due; a scan later the next; not all at once.
  skipping = false;
  asked.length = 0;
  clock.set(T0 + 60_000);
  await s.scan();
  await s.idle();
  assert.equal(asked.length, 1, JSON.stringify(asked));
  clock.set(T0 + 65_000);
  await s.scan();
  await s.idle();
  assert.equal(asked.length, 2, JSON.stringify(asked));
});

test('funding the budget skips: not a failure while the last read is usable; a cool-down skip is, and says why (failedWhy)', async () => {
  const { hl, phoenix } = venues();
  let refuse: 'cooling' | 'budget' | null = null;
  const clock = new VirtualClock(T0);
  const px = Object.assign(phoenix, {
    funding: async () => {
      if (refuse !== null) throw new ReadSkipped('perp-api.phoenix.trade', 'funding', refuse, refuse === 'cooling' ? clock.now() + 30_000 : null, clock.now());
      return phoenix.rows;
    },
  });
  const { scanner: s, notes } = scanner([hl, px], clock, null, POLICY);
  const r1 = await s.scan();
  assert.deepEqual(r1.scan.failed, []);

  // Not sent: the last read (40 s old) stands in, stale, and the venue is not failed.
  refuse = 'budget';
  clock.set(T0 + 40_000);
  const r2 = await s.scan();
  assert.deepEqual(r2.scan.failed, []);
  assert.equal(r2.failedWhy?.phoenix, undefined);
  assert.ok(notes.some((n) => n.startsWith('phoenix funding not read: perp-api.phoenix.trade funding read skipped: request budget spent')), notes.join('\n'));
  assert.ok(phoenixWindows(r2.windows).length > 0 && phoenixWindows(r2.windows).every((w) => w.stale));

  // Refused for a cool-down after a 429: the venue did refuse us, so it is failed, with the reason.
  refuse = 'cooling';
  clock.set(T0 + 80_000);
  const r3 = await s.scan();
  assert.deepEqual(r3.scan.failed, ['phoenix']);
  assert.match(r3.failedWhy?.phoenix ?? '', /^funding: .*cool-down/);

  // A budget skip with no usable last read is a failure too: there is nothing to scan with.
  const fresh = venues();
  const px2 = Object.assign(fresh.phoenix, {
    funding: async () => { throw new ReadSkipped('perp-api.phoenix.trade', 'funding', 'budget', null, T0); },
  });
  const r4 = await scanner([fresh.hl, px2], new VirtualClock(T0)).scanner.scan();
  assert.deepEqual(r4.scan.failed, ['phoenix']);
  assert.match(r4.failedWhy?.phoenix ?? '', /^funding: .*request budget spent/);
});
