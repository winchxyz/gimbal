import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HlClearinghouseState, HlL2Book, HlMetaAndAssetCtxs } from './hyperliquid.ts';
import { HyperliquidReader, parseAccount, parseBook, parseFunding, parseMarkets } from './hyperliquid.ts';
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
  const { f, calls } = fakeFetch((b) => ({ json: b.type === 'l2Book' ? BOOK : META_AND_CTXS }));
  const clock = new VirtualClock(Date.UTC(2026, 9, 30, 16, 5));
  const hl = new HyperliquidReader({ fetch: f, clock });
  assert.equal((await hl.markets()).length, 3);
  assert.equal((await hl.funding())[0]!.nextAt, Date.UTC(2026, 9, 30, 17));
  const book = await hl.book('ETH', 1);
  assert.equal(book.bids.length, 1);
  assert.equal(book.asks.length, 1);
  assert.deepEqual(calls, [{ type: 'metaAndAssetCtxs' }, { type: 'metaAndAssetCtxs' }, { type: 'l2Book', coin: 'ETH' }]);
});

test('reader turns HTTP errors, unknown coins and bad addresses into errors', async () => {
  const { f } = fakeFetch((b) => (b.type === 'l2Book' ? { json: null } : { status: 429, json: 'rate limited' }));
  const hl = new HyperliquidReader({ fetch: f });
  await assert.rejects(hl.funding(), /HTTP 429/);
  await assert.rejects(hl.book('NOPE'), /unknown coin NOPE/);
  await assert.rejects(hl.account('not-an-address'), /not an EVM address/);
});
