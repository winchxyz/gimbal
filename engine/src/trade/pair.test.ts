// The pair trader against two scripted fake legs: both legs go out at once, the legging guard retries once and then
// unwinds reduce-only, an unknown outcome is read back from the venue before anything else (a Hyperliquid one only
// after its expiry, and never retried without one), an Orderly copy of a signed order (a replayed fill) is closed as
// excess and a copy of a reducing one is matched on the partner, the watch holds each leg to the pair's final intent,
// an unsettled Hyperliquid order keeps its leg watched (a close it leaves one-legged is unhedged until it runs),
// close mirrors open and re-hedges a leg that stays open, reduce-only moves split under the policy cap less the price
// band, and sizes are rounded to the common lot before anything is signed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VenueId } from '@gimbal/shared';
import { MpcTimeoutError, OutcomeUnknown } from '../contract/types.ts';
import type { HlOrder } from '../contract/types.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import type { LegOutcome, LegRef, LegSide, TradeLeg } from './legs.ts';
import { HlLeg, LegCheckError } from './legs.ts';
import { floorToLot, lotQty, toQty } from './lots.ts';
import type { PairTraderOptions, WatchReport } from './pair.ts';
import { MAX_CLOSE_ORDERS, PairTrader, REPLAY_WINDOW_MS, UNSETTLED_POLL_MS, UNSETTLED_WATCH_MS, reducedTarget } from './pair.ts';

type Step =
  | 'fill'
  | 'fail'                       // the venue refused it or the IOC did not fill: proof nothing ran, but it was signed
  | 'check'                      // refused by a local check: nothing was signed
  | 'unknown-filled'             // the answer was lost, the order filled
  | 'unknown-none'               // the answer was lost, nothing ran (yet)
  | 'unknown-unreadable'         // the answer was lost, the order filled, and the venue cannot be read afterwards
  | 'unknown-lost'               // the answer was lost, nothing ran (yet), and the venue cannot be read afterwards
  | 'copy'                       // filled, and a replayed copy of the signed order filled too
  | 'fill-unreadable'            // filled, and the next position read fails
  | { partial: string }
  | { hold: Promise<void> };     // waits for the test, then fills

interface Shared {
  started: number;
  overlap: boolean;
  now: number;
}

interface FakeOptions {
  pos?: string;
  script?: Step[];
  replayable?: boolean;
  lot?: string;
  /** Hyperliquid: an unknown order whose signed payload was seen, with expiresAfter this long after it was sent. */
  expiresAfterMs?: number;
  /** The policy cap's largest order (maxSize); unlimited when unset. */
  max?: string;
  /**
   * A cap in USD at a moving price instead: maxSize is the cap at `px` now; each order first moves the price by the
   * next of `upticksBps` (the last repeats), and is refused when it is over the cap at its price.
   */
  capUsd?: number;
  px?: number;
  upticksBps?: number[];
}

class FakeLeg implements TradeLeg {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly lot: bigint;
  readonly replayable: boolean;
  pos: bigint;
  readonly script: Step[];
  readonly orders: { side: LegSide; size: string; reduceOnly: boolean; reason: string }[] = [];
  readonly reads: (number | undefined)[] = [];
  unreadable = false;
  px: number;
  #failReads = 0;
  readonly #shared: Shared;
  readonly #o: FakeOptions;
  readonly #upticks: number[];
  #seq = 0;

  constructor(venue: VenueId, shared: Shared, options: FakeOptions = {}) {
    this.venue = venue;
    this.symbol = venue === 'orderly' ? 'PERP_ETH_USDC' : 'ETH';
    this.lot = lotQty(options.lot ?? '0.0001');
    this.replayable = options.replayable ?? venue === 'orderly';
    this.pos = toQty(options.pos ?? '0');
    this.script = options.script ?? [];
    this.px = options.px ?? 2500;
    this.#upticks = [...(options.upticksBps ?? [0])];
    this.#shared = shared;
    this.#o = options;
  }

  async check(size: bigint): Promise<void> {
    if (size < toQty('0.003')) throw new LegCheckError(`${this.venue}: under the 10 USD minimum`);
  }

