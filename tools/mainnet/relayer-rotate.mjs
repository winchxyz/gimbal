#!/usr/bin/env node
// Rotates the relayer's Arbitrum gas wallet (relayer-wallet.mjs): a new key in .env, and the old wallet's ETH moved
// to it on Arbitrum One. Both wallets are the owner's gas wallets; the ETH stays the owner's, less one transfer's gas.
//
//   node tools/mainnet/relayer-rotate.mjs           dry run: generates nothing, writes nothing, signs nothing. Prints
//                                                   the old relayer's address, its Arbitrum ETH, USDC and USDC.e, what
//                                                   --send would do, and how much ETH would leave, to where
//   node tools/mainnet/relayer-rotate.mjs --send    generates a new key; backs up .env (.env.bak-<time>, mode 0600)
//                                                   and writes it atomically with RELAYER_EVM_PRIVATE_KEY = the new
//                                                   key and RELAYER_EVM_PRIVATE_KEY_OLD = the old one; then sends all
//                                                   the old wallet's ETH minus gas to the new address on Arbitrum One
//
// The new key is written, read back and checked before any ETH moves: the transfer goes to the address of the key
// in the file. A rerun after a --send (RELAYER_EVM_PRIVATE_KEY_OLD set) generates no key and writes nothing: it moves
// what is left on the old wallet to the current one, or says the rotation is done.
//
// Refusals: USDC or USDC.e on the old wallet (the script moves ETH only; move the USDC first), a transaction of the
// old wallet still pending, RELAYER_EVM_PRIVATE_KEY set in the shell environment (it wins over .env, so other scripts
// would keep the old key), --send with a .env inside a linked git worktree. --env-file <file> uses another file than
// the repo's .env. ARBITRUM_RPC_URL (environment or .env) replaces the public RPC; it must answer chain 42161 and is
// printed as its host. No key or .env value is printed.
//
// After --send: update RELAYER_EVM_PRIVATE_KEY on Railway to the new value in .env and redeploy. Until then serve's
// relayer signs with the old wallet, which has no gas left: its Arbitrum submits fail and nothing is paid.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { arbitrumBalances, arbitrumGasPrice, rpcUrls, unitsText } from './balances.mjs';
import { DOT_ENV, UsageError, envValues, isMain, parseDotEnv, parseFlags, run } from './cli.mjs';
import { summaryBlock } from './money.mjs';
import { assertNotInLinkedWorktree, linkedWorktreeOf } from './near.mjs';
import { ARBITRUM_ONE, ENTRY, ethText, evmAddressOf, newEvmKey } from './relayer-wallet.mjs';

export const OLD_ENTRY = `${ENTRY}_OLD`;
const USAGE = 'usage: node tools/mainnet/relayer-rotate.mjs [--send] [--env-file <file>]';

/** Gas limit = the estimate x 3/2: Arbitrum's estimate holds an L1 data part that moves with the L1 price. */
export const GAS_MARGIN = [3n, 2n];
/** Max fee per gas = the gas price x 2 (Arbitrum charges its base fee and ignores tips; the rest stays). */
export const FEE_MARGIN = 2n;
const RECEIPT_TIMEOUT_MS = 180_000;

/**
 * `text` (a .env) with the relayer key rotated: RELAYER_EVM_PRIVATE_KEY = `newKey` in place (its inline comment
 * kept) and the old line kept right under it, renamed RELAYER_EVM_PRIVATE_KEY_OLD. Refuses a file with no key, two
 * entries for a name, or a RELAYER_EVM_PRIVATE_KEY_OLD that holds a value (the key of an earlier rotation's wallet).
 */
export function rotateEnvText(text, newKey) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const find = (name) => {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    const at = lines.map((l, i) => (pattern.test(l) ? i : -1)).filter((i) => i >= 0);
    if (at.length > 1) throw new Error(`${name} is in the file ${at.length} times: keep one entry`);
    return at[0] ?? -1;
  };
  const at = find(ENTRY);
  if (at < 0 || (parseDotEnv(lines[at]).get(ENTRY) ?? '') === '') throw new Error(`the file has no ${ENTRY}: there is no relayer key to rotate`);
  const oldAt = find(OLD_ENTRY);
  if (oldAt >= 0 && (parseDotEnv(lines[oldAt]).get(OLD_ENTRY) ?? '') !== '') {
    throw new Error(`${OLD_ENTRY} holds an earlier rotation's key: once its wallet is empty, take that line out of the file, then rotate again`);
  }
  const old = lines[at];
  const comment = /\s#.*$/.exec(old.replace(/^[^=]*=/, ' '))?.[0] ?? '';
  const renamed = old.replace(new RegExp(`^(\\s*(?:export\\s+)?)${ENTRY}(\\s*=)`), `$1${OLD_ENTRY}$2`);
  const out = [...lines];
  out[at] = `${ENTRY}=${newKey}${comment === '' ? '' : `  ${comment.trim()}`}`;
  out.splice(at + 1, 0, renamed);
  if (oldAt >= 0) out.splice(oldAt > at ? oldAt + 1 : oldAt, 1);
  return out.join(eol);
}

