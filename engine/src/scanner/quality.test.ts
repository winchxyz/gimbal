// The quality findings on watch-only legs, one kind at a time on built legs, then on the recorded sweep of
// 2026-10-31 (fixtures/watch-wire) where the watch-unit audit found each of them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ScanVenueId, Window as FundingWindow } from '@gimbal/shared';
import { HyperliquidReader } from '../venues/hyperliquid.ts';
import { VirtualClock, readWireRecording, replayFetch } from '../venues/replay.ts';
import type { MarketFunding } from '../venues/venue.ts';
import { watchReaders } from '../venues/watch/index.ts';
import { DEFAULT_QUALITY, DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY, FUNDING_LIMITS } from './config.ts';
import type { LegKind, ScanLeg } from './pairs.ts';
import { filterLegs, pairLegs } from './pairs.ts';
import { QUALITY_PREFIXES, WatchQuality, hasQualityFinding, inSession, inTraditionalWeekend, localTime, perHour } from './quality.ts';
import { Scanner } from './scanner.ts';
import { T0, leg } from './test-helpers.ts';

const BASE = 0.0001 / 8;                         // the 0.01 % per 8 h baseline, per hour
const MON_NY_OPEN = Date.UTC(2026, 10, 2, 15);   // Monday 2 Nov 15:00 UTC = 10:00 New York (EST)
const TUE_NIGHT = Date.UTC(2026, 10, 3, 22);     // Tuesday 22:00 UTC: New York shut, Tokyo not yet open

const MAX_DEV = DEFAULT_SCANNER_CONFIG.maxMarkDeviation;

function quality(legs: ScanLeg[], now = T0, hasHistory: (v: ScanVenueId) => boolean = () => false): WatchQuality {
  return new WatchQuality({ now, listed: legs, kept: legs, dropped: [], maxMarkDeviation: MAX_DEV, hasHistory, config: DEFAULT_QUALITY });
}

/** As the scanner builds it: the legs through filterLegs first. */
function filtered(legs: ScanLeg[], now = T0): { q: WatchQuality; kept: ScanLeg[] } {
  const { kept, dropped } = filterLegs(legs, { oiFloorUsd: DEFAULT_SCANNER_CONFIG.oiFloorUsd, maxMarkDeviation: MAX_DEV, deskLegUsd: 1000, deskMaxOiShare: 0.02 });
  return { q: new WatchQuality({ now, listed: legs, kept, dropped, maxMarkDeviation: MAX_DEV, hasHistory: () => false, config: DEFAULT_QUALITY }), kept };
}

/** A watch leg reading `rate` per hour, with a mark, OI (5M USD) and volume unless the fields say otherwise. */
const w = (venue: string, symbol: string, rate: number, fields: Partial<MarketFunding> = {}, kind?: LegKind) =>
  leg(venue, symbol, { ratePerHour: rate, volume24hUsd: 5e6, ...fields }, kind);
/** A Binance or Bybit leg as Hyperliquid's predictedFundings relays it: a rate and nothing else. */
const relayed = (venue: 'binance' | 'bybit', symbol: string, rate: number) =>
  leg(venue, symbol, { ratePerHour: rate, markPx: null, openInterest: null, volume24hUsd: null }, 'cex');

test('thin: under 0.1M USD of 24 h volume names the leg; without volume, open interest stands in', () => {
  // HMSTR on Hyperliquid in the recorded sweep: 1.7M USD of open interest, but 22,701 USD traded in 24 h.
  const hmstr = leg('hyperliquid', 'HMSTR', { markPx: 0.000142, openInterest: 11_804_639_080, volume24hUsd: 22_701 });
  const q = quality([hmstr]);
  assert.deepEqual(q.legFindings(hmstr), ['Thin: Hyperliquid HMSTR traded $23k in 24 h, under the $100k floor']);
  // Exactly at the floor passes.
  const atFloor = w('aster', 'GTCUSDT', 0, { volume24hUsd: 100_000 });
  assert.deepEqual(quality([atFloor]).legFindings(atFloor), []);
  // OKX publishes open interest and no volume: the open-interest floor of filterLegs is its test, not this one.
  const okx = w('okx', 'BTC-USDT-SWAP', BASE, { volume24hUsd: null }, 'cex');
  assert.deepEqual(quality([okx]).legFindings(okx), []);
  // A price with neither volume nor open interest: nothing shows it trades.
  const bare = w('paradex', 'X-USD-PERP', BASE, { volume24hUsd: null, openInterest: null });
  assert.deepEqual(quality([bare]).legFindings(bare), ['Thin: Paradex X-USD-PERP publishes neither 24 h volume nor open interest: nothing shows it trades']);
  assert.equal(DEFAULT_QUALITY.minVolume24hUsd, 100_000);
});

