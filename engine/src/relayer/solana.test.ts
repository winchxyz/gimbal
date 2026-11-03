// The Solana submitter with solana.json messages the replay contract signed with the public desk seed, against a
// stub JSON-RPC: rebroadcast until confirmed; NothingExecuted only for a proven expiry or an on-chain failure, every
// RPC failure, a lookup from a lagging node or a run out of time as OutcomeUnknown with the signature; and what is
// never sent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519Sign } from '../contract/replay-client.ts';
import type { SolSignedAction } from '../contract/types.ts';
import { OutcomeUnknown } from '../contract/types.ts';
import { base58 } from '../venues/orderly-signer.ts';
import {
  COMPUTE_BUDGET_PROGRAM, SOLANA_COMPUTE_UNITS, SOLANA_PRIORITY_MICROLAMPORTS, SolanaSubmitter, base58Decode,
  computeBudgetInstructions, parseMessage,
} from './solana.ts';
import { TEST_SOL_AUTHORITY, TEST_SOL_SEED, fakeTime, stubFetch, testContract, vectors } from './test-helpers.ts';
import { asSolInstructions, compileLegacyMessage, tokenRevoke } from './solana-message.ts';
import { NothingExecuted } from './tx.ts';

const SOL = vectors('solana');
const IOC_BUY = SOL.cases.find((c: { name: string }) => c.name.startsWith('IOC buy 0.005 ETH'));
const T0 = 1_793_491_200_000;

async function signedIoc(): Promise<SolSignedAction> {
  const contract = testContract(() => T0);
  return contract.solSign('alpha', Buffer.from(IOC_BUY.message_hex, 'hex').toString('base64'), 'enter');
}

/**
 * A JSON-RPC stub: `statuses` answers getSignatureStatuses in turn (the last one repeats), read at `statusSlot`;
 * getEpochInfo answers `blockHeight` at `slot`; `fail` answers a method with HTTP 429 (when it returns true for that
 * call's params).
 */
