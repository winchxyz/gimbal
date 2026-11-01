import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CANARY_POLICY_FILE, policyDiff } from './policy.mjs';
import {
  CANARY_SYMBOLS, MAINNET_ORDERLY_BROKER, brokerIdProblem, buildPolicy, formatPolicy, livePolicyProblems, phoenixUnits, policyShapeProblems,
  readLive,
} from './venues.mjs';

// The venues' answers as recorded on mainnet 2026-10-31, cut to the fields the policy reads.
const HL_META = {
  universe: [
    { szDecimals: 5, name: 'BTC' }, { szDecimals: 4, name: 'ETH' }, { szDecimals: 1, name: 'ATOM' }, { szDecimals: 1, name: 'MATIC', isDelisted: true },
    { szDecimals: 1, name: 'DYDX' }, { szDecimals: 2, name: 'SOL' }, { szDecimals: 1, name: 'AVAX' }, { szDecimals: 1, name: 'BNB' },
    { szDecimals: 1, name: 'APE', isDelisted: true }, { szDecimals: 1, name: 'OP' }, { szDecimals: 2, name: 'LTC' }, { szDecimals: 1, name: 'ARB' },
    { szDecimals: 0, name: 'DOGE' },
  ],
};
const PHOENIX = [
  { symbol: 'SOL', marketPubkey: '71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2', baseLotsDecimals: 2, tickSize: 100, marketStatus: 'active' },
  { symbol: 'ETH', marketPubkey: '9u7aqptdRFbsnnoHtjK13E5JkeM14EW5fAKTRPidVF88', baseLotsDecimals: 3, tickSize: 100, marketStatus: 'active' },
  { symbol: 'BTC', marketPubkey: 'AXFz1MuzMUBHi5UKJuK3FDCQ73o3rSzubGU2mPr4LLU7', baseLotsDecimals: 4, tickSize: 100, marketStatus: 'active' },
  { symbol: 'LTC', marketPubkey: 'HFYNBdwXP1BrnD7eLx7B3NGHi3VqEHdTkQH9FhEUFa8n', baseLotsDecimals: 2, tickSize: 10, marketStatus: 'active' },
  { symbol: 'DOGE', marketPubkey: 'Hqt5Vom5L3X3RcKysKnBmLAvjYgo6TGAwoheW658h5cz', baseLotsDecimals: 0, tickSize: 1, marketStatus: 'active' },
];
const ORDERLY = { success: true, data: { rows: ['PERP_BTC_USDC', 'PERP_ETH_USDC', 'PERP_SOL_USDC', 'PERP_DOGE_USDC', 'PERP_LTC_USDC', 'PERP_XRP_USDC'].map((symbol) => ({ symbol })) } };

const fakeFetch = async (url) => {
  const body = url.includes('hyperliquid') ? HL_META : url.includes('phoenix') ? PHOENIX : url.includes('orderly') ? ORDERLY : null;
  assert.ok(body !== null, url);
  assert.doesNotMatch(url, /testnet/);
  return { ok: true, status: 200, json: async () => body };
};

const live = await readLive({ fetch: fakeFetch });
const clone = (x) => JSON.parse(JSON.stringify(x));

test('Phoenix units: base_lot_e8 = 10^(8 - baseLotsDecimals), tick_e8 = tickSize x 10^(baseLotsDecimals + 2)', () => {
  assert.deepEqual(phoenixUnits(2, 100), { base_lot_e8: 1_000_000, tick_e8: 1_000_000 });   // SOL: 0.01 SOL, $0.01
  assert.deepEqual(phoenixUnits(3, 100), { base_lot_e8: 100_000, tick_e8: 10_000_000 });   // ETH: 0.001 ETH, $0.1
  assert.deepEqual(phoenixUnits(4, 100), { base_lot_e8: 10_000, tick_e8: 100_000_000 });   // BTC: 0.0001 BTC, $1
  assert.deepEqual(phoenixUnits(0, 1), { base_lot_e8: 100_000_000, tick_e8: 100 });        // DOGE: 1 DOGE, $0.000001
  assert.deepEqual(phoenixUnits(-3, 1000), { base_lot_e8: 100_000_000_000, tick_e8: 100 });  // a lot of 1000 units
  assert.throws(() => phoenixUnits(-3, 5), /not a whole number/);
  assert.throws(() => phoenixUnits(9, 1), /under 1e-8/);
  assert.throws(() => phoenixUnits(2, 0), /tickSize/);
});

