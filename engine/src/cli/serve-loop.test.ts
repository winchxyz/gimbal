// serve's strategy loop end to end in replay: the recorded scan feeds the loop, decide() asks for an act, a fake
// executor carries it out, and the journal and the decision come out through the server (GET /state, POST /rotate,
// POST /close); plus the window -> policy symbol mapping serve trades.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DeskState, EngineState, JournalEntry, Leg, StrategyDecision, StreamEvent, Window as FundingWindow } from '@gimbal/shared';
import { replayReaders } from '../readers.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from '../scanner/config.ts';
import { Scanner } from '../scanner/scanner.ts';
import { EngineServer } from '../server.ts';
import type { DecideInput, Decision } from '../strategy/decide.ts';
import type { ActOutcome, LoopHands, StrategyLoop } from '../strategy/loop.ts';
import { sizeFor } from '../strategy/decide.ts';
import { STRATEGY, T0, win as deskWin } from '../strategy/test-helpers.ts';
import { VirtualClock, readRecording } from '../venues/replay.ts';
import { replayStart } from './serve-replay.ts';
import { adlGate, depthAtSize, fillsOf, loopHands, openGateText, openedQty, protectionText, riskFacts, serveLoop, windowFacts, windowSymbol } from './serve-loop.ts';
import type { PairHands, ServePair } from './serve-pair.ts';
import { toQty } from '../trade/lots.ts';
import type { PairResult } from '../trade/pair.ts';
import type { VenueReader } from '../venues/venue.ts';
import type { WindowCarry } from '../scanner/scanner.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const HOUR_MS = 3_600_000;
const RECORDING = fileURLToPath(new URL('../../fixtures/replay/scan-mainnet-2026-10-31.jsonl.gz', import.meta.url));

/** The fake executor: what an open and a close would do, recorded; the held pair is what it opened. */
function fakeExecutor() {
  const calls: string[] = [];
  let held: { symbol: string; legUsd: number; pnlUsd: number; oneLeg: null } | null = null;
  const tx = (id: string) => [{ chain: 'hyperliquid' as const, id, url: `https://app.hyperliquid-testnet.xyz/explorer/tx/${id}` }];
  const hands: LoopHands = {
    blocked: () => null,
    held: () => held,
    symbolOf: (w) => ({ symbol: w.symbol }),
    open: async (r): Promise<ActOutcome> => {
      calls.push(`open ${r.symbol} ${r.legUsd} ${r.leverage}x ${r.qty}`);
      held = { symbol: r.symbol, legUsd: r.legUsd, pnlUsd: 0, oneLeg: null };
      return { ok: true, reason: 'opened both legs maker first, net 0', sent: true, tx: tx('0xopen'), feeUsd: 0.4, open: [] };
    },
    close: async (r): Promise<ActOutcome> => {
      calls.push(`close (${r.reason})`);
      held = null;
      return { ok: true, reason: 'both legs closed reduce-only, flat', sent: true, tx: tx('0xclose'), feeUsd: 0.3, open: [] };
    },
  };
  return { hands, calls };
}