function rpc(options: {
  statuses: unknown[]; blockhashValid?: boolean[]; blockHeight?: number; slot?: number; statusSlot?: number;
  fail?: Record<string, (params: unknown[]) => boolean>;
}) {
  let s = 0;
  let b = 0;
  const stub = stubFetch((call) => {
    const { id, method, params } = call.json as { id: number; method: string; params: unknown[] };
    if (options.fail?.[method]?.(params) === true) return new Response('Too Many Requests', { status: 429 });
    const result = (() => {
      switch (method) {
        case 'sendTransaction': return 'sig';
        case 'getSignatureStatuses': return { context: { slot: options.statusSlot ?? options.slot ?? 1 }, value: [options.statuses[Math.min(s++, options.statuses.length - 1)]] };
        case 'isBlockhashValid': return { context: { slot: 1 }, value: options.blockhashValid?.[Math.min(b++, options.blockhashValid.length - 1)] ?? true };
        case 'getEpochInfo': return { absoluteSlot: options.slot ?? 1, blockHeight: options.blockHeight ?? 0, epoch: 1, slotIndex: 0, slotsInEpoch: 432_000 };
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

test('NothingExecuted only for a proven expiry: past lastValidBlockHeight, and a history lookup that found nothing', async () => {
  const h = rpc({ statuses: [null], blockHeight: 1001 });
  const signed = await signedIoc();
  await assert.rejects(submitter(h.fetch).submit(signed, { lastValidBlockHeight: 1000 }), (err: unknown) => {
    assert.ok(err instanceof NothingExecuted);
    assert.match(err.message, /past lastValidBlockHeight 1000\) and the signature is not on chain/);
    return true;
  });
  const lookups = h.calls.map((c) => c.json as { method: string; params: unknown[] }).filter((c) => c.method === 'getSignatureStatuses');
  assert.deepEqual(lookups.at(-1)!.params[1], { searchTransactionHistory: true });
  assert.ok(!h.methods().includes('isBlockhashValid'));
  // Not there yet: rebroadcast, and once the height passes, the same verdict.
  let height = 990;
  const later = stubFetch((call) => {
    const { id, method } = call.json as { id: number; method: string };
    const result = method === 'getEpochInfo' ? { absoluteSlot: 7, blockHeight: (height += 5) } : method === 'getSignatureStatuses' ? { context: { slot: 7 }, value: [null] } : 'sig';
    return { jsonrpc: '2.0', id, result };
  });
  await assert.rejects(submitter(later.fetch).submit(signed, { lastValidBlockHeight: 1000 }), NothingExecuted);
  assert.equal(later.calls.filter((c) => (c.json as { method: string }).method === 'sendTransaction').length, 3);
});

test('an RPC 429 on the status reads is OutcomeUnknown with the signature, never NothingExecuted', async () => {
  const signed = await signedIoc();
  const { signature } = SolanaSubmitter.transaction(signed);
  const r = rpc({ statuses: [null], blockHeight: 1001, fail: { getSignatureStatuses: () => true } });
  await assert.rejects(submitter(r.fetch).submit(signed, { lastValidBlockHeight: 1000 }), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    assert.equal(err.ids.solSignature, signature);
    assert.match(err.message, /HTTP 429/);
    assert.equal(err.tx.at(-1)?.id, signature);
    return true;
  });
  // The block height read failing is no proof of expiry either.
  const noHeight = rpc({ statuses: [null], fail: { getEpochInfo: () => true } });
  await assert.rejects(submitter(noHeight.fetch).submit(signed, { lastValidBlockHeight: 1000 }), OutcomeUnknown);
});

test('a failed history lookup after the blockhash expired is OutcomeUnknown', async () => {
  const signed = await signedIoc();
  const history = (params: unknown[]) => (params[1] as { searchTransactionHistory?: boolean })?.searchTransactionHistory === true;
  const r = rpc({ statuses: [null], blockHeight: 1001, fail: { getSignatureStatuses: history } });
  await assert.rejects(submitter(r.fetch).submit(signed, { lastValidBlockHeight: 1000 }), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    assert.match(err.message, /no proof either way/);
    return true;
  });
});

test('an empty history lookup from a node behind the height read proves nothing (a load balancer, a lagging node)', async () => {
  const signed = await signedIoc();
  const { signature } = SolanaSubmitter.transaction(signed);
  // The height passed lastValidBlockHeight at slot 500, the lookup answered at slot 480: OutcomeUnknown.
  const lagging = rpc({ statuses: [null], blockHeight: 1001, slot: 500, statusSlot: 480 });
  await assert.rejects(submitter(lagging.fetch).submit(signed, { lastValidBlockHeight: 1000 }), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    assert.equal(err.ids.solSignature, signature);
    assert.match(err.message, /answered at slot 480, behind slot 500 .*a lagging node/);
    return true;
  });
  // No context slot on the lookup: no proof either.
  const noContext = stubFetch((call) => {
    const { id, method } = call.json as { id: number; method: string };
    const result = method === 'getEpochInfo' ? { absoluteSlot: 500, blockHeight: 1001 } : method === 'getSignatureStatuses' ? { value: [null] } : 'sig';
    return { jsonrpc: '2.0', id, result };
  });
  await assert.rejects(submitter(noContext.fetch).submit(signed, { lastValidBlockHeight: 1000 }), OutcomeUnknown);
  // A lookup at the same slot or later is the proof.
  const caughtUp = rpc({ statuses: [null], blockHeight: 1001, slot: 500, statusSlot: 500 });
  await assert.rejects(submitter(caughtUp.fetch).submit(signed, { lastValidBlockHeight: 1000 }), NothingExecuted);
});

test('maxWaitMs reached without proof: OutcomeUnknown, also when the RPC only says the blockhash is invalid', async () => {
  const signed = await signedIoc();
  const pending = rpc({ statuses: [{ err: null, confirmationStatus: 'processed' }], blockHeight: 10 });
  await assert.rejects(submitter(pending.fetch).submit(signed, { lastValidBlockHeight: 1000 }), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    assert.match(err.message, /no proof either way after 150 s/);
    return true;
  });
  // Without lastValidBlockHeight, isBlockhashValid false plus an empty lookup is a hint, not proof.
  const hint = rpc({ statuses: [null], blockhashValid: [true, false] });
  await assert.rejects(submitter(hint.fetch).submit(signed), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    assert.match(err.message, /without lastValidBlockHeight that is no proof/);
    return true;
  });
});

