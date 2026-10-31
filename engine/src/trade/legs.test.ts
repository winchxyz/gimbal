// The two venue legs against fakes: Hyperliquid positions from clearinghouseState and IOC outcomes classified from
// the relayer's answers and errors; Orderly orders confirmed by their executionreports (which may arrive before the
// POST answer), positions from the signed read or, when the contract refuses the read, from a push after the order,
// and an asserted start that a later push contradicts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TxRef } from '@gimbal/shared';
import { ContractRefusal, MpcTimeoutError, OutcomeUnknown } from '../contract/types.ts';
import type { HlOrder } from '../contract/types.ts';
import type { HlSubmitResult } from '../relayer/hyperliquid.ts';
import { HlExchangeError } from '../relayer/hyperliquid.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import { OrderlyApiError } from '../venues/orderly-http.ts';
import type { OrderlyAccountSnapshot, OrderlyStreamPosition } from '../venues/orderly-stream.ts';
import type { OrderlyRequest } from '../venues/orderly-signer.ts';
import { HlLeg, OrderlyLeg, provesNothingRan } from './legs.ts';
import { lotQty, toQty } from './lots.ts';

const NEAR_TX: TxRef = { chain: 'near', id: 'NEARTX', url: 'https://testnet.nearblocks.io/txns/NEARTX' };
const q = (s: string) => toQty(s);

function hlResult(totalSz: string | null): HlSubmitResult {
  return {
    kind: 'order', statuses: [], oid: 4242, filled: totalSz === null ? null : { totalSz, avgPx: '2500.5' }, resting: false, fills: [],
    tx: [NEAR_TX], confirmed: true,
  };
}

function hlLeg(answer: (order: HlOrder) => Promise<HlSubmitResult>, info: unknown = { assetPositions: [] }) {
  const sent: HlOrder[] = [];
  const leg = new HlLeg({
    relayer: { hlOrder: async (order) => { sent.push(order); return answer(order); } },
    info: async () => info, user: '0xABC', coin: 'ETH', asset: 4, szDecimals: 4, oraclePx: async () => null, bandBps: 500,
    maxNotionalUsd: 50, maxSz: '0.02', bestPx: async (side) => (side === 'BUY' ? 2500 : 2499),
  });
  return { leg, sent };
}

test('hyperliquid: the position is szi for the coin; a malformed answer is an error, not zero', async () => {
  const { leg } = hlLeg(async () => hlResult('0'), { assetPositions: [{ position: { coin: 'BTC', szi: '1' } }, { position: { coin: 'ETH', szi: '-0.0045' } }] });
  assert.equal(await leg.position(), q('-0.0045'));
  assert.equal(await hlLeg(async () => hlResult('0')).leg.position(), 0n, 'no row is flat');
  await assert.rejects(hlLeg(async () => hlResult('0'), { error: 'x' }).leg.position(), /no assetPositions list/);
  await assert.rejects(hlLeg(async () => hlResult('0'), { assetPositions: [{ position: { coin: 'ETH' } }] }).leg.position(), /szi is undefined/);
  assert.equal(leg.lot, lotQty(4));
});

