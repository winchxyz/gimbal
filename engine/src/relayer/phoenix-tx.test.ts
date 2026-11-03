// The deposit, IOC and cancel_all messages byte for byte against the contract's vectors (solana.json, and
// solana-review.json review 3 for reduce-only), the pinned accounts against the vectors' own, and the live
// exchange check.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DeskSolanaAccounts } from './phoenix-withdraw.ts';
import type { PhoenixMarketAccounts } from './phoenix-tx.ts';
import {
  ORDER_COMPUTE_UNITS, PHOENIX_MAINNET, REDUCE_ONLY_FLAG, cancelAllMessage, depositMessage, exchangeMismatches, iocPacket, marketMismatches, orderMessage,
  priorityFeeLamports, splineOf,
} from './phoenix-tx.ts';
import { parseMessage } from './solana.ts';

interface VectorCase {
  name: string;
  message_hex: string;
  base?: string;
  expect: { ok: boolean };
  parsed?: { recent_blockhash: string; instructions: { program: string; accounts: string[]; data_hex: string }[] };
}

const VECTORS = fileURLToPath(new URL('../../../contract/core/tests/vectors/', import.meta.url));
const load = (file: string) => JSON.parse(readFileSync(`${VECTORS}${file}`, 'utf8')) as {
  cases: VectorCase[]; desk: Record<string, string>; policy?: { phoenix_markets?: { symbol: string; orderbook: string }[] };
};
const SOL = load('solana.json');
const REVIEW = load('solana-review.json');
const byName = (cases: VectorCase[], name: string) => {
  const c = cases.find((x) => x.name === name);
  assert.ok(c !== undefined, name);
  return c;
};

const DESK: DeskSolanaAccounts = {
  authority: SOL.desk.authority!, traderAccount: SOL.desk.phoenix_trader!, usdcAta: SOL.desk.usdc_ata!, phusdAta: SOL.desk.phusd_ata!,
};
/** The vectors were built with the SDK's default budget (400k units at 100,000 µlamports). */
const VECTOR_BUDGET = { units: 400_000, microLamports: 100_000 };
const BLOCKHASH = byName(SOL.cases, 'cancel all ETH').parsed!.recent_blockhash;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const ETH: PhoenixMarketAccounts = {
  symbol: 'ETH', orderbook: '9u7aqptdRFbsnnoHtjK13E5JkeM14EW5fAKTRPidVF88', spline: 'DN7uE4FBSs9Uy6V3GNvAbTdUMufY1hBkdy3JV1UfYdg',
};
const SOL_MARKET: PhoenixMarketAccounts = {
  symbol: 'SOL', orderbook: '71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2', spline: 'EVhkquLbfm5rDRXtZu9FoyDSXX5mYq2EYU6yD8zfKEqM',
};

test('the pinned exchange accounts are the ones the vectors name', () => {
  const deposit = byName(SOL.cases, 'deposit 15 USDC (ATA, Ember wrap, Phoenix deposit)').parsed!.instructions;
  const order = byName(SOL.cases, 'IOC buy 0.005 ETH, limit 2474.5 (+1%)').parsed!.instructions.at(-1)!.accounts;
  const [ember, phoenix] = [deposit[3]!.accounts, deposit[4]!.accounts];
  assert.deepEqual(
    [order[0], order[1], order[2], order[5], [order[6]], [order[7]]],
    [PHOENIX_MAINNET.phoenixProgram, PHOENIX_MAINNET.logAuthority, PHOENIX_MAINNET.globalConfiguration, PHOENIX_MAINNET.perpAssetMap,
      PHOENIX_MAINNET.globalTraderIndex, PHOENIX_MAINNET.activeTraderBuffer],
  );
  assert.deepEqual([ember[1], ember[2], ember[3], ember[6]], [PHOENIX_MAINNET.emberState, PHOENIX_MAINNET.usdcMint, PHOENIX_MAINNET.canonicalMint, PHOENIX_MAINNET.emberVault]);
  assert.equal(phoenix[6], PHOENIX_MAINNET.globalVault);
});

test('the spline PDA of each vector book is the one its orders name', async () => {
  assert.equal(await splineOf(ETH.orderbook), ETH.spline);
  assert.equal(await splineOf(SOL_MARKET.orderbook), SOL_MARKET.spline);
});

test('the deposit is the vector deposit: ATA, Ember wrap, Phoenix deposit_funds of 15 USDC', () => {
  const c = byName(SOL.cases, 'deposit 15 USDC (ATA, Ember wrap, Phoenix deposit)');
  assert.equal(c.expect.ok, true);
  assert.equal(hex(depositMessage(PHOENIX_MAINNET, DESK, 15_000_000n, BLOCKHASH, VECTOR_BUDGET)), c.message_hex);
});

