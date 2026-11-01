#!/usr/bin/env node
// Retires a canary: DeleteAccount for the contract account, its whole NEAR balance to the account that created it
// (tools/mainnet/README.md, "Retiring a canary"):
//
//   node tools/mainnet/retire.mjs <contract> [--beneficiary <account>] [--desks <id,id>] [--key-file <contract key json>]
//        [--env-file <engine env file>] [--send]
//
// Why the checks: after the deletion anyone can register <contract> again, and every desk address is an MPC key
// derived from that name. Whoever holds the name then controls the desks' Hyperliquid, Solana, Arbitrum and Orderly
// accounts and the USDC on NEAR the account held. So nothing may be left on any of them, and nothing may be sent
// to them afterwards.
//
// The beneficiary is the signer of the transaction that created the account (nearblocks' account record, confirmed
// on an archival RPC), never a guess: --beneficiary must match it, and when the creation cannot be read the dry run
// says so and --send needs --beneficiary from the human. The desks are every create_desk the contract received
// (nearblocks), the creator's desks_of, and --desks; each that exists is checked:
//   Hyperliquid main perps dex account value and every spot balance; the Solana authority's SOL and its USDC and
//   PhUSD token accounts; USDC and ETH of the EVM address on Arbitrum; the Orderly account (public: registered, key;
//   the holding needs a signed read, so --send makes one orderly_request of kind holding with the engine's operator
//   key first, and nothing else); the desk's idle_usdc; and the contract's own USDC on NEAR.
// Anything over dust is refused, and so is a desk list that cannot be read in full.
//
// Default: a dry run that reads only. --send reads the contract's key file (and the engine env file for the
// Orderly read), only then, never prints a key, refuses in a linked git worktree, reads every balance again, and
// sends the DeleteAccount only when all of them are dust. It ends with one block to paste back.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError, isMain, parseDotEnv, parseFlags, run } from './cli.mjs';
import { arbitrumBalances, hyperliquidBalances, nearUsdcBalance, rpcUrls, solanaBalances, unitsText } from './balances.mjs';
import { engineEnvProblems, sendRefusal } from './checks.mjs';
import { OPERATOR_METHODS, contractConfigProblems, engineEnvFile } from './desk.mjs';
import {
  KEYS, ROOT, accountLink, act, createClient, describeTx, fullAccessVerdict, isFunctionCallKey, linkedWorktreeOf, mainnetId, near, nearText, nearTextUp,
  panicOf, readKeyFile, tgasText, txGasCap, txLink,
} from './near.mjs';
import { DESK_ID, ledgerOf, summaryBlock, usdcText } from './money.mjs';
import { ORDERLY_API } from './venues.mjs';

export const NEARBLOCKS_API = 'https://api.nearblocks.io/v1';
export const ARCHIVAL_RPC = 'https://archival-rpc.mainnet.fastnear.com';
/** What counts as nothing left. */
export const DUST = { usdcE6: 10_000n, lamports: 1_000_000n, wei: 100_000_000_000_000n };
/** NEAR's limit for DeleteAccount: the account's data besides its code, in bytes. */
export const MAX_DELETE_STATE = 10_000;

const USAGE = `usage: node tools/mainnet/retire.mjs <contract> [--beneficiary <account>] [--desks <id,id>] [--key-file <contract key json>]
         [--env-file <engine env file>] [--send]
  default: dry run (reads mainnet and the venues; signs nothing)`;
const SPEC = { '--beneficiary': 'value', '--desks': 'value', '--key-file': 'value', '--env-file': 'value', '--send': 'switch' };

export function parseRetireArgs(argv) {
  const { positional, values } = parseFlags(argv, SPEC);
  if (positional.length < 1) throw new UsageError('the contract account is required');
  if (positional.length > 1) throw new UsageError(`unexpected argument ${positional[1]}`);
  const [contract] = positional;
  let beneficiary = null;
  try {
    mainnetId(contract, 'contract');
    if (values['--beneficiary'] !== undefined) beneficiary = mainnetId(values['--beneficiary'], '--beneficiary');
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (beneficiary === contract) throw new UsageError('--beneficiary cannot be the account that is deleted');
  const desks = values['--desks'] === undefined ? [] : values['--desks'].split(',');
  for (const d of desks) if (!DESK_ID.test(d)) throw new UsageError(`desk id ${JSON.stringify(d)} is not 1 to 32 characters of a-z, 0-9 and -`);
  return {
    contract, beneficiary, desks, send: values['--send'] === true,
    keyFile: values['--key-file'] === undefined ? join(KEYS, `${contract}.json`) : resolve(values['--key-file']),
    envFile: values['--env-file'] === undefined ? engineEnvFile(contract) : resolve(values['--env-file']),
  };
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || json === null) throw new Error(`${new URL(url).host}${new URL(url).pathname}: HTTP ${res.status}`);
  return json;
}

