import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createDeskBytes,
  DESK_COUNTERS_BYTES,
  depositRefusal,
  largestValidPolicy,
  policyBytes,
  setIpsBytes,
  setPolicyBytes,
  setReceiverBytes,
  storageCharge,
  type NewDesk,
} from './fake-storage.ts';
import { starterPolicy } from './policy.ts';

/** A desk's accounts at the lengths the contract's own test uses: a lowercase EVM address and four 44-character base58 keys. */
const ADDRESSES = {
  evm_address: `0x${'a'.repeat(40)}`,
  solana: { authority: '1'.repeat(44), usdc_ata: '2'.repeat(44), phusd_ata: '3'.repeat(44), phoenix_trader: '4'.repeat(44) },
};

const desk = (over: Partial<NewDesk>): NewDesk => ({ deskId: 'alpha', owner: 'alice', policy: starterPolicy(), ownerHasDesk: false, ...ADDRESSES, ...over });

// What the contract measured, from the table its test prints (contract/src/tests.rs, `the_storage_each_owner_method_adds`,
// run with --nocapture, owner "alice"). The first desk of an owner also writes the owner's count record (54 B for "alice").

test('the model reproduces what the contract measured for a desk, a policy, a receiver and an IP list', () => {
  // `create_desk (the largest valid policy)`, the owner's second desk: 9758 B.
  assert.equal(policyBytes(largestValidPolicy()), 7_804, 'the largest valid policy is under 8 KiB in Borsh');
  assert.equal(createDeskBytes(desk({ deskId: 'large', policy: largestValidPolicy(), ownerHasDesk: true })), 9_758);
  // The review that found the bug: a first desk "alpha" with the starter policy took 2068 B.
  assert.equal(createDeskBytes(desk({})), 2_068);
  // `set_orderly_receiver`: 46 B. `set_orderly_ips` (ten 39-character IPv6 addresses): 430 B. `set_policy` to the same policy: 0 B.
  assert.equal(setReceiverBytes(`0x${'b'.repeat(40)}`), 46);
  const ips = Array.from({ length: 10 }, (_, i) => `1111:2222:3333:4444:5555:6666:7777:${(0x8880 + i).toString(16)}`);
  assert.equal(setIpsBytes([], ips), 430);
  assert.equal(setPolicyBytes(largestValidPolicy(), largestValidPolicy()), 0);
});

test('the pieces of a desk follow the stored structs', () => {
  assert.equal(DESK_COUNTERS_BYTES, 1_329, 'DeskCounters: meters, nonce and a ring of 32 hashes and 32 times');
  assert.equal(policyBytes(starterPolicy()), 60, 'a policy with empty lists is 60 bytes');
  assert.equal(createDeskBytes(desk({})) - createDeskBytes(desk({ ownerHasDesk: true })), 54, 'a first desk also writes the owner’s count');
  assert.ok(createDeskBytes(desk({ deskId: 'a-much-longer-desk-id' })) > createDeskBytes(desk({})), 'a longer id is in four keys and one value');
});

test('a policy that is no larger than the stored one adds nothing; a list adds only what grows', () => {
  const small = starterPolicy();
  assert.equal(setPolicyBytes(largestValidPolicy(), small), 0, 'freed storage is not paid back');
  assert.equal(setPolicyBytes(small, { ...small, orderly_symbols: ['PERP_SOL_USDC'] }), 4 + 13);
  assert.equal(setIpsBytes(['1.2.3.4', '5.6.7.8'], ['1.2.3.4']), 0);
  assert.equal(setIpsBytes(['1.2.3.4'], ['1.2.3.4', '5.6.7.8']), 4 + 7);
});

test('a storage method keeps what it adds at 1e19 yocto a byte, and at least 1 yocto', () => {
  assert.equal(storageCharge(2_068), 20_680_000_000_000_000_000_000n);
  assert.equal(storageCharge(0), 1n);
});

test('a short deposit is the contract’s own refusal, with its numbers; none at all is the function-call key’s path', () => {
  assert.equal(
    depositRefusal('create_desk', 'desk alpha', 2_068, 15_970_000_000_000_000_000_000n),
    'E_DEPOSIT: desk alpha takes 2068 bytes of storage: attach at least 20680000000000000000000 yoctoNEAR, not 15970000000000000000000',
    'the message of the review that found the bug',
  );
  assert.equal(depositRefusal('create_desk', 'desk alpha', 2_068, 20_680_000_000_000_000_000_000n), null, 'exactly the storage is enough');
  assert.equal(depositRefusal('set_policy', 'set_policy on desk alpha', 0, 1n), null, '1 yocto when nothing was added');
  assert.match(depositRefusal('set_policy', 'x', 10, 0n) ?? '', /^E_NOT_ALLOWED: set_policy needs a deposit of at least 1 yoctoNEAR/);
});

test('the largest valid policy of the model is the one the contract caps its tests with (the literals are still in that test)', () => {
  const tests = readFileSync(fileURLToPath(new URL('../../../contract/src/tests.rs', import.meta.url)), 'utf8');
  const start = tests.indexOf('fn the_storage_each_owner_method_adds');
  assert.ok(start >= 0, 'the contract’s measurement test exists');
  const body = tests.slice(start, tests.indexOf('\n}\n', start));
  // The caps it asserts: 4,500 and 12,500 bytes for a desk, 8,000 for set_policy, 100 for the receiver, 500 for the IP list.
  for (const cap of ['4_500', '12_500', '8_000', '100', '500']) assert.match(body, new RegExp(`\\b${cap}\\b`), `the contract's cap ${cap}`);
  assert.match(body, /Policy::largest_valid\(\)/);
});
