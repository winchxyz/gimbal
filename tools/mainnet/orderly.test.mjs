// orderly.mjs on a fake mainnet: argument and IP checks, every dry run's exact calls, and --send with fake keys and a
// fake Orderly. Every id here is a placeholder or a public test key of contract/core/tests/vectors (never funded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UsageError } from './cli.mjs';
import { OPERATOR_METHODS, orderlyAccountId } from './desk.mjs';
import {
  ALLOWED_KINDS, MAX_ORDERLY_IPS, OWNER_DEPOSIT, OWNER_TGAS, ipProblem, ipRestrictionBody, ipsActions, kindGuard, opensText, parseIp, parseIpList,
  parseOrderlyArgs, parseReceiver, receiverActions, requestActions, runOrderly,
} from './orderly.mjs';

const CONTRACT = 'gimbal-dex-test.near';
const DESK_ID = 'carry';
const OWNER = 'abababababababababababababababababababababababababababababababab';
const EVM = '0x2db4e285d94fbb1e2bb65c71ad68ee7ae981890f';
const AUTHORITY = '2av18e4xDpvWRgf6qHzutwtbgXvFRRbXWiNkwx3gcJC2';
const ACCOUNT = orderlyAccountId(EVM, 'gimbal_dex');
const RECEIVER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const SECRET = `ed25519:${'5'.repeat(88)}`;
const OP_PUBLIC = `ed25519:${'8'.repeat(44)}`;
const OWNER_PUBLIC = `ed25519:${'7'.repeat(44)}`;
const NOW = Date.parse('2026-11-04T12:00:00Z');
const NEAR = 10n ** 24n;
// Public addresses that are no one's in particular; the documentation ranges are refused by design.
const IP1 = '1.2.3.4';
const IP2 = '2a00:1450::1';

const leb = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
/** A wasm module that exports `names` as functions. */
function wasmWith(names) {
  const str = (s) => [...leb(s.length), ...Buffer.from(s)];
  const body = [...leb(names.length), ...names.flatMap((n) => [...str(n), 0, 0])];
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x07, ...leb(body.length), ...body]);
}
const CODE = wasmWith(['new', 'config', 'get_desk', 'get_desk_settings', 'orderly_request', 'set_orderly_receiver', 'set_orderly_ips']);

const CONFIG = {
  network: 'Mainnet', mpc: 'v1.signer', price_source: { OutLayer: { contract: 'price-oracle.near' } },
  treasury: { near: 'treasury.near', hl_builder: '0x1111111111111111111111111111111111111111', referral_codes: { hyperliquid: null, orderly: null, phoenix: null } },
  fees: { performance_bps: 1000, hl_builder_tenth_bps: 10 },
  orderly: { broker_id: 'gimbal_dex', chain_id: 42161 },
};
const FEE = { send_sir: 100, send_not_sir: 100, execution: 100 };
const FEES = { receipt: FEE, deploy: FEE, deployByte: FEE, call: FEE, callByte: FEE, addKey: FEE, addKeyByte: FEE, deleteAccount: FEE };

