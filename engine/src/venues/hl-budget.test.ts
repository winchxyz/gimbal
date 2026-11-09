// Hyperliquid's weight budget (http-budget.ts HL_BUDGET, hyperliquid.ts hlBudgetedSend): each /info read charged its
// documented weight in its class, the rows of a list answer charged once it is in, critical reads ahead of the scanner's
// and books ahead of history, a skipped read told apart from an outage, the loop's account reuse, and serve's load
// simulated over an hour boundary and a restart: the weight a minute it spends with the budget and without it.
// The trade path (hlMeteredFetch, unqueued()): charged, never held up; a 429 keeps the bucket's debt; a retry after a
// 429 without Retry-After waits a short jittered pause; a Retry-After past 6 s is not believed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hlInfo as opsHlInfo } from '../cli/pair-ops.ts';
import { HyperliquidSubmitter } from '../relayer/hyperliquid.ts';
import { TEST_EVM_ADDRESS, fakeTime, stubFetch, testContract } from '../relayer/test-helpers.ts';
import { HlLedgerLanding } from '../rescue/hl-ledger.ts';
import type { BudgetTimers, HostBudgetOptions } from './http-budget.ts';
import { HL_BUDGET, HostBudget, RETRY_PAUSE_MS, ReadSkipped, isReadSkipped, readBy, resetHostBudgets, scanRead } from './http-budget.ts';
import { noteDeskAct } from './desk-acts.ts';
import {
  HyperliquidReader, hlBudgetedFetch, hlBudgetedSend, hlExchangeWeight, hlHostBudget, hlInfoWeight, hlMeteredFetch, hlMeteredSend, hlReadKind,
  hlRowsWeight, hlTradeFetch, hlTradeInfo,
} from './hyperliquid.ts';
import { HlDexReader } from './watch/hyperliquid.ts';

const HOUR = 3_600_000;
const USER = '0x00000000000000000000000000000000000000aa';

const meta = { universe: [{ name: 'ETH', szDecimals: 4, maxLeverage: 25 }] };
const ctx = { funding: '0.0000125', openInterest: '1000', oraclePx: '3000', markPx: '3000', dayNtlVlm: '1000000' };
const account = { marginSummary: { accountValue: '100' }, crossMaintenanceMarginUsed: '1', withdrawable: '90', time: 1, assetPositions: [] };
const book = { coin: 'ETH', time: 1, levels: [[{ px: '2999', sz: '1', n: 1 }], [{ px: '3001', sz: '1', n: 1 }]] };
const historyRows = (n: number) => Array.from({ length: n }, (_, i) => ({ coin: 'ETH', fundingRate: '0.00001', premium: '0', time: 1_000 + i * HOUR }));

