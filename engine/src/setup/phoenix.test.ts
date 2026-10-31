import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compileLegacyMessage, PhoenixOnboarding, solanaReads } from './phoenix.ts';
import { base58Decode } from '../relayer/solana.ts';
import { stubFetch, testContract, testDesk, TEST_SOL_AUTHORITY, vectors } from '../relayer/test-helpers.ts';

const V = vectors('solana-onboarding');
const BLOCKHASH: string = V.recent_blockhash ?? V.messages.register.recent_blockhash ?? 'DmnJBJP8mVBgNwKATxATdJe19x6ridh4pjzzs6SCxRh7';
const TRADER_PDA = V.live.build_register_ixs.desk.response.traderPda as string;

/** Phoenix's API as recorded in the vectors (live answers fetched once, never sent to). */
function phoenixApi(over: { send?: unknown; activate?: unknown } = {}) {
  return stubFetch((call) => {
    const path = new URL(call.url).pathname;
    if (path === '/v1/exchange/build-register-ixs') return V.live.build_register_ixs.desk.response;
    if (path === '/v1/exchange/send-register-ixs') return over.send ?? { signature: 'RegSig1111111111111111111111111111111111111', traderPda: TRADER_PDA };
    if (path === '/v1/referral/activation-permission') return V.live.activation_permission;
    if (path === '/v1/exchange/snapshot') return { exchange: V.live.exchange };
    if (path === '/v1/referral/activate-tx') return over.activate ?? { signature: 'RefSig1111111111111111111111111111111111111', trader_pda: TRADER_PDA, referral_code: 'TESTREF1', status: 'activated' };
    return new Response('not found', { status: 404 });
  });
}

function onboarding(api: ReturnType<typeof phoenixApi>, referralCode: string | null = null, exists = false) {
  const contract = testContract(() => 1_800_000_000_000);
  const o = new PhoenixOnboarding({
    deskId: 'alpha', authority: TEST_SOL_AUTHORITY, traderPda: TRADER_PDA, referralCode, signer: contract,
    solana: { latestBlockhash: async () => BLOCKHASH, accountExists: async () => exists },
    fetch: api.fetch,
  });
  return { o, contract };
}

test('the vectors use the same blockhash and trader PDA as the test desk', () => {
  assert.equal(V.live.build_register_ixs.desk.request.traderAuthority, TEST_SOL_AUTHORITY);
  assert.equal(testDesk().solana.phoenix_trader, TRADER_PDA);
  assert.equal(V.messages.referral_activate.http.body.recent_blockhash, BLOCKHASH);
});

test('the legacy compiler builds the register message byte for byte (web3.js key order)', () => {
  const message = compileLegacyMessage(V.live.build_register_ixs.desk.response.instructions, TEST_SOL_AUTHORITY, BLOCKHASH);
  assert.equal(Buffer.from(message).toString('base64'), V.messages.register.message_b64);
  assert.equal(message.length, V.messages.register.size);
  assert.equal(createHash('sha256').update(message).digest('hex'), V.messages.register.message_sha256);
});

test('the compiler keeps the fee payer first when another payer is asked for', () => {
  const r = V.live.build_register_ixs.fee_payer_stranger;
  const message = compileLegacyMessage(r.response.instructions, r.request.txFeePayer, BLOCKHASH);
  assert.equal(message[0], 2, 'the payer and the onboarder sign; the trader authority is not a signer');
  assert.ok(Buffer.from(message.subarray(4, 36)).equals(base58Decode(r.request.txFeePayer)), 'keys[0] is the fee payer');
});

test('register: build, compile, sol_sign_register, send; the body equals the vector', async () => {
  const api = phoenixApi();
  const { o, contract } = onboarding(api);
  const result = await o.register();
  const build = api.calls.find((c) => c.url.endsWith('/v1/exchange/build-register-ixs'))!;
  assert.deepEqual(build.json, V.live.build_register_ixs.desk.request);
  const send = api.calls.find((c) => c.url.endsWith('/v1/exchange/send-register-ixs'))!;
  assert.deepEqual(send.json, V.messages.register.http.body);
  assert.deepEqual(contract.calls.map((c) => c.method), ['sol_sign_register']);
  assert.equal(result.signature, 'RegSig1111111111111111111111111111111111111');
  assert.equal(result.tx[0]?.chain, 'solana');
});

test('register refuses an answer for another trader PDA or position count', async () => {
  const wrong = stubFetch((call) => {
    if (call.url.endsWith('/v1/exchange/build-register-ixs')) return { ...V.live.build_register_ixs.desk.response, traderPda: '7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9' };
    return new Response('no', { status: 500 });
  });
  const a = onboarding(wrong);
  await assert.rejects(a.o.register(), /trader PDA/);
  assert.equal(a.contract.calls.length, 0, 'nothing is signed');

  const thirtyTwo = stubFetch((call) => {
    if (call.url.endsWith('/v1/exchange/build-register-ixs')) return V.live.build_register_ixs.max_positions_32.response;
    return new Response('no', { status: 500 });
  });
  const b = onboarding(thirtyTwo);
  await assert.rejects(b.o.register(), /maxPositions/);
  assert.equal(b.contract.calls.length, 0);
});

test('referral: the v0 activation message and the activate-tx body equal the vector', async () => {
  const api = phoenixApi();
  const { o, contract } = onboarding(api, 'TESTREF1');
  const result = await o.activateReferral();
  assert.equal(result?.status, 'activated');
  const signed = contract.calls.find((c) => c.method === 'sol_sign_register')!;
  assert.equal((signed.args as { message_b64: string }).message_b64, V.messages.referral_activate.message_b64);
  const sent = api.calls.find((c) => c.url.endsWith('/v1/referral/activate-tx'))!;
  assert.deepEqual(sent.json, V.messages.referral_activate.http.body);
});

test('referral: nothing without a code', async () => {
  const api = phoenixApi();
  const { o, contract } = onboarding(api, null);
  assert.equal(await o.activateReferral(), null);
  assert.equal(api.calls.length, 0);
  assert.equal(contract.calls.length, 0);
});

test('a Phoenix error answer fails the step with its text', async () => {
  const api = phoenixApi({ send: new Response('{"error":"blockhash expired"}', { status: 400 }) });
  const { o } = onboarding(api);
  await assert.rejects(o.register(), /HTTP 400 .*blockhash expired/);
});

test('isRegistered reads the trader account', async () => {
  assert.equal(await onboarding(phoenixApi(), null, true).o.isRegistered(), true);
  assert.equal(await onboarding(phoenixApi(), null, false).o.isRegistered(), false);
});

test('solanaReads: blockhash and account existence over JSON-RPC', async () => {
  const rpc = stubFetch((call) => {
    const req = call.json as { method: string; params: unknown[] };
    if (req.method === 'getLatestBlockhash') return { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 9 } } };
    if (req.method === 'getAccountInfo') return { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: req.params[0] === TRADER_PDA ? { data: ['', 'base64'] } : null } };
    return { jsonrpc: '2.0', id: 1, error: { message: 'method not found' } };
  });
  const reads = solanaReads('https://rpc.example', rpc.fetch);
  assert.equal(await reads.latestBlockhash(), BLOCKHASH);
  assert.equal(await reads.accountExists(TRADER_PDA), true);
  assert.equal(await reads.accountExists(TEST_SOL_AUTHORITY), false);
});
