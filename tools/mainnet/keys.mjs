#!/usr/bin/env node
// Lists an account's access keys, and deletes one FunctionCall key from it (tools/mainnet/README.md, "Access keys"):
//
//   node tools/mainnet/keys.mjs list <account>
//   node tools/mainnet/keys.mjs delete <account> <public_key> --key-file <full-access key json of account> [--send]
//
// list only reads: every key with its permission, FullAccess or FunctionCall (receiver, whether that account still
// exists and has contract code, methods, allowance left). Public keys only; no private key is ever read for it. A
// retired canary's name can be registered again by anyone, so a key whose receiver "exists, no contract code" may
// point at a stranger's account.
//
// delete is a dry run by default: it reads mainnet, prints the DeleteKey transaction and signs nothing. It refuses
// a key the account does not have and a full-access key (only FunctionCall keys are deleted here, so the account
// keeps every full-access key it has). --send reads --key-file, only then, and refuses when it is not a full-access
// key of the account or when it is the key to delete; it refuses in a linked git worktree. Both commands end with
// one block to paste back.

import { UsageError, isMain, parseFlags, run } from './cli.mjs';
import { sendRefusal } from './checks.mjs';
import {
  MPC, NO_CODE, ROOT, accountLink, act, describeTx, freeBalance, fullAccessVerdict, isMainnetId, linkedWorktreeOf, mainnetId, near, nearText,
  nearTextUp, panicOf, publicKeyBytes, readKeyFile, tgasText, txGasCap, txLink,
} from './near.mjs';
import { summaryBlock } from './money.mjs';

export const COMMANDS = ['list', 'delete'];
const USAGE = `usage: node tools/mainnet/keys.mjs list <account>
       node tools/mainnet/keys.mjs delete <account> <public_key> --key-file <full-access key json of account> [--send]
  list: read only. delete: dry run by default (prints the DeleteKey transaction; no key read)`;
const SPEC = { '--key-file': 'value', '--send': 'switch' };

