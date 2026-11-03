#!/usr/bin/env node
// Deploys the Gimbal contract to a NEW top-level mainnet account: the canary (tools/mainnet/README.md).
//
//   node tools/mainnet/deploy.mjs <contract>.near --funder <account> --key-file <funder key json>
//        --treasury-near <account> --hl-builder <0x...> [--balance <NEAR>] [--send] [--resume]
//
// tx 1, signed by the funder: near.create_account({new_account_id, new_public_key}) with the initial balance
//   attached. The new full-access key is generated into .keys/<contract>.json (gitignored); only its public key is
//   printed.
// tx 2, signed by that new key: DeployContract(contract/target/near/gimbal.wasm) + new(Mainnet, v1.signer,
//   OutLayer price-oracle.near, treasury, fees 1000 bps / 10 tenth-bps, Orderly broker from .env on chain 42161).
//
// Default: a dry run. It reads mainnet and prints both transactions (signer, receiver, every action with its full
// args, deposit and gas) and the balances before and after; nothing is signed, sent or written, and it works
// without --key-file (the key check is then skipped). The broker id and referral codes new() fixes for good are
// printed in full (they are public in config() once deployed); the broker must be the engine's mainnet broker.
// --send: tx 1, wait for final, tx 2, wait for final, then config(). --send refuses to write the key into a linked
// git worktree (its ignored files go with it): run it from the main checkout. Every file written is printed with
// its absolute path.
//
// Never redeploys: the contract account must not exist. --resume is for an earlier --send whose tx 2 failed: the
// account exists, has no code, and .keys/<contract>.json is its full-access key; then only tx 2 is planned.
//
// The lock, its own run after the human checked the deployed contract (the final deploy; a canary stays unlocked so
// it can be retired):
//
//   node tools/mainnet/deploy.mjs <contract>.near --lock [--treasury-near <account>] [--hl-builder <0x...>] [--send]
//
// tx 3, signed by the contract account's own key: DeleteKey of that key, the account's only key. Before it, on
// chain: code_hash = base58(sha256(the built wasm)), config() = new()'s args (the treasury and the builder only
// when given), and view_access_key_list = exactly the full-access key in .keys/<contract>.json (any other key is
// printed and refused). After it: view_access_key_list is empty, and a block with the tx hash, its nearblocks link
// and the code hash goes into the README. Then nobody, us included, can deploy code to the account, sign for it,
// retire it or move its NEAR. The dry run prints all of it and signs nothing; --lock alone works on an account
// deployed earlier, so it is also the resume. Mainnet only: a testnet chain is refused unless --allow-testnet-lock
// (these scripts refuse testnet ids and RPCs anyway; testnet deploys stay upgradeable).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { b58encode, sha256 } from '../testnet/near.mjs';
import { UsageError, envReport, envValues, isMain, parseFlags, run } from './cli.mjs';
import {
  KEYS, MPC, NO_CODE, ORACLE, REGISTRAR, ROOT, YOCTO_PER_BYTE, YOCTO_PER_NEAR, accountLink, act, assertNotInLinkedWorktree,
  ceilToTenth, describeTx, freeBalance, fullAccessVerdict, linkedWorktreeOf, mainnetId, near, nearText, newKeyFile, panicOf,
  nearTextUp, parseNear, readKeyFile, tgasText, topLevelNearId, txGasCap, txLink,
} from './near.mjs';
import { HL_API, MAINNET_ORDERLY_BROKER, brokerIdProblem } from './venues.mjs';

/** USDC on NEAR (native, Circle); balances.mjs has the same constant (a test compares). */
export const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export const WASM = join(ROOT, 'contract', 'target', 'near', 'gimbal.wasm');
const WASM_SHOWN = 'contract/target/near/gimbal.wasm';
const BUILD = 'cd contract && cargo near build non-reproducible-wasm --no-abi';
/** Over the code's storage: the account, its key and the state `new` writes, and tx 2's gas. */
export const STORAGE_MARGIN = YOCTO_PER_NEAR / 2n;
/** Over the initial balance: tx 1's gas and the funder's own storage. */
export const FUNDER_MARGIN = YOCTO_PER_NEAR / 5n;
const CREATE_TGAS = 100n;
const INIT_TGAS = 100n;
const REFERRAL_ENV = { hyperliquid: 'HL_REFERRAL_CODE', orderly: 'ORDERLY_REFERRAL_CODE', phoenix: 'PHOENIX_REFERRAL_CODE' };
/**
 * The methods that move money in and out of a desk on NEAR (interfaces §1.3, contract/src/money.rs): the C8
 * contract has all four. The dry run lists which of them the wasm exports, so nobody funds a desk whose code
 * cannot take money out. (`panic_close` is not part of C8: money leaves through withdraw_to_owner.)
 */
export const MONEY_METHODS = ['ft_on_transfer', 'fund_venue', 'withdraw_to_owner', 'clear_payout_lock'];

/**
 * The first free name after `id` for a new contract account: `<stem>2.near`, `<stem>3.near`, ... where a trailing
 * number of the stem counts up (gimbal-canary.near -> gimbal-canary2.near -> gimbal-canary3.near). A canary is never
 * migrated: each deploy takes a fresh account. `exists(id)` reads the chain; at most `tries` names are asked.
 */
