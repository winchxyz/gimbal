// The position book, second round: writes that fail (a short write, a failed fsync, a copy that could not be cut
// back), closes made outside the strategy loop (panic_close, a rescue's reduce, an ADL unwind, and one with no
// result), amounts from Hyperliquid's daily aggregates marked as estimated, late entries' ids and "final as of".
// No network.

import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { after, test } from 'node:test';
import type { JournalEntry } from '@gimbal/shared';
import { loopBook } from '../cli/serve-loop.ts';
import type { LoopHeld } from '../strategy/loop.ts';
import type { PairResult } from '../trade/pair.ts';
import type { ProtectionCloseReport } from '../trade/protected-pair.ts';
import { parseFundingRow } from '../venues/hyperliquid.ts';
import { VirtualClock } from '../venues/replay.ts';
import type { FundingPayment } from '../venues/venue.ts';
import { PositionBook, createBook } from './book.ts';
import { bookReport } from './report.ts';
import { phoenixCloseFills, sumFills } from './sources.ts';
import { BookStore } from './store.ts';
import type { BookSources, CloseFillQuery } from './sync.ts';
import type { FundingEvent } from './types.ts';
import { H, T0, XLM, enterXlm, exitXlm, fixtureSources, tempDir } from './test-helpers.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
const DESK = { mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1' } as const;

interface BookAtExtra {
  sources?: ReturnType<typeof fixtureSources>;
  loopHeld?: () => { windowId: string } | null | undefined;
  closeFills?: BookSources['closeFills'];
  write?: (fd: number, text: string, position: number) => number;
  fsync?: (fd: number) => void;
}

function bookAt(dir: string, at: number, extra: BookAtExtra = {}) {
  const src = extra.sources ?? fixtureSources();
  const clock = new VirtualClock(at);
  const journal: JournalEntry[] = [];
  const log: string[] = [];
  const book = createBook({
    dir, ...DESK, addresses: src.addresses,
    sources: { ...src.sources, ...(extra.closeFills === undefined ? {} : { closeFills: extra.closeFills }) },
    clock, publish: (e) => journal.push(e), log: (l) => log.push(l),
    ...(extra.loopHeld === undefined ? {} : { loopHeld: extra.loopHeld }),
    hooks: { ...(extra.write === undefined ? {} : { write: extra.write }), ...(extra.fsync === undefined ? {} : { fsync: extra.fsync }) },
  });
  return { book, clock, journal, log, sources: src };
}

// ---- store write errors ----

test('a short write (a full disk) is cut back off the file and thrown: the next append starts on a whole line', () => {
  const dir = tempDir(dirs);
  let short = false;
  const s = bookAt(dir, enterXlm().at, {
    write: (fd, text, position) => writeSync(fd, short ? text.slice(0, Math.floor(text.length / 2)) : text, position),
  });
  s.book.record(enterXlm());
  const before = readFileSync(s.book.path, 'utf8');
  const events = s.book.events.length;
  short = true;
  s.clock.set(exitXlm().at);
  assert.throws(() => s.book.record(exitXlm()), /short write: \d+ of \d+ bytes/);
  assert.equal(readFileSync(s.book.path, 'utf8'), before, 'the torn half is gone');
  assert.equal(s.book.events.length, events, 'memory did not move');
  short = false;
  s.book.record(exitXlm());
  const loaded = new BookStore(s.book.path);
  assert.equal(loaded.load().filter((e) => e.type === 'exit').length, 1);
  assert.equal(loaded.repaired, null, 'nothing to repair: the file is whole');
});

test('a failed fsync is cut back too: the funding of the read that failed is stored once, by the next sync', async () => {
  const dir = tempDir(dirs);
  let failSync = false;
  const s = bookAt(dir, enterXlm().at, {
    fsync: () => {
      if (failSync) {
        failSync = false;
        throw new Error('EIO: fsync failed');
      }
    },
  });
  s.book.record(enterXlm());
  s.clock.set(T0 + 3 * H + 6 * 60_000);
  failSync = true;
  const r = await s.book.sync();
  assert.ok(r.lines.some((l) => !l.ok && /EIO/.test(l.text)), JSON.stringify(r.lines));
  const onDisk = () => new BookStore(s.book.path).load().filter((e): e is FundingEvent => e.type === 'funding');
  const first = onDisk().length;
  await s.book.sync();
  const keys = onDisk().map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, 'each payment once');
  assert.ok(keys.length > first, 'the failed read is stored now');
  assert.ok(keys.some((k) => k.startsWith('hyperliquid')) && keys.some((k) => k.startsWith('phoenix')), keys.join(' '));
  // A restart reads the same: nothing counted twice.
  const again = new PositionBook({ dir, ...DESK, clock: s.clock });
  close(again.summary().positions[0]!.fundingUsd, s.book.summary().positions[0]!.fundingUsd, 'the same after a restart');
});

