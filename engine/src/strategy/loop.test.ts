import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { JournalEntry, StrategyConfig, StrategyDecision, StreamEvent, Window as FundingWindow } from '@gimbal/shared';
import { DEFAULT_STRATEGY } from '../scanner/config.ts';
import type { DecideInput, Decision } from './decide.ts';
import { LOOP_RULES, NO_COUNTERS } from './decide.ts';
import type { ActOutcome, BookRecord, LoopHands, StrategyLoopOptions } from './loop.ts';
import { HOUR_GRACE_MS, LoopStore, RETRY_AFTER_MS, StrategyLoop, loopStateFile, notEnterable } from './loop.ts';
import type { VetoSource } from './veto.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const HOUR = 3_600_000;
// 10:05 UTC: past the grace after the top of the hour.
const T0 = Date.UTC(2026, 10, 3, 10, 5);

function win(id: string, over: Partial<FundingWindow> = {}): FundingWindow {
  const [symbol, longVenue, shortVenue] = id.split('-') as [string, FundingWindow['longVenue'], FundingWindow['shortVenue']];
  return {
    id, symbol: symbol.toUpperCase(), longVenue, shortVenue, grossAprPct: 30, grossApr7dPct: 28,
    costs: { feesPct: 2, slippagePct: 1, basisPct: 1, rescueReservePct: 0 }, netAprPct: 24, usdPerDayPer1k: 0.66,
    breakevenHours: 40, depthUsd: 1e6, intervalsAbove: 5, updatedAt: T0, tradable: true, held: null,
    checks: [{ ok: true, text: 'policy ok' }], switchCostUsd: null, stale: false, ...over,
  };
}

const OK = (reason: string, tx = [{ chain: 'near' as const, id: 'h1', url: 'https://testnet.nearblocks.io/txns/h1' }]): ActOutcome => ({ ok: true, reason, sent: true, tx, feeUsd: 0.5, open: [] });
const REFUSED = (reason: string): ActOutcome => ({ ok: false, reason, sent: false, tx: [], feeUsd: 0, open: [] });

interface World {
  now: number;
  held: { symbol: string; legUsd: number; pnlUsd: number } | null;
  blocked: string | null;
  busy: string | null;
  opens: { symbol: string; legUsd: number; leverage: number; reason: string }[];
  closes: string[];
  openAnswer: (symbol: string) => ActOutcome;
  closeAnswer: () => ActOutcome;
  events: StreamEvent[];
  inputs: DecideInput[];
  next: Omit<Partial<Decision>, 'decision'> & { decision?: Partial<StrategyDecision> };
  windows: FundingWindow[] | null;
  strategy: StrategyConfig;
  trade: boolean;
}

function world(over: Partial<World> = {}): World {
  return {
    now: T0, held: null, blocked: null, busy: null, opens: [], closes: [], events: [], inputs: [],
    openAnswer: () => OK('opened both legs'), closeAnswer: () => OK('closed both legs, flat'),
    next: {}, windows: [win('sol-phoenix-hyperliquid'), win('eth-phoenix-hyperliquid'), win('btc-hyperliquid-phoenix')],
    strategy: { ...DEFAULT_STRATEGY, auto: true }, trade: true, ...over,
  };
}

function fakeHands(w: World): LoopHands {
  return {
    blocked: () => w.blocked,
    held: () => w.held,
    symbolOf: (x) => (x.longVenue === 'phoenix' && x.shortVenue === 'hyperliquid' ? { symbol: x.symbol } : { refused: 'short hyperliquid, long phoenix only' }),
    open: async (r) => {
      w.opens.push({ symbol: r.symbol, legUsd: r.legUsd, leverage: r.leverage, reason: r.reason });
      const a = w.openAnswer(r.symbol);
      if (a.ok) w.held = { symbol: r.symbol, legUsd: r.legUsd, pnlUsd: 0 };
      return a;
    },
    close: async (r) => {
      w.closes.push(r.reason);
      const a = w.closeAnswer();
      if (a.ok) w.held = null;
      return a;
    },
  };
}

