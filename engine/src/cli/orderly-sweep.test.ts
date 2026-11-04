// panic_close's Orderly sweep: every Orderly position the pair trader does not hold is closed reduce-only through the
// session (split under the cap less the band, read back after each order); a market whose order filled nothing is not
// tried again while the desk is closing; the watch runs from each sweep's start only, acts on a position that came
// back, at most SWEEP_MAX_WATCH_ROUNDS times, asks `covered` anew, and stops once `closing` ends; sweeps and watch
// rounds run one at a time; no session or no lock closes nothing and says so; and the panic reducer closes the pair
// first, leaves a rescue's reduce to the pair, and with no pair is panicOnly.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamEvent, VenueId } from '@gimbal/shared';
import { NothingExecuted } from '../relayer/tx.ts';
import type { Reducer, ReduceResult } from '../rescue/rescuer.ts';
import type { LegOutcome, LegSide, TradeLeg } from '../trade/legs.ts';
import { toQty } from '../trade/lots.ts';
import { REPLAY_WINDOW_MS } from '../trade/pair.ts';
import type { AccountState } from '../venues/venue.ts';
import type { OrderlySweepInput } from './orderly-sweep.ts';
import { OrderlySweep, SWEEP_MAX_WATCH_ROUNDS, SWEEP_POLL_MS, panicReducer } from './orderly-sweep.ts';

class Leg implements TradeLeg {
  readonly venue: VenueId = 'orderly';
  readonly symbol: string;
  readonly lot = toQty('1');
  readonly replayable = true;
  pos: bigint;
  cap: bigint;
  /** The IOC fills nothing (an empty book, a market Orderly dropped): signed, and the venue answers no fill. */
  dead = false;
  /** Orders in flight now, and the most at once (sweeps and watch rounds must not overlap). */
  inFlight = 0;
  most = 0;
  orders: { side: LegSide; size: bigint; reduceOnly: boolean; reason: string }[] = [];
  constructor(symbol: string, pos: string, cap = '1000') {
    this.symbol = symbol;
    this.pos = toQty(pos);
    this.cap = toQty(cap);
  }
  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return this.cap;
  }
  async position(): Promise<bigint> {
    return this.pos;
  }
  async order(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome> {
    this.inFlight++;
    this.most = Math.max(this.most, this.inFlight);
    await new Promise((r) => setImmediate(r));
    this.inFlight--;
    this.orders.push({ side, size, reduceOnly, reason });
    const ref = { venue: 'orderly' as const, side, size: String(size), reduceOnly, orderId: `o${this.orders.length}`, clientId: null, tx: [{ chain: 'near' as const, id: `t${this.orders.length}`, url: '' }], sentAt: 0 };
    if (this.dead) return { kind: 'failed', error: new NothingExecuted('orderly', 'the IOC filled nothing'), ref };
    this.pos += side === 'BUY' ? size : -size;
    return { kind: 'filled', filled: size, avgPx: 1, fee: 0.01, ref };
  }
}

interface Options {
  session?: boolean;
  begin?: string | null;
  heldKnown?: boolean;
}

function setup(legs: Leg[], options: Options = {}) {
  let now = 1_000_000;
  const events: StreamEvent[] = [];
  const marks: string[] = [];
  const bySymbol = new Map(legs.map((l) => [l.symbol, l]));
  const account = async (): Promise<AccountState> => ({
    venue: 'orderly', address: 'acct', time: now, equityUsd: 100, freeMarginUsd: 100, maintenanceMarginUsd: 0,
    positions: legs.filter((l) => l.pos !== 0n).map((l) => ({
      symbol: l.symbol, size: Number(l.pos) / 1e8, entryPx: 1, liqPx: null, marginUsd: 1, unrealizedPnlUsd: 0, leverage: 1, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0,
    })),
  });
  const world = { covered: [] as string[], closing: true as boolean | null, onSleep: null as (() => void) | null, polls: 0 };
  const input: OrderlySweepInput = {
    session: options.session === false ? undefined : { leg: (spec) => bySymbol.get(spec.symbol) ?? null, account },
    heldKnown: () => options.heldKnown ?? true,
    covered: () => world.covered,
    closing: async () => world.closing,
    spec: (symbol) => (symbol.startsWith('PERP_') ? { symbol, oraclePx: async () => 1, maxNotionalUsd: 100, slippageBps: 50 } : null),
    begin: async () => {
      marks.push('begin');
      return options.begin ?? null;
    },
    end: () => marks.push('end'),
    bandBps: 100,
    clock: { now: () => now },
    sleep: async (ms) => {
      now += ms;
      world.polls++;
      world.onSleep?.();
    },
    log: () => {},
    publish: (e) => events.push(e),
  };
  return { sweep: new OrderlySweep(input), events, marks, world, now: () => now };
}