test('hyperliquid: an IOC that fills, and every error classified as failed (proof) or unknown', async () => {
  const filled = hlLeg(async () => hlResult('0.0045'));
  const out = await filled.leg.order('BUY', q('0.0045'), false, 'open');
  assert.equal(out.kind, 'filled');
  assert.equal(out.kind === 'filled' && out.filled, q('0.0045'));
  assert.deepEqual([filled.sent[0]!.sz, filled.sent[0]!.is_buy, filled.sent[0]!.tif, filled.sent[0]!.reduce_only], ['0.0045', true, 'Ioc', false]);
  assert.equal(out.ref.clientId, filled.sent[0]!.cloid);
  assert.deepEqual([out.ref.orderId, out.ref.tx], ['4242', [NEAR_TX]]);

  const cases: [Error, 'failed' | 'unknown'][] = [
    [new NothingExecuted('hyperliquid', 'IOC did not fill'), 'failed'],
    [new HlExchangeError('refused', 422, '{}'), 'failed'],
    [new ContractRefusal('E_PRICE_BAND', 'too far'), 'failed'],
    [new OutcomeUnknown('hl order', 'no answer', { hlCloid: '0x1' }), 'unknown'],
    [new MpcTimeoutError('hl_order', 'slow'), 'unknown'],
    [new Error('socket hang up'), 'unknown'],
  ];
  for (const [err, kind] of cases) {
    const leg = hlLeg(async () => { throw err; });
    const o = await leg.leg.order('SELL', q('0.0045'), true, 'close');
    assert.equal(o.kind, kind, err.name);
    assert.equal(provesNothingRan(err), kind === 'failed');
  }
  const none = await hlLeg(async () => hlResult(null)).leg.order('BUY', q('0.0045'), false, 'open');
  assert.equal(none.kind, 'failed', 'an answer with no fill is proof nothing ran');
});

