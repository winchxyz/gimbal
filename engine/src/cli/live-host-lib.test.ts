// The public live view's host: what it refuses (every write, never forwarded), what it 404s, that the token never
// leaves it (no response, no log line), that visitor headers never reach the engine, one upstream stream for any
// number of visitors, the visitor caps, the cache and the request budget, the reconnect, the not-configured state,
// and what it cuts from the engine's payloads before the public sees them.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { DeskState, EngineState, JournalEntry, StreamEvent } from '@gimbal/shared';
import { viewRedactor } from '../view/view-redact.ts';
import { ViewServer } from '../view/view-server.ts';
import type { ViewSource } from '../view/view-server.ts';
import type { LiveHostServer, LiveUpstreamOptions } from './live-host-lib.ts';
import {
  LIVE_BUILD_MARKER, LIVE_READ_ONLY_REASON, LiveUpstream, NOT_CONFIGURED_REASON, createLiveHostServer, isLiveBuild, liveConfigFromEnv, liveRoute,
  liveStaticFile, publicCutter, publicEvent, publicSetup, publicState,
} from './live-host-lib.ts';

const TOKEN = 'b7e2c94f1a6d38e05c7b9a2f4e81d6c3a5f0b9e7';
const T0 = Date.UTC(2026, 10, 6, 12);

const webDir = mkdtempSync(join(tmpdir(), 'gimbal-live-web-'));
mkdirSync(join(webDir, 'assets'));
writeFileSync(join(webDir, 'index.html'), `<!doctype html><html><head>${LIVE_BUILD_MARKER}</head><body>live</body></html>`);
writeFileSync(join(webDir, 'assets', 'app-1.js'), 'console.log(1)');
after(() => rmSync(webDir, { recursive: true, force: true }));

const desk = (): DeskState => ({
  deskId: 'gimbal-desk', owner: 'owner-account.near', contract: 'gimbal.near', mode: 'mainnet', legs: [], netDelta: 0, equityUsd: 40,
  reserveUsd: 20, pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 }, health: 'level', paused: null, rescueFailure: null, updatedAt: T0,
});
const entry = (id: string, summary: string): JournalEntry => ({ id, t: T0, kind: 'wait', summary, numbers: {}, tx: [] });

