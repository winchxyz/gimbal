#!/usr/bin/env node
// The relayer's Arbitrum gas wallet (interfaces §1.3, Orderly money path): it submits the EIP-3009 transfers the
// contract signed and pays their gas, so it holds a few dollars of ETH and never desk money.
//
//   node tools/mainnet/relayer-wallet.mjs            dry run: the wallet's address when .env has its key, or what
//                                                    --write would do; writes nothing
//   node tools/mainnet/relayer-wallet.mjs --write    a new key into .env RELAYER_EVM_PRIVATE_KEY, only when that
//                                                    entry is empty (never overwritten); prints the address only
//   node tools/mainnet/relayer-wallet.mjs --check    the wallet's ETH balance on Arbitrum One (chain 42161)
//
// --env-file <file> uses another file than the repo's .env. --write refuses a file inside a linked git worktree
// (its ignored files go with it): run it from the main checkout. ARBITRUM_RPC_URL (environment or .env) is the RPC
// for --check, default the public https://arb1.arbitrum.io/rpc; it must answer chain id 42161. No key or .env
// value is printed.

import { createECDH } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256 } from '../testnet/near.mjs';
import { DOT_ENV, UsageError, envValues, isMain, parseDotEnv, parseFlags, run } from './cli.mjs';
import { assertNotInLinkedWorktree, linkedWorktreeOf } from './near.mjs';

export const ENTRY = 'RELAYER_EVM_PRIVATE_KEY';
export const ARBITRUM_ONE = 42161;
export const PUBLIC_ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const USAGE = 'usage: node tools/mainnet/relayer-wallet.mjs [--write | --check] [--env-file <file>]';

/** The lowercase address of a `0x` + 64 hex secp256k1 private key. */
export function evmAddressOf(privateKeyHex) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKeyHex)) throw new Error(`${ENTRY} is not 0x and 64 hex digits`);
  const d = BigInt(privateKeyHex);
  if (d === 0n || d >= N) throw new Error(`${ENTRY} is not a valid secp256k1 key`);
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(privateKeyHex.slice(2), 'hex'));
  return '0x' + keccak256(ecdh.getPublicKey().subarray(1)).subarray(12).toString('hex');
}

/** A new random key: { privateKey: '0x' + 64 hex, address }. */
export function newEvmKey() {
  const ecdh = createECDH('secp256k1');
  ecdh.generateKeys();
  const privateKey = '0x' + ecdh.getPrivateKey().toString('hex').padStart(64, '0');
  return { privateKey, address: evmAddressOf(privateKey) };
}

/**
 * `text` (a .env file) with `name` set to `value`, only when its entry is missing or empty: an empty entry gets the
 * value in place (its inline comment kept), a missing one is appended. Returns { text, written } and leaves a set
 * entry alone (written false). Two entries for the name are refused: which one Node reads is easy to get wrong.
 */
export function setEnvEntry(text, name, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const at = lines.map((l, i) => (pattern.test(l) ? i : -1)).filter((i) => i >= 0);
  if (at.length > 1) throw new Error(`${name} is in the file ${at.length} times: keep one entry`);
  if (at.length === 1) {
    const current = parseDotEnv(lines[at[0]]).get(name) ?? '';
    if (current !== '') return { text, written: false };
    const comment = /\s#.*$/.exec(lines[at[0]].replace(/^[^=]*=/, ' '))?.[0] ?? '';
    lines[at[0]] = `${name}=${value}${comment === '' ? '' : `  ${comment.trim()}`}`;
    return { text: lines.join(eol), written: true };
  }
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  lines.push(`${name}=${value}`, '');
  return { text: lines.join(eol), written: true };
}

async function arbitrum(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null);
  if (json === null || json.error || json.result === undefined) throw new Error(`Arbitrum RPC ${method}: HTTP ${res.status}${json?.error ? `, ${JSON.stringify(json.error).slice(0, 200)}` : ''}`);
  return json.result;
}

/** Wei as ETH, 18 decimals cut to 6. */
export function ethText(wei) {
  const v = BigInt(wei);
  return `${v / 10n ** 18n}.${(v % 10n ** 18n).toString().padStart(18, '0').slice(0, 6)}`;
}

async function main() {
  const { positional, values } = parseFlags(process.argv.slice(2), { '--check': 'switch', '--write': 'switch', '--env-file': 'value' });
  if (positional.length > 0) throw new UsageError(`unexpected argument ${positional[0]}`);
  if (values['--check'] && values['--write']) throw new UsageError('--write and --check are separate steps: run one, then the other');
  const file = resolve(values['--env-file'] ?? DOT_ENV);
  const shown = file;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const current = parseDotEnv(text).get(ENTRY) ?? '';

  if (!values['--check']) {
    if (current !== '') {
      console.log(`${shown} ${ENTRY} is set already: not touched`);
      console.log(`relayer wallet ${evmAddressOf(current)}`);
      return;
    }
    if (!values['--write']) {
      // The default is a dry run, like every script here: nothing is generated or written.
      console.log(`dry run: ${shown} has no ${ENTRY}; --write would generate a new key into it (the value is never shown)`);
      console.log('and print the wallet\'s address. Nothing was written.');
      const tree = linkedWorktreeOf(file);
      if (tree !== null) console.log(`warning   ${tree} is a linked git worktree: --write refuses here; run it from the main checkout`);
      return;
    }
    assertNotInLinkedWorktree(file, `${ENTRY} (in ${file})`);
    const key = newEvmKey();
    const next = setEnvEntry(text, ENTRY, key.privateKey);
    if (!next.written) throw new Error(`${ENTRY} could not be written`);
    writeFileSync(file, next.text, existsSync(file) ? {} : { mode: 0o600 });
    console.log(`${shown} ${ENTRY}: written (a new key; the value is not shown)`);
    console.log(`relayer wallet ${key.address}`);
    console.log(`  https://arbiscan.io/address/${key.address}`);
    console.log('fund it with a few dollars of ETH on Arbitrum One; check with --check');
    return;
  }

  if (current === '') throw new Error(`${shown} has no ${ENTRY}: run with --write first`);
  const address = evmAddressOf(current);
  const rpc = envValues(['ARBITRUM_RPC_URL'], { file }).get('ARBITRUM_RPC_URL');
  const url = rpc.value ?? PUBLIC_ARBITRUM_RPC;
  const chain = Number(await arbitrum(url, 'eth_chainId', []));
  if (chain !== ARBITRUM_ONE) throw new Error(`the Arbitrum RPC (${rpc.value === null ? new URL(url).host : `ARBITRUM_RPC_URL from ${rpc.from}`}) is chain ${chain}, not Arbitrum One ${ARBITRUM_ONE}`);
  const wei = await arbitrum(url, 'eth_getBalance', [address, 'latest']);
  console.log(`relayer wallet ${address}`);
  console.log(`  Arbitrum One (chain ${chain}, RPC ${rpc.value === null ? new URL(url).host : `ARBITRUM_RPC_URL from ${rpc.from}`}): ${ethText(wei)} ETH`);
  console.log(`  https://arbiscan.io/address/${address}`);
}

if (isMain(import.meta.url)) await run(main, USAGE);
