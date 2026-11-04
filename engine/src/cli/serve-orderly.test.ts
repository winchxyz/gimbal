// serve's Orderly session (GIMBAL_ORDERLY_PAIRS): off by default and then nothing is built or signed, with serve's old
// risk line; on, the kept session feeds the risk source (AccountsDeskSource) and the account is unknown, never flat,
// before the first open, when the server has gone quiet (stale) and while the session is down; the keeper reopens at a
// bounded pace, so a dropping session does not spam orderly_ws_auth signatures, and logs once per state change.
// Fake socket, fake signer, fake REST: no network, no key.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeskView } from '../contract/types.ts';
import { AccountsDeskSource } from '../risk/sources.ts';
import type { OrderlyRequest, OrderlyRestAction, OrderlySigner } from '../venues/orderly-signer.ts';
import { orderlyRestMessage } from '../venues/orderly-signer.ts';
import type { OrderlyAccountSnapshot } from '../venues/orderly-stream.ts';
import { VirtualClock } from '../venues/replay.ts';
import type { WebSocketLike, WsEvent } from '../venues/ws.ts';
import type { KeptStream } from './serve-orderly.ts';
import { ORDERLY_PAIRS_ENV, OrderlySessionKeeper, SESSION_TIMING, orderlyPairsOn, riskOrderlyNote, serveOrderly } from './serve-orderly.ts';
import { ConfigError } from './start-errors.ts';

const NOW = Date.UTC(2026, 10, 4, 1);
const ACCOUNT = `0x${'5e'.repeat(32)}`;
const AUTHORITY = '2'.repeat(44);
const SIG = Array.from({ length: 64 }, (_, i) => (i * 7 + 1) % 256);
const DESK = {
  owner: 'owner.near', operator: 'op.near', paused: false, policy: {} as DeskView['policy'], evm_address: `0x${'ab'.repeat(20)}`,
  solana: { authority: AUTHORITY, usdc_ata: '', phusd_ata: '', phoenix_trader: '' }, orderly_receiver: null, orderly_account_id: ACCOUNT,
  ledger: { deposited: 0, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 0 },
} satisfies DeskView;

const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

// ---- flag off ----

test('flag off: no session is built, nothing signs, and the risk line is the one serve printed before', () => {
  let asked = 0;
  const signer = async (): Promise<OrderlySigner> => {
    asked++;
    throw new Error('must not be asked');
  };
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
    const env = envOf(value === undefined ? {} : { [ORDERLY_PAIRS_ENV]: value });
    assert.equal(orderlyPairsOn(env), false, `${JSON.stringify(value)} is not on`);
    assert.equal(serveOrderly({ mode: 'mainnet', env, deskId: 'carry', desk: DESK, log: () => assert.fail('logged'), signer }), null);
  }
  assert.equal(asked, 0);
  assert.equal(riskOrderlyNote(null), '(Orderly legs need its private stream, which serve does not open)');
});

test('flag on: replay builds nothing; a desk without an Orderly account or a missing operator key stops the start', () => {
  const on = envOf({ [ORDERLY_PAIRS_ENV]: '1' });
  assert.equal(serveOrderly({ mode: 'replay', env: on, deskId: 'carry', desk: DESK, log: () => {} }), null);
  const noAccount: DeskView = { ...DESK };
  delete noAccount.orderly_account_id;
  assert.throws(() => serveOrderly({ mode: 'mainnet', env: on, deskId: 'carry', desk: noAccount, log: () => {}, signer: async () => assert.fail() }), ConfigError);
  // The operator key is checked by name at start (its value is never read here).
  const noKey = envOf({ [ORDERLY_PAIRS_ENV]: '1', GIMBAL_CONTRACT_ID: 'gimbal.near', DESK_ID: 'carry', OPERATOR_ACCOUNT_ID: 'op.near' });
  assert.throws(() => serveOrderly({ mode: 'mainnet', env: noKey, deskId: 'carry', desk: DESK, log: () => {} }), /OPERATOR_PRIVATE_KEY/);
});

// ---- flag on: the real stream against fakes ----

type Listener = (ev: WsEvent) => void;

