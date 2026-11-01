// ADL detection against a real PairTrader on fake legs: a leg that shrank with no order of ours is re-hedged (or both
// legs unwound when little is left), while our own fills, an open in flight, and an Orderly leg inside its replay
// window never look like ADL.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VenueId } from '@gimbal/shared';
import type { LegOutcome, LegSide, TradeLeg } from '../trade/legs.ts';
import { toQty } from '../trade/lots.ts';
import { PairTrader } from '../trade/pair.ts';
import { AdlWatch, UNWIND_BELOW, adlJournal, legChange } from './adl.ts';

class Leg implements TradeLeg {
  readonly venue: VenueId;
  readonly symbol = 'ETH';
  readonly lot = toQty('0.001');
  readonly replayable: boolean;
  pos = 0n;
  orders: { side: LegSide; size: bigint; reduceOnly: boolean }[] = [];
  /** The next order waits for this before it fills. */
  hold: Promise<void> | null = null;
  /** Called after the next position read answers (a test's hook into the read). */
  onRead: (() => void) | null = null;
  readonly #now: () => number;

  constructor(venue: VenueId, now: () => number, replayable = false) {
    this.venue = venue;
    this.replayable = replayable;
    this.#now = now;
  }
  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return toQty('1000');
  }
  async position(): Promise<bigint> {
    const p = this.pos;
    const hook = this.onRead;
    this.onRead = null;
    hook?.();
    return p;
  }
  async order(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    this.orders.push({ side, size, reduceOnly });
    if (this.hold !== null) {
      const h = this.hold;
      this.hold = null;
      await h;
    }
    this.pos += side === 'BUY' ? size : -size;
    return {
      kind: 'filled', filled: size, avgPx: 2000,
      ref: { venue: this.venue, side, size: String(size), reduceOnly, orderId: `o${this.orders.length}`, clientId: null, tx: [], sentAt: this.#now() },
    };
  }
}

function setup(options: { replayable?: boolean } = {}) {
  let now = 1_000_000;
  const clock = { now: () => now };
  const hl = new Leg('hyperliquid', clock.now);
  const other = new Leg(options.replayable ? 'orderly' : 'phoenix', clock.now, options.replayable ?? false);
  const trader = new PairTrader({ legs: [hl, other], priceBandBps: 100, clock, unsettledPollMs: null });
  const lines: string[] = [];
  const adl = new AdlWatch(trader, { log: (l) => lines.push(l) });
  return { hl, other, trader, adl, lines, advance: (ms: number) => { now += ms; } };
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
