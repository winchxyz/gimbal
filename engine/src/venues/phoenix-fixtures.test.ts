// Runs PhoenixReader against what the live API really answered (fixtures/phoenix-wire/*.jsonl.gz, captured with
// `npm run capture -w engine -- --venue phoenix`), through the SDK's own schemas. The trader is a public market
// maker picked from the SOL book's splines: authority EibQ2VYpzj18qSdEBkmxWVzde7FzamTxVG9rZyY689Yj, trader PDA 0,
// whose subaccount-0 trader key is FDgug8gKV65UxsCb1C3yfob1qSXz93n3fkuJCascymJb. The capture holds the venue's own
// computed view of that trader at the same slot as the snapshot, so the margin math is checked against Phoenix's.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ExchangeMarketConfig, FundingOverviewResponse, TraderStateSnapshotResponse } from '@ellipsis-labs/rise';
import { FetchTransport, PhoenixReader, parseAccount, parseFunding } from './phoenix.ts';
import type { PhoenixPosition } from './phoenix.ts';
import type { WireLine } from './recorder.ts';
import { ReplayMissError, VirtualClock, readWireRecording, replayFetch } from './replay.ts';

const DIR = fileURLToPath(new URL('../../fixtures/phoenix-wire/', import.meta.url));
const LINES = readWireRecording(join(DIR, 'phoenix-mainnet-2026-10-31.jsonl.gz'));
const AUTHORITY = 'EibQ2VYpzj18qSdEBkmxWVzde7FzamTxVG9rZyY689Yj';
const OCT_11 = Date.UTC(2026, 9, 11);
const OCT_20 = Date.UTC(2026, 9, 20);
const OCT_31 = Date.UTC(2026, 9, 31);
const AT = LINES[0]!.t;

function response<T>(pathPart: string): T {
  const found = LINES.filter((l) => l.url.includes(pathPart));
  assert.ok(found.length >= 1, `nothing recorded for ${pathPart}`);
  return found[0]!.response as T;
}

function readerOver(lines: WireLine[] = LINES) {
  const replay = replayFetch(lines);
  const urls: string[] = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    return replay(input, init);
  }) as typeof fetch;
  return { reader: new PhoenixReader({ fetch: f, clock: new VirtualClock(AT) }), urls };
}

interface Amount { value: number; decimals: number; ui: string }
interface ViewPosition {
  symbol: string; positionSize: Amount; positionValue: Amount; unrealizedPnl: Amount; positionInitialMargin: Amount;
  maintenanceMargin: Amount; unsettledFunding: Amount; accumulatedFunding: Amount; liquidationPrice: Amount;
}
interface View {
  traderSubaccountIndex: number; slot: number; portfolioValue: Amount; maintenanceMargin: Amount;
  withdrawableQuoteCollateral: Amount; positions: ViewPosition[];
}

test('markets: SOL, ETH, BTC and kPEPE in USD and base units, with the policy fields', async () => {
  const { reader } = readerOver();
  const markets = await reader.markets();
  assert.equal(markets.length, 104);
  const by = new Map(markets.map((m) => [m.symbol, m]));
  assert.deepEqual(
    { ...by.get('SOL')!, orderbook: by.get('SOL')!.orderbook.length },
    {
      venue: 'phoenix', symbol: 'SOL', assetIndex: 0, szDecimals: 2, lotSize: 0.01, tickSize: 0.01, maxPxDecimals: 2,
      maxLeverage: 25, isolatedOnly: false, delisted: false, orderbook: 44, takerFee: 0.00035, makerFee: 0.00005,
    },
  );
  assert.equal(by.get('SOL')!.orderbook, '71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2');
  assert.deepEqual([by.get('ETH')!.lotSize, by.get('ETH')!.tickSize, by.get('ETH')!.maxLeverage], [0.001, 0.1, 25]);
  assert.deepEqual([by.get('BTC')!.lotSize, by.get('BTC')!.tickSize, by.get('BTC')!.maxLeverage], [0.0001, 1, 40]);
  // A k-market counts in lots of 100 units with a micro-dollar tick.
  assert.deepEqual([by.get('kPEPE')!.szDecimals, by.get('kPEPE')!.lotSize, by.get('kPEPE')!.tickSize, by.get('kPEPE')!.maxPxDecimals], [-2, 100, 0.000001, 6]);
});

