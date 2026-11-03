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
  ALLOWED_CALLS, HL_REPLAY_MS, HL_WITHDRAW_FEE_E6, authorizationProblem, bridgeMismatch, callProblem, checkBridgeQuote, counterGuards, deliveryHashes,
  depositAddressOf, eip3009NonceOf, guardedSend, quoteObjectOf,
  hlWithdrawActions, hlWithdrawEntry, parseHlReturnArgs, recentWithdraws, relayerGas, runHlReturn, transferActionProblems, withdrawActionProblems,
  withdrawGuards, withdrawNonceMs, withdrawPlan,
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

/**
 * A DeskCounters record (contract/src/rescue.rs, borsh): `next` the EIP-3009 counter, `paid` the ring's paid times. The
 * C8 canary's layout (1,329 bytes), or with `final` the final contract's (1,369 bytes: rescue_quote_e8 before the
 * counter, the notional meter after the paid times).
 */
function countersRecord({ next = 0, paid = [], final = false }) {
  const at = final ? 56 : 40;
  const buf = Buffer.alloc(final ? 1369 : 1329);
  buf.writeBigUInt64LE(BigInt(Math.max(0, ...paid)), 0);
  buf.writeBigUInt64LE(BigInt(next), at);
  buf.writeUInt8(paid.length % 32, at + 8 + 1024);
  paid.forEach((ms, i) => buf.writeBigUInt64LE(BigInt(ms), at + 8 + 1024 + 1 + 8 * i));
  return buf;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hex = (v) => `0x${BigInt(v).toString(16)}`;
const secp = { scheme: 'Secp256k1', big_r: { affine_point: `02${'cd'.repeat(32)}` }, s: { scalar: 'ef'.repeat(32) }, recovery_id: 0 };

/**
 * A fake mainnet, Hyperliquid, Arbitrum, 1Click and nearblocks. `o`: desk, withdrawable, hlLedger, arb ({ address:
 * usdc e6 }), wei ({ address: wei }), keyPublic, env, quote(body), onSend({ actions, desk, setDesk }) -> { value,
 * logs, failure }, sendThrows, status (1Click, after a send), earlierStatus ({ deposit address: status }), hlDown,
 * calls ({ method: nearblocks txns }), nearblocksDown, hlNonce (BigInt), counters ({ next, paid }), stateDown
 * ([prefix]), authUsed / authDown (authorizationState on Arbitrum USDC), hlSubmit, arbSubmit.
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
    // The contract state: the desk's HlNonces record (prefix 3, o.hlNonce, BigInt ms) and DeskCounters (prefix 5,
    // o.counters { next, paid: [ms] }). o.stateDown: the prefixes whose read fails.
    state: async (id, prefix) => {
      const key = Buffer.from(prefix);
      if (o.stateDown?.includes(key[0])) throw new Error('view_state: timeout');
      if (id !== CONTRACT) return [];
      if (key[0] === 3 && o.hlNonce !== undefined) {
        const value = Buffer.alloc(8);
        value.writeBigUInt64LE(o.hlNonce);
        return [{ key, value }];
      }
      if (key[0] === 5 && o.counters !== undefined) return [{ key, value: countersRecord(o.counters) }];
      return [];
    },
    send: async (signer, receiver, actions, { onSent } = {}) => {
      const hash = `Tx${seen.sent.length + 1}`;
      seen.sent.push({ signer: signer.publicKeyString, receiver, actions });
      onSent?.(hash);
      if (o.sendThrows) throw new Error(o.sendThrows);
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
      if (method === 'eth_call' && params[0].data.startsWith('0xe94a0102')) {
        seen.authChecks = [...(seen.authChecks ?? []), { to: params[0].to, data: params[0].data }];
        if (o.authDown) return json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'rate limited' } });
        return json({ result: `0x${(o.authUsed ? 1n : 0n).toString(16).padStart(64, '0')}` });
      }
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
    if (u.includes('/v0/status?depositAddress=')) {
      const address = decodeURIComponent(u.split('depositAddress=')[1]);
      if (o.earlierStatus?.[address] !== undefined) return json({ status: o.earlierStatus[address] });
      return json(o.status ?? { status: 'SUCCESS', swapDetails: { destinationChainTxHashes: [{ hash: 'NearDelivery1', explorerUrl: '' }] } });
    }
    if (u.startsWith('https://api.nearblocks.io/v1/txns/')) return json({ txns: [{ transaction_hash: u.split('/').pop(), signer_account_id: 'solver.near' }] });
    if (u.startsWith(`https://api.nearblocks.io/v1/account/${CONTRACT}/txns?method=`)) {
      if (o.nearblocksDown) return json({ message: 'rate limited' }, 429);
      const method = new URL(u).searchParams.get('method');
      return json({ txns: o.calls?.[method] ?? [] });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const readKey = (_file, accountId) => {
    seen.keys++;
    return { accountId, publicKeyString: o.keyPublic ?? PUBLIC };
  };
  const engine = async () => ({
    parseSignedAction: (await import('../../engine/src/contract/near-client.ts')).parseSignedAction,
    HyperliquidSubmitter: class {
      constructor(options) {
        seen.hlOptions = options;
      }
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
      near: client, fetch: fetchImpl, now: () => o.now ?? AT, tree: null, readKey, env, engine, sleep: async () => {}, pollMs: 0, lock: async () => freeLock,
      urls: { arbitrum: 'https://arb.test/rpc', shown: { arbitrum: 'arb.test' } },
    },
  };
}

/** The rescuer's lock, always free: the real one is tested once, below. */
const freeLock = {
  rescueLockName: (_env, mode, contract, desk) => `fake-${mode}-${contract}-${desk}`, lockText: (n) => n, lockHeld: async () => false,
  acquireRescueLock: async (name) => ({ name, release: async () => {} }),
};

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

/** The summary block a run printed (a dry run that refuses prints it, then throws). */
const blockOf = (r) => r.block ?? (r.out.includes('=== gimbal hl-return') ? r.out.slice(r.out.indexOf('=== gimbal hl-return'), r.out.indexOf('=== end ===') + 11).split('\n') : []);

/**
 * A nearblocks /account/<contract>/txns item, in the shape the live API answers (2026-11-03): the receipt block
 * time as a number of ns, the first receipt's status, the call's args as a JSON string.
 */
const nbTx = (method, { hash, ms, args, ok = true }) => ({
  transaction_hash: hash, predecessor_account_id: OWNER, block_timestamp: String(BigInt(ms - 700) * 1_000_000n),
  receipt_block: { block_timestamp: ms * 1e6 + 856_300 }, receipt_outcome: { status: ok }, outcomes: { status: ok },
  actions: [{ action: 'FUNCTION_CALL', method, args: JSON.stringify(args) }],
});
/** The ledger entry Hyperliquid booked for a withdraw3 of `amount` at `time` (mainnet, 2026-11-03: nonce time x 1000, usdc amount - fee). */
const hlBooked = (time, amount = '11.682396', at = time + 231_000) => ({
  time: at, hash: `0x${'7e'.repeat(32)}`, delta: { type: 'withdraw', usdc: (Number(amount) - 1).toFixed(6), nonce: time * 1000, fee: '1.0' },
});

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

test('withdraw dry run: over the hourly rescue cap, it warns that the bridge goes in parts', async () => {
  const r = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], world({ withdrawable: '25.5' }).deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.match(r.out, /warning {3}24\.5 USDC arriving is over the desk's hourly rescue cap of 20 USD: the bridge stage takes it in parts an hour apart \(at most 20 USDC each\)/);
  assert.ok(r.block.some((l) => l.startsWith('warning:  24.5 USDC arriving is over the desk\'s hourly rescue cap')));
  const under = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], world({ withdrawable: '21' }).deps);
  assert.doesNotMatch(under.out, /hourly rescue cap/);
});

