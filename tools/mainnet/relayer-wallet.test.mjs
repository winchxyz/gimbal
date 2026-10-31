import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envValues, parseDotEnv, parseFlags, shownEnv } from './cli.mjs';
import { ENTRY, ethText, evmAddressOf, newEvmKey, setEnvEntry } from './relayer-wallet.mjs';

const SCRIPT = fileURLToPath(new URL('./relayer-wallet.mjs', import.meta.url));
const KEY = `0x${'1'.repeat(64)}`;

test('the address of a secp256k1 key (the web3 documentation\'s example key)', () => {
  assert.equal(evmAddressOf('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'), '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23');
  assert.throws(() => evmAddressOf('0x1234'), /not 0x and 64 hex digits/);
  assert.throws(() => evmAddressOf(`0x${'0'.repeat(64)}`), /not a valid secp256k1 key/);
  const k = newEvmKey();
  assert.match(k.privateKey, /^0x[0-9a-f]{64}$/);
  assert.equal(evmAddressOf(k.privateKey), k.address);
  assert.notEqual(newEvmKey().privateKey, k.privateKey);
});

test('the .env entry is written only when it is empty or missing, never over a value', () => {
  const example = 'ARBITRUM_RPC_URL=\nRELAYER_EVM_PRIVATE_KEY=           # gas-only Arbitrum wallet\nHL_REFERRAL_CODE=\n';
  const filled = setEnvEntry(example, ENTRY, KEY);
  assert.equal(filled.written, true);
  assert.equal(filled.text, `ARBITRUM_RPC_URL=\nRELAYER_EVM_PRIVATE_KEY=${KEY}  # gas-only Arbitrum wallet\nHL_REFERRAL_CODE=\n`);
  assert.equal(parseDotEnv(filled.text).get(ENTRY), KEY, 'Node reads the value without its comment');
  assert.deepEqual(setEnvEntry(filled.text, ENTRY, `0x${'2'.repeat(64)}`), { text: filled.text, written: false });
  assert.equal(setEnvEntry('A=1\n', ENTRY, KEY).text, `A=1\n${ENTRY}=${KEY}\n`);
  assert.equal(setEnvEntry('', ENTRY, KEY).text, `${ENTRY}=${KEY}\n`);
  assert.equal(setEnvEntry(`A=1\r\n${ENTRY}=\r\n`, ENTRY, KEY).text, `A=1\r\n${ENTRY}=${KEY}\r\n`, 'CRLF kept');
  assert.throws(() => setEnvEntry(`${ENTRY}=\n${ENTRY}=\n`, ENTRY, KEY), /2 times/);
});

test('.env reading: comments, quotes, export; the environment wins; values are shown by name only', () => {
  const m = parseDotEnv('# c\nexport A="x y" # z\nB=plain   # comment\nC=\nD=#only a comment\nE=\'q\'\n');
  assert.deepEqual([...m], [['A', 'x y'], ['B', 'plain'], ['C', ''], ['D', ''], ['E', 'q']]);
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'ORDERLY_BROKER_ID=from_file\nHL_REFERRAL_CODE=\n');
  const v = envValues(['ORDERLY_BROKER_ID', 'HL_REFERRAL_CODE', 'PHOENIX_REFERRAL_CODE'], { file, env: { PHOENIX_REFERRAL_CODE: 'ENV', ORDERLY_BROKER_ID: '' } });
  assert.deepEqual(v.get('ORDERLY_BROKER_ID'), { value: 'from_file', from: '.env' });
  assert.deepEqual(v.get('HL_REFERRAL_CODE'), { value: null, from: null });
  assert.deepEqual(v.get('PHOENIX_REFERRAL_CODE'), { value: 'ENV', from: 'the environment' });
  assert.equal(shownEnv('ORDERLY_BROKER_ID', v.get('ORDERLY_BROKER_ID')), '<ORDERLY_BROKER_ID from .env, 9 characters>');
  assert.equal(shownEnv('HL_REFERRAL_CODE', v.get('HL_REFERRAL_CODE')), null);
  assert.throws(() => parseFlags(['--x'], {}), /unknown option --x/);
});

test('the script: writes a key into an empty entry once, prints the address and never the key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-relayer-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'GIMBAL_MODE=replay\nRELAYER_EVM_PRIVATE_KEY=\n');
  const first = spawnSync(process.execPath, [SCRIPT, '--env-file', file], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const key = parseDotEnv(readFileSync(file, 'utf8')).get(ENTRY);
  assert.match(key, /^0x[0-9a-f]{64}$/);
  assert.equal(first.stdout.includes(key.slice(2)), false, 'the key is not printed');
  assert.match(first.stdout, new RegExp(`relayer wallet ${evmAddressOf(key)}`));
  const second = spawnSync(process.execPath, [SCRIPT, '--env-file', file], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /set already: not touched/);
  assert.equal(parseDotEnv(readFileSync(file, 'utf8')).get(ENTRY), key, 'never overwritten');
  const empty = join(dir, 'empty.env');
  writeFileSync(empty, '');
  const check = spawnSync(process.execPath, [SCRIPT, '--check', '--env-file', empty], { encoding: 'utf8' });
  assert.equal(check.status, 1);
  assert.match(check.stderr, /has no RELAYER_EVM_PRIVATE_KEY: run without --check first/);
  assert.equal(ethText('1234567890000000000'), '1.234567');
});
