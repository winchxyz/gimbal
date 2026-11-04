// The trader state's legs (trade/pair-shape.ts): a version 1 file (no legs) is read as short Hyperliquid / long
// Phoenix and saved back as version 1 with its legs; any other pair is saved as version 2, which an engine from before
// Orderly pairs refuses; a file whose legs or orders do not add up is unusable. startPlan never restores a saved pair
// onto other legs.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { newAdlState } from '../risk/adl.ts';
import { toQty } from './lots.ts';
import { defaultShape, pairShape, shapeRefusal } from './pair-shape.ts';
import { startPlan } from './protected-pair.ts';
import type { LoadedTraderState, TraderFileState } from './trader-state.ts';
import { TRADER_STATE_V1, TRADER_STATE_VERSION, TraderStateStore, parseTraderState, traderStateFile } from './trader-state.ts';

const ID = { contractId: 'gimbal-test.near', deskId: 'canary', evm: `0x${'ab'.repeat(20)}` };

/** A file as serve wrote it before Orderly pairs (version 1, no legs): a pair with an order in flight and one with no answer. */
const OLD_FILE = {
  _readme: 'Gimbal pair trader state (serve): orders that may still run, the ADL unwind budget and pause.',
  version: 1,
  savedAt: 1762300000000,
  symbol: 'XLM',
  trader: {
    intents: ['-5000000000', '5000000000'], baselines: ['-5000000000', '5000000000'], known: ['-5000000000', '5000000000'], net: '0', unhedged: null,
    unsettled: [{
      index: 1, until: 1762300120000, from: '5000000000', unwind: null,
      refs: [{ venue: 'phoenix', side: 'SELL', size: '10', reduceOnly: true, orderId: '5xSig', clientId: null, tx: [{ chain: 'solana', id: '5xSig', url: 'https://solscan.io/tx/5xSig' }], sentAt: 1762300000000 }],
    }],
  },
  pendingMaker: [{ cloid: `0x${'12'.repeat(16)}`, oid: 42, side: 'BUY', size: '10' }],
  inFlight: [{ index: 0, venue: 'hyperliquid', side: 'BUY', size: '10', reduceOnly: true, reason: 'rescue reduce', at: 1762300000000, op: 'close' }],
  adl: { attemptsLeft: 2, paused: null, event: null },
  identity: ID,
};

const tempDir = () => mkdtempSync(join(tmpdir(), 'gimbal-trader-legs-'));