test('load keeps the first copy of an event written twice (a cut that failed) and says so', () => {
  const dir = tempDir(dirs);
  const s = bookAt(dir, enterXlm().at);
  s.book.record(enterXlm());
  s.clock.set(exitXlm().at);
  s.book.record(exitXlm());
  const lines = readFileSync(s.book.path, 'utf8').split('\n').filter((l) => l !== '');
  const twice = lines.filter((l) => /"type":"(exit|enter)"/.test(l));
  assert.equal(twice.length, 2);
  appendFileSync(s.book.path, `${twice.join('\n')}\n`);
  const log: string[] = [];
  const book = new PositionBook({ dir, ...DESK, clock: s.clock, log: (l) => log.push(l) });
  assert.equal(book.events.length, s.book.events.length);
  assert.ok(log.some((l) => /dropped 2 event\(s\) written twice/.test(l)), log.join('\n'));
  assert.equal(book.summary().positions.length, 1);
  assert.equal(book.summary().positions[0]!.open, false);
  const reader = new BookStore(s.book.path);
  reader.load({ repair: false });
  assert.match(reader.repaired!, /dropped 2 event\(s\) written twice/);
});

// ---- closes outside the loop ----

type Fill = { venue: 'hyperliquid' | 'phoenix'; side: 'BUY' | 'SELL'; filled: string; px: number; fee: number };

function result(status: PairResult['status'], final: [string | null, string | null], fills: Fill[]): PairResult {
  const legOf = (venue: 'hyperliquid' | 'phoenix', i: 0 | 1) => ({
    venue, symbol: 'XLM', start: i === 0 ? '-4000' : '4000', target: '0', final: final[i]!,
    orders: fills.filter((f) => f.venue === venue).map((f, n) => ({
      ref: { venue, side: f.side, size: f.filled, reduceOnly: true, orderId: `o${n}`, clientId: null, tx: [], sentAt: 0 },
      outcome: 'filled' as const, filled: f.filled, avgPx: f.px, fee: f.fee, error: null, purpose: 'close' as const,
    })),
  });
  return {
    status, size: '4000', legs: [legOf('hyperliquid', 0), legOf('phoenix', 1)], notes: [],
    tx: [{ chain: 'hyperliquid', id: '0xclose', url: 'https://example.invalid/tx' }],
    feeUsd: fills.reduce((a, f) => a + f.fee, 0), feeUnknown: 0,
  } as PairResult;
}

const report = (by: ProtectionCloseReport['by'], r: PairResult | null, at: number): ProtectionCloseReport => ({
  by, reason: by, startedAt: at - 30_000, at, result: r, error: r === null ? 'socket closed' : null,
});

function wired(dir: string) {
  const s = bookAt(dir, enterXlm().at);
  const log: string[] = [];
  let held: LoopHeld | null = null;
  const w = loopBook(s.book, () => {}, (l) => log.push(l), () => held);
  w.sink(enterXlm());
  held = { windowId: XLM, symbol: 'XLM', since: enterXlm().at, legUsd: 1000, entryNetAprPct: 20 };
  return { ...s, w, log, held: () => held };
}

