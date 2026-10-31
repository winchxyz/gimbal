// The scanner over a recorded hour (fixtures/replay/scan-*.jsonl.gz, recorded with
// `GIMBAL_MODE=mainnet npm run serve -w engine -- --record <file> --minutes 65`): the three desk venues, and in the
// newer recordings the watch-only venues too. Each is played twice: the two plays must agree exactly, every scan
// must be ranked and complete, the ranking must hold steady, and a recording with watch venues serves watch windows.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ScanStatus, Window as FundingWindow } from '@gimbal/shared';
import { replayStart } from '../cli/serve-replay.ts';
import { replayReaders } from '../readers.ts';
import type { RecordLine } from '../venues/recorder.ts';
import { VirtualClock, readRecording } from '../venues/replay.ts';
import { DESK_VENUE_IDS, isDeskVenueId } from '../venues/venue.ts';
import { WATCH_VENUE_IDS } from '../venues/watch/index.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from './config.ts';
import { isEnterable } from './price.ts';
import { hasQualityFinding } from './quality.ts';
import { Scanner } from './scanner.ts';

const FIXTURES = fileURLToPath(new URL('../../fixtures/replay/', import.meta.url));
const files = readdirSync(FIXTURES).filter((f) => f.startsWith('scan-') && f.endsWith('.jsonl.gz')).sort();
/** The live engine's scan interval: the window-set bound below is per 5 s of recording, whatever the step. */
const LIVE_STEP_MS = 5_000;

const hasWatch = (lines: readonly RecordLine[]) => lines.some((l) => !isDeskVenueId(l.venue));
/**
 * The replay step. A recording with the watch venues is played every 30 s, the scanner's watch read interval: their
 * thousands of legs make a scan about 0.3 s of CPU, and three plays of an hour in 5 s steps would take minutes.
 */
const stepOf = (lines: readonly RecordLine[]) => (hasWatch(lines) ? DEFAULT_SCANNER_CONFIG.watchIntervalMs : LIVE_STEP_MS);

interface Played {
  span: number;
  step: number;
  watch: boolean;
  scans: { windows: FundingWindow[]; scan: ScanStatus }[];
}

async function play(file: string): Promise<Played> {
  const lines = readRecording(join(FIXTURES, file));
  const start = replayStart(lines);
  const end = lines.reduce((m, l) => Math.max(m, l.t), 0);
  const step = stepOf(lines);
  const clock = new VirtualClock(start);
  const readers = replayReaders(lines, clock);
  const scanner = new Scanner(readers.venues, readers.watch, { config: DEFAULT_SCANNER_CONFIG, clock, strategy: () => DEFAULT_STRATEGY });
  const scans: Played['scans'] = [];
  for (let t = start; t <= end; t += step) {
    clock.set(t);
    const r = await scanner.scan();
    // History reads answer in the background; the live engine has them back long before its next scan, 5 s later.
    await scanner.idle();
    scans.push({ windows: r.windows, scan: r.scan });
  }
  return { span: end - start, step, watch: readers.watch.length > 0, scans };
}

// The second test checks the first test's first play rather than playing the hour a third time.
const firstPlays = new Map<string, Promise<Played>>();
const firstPlay = (file: string) => firstPlays.get(file) ?? firstPlays.set(file, play(file)).get(file)!;

test('there is a committed scanner recording of about an hour, with the desk venues and the watch-only ones', () => {
  assert.ok(files.length > 0, `no scan-*.jsonl.gz in ${FIXTURES}`);
  const lines = readRecording(join(FIXTURES, files.at(-1)!));
  const span = lines.at(-1)!.t - lines[0]!.t;
  assert.ok(span >= 55 * 60_000, `the recording spans ${Math.round(span / 60_000)} min`);
  const venues = [...new Set(lines.map((l) => l.venue))];
  assert.deepEqual(venues.filter(isDeskVenueId).sort(), [...DESK_VENUE_IDS].sort());
  const watch = venues.filter((v) => !isDeskVenueId(v));
  assert.ok(watch.length > 0, 'the newest recording has no watch-only venue');
  for (const v of watch) assert.ok((WATCH_VENUE_IDS as readonly string[]).includes(v), `${v} is neither a desk nor a watch venue`);
  // Watch venues are recorded by their sweeps only, kept every 10 min: an hour holds a handful of each.
  assert.ok(lines.filter((l) => !isDeskVenueId(l.venue)).every((l) => l.method === 'funding'));
});

