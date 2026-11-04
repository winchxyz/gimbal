// The open's order-time size check (contract S2): the qty decide() sized is a maximum, held to max_notional at the
// highest price an order of the open may carry; it is only ever lowered, to whole common lots, the same on both legs.
// And the open's gate (review F2): a rescue that starts after the loop's gate stops the open before its next part.
// And the open's plan on a stored price that is missing or too old: every refusal is judged first (planOpen is
// read-only), and a real open then refreshes it once (refreshForOpen), enough for the first part at SERVE_MAKER.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VenueId } from '@gimbal/shared';
import type { LegOutcome, LegSide, MakerSettings, TradeLeg } from '../trade/legs.ts';
import { floorToLot, toQty } from '../trade/lots.ts';
import { PairTrader } from '../trade/pair.ts';
import type { PriceDeps } from './pair-mainnet-lib.ts';
import { OPEN_HEADROOM_S, PRICE_MARGIN_S, newPriceState, oraclePxOf, refreshLanded, refreshReachedChain } from './pair-mainnet-lib.ts';
import type { OpenPlan, OpenRefresh, OpenRequest, OpsCtx, Pair } from './pair-ops.ts';
import { MIN_ORDER_USD, capQtyAtOrder, planOpen, recheckOpenSize, refreshForOpen, sendOpen, storedPrice } from './pair-ops.ts';
import { SERVE_MAKER } from './serve-pair.ts';

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

// ---- the open's plan on a stored price that is missing or too old: judged first, refreshed once after ----

interface PlanWorldOptions {
  send: boolean;
  symbol?: string;
  row?: { ageS: number; px: number };
  refreshFails?: string;
  /** The age (s) refresh_prices leaves the price at: the oracle's 600 s recency plus its lag. Default 610. */
  refreshedAgeS?: number;
  /** The price refresh_prices stores. Default 2500, the books' mid. */
  refreshedPx?: number;
  maker?: MakerSettings;
  desk?: { paused?: boolean; closing?: boolean };
  lamports?: number;
  simErr?: unknown;
  /** activeAssetData's margin mode and the openOrders answer the venues give (withVenues). */
  marginMode?: string;
  resting?: unknown[];
}

/**
 * planOpen on fakes that pass every refusal but the ones `o` asks for: the contract's prices() answers what is stored
 * (`row`, or nothing), and refresh_prices writes a row `refreshedAgeS` old at `refreshedPx` unless `refreshFails`. The books
 * are 2499 / 2501 (mid 2500). The legs read the stored price as buildPair's do (oraclePxOf: while planning, as it is,
 * or the estimate where none is stored), so the cap and band checks see what is there when they run.
 */
