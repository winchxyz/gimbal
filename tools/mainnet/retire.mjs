#!/usr/bin/env node
// Retires a canary: DeleteAccount for the contract account, its whole NEAR balance to the account that created it
// (tools/mainnet/README.md, "Retiring a canary"):
//
//   node tools/mainnet/retire.mjs <contract> [--beneficiary <account> [--creation-tx <hash>]] [--desks <id,id>]
//        [--key-file <contract key json>] [--env-file <engine env file>] [--send]
//
// Why the checks: after the deletion anyone can register <contract> again, and every desk address is an MPC key
// derived from that name. Whoever holds the name then controls the desks' Hyperliquid, Solana, EVM and Orderly
// accounts and whatever the account held on NEAR. So nothing may be left on any of them, and nothing may be sent to
// them afterwards.
//
// The beneficiary is the signer of the transaction that created the account, never a guess. nearblocks names the
// transaction; the archival RPC must confirm it is a near.create_account of exactly this account by that signer
// whose result is `true`. When nearblocks has no creation record, --beneficiary with --creation-tx <hash> is
// confirmed the same way; anything else refuses. A --beneficiary that differs from the confirmed creator refuses.
//
// The desks are every create_desk the contract received (nearblocks), the creator's desks_of, and --desks. For each:
//   Hyperliquid: every perp dex `perpDexs` lists (value, cash, positions), spot, vault equities, HYPE staking,
//   sub-accounts; Phoenix: the trader's collateral, positions, orders and spot collateral on every subaccount;
//   Solana: the authority's SOL, its USDC and PhUSD token accounts and every SPL Token and Token-2022 account it
//   owns; EVM: USDC, USDC.e and ETH on Arbitrum, HYPE and USDC on HyperEVM; Orderly under the contract's broker
//   (public: registered, key; the holding needs a signed read, so --send makes one orderly_request of kind holding
//   with the engine's operator key and nothing else); the books' idle_usdc; and in the contract's own state the
//   rescue ring and, for C8 code, the money record (payout_pending, idle_usdc) and the fund_venue ring (a slot paid
//   within 65 min means money may be in flight). And the contract's own NEP-141 tokens (USDC, the nearblocks
//   inventory) and intents.near balances.
// Every read fails closed: an error, an unexpected answer or a non-number refuses, as does anything over dust or a
// desk list that cannot be read in full.
//
// Default: a dry run that reads only. --send reads the contract's key file (and the engine env file for the
// Orderly read), only then, never prints a key, refuses in a linked git worktree, makes the Orderly read, then
// reads everything above again and sends the DeleteAccount right after, only when all of it is clean. It ends with
// one block to paste back.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError, isMain, parseDotEnv, parseFlags, run } from './cli.mjs';
import {
  NEARBLOCKS_API, NEAR_USDC, TOKEN_PROGRAMS, arbitrumBalances, hyperEvmBalances, hyperliquidBalances, intentsTokens, nearInventory, nearUsdcBalance,
  phoenixTrader, rpcUrls, solanaBalances, solanaTokenAccounts, unitsText,
} from './balances.mjs';
import { engineEnvProblems, sendRefusal } from './checks.mjs';
import { wasmExports } from './deploy.mjs';
import { OPERATOR_METHODS, contractConfigProblems, engineEnvFile } from './desk.mjs';
import {
  KEYS, ROOT, accountLink, act, createClient, describeTx, fullAccessVerdict, isFunctionCallKey, linkedWorktreeOf, mainnetId, near, nearText, nearTextUp,
  panicOf, readKeyFile, tgasText, txGasCap, txLink,
} from './near.mjs';
import { DESK_ID, ledgerOf, summaryBlock, usdcText } from './money.mjs';
import { ORDERLY_API } from './venues.mjs';

