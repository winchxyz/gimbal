// The risk engine on a scripted desk: level → watch → rescue as the mark moves against a short, the rescue trigger
// (journal + RescueProgress at `detect`) with its hand-computed amount, a venue that stops answering, and POST /stress:
// it drives the desk to rescue on testnet and in replay, and is refused on mainnet (engine and HTTP).

import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { test } from 'node:test';
import type { DeskState, HealthMap, JournalEntry, Mode, RescueProgress, StreamEvent } from '@gimbal/shared';
import { DEFAULT_STRATEGY } from '../scanner/config.ts';
import type { Scanner } from '../scanner/scanner.ts';
import { EngineServer } from '../server.ts';
import type { AccountState, Position } from '../venues/venue.ts';
import type { DeskSnapshot, DeskSource, LegInput } from './engine.ts';
import type { RescueTrigger } from './engine.ts';
import { DESK_VIEW_STALE_MS, LANDED_SETTLE_MS, RESCUE_LAPSE_MS, RESCUE_RETRY_MS, RiskEngine, STRESS_MARGIN_PTS, StressRefused } from './engine.ts';
import type { AdlReport, AdlWatch } from './adl.ts';
import type { TradeLeg } from '../trade/legs.ts';
import { STRESS_MAINNET_REASON } from './stress-route.ts';
import { VenueHealth } from './venue-health.ts';

/** Short 1 ETH on Hyperliquid opened at 2000 with 400 USD (m = 2 %), long 1 ETH on Phoenix with plenty. */
class Desk implements DeskSource {
  mark = 2000;
  phoenixDown: string | null = null;
  phoenixFree = 1000;
  hlMargin = 400;
  phoenixMargin = 1000;
  deskView: DeskSnapshot['deskView'];
  reads = 0;

  async read(): Promise<DeskSnapshot> {
    this.reads++;
    const short: Position = { symbol: 'ETH', size: -1, entryPx: 2000, liqPx: null, marginUsd: 400, unrealizedPnlUsd: 2000 - this.mark, leverage: 5, fundingSinceOpenUsd: 1.5, unsettledFundingUsd: 0 };
    const long: Position = { symbol: 'ETH', size: 1, entryPx: 2000, liqPx: null, marginUsd: 1000, unrealizedPnlUsd: this.mark - 2000, leverage: 2, fundingSinceOpenUsd: -1, unsettledFundingUsd: 0.25 };
    const acct = (venue: 'hyperliquid' | 'phoenix', equity: number, free: number, p: Position): AccountState => ({
      venue, address: venue, time: 1, equityUsd: equity, freeMarginUsd: free, maintenanceMarginUsd: 0.02 * this.mark, positions: [p],
    });
    const legs: LegInput[] = [
      { venue: 'hyperliquid', symbol: 'ETH', lotSize: 1e-4, account: acct('hyperliquid', this.hlMargin + 2000 - this.mark, 0, short), position: short, markPx: this.mark, feesUsd: -0.4, unpriced: false },
    ];
    if (this.phoenixDown === null) {
      legs.push({ venue: 'phoenix', symbol: 'ETH', lotSize: 1e-3, account: acct('phoenix', this.phoenixMargin + this.mark - 2000, this.phoenixFree, long), position: long, markPx: this.mark, feesUsd: -0.7, unpriced: false });
    }
    return {
      deskId: 'alpha', owner: 'owner.testnet', contract: 'gimbal.testnet', reserveUsd: 50, paused: null, legs,
      reads: [{ venue: 'hyperliquid', ms: 120, error: null }, { venue: 'phoenix', ms: 90, error: this.phoenixDown }],
      ...(this.deskView === undefined ? {} : { deskView: this.deskView }),
    };
  }
}

function engine(mode: Mode, desk = new Desk()) {
  const events: StreamEvent[] = [];
  let t = 1_000_000;
  const risk = new RiskEngine({
    mode, source: desk, strategy: () => DEFAULT_STRATEGY, health: new VenueHealth(), publish: (e) => events.push(e),
    clock: { now: () => (t += 5_000) },
  });
  const of = <K extends StreamEvent['type']>(type: K) => events.filter((e) => e.type === type).map((e) => e.data) as Extract<StreamEvent, { type: K }>['data'][];
  return { risk, desk, events, of };
}

