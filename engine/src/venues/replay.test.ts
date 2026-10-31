import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { RecordLine, WireLine } from './recorder.ts';
import { JsonlGzWriter, RecordingVenue, recordingFetch, recordingWsRequester } from './recorder.ts';
import {
  ReplayMissError, ReplayVenue, ScaledClock, VirtualClock, parseRecording, readRecording, readWireRecording, replayFetch, replayWsRequester,
} from './replay.ts';
import type { AccountState, Book, FundingPayment, Market, MarketFunding, VenueReader } from './venue.ts';

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
  async userFunding(_address: string, _startTime: number, _endTime?: number): Promise<FundingPayment[]> {
    return [];
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

const payment = (time: number, fundingUsd: number): FundingPayment =>
  ({ time, symbol: 'ETH', fundingUsd, size: 2, ratePerHour: 0.0000125, samples: null });

class FundingFakeReader extends FakeReader {
  readonly asked: unknown[][] = [];
  async userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> {
    this.asked.push([address, startTime, endTime]);
    if (address === '0xbad') throw new Error('hyperliquid info userFunding: HTTP 429 rate limited');
    return [payment(startTime, -1), payment(startTime + 3_600_000, -2)];
  }
}

test('userFunding is recorded with its window and replayed for the same window only', async () => {
  const path = join(dir, 'funding.jsonl.gz');
  const clock = new VirtualClock(T0);
  const writer = new JsonlGzWriter(path);
  const inner = new FundingFakeReader(clock);
  const rec = new RecordingVenue(inner, writer, clock);
  const open = await rec.userFunding('0xabc', 1_000);
  const closed = await rec.userFunding('0xabc', 1_000, 9_000);
  await assert.rejects(rec.userFunding('0xbad', 1_000), /HTTP 429/);
  await writer.close();
  assert.deepEqual(inner.asked, [['0xabc', 1_000, undefined], ['0xabc', 1_000, 9_000], ['0xbad', 1_000, undefined]]);

  const lines = readRecording(path);
  assert.deepEqual(lines.map((l) => [l.method, l.args]), [
    ['userFunding', ['0xabc', 1_000]], ['userFunding', ['0xabc', 1_000, 9_000]], ['userFunding', ['0xbad', 1_000]],
  ]);
  assert.equal(lines[2]!.error, 'hyperliquid info userFunding: HTTP 429 rate limited');

  const replay = new ReplayVenue(lines, new VirtualClock(lines[2]!.t));
  assert.deepEqual(await replay.userFunding('0xabc', 1_000), open);
  assert.deepEqual(await replay.userFunding('0xabc', 1_000, 9_000), closed);
  await assert.rejects(replay.userFunding('0xbad', 1_000), /HTTP 429/);
  // A window nothing was recorded for is a miss, never a guess from a neighbouring one.
  await assert.rejects(replay.userFunding('0xabc', 2_000), ReplayMissError);
  await assert.rejects(replay.userFunding('0xabc', 1_000, 9_001), ReplayMissError);
  (await replay.userFunding('0xabc', 1_000))[0]!.fundingUsd = 99;
  assert.equal((await replay.userFunding('0xabc', 1_000))[0]!.fundingUsd, -1);
});

test('every reader has a funding history (interfaces 3): an empty one is recorded and replayed as empty', async () => {
  const path = join(dir, 'no-funding.jsonl.gz');
  const clock = new VirtualClock(T0);
  const writer = new JsonlGzWriter(path);
  const rec = new RecordingVenue(new FakeReader(clock), writer, clock);
  assert.deepEqual(await rec.userFunding('0xabc', 0), []);
  await writer.close();
  assert.equal(writer.lines, 1);
  const replay = new ReplayVenue(readRecording(path), clock);
  assert.deepEqual(await replay.userFunding('0xabc', 0), []);
});

test('raw exchanges are recorded with their status, then served back by request, key order ignored', async () => {
  const clock = new VirtualClock(T0);
  const seen: string[] = [];
  const inner = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(String(init?.body));
    clock.advance(40);
    const body = JSON.parse(String(init?.body)) as { type: string; n?: number };
    if (body.type === 'broken') return new Response('null', { status: 500 });
    if (body.type === 'text') return new Response('not json at all');
    return new Response(JSON.stringify({ echo: body.type, n: body.n ?? 0 }));
  }) as typeof fetch;
  const path = join(dir, 'wire.jsonl.gz');
  const writer = new JsonlGzWriter<WireLine>(path);
  const rec = recordingFetch(inner, writer, clock);
  const url = 'https://api.example.test/info';
  const post = (f: typeof fetch, body: unknown) => f(url, { method: 'POST', body: JSON.stringify(body) });

  const first = await post(rec, { type: 'a', n: 1 });
  assert.deepEqual(await first.json(), { echo: 'a', n: 1 });            // the caller still gets a readable response
  await post(rec, { type: 'a', n: 1 });
  await post(rec, { type: 'broken' });
  await post(rec, { type: 'text' });
  await assert.rejects(rec(url, { method: 'PUT', body: '{}' }), /only POST/);
  await writer.close();

  const lines = readWireRecording(path);
  assert.deepEqual(lines.map((l) => [l.status, l.request, l.ms]), [
    [200, { type: 'a', n: 1 }, 40], [200, { type: 'a', n: 1 }, 40], [500, { type: 'broken' }, 40], [200, { type: 'text' }, 40],
  ]);
  assert.deepEqual(lines[2]!.response, null);
  assert.equal(lines[3]!.response, 'not json at all');

  const replay = replayFetch(lines);
  const sameButReordered = await post(replay, { n: 1, type: 'a' });
  assert.deepEqual(await sameButReordered.json(), { echo: 'a', n: 1 });
  const broken = await post(replay, { type: 'broken' });
  assert.equal(broken.status, 500);
  assert.equal(await broken.text(), 'null');
  assert.equal(await (await post(replay, { type: 'text' })).text(), 'not json at all');
  await assert.rejects(post(replay, { type: 'a', n: 2 }), ReplayMissError);
  await assert.rejects(replay('https://other.example.test/info', { method: 'POST', body: JSON.stringify({ type: 'a', n: 1 }) }), ReplayMissError);
  await assert.rejects(replay(url, { method: 'DELETE' }), /only POST/);
  assert.equal(seen.length, 4);                                          // replay never touched the network
});

