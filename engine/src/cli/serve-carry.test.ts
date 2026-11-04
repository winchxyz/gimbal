// serve's carry open (liveCarry) end to end on the real Hyperliquid and Phoenix legs (buildLiveLegs) and a real
// PairTrader, with fake transports: the venues' HTTP answers, the Solana RPC and the contract's stored price. On a
// stored price that is missing, the open plans read-only (planning on, the legs pricing on the books' mid), judges
// every refusal, then sends one refresh_prices, holds the size to the cap and sends its first part, with no second
// refresh. A refused open pays for none; one refused after the refresh says it paid.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NearContractClient } from '../contract/near-client.ts';
import type { DeskView } from '../contract/types.ts';
import { solanaChain } from '../relayer/phoenix-money.ts';
import { PHOENIX_MAINNET } from '../relayer/phoenix-tx.ts';
import type { SolanaSubmitter } from '../relayer/solana.ts';
import { PairTrader } from '../trade/pair.ts';
import type { ProtectedPair } from '../trade/protected-pair.ts';
import type { HyperliquidReader } from '../venues/hyperliquid.ts';
import type { PhoenixReader } from '../venues/phoenix.ts';
import type { PriceDeps } from './pair-mainnet-lib.ts';
import { PRICE_MARGIN_S, newPriceState } from './pair-mainnet-lib.ts';
import { storedPrice } from './pair-ops.ts';
import type { CarryResult, RefreshAllowance, ServePairInput } from './serve-pair.ts';
import { SERVE_MAKER, buildLiveLegs, liveCarry } from './serve-pair.ts';

const HL_URL = 'https://hl.carry.test';
const PHOENIX_URL = 'https://phoenix.carry.test';
const SOL_RPC = 'https://solana.carry.test';
const ETH_MARKET = { symbol: 'ETH', orderbook: '9u7aqptdRFbsnnoHtjK13E5JkeM14EW5fAKTRPidVF88', base_lot_e8: 100_000, tick_e8: 10_000_000 };
const ACCOUNT = PHOENIX_MAINNET.globalVault;

function desk(closing = false): DeskView {
  return {
    owner: 'owner.near', operator: null, paused: false, closing, evm_address: `0x${'ab'.repeat(20)}`, orderly_receiver: null,
    solana: { authority: ACCOUNT, usdc_ata: ACCOUNT, phusd_ata: ACCOUNT, phoenix_trader: ACCOUNT },
    ledger: { deposited: 0, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 0 },
    policy: {
      hl_assets: [{ index: 1, symbol: 'ETH', sz_decimals: 4 }], phoenix_markets: [ETH_MARKET], orderly_symbols: [],
      max_notional_usd: 100, price_band_bps: 100, oracle_max_age_s: 900, rescue_cap_usd_per_hour: 50,
      unpriced: [], unpriced_max_notional_usd: 0, max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 2_000_000,
    },
  } as unknown as DeskView;
}

/** Every HTTP answer the open reads: Hyperliquid /info, Phoenix's snapshot and trader state, the Solana RPC. */
const venues = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith(HL_URL)) {
    const body = JSON.parse(String(init?.body)) as { type: string };
    if (body.type === 'clearinghouseState') return json({ crossMarginSummary: { accountValue: '100' }, crossMaintenanceMarginUsed: '0', assetPositions: [] });
    if (body.type === 'activeAssetData') return json({ leverage: { type: 'cross', value: 5 } });
    if (body.type === 'openOrders') return json([]);
  }
  if (url.startsWith(`${PHOENIX_URL}/v1/exchange/snapshot`)) {
    return json({
      exchange: { ...PHOENIX_MAINNET, programId: PHOENIX_MAINNET.phoenixProgram, globalConfig: PHOENIX_MAINNET.globalConfiguration, active: true },
      markets: [{
        symbol: 'ETH', marketPubkey: ETH_MARKET.orderbook, baseLotsDecimals: 3, tickSize: 100, marketStatus: 'active',
        takerFee: 0.0002, leverageTiers: [{ maxLeverage: 10, maxSizeBaseLots: '1000000' }], riskFactors: { maintenance: 50 },
      }],
    });
  }
  if (url.startsWith(`${PHOENIX_URL}/v1/trader/state/`)) return json({ slot: 1, snapshot: { capabilities: { state: 'active' }, subaccounts: [] } });
  if (url.startsWith(SOL_RPC)) {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    if (method === 'getBalance') return json({ jsonrpc: '2.0', id: 1, result: { value: 1_000_000_000 } });
    if (method === 'getLatestBlockhash') return json({ jsonrpc: '2.0', id: 1, result: { value: { blockhash: ACCOUNT, lastValidBlockHeight: 100 } } });
    if (method === 'simulateTransaction') return json({ jsonrpc: '2.0', id: 1, result: { value: { err: null, unitsConsumed: 200_000, logs: [] } } });
  }
  return new Response('{"error":"not here"}', { status: 404 });
}) as typeof fetch;

