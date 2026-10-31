// Runs OrderlyReader against what Orderly really answered (fixtures/orderly-wire/*.jsonl.gz, captured with
// `npm run capture -w engine -- --venue orderly [--testnet]`): REST over replayFetch, the public-stream book over
// replayWsRequester. The public stream needs a registered account id in its path; with none configured the reader
// borrows the most active EVM trader's from the public leaderboard, which the capture recorded too.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { OrderlyFuturesRow, OrderlyInfoRow } from './orderly.ts';
import { OrderlyReader, orderlyBaseSymbol, orderlyKeepAlive, orderlySymbol, parseFunding } from './orderly.ts';
import type { WireLine } from './recorder.ts';
import { ReplayMissError, VirtualClock, readWireRecording, replayFetch, replayWsRequester } from './replay.ts';

const DIR = fileURLToPath(new URL('../../fixtures/orderly-wire/', import.meta.url));
const MAINNET = readWireRecording(join(DIR, 'orderly-mainnet-2026-10-31.jsonl.gz'));
const TESTNET = readWireRecording(join(DIR, 'orderly-testnet-2026-10-31.jsonl.gz'));
const HOUR = 3_600_000;

function data<T>(lines: WireLine[], pathPart: string): T {
  const found = lines.find((l) => l.url.includes(pathPart));
  assert.ok(found !== undefined, `nothing recorded for ${pathPart}`);
  return (found.response as { data: T }).data;
}

function readerOver(lines: WireLine[], network: 'mainnet' | 'testnet' = 'mainnet') {
  const urls: string[] = [];
  const ws = replayWsRequester(lines);
  const wsRequest = (url: string, frame: { id: string } & Record<string, unknown>) => {
    urls.push(url);
    return ws(url, frame);
  };
  const reader = new OrderlyReader({ network, fetch: replayFetch(lines), wsRequest, clock: new VirtualClock(lines[0]!.t) });
  return { reader, urls };
}

test('markets: the shared ones only by default, steps from base_tick and quote_tick, leverage from the base IMR', async () => {
  const { reader } = readerOver(MAINNET);
  const markets = await reader.markets();
  // 152 listed on 2026-10-31: 73 shared, 79 brokers' own (75 of them mythos').
  assert.equal(markets.length, 73);
  assert.ok(markets.every((m) => m.brokerId === null && !/_USDC_/.test(m.symbol)));
  const sol = markets.find((m) => m.symbol === 'PERP_SOL_USDC')!;
  assert.deepEqual(sol, {
    venue: 'orderly', symbol: 'PERP_SOL_USDC', assetIndex: null, szDecimals: 2, lotSize: 0.01, tickSize: 0.001, maxPxDecimals: 3,
    maxLeverage: 100, isolatedOnly: false, delisted: false, brokerId: null, baseMin: 0.01, minNotional: 10, fundingPeriodHours: 8,
    baseImr: 0.01, baseMmr: 0.006, imrFactor: 0.0000010667,
  });
  for (const m of markets) {
    assert.ok(Number.isInteger(m.szDecimals) && Number.isInteger(m.maxPxDecimals) && m.maxLeverage >= 1, m.symbol);
    assert.ok([4, 8].includes(m.fundingPeriodHours), `${m.symbol} period ${m.fundingPeriodHours}`);
  }
  // A desk on the mythos broker also sees mythos' own markets, under their own symbols.
  const mythos = await new OrderlyReader({ fetch: replayFetch(MAINNET), brokerId: 'mythos', clock: new VirtualClock(MAINNET[0]!.t) }).markets();
  assert.equal(mythos.length, 73 + 75);
  assert.ok(mythos.some((m) => m.symbol === 'PERP_XAUT_USDC_mythos' && m.brokerId === 'mythos'));
  assert.ok(!mythos.some((m) => m.brokerId !== null && m.brokerId !== 'mythos'));
});

