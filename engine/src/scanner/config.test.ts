// What PUT /strategy and the policy file accept: finite numbers inside sane bounds, nothing unknown.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContractPolicy } from '@gimbal/shared';
import {
  DEFAULT_COSTS, DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY, MAINNET_COSTS, ORDERLY_BROKERS, STRATEGY_LIMITS, TESTNET_COSTS,
  costsFor, parseContractPolicy, parseStrategyConfig, scannerConfigFor,
} from './config.ts';
import { fillFeeBps } from './costs.ts';

const POLICY: ContractPolicy = {
  hl_assets: [{ index: 5, symbol: 'SOL', sz_decimals: 2 }],
  phoenix_markets: [{ symbol: 'SOL', orderbook: 'test-orderbook-sol', base_lot_e8: 1, tick_e8: 1 }],
  orderly_symbols: ['PERP_SOL_USDC'],
  max_notional_usd: 5000, price_band_bps: 100, oracle_max_age_s: 60, rescue_cap_usd_per_hour: 500,
  unpriced: [{ symbol: 'WIF', max_sz: '5000.5' }], unpriced_max_notional_usd: 100,
  max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 2_000_000,
};

test('strategy: the default passes and comes back as a clean copy', () => {
  const out = parseStrategyConfig(DEFAULT_STRATEGY, POLICY);
  assert.deepEqual(out, DEFAULT_STRATEGY);
  assert.notEqual(out, DEFAULT_STRATEGY);
  assert.notEqual(out.risk, DEFAULT_STRATEGY.risk);
});

test('strategy: what a hostile page sent is refused, field by field', () => {
  const bad: [Record<string, unknown>, RegExp][] = [
    // The values a cross-site PUT tried: a negative minimum, a billion-dollar leg, 1000× leverage.
    [{ minNetAprPct: -1000 }, /minNetAprPct must be a number from 0 to 1000/],
    [{ legUsd: 1e9 }, /legUsd must be a number from 10 to 100000/],
    [{ maxLeverage: 1000 }, /maxLeverage must be a number from 1 to 10/],
    // 1e308 passes a plain > 0 check and turns into NaN and Infinity in every cost term.
    [{ legUsd: 1e308 }, /legUsd must be a number from 10/],
    [{ legUsd: 0 }, /legUsd must be a number from 10/],
    [{ legUsd: Number.NaN }, /legUsd must be a number from 10/],
    [{ legUsd: '1000' }, /legUsd must be a number from 10/],
    // From the review: 1e-310 made null numbers, 1e-9 made ±1e13 % APR. Below the venues' $10 minimum order.
    [{ legUsd: 1e-310 }, /legUsd must be a number from 10 to 100000/],
    [{ legUsd: 1e-9 }, /legUsd must be a number from 10 to 100000/],
    [{ legUsd: 9.99 }, /legUsd must be a number from 10 to 100000/],
    [{ legUsd: 6000 }, /legUsd 6000 is over the policy cap of 5000 USD per leg/],
    [{ maxLeverage: 0.5 }, /maxLeverage must be a number from 1 to 10/],
    [{ minNetAprPct: 1e6 }, /minNetAprPct must be a number from 0 to 1000/],
    [{ stopDrawdownPct: 0 }, /stopDrawdownPct must be null or a percentage in \(0, 100\]/],
    [{ stopDrawdownPct: 101 }, /stopDrawdownPct must be null/],
    [{ rotate: { minGainPts: -1, forHours: 4 } }, /rotate needs minGainPts from 0 to 1000/],
    [{ rotate: { minGainPts: 3, forHours: 1e6 } }, /forHours from 0 to 720/],
    [{ rotate: { minGainPts: 3, forHours: 4, when: 'now' } }, /unknown field rotate.when/],
    [{ risk: { watchDistancePct: 8, rescueDistancePct: 15 } }, /0 < rescueDistancePct < watchDistancePct < 100/],
    [{ risk: { watchDistancePct: 8, rescueDistancePct: 8 } }, /0 < rescueDistancePct < watchDistancePct < 100/],
    [{ risk: { watchDistancePct: 150, rescueDistancePct: 8 } }, /watchDistancePct < 100/],
    [{ risk: { watchDistancePct: 15, rescueDistancePct: 0 } }, /0 < rescueDistancePct/],
    [{ risk: { watchDistancePct: 15, rescueDistancePct: 8, margin: 1 } }, /unknown field risk.margin/],
    [{ auto: 'yes' }, /auto must be a boolean/],
    [{ extra: 1 }, /unknown field extra/],
  ];
  for (const [over, error] of bad) assert.throws(() => parseStrategyConfig({ ...DEFAULT_STRATEGY, ...over }, POLICY), error, JSON.stringify(over));
  assert.throws(() => parseStrategyConfig(null), /not an object/);
  assert.throws(() => parseStrategyConfig([DEFAULT_STRATEGY]), /not an object/);
  // The bounds hold with no policy loaded too.
  assert.throws(() => parseStrategyConfig({ ...DEFAULT_STRATEGY, legUsd: STRATEGY_LIMITS.maxLegUsd + 1 }), /legUsd must be/);
  // Without a policy the engine cap is the only one: 100k passes.
  assert.equal(parseStrategyConfig({ ...DEFAULT_STRATEGY, legUsd: STRATEGY_LIMITS.maxLegUsd }).legUsd, 100_000);
  // The smallest order the venues take is the smallest leg.
  assert.equal(STRATEGY_LIMITS.minLegUsd, 10);
  assert.equal(parseStrategyConfig({ ...DEFAULT_STRATEGY, legUsd: 10 }, POLICY).legUsd, 10);
  assert.equal(parseStrategyConfig({ ...DEFAULT_STRATEGY, stopDrawdownPct: null }, POLICY).stopDrawdownPct, null);
});

