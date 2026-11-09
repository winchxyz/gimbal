import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import type { JournalEntry, StrategyConfig, StrategyDecision, StreamEvent, Window as FundingWindow } from '@gimbal/shared';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from '../scanner/config.ts';
import type { DecideInput, Decision } from './decide.ts';
import { LOOP_RULES, NO_COUNTERS, decide as realDecide } from './decide.ts';
import { NO_BREAKEVEN_TEXT, isEnterable, profitCheck } from '../scanner/price.ts';
import type { ActOutcome, BookFill, BookRecord, HandsHeld, LoopHands, StrategyLoopOptions } from './loop.ts';
import {
  DEMO_MAX_LOSS_USD, HOUR_GRACE_MS, LEDGER_HOLD_HOURS, LOOP_STATE_VERSION, LoopStore, MAX_OPEN_REFRESHES_PER_DAY, MAX_OPEN_REFRESHES_PER_DAY_ALL, REFRESH_HOLD_MS, RETRY_AFTER_MS,
  NO_VETO_SOURCE, RISK_NOT_ASKED, StrategyLoop, loopStateFile, nextHourlyCheck, notEnterable, parseDemo, parseLoopState,
} from './loop.ts';
import type { RiskActRecord, RiskCheckRecord, RiskLedgerSink } from '../book/risk-ledger.ts';
import { positionIdOf } from '../book/derive.ts';
import type { VetoSource } from './veto.ts';
import { DEMO_ENTRY_TEXT, VETO_SYSTEM_PROMPT } from './veto.ts';
import { NearAiClient, NearAiUnavailable } from '../nearai/client.ts';
import { PASSED_WHY, PASSING_RISK_CHECK } from './test-helpers.ts';

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
  held: (Omit<HandsHeld, 'oneLeg'> & { oneLeg?: HandsHeld['oneLeg'] }) | null;
  blocked: string | null;
  busy: string | null;
  opens: { symbol: string; legUsd: number; leverage: number; qty: string; reason: string; noRefresh?: string; demo?: { maxLossUsd: number } }[];
  /** A rotate's prepareOpen (none: the hands have no such step), and what each call saw: `SYMBOL closes=N`. */
  prepareAnswer?: (symbol: string) => ActOutcome;
  prepares: string[];
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
    now: T0, held: null, blocked: null, busy: null, opens: [], closes: [], events: [], inputs: [], prepares: [],
    openAnswer: () => OK('opened both legs'), closeAnswer: () => OK('closed both legs, flat'),
    next: {}, windows: [win('sol-phoenix-hyperliquid'), win('eth-phoenix-hyperliquid'), win('btc-hyperliquid-phoenix')],
    strategy: { ...DEFAULT_STRATEGY, auto: true }, trade: true, ...over,
  };
}

