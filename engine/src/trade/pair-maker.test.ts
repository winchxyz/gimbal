// The pair trader's maker-first open and close against scripted fake legs: the maker leg goes first, its partner
// follows as one IOC sized to what the maker leg filled (a fill finer than the common lot is trimmed reduce-only), a
// partner that fails twice unwinds the maker leg, a close matches what the maker leg closed, the fees of every fill
// add up in the result, and an open over the cap is split into whole pairs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VenueId } from '@gimbal/shared';
import { OutcomeUnknown } from '../contract/types.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import type { LegOutcome, LegRef, LegSide, TradeLeg } from './legs.ts';
import { lotQty, toQty } from './lots.ts';
import { PairTrader } from './pair.ts';

type Answer = { fill: string; fee?: number } | 'fail' | 'unknown-none' | { partial: string; late?: string };

class Leg implements TradeLeg {
  readonly venue: VenueId;
  readonly symbol = 'ETH';
  readonly lot: bigint;
  readonly replayable = false;
  pos = 0n;
  begins = 0;
  readonly log: string[];
  readonly iocs: Answer[];
  readonly makers: Answer[];
  readonly #cap: bigint | null;
  #seq = 0;

  constructor(venue: VenueId, log: string[], o: { lot: string; iocs?: Answer[]; makers?: Answer[]; cap?: string }) {
    this.venue = venue;
    this.log = log;
    this.lot = lotQty(o.lot);
    this.iocs = o.iocs ?? [];
    this.makers = o.makers ?? [];
    this.#cap = o.cap === undefined ? null : toQty(o.cap);
  }

  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return this.#cap ?? 10n ** 16n;
  }
  async position(): Promise<bigint> {
    return this.pos;
  }
  order(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    return this.#answer('ioc', this.iocs.shift() ?? { fill: 'all' }, side, size, reduceOnly);
  }
  beginMakerOperation(): void {
    this.begins++;
  }
  makerOrder(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    return this.#answer('maker', this.makers.shift() ?? { fill: 'all' }, side, size, reduceOnly);
  }

  async #answer(kind: string, a: Answer, side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    this.log.push(`${this.venue} ${kind} ${side} ${Number(size) / 1e8}${reduceOnly ? ' ro' : ''}`);
    const ref: LegRef = { venue: this.venue, side, size: String(size), reduceOnly, orderId: `${this.venue}-${++this.#seq}`, clientId: null, tx: [], sentAt: 0 };
    if (a === 'fail') return { kind: 'failed', error: new NothingExecuted(this.venue, 'no match'), ref };
    if (a === 'unknown-none') return { kind: 'unknown', error: new OutcomeUnknown(this.venue, 'no answer', {}), ref, expiresAt: null };
    if ('partial' in a) {
      // A maker order whose first post-only order filled `partial`, and whose second has no answer and no expiry:
      // it may have filled `late` already when the leg is read.
      const p = toQty(a.partial) + (a.late === undefined ? 0n : toQty(a.late));
      this.pos += side === 'BUY' ? p : -p;
      const part: LegOutcome = { kind: 'filled', filled: toQty(a.partial), avgPx: 2500, fee: 0.001, ref: { ...ref, orderId: `${this.venue}-p` } };
      return { kind: 'unknown', error: new OutcomeUnknown(this.venue, 'no answer', {}), ref, expiresAt: null, parts: [part, { kind: 'unknown', error: new Error('x'), ref, expiresAt: null }] };
    }
    const filled = a.fill === 'all' ? size : toQty(a.fill);
    this.pos += side === 'BUY' ? filled : -filled;
    return { kind: 'filled', filled, avgPx: 2500, fee: a.fee ?? 0.01, ref };
  }
}

function pair(hl: { iocs?: Answer[]; makers?: Answer[]; cap?: string }, phoenix: { iocs?: Answer[]; cap?: string }) {
  const log: string[] = [];
  const a = new Leg('hyperliquid', log, { lot: '0.0001', ...hl });
  const b = new Leg('phoenix', log, { lot: '0.001', ...phoenix });
  const trader = new PairTrader({ legs: [a, b], priceBandBps: 100, unsettledPollMs: null, sleep: async () => {} });
  return { a, b, log, trader };
}

