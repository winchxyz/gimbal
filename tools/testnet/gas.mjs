#!/usr/bin/env node
// Measures the gas of each action method a testnet deployment can be driven through: every call
// at 300 TGas from the owner account, one MPC call at a time, and per receipt what it burnt (the
// method, the MPC contract's `sign` and its resume, `on_signed`, refunds).
//
//   node tools/testnet/gas.mjs <contract> <desk_id> [--owner <account>] [--only <label,...>] [--json <file>]
//
// The contract must use the Mock price source: the script first sets BTC, ETH and SOL prices with
// set_mock_price from the contract account's own key (.keys/<contract>.json). The Solana messages
// are the recorded ones of contract/core/tests/vectors/solana*.json with the vector desk's four
// accounts replaced by this desk's; the largest adds token Revokes up to the 1232-byte
// transaction. Nothing is sent to a venue. No key value is printed. Testnet only: every id must
// end in .testnet, the RPC must serve chain "testnet" and the contract's network be Testnet.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, actions, b58decode, loadKey, panicOf, rpc, send, sleep, testnetId, view } from './near.mjs';
import { hlSignature } from './evm.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const [contract, deskId] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const owner = flag('--owner', 'gimbal-owner-fcf135.testnet');
const only = flag('--only', null)?.split(',');
const jsonOut = flag('--json', null);
if (!contract || !deskId) {
  console.error('usage: node tools/testnet/gas.mjs <contract> <desk_id> [--owner <account>] [--only <label,...>] [--json <file>]');
  process.exit(2);
}
testnetId(contract, 'contract');
testnetId(owner, 'owner');
const { mpc, network, price_source: priceSource } = await view(contract, 'config');
if (network !== 'Testnet') throw new Error(`${contract} is configured for ${network}: refusing`);
if (priceSource !== 'Mock') throw new Error(`${contract} prices come from ${JSON.stringify(priceSource)}, not Mock`);
const desk = await view(contract, 'get_desk', { desk_id: deskId });
if (!desk) throw new Error(`no desk ${deskId} on ${contract}`);
if (desk.owner !== owner) throw new Error(`desk ${deskId} is owned by ${desk.owner}, not ${owner}`);
const ownerKey = loadKey(owner);

const PRICES_E8 = { BTC: 8_125_000_000_000, ETH: 245_000_000_000, SOL: 10_380_000_000 };
const DAY_MS = 86_400_000;

// --- Solana messages for this desk ---

const vectors = (f) => JSON.parse(readFileSync(join(ROOT, 'contract', 'core', 'tests', 'vectors', f), 'utf8'));
const sol = vectors('solana.json');
const review = vectors('solana-review.json');
const onboarding = vectors('solana-onboarding.json');
const hexKey = (b58) => Buffer.from(b58decode(b58)).toString('hex');
const swaps = [
  [sol.desk.authority, desk.solana.authority],
  [sol.desk.usdc_ata, desk.solana.usdc_ata],
  [sol.desk.phusd_ata, desk.solana.phusd_ata],
  [sol.desk.phoenix_trader, desk.solana.phoenix_trader],
].map(([from, to]) => [hexKey(from), hexKey(to)]);
/** The message `hex` with the vector desk's accounts replaced by this desk's. */
const forDesk = (hex) => {
  let out = hex;
  for (const [from, to] of swaps) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
  }
  return Buffer.from(out, 'hex');
};
const caseHex = (doc, name) => {
  const c = doc.cases.find((x) => x.name === name);
  if (!c) throw new Error(`no case ${name}`);
  return c.message_hex;
};

function compactU16(n) {
  const out = [];
  for (;;) {
    const low = n & 0x7f;
    n >>= 7;
    if (n === 0) return [...out, low];
    out.push(low | 0x80);
  }
}