test('level, watch, rescue as the mark rises against the short; one trigger with the margin back to the watch line', async () => {
  const { risk, desk, of } = engine('testnet');
  // 2000: e = 400 / 2000 = 0.2, distance (0.2 − 0.02) / 1.02 = 17.647 %: level.
  let d = (await risk.tick())!;
  assert.equal(d.health, 'level');
  const hl = d.legs[0]!;
  assert.equal(hl.side, 'short');
  assert.ok(Math.abs(hl.distanceToLiqPct! - 0.18 / 1.02 * 100) < 1e-9);
  assert.ok(Math.abs(hl.liqPx! - 2400 / 1.02) < 1e-9, '(400 + 2000) / 1.02');
  assert.ok(Math.abs(hl.marginRatio - 0.1) < 1e-12, '40 / 400');
  assert.equal(d.netDelta, 0);
  assert.equal(d.equityUsd, 400 + 1000 + 50);
  assert.deepEqual(d.pnl, { fundingUsd: 1.5 - 1 + 0.25, feesUsd: -0.4 - 0.7, priceUsd: 0, netUsd: 0.75 - 1.1 });

  // 2100: equity 300, e = 300 / 2100, distance 12.045 %: watch.
  desk.mark = 2100;
  d = (await risk.tick())!;
  assert.equal(d.health, 'watch');
  assert.deepEqual(d.legs.map((l) => l.venue), ['hyperliquid', 'phoenix']);

  // 2200: equity 200, e = 0.090909, distance 6.952 %: rescue. To 15 %: e = 0.15 × 1.02 + 0.02 = 0.173,
  // 0.173 × 2200 − 200 = 180.60 USD, from Phoenix (1000 free).
  desk.mark = 2200;
  d = (await risk.tick())!;
  assert.equal(d.health, 'rescue');
  const rescues = of('rescue') as RescueProgress[];
  assert.equal(rescues.length, 1);
  assert.deepEqual({ ...rescues[0]!, id: '', startedAt: 0 }, { id: '', from: 'phoenix', to: 'hyperliquid', amountUsd: 180.6, step: 'detect', startedAt: 0, elapsedS: 0, tx: [] });
  const journal = of('journal') as JournalEntry[];
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.kind, 'rescue');
  assert.match(journal[0]!.summary, /^health rescue: hyperliquid ETH short is 6\.95 % from liquidation, under the 8\.00 % rescue line; 180\.60 USD from phoenix brings it back to 15\.00 %$/);
  assert.deepEqual(journal[0]!.numbers, { venue: 'hyperliquid', distancePct: 6.95, rescuePct: 8, watchPct: 15, amountUsd: 180.6, from: 'phoenix' });

  // Still in rescue: no second trigger. Back to 2000: one point of hysteresis, then level.
  await risk.tick();
  assert.equal(of('rescue').length, 1);
  desk.mark = 2000;
  assert.equal((await risk.tick())!.health, 'level');
  // The desk events carry every read.
  assert.deepEqual((of('desk') as DeskState[]).map((x) => x.health), ['level', 'watch', 'rescue', 'rescue', 'level']);
});

test('the partner\'s free margin does not cover the rescue: it comes from the reserve', async () => {
  const desk = new Desk();
  desk.phoenixFree = 100;
  desk.mark = 2200;
  const { risk, of } = engine('replay', desk);
  await risk.tick();
  assert.equal((of('rescue') as RescueProgress[])[0]!.from, 'reserve');
});

test('a venue that stops answering: health down (one journal line), its leg kept at its last numbers and watched', async () => {
  const { risk, desk, of } = engine('testnet');
  await risk.tick();
  assert.deepEqual(of('health').at(-1), { intents: 'ok', near: 'ok', hyperliquid: 'ok', phoenix: 'ok', orderly: 'ok' });
  desk.phoenixDown = 'phoenix account: fetch failed';
  const d = (await risk.tick())!;
  assert.equal(of('health').at(-1)!.phoenix, 'down');
  assert.deepEqual(d.legs.map((l) => l.venue), ['hyperliquid', 'phoenix'], 'kept');
  assert.equal(d.health, 'watch', 'a leg that cannot be seen is watched');
  await risk.tick();
  const errors = (of('journal') as JournalEntry[]).filter((j) => j.kind === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.summary, 'phoenix not answering: phoenix account: fetch failed');
  desk.phoenixDown = null;
  assert.equal((await risk.tick())!.health, 'level');
  assert.equal(of('health').at(-1)!.phoenix, 'ok');
  assert.equal(of('health').length, 3, 'published on change only');
});

