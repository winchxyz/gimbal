// The replay's loop parts (serve-replay-loop.ts): the hands and book port on a stand-in replay desk, the hourly
// funding line, the demo entry's candidates and the script that plays the owner's two buttons.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContractPolicy, JournalEntry, StreamEvent } from '@gimbal/shared';
import type { ReplayClose, ReplayDesk, ReplayFill, ReplayHeld, ReplayOpen } from '../risk/sources.ts';
import type { BookRecord } from '../book/types.ts';
import type { LoopHeld } from '../strategy/loop.ts';
import { STRATEGY, T0, win } from '../strategy/test-helpers.ts';
import { VirtualClock } from '../venues/replay.ts';
import {
  REPLAY_DEMO_MAX_LOSS_USD,
  REPLAY_ENTER_AFTER_MS,
  REPLAY_EXIT_AFTER_HOUR_MS,
  REPLAY_EXIT_BEFORE_END_MS,
  REPLAY_GIVE_UP_BEFORE_END_MS,
  ReplayScript,
  demoCandidates,
  fundingEntry,
  replayLoop,
  replayMarketLines,
  replayPairSymbols,
  scriptExitAt,
} from './serve-replay-loop.ts';

const HOUR = 3_600_000;
const MIN = 60_000;
const POLICY = { hl_assets: [{ symbol: 'SOL' }, { symbol: 'ZEC' }], phoenix_markets: [{ symbol: 'SOL' }, { symbol: 'ZEC' }] } as unknown as ContractPolicy;

const fill = (venue: 'hyperliquid' | 'phoenix', side: 'BUY' | 'SELL', px: number, feeUsd: number): ReplayFill => ({ venue, symbol: 'SOL', side, qty: 0.06, px, feeUsd, source: 'book' });

/** A replay desk that answers as told: what replayLoop reads of it. */
function fakeDesk(o: { open: ReplayOpen; close: ReplayClose; held?: ReplayHeld | null }) {
  const calls: unknown[] = [];
  const desk = {
    openPair: async (r: unknown) => {
      calls.push(r);
      return o.open;
    },
    closePair: async () => o.close,
    held: () => o.held ?? null,
  } as unknown as ReplayDesk;
  return { desk, calls };
}

const record = (kind: 'enter' | 'exit'): BookRecord => ({
  kind, windowId: 'sol-phoenix-hyperliquid', symbol: 'SOL', at: T0, legs: [], feeUsd: 0, tx: [], forecastNetAprPct: null, exitReason: null,
} as unknown as BookRecord);

