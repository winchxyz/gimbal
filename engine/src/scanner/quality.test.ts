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
import { pairLegs } from './pairs.ts';
import { QUALITY_PREFIXES, WatchQuality, hasQualityFinding, inSession, inTraditionalWeekend, localTime, perHour } from './quality.ts';
import { Scanner } from './scanner.ts';
import { T0, leg } from './test-helpers.ts';

const BASE = 0.0001 / 8;                         // the 0.01 % per 8 h baseline, per hour
const MON_NY_OPEN = Date.UTC(2026, 10, 2, 15);   // Monday 2 Nov 15:00 UTC = 10:00 New York (EST)
const TUE_NIGHT = Date.UTC(2026, 10, 3, 22);     // Tuesday 22:00 UTC: New York shut, Tokyo not yet open

function quality(legs: ScanLeg[], now = T0, hasHistory: (v: ScanVenueId) => boolean = () => false): WatchQuality {
  return new WatchQuality({ now, listed: legs, kept: legs, hasHistory, config: DEFAULT_QUALITY });
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
  assert.deepEqual(q.legFindings(hmstr), ['Thin: hyperliquid HMSTR traded $23k in 24 h, under the $100k floor']);
  // Exactly at the floor passes.
  const atFloor = w('aster', 'GTCUSDT', 0, { volume24hUsd: 100_000 });
  assert.deepEqual(quality([atFloor]).legFindings(atFloor), []);
  // OKX publishes open interest and no volume: the open-interest floor of filterLegs is its test, not this one.
  const okx = w('okx', 'BTC-USDT-SWAP', BASE, { volume24hUsd: null }, 'cex');
  assert.deepEqual(quality([okx]).legFindings(okx), []);
  // A price with neither volume nor open interest: nothing shows it trades.
  const bare = w('paradex', 'X-USD-PERP', BASE, { volume24hUsd: null, openInterest: null });
  assert.deepEqual(quality([bare]).legFindings(bare), ['Thin: paradex X-USD-PERP publishes neither 24 h volume nor open interest: nothing shows it trades']);
  assert.equal(DEFAULT_QUALITY.minVolume24hUsd, 100_000);
});

test('at the cap: a venue\'s own cap or floor, from the sourced table only', () => {
  assert.deepEqual(FUNDING_LIMITS.hyperliquid, { all: { capPerHour: 0.04, floorPerHour: -0.04 } });
  assert.deepEqual(FUNDING_LIMITS.lighter!.all, { capPerHour: 0.005, floorPerHour: -0.005 });
  assert.deepEqual(FUNDING_LIMITS.lighter!.bySymbol!.ARC, { capPerHour: 0.025, floorPerHour: -0.025 });
  assert.deepEqual(FUNDING_LIMITS.lighter!.bySymbol!.SAMSUNG, { capPerHour: 0.000025, floorPerHour: -0.000025 });
  const capped = leg('hyperliquid', 'XYZ', { ratePerHour: 0.04 });
  assert.deepEqual(quality([capped]).legFindings(capped), ['At the cap: hyperliquid XYZ reads 4 % per hour, its venue\'s funding cap of 4 % per hour']);
  const floored = w('lighter', 'ABC', -0.005);
  assert.deepEqual(quality([floored]).legFindings(floored), ['At the cap: lighter ABC reads -0.5 % per hour, its venue\'s funding floor of -0.5 % per hour']);
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
  const line = 'At the cap: aster, bitget, gate, kucoin and mexc all read Q at exactly -0.5 % per hour: 5 venues sharing one rate to the digit is a funding cap or floor, not the market\'s premium';
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
  assert.deepEqual(q.legFindings(binance), ['Unconfirmed: binance NIL has no mark, open interest or history of its own, and no venue with data of its own reads NIL near -0.0559 % per hour']);
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
  assert.deepEqual(q.legFindings(bybit), ['Lone baseline: bybit BLUR reads the quiet 0.00125 % per hour while 6 other venues agree near -0.0517 % per hour: more likely a default than the market\'s rate']);
  assert.equal(perHour(-0.000517445), '-0.0517 % per hour');
  // Hyperliquid's own TRX at the pin against negative CEX rates is real carry: no finding.
  const hlTrx = leg('hyperliquid', 'TRX', { ratePerHour: BASE, volume24hUsd: 3e7 });
  const trxCrowd = ['okx', 'bitget', 'gate', 'kucoin', 'mexc'].map((v) => w(v, `TRX_${v}`, -0.0004, { base: 'TRX' }));
  assert.deepEqual(quality([hlTrx, ...trxCrowd]).legFindings(hlTrx), []);
  // Three venues are no crowd: the relayed reading is then only unconfirmed.
  const small = quality([bybit, ...crowd.slice(0, 3)]);
  assert.match(small.legFindings(bybit)[0]!, /^Unconfirmed: bybit BLUR/);
});

