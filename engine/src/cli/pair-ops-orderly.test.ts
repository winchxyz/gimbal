// Orderly pairs in pair-ops.ts: short Hyperliquid / long Orderly goes maker first on Hyperliquid and IOC on Orderly,
// its residual hedge on Orderly; Orderly and Phoenix go as two IOCs at once; a close refreshes the stored price before
// any order, and the Orderly leg's own price read refreshes one about to go stale once trading (the contract checks a
// reduce-only Orderly order against it too); the open refuses an IP list not applied on chain, and an Orderly input
// that cannot be read; no Orderly session, no Orderly pair.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VenueId } from '@gimbal/shared';
import type { LegOutcome, LegSide, PendingMakerOrder, TradeLeg } from '../trade/legs.ts';
import { wasSigned } from '../trade/legs.ts';
import { toQty } from '../trade/lots.ts';
import { PairTrader } from '../trade/pair.ts';
import type { PairShape } from '../trade/pair-shape.ts';
import { makerIndexOf, pairShape } from '../trade/pair-shape.ts';
import { PHOENIX_BUDGET, hostBudget } from '../venues/http-budget.ts';
import type { PriceDeps } from './pair-mainnet-lib.ts';
import { newPriceState } from './pair-mainnet-lib.ts';
import type { OpenPlan, OpsCtx, OrderlyLegSpec, OrderlyOps, Pair } from './pair-ops.ts';
import { buildPair, finish, planOpen, sendClose, sendOpen, storedPrice, traderRunner } from './pair-ops.ts';

const PHOENIX_URL = 'http://phoenix.orderly-pair.test';
hostBudget(PHOENIX_URL, { ...PHOENIX_BUDGET, ratePerSec: 1_000, burst: 1_000, adaptive: null, criticalFloor: null });

/** A venue leg: IOCs (order) and, on Hyperliquid, post-only maker orders; every call goes on the shared timeline. */
class FakeLeg implements TradeLeg {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly lot = toQty('1');
  readonly replayable: boolean;
  pos = 0n;
  orders: { kind: 'ioc' | 'maker'; side: LegSide; size: bigint; reduceOnly: boolean }[] = [];
  readonly timeline: string[];
  constructor(venue: VenueId, symbol: string, timeline: string[]) {
    this.timeline = timeline;
    this.venue = venue;
    this.symbol = symbol;
    this.replayable = venue === 'orderly';
  }
  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return toQty('6');
  }
  async position(): Promise<bigint> {
    return this.pos;
  }
  fill(kind: 'ioc' | 'maker', side: LegSide, size: bigint, reduceOnly: boolean): LegOutcome {
    this.orders.push({ kind, side, size, reduceOnly });
    this.timeline.push(`${this.venue} ${kind} ${side} ${size / toQty('1')}${reduceOnly ? ' reduce-only' : ''}`);
    this.pos += side === 'BUY' ? size : -size;
    return { kind: 'filled', filled: size, avgPx: 100, ref: { venue: this.venue, side, size: String(size), reduceOnly, orderId: `o${this.orders.length}`, clientId: null, tx: [], sentAt: 1 } };
  }
  async order(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    return this.fill('ioc', side, size, reduceOnly);
  }
}

/** Hyperliquid: post-only maker orders, and post-only orders that may be left unsettled (pending). */
class FakeHl extends FakeLeg {
  pending: PendingMakerOrder[] = [];
  /** What cancelPending finds filled late (base units, the sell side shrinks the position). */
  lateFill = 0n;
  constructor(timeline: string[]) {
    super('hyperliquid', 'SOL', timeline);
  }
  async makerOrder(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    return this.fill('maker', side, size, reduceOnly);
  }
  pendingMakerOrders(): readonly PendingMakerOrder[] {
    return this.pending;
  }
  async cancelPending(): Promise<string[]> {
    this.pending = [];
    this.pos -= this.lateFill;
    return [`cancelled; ${this.lateFill / toQty('1')} filled late`];
  }
}

