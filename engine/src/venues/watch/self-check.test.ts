// The cross-venue unit check over the recorded sweep: every watch venue plus Hyperliquid's main dex as a
// reference. It prints the BTC / ETH / SOL rates per venue and each venue's agreement with the others, fails if a
// venue looks slipped or flipped, and proves it would catch a slip by planting one in each venue in turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ScanVenueId } from '@gimbal/shared';
import { HyperliquidReader } from '../hyperliquid.ts';
import { VirtualClock, readWireRecording, replayFetch } from '../replay.ts';
import type { MarketFunding } from '../venue.ts';
import { watchReaders } from './index.ts';
import { DEFAULT_LIMITS, agreement, agreementProblems, majors, selfCheckReport } from './self-check.ts';
import { answered, sweep, sweepReport } from './sweep.ts';
import { HOURS_PER_YEAR } from './units.ts';

const LINES = readWireRecording(fileURLToPath(new URL('../../../fixtures/watch-wire/watch-mainnet-2026-10-31.jsonl.gz', import.meta.url)));

async function recordedSweep() {
  const clock = new VirtualClock(LINES[0]!.t);
  const fetch = replayFetch(LINES);
  return sweep([new HyperliquidReader({ fetch, clock }), ...watchReaders({ fetch, clock })], clock);
}

test('self-check: every venue agrees with the others in sign and scale', async () => {
  const result = await recordedSweep();
  for (const line of sweepReport(result)) console.log(line);
  const byVenue = answered(result);
  assert.equal(byVenue.size, 24, 'all 23 watch venues and the reference answered');
  const { lines, problems } = selfCheckReport(byVenue);
  for (const line of lines) console.log(line);
  assert.deepEqual(problems, []);

  const judged = agreement(byVenue).filter((a) => a.compared >= DEFAULT_LIMITS.minCompared).map((a) => a.venue);
  assert.deepEqual(judged.sort(), [...byVenue.keys()].filter((v) => !['hl-para', 'hl-mkts', 'hl-io'].includes(v)).sort(),
    'every venue but the three small HIP-3 dexes shares 10+ coins with 3+ others');

  // BTC on the venues that pin it at the 0.01% per 8 h baseline: one number, whatever the venue's own unit.
  const btc = majors(byVenue, ['BTC']);
  for (const v of ['hyperliquid', 'pacifica', 'aster', 'nado', 'variational', 'binance', 'bitget', 'gate', 'kucoin', 'mexc', 'backpack']) {
    assert.ok(Math.abs(btc.get(v)![0]! * HOURS_PER_YEAR * 100 - 10.95) < 0.005, `${v} BTC at the baseline: ${btc.get(v)![0]}`);
  }
});

const SLIPS: [string, (r: number) => number][] = [
  ['x8 (per 8 h read as per hour)', (r) => r * 8], ['/8', (r) => r / 8],
  ['x24 (per day read as per hour)', (r) => r * 24], ['/24', (r) => r / 24],
  ['x100 (percent read as a fraction)', (r) => r * 100], ['/100', (r) => r / 100],
  ['x8760 (annualised left annualised)', (r) => r * HOURS_PER_YEAR], ['/8760', (r) => r / HOURS_PER_YEAR],
];

function withSlip(byVenue: ReadonlyMap<ScanVenueId, readonly MarketFunding[]>, venue: ScanVenueId, slip: (r: number) => number) {
  const out = new Map(byVenue);
  out.set(venue, byVenue.get(venue)!.map((m) => ({ ...m, ratePerHour: slip(m.ratePerHour) })));
  return out;
}

test('self-check: a unit slip or a sign flip planted in any judged venue is caught', async () => {
  const byVenue = answered(await recordedSweep());
  const healthy = new Map(agreement(byVenue).map((a) => [a.venue, a]));
  const judged = [...healthy.values()].filter((a) => a.compared >= DEFAULT_LIMITS.minCompared);
  let planted = 0;
  for (const { venue, signAgreement } of judged) {
    for (const [name, slip] of SLIPS) {
      const a = agreement(withSlip(byVenue, venue, slip)).find((x) => x.venue === venue)!;
      assert.notDeepEqual(agreementProblems(a), [], `${venue} ${name} went unnoticed: ratio ${a.medianRatio}`);
      planted += 1;
    }
    // A flip turns p% sign agreement into (100 - p)%. hl-xyz agrees on 52% only (weekend equities, see
    // DEFAULT_LIMITS), so its sign carries no information on this sweep; every other judged venue is at 60%+.
    if (venue === 'hl-xyz') {
      assert.ok(signAgreement < 0.55, 'hl-xyz is the one venue whose sign this sweep cannot judge');
      continue;
    }
    const flipped = agreement(withSlip(byVenue, venue, (r) => -r)).find((x) => x.venue === venue)!;
    assert.ok(agreementProblems(flipped).some((p) => p.includes('sign flipped?')), `${venue} flipped went unnoticed: ${flipped.signAgreement}`);
    planted += 1;
  }
  assert.equal(planted, judged.length * (SLIPS.length + 1) - 1);
});

test('self-check limits: thresholds sit between the healthy values and every slip', async () => {
  const judged = agreement(answered(await recordedSweep())).filter((a) => a.compared >= DEFAULT_LIMITS.minCompared);
  const ratios = judged.map((a) => a.medianRatio);
  const [lo, hi] = DEFAULT_LIMITS.ratioBand;
  assert.ok(Math.min(...ratios) * 8 > hi, `lowest healthy ratio x8 (${Math.min(...ratios) * 8}) must leave the band`);
  assert.ok(Math.max(...ratios) / 8 < lo, `highest healthy ratio /8 (${Math.max(...ratios) / 8}) must leave the band`);
  assert.deepEqual(agreementProblems({ venue: 'v', compared: 50, signAgreement: 0.85, medianRatio: 8.2 }), ['v: median ratio 8.20 is outside 0.7..6, near 8: a unit slip?']);
  assert.deepEqual(agreementProblems({ venue: 'v', compared: 50, signAgreement: 0.85, medianRatio: 1 / 8760 }), ['v: median ratio 0.00 is outside 0.7..6, near 1/8760: a unit slip?']);
  assert.deepEqual(agreementProblems({ venue: 'v', compared: 9, signAgreement: 0, medianRatio: 100 }), [], 'too few coins to judge');
});
