#!/usr/bin/env node
// Creates the canary desk on a mainnet deployment and gives the engine its operator key (tools/mainnet/README.md).
//
//   node tools/mainnet/desk.mjs <contract> <desk_id> --owner <account> --key-file <owner key json>
//        --policy <file> [--allowance <NEAR, default 5>] [--send]
//
// 1. create_desk(desk_id, policy, evm_address, solana), signed by the owner, with the addresses derived as
//    tools/testnet/desk.mjs derives them: the MPC contract's derived_public_key for gimbal/<desk_id>/evm (domain 0)
//    and gimbal/<desk_id>/sol (domain 1) with the contract as predecessor (this works before the desk, or even the
//    contract, exists), and the testnet script's storage deposit (0.5 NEAR; the excess is refunded).
// 2. AddKey on the owner's account: a new FunctionCall key for the engine, receiver = the contract, method_names =
//    the operator methods only, allowance --allowance. Generated into .keys/operator-<contract>.json; only its
//    public key is printed.
// 3. .keys/engine-mainnet-<contract>.env for the engine (never overwritten, no value printed).
//
// The policy is checked against live data first (Hyperliquid indices and szDecimals, Phoenix orderbooks, lots and
// ticks, Orderly symbols) and refused on any mismatch. Default: a dry run that reads mainnet and prints the planned
// transactions, the desk's addresses and their explorer links; it works without --key-file and against a contract
// that does not exist yet. --send: one transaction at a time, each waited for until final; it refuses to write the
// key and env files into a linked git worktree (its ignored files go with it), so run it from the main checkout.
// Every file written is printed with its absolute path. The contract's Orderly broker must be the engine's mainnet
// broker; ORDERLY_BROKER_ID, when set, must be the same and is printed in full.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { b58decode, evmAddress, keccak256, solanaAccounts } from '../testnet/near.mjs';
import { UsageError, envReport, envValues, isMain, parseFlags, run } from './cli.mjs';
import {
  KEYS, MPC, NO_CODE, ORACLE, PRIVATE_KEY_OF_FILE, YOCTO_PER_NEAR, accountLink, act, assertNotInLinkedWorktree, describeTx,
  freeBalance, fullAccessVerdict, isFunctionCallKey, linkedWorktreeOf, mainnetId, near, nearText, newKeyFile, panicOf, parseNear,
  nearTextUp, readKeyFile, tgasText, txGasCap, txLink, writeEnvFile,
} from './near.mjs';
import {
  HL_API, MAINNET_ORDERLY_BROKER, ORDERLY_API, PHOENIX_API, brokerIdProblem, livePolicyProblems, policyShapeProblems, readLive,
} from './venues.mjs';

/**
 * The operator methods, the engine key's whole allowlist: every method with a mark in the Operator column of the
 * table in docs/interfaces.md §1.3, in the table's order. That is the 18 rows with a ✓, and `set_paused` ("pause
 * only": the engine pauses a desk; unpausing needs 1 yoctoNEAR, which a FunctionCall key cannot attach). The same
 * list as web/src/onboarding/operator.ts; a test reads the table and compares.
 */
export const OPERATOR_METHODS = [
  'set_paused',
  'fund_venue',
  'hl_approve_builder_fee',
  'hl_set_referrer',
  'hl_withdraw',
  'refresh_prices',
  'hl_order',
  'hl_cancel',
  'hl_usd_class_transfer',
  'hl_send_to_intents',
  'sol_sign',
  'sol_sign_register',
  'sol_sign_rescue',
  'orderly_register',
  'orderly_add_key',
  'orderly_request',
  'orderly_ws_auth',
  'orderly_settle_pnl',
  'orderly_withdraw',
  'evm_usdc_to_intents',
  'panic_close',
];

/** tools/testnet/desk.mjs's storage deposit; create_desk refunds what the desk does not take. */
export const CREATE_DESK_DEPOSIT = YOCTO_PER_NEAR / 2n;
const CREATE_DESK_TGAS = 150n;
/** Over the deposit: the two transactions' gas and the new key's storage on the owner's account. */
export const OWNER_MARGIN = YOCTO_PER_NEAR / 5n;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PHUSD_MINT = 'PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A';
export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

