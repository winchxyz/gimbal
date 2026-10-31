// The relayer end to end over the replay contract and stubbed venues: one call signs and delivers, the Orderly
// headers match orderly.json, an Orderly order whose answer is lost is OutcomeUnknown with its client_order_id, a
// Solana message is built again after an MPC timeout once its blockhash is proven expired, and an unknown outcome
// carries the ids the relayer added (the order's cloid, the Solana message).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContractClient } from '../contract/types.ts';
import { MpcTimeoutError, OutcomeUnknown, solMessageDigest } from '../contract/types.ts';
import { OrderlyApiError } from '../venues/orderly-http.ts';
import { HyperliquidSubmitter } from './hyperliquid.ts';
import { Relayer } from './relayer.ts';
import { SolanaSubmitter } from './solana.ts';
import { fakeTime, stubFetch, testContract, testDesk, vectors } from './test-helpers.ts';

const T0 = 1_793_491_200_000;

test('hlOrder: the contract signs, the relayer posts and confirms, the desk address comes from get_desk', async () => {
  const time = fakeTime(T0);
  const hash = `0x${'ef'.repeat(32)}`;
  const stub = stubFetch((call) => (call.url.endsWith('/exchange')
    ? { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.004', avgPx: '2501', oid: 5 } }] } } }
    : [{ coin: 'ETH', px: '2501', sz: '0.004', side: 'B', time: T0, hash, oid: 5 }]));
  const contract = testContract(time.now);
  const relayer = new Relayer({
    contract, deskId: 'alpha',
    hyperliquid: new HyperliquidSubmitter({ network: 'testnet', fetch: stub.fetch, clock: time.clock, sleep: time.sleep }),
  });
  const result = await relayer.hlOrder({ asset: 1, is_buy: true, px: '2510', sz: '0.004', reduce_only: false, tif: 'Ioc', cloid: null }, 'enter');
  assert.deepEqual(result.tx.map((t) => t.id), [hash]);
  assert.deepEqual(contract.calls.map((c) => c.method), ['hl_order']);
  await assert.rejects(new Relayer({ contract, deskId: 'alpha' }).hlCancel(1, 5, 'x'), /no Hyperliquid submitter/);
});

test('orderlyRequest: the four orderly-* headers of orderly.json, then Orderly data', async () => {
  const v = vectors('orderly');
  const r = v.requests[0];
  const contract = testContract(() => r.timestamp, { orderlyBrokerId: v.networks.testnet.brokerId, orderlyChainId: v.networks.testnet.chainId });
  contract.setDesk('alpha', testDesk({ evm_address: v.keys.deskEvm.address }));
  const stub = stubFetch(() => ({ success: true, data: { order_id: 991, client_order_id: 'gimbal-alpha-1' } }));
  const relayer = new Relayer({
    contract, deskId: 'alpha',
    orderly: { apiUrl: v.networks.testnet.api, accountId: r.headers['orderly-account-id'], orderlyKey: r.headers['orderly-key'], fetch: stub.fetch, now: () => r.timestamp },
  });
  // The contract derives client_order_id from its request_id: the engine never sends one, and reads it back.
  const { kind, client_order_id: derived, ...fields } = r.request;
  await assert.rejects(relayer.orderlyRequest(kind, { ...fields, client_order_id: derived }, 'hedge'), /do not pass one/);
  const out = await relayer.orderlyRequest<{ order_id: number }>(kind, fields, 'hedge');
  assert.equal(out.data.order_id, 991);
  assert.equal(out.clientOrderId, derived);
  assert.equal((contract.calls.at(-1)!.args as { req: Record<string, unknown> }).req.client_order_id, undefined);
  const call = stub.calls[0]!;
  assert.equal(call.url, r.url);
  assert.equal(call.method, 'POST');
  assert.equal(call.body, r.body);
  for (const h of ['orderly-timestamp', 'orderly-account-id', 'orderly-key', 'orderly-signature']) assert.equal(call.headers[h], r.headers[h], h);
});

test('orderlyRequest order: no answer, a 5xx or a body that is not JSON is OutcomeUnknown with the client_order_id; a refusal stays OrderlyApiError', async () => {
  const v = vectors('orderly');
  const r = v.requests[0];
  const { kind, client_order_id: derived, ...fields } = r.request;
  const answers: [string, () => Response | never][] = [
    ['timeout', () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }],
    ['dropped', () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }],
    ['502', () => new Response('<html>Bad Gateway</html>', { status: 502 })],
    ['500 json', () => new Response(JSON.stringify({ success: false, code: -1000, message: 'internal' }), { status: 500 })],
    ['200 not json', () => new Response('ok', { status: 200 })],
  ];
  const relayerWith = (answer: () => Response) => {
    const contract = testContract(() => r.timestamp, { orderlyBrokerId: v.networks.testnet.brokerId, orderlyChainId: v.networks.testnet.chainId });
    contract.setDesk('alpha', testDesk({ evm_address: v.keys.deskEvm.address }));
    const f = (async () => answer()) as unknown as typeof fetch;
    return new Relayer({
      contract, deskId: 'alpha',
      orderly: { apiUrl: v.networks.testnet.api, accountId: r.headers['orderly-account-id'], orderlyKey: r.headers['orderly-key'], fetch: f, now: () => r.timestamp },
    });
  };
  for (const [name, answer] of answers) {
    await assert.rejects(relayerWith(answer).orderlyRequest(kind, fields, 'hedge'), (err: unknown) => {
      assert.ok(err instanceof OutcomeUnknown, `${name}: ${String(err)}`);
      assert.equal(err.what, 'orderly order');
      assert.equal(err.ids.orderlyClientOrderId, derived, name);
      assert.match(err.message, /may have taken the request/);
      return true;
    });
  }
  // Orderly's own refusal, under a 4xx or a 200: nothing was taken, OrderlyApiError as before.
  for (const status of [400, 200]) {
    const refused = () => new Response(JSON.stringify({ success: false, code: -1102, message: 'quantity too small' }), { status });
    await assert.rejects(relayerWith(refused).orderlyRequest(kind, fields, 'hedge'), (err: unknown) => {
      assert.ok(err instanceof OrderlyApiError && !(err instanceof OutcomeUnknown), String(err));
      assert.equal(err.code, -1102);
      return true;
    });
  }
});

