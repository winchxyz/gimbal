import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UsageError } from './cli.mjs';
import {
  OPERATOR_METHODS, contractConfigProblems, engineEnvEntries, operatorKeyPlan, orderlyAccountId, parseDeskArgs,
} from './desk.mjs';
import { PRIVATE_KEY_OF_FILE } from './near.mjs';
import { MAINNET_ORDERLY_BROKER } from './venues.mjs';

const OK = ['gimbal-canary.near', 'canary', '--owner', 'owner.near', '--policy', 'p.json'];
const usage = (argv, pattern) => assert.throws(() => parseDeskArgs(argv), (e) => e instanceof UsageError && pattern.test(e.message), argv.join(' '));

/** The methods with a mark in the Operator column of the table in docs/interfaces.md §1.3 (as web/src/onboarding does). */
function methodsInTable() {
  const doc = readFileSync(fileURLToPath(new URL('../../docs/interfaces.md', import.meta.url)), 'utf8');
  const start = doc.indexOf('### 1.3 Who may call what');
  const end = doc.indexOf('\n### 1.4', start);
  assert.ok(start >= 0 && end > start, 'the §1.3 section exists');
  const out = [];
  for (const line of doc.slice(start, end).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const method = /^`([a-z_0-9]+)\(/.exec(cells[1] ?? '')?.[1];
    if (method !== undefined && (cells[3] ?? '') !== '') out.push(method);
  }
  return out;
}

test('the operator key may call exactly the methods marked in the Operator column of interfaces §1.3', () => {
  const fromTable = methodsInTable();
  assert.equal(fromTable.length, 19);
  assert.deepEqual(OPERATOR_METHODS, fromTable, 'the same methods, in the table\'s order');
  for (const owner of ['create_desk', 'set_policy', 'set_operator', 'withdraw_to_owner', 'hl_withdraw', 'panic_close', 'set_orderly_receiver', 'set_orderly_ips', 'set_mock_price']) {
    assert.equal(OPERATOR_METHODS.includes(owner), false, `${owner} is the owner's alone`);
  }
});

test('desk arguments: a dry run needs no key file; the allowance defaults to 5 NEAR', () => {
  const a = parseDeskArgs(OK);
  assert.deepEqual(a, { contract: 'gimbal-canary.near', deskId: 'canary', owner: 'owner.near', keyFile: null, policyFile: 'p.json', allowance: 5n * 10n ** 24n, send: false });
  assert.equal(parseDeskArgs([...OK, '--allowance', '2.5']).allowance, 25n * 10n ** 23n);
});

test('desk arguments: every refusal is a usage error, mainnet ids only', () => {
  usage(['gimbal-canary.near'], /contract and the desk id are required/);
  usage([...OK, 'x'], /unexpected argument x/);
  usage(['gimbal-canary.testnet', ...OK.slice(1)], /contract "gimbal-canary\.testnet" is not a mainnet account/);
  usage(['gimbal-canary.near', 'Canary', ...OK.slice(2)], /desk id "Canary" is not 1 to 32 characters/);
  usage(['gimbal-canary.near', 'x'.repeat(33), ...OK.slice(2)], /not 1 to 32 characters/);
  usage([...OK.slice(0, 3), 'owner.testnet', ...OK.slice(4)], /--owner "owner\.testnet" is not a mainnet account/);
  for (const reserved of ['gimbal-canary.near', 'price-oracle.near']) usage([...OK.slice(0, 3), reserved, ...OK.slice(4)], /--owner cannot be/);
  usage(OK.slice(0, 4), /--policy is required/);
  usage([...OK, '--allowance', '0'], /above 0/);
  usage([...OK, '--allowance', '-1'], /needs a value|not a NEAR amount/);
  usage([...OK, '--send'], /--send needs --key-file/);
});

test('the desk\'s Orderly account id is Orderly\'s own (vectors from contract/core/tests/vectors/orderly.json)', () => {
  const v = JSON.parse(readFileSync(fileURLToPath(new URL('../../contract/core/tests/vectors/orderly.json', import.meta.url)), 'utf8'));
  assert.ok(v.account_ids.length > 0);
  for (const a of v.account_ids) assert.equal(orderlyAccountId(a.user_address.toLowerCase(), a.broker_id), a.account_id, a.broker_id);
});

