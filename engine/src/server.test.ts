// The engine server on a scanner over fake readers: GET /state, the SSE stream, /strategy and /windows/history,
// and who may call it at all.

import assert from 'node:assert/strict';
import { get, request } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';
import type { EngineState, StreamEvent, Window as FundingWindow, WindowHistory } from '@gimbal/shared';
import { VirtualClock } from './venues/replay.ts';
import type { Book, MarketFunding, VenueReader } from './venues/venue.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from './scanner/config.ts';
import { Scanner } from './scanner/scanner.ts';
import { EngineServer, isLoopback } from './server.ts';

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

async function call(
  method: string, path: string, body?: string, headers?: OutgoingHttpHeaders, setHost = true,
): Promise<{ status: number; json: unknown; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const sent = headers ?? (body === undefined ? {} : { 'content-type': 'application/json' });
    const req = request(`${base}${path}`, { method, headers: sent, setHost }, (res) => {
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
    [{ ...next, exitAfterChecks: 0 }, /^strategy: exitAfterChecks must be a whole number of hourly checks from 1 to 24/],
    [{ ...next, exitAfterChecks: 25 }, /exitAfterChecks must be a whole number of hourly checks from 1 to 24/],
    [{ ...next, enterAfterChecks: 2.5 }, /enterAfterChecks must be a whole number of hourly checks from 1 to 24/],
    [{ ...next, enterAfterChecks: '3' }, /enterAfterChecks must be a whole number/],
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

test('without a strategy loop /rotate and /close answer 503 { ok: false } (stress 503 without a risk engine); wrong methods 405; unknown paths 404', async () => {
  const rotate = await call('POST', '/rotate', '{"windowId":"sol-phoenix-hyperliquid"}');
  assert.equal(rotate.status, 503);
  assert.equal((rotate.json as { ok: boolean }).ok, false);
  assert.equal((await call('POST', '/close', '{}')).status, 503);
  assert.equal((await call('POST', '/stress', '{}')).status, 503, 'no risk engine: stress is unavailable');
  const wrong = await call('GET', '/rotate');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, 'POST');
  assert.equal((await call('POST', '/state', '{}')).status, 405);
  assert.equal((await call('GET', '/nope')).status, 404);
});

test('POST /close takes an empty body without a content type; /rotate and /close answer only on a loopback address', async () => {
  // No body, no content type: through the guard, to the loop (503 here: none).
  assert.equal((await call('POST', '/close', undefined, {})).status, 503);
  assert.equal((await call('POST', '/rotate', undefined, {})).status, 415, '/rotate needs its JSON body');
  assert.deepEqual(['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1'].map(isLoopback), [true, true, true, true, true, true]);
  assert.deepEqual(['0.0.0.0', '::', '10.0.0.5', '192.168.1.2', 'engine.example'].map(isLoopback), [false, false, false, false, false]);
  const scanner = new Scanner([reader('hyperliquid', 0.00005)], [], { config: DEFAULT_SCANNER_CONFIG, clock: new VirtualClock(T0), strategy: () => DEFAULT_STRATEGY });
  const wide = new EngineServer({ mode: 'replay', scanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, log: () => {} });
  const port = await wide.start(0, '0.0.0.0');
  try {
    const post = (path: string, body: string) => new Promise<{ status: number; json: { ok: boolean; reason: string } }>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(body);
    });
    const rot = await post('/rotate', '{"windowId":"sol-phoenix-hyperliquid"}');
    assert.equal(rot.status, 403);
    assert.match(rot.json.reason, /only while the engine listens on loopback.*it listens on 0\.0\.0\.0/);
    assert.equal((await post('/close', '{}')).status, 403);
  } finally {
    await wide.stop();
  }
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
  // An id not in memory has nothing older to page to: [] as well, not an error.
  const unknown = await call('GET', '/journal?before=nope');
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.json, []);
  assert.equal((await call('POST', '/journal', '{}')).status, 405);
});

test('it listens on 127.0.0.1 unless told otherwise', () => {
  assert.equal(server.address!.host, '127.0.0.1');
});

test('a Host that does not name this machine is refused (DNS rebinding); local names pass, with or without a port', async () => {
  const port = server.address!.port;
  for (const host of [`localhost:${port}`, 'localhost', `127.0.0.1:${port}`, '127.0.0.1', `[::1]:${port}`, '[::1]', `LOCALHOST:${port}`]) {
    assert.equal((await call('GET', '/state', undefined, { host })).status, 200, host);
  }
  for (const host of ['evil.example', `evil.example:${port}`, 'localhost.evil.example', '127.0.0.1.nip.io', `[::2]:${port}`, '0.0.0.0', 'localhost:abc']) {
    const r = await call('GET', '/state', undefined, { host });
    assert.equal(r.status, 403, host);
    assert.match((r.json as { error: string }).error, /is not this machine/);
  }
  // The SSE stream is behind the same check.
  assert.equal((await call('GET', '/events', undefined, { host: 'evil.example' })).status, 403);
  // No Host at all: Node answers 400 itself, the route is never reached.
  assert.ok([400, 403].includes((await call('GET', '/state', undefined, {}, false)).status));
});

