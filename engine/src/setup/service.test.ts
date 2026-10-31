// POST /setup end to end inside the engine: the server route, the service, the replay contract signing with the
// public test keys, and Hyperliquid and Orderly answering from stubs shaped like their testnet answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { SetupProgress } from '@gimbal/shared';
import { ReplayContractClient } from '../contract/replay-client.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from '../scanner/config.ts';
import { Scanner } from '../scanner/scanner.ts';
import { EngineServer } from '../server.ts';
import { VirtualClock } from '../venues/replay.ts';
import { stubFetch, TEST_CONFIG, TEST_EVM_KEY, TEST_SOL_SEED, testDesk } from '../relayer/test-helpers.ts';
import type { StubCall } from '../relayer/test-helpers.ts';
import { setupRoute } from './route.ts';
import { SetupService } from './service.ts';

const NOW = Date.UTC(2026, 9, 31, 12);
const ACCOUNT = `0x${'5e'.repeat(32)}`;
const RECEIVER = '0x9F8e7d6C5b4A39281706F5e4D3c2B1a098765432';
const HL = 'https://api.hyperliquid-testnet.xyz';
const ORDERLY = 'https://testnet-api.orderly.org';

/** Hyperliquid and Orderly as a fresh desk meets them; `funded` flips when the first deposit lands. */
function venues() {
  const state = { funded: false, approved: 0, registered: false, key: false };
  const ok = (data: unknown) => ({ success: true, data, timestamp: NOW });
  const api = stubFetch((call: StubCall) => {
    const url = new URL(call.url);
    if (call.url.startsWith(HL)) {
      const body = call.json as { type?: string; action?: { type?: string } };
      if (url.pathname === '/info') {
        if (body.type === 'userRole') return { role: state.funded ? 'user' : 'missing' };
        if (body.type === 'referral') return { referredBy: null, cumVlm: '0.0' };
        if (body.type === 'maxBuilderFee') return state.approved;
      }
      if (url.pathname === '/exchange' && body.action?.type === 'approveBuilderFee') {
        if (!state.funded) return { status: 'err', response: 'User or API Wallet 0x1a642f0e3c3af545e7acbd38b07251b3990914f1 does not exist.' };
        state.approved = 10;
        return { status: 'ok', response: { type: 'default' } };
      }
    }
    if (call.url.startsWith(ORDERLY)) {
      switch (url.pathname) {
        case '/v1/get_account': return state.registered ? ok({ account_id: ACCOUNT }) : { success: false, code: -1607, message: 'Account not found.' };
        case '/v1/registration_nonce': return ok({ registration_nonce: '194528949540' });
        case '/v1/register_account': state.registered = true; return ok({ account_id: ACCOUNT });
        case '/v1/get_orderly_key': return state.key
          ? ok({ orderly_key: url.searchParams.get('orderly_key'), scope: 'read,trading', expiration: NOW + 364 * 86_400_000, key_status: 'ACTIVE' })
          : { success: false, code: -1617, message: 'orderlyKey is not exist' };
        case '/v1/orderly_key': state.key = true; return ok({ id: 1, orderly_key: (JSON.parse(call.body!) as { message: { orderlyKey: string } }).message.orderlyKey });
        case '/v1/client/asset/receiver_address': return ok({ chain_id: 421614, token: 'USDC', receiver_address: RECEIVER });
      }
    }
    return new Response(`no stub for ${call.method} ${call.url}`, { status: 404 });
  });
  return { state, api };
}

function contract() {
  return new ReplayContractClient({
    config: TEST_CONFIG,
    desks: { fresh: testDesk({ orderly_account_id: ACCOUNT }), other: testDesk({ owner: 'someone.testnet', operator: null }) },
    prices: [],
    keys: { fresh: { evm: TEST_EVM_KEY, sol: TEST_SOL_SEED } },
    now: () => NOW,
  });
}

function service(c: ReplayContractClient, f: typeof fetch, sleep: (ms: number) => Promise<void>) {
  return new SetupService({
    network: 'testnet', contract: c, operatorAccount: 'owner.testnet',
    config: { network: 'testnet', treasury: { hl_builder: TEST_CONFIG.hlBuilder, referral_codes: { hyperliquid: null, orderly: null, phoenix: null } },
      fees: { hl_builder_tenth_bps: 10 }, orderly: { broker_id: 'woofi_dex', chain_id: 421614 } },
    hlUrl: HL, orderlyUrl: ORDERLY, fetch: f, depositPollMs: 1_000, depositWaitMs: 60_000, sleep, now: () => NOW,
  });
}

