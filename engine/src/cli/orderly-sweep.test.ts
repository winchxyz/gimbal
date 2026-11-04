// panic_close's Orderly sweep: every Orderly position the pair trader does not hold is closed reduce-only through the
// session (split under the cap less the band, read back after each order); a refused close is tried again on
// panic_close's retry with a backoff, never by the watch, and every count starts again on a new panic_close or once the
// desk is not closing; the watch runs from each sweep's start only, acts on a position that came back, at most
// SWEEP_MAX_WATCH_ROUNDS times, asks `covered` anew, stops once `closing` ends, and endWatch is a no-op while the desk
// still reads closing; sweeps and watch
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
import { OrderlySweep, SWEEP_BACKOFF_MS, SWEEP_MAX_WATCH_ROUNDS, SWEEP_POLL_MS, SWEEP_TRIES_PER_CLOSING, panicReducer } from './orderly-sweep.ts';

class Leg implements TradeLeg {
  readonly venue: VenueId = 'orderly';
  readonly symbol: string;
  readonly lot = toQty('1');
  readonly replayable = true;
  pos: bigint;
  cap: bigint;
  /** The IOC fills nothing (an empty book, a market Orderly dropped): signed, and the venue answers no fill. */
  dead = false;
  /** The next this many IOCs fill nothing (a rate limit, a stale price): signed, and refused for now. */
  refuse = 0;
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
    if (this.refuse > 0) {
      this.refuse--;
      return { kind: 'failed', error: new NothingExecuted('orderly', 'rate limited'), ref };
    }
    if (this.dead) return { kind: 'failed', error: new NothingExecuted('orderly', 'the IOC filled nothing'), ref };
    this.pos += side === 'BUY' ? size : -size;
    return { kind: 'filled', filled: size, avgPx: 1, fee: 0.01, ref };
  }
}

interface Options {
  session?: boolean;
  begin?: string | null;
  heldKnown?: 'none' | 'flat' | 'open';
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
  // `closing`: ClosingWatch's read of get_desk, handed to each sweep (the request's `closing`).
  const world = { covered: [] as string[], closing: true, onSleep: null as (() => void) | null, polls: 0 };
  const input: OrderlySweepInput = {
    session: options.session === false ? undefined : { leg: (spec) => bySymbol.get(spec.symbol) ?? null, account },
    heldKnown: () => options.heldKnown ?? 'open',
    covered: () => world.covered,
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
  const sweep = new OrderlySweep(input);
  /** A panic_close's sweep as ClosingWatch asks for it (`fresh`: its first close, not a retry). */
  const go = (reason: string, fresh = false) => sweep.sweep(reason, { fresh, closing: () => world.closing });
  return { sweep, go, events, marks, world, now: () => now, advance: (ms: number) => void (now += ms) };
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

test('serve stops during a sweep: the order in flight is read back, and no further order is signed', async () => {
  const eth = new Leg('PERP_ETH_USDC', '-5', '2');
  const s = setup([eth]);
  const order = eth.order.bind(eth);
  eth.order = async (side, size, reduceOnly, reason) => {
    const out = await order(side, size, reduceOnly, reason);
    if (eth.orders.length === 2) s.sweep.stop();               // serve stops while the second order is out
    return out;
  };
  const r = await s.sweep.sweep('panic_close: the owner closed the desk');
  assert.equal(eth.orders.length, 2);
  assert.equal(eth.pos, toQty('-3'));
  assert.equal(r.closed, false);
  assert.match(r.notes.join('; '), /Orderly PERP_ETH_USDC: serve stops, so no further order is sent/);
  assert.equal(s.sweep.watch, null, 'no watch after stop');
});

test('the watch runs from the sweep\'s start only (its own orders never extend it); a position that comes back is closed and journaled', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  const s = setup([eth]);
  s.world.onSleep = () => {
    if (s.world.polls === 2) eth.pos = toQty('3');            // a replayed copy of the open's IOC lands
  };
  assert.equal((await s.go('panic_close')).closed, true);
  assert.ok(s.sweep.watch !== null, 'watched after the sweep');
  await s.sweep.watch;
  assert.equal(eth.pos, 0n);
  assert.deepEqual(eth.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['SELL', toQty('3'), true], ['SELL', toQty('3'), true]]);
  assert.deepEqual(journal(s.events), ['panic_close: Orderly PERP_ETH_USDC 3 -> 0 came back after the sweep (a replayed order?): closed reduce-only']);
  assert.equal(s.world.polls, POLLS, 'the window ended REPLAY_WINDOW_MS after the sweep\'s start, the watch\'s own close not counted');
});

