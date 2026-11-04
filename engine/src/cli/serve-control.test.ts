// GIMBAL_CONTROL: one call of POST /rotate, POST /close or PUT /strategy through the engine's own server, at most once
// per run-id. Unset it does nothing; a marker stops it; a route not on the list is refused; it waits for the engine to
// be ready, a bounded time; a started run that never wrote its outcome is never run again; serve's shutdown drains it.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { VirtualClock } from '../venues/replay.ts';
import type { Book, MarketFunding, VenueReader } from '../venues/venue.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from '../scanner/config.ts';
import { Scanner } from '../scanner/scanner.ts';
import { EngineServer } from '../server.ts';
import type { StrategyHands } from '../server.ts';
import type { ControlDeps, ControlPath, RouteAnswer, RouteCall } from './serve-control.ts';
import { controlAddress, controlFromEnv, controlMarker, loopbackCall, parseControl, runControl, startControl } from './serve-control.ts';

const T0 = Date.UTC(2026, 10, 5, 10, 30);
const WINDOW = 'sol-hyperliquid-phoenix';

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-control-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function reader(id: 'hyperliquid' | 'phoenix', ratePerHour: number): VenueReader {
  const rows: MarketFunding[] = [{
    venue: id, symbol: 'SOL', ratePerHour, settlement: 'hourly', nextAt: Date.UTC(2026, 10, 5, 11),
    markPx: 100, oraclePx: 100, openInterest: 50_000, volume24hUsd: null,
  }];
  const book: Book = { venue: id, symbol: 'SOL', time: T0, bids: [{ px: 99.99, sz: 1e4 }], asks: [{ px: 100.01, sz: 1e4 }] };
  return { id, funding: async () => rows, book: async () => book } as unknown as VenueReader;
}

// The engine's real server, with fake hands behind /rotate and /close that count what reaches them.
let server: EngineServer;
let port: number;
const hands = { rotates: [] as unknown[], closes: 0 };
const fakeLoop: StrategyHands = {
  rotate: (windowId) => {
    hands.rotates.push(windowId);
    return { ok: true };
  },
  close: () => {
    hands.closes++;
    return { ok: false, reason: 'no pair is held: nothing to close' };
  },
};

before(async () => {
  const scanner = new Scanner([reader('hyperliquid', 0.00001), reader('phoenix', 0.00005)], [], {
    config: DEFAULT_SCANNER_CONFIG, clock: new VirtualClock(T0), strategy: () => server.strategy,
  });
  server = new EngineServer({
    mode: 'replay', scanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, now: () => T0 + 1,
    strategyLoop: fakeLoop,
  });
  port = await server.start(0);
});

after(async () => {
  await server.stop();
});

function deps(stateDir: string, value: string, o: Partial<ControlDeps> = {}): { d: ControlDeps; lines: string[] } {
  const lines: string[] = [];
  const d: ControlDeps = {
    ask: parseControl(value), stateDir, trade: true, waitingFor: () => null, call: loopbackCall('127.0.0.1', port),
    log: (l) => lines.push(l), now: () => T0, pollMs: 1, sleep: () => new Promise((r) => setImmediate(r)), ...o,
  };
  return { d, lines };
}

const rotate = (id: string) => JSON.stringify({ id, method: 'POST', path: '/rotate', body: { windowId: WINDOW } });

