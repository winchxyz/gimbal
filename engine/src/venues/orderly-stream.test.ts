// The desk's private Orderly stream against a fake socket: one ws auth signature per session, the auth frame
// Orderly expects, the three subscriptions, ping answered with pong, the positions and holding seed reads once the
// subscriptions are on (an idle account never pushes), pushes winning over the reads, a failed seed read that leaves
// its topic unknown without ending the session, a new session after any other failure, the silence watchdog, and
// pushes with missing fields read as unknown, never zero.
// The account valuation is checked against numbers worked out by hand. No live private call is made anywhere.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { OrderlyFuturesRow, OrderlyInfoRow } from './orderly.ts';
import { OrderlyReader, parseAccount } from './orderly.ts';
import type { OrderlyRestAction } from './orderly-signer.ts';
import type { OrderlyAccountSnapshot, OrderlySessionReads, OrderlyStreamPosition } from './orderly-stream.ts';
import { ORDERLY_PRIVATE_TOPICS, OrderlyAccountStream, parsePosition, parseRestPosition } from './orderly-stream.ts';
import { VirtualClock, readWireRecording, replayFetch, replayWsRequester } from './replay.ts';
import type { WebSocketLike, WsEvent } from './ws.ts';

const NOW = Date.UTC(2026, 9, 31, 1);
const ACCOUNT = `0x${'5e'.repeat(32)}`;
const KEY = `ed25519:${'2'.repeat(44)}`;
const SIG = Array.from({ length: 64 }, (_, i) => (i * 11 + 3) % 256);

type Listener = (ev: WsEvent) => void;

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  readonly url: string;
  readonly #listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] };

  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    assert.equal(this.readyState, 1, 'sent before the socket opened');
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number): void {
    if (this.readyState >= 2) return;
    this.closedWith = code;
    this.readyState = 3;
    queueMicrotask(() => this.#emit('close', { code: code ?? 1005 }));
  }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    this.#listeners[type]!.push(listener);
  }
  open(): void {
    this.readyState = 1;
    this.#emit('open', {});
  }
  push(msg: Record<string, unknown>): void {
    this.#emit('message', { data: JSON.stringify(msg) });
  }
  drop(code: number, reason: string): void {
    this.readyState = 3;
    this.#emit('close', { code, reason });
  }
  #emit(type: string, ev: WsEvent): void {
    for (const l of this.#listeners[type]!) l(ev);
  }
}

interface SetupOptions {
  timeoutMs?: number;
  silenceMs?: number;
  /** Signer failures to inject, one per call, before it signs normally: an Error to throw, or a desk id to sign for. */
  failures?: (Error | { desk: string })[];
  factoryThrows?: number;
  /** The seed reads; by default they never answer, so only pushes make the state known. */
  reads?: Partial<OrderlySessionReads>;
  seedTimeoutMs?: number;
}

const never = () => new Promise<unknown>(() => {});

