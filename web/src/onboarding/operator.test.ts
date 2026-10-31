import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addOperatorKeyAction, DEFAULT_ALLOWANCE_NEAR, hasOperatorKey, isPublicKey, OPERATOR_GROUPS, OPERATOR_METHODS, type AccessKeyInfo } from './operator.ts';
import { fakeEd25519 } from './fakes.ts';

const KEY = fakeEd25519('test key');
const CONTRACT = 'gimbal-c6-fcf135.testnet';

/** The methods with a mark in the Operator column of the table in docs/interfaces.md §1.3. */
function methodsInTable(): string[] {
  const doc = readFileSync(fileURLToPath(new URL('../../../docs/interfaces.md', import.meta.url)), 'utf8');
  const start = doc.indexOf('### 1.3 Who may call what');
  const end = doc.indexOf('\n### 1.4', start);
  assert.ok(start >= 0 && end > start, 'the §1.3 section exists');
  const out: string[] = [];
  for (const line of doc.slice(start, end).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const method = /^`([a-z_0-9]+)\(/.exec(cells[1] ?? '')?.[1];
    if (method !== undefined && (cells[3] ?? '') !== '') out.push(method);
  }
  return out;
}

test('the operator key’s method list is the table of docs/interfaces.md §1.3, nothing more, nothing less', () => {
  const fromTable = methodsInTable();
  assert.equal(fromTable.length, 19);
  assert.deepEqual([...OPERATOR_METHODS].sort(), [...fromTable].sort());
  assert.equal(new Set(OPERATOR_METHODS).size, OPERATOR_METHODS.length, 'no method twice');
});

test('the owner methods are not on the list: the key must not be able to move money out', () => {
  for (const owner of ['create_desk', 'set_policy', 'set_operator', 'withdraw_to_owner', 'hl_withdraw', 'panic_close', 'set_orderly_receiver', 'set_orderly_ips']) {
    assert.equal((OPERATOR_METHODS as readonly string[]).includes(owner), false, owner);
  }
});

test('the groups shown to the owner cover every method exactly once', () => {
  const grouped = OPERATOR_GROUPS.flatMap((g) => [...g.methods]);
  assert.deepEqual([...grouped].sort(), [...OPERATOR_METHODS].sort());
});

test('the AddKey action: the gimbal contract as receiver, the 19 methods, the allowance in yoctoNEAR', () => {
  const action = addOperatorKeyAction(KEY, CONTRACT, DEFAULT_ALLOWANCE_NEAR);
  assert.equal(action.type, 'AddKey');
  if (action.type !== 'AddKey') return;
  assert.equal(action.params.publicKey, KEY);
  assert.deepEqual(action.params.accessKey.permission, { receiverId: CONTRACT, allowance: '5000000000000000000000000', methodNames: [...OPERATOR_METHODS] });
  const half = addOperatorKeyAction(KEY, CONTRACT, '0.5');
  assert.equal(half.type === 'AddKey' && half.params.accessKey.permission.allowance, '500000000000000000000000');
});

test('a key that is not a public key, or an allowance that is not NEAR, is refused', () => {
  assert.throws(() => addOperatorKeyAction('hello', CONTRACT, '5'), /public key/);
  assert.throws(() => addOperatorKeyAction(KEY, CONTRACT, 'five'), /allowance/);
  assert.throws(() => addOperatorKeyAction(KEY, CONTRACT, '0'), /allowance/);
  assert.equal(isPublicKey(KEY), true);
  assert.equal(isPublicKey(`secp256k1:${KEY.slice(8)}`), false);
  assert.equal(isPublicKey('ed25519:short'), false);
});

test('hasOperatorKey wants this key, on this contract, with exactly the operator methods', () => {
  const key = (permission: AccessKeyInfo['permission'], publicKey = KEY): AccessKeyInfo => ({ publicKey, permission });
  const ok = key({ receiverId: CONTRACT, methodNames: [...OPERATOR_METHODS], allowance: '1' });
  assert.equal(hasOperatorKey([ok], KEY, CONTRACT), true);
  assert.equal(hasOperatorKey([], KEY, CONTRACT), false);
  assert.equal(hasOperatorKey([ok], fakeEd25519('other'), CONTRACT), false);
  assert.equal(hasOperatorKey([key('FullAccess')], KEY, CONTRACT), false, 'a full-access key is not the restricted one');
  assert.equal(hasOperatorKey([key({ receiverId: 'other.testnet', methodNames: [...OPERATOR_METHODS], allowance: '1' })], KEY, CONTRACT), false);
  assert.equal(hasOperatorKey([key({ receiverId: CONTRACT, methodNames: OPERATOR_METHODS.slice(1), allowance: '1' })], KEY, CONTRACT), false);
  assert.equal(hasOperatorKey([key({ receiverId: CONTRACT, methodNames: [...OPERATOR_METHODS, 'withdraw_to_owner'], allowance: '1' })], KEY, CONTRACT), false, 'an extra method is too much');
});