test('IOC orders are the vector orders: ETH buy and sell 5 lots, SOL buy 10 lots', () => {
  const cases: [string, PhoenixMarketAccounts, 'BUY' | 'SELL', bigint, bigint][] = [
    ['IOC buy 0.005 ETH, limit 2474.5 (+1%)', ETH, 'BUY', 24_745n, 5n],
    ['IOC sell 0.005 ETH, limit 2425.5 (-1%)', ETH, 'SELL', 24_255n, 5n],
    ['IOC buy 0.1 SOL, limit 104.84', SOL_MARKET, 'BUY', 10_484n, 10n],
  ];
  for (const [name, market, side, ticks, lots] of cases) {
    const c = byName(SOL.cases, name);
    assert.equal(c.expect.ok, true, name);
    const built = orderMessage(PHOENIX_MAINNET, DESK, market, { side, priceInTicks: ticks, numBaseLots: lots, reduceOnly: false }, BLOCKHASH, VECTOR_BUDGET);
    assert.equal(hex(built), c.message_hex, name);
  }
});

test('a reduce-only IOC is review 3: the vector sell with the 0x80 flag', () => {
  const c = byName(REVIEW.cases, 'review 3: a reduce-only IOC sell');
  assert.equal(c.expect.ok, true);
  const built = orderMessage(PHOENIX_MAINNET, DESK, ETH, { side: 'SELL', priceInTicks: 24_255n, numBaseLots: 5n, reduceOnly: true }, BLOCKHASH, VECTOR_BUDGET);
  assert.equal(hex(built), c.message_hex);
  assert.equal((iocPacket({ side: 'SELL', priceInTicks: 1n, numBaseLots: 1n, reduceOnly: true }) as unknown as { orderFlags: number }).orderFlags, REDUCE_ONLY_FLAG);
});

test('cancel_all is the vector cancel on ETH', () => {
  const c = byName(SOL.cases, 'cancel all ETH');
  assert.equal(hex(cancelAllMessage(PHOENIX_MAINNET, DESK, ETH, BLOCKHASH, VECTOR_BUDGET)), c.message_hex);
});

test('an order message takes the contract\'s 600k unit cap at a fee the contract allows', () => {
  const m = parseMessage(orderMessage(PHOENIX_MAINNET, DESK, ETH, { side: 'BUY', priceInTicks: 24_745n, numBaseLots: 5n, reduceOnly: false }, BLOCKHASH));
  assert.deepEqual([m.version, m.signers, m.keys[0], m.computeUnitLimit, m.computeUnitPrice], ['legacy', 1, DESK.authority, ORDER_COMPUTE_UNITS, 100_000n]);
  assert.equal(priorityFeeLamports({ units: ORDER_COMPUTE_UNITS, microLamports: 100_000 }), 60_000);
  assert.ok(priorityFeeLamports({ units: ORDER_COMPUTE_UNITS, microLamports: 100_000 }) <= 600_000);
});

test('with the production budget (600k units) every order is the vector order but for its unit limit', () => {
  // SetComputeUnitLimit is 02 + u32 LE: 400,000 = 80 1a 06 00, 600,000 = c0 27 09 00. Nothing else may differ.
  const at600k = (vectorHex: string) => {
    assert.equal(vectorHex.split('02801a0600').length, 2, 'one unit limit of 400k in the vector');
    return vectorHex.replace('02801a0600', '02c0270900');
  };
  const cases: [VectorCase, PhoenixMarketAccounts, 'BUY' | 'SELL', bigint, bigint, boolean][] = [
    [byName(SOL.cases, 'IOC buy 0.005 ETH, limit 2474.5 (+1%)'), ETH, 'BUY', 24_745n, 5n, false],
    [byName(SOL.cases, 'IOC sell 0.005 ETH, limit 2425.5 (-1%)'), ETH, 'SELL', 24_255n, 5n, false],
    [byName(SOL.cases, 'IOC buy 0.1 SOL, limit 104.84'), SOL_MARKET, 'BUY', 10_484n, 10n, false],
    [byName(REVIEW.cases, 'review 3: a reduce-only IOC sell'), ETH, 'SELL', 24_255n, 5n, true],
  ];
  for (const [c, market, side, ticks, lots, reduceOnly] of cases) {
    assert.equal(hex(orderMessage(PHOENIX_MAINNET, DESK, market, { side, priceInTicks: ticks, numBaseLots: lots, reduceOnly }, BLOCKHASH)), at600k(c.message_hex), c.name);
  }
  assert.equal(hex(cancelAllMessage(PHOENIX_MAINNET, DESK, ETH, BLOCKHASH)), at600k(byName(SOL.cases, 'cancel all ETH').message_hex));
});