test('unset (or empty): nothing is started, logged, read or written', (t) => {
  const dir = tempDir(t);
  const lines: string[] = [];
  let calls = 0;
  const o = {
    stateDir: dir, trade: true, waitingFor: () => null, log: (l: string) => lines.push(l),
    call: (async () => { calls++; return { status: 200, body: null }; }) as RouteCall,
  };
  assert.equal(controlFromEnv(() => undefined, o), null);
  assert.equal(controlFromEnv((n) => (n === 'GIMBAL_CONTROL' ? '  ' : undefined), o), null);
  assert.deepEqual(lines, []);
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('only POST /rotate, POST /close and PUT /strategy are allowed; anything else is refused with a log line and no marker', async (t) => {
  const dir = tempDir(t);
  const refused: [string, RegExp][] = [
    [JSON.stringify({ id: 'a', method: 'POST', path: '/stress' }), /POST \/stress is not allowed; only POST \/rotate, POST \/close, PUT \/strategy/],
    [JSON.stringify({ id: 'a', method: 'POST', path: '/setup', body: {} }), /POST \/setup is not allowed/],
    [JSON.stringify({ id: 'a', method: 'GET', path: '/strategy' }), /GET \/strategy is not allowed/],
    [JSON.stringify({ id: 'a', method: 'PUT', path: '/rotate', body: { windowId: WINDOW } }), /PUT \/rotate is not allowed/],
    [JSON.stringify({ id: 'a', method: 'POST', path: '/rotate/' , body: {} }), /is not allowed/],
    [JSON.stringify({ id: 'a b', method: 'POST', path: '/close' }), /id "a b" is not \[A-Za-z0-9_-\]\{1,40\}/],
    [JSON.stringify({ id: 'x'.repeat(41), method: 'POST', path: '/close' }), /is not \[A-Za-z0-9_-\]\{1,40\}/],
    [JSON.stringify({ id: 'a', method: 'POST', path: '/rotate' }), /needs a body/],
    [JSON.stringify({ id: 'a', method: 'POST', path: '/close', body: { now: true } }), /POST \/close takes no body/],
    [JSON.stringify({ id: 'a', method: 'POST', path: '/close', extra: 1 }), /unknown field "extra"/],
    ['POST /close', /is not JSON/],
  ];
  for (const [value, why] of refused) {
    assert.throws(() => parseControl(value), why, value);
    const lines: string[] = [];
    let calls = 0;
    const run = startControl({
      value, stateDir: dir, trade: true, waitingFor: () => null, log: (l) => lines.push(l),
      call: async () => { calls++; return { status: 200, body: null }; },
    });
    assert.equal(run, null, value);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^control: refused: .*nothing was called and no marker was written$/);
    assert.equal(calls, 0);
  }
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(parseControl(JSON.stringify({ id: 'Scene-1_close', method: 'POST', path: '/close' })), { runId: 'Scene-1_close', method: 'POST', path: '/close' });
});

test('/rotate waits for the engine (first scan, pair, loop check), then calls the server\'s own route once; the same run-id never again', async (t) => {
  const dir = tempDir(t);
  hands.rotates.length = 0;
  let ready: string | null = 'the first scan';
  const asked: ControlPath[] = [];
  const { d, lines } = deps(dir, rotate('enter-1'), {
    waitingFor: (path) => {
      asked.push(path);
      return ready;
    },
  });
  const run = runControl(d);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(hands.rotates, [], 'nothing reaches the route before the engine is ready');
  assert.equal(existsSync(controlMarker(dir, 'enter-1')), false, 'no marker while it waits');
  ready = 'the strategy loop\'s first check of a scan';
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  ready = null;
  const result = await run;
  assert.deepEqual(result, { status: 'done', answer: { status: 200, body: { ok: true } } });
  assert.deepEqual(hands.rotates, [WINDOW], 'the route got the window id, once');
  assert.ok(asked.every((p) => p === '/rotate'));
  const marker = JSON.parse(readFileSync(controlMarker(dir, 'enter-1'), 'utf8'));
  assert.equal(marker.status, 'done');
  assert.deepEqual(marker.answer, { status: 200, body: { ok: true } });
  assert.deepEqual(marker.body, { windowId: WINDOW });
  assert.ok(lines.every((l) => l.startsWith('control: ')), 'every line has the prefix');
  assert.ok(lines.some((l) => l === 'control: waiting for the first scan (at most 600 s in all)'));
  assert.ok(lines.some((l) => l.startsWith('control: waiting for the strategy loop\'s first check of a scan')));
  assert.ok(lines.some((l) => l.startsWith('control: engine rules before the call (GET /strategy 200): {"auto":false')));
  assert.ok(lines.some((l) => l.startsWith('control: started: marker ')));
  assert.ok(lines.some((l) => l.startsWith('control: done: POST /rotate answered 200 {"ok":true}; ACCEPTED, not yet carried out: the rotate runs in the strategy loop now; wait for its result line')));

  // The next start, the variable still set: the marker says what happened and nothing is called.
  const again = deps(dir, rotate('enter-1'));
  const second = await runControl(again.d);
  assert.equal(second.status, 'marker');
  assert.deepEqual(hands.rotates, [WINDOW]);
  assert.match(again.lines[0]!, /^control: run enter-1 has a marker \(.*\), so nothing runs: done at .*, POST \/rotate answered 200 \{"ok":true\}; unset GIMBAL_CONTROL$/);
});

test('the route\'s own refusal is its answer: kept in the marker as done, with the status and the reason', async (t) => {
  const dir = tempDir(t);
  const before = hands.closes;
  const { d, lines } = deps(dir, JSON.stringify({ id: 'close-1', method: 'POST', path: '/close' }));
  const result = await runControl(d);
  assert.deepEqual(result, { status: 'done', answer: { status: 409, body: { ok: false, reason: 'no pair is held: nothing to close' } } });
  assert.equal(hands.closes, before + 1);
  assert.ok(lines.some((l) => l === 'control: done: POST /close answered 409 {"ok":false,"reason":"no pair is held: nothing to close"}'));
});

test('PUT /strategy goes through the route\'s own checks: a bad config is answered 400 and changes nothing, a good one is set', async (t) => {
  const dir = tempDir(t);
  const bad = { ...DEFAULT_STRATEGY, risk: { watchDistancePct: 8, rescueDistancePct: 15 } };
  const r1 = await runControl(deps(dir, JSON.stringify({ id: 'risk-bad', method: 'PUT', path: '/strategy', body: bad })).d);
  assert.equal(r1.status, 'done');
  assert.equal((r1 as { answer: RouteAnswer }).answer.status, 400);
  assert.deepEqual(server.strategy, DEFAULT_STRATEGY);

  const raised = { ...DEFAULT_STRATEGY, risk: { watchDistancePct: 40, rescueDistancePct: 35 } };
  const r2 = await runControl(deps(dir, JSON.stringify({ id: 'risk-up', method: 'PUT', path: '/strategy', body: raised })).d);
  assert.deepEqual(r2, { status: 'done', answer: { status: 200, body: raised } });
  assert.deepEqual(server.strategy.risk, { watchDistancePct: 40, rescueDistancePct: 35 });
  const restored = await runControl(deps(dir, JSON.stringify({ id: 'risk-back', method: 'PUT', path: '/strategy', body: DEFAULT_STRATEGY })).d);
  assert.equal(restored.status, 'done');
  assert.deepEqual(server.strategy, DEFAULT_STRATEGY);
});

test('/rotate and /close need GIMBAL_TRADE=1: refused before any wait, nothing called, no marker (PUT /strategy does not)', async (t) => {
  const dir = tempDir(t);
  let calls = 0;
  const call: RouteCall = async () => { calls++; return { status: 200, body: {} }; };
  for (const value of [rotate('r1'), JSON.stringify({ id: 'c1', method: 'POST', path: '/close' })]) {
    const { d, lines } = deps(dir, value, { trade: false, call, waitingFor: () => { throw new Error('not asked'); } });
    const r = await runControl(d);
    assert.equal(r.status, 'refused');
    assert.match(lines.at(-1)!, /^control: refused: GIMBAL_TRADE is not 1: POST \/(rotate|close) trades nothing in this engine; nothing was called and no marker was written/);
  }
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(dir), []);
  const s = await runControl(deps(dir, JSON.stringify({ id: 's1', method: 'PUT', path: '/strategy', body: DEFAULT_STRATEGY }), { trade: false, call }).d);
  assert.equal(s.status, 'done');
});

