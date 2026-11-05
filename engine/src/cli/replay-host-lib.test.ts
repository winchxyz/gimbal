// The hosted replay: its read-only guard (what the public port refuses, and that a refused write never reaches the
// engine), the stress gate, the loop that starts the replay over, the engine's environment and the static files.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DeskState, EngineState, Leg, RescueProgress } from '@gimbal/shared';
import type { ReplayEngine } from './replay-host-lib.ts';
import { READ_ONLY_REASON, ReplayCycler, StressGate, childEnv, createHostServer, hostedRoute, staticFile } from './replay-host-lib.ts';

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

test('a stress test needs a held pair, no rescue running, none in flight, and one a minute for everyone', () => {
  let now = 1_000_000;
  const gate = new StressGate({ cooldownMs: 60_000, now: () => now });
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
  const cooling = gate.check(held);
  assert.equal(cooling?.status, 429);
  assert.equal(cooling?.retryAfterS, 60);
  now += 59_500;
  assert.equal(gate.check(held)?.retryAfterS, 1);
  now += 500;
  assert.equal(gate.check(held), null);
  // A refused one does not start the cooldown; a new run clears it.
  gate.begin();
  gate.end(false);
  assert.equal(gate.check(held), null);
  gate.begin();
  gate.end(true);
  assert.equal(gate.check(held)?.status, 429);
  gate.reset();
  assert.equal(gate.check(held), null);
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
  const seen: { method: string; url: string; host: string | undefined; origin: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', host: req.headers.host, origin: req.headers.origin, body: Buffer.concat(chunks).toString() });
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
  return { server, seen, port: (server.address() as AddressInfo).port };
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
    const ok = await raw(port, 'POST', '/stress', { ...json, origin: `http://127.0.0.1:${port}` }, '{}');
    assert.equal(ok.status, 200);
    assert.deepEqual(engine.seen.at(-1), { method: 'POST', url: '/stress', host: `127.0.0.1:${engine.port}`, origin: undefined, body: '{}' });
    const again = await raw(port, 'POST', '/stress', json, '{}');
    assert.equal(again.status, 429);
    assert.equal(again.headers['retry-after'], '60');
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
