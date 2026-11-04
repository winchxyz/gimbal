// PHOENIX_BUDGET against Phoenix's measured limits, on a fake clock: a host that answers like perp-api.phoenix.trade
// (one token bucket per IP, 1 request a second, a burst of 20, then 429 with Retry-After: 2) under serve's steady load
// (the risk engine's account read every 5 s, the scanner's funding, books and history, the hourly book sync). Also the
// class reserves (critical reads first, history last) and the rate cut after a 429 (a host shared with someone else).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BudgetTimers, HostBudgetOptions, ReadClass } from './http-budget.ts';
import { HostBudget, PHOENIX_BUDGET, isReadSkipped } from './http-budget.ts';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A clock and timers that move only when told: advance() fires every timer due, in time order. */
class FakeTime {
  t: number;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();
  #id = 0;

  constructor(t0: number) {
    this.t = t0;
  }

  readonly now = (): number => this.t;

  readonly timers: BudgetTimers = {
    setTimeout: (fn, ms) => {
      const id = ++this.#id;
      this.#timers.set(id, { at: this.t + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (handle) => {
      this.#timers.delete(handle as number);
    },
  };

  /** Calls `fn` now and every `ms` after, on this clock. */
  every(ms: number, fn: () => void, offsetMs = 0): void {
    const tick = () => {
      fn();
      this.timers.setTimeout(tick, ms);
    };
    this.timers.setTimeout(tick, offsetMs);
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await settle();
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.#timers) if (e[1].at <= end && (next === null || e[1].at < next[1].at)) next = e;
      if (next === null) break;
      this.#timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = end;
    await settle();
  }
}

/** The host: a token bucket of `perSec` a second holding `burst`; empty, it answers 429 with Retry-After: 2. */
function phoenixHost(time: FakeTime, perSec = 1, burst = 20) {
  let tokens = burst;
  let at = time.now();
  let ok = 0;
  let limited = 0;
  const send = async (): Promise<Response> => {
    const now = time.now();
    tokens = Math.min(burst, tokens + ((now - at) / 1000) * perSec);
    at = now;
    if (tokens < 1) {
      limited++;
      return new Response('{"error":"rate_limited"}', { status: 429, headers: { 'retry-after': '2' } });
    }
    tokens -= 1;
    ok++;
    return new Response('{}', { status: 200 });
  };
  return { send, counts: () => ({ ok, limited }) };
}

interface Tally {
  sent: number;
  answered: number;
  skipped: number;
  limited: number;
  /** ms from asking to the answer, critical reads only. */
  waits: number[];
}

/**
 * serve's Phoenix load after this change, per class. `critical`: the risk engine's account read every 5 s (the trader
 * snapshot and the marks); the strategy loop takes that answer (accountWithin) and adds nothing. `funding`: the
 * overview once a minute, the market configs every 10 min, the marks when the scanner misses the risk engine's (every
 * 30 s here, to be safe), the book sync's ledger reads hourly. `book`, as the scanner asks for them every 5 s: the
 * held window's and the policy's books once 30 s old, then the off-desk ones once 5 min old, a book not read still due
 * at the next scan, and none asked for after the first one skipped in a scan. `history`: the all-market batch twice an
 * hour, and 4 single-market reads a scan for the first two minutes (a start with every week still to load).
 */
function steadyLoad(time: FakeTime, budget: HostBudget, send: () => Promise<Response>, o: { policyBooks?: number; offDeskBooks?: number; offDeskTtlMs?: number } = {}) {
  const tally: Record<ReadClass, Tally> = {
    critical: { sent: 0, answered: 0, skipped: 0, limited: 0, waits: [] },
    funding: { sent: 0, answered: 0, skipped: 0, limited: 0, waits: [] },
    book: { sent: 0, answered: 0, skipped: 0, limited: 0, waits: [] },
    history: { sent: 0, answered: 0, skipped: 0, limited: 0, waits: [] },
  };
  const read = (cls: ReadClass): Promise<boolean> => {
    const asked = time.now();
    tally[cls].sent++;
    return budget.run(cls, send).then((res) => {
      if (res.status === 429) {
        tally[cls].limited++;
        return false;
      }
      tally[cls].answered++;
      if (cls === 'critical') tally[cls].waits.push(time.now() - asked);
      return true;
    }, (err: unknown) => {
      if (!isReadSkipped(err)) throw err;
      tally[cls].skipped++;
      return false;
    });
  };
  const book = (ttl: number, policy: boolean) => ({ ttl, policy, readAt: -Infinity, ages: [] as number[] });
  const books = [
    ...Array.from({ length: o.policyBooks ?? 4 }, () => book(30_000, true)),
    ...Array.from({ length: o.offDeskBooks ?? 16 }, () => book(o.offDeskTtlMs ?? 300_000, false)),
  ];
  const t0 = time.now();
  time.every(5_000, () => {
    void read('critical');
    void read('critical');
  });
  time.every(60_000, () => void read('funding'), 100);
  time.every(600_000, () => void read('funding'), 200);
  time.every(30_000, () => void read('funding'), 300);
  time.every(3_600_000, () => {
    void read('funding');
    void read('funding');
  }, 5 * 60_000);
  time.every(5_000, () => {
    const now = time.now();
    const due = books.filter((b) => now - b.readAt >= b.ttl);
    void (async () => {
      for (const b of due) {
        if (!await read('book')) return;
        if (b.readAt !== -Infinity) b.ages.push(now - b.readAt);
        b.readAt = now;
      }
    })();
  }, 400);
  time.every(1_800_000, () => void read('history'), 600);
  time.every(5_000, () => {
    if (time.now() - t0 < 120_000) for (let i = 0; i < 4; i++) void read('history');
  }, 700);
  /** The oldest a book got before it was read again: the policy's books, or the off-desk ones. */
  const oldest = (policy: boolean) => Math.max(0, ...books.filter((b) => b.policy === policy).flatMap((b) => b.ages));
  return { tally, oldest };
}