test('stress on testnet: the rescue line goes 5 points over the nearest leg, the desk goes to rescue; off restores it', async () => {
  const { risk, of } = engine('testnet');
  await risk.tick();
  const r = await risk.stress(true);
  assert.equal(r.health, 'rescue');
  // Nearest: the short at 17.647 %.
  assert.ok(Math.abs(r.rescueDistancePct! - (0.18 / 1.02 * 100 + STRESS_MARGIN_PTS)) < 1e-9);
  const j = (of('journal') as JournalEntry[])[0]!;
  assert.equal(j.kind, 'rescue');
  assert.match(j.summary, /\(stress test\)/);
  assert.equal(j.numbers.stress, 1);
  assert.equal(of('rescue').length, 1);
  assert.equal(risk.lines()[0]!.lines.watchPct, r.rescueDistancePct! + 7, 'the watch line keeps its gap');
  const off = await risk.stress(false);
  assert.deepEqual(off, { health: 'level', rescueDistancePct: null });
  assert.equal(risk.stressLine, null);
});

test('stress is refused on mainnet, and with no leg to stress', async () => {
  const { risk, events } = engine('mainnet');
  await risk.tick();
  const before = events.length;
  await assert.rejects(risk.stress(true), (err: unknown) => err instanceof StressRefused && err.status === 403 && /refused on mainnet/.test(err.message));
  await assert.rejects(risk.stress(false), StressRefused);
  assert.equal(events.length, before, 'nothing published');
  assert.equal(risk.stressLine, null);

  const empty = new RiskEngine({
    mode: 'replay', strategy: () => DEFAULT_STRATEGY, health: new VenueHealth(), publish: () => {},
    source: { read: async () => ({ deskId: 'd', owner: 'o', contract: 'c', reserveUsd: 0, paused: null, legs: [], reads: [] }) },
  });
  await assert.rejects(empty.stress(true), (err: unknown) => err instanceof StressRefused && err.status === 409 && /no leg is open/.test(err.message));
});

/** An engine on a clock the test moves, with a rescuer that records the triggers. */
function rig(options: { adl?: AdlWatch; desk?: Desk; rescuer?: (x: RescueTrigger) => void | boolean; source?: DeskSource; running?: () => string | null } = {}) {
  let t = 1_000_000;
  const events: StreamEvent[] = [];
  const triggers: RescueTrigger[] = [];
  const desk = options.desk ?? new Desk();
  const risk = new RiskEngine({
    mode: 'testnet', source: options.source ?? desk, strategy: () => DEFAULT_STRATEGY, health: new VenueHealth(), publish: (e) => events.push(e),
    clock: { now: () => t }, monotonic: () => t, rescuer: (x) => { triggers.push(x); return options.rescuer?.(x); }, ...(options.adl !== undefined ? { adl: options.adl } : {}),
    ...(options.running !== undefined ? { rescuerRunning: options.running } : {}),
  });
  const journal = () => events.filter((e) => e.type === 'journal').map((e) => e.data as JournalEntry);
  const health = () => events.filter((e) => e.type === 'health').map((e) => e.data as HealthMap);
  return { risk, desk, triggers, events, journal, health, now: () => t, advance: (ms: number) => { t += ms; } };
}

async function within<T>(p: Promise<T>, ms = 1_000): Promise<T | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'hung'>((r) => { timer = setTimeout(() => r('hung'), ms); });
  try {
    return await Promise.race([p, hung]);
  } finally {
    clearTimeout(timer);
  }
}