const journal = (events: StreamEvent[]) => events.flatMap((e) => (e.type === 'journal' ? [e.data.summary] : []));
/** Reads until the first one past the window (REPLAY_WINDOW_MS from the sweep's start). */
const POLLS = Math.floor(REPLAY_WINDOW_MS / SWEEP_POLL_MS) + 1;

test('sweep: every Orderly position but the covered ones is closed reduce-only, split under the cap less the band', async () => {
  const eth = new Leg('PERP_ETH_USDC', '-5', '2');
  const xlm = new Leg('PERP_XLM_USDC', '10');
  const s = setup([eth, xlm]);
  s.world.covered = ['PERP_XLM_USDC'];
  const r = await s.sweep.sweep('panic_close: the owner closed the desk');
  assert.equal(r.closed, true, r.notes.join('; '));
  assert.equal(eth.pos, 0n);
  assert.equal(xlm.pos, toQty('10'), 'the pair trader closes its own leg');
  assert.deepEqual(eth.orders.map((o) => [o.side, o.size, o.reduceOnly]), Array(5).fill(['BUY', toQty('1'), true]), '2 under a 100 bps band floors to 1 lot');
  assert.deepEqual(r.legs.map((l) => [l.symbol, l.start, l.final]), [['PERP_ETH_USDC', '-5', '0']]);
  assert.equal(r.tx.length, 5);
  assert.deepEqual(s.marks, ['begin', 'end']);
  await s.sweep.watch;
});

test('the watch runs from the sweep\'s start only (its own orders never extend it); a position that comes back is closed and journaled', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  const s = setup([eth]);
  s.world.onSleep = () => {
    if (s.world.polls === 2) eth.pos = toQty('3');            // a replayed copy of the open's IOC lands
  };
  assert.equal((await s.sweep.sweep('panic_close')).closed, true);
  assert.ok(s.sweep.watch !== null, 'watched after the sweep');
  await s.sweep.watch;
  assert.equal(eth.pos, 0n);
  assert.deepEqual(eth.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['SELL', toQty('3'), true], ['SELL', toQty('3'), true]]);
  assert.deepEqual(journal(s.events), ['panic_close: Orderly PERP_ETH_USDC 3 -> 0 came back after the sweep (a replayed order?): closed reduce-only']);
  assert.equal(s.world.polls, POLLS, 'the window ended REPLAY_WINDOW_MS after the sweep\'s start, the watch\'s own close not counted');
});

test('a market whose reduce-only order filled nothing is not tried again while the desk is closing: no signing every round', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  eth.dead = true;
  const s = setup([eth]);
  const r = await s.sweep.sweep('panic_close');
  assert.equal(r.closed, false);
  assert.match(r.notes.join(' '), /the reduce-only SELL 3 reduce-only: failed \(.*the IOC filled nothing\) left it at 3; not tried again while the desk is closing/);
  assert.equal(eth.orders.length, 1);
  // panic_close's 60 s retry, and the whole watch window: nothing more is signed, the lock is not taken again.
  const again = await s.sweep.sweep('panic_close');
  assert.match(again.notes.join(' '), /Orderly PERP_ETH_USDC: not tried again while the desk is closing \(.*\); unpause, then panic_close again to retry/);
  await s.sweep.watch;
  assert.equal(eth.orders.length, 1);
  assert.deepEqual(s.marks, ['begin', 'end', 'begin', 'end'], 'no watch round began: the position never came back, it stayed');
  assert.deepEqual(journal(s.events), []);
});

