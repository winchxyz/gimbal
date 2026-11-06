// The public live view's host: what it refuses (every write, never forwarded), what it 404s, that the token never
// leaves it (no response, no log line), that visitor headers never reach the engine, one upstream stream for any
// number of visitors, the visitor caps (per address, an IPv6 /64 as one), the unread-bytes caps, the cache (stale kept)
// and the read budget, the SSE framing, the reconnect, the not-configured state, and what the public sees of the
// engine's payloads (a field allowlist per type, then the cut), checked against the page's own fixtures.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { DeskState, EngineState, JournalEntry, StreamEvent, Window } from '@gimbal/shared';
import { viewRedactor } from '../view/view-redact.ts';
import { ViewServer } from '../view/view-server.ts';
import type { ViewSource } from '../view/view-server.ts';
import type { LiveHostOptions, LiveHostServer, LiveUpstreamOptions } from './live-host-lib.ts';
import {
  LIVE_BUILD_MARKER, LIVE_READ_ONLY_REASON, LiveUpstream, NOT_CONFIGURED_REASON, addressGroup, createLiveHostServer, isLiveBuild, liveClientKey,
  liveConfigFromEnv, liveRoute, liveStaticFile, publicCutter, publicEvent, publicRead, publicSetup, publicState,
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
const win = (id: string, extra: Partial<Window> = {}): Window => ({
  id, symbol: 'SOL', longVenue: 'hyperliquid', shortVenue: 'phoenix', grossAprPct: 20, grossApr7dPct: 18,
  costs: { feesPct: 1, slippagePct: 0.5, basisPct: 0.2, rescueReservePct: 0 }, netAprPct: 15, usdPerDayPer1k: 0.41, breakevenHours: 12,
  depthUsd: 1_000_000, intervalsAbove: 3, updatedAt: T0, tradable: true, held: null, checks: [{ ok: true, text: 'policy allows SOL' }], switchCostUsd: null,
  stale: false, ...extra,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

type HostLimits = Pick<LiveHostOptions, 'maxStreams' | 'maxStreamsPerClient' | 'maxUnreadBytes' | 'maxUnreadTotal' | 'unreadCheckMs' | 'heartbeatMs'>;

async function startHost(engineBase: string | null, opts: Partial<LiveUpstreamOptions> & HostLimits & { stream?: boolean; token?: string; upstream?: LiveUpstream } = {}): Promise<Running> {
  const lines: string[] = [];
  const { maxStreams, maxStreamsPerClient, maxUnreadBytes, maxUnreadTotal, unreadCheckMs, heartbeatMs, stream = true, token = TOKEN, upstream: given, ...up } = opts;
  const upstream = given ?? (engineBase === null ? null : new LiveUpstream({ base: engineBase, token, log: (l) => lines.push(l), backoff: () => 50, ...up }));
  const limits = Object.fromEntries(Object.entries({ maxStreams, maxStreamsPerClient, maxUnreadBytes, maxUnreadTotal, unreadCheckMs, heartbeatMs }).filter(([, v]) => v !== undefined));
  const host = createLiveHostServer({
    webDir, upstream, offReason: upstream === null ? 'GIMBAL_LIVE_URL and GIMBAL_VIEW_TOKEN are not set' : null, log: (l) => lines.push(l), ...limits,
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

test('a crowd reading /state sends one request to the engine; histories share a budget per client and in all; the core reads are outside it', async () => {
  const eng = fakeEngine({ windows: ['A', 'B', 'C', 'D', 'E'].map((id) => win(id)) });
  const v = await startView(eng.source);
  const h = await startHost(v.base, { stream: false, rate: { perSecond: 0, burst: 4 }, clientRate: { perSecond: 0, burst: 3 } });
  const a = { 'x-real-ip': '198.51.100.7' };
  const b = { 'x-real-ip': '198.51.100.8' };
  try {
    const crowd = await Promise.all(Array.from({ length: 60 }, () => call(h.base, 'GET', '/state', a)));
    for (const r of crowd) assert.equal(r.status, 200);
    assert.equal(eng.reads.state, 1, 'one read for sixty visitors at once');
    for (let i = 0; i < 20; i++) await call(h.base, 'GET', '/state', a);
    assert.equal(eng.reads.state, 1, 'answered from the cache while it is fresh');
    // Client a has three misses, the host four in all.
    const statuses = async (who: OutgoingHttpHeaders, ids: string[]) => {
      const out: number[] = [];
      for (const id of ids) out.push((await call(h.base, 'GET', `/windows/history?id=${id}`, who)).status);
      return out;
    };
    assert.deepEqual(await statuses(a, ['A', 'B', 'C', 'D']), [200, 200, 200, 503]);
    assert.deepEqual(await statuses(b, ['D', 'E']), [200, 503], 'another client has its own budget, until the host\'s runs out');
    const busy = await call(h.base, 'GET', '/windows/history?id=E', b);
    assert.equal(busy.headers['retry-after'], '2');
    assert.equal(eng.reads.history, 4);
    assert.equal((await call(h.base, 'GET', '/windows/history?id=A', b)).status, 200, 'a cached key still answers when the budget is spent');
    // The page's first reads never wait on the budget.
    for (const p of ['/strategy', '/journal']) assert.equal((await call(h.base, 'GET', p, a)).status, 200, p);
    assert.equal(h.upstream!.counts.requests, 7);
  } finally {
    await h.stop();
    await v.view.stop();
  }
});

test('a history the engine did not list is 404 at the host, and an older journal page only follows an entry the host served', async () => {
  const eng = fakeEngine({ windows: [win('SOL:hyperliquid/phoenix')], journal: [entry('loop-1', 'waiting')] });
  const v = await startView(eng.source);
  const h = await startHost(v.base, { stream: false });
  try {
    // Cold: the host reads /state first, to learn the windows.
    assert.equal((await call(h.base, 'GET', '/windows/history?id=SOL%3Ahyperliquid%2Fphoenix')).status, 200);
    assert.equal(eng.reads.state, 1);
    for (let i = 0; i < 50; i++) {
      const r = await call(h.base, 'GET', `/windows/history?id=made-up-${i}`);
      assert.equal(r.status, 404);
    }
    assert.equal(eng.reads.history, 1, 'made-up ids never reach the engine, nor spend the budget');
    const unknown = await call(h.base, 'GET', '/journal?before=made-up');
    assert.deepEqual([unknown.status, unknown.text], [200, '[]'], 'what the engine answers for an id it does not hold');
    assert.equal(eng.reads.journal, 0);
    assert.equal((await call(h.base, 'GET', '/journal?before=loop-1')).status, 200);
    assert.equal(eng.reads.journal, 1);
  } finally {
    await h.stop();
    await v.view.stop();
  }
});

test('a cold visitor on a desk with 40 tradable windows loads every read without a 503, and the next visitors come from the cache', async () => {
  const windows = Array.from({ length: 40 }, (_, i) => win(`SYM${i}:hyperliquid/phoenix`));
  const eng = fakeEngine({ windows });
  const v = await startView(eng.source);
  for (const stream of [false, true]) {
    eng.reads.history = 0;
    const h = await startHost(v.base, { stream });
    try {
      if (stream) await until(() => h.upstream!.status === 'connected');
      // What the page asks for when it opens: the core reads, and the Windows screen's one history per tradable window,
      // all at once (useHistories), before the host has seen a window list when there is no stream.
      const page = (ip: string) => Promise.all([
        call(h.base, 'GET', '/state', { 'x-real-ip': ip }), call(h.base, 'GET', '/strategy', { 'x-real-ip': ip }), call(h.base, 'GET', '/journal', { 'x-real-ip': ip }),
        ...windows.map((w) => call(h.base, 'GET', `/windows/history?id=${encodeURIComponent(w.id)}`, { 'x-real-ip': ip })),
      ]);
      const first = await page('198.51.100.7');
      assert.deepEqual(first.filter((r) => r.status !== 200).map((r) => r.status), [], `no refusal (stream ${stream})`);
      assert.equal(eng.reads.history, 40);
      for (let i = 0; i < 5; i++) {
        const next = await page(`203.0.113.${i + 1}`);
        assert.ok(next.every((r) => r.status === 200));
      }
      assert.equal(eng.reads.history, 40, 'the next visitors\' histories come from the cache');
    } finally {
      await h.stop();
    }
  }
  await v.view.stop();
});

// ---------- the cache: stale kept, never overwritten by a failure ----------

/** A fetch whose answers the test settles one by one. */
function heldFetch() {
  const pending: { path: string; settle: (r: Response) => void }[] = [];
  const fetchFn = ((url: string | URL) => new Promise<Response>((settle) => {
    const u = new URL(String(url));
    pending.push({ path: `${u.pathname}${u.search}`, settle });
  })) as typeof fetch;
  return { fetchFn, pending };
}

const stateWith = (at: number): EngineState => ({
  mode: 'mainnet', windows: [], scan: null, strategy: null, desk: null, journal: [], rescue: null, setup: null, health: null, decision: null, at,
});

test('a failed read never replaces the last good answer: it is served stale, and the engine is asked again only after a pause', async () => {
  let t = T0;
  let mode: 'ok' | '500' | 'down' | '401' = 'ok';
  let asked = 0;
  const fetchFn = (async () => {
    asked++;
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === '500') return new Response('oops', { status: 500 });
    if (mode === '401') return new Response('no', { status: 401 });
    return Response.json(stateWith(T0 + asked));
  }) as typeof fetch;
  const up = new LiveUpstream({ base: 'http://127.0.0.1:9', token: TOKEN, fetch: fetchFn, now: () => t });
  const good = await up.read('/state');
  assert.equal(good.status, 200);
  for (const m of ['500', 'down'] as const) {
    t += 10_000;
    mode = m;
    const before = asked;
    assert.deepEqual(await up.read('/state'), good, `${m}: the last good answer`);
    assert.deepEqual(await up.read('/state'), good);
    assert.equal(asked, before + 1, `${m}: asked once, then the pause`);
  }
  t += 10_000;
  mode = '401';
  assert.deepEqual(await up.read('/state'), good, 'refused: still the last good answer');
  t += 10_000;
  mode = 'ok';
  const before = asked;
  assert.deepEqual(await up.read('/state'), good, 'paused after the refusal: nothing asked');
  assert.equal(asked, before);
  t += 60_000;
  const fresh = await up.read('/state');
  assert.notDeepEqual(fresh, good);
  assert.equal(JSON.parse(fresh.body).at, T0 + asked);
  // With no good answer at all, a failure is answered as one.
  mode = '500';
  t += 10_000;
  assert.equal((await up.read('/strategy')).status, 502);
});

test('a stale core answer is served for at most maxStaleMs after it was read; then the failure is answered as one', async () => {
  let t = T0;
  let down = false;
  const fetchFn = (async () => {
    if (down) throw new TypeError('fetch failed');
    return Response.json(stateWith(T0));
  }) as typeof fetch;
  const up = new LiveUpstream({ base: 'http://127.0.0.1:9', token: TOKEN, fetch: fetchFn, now: () => t, maxStaleMs: 60_000 });
  const good = await up.read('/state');
  down = true;
  t += 30_000;
  assert.deepEqual(await up.read('/state'), good, 'within the stale age');
  t += 31_000;
  const old = await up.read('/state');
  assert.equal(old.status, 503, 'past it: the page says the engine is not answering');
  t += 1_000;
  assert.equal((await up.read('/state')).status, 503, 'and while the retry waits too');
  down = false;
  t += 2_000;
  assert.equal((await up.read('/state')).status, 200);
});

test('a /state read in flight when the stream says it changed is not taken as fresh', async () => {
  const held = heldFetch();
  const sse = sseBody();
  const fetchFn = ((url: string | URL, init?: RequestInit) => (new URL(String(url)).pathname === '/events' ? Promise.resolve(sse.open(init?.signal)) : held.fetchFn(url))) as typeof fetch;
  const up = new LiveUpstream({ base: 'http://127.0.0.1:9', token: TOKEN, fetch: fetchFn, backoff: () => 60_000 });
  const seen: string[] = [];
  up.subscribe({ event: (c) => seen.push(c.toString('utf8')), drop: () => undefined });
  up.start();
  try {
    await until(() => up.status === 'connected');
    // 1. Asked before a journal event, answered after it: served to whoever asked, but kept stale.
    const p1 = up.read('/state');
    await until(() => held.pending.length === 1);
    sse.push(`data: ${JSON.stringify({ type: 'journal', data: entry('loop-2', 'entered') })}\n\n`);
    await until(() => seen.length === 1);
    held.pending[0]!.settle(Response.json(stateWith(1)));
    assert.equal(JSON.parse((await p1).body).at, 1);
    const p2 = up.read('/state');
    await until(() => held.pending.length === 2);
    held.pending[1]!.settle(Response.json(stateWith(2)));
    assert.equal(JSON.parse((await p2).body).at, 2, 'the next read asks again');
    assert.equal(JSON.parse((await up.read('/state')).body).at, 2, 'and that one is fresh');
    assert.equal(held.pending.length, 2);

    // 2. Two reads overlap across an event: the older answer, landing last, does not replace the newer.
    sse.push(`data: ${JSON.stringify({ type: 'journal', data: entry('loop-3', 'rotated') })}\n\n`);
    await until(() => seen.length === 2);
    const p3 = up.read('/state');
    await until(() => held.pending.length === 3);
    sse.push(`data: ${JSON.stringify({ type: 'journal', data: entry('loop-4', 'exited') })}\n\n`);
    await until(() => seen.length === 3);
    const p4 = up.read('/state');
    await until(() => held.pending.length === 4);
    held.pending[3]!.settle(Response.json(stateWith(4)));
    assert.equal(JSON.parse((await p4).body).at, 4);
    held.pending[2]!.settle(Response.json(stateWith(3)));
    await p3;
    assert.equal(JSON.parse((await up.read('/state')).body).at, 4);
    assert.equal(held.pending.length, 4);
  } finally {
    up.stop();
  }
});

test('a /state asked for before a windows event does not set the host\'s window list back', async () => {
  const held = heldFetch();
  const sse = sseBody();
  const fetchFn = ((url: string | URL, init?: RequestInit) => (new URL(String(url)).pathname === '/events' ? Promise.resolve(sse.open(init?.signal)) : held.fetchFn(url))) as typeof fetch;
  const up = new LiveUpstream({ base: 'http://127.0.0.1:9', token: TOKEN, fetch: fetchFn, backoff: () => 60_000 });
  const seen: string[] = [];
  up.subscribe({ event: (c) => seen.push(c.toString('utf8')), drop: () => undefined });
  up.start();
  try {
    await until(() => up.status === 'connected');
    const p = up.read('/state');
    await until(() => held.pending.length === 1);
    sse.push(`data: ${JSON.stringify({ type: 'windows', data: [win('NEW')] })}\n\n`);
    await until(() => seen.length === 1);
    held.pending[0]!.settle(Response.json({ ...stateWith(1), windows: [win('OLD')] }));
    await p;
    assert.equal((await up.read('/windows/history?id=OLD')).status, 404, 'the older list was not taken');
    assert.equal(held.pending.length, 1);
    const next = up.read('/windows/history?id=NEW');
    await until(() => held.pending.length === 2);
    assert.equal(held.pending[1]!.path, '/windows/history?id=NEW');
    held.pending[1]!.settle(Response.json({ windowId: 'NEW', points: [] }));
    assert.equal((await next).status, 200);
  } finally {
    up.stop();
  }
});

// ---------- the stream ----------

/** An SSE body the test writes into, chunk by chunk; aborting the request errors it, as a real connection would. */
function sseBody() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  return {
    open(signal?: AbortSignal | null): Response {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      signal?.addEventListener('abort', () => {
        try {
          controller?.error(new Error('aborted'));
        } catch {}
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    push(text: string): void {
      controller!.enqueue(encoder.encode(text));
    },
  };
}

test('SSE framing: an event split over chunks, a CRLF split between two chunks, several events in one chunk', async () => {
  const sse = sseBody();
  const fetchFn = ((_url: string | URL, init?: RequestInit) => Promise.resolve(sse.open(init?.signal))) as typeof fetch;
  const up = new LiveUpstream({ base: 'http://127.0.0.1:9', token: TOKEN, fetch: fetchFn, backoff: () => 60_000 });
  const got: string[] = [];
  up.subscribe({ event: (c) => got.push(c.toString('utf8')), drop: () => undefined });
  up.start();
  try {
    await until(() => up.status === 'connected');
    const decision = (reason: string) => JSON.stringify({ type: 'decision', data: { action: 'wait', reason, windowId: null, heldId: null, at: T0 } });
    const one = `data: ${decision('one')}\n\n`;
    for (const part of [one.slice(0, 3), one.slice(3, 40), one.slice(40, -1), one.slice(-1)]) sse.push(part);
    // CRLF endings, one data field over two lines, and the CR and LF of a line in different chunks: still one event.
    const two = decision('two');
    const at = two.indexOf(',') + 1;
    sse.push(`data: ${two.slice(0, at)}\r`);
    sse.push(`\ndata: ${two.slice(at)}\r\n\r`);
    sse.push('\n');
    // A comment and two events in one chunk, with lone CR endings.
    sse.push(`: ping\r\rdata: ${decision('three')}\r\rdata: ${decision('four')}\n\n`);
    await until(() => got.length >= 4);
    await sleep(30);
    assert.deepEqual(got.map((c) => (JSON.parse(c.slice(6)) as { data: { reason: string } }).data.reason), ['one', 'two', 'three', 'four']);
    for (const c of got) assert.ok(c.startsWith('data: {') && c.endsWith('}\n\n'), 'each fanned-out chunk is one whole event');
  } finally {
    up.stop();
  }
});

test('the stream honours the cool-down after a 401: one knock on the engine, not one per backoff', async () => {
  const engine = await rawEngine((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
  });
  const h = await startHost(engine.base, { backoff: () => 20 });
  try {
    await until(() => h.upstream!.counts.streams === 1);
    await sleep(400);
    assert.equal(engine.seen.filter((s) => s.url === '/events').length, 1, 'twenty backoffs went by; the engine was asked once');
    assert.equal((await call(h.base, 'GET', '/state')).status, 503);
    assert.equal((await visit(h.base)).status, 503);
    assert.equal(engine.seen.length, 1, 'no read either while refused');
    assert.ok(h.lines.some((l) => l.includes('401') && l.includes('GIMBAL_VIEW_TOKEN')));
  } finally {
    await h.stop();
    await closeServer(engine.server);
  }
});

// ---------- slow visitors ----------

/** A visitor that opens /events and never reads: what it is sent piles up on the host. */
function stuckVisitor(base: string, ip: string): Socket {
  const u = new URL(base);
  const s = connect(Number(u.port), u.hostname);
  s.write(`GET /events HTTP/1.1\r\nHost: ${u.host}\r\nX-Real-IP: ${ip}\r\n\r\n`);
  s.pause();
  s.on('error', () => undefined);
  return s;
}

/** Sends windows events of about 100 KB through an SSE body until `done`, at most `max` of them. */
async function flood(sse: ReturnType<typeof sseBody>, done: () => boolean, max = 400): Promise<number> {
  const big = Array.from({ length: 20 }, (_, i) => win(`W${i}`, { checks: Array.from({ length: 25 }, (_, j) => ({ ok: true, text: `check ${j} `.padEnd(180, '.') })) }));
  let n = 0;
  while (!done() && n < max) {
    sse.push(`data: ${JSON.stringify({ type: 'windows', data: big.map((w) => ({ ...w, updatedAt: T0 + n })) })}\n\n`);
    n++;
    await sleep(5);
  }
  return n;
}

for (const limit of ['one visitor', 'all visitors'] as const) {
  test(`a visitor that does not read is dropped once it holds too much unread (${limit}); a reading visitor keeps every event`, async () => {
    const sse = sseBody();
    const fetchFn = ((url: string | URL, init?: RequestInit) => Promise.resolve(new URL(String(url)).pathname === '/events' ? sse.open(init?.signal) : Response.json({}, { status: 404 }))) as typeof fetch;
    const upstream = new LiveUpstream({ base: 'http://127.0.0.1:9', token: TOKEN, fetch: fetchFn, backoff: () => 60_000 });
    const h = await startHost(null, {
      upstream, ...(limit === 'one visitor' ? { maxUnreadBytes: 256 * 1024, maxUnreadTotal: 64 * 1024 * 1024 } : { maxUnreadBytes: 64 * 1024 * 1024, maxUnreadTotal: 256 * 1024 }), unreadCheckMs: 50,
    });
    let stuck: Socket | null = null;
    try {
      await until(() => upstream.status === 'connected');
      const fast = await visit(h.base, { 'x-real-ip': '198.51.100.7' });
      stuck = stuckVisitor(h.base, '198.51.100.8');
      await until(() => h.host.stats().visitors === 2);
      const dropped = () => h.lines.some((l) => l.startsWith('visitor stream dropped') && l.includes(`for ${limit}`));
      const sent = await flood(sse, () => dropped());
      assert.ok(dropped(), `dropped after ${sent} events`);
      assert.equal(h.host.stats().visitors, 1, 'the reading visitor stays');
      await until(() => fast.events().filter((e) => e.type === 'windows').length === sent, 10_000);
      assert.ok(h.host.stats().unreadBytes < 256 * 1024);
      fast.close();
    } finally {
      stuck?.destroy();
      await h.stop();
    }
  });
}

// ---------- addresses ----------

test('three hundred visitors that read a 117 KB windows event each scan are never dropped; visitors that do not read are', async () => {
  const sse = sseBody();
  const fetchFn = ((url: string | URL, init?: RequestInit) => Promise.resolve(new URL(String(url)).pathname === '/events' ? sse.open(init?.signal) : Response.json({}, { status: 404 }))) as typeof fetch;
  const upstream = new LiveUpstream({ base: 'http://127.0.0.1:9', token: TOKEN, fetch: fetchFn, backoff: () => 60_000 });
  // 512 KiB a visitor (the default), and 8 MiB in all: less than what 300 reading visitors hold in flight right after
  // one fan-out (300 x 117 KB is 35 MB written at once), so a total measured on the write path would drop them.
  const h = await startHost(null, { upstream, maxStreams: 400, maxUnreadTotal: 8 * 1024 * 1024, unreadCheckMs: 1_000 });
  const readers: { bytes: () => number; close: () => void }[] = [];
  const stuck: Socket[] = [];
  try {
    await until(() => upstream.status === 'connected');
    for (let i = 0; i < 300; i++) readers.push(await byteVisitor(h.base, `10.${Math.floor(i / 250)}.${i % 250}.1`));
    for (let i = 0; i < 3; i++) stuck.push(stuckVisitor(h.base, `192.0.2.${i + 1}`));
    await until(() => h.host.stats().visitors === 303, 10_000);
    const windows = Array.from({ length: 159 }, (_, i) => win(`SYM${i}:hyperliquid/phoenix`, { checks: Array.from({ length: 4 }, (_, j) => ({ ok: true, text: `check ${j} `.padEnd(58, '.') })) }));
    const chunk = `data: ${JSON.stringify({ type: 'windows', data: windows })}\n\n`;
    assert.ok(chunk.length > 110_000 && chunk.length < 125_000, `${chunk.length} bytes`);
    const start = readers.map((r) => r.bytes());
    let sent = 0;
    while (h.host.stats().visitors > 300 && sent < 20) {
      sse.push(chunk);
      sent++;
      await sleep(600);
    }
    assert.equal(h.host.stats().visitors, 300, `the three that do not read are dropped (after ${sent} scans)`);
    await until(() => readers.every((r, i) => r.bytes() - start[i]! >= sent * chunk.length), 20_000);
    assert.ok(!h.lines.some((l) => l.includes('for all visitors')), 'no reading visitor went over the total');
    assert.equal(h.host.stats().visitors, 300);
  } finally {
    for (const r of readers) r.close();
    for (const s of stuck) s.destroy();
    await h.stop();
  }
});

/** A visitor's /events that reads everything and only counts the bytes. */
function byteVisitor(base: string, ip: string): Promise<{ bytes: () => number; close: () => void }> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const req = request(`${base}/events`, { headers: { 'x-real-ip': ip } }, (res) => {
      res.on('data', (c: Buffer) => (n += c.length));
      res.on('error', () => undefined);
      if (res.statusCode !== 200) reject(new Error(`status ${res.statusCode}`));
      else resolve({ bytes: () => n, close: () => req.destroy() });
    });
    req.on('error', () => undefined);
    req.end();
  });
}

test('the visitor key: X-Real-IP only when it is an IP address, else the last X-Forwarded-For entry that is one, else the socket', () => {
  const key = (headers: IncomingHttpHeaders, remoteAddress = '127.0.0.1') => liveClientKey({ headers, socket: { remoteAddress } });
  assert.equal(key({ 'x-real-ip': '198.51.100.7' }), '198.51.100.7');
  assert.equal(key({ 'x-real-ip': ' [2001:db8:1:2::9] ' }), '2001:db8:1:2::/64');
  assert.equal(key({ 'x-real-ip': 'x'.repeat(10_000), 'x-forwarded-for': '203.0.113.5, not-an-ip, 198.51.100.9 , junk' }), '198.51.100.9');
  assert.equal(key({ 'x-real-ip': 'anything', 'x-forwarded-for': 'a, b' }), '127.0.0.1');
  assert.equal(key({ 'x-real-ip': '999.1.1.1' }, '::ffff:203.0.113.4'), '203.0.113.4');
  assert.equal(liveClientKey({ headers: {}, socket: {} }), 'unknown');
});

test('forged non-address X-Real-IP values do not open fresh stream slots or read budgets', async () => {
  const eng = fakeEngine({ windows: ['A', 'B', 'C', 'D'].map((id) => win(id)) });
  const v = await startView(eng.source);
  const h = await startHost(v.base, { maxStreamsPerClient: 2, clientRate: { perSecond: 0, burst: 2 } });
  try {
    await until(() => h.upstream!.status === 'connected');
    const streams = [];
    for (const forged of ['one', 'two', 'three']) streams.push(await visit(h.base, { 'x-real-ip': forged }));
    assert.deepEqual(streams.map((s) => s.status), [200, 200, 429], 'all three are the socket\'s address');
    const reads = [];
    for (const [i, id] of ['A', 'B', 'C'].entries()) reads.push((await call(h.base, 'GET', `/windows/history?id=${id}`, { 'x-real-ip': `forged-${i}` })).status);
    assert.deepEqual(reads, [200, 200, 503]);
    for (const s of streams) s.close();
  } finally {
    await h.stop();
    await v.view.stop();
  }
});

test('one address for the caps: an IPv6 /64 counts as one, an IPv4-mapped address as its IPv4', () => {
  assert.equal(addressGroup('198.51.100.7'), '198.51.100.7');
  assert.equal(addressGroup('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(addressGroup('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(addressGroup('2001:DB8:1:2:bbbb:cccc:dddd:2'), '2001:db8:1:2::/64');
  assert.equal(addressGroup('[2001:db8::1]'), '2001:db8:0:0::/64');
  assert.equal(addressGroup('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(addressGroup('::1'), '0:0:0:0::/64');
  assert.notEqual(addressGroup('2001:db8:1:3::1'), addressGroup('2001:db8:1:2::1'));
  assert.equal(addressGroup('unknown'), 'unknown');
});

test('the per-address stream cap counts a whole IPv6 /64, and its refusal logs the address it counted', async () => {
  const eng = fakeEngine();
  const v = await startView(eng.source);
  const h = await startHost(v.base, { maxStreamsPerClient: 2 });
  try {
    await until(() => h.upstream!.status === 'connected');
    const statuses: number[] = [];
    const open: Visitor[] = [];
    for (const ip of ['2001:db8:1:2::a', '2001:db8:1:2:ffff::b', '2001:db8:1:2:1234:5678:9abc:def0', '2001:db8:1:3::a']) {
      const vi = await visit(h.base, { 'x-real-ip': ip });
      statuses.push(vi.status);
      open.push(vi);
    }
    assert.deepEqual(statuses, [200, 200, 429, 200]);
    assert.ok(h.lines.some((l) => l.includes('2 open from 2001:db8:1:2::/64') && l.includes('429')), h.lines.join('\n'));
    for (const vi of open) vi.close();
  } finally {
    await h.stop();
    await v.view.stop();
  }
});

// ---------- the allowlist keeps everything the page reads ----------

const same = (text: string) => text;
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('every field of every shared type passes the allowlist unchanged (the set-up step details aside); a field the types do not have is dropped', () => {
  const tx = { chain: 'near' as const, id: '9xQe', url: 'https://nearblocks.io/txns/9xQe' };
  const full: EngineState = {
    mode: 'mainnet',
    windows: [win('SOL:hyperliquid/phoenix', {
      veto: { verdict: 'pass', reasons: ['spread steady for a week'], model: 'model-a', at: T0 }, refused: { code: 'E_ORACLE_STALE', reason: 'stored price stale' },
      note: 'refreshed at open', held: { since: T0 - 3_600_000 }, switchCostUsd: 0.42, grossApr7dPct: null,
    })],
    scan: { venues: 33, failed: ['paradex'], at: T0 },
    strategy: { auto: true, minNetAprPct: 10, legUsd: 12, maxLeverage: 2, stopDrawdownPct: 5, rotate: { minGainPts: 5, forHours: 3 }, risk: { watchDistancePct: 15, rescueDistancePct: 8 }, enterAfterChecks: 3, exitAfterChecks: 6 },
    desk: {
      ...desk(),
      legs: [{
        venue: 'hyperliquid', symbol: 'SOL', side: 'long', size: 0.1, lotSize: 0.01, entry: 180.1, mark: 182.45, liqPx: 120, marginUsd: 6, marginRatio: 0.31,
        distanceToLiqPct: 32.6, fundingEarnedUsd: 0.02, unsettledFundingUsd: 0.01, feesUsd: -0.01, feesPositionId: 'SOL@1', unpriced: false,
      }],
      paused: { by: 'owne…near', at: T0 }, rescueFailure: { rescueId: 'r1', step: 'quote', reason: 'no quote', tries: 2, next: 'the owner must act', at: T0 },
      accounts: [{ venue: 'hyperliquid', equityUsd: 20, at: T0 }, { venue: 'phoenix', equityUsd: null, at: null }],
    },
    journal: [{ id: 'loop-1', t: T0, kind: 'rescue', summary: 'rescued', why: 'margin was low', numbers: { usd: -0.1, from: 'reserve', signedS: '2.1' }, tx: [tx] }],
    rescue: { id: 'r1', from: 'reserve', to: 'phoenix', amountUsd: 5, sentUsd: 5.1, step: 'landed', startedAt: T0, elapsedS: 52, tx: [tx] },
    setup: { deskId: 'gimbal-desk', steps: [{ step: 'hl_set_referrer', status: 'done', detail: 'referrer set: CODE', tx: [tx] }] },
    health: { hyperliquid: 'ok', phoenix: 'slow', orderly: 'down', intents: 'ok', near: 'ok' },
    decision: { action: 'hold', reason: 'SOL 14.2 % net', windowId: 'SOL:hyperliquid/phoenix', heldId: 'SOL:hyperliquid/phoenix', at: T0 },
    at: T0,
  };
  const want = roundTrip({ ...full, setup: { deskId: 'gimbal-desk', steps: [{ step: 'hl_set_referrer', status: 'done', tx: [tx] }] } });
  assert.deepEqual(publicState(roundTrip(full), same), want);

  // Unknown fields at every depth go; so does a value of the wrong kind (an object where a number belongs).
  const noisy = roundTrip(full) as unknown as Record<string, unknown> & EngineState;
  Object.assign(noisy, { internal: { key: 'x' } });
  Object.assign(noisy.desk!, { operatorKey: 'ed25519:x', equityUsd: { nested: 1 } });
  Object.assign(noisy.desk!.legs[0]!, { apiKey: 'x' });
  Object.assign(noisy.windows![0]!, { debug: { path: '/app/x' } });
  Object.assign(noisy.windows![0]!.veto!, { prompt: 'x' });
  Object.assign(noisy.journal[0]!, { raw: { headers: {} } });
  Object.assign(noisy.journal[0]!.numbers, { nested: { a: 1 } });
  Object.assign(noisy.health!, { detail: { ip: 'x' } });
  const out = publicState(noisy, same) as EngineState;
  const { equityUsd: _dropped, ...deskWithout } = want.desk!;
  assert.deepEqual(out, { ...want, desk: deskWithout });

  for (const event of [
    { type: 'windows', data: full.windows }, { type: 'scan', data: full.scan }, { type: 'desk', data: full.desk }, { type: 'journal', data: full.journal[0] },
    { type: 'rescue', data: full.rescue }, { type: 'health', data: full.health }, { type: 'decision', data: full.decision },
  ]) assert.deepEqual(publicEvent(roundTrip(event), same), roundTrip(event), event.type);
  assert.deepEqual(publicRead('/strategy', full.strategy, same), full.strategy);
  assert.deepEqual(publicRead('/journal', roundTrip(full.journal), same), roundTrip(full.journal));
  const history = { windowId: 'SOL:hyperliquid/phoenix', points: [{ t: T0, netAprPct: 14.2 }] };
  assert.deepEqual(publicRead('/windows/history', { ...history, extra: 1 }, same), history);
});

test('the page\'s own fixtures (the web fake stream, every desk and rescue scenario) pass the allowlist unchanged', async () => {
  // Imported at run time: they are the web's files, written for the browser, and pure.
  const at = (path: string) => new URL(`../../../web/src/stream/${path}`, import.meta.url).href;
  const fake = await import(at('fake.ts'));
  const fakeWindows = await import(at('fake-windows.ts'));
  const fakeJournal = await import(at('fake-journal.ts'));
  const source = await import(at('source.ts'));
  const events: StreamEvent[] = [];
  const collect = (action: { kind: string; event?: StreamEvent }) => {
    if (action.kind === 'event' && action.event !== undefined) events.push(roundTrip(action.event));
  };
  const runs: Record<string, unknown>[] = [
    ...(source.DESK_SCENARIOS as readonly string[]).map((desk) => ({ desk })),
    ...(source.RESCUE_SCENARIOS as readonly string[]).map((rescue) => ({ rescue })),
    ...['normal', 'empty', 'error'].map((scenario) => ({ scenario })),
  ];
  for (const run of runs) {
    const stop = fake.startFakeStream(collect, { mode: 'mainnet', intervalMs: 1, drift: true, ...run }) as () => void;
    await sleep(30);
    stop();
  }
  assert.deepEqual([...new Set(events.map((e) => e.type))].sort(), ['decision', 'desk', 'health', 'journal', 'rescue', 'scan', 'setup', 'windows']);
  for (const e of events) assert.deepEqual(publicEvent(e, same), e, e.type);

  const latest = <K extends StreamEvent['type']>(type: K) => (events.filter((e) => e.type === type).at(-1)?.data ?? null) as Extract<StreamEvent, { type: K }>['data'] | null;
  const journal = roundTrip(fakeJournal.fakeJournal(T0, 'mainnet') as JournalEntry[]);
  const state: EngineState = {
    mode: 'mainnet', windows: latest('windows'), scan: latest('scan'), strategy: roundTrip(fakeWindows.FAKE_STRATEGY), desk: latest('desk'), journal,
    rescue: latest('rescue'), setup: latest('setup'), health: latest('health'), decision: latest('decision'), at: T0,
  };
  assert.deepEqual(publicState(state, same), state);
  assert.deepEqual(publicRead('/journal', journal, same), journal);
  assert.deepEqual(publicRead('/strategy', state.strategy, same), state.strategy);
  const api = fakeWindows.fakeApi();
  let histories = 0;
  for (const w of state.windows ?? []) {
    if (!w.tradable) continue;
    const history = roundTrip(await api.windowHistory(w.id).catch(() => null));
    if (history === null) continue;
    assert.deepEqual(publicRead('/windows/history', history, same), history, w.id);
    histories++;
  }
  assert.ok(histories > 0);
});

test('a leg\'s feesPositionId and a late-read fill fee reach the page unchanged through the host, so the Journal counts that fee once', async () => {
  const position = 'XLM@1730000000000';
  const leg = (venue: 'hyperliquid' | 'phoenix', side: 'long' | 'short') => ({
    venue, symbol: 'XLM', side, size: 100, lotSize: 1, entry: 0.3, mark: 0.31, liqPx: null, marginUsd: 6, marginRatio: 0.2, distanceToLiqPct: null,
    fundingEarnedUsd: 0.01, unsettledFundingUsd: 0, feesUsd: -0.03, feesPositionId: position, unpriced: false,
  });
  const held: DeskState = { ...desk(), legs: [leg('hyperliquid', 'long'), leg('phoenix', 'short')], pnl: { fundingUsd: 0.02, feesUsd: -0.06, priceUsd: 0, netUsd: -0.04 } };
  const fee: JournalEntry = {
    id: 'book-fee-1', t: T0, kind: 'fee', summary: 'Fill fee read from Phoenix', tx: [],
    numbers: { usd: -0.03, fillFee: 1, position, stage: 'enter', venue: 'phoenix', symbol: 'XLM', fills: 1 },
  };
  const eng = fakeEngine({ desk: held, journal: [fee] });
  const v = await startView(eng.source);
  const h = await startHost(v.base);
  try {
    await until(() => h.upstream!.status === 'connected');
    const state = JSON.parse((await call(h.base, 'GET', '/state')).text) as EngineState;
    assert.deepEqual(state.desk!.legs, held.legs);
    assert.deepEqual(state.journal, [fee]);
    const visitor = await visit(h.base);
    await until(() => visitor.events().some((e) => e.type === 'desk'));
    const late = { ...fee, id: 'book-fee-2', numbers: { ...fee.numbers, venue: 'hyperliquid' } };
    eng.emit({ type: 'journal', data: late });
    await until(() => visitor.events().some((e) => e.type === 'journal'));
    const streamed = visitor.events();
    visitor.close();
    assert.deepEqual(streamed.find((e) => e.type === 'desk')!.data, held);
    assert.deepEqual(streamed.find((e) => e.type === 'journal')!.data, late);

    // The web's own attribution, on what the host served: the desk's P&L already holds both fees, so neither entry adds.
    const model = await import(new URL('../../../web/src/journal/model.ts', import.meta.url).href);
    const fees = (legs: unknown[]) => (model.attributionOf(state.desk!.pnl, [...state.journal, late], legs) as { feesUsd: number }).feesUsd;
    assert.equal(Math.round(fees(state.desk!.legs) * 100) / 100, -0.06);
    assert.equal(Math.round(fees([]) * 100) / 100, -0.12, 'without the legs\' position the same entries would count twice');
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