const MAKER = { timeoutMs: 60_000, repriceMs: 30_000, maxOrders: 6, takerFallback: false };

/** A stored SOL price `ageS` old at `px`; refresh_prices stores one 610 s old at 101 and is put on the timeline. */
function priceWorld(timeline: string[], ageS: number, px = 100) {
  const rows = [{ asset: 'SOL', price_e8: String(px * 1e8), at_ms: Date.now() - ageS * 1000 }];
  const client = { prices: async () => rows.map((r) => ({ ...r })) } as unknown as OpsCtx['client'];
  const prices: PriceDeps = {
    maxAgeS: 900, send: true, read: (s) => storedPrice(client, s),
    refresh: async (s) => {
      timeline.push(`refresh_prices ${s}`);
      rows.splice(0, 1, { asset: 'SOL', price_e8: String(101 * 1e8), at_ms: Date.now() - 610_000 });
      return [{ chain: 'near', id: 'R', url: 'https://nearblocks.io/txns/R' }];
    },
    now: () => Date.now(), log: () => {}, ...newPriceState(),
  };
  return { client, prices };
}

/**
 * A Pair on fake legs in `shape`'s order, sending through its own trader as serve's runner does (the residual hedge on
 * a replayable leg through PairTrader.hedge, sized again from the target net); nothing reads a venue.
 */
function fakePair(shape: PairShape, legs: [FakeLeg, FakeLeg], priced = false): Pair {
  const trader = new PairTrader({ legs, priceBandBps: 100 });
  const makerIndex = makerIndexOf(shape);
  const hl = legs.find((l) => l.venue === 'hyperliquid') ?? null;
  const iocIndex = makerIndex === 0 ? 1 : 0;
  const ioc = legs[iocIndex];
  return {
    symbol: 'SOL', shape, legs, makerIndex, hl, phoenix: null, trader,
    run: {
      ...traderRunner(trader, ioc), stopOnFinish: false,
      hedge: (side: LegSide, size: bigint, reduceOnly: boolean, reason: string, targetNet?: bigint) => (ioc.replayable
        ? trader.hedge(iocIndex, side, size, reduceOnly, reason, targetNet)
        : (ioc as TradeLeg).order(side, size, reduceOnly, reason)),
    },
    lot: toQty('1'), bandBps: 100, priced, mismatches: [], marketConfig: null, orderlyMarket: null, maker: MAKER, microLamports: 1, targetNet: null,
  } as unknown as Pair;
}

/** The context of a send: Hyperliquid info must not be asked when no leg is on Hyperliquid (the builder fee is set). */
function sendCtx(timeline: string[], said: string[], prices?: { client: OpsCtx['client']; prices: PriceDeps }): OpsCtx {
  return {
    client: prices?.client, prices: prices?.prices, hlUrl: 'http://hl.must-not-be-read.test',
    config: { treasury: { hl_builder: '0xb' }, fees: { hl_builder_tenth_bps: 10 } },
    desk: { evm_address: '0xDESK', closing: false, policy: { price_band_bps: 100 } },
    relayer: { hlApproveBuilderFee: async () => { timeline.push('approve builder fee'); return { tx: [] }; } },
    send: true, trading: false, say: (l = '') => said.push(l), open: (l: string) => said.push(`open: ${l}`),
  } as unknown as OpsCtx;
}

const PLAN = { request: { symbol: 'SOL' }, refusals: [], size: toQty('10'), carry: {} } as unknown as OpenPlan;

