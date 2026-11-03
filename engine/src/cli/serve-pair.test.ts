// servePair itself, with the venues, the contract and the legs stubbed: when it trades (GIMBAL_TRADE, the worktree,
// the lock, --once, the start plan, resting orders), the start lines, panic_close's cancel of resting orders, two
// serves at once, and the pair symbol as the policy spells it.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { VenueId } from '@gimbal/shared';
import type { NearContractClient } from '../contract/near-client.ts';
import type { Relayer } from '../relayer/relayer.ts';
import type { LegOutcome, LegSide, PendingMakerOrder, TradeLeg } from '../trade/legs.ts';
import { toQty } from '../trade/lots.ts';
import { newAdlState } from '../risk/adl.ts';
import { TRADER_STATE_VERSION, TraderStateStore, traderLockPath, traderStateFile } from '../trade/trader-state.ts';
import type { ContractSide } from './serve-contract.ts';
import type { ServePairDeps, ServePairInput } from './serve-pair.ts';
import { liveLines, servePair } from './serve-pair.ts';

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
  constructor(venue: VenueId, symbol: string) {
    this.venue = venue;
    this.symbol = symbol;
  }
  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return toQty('1000');
  }
  async position(): Promise<bigint> {
    return this.pos;
  }
  async order(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
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
}

function world(symbol = 'XLM', env: Record<string, string> = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-serve-pair-'));
  return {
    dir, env: { LOCALAPPDATA: dir, XDG_STATE_HOME: dir, ...env },
    hl: new Leg('hyperliquid', symbol), px: new Leg('phoenix', symbol), openOrders: [], signed: 0, cancels: [], lines: [],
  };
}

function side(): ContractSide {
  const policy = {
    hl_assets: [{ symbol: 'XLM', index: 7, sz_decimals: 0 }, { symbol: 'kPEPE', index: 9, sz_decimals: 0 }, { symbol: 'ETH', index: 1, sz_decimals: 4 }],
    phoenix_markets: [{ symbol: 'XLM' }, { symbol: 'kPEPE' }],
    oracle_max_age_s: 900, price_band_bps: 100, unpriced: [], max_notional_usd: 20, unpriced_max_notional_usd: 10,
  };
  const client = { contractId: CONTRACT, prices: async () => [], refreshPrices: async () => [] } as unknown as NearContractClient;
  return { client, desk: { policy, evm_address: EVM, solana: { authority: 'Auth111' } }, policy, prices: {} } as unknown as ContractSide;
}

function input(w: World, extra: Partial<ServePairInput> = {}): ServePairInput {
  const deps: ServePairDeps = {
    hlHeld: async () => (w.hl.pos === 0n ? [] : [w.hl.symbol]),
    phoenixHeld: async () => (w.px.pos === 0n ? [] : [w.px.symbol]),
    openOrders: async () => w.openOrders,
    signing: async () => {
      w.signed++;
      const relayer = {
        hlCancel: async (asset: number, oid: number) => {
          w.cancels.push({ asset, oid });
          return { kind: 'cancel', statuses: ['success'], oid: null, filled: null, resting: false, fills: [], tx: [{ chain: 'near', id: `c${oid}`, url: '' }], confirmed: true, expiresAfter: null };
        },
      } as unknown as Relayer;
      return { client: side().client, relayer };
    },
    buildLegs: async () => ({ hl: w.hl, phoenix: w.px, priced: false, mismatches: [] }),
    close: () => {},
  };
  return {
    mode: 'mainnet', env: (n) => w.env[n], side: side(), deskId: DESK, clock: { now: () => Date.now() }, log: (l) => w.lines.push(l), publish: () => {},
    stateDir: w.dir, linkedWorktree: false, sleep: async () => {}, deps, ...extra,
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
    assert.equal(readFileSync(lockPath(w), 'utf8').trim(), String(process.pid));
    const out = lines(p);
    assert.ok(out.some((l) => /^live {6}TRADES \(GIMBAL_TRADE=1\).*panic_close -> resting Hyperliquid orders cancelled, both legs closed; ADL -> pair paused, both legs unwound \(3 of 3 attempts left\)/.test(l)), out.join('\n'));
    // Two serves at once: the second (a restart with FRESH left in the env, or a second terminal) cannot take the lock.
    await assert.rejects(servePair(input(w)), /another process \(pid \d+\) trades this desk.*pair-mainnet --send holds the same lock/);
    // FRESH left in the env: after a clean save the next start re-adopts (nothing a restart must keep), not refused.
    p.stop();
    assert.equal(existsSync(lockPath(w)), false);
    const again = await servePair(input(w));
    assert.equal(again.pair?.live, true);
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

test('a resting order on the pair\'s coin at start: alert only with a line naming it; unreadable open orders too', async () => {
  const w = world('XLM', { GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}` });
  try {
    open(w);
    w.openOrders = [{ coin: 'XLM', side: 'B', sz: '10', oid: 42 }];
    const p = await servePair(input(w));
    assert.equal(p.pair?.live, false);
    assert.match(p.pair?.why ?? '', /Hyperliquid has 1 resting XLM order\(s\) \(BUY 10 \(oid 42\)\).*cancel it on Hyperliquid, reconcile both legs, then start serve again/);
    p.stop();
    w.openOrders = 'HTTP 500';
    const q = await servePair(input(w));
    assert.match(q.pair?.why ?? '', /the Hyperliquid open orders cannot be read/);
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
    w.openOrders = [{ coin: 'XLM', side: 'A', sz: '5', oid: 1 }, { coin: 'ETH', side: 'B', sz: '0.01', oid: 2 }, { coin: 'DOGE', side: 'B', sz: '1', oid: 3 }];
    const r = await p.cancelResting!();
    assert.equal(r.cancelled, 2);
    assert.deepEqual(w.cancels, [{ asset: 7, oid: 1 }, { asset: 1, oid: 2 }]);
    assert.deepEqual(r.tx.map((t) => t.id), ['c1', 'c2']);
    assert.match(r.notes.join('; '), /DOGE BUY 1 \(oid 3\): not a policy coin, not cancelled here.*Phoenix: the leg sends IOCs only/);
    w.openOrders = { error: 'down' };
    await assert.rejects(p.cancelResting!(), /open orders cannot be read/);
    p.stop();
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
      inFlight: [{ index: 0, venue: 'hyperliquid', side: 'BUY', size: '10', reduceOnly: true, reason: 'rescue r1: reduce', at: 5, op: 'close' }], adl: newAdlState(),
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