test('funding: fundingAmountPerUnit / markPrice of the last booked hour, never the API fundingRate; zero prints kept', async () => {
  const { reader } = readerOver();
  await reader.markets();
  const funding = await reader.funding();
  assert.equal(funding.length, 104);
  const overview = response<FundingOverviewResponse>('/v1/funding/overview');
  const solPoint = overview.series.find((s) => s.symbol === 'SOL')!.points.at(-1)!;
  const sol = funding.find((f) => f.symbol === 'SOL')!;
  assert.equal(sol.ratePerHour, Number(solPoint.fundingAmountPerUnit) / Number(solPoint.markPrice));
  assert.ok(Math.abs(sol.ratePerHour - 0.0000207533) < 1e-10);
  // The API's own fundingRate field is on another scale (it is not the hourly fraction).
  assert.notEqual(Number(solPoint.fundingRate), sol.ratePerHour);
  assert.equal(sol.settlement, 'daily');
  assert.equal(sol.nextAt, Date.UTC(2026, 9, 31, 1));               // the next full hour after the capture
  assert.equal(sol.markPx, 96.3);
  assert.ok(sol.oraclePx! > 90 && sol.openInterest! > 1000 && sol.volume24hUsd! > 1e6);
  const zero = funding.filter((f) => f.ratePerHour === 0).map((f) => f.symbol);
  assert.ok(zero.length > 0, 'some coarse markets print a zero hour');
  for (const f of funding) assert.ok(Number.isFinite(f.ratePerHour) && Math.abs(f.ratePerHour) < 0.01, `${f.symbol} ${f.ratePerHour}`);
});

test('funding leaves out markets that are not active and markets with no booked hour yet', () => {
  const configs = response<ExchangeMarketConfig[]>('/v1/view/exchange/markets');
  const sol = configs.find((c) => c.symbol === 'SOL')!;
  const eth = configs.find((c) => c.symbol === 'ETH')!;
  const overview: FundingOverviewResponse = {
    series: [
      { marketId: 1, symbol: 'SOL', points: [{ timestamp: 1, fundingAmountPerUnit: '0.01', markPrice: '100', fundingRate: '9' }] },
      { marketId: 2, symbol: 'ETH', points: [] },
      { marketId: 3, symbol: 'NEW', points: [{ timestamp: 1, fundingAmountPerUnit: '1', markPrice: '1', fundingRate: '1' }] },
    ],
  };
  const out = parseFunding(overview, { markets: [] }, [{ ...sol, marketStatus: 'closeOnly' }, eth], 0);
  assert.deepEqual(out, []);
  const active = parseFunding(overview, { markets: [] }, [sol], 0);
  assert.equal(active.length, 1);
  assert.equal(active[0]!.ratePerHour, 0.0001);
  assert.equal(active[0]!.markPx, null);
});

test('book: USD prices and base sizes, best first, stamped with the arrival time; unknown symbols say so', async () => {
  const { reader } = readerOver();
  const book = await reader.book('SOL', 5);
  assert.equal(book.venue, 'phoenix');
  assert.equal(book.time, AT);
  assert.equal(book.bids.length, 5);
  assert.equal(book.asks.length, 5);
  assert.ok(book.bids[0]!.px < book.asks[0]!.px);
  for (let i = 1; i < 5; i++) {
    assert.ok(book.bids[i]!.px < book.bids[i - 1]!.px);
    assert.ok(book.asks[i]!.px > book.asks[i - 1]!.px);
  }
  const full = await reader.book('BTC');
  assert.ok(full.bids.length > 5);
  await assert.rejects(reader.book('NOT_A_COIN'), /phoenix orderbook: unknown symbol NOT_A_COIN/);
  await assert.rejects(reader.book('DOGE'), ReplayMissError);         // nothing recorded: the replay refuses
});

test('account: the SDK margin engine at the view\'s own marks matches Phoenix\'s computed view of subaccount 0', () => {
  const configs = response<ExchangeMarketConfig[]>('/v1/view/exchange/markets');
  const snapshot = response<TraderStateSnapshotResponse>('/v1/trader/state/');
  const view = response<View>('/v1/view/trader/');
  assert.equal(view.slot, snapshot.slot, 'the view and the snapshot are of the same slot');
  assert.equal(view.traderSubaccountIndex, 0);
  const ui = (a: Amount) => Number(a.ui);
  // The marks the view priced at: |position value| / |size|.
  const marks = new Map(view.positions.map((p) => [p.symbol, Math.abs(ui(p.positionValue)) / Math.abs(ui(p.positionSize))]));
  const sub0 = { ...snapshot, snapshot: { ...snapshot.snapshot, subaccounts: snapshot.snapshot.subaccounts.filter((s) => s.subaccountIndex === 0) } };
  const account = parseAccount(sub0, configs, marks, 1);
  assert.equal(account.equityUsd, ui(view.portfolioValue));
  assert.equal(account.maintenanceMarginUsd, ui(view.maintenanceMargin));
  assert.equal(account.freeMarginUsd, ui(view.withdrawableQuoteCollateral));
  assert.equal(account.positions.length, view.positions.length);
  for (const v of view.positions) {
    const p = account.positions.find((x) => x.symbol === v.symbol)!;
    assert.equal(p.size, ui(v.positionSize), v.symbol);
    assert.equal(p.unrealizedPnlUsd, ui(v.unrealizedPnl), v.symbol);
    assert.equal(p.marginUsd, ui(v.positionInitialMargin), v.symbol);
    assert.equal(p.unsettledFundingUsd, ui(v.unsettledFunding), v.symbol);
    assert.equal(p.fundingSinceOpenUsd, ui(v.accumulatedFunding), v.symbol);
    // The view rounds its liquidation price to the market's tick; the SDK solves the same equation.
    const tick = configs.find((c) => c.symbol === v.symbol)!;
    const tickUsd = tick.tickSize * 1e-6 * 10 ** tick.baseLotsDecimals;
    assert.ok(Math.abs(p.liqPx! - ui(v.liquidationPrice)) <= tickUsd + 1e-9, `${v.symbol} liq ${p.liqPx} vs ${ui(v.liquidationPrice)}`);
  }
});

