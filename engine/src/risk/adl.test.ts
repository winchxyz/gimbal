// ADL detection against a real PairTrader on fake legs: a leg that shrank with no order of ours is re-hedged (or both
// legs unwound when little is left), while our own fills, an open in flight, and an Orderly leg inside its replay
// window never look like ADL.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VenueId } from '@gimbal/shared';
import type { LegOutcome, LegSide, TradeLeg } from '../trade/legs.ts';
import { toQty } from '../trade/lots.ts';
import { PairTrader } from '../trade/pair.ts';
import type { AdlTrader } from './adl.ts';
import { AdlWatch, CONFIRM_MS, RETRY_MS, UNWIND_BELOW, adlJournal, legChange } from './adl.ts';

class Leg implements TradeLeg {
  readonly venue: VenueId;
  readonly symbol = 'ETH';
  readonly lot: bigint;
  readonly replayable: boolean;
  pos = 0n;
  orders: { side: LegSide; size: bigint; reduceOnly: boolean }[] = [];
  /** The next order waits for this before it fills. */
  hold: Promise<void> | null = null;
  /** Called after the next position read answers (a test's hook into the read). */
  onRead: (() => void) | null = null;
  /** Answers to the next position reads, in place of `pos` (a bad read). */
  reads: bigint[] = [];
  /** An order this says yes to fails (the venue refused it: proof nothing ran). */
  reject: (side: LegSide, reduceOnly: boolean) => boolean = () => false;
  /** Fills at most this much more in all (then refuses): a venue that fills part of a reduction and stops. */
  capacity: bigint | null = null;
  readonly #now: () => number;