/** A stand-in engine behind a real ViewServer: counts its reads, and emits events on demand. */
function fakeEngine(extra: Partial<EngineState> = {}) {
  const listeners = new Set<(e: StreamEvent) => void>();
  const reads = { state: 0, strategy: 0, journal: 0, history: 0 };
  const state = (): EngineState => ({
    mode: 'mainnet', windows: [], scan: { venues: 3, failed: [], at: T0 }, strategy: null, desk: desk(), journal: [entry('loop-1', 'waiting for a window')],
    rescue: null, setup: null, health: null, decision: null, at: T0, ...extra,
  });
  const source: ViewSource = {
    state: () => {
      reads.state++;
      return state();
    },
    strategy: () => {
      reads.strategy++;
      return { auto: true, minNetAprPct: 10, legUsd: 12, maxLeverage: 2, stopDrawdownPct: null, rotate: { minGainPts: 5, forHours: 3 }, risk: { watchDistancePct: 15, rescueDistancePct: 8 }, enterAfterChecks: 3, exitAfterChecks: 6 };
    },
    journal: () => {
      reads.journal++;
      return [];
    },
    history: (id) => {
      reads.history++;
      return id === 'none' ? null : { windowId: id, points: [] };
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { source, reads, emit: (e: StreamEvent) => listeners.forEach((l) => l(e)) };
}

interface Running {
  host: LiveHostServer;
  base: string;
  upstream: LiveUpstream | null;
  lines: string[];
  stop(): Promise<void>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}

async function startHost(engineBase: string | null, opts: Partial<LiveUpstreamOptions> & { maxStreams?: number; maxStreamsPerClient?: number; stream?: boolean; token?: string } = {}): Promise<Running> {
  const lines: string[] = [];
  const { maxStreams, maxStreamsPerClient, stream = true, token = TOKEN, ...up } = opts;
  const upstream = engineBase === null ? null : new LiveUpstream({ base: engineBase, token, log: (l) => lines.push(l), backoff: () => 50, ...up });
  const host = createLiveHostServer({
    webDir, upstream, offReason: engineBase === null ? 'GIMBAL_LIVE_URL and GIMBAL_VIEW_TOKEN are not set' : null, log: (l) => lines.push(l),
    ...(maxStreams === undefined ? {} : { maxStreams }), ...(maxStreamsPerClient === undefined ? {} : { maxStreamsPerClient }),
  });
  const port = await listen(host);
  if (stream) upstream?.start();
  return {
    host, base: `http://127.0.0.1:${port}`, upstream, lines,
    stop: async () => {
      upstream?.stop();
      host.dropStreams();
      host.closeAllConnections();
      await new Promise<void>((r) => host.close(() => r()));
    },
  };
}

async function startView(source: ViewSource, env: Record<string, string> = {}): Promise<{ view: ViewServer; base: string; lines: string[] }> {
  const lines: string[] = [];
  const view = new ViewServer({ source, token: TOKEN, origins: [], redact: viewRedactor(env), log: (l) => lines.push(l) });
  const port = await view.start(0, '127.0.0.1');
  return { view, base: `http://127.0.0.1:${port}`, lines };
}

interface Reply {
  status: number;
  text: string;
  headers: IncomingHttpHeaders;
}

function call(base: string, method: string, path: string, headers: OutgoingHttpHeaders = {}, body?: string): Promise<Reply> {
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

interface Visitor {
  status: number;
  raw: () => string;
  events: () => StreamEvent[];
  ended: Promise<void>;
  close(): void;
}

/** Opens a visitor's /events and keeps it open until close(). */
function visit(base: string, headers: OutgoingHttpHeaders = {}): Promise<Visitor> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let endedResolve: () => void = () => undefined;
    const ended = new Promise<void>((r) => (endedResolve = r));
    const req = request(`${base}/events`, { headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => (raw += c));
      res.on('end', endedResolve);
      res.on('close', endedResolve);
      resolve({
        status: res.statusCode!,
        raw: () => raw,
        events: () => raw.split('\n\n').slice(0, -1).filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as StreamEvent),
        ended,
        close: () => req.destroy(),
      });
    });
    req.on('error', (e) => (raw === '' ? reject(e) : endedResolve()));
    req.end();
  });
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A plain HTTP server standing in for the engine's view, recording what reaches it. */
async function rawEngine(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ base: string; seen: { method: string; url: string; headers: IncomingHttpHeaders }[]; server: Server }> {
  const seen: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    handler(req, res);
  });
  const port = await listen(server);
  return { base: `http://127.0.0.1:${port}`, seen, server };
}

const closeServer = async (server: Server): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
};

// ---------- routes ----------

