// Runs HyperliquidReader against what the live API really answered (fixtures/hl-wire/*.jsonl.gz, captured with
// `npm run capture -w engine`), so parsing, the network choice, paging and the funding sign are checked on real
// shapes. The userFunding and account data belong to one public address picked from the venue's leaderboard.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { HlAssetCtx, HlClearinghouseState, HlFundingRow, HlMeta, HlMetaAndAssetCtxs } from './hyperliquid.ts';
import { HyperliquidReader } from './hyperliquid.ts';
import type { WireLine } from './recorder.ts';
import { ReplayMissError, VirtualClock, readWireRecording, replayFetch } from './replay.ts';

const DIR = fileURLToPath(new URL('../../fixtures/hl-wire/', import.meta.url));
const MAINNET = readWireRecording(join(DIR, 'hl-mainnet-2026-10-30.jsonl.gz'));
const TESTNET = readWireRecording(join(DIR, 'hl-testnet-2026-10-30.jsonl.gz'));
const ADDRESS = '0x54131c9bb91864aa922473d7e4a32d15b3be8b6a';   // a public address with open positions and funding history
const HOUR = 3_600_000;

type Request = { type: string } & Record<string, unknown>;

function lines(all: WireLine[], type: string): WireLine[] {
  return all.filter((l) => (l.request as Request).type === type);
}

function raw<T>(all: WireLine[], type: string): T {
  const found = lines(all, type);
  assert.equal(found.length, 1, `expected one recorded ${type}`);
  return found[0]!.response as T;
}

/** A reader fed by the recording, with the list of request bodies it sent. */
function readerOver(all: WireLine[], network: 'mainnet' | 'testnet', at = Date.UTC(2026, 9, 30, 20, 42, 35)) {
  const replay = replayFetch(all);
  const sent: Request[] = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Request);
    return replay(input, init);
  }) as typeof fetch;
  return { reader: new HyperliquidReader({ network, fetch: f, clock: new VirtualClock(at) }), sent };
}

test('fixtures were captured from the live API on both networks', () => {
  assert.ok(MAINNET.every((l) => l.url === 'https://api.hyperliquid.xyz/info'));
  assert.ok(TESTNET.every((l) => l.url === 'https://api.hyperliquid-testnet.xyz/info'));
  assert.equal(lines(MAINNET, 'userFunding').length, 2);
});

test('markets: every asset of meta, with the venue index, flags and decimals', async () => {
  const { reader } = readerOver(MAINNET, 'mainnet');
  const markets = await reader.markets();
  const meta = raw<HlMeta>(MAINNET, 'meta');
  assert.equal(markets.length, meta.universe.length);
  markets.forEach((m, i) => {
    assert.equal(m.symbol, meta.universe[i]!.name);
    assert.equal(m.assetIndex, i);
    assert.equal(m.venue, 'hyperliquid');
    assert.equal(m.maxLeverage, meta.universe[i]!.maxLeverage);
    assert.equal(m.maxPxDecimals, 6 - m.szDecimals);
  });
  const by = new Map(markets.map((m) => [m.symbol, m]));
  assert.deepEqual(by.get('ETH'), {
    venue: 'hyperliquid', symbol: 'ETH', assetIndex: 1, szDecimals: 4, lotSize: 0.0001, tickSize: null,
    maxPxDecimals: 2, maxLeverage: 25, isolatedOnly: false, delisted: false,
  });
  assert.equal(by.get('BTC')!.assetIndex, 0);
  assert.equal(by.get('BTC')!.maxLeverage, 40);
  assert.equal(by.get('BTC')!.szDecimals, 5);
  // Delisted and isolated-only assets are flagged, not dropped.
  assert.equal(markets.filter((m) => m.delisted).length, meta.universe.filter((a) => a.isDelisted === true).length);
  assert.equal(by.get('MATIC')!.delisted, true);
  assert.deepEqual([by.get('HPOS')!.delisted, by.get('HPOS')!.isolatedOnly], [true, true]);
  assert.deepEqual([by.get('XTEN')!.delisted, by.get('XTEN')!.isolatedOnly], [false, true]);
  assert.ok(markets.filter((m) => m.delisted).length > 0 && markets.filter((m) => m.isolatedOnly).length > 0);
});

