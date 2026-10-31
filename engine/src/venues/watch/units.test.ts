// One test per venue unit, each stated with a real value from the recorded sweep (watch-mainnet-2026-10-31):
// the test first finds the raw field in the recording, then converts it. Most venues sit at the 0.01% per 8 h
// baseline on BTC, which is 0.0000125 per hour (10.95% APR): the clearest check that a unit is right.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readWireRecording } from '../replay.ts';
import {
  HOURS_PER_YEAR, aevoRatePerHour, asterRatePerHour, backpackRatePerHour, bitgetRatePerHour, dydxRatePerHour,
  extendedRatePerHour, gateRatePerHour, gmxRatesPerHour, hlDexRatePerHour, krakenRatePerHour, kucoinRatePerHour,
  lighterRatePerHour, mexcRatePerHour, nadoRatePerHour, nextAtOr, nextBoundary, okxRatePerHour, oneSide,
  pacificaRatePerHour, paradexRatePerHour, perPeriodToHourly, predictedRatePerHour, scaledDecimal, settlementForHours,
  variationalRatePerHour,
} from './units.ts';

const LINES = readWireRecording(fileURLToPath(new URL('../../../fixtures/watch-wire/watch-mainnet-2026-10-31.jsonl.gz', import.meta.url)));
const BASELINE = 0.0000125;     // 0.01% per 8 h, per hour

function recorded(urlPart: string, bodyPart = ''): any {
  const line = LINES.find((l) => l.url.includes(urlPart) && JSON.stringify(l.request).includes(bodyPart));
  assert.ok(line !== undefined, `nothing recorded for ${urlPart} ${bodyPart}`);
  return line.response;
}

function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-9, `${actual} != ${expected}`);
}

test('hl dexes: funding is already per hour (xyz:TSLA 0.0000006905)', () => {
  const [meta, ctxs] = recorded('hyperliquid', '"dex":"xyz"');
  const tsla = ctxs[meta.universe.findIndex((a: { name: string }) => a.name === 'xyz:TSLA')];
  assert.equal(tsla.funding, '0.0000006905');
  assert.equal(hlDexRatePerHour(tsla.funding), 0.0000006905);
});

test('binance / bybit via predictedFundings: per fundingIntervalHours (BTC 0.0001 per 8 h on Binance)', () => {
  const [, venues] = recorded('hyperliquid', 'predictedFundings').find((r: [string]) => r[0] === 'BTC');
  const bin = venues.find((v: [string]) => v[0] === 'BinPerp')[1];
  assert.deepEqual([bin.fundingRate, bin.fundingIntervalHours], ['0.0001', 8]);
  close(predictedRatePerHour(bin.fundingRate, bin.fundingIntervalHours), BASELINE);
  // Hyperliquid's own row in the same answer is already hourly: 0.0001 per 8 h is its 0.0000125 per hour.
  assert.equal(venues.find((v: [string]) => v[0] === 'HlPerp')[1].fundingRate, '0.0000125');
});

test('pacifica: next_funding per hour (BTC 0.0000125)', () => {
  const btc = recorded('pacifica.fi/api/v1/info/prices').data.find((r: { symbol: string }) => r.symbol === 'BTC');
  assert.equal(btc.next_funding, '0.0000125');
  assert.equal(pacificaRatePerHour(btc.next_funding), BASELINE);
});

test('lighter: rate is scaled to 8 h (its copy of Hyperliquid BTC reads 0.0001 = 0.0000125 x 8)', () => {
  const rows = recorded('funding-rates').funding_rates.filter((r: { symbol: string }) => r.symbol === 'BTC');
  const hl = rows.find((r: { exchange: string }) => r.exchange === 'hyperliquid');
  assert.equal(hl.rate, 0.0001);
  close(lighterRatePerHour(hl.rate), BASELINE);
  const own = rows.find((r: { exchange: string }) => r.exchange === 'lighter');
  close(lighterRatePerHour(own.rate), 0.000012);
});

test('extended: fundingRate per hour (BTC-USD 0.000013)', () => {
  const btc = recorded('extended.exchange').data.find((m: { name: string }) => m.name === 'BTC-USD');
  assert.equal(btc.marketStats.fundingRate, '0.000013');
  assert.equal(extendedRatePerHour(btc.marketStats.fundingRate), 0.000013);
});

test('paradex: funding_rate per funding_interval_minutes (BTC 0.000096914903 per 480 min)', () => {
  const btc = recorded('paradex').results.find((m: { symbol: string }) => m.symbol === 'BTC-USD-PERP');
  assert.deepEqual([btc.funding_rate, btc.funding_interval_minutes], ['0.000096914903', 480]);
  close(paradexRatePerHour(btc.funding_rate, btc.funding_interval_minutes), 0.000096914903 / 8);
});