/** A fake /info: answers by request type; counts the requests. */
function info(rows = { history: 176, funding: 40 }) {
  const calls: string[] = [];
  const f: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { type: string; dex?: string };
    calls.push(body.type);
    const answer = body.type === 'clearinghouseState' ? account
      : body.type === 'metaAndAssetCtxs' ? (body.dex === undefined ? [meta, [ctx]] : [{ universe: [{ name: `${body.dex}:ETH` }] }, [ctx]])
        : body.type === 'l2Book' ? book
          : body.type === 'fundingHistory' ? historyRows(rows.history)
            : body.type === 'userFunding' ? Array.from({ length: rows.funding }, (_, i) => ({ time: i, hash: '0x0', delta: { type: 'funding', coin: 'ETH', usdc: '0.01', szi: '1', fundingRate: '0.00001', nSamples: 24 } }))
              : [];
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { f, calls };
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

test('the documented weights: 2 for the light reads, 20 for the rest, 1 more per 20 rows of a list answer', () => {
  assert.equal(hlInfoWeight('clearinghouseState'), 2);
  assert.equal(hlInfoWeight('l2Book'), 2);
  assert.equal(hlInfoWeight('metaAndAssetCtxs'), 20);
  assert.equal(hlInfoWeight('fundingHistory'), 20);
  assert.equal(hlInfoWeight('userRole'), 60);
  assert.equal(hlRowsWeight('fundingHistory', 176), 9);
  assert.equal(hlRowsWeight('userFunding', 500), 25);
  assert.equal(hlRowsWeight('metaAndAssetCtxs', 500), 0);
  assert.equal(hlRowsWeight('candleSnapshot', 61), 2);
  // The class each reads in: critical outside the scanner, by kind inside it.
  assert.deepEqual(['clearinghouseState', 'l2Book', 'fundingHistory', 'metaAndAssetCtxs', 'predictedFundings', 'userFunding', 'openOrders'].map(hlReadKind),
    ['account', 'book', 'history', 'funding', 'funding', 'account', 'account']);
});

test('the reader charges each read its weight; a history read its hours up front and the rows it really brought after', async () => {
  const budget = new HostBudget('hl-weights', HL_BUDGET);
  const { f, calls } = info({ history: 176, funding: 41 });
  const hl = new HyperliquidReader({ fetch: f, budget });
  await hl.account(USER);
  assert.equal(budget.state().spent, 2);
  await hl.funding();
  assert.equal(budget.state().spent, 22);
  await hl.book('ETH');
  assert.equal(budget.state().spent, 24);
  // A week and 8 h (the scanner's window): 176 hours, 20 + 9.
  const end = 1_000 * HOUR;
  await hl.marketFundingHistory('ETH', end - 176 * HOUR + 1, end);
  await settle();
  assert.equal(budget.state().spent, 24 + 29);
  // Fewer rows than its hours: the difference comes back.
  const short = new HyperliquidReader({ fetch: info({ history: 10, funding: 0 }).f, budget });
  await short.marketFundingHistory('ETH', end - 176 * HOUR + 1, end);
  await settle();
  assert.equal(budget.state().spent, 24 + 29 + 21);
  // userFunding: 20 up front, its 41 rows (3 more) once in.
  await hl.userFunding(USER, 0);
  await settle();
  assert.equal(budget.state().spent, 24 + 29 + 21 + 23);
  assert.deepEqual(calls, ['clearinghouseState', 'metaAndAssetCtxs', 'l2Book', 'fundingHistory', 'userFunding']);
  // A reader given its own fetch and no budget has none (tests, capture).
  const free = new HyperliquidReader({ fetch: f });
  await free.account(USER);
  assert.equal(budget.state().spent, 24 + 29 + 21 + 23);
});

test('a scanner read the budget cannot send is ReadSkipped (not an HTTP error); the risk read still goes, on its floor', async () => {
  const budget = new HostBudget('hl-skip', { ...HL_BUDGET, maxWaitMs: { ...HL_BUDGET.maxWaitMs, book: 30, funding: 30 } });
  const { f, calls } = info();
  const hl = new HyperliquidReader({ fetch: f, budget });
  // Someone spent the bucket (a long answer charged after the fact): 300 below zero.
  budget.charge(450);
  const book = await scanRead(() => hl.book('ETH')).catch((e: unknown) => e);
  assert.ok(isReadSkipped(book), String(book));
  assert.equal((book as ReadSkipped).reason, 'budget');
  const dex = await scanRead(() => new HlDexReader('xyz', { fetch: f, budget }).funding()).catch((e: unknown) => e);
  assert.ok(isReadSkipped(dex), 'the watch reader passes it on as is, not as the venue failing');
  // The risk engine's account read: critical, from the floor's own tokens (1 a second, 10 at most).
  const t0 = Date.now();
  await hl.account(USER);
  assert.ok(Date.now() - t0 < 200, 'sent at once');
  assert.deepEqual(calls, ['clearinghouseState']);
});

test('queue order on Hyperliquid: critical, then the scanner\'s funding, books, and history last, which leaves its reserve', async () => {
  const opts: HostBudgetOptions = { ...HL_BUDGET, ratePerSec: 200, burst: 150, criticalFloor: null, maxWaitMs: { critical: 2_000, funding: 2_000, book: 2_000, history: 2_000 } };
  const budget = new HostBudget('hl-order', opts);
  budget.charge(150);
  const order: string[] = [];
  const send = (name: string) => async () => {
    order.push(name);
    return new Response('[]');
  };
  const body = (type: string) => (type === 'fundingHistory' ? { type, startTime: 0, endTime: 176 * HOUR - 1 } : { type });
  const ask = (name: string, type: string, scan: boolean) => {
    const go = () => hlBudgetedSend(budget, body(type), send(name));
    return scan ? scanRead(go) : go();
  };
  await Promise.all([
    ask('history', 'fundingHistory', true), ask('book', 'l2Book', true), ask('funding', 'metaAndAssetCtxs', true), ask('account', 'clearinghouseState', false),
  ]);
  assert.deepEqual(order, ['account', 'funding', 'book', 'history']);
});

test('accountWithin: the risk read\'s answer serves the loop while young, never across the desk\'s own act', async () => {
  const { f, calls } = info();
  let now = 10_000;
  const hl = new HyperliquidReader({ fetch: f, budget: null, clock: { now: () => now } });
  await hl.account(USER);
  now += 4_000;
  await hl.accountWithin(USER, 7_000);
  assert.equal(calls.length, 1, 'reused');
  now += 4_000;
  await hl.accountWithin(USER, 7_000);
  assert.equal(calls.length, 2, '8 s old: read again');
  noteDeskAct();
  await hl.accountWithin(USER, 7_000);
  assert.equal(calls.length, 3, 'the desk acted since: read again');
});

test('the book\'s ledger reads through hlBudgetedFetch are charged like the reader\'s', async () => {
  const budget = new HostBudget('hl-book', HL_BUDGET);
  const { f } = info();
  const g = hlBudgetedFetch(budget, f);
  const res = await g('https://api.hyperliquid.xyz/info', { method: 'POST', body: JSON.stringify({ type: 'userFillsByTime', user: USER, startTime: 0 }) });
  await res.json();
  await settle();
  assert.equal(budget.state().spent, 20);
});

// ---- serve's load on api.hyperliquid.xyz, simulated on a virtual clock ----

/** Timers and a clock that move only when told to, for the budget and the simulated readers alike. */
class VirtualTimers implements BudgetTimers {
  now = 0;
  readonly #q = new Map<number, { at: number; fn: () => void }>();
  #id = 0;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.#id;
    this.#q.set(id, { at: this.now + Math.max(0, ms), fn });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.#q.delete(h as number);
  };
  every(ms: number, offset: number, fn: () => void): void {
    const tick = () => {
      fn();
      this.setTimeout(tick, ms);
    };
    this.setTimeout(tick, offset);
  }
  async runUntil(end: number): Promise<void> {
    for (;;) {
      await settle();
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.#q) if (e[1].at <= end && (next === null || e[1].at < next[1].at)) next = e;
      if (next === null) break;
      this.#q.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].fn();
    }
    this.now = end;
    await settle();
  }
}

