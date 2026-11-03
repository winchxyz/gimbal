import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { b58decode, b58encode } from '../testnet/near.mjs';
import {
  NO_CODE, PRIVATE_KEY_OF_FILE, RPC_URLS, act, assertNotInLinkedWorktree, ceilToTenth, createClient, describeTx, encodeTransaction,
  feesOf, freeBalance, fullAccessVerdict, isFunctionCallKey, isMainnetId, linkedWorktreeOf, mainnetId, nearText, newKeyFile, parseNear,
  nearTextUp, readKeyFile, tgasText, topLevelNearId, txGasCap, writeEnvFile,
} from './near.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'gimbal-mainnet-'));
const NEAR = 10n ** 24n;

test('mainnet ids: <name>.near and 64-hex implicit accounts only', () => {
  for (const id of ['gimbal.near', 'gimbal-canary.near', 'a_b.c.near', 'f'.repeat(64)]) assert.equal(isMainnetId(id), true, id);
  for (const id of ['gimbal.testnet', 'near', 'v1.signer', 'Gimbal.near', '.near', 'a..near', 'x-.near', `0x${'a'.repeat(40)}`, 'f'.repeat(63), '', null, 7]) {
    assert.equal(isMainnetId(id), false, String(id));
  }
  assert.throws(() => mainnetId('owner.testnet', 'owner'), /owner "owner.testnet" is not a mainnet account.*mainnet only/);
  assert.equal(topLevelNearId('gimbal-canary.near'), 'gimbal-canary.near');
  assert.throws(() => topLevelNearId('sub.gimbal.near'), /not a top-level <name>\.near/);
  assert.throws(() => topLevelNearId('f'.repeat(64)), /not a top-level/);
});

test('NEAR amounts: exact parsing, exact and cut printing, rounding up to 0.1', () => {
  assert.equal(parseNear('6.2'), 62n * 10n ** 23n);
  assert.equal(parseNear('5'), 5n * NEAR);
  assert.equal(parseNear('0.000000000000000000000001'), 1n);
  for (const bad of ['', '-1', '1e3', '1.', '.5', '1.0000000000000000000000001', ' 1', undefined]) assert.throws(() => parseNear(bad), /not a NEAR amount/, String(bad));
  assert.equal(nearText(62n * 10n ** 23n), '6.2');
  assert.equal(nearText(5n * NEAR), '5');
  assert.equal(nearText(6197020000000000000000000n, 4), '6.1970');
  assert.equal(ceilToTenth(6197020000000000000000000n), 62n * 10n ** 23n);
  assert.equal(ceilToTenth(62n * 10n ** 23n), 62n * 10n ** 23n);
});

test('free balance: the balance less the storage its state needs, locked stake counting towards it', () => {
  assert.equal(freeBalance({ amount: String(10n * NEAR), locked: '0', storage_usage: 100_000 }), 9n * NEAR);
  assert.equal(freeBalance({ amount: String(10n * NEAR), locked: String(5n * NEAR), storage_usage: 100_000 }), 10n * NEAR);
  assert.equal(freeBalance({ amount: '1', locked: '0', storage_usage: 100_000 }), 0n);
});

const reply = (json, status = 200) => ({ status, json: async () => json });
function chainFetch(chain, calls = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push([new URL(url).host, body.method]);
    if (body.method === 'status') return reply({ jsonrpc: '2.0', result: { chain_id: chain } });
    return reply({ jsonrpc: '2.0', result: { ok: true } });
  };
}
const noPause = async () => {};

test('mainnet only: an RPC endpoint serving testnet is refused before the first call goes through it', async () => {
  const calls = [];
  const client = createClient({ urls: ['https://rpc.example'], fetch: chainFetch('testnet', calls), pause: noPause });
  await assert.rejects(client.rpc('block', { finality: 'final' }), /rpc\.example serves chain "testnet", not mainnet: refusing/);
  assert.deepEqual(calls.map((c) => c[1]), ['status'], 'nothing but status reached the testnet endpoint');
  const ok = createClient({ urls: ['https://rpc.example'], fetch: chainFetch('mainnet', calls), pause: noPause });
  assert.deepEqual(await ok.rpc('block', { finality: 'final' }), { ok: true });
});

