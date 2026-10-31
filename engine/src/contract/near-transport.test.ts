// NearApiTransport against a fake RPC provider (no network, a random key made here): once the signed bytes may have
// left the process, the outcome is read from their hash and nothing is signed twice. Covered: fetch failed after the
// send, a 429 on near-api-js's own re-send after a 408, InvalidNonce when the first copy landed (and when it did not),
// a definitive rejection (and the same one answering a re-send of a copy that landed), a congested or stuck shard, a
// hash that never shows up (OutcomeUnknown), and the RPC URL's key kept out of errors.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { KeyPairEd25519 } from 'near-api-js';
import type { SignedTransaction } from 'near-api-js';
import { InvalidNonceError, NotEnoughBalanceError, ShardCongestedError, ShardStuckError, UnknownTransactionError } from 'near-api-js/rpc-errors';
import { base58 } from '../venues/orderly-signer.ts';
import type { NearRpc } from './near-transport.ts';
import { NearApiTransport, NearViewTransport, redact, rpcLabel } from './near-transport.ts';
import { OutcomeUnknown } from './types.ts';

const BLOCK = base58(Buffer.alloc(32, 7));
const ok = (value: unknown) => ({ status: { SuccessValue: Buffer.from(JSON.stringify(value)).toString('base64') } });
const hashOf = (signed: SignedTransaction) => base58(createHash('sha256').update(signed.transaction.encode()).digest());

/** A provider whose send and status answers are scripted; every send is recorded with its hash and nonce. */
class FakeRpc {
  akNonce = 10n;
  sends: { hash: string; nonce: bigint; waitUntil: string }[] = [];
  /** Answers to sendTransactionUntil in turn: a value is returned, an Error thrown; default ok(1). */
  sendAnswers: ((hash: string) => unknown)[] = [];
  /** Answers to viewTransactionStatus in turn (the last one repeats); default UnknownTransaction. */
  statusAnswers: ((hash: string) => unknown)[] = [];
  statusReads: string[] = [];
  keyReads = 0;

  async viewAccessKey() {
    this.keyReads++;
    return { nonce: this.akNonce, permission: 'FullAccess', block_hash: BLOCK, block_height: 1 };
  }
  async viewBlock() {
    return { header: { hash: BLOCK, height: 1 } };
  }
  async sendTransactionUntil(signed: SignedTransaction, waitUntil: string) {
    const hash = hashOf(signed);
    this.sends.push({ hash, nonce: BigInt(signed.transaction.nonce), waitUntil });
    const answer = this.sendAnswers.shift();
    const r = answer === undefined ? ok(1) : answer(hash);
    if (r instanceof Error) throw r;
    return r;
  }
  async viewTransactionStatus({ txHash, waitUntil }: { txHash: string; waitUntil: string }) {
    this.statusReads.push(waitUntil);
    const answer = this.statusAnswers.length > 1 ? this.statusAnswers.shift()! : this.statusAnswers[0];
    const r = answer === undefined ? new UnknownTransactionError(txHash) : answer(txHash);
    if (r instanceof Error) throw r;
    return r;
  }
  async callFunction() {
    throw new Error('request to https://rpc.example.org/v3/0123456789abcdef0123 failed');
  }
  async viewAccount() {
    return { amount: '1', locked: '0', storage_usage: 0 };
  }
}

function transport(rpc: FakeRpc, extra: { followMs?: number; rpcUrl?: string } = {}) {
  let t = 0;
  return new NearApiTransport({
    network: 'testnet', accountId: 'owner.testnet', privateKey: KeyPairEd25519.fromRandom().toString(),
    provider: rpc as unknown as NearRpc, followMs: extra.followMs ?? 60_000, pollMs: 3_000, rebroadcastMs: 10_000,
    sleep: async (ms) => { t += ms; }, now: () => t, ...(extra.rpcUrl === undefined ? {} : { rpcUrl: extra.rpcUrl }),
  });
}

test('fetch failed after the send: the same hash is followed, the same bytes rebroadcast, nothing signed again', async () => {
  const rpc = new FakeRpc();
  rpc.sendAnswers.push(() => new TypeError('fetch failed'));
  let reads = 0;
  rpc.statusAnswers.push((h) => (++reads < 6 ? new UnknownTransactionError(h) : ok({ signed: true })));
  const out = await transport(rpc).call('gimbal.testnet', 'hl_order', { desk_id: 'alpha' }, 300);
  assert.deepEqual(out, { txHash: rpc.sends[0]!.hash, ok: true, value: { signed: true } });
  assert.ok(rpc.sends.length >= 2, 'rebroadcast while the RPC did not know the hash');
  assert.equal(new Set(rpc.sends.map((s) => s.hash)).size, 1, 'every send carried the same signed bytes');
  assert.equal(rpc.keyReads, 1, 'one nonce read: no second transaction');
});

test('a 429 on near-api-js re-sending after a 408: followed by hash, and OutcomeUnknown if it never shows up', async () => {
  const landed = new FakeRpc();
  landed.sendAnswers.push(() => Object.assign(new Error('Too Many Requests'), { cause: 429 }));
  landed.statusAnswers.push(() => ok({ request_id: 7 }));
  const out = await transport(landed).call('gimbal.testnet', 'hl_order', {}, 300);
  assert.equal(out.ok && (out.value as { request_id: number }).request_id, 7);
  assert.equal(landed.sends.length, 1);

  const lost = new FakeRpc();
  lost.sendAnswers.push(() => Object.assign(new Error('Too Many Requests'), { cause: 429 }));
  await assert.rejects(transport(lost, { followMs: 30_000 }).call('gimbal.testnet', 'hl_order', {}, 300), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    assert.equal(err.ids.nearTx, lost.sends[0]!.hash);
    assert.equal(err.what, 'hl_order');
    assert.equal(err.tx[0]?.url, `https://testnet.nearblocks.io/txns/${lost.sends[0]!.hash}`);
    return true;
  });
  assert.equal(new Set(lost.sends.map((s) => s.hash)).size, 1);
  assert.equal(lost.keyReads, 1);
});

