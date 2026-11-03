// keys.mjs on a fake mainnet RPC: list prints public keys and permissions only; delete is a dry run by default and
// refuses a missing key, a full-access key, the signing key and a key file that is not full access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b58encode } from '../testnet/near.mjs';
import { UsageError } from './cli.mjs';
import { parseKeysArgs, permissionText, runKeys } from './keys.mjs';
import { newKeyFile } from './near.mjs';

// Made-up ids: an implicit owner account and a canary receiver that no longer exists.
const OWNER = 'cd'.repeat(32);
const GONE = 'old-canary.near';
const LIVE = 'gimbal-live.near';
const pk = (byte) => `ed25519:${b58encode(Buffer.alloc(32, byte))}`;
const OLD_OPERATOR = pk(3);
const OPERATOR = pk(4);
const NOW = Date.parse('2026-11-03T12:00:00Z');
const DELETE_KEY_FEE = { execution: 94946625000, send_not_sir: 94946625000, send_sir: 94946625000 };
const FEE = { execution: 1, send_not_sir: 1, send_sir: 1 };

const fc = (receiver, methods, allowance) => ({ FunctionCall: { receiver_id: receiver, method_names: methods, allowance } });

/** A fake mainnet: the owner holds `full` full-access keys plus the two operator keys. */
function world({ full = [], sendFails = false, keyStays = false } = {}) {
  const seen = { sent: [], reads: 0 };
  const keys = [
    ...full.map((k) => ({ public_key: k, access_key: { nonce: 1, permission: 'FullAccess' } })),
    { public_key: OLD_OPERATOR, access_key: { nonce: 7, permission: fc(GONE, ['hl_order', 'set_paused'], '4980000000000000000000000') } },
    { public_key: OPERATOR, access_key: { nonce: 9, permission: fc(LIVE, ['hl_order'], null) } },
  ];
  let deleted = null;
  const client = {
    rpc: async (method) => {
      if (method === 'status') return { chain_id: 'mainnet', sync_info: { latest_block_height: 123 } };
      if (method === 'gas_price') return { gas_price: '100000000' };
      throw new Error(`unexpected rpc ${method}`);
    },
    account: async (id) => (id === OWNER ? { amount: '2000000000000000000000000', locked: '0', storage_usage: 1000 } : id === LIVE ? { amount: '1', locked: '0', storage_usage: 0, code_hash: 'Code1111' } : null),
    accessKeys: async (id) => (id === OWNER ? keys.filter((k) => k.public_key !== deleted) : []),
    accessKey: async (id, key) => {
      seen.reads += 1;
      const k = id === OWNER ? keys.find((x) => x.public_key === key && x.public_key !== deleted) : undefined;
      return k === undefined ? null : { ...k.access_key, block_hash: 'x' };
    },
    fees: async () => ({ receipt: FEE, deploy: FEE, deployByte: FEE, call: FEE, callByte: FEE, addKey: FEE, addKeyByte: FEE, deleteKey: DELETE_KEY_FEE }),
    send: async (signer, receiver, actions, { onSent } = {}) => {
      seen.sent.push({ signer: signer.accountId, key: signer.publicKeyString, receiver, actions });
      onSent?.('TxHash1');
      if (!sendFails && !keyStays) deleted = actions[0].publicKey;
      return { hash: 'TxHash1', value: null, failure: sendFails ? { ActionError: { kind: 'DeleteKeyDoesNotExist' } } : null, logs: [], burntTgas: 0.2, burntYocto: 20000000000000000000n };
    },
  };
  return { seen, deps: { near: client, now: () => NOW, tree: null } };
}

async function capture(argv, deps) {
  const lines = [];
  try {
    const block = await runKeys(argv, { ...deps, say: (s = '') => lines.push(s) });
    return { out: lines.join('\n'), block, error: null };
  } catch (error) {
    return { out: lines.join('\n'), block: null, error };
  }
}

/** A real key file for OWNER in a temp folder, and its private key (to prove it is never printed). */
function ownerKeyFile() {
  const file = join(mkdtempSync(join(tmpdir(), 'gimbal-keys-')), 'owner.json');
  const publicKey = newKeyFile(file, OWNER);
  return { file, publicKey, secret: JSON.parse(readFileSync(file, 'utf8')).private_key };
}

