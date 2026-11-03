// `npm run windows`: its options, and the block it prints for one window, from a scan of recorded numbers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketFunding, MarketFundingPoint } from '../venues/venue.ts';
import { VirtualClock } from '../venues/replay.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from '../scanner/config.ts';
import { HOUR_MS } from '../scanner/history.ts';
import { Scanner } from '../scanner/scanner.ts';
import { T0, row } from '../scanner/test-helpers.ts';
import { legGross, windowBlock, windowsOptions } from './windows-report.ts';

test('options: venues, symbols and leg size are checked; testnet unless --mainnet', () => {
  assert.deepEqual(windowsOptions({}, 1000), {
    network: 'testnet', venues: ['hyperliquid', 'phoenix', 'orderly'], symbols: null, legUsd: 1000, policyFile: null,
  });
  assert.deepEqual(windowsOptions({ mainnet: true, venues: 'hyperliquid,phoenix', symbols: 'doge, LTC,xlm', 'leg-usd': '20' }, 1000), {
    network: 'mainnet', venues: ['hyperliquid', 'phoenix'], symbols: ['DOGE', 'LTC', 'XLM'], legUsd: 20, policyFile: null,
  });
  assert.throws(() => windowsOptions({ venues: 'hyperliquid' }, 1000), /at least two desk venues/);
  assert.throws(() => windowsOptions({ venues: 'hyperliquid,pacifica' }, 1000), /pacifica is not a desk venue/);
  assert.throws(() => windowsOptions({ venues: 'phoenix,phoenix' }, 1000), /named twice/);
  assert.throws(() => windowsOptions({ symbols: ' , ' }, 1000), /no symbol/);
  assert.throws(() => windowsOptions({ 'leg-usd': '5' }, 1000), /--leg-usd must be a number from 10/);
  assert.throws(() => windowsOptions({ 'leg-usd': 'abc' }, 1000), /--leg-usd/);
});

test('gross per column is what the short receives minus what the long pays', () => {
  const g = legGross({ nowAprPct: 11.82, d7AprPct: 4.34, d14AprPct: null }, { nowAprPct: 10.09, d7AprPct: 9.37, d14AprPct: 7.58 });
  assert.ok(Math.abs(g.now - -1.73) < 1e-9);
  assert.ok(Math.abs(g.d7! - 5.03) < 1e-9);
  assert.equal(g.d14, null);
});

/** A desk venue with constant history per symbol, as the scanner reads it. */
function venue(id: 'hyperliquid' | 'phoenix', rows: MarketFunding[], rate: number) {
  return {
    id,
    markets: async () => [], account: async () => { throw new Error('unused'); }, userFunding: async () => [],
    funding: async () => rows,
    book: async (symbol: string) => {
      const mark = rows.find((r) => r.symbol === symbol)!.markPx!;
      // ±1 bp around the mark, deep enough for any leg here.
      return { venue: id, symbol, time: T0, bids: [{ px: mark * 0.9999, sz: 1e9 }], asks: [{ px: mark * 1.0001, sz: 1e9 }] };
    },
    marketFundingHistory: async (symbol: string, start: number, end: number): Promise<MarketFundingPoint[]> => {
      const out: MarketFundingPoint[] = [];
      for (let t = Math.ceil(start / HOUR_MS) * HOUR_MS; t <= end; t += HOUR_MS) out.push({ time: t, symbol, ratePerHour: rate, periodHours: 1 });
      return out;
    },
  };
}

test('the block for one window: legs now / 7 d / 14 d, round trip in USD and bps, carry over the hold, depth, refusals', async () => {
  // XLM as answered on mainnet 2026-11-03, with a flat history: Hyperliquid 0.0000125/h, Phoenix -0.0000125/h.
  const hl = venue('hyperliquid', [row('hyperliquid', 'XLM', { ratePerHour: 0.0000125, markPx: 0.16191, openInterest: 60097706 })], 0.0000125);
  const ph = venue('phoenix', [row('phoenix', 'XLM', { ratePerHour: 0.00001234, markPx: 0.1619, openInterest: 155995 })], -0.0000125);
  const clock = new VirtualClock(T0);
  const s = new Scanner([hl, ph], [], {
    config: { ...DEFAULT_SCANNER_CONFIG, historyPerScan: 20 }, clock, strategy: () => ({ ...DEFAULT_STRATEGY, legUsd: 20 }),
  });
  for (let i = 0; i < 3; i++) {
    clock.set(T0 + i * 5_000);
    await s.scan();
    await s.idle();
  }
  clock.set(T0 + 15_000);
  const r = await s.scan();
  assert.deepEqual(r.windows.map((w) => w.id), ['xlm-phoenix-hyperliquid']);
  const w = r.windows[0]!;
  const c = s.carry(w.id)!;
  // 0.000025/h apart for two weeks: 21.9 % APR on both means (a tie is judged on the 7 days); over 240 h on 20 USD
  // that is 0.12 USD.
  assert.equal(c.estimate.state, 'known');
  assert.equal(c.estimate.basis, '7d');
  assert.ok(Math.abs(c.estimate.expectedUsd! - 0.12) < 1e-9);
  // Fees 20 × 2 × 9 / 10⁴ = 0.036, slippage 4 × 20 × 1 bp = 0.008, no adverse gap (the long is the cheaper mark),
  // buffer 5 bps = 0.01: 0.054 USD = 27 bps.
  assert.ok(Math.abs(c.estimate.roundTrip.totalUsd - 0.054) < 1e-6, String(c.estimate.roundTrip.totalUsd));
  assert.ok(Math.abs(c.estimate.netUsd! - 0.066) < 1e-6);
  // 0.066 / 20 × 8760 / 240 = 12.045 % APR net over the hold: over the default 5 % minimum.
  assert.ok(Math.abs(c.estimate.netAprPct! - 12.045) < 1e-4);
  // 0.054 USD at 21.9 % on 20 USD (0.012 USD a day): 4.5 days.
  assert.ok(Math.abs(c.estimate.breakevenDays! - 4.5) < 1e-6);
  const g = legGross(c.long, c.short);
  assert.ok(Math.abs(g.d14! - c.estimate.gross.d14AprPct!) < 1e-9);
  assert.deepEqual(windowBlock(w, c), [
    'XLM  long Phoenix, short Hyperliquid  (xlm-phoenix-hyperliquid)',
    '  funding, APR %             now     7 d    14 d',
    '    Hyperliquid XLM short    10.95   10.95   10.95',
    '    Phoenix XLM long         10.81  -10.95  -10.95',
    '    gross (short - long)      0.14   21.90   21.90',
    '  round trip    $0.05 = 27.0 bps at $20.00 a leg (4 fills $0.04, slippage $0.0080, basis buffer $0.01)',
    '  one-off, not in the gate: transfers $1.56 (both legs\' margin moved in and out through 1Click), rescue reserve $0.32 over the hold',
    '  over a 10-day hold  expected $0.12 on 21.90 % APR (7 d, the smaller of 7 d and 14 d), $0.07 after the round trip = 12.04 % APR net '
      + '(minimum 5 %), break-even 4.5 days: passes the gate',
    '  depth         $25k (the smaller leg\'s open interest: Hyperliquid $9.7M, Phoenix $25k)',
    '  refused       E_NO_DESK: no desk policy loaded yet',
    '  failing       No desk policy loaded yet: nothing can be entered',
  ]);
  // A 20 USD leg is 0.079 % of Phoenix's 25k USD: no share check fails, and the break-even (4.5 days on the 14-day
  // spread) is well inside a year.
  assert.equal(w.breakevenHours, 108);
});
