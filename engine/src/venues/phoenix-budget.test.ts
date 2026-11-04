// The Phoenix reader under its request budget, on a fake fetch that answers from the mainnet wire recording
// (fixtures/phoenix-wire) unless a test says otherwise: 429 bursts, Retry-After, timeouts, account reads ahead of the
// scanner's book reads, and the requests it no longer makes (the funding overview once a minute, one history request
// for every market); shared reads a critical caller does not inherit a scanner failure from; and the pair trader's
// and rescuer's trader API (phoenixTraderApi) on the same budget.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PhoenixHttpError } from '@ellipsis-labs/rise';
import { phoenixTraderApi } from '../trade/phoenix-leg.ts';
import { noteDeskAct } from './desk-acts.ts';
import { HostBudget, PHOENIX_BUDGET, hostBudget, isReadSkipped, scanRead } from './http-budget.ts';
import type { BudgetTimers, HostBudgetOptions } from './http-budget.ts';
import { MARKS_MAX_AGE_MS, PhoenixReader } from './phoenix.ts';
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

/**
 * PHOENIX_BUDGET's waits, retries and cool-downs on a faster bucket with no rate cut after a 429, so these tests run in
 * real time in well under a second each; the real numbers are tested on a fake clock in http-budget.test.ts.
 */
const TEST_BUDGET: HostBudgetOptions = {
  ...PHOENIX_BUDGET, ratePerSec: 5, burst: 5, criticalReserve: 1, classReserve: {}, adaptive: null, criticalFloor: null, random: () => 0,
};

/** Timers that fire only when told (the marks refresh between account reads). */
function heldTimers() {
  const due: (() => void)[] = [];
  const timers: BudgetTimers = { setTimeout: (fn) => due.push(fn), clearTimeout: () => {} };
  return { timers, fire: () => due.splice(0).forEach((fn) => fn()), armed: () => due.length };
}

