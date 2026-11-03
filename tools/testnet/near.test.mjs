// send's nonce handling against a fake RPC: InvalidNonce signs again with a higher nonce, a timeout or no answer
// never does (the transaction is looked up by hash instead); and send returns only once the outcome is FINAL, so a
// finality-"final" read right after it sees the change. No network, no key file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { NONCE_RETRIES, RPC_URLS, actions, akNonceOf, b58encode, isInvalidNonce, send } from './near.mjs';

let keys = 0;
/** A fresh signer per test (send remembers the last nonce per key). */
function testKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { accountId: `signer-${++keys}.testnet`, publicKey: pub, publicKeyString: `ed25519:${b58encode(pub)}`, sign: (m) => sign(null, m, privateKey) };
}

const BLOCK_HASH = b58encode(Buffer.alloc(32, 7));
const outcomeAt = (final_execution_status) => ({ final_execution_status, status: { SuccessValue: Buffer.from('true').toString('base64') }, transaction_outcome: { outcome: { gas_burnt: 2_000_000_000_000 } }, receipts_outcome: [] });
const FINAL = outcomeAt('FINAL');
/** Every receipt ran, but its blocks are not final: a read with finality "final" does not see it yet. */
const OPTIMISTIC = outcomeAt('EXECUTED_OPTIMISTIC');
const rpcError = (method, error) => Object.assign(new Error(`${method}: ${JSON.stringify(error)}`), { rpc: error });
const invalidNonce = (tx, ak) => rpcError('send_tx', {
  name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: {} },
  data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: tx, ak_nonce: ak } } } },
});
const unknownTx = () => rpcError('tx', { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } });
const timeout = () => Object.assign(new Error('send_tx: TIMEOUT_ERROR'), { timeout: true });

/** The nonce inside a signed transaction (borsh: signer id, key type, 32-byte key, u64 nonce). */
function nonceOf(params) {
  const b = Buffer.from(params.signed_tx_base64, 'base64');
  return b.readBigUInt64LE(4 + b.readUInt32LE(0) + 1 + 32);
}

