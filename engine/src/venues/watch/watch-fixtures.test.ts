// Runs every watch reader against what its venue really answered: one sweep recorded with
// `npm run capture -w engine -- --venue watch` (fixtures/watch-wire/), replayed through replayFetch, so a reader
// that changes what it asks fails here. Each venue's checks pin a market's values to the raw recorded fields.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { WireLine } from '../recorder.ts';
import { VirtualClock, readWireRecording, replayFetch } from '../replay.ts';
import type { MarketFunding } from '../venue.ts';
import { WatchVenueError } from './http.ts';
import { WATCH_VENUE_IDS, watchReaders } from './index.ts';
import { HOUR_MS, nextBoundary } from './units.ts';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/watch-wire/watch-mainnet-2026-10-31.jsonl.gz', import.meta.url));
const LINES = readWireRecording(FIXTURE);
const T0 = LINES[0]!.t;                   // 2026-10-31T02:09:17Z
const NEXT_HOUR = nextBoundary(T0, 1);
const NEXT_8H = 1_793_433_600_000;        // 2026-10-31T08:00:00Z

function replayed(lines: readonly WireLine[] = LINES) {
  const clock = new VirtualClock(T0);
  const calls: string[] = [];
  const replay = replayFetch(lines);
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)} ${typeof init?.body === 'string' ? init.body : ''}`.trim());
    return replay(input, init);
  };
  const readers = new Map(watchReaders({ fetch, clock }).map((r) => [r.id, r]));
  return { clock, calls, readers, reader: (id: string) => readers.get(id)! };
}

async function marketsOf(id: string): Promise<MarketFunding[]> {
  return replayed().reader(id).funding();
}

function market(markets: readonly MarketFunding[], symbol: string): MarketFunding {
  const m = markets.find((f) => f.symbol === symbol);
  assert.ok(m !== undefined, `no ${symbol}`);
  return m;
}

function close(actual: number | null | undefined, expected: number, what = 'value'): void {
  assert.ok(typeof actual === 'number', `${what}: ${actual} is not a number`);
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-9 + 1e-18, `${what}: ${actual} != ${expected}`);
}

test('watchReaders: one reader per venue id, lowercase, DEX first, in WATCH_VENUE_IDS order', () => {
  const readers = watchReaders();
  assert.deepEqual(readers.map((r) => r.id), [...WATCH_VENUE_IDS]);
  assert.equal(new Set(readers.map((r) => r.id)).size, 23);
  for (const r of readers) assert.match(r.id, /^[a-z0-9-]+$/);
  assert.deepEqual(readers.map((r) => r.kind), [...Array(14).fill('dex'), ...Array(9).fill('cex')]);
});

// Markets per venue in the recorded sweep (live perps only; see each reader for what is left out).
const COUNTS: Record<string, number> = {
  'hl-xyz': 120, 'hl-para': 33, 'hl-mkts': 1, 'hl-io': 12, pacifica: 78, lighter: 213, extended: 339, paradex: 66,
  aster: 575, dydx: 57, nado: 82, aevo: 102, variational: 563, 'gmx-arbitrum': 103,
  binance: 189, bybit: 186, okx: 517, bitget: 868, gate: 1066, kucoin: 695, mexc: 1091, kraken: 209, backpack: 91,
};

test('every reader answers from the recording, and every market is well formed', async () => {
  const { readers } = replayed();
  for (const [id, reader] of readers) {
    const markets = await reader.funding();
    assert.equal(markets.length, COUNTS[id], `${id} market count`);
    assert.equal(new Set(markets.map((m) => m.symbol)).size, markets.length, `${id}: a symbol twice`);
    for (const m of markets) {
      const where = `${id} ${m.symbol}`;
      assert.equal(m.venue, id, where);
      assert.ok(Number.isFinite(m.ratePerHour) && Math.abs(m.ratePerHour) < 0.01, `${where}: rate ${m.ratePerHour} per hour`);
      assert.ok(m.nextAt >= T0 - 60_000 && m.nextAt <= T0 + 24 * HOUR_MS + 60_000, `${where}: nextAt ${m.nextAt}`);
      assert.ok(m.markPx === null || m.markPx > 0, `${where}: mark ${m.markPx}`);
      assert.ok(m.oraclePx === null || m.oraclePx > 0, `${where}: oracle ${m.oraclePx}`);
      assert.ok(m.openInterest === null || m.openInterest >= 0, `${where}: OI ${m.openInterest}`);
      assert.ok(typeof m.base === 'string' && m.base !== '' && m.base === m.base.toUpperCase(), `${where}: base ${m.base}`);
      assert.ok(m.multiplier === undefined || (m.multiplier > 0 && m.multiplier !== 1), `${where}: multiplier ${m.multiplier}`);
      if (m.shortRatePerHour !== undefined) assert.ok(Number.isFinite(m.shortRatePerHour), where);
    }
  }
});

test('hl-xyz: funding per hour from the dex context; xyz:TSLA is base TSLA', async () => {
  const markets = await marketsOf('hl-xyz');
  const tsla = market(markets, 'xyz:TSLA');
  assert.deepEqual(
    { rate: tsla.ratePerHour, mark: tsla.markPx, oi: tsla.openInterest, base: tsla.base, multiplier: tsla.multiplier, settlement: tsla.settlement, nextAt: tsla.nextAt },
    { rate: 0.0000006905, mark: 399.55, oi: 99274.868, base: 'TSLA', multiplier: undefined, settlement: 'hourly', nextAt: NEXT_HOUR },
  );
  assert.ok(markets.every((m) => m.symbol.startsWith('xyz:')));
});

test('hl-mkts: the delisted markets (US500 among them) are left out, BVIV is the one live market', async () => {
  const markets = await marketsOf('hl-mkts');
  assert.deepEqual(markets.map((m) => m.symbol), ['mkts:BVIV']);
  for (const id of ['hl-para', 'hl-io']) {
    const prefix = `${id.slice(3)}:`;
    assert.ok((await marketsOf(id)).every((m) => m.symbol.startsWith(prefix) && m.base === m.symbol.slice(prefix.length).toUpperCase()), id);
  }
});

test('pacifica: next_funding per hour, perps only (the SOL-USDC spot market is left out)', async () => {
  const markets = await marketsOf('pacifica');
  const btc = market(markets, 'BTC');
  assert.deepEqual(
    { rate: btc.ratePerHour, mark: btc.markPx, oracle: btc.oraclePx, oi: btc.openInterest, vol: btc.volume24hUsd, nextAt: btc.nextAt },
    { rate: 0.0000125, mark: 77369, oracle: 77376.270945, oi: 457.66821, vol: 432236866.26896, nextAt: NEXT_HOUR },
  );
  assert.equal(markets.find((m) => m.symbol === 'SOL-USDC'), undefined);
  assert.deepEqual([market(markets, 'kPEPE').base, market(markets, 'kPEPE').multiplier], ['PEPE', 1000]);
});

test('lighter: its own rows only, the 8 h-scaled rate over 8; OI is one side in base units', async () => {
  const markets = await marketsOf('lighter');
  const btc = market(markets, 'BTC');
  close(btc.ratePerHour, 0.000096 / 8, 'BTC rate');
  assert.equal(btc.settlement, 'hourly');
  assert.ok(btc.openInterest !== null && btc.openInterest > 0);
  assert.equal(markets.filter((m) => m.base === 'BTC').length, 1);   // the binance/bybit/hyperliquid copies are not markets
});

test('extended: hourly rate; nextFundingRate is the next settlement time', async () => {
  const btc = market(await marketsOf('extended'), 'BTC-USD');
  assert.deepEqual(
    { rate: btc.ratePerHour, nextAt: btc.nextAt, oi: btc.openInterest, base: btc.base },
    { rate: 0.000013, nextAt: 1_793_415_600_000, oi: 546.09938, base: 'BTC' },
  );
});

test('paradex: the 8 h rate over 8, accrued continuously; OI is the long side', async () => {
  const btc = market(await marketsOf('paradex'), 'BTC-USD-PERP');
  close(btc.ratePerHour, 0.000096914903 / 8, 'BTC rate');
  assert.deepEqual({ settlement: btc.settlement, nextAt: btc.nextAt, oi: btc.openInterest, base: btc.base }, { settlement: 'continuous', nextAt: T0, oi: 30.41976, base: 'BTC' });
});

test('aster: lastFundingRate over the fundingInfo interval; no open interest in the bulk answers', async () => {
  const markets = await marketsOf('aster');
  const btc = market(markets, 'BTCUSDT');
  assert.deepEqual(
    { rate: btc.ratePerHour, settlement: btc.settlement, nextAt: btc.nextAt, oi: btc.openInterest, base: btc.base },
    { rate: 0.0000125, settlement: '8h', nextAt: NEXT_8H, oi: null, base: 'BTC' },
  );
  assert.equal(new Set(markets.map((m) => m.base)).size, markets.length, 'one market per base');
});

test('dydx: nextFundingRate per hour, active markets only', async () => {
  const btc = market(await marketsOf('dydx'), 'BTC-USD');
  assert.deepEqual(
    { rate: btc.ratePerHour, mark: btc.markPx, oi: btc.openInterest, settlement: btc.settlement },
    { rate: 0.00003933333333333333, mark: 77259.29999, oi: 229.589, settlement: 'hourly' },
  );
});

test('nado: the 24 h rate over 24; OI is the long side', async () => {
  const btc = market(await marketsOf('nado'), 'BTC-PERP_USDT0');
  close(btc.ratePerHour, 0.0000125, 'BTC rate');
  assert.deepEqual({ oi: btc.openInterest, base: btc.base, settlement: btc.settlement }, { oi: 134.1885, base: 'BTC', settlement: 'hourly' });
});

test('aevo: rate per 60 min interval; OI is the long side', async () => {
  const btc = market(await marketsOf('aevo'), 'BTC-PERP');
  assert.deepEqual({ rate: btc.ratePerHour, oi: btc.openInterest, base: btc.base }, { rate: 0.000012, oi: 27.675, base: 'BTC' });
});

test('variational: the annualised rate over 8760; OI is the mean of long and short USD over the mark', async () => {
  const btc = market(await marketsOf('variational'), 'BTC-PERP');
  close(btc.ratePerHour, 0.1095 / 8760, 'BTC rate');
  close(btc.openInterest, (89919613.4921712 + 72993228.9105248) / 2 / 77247.9789884706, 'BTC OI');
  assert.deepEqual({ settlement: btc.settlement, nextAt: btc.nextAt, oracle: btc.oraclePx }, { settlement: '8h', nextAt: NEXT_8H, oracle: null });
});

test('gmx-arbitrum: per-side net rates (funding + borrow); the largest pool stands for its index', async () => {
  const markets = await marketsOf('gmx-arbitrum');
  const btc = markets.find((m) => m.base === 'BTC')!;
  assert.equal(btc.symbol, 'BTC/USD [WBTC.b-USDC]');
  close(btc.ratePerHour, 0.243203914504095 / 8760, 'what a long pays');
  close(btc.shortRatePerHour, 0.207003189198101 / 8760, 'what a short receives');
  assert.equal(btc.settlement, 'continuous');
  close(btc.openInterest! * btc.markPx!, (8834759.669622406 + 8720945.069508544) / 2, 'one side of OI in USD');
  assert.equal(new Set(markets.map((m) => m.base)).size, markets.length, 'one market per index');
});

test('binance and bybit: Hyperliquid predictedFundings, one call for both, no marks or OI', async () => {
  const { reader, calls } = replayed();
  const [binance, bybit] = await Promise.all([reader('binance').funding(), reader('bybit').funding()]);
  assert.equal(calls.filter((c) => c.includes('predictedFundings')).length, 1);
  const bin = market(binance, 'BTC');
  assert.deepEqual(
    { rate: bin.ratePerHour, settlement: bin.settlement, nextAt: bin.nextAt, mark: bin.markPx, oi: bin.openInterest },
    { rate: 0.0000125, settlement: '8h', nextAt: NEXT_8H, mark: null, oi: null },
  );
  close(market(bybit, 'BTC').ratePerHour, 0.00004721 / 8, 'bybit BTC rate');
  assert.deepEqual([market(binance, 'kPEPE').base, market(binance, 'kPEPE').multiplier], ['PEPE', 1000]);
  close(market(binance, 'kPEPE').ratePerHour, -0.00014321 / 8, 'binance kPEPE rate');
});

test('okx: USDT swaps only, the running period rate over fundingTime - prevFundingTime; OI in coins', async () => {
  const markets = await marketsOf('okx');
  const btc = market(markets, 'BTC-USDT-SWAP');
  close(btc.ratePerHour, 0.0000940656710475 / 8, 'BTC rate');
  assert.deepEqual({ settlement: btc.settlement, nextAt: btc.nextAt, oi: btc.openInterest, base: btc.base }, { settlement: '8h', nextAt: NEXT_8H, oi: 34820.6445000002115, base: 'BTC' });
  assert.ok(markets.every((m) => m.symbol.endsWith('-USDT-SWAP')));
});

test('bitget: rate over current-fund-rate interval; holdingAmount is OI in coins', async () => {
  const btc = market(await marketsOf('bitget'), 'BTCUSDT');
  assert.deepEqual(
    { rate: btc.ratePerHour, settlement: btc.settlement, nextAt: btc.nextAt, oi: btc.openInterest },
    { rate: 0.0000125, settlement: '8h', nextAt: NEXT_8H, oi: 37384.6980999999275 },
  );
});

test('gate: rate over funding_interval seconds; OI is position_size x quanto_multiplier', async () => {
  const btc = market(await marketsOf('gate'), 'BTC_USDT');
  assert.deepEqual({ rate: btc.ratePerHour, settlement: btc.settlement, nextAt: btc.nextAt }, { rate: 0.0000125, settlement: '8h', nextAt: NEXT_8H });
  close(btc.openInterest, 295180136 * 0.0001, 'BTC OI');
});

test('kucoin: USDT linear contracts; XBT is BTC; OI is lots x multiplier', async () => {
  const markets = await marketsOf('kucoin');
  const btc = market(markets, 'XBTUSDTM');
  assert.deepEqual({ rate: btc.ratePerHour, settlement: btc.settlement, nextAt: btc.nextAt, base: btc.base }, { rate: 0.0000125, settlement: '8h', nextAt: NEXT_8H, base: 'BTC' });
  close(btc.openInterest, 9910224 * 0.001, 'BTC OI');
  assert.deepEqual([market(markets, '1000BONKUSDTM').base, market(markets, '1000BONKUSDTM').multiplier], ['BONK', 1000]);
});

test('mexc: enabled _USDT contracts; OI is holdVol x contractSize', async () => {
  const markets = await marketsOf('mexc');
  const btc = market(markets, 'BTC_USDT');
  assert.deepEqual({ rate: btc.ratePerHour, settlement: btc.settlement, nextAt: btc.nextAt, mark: btc.markPx }, { rate: 0.0000125, settlement: '8h', nextAt: NEXT_8H, mark: 77359.8 });
  close(btc.openInterest, 586695559 * 0.0001, 'BTC OI');
  assert.ok(markets.some((m) => m.settlement === 'daily'), 'MEXC has a 24 h contract');
});

test('kraken: PF_ perpetuals, relativeFundingRate per hour, XBT is BTC', async () => {
  const btc = market(await marketsOf('kraken'), 'PF_XBTUSD');
  assert.deepEqual(
    { rate: btc.ratePerHour, base: btc.base, oi: btc.openInterest, settlement: btc.settlement, nextAt: btc.nextAt },
    { rate: 0.00002016405, base: 'BTC', oi: 2686.0845, settlement: 'hourly', nextAt: NEXT_HOUR },
  );
});

test('backpack: open perps, rate over the market fundingInterval, the venue next funding time', async () => {
  const btc = market(await marketsOf('backpack'), 'BTC_USDC_PERP');
  assert.deepEqual(
    { rate: btc.ratePerHour, base: btc.base, settlement: btc.settlement, nextAt: btc.nextAt, mark: btc.markPx },
    { rate: 0.0000125, base: 'BTC', settlement: 'hourly', nextAt: 1_793_415_600_000, mark: 77267.4 },
  );
});

test('a sweep is 1-3 calls per venue: listing data is cached for 10 minutes', async () => {
  const { clock, calls, readers } = replayed();
  const sweep = async () => {
    calls.length = 0;
    await Promise.all([...readers.values()].map((r) => r.funding()));
    const per = new Map<string, number>();
    for (const c of calls) {
      const host = new URL(c.split(' ')[1]!).host;
      per.set(host, (per.get(host) ?? 0) + 1);
    }
    return per;
  };
  const first = await sweep();
  clock.advance(60_000);
  const second = await sweep();
  // Aster's exchangeInfo + fundingInfo, MEXC's detail, Backpack's markets, GMX's tokens, Pacifica's info are cached.
  assert.equal(first.get('fapi.asterdex.com'), 4);
  assert.equal(second.get('fapi.asterdex.com'), 2);
  assert.equal(second.get('contract.mexc.com'), 2);
  assert.equal(second.get('api.backpack.exchange'), 3);
  assert.equal(second.get('arbitrum-api.gmxinfra.io'), 2);
  assert.equal(second.get('api.pacifica.fi'), 1);
  assert.equal(second.get('api.hyperliquid.xyz'), 5);       // 4 dexes + one predictedFundings for binance and bybit
  for (const [host, n] of second) if (host !== 'api.hyperliquid.xyz') assert.ok(n <= 3, `${host}: ${n} calls`);
  clock.advance(10 * 60_000);
  assert.equal((await sweep()).get('fapi.asterdex.com'), 4, 'listing data is re-read after 10 minutes');
});

// A venue that is down, blocked or changed must make funding() throw, never answer an empty or zeroed list.
async function failsWith(fetch: typeof globalThis.fetch, pattern: RegExp): Promise<void> {
  for (const reader of watchReaders({ fetch, clock: new VirtualClock(T0), timeoutMs: 50 })) {
    await assert.rejects(reader.funding(), (err: unknown) => {
      assert.ok(err instanceof WatchVenueError, `${reader.id}: ${String(err)}`);
      assert.equal(err.venue, reader.id);
      assert.match(err.message, pattern, reader.id);
      return true;
    });
  }
}

const answer = (body: string, status = 200, type = 'application/json') => async () => new Response(body, { status, headers: { 'content-type': type } });

test('a WAF or region page (HTML) is a clear error naming the venue', async () => {
  await failsWith(answer('<!DOCTYPE html><html><head><title>Access denied | api</title></head><body>blocked</body></html>', 403, 'text/html'), /HTML page \("Access denied \| api"\).*blocked, region page or maintenance/);
  await failsWith(answer('<html><body>Service unavailable in your region</body></html>', 200, 'text/html'), /HTML page, not market data/);
});

test('an error status, an empty or reshaped answer, and no answer are errors too', async () => {
  await failsWith(answer('{"error":"maintenance"}', 503), /HTTP 503/);
  await failsWith(answer('[]'), /no live market|not an object|code|success|result|not a list/);
  await failsWith(answer('{}'), /no live market|not a list|not an object|code|success|result/);
  await failsWith(async () => { throw new TypeError('fetch failed'); }, /request to https:\/\/.+ failed: fetch failed/);
  const hang: typeof globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  });
  await failsWith(hang, /no answer within 50 ms/);
});

test('a replay miss surfaces: a reader that asks for something else fails its fixture', async () => {
  const lines = LINES.filter((l) => !l.url.includes('kraken'));
  await assert.rejects(replayed(lines).reader('kraken').funding(), /WatchVenueError: kraken: request to https:\/\/futures\.kraken\.com\/\S+ failed: replay: nothing recorded/);
});