test('mainnet only: send refuses a testnet signer or receiver before it touches the network', async () => {
  const client = createClient({ urls: ['https://rpc.example'], fetch: async () => assert.fail('no request may be made'), pause: noPause });
  const signer = { accountId: 'owner.testnet', publicKey: Buffer.alloc(32), publicKeyString: 'ed25519:x', sign: () => Buffer.alloc(64) };
  await assert.rejects(client.send(signer, 'gimbal.near', []), /signer "owner.testnet" is not a mainnet account/);
  await assert.rejects(client.send({ ...signer, accountId: 'owner.near' }, 'gimbal.testnet', []), /receiver "gimbal.testnet" is not a mainnet account/);
  await assert.rejects(client.view('gimbal.testnet', 'config'), /contract "gimbal.testnet" is not a mainnet account/);
  await assert.rejects(client.account('gimbal.testnet'), /not a mainnet account/);
});

test('an answer with neither result nor error is retried on the next endpoint, never taken as a result', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push([new URL(url).host, body.method]);
    if (body.method === 'status') return reply({ jsonrpc: '2.0', result: { chain_id: 'mainnet' } });
    if (new URL(url).host === 'deprecated.example') return reply({ jsonrpc: '2.0', message: 'this endpoint is deprecated' }, 429);
    return reply({ jsonrpc: '2.0', result: { height: 7 } });
  };
  const client = createClient({ urls: ['https://deprecated.example', 'https://good.example'], fetch, pause: noPause });
  assert.deepEqual(await client.rpc('block', { finality: 'final' }), { height: 7 });
  assert.deepEqual(calls.filter((c) => c[1] === 'block').map((c) => c[0]), ['deprecated.example', 'good.example']);
  const only = createClient({ urls: ['https://deprecated.example'], fetch, pause: noPause });
  await assert.rejects(only.rpc('block', { finality: 'final' }), /neither result nor error/);
});

test('the default endpoints: NEAR_RPC_URL from the shell, then public mainnet endpoints; not the deprecated rpc.mainnet.near.org', () => {
  assert.equal(RPC_URLS.includes('https://rpc.mainnet.near.org'), false);
  assert.deepEqual(RPC_URLS.slice(-2), ['https://free.rpc.fastnear.com', 'https://near.drpc.org']);
});

// The mainnet runtime's fees as EXPERIMENTAL_protocol_config gave them on 2026-10-31 (protocol 86), cut to the
// entries txGasCap reads.
const PROTOCOL_CONFIG = {
  runtime_config: {
    transaction_costs: {
      action_receipt_creation_config: { execution: 108059500000, send_not_sir: 108059500000, send_sir: 108059500000 },
      action_creation_config: {
        deploy_contract_cost: { execution: 184765750000, send_not_sir: 184765750000, send_sir: 184765750000 },
        deploy_contract_cost_per_byte: { execution: 64572944, send_not_sir: 47683715, send_sir: 6812999 },
        function_call_cost: { execution: 780000000000, send_not_sir: 200000000000, send_sir: 200000000000 },
        function_call_cost_per_byte: { execution: 2235934, send_not_sir: 47683715, send_sir: 2235934 },
        add_key_cost: {
          function_call_cost: { execution: 102217625000, send_not_sir: 102217625000, send_sir: 102217625000 },
          function_call_cost_per_byte: { execution: 1925331, send_not_sir: 47683715, send_sir: 1925331 },
        },
      },
    },
  },
};