test('replay hands: an open fills on the replay desk and its line carries the fees as a cost; nothing is signed', async () => {
  const fills = [fill('phoenix', 'BUY', 190.2, 0.004), fill('hyperliquid', 'SELL', 190.1, 0.0063)];
  const { desk, calls } = fakeDesk({ open: { ok: true, fills, feeUsd: 0.0103 }, close: { ok: false, reason: 'the replay desk holds no pair' } });
  const { hands, book } = replayLoop({ desk, policy: () => POLICY });
  const w = win('sol-phoenix-hyperliquid');
  const out = await hands.open({ window: w, symbol: 'SOL', legUsd: 12, leverage: 1.5, qty: '0.06', reason: 'demo' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.tx, []);
  assert.match(out.reason, /^replay, simulated fills, nothing signed or sent: bought 0\.06 SOL on Phoenix at 190\.2 \(recorded best ask\), sold 0\.06 SOL on Hyperliquid at 190\.1 \(recorded best bid\)/);
  assert.deepEqual(calls, [{ symbol: 'SOL', qty: 0.06, long: 'phoenix', short: 'hyperliquid', leverage: 1.5 }]);
  const r = book.record(record('enter'));
  assert.deepEqual(r, { positionId: 'replay-sol-phoenix-hyperliquid', numbers: { usd: -0.0103, feeUsd: -0.0103 } });
  assert.equal(book.openWindow(), 'sol-phoenix-hyperliquid');
  // The close the desk refuses comes back refused, labelled as the replay's.
  const c = await hands.close({} as never);
  assert.deepEqual([c.ok, c.reason], [false, 'replay: the replay desk holds no pair']);
});

test('replay hands: a close books the realized split, and the journal amounts add up to the realized net', async () => {
  const fills = [fill('phoenix', 'SELL', 190.0, 0.004), fill('hyperliquid', 'BUY', 190.3, 0.0063)];
  const close: ReplayClose = {
    ok: true, fills, feeUsd: 0.0103, entryFeeUsd: 0.0103, fundingUsd: -0.0003, unbookedFundingUsd: -0.0001, priceUsd: -0.024,
    netUsd: -0.0003 - 0.024 - 0.0206, heldMs: 1.2 * HOUR,
  };
  const { desk } = fakeDesk({ open: { ok: true, fills, feeUsd: 0.0103 }, close });
  const { hands, book } = replayLoop({ desk, policy: () => POLICY });
  await hands.open({ window: win('sol-phoenix-hyperliquid'), symbol: 'SOL', legUsd: 12, leverage: 1.5, qty: '0.06', reason: 'demo' });
  const entered = book.record(record('enter'));
  assert.equal((await hands.close({} as never)).ok, true);
  const exited = book.record(record('exit'));
  assert.equal(exited.positionId, 'replay-sol-phoenix-hyperliquid');
  const n = exited.numbers;
  assert.equal(n.realizedFeesUsd, -0.0206);
  assert.equal(n.realizedFundingUsd, -0.0003);
  assert.equal(n.realizedPriceUsd, -0.024);
  assert.equal(n.heldH, 1.2);
  assert.match(exited.note ?? '', /^realized -0\.0449 USD in all: funding -0\.0003 USD, fees -0\.0206 USD, price -0\.0240 USD \(replay/);
  // The open's line, the booked funding (the part not left unbooked) and the close's line: the realized net.
  const bookedFunding = close.fundingUsd - close.unbookedFundingUsd;
  const sum = (entered.numbers.usd as number) + bookedFunding + (n.usd as number);
  assert.ok(Math.abs(sum - (n.realizedNetUsd as number)) < 1e-6, `${sum} vs ${n.realizedNetUsd}`);
  assert.equal(book.openWindow(), null);
});

test('replay hands: the held pair is the desk\'s, with its P&L and the margin a close frees', () => {
  const held: ReplayHeld = {
    symbol: 'SOL', openedAt: T0,
    legs: [
      { venue: 'phoenix', side: 'long', size: 0.06, entryPx: 190, mark: 191, fundingUsd: 0.001, feeUsd: 0.004, leverage: 1.5 },
      { venue: 'hyperliquid', side: 'short', size: 0.06, entryPx: 190, mark: 191, fundingUsd: -0.0005, feeUsd: 0.0063, leverage: 1.5 },
    ],
  };
  const { desk } = fakeDesk({ open: { ok: false, reason: 'x' }, close: { ok: false, reason: 'x' }, held });
  const h = replayLoop({ desk, policy: () => POLICY }).hands.held();
  assert.ok(h !== null);
  assert.equal(h.symbol, 'SOL');
  assert.ok(Math.abs(h.pnlUsd - (0.06 - 0.06 + 0.0005 - 0.0103)) < 1e-9);
  assert.ok(Math.abs(h.legUsd - 0.06 * 191) < 1e-9);
  assert.ok(Math.abs((h.freedMarginUsd?.phoenix ?? 0) - ((0.06 * 191) / 1.5 + 0.06)) < 1e-9);
});

test('the replay pairs: the policy symbols on Hyperliquid and Phoenix, in either direction, none elsewhere', () => {
  const pairs = replayPairSymbols(() => POLICY);
  assert.deepEqual(pairs('phoenix', 'hyperliquid'), ['SOL', 'ZEC']);
  assert.deepEqual(pairs('hyperliquid', 'phoenix'), ['SOL', 'ZEC']);
  assert.deepEqual(pairs('orderly', 'hyperliquid'), []);
  assert.deepEqual(pairs('phoenix', 'phoenix'), []);
});

test('funding: the hourly booking is a funding line on the replay clock, per leg, labelled as not settled on chain', () => {
  const e: JournalEntry = fundingEntry({
    from: T0 + 17 * MIN, to: T0 + HOUR, usd: 0.0021,
    legs: [
      { venue: 'hyperliquid', symbol: 'SOL', side: 'short', usd: 0.0031, ratePerHour: 0.0000125 },
      { venue: 'phoenix', symbol: 'SOL', side: 'long', usd: -0.001, ratePerHour: 0.0000083 },
    ],
  }, 'f1');
  assert.equal(e.kind, 'funding');
  assert.equal(e.t, T0 + HOUR);
  assert.equal(e.numbers.usd, 0.0021);
  assert.equal(e.numbers.hyperliquidUsd, 0.0031);
  assert.equal(e.numbers.phoenixRatePerHour, 0.0000083);
  assert.equal(e.summary, 'funding 12:17–13:00 on SOL at the recorded rates: Hyperliquid short +0.0031 USD, Phoenix long -0.0010 USD, +0.0021 USD in all (replay: nothing settled on chain)');
});

test('demo candidates: the policy\'s windows on the replay desk that fail only profit checks, paying spreads first', () => {
  const profit = [{ ok: false, kind: 'profit' as const, text: 'Does not break even within a year' }];
  const windows = [
    win('sol-phoenix-hyperliquid', { grossAprPct: -9, netAprPct: -15, checks: profit }),
    win('zec-phoenix-hyperliquid', { grossAprPct: 9.6, netAprPct: -7, checks: profit }),
    win('zec-hyperliquid-phoenix', { grossAprPct: 4, netAprPct: -12, checks: profit }),
    win('near-hyperliquid-phoenix', { grossAprPct: 30, netAprPct: 0.2 }),
    win('sol-orderly-hyperliquid', { grossAprPct: 25, netAprPct: 12 }),
    win('zec-phoenix-orderly', { grossAprPct: 25, netAprPct: 12 }),
    win('sol-hyperliquid-phoenix', { grossAprPct: 25, netAprPct: 12, checks: [{ ok: false, text: 'SOL is over 2 % of its open interest' }] }),
  ];
  assert.deepEqual(demoCandidates(windows, POLICY).map((w) => w.id), ['zec-phoenix-hyperliquid', 'zec-hyperliquid-phoenix', 'sol-phoenix-hyperliquid']);
  assert.deepEqual(demoCandidates(windows, null), []);
});

test('the script closes past the first hour boundary the pair holds through, and before the recording ends', () => {
  const end = T0 + HOUR + 19 * MIN;
  assert.equal(scriptExitAt(T0 + 4 * MIN, end), T0 + HOUR + REPLAY_EXIT_AFTER_HOUR_MS);
  // Too close to the end: before it, but never less than a minute after the entry.
  assert.equal(scriptExitAt(T0 + 4 * MIN, T0 + HOUR + 6 * MIN), T0 + HOUR + 6 * MIN - REPLAY_EXIT_BEFORE_END_MS);
  assert.equal(scriptExitAt(T0 + 59 * MIN, T0 + HOUR + MIN), T0 + 60 * MIN);
});

/** A strategy loop as the script drives it: rotate opens at once (or is refused), close flattens. */
function fakeLoop(o: { refuse?: Set<string> } = {}) {
  const asked: string[] = [];
  let held: LoopHeld | null = null;
  let closes = 0;
  const loop = {
    checked: 1,
    get held() {
      return held;
    },
    rotate: (id: unknown, demo?: unknown) => {
      asked.push(String(id));
      assert.deepEqual(demo, { maxLossUsd: REPLAY_DEMO_MAX_LOSS_USD });
      if (!o.refuse?.has(String(id))) held = { windowId: String(id), symbol: String(id).split('-')[0]!.toUpperCase(), since: clock.now() } as LoopHeld;
      return { ok: true as const };
    },
    close: () => {
      closes += 1;
      held = null;
      return { ok: true as const };
    },
  };
  const clock = new VirtualClock(T0);
  return { loop, asked, clock, closes: () => closes };
}

test('the replay script: enters a few minutes in, moves on from a window the loop did not enter, closes after the hour', () => {
  const { loop, asked, clock, closes } = fakeLoop({ refuse: new Set(['zec-phoenix-hyperliquid']) });
  const profit = [{ ok: false, kind: 'profit' as const, text: 'Does not break even within a year' }];
  const windows = [win('zec-phoenix-hyperliquid', { grossAprPct: 9.6, netAprPct: -7, checks: profit }), win('sol-phoenix-hyperliquid', { grossAprPct: -9, netAprPct: -15, checks: profit })];
  const journal: JournalEntry[] = [];
  const start = T0;
  const end = T0 + HOUR + 19 * MIN;
  const script = new ReplayScript({
    clock, start, end, loop, windows: () => windows, strategy: () => STRATEGY, policy: () => POLICY,
    publish: (e: StreamEvent) => {
      if (e.type === 'journal') journal.push(e.data);
    },
    log: () => {},
  });
  script.tick();
  assert.deepEqual(asked, [], 'the flat desk shows first');
  clock.set(start + REPLAY_ENTER_AFTER_MS);
  script.tick();
  assert.deepEqual(asked, ['zec-phoenix-hyperliquid']);
  assert.match(journal[0]!.summary, /^replay script: the recorded hour is too short .* POST \/rotate on ZEC \(short Hyperliquid, long Phoenix, -7\.0 % net\), its round trip at most 1\.00 USD\. .*Nothing is signed or sent\.$/);
  assert.equal(journal[0]!.numbers.stage, 'replay script');
  // The loop did not enter it (refused after its checks): after a wait, the next window, said shortly.
  clock.set(start + REPLAY_ENTER_AFTER_MS + 30_000);
  script.tick();
  assert.equal(asked.length, 1);
  clock.set(start + REPLAY_ENTER_AFTER_MS + 2 * MIN);
  script.tick();
  assert.deepEqual(asked, ['zec-phoenix-hyperliquid', 'sol-phoenix-hyperliquid']);
  assert.match(journal[1]!.summary, /^replay script: the window before was not entered .* POST \/rotate on SOL .*pays funding: the demo shows the cycle, not a profit\)\. Nothing is signed or sent\.$/);
  script.tick();
  assert.equal(script.phase, 'hold');
  // Held through the hour boundary; the close comes before the recording ends.
  clock.set(T0 + HOUR + REPLAY_EXIT_AFTER_HOUR_MS - 1);
  script.tick();
  assert.equal(closes(), 0);
  clock.set(T0 + HOUR + REPLAY_EXIT_AFTER_HOUR_MS);
  script.tick();
  assert.equal(closes(), 1);
  assert.match(journal[2]!.summary, /^replay script: closes SOL with POST \/close, as the owner would, after its 13:00 funding/);
  script.tick();
  assert.equal(script.phase, 'done');
});

test('the replay script gives up, once, when no window can be entered in time', () => {
  const { loop, asked, clock } = fakeLoop();
  const journal: JournalEntry[] = [];
  const end = T0 + HOUR;
  const script = new ReplayScript({
    clock, start: T0, end, loop, windows: () => [], strategy: () => STRATEGY, policy: () => POLICY,
    publish: (e: StreamEvent) => {
      if (e.type === 'journal') journal.push(e.data);
    },
    log: () => {},
  });
  clock.set(T0 + REPLAY_ENTER_AFTER_MS);
  script.tick();
  assert.equal(journal.length, 0, 'the first scans may not have priced a window yet');
  clock.set(end - REPLAY_GIVE_UP_BEFORE_END_MS);
  script.tick();
  script.tick();
  assert.deepEqual(asked, []);
  assert.equal(journal.length, 1);
  assert.match(journal[0]!.summary, /so the desk stays flat this replay$/);
  assert.equal(script.phase, 'done');
});

test('markets for the replay desk come from the venues\' wire recordings when the scan recording has none', async () => {
  const lines = [
    { t: T0, venue: 'hyperliquid', method: 'funding', args: [], ms: 1, result: [] },
    { t: T0, venue: 'phoenix', method: 'funding', args: [], ms: 1, result: [] },
  ] as const;
  const out = await replayMarketLines(lines.map((l) => ({ ...l, args: [] })), T0);
  assert.deepEqual(out.map((l) => [l.venue, l.method, l.t]), [['hyperliquid', 'markets', T0], ['phoenix', 'markets', T0]]);
  const lots = (venue: string) => new Map((out.find((l) => l.venue === venue)!.result as { symbol: string; lotSize: number }[]).map((m) => [m.symbol, m.lotSize]));
  assert.equal(lots('hyperliquid').get('SOL'), 0.01);
  assert.equal(lots('phoenix').get('BTC'), 0.0001);
  // A recording that keeps its own markets, or does not have the venue, is left as it is.
  const own = await replayMarketLines([{ t: T0, venue: 'hyperliquid', method: 'markets', args: [], ms: 1, result: [] }], T0);
  assert.deepEqual(own, []);
});
