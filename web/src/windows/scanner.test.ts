import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Window as FundingWindow, WindowLeg } from '@gimbal/shared';
import {
  aprOfHourly, assetRows, countdown, DEFAULT_ASSET_SORT, DEFAULT_VENUE_SORT, defaultScope, defaultSort, everyText, everyWords, knownOf, matches, netScale,
  nextAssetSort, nextPayment, nextSort, nextVenueSort, pairNextAt, pairRow, pairRows, payout, priceGapPct, scanLine, scanSummary, scopeCounts, selectAssets,
  selectPairs, siblingPairs, sortAssets, sortPairs, sortVenues, venueQuery, venueRows,
} from './scanner.ts';
import { win } from './testing.ts';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 10, 12, 30);

const leg = (aprPct: number, over: Partial<WindowLeg> = {}): WindowLeg => ({
  symbol: 'SOL', ratePerHour: aprPct / 100 / 8760, apr7dPct: null, settlement: 'hourly', nextAt: T0 + 30 * 60_000, markPx: 100, oiUsd: 1_000_000,
  volume24hUsd: 5_000_000, move24hPct: 1.2, readAt: T0, ...over,
});

const pair = (symbol: string, longVenue: string, shortVenue: string, longApr: number, shortApr: number, over: Partial<FundingWindow> = {}): FundingWindow =>
  win({
    symbol, id: `${symbol}-${longVenue}-${shortVenue}`.toLowerCase(), longVenue, shortVenue, grossAprPct: shortApr - longApr,
    legs: { long: leg(longApr, { symbol }), short: leg(shortApr, { symbol }) }, ...over,
  });

test('a rate per hour is stated as a year', () => {
  assert.equal(Number(aprOfHourly(0.00005).toFixed(2)), 43.8);
  assert.equal(aprOfHourly(0), 0);
});

test('how often a venue pays', () => {
  assert.equal(everyText('hourly'), '1 h');
  assert.equal(everyText('8h'), '8 h');
  assert.equal(everyText('daily'), '24 h');
  assert.equal(everyText('continuous'), 'live');
  assert.equal(everyWords('hourly'), 'every hour');
  assert.equal(everyWords('4h'), 'every 4 hours');
  assert.equal(everyWords('daily'), 'once a day');
  assert.equal(everyWords('continuous'), 'continuously');
});

test('the next payment is the venue\'s own time while it is ahead, else rolled forward by the period', () => {
  assert.equal(nextPayment({ settlement: 'hourly', nextAt: T0 + 1000 }, T0), T0 + 1000);
  // Read 20 minutes before the hour, looked at 5 minutes after it: the payment after that one.
  assert.equal(nextPayment({ settlement: 'hourly', nextAt: T0 }, T0 + 5 * 60_000), T0 + HOUR);
  assert.equal(nextPayment({ settlement: '8h', nextAt: T0 }, T0 + 17 * HOUR), T0 + 24 * HOUR);
  assert.equal(nextPayment({ settlement: 'hourly', nextAt: T0 }, T0), T0 + HOUR);
  assert.equal(nextPayment({ settlement: 'continuous', nextAt: T0 }, T0 + 5), null);
});

test('the time left reads in minutes, then hours and minutes', () => {
  assert.equal(countdown(20_000), 'under 1 min');
  assert.equal(countdown(12 * 60_000 + 59_000), '12 min');
  assert.equal(countdown(65 * 60_000), '1 h 05');
  assert.equal(countdown(7 * HOUR + 41 * 60_000), '7 h 41');
  assert.equal(countdown(-5), 'under 1 min');
});

test('the price gap is the short\'s mark over the long\'s; unknown without both marks', () => {
  assert.equal(Number(priceGapPct(100, 100.25)!.toFixed(2)), 0.25);
  assert.equal(Number(priceGapPct(100, 99.5)!.toFixed(2)), -0.5);
  assert.equal(priceGapPct(null, 100), null);
  assert.equal(priceGapPct(0, 100), null);
});

