#!/usr/bin/env node
// Creates a test desk on a testnet deployment from the owner account, with tools/testnet-policy.json.
//
//   node tools/testnet/desk.mjs <contract> <desk_id> [--owner <owner>.testnet] [--policy <file>]
//
// The desk's addresses are derived the way create_desk checks them: the MPC contract's
// derived_public_key for gimbal/<desk_id>/evm (domain 0) and gimbal/<desk_id>/sol (domain 1),
// with the Gimbal contract as predecessor. Prints the desk's ids; no key value is printed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, YOCTO_PER_NEAR, actions, b58decode, evmAddress, loadKey, panicOf, send, solanaAccounts, view } from './near.mjs';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PHUSD_MINT = 'PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A';

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const [contract, deskId] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const owner = flag('--owner', 'gimbal-owner-fcf135.testnet');
const policy = JSON.parse(readFileSync(flag('--policy', join(ROOT, 'tools', 'testnet-policy.json')), 'utf8'));
if (!contract || !deskId) {
  console.error('usage: node tools/testnet/desk.mjs <contract> <desk_id> [--owner <account>] [--policy <file>]');
  process.exit(2);
}

const { mpc } = await view(contract, 'config');

/** The desk's addresses as create_desk expects them, from the MPC contract's derived keys. */
export async function deskAddresses(mpcId, contractId, id) {
  const evmKey = await view(mpcId, 'derived_public_key', { path: `gimbal/${id}/evm`, predecessor: contractId, domain_id: 0 });
  const solKey = await view(mpcId, 'derived_public_key', { path: `gimbal/${id}/sol`, predecessor: contractId, domain_id: 1 });
  const evm = b58decode(evmKey.replace(/^secp256k1:/, ''));
  if (evm.length !== 64) throw new Error('the EVM key is not 64 bytes');
  const authority = solKey.replace(/^ed25519:/, '');
  return { evm_address: evmAddress(evm), solana: solanaAccounts(authority, USDC_MINT, PHUSD_MINT) };
}

const existing = await view(contract, 'get_desk', { desk_id: deskId });
if (existing) {
  console.log(`desk ${deskId} exists already`);
} else {
  const { evm_address, solana } = await deskAddresses(mpc, contract, deskId);
  const key = loadKey(owner);
  // Storage is refunded beyond what the desk takes.
  const deposit = YOCTO_PER_NEAR / 2n;
  const out = await send(key, contract, [actions.call('create_desk', { desk_id: deskId, policy, evm_address, solana }, 150n, deposit)]);
  if (out.failure) throw new Error(`create_desk ${out.hash}: ${panicOf(out.failure)}`);
  console.log(`create_desk: tx ${out.hash} (${out.burntTgas} TGas) -> ${JSON.stringify(out.value)}`);
  for (const log of out.logs) console.log('  ', log);
}

const desk = await view(contract, 'get_desk', { desk_id: deskId });
if (desk.owner !== owner) throw new Error(`desk ${deskId} is owned by ${desk.owner}, not ${owner}`);
console.log(JSON.stringify({
  contract,
  desk_id: deskId,
  owner: desk.owner,
  evm_address: desk.evm_address,
  solana_authority: desk.solana.authority,
  orderly_account_id: desk.orderly_account_id,
  paused: desk.paused,
}, null, 2));