test('replay: scan -> decide -> act (fake executor) -> journal and decision events, then POST /rotate and /close', async () => {
  const lines = readRecording(RECORDING);
  const clock = new VirtualClock(replayStart(lines));
  const readers = replayReaders(lines, clock);
  const exec = fakeExecutor();
  const events: StreamEvent[] = [];
  const decided: DecideInput[] = [];
  // decide() stand-in: enter the best desk window once, then hold.
  const decide = (input: DecideInput): Decision => {
    decided.push(input);
    const best = [...input.windows].filter((w) => w.tradable).sort((a, b) => b.netAprPct - a.netAprPct)[0]!;
    const base = { counters: input.counters, vetoCandidate: null };
    if (!input.strategy.auto) return { ...base, act: null, decision: { action: 'off', reason: 'Auto is off', windowId: null, heldId: input.held?.windowId ?? null, at: input.now } };
    if (input.held !== null) return { ...base, act: null, decision: { action: 'hold', reason: `holding ${input.held.windowId}`, windowId: null, heldId: input.held.windowId, at: input.now } };
    return {
      ...base, act: { kind: 'enter', windowId: best.id, legUsd: 200, leverage: 1.5, qty: '2' },
      decision: { action: 'enter', reason: `${best.id} cleared the bar`, windowId: best.id, heldId: null, at: input.now },
    };
  };
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-serve-loop-'));
  dirs.push(dir);
  let server: EngineServer | null = null;
  let loop: StrategyLoop | null = null;
  const scanner = new Scanner(readers.venues, readers.watch, {
    config: DEFAULT_SCANNER_CONFIG, clock, strategy: () => server?.strategy ?? DEFAULT_STRATEGY, held: () => loop?.heldWindow() ?? null,
  });
  const publish = (e: StreamEvent) => {
    events.push(e);
    server?.publish(e);
  };
  const strategyLoop = serveLoop({
    mode: 'replay', env: (n) => (n === 'GIMBAL_TRADE' ? '1' : undefined), once: false, stateDir: dir, contractId: null, deskId: null,
    pair: null, lastDesk: () => null, accounts: [], rescueLive: false, busy: () => null, windows: () => server?.state().windows ?? null,
    strategy: () => server?.strategy ?? DEFAULT_STRATEGY, policy: () => null, publish, clock, log: () => {},
    hands: exec.hands, decide,
  });
  loop = strategyLoop;
  server = new EngineServer({
    mode: 'replay', scanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, log: () => {},
    strategyLoop, onStrategy: () => strategyLoop.onScan(), onScan: () => strategyLoop.onScan(),
  });
  const port = await server.start(0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
  };
  try {
    for (let i = 0; i < 200 && server.state().windows === null; i++) await new Promise((r) => setTimeout(r, 10));
    await strategyLoop.idle(2000);
    // auto is off by default: decide() runs and answers `off`, nothing is carried out.
    let state = (await call('GET', '/state')).json as unknown as EngineState;
    assert.equal(state.decision?.action, 'off');
    assert.equal(decided.length, 1);
    assert.deepEqual(exec.calls, []);

    // The owner turns auto on: the loop checks at once, decide() enters, the executor opens.
    const put = await call('PUT', '/strategy', { ...DEFAULT_STRATEGY, auto: true });
    assert.equal(put.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    await strategyLoop.idle(2000);
    assert.equal(decided.length, 2);
    const best = decided[1]!.windows.filter((w) => w.tradable).sort((a, b) => b.netAprPct - a.netAprPct)[0]!;
    assert.deepEqual(exec.calls, [`open ${best.symbol} 200 1.5x 2`]);
    state = (await call('GET', '/state')).json as unknown as EngineState;
    assert.equal(state.decision?.action, 'enter');
    const enter = state.journal.find((j) => j.kind === 'enter')!;
    assert.match(enter.summary, new RegExp(`enter ${best.id}`));
    assert.match(String(enter.numbers.veto), /^no NEAR AI risk check on .*: NEAR_AI_API_KEY is not set/);
    assert.equal(enter.tx[0]!.id, '0xopen');

    // The next scan: the scanner marks the held window, decide() holds.
    await server.scanOnce();
    await strategyLoop.idle(2000);
    assert.equal(server.state().windows!.find((w) => w.id === best.id)!.held !== null, true);
    assert.equal(server.state().decision?.action, 'hold');

    // POST /rotate to a window that is not enterable (no desk policy in this replay): refused at once, with the reason.
    const other = server.state().windows!.find((w) => w.id !== best.id && w.tradable)!;
    const rot = await call('POST', '/rotate', { windowId: other.id });
    assert.equal(rot.status, 409);
    assert.equal(rot.json.ok, false);
    assert.match(String(rot.json.reason), new RegExp(other.id));
    assert.equal((await call('POST', '/rotate', {})).status, 400);

    // POST /close: accepted at once; the close and its journal follow.
    const close = await call('POST', '/close', {});
    assert.deepEqual(close, { status: 200, json: { ok: true } });
    await strategyLoop.idle(2000);
    assert.match(exec.calls.at(-1)!, /close \(strategy: exit .* \(POST \/close \(manual\)\)/);
    const entries = events.filter((e) => e.type === 'journal').map((e) => e.data as JournalEntry);
    // off on its transition and hold on its change of category are `wait` entries whose numbers.action says which.
    assert.deepEqual(entries.map((j) => (j.kind === 'wait' ? `wait ${String(j.numbers.action)}` : j.kind)), ['wait off', 'enter', 'wait hold', 'exit']);
    const shown = events.filter((e) => e.type === 'decision').map((e) => e.data as StrategyDecision);
    // The enter is published twice: as decided, then with the risk check's why line once it answered.
    assert.deepEqual(shown.map((d) => d.action), ['off', 'enter', 'enter', 'hold']);
    assert.match(shown[2]!.reason, /; no NEAR AI key: not checked$/);
    assert.match(enter.summary, /; no NEAR AI key: not checked; /);
    assert.equal(strategyLoop.held, null);
  } finally {
    strategyLoop.stop();
    await server.stop();
    readers.close();
  }
});

test('serve trades short hyperliquid / long phoenix only, on a policy symbol both legs list (kPEPE for PEPE)', () => {
  const w = (id: string, symbol: string): FundingWindow => {
    const [, longVenue, shortVenue] = id.split('-') as [string, FundingWindow['longVenue'], FundingWindow['shortVenue']];
    return { id, symbol, longVenue, shortVenue } as FundingWindow;
  };
  assert.deepEqual(windowSymbol(w('sol-phoenix-hyperliquid', 'SOL'), ['SOL', 'kPEPE']), { symbol: 'SOL' });
  assert.deepEqual(windowSymbol(w('pepe-phoenix-hyperliquid', 'PEPE'), ['SOL', 'kPEPE']), { symbol: 'kPEPE' });
  assert.match((windowSymbol(w('sol-hyperliquid-phoenix', 'SOL'), ['SOL']) as { refused: string }).refused, /short hyperliquid, long phoenix only/);
  assert.match((windowSymbol(w('eth-phoenix-hyperliquid', 'ETH'), ['SOL']) as { refused: string }).refused, /not a market both legs list/);
});

test('window facts: the 14 days and open interest from the carry, lots and the mid for the enterable windows serve trades', async () => {
  const win = (id: string, symbol: string, over: Partial<FundingWindow> = {}): FundingWindow => {
    const [, longVenue, shortVenue] = id.split('-') as [string, FundingWindow['longVenue'], FundingWindow['shortVenue']];
    return { id, symbol, longVenue, shortVenue, tradable: true, stale: false, checks: [{ ok: true, text: 'ok' }], netAprPct: 20, held: null } as unknown as FundingWindow;
  };
  const book = (bid: number, ask: number) => ({ bids: [{ px: bid, sz: 1 }], asks: [{ px: ask, sz: 1 }] });
  let bookReads = 0;
  const reader = (id: string, lot: number, b: ReturnType<typeof book>) => ({
    id, markets: async () => [{ symbol: 'SOL', lotSize: lot }, { symbol: 'kPEPE', lotSize: 1 }],
    book: async () => {
      bookReads++;
      return b;
    },
  }) as unknown as VenueReader;
  const carry = (id: string) => (id === 'sol-phoenix-hyperliquid'
    ? { estimate: { gross: { d14AprPct: 12.5 } }, long: { oiUsd: 1e6 }, short: { oiUsd: 2e6 } } as unknown as WindowCarry : null);
  const now = { t: 0 };
  const facts = windowFacts({
    carry, venues: [reader('hyperliquid', 0.01, book(99, 101)), reader('phoenix', 0.001, book(99.5, 100.5))], symbols: () => ['SOL'],
    clock: { now: () => now.t }, log: () => {},
  });
  const windows = [win('sol-phoenix-hyperliquid', 'SOL'), win('sol-hyperliquid-phoenix', 'SOL'), win('eth-phoenix-hyperliquid', 'ETH')];
  const f = await facts(windows);
  assert.deepEqual(f.gross14dAprPct, { 'sol-phoenix-hyperliquid': 12.5 });
  assert.deepEqual(f.openInterest, { 'sol-phoenix-hyperliquid': { longUsd: 1e6, shortUsd: 2e6 } });
  // Only the direction serve opens, on a policy symbol: long Phoenix's lot, short Hyperliquid's, at the mean of both books.
  assert.deepEqual(f.lots, { 'sol-phoenix-hyperliquid': { longLot: 0.001, shortLot: 0.01, px: 100 } });
  await facts(windows);
  assert.equal(bookReads, 2, 'the mid is kept for 30 s');
});

test('fillsOf: each leg summed over its orders, size-weighted price, a fee not reported makes the leg fee unknown', () => {
  const ref = (venue: string, side: 'BUY' | 'SELL') => ({ venue, side, size: '1', reduceOnly: false, orderId: null, clientId: null, tx: [], sentAt: 0 });
  const order = (venue: string, side: 'BUY' | 'SELL', filled: string | null, avgPx: number | null, fee: number | null) =>
    ({ ref: ref(venue, side), outcome: 'filled', filled, avgPx, fee, error: null, purpose: 'open' });
  const result = {
    status: 'level', size: '3', notes: [], tx: [], feeUsd: 0, feeUnknown: 0,
    legs: [
      { venue: 'hyperliquid', symbol: 'SOL', start: '0', target: '-3', final: '-3', orders: [order('hyperliquid', 'SELL', '1', 100, 0.05), order('hyperliquid', 'SELL', '2', 103, 0.1)] },
      { venue: 'phoenix', symbol: 'SOL', start: '0', target: '3', final: '3', orders: [order('phoenix', 'BUY', '3', 101, null), order('phoenix', 'BUY', null, null, null)] },
    ],
  } as unknown as PairResult;
  assert.deepEqual(fillsOf([result]), [
    { venue: 'hyperliquid', side: 'SELL', qty: '3', avgPx: 102, feeUsd: 0.15000000000000002 },
    { venue: 'phoenix', side: 'BUY', qty: '3', avgPx: 101, feeUsd: null },
  ]);
});

test('openedQty: the parts that went out and opened; a part its gate stopped, or one that ended unwound, adds nothing', () => {
  const order = { ref: { venue: 'hyperliquid', side: 'SELL', size: '5', reduceOnly: false, orderId: null, clientId: null, tx: [], sentAt: 0 }, outcome: 'filled', filled: '5', avgPx: 100, fee: 0, error: null, purpose: 'open' };
  const part = (status: string, size: string, sent: boolean) => ({
    status, size, notes: [], tx: [], feeUsd: 0, feeUnknown: 0,
    legs: [{ venue: 'hyperliquid', symbol: 'SOL', start: '0', target: '0', final: '0', orders: sent ? [order] : [] }, { venue: 'phoenix', symbol: 'SOL', start: '0', target: '0', final: '0', orders: [] }],
  }) as unknown as PairResult;
  assert.equal(openedQty([part('open', '5', true), part('stuck', '5', false)]), '5', 'part 2 gated before its first order');
  assert.equal(openedQty([part('open', '5', true), part('open', '2.5', true)]), '7.5');
  assert.equal(openedQty([part('open', '5', true), part('stuck', '5', true)]), '5', 'a part that went out and was unwound holds nothing');
  assert.equal(openedQty([]), '0');
});

test('the real decide(): three hourly checks above the bar, then the exact qty it sized reaches the hands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-serve-loop-'));
  dirs.push(dir);
  const window = deskWin('sol-phoenix-hyperliquid', { netAprPct: 15 });
  const opens: { symbol: string; legUsd: number; qty: string }[] = [];
  let held: { symbol: string; legUsd: number; pnlUsd: number; oneLeg: null } | null = null;
  const hands: LoopHands = {
    blocked: () => null,
    held: () => held,
    symbolOf: (w) => windowSymbol(w, ['SOL']),
    open: async (r) => {
      opens.push({ symbol: r.symbol, legUsd: r.legUsd, qty: r.qty });
      held = { symbol: r.symbol, legUsd: r.legUsd, pnlUsd: 0, oneLeg: null };
      return { ok: true, reason: 'opened', sent: true, tx: [], feeUsd: 0.01, open: [] };
    },
    close: async () => ({ ok: true, reason: 'closed', sent: true, tx: [], feeUsd: 0, open: [] }),
  };
  const book = { bids: [{ px: 99, sz: 100 }], asks: [{ px: 101, sz: 100 }] };
  const reader = (id: string) => ({ id, markets: async () => [{ symbol: 'SOL', lotSize: 0.01 }], book: async () => book }) as unknown as VenueReader;
  const carry = () => ({ estimate: { gross: { d14AprPct: 18 } }, long: { oiUsd: 1e6 }, short: { oiUsd: 1e6 } }) as unknown as WindowCarry;
  const policy = { max_notional_usd: 20, price_band_bps: 100, hl_assets: [{ symbol: 'SOL' }], phoenix_markets: [{ symbol: 'SOL' }] } as never;
  const clock = new VirtualClock(T0 + 5 * 60_000);
  const events: StreamEvent[] = [];
  const loop = serveLoop({
    mode: 'replay', env: (n) => (n === 'GIMBAL_TRADE' ? '1' : undefined), once: false, stateDir: dir, contractId: null, deskId: null,
    pair: null, lastDesk: () => null, rescueLive: true, busy: () => null, windows: () => [window],
    accounts: [{ venue: 'hyperliquid', read: async () => ({ freeMarginUsd: 50 }) as never }, { venue: 'phoenix', read: async () => ({ freeMarginUsd: 50 }) as never }],
    strategy: () => STRATEGY, policy: () => policy, publish: (e) => events.push(e), clock, log: () => {},
    carry, venues: [reader('hyperliquid'), reader('phoenix')], hands,
  });
  for (let h = 0; h < 6 && opens.length === 0; h++) {
    clock.set(T0 + h * HOUR_MS + 5 * 60_000);
    await loop.check();
  }
  assert.equal(opens.length, 1, 'decide() entered');
  // The qty decide() sized: 12 USD a leg at a mid of 100 on lots of 0.01, whole lots only, never re-derived.
  const sized = sizeFor(window, {
    strategy: STRATEGY, maxNotionalUsd: 20, freeMarginUsd: { hyperliquid: 50, phoenix: 50 }, liveRescue: { hyperliquid: true, phoenix: false, orderly: false },
    priceBandBps: 100, lots: { [window.id]: { longLot: 0.01, shortLot: 0.01, px: 100 } },
  });
  assert.equal(sized.ok, true);
  assert.equal(opens[0]!.qty, (sized as { qty: string }).qty);
  assert.equal(opens[0]!.qty, '0.12');
  const enter = events.filter((e) => e.type === 'journal').map((e) => e.data as JournalEntry).find((j) => j.kind === 'enter')!;
  assert.equal(enter.numbers.qty, '0.12');
  loop.stop();
});

