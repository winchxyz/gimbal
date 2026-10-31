import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VirtualClock } from '../replay.ts';
import type { MarketFunding } from '../venue.ts';
import { TtlCache, WatchHttp, WatchVenueError, collect, htmlPage, num, onePerBase, optNum, optPrice, parseAnswer } from './http.ts';

const URL_ = 'https://api.example.test/v1/markets';

test('parseAnswer: JSON passes; an HTML page, non-JSON or an error status is a WatchVenueError naming the venue', () => {
  assert.deepEqual(parseAnswer('okx', URL_, 200, '{"code":"0","data":[]}'), { code: '0', data: [] });
  assert.throws(() => parseAnswer('okx', URL_, 403, '<html><head><title>Attention Required! | Cloudflare</title></head></html>'),
    (err: unknown) => err instanceof WatchVenueError && err.venue === 'okx' && err.status === 403
      && /^okx: HTTP 403 from https:\/\/api\.example\.test\/v1\/markets is an HTML page \("Attention Required! \| Cloudflare"\), not market data/.test(err.message));
  assert.throws(() => parseAnswer('gate', URL_, 200, '<!doctype html><p>not available in your region</p>'), /gate: HTTP 200 .* is an HTML page, not market data/);
  assert.throws(() => parseAnswer('gate', URL_, 200, 'upstream timeout'), /gate: HTTP 200 .* is not JSON: upstream timeout/);
  assert.throws(() => parseAnswer('gate', URL_, 200, ''), /is not JSON: \(empty body\)/);
  assert.throws(() => parseAnswer('mexc', URL_, 429, '{"msg":"too many requests"}'), (err: unknown) => err instanceof WatchVenueError && err.status === 429 && /HTTP 429/.test(err.message));
});

test('htmlPage: the title, empty for a page without one, null for JSON', () => {
  assert.equal(htmlPage('  <html><title> Just a\n moment... </title>'), 'Just a moment...');
  assert.equal(htmlPage('<html><body>x</body></html>'), '');
  assert.equal(htmlPage('{"a":1}'), null);
  assert.equal(htmlPage('[1,2]'), null);
});

test('WatchHttp: sends JSON accept headers, POST bodies as JSON, and names the venue on a failure', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const http = new WatchHttp('aevo', {
    fetch: async (input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  assert.deepEqual(await http.get(URL_), { ok: true });
  assert.deepEqual(await http.post(URL_, { type: 'meta' }), { ok: true });
  assert.equal((seen[0]!.init.headers as Record<string, string>).accept, 'application/json');
  assert.equal(seen[1]!.init.method, 'POST');
  assert.equal(seen[1]!.init.body, '{"type":"meta"}');
  assert.ok(seen.every((s) => s.init.signal instanceof AbortSignal), 'every request has a timeout');

  const down = new WatchHttp('aevo', { fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.get(URL_), /aevo: request to https:\/\/api\.example\.test\/v1\/markets failed: fetch failed/);
  const hang = new WatchHttp('aevo', {
    timeoutMs: 20,
    fetch: (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
  });
  await assert.rejects(hang.get(URL_), /aevo: no answer within 20 ms from https:\/\/api\.example\.test/);
});

test('num refuses garbage; optNum and optPrice give null instead', () => {
  assert.equal(num('0.0001', 'rate'), 0.0001);
  assert.equal(num(-0, 'rate'), 0);
  assert.ok(!Object.is(num('-0', 'rate'), -0));
  for (const bad of ['', '  ', 'abc', null, undefined, Number.NaN, Infinity, {}]) assert.throws(() => num(bad, 'rate'), /rate is not a number/);
  assert.equal(optNum(''), null);
  assert.equal(optNum(null), null);
  assert.equal(optNum('12.5'), 12.5);
  assert.equal(optPrice('0'), null);
  assert.equal(optPrice(-1), null);
  assert.equal(optPrice('77369'), 77369);
});

function mf(symbol: string, extra: Partial<MarketFunding> = {}): MarketFunding {
  return { venue: 'x', symbol, ratePerHour: 0.00001, settlement: 'hourly', nextAt: 0, markPx: 1, oraclePx: null, openInterest: 1, volume24hUsd: null, ...extra };
}

test('collect: skips rows on purpose, tolerates a few bad rows, fails when half are bad or nothing is left', () => {
  const parse = (r: string) => (r === 'skip' ? null : r === 'bad' ? (() => { throw new Error('bad row'); })() : mf(r));
  assert.deepEqual(collect('x', ['A', 'skip', 'B', 'bad', 'C'], parse).map((f) => f.symbol), ['A', 'B', 'C']);
  assert.throws(() => collect('x', ['A', 'bad'], parse), /x: 1 of 2 rows unreadable \(the answer changed shape\?\), first: bad row/);
  assert.throws(() => collect('x', [], parse), /x: no live market in the answer \(0 rows\)/);
  assert.throws(() => collect('x', ['skip', 'skip'], parse), /no live market/);
});

test('onePerBase: the lower rank wins, then the larger open interest in USD (volume without OI)', () => {
  const kept = onePerBase([
    mf('BTCUSD', { base: 'BTC', openInterest: 10, markPx: 100 }),
    mf('BTCUSDT', { base: 'BTC', openInterest: 1, markPx: 100 }),
    mf('ETHUSDT', { base: 'ETH', openInterest: null, volume24hUsd: 5 }),
    mf('ETHUSDC', { base: 'ETH', openInterest: null, volume24hUsd: 9 }),
  ], (f) => (f.symbol.endsWith('USDT') ? 0 : 1));
  assert.deepEqual(kept.map((f) => f.symbol), ['BTCUSDT', 'ETHUSDT']);
  assert.deepEqual(onePerBase([mf('A', { base: 'Z', volume24hUsd: 1, openInterest: null }), mf('B', { base: 'Z', volume24hUsd: 3, openInterest: null })]).map((f) => f.symbol), ['B']);
});

test('TtlCache: keeps a value for its TTL on the clock, and forgets a failed load', async () => {
  const clock = new VirtualClock(1_000_000);
  const cache = new TtlCache<number>(60_000, clock);
  let loads = 0;
  const load = async () => ++loads;
  assert.equal(await cache.get(load), 1);
  clock.advance(59_999);
  assert.equal(await cache.get(load), 1);
  clock.advance(1);
  assert.equal(await cache.get(load), 2);
  clock.advance(60_000);
  await assert.rejects(cache.get(() => Promise.reject(new Error('down'))), /down/);
  assert.equal(await cache.get(load), 3, 'the failed load was not kept');
});
