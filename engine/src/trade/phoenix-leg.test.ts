// The Phoenix leg against recorded Phoenix answers (fixtures/phoenix-leg) and the contract's vectors: the position
// from the trader snapshot (gated on the last transaction's slot), the IOC it signs (the vector desk and ETH market,
// byte for byte what orderMessage builds, reduce-only flag on closes), and every outcome classified as HlLeg's are.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TxRef } from '@gimbal/shared';
import { ContractRefusal, OutcomeUnknown } from '../contract/types.ts';
import type { SolanaMessageBuilder } from '../relayer/relayer.ts';
import { PHOENIX_MAINNET, REDUCE_ONLY_FLAG, cancelAllMessage, orderMessage } from '../relayer/phoenix-tx.ts';
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
const BLOCKHASH = 'DmnJBJP8mVBgNwKATxATdJe19x6ridh4pjzzs6SCxRh7';
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
      const m = await build();
      messages.push(new Uint8Array(Buffer.from(m.messageB64, 'base64')));
      if (f.sign !== undefined) return f.sign(build);
      return [NEAR_TX, SOL_TX];
    },
  };
  const waits: number[] = [];
  const l = new PhoenixLeg({
    relayer,
    chain: { latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 900 }), signatureSlot: async () => (f.slot === undefined ? 500 : f.slot) },
    waitPastLastValidHeight: async (h) => {
      waits.push(h);
      return f.pastHeight ?? true;
    },
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

test('a buy IOC: the vector-shaped message at the band-held limit, the fill from the position after the slot, fee from history', async () => {
  // Before: 0 lots at slot 400; after: a snapshot still at slot 499 (older than the transaction), then +5 at 500.
  const f = leg({ states: [stateWith(null, 400), stateWith(null, 400), stateWith(null, 499), stateWith('5', 500)], history: historyWith(SIG, '0.005', '2455.3', '0.0042966') });
  const out = await f.leg.order('BUY', toQty('0.005'), false, 'open');
  assert.equal(out.kind, 'filled');
  assert.ok(out.kind === 'filled');
  assert.deepEqual([out.filled, out.avgPx, out.fee, out.ref.orderId, out.ref.tx], [toQty('0.005'), 2455.3, 0.0042966, SIG, [NEAR_TX, SOL_TX]]);
  // best ask 2450 + 50 bps = 2462.25 -> 24622 ticks of 0.1, inside 95 % of the 100 bps band (24732).
  const want = orderMessage(PHOENIX_MAINNET, DESK, ETH, { side: 'BUY', priceInTicks: 24_622n, numBaseLots: 5n, reduceOnly: false }, BLOCKHASH);
  assert.equal(Buffer.from(f.messages[0]!).toString('hex'), Buffer.from(want).toString('hex'));
  const m = parseMessage(f.messages[0]!);
  assert.deepEqual([m.signers, m.keys[0], m.computeUnitLimit], [1, DESK.authority, 600_000]);
});

test('a reduce-only sell carries the 0x80 flag, its limit past the bid by the slippage and inside the band', async () => {
  const f = leg({ states: [stateWith('5', 400), stateWith('0', 500)], best: { BUY: 2450, SELL: 2440 }, oracle: 2450 });
  const out = await f.leg.order('SELL', toQty('0.005'), true, 'close');
  assert.equal(out.kind, 'filled');
  assert.equal(out.kind === 'filled' && out.fee, null, 'no history row: no fee');
  // bid 2440 - 50 bps = 2427.8 -> 24278 ticks, above the band's floor 2450 x (1 - 0.95 %) = 24268 ticks: kept.
  const want = orderMessage(PHOENIX_MAINNET, DESK, ETH, { side: 'SELL', priceInTicks: 24_278n, numBaseLots: 5n, reduceOnly: true }, BLOCKHASH);
  assert.equal(Buffer.from(f.messages[0]!).toString('hex'), Buffer.from(want).toString('hex'));
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
});

test('cancel_all signs the vector-shaped cancel on the leg\'s market', async () => {
  const f = leg({ states: [stateWith(null, 400)] });
  assert.deepEqual(await f.leg.cancelAll('cancel'), [NEAR_TX, SOL_TX]);
  assert.equal(Buffer.from(f.messages[0]!).toString('hex'), Buffer.from(cancelAllMessage(PHOENIX_MAINNET, DESK, ETH, BLOCKHASH)).toString('hex'));
  assert.equal(f.leg.replayable, false);
});
