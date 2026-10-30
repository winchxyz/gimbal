import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { RecordLine } from './recorder.ts';
import { JsonlGzWriter, RecordingVenue } from './recorder.ts';
import { ReplayMissError, ReplayVenue, ScaledClock, VirtualClock, parseRecording, readRecording } from './replay.ts';
import type { AccountState, Book, Market, MarketFunding, VenueReader } from './venue.ts';

const dir = mkdtempSync(join(tmpdir(), 'gimbal-replay-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const T0 = 1_793_377_712_000;

const book = (symbol: string, px: number): Book => ({
  venue: 'hyperliquid', symbol, time: T0,
  bids: [{ px, sz: 1 }, { px: px - 1, sz: 2 }, { px: px - 2, sz: 3 }],
  asks: [{ px: px + 1, sz: 1 }, { px: px + 2, sz: 2 }, { px: px + 3, sz: 3 }],
});

const fundingAt = (rate: number): MarketFunding[] => [{
  venue: 'hyperliquid', symbol: 'ETH', ratePerHour: rate, settlement: 'hourly', nextAt: T0 + 3_600_000,
  markPx: 2235, oraclePx: 2236, openInterest: 1, volume24hUsd: 2,
}];

const line = (t: number, method: RecordLine['method'], args: unknown[], result: unknown): RecordLine =>
  ({ t, venue: 'hyperliquid', method, args, ms: 5, result });

const LINES: RecordLine[] = [
  line(T0, 'funding', [], fundingAt(0.0001)),
  line(T0 + 1_000, 'book', ['ETH'], book('ETH', 2000)),
  line(T0 + 5_000, 'funding', [], fundingAt(0.0002)),
  { t: T0 + 6_000, venue: 'hyperliquid', method: 'book', args: ['ETH'], ms: 10_000, error: 'hyperliquid info l2Book: HTTP 502' },
  line(T0 + 10_000, 'book', ['ETH', 2], book('ETH', 2010)),
  line(T0 + 10_000, 'funding', [], fundingAt(0.0003)),
];

test('answers with the latest record at or before the clock', async () => {
  const clock = new VirtualClock(T0);
  const venue = new ReplayVenue(LINES, clock);
  assert.equal(venue.id, 'hyperliquid');
  assert.equal(venue.start, T0);
  assert.equal(venue.end, T0 + 10_000);
  assert.equal((await venue.funding())[0]!.ratePerHour, 0.0001);
  clock.set(T0 + 4_999);
  assert.equal((await venue.funding())[0]!.ratePerHour, 0.0001);
  assert.equal((await venue.book('ETH')).bids[0]!.px, 2000);
  clock.set(T0 + 5_000);
  assert.equal((await venue.funding())[0]!.ratePerHour, 0.0002);
  clock.set(T0 + 60_000);
  assert.equal((await venue.funding())[0]!.ratePerHour, 0.0003);
  assert.equal((await venue.book('ETH')).bids[0]!.px, 2010);
});

test('a call with nothing recorded before the clock is a miss, not a guess', async () => {
  const clock = new VirtualClock(T0);
  const venue = new ReplayVenue(LINES, clock);
  await assert.rejects(venue.book('ETH'), ReplayMissError);
  await assert.rejects(venue.book('BTC'), ReplayMissError);
  await assert.rejects(venue.markets(), ReplayMissError);
  await assert.rejects(venue.account('0xabc'), ReplayMissError);
});

test('a recorded failure fails again on replay', async () => {
  const venue = new ReplayVenue(LINES, new VirtualClock(T0 + 7_000));
  await assert.rejects(venue.book('ETH'), /HTTP 502/);
});

test('books are keyed by symbol and trimmed to the asked depth', async () => {
  const venue = new ReplayVenue(LINES, new VirtualClock(T0 + 1_000));
  assert.equal((await venue.book('ETH')).bids.length, 3);
  const two = await venue.book('ETH', 2);
  assert.equal(two.bids.length, 2);
  assert.equal(two.asks.length, 2);
  await assert.rejects(venue.book('ETH', 0), RangeError);
});

test('answers are copies: mutating one does not change the next', async () => {
  const venue = new ReplayVenue(LINES, new VirtualClock(T0));
  const first = await venue.funding();
  first[0]!.ratePerHour = 42;
  first.pop();
  assert.equal((await venue.funding())[0]!.ratePerHour, 0.0001);
});

test('times lists answer moments per method', () => {
  const venue = new ReplayVenue(LINES, new VirtualClock(T0));
  assert.deepEqual(venue.times('funding'), [T0, T0 + 5_000, T0 + 10_000]);
  assert.deepEqual(venue.times(), [T0, T0 + 1_000, T0 + 5_000, T0 + 6_000, T0 + 10_000]);
});

test('a venue filter keeps only that venue', async () => {
  const other: RecordLine = { ...line(T0, 'funding', [], []), venue: 'orderly' };
  const venue = new ReplayVenue([other, ...LINES], new VirtualClock(T0), 'hyperliquid');
  assert.equal((await venue.funding()).length, 1);
  assert.throws(() => new ReplayVenue(LINES, new VirtualClock(T0), 'phoenix'), /no phoenix lines/);
  assert.throws(() => new ReplayVenue([], new VirtualClock(T0)), /empty recording/);
});

test('virtual clock moves only forward', () => {
  const clock = new VirtualClock(T0);
  clock.advance(500);
  assert.equal(clock.now(), T0 + 500);
  assert.throws(() => clock.set(T0), RangeError);
  assert.throws(() => clock.advance(-1), RangeError);
});

test('scaled clock runs N times real time', () => {
  const real = new VirtualClock(1_000);
  const clock = new ScaledClock(T0, 60, real);
  assert.equal(clock.now(), T0);
  real.advance(1_000);
  assert.equal(clock.now(), T0 + 60_000);
  assert.throws(() => new ScaledClock(T0, 0, real), RangeError);
});

class FakeReader implements VenueReader {
  readonly id = 'hyperliquid' as const;
  readonly #clock: VirtualClock;
  constructor(clock: VirtualClock) {
    this.#clock = clock;
  }
  async markets(): Promise<Market[]> {
    this.#clock.advance(7);
    return [{
      venue: 'hyperliquid', symbol: 'ETH', assetIndex: 1, szDecimals: 4, lotSize: 0.0001, tickSize: null,
      maxPxDecimals: 2, maxLeverage: 25, isolatedOnly: false, delisted: false,
    }];
  }
  async funding(): Promise<MarketFunding[]> {
    this.#clock.advance(3);
    return fundingAt(this.#clock.now() / 1e17);
  }
  async book(symbol: string): Promise<Book> {
    this.#clock.advance(2);
    if (symbol === 'BAD') throw new Error('hyperliquid l2Book: unknown coin BAD');
    return book(symbol, 2000 + (this.#clock.now() - T0));
  }
  async account(address: string): Promise<AccountState> {
    return { venue: 'hyperliquid', address, time: this.#clock.now(), equityUsd: 1, freeMarginUsd: 1, maintenanceMarginUsd: 0, positions: [] };
  }
}

test('record to .jsonl.gz, then replay gives back exactly what was recorded', async () => {
  const path = join(dir, 'roundtrip.jsonl.gz');
  const clock = new VirtualClock(T0);
  const writer = new JsonlGzWriter(path);
  const rec = new RecordingVenue(new FakeReader(clock), writer, clock);
  const seen: { t: number; funding: MarketFunding[]; book: Book }[] = [];
  const markets = await rec.markets();
  for (let i = 0; i < 5; i++) {
    clock.advance(5_000);
    const funding = await rec.funding();
    const b = await rec.book('ETH');
    seen.push({ t: clock.now(), funding, book: b });
  }
  await assert.rejects(rec.book('BAD'), /unknown coin BAD/);
  await rec.account('0xabc');
  await writer.flush();
  await writer.close();
  assert.equal(writer.lines, 13);

  const lines = readRecording(path);
  assert.equal(lines.length, 13);
  assert.deepEqual(Object.keys(lines[0]!), ['t', 'venue', 'method', 'args', 'ms', 'result']);
  assert.deepEqual(lines[0], { t: T0 + 7, venue: 'hyperliquid', method: 'markets', args: [], ms: 7, result: markets });
  assert.equal(lines[11]!.error, 'hyperliquid l2Book: unknown coin BAD');

  const replayClock = new VirtualClock(T0);
  const replay = new ReplayVenue(lines, replayClock);
  replayClock.set(T0 + 7);
  assert.deepEqual(await replay.markets(), markets);
  for (const s of seen) {
    replayClock.set(s.t);
    assert.deepEqual(await replay.funding(), s.funding);
    assert.deepEqual(await replay.book('ETH'), s.book);
  }
  replayClock.set(lines[12]!.t);
  await assert.rejects(replay.book('BAD'), /unknown coin BAD/);
  assert.deepEqual((await replay.account('0xabc')).address, '0xabc');
});

test('the writer never overwrites an existing file', () => {
  const path = join(dir, 'exists.jsonl.gz');
  writeFileSync(path, '');
  assert.throws(() => new JsonlGzWriter(path), /already exists/);
});

test('a recording cut off mid-write still loads up to the last complete line', () => {
  const text = LINES.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const gz = gzipSync(text);
  const path = join(dir, 'cut.jsonl.gz');
  writeFileSync(path, gz.subarray(0, gz.length - 40));
  const lines = readRecording(path);
  assert.ok(lines.length < LINES.length, `expected fewer than ${LINES.length} lines, got ${lines.length}`);
  assert.deepEqual(lines, LINES.slice(0, lines.length));
});

test('malformed lines are refused with their line number', () => {
  assert.throws(() => parseRecording('{"t":1}\n', 'f'), /f:1: venue must be a string/);
  assert.throws(() => parseRecording('nope\n{"t":1}\n', 'f'), /f:1: not JSON/);
  assert.throws(
    () => parseRecording('{"t":1,"venue":"hyperliquid","method":"trade","args":[],"result":1}\n', 'f'),
    /unknown method trade/,
  );
  assert.throws(() => parseRecording('{"t":1,"venue":"hyperliquid","method":"funding","args":[]}\n', 'f'), /needs result or error/);
});