test('funding: the running period\'s estimate divided by its hours, for the markets the desk can trade', async () => {
  const { reader } = readerOver(MAINNET);
  const funding = await reader.funding();
  // Shared and active on 2026-10-31: 35 markets on a 4 h period, 38 on 8 h, none hourly.
  assert.equal(funding.length, 73);
  assert.equal(funding.filter((f) => f.settlement === '4h').length, 35);
  assert.equal(funding.filter((f) => f.settlement === '8h').length, 38);
  const by = new Map(funding.map((f) => [f.symbol, f]));
  // SOL: est_funding_rate -0.00014473 per 8 h period = -0.00001809125 per hour, paid at 08:00Z.
  const sol = by.get('PERP_SOL_USDC')!;
  assert.deepEqual([sol.ratePerHour, sol.settlement, sol.nextAt], [-0.00014473 / 8, '8h', Date.UTC(2026, 9, 31, 8)]);
  assert.ok(Math.abs(sol.ratePerHour - -0.00001809125) < 1e-15);
  assert.deepEqual([sol.markPx, sol.oraclePx, sol.openInterest, sol.volume24hUsd], [96.134, 96.171, 16682.47, 5272477.99843]);
  // ETHFI: -0.00004446 per 4 h period = -0.000011115 per hour, paid at 04:00Z.
  const ethfi = by.get('PERP_ETHFI_USDC')!;
  assert.deepEqual([ethfi.ratePerHour, ethfi.settlement, ethfi.nextAt], [-0.00004446 / 4, '4h', Date.UTC(2026, 9, 31, 4)]);
  assert.ok(!by.has('PERP_XAUT_USDC_mythos'), 'another broker\'s market is not the desk\'s');
  // On the mythos broker: its own XAUT, 0.00005 per 4 h = 0.0000125 per hour.
  const mythos = await new OrderlyReader({ fetch: replayFetch(MAINNET), brokerId: 'mythos', clock: new VirtualClock(MAINNET[0]!.t) }).funding();
  assert.equal(mythos.length, 73 + 75);
  const xaut = mythos.find((f) => f.symbol === 'PERP_XAUT_USDC_mythos')!;
  assert.deepEqual([xaut.ratePerHour, xaut.settlement], [0.00005 / 4, '4h']);
});

test('funding leaves out inactive markets, other brokers\', unnamed periods, and stale rows', () => {
  const info = (symbol: string, funding_period: number, broker_id: string | null = null) => ({ symbol, funding_period, broker_id }) as OrderlyInfoRow;
  const infos = [info('A', 8), info('B', 2), info('C', 8), info('E', 8, 'other'), info('F', 8, 'mine'), info('G', 8), info('H', 4)];
  const now = Date.UTC(2026, 9, 31, 12);
  const row = (symbol: string, next = Date.UTC(2026, 9, 31, 16), status = 'ACTIVE') =>
    ({ symbol, status, est_funding_rate: 0.0008, next_funding_time: next, mark_price: 1, index_price: 1, open_interest: 1, '24h_amount': 1 }) as OrderlyFuturesRow;
  const rows = [
    row('A'), row('B'), row('C', undefined, 'SUSPENDED'), row('D'), row('E'), row('F'),
    row('G', Date.UTC(2026, 9, 31, 3, 59)),     // 8 h period, next payment 8 h 01 min ago: last booking over 16 h old
    row('H', Date.UTC(2026, 9, 31, 8)),         // 4 h period, next payment 4 h ago: still within two periods
  ];
  assert.deepEqual(parseFunding(rows, infos, now).map((f) => [f.symbol, f.ratePerHour, f.settlement]), [['A', 0.0001, '8h'], ['H', 0.0002, '4h']]);
  assert.deepEqual(parseFunding(rows, infos, now, 'mine').map((f) => f.symbol), ['A', 'F', 'H']);
});

test('base symbols: only a shared market maps to its base asset; a broker market keeps its own symbol', () => {
  assert.equal(orderlyBaseSymbol('PERP_SOL_USDC'), 'SOL');
  assert.equal(orderlyBaseSymbol('PERP_1000BONK_USDC'), '1000BONK');
  assert.equal(orderlyBaseSymbol('PERP_SOL_USDC_mythos'), null);
  assert.equal(orderlyBaseSymbol('SOL'), null);
  assert.equal(orderlySymbol('SOL'), 'PERP_SOL_USDC');
  assert.equal(orderlySymbol('PERP_XAUT_USDC_mythos'), 'PERP_XAUT_USDC_mythos');
});

test('book over the public stream: [price, size] levels best first, the venue\'s own timestamp', async () => {
  const { reader, urls } = readerOver(MAINNET);
  const book = await reader.book('PERP_SOL_USDC', 5);
  const borrowed = data<{ account_id: string }>(MAINNET, '/v1/get_account').account_id;
  assert.equal(urls[0], `wss://ws-evm.orderly.org/ws/stream/${borrowed}`);
  assert.equal(book.venue, 'orderly');
  assert.equal(book.symbol, 'PERP_SOL_USDC');
  assert.equal(book.bids.length, 5);
  assert.ok(book.bids[0]!.px < book.asks[0]!.px);
  for (let i = 1; i < 5; i++) {
    assert.ok(book.bids[i]!.px < book.bids[i - 1]!.px);
    assert.ok(book.asks[i]!.px > book.asks[i - 1]!.px);
  }
  assert.ok(book.time > Date.UTC(2026, 9, 31) && book.time < Date.UTC(2026, 10, 1));
  const eth = await reader.book('PERP_ETH_USDC');
  assert.ok(eth.asks.length > 5);
  await assert.rejects(reader.book('NOT_A_COIN'), /orderly orderbook: unknown symbol NOT_A_COIN/);
  await assert.rejects(reader.book('PERP_DOGE_USDC'), ReplayMissError);
});