export async function nextFreeName(id, exists, tries = 20) {
  const m = /^(.*?)(\d*)\.near$/.exec(id);
  const stem = m[1];
  let n = m[2] === '' ? 2 : Number(m[2]) + 1;
  for (let i = 0; i < tries; i++, n++) {
    const name = `${stem}${n}.near`;
    if (!(await exists(name))) return name;
  }
  return null;
}

/** The function names a wasm module exports (a contract's methods), read from its export section. */
export function wasmExports(code) {
  const b = Buffer.from(code);
  if (b.length < 8 || b.readUInt32LE(0) !== 0x6d736100) throw new Error('not a wasm module');
  let p = 8;
  const leb = () => {
    let v = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = b[p++];
      if (byte === undefined || shift > 28) throw new Error('a truncated or malformed wasm module');
      v += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return v;
    }
  };
  const names = [];
  while (p < b.length) {
    const id = b[p++];
    const size = leb();
    const end = p + size;
    if (end > b.length) throw new Error('a truncated wasm module');
    if (id === 7) {
      for (let n = leb(); n > 0; n--) {
        const len = leb();
        const name = b.subarray(p, p + len).toString('utf8');
        p += len;
        const kind = b[p++];
        leb();
        if (kind === 0) names.push(name);
      }
    }
    p = end;
  }
  return names;
}

const USAGE = `usage: node tools/mainnet/deploy.mjs <contract>.near --funder <account> --key-file <funder key json>
         --treasury-near <account> --hl-builder <0x...> [--balance <NEAR>] [--send] [--resume]
       node tools/mainnet/deploy.mjs <contract>.near --lock [--treasury-near <account>] [--hl-builder <0x...>] [--send]
  default: dry run (reads mainnet, prints the transactions; --key-file optional)
  --lock: deletes the deployed contract account's only full-access key (no upgrade, no undo); its own run`;

const SPEC = {
  '--funder': 'value', '--key-file': 'value', '--treasury-near': 'value', '--hl-builder': 'value', '--balance': 'value',
  '--send': 'switch', '--resume': 'switch', '--lock': 'switch', '--allow-testnet-lock': 'switch',
};
/** Deploy-only flags: --lock is its own run on an account deployed earlier. */
const DEPLOY_ONLY = ['--funder', '--key-file', '--balance', '--resume'];

const asUsage = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw new UsageError(e.message);
  }
};

/**
 * The command line, checked: ids are mainnet ids, the builder is 0x + 40 hex (lowercased), --send has a key.
 * --lock takes no deploy flag; its --treasury-near and --hl-builder are optional (config() is checked against them
 * when given), and a .testnet contract is refused by name unless --allow-testnet-lock.
 */
export function parseDeployArgs(argv) {
  const { positional, values } = parseFlags(argv, SPEC);
  if (positional.length === 0) throw new UsageError('the contract account is missing');
  if (positional.length > 1) throw new UsageError(`unexpected argument ${positional[1]}`);
  const lock = values['--lock'] === true;
  const allowTestnetLock = values['--allow-testnet-lock'] === true;
  if (allowTestnetLock && !lock) throw new UsageError('--allow-testnet-lock goes with --lock only');
  if (lock) {
    for (const f of DEPLOY_ONLY) if (values[f] !== undefined) throw new UsageError(`--lock is its own run on an account deployed earlier: drop ${f} (it is for the deploy)`);
    if (/\.testnet$/.test(positional[0]) && !allowTestnetLock) {
      throw new UsageError(`--lock refuses testnet (${positional[0]}): a testnet contract may want an upgrade; --allow-testnet-lock overrides that, but these scripts run on mainnet only`);
    }
  } else {
    for (const f of ['--funder', '--treasury-near', '--hl-builder']) if (values[f] === undefined) throw new UsageError(`${f} is required`);
  }
  const contract = asUsage(() => topLevelNearId(positional[0], 'contract'));
  const funder = values['--funder'] === undefined ? null : asUsage(() => mainnetId(values['--funder'], '--funder'));
  const treasuryNear = values['--treasury-near'] === undefined ? null : asUsage(() => mainnetId(values['--treasury-near'], '--treasury-near'));
  if (funder === contract) throw new UsageError('--funder cannot be the new contract account');
  if (treasuryNear === contract || treasuryNear === ORACLE) throw new UsageError(`--treasury-near cannot be ${treasuryNear}`);
  const hlBuilder = values['--hl-builder'] === undefined ? null : values['--hl-builder'].toLowerCase();
  if (hlBuilder !== null && !/^0x[0-9a-f]{40}$/.test(hlBuilder)) throw new UsageError(`--hl-builder ${values['--hl-builder']} is not 0x and 40 hex digits`);
  const balance = values['--balance'] === undefined ? null : asUsage(() => parseNear(values['--balance'], '--balance'));
  const send = values['--send'] === true;
  const resume = values['--resume'] === true;
  if (send && !lock && !resume && values['--key-file'] === undefined) throw new UsageError('--send needs --key-file: the funder signs tx 1');
  return { contract, funder, keyFile: values['--key-file'] ?? null, treasuryNear, hlBuilder, balance, send, resume, lock, allowTestnetLock };
}

