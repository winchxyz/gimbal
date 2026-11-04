// The backtest core on a synthetic series with a known answer: one market, SYN, on Hyperliquid and Phoenix. Phoenix
// pays 0; Hyperliquid pays shorts S per hour (20 % APR) for the first 14.5 days plus 120 hours, then the same against
// them. Long Phoenix / short Hyperliquid then nets about 10 % over the hold after its 0.0324 USD round trip, so:
// - check 1 fails (the week before is still loading), check 2 is the window's first passing check, and it is entered
//   at check 1 + N for N = enterAfterChecks;
// - the flip shows at the check after the first negative hour (this hour pays < 0), so the pair leaves M checks later
//   for M = exitAfterChecks, holding M negative hours;
// - nothing re-enters: the hour pays < 0 from then on, and the other direction's multi-day spread does not pay.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContractPolicy } from '@gimbal/shared';
import { DEFAULT_STRATEGY } from '../scanner/config.ts';
import type { MarketFundingPoint } from '../venues/venue.ts';
import type { BacktestData } from './checks-data.ts';
import { HOUR_MS, firstCheckHour, lastCheckHour, simulate } from './checks-sim.ts';

const S = 0.2 / 8760;
const T0 = Date.UTC(2026, 0, 1);
const START = T0 + (14 * 24 + 12) * HOUR_MS;
const FLIP = START + 120 * HOUR_MS;           // the first hour Hyperliquid pays against shorts
const END = FLIP + 48 * HOUR_MS;

/** One print an hour, booked at the hour's end, covering it. */
function series(rate: (hour: number) => number): MarketFundingPoint[] {
  const out: MarketFundingPoint[] = [];
  for (let h = T0; h < END; h += HOUR_MS) out.push({ time: h + HOUR_MS, symbol: 'SYN', ratePerHour: rate(h), periodHours: 1 });
  return out;
}

const row = (venue: 'hyperliquid' | 'phoenix') => ({
  venue, symbol: 'SYN', ratePerHour: 0, settlement: 'hourly' as const, nextAt: 0, markPx: 100, oraclePx: 100, openInterest: 1e6, volume24hUsd: 1e8,
});
const market = (venue: 'hyperliquid' | 'phoenix') => ({
  venue, symbol: 'SYN', assetIndex: 0, szDecimals: 3, lotSize: 0.001, tickSize: null, maxPxDecimals: 3, maxLeverage: 10, isolatedOnly: false, delisted: false,
});
const book = (venue: 'hyperliquid' | 'phoenix') => ({ venue, symbol: 'SYN', time: 0, bids: [{ px: 99.99, sz: 1e4 }], asks: [{ px: 100.01, sz: 1e4 }] });

const DATA: BacktestData = {
  snapshot: {
    takenAt: END,
    funding: { hyperliquid: [row('hyperliquid')], phoenix: [row('phoenix')], orderly: [] },
    markets: { hyperliquid: [market('hyperliquid')], phoenix: [market('phoenix')], orderly: [] },
    books: { 'hyperliquid|SYN': book('hyperliquid'), 'phoenix|SYN': book('phoenix') },
  },
  history: [
    { venue: 'hyperliquid', symbol: 'SYN', fetchedAt: END, points: series((h) => (h < FLIP ? S : -S)) },
    { venue: 'phoenix', symbol: 'SYN', fetchedAt: END, points: series(() => 0) },
  ],
};

const POLICY: ContractPolicy = {
  hl_assets: [{ index: 0, symbol: 'SYN', sz_decimals: 3 }],
  phoenix_markets: [{ symbol: 'SYN', orderbook: 'test-orderbook-syn', base_lot_e8: 100_000, tick_e8: 1 }],
  orderly_symbols: [],
  max_notional_usd: 20, price_band_bps: 100, oracle_max_age_s: 900, rescue_cap_usd_per_hour: 50,
  unpriced: [], unpriced_max_notional_usd: 0, max_transfer_cost_bps: 300, max_transfer_cost_flat_e6: 1_000_000,
};
const STRATEGY = { ...DEFAULT_STRATEGY, auto: true, minNetAprPct: 5, legUsd: 12, maxLeverage: 3, stopDrawdownPct: 10, rotate: { minGainPts: 3, forHours: 4 } };
/** The round trip at 12 USD: 4 taker fills (5.5 + 3.5 bps), 1 bp of slippage a fill, the 5 bps basis buffer. */
const ROUND_TRIP = 12 * 2 * (5.5 + 3.5) / 1e4 + 4 * 12 * (0.01 / 100) + 12 * 5 / 1e4;

