// The engine server on a scanner over fake readers: GET /state, the SSE stream, /strategy and /windows/history.

import assert from 'node:assert/strict';
import { get, request } from 'node:http';
import { after, before, test } from 'node:test';
import type { EngineState, StreamEvent, WindowHistory } from '@gimbal/shared';
import { VirtualClock } from './venues/replay.ts';
import type { Book, MarketFunding, VenueReader } from './venues/venue.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from './scanner/config.ts';
import { Scanner } from './scanner/scanner.ts';
import { EngineServer } from './server.ts';

const T0 = Date.UTC(2026, 9, 31, 10, 30);

function reader(id: 'hyperliquid' | 'phoenix', ratePerHour: number): VenueReader {
  const rows: MarketFunding[] = [{
    venue: id, symbol: 'SOL', ratePerHour, settlement: 'hourly', nextAt: Date.UTC(2026, 9, 31, 11),
    markPx: 100, oraclePx: 100, openInterest: 50_000, volume24hUsd: null,
  }];
  const book: Book = { venue: id, symbol: 'SOL', time: T0, bids: [{ px: 99.99, sz: 1e4 }], asks: [{ px: 100.01, sz: 1e4 }] };
  return { id, funding: async () => rows, book: async () => book } as unknown as VenueReader;
}

let server: EngineServer;
let base: string;

before(async () => {
  const scanner = new Scanner([reader('hyperliquid', 0.00005), reader('phoenix', 0.00001)], [], {
    config: DEFAULT_SCANNER_CONFIG,
    clock: new VirtualClock(T0),
    strategy: () => server.strategy,
  });
  server = new EngineServer({
    mode: 'replay', scanner, strategy: DEFAULT_STRATEGY,
    policy: { ...emptyPolicy(), max_notional_usd: 5000 },
    intervalMs: 3_600_000,          // one scan at start; the tests drive the rest with scanOnce()
    now: () => T0 + 1,
  });
  const port = await server.start(0);
  base = `http://127.0.0.1:${port}`;
  // The loop's first scan.
  for (let i = 0; i < 100 && server.state().windows === null; i++) await new Promise((r) => setTimeout(r, 10));
});

after(async () => {
  await server.stop();
});

function emptyPolicy() {
  return {
    hl_assets: [], phoenix_markets: [], orderly_symbols: [], max_notional_usd: 0, price_band_bps: 100, oracle_max_age_s: 60,
    rescue_cap_usd_per_hour: 0, unpriced: [], unpriced_max_notional_usd: 0, max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 0,
  };
}

async function call(method: string, path: string, body?: string): Promise<{ status: number; json: unknown; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: text === '' ? null : JSON.parse(text), headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('GET /state: the mode, the latest scan and windows, the strategy with its risk distances', async () => {
  const { status, json } = await call('GET', '/state');
  assert.equal(status, 200);
  const state = json as EngineState;
  assert.equal(state.mode, 'replay');
  assert.deepEqual(state.scan, { venues: 2, failed: [], at: T0 });
  assert.deepEqual(state.windows!.map((w) => w.id), ['sol-phoenix-hyperliquid']);
  assert.deepEqual(state.strategy!.risk, { watchDistancePct: 15, rescueDistancePct: 8 });
  assert.deepEqual(state.journal, []);
  assert.equal(state.desk, null);
  assert.equal(state.at, T0 + 1);
});

test('GET /events: retry, the latest scan and windows at once, then every new event as one data message', async () => {
  const messages: StreamEvent[] = [];
  let raw = '';
  let pending = '';
  const done = new Promise<void>((resolve, reject) => {
    const req = get(`${base}/events`, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(String(res.headers['content-type']), /^text\/event-stream/);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        pending += chunk;
        // One SSE message per blank-line-terminated block; the last piece may be incomplete.
        const blocks = pending.split('\n\n');
        pending = blocks.pop()!;
        for (const block of blocks) if (block.startsWith('data: ')) messages.push(JSON.parse(block.slice(6)) as StreamEvent);
        if (messages.length >= 4) {
          req.destroy();
          resolve();
        }
      });
    });
    req.on('error', (e) => (messages.length >= 4 ? resolve() : reject(e)));
  });
  // Wait for the first two (sent on connect), then scan once more.
  for (let i = 0; i < 100 && messages.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(messages.map((m) => m.type), ['scan', 'windows']);
  await server.scanOnce();
  await done;
  assert.ok(raw.startsWith('retry: 5000\n\n'));
  assert.deepEqual(messages.map((m) => m.type), ['scan', 'windows', 'scan', 'windows']);
  const windows = messages[3]!;
  assert.equal(windows.type, 'windows');
  if (windows.type === 'windows') assert.equal(windows.data[0]!.id, 'sol-phoenix-hyperliquid');
});

