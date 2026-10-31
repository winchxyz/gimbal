// The scanner over a recorded hour of the three desk venues (fixtures/replay/scan-*.jsonl.gz, recorded with
// `GIMBAL_MODE=mainnet npm run serve -w engine -- --record <file> --minutes 65`), played twice in 5 s steps: the
// two plays must agree exactly, every scan must be ranked and complete, and the ranking must hold steady.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ScanStatus, Window as FundingWindow } from '@gimbal/shared';
import { replayStart } from '../cli/serve-replay.ts';
import { replayReaders } from '../readers.ts';
import { VirtualClock, readRecording } from '../venues/replay.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from './config.ts';
import { isEnterable } from './price.ts';
import { Scanner } from './scanner.ts';

const FIXTURES = fileURLToPath(new URL('../../fixtures/replay/', import.meta.url));
const files = readdirSync(FIXTURES).filter((f) => f.startsWith('scan-') && f.endsWith('.jsonl.gz')).sort();
const STEP_MS = 5_000;

interface Played {
  span: number;
  scans: { windows: FundingWindow[]; scan: ScanStatus }[];
}

async function play(file: string): Promise<Played> {
  const lines = readRecording(join(FIXTURES, file));
  const start = replayStart(lines);
  const end = lines.reduce((m, l) => Math.max(m, l.t), 0);
  const clock = new VirtualClock(start);
  const readers = replayReaders(lines, clock);
  const scanner = new Scanner(readers.venues, readers.watch, { config: DEFAULT_SCANNER_CONFIG, clock, strategy: () => DEFAULT_STRATEGY });
  const scans: Played['scans'] = [];
  for (let t = start; t <= end; t += STEP_MS) {
    clock.set(t);
    const r = await scanner.scan();
    // History reads answer in the background; the live engine has them back long before its next scan, 5 s later.
    await scanner.idle();
    scans.push({ windows: r.windows, scan: r.scan });
  }
  return { span: end - start, scans };
}

test('there is a committed scanner recording of about an hour', () => {
  assert.ok(files.length > 0, `no scan-*.jsonl.gz in ${FIXTURES}`);
  const lines = readRecording(join(FIXTURES, files.at(-1)!));
  const span = lines.at(-1)!.t - lines[0]!.t;
  assert.ok(span >= 55 * 60_000, `the recording spans ${Math.round(span / 60_000)} min`);
  assert.deepEqual([...new Set(lines.map((l) => l.venue))].sort(), ['hyperliquid', 'orderly', 'phoenix']);
});

for (const file of files) {
  test(`${file}: two replays give identical windows`, async () => {
    const a = await play(file);
    const b = await play(file);
    assert.ok(a.scans.length >= Math.floor(a.span / STEP_MS), `${a.scans.length} scans over ${a.span} ms`);
    assert.deepEqual(a.scans, b.scans);
  });

  test(`${file}: every scan is ranked, complete and finite; the ranking holds steady`, async (t) => {
    const { scans } = await play(file);
    const tops = new Map<string, number>();
    let setChanges = 0;
    let previous = '';
    for (const { windows, scan } of scans) {
      assert.ok(windows.length > 0, `no windows at ${scan.at}`);
      assert.equal(new Set(windows.map((w) => w.id)).size, windows.length);
      // Enterable first, then the other desk windows, each by net; then watch-only by gross. No desk policy is
      // loaded here, so nothing is enterable and every desk window is refused E_NO_DESK.
      const enterable = windows.filter(isEnterable);
      const desk = windows.filter((w) => w.tradable && !isEnterable(w));
      const watchOnly = windows.filter((w) => !w.tradable);
      assert.deepEqual(windows, [...enterable, ...desk, ...watchOnly], 'enterable, then desk, then watch-only');
      assert.equal(enterable.length, 0);
      for (const group of [enterable, desk]) for (let i = 1; i < group.length; i++) assert.ok(group[i - 1]!.netAprPct >= group[i]!.netAprPct);
      for (let i = 1; i < watchOnly.length; i++) assert.ok(watchOnly[i - 1]!.grossAprPct >= watchOnly[i]!.grossAprPct);
      for (const w of desk) assert.equal(w.refused?.code, 'E_NO_DESK');
      for (const w of windows) {
        const numbers = [w.grossAprPct, w.netAprPct, w.usdPerDayPer1k, w.breakevenHours, w.depthUsd, w.intervalsAbove, w.updatedAt, ...Object.values(w.costs)];
        for (const n of numbers) assert.ok(Number.isFinite(n), `${w.id} at ${scan.at}: ${n}`);
        assert.ok(w.grossAprPct > 0, `${w.id}: only positive gross is listed`);
        assert.ok(w.depthUsd >= DEFAULT_SCANNER_CONFIG.oiFloorUsd, `${w.id}: capacity ${w.depthUsd}`);
        assert.ok(w.updatedAt <= scan.at);
        assert.ok(w.grossApr7dPct === null || Number.isFinite(w.grossApr7dPct));
        assert.ok(w.checks.length > 0);
      }
      const top = windows[0]!.id;
      tops.set(top, (tops.get(top) ?? 0) + 1);
      const ids = windows.map((w) => w.id).sort().join(',');
      if (previous !== '' && ids !== previous) setChanges++;
      previous = ids;
    }
    const [bestTop, count] = [...tops.entries()].sort((a, b) => b[1] - a[1])[0]!;
    t.diagnostic(`${scans.length} scans; top ${bestTop} in ${count}; tops ${JSON.stringify([...tops])}; window set changed ${setChanges} times`);
    // Funding moves slowly: one window leads most of the hour, and the set of windows rarely changes.
    assert.ok(count >= 0.75 * scans.length, `top ${bestTop} leads only ${count} of ${scans.length} scans`);
    assert.ok(setChanges <= 0.05 * scans.length, `the window set changed ${setChanges} times in ${scans.length} scans`);
    // The recorded history reads give the leading windows a 7-day gross by the end of the hour.
    const last = scans.at(-1)!.windows;
    assert.ok(last.filter((w) => w.tradable).slice(0, 3).every((w) => w.grossApr7dPct !== null), 'the top windows have a 7-day gross');
  });
}
