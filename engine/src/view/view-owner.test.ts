// Owner writes on the view listener (GIMBAL_OWNER_TOKEN): off unless set, both tokens needed, the lockout after wrong
// owner tokens, the write limit, the body rules, every other write still refused, and the request sent to the engine's
// own routes over loopback, whose handlers answer with their own status and body.

import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { VirtualClock } from '../venues/replay.ts';
import type { Book, MarketFunding, VenueReader } from '../venues/venue.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from '../scanner/config.ts';
import { Scanner } from '../scanner/scanner.ts';
import { EngineServer } from '../server.ts';
import { loopbackCall } from '../cli/serve-control.ts';
import { startView } from './serve-view.ts';
import { ownerTokenFromEnv } from './view-config.ts';
import { viewRedactor } from './view-redact.ts';
import {
  OWNER_FAIL_LIMIT, OWNER_HEADER, OWNER_LOCK_MS, OWNER_MAX_BODY_BYTES, OWNER_WRITE_LIMIT, OWNER_WRITE_WINDOW_MS, ViewServer,
} from './view-server.ts';
import type { OwnerCall } from './view-server.ts';

const T0 = Date.UTC(2026, 10, 9, 10);
const TOKEN = 'f4a6b8c3e1d7a9b2c5e0d3f6a1b4c7e9d2f5a8b0';
const OWNER = '9c2e7a1f4b8d3e6a0c5f9b2d7e1a4c8f3b6d0e5a';
const auth = { authorization: `Bearer ${TOKEN}` };
const both = { ...auth, [OWNER_HEADER]: OWNER };
const jsonType = { 'content-type': 'application/json' };

function reader(id: 'hyperliquid' | 'phoenix', ratePerHour: number): VenueReader {
  const rows: MarketFunding[] = [{
    venue: id, symbol: 'SOL', ratePerHour, settlement: 'hourly', nextAt: Date.UTC(2026, 10, 9, 11),
    markPx: 100, oraclePx: 100, openInterest: 50_000, volume24hUsd: null,
  }];
  const book: Book = { venue: id, symbol: 'SOL', time: T0, bids: [{ px: 99.99, sz: 1e4 }], asks: [{ px: 100.01, sz: 1e4 }] };
  return { id, funding: async () => rows, book: async () => book } as unknown as VenueReader;
}

let engine: EngineServer;
let enginePort: number;
const loop = { rotate: [] as unknown[][], close: 0, answer: { ok: true } as { ok: true } | { ok: false; reason: string } };

before(async () => {
  const scanner = new Scanner([reader('hyperliquid', 0.00005), reader('phoenix', 0.00001)], [], {
    config: DEFAULT_SCANNER_CONFIG, clock: new VirtualClock(T0), strategy: () => engine.strategy,
  });
  engine = new EngineServer({
    mode: 'mainnet', scanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, now: () => T0,
    strategyLoop: {
      rotate: (...args: unknown[]) => {
        loop.rotate.push(args);
        return loop.answer;
      },
      close: () => {
        loop.close++;
        return loop.answer;
      },
    },
  });
  enginePort = await engine.start(0);
});

after(async () => {
  await engine.stop();
});

