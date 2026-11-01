// Margin ratio and distance to liquidation per venue, on hand-computed cases (the formulas are in margin.ts):
//   long  distance = (e − m) / (1 − m),  liqPx = (qP − E) / (q(1 − m))
//   short distance = (e − m) / (1 + m),  liqPx = (E + |q|P) / (|q|(1 + m))
// with e = equity / notional and m = maintenance / notional.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HlClearinghouseState } from '../venues/hyperliquid.ts';
import { parseAccount as parseHlAccount } from '../venues/hyperliquid.ts';
import type { AccountState, Position } from '../venues/venue.ts';
import { computedLiqPx, distancePct, legMark, legRisk, marginToReach } from './margin.ts';

function near(actual: number | null, expected: number, eps = 1e-6, what = ''): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= eps, `${what} ${actual} != ${expected}`);
}

test('Hyperliquid, cross long 1 ETH at 2000 with 100 USD: m = 1/(2 × 25) = 2 %, the venue liquidation price is the nearer', () => {
  // clearinghouseState as Hyperliquid answers it, through the reader's own parser.
  const raw: HlClearinghouseState = {
    marginSummary: { accountValue: '100' }, crossMaintenanceMarginUsed: '40', withdrawable: '20', time: 1,
    assetPositions: [{
      position: {
        coin: 'ETH', szi: '1', entryPx: '2010', liquidationPx: '1940', marginUsed: '80', unrealizedPnl: '-10',
        leverage: { value: 25 }, cumFunding: { sinceOpen: '0' },
      },
    }],
  };
  const account = parseHlAccount('0xdesk', raw);
  const position = account.positions[0]!;
  assert.equal(legMark(position, null), 2000, 'entry 2010 + uPnL −10 / 1');
  const r = legRisk({ venue: 'hyperliquid', account, position, markPx: null });
  near(r.maintenanceFraction, 0.02);
  near(r.equityFraction, 0.05);
  near(r.marginRatio, 0.4, 1e-12, 'maintenance 40 / equity 100');
  near(r.computedLiqPx, 1900 / 0.98, 1e-9, '(2000 − 100) / 0.98 = 1938.7755');
  // Computed: (0.05 − 0.02) / 0.98 = 3.0612 %; the venue's 1940: (2000 − 1940) / 2000 = 3 %, nearer, so it is used.
  near(distancePct('long', 2000, r.computedLiqPx), 3.0612244898, 1e-9);
  assert.equal(r.liqPx, 1940);
  near(r.distanceToLiqPct, 3, 1e-9);
  // To 15 %: e = 0.15 × 0.98 + 0.02 = 0.167, (0.167 − 0.05) × 2000 = 234 USD.
  near(marginToReach(r, 'long', 15), 234, 1e-9);
});

test('Phoenix, short 2 SOL at 150 with 30 USD (10x), m = 2.5 %: the computed price is nearer than the SDK one', () => {
  const position: Position = {
    symbol: 'SOL', size: -2, entryPx: 150, liqPx: 161.2, marginUsd: 30, unrealizedPnlUsd: 0, leverage: 10,
    fundingSinceOpenUsd: 0, unsettledFundingUsd: 0.12,
  };
  const account: AccountState = {
    venue: 'phoenix', address: 'auth', time: 1, equityUsd: 30, freeMarginUsd: 0, maintenanceMarginUsd: 7.5, positions: [position],
  };
  const r = legRisk({ venue: 'phoenix', account, position, markPx: 150 });
  near(r.maintenanceFraction, 0.025);
  near(r.marginRatio, 0.25);
  // (30 + 300) / (2 × 1.025) = 160.9756; distance (0.1 − 0.025) / 1.025 = 7.3171 %. The SDK's 161.2 is 7.4667 %.
  near(r.computedLiqPx, 330 / 2.05, 1e-9);
  near(r.liqPx, 160.9756097561, 1e-9);
  near(r.distanceToLiqPct, 0.075 / 1.025 * 100, 1e-9);
  // To 15 %: e = 0.15 × 1.025 + 0.025 = 0.17875, (0.17875 − 0.1) × 300 = 23.625 USD.
  near(marginToReach(r, 'short', 15), 23.625, 1e-9);
});

test('Orderly, long 0.1 BTC at 60000 with 1000 USD, MMR 0.6 %, no estLiqPrice (0 → null): the computed price', () => {
  const position: Position = {
    symbol: 'PERP_BTC_USDC', size: 0.1, entryPx: 60000, liqPx: null, marginUsd: 600, unrealizedPnlUsd: 0, leverage: 10,
    fundingSinceOpenUsd: 0, unsettledFundingUsd: 0,
  };
  const account: AccountState = {
    venue: 'orderly', address: '0xacct', time: 1, equityUsd: 1000, freeMarginUsd: 400, maintenanceMarginUsd: 36, positions: [position],
  };
  const r = legRisk({ venue: 'orderly', account, position, markPx: 60000 });
  near(r.maintenanceFraction, 0.006);
  near(r.marginRatio, 0.036);
  // (6000 − 1000) / (0.1 × 0.994) = 50301.81; distance (1/6 − 0.006) / 0.994 = 16.1637 %.
  near(r.liqPx, 5000 / 0.0994, 1e-6);
  near(r.distanceToLiqPct, (1 / 6 - 0.006) / 0.994 * 100, 1e-9);
});

