// The read-only view listener on a real engine server: off unless configured, the token, the SSE ticket, the
// origins, the refusal of every write, the failed-auth limit, and the redaction of every secret in the environment.

import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { connect, createServer } from 'node:net';
import { after, before, test } from 'node:test';
import type { EngineState, JournalEntry, StreamEvent } from '@gimbal/shared';
import { VirtualClock } from '../venues/replay.ts';
import type { Book, MarketFunding, VenueReader } from '../venues/venue.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from '../scanner/config.ts';
import { Scanner } from '../scanner/scanner.ts';
import { EngineServer } from '../server.ts';
import { startView } from './serve-view.ts';
import { VIEW_TOKEN_MIN_LENGTH, tokenBits, viewConfigFromEnv } from './view-config.ts';
import { maskAccount, viewRedactor, viewSecrets } from './view-redact.ts';
import { FAIL_LIMIT, FAIL_WINDOW_MS, MAX_TICKETS, STOP_WAIT_MS, TICKET_TTL_MS, ViewServer } from './view-server.ts';
import type { ViewSource } from './view-server.ts';

const T0 = Date.UTC(2026, 10, 4, 10, 30);
const TOKEN = 'v'.repeat(20) + '0123456789abcdef0123';
const ORIGIN = 'https://dash.example';

function reader(id: 'hyperliquid' | 'phoenix', ratePerHour: number): VenueReader {
  const rows: MarketFunding[] = [{
    venue: id, symbol: 'SOL', ratePerHour, settlement: 'hourly', nextAt: Date.UTC(2026, 10, 4, 11),
    markPx: 100, oraclePx: 100, openInterest: 50_000, volume24hUsd: null,
  }];
  const book: Book = { venue: id, symbol: 'SOL', time: T0, bids: [{ px: 99.99, sz: 1e4 }], asks: [{ px: 100.01, sz: 1e4 }] };
  return { id, funding: async () => rows, book: async () => book } as unknown as VenueReader;
}

let engine: EngineServer;
let enginePort: number;
const hands = { rotate: 0, close: 0, saved: 0 };

before(async () => {
  const scanner = new Scanner([reader('hyperliquid', 0.00005), reader('phoenix', 0.00001)], [], {
    config: DEFAULT_SCANNER_CONFIG,
    clock: new VirtualClock(T0),
    strategy: () => engine.strategy,
  });
  engine = new EngineServer({
    mode: 'mainnet', scanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, now: () => T0 + 1,
    saveStrategy: async () => {
      hands.saved++;
    },
    strategyLoop: {
      rotate: () => {
        hands.rotate++;
        return { ok: true };
      },
      close: () => {
        hands.close++;
        return { ok: true };
      },
    },
  });
  enginePort = await engine.start(0);
  for (let i = 0; i < 100 && engine.state().windows === null; i++) await new Promise((r) => setTimeout(r, 10));
});

after(async () => {
  await engine.stop();
});

interface Clocked {
  view: ViewServer;
  base: string;
  clock: { t: number };
  lines: string[];
  stop: () => Promise<void>;
}

async function makeView(options: {
  source?: ViewSource; env?: Record<string, string>; maxStreams?: number; requestTimeoutMs?: number;
} = {}): Promise<Clocked> {
  const clock = { t: T0 };
  const lines: string[] = [];
  const view = new ViewServer({
    source: options.source ?? engine.viewSource(), token: TOKEN, origins: [ORIGIN],
    redact: viewRedactor(options.env ?? {}), now: () => clock.t, log: (l) => lines.push(l),
    ...(options.maxStreams === undefined ? {} : { maxStreams: options.maxStreams }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const port = await view.start(0, '127.0.0.1');
  return { view, base: `http://127.0.0.1:${port}`, clock, lines, stop: () => view.stop() };
}

const auth = { authorization: `Bearer ${TOKEN}` };

function call(base: string, method: string, path: string, headers: OutgoingHttpHeaders = {}, body?: string): Promise<{ status: number; text: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, text, headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Opens /events and collects messages until `until` holds (or 2 s pass), then closes it. */
function stream(base: string, path: string, until: (m: StreamEvent[]) => boolean, headers: OutgoingHttpHeaders = {}): Promise<{ status: number; raw: string; messages: StreamEvent[] }> {
  return new Promise((resolve, reject) => {
    const messages: StreamEvent[] = [];
    let raw = '';
    let pending = '';
    const req = request(`${base}${path}`, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode!, raw, messages }));
        return;
      }
      const timer = setTimeout(() => finish(), 2000);
      const finish = () => {
        clearTimeout(timer);
        req.destroy();
        resolve({ status: 200, raw, messages });
      };
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        pending += chunk;
        const blocks = pending.split('\n\n');
        pending = blocks.pop()!;
        for (const block of blocks) if (block.startsWith('data: ')) messages.push(JSON.parse(block.slice(6)) as StreamEvent);
        if (until(messages)) finish();
      });
    });
    req.on('error', (e) => (messages.length > 0 ? resolve({ status: 200, raw, messages }) : reject(e)));
    req.end();
  });
}

