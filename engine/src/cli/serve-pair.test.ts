// servePair itself, with the venues, the contract and the legs stubbed: when it trades (GIMBAL_TRADE, the worktree,
// the lock, --once, the start plan, resting orders), the start lines, panic_close's cancel of resting orders, two
// serves at once, and the pair symbol as the policy spells it.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { StreamEvent, VenueId } from '@gimbal/shared';
import type { NearContractClient } from '../contract/near-client.ts';
import type { Relayer } from '../relayer/relayer.ts';
import type { LegOutcome, LegSide, PendingMakerOrder, TradeLeg } from '../trade/legs.ts';
import { toQty } from '../trade/lots.ts';
import { newAdlState } from '../risk/adl.ts';
import { LOCK_STALE_MS, THIS_PROCESS, TRADER_STATE_VERSION, TraderStateStore, lockHeartbeats, lockText, parseLockText, traderLockPath, traderStateFile } from '../trade/trader-state.ts';
import type { ContractSide } from './serve-contract.ts';
import type { CarryInput, ServePairDeps, ServePairInput, SlotCarry } from './serve-pair.ts';
import { liveLines, pairRefreshesAtOpen, servePair } from './serve-pair.ts';
import { ConfigError } from './start-errors.ts';

const CONTRACT = 'gimbal-test.near';
const DESK = 'canary';
const EVM = `0x${'ab'.repeat(20)}`;

class Leg implements TradeLeg {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly lot = toQty('1');
  readonly replayable = false;
  pos = 0n;
  orders: { side: LegSide; size: bigint; reduceOnly: boolean }[] = [];
  /** Awaited before an order fills (a test holds an open there). */
  hold: (() => Promise<void>) | null = null;
  /** Every position read (a test counts them). */
  reads = 0;
  /** Phoenix's trader snapshot when set: read in place of `pos`, its slot gated as PhoenixLeg gates it. */
  snap: { slot: number; pos: bigint } | null = null;
  /** The chain's confirmed slot that syncToChain takes (null: syncToChain changes nothing). */
  chainSlot: number | null = null;
  /** The oldest snapshot slot trusted: 0 after a restart, raised by syncToChain. */
  minSlot = 0;
  /** syncToChain throws this (the chain's slot cannot be read), when set. */
  syncFails: string | null = null;
  constructor(venue: VenueId, symbol: string) {
    this.venue = venue;
    this.symbol = symbol;
  }
  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return toQty('1000');
  }
  async position(): Promise<bigint> {
    this.reads++;
    if (this.snap === null) return this.pos;
    if (this.snap.slot < this.minSlot) throw new Error(`${this.venue}: the trader snapshot is at slot ${this.snap.slot}, still before slot ${this.minSlot}: the position is unknown`);
    return this.snap.pos;
  }
  async syncToChain(): Promise<void> {
    if (this.syncFails !== null) throw new Error(this.syncFails);
    if (this.chainSlot !== null) this.minSlot = Math.max(this.minSlot, this.chainSlot);
  }
  async order(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    if (this.hold !== null) await this.hold();
    this.orders.push({ side, size, reduceOnly });
    this.pos += side === 'BUY' ? size : -size;
    return { kind: 'filled', filled: size, avgPx: 1, ref: { venue: this.venue, side, size: String(size), reduceOnly, orderId: `o${this.orders.length}`, clientId: null, tx: [], sentAt: 1 } };
  }
  adoptPending(_orders: readonly PendingMakerOrder[]): void {}
  pendingMakerOrders(): readonly PendingMakerOrder[] {
    return [];
  }
  async cancelPending(): Promise<string[]> {
    return [];
  }
}

interface World {
  dir: string;
  env: Record<string, string>;
  hl: Leg;
  px: Leg;
  openOrders: unknown;
  signed: number;
  cancels: { asset: number; oid: number }[];
  lines: string[];
  /** What the stand-in carry refuses an open with. */
  refuse: string[];
  /** The stand-in carry signs one order outside the trader, then throws (an open that dies before its result). */
  throwAfterOrder: boolean;
  /** hlHeld throws this, when set (Hyperliquid info not answering). */
  hlHeldFails: string | null;
  /** signing() throws this, when set (NEAR RPC, or a configuration error). */
  signingFails: Error | null;
  /** refresh_prices calls the contract got, and the price row it stores (none: prices() answers nothing). */
  refreshes: number;
  /** refresh_prices throws this, when set (an RPC error before the call reached the chain). */
  refreshFails: Error | null;
  stored: { asset: string; price_e8: string; at_ms: number } | null;
}

function world(symbol = 'XLM', env: Record<string, string> = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-serve-pair-'));
  return {
    dir, env: { LOCALAPPDATA: dir, XDG_STATE_HOME: dir, ...env },
    hl: new Leg('hyperliquid', symbol), px: new Leg('phoenix', symbol), openOrders: [], signed: 0, cancels: [], lines: [], refuse: [], throwAfterOrder: false, hlHeldFails: null, signingFails: null,
    refreshes: 0, refreshFails: null, stored: null,
  };
}

function side(w?: World): ContractSide {
  const policy = {
    hl_assets: [{ symbol: 'XLM', index: 7, sz_decimals: 0 }, { symbol: 'kPEPE', index: 9, sz_decimals: 0 }, { symbol: 'ETH', index: 1, sz_decimals: 4 }],
    phoenix_markets: [{ symbol: 'XLM' }, { symbol: 'kPEPE' }],
    oracle_max_age_s: 900, price_band_bps: 100, unpriced: [], max_notional_usd: 20, unpriced_max_notional_usd: 10,
  };
  const client = {
    contractId: CONTRACT, prices: async () => (w?.stored == null ? [] : [{ ...w.stored }]),
    refreshPrices: async () => {
      if (w !== undefined) w.refreshes++;
      if (w?.refreshFails != null) throw w.refreshFails;
      return [];
    },
  } as unknown as NearContractClient;
  return { client, desk: { policy, evm_address: EVM, solana: { authority: 'Auth111' } }, policy, prices: {} } as unknown as ContractSide;
}

function input(w: World, extra: Partial<ServePairInput> = {}): ServePairInput {
  const deps: ServePairDeps = {
    hlHeld: async () => {
      if (w.hlHeldFails !== null) throw new Error(w.hlHeldFails);
      return w.hl.pos === 0n ? [] : [w.hl.symbol];
    },
    phoenixHeld: async () => (w.px.pos === 0n ? [] : [w.px.symbol]),
    openOrders: async () => w.openOrders,
    signing: async () => {
      if (w.signingFails !== null) throw w.signingFails;
      w.signed++;
      const relayer = {
        hlCancel: async (asset: number, oid: number) => {
          w.cancels.push({ asset, oid });
          return { kind: 'cancel', statuses: ['success'], oid: null, filled: null, resting: false, fills: [], tx: [{ chain: 'near', id: `c${oid}`, url: '' }], confirmed: true, expiresAfter: null };
        },
      } as unknown as Relayer;
      return { client: side(w).client, relayer };
    },
    buildLegs: async () => ({ hl: w.hl, phoenix: w.px, priced: false, mismatches: [] }),
    carry: (c) => testCarry(c, w),
    close: () => {},
  };
  return {
    mode: 'mainnet', env: (n) => w.env[n], side: side(w), deskId: DESK, clock: { now: () => Date.now() }, log: (l) => w.lines.push(l), publish: () => {},
    stateDir: w.dir, linkedWorktree: false, sleep: async () => {}, deps, ...extra,
  };
}

