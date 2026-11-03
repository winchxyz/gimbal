// The rescuer's state file: one per mode and desk, written atomically, read back exactly, and refused (never taken as
// "no holds") when any field is not what a save writes.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RescueState } from './state.ts';
import { RescueStateStore, parseRescueState, rescueStateFile } from './state.ts';

const state = (): RescueState => ({
  version: 1, savedAt: 1_700_000_000_000, unknown: null,
  holds: [{
    why: 'rescue a\'s transfer to dep-1 is PROCESSING at 1Click: it may still deliver', rescueId: 'a', venue: 'hyperliquid',
    quote: {
      method: 'evm_usdc_to_intents', quote: '{"amount":"20000000"}', signature: 'ed25519:abc', depositAddress: 'dep-1', amountIn: '20000000', amountInE8: '2000000000',
      amountOut: '1990000000', minAmountOut: '1980000000', minAmountOutE8: '1980000000', destinationAsset: 'x', recipient: '0xabc', costE8: '20000000',
      signedAtMs: 1_700_000_000_000, timeEstimateS: 30,
    },
    sinceMs: 1_700_000_000_000, heldAt: 1_700_000_100_000, reconcileSaid: false, paying: false, unsent: { deadAt: null },
    authorization: { from: '0xabc', nonce: '0x01', validBefore: 1_700_000_300 }, reservedE6: '20000000', status: 'PROCESSING',
  }],
  hl: { strandedE6: '1060000', inFlight: { rescueId: 'b', amountE6: '40000000', baseE6: '1060000', acceptedAt: 1_700_000_000_000, untilMs: 1_700_001_800_000 } },
  cap: [{ usd: 41.5, at: 1_700_000_000_000 }],
  seen: ['ledger-1'],
});

test('one file per mode and desk; a desk id that is not [a-z0-9-] is refused', () => {
  assert.equal(rescueStateFile('/s', 'mainnet', 'alpha'), join('/s', 'rescue-mainnet-alpha.json'));
  assert.notEqual(rescueStateFile('/s', 'mainnet', 'alpha'), rescueStateFile('/s', 'testnet', 'alpha'));
  assert.throws(() => rescueStateFile('/s', 'mainnet', '../x'), /not \[a-z0-9-\]/);
});

test('a save is read back exactly, written through a temporary file that does not stay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-state-'));
  const store = new RescueStateStore(join(dir, 'sub', 'rescue-mainnet-alpha.json'));
  assert.deepEqual(store.load(), { kind: 'none' });
  store.save(state());
  const second = { ...state(), unknown: 'the hl_withdraw of rescue c may have gone out' };
  store.save(second);
  assert.deepEqual(store.load(), { kind: 'loaded', state: second });
  assert.deepEqual(readdirSync(join(dir, 'sub')), ['rescue-mainnet-alpha.json']);
});

test('anything a save does not write makes the file unusable, never "no holds"', () => {
  const bad: [string, (s: Record<string, unknown>) => void, RegExp][] = [
    ['another version', (s) => { s.version = 2; }, /state\.version/],
    ['a negative amount', (s) => { (s.hl as Record<string, unknown>).strandedE6 = '-1'; }, /strandedE6/],
    ['a hold with no quote', (s) => { delete (s.holds as Record<string, unknown>[])[0]!.quote; }, /holds\[0\]\.quote/],
    ['an unknown venue', (s) => { (s.holds as Record<string, unknown>[])[0]!.venue = 'binance'; }, /holds\[0\]\.venue/],
    ['an authorization without a nonce', (s) => { delete ((s.holds as Record<string, unknown>[])[0]!.authorization as Record<string, unknown>).nonce; }, /authorization\.nonce/],
    ['no cap list', (s) => { delete s.cap; }, /state\.cap/],
    ['a cap entry with no time', (s) => { (s.cap as Record<string, unknown>[])[0]!.at = 'soon'; }, /cap\[0\]\.at/],
  ];
  for (const [name, spoil, why] of bad) {
    const s = JSON.parse(JSON.stringify(state())) as Record<string, unknown>;
    spoil(s);
    assert.throws(() => parseRescueState(s), why, name);
  }
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-state-'));
  const store = new RescueStateStore(join(dir, 'rescue-mainnet-alpha.json'));
  writeFileSync(store.path, '{"version":1,', 'utf8');
  const loaded = store.load();
  assert.equal(loaded.kind, 'unusable');
  assert.match(loaded.kind === 'unusable' ? loaded.problem : '', /is not a rescuer state this engine wrote/);
  assert.ok(existsSync(store.path), 'left as it is');
});