test('rescue triggers are per leg: two legs in rescue are both triggered, the nearer its line first', async () => {
  const desk = new Desk();
  desk.hlMargin = 150;          // short: e = 0.075, (0.075 − 0.02) / 1.02 = 5.39 %
  desk.phoenixMargin = 100;     // long:  e = 0.05,  (0.05 − 0.02) / 0.98 = 3.06 %
  const { risk, triggers } = rig({ desk });
  assert.equal((await risk.tick())!.health, 'rescue');
  assert.deepEqual(triggers.map((x) => [x.venue, x.attempt]), [['phoenix', 0], ['hyperliquid', 0]]);
  await risk.tick();
  assert.equal(triggers.length, 2, 'still running: not again');
});

test('a failed rescue is triggered again after the backoff, a lapsed one (no end reported) too, each once', async () => {
  const desk = new Desk();
  desk.hlMargin = 150;
  desk.phoenixMargin = 100;
  const { risk, triggers, journal, advance } = rig({ desk });
  await risk.tick();
  const [phoenix, hl] = triggers;
  risk.rescueEnded(phoenix!.id, false);
  advance(5_000);
  await risk.tick();
  assert.equal(triggers.length, 2, 'inside the backoff');
  advance(RESCUE_RETRY_MS);
  await risk.tick();
  assert.equal(triggers.length, 3);
  assert.deepEqual([triggers[2]!.venue, triggers[2]!.attempt], ['phoenix', 1]);
  assert.match(journal().at(-1)!.summary, /^health rescue \(again: attempt 2\): phoenix ETH long/);
  assert.equal(journal().at(-1)!.numbers.attempt, 2);
  await risk.tick();
  assert.equal(triggers.length, 3);
  // Hyperliquid's rescue never reported an end: it lapses after RESCUE_LAPSE_MS, then waits its backoff.
  advance(RESCUE_LAPSE_MS + RESCUE_RETRY_MS);
  await risk.tick();
  assert.equal(triggers.length, 4);
  assert.deepEqual([triggers[3]!.venue, triggers[3]!.attempt], ['hyperliquid', 1]);
  assert.notEqual(triggers[3]!.id, hl!.id);
  // Both legs back over their lines: the next rescue starts afresh.
  desk.hlMargin = 400;
  desk.phoenixMargin = 1000;
  await risk.tick();
  desk.hlMargin = 150;
  await risk.tick();
  assert.deepEqual([triggers.at(-1)!.venue, triggers.at(-1)!.attempt], ['hyperliquid', 0]);
});

test('an ADL response that hangs (a slow MPC signature) blocks neither the reads, the rescue triggers nor stress; one check at a time', async () => {
  let calls = 0;
  let release!: (r: AdlReport | null) => void;
  const adl = { check: () => { calls++; return new Promise<AdlReport | null>((r) => { release = r; }); } } as unknown as AdlWatch;
  const { risk, desk, triggers } = rig({ adl });
  assert.notEqual(await within(risk.tick()), 'hung');
  assert.equal(calls, 1);
  desk.mark = 2200;
  const d = await within(risk.tick());
  assert.notEqual(d, 'hung', 'the tick does not wait on the ADL response');
  assert.equal((d as DeskState).health, 'rescue');
  assert.equal(triggers.length, 1);
  desk.mark = 2000;
  const stressed = await within(risk.stress(true));
  assert.notEqual(stressed, 'hung');
  assert.equal(calls, 1, 'no second check while one runs');
  release(null);
  await risk.adlRunning;
  await risk.tick();
  assert.equal(calls, 2);
  release(null);
  await risk.stop();
});

test('every ADL report is journaled: each attempt that failed and the one that unwound (bug C: no end without a line)', async () => {
  const leg = { venue: 'hyperliquid', symbol: 'ETH' } as unknown as TradeLeg;
  const report = (attempt: number, stage: AdlReport['stage']): AdlReport => ({
    stage, findings: [{ index: 0, leg, baseline: -500n, pos: -300n, change: 'shrank' }],
    result: null, tx: [], summary: `ADL attempt ${attempt} ${stage}`, attempt, attemptsLeft: 3 - attempt, ownerAlert: false,
  });
  const answers = [report(1, 'failed'), null, null, report(2, 'failed'), null, report(3, 'unwound'), null];
  const adl = { check: async () => answers.shift() ?? null } as unknown as AdlWatch;
  const { risk, journal } = rig({ adl });
  for (let i = 0; i < 7; i++) {
    await risk.tick();
    await risk.adlRunning;
  }
  assert.deepEqual(journal().filter((j) => j.kind === 'adl').map((j) => [j.summary, j.numbers.attempt, j.numbers.stage]), [
    ['ADL attempt 1 failed', 1, 'failed'], ['ADL attempt 2 failed', 2, 'failed'], ['ADL attempt 3 unwound', 3, 'unwound'],
  ]);
  assert.equal(journal().filter((j) => j.kind === 'error').length, 0);
});