test('solSign: after an MPC timeout the message is built again with a fresh blockhash and signed once more', async () => {
  const sol = vectors('solana');
  const ioc = sol.cases.find((c: { name: string }) => c.name.startsWith('IOC buy 0.005 ETH'));
  const time = fakeTime(T0);
  const contract = testContract(time.now);
  let timeouts = 1;
  const flaky: ContractClient = Object.assign(Object.create(contract) as ContractClient, {
    getDesk: (deskId: string) => contract.getDesk(deskId),
    solSign: async (deskId: string, messageB64: string, reason: string) => {
      if (timeouts-- > 0) throw new MpcTimeoutError('sol_sign', 'Request has timed out', null);
      return contract.solSign(deskId, messageB64, reason);
    },
  });
  const rpc = stubFetch((call) => {
    const { id, method } = call.json as { id: number; method: string };
    // Height 101 > lastValidBlockHeight 100: the first message's blockhash is proven expired.
    const result = method === 'getSignatureStatuses' ? { value: [{ err: null, confirmationStatus: 'confirmed' }] } : method === 'getBlockHeight' ? 101 : 'sig';
    return { jsonrpc: '2.0', id, result };
  });
  let builds = 0;
  const relayer = new Relayer({
    contract: flaky, deskId: 'alpha',
    solana: new SolanaSubmitter({ rpcUrl: 'https://rpc.example', network: 'testnet', fetch: rpc.fetch, sleep: time.sleep, now: time.now }),
  });
  const tx = await relayer.solSign(async () => {
    builds++;
    return { messageB64: Buffer.from(ioc.message_hex, 'hex').toString('base64'), lastValidBlockHeight: 100 };
  }, 'enter');
  assert.equal(builds, 2);
  assert.equal(tx.length, 1);
  assert.equal(tx[0]!.chain, 'solana');
  // A second timeout in a row is the caller's to see.
  timeouts = 2;
  const message = Buffer.from(ioc.message_hex, 'hex').toString('base64');
  await assert.rejects(relayer.solSign(async () => ({ messageB64: message, lastValidBlockHeight: 100 }), 'enter'), MpcTimeoutError);
  // Without lastValidBlockHeight the first blockhash is never proven expired: OutcomeUnknown, no second signature.
  timeouts = 1;
  builds = 0;
  await assert.rejects(relayer.solSign(async () => { builds++; return { messageB64: message }; }, 'enter'), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    assert.match(err.message, /not proven expired \(no lastValidBlockHeight\)/);
    return true;
  });
  assert.equal(builds, 1);
});