test('arguments: list <account>; delete <account> <public_key> --key-file <file> [--send]', () => {
  assert.deepEqual(parseKeysArgs(['list', OWNER]), { command: 'list', account: OWNER, publicKey: null, keyFile: null, send: false });
  assert.deepEqual(parseKeysArgs(['delete', OWNER, OLD_OPERATOR, '--key-file', 'k.json']), { command: 'delete', account: OWNER, publicKey: OLD_OPERATOR, keyFile: 'k.json', send: false });
  assert.equal(parseKeysArgs(['delete', OWNER, OLD_OPERATOR, '--key-file', 'k.json', '--send']).send, true);
  const usage = (argv, re) => assert.throws(() => parseKeysArgs(argv), (e) => e instanceof UsageError && re.test(e.message), argv.join(' '));
  usage([], /one of list, delete/);
  usage(['add', OWNER], /one of list, delete/);
  usage(['list', 'owner.testnet'], /not a mainnet account/);
  usage(['list', OWNER, OLD_OPERATOR], /unexpected argument/);
  usage(['list', OWNER, '--send'], /list takes no options/);
  usage(['delete', OWNER], /needs the public key/);
  usage(['delete', OWNER, 'ed25519:short', '--key-file', 'k.json'], /not an ed25519 public key/);
  usage(['delete', OWNER, OLD_OPERATOR], /needs --key-file/);
  usage(['delete', OWNER, OLD_OPERATOR, OPERATOR, '--key-file', 'k.json'], /unexpected argument/);
});

test('permissions as one line: FullAccess, or receiver, methods and allowance', () => {
  assert.equal(permissionText('FullAccess'), 'FullAccess');
  assert.equal(permissionText(fc('g.near', ['a', 'b'], '5000000000000000000000000'), ' (account exists)'),
    'FunctionCall receiver g.near (account exists), 2 methods ["a","b"], allowance 5 NEAR left');
  assert.equal(permissionText(fc('g.near', [], null)), 'FunctionCall receiver g.near, any method, no allowance limit');
});

test('list: every key with its permission and whether the receiver still exists; reads only, signs nothing', async () => {
  const k = ownerKeyFile();
  const { seen, deps } = world({ full: [k.publicKey] });
  const r = await capture(['list', OWNER], deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /^gimbal keys list (cd)+: read only$/m);
  assert.match(r.out, /3 keys, 1 full access, 2 function call/);
  assert.deepEqual(r.block, [
    '=== gimbal keys 2026-11-03T12:00:00.000Z ===',
    `account ${OWNER}, list (read only)`,
    `key:     ${k.publicKey}  FullAccess`,
    `key:     ${OLD_OPERATOR}  FunctionCall receiver ${GONE} (no such account), 2 methods ["hl_order","set_paused"], allowance 4.98 NEAR left`,
    `key:     ${OPERATOR}  FunctionCall receiver ${LIVE} (account exists, has contract code), 1 method ["hl_order"], no allowance limit`,
    '=== end ===',
  ]);
  assert.equal(seen.sent.length, 0);
  assert.ok(!r.out.includes(k.secret));
});

test('delete dry run: the DeleteKey transaction printed, the key file not read, nothing signed', async () => {
  const { seen, deps } = world({ full: [pk(1)] });
  let read = false;
  const r = await capture(['delete', OWNER, OLD_OPERATOR, '--key-file', 'owner.json'], { ...deps, readKey: () => { read = true; throw new Error('no key in a dry run'); } });
  assert.equal(r.error, null, r.error?.stack);
  assert.equal(read, false);
  assert.equal(seen.sent.length, 0);
  assert.match(r.out, new RegExp(`delete {4}${OLD_OPERATOR} {2}FunctionCall receiver ${GONE} \\(no such account\\)`));
  assert.match(r.out, new RegExp(`signer {4}${OWNER} {2}\\(--key-file owner\\.json, read at --send; it must be a full-access key of ${OWNER}\\)`));
  assert.ok(r.out.includes(`action 1  DeleteKey ${OLD_OPERATOR}: the access key is removed from ${OWNER}`));
  // Receipt + DeleteKey fees, both sir: 2 + 94,946,625,000 x 2 gas = 0.2 TGas; at 1e8 yocto/gas about 0.000019 NEAR.
  assert.match(r.out, /gas {7}at most 0\.2 TGas of action fees, 0\.000019 NEAR at 100000000 yocto\/gas; no deposit/);
  assert.deepEqual(r.block.slice(1, -1), [
    `account ${OWNER}, delete ${OLD_OPERATOR}, dry run`,
    `key:     ${OLD_OPERATOR}  FunctionCall receiver ${GONE} (no such account), 2 methods ["hl_order","set_paused"], allowance 4.98 NEAR left`,
    'open:    the DeleteKey is not sent: run the same command with --send from the main checkout',
  ]);
  assert.match(r.out, /dry run: nothing was signed or sent/);
});