test('at the cap: the market\'s own cap or floor from its venue\'s answer, each side alone, before the sourced table', () => {
  // Gate's AGRIPPA_USDT in the recorded sweep: 0.02 per 4 h, exactly its funding_rate_limit of 0.02.
  const agrippa = w('gate', 'AGRIPPA_USDT', 0.02 / 4, { fundingCapPerHour: 0.02 / 4, fundingFloorPerHour: -0.02 / 4 }, 'cex');
  assert.deepEqual(quality([agrippa]).legFindings(agrippa), ['At the cap: Gate AGRIPPA_USDT reads 0.5 % per hour, its market\'s funding cap of 0.5 % per hour']);
  // MEXC's KMISTOCK_USDT: -0.002 per 8 h on its floor of -0.002, with a cap of only 0.0002.
  const kmi = w('mexc', 'KMISTOCK_USDT', -0.002 / 8, { base: 'KMI', fundingCapPerHour: 0.0002 / 8, fundingFloorPerHour: -0.002 / 8 }, 'cex');
  assert.deepEqual(quality([kmi], MON_NY_OPEN).legFindings(kmi), ['At the cap: MEXC KMISTOCK_USDT reads -0.025 % per hour, its market\'s funding floor of -0.025 % per hour']);
  // Under its own cap, a rate the table would not know either.
  const under = w('kucoin', 'XUSDTM', 0.0029 / 8, { fundingCapPerHour: 0.003 / 8 }, 'cex');
  assert.deepEqual(quality([under]).legFindings(under), []);
  // The market's own limit wins over the table: a Lighter market whose answer says 1 % per hour is not capped at
  // the table's 0.5 %.
  const own = w('lighter', 'ABC', -0.005, { fundingFloorPerHour: -0.01 });
  assert.deepEqual(quality([own]).legFindings(own), []);
  // One side given, the other still comes from the table: a cap of its own, the table's floor.
  const half = w('lighter', 'ABC', -0.005, { fundingCapPerHour: 0.01 });
  assert.deepEqual(quality([half]).legFindings(half), ['At the cap: Lighter ABC reads -0.5 % per hour, its venue\'s funding floor of -0.5 % per hour']);
  // A cap at or below zero, or a floor at or above it, is no limit: a quiet market would read "at the cap".
  const zero = leg('mexc', 'Z_USDT', { fundingCapPerHour: 0, fundingFloorPerHour: 0 }, 'cex');
  assert.equal(zero.fundingCapPerHour, undefined);
  assert.equal(zero.fundingFloorPerHour, undefined);
});

test('at the cap: a venue\'s own cap or floor from the sourced table, where its answer gives none', () => {
  assert.deepEqual(FUNDING_LIMITS.hyperliquid, { all: { capPerHour: 0.04, floorPerHour: -0.04 } });
  assert.deepEqual(FUNDING_LIMITS.lighter!.all, { capPerHour: 0.005, floorPerHour: -0.005 });
  assert.deepEqual(FUNDING_LIMITS.lighter!.bySymbol!.ARC, { capPerHour: 0.025, floorPerHour: -0.025 });
  assert.deepEqual(FUNDING_LIMITS.lighter!.bySymbol!.SAMSUNG, { capPerHour: 0.000025, floorPerHour: -0.000025 });
  const capped = leg('hyperliquid', 'XYZ', { ratePerHour: 0.04 });
  assert.deepEqual(quality([capped]).legFindings(capped), ['At the cap: Hyperliquid XYZ reads 4 % per hour, its venue\'s funding cap of 4 % per hour']);
  const floored = w('lighter', 'ABC', -0.005);
  assert.deepEqual(quality([floored]).legFindings(floored), ['At the cap: Lighter ABC reads -0.5 % per hour, its venue\'s funding floor of -0.5 % per hour']);
  // ARC's own clamp is 20 % per 8 h: 0.5 % per hour is not its cap.
  const arc = w('lighter', 'ARC', 0.005);
  assert.deepEqual(quality([arc]).legFindings(arc), []);
  // A venue with no sourced cap is never "at the cap" on its own.
  const aster = w('aster', 'QUSDT', -0.005, { base: 'Q' });
  assert.deepEqual(quality([aster]).legFindings(aster), []);
});

test('at the cap: Q at -2 % per 4 h on five venues at once is a shared floor, not five premiums', () => {
  const venues = ['gate', 'aster', 'bitget', 'kucoin', 'mexc'];
  const q5 = venues.map((v) => w(v, `Q_${v}`, -0.02 / 4, { base: 'Q', settlement: '4h' }));
  const free = w('extended', 'Q-USD', -0.000155, { base: 'Q' });
  const q = quality([...q5, free]);
  const line = 'At the cap: Aster, Bitget, Gate, KuCoin and MEXC all read Q at exactly -0.5 % per hour: 5 venues sharing one rate to the digit is a funding cap or floor, not the market\'s premium';
  for (const l of q5) assert.deepEqual(q.legFindings(l), [line]);
  assert.deepEqual(q.legFindings(free), []);
  // A window of two capped legs says it once.
  const pair = pairLegs([q5[0]!, q5[1]!]).find((p) => p.long === q5[0])!;
  assert.deepEqual(q.checks(pair), [{ ok: false, text: line }]);
  // Two venues can agree by chance; and the baseline is where quiet markets sit, not a cap.
  const two = quality(q5.slice(0, 2));
  assert.deepEqual(two.legFindings(q5[0]!), []);
  const quiet = venues.map((v) => w(v, `BTC_${v}`, BASE, { base: 'BTC' }));
  assert.deepEqual(quality(quiet).legFindings(quiet[0]!), []);
});

