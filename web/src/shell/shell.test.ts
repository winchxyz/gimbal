import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState, Leg } from '@gimbal/shared';
import { screenFromHash } from './routes.ts';
import { statusOf } from './status.ts';

const leg = (venue: Leg['venue'], side: Leg['side'], distanceToLiqPct: number | null): Leg => ({
  venue,
  symbol: 'DOGE',
  side,
  size: 1,
  entry: 1,
  mark: 1,
  liqPx: null,
  marginUsd: 1,
  marginRatio: 0.3,
  distanceToLiqPct,
  fundingEarnedUsd: 0,
  unsettledFundingUsd: 0,
  feesUsd: 0,
  lotSize: 1,
  unpriced: false,
});

const desk = (health: DeskState['health'], legs: Leg[]): DeskState => ({
  deskId: 'd1',
  owner: 'o.testnet',
  contract: 'c.testnet',
  mode: 'testnet',
  legs,
  netDelta: 0,
  equityUsd: 0,
  reserveUsd: 0,
  pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 },
  health,
  paused: null,
  rescueFailure: null,
  updatedAt: 0,
});

test('the status line follows desk health and names the nearest leg', () => {
  const legs = [leg('hyperliquid', 'short', 12.34), leg('phoenix', 'long', 31.9)];
  assert.deepEqual(statusOf(desk('level', legs)), { tone: 'level', word: 'Level', sentence: 'Both legs are safe.' });
  assert.deepEqual(statusOf(desk('watch', legs)), {
    tone: 'watch',
    word: 'Watch',
    sentence: 'The Hyperliquid short is 12.3% from liquidation.',
  });
  assert.equal(statusOf(desk('rescue', legs)).sentence, 'The desk is moving margin to the Hyperliquid short now.');
  assert.equal(statusOf(desk('watch', [leg('orderly', 'long', null)])).sentence, 'The Orderly long is close to liquidation.');
  assert.equal(statusOf(desk('level', [])).tone, 'waiting');
});

test('hash routes map to the five sections, Desk by default', () => {
  assert.equal(screenFromHash(''), 'desk');
  assert.equal(screenFromHash('#/windows'), 'windows');
  assert.equal(screenFromHash('#journal'), 'journal');
  assert.equal(screenFromHash('#/rescue/42'), 'rescue');
  assert.equal(screenFromHash('#/security?x=1'), 'security');
  assert.equal(screenFromHash('#/nope'), 'desk');
});
