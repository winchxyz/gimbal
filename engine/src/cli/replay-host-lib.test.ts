// The hosted replay: its read-only guard (what the public port refuses, and that a refused write never reaches the
// engine), the stress gate, the loop that starts the replay over, the engine's environment and the static files.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DeskState, EngineState, Leg, RescueProgress } from '@gimbal/shared';
import type { ReplayEngine } from './replay-host-lib.ts';
import {
  HOSTED_BUILD_MARKER, MAX_STREAMS_PER_CLIENT, READ_ONLY_REASON, ReplayCycler, StressGate, childEnv, clientKey, createHostServer, hostedRoute, isHostedBuild, staticFile,
  stressBodyProblem,
} from './replay-host-lib.ts';

const leg = (size: number): Leg => ({
  venue: 'hyperliquid', symbol: 'SOL', side: 'long', size, lotSize: 0.01, entry: 180, mark: 180, liqPx: 120, marginUsd: 4,
  marginRatio: 0.1, distanceToLiqPct: 33, fundingEarnedUsd: 0, unsettledFundingUsd: 0, feesUsd: 0, unpriced: false,
});
const desk = (legs: Leg[], health: DeskState['health'] = 'level'): DeskState => ({
  deskId: 'replay', owner: 'replay', contract: 'replay', mode: 'replay', legs, netDelta: 0, equityUsd: 40, reserveUsd: 20,
  pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 }, health, paused: null, rescueFailure: null, updatedAt: 0,
});
const rescue = (step: RescueProgress['step']): RescueProgress => ({ id: 'r1', from: 'reserve', to: 'hyperliquid', amountUsd: 1, step, startedAt: 0, elapsedS: 0, tx: [] });

test('the public port reads the engine and refuses every write but POST /stress, before it reaches the engine', () => {
  for (const [m, p] of [['GET', '/state'], ['GET', '/events'], ['HEAD', '/journal'], ['GET', '/windows/history'], ['GET', '/strategy'], ['GET', '/journal/']]) {
    assert.deepEqual(hostedRoute(m!, p!), { kind: 'proxy' }, `${m} ${p}`);
  }
  for (const [m, p] of [['PUT', '/strategy'], ['POST', '/rotate'], ['POST', '/close'], ['POST', '/close/'], ['POST', '/policy/draft'], ['POST', '/setup'], ['DELETE', '/state'], ['PUT', '/stress'], ['POST', '/events']]) {
    const r = hostedRoute(m!, p!);
    assert.equal(r.kind, 'refuse', `${m} ${p}`);
    if (r.kind === 'refuse') {
      assert.equal(r.status, 403);
      assert.equal(r.body.ok, false);
      assert.ok(r.body.reason.includes(READ_ONLY_REASON));
    }
  }
  assert.deepEqual(hostedRoute('POST', '/stress'), { kind: 'stress' });
  assert.deepEqual(hostedRoute('GET', '/'), { kind: 'static' });
  assert.deepEqual(hostedRoute('GET', '/assets/index-abc.js'), { kind: 'static' });
  assert.deepEqual(hostedRoute('GET', '/healthz'), { kind: 'health' });
  assert.equal(hostedRoute('POST', '/').kind, 'refuse');
});