/** Answers the login and the subscriptions as Orderly does. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly #listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] };
  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.#emit('open', {});
    });
  }
  send(data: string): void {
    const frame = JSON.parse(data) as { id?: string; event?: string };
    if (frame.event === 'auth') queueMicrotask(() => this.push({ id: frame.id, event: 'auth', success: true, ts: NOW }));
    if (frame.event === 'subscribe') queueMicrotask(() => this.push({ id: frame.id, event: 'subscribe', success: true }));
  }
  close(code?: number): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    queueMicrotask(() => this.#emit('close', { code: code ?? 1005 }));
  }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    this.#listeners[type]!.push(listener);
  }
  push(msg: Record<string, unknown>): void {
    this.#emit('message', { data: JSON.stringify(msg) });
  }
  drop(): void {
    this.readyState = 3;
    this.#emit('close', { code: 1006, reason: 'gone' });
  }
  #emit(type: string, ev: WsEvent): void {
    for (const l of this.#listeners[type]!) l(ev);
  }
}

const PATHS: Record<string, string> = { positions: '/v1/positions', holding: '/v1/client/holding' };
const REST: Record<string, unknown> = {
  '/v1/positions': { rows: [{ symbol: 'PERP_SOL_USDC', position_qty: -3, cost_position: -303, last_sum_unitary_funding: 10, average_open_price: 101, est_liq_price: 130.5 }] },
  '/v1/client/holding': { holding: [{ token: 'USDC', holding: 1000, frozen: 10 }] },
  '/v1/public/info': {
    rows: [{ symbol: 'PERP_SOL_USDC', broker_id: null, status: 'ACTIVE', base_tick: 0.01, quote_tick: 0.001, base_min: 0.01, min_notional: 10, base_imr: 0.01, base_mmr: 0.006, imr_factor: 0.0000010667, funding_period: 8 }],
  },
  '/v1/public/futures': {
    rows: [{ symbol: 'PERP_SOL_USDC', status: 'ACTIVE', index_price: 100.1, mark_price: 100, sum_unitary_funding: 10.05, est_funding_rate: 0, last_funding_rate: 0, next_funding_time: NOW + 3_600_000, open_interest: 1, '24h_amount': 1 }],
  },
};

function harness() {
  const clock = new VirtualClock(NOW);
  const sockets: FakeSocket[] = [];
  const signed: string[] = [];
  const logs: string[] = [];
  const action = (kind: string, method: string, path: string, timestamp: number): OrderlyRestAction => ({
    desk_id: 'carry', request_id: signed.length, venue: 'orderly', kind,
    payload: { method, path, body: '', timestamp, message: kind === 'ws_auth' ? String(timestamp) : orderlyRestMessage(timestamp, method, path, '') },
    signature: { scheme: 'Ed25519', signature: SIG },
  });
  const contract = {
    async orderlyWsAuth(_desk: string, timestamp: number) {
      signed.push('ws_auth');
      return action('ws_auth', '', '', timestamp);
    },
    async orderlyRequest(_desk: string, req: OrderlyRequest) {
      signed.push(req.kind);
      return action(req.kind, 'GET', PATHS[req.kind]!, req.timestamp_ms);
    },
  } as unknown as OrderlySigner;
  const fetchFake = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    const data = REST[path];
    if (data === undefined) return new Response('{"success":false,"message":"unknown"}', { status: 404 });
    return new Response(JSON.stringify({ success: true, data }), { status: 200 });
  }) as typeof fetch;
  const orderly = serveOrderly({
    mode: 'mainnet', env: envOf({ [ORDERLY_PAIRS_ENV]: '1' }), deskId: 'carry', desk: DESK, clock,
    log: (l) => logs.push(l), signer: async () => contract, fetch: fetchFake,
    webSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    streamTiming: { timeoutMs: 1_000, silenceMs: 60_000, seedTimeoutMs: 2_000 },
  })!;
  const source = new AccountsDeskSource({ deskId: 'carry', owner: 'owner.near', contract: 'gimbal.near', accounts: [orderly.riskAccount], readDeadlineMs: 2_000 });
  return { clock, sockets, signed, logs, orderly, source };
}

async function settle(h: ReturnType<typeof harness>): Promise<void> {
  for (let i = 0; i < 100 && h.orderly.keeper.busy !== null; i++) await h.orderly.keeper.busy;
}

test('flag on: one ws_auth and the two seed reads open the session, and the risk source reads the Orderly leg from it', async () => {
  const h = harness();
  try {
    // Before the keeper opened a session the account is unknown, and the read does not open (or sign) one itself.
    const before = await h.source.read();
    assert.equal(before.legs.length, 0);
    assert.match(before.reads[0]!.error ?? '', /orderly account unknown: the private session is idle/);
    assert.deepEqual(h.signed, []);

    h.orderly.keeper.check();
    await settle(h);
    assert.equal(h.orderly.status().state, 'live');
    assert.deepEqual([...h.signed].sort(), ['holding', 'positions', 'ws_auth']);
    assert.deepEqual({ wsAuth: h.orderly.status().wsAuth, reads: h.orderly.status().reads }, { wsAuth: 1, reads: 2 });

    const snap = await h.source.read();
    assert.deepEqual(snap.reads.map((r) => [r.venue, r.error]), [['orderly', null]]);
    assert.equal(snap.legs.length, 1);
    const leg = snap.legs[0]!;
    assert.equal(leg.venue, 'orderly');
    assert.equal(leg.position.symbol, 'PERP_SOL_USDC');
    assert.equal(leg.position.size, -3);
    assert.equal(leg.position.liqPx, 130.5);
    // equity = holding + price PnL + unsettled funding: 1000 + (-3 × 100 − (−303)) − (−3 × (10.05 − 10)) = 1003.15.
    assert.ok(Math.abs(leg.account.equityUsd - 1003.15) < 1e-9, `equity ${leg.account.equityUsd}`);
    assert.ok(leg.account.freeMarginUsd > 0 && leg.account.freeMarginUsd < leg.account.equityUsd);
    // The loop's free margin (serve pushes the same reader into its accounts) reads the same account.
    assert.equal((await h.orderly.reader.account(h.orderly.accountId)).freeMarginUsd, leg.account.freeMarginUsd);

    // Checks while live sign nothing more and log nothing more.
    const logged = h.logs.length;
    for (let i = 0; i < 20; i++) h.orderly.keeper.check();
    await settle(h);
    assert.equal(h.signed.length, 3);
    assert.equal(h.logs.length, logged);
  } finally {
    h.orderly.stop();
  }
});

test('flag on: a server quiet for over 30 s makes the account stale, read as unknown (no legs), never flat', async () => {
  const h = harness();
  try {
    h.orderly.keeper.check();
    await settle(h);
    assert.equal((await h.source.read()).legs.length, 1);
    h.clock.set(NOW + 31_000);
    const snap = await h.source.read();
    assert.equal(snap.legs.length, 0);
    assert.match(snap.reads[0]!.error ?? '', /stale/);
  } finally {
    h.orderly.stop();
  }
});

test('flag on: a dropped session is unknown at once, logged once, and reopened only after the backoff', async () => {
  const h = harness();
  try {
    h.orderly.keeper.check();
    await settle(h);
    h.sockets[0]!.drop();
    await settle(h);
    const logged = h.logs.length;
    for (let i = 0; i < 5; i++) h.orderly.keeper.check();
    assert.equal(h.orderly.status().state, 'down');
    assert.equal(h.logs.length, logged + 1, 'one line for the drop');
    assert.match(h.logs.at(-1)!, /down, the Orderly account is unknown: .*closed.*trying again in 60 s/);
    const snap = await h.source.read();
    assert.equal(snap.legs.length, 0);
    assert.match(snap.reads[0]!.error ?? '', /unknown|closed/);
    assert.equal(h.signed.filter((s) => s === 'ws_auth').length, 1);

    h.clock.set(NOW + 59_000);
    h.orderly.keeper.check();
    assert.equal(h.signed.filter((s) => s === 'ws_auth').length, 1, 'no new session inside the backoff');
    h.clock.set(NOW + 60_000);
    h.orderly.keeper.check();
    await settle(h);
    assert.equal(h.orderly.status().state, 'live');
    assert.equal(h.signed.filter((s) => s === 'ws_auth').length, 2);
    assert.equal(h.sockets.length, 2);
    assert.equal((await h.source.read()).legs.length, 1);
  } finally {
    h.orderly.stop();
  }
  assert.match(h.logs.at(-1)!, /orderly session: closed \(2 ws_auth and 4 seed reads signed this run\)/);
});

// ---- the keeper's pace, on a fake stream ----

class FakeStream implements KeptStream {
  down: Error | null = null;
  signatures = 0;
  reseeds = 0;
  failStart: Error | null = null;
  failState: Error | null = null;
  async start(): Promise<void> {
    this.signatures++;
    this.down = null;
    if (this.failStart !== null) {
      this.down = this.failStart;
      throw this.failStart;
    }
  }
  async state(): Promise<OrderlyAccountSnapshot> {
    if (this.down !== null) throw this.down;
    if (this.failState !== null) throw this.failState;
    return {} as OrderlyAccountSnapshot;
  }
  async reseed(): Promise<void> {
    this.reseeds++;
  }
  close(): void {
    this.down = new Error('closed');
  }
}

function keeperHarness() {
  const clock = new VirtualClock(NOW);
  const stream = new FakeStream();
  const logs: string[] = [];
  const keeper = new OrderlySessionKeeper({ stream, clock, log: (l) => logs.push(l) });
  /** Checks every 5 s (as serve's timer does) from now to `ms` later. */
  const run = async (ms: number) => {
    const end = clock.now() + ms;
    while (clock.now() < end) {
      clock.set(clock.now() + SESSION_TIMING.checkMs);
      keeper.check();
      if (keeper.busy !== null) await keeper.busy;
    }
  };
  return { clock, stream, logs, keeper, run };
}