/** A fake RPC: the access key's nonce from `chainNonce`, send_tx and tx answers from the scripts, in order. */
function fakeRpc({ chainNonce = 5n, sends, looks = [] }) {
  const calls = [];
  const rpc = async (method, params, opts) => {
    calls.push({ method, params, opts });
    if (method === 'query') return { nonce: Number(chainNonce), block_hash: BLOCK_HASH };
    const next = method === 'send_tx' ? sends.shift() : method === 'tx' ? looks.shift() : undefined;
    if (next === undefined) throw new Error(`unexpected ${method}`);
    const answer = typeof next === 'function' ? next(params) : next;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const sent = () => calls.filter((c) => c.method === 'send_tx');
  return { rpc, calls, sent };
}

const fast = (rpc) => ({ rpc, pause: async () => {}, polls: 4, pollMs: 0 });
const ACTS = [actions.call('ping', {}, 30n, 0n)];

test('testnet RPCs: FastNEAR first, near.org as the fallback', () => {
  assert.deepEqual(RPC_URLS.slice(-2), ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']);
});

test('InvalidNonce then success: the key is read again and a new transaction signed with a higher nonce', async () => {
  const f = fakeRpc({ chainNonce: 5n, sends: [invalidNonce(6, 9), FINAL] });
  const out = await send(testKey(), 'c.testnet', ACTS, fast(f.rpc));
  const [first, second] = f.sent();
  assert.equal(f.sent().length, 2);
  assert.equal(nonceOf(first.params), 6n);
  // max(chain 5, last used 6, ak_nonce 9 from the refusal) + 1
  assert.equal(nonceOf(second.params), 10n);
  assert.equal(f.calls.filter((c) => c.method === 'query').length, 2, 'the access key is read again');
  assert.deepEqual(first.opts, { once: true }, 'send_tx is never resent by the RPC layer');
  assert.equal(out.value, true);
  assert.equal(out.failure, null);
});

test('the next transaction never reuses a nonce, even when the RPC still serves the old one', async () => {
  const key = testKey();
  const f = fakeRpc({ chainNonce: 5n, sends: [FINAL, FINAL] });
  await send(key, 'c.testnet', ACTS, fast(f.rpc));
  await send(key, 'c.testnet', ACTS, fast(f.rpc));
  assert.deepEqual(f.sent().map((c) => nonceOf(c.params)), [6n, 7n]);
});

test(`InvalidNonce is signed again at most ${NONCE_RETRIES} times`, async () => {
  const f = fakeRpc({ sends: Array.from({ length: 10 }, () => invalidNonce(6, 5)) });
  await assert.rejects(send(testKey(), 'c.testnet', ACTS, fast(f.rpc)), /InvalidNonce 4 times in a row/);
  assert.equal(f.sent().length, NONCE_RETRIES + 1);
  assert.deepEqual(f.sent().map((c) => nonceOf(c.params)), [6n, 7n, 8n, 9n], 'every retry a new nonce');
});

test('timeout then status found: the transaction is looked up by hash and never signed again', async () => {
  const f = fakeRpc({ sends: [timeout()], looks: [unknownTx(), FINAL] });
  const out = await send(testKey(), 'c.testnet', ACTS, fast(f.rpc));
  assert.equal(f.sent().length, 1);
  const looks = f.calls.filter((c) => c.method === 'tx');
  assert.equal(looks.length, 2);
  assert.ok(looks.every((c) => c.params.tx_hash === out.hash), 'looked up by the hash of the one transaction sent');
  assert.equal(out.value, true);
});

test('timeout then not found: the outcome is unknown, nothing is sent again', async () => {
  const f = fakeRpc({ sends: [timeout(), FINAL], looks: Array.from({ length: 10 }, unknownTx) });
  await assert.rejects(send(testKey(), 'c.testnet', ACTS, fast(f.rpc)), (err) => {
    assert.match(err.message, /was not found after 4 looks: its outcome is unknown, so it was not sent again/);
    assert.equal(err.unknown, true);
    assert.equal(typeof err.hash, 'string');
    return true;
  });
  assert.equal(f.sent().length, 1);
  assert.equal(f.calls.filter((c) => c.method === 'query').length, 1, 'no second signature');
});

test('no answer at all to send_tx is treated like a timeout: looked up, not resent', async () => {
  const noAnswer = Object.assign(new Error('send_tx: no answer from rpc (fetch failed): the request may have arrived'), { unknown: true });
  const f = fakeRpc({ sends: [noAnswer], looks: [FINAL] });
  const out = await send(testKey(), 'c.testnet', ACTS, fast(f.rpc));
  assert.equal(f.sent().length, 1);
  assert.equal(out.value, true);
});

test('an EXECUTED_OPTIMISTIC answer is polled until FINAL, so the read-back right after send sees the change', async () => {
  // A fake chain whose finality-"final" view (what deploy.mjs and desk.mjs read back) sees the transaction only once
  // its outcome is FINAL: send_tx answers EXECUTED_OPTIMISTIC, the first tx look too, the second FINAL.
  let finalized = false;
  const f = fakeRpc({
    sends: [OPTIMISTIC],
    looks: [OPTIMISTIC, () => { finalized = true; return FINAL; }],
  });
  const readBack = () => (finalized ? { owner: 'o.testnet' } : null);
  const out = await send(testKey(), 'c.testnet', ACTS, fast(f.rpc));
  assert.deepEqual(readBack(), { owner: 'o.testnet' }, 'send returned only after the transaction was final');
  const looks = f.calls.filter((c) => c.method === 'tx');
  assert.equal(looks.length, 2);
  assert.ok(looks.every((c) => c.params.wait_until === 'FINAL' && c.params.tx_hash === out.hash));
  assert.equal(f.sent().length, 1, 'waiting never sends again');
  assert.equal(out.value, true);
});

test('an outcome that never becomes FINAL is an error after the polls, not a result', async () => {
  const f = fakeRpc({ sends: [OPTIMISTIC], looks: Array.from({ length: 10 }, () => OPTIMISTIC) });
  await assert.rejects(send(testKey(), 'c.testnet', ACTS, fast(f.rpc)), /did not finish after 4 looks/);
  assert.equal(f.sent().length, 1);
});

test('any other refusal of send_tx is thrown as it is, with no retry', async () => {
  const f = fakeRpc({ sends: [rpcError('send_tx', { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: 'NotEnoughBalance' } } })] });
  await assert.rejects(send(testKey(), 'c.testnet', ACTS, fast(f.rpc)), /NotEnoughBalance/);
  assert.equal(f.sent().length, 1);
});

test('isInvalidNonce and akNonceOf read the RPC error', () => {
  assert.equal(isInvalidNonce(invalidNonce(6, 9)), true);
  assert.equal(akNonceOf(invalidNonce(6, 9)), 9n);
  assert.equal(isInvalidNonce(timeout()), false);
  assert.equal(isInvalidNonce(new Error('InvalidNonce in a message only')), false, 'only an RPC answer counts');
  assert.equal(akNonceOf(timeout()), null);
});