test('markets: the testnet has its own asset indexes, and the network option picks the endpoint', async () => {
  const testnet = await readerOver(TESTNET, 'testnet').reader.markets();
  const idx = (symbol: string) => testnet.find((m) => m.symbol === symbol)!.assetIndex;
  assert.deepEqual([idx('SOL'), idx('BTC'), idx('ETH')], [0, 3, 4]);
  const mainnet = await readerOver(MAINNET, 'mainnet').reader.markets();
  assert.notEqual(mainnet.find((m) => m.symbol === 'ETH')!.assetIndex, idx('ETH'));
  // A reader aimed at the other network asks another URL, which the recording does not hold.
  await assert.rejects(readerOver(TESTNET, 'mainnet').reader.markets(), ReplayMissError);
  await assert.rejects(readerOver(MAINNET, 'testnet').reader.markets(), ReplayMissError);
});

test('funding: hourly rate and prices of every listed market, next payment at the next full hour', async () => {
  const at = Date.UTC(2026, 9, 30, 20, 42, 35);
  const { reader } = readerOver(MAINNET, 'mainnet', at);
  const rows = await reader.funding();
  const [meta, ctxs] = raw<HlMetaAndAssetCtxs>(MAINNET, 'metaAndAssetCtxs');
  const live = meta.universe.filter((a) => a.isDelisted !== true);
  assert.equal(rows.length, live.length);
  assert.ok(rows.length > 100);
  const ctxOf = new Map<string, HlAssetCtx>(meta.universe.map((a, i) => [a.name, ctxs[i]!]));
  for (const r of rows) {
    const c = ctxOf.get(r.symbol)!;
    assert.equal(r.venue, 'hyperliquid');
    assert.equal(r.settlement, 'hourly');
    assert.equal(r.nextAt, Date.UTC(2026, 9, 30, 21));
    assert.equal(r.ratePerHour, Number(c.funding));
    assert.equal(r.markPx, Number(c.markPx));
    assert.equal(r.oraclePx, Number(c.oraclePx));
    assert.equal(r.openInterest, Number(c.openInterest));
    assert.equal(r.volume24hUsd, Number(c.dayNtlVlm));
  }
  assert.ok(!rows.some((r) => r.symbol === 'MATIC'), 'delisted markets carry no funding row');
  const eth = rows.find((r) => r.symbol === 'ETH')!;
  assert.ok(Math.abs(eth.ratePerHour) < 0.01 && eth.markPx! > 100);
  // Exactly on the hour the payment has just been made: the next one is an hour on.
  const onTheHour = await readerOver(MAINNET, 'mainnet', Date.UTC(2026, 9, 30, 21)).reader.funding();
  assert.equal(onTheHour[0]!.nextAt, Date.UTC(2026, 9, 30, 21) + HOUR);
});

test('book: best levels first, optional depth, unknown coin refused', async () => {
  const { reader, sent } = readerOver(MAINNET, 'mainnet');
  const full = await reader.book('ETH');
  assert.equal(full.symbol, 'ETH');
  assert.equal(full.bids.length, 20);
  assert.equal(full.asks.length, 20);
  assert.ok(full.bids[0]!.px < full.asks[0]!.px, 'not crossed');
  for (let i = 1; i < full.bids.length; i++) assert.ok(full.bids[i]!.px < full.bids[i - 1]!.px, 'bids best first');
  for (let i = 1; i < full.asks.length; i++) assert.ok(full.asks[i]!.px > full.asks[i - 1]!.px, 'asks best first');

  const five = await reader.book('ETH', 5);
  assert.deepEqual(five.bids, full.bids.slice(0, 5));
  assert.deepEqual(five.asks, full.asks.slice(0, 5));
  assert.equal((await reader.book('ETH', 100)).bids.length, 20, 'the venue shows 20 levels a side at most');
  await assert.rejects(reader.book('ETH', 0), RangeError);
  assert.equal((await reader.book('BTC', 1)).bids.length, 1);

  // The venue answers an unknown coin with HTTP 500 and the body `null` (recorded).
  await assert.rejects(reader.book('NOT_A_COIN'), /unknown coin NOT_A_COIN/);
  assert.ok(sent.every((b) => b.type === 'l2Book'));
});

