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
  assert.deepEqual(await reads.signatureStatus('landed'), { known: true, slot: 380_000_510, failed: false });
  assert.deepEqual(await reads.signatureStatus('never'), { known: false, slot: 380_000_510, failed: false });
  assert.deepEqual(asked[0], { method: 'getEpochInfo', params: [{ commitment: 'finalized' }] });
  assert.deepEqual(asked[2], { method: 'getSignatureStatuses', params: [['never'], { searchTransactionHistory: true }] });
  const { reads: noSlot } = rpc(() => ({ body: { result: { value: [null] } } }));
  assert.deepEqual(await noSlot.signatureStatus('x'), { known: false, slot: null, failed: false }, 'no context: no slot (no proof)');
});

test('the live reader: a signature finalized with an error is failed (it can never run again); a failure not yet finalized is not', async () => {
  const { reads } = rpc((_method, params) => {
    const sig = (params[0] as string[])[0];
    const v = sig === 'final-err' ? { slot: 9, confirmationStatus: 'finalized', err: { InstructionError: [2, { Custom: 1 }] } }
      : sig === 'confirmed-err' ? { slot: 9, confirmationStatus: 'confirmed', err: { InstructionError: [2, { Custom: 1 }] } }
      : sig === 'no-err-key' ? { slot: 9, confirmationStatus: 'finalized' }
      : null;
    return { body: { result: { context: { slot: 500 }, value: [v] } } };
  });
  assert.deepEqual(await reads.signatureStatus('final-err'), { known: true, slot: 500, failed: true });
  assert.deepEqual(await reads.signatureStatus('confirmed-err'), { known: true, slot: 500, failed: false });
  await assert.rejects(reads.signatureStatus('no-err-key'), /a status without err/);
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
  assert.deepEqual(await sol.signatureStatus('s'), { known: false, slot: 978, failed: false });
  sol.land('s');
  assert.equal((await sol.signatureStatus('s')).known, true);
  sol.statusLag = -3;
  assert.equal((await sol.signatureStatus('s')).slot, 975);
  sol.down = 'solana rpc: 503';
  await assert.rejects(sol.finalized(), /503/);
  await assert.rejects(sol.signatureStatus('s'), /503/);
});

test('the history probe: an old signature of the probe address found with searchTransactionHistory, else the reason', async () => {
  const world = (opts: { known: boolean; pages: number[][] }) => rpc((method, params) => {
    if (method === 'getEpochInfo') return { body: { result: { absoluteSlot: 400_000_000, blockHeight: 380_000_000 } } };
    if (method === 'getSignaturesForAddress') {
      const before = (params[1] as { before?: string }).before;
      const page = opts.pages[before === undefined ? 0 : Number(before.slice(1)) + 1] ?? [];
      return { body: { result: page.map((slot, i) => ({ signature: `p${before === undefined ? 0 : Number(before.slice(1)) + 1}-${i}`, slot })).map((x, i, all) => (i === all.length - 1 ? { ...x, signature: `p${before === undefined ? 0 : Number(before.slice(1)) + 1}` } : x)) } };
    }
    return { body: { result: { context: { slot: 400_000_001 }, value: [opts.known ? { slot: 1, err: null } : null] } } };
  });
  const ok = world({ known: true, pages: [[399_999_990, 399_000_000]] });
  assert.equal(await ok.reads.historyProblem(), null);
  assert.deepEqual(ok.asked[1]!.params, ['3c3NTwpg7yW91FxijkHBXwVH1xUifun3Z8TC5eW5Si3K', { limit: 1000, commitment: 'finalized' }]);
  assert.deepEqual(ok.asked[2], { method: 'getSignatureStatuses', params: [['p0'], { searchTransactionHistory: true }] });
  // A node with only its recent status cache: the old signature is not found.
  assert.match((await world({ known: false, pages: [[399_000_000]] }).reads.historyProblem())!, /does not find p0 \(1000000 slots old\): this RPC serves no transaction history/);
  // The first page is all recent: the next page (before its oldest) is read.
  const paged = world({ known: true, pages: [[399_999_999], [399_000_000]] });
  assert.equal(await paged.reads.historyProblem(), null);
  assert.deepEqual(paged.asked[2]!.params, ['3c3NTwpg7yW91FxijkHBXwVH1xUifun3Z8TC5eW5Si3K', { limit: 1000, commitment: 'finalized', before: 'p0' }]);
  assert.match((await world({ known: true, pages: [[399_999_999], [399_999_998], [399_999_997]] }).reads.historyProblem())!, /could not be probed/);
  assert.match((await world({ known: true, pages: [] }).reads.historyProblem())!, /gave no signatures/);
  const down = rpc(() => ({ status: 503, body: {} }));
  assert.match((await down.reads.historyProblem())!, /the history probe failed: getEpochInfo: HTTP 503/);
});