/** decide() stand-in: answers w.next (wait by default) and counts nothing but what the test sets. */
function fakeDecide(w: World) {
  return (input: DecideInput): Decision => {
    w.inputs.push(input);
    const d = w.next;
    const heldId = input.held?.windowId ?? null;
    // As decide() does: off with auto off (no act); the act's own marks and the wait reason in the counters.
    const decision: StrategyDecision = input.strategy.auto
      ? { action: 'wait', reason: 'nothing clears the bar', windowId: null, heldId, at: input.now, ...d.decision }
      : { action: 'off', reason: 'Auto is off: the engine watches and you act by hand', windowId: heldId, heldId, at: input.now };
    const act = input.strategy.auto ? (d.act ?? null) : null;
    const c = d.counters ?? input.counters;
    const counters = {
      ...c, lastWaitReason: decision.action === 'wait' ? decision.reason : null, ...(input.hourly ? { lastHourlyAt: input.now } : {}),
      ...(act?.kind === 'exit' ? { lastExitAt: input.now } : {}), ...(act?.kind === 'rotate' ? { rotationsAt: [...c.rotationsAt, input.now] } : {}),
    };
    return { decision, counters, act, vetoCandidate: act?.kind === 'enter' ? act.windowId : act?.kind === 'rotate' ? act.toId : null };
  };
}

function tmpStore(): LoopStore {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-loop-'));
  dirs.push(dir);
  return new LoopStore(loopStateFile(dir, 'testnet', 'gimbal-test.testnet', 'desk-1'));
}

function makeLoop(w: World, store = tmpStore(), over: Partial<StrategyLoopOptions> = {}): StrategyLoop {
  return new StrategyLoop({
    trade: w.trade, strategy: () => w.strategy, policy: () => ({ max_notional_usd: 5000 }) as never, windows: () => w.windows,
    hands: fakeHands(w), freeMargin: async () => ({ hyperliquid: 900, phoenix: 800 }), liveRescue: () => ({ hyperliquid: true, phoenix: false }),
    busy: () => w.busy, store, publish: (e) => w.events.push(e), clock: { now: () => w.now }, log: () => {},
    decide: fakeDecide(w), vetoTimeoutMs: 50,
    facts: async (ws) => ({ lots: Object.fromEntries(ws.map((x) => [x.id, { longLot: '0.01', shortLot: '0.01', px: 100 }])) }), ...over,
  });
}

const decisions = (w: World) => w.events.filter((e) => e.type === 'decision').map((e) => e.data as StrategyDecision);
const journal = (w: World) => w.events.filter((e) => e.type === 'journal').map((e) => e.data as JournalEntry);

test('off: without GIMBAL_TRADE=1 decide() never runs; with auto off it runs (its counts move) and answers off, nothing acts', async () => {
  const w = world({ trade: false });
  const loop = makeLoop(w);
  await loop.check();
  await loop.check();
  assert.equal(w.inputs.length, 0);
  assert.deepEqual(decisions(w).map((d) => d.action), ['off']);
  assert.match(decisions(w)[0]!.reason, /GIMBAL_TRADE is not 1/);

  const w2 = world({ strategy: { ...DEFAULT_STRATEGY, auto: false } });
  w2.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5 } };
  const loop2 = makeLoop(w2);
  await loop2.check();
  assert.equal(w2.inputs.length, 1);
  assert.match(decisions(w2)[0]!.reason, /Auto is off/);
  assert.equal(w2.opens.length, 0);
  // auto turned on: the decision changes from off.
  w2.next = {};
  w2.strategy = { ...DEFAULT_STRATEGY, auto: true };
  await loop2.check();
  assert.equal(w2.inputs.length, 2);
  assert.deepEqual(decisions(w2).map((d) => d.action), ['off', 'wait']);
});

