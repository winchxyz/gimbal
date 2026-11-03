// The Phoenix reader under its request budget, on a fake fetch that answers from the mainnet wire recording
// (fixtures/phoenix-wire) unless a test says otherwise: 429 bursts, Retry-After, timeouts, account reads ahead of the
// scanner's book reads, and the requests it no longer makes (the funding overview once a minute, one history request
// for every market).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PhoenixHttpError } from '@ellipsis-labs/rise';
import { HostBudget, PHOENIX_BUDGET, isReadSkipped, scanRead } from './http-budget.ts';
import type { HostBudgetOptions } from './http-budget.ts';
import { PhoenixReader } from './phoenix.ts';
import { VirtualClock, readWireRecording } from './replay.ts';

const DIR = fileURLToPath(new URL('../../fixtures/phoenix-wire/', import.meta.url));
const LINES = readWireRecording(join(DIR, 'phoenix-mainnet-2026-10-31.jsonl.gz'));
const AUTHORITY = 'EibQ2VYpzj18qSdEBkmxWVzde7FzamTxVG9rZyY689Yj';
const AT = LINES[0]!.t;

type Answer = Response | Promise<Response> | undefined;

/** Recorded answers by URL; `rule` answers first when it returns something. Every URL asked is kept, in order. */
function fakeFetch(rule: (url: URL, signal: AbortSignal | undefined) => Answer = () => undefined) {
  const urls: URL[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url);
    const ruled = rule(url, init?.signal ?? undefined);
    if (ruled !== undefined) return ruled;
    const line = LINES.find((l) => l.url === url.href);
    if (line === undefined) return new Response('{"error":"not recorded"}', { status: 404 });
    return new Response(JSON.stringify(line.response), { status: line.status });
  }) as typeof fetch;
  const count = (part: string) => urls.filter((u) => u.href.includes(part)).length;
  return { f, urls, count };
}

const limited = (retryAfter?: string) => new Response('{"error":"rate_limited"}', {
  status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
});

function reader(f: typeof fetch, budget: Partial<HostBudgetOptions> = {}, clock = new VirtualClock(AT), timeoutMs?: number) {
  const b = new HostBudget('phoenix-test', { ...PHOENIX_BUDGET, random: () => 0, ...budget });
  return { reader: new PhoenixReader({ fetch: f, clock, budget: b, ...(timeoutMs === undefined ? {} : { timeoutMs }) }), budget: b, clock };
}

test('a 429 burst on books: the scanner\'s read is sent once, the next ones are skipped unsent, account and trader reads go through after Retry-After', async () => {
  let booksLimited = true;
  const { f, count } = fakeFetch((url) => (booksLimited && url.pathname.startsWith('/v1/view/orderbook/') ? limited('0.2') : undefined));
  const { reader: r, budget } = reader(f);
  const t0 = Date.now();
  await assert.rejects(scanRead(() => r.book('SOL')), (err: unknown) => err instanceof PhoenixHttpError && err.status === 429);
  assert.equal(count('/orderbook/'), 1, 'a scanner book is never retried');
  for (const symbol of ['ETH', 'BTC']) {
    await assert.rejects(scanRead(() => r.book(symbol)), (err: unknown) => isReadSkipped(err) && err.reason === 'cooling');
  }
  assert.equal(count('/orderbook/'), 1, 'skipped reads send nothing');

  // The risk engine's account read waits out the 0.2 s and is answered.
  const account = await r.account(AUTHORITY);
  assert.equal(account.address, AUTHORITY);
  assert.ok(Date.now() - t0 >= 190, `account answered after ${Date.now() - t0} ms`);

  // The pair trader's book read (outside the scanner) is critical: sent and answered while scanner books still stand
  // aside for the quiet period.
  booksLimited = false;
  const book = await r.book('SOL');
  assert.ok(book.bids.length > 0);
  await assert.rejects(scanRead(() => r.book('ETH')), (err: unknown) => isReadSkipped(err) && err.reason === 'cooling');
  assert.ok(budget.state().quietUntil > Date.now() + 2_000);
});

test('Retry-After on a trader-state read: retried once after the pause, then answered', async () => {
  let snapshots = 0;
  const { f } = fakeFetch((url) => (url.pathname.startsWith('/v1/trader/state/') && ++snapshots === 1 ? limited('0.3') : undefined));
  const { reader: r } = reader(f);
  const t0 = Date.now();
  const account = await r.account(AUTHORITY);
  assert.equal(snapshots, 2);
  assert.ok(Date.now() - t0 >= 290, `answered after ${Date.now() - t0} ms`);
  assert.ok(account.positions.some((p) => p.symbol === 'SOL'));
});

test('a 429 without Retry-After on a trader-state read: backoff with jitter, then answered', async () => {
  let snapshots = 0;
  const { f } = fakeFetch((url) => (url.pathname.startsWith('/v1/trader/state/') && ++snapshots <= 2 ? limited() : undefined));
  const { reader: r, budget } = reader(f, { backoffBaseMs: 100 });
  const t0 = Date.now();
  await r.account(AUTHORITY);
  assert.equal(snapshots, 3);
  // 100 × 0.5 then 200 × 0.5 at the lowest jitter.
  assert.ok(Date.now() - t0 >= 140, `answered after ${Date.now() - t0} ms`);
  // The run of 429s outlives an answer inside the quiet period: another 429 soon would wait longer still.
  assert.equal(budget.state().rateLimited, 2);
});