/** pair-mainnet's open and close stood in for: one size per USD (the legs' price is 1), refusals from the world. */
function testCarry(c: CarryInput, w: World): SlotCarry {
  return {
    open: async (request, out) => {
      if (w.refuse.length > 0) return { refusals: [...w.refuse], results: [] };
      if (w.throwAfterOrder) {
        await c.pair.hedge(0, 'SELL', toQty('1'), false, 'test: an order signed inside the open', true);
        throw new Error('the open died before its result was recorded');
      }
      out.say(`plan      ${c.symbol} ${request.legUsd} a leg at ${request.leverage}x`);
      return { refusals: [], results: await c.pair.openInChunks({ size: toQty(String(request.legUsd)), longIndex: 1, reason: request.reason }) };
    },
    close: async (request) => ({ refusals: [], results: [await c.pair.close({ reason: request.reason })] }),
  };
}

const lockPath = (w: World) => traderLockPath((n) => w.env[n], 'mainnet', CONTRACT, DESK);
const lines = (p: Awaited<ReturnType<typeof servePair>>) => liveLines({ pair: p, rescueSummary: 'rescue: detect only', rescueLive: false, mode: 'mainnet', alertPct: 25, monitorMin: 30 });

function open(w: World): void {
  w.hl.pos = toQty('-50');
  w.px.pos = toQty('50');
}

