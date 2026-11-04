// set-policy.mjs on recorded venue data and a fake mainnet: the delta it builds, max_sz rounding, every refusal, the
// set_policy args against the contract's Policy, the deposit estimate, and the dry run and --send. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UsageError } from './cli.mjs';
import {
  ORACLE_ASSETS, SET_POLICY_TGAS, addSymbolProblem, additionProblems, argsText, closeCapWarning, decimalE8, e8Text, isCanonicalDecimal, legUsdRange,
  maxSzE8, numberE8,
  parseSetPolicyArgs, planPolicy, policyBorshBytes, policyOrderProblem, policySha256, readMarket, runSetPolicy, storageDeposit, validateForProblems,
} from './set-policy.mjs';
import { MAINNET_ORDERLY_BROKER, livePolicyProblems } from './venues.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const VENUES = JSON.parse(read('./fixtures/set-policy-venues.json'));
const LIVE_POLICY = JSON.parse(read('./fixtures/set-policy-desk.json')).policy;
/** sha256 of the recorded policy as the dry run printed it from get_desk on 2026-11-04. */
const LIVE_SHA = 'e11a50b60393ef68b2aa8faaaa6fd5d13b7bc1b0e023c00f2ac9e9c06c56c5dc';
const clone = (x) => JSON.parse(JSON.stringify(x));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The venues' public APIs answering from the fixture; Hyperliquid's universe padded with fillers up to its indices. */
function venueFetch(v = VENUES, seen = []) {
  const size = Math.max(...v.hl.map((a) => a.index)) + 1;
  const universe = Array.from({ length: size }, (_, i) => ({ szDecimals: 1, name: `FILL${i}` }));
  const ctxs = Array.from({ length: size }, () => ({ markPx: '1.0' }));
  for (const a of v.hl) {
    universe[a.index] = { szDecimals: a.szDecimals, name: a.name, ...(a.isDelisted ? { isDelisted: true } : {}) };
    ctxs[a.index] = { markPx: a.markPx };
  }
  return async (url, init = {}) => {
    seen.push(`${init.method ?? 'GET'} ${url} ${init.body ?? ''}`.trim());
    if (url === 'https://api.hyperliquid.xyz/info') {
      const type = JSON.parse(init.body).type;
      if (type === 'meta') return json({ universe });
      if (type === 'metaAndAssetCtxs') return json([{ universe }, ctxs]);
    }
    if (url === 'https://perp-api.phoenix.trade/v1/view/exchange/markets') return json(v.phoenix);
    if (url === 'https://api.orderly.org/v1/public/info') return json({ success: true, data: { rows: v.orderly } });
    throw new Error(`unexpected fetch ${url}`);
  };
}
const MARKET = await readMarket({ fetch: venueFetch() });

const args = (over = {}) => ({ symbols: ['ZRO', 'ETHFI', 'AAVE'], venues: ['hl', 'orderly'], usdE6: 15_000_000n, unpricedCap: 15, ...over });
const refusedWith = (fn, re) => assert.throws(fn, (e) => {
  assert.match(e.message, re);
  return true;
});

test('decimals: venue numbers in, canonical max_sz out', () => {
  assert.equal(decimalE8('132.63'), 13_263_000_000n);
  assert.equal(decimalE8('80500.0'), 8_050_000_000_000n);
  assert.equal(decimalE8('0.005009'), 500_900n);
  assert.throws(() => decimalE8('0.123456789'), /more than 8 decimals/);
  assert.throws(() => decimalE8('-1'), /not a decimal/);
  assert.equal(e8Text(820_000_000n), '8.2');
  assert.equal(e8Text(11_000_000n), '0.11');
  assert.equal(e8Text(2_500_000_000n), '25');
  assert.equal(numberE8(0.1), 10_000_000n);
  assert.equal(numberE8(0.00001), 1_000n);
  assert.equal(numberE8(100), 10_000_000_000n);
  assert.throws(() => numberE8(1e-9), /whole number of 1e-8/);
  assert.throws(() => numberE8(0), /positive/);
  for (const s of ['8.2', '0.11', '25', '0', '0.00000001']) assert.ok(isCanonicalDecimal(s), s);
  for (const s of ['8.20', '08.2', '.5', '1.', '1e3', '0.000000001', '']) assert.ok(!isCanonicalDecimal(s), s);
});

