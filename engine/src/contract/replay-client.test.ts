// ReplayContractClient against the contract's public vectors: the order checks and refusal codes of hl.json, the
// EIP-3009 nonce rule and digest of eip3009.json, and the Orderly request bodies and signatures of orderly.json.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eip3009Digest } from '../relayer/arbitrum.ts';
import { hlSignature, recoverSigner } from '../relayer/hl-wire.ts';
import { TEST_DEPOSIT_EVM, TEST_EVM_ADDRESS, testContract, testDesk, vectors } from '../relayer/test-helpers.ts';
import type { OrderlyRequest } from '../venues/orderly-signer.ts';
import { ed25519SignatureBase64Url } from '../venues/orderly-signer.ts';
import { ReplayContractClient, eip3009Nonce } from './replay-client.ts';
import type { HlOrder } from './types.ts';
import { ContractRefusal } from './types.ts';

const HL = vectors('hl').order_policy;

function policyContract(): ReplayContractClient {
  const c = testContract(() => HL.now_ms);
  for (const asset of ['ETH', 'BTC', 'SOL']) {
    const p = HL.oracle_by_symbol[asset];
    c.setPrice(asset, p.price_e8, p.at_ms);
  }
  return c;
}

test('hl_order: every order_policy case of hl.json passes or is refused with its code', async () => {
  const c = policyContract();
  const codes: Record<string, number> = {};
  for (const v of HL.cases as { name: string; order: HlOrder; expect: { ok: boolean; code?: string } }[]) {
    const run = c.hlOrder('alpha', v.order, v.name);
    if (v.expect.ok) {
      const signed = await run;
      assert.equal(signed.payload.action.type, 'order', v.name);
    } else {
      await assert.rejects(run, (err: unknown) => {
        assert.ok(err instanceof ContractRefusal, `${v.name}: ${String(err)}`);
        assert.equal(err.code, v.expect.code, `${v.name}: ${err.message}`);
        return true;
      });
      codes[v.expect.code!] = (codes[v.expect.code!] ?? 0) + 1;
    }
  }
  assert.equal(codes.E_PRICE_BAND, 2);
  assert.equal(codes.E_ORACLE_STALE, 2);
});