test('every write is refused at the host; only the dashboard\'s reads are routed to the engine', () => {
  const writes: [string, string][] = [
    ['POST', '/rotate'], ['POST', '/close'], ['POST', '/stress'], ['POST', '/pause'], ['POST', '/resume'], ['PUT', '/strategy'], ['POST', '/strategy'],
    ['POST', '/policy/draft'], ['POST', '/setup'], ['DELETE', '/state'], ['POST', '/events'], ['PATCH', '/journal'], ['POST', '/close/'], ['OPTIONS', '/state'],
  ];
  for (const [m, p] of writes) {
    const r = liveRoute(m, p);
    assert.equal(r.kind, 'refuse', `${m} ${p}`);
    if (r.kind === 'refuse') {
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.ok(r.body.reason.includes(LIVE_READ_ONLY_REASON));
    }
  }
  assert.equal((liveRoute('POST', '/') as { status: number }).status, 405);
  assert.equal((liveRoute('PUT', '/assets/app-1.js') as { status: number }).status, 405);

  assert.deepEqual(liveRoute('GET', '/state'), { kind: 'read', key: '/state' });
  assert.deepEqual(liveRoute('HEAD', '/strategy/'), { kind: 'read', key: '/strategy' });
  assert.deepEqual(liveRoute('GET', '/state', new URLSearchParams('token=x&a=b')), { kind: 'read', key: '/state' }, 'a visitor\'s query is never forwarded');
  assert.deepEqual(liveRoute('GET', '/journal'), { kind: 'read', key: '/journal' });
  assert.deepEqual(liveRoute('GET', '/journal', new URLSearchParams('before=loop-1a&x=1')), { kind: 'read', key: '/journal?before=loop-1a' });
  assert.deepEqual(liveRoute('GET', '/windows/history', new URLSearchParams('id=SOL hl/phoenix'.replace(' ', '+'))), { kind: 'refuse', status: 400, body: { ok: false, error: 'bad request', reason: 'GET /windows/history needs ?id=<window id>' } });
  assert.deepEqual(liveRoute('GET', '/windows/history', new URLSearchParams('id=SOL:hyperliquid/phoenix')), { kind: 'read', key: '/windows/history?id=SOL%3Ahyperliquid%2Fphoenix' });
  assert.equal((liveRoute('GET', '/windows/history') as { status: number }).status, 400);
  assert.deepEqual(liveRoute('GET', '/events'), { kind: 'events' });
  assert.deepEqual(liveRoute('GET', '/healthz'), { kind: 'health' });
  assert.deepEqual(liveRoute('GET', '/'), { kind: 'static' });
  assert.deepEqual(liveRoute('GET', '/assets/app-1.js'), { kind: 'static' });

  for (const p of ['/rotate', '/close', '/stress', '/pause', '/policy', '/policy/draft', '/setup', '/view-ticket', '/windows', '/journal/x', '/events/x', '/control/x']) {
    const r = liveRoute('GET', p);
    assert.equal(r.kind === 'refuse' && r.status, 404, `GET ${p}`);
  }
});

test('static files: index at /, files under web/dist only, anything else 404', () => {
  assert.equal(liveStaticFile(webDir, '/'), join(webDir, 'index.html'));
  assert.equal(liveStaticFile(webDir, '/assets/app-1.js'), join(webDir, 'assets', 'app-1.js'));
  for (const p of ['/desk', '/assets/none.js', '/../package.json', '/%2e%2e/x', '/%00', '/assets']) assert.equal(liveStaticFile(webDir, p), null, p);
  assert.equal(isLiveBuild(`<head>${LIVE_BUILD_MARKER}</head>`), true);
  assert.equal(isLiveBuild('<meta name="gimbal-build" content="hosted-replay">'), false);
});

test('the configuration: both variables, an https origin, names only in every reason', () => {
  assert.deepEqual(liveConfigFromEnv(() => undefined), { off: 'GIMBAL_LIVE_URL and GIMBAL_VIEW_TOKEN are not set' });
  const env = (vars: Record<string, string>) => (n: string) => vars[n];
  assert.deepEqual(liveConfigFromEnv(env({ GIMBAL_VIEW_TOKEN: TOKEN })), { off: 'GIMBAL_LIVE_URL is not set' });
  assert.deepEqual(liveConfigFromEnv(env({ GIMBAL_LIVE_URL: 'https://engine.example' })), { off: 'GIMBAL_VIEW_TOKEN is not set' });
  assert.deepEqual(liveConfigFromEnv(env({ GIMBAL_LIVE_URL: 'https://engine.example/', GIMBAL_VIEW_TOKEN: TOKEN })), { config: { base: 'https://engine.example', token: TOKEN } });
  assert.deepEqual(liveConfigFromEnv(env({ GIMBAL_LIVE_URL: 'http://127.0.0.1:9000', GIMBAL_VIEW_TOKEN: TOKEN })), { config: { base: 'http://127.0.0.1:9000', token: TOKEN } });
  for (const bad of ['http://engine.example', 'https://engine.example/v1', 'https://u:p@engine.example', 'https://engine.example?k=1', 'engine.example']) {
    const r = liveConfigFromEnv(env({ GIMBAL_LIVE_URL: bad, GIMBAL_VIEW_TOKEN: TOKEN }));
    assert.ok('off' in r, bad);
    if ('off' in r) assert.ok(!r.off.includes(TOKEN) && !r.off.includes('engine.example'), r.off);
  }
  const spaced = liveConfigFromEnv(env({ GIMBAL_LIVE_URL: 'https://engine.example', GIMBAL_VIEW_TOKEN: 'two words here' }));
  assert.ok('off' in spaced && !spaced.off.includes('words'));
});

