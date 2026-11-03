import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { b58encode, sha256 } from '../testnet/near.mjs';
import { UsageError } from './cli.mjs';
import {
  MONEY_METHODS, NEAR_USDC, accessKeyLine, buildProvenance, canonical, cargoPackageInfo, checkFunder, configDiff, deployPlanFor, initArgs, initialBalance, lockConfigProblems,
  lockEvidence, lockKeyProblems, lockNetworkProblem, minInitialBalance, nextFreeName, parseDeployArgs, referralCodes, reproducibleBuildProblems, runDeploy,
  treasuryUsdcLine, wasmExports, wasmSourceMetadata,
} from './deploy.mjs';
import { NO_CODE, act, describeTx, feesOf, txGasCap } from './near.mjs';

const NEAR = 10n ** 24n;
const OK = ['gimbal-canary.near', '--funder', 'funder.near', '--treasury-near', 'treasury.near', '--hl-builder', '0x00000000000000000000000000000000000000AB'];
const usage = (argv, pattern) => assert.throws(() => parseDeployArgs(argv), (e) => e instanceof UsageError && pattern.test(e.message), argv.join(' '));

test('deploy arguments: a dry run needs no key file; the builder is lowercased', () => {
  const a = parseDeployArgs(OK);
  assert.deepEqual(a, {
    contract: 'gimbal-canary.near', funder: 'funder.near', keyFile: null, treasuryNear: 'treasury.near',
    hlBuilder: '0x00000000000000000000000000000000000000ab', balance: null, send: false, resume: false, lock: false, nonReproducible: false,
  });
  assert.equal(parseDeployArgs([...OK, '--balance', '7.5']).balance, 75n * 10n ** 23n);
  assert.equal(parseDeployArgs([...OK, '--send', '--key-file', 'k.json']).send, true);
});

test('deploy arguments: every refusal is a usage error', () => {
  usage([], /contract account is missing/);
  usage([...OK, 'extra'], /unexpected argument extra/);
  usage(OK.filter((x, i) => i !== 1 && i !== 2), /--funder is required/);
  usage(['gimbal-canary.near', '--funder', 'funder.near', '--treasury-near', 'treasury.near'], /--hl-builder is required/);
  usage([...OK, '--bogus'], /unknown option --bogus/);
  usage([...OK, '--balance'], /--balance needs a value/);
  usage([...OK, '--send', '--send'], /given twice/);
  usage([...OK, '--balance', 'six'], /not a NEAR amount/);
  usage([...OK.slice(0, 6), '0x1234'], /not 0x and 40 hex digits/);
  usage([...OK, '--send'], /--send needs --key-file/);
});

test('deploy arguments: mainnet only, and the contract is a new top-level .near name', () => {
  usage(['gimbal-canary.testnet', ...OK.slice(1)], /not a mainnet account/);
  usage(['sub.gimbal.near', ...OK.slice(1)], /not a top-level <name>\.near/);
  usage(['gimbal-canary.near', '--funder', 'funder.testnet', ...OK.slice(3)], /--funder "funder\.testnet" is not a mainnet account/);
  usage(['gimbal-canary.near', '--funder', 'funder.near', '--treasury-near', 'treasury.testnet', ...OK.slice(5)], /--treasury-near "treasury\.testnet"/);
  usage(['gimbal-canary.near', '--funder', 'gimbal-canary.near', ...OK.slice(3)], /--funder cannot be the new contract/);
  usage(['gimbal-canary.near', '--funder', 'funder.near', '--treasury-near', 'price-oracle.near', ...OK.slice(5)], /--treasury-near cannot be price-oracle\.near/);
});

test('the initial balance: the code at 1e19 yoctoNEAR per byte + 0.5 NEAR, rounded up to 0.1 by default', () => {
  assert.equal(minInitialBalance(569_702), 5_697_020_000_000_000_000_000_000n + NEAR / 2n);
  assert.deepEqual(initialBalance(569_702), { min: 6_197_020_000_000_000_000_000_000n, balance: 62n * 10n ** 23n });
  assert.equal(initialBalance(569_702, 7n * NEAR).balance, 7n * NEAR);
  assert.throws(() => initialBalance(569_702, 6n * NEAR), /--balance 6 NEAR is under 6\.19702 NEAR/);
});

test('the funder must cover the initial balance + 0.2 NEAR', () => {
  checkFunder(64n * 10n ** 23n, 62n * 10n ** 23n);
  assert.throws(() => checkFunder(64n * 10n ** 23n - 1n, 62n * 10n ** 23n), /tx 1 needs 6\.4000/);
});

