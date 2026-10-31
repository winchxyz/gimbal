// The cross-venue unit check over the recorded sweep: every watch venue plus Hyperliquid's main dex as a
// reference. It prints the BTC / ETH / SOL rates per venue, each venue's agreement with the others and its quiet
// pins, fails if a venue looks slipped or flipped, and proves it would catch a slip by planting one in each venue
// (and each settlement group) in turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ScanVenueId } from '@gimbal/shared';
import { HyperliquidReader } from '../hyperliquid.ts';
import { VirtualClock, readWireRecording, replayFetch } from '../replay.ts';
import type { MarketFunding } from '../venue.ts';
import { watchReaders } from './index.ts';
import { DEFAULT_LIMITS, agreement, agreementProblems, majors, pinProblems, quietPins, selfCheckReport } from './self-check.ts';
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

  // Quiet pins: every judged settlement group sits at the baseline, at its venue's own rounding of it (Lighter
  // 0.0012% and Extended / Aevo 0.0013% per hour), at half of it on hl-xyz, or at 2 x in MEXC's 8 h group.
  const pins = quietPins(byVenue).filter((p) => p.markets >= DEFAULT_LIMITS.minPinned);
  const off = pins.filter((p) => !(p.ofBaseline >= 0.95 && p.ofBaseline <= 1.05)).map((p) => `${p.venue} ${p.settlement} ${p.ofBaseline}`);
  assert.deepEqual(off.sort(), ['hl-xyz hourly 0.5', 'mexc 8h 2']);
  assert.deepEqual(pins.map((p) => `${p.venue} ${p.settlement}`).sort(), [...PINNED_GROUPS].sort());
});

/** Settlement groups whose quiet pin holds 10+ markets on the recorded sweep. */
const PINNED_GROUPS = [
  'aevo hourly', 'aster 4h', 'aster 8h', 'aster hourly', 'backpack hourly', 'binance 4h', 'binance 8h', 'bitget 4h', 'bitget 8h',
  'bybit 4h', 'bybit 8h', 'extended hourly', 'gate 4h', 'gate 8h', 'hl-xyz hourly', 'hyperliquid hourly', 'kucoin 4h', 'kucoin 8h',
  'lighter hourly', 'mexc 4h', 'mexc 8h', 'nado hourly', 'okx 4h', 'okx 8h', 'pacifica hourly', 'variational 4h', 'variational 8h',
];

const SLIPS: [string, (r: number) => number][] = [
  ['x8 (per 8 h read as per hour)', (r) => r * 8], ['/8', (r) => r / 8],
  ['x24 (per day read as per hour)', (r) => r * 24], ['/24', (r) => r / 24],
  ['x100 (percent read as a fraction)', (r) => r * 100], ['/100', (r) => r / 100],
  ['x8760 (annualised left annualised)', (r) => r * HOURS_PER_YEAR], ['/8760', (r) => r / HOURS_PER_YEAR],
];

function withSlip(
  byVenue: ReadonlyMap<ScanVenueId, readonly MarketFunding[]>, venue: ScanVenueId, slip: (r: number) => number, settlement?: string,
) {
  const out = new Map(byVenue);
  out.set(venue, byVenue.get(venue)!.map((m) => (settlement === undefined || m.settlement === settlement ? { ...m, ratePerHour: slip(m.ratePerHour) } : m)));
  return out;
}

function venuePinProblems(byVenue: ReadonlyMap<ScanVenueId, readonly MarketFunding[]>, venue: ScanVenueId): string[] {
  return quietPins(byVenue).filter((p) => p.venue === venue).flatMap((p) => pinProblems(p));
}

test('self-check: a 4 h rate read per hour (or an hourly one over 4) is caught by the quiet pin', async () => {
  const byVenue = answered(await recordedSweep());
  const slips: [string, (r: number) => number][] = [['x4', (r) => r * 4], ['/4', (r) => r / 4]];
  const missed: string[] = [];
  for (const venue of byVenue.keys()) {
    for (const [name, slip] of slips) {
      const slipped = withSlip(byVenue, venue, slip);
      const a = agreement(slipped).find((x) => x.venue === venue)!;
      if (agreementProblems(a).length === 0 && venuePinProblems(slipped, venue).length === 0) missed.push(`${venue} ${name}`);
    }
  }
  assert.deepEqual(missed.sort(), MISSED_BY_4);

  // One settlement group slipped while the rest of its venue reads right: the median ratio cannot see it, the pin can.
  let planted = 0;
  for (const p of quietPins(byVenue).filter((x) => x.markets >= DEFAULT_LIMITS.minPinned && x.ofBaseline > 0.95 && x.ofBaseline < 1.05)) {
    for (const [name, slip] of [...slips, ['x8', (r: number) => r * 8], ['/8', (r: number) => r / 8]] as const) {
      const problems = venuePinProblems(withSlip(byVenue, p.venue, slip, p.settlement), p.venue);
      assert.ok(problems.some((x) => x.startsWith(`${p.venue} ${p.settlement}: `)), `${p.venue} ${p.settlement} ${name} went unnoticed`);
      planted += 1;
    }
  }
  assert.equal(planted, (PINNED_GROUPS.length - 2) * 4);
});

/**
 * Slips by 4 the self-check cannot see on the recorded sweep: venues with no quiet pin (they do not sit at the
 * baseline) whose ratio stays in the band once slipped. dYdX x4 lands at 5.8 (ratio 1.46), Paradex x4 at 4.0
 * (continuous, no pin), Kraken /4 at 1.17 (4.67, premium only), GMX /4 at 0.77 (3.06, funding plus borrow); the
 * three small HIP-3 dexes are not judged at all. Every venue with a quiet pin is covered, all the CEXs among them.
 */
const MISSED_BY_4 = [
  'dydx x4', 'gmx-arbitrum /4', 'hl-io /4', 'hl-io x4', 'hl-mkts /4', 'hl-mkts x4', 'hl-para /4', 'hl-para x4', 'kraken /4', 'paradex x4',
];

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

  const pins = quietPins(answered(await recordedSweep())).filter((p) => p.markets >= DEFAULT_LIMITS.minPinned).map((p) => p.ofBaseline);
  const [pinLo, pinHi] = DEFAULT_LIMITS.pinBand;
  assert.ok(Math.min(...pins) >= pinLo && Math.max(...pins) <= pinHi, `healthy pins ${Math.min(...pins)}..${Math.max(...pins)} sit inside the pin band`);
  const atBaseline = pins.filter((x) => x > 0.95 && x < 1.05);
  assert.ok(Math.min(...atBaseline) * 4 > pinHi && Math.max(...atBaseline) / 4 < pinLo, 'a slip by 4 moves a baseline pin out of the band');
  const pin = { venue: 'v' as ScanVenueId, settlement: '4h' as const, ratePerHour: 0.00005, markets: 120, ofBaseline: 4 };
  assert.deepEqual(pinProblems(pin), ['v 4h: 120 markets sit at 0.00005 per hour, 4.00 x the 0.01% per 8 h baseline (want 0.33..3), near 4: a period slip?']);
  assert.deepEqual(pinProblems({ ...pin, markets: 9 }), [], 'too few markets on the pin to judge');
  assert.deepEqual(pinProblems({ ...pin, ratePerHour: 0.0000125 / 8, ofBaseline: 1 / 8 }), ['v 4h: 120 markets sit at 0.0000015625 per hour, 0.13 x the 0.01% per 8 h baseline (want 0.33..3), near 1/8: a period slip?']);
});
