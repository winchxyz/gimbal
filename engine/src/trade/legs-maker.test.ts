// Hyperliquid's maker order against a fake venue: a post-only (Alo) limit at the touch, read by orderStatus, cancelled
// and placed again at the new touch after repriceMs, an Alo refused for crossing placed again, an IOC for what is left
// after timeoutMs, fees from userFills, and a post-only order whose state cannot be settled reported unknown. A status
// read that throws never leaves the order resting: it is cancelled and read again; at most maxOrders are signed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TxRef } from '@gimbal/shared';
import { OutcomeUnknown } from '../contract/types.ts';
import type { HlOrder } from '../contract/types.ts';
import type { HlFill, HlSubmitResult } from '../relayer/hyperliquid.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import type { MakerSettings } from './legs.ts';
import { DEFAULT_MAKER, HlLeg } from './legs.ts';
import { toQty } from './lots.ts';

const NEAR_TX: TxRef = { chain: 'near', id: 'NEARTX', url: 'https://nearblocks.io/txns/NEARTX' };

/** What the fake venue does with each post-only order, in order: how much it fills while resting, and when. */
interface Rest {
  fills: string;                 // filled before the cancel
  fillAtOnce?: boolean;          // filled in full at the first status read
  refuse?: 'cross';              // Hyperliquid refuses the Alo: it would have crossed
  lost?: boolean;                // the submission's answer is lost (no expiry)
  statusErrors?: number;         // this many orderStatus reads of it throw first (a 429)
  statusDown?: boolean;          // every orderStatus read of it throws
}

/**
 * `px.oracle`: the stored price (null: an unpriced asset, no band); `px.mark`: Hyperliquid's mark in metaAndAssetCtxs
 * (null: the coin is not listed there, so no mark is read); `px.markDown`: that read throws.
 */
