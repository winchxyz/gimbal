// serve's start lines name the rescue routes exactly: live on mainnet, refused when the Solana RPC has no history,
// replay only, and not built; and the one wired route still kept off mainnet.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAINNET_ROUTES, mainnetRouteLimit, routeLines } from './serve-rescue.ts';

test('mainnet with GIMBAL_RESCUE=1: the three live routes, then replay only and not built', () => {
  const lines = routeLines('mainnet', true, null);
  assert.deepEqual(lines, [
    'rescue routes LIVE on mainnet: reserve -> Hyperliquid (fund_venue); reserve -> Phoenix (fund_venue to the desk Solana authority, then a sol_sign deposit); Phoenix -> Hyperliquid (sol_sign_rescue)',
    `rescue routes in replay only: ${MAINNET_ROUTES.replayOnly.join('; ')}`,
    'rescue routes not built: Hyperliquid -> Orderly (Arbitrum USDC into Arbitrum USDC, which 1Click does not quote)',
  ]);
  assert.match(lines[1]!, /Hyperliquid -> Phoenix .*not yet dry-run on mainnet/);
  assert.match(lines[1]!, /reserve -> Orderly and Phoenix -> Orderly/);
});

test('a Solana RPC without history: both Phoenix routes refused, with the reason on its own line', () => {
  const lines = routeLines('mainnet', true, 'the public Solana mainnet RPC cannot back the Solana hold rule: no history');
  assert.equal(lines[0], 'rescue routes LIVE on mainnet: reserve -> Hyperliquid (fund_venue)');
  assert.equal(lines[1], 'rescue routes REFUSED on mainnet: reserve -> Phoenix and Phoenix -> Hyperliquid, because the public Solana mainnet RPC cannot back the Solana hold rule: no history');
});

test('detect only, and the recorded worlds', () => {
  assert.match(routeLines('mainnet', false, null)[0]!, /^rescue routes: none live \(detect only\); with GIMBAL_RESCUE=1: reserve -> Hyperliquid/);
  assert.match(routeLines('replay', true, null)[0]!, /^rescue routes \(replay\): every recorded route, payments simulated/);
  assert.equal(mainnetRouteLimit('hyperliquid', 'phoenix'), 'Hyperliquid -> Phoenix runs only in replay: it is not yet dry-run on mainnet');
  assert.equal(mainnetRouteLimit('phoenix', 'hyperliquid'), null);
  assert.equal(mainnetRouteLimit('reserve', 'phoenix'), null);
});