function call(base: string, method: string, path: string, headers: OutgoingHttpHeaders = {}, body?: string): Promise<{ status: number; text: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    // A fresh connection each time: a refused write closes its connection, which a pooled socket would not know yet.
    const req = request(`${base}${path}`, { method, headers, agent: false }, (res) => {
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

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

interface Made { view: ViewServer; base: string; clock: { t: number }; lines: string[]; calls: unknown[][] }

/** A view with owner writes on; `call` defaults to the real engine's own server over loopback. */
async function makeView(ownerCall?: OwnerCall): Promise<Made> {
  const clock = { t: T0 };
  const lines: string[] = [];
  const calls: unknown[][] = [];
  const real = loopbackCall('127.0.0.1', enginePort);
  const view = new ViewServer({
    source: engine.viewSource(), token: TOKEN, origins: [], redact: viewRedactor({}), now: () => clock.t, log: (l) => lines.push(l),
    owner: {
      token: OWNER,
      call: async (method, path, body) => {
        calls.push([method, path, body]);
        return (ownerCall ?? real)(method, path, body);
      },
    },
  });
  const port = await view.start(0, '127.0.0.1');
  return { view, base: `http://127.0.0.1:${port}`, clock, lines, calls };
}

const reset = () => {
  loop.rotate = [];
  loop.close = 0;
  loop.answer = { ok: true };
};

test('off unless GIMBAL_OWNER_TOKEN is set and usable: the start line is as before, and the owner routes are 404', async () => {
  const port = await freePort();
  const run = async (vars: Record<string, string>, withCall = true) => {
    const lines: string[] = [];
    const view = await startView({
      env: (n) => vars[n], processEnv: vars, enginePort, engineHost: '127.0.0.1', source: engine.viewSource(), log: (l) => lines.push(l), host: '127.0.0.1',
      ...(withCall ? { ownerCall: loopbackCall('127.0.0.1', enginePort) } : {}),
    });
    return { view: view!, lines };
  };
  const base = { GIMBAL_VIEW_TOKEN: TOKEN, PORT: String(port) };
  // Unset: the same start line as without owner writes, and every owner route answers as it always has.
  const off = await run(base);
  try {
    assert.deepEqual(off.lines, [`view: read-only on :${port} for origins (none: no browser page may call it)`]);
    const b = `http://127.0.0.1:${port}`;
    for (const [m, p] of [['GET', '/owner'], ['POST', '/rotate'], ['POST', '/close'], ['GET', '/rotate']] as const) {
      assert.equal((await call(b, m, p, { ...both, ...jsonType }, m === 'GET' ? undefined : '{}')).status, 404, `${m} ${p}`);
    }
    const put = await call(b, 'PUT', '/strategy', { ...both, ...jsonType }, JSON.stringify(DEFAULT_STRATEGY));
    assert.equal(put.status, 405);
    assert.equal(put.headers.allow, 'GET');
    assert.deepEqual([loop.rotate.length, loop.close], [0, 0]);
  } finally {
    await off.view.stop();
  }
  // Bad values: off, with the reason and never the value.
  for (const [value, reason] of [
    ['short-owner-token', /owner writes off: GIMBAL_OWNER_TOKEN is 17 characters, under the 32 required/],
    ['a'.repeat(40), /owner writes off: GIMBAL_OWNER_TOKEN looks guessable/],
    [TOKEN, /owner writes off: GIMBAL_OWNER_TOKEN is the same as GIMBAL_VIEW_TOKEN/],
  ] as const) {
    const r = await run({ ...base, GIMBAL_OWNER_TOKEN: value });
    try {
      assert.equal(r.lines.length, 1);
      assert.match(r.lines[0]!, /^view: read-only on :\d+ for origins .*; owner writes off: /);
      assert.match(r.lines[0]!, reason);
      assert.ok(!r.lines[0]!.includes(value), 'the value is never on the start line');
      assert.equal((await call(`http://127.0.0.1:${port}`, 'GET', '/owner', both)).status, 404);
    } finally {
      await r.view.stop();
    }
  }
  // Set, but serve passed no way to reach its own routes: off.
  const noCall = await run({ ...base, GIMBAL_OWNER_TOKEN: OWNER }, false);
  await noCall.view.stop();
  assert.match(noCall.lines[0]!, /^view: read-only on /);
  // On: the start line says so, without either token.
  const on = await run({ ...base, GIMBAL_OWNER_TOKEN: OWNER });
  try {
    assert.match(on.lines[0]!, new RegExp(`^view: reads on :${port} for origins .*; owner writes on: POST /rotate, POST /close and PUT /strategy`));
    assert.ok(!on.lines[0]!.includes(OWNER) && !on.lines[0]!.includes(TOKEN));
    assert.equal((await call(`http://127.0.0.1:${port}`, 'GET', '/owner', both)).status, 204);
  } finally {
    await on.view.stop();
  }
  assert.deepEqual(ownerTokenFromEnv(() => undefined, TOKEN), { off: null });
});

test('the view token is still required, and the owner token is checked: missing or wrong is 403; right is 204', async () => {
  reset();
  const v = await makeView();
  try {
    // No view token: 401 before the owner token is looked at; nothing is called.
    for (const headers of [{ [OWNER_HEADER]: OWNER }, { authorization: `Bearer ${OWNER}`, [OWNER_HEADER]: OWNER }]) {
      assert.equal((await call(v.base, 'GET', '/owner', headers)).status, 401);
      assert.equal((await call(v.base, 'POST', '/rotate', { ...headers, ...jsonType }, JSON.stringify({ windowId: 'w' }))).status, 401);
    }
    // The view token alone, or with a wrong owner token: 403, never forwarded.
    for (const headers of [auth, { ...auth, [OWNER_HEADER]: `${OWNER}x` }, { ...auth, [OWNER_HEADER]: TOKEN }]) {
      const r = await call(v.base, 'POST', '/close', { ...headers, ...jsonType }, '{}');
      assert.equal(r.status, 403);
      assert.deepEqual(JSON.parse(r.text), { ok: false, error: 'owner', reason: 'the owner token was not accepted' });
      v.clock.t += OWNER_LOCK_MS * 2;   // past the fail window, so the lockout is its own test
    }
    assert.equal(v.calls.length, 0);
    assert.deepEqual([loop.rotate.length, loop.close], [0, 0]);
    const ok = await call(v.base, 'GET', '/owner', both);
    assert.equal(ok.status, 204);
    assert.equal(ok.text, '');
    assert.equal(v.calls.length, 0, 'the check writes nothing');
    for (const line of v.lines) assert.ok(!line.includes(TOKEN) && !line.includes(OWNER), line);
  } finally {
    await v.view.stop();
  }
});

test(`${OWNER_FAIL_LIMIT} wrong owner tokens make further wrong tries 429 for the lock time; the right token is always served`, async () => {
  reset();
  const v = await makeView();
  try {
    for (let i = 0; i < OWNER_FAIL_LIMIT; i++) assert.equal((await call(v.base, 'GET', '/owner', { ...auth, [OWNER_HEADER]: `wrong-${i}` })).status, 403);
    const locked = await call(v.base, 'GET', '/owner', { ...auth, [OWNER_HEADER]: 'wrong-again' });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers['retry-after']) > 0);
    assert.equal((await call(v.base, 'POST', '/close', { ...auth, [OWNER_HEADER]: 'wrong-again', ...jsonType }, '{}')).status, 429);
    assert.equal(loop.close, 0);
    assert.ok(v.lines.some((l) => /^view: wrong owner tokens refused until /.test(l)));
    // Wrong tries from anyone cannot lock the owner out: the right token is served during the lock.
    assert.equal((await call(v.base, 'GET', '/owner', both)).status, 204);
    assert.notEqual((await call(v.base, 'POST', '/close', { ...both, ...jsonType }, '{}')).status, 429);
    // Reads are not owner requests: still served.
    assert.equal((await call(v.base, 'GET', '/state', auth)).status, 200);
    v.clock.t += OWNER_LOCK_MS;
    assert.equal((await call(v.base, 'GET', '/owner', { ...auth, [OWNER_HEADER]: 'wrong-later' })).status, 403);
    // Without the view token even a wrong method says nothing about owner writes: 401, not 405.
    assert.equal((await call(v.base, 'POST', '/owner', { [OWNER_HEADER]: OWNER, ...jsonType }, '{}')).status, 401);
    assert.equal((await call(v.base, 'GET', '/close', {})).status, 401);
  } finally {
    await v.view.stop();
  }
});

test('the engine\'s own routes answer: their status and body come back, nothing relaxed', async () => {
  reset();
  const v = await makeView();
  try {
    // POST /rotate with demo: the route's handler parses it and calls the strategy loop, which answers.
    const ok = await call(v.base, 'POST', '/rotate', { ...both, ...jsonType }, JSON.stringify({ windowId: 'sol-hyperliquid-phoenix', demo: { maxLossUsd: 1 } }));
    assert.deepEqual([ok.status, JSON.parse(ok.text)], [200, { ok: true }]);
    assert.deepEqual(loop.rotate, [['sol-hyperliquid-phoenix', { maxLossUsd: 1 }]]);
    // The route's own refusals: a demo over the cap (parseDemo, 409), and the loop's (409 with its reason).
    const over = await call(v.base, 'POST', '/rotate', { ...both, ...jsonType }, JSON.stringify({ windowId: 'sol-hyperliquid-phoenix', demo: { maxLossUsd: 50 } }));
    assert.equal(over.status, 409);
    assert.match((JSON.parse(over.text) as { reason: string }).reason, /over the \$1\.00 a demo entry may accept/);
    loop.answer = { ok: false, reason: 'GIMBAL_TRADE is not 1: this engine trades nothing' };
    const refused = await call(v.base, 'POST', '/close', { ...both, ...jsonType }, '{}');
    assert.deepEqual([refused.status, JSON.parse(refused.text)], [409, { ok: false, reason: 'GIMBAL_TRADE is not 1: this engine trades nothing' }]);
    assert.equal(loop.close, 1);
    // PUT /strategy: the route checks the whole config.
    const bad = await call(v.base, 'PUT', '/strategy', { ...both, ...jsonType }, JSON.stringify({ ...DEFAULT_STRATEGY, legUsd: -5 }));
    assert.equal(bad.status, 400);
    assert.equal(engine.strategy.legUsd, DEFAULT_STRATEGY.legUsd);
    const good = await call(v.base, 'PUT', '/strategy', { ...both, ...jsonType }, JSON.stringify({ ...DEFAULT_STRATEGY, minNetAprPct: DEFAULT_STRATEGY.minNetAprPct + 1 }));
    assert.equal(good.status, 200);
    assert.equal(engine.strategy.minNetAprPct, DEFAULT_STRATEGY.minNetAprPct + 1);
    // One line per write: method, path, window id and status; never a token or a body.
    const owned = v.lines.filter((l) => l.startsWith('view: owner '));
    assert.deepEqual(owned, [
      'view: owner POST /rotate sol-hyperliquid-phoenix (demo): 200',
      'view: owner POST /rotate sol-hyperliquid-phoenix (demo): 409',
      'view: owner POST /close: 409',
      'view: owner PUT /strategy: 400',
      'view: owner PUT /strategy: 200',
    ]);
    for (const line of v.lines) assert.ok(!line.includes(TOKEN) && !line.includes(OWNER) && !line.includes('maxLossUsd'), line);
  } finally {
    await v.view.stop();
  }
});

test('the body rules: JSON only, an object, under the cap; POST /close takes none', async () => {
  reset();
  const v = await makeView();
  try {
    assert.equal((await call(v.base, 'POST', '/rotate', { ...both, 'content-type': 'text/plain' }, '{"windowId":"w"}')).status, 415);
    assert.equal((await call(v.base, 'POST', '/rotate', { ...both, ...jsonType }, '{"windowId":')).status, 400);
    assert.equal((await call(v.base, 'POST', '/rotate', { ...both, ...jsonType }, '["w"]')).status, 400);
    assert.equal((await call(v.base, 'POST', '/close', { ...both, ...jsonType }, '{"all":true}')).status, 400);
    const big = JSON.stringify({ windowId: 'w', pad: 'x'.repeat(OWNER_MAX_BODY_BYTES) });
    assert.equal((await call(v.base, 'POST', '/rotate', { ...both, ...jsonType }, big)).status, 413);
    assert.equal(v.calls.length, 0);
    // An empty POST /close is {} to the route.
    assert.equal((await call(v.base, 'POST', '/close', { ...both, ...jsonType })).status, 200);
    assert.deepEqual(v.calls, [['POST', '/close', {}]]);
  } finally {
    await v.view.stop();
  }
});

test(`at most ${OWNER_WRITE_LIMIT} owner writes a minute; the check (GET /owner) does not count`, async () => {
  reset();
  const v = await makeView(async () => ({ status: 200, body: { ok: true } }));
  try {
    for (let i = 0; i < OWNER_WRITE_LIMIT; i++) assert.equal((await call(v.base, 'POST', '/close', { ...both, ...jsonType }, '{}')).status, 200);
    assert.equal((await call(v.base, 'GET', '/owner', both)).status, 204);
    const limited = await call(v.base, 'POST', '/close', { ...both, ...jsonType }, '{}');
    assert.equal(limited.status, 429);
    assert.equal(v.calls.length, OWNER_WRITE_LIMIT);
    v.clock.t += OWNER_WRITE_WINDOW_MS;
    assert.equal((await call(v.base, 'POST', '/close', { ...both, ...jsonType }, '{}')).status, 200);
  } finally {
    await v.view.stop();
  }
});

test('with both tokens, every other write is still refused and never forwarded', async () => {
  reset();
  const v = await makeView();
  try {
    for (const [method, path] of [
      ['POST', '/stress'], ['POST', '/setup'], ['POST', '/policy/draft'], ['POST', '/strategy'], ['PATCH', '/strategy'], ['DELETE', '/state'],
      ['PUT', '/journal'], ['POST', '/events'], ['POST', '/view-ticket'], ['PUT', '/rotate'], ['GET', '/close'], ['POST', '/owner'], ['POST', '/pause'],
    ] as const) {
      const r = await call(v.base, method, path, { ...both, ...jsonType }, '{}');
      assert.ok(r.status === 404 || r.status === 405, `${method} ${path}: ${r.status}`);
    }
    assert.equal(v.calls.length, 0);
    assert.deepEqual([loop.rotate.length, loop.close], [0, 0]);
  } finally {
    await v.view.stop();
  }
});

test('an engine server that does not answer is 502, said plainly, and logged without a token', async () => {
  const v = await makeView(async () => {
    throw new Error(`connect ECONNREFUSED with ${OWNER}`);
  });
  try {
    const r = await call(v.base, 'POST', '/close', { ...both, ...jsonType }, '{}');
    assert.equal(r.status, 502);
    assert.ok(!r.text.includes(OWNER));
    for (const line of v.lines) assert.ok(!line.includes(OWNER), line);
  } finally {
    await v.view.stop();
  }
});
