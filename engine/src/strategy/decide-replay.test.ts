// decide() end to end over recorded mainnet scans: the scanner plays fixtures/replay/scan-mainnet-2026-10-31.jsonl.gz
// (the three desk venues, about 65 min) with a desk policy and fresh oracle prices, and every scan it serves goes to
// decide() as one hourly check, with the held pair fed back to the scanner (its switch costs, its margin venues).
// The recording is one hour, so each simulated hour is one of its scans, about 3 minutes of recording apart: the
// windows, gross, 7-day spread, depth and switch costs are recorded; the clock decide() sees moves an hour a check.
//
// Where the recording does not contain the case, the windows are changed, and the test says so in its output:
// - the recording has no second week of history (every desk window is "14-day history loading", a failing check):
//   that check is replaced by a passing one, so the 7-day net decides, as it would once the week is in;
// - from hour 3 NEAR's multi-day gross falls to 7 % (the exit case); from hour 4 SOL long Orderly / short Phoenix nets 8 %
//   (somewhere else to enter); from hour 12 ETH long Phoenix / short Orderly nets 30 % and SOL long Orderly / short
//   Hyperliquid 40 % (the rotation case: ETH on the venues that hold the margin, SOL needing Hyperliquid margin
//   moved in, which its recorded switch cost never pays back on a 12 USD leg);
// - the recording holds no markets() answer: the lot sizes are set here (Hyperliquid's are its szDecimals on
//   mainnet); a leg is sized at the recorded Hyperliquid mark. BTC and ZEC are not used: one common lot of either is
//   under 10 USD or over 12 at their recorded prices, so a 12 USD leg cannot be sized (decide waits on that).
// The NEAR AI risk check plays exchanges recorded for these prompts (fixtures/nearai/SYNTHETIC-veto.json) with no key,
// as serve's replay does: a prompt it has no reply for (the scanner's numbers changed) passes in replay only, labelled
// so (live, it would be held). E10_DUMP_FACTS=1 prints
// the facts of each prompt to stderr, to rebuild those exchanges.
//
// Expected: wait, wait, enter NEAR, hold, hold, exit, cooldown waits, enter SOL, hold while ETH counts, rotate to ETH.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ContractPolicy, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { replayStart } from '../cli/serve-replay.ts';
import { replayReaders } from '../readers.ts';
import { DEFAULT_SCANNER_CONFIG } from '../scanner/config.ts';
import { NO_BREAKEVEN_TEXT } from '../scanner/price.ts';
import type { OracleSource } from '../scanner/price.ts';
import { Scanner } from '../scanner/scanner.ts';
import { LIVE_RESCUE } from '../trade/carry-plan.ts';
import { commonLot, toQty } from '../trade/lots.ts';
import { VirtualClock, readRecording } from '../venues/replay.ts';
import { NO_COUNTERS, decide, skipAct } from './decide.ts';
import { checkRulesOf } from './loop.ts';
import type { DecideInput, Decision, HeldPair, LoopCounters } from './decide.ts';
import { HOUR, STRATEGY, VETO_FIXTURE } from './test-helpers.ts';
import { RecordedVeto, checkVeto, vetoFacts } from './veto.ts';

const RECORDING = fileURLToPath(new URL('../../fixtures/replay/scan-mainnet-2026-10-31.jsonl.gz', import.meta.url));
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'NEAR', 'ZEC'];
/** The mainnet desk's cap: 20 USD a leg, 100 bps band. */
const POLICY: ContractPolicy = {
  hl_assets: SYMBOLS.map((symbol, index) => ({ index, symbol, sz_decimals: 2 })),
  phoenix_markets: SYMBOLS.map((symbol) => ({ symbol, orderbook: `test-orderbook-${symbol.toLowerCase()}`, base_lot_e8: 1, tick_e8: 1 })),
  orderly_symbols: SYMBOLS.map((s) => `PERP_${s}_USDC`),
  max_notional_usd: 20, price_band_bps: 100, oracle_max_age_s: 60, rescue_cap_usd_per_hour: 50,
  unpriced: [], unpriced_max_notional_usd: 0, max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 2_000_000,
};
// The recorded hour fits 3 bad hours before the exit: the owner setting is 3 here (the default 6 is in decide.test.ts).
const STRAT = { ...STRATEGY, minNetAprPct: 5, exitAfterChecks: 3 };
const HOURS = 18;
const WARMUP_MS = 10 * 60_000;
const NEAR = 'near-hyperliquid-phoenix';
const SOL = 'sol-orderly-phoenix';
const ETH = 'eth-phoenix-orderly';
const SOL_HL = 'sol-orderly-hyperliquid';
const LOADING = /^14-day history loading/;
/**
 * Lot sizes (base units per lot) by symbol and venue. The recording holds no markets() answer, so these are set
 * here, of the venues' kind: Hyperliquid 10^-szDecimals, Phoenix base lots, Orderly base ticks.
 */