test('the canary policy from live data: the five oracle assets, the canary limits, nothing unpriced', () => {
  const p = buildPolicy(live);
  assert.deepEqual(p.hl_assets, [
    { index: 0, symbol: 'BTC', sz_decimals: 5 }, { index: 1, symbol: 'ETH', sz_decimals: 4 }, { index: 5, symbol: 'SOL', sz_decimals: 2 },
    { index: 12, symbol: 'DOGE', sz_decimals: 0 }, { index: 10, symbol: 'LTC', sz_decimals: 2 },
  ]);
  assert.deepEqual(p.phoenix_markets.map((m) => m.symbol), CANARY_SYMBOLS);
  assert.deepEqual(p.orderly_symbols, CANARY_SYMBOLS.map((s) => `PERP_${s}_USDC`));
  assert.equal(p.max_notional_usd, 20);
  assert.equal(p.price_band_bps, 100);
  assert.equal(p.oracle_max_age_s, 900);
  assert.equal(p.rescue_cap_usd_per_hour, 20);
  assert.equal(p.max_transfer_cost_bps, 300, 'fund_venue counts the 0.5 % room it requires as cost');
  assert.equal(p.max_transfer_cost_flat_e6, 1_000_000);
  assert.deepEqual(p.unpriced, []);
  assert.equal(p.unpriced_max_notional_usd, 20);
  assert.deepEqual(policyShapeProblems(p), []);
  assert.deepEqual(JSON.parse(formatPolicy(p)), p, 'the file format reads back as the same policy');
  // A symbol Phoenix does not list is left out of phoenix_markets, never invented.
  const fewer = buildPolicy({ ...live, phoenix: live.phoenix.filter((m) => m.symbol !== 'LTC') });
  assert.deepEqual(fewer.phoenix_markets.map((m) => m.symbol), ['BTC', 'ETH', 'SOL', 'DOGE']);
  assert.throws(() => buildPolicy({ ...live, hl: live.hl.filter((a) => a.symbol !== 'DOGE') }), /no active DOGE perp/);
});

test('tools/mainnet-canary-policy.json is the policy built from the recorded data, and valid', () => {
  const file = JSON.parse(readFileSync(CANARY_POLICY_FILE, 'utf8'));
  assert.deepEqual(policyShapeProblems(file), []);
  assert.deepEqual(livePolicyProblems(file, live), []);
  assert.deepEqual(policyDiff(buildPolicy(live), file), []);
  assert.equal(readFileSync(CANARY_POLICY_FILE, 'utf8'), formatPolicy(file));
});

test('policy mismatch refusal: an index, szDecimals, orderbook, lot, tick or symbol that live data does not have', () => {
  const good = buildPolicy(live);
  assert.deepEqual(livePolicyProblems(good, live), []);
  const cases = [
    [(p) => { p.hl_assets[0].index = 3; }, /hl_assets BTC: index 3, Hyperliquid says 0/],
    [(p) => { p.hl_assets[2].sz_decimals = 3; }, /hl_assets SOL: sz_decimals 3, Hyperliquid says 2/],
    [(p) => { p.hl_assets.push({ index: 99, symbol: 'NOPE', sz_decimals: 0 }); }, /hl_assets NOPE: Hyperliquid mainnet lists no such perp/],
    [(p) => { p.hl_assets.push({ index: 3, symbol: 'MATIC', sz_decimals: 1 }); }, /hl_assets MATIC: delisted/],
    [(p) => { p.phoenix_markets[0].orderbook = p.phoenix_markets[1].orderbook; }, /phoenix_markets BTC: orderbook 9u7aq.*Phoenix says AXFz1/],
    [(p) => { p.phoenix_markets[1].base_lot_e8 = 1_000_000; }, /phoenix_markets ETH: base_lot_e8 1000000, Phoenix says 100000/],
    [(p) => { p.phoenix_markets[2].tick_e8 = 1; }, /phoenix_markets SOL: tick_e8 1, Phoenix says 1000000/],
    [(p) => { p.phoenix_markets.push({ symbol: 'XRP', orderbook: '11111111111111111111111111111112', base_lot_e8: 1, tick_e8: 1 }); }, /phoenix_markets XRP: Phoenix mainnet lists no such market/],
    [(p) => { p.orderly_symbols.push('PERP_NOPE_USDC'); }, /orderly_symbols PERP_NOPE_USDC: Orderly mainnet lists no such symbol/],
  ];
  for (const [change, pattern] of cases) {
    const p = clone(good);
    change(p);
    assert.match(livePolicyProblems(p, live).join('\n'), pattern);
  }
  const inactive = clone(live);
  inactive.phoenix[0].active = false;
  assert.match(livePolicyProblems(good, inactive).join(), /phoenix_markets SOL: not active/);
});

