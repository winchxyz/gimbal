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
import { keccak256 } from 'viem';

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

// expiresAfter (C6): the Python SDK's action_hash appends 0x00 and expiresAfter as u64 big-endian after the vault
// byte. The digests below were computed outside the engine (viem's keccak256 and hashTypedData over the SDK's byte
// layout and the vectors' msgpack, for the contract's tests in C6), at each case's nonce with expiresAfter = nonce +
// 60 s; the connection id is also rebuilt here byte by byte from the vector's own msgpack_hex.
const EXPIRING = [
  {
    name: 'cancel ETH oid 77 (fixint)',
    connection: '0x615afe3d2a7e6a208a317396befbba2f096d833fba7c40380a32ddf9f661fb39',
    mainnet: '0xf26ff7219889a502216f9a7022903ef0b5130f5330835427e798c503a5c9af98',
    testnet: '0xd81f2e4e8f110e874e28493580e46b830d9dbdf808a221813aa3af4dd5476130',
  },
  {
    name: 'ETH buy IOC, no cloid, fee 1 bp',
    connection: '0x59db084d38b6d2e4d892ac3fc60b8e947f35b6c6c49ac523c579274a3228f7fb',
    mainnet: '0x883ce8d2d8cc74e61980d19f3ac4c3c3f05aaf79e85a6ff2731a0000205bbc1d',
    testnet: '0x6b4e114abfc4a56ec39875d230c9afa55aca3ef82374fe75b6849cb117302d86',
  },
];

test('expiresAfter enters the L1 hash as the SDK writes it, and the payload digest reads it', () => {
  for (const e of EXPIRING) {
    const c = v.l1.cases.find((x: { name: string }) => x.name === e.name);
    assert.ok(c, e.name);
    const expires = c.nonce + 60_000;
    const u64 = (n: number) => Buffer.from(BigInt(n).toString(16).padStart(16, '0'), 'hex');
    const written = Buffer.concat([Buffer.from(c.msgpack_hex, 'hex'), u64(c.nonce), Buffer.from([0]), Buffer.from([0]), u64(expires)]);
    assert.equal(keccak256(written), e.connection, e.name);
    assert.equal(l1ConnectionId(c.action, c.nonce, expires), e.connection, e.name);
    // Without it, the vector's own connection id.
    assert.equal(l1ConnectionId(c.action, c.nonce), c.connection_id, e.name);
    for (const network of ['mainnet', 'testnet'] as const) {
      assert.equal(l1Digest(c.action, c.nonce, network, expires), e[network], `${e.name} ${network}`);
      const payload: HlPayload = { action: c.action, nonce: c.nonce, vaultAddress: null, expiresAfter: expires };
      assert.equal(payloadDigest(payload, network), e[network], `${e.name} ${network}`);
      const body = exchangeBody(payload, { r: '0x01', s: '0x02', v: 27 });
      assert.equal(body.expiresAfter, expires);
    }
  }
});

// An independent expiresAfter vector: engine/fixtures/hl-sdk/expires-after.json was written by
// hyperliquid-python-sdk 0.24.0 itself, sign_l1_action(wallet, action, None, nonce, expires_after, is_mainnet) with
// the vectors' public desk test key, and its action_hash for the connection id. The cases above check the byte layout
// against digests worked out by hand; these check the SDK's own hash and signature (one case expires 1 ms after its
// nonce).
const SDK_EXPIRING = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/hl-sdk/expires-after.json', import.meta.url)), 'utf8'));

test('expiresAfter: hash, digests and signatures match what hyperliquid-python-sdk 0.24.0 signs', async () => {
  assert.match(SDK_EXPIRING.generator, /^hyperliquid-python-sdk 0\.24\.0: hyperliquid\.utils\.signing\.sign_l1_action\(/);
  assert.equal(SDK_EXPIRING.signer, DESK);
  assert.ok(SDK_EXPIRING.cases.length >= 3);
  for (const c of SDK_EXPIRING.cases) {
    assert.ok(c.expires_after > c.nonce, c.name);
    assert.equal(l1ConnectionId(c.action, c.nonce, c.expires_after), c.connection_id, c.name);
    assert.notEqual(l1ConnectionId(c.action, c.nonce), c.connection_id, `${c.name}: expiresAfter changes the hash`);
    for (const network of ['mainnet', 'testnet'] as const) {
      const n = c[network];
      assert.equal(l1Digest(c.action, c.nonce, network, c.expires_after), n.digest, `${c.name} ${network}`);
      const payload: HlPayload = { action: c.action, nonce: c.nonce, vaultAddress: null, expiresAfter: c.expires_after };
      assert.equal(payloadDigest(payload, network), n.digest, `${c.name} ${network}`);
      const sig = hlSignature(asMpc(n.signature));
      assert.deepEqual(sig, n.signature, `${c.name} ${network}`);
      assert.equal(await recoverSigner(n.digest, sig), DESK, `${c.name} ${network}`);
      assert.deepEqual(exchangeBody(payload, sig), { action: c.action, nonce: c.nonce, vaultAddress: null, expiresAfter: c.expires_after, signature: n.signature });
    }
  }
});
