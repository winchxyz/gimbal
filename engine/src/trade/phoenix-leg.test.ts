// The Phoenix leg against recorded Phoenix answers (fixtures/phoenix-leg) and the contract's vectors: the position
// from the trader snapshot (gated on the last transaction's slot), the IOC it signs (byte for byte the contract's
// vector orders, but for the production 600k unit limit; the reduce-only flag on closes), and every outcome
// classified as HlLeg's are: a landed IOC whose slot is unknown is never "failed".

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TxRef } from '@gimbal/shared';
import { ContractRefusal, MpcTimeoutError, OutcomeUnknown } from '../contract/types.ts';
import type { SolanaMessageBuilder } from '../relayer/relayer.ts';
import { PHOENIX_MAINNET, REDUCE_ONLY_FLAG, cancelAllMessage } from '../relayer/phoenix-tx.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import { parseMessage } from '../relayer/solana.ts';
import { vectors } from '../relayer/test-helpers.ts';
import type { PhoenixLegMarket, PhoenixTraderApi } from './phoenix-leg.ts';
import { PhoenixLeg, fillsOf, parseTraderSnapshot } from './phoenix-leg.ts';
import { LegCheckError } from './legs.ts';
import { toQty } from './lots.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/phoenix-leg/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const STATE = fixture('trader-state.json');
const UNREGISTERED = fixture('trader-state-uninitialized.json');
const HISTORY = fixture('trades-history.json');

const SOL = vectors('solana');
const DESK = { authority: SOL.desk.authority, traderAccount: SOL.desk.phoenix_trader, usdcAta: SOL.desk.usdc_ata, phusdAta: SOL.desk.phusd_ata };
const ETH: PhoenixLegMarket = {
  symbol: 'ETH', orderbook: '9u7aqptdRFbsnnoHtjK13E5JkeM14EW5fAKTRPidVF88', spline: 'DN7uE4FBSs9Uy6V3GNvAbTdUMufY1hBkdy3JV1UfYdg',
  baseLotE8: 100_000, tickE8: 10_000_000,      // 0.001 ETH a lot, 0.1 USD a tick (the vectors' ETH market)
};
type Vector = { name: string; message_hex: string; parsed: { recent_blockhash: string } };
const vector = (file: string, name: string): Vector => (vectors(file).cases as Vector[]).find((c) => c.name === name)!;
const BUY_VECTOR = vector('solana', 'IOC buy 0.005 ETH, limit 2474.5 (+1%)');
const REDUCE_ONLY_VECTOR = vector('solana-review', 'review 3: a reduce-only IOC sell');
const BLOCKHASH = BUY_VECTOR.parsed.recent_blockhash;
/** A vector message (built at 400k units) with the production unit limit, 600k: 02 + u32 LE. */
const at600k = (v: Vector) => v.message_hex.replace('02801a0600', '02c0270900');
const NEAR_TX: TxRef = { chain: 'near', id: 'NEARTX', url: 'https://nearblocks.io/txns/NEARTX' };
const SIG = '4FMfQFvMMnz7dffpzugbNxT5pk7wKP5pgkem5LUo21kakKZYRH9ZRnzyvw5Bw6qkDNCPrCeTXoKJ6HCbCqBFtQYo';
const SOL_TX: TxRef = { chain: 'solana', id: SIG, url: `https://solscan.io/tx/${SIG}` };

/** The recorded active trader's state with its ETH position set to `lots` at `slot`. */
function stateWith(lots: string | null, slot: number): unknown {
  const s = structuredClone(STATE) as { slot: number; snapshot: { subaccounts: { positions: Record<string, unknown>[] }[] } };
  s.slot = slot;
  const positions = s.snapshot.subaccounts[0]!.positions;
  if (lots !== null) positions.push({ ...positions[0]!, symbol: 'ETH', basePositionLots: lots });
  return s;
}

/** The recorded fill rows, one of them re-labelled as this leg's ETH fill. */
function historyWith(signature: string, delta: string, price: string, fees: string): unknown {
  const h = structuredClone(HISTORY) as { data: Record<string, unknown>[] };
  h.data[0] = { ...h.data[0]!, signature, marketSymbol: 'ETH', baseLotsDelta: delta, price, fees };
  return h;
}