test('unconfirmed: a relayed rate needs a second source with data of its own before it leads', () => {
  // NIL on Binance (via predictedFundings) at -0.0559 % per hour; MEXC reads the same with its own mark and OI.
  const binance = relayed('binance', 'NIL', -0.00055918);
  const mexc = w('mexc', 'NIL_USDT', -0.000559, { base: 'NIL' });
  assert.deepEqual(quality([binance, mexc]).legFindings(binance), []);
  // Alone, it is unconfirmed; Bybit, relayed by the same feed, is not a second source.
  const bybit = relayed('bybit', 'NIL', -0.00054035);
  const far = w('gate', 'NIL_USDT', -0.000132, { base: 'NIL' });
  const q = quality([binance, bybit, far]);
  assert.deepEqual(q.legFindings(binance), ['Unconfirmed: Binance NIL has no mark, open interest or history of its own, and no venue with data of its own reads NIL near -0.0559 % per hour']);
  // A venue whose history the scanner reads has data of its own.
  assert.deepEqual(quality([binance], T0, (v) => v === 'binance').legFindings(binance), []);
});

test('lone baseline: a relayed baseline reading against a crowd that agrees (BLUR on Bybit); a venue\'s own pin is real', () => {
  const crowd = [
    w('hyperliquid', 'BLUR', -0.00039885), w('okx', 'BLUR-USDT-SWAP', -0.00049789, { base: 'BLUR' }),
    w('bitget', 'BLURUSDT', -0.00054025, { base: 'BLUR' }), w('gate', 'BLUR_USDT', -0.000537, { base: 'BLUR' }),
    w('kucoin', 'BLURUSDTM', -0.000482, { base: 'BLUR' }), w('mexc', 'BLUR_USDT', -0.0006045, { base: 'BLUR' }),
  ];
  const bybit = relayed('bybit', 'BLUR', BASE);
  const q = quality([bybit, ...crowd]);
  // The crowd's median: (-0.000537 - 0.00049789) / 2 per hour.
  assert.deepEqual(q.legFindings(bybit), ['Lone baseline: Bybit BLUR reads the quiet 0.00125 % per hour while 6 other venues agree near -0.0517 % per hour: more likely a default than the market\'s rate']);
  assert.equal(perHour(-0.000517445), '-0.0517 % per hour');
  // Hyperliquid's own TRX at the pin against negative CEX rates is real carry: no finding.
  const hlTrx = leg('hyperliquid', 'TRX', { ratePerHour: BASE, volume24hUsd: 3e7 });
  const trxCrowd = ['okx', 'bitget', 'gate', 'kucoin', 'mexc'].map((v) => w(v, `TRX_${v}`, -0.0004, { base: 'TRX' }));
  assert.deepEqual(quality([hlTrx, ...trxCrowd]).legFindings(hlTrx), []);
  // Three venues are no crowd: the relayed reading is then only unconfirmed.
  const small = quality([bybit, ...crowd.slice(0, 3)]);
  assert.match(small.legFindings(bybit)[0]!, /^Unconfirmed: Bybit BLUR/);
});

