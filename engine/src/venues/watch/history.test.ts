// The readers against each venue's own settlement record. For every venue leg of the windows the scanner showed
// over 200% gross APR on 2026-10-31, plus a quiet control per venue, the venue's public funding history was
// recorded raw right after the 04:00 UTC settlement (fixtures/watch-wire/watch-history-2026-10-31). Each market's
// reading in the recorded sweep (02:09 UTC) is checked against it:
//   - period: the venue settles that market every `settlement` hours, the period the reader divided by;
//   - scale: the reading times its period against the rate the venue settled for the period it was read in. A
//     quiet coin settles exactly what was read; a running estimate lands within 3x (it drifts until the period
//     closes); a period slip would be 4, 8 or 24x off, a percent 100x.
// So the extreme rates are the venues' own: Backpack settled TRX at -0.119% for 02:00-03:00 (-1040% APR) after
// -0.166% the hour before, Bitget settled NIL at -0.288% for 00:00-04:00 (-631% APR), Q settled at its -2% floor
// on five venues at once, and so on down the table the first test prints.
//
// Not covered, no public history reachable: Binance and Bybit (read through Hyperliquid's predictedFundings) and
// Variational. Periods still open at the recording (8 h markets read in 00:00-08:00) are checked against the last
// period the venue settled.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ScanVenueId } from '@gimbal/shared';
import { HyperliquidReader } from '../hyperliquid.ts';
import type { WireLine } from '../recorder.ts';
import { VirtualClock, readWireRecording, replayFetch } from '../replay.ts';
import type { MarketFunding } from '../venue.ts';
import { watchReaders } from './index.ts';
import { answered, sweep } from './sweep.ts';
import { HOUR_MS, HOURS_PER_YEAR, type Settlement } from './units.ts';

const dir = new URL('../../../fixtures/watch-wire/', import.meta.url);
const SWEEP = readWireRecording(fileURLToPath(new URL('watch-mainnet-2026-10-31.jsonl.gz', dir)));
const HISTORY = readWireRecording(fileURLToPath(new URL('watch-history-2026-10-31.jsonl.gz', dir)));
const T0 = SWEEP[0]!.t;                   // 2026-10-31T02:09:17Z

const HOURS: Partial<Record<Settlement, number>> = { hourly: 1, '2h': 2, '4h': 4, '8h': 8, daily: 24 };

/** One settled period: when the venue stamped it (ms) and the rate it settled per period, + = longs pay. */
interface Settled { t: number; rate: number }

/** Where each venue's history lives, how to tell the market a line is for, and how to read its rows. */
const SOURCES: Record<string, { host: string; key: (l: WireLine) => string; rows: (body: any) => Settled[]; stamp?: 'start' }> = {
  backpack: { host: 'api.backpack.exchange', key: (l) => param(l, 'symbol'), rows: (b) => b.map((r: any) => ({ t: Date.parse(`${r.intervalEndTimestamp}Z`), rate: Number(r.fundingRate) })) },
  hyperliquid: { host: 'api.hyperliquid.xyz', key: (l) => (l.request as any).coin, rows: (b) => b.map((r: any) => ({ t: r.time, rate: Number(r.fundingRate) })) },
  kucoin: { host: 'api-futures.kucoin.com', key: (l) => param(l, 'symbol'), rows: (b) => b.data.map((r: any) => ({ t: r.timepoint, rate: r.fundingRate })) },
  // Kraken stamps an hour by its start: the rate its ticker shows is the one stamped at the top of the hour.
  kraken: { host: 'futures.kraken.com', key: (l) => param(l, 'symbol'), rows: (b) => b.rates.map((r: any) => ({ t: Date.parse(r.timestamp), rate: r.relativeFundingRate })), stamp: 'start' },
  // Lighter: `rate` in percent per hour, its side in `direction` (long = longs pay).
  lighter: { host: 'mainnet.zklighter.elliot.ai', key: (l) => lighterSymbol(param(l, 'market_id')), rows: (b) => b.fundings.map((r: any) => ({ t: r.timestamp * 1000, rate: (r.direction === 'long' ? 1 : -1) * Number(r.rate) / 100 })) },
  aster: { host: 'fapi.asterdex.com', key: (l) => param(l, 'symbol'), rows: (b) => b.map((r: any) => ({ t: r.fundingTime, rate: Number(r.fundingRate) })) },
  gate: { host: 'api.gateio.ws', key: (l) => param(l, 'contract'), rows: (b) => b.map((r: any) => ({ t: r.t * 1000, rate: Number(r.r) })) },
  bitget: { host: 'api.bitget.com', key: (l) => param(l, 'symbol'), rows: (b) => b.data.map((r: any) => ({ t: Number(r.fundingTime), rate: Number(r.fundingRate) })) },
  mexc: { host: 'contract.mexc.com', key: (l) => param(l, 'symbol'), rows: (b) => b.data.resultList.map((r: any) => ({ t: r.settleTime, rate: r.fundingRate })) },
  okx: { host: 'www.okx.com', key: (l) => param(l, 'instId'), rows: (b) => b.data.map((r: any) => ({ t: Number(r.fundingTime), rate: Number(r.realizedRate) })) },
};

