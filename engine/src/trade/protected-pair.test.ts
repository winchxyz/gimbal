// serve's pair: the guarded legs (alert only, reduce-only only, the state saved before an order), ProtectedPair's
// close, the start plan from the venues and the saved file, the trader state file (identity, atomic save, a missing
// file is not a fresh start), the per-desk lock, the PairTrader's adopt/export/import, and the 25 % monitor.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DeskState, Leg as DeskLeg, VenueId } from '@gimbal/shared';
import { newAdlState } from '../risk/adl.ts';
import { ALERT_DISTANCE_PCT, LiquidationAlert, MONITOR_EVERY_MS, legsUnder, monitorLines } from '../risk/monitor.ts';
import type { LegOutcome, LegSide, TradeLeg } from './legs.ts';
import { toQty } from './lots.ts';
import { PairTrader } from './pair.ts';
import type { PairTraderState } from './pair.ts';
import { GuardedLeg, ProtectedPair, startPlan } from './protected-pair.ts';
import type { InFlightOrder, LoadedTraderState, TraderFileState } from './trader-state.ts';
import { TRADER_STATE_VERSION, TraderStateStore, acquireTraderLock, lockHolder, traderStateFile } from './trader-state.ts';

class Leg implements TradeLeg {
  readonly venue: VenueId;
  readonly symbol = 'XLM';
  readonly lot = toQty('1');
  readonly replayable = false;
  pos = 0n;
  orders: { side: LegSide; size: bigint; reduceOnly: boolean }[] = [];
  constructor(venue: VenueId) {
    this.venue = venue;
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
    return { kind: 'filled', filled: size, avgPx: 0.25, ref: { venue: this.venue, side, size: String(size), reduceOnly, orderId: `o${this.orders.length}`, clientId: null, tx: [], sentAt: 1 } };
  }
}

const ID = { contractId: 'gimbal-test.near', deskId: 'canary', evm: `0x${'ab'.repeat(20)}` };
const tempDir = () => mkdtempSync(join(tmpdir(), 'gimbal-trader-'));

function fileState(trader: PairTraderState | null, extra: Partial<TraderFileState> = {}): TraderFileState {
  return { version: TRADER_STATE_VERSION, savedAt: 1, symbol: 'XLM', trader, pendingMaker: [], inFlight: null, adl: newAdlState(), ...extra };
}

function traderState(baselines: [bigint | null, bigint | null], extra: Partial<PairTraderState> = {}): PairTraderState {
  return { intents: [baselines[0] ?? 0n, baselines[1] ?? 0n], baselines, known: baselines, net: 0n, unhedged: null, unsettled: [], ...extra };
}

const loaded = (s: TraderFileState): LoadedTraderState => ({ kind: 'loaded', state: { ...s, identity: ID } });
const plan = (read: [bigint, bigint], saved: LoadedTraderState, fresh = false) => startPlan({ symbol: 'XLM', read, saved, fresh, path: 'trader.json' });

// ---- the guarded legs ----

function guarded(live: boolean, beforeSign: (o: InFlightOrder) => void = () => {}) {
  const inner = new Leg('hyperliquid');
  const marks: string[] = [];
  const leg = new GuardedLeg(inner, { index: 0, live: () => live, beforeSign: (o) => { marks.push(`before ${o.side} ${o.size} ${o.reduceOnly}`); beforeSign(o); }, afterSign: () => marks.push('after'), now: () => 7 });
  return { inner, leg, marks };
}

test('a guarded leg refuses everything when alert only, and anything not reduce-only: nothing reaches the venue', async () => {
  const off = guarded(false);
  const a = await off.leg.order('BUY', toQty('5'), true, 'close');
  assert.equal(a.kind, 'failed');
  assert.match(a.kind === 'failed' ? a.error.message : '', /alert only: this engine does not trade; nothing signed/);
  const on = guarded(true);
  const b = await on.leg.order('SELL', toQty('5'), false, 'grow');
  assert.match(b.kind === 'failed' ? b.error.message : '', /reduce-only orders only/);
  assert.equal(off.inner.orders.length + on.inner.orders.length, 0);
  assert.deepEqual(on.marks, []);
});