test('the hourly check: the first check past the grace after the top of the hour, once an hour', async () => {
  const w = world({ now: Date.UTC(2026, 10, 3, 10, 0, 30) });
  const loop = makeLoop(w);
  await loop.check();                                    // 10:00:30, inside the grace
  w.now = Date.UTC(2026, 10, 3, 10, 1) + HOUR_GRACE_MS - 60_000;
  await loop.check();                                    // 10:01: hourly
  w.now += 5 * 60_000;
  await loop.check();                                    // 10:06: not again
  w.now = Date.UTC(2026, 10, 3, 11, 2);
  await loop.check();                                    // 11:02: the next hour's
  assert.deepEqual(w.inputs.map((i) => i.hourly), [false, true, false, true]);
  assert.equal(loop.counters.lastHourlyAt, w.now);
  // decide() is fed the policy cap, free margin per venue, live rescue per venue and the windows.
  const i = w.inputs.at(-1)!;
  assert.equal(i.maxNotionalUsd, 5000);
  assert.deepEqual(i.freeMarginUsd, { hyperliquid: 900, phoenix: 800 });
  assert.deepEqual(i.liveRescue, { hyperliquid: true, phoenix: false });
  assert.equal(i.windows.length, 3);
});

test('decision events only when the decision changes; a wait is journaled only when its reason changes', async () => {
  const w = world();
  const loop = makeLoop(w);
  await loop.check();
  w.now += 60_000;
  await loop.check();
  w.next = { decision: { reason: 'sol-phoenix-hyperliquid above the bar 1 of 3 checks', windowId: 'sol-phoenix-hyperliquid' } };
  w.now += 60_000;
  await loop.check();
  await loop.check();
  assert.deepEqual(decisions(w).map((d) => d.reason), ['nothing clears the bar', 'sol-phoenix-hyperliquid above the bar 1 of 3 checks']);
  const waits = journal(w).filter((j) => j.kind === 'wait');
  assert.deepEqual(waits.map((j) => j.summary), ['nothing clears the bar', 'sol-phoenix-hyperliquid above the bar 1 of 3 checks']);
  assert.equal(loop.counters.lastWaitReason, 'sol-phoenix-hyperliquid above the bar 1 of 3 checks');
});

test('enter: the veto (none: "no veto check"), then the open; journaled with numbers and tx; held saved and reloaded', async () => {
  const w = world();
  const store = tmpStore();
  const loop = makeLoop(w, store);
  w.next = { decision: { action: 'enter', reason: '3 checks above the bar', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5 } };
  await loop.check();
  assert.deepEqual(w.opens.map((o) => [o.symbol, o.legUsd, o.leverage]), [['SOL', 500, 1.5]]);
  const enter = journal(w).find((j) => j.kind === 'enter')!;
  assert.match(enter.summary, /enter sol-phoenix-hyperliquid, SOL short hyperliquid, long phoenix, 500 USD a leg at 1.5x/);
  assert.match(String(enter.numbers.veto), /^no veto check on SOL: NEAR_AI_API_KEY is not set/);
  assert.equal(enter.numbers.legUsd, 500);
  assert.equal(enter.tx[0]!.id, 'h1');
  assert.equal(loop.held?.windowId, 'sol-phoenix-hyperliquid');
  assert.deepEqual(loop.heldWindow(), { windowId: 'sol-phoenix-hyperliquid', since: T0 });

  // A restart: the same file gives back the held pair and the counters, and decide() sees the pair as held.
  const saved = JSON.parse(readFileSync(store.path, 'utf8'));
  assert.equal(saved.held.windowId, 'sol-phoenix-hyperliquid');
  w.next = {};
  const again = makeLoop(w, store);
  assert.equal(again.held?.since, T0);
  w.now += HOUR;
  await again.check();
  assert.equal(w.inputs.at(-1)!.held?.windowId, 'sol-phoenix-hyperliquid');
  assert.equal(w.inputs.at(-1)!.held?.entryNetAprPct, 24);
});