  constructor(venue: VenueId, now: () => number, replayable = false, lot = '0.001') {
    this.venue = venue;
    this.lot = toQty(lot);
    this.replayable = replayable;
    this.#now = now;
  }
  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return toQty('1000');
  }
  async position(): Promise<bigint> {
    const p = this.reads.length > 0 ? this.reads.shift()! : this.pos;
    const hook = this.onRead;
    this.onRead = null;
    hook?.();
    return p;
  }
  async order(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    if (size % this.lot !== 0n) throw new Error(`${this.venue}: ${size} is not a whole number of lots`);
    this.orders.push({ side, size, reduceOnly });
    const ref = { venue: this.venue, side, size: String(size), reduceOnly, orderId: null, clientId: null, tx: [], sentAt: this.#now() };
    if (this.reject(side, reduceOnly)) return { kind: 'failed', error: new Error('refused'), ref };
    if (reduceOnly) {
      // A reduce-only order never grows a position.
      const next = this.pos + (side === 'BUY' ? size : -size);
      if ((this.pos >= 0n && next > this.pos) || (this.pos <= 0n && next < this.pos)) return { kind: 'failed', error: new Error('reduce-only would increase'), ref };
    }
    if (this.hold !== null) {
      const h = this.hold;
      this.hold = null;
      await h;
    }
    if (this.capacity !== null) {
      if (this.capacity === 0n) return { kind: 'failed', error: new Error('refused: no liquidity'), ref };
      if (size > this.capacity) size = this.capacity;
      this.capacity -= size;
    }
    this.pos += side === 'BUY' ? size : -size;
    return {
      kind: 'filled', filled: size, avgPx: 2000,
      ref: { venue: this.venue, side, size: String(size), reduceOnly, orderId: `o${this.orders.length}`, clientId: null, tx: [], sentAt: this.#now() },
    };
  }
}

function setup(options: { replayable?: boolean; otherLot?: string } = {}) {
  let now = 1_000_000;
  const clock = { now: () => now };
  const hl = new Leg('hyperliquid', clock.now);
  const other = new Leg(options.replayable ? 'orderly' : 'phoenix', clock.now, options.replayable ?? false, options.otherLot ?? '0.001');
  const trader = new PairTrader({ legs: [hl, other], priceBandBps: 100, clock, unsettledPollMs: null });
  const lines: string[] = [];
  const sleeps: number[] = [];
  const adl = new AdlWatch(trader, { log: (l) => lines.push(l), clock, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  return { hl, other, trader, adl, lines, sleeps, advance: (ms: number) => { now += ms; } };
}

test('legChange: shrank toward zero, grew, flipped', () => {
  assert.equal(legChange(-500n, -500n), 'same');
  assert.equal(legChange(-500n, -300n), 'shrank');
  assert.equal(legChange(-500n, 0n), 'shrank');
  assert.equal(legChange(500n, 700n), 'grew');
  assert.equal(legChange(500n, -100n), 'flipped');
  assert.equal(legChange(0n, 100n), 'grew');
});

test('a short leg ADL-ed from 0.5 to 0.3 ETH: the partner is reduced by 0.2 reduce-only, level again, journal kind adl', async () => {
  const { hl, other, trader, adl } = setup();
  const opened = await trader.open({ size: '0.5', longIndex: 1, reason: 'enter' });
  assert.equal(opened.status, 'open');
  assert.equal(await adl.check(), null, 'right after our own fills: nothing is off');
  hl.pos = toQty('-0.3');                                  // the venue deleveraged 0.2 of the short
  const report = await adl.check();
  assert.ok(report !== null);
  assert.equal(report.action, 'rehedge');
  assert.deepEqual(report.targets, [toQty('-0.3'), toQty('0.3')]);
  assert.equal(report.result!.status, 'closed');
  assert.equal(other.pos, toQty('0.3'));
  assert.deepEqual(other.orders.at(-1), { side: 'SELL', size: toQty('0.2'), reduceOnly: true });
  assert.equal(hl.orders.length, 1, 'nothing was sent on the leg that shrank');
  assert.equal(trader.intent(hl), toQty('-0.3'));
  assert.equal(trader.intent(other), toQty('0.3'));
  const entry = adlJournal(report, 5);
  assert.equal(entry.kind, 'adl');
  assert.deepEqual(entry.numbers, { venue: 'hyperliquid', before: '-0.5', after: '-0.3', lost: '0.2', action: 'rehedge' });
  assert.match(entry.summary, /^ADL on hyperliquid ETH -0\.5 -> -0\.3 \(shrank without an order of ours\); re-hedging at 0\.3: phoenix 0\.5 -> 0\.3: level again$/);
  // The pair is level at the new size: the next look finds nothing.
  assert.equal(await adl.check(), null);
});

test(`under ${UNWIND_BELOW * 100} % kept (or nothing): both legs are unwound`, async () => {
  const { hl, other, trader, adl } = setup();
  await trader.open({ size: '0.5', longIndex: 0, reason: 'enter' });
  other.pos = toQty('-0.2');                               // 40 % kept
  const report = await adl.check();
  assert.equal(report!.action, 'unwind');
  assert.deepEqual(report!.targets, [0n, 0n]);
  assert.equal(report!.result!.status, 'closed');
  assert.equal(hl.pos, 0n);
  assert.equal(other.pos, 0n);
  assert.match(report!.summary, /unwinding both legs \(40 % kept, under 50 %\)/);

  await trader.open({ size: '0.5', longIndex: 0, reason: 'enter again' });
  hl.pos = 0n;                                             // all of it
  assert.equal((await adl.check())!.action, 'unwind');
  assert.equal(other.pos, 0n);
});

test('our own fills never look like ADL: nothing is checked while an open is in flight', async () => {
  const { hl, other, trader, adl } = setup();
  let release!: () => void;
  hl.hold = new Promise<void>((r) => { release = r; });
  const opening = trader.open({ size: '0.5', longIndex: 1, reason: 'enter' });
  await new Promise((r) => setImmediate(r));
  assert.equal(trader.busy, true);
  assert.equal(await adl.check(), null);
  // An open that started on a pair already open, with one leg part-way: still not ADL.
  release();
  await opening;
  assert.equal(trader.busy, false);
  const second = trader.open({ size: '0.2', longIndex: 1, reason: 'add' });
  assert.equal(await adl.check(), null, 'queued: busy');
  await second;
  assert.equal(other.pos, toQty('0.7'));
  assert.equal(await adl.check(), null);
});

test('an open that starts while the position read is out makes that read stale: it is dropped', async () => {
  const { hl, trader, adl } = setup();
  await trader.open({ size: '0.5', longIndex: 1, reason: 'enter' });
  let opening: Promise<unknown> | null = null;
  // The read answers -0.5 + a part of our new order... modelled as a smaller short, and our open starts meanwhile.
  hl.pos = toQty('-0.4');
  hl.onRead = () => { opening = trader.open({ size: '0.1', longIndex: 1, reason: 'add' }); };
  assert.equal(await adl.check(), null);
  await opening;
});

test('an Orderly leg inside the replay window of our own signed order is the pair trader\'s to reconcile, not ADL', async () => {
  const { other, trader, adl, advance } = setup({ replayable: true });
  await trader.open({ size: '0.5', longIndex: 0, reason: 'enter' });
  assert.equal(trader.watching(other), true);
  other.pos = toQty('-0.3');                               // a copy of a reducing order could do this
  assert.equal(await adl.check(), null);
  advance(400_000);                                        // past Orderly's 300 s window (+10 s)
  assert.equal(trader.watching(other), false);
  const report = await adl.check();
  assert.equal(report!.action, 'rehedge');
});

test('a position that grew or flipped is not ADL: reported, nothing traded; no open yet: nothing to compare', async () => {
  const fresh = setup();
  assert.equal(await fresh.adl.check(), null, 'no intent before the first open');
  const { hl, other, trader, adl } = setup();
  await trader.open({ size: '0.5', longIndex: 1, reason: 'enter' });
  const sent = hl.orders.length + other.orders.length;
  hl.pos = toQty('-0.7');
  const grew = await adl.check();
  assert.equal(grew!.action, 'none');
  assert.match(grew!.summary, /not ADL, nothing traded: hyperliquid ETH grew -0\.5 -> -0\.7/);
  hl.pos = toQty('0.1');
  assert.equal((await adl.check())!.action, 'none');
  assert.equal(hl.orders.length + other.orders.length, sent);
});

test('one bad read is not ADL: the change must be confirmed by a second read 3 s later', async () => {
  const { hl, other, trader, adl, sleeps, lines } = setup();
  await trader.open({ size: '0.5', longIndex: 1, reason: 'enter' });
  // Hyperliquid left the coin out of assetPositions once: the leg reads 0, then -0.5 again.
  hl.reads = [0n];
  assert.equal(await adl.check(), null);
  assert.deepEqual(sleeps, [CONFIRM_MS]);
  assert.ok(lines.some((l) => /not confirmed by a read 3 s later/.test(l)));
  assert.equal(hl.orders.length + other.orders.length, 2, 'nothing traded');
  assert.equal(other.pos, toQty('0.5'));
});

test('a pair that was not hedged before (intents do not offset): nothing traded, the owner must act', async () => {
  // The reviewer's case: the open came back unhedged (HL +1, Phoenix 0), then HL dropped to 0.6.
  const { hl, other, trader, adl } = setup();
  other.reject = () => true;
  hl.reject = (_side, reduceOnly) => reduceOnly;
  const opened = await trader.open({ size: '1', longIndex: 0, reason: 'enter' });
  assert.equal(opened.status, 'unhedged');
  assert.deepEqual([trader.intent(hl), trader.intent(other)], [toQty('1'), 0n]);
  other.reject = () => false;
  hl.reject = () => false;
  const sent = hl.orders.length + other.orders.length;
  hl.pos = toQty('0.6');
  const report = await adl.check();
  assert.equal(report!.action, 'none');
  assert.match(report!.summary, /the pair was not hedged before \(intents 1 and 0\): nothing traded, the owner must act/);
  assert.equal(hl.orders.length + other.orders.length, sent);
  assert.equal(hl.pos, toQty('0.6'));
  assert.equal(other.pos, 0n);
});

test('the ADL close is reduce-only only: when the partner will not reduce, nothing reopens the shrunk leg', async () => {
  const { hl, other, trader, adl } = setup();
  await trader.open({ size: '0.5', longIndex: 1, reason: 'enter' });
  const before = hl.orders.length;
  other.reject = (_side, reduceOnly) => reduceOnly;       // Phoenix refuses every reduce-only order
  hl.pos = toQty('-0.3');
  const report = await adl.check();
  assert.equal(report!.action, 'rehedge');
  assert.notEqual(report!.result!.status, 'closed');
  assert.match(report!.result!.notes.join('; '), /not re-hedged: this close is reduce-only only/);
  assert.equal(hl.orders.length, before, 'no order on the shrunk leg (a re-hedge would have sold it back to -0.5)');
  assert.ok(other.orders.slice(1).every((o) => o.reduceOnly), 'every ADL order is reduce-only');
  assert.equal(hl.pos, toQty('-0.3'));
  assert.equal(other.pos, toQty('0.5'));
});

test('one event, one response: a close that failed is answered once, retried only after the backoff, journaled once', async () => {
  const { hl, other, trader, adl, advance } = setup();
  await trader.open({ size: '0.5', longIndex: 1, reason: 'enter' });
  hl.pos = toQty('-0.3');
  const real = trader.close.bind(trader);
  let calls = 0;
  (trader as unknown as { close: typeof real }).close = async (request) => {
    calls++;
    if (calls === 1) throw new Error('phoenix position read failed');
    return real(request);
  };
  const first = await adl.check();
  assert.match(first!.summary, /failed: phoenix position read failed/);
  assert.equal(first!.result, null);
  assert.equal(first!.retry, 0);
  assert.equal(adlJournal(first!, 1).numbers.retry, undefined);
  // Every 5 s after: the same finding, nothing sent, nothing to journal.
  for (let i = 0; i < 5; i++) {
    advance(5_000);
    assert.equal(await adl.check(), null);
  }
  assert.equal(calls, 1);
  assert.equal(other.pos, toQty('0.5'));
  advance(RETRY_MS);
  const retry = await adl.check();
  assert.equal(calls, 2);
  assert.equal(retry!.retry, 1);
  assert.equal(retry!.result!.status, 'closed');
  assert.equal(adlJournal(retry!, 1).numbers.retry, 1);
  assert.equal(other.pos, toQty('0.3'));
  assert.equal(await adl.check(), null, 'level again: nothing more');
});

test('a reduce-only re-hedge the venue refuses is kept and retried after the backoff, though the trader adopted the positions', async () => {
  const { hl, other, trader, adl, advance, lines } = setup();
  await trader.open({ size: '0.5', longIndex: 1, reason: 'enter' });
  other.reject = (_side, reduceOnly) => reduceOnly;
  hl.pos = toQty('-0.3');
  const first = await adl.check();
  assert.equal(first!.reached, false);
  assert.deepEqual([trader.intent(hl), trader.intent(other)], [toQty('-0.3'), toQty('0.5')], 'the trader adopted the positions');
  assert.ok(lines.some((l) => /tried 1x, next try after/.test(l)));
  const sent = other.orders.length;
  advance(RETRY_MS - 10_000);
  assert.equal(await adl.check(), null, 'inside the backoff');
  assert.equal(other.orders.length, sent);
  other.reject = () => false;
  advance(10_000);
  const retry = await adl.check();
  assert.equal(retry!.retry, 1);
  assert.equal(retry!.reached, true);
  assert.equal(other.pos, toQty('0.3'));
  assert.equal(hl.pos, toQty('-0.3'));
  advance(RETRY_MS * 4);
  assert.equal(await adl.check(), null, 'level: nothing more');
});

test('unwind in two steps: a partner that refuses its reduction leaves the remnant in place, the exposure no larger; retried', async () => {
  // The reviewer's case: intents +1 / -1, HL ADL-ed to 0.3 (30 % kept: unwind), Phoenix refuses reduce-only.
  const { hl, other, trader, adl, advance } = setup();
  await trader.open({ size: '1', longIndex: 0, reason: 'enter' });
  hl.pos = toQty('0.3');
  other.reject = (_side, reduceOnly) => reduceOnly;
  const before = hl.orders.length;
  const report = await adl.check();
  assert.equal(report!.action, 'unwind');
  assert.equal(report!.reached, false);
  assert.match(report!.summary, /levelling at 0\.3 first, then closing both/);
  assert.equal(hl.orders.length, before, 'the remnant (the only hedge left) was not touched');
  assert.equal(hl.pos, toQty('0.3'));
  assert.equal(hl.pos + other.pos, toQty('-0.7'), 'exposure as the ADL left it, not -1');
  // The retry, once Phoenix reduces again: level at 0.3, then both closed.
  other.reject = () => false;
  advance(RETRY_MS);
  const retry = await adl.check();
  assert.equal(retry!.retry, 1);
  assert.equal(retry!.reached, true);
  assert.deepEqual([hl.pos, other.pos], [0n, 0n]);
  assert.ok([...hl.orders.slice(before), ...other.orders.slice(1)].every((o) => o.reduceOnly));
});

test('a re-hedge whose partner fills part of its reduction and stops: the rest is retried from the kept response', async () => {
  const { hl, other, trader, adl, advance } = setup();
  await trader.open({ size: '0.5', longIndex: 1, reason: 'enter' });
  hl.pos = toQty('-0.3');
  other.capacity = toQty('0.05');                          // 0.05 of the 0.2 reduction, then no more
  const first = await adl.check();
  assert.equal(first!.reached, false);
  assert.equal(other.pos, toQty('0.45'));
  other.capacity = null;
  advance(RETRY_MS);
  const retry = await adl.check();
  assert.equal(retry!.reached, true);
  assert.deepEqual([hl.pos, other.pos], [toQty('-0.3'), toQty('0.3')]);
});

test('the kept response is dropped once the pair trader trades on its own', async () => {
  const { hl, other, trader, adl, advance, lines } = setup();
  await trader.open({ size: '0.5', longIndex: 1, reason: 'enter' });
  other.reject = (_side, reduceOnly) => reduceOnly;
  hl.pos = toQty('-0.3');
  await adl.check();
  other.reject = () => false;
  // The owner closes the pair meanwhile.
  await trader.close({ reason: 'owner close' });
  assert.deepEqual([hl.pos, other.pos], [0n, 0n]);
  advance(RETRY_MS);
  const sent = hl.orders.length + other.orders.length;
  assert.equal(await adl.check(), null);
  assert.equal(hl.orders.length + other.orders.length, sent);
  assert.ok(lines.some((l) => /reached the response's targets|traded since the response/.test(l)));
});

test('the size kept is floored to the common lot: HL 0.001, Phoenix 0.01, a short of 0.5 ADL-ed to 0.337 re-hedges at 0.33', async () => {
  const { hl, other, trader, adl } = setup({ otherLot: '0.01' });
  assert.equal(trader.lot, toQty('0.01'));
  await trader.open({ size: '0.5', longIndex: 1, reason: 'enter' });
  hl.pos = toQty('-0.337');
  const report = await adl.check();
  assert.equal(report!.action, 'rehedge');
  assert.equal(report!.reached, true, report!.summary);
  assert.deepEqual(report!.targets, [toQty('-0.33'), toQty('0.33')]);
  // Toward less exposure: the shrunk leg gives up its sub-lot 0.007 too, reduce-only.
  assert.deepEqual([hl.pos, other.pos], [toQty('-0.33'), toQty('0.33')]);
  assert.deepEqual(hl.orders.at(-1), { side: 'BUY', size: toQty('0.007'), reduceOnly: true });
});

test('a leg with an unsettled order, even one past its window that the trader has not closed out, is not checked', async () => {
  const leg = (venue: VenueId, pos: bigint) => ({ venue, symbol: 'ETH', lot: 1n, replayable: false, position: async () => pos }) as unknown as TradeLeg;
  const a = leg('hyperliquid', -30n);
  const b = leg('phoenix', 50n);
  let closes = 0;
  const trader: AdlTrader = {
    legs: [a, b], lot: 1n, busy: false, net: 0n,
    watching: () => false,                                                  // its window has ended...
    unsettled: (l) => (l === a ? { ref: {}, refs: [], until: 0 } : null),   // ...but the trader has not closed it out
    intent: (l) => (l === a ? -50n : 50n),
    close: async () => { closes++; throw new Error('must not close'); },
  };
  assert.equal(await new AdlWatch(trader, { sleep: async () => {} }).check(), null);
  assert.equal(closes, 0);
});