test('the same call made again replays the next recorded answer, then repeats the last', async () => {
  const answers = [1, 2].map((n): WireLine => ({ t: T0 + n, url: 'u', request: { type: 'x' }, status: 200, ms: 1, response: { n } }));
  const replay = replayFetch(answers);
  const ask = async () => ((await (await replay('u', { method: 'POST', body: '{"type":"x"}' })).json()) as { n: number }).n;
  assert.deepEqual([await ask(), await ask(), await ask()], [1, 2, 2]);
});

test('malformed wire lines are refused with their line number', () => {
  const badFile = join(dir, 'bad-wire.jsonl.gz');
  writeFileSync(badFile, gzipSync('{"t":1,"url":"u","status":200,"request":{}}\n'));
  assert.throws(() => readWireRecording(badFile), /bad-wire.jsonl.gz:1: needs request and response/);
  writeFileSync(badFile, gzipSync('{"t":1,"method":"PATCH","url":"u","status":200,"request":null,"response":1}\n'));
  assert.throws(() => readWireRecording(badFile), /bad-wire.jsonl.gz:1: unknown method PATCH/);
});

test('GET exchanges are recorded by url (query included) and kept apart from a POST to the same url', async () => {
  const clock = new VirtualClock(T0);
  const inner = (async (input: string | URL | Request, init?: RequestInit) => {
    clock.advance(25);
    const url = String(input);
    if (url.endsWith('missing')) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify({ method: init?.method ?? 'GET', url }));
  }) as typeof fetch;
  const path = join(dir, 'wire-get.jsonl.gz');
  const writer = new JsonlGzWriter<WireLine>(path);
  const rec = recordingFetch(inner, writer, clock);
  const base = 'https://api.example.test/v1';
  await rec(`${base}/futures?a=1&b=2`);                                 // no init at all: a plain GET
  await rec(`${base}/futures?a=1&b=2`, { method: 'POST', body: '{"x":1}' });
  await rec(`${base}/missing`, { method: 'GET' });
  await writer.close();

  const lines = readWireRecording(path);
  assert.deepEqual(lines.map((l) => [l.method ?? 'POST', l.request, l.status]), [['GET', null, 200], ['POST', { x: 1 }, 200], ['GET', null, 404]]);
  const replay = replayFetch(lines);
  assert.equal(((await (await replay(`${base}/futures?a=1&b=2`)).json()) as { method: string }).method, 'GET');
  assert.equal(((await (await replay(`${base}/futures?a=1&b=2`, { method: 'POST', body: '{"x":1}' })).json()) as { method: string }).method, 'POST');
  assert.equal((await replay(`${base}/missing`)).status, 404);
  // The query is part of the call: another order or value is another call.
  await assert.rejects(replay(`${base}/futures?b=2&a=1`), ReplayMissError);
});

test('WebSocket request frames are recorded without their id and answered with the caller id on replay', async () => {
  const clock = new VirtualClock(T0);
  const inner = async (_url: string, frame: { id: string } & Record<string, unknown>) => {
    clock.advance(120);
    const params = frame.params as { symbol: string };
    return { id: frame.id, event: 'request', success: true, data: { symbol: params.symbol, asks: [[1, 2]], bids: [] } };
  };
  const path = join(dir, 'wire-ws.jsonl.gz');
  const writer = new JsonlGzWriter<WireLine>(path);
  const rec = recordingWsRequester(inner, writer, clock);
  const url = 'wss://ws.example.test/stream/abc';
  const answer = await rec(url, { id: 'book-7', event: 'request', params: { type: 'orderbook', symbol: 'PERP_SOL_USDC' } });
  assert.equal(answer.id, 'book-7');
  await writer.close();

  const lines = readWireRecording(path);
  assert.deepEqual(lines[0], {
    t: T0 + 120, method: 'WS', url, request: { event: 'request', params: { type: 'orderbook', symbol: 'PERP_SOL_USDC' } }, status: 101, ms: 120,
    response: { event: 'request', success: true, data: { symbol: 'PERP_SOL_USDC', asks: [[1, 2]], bids: [] } },
  });
  const replay = replayWsRequester(lines);
  const again = await replay(url, { id: 'other-1', event: 'request', params: { symbol: 'PERP_SOL_USDC', type: 'orderbook' } });
  assert.equal(again.id, 'other-1');
  assert.deepEqual(again.data, { symbol: 'PERP_SOL_USDC', asks: [[1, 2]], bids: [] });
  await assert.rejects(replay(url, { id: 'x', event: 'request', params: { type: 'orderbook', symbol: 'PERP_ETH_USDC' } }), ReplayMissError);
  // WS lines never answer an HTTP fetch, and HTTP lines never answer a WS request.
  await assert.rejects(replayFetch(lines)(url), ReplayMissError);
});