test('a pair whose start is not confirmed: the loop decides nothing and refuses every act, a manual one too, with the reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-serve-loop-'));
  dirs.push(dir);
  let pending: string | null = 'legs unknown, start not confirmed: phoenix: the trader snapshot is at slot 100, still before slot 120';
  let decided = 0;
  const logs: string[] = [];
  const hands: PairHands = {
    symbols: ['SOL'], blocked: () => null, canOpen: () => false, heldSymbol: () => null, heldLegs: () => [],
    prepareOpen: async () => ({ ok: false, reason: 'not here', results: [], lines: [], open: [], tx: [], feeUsd: 0 }),
    open: async () => ({ ok: false, reason: 'not here', results: [], lines: [], open: [], tx: [], feeUsd: 0 }),
    close: async () => ({ ok: false, reason: 'not here', results: [], lines: [], open: [], tx: [], feeUsd: 0 }),
    reconcile: async () => null,
  };
  const pair = { hands, unconfirmed: () => pending, notTrading: () => pending } as unknown as ServePair;
  const loop = serveLoop({
    mode: 'mainnet', env: (n) => (n === 'GIMBAL_TRADE' ? '1' : undefined), once: false, stateDir: dir, contractId: 'gimbal.near', deskId: 'desk-1',
    pair, lastDesk: () => null, accounts: [], rescueLive: false, busy: () => null, windows: () => [],
    strategy: () => ({ ...DEFAULT_STRATEGY, auto: true }), policy: () => null, publish: () => {}, clock: { now: () => T0 }, log: (l) => logs.push(l),
    decide: (input) => {
      decided++;
      return { counters: input.counters, act: null, vetoCandidate: null, decision: { action: 'wait', reason: 'test', windowId: null, heldId: null, at: input.now } };
    },
  });
  await loop.check();
  assert.equal(decided, 0, 'no decision on legs that are unknown');
  assert.ok(logs.includes(`strategy loop: no decision now, ${pending}`), logs.join('\n'));
  assert.deepEqual(loop.close(), { ok: false, reason: pending });
  assert.deepEqual(loop.rotate('sol-phoenix-hyperliquid'), { ok: false, reason: pending });
  // Confirmed: the loop decides again.
  pending = null;
  await loop.check();
  assert.equal(decided, 1);
  loop.stop();
});