test('market hours: each exchange\'s session in its own time zone, summer time included', () => {
  const ny = DEFAULT_QUALITY.stockSessions.find((s) => s.name === 'New York')!;
  // Friday 30 Oct 2026 is still summer time in New York (EDT, UTC-4): it opens at 13:30 UTC.
  assert.equal(inSession(ny, Date.UTC(2026, 9, 30, 13, 30)), true);
  assert.equal(inSession(ny, Date.UTC(2026, 9, 30, 13, 29)), false);
  // Monday 2 Nov is winter time (EST, UTC-5): 13:30 UTC is 08:30 there; it opens at 14:30 UTC.
  assert.equal(inSession(ny, Date.UTC(2026, 10, 2, 13, 30)), false);
  assert.equal(inSession(ny, Date.UTC(2026, 10, 2, 14, 30)), true);
  assert.equal(inSession(ny, Date.UTC(2026, 10, 2, 21, 0)), false);   // 16:00 EST: closed
  assert.deepEqual(localTime(Date.UTC(2026, 9, 31, 2, 9), 'Asia/Seoul'), { day: 6, minutes: 11 * 60 + 9 });
  // The futures weekend: Friday 17:00 to Sunday 18:00 New York time.
  const wk = DEFAULT_QUALITY.traditionalWeekend;
  assert.equal(inTraditionalWeekend(wk, Date.UTC(2026, 10, 6, 21, 59)), false);  // Fri 16:59 EST
  assert.equal(inTraditionalWeekend(wk, Date.UTC(2026, 10, 6, 22, 0)), true);    // Fri 17:00 EST
  assert.equal(inTraditionalWeekend(wk, Date.UTC(2026, 10, 8, 22, 59)), true);   // Sun 17:59 EST
  assert.equal(inTraditionalWeekend(wk, Date.UTC(2026, 10, 8, 23, 0)), false);   // Sun 18:00 EST
});

test('market closed: a stock perp, named so by a venue\'s own symbol, read while no stock exchange is open', () => {
  // SAMSUNG on a Saturday: Kraken charges a rate, Aster reads 0. MEXC's listing says it is a stock.
  const kraken = w('kraken', 'PF_SAMSUNGUSD', -0.00057849, { base: 'SAMSUNG' }, 'cex');
  const aster = w('aster', 'SAMSUNGUSDT', 0, { base: 'SAMSUNG' });
  const mexc = w('mexc', 'SAMSUNGSTOCK_USDT', 0, { base: 'SAMSUNG' }, 'cex');
  const legs = [kraken, aster, mexc];
  const line = 'Market closed: SAMSUNG is a stock perp (mexc SAMSUNGSTOCK_USDT) and no stock exchange is in session at Sat 10:30 UTC: its rates are not set by a live market';
  const pair = pairLegs(legs).find((p) => p.long === kraken && p.short === aster)!;
  assert.deepEqual(quality(legs).checks(pair), [{ ok: false, text: line }], 'one line for the base, not one per leg');
  // While one exchange is in session the rate is a market's: New York on Monday, Tokyo at 01:00 UTC.
  assert.deepEqual(quality(legs, MON_NY_OPEN).checks(pair), []);
  assert.deepEqual(quality(legs, Date.UTC(2026, 10, 3, 1)).checks(pair), []);
  // Tuesday 22:00 UTC: New York has closed and Tokyo has not opened.
  assert.match(quality(legs, TUE_NIGHT).checks(pair)[0]!.text, /^Market closed: SAMSUNG is a stock perp .* at Tue 22:00 UTC/);
  // Without a venue naming it a stock, SAMSUNG is just a name.
  assert.deepEqual(quality([kraken, aster]).checks(pair), []);
  // MEXC's 4STOCK_USDT is a coin called 4STOCK: the marker's ticker must name the base.
  const coin = w('mexc', '4STOCK_USDT', 0.0003, { base: '4STOCK' }, 'cex');
  assert.deepEqual(quality([coin]).legFindings(coin), []);
  // Extended's 24/5 and Backpack's .US markets name stocks too.
  for (const [venue, symbol] of [['extended', 'INTC_24_5-USD'], ['backpack', 'INTC.US_USDC_PERP'], ['bitget', 'INTCSTOCKUSDT']] as const) {
    const l = w(venue, symbol, 0, { base: 'INTC' });
    assert.match(quality([l]).legFindings(l)[0]!, new RegExp(`^Market closed: INTC is a stock perp \\(${venue} `), venue);
  }
});