const LOTS: Record<string, Record<VenueId, number>> = {
  BTC: { hyperliquid: 0.00001, phoenix: 0.0001, orderly: 0.00001 },
  ETH: { hyperliquid: 0.0001, phoenix: 0.001, orderly: 0.0001 },
  SOL: { hyperliquid: 0.01, phoenix: 0.01, orderly: 0.01 },
  NEAR: { hyperliquid: 0.1, phoenix: 0.1, orderly: 0.1 },
  ZEC: { hyperliquid: 0.01, phoenix: 0.01, orderly: 0.01 },
};

/** The synthetic changes of hour h (see the header). */
function shape(h: number, windows: readonly FundingWindow[]): FundingWindow[] {
  return windows.map((w) => {
    if (!w.tradable) return w;
    // With the week in, the scanner also replaces the break-even at this hour's rates by the one on the multi-day
    // spread (scanner.ts, step 5): dropped here with the loading check.
    const loading = w.checks.some((c) => LOADING.test(c.text));
    const checks = w.checks
      .filter((c) => !(loading && c.text === NO_BREAKEVEN_TEXT))
      .map((c) => (LOADING.test(c.text) ? { ok: true, text: '[test] the recording has no second week: judged on its 7 days' } : c));
    let netAprPct = w.netAprPct;
    // NEAR's gross falls to 7 %: held (heldForwardAprPct), less the exit still to pay, it is under 5 %.
    if (w.id === NEAR && h >= 3) netAprPct = 7 - (w.costs.feesPct + w.costs.slippagePct + w.costs.basisPct + w.costs.rescueReservePct);
    if (w.id === SOL && h >= 4) netAprPct = 8;
    if (w.id === ETH && h >= 12) netAprPct = 30;
    if (w.id === SOL_HL && h >= 12) netAprPct = 40;
    return { ...w, checks, netAprPct };
  });
}

interface Step { h: number; d: Decision; veto: string | null; px: Map<string, number> }

/**
 * The recording's costs: a 10-day hold and a 5 bps exit buffer, the ones its hours were priced on. The scenario test is
 * decide's sequence over them, not the hold; the stricter default hurdle is checked on its own below.
 */
const RECORDED_COSTS = { ...DEFAULT_SCANNER_CONFIG.costs, holdHours: 240, basisBufferBps: 5 };

