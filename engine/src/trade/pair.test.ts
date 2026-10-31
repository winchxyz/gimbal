// The pair trader against two scripted fake legs: both legs go out at once, the legging guard retries once and then
// unwinds reduce-only, an unknown outcome is read back from the venue before anything else, an Orderly copy of a
// filled IOC (a replayed fill) is closed as excess, close mirrors open and re-hedges a leg that stays open, and sizes
// are rounded to the common lot before anything is signed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VenueId } from '@gimbal/shared';
import { OutcomeUnknown } from '../contract/types.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import type { LegOutcome, LegRef, LegSide, TradeLeg } from './legs.ts';
import { LegCheckError } from './legs.ts';
import { lotQty, toQty } from './lots.ts';
import { PairTrader, REPLAY_WINDOW_MS, reducedTarget } from './pair.ts';

type Step =
  | 'fill'
  | 'fail'                       // proof nothing ran
  | 'unknown-filled'             // the answer was lost, the order filled
  | 'unknown-none'               // the answer was lost, nothing ran
  | 'unknown-unreadable'         // the answer was lost and the venue cannot be read afterwards
  | 'copy'                       // filled, and a replayed copy of the signed order filled too
  | { partial: string };

interface Shared {
  started: number;
  overlap: boolean;
  now: number;
}

class FakeLeg implements TradeLeg {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly lot: bigint;
  readonly replayable: boolean;
  pos: bigint;
  readonly script: Step[];
  readonly orders: { side: LegSide; size: string; reduceOnly: boolean; reason: string }[] = [];
  unreadable = false;
  readonly #shared: Shared;
  #seq = 0;

  constructor(venue: VenueId, shared: Shared, options: { pos?: string; script?: Step[]; replayable?: boolean; lot?: string } = {}) {
    this.venue = venue;
    this.symbol = venue === 'orderly' ? 'PERP_ETH_USDC' : 'ETH';
    this.lot = lotQty(options.lot ?? '0.0001');
    this.replayable = options.replayable ?? venue === 'orderly';
    this.pos = toQty(options.pos ?? '0');
    this.script = options.script ?? [];
    this.#shared = shared;
  }

  async check(size: bigint): Promise<void> {
    if (size < toQty('0.003')) throw new LegCheckError(`${this.venue}: under the 10 USD minimum`);
  }

  async position(): Promise<bigint> {
    if (this.unreadable) throw new Error(`${this.venue}: venue unreachable`);
    return this.pos;
  }