test('the watch closes at most SWEEP_MAX_WATCH_ROUNDS positions that came back, then stops and says so', async () => {
  const eth = new Leg('PERP_ETH_USDC', '1');
  const s = setup([eth]);
  s.world.onSleep = () => {
    eth.pos = toQty('1');                                     // it comes back before every read
  };
  await s.sweep.sweep('panic_close');
  await s.sweep.watch;
  assert.equal(eth.orders.length, 1 + SWEEP_MAX_WATCH_ROUNDS);
  assert.match(journal(s.events).at(-1) ?? '', new RegExp(`came back after the sweep again, after ${SWEEP_MAX_WATCH_ROUNDS} closes: the watch stops`));
  assert.ok(s.world.polls < POLLS, 'stopped before its window ended');
});

test('the watch asks covered anew: a pair the loop opened meanwhile keeps its Orderly leg; closing ending stops it and a later panic_close retries', async () => {
  const xlm = new Leg('PERP_XLM_USDC', '0');
  const s = setup([xlm]);
  await s.sweep.sweep('panic_close');
  s.world.onSleep = () => {
    if (s.world.polls === 2) {
      s.world.covered = ['PERP_XLM_USDC'];                    // a new pair's trader holds XLM now
      xlm.pos = toQty('4');
    }
  };
  await s.sweep.watch;
  assert.deepEqual([xlm.orders.length, xlm.pos], [0, toQty('4')], 'the pair\'s own leg is left to its trader');

  // closing ends (unpause): the watch stops at its next read, and a market given up is tried again next time.
  const eth = new Leg('PERP_ETH_USDC', '2');
  eth.dead = true;
  const t = setup([eth]);
  await t.sweep.sweep('panic_close');
  t.world.closing = false;
  await t.sweep.watch;
  assert.ok(t.world.polls <= 2, 'stopped at its next read');
  eth.dead = false;
  assert.equal(eth.orders.length, 1);
  t.world.closing = true;
  assert.equal((await t.sweep.sweep('panic_close')).closed, true, 'the next panic_close tries it again');
  assert.equal(eth.pos, 0n);
  await t.sweep.watch;

  // The strategy loop opens: endWatch stops it at once.
  const u = setup([new Leg('PERP_ETH_USDC', '1')]);
  await u.sweep.sweep('panic_close');
  u.sweep.endWatch();
  await u.sweep.watch;
  assert.ok(u.world.polls <= 2, 'stopped at its next read');
});

test('sweeps (and watch rounds) run one at a time: two panic_close sweeps at once send one close', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  const s = setup([eth]);
  const [a, b] = await Promise.all([s.sweep.sweep('panic_close'), s.sweep.sweep('panic_close retry')]);
  assert.deepEqual([a.closed, b.closed], [true, true]);
  assert.equal(eth.orders.length, 1);
  assert.equal(eth.most, 1);
  assert.deepEqual(s.marks, ['begin', 'end', 'begin', 'end']);
  await s.sweep.watch;
});