test('aster: lastFundingRate per fundingInfo interval (BTCUSDT 0.0001 per 8 h)', () => {
  const btc = recorded('premiumIndex').find((m: { symbol: string }) => m.symbol === 'BTCUSDT');
  const info = recorded('fundingInfo').find((m: { symbol: string }) => m.symbol === 'BTCUSDT');
  assert.deepEqual([btc.lastFundingRate, info.fundingIntervalHours], ['0.00010000', 8]);
  close(asterRatePerHour(btc.lastFundingRate, info.fundingIntervalHours), BASELINE);
});

test('dydx: nextFundingRate per hour (BTC-USD 0.0000393, 34% APR on a quiet Saturday)', () => {
  const btc = recorded('perpetualMarkets').markets['BTC-USD'];
  assert.equal(btc.nextFundingRate, '0.00003933333333333333');
  assert.equal(dydxRatePerHour(btc.nextFundingRate), 0.00003933333333333333);
});

test('nado: funding_rate is a 24 h rate paid hourly (BTC 0.0003 per 24 h)', () => {
  const btc = (Object.values(recorded('nado.xyz')) as { base_currency: string; funding_rate: number }[]).find((c) => c.base_currency === 'BTC-PERP')!;
  close(btc.funding_rate, 0.0003);
  close(nadoRatePerHour(btc.funding_rate), BASELINE);
});

test('aevo: funding_rate per funding_interval_minutes (BTC-PERP 0.000012 per 60 min)', () => {
  const btc = recorded('coingecko-statistics').find((m: { ticker_id: string }) => m.ticker_id === 'BTC-PERP');
  assert.deepEqual([btc.funding_rate, btc.funding_interval_minutes], ['0.000012', 60]);
  assert.equal(aevoRatePerHour(btc.funding_rate, btc.funding_interval_minutes), 0.000012);
});

test('variational: annualized_rate over 8760 (BTC-PERP 0.1095 = interval_rate 0.0001 x 3 x 365)', () => {
  const btc = recorded('variational').listings.find((m: { ticker: string }) => m.ticker === 'BTC-PERP');
  assert.deepEqual([btc.funding.next.annualized_rate, btc.funding.next.interval_rate, btc.funding.interval_seconds], ['0.1095', '0.0001', 28800]);
  close(variationalRatePerHour(btc.funding.next.annualized_rate), BASELINE);
});

test('gmx: per-side annual fractions x 1e30, funding + borrow, positive = pays', () => {
  const btc = recorded('markets/info').markets.find((m: { name: string }) => m.name === 'BTC/USD [WBTC.b-USDC]');
  assert.equal(btc.netRateLong, '243203914504095022904149152000');
  assert.equal(btc.netRateShort, '-207003189198101149852158420857');
  // net = funding + borrow on the long side: 0.2043 + 0.0389 = 0.2432 a year.
  close(scaledDecimal(btc.fundingRateLong, 30, 'f') + scaledDecimal(btc.borrowingRateLong, 30, 'b'), scaledDecimal(btc.netRateLong, 30, 'n'));
  const { ratePerHour, shortRatePerHour } = gmxRatesPerHour(btc.netRateLong, btc.netRateShort);
  close(ratePerHour, 0.243203914504095 / HOURS_PER_YEAR);          // a long pays 24.3% APR
  close(shortRatePerHour, 0.207003189198101 / HOURS_PER_YEAR);     // a short receives 20.7% APR
});

test('okx: fundingRate per period, fundingTime - prevFundingTime (BTC-USDT-SWAP, 8 h)', () => {
  const btc = recorded('funding-rate?instId=ANY').data.find((r: { instId: string }) => r.instId === 'BTC-USDT-SWAP');
  const periodMs = Number(btc.fundingTime) - Number(btc.prevFundingTime);
  assert.deepEqual([btc.fundingRate, periodMs], ['0.0000940656710475', 8 * 3_600_000]);
  close(okxRatePerHour(btc.fundingRate, periodMs), 0.0000940656710475 / 8);
});

test('bitget: fundingRate per fundingRateInterval hours (BTCUSDT 0.0001 per 8)', () => {
  const btc = recorded('mix/market/tickers').data.find((r: { symbol: string }) => r.symbol === 'BTCUSDT');
  const cur = recorded('current-fund-rate').data.find((r: { symbol: string }) => r.symbol === 'BTCUSDT');
  assert.deepEqual([btc.fundingRate, cur.fundingRateInterval], ['0.0001', '8']);
  close(bitgetRatePerHour(btc.fundingRate, cur.fundingRateInterval), BASELINE);
});

