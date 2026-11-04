// The book with an Orderly leg: a Hyperliquid short and an Orderly long on SOL. Orderly's fills come from the private
// session's executionreport pushes (OrderlyFillLog), in the shape a testnet push had; its funding from the signed
// funding_fee_history read through the real OrderlyReader (the rows in the shape interfaces 1.3 records as seen live,
// the funding period from the recorded mainnet /v1/public/info answer). No network, nothing signs.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { JournalEntry } from '@gimbal/shared';
import type { HlFundingRow } from '../venues/hyperliquid.ts';
import { parseFundingRow } from '../venues/hyperliquid.ts';
import type { OrderlyFundingFeePage, OrderlyFundingFeeRow } from '../venues/orderly-actions.ts';
import { VirtualClock, readWireRecording, replayFetch } from '../venues/replay.ts';
import type { FundingPayment } from '../venues/venue.ts';
import { createBook } from './book.ts';
import { fundingPeriodAt, periodicOf } from './derive.ts';
import { ORDERLY_FILL_KEEP_MS, ORDERLY_LATE_PUSH_MS, OrderlyFillLog, orderlyBookFunding, orderlyBookSymbol } from './orderly.ts';
import { bookReport } from './report.ts';
import { liveBookSources } from './sources.ts';
import type { BookSources, CloseFillQuery } from './sync.ts';
import type { BookRecord, FeeEvent, FundingEvent } from './types.ts';
import { FixtureLedger, H, T0, tempDir } from './test-helpers.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
const DESK = { mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1' } as const;
const HL_ADDRESS = '0x00000000000000000000000000000000000000d1';
const ACCOUNT = `0x${'0'.repeat(62)}a1`;
const WIRE = readWireRecording(join(fileURLToPath(new URL('../../fixtures/orderly-wire/', import.meta.url)), 'orderly-mainnet-2026-10-31.jsonl.gz'));
const WINDOW = 'sol-orderly-hyperliquid';
const ZERO_HASH = `0x${'0'.repeat(64)}`;

/** An executionreport push with a fill, in the shape of a testnet push of 2026-10-27 (every field it carried). */
function push(o: { orderId: number; side: 'BUY' | 'SELL'; qty: number; px: number; fee: number; tradeId: number; at: number }): Record<string, unknown> {
  return {
    symbol: 'PERP_SOL_USDC', clientOrderId: `g${o.orderId}`, orderId: o.orderId, type: 'LIMIT', side: o.side, quantity: o.qty, price: o.px,
    tradeId: o.tradeId, executedPrice: o.px, executedQuantity: o.qty, fee: o.fee, feeAsset: 'USDC', totalExecutedQuantity: o.qty,
    avgPrice: o.px, averageExecutedPrice: o.px, status: 'FILLED', reason: '', totalFee: o.fee, visible: o.qty, visibleQuantity: o.qty,
    timestamp: o.at, createdTime: o.at - 4, matchId: o.tradeId, seq: o.at * 1000, marginMode: 'CROSS', maker: false,
  };
}

/** The desk client's funding_fee_history read, over rows in the shape interfaces 1.3 records (one page). */
function feeHistory(rows: OrderlyFundingFeeRow[]) {
  const asked: { start: number; end: number }[] = [];
  return {
    asked,
    accountId: ACCOUNT,
    async fundingFeeHistory(start: number, end: number, page: number, size: number): Promise<OrderlyFundingFeePage> {
      asked.push({ start, end });
      const all = rows.filter((r) => r.created_time >= start && r.created_time <= end);
      return { rows: all.slice((page - 1) * size, page * size), meta: { total: all.length, records_per_page: size, current_page: page } };
    },
  };
}

const feeRow = (t: number, fee: number, type: 'Pay' | 'Receive'): OrderlyFundingFeeRow & Record<string, unknown> => ({
  symbol: 'PERP_SOL_USDC', funding_rate: 0.00005, mark_price: 200, funding_fee: fee, payment_type: type, status: 'Accrued',
  created_time: t, updated_time: t, margin_mode: 'CROSS',
});

/** Hyperliquid userFunding rows (wire shape): a short SOL 5 receiving 0.01 an hour at 11:00 .. 17:00. */
function hlRows(): HlFundingRow[] {
  return Array.from({ length: 7 }, (_, i) => ({
    time: T0 + (i + 1) * H + 65, hash: ZERO_HASH,
    delta: { type: 'funding', coin: 'SOL', usdc: '0.01', szi: '-5.0', fundingRate: '0.00001', nSamples: null },
  } as HlFundingRow));
}

const ENTER_AT = T0 + 20 * 60_000;            // 10:20
const CLOSED_AT = T0 + 7 * H + 30 * 60_000;   // 17:30, a close the loop never reported

/** SOL in at 10:20: Hyperliquid short 5 at 200 (fee 0.4), Orderly long 5 at 200.1 with its fee not in the record. */
function enterSol(): BookRecord {
  return {
    kind: 'enter', windowId: WINDOW, symbol: 'SOL', at: ENTER_AT, startedAt: ENTER_AT - 30_000,
    legs: [
      { venue: 'hyperliquid', side: 'SELL', qty: '5', avgPx: 200, feeUsd: 0.4 },
      { venue: 'orderly', side: 'BUY', qty: '5', avgPx: 200.1, feeUsd: null },
    ],
    feeUsd: 0.4, tx: [], forecastNetAprPct: 20, exitReason: null, rotation: null, by: 'auto', marginMoves: [], legUsd: 1000,
  };
}

/** Orderly pays at 16:00 UTC (its 8 h period): the long pays 0.05 on a positive rate. 08:00 and 00:00 are outside the hold. */
const FUNDING_ROWS = [feeRow(T0 - 2 * H, 0.04, 'Pay'), feeRow(T0 + 6 * H, 0.05, 'Pay'), feeRow(T0 + 14 * H, 0.03, 'Pay')];

function setup(o: { fundingRows?: OrderlyFundingFeeRow[]; orderlyFunding?: boolean } = {}) {
  const log = new OrderlyFillLog(T0);
  // The open's Orderly fill: 4 bps of 5 x 200.1.
  log.onExecutionReport(push({ orderId: 11, side: 'BUY', qty: 5, px: 200.1, fee: 0.4002, tradeId: 9001, at: ENTER_AT - 10_000 }), ENTER_AT - 9_950);
  const fees = feeHistory(o.fundingRows ?? FUNDING_ROWS);
  const live = liveBookSources({ network: 'mainnet', fetch: replayFetch(WIRE), orderly: { fundingFees: fees, fills: log, hearWaitMs: 20 } });
  const hl = new FixtureLedger(hlRows().map(parseFundingRow));
  const hlClose: CloseFillQuery[] = [];
  const sources: BookSources = {
    funding: { hyperliquid: hl, ...(o.orderlyFunding === false ? {} : { orderly: live.funding.orderly! }) },
    fillFee: (q) => (q.venue === 'orderly' ? live.fillFee!(q) : Promise.resolve(null)),
    closeFills: async (q) => {
      if (q.venue === 'orderly') return live.closeFills!(q);
      hlClose.push(q);
      return { fill: { venue: 'hyperliquid', side: 'BUY', qty: '5', avgPx: 201, feeUsd: 0.4 }, at: CLOSED_AT };
    },
  };
  const clock = new VirtualClock(ENTER_AT);
  const journal: JournalEntry[] = [];
  let held: { windowId: string } | null = { windowId: WINDOW };
  const book = createBook({
    dir: tempDir(dirs), ...DESK, addresses: { hyperliquid: HL_ADDRESS, orderly: ACCOUNT }, sources, clock,
    publish: (e) => journal.push(e), log: () => {}, loopHeld: () => held,
  });
  /**
   * The book syncs at `t`. The session is alive: it is heard through `t` and the late-push margin after it (the frames
   * a close read up to `t` waits for), unless `silent`.
   */
  const syncAt = async (t: number, silent = false) => {
    clock.set(t);
    if (!silent) log.heard(t + ORDERLY_LATE_PUSH_MS);
    return book.sync();
  };
  return { book, clock, journal, fees, log, hlClose, syncAt, release: () => { held = null; } };
}

/** The open, then the close nobody reported (sold 5 at 201, 4 bps of 1005), settled past exit + 2 h. */
async function closedOutside(s: ReturnType<typeof setup>) {
  s.book.record(enterSol());
  await s.syncAt(T0 + 7 * H + 5 * 60_000);
  s.log.onExecutionReport(push({ orderId: 12, side: 'SELL', qty: 5, px: 201, fee: 0.402, tradeId: 9002, at: CLOSED_AT }), CLOSED_AT + 50);
  // The same push twice (a resubscribe) is one fill.
  s.log.onExecutionReport(push({ orderId: 12, side: 'SELL', qty: 5, px: 201, fee: 0.402, tradeId: 9002, at: CLOSED_AT }), CLOSED_AT + 60);
  s.release();
  await s.syncAt(CLOSED_AT + 5 * 60_000);
  await s.syncAt(CLOSED_AT + 3 * H);
}

test('an Orderly leg: its fill fee from the session\'s pushes, its close from them, its 8 h funding booked into the pair\'s P&L', async () => {
  const s = setup();
  s.book.record(enterSol());
  await s.syncAt(T0 + 7 * H + 5 * 60_000);

  // The open's Orderly fee was not in the record: read from the session's fill (one fee event, journaled once).
  const fees = s.book.events.filter((e): e is FeeEvent => e.type === 'fee');
  assert.deepEqual(fees.map((f) => [f.venue, f.usd]), [['orderly', -0.4002]]);
  assert.equal(s.journal.filter((j) => j.kind === 'fee').length, 1);
  // Orderly's 16:00 payment under the book's symbol, standing for its 8 h period; 08:00 (before the hold) not stored.
  const orderly = s.book.events.filter((e): e is FundingEvent => e.type === 'funding' && e.venue === 'orderly');
  assert.deepEqual(orderly.map((f) => [f.symbol, f.time, f.usd, f.samples, f.size]), [['SOL', T0 + 6 * H, -0.05, 8, 5]]);

  // The close comes at 17:30; the loop lets go without a report, and the exit is booked from both venues' fills.
  s.log.onExecutionReport(push({ orderId: 12, side: 'SELL', qty: 5, px: 201, fee: 0.402, tradeId: 9002, at: CLOSED_AT }), CLOSED_AT + 50);
  s.log.onExecutionReport(push({ orderId: 12, side: 'SELL', qty: 5, px: 201, fee: 0.402, tradeId: 9002, at: CLOSED_AT }), CLOSED_AT + 60);
  s.release();
  await s.syncAt(CLOSED_AT + 5 * 60_000);
  assert.deepEqual(s.hlClose.map((q) => [q.side, q.symbol]), [['BUY', 'SOL']]);
  let p = s.book.summary().positions[0]!;
  assert.deepEqual([p.open, p.exitReason, p.fillsUnread], [false, 'closed outside the loop', false]);

  // Settled: read past the exit + 2 h. The signed read is made at 17:05 and 20:30 only: at 17:35 no funding time
  // (16:00, plus the hour it may take to post) fell after the last read.
  await s.syncAt(CLOSED_AT + 3 * H);
  assert.equal(s.fees.asked.length, 2);
  p = s.book.summary().positions[0]!;
  const hl = p.legs.find((l) => l.venue === 'hyperliquid')!;
  const ox = p.legs.find((l) => l.venue === 'orderly')!;
  close(hl.fundingUsd, 0.07, 'hyperliquid 11:00 .. 17:00');
  close(ox.fundingUsd, -0.05, 'orderly 16:00');
  assert.deepEqual([ox.payments, ox.paidHours, ox.estimatedUsd, ox.estimatedHours], [1, 8, 0, 0]);
  assert.deepEqual(ox.periodic, { periodHours: 8, due: 1, read: true });
  assert.equal(hl.periodic, undefined);
  assert.equal(ox.exitPx, 201);
  close(ox.entryFeeUsd!, -0.4002, 'orderly open fee');
  close(ox.exitFeeUsd!, -0.402, 'orderly close fee');
  // Fees: 0.4 + 0.4002 open, 0.4 + 0.402 close. Price: short 200 -> 201 = -5, long 200.1 -> 201 = +4.5.
  close(p.feesUsd, -(0.4 + 0.4002 + 0.4 + 0.402), 'fees');
  assert.equal(p.unknownFees, 0);
  close(p.priceUsd!, -0.5, 'price');
  close(p.fundingUsd, 0.02, 'funding');
  close(p.netUsd, 0.02 - 1.6022 - 0.5, 'net');
  assert.equal(p.estimatedUsd, 0, 'an Orderly payment is exact, not an estimate');
  assert.equal(p.settled, true);

  // Journal: one funding entry per hour; Orderly is never "missing" between its payments and never estimated.
  const funding = s.journal.filter((j) => j.kind === 'funding' && j.numbers.final === undefined);
  assert.equal(funding.length, 7);
  assert.ok(funding.every((j) => j.numbers.orderlyUsd !== 'missing' && j.numbers.estimated === undefined), JSON.stringify(funding.map((j) => j.numbers)));
  const at16 = funding.find((j) => j.numbers.hour === '2026-11-02T16:00Z')!;
  assert.equal(at16.summary, 'funding SOL 2026-11-02T16:00Z: hyperliquid +0.0100, orderly -0.0500 (its 8 h funding period); -0.0400 USD');
  assert.deepEqual([at16.numbers.orderlyUsd, at16.numbers.orderlyHours], [-0.05, 8]);
  const final = s.journal.find((j) => j.numbers.final === 1)!;
  assert.equal(final.numbers.estimated, undefined);

  // The report: the Orderly leg with its fee and funding like the other venues.
  const text = bookReport(s.book.summary());
  assert.match(text, /SOL {2}short hyperliquid, long orderly {2}closed/);
  assert.match(text, /legs {7}hyperliquid short 5 @ 200 -> 201; orderly long 5 @ 200\.1 -> 201/);
  assert.match(text, /funding {4}hyperliquid \+0\.0700 \(7 of 7 h paid\), orderly -0\.0500 \(1 of 1 payment\(s\) of its 8 h funding period in 7 h\); total \+0\.0200/);
  assert.match(text, /fees {7}open -0\.8002, close -0\.8020, total -1\.6022\n/);
  assert.doesNotMatch(text, /estimated/);
});

test('an Orderly payment that never came is missing on its funding time (journal and report); a never-read leg says so', async () => {
  // No 16:00 row: Orderly owes one on its funding time inside the hold.
  const s = setup({ fundingRows: [feeRow(T0 - 2 * H, 0.04, 'Pay')] });
  await closedOutside(s);
  const funding = s.journal.filter((j) => j.kind === 'funding' && j.numbers.final === undefined);
  const at16 = funding.find((j) => j.numbers.hour === '2026-11-02T16:00Z')!;
  assert.equal(at16.numbers.orderlyUsd, 'missing');
  assert.match(at16.summary, /orderly no payment/);
  assert.equal(funding.filter((j) => j.numbers.orderlyUsd === 'missing').length, 1, 'only on its funding time');
  assert.match(bookReport(s.book.summary()), /orderly \+0\.0000 \(0 of 1 payment\(s\) of its 8 h funding period in 7 h, 1 with no payment booked\)/);

  // No Orderly ledger reader at all: the leg was never read, and the report does not pretend it paid nothing.
  const u = setup({ orderlyFunding: false });
  await closedOutside(u);
  const ox = u.book.summary().positions[0]!.legs.find((l) => l.venue === 'orderly')!;
  assert.equal(ox.periodic!.read, false);
  assert.match(bookReport(u.book.summary()), /orderly \+0\.0000 \(not read\)/);
});

test('a session that went silent before a close outside the loop holds the exit (never booked as no Orderly fills); once heard, it books', async () => {
  const s = setup();
  s.book.record(enterSol());
  await s.syncAt(T0 + 7 * H + 5 * 60_000);
  // The socket dies without a close at 17:05 + 10 s: the 17:30 close's push never comes, and nothing is heard.
  s.release();
  const r = await s.syncAt(CLOSED_AT + 5 * 60_000, true);
  assert.equal(s.book.summary().positions[0]!.open, true);
  assert.ok(r.lines.some((l) => !l.ok && /orderly: .*the session was last heard/.test(l.text)), JSON.stringify(r.lines));
  // A new session comes up (a gap from 17:05 on would be marked by down/up; here the push is late, then frames again).
  s.log.onExecutionReport(push({ orderId: 12, side: 'SELL', qty: 5, px: 201, fee: 0.402, tradeId: 9002, at: CLOSED_AT }), CLOSED_AT + 6 * 60_000);
  await s.syncAt(CLOSED_AT + 10 * 60_000);
  const p = s.book.summary().positions[0]!;
  assert.deepEqual([p.open, p.exitReason, p.legs.find((l) => l.venue === 'orderly')!.exitPx], [false, 'closed outside the loop', 201]);
});

test('the Orderly fill log answers only for the time the session heard: before it, while down, after it went silent', () => {
  const log = new OrderlyFillLog(T0);
  log.onExecutionReport(push({ orderId: 1, side: 'SELL', qty: 2, px: 100, fee: 0.08, tradeId: 1, at: T0 + H }), T0 + H);
  log.onExecutionReport(push({ orderId: 1, side: 'SELL', qty: 3, px: 101, fee: 0.1212, tradeId: 2, at: T0 + H + 1 }), T0 + H + 1);
  // A status push without a fill, another market and the other side are not this close's fills.
  log.onExecutionReport({ ...push({ orderId: 2, side: 'SELL', qty: 0, px: 0, fee: 0, tradeId: 0, at: T0 + H }), status: 'CANCELLED' }, T0 + H);
  log.onExecutionReport({ ...push({ orderId: 3, side: 'SELL', qty: 1, px: 50, fee: 0.02, tradeId: 3, at: T0 + H }), symbol: 'PERP_ETH_USDC' }, T0 + H);
  log.onExecutionReport(push({ orderId: 4, side: 'BUY', qty: 1, px: 100, fee: 0.04, tradeId: 4, at: T0 + H }), T0 + H);
  log.heard(T0 + 3 * H);
  const q = { venue: 'orderly', address: ACCOUNT, symbol: 'SOL', side: 'SELL' as const, from: T0, to: T0 + 2 * H };
  const got = log.closeFills(q)!;
  assert.deepEqual([got.fill.qty, got.fill.avgPx, got.at], ['5', (2 * 100 + 3 * 101) / 5, T0 + H + 1]);
  close(got.fill.feeUsd!, 0.2012, 'fees summed');
  // Orderly's own symbol names the same market.
  assert.equal(log.closeFills({ ...q, symbol: 'PERP_SOL_USDC' })!.fill.qty, '5');
  assert.equal(log.closeFills({ ...q, from: T0 + 2 * H, to: T0 + 3 * H - ORDERLY_LATE_PUSH_MS }), null, 'heard, and nothing filled');
  assert.throws(() => log.closeFills({ ...q, from: T0 - 1 }), /known from/);

  // A socket that died without a close: nothing heard after 3:00, so a window past it is unknown, not "nothing filled".
  assert.throws(() => log.closeFills({ ...q, from: T0 + 2 * H, to: T0 + 4 * H }), /last heard/);
  assert.equal(log.fillFee({ venue: 'orderly', address: ACCOUNT, symbol: 'SOL', side: 'SELL', startedAt: T0 + 3 * H, at: T0 + 4 * H, tx: [] }), null);

  // A late push: a fill at 4:00 whose push came 4 s later. Until the session is heard past the window plus the margin
  // the window is unknown; then the fill is in it.
  const at = T0 + 4 * H;
  log.heard(at + 1_000);
  const late = { ...q, from: at - 60_000, to: at + 2_000 };
  assert.throws(() => log.closeFills(late), /last heard/);
  log.onExecutionReport(push({ orderId: 5, side: 'SELL', qty: 1, px: 102, fee: 0.0408, tradeId: 5, at }), at + 4_000);
  assert.throws(() => log.closeFills(late), /last heard/, 'still inside the late-push margin');
  log.heard(at + 2_000 + ORDERLY_LATE_PUSH_MS);
  assert.equal(log.closeFills(late)!.fill.qty, '1');

  // Down and up: the time between is unknown for good.
  log.down(T0 + 5 * H);
  log.heard(T0 + 6 * H);   // a frame from a dead session counts for nothing
  assert.throws(() => log.closeFills({ ...q, from: T0 + 5 * H - 10, to: T0 + 5 * H }), /down since/);
  log.up(T0 + 5 * H + 60_000);
  log.heard(T0 + 6 * H);
  assert.throws(() => log.closeFills({ ...q, from: T0 + 5 * H - 10, to: T0 + 5 * H + 10 }), /was down/);
  assert.equal(log.closeFills({ ...q, from: T0 + 5 * H + 60_001, to: T0 + 5 * H + 2 * 60_000 }), null);
  close(log.fillFee({ venue: 'orderly', address: ACCOUNT, symbol: 'SOL', side: 'SELL', startedAt: T0 + H - 1000, at: T0 + H + 1000, tx: [] })!, 0.2012, 'fee read');

  // A push whose own clock is a day off is placed at the time it came.
  log.onExecutionReport(push({ orderId: 6, side: 'SELL', qty: 1, px: 103, fee: 0.0412, tradeId: 6, at: 1_000 }), T0 + 6 * H);
  log.heard(T0 + 6 * H + 60_000);
  assert.equal(log.closeFills({ ...q, from: T0 + 6 * H - 1_000, to: T0 + 6 * H + 1_000 })!.fill.qty, '1');

  // Kept 48 h: older fills and gaps go; a window reaching back to the newest one dropped is unknown, a later one is not.
  log.heard(T0 + 6 * H + ORDERLY_FILL_KEEP_MS);
  assert.equal(log.since, T0, 'the session start stays');
  assert.throws(() => log.closeFills({ ...q, from: T0 + 5 * H, to: T0 + 7 * H }), /no longer kept/);
  assert.equal(log.closeFills({ ...q, from: T0 + 5 * H + 60_001, to: T0 + 7 * H })!.fill.qty, '1');
});

test('a silent session costs one hear-wait: later reads fail at once until it is heard again', async () => {
  const log = new OrderlyFillLog(T0);
  log.heard(T0 + H);
  assert.equal(await log.whenHeard(T0 + 2 * H, 20), false);
  const quick = await Promise.race([log.whenHeard(T0 + 2 * H, 10_000), new Promise<'waited'>((r) => setTimeout(() => r('waited'), 200).unref())]);
  assert.equal(quick, false);
  // Heard again: the next read waits once more, and resolves when the session is heard past its target.
  log.heard(T0 + H + 1_000);
  const back = log.whenHeard(T0 + 2 * H, 10_000);
  log.heard(T0 + 2 * H);
  assert.equal(await back, true);
});

test('a 72 h Orderly hold with no fill after its open still reads its close outside the loop', async () => {
  const s = setup();
  s.book.record(enterSol());
  await s.syncAt(T0 + 7 * H + 5 * 60_000);
  // Frames every hour for three days; the open's fill (10:19:50) is dropped after 48 h.
  for (let t = T0 + 8 * H; t <= T0 + 72 * H; t += H) s.log.heard(t);
  const closedAt = T0 + 72 * H + 30 * 60_000;
  s.log.onExecutionReport(push({ orderId: 13, side: 'SELL', qty: 5, px: 199, fee: 0.398, tradeId: 9003, at: closedAt }), closedAt + 50);
  s.release();
  const r = await s.syncAt(closedAt + 5 * 60_000);
  const p = s.book.summary().positions[0]!;
  assert.deepEqual([p.open, p.exitReason, p.fillsUnread], [false, 'closed outside the loop', false], JSON.stringify(r.lines));
  assert.equal(p.legs.find((l) => l.venue === 'orderly')!.exitPx, 199);
});

test('Orderly funding times are counted per payment interval on that payment\'s period', () => {
  const row = (time: number, samples: number) => ({ v: 1 as const, type: 'funding' as const, at: time, key: `k${time}`, venue: 'orderly', symbol: 'SOL', time, usd: -0.01, size: 1, ratePerHour: 0, samples, positionId: 'p' });
  // 4 h payments at 04:00 and 08:00, then 8 h ones at 16:00 and 00:00; held 00:30 .. 23:59 of day 0.
  const day = T0 - 10 * H;
  const rows = [row(day + 4 * H, 4), row(day + 8 * H, 4), row(day + 16 * H, 8), row(day + 24 * H, 8)];
  // (00:30, 04:00] on 4 h: 04:00; (04:00, 08:00]: 08:00; (08:00, 16:00] on 8 h: 16:00; (16:00, 23:59] on 8 h: none.
  // The shortest period everywhere would also owe 12:00 and 20:00.
  assert.deepEqual(periodicOf(rows, day + 30 * 60_000, day + 24 * H - 60_000, true), { periodHours: 8, due: 3, read: true });
  assert.equal(fundingPeriodAt(rows, day + 12 * H), 8);
  assert.equal(fundingPeriodAt(rows, day + 2 * H), 4);
  assert.equal(fundingPeriodAt([], day), 8);
});

test('without the session\'s fill log an Orderly fill read fails rather than saying nothing filled; symbols; no Orderly, as before', async () => {
  assert.deepEqual(['PERP_SOL_USDC', 'PERP_1000PEPE_USDC', 'PERP_XAU_USDC'].map(orderlyBookSymbol), ['SOL', 'kPEPE', 'GOLD']);
  const plain = liveBookSources({ network: 'mainnet', fetch: async () => { throw new Error('no network in this test'); } });
  assert.deepEqual(Object.keys(plain.funding).sort(), ['hyperliquid', 'phoenix']);
  await assert.rejects(plain.closeFills!({ venue: 'orderly', address: ACCOUNT, symbol: 'SOL', side: 'SELL', from: 0, to: 1 }), /orderly: no fill log/);
  await assert.rejects(plain.fillFee!({ venue: 'orderly', address: ACCOUNT, symbol: 'SOL', side: 'SELL', startedAt: 0, at: 1, tx: [] }), /orderly: no fill log/);

  // An HL + Orderly protection close with no log: the Orderly leg's read fails, so the exit is held, never booked flat.
  const s = setup();
  s.book.record(enterSol());
  await s.syncAt(T0 + 7 * H + 5 * 60_000);
  const noLog = liveBookSources({ network: 'mainnet', fetch: replayFetch(WIRE) });
  const sources: BookSources = {
    funding: {},
    closeFills: async (q) => (q.venue === 'orderly' ? noLog.closeFills!(q) : { fill: { venue: 'hyperliquid', side: 'BUY', qty: '5', avgPx: 201, feeUsd: 0.4 }, at: CLOSED_AT }),
  };
  const book = createBook({ dir: tempDir(dirs), ...DESK, addresses: { hyperliquid: HL_ADDRESS, orderly: ACCOUNT }, sources, clock: s.clock, log: () => {}, loopHeld: () => null });
  book.record(enterSol());
  s.clock.set(CLOSED_AT + 5 * 60_000);
  const r = await book.sync();
  assert.equal(book.summary().positions[0]!.open, true, JSON.stringify(r.lines));
  assert.ok(r.lines.some((l) => !l.ok && /orderly: no fill log/.test(l.text)), JSON.stringify(r.lines));
});

test('the signed Orderly funding read is made only when a funding time fell after the last read', async () => {
  const calls: [number, number | undefined][] = [];
  const reader = { userFunding: async (_a: string, start: number, end?: number): Promise<FundingPayment[]> => { calls.push([start, end]); return []; } };
  const f = orderlyBookFunding(reader);
  const day = T0 - 10 * H;   // 00:00 UTC
  for (const hour of [0.1, 1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 7.1, 8.1]) await f.userFunding(ACCOUNT, day - 24 * H, day + hour * H);
  // 00:06 (first), 01:06 (00:00 may still post), then 04:06 and 05:06, then 08:06.
  assert.deepEqual(calls.map(([, end]) => ((end! - day) / H).toFixed(1)), ['0.1', '1.1', '4.1', '5.1', '8.1']);
  assert.equal(f.skipped, 4);
});