test('a book that never answers fails at the timeout and frees its slot: the account read is not held up', async () => {
  const hang = (signal: AbortSignal | undefined) => new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  });
  const { f } = fakeFetch((url, signal) => (url.pathname.startsWith('/v1/view/orderbook/') ? hang(signal) : undefined));
  const { reader: r } = reader(f, { maxInFlight: 2, scanMaxInFlight: 1 }, new VirtualClock(AT), 100);
  const t0 = Date.now();
  const books = Promise.allSettled(['SOL', 'ETH'].map((s) => scanRead(() => r.book(s))));
  const account = await r.account(AUTHORITY);
  assert.equal(account.address, AUTHORITY);
  const settled = await books;
  assert.ok(settled.every((s) => s.status === 'rejected'));
  assert.ok(Date.now() - t0 < 2_000, `${Date.now() - t0} ms`);
});

test('account reads go ahead of the scanner\'s queued book reads', async () => {
  const { f, urls } = fakeFetch();
  // Slow enough that the books queue: 20 a second, a burst of 2, one token kept for critical reads.
  const { reader: r } = reader(f, { ratePerSec: 20, burst: 2 });
  await r.markets();       // the configs are cached; the account read then needs the snapshot and the marks
  await new Promise((resolve) => setTimeout(resolve, 150));
  const symbols = ['SOL', 'ETH', 'BTC', 'SOL', 'ETH', 'BTC'];
  const books = Promise.allSettled(symbols.map((s) => scanRead(() => r.book(s))));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await r.account(AUTHORITY);
  await books;
  const order = urls.slice(1).map((u) => (u.pathname.includes('/orderbook/') ? 'book' : u.pathname.includes('/trader/state/') ? 'state' : 'stats'));
  assert.ok(order.indexOf('state') < 3, order.join(' '));
  assert.ok(order.indexOf('stats') < 3, order.join(' '));
  assert.equal(order.filter((o) => o === 'book').length, 6, 'the books are read too, after');
});

test('funding: the overview is read once a minute (rates book hourly), the marks on every call; a failed refresh serves the last one', async () => {
  let overviewDown = false;
  const { f, count } = fakeFetch((url) => (overviewDown && url.pathname === '/v1/funding/overview' ? new Response('{}', { status: 502 }) : undefined));
  const clock = new VirtualClock(AT);
  const { reader: r } = reader(f, {}, clock);
  const first = await scanRead(() => r.funding());
  clock.set(AT + 5_000);
  await scanRead(() => r.funding());
  assert.equal(count('/v1/funding/overview'), 1);
  assert.equal(count('/v1/markets/stats/latest'), 2);
  clock.set(AT + 61_000);
  await scanRead(() => r.funding());
  assert.equal(count('/v1/funding/overview'), 2);
  // The overview fails: the one from a minute ago stands, the marks are read as ever.
  overviewDown = true;
  clock.set(AT + 125_000);
  const later = await scanRead(() => r.funding());
  assert.equal(count('/v1/funding/overview'), 3);
  assert.deepEqual(later.map((x) => [x.symbol, x.ratePerHour]), first.map((x) => [x.symbol, x.ratePerHour]));
  // Past ten minutes the old overview is not served.
  clock.set(AT + 61_000 + 11 * 60_000);
  await assert.rejects(scanRead(() => r.funding()), PhoenixHttpError);
});

test('history: the legs of one window share one all-market request; a market it lacks is asked for alone', async () => {
  const overview = LINES.find((l) => l.url.includes('/v1/funding/overview'))!.response as { series: { symbol: string; points: { timestamp: number }[] }[] };
  const { f, count } = fakeFetch((url) => {
    if (url.pathname === '/v1/funding/overview' && url.searchParams.has('startTime')) return new Response(JSON.stringify(overview), { status: 200 });
    if (url.pathname.startsWith('/v1/funding/overview/')) return new Response('{"error":"not found"}', { status: 404 });
    return undefined;
  });
  const { reader: r } = reader(f);
  const sol = overview.series.find((s) => s.symbol === 'SOL')!.points.at(-1)!.timestamp * 1000;
  const start = sol - 3_600_000;
  const end = sol + 3_600_000;
  const [a, b] = await Promise.all([
    scanRead(() => r.marketFundingHistory('SOL', start, end)),
    scanRead(() => r.marketFundingHistory('ETH', start, end)),
  ]);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.symbol, 'SOL');
  assert.equal(b[0]!.symbol, 'ETH');
  await scanRead(() => r.marketFundingHistory('BTC', start, end));
  assert.equal(count('/v1/funding/overview?'), 1, 'one request for every market of that window');
  await assert.rejects(r.marketFundingHistory('NOPE', start, end), /unknown symbol NOPE/);
  assert.equal(count('/v1/funding/overview/NOPE'), 1);
});