async function run(costs = RECORDED_COSTS): Promise<Step[]> {
  const lines = readRecording(RECORDING);
  const start = replayStart(lines);
  const end = lines.reduce((m, l) => Math.max(m, l.t), 0);
  const clock = new VirtualClock(start);
  const readers = replayReaders(lines, clock);
  const hl = readers.venues.find((v) => v.id === 'hyperliquid')!;
  // The replay engine's Mock price source: every desk symbol priced, a second old.
  const oracle: OracleSource = { price: () => ({ px: 1, at: clock.now() - 1_000 }) };
  let held: HeldPair | null = null;
  let heldVenues = new Set<VenueId>();
  const scanner = new Scanner(readers.venues, [], {
    config: { ...DEFAULT_SCANNER_CONFIG, policy: POLICY, costs }, clock, strategy: () => STRAT, oracle,
    held: () => (held === null ? null : { windowId: held.windowId, since: start }),
    marginHeldAt: () => heldVenues,
  });
  for (let t = start; t < start + WARMUP_MS; t += 60_000) {
    clock.set(t);
    await scanner.scan();
    await scanner.idle();
  }
  // A replay, as serve's: a prompt with no recorded reply passes, labelled replay-only (live it would be held).
  const veto = RecordedVeto.fromFile(VETO_FIXTURE, { replayPassUnrecorded: true });
  const simStart = Date.UTC(2026, 10, 3, 0);
  const span = end - (start + WARMUP_MS);
  let counters: LoopCounters = NO_COUNTERS;
  const steps: Step[] = [];
  for (let h = 0; h < HOURS; h++) {
    clock.set(start + WARMUP_MS + Math.floor((span * h) / (HOURS - 1)));
    const scan = await scanner.scan();
    await scanner.idle();
    const windows = shape(h, scan.windows);
    // Sizes round to whole common lots at the recorded Hyperliquid mark of that scan.
    const marks = new Map((await hl.funding()).map((r) => [r.symbol, r.markPx]));
    const lots: NonNullable<DecideInput['lots']> = {};
    for (const w of windows) {
      const px = marks.get(w.symbol);
      const lot = LOTS[w.symbol];
      if (w.tradable && px != null && lot !== undefined) lots[w.id] = { longLot: lot[w.longVenue as VenueId], shortLot: lot[w.shortVenue as VenueId], px };
    }
    const input: DecideInput = {
      lots,
      now: simStart + h * HOUR, hourly: true, windows, held, strategy: STRAT, rules: checkRulesOf(STRAT), maxNotionalUsd: POLICY.max_notional_usd,
      priceBandBps: POLICY.price_band_bps, freeMarginUsd: { hyperliquid: 20, phoenix: 20, orderly: 20 }, liveRescue: LIVE_RESCUE, counters,
      gross14dAprPct: Object.fromEntries(windows.map((w) => [w.id, scanner.carry(w.id)?.estimate.gross.d14AprPct ?? null])),
      // What loop.ts measures: the held legs' margin at 1.5x (their P&L is 0 here).
      freedMarginUsd: held === null ? {} : Object.fromEntries([...heldVenues].map((v) => [v, held!.legUsd / 1.5])),
    };
    const d = decide(input);
    let line: string | null = null;
    let counted = d.counters;
    if (d.vetoCandidate !== null) {
      const w = windows.find((x) => x.id === d.vetoCandidate)!;
      const c = scanner.carry(w.id);
      const act = d.act as { legUsd: number; leverage: number };
      const facts = vetoFacts(w, {
        kind: d.act!.kind === 'rotate' ? 'rotate' : 'enter', legUsd: act.legUsd, leverage: act.leverage, minNetAprPct: STRAT.minNetAprPct,
        // This check's counts, before the act's own marks (the rotation resets the better counts).
        hoursAbove: (d.act!.kind === 'rotate' ? skipAct(input, d).betterByWindow[w.id] : d.counters.aboveByWindow[w.id]) ?? 0,
        grossApr14dPct: c?.estimate.gross.d14AprPct ?? null,
        // What serve's riskFacts adds from the carry: the 24 h move per leg. The recording holds no book or listing time
        // for these legs' sizes, so those stay unknown, as they would in a serve whose reads failed.
        legs: {
          long: { openInterestUsd: c?.long.oiUsd ?? null, priceMove24hPct: c?.long.priceMove24hPct ?? null },
          short: { openInterestUsd: c?.short.oiUsd ?? null, priceMove24hPct: c?.short.priceMove24hPct ?? null },
        },
      });
      if (process.env.E10_DUMP_FACTS === '1') console.error(`FACTS ${JSON.stringify(facts)}`);
      const r = await checkVeto(veto, facts, { now: input.now });
      line = r.line;
      // As loop.ts: no readable verdict holds the act with no hold-out; a refusal holds the window out.
      if (r.held) counted = skipAct(input, d);
      else if (r.veto.verdict === 'veto') counted = skipAct(input, d, { vetoed: true });
    }
    // loop.ts carries the act out; here it simply happens.
    if (counted === d.counters && d.act !== null) {
      if (d.act.kind === 'exit') {
        held = null;
        heldVenues = new Set();
      } else {
        const id = d.act.kind === 'enter' ? d.act.windowId : d.act.toId;
        const w = windows.find((x) => x.id === id)!;
        held = { windowId: id, symbol: w.symbol, since: input.now, legUsd: d.act.legUsd, entryNetAprPct: w.netAprPct, pnlUsd: 0 };
        heldVenues = new Set([w.longVenue, w.shortVenue] as VenueId[]);
      }
    }
    counters = counted;
    steps.push({ h, d, veto: line, px: new Map([...marks].filter((e): e is [string, number] => e[1] != null)) });
  }
  return steps;
}

