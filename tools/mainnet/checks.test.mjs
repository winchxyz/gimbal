import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageError } from './cli.mjs';
import {
  ALLOWED_CALLS, ASSETS, CALL_TGAS, KEY_LIFETIME_MS, ORACLE_DEPOSIT, ORACLE_IDS, callProblem, engineEnvProblems, guardedTransport,
  parseChecksArgs, quoteRequests, quoteVerdict, runChecks, sendRefusal, stalePrices, txCosts,
} from './checks.mjs';
import { OPERATOR_METHODS, orderlyAccountId } from './desk.mjs';
import { CANARY_SYMBOLS } from './venues.mjs';

const CONTRACT = 'gimbal-canary.near';
const DESK_ID = 'canary';
const OWNER = 'abababababababababababababababababababababababababababababababab';
const EVM = '0x2db4e285d94fbb1e2bb65c71ad68ee7ae981890f';
const AUTHORITY = '2av18e4xDpvWRgf6qHzutwtbgXvFRRbXWiNkwx3gcJC2';
const ACCOUNT = orderlyAccountId(EVM, 'gimbal_dex');
const RECEIVER = '0x1111111111111111111111111111111111111111';
const SECRET = `ed25519:${'5'.repeat(88)}`;
const PUBLIC = `ed25519:${'7'.repeat(44)}`;
const NOW = Date.parse('2026-11-01T12:00:00Z');

const DESK = {
  owner: OWNER, operator: null, paused: false, policy: {}, evm_address: EVM,
  solana: { authority: AUTHORITY, usdc_ata: 'u', phusd_ata: 'p', phoenix_trader: 't' },
  orderly_account_id: ACCOUNT, orderly_receiver: null, orderly_ips: [],
  ledger: { deposited: 0, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 0 },
};
const CONFIG = {
  network: 'Mainnet', mpc: 'v1.signer', price_source: { OutLayer: { contract: 'price-oracle.near' } },
  treasury: { near: 'treasury.near', hl_builder: '0x6a3c66eab3b1f5c31a253903ae4f4b957ccc3224', referral_codes: { hyperliquid: 'WINCH', orderly: null, phoenix: 'X' } },
  fees: { performance_bps: 1000, hl_builder_tenth_bps: 10 },
  orderly: { broker_id: 'gimbal_dex', chain_id: 42161 },
};
const FEE = { send_sir: 100, send_not_sir: 100, execution: 100 };
const FEES = { receipt: FEE, deploy: FEE, deployByte: FEE, call: FEE, callByte: FEE, addKey: FEE, addKeyByte: FEE };

const usage = (argv, pattern) => assert.throws(() => parseChecksArgs(argv), (e) => e instanceof UsageError && pattern.test(e.message), argv.join(' '));

test('arguments: all three steps by default, one with --step; mainnet ids and desk ids only', () => {
  const a = parseChecksArgs([CONTRACT, DESK_ID]);
  assert.deepEqual(a.steps, ['prices', 'orderly', 'quotes']);
  assert.equal(a.send, false);
  assert.match(a.envFile, /[\\/]\.keys[\\/]engine-mainnet-gimbal-canary\.near\.env$/);
  assert.deepEqual(parseChecksArgs([CONTRACT, DESK_ID, '--step', 'quotes', '--send']).steps, ['quotes']);
  usage([CONTRACT], /contract and the desk id are required/);
  usage([CONTRACT, DESK_ID, 'x'], /unexpected argument x/);
  usage(['gimbal-c6-fcf135.testnet', DESK_ID], /not a mainnet account/);
  usage([CONTRACT, 'Canary!'], /desk id/);
  usage([CONTRACT, DESK_ID, '--step', 'deposit'], /--step deposit is not one of prices, orderly, quotes/);
  usage([CONTRACT, DESK_ID, '--step', 'prices', '--step', 'orderly'], /given twice/);
  usage([CONTRACT, DESK_ID, '--write'], /unknown option --write/);
});