test('loopHands: the held symbol\'s legs only, one leg named, busy() refusing first, sent as the hands report it', async () => {
  let legs: { venue: string; qty: bigint | null }[] = [{ venue: 'hyperliquid', qty: toQty('-0.12') }, { venue: 'phoenix', qty: toQty('0.12') }];
  let busy: string | null = null;
  let gateSeen: (() => string | null) | undefined;
  const pair: PairHands = {
    symbols: ['SOL'],
    blocked: () => null,
    canOpen: () => true,
    heldSymbol: () => 'SOL',
    heldLegs: () => legs,
    prepareOpen: async () => ({ ok: true, reason: 'SOL refreshed', results: [], lines: [], open: [], tx: [], feeUsd: 0, refreshed: true }),
    open: async (r) => {
      gateSeen = r.gate;
      return { ok: false, reason: 'stopped with orders out: socket closed', results: [], lines: [], open: [], tx: [], feeUsd: 0, sent: true };
    },
    close: async () => ({ ok: false, reason: 'refused', results: [], lines: [], open: [], tx: [], feeUsd: 0 }),
    reconcile: async () => 'SOL record reconciled with the venues',
  };
  const leg = (venue: Leg['venue'], symbol: string, side: Leg['side'], size: number, entry: number, mark: number): Leg => ({
    venue, symbol, side, size, lotSize: 0.01, entry, mark, liqPx: null, marginUsd: 6, marginRatio: 0.1, distanceToLiqPct: 50,
    fundingEarnedUsd: 0.05, unsettledFundingUsd: 0.01, feesUsd: -0.02, unpriced: false,
  });
  const desk = {
    legs: [leg('hyperliquid', 'SOL', 'short', 0.12, 100, 101), leg('phoenix', 'SOL', 'long', 0.12, 100, 101), leg('orderly', 'ETH', 'long', 1, 3000, 3100)],
    pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 999 },
  } as unknown as DeskState;
  const h = loopHands(pair, () => desk, () => {}, () => busy);
  const held = h.held()!;
  assert.equal(held.symbol, 'SOL');
  assert.equal(Math.round(held.legUsd * 100) / 100, 12.12, 'the SOL legs, not the ETH one');
  // Price P&L (-0.12 + 0.12) plus funding (0.06 a leg) plus fees (-0.02 a leg); never the desk's whole net.
  assert.equal(Math.round(held.pnlUsd * 100) / 100, 0.08);
  assert.deepEqual(Object.keys(held.freedMarginUsd!).sort(), ['hyperliquid', 'phoenix']);
  assert.equal(held.oneLeg, null);
  legs = [{ venue: 'hyperliquid', qty: 0n }, { venue: 'phoenix', qty: toQty('0.12') }];
  assert.deepEqual(h.held()!.oneLeg, { venue: 'phoenix', qty: '0.12' });
  legs = [{ venue: 'hyperliquid', qty: null }, { venue: 'phoenix', qty: toQty('0.12') }];
  assert.equal(h.held()!.oneLeg, null, 'a leg not known is not called flat');
  assert.equal(h.blocked(), null);
  busy = 'rescue r-1 runs';
  assert.equal(h.blocked(), 'rescue r-1 runs');
  const opened = await h.open({ window: deskWin('sol-phoenix-hyperliquid'), symbol: 'SOL', legUsd: 12, leverage: 1, qty: '0.12', reason: 'test' });
  assert.equal(opened.sent, true, 'a throw after orders went out is reported as sent');
  assert.equal(gateSeen?.(), 'rescue r-1 runs', 'the open carries the gate, asked again before its orders');
  assert.equal(await h.reconcile!(), 'SOL record reconciled with the venues');
  assert.equal((await h.close({ reason: 'test' })).sent, false);
  // An open the trader refused for cost carries why, for the loop to hold the window out of the entry rules.
  const why = 'the expected spread over 7 days, $0.0390, does not cover the round trip $0.0421';
  const cost = loopHands({ ...pair, open: async () => ({ ok: false, reason: `open refused, nothing signed: ${why}`, results: [], lines: [], open: [], tx: [], feeUsd: 0, costRefused: why }) },
    () => desk, () => {}, () => null);
  const refused = await cost.open({ window: deskWin('sol-phoenix-hyperliquid'), symbol: 'SOL', legUsd: 12, leverage: 1, qty: '0.12', reason: 'test' });
  assert.deepEqual([refused.ok, refused.sent, refused.costRefused], [false, false, why]);
  assert.equal(opened.costRefused, undefined);
});

