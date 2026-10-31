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
// without --key-file (the key check is then skipped). Values from .env (broker id, referral codes) are shown by
// name and length, never printed. --send: tx 1, wait for final, tx 2, wait for final, then config().
//
// Never redeploys: the contract account must not exist. --resume is for an earlier --send whose tx 2 failed: the
// account exists, has no code, and .keys/<contract>.json is its full-access key; then only tx 2 is planned.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../testnet/near.mjs';
import { UsageError, envValues, isMain, parseFlags, run, shownEnv } from './cli.mjs';
import {
  KEYS, MPC, NO_CODE, ORACLE, REGISTRAR, ROOT, TGAS, YOCTO_PER_BYTE, YOCTO_PER_NEAR, accountLink, act, ceilToTenth, describeTx,
  freeBalance, fullAccessVerdict, mainnetId, near, nearText, newKeyFile, panicOf, parseNear, readKeyFile, topLevelNearId, txLink,
} from './near.mjs';
import { HL_API } from './venues.mjs';

export const WASM = join(ROOT, 'contract', 'target', 'near', 'gimbal.wasm');
const WASM_SHOWN = 'contract/target/near/gimbal.wasm';
/** Over the code's storage: the account, its key and the state `new` writes, and tx 2's gas. */
export const STORAGE_MARGIN = YOCTO_PER_NEAR / 2n;
/** Over the initial balance: tx 1's gas and the funder's own storage. */
export const FUNDER_MARGIN = YOCTO_PER_NEAR / 5n;
const CREATE_TGAS = 100n;
const INIT_TGAS = 100n;
const REFERRAL_ENV = { hyperliquid: 'HL_REFERRAL_CODE', orderly: 'ORDERLY_REFERRAL_CODE', phoenix: 'PHOENIX_REFERRAL_CODE' };

const USAGE = `usage: node tools/mainnet/deploy.mjs <contract>.near --funder <account> --key-file <funder key json>
         --treasury-near <account> --hl-builder <0x...> [--balance <NEAR>] [--send] [--resume]
  default: dry run (reads mainnet, prints the transactions; --key-file optional)`;

const SPEC = {
  '--funder': 'value', '--key-file': 'value', '--treasury-near': 'value', '--hl-builder': 'value', '--balance': 'value',
  '--send': 'switch', '--resume': 'switch',
};

const asUsage = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw new UsageError(e.message);
  }
};

/** The command line, checked: ids are mainnet ids, the builder is 0x + 40 hex (lowercased), --send has a key. */
export function parseDeployArgs(argv) {
  const { positional, values } = parseFlags(argv, SPEC);
  if (positional.length === 0) throw new UsageError('the contract account is missing');
  if (positional.length > 1) throw new UsageError(`unexpected argument ${positional[1]}`);
  for (const f of ['--funder', '--treasury-near', '--hl-builder']) if (values[f] === undefined) throw new UsageError(`${f} is required`);
  const contract = asUsage(() => topLevelNearId(positional[0], 'contract'));
  const funder = asUsage(() => mainnetId(values['--funder'], '--funder'));
  const treasuryNear = asUsage(() => mainnetId(values['--treasury-near'], '--treasury-near'));
  if (funder === contract) throw new UsageError('--funder cannot be the new contract account');
  if (treasuryNear === contract || treasuryNear === ORACLE) throw new UsageError(`--treasury-near cannot be ${treasuryNear}`);
  const hlBuilder = values['--hl-builder'].toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(hlBuilder)) throw new UsageError(`--hl-builder ${values['--hl-builder']} is not 0x and 40 hex digits`);
  const balance = values['--balance'] === undefined ? null : asUsage(() => parseNear(values['--balance'], '--balance'));
  const send = values['--send'] === true;
  const resume = values['--resume'] === true;
  if (send && !resume && values['--key-file'] === undefined) throw new UsageError('--send needs --key-file: the funder signs tx 1');
  return { contract, funder, keyFile: values['--key-file'] ?? null, treasuryNear, hlBuilder, balance, send, resume };
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