test('--send refuses in a linked git worktree, before anything is read', async () => {
  assert.equal(sendRefusal(false, '/w/tree'), null, 'a dry run works anywhere');
  assert.equal(sendRefusal(true, null), null);
  assert.match(sendRefusal(true, '/w/tree'), /\/w\/tree is a linked git worktree: --send runs from the main checkout only/);
  const touched = new Proxy({}, { get: () => { throw new Error('read before the refusal'); } });
  for (const step of ['prices', 'orderly', 'quotes']) {
    await assert.rejects(runChecks([CONTRACT, DESK_ID, '--step', step, '--send'], { tree: '/w/tree', near: touched, fetch: touched, say: () => {} }),
      /linked git worktree/);
  }
});

test('only the step\'s own calls get through: no money method, no other Orderly kind, no other contract', async () => {
  assert.deepEqual(ALLOWED_CALLS, { prices: ['refresh_prices'], orderly: ['orderly_register', 'orderly_add_key', 'orderly_request'], quotes: [] });
  for (const m of ALLOWED_CALLS.orderly) assert.ok(OPERATOR_METHODS.includes(m));
  assert.equal(callProblem('prices', CONTRACT, CONTRACT, 'refresh_prices', { assets: ['BTC'] }), null);
  assert.equal(callProblem('orderly', CONTRACT, CONTRACT, 'orderly_request', { req: { kind: 'receiver_address' } }), null);
  assert.equal(callProblem('orderly', CONTRACT, CONTRACT, 'orderly_add_key', {}), null);
  for (const m of ['fund_venue', 'orderly_withdraw', 'orderly_settle_pnl', 'evm_usdc_to_intents', 'hl_send_to_intents', 'sol_sign_rescue', 'hl_order', 'orderly_ws_auth', 'set_paused']) {
    for (const step of ['prices', 'orderly', 'quotes']) assert.match(callProblem(step, CONTRACT, CONTRACT, m, {}), /refused, nothing was signed/, `${step} ${m}`);
  }
  assert.match(callProblem('orderly', CONTRACT, CONTRACT, 'refresh_prices', {}), /not a call of the orderly step/);
  assert.match(callProblem('prices', CONTRACT, CONTRACT, 'orderly_register', {}), /not a call of the prices step/);
  for (const kind of ['withdraw_request', 'settle_pnl', 'order', 'referral_bind', 'ip_restriction', 'holding', undefined]) {
    assert.match(callProblem('orderly', CONTRACT, CONTRACT, 'orderly_request', { req: { kind } }), /is not receiver_address: refused/, String(kind));
  }
  assert.match(callProblem('prices', CONTRACT, 'other.near', 'refresh_prices', {}), /calls gimbal-canary\.near only/);

  const calls = [];
  const inner = { accountId: OWNER, call: async (...c) => { calls.push(c); return { txHash: 'h', ok: true, value: true }; }, view: async () => 1, account: async () => 2, allowance: async () => 3n };
  const t = guardedTransport(inner, 'orderly', CONTRACT);
  await assert.rejects(t.call(CONTRACT, 'orderly_withdraw', { desk_id: DESK_ID }, 300), /refused, nothing was signed/);
  await assert.rejects(t.call(CONTRACT, 'orderly_request', { desk_id: DESK_ID, req: { kind: 'withdraw_request' } }, 300), /refused/);
  assert.equal(calls.length, 0, 'nothing reached the signing transport');
  await t.call(CONTRACT, 'orderly_request', { desk_id: DESK_ID, req: { kind: 'receiver_address' } }, 300);
  assert.equal(calls.length, 1);
  assert.equal(t.accountId, OWNER);
  assert.equal(await t.allowance(), 3n);
});