test('a configured stream account id is used as is, with no leaderboard lookup', async () => {
  const borrowed = data<{ account_id: string }>(MAINNET, '/v1/get_account').account_id;
  const fetched: string[] = [];
  const replay = replayFetch(MAINNET);
  const reader = new OrderlyReader({
    fetch: ((i: string | URL | Request, init?: RequestInit) => { fetched.push(String(i)); return replay(i, init); }) as typeof fetch,
    wsRequest: replayWsRequester(MAINNET),
    streamAccountId: borrowed,
  });
  await reader.book('PERP_BTC_USDC');
  assert.deepEqual(fetched, []);
});

test('market funding history: 8 h prints over three days, per hour, oldest first', async () => {
  const { reader } = readerOver(MAINNET);
  const req = MAINNET.find((l) => l.url.includes('funding_rate_history?symbol=PERP_SOL_USDC'))!;
  const q = new URL(req.url).searchParams;
  const points = await reader.marketFundingHistory('PERP_SOL_USDC', Number(q.get('start_t')), Number(q.get('end_t')));
  assert.equal(points.length, 9);
  for (let i = 1; i < points.length; i++) assert.equal(points[i]!.time - points[i - 1]!.time, 8 * HOUR);
  const last = points.at(-1)!;
  assert.deepEqual(last, { time: Date.UTC(2026, 9, 31), symbol: 'PERP_SOL_USDC', ratePerHour: -0.0001611 / 8, ratePerPeriod: -0.0001611, periodHours: 8 });
});

test('market funding history: each row\'s own period (next funding time minus its time) wins over the market\'s current one', async () => {
  const info = { symbol: 'PERP_X_USDC', funding_period: 4 };
  const rows = [
    { symbol: 'PERP_X_USDC', funding_rate: 0.0008, funding_rate_timestamp: Date.UTC(2026, 9, 30, 0), next_funding_time: Date.UTC(2026, 9, 30, 8) },
    { symbol: 'PERP_X_USDC', funding_rate: 0.0008, funding_rate_timestamp: Date.UTC(2026, 9, 30, 8), next_funding_time: Date.UTC(2026, 9, 30, 12) },
    { symbol: 'PERP_X_USDC', funding_rate: 0.0008, funding_rate_timestamp: Date.UTC(2026, 9, 30, 12) },
  ];
  const f = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const body = path === '/v1/public/info/PERP_X_USDC' ? info : { rows, meta: { total: 3, records_per_page: 500 } };
    return new Response(JSON.stringify({ success: true, data: body }));
  }) as typeof fetch;
  const points = await new OrderlyReader({ fetch: f }).marketFundingHistory('PERP_X_USDC', 0, Date.UTC(2026, 10, 1));
  // 0.0008 over an 8 h period is 0.0001 per hour; over 4 h it is 0.0002; a row that does not say takes the current 4 h.
  assert.deepEqual(points.map((p) => [p.periodHours, p.ratePerHour]), [[8, 0.0001], [4, 0.0002], [4, 0.0002]]);
});

test('testnet: its own endpoints and markets, and a book over the testnet stream', async () => {
  const { reader, urls } = readerOver(TESTNET, 'testnet');
  assert.equal(reader.apiUrl, 'https://testnet-api.orderly.org');
  const markets = await reader.markets();
  assert.equal(markets.length, 22, '27 listed, 5 of them brokers\' own');
  const book = await reader.book('PERP_SOL_USDC', 3);
  assert.ok(urls[0]!.startsWith('wss://testnet-ws-evm.orderly.org/ws/stream/0x'));
  assert.equal(book.bids.length, 3);
});

test('account and userFunding refuse without the desk\'s private side; nothing here signs', async () => {
  const { reader } = readerOver(MAINNET);
  const id = `0x${'ab'.repeat(32)}`;
  await assert.rejects(reader.account(id), /private stream session/);
  await assert.rejects(reader.userFunding(id, 0), /signed client/);
  await assert.rejects(reader.account('0x1234'), /not an account id/);
});

test('helpers: the keep-alive answers pings only, and base assets map to venue symbols', () => {
  assert.deepEqual(orderlyKeepAlive({ event: 'ping', ts: 5 }), { event: 'pong', ts: 5 });
  assert.equal(orderlyKeepAlive({ id: 'x', event: 'request' }), null);
  assert.equal(orderlySymbol('SOL'), 'PERP_SOL_USDC');
  assert.equal(orderlySymbol('PERP_ETH_USDC'), 'PERP_ETH_USDC');
});