async function builderPerpsUsd(address) {
  try {
    const res = await fetch(`${HL_API}/info`, {
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

async function main() {
  const a = parseDeployArgs(process.argv.slice(2));
  const say = (s = '') => console.log(s);
  say(`gimbal mainnet deploy of ${a.contract}: ${a.send ? 'SEND' : 'dry run'}${a.resume ? ', resume (tx 2 only)' : ''}`);

  if (!existsSync(WASM)) throw new Error(`${WASM_SHOWN} is missing: cd contract && cargo near build non-reproducible-wasm --no-abi`);
  const wasm = readFileSync(WASM);
  say(`wasm      ${WASM_SHOWN}: ${wasm.length.toLocaleString('en-US')} bytes, sha256 ${sha256(wasm).toString('hex')}`);
  const { min, balance } = initialBalance(wasm.length, a.balance);
  say(`balance   ${nearText(balance)} NEAR initial${a.balance === null ? ' (the default)' : ''}; at least ${nearText(min)}: ${wasm.length.toLocaleString('en-US')} bytes x 1e19 yoctoNEAR + 0.5 NEAR`);

  const env = envValues(['ORDERLY_BROKER_ID', ...Object.values(REFERRAL_ENV)]);
  for (const [name, e] of env) say(`env       ${name}: ${e.value === null ? 'empty (null)' : `set, from ${e.from}`}`);
  const broker = env.get('ORDERLY_BROKER_ID');
  if (broker.value === null) throw new Error('ORDERLY_BROKER_ID is empty: the mainnet broker id goes into new() and can never change');
  const codes = referralCodes(env);
  const shownCodes = Object.fromEntries(Object.entries(REFERRAL_ENV).map(([venue, name]) => [venue, shownEnv(name, env.get(name))]));
  const init = initArgs({ treasuryNear: a.treasuryNear, hlBuilder: a.hlBuilder, codes, brokerId: broker.value });
  const shownInit = initArgs({ treasuryNear: a.treasuryNear, hlBuilder: a.hlBuilder, codes: shownCodes, brokerId: shownEnv('ORDERLY_BROKER_ID', broker) });

  const status = await near.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  for (const id of [MPC, ORACLE]) if ((await near.account(id)) === null) throw new Error(`${id} does not exist on this chain`);
  if ((await near.account(a.treasuryNear)) === null) throw new Error(`--treasury-near ${a.treasuryNear} does not exist on mainnet: the performance fee would have nowhere to go`);
  say(`accounts  ${MPC}, ${ORACLE} and the treasury ${a.treasuryNear} exist`);

  const contractKeyFile = join(KEYS, `${a.contract}.json`);
  const state = await near.account(a.contract);
  let keyVerdict = null;
  if (state !== null && a.resume && existsSync(contractKeyFile)) {
    keyVerdict = fullAccessVerdict(await near.accessKey(a.contract, readKeyFile(contractKeyFile, a.contract).publicKeyString));
  }
  const plan = deployPlanFor(state, { resume: a.resume, keyVerdict });
  say(`contract  ${a.contract}: ${state === null
    ? 'does not exist (a new account, as it must be)'
    : `exists without code, ${nearText(BigInt(state.amount), 4)} NEAR; .keys/${a.contract}.json ${keyVerdict}`}`);
  if (plan === 'both' && existsSync(contractKeyFile)) {
    const msg = `.keys/${a.contract}.json exists but the account does not: move it away or pick another name`;
    if (a.send) throw new Error(msg);
    say(`warning   ${msg} (--send refuses)`);
  }

  const gasPrice = BigInt((await near.rpc('gas_price', [null])).gas_price);
  const maxGas = (tgas) => tgas * TGAS * gasPrice;
  let funder = null;
  let verdict = null;
  if (plan === 'both') {
    funder = await near.account(a.funder);
    if (funder === null) throw new Error(`--funder ${a.funder} does not exist on mainnet`);
    const free = freeBalance(funder);
    say(`funder    ${a.funder}: ${nearText(BigInt(funder.amount), 4)} NEAR, ${nearText(free, 4)} free to spend`);
    checkFunder(free, balance);
    if (a.keyFile !== null) verdict = fullAccessVerdict(await near.accessKey(a.funder, readKeyFile(a.keyFile, a.funder).publicKeyString));
    say(`key       --key-file: ${verdict ?? 'check skipped (no --key-file)'}`);
    if (a.send && verdict !== 'matches') throw new Error('--send needs --key-file holding a full-access key of the funder');
  }

  const builderUsd = await builderPerpsUsd(a.hlBuilder);
  say(`builder   ${a.hlBuilder}: ${builderUsd === null ? 'its Hyperliquid balance could not be read' : `${builderUsd} USDC in Hyperliquid perps`}`
    + `${builderUsd !== null && builderUsd >= 100 ? '' : ' (Hyperliquid needs at least 100 before an order carries the builder fee; the address is fixed by new(), the funds can come later)'}`);

  const newKeyShown = `ed25519:<new key; --send writes it to .keys/${a.contract}.json>`;
  const tx1Actions = (publicKey) => [act.call('create_account', { new_account_id: a.contract, new_public_key: publicKey }, CREATE_TGAS, balance)];
  const tx2Actions = [act.deploy(wasm, WASM_SHOWN), act.call('new', init, INIT_TGAS, 0n, shownInit)];
  say();
  if (plan === 'both') {
    const actions = tx1Actions(newKeyShown);
    say(describeTx('tx 1: create the account', {
      signer: a.funder, signedBy: a.keyFile === null ? 'the funder\'s key; not checked without --key-file' : `--key-file, ${verdict}`, receiver: REGISTRAR, actions,
    }).join('\n'));
  } else {
    say('tx 1: done earlier (--resume)');
  }
  say(describeTx('tx 2: deploy and initialise', { signer: a.contract, signedBy: `the account's own key, .keys/${a.contract}.json`, receiver: a.contract, actions: tx2Actions }).join('\n'));

  const codeStorage = BigInt(wasm.length) * YOCTO_PER_BYTE;
  say('\nbalances (NEAR)');
  if (plan === 'both') {
    const before = BigInt(funder.amount);
    say(`  ${a.funder}: ${nearText(before, 4)} now; about ${nearText(before - balance, 4)} after tx 1 (${nearText(balance)} attached; gas at most ${nearText(maxGas(CREATE_TGAS + 5n), 4)}, mostly refunded)`);
    say(`  ${a.contract}: none now; ${nearText(balance)} after tx 1; after tx 2 the same less its gas (at most ${nearText(maxGas(INIT_TGAS + 10n), 4)}), `
      + `${nearText(codeStorage, 4)} of it held for the code's storage, plus the state's`);
  } else {
    say(`  ${a.contract}: ${nearText(BigInt(state.amount), 4)} now; tx 2 holds ${nearText(codeStorage, 4)} of it for the code's storage, gas at most ${nearText(maxGas(INIT_TGAS + 10n), 4)}`);
    if (BigInt(state.amount) < min) throw new Error(`${a.contract} holds ${nearText(BigInt(state.amount), 4)} NEAR, under the ${nearText(min, 4)} tx 2 needs`);
  }
  say(`  gas price ${gasPrice} yoctoNEAR per gas`);

  if (!a.send) {
    say('\ndry run: nothing was signed, sent or written. Values from .env are shown by name only; check them in .env,');
    say('new() fixes them for the contract\'s life. Add --send (and --key-file) to send tx 1, then tx 2.');
    return;
  }

  if (plan === 'both') {
    const funderKey = readKeyFile(a.keyFile, a.funder);
    const publicKey = newKeyFile(contractKeyFile, a.contract);
    say(`\nnew key   ${publicKey} -> .keys/${a.contract}.json`);
    const out1 = await near.send(funderKey, REGISTRAR, tx1Actions(publicKey), { onSent: (h) => say(`tx 1 sent ${h}; waiting for final`) });
    if (out1.failure !== null || out1.value !== true) {
      throw new Error(`tx 1 ${out1.hash}: ${out1.failure !== null ? panicOf(out1.failure) : `create_account returned ${JSON.stringify(out1.value)}`} `
        + `(${txLink(out1.hash)}); near refunds the deposit when it does not create the account`);
    }
    say(`tx 1 final: ${txLink(out1.hash)} (${out1.burntTgas} TGas, ${nearText(out1.burntYocto, 6)} NEAR burnt)`);
    if (fullAccessVerdict(await near.accessKey(a.contract, publicKey)) !== 'matches') {
      throw new Error(`${a.contract} has no full-access key ${publicKey} after tx 1: look at ${accountLink(a.contract)}`);
    }
  }
  const key = readKeyFile(contractKeyFile, a.contract);
  const out2 = await near.send(key, a.contract, tx2Actions, { onSent: (h) => say(`tx 2 sent ${h}; waiting for final`) });
  if (out2.failure !== null) {
    throw new Error(`tx 2 ${out2.hash}: ${panicOf(out2.failure)} (${txLink(out2.hash)}). The account keeps its balance and has no code: `
      + 'fix the cause, then run again with --send --resume');
  }
  say(`tx 2 final: ${txLink(out2.hash)} (${out2.burntTgas} TGas, ${nearText(out2.burntYocto, 6)} NEAR burnt)`);
  for (const log of out2.logs) say(`  log ${log}`);

  const config = await near.view(a.contract, 'config');
  say(`\nconfig()  ${JSON.stringify(config)}`);
  say(`version() ${JSON.stringify(await near.view(a.contract, 'version'))}`);
  const after = await near.account(a.contract);
  say(`${a.contract}: ${nearText(BigInt(after.amount), 4)} NEAR, ${after.storage_usage.toLocaleString('en-US')} bytes stored, code ${after.code_hash}`);
  say(`explorer  ${accountLink(a.contract)}`);
  if (canonical(config) !== canonical(init)) throw new Error('config() is not what new() was given: stop and compare it with the args above');
  say('config() is what new() was given');
}

if (isMain(import.meta.url)) await run(main, USAGE);
