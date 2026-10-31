// NearContractClient against a fake chain: what each method sends, how a SignedAction, a refusal and an MPC timeout
// come back, which methods retry (and with what), and the budget check before every signature.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OrderlyRequest } from '../venues/orderly-signer.ts';
import { YOCTO_PER_NEAR } from './budget.ts';
import type { NearCallOutcome, NearTransport } from './near-client.ts';
import { NearContractClient, parseSignedAction, parseStoredPrices } from './near-client.ts';
import { allowanceOf, outcomeOf } from './near-transport.ts';
import type { HlOrder } from './types.ts';
import { ContractRefusal, MpcTimeoutError, SignatureBudgetError, isMpcTimeout, parseRefusal } from './types.ts';

const DESK = 'alpha';
const ORDER: HlOrder = { asset: 1, is_buy: true, px: '2400.5', sz: '0.0042', reduce_only: false, tif: 'Ioc', cloid: null };
const SECP = { scheme: 'Secp256k1', big_r: { affine_point: `02${'11'.repeat(32)}` }, s: { scalar: '22'.repeat(32) }, recovery_id: 0 };

function signed(method: string, args: Record<string, unknown>) {
  return {
    desk_id: args.desk_id, request_id: 7, venue: method.startsWith('hl_') ? 'hyperliquid' : 'orderly', kind: method,
    payload: { action: { type: 'order' }, nonce: 1, vaultAddress: null, args }, signature: SECP,
  };
}

class FakeChain implements NearTransport {
  readonly accountId = 'owner.testnet';
  calls: { method: string; args: Record<string, unknown>; tgas: number }[] = [];
  answers: ((method: string, args: Record<string, unknown>) => NearCallOutcome)[] = [];
  balance = 5n * YOCTO_PER_NEAR;
  allowanceLeft: bigint | null = 5n * YOCTO_PER_NEAR;
  views = new Map<string, unknown>();
  delayMs = 0;

  async call(_contract: string, method: string, args: object, tgas: number): Promise<NearCallOutcome> {
    const a = args as Record<string, unknown>;
    this.calls.push({ method, args: a, tgas });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const answer = this.answers.shift();
    const hash = `tx${this.calls.length}`;
    return answer === undefined ? { txHash: hash, ok: true, value: signed(method, a) } : { ...answer(method, a), txHash: hash };
  }
  async view<T>(_contract: string, method: string, args: object): Promise<T> {
    return this.views.get(`${method} ${JSON.stringify(args)}`) as T;
  }
  async account() {
    return { amount: this.balance, locked: 0n, storageUsage: 0 };
  }
  async allowance() {
    return this.allowanceLeft;
  }
}

const timeout = (): NearCallOutcome => ({ txHash: '', ok: false, failure: '{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: E_MPC: Request has timed out."}}}}' });
const refusal = (text: string) => (): NearCallOutcome => ({ txHash: '', ok: false, failure: `{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${text}"}}}}` });

function client(chain: FakeChain, extra: Partial<ConstructorParameters<typeof NearContractClient>[0]> = {}) {
  return new NearContractClient({ contractId: 'gimbal.testnet', network: 'testnet', transport: chain, ...extra });
}

test('hl_order sends the order as the contract takes it, at 300 TGas, and returns the SignedAction with its NEAR tx', async () => {
  const chain = new FakeChain();
  const action = await client(chain).hlOrder(DESK, ORDER, 'enter ETH');
  assert.deepEqual(chain.calls, [{ method: 'hl_order', args: { desk_id: DESK, order: ORDER, reason: 'enter ETH' }, tgas: 300 }]);
  assert.equal(action.venue, 'hyperliquid');
  assert.deepEqual(action.nearTx, { chain: 'near', id: 'tx1', url: 'https://testnet.nearblocks.io/txns/tx1' });
});

test('a refusal comes back as ContractRefusal with its code, not retried', async () => {
  const chain = new FakeChain();
  chain.answers.push(refusal('E_PRICE_BAND: px 2500 is 4.3% from oracle 2397.1'));
  await assert.rejects(client(chain).hlOrder(DESK, ORDER, 'enter'), (err: unknown) => {
    assert.ok(err instanceof ContractRefusal);
    assert.equal(err.code, 'E_PRICE_BAND');
    assert.equal(err.message, 'E_PRICE_BAND: px 2500 is 4.3% from oracle 2397.1');
    assert.equal(err.txHash, 'tx1');
    return true;
  });
  assert.equal(chain.calls.length, 1);
});

test('an MPC timeout on a contract-nonced method is retried once with the same arguments', async () => {
  const chain = new FakeChain();
  chain.answers.push(timeout);
  const action = await client(chain).hlOrder(DESK, ORDER, 'enter');
  assert.equal(chain.calls.length, 2);
  assert.deepEqual(chain.calls[0]!.args, chain.calls[1]!.args);
  assert.equal(action.nearTx?.id, 'tx2');
  // Two timeouts in a row: MpcTimeoutError, after exactly one retry.
  const again = new FakeChain();
  again.answers.push(timeout, timeout);
  await assert.rejects(client(again).hlCancel(DESK, 1, 77, 'stop'), MpcTimeoutError);
  assert.equal(again.calls.length, 2);
});