test('never redeploy: only a missing account gets both transactions; --resume only on our own account without code', () => {
  assert.equal(deployPlanFor(null), 'both');
  assert.throws(() => deployPlanFor({ code_hash: 'E8Zp9eM2Jh2DRx31Ez9M9bKMRaXbDkJcZ3sVkjnTBgcs' }), /has code .*never redeployed/);
  assert.throws(() => deployPlanFor({ code_hash: 'E8Zp9eM2Jh2DRx31Ez9M9bKMRaXbDkJcZ3sVkjnTBgcs' }, { resume: true, keyVerdict: 'matches' }), /never redeployed/);
  assert.throws(() => deployPlanFor({ code_hash: NO_CODE }), /exists already: never redeployed/);
  assert.throws(() => deployPlanFor({ code_hash: NO_CODE }, { resume: true, keyVerdict: 'does not match' }), /not a full-access key/);
  assert.throws(() => deployPlanFor({ code_hash: NO_CODE }, { resume: true, keyVerdict: null }), /not a full-access key/);
  assert.equal(deployPlanFor({ code_hash: NO_CODE }, { resume: true, keyVerdict: 'matches' }), 'tx2');
  assert.throws(() => deployPlanFor(null, { resume: true }), /no tx 1 to resume/);
});

test('new() for mainnet: v1.signer, OutLayer price-oracle.near, Arbitrum One, the fixed fees; empty codes are null', () => {
  const env = new Map([
    ['HL_REFERRAL_CODE', { value: 'GIMBAL', from: '.env' }],
    ['ORDERLY_REFERRAL_CODE', { value: null, from: null }],
    ['PHOENIX_REFERRAL_CODE', { value: null, from: null }],
  ]);
  const init = initArgs({ treasuryNear: 'treasury.near', hlBuilder: '0xab', codes: referralCodes(env), brokerId: 'broker' });
  assert.deepEqual(init, {
    network: 'Mainnet',
    mpc: 'v1.signer',
    price_source: { OutLayer: { contract: 'price-oracle.near' } },
    treasury: { near: 'treasury.near', hl_builder: '0xab', referral_codes: { hyperliquid: 'GIMBAL', orderly: null, phoenix: null } },
    fees: { performance_bps: 1000, hl_builder_tenth_bps: 10 },
    orderly: { broker_id: 'broker', chain_id: 42161 },
  });
  env.set('HL_REFERRAL_CODE', { value: 'x'.repeat(21), from: '.env' });
  assert.throws(() => referralCodes(env), /more than 20 characters/);
  assert.equal(canonical({ b: 1, a: [{ d: null, c: 'x' }] }), canonical({ a: [{ c: 'x', d: null }], b: 1 }));
});

test('the wasm\'s exported methods: read from its export section, functions only', () => {
  const str = (s) => [s.length, ...Buffer.from(s)];
  // Two function exports and a memory export; the type and custom sections around them are skipped.
  const exports = [3, ...str('new'), 0, 0, ...str('memory'), 2, 0, ...str('config'), 0, 0x81, 0x01];
  const wasm = Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x07, exports.length, ...exports,
    0x00, 0x03, ...str('x'), 0xff,
  ]);
  assert.deepEqual(wasmExports(wasm), ['new', 'config']);
  assert.throws(() => wasmExports(Buffer.from('not wasm at all')), /not a wasm module/);
  assert.throws(() => wasmExports(wasm.subarray(0, 20)), /truncated/);
  assert.deepEqual(MONEY_METHODS, ['ft_on_transfer', 'fund_venue', 'withdraw_to_owner', 'clear_payout_lock']);
});

test('a taken name is never reused: the next free one is proposed (stem + number)', async () => {
  const taken = new Set(['gimbal-canary.near', 'gimbal-canary2.near', 'gimbal-canary3.near']);
  const exists = async (id) => taken.has(id);
  assert.equal(await nextFreeName('gimbal-canary.near', exists), 'gimbal-canary4.near');
  assert.equal(await nextFreeName('gimbal-canary2.near', exists), 'gimbal-canary4.near');
  assert.equal(await nextFreeName('desk9.near', async () => false), 'desk10.near');
  assert.equal(await nextFreeName('x.near', async () => true, 3), null, 'gives up after the tries');
});