async function ticket(base: string): Promise<{ ticket: string; expiresAt: number }> {
  const r = await call(base, 'GET', '/view-ticket', auth);
  assert.equal(r.status, 200, r.text);
  return JSON.parse(r.text) as { ticket: string; expiresAt: number };
}

test('off unless GIMBAL_VIEW_TOKEN is set (and long enough) and a port is given; the start line says which', async () => {
  const run = async (vars: Record<string, string>, engineHost = '127.0.0.1') => {
    const lines: string[] = [];
    const view = await startView({ env: (n) => vars[n], processEnv: vars, enginePort, engineHost, source: engine.viewSource(), log: (l) => lines.push(l), host: '127.0.0.1' });
    await view?.stop();
    return { on: view !== null, lines };
  };
  assert.deepEqual(await run({}), { on: false, lines: ['view: off'] });
  assert.deepEqual(await run({ PORT: '8080' }), { on: false, lines: ['view: off'] });
  const short = await run({ GIMBAL_VIEW_TOKEN: 'x'.repeat(VIEW_TOKEN_MIN_LENGTH - 1), PORT: '8080' });
  assert.equal(short.on, false);
  assert.match(short.lines[0]!, /^view: off: GIMBAL_VIEW_TOKEN is 31 characters, under the 32 required/);
  assert.match((await run({ GIMBAL_VIEW_TOKEN: TOKEN })).lines[0]!, /^view: off: GIMBAL_VIEW_TOKEN is set but neither GIMBAL_VIEW_PORT nor PORT is/);
  assert.match((await run({ GIMBAL_VIEW_TOKEN: TOKEN, PORT: String(enginePort) })).lines[0]!, /^view: off: the view port \d+ is the engine's own/);
  assert.match((await run({ GIMBAL_VIEW_TOKEN: TOKEN, PORT: '8080', GIMBAL_VIEW_ORIGINS: '*' })).lines[0]!, /^view: off: GIMBAL_VIEW_ORIGINS: "\*" is not an origin/);
  assert.match((await run({ GIMBAL_VIEW_TOKEN: TOKEN, PORT: '8080', GIMBAL_VIEW_ORIGINS: 'https://a.example/app' })).lines[0]!, /is not an origin/);

  // GIMBAL_VIEW_PORT wins over PORT; origins are normalised and deduplicated.
  const cfg = viewConfigFromEnv((n) => ({ GIMBAL_VIEW_TOKEN: TOKEN, PORT: '8080', GIMBAL_VIEW_PORT: '9000', GIMBAL_VIEW_ORIGINS: 'https://A.example/, https://a.example http://localhost:5190' } as Record<string, string>)[n], 8790);
  assert.deepEqual(cfg, { config: { token: TOKEN, port: 9000, origins: ['https://a.example', 'http://localhost:5190'] } });

  const port = await freePort();
  const on = await run({ GIMBAL_VIEW_TOKEN: TOKEN, PORT: String(port), GIMBAL_VIEW_ORIGINS: ORIGIN });
  assert.deepEqual(on, { on: true, lines: [`view: read-only on :${port} for origins ${ORIGIN}`] });
});

test('a guessable token keeps the view off: under 16 distinct characters and under 128 bits estimated', async () => {
  const off = (token: string) => {
    const cfg = viewConfigFromEnv((n) => ({ GIMBAL_VIEW_TOKEN: token, PORT: '8080' } as Record<string, string>)[n], 8790);
    return 'off' in cfg ? cfg.off : null;
  };
  assert.match(off('a'.repeat(64))!, /^GIMBAL_VIEW_TOKEN looks guessable \(1 distinct characters, about 0 bits/);
  assert.match(off('ab'.repeat(32))!, /looks guessable \(2 distinct characters, about 64 bits/);
  assert.match(off('abcdefgh'.repeat(5))!, /looks guessable/);
  // 16 distinct passes; so does 64 random-looking hex with one digit missing (about 250 bits).
  assert.equal(off('0123456789abcdef'.repeat(2)), null);
  assert.equal(off('3a9b17c8e2d4f6a0b5c3e1d7f9a2b4c6e8d0f1a3b5c7e9d2f4a6b8c0e1d3f5a7'.replaceAll('0', '1')), null);
  assert.equal(off(TOKEN), null);
  assert.ok(tokenBits('0123456789abcdef'.repeat(4)) === 256);
});

test('the view stays off while the control API is not on loopback', async () => {
  const port = await freePort();
  for (const host of ['0.0.0.0', '::', '10.0.0.5']) {
    const lines: string[] = [];
    const vars = { GIMBAL_VIEW_TOKEN: TOKEN, PORT: String(port) };
    const view = await startView({ env: (n) => (vars as Record<string, string>)[n], processEnv: vars, enginePort, engineHost: host, source: engine.viewSource(), log: (l) => lines.push(l), host: '127.0.0.1' });
    assert.equal(view, null, host);
    assert.deepEqual(lines, ['view: off: the control API is not on loopback']);
  }
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    const lines: string[] = [];
    const vars = { GIMBAL_VIEW_TOKEN: TOKEN, PORT: String(port) };
    const view = await startView({ env: (n) => (vars as Record<string, string>)[n], processEnv: vars, enginePort, engineHost: host, source: engine.viewSource(), log: (l) => lines.push(l), host: '127.0.0.1' });
    assert.notEqual(view, null, host);
    await view!.stop();
  }
});

test('stop() is never held open by a client: a dripped body, an idle socket, an open stream; slow requests time out', async () => {
  const v = await makeView({ requestTimeoutMs: 300 });
  const port = Number(new URL(v.base).port);
  // A request that announces 100 MB and drips it, one byte at a time.
  const drip = connect(port, '127.0.0.1');
  await new Promise<void>((r) => drip.once('connect', () => r()));
  drip.on('error', () => undefined);
  drip.resume();
  drip.write('GET /healthz HTTP/1.1\r\nHost: view\r\nContent-Length: 100000000\r\n\r\n');
  const dripping = setInterval(() => drip.write('x'), 50);
  // Headers sent slowly, never finished: the request timeout closes it.
  const slow = connect(port, '127.0.0.1');
  slow.on('error', () => undefined);
  // Read what the server sends (its 408 and the close); a paused socket would never see the close.
  slow.resume();
  await new Promise<void>((r) => slow.once('connect', () => r()));
  slow.write('GET /state HTTP/1.1\r\nHost: view\r\n');
  const slowClosed = new Promise<number>((r) => {
    const t = Date.now();
    slow.once('close', () => r(Date.now() - t));
  });
  // A live stream outlasts the request timeout: the request was complete, only the response goes on.
  const live = stream(v.base, '/events', (m) => m.some((e) => e.type === 'journal'), auth);
  for (let i = 0; i < 100 && v.view.clientCount === 0; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(v.view.clientCount, 1);
  engine.publish({ type: 'journal', data: { id: 'after-timeout', t: T0, kind: 'wait', summary: 'still streaming', numbers: {}, tx: [] } });
  assert.equal((await live).messages.find((m) => m.type === 'journal')?.data.id, 'after-timeout');
  assert.ok(await slowClosed < 3_000);

  const t = Date.now();
  await v.stop();
  clearInterval(dripping);
  assert.ok(Date.now() - t < STOP_WAIT_MS, `stop took ${Date.now() - t} ms`);
  drip.destroy();
  slow.destroy();
});

test('an error on the listener after it started is logged, never thrown', async () => {
  const v = await makeView();
  try {
    assert.doesNotThrow(() => v.view.httpServer.emit('error', new Error('boom')));
    assert.ok(v.lines.includes('view: listener error: boom'));
    assert.equal((await call(v.base, 'GET', '/healthz')).status, 200);
  } finally {
    await v.stop();
  }
});

test('a wrong or missing token is 401 and nothing is served; the right one is 200; /healthz needs none', async () => {
  let reads = 0;
  const base = engine.viewSource();
  const counting: ViewSource = {
    state: () => (reads++, base.state()),
    journal: (b) => (reads++, base.journal(b)),
    history: (id) => (reads++, base.history(id)),
    strategy: () => (reads++, base.strategy()),
    subscribe: (l) => base.subscribe(l),
  };
  const v = await makeView({ source: counting });
  try {
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}x` }, { authorization: `Bearer ${TOKEN.slice(1)}` }, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }]) {
      for (const path of ['/state', '/journal', '/strategy', '/windows/history?id=sol-phoenix-hyperliquid', '/view-ticket', '/events']) {
        const r = await call(v.base, 'GET', path, headers);
        assert.equal(r.status, 401, `${path} ${JSON.stringify(headers)}`);
        assert.equal(r.headers['www-authenticate'], 'Bearer');
        assert.doesNotMatch(r.text, /windows|strategy"|minNetAprPct/);
      }
      // A fresh client each round, so the failed-try limit does not answer instead.
      v.clock.t += FAIL_WINDOW_MS;
    }
    assert.equal(reads, 0);
    // The token in the query is no way in either.
    assert.equal((await call(v.base, 'GET', `/state?token=${TOKEN}`)).status, 401);
    assert.equal((await call(v.base, 'GET', `/events?ticket=${TOKEN}`)).status, 401);
    assert.equal(reads, 0);
    // Nothing logged carries the token or a query.
    assert.ok(v.lines.length > 0);
    for (const line of v.lines) {
      assert.ok(!line.includes(TOKEN) && !line.includes('?'), line);
    }

    v.clock.t += FAIL_WINDOW_MS;
    const ok = await call(v.base, 'GET', '/state', auth);
    assert.equal(ok.status, 200);
    assert.equal((JSON.parse(ok.text) as EngineState).mode, 'mainnet');
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal(reads, 1);
    assert.equal((await call(v.base, 'GET', '/strategy', { authorization: `bearer  ${TOKEN}` })).status, 200);
    const history = await call(v.base, 'GET', '/windows/history?id=sol-phoenix-hyperliquid', auth);
    assert.equal(history.status, 200);
    assert.equal((await call(v.base, 'GET', '/windows/history', auth)).status, 400);
    assert.equal((await call(v.base, 'GET', '/windows/history?id=nope', auth)).status, 404);

    const health = await call(v.base, 'GET', '/healthz');
    assert.deepEqual([health.status, JSON.parse(health.text)], [200, { ok: true }]);
  } finally {
    await v.stop();
  }
});

test('PUT /strategy, POST /rotate and /close, and every other write on the view port are refused; nothing changes', async () => {
  const v = await makeView();
  const strategyBefore = JSON.stringify(engine.strategy);
  try {
    const body = JSON.stringify({ ...DEFAULT_STRATEGY, auto: true });
    const json = { ...auth, 'content-type': 'application/json' };
    for (const [method, path] of [
      ['PUT', '/strategy'], ['POST', '/strategy'], ['POST', '/rotate'], ['POST', '/close'], ['POST', '/stress'], ['POST', '/setup'],
      ['POST', '/policy/draft'], ['DELETE', '/state'], ['PATCH', '/strategy'], ['POST', '/events'], ['POST', '/view-ticket'], ['PUT', '/journal'],
      ['POST', '/healthz'], ['HEAD', '/state'],
    ] as const) {
      const r = await call(v.base, method, path, json, method === 'HEAD' ? undefined : (path === '/rotate' ? JSON.stringify({ windowId: 'sol-phoenix-hyperliquid' }) : body));
      assert.ok(r.status === 404 || r.status === 405, `${method} ${path}: ${r.status}`);
      if (r.status === 405) assert.equal(r.headers.allow, 'GET');
    }
    // Paths the engine has but the view does not serve at all.
    for (const path of ['/rotate', '/close', '/stress', '/setup', '/policy/draft', '/', '/state/../rotate']) {
      assert.equal((await call(v.base, 'GET', path, auth)).status, 404, path);
    }
    assert.deepEqual(hands, { rotate: 0, close: 0, saved: 0 });
    assert.equal(JSON.stringify(engine.strategy), strategyBefore);
    // What the view is given holds readers only.
    assert.deepEqual(Object.keys(engine.viewSource()).sort(), ['history', 'journal', 'state', 'strategy', 'subscribe']);
  } finally {
    await v.stop();
  }
});

test('an SSE ticket opens /events once, only /events, and expires', async () => {
  const v = await makeView();
  try {
    assert.equal((await call(v.base, 'GET', '/view-ticket')).status, 401);
    const t = await ticket(v.base);
    assert.equal(t.expiresAt, v.clock.t + TICKET_TTL_MS);
    assert.match(t.ticket, /^\d+\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    assert.ok(!t.ticket.includes(TOKEN));

    // Not a key for the other routes.
    assert.equal((await call(v.base, 'GET', `/state?ticket=${encodeURIComponent(t.ticket)}`)).status, 401);

    const first = await stream(v.base, `/events?ticket=${encodeURIComponent(t.ticket)}`, (m) => m.length >= 2);
    assert.equal(first.status, 200);
    assert.ok(first.raw.startsWith('retry: 5000\n\n'));
    assert.deepEqual(first.messages.map((m) => m.type), ['scan', 'windows']);

    // Spent: the same ticket again is refused.
    assert.equal((await stream(v.base, `/events?ticket=${encodeURIComponent(t.ticket)}`, () => true)).status, 401);

    // A ticket with its expiry or signature changed is refused.
    const t2 = await ticket(v.base);
    const [exp, nonce, sig] = t2.ticket.split('.') as [string, string, string];
    assert.equal((await stream(v.base, `/events?ticket=${Number(exp) + 60_000}.${nonce}.${sig}`, () => true)).status, 401);
    assert.equal((await stream(v.base, `/events?ticket=${exp}.${nonce}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, () => true)).status, 401);

    // Expired: a fresh ticket, used after its TTL.
    v.clock.t += FAIL_WINDOW_MS;
    const t3 = await ticket(v.base);
    v.clock.t += TICKET_TTL_MS;
    assert.equal((await stream(v.base, `/events?ticket=${encodeURIComponent(t3.ticket)}`, () => true)).status, 401);
    // Just inside its TTL it works.
    v.clock.t += FAIL_WINDOW_MS;
    const t4 = await ticket(v.base);
    v.clock.t += TICKET_TTL_MS - 1;
    assert.equal((await stream(v.base, `/events?ticket=${encodeURIComponent(t4.ticket)}`, (m) => m.length >= 2)).status, 200);

    // The bearer header works on /events too, and a live stream gets each new event.
    for (let i = 0; i < 100 && v.view.clientCount > 0; i++) await new Promise((r) => setTimeout(r, 10));
    const live = stream(v.base, '/events', (m) => m.some((e) => e.type === 'journal'), auth);
    for (let i = 0; i < 100 && v.view.clientCount === 0; i++) await new Promise((r) => setTimeout(r, 10));
    engine.publish({ type: 'journal', data: { id: 'view-live-1', t: T0, kind: 'wait', summary: 'live entry', numbers: {}, tx: [] } });
    const got = await live;
    assert.equal(got.status, 200);
    assert.equal(got.messages.find((m) => m.type === 'journal')?.data.id, 'view-live-1');
  } finally {
    await v.stop();
  }
});