test('the policy market against the live exchange market: orderbook, lot and tick', () => {
  const live = { symbol: 'ETH', marketPubkey: ETH.orderbook, splinePubkey: ETH.spline, tickSize: 100, baseLotsDecimals: 3, marketStatus: 'active' };
  const policy = { symbol: 'ETH', orderbook: ETH.orderbook, base_lot_e8: 100_000, tick_e8: 10_000_000 };
  assert.deepEqual(marketMismatches(live, policy, ETH.spline), []);
  const moved = marketMismatches({ ...live, tickSize: 1000, baseLotsDecimals: 4 }, policy);
  assert.deepEqual(moved.map((m) => m.replace(/:.*?(base_lot_e8|tick_e8)/, ': $1')), [
    'phoenix ETH: base_lot_e8 is 100000, the exchange\'s lot 10000', 'phoenix ETH: tick_e8 is 10000000, the exchange\'s tick 1000000000',
  ]);
  assert.match(marketMismatches(undefined, policy).join(), /no such market/);
  // A market that is not active refuses an open; a close (reduce-only) ignores the status, never the lot or tick.
  const paused = { ...live, marketStatus: 'maintenance' };
  assert.match(marketMismatches(paused, policy, ETH.spline).join(), /the market is maintenance/);
  assert.deepEqual(marketMismatches(paused, policy, ETH.spline, { ignoreStatus: true }), []);
  assert.equal(marketMismatches({ ...paused, tickSize: 1000 }, policy, ETH.spline, { ignoreStatus: true }).length, 1);
});

test('the policy lot and tick of SOL, DOGE and BTC match the live exchange by the same formula', () => {
  // From the live snapshot (/v1/exchange/snapshot): baseLotsDecimals and tickSize of each market.
  const cases = [
    { symbol: 'SOL', orderbook: '71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2', tickSize: 100, baseLotsDecimals: 2, base_lot_e8: 1_000_000, tick_e8: 1_000_000 },
    { symbol: 'DOGE', orderbook: 'Hqt5Vom5L3X3RcKysKnBmLAvjYgo6TGAwoheW658h5cz', tickSize: 1, baseLotsDecimals: 0, base_lot_e8: 100_000_000, tick_e8: 100 },
    { symbol: 'BTC', orderbook: 'AXFz1MuzMUBHi5UKJuK3FDCQ73o3rSzubGU2mPr4LLU7', tickSize: 100, baseLotsDecimals: 4, base_lot_e8: 10_000, tick_e8: 100_000_000 },
  ];
  for (const c of cases) {
    const live = { symbol: c.symbol, marketPubkey: c.orderbook, tickSize: c.tickSize, baseLotsDecimals: c.baseLotsDecimals, marketStatus: 'active' };
    const policy = { symbol: c.symbol, orderbook: c.orderbook, base_lot_e8: c.base_lot_e8, tick_e8: c.tick_e8 };
    assert.deepEqual(marketMismatches(live, policy), [], c.symbol);
    assert.match(marketMismatches(live, { ...policy, tick_e8: c.tick_e8 * 10 }).join(), /tick_e8/, `${c.symbol}: a tick off by 10x`);
    assert.match(marketMismatches(live, { ...policy, base_lot_e8: c.base_lot_e8 / 10 }).join(), /base_lot_e8/, `${c.symbol}: a lot off by 10x`);
  }
});

test('an IOC with no lots or no price is refused before anything is built', () => {
  assert.throws(() => iocPacket({ side: 'BUY', priceInTicks: 0n, numBaseLots: 5n, reduceOnly: false }), /priceInTicks/);
  assert.throws(() => iocPacket({ side: 'BUY', priceInTicks: 5n, numBaseLots: 0n, reduceOnly: false }), /numBaseLots/);
  assert.throws(() => depositMessage(PHOENIX_MAINNET, DESK, 0n, BLOCKHASH), /amount/);
});

test('the live exchange check passes the recorded snapshot and names every account that moved', () => {
  const live = {
    programId: PHOENIX_MAINNET.phoenixProgram, globalConfig: PHOENIX_MAINNET.globalConfiguration, canonicalMint: PHOENIX_MAINNET.canonicalMint,
    usdcMint: PHOENIX_MAINNET.usdcMint, globalVault: PHOENIX_MAINNET.globalVault, perpAssetMap: PHOENIX_MAINNET.perpAssetMap,
    globalTraderIndex: [...PHOENIX_MAINNET.globalTraderIndex], activeTraderBuffer: [...PHOENIX_MAINNET.activeTraderBuffer],
    withdrawQueue: PHOENIX_MAINNET.withdrawQueue, active: true, withdrawalsAvailable: true,
  };
  assert.deepEqual(exchangeMismatches(live), []);
  const moved = exchangeMismatches({ ...live, globalTraderIndex: [...live.globalTraderIndex, 'x'], active: false });
  assert.equal(moved.length, 2);
  assert.match(moved[0]!, /globalTraderIndex/);
  assert.match(moved[1]!, /not active/);
});