test('max_sz: the USD at the mark, rounded down to a whole lot of every venue', () => {
  const e8 = (s) => decimalE8(s);
  assert.equal(e8Text(maxSzE8(15_000_000n, e8('1.8228'), e8('0.1'))), '8.2');      // 8.229 ZRO
  assert.equal(e8Text(maxSzE8(15_000_000n, e8('0.6014'), e8('0.1'))), '24.9');     // 24.94 ETHFI
  assert.equal(e8Text(maxSzE8(15_000_000n, e8('132.73'), e8('0.01'))), '0.11');    // 0.113 AAVE
  assert.equal(e8Text(maxSzE8(15_000_000n, e8('132.73'), e8('1'))), '0');          // less than one lot
  // Lots that are not powers of ten: a whole number of both, 0.5 here.
  assert.equal(e8Text(maxSzE8(1_990_000n, e8('1'), e8('0.5'))), '1.5');
  // Never rounds up, even a hair under a lot.
  assert.equal(e8Text(maxSzE8(9_999_999n, e8('1'), e8('1'))), '9');
});

test('the delta for ZRO, ETHFI, AAVE on hl,orderly: appended entries only, the cap set', () => {
  const { next, add, rows } = planPolicy(LIVE_POLICY, args(), MARKET);
  assert.deepEqual(add.hl_assets, [
    { index: 46, symbol: 'ZRO', sz_decimals: 1 }, { index: 121, symbol: 'ETHFI', sz_decimals: 1 }, { index: 28, symbol: 'AAVE', sz_decimals: 2 },
  ]);
  assert.deepEqual(add.orderly_symbols, ['PERP_ZRO_USDC', 'PERP_ETHFI_USDC', 'PERP_AAVE_USDC']);
  assert.deepEqual(add.phoenix_markets, []);
  assert.deepEqual(add.unpriced, [{ symbol: 'ZRO', max_sz: '8.2' }, { symbol: 'ETHFI', max_sz: '24.9' }, { symbol: 'AAVE', max_sz: '0.11' }]);
  assert.deepEqual(next.hl_assets, [...LIVE_POLICY.hl_assets, ...add.hl_assets]);
  assert.deepEqual(next.orderly_symbols, [...LIVE_POLICY.orderly_symbols, ...add.orderly_symbols]);
  assert.deepEqual(next.phoenix_markets, LIVE_POLICY.phoenix_markets);
  assert.equal(next.unpriced_max_notional_usd, 15);
  assert.equal(next.max_notional_usd, 20);
  assert.deepEqual(additionProblems(LIVE_POLICY, next, { capChange: true }), []);
  assert.deepEqual(rows.map((r) => [r.symbol, e8Text(r.lotE8), r.missing]), [['ZRO', '0.1', []], ['ETHFI', '0.1', []], ['AAVE', '0.01', []]]);
  // Without --unpriced-cap-usd the cap stays.
  assert.equal(planPolicy(LIVE_POLICY, args({ unpricedCap: null }), MARKET).next.unpriced_max_notional_usd, 20);
});

test('hl,phoenix adds the Phoenix market; with both venues the coarsest lot decides', async () => {
  const p = planPolicy(LIVE_POLICY, args({ symbols: ['ZRO', 'AAVE'], venues: ['hl', 'phoenix'] }), MARKET);
  assert.deepEqual(p.add.phoenix_markets, [
    { symbol: 'ZRO', orderbook: '7hWzmBJJTMNe5zWeiRbfo1bJ6FEhKUnJGpa1ficR6RWj', base_lot_e8: 10_000_000, tick_e8: 10_000 },     // 0.1 ZRO, $0.0001
    { symbol: 'AAVE', orderbook: 'A6CdPuNY3mp4tsY1ifQoesHKfwYdVv3wqcaKirEGtaMS', base_lot_e8: 1_000_000, tick_e8: 1_000_000 },  // 0.01 AAVE, $0.01
  ]);
  assert.deepEqual(p.add.orderly_symbols, []);
  const both = planPolicy(LIVE_POLICY, args({ symbols: ['ZRO', 'ETHFI'], venues: ['hl', 'orderly', 'phoenix'] }), MARKET);
  assert.deepEqual(both.add.phoenix_markets.map((m) => m.symbol), ['ZRO']);
  assert.deepEqual(both.add.orderly_symbols, ['PERP_ZRO_USDC', 'PERP_ETHFI_USDC']);
  assert.deepEqual(both.rows.map((r) => r.missing), [[], ['Phoenix']]);
  // A coarser Phoenix lot than Hyperliquid's: the cap is a whole number of it.
  const coarse = clone(VENUES);
  coarse.phoenix.find((m) => m.symbol === 'AAVE').baseLotsDecimals = 1;
  const market = await readMarket({ fetch: venueFetch(coarse) });
  const r = planPolicy(LIVE_POLICY, args({ symbols: ['AAVE'], venues: ['hl', 'phoenix'], usdE6: 30_000_000n }), market);
  assert.equal(r.add.unpriced[0].max_sz, '0.2');  // 0.226 AAVE at 132.73, lot 0.1
});