test('a guarded leg saves the order in flight before it is sent, and refuses it when the save fails', async () => {
  const ok = guarded(true);
  const r = await ok.leg.order('BUY', toQty('5'), true, 'close');
  assert.equal(r.kind, 'filled');
  assert.deepEqual(ok.marks, ['before BUY 5 true', 'after']);
  const bad = guarded(true, () => { throw new Error('disk full'); });
  const s = await bad.leg.order('BUY', toQty('5'), true, 'close');
  assert.match(s.kind === 'failed' ? s.error.message : '', /could not be saved before the order \(disk full\); nothing signed/);
  assert.equal(bad.inner.orders.length, 0);
});

// ---- ProtectedPair ----

function pair(live: boolean) {
  const hl = new Leg('hyperliquid');
  const px = new Leg('phoenix');
  const legs = [hl, px].map((l, i) => new GuardedLeg(l, { index: i as 0 | 1, live: () => live, beforeSign: () => {}, afterSign: () => {} })) as [GuardedLeg, GuardedLeg];
  const trader = new PairTrader({ legs, priceBandBps: 100, unsettledPollMs: null });
  const events: string[] = [];
  const p = new ProtectedPair({
    trader, symbol: 'XLM', live, why: live ? null : 'GIMBAL_TRADE is not 1', save: () => events.push('save'),
    freshPrice: async () => { events.push('price'); }, onOpen: (lines) => events.push(...lines),
  });
  return { hl, px, trader, p, events };
}

test('ProtectedPair: a close refreshes the price, is reduce-only even when asked otherwise, and saves after', async () => {
  const s = pair(true);
  s.hl.pos = toQty('-50');
  s.px.pos = toQty('50');
  s.p.adopt([toQty('-50'), toQty('50')]);
  s.events.length = 0;
  const r = await s.p.close({ reason: 'panic_close', targets: [0n, 0n], reduceOnly: false });
  assert.equal(r.status, 'closed');
  assert.deepEqual([s.hl.pos, s.px.pos], [0n, 0n]);
  assert.ok([...s.hl.orders, ...s.px.orders].every((o) => o.reduceOnly));
  assert.equal(s.events[0], 'price');
  assert.equal(s.events.at(-1), 'save');
  assert.deepEqual(s.p.openLines(), []);
});

test('ProtectedPair alert only: a close throws before anything is signed, and saves nothing', async () => {
  const s = pair(false);
  s.p.adopt([toQty('-50'), toQty('50')]);
  await assert.rejects(s.p.close({ reason: 'panic_close', targets: [0n, 0n] }), /^Error: alert only \(GIMBAL_TRADE is not 1\): nothing is signed/);
  assert.equal(s.hl.orders.length + s.px.orders.length, 0);
  assert.deepEqual(s.events, []);
});

// ---- PairTrader adopt / export / import ----

test('PairTrader.adopt sets intents and baselines; unhedged when the legs do not offset; export and import round-trip', () => {
  const s = pair(true);
  s.trader.adopt([toQty('-50'), toQty('50')]);
  assert.equal(s.trader.unhedged, null);
  assert.equal(s.trader.baseline(s.trader.legs[0]), toQty('-50'));
  s.trader.adopt([toQty('-50'), toQty('40')]);
  assert.match(s.trader.unhedged ?? '', /^unhedged: adopted/);
  const saved = s.trader.exportState();
  const t = pair(true);
  t.trader.importState(saved);
  assert.deepEqual(t.trader.exportState(), saved);
  assert.equal(t.trader.intent(t.trader.legs[1]), toQty('40'));
});

// ---- the start plan ----