test('an account with two positions: only the venue liquidation price applies', () => {
  const eth: Position = { symbol: 'ETH', size: 1, entryPx: 2000, liqPx: 1800, marginUsd: 100, unrealizedPnlUsd: 0, leverage: 20, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0 };
  const btc: Position = { symbol: 'BTC', size: -0.01, entryPx: 60000, liqPx: 90000, marginUsd: 30, unrealizedPnlUsd: 0, leverage: 20, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0 };
  const account: AccountState = { venue: 'hyperliquid', address: '0x', time: 1, equityUsd: 500, freeMarginUsd: 0, maintenanceMarginUsd: 26, positions: [eth, btc] };
  const r = legRisk({ venue: 'hyperliquid', account, position: eth, markPx: 2000 });
  assert.equal(r.computedLiqPx, null);
  assert.equal(r.liqPx, 1800);
  near(r.distanceToLiqPct, 10, 1e-9);
  near(r.maintenanceFraction, 26 / 2600, 1e-12, 'maintenance over both notionals');
});

test('equity at or under maintenance: ratio ≥ 1 and distance 0; an over-collateralised long has no liquidation price', () => {
  const p: Position = { symbol: 'ETH', size: 1, entryPx: 2000, liqPx: null, marginUsd: 40, unrealizedPnlUsd: 0, leverage: 50, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0 };
  const under = legRisk({ venue: 'hyperliquid', account: { venue: 'hyperliquid', address: '', time: 1, equityUsd: 30, freeMarginUsd: 0, maintenanceMarginUsd: 40, positions: [p] }, position: p, markPx: 2000 });
  near(under.marginRatio, 40 / 30);
  assert.equal(under.distanceToLiqPct, 0);
  // 1 ETH with 2500 USD: (2000 − 2500) / 0.98 < 0, so price alone cannot liquidate it.
  assert.equal(computedLiqPx(1, 2000, 2500, 0.02), null);
  const safe = legRisk({ venue: 'hyperliquid', account: { venue: 'hyperliquid', address: '', time: 1, equityUsd: 2500, freeMarginUsd: 0, maintenanceMarginUsd: 40, positions: [p] }, position: p, markPx: 2000 });
  assert.equal(safe.liqPx, null);
  assert.equal(safe.distanceToLiqPct, null);
  // A short always has one: (2500 + 2000) / 1.02.
  near(computedLiqPx(-1, 2000, 2500, 0.02), 4500 / 1.02, 1e-9);
});

test('two positions, no venue liquidation price, equity 2 % over maintenance: the account margin gives the distance, not null', () => {
  // The reviewer's case: this read as `level` (distance null) on a margin ratio of 0.98.
  const eth: Position = { symbol: 'ETH', size: -10, entryPx: 2000, liqPx: null, marginUsd: 1000, unrealizedPnlUsd: 0, leverage: 20, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0 };
  const dust: Position = { symbol: 'SOL', size: 0.01, entryPx: 150, liqPx: null, marginUsd: 1, unrealizedPnlUsd: 0, leverage: 1, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0 };
  const account: AccountState = { venue: 'phoenix', address: 'x', time: 0, equityUsd: 510, freeMarginUsd: 0, maintenanceMarginUsd: 500, positions: [eth, dust] };
  const r = legRisk({ venue: 'phoenix', account, position: eth, markPx: null });
  near(r.marginRatio, 500 / 510, 1e-12);
  assert.equal(r.liqPx, null);
  assert.equal(r.distanceBasis, 'account');
  // (510 - 500) / (20000 + 1.5) of the account's notional.
  near(r.distanceToLiqPct, 10 / 20001.5 * 100, 1e-9);
  // No mark at all: unknown, not "no liquidation price".
  const blind = legRisk({ venue: 'phoenix', account, position: { ...eth, entryPx: 0 }, markPx: null });
  assert.equal(blind.distanceToLiqPct, null);
  assert.equal(blind.distanceBasis, 'unknown');
  // A lone over-collateralised long: price alone cannot liquidate it, and that is known.
  const p: Position = { symbol: 'ETH', size: 1, entryPx: 2000, liqPx: null, marginUsd: 40, unrealizedPnlUsd: 0, leverage: 50, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0 };
  const safe = legRisk({ venue: 'hyperliquid', account: { venue: 'hyperliquid', address: '', time: 1, equityUsd: 2500, freeMarginUsd: 0, maintenanceMarginUsd: 40, positions: [p] }, position: p, markPx: 2000 });
  assert.equal(safe.distanceBasis, 'none');
});
