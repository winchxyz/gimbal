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
import type { Window as FundingWindow } from '@gimbal/shared';
import { profitCheck } from '../scanner/price.ts';
import { LoopStore, StrategyLoop, loopStateFile } from '../strategy/loop.ts';
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
const hands = { rotates: [] as unknown[], demos: [] as unknown[], closes: 0 };
const fakeLoop: StrategyHands = {
  rotate: (windowId, demo) => {
    hands.rotates.push(windowId);
    hands.demos.push(demo);
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

test('/rotate with demo: the body goes to the route as given (the route and the loop check it), shown on the log and kept in the marker', async (t) => {
  const dir = tempDir(t);
  hands.rotates.length = 0;
  hands.demos.length = 0;
  const value = JSON.stringify({ id: 'demo-1', method: 'POST', path: '/rotate', body: { windowId: WINDOW, demo: { maxLossUsd: 0.25 } } });
  const { d, lines } = deps(dir, value);
  const result = await runControl(d);
  assert.deepEqual(result, { status: 'done', answer: { status: 200, body: { ok: true } } });
  assert.deepEqual(hands.rotates, [WINDOW]);
  assert.deepEqual(hands.demos, [{ maxLossUsd: 0.25 }], 'the route passed demo to the loop');
  assert.ok(lines.some((l) => l.startsWith(`control: run demo-1: POST /rotate {"windowId":"${WINDOW}","demo":{"maxLossUsd":0.25}}; no marker at `)));
  const marker = JSON.parse(readFileSync(controlMarker(dir, 'demo-1'), 'utf8'));
  assert.deepEqual(marker.body, { windowId: WINDOW, demo: { maxLossUsd: 0.25 } });
  // Without demo the route calls the loop with the window id alone, as before.
  const plain = await runControl(deps(dir, rotate('plain-1')).d);
  assert.equal(plain.status, 'done');
  assert.deepEqual(hands.demos, [{ maxLossUsd: 0.25 }, undefined]);
});

test('POST /rotate with a demo that is not { maxLossUsd } within the cap: 409 with parseDemo\'s reason, the loop never called', async () => {
  const post = async (body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/rotate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as { ok: boolean; reason?: string } };
  };
  hands.rotates.length = 0;
  hands.demos.length = 0;
  for (const [demo, why] of [
    [null, /^POST \/rotate's demo must be "demo": \{ "maxLossUsd"/],
    [[], /^POST \/rotate's demo must be/],
    [[0.25], /^POST \/rotate's demo must be/],
    [{}, /^a demo entry needs maxLossUsd/],
    [{ maxLossUsd: {} }, /^demo maxLossUsd \{\} is not a number above 0/],
    [{ maxLossUsd: 0 }, /^demo maxLossUsd 0 is not a number above 0/],
    [{ maxLossUsd: 2 }, /^demo maxLossUsd 2 is over the \$1\.00 a demo entry may accept/],
    [{ maxLossUsd: 0.25, by: 'x' }, /unknown field "by"/],
    ['0.25', /^POST \/rotate's demo must be/],
  ] as [unknown, RegExp][]) {
    const r = await post({ windowId: WINDOW, demo });
    assert.equal(r.status, 409, JSON.stringify(demo));
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason!, why);
  }
  assert.deepEqual(hands.rotates, [], 'nothing reached the loop');
  // A valid one reaches it, parsed.
  assert.deepEqual(await post({ windowId: WINDOW, demo: { maxLossUsd: 0.25 } }), { status: 200, body: { ok: true } });
  assert.deepEqual(hands.demos, [{ maxLossUsd: 0.25 }]);
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

// ---- 3b: POST /rotate waits until the route would start it (the strategy loop's own rotateRefusal) ----

const ZEC = 'zec-phoenix-hyperliquid';
const NO_HISTORY = { ok: false, text: 'No 7-day funding history on both legs yet: the spread expected over a 7-day hold is not known, against a $0.04 round trip' };
const PROFIT = profitCheck('Over a 7-day hold, the 7-day spread of 3.00 % APR pays $0.01 at $12.00 a leg, no more than the $0.04 round trip');
const DEMO_BODY = { windowId: ZEC, demo: { maxLossUsd: 0.25 } };

function zecWindow(checks: FundingWindow['checks'], over: Partial<FundingWindow> = {}): FundingWindow {
  return {
    id: ZEC, symbol: 'ZEC', longVenue: 'phoenix', shortVenue: 'hyperliquid', grossAprPct: 3, grossApr7dPct: 3,
    costs: { feesPct: 2, slippagePct: 1, basisPct: 1, rescueReservePct: 0 }, netAprPct: -1, usdPerDayPer1k: 0, breakevenHours: null,
    depthUsd: 1e6, intervalsAbove: 0, updatedAt: T0, tradable: true, held: null, checks: [{ ok: true, text: 'policy ok' }, ...checks],
    switchCostUsd: null, stale: false, ...over,
  } as FundingWindow;
}

/** A real StrategyLoop (fake hands, a flat desk, auto on) whose last scan is `scan.windows`: its rotateRefusal is the route's check. */
async function realLoop(t: { after(fn: () => void): void }, scan: { windows: FundingWindow[] | null }): Promise<StrategyLoop> {
  const dir = tempDir(t);
  const nothing = { ok: false, reason: 'not in this test', sent: false, tx: [], feeUsd: 0, open: [] };
  const loop = new StrategyLoop({
    // A 20 USD leg, as on mainnet: a demo entry's taker fallback (50 bps of it) is held to maxLossUsd with the round trip.
    trade: true, strategy: () => ({ ...DEFAULT_STRATEGY, auto: true, legUsd: 20 }), policy: () => ({ max_notional_usd: 5000 }) as never, windows: () => scan.windows,
    hands: { blocked: () => null, held: () => null, symbolOf: (w) => ({ symbol: w.symbol }), open: async () => nothing, close: async () => nothing },
    freeMargin: async () => ({ hyperliquid: 900, phoenix: 800 }), liveRescue: () => ({ hyperliquid: true, phoenix: false }), busy: () => null,
    store: new LoopStore(loopStateFile(dir, 'testnet', 'gimbal-test.testnet', 'desk-1')), publish: () => {}, clock: { now: () => T0 }, log: () => {},
    decide: (input) => ({ decision: { action: 'wait', reason: 'nothing clears the bar', windowId: null, heldId: null, at: input.now }, counters: input.counters, act: null, vetoCandidate: null }),
    facts: async (ws, lotsFor = []) => ({
      lots: Object.fromEntries([...ws.map((x) => x.id), ...lotsFor].map((id) => [id, { longLot: '0.01', shortLot: '0.01', px: 100 }])), roundTripUsd: { [ZEC]: 0.04 },
    }),
  });
  await loop.check();
  return loop;
}

/**
 * A run of `body` against a stub route; `scans[i]` is the last scan during poll i (the last one kept), each poll moving
 * the clock by 1 s. rotateRefusal is `refusal` (default: the real loop's, reading the scripted scan).
 */
async function waitRun(t: { after(fn: () => void): void }, body: Record<string, unknown>, scans: FundingWindow[][], o: { waitMs?: number; refusal?: ControlDeps['rotateRefusal'] } = {}) {
  const dir = tempDir(t);
  const scan = { windows: scans[0] ?? null };
  const loop = await realLoop(t, scan);
  const lines: string[] = [];
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const asked: unknown[][] = [];
  const clock = { t: T0 };
  let poll = 0;
  const refusal = o.refusal ?? ((id: unknown, demo: unknown) => loop.rotateRefusal(id, demo));
  const d: ControlDeps = {
    ask: parseControl(JSON.stringify({ id: 'wait-1', method: 'POST', path: '/rotate', body })), stateDir: dir, trade: true, waitingFor: () => null,
    rotateRefusal: (id, demo) => {
      asked.push([id, demo]);
      return refusal(id, demo);
    },
    call: async (method, path, b) => {
      calls.push({ method, path, ...(b === undefined ? {} : { body: b }) });
      return method === 'GET' ? { status: 200, body: { auto: true } } : { status: 200, body: { ok: true } };
    },
    log: (l) => lines.push(l), now: () => clock.t, waitMs: o.waitMs ?? 60_000, pollMs: 1_000,
    sleep: async (ms) => {
      clock.t += ms;
      poll++;
      scan.windows = scans[Math.min(poll, scans.length - 1)]!;
    },
  };
  const result = await runControl(d);
  const rotates = calls.filter((c) => c.path === '/rotate');
  const waits = lines.filter((l) => l.startsWith(`control: waiting for ${ZEC}`));
  return { dir, result, lines, calls, rotates, waits, asked, clock };
}

test('3b: a demo /rotate after a restart waits while its window has no 7-day history, then is sent once, as given, when the history is in', async (t) => {
  const r = await waitRun(t, DEMO_BODY, [[zecWindow([NO_HISTORY])], [zecWindow([NO_HISTORY])], [zecWindow([NO_HISTORY])], [zecWindow([PROFIT])]]);
  assert.deepEqual(r.result, { status: 'done', answer: { status: 200, body: { ok: true } } });
  assert.deepEqual(r.rotates, [{ method: 'POST', path: '/rotate', body: DEMO_BODY }], 'sent once, with the body as given');
  assert.equal(r.clock.t, T0 + 3_000, 'three polls, then sent');
  assert.deepEqual(r.asked.at(-1), [ZEC, { maxLossUsd: 0.25 }], 'the route\'s check is asked with the window and demo the handler passes');
  assert.deepEqual(r.waits, [
    `control: waiting for ${ZEC}: POST /rotate would be refused now (${ZEC} fails a check a demo entry does not waive: ${NO_HISTORY.text}); `
      + 'asked again every 1 s, at most 60 s in all; a demo entry waives the profit checks only, so they are not waited on',
  ], 'one line for one reason');
  assert.ok(r.lines.includes(`control: ${ZEC} passes every check POST /rotate does not waive (the profit checks a demo entry waives are not waited on): calling it`));
  // Nothing was started while it waited: the marker comes after the wait.
  assert.ok(r.lines.findIndex((l) => l.startsWith(`control: waiting for ${ZEC}`)) < r.lines.findIndex((l) => l.startsWith('control: started: marker')));
});

test('3b: a demo /rotate whose window fails only its profit checks is sent at once; a plain /rotate waits on them', async (t) => {
  const demo = await waitRun(t, DEMO_BODY, [[zecWindow([PROFIT])]]);
  assert.equal(demo.result.status, 'done');
  assert.deepEqual(demo.waits, []);
  assert.equal(demo.clock.t, T0, 'sent at once');
  assert.equal(demo.rotates.length, 1);

  const plain = await waitRun(t, { windowId: ZEC }, [[zecWindow([PROFIT])], [zecWindow([PROFIT])], [zecWindow([])]]);
  assert.equal(plain.result.status, 'done');
  assert.deepEqual(plain.asked[0], [ZEC, undefined], 'no demo sent: none passed');
  assert.deepEqual(plain.waits, [`control: waiting for ${ZEC}: POST /rotate would be refused now (${ZEC} fails a check: ${PROFIT.text}); asked again every 1 s, at most 60 s in all`]);
  assert.ok(plain.lines.includes(`control: ${ZEC} passes every check POST /rotate does not waive: calling it`));
  assert.equal(plain.clock.t, T0 + 2_000);
  assert.equal(plain.rotates.length, 1);
});

test('3b: a window that never passes (not in the policy): nothing is called, the marker says failed with the reason, not retried', async (t) => {
  const refused = zecWindow([], { refused: { code: 'E_MARKET_NOT_ALLOWED', reason: 'ZEC is not in the policy' } } as Partial<FundingWindow>);
  const r = await waitRun(t, DEMO_BODY, [[refused]], { waitMs: 5_000 });
  const reason = `${ZEC} is refused: E_MARKET_NOT_ALLOWED ZEC is not in the policy`;
  const error = `POST /rotate ${ZEC} would still be refused after 5 s: ${reason}`;
  assert.deepEqual(r.result, { status: 'failed', error });
  assert.deepEqual(r.calls, [], 'nothing was called, not even GET /strategy');
  const marker = JSON.parse(readFileSync(controlMarker(r.dir, 'wait-1'), 'utf8'));
  assert.equal(marker.status, 'failed');
  assert.equal(marker.error, error);
  assert.equal(r.lines.at(-1), `control: failed: ${error}; nothing was called; marker ${controlMarker(r.dir, 'wait-1')}; not retried: pick a new run-id once it passes`);
  assert.equal(r.clock.t, T0 + 5_000, 'it gave up at the budget');
  assert.ok(!r.lines.some((l) => l.startsWith('control: started')));
});

test('3b: the wait line comes when the reason changes (numbers aside), else at most once a minute', async (t) => {
  let poll = 0;
  const reasons = (i: number) => (i < 3 ? `${ZEC} is not in the last scan`
    : i < 150 ? `${ZEC} fails a check a demo entry does not waive: No 7-day funding history on both legs yet, against a $0.0${i % 9} round trip` : null);
  const r = await waitRun(t, DEMO_BODY, [[]], { waitMs: 600_000, refusal: () => reasons(poll++) });
  assert.equal(r.result.status, 'done');
  assert.equal(r.rotates.length, 1);
  assert.equal(r.clock.t, T0 + 150_000);
  // Polls 0 (not in the scan), 3 (no history), then 63 and 123 (a minute after the line before).
  assert.equal(r.waits.length, 4);
  assert.match(r.waits[0]!, /would be refused now \(zec-phoenix-hyperliquid is not in the last scan\)/);
  assert.match(r.waits[1]!, /No 7-day funding history on both legs yet, against a \$0\.03 round trip/);
  assert.match(r.waits[2]!, /\$0\.0[0-8] round trip\); asked again every 1 s, at most 600 s in all$/);
  assert.equal(r.waits.filter((l) => l.includes('a demo entry waives')).length, 1, 'the demo note on the first line only');
});

test('3b: POST /close and PUT /strategy never ask the rotate check; serve is stopping during the wait: stopped, no marker', async (t) => {
  for (const value of [JSON.stringify({ id: 'c', method: 'POST', path: '/close' }), JSON.stringify({ id: 's', method: 'PUT', path: '/strategy', body: DEFAULT_STRATEGY })]) {
    const dir = tempDir(t);
    let asked = 0;
    const lines: string[] = [];
    const result = await runControl({
      ask: parseControl(value), stateDir: dir, trade: true, waitingFor: () => null, log: (l) => lines.push(l), now: () => T0, sleep: async () => {},
      rotateRefusal: () => {
        asked++;
        return 'never';
      },
      call: async () => ({ status: 200, body: {} }),
    });
    assert.equal(result.status, 'done', value);
    assert.equal(asked, 0, value);
    assert.ok(!lines.some((l) => l.includes('would be refused now')), value);
  }
  const dir = tempDir(t);
  let stopping = false;
  const result = await runControl({
    ask: parseControl(JSON.stringify({ id: 'stop-1', method: 'POST', path: '/rotate', body: DEMO_BODY })), stateDir: dir, trade: true, waitingFor: () => null,
    log: () => {}, now: () => T0, sleep: async () => { stopping = true; }, stopping: () => stopping,
    rotateRefusal: () => `${ZEC} fails a check a demo entry does not waive: ${NO_HISTORY.text}`, call: async () => { throw new Error('not called'); },
  });
  assert.deepEqual(result, { status: 'stopped' });
  assert.deepEqual(readdirSync(dir), []);
});

test('a wildcard listen address is reached on loopback; a named one as is', () => {
  assert.equal(controlAddress('0.0.0.0'), '127.0.0.1');
  assert.equal(controlAddress('::'), '::1');
  assert.equal(controlAddress('127.0.0.1'), '127.0.0.1');
  assert.equal(controlAddress('[::1]'), '::1');
  assert.equal(controlAddress('localhost'), 'localhost');
});