/** A legacy message with `count` token Revokes of the desk PhUSD account appended. */
function withRevokes(message, count) {
  let at = 3;
  let keys = 0;
  for (let shift = 0; ; shift += 7) {
    const b = message[at++];
    keys |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
  }
  const keyList = [];
  for (let i = 0; i < keys; i++) keyList.push(message.subarray(at + 32 * i, at + 32 * (i + 1)).toString('hex'));
  at += 32 * keys + 32;
  const countAt = at;
  let ixs = 0;
  let width = 0;
  for (let shift = 0; ; shift += 7) {
    const b = message[at++];
    width++;
    ixs |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
  }
  const index = (b58) => {
    const i = keyList.indexOf(hexKey(b58));
    if (i < 0) throw new Error(`${b58} is not in the message`);
    return i;
  };
  const revoke = [index('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), 2, index(desk.solana.phusd_ata), index(desk.solana.authority), 1, 5];
  return Buffer.concat([
    message.subarray(0, countAt),
    Buffer.from(compactU16(ixs + count)),
    message.subarray(countAt + width),
    Buffer.from(Array.from({ length: count }, () => revoke).flat()),
  ]);
}

const MAX_MESSAGE = 1232 - 1 - 64;
const withdrawHex = caseHex(review, 'review 6: withdraw 10 USDC with a Revoke of the desk PhUSD account after the unwrap');
const withdraw = forDesk(withdrawHex);
const largest = withRevokes(withdraw, Math.floor((MAX_MESSAGE - withdraw.length) / 6));
const onboardingSwaps = [
  [onboarding.ctx.desk.authority, desk.solana.authority],
  [onboarding.ctx.desk.phoenix_trader, desk.solana.phoenix_trader],
].map(([from, to]) => [hexKey(from), hexKey(to)]);
const onboardingFor = (kind) => {
  let hex = Buffer.from(onboarding.messages[kind].message_b64, 'base64').toString('hex');
  for (const [from, to] of onboardingSwaps) hex = hex.split(from).join(to);
  return Buffer.from(hex, 'hex').toString('base64');
};

// --- the calls ---

const evmSigHex = (sig) => {
  const { r, s, v } = hlSignature(sig);
  return r + s.slice(2) + v.toString(16);
};
const now = () => Date.now();
const solMessage = (bytes) => ({ desk_id: deskId, message_b64: bytes.toString('base64'), reason: 'gas measurement' });
const request = (req) => ({ desk_id: deskId, req: { reduce_only: false, ...req, timestamp_ms: now() }, reason: 'gas measurement' });
const live = vectors('oneclick-live.json');
const dry = vectors('oneclick.json');
const rescueArgs = (doc, name) => {
  const q = doc.quotes.find((x) => x.name === name);
  if (!q) throw new Error(`no quote ${name}`);
  return { desk_id: deskId, quote: q.canonical_json, quote_signature: q.signature, reason: 'gas measurement' };
};

/** [label, method, args (a function of what earlier calls returned), deposit in yocto]. */
const calls = [
  ['hl_order', 'hl_order', () => ({ desk_id: deskId, order: { asset: 3, is_buy: true, px: '79625', sz: '0.0005', reduce_only: false, tif: 'Gtc', cloid: null }, reason: 'gas measurement' })],
  ['hl_order (cloid, reduce-only IOC)', 'hl_order', () => ({ desk_id: deskId, order: { asset: 4, is_buy: false, px: '2401', sz: '0.004', reduce_only: true, tif: 'Ioc', cloid: '0x0123456789abcdef0123456789abcdef' }, reason: 'gas measurement' })],
  ['hl_cancel', 'hl_cancel', () => ({ desk_id: deskId, asset: 3, oid: 123456789, reason: 'gas measurement' })],
  ['hl_set_referrer', 'hl_set_referrer', () => ({ desk_id: deskId })],
  ['hl_approve_builder_fee', 'hl_approve_builder_fee', () => ({ desk_id: deskId })],
  ['hl_usd_class_transfer', 'hl_usd_class_transfer', () => ({ desk_id: deskId, amount: '1.5', to_perp: true, reason: 'gas measurement' })],
  ['hl_withdraw', 'hl_withdraw', () => ({ desk_id: deskId, amount: '5' }), 1n],
  [`sol_sign (lone Revoke, ${forDesk(caseHex(review, 'review 5: lone Revoke of the desk PhUSD account without a priority fee')).length} B)`, 'sol_sign', () => solMessage(forDesk(caseHex(review, 'review 5: lone Revoke of the desk PhUSD account without a priority fee')))],
  [`sol_sign (IOC buy ETH, ${forDesk(caseHex(sol, 'IOC buy 0.005 ETH, limit 2474.5 (+1%)')).length} B)`, 'sol_sign', () => solMessage(forDesk(caseHex(sol, 'IOC buy 0.005 ETH, limit 2474.5 (+1%)')))],
  [`sol_sign (withdraw + Revoke, ${withdraw.length} B)`, 'sol_sign', () => solMessage(withdraw)],
  [`sol_sign (largest: withdraw + ${(largest.length - withdraw.length) / 6} Revokes, ${largest.length} B)`, 'sol_sign', () => solMessage(largest)],
  ['sol_sign_register (register)', 'sol_sign_register', () => ({ desk_id: deskId, message_b64: onboardingFor('register') })],
  ['sol_sign_register (referral_activate)', 'sol_sign_register', () => ({ desk_id: deskId, message_b64: onboardingFor('referral_activate') })],
  // No quote names this desk's addresses, so a rescue stops at the first field check: what these
  // burn is the quote's Ed25519 check and JSON parse, the bulk of the verify step.
  ['evm_usdc_to_intents (live quote; verified, refused at refundTo)', 'evm_usdc_to_intents', () => rescueArgs(live, 'Orderly money out: Arbitrum USDC (desk EVM) to Hyperliquid')],
  ['sol_sign_rescue (live quote; verified, refused at refundTo)', 'sol_sign_rescue', () => ({
    ...rescueArgs(live, 'Solana USDC to the pinned Orderly receiver, 10 USDC'),
    message_b64: forDesk(caseHex(sol, 'rescue in one transaction: Phoenix withdraw + Ember unwrap + ATA for the deposit owner + TransferChecked of amountIn')).toString('base64'),
  })],
  ['hl_send_to_intents (dry quote; verified, refused as dry)', 'hl_send_to_intents', () => rescueArgs(dry, 'rescue Hyperliquid -> Phoenix: HyperCore USDC to the desk Solana authority')],
  ['orderly_register', 'orderly_register', () => ({ desk_id: deskId, registration_nonce: '194528949540' })],
  ['orderly_add_key', 'orderly_add_key', () => ({ desk_id: deskId, expiration_ms: now() + 30 * DAY_MS })],
  ['orderly_request order', 'orderly_request', () => request({ kind: 'order', symbol: 'PERP_BTC_USDC', side: 'BUY', order_type: 'LIMIT', price: '79625', quantity: '0.0005' })],
  ['orderly_request cancel', 'orderly_request', () => request({ kind: 'cancel', symbol: 'PERP_BTC_USDC', order_id: 123456789 })],
  ['orderly_request cancel_all', 'orderly_request', () => request({ kind: 'cancel_all', symbol: 'PERP_BTC_USDC' })],
  ['orderly_request positions', 'orderly_request', () => request({ kind: 'positions' })],
  ['orderly_request funding_fee_history', 'orderly_request', () => request({ kind: 'funding_fee_history', symbol: 'PERP_BTC_USDC', start_t: now() - 7 * DAY_MS, end_t: now(), page: 1, size: 60 })],
  ['set_orderly_ips', 'set_orderly_ips', () => ({ desk_id: deskId, ips: ['203.0.113.7', '198.51.100.23'] }), 10n ** 22n],
  ['orderly_request ip_restriction', 'orderly_request', () => request({ kind: 'ip_restriction' })],
  ['orderly_ws_auth', 'orderly_ws_auth', () => ({ desk_id: deskId, timestamp: now() })],
  ['orderly_settle_pnl', 'orderly_settle_pnl', () => ({ desk_id: deskId, settle_nonce: 7 })],
  ['orderly_request settle_pnl', 'orderly_request', (got) => {
    const s = got.orderly_settle_pnl;
    return request({ kind: 'settle_pnl', nonce: 7, signed_at_ms: Number(s.payload.message.timestamp), eip712_signature: evmSigHex(s.signature) });
  }],
  ['orderly_withdraw', 'orderly_withdraw', () => ({ desk_id: deskId, amount: '1', withdraw_nonce: 8 })],
  ['orderly_request withdraw_request', 'orderly_request', (got) => {
    const w = got.orderly_withdraw;
    return request({ kind: 'withdraw_request', amount: '1', nonce: 8, signed_at_ms: Number(w.payload.message.timestamp), eip712_signature: evmSigHex(w.signature) });
  }],
];

// --- measuring ---

const tgas = (g) => Number(BigInt(g) / 10_000_000_000n) / 100;

/** The method of each receipt of a transaction, by receipt id. */
async function methods(hash) {
  const full = await rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: ownerKey.accountId, wait_until: 'EXECUTED_OPTIMISTIC' });
  const out = new Map();
  for (const r of full.receipts ?? []) {
    const acts = r.receipt?.Action?.actions ?? [];
    const call = acts.find((a) => a.FunctionCall)?.FunctionCall;
    const isRefund = r.predecessor_id === 'system';
    out.set(r.receipt_id, call ? `${call.method_name}` : isRefund ? 'refund' : 'transfer');
  }
  return out;
}

