// serve's strategy loop end to end in replay: the recorded scan feeds the loop, decide() asks for an act, a fake
// executor carries it out, and the journal and the decision come out through the server (GET /state, POST /rotate,
// POST /close); plus the window -> policy symbol mapping serve trades.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { EngineState, JournalEntry, StrategyDecision, StreamEvent, Window as FundingWindow } from '@gimbal/shared';
import { replayReaders } from '../readers.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from '../scanner/config.ts';
import { Scanner } from '../scanner/scanner.ts';
import { EngineServer } from '../server.ts';
import type { DecideInput, Decision } from '../strategy/decide.ts';
import type { ActOutcome, LoopHands, StrategyLoop } from '../strategy/loop.ts';
import { VirtualClock, readRecording } from '../venues/replay.ts';
import { replayStart } from './serve-replay.ts';
import { fillsOf, serveLoop, windowFacts, windowSymbol } from './serve-loop.ts';
import type { PairResult } from '../trade/pair.ts';
import type { VenueReader } from '../venues/venue.ts';
import type { WindowCarry } from '../scanner/scanner.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const RECORDING = fileURLToPath(new URL('../../fixtures/replay/scan-mainnet-2026-10-31.jsonl.gz', import.meta.url));

/** The fake executor: what an open and a close would do, recorded; the held pair is what it opened. */
function fakeExecutor() {
  const calls: string[] = [];
  let held: { symbol: string; legUsd: number; pnlUsd: number } | null = null;
  const tx = (id: string) => [{ chain: 'hyperliquid' as const, id, url: `https://app.hyperliquid-testnet.xyz/explorer/tx/${id}` }];
  const hands: LoopHands = {
    blocked: () => null,
    held: () => held,
    symbolOf: (w) => ({ symbol: w.symbol }),
    open: async (r): Promise<ActOutcome> => {
      calls.push(`open ${r.symbol} ${r.legUsd} ${r.leverage}x`);
      held = { symbol: r.symbol, legUsd: r.legUsd, pnlUsd: 0 };
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
      ...base, act: { kind: 'enter', windowId: best.id, legUsd: 200, leverage: 1.5 },
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
    assert.deepEqual(exec.calls, [`open ${best.symbol} 200 1.5x`]);
    state = (await call('GET', '/state')).json as unknown as EngineState;
    assert.equal(state.decision?.action, 'enter');
    const enter = state.journal.find((j) => j.kind === 'enter')!;
    assert.match(enter.summary, new RegExp(`enter ${best.id}`));
    assert.match(String(enter.numbers.veto), /^no veto check on .*: NEAR_AI_API_KEY is not set/);
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
    const kinds = events.filter((e) => e.type === 'journal').map((e) => (e.data as JournalEntry).kind);
    assert.deepEqual(kinds, ['enter', 'exit']);
    const actions = events.filter((e) => e.type === 'decision').map((e) => (e.data as StrategyDecision).action);
    assert.deepEqual(actions, ['off', 'enter', 'hold']);
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