test('market hours: each exchange\'s session in its own time zone, summer time included', () => {
  const ny = DEFAULT_QUALITY.stockExchanges.NYSE!;
  // Friday 30 Oct 2026 is still summer time in New York (EDT, UTC-4): it opens at 13:30 UTC.
  assert.equal(inSession(ny, Date.UTC(2026, 9, 30, 13, 30)), true);
  assert.equal(inSession(ny, Date.UTC(2026, 9, 30, 13, 29)), false);
  // Monday 2 Nov is winter time (EST, UTC-5): 13:30 UTC is 08:30 there; it opens at 14:30 UTC.
  assert.equal(inSession(ny, Date.UTC(2026, 10, 2, 13, 30)), false);
  assert.equal(inSession(ny, Date.UTC(2026, 10, 2, 14, 30)), true);
  assert.equal(inSession(ny, Date.UTC(2026, 10, 2, 21, 0)), false);   // 16:00 EST: closed
  assert.deepEqual(localTime(Date.UTC(2026, 9, 31, 2, 9), 'Asia/Seoul'), { day: 6, minutes: 11 * 60 + 9 });
  // The Asian lunch breaks are closed, local time, on Monday 2 Nov. Hong Kong (UTC+8): 12:00-13:00 = 04:00-05:00 UTC.
  const at = (h: number, m: number) => Date.UTC(2026, 10, 2, h, m);
  const open = (code: string, times: [number, number][]) => times.map(([h, m]) => inSession(DEFAULT_QUALITY.stockExchanges[code]!, at(h, m)));
  assert.deepEqual(open('HKEX', [[1, 29], [1, 30], [3, 59], [4, 0], [4, 59], [5, 0], [7, 59], [8, 0]]), [false, true, true, false, false, true, true, false]);
  // Tokyo (UTC+9): 11:30-12:30 = 02:30-03:30 UTC, and the 15:30 close = 06:30 UTC.
  assert.deepEqual(open('TSE', [[0, 0], [2, 29], [2, 30], [3, 29], [3, 30], [6, 29], [6, 30]]), [true, true, false, false, true, true, false]);
  // Shanghai and Shenzhen (UTC+8): 11:30-13:00 = 03:30-05:00 UTC.
  assert.deepEqual(open('SSE', [[1, 30], [3, 29], [3, 30], [4, 59], [5, 0], [6, 59], [7, 0]]), [true, true, false, false, true, true, false]);
  // Seoul and Taipei trade through lunch (12:00 local = 03:00 and 04:00 UTC).
  assert.deepEqual([...open('KRX', [[3, 0]]), ...open('TWSE', [[4, 0]])], [true, true]);
  // Mumbai is UTC+5:30, a half-hour offset all year: 09:15-15:30 IST = 03:45-10:00 UTC, and no lunch break.
  assert.deepEqual(open('NSE', [[3, 44], [3, 45], [6, 30], [9, 59], [10, 0]]), [false, true, true, true, false]);
  assert.deepEqual(localTime(at(3, 45), 'Asia/Kolkata'), { day: 1, minutes: 9 * 60 + 15 });
  // The futures weekend: Friday 17:00 to Sunday 18:00 New York time.
  const wk = DEFAULT_QUALITY.traditionalWeekend;
  assert.equal(inTraditionalWeekend(wk, Date.UTC(2026, 10, 6, 21, 59)), false);  // Fri 16:59 EST
  assert.equal(inTraditionalWeekend(wk, Date.UTC(2026, 10, 6, 22, 0)), true);    // Fri 17:00 EST
  assert.equal(inTraditionalWeekend(wk, Date.UTC(2026, 10, 8, 22, 59)), true);   // Sun 17:59 EST
  assert.equal(inTraditionalWeekend(wk, Date.UTC(2026, 10, 8, 23, 0)), false);   // Sun 18:00 EST
});

test('market closed: a stock perp, named so by a venue\'s own symbol, read while its exchange is shut', () => {
  // SAMSUNG on a Saturday: Kraken charges a rate, Aster reads 0. MEXC's listing says it is a stock; it lists in Seoul.
  const kraken = w('kraken', 'PF_SAMSUNGUSD', -0.00057849, { base: 'SAMSUNG' }, 'cex');
  const aster = w('aster', 'SAMSUNGUSDT', 0, { base: 'SAMSUNG' });
  const mexc = w('mexc', 'SAMSUNGSTOCK_USDT', 0, { base: 'SAMSUNG' }, 'cex');
  const legs = [kraken, aster, mexc];
  const line = 'Market closed: SAMSUNG is a stock perp (MEXC SAMSUNGSTOCK_USDT) and KRX (Seoul), whose hours it keeps, is not in session at Sat 10:30 UTC: its rates are not set by a live market';
  const pair = pairLegs(legs).find((p) => p.long === kraken && p.short === aster)!;
  assert.deepEqual(quality(legs).checks(pair), [{ ok: false, text: line }], 'one line for the base, not one per leg');
  // KRX trades 09:00 to 15:30 Seoul time, 00:00 to 06:30 UTC: on Tuesday at 01:00 UTC the rate is a market's.
  assert.deepEqual(quality(legs, Date.UTC(2026, 10, 3, 1)).checks(pair), []);
  assert.match(quality(legs, TUE_NIGHT).checks(pair)[0]!.text, /^Market closed: SAMSUNG is a stock perp .* KRX \(Seoul\), whose hours it keeps, is not in session at Tue 22:00 UTC/);
  // Without a venue naming it a stock, SAMSUNG is just a name.
  assert.deepEqual(quality([kraken, aster]).checks(pair), []);
  // MEXC's 4STOCK_USDT is a coin called 4STOCK: the marker's ticker must name the base.
  const coin = w('mexc', '4STOCK_USDT', 0.0003, { base: '4STOCK' }, 'cex');
  assert.deepEqual(quality([coin]).legFindings(coin), []);
  // Extended's 24/5 and Backpack's .US markets name stocks too.
  for (const [venue, symbol, name] of [['extended', 'INTC_24_5-USD', 'Extended'], ['backpack', 'INTC.US_USDC_PERP', 'Backpack'], ['bitget', 'INTCSTOCKUSDT', 'Bitget']] as const) {
    const l = w(venue, symbol, 0, { base: 'INTC' });
    assert.match(quality([l]).legFindings(l)[0]!, new RegExp(`^Market closed: INTC is a stock perp \\(${name} `), venue);
  }
});