test('Orderly fees: gimbal_dex on mainnet (maker 0, taker 4 = 3 base + 1 markup); the testnet broker keeps 1.5 bps', () => {
  assert.deepEqual(ORDERLY_BROKERS.mainnet, { brokerId: 'gimbal_dex', makerBps: 0, takerBps: 4, markupBps: 1 });
  assert.deepEqual(MAINNET_COSTS.fees.orderly, { takerBps: 3, extraBps: 1 });
  assert.equal(fillFeeBps(MAINNET_COSTS.fees.orderly), ORDERLY_BROKERS.mainnet.takerBps);
  assert.equal(ORDERLY_BROKERS.testnet.brokerId, 'woofi_dex');
  assert.deepEqual(TESTNET_COSTS.fees.orderly, { takerBps: 3, extraBps: 1.5 });
  assert.equal(fillFeeBps(TESTNET_COSTS.fees.orderly), ORDERLY_BROKERS.testnet.takerBps);
  // Only Orderly differs between the networks; replay plays recorded mainnet answers, so it prices mainnet's fees.
  assert.deepEqual({ ...TESTNET_COSTS, fees: { ...TESTNET_COSTS.fees, orderly: MAINNET_COSTS.fees.orderly } }, MAINNET_COSTS);
  assert.equal(DEFAULT_COSTS, MAINNET_COSTS);
  assert.equal(DEFAULT_SCANNER_CONFIG.costs, MAINNET_COSTS);
  assert.equal(costsFor('mainnet'), MAINNET_COSTS);
  assert.equal(costsFor('replay'), MAINNET_COSTS);
  assert.equal(costsFor('testnet'), TESTNET_COSTS);
  assert.deepEqual(scannerConfigFor('testnet'), { ...DEFAULT_SCANNER_CONFIG, costs: TESTNET_COSTS });
});

test('policy file: a good one is copied; a policy without unpriced has none', () => {
  assert.deepEqual(parseContractPolicy(POLICY), POLICY);
  const { unpriced: _u, unpriced_max_notional_usd: _c, ...older } = POLICY;
  const p = parseContractPolicy(older);
  assert.deepEqual(p.unpriced, []);
  assert.equal(p.unpriced_max_notional_usd, 0);
});

test('policy file: a misread policy is refused with the first thing wrong', () => {
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ hl_assets: 'SOL' }, /hl_assets must be a list/],
    [{ hl_assets: [{ index: -1, symbol: 'SOL', sz_decimals: 2 }] }, /hl_assets\[0\] needs index, symbol and sz_decimals/],
    [{ phoenix_markets: [{ symbol: 'SOL' }] }, /phoenix_markets\[0\] needs symbol, orderbook/],
    [{ orderly_symbols: [''] }, /orderly_symbols\[0\] must be a symbol/],
    [{ unpriced: [{ symbol: 'WIF', max_sz: 5000 }] }, /unpriced\[0\] needs symbol and max_sz as a decimal string/],
    [{ unpriced: [{ symbol: 'WIF', max_sz: '1e3' }] }, /max_sz as a decimal string/],
    [{ unpriced: [{ symbol: 'WIF', max_sz: '-5' }] }, /max_sz as a decimal string/],
    [{ unpriced_max_notional_usd: undefined }, /unpriced_max_notional_usd must be a number >= 0/],
    [{ max_notional_usd: 0 }, /max_notional_usd must be a number > 0/],
    [{ oracle_max_age_s: 0 }, /oracle_max_age_s must be a number > 0/],
    [{ price_band_bps: -1 }, /price_band_bps must be a number >= 0/],
    [{ max_transfer_cost_bps: '50' }, /max_transfer_cost_bps must be a number >= 0/],
  ];
  for (const [over, error] of bad) assert.throws(() => parseContractPolicy({ ...POLICY, ...over }), error, JSON.stringify(over));
  assert.throws(() => parseContractPolicy([]), /policy: not an object/);
});