interface Load {
  /** Weight sent, by when. */
  sent: { t: number; w: number; type: string }[];
  /** How long each risk read waited for the budget, ms. */
  riskWaits: number[];
  /** When every leg's week (and the desk legs' week before) had been read for the hour the run ends in, or null. */
  historyDoneAt: number | null;
  /** Scanner reads the budget did not send, by request type (asked again later, as the scanner does). */
  skipped: Record<string, number>;
}

/**
 * serve's readers of the host, as the scanner, the risk engine and the book drive them (scanner.ts, sources.ts,
 * book.ts): every 5 s the scan's funding read and its due books (15 policy legs every 30 s, 110 others every 5 min,
 * 6 at a time), every 30 s the watch sweep (4 dexes and predictedFundings), the history reads (4 a scan, 2 at a time,
 * no new batch while one is out, a skipped one back after a minute; from a minute past the hour), the risk engine's
 * account read every 5 s, and the book's ledger sync at 5 past the hour.
 */
async function simulate(budget: HostBudget | null, timers: VirtualTimers, o: { start: number; end: number; legs: number; deskLegs: number; loaded: boolean }): Promise<Load> {
  const load: Load = { sent: [], riskWaits: [], historyDoneAt: null, skipped: {} };
  const send = (type: string, rows: number) => () => {
    load.sent.push({ t: timers.now, w: hlInfoWeight(type) + hlRowsWeight(type, rows), type });
    return Promise.resolve(new Response(JSON.stringify(rows > 0 ? Array.from({ length: rows }, () => 0) : {})));
  };
  const read = (body: { type: string } & Record<string, unknown>, rows = 0) => hlBudgetedSend(budget, body, send(body.type, rows)).then(() => true, (err: unknown) => {
    if (!isReadSkipped(err)) throw err;
    load.skipped[body.type] = (load.skipped[body.type] ?? 0) + 1;
    return false;
  });
  const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR;
  // History state per leg: the hour its week was read for, when it may be tried again; the desk legs' week before.
  const legs = Array.from({ length: o.legs }, (_, i) => ({ i, loadedHour: o.loaded ? hourOf(o.start) : null as number | null, retryAt: 0, older: o.loaded || i >= o.deskLegs }));
  const books = Array.from({ length: 125 }, (_, i) => ({ ttl: i < 15 ? 30_000 : 300_000, readAt: o.loaded ? o.start - (i * 2_400) % 300_000 : -Infinity }));
  let scanning = false;
  let batch = false;
  let scans = 0;
  const pool = async (jobs: (() => Promise<unknown>)[], n: number) => {
    let next = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    }));
  };
  const historyRows = 176;
  timers.every(5_000, 0, () => {
    if (scanning) return;
    scanning = true;
    const now = timers.now;
    const watch = scans++ % 6 === 0;
    void scanRead(async () => {
      await Promise.all([
        read({ type: 'metaAndAssetCtxs' }),
        ...(watch ? ['xyz', 'para', 'mkts', 'io'].map((dex) => read({ type: 'metaAndAssetCtxs', dex })) : []),
        ...(watch ? [read({ type: 'predictedFundings' })] : []),
      ]);
      const due = books.filter((b) => now - b.readAt >= b.ttl);
      await pool(due.map((b) => async () => {
        if (await read({ type: 'l2Book', coin: 'X' })) b.readAt = timers.now;
      }), 6);
      // History (scanner.ts #loadHistory): no new batch while one is out.
      if (!batch) {
        const current = hourOf(now);
        const todo: { leg: (typeof legs)[number]; older: boolean }[] = [];
        for (const leg of legs) {
          if (todo.length >= 4) break;
          if (leg.loadedHour === current || now < leg.retryAt) continue;
          if (leg.loadedHour !== null && now - current < 60_000) continue;
          todo.push({ leg, older: false });
        }
        for (const leg of legs) {
          if (todo.length >= 4) break;
          if (leg.older || leg.loadedHour === null || now < leg.retryAt) continue;
          todo.push({ leg, older: true });
        }
        if (todo.length > 0) {
          batch = true;
          let skippedHere = 0;
          void pool(todo.map(({ leg, older }) => async () => {
            const ok = await read({ type: 'fundingHistory', coin: 'X', startTime: current - (older ? 344 : 176) * HOUR, endTime: current - (older ? 168 * HOUR : 1) }, historyRows);
            if (!ok) {
              leg.retryAt = now + 60_000 + skippedHere++ * 5_000;
              return;
            }
            if (older) leg.older = true;
            else leg.loadedHour = current;
            if (load.historyDoneAt === null && legs.every((l) => l.loadedHour === hourOf(timers.now) && l.older)) load.historyDoneAt = timers.now;
          }), 2).finally(() => {
            batch = false;
          });
        }
      }
    }).finally(() => {
      scanning = false;
    });
  });
  // The risk engine: one critical account read every 5 s.
  timers.every(5_000, 2_500, () => {
    const asked = timers.now;
    void hlBudgetedSend(budget, { type: 'clearinghouseState', user: USER }, () => {
      load.riskWaits.push(timers.now - asked);
      return send('clearinghouseState', 0)();
    }).catch(() => load.riskWaits.push(Infinity));
  });
  // The book's ledger sync, 5 min past every hour (critical): funding, ledger updates, fills.
  timers.every(HOUR, (hourOf(o.start) + HOUR + 5 * 60_000) - o.start, () => {
    void read({ type: 'userFunding', user: USER, startTime: 0 }, 40);
    void read({ type: 'userNonFundingLedgerUpdates', user: USER, startTime: 0 }, 10);
    void read({ type: 'userFillsByTime', user: USER, startTime: 0 }, 5);
  });
  await timers.runUntil(o.end);
  return load;
}