test('a row carries both sides, the gap, the quieter side\'s volume and the net', () => {
  const w = pair('SOL', 'phoenix', 'hyperliquid', 8.76, 43.8, {
    netAprPct: 30.1,
    legs: { long: leg(8.76, { symbol: 'SOL-PERP', markPx: 200, volume24hUsd: 2_000_000 }), short: leg(43.8, { markPx: 200.3, volume24hUsd: 9_000_000 }) },
  });
  const row = pairRow(w);
  assert.equal(row.long!.name, 'Phoenix');
  assert.equal(row.long!.symbol, 'SOL-PERP');
  assert.equal(Number(row.long!.aprPct.toFixed(2)), 8.76);
  assert.equal(Number(row.short!.aprPct.toFixed(2)), 43.8);
  assert.equal(Number(row.gapPct!.toFixed(2)), 0.15);
  assert.equal(row.volumeUsd, 2_000_000);
  assert.equal(row.netPct, 30.1);
  assert.equal(row.open, true);
});

test('a window without sides still makes a row; a watch-only pair has no net', () => {
  const old = pairRow(win({ symbol: 'ETH' }));
  assert.equal(old.long, null);
  assert.equal(old.gapPct, null);
  assert.equal(old.volumeUsd, null);
  const watch = pairRow(pair('XMR', 'lighter', 'binance', 1, 40, { tradable: false, netAprPct: 39 }));
  assert.equal(watch.netPct, null);
  assert.equal(watch.open, false);
});

test('a pair is next paid at the sooner of its two sides', () => {
  const row = pairRow(pair('SOL', 'phoenix', 'orderly', 1, 12, {
    legs: { long: leg(1, { settlement: 'daily', nextAt: T0 + 5 * HOUR }), short: leg(12, { settlement: '8h', nextAt: T0 + 2 * HOUR }) },
  }));
  assert.equal(pairNextAt(row, T0), T0 + 2 * HOUR);
  const live = pairRow(pair('ETH', 'gmx-arbitrum', 'paradex', 1, 12, {
    tradable: false, legs: { long: leg(1, { settlement: 'continuous' }), short: leg(12, { settlement: 'continuous' }) },
  }));
  assert.equal(pairNextAt(live, T0), null);
});

const LIST = pairRows([
  pair('SOL', 'phoenix', 'hyperliquid', 2, 14, { netAprPct: 9, depthUsd: 2_000_000 }),
  pair('DOGE', 'phoenix', 'orderly', 1, 31, { netAprPct: 24, depthUsd: 40_000, refused: { code: 'E_ASSET', reason: 'not in policy' } }),
  pair('BTC', 'hyperliquid', 'orderly', 3, 8, { netAprPct: 2, grossApr7dPct: null, depthUsd: 90_000_000 }),
  pair('XMR', 'lighter', 'binance', -20, 80, { tradable: false, netAprPct: 100, depthUsd: 300_000 }),
  pair('SOL', 'aster', 'bybit', 1, 51, { tradable: false, netAprPct: 50, depthUsd: 800_000 }),
]);

test('scopes: what the desk may enter, its venues, everything', () => {
  assert.deepEqual(scopeCounts(LIST), { open: 2, desk: 3, all: 5 });
  assert.equal(defaultScope(LIST), 'open');
  assert.equal(defaultScope(LIST.filter((r) => !r.open)), 'desk');
  assert.equal(defaultScope(LIST.filter((r) => !r.w.tradable)), 'all');
  assert.equal(defaultScope([]), 'all');
});

const symbols = (rows: readonly { w: FundingWindow }[]): string => rows.map((r) => `${r.w.symbol}:${r.w.longVenue}`).join(' ');

test('the desk scopes rank by net, with a pair still waiting for its 7 days last; everything ranks by the spread now', () => {
  assert.equal(symbols(selectPairs(LIST, { scope: 'desk', text: '', minOiUsd: 0, sort: defaultSort('desk') }, T0)), 'DOGE:phoenix SOL:phoenix BTC:hyperliquid');
  assert.equal(symbols(selectPairs(LIST, { scope: 'open', text: '', minOiUsd: 0, sort: defaultSort('open') }, T0)), 'SOL:phoenix BTC:hyperliquid');
  assert.equal(symbols(selectPairs(LIST, { scope: 'all', text: '', minOiUsd: 0, sort: defaultSort('all') }, T0)), 'XMR:lighter SOL:aster DOGE:phoenix SOL:phoenix BTC:hyperliquid');
});