test('start: a missing state file is not a fresh start (alert only), GIMBAL_TRADER_FRESH=1 is', () => {
  const none = plan([toQty('-50'), toQty('50')], { kind: 'none' });
  assert.equal(none.stateOk, false);
  assert.match(none.why ?? '', /a missing file is not a fresh start/);
  const fresh = plan([toQty('-50'), toQty('50')], { kind: 'none' }, true);
  assert.equal(fresh.stateOk, true);
  assert.deepEqual(fresh.adopt, [toQty('-50'), toQty('50')]);
  const bad = plan([0n, 0n], { kind: 'unusable', problem: 'trader.json belongs to another desk' });
  assert.equal(bad.stateOk, false);
});

test('(B) start: venues smaller than the saved baselines restore the baselines, so the ADL watch sees the shrink', () => {
  const p = plan([toQty('-30'), toQty('50')], loaded(fileState(traderState([toQty('-50'), toQty('50')]))));
  assert.equal(p.stateOk, true);
  assert.equal(p.adopt, null);
  assert.deepEqual(p.restore?.baselines, [toQty('-50'), toQty('50')]);
});

test('start: as saved restores; a new pair since a flat save gets a new budget; flat legs end an event', () => {
  const same = plan([toQty('-50'), toQty('50')], loaded(fileState(traderState([toQty('-50'), toQty('50')]))));
  assert.notEqual(same.restore, null);
  const spent = { attemptsLeft: 0, paused: 'ADL earlier', event: null };
  const opened = plan([toQty('-50'), toQty('50')], loaded(fileState(traderState([0n, 0n]), { adl: spent })));
  assert.deepEqual(opened.adopt, [toQty('-50'), toQty('50')]);
  assert.equal(opened.adl.attemptsLeft, 3);
  assert.equal(opened.adl.paused, null);
  const event = { at: 1, reference: [toQty('-50'), toQty('50')] as [bigint, bigint], seen: [toQty('-30'), toQty('50')] as [bigint, bigint], attempts: 1, nextAt: 2, alerted: true };
  const ended = plan([0n, 0n], loaded(fileState(traderState([0n, toQty('50')]), { adl: { attemptsLeft: 2, paused: 'ADL', event } })));
  assert.notEqual(ended.restore, null, 'an event in progress restores: the watch itself ends it on flat legs, journaled');
  const inFlight = plan([toQty('-50'), toQty('50')], loaded(fileState(traderState([toQty('-50'), toQty('50')]), { inFlight: { index: 0, venue: 'hyperliquid', side: 'BUY', size: '10', reduceOnly: true, reason: 'reduce', at: 0 } })));
  assert.match(inFlight.open[0] ?? '', /^open: .*hyperliquid BUY 10 XLM reduce-only \(reduce\) was being sent/);
  const other = plan([toQty('-50'), toQty('50')], loaded(fileState(traderState([toQty('-10'), toQty('10')]), { symbol: 'ETH' })));
  assert.equal(other.stateOk, false, 'another symbol with legs open: reconcile by hand');
});

// ---- the state file and the lock ----