test('panic_close: both legs flat is the position\'s exit, with its fills and fees; the loop does not adopt it again', () => {
  const s = wired(tempDir(dirs));
  s.clock.set(T0 + 4 * H);
  s.w.protectionClose(report('panic_close', result('closed', ['0', '0'], [
    { venue: 'hyperliquid', side: 'BUY', filled: '4000', px: 0.249, fee: 0.15 },
    { venue: 'phoenix', side: 'SELL', filled: '4000', px: 0.2493, fee: 0.05 },
  ]), T0 + 4 * H));
  const p = s.book.summary().positions[0]!;
  assert.deepEqual([p.open, p.exitReason, p.exitBy, p.exitedAt], [false, 'panic_close', 'manual', T0 + 4 * H]);
  close(p.exitFeesUsd, -0.2, 'close fees');
  // Hyperliquid short 0.25 -> 0.249: +4; Phoenix long 0.2502 -> 0.2493: -3.6.
  close(p.priceUsd!, 0.4, 'price over the panic fills');
  assert.deepEqual(p.exitTx.map((t) => t.id), ['0xclose']);
  // The loop still says it holds XLM until its next check: not booked as a new position.
  s.w.adopt(s.held());
  assert.equal(s.book.summary().positions.length, 1);
  assert.ok(!s.log.some((l) => /adopted/.test(l)), s.log.join('\n'));
});

test('a rescue\'s reduce is a partial fill of the open position; an ADL unwind that ends flat is its exit', () => {
  const s = wired(tempDir(dirs));
  s.clock.set(T0 + 3 * H);
  s.w.protectionClose(report('rescue reduce', result('closed', ['-3000', '3000'], [
    { venue: 'hyperliquid', side: 'BUY', filled: '1000', px: 0.2495, fee: 0.04 },
    { venue: 'phoenix', side: 'SELL', filled: '1000', px: 0.2497, fee: 0.01 },
  ]), T0 + 3 * H));
  let p = s.book.summary().positions[0]!;
  assert.equal(p.open, true);
  assert.equal(p.partialFills, 1);
  close(p.feesUsd, -0.25, 'the open\'s fees and the reduce\'s');
  s.clock.set(T0 + 6 * H);
  s.w.protectionClose(report('ADL unwind', result('closed', ['0', '0'], [
    { venue: 'hyperliquid', side: 'BUY', filled: '3000', px: 0.249, fee: 0.11 },
    { venue: 'phoenix', side: 'SELL', filled: '3000', px: 0.2493, fee: 0.04 },
  ]), T0 + 6 * H));
  p = s.book.summary().positions[0]!;
  assert.deepEqual([p.open, p.exitReason, p.exitBy], [false, 'ADL unwind', 'auto']);
  close(p.feesUsd, -0.4, 'every fill');
  // Hyperliquid +0.5 + 3.0; Phoenix -0.5 - 2.7.
  close(p.priceUsd!, 0.3, 'price over the reduce and the unwind');
  // A close that filled nothing and did not end flat (its reads failed) books nothing.
  const before = s.book.events.length;
  s.w.protectionClose(report('rescue reduce', result('stuck', [null, null], []), T0 + 7 * H));
  assert.equal(s.book.events.length, before);
});

test('a protection close with no result is found at the next sync: the loop holds nothing, the venues\' fills close it', async () => {
  const dir = tempDir(dirs);
  let held: { windowId: string } | null | undefined = { windowId: XLM };
  const asked: CloseFillQuery[] = [];
  const s = bookAt(dir, enterXlm().at, {
    loopHeld: () => held,
    closeFills: async (q) => {
      asked.push(q);
      return q.venue === 'hyperliquid'
        ? { fill: { venue: 'hyperliquid', side: 'BUY', qty: '4000', avgPx: 0.249, feeUsd: 0.15 }, at: T0 + 4 * H }
        : { fill: { venue: 'phoenix', side: 'SELL', qty: '4000', avgPx: 0.2493, feeUsd: 0.05 }, at: T0 + 4 * H + 2_000 };
    },
  });
  const log: string[] = [];
  const w = loopBook(s.book, () => {}, (l) => log.push(l));
  w.sink(enterXlm());
  w.protectionClose(report('panic_close', null, T0 + 4 * H));
  assert.ok(log.some((l) => /left no result \(socket closed\); the next sync looks for it/.test(l)), log.join('\n'));
  assert.equal(s.book.summary().positions[0]!.open, true);
  // The loop still holds it: nothing to find.
  s.clock.set(T0 + 4 * H + 30 * 60_000);
  await s.book.sync();
  assert.equal(s.book.summary().positions[0]!.open, true);
  // The loop cannot tell (no hands): nothing either.
  held = undefined;
  await s.book.sync();
  assert.equal(s.book.summary().positions[0]!.open, true);
  assert.equal(asked.length, 0);
  // The loop holds nothing now: the exit is booked from the venues' closing fills since the entry.
  held = null;
  const r = await s.book.sync();
  assert.ok(r.lines.some((l) => /closed outside the loop/.test(l.text)), JSON.stringify(r.lines));
  assert.deepEqual(asked.map((q) => [q.venue, q.side, q.from]), [['hyperliquid', 'BUY', enterXlm().at], ['phoenix', 'SELL', enterXlm().at]]);
  const p = s.book.summary().positions[0]!;
  assert.deepEqual([p.open, p.exitReason, p.exitBy, p.exitedAt], [false, 'closed outside the loop', 'manual', T0 + 4 * H + 2_000]);
  close(p.priceUsd!, 0.4, 'price');
  close(p.exitFeesUsd, -0.2, 'fees');
  await s.book.sync();
  assert.equal(s.book.events.filter((e) => e.type === 'exit').length, 1, 'once');
});