test('a column sorts both ways and keeps rows without a value last', () => {
  assert.deepEqual(nextSort({ key: 'net', dir: -1 }, 'net'), { key: 'net', dir: 1 });
  assert.deepEqual(nextSort({ key: 'net', dir: -1 }, 'asset'), { key: 'asset', dir: 1 });
  assert.deepEqual(nextSort({ key: 'net', dir: -1 }, 'oi'), { key: 'oi', dir: -1 });
  // Net ascending: the two watch-only pairs (no net) and BTC (no 7 days) still come after the priced ones.
  assert.equal(symbols(sortPairs(LIST, { key: 'net', dir: 1 }, T0)).split(' ').slice(0, 2).join(' '), 'SOL:phoenix DOGE:phoenix');
  assert.equal(symbols(sortPairs(LIST, { key: 'oi', dir: -1 }, T0)).split(' ')[0], 'BTC:hyperliquid');
  assert.equal(symbols(sortPairs(LIST, { key: 'asset', dir: 1 }, T0)), 'BTC:hyperliquid DOGE:phoenix SOL:phoenix SOL:aster XMR:lighter');
  assert.equal(symbols(sortPairs(LIST, { key: 'long', dir: 1 }, T0)).split(' ')[0], 'XMR:lighter');
});

test('the search reads the asset and both venues, across every scope; the size floor drops thin pairs', () => {
  assert.equal(matches(LIST[0]!, 'sol'), true);
  assert.equal(matches(LIST[0]!, 'sol phoenix'), true);
  assert.equal(matches(LIST[0]!, 'sol orderly'), false);
  assert.equal(matches(LIST[3]!, 'Binance'), true);
  assert.equal(matches(LIST[0]!, '  '), true);
  assert.equal(symbols(selectPairs(LIST, { scope: 'open', text: 'sol', minOiUsd: 0, sort: defaultSort('all') }, T0)), 'SOL:aster SOL:phoenix');
  assert.equal(symbols(selectPairs(LIST, { scope: 'all', text: '', minOiUsd: 1_000_000, sort: defaultSort('all') }, T0)), 'SOL:phoenix BTC:hyperliquid');
});

test('a word that is a listed asset or a venue id, whole, finds only that one', () => {
  const rows = pairRows([
    pair('SOL', 'phoenix', 'hyperliquid', 2, 14),
    pair('SOLV', 'hyperliquid', 'orderly', 2, 9),
    pair('GOLD', 'hl-xyz', 'hyperliquid', 1, 6, { tradable: false }),
    pair('ETH', 'hl-para', 'paradex', 1, 6, { tradable: false }),
  ]);
  const known = knownOf(rows);
  const found = (text: string): string => rows.filter((r) => matches(r, text, known)).map((r) => r.w.symbol).join(' ');
  assert.equal(found('sol'), 'SOL');
  assert.equal(found('so'), 'SOL SOLV');
  assert.equal(found('hyperliquid'), 'SOL SOLV GOLD');
  assert.equal(found('hl-para'), 'ETH');
  assert.equal(found('paradex'), 'ETH');
  assert.equal(found('trade.xyz'), 'GOLD');
  assert.equal(found('para'), 'ETH');
  assert.equal(venueQuery('lighter'), 'Lighter');
  assert.equal(venueQuery('hl-para'), 'hl-para');
  assert.equal(venueQuery('gmx-arbitrum'), 'gmx-arbitrum');
});

test('the net scale takes in the best and the minimum, and does not let one deep loss squeeze the rest', () => {
  const rows = pairRows([pair('A', 'phoenix', 'orderly', 1, 30, { netAprPct: 27.4 }), pair('B', 'phoenix', 'orderly', 1, 3, { netAprPct: -49.7 })]);
  assert.deepEqual(netScale(rows, 5), { lo: -15, hi: 30 });
  assert.deepEqual(netScale(pairRows([pair('A', 'phoenix', 'orderly', 1, 5, { netAprPct: 3 })]), 5), { lo: 0, hi: 10 });
  assert.deepEqual(netScale(pairRows([pair('A', 'phoenix', 'orderly', 1, 5, { netAprPct: -4 })]), 12), { lo: -10, hi: 30 });
  assert.deepEqual(netScale([], null), { lo: 0, hi: 10 });
});

