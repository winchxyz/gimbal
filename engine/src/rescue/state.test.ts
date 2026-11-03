// The rescuer's state file: one per mode, contract, desk and desk EVM address, written atomically (fsync, then a
// rename retried on EPERM / EBUSY / EACCES), read back exactly, and refused (never taken as "no holds") when any field
// is not what a save writes or the file belongs to another contract, desk or address.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RescueIdentity, RescueSnapshot } from './state.ts';
import { MANUAL_CLEAR, RescueStateStore, parseRescueState, rescueStateFile } from './state.ts';

const ID: RescueIdentity = { contractId: 'gimbal.near', deskId: 'alpha', evm: '0x1a642f0e3c3af545e7acbd38b07251b3990914f1' };

const snapshot = (): RescueSnapshot => ({
  version: 2, savedAt: 1_700_000_000_000, unknown: null,
  holds: [{
    why: 'rescue a\'s transfer to dep-1 is PROCESSING at 1Click: it may still deliver', rescueId: 'a', venue: 'hyperliquid',
    quote: {
      method: 'evm_usdc_to_intents', quote: '{"amount":"20000000"}', signature: 'ed25519:abc', depositAddress: 'dep-1', amountIn: '20000000', amountInE8: '2000000000',
      amountOut: '1990000000', minAmountOut: '1980000000', minAmountOutE8: '1980000000', destinationAsset: 'x', recipient: '0xabc', costE8: '20000000',
      signedAtMs: 1_700_000_000_000, deadlineMs: 1_700_001_800_000, timeEstimateS: 30,
    },
    sinceMs: 1_700_000_000_000, heldAt: 1_700_000_100_000, reconcileSaid: false, paying: false, unsent: { deadAt: null },
    authorization: { from: '0xabc', nonce: '0x01', validBefore: 1_700_000_300 }, arbBlock: '123456', scannedTo: '123500', paidLog: null, reservedE6: '20000000', status: 'PROCESSING',
    counter: '4', nearTx: 'NearTx111', solana: null,
  }, {
    why: 'rescue p was paying dep-2 (sol_sign_rescue) when the engine stopped', rescueId: 'p', venue: 'hyperliquid',
    quote: {
      method: 'sol_sign_rescue', quote: '{"amount":"5000000"}', signature: 'ed25519:def', depositAddress: 'dep-2', amountIn: '5000000', amountInE8: '500000000',
      amountOut: '490000000', minAmountOut: '480000000', minAmountOutE8: '480000000', destinationAsset: 'x', recipient: '0xabc', costE8: '10000000',
      signedAtMs: 1_700_000_000_000, deadlineMs: 1_700_001_800_000, timeEstimateS: null,
    },
    sinceMs: 1_700_000_000_000, heldAt: 1_700_000_100_000, reconcileSaid: true, paying: false, unsent: { deadAt: 1_700_000_200_000 },
    authorization: null, arbBlock: null, scannedTo: null, paidLog: null, reservedE6: '0', status: null,
    counter: null, nearTx: null, solana: { lastValidBlockHeight: 350_000_000, signature: '5sig' }, creditBaseE6: '400000',
  }],
  hl: {
    strandedE6: '1060000',
    inFlight: {
      rescueId: 'b', amountE6: '40000000', fromBlock: '123400', acceptedAt: 1_700_000_000_000, untilMs: 1_700_001_800_000, scannedTo: '123450',
      tx: [{ chain: 'hyperliquid', id: '0xwithdraw', url: 'https://app.hyperliquid.xyz/explorer/tx/0xwithdraw' }],
    },
    expired: [{ rescueId: 'z', amountE6: '13000000', fromBlock: '120000', acceptedAt: 1_699_990_000_000, untilMs: 1_699_991_800_000, scannedTo: null, tx: [] }],
  },
  cap: [{ usd: 41.5, at: 1_700_000_000_000 }],
  seen: ['ledger-1', 'arb:0xabc:3'],
});

const tmp = () => mkdtempSync(join(tmpdir(), 'gimbal-state-'));