/** fetch answers maxBuilderFee as approved; any other request is a bug in the test's path. */
async function withHlInfo<T>(run: () => Promise<T>, asked: string[]): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push(`${String(url)} ${String(init?.body)}`);
    return new Response(JSON.stringify(100), { status: 200 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test('short Hyperliquid / long Orderly: Hyperliquid sells post-only first, Orderly buys by IOC for what filled; the close mirrors it reduce-only', async () => {
  const timeline: string[] = [];
  const said: string[] = [];
  const shape = pairShape('SOL', 'orderly', 'hyperliquid');
  assert.deepEqual(shape, { legs: [{ venue: 'hyperliquid', symbol: 'SOL' }, { venue: 'orderly', symbol: 'PERP_SOL_USDC' }], longIndex: 1 });
  const hl = new FakeHl(timeline);
  const ol = new FakeLeg('orderly', 'PERP_SOL_USDC', timeline);
  const pair = fakePair(shape, [hl, ol]);
  const asked: string[] = [];
  const results = await withHlInfo(() => sendOpen(sendCtx(timeline, said), pair, PLAN), asked);
  assert.ok(results.every((r) => r.status === 'open'), results.map((r) => `${r.status} ${r.notes.join('; ')}`).join('\n'));
  assert.ok(hl.orders.length > 0 && hl.orders.every((o) => o.kind === 'maker' && o.side === 'SELL' && !o.reduceOnly));
  assert.ok(ol.orders.length > 0 && ol.orders.every((o) => o.kind === 'ioc' && o.side === 'BUY' && !o.reduceOnly));
  assert.deepEqual([hl.pos, ol.pos], [-toQty('10'), toQty('10')]);
  // Each part: the maker leg first, then its IOC partner.
  assert.deepEqual(timeline.map((l) => l.split(' ')[0]), ['hyperliquid', 'orderly', 'hyperliquid', 'orderly'], timeline.join('\n'));
  assert.equal(asked.length, 1, 'the builder fee is read once, for the Hyperliquid leg');

  timeline.length = 0;
  await withHlInfo(() => sendClose(sendCtx(timeline, said), pair, { reduceOnly: true, clampTargets: true }), asked);
  assert.deepEqual([hl.pos, ol.pos], [0n, 0n]);
  assert.ok(timeline.filter((l) => l.startsWith('hyperliquid')).every((l) => /maker BUY \d+ reduce-only/.test(l)), timeline.join('\n'));
  assert.ok(timeline.filter((l) => l.startsWith('orderly')).every((l) => /ioc SELL \d+ reduce-only/.test(l)), timeline.join('\n'));
});

test('a late Hyperliquid maker fill after the cancel: the residual hedge goes on Orderly, by one IOC back to the target net', async () => {
  const timeline: string[] = [];
  const said: string[] = [];
  const hl = new FakeHl(timeline);
  const ol = new FakeLeg('orderly', 'PERP_SOL_USDC', timeline);
  hl.pos = -toQty('10');
  ol.pos = toQty('10');
  hl.pending = [{ cloid: `0x${'12'.repeat(16)}`, oid: 42, side: 'SELL', size: '2' }];
  hl.lateFill = toQty('2');
  const pair = fakePair(pairShape('SOL', 'orderly', 'hyperliquid'), [hl, ol]);
  pair.targetNet = 0n;
  const ctx = sendCtx(timeline, said);
  ctx.trading = true;
  await finish(ctx, pair);
  assert.deepEqual(ol.orders, [{ kind: 'ioc', side: 'BUY', size: toQty('2'), reduceOnly: false }]);
  assert.deepEqual(hl.orders, [], 'nothing more on Hyperliquid');
  assert.deepEqual([hl.pos, ol.pos], [-toQty('12'), toQty('12')]);
  const out = said.join('\n');
  assert.match(out, /positions after the cancel: hyperliquid SOL -12, orderly SOL 10 \(net -2, target 0\)/);
  assert.match(out, /hedge {5}orderly BUY 2: back to the target net against hyperliquid -12/);
  assert.doesNotMatch(out, /open: /, 'hedged: nothing left for the owner');
});

test('Orderly and Phoenix: no post-only leg, both legs go as IOCs at once; Hyperliquid is never asked (no builder fee)', async () => {
  const timeline: string[] = [];
  const said: string[] = [];
  const shape = pairShape('SOL', 'phoenix', 'orderly');
  assert.deepEqual(shape.legs.map((l) => l.venue), ['orderly', 'phoenix']);
  assert.equal(makerIndexOf(shape), null);
  const ol = new FakeLeg('orderly', 'PERP_SOL_USDC', timeline);
  const px = new FakeLeg('phoenix', 'SOL', timeline);
  const pair = fakePair(shape, [ol, px]);
  const asked: string[] = [];
  const results = await withHlInfo(() => sendOpen(sendCtx(timeline, said), pair, PLAN), asked);
  assert.ok(results.every((r) => r.status === 'open'), results.map((r) => r.status).join(', '));
  assert.ok(ol.orders.every((o) => o.kind === 'ioc' && o.side === 'SELL'));
  assert.ok(px.orders.every((o) => o.kind === 'ioc' && o.side === 'BUY'));
  assert.deepEqual([ol.pos, px.pos], [-toQty('10'), toQty('10')]);
  assert.deepEqual(asked, [], 'no Hyperliquid read, no builder fee');
  assert.equal(timeline.includes('approve builder fee'), false);

  await withHlInfo(() => sendClose(sendCtx(timeline, said), pair, { reduceOnly: true, clampTargets: true }), asked);
  assert.deepEqual([ol.pos, px.pos], [0n, 0n]);
  assert.ok(ol.orders.slice(-1).every((o) => o.kind === 'ioc' && o.side === 'BUY' && o.reduceOnly));
  assert.ok(px.orders.slice(-1).every((o) => o.kind === 'ioc' && o.side === 'SELL' && o.reduceOnly));
  assert.deepEqual(asked, []);
});

test('a close on an Orderly leg refreshes a stored price about to go stale before any order is sent', async () => {
  const timeline: string[] = [];
  const said: string[] = [];
  const w = priceWorld(timeline, 800);
  const ol = new FakeLeg('orderly', 'PERP_SOL_USDC', timeline);
  const px = new FakeLeg('phoenix', 'SOL', timeline);
  ol.pos = -toQty('5');
  px.pos = toQty('5');
  const pair = fakePair(pairShape('SOL', 'phoenix', 'orderly'), [ol, px], true);
  await sendClose(sendCtx(timeline, said, w), pair, { reduceOnly: true, clampTargets: true });
  assert.equal(timeline[0], 'refresh_prices SOL', timeline.join('\n'));
  assert.deepEqual(timeline.slice(1).sort(), ['orderly ioc BUY 5 reduce-only', 'phoenix ioc SELL 5 reduce-only']);
});

// ---- buildPair: the Orderly leg comes from the desk's Orderly session ----

const POLICY = {
  max_notional_usd: 100, price_band_bps: 100, oracle_max_age_s: 900, unpriced: [], unpriced_max_notional_usd: 0,
  hl_assets: [{ symbol: 'SOL', index: 5, sz_decimals: 2 }], phoenix_markets: [], orderly_symbols: ['PERP_SOL_USDC'],
};

function buildCtx(timeline: string[], orderly: OrderlyOps | null, priceAgeS = 10, policy: object = POLICY): OpsCtx {
  const w = priceWorld(timeline, priceAgeS);
  return {
    client: w.client, prices: w.prices, config: {}, hlUrl: 'http://hl.test', phoenixUrl: PHOENIX_URL,
    desk: { policy, evm_address: '0xDESK', closing: false }, relayer: null, ...(orderly === null ? {} : { orderly }),
    send: true, trading: false, say: () => {}, open: () => {},
  } as unknown as OpsCtx;
}

const ORDERS = () => ({ maker: MAKER, microLamports: 1, slippageBps: 50 });

const SOL_MARKET = { venue: 'orderly', symbol: 'PERP_SOL_USDC', delisted: false, baseMmr: 0.012, fundingPeriodHours: 8, minNotional: 10 };

function orderlySession(timeline: string[], specs: OrderlyLegSpec[], up = true, markets: () => Promise<unknown[]> = async () => [SOL_MARKET]): OrderlyOps {
  return {
    reader: {
      markets,
    } as unknown as OrderlyOps['reader'],
    account: async () => {
      throw new Error('not read here');
    },
    ipsApplied: async () => true,
    leg: (spec) => {
      specs.push(spec);
      return up ? new FakeLeg('orderly', spec.symbol, timeline) : null;
    },
  };
}

test('buildPair: an Orderly pair needs the desk\'s Orderly session (pair-mainnet has none), one that is up, and the policy listing it', async () => {
  const timeline: string[] = [];
  const shape = pairShape('SOL', 'orderly', 'hyperliquid');
  await assert.rejects(buildPair(buildCtx(timeline, null), 'SOL', ORDERS, false, shape),
    /an Orderly leg \(PERP_SOL_USDC\) needs the desk's Orderly session, and there is none here \(pair-mainnet has none: Orderly pairs run in serve\)/);
  await assert.rejects(buildPair(buildCtx(timeline, orderlySession(timeline, [], false)), 'SOL', ORDERS, false, shape), /and it is not up: nothing is built or sent/);
  await assert.rejects(buildPair(buildCtx(timeline, orderlySession(timeline, []), 10, { ...POLICY, orderly_symbols: [] }), 'SOL', ORDERS, false, shape),
    /the policy does not list orderly PERP_SOL_USDC/);
  assert.deepEqual(timeline, [], 'nothing sent');
});

test('buildPair: the Orderly leg prices on the stored price, refreshed first once trading (a reduce-only close passes the contract\'s band too)', async () => {
  const timeline: string[] = [];
  const specs: OrderlyLegSpec[] = [];
  // 880 s old: within PRICE_STALE_MARGIN_S (30 s) of the 900 s limit.
  const ctx = buildCtx(timeline, orderlySession(timeline, specs), 880);
  const pair = await buildPair(ctx, 'SOL', ORDERS, true, pairShape('SOL', 'orderly', 'hyperliquid'));
  assert.deepEqual([pair.makerIndex, pair.legs.map((l) => l.venue), pair.hl !== null, pair.phoenix], [0, ['hyperliquid', 'orderly'], true, null]);
  assert.equal(pair.orderlyMarket?.symbol, 'PERP_SOL_USDC');
  assert.equal(specs.length, 1);
  assert.deepEqual({ ...specs[0]!, oraclePx: null }, { symbol: 'PERP_SOL_USDC', oraclePx: null, maxNotionalUsd: 100, slippageBps: 50 });
  // Planning: the stored price as it is, nothing sent.
  assert.equal(await specs[0]!.oraclePx(), 100);
  assert.deepEqual(timeline, []);
  // Trading (a close passed its refusals): one about to go stale is refreshed before the order is priced.
  ctx.trading = true;
  assert.equal(await specs[0]!.oraclePx(), 101);
  assert.deepEqual(timeline, ['refresh_prices SOL']);
});

// ---- planOpen: Orderly's carry inputs and refusals ----

function planCtx(o: { ips?: boolean | Error; funding?: boolean; account?: boolean } = {}) {
  const said: string[] = [];
  const rows = [{ asset: 'SOL', price_e8: String(100 * 1e8), at_ms: Date.now() - 10_000 }];
  const client = { prices: async () => rows.map((r) => ({ ...r })) } as unknown as OpsCtx['client'];
  const book = async () => ({ bids: [{ px: 99.9, sz: 100 }], asks: [{ px: 100.1, sz: 100 }] });
  const orderly: OrderlyOps = {
    reader: {
      book, markets: async () => [],
      funding: async () => (o.funding === false ? [] : [{ symbol: 'PERP_SOL_USDC', ratePerHour: 0.0001 }]),
      marketFundingHistory: async () => [{ time: 1, symbol: 'PERP_SOL_USDC', ratePerHour: 0.0001, ratePerPeriod: 0.0008, periodHours: 8 }],
    } as unknown as OrderlyOps['reader'],
    account: async () => {
      if (o.account === false) throw new Error('the private stream is not confirmed');
      return { venue: 'orderly', address: 'acct', time: 1, equityUsd: 100, freeMarginUsd: 100, maintenanceMarginUsd: 0, positions: [] };
    },
    ipsApplied: async () => {
      if (o.ips instanceof Error) throw o.ips;
      return o.ips ?? true;
    },
    leg: () => null,
  };
  const ctx = {
    client, config: {}, desk: { policy: { ...POLICY, phoenix_markets: [{ symbol: 'SOL' }] }, paused: false, closing: false, evm_address: '0xDESK' },
    hlUrl: 'http://hl.must-not-be-read.test', phoenixUrl: PHOENIX_URL,
    phoenix: {
      funding: async () => [{ symbol: 'SOL', ratePerHour: 0 }], marketFundingHistory: async () => [], book,
      account: async () => ({ cross: { equityUsd: 100, maintenanceMarginUsd: 0 }, positions: [] }),
    },
    chain: { balance: async () => 1_000_000_000, simulate: async () => ({ err: null, unitsConsumed: 200_000, logs: [] }) },
    sol: { authority: 'AUTH' }, relayer: null, orderly,
    prices: { maxAgeS: 900, send: false, read: (s: string) => storedPrice(client, s), refresh: async () => [], now: () => Date.now(), log: () => {}, ...newPriceState() },
    send: false, trading: false, say: (l = '') => said.push(l), open: (l: string) => said.push(`open: ${l}`),
  } as unknown as OpsCtx;
  return { ctx, said };
}

function planPair(shape: PairShape, simSides: LegSide[]): Pair {
  const lot = toQty('0.01');
  return {
    symbol: 'SOL', shape, legs: [], makerIndex: makerIndexOf(shape), hl: null, lot, bandBps: 100, priced: true, mismatches: [], microLamports: 1, targetNet: null, maker: MAKER,
    marketConfig: { takerFee: 0.0002, leverageTiers: [{ maxLeverage: 10, maxSizeBaseLots: '1000000' }], riskFactors: { maintenance: 50 } },
    orderlyMarket: { symbol: 'PERP_SOL_USDC', delisted: false, baseMmr: 0.012, fundingPeriodHours: 8, minNotional: 10 },
    trader: { openChunk: async () => toQty('6') },
    phoenix: {
      lot,
      plan: async (side: LegSide) => {
        simSides.push(side);
        return { px: 100.2, ticks: 1, lots: 50 };
      },
      message: async () => ({ message: new Uint8Array(0) }),
    },
  } as unknown as Pair;
}

/** The Phoenix trader-state answer of a registered desk; Hyperliquid must not be asked. */
async function withPhoenix<T>(run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).startsWith(PHOENIX_URL)) return new Response(JSON.stringify({ slot: 1, snapshot: { capabilities: { state: 'active' }, subaccounts: [] } }), { status: 200 });
    throw new Error(`not asked here: ${String(url)}`);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const REQUEST = { symbol: 'SOL', legUsd: 50, leverage: 1.5, holdDays: 7, basisBps: 10 };

test('planOpen, short Orderly / long Phoenix: Orderly\'s funding, fee and margin priced, both IOC at once, the Phoenix buy simulated', async () => {
  const { ctx, said } = planCtx();
  const sides: LegSide[] = [];
  const plan = await withPhoenix(() => planOpen(ctx, planPair(pairShape('SOL', 'phoenix', 'orderly'), sides), REQUEST));
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.size, toQty('0.5'));
  assert.deepEqual(sides, ['BUY'], 'Phoenix is long: its IOC buys');
  assert.deepEqual(plan.carry.legs.map((l) => `${l.venue} ${l.side}`), ['orderly short', 'phoenix long']);
  const out = said.join('\n');
  assert.match(out, /orderly \(short\) {5}funding now 0\.01000 %\/h/);
  assert.match(out, /phoenix \(long\) {6}funding now/);
  assert.match(out, /4 fills .* \(4 \+ 2(\.0+\d*)? bps each way\)/, 'Orderly: 3 bps taker plus gimbal_dex\'s 1 bp');
  assert.match(out, /order {5}no post-only leg: Orderly SELL and Phoenix BUY go as two IOCs at once for each part/);
  assert.match(out, /orderly {3}PERP_SOL_USDC: IP list applied on chain; base MMR 1\.20 %, funding every 8 h, minimum 10 USD/);
  assert.doesNotMatch(out, /leverage {2}Hyperliquid/);

  // Phoenix short: its simulated IOC sells.
  const short: LegSide[] = [];
  const again = await withPhoenix(() => planOpen(planCtx().ctx, planPair(pairShape('SOL', 'orderly', 'phoenix'), short), REQUEST));
  assert.deepEqual(short, ['SELL']);
  assert.deepEqual(again.carry.legs.map((l) => `${l.venue} ${l.side}`), ['phoenix short', 'orderly long']);
});

test('planOpen refuses an Orderly open the contract would refuse or cannot price: the IP list not applied (or unreadable), no funding, no account', async () => {
  const shape = pairShape('SOL', 'phoenix', 'orderly');
  const refusals = async (o: Parameters<typeof planCtx>[0]) => (await withPhoenix(() => planOpen(planCtx(o).ctx, planPair(shape, []), REQUEST))).refusals.join('\n');
  assert.match(await refusals({ ips: false }), /the contract has not applied the desk's Orderly IP list \(get_desk_settings orderly_ips_applied is not true\): on mainnet it refuses an Orderly order that is not reduce-only until the owner runs set_orderly_ips and the contract signs ip_restriction; nothing is sent/);
  assert.match(await refusals({ ips: new Error('RPC timeout') }), /the desk's Orderly IP list could not be read from the contract \(get_desk_settings: RPC timeout\)/);
  assert.match(await refusals({ funding: false }), /Orderly PERP_SOL_USDC funding cannot be read \(Orderly has no funding for PERP_SOL_USDC\): the carry is not priced without it/);
  assert.match(await refusals({ account: false }), /the desk's Orderly account cannot be read \(the private stream is not confirmed\): its margin is not known/);
});

test('buildPair: a close goes on an Orderly market dropped from the list (or a list that cannot be read); an open does not', async () => {
  const timeline: string[] = [];
  const shape = pairShape('SOL', 'orderly', 'hyperliquid');
  const dropped = orderlySession(timeline, [], true, async () => []);
  const closing = await buildPair(buildCtx(timeline, dropped), 'SOL', ORDERS, true, shape);
  assert.deepEqual([closing.orderlyMarket, closing.mismatches], [null, []], 'treated as delisted: nothing in a close reads it');
  const unread = orderlySession(timeline, [], true, async () => {
    throw new Error('HTTP 503');
  });
  assert.equal((await buildPair(buildCtx(timeline, unread), 'SOL', ORDERS, true, shape)).orderlyMarket, null);
  await assert.rejects(buildPair(buildCtx(timeline, dropped), 'SOL', ORDERS, false, shape), /Orderly has no PERP_SOL_USDC market the desk can trade/);
  await assert.rejects(buildPair(buildCtx(timeline, unread), 'SOL', ORDERS, false, shape), /HTTP 503/);
  assert.deepEqual(timeline, [], 'nothing sent');
});

test('traderRunner (pair-mainnet): a residual hedge on a replayable leg is refused, never signed', async () => {
  const timeline: string[] = [];
  const hl = new FakeHl(timeline);
  const ol = new FakeLeg('orderly', 'PERP_SOL_USDC', timeline);
  const trader = new PairTrader({ legs: [hl, ol], priceBandBps: 100 });
  const out = await traderRunner(trader, ol).hedge('BUY', toQty('2'), false, 'hedge');
  assert.equal(out.kind, 'failed');
  assert.equal(wasSigned(out), false);
  assert.match(out.kind === 'failed' ? out.error.message : '', /a CLI sends no hedge on a replayable leg/);
  assert.deepEqual(ol.orders, []);
});