test('the engine env file is checked against the chain, and no value from it shows in a refusal', () => {
  const good = new Map([
    ['GIMBAL_MODE', 'mainnet'], ['NEAR_NETWORK', 'mainnet'], ['GIMBAL_CONTRACT_ID', CONTRACT], ['DESK_ID', DESK_ID],
    ['OWNER_ACCOUNT_ID', OWNER], ['OPERATOR_ACCOUNT_ID', ''], ['OPERATOR_PRIVATE_KEY', SECRET], ['ORDERLY_BROKER_ID', 'gimbal_dex'],
  ]);
  const ctx = { contract: CONTRACT, deskId: DESK_ID, desk: DESK, brokerId: 'gimbal_dex' };
  const ok = engineEnvProblems(good, ctx);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.accountId, OWNER);
  assert.equal(ok.rpcUrl, null);
  const bad = new Map([
    ['GIMBAL_MODE', 'testnet'], ['NEAR_NETWORK', 'mainnet'], ['GIMBAL_CONTRACT_ID', 'other-zzq-contract.near'], ['DESK_ID', 'other-desk-zzq'],
    ['OWNER_ACCOUNT_ID', 'stranger-zzq.near'], ['OPERATOR_PRIVATE_KEY', 'ed25519:short'], ['ORDERLY_BROKER_ID', 'woofi_dex'],
  ]);
  const p = engineEnvProblems(bad, ctx).problems;
  assert.deepEqual(p, [
    'GIMBAL_MODE is not mainnet',
    'GIMBAL_CONTRACT_ID is not gimbal-canary.near',
    'DESK_ID is not canary',
    `the operator account (OPERATOR_ACCOUNT_ID or OWNER_ACCOUNT_ID) is neither the desk's owner ${OWNER} nor its operator`,
    'OPERATOR_PRIVATE_KEY is not an ed25519 secret key',
    "ORDERLY_BROKER_ID is not the contract's broker gimbal_dex",
  ]);
  for (const v of ['zzq', 'short', 'woofi']) assert.ok(!p.join('\n').includes(v), `no file value (${v}) in the refusal`);
});

test('the dry quotes: dry, out of HyperCore to the desk\'s own addresses, plus one control into HyperCore', () => {
  const q = quoteRequests({ contract: CONTRACT, deskId: DESK_ID, desk: DESK, now: NOW });
  assert.equal(q.length, 3);
  for (const { body } of q) {
    assert.equal(body.dry, true, 'a dry quote reserves no deposit address');
    assert.equal(body.deadline, '2026-11-01T12:30:00.000Z');
    assert.equal(body.recipientType, 'DESTINATION_CHAIN');
    assert.equal(body.swapType, 'EXACT_INPUT');
  }
  assert.deepEqual(q.map((x) => [x.body.originAsset, x.body.destinationAsset, x.body.refundTo, x.body.recipient]), [
    [ASSETS.hypercoreUsdc, ASSETS.solanaUsdc, EVM, AUTHORITY],
    [ASSETS.hypercoreUsdc, ASSETS.nearUsdc, EVM, CONTRACT],
    [ASSETS.solanaUsdc, ASSETS.hypercoreUsdc, AUTHORITY, EVM],
  ]);
  assert.equal(q[1].body.customRecipientMsg, '{"desk_id":"canary"}');
  assert.deepEqual(q.map((x) => x.body.amount), ['500000000', '500000000', '5000000'], '5 USDC: 8 decimals on HyperCore, 6 on Solana');

  assert.deepEqual(quoteVerdict(400, { message: 'Quoting for this pair is not available' }), { verdict: 'not available', text: 'HTTP 400 "Quoting for this pair is not available"' });
  assert.equal(quoteVerdict(400, { message: 'Amount is too low' }).verdict, 'refused');
  assert.equal(quoteVerdict(500, null).verdict, 'refused');
  const quoted = quoteVerdict(201, { quote: { amountIn: '5000000', amountInFormatted: '5.0', amountOut: '468422800', amountOutFormatted: '4.684228', minAmountOut: '463428500', timeEstimate: 30 } });
  assert.equal(quoted.verdict, 'quoted');
  assert.match(quoted.text, /amountIn 5000000 \(5\.0\), amountOut 468422800 \(4\.684228\), minAmountOut 463428500, timeEstimate 30 s/);
});

