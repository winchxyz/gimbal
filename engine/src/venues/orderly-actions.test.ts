// The Orderly writes and signed reads against a fake signer (what the contract would return) and a fake venue.
// Nothing here signs or reaches the network: the point is the order of the steps and what goes on the wire.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OutcomeUnknown } from '../contract/types.ts';
import { OrderlyApiError } from './orderly-http.ts';
import { OrderlyDeskClient } from './orderly-actions.ts';
import type { OrderlyFundingFeeRow } from './orderly-actions.ts';
import { OrderlyReader, morePages, parseFundingFeeRow } from './orderly.ts';
import type {
  OrderlyEip712Action, OrderlyRequest, OrderlyRestAction, OrderlySigner, Secp256k1Signature,
} from './orderly-signer.ts';
import { orderlyRestMessage } from './orderly-signer.ts';
import { VirtualClock } from './replay.ts';

const NOW = Date.UTC(2026, 9, 31, 2);
const ACCOUNT = `0x${'5e'.repeat(32)}`;
const EVM = `0x${'d3'.repeat(20)}`;
const KEY = `ed25519:${'2'.repeat(44)}`;
const SIG = Array.from({ length: 64 }, (_, i) => i);
const SECP: Secp256k1Signature = { scheme: 'Secp256k1', big_r: { affine_point: `02${'11'.repeat(32)}` }, s: { scalar: '22'.repeat(32) }, recovery_id: 0 };
const EIP712_HEX = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;

// What the contract builds for each kind (paths from interfaces 1.3; bodies are the contract's, opaque here).
function route(req: OrderlyRequest): { method: string; path: string; body: string } {
  switch (req.kind) {
    case 'receiver_address': return { method: 'GET', path: '/v1/client/asset/receiver_address?chain_id=42161&token=USDC', body: '' };
    case 'settle_nonce': return { method: 'GET', path: '/v1/settle_nonce', body: '' };
    case 'withdraw_nonce': return { method: 'GET', path: '/v1/withdraw_nonce', body: '' };
    case 'settle_pnl': return { method: 'POST', path: '/v1/settle_pnl', body: JSON.stringify({ nonce: req.nonce, ts: req.signed_at_ms }) };
    case 'withdraw_request': return { method: 'POST', path: '/v1/withdraw_request', body: JSON.stringify({ amount: req.amount, nonce: req.nonce }) };
    case 'referral_bind': return { method: 'POST', path: '/v1/referral/bind', body: '{"referral_code":"GIMBAL"}' };
    case 'funding_fee_history':
      return { method: 'GET', path: `/v1/funding_fee/history?start_t=${req.start_t}&end_t=${req.end_t}&page=${req.page}&size=${req.size}`, body: '' };
    default: throw new Error(`fake signer: ${req.kind}`);
  }
}

class FakeSigner implements OrderlySigner {
  calls: string[] = [];
  requests: OrderlyRequest[] = [];
  tamper: ((a: OrderlyRestAction) => OrderlyRestAction) | null = null;
  #id = 0;