test('sweep: no session (with and without an Orderly leg saved), no lock or signing, or a market it cannot price', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  const nothing = await setup([eth], { session: false, heldKnown: false }).sweep.sweep('panic_close');
  assert.deepEqual([nothing.closed, nothing.notes], [true, ['nothing on Orderly to close: serve has no Orderly session, and the trader state holds no Orderly leg']]);
  const none = await setup([eth], { session: false }).sweep.sweep('panic_close');
  assert.equal(none.closed, false);
  assert.match(none.notes.join(' '), /serve has no Orderly session \(GIMBAL_ORDERLY_PAIRS=1\), and the trader state holds an Orderly leg: the desk's Orderly positions are neither read nor closed here, and pair-mainnet cannot close them/);
  const locked = setup([eth], { begin: 'the trader lock is not held: held by pid 7' });
  const r = await locked.sweep.sweep('panic_close');
  assert.equal(r.closed, false);
  assert.match(r.notes.join(' '), /the desk's Orderly positions are not closed: the trader lock is not held: held by pid 7/);
  assert.equal(locked.sweep.watch, null);
  const odd = new Leg('WEIRD', '1');
  const u = setup([odd]);
  const w = await u.sweep.sweep('panic_close');
  assert.deepEqual([w.closed, w.notes], [false, ['Orderly WEIRD: not a market the desk can price, so it is not closed here']]);
  await u.sweep.watch;
  assert.equal(eth.orders.length + odd.orders.length, 0);
});

/** A pair trader's close as the protections see it: records what it was asked, closes nothing itself. */
function fakePair(status: ReduceResult['status'], legs: TradeLeg[]): Reducer & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked, legs, lot: toQty('1'),
    close: async (request) => {
      asked.push(request.by ?? 'none');
      return { status, size: '10', legs: [], notes: [`pair ${status}`], tx: [], feeUsd: 0, feeUnknown: 0 };
    },
  };
}

test('panicReducer: panic_close closes the pair, then sweeps the rest; a rescue\'s reduce is the pair\'s alone; with no pair it is panicOnly', async () => {
  const pairLeg = new Leg('PERP_XLM_USDC', '10');
  const stray = new Leg('PERP_ETH_USDC', '-2');
  const s = setup([pairLeg, stray]);
  s.world.covered = ['PERP_XLM_USDC'];
  const pair = fakePair('closed', [pairLeg]);
  const red = panicReducer(pair, s.sweep);
  assert.equal(red.panicOnly, undefined);
  const r = await red.close({ reason: 'panic_close', reduceOnly: true, by: 'panic_close' });
  assert.deepEqual([r.status, pair.asked, stray.pos, pairLeg.pos], ['closed', ['panic_close'], 0n, toQty('10')]);
  await red.close({ reason: 'rescue', targets: [0n, 0n], reduceOnly: true, by: 'rescue reduce' });
  assert.deepEqual(pair.asked, ['panic_close', 'rescue reduce']);
  assert.equal(stray.orders.length, 1, 'a rescue never sweeps');
  await s.sweep.watch;

  // No pair: panicOnly; the other venues' legs are named and the close is not done while they are held.
  const t = setup([new Leg('PERP_ETH_USDC', '4')]);
  const alone = panicReducer(null, t.sweep, async () => 'no pair trader holds hyperliquid XLM here: nothing closed it; close by hand (stop serve, then pair-mainnet close --send)');
  assert.match(alone.panicOnly ?? '', /no pair trader holds the legs here/);
  await assert.rejects(alone.close({ reason: 'rescue', by: 'rescue reduce' }), /no pair trader holds the legs here: nothing was closed/);
  const left = await alone.close({ reason: 'panic_close', reduceOnly: true, by: 'panic_close' });
  assert.equal(left.status, 'stuck');
  assert.match(left.notes.join(' '), /no pair trader holds hyperliquid XLM here/);
  await t.sweep.watch;
  const flat = setup([new Leg('PERP_ETH_USDC', '4')]);
  assert.equal((await panicReducer(null, flat.sweep).close({ reason: 'panic_close', by: 'panic_close' })).status, 'closed');
  await flat.sweep.watch;

  // A pair that did not end flat stays what it ended; a live pair with no session and no Orderly leg saved closes.
  const u = setup([]);
  assert.equal((await panicReducer(fakePair('unhedged', []), u.sweep).close({ reason: 'panic_close', by: 'panic_close' })).status, 'unhedged');
  await u.sweep.watch;
  const v = setup([], { session: false, heldKnown: false });
  const done = await panicReducer(fakePair('closed', []), v.sweep).close({ reason: 'panic_close', by: 'panic_close' });
  assert.equal(done.status, 'closed');
  assert.match(done.notes.join(' '), /nothing on Orderly to close/);
});