test('not ready within the bound: the marker says failed, nothing is called, and the run-id is not tried again', async (t) => {
  const dir = tempDir(t);
  let now = T0;
  let calls = 0;
  const call: RouteCall = async () => { calls++; return { status: 200, body: {} }; };
  const { d, lines } = deps(dir, rotate('late'), {
    call, waitMs: 60_000, now: () => now, sleep: async (ms) => { now += ms * 1000; },
    waitingFor: () => 'the pair\'s start (legs unknown, start not confirmed: hyperliquid read failed)',
  });
  const r = await runControl(d);
  assert.equal(r.status, 'failed');
  assert.equal(calls, 0);
  const marker = JSON.parse(readFileSync(controlMarker(dir, 'late'), 'utf8'));
  assert.equal(marker.status, 'failed');
  assert.match(marker.error, /not ready for POST \/rotate within 60 s: still waiting for the pair's start/);
  assert.match(lines.at(-1)!, /^control: failed: .*nothing was called; marker .*; not retried/);
  const again = await runControl(deps(dir, rotate('late'), { call }).d);
  assert.equal(again.status, 'marker');
  assert.equal(calls, 0);
});

test('a restart after `started` with no outcome: logged as an unknown outcome and not retried', async (t) => {
  const dir = tempDir(t);
  writeFileSync(controlMarker(dir, 'cut'), JSON.stringify({ status: 'started', runId: 'cut', method: 'POST', path: '/rotate', body: { windowId: WINDOW }, startedAt: '2026-11-05T10:00:00.000Z' }));
  let calls = 0;
  const { d, lines } = deps(dir, rotate('cut'), { call: async () => { calls++; return { status: 200, body: {} }; } });
  const r = await runControl(d);
  assert.deepEqual(r, { status: 'marker', marker: controlMarker(dir, 'cut'), was: 'started' });
  assert.equal(calls, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^control: run cut has a marker .*: POST \/rotate started at 2026-11-05T10:00:00.000Z with no outcome written; not retried: unknown outcome/);
  // An unreadable marker is no permission either.
  writeFileSync(controlMarker(dir, 'torn'), '{"status":"sta');
  const torn = await runControl(deps(dir, rotate('torn'), { call: async () => { calls++; return { status: 200, body: {} }; } }).d);
  assert.equal(torn.status, 'marker');
  assert.equal(calls, 0);
});

test('a call that fails after the marker: `failed` with the error, an unknown outcome, never retried', async (t) => {
  const dir = tempDir(t);
  const { d, lines } = deps(dir, rotate('lost'), {
    call: async (method) => {
      if (method === 'GET') return { status: 200, body: DEFAULT_STRATEGY };
      throw new Error('socket hang up');
    },
  });
  const r = await runControl(d);
  assert.deepEqual(r, { status: 'failed', error: 'socket hang up' });
  const marker = JSON.parse(readFileSync(controlMarker(dir, 'lost'), 'utf8'));
  assert.equal(marker.status, 'failed');
  assert.equal(marker.error, 'socket hang up');
  assert.match(lines.at(-1)!, /^control: failed: socket hang up; not retried: unknown outcome/);
});

test('drain: a run still waiting stops with no marker (it runs at the next start); a run past its marker is waited for', async (t) => {
  const dir = tempDir(t);
  // Waiting: drain stops it.
  const lines: string[] = [];
  let calls = 0;
  const waiting = startControl({
    value: rotate('drain-wait'), stateDir: dir, trade: true, waitingFor: () => 'the first scan', pollMs: 1,
    call: async () => { calls++; return { status: 200, body: {} }; }, log: (l) => lines.push(l),
  })!;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(waiting.inFlight(), false);
  assert.deepEqual(await waiting.drain(), { status: 'stopped' });
  assert.equal(calls, 0);
  assert.equal(existsSync(controlMarker(dir, 'drain-wait')), false);
  assert.match(lines.at(-1)!, /^control: stopped: serve is stopping before the call; .* drain-wait runs at the next start$/);

  // In the call: drain waits until the route answered and the outcome is on disk.
  let release!: (a: RouteAnswer) => void;
  const answered = new Promise<RouteAnswer>((r) => { release = r; });
  const inCall = startControl({
    value: rotate('drain-call'), stateDir: dir, trade: true, waitingFor: () => null, log: () => {},
    call: async (method) => (method === 'GET' ? { status: 200, body: DEFAULT_STRATEGY } : answered),
  })!;
  for (let i = 0; i < 50 && !inCall.inFlight(); i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(inCall.inFlight(), true);
  assert.equal(JSON.parse(readFileSync(controlMarker(dir, 'drain-call'), 'utf8')).status, 'started');
  let drained = false;
  const drain = inCall.drain().then((r) => { drained = true; return r; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(drained, false, 'the drain waits for the call');
  release({ status: 200, body: { ok: true } });
  assert.deepEqual(await drain, { status: 'done', answer: { status: 200, body: { ok: true } } });
  assert.equal(inCall.inFlight(), false);
  assert.equal(JSON.parse(readFileSync(controlMarker(dir, 'drain-call'), 'utf8')).status, 'done');
});

test('a different request under a used run-id is NOT run and says so loudly; the same request (keys in any order) is the plain marker line', async (t) => {
  const dir = tempDir(t);
  const raise = { ...DEFAULT_STRATEGY, risk: { watchDistancePct: 40, rescueDistancePct: 35 } };
  const first = await runControl(deps(dir, JSON.stringify({ id: 'scene-2', method: 'PUT', path: '/strategy', body: raise })).d);
  assert.equal(first.status, 'done');
  let calls = 0;
  const call: RouteCall = async () => { calls++; return { status: 200, body: {} }; };
  const different: [string, string][] = [
    [JSON.stringify({ id: 'scene-2', method: 'PUT', path: '/strategy', body: DEFAULT_STRATEGY }), 'another body'],
    [JSON.stringify({ id: 'scene-2', method: 'POST', path: '/close' }), 'another route'],
    [JSON.stringify({ id: 'scene-2', method: 'POST', path: '/rotate', body: { windowId: WINDOW } }), 'another route and body'],
  ];
  for (const [value, why] of different) {
    const { d, lines } = deps(dir, value, { call });
    const r = await runControl(d);
    assert.deepEqual(r, { status: 'marker', marker: controlMarker(dir, 'scene-2'), was: 'different' }, why);
    assert.equal(lines.length, 1, why);
    assert.match(lines[0]!, /^control: DIFFERENT request under used run-id scene-2: NOT run\. The marker .* \(done\) is for PUT \/strategy \{.*"rescueDistancePct":35.*\}; GIMBAL_CONTROL asks /, why);
    assert.doesNotMatch(lines[0]!, /done at|answered/, why);
  }
  // The same request, its keys in another order: the marker's own line.
  const reordered = { risk: { rescueDistancePct: 35, watchDistancePct: 40 }, ...Object.fromEntries(Object.entries(DEFAULT_STRATEGY).filter(([k]) => k !== 'risk').reverse()) };
  const same = deps(dir, JSON.stringify({ path: '/strategy', body: reordered, method: 'PUT', id: 'scene-2' }), { call });
  const r = await runControl(same.d);
  assert.deepEqual(r, { status: 'marker', marker: controlMarker(dir, 'scene-2'), was: 'done' });
  assert.match(same.lines[0]!, /^control: run scene-2 has a marker .*: done at .*, PUT \/strategy answered 200/);
  assert.equal(calls, 0);
  assert.equal(server.strategy.risk.rescueDistancePct, 35, 'nothing changed the rules after the first run');
  await runControl(deps(dir, JSON.stringify({ id: 'scene-2-back', method: 'PUT', path: '/strategy', body: DEFAULT_STRATEGY })).d);
});

test('until: a value past it is refused with no marker, also when it passes during the wait; a bad until is refused at parse', async (t) => {
  const dir = tempDir(t);
  let calls = 0;
  const call: RouteCall = async () => { calls++; return { status: 200, body: {} }; };
  const withUntil = (id: string, until: string) => JSON.stringify({ id, method: 'POST', path: '/close', until });
  assert.equal(parseControl(withUntil('u', '2026-11-05T10:31:00Z')).until, Date.UTC(2026, 10, 5, 10, 31));
  assert.equal(parseControl(withUntil('u', '2026-11-05T12:31:00.000+02:00')).until, Date.UTC(2026, 10, 5, 10, 31));
  // Dates and times that do not exist are refused, not rolled over (Date.parse reads 2026-02-30 as March 2).
  assert.equal(parseControl(withUntil('u', '2028-02-29T23:59:59.5-05:00')).until, Date.parse('2028-03-01T04:59:59.500Z'));
  for (const bad of [
    '2026-11-05', '2026-11-05T10:31:00', 'tomorrow', '2026-13-45T10:31:00Z', '2026-02-30T10:00:00Z', '2026-04-31T10:00:00+02:00',
    '2026-11-05T24:00:00Z', '2026-11-05T10:61:00Z', '2026-11-05T10:31:60Z', '2026-11-05T10:31:00+25:00',
  ]) {
    assert.throws(() => parseControl(withUntil('u', bad)), /until .* is not an ISO time with a zone/, bad);
  }
  assert.throws(() => parseControl(JSON.stringify({ id: 'u', method: 'POST', path: '/close', until: 1 })), /until 1 is not/);

  // Past at the start: a variable left set on a later deploy (a new volume has no marker).
  const stale = deps(dir, withUntil('stale', '2026-11-05T10:00:00Z'), { call });
  assert.equal((await runControl(stale.d)).status, 'refused');
  assert.match(stale.lines.at(-1)!, /^control: refused: its until, 2026-11-05T10:00:00.000Z, has passed; nothing was called and no marker was written/);

  // Passing during the wait: refused right before the marker.
  let now = T0;
  let ready = false;
  const waiting = deps(dir, withUntil('in-wait', '2026-11-05T10:31:00Z'), {
    call, now: () => now, waitingFor: () => (ready ? null : 'the first scan'),
    sleep: async () => { now += 30_000; if (now > T0 + 90_000) ready = true; },
  });
  assert.equal((await runControl(waiting.d)).status, 'refused');
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(dir), []);

  // In time: runs, and the marker keeps the until.
  const ok = deps(dir, withUntil('in-time', '2026-11-05T11:00:00Z'));
  assert.equal((await runControl(ok.d)).status, 'done');
  assert.equal(JSON.parse(readFileSync(controlMarker(dir, 'in-time'), 'utf8')).until, '2026-11-05T11:00:00.000Z');
});

test('serve\'s own stopping flag stops a run still waiting, without a drain', async (t) => {
  const dir = tempDir(t);
  let serveStopping = false;
  const run = startControl({
    value: rotate('serve-stops'), stateDir: dir, trade: true, waitingFor: () => 'the first scan', pollMs: 1,
    stopping: () => serveStopping, call: async () => ({ status: 200, body: {} }), log: () => {},
  })!;
  await new Promise((r) => setTimeout(r, 5));
  serveStopping = true;
  assert.deepEqual(await run.done, { status: 'stopped' });
  assert.equal(existsSync(controlMarker(dir, 'serve-stops')), false);
});

test('a wildcard listen address is reached on loopback; a named one as is', () => {
  assert.equal(controlAddress('0.0.0.0'), '127.0.0.1');
  assert.equal(controlAddress('::'), '::1');
  assert.equal(controlAddress('127.0.0.1'), '127.0.0.1');
  assert.equal(controlAddress('[::1]'), '::1');
  assert.equal(controlAddress('localhost'), 'localhost');
});