test('prices: costs over every receipt, and which assets got no newer price', () => {
  const o = (executor, gas, tokens, logs = []) => ({ outcome: { executor_id: executor, gas_burnt: gas, tokens_burnt: tokens, logs, status: { SuccessValue: '' } } });
  const c = txCosts({ transaction_outcome: o(OWNER, 2e12, '200000000000000000000'), receipts_outcome: [o(CONTRACT, 5e12, '500000000000000000000', ['EVENT_JSON:prices']), o('price-oracle.near', 10e12, '1000000000000000000000')] });
  assert.equal(c.gas, 17_000_000_000_000n);
  assert.equal(c.tokens, 1_700_000_000_000_000_000_000n);
  assert.deepEqual(c.receipts.map((r) => [r.executor, r.status, r.logs.length]), [[CONTRACT, 'SuccessValue', 1], ['price-oracle.near', 'SuccessValue', 0]]);
  const before = [{ asset: 'BTC', price_e8: 1, at_ms: 10 }];
  const after = [{ asset: 'BTC', price_e8: 1, at_ms: 10 }, { asset: 'ETH', price_e8: 1, at_ms: 20 }];
  assert.deepEqual(stalePrices(before, after, ['BTC', 'ETH', 'SOL']), ['BTC', 'SOL']);
  assert.deepEqual(stalePrices([], after, ['ETH']), []);
  assert.deepEqual(Object.keys(ORACLE_IDS).sort(), [...CANARY_SYMBOLS].sort(), 'an oracle id for every canary asset');
  assert.equal(ORACLE_DEPOSIT, 20n * 10n ** 21n);
});

test('the constants are the engine\'s: call gas, the orderly key lifetime', async () => {
  const { DEFAULT_CALL_TGAS } = await import('../../engine/src/contract/budget.ts');
  const { ORDERLY_KEY_LIFETIME_MS } = await import('../../engine/src/venues/orderly-actions.ts');
  assert.equal(CALL_TGAS, DEFAULT_CALL_TGAS);
  assert.equal(KEY_LIFETIME_MS, ORDERLY_KEY_LIFETIME_MS);
});