test('market closed: a hl-xyz commodity, index or FX market over the futures weekend, not on weekday nights', () => {
  const gold = w('hl-xyz', 'xyz:GOLD', -0.0003612, { base: 'XAU' });
  const okx = w('okx', 'XAU-USDT-SWAP', 0, { base: 'XAU' }, 'cex');
  const pair = pairLegs([gold, okx]).find((p) => p.long === gold)!;
  assert.deepEqual(quality([gold, okx]).checks(pair), [{
    ok: false, text: 'Market closed: XAU is a commodity, index or FX market (trade.xyz xyz:GOLD) and its futures are shut for the weekend at Sat 10:30 UTC: its rates are not set by a live market',
  }]);
  assert.deepEqual(quality([gold, okx], TUE_NIGHT).checks(pair), []);
  for (const b of ['XAU', 'WTI', 'BRENT', 'SPX500', 'XYZ100', 'JP225', 'EUR']) assert.ok(DEFAULT_QUALITY.traditionalNonEquity.includes(b), b);
});

test('market closed: each stock keeps its own exchange\'s hours (Monday 02:00 and 15:00 UTC)', () => {
  const MON_0200 = Date.UTC(2026, 10, 2, 2);     // Mon 11:00 Seoul and Tokyo, Sun 21:00 New York
  const MON_1500 = MON_NY_OPEN;                  // Mon 10:00 New York, 00:00 Tuesday in Seoul
  const legs = [
    // Tesla: a US share, so New York's hours.
    w('kraken', 'PF_TSLAUSD', 0.0004, { base: 'TSLA' }, 'cex'), w('aster', 'TSLAUSDT', 0, { base: 'TSLA' }),
    w('extended', 'TSLA_24_5-USD', 0, { base: 'TSLA' }),
    // Samsung in Seoul, Toyota in Tokyo.
    w('kraken', 'PF_SAMSUNGUSD', -0.0005, { base: 'SAMSUNG' }, 'cex'), w('aster', 'SAMSUNGUSDT', 0, { base: 'SAMSUNG' }),
    w('mexc', 'SAMSUNGSTOCK_USDT', 0, { base: 'SAMSUNG' }, 'cex'),
    w('mexc', 'TOYOTASTOCK_USDT', 0.0001, { base: 'TOYOTA' }, 'cex'), w('bitget', 'TOYOTAUSDT', 0, { base: 'TOYOTA' }, 'cex'),
    // ETFs listed only on hl-xyz: stocks in New York, not futures.
    ...['SOXL', 'SMH', 'EWZ'].flatMap((b) => [w('hl-xyz', `xyz:${b}`, 0.0002, { base: b }), w('okx', `${b}-USDT-SWAP`, 0, { base: b }, 'cex')]),
    // Gold on hl-xyz: futures, which reopened on Sunday 18:00 New York time.
    w('hl-xyz', 'xyz:GOLD', -0.0003, { base: 'XAU' }), w('okx', 'XAU-USDT-SWAP', 0, { base: 'XAU' }, 'cex'),
  ];
  const closed = (now: number) => {
    const q = quality(legs, now);
    return Object.fromEntries([...new Set(legs.map((l) => l.base))].map((b) => {
      const l = legs.find((x) => x.base === b)!;
      return [b, q.legFindings(l).find((t) => t.startsWith('Market closed:'))?.replace(/^Market closed: \S+ is a stock perp \([^)]*\) and (.*), whose hours it keeps.*$/, '$1') ?? 'open'];
    }));
  };
  const ny = 'NYSE and Nasdaq (New York)';
  // Monday 02:00 UTC: Seoul and Tokyo trade, New York does not; Kraken's TSLA against Aster's is not a window.
  assert.deepEqual(closed(MON_0200), { TSLA: ny, SAMSUNG: 'open', TOYOTA: 'open', SOXL: ny, SMH: ny, EWZ: ny, XAU: 'open' });
  // Monday 15:00 UTC: New York trades, Seoul and Tokyo have closed.
  assert.deepEqual(closed(MON_1500), { TSLA: 'open', SAMSUNG: 'KRX (Seoul)', TOYOTA: 'the Tokyo Stock Exchange', SOXL: 'open', SMH: 'open', EWZ: 'open', XAU: 'open' });
  assert.match(quality(legs, MON_0200).legFindings(legs.find((l) => l.symbol === 'xyz:SOXL')!)[0]!,
    /^Market closed: SOXL is a stock perp \(trade\.xyz xyz:SOXL\) and NYSE and Nasdaq \(New York\), whose hours it keeps, is not in session at Mon 02:00 UTC/);
});