async function withVenues<T>(run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = venues;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

/**
 * The carry of an ETH pair as serve builds it, the contract storing no ETH price (or `row`). refresh_prices stores
 * `refreshedPx` (default 2500, the books' mid) at `refreshedAgeS` old (the oracle's 600 s recency plus its lag). `timeline` says, in order, when planning went on and
 * off, each refresh_prices (and whether it came while planning), the size check's line and each part sent. `agedBeforePartS`
 * ages the price and the last refresh that long before the part's own check (beforePart), as a long earlier part would.
 */
async function carryWorld(o: { closing?: boolean; refreshedAgeS?: number; refreshedPx?: number; row?: { ageS: number; px: number }; agedBeforePartS?: number } = {}) {
  const rows: { asset: string; price_e8: string; at_ms: number }[] = [];
  if (o.row !== undefined) rows.push({ asset: 'ETH', price_e8: String(Math.round(o.row.px * 1e8)), at_ms: Date.now() - o.row.ageS * 1000 });
  const timeline: string[] = [];
  let planning = false;
  const client = {
    config: async () => ({ fees: {} }), getDesk: async () => desk(o.closing), prices: async () => rows.map((r) => ({ ...r })),
  } as unknown as NearContractClient;
  const prices: PriceDeps = {
    maxAgeS: 900, send: true, read: (s) => storedPrice(client, s),
    refresh: async (s) => {
      timeline.push(`refresh ${s}${planning ? ' while planning' : ''}`);
      rows.splice(0, rows.length, { asset: s, price_e8: String(Math.round((o.refreshedPx ?? 2500) * 1e8)), at_ms: Date.now() - (o.refreshedAgeS ?? 610) * 1000 });
      return [{ chain: 'near', id: 'R', url: 'https://nearblocks.io/txns/R' }];
    },
    now: () => Date.now(), log: () => {}, ...newPriceState(),
  };
  const book = async () => ({ bids: [{ px: 2499, sz: 10 }], asks: [{ px: 2501, sz: 10 }] });
  const hl = {
    book, funding: async () => [{ symbol: 'ETH', ratePerHour: 0.0002 }], marketFundingHistory: async () => [], markets: async () => [{ symbol: 'ETH', maxLeverage: 25 }],
  } as unknown as HyperliquidReader;
  const phoenix = {
    book, funding: async () => [{ symbol: 'ETH', ratePerHour: 0 }], marketFundingHistory: async () => [],
    account: async () => ({ cross: { equityUsd: 100, maintenanceMarginUsd: 0 }, positions: [] }),
  } as unknown as PhoenixReader;
  const solana = { landedSlot: () => null, waitPastLastValidHeightSlot: async () => null } as unknown as SolanaSubmitter;
  const legs = await withVenues(() => buildLiveLegs({
    client, desk: desk(o.closing), symbol: 'ETH', hlUrl: HL_URL, hl, phoenix, phoenixUrl: PHOENIX_URL, chain: solanaChain(SOL_RPC, venues), solana,
    relayer: null, prices, trading: () => !planning, maker: SERVE_MAKER, slippageBps: 50, microLamports: 1, phoenixFetch: venues, phoenixBudget: null,
  }));
  assert.deepEqual(legs.mismatches, []);
  const trader = new PairTrader({ legs: [legs.hl, legs.phoenix], priceBandBps: 100 });
  const pair = {
    openInChunks: async (r: { beforePart?: (part: number, parts: number) => Promise<void> }) => {
      await trader.openChunk(1);                         // as the trader does: the legs price the part, trading
      if (o.agedBeforePartS !== undefined) {            // a long earlier part: the price and the last refresh grow old
        for (const row of rows) row.at_ms -= o.agedBeforePartS * 1000;
        const last = prices.lastRefreshAt.get('ETH');
        if (last !== undefined) prices.lastRefreshAt.set('ETH', last - o.agedBeforePartS * 1000);
      }
      await r.beforePart?.(0, 1);
      timeline.push('part 1 sent');
      return [];
    },
    close: async () => {
      throw new Error('no close here');
    },
    hedge: async () => {
      throw new Error('no hedge here');
    },
  } as unknown as ProtectedPair;
  const carry = liveCarry({
    symbol: 'ETH', legs, trader, pair, client, relayer: null, prices,
    planning: (on) => {
      planning = on;
      timeline.push(`planning ${on ? 'on' : 'off'}`);
    },
    input: { deskId: 'desk-1' } as ServePairInput, hlUrl: HL_URL, phoenixUrl: PHOENIX_URL, solRpcUrl: SOL_RPC,
    readers: () => ({ hl, phoenix, solana }),
  });
  const said: string[] = [];
  let paid = 0;
  const open = (allow: RefreshAllowance = {}): Promise<CarryResult> => withVenues(() => carry.open({
    legUsd: 50, leverage: 2, reason: 'strategy: enter eth-phoenix-hyperliquid', qty: '0.02', gate: () => null, ...allow,
    onPaidRefresh: () => {
      paid++;
    },
  }, {
    say: (l) => {
      said.push(l);
      if (l.startsWith('size      0.02 ETH a leg at')) timeline.push('size held to the cap');
    },
    open: (l) => said.push(`open: ${l}`),
  }));
  return { open, timeline, said, paid: () => paid };
}

test('serve\'s carry, no stored price: planning (read-only) -> one refresh_prices -> the size held to the cap -> the first part, no second refresh', async () => {
  const w = await carryWorld();
  const r = await w.open();
  assert.deepEqual(r.refusals, []);
  assert.equal(r.refreshed, true);
  assert.equal(w.paid(), 1);
  assert.deepEqual(w.timeline, ['planning on', 'planning off', 'refresh ETH', 'size held to the cap', 'part 1 sent']);
  const said = w.said.join('\n');
  assert.match(said, /stored ETH none \(planned on the books' mid 2500\.0000\); the open refreshes it once every check above passed/);
  assert.match(said, new RegExp(`stored ETH 2500, 610 s old \\(refreshed for this open\\): it lives 50 s past the first part's ${SERVE_MAKER.timeoutMs / 1000 + PRICE_MARGIN_S} s`));
  assert.match(said, /ioc sim   Phoenix BUY 0\.02 ETH .*: ok/);
});

test('serve\'s carry, a part whose price grew old: the refresh before it is counted for the caps (onPaidRefresh each time)', async () => {
  const w = await carryWorld({ agedBeforePartS: 100 });
  const r = await w.open();
  assert.deepEqual(r.refusals, []);
  assert.equal(r.refreshed, true);
  assert.equal(w.paid(), 2, 'the open\'s own refresh and the one before the part');
  assert.deepEqual(w.timeline, ['planning on', 'planning off', 'refresh ETH', 'size held to the cap', 'refresh ETH', 'part 1 sent']);
});

test('serve\'s carry on a closing desk (panic_close): refused in the plan, read-only, no refresh_prices', async () => {
  const w = await carryWorld({ closing: true });
  const r = await w.open();
  assert.ok(r.refusals.includes('the desk is closing (panic_close)'), r.refusals.join('; '));
  assert.equal(r.refreshed, undefined);
  assert.equal(w.paid(), 0);
  assert.deepEqual(w.timeline, ['planning on', 'planning off']);
});

test('serve\'s carry past the loop\'s daily cap: refused before any refresh_prices, with the cap\'s reason', async () => {
  const w = await carryWorld();
  const r = await w.open({ noRefresh: 'the strategy loop\'s 12 refresh_prices of ETH for 2026-11-04 (UTC) are used' });
  assert.deepEqual(r.refusals, ['the stored ETH price is missing and needs refresh_prices: the strategy loop\'s 12 refresh_prices of ETH for 2026-11-04 (UTC) are used; nothing sent']);
  assert.equal(w.paid(), 0);
  assert.deepEqual(w.timeline, ['planning on', 'planning off']);
});

test('serve\'s carry refused after its refresh_prices (the price lives too little past the first part): paid, nothing sent', async () => {
  const w = await carryWorld({ refreshedAgeS: 650 });
  const r = await w.open();
  assert.equal(r.refreshed, true);
  assert.equal(w.paid(), 1);
  assert.match(r.refusals.join('; '), /^the stored ETH price is 650 s old after refresh_prices: it lives 10 s past the first part's 240 s/);
  assert.deepEqual(w.timeline, ['planning on', 'planning off', 'refresh ETH']);
});

test('serve\'s carry, a days-old stored 2490 refreshed to 2520 (120 bps, over the band): planned again on 2520, then sent', async () => {
  const w = await carryWorld({ row: { ageS: 3 * 86_400, px: 2490 }, refreshedPx: 2520 });
  const r = await w.open();
  assert.deepEqual(r.refusals, []);
  assert.equal(w.paid(), 1);
  assert.deepEqual(w.timeline, ['planning on', 'planning off', 'refresh ETH', 'planning on', 'planning off', 'size held to the cap', 'part 1 sent']);
  const said = w.said.join('\n');
  assert.match(said, /stored ETH 2490, 259200 s old; the open refreshes it/);
  assert.match(said, /replan    the stored ETH price after refresh_prices is 2520, 120 bps from the 2490 the open was judged on \(over the 100 bps band\): planned again on it/);
  assert.match(said, /price     stored ETH 2520, 610 s old; --send refreshes it before each part/, 'the second plan reads the refreshed price, fresh');
});

test('serve\'s carry, no stored price, refreshed to 2560 (240 bps from the mid 2500): planned again, the books are outside the band, refused as paid', async () => {
  const w = await carryWorld({ refreshedPx: 2560 });
  const r = await w.open();
  assert.equal(r.refreshed, true);
  assert.equal(w.paid(), 1);
  assert.match(r.refusals.join('; '), /^the stored ETH price after refresh_prices is 2560, 240 bps from the 2500 the open was judged on \(over the 100 bps band\), and planned again the open refuses: no pair fits the policy cap: hyperliquid ETH: the best bid 2499 is outside the contract's band/);
  assert.deepEqual(w.timeline, ['planning on', 'planning off', 'refresh ETH', 'planning on', 'planning off'], 'nothing sent');
});

test('serve\'s carry, a days-old stored 1800 (over the band from the books): judged on the mid, refreshed to 2500, sent without planning again', async () => {
  const w = await carryWorld({ row: { ageS: 5 * 86_400, px: 1800 } });
  const r = await w.open();
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(w.timeline, ['planning on', 'planning off', 'refresh ETH', 'size held to the cap', 'part 1 sent']);
  assert.match(w.said.join('\n'), /stored ETH 1800, 432000 s old \(planned on the books' mid 2500\.0000, the stored one is over the band from the books\)/);
});