test('gas caps: prepaid gas plus the action fees, DeployContract at about 71 Mgas per byte', () => {
  const fees = feesOf(PROTOCOL_CONFIG);
  const code = Buffer.alloc(569_702);
  const tx2 = txGasCap(fees, { signer: 'g.near', receiver: 'g.near', actions: [act.deploy(code, 'x'), act.call('new', { network: 'Mainnet' }, 100, 0n)] });
  // DeployContract: 184,765,750,000 x 2 + 569,702 x (6,812,999 + 64,572,944) = 41,038,337,221,486 gas, about 41 TGas.
  assert.equal(tx2.deploy, 184_765_750_000n * 2n + 569_702n * (6_812_999n + 64_572_944n));
  assert.equal(tgasText(tx2.deploy), '41.1', 'rounded up: an upper bound stays one');
  assert.equal(tx2.prepaid, 100n * 10n ** 12n);
  const args = Buffer.byteLength('new') + Buffer.byteLength(JSON.stringify({ network: 'Mainnet' }));
  assert.equal(tx2.fees, 108_059_500_000n * 2n + 200_000_000_000n + 780_000_000_000n + BigInt(args) * (2_235_934n * 2n));
  assert.equal(tx2.total, tx2.deploy + tx2.prepaid + tx2.fees);
  assert.equal(tgasText(tx2.total), '142.3', 'tx 2 of the current wasm: 100 prepaid + 41.04 deploy + 1.2 fees');
  assert.equal(tgasText(100n * 10n ** 12n), '100.0');
  assert.equal(nearTextUp(14_224_000_000_000_000_000_000n, 4), '0.0143');
  assert.equal(nearTextUp(10n ** 22n, 4), '0.0100', 'an exact amount is not rounded up');
  // A call to another account pays the not-sir send fees.
  const tx1 = txGasCap(fees, { signer: 'f.near', receiver: 'near', actions: [act.call('create_account', {}, 100, 1n)] });
  assert.equal(tx1.fees, 108_059_500_000n * 2n + 200_000_000_000n + 780_000_000_000n + BigInt(Buffer.byteLength('create_account{}')) * (47_683_715n + 2_235_934n));
  // AddKey: the base fee plus each method name's bytes and one more per name.
  const key = txGasCap(fees, { signer: 'o.near', receiver: 'o.near', actions: [act.functionCallKey(OP_KEY, 'g.near', ['ab', 'cde'], 1n)] });
  assert.equal(key.total, 108_059_500_000n * 2n + 102_217_625_000n * 2n + 7n * (1_925_331n * 2n));
  assert.throws(() => feesOf({}), /no receipt fee/);
});

test('key files are never written into a linked git worktree: .git as a file marks one, a .git directory the main checkout', () => {
  const tree = tmp();
  writeFileSync(join(tree, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  mkdirSync(join(tree, '.keys'));
  const inTree = join(tree, '.keys', 'gimbal-canary.near.json');
  assert.equal(linkedWorktreeOf(inTree), tree);
  assert.throws(() => assertNotInLinkedWorktree(inTree, 'the contract account\'s key'), (e) => e.message.includes(tree) && /Run from the main checkout/.test(e.message));
  const main = tmp();
  mkdirSync(join(main, '.git'));
  mkdirSync(join(main, '.keys'));
  assert.equal(linkedWorktreeOf(join(main, '.keys', 'x.json')), null);
  assert.doesNotThrow(() => assertNotInLinkedWorktree(join(main, '.keys', 'x.json'), 'x'));
  // The nearest .git decides: a main checkout nested in a worktree's folder is a main checkout.
  const nested = join(tree, 'nested');
  mkdirSync(join(nested, '.git'), { recursive: true });
  assert.equal(linkedWorktreeOf(join(nested, 'a.json')), null);
});

test('view_account of a missing account and view_access_key of a missing key are null', async () => {
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'status') return reply({ result: { chain_id: 'mainnet' } });
    if (body.params.request_type === 'view_account') return reply({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } });
    return reply({ result: { error: 'access key ed25519:x does not exist while viewing', logs: [] } });
  };
  const client = createClient({ urls: ['https://rpc.example'], fetch, pause: noPause });
  assert.equal(await client.account('nobody.near'), null);
  assert.equal(await client.accessKey('somebody.near', 'ed25519:x'), null);
});