async function post(base: string, path: string, body: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('POST /setup on a fresh testnet desk: Orderly set up, the builder fee after the first deposit, every step as a setup event', async () => {
  const v = venues();
  const c = contract();
  // Setup waits for the deposit until the test lets it land.
  let land!: () => void;
  const landed = new Promise<void>((resolve) => (land = resolve));
  const svc = service(c, v.api.fetch, async () => {
    await landed;
    v.state.funded = true;
  });
  const scanner = new Scanner([], [], { config: DEFAULT_SCANNER_CONFIG, clock: new VirtualClock(NOW), strategy: () => DEFAULT_STRATEGY });
  const server = new EngineServer({ mode: 'testnet', scanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, setup: svc });
  const port = await server.start(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.deepEqual(await post(base, '/setup', '{"deskId":"fresh"}'), { status: 200, json: { ok: true } });
    assert.deepEqual(await post(base, '/setup', '{"deskId":"fresh"}'), { status: 200, json: { ok: false, reason: 'setup of fresh is already running' } });
    land();
    const final = (await svc.running('fresh'))!;
    const latest = server.state().setup as SetupProgress;
    assert.deepEqual(latest, final);
    const by = Object.fromEntries(final.steps.map((s) => [s.step, s]));
    assert.equal(by.orderly_register!.status, 'done');
    assert.equal(by.orderly_add_key!.status, 'done');
    assert.equal(by.orderly_receiver_lookup!.detail, RECEIVER.toLowerCase());
    assert.equal(by.hl_set_referrer!.status, 'skipped');
    assert.equal(by.hl_approve_builder_fee!.status, 'done');
    assert.equal(by.phoenix_register!.detail, 'Phoenix runs on mainnet only');
    // Nothing was signed for Hyperliquid before it knew the address; one approval after the deposit.
    const approvals = v.api.calls.filter((call) => call.url === `${HL}/exchange`);
    assert.equal(approvals.length, 1);
    assert.deepEqual(c.calls.map((x) => x.method), ['orderly_register', 'orderly_add_key', 'orderly_request', 'hl_approve_builder_fee']);

    // A rerun reads every venue and signs nothing.
    const signed = c.calls.length;
    assert.deepEqual(await post(base, '/setup', '{"deskId":"fresh"}'), { status: 200, json: { ok: true } });
    await svc.running('fresh');
    assert.equal(c.calls.length, signed + 1, 'only the receiver lookup, a signed read, runs again');
    assert.equal(c.calls.at(-1)!.method, 'orderly_request');
  } finally {
    await server.stop();
  }
});

test('POST /setup refuses to start for an unknown desk or one the operator key does not act for', async () => {
  const v = venues();
  const svc = service(contract(), v.api.fetch, async () => {});
  const publish = () => {};
  const read = (body: string) => () => Promise.resolve(body);
  assert.deepEqual(await setupRoute(read('{"deskId":"nope"}'), svc, publish), { status: 200, body: { ok: false, reason: 'the contract has no desk nope' } });
  const other = await setupRoute(read('{"deskId":"other"}'), svc, publish);
  assert.equal(other.status, 200);
  assert.match((other.body as { reason: string }).reason, /belongs to someone\.testnet/);
  assert.equal(v.api.calls.length, 0);
});

test('POST /setup: a malformed body is 400 { error }; setup off is 200 { ok: false }', async () => {
  const read = (body: string) => () => Promise.resolve(body);
  for (const body of ['nope', '[]', '{}', '{"deskId":""}', '{"deskId":"a/b"}', '{"deskId":"x","extra":1}']) {
    const a = await setupRoute(read(body), null, () => {});
    assert.equal(a.status, 400, body);
    assert.equal(typeof (a.body as { error?: unknown }).error, 'string');
  }
  assert.deepEqual(await setupRoute(read('{"deskId":"fresh"}'), null, () => {}), {
    status: 200, body: { ok: false, reason: 'venue setup is off: the engine runs without the operator key (GIMBAL_SETUP=1)' },
  });
});