test('a refused close is tried again on panic_close\'s retry: a transient refusal, then the close', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  eth.refuse = 1;
  const s = setup([eth]);
  const r = await s.go('panic_close', true);
  assert.equal(r.closed, false);
  assert.match(r.notes.join(' '), /the reduce-only SELL 3 reduce-only: failed \(.*rate limited\) left it at 3 \(failed try 1\); panic_close tries it again on its next retry/);
  // The watch never signs it (no watch round began); panic_close's 60 s retry does, and it closes.
  s.advance(60_000);
  const again = await s.go('panic_close');
  assert.equal(again.closed, true, again.notes.join('; '));
  assert.equal(eth.pos, 0n);
  assert.equal(eth.orders.length, 2);
  await s.sweep.watch;
  assert.deepEqual(s.marks, ['begin', 'end', 'begin', 'end']);
  assert.deepEqual(journal(s.events), []);
});

test('a market that keeps refusing: SWEEP_TRIES_PER_CLOSING tries, then one every SWEEP_BACKOFF_MS; the watch never signs it', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  eth.dead = true;
  const s = setup([eth]);
  for (let n = 1; n <= SWEEP_TRIES_PER_CLOSING; n++) {
    const r = await s.go('panic_close', n === 1);
    assert.equal(r.closed, false);
    assert.match(r.notes.join(' '), new RegExp(`failed try ${n}\\); ${n < SWEEP_TRIES_PER_CLOSING ? 'panic_close tries it again' : 'tried again at most every 5 min'}`));
    s.advance(60_000);
  }
  assert.equal(eth.orders.length, SWEEP_TRIES_PER_CLOSING);
  // The next 60 s retries within the backoff sign nothing.
  const held = await s.go('panic_close');
  assert.match(held.notes.join(' '), new RegExp(`Orderly PERP_ETH_USDC: ${SWEEP_TRIES_PER_CLOSING} closes failed in this panic_close \\(last: .*\\); tried again in \\d+ s`));
  await s.sweep.watch;
  assert.equal(eth.orders.length, SWEEP_TRIES_PER_CLOSING, 'nothing signed in the backoff, the watch included');
  // After the backoff it is tried again, and closes once the venue takes it.
  s.advance(SWEEP_BACKOFF_MS);
  eth.dead = false;
  assert.equal((await s.go('panic_close')).closed, true);
  assert.equal(eth.pos, 0n);
  await s.sweep.watch;
});

test('every count starts again on a new panic_close (fresh) and on endWatch once the desk is not closing', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  eth.dead = true;
  const s = setup([eth]);
  for (let n = 0; n < SWEEP_TRIES_PER_CLOSING; n++) await s.go('panic_close', n === 0);
  assert.equal(eth.orders.length, SWEEP_TRIES_PER_CLOSING);
  // An unpause and a new panic_close inside one watch read: the new one's first close tries it at once.
  await s.go('panic_close', true);
  assert.equal(eth.orders.length, SWEEP_TRIES_PER_CLOSING + 1);
  for (let n = 1; n < SWEEP_TRIES_PER_CLOSING; n++) await s.go('panic_close');
  assert.equal(eth.orders.length, 2 * SWEEP_TRIES_PER_CLOSING);
  // endWatch while ClosingWatch reads closing: nothing changes.
  s.sweep.endWatch();
  await s.go('panic_close');
  assert.equal(eth.orders.length, 2 * SWEEP_TRIES_PER_CLOSING, 'still in the backoff');
  // Not closing any more (an unpause the loop read before it opens): endWatch starts every count again.
  s.world.closing = false;
  s.sweep.endWatch();
  s.world.closing = true;
  await s.go('panic_close');
  assert.equal(eth.orders.length, 2 * SWEEP_TRIES_PER_CLOSING + 1, 'tried at once after the reset');
  await s.sweep.watch;
});