/**
 * Writes `text` to `path` atomically: a new temporary file next to it (mode 0600; for .env it is .env.tmp-<...>,
 * which .gitignore's `.env.*` covers), fsync, then a rename over it.
 */
export function writeAtomic(path, text) {
  const tmp = join(dirname(path), `${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** A copy of `path` as `<path>.bak-<time>` (mode 0600, never over another file); returns its path. */
export function backUp(path, text, now) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const bak = `${path}.bak-${stamp}`;
  const fd = openSync(bak, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return bak;
}

async function rpc(fetchImpl, url, method, params) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json === null || json.error || json.result === undefined) {
    throw new Error(`chain ${ARBITRUM_ONE} ${method}: HTTP ${res.status}${json?.error ? `, ${JSON.stringify(json.error).slice(0, 200)}` : ''}`);
  }
  return json.result;
}

/** Gas in ETH with every digit (a transfer's gas on Arbitrum is well under 0.000001 ETH). */
const feeText = (wei) => unitsText(wei, 18);

const quantity = (v, what) => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`${what}: unexpected answer ${JSON.stringify(v)}`);
  return BigInt(v);
};

/** The transfer's gas: { gas, maxFeePerGas, feeCap } (feeCap = gas x maxFeePerGas, the most it can cost). */
async function transferGas(fetchImpl, url, from, to) {
  const price = await arbitrumGasPrice(fetchImpl, url);
  const estimate = quantity(await rpc(fetchImpl, url, 'eth_estimateGas', [{ from, to, value: '0x1' }]), 'eth_estimateGas');
  const gas = (estimate * GAS_MARGIN[0] + GAS_MARGIN[1] - 1n) / GAS_MARGIN[1];
  const maxFeePerGas = price * FEE_MARGIN;
  return { gas, maxFeePerGas, feeCap: gas * maxFeePerGas };
}

/** The old wallet's nonce, refused while one of its transactions is pending (serve's relayer may be submitting). */
async function settledNonce(fetchImpl, url, address) {
  const latest = quantity(await rpc(fetchImpl, url, 'eth_getTransactionCount', [address, 'latest']), 'eth_getTransactionCount');
  const pending = quantity(await rpc(fetchImpl, url, 'eth_getTransactionCount', [address, 'pending']), 'eth_getTransactionCount');
  if (pending !== latest) throw new Error(`${address} has ${pending - latest} transaction(s) pending on Arbitrum One (serve's relayer?): wait until they are mined, then rerun`);
  return latest;
}

const usdcRefusal = (address, b) => `the old relayer ${address} holds ${unitsText(b.usdcE6, 6)} USDC and ${unitsText(b.usdceE6, 6)} USDC.e on Arbitrum One, `
  + 'and this script moves ETH only. Move them first: import the old key (RELAYER_EVM_PRIVATE_KEY in .env) into a wallet by hand and send the USDC '
  + 'to an Arbitrum address of the owner (a desk\'s Arbitrum USDC goes back with hl-return.mjs bridge from the desk\'s own address, not from here); '
  + `check https://arbiscan.io/address/${address} shows none, then rerun`;

/**
 * The rotation. deps: env (the shell environment, default process.env), fetch, say, now, newKey() ({ privateKey,
 * address }), accounts() (viem/accounts, for privateKeyToAccount), sleep, pollMs, tree (a linked worktree or null).
 * Returns the summary block's lines.
 */
export async function runRotate(argv, deps = {}) {
  const { positional, values } = parseFlags(argv, { '--send': 'switch', '--env-file': 'value' });
  if (positional.length > 0) throw new UsageError(`unexpected argument ${positional[0]}`);
  const send = values['--send'];
  const file = resolve(values['--env-file'] ?? DOT_ENV);
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? ((...x) => globalThis.fetch(...x));
  const say = deps.say ?? ((s = '') => console.log(s));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 3_000;
  const summary = [];
  const both = (line) => {
    say(line);
    summary.push(line);
  };

  say(`gimbal relayer-rotate: ${send ? 'SEND' : 'dry run'}`);
  say(`env file  ${file}`);
  const tree = deps.tree === undefined ? linkedWorktreeOf(file) : deps.tree;
  if (send) assertNotInLinkedWorktree(file, `${ENTRY} (in ${file})`);
  else if (tree !== null) say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);
  const shellKey = env[ENTRY]?.trim() ?? '';
  if (shellKey !== '') {
    const why = `${ENTRY} is set in the shell environment, and it wins over .env: the scripts would go on with that key after the rotation. Unset it, then rerun`;
    if (send) throw new Error(why);
    say(`warning   ${why}`);
  }

  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const dot = parseDotEnv(text);
  const current = dot.get(ENTRY)?.trim() ?? '';
  const earlier = dot.get(OLD_ENTRY)?.trim() ?? '';
  if (current === '') throw new Error(`${file} has no ${ENTRY}: there is no relayer key to rotate (relayer-wallet.mjs --write makes the first one)`);
  const rpcEntry = envValues(['ARBITRUM_RPC_URL'], { file, env }).get('ARBITRUM_RPC_URL');
  const urls = rpcUrls({ ARBITRUM_RPC_URL: rpcEntry.value ?? '' });
  const url = urls.arbitrum;
  const rpcShown = rpcEntry.value === null ? urls.shown.arbitrum : `ARBITRUM_RPC_URL from ${rpcEntry.from}, ${urls.shown.arbitrum}`;

  // After a --send: RELAYER_EVM_PRIVATE_KEY_OLD is the old wallet, RELAYER_EVM_PRIVATE_KEY the new one. No new key.
  const finishing = earlier !== '';
  const oldKey = finishing ? earlier : current;
  const oldAddress = evmAddressOf(oldKey);
  const fixedTo = finishing ? evmAddressOf(current) : null;
  both(`old relayer ${oldAddress} (${finishing ? `${OLD_ENTRY}: an earlier --send wrote the new key` : ENTRY} in the env file)`);
  const b = await arbitrumBalances(fetchImpl, url, oldAddress);
  both(`  Arbitrum One (chain ${ARBITRUM_ONE}, RPC ${rpcShown}): ${ethText(b.wei)} ETH, ${unitsText(b.usdcE6, 6)} USDC, ${unitsText(b.usdceE6, 6)} USDC.e`);
  say(`  https://arbiscan.io/address/${oldAddress}`);
  if (fixedTo !== null) both(`new relayer ${fixedTo} (${ENTRY} in the env file)`);
  const usdc = b.usdcE6 > 0n || b.usdceE6 > 0n ? usdcRefusal(oldAddress, b) : null;

  // The gas of the transfer, estimated to an EOA (the new address, or the old one in a dry run: no key exists yet).
  const g = await transferGas(fetchImpl, url, oldAddress, fixedTo ?? oldAddress);
  const leaves = b.wei > g.feeCap ? b.wei - g.feeCap : 0n;
  const to = fixedTo ?? 'the new relayer address (generated by --send)';
  const moneyLine = leaves === 0n
    ? `money     nothing leaves: ${ethText(b.wei)} ETH does not cover the transfer's gas (at most ${feeText(g.feeCap)} ETH)`
    : `money     ${ethText(leaves)} ETH leaves the old relayer ${oldAddress} for ${to} on Arbitrum One; it stays the owner's (both are the owner's gas `
      + `wallets and the new key is in the env file and its backup). Gone for good: only the gas, at most ${feeText(g.feeCap)} ETH; what the gas does not use stays on the old wallet`;

  if (!send) {
    say('');
    if (finishing) {
      say(`--send would: generate no key and write nothing (the env file is rotated already), and send the old wallet's ETH minus gas to ${fixedTo}`);
    } else {
      say('--send would:');
      say('  1. generate a new relayer key (never printed)');
      say(`  2. back up the env file to ${basename(file)}.bak-<time> (mode 0600), then write it atomically: ${ENTRY} = the new key, ${OLD_ENTRY} = this one`);
      say('  3. read the file back, and send all the old wallet\'s ETH minus gas to the address of the key it holds, on Arbitrum One');
      say(`  4. print both addresses and the transaction; then update ${ENTRY} on Railway and redeploy`);
    }
    both(moneyLine);
    if (usdc !== null) both(`refusal   --send refuses: ${usdc}`);
    say('Nothing was generated, written or signed.');
    return summary;
  }

  if (usdc !== null) throw new Error(usdc);
  if (leaves === 0n) {
    if (finishing) {
      both(`done      the rotation is finished: the old relayer has ${ethText(b.wei)} ETH left, less than the gas to move it`);
      both(`next      to rotate again, take ${OLD_ENTRY} out of the env file first (its wallet is empty)`);
      return summary;
    }
    throw new Error(`the old relayer has ${ethText(b.wei)} ETH, less than the transfer's gas (at most ${feeText(g.feeCap)} ETH): nothing to move; fund it or rotate with relayer-wallet.mjs`);
  }
  const nonce = await settledNonce(fetchImpl, url, oldAddress);

  let newAddress = fixedTo;
  if (!finishing) {
    const key = (deps.newKey ?? newEvmKey)();
    const next = rotateEnvText(text, key.privateKey);
    const bak = backUp(file, text, now());
    say(`backup    ${bak} (the env file before the rotation, mode 0600)`);
    writeAtomic(file, next);
    // The transfer goes to the key the file holds, read back, never to one held in memory only.
    const back = parseDotEnv(readFileSync(file, 'utf8'));
    if (back.get(ENTRY) !== key.privateKey || back.get(OLD_ENTRY) !== oldKey) throw new Error(`${file} did not read back as written: nothing was sent; the backup is ${bak}`);
    newAddress = evmAddressOf(back.get(ENTRY));
    both(`written   ${file}: ${ENTRY} = the new key, ${OLD_ENTRY} = the old one (values not shown)`);
    both(`new relayer ${newAddress}`);
  }

  // The gas again, now to the real address, then the balance once more: the amount is what is there now.
  const gas = await transferGas(fetchImpl, url, oldAddress, newAddress);
  const wei = (await arbitrumBalances(fetchImpl, url, oldAddress)).wei;
  if (wei <= gas.feeCap) throw new Error(`the old relayer has ${ethText(wei)} ETH now, less than the gas: nothing was sent (the env file is rotated; rerun to retry)`);
  const value = wei - gas.feeCap;
  const { privateKeyToAccount } = await (deps.accounts ?? (() => import('viem/accounts')))();
  const account = privateKeyToAccount(oldKey);
  if (account.address.toLowerCase() !== oldAddress) throw new Error('the signer\'s address is not the old relayer\'s: nothing was sent');
  const raw = await account.signTransaction({
    type: 'eip1559', chainId: ARBITRUM_ONE, nonce: Number(nonce), to: newAddress, value, gas: gas.gas, maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas: 0n,
  });
  both(`send      ${ethText(value)} ETH from ${oldAddress} to ${newAddress} on Arbitrum One (gas at most ${feeText(gas.feeCap)} ETH)`);
  const hash = await rpc(fetchImpl, url, 'eth_sendRawTransaction', [raw]);
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`eth_sendRawTransaction: unexpected answer ${JSON.stringify(hash)}`);
  both(`tx        https://arbiscan.io/tx/${hash}`);

  let receipt = null;
  for (const start = now(); receipt === null && now() - start < RECEIPT_TIMEOUT_MS;) {
    receipt = await rpc(fetchImpl, url, 'eth_getTransactionReceipt', [hash]);
    if (receipt === null) await sleep(pollMs);
  }
  if (receipt === null) {
    both(`pending   not mined after ${RECEIPT_TIMEOUT_MS / 1000} s: check the link; a rerun moves what is left once it is mined`);
  } else if (receipt.status !== '0x1') {
    both(`FAILED    the transfer reverted (status ${receipt.status}): the ETH is still on the old wallet; rerun to try again`);
  } else {
    const left = (await arbitrumBalances(fetchImpl, url, oldAddress)).wei;
    const got = (await arbitrumBalances(fetchImpl, url, newAddress)).wei;
    both(`mined     block ${quantity(receipt.blockNumber, 'blockNumber')}: the new relayer has ${ethText(got)} ETH; ${ethText(left)} ETH stays on the old one (gas not used)`);
  }
  both(`next      update ${ENTRY} on Railway (the service's variables) to the new value in the env file, and redeploy; until then serve's relayer has no gas`);
  return summary;
}

async function main() {
  const lines = await runRotate(process.argv.slice(2));
  console.log('');
  for (const l of summaryBlock('relayer-rotate', { at: new Date().toISOString(), lines })) console.log(l);
}

if (isMain(import.meta.url)) await run(main, USAGE);