  async order(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome> {
    this.orders.push({ side, size: String(Number(size) / 1e8), reduceOnly, reason });
    const ref: LegRef = { venue: this.venue, side, size: String(size), reduceOnly, orderId: `${this.venue}-${++this.#seq}`, clientId: null, tx: [], sentAt: this.#shared.now };
    // Both legs of a round reach the venue before either answers: the trader sends them together.
    this.#shared.started++;
    for (let i = 0; i < 20 && this.#shared.started % 2 === 1; i++) await new Promise((r) => setImmediate(r));
    if (this.#shared.started % 2 === 0) this.#shared.overlap = true;
    const step = this.script.shift() ?? 'fill';
    const signed = side === 'BUY' ? size : -size;
    const apply = (q: bigint) => {
      if (reduceOnly) {
        // A venue's reduce-only never grows or flips a position.
        const cap = this.pos > 0n ? -this.pos : -this.pos;
        if ((this.pos > 0n && q > 0n) || (this.pos < 0n && q < 0n) || this.pos === 0n) return 0n;
        if ((q < 0n && q < cap) || (q > 0n && q > cap)) q = cap;
      }
      this.pos += q;
      return q < 0n ? -q : q;
    };
    if (step === 'fail') return { kind: 'failed', error: new NothingExecuted(this.venue, 'refused'), ref };
    if (step === 'unknown-none') return { kind: 'unknown', error: new OutcomeUnknown(this.venue, 'no answer', {}), ref };
    if (step === 'unknown-filled') {
      apply(signed);
      return { kind: 'unknown', error: new OutcomeUnknown(this.venue, 'no answer', {}), ref };
    }
    if (step === 'unknown-unreadable') {
      apply(signed);
      this.unreadable = true;
      return { kind: 'unknown', error: new OutcomeUnknown(this.venue, 'no answer', {}), ref };
    }
    if (typeof step === 'object') {
      const part = toQty(step.partial);
      const done = apply(side === 'BUY' ? part : -part);
      return { kind: 'filled', filled: done, avgPx: 2500, ref };
    }
    const done = apply(signed);
    if (done === 0n) return { kind: 'failed', error: new NothingExecuted(this.venue, 'reduce-only had nothing to reduce'), ref };
    if (step === 'copy') this.pos += signed;    // someone sent the public signed copy: it filled again
    return { kind: 'filled', filled: done, avgPx: 2500, ref };
  }
}

function setup(hl: ConstructorParameters<typeof FakeLeg>[2] = {}, orderly: ConstructorParameters<typeof FakeLeg>[2] = {}) {
  const shared: Shared = { started: 0, overlap: false, now: 1_000_000 };
  const a = new FakeLeg('hyperliquid', shared, hl);
  const b = new FakeLeg('orderly', shared, orderly);
  const lines: string[] = [];
  const trader = new PairTrader({ legs: [a, b], clock: { now: () => shared.now }, log: (l) => lines.push(l) });
  return { a, b, trader, shared, lines };
}

const q = (s: string) => toQty(s);

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
});

test('outcome unknown: when the venue shows nothing ran, the retry goes out; when it cannot be read, nothing more is sent', async () => {
  const none = setup({}, { script: ['unknown-none', 'fill'] });
  assert.equal((await none.trader.open({ size: '0.005', longIndex: 0, reason: 'open' })).status, 'open');
  assert.equal(none.b.orders.length, 2);

  const lost = setup({ script: ['unknown-unreadable'] });
  const r = await lost.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.equal(r.status, 'stuck');
  assert.equal(r.legs[0].final, null);
  assert.equal(lost.a.orders.length, 1, 'no retry without proof');
  assert.equal(lost.b.orders.length, 1, 'and no close of the other leg either: its partner may be open');
  assert.match(r.notes.join(' '), /position unknown on hyperliquid/);
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

test('replayed fill later in the window: a push over the target is closed; after the window it is left alone', async () => {
  const s = setup();
  await s.trader.open({ size: '0.005', longIndex: 0, reason: 'open' });
  assert.ok(s.trader.watching(s.b));
  s.b.pos = q('-0.01');                              // the copy lands a minute later
  s.shared.now += 60_000;
  await s.trader.positionPushed(s.b, s.b.pos);
  assert.equal(s.b.pos, q('-0.005'));
  assert.deepEqual(s.b.orders.at(-1), { side: 'BUY', size: '0.005', reduceOnly: true, reason: 'reconcile PERP_ETH_USDC: close 0.005 over the target' });
  assert.equal(s.trader.lastWatch?.final, '-0.005');
  // A push at the target, or a deficit, sends nothing.
  const sent = s.b.orders.length;
  await s.trader.positionPushed(s.b, q('-0.005'));
  await s.trader.positionPushed(s.b, q('-0.004'));
  assert.equal(s.b.orders.length, sent);
  // Past the window nothing is watched any more.
  s.shared.now += REPLAY_WINDOW_MS + 1;
  s.b.pos = q('-0.01');
  await s.trader.positionPushed(s.b, s.b.pos);
  assert.equal(s.b.orders.length, sent);
  assert.equal(s.trader.watching(s.b), false);
  // Hyperliquid legs are never watched: a signed action is taken once.
  assert.equal(s.trader.watching(s.a), false);
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
