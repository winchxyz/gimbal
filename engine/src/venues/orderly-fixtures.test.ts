// Runs OrderlyReader against what Orderly really answered (fixtures/orderly-wire/*.jsonl.gz, captured with
// `npm run capture -w engine -- --venue orderly [--testnet]`): REST over replayFetch, the public-stream book over
// replayWsRequester. The public stream needs a registered account id in its path; with none configured the reader
// borrows the most active EVM trader's from the public leaderboard, which the capture recorded too.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { OrderlyFuturesRow, OrderlyInfoRow } from './orderly.ts';
import { OrderlyReader, orderlyKeepAlive, orderlySymbol, parseFunding } from './orderly.ts';
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

test('markets: venue symbols, steps from base_tick and quote_tick, leverage from the base IMR', async () => {
  const { reader } = readerOver(MAINNET);
  const markets = await reader.markets();
  assert.equal(markets.length, 152);
  const sol = markets.find((m) => m.symbol === 'PERP_SOL_USDC')!;
  assert.deepEqual(sol, {
    venue: 'orderly', symbol: 'PERP_SOL_USDC', assetIndex: null, szDecimals: 2, lotSize: 0.01, tickSize: 0.001, maxPxDecimals: 3,
    maxLeverage: 100, isolatedOnly: false, delisted: false, brokerId: null, baseMin: 0.01, minNotional: 10, fundingPeriodHours: 8,
    baseImr: 0.01, baseMmr: 0.006, imrFactor: 0.0000010667,
  });
  assert.ok(markets.some((m) => m.brokerId !== null), 'brokers list their own markets too');
  for (const m of markets) {
    assert.ok(Number.isInteger(m.szDecimals) && Number.isInteger(m.maxPxDecimals) && m.maxLeverage >= 1, m.symbol);
    assert.ok([1, 4, 8].includes(m.fundingPeriodHours), `${m.symbol} period ${m.fundingPeriodHours}`);
  }
});

test('funding: the running period\'s estimate divided by its hours, with the period as settlement', async () => {
  const { reader } = readerOver(MAINNET);
  const funding = await reader.funding();
  const futures = data<{ rows: OrderlyFuturesRow[] }>(MAINNET, '/v1/public/futures').rows;
  const solRow = futures.find((f) => f.symbol === 'PERP_SOL_USDC')!;
  const sol = funding.find((f) => f.symbol === 'PERP_SOL_USDC')!;
  assert.equal(sol.ratePerHour, solRow.est_funding_rate / 8);
  assert.equal(sol.settlement, '8h');
  assert.equal(sol.nextAt, solRow.next_funding_time);
  assert.equal(sol.nextAt % (8 * HOUR), 0);
  assert.deepEqual([sol.markPx, sol.oraclePx, sol.openInterest, sol.volume24hUsd], [solRow.mark_price, solRow.index_price, solRow.open_interest, solRow['24h_amount']]);
  const settlements = new Set(funding.map((f) => f.settlement));
  assert.ok(settlements.has('4h') && settlements.has('8h'), [...settlements].join(' '));
  for (const f of funding) {
    const period = f.settlement === 'hourly' ? 1 : f.settlement === '4h' ? 4 : 8;
    const row = futures.find((r) => r.symbol === f.symbol)!;
    assert.equal(f.ratePerHour, row.est_funding_rate / period, f.symbol);
  }
  // Every active market with a known period is there; inactive ones are left out.
  const active = futures.filter((r) => r.status === 'ACTIVE').length;
  assert.equal(funding.length, active);
});

test('funding leaves out inactive markets and periods the shared type cannot name', () => {
  const info = [{ symbol: 'A', funding_period: 8 }, { symbol: 'B', funding_period: 2 }, { symbol: 'C', funding_period: 8 }] as OrderlyInfoRow[];
  const row = (symbol: string, status = 'ACTIVE') => ({ symbol, status, est_funding_rate: 0.0008, next_funding_time: 1, mark_price: 1, index_price: 1, open_interest: 1, '24h_amount': 1 }) as OrderlyFuturesRow;
  const out = parseFunding([row('A'), row('B'), row('C', 'SUSPENDED'), row('D')], info);
  assert.deepEqual(out.map((f) => [f.symbol, f.ratePerHour, f.settlement]), [['A', 0.0001, '8h']]);
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

test('testnet: its own endpoints and markets, and a book over the testnet stream', async () => {
  const { reader, urls } = readerOver(TESTNET, 'testnet');
  assert.equal(reader.apiUrl, 'https://testnet-api.orderly.org');
  const markets = await reader.markets();
  assert.equal(markets.length, 27);
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