export function parseKeysArgs(argv) {
  const { positional, values } = parseFlags(argv, SPEC);
  const [command, account, publicKey, ...rest] = positional;
  if (!COMMANDS.includes(command)) throw new UsageError(`the command is one of ${COMMANDS.join(', ')}`);
  try {
    mainnetId(account, 'account');
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (command === 'list') {
    if (publicKey !== undefined) throw new UsageError(`unexpected argument ${publicKey}`);
    if (Object.keys(values).length > 0) throw new UsageError('list takes no options: it only reads');
    return { command, account, publicKey: null, keyFile: null, send: false };
  }
  if (publicKey === undefined) throw new UsageError('delete needs the public key to delete');
  if (rest.length > 0) throw new UsageError(`unexpected argument ${rest[0]}`);
  try {
    publicKeyBytes(publicKey);
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (values['--key-file'] === undefined) throw new UsageError('delete needs --key-file: a full-access key of the account signs the DeleteKey');
  return { command, account, publicKey, keyFile: values['--key-file'], send: values['--send'] === true };
}

/** A permission as one line: `FullAccess`, or the receiver, the methods and the allowance of a FunctionCall key. */
export function permissionText(permission, receiverNote = '') {
  if (permission === 'FullAccess') return 'FullAccess';
  const fc = permission?.FunctionCall;
  if (!fc) return `unknown permission ${JSON.stringify(permission)}`;
  const names = fc.method_names ?? [];
  const methods = names.length === 0 ? 'any method' : `${names.length} ${names.length === 1 ? 'method' : 'methods'} ${JSON.stringify(names)}`;
  const allowance = fc.allowance === null || fc.allowance === undefined ? 'no allowance limit' : `allowance ${nearText(fc.allowance)} NEAR left`;
  return `FunctionCall receiver ${fc.receiver_id}${receiverNote}, ${methods}, ${allowance}`;
}

/** Whether each FunctionCall key's receiver account exists, as a note: `(account exists)`, `(no such account)`. */
async function receiverNotes(client, keys) {
  const notes = new Map();
  for (const k of keys) {
    const r = k.access_key.permission?.FunctionCall?.receiver_id;
    if (r === undefined || notes.has(r)) continue;
    if (!isMainnetId(r) && r !== MPC) {
      notes.set(r, ' (not checked)');
      continue;
    }
    const state = await client.account(r);
    notes.set(r, state === null ? ' (no such account)' : state.code_hash === NO_CODE ? ' (account exists, no contract code)' : ' (account exists, has contract code)');
  }
  return notes;
}

const keyLine = (k, notes) => {
  const p = k.access_key.permission;
  return `${k.public_key}  ${permissionText(p, notes.get(p?.FunctionCall?.receiver_id) ?? '')}`;
};

/** Runs `list` or `delete`; deps: near, say, now, tree, readKey(file, accountId). Returns the summary block. */
export async function runKeys(argv, deps = {}) {
  const a = parseKeysArgs(argv);
  const client = deps.near ?? near;
  const say = deps.say ?? ((s = '') => console.log(s));
  const now = deps.now ?? Date.now;
  const tree = deps.tree === undefined ? linkedWorktreeOf(ROOT) : deps.tree;
  const refusal = sendRefusal(a.send, tree);
  if (refusal !== null) throw new Error(refusal);
  const at = () => new Date(now()).toISOString();

  say(`gimbal keys ${a.command} ${a.account}: ${a.command === 'list' ? 'read only' : a.send ? 'SEND' : 'dry run'}`);
  if (a.send === false && a.command === 'delete' && tree !== null) say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);
  const status = await client.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  const state = await client.account(a.account);
  if (state === null) throw new Error(`${a.account} does not exist on mainnet`);
  const keys = await client.accessKeys(a.account);
  const notes = await receiverNotes(client, keys);
  const full = keys.filter((k) => k.access_key.permission === 'FullAccess').length;
  say(`account   ${a.account}: ${nearText(freeBalance(state), 4)} NEAR free; ${keys.length} ${keys.length === 1 ? 'key' : 'keys'}, `
    + `${full} full access, ${keys.length - full} function call (${accountLink(a.account)})`);
  for (const k of keys) say(`key       ${keyLine(k, notes)}`);

  if (a.command === 'list') {
    const block = summaryBlock('keys', { at: at(), lines: [`account ${a.account}, list (read only)`, ...keys.map((k) => `key:     ${keyLine(k, notes)}`)] });
    say();
    say(block.join('\n'));
    return block;
  }

  const target = keys.find((k) => k.public_key === a.publicKey);
  if (target === undefined) throw new Error(`${a.account} has no key ${a.publicKey}: nothing to delete`);
  if (target.access_key.permission === 'FullAccess') {
    throw new Error(`${a.publicKey} is a full-access key of ${a.account}: this script deletes FunctionCall keys only`);
  }
  say(`delete    ${keyLine(target, notes)}`);

  let signer = null;
  let signedBy = `--key-file ${a.keyFile}, read at --send; it must be a full-access key of ${a.account}`;
  if (a.send) {
    signer = (deps.readKey ?? readKeyFile)(a.keyFile, a.account);
    if (signer.publicKeyString === a.publicKey) throw new Error(`--key-file is the key to delete: a key does not delete itself here; nothing was signed`);
    if (fullAccessVerdict(await client.accessKey(a.account, signer.publicKeyString)) !== 'matches') {
      throw new Error(`--key-file is not a full-access key of ${a.account}: nothing was signed`);
    }
    signedBy = `--key-file, a full-access key of ${a.account}`;
  }
  const actions = [act.deleteKey(a.publicKey)];
  const fees = await client.fees();
  const gasPrice = BigInt((await client.rpc('gas_price', [null])).gas_price);
  const cap = txGasCap(fees, { signer: a.account, receiver: a.account, actions });
  const cost = cap.total * gasPrice;
  say();
  say(describeTx('tx: delete one access key', { signer: a.account, signedBy, receiver: a.account, actions }).join('\n'));
  say(`  gas       at most ${tgasText(cap.total)} TGas of action fees, ${nearTextUp(cost, 6)} NEAR at ${gasPrice} yocto/gas; no deposit; `
    + 'the key\'s storage stake is freed');
  if (freeBalance(state) < cost) throw new Error(`${a.account} can spend ${nearText(freeBalance(state), 6)} NEAR; the DeleteKey can cost ${nearTextUp(cost, 6)}`);

  const head = `account ${a.account}, delete ${a.publicKey}, ${a.send ? 'SEND' : 'dry run'}`;
  if (!a.send) {
    const block = summaryBlock('keys', {
      at: at(),
      lines: [
        head,
        `key:     ${keyLine(target, notes)}`,
        `open:    the DeleteKey is not sent: run the same command with --send from the main checkout`,
      ],
    });
    say();
    say(block.join('\n'));
    say('\ndry run: nothing was signed or sent. Add --send, from the main checkout, to send it.');
    return block;
  }

  const out = await client.send(signer, a.account, actions, { onSent: (h) => say(`\ntx sent ${h}; waiting for final`) });
  say(`tx final: ${txLink(out.hash)} (${out.burntTgas} TGas, ${nearText(out.burntYocto, 6)} NEAR burnt)`);
  const after = await client.accessKey(a.account, a.publicKey);
  const lines = [head, `delete:  tx ${out.hash} ${out.failure === null ? 'succeeded' : `FAILED ${panicOf(out.failure)}`}`];
  lines.push(after === null ? `key:     ${a.publicKey} is no longer a key of ${a.account}` : `open:    ${a.publicKey} is still a key of ${a.account}: look up ${txLink(out.hash)}`);
  const block = summaryBlock('keys', { at: at(), lines });
  say();
  say(block.join('\n'));
  if (out.failure !== null) throw new Error(`DeleteKey ${out.hash}: ${panicOf(out.failure)} (${txLink(out.hash)})`);
  if (after !== null) throw new Error(`${a.publicKey} is still a key of ${a.account} after ${out.hash}`);
  return block;
}

if (isMain(import.meta.url)) await run(() => runKeys(process.argv.slice(2)), USAGE);