test('the treasury must be registered on USDC on NEAR, else every fee transfer fails', async () => {
  const { NEAR_USDC: fromBalances } = await import('./balances.mjs');
  assert.equal(NEAR_USDC, fromBalances, 'one USDC contract everywhere');
  assert.equal(NEAR_USDC, '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
  assert.match(treasuryUsdcLine('treasury.near', { total: '1250000000000000000000', available: '0' }), /^treasury\.near is registered on USDC on NEAR/);
  const line = treasuryUsdcLine('treasury.near', null);
  assert.match(line, /^warning: treasury\.near is NOT registered/);
  assert.match(line, /fee would stay in the desk's idle USDC/);
  assert.match(line, /storage_deposit\(\{"account_id":"treasury\.near","registration_only":true\}\) with 0\.00125 NEAR/);
});

test('the script itself: a testnet id or a --send without a key ends with the usage, before any network read', () => {
  const script = fileURLToPath(new URL('./deploy.mjs', import.meta.url));
  for (const argv of [['gimbal.testnet', ...OK.slice(1)], [...OK, '--send'], ['gimbal.testnet', '--lock'], ['gimbal.testnet', '--lock', '--send']]) {
    const r = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', env: { ...process.env, NEAR_RPC_URL: 'http://127.0.0.1:9' } });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /usage: node tools\/mainnet\/deploy\.mjs/);
  }
});


// --- the lock (tx 3) ---

const CONTRACT = 'gimbal.near';
const BUILDER = '0x00000000000000000000000000000000000000ab';
const OWN_KEY = `ed25519:${b58encode(Buffer.alloc(32, 9))}`;
const OTHER_KEY = `ed25519:${b58encode(Buffer.alloc(32, 5))}`;
const REV = 'a'.repeat(40);
const IMAGE = 'sourcescan/cargo-near:0.22.0-rust-1.86.0@sha256:' + 'b'.repeat(64);
const SNAPSHOT = `git+https://github.com/example/gimbal?rev=${REV}`;
/** A wasm module whose only section is a custom one holding `json` (as near-sdk's NEP-330 literal sits in data). */
function wasmWith(json) {
  const leb = (n) => {
    const out = [];
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n !== 0) byte |= 0x80;
      out.push(byte);
    } while (n !== 0);
    return out;
  };
  const payload = [1, 0x78, ...Buffer.from(`\0\0${json}\0E_ARGS`)];
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, ...leb(payload.length), ...payload]);
}
const META = (buildInfo) => JSON.stringify({ version: '0.1.0', link: null, standards: [{ standard: 'nep330', version: '1.3.0' }], build_info: buildInfo });
const REPRO_WASM = wasmWith(META({
  build_environment: IMAGE, build_command: ['cargo', 'near', 'build', 'reproducible-wasm'], contract_path: 'contract', source_code_snapshot: SNAPSHOT, output_wasm_path: null,
}));
const PLAIN_WASM = wasmWith(META(null));
const shaOf = (w) => sha256(w).toString('hex');
const hashOf = (w) => b58encode(sha256(w));
const CARGO = '[package]\nname = "gimbal"\nversion = "0.1.0"\n\n[package.metadata.near.reproducible_build]\nimage = "sourcescan/cargo-near:0.22.0"\n';
const CARGO_PLAIN = '[package]\nname = "gimbal"\nversion = "0.1.0"\n\n[dependencies]\nnear-sdk = "~5.29"\n';
const NO_CODES = { hyperliquid: null, orderly: null, phoenix: null };
const CONFIG = initArgs({ treasuryNear: 'treasury.near', hlBuilder: BUILDER, codes: NO_CODES, brokerId: 'gimbal_dex' });
const FEE = { send_sir: 100, send_not_sir: 100, execution: 100 };
const FEES = { receipt: FEE, deploy: FEE, deployByte: FEE, call: FEE, callByte: FEE, addKey: FEE, addKeyByte: FEE, deleteAccount: FEE, deleteKey: FEE };
const fullAccess = (public_key) => ({ public_key, access_key: { nonce: 1, permission: 'FullAccess' } });
const LOCK = [CONTRACT, '--lock', '--treasury-near', 'treasury.near', '--hl-builder', BUILDER];
const AT = '2026-11-03T12:00:00.000Z';