function reader(f: typeof fetch, budget: Partial<HostBudgetOptions> = {}, clock = new VirtualClock(AT), timeoutMs?: number, timers = heldTimers().timers) {
  const b = new HostBudget('phoenix-test', { ...TEST_BUDGET, ...budget });
  return { reader: new PhoenixReader({ fetch: f, clock, budget: b, timers, ...(timeoutMs === undefined ? {} : { timeoutMs }) }), budget: b, clock };
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

test('funding: the overview is read once a minute (rates book hourly), the marks once 6 s old; a failed refresh serves the last one, dated', async () => {
  let overviewDown = false;
  const { f, count } = fakeFetch((url) => (overviewDown && url.pathname === '/v1/funding/overview' ? new Response('{}', { status: 502 }) : undefined));
  const clock = new VirtualClock(AT);
  const { reader: r } = reader(f, {}, clock);
  const first = await scanRead(() => r.funding());
  assert.ok(first.every((x) => x.rateReadAt === undefined));
  clock.set(AT + 5_000);
  await scanRead(() => r.funding());
  assert.equal(count('/v1/funding/overview'), 1);
  assert.equal(count('/v1/markets/stats/latest'), 1, 'the marks of 5 s ago are shared');
  clock.set(AT + 6_000);
  await scanRead(() => r.funding());
  assert.equal(count('/v1/markets/stats/latest'), 2, 'read again once 6 s old');
  clock.set(AT + 61_000);
  await scanRead(() => r.funding());
  assert.equal(count('/v1/funding/overview'), 2);
  // The overview fails: the one from a minute ago stands, every rate dated when it was read (the scanner counts the
  // rows stale); the marks are read as ever.
  overviewDown = true;
  clock.set(AT + 125_000);
  const later = await scanRead(() => r.funding());
  assert.equal(count('/v1/funding/overview'), 3);
  assert.deepEqual(later.map((x) => [x.symbol, x.ratePerHour]), first.map((x) => [x.symbol, x.ratePerHour]));
  assert.ok(later.length > 0 && later.every((x) => x.rateReadAt === AT + 61_000));
  // The next scan asks again (a failed refresh is not cached); answered, the rates are fresh.
  overviewDown = false;
  clock.set(AT + 130_000);
  const again = await scanRead(() => r.funding());
  assert.equal(count('/v1/funding/overview'), 4);
  assert.ok(again.every((x) => x.rateReadAt === undefined));
  // Past ten minutes the old overview is not served.
  overviewDown = true;
  clock.set(AT + 130_000 + 11 * 60_000);
  await assert.rejects(scanRead(() => r.funding()), PhoenixHttpError);
});

test('a critical read that joins a shared read the scanner started, which fails, reads again as itself', async () => {
  let configsDown = 1;
  let overviewDown = 1;
  const { f, count } = fakeFetch((url) => {
    if (url.pathname === '/v1/view/exchange/markets' && configsDown-- > 0) return new Response('{}', { status: 502 });
    if (url.pathname === '/v1/funding/overview' && overviewDown-- > 0) return new Response('{}', { status: 502 });
    return undefined;
  });
  const { reader: r } = reader(f);
  // The scanner starts the market configs and the overview; pair-mainnet's funding() and the risk engine's account
  // read join them while they run.
  const scan = scanRead(() => r.funding());
  const pair = r.funding();
  const risk = r.account(AUTHORITY);
  await assert.rejects(scan, PhoenixHttpError);
  const rows = await pair;
  assert.ok(rows.length > 0 && rows.every((x) => x.rateReadAt === undefined));
  assert.equal((await risk).address, AUTHORITY);
  // One read again of each, shared by both critical callers.
  assert.equal(count('/v1/view/exchange/markets'), 2);
  assert.equal(count('/v1/funding/overview'), 2);

  // The other way round, a scanner read that joins a critical one takes its answer as it is.
  const { f: f2, count: count2 } = fakeFetch();
  const { reader: r2 } = reader(f2);
  await Promise.all([r2.account(AUTHORITY), scanRead(() => r2.funding())]);
  assert.equal(count2('/v1/view/exchange/markets'), 1);
});

test('a scanner read skipped by the budget does not fail a critical read that shares it', async () => {
  const { f, count } = fakeFetch();
  // A cool-down after a 429 on a scanner book: the scanner's funding read (here waiting at most 100 ms) is skipped, the
  // cool-down running longer; the account read (15 s) waits it out.
  const { reader: r, budget } = reader(f, { maxWaitMs: { ...PHOENIX_BUDGET.maxWaitMs, funding: 100 } });
  await budget.run('book', async () => new Response('{}', { status: 429, headers: { 'retry-after': '0.3' } }));
  const scan = scanRead(() => r.funding());
  const risk = r.account(AUTHORITY);
  await assert.rejects(scan, (err: unknown) => isReadSkipped(err));
  assert.equal((await risk).address, AUTHORITY);
  assert.equal(count('/v1/view/exchange/markets'), 1, 'sent once, by the account read');
});

test('history: the scanner\'s legs of one window share one all-market request; a market it lacks or cuts short is asked for alone', async () => {
  type Series = { symbol: string; points: { timestamp: number }[] };
  const recorded = LINES.find((l) => l.url.includes('/v1/funding/overview'))!.response as { series: Series[] };
  const last = recorded.series.find((s) => s.symbol === 'SOL')!.points.at(-1)!.timestamp;
  // Three booked hours of a market (the recording has the last one; the two before are copies of it).
  const hours = (s: Series): Series => ({ ...s, points: [2, 1, 0].map((k) => ({ ...s.points.at(-1)!, timestamp: last - k * 3600 })) });
  // The batch carries three hours of every market but BTC, cut to its last one.
  const batch = { series: recorded.series.map((s) => (s.symbol === 'BTC' ? { ...s, points: s.points.slice(-1) } : hours(s))) };
  const { f, count } = fakeFetch((url) => {
    if (url.pathname === '/v1/funding/overview' && url.searchParams.has('startTime')) return new Response(JSON.stringify(batch), { status: 200 });
    if (url.pathname.startsWith('/v1/funding/overview/')) {
      const one = recorded.series.find((s) => s.symbol === decodeURIComponent(url.pathname.split('/').at(-1)!));
      return one === undefined ? new Response('{"error":"not found"}', { status: 404 }) : new Response(JSON.stringify(hours(one)), { status: 200 });
    }
    return undefined;
  });
  const { reader: r } = reader(f);
  const start = (last - 2 * 3600) * 1000;
  const end = last * 1000 + 1_800_000;
  const [a, b] = await Promise.all([
    scanRead(() => r.marketFundingHistory('SOL', start, end)),
    scanRead(() => r.marketFundingHistory('ETH', start, end)),
  ]);
  assert.deepEqual(a.map((p) => [p.symbol, p.time]), [0, 1, 2].map((k) => ['SOL', start + k * 3_600_000]));
  assert.equal(b.length, 3);
  assert.equal(count('/v1/funding/overview?'), 1, 'one request for every market of that window');
  assert.equal(count('/v1/funding/overview/'), 0);
  // BTC's series in the batch is short of the batch's hours: its own answer is used.
  const btc = await scanRead(() => r.marketFundingHistory('BTC', start, end));
  assert.equal(btc.length, 3);
  assert.equal(count('/v1/funding/overview/BTC'), 1);
  assert.equal(count('/v1/funding/overview?'), 1);
  // A market the batch lacks is asked for alone.
  await assert.rejects(scanRead(() => r.marketFundingHistory('NOPE', start, end)), /unknown symbol NOPE/);
  assert.equal(count('/v1/funding/overview/NOPE'), 1);
});

test('history: a batch whose every series was cut short from the newest end is not trusted: each market is asked for alone', async () => {
  type Series = { symbol: string; points: { timestamp: number }[] };
  const recorded = LINES.find((l) => l.url.includes('/v1/funding/overview'))!.response as { series: Series[] };
  const last = recorded.series.find((s) => s.symbol === 'SOL')!.points.at(-1)!.timestamp;
  const hoursBack = (s: Series, ks: number[]): Series => ({ ...s, points: ks.map((k) => ({ ...s.points.at(-1)!, timestamp: last - k * 3600 })) });
  // Six hours asked; every series in the batch holds only the oldest two of them, so each looks complete up to the
  // batch's newest booking, four hours before the end.
  const batch = { series: recorded.series.map((s) => hoursBack(s, [5, 4])) };
  const { f, count } = fakeFetch((url) => {
    if (url.pathname === '/v1/funding/overview' && url.searchParams.has('startTime')) return new Response(JSON.stringify(batch), { status: 200 });
    if (url.pathname.startsWith('/v1/funding/overview/')) {
      const one = recorded.series.find((s) => s.symbol === decodeURIComponent(url.pathname.split('/').at(-1)!))!;
      return new Response(JSON.stringify(hoursBack(one, [5, 4, 3, 2, 1, 0])), { status: 200 });
    }
    return undefined;
  });
  const { reader: r } = reader(f, {}, new VirtualClock(last * 1000 + 1_800_000));
  const start = (last - 5 * 3600) * 1000;
  const end = last * 1000 + 1_800_000;
  const [sol, eth] = await Promise.all(['SOL', 'ETH'].map((s) => scanRead(() => r.marketFundingHistory(s, start, end))));
  assert.equal(sol!.length, 6);
  assert.equal(eth!.length, 6);
  assert.equal(count('/v1/funding/overview?'), 1);
  assert.equal(count('/v1/funding/overview/SOL'), 1);
  assert.equal(count('/v1/funding/overview/ETH'), 1);
});

test('history outside the scanner (pair-mainnet, one symbol): asked for alone, the all-market batch never downloaded', async () => {
  const recorded = LINES.find((l) => l.url.includes('/v1/funding/overview'))!.response as { series: { symbol: string; points: { timestamp: number }[] }[] };
  const sol = recorded.series.find((s) => s.symbol === 'SOL')!;
  const { f, count } = fakeFetch((url) => {
    if (url.pathname === '/v1/funding/overview/SOL') return new Response(JSON.stringify(sol), { status: 200 });
    return undefined;
  });
  const { reader: r } = reader(f);
  const at = sol.points.at(-1)!.timestamp * 1000;
  const points = await r.marketFundingHistory('SOL', at - 7 * 86_400_000, at + 1_000);
  assert.deepEqual(points.map((p) => p.time), [at]);
  assert.equal(count('/v1/funding/overview/SOL'), 1);
  assert.equal(count('/v1/funding/overview?'), 0);
});

const TRADER_STATE = `/v1/trader/state/${AUTHORITY}`;

test('phoenixTraderApi: a 429 on the trader state is retried after Retry-After, then answered', async () => {
  let states = 0;
  const { f } = fakeFetch((url) => (url.pathname === TRADER_STATE && ++states === 1 ? limited('0.2') : undefined));
  const budget = new HostBudget('phoenix-test', TEST_BUDGET);
  const t0 = Date.now();
  const raw = await phoenixTraderApi('https://perp-api.phoenix.trade/', f, 0, budget).traderState(AUTHORITY);
  assert.equal(states, 2);
  assert.ok(Date.now() - t0 >= 190, `answered after ${Date.now() - t0} ms`);
  assert.equal(typeof raw, 'object');
  assert.equal(budget.state().rateLimited, 1);
  assert.equal(budget.state().sent, 2);

  // An hour of Retry-After is cut to the cap: the read probes after it instead of failing for an hour.
  states = 0;
  const capped = new HostBudget('phoenix-test', { ...TEST_BUDGET, retryAfterMaxMs: 200 });
  const { f: f2 } = fakeFetch((url) => (url.pathname === TRADER_STATE && ++states === 1 ? limited('3600') : undefined));
  const t1 = Date.now();
  await phoenixTraderApi('https://perp-api.phoenix.trade', f2, 0, capped).traderState(AUTHORITY);
  assert.equal(states, 2);
  assert.ok(Date.now() - t1 < 2_000, `${Date.now() - t1} ms`);
});

test('phoenixTraderApi under scanner load: its reads go first and are never skipped, in a cool-down too', async () => {
  let booksLimited = false;
  const { f, urls } = fakeFetch((url) => (booksLimited && url.pathname.startsWith('/v1/view/orderbook/') ? limited('0.3') : undefined));
  // The scanner's reader and the trader API on one budget: 20 a second, a burst of 2, one token kept for critical reads.
  const { reader: r, budget } = reader(f, { ratePerSec: 20, burst: 2 });
  const api = phoenixTraderApi('https://perp-api.phoenix.trade', f, 0, budget);
  const symbols = ['SOL', 'ETH', 'BTC', 'SOL', 'ETH', 'BTC', 'SOL', 'ETH'];
  const books = Promise.allSettled(symbols.map((s) => scanRead(() => r.book(s))));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await api.traderState(AUTHORITY);
  await books;
  const order = urls.map((u) => (u.pathname === TRADER_STATE ? 'state' : 'book'));
  assert.ok(order.indexOf('state') <= 2, order.join(' '));

  // A scanner book draws a 429: the scanner's next books are skipped unsent for the cool-down, the trader state is
  // sent after it and answered.
  booksLimited = true;
  await assert.rejects(scanRead(() => r.book('SOL')), (err: unknown) => err instanceof PhoenixHttpError && err.status === 429);
  const sent = urls.length;
  await assert.rejects(scanRead(() => r.book('ETH')), (err: unknown) => isReadSkipped(err) && err.reason === 'cooling');
  assert.equal(urls.length, sent);
  const t0 = Date.now();
  await api.traderState(AUTHORITY);
  assert.ok(Date.now() - t0 >= 250, `answered after ${Date.now() - t0} ms`);
  assert.equal(urls.at(-1)!.pathname, TRADER_STATE);
});

test('phoenixTraderApi with no budget given shares the process\'s budget for that host with the Phoenix reader', async () => {
  const origin = 'https://phoenix-shared.test';
  const { f } = fakeFetch(() => new Response('{"ok":true}', { status: 200 }));
  const shared = hostBudget(origin, PHOENIX_BUDGET);
  const before = shared.state().sent;
  await phoenixTraderApi(`${origin}/`, f).traderState(AUTHORITY);
  await new PhoenixReader({ apiUrl: origin, fetch: f }).book('SOL').catch(() => {});
  assert.equal(shared.state().sent, before + 2);
});

test('account reads: two at once share one snapshot; the loop\'s accountWithin takes the risk engine\'s last answer; the scanner takes its marks', async () => {
  const { f, count } = fakeFetch();
  const clock = new VirtualClock(AT);
  const held = heldTimers();
  const { reader: r } = reader(f, {}, clock, undefined, held.timers);
  const [a, b] = await Promise.all([r.account(AUTHORITY), r.account(AUTHORITY)]);
  assert.deepEqual(a, b);
  assert.equal(count('/v1/trader/state/'), 1, 'one snapshot for both');
  assert.equal(count('/v1/markets/stats/latest'), 1);
  // The scanner's funding 4 s later takes those marks; the strategy loop's free margin takes that account answer.
  clock.set(AT + 4_000);
  await scanRead(() => r.funding());
  assert.equal(count('/v1/markets/stats/latest'), 1, 'the marks of the account read');
  assert.deepEqual(await r.accountWithin(AUTHORITY, 7_000), a);
  assert.equal(count('/v1/trader/state/'), 1);
  // Past its age the loop reads too.
  clock.set(AT + 12_000);
  await r.accountWithin(AUTHORITY, 7_000);
  assert.equal(count('/v1/trader/state/'), 2);
});

test('a risk tick is one request: the marks come from a cache of at most 5 s, refreshed between ticks as a scanner read', async () => {
  const { f, count } = fakeFetch();
  const clock = new VirtualClock(AT);
  const held = heldTimers();
  // A bucket that never runs dry here (the budget's clock is the system's): the requests are what is counted.
  const { reader: r, budget } = reader(f, { ratePerSec: 1_000, burst: 100 }, clock, undefined, held.timers);
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  // The first tick has no marks yet: the snapshot and the marks, both critical.
  await r.account(AUTHORITY);
  assert.deepEqual([count('/v1/trader/state/'), count('/v1/markets/stats/latest')], [1, 1]);
  assert.equal(held.armed(), 1, 'the refresh is armed');
  for (let tick = 1; tick <= 4; tick++) {
    // Half way to the next tick the refresh reads the marks, from the scanner's class.
    clock.set(AT + tick * 5_000 - 2_500);
    const sentBefore = budget.state().sent;
    held.fire();
    await settle();
    await settle();
    assert.equal(count('/v1/markets/stats/latest'), 1 + tick);
    assert.equal(budget.state().sent, sentBefore + 1);
    // The tick: its snapshot alone, the marks 2.5 s old.
    clock.set(AT + tick * 5_000 + 30);
    await r.account(AUTHORITY);
    assert.deepEqual([count('/v1/trader/state/'), count('/v1/markets/stats/latest')], [1 + tick, 1 + tick], `tick ${tick}`);
  }
  // A refresh that did not come (skipped after a 429, say): marks older than 5 s are not used, the tick reads them.
  clock.set(AT + 20_030 + MARKS_MAX_AGE_MS + 3_000);
  await r.account(AUTHORITY);
  assert.deepEqual([count('/v1/trader/state/'), count('/v1/markets/stats/latest')], [6, 6]);
  // Without account reads for a while the armed refresh does nothing.
  clock.set(AT + 60_000);
  held.fire();
  await settle();
  assert.equal(count('/v1/markets/stats/latest'), 6);
});

test('the desk\'s own action (an order, a close, a rescue) ends the reuse of account answers read before it', async () => {
  let hold = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { f, count } = fakeFetch((url) => {
    if (!hold || !url.pathname.startsWith('/v1/trader/state/')) return undefined;
    const line = LINES.find((l) => l.url === url.href)!;
    return gate.then(() => new Response(JSON.stringify(line.response), { status: line.status }));
  });
  const clock = new VirtualClock(AT);
  const { reader: r } = reader(f, {}, clock);
  await r.account(AUTHORITY);
  assert.equal(count('/v1/trader/state/'), 1);
  clock.set(AT + 1_000);
  await r.accountWithin(AUTHORITY, 7_000);
  assert.equal(count('/v1/trader/state/'), 1, 'reused');
  // The relayer marks an order (venues/desk-acts.ts): the loop sizes from a fresh read.
  noteDeskAct();
  await r.accountWithin(AUTHORITY, 7_000);
  assert.equal(count('/v1/trader/state/'), 2, 'read again after the act');
  await r.accountWithin(AUTHORITY, 7_000);
  assert.equal(count('/v1/trader/state/'), 2, 'that fresh answer is reused');
  // A read in flight when the act starts is not joined after it either.
  clock.set(AT + 9_000);
  hold = true;
  const before = r.account(AUTHORITY);
  const joined = r.account(AUTHORITY);
  noteDeskAct();
  const after = r.account(AUTHORITY);
  release();
  await Promise.all([before, joined, after]);
  assert.equal(count('/v1/trader/state/'), 4, 'one for the two before the act, one after it');
});