test('policy shape: what the contract would refuse, and mainnet\'s oracle age floor', () => {
  const good = buildPolicy(live);
  const cases = [
    [(p) => { delete p.unpriced; }, /policy\.unpriced is missing/],
    [(p) => { p.extra = 1; }, /policy\.extra is not a policy field/],
    [(p) => { p.hl_assets[0].sz_decimals = 7; }, /sz_decimals is not 0 to 6/],
    [(p) => { p.hl_assets[1].index = 0; }, /hl_assets: two entries share the index/],
    [(p) => { p.phoenix_markets[0].orderbook = '0xnot-base58'; }, /orderbook is not a base58 address/],
    [(p) => { p.phoenix_markets[0].tick_e8 = 0; }, /tick_e8 is not 1/],
    [(p) => { p.orderly_symbols[0] = 'BTC-PERP'; }, /not PERP_<BASE>_USDC/],
    [(p) => { p.unpriced = [{ symbol: 'HYPE', max_sz: '1.50' }]; }, /max_sz is not a canonical decimal/],
    [(p) => { p.price_band_bps = 0; }, /price_band_bps is not 1 to 10000/],
    [(p) => { p.oracle_max_age_s = 120; }, /under 900/],
    [(p) => { p.oracle_max_age_s = 7200; }, /not 1 to 3600/],
    [(p) => { p.max_notional_usd = 2 ** 53; }, /max_notional_usd is not 0 to 2\^53 - 1/],
  ];
  for (const [change, pattern] of cases) {
    const p = clone(good);
    change(p);
    assert.match(policyShapeProblems(p).join('\n'), pattern);
  }
});

test('the Orderly broker: one expected value, the engine\'s mainnet broker; the testnet broker and any other id are refused', async () => {
  // The engine's own table (its imports are type-only, so Node loads the .ts as it is).
  const { ORDERLY_BROKERS } = await import('../../engine/src/scanner/config.ts');
  assert.equal(MAINNET_ORDERLY_BROKER, ORDERLY_BROKERS.mainnet.brokerId);
  assert.equal(brokerIdProblem(ORDERLY_BROKERS.mainnet.brokerId), null);
  assert.match(brokerIdProblem(ORDERLY_BROKERS.testnet.brokerId), /the testnet broker/);
  assert.match(brokerIdProblem('woofi_dex'), /is woofi_dex, the testnet broker/);
  for (const id of ['', 'someone_else', `${MAINNET_ORDERLY_BROKER} `, MAINNET_ORDERLY_BROKER.toUpperCase()]) {
    assert.match(brokerIdProblem(id), /is not the engine's mainnet broker/, JSON.stringify(id));
  }
});

test('the reads go to the mainnet venue APIs only', async () => {
  const urls = [];
  await readLive({ fetch: async (url, init) => { urls.push(url); return fakeFetch(url, init); } });
  assert.deepEqual(urls.sort(), [
    'https://api.hyperliquid.xyz/info',
    'https://api.orderly.org/v1/public/info',
    'https://perp-api.phoenix.trade/v1/view/exchange/markets',
  ]);
  assert.ok(fileURLToPath(new URL('./policy.mjs', import.meta.url)));
});