test('account: equity, free margin, maintenance margin and positions from clearinghouseState', async () => {
  const { reader, sent } = readerOver(MAINNET, 'mainnet');
  const acct = await reader.account(ADDRESS.toUpperCase().replace('0X', '0x'));   // the venue wants lowercase
  assert.deepEqual(sent, [{ type: 'clearinghouseState', user: ADDRESS }]);
  const state = raw<HlClearinghouseState>(MAINNET, 'clearinghouseState');
  assert.equal(acct.address, ADDRESS);
  assert.equal(acct.time, state.time);
  assert.equal(acct.equityUsd, 206688.793843);
  assert.equal(acct.equityUsd, Number(state.marginSummary.accountValue));
  assert.equal(acct.freeMarginUsd, 0);                       // withdrawable "0.0"
  assert.equal(acct.maintenanceMarginUsd, 39732.353296);
  assert.deepEqual(acct.positions, [
    {
      symbol: 'BTC', size: 19.99951, entryPx: 77629.9, liqPx: 68559.102223169, marginUsd: 77010.913186,
      unrealizedPnlUsd: -12342.813022, leverage: 20, fundingSinceOpenUsd: -321.370868, unsettledFundingUsd: 0,
    },
    {
      symbol: 'HYPE', size: -2500, entryPx: 89.4298, liqPx: 153.6814535467, marginUsd: 22519.75,
      unrealizedPnlUsd: -1622.98792, leverage: 10, fundingSinceOpenUsd: 5.631515, unsettledFundingUsd: 0,
    },
    {
      symbol: 'ZEC', size: -150, entryPx: 1224.2362, liqPx: 2289.3408924444, marginUsd: 18439.5,
      unrealizedPnlUsd: -759.556, leverage: 10, fundingSinceOpenUsd: 409.333492, unsettledFundingUsd: 0,
    },
  ]);
});

/** The funding rows of one coin that belong to its current position: a position pays every hour it is open, so a gap or a flip of side starts a new one. */
function currentRun(rows: { time: number; symbol: string; size: number; fundingUsd: number }[], symbol: string) {
  const mine = rows.filter((r) => r.symbol === symbol);
  const run = [];
  for (let i = mine.length - 1; i >= 0; i--) {
    const r = mine[i]!;
    const next = run[0];
    if (next !== undefined && (next.time - r.time > 1.5 * HOUR || Math.sign(r.size) !== Math.sign(next.size))) break;
    run.unshift(r);
  }
  return run;
}

