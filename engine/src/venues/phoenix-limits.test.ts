// PHOENIX_BUDGET against Phoenix's measured limits, on a fake clock: a host that answers like perp-api.phoenix.trade
// (one token bucket per IP, 1 request a second, a burst of 20, then 429 with Retry-After: 2) under serve's steady load
// (the risk engine's account read every 5 s, the scanner's funding, books and history, the hourly book sync). Also the
// class reserves (critical reads first, history last) and the rate cut after a 429 (a host shared with someone else).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BudgetTimers, HostBudgetOptions, ReadClass } from './http-budget.ts';
import { ACCOUNT_READ_DEADLINE_MS } from '../risk/sources.ts';
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
  /** Someone else on the same IP spends the whole bucket now. */
  const drain = () => {
    tokens = 0;
    at = time.now();
  };
  return { send, drain, counts: () => ({ ok, limited }) };
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
 * snapshot, and the marks when the refresh between ticks did not bring them); the strategy loop takes that answer
 * (accountWithin) and adds nothing. `funding`: the marks refresh 2.5 s after each tick (the scanner shares it), the
 * overview once a minute, the market configs every 10 min, the book sync's ledger reads hourly. `book`, as the scanner
 * asks for them every 5 s: the held window's and the policy's books once 30 s old, then the off-desk ones once 5 min
 * old, a book not read still due
 * at the next scan, and none asked for after the first one skipped in a scan. `history`: the all-market batch twice an
 * hour, and 4 single-market reads a scan for the first two minutes (a start with every week still to load).
 */
function steadyLoad(time: FakeTime, budget: HostBudget, send: () => Promise<Response>, o: { policyBooks?: number; offDeskBooks?: number; offDeskTtlMs?: number; risk?: 'cached' | 'both' } = {}) {
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
  // The risk tick: the trader snapshot, and the marks too unless the refresh between ticks brought them at most 5 s
  // ago (phoenix.ts MARKS_MAX_AGE_MS); `both` is the read before, the two every tick. `ticks`: ms from the tick to
  // its last answer, Infinity for a tick a read of which was not answered.
  const ticks: number[] = [];
  let marksAt = -Infinity;
  time.every(5_000, () => {
    const start = time.now();
    const fresh = o.risk !== 'both' && start - marksAt <= 5_000;
    const reads = fresh ? [read('critical')] : [read('critical'), read('critical')];
    if (!fresh) marksAt = start;
    void Promise.all(reads).then((answered) => ticks.push(answered.every(Boolean) ? time.now() - start : Infinity));
  });
  if (o.risk !== 'both') {
    time.every(5_000, () => {
      void read('funding').then((answered) => {
        if (answered) marksAt = time.now();
      });
    }, 2_500);
  }
  time.every(60_000, () => void read('funding'), 100);
  time.every(600_000, () => void read('funding'), 200);
  // The scanner's marks are the refresh's (risk 'both': the risk tick's, missed now and then).
  if (o.risk === 'both') time.every(30_000, () => void read('funding'), 300);
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
  return { tally, oldest, ticks };
}

const T0 = Date.UTC(2026, 10, 4, 12);