test('gate: funding_rate per funding_interval seconds (BTC_USDT 0.0001 per 28800 s)', () => {
  const btc = recorded('futures/usdt/contracts').find((c: { name: string }) => c.name === 'BTC_USDT');
  assert.deepEqual([btc.funding_rate, btc.funding_interval], ['0.0001', 28800]);
  close(gateRatePerHour(btc.funding_rate, btc.funding_interval), BASELINE);
});

test('kucoin: fundingFeeRate per currentFundingRateGranularity ms (XBTUSDTM 0.0001 per 28800000 ms)', () => {
  const btc = recorded('contracts/active').data.find((c: { symbol: string }) => c.symbol === 'XBTUSDTM');
  assert.deepEqual([btc.fundingFeeRate, btc.currentFundingRateGranularity], [0.0001, 28_800_000]);
  close(kucoinRatePerHour(btc.fundingFeeRate, btc.currentFundingRateGranularity), BASELINE);
});

test('mexc: fundingRate per collectCycle hours (BTC_USDT 0.0001 per 8)', () => {
  const btc = recorded('contract/funding_rate').data.find((r: { symbol: string }) => r.symbol === 'BTC_USDT');
  assert.deepEqual([btc.fundingRate, btc.collectCycle], [0.0001, 8]);
  close(mexcRatePerHour(btc.fundingRate, btc.collectCycle), BASELINE);
});

test('kraken: relativeFundingRate per hour (PF_XBTUSD 0.00002016405 = 1.558 USD per BTC / the index)', () => {
  const btc = recorded('kraken').tickers.find((t: { symbol: string }) => t.symbol === 'PF_XBTUSD');
  assert.equal(btc.relativeFundingRate, 0.00002016405);
  assert.ok(Math.abs(btc.fundingRate / btc.indexPrice / btc.relativeFundingRate - 1) < 0.001, 'relative = USD per contract / price');
  assert.equal(krakenRatePerHour(btc.relativeFundingRate), 0.00002016405);
});

test('backpack: fundingRate per fundingInterval ms (BTC_USDC_PERP 0.0000125 per 3600000 ms)', () => {
  const btc = recorded('markPrices').find((r: { symbol: string }) => r.symbol === 'BTC_USDC_PERP');
  const mkt = recorded('backpack.exchange/api/v1/markets').find((r: { symbol: string }) => r.symbol === 'BTC_USDC_PERP');
  assert.deepEqual([btc.fundingRate, mkt.fundingInterval], ['0.0000125', 3_600_000]);
  assert.equal(backpackRatePerHour(btc.fundingRate, mkt.fundingInterval), BASELINE);
});

test('helpers: period scaling, settlement names, next settlement, one side, exact decimal shift', () => {
  assert.equal(perPeriodToHourly(0.0008, 8), 0.0001);
  assert.equal(perPeriodToHourly(-0, 8), 0);
  assert.throws(() => perPeriodToHourly(0.0001, 0), RangeError);
  assert.throws(() => perPeriodToHourly(Number.NaN, 8), /not a number/);
  assert.deepEqual([1, 2, 4, 8, 24].map(settlementForHours), ['hourly', '2h', '4h', '8h', 'daily']);
  assert.throws(() => settlementForHours(3), /3 h has no settlement name/);
  const now = Date.UTC(2026, 9, 31, 2, 9, 17);
  assert.equal(nextBoundary(now, 1), Date.UTC(2026, 9, 31, 3));
  assert.equal(nextBoundary(now, 8), Date.UTC(2026, 9, 31, 8));
  assert.equal(nextAtOr(Date.UTC(2026, 9, 31, 8), now, 8), Date.UTC(2026, 9, 31, 8));
  assert.equal(nextAtOr(Date.UTC(2026, 9, 30, 8), now, 8), Date.UTC(2026, 9, 31, 8), 'a past time falls back to the boundary');
  assert.equal(nextAtOr(null, now, 1), Date.UTC(2026, 9, 31, 3));
  assert.equal(oneSide(10, 6), 8);
  assert.equal(scaledDecimal('243203914504095022904149152000', 30, 'x'), Number('0.243203914504095022904149152'));
  assert.equal(scaledDecimal('-1.5e31', 30, 'x'), -15);
  assert.throws(() => scaledDecimal('1,5', 30, 'x'), /not a decimal/);
});
