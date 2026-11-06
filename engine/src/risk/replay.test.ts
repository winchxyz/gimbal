// A replay run of the risk engine on a recorded mainnet scan (fixtures/replay/scan-mainnet-2026-10-31.jsonl.gz): the
// replay desk starts flat with its 40 USD deposit, opens a 12 USD pair at the recorded book, every read is marked by
// the recording, funding is booked at the hour boundary, `health` events follow the venues (a recorded Phoenix outage
// turns it down, then ok again), POST /stress's path drives the desk to rescue, and the close realizes the P&L.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { DeskState, HealthMap, JournalEntry, RescueProgress, StreamEvent } from '@gimbal/shared';
import { replayStart } from '../cli/serve-replay.ts';
import { replayReaders } from '../readers.ts';
import { DEFAULT_STRATEGY } from '../scanner/config.ts';
import { VirtualClock, readRecording } from '../venues/replay.ts';
import type { RecordLine } from '../venues/recorder.ts';
import { RiskEngine } from './engine.ts';
import type { ReplayFunding } from './sources.ts';
import { REPLAY_DEPOSIT_USD, REPLAY_VENUE_CASH_USD, ReplayDesk } from './sources.ts';
import { VenueHealth } from './venue-health.ts';

const FIXTURE = fileURLToPath(new URL('../../fixtures/replay/scan-mainnet-2026-10-31.jsonl.gz', import.meta.url));
const HOUR = 3_600_000;
const STRATEGY = { ...DEFAULT_STRATEGY, legUsd: 12, maxLeverage: 3 };