/** The most weight sent in any 60 s, and the mean a minute over [from, to). */
function perMinute(load: Load, from: number, to: number): { peak: number; peakAt: number; mean: number } {
  const s = load.sent.filter((x) => x.t >= from && x.t < to).sort((a, b) => a.t - b.t);
  let peak = 0;
  let peakAt = from;
  let sum = 0;
  let lo = 0;
  for (let hi = 0; hi < s.length; hi++) {
    sum += s[hi]!.w;
    while (s[hi]!.t - s[lo]!.t >= 60_000) sum -= s[lo++]!.w;
    if (sum > peak) {
      peak = sum;
      peakAt = s[hi]!.t;
    }
  }
  const total = s.reduce((a, x) => a + x.w, 0);
  return { peak, peakAt, mean: total / ((to - from) / 60_000) };
}

const mmss = (t: number) => `${String(Math.floor((t % HOUR) / 60_000)).padStart(2, '0')}:${String(Math.floor((t % 60_000) / 1000)).padStart(2, '0')}`;

test('serve\'s load over the hour: without the budget ~1900 a minute after the hour; with it at most 900 in any 60 s, risk reads never wait', async (t) => {
  const start = 10 * HOUR + 50 * 60_000;
  const end = 11 * HOUR + 45 * 60_000;
  const shape = { start, end, legs: 125, deskLegs: 100, loaded: true };

  const before = new VirtualTimers();
  before.now = start;
  const raw = await simulate(null, before, shape);
  const rawHour = perMinute(raw, 11 * HOUR, 11 * HOUR + 10 * 60_000);
  const rawSteady = perMinute(raw, start, 11 * HOUR);
  t.diagnostic(`no budget: steady ${Math.round(rawSteady.mean)}/min; after the hour peak ${rawHour.peak}/min at ${mmss(rawHour.peakAt)}`);
  assert.ok(rawHour.peak > 1200, 'the history refresh alone takes the host past 1200 a minute: the 429s');

  const timers = new VirtualTimers();
  timers.now = start;
  const budget = new HostBudget('hl-sim', { ...HL_BUDGET, now: () => timers.now, timers, random: () => 0.5 });
  const load = await simulate(budget, timers, shape);
  const steady = perMinute(load, start, 11 * HOUR);
  const all = perMinute(load, start, end);
  const refresh = load.historyDoneAt === null ? null : (load.historyDoneAt - 11 * HOUR) / 60_000;
  t.diagnostic(`HL_BUDGET: steady ${Math.round(steady.mean)}/min; peak ${all.peak} in 60 s at ${mmss(all.peakAt)}; mean over the run ${Math.round(all.mean)}/min; `
    + `history refreshed by ${refresh?.toFixed(1)} min past the hour; risk read wait max ${Math.max(...load.riskWaits)} ms; scanner reads skipped ${JSON.stringify(load.skipped)}`);
  const cap = HL_BUDGET.ratePerSec * 60 + HL_BUDGET.burst + (HL_BUDGET.criticalFloor!.ratePerSec * 60 + HL_BUDGET.criticalFloor!.burst);
  assert.ok(all.peak <= 900, `peak ${all.peak} a minute`);
  assert.ok(cap <= 880 && all.peak <= cap, `cap ${cap}: at least 320 of the 1200 left for the trade path's bursts`);
  assert.ok(Math.max(...load.riskWaits) === 0, 'the risk read is sent the moment it asks');
  assert.ok(refresh !== null && refresh < 30, `every leg's week read again within half an hour (${refresh} min)`);
});