test('a stress test needs a held pair, no rescue running, none in flight, and one per run', () => {
  let now = 1_000_000;
  let nextRunAt: number | null = now + 90_000;
  const gate = new StressGate({ nextRunAt: () => nextRunAt, now: () => now });
  const held = { desk: desk([leg(0.06), leg(0.06)]), rescue: null };
  assert.equal(gate.check(null)?.status, 503);
  assert.match(gate.check({ desk: desk([]), rescue: null })?.reason ?? '', /No pair is held/);
  assert.equal(gate.check({ desk: null, rescue: null })?.status, 409);
  assert.equal(gate.check({ desk: desk([leg(0.06)], 'rescue'), rescue: null })?.status, 409);
  assert.match(gate.check({ desk: desk([leg(0.06)]), rescue: rescue('quote') })?.reason ?? '', /rescue is running/);
  assert.equal(gate.check({ desk: desk([leg(0.06)]), rescue: rescue('landed') }), null);
  assert.equal(gate.check(held), null);
  gate.begin();
  assert.match(gate.check(held)?.reason ?? '', /being handled/);
  gate.end(true);
  // This run has had its stress test: the answer says when the next run starts, however long this one waits.
  const used = gate.check(held);
  assert.equal(used?.status, 409);
  assert.match(used?.reason ?? '', /one stress test per run/);
  assert.match(used?.reason ?? '', /starts over in 90 s/);
  assert.equal(used?.retryAfterS, 90);
  now += 89_500;
  assert.equal(gate.check(held)?.retryAfterS, 1);
  now += 60_000;
  assert.equal(gate.check(held)?.status, 409, 'no cooldown runs out: one per run');
  nextRunAt = null;
  assert.match(gate.check(held)?.reason ?? '', /a few minutes/);
  assert.equal(gate.check(held)?.retryAfterS, undefined);
  // A new run has its own; one the engine refused does not use it up.
  gate.reset();
  assert.equal(gate.check(held), null);
  gate.begin();
  gate.end(false);
  assert.equal(gate.check(held), null);
});

test('POST /stress takes no body, {} or {"on":true}; nothing else', () => {
  for (const ok of ['', '  ', '{}', '{"on":true}', ' { "on" : true } ']) assert.equal(stressBodyProblem(ok), null, ok);
  for (const bad of ['{"on":false}', '{"on":"true"}', '{"x":1}', '{"on":true,"x":1}', 'null', '[]', '1', 'on', '{']) {
    assert.notEqual(stressBodyProblem(bad), null, bad);
  }
});

test('who a request comes from: X-Real-IP, else the last X-Forwarded-For entry, else the socket', () => {
  const r = (headers: IncomingMessage['headers'], remoteAddress = '10.1.1.1') => clientKey({ headers, socket: { remoteAddress } });
  assert.equal(r({ 'x-real-ip': '4.4.4.4', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), '4.4.4.4');
  assert.equal(r({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), '2.2.2.2');
  assert.equal(r({ 'x-forwarded-for': ' 3.3.3.3 ', 'x-real-ip': ' ' }), '3.3.3.3');
  assert.equal(r({}), '10.1.1.1');
});

test('the hosted build is told from the normal one by a marker the Vite config writes', () => {
  assert.equal(isHostedBuild(`<!doctype html><html><head>\n${HOSTED_BUILD_MARKER}<title>Gimbal</title>`), true);
  assert.equal(isHostedBuild('<!doctype html><html><head><title>Gimbal</title>'), false);
  const vite = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'vite.config.ts'), 'utf8');
  assert.ok(vite.includes(HOSTED_BUILD_MARKER), 'web/vite.config.ts writes the same marker');
});

