// The position book: records, ledger sync (dedupe, windows, rotation, negative and missing funding), fees, partial
// fills, transfers, journal entries (the settle flow), the append-only store and the report. No network: the ledgers
// are the synthetic fixture in the venues' wire shapes (test-helpers.ts), and one test runs the real HyperliquidReader
// over a replayed wire line.

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { JournalEntry, StreamEvent } from '@gimbal/shared';
import { VirtualClock, replayFetch } from '../venues/replay.ts';
import { HL_MAINNET_INFO_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import type { WireLine } from '../venues/recorder.ts';
import type { FundingPayment } from '../venues/venue.ts';
import { loopBook } from '../cli/serve-loop.ts';
import { PositionBook, createBook, nextSyncAt } from './book.ts';
import { HOUR_MS, positionIdOf, summarize } from './derive.ts';
import { bookReport } from './report.ts';
import { hlFillFee, hlNonFundingLedger } from './sources.ts';
import { BookStore, bookFile } from './store.ts';
import { OVERLAP_MS, READ_AFTER_EXIT_MS, fundingKey, fundingWindow } from './sync.ts';
import type { BookRecord, FeeEvent, FundingEvent, SyncEvent, TransferEvent } from './types.ts';
import { H, SOL, T0, XLM, enterSol, enterXlm, exitXlm, fixtureSources, ledgerFixture, tempDir } from './test-helpers.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
const tick = () => new Promise<void>((r) => setImmediate(r));
const DESK = { mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1' } as const;

function bookAt(dir: string, at: number, sources = fixtureSources(), publish?: (e: JournalEntry) => void) {
  const clock = new VirtualClock(at);
  const journal: JournalEntry[] = [];
  const log: string[] = [];
  const book = createBook({
    dir, ...DESK, addresses: sources.addresses, sources: sources.sources,
    clock, publish: (e) => {
      publish?.(e);
      journal.push(e);
    },
    log: (l) => log.push(l),
  });
  return { book, clock, journal, sources, log };
}

/** The rotation XLM -> SOL, synced at 23:30 (SOL open). */
async function rotated(dir: string, fillFee?: (q: { venue: string }) => Promise<number | null>) {
  const s = bookAt(dir, T0 + 20 * 60_000, fixtureSources(ledgerFixture(), fillFee));
  s.book.record(enterXlm());
  s.clock.set(exitXlm().at);
  s.book.record(exitXlm());
  s.clock.set(enterSol().at);
  s.book.record(enterSol());
  s.clock.set(T0 + 13 * H + 30 * 60_000);
  await s.book.sync();
  return s;
}

const syncLines = (events: readonly { type: string }[], ledger: string) =>
  events.filter((e): e is SyncEvent => e.type === 'sync' && (e as SyncEvent).ledger === ledger);

test('funding is the ledgers own payments, only in each hold: before the entry, after the exit and other markets are ignored', async () => {
  const { book } = await rotated(tempDir(dirs));
  const [xlm, sol] = book.summary().positions;
  assert.equal(xlm!.id, positionIdOf(XLM, enterXlm().at));
  const hl = xlm!.legs.find((l) => l.venue === 'hyperliquid')!;
  const px = xlm!.legs.find((l) => l.venue === 'phoenix')!;
  // 11:00 .. 20:00: the 10:00 row (before 10:20 less the slack) and the 21:00 row (after the 20:20 exit) are not XLM's.
  close(hl.fundingUsd, 0.6, 'hyperliquid XLM');
  assert.deepEqual([hl.payments, hl.paidHours, hl.hours], [10, 10, 10]);
  close(px.fundingUsd, -0.09, 'phoenix XLM');
  // The BTC row on the same account is never stored.
  const stored = book.events.filter((e) => e.type === 'funding') as FundingEvent[];
  assert.ok(stored.every((f) => f.symbol !== 'BTC'));
  assert.ok(!stored.some((f) => f.symbol === 'XLM' && f.time === T0 + 65), '10:00 is before the hold');
  assert.ok(!stored.some((f) => f.symbol === 'XLM' && f.time === T0 + 11 * H + 65), '21:00 is after the exit');
  assert.equal(sol!.open, true);
});

test('the hold starts when the act began (startedAt): a slow open keeps the funding hour it straddled', async () => {
  const dir = tempDir(dirs);
  // The open began at 10:50 and its record was written at 11:15, after the 11:00 payment.
  const slow: BookRecord = { ...enterXlm(), at: T0 + 75 * 60_000, startedAt: T0 + 50 * 60_000 };
  const s = bookAt(dir, slow.at);
  s.book.record(slow);
  s.clock.set(T0 + 3 * H + 6 * 60_000);
  await s.book.sync();
  const p = s.book.summary().positions[0]!;
  const hl = p.legs.find((l) => l.venue === 'hyperliquid')!;
  // 11:00, 12:00, 13:00: with the record time less the slack (11:05) the 11:00 one would be lost.
  assert.equal(hl.payments, 3);
  close(hl.fundingUsd, 0.18, '11:00 .. 13:00');
  assert.equal(p.startedAt, T0 + 50 * 60_000);
  close(p.heldHours, (3 * H + 6 * 60_000 - 50 * 60_000) / H, 'held from the act start');
  // Without startedAt the record time less the slack is the start: 11:00 is not this position's.
  const d2 = tempDir(dirs);
  const s2 = bookAt(d2, slow.at);
  s2.book.record({ ...slow, startedAt: undefined });
  s2.clock.set(T0 + 3 * H + 6 * 60_000);
  await s2.book.sync();
  assert.equal(s2.book.summary().positions[0]!.legs[0]!.payments, 2);
});

test('a rotation splits funding between the two positions, on another symbol and on the same one', async () => {
  const { book } = await rotated(tempDir(dirs));
  const [xlm, sol] = book.summary().positions;
  assert.equal(xlm!.rotatedTo, sol!.id);
  assert.equal(sol!.rotatedFrom, xlm!.id);
  const solHl = sol!.legs.find((l) => l.venue === 'hyperliquid')!;
  // 20:00 SOL is before the SOL entry (20:21 less the slack): not counted; 21, 22, 23 are.
  assert.deepEqual([solHl.payments, solHl.hours], [3, 3]);

  // Same symbol: XLM out at 20:20, XLM in again at 20:21 under another window. The slack never reaches back past the
  // exit, so 20:00 stays the first one's and 21:00 is the second one's.
  const dir = tempDir(dirs);
  const s = bookAt(dir, enterXlm().at);
  s.book.record(enterXlm());
  s.book.record({ ...exitXlm(), rotation: { fromId: XLM, toId: `${XLM}-b` } });
  s.book.record({ ...enterXlm(), windowId: `${XLM}-b`, at: T0 + 10 * H + 21 * 60_000, rotation: { fromId: XLM, toId: `${XLM}-b` }, marginMoves: [] });
  s.clock.set(T0 + 13 * H);
  await s.book.sync();
  const [a, b] = s.book.summary().positions;
  close(a!.legs[0]!.fundingUsd, 0.6, 'first XLM keeps 11:00 .. 20:00');
  close(b!.legs[0]!.fundingUsd, 0.06, 'second XLM gets 21:00');
  assert.equal(b!.rotatedFrom, a!.id);
});

test('negative funding: a short paying on a negative rate and a long receiving it count with their signs', async () => {
  const { book } = await rotated(tempDir(dirs));
  const sol = book.summary().positions[1]!;
  close(sol.legs.find((l) => l.venue === 'hyperliquid')!.fundingUsd, 0.03 + 0.03 - 0.05, 'hyperliquid SOL');
  close(sol.legs.find((l) => l.venue === 'phoenix')!.fundingUsd, -0.01 - 0.01 + 0.04, 'phoenix SOL');
  close(sol.fundingUsd, 0.03, 'SOL total');
  // Open: running numbers to the last ledger read (23:30), 3.15 h after the 20:21 entry; the price waits for the close.
  // Carry 0.03 - 0.10 (Phoenix's fee unknown here) on (1000 + 1000.5) / 2 a leg.
  close(sol.aprHours, 3.15, 'hours to the last read');
  assert.equal(sol.priceUsd, null);
  close(sol.actualAprPct!, (-0.07 / 1000.25) * (8760 / 3.15) * 100, 'running APR');
});

test('each payment is stored once across overlapping syncs and restarts; a read that stored nothing adds no line', async () => {
  const dir = tempDir(dirs);
  const s = bookAt(dir, enterXlm().at);
  s.book.record(enterXlm());
  s.clock.set(T0 + 5 * H + 6 * 60_000);
  await s.book.sync();
  const first = s.book.events.filter((e) => e.type === 'funding').length;
  assert.equal(first, 5 + 4);   // 11:00 .. 15:00 on Hyperliquid; Phoenix has no 15:00
  s.clock.set(T0 + 6 * H + 6 * 60_000);
  await s.book.sync();
  // The second read starts OVERLAP_MS (24 h) before the first one's end, floored at the hold: every row again.
  const second = s.sources.hl.asked.at(-1)!;
  assert.equal(second.start, enterXlm().at - 10 * 60_000);
  assert.equal(s.book.events.filter((e) => e.type === 'funding').length, first + 2);

  // A sync with nothing new moves the cursor in memory only: no sync line, the summary still shows the read.
  const lines = s.book.events.length;
  s.clock.set(T0 + 6 * H + 30 * 60_000);
  const idle = await s.book.sync();
  assert.equal(s.book.events.length, lines, 'nothing appended');
  assert.match(idle.lines.find((l) => l.ledger === 'hyperliquid')!.text, /0 new, \d+ already booked/);
  assert.equal(s.book.summary().cursors.hyperliquid, T0 + 6 * H + 30 * 60_000);
  assert.equal(syncLines(s.book.events, 'hyperliquid').at(-1)!.to, T0 + 6 * H + 6 * 60_000);

  // A restart: a new book over the same file reads from its last stored point less the overlap.
  const r = bookAt(dir, T0 + 6 * H + 30 * 60_000);
  assert.equal(r.book.events.length, s.book.events.length);
  await r.book.sync();
  await r.book.sync();
  assert.equal(r.book.events.filter((e) => e.type === 'funding').length, first + 2);
  const keys = (r.book.events.filter((e) => e.type === 'funding') as FundingEvent[]).map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  // The read window: from the last read less the overlap, never before the hold.
  const w = fundingWindow(r.book.events, 'hyperliquid', T0 + 40 * H)!;
  assert.equal(w.from, Math.max(enterXlm().at - 10 * 60_000, T0 + 6 * H + 6 * 60_000 - OVERLAP_MS));
  const late = fundingWindow(r.book.events, 'hyperliquid', T0 + 40 * H, { hyperliquid: T0 + 39 * H })!;
  assert.equal(late.from, T0 + 15 * H, 'the in-memory read counts too');
});

test('a read that fails keeps the last good read as the start, and the next one catches up', async () => {
  const dir = tempDir(dirs);
  const s = bookAt(dir, enterXlm().at);
  s.book.record(enterXlm());
  s.clock.set(T0 + 3 * H + 6 * 60_000);
  s.sources.phoenix.fail = new Error('HTTP 503');
  const r = await s.book.sync();
  assert.ok(r.lines.some((l) => l.ledger === 'phoenix' && !l.ok && /503/.test(l.text)));
  s.sources.phoenix.fail = null;
  s.clock.set(T0 + 4 * H + 6 * 60_000);
  await s.book.sync();
  const px = (s.book.events.filter((e) => e.type === 'funding') as FundingEvent[]).filter((f) => f.venue === 'phoenix');
  assert.equal(px.length, 4);   // 11:00 .. 14:00, caught up from the hold's start
});

test('a missing ledger hour: never invented, journaled as missing after the grace, and a late booking counts once', async () => {
  const dir = tempDir(dirs);
  const sources = fixtureSources();
  const sixteen = sources.phoenix.rows.find((r) => r.symbol === 'XLM' && r.time === T0 + 6 * H)!;
  sources.phoenix.rows = sources.phoenix.rows.filter((r) => r !== sixteen);
  const s = bookAt(dir, enterXlm().at, sources);
  s.book.record(enterXlm());
  s.clock.set(T0 + 6 * H + 6 * 60_000);
  await s.book.sync();
  const fundingEntries = () => s.journal.filter((j) => j.kind === 'funding');
  // 16:00: Hyperliquid paid, Phoenix not yet: within the grace nothing is journaled for that hour.
  assert.ok(!fundingEntries().some((j) => j.numbers.hour === '2026-11-02T16:00Z'));
  // 15:00 is older than the grace by 16:06? No: 1 h 06 min. Also waiting.
  assert.ok(!fundingEntries().some((j) => j.numbers.hour === '2026-11-02T15:00Z'));
  s.clock.set(T0 + 9 * H + 6 * 60_000);
  await s.book.sync();
  const missing = fundingEntries().find((j) => j.numbers.hour === '2026-11-02T16:00Z')!;
  assert.equal(missing.numbers.phoenixUsd, 'missing');
  assert.equal(missing.numbers.usd, 0.06);
  assert.match(missing.summary, /phoenix no payment/);
  assert.equal(fundingEntries().filter((j) => j.numbers.hour === '2026-11-02T16:00Z').length, 1);
  // Phoenix books 16:00 late; the next read overlaps it.
  sources.phoenix.rows.push(sixteen);
  s.clock.set(T0 + 10 * H + 6 * 60_000);
  await s.book.sync();
  const late = fundingEntries().filter((j) => j.numbers.late === 1);
  assert.equal(late.length, 1);
  assert.equal(late[0]!.numbers.phoenixUsd, -0.01);
  await s.book.sync();
  assert.equal(fundingEntries().filter((j) => j.numbers.late === 1).length, 1);
  const pos = s.book.summary().positions[0]!;
  const px = pos.legs.find((l) => l.venue === 'phoenix')!;
  close(px.fundingUsd, -0.09, 'phoenix: 11..20 less 15:00 (never booked)');
  // 15:00 never came: 9 of 10 hours paid at the end.
  s.clock.set(T0 + 10 * H + 20 * 60_000);
  s.book.record(exitXlm());
  assert.deepEqual([s.book.summary().positions[0]!.legs[1]!.paidHours, s.book.summary().positions[0]!.legs[1]!.hours], [9, 10]);
});

test('a Phoenix hour whose sum changes (a subaccount row showed up late) is stored again as the difference, once', async () => {
  const dir = tempDir(dirs);
  const sources = fixtureSources();
  const s = bookAt(dir, enterXlm().at, sources);
  s.book.record(enterXlm());
  s.clock.set(T0 + 3 * H + 6 * 60_000);
  await s.book.sync();
  const noon = sources.phoenix.rows.find((r) => r.symbol === 'XLM' && r.time === T0 + 2 * H)!;
  sources.phoenix.rows.push({ ...noon, fundingUsd: -0.005, size: 1000 });
  s.clock.set(T0 + 4 * H + 6 * 60_000);
  await s.book.sync();
  await s.book.sync();
  const adj = (s.book.events.filter((e) => e.type === 'funding') as FundingEvent[]).filter((f) => f.adjusts !== undefined);
  assert.equal(adj.length, 1);
  assert.equal(adj[0]!.adjusts, fundingKey('phoenix', T0 + 2 * H, 'XLM'));
  close(adj[0]!.usd, -0.005, 'the difference');
  const px = s.book.summary().positions[0]!.legs.find((l) => l.venue === 'phoenix')!;
  close(px.fundingUsd, -0.04 - 0.005, '11:00 .. 14:00 and the late subaccount row');
  assert.deepEqual([px.payments, px.paidHours], [4, 4], 'an adjustment is no extra payment or hour');
  const late = s.journal.filter((j) => j.kind === 'funding' && j.numbers.late === 1);
  assert.equal(late.length, 1);
  assert.equal(late[0]!.numbers.phoenixUsd, -0.005);
});

test('aggregated rows: hourly rows win; an aggregate counts only the hours of its day no hourly row covers', async () => {
  const dir = tempDir(dirs);
  const sources = fixtureSources();
  const s = bookAt(dir, enterXlm().at, sources);
  s.book.record(enterXlm());
  s.clock.set(T0 + 6 * H);
  await s.book.sync();
  // A 6-hour aggregate on 2 Nov, a day whose hourly rows are booked: dropped.
  sources.hl.rows.push({ time: T0 + 8 * H, symbol: 'XLM', fundingUsd: 0.36, size: -4000, ratePerHour: 0.00006, samples: 6 });
  s.clock.set(T0 + 10 * H);
  await s.book.sync();
  const agg = () => (s.book.events.filter((e) => e.type === 'funding') as FundingEvent[]).filter((f) => f.venue === 'hyperliquid' && f.samples !== null);
  assert.equal(agg().length, 0);

  // 3 Nov: four hourly rows and the day's aggregate of 24: the aggregate is stored for the other 20 hours, pro rata.
  const day = Date.UTC(2026, 10, 3);
  const row = (time: number, usd: number, samples: number | null): FundingPayment => ({ time, symbol: 'XLM', fundingUsd: usd, size: -4000, ratePerHour: 0.00001, samples });
  const d2 = tempDir(dirs);
  const src2 = fixtureSources();
  src2.hl.rows = [1, 2, 3, 4].map((h) => row(day + h * H + 65, 0.1, null)).concat(row(day, 2.4, 24));
  const s2 = bookAt(d2, enterXlm().at, src2);
  s2.book.record(enterXlm());
  s2.clock.set(day + 6 * H);
  await s2.book.sync();
  const hl = s2.book.summary().positions[0]!.legs.find((l) => l.venue === 'hyperliquid')!;
  close(hl.fundingUsd, 0.4 + 2.0, 'four hours + 20/24 of the aggregate');
  assert.equal(hl.paidHours, 24);
  // A later hourly row on a day already booked as an aggregate is dropped: never twice.
  src2.hl.rows.push(row(day + 5 * H + 65, 0.1, null));
  s2.clock.set(day + 7 * H);
  await s2.book.sync();
  close(s2.book.summary().positions[0]!.legs.find((l) => l.venue === 'hyperliquid')!.fundingUsd, 2.4, 'unchanged');
});

test('one funding entry per synced hour per position, with each leg and the total', async () => {
  const { journal } = await rotated(tempDir(dirs));
  const f = journal.filter((j) => j.kind === 'funding' && j.numbers.final === undefined);
  const xlm11 = f.filter((j) => j.numbers.window === XLM && j.numbers.hour === '2026-11-02T11:00Z');
  assert.equal(xlm11.length, 1);
  assert.deepEqual(
    [xlm11[0]!.numbers.hyperliquidUsd, xlm11[0]!.numbers.phoenixUsd, xlm11[0]!.numbers.usd],
    [0.06, -0.01, 0.05],
  );
  assert.equal(xlm11[0]!.summary, 'funding XLM 2026-11-02T11:00Z: hyperliquid +0.0600, phoenix -0.0100; +0.0500 USD');
  // XLM: 10 hours (15:00 with Phoenix missing, past the grace). SOL at 23:30: 21 and 22 are complete; 23:00 too.
  assert.equal(f.filter((j) => j.numbers.window === XLM).length, 10);
  assert.equal(f.filter((j) => j.numbers.window === SOL).length, 3);
  assert.equal(new Set(f.map((j) => j.id)).size, f.length);
});

test('the settle flow: the exit says how far funding was read, then one settled entry with the final numbers', async () => {
  const dir = tempDir(dirs);
  const path = bookFile(dir, DESK.mode, DESK.contractId, DESK.deskId);
  const writtenFirst: boolean[] = [];
  const s = bookAt(dir, enterXlm().at, fixtureSources(), (e) => {
    if (e.id.startsWith('book-settled-')) writtenFirst.push(readFileSync(path, 'utf8').includes(`"id":"${e.id}"`));
  });
  const out: StreamEvent[] = [];
  const w = loopBook(s.book, (e) => out.push(e), () => undefined);
  const loopEntry = (kind: JournalEntry['kind'], summary: string): StreamEvent => ({
    type: 'journal', data: { id: `loop-${out.length}`, t: s.clock.now(), kind, summary, numbers: { window: XLM }, tx: [] },
  });
  w.sink(enterXlm());
  w.publish(loopEntry('enter', 'enter'));
  s.clock.set(T0 + 5 * H + 6 * 60_000);
  await s.book.sync();

  // The exit at 20:20: funding is read to 15:06 only.
  s.clock.set(exitXlm().at);
  w.sink(exitXlm());
  w.publish(loopEntry('exit', 'exit xlm: rotate'));
  const exit = (out.at(-1) as Extract<StreamEvent, { type: 'journal' }>).data;
  assert.equal(exit.summary, 'exit xlm: rotate; funding read to 15:06, settling');
  assert.equal(exit.numbers.fundingThrough, new Date(T0 + 5 * H + 6 * 60_000).toISOString());
  assert.equal(exit.numbers.settling, 1);
  // 11..15 on Hyperliquid (0.30), 11..14 on Phoenix (-0.04); the APR over the 4.77 h read, not the 10 h held.
  assert.equal(exit.numbers.fundingUsd, 0.26);
  const aprH = (T0 + 5 * H + 6 * 60_000 - enterXlm().at) / H;
  assert.equal(exit.numbers.aprH, Math.round(aprH * 100) / 100);
  assert.equal(exit.numbers.actualAprPct, Math.round(((0.26 - 0.4 + 0.4) / 1000) * (8760 / aprH) * 100 * 100) / 100);
  assert.equal(exit.numbers.heldH, 10);

  // 21:06: read past the exit, not yet past exit + 2 h: no settled entry.
  s.clock.set(T0 + 11 * H + 6 * 60_000);
  await s.book.sync();
  const settledEntries = () => s.journal.filter((j) => j.id.startsWith('book-settled-'));
  assert.equal(settledEntries().length, 0);
  assert.equal(s.book.summary().positions[0]!.settled, false);

  // 22:25: past 22:20 on both ledgers: one settled entry, written to the file before it is published.
  s.clock.set(T0 + 12 * H + 25 * 60_000);
  await s.book.sync();
  assert.equal(settledEntries().length, 1);
  assert.deepEqual(writtenFirst, [true]);
  const settled = settledEntries()[0]!;
  assert.equal(settled.kind, 'funding', 'not a second exit: the web counts an exit as a close');
  assert.equal(settled.numbers.usd, undefined, 'the hourly entries carry the money');
  assert.deepEqual([settled.numbers.final, settled.numbers.settled], [1, 1]);
  assert.equal(settled.numbers.fundingUsd, 0.51);
  assert.equal(settled.numbers.actualAprPct, 44.68);
  assert.equal(settled.numbers.fundingThrough, new Date(exitXlm().at).toISOString());
  assert.match(settled.summary, /^settled XLM .*funding read to 20:20 \(final\)$/);
  // The read that crossed exit + 2 h is on file: the report sees the position settled too.
  assert.ok(syncLines(s.book.events, 'phoenix').some((l) => l.to >= exitXlm().at + 2 * H));
  assert.equal(summarize(new BookStore(path).load(), s.clock.now()).positions[0]!.settled, true);

  // Once: later syncs and a restart add none.
  s.clock.set(T0 + 13 * H);
  await s.book.sync();
  const r = bookAt(dir, T0 + 14 * H);
  await r.book.sync();
  assert.equal(settledEntries().length, 1);
  assert.equal(r.journal.filter((j) => j.id.startsWith('book-settled-')).length, 0);

  // The venue is read until exit + READ_AFTER_EXIT_MS, then no more.
  assert.notEqual(fundingWindow(r.book.events, 'hyperliquid', T0 + 15 * H), null);
  r.clock.set(exitXlm().at + READ_AFTER_EXIT_MS + H);
  await r.book.sync();
  assert.equal(fundingWindow(r.book.events, 'hyperliquid', r.clock.now() + H), null);
});

test('fees: the records fills, a missing fill fee read from the venue once, margin moves as transfer costs', async () => {
  const asked: string[] = [];
  const { book, journal } = await rotated(tempDir(dirs), async (q) => {
    asked.push(q.venue);
    return 0.03;
  });
  const [xlm, sol] = book.summary().positions;
  close(xlm!.entryFeesUsd, -0.2, 'XLM open');
  close(xlm!.exitFeesUsd, -0.2, 'XLM close');
  close(xlm!.transferCostUsd, -0.32, 'XLM margin move');
  close(sol!.entryFeesUsd, -0.13, 'SOL open: 0.10 recorded + 0.03 read from Phoenix');
  assert.equal(sol!.unknownFees, 0);
  assert.deepEqual(asked, ['phoenix']);
  await book.sync();
  assert.deepEqual(asked, ['phoenix'], 'read once');
  const fee = journal.filter((j) => j.kind === 'fee');
  assert.ok(fee.some((j) => j.numbers.venue === 'phoenix' && j.numbers.usd === -0.03));
  assert.ok(fee.some((j) => j.numbers.usd === -0.32 && j.numbers.from === 'phoenix'));
});

test('fees: every fill on a venue is read (one read per venue and side, split by size); a rebate stays a rebate', async () => {
  const queries: { venue: string; side: string; startedAt: number | null; at: number }[] = [];
  const dir = tempDir(dirs);
  const s = bookAt(dir, T0 + 20 * 60_000, fixtureSources(ledgerFixture(), async (q) => {
    queries.push({ venue: q.venue, side: (q as { side: string }).side, startedAt: (q as { startedAt: number | null }).startedAt, at: (q as { at: number }).at });
    return q.venue === 'hyperliquid' ? 0.2 : null;
  }));
  s.book.record({
    ...enterXlm(), startedAt: T0 + 15 * 60_000,
    legs: [
      { venue: 'hyperliquid', side: 'SELL', qty: '3000', avgPx: 0.25, feeUsd: null },
      { venue: 'hyperliquid', side: 'SELL', qty: '1000', avgPx: 0.2501, feeUsd: null },
      { venue: 'phoenix', side: 'BUY', qty: '4000', avgPx: 0.2502, feeUsd: 0.05 },
    ],
  });
  s.clock.set(T0 + H + 6 * 60_000);
  await s.book.sync();
  assert.deepEqual(queries, [{ venue: 'hyperliquid', side: 'SELL', startedAt: T0 + 15 * 60_000, at: T0 + 20 * 60_000 }]);
  const fees = s.book.events.filter((e): e is FeeEvent => e.type === 'fee');
  assert.deepEqual(fees.map((f) => [f.index, Math.round(f.usd * 1e6) / 1e6]), [[0, -0.15], [1, -0.05]]);
  const p = s.book.summary().positions[0]!;
  close(p.entryFeesUsd, -0.25, 'both Hyperliquid fills and Phoenix');
  assert.equal(p.unknownFees, 0);
  close(p.legs[0]!.entryFeeUsd!, -0.2, 'the Hyperliquid leg');
  await s.book.sync();
  assert.equal(queries.length, 1, 'read once');

  // A record with no fills keeps the loop's fee sum as charged: a maker rebate (< 0 charged) is income.
  const d2 = tempDir(dirs);
  const r = bookAt(d2, T0 + 20 * 60_000);
  r.book.record(enterXlm());
  r.book.record({ ...exitXlm(), legs: [], feeUsd: -0.05 });
  close(r.book.summary().positions[0]!.exitFeesUsd, 0.05, 'a rebate');
});

test('partial fills: an act that did not end as asked is booked; its fills count in fees and price', async () => {
  const dir = tempDir(dirs);
  const s = bookAt(dir, T0 + 20 * 60_000);
  s.book.record(enterXlm());
  // 15:00: an exit that bought back 1000 of the short and stopped.
  s.clock.set(T0 + 5 * H);
  const partial = s.book.record({
    kind: 'fill', windowId: XLM, symbol: 'XLM', at: T0 + 5 * H, startedAt: T0 + 5 * H - 60_000,
    legs: [{ venue: 'hyperliquid', side: 'BUY', qty: '1000', avgPx: 0.2495, feeUsd: 0.04 }],
    feeUsd: 0.04, tx: [], forecastNetAprPct: null, exitReason: 'one leg did not fill', rotation: null, by: 'auto', marginMoves: [],
  });
  assert.equal(partial.positionId, positionIdOf(XLM, enterXlm().at));
  assert.deepEqual(partial.numbers, {});
  const open = s.book.summary().positions[0]!;
  close(open.feesUsd, -0.24, 'open fees and the partial fill');
  assert.equal(open.priceUsd, null, 'open: no price yet');
  // 20:20: the exit closes the rest.
  s.clock.set(exitXlm().at);
  s.book.record({
    ...exitXlm(),
    legs: [
      { venue: 'hyperliquid', side: 'BUY', qty: '3000', avgPx: 0.249, feeUsd: 0.11 },
      { venue: 'phoenix', side: 'SELL', qty: '4000', avgPx: 0.2493, feeUsd: 0.05 },
    ],
  });
  const p = s.book.summary().positions[0]!;
  assert.equal(p.partialFills, 1);
  close(p.entryFeesUsd, -0.2, 'open');
  close(p.exitFeesUsd, -0.2, 'the partial fill 0.04 and the close 0.16');
  // Hyperliquid +1000 - 249.5 - 747 = +3.50; Phoenix -1000.8 + 997.2 = -3.60.
  close(p.priceUsd!, -0.1, 'every fill');
  close(p.legs[0]!.exitPx!, (1000 * 0.2495 + 3000 * 0.249) / 4000, 'Hyperliquid exit price over both fills');
  close(p.netUsd, -0.4 - 0.1 - 0.32, 'net');

  // A failed open that ended flat: no position; its fills are the desk's and in the totals.
  s.clock.set(T0 + 11 * H);
  const stray = s.book.record({
    kind: 'fill', windowId: SOL, symbol: 'SOL', at: T0 + 11 * H, startedAt: T0 + 11 * H - 30_000,
    legs: [
      { venue: 'phoenix', side: 'BUY', qty: '5', avgPx: 200.1, feeUsd: 0.02 },
      { venue: 'phoenix', side: 'SELL', qty: '5', avgPx: 200, feeUsd: 0.02 },
    ],
    feeUsd: 0.04, tx: [], forecastNetAprPct: null, exitReason: 'unwound', rotation: null, by: 'auto', marginMoves: [],
  });
  assert.equal(stray.positionId, null);
  const sum = s.book.summary();
  assert.equal(sum.strayFills.count, 1);
  close(sum.strayFills.feesUsd, -0.04, 'stray fees');
  close(sum.strayFills.priceUsd!, -0.5, 'stray price');
  close(sum.totals.feesUsd, -0.44, 'totals include them');
  close(sum.totals.netUsd, -0.82 - 0.54, 'desk net');
  assert.match(bookReport(sum), /stray fills 1 act\(s\) that left no position: fees -0\.0400, price -0\.5000/);
});

test('transfers: addTransfer ties one to the open position or to the desk; the Hyperliquid ledger books the desks', async () => {
  const { book, journal } = await rotated(tempDir(dirs));
  const sol = book.summary().positions[1]!;
  book.addTransfer({ from: 'phoenix', to: 'hyperliquid', usd: 4, feeUsd: -0.32, tx: [], positionId: 'open', source: 'rescue', note: 'rescue r-1' });
  book.addTransfer({ from: 'reserve', to: 'hyperliquid', usd: 10, feeUsd: -0.2, tx: [], positionId: null, source: 'fund' });
  assert.throws(() => book.addTransfer({ from: 'a', to: 'b', usd: 1, feeUsd: 0.1, tx: [], source: 'manual' }), /≤ 0/);
  const s = book.summary();
  close(s.positions[1]!.transferCostUsd, sol.transferCostUsd - 0.32, 'the rescue is the open position\'s');
  // Desk: the fixture's deposit (600, before the first entry but inside the lead), the fund transfer (10) and the
  // withdrawal (50 + 1 fee).
  close(s.deskTransfers.inUsd, 610, 'deposits and the fund transfer');
  close(s.deskTransfers.outUsd, -50, 'withdrawals');
  close(s.deskTransfers.feeUsd, -1 - 0.2, 'desk fees');
  assert.ok(journal.some((j) => j.kind === 'deposit' && j.numbers.usd === 600 && j.tx[0]!.chain === 'hyperliquid'));
  assert.ok(journal.some((j) => j.kind === 'withdraw' && j.numbers.usd === -50));
  await book.sync();
  assert.equal(book.summary().deskTransfers.count, 3, 'the ledger rows are stored once');
});

test('transfers are deduplicated by tx hash: addTransfer and the Hyperliquid ledger never count one twice', async () => {
  const f = ledgerFixture();
  const deposit = f.hyperliquidLedger.find((r) => r.delta.type === 'deposit')!;
  const ref = { chain: 'hyperliquid' as const, id: deposit.hash.toUpperCase().replace('0X', '0x'), url: 'https://example.invalid/tx' };
  // The ledger first: addTransfer of the same tx returns the booked one.
  const { book } = await rotated(tempDir(dirs));
  const held = book.addTransfer({ from: 'reserve', to: 'hyperliquid', usd: 600, feeUsd: 0, tx: [ref], positionId: null, source: 'fund' });
  assert.match(held, /^hl:/);
  close(book.summary().deskTransfers.inUsd, 600, 'once');
  // addTransfer first: the ledger row with that hash is a duplicate.
  const s = bookAt(tempDir(dirs), T0 + 20 * 60_000);
  s.book.record(enterXlm());
  const id = s.book.addTransfer({ at: deposit.time, from: 'reserve', to: 'hyperliquid', usd: 600, feeUsd: 0, tx: [ref], positionId: null, source: 'fund' });
  assert.match(id, /^fund:/);
  s.clock.set(T0 + 13 * H);
  await s.book.sync();
  const transfers = s.book.events.filter((e): e is TransferEvent => e.type === 'transfer');
  assert.deepEqual(transfers.map((t) => t.source).sort(), ['fund', 'hl-ledger'], 'the fund transfer and the withdrawal');
  close(s.book.summary().deskTransfers.inUsd, 600, 'once');
  assert.equal(syncLines(s.book.events, 'hyperliquid-ledger').at(-1)!.duplicates, 1);
});

test('the report: per position and desk totals, actual APR checked by hand', async () => {
  const { book } = await rotated(tempDir(dirs));
  const s = book.summary();
  const xlm = s.positions[0]!;
  // Funding 0.60 - 0.09 = 0.51; fees -0.40; price: short 4000 at 0.25 -> 0.249 = +4.00, long 4000 at 0.2502 -> 0.2493 =
  // -3.60, so +0.40. Carry 0.51 - 0.40 + 0.40 = 0.51 over 10 h on 1000 a leg: 0.51 / 1000 x 8760 / 10 x 100 = 44.676 %.
  close(xlm.fundingUsd, 0.51, 'funding');
  close(xlm.feesUsd, -0.4, 'fees');
  close(xlm.priceUsd!, 0.4, 'price');
  close(xlm.heldHours, 10, 'hours');
  close(xlm.aprHours, 10, 'read past the exit: the whole hold');
  close(xlm.actualAprPct!, 44.676, 'actual APR');
  assert.equal(xlm.settled, true);
  // Net adds the 0.32 margin move: 0.51 - 0.32 = 0.19; on 500 of margin, 0.038 %.
  close(xlm.netUsd, 0.19, 'net');
  close(xlm.netOnMarginPct!, 0.038, 'net on margin');
  const text = bookReport(s);
  assert.match(text, /APR {8}actual 44\.68 % vs forecast 20\.00 %/);
  assert.match(text, /funding {4}hyperliquid \+0\.6000 \(10 of 10 h paid\), phoenix -0\.0900 \(9 of 10 h paid, 1 h with no payment booked\); total \+0\.5100/);
  assert.match(text, /net {8}\+0\.1900 USD, 0\.04 % of margin/);
  assert.match(text, /exit {7}rotate into sol-phoenix-hyperliquid/);
  assert.match(text, /settled {4}yes/);
  assert.match(text, /SOL {2}short hyperliquid, long phoenix {2}OPEN/);
  assert.match(text, /fees {7}open -0\.1000, close not yet, total -0\.1000 \(1 fill\(s\) with no fee known: not counted\)/);
  assert.match(text, /NEAR AI veto ledger \(helped \/ hurt\)\n {2}-- not recorded yet/);
  // Desk totals: funding 0.51 + 0.03, fees -0.40 - 0.10, transfers -0.32, price +0.40.
  close(s.totals.netUsd, 0.51 + 0.03 - 0.5 - 0.32 + 0.4, 'desk net');
  assert.match(text, /net {8}\+0\.1200 USD\n {2}desk ledger/);
});

test('npm run report reads the book alone, with no network', async () => {
  const dir = tempDir(dirs);
  await rotated(dir);
  const cli = fileURLToPath(new URL('../cli/report.ts', import.meta.url));
  const run = spawnSync(process.execPath, [cli, '--state', dir], {
    encoding: 'utf8', env: { ...process.env, GIMBAL_STATE_DIR: '' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /position book: mainnet gimbal-test\.near \/ desk-1/);
  assert.match(run.stdout, /actual 44\.68 % vs forecast 20\.00 %/);
  assert.match(run.stdout, /desk totals/);
});

test('the store appends; the summary is written after the call returns, and a crash in its rename loses nothing', async () => {
  const dir = tempDir(dirs);
  const path = bookFile(dir, DESK.mode, DESK.contractId, DESK.deskId);
  const summaryPath = path.replace(/\.jsonl$/, '.summary.json');
  const clock = new VirtualClock(enterXlm().at);
  const log: string[] = [];
  let crash = false;
  const book = new PositionBook({
    dir, ...DESK, clock, log: (l) => log.push(l),
    hooks: { beforeRename: () => {
      if (crash) throw new Error('power cut');
    } },
  });
  book.record(enterXlm());
  assert.equal(existsSync(summaryPath), false, 'record() returned before the summary was written');
  const before = readFileSync(path, 'utf8');
  await tick();
  assert.equal(existsSync(summaryPath), true);
  const oldSummary = readFileSync(summaryPath, 'utf8');
  // Appended, never rewritten: the exit adds lines after the old ones.
  crash = true;
  clock.set(exitXlm().at);
  book.record(exitXlm());
  assert.ok(readFileSync(path, 'utf8').startsWith(before));
  await tick();
  assert.ok(log.some((l) => /summary not written \(power cut\)/.test(l)));
  assert.equal(readFileSync(summaryPath, 'utf8'), oldSummary, 'the old summary is whole');
  assert.ok(existsSync(`${summaryPath}.tmp`), 'the temporary file is left behind');
  // A restart reads the whole JSONL; the next summary is the derived one.
  crash = false;
  const restarted = new PositionBook({ dir, ...DESK, clock });
  assert.equal(restarted.summary().positions[0]!.open, false);
  restarted.addTransfer({ from: 'reserve', to: 'hyperliquid', usd: 1, feeUsd: 0, tx: [], source: 'fund' });
  restarted.flushSummary();
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as { positions: { open: boolean }[] };
  assert.equal(summary.positions[0]!.open, false);
  assert.deepEqual(summary, JSON.parse(JSON.stringify(summarize(new BookStore(path).load(), clock.now()))));
});

test('a torn last line (a write cut off) is dropped and cut from the file; any other bad line is refused', () => {
  const dir = tempDir(dirs);
  const path = bookFile(dir, DESK.mode, DESK.contractId, DESK.deskId);
  const book = new PositionBook({ dir, ...DESK, clock: new VirtualClock(T0) });
  book.record(enterXlm());
  const whole = readFileSync(path, 'utf8');
  appendFileSync(path, '{"v":1,"type":"exit","at":');
  // A reader that must not write (the report) drops it and leaves the file alone.
  const reader = new PositionBook({ dir, ...DESK, persist: false });
  assert.equal(reader.events.length, book.events.length);
  assert.ok(readFileSync(path, 'utf8').endsWith('"at":'));
  // serve's book repairs it and appends cleanly after it.
  const log: string[] = [];
  const repaired = new PositionBook({ dir, ...DESK, clock: new VirtualClock(exitXlm().at), log: (l) => log.push(l) });
  assert.ok(log.some((l) => /dropped a torn last line/.test(l)));
  assert.equal(readFileSync(path, 'utf8'), whole);
  repaired.record(exitXlm());
  const loaded = new BookStore(path);
  assert.equal(loaded.load().filter((e) => e.type === 'exit').length, 1);
  assert.equal(loaded.repaired, null);

  // A bad line that is not the last: refused, never started over.
  rmSync(path);
  writeFileSync(path, `${whole}{"v":1,"type":"enter",\n${whole.split('\n')[0]}\n`);
  assert.throws(() => new PositionBook({ dir, ...DESK }), /not JSON/);
});

test('the real Hyperliquid reader over a replayed userFunding answer feeds the book', async () => {
  const dir = tempDir(dirs);
  const f = ledgerFixture();
  const now = T0 + 11 * H;
  const clock = new VirtualClock(enterXlm().at);
  const probe = new PositionBook({ dir, ...DESK, clock, persist: false });
  probe.record(enterXlm());
  const read = fundingWindow(probe.events, 'hyperliquid', now)!;
  const line: WireLine = {
    t: now, method: 'POST', url: HL_MAINNET_INFO_URL, status: 200, ms: 1,
    request: { type: 'userFunding', user: f.hyperliquidAddress, startTime: read.from, endTime: read.to },
    response: f.hyperliquid.userFunding.filter((r) => r.time >= read.from && r.time <= read.to),
  };
  const book = createBook({
    dir, ...DESK, clock,
    addresses: { hyperliquid: f.hyperliquidAddress },
    sources: { funding: { hyperliquid: new HyperliquidReader({ fetch: replayFetch([line]), clock }) } },
  });
  book.record(enterXlm());
  clock.set(now);
  const r = await book.sync();
  assert.ok(r.lines.find((l) => l.ledger === 'hyperliquid')!.ok, JSON.stringify(r.lines));
  close(book.summary().positions[0]!.legs[0]!.fundingUsd, 0.6, 'hyperliquid XLM over the wire');
});

test('Hyperliquid reads: fill fees only in the act window; a malformed ledger row is named by its shape, never its values', async () => {
  const asked: unknown[] = [];
  const fills = [
    { coin: 'XLM', side: 'A', fee: '0.10', time: T0 + 15 * 60_000 },
    { coin: 'XLM', side: 'A', fee: '0.05', time: T0 + 19 * 60_000 },
    { coin: 'XLM', side: 'A', fee: '9.99', time: T0 - 30 * 60_000 },   // another act, outside the window
    { coin: 'XLM', side: 'B', fee: '7.00', time: T0 + 16 * 60_000 },   // the other side
  ];
  const fake = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { startTime: number; endTime: number };
    asked.push(body);
    return new Response(JSON.stringify(fills.filter((r) => r.time >= body.startTime && r.time <= body.endTime)));
  }) as unknown as typeof fetch;
  const q = { venue: 'hyperliquid', address: '0x00000000000000000000000000000000000000d1', symbol: 'XLM', side: 'SELL' as const, startedAt: T0 + 14 * 60_000, at: T0 + 20 * 60_000, tx: [] };
  close((await hlFillFee(fake, 'https://info.invalid', q))!, 0.15, 'the act\'s two fills');
  assert.deepEqual(asked[0], { type: 'userFillsByTime', user: q.address, startTime: q.startedAt - 5_000, endTime: q.at + 5_000 });
  assert.equal(await hlFillFee(fake, 'https://info.invalid', { ...q, startedAt: null }), null, 'no act start: cannot tell');
  assert.equal(asked.length, 1);

  const counterparty = '0x00000000000000000000000000000000000000c7';
  const bad = (async () => new Response(JSON.stringify([{ time: 'soon', hash: 1, delta: { type: 'send', destination: counterparty, usdc: '5' } }]))) as unknown as typeof fetch;
  await assert.rejects(hlNonFundingLedger(bad, 'https://info.invalid', q.address, 0, 1), (err: Error) => {
    assert.match(err.message, /malformed row \(time: string, hash: number, delta: \{type: string, destination: string, usdc: string\}\)/);
    assert.ok(!err.message.includes(counterparty));
    return true;
  });
});

test('serve wiring: the book numbers join the loop entry written right after the record, and a held pair is adopted', () => {
  const dir = tempDir(dirs);
  const clock = new VirtualClock(enterXlm().at);
  const book = new PositionBook({ dir, ...DESK, clock });
  const out: StreamEvent[] = [];
  const held = { windowId: SOL, symbol: 'SOL', since: T0, legUsd: 50, entryNetAprPct: 12 };
  let loopHeld: typeof held | null = null;
  const w = loopBook(book, (e) => out.push(e), () => undefined, () => loopHeld);
  const journal = (kind: JournalEntry['kind'], numbers: Record<string, number | string>): StreamEvent => ({
    type: 'journal', data: { id: `loop-${out.length}`, t: clock.now(), kind, summary: kind, numbers, tx: [] },
  });
  w.sink(enterXlm());
  w.publish(journal('enter', { window: XLM, feeUsd: 0.2, usd: 1000 }));
  w.publish(journal('wait', { window: XLM }));
  const enter = out[0]!.type === 'journal' ? out[0]!.data : null;
  assert.equal(enter!.numbers.position, positionIdOf(XLM, enterXlm().at));
  assert.equal(enter!.numbers.feeUsd, -0.2, 'the book\'s signed fee wins');
  assert.equal(enter!.numbers.usd, 1000, 'the loop\'s own keys stay');
  assert.equal(enter!.numbers.hyperliquidSide, 'short');
  assert.equal(enter!.numbers.forecastNetAprPct, 20);
  assert.equal(enter!.summary, 'enter');
  assert.deepEqual(out[1]!.type === 'journal' ? out[1]!.data.numbers : null, { window: XLM }, 'only the next entry');
  clock.set(exitXlm().at);
  w.sink({ ...exitXlm(), rotation: null });
  w.publish(journal('exit', { window: XLM, feeUsd: 0.2 }));
  const exit = out[2]!.type === 'journal' ? out[2]!.data : null;
  assert.equal(exit!.numbers.feeUsd, -0.2);
  assert.equal(exit!.numbers.heldH, 10);
  // No ledger read yet: no hours to annualise over, so no APR; the entry says so.
  assert.equal(exit!.numbers.actualAprPct, undefined);
  assert.equal(exit!.numbers.fundingThrough, 'none');
  assert.equal(exit!.summary, 'exit; funding read to none yet, settling');
  assert.equal(exit!.numbers.priceUsd, 0.4);
  // A pair the loop holds and the book never saw enter is adopted on the next decision.
  loopHeld = held;
  w.publish({ type: 'decision', data: { action: 'hold', reason: 'x', windowId: null, heldId: SOL, at: clock.now() } });
  w.publish({ type: 'decision', data: { action: 'hold', reason: 'y', windowId: null, heldId: SOL, at: clock.now() } });
  const sol = book.summary().positions.filter((p) => p.windowId === SOL);
  assert.equal(sol.length, 1);
  assert.deepEqual([sol[0]!.adopted, sol[0]!.enteredAt, sol[0]!.legUsd, sol[0]!.forecastNetAprPct], [true, T0, 50, 12]);
  book.stop();
});

test('the hourly sync runs a few minutes after the top of the hour', () => {
  assert.equal(nextSyncAt(T0), T0 + 5 * 60_000);
  assert.equal(nextSyncAt(T0 + 5 * 60_000), T0 + H + 5 * 60_000);
  assert.equal(nextSyncAt(T0 + 30 * 60_000), T0 + H + 5 * 60_000);
  assert.equal(HOUR_MS, H);
});

test('start() syncs now and schedules the next hour; stop() cancels it', async () => {
  const dir = tempDir(dirs);
  const sources = fixtureSources();
  const clock = new VirtualClock(T0 + 2 * H + 30 * 60_000);
  const timers: { fn: () => void; ms: number }[] = [];
  let cleared = 0;
  const book = createBook({
    dir, ...DESK, clock, addresses: sources.addresses, sources: sources.sources,
    timers: { setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => cleared++ },
  });
  book.record(enterXlm());
  book.start();
  await tick();
  await tick();
  assert.equal(sources.hl.asked.length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 35 * 60_000);
  book.stop();
  assert.equal(cleared, 1);
});