test('a veto drops the window: journaled, nothing opened, and decide() sees the veto for an hour', async () => {
  const w = world();
  const reply = (content: string) => ({ content, raw: { choices: [{ message: { content } }] } });
  const veto: VetoSource = { model: 'test-model', configured: true, complete: async () => reply('{"verdict":"veto","reasons":["delisting announced"]}') };
  const loop = makeLoop(w, tmpStore(), { veto });
  w.next = { decision: { action: 'enter', reason: 'go', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5 } };
  await loop.check();
  assert.equal(w.opens.length, 0);
  const v = journal(w).find((j) => j.kind === 'veto')!;
  assert.match(v.summary, /NEAR AI vetoed SOL: delisting announced/);
  assert.equal(v.numbers.vetoModel, 'test-model');
  assert.match(String(v.numbers.vetoReply), /delisting announced/);
  // The verdict is put on the window and republished, so the web shows it.
  const shown = w.events.filter((e) => e.type === 'windows').at(-1)!.data as FundingWindow[];
  assert.equal(shown.find((x) => x.id === 'sol-phoenix-hyperliquid')!.veto?.verdict, 'veto');
  w.next = {};
  w.now += 60_000;
  await loop.check();
  assert.equal(w.inputs.at(-1)!.windows.find((x) => x.id === 'sol-phoenix-hyperliquid')!.veto?.verdict, 'veto');
  w.now += HOUR;
  await loop.check();
  assert.equal(w.inputs.at(-1)!.windows.find((x) => x.id === 'sol-phoenix-hyperliquid')!.veto, undefined);
  // A veto that does not answer in time is a pass.
  const w2 = world();
  const slow: VetoSource = { model: 'test-model', configured: true, complete: () => new Promise(() => {}) };
  const loop2 = makeLoop(w2, tmpStore(), { veto: slow });
  w2.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5 } };
  await loop2.check();
  assert.equal(w2.opens.length, 1);
  assert.match(String(journal(w2).find((j) => j.kind === 'enter')!.numbers.veto), /no veto check on SOL: no answer within/);
});

test('rotate: close the held pair, then open the new one; a refused open is journaled and the desk stays flat', async () => {
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 3 } });
  const loop = makeLoop(w);
  await loop.check();                                    // adopts the venues' SOL pair as its desk window
  assert.equal(loop.held?.windowId, 'sol-phoenix-hyperliquid');
  w.next = { decision: { action: 'rotate', reason: 'eth better by 5 pts for 4 h' }, act: { kind: 'rotate', fromId: 'sol-phoenix-hyperliquid', toId: 'eth-phoenix-hyperliquid', legUsd: 500, leverage: 1.5 } };
  w.now += 60_000;
  await loop.check();
  assert.equal(w.closes.length, 1);
  assert.deepEqual(w.opens.map((o) => o.symbol), ['ETH']);
  assert.equal(loop.held?.windowId, 'eth-phoenix-hyperliquid');
  assert.equal(loop.counters.rotationsAt.length, 1);
  const kinds = journal(w).map((j) => j.kind);
  assert.deepEqual(kinds.filter((k) => k !== 'wait'), ['exit', 'rotate']);

  // The next rotate's open is refused: the close stands, nothing is held, and the journal says the desk is flat.
  w.openAnswer = () => REFUSED('the spread does not cover the round trip');
  w.next = { decision: { action: 'rotate', reason: 'sol back' }, act: { kind: 'rotate', fromId: 'eth-phoenix-hyperliquid', toId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5 } };
  w.now += 60_000;
  await loop.check();
  assert.equal(w.held, null);
  assert.equal(loop.held, null);
  const refused = journal(w).at(-1)!;
  assert.equal(refused.kind, 'refused');
  assert.match(refused.summary, /the spread does not cover the round trip; eth-phoenix-hyperliquid was closed, so the desk stays flat/);
});

test('exit: both legs closed, held cleared, the cooldown starts', async () => {
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 4.2 } });
  const loop = makeLoop(w);
  w.next = { decision: { action: 'exit', reason: 'below the bar 3 checks' }, act: { kind: 'exit', reason: 'below the bar 3 checks' } };
  await loop.check();
  assert.equal(w.closes.length, 1);
  assert.match(w.closes[0]!, /exit sol-phoenix-hyperliquid \(auto\): below the bar 3 checks/);
  assert.equal(loop.held, null);
  assert.equal(loop.counters.lastExitAt, T0);
  const exit = journal(w).find((j) => j.kind === 'exit')!;
  assert.equal(exit.numbers.pnlUsd, 4.2);
});