/** A stand-in engine the test settles: ready or not, and exits when told. */
function fakeEngine(port: number, events: string[], opts: { fails?: boolean } = {}) {
  let exit!: (how: string) => void;
  const exited = new Promise<string>((r) => {
    exit = r;
  });
  const engine: ReplayEngine & { exit: (how: string) => void } = {
    port,
    ready: opts.fails === true ? Promise.reject(new Error('no answer')) : Promise.resolve(),
    exited,
    exit,
    stop: async () => {
      events.push(`stop ${port}`);
      exit('SIGTERM');
    },
  };
  engine.ready.catch(() => {});
  return engine;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

test('the replay starts over: each run takes over on the other port once ready, then the old one stops', async () => {
  const events: string[] = [];
  const switched: number[] = [];
  const cycler = new ReplayCycler({
    ports: [18790, 18791], cycleMs: 30, pauseMs: 10,
    start: (port, run) => {
      events.push(`start ${run} ${port}`);
      return fakeEngine(port, events);
    },
    onSwitch: (port) => switched.push(port),
  });
  assert.equal(cycler.target, null);
  await cycler.start();
  assert.equal(cycler.target, 18790);
  assert.equal(cycler.serving, 1);
  await until(() => cycler.serving >= 3);
  await cycler.stop();
  assert.deepEqual(events.slice(0, 5), ['start 1 18790', 'start 2 18791', 'stop 18790', 'start 3 18790', 'stop 18791']);
  assert.deepEqual(switched.slice(0, 3), [18790, 18791, 18790]);
  assert.equal(cycler.target, null);
  assert.equal(events.at(-1)?.startsWith('stop '), true);
});

test('a run that is never ready is stopped and tried again while the old one keeps serving; an exit is replaced', async () => {
  const events: string[] = [];
  const engines: ReturnType<typeof fakeEngine>[] = [];
  let fatal: string | null = null;
  const cycler = new ReplayCycler({
    ports: [1, 2], cycleMs: 20, pauseMs: 0, retryMs: { idle: 5, serving: 5 }, maxFailures: 3,
    start: (port, run) => {
      events.push(`start ${run} ${port}`);
      const e = fakeEngine(port, events, { fails: run === 2 });
      engines.push(e);
      return e;
    },
    fatal: (reason) => {
      fatal = reason;
    },
  });
  await cycler.start();
  await until(() => cycler.serving === 3);
  // Run 2 failed: stopped, and run 1 served until run 3 took over.
  assert.deepEqual(events.slice(0, 5), ['start 1 1', 'start 2 2', 'stop 2', 'start 3 2', 'stop 1']);
  assert.equal(cycler.target, 2);
  // The serving engine dies: a new run starts at once on the free port.
  const serving = engines[2]!;
  serving.exit('code 1');
  await until(() => cycler.serving === 4);
  assert.equal(cycler.target, 1);
  await cycler.stop();
  assert.equal(fatal, null);
});

test('runs failing in a row end in fatal()', async () => {
  let fatal: string | null = null;
  const cycler = new ReplayCycler({
    ports: [1, 2], cycleMs: 10, pauseMs: 0, retryMs: { idle: 1, serving: 1 }, maxFailures: 3,
    start: (port) => fakeEngine(port, [], { fails: true }),
    fatal: (reason) => {
      fatal = reason;
    },
  });
  await cycler.start();
  await until(() => fatal !== null);
  assert.match(fatal!, /3 runs in a row failed/);
  await cycler.stop();
});

test('the engine gets the system variables only: no key, token or port of the host', () => {
  const env = childEnv({
    PATH: '/usr/bin', HOME: '/root', TZ: 'UTC', PORT: '8080', NEAR_AI_API_KEY: 'k', ONECLICK_API_KEY: 'k', GIMBAL_VIEW_TOKEN: 't',
    GIMBAL_MODE: 'mainnet', GIMBAL_CONTRACT_ID: 'c', OPERATOR_PRIVATE_KEY: 'ed25519:x', GIMBAL_HOST: '0.0.0.0', NODE_OPTIONS: '--inspect',
    RAILWAY_DOCKERFILE_PATH: 'Dockerfile.replay',
  });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/root', TZ: 'UTC', GIMBAL_MODE: 'replay', GIMBAL_TRADE: '1' });
});

function webDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-host-test-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Gimbal</title>');
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  return dir;
}