  async maxSize(): Promise<bigint> {
    if (this.#o.capUsd !== undefined) {
      return floorToLot(toQty((this.#o.capUsd / this.px).toFixed(8)), this.lot);
    }
    return this.#o.max === undefined ? 10n ** 16n : toQty(this.#o.max);
  }

  async position(after?: number): Promise<bigint> {
    this.reads.push(after);
    if (this.#failReads > 0) {
      this.#failReads--;
      throw new Error(`${this.venue}: read timed out`);
    }
    if (this.unreadable) throw new Error(`${this.venue}: venue unreachable`);
    return this.pos;
  }

  async order(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome> {
    this.orders.push({ side, size: String(Number(size) / 1e8), reduceOnly, reason });
    const ref: LegRef = { venue: this.venue, side, size: String(size), reduceOnly, orderId: `${this.venue}-${++this.#seq}`, clientId: null, tx: [], sentAt: this.#shared.now };
    const expiresAt = this.replayable ? ref.sentAt + REPLAY_WINDOW_MS : this.#o.expiresAfterMs === undefined ? null : ref.sentAt + this.#o.expiresAfterMs;
    const unknown = (): LegOutcome => ({ kind: 'unknown', error: new OutcomeUnknown(this.venue, 'no answer', {}), ref, expiresAt });
    // Both legs of a round reach the venue before either answers: the trader sends them together.
    this.#shared.started++;
    for (let i = 0; i < 20 && this.#shared.started % 2 === 1; i++) await new Promise((r) => setImmediate(r));
    if (this.#shared.started % 2 === 0) this.#shared.overlap = true;
    let step = this.script.shift() ?? 'fill';
    if (typeof step === 'object' && 'hold' in step) {
      await step.hold;
      step = 'fill';
    }
    // The price moves between sizing and sending; as HlLeg plans it, the order is priced again now and refused
    // before signing when that puts it over the cap.
    const move = this.#upticks.length > 1 ? this.#upticks.shift()! : this.#upticks[0]!;
    this.px *= 1 + move / 10_000;
    const usd = (Number(size) / 1e8) * this.px;
    if (this.#o.capUsd !== undefined && usd > this.#o.capUsd + 1e-9) {
      return { kind: 'failed', error: new LegCheckError(`${this.venue}: ${usd.toFixed(2)} USD at ${this.px.toFixed(2)} is over the ${this.#o.capUsd} USD cap`), ref };
    }
    const signed = side === 'BUY' ? size : -size;
    const apply = (q: bigint) => {
      if (reduceOnly) {
        // A venue's reduce-only never grows or flips a position.
        const cap = -this.pos;
        if ((this.pos > 0n && q > 0n) || (this.pos < 0n && q < 0n) || this.pos === 0n) return 0n;
        if ((q < 0n && q < cap) || (q > 0n && q > cap)) q = cap;
      }
      this.pos += q;
      return q < 0n ? -q : q;
    };
    if (step === 'fail') return { kind: 'failed', error: new NothingExecuted(this.venue, 'refused'), ref };
    if (step === 'check') return { kind: 'failed', error: new LegCheckError(`${this.venue}: refused before signing`), ref };
    if (step === 'unknown-none') return unknown();
    if (step === 'unknown-filled') {
      apply(signed);
      return unknown();
    }
    if (step === 'unknown-unreadable') {
      apply(signed);
      this.unreadable = true;
      return unknown();
    }
    if (step === 'unknown-lost') {
      this.unreadable = true;
      return unknown();
    }
    if (typeof step === 'object') {
      const part = toQty(step.partial);
      const done = apply(side === 'BUY' ? part : -part);
      return { kind: 'filled', filled: done, avgPx: 2500, ref };
    }
    const done = apply(signed);
    if (done === 0n) return { kind: 'failed', error: new NothingExecuted(this.venue, 'reduce-only had nothing to reduce'), ref };
    if (step === 'copy') this.pos += signed;    // someone sent the public signed copy: it filled again
    if (step === 'fill-unreadable') this.#failReads = 1;
    return { kind: 'filled', filled: done, avgPx: 2500, ref };
  }
}

/** No band and no unsettled poll unless a test asks: the poll's sleep would run the 2-day window down at once. */
function setup(hl: FakeOptions = {}, orderly: FakeOptions = {}, options: Partial<PairTraderOptions> = {}) {
  const shared: Shared = { started: 0, overlap: false, now: 1_000_000 };
  const a = new FakeLeg('hyperliquid', shared, hl);
  const b = new FakeLeg('orderly', shared, orderly);
  const lines: string[] = [];
  const sleeps: number[] = [];
  const watches: WatchReport[] = [];
  const trader = new PairTrader({
    legs: [a, b], priceBandBps: 0, unsettledPollMs: null, clock: { now: () => shared.now }, log: (l) => lines.push(l),
    sleep: async (ms) => {
      sleeps.push(ms);
      shared.now += ms;
    },
    onWatch: (w) => watches.push(w),
    ...options,
  });
  return { a, b, trader, shared, lines, sleeps, watches };
}

/** A sleep the test ends by hand (no timers): each `step()` ends the oldest one, moving the clock by its length. */
function steppedSleep(shared: () => Shared) {
  const waiting: (() => void)[] = [];
  return {
    sleep: (ms: number) => new Promise<void>((resolve) => waiting.push(() => {
      shared().now += ms;
      resolve();
    })),
    waiting: () => waiting.length,
    async step(): Promise<void> {
      const wake = waiting.shift();
      assert.ok(wake !== undefined, 'nothing is sleeping');
      wake();
      await ticks(100);   // promises and setImmediate only: the poll's read, check and any order run to the end
    },
  };
}

const q = (s: string) => toQty(s);
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

test('open: both legs go out together and end at their targets; sizes round down to the common lot', async () => {
  const s = setup();
  const r = await s.trader.open({ size: '0.00456789', longIndex: 0, reason: 'open ETH' });
  assert.equal(r.status, 'open');
  assert.equal(r.size, '0.0045');
  assert.deepEqual([s.a.pos, s.b.pos], [q('0.0045'), q('-0.0045')]);
  assert.ok(s.shared.overlap, 'the second leg was sent before the first answered');
  assert.deepEqual(s.a.orders, [{ side: 'BUY', size: '0.0045', reduceOnly: false, reason: 'open ETH' }]);
  assert.deepEqual(s.b.orders.map((o) => o.side), ['SELL']);
  assert.deepEqual([r.legs[0].final, r.legs[1].final], ['0.0045', '-0.0045']);
  assert.deepEqual([s.trader.intent(s.a), s.trader.intent(s.b)], [q('0.0045'), q('-0.0045')]);
});

test('open: a size under a venue minimum or under one lot is refused before anything is signed', async () => {
  const s = setup();
  await assert.rejects(s.trader.open({ size: '0.002', longIndex: 0, reason: 'x' }), /under the 10 USD minimum/);
  await assert.rejects(s.trader.open({ size: '0.00009', longIndex: 0, reason: 'x' }), /under one common lot 0.0001/);
  const unreadable = setup();
  unreadable.b.unreadable = true;
  await assert.rejects(unreadable.trader.open({ size: '0.005', longIndex: 0, reason: 'x' }), /venue unreachable/);
  assert.equal(s.a.orders.length + s.b.orders.length + unreadable.a.orders.length, 0);
});

test('legging guard: the failed leg is retried once and the pair opens', async () => {
  const s = setup({}, { script: ['fail', 'fill'] });
  const r = await s.trader.open({ size: '0.005', longIndex: 1, reason: 'open' });
  assert.equal(r.status, 'open');
  assert.deepEqual([s.a.pos, s.b.pos], [q('-0.005'), q('0.005')]);
  assert.deepEqual(s.b.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['BUY', '0.005', false], ['BUY', '0.005', false]]);
  assert.match(r.notes.join(' '), /legging: orderly at 0 of 0.005; retrying once/);
});

test('legging guard: a leg that fails twice makes the filled leg close reduce-only, and the pair ends flat', async () => {
  const s = setup({ script: ['fail', 'fail'] });
  const r = await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r.status, 'flat');
  assert.deepEqual([s.a.pos, s.b.pos], [0n, 0n]);
  assert.deepEqual(s.b.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['SELL', '0.005', false], ['BUY', '0.005', true]]);
  assert.equal(s.a.orders.length, 2, 'the failed leg was tried twice and never closed: it holds nothing');
  assert.deepEqual(r.legs[1].orders.map((o) => o.purpose), ['open', 'unwind']);
});

test('legging guard: a partial fill is topped up once, and an unwind that fails once is retried', async () => {
  const topped = setup({ script: [{ partial: '0.002' }, 'fill'] });
  const r1 = await topped.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r1.status, 'open');
  assert.deepEqual(topped.a.orders.map((o) => o.size), ['0.005', '0.003']);

  const stubborn = setup({ script: ['fail', 'fail'] }, { script: ['fill', 'fail', 'fill'] });
  const r2 = await stubborn.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r2.status, 'flat');
  assert.deepEqual(stubborn.b.orders.map((o) => o.reduceOnly), [false, true, true]);
});

test('outcome unknown: the leg is read back first; a fill that happened is not sent again', async () => {
  const s = setup({ script: ['unknown-filled'] });
  const r = await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r.status, 'open');
  assert.equal(s.a.orders.length, 1, 'no retry: the venue showed the order had filled');
  assert.equal(r.legs[0].orders[0]!.outcome, 'unknown');
  assert.deepEqual(s.sleeps, [], 'a position that moved proves the order ran: nothing to wait for');
});

test('outcome unknown: when the venue shows nothing ran, the retry goes out; when it cannot be read, the pair is unhedged and the leg watched', async () => {
  const none = setup({}, { script: ['unknown-none', 'fill'] });
  assert.equal((await none.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'open');
  assert.equal(none.b.orders.length, 2);

  // The open order filled, and Hyperliquid cannot be read: a position that cannot be read counts as open.
  const lost = setup({ script: ['unknown-unreadable'] });
  const r = await lost.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r.status, 'unhedged');
  assert.equal(r.legs[0].final, null);
  assert.equal(lost.a.orders.length, 1, 'no retry without proof');
  assert.equal(lost.b.orders.length, 1, 'and no unwind of the other leg: it may be the hedge of a fill that cannot be read');
  assert.match(r.notes.join(' '), /position unknown on hyperliquid/);
  assert.match(lost.trader.unhedged ?? '', /^unhedged: hyperliquid's position cannot be read, orderly holds -0\.005, and a position that cannot be read counts as open; the hyperliquid order with no answer \(hyperliquid-1\) may still run and is watched until /);
  assert.ok(lost.trader.watching(lost.a), 'the order may still run: its leg is watched whether or not the read worked');
  assert.equal(lost.trader.intent(lost.a), q('0.005'), 'what offsets its partner');

  // It reads again: the order had run, the legs offset, the alert clears, and nothing is sent.
  lost.a.unreadable = false;
  await lost.trader.positionPushed(lost.a, lost.a.pos);
  assert.deepEqual(lost.watches.map((w) => w.status), ['settled']);
  assert.equal(lost.trader.unhedged, null);
  assert.equal(lost.trader.watching(lost.a), false);
  assert.deepEqual([lost.a.orders.length, lost.b.orders.length], [1, 1]);
});

test('outcome unknown on a close, and the leg cannot be read: unhedged and watched; when it reads again unmoved, still watched', async () => {
  const c = setup({ pos: '0.005', script: ['unknown-lost'] }, { pos: '-0.005' });
  const r = await c.trader.close({ reason: 'close' });
  assert.equal(r.status, 'unhedged');
  assert.equal(r.legs[0].final, null);
  assert.deepEqual([c.a.orders.length, c.b.orders.length], [1, 1]);
  assert.match(c.trader.unhedged ?? '', /^unhedged: hyperliquid's position cannot be read, orderly holds 0, and a position that cannot be read counts as open; the hyperliquid order with no answer \(hyperliquid-1\) may still run/);
  assert.ok(c.trader.watching(c.a));
  assert.equal(c.trader.intent(c.a), 0n);

  // Reads again, unmoved: the order has not run; its position is known again, the pair still unhedged, still watched.
  c.a.unreadable = false;
  await c.trader.positionPushed(c.a, q('0.005'));
  assert.deepEqual(c.watches.map((w) => w.status), ['unhedged']);
  assert.match(c.watches[0]!.notes.join(' '), /hyperliquid ETH reads again: 0\.005, so SELL \S+ \(hyperliquid-1\) has not run/);
  assert.match(c.trader.unhedged ?? '', /^unhedged: hyperliquid holds 0\.005, orderly holds 0: the legs do not offset each other$/);
  assert.ok(c.trader.watching(c.a));
  await c.trader.positionPushed(c.a, q('0.005'));
  assert.equal(c.watches.length, 1, 'known again: an unmoved push is nothing new');

  // The order runs: flat after all.
  c.a.pos = 0n;
  await c.trader.positionPushed(c.a, 0n);
  assert.deepEqual(c.watches.map((w) => w.status), ['unhedged', 'settled']);
  assert.equal(c.trader.unhedged, null);
  assert.equal(c.trader.watching(c.a), false);
  assert.deepEqual([c.a.orders.length, c.b.orders.length], [1, 1]);
});

test('hyperliquid unknown with a signed expiry: read back only once the order has expired, then retried', async () => {
  const s = setup({ expiresAfterMs: 60_000, script: ['unknown-none', 'fill'] });
  const r = await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r.status, 'open');
  assert.deepEqual(s.sleeps, [60_000], 'the read waited for the expiry: before it a late signature could still execute');
  assert.equal(s.a.reads.length, 2, 'the start, then one read after the expiry');
  assert.deepEqual(s.a.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['BUY', '0.005', false], ['BUY', '0.005', false]]);
});

test('hyperliquid unknown without an expiry: never retried; on open the partner goes back (stuck), on close the pair is unhedged until it runs', async () => {
  const s = setup({ script: ['unknown-none'] });
  const r = await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r.status, 'stuck');
  assert.equal(s.a.orders.length, 1, 'a second order could double the first if its signature lands late');
  assert.deepEqual(s.b.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['SELL', '0.005', false], ['BUY', '0.005', true]]);
  assert.deepEqual([s.a.pos, s.b.pos], [0n, 0n]);
  assert.match(r.notes.join(' '), /no answer and no expiry, and had not run when read: it may still execute, so it is not retried/);
  assert.deepEqual(r.legs[1].orders.map((o) => o.purpose), ['open', 'unwind']);
  assert.deepEqual(s.sleeps, []);