/** The deploy dry run's line on the treasury's USDC registration (storage_balance_of; null: not registered). */
export function treasuryUsdcLine(treasury, storageBalance) {
  if (storageBalance !== null && storageBalance !== undefined) return `${treasury} is registered on USDC on NEAR: performance fees can reach it`;
  return `warning: ${treasury} is NOT registered on USDC on NEAR (${NEAR_USDC} storage_balance_of is null): every fee transfer `
    + 'of withdraw_to_owner would fail and the fee would stay in the desk\'s idle USDC. Register it before the first payout with a profit: '
    + `${NEAR_USDC}.storage_deposit({"account_id":"${treasury}","registration_only":true}) with 0.00125 NEAR`;
}

/** The smallest initial balance: the code's bytes at 1e19 yoctoNEAR each, plus 0.5 NEAR. */
export function minInitialBalance(codeBytes) {
  return BigInt(codeBytes) * YOCTO_PER_BYTE + STORAGE_MARGIN;
}

/** The initial balance: --balance, or the minimum rounded up to 0.1 NEAR; refused under the minimum. */
export function initialBalance(codeBytes, asked = null) {
  const min = minInitialBalance(codeBytes);
  const balance = asked ?? ceilToTenth(min);
  if (balance < min) {
    throw new Error(`--balance ${nearText(balance)} NEAR is under ${nearText(min)} NEAR (${codeBytes} bytes of code x 1e19 yoctoNEAR, plus 0.5 NEAR)`);
  }
  return { min, balance };
}

/** The funder must be able to spend the initial balance plus 0.2 NEAR. */
export function checkFunder(free, balance) {
  const need = balance + FUNDER_MARGIN;
  if (free < need) throw new Error(`the funder can spend ${nearText(free, 4)} NEAR; tx 1 needs ${nearText(need, 4)} (the initial balance + 0.2 NEAR)`);
}

/**
 * What the contract account's state allows: 'both' transactions for an account that does not exist; 'tx2' only
 * with --resume, on an account without code whose key in .keys/ is full access on chain; anything else is refused.
 */
export function deployPlanFor(state, { resume = false, keyVerdict = null } = {}) {
  if (state === null) {
    if (resume) throw new Error('--resume: the account does not exist, so there is no tx 1 to resume from; run without --resume');
    return 'both';
  }
  if (state.code_hash !== NO_CODE) throw new Error(`the account exists and has code (${state.code_hash}): never redeployed`);
  if (!resume) throw new Error('the account exists already: never redeployed (an earlier --send whose tx 2 failed? see --resume)');
  if (keyVerdict !== 'matches') throw new Error('--resume: .keys/<contract>.json is not a full-access key of the account on chain');
  return 'tx2';
}

/** The referral codes from the environment or .env: empty is null; the Hyperliquid code is 1 to 20 characters. */
export function referralCodes(env) {
  const codes = {};
  for (const [venue, name] of Object.entries(REFERRAL_ENV)) codes[venue] = env.get(name)?.value ?? null;
  if (codes.hyperliquid !== null && [...codes.hyperliquid].length > 20) throw new Error('HL_REFERRAL_CODE has more than 20 characters: new() refuses it');
  return codes;
}

/** new()'s arguments for mainnet (interfaces §1.1). */
export function initArgs({ treasuryNear, hlBuilder, codes, brokerId }) {
  return {
    network: 'Mainnet',
    mpc: MPC,
    price_source: { OutLayer: { contract: ORACLE } },
    treasury: {
      near: treasuryNear,
      hl_builder: hlBuilder,
      referral_codes: { hyperliquid: codes.hyperliquid, orderly: codes.orderly, phoenix: codes.phoenix },
    },
    fees: { performance_bps: 1000, hl_builder_tenth_bps: 10 },
    orderly: { broker_id: brokerId, chain_id: 42161 },
  };
}

/** JSON with sorted keys, to compare config() with what new() was given. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// --- the lock (tx 3) ---

/** Why --lock refuses the chain the RPC serves, or null: mainnet only, testnet only with --allow-testnet-lock. */
export function lockNetworkProblem(chainId, allowTestnetLock = false) {
  if (chainId === 'mainnet') return null;
  if (chainId === 'testnet') {
    return allowTestnetLock ? null : 'the RPC serves testnet: --lock refuses testnet (a testnet contract may want an upgrade); --allow-testnet-lock overrides';
  }
  return `the RPC serves chain ${JSON.stringify(chainId)}: --lock runs on mainnet only`;
}

/** Every leaf where `actual` differs from `expected`, as `path: expected X, on chain Y`. [] when equal. */
export function configDiff(actual, expected, path = 'config') {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObject(actual) && isObject(expected)) {
    return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort().flatMap((k) => configDiff(actual[k], expected[k], `${path}.${k}`));
  }
  const text = (v) => (v === undefined ? 'missing' : canonical(v));
  return text(actual) === text(expected) ? [] : [`${path}: expected ${text(expected)}, on chain ${text(actual)}`];
}

/**
 * Where config() is not what new() was given on mainnet: the fixed values, the broker and referral codes from the
 * environment or .env, and the treasury account and builder when given (else taken from config() as they are).
 */