function setup(options: SetupOptions = {}) {
  const sockets: FakeSocket[] = [];
  const signed: number[] = [];
  const reports: Record<string, unknown>[] = [];
  const positionLists: [string[], 'push' | 'read'][] = [];
  const failures = [...(options.failures ?? [])];
  let factoryThrows = options.factoryThrows ?? 0;
  const clock = new VirtualClock(NOW);
  const signer = {
    async orderlyWsAuth(deskId: string, timestamp: number): Promise<OrderlyRestAction> {
      signed.push(timestamp);
      const failure = failures.shift();
      if (failure instanceof Error) throw failure;
      return {
        desk_id: failure?.desk ?? deskId, request_id: signed.length, venue: 'orderly', kind: 'ws_auth',
        payload: { method: '', path: '', body: '', timestamp, message: String(timestamp) }, signature: { scheme: 'Ed25519', signature: SIG },
      };
    },
  };
  const stream = new OrderlyAccountStream({
    deskId: 'alpha', accountId: ACCOUNT, orderlyKey: KEY, signer, clock, timeoutMs: options.timeoutMs ?? 200, silenceMs: options.silenceMs ?? 10_000,
    reads: { positions: options.reads?.positions ?? never, holding: options.reads?.holding ?? never },
    seedTimeoutMs: options.seedTimeoutMs ?? 5_000,
    webSocket: (url) => {
      if (factoryThrows > 0) {
        factoryThrows--;
        throw new Error('socket factory failed');
      }
      const s = new FakeSocket(url);
      sockets.push(s);
      queueMicrotask(() => s.open());
      return s;
    },
    onExecutionReport: (r) => reports.push(r),
    onPositions: (positions, from) => positionLists.push([positions.map((p) => `${p.symbol} ${p.positionQty}`), from]),
  });
  return { stream, sockets, signed, reports, positionLists, clock };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(check(), 'condition never held');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function login(s: FakeSocket): void {
  s.push({ id: 'auth-1', event: 'auth', success: true, ts: NOW });
}

async function loggedIn(s: ReturnType<typeof setup>, index = 0): Promise<FakeSocket> {
  const started = s.stream.start();
  await until(() => s.sockets[index]?.sent.length === 1);
  login(s.sockets[index]!);
  await started;
  return s.sockets[index]!;
}

const SOL_ROW = {
  symbol: 'PERP_SOL_USDC', positionQty: 2, costPosition: 190, lastSumUnitaryFunding: 1.5, averageOpenPrice: 95, estLiqPrice: 0, accruedFundingFee: 0.4,
};
const positionPush = (positions: unknown[], ts = NOW + 5) => ({ topic: 'position', ts, data: { positions } });
const balancePush = (holding: number, frozen = 0, ts = NOW + 6) => ({ topic: 'balance', ts, data: { balances: { USDC: { holding, frozen } } } });

test('one ws auth signature opens the session: auth frame auth-1, then the three topics', async () => {
  const s = setup({ timeoutMs: 5_000 });   // the 200 ms default flaked under a loaded CI box
  const started = s.stream.start();
  await until(() => s.sockets[0]?.sent.length === 1);
  const sock = s.sockets[0]!;
  assert.equal(sock.url, `wss://ws-private-evm.orderly.org/v2/ws/private/stream/${ACCOUNT}`);
  assert.deepEqual(sock.sent[0], { id: 'auth-1', event: 'auth', params: { orderly_key: KEY, sign: Buffer.from(SIG).toString('base64url'), timestamp: NOW } });
  login(sock);
  await started;
  assert.deepEqual(sock.sent.slice(1), ORDERLY_PRIVATE_TOPICS.map((topic) => ({ id: `sub-${topic}`, event: 'subscribe', topic })));
  // Reads and repeated starts reuse the session: still one signature.
  await s.stream.start();
  sock.push(positionPush([]));
  sock.push(balancePush(100));
  await s.stream.state();
  await s.stream.state();
  assert.deepEqual(s.signed, [NOW]);
  assert.equal(s.stream.signatures, 1);
  s.stream.close();
});

test('ping is answered with pong carrying the same ts, before and after login', async () => {
  const s = setup();
  const started = s.stream.start();
  await until(() => s.sockets[0]?.sent.length === 1);
  const sock = s.sockets[0]!;
  sock.push({ event: 'ping', ts: 111 });
  login(sock);
  await started;
  sock.push({ event: 'ping', ts: 222 });
  assert.deepEqual(sock.sent.filter((f) => f.event === 'pong'), [{ event: 'pong', ts: 111 }, { event: 'pong', ts: 222 }]);
  s.stream.close();
});

test('state() waits for both first pushes; positions replace, balances merge, reports go to the callback', async () => {
  const s = setup();
  const sock = await loggedIn(s);
  let done = false;
  const first = s.stream.state().then((x) => { done = true; return x; });
  s.clock.set(NOW + 50);
  sock.push(positionPush([{ ...SOL_ROW, markPrice: 96, accruedFundingFee: '0.4' }]));
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, 'no balance push yet');
  s.clock.set(NOW + 70);
  sock.push(balancePush(500, 20));
  const snap = await first;
  assert.deepEqual(snap, {
    accountId: ACCOUNT,
    positions: [{ ...SOL_ROW, markPrice: 96 }],
    balances: { USDC: { holding: 500, frozen: 20 } },
    invalidBalances: {},
    positionsAt: NOW + 5,
    balancesAt: NOW + 6,
    positionsFrom: 'push',
    positionsReceivedAt: NOW + 50,
    balancesFrom: 'push',
    confirmedAt: NOW + 70,          // the local time of the server's last frame
    holdingRead: false,             // no holding read answered: a missing USDC row stays unknown
  });
  sock.push(positionPush([{ ...SOL_ROW, symbol: 'PERP_ETH_USDC', positionQty: -1 }], NOW + 9));
  sock.push({ topic: 'balance', ts: NOW + 10, data: { balances: { USDT: { holding: '7', frozen: 0 } } } });
  sock.push({ topic: 'executionreport', ts: NOW + 11, data: { orderId: 42, status: 'FILLED' } });
  s.clock.set(NOW + 90);
  sock.push({ event: 'ping', ts: 1 });
  const next = await s.stream.state();
  assert.deepEqual(next.positions.map((p) => p.symbol), ['PERP_ETH_USDC'], 'each position push is the whole list');
  assert.deepEqual(next.balances, { USDC: { holding: 500, frozen: 20 }, USDT: { holding: 7, frozen: 0 } });
  assert.equal(next.confirmedAt, NOW + 90, 'a ping confirms the cache too');
  assert.deepEqual(s.reports, [{ orderId: 42, status: 'FILLED' }]);
  s.stream.close();
});

