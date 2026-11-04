// The per-host request budget on fake requests: the rate cap and the concurrency limit, critical reads ahead of the
// scanner's, Retry-After (an hour of it cut to the cap), the backoff without it, the cool-down that skips scanner reads,
// waits that run out, a caller's deadline (readBy), and a request that times out freeing its slot.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostBudgetOptions, ReadKind } from './http-budget.ts';
import {
  HostBudget, PHOENIX_BUDGET, ReadSkipped, isReadSkipped, readBy, readClass, requestTimeoutMs, retryAfterMs, scanRead,
} from './http-budget.ts';

const FAST: HostBudgetOptions = {
  ...PHOENIX_BUDGET,
  ratePerSec: 1000, burst: 100, maxInFlight: 4, scanMaxInFlight: 3, criticalReserve: 1, classReserve: {}, adaptive: null, criticalFloor: null,
  maxWaitMs: { critical: 3_000, funding: 1_000, book: 500, history: 500 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = () => new Response('{}', { status: 200 });
const limited = (retryAfter?: string) => new Response('{"error":"rate_limited"}', { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } });

/** A read of `kind` through `b`, from the scanner when `scan`, recording when it was sent. */
function read(b: HostBudget, kind: ReadKind, scan: boolean, send: () => Promise<Response>): Promise<Response> {
  const go = () => b.run(readClass(kind), send);
  return scan ? scanRead(go) : go();
}

test('Retry-After: seconds or an HTTP date; anything else is no answer', () => {
  assert.equal(retryAfterMs('1', 0), 1000);
  assert.equal(retryAfterMs('0.25', 0), 250);
  assert.equal(retryAfterMs(new Date(5_000).toUTCString(), 2_000), 3_000);
  assert.equal(retryAfterMs(null, 0), null);
  assert.equal(retryAfterMs('soon', 0), null);
  assert.equal(retryAfterMs('-1', 0), null);
});

test('reads outside the scanner are critical; inside it, by kind', async () => {
  assert.equal(readClass('book'), 'critical');
  assert.equal(readClass('account'), 'critical');
  await scanRead(async () => {
    assert.equal(readClass('book'), 'book');
    assert.equal(readClass('history'), 'history');
    assert.equal(readClass('funding'), 'funding');
    await sleep(1);
    // The context survives an await.
    assert.equal(readClass('book'), 'book');
  });
});

test('the rate cap and the concurrency limit: never more in flight than allowed, sends spaced by the rate', async () => {
  const b = new HostBudget('test', { ...FAST, ratePerSec: 50, burst: 2, maxInFlight: 2, scanMaxInFlight: 1 });
  let inFlight = 0;
  let most = 0;
  const sentAt: number[] = [];
  const t0 = Date.now();
  const send = async () => {
    sentAt.push(Date.now() - t0);
    inFlight++;
    most = Math.max(most, inFlight);
    await sleep(5);
    inFlight--;
    return ok();
  };
  await Promise.all(Array.from({ length: 8 }, () => read(b, 'account', false, send)));
  assert.equal(most, 2);
  assert.equal(sentAt.length, 8);
  // 2 at once from the burst, then one per 20 ms: the 8th no sooner than 6 × 20 ms after the start.
  assert.ok(sentAt[7]! >= 110, `8th sent at ${sentAt[7]} ms`);
  assert.equal(b.state().sent, 8);
});

test('critical reads go ahead of queued scanner books, and a scanner read never takes the last token or slot', async () => {
  const b = new HostBudget('test', { ...FAST, ratePerSec: 40, burst: 2, maxInFlight: 2, scanMaxInFlight: 1, criticalReserve: 1 });
  const order: string[] = [];
  const send = (name: string) => async () => {
    order.push(name);
    await sleep(10);
    return ok();
  };
  const books = Array.from({ length: 4 }, (_, i) => read(b, 'book', true, send(`book${i}`)).catch((e: unknown) => e));
  await sleep(1);
  // Queued behind the books, sent before the books still waiting.
  const account = read(b, 'account', false, send('account'));
  await account;
  await Promise.all(books);
  assert.equal(order[0], 'book0');
  assert.ok(order.indexOf('account') <= 1, order.join(' '));
  assert.ok(order.indexOf('account') < order.indexOf('book2'), order.join(' '));
});

test('a scanner read that cannot be sent within its wait is skipped (budget), never sent late', async () => {
  const b = new HostBudget('test', { ...FAST, ratePerSec: 2, burst: 2, criticalReserve: 1, maxWaitMs: { ...FAST.maxWaitMs, book: 100 } });
  let sent = 0;
  const send = async () => {
    sent++;
    return ok();
  };
  // Burst 2 with one kept for critical reads: one book goes now; the next would wait ~500 ms for a token.
  const results = await Promise.allSettled([read(b, 'book', true, send), read(b, 'book', true, send), read(b, 'book', true, send)]);
  assert.equal(results[0]!.status, 'fulfilled');
  for (const r of results.slice(1)) {
    assert.equal(r.status, 'rejected');
    assert.ok(isReadSkipped((r as PromiseRejectedResult).reason));
    assert.equal(((r as PromiseRejectedResult).reason as ReadSkipped).reason, 'budget');
  }
  await sleep(150);
  assert.equal(sent, 1);
  // The critical read still has its token.
  await read(b, 'account', false, send);
  assert.equal(sent, 2);
});

test('a 429 with Retry-After: a critical read waits it out and is retried; the scanner\'s books are skipped meanwhile', async () => {
  const b = new HostBudget('test', { ...FAST, random: () => 0 });
  let calls = 0;
  const t0 = Date.now();
  const account = read(b, 'account', false, async () => (++calls === 1 ? limited('0.3') : ok()));
  await sleep(20);
  const st = b.state();
  assert.equal(st.rateLimited, 1);
  assert.ok(st.retryAt >= t0 + 300 && st.retryAt <= Date.now() + 300, `retryAt ${st.retryAt - t0}`);
  // A book now is told at once, and nothing is sent for it.
  let bookSent = 0;
  await assert.rejects(read(b, 'book', true, async () => {
    bookSent++;
    return ok();
  }), (err: unknown) => isReadSkipped(err) && err.reason === 'cooling' && err.retryAt !== null);
  assert.equal(bookSent, 0);
  const res = await account;
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 >= 295, `retried after ${Date.now() - t0} ms`);
  // The quiet period for scanner books outlasts Retry-After (5 s at the base step).
  assert.ok(b.state().quietUntil >= t0 + 5_000 * 0.75);
});

