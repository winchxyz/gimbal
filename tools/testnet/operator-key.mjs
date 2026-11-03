#!/usr/bin/env node
// Adds the engine's operator key to a testnet desk owner's account: a FunctionCall access key whose receiver is the
// gimbal contract and whose method_names are exactly the operator methods (tools/mainnet/desk.mjs OPERATOR_METHODS),
// with an allowance (default 1 NEAR). The private key is written to .keys/operator-<contract>.json, in the shape the
// MCP server and `npm run attack` read (account_id, public_key, private_key); only its public key is printed.
//
//   node tools/testnet/operator-key.mjs <contract> --owner <account>.testnet [--allowance <NEAR>] [--send]
//
// Default: a dry run. It reads the owner's access-key list, says whether the operator key is already on chain, and
// prints the planned AddKey. It signs and sends nothing and writes no file. --send adds the key (the owner's
// full-access key file must be in .keys/<owner>.json) and writes the operator key file. Testnet only: every account
// id must end in .testnet and the RPC must serve chain "testnet" (tools/testnet/near.mjs).
//
// It builds on the mainnet runbook's logic — OPERATOR_METHODS and operatorKeyPlan from tools/mainnet/desk.mjs,
// act.functionCallKey, encodeTransaction and isFunctionCallKey from tools/mainnet/near.mjs — so the key it adds is
// the same shape the mainnet deploy adds; only the RPC, signing and chain guard are testnet's.

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATOR_METHODS, operatorKeyPlan } from '../mainnet/desk.mjs';
import { act, encodeTransaction, isFunctionCallKey, nearText, YOCTO_PER_NEAR } from '../mainnet/near.mjs';
import { KEYS, b58decode, b58encode, loadKey, rpc, sha256, sleep, testnetId } from './near.mjs';

const say = (line = '') => console.log(line);

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--send') flags.send = true;
    else if (a === '--owner') flags.owner = argv[++i];
    else if (a === '--allowance') flags.allowance = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Error('give exactly one contract id');
  const contract = testnetId(positional[0], 'contract');
  if (flags.owner === undefined) throw new Error('--owner <account>.testnet is required');
  const owner = testnetId(flags.owner, '--owner');
  const allowanceNear = flags.allowance ?? '1';
  if (!/^\d+(\.\d+)?$/.test(allowanceNear) || Number(allowanceNear) <= 0) throw new Error('--allowance must be a number of NEAR above 0');
  const allowance = BigInt(Math.round(Number(allowanceNear) * 1e6)) * (YOCTO_PER_NEAR / 1_000_000n);
  return { contract, owner, allowance, allowanceNear, send: flags.send === true };
}

const operatorKeyFile = (contract) => join(KEYS, `operator-${contract}.json`);