test('keeper: failed opens back off from 60 s doubling to 15 min, so a dead venue costs a handful of signatures an hour', async () => {
  const k = keeperHarness();
  k.stream.failStart = new Error('login refused');
  k.keeper.check();
  await k.keeper.busy;
  assert.equal(k.stream.signatures, 1);
  assert.equal(k.keeper.status().state, 'down');
  await k.run(60 * 60_000);
  // Opens at 0, 1, 3, 7, 15, 30, 45 and 60 min over 720 checks, then 4 an hour.
  assert.equal(k.stream.signatures, 8);
  // Two lines per attempt (opening, then down), none for the checks between.
  assert.equal(k.logs.length, 16);
  await k.run(60 * 60_000);
  assert.equal(k.stream.signatures, 12);
});

test('keeper: a session that held 10 min is reopened at once; one that keeps dropping early backs off', async () => {
  const k = keeperHarness();
  k.keeper.check();
  await k.keeper.busy;
  await k.run(11 * 60_000);
  assert.equal(k.stream.signatures, 1);
  k.stream.down = new Error('network');
  await k.run(SESSION_TIMING.checkMs);
  assert.equal(k.stream.signatures, 2, 'reopened on the check that saw the drop');
  assert.equal(k.keeper.status().state, 'live');
  // Now it drops right after each open: the next open waits 60 s, then 120, 240, 480, then 900 at most (each gap
  // also holds the 5 s until the check that sees the drop).
  const opens: number[] = [];
  for (let i = 0; i < 40 * 12; i++) {
    if (k.keeper.status().state === 'live') k.stream.down = new Error('network');
    const before = k.stream.signatures;
    await k.run(SESSION_TIMING.checkMs);
    if (k.stream.signatures > before) opens.push(k.clock.now());
  }
  const gaps = opens.slice(1).map((t, i) => (t - opens[i]!) / 1000);
  assert.deepEqual(gaps.slice(0, 4), [125, 245, 485, 905]);
  assert.ok(opens.length <= 7, `${opens.length} opens in 40 min`);
});

test('keeper: a failed seed keeps the session, leaves the account unknown and reads again after the backoff', async () => {
  const k = keeperHarness();
  k.stream.failState = new Error('orderly private stream: the holding read that seeds the session failed: 500');
  k.keeper.check();
  await k.keeper.busy;
  assert.equal(k.keeper.status().state, 'unseeded');
  await assert.rejects(k.keeper.state(), /holding read/);
  await k.run(55_000);
  assert.equal(k.stream.reseeds, 0);
  k.stream.failState = null;
  await k.run(5_000);
  assert.equal(k.stream.reseeds, 1);
  assert.equal(k.keeper.status().state, 'live');
  assert.equal(k.stream.signatures, 1, 'the reseed signs no new ws_auth');
});

test('keeper: stopped, it signs nothing and the account is unknown', async () => {
  const k = keeperHarness();
  k.keeper.stop();
  k.keeper.check();
  assert.equal(k.stream.signatures, 0);
  await assert.rejects(k.keeper.state(), /orderly account unknown: the private session is stopped/);
});