/** One leg in rescue (ratio 4) whose mark cannot be told; `entryPx` 0 leaves no price at all. */
function blindLeg(entryPx: number): DeskSource {
  const p: Position = { symbol: 'ETH', size: 1, entryPx, liqPx: null, marginUsd: 10, unrealizedPnlUsd: -entryPx, leverage: 1, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0 };
  const account: AccountState = { venue: 'hyperliquid', address: 'x', time: 1, equityUsd: 10, freeMarginUsd: 0, maintenanceMarginUsd: 40, positions: [p] };
  return {
    read: async () => ({
      deskId: 'd', owner: 'o', contract: 'c', reserveUsd: 0, paused: null, reads: [],
      legs: [{ venue: 'hyperliquid', symbol: 'ETH', lotSize: 1e-4, account, position: p, markPx: null, feesUsd: 0, unpriced: false }],
    }),
  };
}

test('a leg in rescue with no mark: the amount is estimated on the entry price, or marked unknown; never NaN', async () => {
  const est = rig({ source: blindLeg(2000) });
  assert.equal((await est.risk.tick())!.health, 'rescue');
  // 40 + 15 % of 1 × 2000 − 10 = 330 USD.
  assert.deepEqual([est.triggers[0]!.amountUsd, est.triggers[0]!.amountKnown], [330, true]);
  assert.match(est.journal()[0]!.summary, /330\.00 USD from reserve \(estimated on the entry price: no mark\)/);
  const blind = rig({ source: blindLeg(0) });
  await blind.risk.tick();
  assert.deepEqual([blind.triggers[0]!.amountUsd, blind.triggers[0]!.amountKnown], [0, false]);
  assert.match(blind.journal()[0]!.summary, /the amount is unknown \(no mark, no entry price\)/);
  assert.equal(blind.journal()[0]!.numbers.amountKnown, 0);
  assert.ok(!JSON.stringify(blind.journal()).includes('NaN'));
});

test('a rescuer that throws does not end the tick: the ADL check still starts, the trigger counts as failed and is tried again', async () => {
  let checks = 0;
  const adl = { check: async () => { checks++; return null; } } as unknown as AdlWatch;
  let throws = true;
  const desk = new Desk();
  desk.mark = 2200;
  const { risk, triggers, journal, advance } = rig({ desk, adl, rescuer: () => { if (throws) throw new Error('E9 is not wired'); } });
  const d = await risk.tick();
  assert.equal(d!.health, 'rescue');
  await risk.adlRunning;
  assert.equal(checks, 1);
  assert.equal(triggers.length, 1);
  assert.match(journal().at(-1)!.summary, /could not start: E9 is not wired/);
  throws = false;
  advance(RESCUE_RETRY_MS);
  await risk.tick();
  assert.equal(triggers.length, 2);
  assert.equal(triggers[1]!.attempt, 1);
});

test('a rescuer that does not take the trigger (no live rescuer yet): it is published at detect, as without one; a taken one is not', async () => {
  let take = false;
  const desk = new Desk();
  desk.mark = 2200;
  const r = rig({ desk, rescuer: () => take, running: () => null });
  const detected = () => r.events.filter((e) => e.type === 'rescue').map((e) => (e.data as RescueProgress).step);
  await r.risk.tick();
  assert.equal(r.triggers.length, 1);
  assert.deepEqual(detected(), ['detect'], 'not taken: the owner sees it at detect');
  // The live rescuer runs now: the trigger (lapsed, no end reported) fires again and is taken; it reports its own steps.
  take = true;
  r.advance(RESCUE_LAPSE_MS + RESCUE_RETRY_MS);
  await r.risk.tick();
  assert.equal(r.triggers.length, 2);
  assert.deepEqual(detected(), ['detect'], 'no detect progress for a taken trigger');
});