test('a signer that throws ends the session: the next start() signs again and connects', async () => {
  const s = setup({ failures: [new Error('contract unreachable')] });
  await assert.rejects(s.stream.start(), /contract unreachable/);
  await assert.rejects(s.stream.state(), /contract unreachable/, 'a dead session stays dead for reads');
  assert.equal(s.sockets.length, 0);
  await loggedIn(s);
  assert.equal(s.signed.length, 2);
  assert.equal(s.sockets.length, 1);
  s.stream.close();
});

test('a signature for another desk and a socket factory that throws also end the session, and the next start() retries', async () => {
  const wrongDesk = setup({ failures: [{ desk: 'beta' }] });
  await assert.rejects(wrongDesk.stream.start(), /for desk beta, not alpha/);
  assert.equal(wrongDesk.sockets.length, 0, 'nothing is opened with a signature for another desk');
  await loggedIn(wrongDesk);
  assert.equal(wrongDesk.signed.length, 2);
  wrongDesk.stream.close();

  const noSocket = setup({ factoryThrows: 1 });
  await assert.rejects(noSocket.stream.start(), /socket factory failed/);
  await loggedIn(noSocket);
  assert.equal(noSocket.signed.length, 2);
  noSocket.stream.close();
});

test('a refused login fails start(); the next start signs again on a new socket', async () => {
  const s = setup();
  const started = s.stream.start();
  await until(() => s.sockets[0]?.sent.length === 1);
  s.sockets[0]!.push({ id: 'auth-1', event: 'auth', success: false, errorMsg: 'orderly key error' });
  await assert.rejects(started, /login refused: orderly key error/);
  assert.equal(s.sockets[0]!.closedWith, 1000);
  await loggedIn(s, 1);
  assert.equal(s.signed.length, 2);
  s.stream.close();
});

test('timeouts: no auth answer, then neither a seed read nor a push after login', async () => {
  const quiet = setup({ timeoutMs: 30 });
  await assert.rejects(quiet.stream.start(), /no auth answer within 30 ms/);

  const s = setup({ timeoutMs: 30, seedTimeoutMs: 40 });
  const sock = await loggedIn(s);
  sock.push(balancePush(1));
  await assert.rejects(s.stream.state(), /no positions within 40 ms \(neither the seed read nor a push\)/);
  s.stream.close();
});