  async orderlyRequest(deskId: string, req: OrderlyRequest, reason: string): Promise<OrderlyRestAction> {
    assert.ok(reason.length > 0 && reason.length <= 280);
    this.calls.push(`orderly_request:${req.kind}`);
    this.requests.push(req);
    const r = route(req);
    const payload = { ...r, timestamp: req.timestamp_ms, message: orderlyRestMessage(req.timestamp_ms, r.method, r.path, r.body) };
    const action: OrderlyRestAction = { desk_id: deskId, request_id: ++this.#id, venue: 'orderly', kind: req.kind, payload, signature: { scheme: 'Ed25519', signature: SIG } };
    return this.tamper === null ? action : this.tamper(action);
  }
  async orderlyWsAuth(deskId: string, timestamp: number): Promise<OrderlyRestAction> {
    this.calls.push('orderly_ws_auth');
    return { desk_id: deskId, request_id: ++this.#id, venue: 'orderly', kind: 'ws_auth', payload: { method: '', path: '', body: '', timestamp, message: String(timestamp) }, signature: { scheme: 'Ed25519', signature: SIG } };
  }
  async orderlyRegister(deskId: string, registrationNonce: string): Promise<OrderlyEip712Action> {
    this.calls.push(`orderly_register:${registrationNonce}`);
    return this.#eip712(deskId, 'register', { brokerId: 'gimbal', chainId: 42161, timestamp: NOW, registrationNonce });
  }
  async orderlyAddKey(deskId: string, expirationMs: number): Promise<OrderlyEip712Action> {
    this.calls.push('orderly_add_key');
    return this.#eip712(deskId, 'add_key', { brokerId: 'gimbal', chainId: 42161, orderlyKey: KEY, scope: 'read,trading', timestamp: NOW, expiration: expirationMs });
  }
  async orderlySettlePnl(deskId: string, settleNonce: number): Promise<OrderlyEip712Action> {
    this.calls.push(`orderly_settle_pnl:${settleNonce}`);
    return this.#eip712(deskId, 'settle_pnl', { brokerId: 'gimbal', chainId: 42161, settleNonce, timestamp: NOW + 1 });
  }
  async orderlyWithdraw(deskId: string, amount: string, withdrawNonce: number): Promise<OrderlyEip712Action> {
    this.calls.push(`orderly_withdraw:${amount}:${withdrawNonce}`);
    return this.#eip712(deskId, 'withdraw', { brokerId: 'gimbal', chainId: 42161, receiver: EVM, token: 'USDC', amount, withdrawNonce, timestamp: NOW + 2 });
  }
  /** Rewrites an EIP-712 action before it is returned: a contract that signed something else. */
  eip712Tamper: ((a: OrderlyEip712Action) => OrderlyEip712Action) | null = null;
  #eip712(deskId: string, kind: string, message: OrderlyEip712Action['payload']['message']): OrderlyEip712Action {
    const action: OrderlyEip712Action = { desk_id: deskId, request_id: ++this.#id, venue: 'orderly', kind, payload: { message, userAddress: EVM }, signature: SECP };
    return this.eip712Tamper === null ? action : this.eip712Tamper(action);
  }
}

interface Sent { method: string; url: string; headers: Record<string, string>; body: string | undefined }

/** A fake Orderly: answers by method and path, and keeps what was sent. */
function fakeVenue(answers: Record<string, unknown>) {
  const sent: Sent[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    sent.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
    const path = new URL(url).pathname;
    const key = `${method} ${path}`;
    if (!(key in answers)) return new Response(JSON.stringify({ success: false, code: -1000, message: `no fake for ${key}` }), { status: 404 });
    return new Response(JSON.stringify({ success: true, data: answers[key], timestamp: NOW }));
  }) as typeof fetch;
  return { f, sent };
}

function client(signer: FakeSigner, f: typeof fetch, referralCode: string | null = 'GIMBAL') {
  return new OrderlyDeskClient({
    deskId: 'alpha', accountId: ACCOUNT, orderlyKey: KEY, evmAddress: EVM, referralCode, signer, fetch: f, clock: new VirtualClock(NOW),
  });
}

const SETUP_ANSWERS = {
  'GET /v1/registration_nonce': { registration_nonce: '194528949540' },
  'POST /v1/register_account': { account_id: ACCOUNT },
  'POST /v1/orderly_key': { id: 1, orderly_key: KEY },
  'GET /v1/client/asset/receiver_address': { receiver_address: `0x${'ee'.repeat(20)}` },
  'POST /v1/referral/bind': {},
};

test('setup runs registration_nonce, register, add key, receiver address and referral bind, in that order', async () => {
  const signer = new FakeSigner();
  const { f, sent } = fakeVenue(SETUP_ANSWERS);
  const report = await client(signer, f).setup();
  assert.deepEqual(signer.calls, [
    'orderly_register:194528949540', 'orderly_add_key', 'orderly_request:receiver_address', 'orderly_request:referral_bind',
  ]);
  assert.deepEqual(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`), [
    'GET /v1/registration_nonce', 'POST /v1/register_account', 'POST /v1/orderly_key',
    'GET /v1/client/asset/receiver_address', 'POST /v1/referral/bind',
  ]);
  assert.deepEqual(report, { accountId: ACCOUNT, orderlyKey: KEY, receiverAddress: { receiver_address: `0x${'ee'.repeat(20)}` }, referral: 'bound' });
  // The EIP-712 steps carry the typed message, the 65-byte signature and the desk's address; no orderly headers.
  const register = JSON.parse(sent[1]!.body!) as { message: Record<string, unknown>; signature: string; userAddress: string };
  assert.deepEqual(register, { message: { brokerId: 'gimbal', chainId: 42161, timestamp: NOW, registrationNonce: '194528949540' }, signature: EIP712_HEX, userAddress: EVM });
  assert.equal(sent[1]!.headers['orderly-signature'], undefined);
  const addKey = JSON.parse(sent[2]!.body!) as { message: { expiration: number; scope: string } };
  assert.equal(addKey.message.scope, 'read,trading');
  assert.ok(addKey.message.expiration - NOW <= 365 * 86_400_000);
  // The signed steps carry the four headers, the timestamp the contract signed, and the exact signed body.
  const receiver = sent[3]!;
  assert.equal(receiver.url, 'https://api.orderly.org/v1/client/asset/receiver_address?chain_id=42161&token=USDC');
  assert.equal(receiver.headers['orderly-account-id'], ACCOUNT);
  assert.equal(receiver.headers['orderly-key'], KEY);
  assert.equal(receiver.headers['orderly-timestamp'], String(NOW));
  assert.equal(receiver.headers['orderly-signature'], Buffer.from(SIG).toString('base64url'));
  assert.equal(receiver.body, undefined);
  assert.equal(sent[4]!.body, '{"referral_code":"GIMBAL"}');
  assert.equal(sent[4]!.headers['content-type'], 'application/json');
});

test('setup skips referral_bind when no referral code is configured', async () => {
  const signer = new FakeSigner();
  const { f, sent } = fakeVenue(SETUP_ANSWERS);
  const report = await client(signer, f, null).setup();
  assert.equal(report.referral, 'skipped');
  assert.ok(!signer.calls.includes('orderly_request:referral_bind'));
  assert.ok(!sent.some((s) => s.url.includes('/referral/')));
});

test('register refuses an account id other than the desk\'s', async () => {
  const signer = new FakeSigner();
  const { f } = fakeVenue({ ...SETUP_ANSWERS, 'POST /v1/register_account': { account_id: `0x${'99'.repeat(32)}` } });
  await assert.rejects(client(signer, f).register(), /the desk expects/);
});

test('money out settles first: settle_nonce, settle_pnl, withdraw_nonce, withdraw, withdraw_request', async () => {
  const signer = new FakeSigner();
  const { f, sent } = fakeVenue({
    'GET /v1/settle_nonce': { settle_nonce: 17 },
    'POST /v1/settle_pnl': { settle_pnl_id: 3 },
    'GET /v1/withdraw_nonce': { withdraw_nonce: '41' },
    'POST /v1/withdraw_request': { withdraw_id: 9 },
  });
  const report = await client(signer, f).withdraw('12.5');
  assert.deepEqual(signer.calls, [
    'orderly_request:settle_nonce', 'orderly_settle_pnl:17', 'orderly_request:settle_pnl',
    'orderly_request:withdraw_nonce', 'orderly_withdraw:12.5:41', 'orderly_request:withdraw_request',
  ]);
  assert.deepEqual(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`), [
    'GET /v1/settle_nonce', 'POST /v1/settle_pnl', 'GET /v1/withdraw_nonce', 'POST /v1/withdraw_request',
  ]);
  // The EIP-712 signatures and their message timestamps reach the contract, which rebuilds the bodies.
  const settle = signer.requests.find((r) => r.kind === 'settle_pnl')!;
  assert.deepEqual([settle.nonce, settle.signed_at_ms, settle.eip712_signature], [17, NOW + 1, EIP712_HEX]);
  const withdraw = signer.requests.find((r) => r.kind === 'withdraw_request')!;
  assert.deepEqual([withdraw.amount, withdraw.nonce, withdraw.signed_at_ms, withdraw.eip712_signature], ['12.5', 41, NOW + 2, EIP712_HEX]);
  assert.deepEqual(report, { settleNonce: 17, withdrawNonce: 41, settled: { settle_pnl_id: 3 }, withdraw: { withdraw_id: 9 } });
});