test('a version 1 file without legs is short hyperliquid XLM / long phoenix XLM, and is saved back as version 1 with its legs', () => {
  const dir = tempDir();
  try {
    const path = traderStateFile(dir, 'mainnet', ID);
    writeFileSync(path, `${JSON.stringify(OLD_FILE, null, 2)}\n`);
    const store = new TraderStateStore(path, ID);
    const got = store.load();
    assert.equal(got.kind, 'loaded', got.kind === 'unusable' ? got.problem : '');
    if (got.kind !== 'loaded') return;
    assert.deepEqual(got.state.pair, { legs: [{ venue: 'hyperliquid', symbol: 'XLM' }, { venue: 'phoenix', symbol: 'XLM' }], longIndex: 1 });
    assert.deepEqual(got.state.trader?.baselines, [toQty('-50'), toQty('50')]);
    assert.equal(got.state.inFlight.length, 1);
    assert.equal(got.state.pendingMaker.length, 1);
    store.save(got.state);
    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(written.version, TRADER_STATE_V1, 'short hyperliquid / long phoenix stays version 1: an older engine still reads it');
    assert.deepEqual(written.pair, { legs: [{ venue: 'hyperliquid', symbol: 'XLM' }, { venue: 'phoenix', symbol: 'XLM' }], longIndex: 1 });
    const again = store.load();
    assert.ok(again.kind === 'loaded');
    assert.deepEqual({ ...again.state, savedAt: 0 }, { ...got.state, savedAt: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an Orderly pair is saved as version 2 with its legs and loads back as saved', () => {
  const dir = tempDir();
  try {
    const store = new TraderStateStore(traderStateFile(dir, 'mainnet', ID), ID);
    const pair = pairShape('SOL', 'orderly', 'hyperliquid');
    assert.deepEqual(pair, { legs: [{ venue: 'hyperliquid', symbol: 'SOL' }, { venue: 'orderly', symbol: 'PERP_SOL_USDC' }], longIndex: 1 });
    const state: TraderFileState = {
      version: TRADER_STATE_VERSION, savedAt: 1, symbol: 'SOL', pair,
      trader: { intents: [toQty('-1'), toQty('1')], baselines: [toQty('-1'), toQty('1')], known: [toQty('-1'), toQty('1')], net: 0n, unhedged: null, unsettled: [] },
      pendingMaker: [], inFlight: [{ index: 1, venue: 'orderly', side: 'SELL', size: '1', reduceOnly: true, reason: 'panic_close', at: 1, op: 'close' }], adl: newAdlState(),
    };
    store.save(state);
    assert.equal((JSON.parse(readFileSync(store.path, 'utf8')) as { version: number }).version, TRADER_STATE_VERSION);
    const back = store.load();
    assert.ok(back.kind === 'loaded');
    assert.deepEqual(back.state.pair, pair);
    assert.deepEqual(back.state.inFlight, state.inFlight);
    assert.equal('replay' in (JSON.parse(readFileSync(store.path, 'utf8')) as { trader: object }).trader, false, 'no replay watch: no key');
    // An Orderly leg's replay watch running: saved, and loaded back as saved.
    store.save({ ...state, trader: { ...state.trader!, replay: [{ index: 1, until: 310_001 }] } });
    assert.deepEqual((JSON.parse(readFileSync(store.path, 'utf8')) as { trader: { replay: unknown } }).trader.replay, [{ index: 1, until: 310_001 }]);
    const watched = store.load();
    assert.ok(watched.kind === 'loaded');
    assert.deepEqual(watched.state.trader?.replay, [{ index: 1, until: 310_001 }]);
    // Orderly and Phoenix: Orderly is index 0, Phoenix stays last.
    assert.deepEqual(pairShape('SOL', 'phoenix', 'orderly'), { legs: [{ venue: 'orderly', symbol: 'PERP_SOL_USDC' }, { venue: 'phoenix', symbol: 'SOL' }], longIndex: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legs that do not add up make the file unusable, naming the field', () => {
  const orderly = { legs: [{ venue: 'hyperliquid', symbol: 'XLM' }, { venue: 'orderly', symbol: 'PERP_XLM_USDC' }], longIndex: 1 };
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['a version 1 file naming another pair', { ...OLD_FILE, pair: orderly, inFlight: [], pendingMaker: [], trader: null }, /state\.pair: a version 1 file is short hyperliquid \/ long phoenix/],
    ['a version 2 file without legs', { ...OLD_FILE, version: 2 }, /state\.pair: missing/],
    ['a leg that is not the symbol\'s market', { ...OLD_FILE, version: 2, pair: { ...orderly, legs: [orderly.legs[0], { venue: 'orderly', symbol: 'PERP_SOL_USDC' }] } }, /state\.pair\.legs\[1\]\.symbol/],
    ['legs out of the trader\'s order', { ...OLD_FILE, version: 2, pair: { legs: [orderly.legs[1], orderly.legs[0]], longIndex: 0 } }, /not two venues in the trader's order/],
    ['an order in flight on a venue that is not its leg\'s', { ...OLD_FILE, version: 2, pair: orderly }, /state\.trader\.unsettled\[0\]\.refs\[0\]\.venue: phoenix, but leg 1 is orderly/],
    ['post-only orders with no Hyperliquid leg', {
      ...OLD_FILE, version: 2, pair: { legs: [{ venue: 'orderly', symbol: 'PERP_XLM_USDC' }, { venue: 'phoenix', symbol: 'XLM' }], longIndex: 1 }, inFlight: [], trader: null,
    }, /state\.pendingMaker: Hyperliquid post-only orders, but no leg is on Hyperliquid/],
    ['an unknown version', { ...OLD_FILE, version: 3 }, /state\.version/],
    ['a replay watch on a leg that cannot be replayed', {
      ...OLD_FILE, version: 2, pair: orderly, inFlight: [], trader: { ...OLD_FILE.trader, unsettled: [], replay: [{ index: 0, until: 1 }] },
    }, /state\.trader\.replay\[0\]\.index: leg 0 is hyperliquid, which cannot be replayed/],
  ];
  for (const [what, file, why] of cases) assert.throws(() => parseTraderState(file), why, what);
});

test('the policy and the flag decide which pairs may be built', () => {
  const policy = { hl_assets: [{ symbol: 'SOL', index: 5, sz_decimals: 2 }], phoenix_markets: [{ symbol: 'SOL', orderbook: 'x', base_lot_e8: 1, tick_e8: 1 }], orderly_symbols: ['PERP_SOL_USDC'] };
  assert.equal(shapeRefusal(policy, 'SOL', defaultShape('SOL'), false), null);
  assert.match(shapeRefusal(policy, 'SOL', pairShape('SOL', 'orderly', 'hyperliquid'), false) ?? '', /only short hyperliquid \/ long phoenix trades while GIMBAL_ORDERLY_PAIRS is not 1/);
  assert.equal(shapeRefusal(policy, 'SOL', pairShape('SOL', 'orderly', 'hyperliquid'), true), null);
  assert.match(shapeRefusal({ ...policy, orderly_symbols: [] }, 'SOL', pairShape('SOL', 'phoenix', 'orderly'), true) ?? '', /the policy does not list orderly PERP_SOL_USDC/);
});

test('startPlan never restores a saved pair onto other legs of the same symbol', () => {
  const orderly = pairShape('XLM', 'orderly', 'hyperliquid');
  const read: [bigint, bigint] = [toQty('-50'), 0n];
  const trader = { intents: [toQty('-50'), toQty('50')] as [bigint, bigint], baselines: [toQty('-50'), toQty('50')] as [bigint, bigint], known: [toQty('-50'), toQty('50')] as [bigint, bigint], net: 0n, unhedged: null, unsettled: [] };
  const saved = (t: typeof trader | null): LoadedTraderState => ({
    kind: 'loaded', state: { version: TRADER_STATE_VERSION, savedAt: 1, symbol: 'XLM', pair: orderly, trader: t, pendingMaker: [], inFlight: [], adl: newAdlState(), identity: ID },
  });
  const open = startPlan({ symbol: 'XLM', read, saved: saved(trader), fresh: undefined, freshWant: 'f', path: 'trader.json', now: 1 });
  assert.equal(open.stateOk, false);
  assert.equal(open.restore, null);
  assert.match(open.why ?? '', /trader\.json is for XLM \(short hyperliquid XLM, long orderly PERP_XLM_USDC\) with legs or orders open, but the venues are read for XLM \(short hyperliquid XLM, long phoenix XLM\)/);
  const flat = { ...trader, intents: [0n, 0n] as [bigint, bigint], baselines: [0n, 0n] as [bigint, bigint], known: [0n, 0n] as [bigint, bigint] };
  const idle = startPlan({ symbol: 'XLM', read: [0n, 0n], saved: saved(flat), fresh: undefined, freshWant: 'f', path: 'trader.json', now: 1 });
  assert.equal(idle.stateOk, true, 'a flat saved pair on other legs is replaced');
  assert.deepEqual(idle.adopt, [0n, 0n]);
  // The same legs: restored, the lines naming them.
  const same = startPlan({ symbol: 'XLM', pair: orderly, read: [toQty('-50'), toQty('50')], saved: saved(trader), fresh: undefined, freshWant: 'f', path: 'trader.json', now: 1 });
  assert.equal(same.stateOk, true);
  assert.deepEqual(same.restore?.baselines, trader.baselines);
  assert.match(same.notes.join('\n'), /restored from trader\.json: hyperliquid -50, orderly 50 XLM, as saved/);
});