test('a stalled stream (half-open socket) is killed after silenceMs; pings keep a live one open', async () => {
  const live = setup({ silenceMs: 60 });
  const liveSock = await loggedIn(live);
  liveSock.push(positionPush([]));
  liveSock.push(balancePush(10));
  for (let i = 0; i < 5; i++) {
    await sleep(20);
    liveSock.push({ event: 'ping', ts: i });
  }
  await live.stream.state();                                   // 100 ms in, still alive: pings every 20 ms
  live.stream.close();

  const stalled = setup({ silenceMs: 40 });
  const sock = await loggedIn(stalled);
  sock.push(positionPush([SOL_ROW]));
  sock.push(balancePush(10));
  await stalled.stream.state();
  await sleep(70);                                             // the server says nothing, the socket stays "open"
  await assert.rejects(stalled.stream.state(), /no frame from the server for 40 ms/);
  assert.equal(sock.closedWith, 1000);
  await loggedIn(stalled, 1);                                  // a new session, a new signature
  assert.equal(stalled.signed.length, 2);
  stalled.stream.close();
});

test('a dropped socket fails waiting reads; reads stay dead until start(); close() before login fails the start', async () => {
  const s = setup();
  const sock = await loggedIn(s);
  const waiting = s.stream.state();
  await new Promise((r) => setImmediate(r));
  sock.drop(1006, 'gone');
  await assert.rejects(waiting, /closed \(1006 gone\)/);
  await assert.rejects(s.stream.state(), /closed \(1006 gone\)/);
  assert.equal(s.sockets.length, 1);
  assert.equal(s.stream.signatures, 1);
  // A drop between start() and the read is caught too.
  const again = await loggedIn(s, 1);
  const racing = s.stream.state();
  again.drop(1001, 'away');
  await assert.rejects(racing, /closed \(1001 away\)/);

  const early = setup();
  const pending = early.stream.start();
  await until(() => early.sockets[0]?.sent.length === 1);
  early.stream.close();
  await assert.rejects(pending, /orderly private stream: closed/);
});

test('a position push with a missing or renamed field makes the positions unknown, never zero, until a good push', async () => {
  const s = setup();
  const sock = await loggedIn(s);
  sock.push(balancePush(10));
  const { lastSumUnitaryFunding: _gone, ...noSum } = SOL_ROW;
  sock.push(positionPush([noSum]));
  await assert.rejects(s.stream.state(), /position push unusable: position PERP_SOL_USDC: lastSumUnitaryFunding is missing/);
  sock.push(positionPush([{ ...SOL_ROW, positionQty: 'two' }]));
  await assert.rejects(s.stream.state(), /positionQty is not a number \("two"\)/);
  sock.push({ topic: 'position', ts: NOW, data: { rows: [SOL_ROW] } });     // the list under another name
  await assert.rejects(s.stream.state(), /data\.positions is not a list/);
  sock.push(positionPush([SOL_ROW]));
  assert.equal((await s.stream.state()).positions.length, 1);
  s.stream.close();
});

test('a balance row missing a field is marked invalid for that token, not read as 0', async () => {
  const s = setup();
  const sock = await loggedIn(s);
  sock.push(positionPush([]));
  sock.push({ topic: 'balance', ts: NOW, data: { balances: { USDC: { holding: 12 }, USDT: { holding: 1, frozen: 0 } } } });
  const snap = await s.stream.state();
  assert.deepEqual(snap.balances, { USDT: { holding: 1, frozen: 0 } });
  assert.deepEqual(snap.invalidBalances, { USDC: 'balance: frozen is missing' });
  sock.push(balancePush(12, 1));
  const fixed = await s.stream.state();
  assert.deepEqual([fixed.balances.USDC, fixed.invalidBalances], [{ holding: 12, frozen: 1 }, {}]);
  s.stream.close();
});

// ---- the seed reads (Orderly sends no snapshot on subscribe) ----

