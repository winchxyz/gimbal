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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { b58encode, sha256 } from '../testnet/near.mjs';
import { UsageError, envReport, envValues, isMain, parseFlags, run } from './cli.mjs';
import {
  KEYS, MPC, NO_CODE, ORACLE, REGISTRAR, ROOT, YOCTO_PER_BYTE, YOCTO_PER_NEAR, accountLink, act, assertNotInLinkedWorktree,
  ceilToTenth, describeTx, freeBalance, fullAccessVerdict, linkedWorktreeOf, mainnetId, near, nearText, newKeyFile, panicOf,
  nearTextUp, parseNear, readKeyFile, tgasText, topLevelNearId, txGasCap, txLink,
} from './near.mjs';
import { HL_API, brokerIdProblem } from './venues.mjs';

/** USDC on NEAR (native, Circle); balances.mjs has the same constant (a test compares). */
export const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export const WASM = join(ROOT, 'contract', 'target', 'near', 'gimbal.wasm');
const WASM_SHOWN = 'contract/target/near/gimbal.wasm';
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
  const contractKeyFile = join(KEYS, `${a.contract}.json`);
  // The contract account's only full-access key is never written into a linked worktree (deleted with it).
  if (a.send) assertNotInLinkedWorktree(contractKeyFile, 'the contract account\'s key');
  const tree = linkedWorktreeOf(contractKeyFile);
  say(`files     ${a.send ? '' : '--send '}writes the contract account's key to ${contractKeyFile}`);
  if (tree !== null) say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);

  if (!existsSync(WASM)) throw new Error(`${WASM_SHOWN} is missing: cd contract && cargo near build non-reproducible-wasm --no-abi`);
  const wasm = readFileSync(WASM);
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
  const env = envValues(['ORDERLY_BROKER_ID', ...Object.values(REFERRAL_ENV)]);
  for (const line of envReport(env)) say(line);
  const broker = env.get('ORDERLY_BROKER_ID');
  if (broker.value === null) throw new Error('ORDERLY_BROKER_ID is empty: the mainnet broker id goes into new() and can never change');
  const brokerProblem = brokerIdProblem(broker.value);
  if (brokerProblem !== null) throw new Error(`${brokerProblem}; new() would fix it for the contract's life`);
  const codes = referralCodes(env);
  const init = initArgs({ treasuryNear: a.treasuryNear, hlBuilder: a.hlBuilder, codes, brokerId: broker.value });

  const status = await near.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  for (const id of [MPC, ORACLE]) if ((await near.account(id)) === null) throw new Error(`${id} does not exist on this chain`);
  if ((await near.account(a.treasuryNear)) === null) throw new Error(`--treasury-near ${a.treasuryNear} does not exist on mainnet: the performance fee would have nowhere to go`);
  say(`accounts  ${MPC}, ${ORACLE} and the treasury ${a.treasuryNear} exist`);
  // withdraw_to_owner sends the performance fee with ft_transfer: to a treasury USDC does not know, every fee
  // transfer fails and the fee stays in the desk's idle USDC, due again at the next payout.
  const treasuryOnUsdc = await near.view(NEAR_USDC, 'storage_balance_of', { account_id: a.treasuryNear });
  say(`treasury  ${treasuryUsdcLine(a.treasuryNear, treasuryOnUsdc)}`);

  const state = await near.account(a.contract);
  if (state !== null && !a.resume) {
    const free = await nextFreeName(a.contract, async (id) => (await near.account(id)) !== null);
    throw new Error(`${a.contract} exists already: a canary is never redeployed or migrated, it takes a fresh account. `
      + `${free === null ? 'No free name found after it' : `The first free name after it is ${free}`} (or an earlier --send whose tx 2 failed? see --resume)`);
  }
  let keyVerdict = null;
  if (state !== null && a.resume && existsSync(contractKeyFile)) {
    keyVerdict = fullAccessVerdict(await near.accessKey(a.contract, readKeyFile(contractKeyFile, a.contract).publicKeyString));
  }
  const plan = deployPlanFor(state, { resume: a.resume, keyVerdict });
  say(`contract  ${a.contract}: ${state === null
    ? 'does not exist: the name is free (a new account, as it must be)'
    : `exists without code, ${nearText(BigInt(state.amount), 4)} NEAR; ${contractKeyFile} ${keyVerdict}`}`);
  if (plan === 'both' && existsSync(contractKeyFile)) {
    const msg = `${contractKeyFile} exists but the account does not: move it away or pick another name`;
    if (a.send) throw new Error(msg);
    say(`warning   ${msg} (--send refuses)`);
  }

  const gasPrice = BigInt((await near.rpc('gas_price', [null])).gas_price);
  const fees = await near.fees();
  let funder = null;
  let verdict = null;
  let funderShort = null;
  if (plan === 'both') {
    funder = await near.account(a.funder);
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
    if (a.keyFile !== null) verdict = fullAccessVerdict(await near.accessKey(a.funder, readKeyFile(a.keyFile, a.funder).publicKeyString));
    say(`key       --key-file: ${verdict ?? 'check skipped (no --key-file)'}`);
    if (a.send && verdict !== 'matches') throw new Error('--send needs --key-file holding a full-access key of the funder');
  }

  const builderUsd = await builderPerpsUsd(a.hlBuilder);
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
    say('check them now. Add --send (and --key-file) to send tx 1, then tx 2, from the main checkout.');
    if (funderShort !== null) throw new Error(`${funderShort} (the plan above is complete; send the funder NEAR first, e.g. by retiring the old canary)`);
    return;
  }

  if (plan === 'both') {
    const funderKey = readKeyFile(a.keyFile, a.funder);
    const publicKey = newKeyFile(contractKeyFile, a.contract);
    say(`\nnew key   ${publicKey} written to ${contractKeyFile}`);
    const out1 = await near.send(funderKey, REGISTRAR, tx1Actions(publicKey), { onSent: (h) => say(`tx 1 sent ${h}; waiting for final`) });
    if (out1.failure !== null || out1.value !== true) {
      throw new Error(`tx 1 ${out1.hash}: ${out1.failure !== null ? panicOf(out1.failure) : `create_account returned ${JSON.stringify(out1.value)}`} `
        + `(${txLink(out1.hash)}); near refunds the deposit when it does not create the account`);
    }
    say(`tx 1 final: ${txLink(out1.hash)} (${out1.burntTgas} TGas, ${nearText(out1.burntYocto, 6)} NEAR burnt)`);
    if (fullAccessVerdict(await near.accessKey(a.contract, publicKey)) !== 'matches') {
      throw new Error(`${a.contract} has no full-access key ${publicKey} after tx 1: look at ${accountLink(a.contract)}`);
    }
    say(`back up   ${contractKeyFile} now: it is ${a.contract}'s only key, and nothing else can sign for the account`);
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
