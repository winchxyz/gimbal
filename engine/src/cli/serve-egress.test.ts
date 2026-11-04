import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EGRESS_URL, egressLine, logEgressOn, startEgressLog } from './serve-egress.ts';

type Answer = string | number | Error;

/** A stub fetch: each call takes the next answer (a string body, an HTTP error status, or a thrown error). */
function stubFetch(answers: Answer[]) {
  const calls: { url: string; signal: boolean }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), signal: init?.signal instanceof AbortSignal });
    const a = answers.shift();
    if (a === undefined) throw new Error('no more answers');
    if (a instanceof Error) throw a;
    if (typeof a === 'number') return new Response('busy', { status: a });
    return new Response(a, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function waits() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => { slept.push(ms); } };
}

test('flag: only GIMBAL_LOG_EGRESS=1 turns it on', () => {
  assert.equal(logEgressOn(() => undefined), false);
  assert.equal(logEgressOn((n) => (n === 'GIMBAL_LOG_EGRESS' ? '' : undefined)), false);
  assert.equal(logEgressOn((n) => (n === 'GIMBAL_LOG_EGRESS' ? 'true' : undefined)), false);
  assert.equal(logEgressOn((n) => (n === 'GIMBAL_LOG_EGRESS' ? '1' : undefined)), true);
});

test('three lookups a few seconds apart, the distinct IPv4 answers on one line, in the order seen', async () => {
  const f = stubFetch(['203.0.113.7\n', '198.51.100.2', '203.0.113.7']);
  const w = waits();
  const line = await egressLine({ fetch: f.fetchImpl, sleep: w.sleep });
  assert.equal(line, 'egress ipv4: 203.0.113.7, 198.51.100.2');
  assert.deepEqual(f.calls.map((c) => c.url), [EGRESS_URL, EGRESS_URL, EGRESS_URL]);
  assert.ok(f.calls.every((c) => c.signal), 'every lookup carries a timeout');
  assert.deepEqual(w.slept, [3000, 3000], 'a gap before the second and the third lookup only');
});

test('a failed lookup is named on the same line; all failed is "unknown"; never rejects', async () => {
  const w = waits();
  const some = stubFetch([new Error('The operation was aborted due to timeout'), '203.0.113.7', 503]);
  assert.equal(
    await egressLine({ fetch: some.fetchImpl, sleep: w.sleep }),
    'egress ipv4: 203.0.113.7 (2 of 3 lookups failed: The operation was aborted due to timeout; HTTP 503)',
  );
  const none = stubFetch(['<html>', '2001:db8::1', new Error('getaddrinfo ENOTFOUND api.ipify.org')]);
  assert.equal(
    await egressLine({ fetch: none.fetchImpl, sleep: w.sleep }),
    'egress ipv4: unknown (3 of 3 lookups failed: not an IPv4 address (<html>); not an IPv4 address (2001:db8::1); getaddrinfo ENOTFOUND api.ipify.org)',
  );
  const same = stubFetch([502, 502, 502]);
  assert.equal(await egressLine({ fetch: same.fetchImpl, sleep: w.sleep }), 'egress ipv4: unknown (3 of 3 lookups failed: HTTP 502)');
});

test('flag off: no request and no line', () => {
  const f = stubFetch([]);
  const lines: string[] = [];
  const egress = startEgressLog({ env: () => undefined, log: (l) => lines.push(l), fetch: f.fetchImpl });
  assert.equal(egress, null);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(lines, []);
});

test('flag on: one line at start, then one per interval, never two checks at once; stop() ends it', async () => {
  const f = stubFetch(['203.0.113.7', '203.0.113.8', '203.0.113.9', '203.0.113.7', '203.0.113.7', '203.0.113.7']);
  const lines: string[] = [];
  const w = waits();
  const egress = startEgressLog({
    env: (n) => (n === 'GIMBAL_LOG_EGRESS' ? '1' : undefined),
    log: (l) => lines.push(l), fetch: f.fetchImpl, sleep: w.sleep, everyMs: 30,
  });
  assert.ok(egress !== null);
  await egress.current;
  assert.deepEqual(lines, ['egress ipv4: 203.0.113.7, 203.0.113.8, 203.0.113.9']);
  while (f.calls.length < 4) await new Promise((r) => setTimeout(r, 5)); // the next interval's check has begun
  egress.stop();
  await egress.current;
  assert.deepEqual(lines, ['egress ipv4: 203.0.113.7, 203.0.113.8, 203.0.113.9', 'egress ipv4: 203.0.113.7']);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(lines.length, 2, 'nothing after stop()');
  assert.equal(f.calls.length, 6, 'three lookups per check, no retries');
});

test('a slow check is not overlapped by the next tick', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  const slowFetch = (async () => {
    calls++;
    await gate;
    return new Response('203.0.113.7');
  }) as typeof fetch;
  const lines: string[] = [];
  const egress = startEgressLog({
    env: () => '1', log: (l) => lines.push(l), fetch: slowFetch, sleep: async () => {}, everyMs: 10,
  });
  assert.ok(egress !== null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1, 'the ticks while the first lookup hangs start nothing');
  egress.stop();
  release();
  await egress.current;
  assert.deepEqual(lines, ['egress ipv4: 203.0.113.7']);
});