test('a recorded hour of mainnet scans, one an hour: enter, compression, exit, cooldown, enter elsewhere, rotate', async (t) => {
  const steps = await run();
  for (const s of steps) {
    t.diagnostic(`h${String(s.h).padStart(2, '0')} ${s.d.decision.action.padEnd(6)} ${s.d.decision.reason}${s.veto === null ? '' : ` [veto: ${s.veto}]`}`);
  }
  const acts = steps.map((s) => s.d.decision.action);
  assert.deepEqual(acts, [
    'wait', 'wait', 'enter', 'hold', 'hold', 'exit',
    'wait', 'wait', 'wait', 'wait', 'wait', 'enter',
    'hold', 'hold', 'hold', 'rotate', 'hold', 'hold',
  ]);
  const at = (h: number) => steps[h]!.d;
  // Sizes: at most the 12 USD leg, rounded down to whole lots at the recorded mark, never under 10 USD.
  // The qty is whole common lots of the two venues, and legUsd is that qty at the price it was sized at.
  const sized = (h: number, kind: 'enter' | 'rotate', id: string) => {
    const a = at(h).act as { kind: string; legUsd: number; leverage: number; qty: string; windowId?: string; toId?: string };
    assert.equal(a.kind, kind);
    assert.equal(a.windowId ?? a.toId, id);
    assert.equal(a.leverage, 1.5, 'Phoenix has no live rescue');
    assert.ok(a.legUsd >= 10 && a.legUsd <= 12, `${a.legUsd}`);
    const [symbol, longVenue, shortVenue] = id.split('-') as [string, VenueId, VenueId];
    const lots = LOTS[symbol.toUpperCase()]!;
    const q = toQty(a.qty);
    assert.ok(q > 0n && q % commonLot(toQty(lots[longVenue]), toQty(lots[shortVenue])) === 0n, `${a.qty} in whole lots`);
    const px = steps[h]!.px.get(symbol.toUpperCase())!;
    assert.ok(Math.abs(Number(a.qty) * px - a.legUsd) < 0.01, `${a.qty} at ${px} is ${a.legUsd}`);
  };
  sized(2, 'enter', NEAR);
  assert.match(at(2).decision.reason, /^Enter NEAR \(long Hyperliquid, short Phoenix\): \d+\.\d % net, 3 of 3 hours above 5 %/);
  assert.match(at(5).decision.reason, /^Exit NEAR: [0-4]\.\d % net of the exit, under your 5 % minimum, 3 of 3 hours in a row$/);
  assert.match(at(6).decision.reason, /^Cooling down after the exit, 5\.0 h left/);
  sized(11, 'enter', SOL);
  // SOL long Orderly / short Hyperliquid nets more, but its switch moves margin onto Hyperliquid and never pays back on
  // a 12 USD leg; ETH sits on the venues that hold the margin.
  // The gain is over SOL as held (its gross less the exit), not its 8 % entry net.
  assert.match(at(14).decision.reason, /ETH beats it by 1\d\.\d pts, 3 of 4 hours$/);
  sized(15, 'rotate', ETH);
  assert.equal((at(15).act as { fromId: string }).fromId, SOL);
  for (const s of steps) {
    assert.equal(s.d.vetoCandidate !== null, s.d.act?.kind === 'enter' || s.d.act?.kind === 'rotate');
    assert.equal(s.veto !== null, s.d.vetoCandidate !== null, 'the veto is asked before every enter and rotate');
    if (['wait', 'hold'].includes(s.d.decision.action)) assert.equal(s.d.act, null);
    // The recorded verdicts pass; a prompt with no recording passes in replay only, said so. Either way the act stands.
    if (s.veto !== null) assert.match(s.veto, /^(NEAR AI passed|\S+: no recorded NEAR AI risk check reply for this prompt: passed in replay only; live, the entry would wait$)/);
  }
});

test('on the default costs (168 h, 10 bps) the recorded NEAR hours never clear the 5 % minimum: the stricter hurdle, on purpose', async () => {
  assert.deepEqual([DEFAULT_SCANNER_CONFIG.costs.holdHours, DEFAULT_SCANNER_CONFIG.costs.basisBufferBps], [168, 10]);
  const steps = await run(DEFAULT_SCANNER_CONFIG.costs);
  // NEAR's recorded hours, unshaped until hour 3, net under the minimum: never counted, never entered. What is
  // entered later is only the windows shape() sets a net on (SOL from hour 4, ETH from hour 12).
  for (const s of steps.slice(0, 3)) {
    assert.equal(s.d.decision.action, 'wait');
    assert.match(s.d.decision.reason, /^No window clears the entry rules; best NEAR \d\.\d % net: \d\.\d % net, under your 5 % minimum$/);
  }
  const entered = steps.flatMap((s) => (s.d.act?.kind === 'enter' ? [s.d.act.windowId] : s.d.act?.kind === 'rotate' ? [s.d.act.toId] : []));
  assert.ok(!entered.includes(NEAR), entered.join(', '));
  assert.deepEqual(entered, [SOL, ETH]);
});