test('static files: the file, else index.html; never a path outside the build', () => {
  const dir = webDir();
  try {
    assert.equal(staticFile(dir, '/'), join(dir, 'index.html'));
    assert.equal(staticFile(dir, '/assets/index-abc.js'), join(dir, 'assets', 'index-abc.js'));
    assert.equal(staticFile(dir, '/desk'), join(dir, 'index.html'));
    assert.equal(staticFile(dir, '/assets/missing.js'), null);
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json', '/%00']) {
      const f = staticFile(dir, p);
      assert.ok(f === null || f.startsWith(dir), p);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A stand-in engine over HTTP: answers GET /state from `state`, POST /stress with 200, and logs every request. */
async function fakeEngineServer(state: { desk: DeskState | null; rescue: RescueProgress | null }) {
  const seen: {
    method: string; url: string; host: string | undefined; origin: string | undefined; body: string; length: string | undefined; type: string | undefined;
  }[] = [];
  const flood = { written: 0 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '', url: req.url ?? '', host: req.headers.host, origin: req.headers.origin, body: Buffer.concat(chunks).toString(),
        length: req.headers['content-length'], type: req.headers['content-type'],
      });
      // As the engine does: a POST takes JSON bodies only.
      if (req.method === 'POST' && !/^application\/json/.test(req.headers['content-type'] ?? '')) {
        res.writeHead(415, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ ok: false, reason: 'JSON bodies only' }));
      }
      if (req.url === '/events?flood') {
        // Writes as fast as the reader takes it, the way the engine's SSE writer respects backpressure.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = Buffer.alloc(64 * 1024, 'x');
        const pump = () => {
          while (!res.destroyed) {
            flood.written += chunk.length;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
        };
        pump();
        return;
      }
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('retry: 5000\n\n');
        return;
      }
      const body = req.url === '/state' ? JSON.stringify({ mode: 'replay', journal: [], ...state } satisfies Partial<EngineState>) : JSON.stringify({ ok: true });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, flood, port: (server.address() as AddressInfo).port };
}

