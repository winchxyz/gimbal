import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContractPolicy } from '@gimbal/shared';
import {
  addHlAsset,
  addUnpriced,
  coinOfPerp,
  coinsOf,
  policyProblems,
  removeCoin,
  removeUnpriced,
  removeVenue,
  sentenceWith,
  sentenceWithCoin,
  sourceOfNumber,
  starterPolicy,
  strategyProblems,
  unpricedCapUsd,
  unpricedUsd,
  venuesOf,
} from './policy.ts';
import { defaultStrategy } from './rules.ts';
import { fakeDraft } from './fakes.ts';

const policy = (): ContractPolicy => structuredClone(fakeDraft('BTC, ETH, DOGE, $1,500').policy);
const fields = (p: ContractPolicy): string[] => policyProblems(p).map((x) => x.field);

test('the starter policy and a drafted one are accepted by the contract’s rules', () => {
  assert.deepEqual(policyProblems(starterPolicy()), []);
  assert.deepEqual(policyProblems(policy()), []);
});

test('lists are limited to 32, and a duplicate or a bad symbol is refused', () => {
  const p = policy();
  p.hl_assets = Array.from({ length: 33 }, (_, i) => ({ index: i, symbol: `A${i}`, sz_decimals: 2 }));
  assert.match(policyProblems(p)[0]!.message, /at most 32/);
  const dup = policy();
  dup.hl_assets.push({ ...dup.hl_assets[0]! });
  assert.ok(policyProblems(dup).some((x) => /twice/.test(x.message)));
  const bad = policy();
  bad.hl_assets[0]!.sz_decimals = 9;
  assert.match(policyProblems(bad)[0]!.message, /size decimals/);
  const sym = policy();
  sym.orderly_symbols = ['BTC'];
  assert.match(policyProblems(sym)[0]!.message, /not an Orderly perpetual/);
  const ph = policy();
  ph.phoenix_markets = [{ symbol: 'SOL', orderbook: 'not base58 !!', base_lot_e8: 1, tick_e8: 1 }];
  assert.match(policyProblems(ph)[0]!.message, /32-byte address/);
});

test('numbers: band 1..10000 bps, oracle age 900..3600 s, integers within 2^53', () => {
  const p = policy();
  for (const [key, value, field] of [
    ['price_band_bps', 0, 'band'],
    ['price_band_bps', 10_001, 'band'],
    ['oracle_max_age_s', 0, 'age'],
    ['oracle_max_age_s', 899, 'age'],
    ['oracle_max_age_s', 3_601, 'age'],
    ['max_transfer_cost_bps', 10_001, 'transfer'],
    ['max_notional_usd', 1.5, 'size'],
    ['max_notional_usd', -1, 'size'],
    ['rescue_cap_usd_per_hour', 2 ** 53, 'rescue'],
  ] as const) {
    assert.deepEqual(fields({ ...p, [key]: value }), [field], `${key} = ${value}`);
  }
  assert.deepEqual(fields({ ...p, price_band_bps: 10_000, oracle_max_age_s: 3_600 }), []);
});

test('an unpriced size cap must be a canonical decimal', () => {
  const p = policy();
  for (const bad of ['1.50', '012', '', '1.', '-1', '1e5', '0.123456789']) {
    assert.deepEqual(fields({ ...p, unpriced: [{ symbol: 'kPEPE', max_sz: bad }] }), ['unpriced'], bad);
  }
  for (const ok of ['0', '200000', '0.5', '16260.1626']) assert.deepEqual(fields({ ...p, unpriced: [{ symbol: 'kPEPE', max_sz: ok }] }), [], ok);
  assert.ok(policyProblems({ ...p, unpriced: [{ symbol: 'A', max_sz: '1' }, { symbol: 'A', max_sz: '2' }] }).some((x) => /twice/.test(x.message)));
});

test('engine rules: each limit of PUT /strategy, and a leg over the contract’s cap', () => {
  const p = policy();
  const ok = { ...defaultStrategy(), legUsd: 500 };
  assert.deepEqual(strategyProblems(ok, p), []);
  assert.deepEqual(strategyProblems({ ...ok, minNetAprPct: -1 }, p).map((x) => x.field), ['min-apr']);
  assert.deepEqual(strategyProblems({ ...ok, legUsd: 5 }, p).map((x) => x.field), ['leg']);
  assert.match(strategyProblems({ ...ok, legUsd: 5_000 }, p)[0]!.message, /over the contract’s cap of \$1,500/);
  assert.deepEqual(strategyProblems({ ...ok, maxLeverage: 11 }, p).map((x) => x.field), ['leverage']);
  assert.deepEqual(strategyProblems({ ...ok, stopDrawdownPct: 0 }, p).map((x) => x.field), ['stop']);
  assert.deepEqual(strategyProblems({ ...ok, stopDrawdownPct: null }, p), []);
  assert.deepEqual(strategyProblems({ ...ok, rotate: { minGainPts: -1, forHours: 721 } }, p).map((x) => x.field), ['rotate-gain', 'rotate-hours']);
  assert.deepEqual(strategyProblems({ ...ok, risk: { watchDistancePct: 8, rescueDistancePct: 15 } }, p).map((x) => x.field), ['risk']);
});