test('market closed: over an Asian lunch break a stock perp is closed (Tencent, Monday 04:30 UTC = 12:30 Hong Kong)', () => {
  const legs = [w('mexc', 'TENCENTSTOCK_USDT', 0, { base: 'TENCENT' }, 'cex'), w('aster', 'TENCENTUSDT', 0.0001, { base: 'TENCENT' })];
  const aster = legs[1]!;
  assert.deepEqual(quality(legs, Date.UTC(2026, 10, 2, 4, 30)).legFindings(aster), [
    'Market closed: TENCENT is a stock perp (MEXC TENCENTSTOCK_USDT) and HKEX (Hong Kong), whose hours it keeps, is not in session at Mon 04:30 UTC: its rates are not set by a live market',
  ]);
  assert.deepEqual(quality(legs, Date.UTC(2026, 10, 2, 3, 30)).legFindings(aster), []);   // 11:30, the morning session
  assert.deepEqual(quality(legs, Date.UTC(2026, 10, 2, 5, 30)).legFindings(aster), []);   // 13:30, the afternoon one
});

test('stock exchanges: every exchange named has a session, and the names listed outside New York are sourced ones', () => {
  const q = DEFAULT_QUALITY;
  assert.ok(q.stockExchanges[q.defaultStockExchange] !== undefined);
  for (const [base, x] of Object.entries(q.stockExchangeOf)) assert.ok(q.stockExchanges[x] !== undefined, `${base} on ${x}`);
  assert.equal(q.stockExchangeOf.SAMSUNG, 'KRX');
  assert.equal(q.stockExchangeOf.SKHX, 'KRX');
  assert.equal(q.stockExchangeOf.TOYOTA, 'TSE');
  assert.equal(q.stockExchangeOf.TENCENT, 'HKEX');
  assert.equal(q.stockExchangeOf.TSMC, 'TWSE');
  assert.equal(q.stockExchangeOf.TSM, undefined, 'the New York ADR keeps New York hours');
  assert.deepEqual(q.stockExchanges.KRX, { name: 'KRX (Seoul)', timeZone: 'Asia/Seoul', open: '09:00', close: '15:30' });
});

test('market closed: a stock ticker never marks a coin of the same base: the marks must agree (DASH, QNT)', () => {
  // The recorded sweep: Bitget and MEXC list DoorDash as DASHSTOCK (179 USD) beside the Dash coin (48.75 USD);
  // filterLegs drops the stock listings as duplicates of each venue's coin.
  const dash = [
    leg('hyperliquid', 'DASH', { markPx: 48.757 }),
    w('aster', 'DASHUSDT', -0.0001, { base: 'DASH', markPx: 48.727 }),
    w('bitget', 'DASHUSDT', BASE, { base: 'DASH', markPx: 48.75 }, 'cex'),
    w('bitget', 'DASHSTOCKUSDT', 0, { base: 'DASH', markPx: 179.1, openInterest: 1000 }, 'cex'),
    w('mexc', 'DASH_USDT', BASE, { base: 'DASH', markPx: 48.73 }, 'cex'),
    w('mexc', 'DASHSTOCK_USDT', 0, { base: 'DASH', markPx: 178.89, openInterest: 1000 }, 'cex'),
  ];
  const d = filtered(dash);
  assert.deepEqual(d.kept.map((l) => l.symbol), ['DASH', 'DASHUSDT', 'DASHUSDT', 'DASH_USDT']);
  for (const l of d.kept) assert.deepEqual(d.q.legFindings(l), [], `${l.venue} ${l.symbol}`);
  // Quant: hl-xyz's QNT and the QNTSTOCK listings mark about 34 USD, the Quant coin 194: hl-xyz's is a mark outlier.
  const qnt = [
    w('hl-xyz', 'xyz:QNT', 0.0001, { base: 'QNT', markPx: 33.975 }),
    w('aster', 'QNTUSDT', -0.00005, { base: 'QNT', markPx: 194.34 }),
    w('bitget', 'QNTUSDT', BASE, { base: 'QNT', markPx: 194.08 }, 'cex'),
    w('bitget', 'QNTSTOCKUSDT', 0, { base: 'QNT', markPx: 34.097, openInterest: 1000 }, 'cex'),
    w('mexc', 'QNT_USDT', BASE, { base: 'QNT', markPx: 194.16 }, 'cex'),
    w('mexc', 'QNTSTOCK_USDT', 0, { base: 'QNT', markPx: 34.03, openInterest: 1000 }, 'cex'),
    w('kraken', 'PF_QNTUSD', 0.00003, { base: 'QNT', markPx: 194.05 }, 'cex'),
  ];
  const n = filtered(qnt);
  assert.deepEqual(n.kept.map((l) => `${l.venue} ${l.symbol}`), ['aster QNTUSDT', 'bitget QNTUSDT', 'mexc QNT_USDT', 'kraken PF_QNTUSD']);
  for (const l of n.kept) assert.deepEqual(n.q.legFindings(l), [], `${l.venue} ${l.symbol}`);
  // The marks decide even where nothing was dropped: a DoorDash listing at 179 USD says nothing of a coin at 48.73,
  // and a leg without a mark (Binance, relayed) is compared at its base's median mark.
  const coins = [w('aster', 'DASHUSDT', -0.0001, { base: 'DASH', markPx: 48.727 }), w('gate', 'DASH_USDT', BASE, { base: 'DASH', markPx: 48.75 })];
  const stock = w('mexc', 'DASHSTOCK_USDT', 0, { base: 'DASH', markPx: 178.89 }, 'cex');
  const binance = relayed('binance', 'DASH', BASE);
  const q = new WatchQuality({
    now: T0, listed: [...coins, stock, binance], kept: [...coins, binance], dropped: [], maxMarkDeviation: MAX_DEV, hasHistory: () => false, config: DEFAULT_QUALITY,
  });
  for (const l of [...coins, binance]) assert.ok(!q.legFindings(l).some((t) => t.startsWith('Market closed:')), l.symbol);
  assert.match(q.legFindings(stock).at(-1)!, /^Market closed: DASH is a stock perp \(MEXC DASHSTOCK_USDT\)/);
  // Samsung's marks agree, so the relayed leg is Samsung's too.
  const samsung = [w('aster', 'SAMSUNGUSDT', 0, { base: 'SAMSUNG', markPx: 162.86 }), w('mexc', 'SAMSUNGSTOCK_USDT', 0, { base: 'SAMSUNG', markPx: 162.64 }, 'cex')];
  const relayedSamsung = relayed('binance', 'SAMSUNG', BASE);
  const s = quality([...samsung, relayedSamsung]);
  assert.match(s.legFindings(relayedSamsung).at(-1)!, /^Market closed: SAMSUNG is a stock perp \(MEXC SAMSUNGSTOCK_USDT\)/);
});