/** A deployed contract with its one key, built reproducibly from a clean pushed checkout (`o` changes it). */
function lockWorld(o = {}) {
  const wasm = o.wasm ?? REPRO_WASM;
  const st = { keys: o.keys ?? [fullAccess(OWN_KEY)], sent: [], dockerAsked: 0 };
  const exists = new Set(['v1.signer', 'price-oracle.near', 'funder.near', ...(o.treasuryMissing ? [] : ['treasury.near'])]);
  const client = {
    rpc: async (method) => {
      if (method === 'status') return { chain_id: o.chain ?? 'mainnet', sync_info: { latest_block_height: 1 } };
      if (method === 'gas_price') return { gas_price: '100000000' };
      throw new Error(`unexpected rpc ${method}`);
    },
    account: async (id) => {
      if (id === CONTRACT) return o.account === null ? null : { amount: String(7n * NEAR), locked: '0', storage_usage: 700_000, code_hash: o.codeHash ?? hashOf(wasm) };
      return exists.has(id) ? { amount: String(8n * NEAR), locked: '0', storage_usage: 500, code_hash: NO_CODE } : null;
    },
    view: async (id, method) => {
      if (id === CONTRACT && method === 'config') return o.config ?? CONFIG;
      if (id === CONTRACT && method === 'version') return o.version ?? '0.1.0';
      if (id === NEAR_USDC && method === 'storage_balance_of') return o.treasuryUnregistered ? null : { total: '1250000000000000000000', available: '0' };
      throw new Error(`unexpected view ${id}.${method}`);
    },
    accessKey: async () => null,
    accessKeys: async (id) => {
      assert.equal(id, CONTRACT);
      return st.keys;
    },
    fees: async () => FEES,
    send: async (signer, receiver, actions, { onSent } = {}) => {
      st.sent.push({ signer: signer.accountId, receiver, actions });
      onSent?.('LockTx111');
      st.keys = o.keysAfter ?? [];
      return { hash: 'LockTx111', value: null, failure: o.failure ?? null, logs: [], burntTgas: 0.4, burntYocto: 1n };
    },
  };
  const out = [];
  const deps = {
    client,
    say: (s = '') => out.push(s),
    readWasm: () => wasm,
    envOf: (names) => new Map(names.map((n) => [n, n === 'ORDERLY_BROKER_ID' ? { value: 'gimbal_dex', from: '.env' } : { value: null, from: null }])),
    readKey: (file, accountId) => ({ accountId, file, publicKeyString: OWN_KEY, publicKey: Buffer.alloc(32, 9), sign: () => Buffer.alloc(64) }),
    keyExists: () => o.keyFile !== false,
    fetch: async () => new Response(JSON.stringify({ marginSummary: { accountValue: '150.0' } }), { headers: { 'content-type': 'application/json' } }),
    at: () => AT,
    git: () => ({ head: o.head ?? REV, clean: o.dirty === undefined, changed: o.dirty ?? [], pushed: o.pushed !== false }),
    docker: () => {
      st.dockerAsked++;
      return o.docker ?? { ok: true, version: '29.5.3' };
    },
    cargoNear: () => '0.22.0',
    readCargoToml: () => o.cargo ?? CARGO,
  };
  const run = async (argv) => {
    let error = null;
    let result;
    try {
      result = await runDeploy(argv, deps);
    } catch (e) {
      error = e;
    }
    return { error, result, out: out.join('\n') };
  };
  return { st, run };
}

test('lock arguments: its own run; the dry run may leave out the treasury and builder, --send needs both; mainnet only', () => {
  assert.deepEqual(parseDeployArgs([CONTRACT, '--lock']), {
    contract: CONTRACT, funder: null, keyFile: null, treasuryNear: null, hlBuilder: null, balance: null, send: false, resume: false, lock: true, nonReproducible: false,
  });
  const a = parseDeployArgs([...LOCK, '--send', '--non-reproducible']);
  assert.equal(a.send, true, '--lock --send needs no --key-file: the contract key signs');
  assert.equal(a.nonReproducible, true);
  usage([CONTRACT, '--lock', '--send'], /--lock --send needs --treasury-near: config\(\) is checked against it/);
  usage([CONTRACT, '--lock', '--send', '--treasury-near', 'treasury.near'], /--lock --send needs --hl-builder/);
  for (const f of [['--funder', 'funder.near'], ['--key-file', 'k.json'], ['--balance', '7'], ['--resume']]) {
    usage([CONTRACT, '--lock', ...f], new RegExp(`--lock is its own run on an account deployed earlier: drop ${f[0]}`));
  }
  usage([...OK, '--non-reproducible'], /--non-reproducible goes with --lock only/);
  usage([...OK, '--allow-testnet-lock'], /unknown option --allow-testnet-lock/);
  usage(['gimbal.testnet', '--lock'], /--lock refuses testnet \(gimbal\.testnet\): testnet contracts stay upgradeable/);
  usage([CONTRACT, '--lock', '--hl-builder', '0x12'], /not 0x and 40 hex digits/);
});

test('the lock refuses every chain but mainnet', async () => {
  assert.equal(lockNetworkProblem('mainnet'), null);
  assert.match(lockNetworkProblem('testnet'), /--lock never runs there \(testnet contracts stay upgradeable\)/);
  assert.match(lockNetworkProblem('localnet'), /chain "localnet": --lock runs on mainnet only/);
  const w = lockWorld({ chain: 'testnet' });
  const r = await w.run([...LOCK, '--send']);
  assert.match(r.error.message, /--lock never runs there/);
  assert.deepEqual(w.st.sent, []);
});

