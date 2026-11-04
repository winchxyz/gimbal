// The open's order-time size check (contract S2): the qty decide() sized is a maximum, held to max_notional at the
// highest price an order of the open may carry; it is only ever lowered, to whole common lots, the same on both legs.
// And the open's gate (review F2): a rescue that starts after the loop's gate stops the open before its next part.
// And the open's plan on a contract with no stored price: a real open refreshes it once before the refusals.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VenueId } from '@gimbal/shared';
import type { LegOutcome, LegSide, TradeLeg } from '../trade/legs.ts';
import { floorToLot, toQty } from '../trade/lots.ts';
import { PairTrader } from '../trade/pair.ts';
import type { PriceDeps } from './pair-mainnet-lib.ts';
import { PRICE_MARGIN_S, newPriceState, oraclePxOf } from './pair-mainnet-lib.ts';
import type { OpenPlan, OpsCtx, Pair } from './pair-ops.ts';
import { MIN_ORDER_USD, capQtyAtOrder, planOpen, sendOpen, storedPrice } from './pair-ops.ts';

const LOT = toQty('0.01');

test('a 2.1 % rise after decide() sized 0.2 at 100 under a 20 USD cap: cut to 0.19, whole lots, under the cap', () => {
  const r = capQtyAtOrder({ qty: toQty('0.2'), lot: LOT, worstPx: 100 * 1.021, midPx: 101, capUsd: 20 });
  assert.ok('qty' in r);
  assert.equal(r.qty, toQty('0.19'));
  assert.equal(r.cut, true);
  assert.ok(0.19 * 102.1 <= 20);
  assert.equal(r.qty % LOT, 0n, 'whole common lots');
});

test('a size that still fits is sent as sized, never raised', () => {
  const r = capQtyAtOrder({ qty: toQty('0.12'), lot: LOT, worstPx: 102.1, midPx: 101, capUsd: 20 });
  assert.deepEqual(r, { qty: toQty('0.12'), cut: false });
});

test('under one lot, or under the minimum order at the mid, after the cut: nothing is sent', () => {
  const lot = toQty('1');
  const one = capQtyAtOrder({ qty: toQty('1'), lot, worstPx: 20 * 1.021, midPx: 20.2, capUsd: 20 });
  assert.ok('refused' in one);
  assert.match(one.refused, /under one common lot 1 fits the cap.*nothing sent/);

  const small = capQtyAtOrder({ qty: toQty('0.1'), lot: LOT, worstPx: 100 * 1.021, midPx: 101, capUsd: 10 });
  assert.ok('refused' in small);
  assert.match(small.refused, new RegExp(`0\\.09 is 9\\.09 USD, under the ${MIN_ORDER_USD} USD minimum order`));
});

test('no price: refused, nothing sent', () => {
  assert.ok('refused' in capQtyAtOrder({ qty: toQty('0.1'), lot: LOT, worstPx: 0, midPx: 0, capUsd: 20 }));
  assert.ok('refused' in capQtyAtOrder({ qty: toQty('0.1'), lot: LOT, worstPx: Number.NaN, midPx: 100, capUsd: 20 }));
});

class GateLeg implements TradeLeg {
  readonly venue: VenueId;
  readonly symbol = 'XLM';
  readonly lot = toQty('1');
  readonly replayable = false;
  pos = 0n;
  orders: { side: LegSide; size: bigint }[] = [];
  onOrder: () => void = () => {};
  constructor(venue: VenueId) {
    this.venue = venue;
  }
  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return toQty('6');                  // a part is at most 5 lots after the band: an open of 10 is two parts
  }
  async position(): Promise<bigint> {
    return this.pos;
  }
  async order(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    this.orders.push({ side, size });
    this.onOrder();
    this.pos += side === 'BUY' ? size : -size;
    return { kind: 'filled', filled: size, avgPx: 1, ref: { venue: this.venue, side, size: String(size), reduceOnly, orderId: `o${this.orders.length}`, clientId: null, tx: [], sentAt: 1 } };
  }
  makerOrder(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    return this.order(side, size, reduceOnly);
  }
  pendingMakerOrders(): readonly [] {
    return [];
  }
}