test('closing fills from the venues are summed per side and window (Phoenix trades-history by time and sign)', async () => {
  const hl = sumFills('hyperliquid', 'BUY', [
    { size: 1000, px: 0.25, fee: 0.04, time: 5 }, { size: 3000, px: 0.249, fee: 0.11, time: 9 },
  ])!;
  assert.deepEqual([hl.fill.venue, hl.fill.side, hl.fill.qty, hl.at], ['hyperliquid', 'BUY', '4000', 9]);
  close(hl.fill.avgPx!, (250 + 747) / 4000, 'price');
  close(hl.fill.feeUsd!, 0.15, 'fees');
  assert.equal(sumFills('hyperliquid', 'BUY', []), null);
  const rows = [
    { marketSymbol: 'XLM', baseLotsDelta: '-1000', price: '0.2493', fees: '0.02', timestamp: '2026-11-02T14:00:00Z' },
    { marketSymbol: 'XLM', baseLotsDelta: '-3000', price: '0.2490', fees: '0.03', timestamp: '2026-11-02T14:00:05Z' },
    { marketSymbol: 'XLM', baseLotsDelta: '500', price: '0.2500', fees: '0.01', timestamp: '2026-11-02T14:00:06Z' },   // a buy
    { marketSymbol: 'SOL', baseLotsDelta: '-2', price: '200', fees: '0.01', timestamp: '2026-11-02T14:00:07Z' },      // another market
    { marketSymbol: 'XLM', baseLotsDelta: '-9', price: '0.24', fees: '0.01', timestamp: '2026-11-01T14:00:00Z' },     // before the window
  ];
  const api = { tradesHistory: async () => ({ data: rows }) } as unknown as Parameters<typeof phoenixCloseFills>[0];
  const got = (await phoenixCloseFills(api, { venue: 'phoenix', address: 'PhoenixAuthorityPLACEHOLDER', symbol: 'XLM', side: 'SELL', from: T0, to: T0 + 5 * H }))!;
  assert.equal(got.fill.qty, '4000');
  close(got.fill.avgPx!, (1000 * 0.2493 + 3000 * 0.249) / 4000, 'price');
  close(got.fill.feeUsd!, 0.05, 'fees');
  assert.equal(got.at, Date.parse('2026-11-02T14:00:05Z'));
});

// ---- aggregates, late entries, final as of ----

