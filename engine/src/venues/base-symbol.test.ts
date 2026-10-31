// The cross-venue key of each tradable reader (MarketFunding.base / multiplier) and Phoenix's public funding history.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ExchangeMarketConfig, FundingOverviewResponse, LatestMarketsStatsResponse } from '@ellipsis-labs/rise';
import { baseFields, kiloBase } from './base-symbol.ts';
import { orderlyBase } from './orderly.ts';
import { parseFunding as parsePhoenixFunding, parseFundingSeries, phoenixBase } from './phoenix.ts';
import { readWireRecording } from './replay.ts';

test('kilo markets: "kPEPE" is 1000 PEPE; a plain name is never cut', () => {
  assert.deepEqual(kiloBase('kPEPE'), { base: 'PEPE', multiplier: 1000 });
  assert.deepEqual(kiloBase('k1INCH'), { base: '1INCH', multiplier: 1000 });
  assert.deepEqual(kiloBase('kaito'), { base: 'kaito', multiplier: 1 });
  assert.deepEqual(kiloBase('KAS'), { base: 'KAS', multiplier: 1 });
  assert.deepEqual(baseFields({ base: 'SOL', multiplier: 1 }), { base: 'SOL' });
  assert.deepEqual(baseFields({ base: 'PEPE', multiplier: 1000 }), { base: 'PEPE', multiplier: 1000 });
});

test('Phoenix lists its k-markets like Hyperliquid: kBONK is 1000 BONK; GOLD stays GOLD', () => {
  assert.deepEqual(phoenixBase('kBONK'), { base: 'BONK', multiplier: 1000 });
  assert.deepEqual(phoenixBase('SOL'), { base: 'SOL', multiplier: 1 });
  assert.deepEqual(phoenixBase('GOLD'), { base: 'GOLD', multiplier: 1 });
});

test('Orderly: PERP_SOL_USDC is SOL, PERP_1000PEPE_USDC is 1000 PEPE, XAU / XAG / CL are GOLD / SILVER / WTIOIL', () => {
  assert.deepEqual(orderlyBase('PERP_SOL_USDC'), { base: 'SOL', multiplier: 1 });
  assert.deepEqual(orderlyBase('PERP_1000PEPE_USDC'), { base: 'PEPE', multiplier: 1000 });
  assert.deepEqual(orderlyBase('PERP_1000BONK_USDC'), { base: 'BONK', multiplier: 1000 });
  assert.deepEqual(orderlyBase('PERP_XAU_USDC'), { base: 'GOLD', multiplier: 1 });
  assert.deepEqual(orderlyBase('PERP_XAG_USDC'), { base: 'SILVER', multiplier: 1 });
  assert.deepEqual(orderlyBase('PERP_CL_USDC'), { base: 'WTIOIL', multiplier: 1 });
  // A broker's own market is another market with its own book: it keeps its full symbol and pairs with nothing.
  assert.deepEqual(orderlyBase('PERP_SOL_USDC_mythos'), { base: 'PERP_SOL_USDC_mythos', multiplier: 1 });
});

const PHOENIX = fileURLToPath(new URL('../../fixtures/phoenix-wire/phoenix-mainnet-2026-10-31.jsonl.gz', import.meta.url));

test('Phoenix funding rows carry the base: kPEPE in the recorded answer is 1000 PEPE', () => {
  const lines = readWireRecording(PHOENIX);
  const first = <T>(part: string): T => lines.find((l) => l.url.includes(part))!.response as T;
  const rows = parsePhoenixFunding(
    first<FundingOverviewResponse>('/v1/funding/overview'), first<LatestMarketsStatsResponse>('/v1/markets/stats/latest'),
    first<ExchangeMarketConfig[]>('/v1/view/exchange/markets'), lines[0]!.t,
  );
  const pepe = rows.find((r) => r.symbol === 'kPEPE')!;
  assert.equal(pepe.base, 'PEPE');
  assert.equal(pepe.multiplier, 1000);
  const sol = rows.find((r) => r.symbol === 'SOL')!;
  assert.equal(sol.base, 'SOL');
  assert.equal(sol.multiplier, undefined);
});

test('Phoenix history: each booked hour is fundingAmountPerUnit / markPrice, timestamps in seconds become ms', () => {
  const t = Date.UTC(2026, 9, 31, 1) / 1000;
  const series = {
    marketId: 0, symbol: 'SOL',
    points: [
      { timestamp: t - 3600, fundingAmountPerUnit: '0.002', markPrice: '100', fundingRate: '9' },
      { timestamp: t, fundingAmountPerUnit: '-0.001', markPrice: '50', fundingRate: '9' },
      { timestamp: t, fundingAmountPerUnit: '-0.001', markPrice: '50', fundingRate: '9' },     // repeated: one point
      { timestamp: t + 7200, fundingAmountPerUnit: '0.001', markPrice: '50', fundingRate: '9' }, // after the end
    ],
  };
  assert.deepEqual(parseFundingSeries(series, 0, t * 1000 + 3_600_000), [
    { time: (t - 3600) * 1000, symbol: 'SOL', ratePerHour: 0.00002, periodHours: 1 },
    { time: t * 1000, symbol: 'SOL', ratePerHour: -0.00002, periodHours: 1 },
  ]);
});