const USAGE = `usage: node tools/mainnet/desk.mjs <contract> <desk_id> --owner <account> --key-file <owner key json>
         --policy <file> [--allowance <NEAR, default 5>] [--send]
  default: dry run (reads mainnet, prints the transactions; --key-file optional)`;

const SPEC = { '--owner': 'value', '--key-file': 'value', '--policy': 'value', '--allowance': 'value', '--send': 'switch' };

export const operatorKeyFile = (contract) => join(KEYS, `operator-${contract}.json`);
export const engineEnvFile = (contract) => join(KEYS, `engine-mainnet-${contract}.env`);

/** The command line, checked: mainnet ids, a desk id create_desk takes, an owner the contract allows. */
export function parseDeskArgs(argv) {
  const { positional, values } = parseFlags(argv, SPEC);
  if (positional.length < 2) throw new UsageError('the contract and the desk id are required');
  if (positional.length > 2) throw new UsageError(`unexpected argument ${positional[2]}`);
  const [contract, deskId] = positional;
  for (const f of ['--owner', '--policy']) if (values[f] === undefined) throw new UsageError(`${f} is required`);
  const asUsage = (fn) => {
    try {
      return fn();
    } catch (e) {
      throw new UsageError(e.message);
    }
  };
  asUsage(() => mainnetId(contract, 'contract'));
  if (!/^[a-z0-9-]{1,32}$/.test(deskId)) throw new UsageError(`desk id ${JSON.stringify(deskId)} is not 1 to 32 characters of a-z, 0-9 and -`);
  const owner = asUsage(() => mainnetId(values['--owner'], '--owner'));
  if ([contract, MPC, ORACLE].includes(owner)) throw new UsageError(`--owner cannot be ${owner}: the contract refuses the contract itself, the MPC contract and the oracle`);
  const allowance = asUsage(() => parseNear(values['--allowance'] ?? '5', '--allowance'));
  if (allowance === 0n) throw new UsageError('--allowance must be above 0');
  const send = values['--send'] === true;
  if (send && values['--key-file'] === undefined) throw new UsageError('--send needs --key-file: the owner signs both transactions');
  return { contract, deskId, owner, keyFile: values['--key-file'] ?? null, policyFile: values['--policy'], allowance, send };
}

/** The desk's addresses as create_desk expects them, from the MPC contract's derived keys (as tools/testnet/desk.mjs). */
export async function deskAddresses(client, contractId, deskId) {
  const evmKey = await client.view(MPC, 'derived_public_key', { path: `gimbal/${deskId}/evm`, predecessor: contractId, domain_id: 0 });
  const solKey = await client.view(MPC, 'derived_public_key', { path: `gimbal/${deskId}/sol`, predecessor: contractId, domain_id: 1 });
  const evm = b58decode(evmKey.replace(/^secp256k1:/, ''));
  if (evm.length !== 64) throw new Error('the EVM key is not 64 bytes');
  const authority = solKey.replace(/^ed25519:/, '');
  return { evm_address: evmAddress(evm), solana: solanaAccounts(authority, USDC_MINT, PHUSD_MINT) };
}

/** Orderly's account id: keccak256(abi.encode(address, keccak256(broker_id))), as the contract computes it. */
export function orderlyAccountId(evm, brokerId) {
  const buf = Buffer.alloc(64);
  Buffer.from(evm.slice(2), 'hex').copy(buf, 12);
  keccak256(Buffer.from(brokerId, 'utf8')).copy(buf, 32);
  return `0x${keccak256(buf).toString('hex')}`;
}

/** Where config() is not a mainnet canary's: network, MPC, oracle, Arbitrum chain, broker. [] when none. */
export function contractConfigProblems(config) {
  const out = [];
  if (config?.network !== 'Mainnet') out.push(`network is ${JSON.stringify(config?.network)}, not Mainnet`);
  if (config?.mpc !== MPC) out.push(`mpc is ${JSON.stringify(config?.mpc)}, not ${MPC}`);
  if (config?.price_source?.OutLayer?.contract !== ORACLE) out.push(`price_source is ${JSON.stringify(config?.price_source)}, not OutLayer ${ORACLE}`);
  if (config?.orderly?.chain_id !== 42161) out.push(`orderly.chain_id is ${JSON.stringify(config?.orderly?.chain_id)}, not 42161`);
  if (typeof config?.orderly?.broker_id !== 'string' || config.orderly.broker_id === '') out.push('orderly.broker_id is empty');
  else if (brokerIdProblem(config.orderly.broker_id) !== null) out.push(`orderly.broker_id ${JSON.stringify(config.orderly.broker_id)} is not the engine's mainnet broker ${MAINNET_ORDERLY_BROKER}`);
  return out;
}