test('serve without GIMBAL_TRADE=1: alert only, no key loaded, no lock held, the start lines say so', async () => {
  const w = world();
  try {
    open(w);
    const p = await servePair(input(w));
    assert.equal(p.pair?.live, false);
    assert.equal(p.reducer(), null);
    assert.equal(p.cancelResting, undefined);
    assert.match(p.notTrading() ?? '', /^alert only: GIMBAL_TRADE is not 1/);
    assert.equal(w.signed, 0);
    assert.equal(existsSync(lockPath(w)), false);
    const out = lines(p);
    assert.ok(out.some((l) => /^live {6}trades: NOTHING, alert only: GIMBAL_TRADE is not 1/.test(l)), out.join('\n'));
    assert.ok(out.some((l) => /panic_close \(journaled, nothing cancelled or closed\)/.test(l)));
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('GIMBAL_TRADE=1 refuses in a linked worktree, before any key or lock', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1' });
  try {
    open(w);
    await assert.rejects(servePair(input(w, { linkedWorktree: true })), /linked git worktree, and trading refuses here/);
    assert.equal(w.signed, 0);
    assert.equal(existsSync(lockPath(w)), false);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('GIMBAL_TRADE=1 with no trader state: alert only (a missing file is not a fresh start) and the lock is released', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1' });
  try {
    open(w);
    const p = await servePair(input(w));
    assert.equal(p.pair?.live, false);
    assert.match(p.pair?.why ?? '', new RegExp(`a missing file is not a fresh start.*GIMBAL_TRADER_FRESH=${CONTRACT}/${DESK}`));
    assert.equal(existsSync(lockPath(w)), false, 'alert only holds no lock: pair-mainnet may fix what is wrong');
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('GIMBAL_TRADE=1 with the fresh start named: trades, holds the lock, writes the state; a second serve is refused; stop releases', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    open(w);
    const p = await servePair(input(w));
    assert.equal(p.pair?.live, true, p.pair?.why ?? '');
    assert.equal(p.reducer(), p.pair);
    assert.equal(p.notTrading(), null);
    assert.equal(parseLockText(readFileSync(lockPath(w), 'utf8'))?.id, THIS_PROCESS.id);
    const out = lines(p);
    assert.ok(out.some((l) => /^live {6}TRADES \(GIMBAL_TRADE=1\).*panic_close -> resting Hyperliquid orders cancelled, both legs closed; ADL -> pair paused, both legs unwound \(3 of 3 attempts left\)/.test(l)), out.join('\n'));
    // Two serves at once: the second (a restart with FRESH left in the env, or a second terminal) cannot take the lock;
    // it does not stop either (review S1: an exit would crash-loop): alert only, the lock tried again.
    const second = await servePair(input(w));
    assert.match(second.unconfirmed!() ?? '', /the trader lock is not held: this process \(pid \d+\) already trades this desk.*pair-mainnet --send holds the same lock/);
    assert.equal(second.pair === null, true);
    second.stop();
    assert.ok(existsSync(lockPath(w)), 'the first serve keeps its lock');
    // FRESH left in the env: the next start finds a usable state, so FRESH is ignored (with a line) and it is restored.
    p.stop();
    assert.equal(existsSync(lockPath(w)), false);
    const again = await servePair(input(w));
    assert.equal(again.pair?.live, true);
    assert.ok(again.lines.some((l) => /GIMBAL_TRADER_FRESH is ignored: .* is a usable trader state and is used as saved .*remove GIMBAL_TRADER_FRESH from the env/.test(l)), again.lines.join('\n'));
    assert.ok(again.lines.some((l) => /restored from .*as saved/.test(l)), again.lines.join('\n'));
    again.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('GIMBAL_TRADER_FRESH=1 (the old form) is ignored: the start says how to name the desk', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: '1' });
  try {
    open(w);
    const p = await servePair(input(w));
    assert.equal(p.pair?.live, false);
    assert.ok(p.lines.some((l) => l.includes(`GIMBAL_TRADER_FRESH="1" is ignored: a fresh start names this contract and desk, GIMBAL_TRADER_FRESH=${CONTRACT}/${DESK}`)), p.lines.join('\n'));
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('serve --once is alert only even with GIMBAL_TRADE=1: no key, no lock, nothing can be cut off by its exit', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    open(w);
    const p = await servePair(input(w, { once: true }));
    assert.equal(p.pair?.live, false);
    assert.match(p.pair?.why ?? '', /^serve --once is alert only \(GIMBAL_TRADE=1 is ignored/);
    assert.equal(w.signed, 0);
    assert.equal(existsSync(lockPath(w)), false);
    await assert.rejects(p.pair!.close({ reason: 'panic_close' }), /alert only/);
    assert.equal(w.hl.orders.length + w.px.orders.length, 0);
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('a resting order on the pair\'s coin at start: alert only with a line naming it; unreadable open orders are retried', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    open(w);
    w.openOrders = [{ coin: 'XLM', side: 'B', sz: '10', oid: 42 }];
    const p = await servePair(input(w));
    assert.equal(p.pair?.live, false);
    assert.match(p.pair?.why ?? '', /Hyperliquid has 1 resting XLM order\(s\) \(BUY 10 \(oid 42\)\).*cancel it on Hyperliquid, reconcile both legs, then start serve again/);
    p.stop();
    // Open orders that cannot be read are a read that failed: not confirmed, tried again, then live.
    w.openOrders = 'HTTP 500';
    const q = await servePair(input(w));
    assert.equal(q.pair === null, true);
    assert.match(q.unconfirmed!() ?? '', /the Hyperliquid open orders cannot be read/);
    w.openOrders = [];
    assert.match(await q.retryStart!() ?? '', /XLM trades$/);
    assert.equal(q.pair?.live, true);
    q.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('panic_close\'s cancelResting cancels every resting order on a policy coin through the relayer, and names the rest', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    open(w);
    const p = await servePair(input(w));
    assert.equal(p.pair?.live, true);
    w.openOrders = [{ coin: 'ETH', side: 'B', sz: '0.01', oid: 2 }, { coin: 'DOGE', side: 'B', sz: '1', oid: 3 }, { coin: 'XLM', side: 'A', sz: '5', oid: 1 }, { coin: 'ETH', side: 'A', sz: '0.02', oid: 'x9' }];
    const r = await p.cancelResting!();
    assert.equal(r.cancelled, 2);
    assert.deepEqual(w.cancels, [{ asset: 7, oid: 1 }, { asset: 1, oid: 2 }], 'the pair\'s coin first, then the rest in order');
    assert.deepEqual(r.tx.map((t) => t.id), ['c1', 'c2']);
    assert.match(r.notes.join('; '), /DOGE BUY 1 \(oid 3\): not a policy coin, not cancelled here; ETH SELL 0\.02 \(oid x9\): the order id is not a number, so it cannot be cancelled by id here; cancel it on Hyperliquid.*Phoenix: the leg sends IOCs only/);
    w.openOrders = { error: 'down' };
    await assert.rejects(p.cancelResting!(), /open orders cannot be read/);
    p.stop();
    w.openOrders = [{ coin: 'XLM', side: 'A', sz: '5', oid: 4 }];
    await assert.rejects(p.cancelResting!(), /serve is stopping and its trader lock is released: nothing is cancelled/);
    assert.equal(w.cancels.length, 2);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('GIMBAL_PAIR_SYMBOL is taken as the policy spells it (kPEPE), not uppercased; an unknown one protects nothing', async () => {
  const w = world('kPEPE', { GIMBAL_PAIR_SYMBOL: 'kPEPE' });
  try {
    const p = await servePair(input(w));
    assert.equal(p.pair?.symbol, 'kPEPE');
    p.stop();
    w.env.GIMBAL_PAIR_SYMBOL = 'KPEPE';
    const q = await servePair(input(w));
    assert.equal(q.pair, null);
    assert.match(q.lines.join('\n'), /KPEPE is not in both policy\.hl_assets and policy\.phoenix_markets/);
    q.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('the start lines: ADL alert only while orders saved in flight hold it, and when the baselines do not offset', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    w.hl.pos = toQty('-50');
    w.px.pos = toQty('40');
    const p = await servePair(input(w));
    const out = lines(p);
    assert.ok(out.some((l) => /ADL -> alert only: the baselines -50 and 40 do not offset each other/.test(l)), out.join('\n'));
    p.stop();
    // A crash in the middle of a reduce: the state holds the pair as before it and the Hyperliquid order in flight.
    const identity = { contractId: CONTRACT, deskId: DESK, evm: EVM };
    const store = new TraderStateStore(traderStateFile(w.dir, 'mainnet', identity), identity);
    const trader = { intents: [toQty('-50'), toQty('50')], baselines: [toQty('-50'), toQty('50')], known: [toQty('-50'), toQty('50')], net: 0n, unhedged: null, unsettled: [] } as const;
    store.save({
      version: TRADER_STATE_VERSION, savedAt: 1, symbol: 'XLM', trader: { ...trader, intents: [...trader.intents], baselines: [...trader.baselines], known: [...trader.known], unsettled: [] }, pendingMaker: [],
      inFlight: [{ index: 0, venue: 'hyperliquid', side: 'BUY', size: '10', reduceOnly: true, reason: 'rescue r1: reduce', at: Date.now() - 1_000, op: 'close' }], adl: newAdlState(),
    });
    delete w.env.GIMBAL_TRADER_FRESH;
    w.hl.pos = toQty('-40');      // our reduce landed, its result was never saved
    w.px.pos = toQty('50');
    const q = await servePair(input(w));
    assert.equal(q.pair?.live, true, 'panic_close and a rescue reduce still trade');
    const after = lines(q);
    assert.ok(after.some((l) => /ADL -> alert only: 1 order\(s\) were in flight when the engine stopped \(hyperliquid BUY 10\)/.test(l)), after.join('\n'));
    assert.ok(after.some((l) => /^open: {5}hyperliquid BUY 10 XLM reduce-only \(rescue r1: reduce\) was sent at /.test(l)));
    assert.equal(q.pair?.trader.baseline(q.pair.legs[0]), toQty('-50'), 'the saved baselines, not the venues: the shrink is not hidden');
    q.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

/**
 * A crash in the middle of a reduce: the state holds the pair as before it (-50/50) and the reduce's orders in flight
 * (both legs by 10, or the Hyperliquid BUY 10 alone when `both` is false).
 */
function crashed(w: World, at: number, both = true): void {
  const identity = { contractId: CONTRACT, deskId: DESK, evm: EVM };
  const store = new TraderStateStore(traderStateFile(w.dir, 'mainnet', identity), identity);
  const hl = { index: 0 as const, venue: 'hyperliquid' as const, side: 'BUY' as const, size: '10', reduceOnly: true, reason: 'rescue r1: reduce', at, op: 'close' as const };
  const px = { ...hl, index: 1 as const, venue: 'phoenix' as const, side: 'SELL' as const };
  store.save({
    version: TRADER_STATE_VERSION, savedAt: 1, symbol: 'XLM',
    trader: { intents: [toQty('-50'), toQty('50')], baselines: [toQty('-50'), toQty('50')], known: [toQty('-50'), toQty('50')], net: 0n, unhedged: null, unsettled: [] }, pendingMaker: [],
    inFlight: both ? [hl, px] : [hl], adl: newAdlState(),
  });
}

const ownerEntries = (events: StreamEvent[]) => events.flatMap((e) => (e.type === 'journal' && e.data.kind === 'error' && e.data.summary.startsWith('owner: ') ? [e.data.summary] : []));

test('(A) orders saved in flight that can no longer run are settled at start: offsetting reads adopted, a leg moved alone keeps the baselines, others keep the hold; the owner is journaled', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1' });
  try {
    const events: StreamEvent[] = [];
    crashed(w, Date.now() - 11 * 60_000);
    w.hl.pos = toQty('-40');      // the reduce landed on both legs, its result was never saved
    w.px.pos = toQty('40');
    const p = await servePair(input(w, { publish: (e) => events.push(e) }));
    assert.equal(p.pair?.live, true);
    assert.equal(p.pair?.adlHold, null);
    assert.equal(p.pair?.trader.baseline(p.pair.legs[0]), toQty('-40'));
    assert.ok(p.lines.some((l) => /offsetting each other: adopted, the ADL hold ends/.test(l)), p.lines.join('\n'));
    assert.deepEqual(ownerEntries(events), [], 'an adopt is no news for the owner');
    p.stop();
    // Hyperliquid alone moved by its BUY 10: an ADL while serve was down looks the same as the reduce never sent.
    crashed(w, Date.now() - 11 * 60_000, false);
    w.px.pos = toQty('50');
    const q = await servePair(input(w, { publish: (e) => events.push(e) }));
    assert.equal(q.pair?.adlHold, null);
    assert.equal(q.pair?.trader.baseline(q.pair.legs[0]), toQty('-50'), 'not adopted: the ADL watch sees the shrink');
    assert.match(ownerEntries(events).join('\n'), /^owner: .*do not offset each other .*not adopted; the ADL hold ends and the saved baselines stay/);
    const r = await q.adl!.check();
    assert.notEqual(r?.stage, 'alert');
    assert.deepEqual([w.hl.pos, w.px.pos], [0n, 0n], 'both legs unwound reduce-only');
    q.stop();
    crashed(w, Date.now() - 11 * 60_000);
    w.hl.pos = toQty('-45');      // neither the baseline nor the order: an ADL, a partial fill, a trade elsewhere
    w.px.pos = toQty('50');
    events.length = 0;
    const u = await servePair(input(w, { publish: (e) => events.push(e) }));
    assert.equal(u.pair?.live, true, 'panic_close and a rescue reduce still trade');
    const out = lines(u);
    assert.ok(out.some((l) => /ADL -> alert only: 2 order\(s\) were in flight .* can no longer run, but hyperliquid reads -45, .*npm run monitor -w engine -- --mainnet.*pair-mainnet close XLM --send.*move .*trader-mainnet-.*\.json aside, then start serve once with GIMBAL_TRADER_FRESH=gimbal-test\.near\/canary/.test(l)), out.join('\n'));
    assert.equal(u.pair?.trader.baseline(u.pair.legs[0]), toQty('-50'));
    assert.match(ownerEntries(events)[0] ?? '', /^owner: ADL hold stays: /);
    u.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('(A) orders in flight that could still run at start are settled from the venues once they cannot', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1' });
  try {
    let now = Date.now();
    crashed(w, now - 1_000);
    w.hl.pos = toQty('-40');
    w.px.pos = toQty('40');
    const p = await servePair(input(w, { clock: { now: () => now } }));
    assert.match(p.pair?.adlHold ?? '', /or until they can no longer run \(.*\) and serve settles them from the venues/);
    assert.match((await p.settleInFlight!()) ?? '', /they can run until .*, settled from the venues then/);
    assert.notEqual(p.pair?.adlHold, null);
    now += 10 * 60_000;
    assert.match((await p.settleInFlight!()) ?? '', /offsetting each other: adopted, the ADL hold ends/);
    assert.equal(p.pair?.adlHold, null);
    assert.equal(p.pair?.trader.baseline(p.pair.legs[0]), toQty('-40'));
    assert.equal(await p.settleInFlight!(), null);
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('(B) a usable state and FRESH left set: a shrink since the last run is restored against, and the ADL watch takes it (two reads, then the unwind)', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    open(w);
    const p = await servePair(input(w));
    p.stop();
    w.hl.pos = toQty('-30');      // ADL while serve was down
    const q = await servePair(input(w));
    assert.equal(q.pair?.live, true);
    assert.equal(q.pair?.trader.baseline(q.pair.legs[0]), toQty('-50'), 'restored, not adopted');
    const r = await q.adl!.check();
    assert.notEqual(r?.stage, 'alert');
    assert.notEqual(q.adl!.state.paused, null);
    assert.deepEqual([w.hl.pos, w.px.pos], [0n, 0n], 'unwound reduce-only');
    q.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('(C) stop() turns trading off first: no reducer, closes and guarded orders refused, nothing signed or saved after it', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    open(w);
    const p = await servePair(input(w));
    const reducer = p.reducer();
    assert.notEqual(reducer, null);
    p.stop();
    assert.equal(p.reducer(), null);
    assert.equal(p.notTrading(), 'serve is stopping: nothing is signed');
    // A rescue that took the reducer before stop() and reaches its reduce after it.
    await assert.rejects(reducer!.close({ reason: 'rescue: reduce', targets: [toQty('-40'), toQty('40')] }), /serve is stopping and its trader lock is released: nothing is signed/);
    const r = await p.pair!.legs[0].order('BUY', toQty('10'), true, 'rescue: reduce');
    assert.match(r.kind === 'failed' ? r.error.message : '', /serve is stopping and its trader lock is released; nothing signed/);
    assert.equal(w.hl.orders.length + w.px.orders.length, 0);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('the hands (strategy loop): a flat desk opens through the pair, is held and protected at once, and closes reduce-only; refusals sign nothing', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    const p = await servePair(input(w));
    assert.ok(p.hands !== undefined, p.lines.join('\n'));
    const hands = p.hands!;
    assert.deepEqual([...hands.symbols].sort(), ['XLM', 'kPEPE']);
    assert.equal(hands.heldSymbol(), null);
    assert.equal(hands.blocked(), null);
    // Not one of the pair's symbols: refused, nothing sent.
    const eth = await hands.open({ symbol: 'ETH', legUsd: 10, leverage: 1.5, reason: 'test' });
    assert.equal(eth.ok, false);
    assert.equal(w.hl.orders.length + w.px.orders.length, 0);
    // The carry plan refuses: nothing sent, the reason says why.
    w.refuse = ['Hyperliquid leg 38 % from liquidation, under 40 %'];
    const refused = await hands.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'test' });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /38 % from liquidation/);
    assert.equal(w.hl.orders.length + w.px.orders.length, 0);
    w.refuse = [];
    // The open: short Hyperliquid, long Phoenix, then held and protected as an adopted pair (ADL, reducer).
    const opened = await hands.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'strategy: enter xlm-phoenix-hyperliquid' });
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(w.hl.pos, -toQty('10'));
    assert.equal(w.px.pos, toQty('10'));
    assert.equal(hands.heldSymbol(), 'XLM');
    assert.equal(p.reducer(), p.pair);
    assert.equal(p.pair?.live, true);
    assert.ok(p.adl !== undefined);
    // A second open while a pair is held: refused.
    const twice = await hands.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'test' });
    assert.equal(twice.ok, false);
    // Outside the loop's open, the guarded legs refuse anything that could grow a position.
    const grow = await p.pair!.legs[0]!.order('SELL', toQty('1'), false, 'test');
    assert.equal(grow.kind, 'failed');
    assert.match(String((grow as { error: Error }).error.message), /reduce-only orders only, outside the strategy loop's open, and this one could open or grow a position; nothing signed/);
    // The close: both legs reduce-only, flat.
    const before = w.hl.orders.length;
    const closed = await hands.close({ reason: 'strategy: exit' });
    assert.equal(closed.ok, true, closed.reason);
    assert.equal(w.hl.pos, 0n);
    assert.equal(w.px.pos, 0n);
    assert.ok(w.hl.orders.slice(before).every((o) => o.reduceOnly));
    assert.equal(hands.heldSymbol(), null);
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

/** A trader whose last live reads say `known` while its record (baselines) says what the open left. */
function liveReads(p: Awaited<ReturnType<typeof servePair>>, known: [bigint, bigint]): void {
  const t = p.pair!.trader;
  const s = t.exportState();
  t.importState({ ...s, known });
}

test('F1: a pair recorded while the venues hold one leg (an IOC lapsed, its unwind failed): two agreeing reads adopt it, and the leg is named to close', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    const p = await servePair(input(w));
    const hands = p.hands!;
    const opened = await hands.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'strategy: enter' });
    assert.equal(opened.ok, true, opened.reason);
    // Nothing differs: no read, nothing changes.
    const reads = w.hl.reads + w.px.reads;
    assert.equal(await hands.reconcile(), null);
    assert.equal(w.hl.reads + w.px.reads, reads, 'record and live reads agree: no venue read');
    // Phoenix's IOC never ran (its lapse read 0) and the Hyperliquid unwind failed: the record still says a pair.
    w.px.pos = 0n;
    liveReads(p, [-toQty('10'), 0n]);
    assert.deepEqual(hands.heldLegs().map((l) => l.qty), [-toQty('10'), toQty('10')], 'the record before');
    const line = await hands.reconcile();
    assert.match(line ?? '', /XLM record reconciled with the venues: it said pair \(-10 and 10\), two reads agree on one leg \(-10 and 0\) and are adopted; the single leg is closed reduce-only next/);
    assert.deepEqual(hands.heldLegs().map((l) => l.qty), [-toQty('10'), 0n]);
    assert.equal(hands.heldSymbol(), 'XLM');
    // The loop's close of the one leg: reduce-only, flat.
    const before = w.hl.orders.length;
    const closed = await hands.close({ reason: 'strategy: one leg open: hyperliquid -10, closed reduce-only' });
    assert.equal(closed.ok, true, closed.reason);
    assert.equal(w.hl.pos, 0n);
    assert.ok(w.hl.orders.slice(before).every((o) => o.reduceOnly));
    assert.equal(w.px.orders.length, 1, 'nothing sent on the flat Phoenix leg');
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('F1: a pair recorded while both venues are flat is cleared after two agreeing reads; reads that do not confirm change nothing', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    const p = await servePair(input(w));
    const hands = p.hands!;
    assert.equal((await hands.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'strategy: enter' })).ok, true);
    // The live reads say flat but the venues still hold the pair: not confirmed, nothing adopted.
    liveReads(p, [0n, 0n]);
    assert.equal(await hands.reconcile(), null);
    assert.equal(hands.heldSymbol(), 'XLM');
    // Both legs closed outside the trader: every exit would be refused "nothing to close" and every open "a pair is held".
    w.hl.pos = 0n;
    w.px.pos = 0n;
    liveReads(p, [0n, 0n]);
    assert.match(await hands.reconcile() ?? '', /record reconciled with the venues: it said pair \(-10 and 10\), two reads agree on flat \(0 and 0\) and are adopted$/);
    assert.equal(hands.heldSymbol(), null);
    const again = await hands.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'strategy: enter' });
    assert.equal(again.ok, true, again.reason);
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('Phoenix settlement lag after a restart: a stale snapshot showing Phoenix 0 is never adopted as one leg; reconcile syncs to the chain first', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    const p = await servePair(input(w));
    const hands = p.hands!;
    assert.equal((await hands.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'strategy: enter' })).ok, true);
    // As after a restart: the Phoenix leg trusts any snapshot again (slot 0), and Phoenix's snapshot (slot 100) is from
    // before the long landed (the chain is at 120), so it shows 0. The live reads already say one leg (HL -10, PX 0).
    w.px.minSlot = 0;
    w.px.snap = { slot: 100, pos: 0n };
    w.px.chainSlot = 120;
    liveReads(p, [-toQty('10'), 0n]);
    assert.equal(await hands.reconcile(), null);
    assert.ok(w.lines.some((l) => /not reconciled: phoenix: the trader snapshot is at slot 100, still before slot 120: the position is unknown/.test(l)), w.lines.join('\n'));
    assert.deepEqual(hands.heldLegs().map((l) => l.qty), [-toQty('10'), toQty('10')], 'nothing adopted: the pair stays recorded');
    // The snapshot reaches the chain's slot: the venues hold the pair after all, so nothing changes.
    w.px.snap = { slot: 121, pos: toQty('10') };
    assert.equal(await hands.reconcile(), null);
    assert.deepEqual(hands.heldLegs().map((l) => l.qty), [-toQty('10'), toQty('10')]);
    assert.deepEqual([w.hl.pos, w.px.pos], [-toQty('10'), toQty('10')], 'no leg was closed');
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

/** A trader state saved with the XLM pair -50/50, nothing in flight (a clean restart). */
function savedPair(w: World): void {
  const identity = { contractId: CONTRACT, deskId: DESK, evm: EVM };
  const store = new TraderStateStore(traderStateFile(w.dir, 'mainnet', identity), identity);
  store.save({
    version: TRADER_STATE_VERSION, savedAt: 1, symbol: 'XLM',
    trader: { intents: [toQty('-50'), toQty('50')], baselines: [toQty('-50'), toQty('50')], known: [toQty('-50'), toQty('50')], net: 0n, unhedged: null, unsettled: [] }, pendingMaker: [],
    inFlight: [], adl: newAdlState(),
  });
}

/** The start's word on each venue's health, the latest one: `venue status`, sorted. */
function healthOf() {
  const last = new Map<string, string>();
  return {
    hook: (v: string, s: string, d: string | null) => last.set(v, d === null ? s : `${s}: ${d}`),
    now: () => [...last.entries()].sort().map(([v, s]) => `${v} ${s}`),
  };
}

/** The start's journal lines (numbers.stage 'start'), as `kind: summary`. */
const startJournal = (events: StreamEvent[]) => events.flatMap((e) => (e.type === 'journal' && e.data.numbers.stage === 'start' ? [`${e.data.kind}: ${e.data.summary}`] : []));

test('S1: a Phoenix snapshot behind the chain at start: alert only with the legs unknown, retried, then live once two synced reads agree', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1' });
  try {
    savedPair(w);
    w.hl.pos = toQty('-50');
    w.px.pos = toQty('50');
    w.px.snap = { slot: 100, pos: 0n };
    w.px.chainSlot = 120;
    const events: StreamEvent[] = [];
    const health = healthOf();
    const closes: string[] = [];
    const p = await servePair(input(w, { publish: (e) => events.push(e), health: health.hook, onProtectionClose: (r) => closes.push(`${r.by} ${r.result?.status ?? r.error}`) }));
    // Serve runs on: nothing adopted, nothing trades, every act refused with the reason.
    assert.equal(p.pair === null, true, 'the stale Phoenix 0 is not adopted');
    assert.match(p.unconfirmed!() ?? '', /^legs unknown, start not confirmed: the legs could not be read twice alike \(phoenix: the trader snapshot is at slot 100, still before slot 120: the position is unknown\); nothing is adopted$/);
    assert.equal(p.reducer(), null);
    assert.match(p.notTrading() ?? '', /^legs unknown, start not confirmed/);
    assert.notEqual(p.adl, undefined, 'the ADL watch is kept for the pair to come');
    assert.equal(await p.adl!.check(), null);
    await assert.rejects(p.cancelResting!(), /legs unknown, start not confirmed.*nothing is cancelled/);
    const hands = p.hands!;
    assert.match(hands.blocked() ?? '', /^legs unknown, start not confirmed/);
    const opened = await hands.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'strategy: enter' });
    assert.equal(opened.ok, false);
    assert.match(opened.reason, /^legs unknown, start not confirmed/);
    assert.match((await hands.close({ reason: 'strategy: exit' })).reason, /^legs unknown, start not confirmed/);
    assert.deepEqual([w.hl.orders.length, w.px.orders.length], [0, 0]);
    assert.ok(existsSync(lockPath(w)), 'the lock is kept: the pair goes live without a restart');
    assert.deepEqual(health.now().map((h) => h.replace(/: .*/, '')), ['hyperliquid ok', 'near ok', 'phoenix slow']);
    assert.ok(lines(p).some((l) => /^live {6}trades: NOTHING yet, legs unknown, start not confirmed: .*goes live once two synced reads of both legs agree/.test(l)), lines(p).join('\n'));
    assert.equal(startJournal(events).length, 1);
    assert.match(startJournal(events)[0]!, /^error: pair start not confirmed: .*still before slot 120.*Alert only until two synced reads of both legs agree/);
    // Still behind: tried again, the same reason is not journaled again.
    assert.equal(await p.retryStart!(), null);
    assert.equal(startJournal(events).length, 1);
    // The snapshot reaches the chain's slot: the saved pair is restored and trades.
    w.px.snap = { slot: 121, pos: toQty('50') };
    assert.match(await p.retryStart!() ?? '', /^pair start confirmed after 2 failed attempt\(s\): both legs synced to their chains and read twice alike; XLM trades$/);
    assert.equal(p.unconfirmed!(), null);
    assert.equal(p.pair?.live, true);
    assert.deepEqual(p.pair!.legs.map((l) => p.pair!.trader.baseline(l)), [toQty('-50'), toQty('50')]);
    assert.deepEqual(p.pair!.legs.map((l) => p.pair!.trader.known(l)), [toQty('-50'), toQty('50')]);
    assert.equal(hands.blocked(), null);
    assert.notEqual(p.reducer(), null);
    assert.match(startJournal(events).at(-1)!, /^wait: pair start confirmed after 2 failed attempt/);
    assert.deepEqual(health.now(), ['hyperliquid ok', 'near ok', 'phoenix ok']);
    assert.equal(await p.retryStart!(), null, 'confirmed: nothing more to try');
    // The position book's hook: nothing reported while the start was pending, wired to the pair once it trades.
    assert.deepEqual(closes, []);
    await p.pair!.close({ reason: 'panic_close', by: 'panic_close' });
    assert.equal(closes.length, 1);
    assert.match(closes[0]!, /^panic_close /);
    p.stop();
    assert.equal(existsSync(lockPath(w)), false);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('S1 (Railway): a lock of this pid (node is pid 1 in every container) waits while it beats, is taken over once its heartbeat is over 90 s old, and beats until stop()', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1' });
  const beatAgo = (agoMs: number) => {
    const t = new Date(Date.now() - agoMs);
    utimesSync(lockPath(w), t, t);
  };
  try {
    savedPair(w);
    w.hl.pos = toQty('-50');
    w.px.pos = toQty('50');
    // Another process with this pid: the container before this one, or one overlapping it. Beating: it waits.
    mkdirSync(dirname(lockPath(w)), { recursive: true });
    writeFileSync(lockPath(w), lockText({ pid: process.pid, startedMs: THIS_PROCESS.startedMs! - 60_000, id: 'killed-container', boot: THIS_PROCESS.boot }));
    beatAgo(10_000);
    const beats = lockHeartbeats();
    const events: StreamEvent[] = [];
    const p = await servePair(input(w, { publish: (e) => events.push(e) }));
    assert.match(p.unconfirmed!() ?? '', /^legs unknown, start not confirmed: the trader lock is not held: another process \(.*its last heartbeat 10 s ago: taken over only after 90 s without one\)/);
    assert.equal(p.pair === null, true, 'alert only meanwhile, nothing adopted');
    assert.equal(parseLockText(readFileSync(lockPath(w), 'utf8'))?.id, 'killed-container', 'left alone while it beats');
    assert.equal(lockHeartbeats(), beats);
    // Its heartbeat stopped over 90 s ago (the container was killed): the next try takes it over.
    beatAgo(LOCK_STALE_MS + 5_000);
    assert.match(await p.retryStart!() ?? '', /^pair start confirmed after 1 failed attempt\(s\).*XLM trades$/);
    assert.equal(p.pair?.live, true, p.pair?.why ?? '');
    assert.equal(parseLockText(readFileSync(lockPath(w), 'utf8'))?.id, THIS_PROCESS.id, 'the lock is this process\'s now');
    const took = events.flatMap((e) => (e.type === 'journal' && e.data.numbers.stage === 'lock' ? [e.data.summary] : []));
    assert.equal(took.length, 1);
    assert.match(took[0]!, new RegExp(`^pair: the trader lock .* of pid ${process.pid} was stale \\(it names pid ${process.pid}, this process's own pid .*its last heartbeat 95 s ago, over 90 s: that process is gone\\) and is taken over`));
    assert.ok(w.lines.some((l) => /pair {6}the trader lock .* was stale/.test(l)));
    assert.equal(lockHeartbeats(), beats + 1, 'the holder beats');
    p.stop();
    assert.equal(lockHeartbeats(), beats, 'stop() ends the heartbeat');
    assert.equal(existsSync(lockPath(w)), false);
    // An older serve's lock (a bare pid, no start time) of this pid, silent for over 90 s: stale too.
    writeFileSync(lockPath(w), `${process.pid}\n`);
    beatAgo(LOCK_STALE_MS + 5_000);
    const q = await servePair(input(w));
    assert.equal(q.pair?.live, true, q.pair?.why ?? '');
    q.stop();
    assert.equal(lockHeartbeats(), beats);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('S1 (Railway): a lock held by a live other process degrades the pair (no exit), retried until it is free, then live', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1' });
  try {
    savedPair(w);
    w.hl.pos = toQty('-50');
    w.px.pos = toQty('50');
    mkdirSync(dirname(lockPath(w)), { recursive: true });
    // The parent of this test process: alive, and not this process (pair-mainnet --send in another terminal).
    writeFileSync(lockPath(w), lockText({ pid: process.ppid, startedMs: 1, id: 'pair-mainnet', boot: THIS_PROCESS.boot }));
    const events: StreamEvent[] = [];
    const health = healthOf();
    const p = await servePair(input(w, { publish: (e) => events.push(e), health: health.hook }));
    assert.match(p.unconfirmed!() ?? '', new RegExp(`^legs unknown, start not confirmed: the trader lock is not held: another process \\(pid ${process.ppid}\\) trades this desk`));
    assert.equal(p.pair === null, true, 'nothing adopted');
    assert.match(p.hands!.blocked() ?? '', /^legs unknown, start not confirmed/);
    assert.deepEqual(health.now(), ['hyperliquid ok', 'near ok', 'phoenix ok'], 'no venue is to blame');
    assert.match(startJournal(events)[0] ?? '', /^error: pair start not confirmed: the trader lock is not held: another process/);
    assert.equal(parseLockText(readFileSync(lockPath(w), 'utf8'))?.id, 'pair-mainnet', 'the other process\'s lock is left alone');
    assert.equal(await p.retryStart!(), null, 'still held');
    // The other process ends and lets its lock go: the next try takes it and the pair goes live.
    rmSync(lockPath(w));
    assert.match(await p.retryStart!() ?? '', /^pair start confirmed after 2 failed attempt\(s\).*XLM trades$/);
    assert.equal(p.pair?.live, true);
    p.stop();
    assert.equal(existsSync(lockPath(w)), false);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('S2: while the start is not confirmed, the monitor says "pair unprotected" every 30 min, journaled at most hourly; nothing once confirmed', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1' });
  try {
    savedPair(w);
    w.hl.pos = toQty('-50');
    w.px.pos = toQty('50');
    w.px.snap = { slot: 100, pos: 0n };
    w.px.chainSlot = 120;
    let now = Date.UTC(2026, 10, 4, 12, 0, 0);
    const start = now;
    const events: StreamEvent[] = [];
    const p = await servePair(input(w, { publish: (e) => events.push(e), clock: { now: () => now } }));
    const unprotected = () => startJournal(events).filter((l) => l.startsWith('error: pair unprotected'));
    assert.equal(startJournal(events).length, 1, 'the start said it once');
    now += 30 * 60_000;
    const line = p.monitor!();
    assert.match(line ?? '', new RegExp(`^pair unprotected: legs unknown since ${new Date(start).toISOString()}, 1 try \\(the legs could not be read twice alike .*\\); no trader, ADL watch or rescue reduce acts on a pair that may be open`));
    assert.equal(unprotected().length, 0, 'under an hour since the start\'s entry: the log line only');
    assert.equal(await p.retryStart!(), null);
    now += 30 * 60_000;
    assert.match(p.monitor!() ?? '', /, 2 tries \(/);
    assert.equal(unprotected().length, 1, 'an hour on: journaled again');
    assert.match(unprotected()[0]!, /legs unknown since 2026-11-04T12:00:00\.000Z, 2 tries/);
    now += 30 * 60_000;
    p.monitor!();
    assert.equal(unprotected().length, 1, 'the next half hour: the log line only');
    now += 30 * 60_000;
    p.monitor!();
    assert.equal(unprotected().length, 2);
    w.px.snap = { slot: 121, pos: toQty('50') };
    assert.match(await p.retryStart!() ?? '', /^pair start confirmed/);
    assert.equal(p.monitor!(), null, 'the legs are known: nothing to say');
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('S1: getSlot failing at start: Phoenix down, alert only, then live when the chain answers', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    open(w);
    w.px.syncFails = 'solana getSlot: fetch failed';
    const health = healthOf();
    const p = await servePair(input(w, { health: health.hook }));
    assert.equal(p.pair === null, true);
    assert.match(p.unconfirmed!() ?? '', /phoenix XLM: the chain's confirmed slot was not read \(solana getSlot: fetch failed\), so no snapshot can be proven current/);
    assert.match(health.now()[2]!, /^phoenix down: .*getSlot: fetch failed/);
    assert.equal(w.signed, 1, 'the signing side is loaded once');
    w.px.syncFails = null;
    assert.match(await p.retryStart!() ?? '', /XLM trades$/);
    assert.equal(w.signed, 1);
    assert.deepEqual(p.pair!.legs.map((l) => p.pair!.trader.baseline(l)), [toQty('-50'), toQty('50')]);
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('S1: Hyperliquid info and NEAR RPC failing at start degrade too; a configuration error still stops the start', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    open(w);
    w.hlHeldFails = 'hyperliquid /info clearinghouseState: HTTP 502';
    const health = healthOf();
    const p = await servePair(input(w, { health: health.hook }));
    assert.match(p.unconfirmed!() ?? '', /hyperliquid: hyperliquid \/info clearinghouseState: HTTP 502$/);
    assert.deepEqual(health.now().map((h) => h.replace(/: .*/, '')), ['hyperliquid down', 'near ok', 'phoenix ok']);
    w.hlHeldFails = null;
    w.signingFails = new Error('near rpc: 503 Service Unavailable');
    assert.equal(await p.retryStart!(), null);
    assert.match(p.unconfirmed!() ?? '', /the signing contract client: near rpc: 503 Service Unavailable$/);
    assert.deepEqual(health.now().map((h) => h.replace(/: .*/, '')), ['hyperliquid ok', 'near down', 'phoenix ok']);
    // A contract on another network found on a retry: not tried again, the lock goes.
    w.signingFails = new ConfigError('gimbal-test.near is a testnet contract (config().network), but the engine runs on mainnet; not starting');
    assert.equal(await p.retryStart!(), null);
    assert.match(p.unconfirmed!() ?? '', /a configuration error: fix it and restart serve; not tried again/);
    assert.equal(existsSync(lockPath(w)), false);
    w.signingFails = null;                         // even if the next read would pass: refused stays refused
    assert.equal(await p.retryStart!(), null);
    assert.equal(p.pair, null, 'still nothing adopted');
    assert.match(p.unconfirmed!() ?? '', /not tried again/);
    p.stop();
    // The same error at the first attempt stops serve (exit 2): no retry fixes a configuration.
    w.signingFails = new ConfigError('GIMBAL_TRADE=1 needs GIMBAL_CONTRACT_ID, DESK_ID and the operator key');
    await assert.rejects(servePair(input(w)), /GIMBAL_TRADE=1 needs GIMBAL_CONTRACT_ID, DESK_ID and the operator key/);
    assert.equal(existsSync(lockPath(w)), false);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('S4: an open that dies after an order was signed but before any result is recorded is reported sent, not "not done"', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    const p = await servePair(input(w));
    const hands = p.hands!;
    // The XLM pair exists already (opened and closed): the slot, the epoch and the held symbol do not move below.
    assert.equal((await hands.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'strategy: enter' })).ok, true);
    assert.equal((await hands.close({ reason: 'strategy: exit' })).ok, true);
    const before = w.hl.orders.length;
    w.throwAfterOrder = true;
    const r = await hands.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'strategy: enter' });
    assert.equal(w.hl.orders.length - before, 1, 'one order went out');
    assert.equal(r.ok, false);
    assert.equal(r.sent, true);
    assert.match(r.reason, /^stopped with orders out: the open died before its result was recorded/);
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('the open\'s scope: during the loop\'s open, an order that could grow a position from anything but that open is refused', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    const p = await servePair(input(w));
    const hands = p.hands!;
    // Hold the open at its Phoenix order, after the Hyperliquid leg went out.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let reached: () => void = () => {};
    const atPhoenix = new Promise<void>((r) => {
      reached = r;
    });
    w.px.hold = async () => {
      reached();
      await held;
    };
    const opening = hands.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'strategy: enter' });
    await atPhoenix;
    assert.equal(p.pair!.opening, true, 'the open runs');
    // A watch check, a protection or anything else meanwhile: not part of the open, refused before signing.
    const outside = await p.pair!.legs[0]!.order('SELL', toQty('1'), false, 'test: outside the open');
    assert.equal(outside.kind, 'failed');
    assert.match(String((outside as { error: Error }).error.message), /reduce-only orders only, outside the strategy loop's open/);
    // Reduce-only still goes out.
    w.px.hold = null;
    release();
    const r = await opening;
    assert.equal(r.ok, true, r.reason);
    assert.equal(w.hl.orders.filter((o) => !o.reduceOnly).length, 1, 'only the open\'s own order grew Hyperliquid');
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('canOpen (the scanner\'s oracleRefreshAtOpen): false before the start is confirmed, true once live and during the loop\'s own open, false after stop()', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1' });
  try {
    savedPair(w);
    w.hl.pos = toQty('-50');
    w.px.pos = toQty('50');
    w.px.snap = { slot: 100, pos: 0n };
    w.px.chainSlot = 120;
    const p = await servePair(input(w));
    assert.notEqual(p.hands, undefined, 'the hands exist before the start is confirmed');
    assert.equal(p.hands!.canOpen(), false);
    assert.equal(pairRefreshesAtOpen(p), false);
    w.px.snap = { slot: 121, pos: toQty('50') };
    assert.match(await p.retryStart!() ?? '', /^pair start confirmed/);
    assert.equal(pairRefreshesAtOpen(p), true);
    // The loop's own open in flight: blocked() refuses a second act, the scan still sees a pair that opens.
    assert.equal((await p.hands!.close({ reason: 'strategy: exit' })).ok, true);
    let release!: () => void;
    w.hl.hold = () => new Promise<void>((r) => {
      release = r;
    });
    const opening = p.hands!.open({ symbol: 'XLM', legUsd: 10, leverage: 1.5, reason: 'strategy: enter' });
    for (let i = 0; i < 50 && w.hl.orders.length === 0 && p.hands!.blocked() === null; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(p.hands!.blocked(), 'an open or close of the strategy loop is running');
    assert.equal(pairRefreshesAtOpen(p), true);
    while (release === undefined) await new Promise((r) => setTimeout(r, 5));
    w.hl.hold = null;
    release();
    assert.equal((await opening).ok, true);
    p.stop();
    assert.equal(pairRefreshesAtOpen(p), false, 'stopped: nothing opens');
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
  // Alert only (no GIMBAL_TRADE): no hands, the contract's verdict stands.
  const a = world();
  try {
    const p = await servePair(input(a));
    assert.equal(p.hands, undefined);
    assert.equal(pairRefreshesAtOpen(p), false);
    assert.equal(pairRefreshesAtOpen(null), false);
    p.stop();
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
});

test('prepareOpen: a refresh_prices the RPC never took (an error before the chain) is not ok and not paid: no hold, not counted', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    const p = await servePair(input(w));
    w.refreshFails = new Error('near rpc: HTTP 503');
    const down = await p.hands!.prepareOpen({ symbol: 'XLM' });
    assert.deepEqual([down.ok, down.refreshed], [false, undefined]);
    assert.equal(down.reason, 'the stored XLM price (missing) could not be refreshed: near rpc: HTTP 503');
    assert.equal(w.refreshes, 1);
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('prepareOpen (a rotate\'s first step): a missing price is refreshed, a failed refresh is not ok and paid; no refresh past the cap or for a symbol the oracle cannot price', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    const p = await servePair(input(w));
    const hands = p.hands!;
    // The contract stores nothing and refresh_prices stores nothing either: the refresh is paid and fails.
    const failed = await hands.prepareOpen({ symbol: 'XLM' });
    assert.equal(failed.ok, false);
    assert.equal(failed.refreshed, true);
    assert.match(failed.reason, /^the stored XLM price \(missing\) could not be refreshed: after refresh_prices the stored XLM price is missing/);
    assert.equal(w.refreshes, 1);
    // The day's cap: refused, nothing sent.
    const capped = await hands.prepareOpen({ symbol: 'XLM', noRefresh: 'the day\'s 12 are used' });
    assert.deepEqual([capped.ok, capped.refreshed, capped.reason], [false, undefined, 'the stored XLM price is missing and needs refresh_prices: the day\'s 12 are used']);
    // kPEPE is not one of the contract's oracle assets: refused, nothing sent.
    const pepe = await hands.prepareOpen({ symbol: 'kPEPE' });
    assert.equal(pepe.ok, false);
    assert.match(pepe.reason, /refresh_prices cannot refresh it \(kPEPE is not one of the contract's oracle assets\)/);
    assert.equal(w.refreshes, 1);
    // A fresh price: ok, nothing sent.
    w.stored = { asset: 'XLM', price_e8: '25000000', at_ms: Date.now() - 610_000 };
    const fresh = await hands.prepareOpen({ symbol: 'XLM' });
    assert.deepEqual([fresh.ok, fresh.refreshed], [true, undefined]);
    assert.equal(w.refreshes, 1);
    p.stop();
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});