test('assets: each venue once, lowest funding first, with the widest listed pair', () => {
  const assets = assetRows(LIST);
  assert.deepEqual(assets.map((a) => a.symbol), ['XMR', 'SOL', 'DOGE', 'BTC']);
  const sol = assets[1]!;
  assert.equal(sol.pairs, 2);
  assert.deepEqual(sol.venues.map((v) => v.venue), ['aster', 'phoenix', 'hyperliquid', 'bybit']);
  assert.deepEqual(sol.venues.map((v) => v.desk), [false, true, true, false]);
  assert.equal(sol.best.id, 'sol-aster-bybit');
  assert.equal(sol.bestDesk!.id, 'sol-phoenix-hyperliquid');
  assert.equal(sol.oiUsd, 4_000_000);
  assert.equal(assets[3]!.bestDesk, null);
  assert.deepEqual(selectAssets(assets, 'do').map((a) => a.symbol), ['DOGE']);
  assert.deepEqual(selectAssets(assets, 'bybit').map((a) => a.symbol), ['SOL']);
  assert.equal(selectAssets(assets, '').length, 4);
});

test('venues: the desk\'s first, then DEXs, then exchanges, each with its listed pairs', () => {
  const scan = {
    venues: 5, failed: ['binance'], at: T0,
    sources: [
      { id: 'binance', kind: 'cex' as const, markets: 500, oiUsd: 28e9, volume24hUsd: 60e9, readAt: T0 - 90_000, ok: false },
      { id: 'hyperliquid', kind: 'desk' as const, markets: 229, oiUsd: 9e9, volume24hUsd: 7e9, readAt: T0, ok: true },
      { id: 'lighter', kind: 'dex' as const, markets: 120, oiUsd: 1.7e9, volume24hUsd: 5e9, readAt: T0, ok: true },
      { id: 'phoenix', kind: 'desk' as const, markets: 41, oiUsd: 62e6, volume24hUsd: 118e6, readAt: T0, ok: true },
      { id: 'nado', kind: 'dex' as const, markets: 30, oiUsd: null, volume24hUsd: null, readAt: T0, ok: true },
    ],
  };
  const venues = venueRows(scan, LIST);
  assert.deepEqual(venues.map((v) => v.id), ['hyperliquid', 'phoenix', 'lighter', 'nado', 'binance']);
  assert.deepEqual(venues.map((v) => v.pairs), [2, 2, 1, 0, 1]);
  assert.equal(venues[1]!.assets, 2);
  assert.equal(venues[1]!.best!.symbol, 'DOGE');
  assert.equal(venues[4]!.ok, false);
  assert.equal(venues[3]!.best, null);
});

test('venues from an engine that names no sources: only what the pairs tell', () => {
  const venues = venueRows({ venues: 26, failed: [], at: T0 }, LIST);
  assert.deepEqual(venues.slice(0, 3).map((v) => v.id).sort(), ['hyperliquid', 'orderly', 'phoenix']);
  assert.equal(venues.find((v) => v.id === 'binance')!.kind, null);
  assert.equal(venues.find((v) => v.id === 'binance')!.markets, null);
  assert.equal(venues.find((v) => v.id === 'phoenix')!.kind, 'desk');
  assert.equal(venueRows(null, []).length, 0);
});

test('the summary counts what answered, what is listed and what clears the minimum', () => {
  const s = scanSummary({ venues: 26, failed: ['aevo'], at: T0 }, LIST, 5);
  assert.deepEqual(s, { venues: 26, answering: 25, pairs: 5, assets: 4, open: 2, clearing: 1 });
  assert.equal(scanSummary(null, [], null).venues, null);
  assert.equal(scanSummary(null, LIST, null).clearing, null);
});

