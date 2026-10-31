// The Solana submitter with solana.json messages the replay contract signed with the public desk seed, against a
// stub JSON-RPC: rebroadcast until confirmed, expiry and on-chain failure as NothingExecuted, and what is never sent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519Sign } from '../contract/replay-client.ts';
import type { SolSignedAction } from '../contract/types.ts';
import { base58 } from '../venues/orderly-signer.ts';
import {
  COMPUTE_BUDGET_PROGRAM, SOLANA_COMPUTE_UNITS, SOLANA_PRIORITY_MICROLAMPORTS, SolanaSubmitter, base58Decode,
  computeBudgetInstructions, parseMessage,
} from './solana.ts';
import { TEST_SOL_AUTHORITY, TEST_SOL_SEED, fakeTime, stubFetch, testContract, vectors } from './test-helpers.ts';
import { NothingExecuted } from './tx.ts';

const SOL = vectors('solana');
const IOC_BUY = SOL.cases.find((c: { name: string }) => c.name.startsWith('IOC buy 0.005 ETH'));
const T0 = 1_793_491_200_000;

async function signedIoc(): Promise<SolSignedAction> {
  const contract = testContract(() => T0);
  return contract.solSign('alpha', Buffer.from(IOC_BUY.message_hex, 'hex').toString('base64'), 'enter');
}

/** A JSON-RPC stub: `statuses` answers getSignatureStatuses in turn (the last one repeats). */
function rpc(options: { statuses: unknown[]; blockhashValid?: boolean[]; blockHeight?: number }) {
  let s = 0;
  let b = 0;
  const stub = stubFetch((call) => {
    const { id, method } = call.json as { id: number; method: string };
    const result = (() => {
      switch (method) {
        case 'sendTransaction': return 'sig';
        case 'getSignatureStatuses': return { context: { slot: 1 }, value: [options.statuses[Math.min(s++, options.statuses.length - 1)]] };
        case 'isBlockhashValid': return { context: { slot: 1 }, value: options.blockhashValid?.[Math.min(b++, options.blockhashValid.length - 1)] ?? true };
        case 'getBlockHeight': return options.blockHeight ?? 0;
        default: throw new Error(`unexpected ${method}`);
      }
    })();
    return { jsonrpc: '2.0', id, result };
  });
  const methods = () => stub.calls.map((c) => (c.json as { method: string }).method);
  return { ...stub, methods };
}

function submitter(fetchStub: typeof fetch) {
  const time = fakeTime(T0);
  return new SolanaSubmitter({ rpcUrl: 'https://rpc.example', network: 'testnet', fetch: fetchStub, sleep: time.sleep, now: time.now });
}

test('the desk transaction: compute budget first, keys[0] the desk authority, a signature that verifies', async () => {
  const [limit, price] = computeBudgetInstructions();
  assert.equal(limit!.programAddress, COMPUTE_BUDGET_PROGRAM);
  assert.deepEqual([...limit!.data], [2, ...Buffer.from(Uint32Array.of(SOLANA_COMPUTE_UNITS).buffer)]);
  assert.equal(Buffer.from(price!.data).readBigUInt64LE(1), BigInt(SOLANA_PRIORITY_MICROLAMPORTS));
  const parsed = parseMessage(Buffer.from(IOC_BUY.message_hex, 'hex'));
  assert.equal(parsed.version, 'legacy');
  assert.equal(parsed.signers, 1);
  assert.equal(parsed.keys[0], TEST_SOL_AUTHORITY);
  assert.equal(parsed.blockhash, SOL.recent_blockhash);
  assert.ok(parsed.computeUnitLimit !== null && parsed.computeUnitPrice !== null && parsed.computeUnitPrice > 0n);
  const signed = await signedIoc();
  const { bytes, signature } = SolanaSubmitter.transaction(signed);
  assert.equal(bytes[0], 1);
  assert.equal(bytes.length, 1 + 64 + IOC_BUY.message_hex.length / 2);
  assert.equal(base58(base58Decode(signature)), signature);
});