test('account through the reader: every subaccount counts, positions say which one, shorts are negative', async () => {
  const { reader, urls } = readerOver();
  await reader.markets();
  const account = await reader.account(AUTHORITY);
  assert.ok(urls.some((u) => u.endsWith(`/v1/trader/state/${AUTHORITY}?traderPdaIndex=0`)));
  assert.equal(account.venue, 'phoenix');
  assert.equal(account.address, AUTHORITY);
  assert.equal(account.time, AT);
  const sol = account.positions.find((p) => p.symbol === 'SOL') as PhoenixPosition;
  assert.equal(sol.size, -3242.13);
  assert.equal(sol.subaccountIndex, 0);
  assert.equal(sol.leverage, 25);
  assert.ok(Math.abs(sol.entryPx - 365984.387997 / 3242.13) < 1e-9, 'the average entry from the quote paid over the size');
  assert.ok(sol.unsettledFundingUsd > 0, 'a short on a positive rate has funding to receive');
  // Subaccounts 1 and 2 hold isolated collateral and no positions: equity counts it, the free margin does not.
  const snapshot = response<TraderStateSnapshotResponse>('/v1/trader/state/');
  assert.equal(snapshot.snapshot.subaccounts.length, 3);
  const view = response<View>('/v1/view/trader/');
  assert.ok(account.equityUsd > Number(view.portfolioValue.ui) + 30_000);
  await assert.rejects(reader.account('not-an-address'), /not a Solana address/);
});

test('userFunding: pages newest to oldest until past the start, oldest first, received > 0 and paid < 0', async () => {
  const { reader, urls } = readerOver();
  const rows = await reader.userFunding(AUTHORITY, OCT_11);
  assert.equal(urls.filter((u) => u.includes('/funding-history')).length, 3);
  assert.equal(rows.length, 2833);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i]!.time >= rows[i - 1]!.time, 'oldest first');
  assert.ok(rows[0]!.time >= OCT_11);
  assert.equal(new Set(rows.map((r) => `${r.time}:${r.symbol}`)).size, rows.length, 'no duplicates');
  const newestSol = rows.filter((r) => r.symbol === 'SOL').at(-1)!;
  assert.deepEqual(newestSol, { time: OCT_31, symbol: 'SOL', fundingUsd: 6.48426, size: -3242.13, ratePerHour: 0.00002075, samples: null });
  // The sign rule, on every row: a short receives a positive rate, a long pays it, and the other way round.
  for (const r of rows) {
    if (r.fundingUsd === 0 || r.ratePerHour === 0 || r.size === 0) continue;
    assert.equal(Math.sign(r.fundingUsd), -Math.sign(r.size) * Math.sign(r.ratePerHour), `${r.symbol} at ${new Date(r.time).toISOString()}`);
  }
  // And the amount is the size times the funding per unit: |fundingUsd| ~ |size| x rate x mark.
  assert.ok(Math.abs(Math.abs(newestSol.fundingUsd) / Math.abs(newestSol.size) / newestSol.ratePerHour - 96.37) < 0.1);
});

test('userFunding: a later start stops paging earlier, and an end time trims the newest rows', async () => {
  const { reader, urls } = readerOver();
  const rows = await reader.userFunding(AUTHORITY, OCT_20, OCT_31 - 1);
  assert.equal(urls.filter((u) => u.includes('/funding-history')).length, 2);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.time >= OCT_20 && r.time < OCT_31));
  await assert.rejects(reader.userFunding(AUTHORITY, OCT_20, OCT_11), /endTime/);
  await assert.rejects(reader.userFunding(AUTHORITY, -1), /startTime/);
});

test('the fetch transport only reads: a POST is refused before it reaches the network', async () => {
  let called = false;
  const t = new FetchTransport('https://perp-api.phoenix.trade', (async () => {
    called = true;
    return new Response('{}');
  }) as typeof fetch);
  await assert.rejects(t.fetch('POST', '/v1/exchange/send-register-ixs', undefined, {}), /only GET/);
  assert.equal(called, false);
});