/** GET /v1/positions as Orderly answers it (snake_case, no accrued funding fee). */
const REST_SOL = {
  symbol: 'PERP_SOL_USDC', position_qty: 2, cost_position: 190, last_sum_unitary_funding: 1.5, average_open_price: 95, est_liq_price: 0,
  mark_price: 96, mmr: 0.006, imr: 0.01, settle_price: 95, pnl_24_h: 0,
};
const restPositions = (...rows: unknown[]) => ({ rows, current_margin_ratio_with_orders: 0 });
const restHolding = (...rows: { token: string; holding: number; frozen: number }[]) => ({ holding: rows.map((r) => ({ ...r, pending_short: 0, updated_time: 1 })) });

function acks(sock: FakeSocket): void {
  for (const topic of ORDERLY_PRIVATE_TOPICS) sock.push({ id: `sub-${topic}`, event: 'subscribe', success: true, ts: NOW });
}

function gate<T>(): { promise: Promise<T>; open: (v: T) => void } {
  let open!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    open = res;
  });
  return { promise, open };
}

const tick = () => new Promise((r) => setImmediate(r));

test('an idle account is served from the seed reads, sent once the subscriptions are acknowledged', async () => {
  let reads = 0;
  const s = setup({
    reads: {
      positions: async () => { reads++; return restPositions(REST_SOL); },
      holding: async () => { reads++; return restHolding({ token: 'USDC', holding: 250, frozen: 3 }); },
    },
  });
  const sock = await loggedIn(s);
  await tick();
  assert.equal(reads, 0, 'no read before Orderly acknowledged the position and balance subscriptions');
  s.clock.set(NOW + 40);
  acks(sock);
  const snap = await s.stream.state();
  assert.equal(reads, 2);
  assert.deepEqual(snap.positions, [{
    symbol: 'PERP_SOL_USDC', positionQty: 2, costPosition: 190, lastSumUnitaryFunding: 1.5, averageOpenPrice: 95, estLiqPrice: 0, markPrice: 96, mmr: 0.006, imr: 0.01,
  }], 'the REST row has no accrued funding fee, and none is made up');
  assert.deepEqual(snap.balances, { USDC: { holding: 250, frozen: 3 } });
  assert.deepEqual([snap.positionsFrom, snap.balancesFrom, snap.positionsAt, snap.balancesAt], ['read', 'read', NOW + 40, NOW + 40]);
  assert.deepEqual(s.positionLists, [[['PERP_SOL_USDC 2'], 'read']]);
  assert.equal(s.stream.signatures, 1, 'the reads are the signer\'s, not ws auth signatures');
  // A later push replaces the read and carries the funding fee.
  sock.push(positionPush([SOL_ROW], NOW + 50));
  const next = await s.stream.state();
  assert.deepEqual([next.positionsFrom, next.positions[0]!.accruedFundingFee], ['push', 0.4]);
  assert.deepEqual(s.positionLists.at(-1), [['PERP_SOL_USDC 2'], 'push']);
  s.stream.close();

  // Without the acknowledgements the reads go once timeoutMs has passed.
  const late = setup({ timeoutMs: 20, reads: { positions: async () => restPositions(), holding: async () => restHolding() } });
  await loggedIn(late);
  const lateSnap = await late.stream.state();
  assert.deepEqual([lateSnap.positions, lateSnap.balances, lateSnap.positionsFrom], [[], {}, 'read']);
  late.stream.close();
});

test('a push that comes before the read answers wins; the read only fills in balance tokens no push named', async () => {
  const positions = gate<unknown>();
  const holding = gate<unknown>();
  const s = setup({ reads: { positions: () => positions.promise, holding: () => holding.promise } });
  const sock = await loggedIn(s);
  acks(sock);
  await tick();
  sock.push(positionPush([{ ...SOL_ROW, positionQty: 5 }], NOW + 7));
  sock.push(balancePush(900, 0, NOW + 8));
  positions.open(restPositions(REST_SOL));
  holding.open(restHolding({ token: 'USDC', holding: 1, frozen: 0 }, { token: 'USDT', holding: 4, frozen: 1 }));
  await tick();
  await tick();
  const snap = await s.stream.state();
  assert.deepEqual(snap.positions.map((p) => p.positionQty), [5], 'the read does not overwrite the push');
  assert.deepEqual(snap.balances, { USDC: { holding: 900, frozen: 0 }, USDT: { holding: 4, frozen: 1 } });
  assert.deepEqual([snap.positionsFrom, snap.balancesFrom, snap.positionsAt], ['push', 'push', NOW + 7]);
  s.stream.close();
});