test('funding sign: Hyperliquid counts cumFunding as paid, we report received > 0, and userFunding agrees', async () => {
  const { reader } = readerOver(MAINNET, 'mainnet');
  const acct = await reader.account(ADDRESS);
  const rows = await reader.userFunding(ADDRESS, 0);
  const state = raw<HlClearinghouseState>(MAINNET, 'clearinghouseState');
  const venueSinceOpen = (coin: string) => Number(state.assetPositions.find((p) => p.position.coin === coin)!.position.cumFunding.sinceOpen);
  const ours = (coin: string) => acct.positions.find((p) => p.symbol === coin)!.fundingSinceOpenUsd;

  // 1. A long that paid over the run: the venue's cumFunding is > 0, ours is < 0 and equals the sum of the
  //    userFunding payments since it opened, down to the last digit.
  const btc = currentRun(rows, 'BTC');
  assert.ok(btc.length >= 20, `${btc.length} hourly BTC payments`);
  assert.ok(btc.every((r) => r.size > 0));
  assert.ok(sum(btc) < 0, 'the long paid over the run');
  assert.ok(venueSinceOpen('BTC') > 0);
  assert.ok(ours('BTC') < 0);
  assert.ok(Math.abs(ours('BTC') - sum(btc)) < 1e-6, `${ours('BTC')} vs ${sum(btc)}`);

  // 2. A short that received over the run: the venue's cumFunding is < 0, ours is > 0.
  const hype = currentRun(rows, 'HYPE');
  assert.equal(hype.length, 2);
  assert.ok(hype.every((r) => r.size < 0));
  assert.ok(sum(hype) > 0, 'the short received over the run');
  assert.ok(venueSinceOpen('HYPE') < 0);
  assert.ok(ours('HYPE') > 0);
  assert.ok(Math.abs(ours('HYPE') - sum(hype)) < 1e-6, `${ours('HYPE')} vs ${sum(hype)}`);

  // 3. The same holds for sinceChange (funding since the size last changed): ZEC short, 59 hourly payments.
  const zec = rows.filter((r) => r.symbol === 'ZEC');
  const sinceSizeChange = [];
  for (let i = zec.length - 1; i >= 0 && zec[i]!.size === -150; i--) sinceSizeChange.push(zec[i]!);
  const zecState = state.assetPositions.find((p) => p.position.coin === 'ZEC')!.position;
  assert.equal(sinceSizeChange.length, 59);
  assert.ok(Math.abs(-Number(zecState.cumFunding.sinceChange) - sum(sinceSizeChange)) < 1e-6);
  // (ZEC's sinceOpen reaches back into the venue's older once-a-day rows, where sums are not guaranteed to line up.)
  assert.ok(ours('ZEC') > 0);

  // 4. The row rule behind it, for every payment in the history: pays when size and rate share a sign.
  for (const r of rows) {
    if (r.size === 0 || r.ratePerHour === 0) continue;
    assert.equal(Math.sign(r.fundingUsd), -Math.sign(r.size * r.ratePerHour), `${r.symbol} at ${r.time}`);
  }
});

function sum(rows: { fundingUsd: number }[]): number {
  return rows.reduce((s, r) => s + r.fundingUsd, 0);
}

test('userFunding pages past the 500-row limit without losing rows that share the cut timestamp', async () => {
  const { reader, sent } = readerOver(MAINNET, 'mainnet');
  const rows = await reader.userFunding(ADDRESS, 0);
  const pages = lines(MAINNET, 'userFunding').map((l) => l.response as HlFundingRow[]);
  assert.deepEqual(pages.map((p) => p.length), [500, 8]);
  const cut = pages[0]![499]!.time;

  // Two requests: from the start, then from the last timestamp of page one (inclusive), not after it.
  assert.deepEqual(sent, [
    { type: 'userFunding', user: ADDRESS, startTime: 0 },
    { type: 'userFunding', user: ADDRESS, startTime: cut },
  ]);
  // The venue cut page one between HYPE and ZEC of the same hour; those rows only come with page two.
  const atCut = rows.filter((r) => r.time === cut).map((r) => r.symbol);
  assert.deepEqual(atCut, ['BTC', 'HYPE', 'ZEC', 'xyz:NVDA']);
  assert.deepEqual(pages[0]!.filter((r) => r.time === cut).map((r) => r.delta.coin), ['BTC', 'HYPE']);

  assert.equal(rows.length, 506);                              // 500 + 8, minus the two rows both pages carry
  assert.equal(new Set(rows.map((r) => `${r.time}:${r.symbol}`)).size, rows.length);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i]!.time >= rows[i - 1]!.time, 'oldest first');

  // Row shape: builder-deployed markets keep their prefix, older rows are daily aggregates with a sample count.
  assert.ok(rows.some((r) => r.symbol === 'xyz:NVDA'));
  assert.deepEqual(rows[0], {
    time: 1786924800000, symbol: 'xyz:CXMT', fundingUsd: 78.030355, size: -16146.7461538462, ratePerHour: 0.0000413179, samples: 13,
  });
  assert.equal(rows.at(-1)!.samples, null);
});

test('userFunding refuses what the venue would answer oddly', async () => {
  const { reader } = readerOver(MAINNET, 'mainnet');
  await assert.rejects(reader.userFunding('0x123', 0), /not an EVM address/);
  await assert.rejects(reader.userFunding(ADDRESS, -1), RangeError);
  await assert.rejects(reader.userFunding(ADDRESS, 1.5), RangeError);
  await assert.rejects(reader.userFunding(ADDRESS, 10, 9), RangeError);
});