test('serve\'s load from a restart: every week and the desk legs\' week before loads under the budget, at most 900 in any 60 s', async (t) => {
  const start = 10 * HOUR + 20 * 60_000;
  const end = 11 * HOUR + 5 * 60_000;
  const timers = new VirtualTimers();
  timers.now = start;
  const budget = new HostBudget('hl-restart', { ...HL_BUDGET, now: () => timers.now, timers, random: () => 0.5 });
  const load = await simulate(budget, timers, { start, end, legs: 125, deskLegs: 100, loaded: false });
  const all = perMinute(load, start, end);
  const done = load.historyDoneAt === null ? null : (load.historyDoneAt - start) / 60_000;
  t.diagnostic(`restart: peak ${all.peak} in 60 s; all ${125 + 100} history reads done ${done?.toFixed(1)} min after the start; risk read wait max ${Math.max(...load.riskWaits)} ms; scanner reads skipped ${JSON.stringify(load.skipped)}`);
  assert.ok(all.peak <= 900);
  assert.ok(Math.max(...load.riskWaits) === 0);
  assert.ok(done !== null && done < 40, `loaded within 40 min (${done})`);
});

// ---- the trade path: charged to the budget, never held up by it ----

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const tooMany = (retryAfter?: string) => new Response('{}', { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } });

test('the weight of an /exchange post: 1, plus 1 per 40 orders or cancels in its batch', () => {
  assert.equal(hlExchangeWeight({ action: { type: 'order', orders: [{}], grouping: 'na' } }), 1);
  assert.equal(hlExchangeWeight({ action: { type: 'cancel', cancels: Array.from({ length: 45 }, () => ({})) } }), 2);
  assert.equal(hlExchangeWeight({ action: { type: 'usdClassTransfer', amount: '1' } }), 1);
  assert.equal(hlExchangeWeight(null), 1);
});

test('a trade-path request goes at once through a spent bucket, is charged, and the scanner then waits for it', async () => {
  const budget = new HostBudget('hl-trade', { ...HL_BUDGET, maxWaitMs: { ...HL_BUDGET.maxWaitMs, book: 30, funding: 30 } });
  const sent: string[] = [];
  const g = hlMeteredFetch(budget, async (input, init) => {
    if (init?.body === undefined) return ok({});
    const body = JSON.parse(String(init.body)) as { type?: string; action?: { type: string } };
    sent.push(`${String(input).split('/').pop()} ${body.type ?? body.action?.type}`);
    return ok(body.type === 'userFills' ? Array.from({ length: 41 }, () => ({})) : { status: 'ok' });
  });
  const post = (path: string, body: unknown) => g(`https://api.hyperliquid.xyz${path}`, { method: 'POST', body: JSON.stringify(body) });
  // The scanner has spent the bucket to its last token.
  budget.charge(150);
  await post('/info', { type: 'orderStatus', user: USER, oid: 1 });
  await post('/exchange', { action: { type: 'cancel', cancels: Array.from({ length: 41 }, () => ({})) }, nonce: 1 });
  await (await post('/info', { type: 'userFills', user: USER })).json();
  await settle();
  assert.deepEqual(sent, ['info orderStatus', 'exchange cancel', 'info userFills'], 'all sent at once, none skipped or held');
  const s = budget.state();
  // orderStatus 2, the cancel 1 + 1 (41 in its batch), userFills 20 + 3 for its 41 rows.
  assert.equal(s.unqueuedSpent, 2 + 2 + 23);
  assert.equal(s.spent, 150 + 27);
  // Booked as trade debt, not taken from the tokens critical reads go on (the clock is real: a few ms of refill).
  assert.equal(s.tradeDebt, 27);
  assert.ok(s.tokens >= 0 && s.tokens < 1, `the bucket is left as the scanner left it: ${s.tokens}`);
  assert.ok(s.floorTokens >= HL_BUDGET.criticalFloor!.burst - 1e-9, 'the critical floor is not touched: the risk read keeps its rate');
  assert.equal(s.sent, 3);
  // The scanner's book read waits for the bucket to pay the trade back: skipped (its wait is 30 ms here).
  const skipped = await scanRead(() => hlBudgetedSend(budget, { type: 'l2Book', coin: 'ETH' }, async () => ok(book))).catch((e: unknown) => e);
  assert.ok(isReadSkipped(skipped) && skipped.reason === 'budget', String(skipped));
  // Anything that is not /info or /exchange goes as is, uncharged.
  await g('https://api.hyperliquid.xyz/health', { method: 'GET' });
  assert.equal(budget.state().spent, 177);
});