function gateWorld() {
  const hl = new GateLeg('hyperliquid');
  const px = new GateLeg('phoenix');
  const trader = new PairTrader({ legs: [hl, px], priceBandBps: 100 });
  const said: string[] = [];
  const ctx = { config: {}, say: (l = '') => said.push(l), open: (l: string) => said.push(`open: ${l}`), trading: false } as unknown as OpsCtx;
  const pair = {
    symbol: 'XLM', hl, phoenix: px, trader, priced: false, targetNet: null, maker: { timeoutMs: 60_000 },
    run: { openInChunks: (r: Parameters<PairTrader['openInChunks']>[0]) => trader.openInChunks(r), close: () => Promise.reject(new Error('no close')), hedge: () => Promise.reject(new Error('no hedge')), stopOnFinish: false },
  } as unknown as Pair;
  const plan = { request: { symbol: 'XLM' }, refusals: [], size: toQty('10'), carry: {} } as unknown as OpenPlan;
  return { hl, px, ctx, pair, plan, said };
}

test('F2: a rescue that starts during part 1 stops the open before part 2; part 1 stays a whole hedged pair', async () => {
  const g = gateWorld();
  let rescue: string | null = null;
  g.hl.onOrder = () => {
    rescue = 'rescue r-9 runs';
  };
  const results = await sendOpen(g.ctx, g.pair, g.plan, 'strategy: enter', { gate: () => rescue });
  assert.deepEqual(results.map((r) => r.status), ['open', 'stuck']);
  assert.match(results[1]!.notes.join('; '), /part 2 of 2 not sent: rescue r-9 runs/);
  assert.equal(g.hl.orders.length, 1);
  assert.equal(g.px.orders.length, 1);
  assert.equal(g.hl.pos + g.px.pos, 0n, 'part 1 hedged');
  assert.equal(results[1]!.legs.every((l) => l.orders.length === 0), true, 'nothing of part 2 sent');
});

test('F2: a rescue already running when the open reaches its first order: nothing is sent', async () => {
  const g = gateWorld();
  const results = await sendOpen(g.ctx, g.pair, g.plan, 'strategy: enter', { gate: () => 'rescue r-9 runs' });
  assert.deepEqual(results.map((r) => r.status), ['stuck'], 'the trader refuses the part before it is sent: stuck, nothing sent');
  assert.match(results[0]!.notes.join('; '), /part 1 of 2 not sent: rescue r-9 runs/);
  assert.equal(g.hl.orders.length + g.px.orders.length, 0);
  // Without a gate (pair-mainnet) the same open sends both parts.
  const h = gateWorld();
  const all = await sendOpen(h.ctx, h.pair, h.plan, 'pair-mainnet: open');
  assert.deepEqual(all.map((r) => r.status), ['open', 'open']);
});

// ---- the open's plan on a contract with no stored price (refresh_prices never called) ----

/**
 * planOpen on fakes that pass every refusal but the price: the contract's prices() answers what is stored (`row`, or
 * nothing), and refresh_prices writes a row 610 s old (the oracle's 600 s recency) unless `refreshFails`. The legs
 * read the stored price as buildPair's do (oraclePxOf while planning: the price as it is), so the cap and band checks
 * see what is stored when they run.
 */