test('serve\'s steady load under PHOENIX_BUDGET on a host with Phoenix\'s limits: no 429 in 2 hours, every account read answered within 3 s', async () => {
  const time = new FakeTime(T0);
  const host = phoenixHost(time);
  const budget = new HostBudget('phoenix-sim', { ...PHOENIX_BUDGET, now: time.now, timers: time.timers, random: () => 0.5 });
  const { tally, oldest, ticks } = steadyLoad(time, budget, host.send);
  await time.advance(2 * 3_600_000);
  await time.advance(20_000);
  assert.equal(host.counts().limited, 0, JSON.stringify(tally.book));
  assert.ok(ticks.length >= 1_440 && Math.max(...ticks) <= 3_000, `${ticks.length} risk ticks, the slowest ${Math.max(...ticks)} ms`);
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
    ...PHOENIX_BUDGET, ratePerSec: 5, burst: 5, scanMaxInFlight: 3, criticalReserve: 1, classReserve: {}, adaptive: null, criticalFloor: null,
    now: time.now, timers: time.timers, random: () => 0.5,
  };
  const budget = new HostBudget('phoenix-sim', before);
  steadyLoad(time, budget, host.send, { policyBooks: 0, offDeskBooks: 20, offDeskTtlMs: 30_000, risk: 'both' });
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
  // The shared bucket is empty, the critical floor is not: the next critical read waits out the server's Retry-After
  // (2 s) alone and goes on a floor token, while the scanner's funding waits for the shared bucket at the new rate.
  const asked = time.now();
  const read = budget.run('critical', ok);
  const funding = budget.run('funding', ok).then(() => 'sent', (err: unknown) => (isReadSkipped(err) ? `skipped ${err.reason}` : 'error'));
  await time.advance(1_999);
  assert.equal(budget.state().sent, 1, 'not sent inside the cool-down');
  await time.advance(1);
  assert.equal((await read).status, 200);
  assert.equal(time.now() - asked, 2_000);
  assert.equal(budget.state().sent, 2, 'the funding read still waits');
  assert.ok(Math.abs(budget.state().floorTokens - 1) < 1e-9, `${budget.state().floorTokens} floor tokens`);
  // It needs 3 shared tokens, 8 s at the cut rate: past its 3 s wait, so the scanner is the one that goes without.
  await time.advance(3_000);
  assert.equal(await funding, 'skipped budget');
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

test('critical reads wait for the server\'s Retry-After only, never for an older backoff of a 429 without one', async () => {
  const time = new FakeTime(T0);
  // No retries, so each 429 comes back as it came.
  const retries = { critical: 0, funding: 0, book: 0, history: 0 };
  const budget = new HostBudget('phoenix-sim', { ...PHOENIX_BUDGET, retries, now: time.now, timers: time.timers, random: () => 0 });
  // 429s without Retry-After: the budget's own backoff (0.5, 1, 2, 4 s at the lowest jitter) holds the scanner; critical
  // reads go on meanwhile (they wait for the server's pause only).
  // 3 s apart, so each finds a floor token (0.45 a second) and is sent at once.
  for (let i = 0; i < 4; i++) {
    await time.advance(3_000);
    assert.equal((await budget.run('critical', async () => new Response('', { status: 429 }))).status, 429);
  }
  assert.ok(budget.state().retryAt - time.now() >= 4_000, `${budget.state().retryAt - time.now()} ms of backoff`);
  assert.equal(budget.state().criticalRetryAt, 0, 'no server pause yet');
  // Then one with Retry-After: 2. Critical reads wait those 2 s, not the backoff still running.
  assert.equal((await budget.run('critical', async () => new Response('', { status: 429, headers: { 'retry-after': '2' } }))).status, 429);
  assert.equal(budget.state().criticalRetryAt, time.now() + 2_000);
  assert.ok(budget.state().retryAt > budget.state().criticalRetryAt);
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

test('a 429 storm (a host that allows 0.6 a second, emptied by someone else every 20 s): every risk read is answered inside its 7 s deadline', async () => {
  const run = async (options: HostBudgetOptions, risk: 'cached' | 'both') => {
    const time = new FakeTime(T0);
    const host = phoenixHost(time, 0.6, 20);
    const budget = new HostBudget('phoenix-sim', { ...options, now: time.now, timers: time.timers, random: () => 0.5 });
    const { ticks } = steadyLoad(time, budget, host.send, { risk });
    time.every(20_000, host.drain, 1_000);
    await time.advance(60 * 60_000);
    await time.advance(20_000);
    return { ticks, limited: host.counts().limited, rate: budget.state().ratePerSec };
  };
  const now = await run(PHOENIX_BUDGET, 'cached');
  // The host answers 429 after every drain until the cut rate is under it (from 0.75 to 0.375 to 0.25 a second).
  assert.ok(now.limited >= 10 && now.rate < PHOENIX_BUDGET.ratePerSec, `${now.limited} 429s, rate ${now.rate}`);
  assert.ok(now.ticks.length >= 720, `${now.ticks.length} risk ticks`);
  const slowest = Math.max(...now.ticks);
  assert.ok(slowest <= ACCOUNT_READ_DEADLINE_MS, `the slowest risk tick ${slowest} ms`);
  // Before: the cut and the drain reached the risk reads too, two requests a tick: past the deadline again and again.
  const before = await run({ ...PHOENIX_BUDGET, criticalFloor: null }, 'both');
  const late = before.ticks.filter((t) => t > ACCOUNT_READ_DEADLINE_MS).length;
  assert.ok(before.limited > 5 * now.limited && late > before.ticks.length / 2, `before: ${before.limited} 429s, ${late} of ${before.ticks.length} risk ticks late`);
});