/**
 * `send`, again after 3 s when the RPC still served the access key's nonce from before the last
 * transaction (an `InvalidNonce` transaction never ran, so sending it again cannot repeat it).
 */
async function sendFresh(key, receiverId, acts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(key, receiverId, acts);
    } catch (e) {
      if (attempt >= 5 || !/InvalidNonce/.test(e.message)) throw e;
      await sleep(3000);
    }
  }
}

async function measure(label, method, callArgs, deposit = 0n) {
  const out = await sendFresh(ownerKey, contract, [actions.call(method, callArgs, 300n, deposit)]);
  const names = await methods(out.hash);
  const parts = [{ where: 'tx -> receipt', on: ownerKey.accountId, tgas: 0 }];
  // The transaction's own conversion, then each receipt in order.
  const txOutcome = await rpc('tx', { tx_hash: out.hash, sender_account_id: ownerKey.accountId, wait_until: 'EXECUTED_OPTIMISTIC' });
  parts[0].tgas = tgas(txOutcome.transaction_outcome.outcome.gas_burnt);
  for (const r of out.receipts) {
    const name = names.get(r.id) ?? '?';
    parts.push({ where: name, on: r.outcome.executor_id, tgas: tgas(r.outcome.gas_burnt) });
  }
  const sum = (pred) => Math.round(parts.filter(pred).reduce((s, p) => s + p.tgas, 0) * 100) / 100;
  const row = {
    label,
    method,
    result: out.failure ? panicOf(out.failure).slice(0, 90) : 'ok',
    total: out.burntTgas,
    method_receipt: sum((p) => p.where === method),
    mpc: sum((p) => p.on === mpc),
    on_signed: sum((p) => p.where === 'on_signed'),
    rest: sum((p) => p.where !== method && p.on !== mpc && p.where !== 'on_signed'),
    parts,
    tx: out.hash,
  };
  console.log(`${label}: ${row.result}: ${row.total} TGas (method ${row.method_receipt}, MPC ${row.mpc}, on_signed ${row.on_signed}, rest ${row.rest}) tx ${out.hash}`);
  for (const p of parts) console.log(`    ${p.where.padEnd(42)} ${p.on.padEnd(36)} ${p.tgas}`);
  return { row, value: out.value };
}

