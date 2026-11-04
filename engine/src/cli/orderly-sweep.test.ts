// panic_close's Orderly sweep: every Orderly position the pair trader does not hold is closed reduce-only through the
// session (split under the cap less the band, read back after each order), the replay window is watched after it and
// a position that comes back is closed and journaled, no session or no lock closes nothing and says so, and the
// panic reducer closes the pair first, leaves a rescue's reduce to the pair, and with no pair is panicOnly.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamEvent, VenueId } from '@gimbal/shared';
import type { Reducer, ReduceResult } from '../rescue/rescuer.ts';
import type { LegOutcome, LegSide, TradeLeg } from '../trade/legs.ts';
import { toQty } from '../trade/lots.ts';
import { REPLAY_WINDOW_MS } from '../trade/pair.ts';
import type { AccountState } from '../venues/venue.ts';
import type { OrderlySweepInput } from './orderly-sweep.ts';
import { OrderlySweep, SWEEP_POLL_MS, panicReducer } from './orderly-sweep.ts';
import type { OrderlyLegSpec } from './pair-ops.ts';

class Leg implements TradeLeg {
  readonly venue: VenueId = 'orderly';
  readonly symbol: string;
  readonly lot = toQty('1');
  readonly replayable = true;
  pos: bigint;
  cap: bigint;
  orders: { side: LegSide; size: bigint; reduceOnly: boolean; reason: string }[] = [];
  constructor(symbol: string, pos: string, cap = '1000') {
    this.symbol = symbol;
    this.pos = toQty(pos);
    this.cap = toQty(cap);
  }
  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return this.cap;
  }
  async position(): Promise<bigint> {
    return this.pos;
  }
  async order(side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome> {
    this.orders.push({ side, size, reduceOnly, reason });
    this.pos += side === 'BUY' ? size : -size;
    return { kind: 'filled', filled: size, avgPx: 1, fee: 0.01, ref: { venue: 'orderly', side, size: String(size), reduceOnly, orderId: `o${this.orders.length}`, clientId: null, tx: [{ chain: 'near', id: `t${this.orders.length}`, url: '' }], sentAt: 0 } };
  }
}

function setup(legs: Leg[], options: { session?: boolean; begin?: string | null } = {}) {
  let now = 1_000_000;
  const events: StreamEvent[] = [];
  const specs: OrderlyLegSpec[] = [];
  const marks: string[] = [];
  const bySymbol = new Map(legs.map((l) => [l.symbol, l]));
  const account = async (): Promise<AccountState> => ({
    venue: 'orderly', address: 'acct', time: now, equityUsd: 100, freeMarginUsd: 100, maintenanceMarginUsd: 0,
    positions: legs.filter((l) => l.pos !== 0n).map((l) => ({
      symbol: l.symbol, size: Number(l.pos) / 1e8, entryPx: 1, liqPx: null, marginUsd: 1, unrealizedPnlUsd: 0, leverage: 1, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0,
    })),
  });
  const hooks: { onSleep: (() => void) | null } = { onSleep: null };
  const input: OrderlySweepInput = {
    session: options.session === false ? undefined : {
      leg: (spec) => {
        specs.push(spec);
        return bySymbol.get(spec.symbol) ?? null;
      },
      account,
    },
    spec: (symbol) => (symbol.startsWith('PERP_') ? { symbol, oraclePx: async () => 1, maxNotionalUsd: 100, slippageBps: 50 } : null),
    begin: async () => {
      marks.push('begin');
      return options.begin ?? null;
    },
    end: () => marks.push('end'),
    bandBps: 100,
    clock: { now: () => now },
    sleep: async (ms) => {
      now += ms;
      hooks.onSleep?.();
    },
    log: () => {},
    publish: (e) => events.push(e),
  };
  return { sweep: new OrderlySweep(input), events, specs, marks, hooks, now: () => now };
}

const journal = (events: StreamEvent[]) => events.flatMap((e) => (e.type === 'journal' ? [e.data.summary] : []));

test('sweep: every Orderly position but the covered ones is closed reduce-only, split under the cap less the band', async () => {
  const eth = new Leg('PERP_ETH_USDC', '-5', '2');
  const xlm = new Leg('PERP_XLM_USDC', '10');
  const s = setup([eth, xlm]);
  const r = await s.sweep.sweep(['PERP_XLM_USDC'], 'panic_close: the owner closed the desk');
  assert.equal(r.closed, true, r.notes.join('; '));
  assert.equal(eth.pos, 0n);
  assert.equal(xlm.pos, toQty('10'), 'the pair trader closes its own leg');
  assert.deepEqual(eth.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['BUY', toQty('1'), true], ['BUY', toQty('1'), true], ['BUY', toQty('1'), true], ['BUY', toQty('1'), true], ['BUY', toQty('1'), true]],
    '2 under a 100 bps band floors to 1 lot');
  assert.deepEqual(r.legs.map((l) => [l.symbol, l.start, l.final]), [['PERP_ETH_USDC', '-5', '0']]);
  assert.equal(r.tx.length, 5);
  assert.deepEqual(s.marks, ['begin', 'end']);
  await s.sweep.watch;
});