function venue(
  rests: Rest[], book = { bid: 2499, ask: 2500 }, ioc: string | null = null, maker: Partial<MakerSettings> = {},
  px: { oracle?: number | null; mark?: number | null; markDown?: boolean } = {},
) {
  let now = 1_000_000;
  let oid = 100;
  const orders: HlOrder[] = [];
  const reasons: string[] = [];
  const infos: string[] = [];
  const cancels: number[] = [];
  const status = new Map<number, { sz: string; origSz: string; status: string; limitPx: string; full: boolean; fill: string; errors: number; down: boolean }>();
  const fills: HlFill[] = [];
  const result = (o: number, filled: { totalSz: string; avgPx: string } | null, resting: boolean): HlSubmitResult => ({
    kind: 'order', statuses: [], oid: o, filled, resting, fills: [], tx: [NEAR_TX], confirmed: true, expiresAfter: now + 60_000,
  });
  const leg = new HlLeg({
    relayer: {
      hlOrder: async (order, reason) => {
        orders.push(order);
        reasons.push(reason);
        if (order.tif === 'Ioc') {
          if (ioc === null) throw new NothingExecuted('hyperliquid', 'Order could not immediately match', [NEAR_TX]);
          const o = ++oid;
          const r = result(o, { totalSz: ioc, avgPx: '2500.5' }, false);
          r.fills = [{ coin: 'ETH', px: '2500.5', sz: ioc, side: order.is_buy ? 'B' : 'A', time: now, hash: '0x1', oid: o, fee: '0.06' }];
          return r;
        }
        const rest = rests.shift() ?? { fills: '0' };
        if (rest.refuse === 'cross') throw new NothingExecuted('hyperliquid', 'Post only order would have immediately matched', [NEAR_TX]);
        if (rest.lost) throw new OutcomeUnknown('hyperliquid order', 'no answer', { hlCloid: order.cloid! });
        const o = ++oid;
        status.set(o, { sz: order.sz, origSz: order.sz, status: 'open', limitPx: order.px, full: rest.fillAtOnce === true, fill: rest.fills, errors: rest.statusErrors ?? 0, down: rest.statusDown === true });
        return result(o, null, true);
      },
      hlCancel: async (_asset, o) => {
        cancels.push(o);
        const st = status.get(o)!;
        const filled = st.fill;
        st.sz = String(Number(st.origSz) - Number(filled));
        st.status = 'canceled';
        if (Number(filled) > 0) fills.push({ coin: 'ETH', px: st.limitPx, sz: filled, side: 'B', time: now, hash: '0x2', oid: o, fee: '-0.0005' });
        return result(o, null, false);
      },
    },
    info: async (body) => {
      infos.push(String(body.type));
      if (body.type === 'metaAndAssetCtxs') {
        if (px.markDown === true) throw new Error('hyperliquid /info: HTTP 503');
        const mark = px.mark === undefined ? 2499.5 : px.mark;
        return [{ universe: [{ name: 'BTC' }, ...(mark === null ? [] : [{ name: 'ETH' }])] }, [{ markPx: '100000' }, ...(mark === null ? [] : [{ markPx: String(mark) }])]];
      }
      if (body.type === 'orderStatus') {
        const st = status.get(Number(body.oid));
        if (st === undefined) return { status: 'unknownOid' };
        if (st.down) throw new Error('hyperliquid /info: HTTP 429');
        if (st.errors > 0) {
          st.errors--;
          throw new Error('hyperliquid /info: HTTP 502');
        }
        if (st.full && st.status === 'open') {
          st.status = 'filled';
          fills.push({ coin: 'ETH', px: st.limitPx, sz: st.origSz, side: 'B', time: now, hash: '0x3', oid: Number(body.oid), fee: '-0.001' });
          st.sz = '0';
        }
        return { status: 'order', order: { status: st.status, order: { oid: Number(body.oid), sz: st.sz, origSz: st.origSz, limitPx: st.limitPx } } };
      }
      if (body.type === 'userFills') return fills;
      return { assetPositions: [] };
    },
    user: '0xABC', coin: 'ETH', asset: 1, szDecimals: 4, oraclePx: async () => (px.oracle === undefined ? 2500 : px.oracle), bandBps: 100, maxNotionalUsd: 50,
    bestPx: async (side) => (side === 'BUY' ? book.ask : book.bid),
    maker: { repriceMs: 5_000, timeoutMs: 10_000, takerFallback: true, pollMs: 1_000, ...maker },
    clock: { now: () => now },
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { leg, orders, cancels, reasons, infos };
}

test('a post-only buy rests at the best bid and fills: one part, the maker fee (a rebate) from userFills', async () => {
  const v = venue([{ fills: '0', fillAtOnce: true }]);
  const out = await v.leg.makerOrder('BUY', toQty('0.005'), false, 'open');
  assert.equal(out.kind, 'filled');
  assert.ok(out.kind === 'filled');
  assert.deepEqual([out.filled, out.avgPx, out.fee, out.parts?.length], [toQty('0.005'), 2499, -0.001, 1]);
  assert.deepEqual([v.orders[0]!.tif, v.orders[0]!.px, v.orders[0]!.sz, v.orders[0]!.is_buy, v.orders[0]!.reduce_only], ['Alo', '2499', '0.005', true, false]);
  assert.deepEqual(v.cancels, []);
});

test('repriced: a resting order is cancelled after repriceMs and placed again; the rest goes as an IOC after the timeout', async () => {
  // 1st Alo fills 0.004 then is cancelled; 2nd refused (would cross); 3rd fills nothing; then the IOC takes 0.006.
  // Each placement at least repriceMs (5 s) after the one before, the refused one included: at 0, 5 and 10 s.
  const v = venue([{ fills: '0.004' }, { fills: '0', refuse: 'cross' }, { fills: '0' }], undefined, '0.006', { timeoutMs: 15_000 });
  const out = await v.leg.makerOrder('BUY', toQty('0.01'), false, 'open');
  assert.equal(out.kind, 'filled');
  assert.ok(out.kind === 'filled');
  assert.equal(out.filled, toQty('0.01'));
  assert.deepEqual(v.orders.map((o) => [o.tif, o.sz]), [['Alo', '0.01'], ['Alo', '0.006'], ['Alo', '0.006'], ['Ioc', '0.006']]);
  assert.equal(v.cancels.length, 2);
  assert.deepEqual(out.parts!.map((p) => p.kind), ['filled', 'failed', 'failed', 'filled']);
  assert.deepEqual(out.parts!.slice(0, 3).map((p) => p.ref.sentAt - out.ref.sentAt), [0, 5_000, 10_000], 'the reprice floor holds after a refusal');
  // 0.004 at 2499 (rebate 0.0005) and 0.006 at 2500.5 (fee 0.06).
  assert.ok(Math.abs(out.fee! - 0.0595) < 1e-12);
  assert.ok(Math.abs(out.avgPx! - (0.004 * 2499 + 0.006 * 2500.5) / 0.01) < 1e-9);
});

test('no fill and no fallback taker fill: failed with proof; a post-only order with no answer and no expiry: unknown', async () => {
  const none = venue([{ fills: '0' }, { fills: '0' }, { fills: '0' }]);
  const out = await none.leg.makerOrder('SELL', toQty('0.005'), true, 'close');
  assert.equal(out.kind, 'failed');
  assert.equal(none.orders.at(-1)!.tif, 'Ioc');
  assert.equal(none.orders[0]!.px, '2500', 'a sell rests at the best ask');

  const lost = venue([{ fills: '0', lost: true }]);
  const u = await lost.leg.makerOrder('BUY', toQty('0.005'), false, 'open');
  assert.equal(u.kind, 'unknown');
  assert.ok(u.kind === 'unknown' && u.expiresAt === null);
  assert.equal(lost.orders.length, 1, 'nothing more is sent after an order that may still rest');
});

test('a status read that throws: the order is cancelled and read again, never left resting; one that keeps throwing is unknown', async () => {
  // The first read fails (a 502): cancelled at once, then read: it had filled 0.005 by then.
  const flaky = venue([{ fills: '0.005', statusErrors: 1 }]);
  const out = await flaky.leg.makerOrder('BUY', toQty('0.005'), false, 'open');
  assert.equal(out.kind, 'filled');
  assert.equal(flaky.cancels.length, 1);

  const down = venue([{ fills: '0', statusDown: true }]);
  const u = await down.leg.makerOrder('BUY', toQty('0.005'), false, 'open');
  assert.ok(u.kind === 'unknown' && u.expiresAt === null, 'cannot be settled: it may still rest');
  assert.equal(down.cancels.length, 2, 'cancelled twice anyway');
  assert.equal(down.orders.length, 1, 'nothing more is sent');
  assert.equal(u.ref.clientId, down.orders[0]!.cloid, 'the summary names the order to reconcile');
  assert.deepEqual(down.leg.pendingMakerOrders().map((p) => p.cloid), [down.orders[0]!.cloid]);
  const lines = await down.leg.cancelPending('exit');
  assert.match(lines[0]!, /status cannot be read .*by hand/);
});

test('at most maxOrders post-only orders are signed, crossing refusals included; the taker fallback is off by default', async () => {
  const v = venue([{ fills: '0', refuse: 'cross' }, { fills: '0' }, { fills: '0' }, { fills: '0' }], undefined, null, { maxOrders: 2, timeoutMs: 600_000 });
  const out = await v.leg.makerOrder('SELL', toQty('0.005'), false, 'open');
  assert.equal(out.kind, 'failed');
  assert.deepEqual(v.orders.map((o) => o.tif), ['Alo', 'Alo', 'Ioc']);
  assert.deepEqual([DEFAULT_MAKER.takerFallback, DEFAULT_MAKER.repriceMs, DEFAULT_MAKER.maxOrders], [false, 30_000, 6]);
});

test('a crossing refusal waits out the reprice floor: no placement inside repriceMs, none past the deadline', async () => {
  // Refused at 0; the next placement would be at 5 s, which is the deadline: no second Alo, the IOC takes it.
  const v = venue([{ fills: '0', refuse: 'cross' }], undefined, '0.005', { timeoutMs: 5_000 });
  const out = await v.leg.makerOrder('BUY', toQty('0.005'), false, 'open');
  assert.deepEqual(v.orders.map((o) => o.tif), ['Alo', 'Ioc']);
  assert.equal(out.kind, 'filled');
});

test('one pair operation shares the maxOrders budget across its maker orders; the next operation starts a new one', async () => {
  const v = venue([{ fills: '0' }, { fills: '0' }, { fills: '0' }, { fills: '0' }, { fills: '0' }], undefined, null, { maxOrders: 3, timeoutMs: 600_000, takerFallback: false });
  const end = v.leg.beginMakerOperation();
  await v.leg.makerOrder('SELL', toQty('0.005'), true, 'close (part 1)');
  const second = await v.leg.makerOrder('SELL', toQty('0.005'), true, 'close (part 2)');
  assert.deepEqual(v.orders.map((o) => o.tif), ['Alo', 'Alo', 'Alo'], 'three for the operation, not three per call');
  assert.ok(second.kind === 'failed');
  assert.match(second.error.message, /the budget of 3 post-only orders for this open or close is spent/, 'the outcome names the budget');
  end();
  v.leg.beginMakerOperation();
  await v.leg.makerOrder('SELL', toQty('0.005'), true, 'close again');
  assert.equal(v.orders.length, 6, 'a new operation: the budget of three starts again');
});

test('the reprice floor holds across the maker orders of one operation, and ends with it', async () => {
  // repriceMs 5 s: part 1 fills at once at t0; part 2 of the same operation places no sooner than t0 + 5 s.
  const v = venue(Array.from({ length: 5 }, () => ({ fills: '0', fillAtOnce: true })));
  const end = v.leg.beginMakerOperation();
  const a = await v.leg.makerOrder('BUY', toQty('0.005'), false, 'open (part 1)');
  const b = await v.leg.makerOrder('BUY', toQty('0.005'), false, 'open (part 2)');
  assert.ok(a.kind === 'filled' && b.kind === 'filled');
  assert.equal(b.parts![0]!.ref.sentAt - a.parts![0]!.ref.sentAt, 5_000, 'part 2 waits out the floor from part 1');
  end();
  end();      // ending twice touches nothing
  const e2 = v.leg.beginMakerOperation();
  end();      // the first operation's end, after a later one began: the later one stays
  const d1 = await v.leg.makerOrder('BUY', toQty('0.005'), false, 'open 2 (part 1)');
  const d2 = await v.leg.makerOrder('BUY', toQty('0.005'), false, 'open 2 (part 2)');
  assert.ok(d1.kind === 'filled' && d2.kind === 'filled');
  assert.equal(d2.parts![0]!.ref.sentAt - d1.parts![0]!.ref.sentAt, 5_000, 'still the second operation: its floor holds');
  e2();
  const c = await v.leg.makerOrder('BUY', toQty('0.005'), false, 'another open');
  assert.equal(c.parts![0]!.ref.sentAt, c.ref.sentAt, 'no operation: no floor carried over, placed at once');
});

// ---- an owner demo entry's taker fallback (makerOrder's options.takerFallback) ----

const FALLBACK = { takerFallback: { markBps: 50 } };

test('owner entry: after the maker window the rest goes as a taker fallback IOC, its ref and reason say so', async () => {
  // The leg's own settings have no fallback (serve's): only the call's option adds it. 0.004 fills post-only, 0.006 by IOC.
  const v = venue([{ fills: '0.004' }, { fills: '0' }], undefined, '0.006', { takerFallback: false });
  const out = await v.leg.makerOrder('BUY', toQty('0.01'), false, 'open', FALLBACK);
  assert.ok(out.kind === 'filled');
  assert.equal(out.filled, toQty('0.01'));
  assert.deepEqual(v.orders.map((o) => [o.tif, o.sz]), [['Alo', '0.01'], ['Alo', '0.006'], ['Ioc', '0.006']]);
  assert.deepEqual(out.parts!.map((p) => p.ref.takerFallback === true), [false, false, true]);
  assert.equal(v.reasons.at(-1), 'open (taker fallback)');
  assert.ok(v.infos.includes('metaAndAssetCtxs'), 'the mark was read for it');
});

test('owner entry: without the option (the loop\'s own entries, a plain rotate) no IOC follows the maker window', async () => {
  const v = venue([{ fills: '0.004' }, { fills: '0' }], undefined, '0.006', { takerFallback: false });
  const out = await v.leg.makerOrder('BUY', toQty('0.01'), false, 'open');
  assert.ok(out.kind === 'filled');
  assert.equal(out.filled, toQty('0.004'), 'what the post-only part filled, nothing more');
  assert.deepEqual(v.orders.map((o) => o.tif), ['Alo', 'Alo']);
  assert.ok(!v.infos.includes('metaAndAssetCtxs'), 'no mark read');
});

test('owner entry, unpriced symbol (no band): the fallback\'s limit is held within 50 bps of the mark as well as the touch', async () => {
  // Ask 2500, mark 2499.5: the touch's 50 bps would allow 2512.5; the mark's 50 bps hold it to 2511.99 (2511.9 on the tick).
  const unpriced = venue([{ fills: '0' }, { fills: '0' }], undefined, '0.01', { takerFallback: false }, { oracle: null, mark: 2499.5 });
  const out = await unpriced.leg.makerOrder('BUY', toQty('0.01'), false, 'open', FALLBACK);
  assert.ok(out.kind === 'filled');
  const ioc = unpriced.orders.at(-1)!;
  assert.equal(ioc.tif, 'Ioc');
  assert.equal(ioc.px, '2511.9');
  assert.ok(Number(ioc.px) <= 2499.5 * 1.005 && Number(ioc.px) >= 2500);
  // The same without the mark bound (pair-mainnet's --taker-fallback): the touch's 50 bps alone.
  const plain = venue([{ fills: '0' }, { fills: '0' }], undefined, '0.01', { takerFallback: true }, { oracle: null });
  await plain.leg.makerOrder('BUY', toQty('0.01'), false, 'open');
  assert.equal(plain.orders.at(-1)!.px, '2512.5');
  // A sell: held to the mark's 50 bps below it.
  const sell = venue([{ fills: '0' }, { fills: '0' }], { bid: 2499, ask: 2500 }, '0.01', { takerFallback: false }, { oracle: null, mark: 2499.5 });
  await sell.leg.makerOrder('SELL', toQty('0.01'), false, 'open', FALLBACK);
  assert.ok(Number(sell.orders.at(-1)!.px) >= 2499.5 * 0.995 && Number(sell.orders.at(-1)!.px) <= 2499);
});

test('owner entry: a touch more than 50 bps from the mark, or a mark that cannot be read, signs no fallback: nothing sent', async () => {
  // The book's ask ran 4 % above the mark (a thin unpriced book): an IOC held within 50 bps of the mark would not fill.
  const thin = venue([{ fills: '0' }, { fills: '0' }], undefined, '0.01', { takerFallback: false }, { oracle: null, mark: 2400 });
  const out = await thin.leg.makerOrder('BUY', toQty('0.01'), false, 'open', FALLBACK);
  assert.ok(out.kind === 'failed');
  assert.deepEqual(thin.orders.map((o) => o.tif), ['Alo', 'Alo'], 'no IOC signed');
  assert.match(out.error.message, /the best ask 2500 is more than 50 bps from the mark 2400/);
  assert.equal(out.parts!.at(-1)!.ref.takerFallback, true);

  for (const px of [{ oracle: null, markDown: true }, { oracle: null, mark: null }]) {
    const blind = venue([{ fills: '0' }, { fills: '0' }], undefined, '0.01', { takerFallback: false }, px);
    const b = await blind.leg.makerOrder('BUY', toQty('0.01'), false, 'open', FALLBACK);
    assert.ok(b.kind === 'failed');
    assert.deepEqual(blind.orders.map((o) => o.tif), ['Alo', 'Alo'], JSON.stringify(px));
    assert.match(b.error.message, /the mark price cannot be read, so the taker fallback's limit cannot be held within 50 bps of it: nothing sent/);
  }
});

test('owner entry, priced symbol: the fallback stays inside the contract\'s band and the cap as every IOC does', async () => {
  // Stored price 2450, band 100 bps (95 % used): the edge 2473.27 is under the book (bid 2499, ask 2500), so neither the
  // post-only order nor the fallback is signed.
  const out = venue([{ fills: '0' }, { fills: '0' }], undefined, '0.01', { takerFallback: false }, { oracle: 2450 });
  const r = await out.leg.makerOrder('BUY', toQty('0.01'), false, 'open', FALLBACK);
  assert.ok(r.kind === 'failed');
  assert.deepEqual(out.orders, []);
  assert.match(r.error.message, /outside the contract's band/);
  assert.equal(r.parts!.at(-1)!.ref.takerFallback, true, 'the fallback was tried and refused before signing');
  // Over the policy's 50 USD cap: refused before signing.
  const big = venue([{ fills: '0' }, { fills: '0' }], undefined, '0.03', { takerFallback: false });
  const b = await big.leg.makerOrder('BUY', toQty('0.03'), false, 'open', FALLBACK);
  assert.ok(b.kind === 'failed');
  assert.ok(!big.orders.some((o) => o.tif === 'Ioc'));
});
