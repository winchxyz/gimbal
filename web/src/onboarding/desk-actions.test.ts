import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATE_DESK_GAS,
  createDeskTx,
  depositTx,
  DEPOSIT_GAS,
  isDeskId,
  isEvmAddress,
  isIp,
  OWNER_CALL_GAS,
  setOrderlyIpsTx,
  setOrderlyReceiverTx,
  setPolicyTx,
  splitIps,
} from './desk-actions.ts';
import { addressesFrom } from './derive.ts';
import { fakeEd25519 } from './fakes.ts';
import { formatNear, nearToYocto, storageDeposit, tgas, YOCTO } from './near.ts';
import { starterPolicy } from './policy.ts';

const DERIVED = addressesFrom('secp256k1:4XR92Zct9ZodXzisJ4kov3upmTvMotYVrg65MHP8aoCjSPJwUa7vjaXK5VhDF7ZiiF16v7cY5BPazCLnVqZ3yzb', fakeEd25519('sol'));

test('create_desk: 100 TGas, a storage deposit, the policy and the derived addresses as the contract checks them', () => {
  const tx = createDeskTx('c.testnet', 'desk-07', starterPolicy(), DERIVED);
  assert.equal(tx.receiverId, 'c.testnet');
  const a = tx.actions[0]!;
  assert.equal(a.type, 'FunctionCall');
  if (a.type !== 'FunctionCall') return;
  assert.equal(a.params.methodName, 'create_desk');
  assert.equal(a.params.gas, '100000000000000');
  assert.equal(a.params.gas, CREATE_DESK_GAS);
  assert.deepEqual(a.params.args, { desk_id: 'desk-07', policy: starterPolicy(), evm_address: DERIVED.evm_address, solana: DERIVED.solana });
  assert.ok(BigInt(a.params.deposit) > 1n, 'more than the 1 yocto a wallet attaches to an owner call');
  assert.ok(BigInt(a.params.deposit) < 5n * YOCTO, 'and a small fraction of a NEAR: the storage of one desk');
});

test('set_policy carries a storage deposit, the owner calls exactly 1 yocto', () => {
  const sp = setPolicyTx('c.testnet', 'd', starterPolicy()).actions[0]!;
  assert.equal(sp.type === 'FunctionCall' && sp.params.gas, OWNER_CALL_GAS);
  assert.ok(sp.type === 'FunctionCall' && BigInt(sp.params.deposit) > 1n);
  const rec = setOrderlyReceiverTx('c.testnet', 'd', '0x' + 'a'.repeat(40)).actions[0]!;
  assert.deepEqual(rec.type === 'FunctionCall' && [rec.params.methodName, rec.params.deposit, rec.params.args], ['set_orderly_receiver', '1', { desk_id: 'd', receiver: '0x' + 'a'.repeat(40) }]);
  const ips = setOrderlyIpsTx('c.testnet', 'd', ['203.0.113.7']).actions[0]!;
  assert.deepEqual(ips.type === 'FunctionCall' && [ips.params.methodName, ips.params.deposit], ['set_orderly_ips', '1']);
});

test('a deposit is ft_transfer_call on the USDC token with the desk id in msg, 1 yocto', () => {
  const tx = depositTx('usdc.testnet', 'c.testnet', 'desk-07', 1_050_000_000n);
  assert.equal(tx.receiverId, 'usdc.testnet');
  const a = tx.actions[0]!;
  assert.equal(a.type === 'FunctionCall' && a.params.deposit, '1');
  assert.equal(a.type === 'FunctionCall' && a.params.gas, DEPOSIT_GAS);
  assert.deepEqual(a.type === 'FunctionCall' && a.params.args, { receiver_id: 'c.testnet', amount: '1050000000', msg: '{"desk_id":"desk-07"}' });
});

test('desk ids, addresses and IPs', () => {
  for (const ok of ['a', 'desk-07', 'a'.repeat(32), '0-9']) assert.equal(isDeskId(ok), true, ok);
  for (const bad of ['', 'Desk', 'a'.repeat(33), 'a_b', 'a b', 'é']) assert.equal(isDeskId(bad), false, bad);
  assert.equal(isEvmAddress('0x' + 'aB'.repeat(20)), true);
  assert.equal(isEvmAddress('0x' + 'a'.repeat(39)), false);
  assert.deepEqual(splitIps('1.2.3.4, 5.6.7.8\n9.9.9.9  '), ['1.2.3.4', '5.6.7.8', '9.9.9.9']);
  for (const ok of ['203.0.113.7', '0.0.0.0', '255.255.255.255', '2001:db8::1']) assert.equal(isIp(ok), true, ok);
  for (const bad of ['256.1.1.1', '01.2.3.4', '1.2.3', 'example.com', '']) assert.equal(isIp(bad), false, bad);
});

test('NEAR amounts are exact', () => {
  assert.equal(nearToYocto('5'), 5n * YOCTO);
  assert.equal(nearToYocto('0.000000000000000000000001'), 1n);
  for (const bad of ['0', '-1', '1e3', 'x', '', '1.0000000000000000000000001']) assert.equal(nearToYocto(bad), null, bad);
  assert.equal(tgas(100), '100000000000000');
  assert.equal(formatNear(3_000_000_000_000_000_000_000n), '0.003');
  assert.equal(formatNear(3_000_000_000_000_000_000_001n), '0.004', 'a cost is rounded up, never understated');
  assert.equal(formatNear(5n * YOCTO), '5');
  assert.equal(storageDeposit('abcd', 6), 10n * 10n ** 19n);
});