test('the build: NEP-330 metadata read from the wasm, reproducible only with build_info; Cargo.toml version and section', () => {
  assert.deepEqual(buildProvenance(wasmSourceMetadata(REPRO_WASM)), {
    reproducible: true, version: '0.1.0', rev: REV, snapshot: SNAPSHOT, environment: IMAGE, command: 'cargo near build reproducible-wasm',
  });
  assert.deepEqual(buildProvenance(wasmSourceMetadata(PLAIN_WASM)), { reproducible: false, version: '0.1.0' });
  assert.equal(wasmSourceMetadata(Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0])), null);
  assert.deepEqual(cargoPackageInfo(CARGO), { version: '0.1.0', reproducible: true });
  assert.deepEqual(cargoPackageInfo(CARGO_PLAIN), { version: '0.1.0', reproducible: false });
  const down = { ok: false, detail: 'failed to connect to the docker API' };
  assert.deepEqual(reproducibleBuildProblems({ cargo: { reproducible: true }, docker: { ok: true } }), []);
  const both = reproducibleBuildProblems({ cargo: { reproducible: false }, docker: down }).join('\n');
  assert.match(both, /contract\/Cargo\.toml has no \[package\.metadata\.near\.reproducible_build\] section/);
  assert.match(both, /Docker's engine is not running \(docker version: failed to connect to the docker API\): start Docker Desktop, then build again/);
});

test('plan without --lock: the deploy dry run prints tx 1, tx 2 and tx 3 (the DeleteKey) as its own later run, and sends nothing', async () => {
  const w = lockWorld({ account: null, wasm: PLAIN_WASM });
  const r = await w.run(OK);
  assert.equal(r.error, null, r.error?.message);
  assert.match(r.out, /^tx 1: create the account$/m);
  assert.match(r.out, /^tx 2: deploy and initialise$/m);
  assert.match(r.out, /^tx 3, its own run \(--lock\), after you checked the deployed contract: lock the account$/m);
  assert.match(r.out, /action 1 {2}DeleteKey ed25519:<the key in .*gimbal-canary\.near\.json>: the key is removed from gimbal-canary\.near/);
  assert.match(r.out, /node tools\/mainnet\/deploy\.mjs gimbal-canary\.near --lock --treasury-near treasury\.near --hl-builder 0x0{38}ab, then the same with --send/);
  assert.match(r.out, /build {5}non-reproducible \(build_info null\): fine for a canary; the final deploy, which gets locked, is built with `cd contract && cargo near build reproducible-wasm`/);
  assert.match(r.out, /--send never sends tx 3/);
  assert.deepEqual(w.st.sent, []);
});

test('plan with --lock: only the DeleteKey of the key file\'s key, after every check passed; nothing sent', async () => {
  const w = lockWorld();
  const r = await w.run(LOCK);
  assert.equal(r.error, null, r.error?.message);
  assert.doesNotMatch(r.out, /^tx [12]/m);
  assert.match(r.out, new RegExp(`checkout  commit ${REV}, clean, on the remote`));
  assert.match(r.out, new RegExp(`build {5}reproducible: cargo near build reproducible-wasm, image ${IMAGE.replace(/[.+]/g, '\\$&')}, source ${SNAPSHOT.replace(/[.?+/]/g, '\\$&')}`));
  assert.match(r.out, new RegExp(`code {6}the code on chain is the built wasm: code_hash ${hashOf(REPRO_WASM)}`));
  assert.match(r.out, /config {3}matches/);
  assert.match(r.out, /treasury  treasury\.near is registered on USDC on NEAR/);
  assert.match(r.out, new RegExp(`keys {6}1 access key on chain:\\n {10}${OWN_KEY} FullAccess \\(the key file\\)`));
  assert.match(r.out, /^tx 3: lock the account\n {2}signer {4}gimbal\.near {2}\(the key itself, .*gimbal\.near\.json\)\n {2}receiver {2}gimbal\.near$/m);
  assert.match(r.out, new RegExp(`action 1 {2}DeleteKey ${OWN_KEY}: the key is removed from gimbal\\.near`));
  assert.match(r.out, /view_access_key_list of gimbal\.near is empty: nobody, us included, can deploy code to it/);
  assert.match(r.out, /gas {7}at most 0\.1 TGas \(action fees only\)/);
  assert.match(r.out, /dry run: nothing was signed or sent/);
  assert.doesNotMatch(r.out, /private_key|secret/);
  assert.equal(w.st.dockerAsked, 0, 'a reproducible wasm needs no Docker check');
  assert.deepEqual(w.st.sent, []);
  // The dry run may leave out --treasury-near and --hl-builder: they are taken from config() with a warning.
  const unchecked = await lockWorld().run([CONTRACT, '--lock']);
  assert.equal(unchecked.error, null, unchecked.error?.message);
  assert.match(unchecked.out, /warning {3}treasury "treasury\.near" and builder "0x0{38}ab" are taken as they are: pass --treasury-near and --hl-builder to check them/);
});