const contractKey = loadKey(contract);
for (const [asset, price] of Object.entries(PRICES_E8)) {
  const out = await sendFresh(contractKey, contract, [actions.call('set_mock_price', { asset, price_e8: price }, 30n, 1n)]);
  if (out.failure) throw new Error(`set_mock_price ${asset}: ${panicOf(out.failure)}`);
  console.log(`set_mock_price ${asset} ${price}: ${out.burntTgas} TGas`);
}

const rows = [];
const got = {};
for (const [label, method, argsOf, deposit] of calls) {
  if (only && !only.some((o) => label.startsWith(o))) continue;
  let callArgs;
  try {
    callArgs = argsOf(got);
  } catch (e) {
    console.log(`${label}: skipped (${e.message})`);
    continue;
  }
  const { row, value } = await measure(label, method, callArgs, deposit ?? 0n);
  if (value && row.result === 'ok') got[method] = value;
  rows.push(row);
}

console.log('\n| call | result | total TGas | method | MPC | on_signed | rest |');
console.log('|---|---|---:|---:|---:|---:|---:|');
for (const r of rows) {
  console.log(`| ${r.label} | ${r.result.replace(/\|/g, '/')} | ${r.total} | ${r.method_receipt} | ${r.mpc} | ${r.on_signed} | ${r.rest} |`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2) + '\n');