// --- whole runs on fakes ---

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A mainnet that answers the reads; `state` steers Orderly and prices. Records every request. */
function fakes({ registered = false, keyActive = false, pricesAfter = null } = {}) {
  const seen = { fetch: [], rpc: [], sent: [] };
  let refreshed = false;
  const client = {
    rpc: async (method, params) => {
      seen.rpc.push(method);
      if (method === 'status') return { chain_id: 'mainnet', sync_info: { latest_block_height: 1 } };
      if (method === 'gas_price') return { gas_price: '100000000' };
      if (method === 'tx') {
        const o = (executor, gas, logs = []) => ({ outcome: { executor_id: executor, gas_burnt: gas, tokens_burnt: String(BigInt(gas) * 100_000_000n), logs, status: { SuccessValue: '' } } });
        return { transaction_outcome: o(OWNER, 2_400_000_000_000), receipts_outcome: [o(CONTRACT, 6_000_000_000_000, ['EVENT_JSON:{"event":"prices"}']), o('price-oracle.near', 9_000_000_000_000)] };
      }
      throw new Error(`unexpected rpc ${method}`);
    },
    view: async (contract, method) => {
      assert.equal(contract, CONTRACT);
      if (method === 'config') return CONFIG;
      if (method === 'get_desk') return DESK;
      if (method === 'version') return '0.1.0';
      if (method === 'prices') return refreshed && pricesAfter !== null ? pricesAfter : [];
      throw new Error(`unexpected view ${method}`);
    },
    account: async (id) => ({ amount: String((id === CONTRACT ? 6n : 2n) * 10n ** 24n - (refreshed ? 10n ** 21n : 0n)), locked: '0', storage_usage: 100 }),
    accessKey: async (id, key) => (id === OWNER && key === PUBLIC
      ? { nonce: 1, permission: { FunctionCall: { allowance: '5000000000000000000000000', receiver_id: CONTRACT, method_names: [...OPERATOR_METHODS] } } }
      : null),
    fees: async () => FEES,
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    seen.fetch.push(`${init.method ?? 'GET'} ${u}${init.body === undefined ? '' : ` ${init.body}`}`);
    if (u.includes('/v1/get_account')) return json(registered ? { success: true, data: { account_id: ACCOUNT } } : { success: false, code: -1607, message: 'Account not found.' });
    if (u.includes('/v1/get_orderly_key')) {
      return json(keyActive
        ? { success: true, data: { orderly_key: `ed25519:${AUTHORITY}`, scope: 'read,trading', expiration: NOW + 300 * 86_400_000, key_status: 'ACTIVE' } }
        : { success: false, code: -1617, message: 'orderlyKey is not exist' });
    }
    if (u.includes('/v1/client/asset/receiver_address')) {
      assert.equal(init.headers['orderly-account-id'], ACCOUNT);
      return json({ success: true, data: { receiver_address: RECEIVER, chain_id: 42161 } });
    }
    if (u.endsWith('/v0/quote')) {
      const body = JSON.parse(init.body);
      assert.equal(body.dry, true);
      return body.originAsset === ASSETS.hypercoreUsdc
        ? json({ message: 'Quoting for this pair is not available' }, 400)
        : json({ quote: { amountIn: '5000000', amountInFormatted: '5.0', amountOut: '468422800', amountOutFormatted: '4.684228', minAmountOut: '463428500', timeEstimate: 30 } }, 201);
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const transport = {
    accountId: OWNER,
    publicKey: async () => PUBLIC,
    allowance: async () => (refreshed ? 4_999_000_000_000_000_000_000_000n : 5n * 10n ** 24n),
    account: async () => ({ amount: 2n * 10n ** 24n, locked: 0n, storageUsage: 100 }),
    view: async (_c, method) => client.view(CONTRACT, method),
    call: async (contractId, method, args, tgas) => {
      seen.sent.push({ contractId, method, args, tgas });
      if (method === 'refresh_prices') {
        refreshed = true;
        return { txHash: 'PriceTx111', ok: true, value: true };
      }
      if (method === 'orderly_request') {
        const path = '/v1/client/asset/receiver_address?chain_id=42161&token=USDC';
        const t = args.req.timestamp_ms;
        return {
          txHash: 'ReceiverTx111', ok: true,
          value: {
            desk_id: DESK_ID, request_id: 7, venue: 'orderly', kind: 'receiver_address',
            payload: { method: 'GET', path, body: '', timestamp: t, message: `${t}GET${path}` },
            signature: { scheme: 'Ed25519', signature: Array(64).fill(1) },
          },
        };
      }
      throw new Error(`the fake signs only refresh_prices and receiver_address, not ${method}`);
    },
  };
  const env = new Map([
    ['GIMBAL_MODE', 'mainnet'], ['NEAR_NETWORK', 'mainnet'], ['GIMBAL_CONTRACT_ID', CONTRACT], ['DESK_ID', DESK_ID],
    ['OWNER_ACCOUNT_ID', OWNER], ['OPERATOR_PRIVATE_KEY', SECRET], ['ORDERLY_BROKER_ID', 'gimbal_dex'],
  ]);
  let transportOptions = null;
  const deps = {
    near: client, fetch: fetchImpl, now: () => NOW, tree: null, sleep: async () => {}, pollMs: 0,
    readEnv: () => env,
    transport: async (o) => { transportOptions = o; return transport; },
  };
  return { seen, deps, transportOptions: () => transportOptions };
}

async function capture(argv, deps) {
  const lines = [];
  const block = await runChecks(argv, { ...deps, say: (s = '') => lines.push(s) });
  return { out: lines.join('\n'), block };
}

test('the dry run prints every call of the three steps in full, signs nothing, reads no key', async () => {
  const f = fakes();
  let envRead = false;
  const { out, block } = await capture([CONTRACT, DESK_ID], { ...f.deps, readEnv: () => { envRead = true; return new Map(); }, transport: async () => { throw new Error('no transport in a dry run'); } });
  assert.equal(envRead, false, 'the env file is read only with --send');
  assert.equal(f.seen.sent.length, 0);
  assert.ok(!f.seen.rpc.includes('send_tx') && !f.seen.rpc.includes('broadcast_tx_commit'));
  // prices
  assert.match(out, /FunctionCall refresh_prices {2}gas 300 TGas {2}deposit 0 NEAR\n {12}args {"assets":\["BTC","ETH","SOL","DOGE","LTC"\]}/);
  assert.match(out, /price-oracle\.near request_price_data {"asset_ids":\["nbtc\.bridge\.near","eth\.bridge\.near","22\.contract\.portalbridge\.near","doge\.omft\.near","ltc\.omft\.near"\]}, deposit 0\.02 NEAR/);
  assert.match(out, new RegExp(`signer {4}${OWNER} {2}\\(the operator key from the engine env file, read at --send\\)`));
  assert.match(out, /gas {7}at most 300\.1 TGas/);
  // orderly
  assert.match(out, /now {16}not registered; key not read \(no account yet\)/);
  assert.match(out, /GET https:\/\/api\.orderly\.org\/v1\/registration_nonce/);
  assert.match(out, /FunctionCall orderly_register {2}gas 300 TGas {2}deposit 0 NEAR\n {16}args {"desk_id":"canary","registration_nonce":"<the nonce/);
  assert.match(out, new RegExp(`args {"desk_id":"canary","expiration_ms":${NOW + KEY_LIFETIME_MS}}`));
  assert.match(out, new RegExp(`args {"desk_id":"canary","req":{"reduce_only":false,"kind":"receiver_address","timestamp_ms":${NOW}},"reason":"look up the Orderly receiver address"}`));
  assert.match(out, /GET https:\/\/api\.orderly\.org\/v1\/client\/asset\/receiver_address\?chain_id=42161&token=USDC/);
  assert.match(out, new RegExp(`orderly-account-id ${ACCOUNT}, orderly-key ed25519:${AUTHORITY}`));
  assert.match(out, /not done here: referral_bind, ip_restriction, set_orderly_receiver, any deposit/);
  // quotes, asked live even in the dry run (they reserve nothing)
  assert.equal(f.seen.fetch.filter((x) => x.startsWith('POST https://1click.chaindefuser.com/v0/quote {"dry":true,')).length, 3);
  assert.ok(f.seen.fetch.every((x) => x.startsWith('GET https://api.orderly.org/v1/get_account') || x.startsWith('POST https://1click')), f.seen.fetch.join('\n'));
  // the summary block
  assert.deepEqual(block, [
    '=== gimbal canary checks 2026-11-01T12:00:00.000Z ===',
    'contract gimbal-canary.near, desk canary, dry run',
    'prices:  dry run; refresh_prices BTC,ETH,SOL,DOGE,LTC not sent; prices() now: none stored',
    `orderly: dry run; not registered under gimbal_dex, key none (no account); account ${ACCOUNT}`,
    'quotes:  HyperCore -> Solana USDC (rescue Hyperliquid -> Phoenix): still not available (HTTP 400 "Quoting for this pair is not available")',
    'quotes:  HyperCore -> NEAR USDC (payout to the contract): still not available (HTTP 400 "Quoting for this pair is not available")',
    'quotes:  control: Solana USDC -> HyperCore (rescue Phoenix -> Hyperliquid): quoted (amountIn 5000000 (5.0), amountOut 468422800 (4.684228), minAmountOut 463428500, timeEstimate 30 s)',
    '=== end ===',
  ]);
  assert.match(out, /dry run: nothing was signed or sent/);
});

test('the dry run refuses a contract that is not a mainnet canary, or a desk that is not there', async () => {
  const f = fakes();
  const withView = (view) => ({ ...f.deps, near: { ...f.deps.near, view } });
  await assert.rejects(capture([CONTRACT, DESK_ID], withView(async (_c, m) => (m === 'config' ? { ...CONFIG, network: 'Testnet' } : DESK))), /not a mainnet Gimbal contract:\n {2}network is "Testnet"/);
  await assert.rejects(capture([CONTRACT, DESK_ID], withView(async (_c, m) => (m === 'config' ? { ...CONFIG, orderly: { broker_id: 'woofi_dex', chain_id: 42161 } } : DESK))), /not the engine's mainnet broker/);
  await assert.rejects(capture([CONTRACT, DESK_ID], withView(async (_c, m) => (m === 'config' ? CONFIG : null))), /has no desk canary/);
  await assert.rejects(capture([CONTRACT, DESK_ID], withView(async (_c, m) => (m === 'config' ? CONFIG : { ...DESK, orderly_account_id: '0x00' }))), /orderly_account_id 0x00 is not/);
});

test('--send: prices and orderly through the engine, the key checked first and never printed', async () => {
  const f = fakes({ registered: true, keyActive: true, pricesAfter: CANARY_SYMBOLS.map((asset, i) => ({ asset, price_e8: 1e8 * (i + 1), at_ms: NOW - 600_000 })) });
  const { out, block } = await capture([CONTRACT, DESK_ID, '--send', '--step', 'prices'], f.deps);
  assert.equal(f.transportOptions().privateKey, SECRET, 'the env file\'s key went to the engine transport');
  assert.ok(!out.includes(SECRET), 'the key is never printed');
  assert.deepEqual(f.seen.sent.map((s) => [s.method, s.args, s.tgas]), [['refresh_prices', { assets: [...CANARY_SYMBOLS] }, 300]]);
  assert.match(out, new RegExp(`key {7}${PUBLIC} on ${OWNER}: FunctionCall, receiver ${CONTRACT}`));
  assert.equal(block[2], 'prices:  tx PriceTx111 returned true; gas burnt 17.4 TGas (0.001740 NEAR)');
  assert.equal(block[3], `         gimbal-canary.near balance -0.001000 NEAR; ${OWNER} balance -0.001000 NEAR; key allowance -0.001000 NEAR`);
  assert.match(block[4], /prices\(\) after: BTC 1 \(at 2026-11-01T11:50:00\.000Z\), ETH 2/);

  const g = fakes({ registered: true, keyActive: true });
  const r = await capture([CONTRACT, DESK_ID, '--send', '--step', 'orderly'], g.deps);
  assert.ok(!r.out.includes(SECRET));
  assert.deepEqual(g.seen.sent.map((s) => [s.method, s.args.req?.kind]), [['orderly_request', 'receiver_address']], 'registered with an active key: only the signed read');
  assert.deepEqual(r.block.slice(2, 6), [
    `orderly: orderly_register done: registered under gimbal_dex: ${ACCOUNT}`,
    'orderly: orderly_add_key done: key active until 2027-08-28',
    `orderly: orderly_receiver_lookup done: ${RECEIVER}; tx ReceiverTx111`,
    `orderly: receiver_address answer {"receiver_address":"${RECEIVER}","chain_id":42161}`,
  ]);
});

test('--send refuses an operator key that is not on chain with the operator methods', async () => {
  const f = fakes();
  const deps = { ...f.deps, near: { ...f.deps.near, accessKey: async () => ({ nonce: 1, permission: 'FullAccess' }) } };
  await assert.rejects(capture([CONTRACT, DESK_ID, '--send', '--step', 'prices'], deps), /is not .*'s operator key for gimbal-canary\.near/);
  assert.equal(f.seen.sent.length, 0);
  const bad = { ...f.deps, readEnv: () => new Map([['GIMBAL_MODE', 'mainnet']]) };
  await assert.rejects(capture([CONTRACT, DESK_ID, '--send', '--step', 'orderly'], bad), /does not match gimbal-canary\.near \/ canary:\n {2}NEAR_NETWORK is not mainnet/);
});