test('stop() is final: no read, no ADL check and no stress after it', async () => {
  let checks = 0;
  const adl = { check: async () => { checks++; return null; } } as unknown as AdlWatch;
  const { risk, desk } = rig({ adl });
  await risk.tick();
  await risk.adlRunning;
  await risk.stop();
  const reads = desk.reads;
  assert.notEqual(await risk.tick(), null, 'the last desk');
  await assert.rejects(risk.stress(true), (err: unknown) => err instanceof StressRefused && err.status === 503);
  assert.equal(desk.reads, reads);
  assert.equal(risk.adlRunning, null);
  assert.equal(checks, 1);
});

test('stop() during a tick whose read is out: that tick publishes and triggers nothing, and the ADL watch is stopped', async () => {
  const desk = new Desk();
  desk.mark = 2200;                                        // the read would be a rescue
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let stops = 0;
  const adl = { check: async () => null, stop: () => { stops++; } } as unknown as AdlWatch;
  const { risk, triggers, journal } = rig({ adl, source: { read: async () => { await gate; return desk.read(); } } });
  const ticking = risk.tick();
  await new Promise((r) => setImmediate(r));
  const stopping = risk.stop();
  release();
  assert.equal(await ticking, null);
  await stopping;
  assert.equal(triggers.length, 0);
  assert.equal(journal().length, 0);
  assert.equal(risk.desk, null);
  assert.equal(stops, 1);
});