interface Fake {
  states: unknown[];
  history?: unknown;
  sign?: (build: SolanaMessageBuilder) => Promise<TxRef[]>;
  slot?: number | null;
  landed?: number | null;
  current?: number;
  /** The relayer fails before it builds (and so before anything is signed). */
  beforeBuild?: () => Promise<TxRef[]>;
  pastHeight?: boolean;
  oracle?: number | null;
  best?: { BUY: number; SELL: number };
}

function leg(f: Fake) {
  const messages: Uint8Array[] = [];
  let now = 1_000_000;
  const api: PhoenixTraderApi = {
    traderState: async () => (f.states.length > 1 ? f.states.shift() : f.states[0]),
    tradesHistory: async () => f.history ?? { data: [] },
  };
  const relayer = {
    solSign: async (build: SolanaMessageBuilder) => {
      if (f.beforeBuild !== undefined) return f.beforeBuild();
      const m = await build();
      messages.push(new Uint8Array(Buffer.from(m.messageB64, 'base64')));
      if (f.sign !== undefined) return f.sign(build);
      return [NEAR_TX, SOL_TX];
    },
  };
  const waits: number[] = [];
  const l = new PhoenixLeg({
    relayer,
    chain: { latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 900 }), signatureSlot: async () => (f.slot === undefined ? 500 : f.slot),
      ...(f.current === undefined ? {} : { currentSlot: async () => f.current! }) },
    ...(f.landed === undefined ? {} : { landedSlot: () => f.landed ?? null }),
    waitPastLastValidHeight: async (h) => {
      waits.push(h);
      return f.pastHeight === false ? null : 600;
    },
    slotWaitMs: 3_000,
    api, desk: DESK, market: ETH, oraclePx: async () => (f.oracle === undefined ? 2450 : f.oracle), bandBps: 100, maxNotionalUsd: 20,
    bestPx: async (side) => (f.best ?? { BUY: 2450, SELL: 2449.9 })[side],
    clock: { now: () => now },
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { leg: l, messages, waits };
}

test('the trader snapshot: signed base lots of the symbol over every subaccount, and an unregistered trader', () => {
  const s = parseTraderSnapshot(STATE, 'AAPL');
  assert.deepEqual([s.slot, s.state, s.lots], [464772031, 'cold', -12n]);
  assert.equal(parseTraderSnapshot(STATE, 'ETH').lots, 0n, 'no row is flat');
  const u = parseTraderSnapshot(UNREGISTERED, 'ETH');
  assert.deepEqual([u.state, u.lots], ['uninitialized', 0n]);
  assert.throws(() => parseTraderSnapshot({ error: 'x' }, 'ETH'), /no slot/);
});

test('trades-history: one signature\'s fills on the symbol, size in base units, price and fees in USD', () => {
  const recorded = (HISTORY as { data: { signature: string; marketSymbol: string }[] }).data[0]!;
  assert.deepEqual(fillsOf(HISTORY, recorded.signature, recorded.marketSymbol), { size: 2.04, avgPx: 1.253, feeUsd: 0 });
  assert.equal(fillsOf(HISTORY, recorded.signature, 'ETH'), null);
  assert.equal(fillsOf({ error: 'User not found' }, recorded.signature, 'XRP'), null);
});

test('a buy IOC: the vector order at the slippage limit, the fill from the position after the slot, fee from history', async () => {
  // Before: 0 lots at slot 400; after: a snapshot still at slot 499 (older than the transaction), then +5 at 500.
  const f = leg({
    states: [stateWith(null, 400), stateWith(null, 400), stateWith(null, 499), stateWith('5', 500)], history: historyWith(SIG, '0.005', '2455.3', '0.0042966'),
    best: { BUY: 2462.2, SELL: 2462.1 }, oracle: 2460,
  });
  const out = await f.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.equal(out.kind, 'filled');
  assert.ok(out.kind === 'filled');
  assert.deepEqual([out.filled, out.avgPx, out.fee, out.ref.orderId, out.ref.tx], [toQty('0.005'), 2455.3, 0.0042966, SIG, [NEAR_TX, SOL_TX]]);
  // best ask 2462.2 + 50 bps = 2474.51 -> 24745 ticks of 0.1 (the vector's 2474.5), inside 95 % of the band around 2460.
  assert.equal(Buffer.from(f.messages[0]!).toString('hex'), at600k(BUY_VECTOR));
  const m = parseMessage(f.messages[0]!);
  assert.deepEqual([m.signers, m.keys[0], m.computeUnitLimit], [1, DESK.authority, 600_000]);
});