test('maker first: the Hyperliquid short works as a maker order, then Phoenix buys what it filled; fees add up', async () => {
  const p = pair({ makers: [{ fill: 'all', fee: -0.002 }] }, { iocs: [{ fill: 'all', fee: 0.0043 }] });
  const r = await p.trader.open({ size: '0.005', longIndex: 1, reason: 'carry', maker: { index: 0 } });
  assert.equal(r.status, 'open');
  assert.deepEqual(p.log, ['hyperliquid maker SELL 0.005', 'phoenix ioc BUY 0.005']);
  assert.deepEqual([p.a.pos, p.b.pos], [toQty('-0.005'), toQty('0.005')]);
  assert.ok(Math.abs(r.feeUsd - 0.0023) < 1e-12);
  assert.equal(r.feeUnknown, 0);
  assert.deepEqual(r.legs.map((l) => l.orders.map((o) => o.fee)), [[-0.002], [0.0043]]);
});

test('a maker fill finer than the common lot: the excess is trimmed reduce-only and the pair opens at the hedge', async () => {
  const p = pair({ makers: [{ fill: '0.0034' }] }, {});
  const r = await p.trader.open({ size: '0.005', longIndex: 1, reason: 'carry', maker: { index: 0 } });
  assert.equal(r.status, 'open');
  assert.equal(r.size, '0.003');
  assert.deepEqual(p.log, ['hyperliquid maker SELL 0.005', 'hyperliquid ioc BUY 0.0004 ro', 'phoenix ioc BUY 0.003']);
  assert.deepEqual([p.a.pos, p.b.pos], [toQty('-0.003'), toQty('0.003')]);
  assert.ok(r.notes.some((n) => /opens at that size/.test(n)));
});

test('a maker leg that fills nothing opens nothing, and its partner never trades', async () => {
  const p = pair({ makers: ['fail'] }, {});
  const r = await p.trader.open({ size: '0.005', longIndex: 1, reason: 'carry', maker: { index: 0 } });
  assert.equal(r.status, 'flat');
  assert.deepEqual(p.log, ['hyperliquid maker SELL 0.005']);
});

test('the IOC partner fails twice: the maker leg is unwound reduce-only, flat', async () => {
  const p = pair({}, { iocs: ['fail', 'fail'] });
  const r = await p.trader.open({ size: '0.005', longIndex: 1, reason: 'carry', maker: { index: 0 } });
  assert.equal(r.status, 'flat');
  assert.deepEqual(p.log, ['hyperliquid maker SELL 0.005', 'phoenix ioc BUY 0.005', 'phoenix ioc BUY 0.005', 'hyperliquid ioc BUY 0.005 ro']);
  assert.deepEqual([p.a.pos, p.b.pos], [0n, 0n]);
});

test('a maker leg with no answer and no expiry halts the open before its partner trades', async () => {
  const p = pair({ makers: ['unknown-none'] }, {});
  const r = await p.trader.open({ size: '0.005', longIndex: 1, reason: 'carry', maker: { index: 0 } });
  assert.notEqual(r.status, 'open');
  assert.deepEqual(p.log, ['hyperliquid maker SELL 0.005']);
  assert.notEqual(p.trader.unsettled(p.a), null);
});

test('maker-first close: Hyperliquid closes as a maker order, Phoenix matches what it closed, the retry takes the rest', async () => {
  const p = pair({ makers: [{ fill: '0.002' }] }, {});
  p.a.pos = toQty('-0.005');
  p.b.pos = toQty('0.005');
  const r = await p.trader.close({ reason: 'close', maker: { index: 0 } });
  assert.equal(r.status, 'closed');
  assert.deepEqual(p.log, ['hyperliquid maker BUY 0.005 ro', 'phoenix ioc SELL 0.002 ro', 'hyperliquid ioc BUY 0.003 ro', 'phoenix ioc SELL 0.003 ro']);
  assert.deepEqual([p.a.pos, p.b.pos], [0n, 0n]);
});

