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
import { ALERT_DISTANCE_PCT, LiquidationAlert, MONITOR_EVERY_MS, isHedged, legsUnder, monitorLines } from '../risk/monitor.ts';
import { AdlWatch } from '../risk/adl.ts';
import type { LegOutcome, LegSide, TradeLeg } from './legs.ts';
import { qtyString, toQty } from './lots.ts';
import { PairTrader } from './pair.ts';
import type { PairTraderState } from './pair.ts';
import type { OutgoingOrder } from './protected-pair.ts';
import { GuardedLeg, InFlightBook, ProtectedPair, startPlan } from './protected-pair.ts';
import type { InFlightOrder, LoadedTraderState, TraderFileState } from './trader-state.ts';
import { TRADER_STATE_VERSION, TraderStateStore, acquireTraderLock, lockHolder, parseTraderState, traderStateFile, traderStateJson } from './trader-state.ts';

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
  return { version: TRADER_STATE_VERSION, savedAt: 1, symbol: 'XLM', trader, pendingMaker: [], inFlight: [], adl: newAdlState(), ...extra };
}

const FRESH = 'gimbal-test.near/canary';
const flight = (extra: Partial<InFlightOrder> = {}): InFlightOrder => ({ index: 0, venue: 'hyperliquid', side: 'BUY', size: '10', reduceOnly: true, reason: 'reduce', at: 0, op: 'close', ...extra });

function traderState(baselines: [bigint | null, bigint | null], extra: Partial<PairTraderState> = {}): PairTraderState {
  return { intents: [baselines[0] ?? 0n, baselines[1] ?? 0n], baselines, known: baselines, net: 0n, unhedged: null, unsettled: [], ...extra };
}

const loaded = (s: TraderFileState): LoadedTraderState => ({ kind: 'loaded', state: { ...s, identity: ID } });
const plan = (read: [bigint, bigint], saved: LoadedTraderState, fresh?: string) => startPlan({ symbol: 'XLM', read, saved, fresh, freshWant: FRESH, path: 'trader.json' });

// ---- the guarded legs ----

function guarded(live: boolean, beforeSign: (o: OutgoingOrder) => void = () => {}) {
  const inner = new Leg('hyperliquid');
  const marks: string[] = [];
  const leg = new GuardedLeg(inner, { index: 0, live: () => live, beforeSign: (o) => { marks.push(`before ${o.side} ${o.size} ${o.reduceOnly}`); beforeSign(o); }, now: () => 7 });
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
  assert.deepEqual(ok.marks, ['before BUY 5 true'], 'nothing is cleared when the order answers: only the recorded result does');
  const bad = guarded(true, () => { throw new Error('disk full'); });
  const s = await bad.leg.order('BUY', toQty('5'), true, 'close');
  assert.match(s.kind === 'failed' ? s.error.message : '', /could not be saved before the order \(disk full\); nothing signed/);
  assert.equal(bad.inner.orders.length, 0);
});

// ---- ProtectedPair ----