function planWorld(o: PlanWorldOptions) {
  const sym = o.symbol ?? 'ETH';
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
      rows.splice(0, rows.length, { asset: s, price_e8: String(Math.round((o.refreshedPx ?? 2500) * 1e8)), at_ms: Date.now() - (o.refreshedAgeS ?? 610) * 1000 });
      return [{ chain: 'near', id: 'R', url: 'https://nearblocks.io/txns/R' }];
    },
    now: () => Date.now(), log: (l) => logs.push(l), landed: refreshLanded, reachedChain: refreshReachedChain, ...newPriceState(),
  };
  const said: string[] = [];
  const book = async () => ({ bids: [{ px: 2499 }], asks: [{ px: 2501 }] });
  const ctx = {
    client, config: { fees: {} }, desk: { policy, paused: o.desk?.paused ?? false, closing: o.desk?.closing ?? false, evm_address: '0xDESK' },
    hlUrl: 'http://hl.plan.test', phoenixUrl: 'http://phoenix.plan.test',
    hl: {
      funding: async () => [{ symbol: sym, ratePerHour: 0.0002 }], marketFundingHistory: async () => [],
      markets: async () => [{ symbol: sym, maxLeverage: 25 }], book,
    },
    phoenix: {
      funding: async () => [{ symbol: sym, ratePerHour: 0 }], marketFundingHistory: async () => [], book,
      account: async () => ({ cross: { equityUsd: 100, maintenanceMarginUsd: 0 }, positions: [] }),
    },
    chain: { balance: async () => o.lamports ?? 1_000_000_000, simulate: async () => ({ err: o.simErr ?? null, unitsConsumed: 200_000, logs: [] }) },
    sol: { authority: 'AUTH' }, relayer: null, prices, send: o.send, trading: false,
    say: (l = '') => said.push(l), open: (l: string) => said.push(`open: ${l}`),
  } as unknown as OpsCtx;
  // What the legs priced with: openChunk's cap and band, and the Phoenix IOC's limit.
  const seen: number[] = [];
  const oraclePx = oraclePxOf(prices, sym, () => ctx.send && ctx.trading);
  const lot = toQty('0.001');
  const pair = {
    symbol: sym, lot, bandBps: policy.price_band_bps, priced: true, mismatches: [], microLamports: 1, targetNet: null,
    maker: o.maker ?? { timeoutMs: 60_000, repriceMs: 30_000, maxOrders: 6, takerFallback: false },
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
  /** The stored row `s` seconds older: time passing. */
  const age = (s: number) => {
    for (const r of rows) r.at_ms -= s * 1000;
  };
  const request: OpenRequest = { symbol: sym, legUsd: 50, leverage: 2, holdDays: 7, basisBps: 10 };
  return { ctx, pair, refreshes, logs, said, seen, prices, age, request };
}

/** What refreshForOpen answered, without the plan it hands on. */
const three = (f: OpenRefresh) => ({ refused: f.refused, paid: f.paid, line: f.line });