function param(l: WireLine, name: string): string {
  return new URL(l.url).searchParams.get(name) ?? '';
}

function lighterSymbol(marketId: string): string {
  const details = SWEEP.find((l) => l.url.includes('orderBookDetails'))!.response as { order_book_details: { market_id: number; symbol: string }[] };
  return details.order_book_details.find((d) => String(d.market_id) === marketId)?.symbol ?? `?${marketId}`;
}

/** The venue's settled periods for one market, oldest first. */
function settled(venue: string, symbol: string): Settled[] {
  const source = SOURCES[venue.startsWith('hl-') ? 'hyperliquid' : venue]!;
  const line = HISTORY.find((l) => new URL(l.url).host === source.host && source.key(l) === symbol);
  assert.ok(line !== undefined, `no history recorded for ${venue} ${symbol}`);
  assert.equal(line.status, 200, `${venue} ${symbol} history answered ${line.status}`);
  return source.rows(line.response).sort((a, b) => a.t - b.t);
}

/**
 * exact: settled exactly as read, a quiet coin at its venue's resting rate or a rate the venue fixed for the hour
 * (Kraken); moving: a running estimate, within 3x of what the period settled at; drifted: an estimate the market
 * overtook in the two hours between the sweep and the close (same sign and period only, see DRIFTED).
 */
type Kind = 'exact' | 'moving' | 'drifted';

/** Every venue leg of the >200% windows, and a quiet control per venue. */
const CASES: [ScanVenueId, string, Kind][] = [
  ['backpack', 'BTC_USDC_PERP', 'exact'], ['backpack', 'TRX_USDC_PERP', 'moving'],
  ['hyperliquid', 'BTC', 'exact'], ['hyperliquid', 'TRX', 'exact'], ['hyperliquid', 'NIL', 'exact'],
  ['hyperliquid', 'HMSTR', 'exact'], ['hyperliquid', 'BLUR', 'moving'], ['hl-para', 'para:UNITREE', 'moving'],
  ['kraken', 'PF_SAMSUNGUSD', 'exact'],
  ['lighter', 'BTC', 'exact'], ['lighter', 'TRX', 'moving'], ['lighter', 'USELESS', 'moving'], ['lighter', 'UNITREE', 'exact'],
  ['kucoin', 'XBTUSDTM', 'exact'], ['kucoin', 'HMSTRUSDTM', 'exact'], ['kucoin', 'TRXUSDTM', 'moving'], ['kucoin', 'AINUSDTM', 'drifted'],
  ['kucoin', 'GTCUSDTM', 'moving'], ['kucoin', 'NILUSDTM', 'moving'], ['kucoin', 'QUSDTM', 'drifted'], ['kucoin', 'IDOLUSDTM', 'moving'],
  ['aster', 'BTCUSDT', 'exact'], ['aster', 'HMSTRUSDT', 'exact'], ['aster', 'TRXUSDT', 'moving'], ['aster', 'AINUSDT', 'drifted'],
  ['aster', 'AKEUSDT', 'moving'], ['aster', 'GTCUSDT', 'moving'], ['aster', 'IDOLUSDT', 'moving'], ['aster', 'JCTUSDT', 'moving'],
  ['aster', 'NILUSDT', 'moving'], ['aster', 'QUSDT', 'drifted'],
  ['gate', 'BTC_USDT', 'exact'], ['gate', 'HMSTR_USDT', 'exact'], ['gate', 'AIN_USDT', 'drifted'], ['gate', 'IDOL_USDT', 'moving'],
  ['gate', 'JCT_USDT', 'moving'], ['gate', 'NIL_USDT', 'moving'], ['gate', 'Q_USDT', 'drifted'], ['gate', 'USELESS_USDT', 'moving'],
  ['gate', 'UNITREE_USDT', 'moving'],
  ['bitget', 'BTCUSDT', 'exact'], ['bitget', 'IDOLUSDT', 'exact'], ['bitget', 'AKEUSDT', 'moving'], ['bitget', 'JCTUSDT', 'moving'],
  ['bitget', 'NILUSDT', 'moving'], ['bitget', 'QUSDT', 'drifted'],
  ['mexc', 'BTC_USDT', 'exact'], ['mexc', 'AIN_USDT', 'moving'], ['mexc', 'GTC_USDT', 'moving'], ['mexc', 'IDOL_USDT', 'moving'],
  ['mexc', 'NIL_USDT', 'moving'], ['mexc', 'Q_USDT', 'drifted'],
  ['okx', 'HMSTR-USDT-SWAP', 'exact'], ['okx', 'BTC-USDT-SWAP', 'moving'], ['okx', 'TRX-USDT-SWAP', 'moving'], ['okx', 'UNITREE-USDT-SWAP', 'moving'],
];