function pair(live: boolean, options: { restored?: InFlightOrder[]; adlHold?: string; hl?: TradeLeg; px?: TradeLeg } = {}) {
  const hl = new Leg('hyperliquid');
  const px = new Leg('phoenix');
  const book = new InFlightBook(options.restored ?? []);
  const events: string[] = [];
  /** What each save wrote: the book's orders and the trader's unsettled legs, as one file would hold them. */
  const saves: { inFlight: InFlightOrder[]; unsettled: number[] }[] = [];
  let trader: PairTrader | null = null;
  const save = () => {
    events.push('save');
    saves.push({ inFlight: book.orders, unsettled: trader?.exportState().unsettled.map((u) => u.index) ?? [] });
  };
  const inner = [options.hl ?? hl, options.px ?? px];
  const legs = inner.map((l, i) => new GuardedLeg(l, { index: i as 0 | 1, live: () => live, beforeSign: (o) => book.add(o, save) })) as [GuardedLeg, GuardedLeg];
  trader = new PairTrader({ legs, priceBandBps: 100, unsettledPollMs: null });
  const p = new ProtectedPair({
    trader, symbol: 'XLM', live, why: live ? null : 'GIMBAL_TRADE is not 1', save, inFlight: book, ...(options.adlHold === undefined ? {} : { adlHold: options.adlHold }),
    freshPrice: async () => { events.push('price'); }, onOpen: (lines) => events.push(...lines),
  });
  return { hl, px, trader, p, events, saves, book };
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

test('start: a missing state file is not a fresh start (alert only); GIMBAL_TRADER_FRESH=<contract>/<desk> is, any other value is ignored', () => {
  const none = plan([toQty('-50'), toQty('50')], { kind: 'none' });
  assert.equal(none.stateOk, false);
  assert.match(none.why ?? '', new RegExp(`a missing file is not a fresh start.*GIMBAL_TRADER_FRESH=${FRESH}`));
  const fresh = plan([toQty('-50'), toQty('50')], { kind: 'none' }, FRESH);
  assert.equal(fresh.stateOk, true);
  assert.deepEqual(fresh.adopt, [toQty('-50'), toQty('50')]);
  for (const value of ['1', 'gimbal-test.near/other', 'other.near/canary']) {
    const left = plan([toQty('-50'), toQty('50')], { kind: 'none' }, value);
    assert.equal(left.stateOk, false, `${value} is not this desk's fresh start`);
    assert.match(left.notes[0] ?? '', /is ignored: a fresh start names this contract and desk/);
  }
  const bad = plan([0n, 0n], { kind: 'unusable', problem: 'trader.json belongs to another desk' });
  assert.equal(bad.stateOk, false);
  assert.equal(plan([0n, 0n], { kind: 'unusable', problem: 'broken' }, FRESH).stateOk, true, 'an unusable file can be started over');
});

test('(4) GIMBAL_TRADER_FRESH is refused over a usable state with an ADL event, a spent budget, unsettled or in-flight orders', () => {
  const read: [bigint, bigint] = [toQty('-30'), toQty('50')];
  const base = traderState([toQty('-50'), toQty('50')]);
  const event = { at: 1, reference: [toQty('-50'), toQty('50')] as [bigint, bigint], seen: read, attempts: 1, nextAt: 2, alerted: false };
  const ref = { venue: 'hyperliquid' as const, side: 'BUY' as const, size: '10', reduceOnly: true, orderId: null, clientId: '0xab', tx: [], sentAt: 1 };
  const cases: [string, TraderFileState][] = [
    ['an ADL event in progress', fileState(base, { adl: { attemptsLeft: 2, paused: 'ADL', event } })],
    ['an ADL budget already spent in part', fileState(base, { adl: { attemptsLeft: 2, paused: null, event: null } })],
    ['leg\\(s\\) with an order that may still run', fileState(traderState([toQty('-50'), toQty('50')], { unsettled: [{ index: 0, refs: [ref], until: 10, from: toQty('-50'), unwind: null }] }))],
    ['order\\(s\\) in flight when the engine stopped', fileState(base, { inFlight: [flight()] })],
  ];
  for (const [what, state] of cases) {
    const p = plan(read, loaded(state), FRESH);
    assert.match(p.notes[0] ?? '', new RegExp(`GIMBAL_TRADER_FRESH is refused: trader.json holds .*${what}`));
    assert.equal(p.adopt, null, `${what}: the saved state is restored, not the venues adopted`);
    assert.deepEqual(p.restore?.baselines, [toQty('-50'), toQty('50')]);
  }
  const clean = plan(read, loaded(fileState(base)), FRESH);
  assert.deepEqual(clean.adopt, read, 'a usable state with nothing a restart must keep may be started over');
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
  const other = plan([toQty('-50'), toQty('50')], loaded(fileState(traderState([toQty('-10'), toQty('10')]), { symbol: 'ETH' })));
  assert.equal(other.stateOk, false, 'another symbol with legs open: reconcile by hand');
});

test('(3) start: orders saved in flight restore the baselines with the ADL hold; flat legs adopt flat and drop them', () => {
  const saved = loaded(fileState(traderState([toQty('-50'), toQty('50')]), { inFlight: [flight({ side: 'BUY', size: '20' })] }));
  const p = plan([toQty('-30'), toQty('50')], saved);
  assert.equal(p.stateOk, true);
  assert.deepEqual(p.restore?.baselines, [toQty('-50'), toQty('50')]);
  assert.equal(p.inFlight.length, 1);
  assert.match(p.adlHold ?? '', /1 order\(s\) were in flight when the engine stopped \(hyperliquid BUY 20\).*ADL only alerts until a close result or an adopt/);
  const same = plan([toQty('-50'), toQty('50')], saved);
  assert.notEqual(same.adlHold, null, 'as saved too: the order may still land');
  const flatNow = plan([0n, 0n], saved);
  assert.deepEqual([flatNow.adopt, flatNow.inFlight, flatNow.adlHold], [[0n, 0n], [], null], 'a reduce-only order cannot run on a flat leg');
  const s = pair(true, { restored: p.inFlight, adlHold: p.adlHold! });
  assert.match(s.p.openLines()[0] ?? '', /^open: {5}hyperliquid BUY 20 XLM reduce-only \(reduce\) was sent at .* and no saved result holds its outcome/);
});

test('(3) the ADL hold: a shrink while orders were in flight at the restart starts no event and trades nothing; a close result ends the hold', async () => {
  const s = pair(true, { restored: [flight({ side: 'BUY', size: '20' })], adlHold: 'orders were in flight' });
  s.trader.importState(traderState([toQty('-50'), toQty('50')]));
  s.hl.pos = toQty('-30');      // our own reduce of before the restart landed
  s.px.pos = toQty('50');
  const adl = new AdlWatch(s.p, { hold: () => s.p.adlHold, sleep: async () => {}, confirmMs: 0 });
  const r = await adl.check();
  assert.equal(r?.stage, 'alert');
  assert.equal(r?.ownerAlert, true);
  assert.match(r?.summary ?? '', /not taken as ADL \(orders were in flight\): no event, nothing traded/);
  assert.equal(adl.state.event, null);
  assert.equal(adl.state.attemptsLeft, 3);
  assert.equal(s.hl.orders.length + s.px.orders.length, 0);
  assert.equal(await adl.check(), null, 'reported once');
  // A close result sets the baselines: the hold ends and the restored orders leave the book.
  await s.p.close({ reason: 'rescue: reduce', targets: [toQty('-30'), toQty('30')] });
  assert.equal(s.p.adlHold, null);
  assert.deepEqual(s.book.orders, []);
  s.hl.pos = toQty('-10');      // now a real ADL
  const real = await adl.check();
  assert.notEqual(real?.stage, 'alert');
  assert.equal(adl.state.attemptsLeft, 2, 'an unwind attempt went out');
});

test('(1, 2) each leg has its own in-flight entry, and an order leaves the book only in the save that records its result', async () => {
  // Hyperliquid's IOC has no answer (outcome unknown, the leg unmoved), and answers only after Phoenix filled.
  let answer: () => void = () => {};
  const slow = new Leg('hyperliquid');
  slow.order = async (side, size, reduceOnly) => {
    slow.orders.push({ side, size, reduceOnly });
    await new Promise<void>((r) => { answer = r; });
    return { kind: 'unknown', error: new Error('MPC timeout'), ref: { venue: 'hyperliquid', side, size: qtyString(size), reduceOnly, orderId: null, clientId: '0xcl', tx: [], sentAt: 1 }, expiresAt: null };
  };
  const s = pair(true, { hl: slow });
  slow.pos = toQty('-50');
  s.px.pos = toQty('50');
  s.p.adopt([toQty('-50'), toQty('50')]);
  s.saves.length = 0;
  const closing = s.p.close({ reason: 'panic_close', targets: [0n, 0n] });
  for (let i = 0; i < 20 && s.px.orders.length === 0; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // Phoenix answered; Hyperliquid has not: both entries are still in the book, one per leg.
  assert.deepEqual(s.book.orders.map((o) => [o.index, o.venue]).sort(), [[0, 'hyperliquid'], [1, 'phoenix']]);
  answer();
  const r = await closing;
  assert.notEqual(r.status, 'closed');
  assert.deepEqual(s.book.orders, [], 'the result is recorded: the book is empty');
  const last = s.saves.at(-1)!;
  assert.deepEqual([last.inFlight, last.unsettled], [[], [0]], 'the last save holds the unsettled Hyperliquid order instead');
  // At no save was the Hyperliquid order named neither in flight nor unsettled (a crash at any point keeps it).
  const after = s.saves.findIndex((x) => x.inFlight.some((o) => o.index === 0));
  assert.ok(after >= 0);
  for (const x of s.saves.slice(after)) assert.ok(x.inFlight.some((o) => o.index === 0) || x.unsettled.includes(0), JSON.stringify(x));
  assert.match(s.p.openLines().join('\n'), /hyperliquid BUY 50 reduce-only \(0xcl\) has no answer/);
});

test('a close that throws keeps its orders in the book until a later close result', async () => {
  const s = pair(true);
  s.hl.pos = toQty('-50');
  s.px.pos = toQty('50');
  s.p.adopt([toQty('-50'), toQty('50')]);
  const send = s.px.order.bind(s.px);
  // The Phoenix order throws after it went out: trader.close throws before it records a result.
  s.px.order = async (side, size, reduceOnly) => {
    s.px.orders.push({ side, size, reduceOnly });
    throw new Error('socket hang up');
  };
  await assert.rejects(s.p.close({ reason: 'panic_close', targets: [0n, 0n] }), /socket hang up/);
  assert.deepEqual(s.book.orders.map((o) => [o.venue, o.op]).sort(), [['hyperliquid', 'close'], ['phoenix', 'close']], 'the orders of the close that threw stay in the book');
  assert.equal(s.saves.at(-1)!.inFlight.length, 2, 'and on disk');
  assert.match(s.p.openLines().join('\n'), /phoenix SELL 50 XLM reduce-only \(panic_close\) was sent at .* no saved result holds its outcome/);
  s.px.order = send;
  await s.p.close({ reason: 'panic_close (retry)', targets: [0n, 0n] });
  assert.deepEqual(s.book.orders, []);
  assert.deepEqual([s.hl.pos, s.px.pos], [0n, 0n]);
});

test('a close clamps stale targets between 0 and the position read when it runs: no leg grows or crosses zero', async () => {
  const s = pair(true);
  s.hl.pos = toQty('-30');
  s.px.pos = toQty('30');
  s.p.adopt([toQty('-30'), toQty('30')]);
  const r = await s.p.close({ reason: 'rescue: reduce (computed at -40/40)', targets: [toQty('-40'), toQty('20')] });
  assert.deepEqual(s.hl.orders, [], 'hyperliquid -30 is not grown to -40');
  assert.deepEqual(s.px.orders.map((o) => [o.side, o.size]), [['SELL', toQty('10')]]);
  assert.match(r.notes.join(' '), /hyperliquid target -40 is past its position -30 read now \(toward zero only\): -30/);
  const t = pair(true);
  t.hl.pos = toQty('-30');
  t.px.pos = toQty('30');
  t.p.adopt([toQty('-30'), toQty('30')]);
  await t.p.close({ reason: 'stale', targets: [toQty('10'), toQty('-10')] });
  assert.deepEqual([t.hl.pos, t.px.pos], [0n, 0n], 'a target past zero stops at zero');
});

test('ProtectedPair.whenIdle waits for a close in flight, bounded', async () => {
  let answer: () => void = () => {};
  const slow = new Leg('hyperliquid');
  slow.order = async (side, size, reduceOnly) => {
    await new Promise<void>((r) => { answer = r; });
    slow.pos += side === 'BUY' ? size : -size;
    return { kind: 'filled', filled: size, avgPx: 0.25, ref: { venue: 'hyperliquid', side, size: String(size), reduceOnly, orderId: 'o', clientId: null, tx: [], sentAt: 1 } };
  };
  const s = pair(true, { hl: slow });
  slow.pos = toQty('-5');
  s.px.pos = toQty('5');
  s.p.adopt([toQty('-5'), toQty('5')]);
  assert.equal(await s.p.whenIdle(10), true);
  const closing = s.p.close({ reason: 'panic_close', targets: [0n, 0n] });
  assert.equal(s.p.closing, true);
  assert.equal(await s.p.whenIdle(150), false, 'still running after the bound');
  const idle = s.p.whenIdle(5_000);
  answer();
  await closing;
  assert.equal(await idle, true);
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

test('(6) a lock file with no pid yet (made, not written) counts as held', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'locks', 'trader.lock');
    acquireTraderLock(path, { onExit: false }).release();
    writeFileSync(path, '');
    assert.equal(lockHolder(path), 'unknown');
    assert.throws(() => acquireTraderLock(path, { onExit: false }), /holds no pid .*counts as held/);
    writeFileSync(path, '12');
    assert.notEqual(lockHolder(path), 'unknown', 'a pid, written in full, is read as one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(5) load() removes only its own temp files and those of a process that is gone, never a live writer\'s', () => {
  const dir = tempDir();
  try {
    const path = traderStateFile(dir, 'mainnet', ID);
    const store = new TraderStateStore(path, ID);
    store.save(fileState(null));
    const live = `${path}.${process.ppid}.tmp`;       // the parent runs: a live writer between fsync and rename
    const dead = `${path}.999999999.tmp`;
    const own = `${path}.${process.pid}.tmp`;
    const other = `${path}.backup.tmp`;
    for (const f of [live, dead, own, other]) writeFileSync(f, '{}');
    assert.equal(store.load().kind, 'loaded');
    assert.deepEqual([existsSync(live), existsSync(dead), existsSync(own), existsSync(other)], [true, false, false, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the state file: orders in flight round-trip one entry each; sizes must be positive decimals as a save writes them', () => {
  const s = fileState(traderState([toQty('-50'), toQty('50')]), { inFlight: [flight({ index: 0 }), flight({ index: 1, venue: 'phoenix', side: 'SELL', size: '0.5', op: 'watch' })] });
  const back = parseTraderState({ ...traderStateJson(s), identity: ID });
  assert.deepEqual(back.inFlight, s.inFlight);
  const json = traderStateJson(s) as { inFlight: Record<string, unknown>[] };
  for (const size of ['-10', '1e3', '0', '10.0', ' 10', '0x10']) {
    const bad = { ...json, identity: ID, inFlight: [{ ...json.inFlight[0], size }] };
    assert.throws(() => parseTraderState(bad), /state\.inFlight\[0\]\.size: not a size/, size);
  }
  assert.throws(() => parseTraderState({ ...json, identity: ID, inFlight: [{ ...json.inFlight[0], op: 'other' }] }), /state\.inFlight\[0\]\.op/);
  assert.throws(() => parseTraderState({ ...json, identity: ID, inFlight: null }), /state\.inFlight: not a list/);
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

test('the monitor: an unknown distance is not a recovery; a float net delta within tolerance is hedged', () => {
  const alert = new LiquidationAlert();
  assert.equal(alert.observe(desk([deskLeg('hyperliquid', 'short', 20), deskLeg('phoenix', 'long', 70)]), 0).journal.length, 1);
  const unknown = alert.observe(desk([deskLeg('hyperliquid', 'short', null), deskLeg('phoenix', 'long', 70)]), 1000);
  assert.deepEqual(unknown, { journal: [], console: [] }, 'no "back above" for a null distance');
  const still = alert.observe(desk([deskLeg('hyperliquid', 'short', 20), deskLeg('phoenix', 'long', 70)]), 2000);
  assert.equal(still.journal.length, 0, 'still under since the first alert: not a new crossing');
  const rounding = { ...desk([deskLeg('hyperliquid', 'short', 60), deskLeg('phoenix', 'long', 70)]), netDelta: 5.5e-15 };
  assert.equal(isHedged(rounding), true);
  assert.match(monitorLines(rounding)[2]!, /\(hedged\)/);
  assert.equal(isHedged({ ...rounding, netDelta: 0.001 }), false);
});