/** A raw HTTP/1.1 exchange on one keep-alive socket: what the host answers, byte for byte. */
function rawSocket(port: number, text: string, ms = 1_000): Promise<string> {
  return new Promise((done) => {
    const s = connect({ host: '127.0.0.1', port });
    let got = '';
    s.on('data', (c: Buffer) => (got += c.toString()));
    s.on('close', () => done(got));
    s.on('error', () => done(got));
    s.setTimeout(ms, () => s.destroy());
    s.write(text);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string; headers: IncomingMessage['headers'] }> {
  return new Promise((ok, bad) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', bad);
    req.end(body);
  });
}

test('the host server: refused writes never reach the engine, reads do, stress passes the gate only', async () => {
  const dir = webDir();
  const state: { desk: DeskState | null; rescue: RescueProgress | null } = { desk: desk([]), rescue: null };
  const engine = await fakeEngineServer(state);
  let target: number | null = null;
  const host = createHostServer({ webDir: dir, target: () => target, gate: new StressGate() });
  const port = await listen(host);
  const json = { 'content-type': 'application/json' };
  try {
    // No engine ready yet: the page is served, the API says so.
    assert.equal((await raw(port, 'GET', '/')).status, 200);
    assert.equal((await raw(port, 'GET', '/state')).status, 503);
    assert.equal((await raw(port, 'GET', '/healthz')).status, 503);
    target = engine.port;
    assert.equal((await raw(port, 'GET', '/healthz')).status, 200);

    const page = await raw(port, 'GET', '/desk');
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>Gimbal/);
    const asset = await raw(port, 'GET', '/assets/index-abc.js');
    assert.match(String(asset.headers['content-type']), /javascript/);
    assert.match(String(asset.headers['cache-control']), /immutable/);
    const escape = await raw(port, 'GET', '/%2e%2e/package.json');
    assert.equal(escape.status, 404);
    assert.doesNotMatch(escape.text, /"name"/);

    const read = await raw(port, 'GET', '/state', { origin: 'https://judge.example' });
    assert.equal(read.status, 200);
    assert.equal(engine.seen.at(-1)?.host, `127.0.0.1:${engine.port}`);
    assert.equal(engine.seen.at(-1)?.origin, undefined);

    const before = engine.seen.length;
    for (const [m, p, b] of [
      ['PUT', '/strategy', '{"auto":false}'], ['POST', '/rotate', '{"windowId":"x"}'], ['POST', '/close', '{}'], ['POST', '/close', ''],
      ['POST', '/policy/draft', '{}'], ['POST', '/setup', '{}'], ['DELETE', '/journal', ''],
    ] as const) {
      const r = await raw(port, m, p, json, b);
      assert.equal(r.status, 403, `${m} ${p}`);
      const body = JSON.parse(r.text) as { ok: boolean; reason: string };
      assert.equal(body.ok, false);
      assert.match(body.reason, /hosted replay/);
    }
    assert.equal(engine.seen.length, before, 'no refused write reached the engine');

    // Flat desk: refused here, only GET /state went to the engine.
    const flat = await raw(port, 'POST', '/stress', json, '{}');
    assert.equal(flat.status, 409);
    assert.match(flat.text, /No pair is held/);
    assert.deepEqual(engine.seen.slice(before).map((s) => `${s.method} ${s.url}`), ['GET /state']);

    // Another site's page cannot fire it.
    assert.equal((await raw(port, 'POST', '/stress', { ...json, origin: 'https://evil.example', host: 'demo.example' }, '{}')).status, 403);

    state.desk = desk([leg(0.06), leg(0.06)]);
    // A body other than none, {} or {"on":true} is refused before the gate, and does not use up the run's stress test.
    const seenBefore = engine.seen.length;
    for (const b of ['{"on":false}', '{"x":1}', 'not json']) {
      const r = await raw(port, 'POST', '/stress', json, b);
      assert.equal(r.status, 400, b);
      assert.match(r.text, /POST \/stress:/);
    }
    assert.equal(engine.seen.length, seenBefore, 'a refused body never reaches the engine');
    const ok = await raw(port, 'POST', '/stress', { ...json, origin: `http://127.0.0.1:${port}` }, '{}');
    assert.equal(ok.status, 200);
    assert.deepEqual(engine.seen.at(-1), {
      method: 'POST', url: '/stress', host: `127.0.0.1:${engine.port}`, origin: undefined, body: '{"on":true}', length: '11',
      type: 'application/json',
    });
    const again = await raw(port, 'POST', '/stress', json, '{"on":true}');
    assert.equal(again.status, 409);
    assert.match(JSON.parse(again.text).reason, /one stress test per run/);
    assert.equal(engine.seen.at(-1)?.url, '/stress', 'the second one did not even read the state');
  } finally {
    host.close();
    engine.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bodyless POST /stress with no content-type reaches the engine as JSON, not a 415', async () => {
  const dir = webDir();
  const engine = await fakeEngineServer({ desk: desk([leg(0.06), leg(0.06)]), rescue: null });
  const host = createHostServer({ webDir: dir, target: () => engine.port, gate: new StressGate() });
  const port = await listen(host);
  try {
    const r = await raw(port, 'POST', '/stress');
    assert.equal(r.status, 200, r.text);
    const sent = engine.seen.at(-1);
    assert.deepEqual([sent?.method, sent?.url, sent?.type, sent?.body], ['POST', '/stress', 'application/json', '{"on":true}']);
  } finally {
    host.close();
    engine.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a switch to the next run ends the open streams, so the page reconnects to it', async () => {
  const dir = webDir();
  const engine = await fakeEngineServer({ desk: null, rescue: null });
  const host = createHostServer({ webDir: dir, target: () => engine.port, gate: new StressGate() });
  const port = await listen(host);
  try {
    const ended = await new Promise<string>((done, bad) => {
      const req = request({ host: '127.0.0.1', port, path: '/events' }, (res) => {
        assert.equal(res.statusCode, 200);
        res.once('data', () => host.dropStreams());
        res.on('close', () => done('closed'));
        res.on('error', () => done('closed'));
      });
      req.on('error', bad);
      req.end();
    });
    assert.equal(ended, 'closed');
  } finally {
    host.close();
    engine.server.closeAllConnections();
    engine.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Opens GET /events from a client that never reads: its socket is paused, so the kernel buffers fill and stay full. */
function pausedStream(port: number, path = '/events?flood'): { socket: ReturnType<typeof connect>; closed: Promise<void> } {
  const socket = connect({ host: '127.0.0.1', port });
  socket.pause();
  socket.write(`GET ${path} HTTP/1.1\r\nHost: demo.example\r\n\r\n`);
  const closed = new Promise<void>((r) => {
    socket.on('close', () => r());
    socket.on('error', () => r());
  });
  return { socket, closed };
}

test('a client that stops reading holds no memory: the engine is paused behind it, nothing piles up in the host', async () => {
  const dir = webDir();
  const engine = await fakeEngineServer({ desk: null, rescue: null });
  const host = createHostServer({ webDir: dir, target: () => engine.port, gate: new StressGate() });
  const port = await listen(host);
  const client = pausedStream(port);
  try {
    await until(() => engine.flood.written > 0);
    // Let it run: without backpressure the host would buffer everything the engine writes (hundreds of MB a second).
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      await wait(25);
      peak = Math.max(peak, host.stats().unreadBytes);
    }
    const written = engine.flood.written;
    await wait(200);
    assert.ok(peak <= 1.1 * 1024 * 1024, `the host held ${peak} bytes for one paused client`);
    assert.ok(engine.flood.written - written <= 128 * 1024, 'the engine stopped writing: its stream waits on the client');
    assert.ok(engine.flood.written < 64 * 1024 * 1024, `the engine wrote ${engine.flood.written} bytes`);
  } finally {
    client.socket.destroy();
    host.close();
    engine.server.closeAllConnections();
    engine.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a client that leaves more than the cap unread is dropped, and the engine stream with it', async () => {
  const dir = webDir();
  const engine = await fakeEngineServer({ desk: null, rescue: null });
  const lines: string[] = [];
  const host = createHostServer({ webDir: dir, target: () => engine.port, gate: new StressGate(), maxUnreadBytes: 1024, log: (l) => lines.push(l) });
  const port = await listen(host);
  const client = pausedStream(port);
  try {
    // The client's socket is paused, so it notices nothing; the host's side is what must let go.
    await until(() => lines.some((l) => /client dropped: \d+ bytes unread on \/events\?flood, over 1024/.test(l)), 5_000);
    await until(() => host.stats().proxied === 0 && host.stats().streams === 0);
    const written = engine.flood.written;
    await wait(100);
    assert.equal(engine.flood.written, written, 'the engine stream was closed too');
    client.socket.resume();
    await Promise.race([client.closed, wait(2_000).then(() => assert.fail('the client never saw its connection end'))]);
  } finally {
    client.socket.destroy();
    host.close();
    engine.server.closeAllConnections();
    engine.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('event streams are capped per client address (X-Forwarded-For behind the proxy), not only for everyone', async () => {
  const dir = webDir();
  const engine = await fakeEngineServer({ desk: null, rescue: null });
  const host = createHostServer({ webDir: dir, target: () => engine.port, gate: new StressGate() });
  const port = await listen(host);
  const open: ReturnType<typeof request>[] = [];
  const stream = (xff: string) =>
    new Promise<number>((done, bad) => {
      const req = request({ host: '127.0.0.1', port, path: '/events', headers: { 'x-forwarded-for': xff } }, (res) => {
        done(res.statusCode ?? 0);
        res.resume();
      });
      req.on('error', (err) => (open.includes(req) ? undefined : bad(err)));
      req.end();
      open.push(req);
    });
  try {
    // Room for several judges' tabs behind one office or venue address.
    assert.equal(MAX_STREAMS_PER_CLIENT, 16);
    for (let i = 0; i < MAX_STREAMS_PER_CLIENT; i++) assert.equal(await stream('198.51.100.1, 192.0.2.7'), 200, `stream ${i + 1}`);
    assert.equal(host.stats().streams, MAX_STREAMS_PER_CLIENT);
    assert.equal(await stream('198.51.100.9, 192.0.2.7'), 429, 'the same last hop is the same client');
    assert.equal(await stream('192.0.2.8'), 200, 'another address still gets one');
    // Closing one frees a place.
    open[0]!.destroy();
    await until(() => host.stats().streams === MAX_STREAMS_PER_CLIENT);
    assert.equal(await stream('192.0.2.7'), 200);
  } finally {
    for (const r of open) r.destroy();
    host.close();
    engine.server.closeAllConnections();
    engine.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a GET or HEAD with a body is answered 400 and its connection closed; nothing of it reaches the engine', async () => {
  const dir = webDir();
  const engine = await fakeEngineServer({ desk: desk([]), rescue: null });
  const host = createHostServer({ webDir: dir, target: () => engine.port, gate: new StressGate() });
  const port = await listen(host);
  try {
    // The body is a second request: if it were left on a kept-alive connection it would be read as one.
    const smuggled = 'GET /journal HTTP/1.1\r\nHost: x\r\n\r\n';
    const answer = await rawSocket(port, `GET /state HTTP/1.1\r\nHost: demo.example\r\nContent-Length: ${smuggled.length}\r\n\r\n${smuggled}`);
    assert.match(answer, /^HTTP\/1\.1 400 /);
    assert.match(answer, /\r\nconnection: close\r\n/i);
    assert.equal((answer.match(/HTTP\/1\.1 /g) ?? []).length, 1, 'one answer, the body was not read as a request');
    const chunked = await rawSocket(port, 'HEAD /windows HTTP/1.1\r\nHost: demo.example\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n');
    assert.match(chunked, /^HTTP\/1\.1 400 /);
    assert.equal(engine.seen.length, 0, 'the engine saw none of it');

    // The next request is ordinary, and the engine gets it with no length and no body.
    const next = await raw(port, 'GET', '/state');
    assert.equal(next.status, 200);
    assert.deepEqual(engine.seen.map((s) => [s.method, s.url, s.length, s.body]), [['GET', '/state', undefined, '']]);
    // Two reads on one kept-alive connection both answered.
    const two = await rawSocket(port, 'GET /state HTTP/1.1\r\nHost: demo.example\r\n\r\nGET /journal HTTP/1.1\r\nHost: demo.example\r\n\r\n', 500);
    assert.equal((two.match(/HTTP\/1\.1 200 /g) ?? []).length, 2);
  } finally {
    host.close();
    engine.server.closeAllConnections();
    engine.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HEAD on an API path is a GET without the body: the stream answered here, the rest with the engine headers', async () => {
  const dir = webDir();
  const engine = await fakeEngineServer({ desk: desk([]), rescue: null });
  const host = createHostServer({ webDir: dir, target: () => engine.port, gate: new StressGate() });
  const port = await listen(host);
  try {
    const head = await raw(port, 'HEAD', '/state');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.match(String(head.headers['content-type']), /application\/json/);
    assert.deepEqual(engine.seen.map((s) => `${s.method} ${s.url}`), ['GET /state']);
    const events = await raw(port, 'HEAD', '/events');
    assert.equal(events.status, 200);
    assert.match(String(events.headers['content-type']), /text\/event-stream/);
    assert.equal(engine.seen.length, 1, 'HEAD /events does not open a stream on the engine');
    assert.equal(host.stats().streams, 0);
    const page = await raw(port, 'HEAD', '/');
    assert.equal(page.status, 200);
    assert.equal(page.text, '');
  } finally {
    host.close();
    engine.server.closeAllConnections();
    engine.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