test('a failed seed read leaves its topic unknown without ending the session; a push or reseed() makes it known', async () => {
  let positionsCalls = 0;
  const s = setup({
    reads: {
      positions: async () => {
        positionsCalls++;
        if (positionsCalls === 1) throw new Error('E_ARGS: kind "positions" is not an Orderly request kind');
        return restPositions(REST_SOL);
      },
      holding: async () => restHolding({ token: 'USDC', holding: 99, frozen: 0 }),
    },
  });
  const sock = await loggedIn(s);
  acks(sock);
  await assert.rejects(s.stream.state(), /the positions read that seeds the session failed: E_ARGS: kind "positions"/);
  assert.equal(sock.closedWith, undefined, 'the session lives on');
  await s.stream.reseed();
  const snap = await s.stream.state();
  assert.deepEqual([snap.positions.length, snap.positionsFrom, positionsCalls], [1, 'read', 2]);
  assert.equal(s.stream.signatures, 1);
  s.stream.close();

  const pushed = setup({ reads: { positions: async () => { throw new Error('read refused'); }, holding: async () => restHolding() } });
  const pushedSock = await loggedIn(pushed);
  acks(pushedSock);
  await assert.rejects(pushed.stream.state(), /read refused/);
  pushedSock.push(positionPush([]));
  assert.equal((await pushed.stream.state()).positionsFrom, 'push');
  pushed.stream.close();

  // A read that is not Orderly's shape is unknown too, never an empty account.
  const odd = setup({ reads: { positions: async () => ({ rows: [{ symbol: 'PERP_SOL_USDC', position_qty: 1 }] }), holding: async () => ({ list: [] }) } });
  const oddSock = await loggedIn(odd);
  acks(oddSock);
  await assert.rejects(odd.stream.state(), /position read unusable: position PERP_SOL_USDC: cost_position is missing/);
  oddSock.push(positionPush([]));
  assert.deepEqual((await odd.stream.state()).invalidBalances, { '*': 'data.holding is not a list' });
  odd.stream.close();
});

test('positionsState(): positions alone, usable while the holding is unknown (round-1 contract: both reads refused)', async () => {
  const refused = async () => { throw new Error('E_ARGS: kind is not an Orderly request kind'); };
  const s = setup({ reads: { positions: refused, holding: refused } });
  const sock = await loggedIn(s);
  acks(sock);
  await assert.rejects(s.stream.positionsState(), /the positions read that seeds the session failed/);
  s.clock.set(NOW + 300);
  sock.push(positionPush([{ ...SOL_ROW, positionQty: -0.005 }], NOW + 290));
  const p = await s.stream.positionsState();
  assert.deepEqual([p.positions[0]!.positionQty, p.positionsFrom, p.positionsAt, p.positionsReceivedAt], [-0.005, 'push', NOW + 290, NOW + 300]);
  await assert.rejects(s.stream.state(), /the holding read that seeds the session failed/, 'the full state still needs the holding');
  sock.drop(1006, 'gone');
  await assert.rejects(s.stream.positionsState(), /closed \(1006 gone\)/);
});

test('a refused subscription ends the session', async () => {
  const s = setup({ reads: { positions: async () => restPositions(), holding: async () => restHolding() } });
  const sock = await loggedIn(s);
  sock.push({ id: 'sub-position', event: 'subscribe', success: false, errorMsg: 'topic not allowed' });
  await assert.rejects(s.stream.state(), /subscribe sub-position refused: topic not allowed/);
  assert.equal(sock.closedWith, 1000);
});