  assert.ok(s.trader.watching(s.a), 'the order may still run: its leg is watched');
  assert.equal(s.trader.unhedged, null, 'the legs offset each other');

  // On close the unsettled leg is left alone and its partner's close stands (nothing is reopened against an order
  // that may still close the leg): Hyperliquid is open alone, so the pair is unhedged and its leg watched.
  const c = setup({ pos: '0.005', script: ['unknown-none'] }, { pos: '-0.005' });
  const rc = await c.trader.close({ reason: 'close' });
  assert.equal(rc.status, 'unhedged');
  assert.deepEqual([c.a.orders.length, c.b.orders.length], [1, 1]);
  assert.deepEqual([c.a.pos, c.b.pos], [q('0.005'), 0n]);
  assert.match(c.trader.unhedged ?? '', /^unhedged: hyperliquid holds 0\.005, orderly holds 0, which do not offset each other; the hyperliquid order with no answer \(hyperliquid-1\) may still run and is watched until /);
  assert.ok(c.trader.watching(c.a));
  assert.equal(c.trader.unsettled(c.a)?.until, 1_000_000 + UNSETTLED_WATCH_MS);
  assert.equal(c.trader.intent(c.a), 0n, 'what offsets its partner');

  // The order runs an hour later: flat after all, the alert clears, and nothing is sent.
  c.a.pos = 0n;
  c.shared.now += 3_600_000;
  await c.trader.positionPushed(c.a, 0n);
  assert.deepEqual(c.watches.map((w) => w.status), ['settled']);
  assert.match(c.watches[0]!.notes.join(' '), /hyperliquid SELL \S+ \(hyperliquid-1\), which had no answer, ran: 0\.005 -> 0/);
  assert.equal(c.trader.unhedged, null);
  assert.equal(c.trader.watching(c.a), false);
  assert.deepEqual([c.a.orders.length, c.b.orders.length], [1, 1]);
});