test('a trade-path request goes at once through a cool-down; a 429 on /info holds the scanner only, on /exchange nothing', async () => {
  const now = 2_000_000;
  const budget = new HostBudget('hl-trade-429', { ...HL_BUDGET, now: () => now });
  await hlMeteredSend(budget, 'info', { type: 'openOrders', user: USER }, async () => tooMany('5'));
  const cooling = budget.state();
  assert.ok(cooling.retryAt > now && cooling.quietUntil > now && cooling.rateLimited === 1, 'the scanner\'s reads wait out the server\'s pause');
  assert.equal(cooling.criticalRetryAt, 0, 'critical reads do not');
  assert.equal(cooling.tokens, HL_BUDGET.burst, 'and the bucket they go on is not emptied');
  let sent = 0;
  const res = await hlMeteredSend(budget, 'info', { type: 'orderStatus', user: USER, oid: 1 }, async () => {
    sent++;
    return ok({ status: 'unknownOid' });
  });
  assert.equal(res.status, 200);
  assert.equal(sent, 1, 'sent at once, in the cool-down');
  // A 429 on /exchange may be the address's own action limit (it grows with volume traded), not this IP's weight.
  await hlMeteredSend(budget, 'exchange', { action: { type: 'order', orders: [{}] } }, async () => tooMany());
  assert.equal(budget.state().rateLimited, 1);
  assert.equal(budget.state().unqueuedSpent, 20 + 2 + 1);
});

test('the trade path\'s callers are metered against the host\'s shared budget: pair-ops hlInfo, the submitter, the rescue ledger', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string };
    return ok(body.type === 'userNonFundingLedgerUpdates' ? [] : { status: 'order', order: { status: 'open', order: { oid: 1, sz: '1', origSz: '1', limitPx: '1' } } });
  }) as typeof fetch;
  try {
    // pair-ops (and serve-pair) hlInfo: the legs' orderStatus, userFills and margin reads.
    const ops = hlHostBudget('https://hl-ops.test/info');
    await opsHlInfo({ hlUrl: 'https://hl-ops.test' }, { type: 'orderStatus', user: USER, oid: 1 });
    assert.equal(ops.state().unqueuedSpent, 2);
    // The rescue's ledger read, with no fetch of its own.
    const rescue = hlHostBudget('https://hl-rescue.test');
    const landing = new HlLedgerLanding({ network: 'mainnet', desk: async () => USER, apiUrl: 'https://hl-rescue.test' });
    await landing.find('hyperliquid', { minAmountOutE8: 1n } as Parameters<HlLedgerLanding['find']>[1], 0, new Set());
    await settle();
    assert.equal(rescue.state().unqueuedSpent, 20);
    // hlTradeFetch: the same budget as the host's readers.
    await hlTradeFetch('https://hl-ops.test')('https://hl-ops.test/info', { method: 'POST', body: JSON.stringify({ type: 'clearinghouseState', user: USER }) });
    assert.equal(ops.state().unqueuedSpent, 4);
  } finally {
    globalThis.fetch = real;
    resetHostBudgets();
  }
  // The relayer: the /exchange post and the userFillsByTime read that confirms the fill.
  const time = fakeTime(1_793_491_200_000);
  const budget = new HostBudget('hl-relayer', HL_BUDGET);
  const stub = stubFetch((call) => (call.url.endsWith('/exchange')
    ? { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.01', avgPx: '2500', oid: 77 } }] } } }
    : [{ coin: 'ETH', px: '2500', sz: '0.01', side: 'B', time: time.now(), hash: `0x${'ab'.repeat(32)}`, oid: 77 }]));
  const hl = new HyperliquidSubmitter({ network: 'testnet', fetch: stub.fetch, budget, clock: time.clock, sleep: time.sleep });
  const signed = await testContract(time.now).hlOrder('alpha', { asset: 1, is_buy: true, px: '2510', sz: '0.01', reduce_only: false, tif: 'Ioc', cloid: null }, 'enter');
  const result = await hl.submit(signed, TEST_EVM_ADDRESS);
  await settle();
  assert.equal(result.confirmed, true);
  // The order 1; userFillsByTime 20, and 1 for its one row.
  assert.equal(budget.state().unqueuedSpent, 1 + 21);
  // A submitter given its own fetch and no budget has none (tests).
  const free = new HyperliquidSubmitter({ network: 'testnet', fetch: stub.fetch, clock: time.clock, sleep: time.sleep });
  await free.submit(await testContract(time.now).hlOrder('alpha', { asset: 1, is_buy: true, px: '2510', sz: '0.01', reduce_only: false, tif: 'Ioc', cloid: null }, 'enter'), TEST_EVM_ADDRESS);
  assert.equal(budget.state().unqueuedSpent, 22);
});