test('market closed: a hl-xyz market (traditional assets only) over the futures weekend, not on weekday nights', () => {
  const gold = w('hl-xyz', 'xyz:GOLD', -0.0003612, { base: 'XAU' });
  const okx = w('okx', 'XAU-USDT-SWAP', 0, { base: 'XAU' }, 'cex');
  const pair = pairLegs([gold, okx]).find((p) => p.long === gold)!;
  assert.deepEqual(quality([gold, okx]).checks(pair), [{
    ok: false, text: 'Market closed: XAU is listed on hl-xyz, which lists traditional assets only, and their markets are shut for the weekend at Sat 10:30 UTC: its rates are not set by a live market',
  }]);
  assert.deepEqual(quality([gold, okx], TUE_NIGHT).checks(pair), []);
});

// ---------- the recorded sweep ----------

const SWEEP = readWireRecording(fileURLToPath(new URL('../../fixtures/watch-wire/watch-mainnet-2026-10-31.jsonl.gz', import.meta.url)));

async function sweepScan(now?: number): Promise<FundingWindow[]> {
  const clock = new VirtualClock(SWEEP[0]!.t);
  const fetch = replayFetch(SWEEP);
  const scanClock = now === undefined ? clock : { now: () => now };
  const s = new Scanner([new HyperliquidReader({ fetch, clock })], watchReaders({ fetch, clock }), {
    config: { ...DEFAULT_SCANNER_CONFIG, maxWatchWindows: 10_000 }, clock: scanClock, strategy: () => DEFAULT_STRATEGY,
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
  assert.deepEqual(findings(byId('samsung-kraken-aster')), ['Market closed: SAMSUNG is a stock perp (mexc SAMSUNGSTOCK_USDT) and no stock exchange is in session at Sat 02:09 UTC: its rates are not set by a live market']);
  assert.match(findings(byId('snxx-hl-xyz-aster'))[0]!, /^Market closed: SNXX is listed on hl-xyz/);
  assert.match(findings(byId('intc-hl-xyz-kraken'))[0]!, /^Market closed: INTC is a stock perp \(extended INTC_24_5-USD\)/);
  // Bybit's relayed BLUR at the baseline while every other venue reads about -0.05 % per hour.
  assert.match(findings(byId('blur-hyperliquid-bybit'))[0]!, /^Lone baseline: bybit BLUR reads the quiet 0.00125 % per hour while 7 other venues agree/);
  // Aster's thin GTC and NIL.
  assert.deepEqual(findings(byId('gtc-aster-kucoin')), ['Thin: aster GTCUSDT traded $64k in 24 h, under the $100k floor']);
  assert.deepEqual(findings(byId('nil-aster-hyperliquid')), ['Thin: aster NILUSDT traded $75k in 24 h, under the $100k floor']);
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

test('the recorded sweep read on a weekday in New York hours: no market is closed, the other findings stand', async () => {
  const windows = await sweepScan(MON_NY_OPEN);
  assert.ok(!windows.some((x) => findings(x).some((t) => t.startsWith('Market closed:'))));
  assert.deepEqual(findings(windows.find((x) => x.id === 'samsung-kraken-aster')), []);
  assert.equal(findings(windows.find((x) => x.id === 'gtc-aster-kucoin')).length, 1);
});