const deskOf = (over = {}) => ({
  owner: OWNER, operator: null, paused: false, policy: {}, evm_address: EVM,
  solana: { authority: AUTHORITY, usdc_ata: 'u', phusd_ata: 'p', phoenix_trader: 't' },
  orderly_account_id: ACCOUNT, orderly_receiver: null, orderly_ips: [],
  ledger: { deposited: 0, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 0 },
  ...over,
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake mainnet, Orderly and keys. `o`: desk, applied, code, registered, keyActive, receiverAnswer, ownerKey (the key
 * file's public key), ownerNear, holding, ipRefused (the holding read), ipPostFails (Orderly refuses the ip_restriction
 * POST after the contract signed it), thisIps (this machine's public IPs).
 */
function world(o = {}) {
  let desk = o.desk ?? deskOf();
  let applied = o.applied ?? false;
  const seen = { sent: [], signed: [], fetch: [], keyReads: 0, envReads: 0 };
  const client = {
    rpc: async (method) => {
      if (method === 'status') return { chain_id: 'mainnet', sync_info: { latest_block_height: 1 } };
      if (method === 'gas_price') return { gas_price: '100000000' };
      throw new Error(`unexpected rpc ${method}`);
    },
    account: async (id) => {
      if (id === CONTRACT) return { amount: String(7n * NEAR), locked: '0', storage_usage: 1000, code_hash: 'Code111' };
      if (id === OWNER) return { amount: String(o.ownerNear ?? 2n * NEAR), locked: '0', storage_usage: 500, code_hash: '11111111111111111111111111111111' };
      return null;
    },
    code: async () => o.code ?? CODE,
    view: async (id, method, args) => {
      assert.equal(id, CONTRACT);
      if (method === 'config') return CONFIG;
      if (method === 'get_desk') return args.desk_id === DESK_ID ? desk : null;
      if (method === 'get_desk_settings') return { phoenix_accounts: {}, oneclick_key: null, oneclick_key_from_ms: 0, oneclick_key_active: false, pinned_key_trusted: true, orderly_ips_applied: applied };
      throw new Error(`unexpected view ${method}`);
    },
    accessKey: async (id, key) => {
      if (id === OWNER && key === OWNER_PUBLIC) return { nonce: 1, permission: 'FullAccess' };
      if (id === OWNER && key === OP_PUBLIC) return { nonce: 1, permission: { FunctionCall: { allowance: String(5n * NEAR), receiver_id: CONTRACT, method_names: [...OPERATOR_METHODS] } } };
      return null;
    },
    fees: async () => FEES,
    send: async (signer, receiver, actions, { onSent } = {}) => {
      const hash = `OwnerTx${seen.sent.length + 1}`;
      seen.sent.push({ signer: signer.publicKeyString, receiver, actions });
      onSent?.(hash);
      const a = actions[0];
      const logs = [];
      if (a.method === 'set_orderly_receiver') {
        desk = { ...desk, orderly_receiver: a.args.receiver };
        logs.push(`EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"orderly_receiver_set","data":[{"desk_id":"${DESK_ID}","receiver":"${a.args.receiver}"}]}`);
      }
      if (a.method === 'set_orderly_ips') {
        desk = { ...desk, orderly_ips: a.args.ips };
        applied = false;
        logs.push(`EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"orderly_ips_set","data":[{"desk_id":"${DESK_ID}","ips":${JSON.stringify(a.args.ips)}}]}`);
      }
      return { hash, burntTgas: 3, burntYocto: 10n ** 20n, logs, failure: null, value: null };
    },
  };
  const PATHS = {
    receiver_address: ['GET', '/v1/client/asset/receiver_address?chain_id=42161&token=USDC', () => ''],
    holding: ['GET', '/v1/client/holding', () => ''],
    ip_restriction: ['POST', '/v1/client/set_orderly_key_ip_restriction', () => ipRestrictionBody(AUTHORITY, desk.orderly_ips)],
  };
  const transport = {
    accountId: OWNER,
    publicKey: async () => OP_PUBLIC,
    allowance: async () => 5n * NEAR,
    account: async () => ({ amount: 2n * NEAR, locked: 0n, storageUsage: 500 }),
    view: async (_c, method, args) => client.view(CONTRACT, method, args),
    call: async (contractId, method, args, tgas) => {
      seen.signed.push({ contractId, method, args, tgas });
      assert.equal(method, 'orderly_request');
      const kind = args.req.kind;
      if (kind === 'ip_restriction') applied = true;
      const [m, path, body] = PATHS[kind];
      const t = args.req.timestamp_ms;
      return {
        txHash: `OpTx${seen.signed.length}`, ok: true,
        value: {
          desk_id: DESK_ID, request_id: seen.signed.length, venue: 'orderly', kind,
          payload: { method: m, path, body: body(), timestamp: t, message: `${t}${m}${path}${body()}` },
          signature: { scheme: 'Ed25519', signature: Array(64).fill(1) },
        },
      };
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    seen.fetch.push(`${init.method ?? 'GET'} ${u}${init.body === undefined ? '' : ` ${init.body}`}`);
    if (u.includes('/v1/get_account')) return json(o.registered === false ? { success: false, code: -1607, message: 'Account not found.' } : { success: true, data: { account_id: ACCOUNT } });
    if (u.includes('/v1/get_orderly_key')) {
      return json(o.keyActive === false
        ? { success: false, code: -1617, message: 'orderlyKey is not exist' }
        : { success: true, data: { orderly_key: `ed25519:${AUTHORITY}`, scope: 'read,trading', expiration: NOW + 300 * 86_400_000, key_status: 'ACTIVE' } });
    }
    if (u.includes('/v1/client/asset/receiver_address')) {
      assert.equal(init.headers['orderly-account-id'], ACCOUNT);
      return json({ success: true, data: { receiver_address: o.receiverAnswer ?? RECEIVER, chain_id: 42161 } });
    }
    if (u.endsWith('/v1/client/holding')) {
      if (o.ipRefused) return json({ success: false, code: -1002, message: 'IP is not allowed' }, 401);
      return json({ success: true, data: { holding: o.holding ?? [{ token: 'USDC', holding: 12.5, frozen: 0, pending_short: 0 }] } });
    }
    if (u.endsWith('/v1/client/set_orderly_key_ip_restriction')) {
      if (o.ipPostFails) return json({ success: false, code: -1002, message: 'IP is not allowed' }, 401);
      return json({ success: true, data: {} });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const env = new Map([
    ['GIMBAL_MODE', 'mainnet'], ['NEAR_NETWORK', 'mainnet'], ['GIMBAL_CONTRACT_ID', CONTRACT], ['DESK_ID', DESK_ID],
    ['OWNER_ACCOUNT_ID', OWNER], ['OPERATOR_PRIVATE_KEY', SECRET], ['ORDERLY_BROKER_ID', 'gimbal_dex'],
  ]);
  const deps = {
    near: client, fetch: fetchImpl, now: () => NOW, tree: null,
    readEnv: () => { seen.envReads++; return env; },
    readKey: (_file, accountId) => { seen.keyReads++; return { accountId, publicKeyString: o.ownerKey ?? OWNER_PUBLIC }; },
    transport: async () => transport,
    publicIps: async () => o.thisIps ?? [IP1],
  };
  return { seen, deps, desk: () => desk, applied: () => applied };
}

async function capture(argv, deps) {
  const lines = [];
  try {
    const block = await runOrderly(argv, { ...deps, say: (s = '') => lines.push(s) });
    return { out: lines.join('\n'), block, error: null };
  } catch (e) {
    // A run that exits non-zero still prints its block: read it back from the output.
    const out = lines.join('\n').split('\n');
    const start = out.findIndex((l) => l.startsWith('=== gimbal orderly '));
    return { out: lines.join('\n'), block: start < 0 ? null : out.slice(start, out.indexOf('=== end ===', start) + 1), error: e };
  }
}

const usage = (argv, pattern) => assert.throws(() => parseOrderlyArgs(argv), (e) => e instanceof UsageError && pattern.test(e.message), argv.join(' '));

// --- arguments and addresses ---

test('arguments: four commands, mainnet ids, the receiver and the IP list checked, --key-file for an owner --send', () => {
  const s = parseOrderlyArgs(['status', CONTRACT, DESK_ID]);
  assert.equal(s.send, false);
  assert.match(s.envFile, /[\\/]\.keys[\\/]engine-mainnet-gimbal-dex-test\.near\.env$/);
  assert.equal(parseOrderlyArgs(['receiver', CONTRACT, DESK_ID, RECEIVER.toUpperCase().replace('0X', '0x')]).receiver, RECEIVER, 'sent lowercase');
  assert.deepEqual(parseOrderlyArgs(['ips', CONTRACT, DESK_ID, `${IP1},${IP2}`]).ips, [IP1, IP2]);
  assert.deepEqual(parseOrderlyArgs(['apply-ips', CONTRACT, DESK_ID, '--engine-ips', IP1]).engineIps, [IP1]);
  usage([], /a command is required/);
  usage(['pin', CONTRACT, DESK_ID], /pin is not one of status, receiver, ips, apply-ips/);
  usage(['status', CONTRACT], /contract and the desk id are required/);
  usage(['status', CONTRACT, DESK_ID, 'x'], /unexpected argument x/);
  usage(['status', 'gimbal.testnet', DESK_ID], /not a mainnet account/);
  usage(['status', CONTRACT, 'Carry!'], /desk id/);
  usage(['status', CONTRACT, DESK_ID, '--key-file', 'k.json'], /unknown option --key-file/);
  usage(['ips', CONTRACT, DESK_ID, IP1, '--engine-ips', IP1], /unknown option --engine-ips/);
  usage(['receiver', CONTRACT, DESK_ID, '0x1234'], /not a 0x address of 40 hex digits/);
  usage(['receiver', CONTRACT, DESK_ID, `0x${'0'.repeat(40)}`], /zero address/);
  usage(['receiver', CONTRACT, DESK_ID, RECEIVER, '--send'], /--send with a receiver needs --key-file/);
  usage(['ips', CONTRACT, DESK_ID], /the IP list is required/);
  usage(['ips', CONTRACT, DESK_ID, IP1, '--send'], /--send needs --key-file/);
  usage(['ips', CONTRACT, DESK_ID, `${IP1},${IP1}`], /1\.2\.3\.4 is listed twice/);
  usage(['ips', CONTRACT, DESK_ID, `${IP1},`], /entry 2 is empty/);
  usage(['ips', CONTRACT, DESK_ID, `${IP1}, 5.6.7.8`], /" 5\.6\.7\.8" is not an IPv4 or IPv6 address/);
  usage(['ips', CONTRACT, DESK_ID, Array.from({ length: 11 }, (_, i) => `1.2.3.${i + 10}`).join(',')], /11 addresses; the contract takes 1 to 10/);
  usage(['apply-ips', CONTRACT, DESK_ID, '--engine-ips', '10.0.0.1'], /--engine-ips: 10\.0\.0\.1 is in 10\.0\.0\.0\/8 \(private\)/);
  // The engine's IPs are never this machine's guess at --send.
  usage(['apply-ips', CONTRACT, DESK_ID, '--send'], /--send needs --engine-ips <ip\[,ip\.\.\.\]>: every IP the engine sends .*railway outbound-network static-ip status/);
  assert.equal(parseOrderlyArgs(['apply-ips', CONTRACT, DESK_ID]).engineIps, null, 'a dry run may leave it out');
  assert.equal(parseOrderlyArgs(['ips', CONTRACT, DESK_ID, IP1, '--force-same']).forceSame, true);
  assert.equal(parseOrderlyArgs(['ips', CONTRACT, DESK_ID, IP1]).forceSame, false);
  usage(['apply-ips', CONTRACT, DESK_ID, '--force-same'], /unknown option --force-same/);
  // A receiver --send without an address is the lookup alone: it needs no owner key.
  assert.equal(parseOrderlyArgs(['receiver', CONTRACT, DESK_ID, '--send']).receiver, null);
  assert.equal(parseReceiver('0xAbCdEf0000000000000000000000000000000001'), '0xabcdef0000000000000000000000000000000001');
});

test('IPs: the canonical form is Rust\'s IpAddr display, as the contract compares; ranges, zones and private addresses refused', () => {
  // [input, canonical form] as Rust's `parse::<IpAddr>()` then `to_string()` gives it.
  for (const [input, canonical] of [
    ['1.2.3.4', '1.2.3.4'],
    ['2001:0db8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:DB8::1', '2001:db8::1'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
    ['1:0:0:2:0:0:3:4', '1::2:0:0:3:4'],
    ['1:2:3:4:5:6:0:8', '1:2:3:4:5:6:0:8'],
    ['1:2:3:4:5:6::8', '1:2:3:4:5:6:0:8'],
    ['::', '::'],
    ['::1', '::1'],
    ['1::', '1::'],
    ['::ffff:102:304', '::ffff:1.2.3.4'],
    ['::1.2.3.4', '::102:304'],
    ['2a00:1450:0:0::1', '2a00:1450::1'],
  ]) assert.equal(parseIp(input)?.canonical, canonical, input);
  for (const bad of ['01.2.3.4', '1.2.3.256', '1.2.3', '1.2.3.4/32', '1::2::3', 'fe80::1%eth0', '[2a00:1450::1]', ' 1.2.3.4', '1.2.3.4:80', '12345::1', ':1::', 'x']) {
    assert.equal(parseIp(bad), null, bad);
    assert.match(ipProblem(bad), /is not an IPv4 or IPv6 address/, bad);
  }
  assert.equal(ipProblem(IP1), null);
  assert.equal(ipProblem(IP2), null);
  assert.match(ipProblem('2A00:1450::1'), /not in the canonical form the contract takes \(E_ARGS\): write 2a00:1450::1/);
  assert.match(ipProblem('::ffff:1.2.3.4'), /IPv4-mapped IPv6 address: give the IPv4 address 1\.2\.3\.4 itself/);
  for (const [ip, range] of [
    ['10.1.2.3', '10.0.0.0/8 (private)'], ['172.31.0.1', '172.16.0.0/12 (private)'], ['192.168.1.1', '192.168.0.0/16 (private)'],
    ['127.0.0.1', '127.0.0.0/8 (loopback)'], ['100.64.0.1', '100.64.0.0/10 (carrier-grade NAT)'], ['203.0.113.7', '203.0.113.0/24 (documentation)'],
    ['0.0.0.0', '0.0.0.0/8'], ['255.255.255.255', '240.0.0.0/4 (reserved)'], ['::1', '::/96'], ['2001:db8::1', '2001:db8::/32 (documentation)'],
    ['fd00::1', 'fc00::/7 (unique local (private))'], ['fe80::1', 'fe80::/10 (link-local)'], ['ff02::1', 'ff00::/8 (multicast)'],
    // Addresses that stand for an IPv4 one: Orderly sees the IPv4 address, never these.
    ['64:ff9b::102:304', '64:ff9b::/96 (NAT64: a translated IPv4 address)'], ['2002:102:304::1', '2002::/16 (6to4: a tunnelled IPv4 address)'],
    ['192.88.99.1', '192.88.99.0/24 (6to4 relay anycast)'],
  ]) assert.ok(ipProblem(ip)?.includes(`is in ${range}`), `${ip}: ${ipProblem(ip)}`);
  for (const ip of ['64:ff9b:0:1::1', '2003::1', '2001:db9::1', '192.88.100.1', '192.88.98.255']) assert.equal(ipProblem(ip), null, `${ip} is public`);
  assert.ok(parseIpList('172.32.0.1', 'x'), 'just past 172.16/12 is public');
  assert.throws(() => parseIpList('1.1.1.1,10.0.0.1,1.1.1.1', 'the IP list'), /10\.0\.0\.1 is in 10\.0\.0\.0\/8 \(private\)[\s\S]*1\.1\.1\.1 is listed twice/);
});

test('the calls match the contract: method names, argument names, the IP limit, the ip_restriction body', () => {
  const src = (f) => readFileSync(new URL(`../../contract/${f}`, import.meta.url), 'utf8');
  const orderly = src('src/orderly.rs');
  assert.match(orderly, /pub fn set_orderly_receiver\(&mut self, desk_id: String, receiver: String\)/);
  assert.match(orderly, /pub fn set_orderly_ips\(&mut self, desk_id: String, ips: Vec<String>\)/);
  assert.match(src('src/settings.rs'), /pub orderly_ips_applied: bool,\n\}/, 'a field of DeskSettingsView (the last one)');
  assert.match(src('src/desk.rs'), /pub orderly_receiver: Option<String>,[\s\S]*pub orderly_ips: Vec<String>,/);
  const core = src('core/src/orderly.rs');
  assert.match(core, new RegExp(`pub const MAX_ORDERLY_IPS: usize = ${MAX_ORDERLY_IPS};`));
  assert.match(core, /pub const IP_RESTRICTION_PATH: &str = "\/v1\/client\/set_orderly_key_ip_restriction";/);
  // The contract test's body for the same key and list.
  assert.equal(ipRestrictionBody('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB', ['203.0.113.7', '2001:db8::1']),
    '{"orderly_key":"ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB","ip_restriction_list":"203.0.113.7,2001:db8::1"}');
  assert.ok(src('src/tests/orderly.rs').includes('r#"{"orderly_key":"ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB","ip_restriction_list":"203.0.113.7,2001:db8::1"}"#'));
  // The exact payloads.
  assert.deepEqual(receiverActions(DESK_ID, RECEIVER), [{ type: 'FunctionCall', method: 'set_orderly_receiver', args: { desk_id: DESK_ID, receiver: RECEIVER }, gasTgas: OWNER_TGAS, deposit: OWNER_DEPOSIT, shownArgs: { desk_id: DESK_ID, receiver: RECEIVER } }]);
  assert.deepEqual(ipsActions(DESK_ID, [IP1, IP2])[0].args, { desk_id: DESK_ID, ips: [IP1, IP2] });
  assert.equal(OWNER_DEPOSIT, 10n ** 22n, '0.01 NEAR: over the 100 and 500 bytes the contract tests allow these settings');
  assert.deepEqual(requestActions(DESK_ID, 'ip_restriction', NOW, 'r')[0].args, { desk_id: DESK_ID, req: { reduce_only: false, kind: 'ip_restriction', timestamp_ms: NOW }, reason: 'r' });
  assert.equal(requestActions(DESK_ID, 'holding', NOW, 'r')[0].gasTgas, 300n);
  assert.match(opensText([], false), /^refused: the contract refuses every Orderly order that is not reduce-only \(E_ARGS\) until the owner sets a list .*reduce-only closes are still signed$/);
  assert.match(opensText([IP1], true), /^signed:/);
});

test('the reasons are the engine\'s, and the guard lets only the command\'s kinds through', async () => {
  const actions = readFileSync(new URL('../../engine/src/venues/orderly-actions.ts', import.meta.url), 'utf8');
  assert.ok(actions.includes("this.request('ip_restriction', {}, 'limit the Orderly key to the relayer IPs')"));
  assert.ok(actions.includes("holding(reason = 'read Orderly holding')"));
  assert.deepEqual(ALLOWED_KINDS, { status: ['holding', 'receiver_address'], receiver: ['receiver_address'], 'apply-ips': ['receiver_address', 'ip_restriction'] });
  const calls = [];
  const inner = { accountId: OWNER, call: async (...c) => { calls.push(c); return { ok: true }; }, view: async () => 1, account: async () => 2, allowance: async () => 3n };
  const g = kindGuard(inner, CONTRACT, ['ip_restriction']);
  for (const [id, method, kind] of [[CONTRACT, 'orderly_request', 'order'], [CONTRACT, 'orderly_request', 'withdraw_request'], [CONTRACT, 'orderly_withdraw', undefined], [CONTRACT, 'fund_venue', undefined], ['other.near', 'orderly_request', 'ip_restriction']]) {
    await assert.rejects(g.call(id, method, { req: { kind } }, 300), /refused, nothing was signed/, `${id} ${method} ${kind}`);
  }
  assert.equal(calls.length, 0);
  await g.call(CONTRACT, 'orderly_request', { req: { kind: 'ip_restriction' } }, 300);
  assert.equal(calls.length, 1);
});

test('--send refuses in a linked git worktree before anything is read, for every command', async () => {
  const touched = new Proxy({}, { get: () => { throw new Error('read before the refusal'); } });
  for (const argv of [
    ['status', CONTRACT, DESK_ID, '--send'],
    ['receiver', CONTRACT, DESK_ID, RECEIVER, '--key-file', 'k.json', '--send'],
    ['ips', CONTRACT, DESK_ID, IP1, '--key-file', 'k.json', '--send'],
    ['apply-ips', CONTRACT, DESK_ID, '--engine-ips', IP1, '--send'],
  ]) {
    await assert.rejects(runOrderly(argv, { tree: '/w/tree', near: touched, fetch: touched, say: () => {} }), /\/w\/tree is a linked git worktree: --send runs from the main checkout only/, argv[0]);
  }
});

test('every command refuses a contract without the method it calls, or that is not a mainnet Gimbal contract', async () => {
  const old = world({ code: wasmWith(['new', 'config', 'get_desk', 'orderly_request']) });
  assert.match((await capture(['receiver', CONTRACT, DESK_ID], old.deps)).error.message, /has no set_orderly_receiver: this command cannot run on it/);
  assert.match((await capture(['ips', CONTRACT, DESK_ID, IP1], old.deps)).error.message, /has no set_orderly_ips/);
  const s = await capture(['status', CONTRACT, DESK_ID], old.deps);
  assert.equal(s.error, null, s.error?.stack);
  assert.match(s.out, /applied {3}unknown \(no get_desk_settings in this contract\)/);
  const testnet = world();
  testnet.deps.near.view = async (_c, m) => (m === 'config' ? { ...CONFIG, network: 'Testnet' } : deskOf());
  assert.match((await capture(['status', CONTRACT, DESK_ID], testnet.deps)).error.message, /not a mainnet Gimbal contract:\n {2}network is "Testnet"/);
  assert.match((await capture(['status', CONTRACT, 'other'], world().deps)).error.message, /has no desk other/);
});

// --- status ---

test('status dry run: receiver, IP list, applied, opens, Orderly\'s public view; the holding is a signed read left for --send', async () => {
  const w = world();
  const r = await capture(['status', CONTRACT, DESK_ID], w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /\nreceiver {2}not pinned: fund_venue and rescues into Orderly are refused until the owner pins it\n/);
  assert.match(r.out, /\nips {7}none set\napplied {3}no \(no list\)\nopens {5}refused: the contract refuses every Orderly order that is not reduce-only/);
  assert.match(r.out, /a wrong IP list blocks Orderly/);
  assert.match(r.out, /reduce-only closes are still signed/);
  assert.match(r.out, new RegExp(`orderly {3}registered under gimbal_dex; key ed25519:${AUTHORITY} ACTIVE, scope read,trading`));
  assert.ok(r.out.includes(`args {"desk_id":"carry","req":{"reduce_only":false,"kind":"holding","timestamp_ms":${NOW}},"reason":"read Orderly holding"}`));
  assert.ok(r.out.includes(`args {"desk_id":"carry","req":{"reduce_only":false,"kind":"receiver_address","timestamp_ms":${NOW}},"reason":"look up the Orderly receiver address"}`));
  assert.match(r.out, /GET https:\/\/api\.orderly\.org\/v1\/client\/holding/);
  assert.match(r.out, /GET https:\/\/api\.orderly\.org\/v1\/client\/asset\/receiver_address\?chain_id=42161&token=USDC/);
  assert.match(r.out, /status --send SIGNS two reads with the operator key, orderly_request\n {10}of kinds holding and receiver_address/);
  assert.deepEqual(r.block, [
    '=== gimbal orderly status 2026-11-04T12:00:00.000Z ===',
    `contract ${CONTRACT}, desk carry, dry run`,
    'state:    receiver none; ips none; applied false',
    'opens:    refused: the contract refuses every Orderly order that is not reduce-only (E_ARGS) until the owner sets a list and it signs ip_restriction for it; reduce-only closes are still signed',
    'orderly:  registered; key ACTIVE',
    'holding:  not read (signed read at --send)',
    'receiver: not pinned; not compared with Orderly (signed read at --send)',
    '=== end ===',
  ]);
  assert.equal(w.seen.signed.length + w.seen.sent.length + w.seen.envReads + w.seen.keyReads, 0);
  assert.ok(w.seen.fetch.every((f) => /\/v1\/get_(account|orderly_key)\?/.test(f)), w.seen.fetch.join('\n'));
});

test('status --send: two signed reads with the operator key, never printed; the pinned receiver compared with Orderly\'s answer', async () => {
  const w = world({ desk: deskOf({ orderly_receiver: RECEIVER, orderly_ips: [IP1, IP2] }), applied: true });
  const r = await capture(['status', CONTRACT, DESK_ID, '--send'], w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.deepEqual(w.seen.signed.map((s) => [s.method, s.args.req.kind, s.args.reason]), [
    ['orderly_request', 'holding', 'read Orderly holding'],
    ['orderly_request', 'receiver_address', 'look up the Orderly receiver address'],
  ]);
  assert.equal(w.seen.sent.length, 0);
  assert.ok(!r.out.includes(SECRET));
  assert.match(r.out, /money {5}none moves: two signed reads, gas only/);
  assert.match(r.out, /\nholding {3}USDC 12\.5 \(frozen 0, pending_short 0\)\nreceiver {2}pinned 0x1{40}, Orderly's answer: they match\n/);
  assert.deepEqual(r.block.slice(2, -1), [
    `state:    receiver ${RECEIVER}; ips ${IP1},${IP2}; applied true`,
    'opens:    signed: the list is set and its ip_restriction signed, so the contract signs Orderly orders that grow a position',
    'orderly:  registered; key ACTIVE',
    'holding:  USDC 12.5 (frozen 0, pending_short 0)',
    `receiver: pinned ${RECEIVER}, Orderly's answer: they match`,
  ]);
  assert.doesNotMatch(r.out, /a wrong IP list blocks Orderly/, 'no warning once the list is applied');

  // A pinned receiver that is not Orderly's answer: a clear line and a non-zero exit.
  const wrong = world({ desk: deskOf({ orderly_receiver: RECEIVER, orderly_ips: [IP1] }), applied: true, receiverAnswer: OTHER });
  const m = await capture(['status', CONTRACT, DESK_ID, '--send'], wrong.deps);
  assert.match(m.error.message, new RegExp(`the pinned receiver ${RECEIVER} is NOT Orderly's answer ${OTHER}: .*Fund nothing into Orderly`));
  assert.ok(m.out.includes(`receiver: MISMATCH: the pinned receiver ${RECEIVER} is NOT Orderly's answer ${OTHER}`), m.out);
  assert.equal(wrong.seen.sent.length, 0);

  // Not pinned yet: Orderly's answer and the command that pins it.
  const fresh = await capture(['status', CONTRACT, DESK_ID, '--send'], world().deps);
  assert.equal(fresh.error, null, fresh.error?.stack);
  assert.ok(fresh.block.includes(`receiver: not pinned; Orderly answers ${RECEIVER}`));
  assert.ok(fresh.block.includes(`next:     node tools/mainnet/orderly.mjs receiver ${CONTRACT} carry ${RECEIVER} --key-file <owner key json> --send`));

  const refused = world({ desk: deskOf({ orderly_ips: [IP2] }), applied: true, ipRefused: true });
  const e = await capture(['status', CONTRACT, DESK_ID, '--send'], refused.deps);
  assert.match(e.error.message, /Orderly holding could not be read: .*an applied IP list refuses the desk key from any IP not in it/);
  assert.deepEqual(refused.seen.signed.map((s) => s.args.req.kind), ['holding', 'receiver_address'], 'the receiver is still read and shown');
});

// --- receiver ---

test('receiver dry run: the signed lookup and set_orderly_receiver printed in full, 0.01 NEAR for storage; nothing signed', async () => {
  const w = world();
  const r = await capture(['receiver', CONTRACT, DESK_ID, RECEIVER], w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.ok(r.out.includes(`args {"desk_id":"carry","req":{"reduce_only":false,"kind":"receiver_address","timestamp_ms":${NOW}},"reason":"look up the Orderly receiver address"}`));
  assert.match(r.out, /GET https:\/\/api\.orderly\.org\/v1\/client\/asset\/receiver_address\?chain_id=42161&token=USDC/);
  assert.match(r.out, new RegExp(`signer {4}${OWNER} {2}\\(the owner's key, read at --send\\)\\n {2}receiver {2}${CONTRACT}\\n {2}action 1 {2}FunctionCall set_orderly_receiver {2}gas 50 TGas {2}deposit 0\\.01 NEAR`));
  assert.ok(r.out.includes(`args {"desk_id":"carry","receiver":"${RECEIVER}"}`));
  assert.match(r.out, /money {5}no USDC moves\. 0\.01 NEAR attached for storage: the contract keeps what the pin takes \(under 0\.001 NEAR\) and refunds the rest/);
  assert.match(r.out, /the pin is permanent/);
  assert.deepEqual(r.block.slice(2, -1), [`receiver: not pinned; planned ${RECEIVER}`]);
  assert.equal(w.seen.signed.length + w.seen.sent.length + w.seen.envReads + w.seen.keyReads, 0);

  const noAddr = await capture(['receiver', CONTRACT, DESK_ID], world().deps);
  assert.ok(noAddr.out.includes('args {"desk_id":"carry","receiver":"<the receiver_address Orderly answers>"}'));
  assert.match(noAddr.out, /--send looks the receiver up and prints it/);
});

test('receiver --send without an address: the signed lookup only, printed with the command that pins it; no owner key read', async () => {
  const w = world();
  const r = await capture(['receiver', CONTRACT, DESK_ID, '--send'], w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.deepEqual(w.seen.signed.map((s) => [s.method, s.args.req.kind, s.tgas]), [['orderly_request', 'receiver_address', 300]]);
  assert.equal(w.seen.sent.length, 0);
  assert.equal(w.seen.keyReads, 0);
  assert.ok(r.block.includes(`lookup:   receiver_address ${RECEIVER}; tx OpTx1`));
  assert.ok(r.block.includes(`next:     node tools/mainnet/orderly.mjs receiver ${CONTRACT} carry ${RECEIVER} --key-file <owner key json> --send`));
  assert.equal(w.desk().orderly_receiver, null);
});

test('receiver --send with an address: pinned only when it is Orderly\'s answer, with the owner\'s full-access key', async () => {
  const w = world({ receiverAnswer: '0x1111111111111111111111111111111111111111' });
  const r = await capture(['receiver', CONTRACT, DESK_ID, RECEIVER, '--key-file', 'k.json', '--send'], w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.equal(w.seen.sent.length, 1);
  assert.equal(w.seen.sent[0].signer, OWNER_PUBLIC);
  assert.equal(w.seen.sent[0].receiver, CONTRACT);
  assert.deepEqual(w.seen.sent[0].actions, receiverActions(DESK_ID, RECEIVER));
  assert.ok(r.block.includes(`event:    orderly_receiver_set {"desk_id":"carry","receiver":"${RECEIVER}"}`));
  assert.ok(r.block.includes(`receiver: get_desk now ${RECEIVER}`));

  const other = world({ receiverAnswer: OTHER });
  const m = await capture(['receiver', CONTRACT, DESK_ID, RECEIVER, '--key-file', 'k.json', '--send'], other.deps);
  assert.match(m.error.message, new RegExp(`${RECEIVER} is not the receiver Orderly gives this account \\(${OTHER}\\): nothing was pinned`));
  assert.equal(other.seen.sent.length, 0);

  const wrongKey = world({ ownerKey: OP_PUBLIC });
  const k = await capture(['receiver', CONTRACT, DESK_ID, RECEIVER, '--key-file', 'k.json', '--send'], wrongKey.deps);
  assert.match(k.error.message, /--key-file is not a full-access key of the desk owner/);
  assert.equal(wrongKey.seen.signed.length + wrongKey.seen.sent.length, 0, 'refused before the lookup is signed');

  const poor = world({ ownerNear: 10n ** 21n });
  const p = await capture(['receiver', CONTRACT, DESK_ID, RECEIVER, '--key-file', 'k.json', '--send'], poor.deps);
  assert.match(p.error.message, /the owner can spend .* NEAR; the call needs 0\.01 NEAR of deposit/);
  assert.equal(poor.seen.signed.length, 0);
});

test('receiver: a pinned receiver is never replaced; the same one is nothing to send; an unready Orderly account refuses at --send', async () => {
  const pinned = world({ desk: deskOf({ orderly_receiver: RECEIVER }) });
  const same = await capture(['receiver', CONTRACT, DESK_ID, RECEIVER, '--key-file', 'k.json', '--send'], pinned.deps);
  assert.equal(same.error, null);
  assert.match(same.out, /nothing to send: the receiver is pinned already/);
  const diff = await capture(['receiver', CONTRACT, DESK_ID, OTHER], pinned.deps);
  assert.match(diff.error.message, /has its receiver pinned already, 0x1{40}: the contract pins it once \(E_ARGS the second time\)/);
  assert.equal(pinned.seen.signed.length + pinned.seen.sent.length, 0);

  const fresh = world({ keyActive: false });
  const d = await capture(['receiver', CONTRACT, DESK_ID], fresh.deps);
  assert.match(d.out, /refused {3}at --send: the desk's Orderly account or its key is not ready: run checks\.mjs/);
  const s = await capture(['receiver', CONTRACT, DESK_ID, '--send'], fresh.deps);
  assert.match(s.error.message, /not ready/);
  assert.equal(fresh.seen.signed.length, 0);
});

// --- ips ---

test('ips dry run: current against new, the warning, set_orderly_ips with 0.01 NEAR; nothing signed', async () => {
  const w = world({ desk: deskOf({ orderly_ips: [IP1] }), applied: true });
  const r = await capture(['ips', CONTRACT, DESK_ID, `${IP1},${IP2}`], w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /\ncurrent {3}1\.2\.3\.4\nnew {7}1\.2\.3\.4, 2a00:1450::1\nchange {4}adds 2a00:1450::1; none removed\n/);
  assert.match(r.out, /warning {3}a wrong IP list blocks Orderly\. Until a list is set and the contract signed its ip_restriction, the contract\n {10}refuses every Orderly order that is not reduce-only, so every open; reduce-only closes are still signed\./);
  assert.match(r.out, /an engine whose IP is\n {10}left out cannot open, close or read on Orderly/);
  assert.match(r.out, /FunctionCall set_orderly_ips {2}gas 50 TGas {2}deposit 0\.01 NEAR\n {12}args {"desk_id":"carry","ips":\["1\.2\.3\.4","2a00:1450::1"\]}/);
  assert.match(r.out, /orderly_ips_applied is false until apply-ips/);
  assert.match(r.out, /money {5}no USDC moves\./);
  assert.deepEqual(r.block.slice(2, -1), [
    'ips:      1.2.3.4 -> 1.2.3.4,2a00:1450::1 planned',
    `next:     node tools/mainnet/orderly.mjs apply-ips ${CONTRACT} carry --engine-ips <the engine's IPs> (after --send)`,
  ]);
  assert.equal(w.seen.signed.length + w.seen.sent.length + w.seen.keyReads, 0);
});

test('ips --send: the owner signs set_orderly_ips; the list reads back and applied is false; the same list sends nothing', async () => {
  const w = world({ applied: true });
  const r = await capture(['ips', CONTRACT, DESK_ID, `${IP2},${IP1}`, '--key-file', 'k.json', '--send'], w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.equal(w.seen.sent.length, 1);
  assert.equal(w.seen.sent[0].signer, OWNER_PUBLIC);
  assert.deepEqual(w.seen.sent[0].actions, ipsActions(DESK_ID, [IP2, IP1]));
  assert.equal(w.seen.signed.length, 0, 'the operator signs nothing here');
  assert.ok(r.block.includes(`event:    orderly_ips_set {"desk_id":"carry","ips":["${IP2}","${IP1}"]}`));
  assert.ok(r.block.includes(`ips:      get_desk now ${IP2},${IP1}; applied false`));

  const same = world({ desk: deskOf({ orderly_ips: [IP1] }), applied: true });
  const s = await capture(['ips', CONTRACT, DESK_ID, IP1, '--key-file', 'k.json', '--send'], same.deps);
  assert.equal(s.error, null);
  assert.match(s.out, /nothing to send: the desk has this list already \(setting it again would only clear orderly_ips_applied; --force-same does that\)/);
  assert.equal(same.seen.sent.length + same.seen.keyReads, 0);
  const reordered = await capture(['ips', CONTRACT, DESK_ID, `${IP2},${IP1}`], world({ desk: deskOf({ orderly_ips: [IP1, IP2] }) }).deps);
  assert.match(reordered.out, /the same addresses in another order/);
});

test('ips --force-same: the same list again, signed by the owner, only to clear orderly_ips_applied', async () => {
  const w = world({ desk: deskOf({ orderly_ips: [IP1, IP2] }), applied: true });
  const dry = await capture(['ips', CONTRACT, DESK_ID, `${IP1},${IP2}`, '--force-same'], w.deps);
  assert.equal(dry.error, null, dry.error?.stack);
  assert.match(dry.out, /force {5}--force-same: the same list again, only to clear orderly_ips_applied\. Use it when the contract signed an ip_restriction\n {10}that Orderly did not take/);
  assert.doesNotMatch(dry.out, /nothing to send|another order/);
  assert.match(dry.out, /args {"desk_id":"carry","ips":\["1\.2\.3\.4","2a00:1450::1"\]}/);
  assert.equal(w.seen.sent.length + w.seen.keyReads, 0);

  const r = await capture(['ips', CONTRACT, DESK_ID, `${IP1},${IP2}`, '--force-same', '--key-file', 'k.json', '--send'], w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.deepEqual(w.seen.sent.map((s) => [s.signer, s.receiver, s.actions]), [[OWNER_PUBLIC, CONTRACT, ipsActions(DESK_ID, [IP1, IP2])]]);
  assert.equal(w.applied(), false, 'the contract clears the flag');
  assert.ok(r.block.includes(`ips:      get_desk now ${IP1},${IP2}; applied false`));

  const differs = await capture(['ips', CONTRACT, DESK_ID, IP1, '--force-same'], world({ desk: deskOf({ orderly_ips: [IP2] }) }).deps);
  assert.match(differs.out, /--force-same changes nothing here: the list differs from the desk's/);
});

// --- apply-ips ---

test('apply-ips dry run: the engine\'s two signed requests and the body the contract builds; a missing engine IP is called out', async () => {
  const w = world({ desk: deskOf({ orderly_ips: [IP1, IP2] }) });
  const r = await capture(['apply-ips', CONTRACT, DESK_ID, '--engine-ips', IP2], w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /engine {4}2a00:1450::1 \(--engine-ips\)/);
  assert.match(r.out, /^this {6}this machine's public IP 1\.2\.3\.4: in the list$/m);
  assert.ok(r.out.includes(`args {"desk_id":"carry","req":{"reduce_only":false,"kind":"ip_restriction","timestamp_ms":${NOW}},"reason":"limit the Orderly key to the relayer IPs"}`));
  assert.ok(r.out.includes(`POST https://api.orderly.org/v1/client/set_orderly_key_ip_restriction {"orderly_key":"ed25519:${AUTHORITY}","ip_restriction_list":"1.2.3.4,2a00:1450::1"}`));
  assert.match(r.out, /money {5}none moves: two signed requests on the operator key, gas only/);
  assert.match(r.out, /a wrong IP list blocks Orderly/);
  assert.doesNotMatch(r.out, /^refused /m, 'nothing the --send would refuse');
  assert.deepEqual(r.block.slice(2, -1), [`state:    receiver none; ips ${IP1},${IP2}; applied false`, `engine:   ${IP2}`, `this:     ${IP1} in the list`]);
  assert.equal(w.seen.signed.length + w.seen.envReads, 0);

  // Without --engine-ips the dry run says --send needs it; this machine's IP is never taken for the engine's.
  const bare = await capture(['apply-ips', CONTRACT, DESK_ID], w.deps);
  assert.equal(bare.error, null, bare.error?.stack);
  assert.match(bare.out, /engine {4}not given: --send needs --engine-ips, every IP the engine sends its Orderly requests from \(on Railway: `railway outbound-network static-ip status`, all of them\)/);
  assert.match(bare.out, /^refused {3}at --send without --engine-ips$/m);
  assert.ok(bare.block.includes('engine:   not given (--send needs --engine-ips)'));

  // This machine outside the list: said plainly, not refused (the laptop applying Railway's IPs is the normal case).
  const away = world({ desk: deskOf({ orderly_ips: [IP2] }), thisIps: ['5.6.7.8'] });
  const a = await capture(['apply-ips', CONTRACT, DESK_ID, '--engine-ips', IP2], away.deps);
  assert.match(a.out, /this {6}this machine's public IP 5\.6\.7\.8: NOT in the list\. Once Orderly applies it, this machine cannot post a correction or read the holding/);
  assert.ok(a.block.includes('this:     5.6.7.8 NOT in the list'));
  assert.doesNotMatch(a.out, /^refused /m);
  const lost = world({ desk: deskOf({ orderly_ips: [IP2] }) });
  lost.deps.publicIps = async () => { throw new Error('no answer'); };
  assert.match((await capture(['apply-ips', CONTRACT, DESK_ID, '--engine-ips', IP2], lost.deps)).out, /^this {6}this machine's public IP unknown \(no answer\)$/m);

  const miss = world({ desk: deskOf({ orderly_ips: [IP2] }) });
  const m = await capture(['apply-ips', CONTRACT, DESK_ID, '--engine-ips', '5.6.7.8'], miss.deps);
  assert.match(m.out, /engine {4}5\.6\.7\.8 \(--engine-ips\)/);
  assert.match(m.out, /refused {3}the list leaves out 5\.6\.7\.8: Orderly would refuse every request the engine sends from there, so it could not open, close or read/);
  const ms = await capture(['apply-ips', CONTRACT, DESK_ID, '--engine-ips', '5.6.7.8', '--send'], miss.deps);
  assert.match(ms.error.message, /leaves out 5\.6\.7\.8, an IP the engine sends from: nothing was signed/);
  assert.equal(miss.seen.signed.length + miss.seen.envReads, 0);

  assert.match((await capture(['apply-ips', CONTRACT, DESK_ID], world().deps)).error.message, /has no IP list: set one with the ips command first/);
});

test('apply-ips --send: the engine\'s setup steps sign receiver_address then ip_restriction, post the body, and the contract reads applied', async () => {
  const w = world({ desk: deskOf({ orderly_receiver: RECEIVER, orderly_ips: [IP1, IP2] }) });
  const r = await capture(['apply-ips', CONTRACT, DESK_ID, '--engine-ips', IP2, '--send'], w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.deepEqual(w.seen.signed.map((s) => [s.method, s.args.req.kind, s.args.reason]), [
    ['orderly_request', 'receiver_address', 'look up the Orderly receiver address'],
    ['orderly_request', 'ip_restriction', 'limit the Orderly key to the relayer IPs'],
  ]);
  assert.equal(w.seen.sent.length, 0, 'no owner transaction');
  assert.ok(w.seen.fetch.includes(`POST https://api.orderly.org/v1/client/set_orderly_key_ip_restriction {"orderly_key":"ed25519:${AUTHORITY}","ip_restriction_list":"${IP1},${IP2}"}`), w.seen.fetch.join('\n'));
  assert.ok(!r.out.includes(SECRET));
  assert.deepEqual(r.block.slice(2, -1), [
    `this:     ${IP1} in the list`,
    `setup:    orderly_register done: registered under gimbal_dex: ${ACCOUNT}`,
    'setup:    orderly_add_key done: key active until 2027-08-31',
    `setup:    orderly_receiver_lookup done: ${RECEIVER}; tx OpTx1`,
    `setup:    orderly_ip_restriction done: key limited to ${IP1}, ${IP2}; tx OpTx2`,
    'applied:  true',
    'opens:    signed: the list is set and its ip_restriction signed, so the contract signs Orderly orders that grow a position',
  ]);

  // An operator key that is not on chain as the operator key signs nothing.
  const bad = world({ desk: deskOf({ orderly_ips: [IP1] }) });
  bad.deps.near.accessKey = async () => ({ nonce: 1, permission: 'FullAccess' });
  const b = await capture(['apply-ips', CONTRACT, DESK_ID, '--engine-ips', IP1, '--send'], bad.deps);
  assert.match(b.error.message, /is not .*'s operator key for gimbal-dex-test\.near/);
  assert.equal(bad.seen.signed.length, 0);
});

test('apply-ips --send, Orderly refuses the POST after the contract signed: loud NOT PROTECTED lines, the way out, a non-zero exit', async () => {
  const w = world({ desk: deskOf({ orderly_receiver: RECEIVER, orderly_ips: [IP2] }), thisIps: ['5.6.7.8'], ipPostFails: true });
  const r = await capture(['apply-ips', CONTRACT, DESK_ID, '--engine-ips', IP2, '--send'], w.deps);
  assert.deepEqual(w.seen.signed.map((s) => s.args.req.kind), ['receiver_address', 'ip_restriction'], 'the contract did sign it');
  assert.equal(w.applied(), true, 'the contract marks the list applied when it signs');
  const fix = `node tools/mainnet/orderly.mjs ips ${CONTRACT} carry ${IP2} --force-same --key-file <owner key json> --send`;
  assert.match(r.error.message, /^orderly_ip_restriction failed after the contract signed it: .*IP is not allowed.*\. The contract marks the list applied but Orderly did not take it, so opens are NOT protected\. Rerun apply-ips from an IP Orderly takes, or clear the flag: /);
  assert.ok(r.error.message.endsWith(fix), r.error.message);
  assert.match(r.out, /\nFAILED {4}orderly_ip_restriction: the contract signed it \(tx OpTx2\) and marks the list applied, but Orderly did NOT take it: .*IP is not allowed/);
  assert.match(r.out, /\n {10}OPENS ARE NOT PROTECTED: the contract signs Orderly opens while Orderly does not limit the key to the list\.\n/);
  assert.ok(r.out.includes(`          - clear the flag, so the contract refuses opens again: ${fix}`));
  assert.deepEqual(r.block.slice(2, -1).filter((l) => !l.startsWith('setup:')), [
    'this:     5.6.7.8 NOT in the list',
    'applied:  true in the contract, but Orderly did NOT take the list',
    'opens:    NOT PROTECTED: the contract signs opens that Orderly does not limit to the list',
    `fix:      rerun apply-ips from an IP Orderly takes, or: ${fix}`,
  ]);
  assert.doesNotMatch(r.block.join('\n'), /opens: {4}signed/, 'never the plain "signed" line');
  assert.ok(r.block.some((l) => /^setup: {4}orderly_ip_restriction failed: .*IP is not allowed.*; tx OpTx2$/.test(l)), r.block.join('\n'));

  // The way out it names: the same list with --force-same clears the flag, so opens are refused again.
  const out = await capture(['ips', CONTRACT, DESK_ID, IP2, '--force-same', '--key-file', 'k.json', '--send'], w.deps);
  assert.equal(out.error, null, out.error?.stack);
  assert.equal(w.applied(), false);
  assert.ok(out.block.includes(`ips:      get_desk now ${IP2}; applied false`));
});

test('apply-ips --send with a pinned receiver that is not Orderly\'s answer: a FAILED line and a non-zero exit', async () => {
  const w = world({ desk: deskOf({ orderly_receiver: RECEIVER, orderly_ips: [IP1] }), receiverAnswer: OTHER });
  const r = await capture(['apply-ips', CONTRACT, DESK_ID, '--engine-ips', IP1, '--send'], w.deps);
  assert.match(r.error.message, new RegExp(`^orderly_receiver_lookup failed: the pinned receiver ${RECEIVER} is not the one Orderly gives this account \\(${OTHER}\\)`));
  assert.match(r.out, new RegExp(`\\nFAILED {4}orderly_receiver_lookup failed: the pinned receiver ${RECEIVER}`));
  assert.ok(r.block.some((l) => l.startsWith(`receiver: FAILED: the pinned receiver ${RECEIVER}`)), r.block.join('\n'));
  // The IP step is independent of the receiver and still ran (as the engine's setup runs it).
  assert.ok(r.block.includes('applied:  true'));
});
