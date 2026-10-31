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
  setPolicyDeposit,
  setPolicyTx,
  splitIps,
} from './desk-actions.ts';
import { addressesFrom } from './derive.ts';
import { createDeskBytes, depositRefusal, largestValidPolicy, setIpsBytes, setPolicyBytes, setReceiverBytes, storageCharge } from './fake-storage.ts';
import { fakeEd25519 } from './fakes.ts';
import { formatNear, nearToYocto, STORAGE_BYTE_COST, storageDeposit, tgas, YOCTO } from './near.ts';
import { starterPolicy } from './policy.ts';
import type { WalletTx } from './wallet.ts';

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
  assert.ok(BigInt(a.params.deposit) < YOCTO / 5n, 'and a fraction of a NEAR: the storage of one desk, with room');
});

/** The deposit a call carries, in yoctoNEAR. */
function depositOf(tx: WalletTx): bigint {
  const a = tx.actions[0]!;
  assert.equal(a.type, 'FunctionCall');
  return a.type === 'FunctionCall' ? BigInt(a.params.deposit) : 0n;
}

const OWNER_64 = `${'o'.repeat(56)}.testnet`;
const DESK_32 = 'd'.repeat(32);

test('create_desk covers the storage the contract measures for a desk: the starter policy, the largest policy, the longest names', () => {
  const cases = [
    { deskId: 'alpha', owner: 'alice', policy: starterPolicy() },
    { deskId: 'desk-07', owner: 'demo-owner.testnet', policy: starterPolicy() },
    { deskId: DESK_32, owner: OWNER_64, policy: starterPolicy() },
    { deskId: 'alpha', owner: 'alice', policy: largestValidPolicy() },
    { deskId: DESK_32, owner: OWNER_64, policy: largestValidPolicy() },
  ];
  for (const c of cases) {
    const need = createDeskBytes({ ...c, evm_address: DERIVED.evm_address, solana: DERIVED.solana, ownerHasDesk: false });
    const deposit = depositOf(createDeskTx('c.testnet', c.deskId, c.policy, DERIVED));
    assert.equal(depositRefusal('create_desk', `desk ${c.deskId}`, need, deposit), null, `${c.deskId} / ${c.owner} / ${c.policy.hl_assets.length} assets: ${need} B`);
    assert.ok(deposit - storageCharge(need) >= STORAGE_BYTE_COST * 5_000n, 'with at least 5,000 bytes of room for the contract to change how it stores a desk');
  }
  // The contract's own test caps the largest desk at 10,000 bytes and a small one at 2,500: the deposit is over both.
  assert.ok(depositOf(createDeskTx('c.testnet', 'alpha', starterPolicy(), DERIVED)) >= STORAGE_BYTE_COST * 2_500n);
  assert.ok(depositOf(createDeskTx('c.testnet', 'alpha', largestValidPolicy(), DERIVED)) >= STORAGE_BYTE_COST * 10_000n);
});

test('the margin that failed on the chain is refused by the model with the contract’s own message', () => {
  const args = { desk_id: 'alpha', policy: starterPolicy(), evm_address: DERIVED.evm_address, solana: DERIVED.solana };
  const old = storageDeposit(JSON.stringify(args), 1_000);
  const need = createDeskBytes({ deskId: 'alpha', owner: 'alice', policy: starterPolicy(), evm_address: DERIVED.evm_address, solana: DERIVED.solana, ownerHasDesk: false });
  const refusal = depositRefusal('create_desk', 'desk alpha', need, old);
  assert.match(refusal ?? '', /^E_DEPOSIT: desk alpha takes \d+ bytes of storage: attach at least \d+ yoctoNEAR, not \d+$/);
  assert.ok(old < storageCharge(need), 'args + 1000 B is short of a desk even with the starter policy');
});

test('set_policy, the receiver and the IP list cover what the contract measures, from the smallest policy to the largest', () => {
  const grow = depositOf(setPolicyTx('c.testnet', 'a', largestValidPolicy()));
  assert.equal(depositRefusal('set_policy', 'set_policy on desk a', setPolicyBytes(starterPolicy(), largestValidPolicy()), grow), null, 'starter to largest');
  assert.equal(setPolicyDeposit('a', largestValidPolicy()), grow, 'the rules panel shows the deposit the transaction carries');
  assert.ok(grow >= STORAGE_BYTE_COST * 8_000n, 'over the contract’s own cap for it, 8,000 B');

  const receiver = depositOf(setOrderlyReceiverTx('c.testnet', DESK_32, `0x${'B'.repeat(40)}`));
  assert.equal(depositRefusal('set_orderly_receiver', 'x', setReceiverBytes(`0x${'b'.repeat(40)}`), receiver), null);

  // Ten IPv6 addresses of 39 characters, on a desk with a one-character id: the JSON is closest to the storage there.
  const ips = Array.from({ length: 10 }, (_, i) => `1111:2222:3333:4444:5555:6666:7777:${(0x8880 + i).toString(16)}`);
  const list = depositOf(setOrderlyIpsTx('c.testnet', 'a', ips));
  assert.equal(depositRefusal('set_orderly_ips', 'x', setIpsBytes([], ips), list), null);
  assert.ok(list >= STORAGE_BYTE_COST * 500n, 'over the contract’s own cap for it, 500 B');
});

test('set_policy, set_orderly_receiver and set_orderly_ips carry a storage deposit, not 1 yocto', () => {
  const sp = setPolicyTx('c.testnet', 'd', starterPolicy()).actions[0]!;
  assert.equal(sp.type === 'FunctionCall' && sp.params.gas, OWNER_CALL_GAS);
  assert.ok(sp.type === 'FunctionCall' && BigInt(sp.params.deposit) > 1n);
  const rec = setOrderlyReceiverTx('c.testnet', 'd', '0x' + 'A'.repeat(40)).actions[0]!;
  assert.deepEqual(rec.type === 'FunctionCall' && [rec.params.methodName, rec.params.args], ['set_orderly_receiver', { desk_id: 'd', receiver: '0x' + 'a'.repeat(40) }], 'the receiver goes lowercase');
  assert.ok(rec.type === 'FunctionCall' && BigInt(rec.params.deposit) > 1n && BigInt(rec.params.deposit) < YOCTO);
  const ips = setOrderlyIpsTx('c.testnet', 'd', ['203.0.113.7']).actions[0]!;
  assert.equal(ips.type === 'FunctionCall' && ips.params.methodName, 'set_orderly_ips');
  assert.ok(ips.type === 'FunctionCall' && BigInt(ips.params.deposit) > 1n && BigInt(ips.params.deposit) < YOCTO);
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