// ---------- the recorded sweep ----------

const SWEEP = readWireRecording(fileURLToPath(new URL('../../fixtures/watch-wire/watch-mainnet-2026-10-31.jsonl.gz', import.meta.url)));

async function sweepScan(now?: number, maxWatchWindows = 10_000): Promise<FundingWindow[]> {
  const clock = new VirtualClock(SWEEP[0]!.t);
  const fetch = replayFetch(SWEEP);
  const scanClock = now === undefined ? clock : { now: () => now };
  const s = new Scanner([new HyperliquidReader({ fetch, clock })], watchReaders({ fetch, clock }), {
    config: { ...DEFAULT_SCANNER_CONFIG, maxWatchWindows }, clock: scanClock, strategy: () => DEFAULT_STRATEGY,
  });
  return (await s.scan()).windows;
}

const findings = (win: FundingWindow | undefined) => {
  assert.ok(win !== undefined);
  return win.checks.filter((c) => !c.ok && QUALITY_PREFIXES.some((p) => c.text.startsWith(p))).map((c) => c.text);
};

test('the recorded sweep (Saturday 02:09 UTC): each finding of the audit, and clean windows first', async () => {
  const windows = await sweepScan();
  const byId = (id: string) => windows.find((x) => x.id === id);
  // Kraken's weekend rate on a stock against 0 elsewhere: 507 % gross, not a window.
  assert.deepEqual(findings(byId('samsung-kraken-aster')), ['Market closed: SAMSUNG is a stock perp (MEXC SAMSUNGSTOCK_USDT) and KRX (Seoul), whose hours it keeps, is not in session at Sat 02:09 UTC: its rates are not set by a live market']);
  assert.match(findings(byId('snxx-hl-xyz-aster'))[0]!, /^Market closed: SNXX is a stock perp \(trade\.xyz xyz:SNXX\) and NYSE and Nasdaq \(New York\)/);
  assert.match(findings(byId('intc-hl-xyz-kraken'))[0]!, /^Market closed: INTC is a stock perp \(Extended INTC_24_5-USD\)/);
  // Bybit's relayed BLUR at the baseline while every other venue reads about -0.05 % per hour.
  assert.match(findings(byId('blur-hyperliquid-bybit'))[0]!, /^Lone baseline: Bybit BLUR reads the quiet 0.00125 % per hour while 7 other venues agree/);
  // Aster's thin GTC and NIL.
  assert.deepEqual(findings(byId('gtc-aster-kucoin')), ['Thin: Aster GTCUSDT traded $64k in 24 h, under the $100k floor']);
  assert.deepEqual(findings(byId('nil-aster-hyperliquid')), ['Thin: Aster NILUSDT traded $75k in 24 h, under the $100k floor']);
  // Real rates on venues with data of their own stay clean: Backpack's TRX against Hyperliquid's pin leads.
  assert.deepEqual(findings(byId('trx-backpack-hyperliquid')), []);
  assert.deepEqual(findings(byId('nil-binance-hyperliquid')), [], 'MEXC confirms Binance\'s NIL');
  // Clean watch windows first by gross, then the flagged ones by gross.
  const watchOnly = windows.filter((x) => !x.tradable);
  const firstFlagged = watchOnly.findIndex(hasQualityFinding);
  assert.ok(firstFlagged > 0);
  assert.ok(watchOnly.slice(firstFlagged).every(hasQualityFinding), 'no clean window after a flagged one');
  for (const group of [watchOnly.slice(0, firstFlagged), watchOnly.slice(firstFlagged)]) {
    for (let i = 1; i < group.length; i++) assert.ok(group[i - 1]!.grossAprPct >= group[i]!.grossAprPct);
  }
  assert.equal(watchOnly[0]!.id, 'trx-backpack-hyperliquid');
  // The findings sit right after the watch-only line.
  const samsung = byId('samsung-kraken-aster')!;
  assert.match(samsung.checks[0]!.text, /^Watch-only: /);
  assert.match(samsung.checks[1]!.text, /^Market closed: /);
});