// ---------- not configured ----------

test('with no engine configured the page still serves and says so; reads answer 503 and writes 403', async () => {
  const h = await startHost(null);
  try {
    const page = await call(h.base, 'GET', '/');
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(LIVE_BUILD_MARKER));
    const health = await call(h.base, 'GET', '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.text), { ok: true, live: 'not-configured', reason: 'GIMBAL_LIVE_URL and GIMBAL_VIEW_TOKEN are not set', visitors: 0 });
    for (const p of ['/state', '/strategy', '/journal', '/windows/history?id=x', '/events']) {
      const r = await call(h.base, 'GET', p);
      assert.equal(r.status, 503, p);
      assert.equal(JSON.parse(r.text).error, 'live engine not configured');
      assert.equal(JSON.parse(r.text).reason, NOT_CONFIGURED_REASON);
    }
    assert.equal((await call(h.base, 'POST', '/close', { 'content-type': 'application/json' }, '{}')).status, 403);
    assert.equal((await call(h.base, 'GET', '/assets/app-1.js')).status, 200);
    assert.equal((await call(h.base, 'GET', '/nothing-here')).status, 404);
  } finally {
    await h.stop();
  }
});

// ---------- nothing a visitor sends reaches the engine but a read ----------

test('a refused write or an unknown route never reaches the engine, and no visitor header is forwarded', async () => {
  const engine = await rawEngine((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/state' ? JSON.stringify({ mode: 'mainnet', windows: null, journal: [], at: T0 }) : '{}');
  });
  const h = await startHost(engine.base, { stream: false });
  try {
    for (const [m, p] of [['POST', '/rotate'], ['POST', '/close'], ['PUT', '/strategy'], ['POST', '/stress'], ['POST', '/pause'], ['DELETE', '/journal']] as const) {
      const r = await call(h.base, m, p, { 'content-type': 'application/json' }, '{"windowId":"x"}');
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.headers.connection, 'close');
    }
    for (const p of ['/policy', '/setup', '/view-ticket', '/rotate', '/windows']) assert.equal((await call(h.base, 'GET', p)).status, 404, p);
    assert.equal((await call(h.base, 'GET', '/state', { 'content-length': '5' }, 'hello')).status, 400, 'a GET with a body');
    assert.equal(engine.seen.length, 0, 'nothing reached the engine');

    const r = await call(h.base, 'GET', '/state?token=visitor', {
      cookie: 'session=visitor', authorization: 'Bearer visitor-token', origin: 'https://evil.example', 'x-forwarded-for': '198.51.100.7', referer: 'https://evil.example/x',
    });
    assert.equal(r.status, 200);
    assert.equal(engine.seen.length, 1);
    const seen = engine.seen[0]!;
    assert.equal(seen.method, 'GET');
    assert.equal(seen.url, '/state', 'the visitor\'s query is not forwarded');
    assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`, 'the host\'s token, never the visitor\'s');
    for (const h2 of ['cookie', 'origin', 'x-forwarded-for', 'referer', 'x-real-ip']) assert.equal(seen.headers[h2], undefined, h2);
  } finally {
    await h.stop();
    await closeServer(engine.server);
  }
});

// ---------- the token ----------

test('the token is never in a response, a header or a log line, even when the engine quotes it', async () => {
  // The engine's own redactor is given no environment here, so a token it echoes reaches the host: the host cuts it.
  const eng = fakeEngine({ journal: [entry('loop-1', `refused: Bearer ${TOKEN} not accepted`)] });
  const v = await startView(eng.source);
  const h = await startHost(v.base);
  try {
    await until(() => h.upstream!.status === 'connected');
    const replies: Reply[] = [];
    for (const [m, p] of [['GET', '/'], ['GET', '/healthz'], ['GET', '/state'], ['HEAD', '/state'], ['GET', '/strategy'], ['GET', '/journal?before=loop-1'], ['GET', '/windows/history?id=SOL'],
      ['GET', '/windows/history?id=none'], ['POST', '/close'], ['GET', '/view-ticket'], ['GET', '/nope']] as const) {
      replies.push(await call(h.base, m, p));
    }
    const visitor = await visit(h.base);
    eng.emit({ type: 'journal', data: entry('loop-2', `an error quoting ${TOKEN}`) });
    await until(() => visitor.events().some((e) => e.type === 'journal'));
    visitor.close();
    const state = JSON.parse(replies[2]!.text) as EngineState;
    assert.equal(state.journal[0]!.summary, 'refused: Bearer … not accepted');
    for (const r of replies) {
      assert.ok(!r.text.includes(TOKEN), r.text);
      assert.ok(!JSON.stringify(r.headers).includes(TOKEN));
    }
    assert.ok(!visitor.raw().includes(TOKEN));
    assert.ok(visitor.raw().includes('an error quoting …'));
    assert.ok(h.lines.length > 0);
    for (const line of [...h.lines, ...v.lines]) assert.ok(!line.includes(TOKEN), line);
  } finally {
    await h.stop();
    await v.view.stop();
  }
});

test('a token the engine refuses: one 401, then nothing is asked for a while, and the log names the variable, not the value', async () => {
  const eng = fakeEngine();
  const v = await startView(eng.source);
  const wrong = `${TOKEN.slice(0, -4)}0000`;
  const h = await startHost(v.base, { token: wrong, stream: false });
  try {
    const first = await call(h.base, 'GET', '/strategy');
    assert.equal(first.status, 503);
    assert.equal(h.upstream!.counts.requests, 1);
    for (let i = 0; i < 5; i++) assert.equal((await call(h.base, 'GET', `/windows/history?id=W${i}`)).status, 503);
    assert.equal(h.upstream!.counts.requests, 1, 'paused after the 401: the engine\'s failed-auth limit is never reached');
    assert.ok(h.lines.some((l) => l.includes('GIMBAL_VIEW_TOKEN')));
    for (const line of h.lines) assert.ok(!line.includes(wrong) && !line.includes(TOKEN), line);
    assert.ok(!first.text.includes(wrong));
  } finally {
    await h.stop();
    await v.view.stop();
  }
});

// ---------- protecting the engine ----------

test('one upstream stream for many visitors; every visitor gets the snapshots and each event', async () => {
  const eng = fakeEngine();
  const v = await startView(eng.source);
  const h = await startHost(v.base);
  try {
    await until(() => h.upstream!.status === 'connected');
    const visitors = await Promise.all(Array.from({ length: 25 }, (_, i) => visit(h.base, { 'x-real-ip': `10.0.0.${i}` })));
    for (const vi of visitors) assert.equal(vi.status, 200);
    await until(() => h.host.stats().visitors === 25);
    // The snapshots the engine sent when the host connected, replayed to each visitor from the host's memory.
    for (const vi of visitors) await until(() => vi.events().some((e) => e.type === 'desk'));
    eng.emit({ type: 'decision', data: { action: 'wait', reason: 'no window above the minimum', windowId: null, heldId: null, at: T0 } });
    for (const vi of visitors) await until(() => vi.events().some((e) => e.type === 'decision'));
    assert.equal(v.view.clientCount, 1, 'the engine holds one stream, the host\'s');
    assert.equal(h.upstream!.counts.streams, 1);
    const health = JSON.parse((await call(h.base, 'GET', '/healthz')).text);
    assert.deepEqual(health, { ok: true, live: 'connected', visitors: 25 });
    for (const vi of visitors) vi.close();
    await until(() => h.host.stats().visitors === 0);
  } finally {
    await h.stop();
    await v.view.stop();
  }
});

test('visitor streams are capped, in all and per address', async () => {
  const eng = fakeEngine();
  const v = await startView(eng.source);
  const h = await startHost(v.base, { maxStreams: 3, maxStreamsPerClient: 2 });
  try {
    await until(() => h.upstream!.status === 'connected');
    const a1 = await visit(h.base, { 'x-real-ip': '10.1.1.1' });
    const a2 = await visit(h.base, { 'x-real-ip': '10.1.1.1' });
    const a3 = await visit(h.base, { 'x-real-ip': '10.1.1.1' });
    assert.deepEqual([a1.status, a2.status, a3.status], [200, 200, 429]);
    const b1 = await visit(h.base, { 'x-real-ip': '10.2.2.2' });
    const c1 = await visit(h.base, { 'x-real-ip': '10.3.3.3' });
    assert.deepEqual([b1.status, c1.status], [200, 503]);
    a1.close();
    await until(() => h.host.stats().visitors === 2);
    const a4 = await visit(h.base, { 'x-real-ip': '10.1.1.1' });
    assert.equal(a4.status, 200, 'a slot freed by a closed tab is free again');
    assert.equal(v.view.clientCount, 1);
    for (const x of [a2, a4, b1]) x.close();
  } finally {
    await h.stop();
    await v.view.stop();
  }
});

test('a crowd reading /state sends one request to the engine; distinct keys share a small budget', async () => {
  const eng = fakeEngine();
  const v = await startView(eng.source);
  const h = await startHost(v.base, { stream: false, rate: { perSecond: 0, burst: 4 } });
  try {
    const crowd = await Promise.all(Array.from({ length: 60 }, () => call(h.base, 'GET', '/state')));
    for (const r of crowd) assert.equal(r.status, 200);
    assert.equal(eng.reads.state, 1, 'one read for sixty visitors at once');
    for (let i = 0; i < 20; i++) await call(h.base, 'GET', '/state');
    assert.equal(eng.reads.state, 1, 'answered from the cache while it is fresh');
    // Four requests in the budget: /state used one; three window histories pass, the fourth is answered 503 by the host.
    const histories = [];
    for (const id of ['A', 'B', 'C', 'D']) histories.push(await call(h.base, 'GET', `/windows/history?id=${id}`));
    assert.deepEqual(histories.map((r) => r.status), [200, 200, 200, 503]);
    assert.equal(histories[3]!.headers['retry-after'], '2');
    assert.equal(eng.reads.history, 3);
    assert.equal((await call(h.base, 'GET', '/windows/history?id=A')).status, 200, 'a cached key still answers when the budget is spent');
    assert.equal(h.upstream!.counts.requests, 4);
  } finally {
    await h.stop();
    await v.view.stop();
  }
});

test('the upstream stream reconnects with backoff, and every visitor stream ends so each page reads /state again', async () => {
  let open: ServerResponse | null = null;
  const engine = await rawEngine((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'desk', data: desk() })}\n\n`);
      open = res;
      return;
    }
    res.writeHead(404).end();
  });
  const h = await startHost(engine.base);
  try {
    await until(() => h.upstream!.status === 'connected');
    const visitor = await visit(h.base);
    await until(() => visitor.events().some((e) => e.type === 'desk'));
    (open as ServerResponse | null)?.destroy();
    await visitor.ended;
    await until(() => h.upstream!.counts.streams === 2 && h.upstream!.status === 'connected');
    assert.equal(engine.seen.filter((s) => s.url === '/events').length, 2);
    const again = await visit(h.base);
    assert.equal(again.status, 200);
    again.close();
  } finally {
    await h.stop();
    await closeServer(engine.server);
  }
});