test('money out stops at the first refusal and never withdraws unsettled', async () => {
  const signer = new FakeSigner();
  const { f, sent } = fakeVenue({ 'GET /v1/settle_nonce': { settle_nonce: 17 } });   // settle_pnl is refused (404 fake)
  await assert.rejects(client(signer, f).withdraw('12.5'), /orderly settle_pnl POST \/v1\/settle_pnl: HTTP 404 code -1000/);
  assert.ok(!signer.calls.some((c) => c.startsWith('orderly_withdraw')));
  assert.ok(!sent.some((s) => s.url.includes('withdraw')));
});

test('a withdraw_request with a lost answer (a 5xx, a timeout) is OutcomeUnknown with its nonce; a read with one stays a plain error', async () => {
  const venue = fakeVenue({
    'GET /v1/settle_nonce': { settle_nonce: 17 },
    'POST /v1/settle_pnl': { settle_pnl_id: 3 },
    'GET /v1/withdraw_nonce': { withdraw_nonce: '41' },
  });
  for (const lost of [
    () => new Response('<html>Bad Gateway</html>', { status: 502 }),
    () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
  ]) {
    const f = (async (input: string | URL | Request, init?: RequestInit) =>
      (String(input).endsWith('/v1/withdraw_request') ? lost() : venue.f(input, init))) as typeof fetch;
    await assert.rejects(client(new FakeSigner(), f).withdraw('12.5'), (err: unknown) => {
      assert.ok(err instanceof OutcomeUnknown, String(err));
      assert.equal(err.what, 'orderly withdraw_request');
      assert.equal(err.ids.orderlyWithdrawNonce, 41);
      return true;
    });
  }
  // The receiver address read meeting a 502: not a money move, so the plain OrderlyApiError.
  const down = (async () => new Response('<html>Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(client(new FakeSigner(), down).receiverAddress(), (err: unknown) => err instanceof OrderlyApiError && !(err instanceof OutcomeUnknown));
});

test('a withdraw amount must be a canonical USDC decimal string, at most 6 decimals', async () => {
  const signer = new FakeSigner();
  const { f } = fakeVenue({});
  for (const bad of ['0', '-1', '1.50', '01', '1.1234567', '1.123456789', 'abc']) {
    await assert.rejects(client(signer, f).withdraw(bad), /canonical/, bad);
  }
  assert.deepEqual(signer.calls, []);
});

test('settle_pnl and withdraw_request only run inside withdraw(): request() refuses them without signing', async () => {
  const signer = new FakeSigner();
  const { f, sent } = fakeVenue({});
  for (const kind of ['settle_pnl', 'withdraw_request'] as const) {
    await assert.rejects(client(signer, f).request(kind, { amount: '1', nonce: 1 }), new RegExp(`${kind} only runs inside withdraw\\(\\)`));
  }
  assert.deepEqual(signer.calls, []);
  assert.equal(sent.length, 0);
});

const MONEY_OUT = {
  'GET /v1/settle_nonce': { settle_nonce: 17 },
  'POST /v1/settle_pnl': { settle_pnl_id: 3 },
  'GET /v1/withdraw_nonce': { withdraw_nonce: 41 },
  'POST /v1/withdraw_request': { withdraw_id: 9 },
};

test('the settle and withdraw messages must carry the nonce, amount and receiver asked for, or nothing more is sent', async () => {
  const cases: [string, (a: OrderlyEip712Action) => OrderlyEip712Action, RegExp, string][] = [
    ['settle nonce', (a) => (a.kind === 'settle_pnl' ? { ...a, payload: { ...a.payload, message: { ...a.payload.message, settleNonce: 16 } } } : a), /settle pnl: the contract signed settleNonce 16, the engine asked for 17/, 'GET /v1/settle_nonce'],
    ['withdraw nonce', (a) => (a.kind === 'withdraw' ? { ...a, payload: { ...a.payload, message: { ...a.payload.message, withdrawNonce: 40 } } } : a), /signed withdrawNonce 40/, 'GET /v1/withdraw_nonce'],
    ['amount', (a) => (a.kind === 'withdraw' ? { ...a, payload: { ...a.payload, message: { ...a.payload.message, amount: '125' } } } : a), /signed amount "125", the engine asked for 12.5 USDC/, 'GET /v1/withdraw_nonce'],
    ['receiver', (a) => (a.kind === 'withdraw' ? { ...a, payload: { ...a.payload, message: { ...a.payload.message, receiver: `0x${'aa'.repeat(20)}` } } } : a), /signed receiver 0xaaaa/, 'GET /v1/withdraw_nonce'],
    ['desk', (a) => (a.kind === 'settle_pnl' ? { ...a, desk_id: 'beta' } : a), /for desk beta, not alpha/, 'GET /v1/settle_nonce'],
  ];
  for (const [name, tamper, error, lastSent] of cases) {
    const signer = new FakeSigner();
    signer.eip712Tamper = tamper;
    const { f, sent } = fakeVenue(MONEY_OUT);
    await assert.rejects(client(signer, f).withdraw('12.5'), error, name);
    assert.equal(`${sent.at(-1)!.method} ${new URL(sent.at(-1)!.url).pathname}`, lastSent, name);
    assert.ok(!sent.some((s) => s.url.endsWith('/v1/withdraw_request')), name);
  }
  // The amount may come back in USDC's 6-decimal units: 12.5 USDC = 12500000.
  const signer = new FakeSigner();
  signer.eip712Tamper = (a) => (a.kind === 'withdraw' ? { ...a, payload: { ...a.payload, message: { ...a.payload.message, amount: 12_500_000 } } } : a);
  const { f } = fakeVenue(MONEY_OUT);
  assert.equal((await client(signer, f).withdraw('12.5')).withdrawNonce, 41);
});

test('setup refuses a registration or key the contract signed for something else', async () => {
  const wrongNonce = new FakeSigner();
  wrongNonce.eip712Tamper = (a) => ({ ...a, payload: { ...a.payload, message: { ...a.payload.message, registrationNonce: '1' } } });
  const one = fakeVenue(SETUP_ANSWERS);
  await assert.rejects(client(wrongNonce, one.f).register(), /register: the contract signed registrationNonce "1", the engine asked for "194528949540"/);
  assert.ok(!one.sent.some((s) => s.url.endsWith('/v1/register_account')));
  const wrongKey = new FakeSigner();
  wrongKey.eip712Tamper = (a) => ({ ...a, payload: { ...a.payload, message: { ...a.payload.message, orderlyKey: `ed25519:${'3'.repeat(44)}` } } });
  const two = fakeVenue(SETUP_ANSWERS);
  await assert.rejects(client(wrongKey, two.f).addKey(), /add key: the contract signed orderlyKey/);
  assert.equal(two.sent.length, 0);
});

test('a signed request whose message does not match what is sent is never sent', async () => {
  const signer = new FakeSigner();
  signer.tamper = (a) => ({ ...a, payload: { ...a.payload, path: '/v1/withdraw_nonce' } });
  const { f, sent } = fakeVenue({ 'GET /v1/settle_nonce': { settle_nonce: 1 }, 'GET /v1/withdraw_nonce': { withdraw_nonce: 1 } });
  await assert.rejects(client(signer, f).request('settle_nonce'), /not timestamp \+ method \+ path \+ body/);
  signer.tamper = (a) => ({ ...a, payload: { ...a.payload, timestamp: NOW - 400_000, message: orderlyRestMessage(NOW - 400_000, 'GET', '/v1/settle_nonce', '') } });
  await assert.rejects(client(signer, f).request('settle_nonce'), /outside 300 s/);
  assert.equal(sent.length, 0);
});

test('userFunding over the signed funding_fee_history read: pages, signs by payment type, sizes from the fee', async () => {
  const signer = new FakeSigner();
  const row = (t: number, symbol: string, rate: number, fee: number, type: string): OrderlyFundingFeeRow =>
    ({ symbol, funding_rate: rate, mark_price: 100, funding_fee: fee, payment_type: type, created_time: t });
  const rows = Array.from({ length: 500 }, (_, i) => row(NOW - (i + 1) * 8 * 3_600_000, 'PERP_SOL_USDC', 0.0001, 0.02, 'Pay'));
  const pages: Record<number, OrderlyFundingFeeRow[]> = { 1: rows, 2: [row(NOW - 1000, 'PERP_ETH_USDC', -0.0002, 0.04, 'Pay')] };
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/public/info') {
      return new Response(JSON.stringify({ success: true, data: { rows: [{ symbol: 'PERP_SOL_USDC', funding_period: 8 }, { symbol: 'PERP_ETH_USDC', funding_period: 4 }] } }));
    }
    const page = Number(url.searchParams.get('page'));
    return new Response(JSON.stringify({ success: true, data: { rows: pages[page] ?? [], meta: { total: 501, records_per_page: 500, current_page: page } } }));
  }) as typeof fetch;
  const desk = client(signer, f);
  const reader = new OrderlyReader({ fetch: f, fundingFees: desk, clock: new VirtualClock(NOW) });
  const out = await reader.userFunding(ACCOUNT, 0, NOW);
  assert.equal(signer.calls.filter((c) => c === 'orderly_request:funding_fee_history').length, 2, 'one signature per page');
  assert.equal(out.length, 501);
  for (let i = 1; i < out.length; i++) assert.ok(out[i]!.time >= out[i - 1]!.time);
  const sol = out[0]!;
  // Paid 0.02 USDC on a positive 8 h rate: a long of 0.02 / (0.0001 x 100) = 2 SOL.
  assert.equal(sol.fundingUsd, -0.02);
  assert.ok(Math.abs(sol.size - 2) < 1e-12);
  assert.equal(sol.ratePerHour, 0.0001 / 8);
  assert.equal(sol.samples, 8);
  const eth = out.at(-1)!;
  // Paid on a negative rate: shorts pay, so a short.
  assert.equal(eth.fundingUsd, -0.04);
  assert.ok(eth.size < 0);
  assert.equal(eth.ratePerHour, -0.0002 / 4);
  await assert.rejects(new OrderlyReader({ fetch: f }).userFunding(ACCOUNT, 0), /needs the desk's signed client/);
  await assert.rejects(reader.userFunding(`0x${'77'.repeat(32)}`, 0), /the client is for/);
});