test('sweep: the replay window is watched after it; a position that comes back is closed again and journaled', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  const s = setup([eth]);
  let polls = 0;
  s.hooks.onSleep = () => {
    if (++polls === 2) eth.pos = toQty('3');          // a replayed copy of the open's IOC lands
  };
  const r = await s.sweep.sweep([], 'panic_close');
  assert.equal(r.closed, true);
  assert.ok(s.sweep.watch !== null, 'watched after the sweep');
  await s.sweep.watch;
  assert.equal(eth.pos, 0n);
  assert.deepEqual(eth.orders.map((o) => [o.side, o.size, o.reduceOnly]), [['SELL', toQty('3'), true], ['SELL', toQty('3'), true]]);
  assert.deepEqual(journal(s.events), ['panic_close: Orderly PERP_ETH_USDC 3 -> 0 came back after the sweep (a replayed order?): closed reduce-only']);
  assert.ok(s.now() >= 1_000_000 + REPLAY_WINDOW_MS, 'the watch ran to the end of the window');
  assert.equal(polls, Math.ceil(REPLAY_WINDOW_MS / SWEEP_POLL_MS) + 1);
});

test('sweep: no session, no lock or signing, or a market it cannot price: nothing closed, and said', async () => {
  const eth = new Leg('PERP_ETH_USDC', '3');
  const none = await setup([eth], { session: false }).sweep.sweep([], 'panic_close');
  assert.equal(none.closed, false);
  assert.match(none.notes.join(' '), /serve has no Orderly session \(GIMBAL_ORDERLY_PAIRS=1\): the desk's Orderly positions are neither read nor closed here, and pair-mainnet cannot close them/);
  const locked = setup([eth], { begin: 'the trader lock is not held: held by pid 7' });
  const r = await locked.sweep.sweep([], 'panic_close');
  assert.equal(r.closed, false);
  assert.match(r.notes.join(' '), /the desk's Orderly positions are not closed: the trader lock is not held: held by pid 7/);
  assert.equal(locked.sweep.watch, null);
  const odd = new Leg('WEIRD', '1');
  const u = await setup([odd]).sweep.sweep([], 'panic_close');
  assert.deepEqual([u.closed, u.notes], [false, ['Orderly WEIRD: not a market the desk can price, so it is not closed here']]);
  assert.equal(eth.orders.length + odd.orders.length, 0);
});

/** A pair trader's close as the protections see it: records what it was asked, closes nothing itself. */
function fakePair(status: ReduceResult['status'], legs: TradeLeg[]): Reducer & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked, legs, lot: toQty('1'),
    close: async (request) => {
      asked.push(request.by ?? 'none');
      return { status, size: '10', legs: [], notes: [`pair ${status}`], tx: [], feeUsd: 0, feeUnknown: 0 };
    },
  };
}

test('panicReducer: panic_close closes the pair, then sweeps the rest; a rescue\'s reduce is the pair\'s alone; with no pair it is panicOnly', async () => {
  const pairLeg = new Leg('PERP_XLM_USDC', '10');
  const stray = new Leg('PERP_ETH_USDC', '-2');
  const s = setup([pairLeg, stray]);
  const pair = fakePair('closed', [pairLeg]);
  const red = panicReducer(pair, s.sweep);
  assert.equal(red.panicOnly, undefined);
  const r = await red.close({ reason: 'panic_close', reduceOnly: true, by: 'panic_close' });
  assert.deepEqual([r.status, pair.asked, stray.pos, pairLeg.pos], ['closed', ['panic_close'], 0n, toQty('10')]);
  await red.close({ reason: 'rescue', targets: [0n, 0n], reduceOnly: true, by: 'rescue reduce' });
  assert.deepEqual(pair.asked, ['panic_close', 'rescue reduce']);
  assert.equal(stray.orders.length, 1, 'a rescue never sweeps');
  await s.sweep.watch;

  // No pair: panicOnly; the other venues' legs are named and the close is not done while they are held.
  const t = setup([new Leg('PERP_ETH_USDC', '4')]);
  const alone = panicReducer(null, t.sweep, async () => 'no pair trader holds hyperliquid XLM here: nothing closed it; close by hand (stop serve, then pair-mainnet close --send)');
  assert.match(alone.panicOnly ?? '', /no pair trader holds the legs here/);
  await assert.rejects(alone.close({ reason: 'rescue', by: 'rescue reduce' }), /no pair trader holds the legs here: nothing was closed/);
  const left = await alone.close({ reason: 'panic_close', reduceOnly: true, by: 'panic_close' });
  assert.equal(left.status, 'stuck');
  assert.match(left.notes.join(' '), /no pair trader holds hyperliquid XLM here/);
  await t.sweep.watch;
  const flat = setup([new Leg('PERP_ETH_USDC', '4')]);
  assert.equal((await panicReducer(null, flat.sweep).close({ reason: 'panic_close', by: 'panic_close' })).status, 'closed');
  await flat.sweep.watch;

  // A pair that did not end flat stays what it ended.
  const u = setup([]);
  assert.equal((await panicReducer(fakePair('unhedged', []), u.sweep).close({ reason: 'panic_close', by: 'panic_close' })).status, 'unhedged');
  await u.sweep.watch;
});
