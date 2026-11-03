import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { b58encode, sha256 } from '../testnet/near.mjs';
import { UsageError } from './cli.mjs';
import {
  LOCK_METHODS, MONEY_METHODS, NEAR_USDC, accessKeyLine, buildProvenance, canonical, cargoPackageInfo, checkFunder, configDiff, deployPlanFor, initArgs, initialBalance, lockConfigProblems,
  lockEvidence, lockKeyProblems, isCanary, lockNetworkProblem, minInitialBalance, nextFreeName, parseDeployArgs, referralCodes, reproducibleBuildProblems, runDeploy,
  treasuryUsdcLine, wasmExports, wasmSourceMetadata,
} from './deploy.mjs';
import { NO_CODE } from './near.mjs';

const NEAR = 10n ** 24n;
const OK = ['gimbal-canary.near', '--funder', 'funder.near', '--treasury-near', 'treasury.near', '--hl-builder', '0x00000000000000000000000000000000000000AB'];
const usage = (argv, pattern) => assert.throws(() => parseDeployArgs(argv), (e) => e instanceof UsageError && pattern.test(e.message), argv.join(' '));

test('deploy arguments: a dry run needs no key file; the builder is lowercased', () => {
  const a = parseDeployArgs(OK);
  assert.deepEqual(a, {
    contract: 'gimbal-canary.near', funder: 'funder.near', keyFile: null, treasuryNear: 'treasury.near',
    hlBuilder: '0x00000000000000000000000000000000000000ab', balance: null, send: false, resume: false, lock: false, nonReproducible: false,
    confirmLock: null,
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
const RUSTC = 'rustc 1.86.0 (05f9846f8 2025-03-31)';
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
/**
 * A wasm module with an export section (each of `exports` a function) and a custom section holding `json` (as
 * near-sdk's NEP-330 literal sits in data).
 */
function wasmWith(json, exports = LOCK_METHODS) {
  const names = exports.flatMap((m) => [...leb(Buffer.byteLength(m)), ...Buffer.from(m), 0, 0]);
  const exportSection = [...leb(exports.length), ...names];
  const payload = [1, 0x78, ...Buffer.from(`\0\0${json}\0E_ARGS`)];
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x07, ...leb(exportSection.length), ...exportSection,
    0x00, ...leb(payload.length), ...payload,
  ]);
}
const META = (buildInfo) => JSON.stringify({ version: '0.1.0', link: null, standards: [{ standard: 'nep330', version: '1.3.0' }], build_info: buildInfo });
const BUILD_INFO = {
  build_environment: IMAGE, build_command: ['cargo', 'near', 'build', 'reproducible-wasm'], contract_path: 'contract', source_code_snapshot: SNAPSHOT, output_wasm_path: null,
};
const REPRO_WASM = wasmWith(META(BUILD_INFO));
const PLAIN_WASM = wasmWith(META(null));
/** An earlier build on disk: the C8 money methods only (no panic_close, no venue returns). */
const STALE_WASM = wasmWith(META(null), MONEY_METHODS);
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
const LOCK_SEND = [...LOCK, '--send', '--confirm-lock', CONTRACT];
const AT = '2026-11-03T12:00:00.000Z';
const DOWN = { ok: false, installed: true, detail: 'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine' };

/**
 * A deployed contract with its one key, built reproducibly from a clean pushed checkout (`o` changes it). `rebuilt`
 * is the wasm the --non-reproducible rebuild writes, `gitAfter` the checkout after it.
 */
function lockWorld(o = {}) {
  let wasm = o.wasm ?? REPRO_WASM;
  const deployed = o.codeHash ?? hashOf(o.rebuilt ?? wasm);
  const st = { keys: o.keys ?? [fullAccess(OWN_KEY)], sent: [], dockerAsked: 0, rebuilds: 0, gitCalls: [] };
  const exists = new Set(['v1.signer', 'price-oracle.near', 'funder.near', ...(o.treasuryMissing ? [] : ['treasury.near'])]);
  const client = {
    rpc: async (method) => {
      if (method === 'status') return { chain_id: o.chain ?? 'mainnet', sync_info: { latest_block_height: 1 } };
      if (method === 'gas_price') return { gas_price: '100000000' };
      throw new Error(`unexpected rpc ${method}`);
    },
    account: async (id) => {
      // 7 NEAR, 600,000 bytes stored (6 NEAR): 1 NEAR free above storage.
      if (id === CONTRACT) return o.account === null ? null : { amount: String(7n * NEAR), locked: '0', storage_usage: 600_000, code_hash: deployed };
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
  const checkout = { head: o.head ?? REV, clean: o.dirty === undefined, changed: o.dirty ?? [], pushed: o.pushed !== false, fetchError: o.fetchError ?? null };
  const deps = {
    client,
    say: (s = '') => out.push(s),
    readWasm: () => wasm,
    envOf: (names) => new Map(names.map((n) => [n, n === 'ORDERLY_BROKER_ID' ? { value: 'gimbal_dex', from: '.env' } : { value: null, from: null }])),
    readKey: (file, accountId) => ({ accountId, file, publicKeyString: OWN_KEY, publicKey: Buffer.alloc(32, 9), sign: () => Buffer.alloc(64) }),
    keyExists: () => o.keyFile !== false,
    fetch: async () => new Response(JSON.stringify({ marginSummary: { accountValue: '150.0' } }), { headers: { 'content-type': 'application/json' } }),
    at: () => AT,
    git: (opts = {}) => {
      st.gitCalls.push(opts);
      return st.rebuilds > 0 && o.gitAfter ? o.gitAfter : checkout;
    },
    docker: () => {
      st.dockerAsked++;
      return o.docker ?? { ok: true, installed: true, version: '29.5.3' };
    },
    cargoNear: () => '0.22.0',
    rustc: () => RUSTC,
    readCargoToml: () => o.cargo ?? CARGO,
    rebuild: () => {
      st.rebuilds++;
      if (o.rebuildFails) return { ok: false, detail: o.rebuildFails };
      wasm = o.rebuilt ?? wasm;
      return { ok: true };
    },
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

test('lock arguments: its own run, never on a canary; --send needs the treasury, the builder and --confirm-lock with the same account', () => {
  assert.deepEqual(parseDeployArgs([CONTRACT, '--lock']), {
    contract: CONTRACT, funder: null, keyFile: null, treasuryNear: null, hlBuilder: null, balance: null, send: false, resume: false, lock: true, nonReproducible: false,
    confirmLock: null,
  });
  const a = parseDeployArgs([...LOCK_SEND, '--non-reproducible']);
  assert.equal(a.send, true, '--lock --send needs no --key-file: the contract key signs');
  assert.equal(a.nonReproducible, true);
  assert.equal(a.confirmLock, CONTRACT);
  usage([CONTRACT, '--lock', '--send'], /--lock --send needs --treasury-near: config\(\) is checked against it/);
  usage([CONTRACT, '--lock', '--send', '--treasury-near', 'treasury.near'], /--lock --send needs --hl-builder/);
  usage([...LOCK, '--send'], /--lock --send needs --confirm-lock gimbal\.near, the exact account typed again: a locked contract is locked for good/);
  usage([...LOCK, '--send', '--confirm-lock', 'gimbal2.near'], /needs --confirm-lock gimbal\.near, the exact account typed again \(not gimbal2\.near\)/);
  usage([...OK, '--confirm-lock', 'gimbal-canary.near'], /--confirm-lock goes with --lock only/);
  for (const f of [['--funder', 'funder.near'], ['--key-file', 'k.json'], ['--balance', '7'], ['--resume']]) {
    usage([CONTRACT, '--lock', ...f], new RegExp(`--lock is its own run on an account deployed earlier: drop ${f[0]}`));
  }
  usage([...OK, '--non-reproducible'], /--non-reproducible goes with --lock only/);
  usage([...OK, '--allow-testnet-lock'], /unknown option --allow-testnet-lock/);
  usage(['gimbal.testnet', '--lock'], /--lock refuses testnet \(gimbal\.testnet\): testnet contracts stay upgradeable/);
  for (const canary of ['gimbal-canary.near', 'gimbal-canary2.near', 'canary.near']) {
    usage([canary, '--lock'], new RegExp(`--lock refuses ${canary.replace(/\./g, '\\.')}: a canary is never locked \\(it gets retired\\)`));
    usage([canary, '--lock', '--send', '--treasury-near', 'treasury.near', '--hl-builder', BUILDER, '--confirm-lock', canary], /a canary is never locked/);
    assert.equal(isCanary(canary), true);
  }
  assert.equal(isCanary(CONTRACT), false);
  usage([CONTRACT, '--lock', '--hl-builder', '0x12'], /not 0x and 40 hex digits/);
});

test('the lock refuses every chain but mainnet', async () => {
  assert.equal(lockNetworkProblem('mainnet'), null);
  assert.match(lockNetworkProblem('testnet'), /--lock never runs there \(testnet contracts stay upgradeable\)/);
  assert.match(lockNetworkProblem('localnet'), /chain "localnet": --lock runs on mainnet only/);
  const w = lockWorld({ chain: 'testnet' });
  const r = await w.run(LOCK_SEND);
  assert.match(r.error.message, /--lock never runs there/);
  assert.deepEqual(w.st.sent, []);
});

test('the build: NEP-330 metadata read from the wasm, reproducible only with build_info; Cargo.toml version and section; Docker missing or down', () => {
  assert.deepEqual(buildProvenance(wasmSourceMetadata(REPRO_WASM)), {
    reproducible: true, version: '0.1.0', rev: REV, snapshot: SNAPSHOT, environment: IMAGE, command: 'cargo near build reproducible-wasm',
  });
  assert.deepEqual(buildProvenance(wasmSourceMetadata(PLAIN_WASM)), { reproducible: false, version: '0.1.0' });
  assert.equal(wasmSourceMetadata(Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0])), null);
  assert.deepEqual(wasmExports(REPRO_WASM), LOCK_METHODS);
  assert.deepEqual(cargoPackageInfo(CARGO), { version: '0.1.0', reproducible: true });
  assert.deepEqual(cargoPackageInfo(CARGO_PLAIN), { version: '0.1.0', reproducible: false });
  assert.deepEqual(reproducibleBuildProblems({ cargo: { reproducible: true }, docker: { ok: true, installed: true } }), []);
  const both = reproducibleBuildProblems({ cargo: { reproducible: false }, docker: DOWN }).join('\n');
  assert.match(both, /contract\/Cargo\.toml has no \[package\.metadata\.near\.reproducible_build\] section/);
  assert.match(both, /Docker's engine is not running \(docker version: failed to connect to the docker API.*\): start Docker Desktop, then build again/);
  assert.deepEqual(reproducibleBuildProblems({ cargo: { reproducible: true }, docker: { ok: false, installed: false, detail: 'no docker command' } }), [
    'Docker is not installed (no docker command): install Docker Desktop, start it, then build again',
  ]);
  assert.deepEqual(LOCK_METHODS, [...MONEY_METHODS, 'panic_close', 'hl_withdraw', 'hl_send_to_intents', 'evm_usdc_to_intents']);
});

test('plan without --lock: a canary\'s deploy prints no tx 3; the final deploy prints tx 3 (the DeleteKey) as its own later run with --confirm-lock', async () => {
  const canary = lockWorld({ account: null, wasm: PLAIN_WASM });
  const c = await canary.run(OK);
  assert.equal(c.error, null, c.error?.message);
  assert.match(c.out, /^tx 1: create the account$/m);
  assert.match(c.out, /^tx 2: deploy and initialise$/m);
  assert.match(c.out, /^tx 3: none: a canary is never locked \(it gets retired\)$/m);
  assert.doesNotMatch(c.out, /DeleteKey|--lock/);
  assert.match(c.out, /build {5}non-reproducible \(build_info null\): fine for a canary; the final deploy, which gets locked, is built with `cd contract && cargo near build reproducible-wasm`/);
  assert.deepEqual(canary.st.sent, []);

  const final = lockWorld({ account: null });
  const f = await final.run([CONTRACT, ...OK.slice(1)]);
  assert.equal(f.error, null, f.error?.message);
  assert.match(f.out, /^tx 3, its own run \(--lock\), after you checked the deployed contract: lock the account$/m);
  assert.match(f.out, /action 1 {2}DeleteKey ed25519:<the key in .*gimbal\.near\.json>: the access key is removed from gimbal\.near/);
  assert.match(f.out, /node tools\/mainnet\/deploy\.mjs gimbal\.near --lock --treasury-near treasury\.near --hl-builder 0x0{38}ab, then the same with --send --confirm-lock gimbal\.near/);
  assert.match(f.out, /--send never sends tx 3/);
  assert.deepEqual(final.st.sent, []);
});

test('plan with --lock: only the DeleteKey of the key file\'s key, after every check passed; nothing sent', async () => {
  const w = lockWorld();
  const r = await w.run(LOCK);
  assert.equal(r.error, null, r.error?.message);
  assert.doesNotMatch(r.out, /^tx [12]/m);
  assert.match(r.out, new RegExp(`checkout  commit ${REV}, clean, on a remote branch \\(after git fetch --prune\\)`));
  assert.deepEqual(w.st.gitCalls, [{}], 'one checkout read, with the fetch');
  assert.match(r.out, /exports {3}all of ft_on_transfer, fund_venue, withdraw_to_owner, clear_payout_lock, panic_close, hl_withdraw, hl_send_to_intents, evm_usdc_to_intents/);
  assert.match(r.out, new RegExp(`build {5}reproducible: cargo near build reproducible-wasm, image ${IMAGE.replace(/[.+]/g, '\\$&')}, source ${SNAPSHOT.replace(/[.?+/]/g, '\\$&')}`));
  assert.match(r.out, new RegExp(`code {6}the code on chain is the built wasm: code_hash ${hashOf(REPRO_WASM)}`));
  assert.match(r.out, /balance {3}1\.0000 NEAR free above storage: after the lock no key can move it; only the contract's own methods spend it \(refresh_prices' oracle deposit, refunds\)/);
  assert.match(r.out, /config {3}matches/);
  assert.match(r.out, /treasury  treasury\.near is registered on USDC on NEAR/);
  assert.match(r.out, new RegExp(`keys {6}1 access key on chain:\\n {10}${OWN_KEY} FullAccess \\(the key file\\)`));
  assert.match(r.out, /^tx 3: lock the account\n {2}signer {4}gimbal\.near {2}\(the key itself, .*gimbal\.near\.json\)\n {2}receiver {2}gimbal\.near$/m);
  assert.match(r.out, new RegExp(`action 1 {2}DeleteKey ${OWN_KEY}: the access key is removed from gimbal\\.near`));
  assert.match(r.out, /view_access_key_list of gimbal\.near is empty: no key can deploy code to it, sign for it, retire it or move its NEAR;\n {12}only the contract's own methods spend that NEAR/);
  assert.match(r.out, /gas {7}at most 0\.1 TGas \(action fees only\)/);
  assert.match(r.out, /dry run: nothing was signed or sent/);
  assert.doesNotMatch(r.out, /private_key|secret|nobody/);
  assert.equal(w.st.dockerAsked, 0, 'a reproducible wasm needs no Docker check');
  assert.equal(w.st.rebuilds, 0, 'nothing is built without --non-reproducible');
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
    const r = await w.run(LOCK_SEND);
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
  const r = await w.run(LOCK_SEND);
  assert.match(r.error.message, new RegExp(`code_hash E8Zp9eM2Jh2DRx31Ez9M9bKMRaXbDkJcZ3sVkjnTBgcs on chain is not ${hashOf(REPRO_WASM)}, the base58 sha256 of contract/target/near/gimbal\\.wasm`));
  assert.deepEqual(w.st.sent, []);
  const none = await lockWorld({ codeHash: NO_CODE }).run(LOCK);
  assert.match(none.error.message, /has no code: deploy it first/);
});

test('refused: a wasm without every method a locked contract needs (money, panic_close, the venue returns)', async () => {
  const w = lockWorld({ wasm: wasmWith(META(BUILD_INFO), MONEY_METHODS) });
  const r = await w.run(LOCK_SEND);
  assert.match(r.error.message, /the wasm does not export panic_close, hl_withdraw, hl_send_to_intents, evm_usdc_to_intents: a locked contract can never get them/);
  assert.deepEqual(w.st.sent, []);
  const one = await lockWorld({ wasm: wasmWith(META(BUILD_INFO), LOCK_METHODS.filter((m) => m !== 'withdraw_to_owner')) }).run(LOCK);
  assert.match(one.error.message, /the wasm does not export withdraw_to_owner: a locked contract can never get it/);
});

test('refused: config() is not what new() was given (every differing field named)', async () => {
  const bad = { ...CONFIG, fees: { performance_bps: 2000, hl_builder_tenth_bps: 10 }, treasury: { ...CONFIG.treasury, near: 'someone.near' } };
  const w = lockWorld({ config: bad });
  const r = await w.run(LOCK_SEND);
  assert.match(r.error.message, /config\.fees\.performance_bps: expected 1000, on chain 2000/);
  assert.match(r.error.message, /config\.treasury\.near: expected "treasury\.near", on chain "someone\.near"/);
  assert.deepEqual(w.st.sent, []);
  assert.deepEqual(lockConfigProblems({ ...CONFIG, treasury: { ...CONFIG.treasury, near: 'someone.near' } }, { codes: NO_CODES, brokerId: 'gimbal_dex' }), []);
  assert.deepEqual(configDiff({ a: 1, b: { c: 'x' } }, { a: 1, b: { c: 'x' } }), []);
  assert.deepEqual(configDiff({ a: 1 }, { a: 1, b: null }), ['config.b: expected null, on chain missing']);
});

test('refused: a treasury that does not exist or is not on USDC, and version() other than contract/Cargo.toml', async () => {
  const missing = await lockWorld({ treasuryMissing: true }).run(LOCK_SEND);
  assert.match(missing.error.message, /the treasury "treasury\.near" does not exist on mainnet/);
  const unregistered = await lockWorld({ treasuryUnregistered: true }).run(LOCK_SEND);
  assert.match(unregistered.error.message, /the treasury treasury\.near is not registered on USDC on NEAR: register it first/);
  const version = await lockWorld({ version: '0.2.0' }).run(LOCK_SEND);
  assert.match(version.error.message, /version\(\) is "0\.2\.0", contract\/Cargo\.toml says "0\.1\.0"/);
  const crate = await lockWorld({ cargo: CARGO.replace('version = "0.1.0"', 'version = "0.3.0"') }).run(LOCK_SEND);
  assert.match(crate.error.message, /the wasm says version 0\.1\.0, contract\/Cargo\.toml 0\.3\.0: build this checkout/);
});

test('refused: a dirty or unpushed checkout, and a reproducible wasm built from another commit', async () => {
  const w = lockWorld({ dirty: [' M contract/src/lib.rs'] });
  const r = await w.run(LOCK_SEND);
  assert.match(r.out, /checkout  commit a{40}, 1 uncommitted change, on a remote branch \(after git fetch --prune\)\n {10} M contract\/src\/lib\.rs/);
  assert.match(r.error.message, /the checkout has uncommitted changes: commit or stash them/);
  assert.deepEqual(w.st.sent, []);
  const unpushed = await lockWorld({ pushed: false }).run(LOCK_SEND);
  assert.match(unpushed.out, /NOT on a remote branch/);
  assert.match(unpushed.error.message, /commit a{40} is on no remote branch: push it\. The repo is public from the hackathon submission; the commit is named so anyone can rebuild it then/);
  const offline = await lockWorld({ pushed: false, fetchError: 'fatal: unable to access the remote' }).run(LOCK_SEND);
  assert.match(offline.error.message, /is on no remote branch \(git fetch --prune failed: fatal: unable to access the remote\): push it/);

  const other = 'c'.repeat(40);
  const moved = lockWorld({ head: other });
  const m = await moved.run(LOCK_SEND);
  assert.match(m.error.message, new RegExp(`the wasm was built from commit ${REV}, and this checkout is at ${other}: check out ${REV} \\(clean, pushed\\) and run --lock there`));
  assert.deepEqual(moved.st.sent, []);
});

test('refused: a non-reproducible wasm without --non-reproducible, with why reproducible-wasm cannot run here (Docker missing or down)', async () => {
  const w = lockWorld({ wasm: PLAIN_WASM, docker: DOWN, cargo: CARGO_PLAIN });
  const r = await w.run(LOCK_SEND);
  assert.match(r.error.message, /the wasm was not built with `cd contract && cargo near build reproducible-wasm`/);
  assert.match(r.error.message, /Docker's engine is not running \(docker version: failed to connect.*\): start Docker Desktop, then build again/);
  assert.match(r.error.message, /no \[package\.metadata\.near\.reproducible_build\] section/);
  assert.match(r.error.message, /--non-reproducible instead rebuilds the wasm from the clean checkout and locks only when that build is the deployed code/);
  assert.match(r.out, /build {5}non-reproducible \(build_info null in the wasm's NEP-330 metadata\)$/m);
  assert.equal(w.st.rebuilds, 0);
  assert.deepEqual(w.st.sent, []);
  const missing = await lockWorld({ wasm: PLAIN_WASM, docker: { ok: false, installed: false, detail: 'no docker command' } }).run(LOCK_SEND);
  assert.match(missing.error.message, /Docker is not installed \(no docker command\): install Docker Desktop, start it, then build again/);
  const ready = await lockWorld({ wasm: PLAIN_WASM }).run(LOCK_SEND);
  assert.match(ready.error.message, /Docker and contract\/Cargo\.toml are ready for it/);
});

test('--non-reproducible: the wasm is rebuilt from the clean checkout and must be the deployed code; the evidence says only that', async () => {
  // A stale wasm on disk; the rebuild writes the deployed code.
  const forced = lockWorld({ wasm: STALE_WASM, rebuilt: PLAIN_WASM, docker: DOWN, cargo: CARGO_PLAIN });
  const f = await forced.run([...LOCK_SEND, '--non-reproducible']);
  assert.equal(f.error, null, f.error?.message);
  assert.equal(forced.st.rebuilds, 1);
  assert.deepEqual(forced.st.gitCalls, [{}, { fetch: false }], 'the checkout is read again after the rebuild');
  assert.equal(forced.st.dockerAsked, 0, '--non-reproducible asks Docker nothing');
  assert.equal(forced.st.sent.length, 1);
  assert.match(f.out, new RegExp(`rebuild {3}--non-reproducible: \`cd contract && cargo near build non-reproducible-wasm --no-abi\` from commit ${REV}`));
  assert.match(f.out, new RegExp(`rebuild {3}done: cargo-near 0\\.22\\.0, ${RUSTC.replace(/[.()]/g, '\\$&')}; the checkout is still clean at ${REV}`));
  assert.match(f.out, new RegExp(`code {6}the code on chain is the built wasm: code_hash ${hashOf(PLAIN_WASM)}`));
  assert.ok(f.result.includes(`build:     non-reproducible (build_info null): rebuilt during the lock run with \`cd contract && cargo near build non-reproducible-wasm --no-abi\` `
    + `from the clean commit ${REV} (cargo-near 0.22.0, ${RUSTC}); its sha256 equals the deployed code. Another machine may not get the same bytes`), f.result.join('\n'));
  assert.ok(f.result.includes(`Contract has no access keys: DeleteKey tx LockTx111 (https://nearblocks.io/txns/LockTx111), code_hash ${hashOf(PLAIN_WASM)}. `
    + `Its code is a non-reproducible build of commit ${REV} (cargo-near 0.22.0, ${RUSTC}): rebuilt from that clean commit when it was locked, `
    + `its sha256 ${shaOf(PLAIN_WASM)} equals the deployed code; another machine may not rebuild the same bytes.`), f.result.join('\n'));

  // The rebuild is not the deployed code: refused.
  const other = wasmWith(META(null), [...LOCK_METHODS, 'extra']);
  const mismatch = lockWorld({ wasm: STALE_WASM, rebuilt: other, codeHash: hashOf(PLAIN_WASM) });
  const m = await mismatch.run([...LOCK_SEND, '--non-reproducible']);
  assert.match(m.error.message, new RegExp(`code_hash ${hashOf(PLAIN_WASM)} on chain is not ${hashOf(other)}, the wasm rebuilt from commit ${REV}: the deployed code is not this commit's build`));
  assert.deepEqual(mismatch.st.sent, []);

  // Without a rebuild, the stale wasm is never what gets checked.
  const failed = lockWorld({ wasm: STALE_WASM, rebuildFails: 'error: could not compile `gimbal`' });
  const fr = await failed.run([...LOCK_SEND, '--non-reproducible']);
  assert.match(fr.error.message, /the rebuild failed \(error: could not compile `gimbal`\): nothing was checked or sent/);
  assert.deepEqual(failed.st.sent, []);
  const dirty = lockWorld({ wasm: PLAIN_WASM, dirty: [' M contract/src/lib.rs'] });
  const d = await dirty.run([...LOCK, '--non-reproducible']);
  assert.equal(dirty.st.rebuilds, 0);
  assert.match(d.error.message, /--non-reproducible rebuilds the wasm from a clean checkout, and this one is not: the wasm on disk was not rebuilt/);
  const writes = lockWorld({ wasm: STALE_WASM, rebuilt: PLAIN_WASM, gitAfter: { head: REV, clean: false, changed: [' M contract/Cargo.lock'], pushed: true, fetchError: null } });
  const wr = await writes.run([...LOCK_SEND, '--non-reproducible']);
  assert.match(wr.error.message, /the rebuild changed the checkout \(commit a{40}, 1 uncommitted change:  M contract\/Cargo\.lock\): commit what the build writes/);
  assert.deepEqual(writes.st.sent, []);
});

test('--lock --send: one DeleteKey signed by that key, the key list read empty after, the evidence block and the key file called useless', async () => {
  const w = lockWorld();
  const r = await w.run(LOCK_SEND);
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
    `checkout:  commit ${REV}, clean, on a remote branch after git fetch --prune`,
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
  const still = await lockWorld({ keysAfter: [fullAccess(OWN_KEY)] }).run(LOCK_SEND);
  assert.match(still.error.message, /still has access keys after LockTx111/);
  const failed = await lockWorld({ failure: { ActionError: { kind: 'DeleteKeyDoesNotExist' } } }).run(LOCK_SEND);
  assert.match(failed.error.message, /DeleteKey LockTx111: .*; read the key list \(rerun the --lock dry run\) before anything else/);
  assert.doesNotMatch(failed.error.message, /still on the account/);
});

test('a rerun that finds no keys (a lock whose outcome was not seen): the evidence block without the hash, and the hash from nearblocks', async () => {
  const w = lockWorld({ keys: [] });
  const r = await w.run(LOCK_SEND);
  assert.equal(r.error, null, r.error?.message);
  assert.deepEqual(w.st.sent, []);
  assert.match(r.out, /nothing to send: gimbal\.near has no access keys, it is locked already/);
  assert.ok(r.result.includes('DeleteKey: not seen by this run (the account had no keys when it was read): take its hash from https://nearblocks.io/address/gimbal.near'));
  assert.ok(r.result.at(-2).startsWith('Contract has no access keys: DeleteKey tx <the DeleteKey\'s hash from https://nearblocks.io/address/gimbal.near>, code_hash '));
  assert.match(r.out, /hash {6}take the DeleteKey's transaction hash from https:\/\/nearblocks\.io\/address\/gimbal\.near/);
  const wrong = await lockWorld({ keys: [], codeHash: 'E8Zp9eM2Jh2DRx31Ez9M9bKMRaXbDkJcZ3sVkjnTBgcs' }).run(LOCK);
  assert.match(wrong.error.message, /no evidence block, because:\n {2}code_hash E8Zp/);
});
