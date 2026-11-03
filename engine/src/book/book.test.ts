// The position book: records, ledger sync (dedupe, windows, rotation, negative and missing funding), fees, transfers,
// journal entries, the atomic store and the report. No network: the ledgers are the synthetic fixture in the venues'
// wire shapes (test-helpers.ts), and one test runs the real HyperliquidReader over a replayed wire line.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { JournalEntry, StreamEvent } from '@gimbal/shared';
import { VirtualClock, replayFetch } from '../venues/replay.ts';
import { HL_MAINNET_INFO_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import type { WireLine } from '../venues/recorder.ts';
import { loopBook } from '../cli/serve-loop.ts';
import { PositionBook, createBook, nextSyncAt } from './book.ts';
import { HOUR_MS, positionIdOf, summarize } from './derive.ts';
import { bookReport } from './report.ts';
import { BookStore, bookFile } from './store.ts';
import { fundingWindow } from './sync.ts';
import type { FundingEvent, SyncEvent } from './types.ts';
import { H, SOL, T0, XLM, enterSol, enterXlm, exitXlm, fixtureSources, ledgerFixture, tempDir } from './test-helpers.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

function bookAt(dir: string, at: number, sources = fixtureSources()) {
  const clock = new VirtualClock(at);
  const journal: JournalEntry[] = [];
  const book = createBook({
    dir, mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1', addresses: sources.addresses, sources: sources.sources,
    clock, publish: (e) => journal.push(e),
  });
  return { book, clock, journal, sources };
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

test('each payment is stored once across overlapping syncs and restarts', async () => {
  const dir = tempDir(dirs);
  const s = bookAt(dir, enterXlm().at);
  s.book.record(enterXlm());
  s.clock.set(T0 + 5 * H + 6 * 60_000);
  await s.book.sync();
  const first = s.book.events.filter((e) => e.type === 'funding').length;
  assert.equal(first, 5 + 4);   // 11:00 .. 15:00 on Hyperliquid; Phoenix has no 15:00
  s.clock.set(T0 + 6 * H + 6 * 60_000);
  await s.book.sync();
  // The second read starts 6 h before the first one's end, so it reads every row of the first again.
  const second = s.sources.hl.asked.at(-1)!;
  assert.ok(second.start <= T0 + H, 'the read overlaps the one before');
  assert.equal(s.book.events.filter((e) => e.type === 'funding').length, first + 2);

  // A restart: a new book over the same file reads from its last stored point less the overlap.
  const r = bookAt(dir, T0 + 6 * H + 30 * 60_000);
  assert.equal(r.book.events.length, s.book.events.length);
  await r.book.sync();
  await r.book.sync();
  assert.equal(r.book.events.filter((e) => e.type === 'funding').length, first + 2);
  const last = r.book.events.filter((e): e is SyncEvent => e.type === 'sync' && e.ledger === 'hyperliquid').at(-1)!;
  assert.ok(last.duplicates > 0 && last.stored === 0);
  const keys = (r.book.events.filter((e) => e.type === 'funding') as FundingEvent[]).map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  // The read window: from the last read less the overlap, never before the hold.
  const w = fundingWindow(r.book.events, 'hyperliquid', T0 + 7 * H)!;
  assert.equal(w.from, Math.max(enterXlm().at - 10 * 60_000, T0 + 6 * H + 30 * 60_000 - 6 * HOUR_MS));
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

test('one funding entry per synced hour per position, with each leg and the total', async () => {
  const { journal } = await rotated(tempDir(dirs));
  const f = journal.filter((j) => j.kind === 'funding');
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
  close(xlm.actualAprPct!, 44.676, 'actual APR');
  // Net adds the 0.32 margin move: 0.51 - 0.32 = 0.19; on 500 of margin, 0.038 %.
  close(xlm.netUsd, 0.19, 'net');
  close(xlm.netOnMarginPct!, 0.038, 'net on margin');
  const text = bookReport(s);
  assert.match(text, /APR {8}actual 44\.68 % vs forecast 20\.00 %/);
  assert.match(text, /funding {4}hyperliquid \+0\.6000 \(10 of 10 h paid\), phoenix -0\.0900 \(9 of 10 h paid, 1 h with no payment booked\); total \+0\.5100/);
  assert.match(text, /net {8}\+0\.1900 USD, 0\.04 % of margin/);
  assert.match(text, /exit {7}rotate into sol-phoenix-hyperliquid/);
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

test('the book survives a crash between the temporary file and the rename', () => {
  const dir = tempDir(dirs);
  const path = bookFile(dir, 'mainnet', 'gimbal-test.near', 'desk-1');
  const clock = new VirtualClock(enterXlm().at);
  const book = new PositionBook({ dir, mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1', clock });
  book.record(enterXlm());
  const before = readFileSync(path, 'utf8');
  let crash = true;
  const crashing = new PositionBook({
    dir, mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1', clock,
    hooks: { beforeRename: () => {
      if (crash) throw new Error('power cut');
    } },
  });
  clock.set(exitXlm().at);
  assert.throws(() => crashing.record(exitXlm()), /power cut/);
  assert.equal(readFileSync(path, 'utf8'), before, 'the book is the old one, whole');
  assert.ok(existsSync(`${path}.tmp`), 'the temporary file is left behind');
  // A restart reads the old book; the exit was never booked, so the position is open.
  const restarted = new PositionBook({ dir, mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1', clock });
  assert.equal(restarted.summary().positions[0]!.open, true);
  crash = false;
  restarted.record(exitXlm());
  assert.ok(!existsSync(`${path}.tmp`));
  assert.equal(new BookStore(path).load().filter((e) => e.type === 'exit').length, 1);
  // The summary is derived: written next to it, and the same as summarize() of the JSONL.
  const summary = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.summary.json'), 'utf8')) as { positions: { open: boolean }[] };
  assert.equal(summary.positions[0]!.open, false);
  assert.deepEqual(summary, JSON.parse(JSON.stringify(summarize(new BookStore(path).load(), clock.now()))));
});

test('an unreadable book is refused, never started over', () => {
  const dir = tempDir(dirs);
  const path = bookFile(dir, 'mainnet', 'gimbal-test.near', 'desk-1');
  const book = new PositionBook({ dir, mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1', clock: new VirtualClock(T0) });
  book.record(enterXlm());
  const text = readFileSync(path, 'utf8');
  rmSync(path);
  writeFileSync(path, `${text}{"v":1,"type":"enter",`);
  assert.throws(() => new PositionBook({ dir, mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1' }), /not JSON/);
});


test('a venue-aggregated row is dropped when hourly rows of that day are booked', async () => {
  const dir = tempDir(dirs);
  const sources = fixtureSources();
  const s = bookAt(dir, enterXlm().at, sources);
  s.book.record(enterXlm());
  s.clock.set(T0 + 6 * H);
  await s.book.sync();
  const before = s.book.events.filter((e) => e.type === 'funding').length;
  sources.hl.rows.push({ time: T0 + 14 * H, symbol: 'XLM', fundingUsd: 0.36, size: -4000, ratePerHour: 0.00006, samples: 6 });
  s.clock.set(T0 + 15 * H);
  await s.book.sync();
  const hl = (s.book.events.filter((e) => e.type === 'funding') as FundingEvent[]).filter((f) => f.venue === 'hyperliquid');
  assert.ok(!hl.some((f) => f.samples !== null));
  assert.ok(s.book.events.filter((e) => e.type === 'funding').length > before);
});

test('the real Hyperliquid reader over a replayed userFunding answer feeds the book', async () => {
  const dir = tempDir(dirs);
  const f = ledgerFixture();
  const now = T0 + 11 * H;
  const clock = new VirtualClock(enterXlm().at);
  const probe = new PositionBook({ dir, mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1', clock, persist: false });
  probe.record(enterXlm());
  const read = fundingWindow(probe.events, 'hyperliquid', now)!;
  const line: WireLine = {
    t: now, method: 'POST', url: HL_MAINNET_INFO_URL, status: 200, ms: 1,
    request: { type: 'userFunding', user: f.hyperliquidAddress, startTime: read.from, endTime: read.to },
    response: f.hyperliquid.userFunding.filter((r) => r.time >= read.from && r.time <= read.to),
  };
  const book = createBook({
    dir, mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1', clock,
    addresses: { hyperliquid: f.hyperliquidAddress },
    sources: { funding: { hyperliquid: new HyperliquidReader({ fetch: replayFetch([line]), clock }) } },
  });
  book.record(enterXlm());
  clock.set(now);
  const r = await book.sync();
  assert.ok(r.lines.find((l) => l.ledger === 'hyperliquid')!.ok, JSON.stringify(r.lines));
  close(book.summary().positions[0]!.legs[0]!.fundingUsd, 0.6, 'hyperliquid XLM over the wire');
});

test('serve wiring: the book numbers join the loop entry written right after the record, and a held pair is adopted', () => {
  const dir = tempDir(dirs);
  const clock = new VirtualClock(enterXlm().at);
  const book = new PositionBook({ dir, mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1', clock });
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
  assert.deepEqual(out[1]!.type === 'journal' ? out[1]!.data.numbers : null, { window: XLM }, 'only the next entry');
  clock.set(exitXlm().at);
  w.sink({ ...exitXlm(), rotation: null });
  w.publish(journal('exit', { window: XLM, feeUsd: 0.2 }));
  const exit = out[2]!.type === 'journal' ? out[2]!.data : null;
  assert.equal(exit!.numbers.feeUsd, -0.2);
  assert.equal(exit!.numbers.heldH, 10);
  // No funding synced here: fees -0.40 and price +0.40 carry 0.
  assert.equal(exit!.numbers.actualAprPct, 0);
  assert.equal(exit!.numbers.priceUsd, 0.4);
  // A pair the loop holds and the book never saw enter is adopted on the next decision.
  loopHeld = held;
  w.publish({ type: 'decision', data: { action: 'hold', reason: 'x', windowId: null, heldId: SOL, at: clock.now() } });
  w.publish({ type: 'decision', data: { action: 'hold', reason: 'y', windowId: null, heldId: SOL, at: clock.now() } });
  const sol = book.summary().positions.filter((p) => p.windowId === SOL);
  assert.equal(sol.length, 1);
  assert.deepEqual([sol[0]!.adopted, sol[0]!.enteredAt, sol[0]!.legUsd, sol[0]!.forecastNetAprPct], [true, T0, 50, 12]);
});

test('the hourly sync runs a few minutes after the top of the hour', () => {
  assert.equal(nextSyncAt(T0), T0 + 5 * 60_000);
  assert.equal(nextSyncAt(T0 + 5 * 60_000), T0 + H + 5 * 60_000);
  assert.equal(nextSyncAt(T0 + 30 * 60_000), T0 + H + 5 * 60_000);
});

test('start() syncs now and schedules the next hour; stop() cancels it', async () => {
  const dir = tempDir(dirs);
  const sources = fixtureSources();
  const clock = new VirtualClock(T0 + 2 * H + 30 * 60_000);
  const timers: { fn: () => void; ms: number }[] = [];
  let cleared = 0;
  const book = createBook({
    dir, mode: 'mainnet', contractId: 'gimbal-test.near', deskId: 'desk-1', clock, addresses: sources.addresses, sources: sources.sources,
    timers: { setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => cleared++ },
  });
  book.record(enterXlm());
  book.start();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(sources.hl.asked.length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 35 * 60_000);
  book.stop();
  assert.equal(cleared, 1);
});