/**
 * Who created `contract`: nearblocks' account record names the creating transaction, nearblocks' transaction its
 * signer; the archival RPC then confirms the transaction is a successful near.create_account of exactly this
 * account by that signer. Returns { creator, txHash, confirmed, note } (creator null when it cannot be read).
 */
export async function findCreator(fetchImpl, archive, contract) {
  let txHash;
  let creator;
  try {
    const acc = (await getJson(fetchImpl, `${NEARBLOCKS_API}/account/${contract}`)).account?.[0];
    txHash = acc?.created?.transaction_hash;
    if (typeof txHash !== 'string') return { creator: null, txHash: null, confirmed: false, note: 'nearblocks has no creation record' };
    const tx = (await getJson(fetchImpl, `${NEARBLOCKS_API}/txns/${txHash}`)).txns?.[0];
    creator = tx?.signer_account_id;
    if (typeof creator !== 'string') return { creator: null, txHash, confirmed: false, note: 'nearblocks has no signer for the creation' };
  } catch (e) {
    return { creator: null, txHash: txHash ?? null, confirmed: false, note: `nearblocks could not be read (${e.message})` };
  }
  try {
    const r = await archive.rpc('tx', { tx_hash: txHash, sender_account_id: creator, wait_until: 'NONE' });
    const t = r.transaction;
    const call = t?.actions?.[0]?.FunctionCall;
    const args = call ? JSON.parse(Buffer.from(call.args, 'base64').toString()) : null;
    const ok = t?.signer_id === creator && t?.receiver_id === 'near' && call?.method_name === 'create_account'
      && args?.new_account_id === contract && r.status?.SuccessValue !== undefined;
    if (!ok) return { creator: null, txHash, confirmed: false, note: `transaction ${txHash} is not a successful near.create_account of ${contract} by ${creator}` };
    return { creator, txHash, confirmed: true, note: `created by ${creator} in ${txLink(txHash)} (near.create_account, confirmed on ${new URL(ARCHIVAL_RPC).host})` };
  } catch (e) {
    return { creator, txHash, confirmed: false, note: `nearblocks says ${creator} created it in ${txHash}; the archival RPC could not confirm it (${e.message})` };
  }
}