function planWorld(o: { send: boolean; row?: { ageS: number; px: number }; refreshFails?: string }) {
  const sym = 'ETH';
  const policy = {
    max_notional_usd: 100, price_band_bps: 100, oracle_max_age_s: 900, unpriced: [], unpriced_max_notional_usd: 0,
    hl_assets: [{ symbol: sym, index: 1, sz_decimals: 4 }], phoenix_markets: [{ symbol: sym }],
  };
  const rows: { asset: string; price_e8: string; at_ms: number }[] = [];
  if (o.row !== undefined) rows.push({ asset: sym, price_e8: String(Math.round(o.row.px * 1e8)), at_ms: Date.now() - o.row.ageS * 1000 });
  const client = { prices: async () => rows.map((r) => ({ ...r })) } as unknown as OpsCtx['client'];
  const refreshes: string[] = [];
  const logs: string[] = [];
  const prices: PriceDeps = {
    maxAgeS: policy.oracle_max_age_s, send: o.send, read: (s) => storedPrice(client, s),
    refresh: async (s, maxAgeS) => {
      refreshes.push(`${s} ${maxAgeS}`);
      if (o.refreshFails !== undefined) throw new Error(o.refreshFails);
      rows.splice(0, rows.length, { asset: s, price_e8: String(2500 * 1e8), at_ms: Date.now() - 610_000 });
      return [{ chain: 'near', id: 'R', url: 'https://nearblocks.io/txns/R' }];
    },
    now: () => Date.now(), log: (l) => logs.push(l), ...newPriceState(),
  };
  const said: string[] = [];
  const book = async () => ({ bids: [{ px: 2499 }], asks: [{ px: 2501 }] });
  const ctx = {
    client, config: { fees: {} }, desk: { policy, paused: false, closing: false, evm_address: '0xDESK' },
    hlUrl: 'http://hl.plan.test', phoenixUrl: 'http://phoenix.plan.test',
    hl: {
      funding: async () => [{ symbol: sym, ratePerHour: 0.0002 }], marketFundingHistory: async () => [],
      markets: async () => [{ symbol: sym, maxLeverage: 25 }], book,
    },
    phoenix: {
      funding: async () => [{ symbol: sym, ratePerHour: 0 }], marketFundingHistory: async () => [], book,
      account: async () => ({ cross: { equityUsd: 100, maintenanceMarginUsd: 0 }, positions: [] }),
    },
    chain: { balance: async () => 1_000_000_000, simulate: async () => ({ err: null, unitsConsumed: 200_000, logs: [] }) },
    sol: { authority: 'AUTH' }, relayer: null, prices, send: o.send, trading: false,
    say: (l = '') => said.push(l), open: (l: string) => said.push(`open: ${l}`),
  } as unknown as OpsCtx;
  // What the legs priced with: openChunk's cap and band, and the Phoenix IOC's limit.
  const seen: number[] = [];
  const oraclePx = oraclePxOf(prices, sym, () => ctx.send && ctx.trading);
  const lot = toQty('0.001');
  const pair = {
    symbol: sym, lot, bandBps: policy.price_band_bps, priced: true, mismatches: [], microLamports: 1, targetNet: null,
    maker: { timeoutMs: 60_000, repriceMs: 30_000, maxOrders: 6, takerFallback: false },
    marketConfig: { takerFee: 0.0002, leverageTiers: [{ maxLeverage: 10, maxSizeBaseLots: '1000000' }], riskFactors: { maintenance: 50 } },
    trader: {
      openChunk: async () => {
        const px = await oraclePx();
        seen.push(px);
        return floorToLot(toQty((policy.max_notional_usd / (px * 1.01)).toFixed(8)), lot);
      },
    },
    phoenix: {
      lot,
      plan: async () => {
        const px = await oraclePx();
        seen.push(px);
        return { px: px * 1.01, ticks: 1, lots: 20 };
      },
      message: async () => ({ message: new Uint8Array(0) }),
    },
  } as unknown as Pair;
  return { ctx, pair, refreshes, logs, said, seen, request: { symbol: sym, legUsd: 50, leverage: 2, holdDays: 7, basisBps: 10 } };
}