test('parseRestPosition names what is missing and keeps an accrued funding fee when Orderly sends one', () => {
  assert.throws(() => parseRestPosition({ ...REST_SOL, est_liq_price: null }), /est_liq_price is not a number \(null\)/);
  assert.throws(() => parseRestPosition({ ...REST_SOL, symbol: undefined }), /no symbol/);
  assert.equal(parseRestPosition({ ...REST_SOL, accrued_funding_fee: '-0.2' }).accruedFundingFee, -0.2);
  assert.equal('accruedFundingFee' in parseRestPosition(REST_SOL), false);
});

test('the stream refuses a key that is not ed25519:<base58>; parsePosition names what is missing', () => {
  const signer = { orderlyWsAuth: async () => { throw new Error('never'); } };
  const reads = { positions: never, holding: never };
  assert.throws(() => new OrderlyAccountStream({ deskId: 'alpha', accountId: ACCOUNT, orderlyKey: 'ed25519:0O', signer, reads }), /ed25519:<base58>/);
  assert.throws(() => parsePosition({ ...SOL_ROW, estLiqPrice: undefined }), /estLiqPrice is missing/);
  assert.throws(() => parsePosition({ ...SOL_ROW, symbol: '' }), /no symbol/);
  assert.deepEqual(parsePosition({ ...SOL_ROW, mmr: 'x' }), SOL_ROW, 'an optional field that is not a number is left out');
});

// ---- valuation, worked by hand ----

const INFO: OrderlyInfoRow = {
  symbol: 'PERP_SOL_USDC', broker_id: null, status: 'ACTIVE', base_tick: 0.01, quote_tick: 0.001, base_min: 0.01, min_notional: 10,
  base_imr: 0.01, base_mmr: 0.006, imr_factor: 0.0000010667, funding_period: 8,
};
const FUTURES: OrderlyFuturesRow = {
  symbol: 'PERP_SOL_USDC', status: 'ACTIVE', index_price: 100.1, mark_price: 100, sum_unitary_funding: 10.05, est_funding_rate: 0,
  last_funding_rate: 0, next_funding_time: NOW + 3_600_000, open_interest: 1, '24h_amount': 1,
};
const SHORT: OrderlyStreamPosition = {
  symbol: 'PERP_SOL_USDC', positionQty: -3, costPosition: -303, lastSumUnitaryFunding: 10, averageOpenPrice: 101, estLiqPrice: 130.5, accruedFundingFee: -0.25,
};
const snapshot = (over: Partial<OrderlyAccountSnapshot> = {}): OrderlyAccountSnapshot => ({
  accountId: ACCOUNT, positions: [SHORT], balances: { USDC: { holding: 1000, frozen: 10 } }, invalidBalances: {},
  positionsAt: NOW - 4000, balancesAt: NOW - 9000, positionsFrom: 'push', positionsReceivedAt: NOW - 4000, balancesFrom: 'push', confirmedAt: NOW - 2000, ...over,
});
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