// --- withdraw: earlier withdrawals and signatures ---

const withdrawSigned = (over = {}) => ({
  desk_id: DESK_ID, request_id: 7, venue: 'hyperliquid', kind: 'withdraw3',
  payload: { action: { type: 'withdraw3', signatureChainId: '0x66eee', hyperliquidChain: 'Mainnet', destination: EVM, amount: '11.682396', time: AT + 2000, ...over }, nonce: AT + 2000 },
  signature: secp,
});
const WITHDRAW_SEND = [CONTRACT, DESK_ID, 'withdraw', 'all', '--key-file', 'k.json', '--send'];

const T_EARLIER = AT - 3 * 3_600_000;
const earlierWithdraw = (over = {}) => nbTx('hl_withdraw', { hash: 'EarlierW1', ms: T_EARLIER, args: { desk_id: DESK_ID, amount: '11.682396' }, ...over });

test('withdraw: a withdrawal under 30 min old refuses --send (before any key), the dry run lists it; --again sends', async () => {
  const entry = { time: AT - 5 * 60_000, hash: '0xw1', delta: { type: 'withdraw', usdc: '3.0', nonce: (AT - 9 * 60_000) * 1000, fee: '1.0' } };
  const dry = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], world({ hlLedger: [entry] }).deps);
  assert.match(dry.error?.message ?? '', /^--send would refuse: a Hyperliquid withdrawal of 3 USDC booked at .* is under 30 min old: it may still be on its way to Arbitrum/);
  const block = blockOf(dry);
  assert.ok(block.some((l) => /^earlier: {2}withdraw of 3 USDC at .* \(under 30 min ago: may still be on its way to Arbitrum\), 0xw1$/.test(l)), block.join('\n'));
  assert.ok(block.some((l) => l.startsWith('would refuse at --send: a Hyperliquid withdrawal of 3 USDC') && l.endsWith('(--again sends anyway)')), block.join('\n'));
  assert.equal(recentWithdraws([{ type: 'withdraw', time: AT - 3_600_000 }], AT)[0].inFlight, false);

  const send = world({ hlLedger: [entry] });
  const s = await capture([CONTRACT, DESK_ID, 'withdraw', 'all', '--key-file', 'k.json', '--send'], send.deps);
  assert.match(s.error?.message ?? '', /^withdraw --send refused, nothing was signed: a Hyperliquid withdrawal of 3 USDC/);
  assert.equal(send.seen.keys + send.seen.sent.length, 0);

  const again = world({ hlLedger: [entry], onSend: () => ({ value: withdrawSigned() }), hlSubmit: ({ arb }) => { arb.set(EVM.toLowerCase(), 10_682_396n); return { confirmed: false, tx: [] }; } });
  const g = await capture([CONTRACT, DESK_ID, 'withdraw', 'all', '--key-file', 'k.json', '--send', '--again'], again.deps);
  assert.equal(again.seen.sent.length, 1, g.error?.stack);
  assert.match(g.out, /override {2}a Hyperliquid withdrawal of 3 USDC .* \(--again\)/);
  assert.ok(g.block.some((l) => l.startsWith('override: a Hyperliquid withdrawal of 3 USDC')));
  assert.equal(parseHlReturnArgs([CONTRACT, DESK_ID, 'bridge', 'all', '--again']).again, true);
  assert.equal(parseHlReturnArgs([CONTRACT, DESK_ID, 'bridge', 'all']).again, false);
});