/** The desk ids of every create_desk transaction nearblocks lists for the contract (all pages), or an error. */
export async function createDeskIds(fetchImpl, contract) {
  const ids = new Set();
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const url = `${NEARBLOCKS_API}/account/${contract}/txns?method=create_desk&per_page=25${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const r = await getJson(fetchImpl, url);
    for (const t of r.txns ?? []) {
      for (const a of t.actions ?? []) {
        if (a.method !== 'create_desk') continue;
        try {
          const id = JSON.parse(a.args)?.desk_id;
          if (typeof id === 'string') ids.add(id);
        } catch {
          throw new Error(`nearblocks: the args of create_desk in ${t.transaction_hash} are not JSON`);
        }
      }
    }
    if (!r.cursor || (r.txns ?? []).length === 0) return [...ids];
    cursor = r.cursor;
  }
  throw new Error('nearblocks: more than 40 pages of create_desk');
}

/** Orderly's public view of the desk: registered under the broker, and the desk key's state. */
async function orderlyPublic(fetchImpl, desk, brokerId) {
  const acc = await getJson(fetchImpl, `${ORDERLY_API}/v1/get_account?address=${desk.evm_address}&broker_id=${brokerId}`);
  if (!acc.success) return { registered: false, key: null };
  const key = await getJson(fetchImpl, `${ORDERLY_API}/v1/get_orderly_key?account_id=${desk.orderly_account_id}&orderly_key=ed25519:${desk.solana.authority}`);
  return { registered: true, key: key.success ? key.data?.key_status ?? null : null };
}

/** Every balance of one desk, as { lines, problems, orderlyRegistered }. `orderlyHolding` is the signed read (or null). */
export async function deskFindings({ fetchImpl, urls, desk, deskId, brokerId, orderlyHolding = null }) {
  const lines = [];
  const problems = [];
  const over = (what, v, dust, text) => {
    lines.push(`  ${what.padEnd(26)} ${text}`);
    if (v > dust) problems.push(`desk ${deskId}: ${what} holds ${text}`);
  };
  const read = async (what, fn) => {
    try {
      await fn();
    } catch (e) {
      lines.push(`  ${what.padEnd(26)} could not be read (${e.message})`);
      problems.push(`desk ${deskId}: ${what} could not be read`);
    }
  };
  await read('Hyperliquid', async () => {
    const hl = await hyperliquidBalances(fetchImpl, desk.evm_address);
    over('Hyperliquid perps value', hl.accountValueE6 < 0n ? -hl.accountValueE6 : hl.accountValueE6, DUST.usdcE6, `${usdcText(hl.accountValueE6)} USDC (withdrawable ${usdcText(hl.withdrawableE6)}, ${hl.positions} positions)`);
    if (hl.positions > 0) problems.push(`desk ${deskId}: ${hl.positions} open Hyperliquid position(s)`);
    if (hl.spot.length === 0) lines.push(`  ${'Hyperliquid spot'.padEnd(26)} no balances`);
    for (const b of hl.spot) {
      const tiny = Number(b.total) <= 0.01;
      lines.push(`  ${`Hyperliquid spot ${b.coin}`.padEnd(26)} ${b.total}`);
      if (!tiny) problems.push(`desk ${deskId}: Hyperliquid spot ${b.coin} holds ${b.total}`);
    }
  });
  await read('Solana', async () => {
    const s = await solanaBalances(fetchImpl, urls.solana, { authority: desk.solana.authority, tokenAccounts: { usdc: desk.solana.usdc_ata, phusd: desk.solana.phusd_ata } });
    over('Solana authority SOL', s.lamports, DUST.lamports, `${unitsText(s.lamports, 9)} SOL`);
    for (const [name, t] of Object.entries(s.tokens)) {
      over(`Solana ${name === 'usdc' ? 'USDC' : 'PhUSD'} token account`, t.amount, DUST.usdcE6, t.exists ? `${unitsText(t.amount, t.decimals)}` : 'none (never created)');
    }
  });
  await read('Arbitrum', async () => {
    const e = await arbitrumBalances(fetchImpl, urls.arbitrum, desk.evm_address);
    over('Arbitrum USDC', e.usdcE6, DUST.usdcE6, `${usdcText(e.usdcE6)} USDC`);
    over('Arbitrum ETH', e.wei, DUST.wei, `${unitsText(e.wei, 18)} ETH`);
  });
  let registered = null;
  await read('Orderly', async () => {
    const o = await orderlyPublic(fetchImpl, desk, brokerId);
    registered = o.registered;
    if (!o.registered) {
      lines.push(`  ${'Orderly'.padEnd(26)} not registered under ${brokerId}: no account, no holding`);
      return;
    }
    if (orderlyHolding === null) {
      lines.push(`  ${'Orderly'.padEnd(26)} registered (${desk.orderly_account_id}), key ${o.key ?? 'none'}; holding not public: --send reads it signed first`);
      return;
    }
    for (const h of orderlyHolding) {
      const total = Math.abs(Number(h.holding ?? 0)) + Math.abs(Number(h.frozen ?? 0)) + Math.abs(Number(h.pending_short ?? 0));
      lines.push(`  ${`Orderly ${h.token}`.padEnd(26)} holding ${h.holding}, frozen ${h.frozen ?? 0}, pending_short ${h.pending_short ?? 0}`);
      if (total > 0.01) problems.push(`desk ${deskId}: Orderly ${h.token} holds ${total}`);
    }
    if (orderlyHolding.length === 0) lines.push(`  ${'Orderly'.padEnd(26)} holding: none`);
  });
  const l = ledgerOf(desk);
  over('contract idle_usdc (books)', l.idle_usdc, 0n, `${usdcText(l.idle_usdc)} USDC`);
  return { lines, problems, orderlyRegistered: registered };
}

const defaultEngine = async () => ({
  ...(await import('../../engine/src/venues/orderly-actions.ts')),
  ...(await import('../../engine/src/contract/near-client.ts')),
});
const defaultTransport = async (options) => new (await import('../../engine/src/contract/near-transport.ts')).NearApiTransport(options);

/** Why a contract call is not the one retire may make (orderly_request of kind holding on the contract), or null. */
export function retireCallProblem(contract, contractId, method, args) {
  if (contractId !== contract) return `${method} on ${contractId}: retire calls ${contract} only`;
  if (method !== 'orderly_request' || args?.req?.kind !== 'holding') return `${method} ${JSON.stringify(args?.req?.kind ?? null)} is not orderly_request of kind holding: refused, nothing was signed`;
  return null;
}

/** The signed Orderly holding read: one orderly_request of kind holding, through the engine's own clients. */
async function signedHolding({ a, deps, desk, deskId, brokerId, client, say }) {
  const readEnv = deps.readEnv ?? ((f) => {
    if (!existsSync(f)) throw new Error(`${f} does not exist: the engine env file desk.mjs --send wrote, needed for the signed Orderly read`);
    return parseDotEnv(readFileSync(f, 'utf8'));
  });
  const e = engineEnvProblems(readEnv(a.envFile), { contract: a.contract, deskId, desk, brokerId });
  if (e.problems.length > 0) throw new Error(`${a.envFile} does not match ${a.contract} / ${deskId}:\n  ${e.problems.join('\n  ')}`);
  const transport = await (deps.transport ?? defaultTransport)({ network: 'mainnet', accountId: e.accountId, privateKey: e.privateKey });
  const publicKey = await transport.publicKey();
  if (!isFunctionCallKey(await client.accessKey(e.accountId, publicKey), a.contract, OPERATOR_METHODS)) {
    throw new Error(`${publicKey} is not ${e.accountId}'s operator key for ${a.contract}: nothing was signed`);
  }
  const guarded = {
    get accountId() { return transport.accountId; },
    call(contractId, method, args, tgas, ...rest) {
      const problem = retireCallProblem(a.contract, contractId, method, args);
      return problem === null ? transport.call(contractId, method, args, tgas, ...rest) : Promise.reject(new Error(problem));
    },
    view: (...x) => transport.view(...x),
    account: () => transport.account(),
    allowance: () => transport.allowance(),
  };
  const engine = await (deps.engine ?? defaultEngine)();
  const contract = new engine.NearContractClient({ contractId: a.contract, network: 'mainnet', transport: guarded, onHealth: (s, d) => say(`  near ${s}: ${d}`) });
  const orderly = new engine.OrderlyDeskClient({
    deskId, network: 'mainnet', apiUrl: ORDERLY_API, accountId: desk.orderly_account_id, orderlyKey: `ed25519:${desk.solana.authority}`,
    evmAddress: desk.evm_address, referralCode: null, signer: contract, fetch: deps.fetch ?? ((...x) => globalThis.fetch(...x)),
  });
  say(`orderly   desk ${deskId}: signing one orderly_request kind holding with ${publicKey} (${e.accountId})`);
  const data = await orderly.holding('retire: check that the Orderly holding is empty');
  const rows = data?.holding;
  if (!Array.isArray(rows)) throw new Error(`Orderly holding answered ${JSON.stringify(data).slice(0, 300)}, not a holding list`);
  return rows;
}