for (const file of files) {
  test(`${file}: two replays give identical windows`, async () => {
    const a = await firstPlay(file);
    const b = await play(file);
    assert.ok(a.scans.length >= Math.floor(a.span / a.step), `${a.scans.length} scans over ${a.span} ms`);
    assert.deepEqual(a.scans, b.scans);
  });

  test(`${file}: every scan is ranked, complete and finite; the ranking holds steady`, async (t) => {
    const { scans, span, watch } = await firstPlay(file);
    const tops = new Map<string, number>();
    let setChanges = 0;
    let previous = '';
    let watchServed = 0;
    for (const { windows, scan } of scans) {
      assert.ok(windows.length > 0, `no windows at ${scan.at}`);
      assert.equal(new Set(windows.map((w) => w.id)).size, windows.length);
      // Enterable first, then the other desk windows, each by net; then watch-only. No desk policy is loaded here,
      // so nothing is enterable and every desk window is refused E_NO_DESK.
      const enterable = windows.filter(isEnterable);
      const desk = windows.filter((w) => w.tradable && !isEnterable(w));
      const watchOnly = windows.filter((w) => !w.tradable);
      assert.deepEqual(windows, [...enterable, ...desk, ...watchOnly], 'enterable, then desk, then watch-only');
      assert.equal(enterable.length, 0);
      for (const group of [enterable, desk]) for (let i = 1; i < group.length; i++) assert.ok(group[i - 1]!.netAprPct >= group[i]!.netAprPct);
      // Watch-only: the clean ones, then those with a quality finding, each by gross.
      const clean = watchOnly.filter((w) => !hasQualityFinding(w));
      const flagged = watchOnly.filter(hasQualityFinding);
      assert.deepEqual(watchOnly, [...clean, ...flagged], 'clean watch windows, then flagged ones');
      for (const group of [clean, flagged]) for (let i = 1; i < group.length; i++) assert.ok(group[i - 1]!.grossAprPct >= group[i]!.grossAprPct);
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
      for (const w of watchOnly) assert.ok(!isDeskVenueId(w.longVenue) || !isDeskVenueId(w.shortVenue), `${w.id}: a watch window on two desk venues`);
      if (watchOnly.length > 0) watchServed++;
      const top = windows[0]!.id;
      tops.set(top, (tops.get(top) ?? 0) + 1);
      // The desk windows' set: the watch windows' set moves with each recorded sweep and outage of 23 venues.
      const ids = [...enterable, ...desk].map((w) => w.id).sort().join(',');
      if (previous !== '' && ids !== previous) setChanges++;
      previous = ids;
    }
    const [bestTop, count] = [...tops.entries()].sort((a, b) => b[1] - a[1])[0]!;
    t.diagnostic(`${scans.length} scans; top ${bestTop} in ${count}; tops ${JSON.stringify([...tops])}; desk window set changed ${setChanges} times; `
      + `watch windows in ${watchServed} scans`);
    // Funding moves slowly: one window leads most of the hour, and the set of desk windows rarely changes (at most
    // once in 20 live scans, so the bound holds whatever the replay step).
    assert.ok(count >= 0.75 * scans.length, `top ${bestTop} leads only ${count} of ${scans.length} scans`);
    assert.ok(setChanges <= 0.05 * (span / LIVE_STEP_MS), `the desk window set changed ${setChanges} times in ${scans.length} scans`);
    // A recording with the watch venues serves watch windows from its first scan on: the replay starts once every
    // venue has answered.
    assert.equal(watchServed, watch ? scans.length : 0, `watch windows in ${watchServed} of ${scans.length} scans`);
    // The recorded history reads give the leading windows a 7-day gross by the end of the hour.
    const last = scans.at(-1)!.windows;
    assert.ok(last.filter((w) => w.tradable).slice(0, 3).every((w) => w.grossApr7dPct !== null), 'the top windows have a 7-day gross');
  });
}