test('sent with skipPreflight, rebroadcast every 2 s until confirmed, then returned as its solscan link', async () => {
  const r = rpc({ statuses: [null, { err: null, confirmationStatus: 'processed' }, { err: null, confirmationStatus: 'confirmed' }] });
  const signed = await signedIoc();
  const tx = await submitter(r.fetch).submit(signed);
  const { signature } = SolanaSubmitter.transaction(signed);
  assert.deepEqual(tx, [{ chain: 'solana', id: signature, url: `https://solscan.io/tx/${signature}?cluster=devnet` }]);
  assert.deepEqual(r.methods().filter((m) => m === 'sendTransaction').length, 3);
  const first = r.calls[0]!.json as { params: [string, Record<string, unknown>] };
  assert.deepEqual(first.params[1], { encoding: 'base64', skipPreflight: true, maxRetries: 0 });
  assert.equal(Buffer.from(first.params[0], 'base64').subarray(65).toString('hex'), IOC_BUY.message_hex);
});

test('a blockhash that expires before the transaction lands: nothing executed', async () => {
  const r = rpc({ statuses: [null], blockhashValid: [true, true, false] });
  await assert.rejects(submitter(r.fetch).submit(await signedIoc()), (err: unknown) => {
    assert.ok(err instanceof NothingExecuted);
    assert.match(err.message, /solana: nothing executed: the blockhash expired before it landed/);
    return true;
  });
  assert.equal(r.methods().filter((m) => m === 'sendTransaction').length, 3);
  // With lastValidBlockHeight the block height decides.
  const h = rpc({ statuses: [null], blockHeight: 1001 });
  await assert.rejects(submitter(h.fetch).submit(await signedIoc(), { lastValidBlockHeight: 1000 }), NothingExecuted);
  assert.ok(h.methods().includes('getBlockHeight') && !h.methods().includes('isBlockhashValid'));
});

test('a transaction that failed on chain is NothingExecuted and still points at the transaction', async () => {
  const r = rpc({ statuses: [{ err: { InstructionError: [2, { Custom: 1 }] }, confirmationStatus: 'confirmed' }] });
  await assert.rejects(submitter(r.fetch).submit(await signedIoc()), (err: unknown) => {
    assert.ok(err instanceof NothingExecuted);
    assert.match(err.message, /failed on chain: \{"InstructionError"/);
    assert.equal(err.tx.length, 1);
    return true;
  });
});

test('never sent: a signature that does not verify, a message without a compute budget, two signers', async () => {
  const r = rpc({ statuses: [null] });
  const s = submitter(r.fetch);
  const signed = await signedIoc();
  const bad = { ...signed, signature: { ...signed.signature, signature: signed.signature.signature.map((b, i) => (i === 0 ? b ^ 1 : b)) } };
  await assert.rejects(s.submit(bad), /does not verify .* nothing sent/);

  // A legacy message with one System transfer and no compute-budget instructions.
  const authority = base58Decode(TEST_SOL_AUTHORITY);
  const system = Buffer.alloc(32);
  const message = Buffer.concat([
    Buffer.from([1, 0, 1, 2]), authority, system, base58Decode(SOL.recent_blockhash),
    Buffer.from([1, 1, 1, 0, 12, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
  ]);
  const noBudget: SolSignedAction = {
    desk_id: 'alpha', request_id: 1, venue: 'phoenix', kind: 'transaction', payload: { message_b64: message.toString('base64') },
    signature: { scheme: 'Ed25519', signature: [...ed25519Sign(TEST_SOL_SEED, message)] },
  };
  assert.equal(parseMessage(message).computeUnitLimit, null);
  await assert.rejects(s.submit(noBudget), /no compute-unit limit and priority fee/);

  const twoSigners = Buffer.from(message);
  twoSigners[0] = 2;
  await assert.rejects(s.submit({ ...noBudget, payload: { message_b64: twoSigners.toString('base64') } }), /needs 2 signatures/);
  assert.equal(r.calls.length, 0);
});