test('depth at size: a long walks the asks, a short the bids; the fill\'s distance from the mid in bps, unknown when the levels read do not fill it', () => {
  const book = {
    venue: 'hyperliquid' as const, symbol: 'SOL', time: T0,
    bids: [{ px: 99, sz: 2 }, { px: 98, sz: 10 }],
    asks: [{ px: 101, sz: 1 }, { px: 102, sz: 10 }],
  };
  // mid 100. Long 300 USD: 101 USD at 101, 199 USD at 102 -> qty 1 + 199/102; vwap = 300 / qty.
  const long = depthAtSize(book, 'long', 300);
  assert.equal(long.bookDepthUsd, 101 + 1020);
  const qty = 1 + 199 / 102;
  assert.ok(Math.abs(long.fillImpactBps! - (300 / qty / 100 - 1) * 1e4) < 1e-9);
  // Short 150 USD: all at 99 -> 100 bps under the mid.
  const short = depthAtSize(book, 'short', 150);
  assert.equal(short.bookDepthUsd, 198 + 980);
  assert.ok(Math.abs(short.fillImpactBps! - 100) < 1e-9);
  // More than the levels read hold: the depth is known, the impact is not.
  assert.deepEqual(depthAtSize(book, 'short', 5_000), { bookDepthUsd: 1178, fillImpactBps: null });
  // An empty or one-sided book: nothing known.
  assert.deepEqual(depthAtSize({ ...book, bids: [] }, 'long', 100), { bookDepthUsd: null, fillImpactBps: null });
});