export function lockConfigProblems(config, { treasuryNear = null, hlBuilder = null, codes, brokerId }) {
  const expected = initArgs({
    treasuryNear: treasuryNear ?? config?.treasury?.near, hlBuilder: hlBuilder ?? config?.treasury?.hl_builder, codes, brokerId,
  });
  return configDiff(config, expected);
}

/** One access key of view_access_key_list as a line: its public key and permission. */
export function accessKeyLine(k) {
  const p = k?.access_key?.permission;
  if (p === 'FullAccess') return `${k.public_key} FullAccess`;
  const fc = p?.FunctionCall;
  if (fc) {
    return `${k.public_key} FunctionCall receiver ${fc.receiver_id}, allowance ${fc.allowance === null || fc.allowance === undefined ? 'unlimited' : `${nearText(BigInt(fc.allowance))} NEAR`}, `
      + `methods ${JSON.stringify(fc.method_names ?? [])}`;
  }
  return `${k?.public_key} ${JSON.stringify(p)}`;
}

/**
 * Why the DeleteKey may not go out, from the account's view_access_key_list: it must hold exactly one key, the
 * full-access key of .keys/<contract>.json (`ownKey`, null when the file is missing). Any other key is refused, and
 * listed: whoever holds it could still deploy code or sign for the account after the lock.
 */
export function lockKeyProblems(keys, ownKey) {
  // Without the key file nothing can sign, and which key on chain is ours cannot be told.
  if (ownKey === null) return [`the key file is missing, so the key that signs the DeleteKey is unknown (on chain: ${keys.map(accessKeyLine).join('; ')})`];
  const problems = [];
  const own = keys.find((k) => k.public_key === ownKey);
  if (own === undefined) problems.push(`the key file's key ${ownKey} is not on the account`);
  if (own !== undefined && own.access_key?.permission !== 'FullAccess') problems.push(`the key file's key is not full access on chain (${accessKeyLine(own)})`);
  const others = keys.filter((k) => k.public_key !== ownKey);
  if (others.length > 0) {
    problems.push(`the account has ${others.length} other access key${others.length === 1 ? '' : 's'}; a lock leaves no key at all, `
      + `so delete ${others.length === 1 ? 'it' : 'them'} first (or find out whose ${others.length === 1 ? 'it is' : 'they are'}):\n    ${others.map(accessKeyLine).join('\n    ')}`);
  }
  return problems;
}

/** The DeleteKey transaction as printed lines; `publicKey` null prints a placeholder. */
export function lockTxLines({ label, contract, publicKey, keyFile }) {
  const actions = [publicKey === null ? { type: 'DeleteKey', publicKey: `ed25519:<the key in ${keyFile}>` } : act.deleteKey(publicKey)];
  return [
    ...describeTx(label, { signer: contract, signedBy: `the key itself, ${keyFile}`, receiver: contract, actions }),
    `  after     view_access_key_list of ${contract} is empty: nobody, us included, can deploy code to it, sign for it, retire it or move`,
    '            its NEAR; the code above runs as it is for good, and anyone can still send it NEAR. There is no undo.',
  ];
}

/** The block to paste back after the lock, with the README's evidence line. */
export function lockEvidence({ at, contract, hash, codeHash, wasmSha256, wasmBytes }) {
  return [
    `=== gimbal lock ${at} ===`,
    `contract:  ${contract} ${accountLink(contract)}`,
    `DeleteKey: tx ${hash} ${txLink(hash)}`,
    `code_hash: ${codeHash} (base58 of sha256 ${wasmSha256}, ${WASM_SHOWN}, ${wasmBytes.toLocaleString('en-US')} bytes)`,
    'keys:      view_access_key_list is empty',
    'README:',
    `Contract has no access keys: DeleteKey tx ${hash} (${txLink(hash)}), code_hash ${codeHash}.`,
    '=== end ===',
  ];
}

