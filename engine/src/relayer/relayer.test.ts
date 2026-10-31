// The relayer end to end over the replay contract and stubbed venues: one call signs and delivers, the Orderly
// headers match orderly.json, and a Solana message is built again after an MPC timeout (its blockhash is stale).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContractClient } from '../contract/types.ts';
import { MpcTimeoutError } from '../contract/types.ts';
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
  const { kind, ...fields } = r.request;
  const out = await relayer.orderlyRequest<{ order_id: number }>(kind, fields, 'hedge');
  assert.equal(out.data.order_id, 991);
  const call = stub.calls[0]!;
  assert.equal(call.url, r.url);
  assert.equal(call.method, 'POST');
  assert.equal(call.body, r.body);
  for (const h of ['orderly-timestamp', 'orderly-account-id', 'orderly-key', 'orderly-signature']) assert.equal(call.headers[h], r.headers[h], h);
});

test('solSign: after an MPC timeout the message is built again with a fresh blockhash and signed once more', async () => {
  const sol = vectors('solana');
  const ioc = sol.cases.find((c: { name: string }) => c.name.startsWith('IOC buy 0.005 ETH'));
  const time = fakeTime(T0);
  const contract = testContract(time.now);
  let timeouts = 1;
  const flaky: ContractClient = Object.assign(Object.create(contract) as ContractClient, {
    solSign: async (deskId: string, messageB64: string, reason: string) => {
      if (timeouts-- > 0) throw new MpcTimeoutError('sol_sign', 'Request has timed out', null);
      return contract.solSign(deskId, messageB64, reason);
    },
  });
  const rpc = stubFetch((call) => {
    const { id, method } = call.json as { id: number; method: string };
    const result = method === 'getSignatureStatuses' ? { value: [{ err: null, confirmationStatus: 'confirmed' }] } : method === 'getBlockHeight' ? 10 : 'sig';
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
  await assert.rejects(relayer.solSign(async () => ({ messageB64: Buffer.from(ioc.message_hex, 'hex').toString('base64') }), 'enter'), MpcTimeoutError);
});