test('refused: an oracle asset, a prefixed name, a symbol a requested venue lacks, one not on Hyperliquid, one already there', () => {
  refusedWith(() => planPolicy(LIVE_POLICY, args({ symbols: ['ETH'] }), MARKET), /ETH has an oracle price in this contract/);
  refusedWith(() => planPolicy(LIVE_POLICY, args({ symbols: ['kPEPE'] }), MARKET), /kPEPE is a k- or 1000-prefixed name/);
  refusedWith(() => planPolicy(LIVE_POLICY, args({ symbols: ['1000PEPE'] }), MARKET), /1000PEPE is a k- or 1000-prefixed name/);
  refusedWith(() => planPolicy(LIVE_POLICY, args({ symbols: ['ETHFI'], venues: ['hl', 'phoenix'] }), MARKET), /ETHFI: listed on Hyperliquid but not on Phoenix/);
  refusedWith(() => planPolicy(LIVE_POLICY, args({ symbols: ['NOPE'] }), MARKET), /Hyperliquid mainnet lists no active NOPE perp/);
  refusedWith(() => planPolicy(LIVE_POLICY, args({ symbols: ['zro'] }), MARKET), /is not 1 to 22 characters of A-Z and 0-9/);
  refusedWith(() => planPolicy(LIVE_POLICY, args({ symbols: ['AAVE'], usdE6: 1_000_000n }), MARKET), /less than one lot \(0\.01 AAVE\)/);
  const has = planPolicy(LIVE_POLICY, args({ symbols: ['ZRO'] }), MARKET).next;
  refusedWith(() => planPolicy(has, args({ symbols: ['ZRO'] }), MARKET), /ZRO is already in the live policy/);
  // Every reason at once, and nothing half-planned.
  refusedWith(() => planPolicy(LIVE_POLICY, args({ symbols: ['ZRO', 'BTC', 'kBONK'] }), MARKET), /BTC has an oracle price[\s\S]*kBONK is a k-/);
  for (const s of ORACLE_ASSETS) assert.match(addSymbolProblem(s), /oracle price/);
  assert.equal(addSymbolProblem('HYPE'), null);
});

