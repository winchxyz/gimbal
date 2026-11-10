// The history cache file on its own: its name, an atomic write read back, and what a load keeps of each leg.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileHistoryStore, historyCacheFile, parseHistoryCache, serializeHistoryCache } from './history-cache.ts';
import { HOUR_MS } from './history.ts';

const CURRENT = Date.UTC(2026, 10, 10, 4);
const NOW = CURRENT + 20 * 60_000;

/** A leg read this hour: `hours` booked rates ending with the hour before this one. */
const leg = (key: string, hours: number, fields: Record<string, unknown> = {}) => ({
  key, loadedHour: CURRENT, points: 176, olderDone: true, from: CURRENT - hours * HOUR_MS, rates: Array.from({ length: hours }, () => 0.00001), ...fields,
});

test('the file is named as the journal\'s, per mode, contract and desk; a write is whole and read back', () => {
  assert.equal(historyCacheFile('/data/gimbal', 'mainnet', 'gimbal.near', 'd1'), join('/data/gimbal', 'history-mainnet-gimbal.near-d1.json'));
  assert.equal(historyCacheFile('/s', 'testnet', null, null), join('/s', 'history-testnet.json'));
  assert.throws(() => historyCacheFile('/s', 'mainnet', '../x', 'd1'), /cannot name a history cache file/);

  const dir = mkdtempSync(join(tmpdir(), 'gimbal-history-'));
  try {
    const store = new FileHistoryStore(join(dir, 'sub', 'history-mainnet.json'));
    assert.equal(store.read(), null, 'no file yet');
    const text = serializeHistoryCache(NOW, [leg('hyperliquid|BTC', 352)]);
    store.write(text);
    store.write(text);
    assert.equal(store.read(), text);
    // No temporary file is left next to it.
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['history-mainnet.json']);
    assert.deepEqual(parseHistoryCache(store.read()!, NOW).legs.map((l) => l.key), ['hyperliquid|BTC']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a load keeps the two weeks and the 8 h overlap, and drops each leg it cannot trust', () => {
  const text = serializeHistoryCache(NOW, [
    leg('hyperliquid|BTC', 400),                                             // longer than kept: trimmed to 344 h
    leg('phoenix|SOL', 0, { points: 0, olderDone: false }),                  // the venue answered nothing: kept
    leg('hyperliquid|BTC', 100),                                             // a second copy of a key
    leg('hyperliquid|ETH', 100, { loadedHour: CURRENT + HOUR_MS }),          // read in the future
    leg('hyperliquid|SOL', 100, { loadedHour: CURRENT - 169 * HOUR_MS, from: CURRENT - 269 * HOUR_MS }), // read over a week ago
    leg('hyperliquid|DOGE', 100, { from: CURRENT - 98 * HOUR_MS }),          // an hour after its read
    leg('hyperliquid|WIF', 10, { from: CURRENT - 200 * HOUR_MS }),           // stops short of the next week read
    leg('hyperliquid|HYPE', 10, { rates: [1, 2, 'x'] }),                     // not a rate
    leg('hyperliquid|kPEPE', 10, { points: -1 }),
    leg('Bad Key', 10),
    leg('hyperliquid|ENA', 10, { olderDone: 'yes' }),
  ]);
  const load = parseHistoryCache(text, NOW);
  assert.equal(load.problem, null);
  assert.equal(load.dropped, 9);
  assert.deepEqual(load.legs.map((l) => [l.key, (CURRENT - l.from) / HOUR_MS, l.rates.length]), [['hyperliquid|BTC', 344, 344], ['phoenix|SOL', 0, 0]]);
  assert.equal(parseHistoryCache('[]', NOW).problem, 'not an object');
  assert.equal(parseHistoryCache(JSON.stringify({ version: 1, savedAt: NOW }), NOW).problem, 'no legs');
});