async function builderPerpsUsd(address, fetchImpl) {
  try {
    const res = await fetchImpl(`${HL_API}/info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: address }),
      signal: AbortSignal.timeout(20_000),
    });
    const v = Number((await res.json())?.marginSummary?.accountValue);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** How the next run locks the account: the lock's own command line (tx 3). */
const lockCommand = (a) => `node tools/mainnet/deploy.mjs ${a.contract} --lock --treasury-near ${a.treasuryNear} --hl-builder ${a.hlBuilder}`;

async function deploy(a, { client, say, readWasm, envOf, readKey, keyExists, fetchImpl }) {
  say(`gimbal mainnet deploy of ${a.contract}: ${a.send ? 'SEND' : 'dry run'}${a.resume ? ', resume (tx 2 only)' : ''}`);
  const contractKeyFile = join(KEYS, `${a.contract}.json`);
  // The contract account's only full-access key is never written into a linked worktree (deleted with it).
  if (a.send) assertNotInLinkedWorktree(contractKeyFile, 'the contract account\'s key');
  const tree = linkedWorktreeOf(contractKeyFile);
  say(`files     ${a.send ? '' : '--send '}writes the contract account's key to ${contractKeyFile}`);
  if (tree !== null) say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);

  const wasm = readWasm();
  if (wasm === null) throw new Error(`${WASM_SHOWN} is missing: ${BUILD}`);
  const hash = sha256(wasm);
  say(`wasm      ${WASM_SHOWN}: ${wasm.length.toLocaleString('en-US')} bytes, sha256 ${hash.toString('hex')} (code_hash ${b58encode(hash)})`);
  const exported = wasmExports(wasm);
  const missing = MONEY_METHODS.filter((m) => !exported.includes(m));
  say(`methods   ${exported.length} exported; money methods ${MONEY_METHODS.map((m) => `${m} ${exported.includes(m) ? 'yes' : 'NO'}`).join(', ')}`);
  if (missing.length > 0) {
    say(`warning   this code cannot ${missing.length === MONEY_METHODS.length ? 'take money in or out' : `run ${missing.join(', ')}`}: send no funds to the desk's addresses `
      + 'while it is deployed (tools/mainnet/README.md, "What this contract version can do")');
  }
  const { min, balance } = initialBalance(wasm.length, a.balance);
  say(`balance   ${nearText(balance)} NEAR initial${a.balance === null ? ' (the default)' : ''}; at least ${nearText(min)}: ${wasm.length.toLocaleString('en-US')} bytes x 1e19 yoctoNEAR + 0.5 NEAR`);

  // Public once deployed (config()), and fixed by new() for good: printed in full so this is the moment to check.
  const env = envOf(['ORDERLY_BROKER_ID', ...Object.values(REFERRAL_ENV)]);
  for (const line of envReport(env)) say(line);
  const broker = env.get('ORDERLY_BROKER_ID');
  if (broker.value === null) throw new Error('ORDERLY_BROKER_ID is empty: the mainnet broker id goes into new() and can never change');
  const brokerProblem = brokerIdProblem(broker.value);
  if (brokerProblem !== null) throw new Error(`${brokerProblem}; new() would fix it for the contract's life`);
  const codes = referralCodes(env);
  const init = initArgs({ treasuryNear: a.treasuryNear, hlBuilder: a.hlBuilder, codes, brokerId: broker.value });

  const status = await client.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  for (const id of [MPC, ORACLE]) if ((await client.account(id)) === null) throw new Error(`${id} does not exist on this chain`);
  if ((await client.account(a.treasuryNear)) === null) throw new Error(`--treasury-near ${a.treasuryNear} does not exist on mainnet: the performance fee would have nowhere to go`);
  say(`accounts  ${MPC}, ${ORACLE} and the treasury ${a.treasuryNear} exist`);
  // withdraw_to_owner sends the performance fee with ft_transfer: to a treasury USDC does not know, every fee
  // transfer fails and the fee stays in the desk's idle USDC, due again at the next payout.
  const treasuryOnUsdc = await client.view(NEAR_USDC, 'storage_balance_of', { account_id: a.treasuryNear });
  say(`treasury  ${treasuryUsdcLine(a.treasuryNear, treasuryOnUsdc)}`);

  const state = await client.account(a.contract);
  if (state !== null && !a.resume) {
    const free = await nextFreeName(a.contract, async (id) => (await client.account(id)) !== null);
    throw new Error(`${a.contract} exists already: a canary is never redeployed or migrated, it takes a fresh account. `
      + `${free === null ? 'No free name found after it' : `The first free name after it is ${free}`} (or an earlier --send whose tx 2 failed? see --resume)`);
  }
  let keyVerdict = null;
  if (state !== null && a.resume && keyExists(contractKeyFile)) {
    keyVerdict = fullAccessVerdict(await client.accessKey(a.contract, readKey(contractKeyFile, a.contract).publicKeyString));
  }
  const plan = deployPlanFor(state, { resume: a.resume, keyVerdict });
  say(`contract  ${a.contract}: ${state === null
    ? 'does not exist: the name is free (a new account, as it must be)'
    : `exists without code, ${nearText(BigInt(state.amount), 4)} NEAR; ${contractKeyFile} ${keyVerdict}`}`);
  if (plan === 'both' && keyExists(contractKeyFile)) {
    const msg = `${contractKeyFile} exists but the account does not: move it away or pick another name`;
    if (a.send) throw new Error(msg);
    say(`warning   ${msg} (--send refuses)`);
  }

  const gasPrice = BigInt((await client.rpc('gas_price', [null])).gas_price);
  const fees = await client.fees();
  let funder = null;
  let verdict = null;
  let funderShort = null;
  if (plan === 'both') {
    funder = await client.account(a.funder);
    if (funder === null) throw new Error(`--funder ${a.funder} does not exist on mainnet`);
    const free = freeBalance(funder);
    say(`funder    ${a.funder}: ${nearText(BigInt(funder.amount), 4)} NEAR, ${nearText(free, 4)} free to spend`);
    // The dry run still prints the plan (the funder may be waiting for a retired canary's NEAR); --send refuses here.
    try {
      checkFunder(free, balance);
    } catch (e) {
      if (a.send) throw e;
      funderShort = e.message;
      say(`warning   ${e.message}: --send refuses until it can`);
    }
    if (a.keyFile !== null) verdict = fullAccessVerdict(await client.accessKey(a.funder, readKey(a.keyFile, a.funder).publicKeyString));
    say(`key       --key-file: ${verdict ?? 'check skipped (no --key-file)'}`);
    if (a.send && verdict !== 'matches') throw new Error('--send needs --key-file holding a full-access key of the funder');
  }

  const builderUsd = await builderPerpsUsd(a.hlBuilder, fetchImpl);
  say(`builder   ${a.hlBuilder}: ${builderUsd === null ? 'its Hyperliquid balance could not be read' : `${builderUsd} USDC in Hyperliquid perps`}`
    + `${builderUsd !== null && builderUsd >= 100 ? '' : ' (Hyperliquid needs at least 100 before an order carries the builder fee; the address is fixed by new(), the funds can come later)'}`);

  const newKeyShown = `ed25519:<new key; --send writes it to ${contractKeyFile}>`;
  const tx1Actions = (publicKey) => [act.call('create_account', { new_account_id: a.contract, new_public_key: publicKey }, CREATE_TGAS, balance)];
  const tx2Actions = [act.deploy(wasm, WASM_SHOWN), act.call('new', init, INIT_TGAS, 0n)];
  // The most gas each transaction can burn: prepaid gas, DeployContract's per-byte fee and the action fees, from
  // the live runtime config. tx 1's key is a placeholder of a real key's length.
  const cap1 = txGasCap(fees, { signer: a.funder, receiver: REGISTRAR, actions: tx1Actions(`ed25519:${'1'.repeat(44)}`) });
  const cap2 = txGasCap(fees, { signer: a.contract, receiver: a.contract, actions: tx2Actions });
  const perByte = (BigInt(fees.deployByte.send_sir) + BigInt(fees.deployByte.execution));
  say(`gas       tx 1 at most ${tgasText(cap1.total)} TGas (${tgasText(cap1.prepaid)} prepaid for create_account + ${tgasText(cap1.fees)} action fees); `
    + `tx 2 at most ${tgasText(cap2.total)} TGas (${tgasText(cap2.prepaid)} prepaid for new() + ${tgasText(cap2.deploy)} DeployContract, `
    + `${wasm.length.toLocaleString('en-US')} bytes x ${(Number(perByte) / 1e6).toFixed(1)} Mgas + ${tgasText(cap2.fees)} action fees)`);
  say();
  if (plan === 'both') {
    const actions = tx1Actions(newKeyShown);
    say(describeTx('tx 1: create the account', {
      signer: a.funder, signedBy: a.keyFile === null ? 'the funder\'s key; not checked without --key-file' : `--key-file, ${verdict}`, receiver: REGISTRAR, actions,
    }).join('\n'));
  } else {
    say('tx 1: done earlier (--resume)');
  }
  say(describeTx('tx 2: deploy and initialise', { signer: a.contract, signedBy: `the account's own key, ${contractKeyFile}`, receiver: a.contract, actions: tx2Actions }).join('\n'));
  // Planned here so it is never a surprise, sent only by its own run: the human checks the deployed contract first.
  say(lockTxLines({ label: 'tx 3, its own run (--lock), after you checked the deployed contract: lock the account', contract: a.contract, publicKey: null, keyFile: contractKeyFile }).join('\n'));
  say(`            the final deploy only (a canary stays unlocked, so it can be retired): ${lockCommand(a)}, then the same with --send`);

  const codeStorage = BigInt(wasm.length) * YOCTO_PER_BYTE;
  const gasNear = (cap) => nearTextUp(cap.total * gasPrice, 4);
  say('\nbalances (NEAR)');
  if (plan === 'both') {
    const before = BigInt(funder.amount);
    say(`  ${a.funder}: ${nearText(before, 4)} now; about ${nearText(before - balance, 4)} after tx 1 (${nearText(balance)} attached; gas at most ${gasNear(cap1)}, mostly refunded)`);
    say(`  ${a.contract}: none now; ${nearText(balance)} after tx 1; after tx 2 the same less its gas (at most ${gasNear(cap2)}), `
      + `${nearText(codeStorage, 4)} of it held for the code's storage, plus the state's`);
  } else {
    say(`  ${a.contract}: ${nearText(BigInt(state.amount), 4)} now; tx 2 holds ${nearText(codeStorage, 4)} of it for the code's storage, gas at most ${gasNear(cap2)}`);
    if (BigInt(state.amount) < min) throw new Error(`${a.contract} holds ${nearText(BigInt(state.amount), 4)} NEAR, under the ${nearText(min, 4)} tx 2 needs`);
  }
  say(`  gas price ${gasPrice} yoctoNEAR per gas`);

  if (!a.send) {
    say('\ndry run: nothing was signed, sent or written. new() fixes every value in tx 2\'s args for the contract\'s life:');
    say('check them now. Add --send (and --key-file) to send tx 1, then tx 2, from the main checkout. --send never sends tx 3.');
    if (funderShort !== null) throw new Error(`${funderShort} (the plan above is complete; send the funder NEAR first, e.g. by retiring the old canary)`);
    return;
  }

  if (plan === 'both') {
    const funderKey = readKey(a.keyFile, a.funder);
    const publicKey = newKeyFile(contractKeyFile, a.contract);
    say(`\nnew key   ${publicKey} written to ${contractKeyFile}`);
    const out1 = await client.send(funderKey, REGISTRAR, tx1Actions(publicKey), { onSent: (h) => say(`tx 1 sent ${h}; waiting for final`) });
    if (out1.failure !== null || out1.value !== true) {
      throw new Error(`tx 1 ${out1.hash}: ${out1.failure !== null ? panicOf(out1.failure) : `create_account returned ${JSON.stringify(out1.value)}`} `
        + `(${txLink(out1.hash)}); near refunds the deposit when it does not create the account`);
    }
    say(`tx 1 final: ${txLink(out1.hash)} (${out1.burntTgas} TGas, ${nearText(out1.burntYocto, 6)} NEAR burnt)`);
    if (fullAccessVerdict(await client.accessKey(a.contract, publicKey)) !== 'matches') {
      throw new Error(`${a.contract} has no full-access key ${publicKey} after tx 1: look at ${accountLink(a.contract)}`);
    }
    say(`back up   ${contractKeyFile} now: it is ${a.contract}'s only key, and nothing else can sign for the account`);
  }
  const key = readKey(contractKeyFile, a.contract);
  const out2 = await client.send(key, a.contract, tx2Actions, { onSent: (h) => say(`tx 2 sent ${h}; waiting for final`) });
  if (out2.failure !== null) {
    throw new Error(`tx 2 ${out2.hash}: ${panicOf(out2.failure)} (${txLink(out2.hash)}). The account keeps its balance and has no code: `
      + 'fix the cause, then run again with --send --resume');
  }
  say(`tx 2 final: ${txLink(out2.hash)} (${out2.burntTgas} TGas, ${nearText(out2.burntYocto, 6)} NEAR burnt)`);
  for (const log of out2.logs) say(`  log ${log}`);

  const config = await client.view(a.contract, 'config');
  say(`\nconfig()  ${JSON.stringify(config)}`);
  say(`version() ${JSON.stringify(await client.view(a.contract, 'version'))}`);
  const after = await client.account(a.contract);
  say(`${a.contract}: ${nearText(BigInt(after.amount), 4)} NEAR, ${after.storage_usage.toLocaleString('en-US')} bytes stored, code ${after.code_hash}`);
  say(`explorer  ${accountLink(a.contract)}`);
  if (canonical(config) !== canonical(init)) throw new Error('config() is not what new() was given: stop and compare it with the args above');
  say('config() is what new() was given');
  say(`\nnext      the final deploy only: check the contract (config, version, nearblocks), then lock it (tx 3): ${lockCommand(a)}`);
  say('          (a dry run), then the same with --send. A canary stays unlocked, so it can be retired.');
}

async function lock(a, { client, say, readWasm, envOf, readKey, keyExists, at }) {
  say(`gimbal mainnet lock of ${a.contract}: ${a.send ? 'SEND' : 'dry run'} (DeleteKey of its last full-access key: no upgrade, no undo)`);
  const status = await client.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  const network = lockNetworkProblem(status.chain_id, a.allowTestnetLock);
  if (network !== null) throw new Error(network);

  const wasm = readWasm();
  if (wasm === null) throw new Error(`${WASM_SHOWN} is missing: build the code that was deployed (${BUILD}), its hash is compared with the account's`);
  const hash = sha256(wasm);
  const codeHash = b58encode(hash);
  say(`wasm      ${WASM_SHOWN}: ${wasm.length.toLocaleString('en-US')} bytes, sha256 ${hash.toString('hex')} (code_hash ${codeHash})`);

  // What new() was given, from the same sources the deploy used: the broker and the referral codes (.env or the
  // shell), and the treasury and the builder from the command line when given.
  const env = envOf(['ORDERLY_BROKER_ID', ...Object.values(REFERRAL_ENV)]);
  for (const line of envReport(env)) say(line);
  const brokerEnv = env.get('ORDERLY_BROKER_ID').value;
  if (brokerEnv !== null && brokerIdProblem(brokerEnv) !== null) throw new Error(brokerIdProblem(brokerEnv));
  const codes = referralCodes(env);

  const problems = [];
  const keyFile = join(KEYS, `${a.contract}.json`);
  const ownKey = keyExists(keyFile) ? readKey(keyFile, a.contract).publicKeyString : null;
  say(`key file  ${keyFile}: ${ownKey === null ? 'missing (run from the main checkout, where deploy --send wrote it)' : ownKey}`);

  const state = await client.account(a.contract);
  if (state === null) {
    problems.push(`${a.contract} does not exist: deploy it first (this script without --lock), check it, then lock it`);
    say(`contract  ${a.contract}: does not exist, so its code hash, config() and keys are not checked (--send refuses until it is deployed)`);
  } else {
    say(`contract  ${a.contract}: ${nearText(BigInt(state.amount), 4)} NEAR, ${state.storage_usage.toLocaleString('en-US')} bytes stored, code_hash ${state.code_hash}`);
    if (state.code_hash === NO_CODE) {
      problems.push(`${a.contract} has no code: deploy it first (this script without --lock, or --resume)`);
    } else {
      if (state.code_hash === codeHash) say(`code      the code on chain is the built wasm: code_hash ${codeHash}`);
      else problems.push(`code_hash ${state.code_hash} on chain is not ${codeHash}, the base58 sha256 of ${WASM_SHOWN}: build exactly the code that was deployed, or stop`);
      const config = await client.view(a.contract, 'config');
      say(`config()  ${JSON.stringify(config)}`);
      say(`version() ${JSON.stringify(await client.view(a.contract, 'version'))}`);
      const diff = lockConfigProblems(config, { treasuryNear: a.treasuryNear, hlBuilder: a.hlBuilder, codes, brokerId: MAINNET_ORDERLY_BROKER });
      if (diff.length > 0) problems.push(`config() is not what new() was given on mainnet:\n    ${diff.join('\n    ')}`);
      else say('config   matches: Mainnet, v1.signer, OutLayer price-oracle.near, fees 1000 bps / 10 tenth-bps, Orderly gimbal_dex on 42161, the referral codes above');
      const unchecked = [a.treasuryNear === null ? '--treasury-near' : null, a.hlBuilder === null ? '--hl-builder' : null].filter(Boolean);
      if (unchecked.length > 0) {
        say(`warning   treasury ${JSON.stringify(config?.treasury?.near)} and builder ${JSON.stringify(config?.treasury?.hl_builder)} are taken as they are: `
          + `pass ${unchecked.join(' and ')} to check ${unchecked.length === 1 ? 'it' : 'them'}`);
      }
    }
    const keys = await client.accessKeys(a.contract);
    say(`keys      ${keys.length} access key${keys.length === 1 ? '' : 's'} on chain${keys.length === 0 ? '' : ':'}`);
    for (const k of keys) say(`          ${accessKeyLine(k)}${k.public_key === ownKey ? ' (the key file)' : ''}`);
    if (keys.length === 0) {
      say(`\nnothing to send: ${a.contract} has no access keys, it is locked already (code_hash ${state.code_hash}). Its DeleteKey is on ${accountLink(a.contract)}.`);
      if (problems.length > 0) throw new Error(`but:\n  ${problems.join('\n  ')}`);
      return null;
    }
    problems.push(...lockKeyProblems(keys, ownKey));
  }

  const fees = await client.fees();
  const gasPrice = BigInt((await client.rpc('gas_price', [null])).gas_price);
  const cap = txGasCap(fees, { signer: a.contract, receiver: a.contract, actions: [{ type: 'DeleteKey' }] });
  say();
  say(lockTxLines({ label: 'tx 3: lock the account', contract: a.contract, publicKey: ownKey, keyFile }).join('\n'));
  say(`gas       at most ${tgasText(cap.total)} TGas (action fees only), at most ${nearTextUp(cap.total * gasPrice, 6)} NEAR from ${a.contract}'s balance`);

  if (!a.send) {
    say('\ndry run: nothing was signed or sent. Check the contract first (config, version, nearblocks), then add --send to delete the key.');
    if (problems.length > 0) throw new Error(`--send would refuse:\n  ${problems.join('\n  ')}`);
    return null;
  }
  if (problems.length > 0) throw new Error(`not locking ${a.contract}:\n  ${problems.join('\n  ')}`);

  const signer = readKey(keyFile, a.contract);
  const out = await client.send(signer, a.contract, [act.deleteKey(signer.publicKeyString)], { onSent: (h) => say(`\nDeleteKey sent ${h}; waiting for final`) });
  if (out.failure !== null) throw new Error(`DeleteKey ${out.hash}: ${panicOf(out.failure)} (${txLink(out.hash)}); the key is still on the account`);
  say(`DeleteKey final: ${txLink(out.hash)} (${out.burntTgas} TGas, ${nearText(out.burntYocto, 6)} NEAR burnt)`);
  const left = await client.accessKeys(a.contract);
  if (left.length > 0) throw new Error(`${a.contract} still has access keys after ${out.hash}:\n  ${left.map(accessKeyLine).join('\n  ')}`);
  const after = await client.account(a.contract);
  if (after?.code_hash !== codeHash) throw new Error(`${a.contract}'s code_hash is ${after?.code_hash} after the lock, not ${codeHash}: look at ${accountLink(a.contract)}`);
  say(`keys      view_access_key_list of ${a.contract} is empty; code_hash ${after.code_hash}`);
  const block = lockEvidence({ at: at(), contract: a.contract, hash: out.hash, codeHash, wasmSha256: hash.toString('hex'), wasmBytes: wasm.length });
  say();
  say(block.join('\n'));
  say(`\nkey file  ${keyFile} is now useless: its key is on no account any more and can sign nothing. You can delete it.`);
  return block;
}

/**
 * The script: --lock runs the lock, anything else the deploy. `deps` replaces the mainnet client (`client`), the
 * printer (`say`), the wasm (`readWasm`, null when missing), the env reader (`envOf`), key files (`readKey`,
 * `keyExists`), fetch and the clock (`at`), for tests.
 */
export async function runDeploy(argv, deps = {}) {
  const a = parseDeployArgs(argv);
  const ctx = {
    client: deps.client ?? near,
    say: deps.say ?? ((s = '') => console.log(s)),
    readWasm: deps.readWasm ?? (() => (existsSync(WASM) ? readFileSync(WASM) : null)),
    envOf: deps.envOf ?? ((names) => envValues(names)),
    readKey: deps.readKey ?? readKeyFile,
    keyExists: deps.keyExists ?? existsSync,
    fetchImpl: deps.fetch ?? ((...x) => globalThis.fetch(...x)),
    at: deps.at ?? (() => new Date().toISOString()),
  };
  return a.lock ? lock(a, ctx) : deploy(a, ctx);
}

if (isMain(import.meta.url)) await run(() => runDeploy(process.argv.slice(2)), USAGE);