// Vectors from near-api-js 7.3.1 (createTransaction + encodeTransaction) for the same transactions: signer key 32 x
// 0x07, block hash 32 x 0x01, operator key 32 x 0x09.
const SIGNER = Buffer.alloc(32, 7);
const OP_KEY = `ed25519:${b58encode(Buffer.alloc(32, 9))}`;
const BLOCK = Buffer.alloc(32, 1);
const VECTORS = {
  addKey: '0a0000006f776e65722e6e65617200070707070707070707070707070707070707070707070707070707070707070707000000000000000a0000006f776e65722e6e656172010101010101010101010101010101010101010101010101010101010101010101000000050009090909090909090909090909090909090909090909090909090909090909090000000000000000000100000025a4000a8bca220400000000001200000067696d62616c2d63616e6172792e6e656172030000000a0000007365745f70617573656408000000686c5f6f726465720f0000006f726465726c795f72657175657374',
  createAccount: '0b00000066756e6465722e6e656172000707070707070707070707070707070707070707070707070707070707070707351cdcdf02000000040000006e656172010101010101010101010101010101010101010101010101010101010101010101000000020e0000006372656174655f6163636f756e746e0000007b226e65775f6163636f756e745f6964223a2267696d62616c2d63616e6172792e6e656172222c226e65775f7075626c69635f6b6579223a22656432353531393a634766486943364b6767334670465a7667774763737773435274703461425032667a7558525150697a754e227d00407a10f35a0000000000b3279068ace620050000000000',
  deployInit: '1200000067696d62616c2d63616e6172792e6e65617200070707070707070707070707070707070707070707070707070707070707070701000000000000001200000067696d62616c2d63616e6172792e6e656172010101010101010101010101010101010101010101010101010101010101010102000000010e0000000061736d2d66616b652d636f646502030000006e6577150000007b226e6574776f726b223a224d61696e6e6574227d00407a10f35a000000000000000000000000000000000000',
  // near-api-js 7.3.1: createTransaction('gimbal-canary.near', <7 x 32>, 'gimbal-canary.near', 5n, [actions.deleteAccount('funder.near')], <1 x 32>).
  deleteAccount: '1200000067696d62616c2d63616e6172792e6e65617200070707070707070707070707070707070707070707070707070707070707070705000000000000001200000067696d62616c2d63616e6172792e6e656172010101010101010101010101010101010101010101010101010101010101010101000000070b00000066756e6465722e6e656172',
};

test('DeleteAccount: borsh as near-api-js, its fee in the gas cap, the beneficiary printed; mainnet beneficiaries only', () => {
  const bytes = encodeTransaction({ signerId: 'gimbal-canary.near', publicKey: SIGNER, nonce: 5n, receiverId: 'gimbal-canary.near', blockHash: BLOCK, actions: [act.deleteAccount('funder.near')] });
  assert.equal(bytes.toString('hex'), VECTORS.deleteAccount);
  assert.throws(() => act.deleteAccount('funder.testnet'), /beneficiary "funder\.testnet" is not a mainnet account/);
  const del = { execution: 147489000000, send_not_sir: 147489000000, send_sir: 147489000000 };
  const cfg = structuredClone(PROTOCOL_CONFIG);
  assert.throws(() => txGasCap(feesOf(cfg), { signer: 'g.near', receiver: 'g.near', actions: [act.deleteAccount('f.near')] }), /no delete_account_cost/);
  cfg.runtime_config.transaction_costs.action_creation_config.delete_account_cost = del;
  const cap = txGasCap(feesOf(cfg), { signer: 'g.near', receiver: 'g.near', actions: [act.deleteAccount('f.near')] });
  assert.equal(cap.prepaid, 0n);
  assert.equal(cap.total, 108_059_500_000n * 2n + 147_489_000_000n * 2n);
  const lines = describeTx('tx', { signer: 'g.near', signedBy: 'its key', receiver: 'g.near', actions: [act.deleteAccount('f.near')] }).join('\n');
  assert.match(lines, /DeleteAccount: the account g\.near is deleted; its whole NEAR balance goes to the beneficiary f\.near/);
});

test('DeleteKey: borsh as near-api-js, its fee in the gas cap, the key printed; only an ed25519 key', () => {
  // near-api-js 7.3.1: createTransaction('owner.near', <7 x 32>, 'owner.near', 5n, [actions.deleteKey(<9 x 32>)], <1 x 32>).
  const vector = '0a0000006f776e65722e6e65617200070707070707070707070707070707070707070707070707070707070707070705000000000000000a0000006f776e65722e6e65617201010101010101010101010101010101010101010101010101010101010101010100000006000909090909090909090909090909090909090909090909090909090909090909';
  const bytes = encodeTransaction({ signerId: 'owner.near', publicKey: SIGNER, nonce: 5n, receiverId: 'owner.near', blockHash: BLOCK, actions: [act.deleteKey(OP_KEY)] });
  assert.equal(bytes.toString('hex'), vector);
  assert.throws(() => act.deleteKey('ed25519:short'), /is not an ed25519 public key/);
  assert.throws(() => act.deleteKey(`secp256k1:${b58encode(Buffer.alloc(64, 9))}`), /is not an ed25519 public key/);
  // The mainnet fee, EXPERIMENTAL_protocol_config on 2026-11-03 (protocol 86).
  const del = { execution: 94946625000, send_not_sir: 94946625000, send_sir: 94946625000 };
  const cfg = structuredClone(PROTOCOL_CONFIG);
  assert.throws(() => txGasCap(feesOf(cfg), { signer: 'o.near', receiver: 'o.near', actions: [act.deleteKey(OP_KEY)] }), /no delete_key_cost/);
  cfg.runtime_config.transaction_costs.action_creation_config.delete_key_cost = del;
  const cap = txGasCap(feesOf(cfg), { signer: 'o.near', receiver: 'o.near', actions: [act.deleteKey(OP_KEY)] });
  assert.equal(cap.prepaid, 0n);
  assert.equal(cap.total, 108_059_500_000n * 2n + 94_946_625_000n * 2n);
  const lines = describeTx('tx', { signer: 'o.near', signedBy: 'its key', receiver: 'o.near', actions: [act.deleteKey(OP_KEY)] }).join('\n');
  assert.ok(lines.includes(`action 1  DeleteKey ${OP_KEY}: the access key is removed from o.near`), lines);
});