/**
 * Estimates the market overtook before the 04:00 close, read / settled (measured). Q fell into the -2% per 4 h
 * floor on every venue after the sweep (see the Q test below). AIN's premium fell through the period: Aster and
 * Gate read 3.0x and 3.2x what settled, MEXC 1.65x; KuCoin still read its resting 0.005% at 02:09.
 */
const DRIFTED: Record<string, number> = {
  'kucoin AINUSDTM': 0.1, 'kucoin QUSDTM': 0.05, 'aster AINUSDT': 3.01, 'aster QUSDT': 0.02, 'gate AIN_USDT': 3.19,
  'gate Q_USDT': 0.11, 'bitget QUSDT': 0.04, 'mexc Q_USDT': 0.03,
};

async function readings(): Promise<Map<ScanVenueId, MarketFunding[]>> {
  const clock = new VirtualClock(T0);
  const fetch = replayFetch(SWEEP);
  return answered(await sweep([new HyperliquidReader({ fetch, clock }), ...watchReaders({ fetch, clock })], clock));
}

/** The settled period a reading belongs to, or the last one the venue settled when that period was still open. */
function periodOf(venue: string, m: MarketFunding, rows: readonly Settled[]): { row: Settled; open: boolean } {
  const hours = HOURS[m.settlement]!;
  const stamp = SOURCES[venue.startsWith('hl-') ? 'hyperliquid' : venue]!.stamp === 'start' ? m.nextAt - hours * HOUR_MS : m.nextAt;
  const row = rows.find((r) => Math.abs(r.t - stamp) < 2 * 60_000);
  if (row !== undefined) return { row, open: false };
  const last = rows.filter((r) => r.t <= T0).at(-1);
  assert.ok(last !== undefined, `${venue} ${m.symbol}: nothing settled before the sweep`);
  return { row: last, open: true };
}

