// panic_close on the engine's side: the first `closing: true` cancels the resting orders, then closes both legs
// reduce-only, journals both and blocks opens and rescues; a close that is not flat is tried again after a minute;
// set_paused(false) clears it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamEvent } from '@gimbal/shared';
import type { PairResult } from '../trade/pair.ts';
import type { TradeLeg } from '../trade/legs.ts';
import { CLOSE_RETRY_MS, ClosingWatch } from './closing.ts';
import { loadRescueRecording } from './recorded.ts';
import type { Reducer } from './rescuer.ts';
import { Rescuer } from './rescuer.ts';

const rec = loadRescueRecording();

function setup(results: PairResult['status'][] = ['closed'], gate: Promise<void>[] = []) {
  let t = 1_000_000;
  const calls: string[] = [];
  const closes: { reason: string; targets?: [bigint, bigint]; reduceOnly?: boolean }[] = [];
  const events: StreamEvent[] = [];
  const reducer: Reducer = {
    legs: [{ venue: 'hyperliquid', symbol: 'ETH' }, { venue: 'phoenix', symbol: 'ETH' }] as unknown as [TradeLeg, TradeLeg],
    lot: 10_000n,
    close: async (req) => {
      calls.push('close');
      closes.push(req);
      await gate.shift();
      const status = results.shift() ?? 'closed';
      return {
        status, size: '1', notes: status === 'closed' ? [] : ['phoenix did not fill'], tx: [], feeUsd: 0, feeUnknown: 0,
        legs: [
          { venue: 'hyperliquid', symbol: 'ETH', start: '1', target: '0', final: status === 'closed' ? '0' : '0', orders: [] },
          { venue: 'phoenix', symbol: 'ETH', start: '-1', target: '0', final: status === 'closed' ? '0' : '-1', orders: [] },
        ],
      };
    },
  };
  const watch = new ClosingWatch({
    publish: (e) => events.push(e), clock: { now: () => t },
    cancelResting: async () => {
      calls.push('cancel');
      return { cancelled: 2, tx: [], notes: [] };
    },
    reducer: () => reducer,
  });
  const journal = () => events.flatMap((e) => (e.type === 'journal' ? [`${e.data.kind}: ${e.data.summary}`] : []));
  return { watch, calls, closes, journal, advance: (ms: number) => { t += ms; } };
}

test('closing: cancel resting orders, then close both legs reduce-only, journaled; opens and rescues blocked', async () => {
  const s = setup();
  assert.equal(s.watch.blocked(), null);
  // As serve wires it: the rescuer's desk says closing while the watch blocks, and the pair trader's openBlocked is it.
  const rescuer = new Rescuer({
    mode: 'testnet', publish: () => {}, clock: { now: () => 0 }, sleep: async () => {},
    oneClick: { source: 'test', quote: async () => { throw new Error('no quote while closing'); }, submitDeposit: async () => ({ status: 0 }), status: async () => ({ status: '', body: null }) },
    desk: async () => ({ addresses: rec.desk, policy: rec.policy, reserveUsd: 100, closing: s.watch.blocked() !== null }),
    view: () => ({ legs: [], freeMargin: {} }), landing: { confirms: () => null, find: async () => null }, payers: {},
    ended: (id, landed) => ended.push([id, landed]), failure: (f) => reasons.push(f?.reason ?? ''),
  });
  const ended: [string, boolean][] = [];
  const reasons: string[] = [];
  s.watch.observe(true);
  assert.match(s.watch.blocked()!, /closing \(panic_close\)/);
  rescuer.take({ id: 'r', venue: 'hyperliquid', symbol: 'ETH', distancePct: 5, rescuePct: 8, watchPct: 15, amountUsd: 20, amountKnown: true, from: 'reserve', stress: false, attempt: 0, at: 0 });
  await rescuer.current;
  assert.deepEqual(ended, [['r', false]]);
  assert.match(reasons[0]!, /the desk is closing \(panic_close\): no rescue starts/);
  await s.watch.current;
  assert.deepEqual(s.calls, ['cancel', 'close']);
  assert.deepEqual(s.closes, [{ reason: 'panic_close: the owner closed the desk', reduceOnly: true }]);
  const j = s.journal();
  assert.equal(j.length, 3);
  assert.match(j[0]!, /^exit: panic_close read from get_desk/);
  assert.match(j[1]!, /^exit: panic_close: cancelled 2 resting orders/);
  assert.match(j[2]!, /^exit: panic_close: both legs closed reduce-only \(hyperliquid ETH 1 -> 0, phoenix ETH -1 -> 0\)/);
  // Later reads of closing: true do nothing more once both legs are closed.
  s.advance(CLOSE_RETRY_MS * 2);
  s.watch.observe(true);
  assert.equal(s.watch.current, null);
  assert.deepEqual(s.calls, ['cancel', 'close']);
  // set_paused(false) clears it; the next panic_close closes again.
  s.watch.observe(false);
  assert.equal(s.watch.blocked(), null);
  s.watch.observe(true);
  await s.watch.current;
  assert.deepEqual(s.calls, ['cancel', 'close', 'cancel', 'close']);
});