test('the recorded sweep with the default cut: the best windows by gross are sent, the flagged ones after the clean', async (t) => {
  const all = (await sweepScan()).filter((x) => !x.tradable);
  const sent = (await sweepScan(undefined, DEFAULT_SCANNER_CONFIG.maxWatchWindows)).filter((x) => !x.tradable);
  assert.equal(DEFAULT_SCANNER_CONFIG.maxWatchWindows, 150);
  assert.equal(sent.length, 150);
  // The same 150 as a cut by gross alone: a finding never keeps a window from the reader.
  const best = [...all].sort((a, b) => b.grossAprPct - a.grossAprPct || (a.id < b.id ? -1 : 1)).slice(0, 150);
  assert.deepEqual(sent.map((x) => x.id).sort(), best.map((x) => x.id).sort());
  // The audit's large flagged windows are among them, and say why.
  for (const [id, prefix] of [['samsung-kraken-aster', 'Market closed:'], ['nil-aster-hyperliquid', 'Thin:'], ['blur-hyperliquid-bybit', 'Lone baseline:']] as const) {
    assert.ok(findings(sent.find((x) => x.id === id))[0]!.startsWith(prefix), id);
  }
  // Inside the cut: clean first, then flagged, each by gross.
  const flagged = sent.filter(hasQualityFinding);
  const clean = sent.filter((x) => !hasQualityFinding(x));
  assert.deepEqual(sent, [...clean, ...flagged]);
  for (const group of [clean, flagged]) for (let i = 1; i < group.length; i++) assert.ok(group[i - 1]!.grossAprPct >= group[i]!.grossAprPct);
  assert.ok(flagged.length > 0 && clean.length > 0);
  t.diagnostic(`${flagged.length} of the ${sent.length} watch windows sent carry a quality finding`);
});

test('the recorded sweep read on Monday: each stock closed only while its own exchange is, the other findings stand', async () => {
  const closedLines = (windows: FundingWindow[]) => windows.flatMap((x) => findings(x).filter((t) => t.startsWith('Market closed:')));
  // 15:00 UTC, New York open: no US share and no futures market is closed; Seoul's Samsung is.
  const afternoon = await sweepScan(MON_NY_OPEN);
  assert.ok(!closedLines(afternoon).some((t) => t.includes('NYSE and Nasdaq') || t.includes('futures are shut')));
  assert.match(findings(afternoon.find((x) => x.id === 'samsung-kraken-aster'))[0]!, /^Market closed: SAMSUNG .* KRX \(Seoul\)/);
  assert.deepEqual(findings(afternoon.find((x) => x.id === 'intc-hl-xyz-kraken')), []);
  assert.deepEqual(findings(afternoon.find((x) => x.id === 'snxx-hl-xyz-aster')), []);
  assert.equal(findings(afternoon.find((x) => x.id === 'gtc-aster-kucoin')).length, 1);
  // 02:00 UTC, Seoul, Tokyo, Hong Kong, Taipei and Shanghai open, New York shut: the reverse.
  const night = await sweepScan(Date.UTC(2026, 10, 2, 2));
  const nightLines = closedLines(night);
  assert.ok(!nightLines.some((t) => /KRX|Tokyo|HKEX|TWSE|SSE/.test(t)));
  assert.deepEqual(findings(night.find((x) => x.id === 'samsung-kraken-aster')), []);
  assert.match(findings(night.find((x) => x.id === 'intc-hl-xyz-kraken'))[0]!, /^Market closed: INTC .* NYSE and Nasdaq \(New York\)/);
  assert.match(findings(night.find((x) => x.id === 'snxx-hl-xyz-aster'))[0]!, /^Market closed: SNXX is a stock perp \(trade\.xyz xyz:SNXX\)/);
});