test('userFunding pages by what the venue says: capped at 100 per page with 450 in all is five pages, not one', async () => {
  const signer = new FakeSigner();
  const all = Array.from({ length: 450 }, (_, i): OrderlyFundingFeeRow =>
    ({ symbol: i === 7 ? 'PERP_GONE_USDC' : 'PERP_SOL_USDC', funding_rate: 0.0001, mark_price: 100, funding_fee: 0.01, payment_type: 'Pay', created_time: NOW - (i + 1) * 28_800_000 }));
  const asked: number[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/public/info') return new Response(JSON.stringify({ success: true, data: { rows: [{ symbol: 'PERP_SOL_USDC', funding_period: 8 }] } }));
    const page = Number(url.searchParams.get('page'));
    asked.push(Number(url.searchParams.get('size')));
    // The venue serves at most 100 rows whatever size was asked for, and says so.
    const rows = all.slice((page - 1) * 100, page * 100);
    return new Response(JSON.stringify({ success: true, data: { rows, meta: { total: 450, records_per_page: 100, current_page: page } } }));
  }) as typeof fetch;
  const notes: string[] = [];
  const reader = new OrderlyReader({ fetch: f, fundingFees: client(signer, f), clock: new VirtualClock(NOW), onNote: (n) => notes.push(n) });
  const out = await reader.userFunding(ACCOUNT, 0, NOW);
  assert.deepEqual(asked, [500, 500, 500, 500, 500]);
  assert.equal(signer.calls.filter((c) => c === 'orderly_request:funding_fee_history').length, 5);
  // A symbol missing from /v1/public/info is skipped and said, not a failure of the whole read.
  assert.equal(out.length, 449);
  assert.deepEqual(notes, ['orderly userFunding: skipped 1 payment(s) on PERP_GONE_USDC: no funding period (not in /v1/public/info)']);
});

