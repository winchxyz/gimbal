import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UsageError } from './cli.mjs';
import {
  MONEY_METHODS, NEAR_USDC, canonical, checkFunder, deployPlanFor, initArgs, initialBalance, minInitialBalance, nextFreeName, parseDeployArgs, referralCodes,
  treasuryUsdcLine, wasmExports,
} from './deploy.mjs';
import { NO_CODE } from './near.mjs';

const NEAR = 10n ** 24n;
const OK = ['gimbal-canary.near', '--funder', 'funder.near', '--treasury-near', 'treasury.near', '--hl-builder', '0x00000000000000000000000000000000000000AB'];
const usage = (argv, pattern) => assert.throws(() => parseDeployArgs(argv), (e) => e instanceof UsageError && pattern.test(e.message), argv.join(' '));

test('deploy arguments: a dry run needs no key file; the builder is lowercased', () => {
  const a = parseDeployArgs(OK);
  assert.deepEqual(a, {
    contract: 'gimbal-canary.near', funder: 'funder.near', keyFile: null, treasuryNear: 'treasury.near',
    hlBuilder: '0x00000000000000000000000000000000000000ab', balance: null, send: false, resume: false,
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
  for (const argv of [['gimbal.testnet', ...OK.slice(1)], [...OK, '--send']]) {
    const r = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', env: { ...process.env, NEAR_RPC_URL: 'http://127.0.0.1:9' } });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /usage: node tools\/mainnet\/deploy\.mjs/);
  }
});