test('one file per mode, contract, desk and desk EVM address; ids that are not safe in a file name are refused', () => {
  assert.equal(rescueStateFile('/s', 'mainnet', ID), join('/s', 'rescue-mainnet-gimbal.near-alpha-0x1a642f0e3c3af545e7acbd38b07251b3990914f1.json'));
  assert.notEqual(rescueStateFile('/s', 'mainnet', ID), rescueStateFile('/s', 'testnet', ID));
  assert.notEqual(rescueStateFile('/s', 'mainnet', ID), rescueStateFile('/s', 'mainnet', { ...ID, contractId: 'gimbal2.near' }));
  assert.notEqual(rescueStateFile('/s', 'mainnet', ID), rescueStateFile('/s', 'mainnet', { ...ID, evm: '0x'.padEnd(42, '2') }));
  assert.throws(() => rescueStateFile('/s', 'mainnet', { ...ID, deskId: '../x' }), /not \[a-z0-9-\]/);
  assert.throws(() => rescueStateFile('/s', 'mainnet', { ...ID, contractId: 'a/b' }), /contract id/);
  assert.throws(() => rescueStateFile('/s', 'mainnet', { ...ID, evm: '0xABC' }), /EVM address/);
});

test('a save is read back exactly with its identity, says how to clear a hold, and leaves no temporary file', () => {
  const dir = tmp();
  const store = new RescueStateStore(join(dir, 'sub', 'rescue.json'), ID);
  assert.deepEqual(store.load(), { kind: 'none' });
  store.save(snapshot());
  const second = { ...snapshot(), unknown: 'the hl_withdraw of rescue c may have gone out' };
  store.save(second);
  assert.deepEqual(store.load(), { kind: 'loaded', state: { ...second, identity: ID } });
  assert.deepEqual(readdirSync(join(dir, 'sub')), ['rescue.json']);
  const raw = JSON.parse(readFileSync(store.path, 'utf8')) as { _readme: string };
  assert.ok(raw._readme.includes(MANUAL_CLEAR) && /a missing file holds every transfer/.test(raw._readme));
});

test('a hold saved before creditBaseE6 existed loads without it; a wrong one makes the file unusable', () => {
  const dir = tmp();
  const store = new RescueStateStore(join(dir, 'rescue.json'), ID);
  store.save(snapshot());
  const loaded = store.load();
  assert.ok(loaded.kind === 'loaded');
  assert.equal(loaded.state.holds[0]!.creditBaseE6, undefined, 'an older hold: no baseline');
  assert.equal(loaded.state.holds[1]!.creditBaseE6, '400000');
  const raw = JSON.parse(readFileSync(store.path, 'utf8')) as { holds: { creditBaseE6?: unknown }[] };
  raw.holds[1]!.creditBaseE6 = -1;
  writeFileSync(store.path, JSON.stringify(raw));
  assert.equal(store.load().kind, 'unusable');
});

test('a file of another contract, desk or desk EVM address is unusable, never "no holds"', () => {
  const dir = tmp();
  const path = join(dir, 'rescue.json');
  new RescueStateStore(path, ID).save(snapshot());
  for (const other of [{ ...ID, deskId: 'beta' }, { ...ID, contractId: 'gimbal2.near' }, { ...ID, evm: '0x'.padEnd(42, '2') }]) {
    const loaded = new RescueStateStore(path, other).load();
    assert.equal(loaded.kind, 'unusable');
    assert.match(loaded.kind === 'unusable' ? loaded.problem : '', /belongs to contract gimbal\.near, desk alpha, EVM 0x1a64/);
  }
  assert.equal(new RescueStateStore(path, { ...ID, evm: ID.evm.toUpperCase().replace('0X', '0x') }).load().kind, 'loaded', 'the address in any case');
});