test('an open over the cap is split into whole pairs under the cap less the band', async () => {
  // Phoenix caps one order at 0.008: less the 100 bps band, 0.007 a pair; 0.012 goes as 0.007 then 0.005.
  const p = pair({}, { cap: '0.008' });
  const results = await p.trader.openInChunks({ size: '0.012', longIndex: 1, reason: 'carry', maker: { index: 0 } });
  assert.deepEqual(results.map((r) => [r.status, r.size]), [['open', '0.007'], ['open', '0.005']]);
  assert.deepEqual([p.a.pos, p.b.pos], [toQty('-0.012'), toQty('0.012')]);
  assert.deepEqual([p.a.begins, p.b.begins], [1, 0], 'one maker budget for the whole open, on the maker leg');
  await p.trader.close({ reason: 'close', maker: { index: 0 } });
  assert.equal(p.a.begins, 2, 'a close is an operation of its own');
});

test('a maker leg that partly filled, then lost an order with no expiry: the known fill is hedged, the lost order watched', async () => {
  // Hyperliquid filled 0.002 in parts, then an order with no answer: Phoenix buys the known 0.002 (whole common lots).
  // Read with nothing more: hedged, stuck. Read when the lost order already filled 0.001 more: that 0.001 is open.
  for (const [late, status] of [[undefined, 'stuck'], ['0.001', 'unhedged']] as const) {
    const p = pair({ makers: [{ partial: '0.002', ...(late === undefined ? {} : { late }) }] }, {});
    const r = await p.trader.open({ size: '0.005', longIndex: 1, reason: 'carry', maker: { index: 0 } });
    assert.equal(r.status, status, `late ${late}`);
    assert.deepEqual(p.log, ['hyperliquid maker SELL 0.005', 'phoenix ioc BUY 0.002'], 'Phoenix is sized to the known fill, never to what may still grow');
    assert.equal(p.b.pos, toQty('0.002'), 'the hedge is kept, not unwound');
    assert.notEqual(p.trader.unsettled(p.a), null, 'watched: the lost order may still fill');
    assert.ok(r.notes.some((n) => /no answer and no expiry/.test(n)));
    assert.ok(r.notes.some((n) => /filled 0\.002 before an order with no answer/.test(n)));
    assert.equal(p.trader.unhedged === null, status === 'stuck');
  }
});

test('a known maker fill under one common lot is not hedged: unhedged, and the partner never trades', async () => {
  const p = pair({ makers: [{ partial: '0.0004' }] }, {});
  const r = await p.trader.open({ size: '0.005', longIndex: 1, reason: 'carry', maker: { index: 0 } });
  assert.equal(r.status, 'unhedged');
  assert.deepEqual(p.log, ['hyperliquid maker SELL 0.005']);
  assert.ok(r.notes.some((n) => /under one lot of the hedge/.test(n)));
});

test('a maker close that partly closed, then lost an order: the partner closes the known part reduce-only', async () => {
  const p = pair({ makers: [{ partial: '0.002' }] }, {});
  p.a.pos = toQty('-0.005');
  p.b.pos = toQty('0.005');
  const r = await p.trader.close({ reason: 'close', maker: { index: 0 } });
  assert.deepEqual(p.log, ['hyperliquid maker BUY 0.005 ro', 'phoenix ioc SELL 0.002 ro']);
  assert.deepEqual([p.a.pos, p.b.pos], [toQty('-0.003'), toQty('0.003')]);
  assert.equal(r.status, 'stuck', 'hedged: what is left offsets, the lost order watched');
  assert.notEqual(p.trader.unsettled(p.a), null);
});

test('a stale price mid-pair: the hook before each part refreshes it; one that fails stops the open before that part', async () => {
  const p = pair({}, { cap: '0.008' });
  const calls: string[] = [];
  const results = await p.trader.openInChunks({
    size: '0.012', longIndex: 1, reason: 'carry', maker: { index: 0 },
    beforePart: async (part, parts) => {
      calls.push(`${part}/${parts}`);
      if (part === 2) throw new Error('refresh_prices did not leave a fresh ETH price');
    },
  });
  assert.deepEqual(calls, ['1/2', '2/2']);
  assert.deepEqual(results.map((r) => r.status), ['open', 'stuck']);
  assert.match(results[1]!.notes.join(), /part 2 of 2 not sent: refresh_prices did not leave a fresh ETH price/);
  assert.deepEqual([p.a.pos, p.b.pos], [toQty('-0.007'), toQty('0.007')], 'the first part stays hedged');
});