test('withdraw: an earlier hl_withdraw the ledger has not booked refuses within Hyperliquid\'s 2-day window; booked or refused calls do not', async () => {
  const unbooked = world({ calls: { hl_withdraw: [earlierWithdraw()] }, hlNonce: BigInt(T_EARLIER) });
  const r = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], unbooked.deps);
  const until = new Date(T_EARLIER + HL_REPLAY_MS).toISOString();
  assert.match(r.error?.message ?? '', /hl_withdraw EarlierW1 \(11\.682396 USDC\) signed a withdraw3 at about .* that the Hyperliquid ledger does not show/);
  assert.ok(r.error.message.includes(`Hyperliquid takes it until about ${until} (its nonce window)`), r.error.message);
  assert.match(r.out, /signed {4}hl_withdraw EarlierW1 \(11\.682396 USDC\) at .*: not in the Hyperliquid ledger; its withdraw3 can still be posted until about/);
  assert.ok(unbooked.seen.fetch.some((f) => f.startsWith(`GET https://api.nearblocks.io/v1/account/${CONTRACT}/txns?method=hl_withdraw&per_page=25`)));

  // Booked: the ledger entry's nonce is the withdraw3 time x 1000 (the receipt block's ms).
  const booked = world({ calls: { hl_withdraw: [earlierWithdraw()] }, hlNonce: BigInt(T_EARLIER), hlLedger: [hlBooked(T_EARLIER)] });
  const b = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], booked.deps);
  assert.equal(b.error, null, b.error?.stack ?? b.out);
  assert.match(b.out, new RegExp(`signed {4}hl_withdraw EarlierW1 \\(11\\.682396 USDC\\) at .*: booked, ledger 0x(7e){32} \\(nonce ${T_EARLIER}000\\)`));
  // A call the contract refused signed nothing; another desk's call is not this desk's.
  const refused = world({ calls: { hl_withdraw: [earlierWithdraw({ ok: false }), earlierWithdraw({ hash: 'Other1', args: { desk_id: 'other', amount: '5' } })] } });
  const f = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], refused.deps);
  assert.equal(f.error, null, f.error?.stack);
  assert.match(f.out, /hl_withdraw EarlierW1 at .*: refused by the contract \(nothing signed\)/);
  assert.doesNotMatch(f.out, /Other1/);
  // Older than the window: Hyperliquid no longer takes it.
  const old = withdrawGuards({ calls: [{ hash: 'Old', ms: AT - HL_REPLAY_MS - 1000, accepted: true, amount: '5', deskKnown: true }], entries: [], hlNonce: 0n, nowMs: AT });
  assert.deepEqual(old.refusals, []);
});

test('withdraw: nearblocks unreadable fails closed unless the desk\'s Hyperliquid nonce rules a live signature out; a nonce nearblocks has not indexed refuses', async () => {
  const down = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], world({ nearblocksDown: true, hlNonce: BigInt(AT - 3_600_000) }).deps);
  assert.match(down.error?.message ?? '', /nearblocks could not be read \(nearblocks hl_withdraw calls: HTTP 429\) and the desk signed a Hyperliquid action at .* that the ledger does not show as a withdraw/);
  const bookedNonce = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], world({ nearblocksDown: true, hlNonce: BigInt(T_EARLIER), hlLedger: [hlBooked(T_EARLIER)] }).deps);
  assert.equal(bookedNonce.error, null, bookedNonce.error?.stack);
  const oldNonce = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], world({ nearblocksDown: true, hlNonce: BigInt(AT - HL_REPLAY_MS - 60_000) }).deps);
  assert.equal(oldNonce.error, null, oldNonce.error?.stack);
  const noNonce = withdrawGuards({ calls: new Error('down'), entries: [], hlNonce: null, nowMs: AT });
  assert.match(noNonce.refusals.join(), /an earlier hl_withdraw signature cannot be ruled out/);
  // Signed 2 min ago, not listed by nearblocks yet.
  const lag = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], world({ hlNonce: BigInt(AT - 120_000) }).deps);
  assert.match(lag.error?.message ?? '', /the desk signed a Hyperliquid action at .* that nearblocks does not list yet: if it is an hl_withdraw it is not checked here/);
});