/** 'add' when the operator key is not on the owner's account; 'on chain' when it is, exactly; refused otherwise. */
export function operatorKeyPlan(view, contract) {
  if (view === null || view === undefined) return 'add';
  if (isFunctionCallKey(view, contract, OPERATOR_METHODS)) return 'on chain';
  throw new Error(`the operator key is on the owner's account with another permission (${JSON.stringify(view.permission)}): delete that key first`);
}

/** The engine's environment for this desk; OPERATOR_PRIVATE_KEY comes from the operator key file. */
export function engineEnvEntries({ contract, deskId, owner, allowance, brokerId }) {
  return [
    ['GIMBAL_MODE', 'mainnet'],
    ['NEAR_NETWORK', 'mainnet'],
    ['GIMBAL_CONTRACT_ID', contract],
    ['DESK_ID', deskId],
    ['OWNER_ACCOUNT_ID', owner],
    ['OPERATOR_ACCOUNT_ID', ''],
    ['OPERATOR_PRIVATE_KEY', PRIVATE_KEY_OF_FILE],
    ['OPERATOR_ALLOWANCE_NEAR', nearText(allowance)],
    ['ORDERLY_BROKER_ID', brokerId],
    ['HL_API_URL', HL_API],
    ['ORDERLY_API_URL', ORDERLY_API],
    ['PHOENIX_API_URL', PHOENIX_API],
    ['SOLANA_RPC_URL', SOLANA_RPC],
  ];
}

/** The desk's venue addresses with explorer links, as lines. */
export function addressLines(addr, orderlyId, brokerId) {
  const s = addr.solana;
  return [
    `  EVM address        ${addr.evm_address}`,
    `                     https://app.hyperliquid.xyz/explorer/address/${addr.evm_address}`,
    `                     https://arbiscan.io/address/${addr.evm_address}`,
    `  Solana authority   ${s.authority}  https://solscan.io/account/${s.authority}`,
    `  USDC ATA           ${s.usdc_ata}  https://solscan.io/account/${s.usdc_ata}`,
    `  PhUSD ATA          ${s.phusd_ata}  https://solscan.io/account/${s.phusd_ata}`,
    `  Phoenix trader     ${s.phoenix_trader}  https://solscan.io/account/${s.phoenix_trader}`,
    orderlyId === null
      ? '  Orderly account    needs the broker id (config() once deployed, or ORDERLY_BROKER_ID)'
      : `  Orderly account    ${orderlyId}\n                     ${ORDERLY_API}/v1/get_account?address=${addr.evm_address}&broker_id=${brokerId} (answers once registered)`,
  ];
}