test('delete refuses a key the account does not have and a full-access key', async () => {
  const { seen, deps } = world({ full: [pk(1)] });
  const missing = await capture(['delete', OWNER, pk(8), '--key-file', 'k.json'], deps);
  assert.match(missing.error?.message ?? '', new RegExp(`${OWNER} has no key ${pk(8)}: nothing to delete`));
  const fullKey = await capture(['delete', OWNER, pk(1), '--key-file', 'k.json'], deps);
  assert.match(fullKey.error?.message ?? '', /is a full-access key of .*: this script deletes FunctionCall keys only/);
  const nobody = await capture(['delete', 'nobody.near', OLD_OPERATOR, '--key-file', 'k.json'], deps);
  assert.match(nobody.error?.message ?? '', /nobody\.near does not exist on mainnet/);
  assert.equal(seen.sent.length, 0);
});

test('delete --send refuses the key that would sign it, a key file that is not full access, and a linked worktree', async () => {
  const { seen, deps } = world({ full: [pk(1)] });
  const self = await capture(['delete', OWNER, OLD_OPERATOR, '--key-file', 'k.json', '--send'], { ...deps, readKey: () => ({ accountId: OWNER, publicKeyString: OLD_OPERATOR }) });
  assert.match(self.error?.message ?? '', /--key-file is the key to delete: .*nothing was signed/);
  const notFull = await capture(['delete', OWNER, OLD_OPERATOR, '--key-file', 'k.json', '--send'], { ...deps, readKey: () => ({ accountId: OWNER, publicKeyString: OPERATOR }) });
  assert.match(notFull.error?.message ?? '', new RegExp(`--key-file is not a full-access key of ${OWNER}: nothing was signed`));
  const stranger = await capture(['delete', OWNER, OLD_OPERATOR, '--key-file', 'k.json', '--send'], { ...deps, readKey: () => ({ accountId: OWNER, publicKeyString: pk(6) }) });
  assert.match(stranger.error?.message ?? '', /is not a full-access key/);
  const tree = await capture(['delete', OWNER, OLD_OPERATOR, '--key-file', 'k.json', '--send'], { ...deps, tree: '/some/worktree' });
  assert.match(tree.error?.message ?? '', /is a linked git worktree: --send runs from the main checkout only/);
  assert.equal(tree.out, '', 'refused before anything is read');
  assert.equal(seen.sent.length, 0);
});

test('delete --send: one DeleteKey signed by the full-access key file, the key gone after; the private key never printed', async () => {
  const k = ownerKeyFile();
  const { seen, deps } = world({ full: [k.publicKey] });
  const r = await capture(['delete', OWNER, OLD_OPERATOR, '--key-file', k.file, '--send'], deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.deepEqual(seen.sent.map((s) => [s.signer, s.key, s.receiver, s.actions]), [[OWNER, k.publicKey, OWNER, [{ type: 'DeleteKey', publicKey: OLD_OPERATOR }]]]);
  assert.deepEqual(r.block.slice(1, -1), [
    `account ${OWNER}, delete ${OLD_OPERATOR}, SEND`,
    'delete:  tx TxHash1 succeeded',
    `key:     ${OLD_OPERATOR} is no longer a key of ${OWNER}`,
  ]);
  assert.ok(!r.out.includes(k.secret));
  assert.ok(!r.out.includes(k.secret.slice('ed25519:'.length, 20)));
});

test('delete --send: a failed transaction or a key still there is an open line and a refusal', async () => {
  const k = ownerKeyFile();
  const failed = world({ full: [k.publicKey], sendFails: true });
  const f = await capture(['delete', OWNER, OLD_OPERATOR, '--key-file', k.file, '--send'], failed.deps);
  assert.match(f.error?.message ?? '', /DeleteKey TxHash1:/);
  assert.ok(f.out.includes(`open:    ${OLD_OPERATOR} is still a key of ${OWNER}: look up https://nearblocks.io/txns/TxHash1`), f.out);
  const stays = world({ full: [k.publicKey], keyStays: true });
  const s = await capture(['delete', OWNER, OLD_OPERATOR, '--key-file', k.file, '--send'], stays.deps);
  assert.match(s.error?.message ?? '', /is still a key of .* after TxHash1/);
});
