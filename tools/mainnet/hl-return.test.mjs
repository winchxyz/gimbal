// hl-return.mjs on a fake mainnet: both stages' dry runs, every refusal, and --send with fake submitters. No
// network: the 1Click quote is a recorded dry quote (fixtures/oneclick-arb-to-near-dry.json, 1Click's real
// signature) to the vectors' public test desk; every other id is a placeholder or a public test key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MONEY_METHODS } from './deploy.mjs';
import { OPERATOR_METHODS } from './desk.mjs';
import {
  ALLOWED_CALLS, HL_WITHDRAW_FEE_E6, bridgeMismatch, callProblem, checkBridgeQuote, deliveryHashes, guardedSend, hlWithdrawActions, hlWithdrawEntry,
  parseHlReturnArgs, recentWithdraws, relayerGas, runHlReturn, transferActionProblems, withdrawActionProblems, withdrawPlan,
} from './hl-return.mjs';
import { canonicalQuote } from './oneclick.mjs';
import { CANARY_LIMITS, MAINNET_ORDERLY_BROKER } from './venues.mjs';

const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/oneclick-arb-to-near-dry.json', import.meta.url)), 'utf8')).response;
const LIVE = JSON.parse(readFileSync(fileURLToPath(new URL('../../contract/core/tests/vectors/oneclick-live.json', import.meta.url)), 'utf8'));

const CONTRACT = 'gimbal-canary2.near';
const DESK_ID = 'canary';
const EVM = LIVE.desk.evm;
const SOL = LIVE.desk.sol;
const OWNER = LIVE.contract;
const PUBLIC = `ed25519:${'7'.repeat(44)}`;
const OP_PUBLIC = `ed25519:${'8'.repeat(44)}`;
const RELAYER_KEY = `0x${'11'.repeat(32)}`;
const RELAYER = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
const DEPOSIT = '0x' + '5d'.repeat(20);
const ARB_TX = `0x${'ab'.repeat(32)}`;
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const NEAR = 10n ** 24n;
const USDC = 1_000_000n;
const AT = Date.parse(FIXTURE.timestamp) + 1000;

const leb = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
function wasmWith(names) {
  const str = (s) => [...leb(s.length), ...Buffer.from(s)];
  const body = [...leb(names.length), ...names.flatMap((n) => [...str(n), 0, 0])];
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x07, ...leb(body.length), ...body]);
}
const C8 = wasmWith(['new', 'config', 'get_desk', 'hl_withdraw', 'evm_usdc_to_intents', ...MONEY_METHODS]);

const CONFIG = {
  network: 'Mainnet', mpc: 'v1.signer', price_source: { OutLayer: { contract: 'price-oracle.near' } },
  treasury: { near: 'treasury.near', hl_builder: '0x1111111111111111111111111111111111111111', referral_codes: { hyperliquid: null, orderly: null, phoenix: null } },
  fees: { performance_bps: 1000, hl_builder_tenth_bps: 10 },
  orderly: { broker_id: MAINNET_ORDERLY_BROKER, chain_id: 42161 },
};
const FEE = { send_sir: 100, send_not_sir: 100, execution: 100 };
const FEES = { receipt: FEE, deploy: FEE, deployByte: FEE, call: FEE, callByte: FEE, addKey: FEE, addKeyByte: FEE, deleteAccount: FEE };

