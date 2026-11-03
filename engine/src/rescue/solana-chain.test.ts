// The Solana reads behind a sol_sign_rescue's release: the live reader's two JSON-RPC calls on a fake fetch (what it
// asks, the answers it takes with their slots, and every other answer an error with the URL redacted), and the
// simulated cluster.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RpcSolanaReads, SimulatedSolana } from './solana-chain.ts';

const URL = 'https://solana.example/rpc?api-key=placeholder-key';

function rpc(answer: (method: string, params: unknown[]) => { status?: number; body: unknown }) {
  const asked: { method: string; params: unknown[] }[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { method: string; params: unknown[] };
    asked.push({ method: req.method, params: req.params });
    const a = answer(req.method, req.params);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { reads: new RpcSolanaReads({ rpcUrl: URL, fetch: fetchImpl }), asked };
}

test('the live reader: the finalized height with its slot, and a signature searched in the history with the slot it was read at', async () => {
  const { reads, asked } = rpc((method, params) => {
    if (method === 'getEpochInfo') return { body: { jsonrpc: '2.0', id: 1, result: { absoluteSlot: 380_000_500, blockHeight: 350_000_123, epoch: 880, slotIndex: 1, slotsInEpoch: 432_000 } } };
    const sig = (params[0] as string[])[0];
    return { body: { jsonrpc: '2.0', id: 2, result: { context: { slot: 380_000_510 }, value: [sig === 'landed' ? { slot: 9, confirmationStatus: 'finalized', err: null } : null] } } };
  });
  assert.deepEqual(await reads.finalized(), { height: 350_000_123, slot: 380_000_500 });
  assert.deepEqual(await reads.signatureStatus('landed'), { known: true, slot: 380_000_510 });
  assert.deepEqual(await reads.signatureStatus('never'), { known: false, slot: 380_000_510 });
  assert.deepEqual(asked[0], { method: 'getEpochInfo', params: [{ commitment: 'finalized' }] });
  assert.deepEqual(asked[2], { method: 'getSignatureStatuses', params: [['never'], { searchTransactionHistory: true }] });
  const { reads: noSlot } = rpc(() => ({ body: { result: { value: [null] } } }));
  assert.deepEqual(await noSlot.signatureStatus('x'), { known: false, slot: null }, 'no context: no slot (no proof)');
});

test('the live reader: an HTTP error, an RPC error or an answer of another shape is an error, never a height or "unknown"; the URL is redacted', async () => {
  const cases: [string, (method: string) => { status?: number; body: unknown }, RegExp][] = [
    ['HTTP 429', () => ({ status: 429, body: {} }), /HTTP 429/],
    ['an RPC error', () => ({ body: { error: { code: -32005, message: 'node is behind' } } }), /node is behind/],
    ['no height', (m) => ({ body: { result: m === 'getEpochInfo' ? { blockHeight: 'high', absoluteSlot: 1 } : { value: [] } } }), /not a block height|not one status/],
  ];
  for (const [name, answer, why] of cases) {
    const { reads } = rpc(answer);
    await assert.rejects(reads.finalized(), why, name);
    await assert.rejects(reads.signatureStatus('x'), (err: Error) => why.test(err.message) && !err.message.includes('placeholder-key'), name);
  }
  const { reads } = rpc(() => ({ body: { result: { value: [null, null] } } }));
  await assert.rejects(reads.signatureStatus('x'), /not one status/);
});

test('the simulated cluster: the height grows with the clock (finalized 32 behind), a landed signature is known, `down` fails every read', async () => {
  let now = 400_000;
  const sol = new SimulatedSolana({ now: () => now });
  assert.equal(sol.heightNow(), 1_000);
  assert.deepEqual(await sol.finalized(), { height: 968, slot: 968 });
  now += 4_000;
  assert.equal((await sol.finalized()).height, 978);
  assert.deepEqual(await sol.signatureStatus('s'), { known: false, slot: 978 });
  sol.land('s');
  assert.equal((await sol.signatureStatus('s')).known, true);
  sol.statusLag = -3;
  assert.equal((await sol.signatureStatus('s')).slot, 975);
  sol.down = 'solana rpc: 503';
  await assert.rejects(sol.finalized(), /503/);
  await assert.rejects(sol.signatureStatus('s'), /503/);
});
