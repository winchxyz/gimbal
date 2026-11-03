// serve's startup read of Phoenix's exchange snapshot (buildLiveLegs): it goes through the host's request budget as a
// critical read, so a 429 at restart is waited out and retried instead of failing serve's start.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NearContractClient } from '../contract/near-client.ts';
import type { DeskView } from '../contract/types.ts';
import type { SolanaChain } from '../relayer/phoenix-money.ts';
import type { SolanaSubmitter } from '../relayer/solana.ts';
import { PHOENIX_MAINNET } from '../relayer/phoenix-tx.ts';
import { HostBudget, PHOENIX_BUDGET } from '../venues/http-budget.ts';
import { buildLiveLegs } from './serve-pair.ts';
import type { PriceDeps } from './pair-mainnet-lib.ts';

const URL_BASE = 'https://perp-api.phoenix.test';
const SOL_MARKET = { symbol: 'SOL', orderbook: '71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2', base_lot_e8: 1_000_000, tick_e8: 1_000_000 };

const DESK_VIEW: DeskView = {
  owner: 'owner.near', operator: null, paused: false, evm_address: `0x${'ab'.repeat(20)}`, orderly_receiver: null,
  solana: { authority: PHOENIX_MAINNET.globalVault, usdc_ata: PHOENIX_MAINNET.globalVault, phusd_ata: PHOENIX_MAINNET.globalVault, phoenix_trader: PHOENIX_MAINNET.globalVault },
  ledger: { deposited: 0, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 0 },
  policy: {
    hl_assets: [{ index: 5, symbol: 'SOL', sz_decimals: 2 }],
    phoenix_markets: [SOL_MARKET],
    orderly_symbols: [],
    max_notional_usd: 100, price_band_bps: 100, oracle_max_age_s: 60, rescue_cap_usd_per_hour: 50,
    unpriced: [{ symbol: 'SOL', max_sz: '1' }], unpriced_max_notional_usd: 100,
    max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 2_000_000,
  },
};

test('serve startup: a 429 on the exchange snapshot is waited out and retried, and the legs are built', async () => {
  const asked: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    if (url.pathname !== '/v1/exchange/snapshot') return new Response('{"error":"not here"}', { status: 404 });
    if (asked.filter((p) => p === '/v1/exchange/snapshot').length === 1) {
      return new Response('{"error":"rate_limited"}', { status: 429, headers: { 'retry-after': '0.2' } });
    }
    return new Response(JSON.stringify({
      exchange: { ...PHOENIX_MAINNET, active: true },
      markets: [{ symbol: 'SOL', marketPubkey: SOL_MARKET.orderbook, tickSize: 100, baseLotsDecimals: 2 }],
    }), { status: 200 });
  }) as typeof fetch;
  const budget = new HostBudget('phoenix-test', { ...PHOENIX_BUDGET, random: () => 0 });
  const t0 = Date.now();
  const legs = await buildLiveLegs({
    client: {} as NearContractClient, desk: DESK_VIEW, symbol: 'SOL', hlUrl: 'https://hl.test',
    hl: { book: async () => { throw new Error('not used'); } }, phoenix: { book: async () => { throw new Error('not used'); } },
    phoenixUrl: URL_BASE, chain: {} as SolanaChain, solana: {} as SolanaSubmitter, relayer: null, prices: {} as PriceDeps,
    trading: () => false, maker: { repriceMs: 1_000, timeoutMs: 10_000, takerFallback: false }, slippageBps: 50, microLamports: 1,
    phoenixFetch: f, phoenixBudget: budget,
  });
  assert.deepEqual(asked, ['/v1/exchange/snapshot', '/v1/exchange/snapshot']);
  assert.ok(Date.now() - t0 >= 190, `built after ${Date.now() - t0} ms`);
  assert.equal(legs.phoenix.symbol, 'SOL');
  assert.equal(legs.priced, false);
  assert.ok(legs.mismatches.every((m) => !m.includes('lot') && !m.includes('tick')), legs.mismatches.join('\n'));
  assert.equal(budget.state().rateLimited, 1);
});