test('hl_order: the action carries the builder fee, a nonce that only grows, and a signature by the desk key', async () => {
  const c = policyContract();
  const order: HlOrder = { asset: 1, is_buy: true, px: '2500.5', sz: '0.1', reduce_only: false, tif: 'Ioc', cloid: null };
  const a = await c.hlOrder('alpha', order, 'enter');
  const b = await c.hlOrder('alpha', order, 'enter again');
  assert.deepEqual(a.payload.action, {
    type: 'order', orders: [{ a: 1, b: true, p: '2500.5', s: '0.1', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na',
    builder: { b: '0x2222222222222222222222222222222222222222', f: 10 },
  });
  assert.equal(a.payload.nonce, HL.now_ms);
  assert.equal(b.payload.nonce, HL.now_ms + 1);
  assert.equal(a.replay, true);
  const { l1Digest } = await import('../relayer/hl-wire.ts');
  const signer = await recoverSigner(l1Digest(a.payload.action as never, a.payload.nonce, 'testnet'), hlSignature(a.signature));
  assert.equal(signer, TEST_EVM_ADDRESS.toLowerCase());
});

test('a paused desk refuses new risk but still signs what reduces it', async () => {
  const c = policyContract();
  await c.pause('alpha');
  const order: HlOrder = { asset: 1, is_buy: false, px: '2499', sz: '0.2', reduce_only: false, tif: 'Ioc', cloid: null };
  await assert.rejects(c.hlOrder('alpha', order, 'enter'), { code: 'E_PAUSED' });
  await c.hlOrder('alpha', { ...order, reduce_only: true }, 'exit');
  await c.hlCancel('alpha', 1, 42, 'stop');
  await assert.rejects(c.hlOrder('nope', order, 'x'), { code: 'E_NO_DESK' });
});

test('evm_usdc_to_intents: the nonce rule and digest of eip3009.json, signed by the desk', async () => {
  const v = vectors('eip3009');
  for (const n of v.nonce_cases) assert.equal(eip3009Nonce(n.desk_id, BigInt(n.counter)), n.nonce);
  for (const k of v.cases.filter((x: { network: string }) => x.network === 'testnet')) {
    const c = new ReplayContractClient({
      config: { network: 'testnet', hlBuilder: '0x2222222222222222222222222222222222222222', hlBuilderTenthBps: 10 },
      desks: { [k.desk_id]: testDesk() }, keys: { [k.desk_id]: { evm: v.keys.deskEvm.private_key } }, now: () => k.now_s * 1000,
    });
    const quote = { quote: { depositAddress: k.message.to, amountIn: k.message.value }, quote_signature: 'ed25519:test' };
    for (let i = 0n; i < BigInt(k.counter); i++) await c.evmUsdcToIntents(k.desk_id, quote, 'earlier');
    const signed = await c.evmUsdcToIntents(k.desk_id, quote, k.name);  // the vector's counter
    assert.deepEqual(
      { from: signed.payload.from, to: signed.payload.to, value: signed.payload.value, validAfter: signed.payload.validAfter, validBefore: signed.payload.validBefore, nonce: signed.payload.nonce },
      k.message, k.name,
    );
    assert.equal(eip3009Digest(signed.payload), k.digest, k.name);
    const sig = hlSignature(signed.signature);
    assert.equal(sig.r, k.signature.r);
    assert.equal(sig.s, k.signature.s);
    assert.equal(sig.v, k.signature.v);
  }
  assert.equal(TEST_DEPOSIT_EVM, v.keys.depositEvm.address);
});

test('orderly_request: the body, message and signature of every testnet request in orderly.json', async () => {
  const v = vectors('orderly');
  const desk = testDesk({ evm_address: v.keys.deskEvm.address });
  for (const r of v.requests.filter((x: { network: string }) => x.network === 'testnet')) {
    const c = testContract(() => r.timestamp, {
      orderlyBrokerId: v.networks.testnet.brokerId, orderlyChainId: v.networks.testnet.chainId, orderlyReferralCode: 'TESTCODE',
    });
    c.setDesk('alpha', desk);
    // Requests without a `request` object carry their inputs in the body (the EIP-712 parts the engine passes in).
    const fromBody: Partial<OrderlyRequest> = {};
    if (r.kind === 'settle_pnl' || r.kind === 'withdraw_request') {
      const b = JSON.parse(r.body);
      fromBody.nonce = b.message.settleNonce ?? b.message.withdrawNonce;
      fromBody.signed_at_ms = b.message.timestamp;
      fromBody.eip712_signature = b.signature;
      if (b.message.amount !== undefined) fromBody.amount = String(Number(b.message.amount) / 1e6);
    }
    const req = { kind: r.kind, reduce_only: false, ...fromBody, ...r.request, timestamp_ms: r.timestamp } as OrderlyRequest;
    const signed = await c.orderlyRequest('alpha', req, r.name);
    assert.equal(signed.payload.method, r.method, r.name);
    assert.equal(signed.payload.path, r.path, r.name);
    assert.equal(signed.payload.body, r.body, r.name);
    assert.equal(signed.payload.message, r.message, r.name);
    assert.equal(ed25519SignatureBase64Url(signed.signature), r.signature_b64url, r.name);
  }
  const ws = await testContract(() => v.ws_auth.timestamp).orderlyWsAuth('alpha', v.ws_auth.timestamp);
  assert.equal(ed25519SignatureBase64Url(ws.signature), v.ws_auth.signature_b64url);
});

test('orderly EIP-712 actions recover to the desk, and the refusals the contract makes', async () => {
  const v = vectors('orderly');
  const c = testContract(() => 1_793_491_200_000);
  await assert.rejects(c.orderlyRegister('alpha', '12ab'), { code: 'E_ARGS' });
  await assert.rejects(c.orderlyAddKey('alpha', 1_793_491_200_000 + 400 * 86_400_000), { code: 'E_ARGS' });
  await assert.rejects(c.orderlyRequest('alpha', { kind: 'order', symbol: 'PERP_DOGE_USDC', reduce_only: false, timestamp_ms: 1 }, 'x'), { code: 'E_ASSET' });
  const reg = await c.orderlyRegister('alpha', '194528949540');
  assert.equal(reg.payload.userAddress, TEST_EVM_ADDRESS);
  assert.equal(reg.payload.message.brokerId, 'woofi_dex');
  assert.equal(reg.payload.message.chainId, v.networks.testnet.chainId);
});