test('origins: a listed one gets CORS and its preflight; any other Origin is refused', async () => {
  const v = await makeView();
  try {
    const ok = await call(v.base, 'GET', '/state', { ...auth, origin: ORIGIN });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(ok.headers.vary, 'Origin');

    const pre = await call(v.base, 'OPTIONS', '/state', { origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(pre.headers['access-control-allow-methods'], 'GET');
    assert.equal(pre.headers['access-control-allow-headers'], 'authorization');

    for (const origin of ['https://evil.example', 'https://dash.example.evil', 'http://dash.example', 'null']) {
      const r = await call(v.base, 'GET', '/state', { ...auth, origin });
      assert.equal(r.status, 403, origin);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
      assert.doesNotMatch(r.text, /windows/);
      const p = await call(v.base, 'OPTIONS', '/state', { origin, 'access-control-request-method': 'GET' });
      assert.equal(p.status, 403, origin);
      assert.equal(p.headers['access-control-allow-origin'], undefined);
    }
    // An EventSource from the listed origin, with a ticket.
    const t = await ticket(v.base);
    const s = await stream(v.base, `/events?ticket=${encodeURIComponent(t.ticket)}`, (m) => m.length >= 1, { origin: ORIGIN });
    assert.equal(s.status, 200);
    // From another origin even a good ticket is refused.
    const t2 = await ticket(v.base);
    assert.equal((await stream(v.base, `/events?ticket=${encodeURIComponent(t2.ticket)}`, () => true, { origin: 'https://evil.example' })).status, 403);
  } finally {
    await v.stop();
  }
});

test('failed tries are limited per client; the right token is always served, a shared IP\'s failures notwithstanding', async () => {
  const v = await makeView();
  try {
    const a = { 'x-forwarded-for': '203.0.113.7' };
    const b = { 'x-forwarded-for': '203.0.113.8' };
    const bad = { authorization: 'Bearer nope' };
    for (let i = 0; i < FAIL_LIMIT; i++) assert.equal((await call(v.base, 'GET', '/state', { ...a, ...bad })).status, 401);
    const limited = await call(v.base, 'GET', '/state', { ...a, ...bad });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers['retry-after'], String(FAIL_WINDOW_MS / 1000));
    assert.equal((await call(v.base, 'GET', '/events?ticket=1.2.3', a)).status, 429);
    // The right token from that same client is served, and a good ticket too.
    assert.equal((await call(v.base, 'GET', '/state', { ...a, ...auth })).status, 200);
    const t = await ticket(v.base);
    assert.equal((await stream(v.base, `/events?ticket=${encodeURIComponent(t.ticket)}`, (m) => m.length >= 1, a)).status, 200);
    // Another client is not limited; a client cannot dodge by putting its own entry first (the proxy appends last).
    assert.equal((await call(v.base, 'GET', '/state', { ...b, ...bad })).status, 401);
    assert.equal((await call(v.base, 'GET', '/state', { 'x-forwarded-for': '198.51.100.1, 203.0.113.7', ...bad })).status, 429);
    v.clock.t += FAIL_WINDOW_MS;
    assert.equal((await call(v.base, 'GET', '/state', { ...a, ...bad })).status, 401);
  } finally {
    await v.stop();
  }
});

test('outstanding tickets are capped: a new one retires the oldest, so asking for tickets never locks the owner out', async () => {
  const v = await makeView();
  try {
    const issued = [];
    for (let i = 0; i < MAX_TICKETS + 3; i++) issued.push(await ticket(v.base));
    const open = async (t: { ticket: string }) => (await stream(v.base, `/events?ticket=${encodeURIComponent(t.ticket)}`, (m) => m.length >= 1)).status;
    // The 3 oldest were retired; the newest 8 still work, each once.
    for (const t of issued.slice(0, 3)) assert.equal(await open(t), 401);
    for (const t of issued.slice(3)) {
      assert.equal(await open(t), 200);
      for (let i = 0; i < 100 && v.view.clientCount > 0; i++) await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    await v.stop();
  }
});

test('the stream cap is checked before a ticket is spent', async () => {
  const v = await makeView({ maxStreams: 1 });
  try {
    const first = stream(v.base, '/events', (m) => m.some((e) => e.type === 'journal'), auth);
    for (let i = 0; i < 100 && v.view.clientCount === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const t = await ticket(v.base);
    assert.equal((await stream(v.base, `/events?ticket=${encodeURIComponent(t.ticket)}`, () => true)).status, 503);
    engine.publish({ type: 'journal', data: { id: 'cap-1', t: T0, kind: 'wait', summary: 'cap', numbers: {}, tx: [] } });
    await first;
    for (let i = 0; i < 100 && v.view.clientCount > 0; i++) await new Promise((r) => setTimeout(r, 10));
    // The same ticket still opens the stream once there is room.
    assert.equal((await stream(v.base, `/events?ticket=${encodeURIComponent(t.ticket)}`, (m) => m.length >= 1)).status, 200);
  } finally {
    await v.stop();
  }
});

test('redaction: no secret from the environment reaches /state, /journal or /events, even when the engine wrote it', async () => {
  const nearSecret = `ed25519:${'4'.repeat(40)}${'Zx9kQ7mP3r'.repeat(5)}`;   // the shape of a 64-byte key, 90 characters
  const env: Record<string, string> = {
    OPERATOR_PRIVATE_KEY: nearSecret,
    RELAYER_EVM_PRIVATE_KEY: `0x${'ab12'.repeat(16)}`,
    ONECLICK_API_KEY: 'oc_live_9f8e7d6c5b4a39281706',
    NEAR_AI_API_KEY: 'sk-nearai-1a2b3c4d5e6f7a8b9c0d',
    GIMBAL_VIEW_TOKEN: TOKEN,
    SOLANA_RPC_URL: 'https://solana.rpc.example/?api-key=5f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b',
    NEAR_RPC_URL: 'https://near.rpc.example/v2/0f9e8d7c6b5a49382716051423324150',
    ARBITRUM_RPC_URL: 'https://user:hunter2pass@arb.rpc.example/rpc',
    HL_API_URL: 'https://api.hyperliquid.xyz',
    GIMBAL_MODE: 'mainnet',
    GIMBAL_TRADE: '1',
    OWNER_ACCOUNT_ID: 'gimbal-owner.near',
    OPERATOR_ACCOUNT_ID: 'desk-operator.near',
    // A sub-account of the owner: it stays as it is.
    GIMBAL_CONTRACT_ID: 'desk.gimbal-owner.near',
  };
  const evmBare = env.RELAYER_EVM_PRIVATE_KEY!.slice(2);
  const secretValues = [
    env.OPERATOR_PRIVATE_KEY!, env.RELAYER_EVM_PRIVATE_KEY!, env.ONECLICK_API_KEY!, env.NEAR_AI_API_KEY!, env.GIMBAL_VIEW_TOKEN!,
    env.SOLANA_RPC_URL!, '5f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b', env.NEAR_RPC_URL!, '0f9e8d7c6b5a49382716051423324150', 'hunter2pass',
    // The variants: a NEAR key without its prefix, an EVM key without 0x and in other cases.
    nearSecret.slice('ed25519:'.length), evmBare, evmBare.toUpperCase(), `0X${evmBare.toUpperCase()}`,
  ];
  // Every secret also URL-encoded and JSON-escaped (with / as \/), as a log line or a quoted body would carry it.
  const allForms = (s: string) => [...new Set([s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1), JSON.stringify(s).slice(1, -1).replaceAll('/', '\\/')])];
  // Secrets the environment does not name, caught by their shape: a NEAR secret key, a 43-character seed, a query key.
  const unnamed = [`ed25519:${'7'.repeat(30)}${'Ab3dEf6hJk'.repeat(6)}`, `ed25519:${'5'.repeat(3)}${'Hj8kLm2nPq'.repeat(4)}`, 'QWERTY987654unnamed'];
  const implicit = 'a1b2'.repeat(16);
  const hlHash = `0x${'c3d4'.repeat(16)}`;
  const leaky = (what: string) => `${what}: failed at ${env.SOLANA_RPC_URL} and ${env.NEAR_RPC_URL} with ${env.ARBITRUM_RPC_URL}`
    + ` (key ${env.ONECLICK_API_KEY}, ${env.NEAR_AI_API_KEY}, signer ${env.OPERATOR_PRIVATE_KEY}, relayer ${env.RELAYER_EVM_PRIVATE_KEY},`
    + ` view ${env.GIMBAL_VIEW_TOKEN}) also ${unnamed[0]} and seed ${unnamed[1]} via https://other.example/x?apikey=${unnamed[2]}&chain=1;`
    + ` bare ${nearSecret.slice(8)}, ${evmBare.toUpperCase()}, 0X${evmBare.toUpperCase()}, ${evmBare.slice(0, 32)}${evmBare.slice(32).toUpperCase()};`
    + ` encoded ${encodeURIComponent(env.SOLANA_RPC_URL!)} ${encodeURIComponent(nearSecret)} ${encodeURIComponent(env.NEAR_AI_API_KEY!)};`
    + ` quoted ${JSON.stringify({ rpc: env.NEAR_RPC_URL, key: env.ONECLICK_API_KEY }).replaceAll('/', '\\/')};`
    + ` paused by ${env.OPERATOR_ACCOUNT_ID} for ${env.OWNER_ACCOUNT_ID}. see https://nearblocks.io/address/${env.OWNER_ACCOUNT_ID}`
    + ` and implicit ${implicit}; contract ${env.GIMBAL_CONTRACT_ID}; fill https://app.hyperliquid.xyz/explorer/tx/${hlHash}`;
  const tx = { chain: 'near' as const, id: 'Gx7tx', url: 'https://nearblocks.io/txns/Gx7tx' };
  const hlTx = { chain: 'hyperliquid' as const, id: hlHash, url: `https://app.hyperliquid.xyz/explorer/tx/${hlHash}` };
  const entry = (id: string): JournalEntry => ({ id, t: T0, kind: 'error', summary: leaky('journal'), why: leaky('why'), numbers: { venue: 'phoenix', detail: leaky('number') }, tx: [tx, hlTx] });

  // The view's own engine, so these entries do not show in the other tests.
  const scanner = new Scanner([reader('hyperliquid', 0.00005), reader('phoenix', 0.00001)], [], {
    config: DEFAULT_SCANNER_CONFIG, clock: new VirtualClock(T0), strategy: () => DEFAULT_STRATEGY,
  });
  const leakyEngine = new EngineServer({ mode: 'mainnet', scanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, now: () => T0 + 1 });
  leakyEngine.publish({ type: 'journal', data: entry('leak-1') });
  leakyEngine.publish({ type: 'setup', data: { deskId: 'd1', steps: [{ step: 'orderly_add_key', status: 'failed', detail: leaky('setup'), tx: [] }] } });
  leakyEngine.publish({ type: 'decision', data: { action: 'wait', reason: leaky('decision'), windowId: null, heldId: null, at: T0 } });
  leakyEngine.publish({ type: 'health', data: { hyperliquid: 'ok', phoenix: 'ok', orderly: 'ok', intents: 'ok', near: 'slow' } });
  leakyEngine.publish({ type: 'desk', data: {
    deskId: 'canary', owner: env.OWNER_ACCOUNT_ID!, contract: env.GIMBAL_CONTRACT_ID!, mode: 'mainnet', legs: [], netDelta: 0,
    equityUsd: 100, reserveUsd: 10, pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 }, health: 'level',
    paused: { by: env.OPERATOR_ACCOUNT_ID!, at: T0 },
    rescueFailure: { rescueId: 'r1', step: 'sign', reason: leaky('rescue'), tries: 1, next: `ask ${env.OWNER_ACCOUNT_ID}`, at: T0 }, updatedAt: T0,
  } });

  const v = await makeView({ source: leakyEngine.viewSource(), env });
  try {
    const state = await call(v.base, 'GET', '/state', auth);
    const journal = await call(v.base, 'GET', '/journal', auth);
    const t = await ticket(v.base);
    const live = stream(v.base, `/events?ticket=${encodeURIComponent(t.ticket)}`, (m) => m.some((e) => e.type === 'journal'));
    for (let i = 0; i < 100 && v.view.clientCount === 0; i++) await new Promise((r) => setTimeout(r, 10));
    leakyEngine.publish({ type: 'journal', data: entry('leak-2') });
    const events = await live;
    assert.deepEqual(events.messages.map((m) => m.type), ['desk', 'health', 'setup', 'decision', 'journal']);

    // Each payload as served, and as a client decodes it (every string in it, the JSON escapes undone).
    const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings)
      : v !== null && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
    const payloads = {
      state: state.text, journal: journal.text, events: events.raw,
      'state decoded': strings(JSON.parse(state.text)).join('\n'),
      'journal decoded': strings(JSON.parse(journal.text)).join('\n'),
      'events decoded': events.messages.flatMap(strings).join('\n'),
    };
    const owner = /(?<![A-Za-z0-9_.-])(gimbal-owner|desk-operator)\.near(?![A-Za-z0-9_-])/;
    for (const [name, text] of Object.entries(payloads)) {
      for (const secret of [...secretValues, ...unnamed].flatMap(allForms)) assert.ok(!text.includes(secret), `${name} leaks ${secret.slice(0, 12)}…`);
      assert.doesNotMatch(text, new RegExp(evmBare, 'i'), `${name} leaks the EVM key in some case`);
      // And every value the redactor took from the environment.
      for (const [secret] of viewSecrets(env)) assert.ok(!text.includes(secret), `${name} leaks ${secret.slice(0, 12)}…`);
      // The accounts are masked, wherever they stand alone.
      assert.doesNotMatch(text, owner, `${name} names an account`);
      assert.ok(!text.includes(implicit), `${name} names the implicit account`);
      assert.ok(text.includes(maskAccount(implicit)));
      assert.ok(text.includes('https://nearblocks.io/address/gimb…near'));
      // What a viewer should see stays: the text around them, the RPC origins, the contract, the tx links, the mode.
      assert.match(text, /failed at https:\/\/solana\.rpc\.example\/…/);
      assert.ok(text.includes('https://near.rpc.example/…'));
      assert.ok(text.includes('https://nearblocks.io/txns/Gx7tx'));
      assert.ok(text.includes(`https://app.hyperliquid.xyz/explorer/tx/${hlHash}`));
      assert.ok(text.includes('contract desk.gimbal-owner.near;'));
      assert.ok(text.includes('&chain=1'));
    }
    const s = JSON.parse(state.text) as EngineState;
    assert.equal(s.mode, 'mainnet');
    assert.equal(s.journal[0]!.numbers.venue, 'phoenix');
    assert.deepEqual(s.journal[0]!.tx, [tx, hlTx]);
    assert.equal(s.health!.near, 'slow');
    assert.equal(s.desk!.owner, 'gimb…near');
    assert.equal(s.desk!.paused!.by, 'desk…near');
    assert.equal(s.desk!.contract, env.GIMBAL_CONTRACT_ID);
    assert.equal(s.desk!.deskId, 'canary');
    assert.equal(s.desk!.rescueFailure!.next, 'ask gimb…near');
    // The engine's own data is untouched: the view cuts its copy only.
    assert.ok(leakyEngine.state().journal[0]!.summary.includes(env.ONECLICK_API_KEY!));
  } finally {
    await v.stop();
    await leakyEngine.stop().catch(() => undefined);
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}
