import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakeEd25519 } from '../onboarding/fakes.ts';
import { OPERATOR_METHODS, type AccessKeyInfo } from '../onboarding/operator.ts';
import { allowanceText, OTHER_CALLERS, OWNER_ONLY, readKeys, RESUME } from './keys.ts';

const CONTRACT = 'gimbal-c6-fcf135.testnet';
const NEAR = 10n ** 24n;

const operatorKey = (allowance: string | null, methodNames: readonly string[] = OPERATOR_METHODS, receiverId = CONTRACT): AccessKeyInfo => ({
  publicKey: fakeEd25519('engine'),
  permission: { receiverId, methodNames: [...methodNames], allowance },
});

interface TableRow {
  method: string;
  owner: string;
  operator: string;
}

/** The rows of the table in docs/interfaces.md §1.3: the method, and what stands under Owner and Operator. */
function table(): TableRow[] {
  const doc = readFileSync(fileURLToPath(new URL('../../../docs/interfaces.md', import.meta.url)), 'utf8');
  const start = doc.indexOf('### 1.3 Who may call what');
  const end = doc.indexOf('\n### 1.4', start);
  assert.ok(start >= 0 && end > start, 'the §1.3 section exists');
  const rows: TableRow[] = [];
  for (const line of doc.slice(start, end).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const method = /^`([a-z_0-9]+)\(/.exec(cells[1] ?? '')?.[1];
    if (method !== undefined) rows.push({ method, owner: cells[2] ?? '', operator: cells[3] ?? '' });
  }
  return rows;
}

test('an allowance is shown in NEAR and rounded down, never up', () => {
  assert.equal(allowanceText((5n * NEAR).toString()), '5');
  assert.equal(allowanceText('4999700000000000000000000'), '4.9997');
  assert.equal(allowanceText('4999999999999999999999999'), '4.9999', 'a hair under 5 NEAR does not read as 5');
  assert.equal(allowanceText('50000000000000000000'), '0', 'less than 0.0001 NEAR left');
  assert.equal(allowanceText('0'), '0');
  assert.equal(allowanceText('12'), '0');
  assert.equal(allowanceText(String(10n * NEAR + NEAR / 2n)), '10.5');
  assert.equal(allowanceText('not a number'), null);
  assert.equal(allowanceText(''), null);
});

test('only function-call keys to this contract are operator keys; wallets are counted, other receivers are left out', () => {
  const read = readKeys(
    [
      { publicKey: fakeEd25519('wallet'), permission: 'FullAccess' },
      operatorKey((5n * NEAR).toString()),
      operatorKey((5n * NEAR).toString(), ['transfer'], 'other.testnet'),
      { publicKey: fakeEd25519('wallet 2'), permission: 'FullAccess' },
    ],
    CONTRACT,
  );
  assert.equal(read.fullAccess, 2);
  assert.equal(read.keys.length, 1);
  assert.equal(read.keys[0]!.allowance, '5');
});

test('a key with the full operator list holds all 21 methods in the owner’s groups and nothing else', () => {
  const [key] = readKeys([operatorKey(null)], CONTRACT).keys;
  assert.ok(key);
  assert.equal(key.allowance, null, 'no allowance limit');
  assert.equal(key.noMethodList, false);
  assert.deepEqual(key.extra, []);
  assert.deepEqual(key.groups.flatMap((g) => g.methods).sort(), [...OPERATOR_METHODS].sort());
  assert.deepEqual(
    key.groups.map((g) => g.label),
    ['Hyperliquid', 'Phoenix and Solana', 'Orderly', 'Moving margin', 'Housekeeping'],
  );
});

test('a narrower key shows only what it holds; a method outside the operator list is called out', () => {
  const [key] = readKeys([operatorKey('1', ['hl_order', 'hl_cancel', 'withdraw_to_owner'])], CONTRACT).keys;
  assert.ok(key);
  assert.deepEqual(key.groups.map((g) => g.label), ['Hyperliquid']);
  assert.deepEqual(key.groups[0]!.methods, ['hl_order', 'hl_cancel']);
  assert.deepEqual(key.extra, ['withdraw_to_owner']);
});

test('a key with no method list is NEAR’s "every method": it is flagged, not shown as empty', () => {
  const [key] = readKeys([operatorKey('1', [])], CONTRACT).keys;
  assert.ok(key);
  assert.equal(key.noMethodList, true);
  assert.deepEqual(key.groups, []);
});

test('the owner-only list is the table of docs/interfaces.md §1.3: owner ✓, nothing under Operator', () => {
  const fromTable = table()
    .filter((r) => r.owner === '✓' && r.operator === '')
    .map((r) => r.method);
  assert.equal(fromTable.length, 9);
  assert.deepEqual(OWNER_ONLY.map((o) => o.method).sort(), fromTable.sort());
});

test('every row of the table is accounted for: operator key, owner only, resume, or another caller', () => {
  const known = new Set<string>([...OPERATOR_METHODS, ...OWNER_ONLY.map((o) => o.method), ...OTHER_CALLERS]);
  for (const row of table()) assert.ok(known.has(row.method), `${row.method} is on the screen`);
  assert.ok(known.size >= table().length);
});

test('resuming is the one operator method the key cannot make in full: it is on the operator list and on its own line', () => {
  assert.equal(RESUME.method, 'set_paused');
  assert.ok((OPERATOR_METHODS as readonly string[]).includes(RESUME.method));
  const row = table().find((r) => r.method === 'set_paused');
  assert.ok(row);
  assert.equal(row.operator, 'pause only');
});