test('config() must be a mainnet canary\'s: Mainnet, v1.signer, OutLayer price-oracle.near, Arbitrum One, the mainnet broker', () => {
  const good = { network: 'Mainnet', mpc: 'v1.signer', price_source: { OutLayer: { contract: 'price-oracle.near' } }, orderly: { broker_id: MAINNET_ORDERLY_BROKER, chain_id: 42161 } };
  assert.deepEqual(contractConfigProblems(good), []);
  assert.match(contractConfigProblems({ ...good, network: 'Testnet' }).join(), /not Mainnet/);
  assert.match(contractConfigProblems({ ...good, mpc: 'v1.signer-prod.testnet' }).join(), /not v1\.signer/);
  assert.match(contractConfigProblems({ ...good, price_source: 'Mock' }).join(), /not OutLayer/);
  assert.match(contractConfigProblems({ ...good, orderly: { broker_id: MAINNET_ORDERLY_BROKER, chain_id: 421614 } }).join(), /not 42161/);
  assert.match(contractConfigProblems({ ...good, orderly: { broker_id: '', chain_id: 42161 } }).join(), /broker_id is empty/);
  for (const other of ['woofi_dex', 'someone_else']) {
    assert.match(contractConfigProblems({ ...good, orderly: { broker_id: other, chain_id: 42161 } }).join(), /not the engine's mainnet broker/, other);
  }
});

test('the operator key on chain: added when missing, skipped when exact, refused with any other permission', () => {
  const fc = (receiver_id, method_names) => ({ permission: { FunctionCall: { allowance: '1', receiver_id, method_names } } });
  assert.equal(operatorKeyPlan(null, 'g.near'), 'add');
  assert.equal(operatorKeyPlan(fc('g.near', [...OPERATOR_METHODS].reverse()), 'g.near'), 'on chain');
  assert.throws(() => operatorKeyPlan({ permission: 'FullAccess' }, 'g.near'), /another permission/);
  assert.throws(() => operatorKeyPlan(fc('g.near', [...OPERATOR_METHODS, 'withdraw_to_owner']), 'g.near'), /another permission/);
  assert.throws(() => operatorKeyPlan(fc('other.near', OPERATOR_METHODS), 'g.near'), /another permission/);
});

test('the engine env: mainnet names the engine reads, the key from the operator key file', () => {
  const entries = engineEnvEntries({ contract: 'g.near', deskId: 'canary', owner: 'o.near', allowance: 5n * 10n ** 24n, brokerId: 'b' });
  const env = Object.fromEntries(entries);
  assert.equal(env.GIMBAL_MODE, 'mainnet');
  assert.equal(env.NEAR_NETWORK, 'mainnet');
  assert.equal(env.GIMBAL_CONTRACT_ID, 'g.near');
  assert.equal(env.DESK_ID, 'canary');
  assert.equal(env.OWNER_ACCOUNT_ID, 'o.near');
  assert.equal(env.OPERATOR_ACCOUNT_ID, '', 'the key sits on the owner account');
  assert.equal(env.OPERATOR_PRIVATE_KEY, PRIVATE_KEY_OF_FILE);
  assert.equal(env.OPERATOR_ALLOWANCE_NEAR, '5');
  assert.equal(env.ORDERLY_BROKER_ID, 'b');
  for (const k of ['HL_API_URL', 'ORDERLY_API_URL', 'PHOENIX_API_URL', 'SOLANA_RPC_URL']) {
    assert.match(env[k], /^https:\/\//, k);
    assert.doesNotMatch(env[k], /testnet|devnet/, k);
  }
});

test('the script itself: a testnet owner ends with the usage, before any network read', () => {
  const script = fileURLToPath(new URL('./desk.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, 'gimbal-canary.near', 'canary', '--owner', 'owner.testnet', '--policy', 'p.json'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /not a mainnet account/);
});
