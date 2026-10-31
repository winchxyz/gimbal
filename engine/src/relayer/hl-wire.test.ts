// hl-wire against the public vectors the contract is tested with (contract/core/tests/vectors/hl.json, made with
// Hyperliquid's own SDKs): the msgpack bytes, both digests, and an MPC-shaped signature that must come out as the
// SDK's {r, s, v} and recover to the desk's address.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { HlPayload, Secp256k1Signature } from '../contract/types.ts';
import {
  bytesToHex, exchangeBody, hlSignature, l1ConnectionId, l1Digest, msgpack, payloadDigest, recoverSigner, userSignedDigest,
} from './hl-wire.ts';
import type { MsgpackValue } from './hl-wire.ts';

const VECTORS = fileURLToPath(new URL('../../../contract/core/tests/vectors/hl.json', import.meta.url));
const v = JSON.parse(readFileSync(VECTORS, 'utf8'));
const DESK: string = v.keys.deskEvm.address_lower;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

interface SdkSig { r: string; s: string; v: number }

/** The SDK's {r, s, v} as the MPC network returns it: big_r = parity prefix + r, recovery_id = v − 27. */
function asMpc(sig: SdkSig): Secp256k1Signature {
  const recovery = sig.v - 27;
  return { scheme: 'Secp256k1', big_r: { affine_point: `${recovery === 0 ? '02' : '03'}${sig.r.slice(2)}` }, s: { scalar: sig.s.slice(2) }, recovery_id: recovery };
}

test('msgpack, connection id and both L1 digests match every vector', async () => {
  assert.ok(v.l1.cases.length >= 18);
  for (const c of v.l1.cases) {
    assert.equal(bytesToHex(msgpack(c.action as MsgpackValue)).slice(2), c.msgpack_hex, c.name);
    assert.equal(l1ConnectionId(c.action, c.nonce), c.connection_id, c.name);
    for (const network of ['mainnet', 'testnet'] as const) {
      const n = c[network];
      assert.equal(l1Digest(c.action, c.nonce, network), n.digest, `${c.name} ${network}`);
      const sig = hlSignature(asMpc(n.signature));
      assert.deepEqual(sig, { r: n.signature.r, s: n.signature.s, v: n.signature.v }, c.name);
      assert.equal(await recoverSigner(n.digest, sig), DESK, c.name);
      const payload: HlPayload = { action: c.action, nonce: c.nonce, vaultAddress: null };
      assert.equal(payloadDigest(payload, network), n.digest);
      assert.deepEqual(exchangeBody(payload, sig), n.exchange_body, c.name);
    }
  }
});

test('user-signed digests match every vector and recover to the desk', async () => {
  assert.ok(v.user_signed.cases.length >= 14);
  for (const c of v.user_signed.cases) {
    assert.equal(userSignedDigest(c.action), c.digest, c.name);
    const network = c.network as 'mainnet' | 'testnet';
    const payload: HlPayload = { action: c.action, nonce: c.exchange_body.nonce };
    assert.equal(payloadDigest(payload, network), c.digest, c.name);
    const sig = hlSignature(asMpc(c.signature));
    assert.equal(await recoverSigner(c.digest, sig), DESK, c.name);
    assert.deepEqual(exchangeBody(payload, sig), c.exchange_body, c.name);
  }
});

test('a user-signed action for the other network is refused before anything is posted', () => {
  const c = v.user_signed.cases.find((x: { network: string }) => x.network === 'mainnet');
  assert.throws(() => payloadDigest({ action: c.action, nonce: c.exchange_body.nonce }, 'testnet'), /signed for Mainnet/);
});

test('a high s comes out as its low twin with the other v, and still recovers to the desk', async () => {
  const c = v.l1.cases[0];
  const sdk: SdkSig = c.testnet.signature;
  const low = asMpc(sdk);
  const highS = (N - BigInt(sdk.s)).toString(16).padStart(64, '0');
  const high: Secp256k1Signature = { ...low, s: { scalar: highS }, recovery_id: low.recovery_id === 0 ? 1 : 0 };
  const sig = hlSignature(high);
  assert.deepEqual(sig, { r: sdk.r, s: sdk.s, v: sdk.v });
  assert.equal(await recoverSigner(c.testnet.digest, sig), DESK);
});

test('malformed MPC signatures are refused', () => {
  const good = asMpc(v.l1.cases[0].testnet.signature);
  assert.throws(() => hlSignature({ ...good, big_r: { affine_point: `04${'11'.repeat(32)}` } }), /compressed point/);
  assert.throws(() => hlSignature({ ...good, recovery_id: 2 }), /recovery id/);
  assert.throws(() => hlSignature({ ...good, s: { scalar: 'zz' } }), /32 bytes/);
  assert.throws(() => hlSignature({ ...good, s: { scalar: '00'.repeat(32) } }), /curve order/);
  assert.throws(() => hlSignature({ scheme: 'Ed25519' } as unknown as Secp256k1Signature), /Secp256k1/);
});

test('msgpack picks the smallest int and string forms and refuses floats', () => {
  const hex = (x: MsgpackValue) => bytesToHex(msgpack(x)).slice(2);
  assert.equal(hex(127), '7f');
  assert.equal(hex(128), 'cc80');
  assert.equal(hex(256), 'cd0100');
  assert.equal(hex(65536), 'ce00010000');
  assert.equal(hex(4294967296), 'cf0000000100000000');
  assert.equal(hex(-1), 'ff');
  assert.equal(hex(-33), 'd0df');
  assert.equal(hex('a'.repeat(31)).slice(0, 2), 'bf');
  assert.equal(hex('a'.repeat(32)).slice(0, 4), 'd920');
  assert.throws(() => msgpack(1.5), /safe integer/);
});