test('page walk: short page against records_per_page, the total when given, else the size asked for', () => {
  assert.equal(morePages(100, 500, 100, { total: 450, records_per_page: 100 }), true);
  assert.equal(morePages(50, 500, 450, { total: 450, records_per_page: 100 }), false);
  assert.equal(morePages(100, 500, 450, { total: 450, records_per_page: 100 }), false, 'every row is in');
  assert.equal(morePages(100, 500, 100, { total: 450 }), true, 'capped silently: the total keeps the walk going');
  assert.equal(morePages(100, 500, 100, undefined), false, 'nothing said: a page short of the size asked for is the last');
  assert.equal(morePages(500, 500, 500, undefined), true);
  assert.equal(morePages(0, 500, 300, { total: 450 }), false, 'an empty page ends it');
});

test('a funding fee row received on a positive rate is a short receiving', () => {
  const p = parseFundingFeeRow({ symbol: 'PERP_SOL_USDC', funding_rate: 0.0001, mark_price: 50, funding_fee: 0.01, payment_type: 'Receive', created_time: 5 }, 8);
  assert.equal(p.fundingUsd, 0.01);
  assert.ok(Math.abs(p.size + 2) < 1e-12);
  const flatRow: OrderlyFundingFeeRow = { symbol: 'PERP_SOL_USDC', funding_rate: 0, mark_price: 50, funding_fee: 0, payment_type: 'Pay', created_time: 5 };
  const flat = parseFundingFeeRow(flatRow, 8);
  assert.equal(flat.size, 0);
  assert.ok(Object.is(flat.fundingUsd, 0));
  assert.throws(() => parseFundingFeeRow({ ...flatRow, payment_type: 'Other' }, 8), /unknown payment_type Other/);
});

test('an order never carries a caller-chosen client_order_id: the contract derives it from its request_id', async () => {
  const signer = new FakeSigner();
  await assert.rejects(client(signer, fakeVenue({}).f).request('order', { symbol: 'PERP_ETH_USDC', client_order_id: 'mine' }), /do not pass one/);
  assert.deepEqual(signer.calls, []);
});
