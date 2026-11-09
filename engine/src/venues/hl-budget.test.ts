// Hyperliquid's weight budget (http-budget.ts HL_BUDGET, hyperliquid.ts hlBudgetedSend): each /info read charged its
// documented weight in its class, the rows of a list answer charged once it is in, critical reads ahead of the scanner's
// and books ahead of history, a skipped read told apart from an outage, the loop's account reuse, and serve's load
// simulated over an hour boundary and a restart: the weight a minute it spends with the budget and without it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BudgetTimers, HostBudgetOptions } from './http-budget.ts';
import { HL_BUDGET, HostBudget, ReadSkipped, isReadSkipped, scanRead } from './http-budget.ts';
import { noteDeskAct } from './desk-acts.ts';
import { HyperliquidReader, hlBudgetedFetch, hlBudgetedSend, hlInfoWeight, hlReadKind, hlRowsWeight } from './hyperliquid.ts';
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
  assert.ok(cap <= 970 && all.peak <= cap);
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