test('borsh transactions match near-api-js: an AddKey with a FunctionCall permission, create_account, deploy + new', () => {
  const tx = (signerId, receiverId, nonce, actions) => encodeTransaction({ signerId, publicKey: SIGNER, nonce, receiverId, blockHash: BLOCK, actions }).toString('hex');
  assert.equal(tx('owner.near', 'owner.near', 7n, [act.functionCallKey(OP_KEY, 'gimbal-canary.near', ['set_paused', 'hl_order', 'orderly_request'], 5n * NEAR)]), VECTORS.addKey);
  assert.equal(tx('funder.near', 'near', 12345678901n, [act.call('create_account', { new_account_id: 'gimbal-canary.near', new_public_key: OP_KEY }, 100n, 62n * 10n ** 23n)]), VECTORS.createAccount);
  assert.equal(tx('gimbal-canary.near', 'gimbal-canary.near', 1n, [act.deploy(Buffer.from('\0asm-fake-code'), 'x'), act.call('new', { network: 'Mainnet' }, 100n)]), VECTORS.deployInit);
});

test('an operator key is never full access: no empty method list, no zero allowance', () => {
  assert.throws(() => act.functionCallKey(OP_KEY, 'gimbal.near', [], NEAR), /empty list allows every method/);
  assert.throws(() => act.functionCallKey(OP_KEY, 'gimbal.near', ['hl_order'], 0n), /allowance above 0/);
  const bytes = encodeTransaction({ signerId: 'o.near', publicKey: SIGNER, nonce: 1n, receiverId: 'o.near', blockHash: BLOCK, actions: [act.functionCallKey(OP_KEY, 'g.near', ['hl_order'], 1n)] });
  // After the action tag (5), the key (1 + 32 bytes) and the nonce (8): permission 0 = FunctionCall, never 1.
  const at = bytes.indexOf(Buffer.from([5, 0, ...Buffer.alloc(32, 9)]));
  assert.ok(at > 0);
  assert.equal(bytes[at + 2 + 32 + 8], 0);
});

test('a planned transaction prints every action with its full args, deposit and gas', () => {
  const lines = describeTx('tx 1', {
    signer: 'funder.near', signedBy: 'checked', receiver: 'near',
    actions: [act.call('create_account', { new_account_id: 'g.near', new_public_key: 'ed25519:k' }, 100n, 62n * 10n ** 23n, { new_account_id: 'g.near', new_public_key: '<shown>' })],
  }).join('\n');
  assert.match(lines, /signer {4}funder\.near {2}\(checked\)/);
  assert.match(lines, /FunctionCall create_account {2}gas 100 TGas {2}deposit 6\.2 NEAR/);
  assert.match(lines, /args \{"new_account_id":"g\.near","new_public_key":"<shown>"\}/, 'the shown args, not the sent ones');
});