test('coins, venues and removals', () => {
  const p = policy();
  assert.deepEqual(coinsOf(p), ['BTC', 'ETH', 'SOL', 'DOGE']);
  assert.deepEqual(venuesOf(p), ['hyperliquid', 'orderly']);
  assert.equal(coinOfPerp('PERP_SOL_USDC'), 'SOL');
  const without = removeCoin(p, 'ETH');
  assert.deepEqual(coinsOf(without), ['BTC', 'SOL', 'DOGE']);
  assert.equal(without.orderly_symbols.includes('PERP_ETH_USDC'), false);
  assert.deepEqual(venuesOf(removeVenue(p, 'orderly')), ['hyperliquid']);
  assert.deepEqual(removeUnpriced({ ...p, unpriced: [{ symbol: 'X', max_sz: '1' }] }, 'X').unpriced, []);
});

test('an unpriced asset from a dollar cap and a mark', () => {
  const p = policy();
  const got = addUnpriced(p, ' kPEPE ', 1500, 0.0075);
  assert.ok('policy' in got);
  if ('policy' in got) assert.deepEqual(got.policy.unpriced, [{ symbol: 'kPEPE', max_sz: '200000' }]);
  assert.ok('error' in addUnpriced(p, 'kPEPE', 0, 1));
  assert.ok('error' in addUnpriced(p, 'kPEPE', 100, 0));
  assert.ok('error' in addUnpriced(p, '', 100, 1));
  assert.ok('error' in addUnpriced(p, 'a b', 100, 1));
  const twice = addUnpriced({ ...p, unpriced: [{ symbol: 'kPEPE', max_sz: '1' }] }, 'kPEPE', 100, 1);
  assert.ok('error' in twice && /already/.test(twice.error));
  assert.equal(unpricedUsd('200000', 0.0075), 1500);
  assert.equal(unpricedUsd('200000', undefined), null);
  assert.equal(unpricedCapUsd({ ...p, max_notional_usd: 1500, unpriced_max_notional_usd: 400 }), 400, 'the smaller of the two caps is the one that binds');
});

test('adding a Hyperliquid asset by its listing', () => {
  const p = policy();
  const added = addHlAsset(p, { index: 150, symbol: 'kPEPE', sz_decimals: 0 });
  assert.ok('policy' in added && added.policy.hl_assets.at(-1)?.symbol === 'kPEPE');
  assert.ok('error' in addHlAsset(p, { index: 99, symbol: 'BTC', sz_decimals: 5 }));
  assert.ok('error' in addHlAsset(p, { index: 0, symbol: 'NEW', sz_decimals: 5 }), 'an index in use');
});

test('a number in the owner’s words is traced to its sentence; one that is not there is the model’s', () => {
  const words = 'I want steady income. Never more than $1,500 a side and never more than 3x. Big coins plus DOGE and NEAR.';
  assert.equal(sentenceWith(words, 1500), 'Never more than $1,500 a side and never more than 3x.');
  assert.equal(sentenceWith(words, 3), 'Never more than $1,500 a side and never more than 3x.');
  assert.equal(sentenceWith(words, 150), null, '150 is not in 1,500');
  assert.equal(sentenceWith(words, 5), null);
  assert.equal(sentenceWith('up to 1.5k a side', 1500), 'up to 1.5k a side');
  assert.equal(sentenceWithCoin(words, 'DOGE'), 'Big coins plus DOGE and NEAR.');
  assert.equal(sentenceWithCoin(words, 'DOG'), null, 'a coin is a whole word');
  assert.deepEqual(sourceOfNumber(words, 1500, 'a limit'), { kind: 'words', quote: 'Never more than $1,500 a side and never more than 3x' });
  assert.deepEqual(sourceOfNumber(words, 60, 'a limit'), { kind: 'ai', note: 'a limit, not a number in your words' });
});