test('risk facts: each leg\'s book at size, the 24 h move from the carry, the listing age where the venue gives it; unknown otherwise', async () => {
  const DAY = 86_400_000;
  const carry = {
    long: { venue: 'orderly', symbol: 'PERP_SOL_USDC', nowAprPct: 10, d7AprPct: 9, d14AprPct: 8, oiUsd: 1e6, priceMove24hPct: 3.2 },
    short: { venue: 'hyperliquid', symbol: 'SOL', nowAprPct: 20, d7AprPct: 19, d14AprPct: 18, oiUsd: 2e7 },
  } as unknown as WindowCarry;
  const level = (px: number) => [{ px, sz: 100 }];
  const reader = (id: string, over: Partial<VenueReader>): VenueReader => ({
    id, markets: async () => [], book: async (symbol: string) => ({ venue: id, symbol, time: T0, bids: level(99.9), asks: level(100.1) }), ...over,
  }) as unknown as VenueReader;
  const venues = [
    reader('orderly', { markets: async () => [{ symbol: 'PERP_SOL_USDC', listedAt: T0 - 30 * DAY }] as never }),
    reader('hyperliquid', { book: async () => { throw new Error('socket closed'); } }),
  ];
  const logs: string[] = [];
  const facts = riskFacts({ carry: (id) => (id === 'sol-orderly-hyperliquid' ? carry : null), venues, clock: { now: () => T0 }, log: (l) => logs.push(l) });
  const got = await facts({ id: 'sol-orderly-hyperliquid' } as FundingWindow, 500);
  assert.equal(got.long?.priceMove24hPct, 3.2);
  assert.equal(got.long?.daysSinceListing, 30);
  assert.equal(got.long?.bookDepthUsd, 100.1 * 100);
  assert.ok(Math.abs(got.long!.fillImpactBps! - 10) < 1e-9);
  // Hyperliquid: no move in the carry, no listing time, and its book did not answer: all unknown, and logged.
  assert.deepEqual(got.short, { priceMove24hPct: null });
  assert.ok(logs.some((l) => /hyperliquid SOL book not read \(socket closed\), its depth is unknown/.test(l)));
  // A window the scan does not carry: nothing added.
  assert.deepEqual(await facts({ id: 'eth-orderly-hyperliquid' } as FundingWindow, 500), {});
});