test('key-file permission check: only a full-access key on chain matches', () => {
  assert.equal(fullAccessVerdict({ nonce: 1, permission: 'FullAccess' }), 'matches');
  assert.equal(fullAccessVerdict({ nonce: 1, permission: { FunctionCall: { allowance: '1', receiver_id: 'g.near', method_names: [] } } }), 'does not match');
  assert.equal(fullAccessVerdict(null), 'does not match');
  const fc = (receiver_id, method_names) => ({ permission: { FunctionCall: { allowance: '5', receiver_id, method_names } } });
  assert.equal(isFunctionCallKey(fc('g.near', ['a', 'b']), 'g.near', ['b', 'a']), true);
  assert.equal(isFunctionCallKey(fc('g.near', ['a']), 'g.near', ['a', 'b']), false, 'a method short');
  assert.equal(isFunctionCallKey(fc('g.near', ['a', 'b', 'c']), 'g.near', ['a', 'b']), false, 'a method too many');
  assert.equal(isFunctionCallKey(fc('other.near', ['a', 'b']), 'g.near', ['a', 'b']), false, 'another receiver');
  assert.equal(isFunctionCallKey({ permission: 'FullAccess' }, 'g.near', ['a']), false, 'full access is never an operator key');
});

test('key files: written once, read back as a signer, refused for another account, network or public key', () => {
  const dir = tmp();
  const file = join(dir, 'owner.near.json');
  const pk = newKeyFile(file, 'owner.near');
  assert.match(pk, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.throws(() => newKeyFile(file, 'owner.near'), /exists: a key file is never overwritten/);
  const signer = readKeyFile(file, 'owner.near');
  assert.equal(signer.publicKeyString, pk);
  const msg = Buffer.from('gimbal');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), b58decode(pk.slice(8))]);
  assert.equal(verify(null, msg, createPublicKey({ key: spki, format: 'der', type: 'spki' }), signer.sign(msg)), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).network, 'mainnet');

  assert.throws(() => readKeyFile(file, 'someone.near'), /is the key of "owner\.near", not someone\.near/);
  assert.throws(() => readKeyFile(file, 'owner.testnet'), /not a mainnet account/);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const testnetFile = join(dir, 'testnet.json');
  writeFileSync(testnetFile, JSON.stringify({ ...json, network: 'testnet' }));
  assert.throws(() => readKeyFile(testnetFile, 'owner.near'), /a "testnet" key, not mainnet/);
  const otherFile = join(dir, 'other.json');
  writeFileSync(otherFile, JSON.stringify({ ...json, public_key: OP_KEY }));
  assert.throws(() => readKeyFile(otherFile, 'owner.near'), /public_key is not the private key's/);
  const brokenFile = join(dir, 'broken.json');
  writeFileSync(brokenFile, `{"private_key": "ed25519:${'secret'.repeat(4)}"`);
  assert.throws(() => readKeyFile(brokenFile, 'owner.near'), (e) => /not a readable JSON key file/.test(e.message) && !e.message.includes('secret'));
});

test('the engine env file: written once, the private key taken from the key file, never printed', () => {
  const dir = tmp();
  const keyFile = join(dir, 'operator.json');
  newKeyFile(keyFile, 'owner.near');
  const envFile = join(dir, 'engine.env');
  writeEnvFile(envFile, ['header'], [['GIMBAL_MODE', 'mainnet'], ['OPERATOR_ACCOUNT_ID', ''], ['OPERATOR_PRIVATE_KEY', PRIVATE_KEY_OF_FILE]], { keyFile, accountId: 'owner.near' });
  const text = readFileSync(envFile, 'utf8');
  assert.match(text, /^# header\nGIMBAL_MODE=mainnet\nOPERATOR_ACCOUNT_ID=\nOPERATOR_PRIVATE_KEY=ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}\n$/);
  assert.equal(text.split('OPERATOR_PRIVATE_KEY=')[1].trim(), JSON.parse(readFileSync(keyFile, 'utf8')).private_key);
  assert.throws(() => writeEnvFile(envFile, [], [['A', '1']]), /exists: it is never overwritten/);
  assert.throws(() => writeEnvFile(join(dir, 'x.env'), [], [['A', 'one\ntwo']]), /newline/);
  assert.equal(NO_CODE, '11111111111111111111111111111111');
});

test('view.mjs: read-only views of mainnet accounts only; a testnet id, an unknown view or bad JSON ends with the usage', () => {
  const script = fileURLToPath(new URL('./view.mjs', import.meta.url));
  for (const argv of [['gimbal.testnet', 'config'], ['--keys', 'owner.testnet'], ['gimbal.near', 'new'], ['gimbal.near', 'get_desk', '{bad'], ['gimbal.near']]) {
    const r = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', env: { ...process.env, NEAR_RPC_URL: 'http://127.0.0.1:9' } });
    assert.equal(r.status, 2, `${argv.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /usage: node tools\/mainnet\/view\.mjs/);
  }
});