test('a paused desk\'s rescue goes without a priority fee and is rebroadcast every 500 ms; nothing else goes without one', async () => {
  // A compute-unit limit and no price, as pausedRescueMessage builds it (any instruction will do for the submitter).
  const [limit] = asSolInstructions(computeBudgetInstructions());
  const message = Buffer.from(compileLegacyMessage(TEST_SOL_AUTHORITY, [limit!, tokenRevoke(SOL.desk.phusd_ata, TEST_SOL_AUTHORITY)], SOL.recent_blockhash));
  assert.deepEqual([parseMessage(message).computeUnitLimit, parseMessage(message).computeUnitPrice], [SOLANA_COMPUTE_UNITS, null]);
  const signed = (kind: string): SolSignedAction => ({
    desk_id: 'alpha', request_id: 1, venue: 'phoenix', kind, payload: { message_b64: message.toString('base64') },
    signature: { scheme: 'Ed25519', signature: [...ed25519Sign(TEST_SOL_SEED, message)] },
  });
  const sleeps: number[] = [];
  const time = fakeTime(T0);
  const s = (f: typeof fetch) => new SolanaSubmitter({
    rpcUrl: 'https://rpc.example', network: 'testnet', fetch: f, now: time.now,
    sleep: async (ms) => { sleeps.push(ms); await time.sleep(ms); },
  });
  const r = rpc({ statuses: [null, null, { err: null, confirmationStatus: 'confirmed' }] });
  const tx = await s(r.fetch).submit(signed('rescue'));
  assert.equal(tx.length, 1);
  assert.equal(r.methods().filter((m) => m === 'sendTransaction').length, 3);
  assert.deepEqual(sleeps, [500, 500]);

  // A fee-paying message keeps the 2 s pace.
  sleeps.length = 0;
  await s(rpc({ statuses: [null, { err: null, confirmationStatus: 'confirmed' }] }).fetch).submit(await signedIoc());
  assert.deepEqual(sleeps, [2_000]);

  const other = rpc({ statuses: [null] });
  await assert.rejects(s(other.fetch).submit(signed('transaction')), /no compute-unit limit and priority fee; public RPCs drop it, nothing sent/);
  assert.equal(other.calls.length, 0);
});

test('a fee payer other than the desk authority is never sent', async () => {
  const r = rpc({ statuses: [null] });
  await assert.rejects(submitter(r.fetch).submit(await signedIoc(), { authority: '11111111111111111111111111111111' }), /not the desk authority .* nothing sent/);
  assert.equal(r.calls.length, 0);
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

test('the slot a confirmed transaction landed in is kept (landedSlot); the slot where a height passed is returned', async () => {
  const r = rpc({ statuses: [{ err: null, confirmationStatus: 'confirmed', slot: 4242 }] });
  const signed = await signedIoc();
  const s = submitter(r.fetch);
  await s.submit(signed);
  const { signature } = SolanaSubmitter.transaction(signed);
  assert.equal(s.landedSlot(signature), 4242);
  assert.equal(s.landedSlot('other'), null);
  const past = submitter(rpc({ statuses: [null], blockHeight: 1001, slot: 5150 }).fetch);
  assert.equal(await past.waitPastLastValidHeightSlot(1000), 5150);
  assert.equal(await submitter(rpc({ statuses: [null], blockHeight: 900, slot: 5150 }).fetch).waitPastLastValidHeightSlot(1000, 10_000), null);
});