export { NEARBLOCKS_API };
export const ARCHIVAL_RPC = 'https://archival-rpc.mainnet.fastnear.com';
/** What counts as nothing left. */
export const DUST = { usdcE6: 10_000n, lamports: 1_000_000n, wei: 100_000_000_000_000n, token18: 10_000_000_000_000_000n, hype18: 1_000_000_000_000_000n };
/** NEAR's limit for DeleteAccount: the account's data besides its code, in bytes. */
export const MAX_DELETE_STATE = 10_000;
/** A ring slot paid more recently than this may still have money in flight (the contract's own 65 min window). */
export const IN_FLIGHT_MS = 65 * 60_000;
/** The contract's storage prefixes (contract/src/lib.rs StorageKey, borsh variant index). */
export const STORAGE_PREFIX = { DeskCounters: 5, Money: 7, FundCounters: 8 };
/** Orderly's answer for an address with no account under the broker. */
export const ORDERLY_NOT_FOUND = -1607;
const RING = 32;

const USAGE = `usage: node tools/mainnet/retire.mjs <contract> [--beneficiary <account> [--creation-tx <hash>]] [--desks <id,id>]
         [--key-file <contract key json>] [--env-file <engine env file>] [--send]
  default: dry run (reads mainnet and the venues; signs nothing)`;