test('a rename Windows refuses for a moment (EBUSY, EPERM, EACCES) is tried again; one that keeps failing throws and keeps the old file', () => {
  const dir = tmp();
  const path = join(dir, 'rescue.json');
  let fails = 2;
  const busy = new RescueStateStore(path, ID, {
    rename: (a, b) => {
      if (fails-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
      renameSync(a, b);
    },
  });
  busy.save(snapshot());
  assert.equal(busy.load().kind, 'loaded', 'saved on the third try');
  const before = readFileSync(path, 'utf8');
  let tries = 0;
  const denied = new RescueStateStore(path, ID, {
    rename: () => {
      tries++;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    },
    renameTries: 3,
  });
  assert.throws(() => denied.save({ ...snapshot(), unknown: 'x' }), /EPERM/);
  assert.equal(tries, 3);
  assert.equal(readFileSync(path, 'utf8'), before, 'the last good state stays');
  assert.deepEqual(readdirSync(dir), ['rescue.json'], 'no temporary file left');
  let other = 0;
  const full = new RescueStateStore(path, ID, {
    rename: () => {
      other++;
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    },
  });
  assert.throws(() => full.save(snapshot()), /ENOSPC/);
  assert.equal(other, 1, 'not a passing refusal: not tried again');
});

test('a temporary file a crash left next to the state file is removed at load', () => {
  const dir = tmp();
  const path = join(dir, 'rescue.json');
  const store = new RescueStateStore(path, ID);
  store.save(snapshot());
  writeFileSync(`${path}.4242.tmp`, '{"half":', 'utf8');
  writeFileSync(join(dir, 'other.json.1.tmp'), 'not ours', 'utf8');
  assert.equal(store.load().kind, 'loaded');
  assert.deepEqual(readdirSync(dir).sort(), ['other.json.1.tmp', 'rescue.json']);
});

test('anything a save does not write makes the file unusable, never "no holds"', () => {
  const full = () => JSON.parse(JSON.stringify({ ...snapshot(), identity: ID })) as Record<string, unknown>;
  const hold0 = (s: Record<string, unknown>) => (s.holds as Record<string, unknown>[])[0]!;
  const bad: [string, (s: Record<string, unknown>) => void, RegExp][] = [
    ['another version (a version 1 file)', (s) => { s.version = 1; }, /state\.version/],
    ['a quote with no deadline', (s) => { delete (hold0(s).quote as Record<string, unknown>).deadlineMs; }, /quote\.deadlineMs/],
    ['no identity', (s) => { delete s.identity; }, /state\.identity/],
    ['a negative amount', (s) => { (s.hl as Record<string, unknown>).strandedE6 = '-1'; }, /strandedE6/],
    ['a hold with no quote', (s) => { delete hold0(s).quote; }, /holds\[0\]\.quote/],
    ['an unknown venue', (s) => { hold0(s).venue = 'binance'; }, /holds\[0\]\.venue/],
    ['an authorization without a nonce', (s) => { delete (hold0(s).authorization as Record<string, unknown>).nonce; }, /authorization\.nonce/],
    ['a scanned block that is not an integer', (s) => { hold0(s).scannedTo = 7; }, /holds\[0\]\.scannedTo/],
    ['a withdraw tx on an unknown chain', (s) => { (((s.hl as Record<string, unknown>).inFlight as Record<string, unknown>).tx as Record<string, unknown>[])[0]!.chain = 'btc'; }, /inFlight\.tx\[0\]\.chain/],
    ['no expired list', (s) => { delete (s.hl as Record<string, unknown>).expired; }, /hl\.expired/],
    ['a withdraw with no block', (s) => { delete ((s.hl as Record<string, unknown>).inFlight as Record<string, unknown>).fromBlock; }, /inFlight\.fromBlock/],
    ['no cap list', (s) => { delete s.cap; }, /state\.cap/],
    ['a cap entry with no time', (s) => { (s.cap as Record<string, unknown>[])[0]!.at = 'soon'; }, /cap\[0\]\.at/],
    ['a pre-sign counter that is not a count', (s) => { hold0(s).counter = '-2'; }, /holds\[0\]\.counter/],
    ['no counter field', (s) => { delete hold0(s).counter; }, /holds\[0\]\.counter/],
    ['an empty NEAR transaction', (s) => { hold0(s).nearTx = ''; }, /holds\[0\]\.nearTx/],
    ['a Solana hold with no lastValidBlockHeight', (s) => { delete ((s.holds as Record<string, unknown>[])[1]!.solana as Record<string, unknown>).lastValidBlockHeight; }, /holds\[1\]\.solana\.lastValidBlockHeight/],
    ['a Solana block height that is not an integer', (s) => { ((s.holds as Record<string, unknown>[])[1]!.solana as Record<string, unknown>).lastValidBlockHeight = 1.5; }, /solana\.lastValidBlockHeight/],
  ];
  for (const [name, spoil, why] of bad) {
    const s = full();
    spoil(s);
    assert.throws(() => parseRescueState(s), why, name);
  }
  const dir = tmp();
  const store = new RescueStateStore(join(dir, 'rescue.json'), ID);
  writeFileSync(store.path, '{"version":1,', 'utf8');
  const loaded = store.load();
  assert.equal(loaded.kind, 'unusable');
  assert.match(loaded.kind === 'unusable' ? loaded.problem : '', /is not a rescuer state this engine wrote/);
  assert.ok(existsSync(store.path), 'left as it is');
});