test('replay: the replay desk from flat, a 12 USD pair on recorded prices, funding at the hour, health, stress, close', async () => {
  const recorded = readRecording(FIXTURE);
  const start = replayStart(recorded);
  // A Phoenix outage 2 min in, as a recording keeps one (an error line), until its next recorded answer.
  const phoenix = recorded.filter((l) => l.venue === 'phoenix' && l.method === 'funding' && l.error === undefined).map((l) => l.t).sort((a, b) => a - b);
  const outageAt = phoenix.find((t) => t > start + 120_000)! + 1;
  const back = phoenix.find((t) => t > outageAt)!;
  const lines: RecordLine[] = [...recorded, { t: outageAt, venue: 'phoenix', method: 'funding', args: [], ms: 10_000, error: 'fetch failed: ETIMEDOUT' }];
  const end = recorded.reduce((m, l) => Math.max(m, l.t), 0);

  const clock = new VirtualClock(start);
  const readers = replayReaders(lines, clock);
  const events: StreamEvent[] = [];
  const bookings: ReplayFunding[] = [];
  const health = new VenueHealth();
  const desk = new ReplayDesk({
    venues: readers.venues, clock, strategy: () => STRATEGY, takerBps: (v) => (v === 'hyperliquid' ? 5.5 : 3.5), onFunding: (f) => bookings.push(f),
  });
  const risk = new RiskEngine({
    mode: 'replay', clock, strategy: () => STRATEGY, health, publish: (e) => events.push(e), source: desk, reserveUsd: () => desk.reserveUsd,
  });
  const of = <K extends StreamEvent['type']>(type: K) => events.filter((e) => e.type === type).map((e) => e.data) as Extract<StreamEvent, { type: K }>['data'][];

  // Flat at the start: the deposit, on two accounts and the reserve.
  const flat = (await risk.tick())!;
  assert.equal(flat.legs.length, 0);
  assert.equal(flat.equityUsd, REPLAY_DEPOSIT_USD);
  assert.equal(flat.reserveUsd, REPLAY_DEPOSIT_USD - 2 * REPLAY_VENUE_CASH_USD);
  assert.deepEqual((await desk.account('phoenix')).freeMarginUsd, REPLAY_VENUE_CASH_USD);
  assert.deepEqual(await desk.closePair(), { ok: false, reason: 'the replay desk holds no pair' });

  // A 12 USD pair at 1.5x: long Phoenix, short Hyperliquid, at the recorded best ask and bid.
  const mark = (await readers.venues.find((v) => v.id === 'hyperliquid')!.funding()).find((r) => r.symbol === 'ETH')!.markPx!;
  const qty = Math.floor((12 / mark) * 1e4) / 1e4;
  const opened = await desk.openPair({ symbol: 'ETH', qty, long: 'phoenix', short: 'hyperliquid', leverage: 1.5 });
  assert.ok(opened.ok, JSON.stringify(opened));
  assert.deepEqual(opened.fills.map((f) => [f.venue, f.side, f.qty]), [['phoenix', 'BUY', qty], ['hyperliquid', 'SELL', qty]]);
  assert.ok(opened.fills.every((f) => f.px > 0 && f.feeUsd > 0 && f.feeUsd < 0.01));
  assert.deepEqual(await desk.openPair({ symbol: 'ETH', qty, long: 'phoenix', short: 'hyperliquid', leverage: 1.5 }), { ok: false, reason: 'the replay desk holds ETH already' });

  // Every 5 s of recorded time, through the outage and past the hour boundary.
  const boundary = Math.floor(start / HOUR) * HOUR + HOUR;
  assert.ok(boundary + 60_000 < end, 'the fixture runs past an hour boundary');
  const marks = new Set<number>();
  for (let t = start; t <= Math.max(back + 10_000, boundary + 60_000); t += 5_000) {
    clock.set(t);
    const d = (await risk.tick())!;
    if (d.legs.length === 2) marks.add(d.legs[0]!.mark);
  }
  const desks = of('desk') as DeskState[];
  const first = desks[1]!;
  assert.deepEqual(first.legs.map((l) => l.symbol), ['ETH', 'ETH']);
  assert.deepEqual(first.legs.map((l) => l.side).sort(), ['long', 'short']);
  // 12 USD of notional on 10 USD of margin: far from liquidation; the fees are the desk's only cost at the open.
  assert.ok(first.legs.every((l) => l.size * l.mark < 12.5 && l.distanceToLiqPct! > 60 && l.feesUsd < 0));
  // Each leg's fees are its open fill's taker fee, as a cost (the replay desk's own; no position book in replay).
  const openFee = new Map(opened.fills.map((f) => [f.venue, f.feeUsd]));
  assert.ok(first.legs.every((l) => l.feesUsd === -openFee.get(l.venue)!));
  assert.ok(Math.abs(first.pnl.feesUsd + opened.feeUsd) < 1e-12);
  assert.ok(Math.abs(first.equityUsd - (REPLAY_DEPOSIT_USD + first.pnl.netUsd)) < 1e-9, `${first.equityUsd} ${JSON.stringify(first.pnl)}`);
  assert.ok(marks.size > 1, 'the recording moves the marks');
  assert.ok(desks.every((d) => d.mode === 'replay' && (d.health === 'level' || d.health === 'watch')));

  // Funding booked once, at the hour boundary, from the open; the legs' funding since the open includes it.
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0]!.to, boundary);
  assert.equal(bookings[0]!.from, start);
  assert.deepEqual(bookings[0]!.legs.map((l) => `${l.venue} ${l.side}`), ['phoenix long', 'hyperliquid short']);
  assert.ok(Math.abs(bookings[0]!.usd - bookings[0]!.legs.reduce((s, l) => s + l.usd, 0)) < 1e-12);

  // health: ok at the first read, Phoenix down through the recorded outage, ok again after it.
  const maps = of('health') as HealthMap[];
  assert.deepEqual(maps.map((m) => m.phoenix), ['ok', 'down', 'ok']);
  assert.ok(maps.every((m) => m.hyperliquid === 'ok' && m.intents === 'ok' && m.near === 'ok'));
  const errors = (of('journal') as JournalEntry[]).filter((j) => j.kind === 'error');
  assert.deepEqual(errors.map((j) => j.summary), ['phoenix not answering: fetch failed: ETIMEDOUT']);
  // While Phoenix was down its leg stayed, watched.
  const during = desks.find((d) => d.updatedAt > outageAt && d.updatedAt < back)!;
  assert.equal(during.legs.length, 2);
  assert.equal(during.health, 'watch');

  // POST /stress's path: rescue now, with its journal line and a detect step; a small desk needs a small amount.
  const stressed = await risk.stress(true);
  assert.equal(stressed.health, 'rescue');
  assert.equal((of('desk') as DeskState[]).at(-1)!.health, 'rescue');
  const rescue = (of('journal') as JournalEntry[]).filter((j) => j.kind === 'rescue');
  assert.equal(rescue.length, 1);
  // The replay's rescuer plans from the reserve first, and the trigger names it (reserveUsd, replay only).
  assert.match(rescue[0]!.summary, /^health rescue: .* \(stress test\).*; [\d.]+ USD from reserve brings it back to [\d.]+ %$/);
  const progress = of('rescue') as RescueProgress[];
  assert.equal(progress.length, 1);
  assert.equal(progress[0]!.step, 'detect');
  assert.ok(progress[0]!.amountUsd > 0 && progress[0]!.amountUsd < 5, `${progress[0]!.amountUsd}`);
  await risk.stress(false);

  // The close: flat again, the realized P&L in the accounts, every part accounted for.
  clock.set(boundary + 5 * 60_000);
  const closed = await desk.closePair();
  assert.ok(closed.ok, JSON.stringify(closed));
  assert.ok(Math.abs(closed.netUsd - (closed.fundingUsd + closed.priceUsd - closed.entryFeeUsd - closed.feeUsd)) < 1e-12);
  assert.ok(Math.abs(closed.entryFeeUsd - opened.feeUsd) < 1e-12);
  assert.equal(closed.heldMs, boundary + 5 * 60_000 - start);
  assert.ok(Math.abs(closed.fundingUsd - bookings[0]!.usd - closed.unbookedFundingUsd) < 1e-12);
  assert.equal(desk.held(), null);
  const after = (await risk.tick())!;
  assert.equal(after.legs.length, 0);
  assert.ok(Math.abs(after.equityUsd - (REPLAY_DEPOSIT_USD + closed.netUsd)) < 1e-9, `${after.equityUsd} ${closed.netUsd}`);
});