/** The Hyperliquid /info and Phoenix trader-state answers of a desk that may open (cross margin, no resting orders). */
async function withVenues<T>(run: () => Promise<T>, o: Pick<PlanWorldOptions, 'marginMode' | 'resting'> = {}): Promise<T> {
  const real = globalThis.fetch;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith('http://phoenix.plan.test')) return json({ slot: 1, snapshot: { capabilities: { state: 'active' }, subaccounts: [] } });
    const body = JSON.parse(String(init?.body)) as { type: string };
    if (body.type === 'clearinghouseState') return json({ crossMarginSummary: { accountValue: '100' }, crossMaintenanceMarginUsed: '0', assetPositions: [] });
    if (body.type === 'activeAssetData') return json({ leverage: { type: o.marginMode ?? 'cross', value: 5 } });
    if (body.type === 'openOrders') return json(o.resting ?? []);
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test('no stored price, a real open: planned on the books\' mid with nothing sent, then one refresh_prices after the checks', async () => {
  const w = planWorld({ send: true });
  const plan = await withVenues(() => planOpen(w.ctx, w.pair, w.request));
  assert.deepEqual(plan.refusals, []);
  assert.deepEqual(w.refreshes, [], 'planOpen is read-only');
  assert.deepEqual(w.seen, [2500, 2500], 'the cap (openChunk) and the IOC band priced on the books\' mid');
  assert.equal(w.prices.estimate?.has('ETH') ?? false, false, 'the estimate is gone once planned');
  assert.deepEqual(plan.refresh, { marginS: 60 + PRICE_MARGIN_S, was: 'missing' });
  assert.match(w.said.join('\n'), /stored ETH none \(planned on the books' mid 2500\.0000\); the open refreshes it once every check above passed/);
  const fresh = await refreshForOpen(w.ctx, w.pair, plan);
  // The first part's margin (the maker timeout plus the IOC's 120 s): sendOpen's beforePart then finds it fresh.
  assert.deepEqual(w.refreshes, [`ETH ${900 - (60 + PRICE_MARGIN_S)}`]);
  assert.deepEqual(three(fresh), { refused: null, paid: true, line: 'price     stored ETH 2500, 610 s old (refreshed for this open): it lives 110 s past the first part\'s 180 s' });
  assert.match(w.logs.join('\n'), /the stored ETH price is missing: refresh_prices/);
  // Asked again at once: the price is fresh now, nothing more is sent.
  assert.deepEqual(three(await refreshForOpen(w.ctx, w.pair, plan)), { refused: null, paid: false, line: 'price     stored ETH 2500, 610 s old: it lives 110 s past the first part\'s 180 s' });
  assert.equal(w.refreshes.length, 1);
});

test('a stored price too old to plan with: planned on as it is within the band of the books, else on the mid; refreshed once after the checks', async () => {
  const far = planWorld({ send: true, row: { ageS: 5 * 86_400, px: 1800 } });
  const farPlan = await withVenues(() => planOpen(far.ctx, far.pair, far.request));
  assert.deepEqual(farPlan.refusals, []);
  assert.deepEqual(far.seen, [2500, 2500], 'a days-old 1800 is over the band from the books: judged on the mid');
  assert.equal(farPlan.pricedAt, 2500);
  assert.match(far.said.join('\n'), /stored ETH 1800, 432000 s old \(planned on the books' mid 2500\.0000, the stored one is over the band from the books\)/);

  const old = planWorld({ send: true, row: { ageS: 5 * 86_400, px: 2490 } });
  const plan = await withVenues(() => planOpen(old.ctx, old.pair, old.request));
  assert.deepEqual(plan.refusals, []);
  assert.deepEqual(old.refreshes, []);
  assert.deepEqual(old.seen, [2490, 2490], 'judged on the stored price as it is');
  assert.equal(plan.pricedAt, 2490);
  assert.equal(plan.refresh?.was, `${5 * 86_400} s old`);
  assert.equal((await refreshForOpen(old.ctx, old.pair, plan)).paid, true);
  assert.equal(old.refreshes.length, 1);

  const fresh = planWorld({ send: true, row: { ageS: 610, px: 2500 } });
  const freshPlan = await withVenues(() => planOpen(fresh.ctx, fresh.pair, fresh.request));
  assert.deepEqual(freshPlan.refusals, []);
  assert.equal(freshPlan.refresh, null);
  assert.deepEqual(three(await refreshForOpen(fresh.ctx, fresh.pair, freshPlan)), { refused: null, paid: false, line: null });
  assert.deepEqual(fresh.refreshes, []);
});

test('no stored price, a dry run: read-only, the missing price is a refusal, every other check still runs on the mid', async () => {
  const w = planWorld({ send: false });
  const plan = await withVenues(() => planOpen(w.ctx, w.pair, w.request));
  assert.deepEqual(plan.refusals, ['the contract has no stored ETH price']);
  assert.deepEqual(w.seen, [2500, 2500]);
  assert.equal(plan.refresh, null);
  assert.match(w.said.join('\n'), /stored ETH none/);
  assert.equal((await refreshForOpen(w.ctx, w.pair, plan)).paid, false);
  assert.deepEqual(w.refreshes, []);
  // Stale but stored: a dry run plans on it and says --send would refresh it; nothing is sent.
  const stale = planWorld({ send: false, row: { ageS: 800, px: 2500 } });
  const stalePlan = await withVenues(() => planOpen(stale.ctx, stale.pair, stale.request));
  assert.deepEqual(stalePlan.refusals, []);
  assert.match(stale.said.join('\n'), /--send refreshes it once its checks pass/);
  assert.deepEqual(three(await refreshForOpen(stale.ctx, stale.pair, stalePlan)), { refused: 'the stored ETH price is 800 s old: a dry run does not refresh it', paid: false, line: null });
  assert.deepEqual(stale.refreshes, []);
});

test('no stored price, a real open whose refresh fails: a refusal with the reason, never a throw; paid only when it landed', async () => {
  // The RPC failed before the chain: nothing went out, nothing paid (no 6 h hold, not counted for the caps).
  const w = planWorld({ send: true, refreshFails: 'near rpc: HTTP 503' });
  const plan = await withVenues(() => planOpen(w.ctx, w.pair, w.request));
  assert.deepEqual(plan.refusals, []);
  const fresh = await refreshForOpen(w.ctx, w.pair, plan);
  assert.equal(w.refreshes.length, 1);
  assert.deepEqual(three(fresh), { refused: 'the stored ETH price (missing) could not be refreshed before the open: near rpc: HTTP 503', paid: false, line: null });
  // It ran on chain, then reading the outcome failed: it landed, so it is paid.
  const ran = planWorld({ send: true, refreshFails: 'refresh_prices ran in T: prices() has no newer price' });
  const ranPlan = await withVenues(() => planOpen(ran.ctx, ran.pair, ran.request));
  const landed = await refreshForOpen(ran.ctx, ran.pair, ranPlan);
  assert.deepEqual(three(landed), { refused: 'the stored ETH price (missing) could not be refreshed before the open: refresh_prices ran in T: prices() has no newer price', paid: true, line: null });
  // The transaction failed on chain (its state reverted, no ask recorded): the gas is spent, so it is paid too.
  const failed = planWorld({ send: true, refreshFails: 'refresh_prices failed in transaction H6: Exceeded the prepaid gas.' });
  const failedPlan = await withVenues(() => planOpen(failed.ctx, failed.pair, failed.request));
  const onChain = await refreshForOpen(failed.ctx, failed.pair, failedPlan);
  assert.deepEqual(three(onChain), { refused: 'the stored ETH price (missing) could not be refreshed before the open: refresh_prices failed in transaction H6: Exceeded the prepaid gas.', paid: true, line: null });
  assert.equal(failed.prices.lastRefreshAt.has('ETH'), false, 'not landed: the next refresh is not held back 30 s');
});

test('a real open already refused for anything else sends no refresh_prices: paused, closing, margin, resting, SOL, minimum, cap, IOC', async () => {
  const cases: { name: string; o: Partial<PlanWorldOptions>; legUsd?: number; qty?: string; match: RegExp }[] = [
    { name: 'paused', o: { desk: { paused: true } }, match: /the desk is paused/ },
    { name: 'closing', o: { desk: { closing: true } }, match: /the desk is closing \(panic_close\)/ },
    { name: 'margin', o: { marginMode: 'isolated' }, match: /margin mode: only cross is planned/ },
    { name: 'resting', o: { resting: [{ coin: 'ETH', side: 'A', sz: '0.01', oid: 7 }] }, match: /resting ETH order/ },
    { name: 'SOL', o: { lamports: 1000 }, match: /the desk authority holds/ },
    { name: 'minimum', o: {}, qty: '0.002', match: /under Hyperliquid's 10 USD order minimum/ },
    { name: 'cap', o: {}, legUsd: 150, match: /is over .*, the policy's 100 USD cap/ },
    { name: 'IOC', o: { simErr: { InstructionError: [0, 'Custom'] } }, match: /the Phoenix IOC fails in simulation/ },
  ];
  for (const c of cases) {
    const w = planWorld({ send: true, ...c.o });
    const request = { ...w.request, ...(c.legUsd === undefined ? {} : { legUsd: c.legUsd }), ...(c.qty === undefined ? {} : { qty: c.qty }) };
    const plan = await withVenues(() => planOpen(w.ctx, w.pair, request), c.o);
    assert.ok(plan.refusals.some((r) => c.match.test(r)), `${c.name}: ${plan.refusals.join('; ')}`);
    assert.notEqual(plan.refresh, null, `${c.name}: the price would need a refresh`);
    const fresh = await refreshForOpen(w.ctx, w.pair, plan);
    assert.equal(fresh.paid, false, c.name);
    assert.match(fresh.refused ?? '', /^refused already, so the stored ETH price \(missing\) is not refreshed/, c.name);
    assert.deepEqual(w.refreshes, [], `${c.name}: nothing refreshed`);
    await assert.rejects(sendOpen(w.ctx, w.pair, plan), /open refused, nothing signed/);
  }
});

test('a symbol refresh_prices cannot price: a missing price keeps the old refusal, a stale one is refused, nothing refreshed', async () => {
  const missing = planWorld({ send: true, symbol: 'AVAX' });
  const plan = await withVenues(() => planOpen(missing.ctx, missing.pair, missing.request));
  assert.deepEqual(plan.refusals, ['the contract has no stored AVAX price']);
  assert.equal(plan.refresh, null);
  const stale = planWorld({ send: true, symbol: 'AVAX', row: { ageS: 2000, px: 20 } });
  const stalePlan = await withVenues(() => planOpen(stale.ctx, stale.pair, stale.request));
  assert.ok(stalePlan.refusals.includes('the stored AVAX price is 2000 s old and refresh_prices cannot refresh it (AVAX is not one of the contract\'s oracle assets)'), stalePlan.refusals.join('; '));
  assert.equal((await refreshForOpen(missing.ctx, missing.pair, plan)).paid, false);
  assert.equal((await refreshForOpen(stale.ctx, stale.pair, stalePlan)).paid, false);
  assert.deepEqual([...missing.refreshes, ...stale.refreshes], []);
});

test('SERVE_MAKER: one refresh lives through the size check and the first part, 20 s later, with no second refresh', async () => {
  const w = planWorld({ send: true, maker: SERVE_MAKER, refreshedAgeS: 610 });
  const plan = await withVenues(() => planOpen(w.ctx, w.pair, { ...w.request, qty: '0.02' }));
  assert.deepEqual(plan.refusals, []);
  assert.equal(SERVE_MAKER.timeoutMs / 1000 + PRICE_MARGIN_S, 240);
  const fresh = await refreshForOpen(w.ctx, w.pair, plan);
  assert.deepEqual([fresh.refused, fresh.paid], [null, true]);
  assert.match(fresh.line ?? '', /lives 50 s past the first part's 240 s/);
  w.age(10);                                         // the size held to the cap, the gate
  const held = await recheckOpenSize(w.ctx, w.pair, plan.size, 50);
  assert.ok(!('refused' in held), 'refused' in held ? held.refused : '');
  w.age(10);                                         // both legs read, the builder fee checked
  let beforeParts = 0;
  const pair = {
    ...w.pair, hl: { position: async () => 0n, pendingMakerOrders: () => [] }, phoenix: { ...(w.pair.phoenix as object), position: async () => 0n },
    trader: { unhedged: null, unsettled: () => null, legs: [] },
    run: {
      openInChunks: async (r: { beforePart?: (part: number, parts: number) => Promise<void> }) => {
        await r.beforePart?.(0, 1);
        beforeParts++;
        return [];
      },
      stopOnFinish: false,
    },
  } as unknown as Pair;
  await sendOpen(w.ctx, pair, plan);
  assert.equal(beforeParts, 1);
  assert.deepEqual(w.refreshes, [`ETH ${900 - 240}`], 'one refresh_prices for the whole open');
  assert.equal(w.logs.some((l) => l.includes('not sent again')), false, 'no second refresh was needed');
});

test('SERVE_MAKER: a refresh that leaves the price under the open\'s headroom is refused (paid), before anything is sent', async () => {
  const w = planWorld({ send: true, maker: SERVE_MAKER, refreshedAgeS: 650 });
  const plan = await withVenues(() => planOpen(w.ctx, w.pair, w.request));
  const fresh = await refreshForOpen(w.ctx, w.pair, plan);
  assert.equal(fresh.paid, true);
  assert.equal(fresh.refused, `the stored ETH price is 650 s old after refresh_prices: it lives 10 s past the first part's 240 s, under the ${OPEN_HEADROOM_S} s the open needs before it; nothing sent`);
});

test('a refresh that moves the price over the band from what the plan judged on: planned again on it; a refusal then is paid', async () => {
  // Planned on the mid 2500, refreshed to 2540 (160 bps): planned again, and the plan sent is the new one.
  const moved = planWorld({ send: true, refreshedPx: 2540 });
  const plan = await withVenues(() => planOpen(moved.ctx, moved.pair, moved.request));
  assert.deepEqual(plan.refusals, []);
  const fresh = await withVenues(() => refreshForOpen(moved.ctx, moved.pair, plan));
  assert.deepEqual([fresh.refused, fresh.paid], [null, true]);
  assert.notEqual(fresh.plan, plan);
  assert.equal(fresh.plan.pricedAt, 2540);
  assert.deepEqual(moved.seen, [2500, 2500, 2540, 2540], 'the cap and the IOC judged again on the refreshed price');
  assert.match(moved.said.join('\n'), /replan    the stored ETH price after refresh_prices is 2540, 160 bps from the 2500 the open was judged on \(over the 100 bps band\): planned again on it/);
  assert.equal(moved.refreshes.length, 1, 'planning again sends nothing');

  // Within the band: the plan stands as it is.
  const near = planWorld({ send: true, refreshedPx: 2520 });
  const nearPlan = await withVenues(() => planOpen(near.ctx, near.pair, near.request));
  const kept = await withVenues(() => refreshForOpen(near.ctx, near.pair, nearPlan));
  assert.equal(kept.plan, nearPlan);
  assert.deepEqual(near.seen, [2500, 2500]);

  // Planned again, the open refuses (a part now under the Hyperliquid minimum at the new price): refused, paid.
  const low = planWorld({ send: true, refreshedPx: 2540, simErr: undefined });
  const lowPlan = await withVenues(() => planOpen(low.ctx, low.pair, low.request));
  (low.ctx.chain as unknown as { balance: () => Promise<number> }).balance = async () => 1000;
  const refused = await withVenues(() => refreshForOpen(low.ctx, low.pair, lowPlan));
  assert.equal(refused.paid, true);
  assert.match(refused.refused ?? '', /^the stored ETH price after refresh_prices is 2540, 160 bps from the 2500 the open was judged on \(over the 100 bps band\), and planned again the open refuses: the desk authority holds/);
  await assert.rejects(sendOpen(low.ctx, low.pair, refused.plan), /open refused, nothing signed/);
});

test('planning again takes the price past the headroom: refused, paid, before anything else runs', async () => {
  // Refreshed to 610 s old at 2540 (160 bps off the 2500 judged on): 50 s past SERVE_MAKER's 240 s. Planning again
  // takes 40 s on this clock (the books and funding answer slowly), so the price is 650 s old when it is done.
  const w = planWorld({ send: true, maker: SERVE_MAKER, refreshedPx: 2540 });
  const plan = await withVenues(() => planOpen(w.ctx, w.pair, w.request));
  assert.deepEqual(plan.refusals, []);
  const hl = w.ctx.hl as unknown as { funding: () => Promise<unknown> };
  const funding = hl.funding;
  hl.funding = async () => {
    if (w.refreshes.length > 0) w.age(40);
    return funding();
  };
  const fresh = await withVenues(() => refreshForOpen(w.ctx, w.pair, plan));
  assert.equal(fresh.paid, true);
  assert.equal(fresh.refused, `the stored ETH price after refresh_prices is 2540, 160 bps from the 2500 the open was judged on (over the 100 bps band); planned again, the stored ETH price is 650 s old: it lives 10 s past the first part's 240 s, under the ${OPEN_HEADROOM_S} s the open needs before it; nothing sent`);
  assert.equal(w.refreshes.length, 1, 'no second refresh_prices');
  // On an instant clock the same replan passes.
  const quick = planWorld({ send: true, maker: SERVE_MAKER, refreshedPx: 2540 });
  const quickPlan = await withVenues(() => planOpen(quick.ctx, quick.pair, quick.request));
  const ok = await withVenues(() => refreshForOpen(quick.ctx, quick.pair, quickPlan));
  assert.deepEqual([ok.refused, ok.paid, ok.plan.pricedAt], [null, true, 2540]);
});