test('the scan in one line, for the phone', () => {
  const s = { venues: 26, answering: 23, pairs: 220, assets: 85, open: 26, clearing: 4 };
  assert.equal(scanLine(s, 5), '4 of the 26 pairs open to the desk pay your 5% minimum.');
  assert.equal(scanLine({ ...s, clearing: 1 }, 7.5), '1 of the 26 pairs open to the desk pays your 7.5% minimum.');
  assert.equal(scanLine({ ...s, clearing: 0 }, 5), 'None of the 26 pairs open to the desk pays your 5% minimum now.');
  assert.equal(scanLine({ ...s, open: 1, clearing: 1 }, 5), 'The one pair open to the desk pays your 5% minimum.');
  assert.equal(scanLine({ ...s, open: 1, clearing: 0 }, 5), 'The one pair open to the desk pays less than your 5% minimum.');
  assert.equal(scanLine({ ...s, open: 0, clearing: 0 }, 5), '220 pairs listed on 85 assets; none is open to the desk.');
  assert.equal(scanLine({ ...s, clearing: null }, null), '220 pairs listed on 85 assets; 26 open to the desk.');
  assert.equal(scanLine({ ...s, pairs: 1, assets: 1, open: 0, clearing: null }, null), '1 pair listed on 1 asset; none is open to the desk.');
});

const names = (assets: readonly { symbol: string }[]): string => assets.map((a) => a.symbol).join(' ');

test('the assets sort by any column, and an asset with no figure there goes last both ways', () => {
  const assets = assetRows(LIST);
  assert.equal(names(sortAssets(assets, DEFAULT_ASSET_SORT)), 'XMR SOL DOGE BTC');
  assert.equal(names(sortAssets(assets, { key: 'asset', dir: 1 })), 'BTC DOGE SOL XMR');
  assert.equal(names(sortAssets(assets, { key: 'venues', dir: -1 })), 'SOL XMR DOGE BTC');
  // SOL and DOGE both start at 1%: the wider pair first.
  assert.equal(names(sortAssets(assets, { key: 'low', dir: 1 })), 'XMR SOL DOGE BTC');
  assert.equal(names(sortAssets(assets, { key: 'high', dir: -1 })), 'XMR SOL DOGE BTC');
  // XMR is watch-only and BTC has no 7 days: neither has a net, so both close the list whichever way it runs.
  assert.equal(names(sortAssets(assets, { key: 'net', dir: -1 })), 'DOGE SOL XMR BTC');
  assert.equal(names(sortAssets(assets, { key: 'net', dir: 1 })), 'SOL DOGE XMR BTC');
  assert.equal(names(selectAssets(assets, 'o', { key: 'asset', dir: -1 })), 'SOL DOGE BTC');
});

test('a click on a column: the same one turns it round, a new one starts where its figures read best', () => {
  assert.deepEqual(nextAssetSort(DEFAULT_ASSET_SORT, 'widest'), { key: 'widest', dir: 1 });
  assert.deepEqual(nextAssetSort(DEFAULT_ASSET_SORT, 'asset'), { key: 'asset', dir: 1 });
  assert.deepEqual(nextAssetSort(DEFAULT_ASSET_SORT, 'low'), { key: 'low', dir: 1 });
  assert.deepEqual(nextAssetSort(DEFAULT_ASSET_SORT, 'oi'), { key: 'oi', dir: -1 });
  assert.deepEqual(nextVenueSort(DEFAULT_VENUE_SORT, 'kind'), { key: 'kind', dir: -1 });
  assert.deepEqual(nextVenueSort(DEFAULT_VENUE_SORT, 'venue'), { key: 'venue', dir: 1 });
  assert.deepEqual(nextVenueSort(DEFAULT_VENUE_SORT, 'pairs'), { key: 'pairs', dir: -1 });
});