test('the trader state file: round trip, identity in the name and checked, no temp left, a failed rename keeps the old file', () => {
  const dir = tempDir();
  try {
    const path = traderStateFile(dir, 'mainnet', ID);
    assert.match(path, /trader-mainnet-gimbal-test\.near-canary-0xabab/);
    const store = new TraderStateStore(path, ID);
    assert.deepEqual(store.load(), { kind: 'none' });
    const s = fileState(traderState([toQty('-50'), toQty('50')]), { adl: { attemptsLeft: 2, paused: 'p', event: null } });
    store.save(s);
    const back = store.load();
    assert.equal(back.kind, 'loaded');
    if (back.kind === 'loaded') {
      assert.deepEqual(back.state.trader, s.trader);
      assert.deepEqual(back.state.adl, s.adl);
    }
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
    const other = new TraderStateStore(path, { ...ID, deskId: 'other' });
    const refused = other.load();
    assert.equal(refused.kind, 'unusable');
    const failing = new TraderStateStore(path, ID, { rename: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }, renameTries: 2 });
    assert.throws(() => failing.save(fileState(null)), /busy/);
    const still = store.load();
    assert.ok(still.kind === 'loaded' && still.state.trader !== null, 'the old file is kept');
    writeFileSync(path, '{"version": 1');
    assert.equal(store.load().kind, 'unusable', 'a broken file is not a fresh start either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the per-desk lock: one holder; a stale lock is taken over; lockHolder names a live holder only', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'locks', 'trader.lock');
    assert.equal(lockHolder(path), null);
    const lock = acquireTraderLock(path, { onExit: false });
    assert.equal(lockHolder(path), process.pid);
    assert.throws(() => acquireTraderLock(path, { onExit: false }), /one trader per desk/);
    lock.release();
    assert.equal(existsSync(path), false);
    writeFileSync(path, '999999999\n');
    assert.equal(lockHolder(path), null, 'its process is gone');
    const again = acquireTraderLock(path, { onExit: false });
    assert.equal(readFileSync(path, 'utf8').trim(), String(process.pid));
    again.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the monitor ----

function deskLeg(venue: VenueId, side: 'long' | 'short', distance: number | null): DeskLeg {
  return { venue, symbol: 'XLM', side, size: 50, lotSize: 1, entry: 0.25, mark: 0.25, liqPx: 0.4, marginUsd: 6, marginRatio: 0.2, distanceToLiqPct: distance, fundingEarnedUsd: 0, unsettledFundingUsd: 0, feesUsd: 0, unpriced: false };
}

function desk(legs: DeskLeg[]): DeskState {
  return { deskId: 'canary', owner: 'owner.near', contract: 'gimbal-test.near', mode: 'mainnet', legs, netDelta: 0, equityUsd: 24, reserveUsd: 1, pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 }, health: 'level', paused: null, rescueFailure: null, updatedAt: 0 };
}

test('the monitor: a line per leg and the net; the 25 % alert on crossing, again every 30 min, and the way back', () => {
  const safe = desk([deskLeg('hyperliquid', 'short', 60), deskLeg('phoenix', 'long', 70)]);
  assert.equal(monitorLines(safe).length, 3);
  assert.match(monitorLines(safe)[2]!, /net delta 0 \(hedged\)/);
  assert.match(monitorLines(desk([]))[0]!, /no open legs/);
  const alert = new LiquidationAlert();
  assert.deepEqual(alert.observe(safe, 0), { journal: [], console: [] });
  const close = desk([deskLeg('hyperliquid', 'short', 20), deskLeg('phoenix', 'long', 70)]);
  assert.equal(legsUnder(close).length, 1);
  const first = alert.observe(close, 1000);
  assert.equal(first.journal.length, 1);
  assert.equal(first.journal[0]!.kind, 'error');
  assert.match(first.console[0]!, new RegExp(`^ALERT .*hyperliquid XLM short .*20\\.00 % from liquidation.*under the ${ALERT_DISTANCE_PCT} % line$`));
  assert.equal(alert.observe(close, 2000).journal.length, 0, 'not on every read');
  assert.match(alert.observe(close, 1000 + MONITOR_EVERY_MS).journal[0]!.summary, /\(still\)$/);
  const back = alert.observe(desk([deskLeg('hyperliquid', 'short', 25.5), deskLeg('phoenix', 'long', 70)]), 3000 + MONITOR_EVERY_MS);
  assert.deepEqual(back, { journal: [], console: [] }, 'inside the 1 point hysteresis: still under');
  const above = alert.observe(safe, 4000 + MONITOR_EVERY_MS);
  assert.match(above.console[0]!, /back above the 25 % liquidation line/);
  assert.equal(above.journal.length, 0);
});