test('a 429 without Retry-After: exponential backoff with jitter; a scanner book is not retried', async () => {
  let rnd = 0;
  const b = new HostBudget('test', { ...FAST, backoffBaseMs: 200, backoffMaxMs: 1_000, random: () => rnd });
  let calls = 0;
  const t0 = Date.now();
  // A book: one request, its 429 returned as it came.
  const first = await scanRead(() => b.run(readClass('book'), async () => {
    calls++;
    return limited();
  }));
  assert.equal(first.status, 429);
  assert.equal(calls, 1);
  // Half the step at the lowest jitter: 100 ms.
  assert.ok(b.state().retryAt - t0 >= 100 && b.state().retryAt - t0 < 150, `${b.state().retryAt - t0}`);
  // A second 429 in a row doubles the step: 400 ms at the highest jitter.
  rnd = 1;
  await sleep(110);
  const t1 = Date.now();
  const second = await b.run('critical', async () => {
    calls++;
    return limited();
  }).catch((e: unknown) => e);
  // Critical retries run out on the cap of the backoff steps (400, 800, 1000 ms) within its 3 s wait.
  assert.ok(second instanceof Response && second.status === 429);
  assert.equal(b.state().rateLimited, 5);
  assert.ok(Date.now() - t1 >= 400 + 800 + 1000 - 50, `${Date.now() - t1} ms`);
});