test('a 429 keeps the bucket\'s debt: what was spent is still paid back after the rate is cut', async () => {
  const now = 5_000_000;
  // A queued critical read that meets a 429 once (no Retry-After), then goes; on its floor while the bucket is in debt.
  const once = (b: HostBudget) => {
    let n = 0;
    return b.run('critical', async () => (n++ === 0 ? tooMany() : ok({})), 2);
  };
  const budget = new HostBudget('hl-debt', { ...HL_BUDGET, now: () => now, random: () => 0 });
  budget.charge(450);
  assert.equal(budget.state().tokens, -300);
  assert.equal((await once(budget)).status, 200);
  const s = budget.state();
  assert.equal(s.tokens, -300, 'not reset to zero');
  assert.equal(s.floorTokens, HL_BUDGET.criticalFloor!.burst - 4, 'both tries on the floor, which stays above zero');
  assert.equal(s.ratePerSec, HL_BUDGET.ratePerSec * HL_BUDGET.adaptive!.cut);
  // A bucket above zero is still emptied.
  const full = new HostBudget('hl-debt-2', { ...HL_BUDGET, now: () => now, random: () => 0 });
  assert.equal((await once(full)).status, 200);
  assert.equal(full.state().tokens, 0);
});

test('a critical retry after a 429 without Retry-After waits 500 to 1000 ms; with one, the server\'s pause; never past the deadline', async () => {
  const run = async (first: Response, random: number, deadlineMs: number | null) => {
    const timers = new VirtualTimers();
    timers.now = 0;
    const budget = new HostBudget('hl-pause', { ...HL_BUDGET, now: () => timers.now, timers, random: () => random });
    const at: number[] = [];
    let n = 0;
    const send = async () => {
      at.push(timers.now);
      return n++ === 0 ? first : ok({});
    };
    const go = () => budget.run('critical', send, 2);
    const p = deadlineMs === null ? go() : readBy(Date.now() + deadlineMs, go);
    await timers.runUntil(20_000);
    const res = await p;
    return { at, status: res.status };
  };
  const [lo, hi] = RETRY_PAUSE_MS;
  assert.deepEqual(await run(tooMany(), 0, null), { at: [0, lo], status: 200 });
  assert.deepEqual(await run(tooMany(), 0.5, null), { at: [0, (lo + hi) / 2], status: 200 });
  assert.deepEqual(await run(tooMany(), 1, null), { at: [0, hi], status: 200 });
  // Retry-After: 1 is the gate: 1 s plus up to 15 %, no pause of its own on top.
  assert.deepEqual(await run(tooMany('1'), 0, null), { at: [0, 1_000], status: 200 });
  // A caller whose deadline comes before the pause ends gets the 429 back, not a late retry.
  assert.deepEqual(await run(tooMany(), 0.5, 300), { at: [0], status: 429 });
});

test('Hyperliquid\'s Retry-After is believed up to 6 s: a critical read probes again inside the risk read\'s 7 s', async () => {
  assert.ok(HL_BUDGET.retryAfterMaxMs <= 6_000);
  const now = 9_000_000;
  const budget = new HostBudget('hl-retry-after', { ...HL_BUDGET, now: () => now, random: () => 1 });
  // A queued critical read with a short deadline: the 429 is returned at once, the gate set for the next.
  const res = await readBy(Date.now() + 100, () => budget.run('critical', async () => tooMany('3600'), 2));
  assert.equal(res.status, 429);
  assert.equal(budget.state().criticalRetryAt - now, Math.round(6_000 * 1.15));
  assert.ok(budget.state().criticalRetryAt - now < 7_000);
  // An unqueued request's Retry-After is capped the same way, for the scanner's reads.
  const scan = new HostBudget('hl-retry-after-2', { ...HL_BUDGET, now: () => now, random: () => 1 });
  await scan.unqueued(async () => tooMany('3600'), 2);
  assert.equal(scan.state().retryAt - now, Math.round(6_000 * 1.15));
});