/** The Hyperliquid /info and Phoenix trader-state answers of a desk that may open (cross margin, no resting orders). */
async function withVenues<T>(run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith('http://phoenix.plan.test')) return json({ slot: 1, snapshot: { capabilities: { state: 'active' }, subaccounts: [] } });
    const body = JSON.parse(String(init?.body)) as { type: string };
    if (body.type === 'clearinghouseState') return json({ crossMarginSummary: { accountValue: '100' }, crossMaintenanceMarginUsed: '0', assetPositions: [] });
    if (body.type === 'activeAssetData') return json({ leverage: { type: 'cross', value: 5 } });
    if (body.type === 'openOrders') return json([]);
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test('no stored price, a real open: one refresh_prices before the refusals, then the plan passes on the refreshed price', async () => {
  const w = planWorld({ send: true });
  const plan = await withVenues(() => planOpen(w.ctx, w.pair, w.request));
  assert.deepEqual(plan.refusals, []);
  // The first part's margin (the maker timeout plus the IOC's 120 s): sendOpen's beforePart then finds it fresh.
  assert.deepEqual(w.refreshes, [`ETH ${900 - (60 + PRICE_MARGIN_S)}`]);
  assert.deepEqual(w.seen, [2500, 2500], 'the cap (openChunk) and the IOC band priced with the refreshed price');
  assert.equal(plan.size, toQty('0.02'));
  assert.match(w.said.join('\n'), /stored ETH 2500, 610 s old \(refreshed for this open\)/);
  assert.match(w.logs.join('\n'), /the stored ETH price is missing: refresh_prices/);
  // Planned again at once: the price is fresh now, nothing more is sent.
  await withVenues(() => planOpen(w.ctx, w.pair, w.request));
  assert.equal(w.refreshes.length, 1);
});

test('a stored price too old to plan with is refreshed once at a real open; a fresh one is not', async () => {
  const old = planWorld({ send: true, row: { ageS: 5 * 86_400, px: 1800 } });
  const plan = await withVenues(() => planOpen(old.ctx, old.pair, old.request));
  assert.deepEqual(plan.refusals, []);
  assert.equal(old.refreshes.length, 1);
  assert.deepEqual(old.seen, [2500, 2500], 'the cap and band are held to the refreshed price, not the 5-day-old one');

  const fresh = planWorld({ send: true, row: { ageS: 610, px: 2500 } });
  assert.deepEqual((await withVenues(() => planOpen(fresh.ctx, fresh.pair, fresh.request))).refusals, []);
  assert.deepEqual(fresh.refreshes, []);
});

test('no stored price, a dry run: read-only, the missing price is a refusal, nothing is refreshed', async () => {
  const w = planWorld({ send: false });
  const plan = await withVenues(() => planOpen(w.ctx, w.pair, w.request));
  assert.deepEqual(w.refreshes, []);
  assert.ok(plan.refusals.includes('the contract has no stored ETH price'), plan.refusals.join('; '));
  assert.match(w.said.join('\n'), /stored ETH none/);
});

test('no stored price, a real open whose refresh fails: a refusal with the reason, never a throw', async () => {
  const w = planWorld({ send: true, refreshFails: 'near rpc: HTTP 503' });
  const plan = await withVenues(() => planOpen(w.ctx, w.pair, w.request));
  assert.equal(w.refreshes.length, 1);
  assert.ok(plan.refusals.includes('the stored ETH price could not be refreshed before the open: near rpc: HTTP 503'), plan.refusals.join('; '));
  assert.equal(plan.refusals.includes('the contract has no stored ETH price'), false, 'one refusal for the price, with its reason');
  await assert.rejects(sendOpen(w.ctx, w.pair, plan), /open refused, nothing signed/);
});

test('a real open already refused for something else sends no refresh_prices', async () => {
  const w = planWorld({ send: true });
  (w.ctx.desk as { paused: boolean }).paused = true;
  const plan = await withVenues(() => planOpen(w.ctx, w.pair, w.request));
  assert.deepEqual(w.refreshes, []);
  assert.ok(plan.refusals.includes('the desk is paused: no open is signed'));
  assert.ok(plan.refusals.includes('the contract has no stored ETH price'));
});