test('closing: a close that is not flat is tried again after a minute, not on every read', async () => {
  const s = setup(['stuck', 'closed']);
  s.watch.observe(true);
  await s.watch.current;
  assert.match(s.journal().at(-1)!, /^error: panic_close: the reduce-only close ended stuck .*phoenix did not fill; tried again in 60 s/);
  s.advance(10_000);
  s.watch.observe(true);
  assert.equal(s.watch.current, null, 'not yet');
  s.advance(CLOSE_RETRY_MS);
  s.watch.observe(true);
  await s.watch.current;
  assert.deepEqual(s.calls, ['cancel', 'close', 'cancel', 'close']);
  assert.match(s.journal().at(-1)!, /both legs closed reduce-only/);
});

test('closing without a pair trader says so once and trades nothing', async () => {
  const events: StreamEvent[] = [];
  const watch = new ClosingWatch({ publish: (e) => events.push(e), clock: { now: () => 0 }, reducer: () => null });
  watch.observe(true);
  await watch.current;
  watch.observe(true);
  const errors = events.filter((e) => e.type === 'journal' && e.data.kind === 'error');
  assert.equal(errors.length, 1);
  assert.ok(watch.blocked() !== null);
});

test('closing race: an unpause during a close in flight, then a new panic_close: the stale close does not mark it done', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const s = setup(['closed', 'closed'], [held]);
  s.watch.observe(true);
  const stale = s.watch.current!;
  s.watch.observe(false);              // set_paused(false) while the first close still runs
  assert.equal(s.watch.blocked(), null);
  s.watch.observe(true);               // a new panic_close: waits for the close in flight
  assert.equal(s.watch.current, stale);
  release();
  await stale;
  s.watch.observe(true);               // the next read starts this panic_close's own close at once
  assert.notEqual(s.watch.current, null, 'the new panic_close is not taken as done');
  await s.watch.current;
  assert.deepEqual(s.calls, ['cancel', 'close', 'cancel', 'close']);
  assert.equal(s.journal().filter((j) => /panic_close read from get_desk/.test(j)).length, 2);
});

test('closing with no reducer: the journal says why (alert only), and nothing is cancelled or closed', async () => {
  const events: StreamEvent[] = [];
  let cancels = 0;
  const watch = new ClosingWatch({
    publish: (e) => events.push(e), clock: { now: () => 1 }, reducer: () => null,
    cancelResting: async () => { cancels++; return { cancelled: 0, tx: [], notes: [] }; },
    notTrading: () => 'alert only: GIMBAL_TRADE is not 1',
  });
  watch.observe(true);
  await watch.current;
  const lines = events.flatMap((e) => (e.type === 'journal' ? [`${e.data.kind}: ${e.data.summary}`] : []));
  assert.equal(cancels, 0);
  assert.equal(lines[0], 'exit: panic_close read from get_desk: no rescue or open starts');
  assert.match(lines[1] ?? '', /^error: panic_close: this engine is alert only: GIMBAL_TRADE is not 1: nothing was cancelled or closed; cancel the resting orders and close both legs by hand/);
});