test('the venues sort by any column; one that did not answer has no market count', () => {
  const scan = {
    venues: 5, failed: ['binance'], at: T0,
    sources: [
      { id: 'binance', kind: 'cex' as const, markets: 500, oiUsd: 28e9, volume24hUsd: 60e9, readAt: T0 - 90_000, ok: false },
      { id: 'hyperliquid', kind: 'desk' as const, markets: 229, oiUsd: 9e9, volume24hUsd: 7e9, readAt: T0, ok: true },
      { id: 'lighter', kind: 'dex' as const, markets: 120, oiUsd: 1.7e9, volume24hUsd: 5e9, readAt: T0, ok: true },
      { id: 'phoenix', kind: 'desk' as const, markets: 41, oiUsd: 62e6, volume24hUsd: 118e6, readAt: T0, ok: true },
      { id: 'nado', kind: 'dex' as const, markets: 30, oiUsd: null, volume24hUsd: null, readAt: T0, ok: true },
    ],
  };
  const venues = venueRows(scan, LIST);
  const ids = (sort: Parameters<typeof sortVenues>[1]): string => sortVenues(venues, sort).map((v) => v.id).join(' ');
  assert.equal(ids(DEFAULT_VENUE_SORT), 'hyperliquid phoenix lighter nado binance');
  assert.equal(ids({ key: 'venue', dir: 1 }), 'binance hyperliquid lighter nado phoenix');
  assert.equal(ids({ key: 'oi', dir: -1 }), 'binance hyperliquid lighter phoenix nado');
  assert.equal(ids({ key: 'oi', dir: 1 }), 'phoenix lighter hyperliquid binance nado');
  assert.equal(ids({ key: 'markets', dir: -1 }), 'hyperliquid lighter phoenix nado binance');
  // Lighter and Binance share the widest pair (XMR): the DEX before the exchange, as the scan groups them.
  assert.equal(ids({ key: 'widest', dir: -1 }), 'lighter binance phoenix hyperliquid nado');
  assert.equal(venues.find((v) => v.id === 'phoenix')!.settlement, 'hourly');
  assert.equal(venues.find((v) => v.id === 'nado')!.settlement, null);
});

test('a venue pays the way most of its listed markets do', () => {
  const eight = { settlement: '8h' as const };
  const rows = pairRows([
    pair('A', 'gate', 'phoenix', 1, 5, { tradable: false, legs: { long: leg(1, eight), short: leg(5) } }),
    pair('B', 'gate', 'phoenix', 1, 6, { tradable: false, legs: { long: leg(1, eight), short: leg(6) } }),
    pair('C', 'phoenix', 'gate', 1, 7, { tradable: false, legs: { long: leg(1), short: leg(7, { settlement: '4h' }) } }),
  ]);
  const venues = venueRows({ venues: 2, failed: [], at: T0 }, rows);
  assert.equal(venues.find((v) => v.id === 'gate')!.settlement, '8h');
  assert.equal(venues.find((v) => v.id === 'phoenix')!.settlement, 'hourly');
});

test('the other pairs on an asset: the desk\'s first by net, then the watched ones by spread', () => {
  const rows = pairRows([
    pair('SOL', 'phoenix', 'hyperliquid', 2, 14, { netAprPct: 9 }),
    pair('SOL', 'aster', 'bybit', 1, 51, { tradable: false }),
    pair('SOL', 'hyperliquid', 'orderly', 14, 20, { netAprPct: 3 }),
    pair('SOL', 'lighter', 'binance', 1, 71, { tradable: false }),
    pair('SOL', 'phoenix', 'orderly', 2, 20, { netAprPct: 12 }),
    pair('ETH', 'phoenix', 'orderly', 2, 20, { netAprPct: 40 }),
  ]);
  assert.deepEqual(siblingPairs(rows, rows[0]!.w).map((r) => r.w.id), ['sol-phoenix-orderly', 'sol-hyperliquid-orderly', 'sol-lighter-binance', 'sol-aster-bybit']);
  assert.deepEqual(siblingPairs(rows, rows[5]!.w), []);
});

test('what a rate pays on a leg', () => {
  const p = payout(36.5, 1000);
  assert.equal(Number(p.year.toFixed(2)), 365);
  assert.equal(Number(p.day.toFixed(2)), 1);
  assert.equal(Number(p.week.toFixed(2)), 7);
  assert.equal(Number(p.hour.toFixed(4)), 0.0417);
  assert.equal(Number(p.eightHours.toFixed(4)), 0.3333);
});