test('a browser Origin other than the dashboard\'s is refused; the dashboard\'s own, and none, pass', async () => {
  for (const origin of ['http://localhost:5190', 'http://127.0.0.1:5190', 'http://[::1]:5190']) {
    assert.equal((await call('GET', '/state', undefined, { origin })).status, 200, origin);
  }
  for (const origin of ['http://evil.example', 'http://localhost:5191', 'https://localhost:5190', 'null', 'http://localhost:5190.evil.example']) {
    const r = await call('GET', '/state', undefined, { origin });
    assert.equal(r.status, 403, origin);
    assert.match((r.json as { error: string }).error, /is not the dashboard's/);
  }
});

test('the cross-site PUT /strategy from the review changes nothing; POST and PUT need a JSON content type', async () => {
  const before = (await call('GET', '/strategy')).json;
  const hostile = JSON.stringify({ ...DEFAULT_STRATEGY, auto: true, minNetAprPct: -1000, legUsd: 1e9, maxLeverage: 1000 });
  // As sent: a foreign Host and Origin, and a text/plain body (which a cross-site form can send without a preflight).
  assert.equal((await call('PUT', '/strategy', hostile, { host: 'evil.example', origin: 'http://evil.example', 'content-type': 'text/plain' })).status, 403);
  // Each guard holds on its own. The right Host with a foreign Origin:
  assert.equal((await call('PUT', '/strategy', hostile, { origin: 'http://evil.example', 'content-type': 'application/json' })).status, 403);
  // The right Host, no Origin, a body type a form can send (or none):
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
    const r = await call('PUT', '/strategy', hostile, type === undefined ? {} : { 'content-type': type });
    assert.equal(r.status, 415, String(type));
    assert.match((r.json as { error: string }).error, /PUT needs content-type application\/json/);
  }
  assert.equal((await call('POST', '/rotate', '{}', { 'content-type': 'text/plain' })).status, 415);
  // Everything right but the numbers: the bounds refuse them.
  const bounded = await call('PUT', '/strategy', hostile, { 'content-type': 'application/json; charset=utf-8', origin: 'http://localhost:5190' });
  assert.equal(bounded.status, 400);
  assert.match((bounded.json as { error: string }).error, /minNetAprPct must be a number from 0/);
  const huge = await call('PUT', '/strategy', JSON.stringify({ ...DEFAULT_STRATEGY, legUsd: 1e308 }));
  assert.equal(huge.status, 400);
  assert.match((huge.json as { error: string }).error, /legUsd must be a number from 10 to 100000/);
  assert.deepEqual((await call('GET', '/strategy')).json, before);
});