const SPEC = { '--beneficiary': 'value', '--creation-tx': 'value', '--desks': 'value', '--key-file': 'value', '--env-file': 'value', '--send': 'switch' };

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
  const creationTx = values['--creation-tx'] ?? null;
  if (creationTx !== null && !/^[1-9A-HJ-NP-Za-km-z]{1,64}$/.test(creationTx)) throw new UsageError('--creation-tx is not a base58 transaction hash');
  if (creationTx !== null && beneficiary === null) throw new UsageError('--creation-tx needs --beneficiary: the signer it is checked against');
  const desks = values['--desks'] === undefined ? [] : values['--desks'].split(',');
  for (const d of desks) if (!DESK_ID.test(d)) throw new UsageError(`desk id ${JSON.stringify(d)} is not 1 to 32 characters of a-z, 0-9 and -`);
  return {
    contract, beneficiary, creationTx, desks, send: values['--send'] === true,
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
 * Whether `txHash` is a near.create_account of exactly `contract`, signed by `signer`, whose result (the
 * registrar's on_account_created callback) is `true`. Read from the archival RPC. Returns null or the problem.
 */
export async function creationProblem(archive, contract, txHash, signer) {
  let r;
  try {
    r = await archive.rpc('tx', { tx_hash: txHash, sender_account_id: signer, wait_until: 'NONE' });
  } catch (e) {
    return `the archival RPC could not read ${txHash} (${e.message})`;
  }
  const t = r?.transaction;
  const call = t?.actions?.length === 1 ? t.actions[0]?.FunctionCall : undefined;
  let args = null;
  try {
    args = call ? JSON.parse(Buffer.from(call.args, 'base64').toString()) : null;
  } catch {
    args = null;
  }
  let result = null;
  try {
    result = typeof r?.status?.SuccessValue === 'string' ? JSON.parse(Buffer.from(r.status.SuccessValue, 'base64').toString()) : null;
  } catch {
    result = null;
  }
  if (t?.signer_id !== signer) return `${txHash} is signed by ${t?.signer_id ?? 'nobody'}, not ${signer}`;
  if (t?.receiver_id !== 'near' || call?.method_name !== 'create_account' || args?.new_account_id !== contract) return `${txHash} is not near.create_account of ${contract}`;
  if (result !== true) return `${txHash}'s create_account returned ${JSON.stringify(result)}, not true`;
  return null;
}

/**
 * Who created `contract`, confirmed: { creator, txHash, confirmed, note }. nearblocks names the transaction; when it
 * has none, `fallback` ({ beneficiary, creationTx } from the human) is checked the same way.
 */
export async function findCreator(fetchImpl, archive, contract, fallback = {}) {
  const host = new URL(ARCHIVAL_RPC).host;
  const confirmed = (creator, txHash, via) => ({ creator, txHash, confirmed: true, note: `created by ${creator} in ${txLink(txHash)} (near.create_account returned true, confirmed on ${host}${via})` });
  let txHash = null;
  let creator = null;
  let note;
  try {
    const acc = (await getJson(fetchImpl, `${NEARBLOCKS_API}/account/${contract}`)).account?.[0];
    txHash = typeof acc?.created?.transaction_hash === 'string' ? acc.created.transaction_hash : null;
    if (txHash !== null) {
      const tx = (await getJson(fetchImpl, `${NEARBLOCKS_API}/txns/${txHash}`)).txns?.[0];
      creator = typeof tx?.signer_account_id === 'string' ? tx.signer_account_id : null;
    }
    note = txHash === null ? 'nearblocks has no creation record' : creator === null ? `nearblocks has no signer for ${txHash}` : null;
  } catch (e) {
    note = `nearblocks could not be read (${e.message})`;
  }
  if (txHash !== null && creator !== null) {
    const p = await creationProblem(archive, contract, txHash, creator);
    if (p === null) return confirmed(creator, txHash, '');
    note = `nearblocks says ${creator} created it in ${txHash}, not confirmed: ${p}`;
  }
  if (fallback.creationTx && fallback.beneficiary) {
    const p = await creationProblem(archive, contract, fallback.creationTx, fallback.beneficiary);
    if (p === null && (creator === null || creator === fallback.beneficiary)) return confirmed(fallback.beneficiary, fallback.creationTx, ', from --creation-tx');
    note += `; --creation-tx not confirmed: ${p ?? `nearblocks names ${creator}`}`;
  }
  return { creator, txHash, confirmed: false, note };
}

/** The desk ids of every create_desk transaction nearblocks lists for the contract (all pages), or an error. */
export async function createDeskIds(fetchImpl, contract) {
  const ids = new Set();
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const url = `${NEARBLOCKS_API}/account/${contract}/txns?method=create_desk&per_page=25${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const r = await getJson(fetchImpl, url);
    if (!Array.isArray(r.txns)) throw new Error('nearblocks: no txns list');
    for (const t of r.txns) {
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
    if (!r.cursor || r.txns.length === 0) return [...ids];
    cursor = r.cursor;
  }
  throw new Error('nearblocks: more than 40 pages of create_desk');
}

// --- the contract's own records (borsh, as near-sdk stores them) ---

class BorshReader {
  constructor(buf, what) {
    this.b = buf;
    this.o = 0;
    this.what = what;
  }

  take(n) {
    if (this.o + n > this.b.length) throw new Error(`${this.what}: truncated`);
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }

  u8() { return this.take(1)[0]; }
  u64() { return this.take(8).readBigUInt64LE(); }
  u128() { const s = this.take(16); return s.readBigUInt64LE(0) + (s.readBigUInt64LE(8) << 64n); }
  string() { return this.take(this.take(4).readUInt32LE()).toString('utf8'); }
  bool() {
    const v = this.u8();
    if (v > 1) throw new Error(`${this.what}: bad bool`);
    return v === 1;
  }

  end() {
    if (this.o !== this.b.length) throw new Error(`${this.what}: ${this.b.length - this.o} bytes left over`);
  }
}

/** contract/src/money.rs DeskMoney: owner, ledger (5 x u128), payout_pending, payout_since_ms, payout_seq. */
export function decodeDeskMoney(buf) {
  const r = new BorshReader(buf, 'the money record');
  const owner = r.string();
  const ledger = { deposited: r.u128(), withdrawn: r.u128(), fees_paid: r.u128(), hwm: r.u128(), idle_usdc: r.u128() };
  const out = { owner, ledger, payout_pending: r.bool(), payout_since_ms: r.u64(), payout_seq: r.u64() };
  r.end();
  return out;
}

/** contract/src/rescue.rs DeskCounters (1,329 bytes): the meters, the ring of 32 deposit hashes and their paid times. */
export function decodeCounters(buf) {
  const r = new BorshReader(buf, 'the counters record');
  r.u64();
  r.u128();
  r.u128();
  r.u64();
  r.take(32 * RING);
  const next = r.u8();
  const paid = Array.from({ length: RING }, () => r.u64());
  r.end();
  return { deposit_next: next, deposit_paid_ms: paid };
}

const storageKey = (prefix, deskId) => {
  const id = Buffer.from(deskId);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(id.length);
  return Buffer.concat([Buffer.from([prefix]), len, id]);
};

/** One record of the contract's state under `prefix` for `deskId` (a Buffer), or null when there is none. */
async function readRecord(client, contract, prefix, deskId) {
  const key = storageKey(prefix, deskId);
  const rows = await client.state(contract, key);
  const hit = rows.filter((row) => Buffer.from(row.key).equals(key));
  if (hit.length > 1) throw new Error('two records under one key');
  return hit.length === 0 ? null : Buffer.from(hit[0].value);
}

/** What the contract's own records of a desk say may still be in flight. */
async function recordFindings({ client, contract, deskId, c8, now }) {
  const lines = [];
  const problems = [];
  const ring = (name, counters) => {
    if (counters === null) {
      lines.push(`  ${`${name} ring`.padEnd(26)} none (never used)`);
      return;
    }
    const d = decodeCounters(counters);
    const recent = d.deposit_paid_ms.map((ms, i) => [i, ms]).filter(([, ms]) => ms > 0n && BigInt(now) - ms < BigInt(IN_FLIGHT_MS));
    lines.push(`  ${`${name} ring`.padEnd(26)} ${recent.length === 0 ? 'no slot paid within 65 min' : `${recent.length} slot(s) paid within 65 min`}`);
    for (const [i, ms] of recent) {
      problems.push(`desk ${deskId}: ${name} ring slot ${i} was paid ${Math.floor(Number(BigInt(now) - ms) / 60_000)} min ago: money may be in flight; wait 65 min`);
    }
  };
  try {
    ring('rescue', await readRecord(client, contract, STORAGE_PREFIX.DeskCounters, deskId));
  } catch (e) {
    lines.push(`  ${'rescue ring'.padEnd(26)} could not be read (${e.message})`);
    problems.push(`desk ${deskId}: the contract state could not be read (rescue ring)`);
  }
  if (!c8) {
    lines.push(`  ${'money record'.padEnd(26)} none (code before C8: no payout or fund_venue can be in flight)`);
    return { lines, problems };
  }
  try {
    const raw = await readRecord(client, contract, STORAGE_PREFIX.Money, deskId);
    if (raw === null) throw new Error('missing; create_desk writes it on C8');
    const m = decodeDeskMoney(raw);
    lines.push(`  ${'money record'.padEnd(26)} payout_pending ${m.payout_pending}, payout ${m.payout_seq}, idle_usdc ${usdcText(m.ledger.idle_usdc)} USDC`);
    if (m.payout_pending) problems.push(`desk ${deskId}: a payout is in flight (payout_pending, since ${new Date(Number(m.payout_since_ms)).toISOString()}, payout ${m.payout_seq})`);
    if (m.ledger.idle_usdc > 0n) problems.push(`desk ${deskId}: the money record idle_usdc holds ${usdcText(m.ledger.idle_usdc)} USDC`);
  } catch (e) {
    lines.push(`  ${'money record'.padEnd(26)} could not be read (${e.message})`);
    problems.push(`desk ${deskId}: the C8 money record could not be read (${e.message})`);
  }
  try {
    ring('fund_venue', await readRecord(client, contract, STORAGE_PREFIX.FundCounters, deskId));
  } catch (e) {
    lines.push(`  ${'fund_venue ring'.padEnd(26)} could not be read (${e.message})`);
    problems.push(`desk ${deskId}: the contract state could not be read (fund_venue ring)`);
  }
  return { lines, problems };
}

// --- the venues ---

/** Orderly's public view of the desk under the contract's broker: registered (only -1607 means no), the key's state. */
async function orderlyPublic(fetchImpl, desk, brokerId) {
  const acc = await getJson(fetchImpl, `${ORDERLY_API}/v1/get_account?address=${desk.evm_address}&broker_id=${brokerId}`);
  if (acc.success === false && acc.code === ORDERLY_NOT_FOUND) return { registered: false, key: null };
  if (acc.success !== true || typeof acc.data?.account_id !== 'string') throw new Error(`get_account answered ${JSON.stringify(acc).slice(0, 200)}`);
  const key = await getJson(fetchImpl, `${ORDERLY_API}/v1/get_orderly_key?account_id=${desk.orderly_account_id}&orderly_key=ed25519:${desk.solana.authority}`);
  return { registered: true, key: key.success === true ? key.data?.key_status ?? 'unknown' : `unread (code ${key.code})` };
}

/** A holding row's number (Orderly sends numbers; a decimal string is accepted); anything else throws. */
function holdingNumber(deskId, field, v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`Orderly holding of desk ${deskId} could not be read: ${field} ${JSON.stringify(v)} is not a number`);
  return n;
}

/** Every balance of one desk, as { lines, problems, orderlyRegistered }. `orderlyHolding` is the signed read (or null). */
export async function deskFindings({ fetchImpl, urls, desk, deskId, brokerId, orderlyHolding = null }) {
  const lines = [];
  const problems = [];
  const show = (what, text) => lines.push(`  ${what.padEnd(26)} ${text}`);
  const over = (what, v, dust, text) => {
    show(what, text);
    if (v > dust) problems.push(`desk ${deskId}: ${what} holds ${text}`);
  };
  const read = async (what, fn) => {
    try {
      await fn();
    } catch (e) {
      show(what, `could not be read (${e.message})`);
      problems.push(`desk ${deskId}: ${what} could not be read`);
    }
  };
  const abs = (v) => (v < 0n ? -v : v);

  await read('Hyperliquid', async () => {
    const hl = await hyperliquidBalances(fetchImpl, desk.evm_address);
    for (const d of hl.dexes) {
      const v = abs(d.accountValueE6) > abs(d.totalRawE6) ? abs(d.accountValueE6) : abs(d.totalRawE6);
      over(`Hyperliquid perps ${d.dex}`, v, DUST.usdcE6, `${usdcText(d.accountValueE6)} USDC (cash ${usdcText(d.totalRawE6)}, ${d.positions} positions)`);
      if (d.positions > 0) problems.push(`desk ${deskId}: ${d.positions} open Hyperliquid position(s) on ${d.dex}`);
    }
    if (hl.spot.length === 0) show('Hyperliquid spot', 'no balances');
    for (const b of hl.spot) over(`Hyperliquid spot ${b.coin}`, b.total, DUST.token18, unitsText(b.total, 18));
    if (hl.vaults.length === 0) show('Hyperliquid vaults', 'none');
    for (const v of hl.vaults) over(`Hyperliquid vault ${v.vault}`, v.equityE6, DUST.usdcE6, `${usdcText(v.equityE6)} USDC`);
    const staked = hl.staking.delegated + hl.staking.undelegated + hl.staking.pendingWithdrawal;
    over('Hyperliquid staking', staked, DUST.hype18, `${unitsText(staked, 18)} HYPE (${hl.staking.nPending} pending withdrawals)`);
    if (hl.staking.nPending > 0 && staked <= DUST.hype18) problems.push(`desk ${deskId}: ${hl.staking.nPending} pending Hyperliquid staking withdrawal(s)`);
    show('Hyperliquid sub-accounts', hl.subAccounts.length === 0 ? 'none' : hl.subAccounts.join(', '));
    if (hl.subAccounts.length > 0) problems.push(`desk ${deskId}: Hyperliquid has ${hl.subAccounts.length} sub-account(s): ${hl.subAccounts.join(', ')}`);
  });

  await read('Phoenix trader', async () => {
    const subs = await phoenixTrader(fetchImpl, desk.solana.authority);
    if (subs.length === 0) show('Phoenix trader', 'no subaccounts (not registered, or empty)');
    for (const s of subs) {
      const at = `Phoenix trader subaccount ${s.index}`;
      show(at, `collateral ${usdcText(s.collateralE6)} USDC, ${s.positions} positions, ${s.orders} orders`);
      if (s.collateralE6 > DUST.usdcE6) problems.push(`desk ${deskId}: ${at} holds ${usdcText(s.collateralE6)} USDC of collateral`);
      if (s.positions > 0) problems.push(`desk ${deskId}: ${at} has ${s.positions} position(s)`);
      if (s.orders > 0) problems.push(`desk ${deskId}: ${at} has ${s.orders} open order(s)`);
      for (const c of s.spot) {
        const dust = c.decimals === 9 ? DUST.lamports : 10n ** BigInt(Math.max(0, c.decimals - 2));
        if (c.balance > dust) problems.push(`desk ${deskId}: ${at} holds ${unitsText(c.balance, c.decimals)} ${c.symbol}`);
      }
    }
  });

  await read('Solana authority SOL', async () => {
    const s = await solanaBalances(fetchImpl, urls.solana, { authority: desk.solana.authority, tokenAccounts: {} });
    over('Solana authority SOL', s.lamports, DUST.lamports, `${unitsText(s.lamports, 9)} SOL`);
  });
  for (const [name, account] of [['USDC', desk.solana.usdc_ata], ['PhUSD', desk.solana.phusd_ata]]) {
    const what = `Solana ${name} token account`;
    await read(what, async () => {
      const t = (await solanaBalances(fetchImpl, urls.solana, { authority: desk.solana.authority, tokenAccounts: { t: account } })).tokens.t;
      over(what, t.amount, DUST.usdcE6, t.exists ? unitsText(t.amount, t.decimals) : 'none (never created)');
    });
  }
  for (const program of Object.keys(TOKEN_PROGRAMS)) {
    await read(`Solana ${program} accounts`, async () => {
      const accounts = (await solanaTokenAccounts(fetchImpl, urls.solana, desk.solana.authority, [program]))[program];
      show(`Solana ${program} accounts`, accounts.length === 0 ? 'none' : `${accounts.length}`);
      for (const t of accounts) {
        const text = unitsText(t.amount, t.decimals);
        show(`  ${t.pubkey}`, `mint ${t.mint}: ${text}`);
        if (t.amount > 0n) problems.push(`desk ${deskId}: Solana ${program} account ${t.pubkey} (mint ${t.mint}) holds ${text}`);
      }
    });
  }

  await read('Arbitrum', async () => {
    const e = await arbitrumBalances(fetchImpl, urls.arbitrum, desk.evm_address);
    over('Arbitrum USDC', e.usdcE6, DUST.usdcE6, `${usdcText(e.usdcE6)} USDC`);
    over('Arbitrum USDC.e', e.usdceE6, DUST.usdcE6, `${usdcText(e.usdceE6)} USDC`);
    over('Arbitrum ETH', e.wei, DUST.wei, `${unitsText(e.wei, 18)} ETH`);
  });
  await read('HyperEVM', async () => {
    const e = await hyperEvmBalances(fetchImpl, urls.hyperevm, desk.evm_address);
    over('HyperEVM HYPE', e.wei, DUST.wei, `${unitsText(e.wei, 18)} HYPE`);
    over('HyperEVM USDC', e.usdcE6, DUST.usdcE6, `${usdcText(e.usdcE6)} USDC`);
  });

  let registered = null;
  await read('Orderly', async () => {
    const o = await orderlyPublic(fetchImpl, desk, brokerId);
    registered = o.registered;
    if (!o.registered) {
      show('Orderly', `not registered under ${brokerId} (code ${ORDERLY_NOT_FOUND}): no account, no holding`);
      return;
    }
    if (orderlyHolding === null) {
      show('Orderly', `registered (${desk.orderly_account_id}), key ${o.key}; holding not public: --send reads it signed first`);
      return;
    }
    for (const h of orderlyHolding) {
      const total = Math.abs(h.holding) + Math.abs(h.frozen) + Math.abs(h.pending_short);
      show(`Orderly ${h.token}`, `holding ${h.holding}, frozen ${h.frozen}, pending_short ${h.pending_short}`);
      if (total > 0.01) problems.push(`desk ${deskId}: Orderly ${h.token} holds ${total}`);
    }
    if (orderlyHolding.length === 0) show('Orderly', 'holding: none');
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
  if (!Array.isArray(rows)) throw new Error(`Orderly holding of desk ${deskId} could not be read: ${JSON.stringify(data).slice(0, 300)} is not a holding list`);
  return rows.map((h) => ({
    token: String(h?.token ?? '?'),
    holding: holdingNumber(deskId, 'holding', h?.holding),
    frozen: holdingNumber(deskId, 'frozen', h?.frozen ?? 0),
    pending_short: holdingNumber(deskId, 'pending_short', h?.pending_short ?? 0),
  }));
}

/** What these checks do not read (said in every run, so nobody takes the list for more than it is). */
export const NOT_COVERED = 'Orderly under any broker but the contract\'s; EVM chains other than Arbitrum and HyperEVM; Phoenix trader PDAs other than 0; '
  + 'Solana stake accounts and NFTs; NEP-141 tokens nearblocks does not index; NEAR NFTs';

/**
 * Runs the retirement; deps: near, archive (RPC client), fetch, say, now, tree, readKey(file, accountId), readEnv,
 * transport(options), engine(), rpcEnv (the environment the RPC URLs come from). Returns the summary block.
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
  const c8 = code !== null && wasmExports(code).includes('withdraw_to_owner');
  const dataBytes = state.storage_usage - (code === null ? 0 : code.length);
  say(`state     about ${dataBytes.toLocaleString('en-US')} bytes besides the ${(code?.length ?? 0).toLocaleString('en-US')}-byte code (NEAR deletes accounts with up to ${MAX_DELETE_STATE.toLocaleString('en-US')}); `
    + `${c8 ? 'C8 code: the money record and the fund_venue ring are read' : 'code before C8'}`);
  if (dataBytes > MAX_DELETE_STATE) blockers.push(`${a.contract} stores about ${dataBytes} bytes besides its code: NEAR refuses DeleteAccount over ${MAX_DELETE_STATE} (DeleteAccountWithLargeState)`);

  const made = await findCreator(fetchImpl, archive, a.contract, { beneficiary: a.beneficiary, creationTx: a.creationTx });
  say(`creator   ${made.note}`);
  if (made.confirmed && a.beneficiary !== null && a.beneficiary !== made.creator) {
    throw new Error(`--beneficiary ${a.beneficiary} is not ${made.creator}, the account that created ${a.contract}: the NEAR goes back to the funder`);
  }
  const beneficiary = made.confirmed ? made.creator : null;
  if (beneficiary === null) {
    blockers.push('the beneficiary is unknown: no confirmed creation transaction (pass --beneficiary <funder> --creation-tx <hash of its near.create_account>)');
  } else if ((await client.account(beneficiary)) === null) {
    throw new Error(`the beneficiary ${beneficiary} does not exist: the NEAR would be lost`);
  }
  say(`benefic.  ${beneficiary ?? 'unknown (never guessed)'}`);

  const ids = new Set(a.desks);
  try {
    for (const id of await createDeskIds(fetchImpl, a.contract)) ids.add(id);
  } catch (e) {
    blockers.push(`the desk list could not be read in full (${e.message}): run again later`);
  }
  for (const owner of new Set([made.creator, beneficiary].filter((x) => x !== null))) {
    for (const id of await client.view(a.contract, 'desks_of', { owner })) ids.add(id);
  }
  const deskIds = [...ids].sort();

  const urls = rpcUrls(deps.rpcEnv ?? process.env);
  say(`rpc       Solana ${urls.shown.solana}, Arbitrum ${urls.shown.arbitrum}, HyperEVM ${urls.shown.hyperevm}`);
  say(`not covered: ${NOT_COVERED}`);

  /** Everything, read now: the contract's NEAR tokens, then each desk's books, records and venues. */
  const readAll = async (holdings) => {
    const problems = [];
    const lines = [];
    const contractRead = async (what, fn) => {
      try {
        await fn();
      } catch (e) {
        lines.push(`${a.contract} ${what} could not be read (${e.message})`);
        problems.push(`${a.contract} ${what} could not be read`);
      }
    };
    await contractRead('USDC on NEAR', async () => {
      const u = await nearUsdcBalance(client, a.contract);
      lines.push(`${a.contract} USDC on NEAR: ${usdcText(u)}`);
      if (u > DUST.usdcE6) problems.push(`${a.contract} holds ${usdcText(u)} USDC on NEAR`);
    });
    await contractRead('NEP-141 tokens (nearblocks)', async () => {
      const fts = (await nearInventory(fetchImpl, a.contract)).filter((t) => t.contract !== NEAR_USDC);
      lines.push(`${a.contract} NEP-141 tokens (nearblocks): ${fts.length === 0 ? 'none' : fts.map((t) => `${t.contract} ${t.amount}`).join(', ')}`);
      for (const t of fts) if (t.amount > 0n) problems.push(`${a.contract} holds ${t.contract} ${t.amount} (base units)`);
    });
    await contractRead('intents.near tokens', async () => {
      const tokens = await intentsTokens(client, a.contract);
      lines.push(`${a.contract} intents.near tokens: ${tokens.length === 0 ? 'none' : JSON.stringify(tokens).slice(0, 300)}`);
      if (tokens.length > 0) problems.push(`${a.contract} holds tokens on intents.near: ${JSON.stringify(tokens).slice(0, 300)}`);
    });
    const desks = [];
    for (const id of deskIds) {
      const d = await client.view(a.contract, 'get_desk', { desk_id: id });
      if (d !== null) desks.push([id, d]);
    }
    lines.push(`desks: ${desks.length === 0 ? 'none' : desks.map(([id, d]) => `${id} (owner ${d.owner})`).join(', ')}`);
    const registered = [];
    for (const [id, d] of desks) {
      lines.push(`desk ${id}: EVM ${d.evm_address}, Solana ${d.solana.authority}, Orderly ${d.orderly_account_id}`);
      const f = await deskFindings({ fetchImpl, urls, desk: d, deskId: id, brokerId, orderlyHolding: holdings.get(id) ?? null });
      const r = await recordFindings({ client, contract: a.contract, deskId: id, c8, now: now() });
      lines.push(...f.lines, ...r.lines);
      problems.push(...f.problems, ...r.problems);
      if (f.orderlyRegistered) registered.push([id, d]);
    }
    return { problems, lines, registered };
  };
  let found = await readAll(new Map());
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
  const head = [
    `contract ${a.contract}, ${a.send ? 'SEND' : 'dry run'}; beneficiary ${beneficiary ?? 'unknown'} (${made.confirmed ? 'creation confirmed' : 'not confirmed'}); `
      + `${nearText(BigInt(state.amount), 4)} NEAR, ${dataBytes} bytes of data`,
    `not covered: ${NOT_COVERED}`,
  ];
  const unread = found.registered.map(([id]) => `desk ${id}: Orderly holding unread (signed read at --send)`);
  if (!a.send) {
    const block = summaryBlock('retire', {
      at: at(),
      lines: [...head, ...found.lines.map((l) => l.trim()), ...unread, ...found.problems.map((p) => `refused:  ${p}`), ...blockers.map((b) => `refused:  ${b}`)],
    });
    say();
    say(block.join('\n'));
    say('\ndry run: nothing was signed or sent. --send reads the Orderly holding with one signed read, then everything again, and deletes the account only when all is clean.');
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
  // Everything again, after the Orderly read and right before the signature: money may have moved meanwhile.
  say('\nrecheck   every balance, the books and the contract\'s records, read again after the Orderly read, just before signing');
  found = await readAll(holdings);
  say(found.lines.join('\n'));
  const missing = found.registered.filter(([id]) => !holdings.has(id)).map(([id]) => `desk ${id}: registered on Orderly since the first read; run again`);
  if (found.problems.length > 0 || missing.length > 0) throw new Error(`not deleting ${a.contract}:\n  ${[...found.problems, ...missing].join('\n  ')}`);

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
