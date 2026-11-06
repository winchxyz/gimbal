// The position book, second and third rounds: writes that fail (a short write, a failed fsync, a cut that fails too:
// read only), closes made outside the strategy loop (panic_close, a rescue's reduce, an ADL unwind, one that threw, one
// with no report at all, a stale open position entered again), amounts from Hyperliquid's daily aggregates marked as
// estimated, late entries' ids and "final as of". No network.

import assert from 'node:assert/strict';
import { appendFileSync, ftruncateSync, readFileSync, rmSync, writeSync } from 'node:fs';
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
import type { BookEvent, FundingEvent } from './types.ts';
import { H, T0, XLM, enterXlm, exitXlm, fixtureSources, tempDir } from './test-helpers.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tick = () => new Promise<void>((r) => setImmediate(r));
const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
const DESK = { mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1' } as const;

interface BookAtExtra {
  sources?: ReturnType<typeof fixtureSources>;
  loopHeld?: () => { windowId: string } | null | undefined;
  closeFills?: BookSources['closeFills'];
  write?: (fd: number, text: string, position: number) => number;
  fsync?: (fd: number) => void;
  truncate?: (fd: number, size: number) => void;
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
    hooks: {
      ...(extra.write === undefined ? {} : { write: extra.write }), ...(extra.fsync === undefined ? {} : { fsync: extra.fsync }),
      ...(extra.truncate === undefined ? {} : { truncate: extra.truncate }),
    },
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
  by, reason: by, symbol: 'XLM', startedAt: at - 30_000, at, result: r, error: r === null ? 'socket closed' : null,
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

test('panic_close: both legs flat is the position\'s exit, with its fills and fees; the loop does not adopt it again', async () => {
  const s = wired(tempDir(dirs));
  s.clock.set(T0 + 4 * H);
  const before = s.book.events.length;
  s.w.protectionClose(report('panic_close', result('closed', ['0', '0'], [
    { venue: 'hyperliquid', side: 'BUY', filled: '4000', px: 0.249, fee: 0.15 },
    { venue: 'phoenix', side: 'SELL', filled: '4000', px: 0.2493, fee: 0.05 },
  ]), T0 + 4 * H));
  // Booked on the next turn: the protection's path does not wait on the book's write.
  assert.equal(s.book.events.length, before);
  await tick();
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

test('a rescue\'s reduce is a partial fill of the open position; an ADL unwind that ends flat is its exit', async () => {
  const s = wired(tempDir(dirs));
  s.clock.set(T0 + 3 * H);
  s.w.protectionClose(report('rescue reduce', result('closed', ['-3000', '3000'], [
    { venue: 'hyperliquid', side: 'BUY', filled: '1000', px: 0.2495, fee: 0.04 },
    { venue: 'phoenix', side: 'SELL', filled: '1000', px: 0.2497, fee: 0.01 },
  ]), T0 + 3 * H));
  await tick();
  let p = s.book.summary().positions[0]!;
  assert.equal(p.open, true);
  assert.equal(p.partialFills, 1);
  close(p.feesUsd, -0.25, 'the open\'s fees and the reduce\'s');
  s.clock.set(T0 + 6 * H);
  s.w.protectionClose(report('ADL unwind', result('closed', ['0', '0'], [
    { venue: 'hyperliquid', side: 'BUY', filled: '3000', px: 0.249, fee: 0.11 },
    { venue: 'phoenix', side: 'SELL', filled: '3000', px: 0.2493, fee: 0.04 },
  ]), T0 + 6 * H));
  await tick();
  p = s.book.summary().positions[0]!;
  assert.deepEqual([p.open, p.exitReason, p.exitBy], [false, 'ADL unwind', 'auto']);
  close(p.feesUsd, -0.4, 'every fill');
  // Hyperliquid +0.5 + 3.0; Phoenix -0.5 - 2.7.
  close(p.priceUsd!, 0.3, 'price over the reduce and the unwind');
  // A close that filled nothing and did not end flat (its reads failed) books nothing.
  const before = s.book.events.length;
  s.w.protectionClose(report('rescue reduce', result('stuck', [null, null], []), T0 + 7 * H));
  await tick();
  assert.equal(s.book.events.length, before);
});

/** Fake venue fills: each read sums the ones on its venue, side and window (as the real readers do); `fail` throws. */
function venueFills(
  list: { venue: string; side: 'BUY' | 'SELL'; qty: string; avgPx: number; feeUsd: number; at: number }[],
  fail: (venue: string) => string | null = () => null,
) {
  const asked: CloseFillQuery[] = [];
  const closeFills: NonNullable<BookSources['closeFills']> = async (q) => {
    asked.push(q);
    const why = fail(q.venue);
    if (why !== null) throw new Error(why);
    const mine = list.filter((f) => f.venue === q.venue && f.side === q.side && f.at >= q.from && f.at <= q.to);
    return sumFills(q.venue, q.side, mine.map((f) => ({ size: Number(f.qty), px: f.avgPx, fee: f.feeUsd, time: f.at })));
  };
  return { asked, closeFills };
}

const CLOSED_AT = T0 + 4 * H;
const closingFills = () => [
  { venue: 'hyperliquid', side: 'BUY' as const, qty: '4000', avgPx: 0.249, feeUsd: 0.15, at: CLOSED_AT },
  { venue: 'phoenix', side: 'SELL' as const, qty: '4000', avgPx: 0.2493, feeUsd: 0.05, at: CLOSED_AT + 2_000 },
];

test('a protection close that threw after a partial fill: the next sync reads its fills over its own time and books them as a fill', async () => {
  const at = T0 + 4 * H;
  let fail: string | null = 'HTTP 502';
  const v = venueFills([
    { venue: 'hyperliquid', side: 'BUY', qty: '1000', avgPx: 0.2495, feeUsd: 0.04, at: at - 20_000 },
    { venue: 'phoenix', side: 'SELL', qty: '1000', avgPx: 0.2497, feeUsd: 0.01, at: at - 10_000 },
    { venue: 'hyperliquid', side: 'BUY', qty: '50', avgPx: 0.25, feeUsd: 0.01, at: T0 + 2 * H },   // earlier: not this close's
  ], (venue) => (venue === 'phoenix' ? fail : null));
  const s = bookAt(tempDir(dirs), enterXlm().at, { loopHeld: () => ({ windowId: XLM }), closeFills: v.closeFills });
  const log: string[] = [];
  const w = loopBook(s.book, () => {}, (l) => log.push(l));
  w.sink(enterXlm());
  w.protectionClose(report('rescue reduce', null, at));
  await tick();
  assert.ok(log.some((l) => /left no result \(socket closed\); the next sync reads its fills from the venues/.test(l)), log.join('\n'));
  // The loop keeps holding the pair (the legs are not flat): the detector has nothing to do, the lookup does it.
  s.clock.set(at + 30 * 60_000);
  let r = await s.book.sync();
  assert.ok(r.lines.some((l) => !l.ok && /rescue reduce close's fills on \S+: not read \(phoenix: HTTP 502\); tried again at the next sync/.test(l.text)), JSON.stringify(r.lines));
  assert.equal(s.book.summary().positions[0]!.partialFills, 0);
  fail = null;
  s.clock.set(at + 90 * 60_000);
  r = await s.book.sync();
  assert.ok(r.lines.some((l) => /2 venue fill\(s\) booked as a partial fill/.test(l.text)), JSON.stringify(r.lines));
  assert.deepEqual([v.asked.at(-1)!.from, v.asked.at(-1)!.to], [at - 30_000 - 5_000, at + 5_000], 'its own time, with the fill slack');
  const p = s.book.summary().positions[0]!;
  assert.equal(p.open, true);
  assert.equal(p.partialFills, 1);
  close(p.feesUsd, -0.25, 'the open\'s fees and the reduce\'s');
  const fill = s.book.events.find((e) => e.type === 'fill') as Extract<BookEvent, { type: 'fill' }>;
  assert.deepEqual([fill.record.exitReason, fill.record.by, fill.record.startedAt, fill.record.at], ['rescue reduce', 'auto', at - 30_000, at - 10_000]);
  // Once: the next sync does not read it again.
  const reads = v.asked.length;
  await s.book.sync();
  assert.equal(v.asked.length, reads);
});

test('a close with no report: once the loop holds nothing, the next sync books the exit from the venues\' fills since the last record', async () => {
  let held: { windowId: string } | null | undefined = { windowId: XLM };
  const v = venueFills(closingFills());
  const s = bookAt(tempDir(dirs), enterXlm().at, { loopHeld: () => held, closeFills: v.closeFills });
  const log: string[] = [];
  const w = loopBook(s.book, () => {}, (l) => log.push(l));
  w.sink(enterXlm());
  // The loop still holds it: nothing to find.
  s.clock.set(CLOSED_AT + 30 * 60_000);
  await s.book.sync();
  assert.equal(s.book.summary().positions[0]!.open, true);
  // The loop cannot tell (no hands, or its start not confirmed): nothing either.
  held = undefined;
  await s.book.sync();
  assert.equal(s.book.summary().positions[0]!.open, true);
  assert.equal(v.asked.length, 0);
  // A panic_close that threw, and the loop then holds nothing: its lookup leaves the fills to the exit.
  w.protectionClose(report('panic_close', null, CLOSED_AT + 3_000));
  await tick();
  held = null;
  const r = await s.book.sync();
  assert.ok(r.lines.some((l) => /panic_close close's fills on \S+: the loop no longer holds it, so they go with its exit/.test(l.text)), JSON.stringify(r.lines));
  assert.ok(r.lines.some((l) => l.ok && /closed outside the loop \(the loop holds nothing\): exit booked from 2 venue fill\(s\)$/.test(l.text)), JSON.stringify(r.lines));
  assert.deepEqual(v.asked.map((q) => [q.venue, q.side, q.from]), [['hyperliquid', 'BUY', enterXlm().at + 1], ['phoenix', 'SELL', enterXlm().at + 1]]);
  const p = s.book.summary().positions[0]!;
  assert.deepEqual([p.open, p.exitReason, p.exitBy, p.exitedAt, p.fillsUnread], [false, 'closed outside the loop', 'manual', CLOSED_AT + 2_000, false]);
  close(p.priceUsd!, 0.4, 'price');
  close(p.exitFeesUsd, -0.2, 'fees');
  await s.book.sync();
  assert.equal(s.book.events.filter((e) => e.type === 'exit').length, 1, 'once');
});

test('a close found outside the loop whose fills cannot be read waits for the next sync; after 24 h it is booked as fills unread', async () => {
  // A read that fails once: the position stays open, the next sync books it as usual.
  let fail: string | null = 'HTTP 429';
  const v = venueFills(closingFills(), (venue) => (venue === 'phoenix' ? fail : null));
  const s = bookAt(tempDir(dirs), enterXlm().at, { loopHeld: () => null, closeFills: v.closeFills });
  s.book.record(enterXlm());
  s.clock.set(T0 + 5 * H);
  let r = await s.book.sync();
  assert.ok(r.lines.some((l) => !l.ok && /looks closed outside the loop, but its closing fills were not read \(phoenix: HTTP 429\); tried again at the next sync/.test(l.text)), JSON.stringify(r.lines));
  assert.equal(s.book.summary().positions[0]!.open, true);
  fail = null;
  s.clock.set(T0 + 6 * H);
  await s.book.sync();
  let p = s.book.summary().positions[0]!;
  assert.deepEqual([p.open, p.exitReason, p.fillsUnread], [false, 'closed outside the loop', false]);
  close(p.priceUsd!, 0.4, 'price');

  // Never readable: retried for 24 h, then booked with what was read, marked.
  const never = venueFills(closingFills(), (venue) => (venue === 'phoenix' ? 'HTTP 502' : null));
  const t = bookAt(tempDir(dirs), enterXlm().at, { loopHeld: () => null, closeFills: never.closeFills });
  t.book.record(enterXlm());
  for (const h of [5, 6, 28]) {
    t.clock.set(T0 + h * H);
    await t.book.sync();
    assert.equal(t.book.summary().positions[0]!.open, true, `still waiting at +${h} h`);
  }
  t.clock.set(T0 + 29 * H);
  r = await t.book.sync();
  assert.ok(r.lines.some((l) => !l.ok && /exit booked from 1 venue fill\(s\); fills unread for 24 h \(phoenix: HTTP 502\): price and close fees unknown, estimated$/.test(l.text)), JSON.stringify(r.lines));
  p = t.book.summary().positions[0]!;
  assert.deepEqual([p.open, p.exitReason, p.fillsUnread, p.priceUsd], [false, 'closed outside the loop (fills unread)', true, null]);
  assert.match(bookReport(t.book.summary()), /exit {7}closed outside the loop \(fills unread\) \(its fills were never read: price and close fees unknown, the numbers are estimated\)/);
  const fin = t.journal.find((j) => j.id.startsWith('book-settled-'))!;
  assert.deepEqual([fin.numbers.fillsUnread, fin.numbers.estimated], [1, 1]);
  assert.match(fin.summary, /the exit's fills were never read: price and close fees unknown, estimated; final as of/);
});

test('a booking that throws inside the protection\'s callback is logged, never an uncaught exception (serve survives)', async () => {
  const log: string[] = [];
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    const port = {
      record: () => ({ positionId: null, numbers: {} }), adopt: () => '', openWindow: () => null,
      recordOutside: () => {
        throw new Error('disk full');
      },
      queueCloseLookup: () => {
        throw new Error('lookup queue broken');
      },
    };
    const w = loopBook(port, () => {}, (l) => log.push(l));
    // No result: queueCloseLookup throws. A result: recordOutside throws, then queueCloseLookup too. A malformed leg size.
    w.protectionClose(report('panic_close', null, T0 + 4 * H));
    w.protectionClose(report('rescue reduce', result('closed', ['0', '0'], [
      { venue: 'hyperliquid', side: 'BUY', filled: '4000', px: 0.249, fee: 0.15 },
    ]), T0 + 4 * H));
    w.protectionClose(report('ADL unwind', result('closed', ['not a size', '0'], []), T0 + 4 * H));
    await tick();
    await tick();
    assert.deepEqual(uncaught, []);
    const failed = log.filter((l) => /close was not booked and its fills are not looked for \(lookup queue broken\)/.test(l));
    assert.equal(failed.length, 3, log.join('\n'));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

test('a close lookup never reads before the position\'s last record: fills booked with it are not counted twice', async () => {
  const at = T0 + 4 * H;
  const v = venueFills([
    { venue: 'hyperliquid', side: 'BUY', qty: '1000', avgPx: 0.2495, feeUsd: 0.04, at: at - 20_000 },
    { venue: 'phoenix', side: 'SELL', qty: '1000', avgPx: 0.2497, feeUsd: 0.01, at: at - 10_000 },
  ]);
  const s = bookAt(tempDir(dirs), enterXlm().at, { loopHeld: () => ({ windowId: XLM }), closeFills: v.closeFills });
  s.book.record(enterXlm());
  // The close's first fill was booked already (a fill record at its time); the lookup reads after it.
  s.book.record({
    kind: 'fill', windowId: XLM, symbol: 'XLM', at: at - 20_000, legs: [{ venue: 'hyperliquid', side: 'BUY', qty: '1000', avgPx: 0.2495, feeUsd: 0.04 }],
    feeUsd: 0.04, tx: [], forecastNetAprPct: 20, exitReason: 'rescue reduce', rotation: null, by: 'auto', marginMoves: [],
  });
  s.book.queueCloseLookup({ reason: 'rescue reduce', by: 'auto', startedAt: at - 30_000, at, symbol: 'XLM' });
  s.clock.set(at + 30 * 60_000);
  await s.book.sync();
  assert.equal(v.asked[0]!.from, at - 20_000 + 1);
  const p = s.book.summary().positions[0]!;
  assert.equal(p.partialFills, 2);
  close(p.feesUsd, -0.25, 'each fill once');
});

test('the detector checks the position again after its reads: a close booked meanwhile is not booked twice', async () => {
  let book: PositionBook | null = null;
  const closeFills: NonNullable<BookSources['closeFills']> = async (q) => {
    // A protection's report lands while the venues are read.
    if (q.venue === 'hyperliquid') {
      book!.recordOutside({ reason: 'panic_close', by: 'manual', startedAt: CLOSED_AT - 5_000, at: CLOSED_AT, fills: [], feeUsd: 0, tx: [], flat: true, symbol: 'XLM' });
    }
    return null;
  };
  const s = bookAt(tempDir(dirs), enterXlm().at, { loopHeld: () => null, closeFills });
  book = s.book;
  s.book.record(enterXlm());
  s.clock.set(T0 + 5 * H);
  await s.book.sync();
  assert.equal(s.book.events.filter((e) => e.type === 'exit').length, 1);
  assert.equal(s.book.summary().positions[0]!.exitReason, 'panic_close');
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

// ---- round three: a store that cannot cut back, a stale open position ----

test('a short write whose cut fails too: the book goes read only until restart, journals one error, and a restart repairs it', async () => {
  const dir = tempDir(dirs);
  let broken = false;
  const s = bookAt(dir, enterXlm().at, {
    write: (fd, text, position) => writeSync(fd, broken ? text.slice(0, 10) : text, position),
    truncate: (fd, size) => {
      if (broken) throw new Error('EIO: truncate failed');
      ftruncateSync(fd, size);
    },
  });
  s.book.record(enterXlm());
  const xlm = (symbol: string) => symbol === 'XLM';
  assert.ok(Math.abs(s.book.openLegFees('hyperliquid', 'short', xlm)!.usd + 0.15) < 1e-9, 'the open position lends its fees');
  broken = true;
  s.clock.set(exitXlm().at);
  assert.throws(() => s.book.record(exitXlm()), /short write: 10 of \d+ bytes.*cutting it back failed too \(EIO: truncate failed\): the book is read only until restart/);
  assert.match(s.book.readOnly() ?? '', /^short write/);
  // The exit that failed to write may have closed it: memory still holds XLM open, so no leg takes fees from it.
  assert.equal(s.book.openLegFees('hyperliquid', 'short', xlm), null, 'read only: no open-leg fees');
  broken = false;
  assert.throws(() => s.book.record(exitXlm()), /the book is read only until restart/);
  const errors = s.journal.filter((j) => j.kind === 'error');
  assert.equal(errors.length, 1, 'journaled once');
  assert.match(errors[0]!.summary, /^position book read only until serve restarts: short write/);
  assert.ok(s.log.some((l) => /book: READ ONLY until restart/.test(l)), s.log.join('\n'));
  const r = await s.book.sync();
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0]!.text, /^read only until restart .*: nothing synced$/);
  // A restart: load cuts the torn bytes, and the book writes again.
  const log: string[] = [];
  const again = new PositionBook({ dir, ...DESK, clock: s.clock, log: (l) => log.push(l) });
  assert.equal(again.readOnly(), null);
  assert.ok(log.some((l) => /torn last line \(10 bytes/.test(l)), log.join('\n'));
  again.record(exitXlm());
  assert.equal(again.summary().positions[0]!.open, false);
});

test('an entry into a window the book still holds open closes that stale position first, as closed outside the loop', () => {
  const s = bookAt(tempDir(dirs), enterXlm().at);
  s.book.record(enterXlm());
  s.clock.set(T0 + 6 * H);
  s.book.record({ ...enterXlm(), at: T0 + 6 * H, startedAt: T0 + 6 * H - 60_000, by: 'manual', marginMoves: [] });
  const [stale, fresh] = s.book.summary().positions;
  assert.deepEqual(
    [stale!.open, stale!.exitReason, stale!.exitBy, stale!.exitedAt, stale!.fillsUnread],
    [false, 'closed outside the loop (fills unread)', 'manual', T0 + 6 * H - 60_001, true],
  );
  assert.equal(fresh!.open, true);
  assert.notEqual(stale!.id, fresh!.id);
  assert.ok(s.log.some((l) => /was still open when \S+ was entered again: closed outside the loop first/.test(l)), s.log.join('\n'));
});