test('an SSE client that stops reading is dropped once too much is queued for it; a reading client stays', async () => {
  const scanner = new Scanner([reader('hyperliquid', 0.00005), reader('phoenix', 0.00001)], [], {
    config: DEFAULT_SCANNER_CONFIG, clock: new VirtualClock(T0), strategy: () => DEFAULT_STRATEGY,
  });
  const logs: string[] = [];
  const s = new EngineServer({ mode: 'replay', scanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, log: (l) => logs.push(l) });
  const port = await s.start(0);
  try {
    let received = 0;
    const reading = get(`http://127.0.0.1:${port}/events`, (res) => res.on('data', (c: Buffer) => (received += c.length)));
    reading.on('error', () => {});
    // A client that sends its request and then never reads a byte.
    const stalled = connect(port, '127.0.0.1');
    stalled.on('error', () => {});
    stalled.pause();
    stalled.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    for (let i = 0; i < 400 && s.clientCount < 2; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.clientCount, 2);
    // 60 kB events until the stalled client has more than 1 MiB queued (past what the OS buffers for it).
    const summary = 'x'.repeat(60_000);
    for (let i = 0; i < 5_000 && s.clientCount === 2; i++) {
      s.publish({ type: 'health', data: { hyperliquid: { ok: true, at: T0, note: summary } } as never });
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(s.clientCount, 1, 'the stalled client is dropped, the reading one kept');
    assert.ok(logs.some((l) => /^SSE client dropped: \d+ bytes unread, over 1048576$/.test(l)), logs.join('\n'));
    assert.ok(received > 1_048_576);
    reading.destroy();
    stalled.destroy();
  } finally {
    await s.stop();
  }
});

test('refused requests are logged once a minute per kind of refusal, with a count of those left out', async () => {
  const quiet = {
    scan: async () => ({ windows: [], scan: { venues: 0, failed: [], at: T0 }, notes: { dropped: {}, unpriced: [], historyReads: 0, ms: 0 } }),
    history: () => null,
  } as unknown as Scanner;
  const logs: string[] = [];
  let now = T0;
  const s = new EngineServer({ mode: 'replay', scanner: quiet, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, now: () => now, log: (l) => logs.push(l) });
  const port = await s.start(0);
  const send = (headers: OutgoingHttpHeaders, method = 'GET', path = '/state') => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
  const refused = () => logs.filter((l) => l.startsWith('refused '));
  try {
    // A probe that varies its Host every time still writes one line a minute.
    for (let i = 0; i < 20; i++) assert.equal(await send({ host: `evil${i}.example` }), 403);
    assert.deepEqual(refused(), ['refused GET /state: host "evil0.example" is not this machine: the engine answers its own dashboard only']);
    // Another kind of refusal has its own line.
    assert.equal(await send({ origin: 'http://evil.example' }), 403);
    assert.equal(await send({ 'content-type': 'text/plain' }, 'PUT', '/strategy'), 415);
    assert.equal(await send({ 'content-type': 'text/plain' }, 'PUT', '/strategy'), 415);
    assert.equal(refused().length, 3);
    assert.equal(refused()[2], 'refused PUT /strategy: PUT needs content-type application/json');
    // A minute later the next one is logged, with the count left out since.
    now = T0 + 59_999;
    await send({ host: 'evil.example' });
    assert.equal(refused().length, 3);
    now = T0 + 60_000;
    await send({ host: 'evil.example' });
    assert.equal(refused().at(-1), 'refused GET /state: host "evil.example" is not this machine: the engine answers its own dashboard only (and 20 more like it since the last line)');
    now = T0 + 120_000;
    await send({ 'content-type': 'text/plain' }, 'POST', '/rotate');
    assert.equal(refused().at(-1), 'refused POST /rotate: POST needs content-type application/json (and 1 more like it since the last line)');
    assert.equal(refused().length, 5);
  } finally {
    await s.stop();
  }
});

test('a burst of refusals that stops still has its count logged, when the minute is up or the server stops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const quiet = {
    scan: async () => ({ windows: [], scan: { venues: 0, failed: [], at: T0 }, notes: { dropped: {}, unpriced: [], historyReads: 0, ms: 0 } }),
    history: () => null,
  } as unknown as Scanner;
  const logs: string[] = [];
  let now = T0;
  const s = new EngineServer({ mode: 'replay', scanner: quiet, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, now: () => now, log: (l) => logs.push(l) });
  const port = await s.start(0);
  const send = (headers: OutgoingHttpHeaders) => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/state', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
  const refused = () => logs.filter((l) => l.startsWith('refused '));
  let stopped = false;
  try {
    for (let i = 0; i < 5; i++) assert.equal(await send({ host: `evil${i}.example` }), 403);
    assert.equal(refused().length, 1);
    // Nothing more arrives: the four left out are counted when the minute since the logged one is up.
    t.mock.timers.tick(59_999);
    assert.equal(refused().length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(refused().slice(1), ['refused 4 more requests whose Host is not this machine since the last line']);
    // Counted once: no further line, and the next refusal after the minute is logged in full, without a count.
    t.mock.timers.tick(600_000);
    assert.equal(refused().length, 2);
    now = T0 + 60_000;
    await send({ host: 'evil.example' });
    assert.equal(refused().at(-1), 'refused GET /state: host "evil.example" is not this machine: the engine answers its own dashboard only');
    // A count still pending when the server stops is logged by stop().
    await send({ origin: 'http://evil.example' });
    await send({ origin: 'http://evil.example' });
    assert.equal(refused().length, 4);
    stopped = true;
    await s.stop();
    assert.equal(refused().at(-1), 'refused 1 more request from an Origin other than the dashboard\'s since the last line');
    assert.equal(refused().length, 5);
  } finally {
    if (!stopped) await s.stop();
  }
});

test('a scan that fails marks the windows last sent as stale, never leaves them looking current', async () => {
  let scans = 0;
  const w = { id: 'sol-phoenix-hyperliquid', stale: false } as FundingWindow;
  const failing = {
    scan: async () => {
      scans++;
      if (scans > 1) throw new Error('boom');
      return { windows: [w], scan: { venues: 2, failed: [], at: T0 }, notes: { dropped: {}, unpriced: [], historyReads: 0, ms: 0 } };
    },
    history: () => null,
  } as unknown as Scanner;
  const logs: string[] = [];
  const s = new EngineServer({ mode: 'replay', scanner: failing, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 10, log: (l) => logs.push(l) });
  await s.start(0);
  try {
    for (let i = 0; i < 400 && s.state().windows?.[0]?.stale !== true; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.state().windows![0]!.stale, true);
    assert.ok(logs.includes('scan failed: boom'));
  } finally {
    await s.stop();
  }
});
