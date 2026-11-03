// Review S1, the rescue part: a live rescuer whose start read fails runs detect only and is started again in the
// background with the start backoff; the fallback and the recovery are journaled; a configuration error is never
// retried; the panic_close watch is the same object across the swap.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '../cli/start-errors.ts';
import type { RescueTrigger } from '../risk/engine.ts';
import type { ClosingWatch } from './closing.ts';
import { retryingRescue } from './rescue-retry.ts';
import type { RescueTimers } from './rescue-retry.ts';
import type { ServeRescue } from './serve-rescue.ts';

const trigger = { id: 'rescue-1', venue: 'hyperliquid', symbol: 'XLM' } as RescueTrigger;

/** A fake serveRescue: live (takes triggers) or detect only, with its own panic_close watch unless one is handed in. */
function fakeRescue(live: boolean, closing: ClosingWatch | undefined, taken: RescueTrigger[], stops: string[]): ServeRescue {
  const name = live ? 'live' : 'detect';
  return {
    rescuer: live ? (t) => { taken.push(t); } : undefined,
    closing: closing ?? ({ name: `${name} watch` } as unknown as ClosingWatch),
    summary: live ? 'rescue: LIVE on mainnet' : 'rescue: detect only on mainnet',
    running: () => (live ? 'rescue-1' : null),
    stop: async () => { stops.push(name); },
    routes: [`${name} routes`],
  };
}

function rig(fails: () => Error | null) {
  const journal: { kind: string; summary: string }[] = [];
  const logs: string[] = [];
  const taken: RescueTrigger[] = [];
  const stops: string[] = [];
  const waits: number[] = [];
  const handed: (ClosingWatch | undefined)[] = [];
  let due: (() => void) | null = null;
  const timers: RescueTimers = {
    setTimeout: (fn, ms) => { waits.push(ms); due = fn; return ms; },
    clearTimeout: () => { due = null; },
  };
  const start = () => retryingRescue({
    live: async (closing) => {
      handed.push(closing);
      const err = fails();
      if (err !== null) throw err;
      return fakeRescue(true, closing, taken, stops);
    },
    detectOnly: async () => fakeRescue(false, undefined, taken, stops),
    log: (l) => logs.push(l),
    journal: (kind, summary) => journal.push({ kind, summary }),
    timers,
  });
  return { start, journal, logs, taken, stops, waits, handed, due: () => due };
}

test('a live start that fails: detect only, journaled; retried with backoff (one journal per reason); then live, journaled, same watch', async () => {
  let err: Error | null = new Error('near rpc: 503 Service Unavailable');
  const w = rig(() => err);
  const r = await w.start();
  assert.equal(r.live(), false);
  assert.equal(r.rescuer(trigger), false, 'not taken: the risk engine publishes it at detect');
  assert.equal(r.running(), null);
  assert.match(r.pending() ?? '', /near rpc: 503/);
  assert.match(r.summary, /^rescue: detect only on mainnet; the live rescuer did not start \(near rpc: 503 Service Unavailable\)/);
  assert.equal(w.journal.length, 1);
  assert.equal(w.journal[0]!.kind, 'error');
  assert.match(w.journal[0]!.summary, /the live rescuer did not start \(near rpc: 503 Service Unavailable\): detect only for now.*tried again in 5 s/);
  assert.deepEqual(w.waits, [5_000]);
  const watch = r.closing;

  // The timer fires: another reason is journaled, the same kind again (only its status code differs) is logged only;
  // the backoff doubles each time.
  err = new Error('near rpc: 502 Bad Gateway');
  w.due()!();
  await r.retry();
  assert.deepEqual(w.waits, [5_000, 10_000]);
  assert.equal(w.journal.length, 2, 'a new reason is journaled');
  err = new Error('near rpc: 504 Bad Gateway');
  assert.equal(await r.retry(), false);
  assert.deepEqual(w.waits, [5_000, 10_000, 20_000]);
  assert.equal(w.journal.length, 2, 'the same kind of failure again: logged only');
  assert.match(w.logs.at(-1)!, /try 3: near rpc: 504 Bad Gateway\); detect only, tried again in 20 s/);

  // Recovery: the live rescuer takes the next trigger, on the fallback's panic_close watch; the fallback is stopped.
  err = null;
  assert.equal(await r.retry(), true);
  assert.equal(r.live(), true);
  assert.equal(r.pending(), null);
  assert.equal(r.closing, watch, 'one panic_close watch for the whole run');
  assert.equal(w.handed.at(-1), watch);
  assert.deepEqual(w.stops, ['detect']);
  assert.equal(r.rescuer(trigger), true);
  assert.deepEqual(w.taken, [trigger]);
  assert.equal(r.running(), 'rescue-1');
  assert.equal(r.summary, 'rescue: LIVE on mainnet');
  assert.deepEqual(w.journal.at(-1), { kind: 'wait', summary: 'rescue: the live rescuer started after 3 failed attempt(s); it takes the next trigger (rescue: LIVE on mainnet)' });
  assert.ok(w.logs.includes('live routes'));
  assert.equal(await r.retry(), true, 'nothing left to retry');
  assert.deepEqual(w.waits, [5_000, 10_000, 20_000], 'no timer after the recovery');
  await r.stop();
  assert.deepEqual(w.stops, ['detect', 'live']);
});

test('a configuration error: at the first try it is thrown (serve stops); on a retry it ends the retries, journaled', async () => {
  await assert.rejects(rig(() => new ConfigError('GIMBAL_RESCUE=1 needs RELAYER_EVM_PRIVATE_KEY')).start(), /needs RELAYER_EVM_PRIVATE_KEY/);

  let err: Error = new Error('get_desk: fetch failed');
  const w = rig(() => err);
  const r = await w.start();
  err = new ConfigError('gimbal.near is a testnet contract, but the engine runs on mainnet');
  assert.equal(await r.retry(), false);
  assert.match(r.pending() ?? '', /a configuration error: fix it and restart serve; not tried again/);
  assert.match(w.journal.at(-1)!.summary, /the live rescuer is refused \(gimbal\.near is a testnet contract.*\): detect only until serve restarts/);
  assert.deepEqual(w.waits, [5_000], 'no further retry is scheduled');
  const tries = w.handed.length;
  assert.equal(await r.retry(), false);
  assert.equal(w.handed.length, tries, 'not tried again');
  assert.equal(r.live(), false);
});

test('a live start that works at once: nothing journaled, nothing scheduled; stop() during a retry drops the late rescuer', async () => {
  const ok = rig(() => null);
  const r = await ok.start();
  assert.equal(r.live(), true);
  assert.equal(r.pending(), null);
  assert.deepEqual([ok.journal, ok.waits], [[], []]);

  let release: (() => void) | null = null;
  let first = true;
  const stops: string[] = [];
  const late = await retryingRescue({
    live: async (closing) => {
      if (first) {
        first = false;
        throw new Error('solana rpc: timeout');
      }
      await new Promise<void>((res) => { release = res; });
      return fakeRescue(true, closing, [], stops);
    },
    detectOnly: async () => fakeRescue(false, undefined, [], stops),
    log: () => {}, journal: () => {},
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  const retried = late.retry();
  await late.stop();
  release!();
  assert.equal(await retried, false);
  assert.equal(late.live(), false);
  assert.deepEqual(stops, ['detect', 'live'], 'the rescuer that started after stop() is stopped at once');
});
