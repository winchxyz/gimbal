// A replay run of the risk engine on a recorded mainnet scan (fixtures/replay/scan-mainnet-2026-10-31.jsonl.gz): the
// scripted desk opens at the recorded marks, every read is marked by the recording, `health` events follow the
// venues (a recorded Phoenix outage turns it down, then ok again), and POST /stress's path drives the desk to rescue.

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
import { ReplayDesk } from './sources.ts';
import { VenueHealth } from './venue-health.ts';

const FIXTURE = fileURLToPath(new URL('../../fixtures/replay/scan-mainnet-2026-10-31.jsonl.gz', import.meta.url));

test('replay: the scripted desk on recorded marks, health events through a recorded outage, stress to rescue', async () => {
  const recorded = readRecording(FIXTURE);
  const start = replayStart(recorded);
  // A Phoenix outage 2 min in, as a recording keeps one (an error line), until its next recorded answer.
  const phoenix = recorded.filter((l) => l.venue === 'phoenix' && l.method === 'funding' && l.error === undefined).map((l) => l.t).sort((a, b) => a - b);
  const outageAt = phoenix.find((t) => t > start + 120_000)! + 1;
  const back = phoenix.find((t) => t > outageAt)!;
  const lines: RecordLine[] = [...recorded, { t: outageAt, venue: 'phoenix', method: 'funding', args: [], ms: 10_000, error: 'fetch failed: ETIMEDOUT' }];

  const clock = new VirtualClock(start);
  const readers = replayReaders(lines, clock);
  const events: StreamEvent[] = [];
  const opened: string[] = [];
  const health = new VenueHealth();
  const risk = new RiskEngine({
    mode: 'replay', clock, strategy: () => DEFAULT_STRATEGY, health, publish: (e) => events.push(e),
    source: new ReplayDesk({ venues: readers.venues, clock, strategy: () => DEFAULT_STRATEGY, onOpen: (s) => opened.push(s) }),
  });
  const of = <K extends StreamEvent['type']>(type: K) => events.filter((e) => e.type === type).map((e) => e.data) as Extract<StreamEvent, { type: K }>['data'][];

  // Every 5 s of recorded time, through the outage and past its end.
  const marks = new Set<number>();
  for (let t = start; t <= back + 10_000; t += 5_000) {
    clock.set(t);
    const d = (await risk.tick())!;
    if (d.legs.length === 2) marks.add(d.legs[0]!.mark);
  }

  assert.equal(opened.length, 1);
  assert.match(opened[0]!, /^replay desk \(scripted positions, recorded prices\): long [\d.]+ ETH on (phoenix|hyperliquid) at [\d.]+, short on (phoenix|hyperliquid) at [\d.]+, 1000 USD a leg at 3x$/);
  const desks = of('desk') as DeskState[];
  const first = desks[0]!;
  assert.deepEqual(first.legs.map((l) => l.symbol), ['ETH', 'ETH']);
  assert.deepEqual(first.legs.map((l) => l.side).sort(), ['long', 'short']);
  // 1000 USD at 3x, m = 2 %: e = 1/3, so (1/3 − 0.02) / 0.98 = 31.97 % long and / 1.02 = 30.72 % short at the open.
  const long = first.legs.find((l) => l.side === 'long')!;
  const short = first.legs.find((l) => l.side === 'short')!;
  assert.ok(Math.abs(long.distanceToLiqPct! - (1 / 3 - 0.02) / 0.98 * 100) < 1e-6, `${long.distanceToLiqPct}`);
  assert.ok(Math.abs(short.distanceToLiqPct! - (1 / 3 - 0.02) / 1.02 * 100) < 0.05, `${short.distanceToLiqPct}`);
  assert.ok(marks.size > 1, 'the recording moves the marks');
  assert.ok(desks.every((d) => d.mode === 'replay' && (d.health === 'level' || d.health === 'watch')));

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

  // POST /stress's path: rescue now, with its journal line and a detect step.
  const stressed = await risk.stress(true);
  assert.equal(stressed.health, 'rescue');
  assert.equal((of('desk') as DeskState[]).at(-1)!.health, 'rescue');
  const rescue = (of('journal') as JournalEntry[]).filter((j) => j.kind === 'rescue');
  assert.equal(rescue.length, 1);
  // The recorded marks give a volatility estimate, far under the stress line.
  assert.match(rescue[0]!.summary, /^health rescue: .* \(stress test\), volatility term [\d.]+ %; [\d.]+ USD from reserve brings it back to [\d.]+ %$/);
  const progress = of('rescue') as RescueProgress[];
  assert.equal(progress.length, 1);
  assert.equal(progress[0]!.step, 'detect');
  assert.ok(progress[0]!.amountUsd > 0);
});
