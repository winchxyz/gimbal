// The desk's private Orderly stream against a fake socket: one ws auth signature per session, the auth frame
// Orderly expects, the three subscriptions, ping answered with pong, and state() waiting for the first pushes.
// No live private call is made anywhere in the suite.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { OrderlyFuturesRow, OrderlyInfoRow } from './orderly.ts';
import { OrderlyReader } from './orderly.ts';
import type { OrderlyRestAction } from './orderly-signer.ts';
import { OrderlyAccountStream, ORDERLY_PRIVATE_TOPICS } from './orderly-stream.ts';
import { positionImr, positionMmr, unsettledFundingUsd, unsettledPnlUsd } from './orderly-units.ts';
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

function setup(timeoutMs = 200) {
  const sockets: FakeSocket[] = [];
  const signed: number[] = [];
  const reports: Record<string, unknown>[] = [];
  const signer = {
    async orderlyWsAuth(deskId: string, timestamp: number): Promise<OrderlyRestAction> {
      signed.push(timestamp);
      return { desk_id: deskId, request_id: signed.length, venue: 'orderly', kind: 'ws_auth', payload: { method: 'GET', path: '', body: '', timestamp, message: String(timestamp) }, signature: { scheme: 'Ed25519', signature: SIG } };
    },
  };
  const stream = new OrderlyAccountStream({
    deskId: 'alpha', accountId: ACCOUNT, orderlyKey: KEY, signer, clock: new VirtualClock(NOW), timeoutMs,
    webSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); queueMicrotask(() => s.open()); return s; },
    onExecutionReport: (r) => reports.push(r),
  });
  return { stream, sockets, signed, reports };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(check(), 'condition never held');
}

function login(s: FakeSocket): void {
  s.push({ id: 'auth', event: 'auth', success: true, ts: NOW });
}

const positionPush = (positions: unknown[], ts = NOW + 5) => ({ topic: 'position', ts, data: { positions } });
const balancePush = (holding: number, frozen = 0, ts = NOW + 6) => ({ topic: 'balance', ts, data: { balances: { USDC: { holding, frozen } } } });

test('one ws auth signature opens the session: auth frame, then the three topics', async () => {
  const { stream, sockets, signed } = setup();
  const started = stream.start();
  await until(() => sockets[0]?.sent.length === 1);
  const s = sockets[0]!;
  assert.equal(s.url, `wss://ws-private-evm.orderly.org/v2/ws/private/stream/${ACCOUNT}`);
  assert.deepEqual(s.sent[0], { id: 'auth', event: 'auth', params: { orderly_key: KEY, sign: Buffer.from(SIG).toString('base64url'), timestamp: NOW } });
  login(s);
  await started;
  assert.deepEqual(s.sent.slice(1), ORDERLY_PRIVATE_TOPICS.map((topic) => ({ id: `sub-${topic}`, event: 'subscribe', topic })));
  // Reads and repeated starts reuse the session: still one signature.
  await stream.start();
  s.push(positionPush([]));
  s.push(balancePush(100));
  await stream.state();
  await stream.state();
  assert.deepEqual(signed, [NOW]);
  assert.equal(stream.signatures, 1);
  stream.close();
});

test('ping is answered with pong carrying the same ts, before and after login', async () => {
  const { stream, sockets } = setup();
  const started = stream.start();
  await until(() => sockets[0]?.sent.length === 1);
  const s = sockets[0]!;
  s.push({ event: 'ping', ts: 111 });
  login(s);
  await started;
  s.push({ event: 'ping', ts: 222 });
  assert.deepEqual(s.sent.filter((f) => f.event === 'pong'), [{ event: 'pong', ts: 111 }, { event: 'pong', ts: 222 }]);
  stream.close();
});

