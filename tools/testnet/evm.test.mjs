// hlL1Digest against the contract's own bytes: every L1 case of contract/core/tests/vectors/hl.json (msgpack,
// digest per network, the vector signature recovers to the vector desk), the expiresAfter digests that
// contract/core/tests/hl_vectors.rs pins from hyperliquid-python-sdk, and one live MPC signature from testnet.
// No network, no key file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './near.mjs';
import { hlL1Digest, hlSignature, msgpack, recoverAddress } from './evm.mjs';

const doc = JSON.parse(readFileSync(join(ROOT, 'contract', 'core', 'tests', 'vectors', 'hl.json'), 'utf8'));
const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const recover = (digest, { r, s, v }) => recoverAddress(digest, Buffer.from(r.slice(2), 'hex'), Buffer.from(s.slice(2), 'hex'), v - 27);
/** contract/core/src/hl.rs EXPIRES_AFTER_MS. */
const EXPIRES_AFTER_MS = 60_000;

test('every L1 vector: msgpack, the digest per network, and the signature recovers to the desk', () => {
  const cases = doc.l1.cases;
  assert.ok(cases.length > 0);
  const desk = doc.keys.deskEvm.address_lower;
  for (const c of cases) {
    assert.equal(msgpack(c.action).toString('hex'), c.msgpack_hex, `${c.name}: msgpack`);
    const body = { action: c.action, nonce: c.nonce, vaultAddress: null };
    for (const net of ['mainnet', 'testnet']) {
      const digest = hlL1Digest(body, c[net].source);
      assert.equal(hex(digest), c[net].digest, `${c.name} ${net}: digest`);
      assert.equal(recover(digest, c[net].signature), desk, `${c.name} ${net}: recovers to the vector desk`);
    }
  }
});

test('expiresAfter adds 0x00 and the expiry (u64 BE) to the connection id: the SDK digests pinned by hl_vectors.rs', () => {
  // contract/core/tests/hl_vectors.rs expires_after_enters_the_l1_hash_as_the_sdk_writes_it: name, mainnet, testnet.
  const pinned = [
    ['cancel ETH oid 77 (fixint)',
      '0xf26ff7219889a502216f9a7022903ef0b5130f5330835427e798c503a5c9af98',
      '0xd81f2e4e8f110e874e28493580e46b830d9dbdf808a221813aa3af4dd5476130'],
    ['ETH buy IOC, no cloid, fee 1 bp',
      '0x883ce8d2d8cc74e61980d19f3ac4c3c3f05aaf79e85a6ff2731a0000205bbc1d',
      '0x6b4e114abfc4a56ec39875d230c9afa55aca3ef82374fe75b6849cb117302d86'],
  ];
  for (const [name, mainnet, testnet] of pinned) {
    const c = doc.l1.cases.find((x) => x.name === name);
    assert.ok(c, name);
    const body = { action: c.action, nonce: c.nonce, vaultAddress: null, expiresAfter: c.nonce + EXPIRES_AFTER_MS };
    assert.equal(hex(hlL1Digest(body, 'a')), mainnet, `${name} mainnet`);
    assert.equal(hex(hlL1Digest(body, 'b')), testnet, `${name} testnet`);
    assert.notEqual(hex(hlL1Digest({ ...body, expiresAfter: undefined }, 'b')), testnet, `${name}: the expiry changes the digest`);
  }
});

test('a live testnet hl_order signature (desk final-1, 2026-11-03) recovers to the desk address', () => {
  // The SignedAction of tx 9RgCHtyJ4g8PBoHd4fMPivaJrckoBQMPRPTVbnzC3ARQ; Hyperliquid testnet recovered the same address.
  const payload = {
    action: {
      type: 'order',
      orders: [{ a: 3, b: true, p: '61053', s: '0.0002', r: false, t: { limit: { tif: 'Gtc' } } }],
      grouping: 'na',
      builder: { b: '0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c', f: 10 },
    },
    nonce: 1793694901833,
    vaultAddress: null,
    expiresAfter: 1793694961833,
  };
  const signature = {
    scheme: 'Secp256k1',
    big_r: { affine_point: '0356d6a0325a422c887e0f93371b5648fed3d26b7fc9141585749384cd57103f13' },
    s: { scalar: '1fefcbefe21550bea5a39d1b8cc9f291c9a45b46d8c41ae856da2e22906bf9e7' },
    recovery_id: 0,
  };
  const sig = hlSignature(signature);
  assert.equal(recover(hlL1Digest(payload), sig), '0x6dc11a853ca5afaa44fb926bf26ff0b3950928cb');
  const { expiresAfter, ...withoutExpiry } = payload;
  assert.ok(expiresAfter);
  assert.notEqual(recover(hlL1Digest(withoutExpiry), sig), '0x6dc11a853ca5afaa44fb926bf26ff0b3950928cb', 'the old digest (no expiry) does not');
});