async function main() {
  const a = parseDeskArgs(process.argv.slice(2));
  const say = (s = '') => console.log(s);
  say(`gimbal mainnet desk ${a.deskId} on ${a.contract}: ${a.send ? 'SEND' : 'dry run'}`);
  const opFile = operatorKeyFile(a.contract);
  const opShown = opFile;
  const envFile = engineEnvFile(a.contract);
  const envShown = envFile;
  // The operator key and the engine env file are never written into a linked worktree (deleted with it).
  if (a.send) {
    assertNotInLinkedWorktree(opFile, 'the operator key');
    assertNotInLinkedWorktree(envFile, 'the engine env file');
  }
  const tree = linkedWorktreeOf(opFile);
  if (tree !== null) say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);

  let policy;
  try {
    policy = JSON.parse(readFileSync(a.policyFile, 'utf8'));
  } catch (e) {
    throw new Error(`--policy ${a.policyFile}: not a readable JSON file (${e.code ?? 'not JSON'})`);
  }
  const shape = policyShapeProblems(policy);
  if (shape.length > 0) throw new Error(`--policy ${a.policyFile} is not a valid policy:\n  ${shape.join('\n  ')}`);
  const live = await readLive();
  const mismatch = livePolicyProblems(policy, live);
  if (mismatch.length > 0) throw new Error(`--policy ${a.policyFile} does not match live mainnet data:\n  ${mismatch.join('\n  ')}`);
  say(`policy    ${a.policyFile}: ${policy.hl_assets.length} Hyperliquid assets, ${policy.phoenix_markets.length} Phoenix markets, `
    + `${policy.orderly_symbols.length} Orderly symbols; matches live Hyperliquid, Phoenix and Orderly data`);
  say(`          ${policy.max_notional_usd} USD per leg, band ${policy.price_band_bps} bps, oracle age ${policy.oracle_max_age_s} s, `
    + `rescue cap ${policy.rescue_cap_usd_per_hour} USD per hour, ${policy.unpriced.length} unpriced`);

  const status = await near.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  // The broker id is public (config() once deployed): printed in full, with a warning when the shell set it.
  const brokerEnv = envValues(['ORDERLY_BROKER_ID']);
  for (const line of envReport(brokerEnv)) say(line);
  const envBroker = brokerEnv.get('ORDERLY_BROKER_ID');
  if (envBroker.value !== null && brokerIdProblem(envBroker.value) !== null) throw new Error(brokerIdProblem(envBroker.value));
  const contractState = await near.account(a.contract);
  let brokerId = null;
  let desk = null;
  if (contractState === null) {
    if (a.send) throw new Error(`${a.contract} does not exist: deploy it first (tools/mainnet/deploy.mjs)`);
    brokerId = envBroker.value;
    say(`contract  ${a.contract}: does not exist yet, so config() and get_desk are not checked (--send refuses until it does)`);
  } else {
    if (contractState.code_hash === NO_CODE) throw new Error(`${a.contract} has no contract code`);
    const config = await near.view(a.contract, 'config');
    const bad = contractConfigProblems(config);
    if (bad.length > 0) throw new Error(`${a.contract} is not a mainnet Gimbal contract:\n  ${bad.join('\n  ')}`);
    brokerId = config.orderly.broker_id;
    if (envBroker.value !== null && envBroker.value !== brokerId) {
      throw new Error(`ORDERLY_BROKER_ID ${JSON.stringify(envBroker.value)} (from ${envBroker.from}) is not the contract's broker id ${JSON.stringify(brokerId)}`);
    }
    say(`contract  ${a.contract}: version ${JSON.stringify(await near.view(a.contract, 'version'))}, Mainnet, MPC ${config.mpc}, `
      + `OutLayer ${config.price_source.OutLayer.contract}, Orderly broker ${JSON.stringify(brokerId)} on chain ${config.orderly.chain_id}`);
    desk = await near.view(a.contract, 'get_desk', { desk_id: a.deskId });
    if (desk !== null && desk.owner !== a.owner) throw new Error(`desk ${a.deskId} exists and belongs to ${desk.owner}, not ${a.owner}`);
    if (desk !== null) say(`desk      ${a.deskId} exists already, owned by ${a.owner}: create_desk is skipped`);
  }

  const addr = await deskAddresses(near, a.contract, a.deskId);
  if (desk !== null && (desk.evm_address !== addr.evm_address || JSON.stringify(desk.solana) !== JSON.stringify(addr.solana))) {
    throw new Error(`desk ${a.deskId}'s stored addresses are not the MPC-derived ones: stop and compare get_desk with ${MPC}`);
  }
  const orderlyId = brokerId === null ? null : orderlyAccountId(addr.evm_address, brokerId);
  if (desk !== null && desk.orderly_account_id !== orderlyId) throw new Error(`get_desk's orderly_account_id ${desk.orderly_account_id} is not ${orderlyId}`);

  const owner = await near.account(a.owner);
  if (owner === null) throw new Error(`--owner ${a.owner} does not exist on mainnet`);
  const free = freeBalance(owner);
  say(`owner     ${a.owner}: ${nearText(BigInt(owner.amount), 4)} NEAR, ${nearText(free, 4)} free to spend`);
  if (desk === null && free < CREATE_DESK_DEPOSIT + OWNER_MARGIN) {
    throw new Error(`the owner can spend ${nearText(free, 4)} NEAR; create_desk needs ${nearText(CREATE_DESK_DEPOSIT + OWNER_MARGIN, 4)} (the deposit + 0.2 NEAR)`);
  }
  let verdict = null;
  if (a.keyFile !== null) verdict = fullAccessVerdict(await near.accessKey(a.owner, readKeyFile(a.keyFile, a.owner).publicKeyString));
  say(`key       --key-file: ${verdict ?? 'check skipped (no --key-file)'}`);
  if (a.send && verdict !== 'matches') throw new Error('--send needs --key-file holding a full-access key of the owner');

  let opKey = null;
  let opPlan = 'add';
  if (existsSync(opFile)) {
    opKey = readKeyFile(opFile, a.owner).publicKeyString;
    opPlan = operatorKeyPlan(await near.accessKey(a.owner, opKey), a.contract);
    say(`operator  ${opShown} exists (${opKey}): ${opPlan === 'on chain' ? 'on chain with exactly the operator methods, AddKey is skipped' : 'not on chain yet, AddKey adds it'}`);
  } else {
    say(`operator  a new key; --send writes it to ${opShown}`);
  }
  const envExists = existsSync(envFile);
  if (desk !== null && opPlan === 'on chain' && envExists) {
    say(`engine    ${envShown} exists`);
    say('\nnothing to send: the desk, its operator key and the engine env file are all in place.');
    say(addressLines(addr, orderlyId, brokerId).join('\n'));
    return;
  }
  if (envExists) {
    const msg = `${envShown} exists and is never overwritten: move it away first`;
    if (a.send) throw new Error(msg);
    say(`warning   ${msg} (--send refuses)`);
  }

  const signedBy = a.keyFile === null ? 'the owner\'s key; not checked without --key-file' : `--key-file, ${verdict}`;
  const createActions = [act.call('create_desk', { desk_id: a.deskId, policy, evm_address: addr.evm_address, solana: addr.solana }, CREATE_DESK_TGAS, CREATE_DESK_DEPOSIT)];
  const keyActions = (publicKey) => [act.functionCallKey(publicKey, a.contract, OPERATOR_METHODS, a.allowance)];
  const gasPrice = BigInt((await near.rpc('gas_price', [null])).gas_price);
  const fees = await near.fees();
  // The most gas each can burn (prepaid gas plus the action fees, from the live runtime config).
  const createCap = txGasCap(fees, { signer: a.owner, receiver: a.contract, actions: createActions });
  const keyCap = txGasCap(fees, { signer: a.owner, receiver: a.owner, actions: keyActions(`ed25519:${'1'.repeat(44)}`) });
  say();
  let n = 0;
  if (desk === null) say(describeTx(`tx ${++n}: create the desk`, { signer: a.owner, signedBy, receiver: a.contract, actions: createActions }).join('\n'));
  if (opPlan === 'add') {
    say(describeTx(`tx ${++n}: add the engine's operator key`, {
      signer: a.owner, signedBy, receiver: a.owner, actions: keyActions(opKey ?? `ed25519:<new key; --send writes it to ${opShown}>`),
    }).join('\n'));
  }
  say(`gas       ${desk === null ? `create_desk at most ${tgasText(createCap.total)} TGas (${tgasText(createCap.prepaid)} prepaid + ${tgasText(createCap.fees)} action fees)` : ''}`
    + `${desk === null && opPlan === 'add' ? '; ' : ''}${opPlan === 'add' ? `AddKey at most ${tgasText(keyCap.total)} TGas (action fees only)` : ''}`);

  say('\nbalances (NEAR)');
  const before = BigInt(owner.amount);
  const createGas = desk === null ? createCap.total * gasPrice : 0n;
  const keyGas = opPlan === 'add' ? keyCap.total * gasPrice : 0n;
  say(`  ${a.owner}: ${nearText(before, 4)} now; ${desk === null ? `at least ${nearText(before - CREATE_DESK_DEPOSIT - createGas, 4)} right after create_desk `
    + `(${nearText(CREATE_DESK_DEPOSIT)} deposit, the storage the desk does not take comes back; gas at most ${nearTextUp(createGas, 4)}, mostly refunded); ` : ''}`
    + `${opPlan === 'add' ? `AddKey burns at most ${nearTextUp(keyGas, 4)} and holds a few hundred bytes of storage on the account` : ''}`);
  say(`  the operator key may spend at most ${nearText(a.allowance)} NEAR of the owner's balance on gas (its allowance); `
    + 'keep 0.3 NEAR free per signature in flight');

  say(`\ndesk ${a.deskId} addresses (MPC ${MPC}, predecessor ${a.contract})`);
  say(addressLines(addr, orderlyId, brokerId).join('\n'));
  say(`\nengine    ${a.send ? '' : '--send writes '}${envShown}: ${engineEnvEntries({ contract: a.contract, deskId: a.deskId, owner: a.owner, allowance: a.allowance, brokerId: brokerId ?? '' })
    .map(([k]) => k).join(', ')} (values not shown)`);

  if (!a.send) {
    say(`\ndry run: nothing was signed, sent or written. Add --send (and --key-file) to send ${n === 2 ? 'both transactions' : 'the transaction'} above, one at a time,`);
    say('from the main checkout.');
    return;
  }

  const ownerKey = readKeyFile(a.keyFile, a.owner);
  if (desk === null) {
    // The venues' lists again, right before the policy is signed into the desk.
    const again = livePolicyProblems(policy, await readLive());
    if (again.length > 0) throw new Error(`the policy no longer matches live data:\n  ${again.join('\n  ')}`);
    const out = await near.send(ownerKey, a.contract, createActions, { onSent: (h) => say(`\ncreate_desk sent ${h}; waiting for final`) });
    if (out.failure !== null || out.value !== true) {
      throw new Error(`create_desk ${out.hash}: ${out.failure !== null ? panicOf(out.failure) : `returned ${JSON.stringify(out.value)}`} (${txLink(out.hash)})`);
    }
    say(`create_desk final: ${txLink(out.hash)} (${out.burntTgas} TGas, ${nearText(out.burntYocto, 6)} NEAR burnt)`);
    for (const log of out.logs) say(`  log ${log}`);
    desk = await near.view(a.contract, 'get_desk', { desk_id: a.deskId });
    // Desk ids are global: another owner could have taken this one between the call and its callback.
    if (desk === null || desk.owner !== a.owner) throw new Error(`get_desk(${a.deskId}) is not owned by ${a.owner} after create_desk: do not fund it`);
  }
  if (opPlan === 'add') {
    opKey ??= newKeyFile(opFile, a.owner);
    say(`\noperator  ${opKey}, key file ${opShown}`);
    const out = await near.send(ownerKey, a.owner, keyActions(opKey), { onSent: (h) => say(`AddKey sent ${h}; waiting for final`) });
    if (out.failure !== null) throw new Error(`AddKey ${out.hash}: ${panicOf(out.failure)} (${txLink(out.hash)})`);
    say(`AddKey final: ${txLink(out.hash)} (${out.burntTgas} TGas, ${nearText(out.burntYocto, 6)} NEAR burnt)`);
    const view = await near.accessKey(a.owner, opKey);
    if (!isFunctionCallKey(view, a.contract, OPERATOR_METHODS)) {
      throw new Error(`the key on ${a.owner} is not the operator key it should be (${JSON.stringify(view?.permission)}): delete it at once`);
    }
    say(`operator key on chain: FunctionCall, receiver ${a.contract}, ${OPERATOR_METHODS.length} methods, allowance ${nearText(BigInt(view.permission.FunctionCall.allowance))} NEAR`);
  }
  writeEnvFile(envFile, [
    `Gimbal engine, mainnet: ${a.contract}, desk ${a.deskId}. Written by tools/mainnet/desk.mjs; never commit.`,
    `node --env-file=.keys/engine-mainnet-${a.contract}.env engine/src/cli/serve.ts`,
  ], engineEnvEntries({ contract: a.contract, deskId: a.deskId, owner: a.owner, allowance: a.allowance, brokerId }), { keyFile: opFile, accountId: a.owner });
  say(`wrote ${envShown} (values not shown)`);
  say(`\ndesk ${a.deskId}: owner ${desk.owner}, paused ${desk.paused}, ${accountLink(a.contract)}`);
  say(addressLines({ evm_address: desk.evm_address, solana: desk.solana }, desk.orderly_account_id, brokerId).join('\n'));
}

if (isMain(import.meta.url)) await run(main, USAGE);