test('state() waits for both first pushes; positions replace, balances merge, reports go to the callback', async () => {
  const { stream, sockets, reports } = setup();
  const started = stream.start();
  await until(() => sockets[0]?.sent.length === 1);
  const s = sockets[0]!;
  login(s);
  await started;
  let done = false;
  const first = stream.state().then((x) => { done = true; return x; });
  s.push(positionPush([{ symbol: 'PERP_SOL_USDC', positionQty: 2, costPosition: 190, lastSumUnitaryFunding: 1.5, averageOpenPrice: 95, markPrice: 96, estLiqPrice: 0, accruedFundingFee: '0.4' }]));
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, 'no balance push yet');
  s.push(balancePush(500, 20));
  const snap = await first;
  assert.deepEqual(snap, {
    accountId: ACCOUNT,
    positions: [{ symbol: 'PERP_SOL_USDC', positionQty: 2, costPosition: 190, lastSumUnitaryFunding: 1.5, averageOpenPrice: 95, markPrice: 96, estLiqPrice: 0 }],
    balances: { USDC: { holding: 500, frozen: 20 } },
    positionsAt: NOW + 5,
    balancesAt: NOW + 6,
  });
  s.push(positionPush([{ symbol: 'PERP_ETH_USDC', positionQty: -1, costPosition: -3000, lastSumUnitaryFunding: 0, averageOpenPrice: 3000 }], NOW + 9));
  s.push({ topic: 'balance', ts: NOW + 10, data: { balances: { USDT: { holding: '7', frozen: 0 } } } });
  s.push({ topic: 'executionreport', ts: NOW + 11, data: { orderId: 42, status: 'FILLED' } });
  const next = await stream.state();
  assert.deepEqual(next.positions.map((p) => p.symbol), ['PERP_ETH_USDC'], 'each position push is the whole list');
  assert.deepEqual(next.balances, { USDC: { holding: 500, frozen: 20 }, USDT: { holding: 7, frozen: 0 } });
  assert.deepEqual(reports, [{ orderId: 42, status: 'FILLED' }]);
  stream.close();
});

test('a refused login fails start(); the next start signs again on a new socket', async () => {
  const { stream, sockets, signed } = setup();
  const started = stream.start();
  await until(() => sockets[0]?.sent.length === 1);
  sockets[0]!.push({ id: 'auth', event: 'auth', success: false, errorMsg: 'orderly key error' });
  await assert.rejects(started, /login refused: orderly key error/);
  assert.equal(sockets[0]!.closedWith, 1000);
  const again = stream.start();
  await until(() => sockets[1]?.sent.length === 1);
  login(sockets[1]!);
  await again;
  assert.equal(signed.length, 2);
  stream.close();
});

test('timeouts: no auth answer, then no pushes after login', async () => {
  const quiet = setup(30);
  await assert.rejects(quiet.stream.start(), /no auth answer within 30 ms/);

  const { stream, sockets } = setup(30);
  const started = stream.start();
  await until(() => sockets[0]?.sent.length === 1);
  login(sockets[0]!);
  await started;
  sockets[0]!.push(balancePush(1));
  await assert.rejects(stream.state(), /no position push within 30 ms/);
  stream.close();
});

test('a dropped socket fails waiting reads; close() before login fails the start', async () => {
  const { stream, sockets } = setup();
  const started = stream.start();
  await until(() => sockets[0]?.sent.length === 1);
  login(sockets[0]!);
  await started;
  const waiting = stream.state();
  await new Promise((r) => setImmediate(r));
  sockets[0]!.drop(1006, 'gone');
  await assert.rejects(waiting, /closed \(1006 gone\)/);
  // A dead session stays dead for reads: no new socket and no new signature until start() is called.
  const dropped = stream.state();
  sockets.length = 0;
  await assert.rejects(dropped, /closed \(1006 gone\)/);
  assert.equal(sockets.length, 0);
  assert.equal(stream.signatures, 1);
  // A drop between start() and the read is caught too.
  const again = stream.start();
  await until(() => sockets[0]?.sent.length === 1);
  login(sockets[0]!);
  await again;
  const racing = stream.state();
  sockets[0]!.drop(1001, 'away');
  await assert.rejects(racing, /closed \(1001 away\)/);

  const early = setup();
  const pending = early.stream.start();
  await until(() => early.sockets[0]?.sent.length === 1);
  early.stream.close();
  await assert.rejects(pending, /orderly private stream: closed/);
});