/** Writes a new ed25519 operator key file (never over an existing one); returns its `ed25519:<base58>` public key. */
function writeOperatorKeyFile(file, accountId) {
  if (existsSync(file)) throw new Error(`${file} exists: a key file is never overwritten (move it away to rotate)`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const public_key = `ed25519:${b58encode(pub)}`;
  const private_key = `ed25519:${b58encode(Buffer.concat([seed, pub]))}`;
  mkdirSync(KEYS, { recursive: true });
  writeFileSync(file, JSON.stringify({ account_id: accountId, public_key, private_key, network: 'testnet' }) + '\n', { mode: 0o600, flag: 'wx' });
  return public_key;
}

async function accessKey(accountId, publicKey) {
  const r = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
  if (r.error) {
    if (/does not exist/i.test(r.error)) return null;
    throw new Error(`view_access_key ${accountId}: ${r.error}`);
  }
  return r;
}

async function main(argv) {
  const a = parse(argv);
  const file = operatorKeyFile(a.contract);
  say(`operator key for ${a.contract}, added to ${a.owner}`);
  say(`  receiver   ${a.contract}`);
  say(`  methods    ${OPERATOR_METHODS.length} operator methods`);
  say(`  allowance  ${a.allowanceNear} NEAR`);
  say(`  key file   ${file}`);
  say();

  // The owner must exist and hold a full-access key file to sign AddKey.
  let ownerKey = null;
  if (existsSync(join(KEYS, `${a.owner}.json`))) {
    ownerKey = loadKey(a.owner);
    say(`owner key    ${join(KEYS, `${a.owner}.json`)} (${ownerKey.publicKeyString})`);
  } else {
    say(`owner key    not in .keys/${a.owner}.json — needed for --send`);
  }

  // The operator key's current state on the owner's account (its public key is read from the file, no signing).
  let opPublic = null;
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (stored.account_id !== a.owner) throw new Error(`${file} is the key of ${JSON.stringify(stored.account_id)}, not ${a.owner}`);
    if (typeof stored.public_key !== 'string') throw new Error(`${file}: no public_key`);
    opPublic = stored.public_key;
  }
  if (opPublic !== null) {
    const view = await accessKey(a.owner, opPublic);
    const plan = operatorKeyPlan(view, a.contract);
    say(`operator key ${file} exists (${opPublic}): ${plan === 'on chain' ? 'already on chain with exactly the operator methods; nothing to add' : 'not on chain yet'}`);
    if (plan === 'on chain') return 0;
  } else {
    say('operator key a new key; --send generates it and writes the file');
  }

  // A read-only look at what keys the owner already has (the task's dry-run read).
  const list = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: a.owner });
  const keys = list.keys ?? [];
  say(`\n${a.owner} has ${keys.length} access key(s):`);
  for (const k of keys) {
    const fc = k.access_key?.permission?.FunctionCall;
    say(`  ${k.public_key}  ${fc ? `FunctionCall receiver ${fc.receiver_id}, ${(fc.method_names ?? []).length} methods` : 'FullAccess'}`
      + (fc && isFunctionCallKey(k.access_key, a.contract, OPERATOR_METHODS) ? '  <- an operator key for this contract' : ''));
  }

  const addKey = (publicKey) => [act.functionCallKey(publicKey, a.contract, OPERATOR_METHODS, a.allowance)];
  say('\nplanned transaction');
  say(`  signer    ${a.owner}`);
  say(`  receiver  ${a.owner} (AddKey on the owner's own account)`);
  say(`  action    AddKey ${opPublic ?? '<new key, written on --send>'}`);
  say(`            FunctionCall: receiver ${a.contract}, allowance ${nearText(a.allowance)} NEAR, ${OPERATOR_METHODS.length} methods`);
  say(`            method_names ${JSON.stringify(OPERATOR_METHODS)}`);

  if (!a.send) {
    say('\ndry run: nothing signed, sent or written. Add --send (with the owner key file in .keys/) to add the key.');
    return 0;
  }
  if (ownerKey === null) throw new Error(`--send needs the owner's full-access key file at ${join(KEYS, `${a.owner}.json`)}`);

  const opPublicKey = opPublic ?? writeOperatorKeyFile(file, a.owner);
  say(`\noperator key ${opPublicKey}, written to ${file}`);
  const access = await accessKey(a.owner, ownerKey.publicKeyString);
  if (access === null) throw new Error(`${ownerKey.publicKeyString} is not a key of ${a.owner}`);
  const tx = encodeTransaction({
    signerId: a.owner, publicKey: ownerKey.publicKey, nonce: BigInt(access.nonce) + 1n,
    receiverId: a.owner, blockHash: b58decode(access.block_hash), actions: addKey(opPublicKey),
  });
  const hash = sha256(tx);
  const signed = Buffer.concat([tx, Buffer.from([0]), ownerKey.sign(hash)]);
  const txHash = b58encode(hash);
  say(`AddKey sent ${txHash}; waiting for final`);
  let outcome = await rpc('send_tx', { signed_tx_base64: signed.toString('base64'), wait_until: 'FINAL' }, { once: true });
  for (let i = 0; (outcome?.final_execution_status !== 'FINAL' || !outcome.status) && i < 40; i++) {
    await sleep(3000);
    outcome = await rpc('tx', { tx_hash: txHash, sender_account_id: a.owner, wait_until: 'FINAL' });
  }
  if (outcome?.status?.Failure !== undefined) throw new Error(`AddKey ${txHash} failed: ${JSON.stringify(outcome.status.Failure).slice(0, 400)}`);
  const view = await accessKey(a.owner, opPublicKey);
  if (!isFunctionCallKey(view, a.contract, OPERATOR_METHODS)) throw new Error(`the key on ${a.owner} is not the operator key it should be (${JSON.stringify(view?.permission)}): delete it at once`);
  say(`AddKey final: https://testnet.nearblocks.io/txns/${txHash}`);
  say(`operator key on chain: FunctionCall, receiver ${a.contract}, ${OPERATOR_METHODS.length} methods, allowance ${nearText(a.allowance)} NEAR`);
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(`operator-key: ${err.message}`);
  process.exit(2);
});
