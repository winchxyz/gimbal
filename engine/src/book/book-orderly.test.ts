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
import { createBook } from './book.ts';
import { OrderlyFillLog, orderlyBookSymbol } from './orderly.ts';
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

function setup() {
  const log = new OrderlyFillLog(T0);
  // The open's Orderly fill (4 bps of 5 x 200.1), then the close nobody reported: sold 5 at 201 (4 bps of 1005).
  log.onExecutionReport(push({ orderId: 11, side: 'BUY', qty: 5, px: 200.1, fee: 0.4002, tradeId: 9001, at: ENTER_AT - 10_000 }), ENTER_AT - 9_950);
  log.onExecutionReport(push({ orderId: 12, side: 'SELL', qty: 5, px: 201, fee: 0.402, tradeId: 9002, at: CLOSED_AT }), CLOSED_AT + 50);
  // The same push twice (a resubscribe) is one fill.
  log.onExecutionReport(push({ orderId: 12, side: 'SELL', qty: 5, px: 201, fee: 0.402, tradeId: 9002, at: CLOSED_AT }), CLOSED_AT + 60);
  // Orderly pays at 16:00 UTC (its 8 h period): the long pays 0.05 on a positive rate. 08:00 and 00:00 are outside the hold.
  const fees = feeHistory([feeRow(T0 - 2 * H, 0.04, 'Pay'), feeRow(T0 + 6 * H, 0.05, 'Pay'), feeRow(T0 + 14 * H, 0.03, 'Pay')]);
  const live = liveBookSources({ network: 'mainnet', fetch: replayFetch(WIRE), orderly: { fundingFees: fees, fills: log } });
  const hl = new FixtureLedger(hlRows().map(parseFundingRow));
  const hlClose: CloseFillQuery[] = [];
  const sources: BookSources = {
    funding: { hyperliquid: hl, orderly: live.funding.orderly! },
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
  return { book, clock, journal, fees, log, hlClose, release: () => { held = null; } };
}

test('an Orderly leg: its fill fee from the session\'s pushes, its close from them, its 8 h funding booked into the pair\'s P&L', async () => {
  const s = setup();
  s.book.record(enterSol());
  s.clock.set(T0 + 7 * H + 5 * 60_000);
  await s.book.sync();

  // The open's Orderly fee was not in the record: read from the session's fill (one fee event, journaled once).
  const fees = s.book.events.filter((e): e is FeeEvent => e.type === 'fee');
  assert.deepEqual(fees.map((f) => [f.venue, f.usd]), [['orderly', -0.4002]]);
  assert.equal(s.journal.filter((j) => j.kind === 'fee').length, 1);
  // Orderly's 16:00 payment under the book's symbol, standing for its 8 h period; 08:00 (before the hold) not stored.
  const orderly = s.book.events.filter((e): e is FundingEvent => e.type === 'funding' && e.venue === 'orderly');
  assert.deepEqual(orderly.map((f) => [f.symbol, f.time, f.usd, f.samples, f.size]), [['SOL', T0 + 6 * H, -0.05, 8, 5]]);

  // The loop lets go at 17:35 without a report: the exit is booked from both venues' fills since the open.
  s.release();
  s.clock.set(CLOSED_AT + 5 * 60_000);
  await s.book.sync();
  assert.deepEqual(s.hlClose.map((q) => [q.side, q.symbol]), [['BUY', 'SOL']]);
  let p = s.book.summary().positions[0]!;
  assert.deepEqual([p.open, p.exitReason, p.fillsUnread], [false, 'closed outside the loop', false]);

  // Settled: read past the exit + 2 h.
  s.clock.set(CLOSED_AT + 3 * H);
  await s.book.sync();
  p = s.book.summary().positions[0]!;
  const hl = p.legs.find((l) => l.venue === 'hyperliquid')!;
  const ox = p.legs.find((l) => l.venue === 'orderly')!;
  close(hl.fundingUsd, 0.07, 'hyperliquid 11:00 .. 17:00');
  close(ox.fundingUsd, -0.05, 'orderly 16:00');
  assert.deepEqual([ox.payments, ox.paidHours, ox.estimatedUsd, ox.estimatedHours], [1, 8, 0, 0]);
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
  assert.match(text, /funding {4}hyperliquid \+0\.0700 \(7 of 7 h paid\), orderly -0\.0500 \(1 payment\(s\), one per 8 h funding period, in 7 h\); total \+0\.0200/);
  assert.match(text, /fees {7}open -0\.8002, close -0\.8020, total -1\.6022\n/);
  assert.doesNotMatch(text, /estimated/);
});

test('the Orderly fill log answers only for the time the session heard: before it, or while it was down, the read fails', () => {
  const log = new OrderlyFillLog(T0);
  log.onExecutionReport(push({ orderId: 1, side: 'SELL', qty: 2, px: 100, fee: 0.08, tradeId: 1, at: T0 + H }), T0 + H);
  log.onExecutionReport(push({ orderId: 1, side: 'SELL', qty: 3, px: 101, fee: 0.1212, tradeId: 2, at: T0 + H + 1 }), T0 + H + 1);
  // A status push without a fill, another market and the other side are not this close's fills.
  log.onExecutionReport({ ...push({ orderId: 2, side: 'SELL', qty: 0, px: 0, fee: 0, tradeId: 0, at: T0 + H }), status: 'CANCELLED' }, T0 + H);
  log.onExecutionReport({ ...push({ orderId: 3, side: 'SELL', qty: 1, px: 50, fee: 0.02, tradeId: 3, at: T0 + H }), symbol: 'PERP_ETH_USDC' }, T0 + H);
  log.onExecutionReport(push({ orderId: 4, side: 'BUY', qty: 1, px: 100, fee: 0.04, tradeId: 4, at: T0 + H }), T0 + H);
  const q = { venue: 'orderly', address: ACCOUNT, symbol: 'SOL', side: 'SELL' as const, from: T0, to: T0 + 2 * H };
  const got = log.closeFills(q)!;
  assert.deepEqual([got.fill.qty, got.fill.avgPx, got.at], ['5', (2 * 100 + 3 * 101) / 5, T0 + H + 1]);
  close(got.fill.feeUsd!, 0.2012, 'fees summed');
  // Orderly's own symbol names the same market.
  assert.equal(log.closeFills({ ...q, symbol: 'PERP_SOL_USDC' })!.fill.qty, '5');
  assert.equal(log.closeFills({ ...q, from: T0 + 2 * H, to: T0 + 3 * H }), null, 'heard, and nothing filled');
  assert.throws(() => log.closeFills({ ...q, from: T0 - 1 }), /known from/);
  log.down(T0 + 2 * H);
  assert.throws(() => log.closeFills({ ...q, from: T0 + 2 * H, to: T0 + 3 * H }), /down since/);
  log.up(T0 + 2 * H + 60_000);
  assert.throws(() => log.closeFills({ ...q, from: T0 + 2 * H - 10, to: T0 + 3 * H }), /was down/);
  assert.equal(log.closeFills({ ...q, from: T0 + 2 * H + 60_001, to: T0 + 3 * H }), null);
  // A fee read cannot tell what it did not hear: null, never 0.
  assert.equal(log.fillFee({ venue: 'orderly', address: ACCOUNT, symbol: 'SOL', side: 'SELL', startedAt: T0 + 2 * H, at: T0 + 2 * H + 1, tx: [] }), null);
  close(log.fillFee({ venue: 'orderly', address: ACCOUNT, symbol: 'SOL', side: 'SELL', startedAt: T0 + H - 1000, at: T0 + H + 1000, tx: [] })!, 0.2012, 'fee read');
});

test('book symbols for Orderly markets; without Orderly reads the live sources are what they were', async () => {
  assert.deepEqual(['PERP_SOL_USDC', 'PERP_1000PEPE_USDC', 'PERP_XAU_USDC'].map(orderlyBookSymbol), ['SOL', 'kPEPE', 'GOLD']);
  const plain = liveBookSources({ network: 'mainnet', fetch: async () => { throw new Error('no network in this test'); } });
  assert.deepEqual(Object.keys(plain.funding).sort(), ['hyperliquid', 'phoenix']);
  assert.equal(await plain.closeFills!({ venue: 'orderly', address: ACCOUNT, symbol: 'SOL', side: 'SELL', from: 0, to: 1 }), null);
  assert.equal(await plain.fillFee!({ venue: 'orderly', address: ACCOUNT, symbol: 'SOL', side: 'SELL', startedAt: 0, at: 1, tx: [] }), null);
});