test('the check hours span the synthetic history', () => {
  assert.equal(firstCheckHour(DATA, ['hyperliquid', 'phoenix']), START);
  // The last print, booked at END, covers the hour before it: the check at END books it.
  assert.equal(lastCheckHour(DATA, ['hyperliquid', 'phoenix']), END);
});

for (const [n, m] of [[1, 1], [3, 3], [2, 4]] as const) {
  test(`enter after ${n}, exit after ${m}: one trade, in at check ${1 + n}, out ${m} checks after the flip shows`, async () => {
    const r = await simulate(DATA, {
      enterAfterChecks: n, exitAfterChecks: m, strategy: STRATEGY, policy: POLICY, scope: 'live', venues: ['hyperliquid', 'phoenix'], start: START, end: END,
    });
    assert.equal(r.trades.length, 1, JSON.stringify(r.trades));
    const t = r.trades[0]!;
    assert.equal(t.windowId, 'syn-phoenix-hyperliquid');
    assert.equal(t.enteredAt, START + n * HOUR_MS);
    assert.equal(t.exitedAt, FLIP + m * HOUR_MS);
    assert.match(t.exitReason, /the spread flipped: this hour pays .*in a row$/);
    assert.equal(t.legUsd, 12);
    assert.equal(t.hours, 120 - n + m);
    // 120 - n positive hours, then m negative ones.
    assert.ok(Math.abs(t.fundingUsd - 12 * S * (120 - n - m)) < 1e-9, `funding ${t.fundingUsd}`);
    assert.ok(Math.abs(t.costUsd - ROUND_TRIP) < 1e-9, `cost ${t.costUsd} against ${ROUND_TRIP}`);
    assert.ok(Math.abs(r.netUsd - (t.fundingUsd - t.costUsd)) < 1e-12);
    assert.equal(t.waitedHours, n - 1);
    assert.ok(Math.abs(t.waitedFundingUsd - 12 * S * (n - 1)) < 1e-9);
    assert.equal(t.badHours, m - 1);
    assert.ok(Math.abs(t.badFundingUsd + 12 * S * (m - 1)) < 1e-9);
    assert.deepEqual([r.entries, r.exits, r.rotations, r.missed.length, r.recovered, r.missingHours], [1, 1, 0, 0, 0, 0]);
  });
}

test('a window that passes for 2 checks only: entered after 1 check, missed after 3', async () => {
  const flip = START + 2 * HOUR_MS;
  const data: BacktestData = {
    ...DATA,
    history: [{ ...DATA.history[0]!, points: series((h) => (h < flip ? S : -S)) }, DATA.history[1]!],
  };
  const cfg = { exitAfterChecks: 1, strategy: STRATEGY, policy: POLICY, scope: 'live' as const, venues: ['hyperliquid', 'phoenix'] as const, start: START, end: START + 24 * HOUR_MS };
  const one = await simulate(data, { ...cfg, enterAfterChecks: 1 });
  assert.deepEqual(one.trades.map((t) => [t.enteredAt, t.exitedAt]), [[START + HOUR_MS, START + 3 * HOUR_MS]]);
  assert.deepEqual(one.missed, []);
  const three = await simulate(data, { ...cfg, enterAfterChecks: 3 });
  assert.deepEqual(three.trades, []);
  assert.deepEqual(three.missed, [{ windowId: 'syn-phoenix-hyperliquid', startedAt: START + HOUR_MS, hours: 2 }]);
});