function fakeHands(w: World): LoopHands {
  return {
    blocked: () => w.blocked,
    held: () => (w.held === null ? null : { ...w.held, oneLeg: w.held.oneLeg ?? null }),
    symbolOf: (x) => (x.longVenue === 'phoenix' && x.shortVenue === 'hyperliquid' ? { symbol: x.symbol } : { refused: 'short hyperliquid, long phoenix only' }),
    ...(w.prepareAnswer === undefined ? {} : {
      prepareOpen: async (r: { symbol: string; noRefresh?: string }) => {
        w.prepares.push(`${r.symbol} closes=${w.closes.length}`);
        return w.prepareAnswer!(r.symbol);
      },
    }),
    open: async (r) => {
      w.opens.push({
        symbol: r.symbol, legUsd: r.legUsd, leverage: r.leverage, qty: r.qty, reason: r.reason, ...(r.noRefresh === undefined ? {} : { noRefresh: r.noRefresh }),
        ...(r.demo === undefined ? {} : { demo: r.demo }),
      });
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
    decide: fakeDecide(w), vetoTimeoutMs: 50, veto: PASSING_RISK_CHECK,
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
  assert.deepEqual(journal(w).map((j) => [j.kind, j.numbers.action]), [['wait', 'off']], 'off is journaled once, on the transition');

  const w2 = world({ strategy: { ...DEFAULT_STRATEGY, auto: false } });
  w2.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
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
  // And the windows the hands refuse (here the wrong direction), so the gate passes over them.
  assert.deepEqual(i.unopenable, { 'btc-hyperliquid-phoenix': 'short hyperliquid, long phoenix only' });
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
  // Every wait carries the top window's net, the minimum, k/N checks and what blocks it.
  const n = waits[1]!.numbers;
  assert.equal(n.action, 'wait');
  assert.equal(n.window, 'sol-phoenix-hyperliquid');
  assert.equal(n.netAprPct, 24);
  assert.equal(n.minNetAprPct, DEFAULT_STRATEGY.minNetAprPct);
  assert.equal(n.checks, `0/${DEFAULT_STRATEGY.enterAfterChecks}`);
  assert.equal(typeof n.block, 'string');
});

test('enter: the veto (none: "no NEAR AI risk check"), then the open; journaled with numbers and tx; held saved and reloaded', async () => {
  const w = world();
  const store = tmpStore();
  const loop = makeLoop(w, store);
  w.next = { decision: { action: 'enter', reason: '3 checks above the bar', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.deepEqual(w.opens.map((o) => [o.symbol, o.legUsd, o.leverage, o.qty]), [['SOL', 500, 1.5, '5']], 'the exact qty decide() sized');
  const enter = journal(w).find((j) => j.kind === 'enter')!;
  assert.match(enter.summary, /enter sol-phoenix-hyperliquid, SOL short hyperliquid, long phoenix, at most 5 SOL \(500 USD\) a leg at 1.5x/);
  assert.equal(enter.numbers.qty, '5');
  assert.match(String(enter.numbers.veto), /^NEAR AI passed SOL$/);
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

test('enter on a window whose stored price the open refreshes: the journal carries the note, nothing is refused', async () => {
  const w = world();
  const loop = makeLoop(w);
  const reason = 'Enter SOL: 24 % net, 3 of 3 hours above 10 %; $500.00 a leg at 1.5x; stored SOL price missing: refreshed at open';
  w.next = { decision: { action: 'enter', reason, windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  const enter = journal(w).find((j) => j.kind === 'enter')!;
  assert.match(enter.summary, /stored SOL price missing: refreshed at open/);
  // The why line carries both: the stored-price note and the risk check's verdict.
  assert.match(enter.summary, /: Enter SOL: .*; stored SOL price missing: refreshed at open; NEAR AI risk check passed \(TEE not attested: no attestation fetched in this run\): no red flag named; opened both legs$/);
  assert.match(decisions(w).at(-1)!.reason, /; stored SOL price missing: refreshed at open; NEAR AI risk check passed \(TEE not attested: no attestation fetched in this run\): no red flag named$/);
  assert.equal(journal(w).some((j) => j.kind === 'refused'), false);
});

test('an enter refused after its open paid for refresh_prices holds the window 6 h, journaled with why; one refused unpaid is retried after 15 min', async () => {
  const w = world();
  const loop = makeLoop(w);
  w.openAnswer = () => ({ ...REFUSED('open refused, nothing signed: the price moved: under one common lot fits the cap'), refreshed: true });
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.equal(w.opens.length, 1);
  const until = new Date(T0 + REFRESH_HOLD_MS).toISOString();
  const held = journal(w).at(-1)!;
  assert.equal(held.kind, 'refused');
  assert.equal(held.summary, `enter sol-phoenix-hyperliquid held until ${until}: refused after the open paid for refresh_prices (open refused, nothing signed: the price moved: under one common lot fits the cap); not tried again for 6 h, so a refusal that repeats does not pay again; ${PASSED_WHY}`);
  assert.equal(held.numbers.holdHours, 6);
  // Past the 15-minute retry: still held, nothing opened, nothing refused again.
  const said = journal(w).length;
  w.now += RETRY_AFTER_MS + 60_000;
  await loop.check();
  assert.equal(w.opens.length, 1);
  assert.equal(journal(w).slice(said).some((j) => j.kind === 'refused'), false);
  // After the hold: tried again.
  w.now = T0 + REFRESH_HOLD_MS + 60_000;
  w.openAnswer = () => OK('opened both legs');
  await loop.check();
  assert.equal(w.opens.length, 2);
  assert.equal(loop.held?.windowId, 'sol-phoenix-hyperliquid');

  // The same refusal with no refresh_prices paid: the usual 15-minute retry.
  // (A refresh the RPC never took is reported so too: serve's hands set `refreshed` only for one that landed.)
  const v = world();
  const vStore = tmpStore();
  const plain = makeLoop(v, vStore);
  v.openAnswer = () => REFUSED('open refused, nothing signed: the stored SOL price (missing) could not be refreshed before the open: near rpc: HTTP 503');
  v.next = w.next;
  await plain.check();
  const vSaved = JSON.parse(readFileSync(vStore.path, 'utf8')) as { holds?: unknown; refreshes?: unknown };
  assert.equal(vSaved.holds, undefined, 'no hold saved');
  assert.equal(vSaved.refreshes, undefined, 'nothing counted for the caps');
  v.now += RETRY_AFTER_MS + 60_000;
  await plain.check();
  assert.equal(v.opens.length, 2);
  assert.equal(journal(v).some((j) => j.summary.includes('held until')), false);
});

test('the opens send at most 12 refresh_prices per symbol per UTC day: saved, journaled when hit, then the open is told not to refresh until 00:00 UTC', async () => {
  const w = world();
  const store = tmpStore();
  store.save({ version: LOOP_STATE_VERSION, counters: { ...NO_COUNTERS }, held: null, refreshes: { day: '2026-11-03', bySymbol: { SOL: MAX_OPEN_REFRESHES_PER_DAY - 1, ETH: 3 } } });
  const loop = makeLoop(w, store);
  w.openAnswer = () => ({ ...OK('opened both legs'), refreshed: true });
  const enter: World['next'] = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  const exit: World['next'] = { decision: { action: 'exit', reason: 'below the bar' }, act: { kind: 'exit', reason: 'below the bar' } };
  w.next = enter;
  await loop.check();
  assert.equal(w.opens[0]!.noRefresh, undefined, 'the 12th may still be sent');
  const cap = journal(w).find((j) => j.summary.startsWith('refresh_prices cap'))!;
  assert.equal(cap.summary, 'refresh_prices cap: the strategy loop\'s opens sent 12 refresh_prices of SOL on 2026-11-03 (UTC), the most a day; no open of SOL that needs one is sent before 00:00 UTC');
  const saved = JSON.parse(readFileSync(store.path, 'utf8')) as { refreshes: unknown };
  assert.deepEqual(saved.refreshes, { day: '2026-11-03', bySymbol: { SOL: 12, ETH: 3 } });
  // A restart reads the day's count: the next SOL open may not refresh.
  w.next = exit;
  w.now += 60_000;
  await loop.check();
  loop.stop();
  const again = makeLoop(w, store);
  w.next = enter;
  w.now += 60_000;
  await again.check();
  assert.equal(w.opens[1]!.noRefresh, 'the strategy loop\'s 12 refresh_prices of SOL for 2026-11-03 (UTC) are used; the next may go after 00:00 UTC');
  // The next UTC day starts the count over.
  w.next = exit;
  w.now = Date.UTC(2026, 10, 4, 0, 10);
  await again.check();
  w.next = enter;
  w.now += 60_000;
  await again.check();
  assert.equal(w.opens[2]!.noRefresh, undefined);
  assert.deepEqual((JSON.parse(readFileSync(store.path, 'utf8')) as { refreshes: unknown }).refreshes, { day: '2026-11-04', bySymbol: { SOL: 1 } });
});

test('a rotate refreshes the target price before it closes the held pair; a refresh that fails keeps the pair, journaled and held 6 h', async () => {
  const failed = REFUSED('the stored ETH price (missing) could not be refreshed: near rpc: HTTP 503');
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 3 }, prepareAnswer: () => ({ ...failed, refreshed: true }) });
  const loop = makeLoop(w);
  await loop.check();                                    // adopts the venues' SOL pair as its desk window
  const rotate: World['next'] = { decision: { action: 'rotate', reason: 'eth better' }, act: { kind: 'rotate', fromId: 'sol-phoenix-hyperliquid', toId: 'eth-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  w.next = rotate;
  w.now += 60_000;
  await loop.check();
  assert.deepEqual(w.prepares, ['ETH closes=0']);
  assert.deepEqual([w.closes.length, w.opens.length], [0, 0], 'nothing closed, nothing opened');
  assert.equal(loop.held?.windowId, 'sol-phoenix-hyperliquid');
  const lines = journal(w).filter((j) => j.kind === 'refused').map((j) => j.summary);
  assert.ok(lines.includes(`rotate sol-phoenix-hyperliquid -> eth-phoenix-hyperliquid not carried out: ${failed.reason}; sol-phoenix-hyperliquid is kept, nothing closed; ${PASSED_WHY}`), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`rotate eth-phoenix-hyperliquid held until ${new Date(w.now + REFRESH_HOLD_MS).toISOString()}`)), lines.join('\n'));
  w.now += RETRY_AFTER_MS + 60_000;
  await loop.check();
  assert.equal(w.prepares.length, 1, 'held: not tried again');

  // A refresh that works: the price first, then the close, then the open.
  const v = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 3 }, prepareAnswer: () => ({ ...OK('the stored ETH price (missing) refreshed before the close'), refreshed: true }) });
  const ok = makeLoop(v);
  await ok.check();
  v.next = rotate;
  v.now += 60_000;
  await ok.check();
  assert.deepEqual(v.prepares, ['ETH closes=0']);
  assert.deepEqual([v.closes.length, v.opens.map((o) => o.symbol)], [1, ['ETH']]);
  assert.equal(ok.held?.windowId, 'eth-phoenix-hyperliquid');
});

test('the opens send at most 24 refresh_prices a UTC day over all symbols: saved with the per-symbol counts, journaled when hit', async () => {
  const w = world();
  const store = tmpStore();
  store.save({ version: LOOP_STATE_VERSION, counters: { ...NO_COUNTERS }, held: null, refreshes: { day: '2026-11-03', bySymbol: { SOL: 5, ETH: 11, BTC: 7 } } });
  const loop = makeLoop(w, store);
  w.openAnswer = () => ({ ...OK('opened both legs'), refreshed: true });
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.equal(w.opens[0]!.noRefresh, undefined, 'the 24th may still be sent');
  const cap = journal(w).filter((j) => j.summary.startsWith('refresh_prices cap'));
  assert.deepEqual(cap.map((j) => j.summary), [`refresh_prices cap: the strategy loop's opens sent ${MAX_OPEN_REFRESHES_PER_DAY_ALL} refresh_prices on 2026-11-03 (UTC) over all symbols, the most a day; no open that needs one is sent before 00:00 UTC`]);
  assert.deepEqual((JSON.parse(readFileSync(store.path, 'utf8')) as { refreshes: unknown }).refreshes, { day: '2026-11-03', bySymbol: { SOL: 6, ETH: 11, BTC: 7 } });
  // ETH (11 of its 12) after a restart: refused by the day's total, not its own count.
  w.next = { decision: { action: 'exit', reason: 'below the bar' }, act: { kind: 'exit', reason: 'below the bar' } };
  w.now += 60_000;
  await loop.check();
  loop.stop();
  const again = makeLoop(w, store);
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'eth-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  w.now += 60_000;
  await again.check();
  assert.equal(w.opens[1]!.symbol, 'ETH');
  assert.equal(w.opens[1]!.noRefresh, 'the strategy loop\'s 24 refresh_prices for 2026-11-03 (UTC), all symbols, are used; the next may go after 00:00 UTC');
  again.stop();
});

test('the 6 h hold after a paid refusal is saved: a restart keeps it until it ends, then the act is tried again', async () => {
  const w = world();
  const store = tmpStore();
  const loop = makeLoop(w, store);
  w.openAnswer = () => ({ ...REFUSED('open refused, nothing signed: the price moved'), refreshed: true });
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.equal(w.opens.length, 1);
  const saved = JSON.parse(readFileSync(store.path, 'utf8')) as { holds: Record<string, { until: number; reason: string }> };
  assert.deepEqual(Object.keys(saved.holds).sort(), ['enter sol-phoenix-hyperliquid', 'rotate sol-phoenix-hyperliquid']);
  assert.equal(saved.holds['enter sol-phoenix-hyperliquid']!.until, T0 + REFRESH_HOLD_MS);
  assert.match(saved.holds['enter sol-phoenix-hyperliquid']!.reason, /^enter sol-phoenix-hyperliquid held until /);
  loop.stop();
  // Restarted 1 h later: still held, nothing opened, nothing journaled again.
  w.now += HOUR;
  const restarted = makeLoop(w, store);
  const said = journal(w).length;
  await restarted.check();
  assert.equal(w.opens.length, 1);
  assert.equal(journal(w).slice(said).some((j) => j.kind === 'refused'), false);
  restarted.stop();
  // Restarted after the hold ended: tried again.
  w.now = T0 + REFRESH_HOLD_MS + 60_000;
  w.openAnswer = () => OK('opened both legs');
  const later = makeLoop(w, store);
  await later.check();
  assert.equal(w.opens.length, 2);
  later.stop();
});

test('an open refused after a refresh_prices that failed on chain (paid, refreshed): held 6 h and counted for the caps', async () => {
  const w = world();
  const store = tmpStore();
  const loop = makeLoop(w, store);
  w.openAnswer = () => ({ ...REFUSED('open refused, nothing signed: the stored SOL price (missing) could not be refreshed before the open: refresh_prices failed in transaction H6: Exceeded the prepaid gas.'), refreshed: true });
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  const saved = JSON.parse(readFileSync(store.path, 'utf8')) as { holds: Record<string, { until: number }>; refreshes: unknown };
  assert.equal(saved.holds['enter sol-phoenix-hyperliquid']!.until, T0 + REFRESH_HOLD_MS);
  assert.deepEqual(saved.refreshes, { day: '2026-11-03', bySymbol: { SOL: 1 } });
  // A retry 15 min later (the usual one for an unpaid refusal) does not come: the failure does not repeat every check.
  w.now += RETRY_AFTER_MS + 60_000;
  await loop.check();
  assert.equal(w.opens.length, 1);
  loop.stop();
});

test('a saved hold longer than 6 h from now (a clock that jumped, a hand-edited file) is cut to 6 h on load and saved so', async () => {
  const w = world();
  const store = tmpStore();
  const reason = 'enter sol-phoenix-hyperliquid held until 2026-12-03T10:05:00.000Z: refused after the open paid for refresh_prices (the price moved)';
  store.save({ version: LOOP_STATE_VERSION, counters: { ...NO_COUNTERS }, held: null, holds: { 'enter sol-phoenix-hyperliquid': { until: T0 + 30 * 24 * HOUR, reason } } });
  const loop = makeLoop(w, store);
  const saved = JSON.parse(readFileSync(store.path, 'utf8')) as { holds: Record<string, { until: number; reason: string }> };
  assert.deepEqual(saved.holds, { 'enter sol-phoenix-hyperliquid': { until: T0 + REFRESH_HOLD_MS, reason } });
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.equal(w.opens.length, 0, 'held');
  loop.stop();
  // Restarted 5 h later: still held to T0 + 6 h, not 6 h from the restart.
  w.now = T0 + 5 * HOUR;
  const restarted = makeLoop(w, store);
  await restarted.check();
  assert.equal(w.opens.length, 0);
  restarted.stop();
  w.now = T0 + REFRESH_HOLD_MS + 60_000;
  const later = makeLoop(w, store);
  await later.check();
  assert.equal(w.opens.length, 1, 'tried again once the 6 h are over');
  later.stop();
});

test('every refresh_prices an open sent counts toward the caps: its own and those before its parts', async () => {
  const w = world();
  const store = tmpStore();
  store.save({ version: LOOP_STATE_VERSION, counters: { ...NO_COUNTERS }, held: null, refreshes: { day: '2026-11-03', bySymbol: { SOL: 10, ETH: 11 } } });
  const loop = makeLoop(w, store);
  w.openAnswer = () => ({ ...OK('opened both legs'), refreshed: true, refreshes: 3 });
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.deepEqual((JSON.parse(readFileSync(store.path, 'utf8')) as { refreshes: unknown }).refreshes, { day: '2026-11-03', bySymbol: { SOL: 13, ETH: 11 } });
  // Both caps are passed in one open (10 -> 13 of 12, 21 -> 24 of 24): each journaled once.
  const cap = journal(w).filter((j) => j.summary.startsWith('refresh_prices cap')).map((j) => j.summary);
  assert.equal(cap.length, 2);
  assert.match(cap[0]!, /sent 13 refresh_prices of SOL on 2026-11-03/);
  assert.match(cap[1]!, new RegExp(`sent ${MAX_OPEN_REFRESHES_PER_DAY_ALL} refresh_prices on 2026-11-03 \\(UTC\\) over all symbols`));
  loop.stop();
});

test('a veto drops the window: journaled, nothing opened, held out by counters.vetoedUntil (saved), shown on the window', async () => {
  const w = world();
  const reply = (content: string) => ({ content, raw: { choices: [{ message: { content } }] } });
  const veto: VetoSource = { model: 'test-model', configured: true, complete: async () => reply('{"verdict":"veto","reasons":["delisting announced"]}') };
  const loop = makeLoop(w, tmpStore(), { veto });
  w.next = { decision: { action: 'enter', reason: 'go', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.equal(w.opens.length, 0);
  const v = journal(w).find((j) => j.kind === 'veto')!;
  assert.equal(v.summary, 'sol-phoenix-hyperliquid: NEAR AI risk check refused (TEE not attested: no attestation fetched in this run): delisting announced; not entered, held out for 6 h');
  // The why line is kept with the hold-out, so the waits say why the window is out.
  assert.equal(loop.counters.vetoWhy?.['sol-phoenix-hyperliquid'], 'NEAR AI risk check refused (TEE not attested: no attestation fetched in this run): delisting announced');
  assert.equal(v.numbers.vetoModel, 'test-model');
  assert.match(String(v.numbers.vetoReply), /delisting announced/);
  // The verdict is put on the window and republished, so the web shows it.
  const shown = w.events.filter((e) => e.type === 'windows').at(-1)!.data as FundingWindow[];
  assert.equal(shown.find((x) => x.id === 'sol-phoenix-hyperliquid')!.veto?.verdict, 'veto');
  // The hold is the counters' (decide() reads it), on disk; decide() gets the scan's windows as they are.
  assert.equal(loop.counters.vetoedUntil['sol-phoenix-hyperliquid'], T0 + LOOP_RULES.vetoHoldHours * HOUR);
  w.next = {};
  w.now += 60_000;
  await loop.check();
  assert.equal(w.inputs.at(-1)!.counters.vetoedUntil['sol-phoenix-hyperliquid'], T0 + LOOP_RULES.vetoHoldHours * HOUR);
  assert.equal(w.inputs.at(-1)!.windows.find((x) => x.id === 'sol-phoenix-hyperliquid')!.veto, undefined);
  // A manual rotate into it is refused while it is held out.
  assert.match((loop.rotate('sol-phoenix-hyperliquid') as { reason: string }).reason, /refused by the NEAR AI risk check: held out until/);
  // A check that does not answer in time is held, never passed (the held tests below).
  const w2 = world();
  const slow: VetoSource = { model: 'test-model', configured: true, complete: () => new Promise(() => {}) };
  const loop2 = makeLoop(w2, tmpStore(), { veto: slow });
  w2.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop2.check();
  assert.equal(w2.opens.length, 0);
  assert.match(String(journal(w2).find((j) => j.kind === 'refused')!.numbers.veto), /^the NEAR AI risk check did not answer on SOL: no answer within/);
});

test('rotate: close the held pair, then open the new one; a refused open is journaled and the desk stays flat', async () => {
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 3 } });
  const loop = makeLoop(w);
  await loop.check();                                    // adopts the venues' SOL pair as its desk window
  assert.equal(loop.held?.windowId, 'sol-phoenix-hyperliquid');
  w.next = { decision: { action: 'rotate', reason: 'eth better by 5 pts for 4 h' }, act: { kind: 'rotate', fromId: 'sol-phoenix-hyperliquid', toId: 'eth-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
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
  w.next = { decision: { action: 'rotate', reason: 'sol back' }, act: { kind: 'rotate', fromId: 'eth-phoenix-hyperliquid', toId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
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
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  w.now += 60_000;
  await loop.check();
  assert.equal(w.opens.length, 1, 'not tried again within RETRY_AFTER_MS');
  w.now += RETRY_AFTER_MS;
  await loop.check();
  assert.equal(w.opens.length, 2);
  // A direction serve does not open: refused once, with the reason, however many checks ask for it.
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'btc-hyperliquid-phoenix', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  w.now += RETRY_AFTER_MS;
  await loop.check();
  assert.equal(journal(w).filter((j) => /btc-hyperliquid-phoenix/.test(j.summary)).length, 1);

  const w2 = world();
  const loop2 = makeLoop(w2, tmpStore(), { hands: null, handsWhy: 'serve holds a pair on mainnet only, this is testnet' });
  w2.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop2.check();
  w2.now += 60_000;
  await loop2.check();
  const r = journal(w2).filter((j) => j.kind === 'refused');
  assert.equal(r.length, 1);
  assert.match(r[0]!.summary, /no pair trader here: serve holds a pair on mainnet only/);
  assert.equal(decisions(w2)[0]!.action, 'enter');
});

test('an open the trader refuses for cost: held out of the entry rules until the next hourly check, its hours start again, the next window entered', async () => {
  const SOL = 'sol-phoenix-hyperliquid';
  const ETH = 'eth-phoenix-hyperliquid';
  const why = 'the expected spread over 7 days, $0.0390, does not cover the round trip $0.0421 (36.7 bps: 4 fills $0.0206, slippage $0.0101, basis buffer $0.0114)';
  const w = world({ openAnswer: (sym) => (sym === 'SOL' ? { ...REFUSED(`open refused, nothing signed: ${why}`), costRefused: why } : OK('opened both legs')) });
  // decide() itself: SOL and ETH both pass the entry rules, SOL ranked first.
  const loop = makeLoop(w, tmpStore(), { decide: undefined });
  for (let h = 0; h < 3; h += 1) {
    w.now = T0 + h * HOUR;
    await loop.check();
  }
  // 12:05, the third hourly check: SOL entered, refused for cost, nothing sent.
  assert.deepEqual(w.opens.map((o) => o.symbol), ['SOL']);
  const refused = journal(w).filter((j) => j.kind === 'refused');
  assert.equal(refused.length, 1);
  assert.match(refused[0]!.summary, new RegExp(`^enter ${SOL}: open refused, nothing signed: the expected spread over 7 days`));
  assert.match(refused[0]!.summary, /; sol-phoenix-hyperliquid is held out of the entry rules until the hourly check at 2026-11-03T13:01:00\.000Z and its hours start again; /);
  // Its count is gone, ETH's stands: the refusal is not counted as an hour SOL passed.
  assert.equal(loop.counters.aboveByWindow[SOL], undefined);
  assert.equal(loop.counters.aboveByWindow[ETH], 3);
  // The next scan: SOL fails the entry rules as `cost` and the loop falls through to ETH, entered.
  w.now = T0 + 2 * HOUR + 60_000;
  await loop.check();
  assert.equal(w.inputs.length, 0, 'decide() is the real one: nothing recorded by the fake');
  assert.deepEqual(w.opens.map((o) => o.symbol), ['SOL', 'ETH']);
  assert.equal(journal(w).filter((j) => j.kind === 'enter').length, 1);
});

test('the cost hold-out ends at the next hourly check; until then decide() is told why, after it the window is counted from 1', async () => {
  const SOL = 'sol-phoenix-hyperliquid';
  const why = 'the expected spread over 7 days, $0.0390, does not cover the round trip $0.0421';
  const w = world({ openAnswer: () => ({ ...REFUSED(`open refused, nothing signed: ${why}`), costRefused: why }) });
  const loop = makeLoop(w);
  w.next = { decision: { action: 'enter', reason: 'go', windowId: SOL }, act: { kind: 'enter', windowId: SOL, legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();                                    // 10:05: refused for cost
  assert.equal(loop.counters.aboveByWindow[SOL], undefined, 'counted this hour, then its count reset');
  w.next = {};
  w.now = T0 + 60_000;
  await loop.check();                                    // 10:06: still held out
  assert.deepEqual(w.inputs.at(-1)!.costRefused, { [SOL]: why });
  w.now = Date.UTC(2026, 10, 3, 11, 0, 30);
  await loop.check();                                    // 11:00:30: before the hourly check, still held out
  assert.equal(w.inputs.at(-1)!.hourly, false);
  assert.ok(w.inputs.at(-1)!.costRefused !== undefined);
  w.now = Date.UTC(2026, 10, 3, 11, 1);
  await loop.check();                                    // 11:01: the hourly check reads it again
  assert.equal(w.inputs.at(-1)!.hourly, true);
  assert.equal(w.inputs.at(-1)!.costRefused, undefined);
  // Other refusals (margin, a stale price) mark nothing.
  const w2 = world({ openAnswer: () => REFUSED('Hyperliquid leg 38 % from liquidation, under 40 %') });
  const loop2 = makeLoop(w2);
  w2.next = { decision: { action: 'enter', reason: 'go', windowId: SOL }, act: { kind: 'enter', windowId: SOL, legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop2.check();
  w2.now += 60_000;
  await loop2.check();
  assert.equal(w2.inputs.at(-1)!.costRefused, undefined);
  assert.equal(loop2.counters.aboveByWindow[SOL], 1, 'a refusal that is not for cost keeps the count');
  // When the next hourly check runs: the grace past this hour's top when not yet taken, else the next hour's.
  assert.equal(nextHourlyCheck(Date.UTC(2026, 10, 3, 10, 0, 30)), Date.UTC(2026, 10, 3, 10, 1));
  assert.equal(nextHourlyCheck(Date.UTC(2026, 10, 3, 10, 1)), Date.UTC(2026, 10, 3, 11, 1));
  assert.equal(nextHourlyCheck(T0), Date.UTC(2026, 10, 3, 11, 1));
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

test('POST /rotate (auto on only) and /close (always): refused at once with the reason, or started through the same path as auto', async () => {
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
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

  // Auto off: nothing new opens, a rotate is refused.
  w.strategy = { ...DEFAULT_STRATEGY, auto: false };
  assert.match((loop.rotate('eth-phoenix-hyperliquid') as { reason: string }).reason, /^auto is off/);
  w.strategy = { ...DEFAULT_STRATEGY, auto: true };

  // A manual rotate, SOL -> ETH, at strategy.legUsd capped by the policy, sized again when it runs.
  assert.deepEqual(loop.rotate('eth-phoenix-hyperliquid'), { ok: true });
  // A second manual rotate waits for the first (a close never does: see the close-first tests).
  assert.match((loop.rotate('eth-phoenix-hyperliquid') as { reason: string }).reason, /the strategy loop is acting \(POST \/rotate eth-phoenix-hyperliquid\)/);
  await loop.idle(1000);
  assert.equal(w.closes.length, 1);
  assert.deepEqual(w.opens.map((o) => [o.symbol, o.legUsd, o.qty]), [['ETH', 1000, '10']]);
  assert.equal(loop.held?.windowId, 'eth-phoenix-hyperliquid');
  assert.equal(loop.counters.rotationsAt.length, 1, 'a manual rotation counts toward the day\'s');
  assert.equal(journal(w).find((j) => j.kind === 'rotate')!.numbers.by, 'POST /rotate (manual)');

  // POST /close works with auto off.
  w.strategy = { ...DEFAULT_STRATEGY, auto: false };
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
  store.save({ version: 1, counters: { ...NO_COUNTERS, vetoedUntil: { 'sol-phoenix-hyperliquid': T0 + HOUR } }, held: null });
  assert.deepEqual(store.load(T0).state.counters.vetoedUntil, { 'sol-phoenix-hyperliquid': T0 + HOUR });
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
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  w.next = { decision: { action: 'rotate', reason: 'eth better' }, act: { kind: 'rotate', fromId: 'sol-phoenix-hyperliquid', toId: 'eth-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
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
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  w.now += 60_000;
  await loop.check();
  assert.equal(records.length, before);
});

const ENTER_SOL = { kind: 'enter' as const, windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' };

test('a rescue that starts after the check began: re-checked right before the open; refused, tried again next check (no hold-off)', async () => {
  const w = world();
  // The rescue starts while NEAR AI is asked (after the check's own busy() read), once.
  let asked = 0;
  const veto: VetoSource = {
    model: 'test-model', configured: true,
    complete: async () => {
      if (++asked === 1) w.busy = 'rescue r-2 runs';
      const content = '{"verdict":"pass","reasons":[]}';
      return { content, raw: { choices: [{ message: { content } }] } };
    },
  };
  const loop = makeLoop(w, tmpStore(), { veto });
  w.next = { decision: { action: 'enter', reason: 'go' }, act: ENTER_SOL };
  await loop.check();
  assert.equal(w.opens.length, 0);
  assert.match(journal(w).filter((j) => j.kind === 'refused').at(-1)!.summary, /enter sol-phoenix-hyperliquid not carried out: rescue r-2 runs/);
  w.busy = null;
  w.now += 60_000;
  await loop.check();
  assert.equal(w.opens.length, 1, 'tried again on the next check, not after RETRY_AFTER_MS');

  // hands.blocked() is the same gate (a close in flight).
  const w2 = world();
  const loop2 = makeLoop(w2);
  w2.blocked = 'a close runs on SOL';
  w2.next = { decision: { action: 'enter', reason: 'go' }, act: ENTER_SOL };
  await loop2.check();
  assert.equal(w2.opens.length, 0);
  w2.blocked = null;
  w2.now += 60_000;
  await loop2.check();
  assert.equal(w2.opens.length, 1);
});

test('a rotate whose open meets a running rescue: the close stands, nothing opens, the desk stays flat', async () => {
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
  const loop = makeLoop(w);
  await loop.check();
  w.closeAnswer = () => {
    w.busy = 'rescue r-3 runs';
    return OK('closed both legs, flat');
  };
  w.next = { decision: { action: 'rotate', reason: 'eth better' }, act: { kind: 'rotate', fromId: 'sol-phoenix-hyperliquid', toId: 'eth-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  w.now += 60_000;
  await loop.check();
  assert.equal(w.closes.length, 1);
  assert.equal(w.opens.length, 0);
  assert.equal(loop.held, null);
  assert.match(journal(w).at(-1)!.summary, /rotate eth-phoenix-hyperliquid not carried out: rescue r-3 runs; sol-phoenix-hyperliquid was closed, so the desk stays flat/);
  assert.equal(loop.counters.lastExitAt, w.now, 'flat: the cooldown starts');
});

test('an open that failed after orders went out: the venues\' position is held, booked and journaled as an error', async () => {
  const records: BookRecord[] = [];
  const w = world();
  w.openAnswer = (symbol) => {
    w.held = { symbol, legUsd: 300, pnlUsd: 0 };
    return { ok: false, reason: 'stopped with orders out: socket closed', sent: true, tx: [], feeUsd: 0.2, open: [] };
  };
  const loop = makeLoop(w, tmpStore(), { book: (r) => records.push(r) });
  w.next = { decision: { action: 'enter', reason: 'go' }, act: ENTER_SOL };
  await loop.check();
  assert.equal(loop.held?.windowId, 'sol-phoenix-hyperliquid');
  assert.equal(loop.held?.legUsd, 300);
  assert.deepEqual(records.map((r) => [r.kind, r.windowId]), [['enter', 'sol-phoenix-hyperliquid']]);
  const e = journal(w).find((j) => j.kind === 'error')!;
  assert.match(e.summary, /stopped with orders out: socket closed; the venues hold SOL \(300 USD a leg\): held from now/);
  assert.equal(journal(w).filter((j) => j.kind === 'refused').length, 0, 'not "refused, nothing signed"');
});

test('an exit that sent orders and did not end flat is tried again on the next check (no hold-off)', async () => {
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
  w.closeAnswer = () => ({ ok: false, reason: 'one leg did not fill', sent: true, tx: [], feeUsd: 0.1, open: [] });
  const loop = makeLoop(w);
  w.next = { decision: { action: 'exit', reason: 'below the bar' }, act: { kind: 'exit', reason: 'below the bar' } };
  await loop.check();
  assert.equal(journal(w).filter((j) => j.kind === 'error').length, 1);
  w.closeAnswer = () => OK('closed both legs, flat');
  w.now += 60_000;
  await loop.check();
  assert.equal(w.closes.length, 2);
  assert.equal(loop.held, null);
});

test('one leg is never held: closed reduce-only at once (auto off too), retried on the checks past its backoff, journaled and published as exit', async () => {
  const w = world({ strategy: { ...DEFAULT_STRATEGY, auto: false }, held: { symbol: 'SOL', legUsd: 250, pnlUsd: 0, oneLeg: { venue: 'phoenix', qty: '2.5' } } });
  w.closeAnswer = () => ({ ok: false, reason: 'Phoenix did not answer', sent: false, tx: [], feeUsd: 0, open: [] });
  const loop = makeLoop(w);
  await loop.check();
  assert.equal(w.inputs.length, 0, 'no decide() while one leg is open');
  assert.equal(w.closes.length, 1);
  assert.match(w.closes[0]!, /one leg open: phoenix 2.5, closed reduce-only/);
  const d = decisions(w).at(-1)!;
  assert.equal(d.action, 'exit');
  assert.match(d.reason, /^one leg open: phoenix 2.5/);
  assert.equal(journal(w).at(-1)!.kind, 'error');
  assert.match(journal(w).at(-1)!.summary, /^one leg open: phoenix 2.5: the close did not end flat: Phoenix did not answer; tried again in 5 s$/);
  w.now += 60_000;
  await loop.check();
  assert.equal(w.closes.length, 2, 'retried: its 5 s wait is over');
  // Nothing was signed (sent false): no backoff, the same 5 s, the same line not journaled again.
  assert.equal(journal(w).filter((j) => j.kind === 'error').length, 1);
  w.closeAnswer = () => OK('closed, flat');
  w.now += 60_000;
  await loop.check();
  assert.equal(w.held, null);
  assert.equal(journal(w).at(-1)!.kind, 'exit');
  assert.equal(loop.counters.lastExitAt, w.now);
});

test('a one-leg close that keeps failing with orders sent backs off: 5 s doubling to 2 min, one journal line per step; unsent refusals stay at 5 s; flat or another leg starts over', async () => {
  const w = world({ strategy: { ...DEFAULT_STRATEGY, auto: false }, held: { symbol: 'SOL', legUsd: 250, pnlUsd: 0, oneLeg: { venue: 'orderly', qty: '2.5' } } });
  w.closeAnswer = () => ({ ok: false, reason: 'Orderly refused the reduce-only order', sent: true, tx: [], feeUsd: 0, open: [] });
  const loop = makeLoop(w);
  // A check every second (the scan): the close goes out only when its wait is over.
  const at: number[] = [];
  for (let s = 0; s <= 400; s++) {
    const before = w.closes.length;
    await loop.check();
    if (w.closes.length > before) at.push((w.now - T0) / 1000);
    w.now += 1_000;
  }
  // 0, then +5, +10, +20, +40, +80, +120 (the cap), +120.
  assert.deepEqual(at, [0, 5, 15, 35, 75, 155, 275, 395]);
  const lines = journal(w).filter((j) => j.kind === 'error').map((j) => j.summary.replace(/^.*; tried again in /, ''));
  assert.deepEqual(lines, ['5 s', '10 s', '20 s', '40 s', '1 min 20 s', '2 min'], 'one line per step; the cap repeats nothing');
  assert.equal(journal(w).filter((j) => j.kind === 'error').at(-1)!.numbers['retryMs'], 120_000);

  // Refused before anything was signed (a refresh or an RPC outage): tried every 5 s, never backed off, so the leg is
  // closed within 5 s of the cause clearing.
  const u = world({ strategy: { ...DEFAULT_STRATEGY, auto: false }, held: { symbol: 'SOL', legUsd: 250, pnlUsd: 0, oneLeg: { venue: 'orderly', qty: '2.5' } } });
  u.closeAnswer = () => REFUSED('the stored SOL price could not be refreshed');
  const unsent = makeLoop(u);
  const uat: number[] = [];
  for (let s = 0; s <= 30; s++) {
    const before = u.closes.length;
    await unsent.check();
    if (u.closes.length > before) uat.push((u.now - T0) / 1000);
    u.now += 1_000;
  }
  assert.deepEqual(uat, [0, 5, 10, 15, 20, 25, 30]);
  assert.equal(journal(u).filter((j) => j.kind === 'error').length, 1, 'the same 5 s line once');
  assert.match(decisions(w).at(-1)!.reason, /^one leg open: orderly 2\.5: closing it, reduce-only; the last close failed, next try at /);

  // Another size is a new state: it starts over at 5 s.
  w.held = { ...w.held!, oneLeg: { venue: 'orderly', qty: '1.5' } };
  const n = w.closes.length;
  await loop.check();
  assert.equal(w.closes.length, n + 1, 'tried at once');
  w.now += 5_000;
  await loop.check();
  assert.equal(w.closes.length, n + 2, 'after 5 s');

  // A close that ends flat ends the backoff: the next single leg is tried at once.
  w.now += 10_000;
  w.closeAnswer = () => OK('closed, flat');
  await loop.check();
  assert.equal(w.held, null);
  w.held = { symbol: 'SOL', legUsd: 250, pnlUsd: 0, oneLeg: { venue: 'orderly', qty: '1.5' } };
  w.closeAnswer = () => REFUSED('Orderly refused the reduce-only order');
  const m = w.closes.length;
  await loop.check();
  assert.equal(w.closes.length, m + 1, 'tried at once after a flat close');
});

test('an automatic rotate out of a pair the hands refuse to leave (an Orderly leg) asks no NEAR AI risk check and is journaled once; a manual one still is checked and refused', async () => {
  let asked = 0;
  const veto: VetoSource = {
    model: 'test-model', configured: true,
    complete: async () => {
      asked++;
      return { content: '{"verdict":"pass","reasons":[]}', raw: {} };
    },
  };
  const OUT = 'the held SOL pair has an Orderly leg (PERP_SOL_USDC): its close arms the trader\'s replay watch';
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 3 }, prepareAnswer: () => REFUSED(OUT) });
  const hands = { ...fakeHands(w), rotateOutRefused: () => OUT };
  const loop = makeLoop(w, tmpStore(), { veto, hands });
  await loop.check();                                    // adopts the held pair
  w.next = { decision: { action: 'rotate', reason: 'eth better' }, act: { kind: 'rotate', fromId: 'sol-phoenix-hyperliquid', toId: 'eth-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  for (let h = 1; h <= 3; h++) {
    w.now += HOUR;
    await loop.check();
  }
  assert.equal(asked, 0, 'no NEAR AI call for a rotation the hands refuse');
  assert.deepEqual([w.prepares, w.closes.length, w.opens.length], [[], 0, 0]);
  const refused = journal(w).filter((j) => j.kind === 'refused');
  assert.equal(refused.length, 1, JSON.stringify(refused.map((j) => j.summary)));
  assert.equal(refused[0]!.summary, `rotate sol-phoenix-hyperliquid -> eth-phoenix-hyperliquid not carried out: ${OUT}; sol-phoenix-hyperliquid is kept, nothing closed; ${RISK_NOT_ASKED}`);
  assert.equal(loop.held?.windowId, 'sol-phoenix-hyperliquid');

  // POST /rotate: checked (the owner asked for it) and refused by prepareOpen, as before.
  w.next = {};
  assert.deepEqual(loop.rotate('eth-phoenix-hyperliquid'), { ok: true });
  await loop.idle(2_000);
  assert.equal(asked, 1);
  assert.deepEqual([w.prepares.length, w.closes.length, w.opens.length], [1, 0, 0]);
  assert.match(journal(w).at(-1)!.summary, new RegExp(`^rotate sol-phoenix-hyperliquid -> eth-phoenix-hyperliquid not carried out: ${OUT.replace(/[()]/g, '\\$&')}; sol-phoenix-hyperliquid is kept, nothing closed; NEAR AI risk check passed`));
});

test('a manual close accepted while a check runs: the check\'s act waits for it; a queued manual task does nothing after stop()', async () => {
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  const loop = makeLoop(w, tmpStore(), {
    freeMargin: async () => {
      if (first) {
        first = false;
        await gate;
      }
      return { hyperliquid: 900, phoenix: 800 };
    },
  });
  w.next = { decision: { action: 'exit', reason: 'below the bar' }, act: { kind: 'exit', reason: 'below the bar' } };
  const running = loop.check();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(loop.close(), { ok: true });
  release();
  await running;
  await loop.idle(1000);
  assert.equal(w.closes.length, 1, 'only the manual close ran');
  assert.match(w.closes[0]!, /POST \/close \(manual\)/);

  const w2 = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
  const loop2 = makeLoop(w2);
  assert.deepEqual(loop2.close(), { ok: true });
  loop2.stop();
  await loop2.idle(1000);
  assert.equal(w2.closes.length, 0);
  // An accepted close dropped by the stop says so, never silently.
  assert.deepEqual(journal(w2).map((j) => [j.kind, j.summary]), [['refused', 'POST /close not carried out: serve is stopping; nothing sent; ask again after the restart']]);
});

test('hold: journaled on a change of category and once per hourly check, with the held net, P&L, hours held and bad checks', async () => {
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 1.5 } });
  const loop = makeLoop(w);
  w.next = { decision: { action: 'hold', reason: 'held: 24 % net, above the bar' } };
  await loop.check();                                    // 10:05, hourly
  w.now += 60_000;
  await loop.check();                                    // not hourly, same category
  w.next = { decision: { action: 'hold', reason: 'held: 23.5 % net, above the bar' } };
  w.now += 60_000;
  await loop.check();                                    // only the numbers changed
  w.now = Date.UTC(2026, 10, 3, 11, 2);
  await loop.check();                                    // the next hourly check
  const holds = journal(w).filter((j) => j.numbers.action === 'hold');
  assert.equal(holds.length, 2);
  const n = holds[1]!.numbers;
  assert.equal(n.window, 'sol-phoenix-hyperliquid');
  assert.equal(n.pnlUsd, 1.5);
  assert.equal(n.hoursHeld, Math.round(((w.now - T0) / HOUR) * 100) / 100);
  assert.equal(typeof n.heldNetAprPct, 'number');
  assert.equal(n.badChecks, 0);
  assert.equal(n.hourly, 1);
  // The adoption says since=now is an assumption.
  assert.match(journal(w).find((j) => j.numbers.action === 'adopt')!.summary, /held since now is an assumption/);
});

test('the owner\'s check counts: fed to decide() as rules, on the start line and in the journal; a change keeps the counts reached', async () => {
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
  assert.equal(w.strategy.enterAfterChecks, 3);
  assert.equal(w.strategy.exitAfterChecks, 6);
  const loop = makeLoop(w);
  assert.match(loop.startLine(), /enter after 3 hourly checks in a row, exit after 6 \(owner settings\)/);
  // Two bad hours counted under exit 3.
  w.strategy = { ...w.strategy, exitAfterChecks: 3 };
  w.next = { decision: { action: 'hold', reason: 'held: under the minimum' }, counters: { ...NO_COUNTERS, badChecks: 2 } };
  await loop.check();
  assert.deepEqual(w.inputs.at(-1)!.rules, { enterAfterChecks: 3, exitAfterChecks: 3 });
  assert.equal(loop.counters.badChecks, 2);
  // The owner raises it to 6 (PUT /strategy, then onScan): the next input carries 6 and the counts already reached.
  w.strategy = { ...w.strategy, exitAfterChecks: 6, enterAfterChecks: 4 };
  w.next = { decision: { action: 'hold', reason: 'held: under the minimum, 2 of 6' } };
  w.now += 60_000;
  await loop.check();
  const after = w.inputs.at(-1)!;
  assert.deepEqual(after.rules, { enterAfterChecks: 4, exitAfterChecks: 6 });
  assert.equal(after.counters.badChecks, 2, 'a changed count never resets the count in progress');
  assert.equal(loop.counters.badChecks, 2);
  assert.match(loop.startLine(), /enter after 4 hourly checks in a row, exit after 6 /);
  const hold = journal(w).filter((j) => j.numbers.action === 'hold').at(-1)!;
  assert.equal(hold.numbers.exitAfterChecks, 6);
});

test('F1: each check asks the hands to check their record against the venues first; a correction is journaled and acted on', async () => {
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
  const hands = fakeHands(w);
  let fix: string | null = null;
  hands.reconcile = async () => {
    const line = fix;
    if (line !== null) w.held = { symbol: 'SOL', legUsd: 500, pnlUsd: 0, oneLeg: { venue: 'hyperliquid', qty: '-5' } };
    fix = null;
    return line;
  };
  const loop = makeLoop(w, tmpStore(), { hands });
  await loop.check();
  assert.equal(journal(w).filter((j) => j.numbers.action === 'reconcile').length, 0);
  fix = 'SOL record reconciled with the venues: it said pair (-5 and 5), two reads agree on one leg (-5 and 0) and are adopted';
  w.now += 60_000;
  await loop.check();
  const r = journal(w).find((j) => j.numbers.action === 'reconcile')!;
  assert.equal(r.kind, 'error');
  assert.match(r.summary, /two reads agree on one leg/);
  // The same check closes the single leg, reduce-only.
  assert.equal(w.closes.length, 1);
  assert.match(w.closes[0]!, /one leg open: hyperliquid -5/);
});

test('a gated part 2: the journal and the held size report what filled (part 1), not what was asked', async () => {
  const records: BookRecord[] = [];
  const fills: BookFill[] = [
    { venue: 'hyperliquid', side: 'SELL', qty: '2.5', avgPx: 100, feeUsd: 0.1 },
    { venue: 'phoenix', side: 'BUY', qty: '2.5', avgPx: 100.2, feeUsd: 0.12 },
  ];
  const w = world();
  w.openAnswer = () => ({ ...OK('sol opened: 2.5 a leg (the last part ended stuck)'), fills, filledQty: '2.5' });
  const loop = makeLoop(w, tmpStore(), { book: (r) => records.push(r) });
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.equal(loop.held?.legUsd, 250, 'held as filled');
  const enter = journal(w).find((j) => j.kind === 'enter')!;
  assert.match(enter.summary, /^enter sol-phoenix-hyperliquid, SOL short hyperliquid, long phoenix, 2\.5 SOL \(250 USD\) a leg filled of the 5 \(500 USD\) asked at 1\.5x/);
  assert.equal(enter.numbers.qty, '2.5');
  assert.equal(enter.numbers.legUsd, 250);
  assert.equal(enter.numbers.usd, 250);
  assert.equal(enter.numbers.askedQty, '5');
  assert.equal(enter.numbers.askedLegUsd, 500);
  assert.deepEqual(records.map((r) => [r.kind, r.legs]), [['enter', fills]], 'the book takes the fills');
  // All of it filled: as before, the asked size.
  const v = world();
  const full = makeLoop(v);
  v.openAnswer = () => ({ ...OK('sol opened: 5 a leg'), filledQty: '5' });
  v.next = w.next;
  await full.check();
  assert.equal(full.held?.legUsd, 500);
  const e = journal(v).find((j) => j.kind === 'enter')!;
  assert.match(e.summary, /, at most 5 SOL \(500 USD\) a leg at 1\.5x/);
  assert.deepEqual([e.numbers.qty, e.numbers.usd, e.numbers.askedQty], ['5', 500, undefined]);
});

test('F2: an open its own gate stopped (nothing sent, a rescue now running) is tried again next check, no hold-off', async () => {
  const w = world();
  w.openAnswer = () => {
    w.busy = 'rescue r-4 runs';
    return { ok: false, reason: 'open refused, nothing signed: rescue r-4 runs: nothing sent', sent: false, tx: [], feeUsd: 0, open: [] };
  };
  const loop = makeLoop(w);
  w.next = { decision: { action: 'enter', reason: 'go' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.equal(w.opens.length, 1);
  w.busy = null;
  w.openAnswer = () => OK('opened both legs');
  w.now += 60_000;
  await loop.check();
  assert.equal(w.opens.length, 2, 'not held off for RETRY_AFTER_MS');
  assert.equal(loop.held?.windowId, 'sol-phoenix-hyperliquid');
});

test('the book: an act carries its start; the fills of an exit or open that did not end as asked are booked as fill', async () => {
  const records: BookRecord[] = [];
  const fills = [{ venue: 'hyperliquid', side: 'BUY' as const, qty: '2', avgPx: 100, feeUsd: 0.05 }];
  const w = world();
  // The open takes 90 s: the record is written after it, the start is before its first order.
  w.openAnswer = () => {
    w.now += 90_000;
    return { ...OK('opened'), fills };
  };
  const loop = makeLoop(w, tmpStore(), { book: (r) => records.push(r) });
  w.next = { decision: { action: 'enter', reason: 'go' }, act: ENTER_SOL };
  await loop.check();
  assert.deepEqual([records[0]!.kind, records[0]!.startedAt, records[0]!.at], ['enter', T0, T0 + 90_000]);
  // An exit that filled part and did not end flat: its fills go to the book as `fill`, the position stays held.
  w.closeAnswer = () => ({ ok: false, reason: 'one leg did not fill', sent: true, tx: [], feeUsd: 0.05, open: [], fills });
  w.next = { decision: { action: 'exit', reason: 'below the bar' }, act: { kind: 'exit', reason: 'below the bar' } };
  w.now += 60_000;
  await loop.check();
  assert.deepEqual(records.map((r) => r.kind), ['enter', 'fill']);
  assert.deepEqual([records[1]!.windowId, records[1]!.legs, records[1]!.exitReason], ['sol-phoenix-hyperliquid', fills, 'one leg did not fill']);
  // One that filled nothing adds nothing.
  w.closeAnswer = () => ({ ok: false, reason: 'refused', sent: false, tx: [], feeUsd: 0, open: [] });
  w.now += 60_000;
  await loop.check();
  assert.equal(records.length, 2);
  // An open that failed and left the desk flat, with fills on the way: booked as `fill` of that window.
  const w2 = world();
  w2.openAnswer = () => ({ ok: false, reason: 'unwound: the other leg did not fill', sent: true, tx: [], feeUsd: 0.1, open: [], fills });
  const r2: BookRecord[] = [];
  const loop2 = makeLoop(w2, tmpStore(), { book: (r) => r2.push(r) });
  w2.next = { decision: { action: 'enter', reason: 'go' }, act: ENTER_SOL };
  await loop2.check();
  assert.deepEqual(r2.map((r) => [r.kind, r.windowId, r.startedAt]), [['fill', 'sol-phoenix-hyperliquid', T0]]);
});

test('the risk check why line: every enter and refusal carries the verdict, the attestation and the reason; every check is booked', async () => {
  const booked: RiskCheckRecord[] = [];
  const hourly: number[] = [];
  const ledger: RiskLedgerSink = { check: (r) => booked.push(r), hourly: (now) => hourly.push(now) };
  const reply = (content: string) => ({ content, raw: { choices: [{ message: { content } }] }, latencyMs: 812 });
  const veto: VetoSource = { model: 'test-model', configured: true, complete: async () => reply('{"verdict":"pass","reasons":["deep books, no event"]}') };
  const facts: { w: string; legUsd: number }[] = [];
  const w = world();
  const loop = makeLoop(w, tmpStore(), {
    veto, ledger, attestation: () => 'attested', grossHours: () => [],
    riskFacts: async (win, legUsd) => {
      facts.push({ w: win.id, legUsd });
      return { long: { bookDepthUsd: 9_000, fillImpactBps: 3.1, priceMove24hPct: 1.5, daysSinceListing: null }, short: { bookDepthUsd: 12_000, fillImpactBps: 2, priceMove24hPct: 1.4, daysSinceListing: 400 } };
    },
  });
  w.next = { decision: { action: 'enter', reason: 'go', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.equal(w.opens.length, 1);
  const enter = journal(w).find((j) => j.kind === 'enter')!;
  assert.match(enter.summary, /; NEAR AI risk check passed \(attested\): deep books, no event; opened both legs$/);
  assert.equal(enter.numbers.riskCheck, 'NEAR AI risk check passed (attested): deep books, no event');
  assert.equal(enter.numbers.riskCheckOutcome, 'passed');
  assert.equal(enter.numbers.attestation, 'attested');
  assert.equal(enter.numbers.vetoMs, 812);
  // The prompt sent is the one journaled: it carries the depth, the fill impact, the move and the listing age per leg.
  const prompt = JSON.parse(String(enter.numbers.vetoPrompt));
  assert.deepEqual(prompt.legs.map((l: Record<string, unknown>) => [l.venue, l.book_depth_usd, l.fill_impact_bps, l.price_move_24h_pct, l.days_since_listing]), [
    ['phoenix', 9_000, 3.1, 1.5, null], ['hyperliquid', 12_000, 2, 1.4, 400],
  ]);
  assert.deepEqual(facts, [{ w: 'sol-phoenix-hyperliquid', legUsd: 500 }]);
  // The decision shown says the same.
  assert.match(decisions(w).at(-1)!.reason, /NEAR AI risk check passed \(attested\)/);
  // Booked: the outcome, the exact prompt, the reply, the latency, and what the refusal would be priced over.
  assert.equal(booked.length, 1);
  const b = booked[0]!;
  assert.deepEqual([b.kind, b.by, b.windowId, b.verdict, b.outcome, b.attestation, b.latencyMs, b.legUsd, b.holdHours], [
    'enter', 'auto', 'sol-phoenix-hyperliquid', 'passed', 'passed', 'attested', 812, 500, LEDGER_HOLD_HOURS,
  ]);
  assert.equal(b.prompt?.[1]?.content, enter.numbers.vetoPrompt);
  assert.equal(b.reply, '{"verdict":"pass","reasons":["deep books, no event"]}');
  // Fees 2 + slippage 1 + basis 1 APR points over the scanner's 168 h hold on 500 USD.
  assert.equal(DEFAULT_SCANNER_CONFIG.costs.holdHours, 168);
  assert.ok(Math.abs(b.roundTripCostUsd - 0.04 * 500 * 168 / 8760) < 1e-9);

  // No key: the enter is held (never passed), said so, with no attestation (nothing came to attest), booked as unchecked.
  const w2 = world();
  const booked2: RiskCheckRecord[] = [];
  const loop2 = makeLoop(w2, tmpStore(), { veto: NO_VETO_SOURCE, ledger: { check: (r) => booked2.push(r), hourly: () => {} }, attestation: () => 'attested' });
  w2.next = { decision: { action: 'enter', reason: 'go', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop2.check();
  assert.equal(w2.opens.length, 0);
  const held2 = journal(w2).find((j) => j.kind === 'refused')!;
  assert.match(held2.summary, /^enter sol-phoenix-hyperliquid not carried out: no NEAR AI key, so the NEAR AI risk check cannot answer: held, not passed: the act waits; nothing sent; /);
  assert.equal(held2.numbers.attestation, undefined);
  assert.deepEqual(booked2.map((r) => [r.verdict, r.outcome, r.attestation, r.prompt]), [['unchecked', 'no-key', null, null]]);

  // A refusal before the risk check says the check was not asked.
  const w3 = world();
  const loop3 = makeLoop(w3, tmpStore(), { hands: null, handsWhy: 'replay mode' });
  w3.next = { decision: { action: 'enter', reason: 'go', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop3.check();
  const refused = journal(w3).find((j) => j.kind === 'refused')!;
  assert.ok(refused.summary.endsWith(`; ${RISK_NOT_ASKED}`), refused.summary);
});

test('the hourly check prices the ledger\'s refusals; a ledger that throws never stops an act', async () => {
  const hourly: number[] = [];
  const ledger: RiskLedgerSink = { check: () => { throw new Error('disk full'); }, hourly: (now) => hourly.push(now) };
  const veto: VetoSource = { model: 'test-model', configured: true, complete: async () => ({ content: '{"verdict":"pass","reasons":[]}', raw: {} }) };
  const w = world();
  const logs: string[] = [];
  const loop = makeLoop(w, tmpStore(), { veto, ledger, grossHours: () => [], log: (l) => logs.push(l) });
  w.now = Date.UTC(2026, 10, 3, 10, 1) + HOUR_GRACE_MS - 60_000;
  w.next = { decision: { action: 'enter', reason: 'go', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.equal(w.opens.length, 1, 'opened although the ledger failed');
  assert.ok(logs.some((l) => /was not booked \(disk full\)/.test(l)));
  assert.deepEqual(hourly, [w.now]);
});

test('the NEAR AI key is in no journal entry, decision or ledger record, even when an error quotes it', async () => {
  const KEY = 'sk-test-0123456789abcdef-never-shown';
  const answers = [
    { status: 200, body: { choices: [{ message: { content: '{"verdict":"pass","reasons":[]}' }, finish_reason: 'stop' }] } },
    { status: 500, body: { error: { message: `upstream rejected bearer ${KEY}` } } },
  ];
  let sent = 0;
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    assert.match(String((init?.headers as Record<string, string>).authorization ?? (init?.headers as Record<string, string>).Authorization), /Bearer /);
    const a = answers[Math.min(sent++, answers.length - 1)]!;
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof globalThis.fetch;
  const booked: RiskCheckRecord[] = [];
  const veto = new NearAiClient({ apiKey: KEY, fetch });
  const events: StreamEvent[] = [];
  for (const id of ['sol-phoenix-hyperliquid', 'eth-phoenix-hyperliquid']) {
    const w = world();
    const loop = makeLoop(w, tmpStore(), { veto, ledger: { check: (r) => booked.push(r), hourly: () => {} }, attestation: () => 'attested' });
    w.next = { decision: { action: 'enter', reason: 'go', windowId: id }, act: { kind: 'enter', windowId: id, legUsd: 500, leverage: 1.5, qty: '5' } };
    await loop.check();
    events.push(...w.events);
  }
  assert.equal(booked.length, 2, 'both checks booked');
  assert.deepEqual(booked.map((r) => r.outcome), ['passed', 'unavailable']);
  const all = JSON.stringify({ events, booked });
  assert.ok(!all.includes(KEY), 'the key is nowhere');
  assert.ok(!all.includes('0123456789abcdef'), 'no part of it either');
});

test('the ledger: the act after a pass is booked with the position id the book got; a retry of the same act is not booked again', async () => {
  const records: (RiskCheckRecord | RiskActRecord)[] = [];
  const ledger: RiskLedgerSink = { check: (r) => records.push(r), act: (r) => records.push(r), hourly: () => {} };
  const veto: VetoSource = { model: 'test-model', configured: true, complete: async () => ({ content: '{"verdict":"pass","reasons":[]}', raw: {} }) };
  const booked: BookRecord[] = [];
  const w = world({ openAnswer: () => REFUSED('the spread does not cover the round trip') });
  const loop = makeLoop(w, tmpStore(), { veto, ledger, attestation: () => 'TEE attested 2026-11-03 09:00 UTC', book: (r) => booked.push(r) });
  w.next = { decision: { action: 'enter', reason: 'go', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  // Refused with nothing sent: tried again after RETRY_AFTER_MS, asked again, but the same act: one check, one act.
  w.now += RETRY_AFTER_MS + 60_000;
  await loop.check();
  assert.equal(w.opens.length, 2);
  assert.deepEqual(records.map((r) => r.type), ['check', 'act']);
  const first = records[0] as RiskCheckRecord;
  assert.deepEqual(records[1], {
    v: 1, type: 'act', at: T0, checkId: first.id, opened: false, positionId: null, result: 'not opened: the spread does not cover the round trip',
  });
  // The next retry opens: the act that opened is booked against the same check, with the book's position id.
  w.openAnswer = () => OK('opened both legs');
  w.now += RETRY_AFTER_MS + 60_000;
  await loop.check();
  assert.deepEqual(records.map((r) => r.type), ['check', 'act', 'act']);
  const opened = records[2] as RiskActRecord;
  const enter = booked.find((r) => r.kind === 'enter')!;
  assert.deepEqual([opened.checkId, opened.opened, opened.positionId], [first.id, true, positionIdOf('sol-phoenix-hyperliquid', enter.at)]);
});

test('no key: the facts for a check that is not asked are not read; a refusal never costs a refresh', async () => {
  let reads = 0;
  const riskFacts = async () => {
    reads++;
    return {};
  };
  const w = world();
  const loop = makeLoop(w, tmpStore(), { veto: NO_VETO_SOURCE, riskFacts });
  w.next = { decision: { action: 'enter', reason: 'go', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  assert.equal(w.opens.length, 0, 'no key: held, nothing opened');
  assert.equal(reads, 0, 'no book reads for an unasked check');

  // A rotate the risk check refuses: no prepareOpen (no paid refresh), nothing closed.
  const v = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 3 } });
  const veto: VetoSource = { model: 'test-model', configured: true, complete: async () => ({ content: '{"verdict":"veto","reasons":["a spike"]}', raw: {} }) };
  const rot = makeLoop(v, tmpStore(), { veto, riskFacts });
  await rot.check();
  v.next = { decision: { action: 'rotate', reason: 'eth better' }, act: { kind: 'rotate', fromId: 'sol-phoenix-hyperliquid', toId: 'eth-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  v.now += 60_000;
  await rot.check();
  assert.equal(reads, 1, 'asked: its facts were read');
  assert.deepEqual([v.prepares, v.closes.length, v.opens.length], [[], 0, 0]);
  assert.equal(rot.held?.windowId, 'sol-phoenix-hyperliquid');
});

test('the saved state keeps the risk check\'s why line with a hold-out; a malformed one is dropped, the state kept', () => {
  const store = tmpStore();
  const state = {
    version: LOOP_STATE_VERSION, held: null,
    counters: { ...NO_COUNTERS, vetoedUntil: { 'sol-phoenix-hyperliquid': T0 + HOUR }, vetoWhy: { 'sol-phoenix-hyperliquid': 'NEAR AI risk check refused (TEE attested 2026-11-03 09:00 UTC): a spike' } },
  };
  writeFileSync(store.path, JSON.stringify(state));
  const w = world();
  const loop = makeLoop(w, store);
  assert.equal(loop.counters.vetoWhy?.['sol-phoenix-hyperliquid'], 'NEAR AI risk check refused (TEE attested 2026-11-03 09:00 UTC): a spike');
  // Display only: a malformed one is dropped, the rest of the state (the hold-out itself) is kept.
  const bad = parseLoopState({ ...state, counters: { ...state.counters, vetoWhy: { x: 5, 'sol-phoenix-hyperliquid': 'kept' } } });
  assert.deepEqual(bad.counters.vetoWhy, { 'sol-phoenix-hyperliquid': 'kept' });
  for (const junk of [[], 'text', null, 7]) {
    const s = parseLoopState({ ...state, counters: { ...state.counters, vetoWhy: junk } });
    assert.equal(s.counters.vetoWhy, undefined);
    assert.equal(s.counters.vetoedUntil['sol-phoenix-hyperliquid'], T0 + HOUR);
  }
});

test('the NEAR AI prompt: an auto enter carries the owner\'s minimum and the streak; a manual one says the minimum is waived and has no streak', async () => {
  const reply = (content: string) => ({ content, raw: { choices: [{ message: { content } }] } });
  const prompts: Record<string, unknown>[] = [];
  const veto: VetoSource = {
    model: 'test-model', configured: true,
    complete: async (messages) => {
      prompts.push(JSON.parse(messages[1]!.content) as Record<string, unknown>);
      return reply('{"verdict":"pass","reasons":[]}');
    },
  };
  const auto = world({ strategy: { ...DEFAULT_STRATEGY, auto: true, minNetAprPct: 7 } });
  auto.next = { decision: { action: 'enter', reason: 'go', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  await makeLoop(auto, tmpStore(), { veto }).check();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.owner_minimum_net_apr_pct, 7);
  assert.equal(typeof prompts[0]!.hours_in_a_row_above_minimum, 'number');
  assert.equal(prompts[0]!.manual, undefined);
  assert.equal(prompts[0]!.trade, 'open a new pair');

  // The demo's rules: a minimum the manual enter skips. The prompt must not hold it to that minimum.
  const hand = world({ strategy: { ...DEFAULT_STRATEGY, auto: true, minNetAprPct: 987 } });
  const loop = makeLoop(hand, tmpStore(), { veto });
  await loop.check();
  assert.deepEqual(loop.rotate('sol-phoenix-hyperliquid'), { ok: true });
  await loop.idle(1000);
  assert.equal(hand.opens.length, 1);
  const manual = prompts.at(-1)!;
  assert.equal(manual.manual, true);
  assert.equal(manual.owner_minimum_net_apr_pct, 'waived: the owner asked for this trade');
  assert.equal('hours_in_a_row_above_minimum' in manual, false);
  assert.equal(manual.trade, 'open a new pair (asked by the owner by hand)');
  assert.doesNotMatch(JSON.stringify(manual), /987/);
});

test('checked counts only the checks that read a scan and the free margin (GIMBAL_CONTROL waits for the first)', async () => {
  const off = world({ trade: false });
  const offLoop = makeLoop(off);
  await offLoop.check();
  assert.equal(offLoop.checked, 0, 'GIMBAL_TRADE off: no check reads the scan');

  const w = world({ windows: null });
  const loop = makeLoop(w);
  await loop.check();
  assert.equal(loop.checked, 0, 'no scan yet');
  w.busy = 'rescue r-1 is running';
  w.windows = world().windows;
  await loop.check();
  assert.equal(loop.checked, 0, 'busy: no decision');
  w.busy = null;
  await loop.check();
  assert.equal(loop.checked, 1);
});

// ---- the owner demo entry (POST /rotate with demo) ----

/** The demo tests' world: a leg of 20 USD, as on mainnet (the taker fallback's 50 bps of it is held to maxLossUsd). */
const demoWorld = (over: Partial<World> = {}): World => world({ ...over, strategy: { ...DEFAULT_STRATEGY, auto: true, ...over.strategy, legUsd: 20 } });

const DEMO_ID = 'zec-phoenix-hyperliquid';
/** A window every safety check passes and its profit checks fail: today's ZEC, on the fake hands' direction. */
const demoWin = (over: Partial<FundingWindow> = {}) => win(DEMO_ID, {
  netAprPct: -3, checks: [{ ok: true, text: 'policy ok' }, profitCheck('Over a 7-day hold ... no more than the $0.04 round trip: it never pays it back'), profitCheck(NO_BREAKEVEN_TEXT)], ...over,
});
/** The facts serve-loop.ts windowFacts gives: lots for the enterable windows and those named, every round trip. */
const demoFacts = (roundTripUsd: Record<string, number> = { [DEMO_ID]: 0.04 }, asked: string[][] = []): StrategyLoopOptions['facts'] => async (ws, lotsFor = []) => {
  asked.push([...lotsFor]);
  const lots = ws.filter((x) => isEnterable(x) || lotsFor.includes(x.id)).map((x) => [x.id, { longLot: '0.01', shortLot: '0.01', px: 100 }]);
  return { lots: Object.fromEntries(lots), roundTripUsd };
};
const DEMO = { maxLossUsd: 0.25 };

test('demo: a window that fails only its profit checks is entered, said so on the journal, the book, the ledger and to the hands', async () => {
  const w = demoWorld({ windows: [demoWin(), win('sol-phoenix-hyperliquid')] });
  const records: BookRecord[] = [];
  const checks: RiskCheckRecord[] = [];
  const ledger: RiskLedgerSink = { check: (r) => checks.push(r), hourly: () => {} };
  const asked: string[][] = [];
  const loop = makeLoop(w, tmpStore(), { facts: demoFacts(undefined, asked), book: (r) => records.push(r), ledger });
  await loop.check();
  assert.equal(notEnterable(w.windows![0]!), `${DEMO_ID} fails a check: Over a 7-day hold ... no more than the $0.04 round trip: it never pays it back`);
  assert.equal(notEnterable(w.windows![0]!, true), null);
  // The last check read no lots for it (it is not enterable): POST /rotate still answers at once, sized when it runs.
  assert.deepEqual(loop.rotate(DEMO_ID, DEMO), { ok: true });
  await loop.idle(1000);
  assert.deepEqual(asked.at(-1), [DEMO_ID], 'its lots are read by name when it runs');
  assert.deepEqual(w.opens.map((o) => [o.symbol, o.legUsd, o.qty, o.demo]), [['ZEC', 20, '0.2', DEMO]]);
  assert.match(w.opens[0]!.reason, /owner demo entry/);
  const enter = journal(w).find((j) => j.kind === 'enter')!;
  assert.match(enter.summary, new RegExp(`^enter ${DEMO_ID}, ZEC short hyperliquid, long phoenix, .* \\(POST /rotate \\(manual\\)\\); `
    + 'owner demo entry: the profit checks are waived; round trip \\$0\\.04 estimated \\(\\+ \\$0\\.10 for a taker fallback after the maker window\\), at most \\$0\\.25 accepted; NEAR AI risk check passed \\(TEE not attested: no attestation fetched in this run\\): no red flag named; opened both legs$'));
  assert.equal(enter.numbers.demo, 1);
  assert.equal(enter.numbers.maxLossUsd, 0.25);
  assert.equal(enter.numbers.roundTripUsd, 0.04);
  assert.equal(enter.numbers.by, 'POST /rotate (manual)');
  assert.deepEqual(records.map((r) => [r.kind, r.by, r.demo]), [['enter', 'manual', true]]);
  assert.deepEqual(checks.map((c) => [c.kind, c.by, c.demo]), [['enter', 'manual', true]]);
  assert.equal(loop.held?.windowId, DEMO_ID);

  // An auto enter carries no demo anywhere.
  const a = world();
  a.next = { decision: { action: 'enter', reason: 'go', windowId: 'sol-phoenix-hyperliquid' }, act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  const autoRecords: BookRecord[] = [];
  await makeLoop(a, tmpStore(), { book: (r) => autoRecords.push(r) }).check();
  assert.equal(a.opens[0]!.demo, undefined);
  assert.equal(autoRecords[0]!.demo, undefined);
  assert.equal(journal(a).find((j) => j.kind === 'enter')!.numbers.demo, undefined);
});

test('rotateRefusal is POST /rotate\'s own first answer, with nothing started: no 7-day history refuses a demo entry too, its profit checks do not', async () => {
  const noHistory = { ok: false, text: 'No 7-day funding history on both legs yet: the spread expected over a 7-day hold is not known' };
  const w = demoWorld({ windows: [demoWin({ checks: [{ ok: true, text: 'policy ok' }, noHistory] })] });
  const loop = makeLoop(w, tmpStore(), { facts: demoFacts() });
  await loop.check();
  const events = w.events.length;
  const refused = `${DEMO_ID} fails a check a demo entry does not waive: ${noHistory.text}`;
  assert.equal(loop.rotateRefusal(DEMO_ID, DEMO), refused);
  assert.deepEqual(loop.rotate(DEMO_ID, DEMO), { ok: false, reason: refused }, 'the same answer the route gives');
  assert.equal(loop.rotateRefusal(DEMO_ID), `${DEMO_ID} fails a check: ${noHistory.text}`);
  assert.equal(loop.rotateRefusal('nope-phoenix-hyperliquid', DEMO), 'nope-phoenix-hyperliquid is not in the last scan');
  assert.match(loop.rotateRefusal(DEMO_ID, null)!, /^POST \/rotate's demo must be/);
  assert.equal(loop.rotateRefusal(''), 'POST /rotate needs { "windowId": "<window id>" }');
  // The history is in: only the profit checks fail. A demo entry would start; a plain one is still refused on them.
  w.windows = [demoWin()];
  assert.equal(loop.rotateRefusal(DEMO_ID, DEMO), null);
  assert.equal(loop.rotateRefusal(DEMO_ID), `${DEMO_ID} fails a check: ${demoWin().checks[1]!.text}`);
  await loop.idle(1000);
  assert.equal(w.events.length, events, 'asking started, journaled and published nothing');
  assert.equal(w.opens.length, 0);
  assert.deepEqual(loop.rotate(DEMO_ID, DEMO), { ok: true });
});

test('demo: without the flag nothing changes; the same window is refused with the first failing check, as before', async () => {
  const w = demoWorld({ windows: [demoWin()] });
  const loop = makeLoop(w, tmpStore(), { facts: demoFacts() });
  await loop.check();
  const first = (demoWin().checks[1]!).text;
  assert.deepEqual(loop.rotate(DEMO_ID), { ok: false, reason: `${DEMO_ID} fails a check: ${first}` });
  // The break-even check alone is refused in its own words, as the 409 said.
  w.windows = [demoWin({ checks: [{ ok: true, text: 'policy ok' }, profitCheck(NO_BREAKEVEN_TEXT)] })];
  assert.deepEqual(loop.rotate(DEMO_ID), { ok: false, reason: `${DEMO_ID} fails a check: Does not break even within a year at today's rates` });
  assert.equal(w.opens.length, 0);
});

test('demo: every safety reason still refuses it: a failing safety check, stale, refused, watch only, the risk check, the policy, the size, a held pair', async () => {
  const refusedWith = async (over: Partial<FundingWindow>, why: RegExp, o: { id?: string; store?: LoopStore; setup?: (w: World) => void; loop?: Partial<StrategyLoopOptions> } = {}) => {
    const w = demoWorld({ windows: [demoWin(over), win('btc-hyperliquid-phoenix', { netAprPct: -3, checks: demoWin().checks })] });
    const loop = makeLoop(w, o.store ?? tmpStore(), { facts: demoFacts({ [DEMO_ID]: 0.04, 'btc-hyperliquid-phoenix': 0.04 }), ...o.loop });
    await loop.check();
    o.setup?.(w);
    const r = loop.rotate(o.id ?? DEMO_ID, DEMO) as { ok: false; reason: string };
    assert.equal(r.ok, false, `${why}`);
    assert.match(r.reason, why);
    await loop.idle(1000);
    assert.equal(w.opens.length, 0);
  };
  const safety = { ok: false, text: 'The oracle price for ZEC on Phoenix is 90 s old, over the 60 s limit: the contract refuses its orders' };
  await refusedWith({ checks: [...demoWin().checks, safety] }, /^zec-phoenix-hyperliquid fails a check a demo entry does not waive: The oracle price for ZEC on Phoenix is 90 s old/);
  // A failing check with no kind is a safety check, whatever its words.
  await refusedWith({ checks: [{ ok: false, text: NO_BREAKEVEN_TEXT }] }, /fails a check a demo entry does not waive: Does not break even/);
  await refusedWith({ stale: true }, /is stale: a venue it needs did not answer/);
  await refusedWith({ refused: { code: 'E_ORACLE_STALE', reason: 'no oracle price for ZEC on phoenix' } }, /is refused: E_ORACLE_STALE/);
  await refusedWith({ tradable: false }, /is watch only/);
  await refusedWith({ veto: { verdict: 'veto', reasons: ['a spike'], model: 'test', at: T0 } }, /was refused by the NEAR AI risk check: a spike/);
  const held = tmpStore();
  writeFileSync(held.path, JSON.stringify({ version: LOOP_STATE_VERSION, held: null, counters: { ...NO_COUNTERS, vetoedUntil: { [DEMO_ID]: T0 + HOUR } } }));
  await refusedWith({}, /was refused by the NEAR AI risk check: held out until/, { store: held });
  // The policy's markets and the direction rule (symbolOf).
  await refusedWith({}, /short hyperliquid, long phoenix only/, { id: 'btc-hyperliquid-phoenix' });
  // The size: no free margin.
  await refusedWith({}, /cannot be sized: .*free margin/, { loop: { freeMargin: async () => ({ hyperliquid: 0, phoenix: 0 }) } });
  // From flat only.
  await refusedWith({}, /a pair is held \(SOL\): a demo entry opens from flat only, so its cost is its own round trip; POST \/close first/, {
    setup: (w) => { w.held = { symbol: 'SOL', legUsd: 500, pnlUsd: 0 }; },
  });
});

test('demo: maxLossUsd is required, a number above 0 and at most 1 USD, and at least the window\'s round trip, which must be known', async () => {
  for (const [demo, why] of [
    [{}, /^a demo entry needs maxLossUsd, the most its round trip may cost/],
    [{ maxLossUsd: 0 }, /^demo maxLossUsd 0 is not a number above 0/],
    [{ maxLossUsd: -0.1 }, /^demo maxLossUsd -0\.1 is not a number above 0/],
    [{ maxLossUsd: Number.NaN }, /^demo maxLossUsd NaN is not a number above 0/],
    [{ maxLossUsd: Infinity }, /^demo maxLossUsd Infinity is not a number above 0/],
    [{ maxLossUsd: '0.25' }, /^demo maxLossUsd "0\.25" is not a number above 0/],
    [{ maxLossUsd: 1.01 }, /^demo maxLossUsd 1\.01 is over the \$1\.00 a demo entry may accept/],
    [{ maxLossUsd: 0.25, extra: 1 }, /unknown field "extra"/],
    [null, /^POST \/rotate's demo must be "demo": \{ "maxLossUsd"/],
    [true, /^POST \/rotate's demo must be/],
    [[], /^POST \/rotate's demo must be/],
    [[{ maxLossUsd: 0.25 }], /^POST \/rotate's demo must be/],
    [{ maxLossUsd: {} }, /^demo maxLossUsd \{\} is not a number above 0/],
    [{ maxLossUsd: null }, /^demo maxLossUsd null is not a number above 0/],
  ] as [unknown, RegExp][]) {
    const r = parseDemo(demo);
    assert.ok('refused' in r, JSON.stringify(demo));
    assert.match(r.refused, why);
  }
  assert.equal(DEMO_MAX_LOSS_USD, 1);
  assert.deepEqual(parseDemo({ maxLossUsd: 1 }), { maxLossUsd: 1 });

  const w = demoWorld({ windows: [demoWin()] });
  const loop = makeLoop(w, tmpStore(), { facts: demoFacts() });
  await loop.check();
  // Through rotate: the same refusals, before anything else.
  assert.match((loop.rotate(DEMO_ID, { maxLossUsd: 5 }) as { reason: string }).reason, /over the \$1\.00 a demo entry may accept/);
  assert.match((loop.rotate(DEMO_ID, {}) as { reason: string }).reason, /needs maxLossUsd/);
  // Under the window's round trip: refused, with both numbers and the taker fallback's slippage (50 bps of 20 USD).
  assert.deepEqual(loop.rotate(DEMO_ID, { maxLossUsd: 0.03 }), {
    ok: false, reason: `${DEMO_ID}: its round trip, $0.04, plus $0.10 for the taker fallback's 50 bps past the touch, is over the $0.03 the demo entry accepts (maxLossUsd)`,
  });
  // Over the round trip but not over it with the taker fallback: refused too (the fallback's fee is in the round trip,
  // its slippage past the book is added), so the waiver never hides a cost above maxLossUsd.
  assert.match((loop.rotate(DEMO_ID, { maxLossUsd: 0.12 }) as { reason: string }).reason, /round trip, \$0\.04, plus \$0\.10 for the taker fallback's 50 bps past the touch, is over the \$0\.12/);
  // At the policy's cap when it is under the rules' leg: the fallback is counted on the leg the cap allows.
  const capped = world({ windows: [demoWin()] });
  const cappedLoop = makeLoop(capped, tmpStore(), { facts: demoFacts(), policy: () => ({ max_notional_usd: 20 }) as never });
  await cappedLoop.check();
  assert.match((cappedLoop.rotate(DEMO_ID, { maxLossUsd: 0.13 }) as { reason: string }).reason, /plus \$0\.10 for the taker fallback/);
  assert.deepEqual(cappedLoop.rotate(DEMO_ID, { maxLossUsd: 0.15 }), { ok: true });
  await cappedLoop.idle(1000);
  // Its round trip not known: refused.
  const u = demoWorld({ windows: [demoWin()] });
  const unknown = makeLoop(u, tmpStore(), { facts: demoFacts({}) });
  await unknown.check();
  assert.match((unknown.rotate(DEMO_ID, DEMO) as { reason: string }).reason, /its round trip in USD is not known, so a demo entry cannot be held to its \$0\.25 maxLossUsd/);
  // A round trip that grew over maxLossUsd by the time it runs: refused then, journaled with the number.
  const g = demoWorld({ windows: [demoWin()] });
  let rt = 0.04;
  const growing = makeLoop(g, tmpStore(), { facts: async (ws, lotsFor = []) => ({ ...(await demoFacts({ [DEMO_ID]: rt })!(ws, lotsFor)) }) });
  await growing.check();
  rt = 0.3;
  assert.deepEqual(growing.rotate(DEMO_ID, DEMO), { ok: true });
  await growing.idle(1000);
  assert.equal(g.opens.length, 0);
  const line = journal(g).at(-1)!;
  assert.equal(line.summary, `POST /rotate ${DEMO_ID} not carried out: (owner demo entry, at most $0.25) ${DEMO_ID}: its round trip, $0.30, plus $0.10 for the taker fallback's 50 bps past the touch, is over the $0.25 the demo entry accepts (maxLossUsd)`);
  assert.equal(line.numbers.demo, 1);
});

test('demo: the NEAR AI risk check is still asked, told it is an owner demonstration entry with the profit checks waived and the cost accepted; its refusal stands', async () => {
  const reply = (content: string) => ({ content, raw: { choices: [{ message: { content } }] } });
  const sent: { system: string; user: Record<string, unknown> }[] = [];
  let verdict = '{"verdict":"pass","reasons":[]}';
  const veto: VetoSource = {
    model: 'test-model', configured: true,
    complete: async (messages) => {
      sent.push({ system: messages[0]!.content, user: JSON.parse(messages[1]!.content) as Record<string, unknown> });
      return reply(verdict);
    },
  };
  const w = demoWorld({ windows: [demoWin()], strategy: { ...DEFAULT_STRATEGY, auto: true, minNetAprPct: 1000 } });
  const loop = makeLoop(w, tmpStore(), { veto, facts: demoFacts() });
  await loop.check();
  assert.deepEqual(loop.rotate(DEMO_ID, DEMO), { ok: true });
  await loop.idle(1000);
  assert.equal(w.opens.length, 1);
  const p = sent.at(-1)!;
  assert.equal(p.system, VETO_SYSTEM_PROMPT, 'the risk check itself is the same');
  assert.equal(p.user.manual, true);
  assert.equal(p.user.owner_minimum_net_apr_pct, 'waived: the owner asked for this trade');
  assert.equal(p.user.demo_entry, DEMO_ENTRY_TEXT);
  assert.match(String(p.user.demo_entry), /^an owner-requested demonstration entry: the profit checks .* are waived/);
  assert.match(String(p.user.demo_entry), /must be positive\. owner_accepted_cost_usd bounds the estimated round-trip cost .* only: funding during the hold is expected positive and is not part of that bound$/);
  assert.equal(p.user.expected_round_trip_cost_usd, 0.04);
  assert.equal(p.user.owner_accepted_cost_usd, 0.25);
  assert.equal(p.user.trade, 'open a new pair (an owner-requested demonstration entry, asked by hand)');
  assert.equal(p.user.net_apr_pct_after_costs, -3, 'the net is shown as it is');
  assert.ok(Object.entries(p.user).every(([k, v]) => !k.includes('minimum') || v !== 1000), 'the 1000 % demo minimum is not passed as the bar');

  // A refusal opens nothing, journaled as a demo entry.
  verdict = '{"verdict":"veto","reasons":["the ZEC book is thin"]}';
  const v = demoWorld({ windows: [demoWin()] });
  const vetoed = makeLoop(v, tmpStore(), { veto, facts: demoFacts() });
  await vetoed.check();
  assert.deepEqual(vetoed.rotate(DEMO_ID, DEMO), { ok: true });
  await vetoed.idle(1000);
  assert.equal(v.opens.length, 0);
  const line = journal(v).find((j) => j.kind === 'veto')!;
  assert.match(line.summary, new RegExp(`^${DEMO_ID} \\(owner demo entry: the profit checks are waived; .*\\): NEAR AI risk check refused`));
  assert.equal(line.numbers.demo, 1);
});

test('demo: held under the demo rules, the loop does not close or rotate it by itself for 23 hourly checks; the 24th is the counted exit', async () => {
  // The demo rules (docs/deploy-railway.md): auto on, a 1000 % minimum, rotation at 1000 points, exit after 24 checks.
  const rules: StrategyConfig = { ...DEFAULT_STRATEGY, auto: true, minNetAprPct: 1000, rotate: { ...DEFAULT_STRATEGY.rotate, minGainPts: 1000 }, exitAfterChecks: 24 };
  const w = demoWorld({ windows: [demoWin(), win('sol-phoenix-hyperliquid'), win('eth-phoenix-hyperliquid', { netAprPct: 60 })], strategy: rules });
  const loop = makeLoop(w, tmpStore(), { facts: demoFacts(), decide: realDecide });
  await loop.check();
  assert.deepEqual(loop.rotate(DEMO_ID, DEMO), { ok: true });
  await loop.idle(1000);
  assert.equal(loop.held?.windowId, DEMO_ID);
  for (let h = 1; h <= 23; h++) {
    w.now = T0 + h * HOUR;
    await loop.check();
    assert.equal(w.closes.length, 0, `closed at hour ${h}: ${decisions(w).at(-1)!.reason}`);
    assert.equal(w.opens.length, 1, `opened again at hour ${h}`);
    assert.equal(decisions(w).at(-1)!.action, 'hold');
  }
  assert.match(decisions(w).at(-1)!.reason, /^Hold ZEC: .* under your 1000 % minimum, 23 of 24/);
  // Scan events between the hours change nothing either.
  w.now += 5 * 60_000;
  await loop.check();
  assert.equal(w.closes.length, 0);
  // The 24th hourly check in a row under the minimum: the counted exit, a day after the entry.
  w.now = T0 + 24 * HOUR;
  await loop.check();
  assert.equal(w.closes.length, 1);
  assert.match(decisions(w).at(-1)!.reason, /^Exit ZEC: .* under your 1000 % minimum, 24 of 24/);
});

test('demo: the risk check ledger never books a demo open against an auto or plain check, nor the reverse', async () => {
  const records: (RiskCheckRecord | RiskActRecord)[] = [];
  const ledger: RiskLedgerSink = { check: (r) => records.push(r), act: (r) => records.push(r), hourly: () => {} };
  const veto: VetoSource = { model: 'test-model', configured: true, complete: async () => ({ content: '{"verdict":"pass","reasons":[]}', raw: {} }) };
  const SOL = 'sol-phoenix-hyperliquid';
  const w = demoWorld({ openAnswer: () => REFUSED('the venue is busy') });
  const loop = makeLoop(w, tmpStore(), { veto, ledger, attestation: () => 'attested', facts: demoFacts({ [SOL]: 0.04 }) });
  // An auto enter, refused with nothing sent: one check (auto), one act.
  w.next = { decision: { action: 'enter', reason: 'go', windowId: SOL }, act: { kind: 'enter', windowId: SOL, legUsd: 500, leverage: 1.5, qty: '5' } };
  await loop.check();
  w.next = {};
  // A demo entry into the same window at once: a check of its own, not the auto one.
  w.now += 60_000;
  await loop.check();
  assert.deepEqual(loop.rotate(SOL, DEMO), { ok: true });
  await loop.idle(1000);
  // The same demo entry again: the same act, its check stands (no new check, no act booked for a retry not opened).
  assert.deepEqual(loop.rotate(SOL, DEMO), { ok: true });
  await loop.idle(1000);
  // A plain manual rotate: not booked against the demo check.
  assert.deepEqual(loop.rotate(SOL), { ok: true });
  await loop.idle(1000);
  assert.equal(w.opens.length, 4);
  const checks = records.filter((r): r is RiskCheckRecord => r.type === 'check');
  assert.deepEqual(checks.map((c) => [c.by, c.demo]), [['auto', undefined], ['manual', true], ['manual', undefined]]);
  assert.deepEqual(records.map((r) => r.type), ['check', 'act', 'check', 'act', 'check', 'act']);
  const acts = records.filter((r): r is RiskActRecord => r.type === 'act');
  assert.deepEqual(acts.map((a) => a.checkId), checks.map((c) => c.id));
  assert.equal(new Set(checks.map((c) => c.id)).size, 3);
});

test('demo: a refusal line after the risk check keeps the plain lead (web waitCopy.ts reads it), the demo tag after it', async () => {
  const w = demoWorld({ windows: [demoWin()], openAnswer: () => REFUSED('open refused, nothing signed: the venue is busy') });
  const loop = makeLoop(w, tmpStore(), { facts: demoFacts() });
  await loop.check();
  assert.deepEqual(loop.rotate(DEMO_ID, DEMO), { ok: true });
  await loop.idle(1000);
  const line = journal(w).find((j) => j.kind === 'refused')!;
  assert.equal(line.summary, `enter ${DEMO_ID}: (owner demo entry: the profit checks are waived; round trip $0.04 estimated (+ $0.10 for a taker fallback after the maker window), at most $0.25 accepted) `
    + 'open refused, nothing signed: the venue is busy; ' + PASSED_WHY);
  assert.equal(line.numbers.demo, 1);
  // The same refusal without demo, for comparison: the same lead.
  const p = world({ windows: [win('sol-phoenix-hyperliquid')], openAnswer: () => REFUSED('open refused, nothing signed: the venue is busy') });
  const plain = makeLoop(p, tmpStore());
  await plain.check();
  assert.deepEqual(plain.rotate('sol-phoenix-hyperliquid'), { ok: true });
  await plain.idle(1000);
  assert.match(journal(p).find((j) => j.kind === 'refused')!.summary, /^enter sol-phoenix-hyperliquid: open refused, nothing signed: the venue is busy; /);
});

test('demo: refused on a safety carry line: no 7 days of history, two weeks that disagree, a spread of 0 or less', async () => {
  const lines = [
    { ok: false, text: 'No 7-day funding history on both legs yet: the spread expected over a 7-day hold is not known' },
    { ok: false, text: 'The 7-day spread (5.11 % APR) and the 14-day spread (-2.00 % APR) point opposite ways: no steady carry in this direction' },
    { ok: false, text: 'Over a 7-day hold, the 7-day spread of -3.00 % APR pays -$0.01 at $12.00 a leg, no more than the $0.04 round trip: it never pays it back' },
  ];
  for (const safety of lines) {
    const w = demoWorld({ windows: [demoWin({ checks: [safety, profitCheck(NO_BREAKEVEN_TEXT)] })] });
    const loop = makeLoop(w, tmpStore(), { facts: demoFacts() });
    await loop.check();
    assert.deepEqual(loop.rotate(DEMO_ID, DEMO), { ok: false, reason: `${DEMO_ID} fails a check a demo entry does not waive: ${safety.text}` });
  }
});

// ---- The NEAR AI risk check fails closed: no readable verdict holds the act, never passes it ----

const HOLD_ENTER_SOL: World['next'] = {
  decision: { action: 'enter', reason: 'go', windowId: 'sol-phoenix-hyperliquid' },
  act: { kind: 'enter', windowId: 'sol-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' },
};
const counting = (complete: VetoSource['complete']): VetoSource & { calls: number } => {
  const s = { model: 'test-model', configured: true, calls: 0, complete: (m: Parameters<VetoSource['complete']>[0], o?: Parameters<VetoSource['complete']>[1]) => {
    s.calls++;
    return complete(m, o);
  } };
  return s;
};
const passReply = { content: '{"verdict":"pass","reasons":[]}', raw: { choices: [{ message: { content: '{"verdict":"pass","reasons":[]}' } }] } };

test('fail closed: no answer is asked once more, then the enter is held (not passed, no 6 h hold-out), and asked again at the next hourly check', async () => {
  let answer = false;
  const veto = counting(() => (answer ? Promise.resolve(passReply) : new Promise(() => {})));
  const checks: RiskCheckRecord[] = [];
  const w = world();
  const loop = makeLoop(w, tmpStore(), { veto, ledger: { check: (r) => checks.push(r), hourly: () => {} } });
  w.next = HOLD_ENTER_SOL;
  await loop.check();
  assert.equal(veto.calls, LOOP_RULES.vetoAttempts, 'asked again once after the timeout');
  assert.equal(LOOP_RULES.vetoAttempts, 2);
  assert.equal(w.opens.length, 0, 'held: nothing opened');
  const held = journal(w).find((j) => j.kind === 'refused')!;
  const next = new Date(nextHourlyCheck(T0)).toISOString();
  assert.equal(held.summary, 'enter sol-phoenix-hyperliquid not carried out: the NEAR AI risk check did not answer (no answer within 0.05 s, asked 2 times): '
    + `held, not passed: the act waits; nothing sent; asked again at the next hourly check (${next}); not a refusal, so no 6 h hold-out`);
  assert.equal(held.numbers.riskCheckOutcome, 'timeout');
  assert.equal(held.numbers.riskCheckAttempts, 2);
  assert.equal(journal(w).some((j) => j.kind === 'veto'), false, 'no refusal entry');
  // No 6 h hold-out: nothing in vetoedUntil, nothing kept as a refusal's why, nothing shown on the window.
  assert.deepEqual(loop.counters.vetoedUntil, {});
  assert.equal(loop.counters.vetoWhy?.['sol-phoenix-hyperliquid'], undefined);
  assert.equal(w.events.some((e) => e.type === 'windows'), false);
  // The decision waits, with the held line: not "enter" while the act is held.
  assert.deepEqual([decisions(w).at(-1)!.action, decisions(w).at(-1)!.reason], ['wait', held.summary]);
  // Booked unchecked (never priced as a refusal).
  assert.deepEqual(checks.map((c) => [c.verdict, c.outcome]), [['unchecked', 'timeout']]);
  // A scan before the next hourly check does not ask again, and decide()'s enter is still published as that wait.
  answer = true;
  w.now += 20 * 60_000;
  const before = decisions(w).length;
  await loop.check();
  assert.equal(veto.calls, 2);
  assert.equal(w.opens.length, 0);
  assert.ok(decisions(w).slice(before).every((d) => d.action === 'wait' && d.reason === held.summary), 'never "enter" again until the next hourly check');
  assert.deepEqual([loop.decision!.action, loop.decision!.reason], ['wait', held.summary]);
  // The next hourly check asks again, and a readable pass opens it.
  w.now = nextHourlyCheck(T0);
  await loop.check();
  assert.equal(veto.calls, 3);
  assert.equal(w.opens.length, 1);
});

test('fail closed: a transport error is asked once more, then held; a rejected key is asked once and held; a readable refusal holds out 6 h; a readable pass opens', async () => {
  const cases: { complete: VetoSource['complete']; calls: number; opens: number; outcome: string; why: RegExp; vetoed: boolean }[] = [
    {
      complete: async () => { throw new NearAiUnavailable('NEAR AI did not answer: connection reset'); }, calls: 2, opens: 0, outcome: 'unavailable', vetoed: false,
      why: /^enter sol-phoenix-hyperliquid not carried out: the NEAR AI risk check did not answer \(NEAR AI did not answer: connection reset, asked 2 times\): held, not passed: the act waits; /,
    },
    {
      complete: async () => { throw new NearAiUnavailable('NEAR AI answered HTTP 401: invalid api key'); }, calls: 1, opens: 0, outcome: 'key-rejected', vetoed: false,
      why: /^enter sol-phoenix-hyperliquid not carried out: NEAR AI key rejected \(HTTP 401: invalid api key\), so the NEAR AI risk check cannot answer: held, not passed/,
    },
    {
      complete: async () => ({ content: '{"verdict":"veto","reasons":["a spike"]}', raw: {} }), calls: 1, opens: 0, outcome: 'refused', vetoed: true,
      why: /^sol-phoenix-hyperliquid: NEAR AI risk check refused \(TEE not attested: no attestation fetched in this run\): a spike; not entered, held out for 6 h$/,
    },
    { complete: async () => passReply, calls: 1, opens: 1, outcome: 'passed', vetoed: false, why: /; NEAR AI risk check passed \(.*\): no red flag named; opened both legs$/ },
  ];
  for (const c of cases) {
    const veto = counting(c.complete);
    const w = world();
    const loop = makeLoop(w, tmpStore(), { veto });
    w.next = HOLD_ENTER_SOL;
    await loop.check();
    assert.equal(veto.calls, c.calls, c.outcome);
    assert.equal(w.opens.length, c.opens, c.outcome);
    const line = journal(w).find((j) => j.kind === (c.opens === 1 ? 'enter' : c.vetoed ? 'veto' : 'refused'))!;
    assert.match(line.summary, c.why);
    assert.equal(line.numbers.riskCheckOutcome, c.outcome);
    assert.equal(loop.counters.vetoedUntil['sol-phoenix-hyperliquid'], c.vetoed ? T0 + LOOP_RULES.vetoHoldHours * HOUR : undefined, c.outcome);
  }
});

test('fail closed: a rotate with no answer keeps the held pair: nothing closed, no prepareOpen, held, no hold-out', async () => {
  const veto = counting(() => new Promise(() => {}));
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 3 }, prepareAnswer: () => OK('price fresh') });
  const loop = makeLoop(w, tmpStore(), { veto });
  await loop.check();
  w.next = { decision: { action: 'rotate', reason: 'eth better' }, act: { kind: 'rotate', fromId: 'sol-phoenix-hyperliquid', toId: 'eth-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' } };
  w.now += 60_000;
  await loop.check();
  assert.deepEqual([veto.calls, w.prepares.length, w.closes.length, w.opens.length], [2, 0, 0, 0]);
  assert.equal(loop.held?.windowId, 'sol-phoenix-hyperliquid');
  assert.match(journal(w).at(-1)!.summary, /^rotate sol-phoenix-hyperliquid -> eth-phoenix-hyperliquid not carried out: the NEAR AI risk check did not answer .*; sol-phoenix-hyperliquid is kept, nothing closed; asked again at the next hourly check/);
  assert.deepEqual(loop.counters.vetoedUntil, {});
});

test('the owner demo entry waives only the profit checks, never the NEAR AI risk check: refused or held like any entry', async () => {
  // A refusal refuses it, with the 6 h hold-out.
  const refuse = counting(async () => ({ content: '{"verdict":"veto","reasons":["thin book"]}', raw: {} }));
  const w = demoWorld({ windows: [demoWin(), win('sol-phoenix-hyperliquid')] });
  const loop = makeLoop(w, tmpStore(), { facts: demoFacts(), veto: refuse });
  await loop.check();
  assert.deepEqual(loop.rotate(DEMO_ID, DEMO), { ok: true });
  await loop.idle(1000);
  assert.equal(refuse.calls, 1, 'the demo entry is checked');
  assert.equal(w.opens.length, 0);
  assert.match(journal(w).find((j) => j.kind === 'veto')!.summary, /owner demo entry.*NEAR AI risk check refused .*thin book; not entered, held out for 6 h$/);
  // No answer holds it, and nothing opens.
  const silent = counting(() => new Promise(() => {}));
  const w2 = demoWorld({ windows: [demoWin(), win('sol-phoenix-hyperliquid')] });
  const loop2 = makeLoop(w2, tmpStore(), { facts: demoFacts(), veto: silent });
  await loop2.check();
  assert.deepEqual(loop2.rotate(DEMO_ID, DEMO), { ok: true });
  await loop2.idle(2000);
  assert.equal(silent.calls, 2);
  assert.equal(w2.opens.length, 0);
  const held = journal(w2).find((j) => j.kind === 'refused')!;
  assert.match(held.summary, new RegExp(`^enter ${DEMO_ID} not carried out: \\(owner demo entry: .*\\) the NEAR AI risk check did not answer .*held, not passed: the act waits; nothing sent; not tried again by itself: POST /rotate asks again; not a refusal, so no 6 h hold-out$`));
  assert.equal(held.numbers.demo, 1);
  // No key holds it too.
  const w3 = demoWorld({ windows: [demoWin(), win('sol-phoenix-hyperliquid')] });
  const loop3 = makeLoop(w3, tmpStore(), { facts: demoFacts(), veto: NO_VETO_SOURCE });
  await loop3.check();
  assert.deepEqual(loop3.rotate(DEMO_ID, DEMO), { ok: true });
  await loop3.idle(1000);
  assert.equal(w3.opens.length, 0);
  assert.match(journal(w3).find((j) => j.kind === 'refused')!.summary, /no NEAR AI key, so the NEAR AI risk check cannot answer: held, not passed/);
});

test('exits never wait on NEAR AI: a counted exit, a stop, POST /close and the one-leg close never ask it, with no key or a silent one', async () => {
  for (const veto of [NO_VETO_SOURCE, counting(() => new Promise(() => {}))]) {
    const asked = () => ('calls' in veto ? (veto as { calls: number }).calls : 0);
    // A counted exit and a time stop (decide()'s exit act).
    for (const reason of ['below the bar 6 checks', 'time stop']) {
      const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 3 } });
      const loop = makeLoop(w, tmpStore(), { veto });
      await loop.check();
      w.next = { decision: { action: 'exit', reason }, act: { kind: 'exit', reason } };
      w.now += 60_000;
      await loop.check();
      assert.equal(w.closes.length, 1, reason);
      assert.equal(w.held, null);
    }
    // POST /close.
    const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 3 } });
    const loop = makeLoop(w, tmpStore(), { veto });
    await loop.check();
    assert.deepEqual(loop.close(), { ok: true });
    await loop.idle(1000);
    assert.equal(w.closes.length, 1);
    // The one-leg close.
    const u = world({ held: { symbol: 'SOL', legUsd: 250, pnlUsd: 0, oneLeg: { venue: 'phoenix', qty: '2.5' } } });
    const one = makeLoop(u, tmpStore(), { veto });
    await one.check();
    assert.equal(u.closes.length, 1);
    assert.equal(asked(), 0, 'NEAR AI was never asked');
    assert.equal(journal(w).some((j) => j.kind === 'refused'), false);
  }
});

test('the rescue, the risk engine, the trader and panic_close have no path to the NEAR AI risk check: only the strategy loop imports it', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('test-helpers.ts') ? [p] : [];
  });
  const importers = files(src).filter((p) => /from '[^']*strategy\/veto\.ts'|from '\.\/veto\.ts'/.test(readFileSync(p, 'utf8')))
    .map((p) => p.slice(src.length).replaceAll('\\', '/').replace(/^\//, '')).sort();
  // book/risk-ledger.ts and cli/serve-loop.ts take types only; serve.ts builds the source; the loop calls it;
  // record-nearai.ts is the recorder the owner runs by hand (it builds and parses prompts, it never acts).
  assert.deepEqual(importers, ['book/risk-ledger.ts', 'cli/record-nearai.ts', 'cli/serve-loop.ts', 'cli/serve.ts', 'strategy/loop.ts']);
  for (const p of ['book/risk-ledger.ts', 'cli/serve-loop.ts']) {
    assert.match(readFileSync(join(src, p), 'utf8'), /import type \{[^}]*\} from '\.\.\/strategy\/veto\.ts'/, `${p} imports types only`);
    assert.doesNotMatch(readFileSync(join(src, p), 'utf8'), /^import \{[^}]*\} from '\.\.\/strategy\/veto\.ts'/m, `${p} imports types only`);
  }
  assert.doesNotMatch(readFileSync(join(src, 'cli/record-nearai.ts'), 'utf8'), /checkVeto/);
  // Inside the loop, checkVeto is called from #veto alone, and #veto from the enter-or-rotate path alone.
  const loop = readFileSync(join(src, 'strategy/loop.ts'), 'utf8');
  assert.equal(loop.match(/checkVeto\(/g)?.length, 1);
  assert.equal(loop.match(/this\.#veto\(/g)?.length, 1);
  const enterOrRotate = loop.slice(loop.indexOf('async #enterOrRotateChecked('), loop.indexOf('this.#veto('));
  assert.ok(enterOrRotate.length > 0 && !enterOrRotate.includes('\n  async #'), 'the call sits in #enterOrRotateChecked');
});

// ---- Nothing waits on a pending NEAR AI risk check: serve stopping, POST /close and a stop cancel it ----

const ROTATE_ETH: World['next'] = {
  decision: { action: 'rotate', reason: 'eth better', windowId: 'eth-phoenix-hyperliquid' },
  act: { kind: 'rotate', fromId: 'sol-phoenix-hyperliquid', toId: 'eth-phoenix-hyperliquid', legUsd: 500, leverage: 1.5, qty: '5' },
};
/** Waits (real time, at most 2 s) until `cond` holds. */
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 2_000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(cond(), 'the condition never held');
};
/** A NEAR AI that answers pass only when `release` is called, and never looks at the abort signal. */
const slowPass = () => {
  let release: () => void = () => {};
  const answered = new Promise<typeof passReply>((r) => {
    release = () => r(passReply);
  });
  return { veto: counting(() => answered), release: () => release() };
};

test('serve stopping during a slow risk check: the entry is not carried out, nothing sent, even if NEAR AI passes after', async () => {
  const slow = slowPass();
  const w = world();
  const loop = makeLoop(w, tmpStore(), { veto: slow.veto, vetoTimeoutMs: 120_000 });
  w.next = HOLD_ENTER_SOL;
  const started = Date.now();
  const running = loop.check();
  await until(() => slow.veto.calls === 1);
  loop.stop();                                           // SIGTERM: Railway's redeploy on every merge
  await running;
  assert.ok(Date.now() - started < 30_000, 'the stop does not wait for the 2 min check');
  slow.release();                                        // NEAR AI passes after the stop: too late, nothing opens
  await loop.idle(1000);
  assert.equal(w.opens.length, 0);
  assert.equal(w.closes.length, 0, 'nothing closed');
  const line = journal(w).at(-1)!;
  assert.equal(line.kind, 'refused');
  assert.equal(line.summary, 'enter sol-phoenix-hyperliquid not carried out: serve is stopping; nothing sent');
  assert.equal(line.numbers.cancelled, 1);
  assert.equal(slow.veto.calls, 1, 'not asked again');

  // A rotate past its pass when serve stops (in prepareOpen): the held pair is kept, nothing closed or opened.
  const v = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
  let rot: StrategyLoop | null = null;
  v.prepareAnswer = () => {
    rot!.stop();
    return OK('price fresh');
  };
  rot = makeLoop(v, tmpStore());
  await rot.check();
  v.next = ROTATE_ETH;
  v.now += 60_000;
  await rot.check();
  assert.deepEqual([v.closes.length, v.opens.length], [0, 0]);
  assert.match(journal(v).at(-1)!.summary, /^rotate sol-phoenix-hyperliquid -> eth-phoenix-hyperliquid not carried out: serve is stopping; sol-phoenix-hyperliquid is kept, nothing closed; NEAR AI risk check passed/);
});

test('POST /close during a rotate\'s pending risk check: accepted at once, the rotate is cancelled with nothing sent, the close runs right after', async () => {
  const silent = counting(() => new Promise(() => {}));
  const checks: RiskCheckRecord[] = [];
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 }, prepareAnswer: () => OK('price fresh') });
  const loop = makeLoop(w, tmpStore(), { veto: silent, vetoTimeoutMs: 120_000, ledger: { check: (r) => checks.push(r), hourly: () => {} } });
  await loop.check();
  w.next = ROTATE_ETH;
  w.now += 60_000;
  const started = Date.now();
  const running = loop.check();
  await until(() => silent.calls === 1);
  assert.deepEqual(loop.close(), { ok: true }, 'never "the strategy loop is acting"');
  await running;
  await loop.idle(1000);
  assert.ok(Date.now() - started < 30_000, 'the close did not wait for the 2 min check');
  assert.equal(silent.calls, 1);
  assert.deepEqual([w.prepares.length, w.opens.length], [0, 0]);
  assert.equal(w.closes.length, 1);
  assert.match(w.closes[0]!, /POST \/close \(manual\)/);
  assert.equal(w.held, null);
  const lines = journal(w).map((j) => [j.kind, j.summary]);
  assert.deepEqual(lines.at(-2), ['refused', 'rotate sol-phoenix-hyperliquid -> eth-phoenix-hyperliquid not carried out: a close came first; nothing sent']);
  assert.equal(lines.at(-1)![0], 'exit');
  assert.deepEqual(checks, [], 'a cancelled check is not booked');
  assert.deepEqual(loop.counters.vetoedUntil, {});
});

test('POST /close after a rotate passed its risk check: the rotate stops before its next step (prepareOpen, its close, the open); no new pair is opened', async () => {
  const KEPT = 'rotate sol-phoenix-hyperliquid -> eth-phoenix-hyperliquid not carried out: a close came first; sol-phoenix-hyperliquid is kept, nothing closed; NEAR AI risk check passed';
  // 1. Before prepareOpen (nothing paid for a refresh): the close comes as the rotate's gate is read, right after its pass.
  {
    const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 }, prepareAnswer: () => OK('price fresh') });
    let armed = false;
    let answer: ReturnType<StrategyLoop['close']> | null = null;
    let loop: StrategyLoop | null = null;
    const veto = counting(async () => {
      armed = true;
      return passReply;
    });
    loop = makeLoop(w, tmpStore(), {
      veto,
      busy: () => {
        if (armed) {
          armed = false;
          answer = loop!.close();
        }
        return null;
      },
    });
    await loop.check();
    w.next = ROTATE_ETH;
    w.now += 60_000;
    await loop.check();
    await loop.idle(1000);
    assert.deepEqual(answer, { ok: true });
    assert.equal(veto.calls, 1);
    assert.deepEqual([w.prepares.length, w.opens.length], [0, 0], 'no prepareOpen, nothing opened');
    assert.equal(w.closes.length, 1, 'SOL closed once, by the close');
    assert.match(w.closes[0]!, /POST \/close \(manual\)/);
    assert.ok(journal(w).find((j) => j.kind === 'refused')!.summary.startsWith(KEPT));
    assert.equal(journal(w).find((j) => j.kind === 'refused')!.numbers.cancelled, 1);
    assert.equal(w.held, null);
  }
  // 2. Before the rotate's close (prepareOpen ran): SOL is kept for the close, which closes it.
  {
    const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
    let loop: StrategyLoop | null = null;
    let answer: ReturnType<StrategyLoop['close']> | null = null;
    w.prepareAnswer = () => {
      answer = loop!.close();
      return OK('price fresh');
    };
    loop = makeLoop(w, tmpStore());
    await loop.check();
    w.next = ROTATE_ETH;
    w.now += 60_000;
    await loop.check();
    await loop.idle(1000);
    assert.deepEqual(answer, { ok: true });
    assert.deepEqual([w.prepares.length, w.opens.length], [1, 0]);
    assert.equal(w.closes.length, 1, 'SOL closed once, by the close');
    assert.match(w.closes[0]!, /POST \/close \(manual\)/);
    assert.ok(journal(w).find((j) => j.kind === 'refused')!.summary.startsWith(KEPT));
    assert.equal(w.held, null);
  }
  // 3. Before the open (SOL already closed by the rotate): the desk stays flat; the close finds nothing to close.
  {
    const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 }, prepareAnswer: () => OK('price fresh') });
    let loop: StrategyLoop | null = null;
    let answer: ReturnType<StrategyLoop['close']> | null = null;
    w.closeAnswer = () => {
      if (answer === null) answer = loop!.close();
      return OK('closed both legs, flat');
    };
    loop = makeLoop(w, tmpStore());
    await loop.check();
    w.next = ROTATE_ETH;
    w.now += 60_000;
    await loop.check();
    await loop.idle(1000);
    assert.deepEqual(answer, { ok: true });
    assert.equal(w.opens.length, 0, 'nothing opened');
    assert.equal(w.closes.length, 1, 'SOL closed exactly once');
    assert.match(w.closes[0]!, /rotate out of sol-phoenix-hyperliquid/);
    const refused = journal(w).filter((j) => j.kind === 'refused').map((j) => j.summary);
    assert.ok(refused[0]!.startsWith('rotate eth-phoenix-hyperliquid not carried out: a close came first; sol-phoenix-hyperliquid was closed, so the desk stays flat; nothing opened; NEAR AI risk check passed'), refused[0]);
    assert.equal(refused[1], 'POST /close not carried out: no pair is held any more (the act before it left the desk flat); nothing sent');
    assert.equal(w.held, null);
    assert.equal(loop.held, null);
  }
  // A second close while one is queued or running is refused at once, never queued twice.
  const v = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
  const two = makeLoop(v, tmpStore());
  assert.deepEqual(two.close(), { ok: true });
  assert.deepEqual(two.close(), { ok: false, reason: 'a POST /close is queued or running: wait for its result' });
  await two.idle(1000);
  assert.equal(v.closes.length, 1);
});

test('POST /close right after a POST /rotate that has not reached its risk check: the rotate is not asked, nothing sent; the close runs', async () => {
  const veto = counting(async () => passReply);
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 } });
  const loop = makeLoop(w, tmpStore(), { veto });
  await loop.check();
  assert.deepEqual(loop.rotate('eth-phoenix-hyperliquid'), { ok: true });
  assert.deepEqual(loop.close(), { ok: true });
  await loop.idle(1000);
  assert.equal(veto.calls, 0, 'NEAR AI not asked');
  assert.deepEqual([w.opens.length, w.closes.length], [0, 1]);
  assert.match(w.closes[0]!, /POST \/close \(manual\)/);
  assert.equal(journal(w).find((j) => j.kind === 'refused')!.summary,
    `rotate sol-phoenix-hyperliquid -> eth-phoenix-hyperliquid not carried out: a close came first; nothing sent; ${RISK_NOT_ASKED}`);
});

test('a drawdown stop that comes due during a rotate\'s pending risk check cancels the rotate: the exit runs next, without waiting for NEAR AI', async () => {
  const silent = counting(() => new Promise(() => {}));
  const w = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 }, prepareAnswer: () => OK('price fresh') });
  const loop = makeLoop(w, tmpStore(), { veto: silent, vetoTimeoutMs: 120_000 });
  await loop.check();
  w.next = ROTATE_ETH;
  w.now += 60_000;
  const started = Date.now();
  const running = loop.check();
  await until(() => silent.calls === 1);
  // Not due yet: a scan leaves the check alone.
  w.held = { symbol: 'SOL', legUsd: 500, pnlUsd: -10 };
  loop.onScan();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(journal(w).some((j) => j.numbers.cancelled === 1), false);
  // 20 % down on a 500 USD leg, past the 10 % stop: the next scan cancels the rotate, and the queued check exits.
  w.held = { symbol: 'SOL', legUsd: 500, pnlUsd: -100 };
  w.next = { decision: { action: 'exit', reason: 'stop' }, act: { kind: 'exit', reason: 'stop' } };
  loop.onScan();
  await running;
  await loop.idle(1000);
  assert.ok(Date.now() - started < 30_000, 'the stop did not wait for the 2 min check');
  assert.equal(silent.calls, 1);
  assert.deepEqual([w.opens.length, w.closes.length], [0, 1]);
  assert.match(w.closes[0]!, /strategy: exit sol-phoenix-hyperliquid \(auto\): stop/);
  assert.match(journal(w).find((j) => j.numbers.cancelled === 1)!.summary,
    /^rotate sol-phoenix-hyperliquid -> eth-phoenix-hyperliquid not carried out: a stop came first \(Exit SOL: down \$100\.00, 20\.0 % of the \$500\.00 leg, at your 10 % stop\); nothing sent$/);
});

test('no NEAR AI key: decide()\'s enter is published as a wait that says why, never "enter", on every scan', async () => {
  const w = world();
  const loop = makeLoop(w, tmpStore(), { veto: NO_VETO_SOURCE });
  w.next = HOLD_ENTER_SOL;
  for (let i = 0; i < 3; i++) {
    await loop.check();
    w.now += 60_000;
  }
  assert.equal(w.opens.length, 0);
  const ds = decisions(w);
  assert.ok(ds.length > 0);
  assert.ok(ds.every((d) => d.action === 'wait'), 'never "enter"');
  assert.match(ds.at(-1)!.reason, /^enter sol-phoenix-hyperliquid not carried out: no NEAR AI key, so the NEAR AI risk check cannot answer: held, not passed: the act waits; nothing sent; asked again at the next hourly check \(.*\); not a refusal, so no 6 h hold-out$/);
  // A rotate the same: the held pair is kept.
  const v = world({ held: { symbol: 'SOL', legUsd: 500, pnlUsd: 0 }, prepareAnswer: () => OK('price fresh') });
  const rot = makeLoop(v, tmpStore(), { veto: NO_VETO_SOURCE });
  await rot.check();
  v.next = ROTATE_ETH;
  v.now += 60_000;
  await rot.check();
  assert.ok(decisions(v).every((d) => d.action !== 'rotate'));
  assert.match(rot.decision!.reason, /^rotate sol-phoenix-hyperliquid -> eth-phoenix-hyperliquid not carried out: no NEAR AI key, .*; sol-phoenix-hyperliquid is kept, nothing closed; /);
  assert.deepEqual([v.closes.length, v.opens.length], [0, 0]);
});

test('a held manual POST /rotate (no demo): nothing sent, no hold-out, the decision untouched; the next POST /rotate asks again', async () => {
  const silent = counting(() => new Promise(() => {}));
  const w = world();
  const loop = makeLoop(w, tmpStore(), { veto: silent });
  await loop.check();
  const shown = loop.decision;
  assert.deepEqual(loop.rotate('sol-phoenix-hyperliquid'), { ok: true });
  await loop.idle(2000);
  assert.equal(silent.calls, 2);
  assert.equal(w.opens.length, 0);
  const held = journal(w).find((j) => j.kind === 'refused')!;
  assert.equal(held.summary, 'enter sol-phoenix-hyperliquid not carried out: the NEAR AI risk check did not answer (no answer within 0.05 s, asked 2 times): '
    + 'held, not passed: the act waits; nothing sent; not tried again by itself: POST /rotate asks again; not a refusal, so no 6 h hold-out');
  assert.equal(held.numbers.by, 'POST /rotate (manual)');
  assert.equal(held.numbers.held, 1);
  assert.equal(held.numbers.demo, undefined);
  assert.deepEqual(loop.counters.vetoedUntil, {});
  assert.deepEqual(loop.decision, shown, 'a manual act does not change the published decision');
  assert.deepEqual(loop.rotate('sol-phoenix-hyperliquid'), { ok: true });
  await loop.idle(2000);
  assert.equal(silent.calls, 4, 'asked again');
});

test('only enters and rotates reach the risk check: #enterOrRotate is called from POST /rotate and from #act\'s non-exit branch, nowhere else', () => {
  const loop = readFileSync(fileURLToPath(new URL('./loop.ts', import.meta.url)), 'utf8');
  assert.equal(loop.match(/this\.#enterOrRotate\(/g)?.length, 2);
  const rotate = loop.slice(loop.indexOf('  rotate(windowId: unknown'), loop.indexOf('  close(): {'));
  assert.equal(rotate.match(/this\.#enterOrRotate\(/g)?.length, 1, 'POST /rotate');
  const act = loop.slice(loop.indexOf('  async #act('), loop.indexOf('  async #enterOrRotate('));
  assert.equal(act.match(/this\.#enterOrRotate\(/g)?.length, 1);
  const exitBranch = act.indexOf("if (act.kind === 'exit') {");
  const elseBranch = act.indexOf('} else {', exitBranch);
  assert.ok(exitBranch > 0 && elseBranch > exitBranch);
  assert.match(act.slice(exitBranch, elseBranch), /r = await this\.#exit\(/);
  assert.doesNotMatch(act.slice(exitBranch, elseBranch), /#enterOrRotate|#veto/);
  assert.ok(act.indexOf('this.#enterOrRotate(') > elseBranch, '#act calls it inside the non-exit branch');
  // #exit and #closeOneLeg never reach it.
  for (const name of ['  async #exit(', '  async #closeOneLeg(']) {
    const start = loop.indexOf(name);
    const body = loop.slice(start, loop.indexOf('\n  }\n', start));
    assert.doesNotMatch(body, /#enterOrRotate|#veto|checkVeto/, name);
  }
});