test('an ADL watch that gives up: an error line in the journal, only the owner can act', async () => {
  const leg = { venue: 'phoenix', symbol: 'ETH' } as unknown as TradeLeg;
  const report: AdlReport = {
    stage: 'gave-up', findings: [{ index: 1, leg, baseline: 500n, pos: 300n, change: 'shrank' }],
    result: null, tx: [], summary: 'ADL on phoenix ETH 0.5 -> 0.3: the pair\'s unwind attempts are spent', attempt: 3, attemptsLeft: 0, ownerAlert: true,
  };
  let answers = [report];
  const adl = { check: async () => answers.shift() ?? null } as unknown as AdlWatch;
  const { risk, journal } = rig({ adl });
  await risk.tick();
  await risk.adlRunning;
  answers = [];
  const errors = journal().filter((j) => j.kind === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.summary, /^owner: ADL on phoenix ETH 0\.5 -> 0\.3: the pair's unwind attempts are spent/);
  assert.equal(errors[0]!.numbers.stage, 'gave-up');
  assert.deepEqual(journal().filter((j) => j.kind === 'adl').map((j) => j.numbers.attemptsLeft), [0], 'the attempt is journaled as adl too');
});

test('the desk view: never read is NEAR down and the desk at watch; a late read slow; older than a minute down again', async () => {
  const desk = new Desk();
  const { risk, health, journal, now, advance } = rig({ desk });
  desk.deskView = { at: null, error: 'get_desk has not answered for 5 s' };
  let d = (await risk.tick())!;
  assert.equal(health().at(-1)!.near, 'down');
  assert.equal(d.health, 'watch', 'reserve and pause unknown: not level');
  assert.match(journal().at(-1)!.summary, /^near not answering: the desk view \(get_desk\) is never read: get_desk has not answered/);
  desk.deskView = { at: now(), error: null };
  d = (await risk.tick())!;
  assert.equal(health().at(-1)!.near, 'ok');
  assert.equal(d.health, 'level');
  advance(10_000);
  desk.deskView = { at: now() - 10_000, error: 'get_desk has not answered for 10 s' };
  d = (await risk.tick())!;
  assert.equal(health().at(-1)!.near, 'slow');
  assert.equal(d.health, 'level');
  advance(DESK_VIEW_STALE_MS);
  await risk.tick();
  assert.equal(health().at(-1)!.near, 'down');
});

// ---- HTTP: POST /stress through the engine server ----

const stubScanner = {
  scan: async () => ({ scan: { venues: 0, failed: [], at: 1 }, windows: [], notes: { ms: 0, unpriced: [], historyReads: 0 } }),
  history: () => null,
} as unknown as Scanner;

async function withServer(mode: Mode, fn: (call: (method: string, body?: string, headers?: OutgoingHttpHeaders) => Promise<{ status: number; json: Record<string, unknown> }>, server: EngineServer, risk: RiskEngine) => Promise<void>): Promise<void> {
  const { risk } = engine(mode);
  const server = new EngineServer({ mode, scanner: stubScanner, strategy: DEFAULT_STRATEGY, policy: null, intervalMs: 3_600_000, stress: risk });
  const port = await server.start(0);
  const call = (method: string, body?: string, headers?: OutgoingHttpHeaders) => new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}/stress`, { method, headers: headers ?? {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: text === '' ? {} : JSON.parse(text) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  try {
    await fn(call, server, risk);
  } finally {
    await server.stop();
  }
}

test('POST /stress in replay: a bare `curl -X POST` (no body, no content type) starts it; { on: false } ends it', async () => {
  await withServer('replay', async (call, _server, risk) => {
    // The same answer shape as POST /rotate and /close; what it led to arrives as events.
    const on = await call('POST');
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.deepEqual(on.json, { ok: true });
    assert.equal(risk.desk!.health, 'rescue');
    const off = await call('POST', '{"on":false}', { 'content-type': 'application/json' });
    assert.deepEqual(off.json, { ok: true });
    assert.equal(risk.desk!.health, 'level');
    assert.equal(risk.stressLine, null);
    assert.equal((await call('POST', '{"on":"yes"}', { 'content-type': 'application/json' })).status, 400);
    assert.equal((await call('POST', '{"x":1}', { 'content-type': 'application/json' })).status, 400);
    // A body still needs the JSON content type; GET is not a stress.
    assert.equal((await call('POST', '{}', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await call('GET')).status, 405);
    // A browser page from another site sends its Origin: refused before the route.
    assert.equal((await call('POST', undefined, { origin: 'https://evil.example' })).status, 403);
  });
});

test('POST /stress on mainnet: 403 with the reason, nothing stressed', async () => {
  await withServer('mainnet', async (call, server) => {
    const r = await call('POST');
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { ok: false, reason: STRESS_MAINNET_REASON });
    assert.equal((await call('POST', '{"on":true}', { 'content-type': 'application/json' })).status, 403);
    assert.equal(server.state().desk, null);
  });
});

/** A desk whose read takes its snapshot at once and, while held, answers only when released (a slow venue read). */
function slowReads(desk: Desk) {
  let gate: Promise<void> | null = null;
  const source: DeskSource = {
    read: async () => {
      const snap = await desk.read();
      if (gate !== null) await gate;
      return snap;
    },
  };
  /** Holds the next read; the returned function lets it answer. */
  const hold = (): (() => void) => {
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    return () => { gate = null; open(); };
  };
  return { source, hold };
}

test('a read that started before a rescue landed triggers nothing; a read that started after it still does', async () => {
  const desk = new Desk();
  desk.hlMargin = 150;   // 5.39 % from liquidation, under the 8 % rescue line
  const { source, hold } = slowReads(desk);
  const { risk, triggers, advance } = rig({ desk, source });
  await risk.tick();
  assert.equal(triggers.length, 1);
  const first = triggers[0]!.id;

  const release = hold();
  const inFlight = risk.tick();
  // The margin lands while that read is still out, so its numbers predate the landing.
  advance(1_000);
  risk.rescueEnded(first, true);
  release();
  const stale = (await inFlight)!;
  assert.ok(stale.legs[0]!.distanceToLiqPct! < 8, 'the late read still shows the leg under its line');
  assert.equal(triggers.length, 1, 'no second rescue on a read from before the landing');

  // A read that starts after the landing (and its settle time) is judged as usual: still under the line, afresh.
  advance(5_000);
  await risk.tick();
  assert.equal(triggers.length, 2);
  assert.equal(triggers[1]!.attempt, 0);
  assert.notEqual(triggers[1]!.id, first);
});

test('a read started within LANDED_SETTLE_MS of a landing triggers nothing; the first one after it does', async () => {
  const desk = new Desk();
  desk.hlMargin = 150;
  const { risk, triggers, advance } = rig({ desk });
  await risk.tick();
  risk.rescueEnded(triggers[0]!.id, true);
  // The venue's API may still answer from before the landing (Phoenix lags its chain).
  advance(LANDED_SETTLE_MS - 1_000);
  await risk.tick();
  assert.equal(triggers.length, 1, 'no trigger inside the settle window');
  advance(1_000);
  await risk.tick();
  assert.equal(triggers.length, 2, 'settled and still under the line: a fresh rescue');
  assert.equal(triggers[1]!.attempt, 0);
});

test('rescue A lands after the leg bounced out and trigger B was refused: a stale read pays nothing twice', async () => {
  const desk = new Desk();
  desk.hlMargin = 150;
  const { source, hold } = slowReads(desk);
  const { risk, triggers, advance } = rig({ desk, source });
  await risk.tick();
  const a = triggers[0]!.id;
  // A runs; the leg bounces out of rescue (its record goes), then back in: trigger B.
  desk.hlMargin = 400;
  advance(5_000);
  await risk.tick();
  desk.hlMargin = 150;
  advance(5_000);
  await risk.tick();
  assert.equal(triggers.length, 2);
  const b = triggers[1]!.id;
  // The rescuer refuses B (one at a time: A still runs).
  risk.rescueEnded(b, false);
  // A read starts, B's backoff passes while it is out, and A lands before it answers.
  const release = hold();
  const inFlight = risk.tick();
  advance(RESCUE_RETRY_MS * 2);
  risk.rescueEnded(a, true);
  release();
  await inFlight;
  assert.equal(triggers.length, 2, 'no retry of B on numbers from before A landed');
  // Once a read could see A's margin, the leg is judged afresh (here still under the line).
  advance(LANDED_SETTLE_MS);
  await risk.tick();
  assert.equal(triggers.length, 3);
  assert.equal(triggers[2]!.attempt, 0);
});

test('a landing while the leg\'s venue is unread: its kept numbers trigger nothing until a settled read', async () => {
  const desk = new Desk();
  desk.hlMargin = 400;
  desk.phoenixMargin = 100;   // the Phoenix long 3.06 % from liquidation
  const { risk, triggers, advance } = rig({ desk });
  await risk.tick();
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0]!.venue, 'phoenix');
  risk.rescueEnded(triggers[0]!.id, true);
  desk.phoenixDown = 'timeout';
  advance(LANDED_SETTLE_MS + 5_000);
  const d = (await risk.tick())!;
  assert.equal(d.legs.find((l) => l.venue === 'phoenix')!.distanceToLiqPct! < 8, true, 'the kept numbers are from before the landing');
  assert.equal(triggers.length, 1, 'no trigger on numbers read before the landing');
  desk.phoenixDown = null;
  advance(5_000);
  await risk.tick();
  assert.equal(triggers.length, 2);
  assert.equal(triggers[1]!.attempt, 0);
});

test('a rescue the rescuer is still running never lapses; its late end still counts', async () => {
  const desk = new Desk();
  desk.hlMargin = 150;
  desk.phoenixMargin = 1000;
  let running: string | null = null;
  const { risk, triggers, advance } = rig({ desk, running: () => running });
  await risk.tick();
  assert.equal(triggers.length, 1);
  running = triggers[0]!.id;
  // A real rescue (reserve -> Hyperliquid, or out of Hyperliquid through Arbitrum) can outlast RESCUE_LAPSE_MS.
  advance(RESCUE_LAPSE_MS + RESCUE_RETRY_MS * 4);
  await risk.tick();
  assert.equal(triggers.length, 1, 'not lapsed while it runs');
  // It lands late: the leg starts afresh (attempt 0), not as a retry of a lapsed one.
  risk.rescueEnded(running, true);
  running = null;
  advance(LANDED_SETTLE_MS);
  await risk.tick();
  assert.equal(triggers.length, 2);
  assert.equal(triggers[1]!.attempt, 0);
  // Once nothing runs it, a rescue with no end reported lapses as before.
  advance(RESCUE_LAPSE_MS + RESCUE_RETRY_MS);
  await risk.tick();
  assert.equal(triggers.length, 3);
  assert.equal(triggers[2]!.attempt, 1);
});