test('a reduce-only sell carries the 0x80 flag, its limit past the bid by the slippage and inside the band', async () => {
  const f = leg({ states: [stateWith('5', 400), stateWith('0', 500)], best: { BUY: 2437.75, SELL: 2437.65 }, oracle: 2440 });
  const out = await f.leg.order('SELL', toQty('0.005'), true, 'close');
  assert.equal(out.kind, 'filled');
  assert.equal(out.kind === 'filled' && out.fee, null, 'no history row: no fee');
  // bid 2437.65 - 50 bps = 2425.46 -> 24255 ticks (review 3's 2425.5), above the band's floor 2440 x (1 - 0.95 %).
  assert.equal(Buffer.from(f.messages[0]!).toString('hex'), at600k(REDUCE_ONLY_VECTOR));
  const data = Buffer.from(parseMessage(f.messages[0]!).instructions.at(-1)!.data);
  assert.equal(data[data.length - 2], REDUCE_ONLY_FLAG);
});

test('a bid outside the band, an order over the cap, and an unregistered trader are refused before anything is signed', async () => {
  const outside = leg({ states: [stateWith('5', 400)], best: { BUY: 2450, SELL: 2380 }, oracle: 2450 });
  const out = await outside.leg.order('SELL', toQty('0.005'), true, 'close');
  assert.equal(out.kind, 'failed');
  assert.ok(out.kind === 'failed' && out.error instanceof LegCheckError);
  assert.match((out as { error: Error }).error.message, /outside/);
  assert.equal(outside.messages.length, 0);
  const big = leg({ states: [stateWith(null, 400)] });
  await assert.rejects(big.leg.check(toQty('0.009'), false), /over the policy's 20 USD/);
  await assert.rejects(leg({ states: [UNREGISTERED] }).leg.check(toQty('0.005'), false), /not registered/);
  // A buy whose ask is far under the contract's price would have a limit under the band: refused here too.
  const cheap = leg({ states: [stateWith(null, 400)], best: { BUY: 2400, SELL: 2399.9 }, oracle: 2450 });
  const low = await cheap.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.match((low as { error: Error }).error.message, /buy limit .* is under 0\.95 % of the contract's price 2450/);
  assert.equal(cheap.messages.length, 0);
});

test('the largest order under the cap: whole lots at max(limit, oracle)', async () => {
  // 20 USD at the sell limit's max(2437.7, 2450) -> 8 lots (0.008 ETH).
  assert.equal(await leg({ states: [stateWith(null, 400)] }).leg.maxSize('SELL'), toQty('0.008'));
});

test('outcomes: a refusal and a failed transaction are failed; a landed IOC that did not move is failed; no answer waits out the blockhash', async () => {
  const refused = leg({ states: [stateWith(null, 400)], sign: async () => { throw new ContractRefusal('E_PRICE_BAND', 'limit outside the band'); } });
  const a = await refused.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.equal(a.kind, 'failed');

  const failedOnChain = leg({ states: [stateWith(null, 400)], sign: async () => { throw new NothingExecuted('solana', 'the transaction failed on chain: {}', [NEAR_TX, SOL_TX]); } });
  const b = await failedOnChain.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.deepEqual([b.kind, b.ref.tx], ['failed', [NEAR_TX, SOL_TX]]);

  const noFill = leg({ states: [stateWith(null, 400), stateWith(null, 500)] });
  const c = await noFill.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.equal(c.kind, 'failed');
  assert.match((c as { error: Error }).error.message, /did not fill/);

  const lost = new OutcomeUnknown('solana sol_sign', 'no proof either way', { solSignature: SIG }, [NEAR_TX, SOL_TX]);
  const unknown = leg({ states: [stateWith(null, 400)], sign: async () => { throw lost; } });
  const d = await unknown.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.equal(d.kind, 'unknown');
  assert.ok(d.kind === 'unknown' && d.expiresAt !== null, 'past lastValidBlockHeight: the pair may read the position now');
  assert.deepEqual([unknown.waits, d.ref.orderId], [[900], SIG]);

  const unproven = leg({ states: [stateWith(null, 400)], sign: async () => { throw lost; }, pastHeight: false });
  const e = await unproven.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.ok(e.kind === 'unknown' && e.expiresAt === null, 'not proven expired: it may still land');

  const timeout = leg({ states: [stateWith(null, 400)], sign: async () => { throw new MpcTimeoutError('sol_sign', 'no signature in 60 s'); } });
  const g = await timeout.leg.order('BUY', toQty('0.005'), false, 'open');
  // A late signature can still be posted while the blockhash lives: unknown until the chain is past it.
  assert.ok(g.kind === 'unknown' && g.error instanceof MpcTimeoutError && g.expiresAt !== null, 'a timeout is no proof: unknown, read past the blockhash');
  assert.deepEqual(timeout.waits, [900], 'the wait is on the lastValidBlockHeight of the signed message');
  const stuck = leg({ states: [stateWith(null, 400)], sign: async () => { throw new MpcTimeoutError('sol_sign', 'no signature in 60 s'); }, pastHeight: false });
  const h = await stuck.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.ok(h.kind === 'unknown' && h.expiresAt === null, 'not proven past the blockhash: unsettled');
  // A timeout before any message was built: nothing went to MPC, nothing can land.
  const early = leg({ states: [stateWith(null, 400)], beforeBuild: async () => { throw new MpcTimeoutError('sol_sign', 'no signature in 60 s'); } });
  const i = await early.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.ok(i.kind === 'failed' && i.error instanceof MpcTimeoutError, 'never built, never signed: failed');
  assert.deepEqual(early.waits, []);
});

test('a landed IOC whose slot is unknown is unknown with no expiry, never failed: a stale snapshot shows no move', async () => {
  // The snapshot never moves (it may be older than the transaction): without the slot that proves nothing.
  const f = leg({ states: [stateWith(null, 400)], slot: null });
  const out = await f.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.equal(out.kind, 'unknown');
  assert.ok(out.kind === 'unknown' && out.expiresAt === null);
  assert.match((out as { error: Error }).error.message, /slot it landed in is unknown/);
  // The submitter's confirmed slot is used first, before the RPC: the leg then waits for a snapshot at that slot.
  const g = leg({ states: [stateWith(null, 400), stateWith(null, 400), stateWith(null, 640), stateWith('5', 700)], slot: null, landed: 700 });
  const filled = await g.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.deepEqual([filled.kind, filled.kind === 'filled' && filled.filled], ['filled', toQty('0.005')]);
  // No slot from either, but the chain's confirmed slot now is a lower bound: a snapshot at or past it shows the fill.
  const c = leg({ states: [stateWith(null, 400), stateWith(null, 700), stateWith('5', 800)], slot: null, current: 800 });
  const bounded = await c.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.deepEqual([bounded.kind, bounded.kind === 'filled' && bounded.filled], ['filled', toQty('0.005')], 'the snapshot at 700 is before the bound: skipped');
  // No move under that bound proves nothing: the node behind getSlot may lag the one that confirmed the IOC.
  const still = leg({ states: [stateWith(null, 400), stateWith(null, 800)], slot: null, current: 800 });
  const none = await still.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.ok(none.kind === 'unknown' && none.expiresAt === null, 'no move under a getSlot bound: unknown, never failed');
  assert.match((none as { error: Error }).error.message, /not proven unfilled/);
});

test('after an order with no answer, the slot where its blockhash expired is the oldest snapshot trusted', async () => {
  const lost = new OutcomeUnknown('solana sol_sign', 'no proof either way', { solSignature: SIG, solLastValidBlockHeight: 900 }, [NEAR_TX, SOL_TX]);
  // The height was proven passed at slot 600: a snapshot at 550 could miss a late landing; the one at 600 shows it.
  const f = leg({ states: [stateWith(null, 400), stateWith(null, 550), stateWith('5', 600)], sign: async () => { throw lost; } });
  const out = await f.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.ok(out.kind === 'unknown' && out.expiresAt !== null);
  assert.equal(await f.leg.position(), toQty('0.005'));
});

test('cancel_all signs the vector-shaped cancel on the leg\'s market', async () => {
  const f = leg({ states: [stateWith(null, 400)] });
  assert.deepEqual(await f.leg.cancelAll('cancel'), [NEAR_TX, SOL_TX]);
  assert.equal(Buffer.from(f.messages[0]!).toString('hex'), Buffer.from(cancelAllMessage(PHOENIX_MAINNET, DESK, ETH, BLOCKHASH)).toString('hex'));
  assert.equal(f.leg.replayable, false);
});