test('refused: a list over 32 entries', () => {
  const full = clone(LIVE_POLICY);
  full.unpriced = Array.from({ length: 31 }, (_, i) => ({ symbol: `X${i}`, max_sz: '1' }));
  refusedWith(() => planPolicy(full, args({ symbols: ['ZRO', 'AAVE'] }), MARKET), /unpriced would have 33 entries, over the contract's 32/);
  // 30 + 2 fits.
  full.unpriced.pop();
  assert.doesNotThrow(() => planPolicy(full, args({ symbols: ['ZRO', 'AAVE'] }), MARKET));
});

test('refused: any removal or change of what is there (the tool only appends)', () => {
  const base = planPolicy(LIVE_POLICY, args(), MARKET).next;
  const fewer = clone(base);
  fewer.orderly_symbols.splice(6, 1);  // PERP_ZRO_USDC gone: ZRO's closes on Orderly would be refused
  assert.match(additionProblems(base, fewer).join('\n'), /orderly_symbols\[6\] PERP_ZRO_USDC would be removed or changed/);
  const dropped = clone(base);
  dropped.unpriced = [];
  assert.equal(additionProblems(base, dropped).length, 3);
  const moved = clone(base);
  moved.hl_assets.reverse();
  assert.ok(additionProblems(base, moved).length > 0);
  const resized = clone(base);
  resized.unpriced[0].max_sz = '9';
  assert.match(additionProblems(base, resized).join('\n'), /unpriced\[0\] ZRO would be removed or changed/);
  const limit = clone(base);
  limit.max_notional_usd = 100;
  assert.match(additionProblems(base, limit).join('\n'), /max_notional_usd would change from 20 to 100/);
  const cap = { ...base, unpriced_max_notional_usd: 5 };
  assert.equal(additionProblems(base, cap).length, 1);
  assert.deepEqual(additionProblems(base, cap, { capChange: true }), []);
  const { max_notional_usd: _, ...missingField } = base;
  assert.match(additionProblems(base, missingField).join('\n'), /max_notional_usd would be removed/);
  // No flag removes: --remove is refused up front with the reason.
  assert.throws(() => parseSetPolicyArgs(['gimbal_dex.near', 'carry', '--remove', 'ZRO']), (e) => e instanceof UsageError && /E_ASSET/.test(e.message));
  assert.throws(() => parseSetPolicyArgs(['gimbal_dex.near', 'carry', '--remove-unpriced']), (e) => e instanceof UsageError && /never removes/.test(e.message));
});

test('the arguments: what is required, what is refused', () => {
  const a = parseSetPolicyArgs(['gimbal_dex.near', 'carry', '--add-unpriced', 'ZRO,ETHFI,AAVE', '--venues', 'hl,orderly', '--usd', '15', '--unpriced-cap-usd', '15']);
  assert.deepEqual(a, { contract: 'gimbal_dex.near', deskId: 'carry', symbols: ['ZRO', 'ETHFI', 'AAVE'], venues: ['hl', 'orderly'], usdE6: 15_000_000n, unpricedCap: 15, expectSha: null, keyFile: null, send: false });
  assert.equal(parseSetPolicyArgs(['gimbal_dex.near', 'carry', '--unpriced-cap-usd', '10']).unpricedCap, 10);
  const usage = (argv, re) => assert.throws(() => parseSetPolicyArgs(argv), (e) => e instanceof UsageError && re.test(e.message));
  usage(['gimbal_dex.near', 'carry'], /nothing to change/);
  usage(['gimbal_dex.near', 'carry', '--add-unpriced', 'ZRO', '--usd', '15'], /needs --venues/);
  usage(['gimbal_dex.near', 'carry', '--add-unpriced', 'ZRO', '--venues', 'hl,orderly'], /needs --usd/);
  usage(['gimbal_dex.near', 'carry', '--add-unpriced', 'ZRO', '--venues', 'orderly,phoenix', '--usd', '15'], /must be hl plus/);
  usage(['gimbal_dex.near', 'carry', '--add-unpriced', 'ZRO', '--venues', 'hl', '--usd', '15'], /must be hl plus/);
  usage(['gimbal_dex.near', 'carry', '--add-unpriced', 'ZRO', '--venues', 'hl,binance', '--usd', '15'], /unknown venue binance/);
  usage(['gimbal_dex.near', 'carry', '--add-unpriced', 'ZRO,ZRO', '--venues', 'hl,orderly', '--usd', '15'], /twice/);
  usage(['gimbal_dex.near', 'carry', '--add-unpriced', 'ZRO', '--venues', 'hl,orderly', '--usd', '0'], /above 0/);
  usage(['gimbal_dex.near', 'carry', '--unpriced-cap-usd', '1.5'], /whole number/);
  usage(['gimbal_dex.near', 'carry', '--venues', 'hl,orderly'], /go with --add-unpriced/);
  usage(['gimbal_dex.near', 'carry', '--unpriced-cap-usd', '10', '--send'], /--send needs --key-file/);
  usage(['gimbal.testnet', 'carry', '--unpriced-cap-usd', '10'], /not a mainnet account/);
  usage(['gimbal_dex.near', 'Carry', '--unpriced-cap-usd', '10'], /desk id/);
});

test('the args match the contract: Policy\'s serde field names and order, set_policy(desk_id, policy), the policy_sha256 form', () => {
  const rs = read('../../contract/core/src/policy.rs');
  const fieldsOf = (name) => {
    const body = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(rs)[1];
    return [...body.matchAll(/^\s*pub (\w+):/gm)].map((m) => m[1]);
  };
  const { next } = planPolicy(LIVE_POLICY, args({ venues: ['hl', 'orderly', 'phoenix'], symbols: ['ZRO', 'AAVE'] }), MARKET);
  const policyFields = fieldsOf('Policy');
  // max_hourly_notional_usd is skipped when None (serde skip_serializing_if): the live policy has none.
  assert.deepEqual(Object.keys(next), policyFields.filter((f) => f !== 'max_hourly_notional_usd'));
  assert.ok(next.hl_assets.every((e) => JSON.stringify(Object.keys(e)) === JSON.stringify(fieldsOf('HlAsset'))));
  assert.ok(next.phoenix_markets.every((e) => JSON.stringify(Object.keys(e)) === JSON.stringify(fieldsOf('PhoenixMarket'))));
  assert.ok(next.unpriced.every((e) => JSON.stringify(Object.keys(e)) === JSON.stringify(fieldsOf('UnpricedAsset'))));
  assert.match(read('../../contract/src/lib.rs'), /pub fn set_policy\(&mut self, desk_id: String, policy: Policy\)/);
  assert.deepEqual(validateForProblems(next), []);
  const call = { desk_id: 'carry', policy: next };
  assert.deepEqual(JSON.parse(argsText(call)), call);
  // The contract's own vector: sha256 of POLICY_2_JSON (contract/src/tests.rs).
  const tests = read('../../contract/src/tests.rs');
  const p2 = JSON.parse(/const POLICY_2_JSON: &str = r#"(.*)"#;/.exec(tests)[1]);
  const sha2 = /const POLICY_2_SHA256: &str = "([0-9a-f]{64})";/.exec(tests)[1];
  assert.equal(policyOrderProblem(p2), null);
  assert.equal(policySha256(p2), sha2);
  assert.equal(policyOrderProblem(LIVE_POLICY), null);
  assert.equal(policySha256(LIVE_POLICY), LIVE_SHA);
  // Another field order is not the contract's JSON: no hash is claimed for it.
  const { hl_assets: h, ...rest } = LIVE_POLICY;
  assert.match(policyOrderProblem({ ...rest, hl_assets: h }), /not Policy's order/);
  // The oracle assets are the contract's.
  const oracle = read('../../contract/core/src/oracle.rs');
  const table = /pub const ORACLE_ASSETS[^=]*= \[([\s\S]*?)\];/.exec(oracle)[1];
  assert.deepEqual([...table.matchAll(/\("(\w+)",/g)].map((m) => m[1]).sort(), ORACLE_ASSETS);
});

test('validate_for port: what the contract would refuse', () => {
  const ok = planPolicy(LIVE_POLICY, args(), MARKET).next;
  assert.deepEqual(validateForProblems({ ...ok, max_hourly_notional_usd: 300 }), []);
  assert.match(validateForProblems({ ...ok, unpriced: [{ symbol: 'ZRO', max_sz: '8.20' }] }).join(), /not a canonical decimal/);
  assert.match(validateForProblems({ ...ok, unpriced: [{ symbol: 'ZRO', max_sz: '9007199254740992' }] }).join(), /over 2\^53 - 1 base units/);
  assert.match(validateForProblems({ ...ok, unpriced: [{ symbol: 'Z RO', max_sz: '1' }] }).join(), /not a symbol/);
  assert.match(validateForProblems({ ...ok, oracle_max_age_s: 60 }).join(), /under 900/);
  assert.match(validateForProblems({ ...ok, max_hourly_notional_usd: -1 }).join(), /max_hourly_notional_usd/);
});

test('deposit: the Borsh growth of the policy plus margin, rounded up to 0.001 NEAR', () => {
  const { next } = planPolicy(LIVE_POLICY, args(), MARKET);
  // hl_assets 3 x (index 4 + len 4 + symbol + sz 1) = 12 + 14 + 13; orderly 3 x (4 + 13/15/14) = 54;
  // unpriced (4 + 3 + 4 + 3) + (4 + 5 + 4 + 4) + (4 + 4 + 4 + 4) = 47.
  assert.equal(policyBorshBytes(next) - policyBorshBytes(LIVE_POLICY), 39 + 54 + 47);
  assert.equal(storageDeposit(140, 10n ** 19n), 7n * 10n ** 21n);  // (140 + 500) x 1e19 = 0.0064 -> 0.007 NEAR
  assert.equal(storageDeposit(0, 10n ** 19n), 5n * 10n ** 21n);
  assert.equal(storageDeposit(-50, 10n ** 19n), 5n * 10n ** 21n);  // a smaller policy still attaches some (at least 1 yocto)
  // A Phoenix market: symbol, 44-character orderbook, two u64.
  const phx = planPolicy(LIVE_POLICY, args({ symbols: ['ZRO'], venues: ['hl', 'phoenix'] }), MARKET).next;
  assert.equal(policyBorshBytes(phx) - policyBorshBytes(LIVE_POLICY), 12 + (7 + 48 + 16) + 14);
});

// --- the run, on a fake mainnet ---

const CONTRACT = 'gimbal_dex.near';
const OWNER = 'owner.near';
const PUBLIC = `ed25519:${'7'.repeat(44)}`;
const NEAR = 10n ** 24n;
const CONFIG = {
  network: 'Mainnet', mpc: 'v1.signer', price_source: { OutLayer: { contract: 'price-oracle.near' } },
  treasury: { near: 'treasury.near', hl_builder: '0x1111111111111111111111111111111111111111', referral_codes: { hyperliquid: null, orderly: null, phoenix: null } },
  fees: { performance_bps: 1000, hl_builder_tenth_bps: 10 },
  orderly: { broker_id: MAINNET_ORDERLY_BROKER, chain_id: 42161 },
};
const FEE = { send_sir: 100, send_not_sir: 100, execution: 100 };
const PROTOCOL = {
  runtime_config: {
    storage_amount_per_byte: '10000000000000000000',
    transaction_costs: {
      action_receipt_creation_config: FEE,
      action_creation_config: {
        deploy_contract_cost: FEE, deploy_contract_cost_per_byte: FEE, function_call_cost: FEE, function_call_cost_per_byte: FEE,
        add_key_cost: { function_call_cost: FEE, function_call_cost_per_byte: FEE },
      },
    },
  },
};
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

/** A fake mainnet with the carry desk. `store(policy)` decides what set_policy leaves on chain (default: the policy sent). */
function world(o = {}) {
  let desk = { owner: OWNER, operator: null, paused: false, closing: false, policy: clone(LIVE_POLICY) };
  const seen = { sent: [], fetch: [], keys: 0 };
  const client = {
    rpc: async (method) => {
      if (method === 'status') return { chain_id: 'mainnet', sync_info: { latest_block_height: 1 } };
      if (method === 'gas_price') return { gas_price: '100000000' };
      if (method === 'EXPERIMENTAL_protocol_config') return PROTOCOL;
      throw new Error(`unexpected rpc ${method}`);
    },
    view: async (id, method, a) => {
      if (id === CONTRACT && method === 'config') return CONFIG;
      if (id === CONTRACT && method === 'get_desk') return a.desk_id === 'carry' ? clone(desk) : null;
      throw new Error(`unexpected view ${id}.${method}`);
    },
    account: async (id) => {
      if (id === CONTRACT) return { amount: String(5n * NEAR), locked: '0', storage_usage: 100_000, code_hash: 'Code111' };
      if (id === OWNER) return { amount: String(o.ownerNear ?? NEAR), locked: '0', storage_usage: 500, code_hash: '11111111111111111111111111111111' };
      return null;
    },
    code: async () => o.code ?? wasmWith(['new', 'config', 'get_desk', 'set_policy']),
    accessKey: async (id, key) => (id === OWNER && key === PUBLIC ? { nonce: 1, permission: o.keyPermission ?? 'FullAccess' } : null),
    send: async (signer, receiver, actions, { onSent } = {}) => {
      seen.sent.push({ signer: signer.accountId, receiver, actions });
      onSent?.('TxHash111');
      const policy = (o.store ?? ((p) => p))(clone(actions[0].args.policy));
      desk = { ...desk, policy };
      const event = { standard: 'gimbal', version: '1.0.0', event: 'policy_set', data: [{ desk_id: 'carry', policy_sha256: policySha256(policy) }] };
      return { hash: 'TxHash111', value: null, failure: null, logs: [`EVENT_JSON:${JSON.stringify(event)}`], burntTgas: 3, burntYocto: 10n ** 20n };
    },
  };
  const deps = {
    near: client,
    fetch: venueFetch(VENUES, seen.fetch),
    say: (s = '') => { seen.out = `${seen.out ?? ''}${s}\n`; },
    now: () => Date.UTC(2026, 10, 4),
    tree: o.tree ?? null,
    readKey: (file, accountId) => {
      seen.keys++;
      assert.equal(accountId, OWNER);
      return { accountId, file, publicKey: Buffer.alloc(32, 7), publicKeyString: PUBLIC, sign: () => Buffer.alloc(64) };
    },
  };
  return { deps, seen, desk: () => desk };
}

const FIRST_USE = [CONTRACT, 'carry', '--add-unpriced', 'ZRO,ETHFI,AAVE', '--venues', 'hl,orderly', '--usd', '15', '--unpriced-cap-usd', '15'];
const PLANNED_SHA = policySha256(planPolicy(LIVE_POLICY, args(), MARKET).next);
/** The README's command: the unpriced cap stays at max_notional_usd (20). */
const RECOMMENDED = [CONTRACT, 'carry', '--add-unpriced', 'ZRO,ETHFI,AAVE', '--venues', 'hl,orderly', '--usd', '15'];

test('legUsd range and the close-cap warning', () => {
  const { next, rows } = planPolicy(LIVE_POLICY, args({ unpricedCap: null }), MARKET);
  const zro = legUsdRange(rows[0], next);
  assert.equal(zro.lo, 10);
  assert.equal(zro.hi.toFixed(2), '14.95');               // 8.2 ZRO x 1.8228, under 20 / 1.01
  assert.equal(zro.capAtBand.toFixed(2), '19.80');
  const capped = planPolicy(LIVE_POLICY, args(), MARKET);
  assert.equal(legUsdRange(capped.rows[0], capped.next).hi.toFixed(2), '14.85');  // 15 / 1.01
  assert.equal(closeCapWarning(rows, 20), null);           // 20 >= 1.3 x 14.95
  assert.match(closeCapWarning(capped.rows, 15), /15 USD, is under 1\.3 x the max_sz worth of ZRO \(14\.94\), ETHFI \(14\.97\), AAVE \(14\.60\)/);
  // A cap under the venue minimum leaves no workable legUsd.
  const tiny = planPolicy(LIVE_POLICY, args({ unpricedCap: 8 }), MARKET);
  const g = legUsdRange(tiny.rows[0], tiny.next);
  assert.ok(g.lo > g.hi);
});

test('the README command: no warning, the cap unchanged, the engine lines', async () => {
  const w = world();
  const block = await runSetPolicy(RECOMMENDED, w.deps);
  const out = w.seen.out;
  assert.ok(!out.includes('warning   the unpriced cap'));
  assert.ok(!out.includes('~ unpriced_max_notional_usd'));
  assert.match(block.join('\n'), /unpriced_max_notional_usd 20 -> 20/);
  assert.match(out, /nothing changes for the engine until serve restarts/);
  assert.match(out, /ZRO, ETHFI, AAVE pair Hyperliquid with Orderly only: serve trades them only with GIMBAL_ORDERLY_PAIRS=1 set on/);
  assert.match(out, /ZRO {4}legUsd 10\.00 to 14\.94 USD \(minimum 10\.00, max_sz worth 14\.94, cap 20 \/ 1\.0100 = 19\.80\)/);
  assert.match(out, /on Hyperliquid up to about 14\.94 USD per order; on Orderly, which takes prices within 3\.0 % of its mark, about 0\.44 USD/);
  const sha = policySha256(planPolicy(LIVE_POLICY, args({ unpricedCap: null }), MARKET).next);
  assert.ok(out.includes(`add --send --key-file <owner key json> --expect-sha256 ${sha}`));
});

test('--send signs only the plan the dry run printed (--expect-sha256)', async () => {
  assert.throws(() => parseSetPolicyArgs([...FIRST_USE, '--key-file', 'k.json', '--send']), (e) => e instanceof UsageError && /--send needs --expect-sha256/.test(e.message));
  assert.throws(() => parseSetPolicyArgs([...FIRST_USE, '--expect-sha256', 'ABC']), (e) => e instanceof UsageError && /64 lowercase hex/.test(e.message));
  // The marks moved since the dry run: another max_sz, another sha256, nothing read or signed.
  const moved = clone(VENUES);
  moved.hl.find((a) => a.name === 'ZRO').markPx = '1.7';
  const w = world();
  w.deps.fetch = venueFetch(moved);
  await assert.rejects(runSetPolicy([...FIRST_USE, '--key-file', 'k.json', '--send', '--expect-sha256', PLANNED_SHA], w.deps),
    /not the --expect-sha256 [0-9a-f]{64}: the live policy or the venues' marks or lists changed since that dry run\. Run the dry run again/);
  assert.equal(w.seen.keys, 0);
  assert.equal(w.seen.sent.length, 0);
  // A dry run given the sha256 says it matches.
  const d = world();
  await runSetPolicy([...FIRST_USE, '--expect-sha256', PLANNED_SHA], d.deps);
  assert.match(d.seen.out, /matches --expect-sha256: this is the plan the dry run printed/);
});

test('dry run: live sha256, the diff, max_sz with mark and USD, the args, signer, deposit, gas, engine and risk; nothing signed', async () => {
  const w = world();
  const block = await runSetPolicy(FIRST_USE, w.deps);
  const out = w.seen.out;
  assert.match(out, new RegExp(`live      policy sha256 ${LIVE_SHA} \\(the contract's policy_sha256`));
  assert.match(out, /\+ hl_assets\[7\] +\{"index":46,"symbol":"ZRO","sz_decimals":1\}/);
  assert.match(out, /\+ orderly_symbols\[8\] +"PERP_AAVE_USDC"/);
  assert.match(out, /\+ unpriced\[1\] +\{"symbol":"ETHFI","max_sz":"24.9"\}/);
  assert.match(out, /~ unpriced_max_notional_usd 20 -> 15/);
  assert.match(out, /ZRO    max_sz 8\.2 ZRO = 14\.94 USD at mark 1\.8228; lot 0\.1 from Hyperliquid 0\.1 \(szDecimals 1\), Orderly 0\.1 \(base_tick 0\.1\)/);
  assert.match(out, /AAVE   max_sz 0\.11 AAVE = 14\.60 USD at mark 132\.73/);
  assert.match(out, /signer    owner\.near/);
  assert.match(out, /FunctionCall set_policy {2}gas 50 TGas {2}deposit 0\.007 NEAR/);
  assert.match(out, /deposit   0\.007 NEAR: the policy grows by 140 bytes/);
  assert.match(out, /start \(railway redeploy, or Redeploy in the Railway dashboard\)/);
  assert.match(out, /warning   the unpriced cap per order, 15 USD, is under 1\.3 x the max_sz worth of ZRO/);
  assert.match(block.join('\n'), /warning: +the unpriced cap per order, 15 USD/);
  assert.match(out, /no oracle price: the contract checks no price band/);
  assert.match(out, /reduce-only closes included \(E_ASSET\)/);
  assert.match(out, /dry run: nothing was signed or sent/);
  const planned = planPolicy(LIVE_POLICY, args(), MARKET).next;
  assert.match(out, new RegExp(`policy sha256 ${policySha256(planned)} \\(the policy_set event must show it; --send needs it as --expect-sha256\\)`));
  // The full args, once on the action line and once one entry per line.
  assert.ok(out.includes(`args ${JSON.stringify({ desk_id: 'carry', policy: planned })}`));
  assert.ok(out.includes(argsText({ desk_id: 'carry', policy: planned })));
  assert.equal(w.seen.sent.length, 0);
  assert.equal(w.seen.keys, 0);
  assert.equal(block[0], '=== gimbal set-policy 2026-11-04T00:00:00.000Z ===');
  assert.match(block.join('\n'), /adds: +ZRO max_sz 8\.2, ETHFI max_sz 24\.9, AAVE max_sz 0\.11; unpriced_max_notional_usd 20 -> 15/);
  // One read per venue endpoint: readLive and the sizing share Orderly's info.
  assert.equal(w.seen.fetch.filter((f) => f.includes('orderly')).length, 1);
});

test('--send: one set_policy from the owner, the policy_set event, get_desk holds exactly the planned additions', async () => {
  const w = world();
  const block = await runSetPolicy([...FIRST_USE, '--key-file', '<owner key json>', '--send', '--expect-sha256', PLANNED_SHA], w.deps);
  assert.equal(w.seen.keys, 1);
  assert.equal(w.seen.sent.length, 1);
  const [tx] = w.seen.sent;
  assert.equal(tx.signer, OWNER);
  assert.equal(tx.receiver, CONTRACT);
  assert.equal(tx.actions.length, 1);
  assert.equal(tx.actions[0].method, 'set_policy');
  assert.equal(tx.actions[0].gasTgas, SET_POLICY_TGAS * 1n);
  assert.equal(tx.actions[0].deposit, 7n * 10n ** 21n);
  assert.deepEqual(Object.keys(tx.actions[0].args), ['desk_id', 'policy']);
  const text = block.join('\n');
  assert.match(text, /event: +policy_set \{"desk_id":"carry","policy_sha256":"[0-9a-f]{64}"\}/);
  assert.match(text, /check: +get_desk holds exactly the planned additions \(ZRO max_sz 8\.2, ETHFI max_sz 24\.9, AAVE max_sz 0\.11\)/);
  assert.match(w.seen.out, /https:\/\/nearblocks\.io\/txns\/TxHash111/);
  assert.deepEqual(w.desk().policy, planPolicy(LIVE_POLICY, args(), MARKET).next);
  assert.ok(!w.seen.out.includes('<owner key json>'));
});

test('--send: a policy on chain that is not the planned one fails loudly', async () => {
  const w = world({ store: (p) => ({ ...p, unpriced: p.unpriced.slice(0, 2) }) });
  await assert.rejects(runSetPolicy([...FIRST_USE, '--key-file', 'k.json', '--send', '--expect-sha256', PLANNED_SHA], w.deps), /not the planned one[\s\S]*unpriced/);
});

test('--send is refused: in a linked worktree, with a key that is not full access, when the owner cannot pay', async () => {
  const send = [...FIRST_USE, '--key-file', 'k.json', '--send', '--expect-sha256', PLANNED_SHA];
  const tree = world({ tree: '/checkout/wt' });
  await assert.rejects(runSetPolicy(send, tree.deps), /linked git worktree: --send runs from the main checkout only/);
  assert.equal(tree.seen.sent.length, 0);
  const fc = world({ keyPermission: { FunctionCall: { receiver_id: CONTRACT, method_names: [] } } });
  await assert.rejects(runSetPolicy(send, fc.deps), /not a full-access key of the desk owner/);
  assert.equal(fc.seen.sent.length, 0);
  const poor = world({ ownerNear: 10n ** 21n });
  await assert.rejects(runSetPolicy(send, poor.deps), /the owner can spend/);
  assert.equal(poor.seen.sent.length, 0);
  const old = world({ code: wasmWith(['new', 'config', 'get_desk']) });
  await assert.rejects(runSetPolicy(FIRST_USE, old.deps), /code has no set_policy/);
});

test('livePolicyProblems checks a name listed twice against its active market, as buildPolicy and the plan pick it', () => {
  const p = planPolicy(LIVE_POLICY, args({ symbols: ['ZRO'], venues: ['hl', 'phoenix'] }), MARKET).next;
  const live = clone({ hl: MARKET.live.hl, phoenix: MARKET.live.phoenix, orderly: MARKET.live.orderly });
  live.hl.unshift({ index: 999, symbol: 'ZRO', szDecimals: 0, delisted: true });
  live.phoenix.unshift({ symbol: 'ZRO', orderbook: '11111111111111111111111111111111', baseLotsDecimals: 0, tickSize: 1, active: false });
  assert.deepEqual(livePolicyProblems(p, live), []);
  // Only the delisted one: still refused.
  live.hl = live.hl.filter((a) => a.symbol !== 'ZRO' || a.delisted);
  assert.match(livePolicyProblems(p, live).join(), /hl_assets ZRO: index 46, Hyperliquid says 999[\s\S]*delisted/);
});

test('a refused plan stops before any transaction is built', async () => {
  const w = world();
  await assert.rejects(runSetPolicy([CONTRACT, 'carry', '--add-unpriced', 'SOL', '--venues', 'hl,orderly', '--usd', '15', '--key-file', 'k.json', '--send', '--expect-sha256', PLANNED_SHA], w.deps), /SOL has an oracle price/);
  assert.equal(w.seen.keys, 0);
  assert.equal(w.seen.sent.length, 0);
});