test('--lock on a name that does not exist: the plan with a placeholder key, and --send would refuse', async () => {
  const w = lockWorld({ account: null, keyFile: false });
  const r = await w.run([CONTRACT, '--lock']);
  assert.match(r.out, /does not exist, so its code hash, config\(\) and keys are not checked/);
  assert.match(r.out, /DeleteKey ed25519:<the key in .*gimbal\.near\.json>/);
  assert.match(r.error.message, /--send would refuse:\n {2}gimbal\.near does not exist: deploy it first/);
  assert.deepEqual(w.st.sent, []);
});

test('refused: another key on the account (printed), and the --send never signs', async () => {
  const fc = { public_key: OTHER_KEY, access_key: { nonce: 3, permission: { FunctionCall: { allowance: String(NEAR / 4n), receiver_id: CONTRACT, method_names: ['set_paused'] } } } };
  for (const other of [fullAccess(OTHER_KEY), fc]) {
    const w = lockWorld({ keys: [fullAccess(OWN_KEY), other] });
    const r = await w.run([...LOCK, '--send']);
    assert.match(r.error.message, /not locking gimbal\.near:\n {2}the account has 1 other access key; a lock leaves no key at all/);
    assert.ok(r.error.message.includes(accessKeyLine(other)), r.error.message);
    assert.match(r.out, /keys {6}2 access keys on chain:/);
    assert.ok(r.out.includes(`          ${accessKeyLine(other)}`), 'every key on chain is printed');
    assert.deepEqual(w.st.sent, []);
  }
  assert.equal(accessKeyLine(fc), `${OTHER_KEY} FunctionCall receiver gimbal.near, allowance 0.25 NEAR, methods ["set_paused"]`);
  assert.match(lockKeyProblems([fullAccess(OTHER_KEY)], OWN_KEY).join('\n'), /the key file's key .* is not on the account[\s\S]*1 other access key/);
  assert.match(lockKeyProblems([{ ...fc, public_key: OWN_KEY }], OWN_KEY).join('\n'), /not full access on chain/);
  assert.deepEqual(lockKeyProblems([fullAccess(OWN_KEY)], null), [`the key file is missing, so the key that signs the DeleteKey is unknown (on chain: ${OWN_KEY} FullAccess)`]);
  assert.deepEqual(lockKeyProblems([fullAccess(OWN_KEY)], OWN_KEY), []);
});

test('refused: the code on chain is not the built wasm', async () => {
  const w = lockWorld({ codeHash: 'E8Zp9eM2Jh2DRx31Ez9M9bKMRaXbDkJcZ3sVkjnTBgcs' });
  const r = await w.run([...LOCK, '--send']);
  assert.match(r.error.message, new RegExp(`code_hash E8Zp9eM2Jh2DRx31Ez9M9bKMRaXbDkJcZ3sVkjnTBgcs on chain is not ${hashOf(REPRO_WASM)}, the base58 sha256 of contract/target/near/gimbal\\.wasm`));
  assert.deepEqual(w.st.sent, []);
  const none = await lockWorld({ codeHash: NO_CODE }).run(LOCK);
  assert.match(none.error.message, /has no code: deploy it first/);
});

test('refused: config() is not what new() was given (every differing field named)', async () => {
  const bad = { ...CONFIG, fees: { performance_bps: 2000, hl_builder_tenth_bps: 10 }, treasury: { ...CONFIG.treasury, near: 'someone.near' } };
  const w = lockWorld({ config: bad });
  const r = await w.run([...LOCK, '--send']);
  assert.match(r.error.message, /config\.fees\.performance_bps: expected 1000, on chain 2000/);
  assert.match(r.error.message, /config\.treasury\.near: expected "treasury\.near", on chain "someone\.near"/);
  assert.deepEqual(w.st.sent, []);
  assert.deepEqual(lockConfigProblems({ ...CONFIG, treasury: { ...CONFIG.treasury, near: 'someone.near' } }, { codes: NO_CODES, brokerId: 'gimbal_dex' }), []);
  assert.deepEqual(configDiff({ a: 1, b: { c: 'x' } }, { a: 1, b: { c: 'x' } }), []);
  assert.deepEqual(configDiff({ a: 1 }, { a: 1, b: null }), ['config.b: expected null, on chain missing']);
});

test('refused: a treasury that does not exist or is not on USDC, and version() other than contract/Cargo.toml', async () => {
  const missing = await lockWorld({ treasuryMissing: true }).run([...LOCK, '--send']);
  assert.match(missing.error.message, /the treasury "treasury\.near" does not exist on mainnet/);
  const unregistered = await lockWorld({ treasuryUnregistered: true }).run([...LOCK, '--send']);
  assert.match(unregistered.error.message, /the treasury treasury\.near is not registered on USDC on NEAR: register it first/);
  const version = await lockWorld({ version: '0.2.0' }).run([...LOCK, '--send']);
  assert.match(version.error.message, /version\(\) is "0\.2\.0", contract\/Cargo\.toml says "0\.1\.0"/);
  const crate = await lockWorld({ cargo: CARGO.replace('version = "0.1.0"', 'version = "0.3.0"') }).run([...LOCK, '--send']);
  assert.match(crate.error.message, /the wasm says version 0\.1\.0, contract\/Cargo\.toml 0\.3\.0: build this checkout/);
});

test('refused: a dirty or unpushed checkout', async () => {
  const w = lockWorld({ dirty: [' M contract/src/lib.rs'] });
  const r = await w.run([...LOCK, '--send']);
  assert.match(r.out, /checkout  commit a{40}, 1 uncommitted change, on the remote\n {10} M contract\/src\/lib\.rs/);
  assert.match(r.error.message, /the checkout has uncommitted changes: commit or stash them/);
  assert.deepEqual(w.st.sent, []);
  const unpushed = await lockWorld({ pushed: false }).run([...LOCK, '--send']);
  assert.match(unpushed.error.message, /commit a{40} is on no remote branch: push it/);
});

test('refused: a non-reproducible wasm, with why reproducible-wasm cannot run here; --non-reproducible locks it with honest evidence', async () => {
  const down = { ok: false, detail: 'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine' };
  const w = lockWorld({ wasm: PLAIN_WASM, docker: down, cargo: CARGO_PLAIN });
  const r = await w.run([...LOCK, '--send']);
  assert.match(r.error.message, /the wasm was not built with `cd contract && cargo near build reproducible-wasm`/);
  assert.match(r.error.message, /Docker's engine is not running \(docker version: failed to connect.*\): start Docker Desktop, then build again/);
  assert.match(r.error.message, /no \[package\.metadata\.near\.reproducible_build\] section/);
  assert.match(r.error.message, /--non-reproducible locks this build anyway/);
  assert.match(r.out, /build {5}non-reproducible \(build_info null in the wasm's NEP-330 metadata\); cargo-near 0\.22\.0 installed here/);
  assert.deepEqual(w.st.sent, []);
  const ready = await lockWorld({ wasm: PLAIN_WASM }).run([...LOCK, '--send']);
  assert.match(ready.error.message, /Docker and contract\/Cargo\.toml are ready for it/);

  const forced = lockWorld({ wasm: PLAIN_WASM, docker: down, cargo: CARGO_PLAIN });
  const f = await forced.run([...LOCK, '--send', '--non-reproducible']);
  assert.equal(f.error, null, f.error?.message);
  assert.equal(forced.st.sent.length, 1);
  assert.equal(forced.st.dockerAsked, 0, '--non-reproducible asks Docker nothing');
  assert.ok(f.result.includes(`build:     non-reproducible (build_info null), cargo-near 0.22.0 installed here: nobody can rebuild these bytes; the sha256 identifies the exact file`));
  assert.ok(f.result.includes(`Contract has no access keys: DeleteKey tx LockTx111 (https://nearblocks.io/txns/LockTx111), code_hash ${hashOf(PLAIN_WASM)}. `
    + `Built from commit ${REV} with cargo-near 0.22.0, non-reproducible: the sha256 ${shaOf(PLAIN_WASM)} identifies the exact file.`));
});

test('--lock --send: one DeleteKey signed by that key, the key list read empty after, the evidence block and the key file called useless', async () => {
  const w = lockWorld();
  const r = await w.run([...LOCK, '--send']);
  assert.equal(r.error, null, r.error?.message);
  assert.equal(w.st.sent.length, 1);
  assert.deepEqual(w.st.sent[0], { signer: CONTRACT, receiver: CONTRACT, actions: [{ type: 'DeleteKey', publicKey: OWN_KEY }] });
  const build = buildProvenance(wasmSourceMetadata(REPRO_WASM));
  const evidence = lockEvidence({ at: AT, contract: CONTRACT, hash: 'LockTx111', codeHash: hashOf(REPRO_WASM), wasmSha256: shaOf(REPRO_WASM), wasmBytes: REPRO_WASM.length, version: '0.1.0', commit: REV, build });
  assert.deepEqual(r.result, evidence);
  assert.ok(r.out.includes(evidence.join('\n')));
  assert.deepEqual(evidence, [
    `=== gimbal lock ${AT} ===`,
    'contract:  gimbal.near https://nearblocks.io/address/gimbal.near',
    'DeleteKey: tx LockTx111 https://nearblocks.io/txns/LockTx111',
    `code_hash: ${hashOf(REPRO_WASM)}`,
    `sha256:    ${shaOf(REPRO_WASM)} (contract/target/near/gimbal.wasm, ${REPRO_WASM.length} bytes)`,
    'version:   0.1.0 (contract/Cargo.toml, version() on chain)',
    `checkout:  commit ${REV}, clean, on the remote`,
    `build:     reproducible: cargo near build reproducible-wasm, image ${IMAGE}, source ${SNAPSHOT}`,
    'keys:      view_access_key_list is empty',
    'README:',
    `Contract has no access keys: DeleteKey tx LockTx111 (https://nearblocks.io/txns/LockTx111), code_hash ${hashOf(REPRO_WASM)} (sha256 ${shaOf(REPRO_WASM)}), `
      + `a reproducible build (${IMAGE}) of ${SNAPSHOT}.`,
    '=== end ===',
  ]);
  assert.match(r.out, /key file {2}.*gimbal\.near\.json is now useless: its key is on no account any more and can sign nothing\. You can delete it\./);
  assert.doesNotMatch(r.out, /private_key|secret/);
});

test('--lock --send: a key still listed after the DeleteKey, or a failed DeleteKey, is an error', async () => {
  const still = await lockWorld({ keysAfter: [fullAccess(OWN_KEY)] }).run([...LOCK, '--send']);
  assert.match(still.error.message, /still has access keys after LockTx111/);
  const failed = await lockWorld({ failure: { ActionError: { kind: 'DeleteKeyDoesNotExist' } } }).run([...LOCK, '--send']);
  assert.match(failed.error.message, /DeleteKey LockTx111: .*the key is still on the account/);
});

test('a rerun that finds no keys (a lock whose outcome was not seen): the evidence block without the hash, and the hash from nearblocks', async () => {
  const w = lockWorld({ keys: [] });
  const r = await w.run([...LOCK, '--send']);
  assert.equal(r.error, null, r.error?.message);
  assert.deepEqual(w.st.sent, []);
  assert.match(r.out, /nothing to send: gimbal\.near has no access keys, it is locked already/);
  assert.ok(r.result.includes('DeleteKey: not seen by this run (the account had no keys when it was read): take its hash from https://nearblocks.io/address/gimbal.near'));
  assert.ok(r.result.at(-2).startsWith('Contract has no access keys: DeleteKey tx <the DeleteKey\'s hash from https://nearblocks.io/address/gimbal.near>, code_hash '));
  assert.match(r.out, /hash {6}take the DeleteKey's transaction hash from https:\/\/nearblocks\.io\/address\/gimbal\.near/);
  const wrong = await lockWorld({ keys: [], codeHash: 'E8Zp9eM2Jh2DRx31Ez9M9bKMRaXbDkJcZ3sVkjnTBgcs' }).run(LOCK);
  assert.match(wrong.error.message, /no evidence block, because:\n {2}code_hash E8Zp/);
});

test('DeleteKey: its fee in the gas cap, printed with its key', () => {
  assert.throws(() => act.deleteKey('ed25519:short'), /not an ed25519 public key/);
  const cfg = { runtime_config: { transaction_costs: { action_receipt_creation_config: FEE, action_creation_config: {
    deploy_contract_cost: FEE, deploy_contract_cost_per_byte: FEE, function_call_cost: FEE, function_call_cost_per_byte: FEE,
    add_key_cost: { function_call_cost: FEE, function_call_cost_per_byte: FEE },
  } } } };
  assert.throws(() => txGasCap(feesOf(cfg), { signer: 'g.near', receiver: 'g.near', actions: [act.deleteKey(OWN_KEY)] }), /no delete_key_cost/);
  cfg.runtime_config.transaction_costs.action_creation_config.delete_key_cost = { send_sir: 94946625000, send_not_sir: 94946625000, execution: 94946625000 };
  const cap = txGasCap(feesOf(cfg), { signer: 'g.near', receiver: 'g.near', actions: [act.deleteKey(OWN_KEY)] });
  assert.equal(cap.total, 200n + 2n * 94946625000n, 'the receipt (100 + 100, signer = receiver) and the DeleteKey');
  assert.equal(cap.prepaid, 0n);
  const lines = describeTx('tx', { signer: 'g.near', signedBy: 'its key', receiver: 'g.near', actions: [act.deleteKey(OWN_KEY)] }).join('\n');
  assert.match(lines, new RegExp(`action 1 {2}DeleteKey ${OWN_KEY}: the key is removed from g\\.near`));
});