test('an unsettled open order that runs later is closed back reduce-only: the pair is flat again', async () => {
  const s = setup({ script: ['unknown-none'] });
  assert.equal((await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'stuck');
  assert.equal(s.trader.intent(s.a), 0n);
  // A push at the position the trader left it at: the order has not run.
  await s.trader.positionPushed(s.a, 0n);
  assert.equal(s.watches.length, 0);
  s.a.pos = q('0.005');                               // the late signature lands
  s.shared.now += 600_000;
  await s.trader.positionPushed(s.a, s.a.pos);
  assert.deepEqual(s.watches.map((w) => w.status), ['reconciled']);
  assert.deepEqual(s.a.orders.at(-1), { side: 'SELL', size: '0.005', reduceOnly: true, reason: 'reconcile ETH: close 0.005 over the target' });
  assert.deepEqual([s.a.pos, s.b.pos], [0n, 0n]);
  assert.equal(s.trader.watching(s.a), false, 'it ran: nothing on the leg can land any more');
  assert.equal(s.trader.unhedged, null);
});

test('an unsettled order that never runs: when its window ends with the legs not offset, the alert is raised again', async () => {
  const c = setup({ pos: '0.005', script: ['unknown-none'] }, { pos: '-0.005' });
  assert.equal((await c.trader.close({ reason: 'close' })).status, 'unhedged');
  const until = c.trader.unsettled(c.a)!.until;
  c.shared.now = until;
  await c.trader.positionPushed(c.a, q('0.005'));
  assert.equal(c.watches.length, 0, 'inside the window, unmoved: nothing to say');
  c.shared.now = until + 1;
  await c.trader.positionPushed(c.a, q('0.005'));
  assert.deepEqual(c.watches.map((w) => w.status), ['unhedged']);
  assert.match(c.watches[0]!.notes.join(' '), /^unhedged: hyperliquid SELL \S+ \(hyperliquid-1\) had no answer and never ran; since \S+ it no longer can; hyperliquid holds 0\.005, orderly holds 0, which do not offset each other$/);
  assert.equal(c.trader.unhedged, c.watches[0]!.notes[0]);
  assert.equal(c.trader.unsettled(c.a), null);
  assert.equal(c.trader.watching(c.a), false);
  assert.deepEqual([c.a.orders.length, c.b.orders.length], [1, 1], 'nothing is traded: the owner acts');

  // A stuck open whose order never runs is hedged when its window ends: no alert.
  const o = setup({ script: ['unknown-none'] });
  assert.equal((await o.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'stuck');
  o.shared.now = o.trader.unsettled(o.a)!.until + 1;
  await o.trader.positionPushed(o.a, 0n);
  assert.deepEqual(o.watches.map((w) => w.status), ['lapsed']);
  assert.match(o.watches[0]!.notes.join(' '), /never ran; since \S+ it no longer can; the legs offset each other$/);
  assert.equal(o.trader.unhedged, null);
  assert.equal(o.trader.unsettled(o.a), null);
});

test('a window that ends with the legs offset clears an alert raised meanwhile, as a settled landing does', async () => {
  // The open's Orderly unwind fails twice: Orderly is short alone, Hyperliquid's BUY has no answer.
  const s = setup({ script: ['unknown-none'] }, { script: ['fill', 'fail', 'fail'] });
  assert.equal((await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'unhedged');
  assert.equal(s.trader.intent(s.a), q('0.005'));
  // A copy of a refused unwind lands: Orderly is flat. A deficit against its intent, and its partner cannot be
  // matched while its order may run: still the alert.
  s.b.pos = 0n;
  await s.trader.positionPushed(s.b, 0n);
  assert.deepEqual(s.watches.map((w) => w.status), ['unhedged']);
  assert.equal(s.trader.intent(s.a), 0n, 'what offsets Orderly now');
  assert.notEqual(s.trader.unhedged, null);
  // The window ends and the BUY never ran: both legs flat, offset. The alert clears.
  s.shared.now = s.trader.unsettled(s.a)!.until + 1;
  await s.trader.positionPushed(s.a, 0n);
  assert.deepEqual(s.watches.map((w) => w.status), ['unhedged', 'lapsed']);
  assert.equal(s.trader.unhedged, null);
  assert.equal(s.a.orders.length, 1);
});

test('a deficit while the partner\'s order has no answer: where that order would leave the partner moves, so its landing is hedged', async () => {
  // A stuck open: Hyperliquid's BUY has no answer, Orderly went back to 0. Then a copy of Orderly's SELL lands, and
  // its excess close is refused twice: Orderly is short 0.005 against its intent of 0.
  const s = setup({ script: ['unknown-none'] }, { script: ['fill', 'fill', 'fail', 'fail'] });
  assert.equal((await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'stuck');
  assert.equal(s.trader.intent(s.a), 0n);
  s.b.pos = q('-0.005');
  await s.trader.positionPushed(s.b, s.b.pos);
  assert.deepEqual(s.watches.map((w) => w.status), ['unhedged']);
  assert.match(s.watches[0]!.notes.join(' '), /hyperliquid has an order with no answer that may still run: not matched; it offsets this leg at 0\.005/);
  assert.equal(s.trader.intent(s.a), q('0.005'));
  // The BUY lands: the legs offset at 0.005 / -0.005. Hedged: nothing is closed back, the alert clears.
  s.a.pos = q('0.005');
  await s.trader.positionPushed(s.a, s.a.pos);
  assert.deepEqual(s.watches.map((w) => w.status), ['unhedged', 'settled']);
  assert.equal(s.a.orders.length, 1, 'no reduce-only close of the landing');
  assert.equal(s.trader.unhedged, null);
});

test('while an order has no answer, open is refused naming it; a reduce-only close still goes out, and the old order stays watched', async () => {
  // A close whose Hyperliquid reduce-only has no answer: Hyperliquid open alone, unhedged.
  const c = setup({ pos: '0.005', script: ['unknown-none'] }, { pos: '-0.005' });
  assert.equal((await c.trader.close({ reason: 'close' })).status, 'unhedged');
  const until = c.trader.unsettled(c.a)!.until;
  // An open now would reopen Hyperliquid, and the old reduce-only could then close it alone.
  const reopen = await c.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(reopen.status, 'unhedged', 'the alert stands');
  assert.match(reopen.notes[0]!, /^open refused, nothing sent: the hyperliquid SELL \S+ reduce-only \(hyperliquid-1\) has no answer and may still run until \S+; no open goes out on this pair until it runs or can no longer \(its watch reads the leg every 15 s\); a close still can$/);
  assert.deepEqual(reopen.tx, []);
  assert.deepEqual([c.a.orders.length, c.b.orders.length], [1, 1]);

  // An hour later the owner closes again: a reduce-only close cannot double anything, so it goes out at once.
  c.shared.now += 3_600_000;
  const again = await c.trader.close({ reason: 'close again' });
  assert.equal(again.status, 'closed');
  assert.deepEqual(c.a.orders.map((o) => [o.side, o.reduceOnly]), [['SELL', true], ['SELL', true]]);
  assert.deepEqual([c.a.pos, c.b.pos], [0n, 0n]);
  assert.equal(c.trader.unhedged, null);
  assert.equal(c.trader.unsettled(c.a)?.until, until, 'the old order stays watched until its own window ends');
  assert.equal((await c.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'stuck', 'open still waits for it');
  // Its window ends: read once more, it never ran; the open goes out.
  c.shared.now = until + 1;
  assert.equal((await c.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'open');
  assert.deepEqual(c.watches.map((w) => w.status), ['lapsed']);

  // The second close's reduce-only gets no answer too: both are watched, until the later window ends.
  const d = setup({ pos: '0.005', script: ['unknown-none', 'unknown-none'] }, { pos: '-0.005' });
  assert.equal((await d.trader.close({ reason: 'close' })).status, 'unhedged');
  d.shared.now += 60_000;
  assert.equal((await d.trader.close({ reason: 'close again' })).status, 'unhedged');
  assert.deepEqual(d.trader.unsettled(d.a)!.refs.map((r) => r.orderId), ['hyperliquid-1', 'hyperliquid-2']);
  assert.equal(d.trader.unsettled(d.a)!.until, 1_060_000 + UNSETTLED_WATCH_MS);
  d.a.pos = 0n;                                      // one of them lands
  await d.trader.positionPushed(d.a, 0n);
  assert.deepEqual(d.watches.map((w) => w.status), ['settled']);
  assert.match(d.watches[0]!.notes.join(' '), /one of the hyperliquid orders with no answer \(hyperliquid-1, hyperliquid-2\) ran: 0\.005 -> 0; the others stay watched/);
  assert.equal(d.trader.unhedged, null);
  assert.ok(d.trader.watching(d.a), 'which one ran is not known');

  // A close that would reopen that leg against the other one is not sent: it is not reduce-only.
  const g = setup({ pos: '0.005', script: ['unknown-none', { partial: '0.003' }, 'fail'] }, { pos: '-0.005', script: ['fail', 'fail', 'fail'] });
  assert.equal((await g.trader.close({ reason: 'close' })).status, 'stuck');
  const r = await g.trader.close({ reason: 'close again' });
  assert.equal(r.status, 'unhedged');
  assert.deepEqual(g.a.orders.map((o) => [o.side, o.reduceOnly]), [['SELL', true], ['SELL', true], ['SELL', true]], 'no BUY on Hyperliquid');
  assert.match(r.notes.join(' '), /not re-hedged: hyperliquid has SELL \S+ reduce-only \(hyperliquid-1\) with no answer, which may still run until \S+; an order on it that is not reduce-only could double that/);
  assert.match(g.trader.unhedged ?? '', /^unhedged: hyperliquid holds 0\.002, orderly holds -0\.005, which do not offset each other$/);

  // The pending order is on the leg hedged against: the old SELL runs after the second close read Hyperliquid, so the
  // new reduce-only SELL is refused twice on a leg it already closed. Orderly is not reopened against it.
  const h = setup({ pos: '0.005', script: ['unknown-none', 'fail', 'fail'] }, { pos: '-0.005' });
  assert.equal((await h.trader.close({ reason: 'close' })).status, 'unhedged');
  const order = h.a.order.bind(h.a);
  h.a.order = async (side, size, reduceOnly, reason) => {
    h.a.pos = 0n;                                     // the old SELL runs now
    return order(side, size, reduceOnly, reason);
  };
  const h2 = await h.trader.close({ reason: 'close again' });
  assert.equal(h2.status, 'unhedged', 'not stuck: Orderly would be open alone');
  assert.deepEqual(h.b.orders.map((o) => [o.side, o.reduceOnly]), [['BUY', true]], 'Orderly not reopened');
  assert.match(h2.notes.join(' '), /not re-hedged: hyperliquid has SELL \S+ reduce-only \(hyperliquid-1\) with no answer, which may still run until \S+; it may have run since hyperliquid was read, and orderly reopened against it would then be open alone/);
  assert.notEqual(h.trader.unhedged, null);
});

test('an open whose Hyperliquid read failed: when the leg reads again unmoved, Orderly goes back as a first read would have sent it', async () => {
  const s = setup({ script: ['unknown-lost'] });
  const r = await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r.status, 'unhedged');
  assert.deepEqual([s.a.pos, s.b.pos], [0n, q('-0.005')]);
  assert.match(r.notes.join(' '), /when hyperliquid reads again unmoved, orderly goes back to its start 0 reduce-only/);
  // An hour later the watch reads Hyperliquid, unmoved: its BUY had not run.
  s.shared.now += 3_600_000;
  s.a.unreadable = false;
  await s.trader.positionPushed(s.a, 0n);
  assert.deepEqual(s.watches.map((w) => w.status), ['rehedged']);
  assert.match(s.watches[0]!.notes.join(' '), /as the first read would have: orderly back to its start 0 reduce-only/);
  assert.deepEqual(s.b.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['SELL', '0.005', false], ['BUY', '0.005', true]]);
  assert.deepEqual([s.a.pos, s.b.pos], [0n, 0n]);
  assert.equal(s.trader.unhedged, null);
  assert.equal(s.trader.intent(s.a), 0n, 'what offsets Orderly now');
  assert.ok(s.trader.watching(s.a), 'the BUY may still run');
  // It lands a day later: closed back reduce-only, flat again.
  s.shared.now += 86_400_000;
  s.a.pos = q('0.005');
  await s.trader.positionPushed(s.a, s.a.pos);
  assert.deepEqual(s.watches.map((w) => w.status), ['rehedged', 'reconciled']);
  assert.deepEqual(s.a.orders.map((o) => [o.side, o.reduceOnly]), [['BUY', false], ['SELL', true]]);
  assert.deepEqual([s.a.pos, s.b.pos], [0n, 0n]);

  // Or the owner closes first: the close is not refused, and a later read has nothing left to unwind.
  const c = setup({ script: ['unknown-lost'] });
  assert.equal((await c.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'unhedged');
  c.shared.now += 3_600_000;
  c.a.unreadable = false;
  assert.equal((await c.trader.close({ reason: 'close' })).status, 'closed');
  assert.deepEqual([c.a.pos, c.b.pos], [0n, 0n]);
  assert.equal(c.a.orders.length, 1);
  assert.ok(c.trader.watching(c.a));
  await c.trader.positionPushed(c.a, 0n);
  assert.equal(c.b.orders.length, 2);

  // Or it is not read again until its window ends: the read then shows it never ran, and Orderly goes back.
  const l = setup({ script: ['unknown-lost'] });
  assert.equal((await l.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'unhedged');
  l.shared.now = l.trader.unsettled(l.a)!.until + 1;
  l.a.unreadable = false;
  await l.trader.positionPushed(l.a, 0n);
  assert.deepEqual(l.watches.map((w) => w.status), ['rehedged']);
  assert.deepEqual([l.a.pos, l.b.pos], [0n, 0n]);
  assert.equal(l.trader.unsettled(l.a), null);
});

test('a deferred unwind whose Orderly read fails waits, alerted once, and goes out on a later read', async () => {
  const f = setup({ script: ['unknown-lost'] });
  assert.equal((await f.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'unhedged');
  f.a.unreadable = false;
  f.b.unreadable = true;
  await f.trader.positionPushed(f.a, 0n);
  assert.deepEqual(f.watches.map((w) => w.status), ['unhedged']);
  assert.match(f.watches[0]!.notes.join(' '), /orderly cannot be read, so its unwind to 0 waits; it is tried again on the next read of hyperliquid/);
  assert.equal(f.b.orders.length, 1);
  await f.trader.positionPushed(f.a, 0n);              // still unreadable: tried again, not alerted again
  assert.equal(f.watches.length, 1);
  f.b.unreadable = false;
  await f.trader.positionPushed(f.a, 0n);
  assert.deepEqual(f.watches.map((w) => w.status), ['unhedged', 'rehedged']);
  assert.deepEqual(f.b.orders.map((o) => [o.side, o.reduceOnly]), [['SELL', false], ['BUY', true]]);
  assert.deepEqual([f.a.pos, f.b.pos], [0n, 0n]);
  assert.equal(f.trader.unhedged, null);

  // At the end of the window: the entry stays while the unwind waits, and open stays refused.
  const w = setup({ script: ['unknown-lost'] });
  assert.equal((await w.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'unhedged');
  w.shared.now = w.trader.unsettled(w.a)!.until + 1;
  w.a.unreadable = false;
  w.b.unreadable = true;
  await w.trader.positionPushed(w.a, 0n);
  assert.deepEqual(w.watches.map((x) => x.status), ['unhedged']);
  assert.notEqual(w.trader.unsettled(w.a), null);
  const blocked = await w.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(blocked.status, 'unhedged');
  assert.match(blocked.notes[0]!, /^open refused, nothing sent: the hyperliquid BUY \S+ \(hyperliquid-1\) can no longer run, but orderly could not be read for the unwind that waits on it/);
  w.b.unreadable = false;
  await w.trader.positionPushed(w.a, 0n);
  assert.deepEqual(w.watches.map((x) => x.status), ['unhedged', 'rehedged']);
  assert.deepEqual([w.a.pos, w.b.pos], [0n, 0n]);
  assert.equal(w.trader.unsettled(w.a), null);

  // A close that finishes first ends the wait: a later read unwinds nothing.
  const c = setup({ script: ['unknown-lost'] });
  assert.equal((await c.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'unhedged');
  c.a.unreadable = false;
  c.b.unreadable = true;
  await c.trader.positionPushed(c.a, 0n);
  c.b.unreadable = false;
  assert.equal((await c.trader.close({ reason: 'close' })).status, 'closed');
  const sent = c.b.orders.length;
  await c.trader.positionPushed(c.a, 0n);
  assert.equal(c.b.orders.length, sent);
});

test('at the end of its window the leg is read once more: a landing in the last seconds is seen; an unreadable leg keeps the alert', async () => {
  const c = setup({ pos: '0.005', script: ['unknown-none'] }, { pos: '-0.005' });
  assert.equal((await c.trader.close({ reason: 'close' })).status, 'unhedged');
  const until = c.trader.unsettled(c.a)!.until;
  c.shared.now = until - 1_000;
  c.a.pos = 0n;                                       // the SELL runs in the last second, after the last poll's read
  c.shared.now = until + 1;
  await c.trader.positionPushed(c.a, q('0.005'));     // that stale read
  assert.deepEqual(c.watches.map((w) => w.status), ['settled']);
  assert.match(c.watches[0]!.notes.join(' '), /which had no answer, ran: 0\.005 -> 0/);
  assert.equal(c.trader.unhedged, null);
  assert.equal(c.trader.unsettled(c.a), null);
  assert.equal(c.a.orders.length, 1);

  // A stuck open, hedged, whose leg cannot be read when the window ends: not 'lapsed', the alert.
  const o = setup({ script: ['unknown-none'] });
  assert.equal((await o.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'stuck');
  o.shared.now = o.trader.unsettled(o.a)!.until + 1;
  o.a.unreadable = true;
  await o.trader.positionPushed(o.a, 0n);
  assert.deepEqual(o.watches.map((w) => w.status), ['unhedged']);
  assert.match(o.trader.unhedged ?? '', /^unhedged: hyperliquid BUY \S+ \(hyperliquid-1\) had no answer; since \S+ it can no longer run, but hyperliquid cannot be read: whether it ran is unknown, and the leg counts as open$/);
  assert.equal(o.trader.unsettled(o.a), null);

  // The last read shows a part-run, and the reduce-only close of the rest has no answer too: it is watched anew.
  const t = setup({ pos: '0.005', script: ['unknown-none', 'unknown-none'] }, { pos: '-0.005' });
  assert.equal((await t.trader.close({ reason: 'close' })).status, 'unhedged');
  const end = t.trader.unsettled(t.a)!.until;
  t.a.pos = q('0.002');                               // part of the SELL ran
  t.shared.now = end + 1;
  await t.trader.positionPushed(t.a, q('0.005'));
  assert.deepEqual(t.watches.map((w) => w.status), ['unhedged']);
  assert.deepEqual(t.a.orders.map((x) => [x.side, x.size, x.reduceOnly]), [['SELL', '0.005', true], ['SELL', '0.002', true]]);
  assert.equal(t.trader.unsettled(t.a)?.until, end + 1 + UNSETTLED_WATCH_MS, 'the new SELL is watched for its own window');
  assert.ok(t.trader.watching(t.a));
});

test('the unsettled watch reads Hyperliquid itself every 15 s (nothing pushes it) until the order runs or cannot', async () => {
  let c!: ReturnType<typeof setup>;
  const st = steppedSleep(() => c.shared);
  c = setup({ pos: '0.005', script: ['unknown-none'] }, { pos: '-0.005' }, { sleep: st.sleep, unsettledPollMs: UNSETTLED_POLL_MS });
  assert.equal((await c.trader.close({ reason: 'close' })).status, 'unhedged');
  assert.equal(st.waiting(), 1, 'the poll sleeps');
  const reads = c.a.reads.length;
  await st.step();
  assert.equal(c.a.reads.length, reads + 1);
  assert.equal(c.watches.length, 0, 'unmoved: the order has not run');
  assert.equal(st.waiting(), 1);
  c.a.pos = 0n;                                       // the order runs
  await st.step();
  assert.deepEqual(c.watches.map((w) => w.status), ['settled']);
  assert.equal(c.trader.unhedged, null);
  await st.step();
  assert.equal(st.waiting(), 0, 'nothing left to watch: the poll ends');

  // The window ends on the poll: the alert again, and the poll ends.
  let l!: ReturnType<typeof setup>;
  const sl = steppedSleep(() => l.shared);
  l = setup({ pos: '0.005', script: ['unknown-none'] }, { pos: '-0.005' }, { sleep: sl.sleep, unsettledPollMs: UNSETTLED_POLL_MS });
  assert.equal((await l.trader.close({ reason: 'close' })).status, 'unhedged');
  l.shared.now = l.trader.unsettled(l.a)!.until - 1_000;
  await sl.step();                                    // 15 s on: past the window
  assert.deepEqual(l.watches.map((w) => w.status), ['unhedged']);
  assert.match(l.trader.unhedged ?? '', /never ran/);
  assert.equal(sl.waiting(), 0);
});

test('stop() ends the unsettled poll, and on the real clock its timer never keeps the process alive', async () => {
  let c!: ReturnType<typeof setup>;
  const st = steppedSleep(() => c.shared);
  c = setup({ pos: '0.005', script: ['unknown-none'] }, { pos: '-0.005' }, { sleep: st.sleep, unsettledPollMs: UNSETTLED_POLL_MS });
  assert.equal((await c.trader.close({ reason: 'close' })).status, 'unhedged');
  assert.equal(st.waiting(), 1);
  const reads = c.a.reads.length;
  c.trader.stop();
  await st.step();
  assert.equal(c.a.reads.length, reads, 'no read after stop()');
  assert.equal(st.waiting(), 0, 'the poll ended');
  assert.notEqual(c.trader.unsettled(c.a), null, 'what it watched stays: open still refuses');
  assert.equal((await c.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'unhedged');
  assert.equal(c.a.orders.length, 1);

  // The real clock: the poll's 60 s timer is unref'd, and stop() ends it.
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  const shared: Shared = { started: 0, overlap: false, now: Date.now() };
  const a = new FakeLeg('hyperliquid', shared, { pos: '0.005', script: ['unknown-none'] });
  const b = new FakeLeg('orderly', shared, { pos: '-0.005' });
  const lines: string[] = [];
  const trader = new PairTrader({ legs: [a, b], priceBandBps: 0, unsettledPollMs: 60_000, clock: { now: () => shared.now }, log: (l) => lines.push(l) });
  assert.equal((await trader.close({ reason: 'close' })).status, 'unhedged');
  assert.ok(trader.watching(a));
  assert.equal(timers(), before, 'a 2-day watch must not keep a CLI alive');
  const readsBefore = a.reads.length;
  trader.stop();
  await ticks(20);
  assert.equal(a.reads.length, readsBefore, 'stop() woke the poll, which ended without a read');
  assert.ok(!lines.some((l) => /watch stopped/.test(l)));
});

test('hyperliquid MPC timeout: no signed payload, so no expiry; nothing ran when read, so it is never retried', async () => {
  // The real leg: the relayer's MPC call timed out, the venue shows no position.
  const shared: Shared = { started: 0, overlap: false, now: 1_000_000 };
  const sent: HlOrder[] = [];
  const hl = new HlLeg({
    relayer: { hlOrder: async (order) => { sent.push(order); throw new MpcTimeoutError('hl_order', 'no signature within 120 s'); } },
    info: async () => ({ assetPositions: [] }), user: '0xabc', coin: 'ETH', asset: 4, szDecimals: 4, oraclePx: async () => 2500, bandBps: 500,
    maxNotionalUsd: 50, bestPx: async (side) => (side === 'BUY' ? 2500 : 2499), clock: { now: () => shared.now },
  });
  const b = new FakeLeg('orderly', shared);
  const sleeps: number[] = [];
  const trader = new PairTrader({
    legs: [hl, b], priceBandBps: 0, unsettledPollMs: null, clock: { now: () => shared.now },
    sleep: async (ms) => { sleeps.push(ms); shared.now += ms; },
  });
  const r = await trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r.status, 'stuck');
  assert.equal(sent.length, 1, 'a retry could double the order when the late signature lands');
  assert.equal(r.legs[0].orders[0]!.outcome, 'unknown');
  assert.deepEqual(sleeps, [], 'no expiry to wait for');
  assert.deepEqual(b.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['SELL', '0.005', false], ['BUY', '0.005', true]]);
  assert.match(r.notes.join(' '), /no answer and no expiry/);
});

test('replayed fill: a copy of the filled Orderly IOC is seen on the position read and closed reduce-only', async () => {
  const s = setup({}, { script: ['copy'] });
  const r = await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r.status, 'open');
  assert.deepEqual([s.a.pos, s.b.pos], [q('0.005'), q('-0.005')]);
  assert.deepEqual(s.b.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['SELL', '0.005', false], ['BUY', '0.005', true]]);
  assert.deepEqual(r.legs[1].orders.map((o) => o.purpose), ['open', 'excess']);
  assert.ok(s.lines.some((l) => /holds -0.01, target -0.005: closing 0.005 reduce-only/.test(l)));
});

test('replayed fill later in the window: a push over the intent is closed; after the window it is left alone', async () => {
  const s = setup();
  await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.ok(s.trader.watching(s.b));
  s.b.pos = q('-0.01');                              // the copy lands a minute later
  s.shared.now += 60_000;
  await s.trader.positionPushed(s.b, s.b.pos);
  assert.equal(s.b.pos, q('-0.005'));
  assert.deepEqual(s.b.orders.at(-1), { side: 'BUY', size: '0.005', reduceOnly: true, reason: 'reconcile PERP_ETH_USDC: close 0.005 over the target' });
  assert.equal(s.trader.lastWatch?.status, 'reconciled');
  assert.equal(s.trader.lastWatch?.legs[0]!.final, '-0.005');
  // A push at the intent sends nothing.
  const sent = s.b.orders.length;
  await s.trader.positionPushed(s.b, q('-0.005'));
  assert.equal(s.b.orders.length, sent);
  // Past the window nothing is watched any more.
  s.shared.now += REPLAY_WINDOW_MS + 1;
  s.b.pos = q('-0.01');
  await s.trader.positionPushed(s.b, s.b.pos);
  assert.equal(s.b.orders.length, sent);
  assert.equal(s.trader.watching(s.b), false);
  // Hyperliquid legs are not watched for copies: a late signature of an order with no answer is handled by its
  // expiry (or, without one, by never retrying it), see the tests above.
  assert.equal(s.trader.watching(s.a), false);
});

test('the watch holds each leg to the pair\'s final intent: after a flat open that is the start, not the order\'s target', async () => {
  // Orderly's open order has no answer and had not run; its retry is refused; Hyperliquid is unwound: flat.
  const s = setup({}, { script: ['unknown-none', 'fail'] });
  const r = await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r.status, 'flat');
  assert.equal(s.trader.intent(s.b), 0n);
  // The first order's copy lands later: Orderly is short alone. Against the open's target it would look right.
  s.b.pos = q('-0.005');
  s.shared.now += 30_000;
  await s.trader.positionPushed(s.b, s.b.pos);
  assert.equal(s.b.pos, 0n);
  assert.equal(s.trader.lastWatch?.status, 'reconciled');
  assert.deepEqual(s.b.orders.at(-1), { side: 'BUY', size: '0.005', reduceOnly: true, reason: 'reconcile PERP_ETH_USDC: close 0.005 over the target' });
});

test('every signed order arms the watch for its whole window, a refused or unfilled one too; a local check does not', async () => {
  const s = setup({}, { script: ['fail', 'fail'] });
  assert.equal((await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'flat');
  assert.ok(s.trader.watching(s.b), 'a cancelled IOC was signed: its copy can be sent again and fill');
  s.shared.now += REPLAY_WINDOW_MS - 1_000;
  s.b.pos = q('-0.005');
  await s.trader.positionPushed(s.b, s.b.pos);
  assert.equal(s.b.pos, 0n);

  const local = setup({}, { script: ['check', 'check'] });
  assert.equal((await local.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'flat');
  assert.equal(local.trader.watching(local.b), false, 'nothing was signed: there is no copy to watch for');
});

test('a deficit push: the partner closes reduce-only by as much; one it cannot close leaves the pair unhedged', async () => {
  const s = setup();
  await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  s.b.pos = q('-0.003');                             // a copy of a reducing order landed
  s.shared.now += 30_000;
  await s.trader.positionPushed(s.b, s.b.pos);
  assert.equal(s.trader.lastWatch?.status, 'rehedged');
  assert.deepEqual(s.a.orders.at(-1), { side: 'SELL', size: '0.002', reduceOnly: true, reason: 'reconcile ETH: close 0.002 its partner lost' });
  assert.deepEqual([s.a.pos, s.b.pos], [q('0.003'), q('-0.003')]);
  assert.deepEqual(s.trader.lastWatch?.legs.map((l) => l.orders.map((o) => o.purpose)), [[], ['deficit']]);
  assert.match(s.trader.lastWatch!.notes.join(' '), /unhedged: orderly holds -0.003, 0.002 short of its intent -0.005/);
  assert.equal(s.trader.unhedged, null);
  // The smaller pair is the intent now: the same push again sends nothing.
  const sent = s.a.orders.length + s.b.orders.length;
  await s.trader.positionPushed(s.b, q('-0.003'));
  assert.equal(s.a.orders.length + s.b.orders.length, sent);

  const stuck = setup({ script: ['fill', 'fail'] });
  await stuck.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  stuck.b.pos = q('-0.003');
  await stuck.trader.positionPushed(stuck.b, stuck.b.pos);
  assert.equal(stuck.trader.lastWatch?.status, 'unhedged');
  assert.match(stuck.trader.unhedged ?? '', /short of its intent/);
});

test('a filled Orderly leg whose read fails counts the fill, and stays watched', async () => {
  const s = setup({}, { script: ['fill-unreadable'] });
  const r = await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r.status, 'open');
  assert.equal(r.legs[1].final, '-0.005');
  assert.ok(s.trader.watching(s.b));
  assert.ok(s.lines.some((l) => /position unreadable after a fill .*counting 0 plus the fill = -0.005, the replay watch stays on/.test(l)));
});

test('reduce-only moves split into orders under the policy cap, floored to the lot', async () => {
  const s = setup({ pos: '0.01', max: '0.00456' }, { pos: '-0.01', max: '0.004' });
  const r = await s.trader.close({ reason: 'close' });
  assert.equal(r.status, 'closed');
  assert.deepEqual(s.a.orders.map((o) => [o.size, o.reduceOnly]), [['0.0045', true], ['0.0045', true], ['0.001', true]]);
  assert.deepEqual(s.b.orders.map((o) => [o.size, o.reduceOnly]), [['0.004', true], ['0.004', true], ['0.002', true]]);
  assert.deepEqual([s.a.pos, s.b.pos], [0n, 0n]);
});

test('reduce-only chunks are sized under the cap by the price band: an uptick between sizing and sending still fits', async () => {
  // Hyperliquid's cap is 12.5 USD; each order is priced again after it was sized, 40 bps higher from the second on.
  const hl: FakeOptions = { pos: '0.01', lot: '0.000001', capUsd: 12.5, px: 2500, upticksBps: [0, 40] };
  const tight = setup({ ...hl }, { pos: '-0.01' });
  assert.equal((await tight.trader.close({ reason: 'close' })).status, 'stuck', 'sized at the cap, the uptick put the second chunk and its retry over it');
  assert.deepEqual(tight.a.orders.map((o) => [o.size, o.reduceOnly]), [['0.005', true], ['0.005', true], ['0.00498', true]]);
  assert.deepEqual(tight.b.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['BUY', '0.01', true], ['SELL', '0.005', false]], 'Orderly reopened against the half left');
  assert.deepEqual([tight.a.pos, tight.b.pos], [q('0.005'), q('-0.005')]);

  const banded = setup({ ...hl }, { pos: '-0.01' }, { priceBandBps: 100 });
  assert.equal((await banded.trader.close({ reason: 'close' })).status, 'closed');
  assert.deepEqual(banded.a.orders.map((o) => o.size), ['0.00495', '0.00495', '0.0001']);
  assert.deepEqual([banded.a.pos, banded.b.pos], [0n, 0n]);
  assert.ok(banded.lines.some((l) => /splitting into orders of 0\.00495 \(the cap less the 100 bps band\)/.test(l)));

  // Wide bands: cap × 10^4 / (10^4 + band), so 9000 bps is a little over half the cap, 10000 bps half of it.
  const wide = setup({ ...hl }, { pos: '-0.01' }, { priceBandBps: 9000 });
  assert.equal((await wide.trader.close({ reason: 'close' })).status, 'closed');
  assert.deepEqual(wide.a.orders.map((o) => o.size).slice(0, 2), ['0.002631', '0.002631']);
  assert.equal(wide.a.orders.length, 4, 'not 20 orders of a tenth of the cap');
  const widest = setup({ ...hl }, { pos: '-0.01' }, { priceBandBps: 10_000 });
  assert.equal((await widest.trader.close({ reason: 'close' })).status, 'closed');
  assert.deepEqual(widest.a.orders.map((o) => o.size).slice(0, 2), ['0.0025', '0.0025'], 'half the cap, not the whole cap');
  assert.ok(widest.a.orders.length <= 5);
  assert.deepEqual([widest.a.pos, widest.b.pos], [0n, 0n]);
  // A cap of one lot: nothing smaller can be sent, so one lot.
  const tiny = setup({ pos: '0.000003', lot: '0.000001', capUsd: 0.0025, px: 2500 }, { pos: '-0.000003', lot: '0.000001' }, { priceBandBps: 10_000 });
  assert.equal((await tiny.trader.close({ reason: 'close' })).status, 'closed');
  assert.deepEqual(tiny.a.orders.map((o) => o.size), ['0.000001', '0.000001', '0.000001']);

  assert.throws(() => setup({}, {}, { priceBandBps: -1 }), /priceBandBps must be 0 or more/);
});

test('a close that needs more than MAX_CLOSE_ORDERS orders on a leg at today\'s cap is refused before anything is sent', async () => {
  const hl: FakeOptions = { pos: '0.3', lot: '0.000001', capUsd: 12.5, px: 2500 };
  const s = setup(hl, { pos: '-0.3' }, { priceBandBps: 10_000 });
  const r = await s.trader.close({ reason: 'close' });
  assert.equal(r.status, 'stuck', 'hedged as it was');
  assert.equal(MAX_CLOSE_ORDERS, 40);
  assert.match(r.notes[0]!, /^close refused, nothing sent: hyperliquid needs 120 reduce-only orders of at most 0\.0025 \(the policy cap less the 10000 bps band\) to go from 0\.3 to 0, over 40; close in parts \(targets\) or raise the cap$/);
  assert.deepEqual([s.a.orders.length, s.b.orders.length], [0, 0]);
  assert.deepEqual([r.legs[0].final, r.legs[1].final], ['0.3', '-0.3']);
  // In parts: a close to targets that one leg can reach in 40 orders goes out.
  const part = await s.trader.close({ reason: 'close part', targets: [q('0.2'), q('-0.2')] });
  assert.equal(part.status, 'closed');
  assert.equal(s.a.orders.length, 40);
});

test('one queued check per leg, and the window is checked again when its turn comes', async () => {
  const s = setup();
  await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  s.b.pos = q('-0.01');
  const first = s.trader.positionPushed(s.b, q('-0.0098'));
  const second = s.trader.positionPushed(s.b, q('-0.01'));
  assert.equal(first, second, 'the second push is covered by the queued check, which reads the venue itself');
  await first;
  assert.deepEqual(s.b.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['SELL', '0.005', false], ['BUY', '0.005', true]]);

  // A push queued behind a close whose window ends before its turn comes sends nothing.
  let release!: () => void;
  s.a.script.push({ hold: new Promise<void>((resolve) => { release = resolve; }) });
  const closing = s.trader.close({ reason: 'close' });
  await ticks(40);
  const queued = s.trader.positionPushed(s.b, 0n);
  s.shared.now += REPLAY_WINDOW_MS + 1;
  release();
  assert.equal((await closing).status, 'closed');
  const sent = s.b.orders.length;
  s.b.pos = q('-0.005');
  await queued;
  assert.equal(s.b.orders.length, sent);
});

test('close mirrors open: both legs close reduce-only together; an already flat pair sends nothing', async () => {
  const s = setup({ pos: '0.005' }, { pos: '-0.005' });
  const r = await s.trader.close({ reason: 'close' });
  assert.equal(r.status, 'closed');
  assert.deepEqual([s.a.pos, s.b.pos], [0n, 0n]);
  assert.deepEqual([s.a.orders[0]!.reduceOnly, s.b.orders[0]!.reduceOnly], [true, true]);
  assert.ok(s.shared.overlap);
  const again = await s.trader.close({ reason: 'close' });
  assert.equal(again.status, 'closed');
  assert.equal(s.a.orders.length + s.b.orders.length, 2);
});

test('close: a leg that stays open after its retry gets its partner reopened against it (hedged, stuck)', async () => {
  const s = setup({ pos: '0.005' }, { pos: '-0.005', script: ['fail', 'fail'] });
  const r = await s.trader.close({ reason: 'close' });
  assert.equal(r.status, 'stuck');
  assert.deepEqual([s.a.pos, s.b.pos], [q('0.005'), q('-0.005')], 'hedged again, never one leg alone');
  assert.deepEqual(s.a.orders.map((o) => [o.side, o.reduceOnly]), [['SELL', true], ['BUY', false]]);
  assert.deepEqual(r.legs[0].orders.map((o) => o.purpose), ['close', 'rehedge']);

  const naked = setup({ pos: '0.005', script: ['fill', 'fail'] }, { pos: '-0.005', script: ['fail', 'fail'] });
  const r2 = await naked.trader.close({ reason: 'close' });
  assert.equal(r2.status, 'unhedged', 'the re-hedge was refused: the owner must act');
  assert.notEqual(naked.trader.unhedged, null);
});

test('reducedTarget: excess on the target side, the other side closes to 0, deficits are left', () => {
  assert.equal(reducedTarget(q('0.01'), q('0.005')), q('0.005'));
  assert.equal(reducedTarget(q('-0.01'), q('-0.005')), q('-0.005'));
  assert.equal(reducedTarget(q('0.004'), q('0.005')), null, 'a deficit');
  assert.equal(reducedTarget(q('-0.002'), q('0.005')), 0n, 'the wrong side closes to 0');
  assert.equal(reducedTarget(0n, q('0.005')), null);
  assert.equal(reducedTarget(q('0.003'), 0n), 0n);
  assert.equal(reducedTarget(q('0.005'), q('0.005')), null);
});