const T0 = Date.UTC(2026, 10, 4, 12);

test('serve\'s steady load under PHOENIX_BUDGET on a host with Phoenix\'s limits: no 429 in 2 hours, every account read answered within 3 s', async () => {
  const time = new FakeTime(T0);
  const host = phoenixHost(time);
  const budget = new HostBudget('phoenix-sim', { ...PHOENIX_BUDGET, now: time.now, timers: time.timers, random: () => 0.5 });
  const { tally, oldest } = steadyLoad(time, budget, host.send);
  await time.advance(2 * 3_600_000);
  await time.advance(20_000);
  assert.equal(host.counts().limited, 0, JSON.stringify(tally.book));
  const c = tally.critical;
  // The reads asked for in the last 20 s may still wait; every one before has its answer.
  assert.ok(c.answered >= c.sent - 8 && c.skipped === 0 && c.limited === 0, JSON.stringify({ ...c, waits: undefined }));
  assert.ok(Math.max(...c.waits) <= 3_000, `the longest account wait ${Math.max(...c.waits)} ms`);
  // Under the cap with room to spare.
  assert.ok(host.counts().ok / (2 * 3_600 + 20) < 0.75, `${host.counts().ok} requests`);
  // The books that can trade are read again within a scan or two of turning 30 s old; the off-desk ones within 10 min.
  assert.ok(oldest(true) <= 45_000, `a policy book ${oldest(true)} ms old`);
  assert.ok(oldest(false) <= 600_000, `an off-desk book ${oldest(false)} ms old`);
  assert.equal(budget.state().ratePerSec, PHOENIX_BUDGET.ratePerSec, 'never cut: no 429 came');
});

test('the same load under the budget before (5 a second, a burst of 5) and its reads before (the loop\'s own account read, the marks every scan, every book every 30 s): Phoenix answers 429', async () => {
  const time = new FakeTime(T0);
  const host = phoenixHost(time);
  const before: HostBudgetOptions = {
    ...PHOENIX_BUDGET, ratePerSec: 5, burst: 5, scanMaxInFlight: 3, criticalReserve: 1, classReserve: {}, adaptive: null,
    now: time.now, timers: time.timers, random: () => 0.5,
  };
  const budget = new HostBudget('phoenix-sim', before);
  steadyLoad(time, budget, host.send, { policyBooks: 0, offDeskBooks: 20, offDeskTtlMs: 30_000 });
  // The strategy loop's free margin (two more requests) and the scanner's own marks, every 5 s.
  time.every(5_000, () => {
    for (const cls of ['critical', 'critical', 'funding'] as const) void budget.run(cls, host.send).catch(() => {});
  }, 50);
  await time.advance(10 * 60_000);
  assert.ok(host.counts().limited > 20, JSON.stringify(host.counts()));
});