test('while the engine is down, a visitor\'s stream is answered 503 at once and the engine is not asked', async () => {
  const engine = await rawEngine((_req, res) => {
    res.writeHead(503).end();
  });
  const h = await startHost(engine.base, { backoff: () => 60_000 });
  try {
    await until(() => h.upstream!.counts.streams === 1 && h.upstream!.status !== 'connecting');
    const before = engine.seen.length;
    for (let i = 0; i < 10; i++) assert.equal((await visit(h.base)).status, 503);
    assert.equal(engine.seen.length, before);
    assert.equal(JSON.parse((await call(h.base, 'GET', '/healthz')).text).live, 'down');
  } finally {
    await h.stop();
    await closeServer(engine.server);
  }
});

// ---------- what the public sees ----------

test('the public cut: IPs, e-mails, local paths, private host names and referral codes go; times, prices and links stay', () => {
  const cut = publicCutter([TOKEN, 'engine.example']);
  const cases: [string, string][] = [
    ['the desk\'s IP list (203.0.113.9, 2001:db8::7) leaves out 198.51.100.20', 'the desk\'s IP list (…, …) leaves out …'],
    ['contact ops@example.com', 'contact …@…'],
    ['ENOENT: no such file /data/gimbal/trader.json', 'ENOENT: no such file …'],
    ['at /app/engine/src/cli/serve.ts:12', 'at …'],
    ['D:\\work\\gimbal\\x.ts failed', '… failed'],
    ['connect ECONNREFUSED engine.railway.internal:8790', 'connect ECONNREFUSED …:8790'],
    ['referred by GIMBALCODE', 'referred by …'],
    ['referrer set: ABC_123', 'referrer set: …'],
    ['{"referral_code":"XYZ9"}', '{"referral_code":"…"}'],
    [`Bearer ${TOKEN}`, 'Bearer …'],
    ['https://engine.example/state', 'https://…/state'],
  ];
  for (const [input, want] of cases) assert.equal(cut(input), want, input);
  for (const keep of [
    'funding at 17:00:00 UTC', 'SOL 14.2 % net, 2 of 3 hours above 10 %', 'mark 182.45, entry 180.1', 'https://nearblocks.io/txns/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    'https://app.hyperliquid.xyz/explorer/tx/0xab12cd', 'GET /state: 500', 'E_ORACLE_STALE', 'v1.2', 'loop-mhb2x9-17',
  ]) assert.equal(cut(keep), keep, keep);
});

