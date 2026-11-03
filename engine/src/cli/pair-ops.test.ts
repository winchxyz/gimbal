// The open's order-time size check (contract S2): the qty decide() sized is a maximum, held to max_notional at the
// highest price an order of the open may carry; it is only ever lowered, to whole common lots, the same on both legs.
// And the open's gate (review F2): a rescue that starts after the loop's gate stops the open before its next part.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VenueId } from '@gimbal/shared';
import type { LegOutcome, LegSide, TradeLeg } from '../trade/legs.ts';
import { toQty } from '../trade/lots.ts';
import { PairTrader } from '../trade/pair.ts';
import type { OpenPlan, OpsCtx, Pair } from './pair-ops.ts';
import { MIN_ORDER_USD, capQtyAtOrder, sendOpen } from './pair-ops.ts';

const LOT = toQty('0.01');

test('a 2.1 % rise after decide() sized 0.2 at 100 under a 20 USD cap: cut to 0.19, whole lots, under the cap', () => {
  const r = capQtyAtOrder({ qty: toQty('0.2'), lot: LOT, worstPx: 100 * 1.021, midPx: 101, capUsd: 20 });
  assert.ok('qty' in r);
  assert.equal(r.qty, toQty('0.19'));
  assert.equal(r.cut, true);
  assert.ok(0.19 * 102.1 <= 20);
  assert.equal(r.qty % LOT, 0n, 'whole common lots');
});

test('a size that still fits is sent as sized, never raised', () => {
  const r = capQtyAtOrder({ qty: toQty('0.12'), lot: LOT, worstPx: 102.1, midPx: 101, capUsd: 20 });
  assert.deepEqual(r, { qty: toQty('0.12'), cut: false });
});

test('under one lot, or under the minimum order at the mid, after the cut: nothing is sent', () => {
  const lot = toQty('1');
  const one = capQtyAtOrder({ qty: toQty('1'), lot, worstPx: 20 * 1.021, midPx: 20.2, capUsd: 20 });
  assert.ok('refused' in one);
  assert.match(one.refused, /under one common lot 1 fits the cap.*nothing sent/);

  const small = capQtyAtOrder({ qty: toQty('0.1'), lot: LOT, worstPx: 100 * 1.021, midPx: 101, capUsd: 10 });
  assert.ok('refused' in small);
  assert.match(small.refused, new RegExp(`0\\.09 is 9\\.09 USD, under the ${MIN_ORDER_USD} USD minimum order`));
});

test('no price: refused, nothing sent', () => {
  assert.ok('refused' in capQtyAtOrder({ qty: toQty('0.1'), lot: LOT, worstPx: 0, midPx: 0, capUsd: 20 }));
  assert.ok('refused' in capQtyAtOrder({ qty: toQty('0.1'), lot: LOT, worstPx: Number.NaN, midPx: 100, capUsd: 20 }));
});

class GateLeg implements TradeLeg {
  readonly venue: VenueId;
  readonly symbol = 'XLM';
  readonly lot = toQty('1');
  readonly replayable = false;
  pos = 0n;
  orders: { side: LegSide; size: bigint }[] = [];
  onOrder: () => void = () => {};
  constructor(venue: VenueId) {
    this.venue = venue;
  }
  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return toQty('6');                  // a part is at most 5 lots after the band: an open of 10 is two parts
  }
  async position(): Promise<bigint> {
    return this.pos;
  }
  async order(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    this.orders.push({ side, size });
    this.onOrder();
    this.pos += side === 'BUY' ? size : -size;
    return { kind: 'filled', filled: size, avgPx: 1, ref: { venue: this.venue, side, size: String(size), reduceOnly, orderId: `o${this.orders.length}`, clientId: null, tx: [], sentAt: 1 } };
  }
  makerOrder(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    return this.order(side, size, reduceOnly);
  }
  pendingMakerOrders(): readonly [] {
    return [];
  }
}

function gateWorld() {
  const hl = new GateLeg('hyperliquid');
  const px = new GateLeg('phoenix');
  const trader = new PairTrader({ legs: [hl, px], priceBandBps: 100 });
  const said: string[] = [];
  const ctx = { config: {}, say: (l = '') => said.push(l), open: (l: string) => said.push(`open: ${l}`), trading: false } as unknown as OpsCtx;
  const pair = {
    symbol: 'XLM', hl, phoenix: px, trader, priced: false, targetNet: null, maker: { timeoutMs: 60_000 },
    run: { openInChunks: (r: Parameters<PairTrader['openInChunks']>[0]) => trader.openInChunks(r), close: () => Promise.reject(new Error('no close')), hedge: () => Promise.reject(new Error('no hedge')), stopOnFinish: false },
  } as unknown as Pair;
  const plan = { request: { symbol: 'XLM' }, refusals: [], size: toQty('10'), carry: {} } as unknown as OpenPlan;
  return { hl, px, ctx, pair, plan, said };
}

test('F2: a rescue that starts during part 1 stops the open before part 2; part 1 stays a whole hedged pair', async () => {
  const g = gateWorld();
  let rescue: string | null = null;
  g.hl.onOrder = () => {
    rescue = 'rescue r-9 runs';
  };
  const results = await sendOpen(g.ctx, g.pair, g.plan, 'strategy: enter', { gate: () => rescue });
  assert.deepEqual(results.map((r) => r.status), ['open', 'stuck']);
  assert.match(results[1]!.notes.join('; '), /part 2 of 2 not sent: rescue r-9 runs/);
  assert.equal(g.hl.orders.length, 1);
  assert.equal(g.px.orders.length, 1);
  assert.equal(g.hl.pos + g.px.pos, 0n, 'part 1 hedged');
  assert.equal(results[1]!.legs.every((l) => l.orders.length === 0), true, 'nothing of part 2 sent');
});

test('F2: a rescue already running when the open reaches its first order: nothing is sent', async () => {
  const g = gateWorld();
  const results = await sendOpen(g.ctx, g.pair, g.plan, 'strategy: enter', { gate: () => 'rescue r-9 runs' });
  assert.deepEqual(results.map((r) => r.status), ['stuck'], 'the trader refuses the part before it is sent: stuck, nothing sent');
  assert.match(results[0]!.notes.join('; '), /part 1 of 2 not sent: rescue r-9 runs/);
  assert.equal(g.hl.orders.length + g.px.orders.length, 0);
  // Without a gate (pair-mainnet) the same open sends both parts.
  const h = gateWorld();
  const all = await sendOpen(h.ctx, h.pair, h.plan, 'pair-mainnet: open');
  assert.deepEqual(all.map((r) => r.status), ['open', 'open']);
});
