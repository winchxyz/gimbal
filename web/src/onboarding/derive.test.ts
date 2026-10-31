import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressesFrom, b58decode, b58encode, evmAddressOf, evmPath, isOnCurve, solanaAccountsOf, solPath } from './derive.ts';

// Vectors from tools/testnet/near.mjs (the script that created the testnet desks) for three authorities; the
// first one's Phoenix trader is also the one in contract/core/tests/vectors/solana-onboarding.json, which the
// Phoenix SDK produced.
const SOLANA: [string, { usdc_ata: string; phusd_ata: string; phoenix_trader: string }][] = [
  ['GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB', { usdc_ata: '7woc3ajaGMMXczFYjxon4aQoHH3j126fMUR9c58eHRsK', phusd_ata: 'B47LSj6jai4xihMm7yzYTLKpDjq49KTYLTgunx9g1e9L', phoenix_trader: 'BteLYAHGWEHAn4u3yBTrhon7cNsvJFCPeuqc1EyB5cJZ' }],
  ['7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9', { usdc_ata: 'ECGH8sEveKyzjhtjVSMs2Yr3GCaYx5DXWDMaJAY1Sso6', phusd_ata: 'A3cw7fawU5Xu4v3tn7A8JraJ3D9sMnrzah8UkxZ7VLCz', phoenix_trader: '3ijttWkut1mYU7ZVcjKoRbPwSGntYC3Q9Juw7KUfy13Q' }],
  ['5Z6Ay5NEcbg3xhopc522sBCRXQujkTiuDRnHGfQdcnSf', { usdc_ata: '5vUprZVMWkZgRdVKoEFp5fJHdeWvGXJQrGErFNwAysL4', phusd_ata: 'GmcmgmEF7LJnS6ascRRmAs8Z4FBh1FNxqwGUDWhrab1H', phoenix_trader: '7HX1szZiJTkVTNCggjjtvJ5kw3hvUyqEKw4112UXUq4' }],
];

test('the Solana accounts of an authority match the ones the contract checks', () => {
  for (const [authority, expected] of SOLANA) assert.deepEqual(solanaAccountsOf(authority), { authority, ...expected });
});

test('an EVM address is the last 20 bytes of keccak256 of the 64-byte key', () => {
  const key = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 255);
  assert.equal(b58encode(key), '4XR92Zct9ZodXzisJ4kov3upmTvMotYVrg65MHP8aoCjSPJwUa7vjaXK5VhDF7ZiiF16v7cY5BPazCLnVqZ3yzb');
  assert.equal(evmAddressOf(key), '0xbe85f3dc536fc93df590c2d20ca9b28af1ed2c39');
  assert.throws(() => evmAddressOf(key.subarray(1)), /64 bytes/);
});

test('addresses come from the two MPC answers, and a malformed answer says which one', () => {
  const key = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 255);
  const [authority, accounts] = SOLANA[0]!;
  const out = addressesFrom(`secp256k1:${b58encode(key)}`, `ed25519:${authority}`);
  assert.equal(out.evm_address, '0xbe85f3dc536fc93df590c2d20ca9b28af1ed2c39');
  assert.deepEqual(out.solana, { authority, ...accounts });
  assert.throws(() => addressesFrom(b58encode(key), `ed25519:${authority}`), /EVM key does not start/);
  assert.throws(() => addressesFrom(`secp256k1:${b58encode(key.subarray(2))}`, `ed25519:${authority}`), /EVM key is not 64 bytes/);
  assert.throws(() => addressesFrom(`secp256k1:${b58encode(key)}`, authority), /Solana key does not start/);
  assert.throws(() => addressesFrom(`secp256k1:${b58encode(key)}`, 'ed25519:abc'), /Solana key is not 32 bytes/);
});

test('base58 round-trips, keeps leading zero bytes and refuses other characters', () => {
  for (const bytes of [[], [0], [0, 0, 1], [255, 0, 255], Array.from({ length: 32 }, (_, i) => i)]) {
    assert.deepEqual([...b58decode(b58encode(Uint8Array.from(bytes)))], bytes);
  }
  assert.equal(b58encode(Uint8Array.of(0, 0, 1)), '112');
  assert.throws(() => b58decode('0OIl'), /not base58/);
});

test('program addresses are off the curve and an ordinary key is on it', () => {
  assert.equal(isOnCurve(b58decode('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB')), true);
  assert.equal(isOnCurve(b58decode('BteLYAHGWEHAn4u3yBTrhon7cNsvJFCPeuqc1EyB5cJZ')), false);
});

test('the derivation paths follow docs/interfaces.md §1.2', () => {
  assert.equal(evmPath('desk-07'), 'gimbal/desk-07/evm');
  assert.equal(solPath('desk-07'), 'gimbal/desk-07/sol');
});