test('protectionText and openGateText: a rescue, an ADL unwind, event or confirming check, panic_close; the open also stops on a pause', () => {
  const quiet = { unwinding: false, confirming: false, event: false, paused: null };
  const none = { rescue: null, adl: quiet, panicClose: false };
  // serve runs the ADL check beside every 5 s read: while it sees nothing off it holds nothing back.
  assert.equal(protectionText(none), null);
  assert.equal(protectionText({ ...none, adl: null }), null, 'no pair, no ADL watch');
  assert.equal(protectionText({ ...none, adl: { ...quiet, unwinding: true } }), 'an ADL unwind is in flight');
  // An event whose attempt failed (no unwind in flight) or a check confirming a leg off its baseline: the loop waits.
  assert.equal(protectionText({ ...none, adl: { ...quiet, event: true } }), 'an ADL event is in progress');
  assert.equal(protectionText({ ...none, adl: { ...quiet, confirming: true } }), 'an ADL check is confirming a leg off its baseline');
  assert.equal(protectionText({ ...none, rescue: 'r-1' }), 'rescue r-1 runs');
  assert.equal(protectionText({ ...none, panicClose: true }), 'panic_close runs');
  assert.equal(protectionText({ rescue: 'r-1', adl: { ...quiet, unwinding: true }, panicClose: true }), 'rescue r-1 runs', 'the rescue is named first');
  // A pause after an ADL does not stop the loop's decisions (a held pair may still be closed), but stops every open.
  const paused = { ...none, adl: { ...quiet, paused: 'ADL on hyperliquid XLM -50 -> -30' } };
  assert.equal(protectionText(paused), null);
  assert.equal(openGateText(paused), 'the pair is paused since an ADL (ADL on hyperliquid XLM -50 -> -30): no new pair opens until the owner reconciles');
  assert.equal(openGateText({ ...none, adl: { ...quiet, event: true } }), 'an ADL event is in progress');
  assert.equal(openGateText(none), null);
  // adlGate reads serve-pair's PairAdl.
  const state = { attemptsLeft: 3, paused: null, event: null };
  assert.deepEqual(adlGate({ check: async () => null, stop: () => {}, state, unwinding: false, confirming: true }), { ...quiet, confirming: true });
  assert.equal(adlGate(undefined), null);
});