test('class reserves: critical reads take the last tokens, the scanner\'s funding leaves 2, books 3, history 5', async () => {
  const time = new FakeTime(T0);
  const budget = new HostBudget('phoenix-sim', { ...PHOENIX_BUDGET, now: time.now, timers: time.timers, random: () => 0.5 });
  const sent: ReadClass[] = [];
  const go = (cls: ReadClass) => budget.run(cls, async () => {
    sent.push(cls);
    return new Response('{}', { status: 200 });
  }).then(() => 'sent', (err: unknown) => (isReadSkipped(err) ? `skipped ${err.reason}` : 'error'));
  // A full bucket of 10: history may spend 5 of it, books 2 more, funding 1 more, critical reads the rest.
  const history = Promise.all(Array.from({ length: 6 }, () => go('history')));
  await time.advance(0);
  assert.equal(sent.filter((c) => c === 'history').length, 5);
  const books = Promise.all(Array.from({ length: 3 }, () => go('book')));
  await time.advance(0);
  assert.equal(sent.filter((c) => c === 'book').length, 2);
  const funding = go('funding');
  await time.advance(0);
  assert.equal(sent.filter((c) => c === 'funding').length, 1);
  const critical = Promise.all([go('critical'), go('critical')]);
  await time.advance(0);
  assert.equal(sent.filter((c) => c === 'critical').length, 2, 'the last two tokens go to critical reads');
  assert.deepEqual(await critical, ['sent', 'sent']);
  assert.equal(await funding, 'sent');
  // The waiting scanner reads hear "budget" once their wait is up: the bucket refills at 0.75 a second, and every
  // token goes to the class that needs the fewest.
  await time.advance(5_000);
  assert.deepEqual((await books).sort(), ['sent', 'sent', 'skipped budget']);
  assert.deepEqual((await history).filter((r) => r !== 'sent'), ['skipped budget']);
});

test('a 429 halves the rate and empties the bucket; quiet minutes step it back by 0.1 up to 0.75; it never falls under 0.25', async () => {
  const time = new FakeTime(T0);
  const budget = new HostBudget('phoenix-sim', { ...PHOENIX_BUDGET, now: time.now, timers: time.timers, random: () => 0 });
  const limited = async () => new Response('{"error":"rate_limited"}', { status: 429, headers: { 'retry-after': '2' } });
  const ok = async () => new Response('{}', { status: 200 });
  assert.equal((await budget.run('book', limited)).status, 429);
  assert.equal(budget.state().ratePerSec, 0.375);
  // Empty: the next critical read waits for the cool-down (2 s) and a token at the new rate (1 / 0.375 s = 2.7 s).
  const asked = time.now();
  const read = budget.run('critical', ok);
  await time.advance(2_000);
  assert.equal(budget.state().sent, 1, 'not sent inside the cool-down');
  await time.advance(1_000);
  assert.equal((await read).status, 200);
  assert.ok(time.now() - asked >= 2_666, `${time.now() - asked} ms`);
  // A minute without a 429: 0.475; five more: back at 0.75, and no higher.
  await time.advance(60_000);
  await budget.run('critical', ok);
  assert.ok(Math.abs(budget.state().ratePerSec - 0.475) < 1e-9, `${budget.state().ratePerSec}`);
  await time.advance(10 * 60_000);
  await budget.run('critical', ok);
  assert.equal(budget.state().ratePerSec, 0.75);
  // 429 after 429: halved each time, down to the floor.
  for (let i = 0; i < 4; i++) {
    await time.advance(15_000);
    const res = budget.run('critical', limited);
    await time.advance(60_000);
    await res;
  }
  assert.equal(budget.state().ratePerSec, PHOENIX_BUDGET.adaptive!.minRatePerSec);
});

test('a host shared with someone else (it lets this process have 0.6 a second): the cut keeps 429s rare and every account read is answered', async () => {
  const time = new FakeTime(T0);
  const host = phoenixHost(time, 0.6, 20);
  const budget = new HostBudget('phoenix-sim', { ...PHOENIX_BUDGET, now: time.now, timers: time.timers, random: () => 0.5 });
  const { tally } = steadyLoad(time, budget, host.send);
  await time.advance(60 * 60_000);
  await time.advance(20_000);
  const c = tally.critical;
  assert.ok(c.answered >= c.sent - 8 && c.skipped === 0, JSON.stringify({ ...c, waits: Math.max(...c.waits) }));
  // A 429 now and then as the rate climbs back and finds the edge again; nowhere near one a scan.
  const cut = host.counts().limited;
  assert.ok(cut <= 30, JSON.stringify(host.counts()));
  // Without the cut, the same budget runs into the host's limit far more often.
  const time2 = new FakeTime(T0);
  const host2 = phoenixHost(time2, 0.6, 20);
  const fixed = new HostBudget('phoenix-sim', { ...PHOENIX_BUDGET, adaptive: null, now: time2.now, timers: time2.timers, random: () => 0.5 });
  steadyLoad(time2, fixed, host2.send);
  await time2.advance(60 * 60_000);
  assert.ok(host2.counts().limited > 3 * Math.max(1, cut), `${host2.counts().limited} against ${cut}`);
});