test('GET and PUT /strategy: the whole config, checked; a bad one is refused and changes nothing', async () => {
  assert.deepEqual((await call('GET', '/strategy')).json, DEFAULT_STRATEGY);
  const next = { ...DEFAULT_STRATEGY, minNetAprPct: 8, legUsd: 2000, risk: { watchDistancePct: 20, rescueDistancePct: 10 } };
  const put = await call('PUT', '/strategy', JSON.stringify(next));
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, next);
  assert.deepEqual((await call('GET', '/strategy')).json, next);
  // The scanner reads it on the next scan: the windows are priced at 2000 USD a leg.
  await server.scanOnce();
  assert.ok(server.state().windows![0]!.checks.some((c) => c.text.includes('at $2,000 a leg')));

  const bad = [
    [{ ...next, extra: 1 }, /unknown field extra/],
    [{ ...next, risk: { watchDistancePct: 8, rescueDistancePct: 15 } }, /rescueDistancePct < watchDistancePct/],
    [{ ...next, legUsd: 6000 }, /over the policy cap of 5000/],
    [{ ...next, auto: 'yes' }, /auto must be a boolean/],
  ] as const;
  for (const [body, error] of bad) {
    const r = await call('PUT', '/strategy', JSON.stringify(body));
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, error);
  }
  assert.equal((await call('PUT', '/strategy', '{not json')).status, 400);
  assert.deepEqual((await call('GET', '/strategy')).json, next);
  await call('PUT', '/strategy', JSON.stringify(DEFAULT_STRATEGY));
});

test('GET /windows/history: 400 without an id, 404 for a window the last scan did not list, else the hourly series', async () => {
  assert.equal((await call('GET', '/windows/history')).status, 400);
  assert.equal((await call('GET', '/windows/history?id=sol-orderly-phoenix')).status, 404);
  const r = await call('GET', '/windows/history?id=sol-phoenix-hyperliquid');
  assert.equal(r.status, 200);
  const h = r.json as WindowHistory;
  assert.equal(h.windowId, 'sol-phoenix-hyperliquid');
  assert.equal(h.points.at(-1)!.t, Date.UTC(2026, 9, 31, 10));
});

test('routes not built yet answer 501; wrong methods 405; unknown paths 404', async () => {
  const rotate = await call('POST', '/rotate', '{}');
  assert.equal(rotate.status, 501);
  assert.equal((rotate.json as { ok: boolean }).ok, false);
  assert.equal((await call('POST', '/close', '{}')).status, 501);
  assert.equal((await call('POST', '/stress', '{}')).status, 501);
  const wrong = await call('GET', '/rotate');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, 'POST');
  assert.equal((await call('POST', '/state', '{}')).status, 405);
  assert.equal((await call('GET', '/nope')).status, 404);
});

test('publish keeps the latest of each type for /state, and the journal newest first', async () => {
  const entry = (id: string) => ({ id, t: T0, kind: 'window' as const, summary: id, numbers: {}, tx: [] });
  server.publish({ type: 'journal', data: entry('first') });
  server.publish({ type: 'journal', data: entry('second') });
  const state = (await call('GET', '/state')).json as EngineState;
  assert.deepEqual(state.journal.map((j) => j.id), ['second', 'first']);
});

test('GET /journal?before=<id>: up to 100 entries older than that id, newest first, [] past the oldest', async () => {
  const entry = (id: string) => ({ id, t: T0, kind: 'window' as const, summary: id, numbers: {}, tx: [] });
  // 250 more entries, j0 oldest ... j249 newest, on top of 'first' and 'second' from the test above.
  for (let i = 0; i < 250; i++) server.publish({ type: 'journal', data: entry(`j${i}`) });
  const ids = async (path: string) => ((await call('GET', path)).json as { id: string }[]).map((e) => e.id);
  const state = (await call('GET', '/state')).json as EngineState;
  assert.equal(state.journal.length, 100);
  assert.equal(state.journal[0]!.id, 'j249');
  assert.deepEqual(await ids('/journal'), state.journal.map((e) => e.id));
  const page = await ids('/journal?before=j150');
  assert.equal(page.length, 100);
  assert.equal(page[0], 'j149');
  assert.equal(page.at(-1), 'j50');
  assert.deepEqual(await ids('/journal?before=j10'), ['j9', 'j8', 'j7', 'j6', 'j5', 'j4', 'j3', 'j2', 'j1', 'j0', 'second', 'first']);
  assert.deepEqual(await ids('/journal?before=first'), []);
  assert.equal((await call('GET', '/journal?before=nope')).status, 404);
  assert.equal((await call('POST', '/journal', '{}')).status, 405);
});