test('amounts from a Hyperliquid daily aggregate are marked estimated in the funding entry, the final entry and the report', async () => {
  // The shape of a real aggregate row (seen in a public mainnet answer): 00:00:00 UTC, nSamples 24, the hourly fields.
  const day = Date.UTC(2026, 10, 3);
  const agg = parseFundingRow({
    time: day, hash: `0x${'0'.repeat(64)}`,
    delta: { type: 'funding', coin: 'XLM', usdc: '2.4', szi: '-4000.0', fundingRate: '0.0000102254', nSamples: 24 },
  });
  assert.equal(agg.samples, 24);
  const src = fixtureSources();
  const row = (time: number, usd: number): FundingPayment => ({ time, symbol: 'XLM', fundingUsd: usd, size: -4000, ratePerHour: 0.00001, samples: null });
  src.hl.rows = [row(day + 1 * H + 65, 0.1), row(day + 2 * H + 65, 0.1), agg];
  const s = bookAt(tempDir(dirs), enterXlm().at, { sources: src });
  s.book.record(enterXlm());
  s.clock.set(day + 4 * H);
  await s.book.sync();
  const hl = s.book.summary().positions[0]!.legs.find((l) => l.venue === 'hyperliquid')!;
  close(hl.estimatedUsd, (2.4 * 22) / 24, 'the aggregate for the 22 hours the hourly rows do not cover');
  assert.equal(hl.estimatedHours, 22);
  const entry = s.journal.find((j) => j.kind === 'funding' && j.numbers.hour === '2026-11-03T00:00Z')!;
  assert.equal(entry.numbers.estimated, 1);
  assert.match(entry.summary, /22 h aggregated, estimated/);
  const hourly = s.journal.find((j) => j.kind === 'funding' && j.numbers.hour === '2026-11-03T01:00Z')!;
  assert.equal(hourly.numbers.estimated, undefined);
  assert.match(bookReport(s.book.summary()), /22 h \+2\.2000 estimated from daily aggregates/);
  // Closed and settled: the final entry says how much of it is an estimate.
  s.clock.set(day + 5 * H);
  s.book.record({ ...exitXlm(), at: day + 5 * H, rotation: null, exitReason: 'strategy: test' });
  s.clock.set(day + 8 * H);
  await s.book.sync();
  const fin = s.journal.find((j) => j.id.startsWith('book-settled-'))!;
  assert.equal(fin.numbers.estimated, 1);
  assert.match(fin.summary, /\(\+2\.2000 of the funding estimated from daily aggregates\); final as of 08:00$/);
});

test('late entries: an adjustment names its adjN in the id; a booking after the final entry is an adjustment against it', async () => {
  const src = fixtureSources();
  assert.equal(src.phoenix.rows.some((r) => r.symbol === 'XLM' && r.time === T0 + 5 * H), false, 'the fixture has no Phoenix 15:00');
  const s = bookAt(tempDir(dirs), enterXlm().at, { sources: src });
  s.book.record(enterXlm());
  s.clock.set(T0 + 3 * H + 6 * 60_000);
  await s.book.sync();
  // A second row for 12:00 shows up (another subaccount's share): its late entry is adjustment 1 of that hour.
  const noon = src.phoenix.rows.find((r) => r.symbol === 'XLM' && r.time === T0 + 2 * H)!;
  src.phoenix.rows.push({ ...noon, fundingUsd: -0.005, size: 1000 });
  s.clock.set(T0 + 4 * H + 6 * 60_000);
  await s.book.sync();
  const adj = s.journal.filter((j) => j.numbers.late === 1);
  assert.equal(adj.length, 1);
  assert.match(adj[0]!.id, /-late-\d+-adj1$/);
  // Exit, settle: the final entry and the report say when.
  s.clock.set(exitXlm().at);
  s.book.record(exitXlm());
  s.clock.set(T0 + 12 * H + 25 * 60_000);
  await s.book.sync();
  const fin = s.journal.filter((j) => j.id.startsWith('book-settled-'));
  assert.equal(fin.length, 1);
  assert.match(fin[0]!.summary, /; final as of 22:25$/);
  assert.match(bookReport(s.book.summary()), / {2}settled {4}yes: final as of 2026-11-02 22:25 UTC\n/);
  // Phoenix books 15:00 after the final entry: a late entry against it, and the report shows it.
  src.phoenix.rows.push({ ...noon, time: T0 + 5 * H, fundingUsd: -0.01, size: 4000 });
  s.clock.set(T0 + 13 * H + 6 * 60_000);
  await s.book.sync();
  const late = s.journal.filter((j) => j.numbers.afterFinal === 1);
  assert.equal(late.length, 1);
  assert.match(late[0]!.summary, /booked late, after the final entry of \S+: an adjustment to it/);
  const p = s.book.summary().positions[0]!;
  close(p.afterFinalUsd, -0.01, 'after the final');
  assert.match(bookReport(s.book.summary()), /final as of 2026-11-02 22:25 UTC; booked late after it: -0\.0100 \(an adjustment to the final, in the numbers here\)/);
  assert.equal(s.journal.filter((j) => j.id.startsWith('book-settled-')).length, 1, 'still one final entry');
});