const deskOf = (over = {}) => ({
  owner: OWNER, operator: null, paused: false, policy: { ...CANARY_LIMITS, unpriced_max_notional_usd: 20 },
  evm_address: EVM, solana: { authority: SOL, usdc_ata: 'UsdcAta111', phusd_ata: 'PhusdAta111', phoenix_trader: 'T' },
  orderly_account_id: `0x${'ab'.repeat(32)}`, orderly_receiver: null, orderly_ips: [],
  ledger: { deposited: 29_000_000, withdrawn: 5_000_000, fees_paid: 0, hwm: 0, idle_usdc: 12_000_000 },
  ...over,
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hex = (v) => `0x${BigInt(v).toString(16)}`;
const secp = { scheme: 'Secp256k1', big_r: { affine_point: `02${'cd'.repeat(32)}` }, s: { scalar: 'ef'.repeat(32) }, recovery_id: 0 };

/**
 * A fake mainnet, Hyperliquid, Arbitrum and 1Click. `o`: desk, withdrawable, hlLedger, arb ({ address: usdc e6 }),
 * wei ({ address: wei }), keyPublic, env, quote(body), onSend({ actions, desk, setDesk }) -> { value, logs, failure },
 * status (1Click), hlDown.
 */
function world(o = {}) {
  let desk = o.desk ?? deskOf();
  const arb = new Map(Object.entries(o.arb ?? {}).map(([k, v]) => [k.toLowerCase(), BigInt(v)]));
  const wei = new Map(Object.entries(o.wei ?? {}).map(([k, v]) => [k.toLowerCase(), BigInt(v)]));
  let hlLedger = o.hlLedger ?? [];
  const seen = { sent: [], fetch: [], keys: 0, quotes: [], posted: [], submitted: [] };
  const client = {
    rpc: async (method, params) => {
      if (method === 'status') return { chain_id: 'mainnet', sync_info: { latest_block_height: 1 } };
      if (method === 'gas_price') return { gas_price: '100000000' };
      if (method === 'tx') {
        return { receipts_outcome: [{ outcome: { executor_id: CONTRACT, logs: [`EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"deposit","data":[{"desk_id":"canary","sender":"intents.near","amount":"10500000","principal":false}]}`] } }], tx: params.tx_hash };
      }
      throw new Error(`unexpected rpc ${method}`);
    },
    view: async (id, method, args) => {
      if (id === CONTRACT && method === 'config') return CONFIG;
      if (id === CONTRACT && method === 'get_desk') return args.desk_id === DESK_ID ? desk : null;
      throw new Error(`unexpected view ${id}.${method}`);
    },
    account: async (id) => ({
      [CONTRACT]: { amount: String(6n * NEAR), locked: '0', storage_usage: 1000, code_hash: 'Code111' },
      [OWNER]: { amount: String(2n * NEAR), locked: '0', storage_usage: 500, code_hash: '11111111111111111111111111111111' },
    })[id] ?? null,
    code: async (id) => (id === CONTRACT ? C8 : null),
    accessKey: async (id, key) => {
      if (key === PUBLIC && id === OWNER) return { nonce: 1, permission: 'FullAccess' };
      if (key === OP_PUBLIC && id === OWNER) return { nonce: 1, permission: { FunctionCall: { allowance: String(5n * NEAR), receiver_id: CONTRACT, method_names: [...OPERATOR_METHODS] } } };
      return null;
    },
    fees: async () => FEES,
    send: async (signer, receiver, actions, { onSent } = {}) => {
      const hash = `Tx${seen.sent.length + 1}`;
      seen.sent.push({ signer: signer.publicKeyString, receiver, actions });
      onSent?.(hash);
      const r = o.onSend ? o.onSend({ actions, desk, setDesk: (d) => { desk = d; } }) : {};
      return { hash, burntTgas: 5, burntYocto: 10n ** 20n, logs: r.logs ?? [], failure: r.failure ?? null, value: r.value ?? null };
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    seen.fetch.push(`${init.method ?? 'GET'} ${u}${init.body === undefined ? '' : ` ${init.body}`}`);
    if (u.includes('hyperliquid.xyz/info')) {
      if (o.hlDown) return json({ error: 'down' }, 500);
      const body = JSON.parse(init.body);
      if (body.type === 'clearinghouseState') {
        const w = o.withdrawable ?? '11.682396';
        return json({ marginSummary: { accountValue: w, totalRawUsd: w }, withdrawable: w, assetPositions: [] });
      }
      if (body.type === 'userNonFundingLedgerUpdates') return json(hlLedger.filter((e) => e.time >= body.startTime));
    }
    if (u === 'https://arb.test/rpc') {
      const { method, params } = JSON.parse(init.body);
      if (method === 'eth_chainId') return json({ result: '0xa4b1' });
      if (method === 'eth_gasPrice') return json({ result: hex(10_000_000n) });
      if (method === 'eth_getBalance') return json({ result: hex(wei.get(params[0].toLowerCase()) ?? 0n) });
      if (method === 'eth_call') {
        const who = `0x${params[0].data.slice(-40)}`;
        return json({ result: hex(params[0].to === ARB_USDC ? arb.get(who) ?? 0n : 0n) });
      }
    }
    if (u.endsWith('/v0/quote')) {
      const body = JSON.parse(init.body);
      seen.quotes.push(body);
      return o.quote ? o.quote(body) : json(FIXTURE, 201);
    }
    if (u.endsWith('/v0/deposit/submit')) {
      seen.posted.push(JSON.parse(init.body));
      return json({ status: 'PENDING_DEPOSIT' });
    }
    if (u.includes('/v0/status?depositAddress=')) return json(o.status ?? { status: 'SUCCESS', swapDetails: { destinationChainTxHashes: [{ hash: 'NearDelivery1', explorerUrl: '' }] } });
    if (u.startsWith('https://api.nearblocks.io/v1/txns/')) return json({ txns: [{ transaction_hash: u.split('/').pop(), signer_account_id: 'solver.near' }] });
    throw new Error(`unexpected fetch ${u}`);
  };
  const readKey = (_file, accountId) => {
    seen.keys++;
    return { accountId, publicKeyString: o.keyPublic ?? PUBLIC };
  };
  const engine = async () => ({
    parseSignedAction: (await import('../../engine/src/contract/near-client.ts')).parseSignedAction,
    HyperliquidSubmitter: class {
      async submit(signed, desk) {
        seen.submitted.push({ venue: 'hyperliquid', signed, desk });
        if (o.hlSubmit) return o.hlSubmit({ signed, setLedger: (l) => { hlLedger = l; }, arb });
        return { confirmed: false, tx: [] };
      }
    },
    ArbitrumSubmitter: class {
      constructor(options) {
        seen.arbOptions = options;
      }
      async submit(signed, desk) {
        seen.submitted.push({ venue: 'arbitrum', signed, desk });
        if (o.arbSubmit) return o.arbSubmit({ signed, arb });
        return [{ chain: 'arbitrum', id: ARB_TX, url: '' }];
      }
    },
  });
  const env = o.env ?? new Map([['ONECLICK_API_KEY', { value: null, from: null }], ['RELAYER_EVM_PRIVATE_KEY', { value: null, from: null }]]);
  return {
    seen,
    deps: {
      near: client, fetch: fetchImpl, now: () => o.now ?? AT, tree: null, readKey, env, engine, sleep: async () => {}, pollMs: 0,
      urls: { arbitrum: 'https://arb.test/rpc', shown: { arbitrum: 'arb.test' } },
    },
  };
}

async function capture(argv, deps) {
  const lines = [];
  try {
    const block = await runHlReturn(argv, { ...deps, say: (s = '') => lines.push(s) });
    return { out: lines.join('\n'), block, error: null };
  } catch (e) {
    return { out: lines.join('\n'), block: null, error: e };
  }
}

const withRelayer = new Map([['ONECLICK_API_KEY', { value: null, from: null }], ['RELAYER_EVM_PRIVATE_KEY', { value: RELAYER_KEY, from: '.env' }]]);

// --- arguments and guards ---

test('arguments: stages, amounts, the flags each stage takes', () => {
  assert.equal(parseHlReturnArgs([CONTRACT, DESK_ID, 'withdraw', 'all']).amount, null);
  assert.equal(parseHlReturnArgs([CONTRACT, DESK_ID, 'bridge', '10.6']).amount, 10_600_000n);
  assert.match(parseHlReturnArgs([CONTRACT, DESK_ID, 'bridge', 'all']).keyFile, /operator-gimbal-canary2\.near\.json$/);
  assert.throws(() => parseHlReturnArgs([CONTRACT, DESK_ID, 'swap', '1']), /stage swap is not one of withdraw, bridge/);
  assert.throws(() => parseHlReturnArgs([CONTRACT, DESK_ID, 'withdraw', '1', '--slippage-bps', '100']), /--slippage-bps is for the bridge stage/);
  assert.throws(() => parseHlReturnArgs([CONTRACT, DESK_ID, 'withdraw', '5', '--send']), /withdraw --send needs --key-file/);
  assert.throws(() => parseHlReturnArgs([CONTRACT, DESK_ID, 'bridge', '5', '--slippage-bps', '5']), /from 10 to 300/);
  assert.throws(() => parseHlReturnArgs([CONTRACT, DESK_ID, 'bridge', '1.0000001']), /not a USDC amount/);
});

test('--send refuses in a linked git worktree before anything is read, both stages', async () => {
  const touched = new Proxy({}, { get: () => { throw new Error('read before the refusal'); } });
  const deps = { tree: '/w/tree', near: touched, fetch: touched, readKey: () => { throw new Error('key read'); }, say: () => {} };
  for (const argv of [[CONTRACT, DESK_ID, 'withdraw', '5', '--key-file', 'k.json', '--send'], [CONTRACT, DESK_ID, 'bridge', 'all', '--send']]) {
    await assert.rejects(runHlReturn(argv, deps), /\/w\/tree is a linked git worktree: --send runs from the main checkout only/, argv.join(' '));
  }
});

test('the allow-list: each stage sends its one method to the contract, nothing else is signed', async () => {
  assert.deepEqual(ALLOWED_CALLS, { withdraw: ['hl_withdraw'], bridge: ['evm_usdc_to_intents'] });
  const call = (m) => [{ type: 'FunctionCall', method: m }];
  assert.equal(callProblem('withdraw', CONTRACT, CONTRACT, call('hl_withdraw')), null);
  assert.equal(callProblem('bridge', CONTRACT, CONTRACT, call('evm_usdc_to_intents')), null);
  assert.match(callProblem('withdraw', CONTRACT, CONTRACT, call('evm_usdc_to_intents')), /not a call of the withdraw stage/);
  assert.match(callProblem('bridge', CONTRACT, CONTRACT, call('withdraw_to_owner')), /not a call of the bridge stage/);
  assert.match(callProblem('bridge', CONTRACT, 'usdc.near', call('evm_usdc_to_intents')), /this script calls gimbal-canary2\.near only/);
  assert.match(callProblem('withdraw', CONTRACT, CONTRACT, [{ type: 'DeleteAccount' }]), /DeleteAccount is not a call/);
  let sent = 0;
  const send = guardedSend({ send: async () => { sent++; } }, 'withdraw', CONTRACT);
  await assert.rejects(send({}, CONTRACT, call('hl_send_to_intents')), /refused, nothing was signed/);
  assert.equal(sent, 0);
});

// --- withdraw ---

test('withdrawPlan: all is the withdrawable; over it or at most the 1 USDC fee is refused; amount - 1 arrives', () => {
  assert.deepEqual(withdrawPlan(null, 11_682_396n), { amount: 11_682_396n, arrival: 10_682_396n });
  assert.deepEqual(withdrawPlan(5n * USDC, 11_682_396n), { amount: 5n * USDC, arrival: 4n * USDC });
  assert.throws(() => withdrawPlan(12n * USDC, 11_682_396n), /12 USDC is over the desk's Hyperliquid perps withdrawable, 11\.682396/);
  assert.throws(() => withdrawPlan(HL_WITHDRAW_FEE_E6, 11n * USDC), /is not more than Hyperliquid's 1 USDC withdrawal fee/);
  assert.throws(() => withdrawPlan(null, 400_000n), /\(all of the withdrawable\) is not more than/);
  // The contract's amount format: a canonical decimal string, no trailing zeros, at most 6 decimals.
  assert.deepEqual(hlWithdrawActions(DESK_ID, 11_682_396n)[0].args, { desk_id: DESK_ID, amount: '11.682396' });
  assert.deepEqual(hlWithdrawActions(DESK_ID, 5_000_000n)[0].args, { desk_id: DESK_ID, amount: '5' });
  assert.deepEqual(hlWithdrawActions(DESK_ID, 1_500_000n)[0].args, { desk_id: DESK_ID, amount: '1.5' });
});

test('withdraw dry run: hl_withdraw with 1 yocto and 300 TGas, the expected arrival; no key, nothing sent', async () => {
  const { seen, deps } = world();
  const r = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /FunctionCall hl_withdraw {2}gas 300 TGas {2}deposit 0\.000000000000000000000001 NEAR/);
  assert.ok(r.out.includes('args {"desk_id":"canary","amount":"11.682396"}'));
  assert.match(r.out, /an action method needs at least 85/);
  assert.match(r.out, /so 10\.682396 USDC arrives on Arbitrum \(desk EVM 0 -> 10\.682396\)/);
  assert.match(r.block[0], /^=== gimbal hl-return 2026-11-03T\S+ ===$/);
  assert.deepEqual(r.block.slice(-1), ['=== end ===']);
  assert.ok(r.block.some((l) => l.startsWith('withdraw: hl_withdraw {"desk_id":"canary","amount":"11.682396"} planned; 10.682396 USDC expected')));
  assert.equal(seen.keys + seen.sent.length, 0);
});

test('withdraw refusals: over the withdrawable, an unreadable Hyperliquid (fails closed), a key that is not the owner\'s', async () => {
  const over = await capture([CONTRACT, DESK_ID, 'withdraw', '12'], world().deps);
  assert.match(over.error.message, /over the desk's Hyperliquid perps withdrawable/);
  const down = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], world({ hlDown: true }).deps);
  assert.match(down.error.message, /hyperliquid clearinghouseState: HTTP 500/);
  const op = world({ keyPublic: OP_PUBLIC });
  const k = await capture([CONTRACT, DESK_ID, 'withdraw', 'all', '--key-file', 'k.json', '--send'], op.deps);
  assert.match(k.error.message, /--key-file is not a full-access key of the desk owner/);
  assert.equal(op.seen.sent.length, 0);
});

test('withdraw dry run: a withdrawal booked under 30 min ago shows as possibly in flight', async () => {
  const entry = { time: AT - 5 * 60_000, hash: '0xw1', delta: { type: 'withdraw', usdc: '3.0', nonce: 1, fee: '1.0' } };
  const r = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], world({ hlLedger: [entry] }).deps);
  assert.ok(r.block.some((l) => /^earlier: {2}withdraw of 3 USDC at .* \(under 30 min ago: may still be on its way to Arbitrum\), 0xw1$/.test(l)), r.block.join('\n'));
  assert.equal(recentWithdraws([{ type: 'withdraw', time: AT - 3_600_000 }], AT)[0].inFlight, false);
});

const withdrawSigned = (over = {}) => ({
  desk_id: DESK_ID, request_id: 7, venue: 'hyperliquid', kind: 'withdraw3',
  payload: { action: { type: 'withdraw3', signatureChainId: '0xa4b1', hyperliquidChain: 'Mainnet', destination: EVM, amount: '11.682396', time: 1_793_668_600_000, ...over }, nonce: 1_793_668_600_000 },
  signature: secp,
});

test('withdraw --send: hl_withdraw by the owner, the SignedAction posted, Hyperliquid\'s ledger, then the Arbitrum arrival', async () => {
  const w = world({
    onSend: () => ({ value: withdrawSigned() }),
    hlSubmit: ({ setLedger, arb }) => {
      setLedger([{ time: AT + 1000, hash: '0xhlw', delta: { type: 'withdraw', usdc: '11.682396', nonce: 1_793_668_600_000, fee: '1.0' } }]);
      arb.set(EVM.toLowerCase(), 10_682_396n);
      return { confirmed: true, tx: [{ chain: 'hyperliquid', id: '0xhlw' }] };
    },
  });
  const r = await capture([CONTRACT, DESK_ID, 'withdraw', 'all', '--key-file', 'k.json', '--send'], w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.equal(w.seen.sent.length, 1);
  assert.equal(w.seen.sent[0].actions[0].method, 'hl_withdraw');
  assert.equal(w.seen.sent[0].actions[0].deposit, 1n);
  assert.equal(w.seen.sent[0].signer, PUBLIC);
  assert.equal(w.seen.submitted.length, 1);
  assert.equal(w.seen.submitted[0].desk, EVM);
  assert.ok(r.block.some((l) => /^ledger: {3}Hyperliquid withdraw 11\.682396 USDC fee 1\.0 at .*, 0xhlw$/.test(l)), r.block.join('\n'));
  assert.ok(r.block.includes('arbitrum: desk EVM USDC 0 -> 10.682396 (expected +10.682396)'));
  assert.ok(r.block.includes('arrived:  yes'));

  // Not arrived within the timeout: "not yet".
  const slow = world({ onSend: () => ({ value: withdrawSigned() }), now: AT });
  let t = AT;
  const s = await capture([CONTRACT, DESK_ID, 'withdraw', 'all', '--key-file', 'k.json', '--send', '--timeout-s', '60'], { ...slow.deps, now: () => (t += 10_000) });
  assert.ok(s.block.some((l) => /^arrived: {2}not yet \(after 60 s\)/.test(l)), s.block?.join('\n') ?? s.error?.stack);
});

test('withdraw --send: a signed action that is not the withdrawal asked for is never posted', async () => {
  for (const [over, why] of [[{ destination: '0x3333333333333333333333333333333333333333' }, /destination .* is not the desk EVM address/], [{ amount: '11.6' }, /amount "11\.6" is not "11\.682396"/], [{ type: 'usdClassTransfer' }, /action type usdClassTransfer, not withdraw3/]]) {
    const w = world({ onSend: () => ({ value: withdrawSigned(over) }) });
    const r = await capture([CONTRACT, DESK_ID, 'withdraw', 'all', '--key-file', 'k.json', '--send'], w.deps);
    assert.match(r.error?.message ?? '', why);
    assert.equal(w.seen.submitted.length, 0);
  }
  assert.deepEqual(withdrawActionProblems(withdrawSigned(), { deskId: DESK_ID, evm: EVM.toUpperCase().replace('0X', '0x'), amountText: '11.682396' }), []);
});

test('hlWithdrawEntry: by the action\'s nonce when the entry has one, else by the amount (or the amount less the fee)', () => {
  const e = (delta, time = 10) => ({ time, hash: 'h', type: delta.type, usdcE6: delta.usdc === undefined ? null : BigInt(Math.round(Number(delta.usdc) * 1e6)), delta });
  assert.ok(hlWithdrawEntry([e({ type: 'withdraw', usdc: '5', nonce: 42 })], { since: 0, nonce: 42, amountE6: 5n * USDC }));
  assert.equal(hlWithdrawEntry([e({ type: 'withdraw', usdc: '5', nonce: 41 })], { since: 0, nonce: 42, amountE6: 5n * USDC }), null);
  assert.ok(hlWithdrawEntry([e({ type: 'withdraw', usdc: '4' })], { since: 0, nonce: 42, amountE6: 5n * USDC }));
  assert.equal(hlWithdrawEntry([e({ type: 'withdraw', usdc: '3' })], { since: 0, nonce: 42, amountE6: 5n * USDC }), null);
  assert.equal(hlWithdrawEntry([e({ type: 'deposit', usdc: '5' })], { since: 0, nonce: 42, amountE6: 5n * USDC }), null);
  assert.equal(hlWithdrawEntry([e({ type: 'withdraw', usdc: '5', nonce: 42 }, 5)], { since: 6, nonce: 42, amountE6: 5n * USDC }), null);
});

// --- bridge ---

test('bridge dry run with 0 USDC on Arbitrum and no relayer: the quote is still shown, then "would refuse at --send"', async () => {
  const { seen, deps } = world();
  const r = await capture([CONTRACT, DESK_ID, 'bridge', '10.6'], deps);
  assert.match(r.error?.message ?? '', /^--send would refuse: 10\.6 USDC is over the desk EVM's 0 USDC on Arbitrum/);
  assert.equal(seen.quotes.length, 1);
  const body = seen.quotes[0];
  assert.equal(body.dry, true);
  assert.equal(body.originAsset, 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near');
  assert.equal(body.destinationAsset, 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
  assert.equal(body.recipient, CONTRACT);
  assert.equal(body.customRecipientMsg, '{"desk_id":"canary"}');
  assert.equal(body.refundTo, EVM);
  assert.equal(body.amount, '10600000');
  assert.match(r.out, /verified {2}1Click's signature over the canonical quote; evm_usdc_to_intents's field rules/);
  assert.match(r.out, /FunctionCall evm_usdc_to_intents {2}gas 300 TGas {2}deposit 0 NEAR/);
  assert.ok(r.out.includes(JSON.stringify(canonicalQuote(FIXTURE))), 'the quote goes to the contract as the exact signed string');
  assert.match(r.out, /expected {2}idle_usdc 12 -> at least 22\.491984 \(minAmountOut 10\.491984\); deposited stays 29/);
  // The dry run prints its block, then refuses (exit 1) for what --send would refuse.
  r.block = r.out.slice(r.out.indexOf('=== gimbal hl-return'), r.out.indexOf('=== end ===') + 11).split('\n');
  assert.ok(r.block.includes('quote:    dry, amountIn 10600000, amountOut 10597964, minAmountOut 10491984; cost 0.108016 of 1 allowed, room 100 bps'), r.block.join('\n'));
  assert.ok(r.block.some((l) => l.startsWith('would refuse at --send: 10.6 USDC is over the desk EVM\'s 0 USDC on Arbitrum')));
  assert.ok(r.block.some((l) => l.startsWith('would refuse at --send: no relayer wallet: RELAYER_EVM_PRIVATE_KEY is not set')));
  assert.equal(seen.keys + seen.sent.length, 0);
});

test('bridge dry run with the USDC there and a funded relayer: no refusal; "all" is the whole Arbitrum balance', async () => {
  const { seen, deps } = world({ arb: { [EVM]: 10_600_000n }, wei: { [RELAYER]: 10n ** 15n }, env: withRelayer });
  const r = await capture([CONTRACT, DESK_ID, 'bridge', 'all'], deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.equal(seen.quotes[0].amount, '10600000');
  assert.match(r.out, new RegExp(`relayer {3}${RELAYER} \\(RELAYER_EVM_PRIVATE_KEY from \\.env; not shown\\): 0\\.001000 ETH; one transfer needs at most 0\\.000005 ETH \\(500,000 gas at 0\\.01 gwei\\)`));
  assert.doesNotMatch(r.out + seen.fetch.join('\n'), new RegExp(RELAYER_KEY.slice(2)));
  assert.ok(!r.block.some((l) => l.startsWith('would refuse')));
});

test('bridge refusals: nothing on Arbitrum for all; --send checks balance and relayer before any quote or key', async () => {
  const empty = await capture([CONTRACT, DESK_ID, 'bridge', 'all'], world().deps);
  assert.match(empty.error.message, /holds no USDC on Arbitrum: nothing to bridge \(run the withdraw stage first\)/);
  const short = world({ arb: { [EVM]: 5n * USDC }, wei: { [RELAYER]: 10n ** 15n }, env: withRelayer });
  const s = await capture([CONTRACT, DESK_ID, 'bridge', '10.6', '--send'], short.deps);
  assert.match(s.error.message, /10\.6 USDC is over the desk EVM's 5 USDC on Arbitrum/);
  assert.equal(short.seen.quotes.length + short.seen.keys + short.seen.sent.length, 0);
  const broke = world({ arb: { [EVM]: 10_600_000n }, wei: { [RELAYER]: 1000n }, env: withRelayer });
  const b = await capture([CONTRACT, DESK_ID, 'bridge', 'all', '--send'], broke.deps);
  assert.match(b.error.message, /the relayer wallet 0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a holds 0\.000000 ETH on Arbitrum, under the 0\.000005 ETH/);
  assert.equal(broke.seen.quotes.length, 0);
  const cap = await capture([CONTRACT, DESK_ID, 'bridge', '25', '--send'], world({ arb: { [EVM]: 30n * USDC }, wei: { [RELAYER]: 10n ** 15n }, env: withRelayer }).deps);
  assert.match(cap.error.message, /over the hourly rescue cap of 20 USD: the contract refuses it \(E_RESCUE_CAP\)/);
  assert.deepEqual(relayerGas(5_000_000_000_000n, 10_000_000n), { need: 5_000_000_000_000n, ok: true });
});

test('bridge: a quote that is not the bridge asked for, or over the policy\'s cost, is refused before signing', async () => {
  const quote = canonicalQuote(FIXTURE);
  const ask = { contract: CONTRACT, deskId: DESK_ID, evm: EVM, amount: 10_600_000n, slippage: 100 };
  assert.deepEqual(bridgeMismatch(quote, ask), []);
  assert.match(bridgeMismatch(quote, { ...ask, amount: 10n * USDC }).join(), /amountIn 10600000 is not the 10 USDC asked/);
  assert.match(bridgeMismatch(quote, { ...ask, slippage: 50 }).join(), /slippageTolerance 100 is not the 50 asked/);
  assert.match(bridgeMismatch(quote, { ...ask, deskId: 'other' }).join(), /customRecipientMsg .* is not \{"desk_id":"other"\}/);
  assert.match(bridgeMismatch(quote, { ...ask, contract: 'other.near' }).join(), /recipient gimbal-canary2\.near is not the contract other\.near/);
  // The contract's own rules: another desk's message, or a cost over the policy.
  const policy = { ...CANARY_LIMITS, unpriced_max_notional_usd: 20 };
  const ctx = { contract: CONTRACT, deskId: DESK_ID, desk: deskOf(), policy, now: AT, dry: true };
  assert.equal(checkBridgeQuote(FIXTURE, ctx).cost, 10_801_600n);
  assert.throws(() => checkBridgeQuote(FIXTURE, { ...ctx, deskId: 'other' }), /E_QUOTE_FIELDS: customRecipientMsg must name this desk exactly/);
  assert.throws(() => checkBridgeQuote(FIXTURE, { ...ctx, policy: { ...policy, max_transfer_cost_bps: 10, max_transfer_cost_flat_e6: 50_000 } }), /E_QUOTE_FIELDS: the transfer may cost 0\.108016 USDC/);
  assert.throws(() => checkBridgeQuote(FIXTURE, { ...ctx, dry: false }), /not a live quote with a deposit address/);
  assert.throws(() => checkBridgeQuote({ ...FIXTURE, signature: FIXTURE.signature.replace(/.$/, (c) => (c === '1' ? '2' : '1')) }, ctx), /E_QUOTE_SIGNATURE/);
  const r = await capture([CONTRACT, DESK_ID, 'bridge', '10'], world({ arb: { [EVM]: 20n * USDC } }).deps);
  assert.match(r.error.message, /the quote is not the bridge asked for: nothing was signed[\s\S]*amountIn 10600000 is not the 10 USDC asked/);
});

const transferSigned = (over = {}) => ({
  desk_id: DESK_ID, request_id: 9, venue: 'arbitrum', kind: 'transfer_with_authorization',
  payload: { from: EVM, to: DEPOSIT, value: '10600000', validAfter: '0', validBefore: String(Math.floor(AT / 1000) + 300), nonce: `0x${'77'.repeat(32)}`, token: ARB_USDC, chainId: 42161, ...over },
  signature: secp,
});

/** --send needs a live quote, which only 1Click can sign: the recorded dry one, checked as dry, with a deposit address. */
const liveLike = async (deps) => {
  const { checkBridgeQuote: check } = await import('./hl-return.mjs');
  return { ...deps, checkQuote: (body, ctx) => { const c = check(body, { ...ctx, dry: true }); return { ...c, q: { ...c.q, depositAddress: DEPOSIT } }; } };
};

test('bridge --send: evm_usdc_to_intents by the operator key, the relayer submits, 1Click status, then the ledger credit', async () => {
  const w = world({
    arb: { [EVM]: 10_600_000n }, wei: { [RELAYER]: 10n ** 15n }, env: withRelayer, keyPublic: OP_PUBLIC,
    onSend: ({ desk, setDesk }) => {
      setDesk({ ...desk, ledger: { ...desk.ledger, idle_usdc: 12_000_000 + 10_500_000 } });
      return { value: transferSigned() };
    },
  });
  const r = await capture([CONTRACT, DESK_ID, 'bridge', 'all', '--send'], await liveLike(w.deps));
  assert.equal(r.error, null, r.error?.stack);
  assert.equal(w.seen.quotes[0].dry, false, '--send asks a live quote');
  assert.equal(w.seen.sent.length, 1);
  assert.equal(w.seen.sent[0].actions[0].method, 'evm_usdc_to_intents');
  assert.equal(w.seen.sent[0].actions[0].deposit, 0n);
  assert.equal(w.seen.sent[0].signer, OP_PUBLIC);
  assert.equal(w.seen.sent[0].actions[0].args.quote, canonicalQuote(FIXTURE));
  assert.equal(w.seen.arbOptions.relayerKey, RELAYER_KEY);
  assert.equal(w.seen.submitted[0].desk, EVM);
  assert.deepEqual(w.seen.posted, [{ txHash: ARB_TX, depositAddress: DEPOSIT }]);
  assert.ok(r.block.includes('1click:   status SUCCESS'));
  assert.ok(r.block.includes('event:    deposit {"desk_id":"canary","sender":"intents.near","amount":"10500000","principal":false} (NEAR tx NearDelivery1)'), r.block.join('\n'));
  assert.ok(r.block.includes('landed:   yes: 1Click SUCCESS and idle_usdc up 10.5 USDC (>= minAmountOut 10.491984)'), r.block.join('\n'));
  assert.doesNotMatch(r.out, new RegExp(RELAYER_KEY.slice(2)));

  // SUCCESS without the ledger credit is not a landing.
  const nocredit = world({ arb: { [EVM]: 10_600_000n }, wei: { [RELAYER]: 10n ** 15n }, env: withRelayer, keyPublic: OP_PUBLIC, onSend: () => ({ value: transferSigned() }) });
  const n = await capture([CONTRACT, DESK_ID, 'bridge', 'all', '--send'], await liveLike(nocredit.deps));
  assert.ok(n.block.some((l) => /^landed: {3}not seen: 1Click SUCCESS but idle_usdc is up 0 USDC/.test(l)), n.block?.join('\n') ?? n.error?.stack);
  // A refund: the USDC goes back to the desk EVM address.
  const refunded = world({ arb: { [EVM]: 10_600_000n }, wei: { [RELAYER]: 10n ** 15n }, env: withRelayer, keyPublic: OP_PUBLIC, status: { status: 'REFUNDED' }, onSend: () => ({ value: transferSigned() }) });
  const f = await capture([CONTRACT, DESK_ID, 'bridge', 'all', '--send'], await liveLike(refunded.deps));
  assert.match(f.error.message, /1Click ended the bridge REFUNDED: the USDC goes back to the desk EVM address/);
});

test('bridge --send: a signed authorization that is not the quote\'s transfer is never submitted; a full-access key signs nothing', async () => {
  for (const [over, why] of [[{ to: '0x' + '66'.repeat(20) }, /to .* is not the quote's deposit address/], [{ value: '20000000' }, /value 20000000 is not the quote's amountIn 10600000/], [{ chainId: 1 }, /chainId 1 is not 42161/]]) {
    const w = world({ arb: { [EVM]: 10_600_000n }, wei: { [RELAYER]: 10n ** 15n }, env: withRelayer, keyPublic: OP_PUBLIC, onSend: () => ({ value: transferSigned(over) }) });
    const r = await capture([CONTRACT, DESK_ID, 'bridge', 'all', '--send'], await liveLike(w.deps));
    assert.match(r.error?.message ?? '', why);
    assert.equal(w.seen.submitted.length, 0);
    assert.equal(w.seen.posted.length, 0);
  }
  assert.deepEqual(transferActionProblems(transferSigned(), { deskId: DESK_ID, evm: EVM, depositAddress: DEPOSIT, amountIn: 10_600_000n }), []);
  const full = world({ arb: { [EVM]: 10_600_000n }, wei: { [RELAYER]: 10n ** 15n }, env: withRelayer, keyPublic: PUBLIC });
  const k = await capture([CONTRACT, DESK_ID, 'bridge', 'all', '--send'], await liveLike(full.deps));
  assert.match(k.error.message, /is not .*'s operator key for gimbal-canary2\.near/);
  assert.equal(full.seen.sent.length + full.seen.quotes.length, 0);
});

test('bridge --send: when the relayer\'s outcome is unknown, the block says to wait out the authorization', async () => {
  const w = world({
    arb: { [EVM]: 10_600_000n }, wei: { [RELAYER]: 10n ** 15n }, env: withRelayer, keyPublic: OP_PUBLIC, onSend: () => ({ value: transferSigned() }),
    arbSubmit: () => { throw Object.assign(new Error('no receipt for 0xabc'), { name: 'OutcomeUnknown' }); },
  });
  const r = await capture([CONTRACT, DESK_ID, 'bridge', 'all', '--send'], await liveLike(w.deps));
  assert.match(r.error.message, /no receipt/);
  assert.match(r.out, /open: {5}authorization nonce 0x7{64} to 0x(5d){20} stays valid until .*: do not run bridge again before then/);
  assert.equal(w.seen.posted.length, 0);
  assert.deepEqual(deliveryHashes({ swapDetails: { destinationChainTxHashes: [{ hash: 'A' }, 'B', {}] } }), ['A', 'B']);
});