test('history: every window leg settles on the period its reader divided by, at the scale it read', async () => {
  const byVenue = await readings();
  const failures: string[] = [];
  const open: string[] = [];
  for (const [venue, symbol, kind] of CASES) {
    const m = byVenue.get(venue)?.find((f) => f.symbol === symbol);
    assert.ok(m !== undefined, `${venue} ${symbol} is not in the recorded sweep`);
    const hours = HOURS[m.settlement];
    assert.ok(hours !== undefined, `${venue} ${symbol}: ${m.settlement} has no period`);
    const rows = settled(venue, symbol);

    // Period: the venue's own spacing between its last settlements.
    const recent = rows.slice(-4);
    const gaps = recent.slice(1).map((r, i) => Math.round((r.t - recent[i]!.t) / HOUR_MS));
    if (!(gaps.length >= 1 && gaps.every((g) => g === hours))) failures.push(`${venue} ${symbol}: read per ${hours} h, settled every ${gaps.join(', ')} h`);

    // Scale: the reading per period against what the venue settled.
    const { row, open: isOpen } = periodOf(venue, m, rows);
    if (isOpen) open.push(`${venue} ${symbol}`);
    const read = m.ratePerHour * hours;
    const ratio = read / row.rate;
    console.log(`${venue.padEnd(12)} ${symbol.padEnd(18)} ${m.settlement.padEnd(6)} read ${read.toExponential(3).padStart(10)}  settled ${row.rate.toExponential(3).padStart(10)} at ${new Date(row.t).toISOString().slice(11, 16)}${isOpen ? ' (last; period open)' : ''}  ${(m.ratePerHour * HOURS_PER_YEAR * 100).toFixed(0).padStart(6)}% APR`);
    const ok = kind === 'exact' ? Math.abs(read - row.rate) <= Math.abs(row.rate) * 1e-9
      : kind === 'moving' ? ratio >= 1 / 3 && ratio <= 3
      : ratio > 0 && Math.abs(ratio - DRIFTED[`${venue} ${symbol}`]!) < 0.005;
    if (!ok) failures.push(`${venue} ${symbol}: read ${read} per ${hours} h, settled ${row.rate}: ${ratio.toFixed(2)}x`);
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(open.sort(), OPEN_PERIODS, 'markets read in a period still open at the recording');
  assert.equal(CASES.filter(([, , k]) => k === 'drifted').length, Object.keys(DRIFTED).length);
});

/** 8 h markets read in 00:00-08:00, compared with the 00:00 settlement instead (measured). */
const OPEN_PERIODS = [
  'aster BTCUSDT', 'aster TRXUSDT', 'bitget BTCUSDT', 'gate BTC_USDT', 'kucoin XBTUSDTM', 'mexc BTC_USDT',
  'okx BTC-USDT-SWAP', 'okx TRX-USDT-SWAP', 'okx UNITREE-USDT-SWAP',
];

test('history: Q settled at the -2% per 4 h floor its contracts state, the -4380% APR the scanner read later', async () => {
  // In the sweep the floor is a per-period number beside the rate the reader divides by the same period.
  const floors: [string, string, number][] = [
    ['aster', 'QUSDT', (recordedRow('fapi.asterdex.com/fapi/v1/fundingInfo', 'QUSDT') as any).fundingFeeFloor],
    ['bitget', 'QUSDT', Number((recordedRow('current-fund-rate', 'QUSDT') as any).minFundingRate)],
    ['gate', 'Q_USDT', -Number((recordedRow('futures/usdt/contracts', 'Q_USDT') as any).funding_rate_limit)],
    ['kucoin', 'QUSDTM', (recordedRow('contracts/active', 'QUSDTM') as any).fundingRateFloor],
  ];
  for (const [venue, symbol, floor] of floors) {
    assert.equal(floor, -0.02, `${venue} ${symbol} floor`);
    const close = settled(venue, symbol).find((r) => Math.abs(r.t - Date.UTC(2026, 9, 31, 4)) < 2 * 60_000);
    assert.equal(close?.rate, floor, `${venue} ${symbol} settled at its floor`);
    assert.equal((floor / 4) * HOURS_PER_YEAR * 100, -4380);
  }
  // MEXC states a -3% floor and settled -2% with the others.
  assert.equal(settled('mexc', 'Q_USDT').at(-1)!.rate, -0.02);
});

/** One row of a bulk answer in the recorded sweep, by its symbol field. */
function recordedRow(urlPart: string, symbol: string): unknown {
  const line = SWEEP.find((l) => l.url.includes(urlPart));
  assert.ok(line !== undefined, `nothing recorded for ${urlPart}`);
  const body = line.response as any;
  const rows: any[] = Array.isArray(body) ? body : body.data;
  const row = rows.find((r) => r.symbol === symbol || r.name === symbol);
  assert.ok(row !== undefined, `no ${symbol} in ${urlPart}`);
  return row;
}