test('InvalidNonce: the original hash is looked up first; it landed, so its outcome is returned and nothing is re-signed', async () => {
  const rpc = new FakeRpc();
  rpc.sendAnswers.push((h) => new InvalidNonceError(11, 11, h, BLOCK));
  rpc.statusAnswers.push(() => ok({ first: true }));
  const out = await transport(rpc).call('gimbal.testnet', 'hl_order', {}, 300);
  assert.deepEqual(out, { txHash: rpc.sends[0]!.hash, ok: true, value: { first: true } });
  assert.equal(rpc.sends.length, 1);
  assert.equal(rpc.keyReads, 1);
});

test('InvalidNonce with the hash absent on three reads: the transaction can never run, so it is signed once more', async () => {
  const rpc = new FakeRpc();
  rpc.sendAnswers.push((h) => { rpc.akNonce = 15n; return new InvalidNonceError(15, 11, h, BLOCK); });
  const out = await transport(rpc).call('gimbal.testnet', 'refresh_prices', {}, 300);
  assert.equal(rpc.sends.length, 2);
  assert.notEqual(rpc.sends[0]!.hash, rpc.sends[1]!.hash);
  assert.equal(rpc.sends[1]!.nonce, 16n);
  assert.equal(out.txHash, rpc.sends[1]!.hash);
  assert.deepEqual(rpc.statusReads, ['NONE', 'NONE', 'NONE']);
});

test('a definitive rejection (not enough balance) is thrown as is once the hash lookup finds nothing', async () => {
  const rpc = new FakeRpc();
  rpc.sendAnswers.push((h) => new NotEnoughBalanceError(1n, 2n, 'owner.testnet', h, BLOCK));
  await assert.rejects(transport(rpc).call('gimbal.testnet', 'hl_order', {}, 300), NotEnoughBalanceError);
  assert.deepEqual(rpc.statusReads, ['NONE', 'NONE', 'NONE']);
  assert.equal(rpc.sends.length, 1);
  // The same refusal answering near-api-js's re-send while the first copy landed: that copy's outcome, not "nothing ran".
  const landed = new FakeRpc();
  landed.sendAnswers.push((h) => new NotEnoughBalanceError(1n, 2n, 'owner.testnet', h, BLOCK));
  landed.statusAnswers.push(() => ok({ first: true }));
  const out = await transport(landed).call('gimbal.testnet', 'hl_order', {}, 300);
  assert.deepEqual(out, { txHash: landed.sends[0]!.hash, ok: true, value: { first: true } });
  assert.equal(landed.keyReads, 1);
});

test('ShardCongested / ShardStuck (checked before the nonce): the hash is followed, never "nothing ran"', async () => {
  // near-api-js re-sent after a 408 while the first copy was executing (waiting on the MPC network); the re-send
  // met a congested shard. The first copy's outcome is what comes back.
  const running = new FakeRpc();
  running.sendAnswers.push((h) => new ShardCongestedError(0.9, 2, h, BLOCK));
  let reads = 0;
  running.statusAnswers.push((h) => (++reads < 4 ? new UnknownTransactionError(h) : ok({ signed: true })));
  const out = await transport(running).call('gimbal.testnet', 'hl_order', {}, 300);
  assert.deepEqual(out, { txHash: running.sends[0]!.hash, ok: true, value: { signed: true } });
  assert.equal(new Set(running.sends.map((s) => s.hash)).size, 1);
  assert.equal(running.keyReads, 1, 'no second transaction');
  // Stuck the whole time: OutcomeUnknown with the hash, after rebroadcasting the same bytes only.
  const stuck = new FakeRpc();
  stuck.sendAnswers.push((h) => new ShardStuckError(5, 2, h, BLOCK));
  await assert.rejects(transport(stuck, { followMs: 30_000 }).call('gimbal.testnet', 'hl_order', {}, 300), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    assert.equal(err.ids.nearTx, stuck.sends[0]!.hash);
    return true;
  });
  assert.ok(stuck.sends.length >= 2);
  assert.equal(new Set(stuck.sends.map((s) => s.hash)).size, 1);
  assert.equal(stuck.keyReads, 1);
});

test('NEAR_RPC_URL keys never reach an error text', async () => {
  const url = 'https://rpc.example.org/v3/0123456789abcdef0123';
  assert.equal(rpcLabel(url), 'https://rpc.example.org/…');
  assert.equal(rpcLabel('https://test.rpc.fastnear.com'), 'https://test.rpc.fastnear.com');
  assert.equal(redact(`POST ${url} unavailable`, url), 'POST https://rpc.example.org/… unavailable');
  assert.equal(redact('?apiKey=s3cr3tvalue failed', 'https://rpc.example.org/?apiKey=s3cr3tvalue'), '… failed');
  const view = new NearViewTransport({ network: 'testnet', rpcUrl: url, provider: new FakeRpc() as unknown as NearRpc });
  await assert.rejects(view.view('g.testnet', 'config', {}), (err: unknown) => {
    assert.ok(!String((err as Error).message).includes('0123456789abcdef0123'), String(err));
    assert.match(String((err as Error).message), /rpc\.example\.org\/…/);
    return true;
  });
  // The view transport holds no key and refuses to sign.
  await assert.rejects(view.call('g.testnet', 'hl_order', {}, 300), /only reads views/);
});