test('the venue set-up loses its details; unknown state fields and event types are not published', () => {
  const setup = { deskId: 'd', steps: [{ step: 'orderly_ip_restriction', status: 'done', detail: 'key limited to 203.0.113.9', tx: [] }, { step: 'hl_set_referrer', status: 'done', detail: 'referrer set: CODE', tx: [{ chain: 'hyperliquid', id: '0x1', url: 'https://app.hyperliquid.xyz/explorer/tx/0x1' }] }] };
  assert.deepEqual(publicSetup(setup), { deskId: 'd', steps: [{ step: 'orderly_ip_restriction', status: 'done', tx: [] }, { step: 'hl_set_referrer', status: 'done', tx: setup.steps[1]!.tx }] });
  const cut = publicCutter();
  const state = publicState({ mode: 'mainnet', journal: [], at: 1, setup, secretField: 'x', windows: null }, cut) as Record<string, unknown>;
  assert.deepEqual(Object.keys(state).sort(), ['at', 'journal', 'mode', 'setup', 'windows']);
  assert.ok(!JSON.stringify(state).includes('203.0.113.9') && !JSON.stringify(state).includes('CODE'));
  assert.equal(publicEvent({ type: 'internal', data: {} }, cut), null);
  assert.deepEqual(publicEvent({ type: 'setup', data: setup }, cut), { type: 'setup', data: publicSetup(setup) });
  assert.equal(publicState('nope', cut), null);
});