test('account: a 3 SOL short valued by hand at mark 100, funding sum up 0.05 since it was last settled', () => {
  // notional = 3 x 100 = 300 USD. Size term 1.0667e-6 x 300^0.8 = 1.02e-4 < base IMR 0.01, so IMR = 0.01 and
  // MMR = 0.006: margin 3.00 USD, maintenance 1.80 USD.
  // unsettled PnL = qty x mark - cost - qty x (sum - last) = -300 + 303 + 3 x 0.05 = 3.15 USD; equity 1003.15.
  // free = equity - initial - frozen = 1003.15 - 3 - 10 = 990.15. Unsettled funding = -qty x 0.05 = +0.15 (a short receives).
  const state = parseAccount(snapshot(), [FUTURES], [INFO], NOW);
  near(state.equityUsd, 1003.15, 'equity');
  near(state.freeMarginUsd, 990.15, 'free margin');
  near(state.maintenanceMarginUsd, 1.8, 'maintenance');
  const p = state.positions[0]!;
  near(p.marginUsd, 3, 'margin');
  near(p.unrealizedPnlUsd, 3, 'unrealized: -3 x (100 - 101)');
  near(p.unsettledFundingUsd, 0.15, 'unsettled funding');
  assert.deepEqual([p.symbol, p.size, p.entryPx, p.liqPx, p.leverage], ['PERP_SOL_USDC', -3, 101, 130.5, 100]);
  // ASSUMPTION, to verify on day 5 (C5): accruedFundingFee is paid > 0, so -0.25 is read as 0.25 received.
  assert.equal(p.fundingSinceOpenUsd, 0.25);
  assert.equal(state.time, NOW - 2000, 'the time is when the server last confirmed the stream, not now');
  assert.deepEqual([state.positionsPushedAt, state.balancesPushedAt], [NOW - 4000, NOW - 9000]);
  assert.deepEqual(state.fundingUnknown, []);
  // Orderly's estLiqPrice 0 means none.
  assert.equal(parseAccount(snapshot({ positions: [{ ...SHORT, estLiqPrice: 0 }] }), [FUTURES], [INFO], NOW).positions[0]!.liqPx, null);
  // A row from the seed read has no accrued funding fee: named as unknown, not passed off as a real zero.
  const { accruedFundingFee: _fee, ...seeded } = SHORT;
  const fromRead = parseAccount(snapshot({ positions: [seeded], positionsFrom: 'read' }), [FUTURES], [INFO], NOW);
  assert.deepEqual([fromRead.fundingUnknown, fromRead.positions[0]!.fundingSinceOpenUsd], [['PERP_SOL_USDC'], 0]);
  near(fromRead.equityUsd, 1003.15, 'the valuation does not use the funding fee');
});

test('account: nothing missing is read as zero, and stream state the server has not confirmed lately is refused', () => {
  assert.throws(() => parseAccount(snapshot(), [], [INFO], NOW), /no PERP_SOL_USDC row in \/v1\/public\/futures/);
  assert.throws(() => parseAccount(snapshot(), [FUTURES], [], NOW), /no market info for PERP_SOL_USDC/);
  assert.throws(() => parseAccount(snapshot({ balances: {} }), [FUTURES], [INFO], NOW), /pushed no USDC balance/);
  assert.throws(() => parseAccount(snapshot({ balances: {}, invalidBalances: { USDC: 'balance: frozen is missing' } }), [FUTURES], [INFO], NOW), /USDC balance push is unusable: balance: frozen is missing/);
  assert.throws(() => parseAccount(snapshot(), [{ ...FUTURES, mark_price: 0 }], [INFO], NOW), /no usable mark price/);
  assert.throws(() => parseAccount(snapshot({ confirmedAt: NOW - 30_001 }), [FUTURES], [INFO], NOW), /stale: the private stream last heard from the server 30001 ms ago \(limit 30000 ms\)/);
  parseAccount(snapshot({ confirmedAt: NOW - 30_000 }), [FUTURES], [INFO], NOW);
});

test('reader account(): the stream state priced at the recorded REST mark, refused when stale or for another account', async () => {
  const lines = readWireRecording(join(fileURLToPath(new URL('../../fixtures/orderly-wire/', import.meta.url)), 'orderly-mainnet-2026-10-31.jsonl.gz'));
  const at = lines[0]!.t;
  const clock = new VirtualClock(at);
  let confirmedAt = at - 1000;
  const accountStream = { accountId: ACCOUNT, state: async () => snapshot({ confirmedAt }) };
  const reader = new OrderlyReader({ fetch: replayFetch(lines), wsRequest: replayWsRequester(lines), accountStream, clock });
  const state = await reader.account(ACCOUNT.toUpperCase().replace('0X', '0x'));
  assert.equal(state.address, ACCOUNT);
  assert.equal(state.time, at - 1000);
  // The recorded SOL mark is 96.134: a 3 SOL short opened at 101 is 3 x (101 - 96.134) = 14.598 USD up.
  near(state.positions[0]!.unrealizedPnlUsd, 14.598, 'unrealized at the recorded mark');
  confirmedAt = at - 31_000;
  await assert.rejects(reader.account(ACCOUNT), /stale/);
  await assert.rejects(reader.account(`0x${'11'.repeat(32)}`), /the stream is for/);
});