test('a refused act is journaled once and not tried again before RETRY_AFTER_MS; no hands refuse every act', async () => {
  const w = world({ openAnswer: () => REFUSED('Hyperliquid leg 38 % from liquidation, under 40 %') });
  const loop = makeLoop(w);
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5 } };
  await loop.check();
  w.now += 60_000;
  await loop.check();
  assert.equal(w.opens.length, 1, 'not tried again within RETRY_AFTER_MS');
  w.now += RETRY_AFTER_MS;
  await loop.check();
  assert.equal(w.opens.length, 2);
  // A direction serve does not open: refused once, with the reason, however many checks ask for it.
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'btc-hyperliquid-phoenix', legUsd: 500, leverage: 1.5 } };
  await loop.check();
  w.now += RETRY_AFTER_MS;
  await loop.check();
  assert.equal(journal(w).filter((j) => /btc-hyperliquid-phoenix/.test(j.summary)).length, 1);

  const w2 = world();
  const loop2 = makeLoop(w2, tmpStore(), { hands: null, handsWhy: 'serve holds a pair on mainnet only, this is testnet' });
  w2.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5 } };
  await loop2.check();
  w2.now += 60_000;
  await loop2.check();
  const r = journal(w2).filter((j) => j.kind === 'refused');
  assert.equal(r.length, 1);
  assert.match(r[0]!.summary, /no pair trader here: serve holds a pair on mainnet only/);
  assert.equal(decisions(w2)[0]!.action, 'enter');
});

test('no decision while a rescue or an ADL unwind runs; the hourly check is taken at the next scan', async () => {
  const w = world({ busy: 'rescue r-1 runs' });
  const loop = makeLoop(w);
  await loop.check();
  assert.equal(w.inputs.length, 0);
  w.busy = null;
  w.now += 60_000;
  await loop.check();
  assert.deepEqual(w.inputs.map((i) => i.hourly), [true]);
});