test('withdraw --send: hl_withdraw by the owner, the SignedAction posted, Hyperliquid\'s ledger (nonce = time x 1000), then the Arbitrum arrival', async () => {
  const w = world({
    onSend: () => ({ value: withdrawSigned() }),
    hlSubmit: ({ setLedger, arb }) => {
      // What mainnet booked: usdc is the amount less the fee, the nonce the withdraw3 time x 1000.
      setLedger([{ time: AT + 1000, hash: '0xhlw', delta: { type: 'withdraw', usdc: '10.682396', nonce: (AT + 2000) * 1000, fee: '1.0' } }]);
      arb.set(EVM.toLowerCase(), 10_682_396n);
      return { confirmed: true, tx: [{ chain: 'hyperliquid', id: '0xhlw' }] };
    },
  });
  const r = await capture(WITHDRAW_SEND, w.deps);
  assert.equal(r.error, null, r.error?.stack);
  assert.equal(w.seen.sent.length, 1);
  assert.equal(w.seen.sent[0].actions[0].method, 'hl_withdraw');
  assert.equal(w.seen.sent[0].actions[0].deposit, 1n);
  assert.equal(w.seen.sent[0].signer, PUBLIC);
  assert.equal(w.seen.submitted.length, 1);
  assert.equal(w.seen.submitted[0].desk, EVM);
  assert.equal(w.seen.hlOptions.confirmMs, 5_000, 'the submitter waits briefly; the script\'s own wait is announced');
  assert.match(r.out, new RegExp(`posting {3}to https://api\\.hyperliquid\\.xyz/exchange; then up to 5 s for its ledger entry \\(withdraw, nonce ${AT + 2000}000\\)`));
  assert.match(r.out, /waiting {3}up to 900 s \(--timeout-s\) for Hyperliquid's ledger entry .* and \+10\.682396 USDC at the desk EVM on Arbitrum/);
  assert.ok(r.block.some((l) => new RegExp(`^ledger: {3}Hyperliquid withdraw 10\\.682396 USDC fee 1\\.0 nonce ${AT + 2000}000 at .*, 0xhlw$`).test(l)), r.block.join('\n'));
  assert.ok(r.block.includes('arbitrum: desk EVM USDC 0 -> 10.682396 (expected +10.682396)'));
  assert.ok(r.block.includes('arrived:  yes'));

  // Not arrived within the timeout: "not yet", with progress lines on the way.
  const slow = world({ onSend: () => ({ value: withdrawSigned() }) });
  let t = AT;
  const s = await capture([...WITHDRAW_SEND, '--timeout-s', '120'], { ...slow.deps, now: () => (t += 10_000) });
  assert.ok(s.block.some((l) => /^arrived: {2}not yet \(after 120 s\)/.test(l)), s.block?.join('\n') ?? s.error?.stack);
  assert.ok(s.block.some((l) => l.startsWith(`ledger:   no Hyperliquid withdraw with nonce ${AT + 2000}000 seen`)));
  assert.match(s.out, /waiting {3}\d+ s left: ledger entry not yet, Arbitrum 0 USDC/);

  // Arrived but no ledger match: a few more reads, not the whole timeout.
  const reads = { n: 0 };
  const unmatched = world({ onSend: () => ({ value: withdrawSigned() }), hlSubmit: ({ arb }) => { arb.set(EVM.toLowerCase(), 10_682_396n); return { confirmed: false, tx: [] }; } });
  const u = await capture(WITHDRAW_SEND, { ...unmatched.deps, sleep: async () => { reads.n++; } });
  assert.ok(u.block.includes('arrived:  yes'), u.block?.join('\n') ?? u.error?.stack);
  assert.ok(reads.n <= 7, `${reads.n} sleeps`);
});

test('withdraw --send: a signed action that is not the withdrawal asked for is never posted', async () => {
  for (const [over, why] of [
    [{ destination: '0x3333333333333333333333333333333333333333' }, /destination .* is not the desk EVM address/], [{ amount: '11.6' }, /amount "11\.6" is not "11\.682396"/],
    [{ type: 'usdClassTransfer' }, /action type usdClassTransfer, not withdraw3/], [{ hyperliquidChain: 'Testnet' }, /hyperliquidChain "Testnet" is not "Mainnet"/],
    [{ signatureChainId: '0xa4b1' }, /signatureChainId "0xa4b1" is not "0x66eee"/],
  ]) {
    const w = world({ onSend: () => ({ value: withdrawSigned(over) }) });
    const r = await capture(WITHDRAW_SEND, w.deps);
    assert.match(r.error?.message ?? '', why);
    assert.equal(w.seen.submitted.length, 0);
  }
  assert.deepEqual(withdrawActionProblems(withdrawSigned(), { deskId: DESK_ID, evm: EVM.toUpperCase().replace('0X', '0x'), amountText: '11.682396' }), []);
  assert.deepEqual(withdrawActionProblems(withdrawSigned({ hyperliquidChain: 'Testnet' }), { deskId: DESK_ID, evm: EVM, amountText: '11.682396', hyperliquidChain: 'Testnet' }), []);
});

test('withdraw --send: Hyperliquid refusing or not answering leaves an open line with the replay window', async () => {
  for (const [name, message, why] of [['OutcomeUnknown', 'no answer from /exchange', /no answer: it may have been taken/], ['HlExchangeError', 'hyperliquid refused: Insufficient balance', /Hyperliquid refused it/]]) {
    const w = world({ onSend: () => ({ value: withdrawSigned() }), hlSubmit: () => { throw Object.assign(new Error(message), { name }); } });
    const r = await capture(WITHDRAW_SEND, w.deps);
    assert.equal(r.error?.message, message);
    const block = blockOf(r);
    assert.ok(block.some((l) => l.startsWith(`hyperliquid: ${name}`) && why.test(l)), block.join('\n'));
    const until = new Date(AT + 2000 + HL_REPLAY_MS).toISOString();
    assert.ok(block.some((l) => l.startsWith(`open:     withdraw3 time ${AT + 2000} is signed and was sent to Hyperliquid: it can still be posted until about ${until}`)), block.join('\n'));
  }
});

test('withdraw --send: a failed hl_withdraw, an unreadable outcome or SignedAction each leave an open line', async () => {
  const fail = world({ onSend: () => ({ failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_MPC: sign failed' } } } } }) });
  const f = await capture(WITHDRAW_SEND, fail.deps);
  assert.match(f.error?.message ?? '', /^hl_withdraw Tx1: /);
  const fb = blockOf(f);
  assert.ok(fb.some((l) => l.startsWith('near:     hl_withdraw tx Tx1 FAILED')), fb.join('\n'));
  assert.ok(fb.some((l) => /^open: {5}hl_withdraw Tx1 failed on NEAR, but a signature of its withdraw3 may be public .* a late withdraw3 can still be posted within Hyperliquid's nonce window \(until about .*\); check the ledger/.test(l)), fb.join('\n'));
  assert.equal(fail.seen.submitted.length, 0);

  const lost = world({ sendThrows: 'transaction Tx1 is not final after 3 min' });
  const l = await capture(WITHDRAW_SEND, lost.deps);
  assert.match(l.error?.message ?? '', /not final after 3 min/);
  assert.ok(blockOf(l).some((x) => x.startsWith('open:     hl_withdraw Tx1 failed on NEAR, but a signature of its withdraw3 may be public')), l.out);

  const garbled = world({ onSend: () => ({ value: { not: 'a signed action' } }) });
  const g = await capture(WITHDRAW_SEND, garbled.deps);
  assert.match(g.error?.message ?? '', /hl_withdraw/);
  assert.ok(blockOf(g).some((x) => /^open: {5}the transaction ran but its SignedAction cannot be read: .*a withdraw3 may still have been signed \(Hyperliquid takes it until about /.test(x)), g.out);
  assert.equal(garbled.seen.submitted.length, 0);
});

test('hlWithdrawEntry and withdrawNonceMs: the nonce is the withdraw3 time x 1000 (or the bare time); without one, usdc + fee is the amount', () => {
  const e = (delta, time = 10) => ({ time, hash: 'h', type: delta.type, usdcE6: delta.usdc === undefined ? null : BigInt(Math.round(Number(delta.usdc) * 1e6)), delta });
  const T = 1_793_669_928_713;
  const amountE6 = 11_682_396n;
  // The entry mainnet booked on 2026-11-03 for withdraw3 time 1793669928713 of 11.682396 USDC.
  assert.ok(hlWithdrawEntry([e({ type: 'withdraw', usdc: '10.682396', nonce: 1793669928713000, fee: '1.0' })], { since: 0, time: T, amountE6 }));
  assert.ok(hlWithdrawEntry([e({ type: 'withdraw', usdc: '10.682396', nonce: T, fee: '1.0' })], { since: 0, time: T, amountE6 }));
  assert.equal(hlWithdrawEntry([e({ type: 'withdraw', usdc: '10.682396', nonce: (T - 1) * 1000, fee: '1.0' })], { since: 0, time: T, amountE6 }), null);
  assert.ok(hlWithdrawEntry([e({ type: 'withdraw', usdc: '10.682396', fee: '1.0' })], { since: 0, time: T, amountE6 }));
  assert.ok(hlWithdrawEntry([e({ type: 'withdraw', usdc: '11.682396' })], { since: 0, time: T, amountE6 }));
  assert.equal(hlWithdrawEntry([e({ type: 'withdraw', usdc: '11.682396', fee: '1.0' })], { since: 0, time: T, amountE6 }), null);
  assert.equal(hlWithdrawEntry([e({ type: 'deposit', usdc: '11.682396' })], { since: 0, time: T, amountE6 }), null);
  assert.equal(hlWithdrawEntry([e({ type: 'withdraw', usdc: '10.682396', nonce: T * 1000, fee: '1.0' }, 5)], { since: 6, time: T, amountE6 }), null);
  assert.equal(withdrawNonceMs({ nonce: 1793669928713000 }), 1793669928713n);
  assert.equal(withdrawNonceMs({ nonce: '1793669928713000' }), 1793669928713n);
  assert.equal(withdrawNonceMs({ nonce: 1793669928713 }), 1793669928713n);
  assert.equal(withdrawNonceMs({ nonce: 1793669928713001 }), -1n);
  assert.equal(withdrawNonceMs({ nonce: 'x' }), -1n);
  assert.equal(withdrawNonceMs({}), null);
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

const ready = { arb: { [EVM]: 10_600_000n }, wei: { [RELAYER]: 10n ** 15n }, env: withRelayer, keyPublic: OP_PUBLIC };
const BRIDGE_SEND = [CONTRACT, DESK_ID, 'bridge', 'all', '--send'];

test('bridge --send: a failed evm_usdc_to_intents, a lost outcome or an unreadable SignedAction leave an open line (the rescue is counted)', async () => {
  const fail = world({ ...ready, onSend: () => ({ failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_MPC: sign failed' } } } } }) });
  const f = await capture(BRIDGE_SEND, await liveLike(fail.deps));
  assert.match(f.error?.message ?? '', /^evm_usdc_to_intents Tx1: /);
  const fb = blockOf(f);
  const until = new Date(AT + 360_000).toISOString();
  assert.ok(fb.includes(`open:     evm_usdc_to_intents Tx1 failed on NEAR, but a signature of its authorization may be public (the failure can come after the MPC network signed): `
    + `the rescue is counted, and a late authorization is valid until block time + 300 s (about ${until}); do not rerun bridge before then`), fb.join('\n'));
  assert.equal(fail.seen.submitted.length, 0);

  const lost = world({ ...ready, sendThrows: 'transaction Tx1 is not final after 3 min' });
  const l = await capture(BRIDGE_SEND, await liveLike(lost.deps));
  assert.ok(blockOf(l).some((x) => x.startsWith('open:     evm_usdc_to_intents Tx1 failed on NEAR, but a signature of its authorization may be public')), l.out);

  const garbled = world({ ...ready, onSend: () => ({ value: 'nope' }) });
  const g = await capture(BRIDGE_SEND, await liveLike(garbled.deps));
  assert.ok(blockOf(g).some((x) => /^open: {5}the transaction ran but its SignedAction cannot be read: .*the rescue is counted, and an authorization it signed is valid until about .*: do not rerun bridge before then/.test(x)), g.out);
  assert.equal(garbled.seen.submitted.length, 0);
});

test('bridge --send: 1Click FAILED is not a landing; the block names the status to read and the refund address', async () => {
  const w = world({ ...ready, status: { status: 'FAILED' }, onSend: () => ({ value: transferSigned() }) });
  const r = await capture(BRIDGE_SEND, await liveLike(w.deps));
  assert.match(r.error?.message ?? '', /1Click ended the bridge FAILED: the USDC goes back to the desk EVM address/);
  const block = blockOf(r);
  assert.ok(block.includes('1click:   status FAILED'), block.join('\n'));
  assert.ok(block.includes('landed:   no: 1Click status FAILED'));
  assert.ok(block.some((x) => x.startsWith(`open:     GET https://1click.chaindefuser.com/v0/status?depositAddress=${DEPOSIT}; a refund goes to the desk EVM address ${EVM}`)));
});

// --- bridge: earlier authorizations ---

const EARLIER_DEPOSIT = '0x' + '3a'.repeat(20);
const earlierAuth = (msAgo, over = {}) => nbTx('evm_usdc_to_intents', {
  hash: 'EarlierB1', ms: AT - msAgo,
  // nearblocks over-escapes the quote's own quotes: the deposit address is read from the text.
  args: { desk_id: DESK_ID, quote: `{\\"depositAddress\\":\\"${EARLIER_DEPOSIT}\\",\\"amountIn\\":\\"2000000\\"}`, quote_signature: 'ed25519:x', reason: 'r' },
  ...over,
});

test('bridge: an earlier authorization still valid, or a deposit 1Click has not settled, refuses --send before the quote; --again sends', async () => {
  for (const [msAgo, status, why] of [
    [120_000, 'PENDING_DEPOSIT', /its authorization is valid until about .* and 1Click says PENDING_DEPOSIT: do not bridge again before then/],
    [3_600_000, 'PROCESSING', /1Click says PROCESSING: its deposit has not settled/],
    [3_600_000, 'KNOWN_DEPOSIT_TX', /1Click says KNOWN_DEPOSIT_TX: its deposit has not settled/],
    [3_600_000, 'FAILED', /1Click says FAILED; read GET \/v0\/status for it/],
  ]) {
    const w = world({ ...ready, calls: { evm_usdc_to_intents: [earlierAuth(msAgo)] }, earlierStatus: { [EARLIER_DEPOSIT]: status } });
    const r = await capture(BRIDGE_SEND, await liveLike(w.deps));
    assert.match(r.error?.message ?? '', why, status);
    assert.match(r.error.message, /evm_usdc_to_intents EarlierB1 at .* \(deposit address 0x(3a){20}\)/);
    assert.equal(w.seen.quotes.length + w.seen.keys + w.seen.sent.length, 0, status);
    // The dry run lists it.
    const dry = await capture([CONTRACT, DESK_ID, 'bridge', 'all'], world({ ...ready, calls: { evm_usdc_to_intents: [earlierAuth(msAgo)] }, earlierStatus: { [EARLIER_DEPOSIT]: status } }).deps);
    assert.ok(blockOf(dry).some((x) => x.startsWith('would refuse at --send: evm_usdc_to_intents EarlierB1')), dry.out);
    assert.ok(blockOf(dry).includes(`earlier:  evm_usdc_to_intents EarlierB1 at ${new Date(AT - msAgo).toISOString()} to ${EARLIER_DEPOSIT}: 1Click ${status}`), dry.out);
  }
  const again = world({
    ...ready, calls: { evm_usdc_to_intents: [earlierAuth(120_000)] }, earlierStatus: { [EARLIER_DEPOSIT]: 'PENDING_DEPOSIT' },
    onSend: ({ desk, setDesk }) => { setDesk({ ...desk, ledger: { ...desk.ledger, idle_usdc: 22_500_000 } }); return { value: transferSigned() }; },
  });
  const g = await capture([...BRIDGE_SEND, '--again'], await liveLike(again.deps));
  assert.equal(g.error, null, g.error?.stack);
  assert.equal(again.seen.sent.length, 1);
  assert.ok(g.block.some((x) => x.startsWith('override: evm_usdc_to_intents EarlierB1') && x.endsWith('(--again)')), g.block.join('\n'));
});

test('bridge: settled earlier authorizations (SUCCESS, REFUNDED, expired unused, refused by the contract) do not refuse; nearblocks unreadable does', async () => {
  for (const [msAgo, status, over] of [[200_000, 'SUCCESS'], [200_000, 'REFUNDED'], [400_000, 'PENDING_DEPOSIT'], [60_000, 'PENDING_DEPOSIT', { ok: false }]]) {
    const w = world({ ...ready, calls: { evm_usdc_to_intents: [earlierAuth(msAgo, over)] }, earlierStatus: { [EARLIER_DEPOSIT]: status } });
    const r = await capture([CONTRACT, DESK_ID, 'bridge', 'all'], w.deps);
    assert.equal(r.error, null, `${status} ${msAgo}: ${r.error?.message}`);
  }
  // Another desk's authorization is not this desk's.
  const other = world({ ...ready, calls: { evm_usdc_to_intents: [earlierAuth(60_000, { args: { desk_id: 'other', quote: 'q' } })] } });
  assert.equal((await capture([CONTRACT, DESK_ID, 'bridge', 'all'], other.deps)).error, null);
  const down = world({ ...ready, nearblocksDown: true });
  const d = await capture(BRIDGE_SEND, await liveLike(down.deps));
  assert.match(d.error?.message ?? '', /earlier evm_usdc_to_intents calls could not be read \(nearblocks evm_usdc_to_intents calls: HTTP 429\): an authorization still valid cannot be ruled out/);
  assert.equal(down.seen.quotes.length, 0);
  // No deposit address readable: unknown, so refused while it is not known to be settled.
  const c = { hash: 'H', ms: AT - 3_600_000, accepted: true, depositAddress: null };
  assert.match(authorizationProblem(c, 'unread (no deposit address in its quote)', AT), /deposit address not readable.*1Click says unread/);
  assert.equal(authorizationProblem({ ...c, depositAddress: EARLIER_DEPOSIT }, 'SUCCESS', AT), null);
});

test('depositAddressOf: the quote\'s own depositAddress (over-escaped as nearblocks gives it), never an address in reason', () => {
  const a = '0x' + '1a'.repeat(20);
  const b = '0x' + '2b'.repeat(20);
  // The args nearblocks returned on 2026-11-03: the quote's quotes escaped once more than JSON needs.
  const nearblocksQuote = `{\\"amountIn\\":\\"2000000\\",\\"customRecipientMsg\\":\\"{\\\\\\"desk_id\\\\\\":\\\\\\"canary\\\\\\"}\\",\\"depositAddress\\":\\"${a}\\"}`;
  assert.deepEqual(quoteObjectOf(nearblocksQuote), { amountIn: '2000000', customRecipientMsg: '{"desk_id":"canary"}', depositAddress: a });
  assert.equal(depositAddressOf({ quote: nearblocksQuote, reason: `depositAddress ${b}` }, ''), a);
  assert.equal(depositAddressOf({ quote: JSON.stringify({ depositAddress: a }), reason: `depositAddress ${b}` }, ''), a);
  // A quote that parses but has no deposit address: none, not the one in reason.
  assert.equal(depositAddressOf({ quote: JSON.stringify({ amountIn: '1' }), reason: `depositAddress ${b}` }, ''), null);
  // Args that are not JSON: the text before reason only.
  assert.equal(depositAddressOf(null, `{"desk_id":"canary","quote":"..depositAddress..${a}..","reason":"depositAddress ${b}"}x`), a);
  assert.equal(depositAddressOf(null, `{"desk_id":"canary","reason":"depositAddress ${b}"}x`), null);
});

test('eip3009NonceOf: keccak256(desk_id ‖ counter as u64 big-endian), the contract\'s vectors', () => {
  const v = JSON.parse(readFileSync(fileURLToPath(new URL('../../contract/core/tests/vectors/eip3009.json', import.meta.url)), 'utf8'));
  assert.ok(v.nonce_cases.length > 0);
  for (const n of v.nonce_cases) assert.equal(eip3009NonceOf(n.desk_id, BigInt(n.counter)), n.nonce, `${n.desk_id} ${n.counter}`);
});

test('counterGuards: the last authorization unused and possibly valid refuses; a used one newer than nearblocks lists refuses for 10 min', () => {
  const nonce1 = eip3009NonceOf(DESK_ID, 1n);
  const base = { deskId: DESK_ID, listedMs: [], nowMs: AT };
  const at = (ms) => ({ eip3009_next: 2n, deposit_paid_ms: [BigInt(AT - 3_600_000), BigInt(ms)] });
  const live = counterGuards({ ...base, counters: at(AT - 60_000), lastUsed: false });
  assert.match(live.refusals.join(), new RegExp(`the desk's last authorization \\(counter 1, nonce ${nonce1}\\) is not used on Arbitrum USDC and may be valid until about ${new Date(AT - 60_000 + 360_000).toISOString()}`));
  assert.ok(live.lines.includes(`last authorization (counter 1, nonce ${nonce1}): not used on Arbitrum USDC`));
  // Unused and past its validBefore: it can never be used.
  assert.deepEqual(counterGuards({ ...base, counters: at(AT - 400_000), lastUsed: false }).refusals, []);
  // Used, and nearblocks does not list a call that recent: its deposit is unchecked.
  const lag = counterGuards({ ...base, counters: at(AT - 60_000), lastUsed: true });
  assert.match(lag.refusals.join(), /the desk counted a rescue at .* that nearblocks does not list as an evm_usdc_to_intents yet/);
  assert.deepEqual(counterGuards({ ...base, counters: at(AT - 60_000), lastUsed: true, listedMs: [AT - 60_000] }).refusals, []);
  assert.deepEqual(counterGuards({ ...base, counters: at(AT - 11 * 60_000), lastUsed: true }).refusals, []);
  // No record, or no authorization ever signed.
  assert.deepEqual(counterGuards({ ...base, counters: null, lastUsed: null }).refusals, []);
  assert.deepEqual(counterGuards({ ...base, counters: { eip3009_next: 0n, deposit_paid_ms: [BigInt(AT - 1000)] }, lastUsed: null }).refusals, []);
});

test('bridge --send: an authorization nearblocks has not indexed yet (contract counter, authorizationState) refuses before the quote; unreadable state refuses', async () => {
  // Signed a minute ago (a rerun after a lost outcome), not used on Arbitrum, not on nearblocks yet. The same in the
  // final contract's record layout as in the canary's.
  for (const final of [true, false]) {
    const f = world({ ...ready, counters: { next: 3, paid: [AT - 7_200_000, AT - 60_000], final }, authUsed: false });
    const r = await capture(BRIDGE_SEND, await liveLike(f.deps));
    assert.match(r.error?.message ?? '', /the desk's last authorization \(counter 2, nonce 0x[0-9a-f]{64}\) is not used on Arbitrum USDC and may be valid until about/, String(final));
    assert.equal(f.seen.quotes.length + f.seen.keys + f.seen.sent.length, 0);
  }
  const w = world({ ...ready, counters: { next: 3, paid: [AT - 7_200_000, AT - 60_000] }, authUsed: false });
  await capture(BRIDGE_SEND, await liveLike(w.deps));
  // authorizationState(desk EVM, nonce of counter 2) on Circle USDC.
  assert.deepEqual(w.seen.authChecks, [{ to: ARB_USDC, data: `0xe94a0102${EVM.slice(2).toLowerCase().padStart(64, '0')}${eip3009NonceOf(DESK_ID, 2n).slice(2)}` }]);
  // The dry run prints the counter lines.
  const dry = await capture([CONTRACT, DESK_ID, 'bridge', 'all'], world({ ...ready, counters: { next: 3, paid: [AT - 60_000] }, authUsed: false }).deps);
  assert.ok(blockOf(dry).some((x) => x.startsWith('earlier:  desk EIP-3009 counter 3 (the next nonce\'s); the last rescue counted at')), dry.out);
  assert.ok(blockOf(dry).some((x) => x.startsWith('would refuse at --send: the desk\'s last authorization (counter 2')), dry.out);
  // Used a minute ago and not on nearblocks yet.
  const used = await capture(BRIDGE_SEND, await liveLike(world({ ...ready, counters: { next: 3, paid: [AT - 60_000] }, authUsed: true }).deps));
  assert.match(used.error?.message ?? '', /nearblocks does not list as an evm_usdc_to_intents yet/);
  // Listed, used and SUCCESS: no refusal from either check.
  const listed = world({
    ...ready, counters: { next: 3, paid: [AT - 200_000] }, authUsed: true, calls: { evm_usdc_to_intents: [earlierAuth(200_000)] }, earlierStatus: { [EARLIER_DEPOSIT]: 'SUCCESS' },
    onSend: ({ desk, setDesk }) => { setDesk({ ...desk, ledger: { ...desk.ledger, idle_usdc: 22_500_000 } }); return { value: transferSigned() }; },
  });
  const ok = await capture(BRIDGE_SEND, await liveLike(listed.deps));
  assert.equal(ok.error, null, ok.error?.stack);
  // Fail closed: the counters record or authorizationState unreadable.
  for (const o of [{ stateDown: [5] }, { counters: { next: 1, paid: [AT - 7_200_000] }, authDown: true }]) {
    const d = world({ ...ready, ...o });
    const x = await capture(BRIDGE_SEND, await liveLike(d.deps));
    assert.match(x.error?.message ?? '', /the desk's EIP-3009 counter or its last nonce on Arbitrum could not be read .*: an authorization nearblocks has not indexed cannot be ruled out/, JSON.stringify(o));
    assert.equal(d.seen.quotes.length, 0);
  }
});

test('withdraw: an unreadable Hyperliquid nonce refuses; one ledger entry books at most one of two hl_withdraw calls a moment apart', async () => {
  const r = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], world({ stateDown: [3] }).deps);
  assert.match(r.error?.message ?? '', /the desk's Hyperliquid nonce \(contract state\) could not be read: an hl_withdraw signed in the last minutes, before nearblocks lists it, cannot be ruled out/);
  const call = (hash, ms) => ({ hash, ms, accepted: true, amount: '5', deskKnown: true });
  const t = AT - 3_600_000;
  const entry = { type: 'withdraw', time: t + 200_000, hash: '0xone', usdcE6: 4_000_000n, delta: { type: 'withdraw', usdc: '4.0', nonce: (t + 1500) * 1000, fee: '1.0' } };
  const g = withdrawGuards({ calls: [call('Second', t + 1500), call('First', t)], entries: [entry], hlNonce: BigInt(t + 1500), nowMs: AT });
  assert.equal(g.refusals.length, 1, g.refusals.join('\n'));
  // The entry's nonce is the second call's time: it books that one, and the first stays open.
  assert.match(g.refusals[0], /^hl_withdraw First \(5 USDC\) signed a withdraw3/);
  assert.ok(g.lines.some((l) => l.startsWith('hl_withdraw Second (5 USDC)') && l.includes('booked, ledger 0xone')), g.lines.join('\n'));
  // With an entry each, both are booked.
  const both = withdrawGuards({ calls: [call('Second', t + 1500), call('First', t)], entries: [entry, { ...entry, hash: '0xtwo', delta: { ...entry.delta, nonce: t * 1000 } }], hlNonce: BigInt(t + 1500), nowMs: AT });
  assert.deepEqual(both.refusals, []);
});

test('the rescuer\'s lock: held by a live rescuer, --send refuses before anything is read or signed (the dry run says so); free, --send holds it for the run', async () => {
  // The real lock (engine/src/rescue/lock.ts) under the name the script derives, for a desk id of this process's own:
  // the plain name is the live canary desk's, and a Windows pipe name is machine-wide, so a running rescuer (or another
  // test run) would collide with it.
  const real = await import('../../engine/src/rescue/lock.ts');
  const run = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const locks = { ...real, rescueLockName: (env, mode, contract, desk) => real.rescueLockName(env, mode, contract, `${desk}-hl-test-${run}`) };
  const name = locks.rescueLockName((k) => process.env[k], 'mainnet', CONTRACT, DESK_ID);
  const rescuer = await locks.acquireRescueLock(name);
  try {
    const w = world();
    const live = { ...w.deps, lock: async () => locks };
    for (const argv of [WITHDRAW_SEND, [...WITHDRAW_SEND, '--again'], [CONTRACT, DESK_ID, 'bridge', 'all', '--send']]) {
      const s = await capture(argv, live);
      assert.match(s.error?.message ?? '', /^--send refused, nothing was signed: the desk's live rescuer holds .*gimbal-rescue-mainnet-gimbal-canary2\.near-canary-hl-test-.*same EIP-3009 counter.*stop the rescuer first \(--again does not lift this\)$/, argv.join(' '));
      assert.equal(s.out, '', 'refused before the first read');
    }
    assert.equal(w.seen.sent.length, 0);
    assert.equal(w.seen.keys, 0, 'no key file read');
    const d = await capture([CONTRACT, DESK_ID, 'withdraw', 'all'], live);
    assert.equal(d.error, null, d.error?.stack);
    assert.match(d.out, /\nwarning {3}the desk's live rescuer holds .*: --send refuses while it runs\n/);
  } finally {
    await rescuer.release();
  }

  const w = world({
    onSend: () => ({ value: withdrawSigned() }),
    hlSubmit: ({ setLedger, arb }) => {
      setLedger([{ time: AT + 1000, hash: '0xhlw', delta: { type: 'withdraw', usdc: '10.682396', nonce: (AT + 2000) * 1000, fee: '1.0' } }]);
      arb.set(EVM.toLowerCase(), 10_682_396n);
      return { confirmed: true, tx: [{ chain: 'hyperliquid', id: '0xhlw' }] };
    },
  });
  // A rescuer starting while the script is about to sign is refused.
  let during = null;
  const s = await capture(WITHDRAW_SEND, {
    ...w.deps,
    lock: async () => locks,
    engine: async () => {
      during = await locks.acquireRescueLock(name).then(async (l) => { await l.release(); return 'taken'; }, (e) => e.message);
      return w.deps.engine();
    },
  });
  assert.equal(s.error, null, s.error?.stack);
  assert.match(s.out, /\nlock {6}.* taken for this run: no live rescuer of the desk can start until it ends\n/);
  assert.match(during ?? '', /another live rescuer \(or tools\/mainnet\/hl-return\.mjs or fund\.mjs\) holds/);
  assert.equal(w.seen.sent.length, 1);
  // Released when the run ends.
  const after = await locks.acquireRescueLock(name);
  await after.release();
});
