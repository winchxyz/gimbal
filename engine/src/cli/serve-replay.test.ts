// The serve CLI's recording sink and where its replays start.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RecordLine } from '../venues/recorder.ts';
import { ThinningSink, replayStart } from './serve-replay.ts';

const T = Date.UTC(2026, 9, 31, 2);

function line(t: number, venue: RecordLine['venue'], method: RecordLine['method'], args: unknown[] = [], error?: string): RecordLine {
  return { t, venue, method, args, ms: 10, ...(error === undefined ? { result: [] } : { error }) };
}

function sink(): { thin: ThinningSink; out: RecordLine[] } {
  const out: RecordLine[] = [];
  return { thin: new ThinningSink({ write: (l) => out.push(l) }, { funding: 30_000, book: 30_000 }), out };
}

test('the same call is written at most once per gap; other calls and other methods are not held back', () => {
  const { thin, out } = sink();
  thin.write(line(T, 'hyperliquid', 'funding'));
  thin.write(line(T + 5_000, 'hyperliquid', 'funding'));            // within 30 s: dropped
  thin.write(line(T + 5_000, 'phoenix', 'funding'));                // another venue: written
  thin.write(line(T + 30_000, 'hyperliquid', 'funding'));           // 30 s later: written
  thin.write(line(T + 5_000, 'hyperliquid', 'marketFundingHistory', ['SOL', 1, 2]));
  thin.write(line(T + 6_000, 'hyperliquid', 'marketFundingHistory', ['SOL', 1, 2]));   // no gap for this method
  assert.deepEqual(out.map((l) => [l.t - T, l.venue, l.method]), [
    [0, 'hyperliquid', 'funding'], [5_000, 'phoenix', 'funding'], [30_000, 'hyperliquid', 'funding'],
    [5_000, 'hyperliquid', 'marketFundingHistory'], [6_000, 'hyperliquid', 'marketFundingHistory'],
  ]);
});

test('books are thinned per symbol whatever depth was asked', () => {
  const { thin, out } = sink();
  thin.write(line(T, 'orderly', 'book', ['PERP_SOL_USDC', 20]));
  thin.write(line(T + 1_000, 'orderly', 'book', ['PERP_SOL_USDC', 5]));
  thin.write(line(T + 1_000, 'orderly', 'book', ['PERP_ETH_USDC', 20]));
  assert.deepEqual(out.map((l) => l.args[0]), ['PERP_SOL_USDC', 'PERP_ETH_USDC']);
});

test('an error is always written, and so is the first success after it: a replay shows the outage as it was', () => {
  const { thin, out } = sink();
  thin.write(line(T, 'phoenix', 'funding'));
  thin.write(line(T + 5_000, 'phoenix', 'funding', [], 'HTTP 502'));
  thin.write(line(T + 10_000, 'phoenix', 'funding', [], 'HTTP 502'));
  thin.write(line(T + 15_000, 'phoenix', 'funding'));
  thin.write(line(T + 20_000, 'phoenix', 'funding'));               // 5 s after a success: dropped
  assert.deepEqual(out.map((l) => [l.t - T, l.error ?? 'ok']), [[0, 'ok'], [5_000, 'HTTP 502'], [10_000, 'HTTP 502'], [15_000, 'ok']]);
});

test('a replay starts 1 s after the recorded first scan had every first answer: funding, books and history', () => {
  const lines = [
    line(T + 400, 'hyperliquid', 'funding'),
    line(T + 900, 'phoenix', 'funding'),
    line(T + 300, 'orderly', 'funding', [], 'timeout'),           // errors do not count
    line(T + 1_200, 'orderly', 'funding'),
    line(T + 2_600, 'orderly', 'book', ['PERP_SOL_USDC', 20]),
    line(T + 1_700, 'hyperliquid', 'marketFundingHistory', ['SOL', 1, 2]),
    line(T + 9_000, 'orderly', 'book', ['PERP_SOL_USDC', 20]),    // a later answer: not the first
  ];
  assert.equal(replayStart(lines), T + 3_600);
  // Nothing the scanner reads: the first line.
  assert.equal(replayStart([line(T + 50, 'hyperliquid', 'markets'), line(T + 10, 'hyperliquid', 'account', ['0x0'])]), T + 10);
});