test('the watch closes at most SWEEP_MAX_WATCH_ROUNDS positions that came back, then stops and says so', async () => {
  const eth = new Leg('PERP_ETH_USDC', '1');
  const s = setup([eth]);
  s.world.onSleep = () => {
    eth.pos = toQty('1');                                     // it comes back before every read
  };
  await s.go('panic_close');
  await s.sweep.watch;
  assert.equal(eth.orders.length, 1 + SWEEP_MAX_WATCH_ROUNDS);
  assert.match(journal(s.events).at(-1) ?? '', new RegExp(`came back after the sweep again, after ${SWEEP_MAX_WATCH_ROUNDS} closes: the watch stops`));
  assert.ok(s.world.polls < POLLS, 'stopped before its window ended');
});

test('the watch asks covered anew: a pair the loop opened meanwhile keeps its Orderly leg; closing ending stops it and a later panic_close retries', async () => {
  const xlm = new Leg('PERP_XLM_USDC', '0');
  const s = setup([xlm]);
  await s.go('panic_close');
  s.world.onSleep = () => {
    if (s.world.polls === 2) {
      s.world.covered = ['PERP_XLM_USDC'];                    // a new pair's trader holds XLM now
      xlm.pos = toQty('4');
    }
  };
  await s.sweep.watch;
  assert.deepEqual([xlm.orders.length, xlm.pos], [0, toQty('4')], 'the pair\'s own leg is left to its trader');

  // closing ends (unpause): the watch stops at its next read, and every count starts again.
  const eth = new Leg('PERP_ETH_USDC', '2');
  eth.dead = true;
  const t = setup([eth]);
  for (let n = 0; n < SWEEP_TRIES_PER_CLOSING; n++) await t.go('panic_close', n === 0);
  const before = t.world.polls;
  t.world.closing = false;
  await t.sweep.watch;
  assert.ok(t.world.polls - before <= 2, 'stopped at its next read');
  eth.dead = false;
  assert.equal(eth.orders.length, SWEEP_TRIES_PER_CLOSING);
  t.world.closing = true;
  assert.equal((await t.go('panic_close')).closed, true, 'a retry, no backoff: the counts started again');
  assert.equal(eth.pos, 0n);
  await t.sweep.watch;

  // The strategy loop opens (endWatch) while ClosingWatch still reads closing: the watch goes on, and closes a copy.
  const back = new Leg('PERP_ETH_USDC', '1');
  const v = setup([back]);
  v.world.onSleep = () => {
    if (v.world.polls === 3) back.pos = toQty('1');
  };
  await v.go('panic_close', true);
  v.sweep.endWatch();
  await v.sweep.watch;
  assert.equal(back.pos, 0n);
  assert.equal(back.orders.length, 2, 'the watch closed the position that came back');
  assert.equal(v.world.polls, POLLS);

  // Once it reads not closing, endWatch stops it at once.
  const u = setup([new Leg('PERP_ETH_USDC', '1')]);
  await u.go('panic_close', true);
  u.world.closing = false;
  u.sweep.endWatch();
  await u.sweep.watch;
  assert.ok(u.world.polls <= 2, 'stopped at its next read');
});

test('sweeps (and watch rounds) run one at a time: two panic_close sweeps at once send one close', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  const s = setup([eth]);
  const [a, b] = await Promise.all([s.go('panic_close'), s.sweep.sweep('panic_close retry')]);
  assert.deepEqual([a.closed, b.closed], [true, true]);
  assert.equal(eth.orders.length, 1);
  assert.equal(eth.most, 1);
  assert.deepEqual(s.marks, ['begin', 'end', 'begin', 'end']);
  await s.sweep.watch;
});

test('sweep: no session (with and without an Orderly leg saved), no lock or signing, or a market it cannot price', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  const nothing = await setup([eth], { session: false, heldKnown: 'none' }).sweep.sweep('panic_close');
  assert.deepEqual([nothing.closed, nothing.notes], [true, ['nothing on Orderly to close: serve has no Orderly session, and the trader state holds no Orderly leg']]);
  // A saved Orderly leg that is flat, or no state: nothing known, and not done (the alert goes on).
  const flat = await setup([eth], { session: false, heldKnown: 'flat' }).sweep.sweep('panic_close');
  assert.equal(flat.closed, false);
  assert.match(flat.notes.join(' '), /^nothing known on Orderly: serve has no Orderly session to read it/);
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
  const w = await u.go('panic_close');
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
  const v = setup([], { session: false, heldKnown: 'none' });
  const done = await panicReducer(fakePair('closed', []), v.sweep).close({ reason: 'panic_close', by: 'panic_close' });
  assert.equal(done.status, 'closed');
  assert.match(done.notes.join(' '), /nothing on Orderly to close/);
});