test('POST /rotate and /close: refused at once with the reason, or started through the same path as auto', async () => {
  const w = world({ strategy: { ...DEFAULT_STRATEGY, auto: false }, held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
  const loop = makeLoop(w);
  await loop.check();                                    // the facts and free margin a manual rotate is sized on
  assert.deepEqual(loop.rotate(''), { ok: false, reason: 'POST /rotate needs { "windowId": "<window id>" }' });
  assert.deepEqual(loop.rotate('doge-phoenix-hyperliquid'), { ok: false, reason: 'doge-phoenix-hyperliquid is not in the last scan' });
  w.windows!.push(win('xrp-phoenix-hyperliquid', { checks: [{ ok: false, text: 'oracle stale' }] }));
  assert.match((loop.rotate('xrp-phoenix-hyperliquid') as { reason: string }).reason, /fails a check: oracle stale/);
  assert.match((loop.rotate('btc-hyperliquid-phoenix') as { reason: string }).reason, /short hyperliquid, long phoenix only/);
  w.busy = 'an ADL unwind runs';
  assert.deepEqual(loop.rotate('eth-phoenix-hyperliquid'), { ok: false, reason: 'an ADL unwind runs' });
  w.busy = null;

  // With auto off: a manual rotate, SOL -> ETH, at strategy.legUsd capped by the policy.
  assert.deepEqual(loop.rotate('eth-phoenix-hyperliquid'), { ok: true });
  assert.match((loop.close() as { reason: string }).reason, /the strategy loop is acting \(POST \/rotate eth-phoenix-hyperliquid\)/);
  await loop.idle(1000);
  assert.equal(w.closes.length, 1);
  assert.deepEqual(w.opens.map((o) => [o.symbol, o.legUsd]), [['ETH', 1000]]);
  assert.equal(loop.held?.windowId, 'eth-phoenix-hyperliquid');
  assert.equal(loop.counters.rotationsAt.length, 0, 'a manual rotate is not one of the loop\'s own');
  assert.equal(journal(w).find((j) => j.kind === 'rotate')!.numbers.by, 'POST /rotate (manual)');

  assert.deepEqual(loop.close(), { ok: true });
  await loop.idle(1000);
  assert.equal(w.held, null);
  assert.deepEqual(loop.close(), { ok: false, reason: 'no pair is held: nothing to close' });

  const off = makeLoop(world({ trade: false }));
  assert.match((off.close() as { reason: string }).reason, /GIMBAL_TRADE is not 1/);
});

test('the loop file: atomic JSON next to the trader state; an unusable one starts over with the cooldown and rotations used', () => {
  const store = tmpStore();
  assert.match(store.path, /loop-testnet-gimbal-test\.testnet-desk-1\.json$/);
  assert.deepEqual(store.load(T0), { state: { version: 1, counters: NO_COUNTERS, held: null }, problem: null });
  writeFileSync(store.path, '{ not json');
  const bad = store.load(T0);
  assert.notEqual(bad.problem, null);
  assert.equal(bad.state.counters.lastExitAt, T0);
  assert.equal(bad.state.counters.rotationsAt.length, LOOP_RULES.maxRotationsPerDay);
  store.save({ version: 1, counters: { ...NO_COUNTERS, badChecks: 2 }, held: null });
  assert.equal(store.load(T0).state.counters.badChecks, 2);
  assert.throws(() => loopStateFile('/x', 'mainnet', 'Bad/Id', 'd'));
});

test('notEnterable names the first reason', () => {
  assert.equal(notEnterable(win('sol-phoenix-hyperliquid')), null);
  assert.match(notEnterable(win('sol-phoenix-hyperliquid', { stale: true }))!, /is stale/);
  assert.match(notEnterable(win('sol-phoenix-hyperliquid', { refused: { code: 'E_ORACLE_STALE', reason: 'old price' } }))!, /E_ORACLE_STALE/);
});

test('the book: every carried-out enter and exit, a rotation as its exit then its enter; refusals and vetoes add nothing', async () => {
  const records: BookRecord[] = [];
  const fills = [{ venue: 'phoenix', side: 'BUY' as const, qty: '5', avgPx: 100, feeUsd: 0.1 }, { venue: 'hyperliquid', side: 'SELL' as const, qty: '5', avgPx: 100.1, feeUsd: 0.2 }];
  const w = world();
  w.openAnswer = () => ({ ...OK('opened'), fills });
  const loop = makeLoop(w, tmpStore(), { book: (r) => records.push(r) });
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5 } };
  await loop.check();
  w.next = { decision: { action: 'rotate', reason: 'eth better' }, act: { kind: 'rotate', fromId: 'sol-phoenix-hyperliquid', toId: 'eth-phoenix-hyperliquid', legUsd: 500, leverage: 1.5 } };
  w.now += 60_000;
  await loop.check();
  w.next = { decision: { action: 'exit', reason: 'time stop' }, act: { kind: 'exit', reason: 'time stop' } };
  w.now += 60_000;
  await loop.check();
  assert.deepEqual(records.map((r) => [r.kind, r.windowId, r.rotation?.toId ?? null, r.exitReason]), [
    ['enter', 'sol-phoenix-hyperliquid', null, null],
    ['exit', 'sol-phoenix-hyperliquid', 'eth-phoenix-hyperliquid', 'rotate into eth-phoenix-hyperliquid'],
    ['enter', 'eth-phoenix-hyperliquid', 'eth-phoenix-hyperliquid', null],
    ['exit', 'eth-phoenix-hyperliquid', null, 'time stop'],
  ]);
  assert.deepEqual(records[0]!.legs, fills);
  assert.equal(records[0]!.forecastNetAprPct, 24);
  assert.equal(records[3]!.forecastNetAprPct, 24, 'an exit carries the net it was entered at');
  assert.equal(records[0]!.by, 'auto');
  assert.deepEqual(records[0]!.marginMoves, []);
  // A refused open adds nothing.
  const before = records.length;
  w.openAnswer = () => REFUSED('no');
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5 } };
  w.now += 60_000;
  await loop.check();
  assert.equal(records.length, before);
});
