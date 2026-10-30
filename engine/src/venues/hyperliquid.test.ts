import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HlClearinghouseState, HlFundingRow, HlL2Book, HlMetaAndAssetCtxs } from './hyperliquid.ts';
import {
  HL_MAINNET_INFO_URL, HL_TESTNET_INFO_URL, HlHttpError, HyperliquidReader, parseAccount, parseBook, parseFunding,
  parseFundingRow, parseMarkets,
} from './hyperliquid.ts';
import { VirtualClock } from './replay.ts';

const ctx = (funding: string, markPx: string) => ({
  funding, markPx, oraclePx: markPx, openInterest: '10.5', midPx: markPx, dayNtlVlm: '123456.7',
});

const META_AND_CTXS: HlMetaAndAssetCtxs = [
  {
    universe: [
      { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
      { name: 'OLD', szDecimals: 1, maxLeverage: 3, isDelisted: true },
      { name: 'HPOS', szDecimals: 0, maxLeverage: 3, onlyIsolated: true, marginMode: 'strictIsolated' },
    ],
  },
  [ctx('0.0000125', '77597.0'), ctx('0.0', '1.0'), ctx('-0.0003', '0.0123')],
];

const BOOK: HlL2Book = {
  coin: 'ETH',
  time: 1793377713000,
  levels: [
    [{ px: '2235.5', sz: '1.5', n: 3 }, { px: '2235.4', sz: '2', n: 1 }],
    [{ px: '2235.6', sz: '0.25', n: 1 }, { px: '2235.7', sz: '4', n: 2 }],
  ],
};

test('markets keep the asset index and flag delisted and isolated-only assets', () => {
  const markets = parseMarkets(META_AND_CTXS[0]);
  assert.deepEqual(markets.map((m) => [m.symbol, m.assetIndex, m.delisted, m.isolatedOnly]), [
    ['BTC', 0, false, false],
    ['OLD', 1, true, false],
    ['HPOS', 2, false, true],
  ]);
  const btc = markets[0]!;
  assert.equal(btc.lotSize, 0.00001);
  assert.equal(btc.maxPxDecimals, 1);
  assert.equal(btc.tickSize, null);
});

test('funding skips delisted assets and points nextAt at the next full hour', () => {
  const now = Date.UTC(2026, 9, 30, 16, 28, 33);
  const rows = parseFunding(META_AND_CTXS[0], META_AND_CTXS[1], now);
  assert.deepEqual(rows.map((r) => r.symbol), ['BTC', 'HPOS']);
  assert.deepEqual(rows[0], {
    venue: 'hyperliquid', symbol: 'BTC', ratePerHour: 0.0000125, settlement: 'hourly',
    nextAt: Date.UTC(2026, 9, 30, 17), markPx: 77597, oraclePx: 77597, openInterest: 10.5, volume24hUsd: 123456.7,
  });
  assert.equal(rows[1]!.ratePerHour, -0.0003);
  // Exactly on the hour, that hour's payment is done: next is the one after.
  assert.equal(parseFunding(META_AND_CTXS[0], META_AND_CTXS[1], Date.UTC(2026, 9, 30, 17))[0]!.nextAt, Date.UTC(2026, 9, 30, 18));
});

test('funding refuses a context list that does not line up with the universe', () => {
  assert.throws(() => parseFunding(META_AND_CTXS[0], META_AND_CTXS[1].slice(1), 0), /3 assets but 2 contexts/);
});

test('book parses both sides best first', () => {
  const book = parseBook(BOOK);
  assert.deepEqual(book.bids, [{ px: 2235.5, sz: 1.5 }, { px: 2235.4, sz: 2 }]);
  assert.deepEqual(book.asks[0], { px: 2235.6, sz: 0.25 });
  assert.equal(book.time, 1793377713000);
});

test('account flips cumFunding to received-positive', () => {
  const raw: HlClearinghouseState = {
    marginSummary: { accountValue: '1000.5' },
    crossMaintenanceMarginUsed: '12.25',
    withdrawable: '800',
    time: 1793377713000,
    assetPositions: [{
      position: {
        coin: 'BTC', szi: '-0.01', entryPx: '77000', liquidationPx: null, marginUsed: '50',
        unrealizedPnl: '-6', leverage: { value: 5 }, cumFunding: { sinceOpen: '-0.42' },
      },
    }],
  };
  const acct = parseAccount('0xabc', raw);
  assert.equal(acct.equityUsd, 1000.5);
  assert.equal(acct.freeMarginUsd, 800);
  assert.equal(acct.maintenanceMarginUsd, 12.25);
  assert.deepEqual(acct.positions, [{
    symbol: 'BTC', size: -0.01, entryPx: 77000, liqPx: null, marginUsd: 50, unrealizedPnlUsd: -6,
    leverage: 5, fundingSinceOpenUsd: 0.42, unsettledFundingUsd: 0,
  }]);
});

test('account turns a zero cumFunding into 0, not -0, and a paid position into a negative number', () => {
  const position = (sinceOpen: string) => ({
    coin: 'ETH', szi: '1', entryPx: '2000', liquidationPx: '1500', marginUsed: '100', unrealizedPnl: '0',
    leverage: { value: 20 }, cumFunding: { sinceOpen },
  });
  const raw: HlClearinghouseState = {
    marginSummary: { accountValue: '1' }, crossMaintenanceMarginUsed: '0', withdrawable: '0', time: 1,
    assetPositions: [{ position: position('0.0') }, { position: position('3.5') }],
  };
  const [flat, paid] = parseAccount('0xabc', raw).positions;
  assert.ok(Object.is(flat!.fundingSinceOpenUsd, 0));
  assert.equal(flat!.liqPx, 1500);
  assert.equal(paid!.fundingSinceOpenUsd, -3.5);
});

test('a funding row keeps the venue sign (received > 0) and the dex prefix', () => {
  const row = (coin: string, usdc: string, nSamples: number | null): HlFundingRow => ({
    time: 1793386800065, hash: '0x00', delta: { type: 'funding', coin, usdc, szi: '-2500.0', fundingRate: '0.0000125', nSamples },
  });
  assert.deepEqual(parseFundingRow(row('HYPE', '2.803734', null)), {
    time: 1793386800065, symbol: 'HYPE', fundingUsd: 2.803734, size: -2500, ratePerHour: 0.0000125, samples: null,
  });
  assert.equal(parseFundingRow(row('xyz:NVDA', '-7.5', 24)).fundingUsd, -7.5);
  assert.equal(parseFundingRow(row('xyz:NVDA', '-7.5', 24)).symbol, 'xyz:NVDA');
  assert.equal(parseFundingRow(row('xyz:NVDA', '-7.5', 24)).samples, 24);
  assert.throws(() => parseFundingRow(row('ETH', 'n/a', null)), /usdc is not a number/);
});

function fakeFetch(answer: (body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const calls: Record<string, unknown>[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    const a = answer(body);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

test('reader posts the documented info requests', async () => {
  const { f, calls } = fakeFetch((b) => ({ json: b.type === 'l2Book' ? BOOK : b.type === 'meta' ? META_AND_CTXS[0] : META_AND_CTXS }));
  const clock = new VirtualClock(Date.UTC(2026, 9, 30, 16, 5));
  const hl = new HyperliquidReader({ fetch: f, clock });
  assert.equal((await hl.markets()).length, 3);
  assert.equal((await hl.funding())[0]!.nextAt, Date.UTC(2026, 9, 30, 17));
  const book = await hl.book('ETH', 1);
  assert.equal(book.bids.length, 1);
  assert.equal(book.asks.length, 1);
  assert.deepEqual(calls, [{ type: 'meta' }, { type: 'metaAndAssetCtxs' }, { type: 'l2Book', coin: 'ETH' }]);
});

test('reader turns HTTP errors, unknown coins and bad addresses into errors', async () => {
  const { f } = fakeFetch((b) => (b.type === 'l2Book' ? { status: 500, json: null } : { status: 429, json: 'rate limited' }));
  const hl = new HyperliquidReader({ fetch: f });
  await assert.rejects(hl.funding(), /HTTP 429/);
  await assert.rejects(hl.book('NOPE'), /unknown coin NOPE/);
  await assert.rejects(hl.account('not-an-address'), /not an EVM address/);
});

test('an unknown coin answered as HTTP 200 null is refused too; another 500 stays an HTTP error', async () => {
  const unknown = new HyperliquidReader({ fetch: fakeFetch(() => ({ json: null })).f });
  await assert.rejects(unknown.book('NOPE'), /unknown coin NOPE/);
  const outage = new HyperliquidReader({ fetch: fakeFetch(() => ({ status: 500, json: 'internal error' })).f });
  await assert.rejects(outage.book('ETH'), (err: unknown) => err instanceof HlHttpError && err.status === 500 && /HTTP 500/.test(err.message));
});

test('the network option picks the endpoint, and url overrides it', async () => {
  const urls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(META_AND_CTXS[0]));
  }) as typeof fetch;
  assert.equal(new HyperliquidReader({ fetch: f }).network, 'mainnet');
  await new HyperliquidReader({ fetch: f }).markets();
  await new HyperliquidReader({ fetch: f, network: 'mainnet' }).markets();
  const testnet = new HyperliquidReader({ fetch: f, network: 'testnet' });
  await testnet.markets();
  await new HyperliquidReader({ fetch: f, network: 'testnet', url: 'http://localhost:9/info' }).markets();
  assert.deepEqual(urls, [HL_MAINNET_INFO_URL, HL_MAINNET_INFO_URL, HL_TESTNET_INFO_URL, 'http://localhost:9/info']);
  assert.equal(HL_MAINNET_INFO_URL, 'https://api.hyperliquid.xyz/info');
  assert.equal(HL_TESTNET_INFO_URL, 'https://api.hyperliquid-testnet.xyz/info');
  assert.equal(testnet.network, 'testnet');
  assert.equal(testnet.infoUrl, HL_TESTNET_INFO_URL);
});

// A stand-in for the venue's userFunding: ascending rows, startTime and endTime inclusive, 500 rows at most.
function fundingServer(history: HlFundingRow[]) {
  return fakeFetch((b) => {
    assert.equal(b.type, 'userFunding');
    const from = b.startTime as number;
    const to = (b.endTime as number | undefined) ?? Infinity;
    return { json: history.filter((r) => r.time >= from && r.time <= to).slice(0, 500) };
  });
}

function fundingRow(time: number, coin: string, usdc = '-1', type = 'funding'): HlFundingRow {
  return { time, hash: '0x00', delta: { type, coin, usdc, szi: '10', fundingRate: '0.0000125', nSamples: null } };
}

const ADDR = '0x54131C9BB91864AA922473D7E4A32D15B3BE8B6A';
const T0 = Date.UTC(2026, 9, 1);
const HOUR = 3_600_000;

test('userFunding sends the lowercased address and the window, and returns payments oldest first', async () => {
  const history = [fundingRow(T0, 'BTC', '-2.5'), fundingRow(T0, 'ETH', '1.25'), fundingRow(T0 + HOUR, 'BTC', '-2.75')];
  const { f, calls } = fundingServer(history);
  const hl = new HyperliquidReader({ fetch: f });
  const all = await hl.userFunding(ADDR, 0);
  assert.deepEqual(calls, [{ type: 'userFunding', user: ADDR.toLowerCase(), startTime: 0 }]);
  assert.deepEqual(all.map((p) => [p.time, p.symbol, p.fundingUsd]), [[T0, 'BTC', -2.5], [T0, 'ETH', 1.25], [T0 + HOUR, 'BTC', -2.75]]);

  const windowed = await hl.userFunding(ADDR, T0, T0);
  assert.deepEqual(calls[1], { type: 'userFunding', user: ADDR.toLowerCase(), startTime: T0, endTime: T0 });
  assert.equal(windowed.length, 2);
  assert.deepEqual(await hl.userFunding(ADDR, T0 + 5 * HOUR), []);
});

test('userFunding keeps rows that share the timestamp a page was cut at, and rows seen twice only once', async () => {
  // 3 coins every hour for 400 hours: 1200 rows, so three pages, and the 500-row cut falls inside an hour.
  const history: HlFundingRow[] = [];
  for (let h = 0; h < 400; h++) for (const coin of ['BTC', 'ETH', 'HYPE']) history.push(fundingRow(T0 + h * HOUR, coin, String(h)));
  const { f, calls } = fundingServer(history);
  const rows = await new HyperliquidReader({ fetch: f }).userFunding(ADDR, 0);
  assert.equal(rows.length, 1200);
  assert.deepEqual(rows.map((r) => [r.time, r.symbol]), history.map((r) => [r.time, r.delta.coin]));
  assert.ok(calls.length >= 3);
  // The first cut is mid-hour (500 = 166 hours of 3 rows + 2): page two must start at that hour, not after it.
  assert.equal(calls[1]!.startTime, T0 + 166 * HOUR);
});

test('userFunding ignores row types it does not know and refuses malformed rows', async () => {
  const mixed = [fundingRow(T0, 'BTC'), fundingRow(T0 + HOUR, 'BTC', '-1', 'somethingNew')];
  const rows = await new HyperliquidReader({ fetch: fundingServer(mixed).f }).userFunding(ADDR, 0);
  assert.deepEqual(rows.map((r) => r.time), [T0]);
  const broken = new HyperliquidReader({ fetch: fakeFetch(() => ({ json: [{ time: 1 }] })).f });
  await assert.rejects(broken.userFunding(ADDR, 0), /malformed row/);
  const notAList = new HyperliquidReader({ fetch: fakeFetch(() => ({ json: { error: 'x' } })).f });
  await assert.rejects(notAList.userFunding(ADDR, 0), /expected a list/);
});

test('userFunding stops instead of looping when paging cannot advance or never ends', async () => {
  // 500 rows at one timestamp, returned again and again: nothing new to page past.
  const stuck = Array.from({ length: 500 }, (_, i) => fundingRow(T0, `C${i}`));
  await assert.rejects(
    new HyperliquidReader({ fetch: fakeFetch(() => ({ json: stuck })).f }).userFunding(ADDR, 0),
    /500 rows share one timestamp/,
  );
  // Always 500 fresh rows: the page cap ends it.
  let served = 0;
  const endless = fakeFetch(() => {
    const rows = Array.from({ length: 500 }, (_, i) => fundingRow(T0 + (served * 500 + i) * 1000, 'BTC'));
    served++;
    return { json: rows };
  });
  await assert.rejects(new HyperliquidReader({ fetch: endless.f }).userFunding(ADDR, 0), /after 100 pages/);
  assert.equal(served, 100);
});

test('userFunding refuses bad arguments before asking the venue', async () => {
  const { f, calls } = fundingServer([]);
  const hl = new HyperliquidReader({ fetch: f });
  await assert.rejects(hl.userFunding('0xabc', 0), /not an EVM address/);
  await assert.rejects(hl.userFunding(ADDR, -1), RangeError);
  await assert.rejects(hl.userFunding(ADDR, 1.5), RangeError);
  await assert.rejects(hl.userFunding(ADDR, Number.NaN), RangeError);
  await assert.rejects(hl.userFunding(ADDR, 100, 99), RangeError);
  assert.equal(calls.length, 0);
});