test('a critical read whose cool-down outlasts its wait is not sent: skipped (cooling)', async () => {
  const b = new HostBudget('test', { ...FAST, maxWaitMs: { ...FAST.maxWaitMs, critical: 200 } });
  const res = await b.run('critical', async () => limited('5'));
  // Retry-After 5 s is past the read's 200 ms: the 429 is returned, not retried.
  assert.equal(res.status, 429);
  let sent = 0;
  await assert.rejects(b.run('critical', async () => {
    sent++;
    return ok();
  }), (err: unknown) => isReadSkipped(err) && err.reason === 'cooling');
  assert.equal(sent, 0);
});

test('the scanner\'s funding read waits out a short cool-down instead of being skipped', async () => {
  const b = new HostBudget('test', { ...FAST, random: () => 0 });
  await b.run('critical', async () => limited('0.1'));
  const t0 = Date.now();
  const res = await read(b, 'funding', true, async () => ok());
  assert.equal(res.status, 200);
  assert.ok(Date.now() - t0 >= 80, `${Date.now() - t0} ms`);
});

test('a request that times out frees its slot: the next one is sent', async () => {
  const b = new HostBudget('test', { ...FAST, maxInFlight: 1 });
  const hang = (signal: AbortSignal) => new Promise<Response>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const t0 = Date.now();
  await assert.rejects(b.run('critical', () => hang(AbortSignal.timeout(50))), (err: unknown) => (err as Error).name === 'TimeoutError');
  const res = await b.run('critical', async () => ok());
  assert.equal(res.status, 200);
  assert.ok(Date.now() - t0 < 1_000);
  assert.equal(b.state().inFlight, 0);
});

test('a Retry-After of an hour is cut to retryAfterMaxMs: a critical read probes the host after the capped wait', async () => {
  const b = new HostBudget('test', { ...FAST, retryAfterMaxMs: 200, random: () => 0 });
  let sent = 0;
  const t0 = Date.now();
  const res = await b.run('critical', async () => (++sent === 1 ? limited('3600') : ok()));
  assert.equal(res.status, 200);
  assert.equal(sent, 2);
  const waited = Date.now() - t0;
  assert.ok(waited >= 190 && waited < 2_000, `${waited} ms`);
  // An HTTP date an hour away is cut the same way.
  const b2 = new HostBudget('test', { ...FAST, retryAfterMaxMs: 200, random: () => 0 });
  await b2.run('book', async () => limited(new Date(Date.now() + 3_600_000).toUTCString()));
  assert.ok(b2.state().retryAt - Date.now() <= 200, `${b2.state().retryAt - Date.now()} ms`);
  // Phoenix's cap, with its 15 % spread, ends inside a critical read's wait.
  assert.ok(PHOENIX_BUDGET.retryAfterMaxMs * 1.15 < PHOENIX_BUDGET.maxWaitMs.critical);
});

test('readBy: a critical read waits for the budget only until the caller\'s deadline, and its request timeout ends there', async () => {
  // One token, half a second to the next.
  const b = new HostBudget('test', { ...FAST, ratePerSec: 2, burst: 1 });
  assert.equal((await b.run('critical', async () => ok())).status, 200);
  let sent = 0;
  const t0 = Date.now();
  await assert.rejects(readBy(Date.now() + 100, () => b.run(readClass('account'), async () => {
    sent++;
    return ok();
  })), (err: unknown) => isReadSkipped(err) && err.reason === 'budget');
  assert.equal(sent, 0);
  assert.ok(Date.now() - t0 < 400, `gave up after ${Date.now() - t0} ms`);
  // Without a deadline the same read waits for the token and is sent.
  assert.equal((await b.run(readClass('account'), async () => ok())).status, 200);

  assert.equal(requestTimeoutMs(10_000), 10_000);
  const inside = await readBy(Date.now() + 50, async () => requestTimeoutMs(10_000));
  assert.ok(inside <= 50 && inside >= 1, `${inside}`);
  // A deadline inside another keeps the earlier; a past one skips at once.
  assert.ok(await readBy(Date.now() + 50, () => readBy(Date.now() + 5_000, async () => requestTimeoutMs(10_000))) <= 50);
  await assert.rejects(readBy(Date.now() - 1, () => b.run('critical', async () => ok())), (err: unknown) => isReadSkipped(err) && err.reason === 'budget');
});