test('the engine\'s own masking still applies through the host: the owner\'s account and platform ids are cut', async () => {
  const railwayId = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
  const eng = fakeEngine({ journal: [entry('loop-1', `paused by owner-account.near on service ${railwayId}`)] });
  const v = await startView(eng.source, { OWNER_ACCOUNT_ID: 'owner-account.near', RAILWAY_SERVICE_ID: railwayId });
  const h = await startHost(v.base, { stream: false });
  try {
    const state = JSON.parse((await call(h.base, 'GET', '/state')).text) as EngineState;
    assert.equal(state.desk!.owner, 'owne…near');
    assert.equal(state.journal[0]!.summary, 'paused by owne…near on service …');
    assert.equal(state.desk!.contract, 'gimbal.near', 'the contract id is public and stays');
  } finally {
    await h.stop();
    await v.view.stop();
  }
});

test('HEAD answers a read\'s headers without its body', async () => {
  const eng = fakeEngine();
  const v = await startView(eng.source);
  const h = await startHost(v.base, { stream: false });
  try {
    const r = await call(h.base, 'HEAD', '/state');
    assert.equal(r.status, 200);
    assert.equal(r.text, '');
    assert.ok(Number(r.headers['content-length']) > 0);
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally {
    await h.stop();
    await v.view.stop();
  }
});