/**
 * Runs the retirement; deps: near, archive (RPC client), fetch, say, now, tree, readKey(file, accountId), readEnv,
 * transport(options), engine(). Returns the summary block.
 */
export async function runRetire(argv, deps = {}) {
  const a = parseRetireArgs(argv);
  const client = deps.near ?? near;
  const archive = deps.archive ?? createClient({ urls: [ARCHIVAL_RPC] });
  const fetchImpl = deps.fetch ?? ((...x) => globalThis.fetch(...x));
  const say = deps.say ?? ((s = '') => console.log(s));
  const now = deps.now ?? Date.now;
  const tree = deps.tree === undefined ? linkedWorktreeOf(ROOT) : deps.tree;
  const refusal = sendRefusal(a.send, tree);
  if (refusal !== null) throw new Error(refusal);

  say(`gimbal retire ${a.contract}: ${a.send ? 'SEND' : 'dry run'}`);
  if (tree !== null) say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);
  say('why       after the deletion anyone can register this name again, and every desk address is an MPC key derived from it:');
  say('          whoever takes the name controls those addresses. Nothing may be left on them, and nothing may be sent to them later.');
  const status = await client.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  const state = await client.account(a.contract);
  if (state === null) throw new Error(`${a.contract} does not exist: nothing to retire`);
  say(`contract  ${a.contract}: ${nearText(BigInt(state.amount), 4)} NEAR, ${state.storage_usage.toLocaleString('en-US')} bytes stored, code ${state.code_hash}`);
  const config = await client.view(a.contract, 'config');
  const bad = contractConfigProblems(config);
  if (bad.length > 0) throw new Error(`${a.contract} is not a mainnet Gimbal contract:\n  ${bad.join('\n  ')}`);
  const brokerId = config.orderly.broker_id;
  const blockers = [];
  // NEAR refuses DeleteAccount for an account with more than 10 kB of data besides its code (DeleteAccountWithLargeState).
  const code = await client.code(a.contract);
  const dataBytes = state.storage_usage - (code === null ? 0 : code.length);
  say(`state     about ${dataBytes.toLocaleString('en-US')} bytes besides the ${(code?.length ?? 0).toLocaleString('en-US')}-byte code (NEAR deletes accounts with up to ${MAX_DELETE_STATE.toLocaleString('en-US')})`);
  if (dataBytes > MAX_DELETE_STATE) blockers.push(`${a.contract} stores about ${dataBytes} bytes besides its code: NEAR refuses DeleteAccount over ${MAX_DELETE_STATE} (DeleteAccountWithLargeState)`);

  const made = await findCreator(fetchImpl, archive, a.contract);
  say(`creator   ${made.note}`);
  let beneficiary = made.confirmed ? made.creator : null;
  if (a.beneficiary !== null) {
    if (made.creator !== null && a.beneficiary !== made.creator) {
      throw new Error(`--beneficiary ${a.beneficiary} is not ${made.creator}, the account that created ${a.contract}: the NEAR goes back to the funder`);
    }
    beneficiary = a.beneficiary;
    if (!made.confirmed) say(`warning   the beneficiary ${a.beneficiary} comes from --beneficiary, not from a confirmed creation record: check it is the funder`);
  }
  if (beneficiary === null) blockers.push('the beneficiary is unknown: pass --beneficiary <the funder that created the account>');
  else if ((await client.account(beneficiary)) === null) throw new Error(`the beneficiary ${beneficiary} does not exist: the NEAR would be lost`);
  say(`benefic.  ${beneficiary ?? 'unknown (pass --beneficiary <funder>.near; never guessed)'}`);

  const ids = new Set(a.desks);
  try {
    for (const id of await createDeskIds(fetchImpl, a.contract)) ids.add(id);
  } catch (e) {
    blockers.push(`the desk list could not be read in full (${e.message}): run again later`);
  }
  if (made.creator !== null) for (const id of await client.view(a.contract, 'desks_of', { owner: made.creator })) ids.add(id);
  const desks = [];
  for (const id of [...ids].sort()) {
    const d = await client.view(a.contract, 'get_desk', { desk_id: id });
    if (d !== null) desks.push([id, d]);
  }
  say(`desks     ${desks.length === 0 ? 'none' : desks.map(([id, d]) => `${id} (owner ${d.owner})`).join(', ')}`);

  const urls = rpcUrls();
  say(`rpc       Solana ${urls.shown.solana}, Arbitrum ${urls.shown.arbitrum}`);
  const contractUsdc = await nearUsdcBalance(client, a.contract);
  const findings = async (holdings) => {
    const problems = [];
    const lines = [];
    if (contractUsdc > DUST.usdcE6) problems.push(`${a.contract} holds ${usdcText(contractUsdc)} USDC on NEAR`);
    lines.push(`${a.contract} USDC on NEAR: ${usdcText(contractUsdc)}`);
    const registered = [];
    for (const [id, d] of desks) {
      const f = await deskFindings({ fetchImpl, urls, desk: d, deskId: id, brokerId, orderlyHolding: holdings.get(id) ?? null });
      lines.push(`desk ${id}: EVM ${d.evm_address}, Solana ${d.solana.authority}, Orderly ${d.orderly_account_id}`, ...f.lines);
      problems.push(...f.problems);
      if (f.orderlyRegistered) registered.push([id, d]);
    }
    return { problems, lines, registered };
  };
  let found = await findings(new Map());
  say();
  say(found.lines.join('\n'));

  const actions = [act.deleteAccount(beneficiary ?? 'unknown.near')];
  const fees = await client.fees();
  const gasPrice = BigInt((await client.rpc('gas_price', [null])).gas_price);
  const cap = txGasCap(fees, { signer: a.contract, receiver: a.contract, actions });
  const signedBy = a.send ? `${a.keyFile}, read now` : `the account's own key, ${a.keyFile}, read at --send (${existsSync(a.keyFile) ? 'exists' : 'not found here'})`;
  say();
  say(describeTx('tx: delete the account', { signer: a.contract, signedBy, receiver: a.contract, actions }).join('\n'));
  say(`  gas       at most ${tgasText(cap.total)} TGas (action fees only), ${nearTextUp(cap.total * gasPrice, 4)} NEAR`);
  say(`  returns   about ${nearText(BigInt(state.amount), 4)} NEAR to ${beneficiary ?? 'the beneficiary'}, the code's storage included`);

  const at = () => new Date(now()).toISOString();
  const head = [`contract ${a.contract}, ${a.send ? 'SEND' : 'dry run'}; beneficiary ${beneficiary ?? 'unknown'} (${made.confirmed ? 'creation confirmed' : 'not confirmed'}); `
    + `${nearText(BigInt(state.amount), 4)} NEAR, ${dataBytes} bytes of data`];
  const unread = found.registered.map(([id]) => `desk ${id}: Orderly holding unread (signed read at --send)`);
  if (!a.send) {
    const block = summaryBlock('retire', {
      at: at(),
      lines: [...head, ...found.lines.map((l) => l.trim()), ...unread, ...found.problems.map((p) => `refused:  ${p}`), ...blockers.map((b) => `refused:  ${b}`)],
    });
    say();
    say(block.join('\n'));
    say('\ndry run: nothing was signed or sent. --send reads the Orderly holding with one signed read, every balance again, and deletes the account only when all are dust.');
    const all = [...found.problems, ...blockers];
    if (all.length > 0) throw new Error(`--send would refuse:\n  ${all.join('\n  ')}`);
    return block;
  }

  if (blockers.length > 0 || found.problems.length > 0) throw new Error(`not deleting ${a.contract}:\n  ${[...found.problems, ...blockers].join('\n  ')}`);
  const signer = (deps.readKey ?? readKeyFile)(a.keyFile, a.contract);
  if (fullAccessVerdict(await client.accessKey(a.contract, signer.publicKeyString)) !== 'matches') {
    throw new Error(`${a.keyFile} is not a full-access key of ${a.contract}: nothing was signed`);
  }
  const holdings = new Map();
  for (const [id, d] of found.registered) holdings.set(id, await signedHolding({ a, deps, desk: d, deskId: id, brokerId, client, say }));
  found = await findings(holdings);
  say(found.lines.join('\n'));
  if (found.problems.length > 0) throw new Error(`not deleting ${a.contract}:\n  ${found.problems.join('\n  ')}`);

  const before = BigInt((await client.account(beneficiary)).amount);
  const out = await client.send(signer, a.contract, actions, { onSent: (h) => say(`\nDeleteAccount sent ${h}; waiting for final`) });
  say(`tx final: ${txLink(out.hash)} (${out.burntTgas} TGas)`);
  const gone = (await client.account(a.contract)) === null;
  const after = BigInt((await client.account(beneficiary)).amount);
  const block = summaryBlock('retire', {
    at: at(),
    lines: [
      ...head,
      ...found.lines.map((l) => l.trim()),
      `delete:   tx ${out.hash} ${out.failure === null ? 'succeeded' : `FAILED ${panicOf(out.failure)}`}; ${a.contract} ${gone ? 'no longer exists' : 'STILL EXISTS'}`,
      `benefic.: ${beneficiary} ${nearText(before, 4)} -> ${nearText(after, 4)} NEAR`,
      `never send anything to the desk addresses above again (${accountLink(a.contract)})`,
    ],
  });
  say();
  say(block.join('\n'));
  if (out.failure !== null || !gone) throw new Error(`DeleteAccount ${out.hash}: ${out.failure === null ? 'the account still exists' : panicOf(out.failure)} (${txLink(out.hash)})`);
  return block;
}

if (isMain(import.meta.url)) await run(() => runRetire(process.argv.slice(2)), USAGE);
