// panic_close on the engine's side: the first `closing: true` cancels the resting orders, then closes both legs
// reduce-only, journals both and blocks opens and rescues; a close that is not flat is tried again after a minute;
// set_paused(false) clears it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamEvent } from '@gimbal/shared';
import type { PairResult } from '../trade/pair.ts';
import type { TradeLeg } from '../trade/legs.ts';
import { CLOSE_RETRY_MS, ClosingWatch } from './closing.ts';
import type { Reducer } from './rescuer.ts';

function setup(results: PairResult['status'][] = ['closed']) {
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
      const status = results.shift() ?? 'closed';
      return {
        status, size: '1', notes: status === 'closed' ? [] : ['phoenix did not fill'], tx: [],
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
  s.watch.observe(true);
  assert.match(s.watch.blocked()!, /closing \(panic_close\)/);
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