test('solSign: a contract that signed another message than the one built, or for another fee payer, sends nothing', async () => {
  const sol = vectors('solana');
  const ioc = sol.cases.find((c: { name: string }) => c.name.startsWith('IOC buy 0.005 ETH'));
  const time = fakeTime(T0);
  const contract = testContract(time.now);
  const message = Buffer.from(ioc.message_hex, 'hex');
  const other = Buffer.from(message);
  other[other.length - 1] ^= 1;
  const swapped: ContractClient = Object.assign(Object.create(contract) as ContractClient, {
    getDesk: (deskId: string) => contract.getDesk(deskId),
    solSign: (deskId: string, _m: string, reason: string) => contract.solSign(deskId, other.toString('base64'), reason),
  });
  const rpc = stubFetch(() => ({ jsonrpc: '2.0', id: 1, result: 'sig' }));
  const solana = new SolanaSubmitter({ rpcUrl: 'https://rpc.example', network: 'testnet', fetch: rpc.fetch, sleep: time.sleep, now: time.now });
  const relayer = new Relayer({ contract: swapped, deskId: 'alpha', solana });
  await assert.rejects(relayer.solSign(async () => ({ messageB64: message.toString('base64'), lastValidBlockHeight: 100 }), 'enter'), /signed a different message .* nothing sent/);
  // get_desk names another authority than the message's fee payer.
  const elsewhere: ContractClient = Object.assign(Object.create(contract) as ContractClient, {
    getDesk: async () => testDesk({ solana: { ...testDesk().solana, authority: '11111111111111111111111111111111' } }),
    solSign: (deskId: string, m: string, reason: string) => contract.solSign(deskId, m, reason),
  });
  const strict = new Relayer({ contract: elsewhere, deskId: 'alpha', solana });
  await assert.rejects(strict.solSign(async () => ({ messageB64: message.toString('base64'), lastValidBlockHeight: 100 }), 'enter'), /not the desk authority .* nothing sent/);
  assert.equal(rpc.calls.length, 0);
});

test('hlOrder: every order gets a cloid, and an unknown outcome names it', async () => {
  const time = fakeTime(T0);
  const contract = testContract(time.now);
  const stub = stubFetch(() => { throw new TypeError('fetch failed'); });
  const relayer = new Relayer({
    contract, deskId: 'alpha',
    hyperliquid: new HyperliquidSubmitter({ network: 'testnet', fetch: stub.fetch, clock: time.clock, sleep: time.sleep }),
  });
  await assert.rejects(relayer.hlOrder({ asset: 1, is_buy: true, px: '2510', sz: '0.004', reduce_only: false, tif: 'Ioc', cloid: null }, 'enter'), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    const sent = (contract.calls[0]!.args as { order: { cloid: string } }).order.cloid;
    assert.match(sent, /^0x[0-9a-f]{32}$/);
    assert.equal(err.ids.hlCloid, sent);
    return true;
  });
  // The contract side failing the same way still names the cloid the relayer chose.
  const lost: ContractClient = Object.assign(Object.create(contract) as ContractClient, {
    hlOrder: async () => { throw new OutcomeUnknown('hl_order', 'no final outcome', { nearTx: 'h1' }); },
  });
  const cloid = '0x0123456789abcdef0123456789abcdef';
  await assert.rejects(new Relayer({ contract: lost, deskId: 'alpha' }).hlOrder({ asset: 1, is_buy: true, px: '2510', sz: '0.004', reduce_only: false, tif: 'Ioc', cloid }, 'enter'),
    (err: unknown) => err instanceof OutcomeUnknown && err.ids.hlCloid === cloid && err.ids.nearTx === 'h1');
});