test('the stream refuses a key that is not ed25519:<base58>', () => {
  const signer = { orderlyWsAuth: async () => { throw new Error('never'); } };
  assert.throws(() => new OrderlyAccountStream({ deskId: 'alpha', accountId: ACCOUNT, orderlyKey: 'ed25519:0O', signer }), /ed25519:<base58>/);
});

test('reader account(): stream state valued at the recorded SOL mark, sum unitary funding and IMR/MMR', async () => {
  const lines = readWireRecording(join(fileURLToPath(new URL('../../fixtures/orderly-wire/', import.meta.url)), 'orderly-mainnet-2026-10-31.jsonl.gz'));
  const futures = (lines.find((l) => l.url.includes('/v1/public/futures'))!.response as { data: { rows: OrderlyFuturesRow[] } }).data.rows;
  const info = (lines.find((l) => l.url.endsWith('/v1/public/info'))!.response as { data: { rows: OrderlyInfoRow[] } }).data.rows;
  const sol = futures.find((f) => f.symbol === 'PERP_SOL_USDC')!;
  const solInfo = info.find((r) => r.symbol === 'PERP_SOL_USDC')!;
  const position = { symbol: 'PERP_SOL_USDC', positionQty: -3, costPosition: -300, lastSumUnitaryFunding: sol.sum_unitary_funding - 0.05, averageOpenPrice: 100, estLiqPrice: 130.5, accruedFundingFee: -0.25 };
  const accountStream = { accountId: ACCOUNT, state: async () => ({ accountId: ACCOUNT, positions: [position], balances: { USDC: { holding: 1000, frozen: 10 } }, positionsAt: NOW, balancesAt: NOW }) };
  const reader = new OrderlyReader({ fetch: replayFetch(lines), wsRequest: replayWsRequester(lines), accountStream, clock: new VirtualClock(lines[0]!.t) });

  const state = await reader.account(ACCOUNT.toUpperCase().replace('0X', '0x'));
  const notional = 3 * sol.mark_price;                                              // USD
  const imr = positionImr(notional, solInfo.base_imr, solInfo.imr_factor);          // fraction of notional
  const mmr = positionMmr(notional, solInfo.base_mmr, solInfo.base_imr, solInfo.imr_factor);
  const equity = 1000 + unsettledPnlUsd(-3, sol.mark_price, -300, sol.sum_unitary_funding, position.lastSumUnitaryFunding);
  assert.equal(state.venue, 'orderly');
  assert.equal(state.address, ACCOUNT);
  assert.equal(state.equityUsd, equity);
  assert.equal(state.freeMarginUsd, equity - notional * imr - 10);
  assert.equal(state.maintenanceMarginUsd, notional * mmr);
  assert.equal(state.positions.length, 1);
  const p = state.positions[0]!;
  assert.deepEqual([p.symbol, p.size, p.entryPx, p.liqPx, p.leverage], ['PERP_SOL_USDC', -3, 100, 130.5, 1 / imr]);
  assert.equal(p.marginUsd, notional * imr);
  assert.equal(p.unrealizedPnlUsd, -3 * (sol.mark_price - 100));
  assert.equal(p.unsettledFundingUsd, unsettledFundingUsd(-3, sol.sum_unitary_funding, position.lastSumUnitaryFunding));
  assert.equal(p.fundingSinceOpenUsd, 0.25, 'accruedFundingFee read as paid > 0 (to verify on C5)');
  await assert.rejects(reader.account(`0x${'11'.repeat(32)}`), /the stream is for/);
});