test('hyperliquid: sizes off the lot or over the policy are refused before anything is signed', async () => {
  const s = hlLeg(async () => hlResult('1'));
  for (const size of [q('0.00451'), q('0.03'), 0n]) {
    const o = await s.leg.order('BUY', size, false, 'open');
    assert.equal(o.kind, 'failed');
    assert.equal(o.kind === 'failed' && o.error.name, 'LegCheckError');
  }
  await assert.rejects(s.leg.check(q('0.003'), false), /under Hyperliquid's 10 USD minimum/);
  assert.equal(s.sent.length, 0);
});

// ---- Orderly ----

interface FakeStream {
  snap: OrderlyAccountSnapshot | null;
  state(): Promise<OrderlyAccountSnapshot>;
}

function snapshot(positions: OrderlyStreamPosition[], receivedAt: number): OrderlyAccountSnapshot {
  return {
    accountId: '0x', positions, balances: {}, invalidBalances: {}, positionsAt: receivedAt, balancesAt: receivedAt, positionsFrom: 'push',
    positionsReceivedAt: receivedAt, balancesFrom: 'push', confirmedAt: receivedAt,
  };
}

const ROW = (qty: number): OrderlyStreamPosition => ({
  symbol: 'PERP_ETH_USDC', positionQty: qty, costPosition: 0, lastSumUnitaryFunding: 0, averageOpenPrice: 2500, estLiqPrice: 0, accruedFundingFee: 0,
});

function orderlyLeg(options: {
  answer?: (fields: Partial<OrderlyRequest>) => Promise<{ data: { order_id?: unknown }; tx: TxRef[]; clientOrderId: string | null }>;
  reports?: (leg: OrderlyLeg) => void;
  read?: () => Promise<unknown>;
  assumedStart?: bigint;
} = {}) {
  const sent: Partial<OrderlyRequest>[] = [];
  const stream: FakeStream = { snap: null, state: async () => { if (stream.snap === null) throw new Error('not known'); return stream.snap; } };
  const lines: string[] = [];
  const leg: OrderlyLeg = new OrderlyLeg({
    relayer: {
      async orderlyRequest<T>(kind: string, fields: Partial<OrderlyRequest>): Promise<{ data: T; tx: TxRef[]; clientOrderId: string | null }> {
        assert.equal(kind, 'order');
        sent.push(fields);
        options.reports?.(leg);
        const a = await (options.answer ?? (async () => ({ data: { order_id: 77 }, tx: [NEAR_TX], clientOrderId: 'g12' })))(fields);
        return a as unknown as { data: T; tx: TxRef[]; clientOrderId: string | null };
      },
    },
    readPositions: options.read ?? (async () => ({ rows: [] })),
    stream, symbol: 'PERP_ETH_USDC', lot: lotQty('0.0001'), baseMin: lotQty('0.0001'), quoteTick: 0.01, minNotional: 10, maxNotionalUsd: 50,
    maxSz: '0.02', bestPx: async (side) => (side === 'BUY' ? 2500.004 : 2499.996), reportTimeoutMs: 60, pushWaitMs: 40, settleMs: 5,
    log: (l) => lines.push(l), ...(options.assumedStart === undefined ? {} : { assumedStart: options.assumedStart }),
  });
  return { leg, sent, stream, lines };
}

const report = (status: string, extra: Record<string, unknown> = {}) => ({
  symbol: 'PERP_ETH_USDC', orderId: 77, clientOrderId: 'g12', side: 'SELL', status, executedQuantity: 0, totalExecutedQuantity: 0, avgPrice: 0, ...extra,
});

test('orderly: an IOC confirmed by its executionreport, even one pushed before the POST answer', async () => {
  const s = orderlyLeg({
    reports: (leg) => {
      leg.onExecutionReport(report('NEW'));
      leg.onExecutionReport(report('FILLED', { executedQuantity: 0.005, totalExecutedQuantity: 0.005, avgPrice: 2499.5 }));
      leg.onExecutionReport({ ...report('FILLED'), symbol: 'PERP_BTC_USDC', orderId: 78 });
    },
  });
  const out = await s.leg.order('SELL', q('0.005'), false, 'open');
  assert.equal(out.kind, 'filled');
  assert.equal(out.kind === 'filled' && out.filled, q('0.005'));
  assert.equal(out.kind === 'filled' && out.avgPx, 2499.5);
  assert.deepEqual([out.ref.orderId, out.ref.clientId], ['77', 'g12']);
  assert.deepEqual(s.sent[0], { symbol: 'PERP_ETH_USDC', side: 'SELL', order_type: 'IOC', price: '2487.5', quantity: '0.005', reduce_only: false });
  assert.equal(s.leg.reportsFor('77').length, 2);
});

test('orderly: prices sit past the best by the slippage, on the tick, and never inside the best', async () => {
  const s = orderlyLeg({ reports: (leg) => leg.onExecutionReport(report('FILLED', { side: 'BUY', executedQuantity: 0.005, totalExecutedQuantity: 0.005 })) });
  await s.leg.order('BUY', q('0.005'), true, 'close');
  assert.equal(s.sent[0]!.price, '2512.5');
  assert.equal(s.sent[0]!.reduce_only, true);
});

test('orderly: no final report is unknown (with the client_order_id); a cancelled IOC with no fill is proof; refusals are proof', async () => {
  const silent = await orderlyLeg({ reports: (leg) => leg.onExecutionReport(report('NEW')) }).leg.order('SELL', q('0.005'), false, 'open');
  assert.equal(silent.kind, 'unknown');
  assert.ok(silent.kind === 'unknown' && silent.error instanceof OutcomeUnknown && silent.error.ids.orderlyClientOrderId === 'g12');

  const cancelled = await orderlyLeg({ reports: (leg) => leg.onExecutionReport(report('CANCELLED')) }).leg.order('SELL', q('0.005'), false, 'open');
  assert.equal(cancelled.kind, 'failed');

  const partial = await orderlyLeg({
    reports: (leg) => {
      leg.onExecutionReport(report('PARTIAL_FILLED', { executedQuantity: 0.002, totalExecutedQuantity: 0.002 }));
      leg.onExecutionReport(report('CANCELLED', { totalExecutedQuantity: 0.002 }));
    },
  }).leg.order('SELL', q('0.005'), false, 'open');
  assert.equal(partial.kind === 'filled' && partial.filled, q('0.002'));

  const refused = await orderlyLeg({ answer: async () => { throw new OrderlyApiError('order', 400, -1102, 'too small', '{}'); } }).leg.order('SELL', q('0.005'), false, 'open');
  assert.equal(refused.kind, 'failed');
  const lost = await orderlyLeg({ answer: async () => { throw new OutcomeUnknown('orderly order', 'timeout', { orderlyClientOrderId: 'g13' }, [NEAR_TX]); } }).leg.order('SELL', q('0.005'), false, 'open');
  assert.deepEqual([lost.kind, lost.ref.clientId, lost.ref.tx], ['unknown', 'g13', [NEAR_TX]]);
  const noId = await orderlyLeg({ answer: async () => ({ data: {}, tx: [], clientOrderId: 'g14' }) }).leg.order('SELL', q('0.005'), false, 'open');
  assert.equal(noId.kind, 'unknown');
});

test('orderly: sizes and notionals the venue or the policy would refuse are caught before signing', async () => {
  const s = orderlyLeg();
  for (const size of [q('0.00455'), q('0.003'), q('0.021')]) assert.equal((await s.leg.order('SELL', size, false, 'open')).kind, 'failed');
  assert.equal(s.sent.length, 0);
  await assert.rejects(s.leg.check(q('0.003'), false), /under Orderly's min_notional 10/);
  await s.leg.check(q('0.003'), true).catch(() => assert.fail('a reduce-only close has no minimum'));
});

test('orderly: the position comes from the signed read; a refused read falls back to a push after the order', async () => {
  const read = orderlyLeg({ read: async () => ({ rows: [{ symbol: 'PERP_ETH_USDC', position_qty: -0.005, cost_position: 1, last_sum_unitary_funding: 0, average_open_price: 1, est_liq_price: 0 }] }) });
  assert.equal(await read.leg.position(), q('-0.005'));

  const refused = new ContractRefusal('E_ARGS', 'kind "positions" is not an Orderly request kind');
  const s = orderlyLeg({ read: async () => { throw refused; } });
  await assert.rejects(s.leg.position(), /position unknown: the positions read is refused/);
  const sentAt = Date.now();
  s.stream.snap = snapshot([ROW(-0.005)], sentAt - 10);
  await assert.rejects(s.leg.position(sentAt), /no push came after the order/, 'a push from before the order is not proof of what the order did');
  s.stream.snap = snapshot([ROW(-0.005)], sentAt + 1);
  assert.equal(await s.leg.position(sentAt), q('-0.005'));
  assert.ok(s.lines.some((l) => /positions come from the private session's pushes/.test(l)));
  // Another error from the read is not a refusal: it is thrown, never papered over.
  await assert.rejects(orderlyLeg({ read: async () => { throw new Error('mpc down'); } }).leg.position(), /mpc down/);
});

test('orderly: an asserted start is used only when nothing is known, and a push that contradicts it stops the leg', async () => {
  const refused = new ContractRefusal('E_ARGS', 'no read kind');
  const ok = orderlyLeg({ read: async () => { throw refused; }, assumedStart: 0n });
  assert.equal(await ok.leg.position(), 0n);
  ok.leg.onExecutionReport(report('FILLED', { executedQuantity: 0.005, totalExecutedQuantity: 0.005 }));
  const t = Date.now();
  ok.stream.snap = snapshot([ROW(-0.005)], t + 1);
  assert.equal(await ok.leg.position(t), q('-0.005'), 'start 0 plus the session\'s fill: consistent');

  const wrong = orderlyLeg({ read: async () => { throw refused; }, assumedStart: 0n });
  assert.equal(await wrong.leg.position(), 0n);
  wrong.leg.onExecutionReport(report('FILLED', { executedQuantity: 0.005, totalExecutedQuantity: 0.005 }));
  const t2 = Date.now();
  wrong.stream.snap = snapshot([ROW(-0.015)], t2 + 1);
  await assert.rejects(wrong.leg.position(t2), /the asserted start 0 was wrong: the venue shows -0.015/);
  await assert.rejects(wrong.leg.position(), /was wrong/, 'and stays stopped');
});
