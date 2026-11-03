// serve's start errors (review S1): a read that fails is retried with backoff capped at 60 s; only a ConfigError stops.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, START_RETRY_MAX_MS, retryStart, startBackoffMs } from './start-errors.ts';

test('the backoff: 5, 10, 20, 40 s, then 60 s for good', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50, 10_000].map(startBackoffMs), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
  assert.equal(START_RETRY_MAX_MS, 60_000);
});

test('retryStart: a read that fails is tried again until it answers; a ConfigError is thrown at once', async () => {
  const waits: number[] = [];
  const lines: string[] = [];
  let calls = 0;
  const got = await retryStart('contract gimbal.near', async () => {
    calls++;
    if (calls < 4) throw new Error('near rpc: 503');
    return 'desk';
  }, { log: (l) => lines.push(l), sleep: async (ms) => { waits.push(ms); } });
  assert.equal(got, 'desk');
  assert.deepEqual(waits, [5_000, 10_000, 20_000]);
  assert.match(lines[0]!, /^contract gimbal\.near: not read at start \(try 1: near rpc: 503\); trying again in 5 s/);
  calls = 0;
  await assert.rejects(retryStart('contract', async () => {
    calls++;
    throw new ConfigError('gimbal.near is a testnet contract');
  }, { log: () => {}, sleep: async () => {} }), (err: unknown) => err instanceof ConfigError);
  assert.equal(calls, 1);
});