test('critical reads are served within 2 s of a trade\'s large debt and a 20-weight critical read; the floor never goes below zero', async () => {
  const timers = new VirtualTimers();
  timers.now = 0;
  const budget = new HostBudget('hl-after-trade', { ...HL_BUDGET, now: () => timers.now, timers, random: () => 0.5 });
  // The scanner has spent the bucket; a close then read userFills five times (120 each) and polled userFillsByTime.
  budget.charge(150);
  for (let i = 0; i < 5; i++) await budget.unqueued(async () => ok([]), 120);
  for (let i = 0; i < 10; i++) await budget.unqueued(async () => ok([]), 21);
  assert.equal(budget.state().tradeDebt, 810);
  const sentAt: Record<string, number> = {};
  const read = (name: string, type: string, scan = false) => {
    const go = () => hlBudgetedSend(budget, { type, user: USER }, async () => {
      sentAt[name] = timers.now;
      return ok({});
    });
    return (scan ? scanRead(go) : go()).catch((e: unknown) => e);
  };
  // The book's ledger reads after the act (20 each, critical), then the risk read and a book read (2 each).
  const asked = [
    read('ledger', 'userNonFundingLedgerUpdates'), read('fills', 'userFillsByTime'),
    read('risk', 'clearinghouseState'), read('book', 'l2Book'), read('funding', 'metaAndAssetCtxs', true),
  ];
  await timers.runUntil(3_000);
  assert.equal(sentAt.ledger, 0, 'the first 20-weight read goes on the floor and the shared bucket');
  assert.ok(sentAt.risk! <= 2_000, `the risk read at ${sentAt.risk} ms`);
  assert.ok(sentAt.book! <= 2_000, `the book read at ${sentAt.book} ms`);
  assert.ok(budget.state().floorTokens >= 0);
  assert.equal(sentAt.funding, undefined, 'the scanner waits for the trade debt');
  await timers.runUntil(60_000);
  await Promise.all(asked);
  assert.ok(sentAt.fills! < 5_000, `the second ledger read at ${sentAt.fills} ms`);
  assert.equal(sentAt.funding, undefined, 'skipped: 810 of debt is more than its 3 s wait');
});

test('an unqueued request\'s 429 does not delay a queued critical read; it holds the scanner\'s', async () => {
  const timers = new VirtualTimers();
  timers.now = 0;
  const budget = new HostBudget('hl-unqueued-429', { ...HL_BUDGET, now: () => timers.now, timers, random: () => 0.5 });
  await hlMeteredSend(budget, 'info', { type: 'orderStatus', user: USER, oid: 1 }, async () => tooMany('5'));
  const sentAt: Record<string, number> = {};
  const risk = hlBudgetedSend(budget, { type: 'clearinghouseState', user: USER }, async () => {
    sentAt.risk = timers.now;
    return ok(account);
  });
  const funding = scanRead(() => hlBudgetedSend(budget, { type: 'metaAndAssetCtxs' }, async () => {
    sentAt.funding = timers.now;
    return ok([meta, [ctx]]);
  })).catch((e: unknown) => e);
  await timers.runUntil(20_000);
  assert.equal((await risk).status, 200);
  assert.equal(sentAt.risk, 0, 'sent at once');
  assert.ok(isReadSkipped(await funding), 'the scanner\'s funding read waits out the pause (past its 3 s wait: skipped)');
  assert.equal(sentAt.funding, undefined);
});

test('the trade reader (bestPx, hlHeld, legBook) goes at once through a spent bucket and a cool-down, charged as trade debt', async () => {
  const budget = new HostBudget('hl-trade-reader', { ...HL_BUDGET, now: () => 7_000_000 });
  budget.charge(450);
  await budget.unqueued(async () => tooMany('5'), 2);
  const { f, calls } = info({ history: 0, funding: 41 });
  const hl = new HyperliquidReader({ fetch: f, budget, trade: true });
  await hl.book('ETH');
  await hl.account(USER);
  // userFunding: its rows charged from the answer the reader parsed (20 + 3), not from a second copy.
  await hl.userFunding(USER, 0);
  assert.deepEqual(calls, ['l2Book', 'clearinghouseState', 'userFunding']);
  assert.equal(budget.state().unqueuedSpent, 2 + 2 + 2 + 23);
  assert.equal(budget.state().tradeDebt, 29);
});

test('hlTradeInfo parses a long answer once and charges its rows from it; resetHostBudgets gives tests a fresh budget', async () => {
  const real = globalThis.fetch;
  let copies = 0;
  globalThis.fetch = (async () => {
    const res = ok(Array.from({ length: 2000 }, (_, i) => ({ oid: i })));
    const clone = res.clone.bind(res);
    res.clone = () => {
      copies++;
      return clone();
    };
    return res;
  }) as typeof fetch;
  try {
    const rows = await hlTradeInfo<unknown[]>('https://hl-once.test', { type: 'userFills', user: USER });
    assert.equal(rows.length, 2000);
    assert.equal(copies, 0, 'no copy of the answer is read for its rows');
    assert.equal(hlHostBudget('https://hl-once.test').state().unqueuedSpent, 20 + 100);
    resetHostBudgets();
    assert.equal(hlHostBudget('https://hl-once.test').state().unqueuedSpent, 0);
  } finally {
    globalThis.fetch = real;
    resetHostBudgets();
  }
});