test('orderly_request retries with a fresh timestamp; sol_sign and orderly_register leave the retry to the caller', async () => {
  let now = 1_000_000;
  const chain = new FakeChain();
  chain.answers.push(() => { now += 120_000; return timeout(); });
  const req: OrderlyRequest = { kind: 'order', symbol: 'PERP_ETH_USDC', reduce_only: false, timestamp_ms: now };
  await client(chain, { now: () => now }).orderlyRequest(DESK, req, 'hedge');
  assert.equal((chain.calls[0]!.args.req as OrderlyRequest).timestamp_ms, 1_000_000);
  assert.equal((chain.calls[1]!.args.req as OrderlyRequest).timestamp_ms, 1_120_000);

  for (const call of [
    (c: NearContractClient) => c.solSign(DESK, 'AQID', 'order'),
    (c: NearContractClient) => c.orderlyRegister(DESK, '123'),
    (c: NearContractClient) => c.orderlyWsAuth(DESK, 1),
  ]) {
    const once = new FakeChain();
    once.answers.push(timeout);
    await assert.rejects(call(client(once)), MpcTimeoutError);
    assert.equal(once.calls.length, 1);
  }
});

test('every signature checks the budget first: an empty allowance stops it before anything is sent, and says so', async () => {
  const chain = new FakeChain();
  chain.allowanceLeft = YOCTO_PER_NEAR / 10n;
  const health: string[] = [];
  await assert.rejects(client(chain, { onHealth: (s) => health.push(s) }).hlOrder(DESK, ORDER, 'enter'), SignatureBudgetError);
  assert.equal(chain.calls.length, 0);
  assert.deepEqual(health, ['down']);
});

test('a signature slower than slowMs marks NEAR slow, a quick one brings it back', async () => {
  let t = 0;
  const chain = new FakeChain();
  const health: string[] = [];
  const c = client(chain, { now: () => t, slowMs: 30_000, onHealth: (s) => health.push(s) });
  chain.answers.push((m, a) => { t += 45_000; return { txHash: '', ok: true, value: signed(m, a) }; });
  await c.hlOrder(DESK, ORDER, 'slow');
  chain.answers.push((m, a) => { t += 5_000; return { txHash: '', ok: true, value: signed(m, a) }; });
  await c.hlOrder(DESK, ORDER, 'fast');
  assert.deepEqual(health, ['slow', 'ok']);
});

test('the contract on main returns an UnsignedAction: a clear error, never a payload without a signature', () => {
  assert.throws(
    () => parseSignedAction('hl_order', { desk_id: DESK, venue: 'hyperliquid', kind: 'order', payload: {}, sign_request: {} }, DESK),
    /UnsignedAction: this deploy does not call the MPC network yet/,
  );
  assert.throws(() => parseSignedAction('hl_order', { ...signed('hl_order', { desk_id: 'other' }) }, DESK), /desk other/);
});

test('views: get_desk and prices() in either shape', async () => {
  const chain = new FakeChain();
  chain.views.set(`get_desk ${JSON.stringify({ desk_id: DESK })}`, { owner: 'owner.testnet', evm_address: '0xab' });
  chain.views.set('prices {}', [{ asset: 'ETH', price_e8: 239_710_000_000, at_ms: 5 }, { asset: 'bad' }]);
  const c = client(chain);
  assert.equal((await c.getDesk(DESK))?.owner, 'owner.testnet');
  assert.equal(await c.getDesk('nope'), null);
  assert.deepEqual(await c.prices(), [{ asset: 'ETH', price_e8: 239_710_000_000, at_ms: 5 }]);
  assert.deepEqual(parseStoredPrices({ BTC: { price_e8: '8125500000000', at_ms: 9 } }), [{ asset: 'BTC', price_e8: '8125500000000', at_ms: 9 }]);
  assert.deepEqual(parseStoredPrices(null), []);
});

test('refusal texts: the code first, near-sdk deserialization as E_ARGS, timeouts recognised', () => {
  assert.deepEqual(parseRefusal('Smart contract panicked: E_SIZE: ETH 2500 x 1 = 2500 USD is over max_notional_usd 1000'), {
    code: 'E_SIZE', message: 'ETH 2500 x 1 = 2500 USD is over max_notional_usd 1000',
  });
  assert.equal(parseRefusal('Smart contract panicked: Failed to deserialize input from JSON.: Error("unknown field")')?.code, 'E_ARGS');
  assert.equal(parseRefusal('Exceeded the prepaid gas.'), null);
  assert.ok(isMpcTimeout('Smart contract panicked: Request has timed out.'));
  assert.ok(isMpcTimeout('E_MPC: the MPC network did not return a signature'));
  assert.ok(!isMpcTimeout('E_PRICE_BAND: far'));
});

test('transport parsing: final statuses and key allowances', () => {
  const ok = outcomeOf('h', { status: { SuccessValue: Buffer.from(JSON.stringify({ a: 1 })).toString('base64') } });
  assert.deepEqual(ok, { txHash: 'h', ok: true, value: { a: 1 } });
  assert.deepEqual(outcomeOf('h', { status: { SuccessValue: '' } }), { txHash: 'h', ok: true, value: null });
  const failed = outcomeOf('h', { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_PAUSED: desk alpha is paused' } } } } } });
  assert.equal(failed.ok, false);
  assert.match(failed.ok ? '' : failed.failure, /E_PAUSED/);
  assert.equal(allowanceOf({ FunctionCall: { allowance: '4700000000000000000000000', receiver_id: 'g', method_names: [] } }), 4_700_000_000_000_000_000_000_000n);
  assert.equal(allowanceOf({ FunctionCall: { allowance: null, receiver_id: 'g', method_names: [] } }), null);
  assert.equal(allowanceOf('FullAccess'), null);
});
