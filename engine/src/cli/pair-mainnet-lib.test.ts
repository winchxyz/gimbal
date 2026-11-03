// pair-mainnet's decisions without a network: the order options a bare command line gets (the taker fallback is off),
// a maker timeout that must fit the life of a fresh stored price, when the stored price is refreshed (once for
// concurrent callers, per symbol, never within 30 s of the last that landed, never while planning) and checked after,
// whether a failed refresh_prices still went on chain (against the near-client's own errors), resting Hyperliquid
// orders an open refuses beside, what a Phoenix withdrawal must leave, both venues' cross margin, and what finish()
// does after a late maker fill (the plan and the reads and sends around it).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TxRef } from '@gimbal/shared';
import type { NearCallOutcome, NearTransport } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { OutcomeUnknown } from '../contract/types.ts';
import type { LegOutcome, LegSide } from '../trade/legs.ts';
import { toQty } from '../trade/lots.ts';
import type { PhoenixCrossView, PriceDeps, ResidualDeps, ResidualInput, StoredPrice } from './pair-mainnet-lib.ts';
import {
  DEFAULT_MAKER_TIMEOUT_S, PRICE_MARGIN_S, UsageError, ensureFresh, hlCross, newPriceState, oraclePxOf, orderOptions, parseArgs, phoenixCross,
  priceFitRefusal, priceLifeS, refreshLanded, residualHedge, residualPlan, restingOrdersRefusal, settleResidual, withdrawKeepsLegs,
} from './pair-mainnet-lib.ts';

const OPEN = ['open', 'ETH', '15', '--short', 'hyperliquid', '--long', 'phoenix'];

test('the order options of a bare open: maker only (no taker fallback), 30 s reprice, 6 orders, a timeout that fits the price', () => {
  const o = orderOptions(parseArgs(OPEN));
  assert.equal(o.maker.takerFallback, false, 'a taker fill is an explicit opt-in');
  assert.deepEqual([o.maker.repriceMs, o.maker.timeoutMs, o.maker.maxOrders, o.microLamports, o.slippageBps], [30_000, 120_000, 6, 100_000, 50]);
  assert.equal(priceFitRefusal(o.maker.timeoutMs / 1000, 900), null, 'the default timeout fits the mainnet policy');
  assert.equal(orderOptions(parseArgs([...OPEN, '--taker-fallback'])).maker.takerFallback, true);
  assert.equal(orderOptions(parseArgs(['close', 'ETH'])).maker.takerFallback, false);
  assert.throws(() => orderOptions(parseArgs([...OPEN, '--reprice-s', '10'])), UsageError);
  assert.throws(() => orderOptions(parseArgs([...OPEN, '--max-orders', '7'])), UsageError);
  assert.throws(() => orderOptions(parseArgs([...OPEN, '--priority-microlamports', '300000'])), UsageError);
  assert.throws(() => parseArgs([...OPEN, '--nope']), /unknown option/);
});

test('a fresh stored price lives oracle_max_age_s less the 600 s recency: the maker timeout plus the margin must fit it', () => {
  assert.equal(priceLifeS(900), 300);
  assert.equal(priceFitRefusal(DEFAULT_MAKER_TIMEOUT_S, 900), null);
  assert.equal(priceFitRefusal(300 - PRICE_MARGIN_S, 900), null, 'exactly the life');
  assert.match(priceFitRefusal(181, 900)!, /does not fit.*is 300 s; use --maker-timeout-s 180 or less/);
  assert.notEqual(priceFitRefusal(180, 1000 - 101), null, 'the old 180 s default does not fit a 899 s policy');
  assert.match(priceFitRefusal(10, 700)!, /no time for a maker order/);
});

/** A stored-price fake: `ages` is what each read answers in turn (the last one repeats); a refresh takes `afterS`. */
function prices(o: { ages: Record<string, (number | null)[]>; afterRefresh?: Record<string, number>; send?: boolean }) {
  let now = 1_000_000;
  const refreshes: string[] = [];
  const logs: string[] = [];
  const ages = Object.fromEntries(Object.entries(o.ages).map(([k, v]) => [k, [...v]]));
  const d: PriceDeps = {
    maxAgeS: 900, send: o.send ?? true,
    read: async (symbol): Promise<StoredPrice | null> => {
      const list = ages[symbol]!;
      const age = list.length > 1 ? list.shift()! : list[0]!;
      return age === null ? null : { px: 2500, ageS: age };
    },
    refresh: async (symbol, maxAgeS): Promise<TxRef[]> => {
      refreshes.push(`${symbol} ${maxAgeS}`);
      await new Promise((r) => setTimeout(r, 5));
      ages[symbol] = [o.afterRefresh?.[symbol] ?? 610];
      return [{ chain: 'near', id: 'T', url: 'https://nearblocks.io/txns/T' }];
    },
    now: () => now, log: (l) => logs.push(l), ...newPriceState(),
  };
  return { d, refreshes, logs, tick: (ms: number) => { now += ms; } };
}

test('ensureFresh: a price that lives the margin is used as it is; a stale one is refreshed once and checked after', async () => {
  const fresh = prices({ ages: { ETH: [650] } });
  assert.equal((await ensureFresh(fresh.d, 'ETH', 240)).ageS, 650);
  assert.deepEqual(fresh.refreshes, []);

  const stale = prices({ ages: { ETH: [700] } });
  // Two callers at once share one refresh_prices.
  const [a, b] = await Promise.all([ensureFresh(stale.d, 'ETH', 240), ensureFresh(stale.d, 'ETH', 240)]);
  assert.deepEqual([a.ageS, b.ageS, stale.refreshes], [610, 610, ['ETH 660']]);

  const dry = prices({ ages: { ETH: [700] }, send: false });
  await assert.rejects(ensureFresh(dry.d, 'ETH', 240), /700 s old/);
  assert.deepEqual(dry.refreshes, [], 'a dry run never refreshes');

  // The oracle lags: the refreshed price is 700 s old, which does not live the 240 s asked.
  const lag = prices({ ages: { ETH: [800] }, afterRefresh: { ETH: 700 } });
  await assert.rejects(ensureFresh(lag.d, 'ETH', 240), /after refresh_prices the stored ETH price is 700 s old: it does not live the 240 s/);
});

test('ensureFresh: one refresh in flight per symbol, and none within 30 s of the last', async () => {
  const p = prices({ ages: { ETH: [700], SOL: [700] } });
  await Promise.all([ensureFresh(p.d, 'ETH', 240), ensureFresh(p.d, 'SOL', 240)]);
  assert.deepEqual(p.refreshes.sort(), ['ETH 660', 'SOL 660'], 'ETH does not wait on (or skip) the SOL refresh');
  // 10 s later the ETH price reads stale again (a slow oracle): not sent again, and the read decides.
  p.tick(10_000);
  p.d.read = async () => ({ px: 2500, ageS: 880 });
  await assert.rejects(ensureFresh(p.d, 'ETH', 240), /880 s old/);
  assert.equal(p.refreshes.length, 2);
  assert.ok(p.logs.some((l) => /last refresh_prices was 10 s ago: not sent again/.test(l)));
  // Past 30 s it may go again.
  p.tick(25_000);
  p.d.read = async () => ({ px: 2500, ageS: 700 });
  await assert.rejects(ensureFresh(p.d, 'ETH', 240));
  assert.equal(p.refreshes.length, 3);
});

test('ensureFresh: a refresh that failed before the chain does not block the next; one that landed does', async () => {
  const p = prices({ ages: { ETH: [700] } });
  const ok = p.d.refresh;
  p.d.refresh = async () => { throw new Error('NEAR RPC: HTTP 503'); };
  await assert.rejects(ensureFresh(p.d, 'ETH', 240), /HTTP 503/);
  assert.equal(p.d.lastRefreshAt.has('ETH'), false, 'a failed refresh starts no gap');
  p.tick(1_000);
  p.d.refresh = ok;
  assert.equal((await ensureFresh(p.d, 'ETH', 240)).ageS, 610, 'retried at once, and it went through');
  assert.deepEqual(p.refreshes, ['ETH 660']);
  // One that ran but the poll threw: it landed, so the next one within 30 s is not sent.
  const landed = prices({ ages: { ETH: [700] } });
  landed.d.landed = refreshLanded;
  landed.d.refresh = async () => { throw new Error('refresh_prices ran in T: prices() has no newer price'); };
  await assert.rejects(ensureFresh(landed.d, 'ETH', 240), /ran in/);
  assert.equal(landed.d.lastRefreshAt.has('ETH'), true);
  landed.d.refresh = async () => { throw new Error('must not be sent'); };
  await assert.rejects(ensureFresh(landed.d, 'ETH', 240), /700 s old/);
  assert.ok(landed.logs.some((l) => /not sent again/.test(l)));
});

/** A chain for the real NearContractClient.refreshPrices: one call outcome (or a throw), then prices() reads in turn. */
function refreshChain(call: NearCallOutcome | Error, reads: (unknown | Error)[]): NearContractClient {
  const transport: NearTransport = {
    accountId: 'owner.near',
    call: async () => {
      if (call instanceof Error) throw call;
      return call;
    },
    view: async <T>(): Promise<T> => {
      const r = reads.length > 1 ? reads.shift() : reads[0];
      if (r instanceof Error) throw r;
      return r as T;
    },
    account: async () => ({ amount: 10n ** 25n, locked: 0n, storageUsage: 0 }),
    allowance: async () => null,
  };
  return new NearContractClient({ contractId: 'gimbal.near', network: 'mainnet', transport, sleep: async () => {} });
}

async function refreshError(c: NearContractClient): Promise<unknown> {
  try {
    await c.refreshPrices(['ETH'], { maxAgeS: 600 });
  } catch (err) {
    return err;
  }
  return assert.fail('refreshPrices did not throw');
}

test('refreshLanded reads the near-client\'s own errors: on chain after the call, or sent with no outcome; not a refusal or a reverted call', async () => {
  const old = [{ asset: 'ETH', price_e8: 250_000_000_000, at_ms: 0 }];
  const ranFalse = await refreshError(refreshChain({ txHash: 'H1', ok: true, value: false }, [old]));
  assert.match(String(ranFalse), /^Error: refresh_prices ran in H1: it returned false/);
  assert.equal(refreshLanded(ranFalse), true, 'false is the callback\'s answer: the ask was recorded');
  const noNewer = await refreshError(refreshChain({ txHash: 'H2', ok: true, value: true }, [old]));
  assert.match(String(noNewer), /^Error: refresh_prices ran in H2: prices\(\) has no newer price/);
  assert.equal(refreshLanded(noNewer), true);
  // It ran, then the poll's prices() read failed over HTTP: still on chain, so no second refresh within 30 s.
  const readFails = await refreshError(refreshChain({ txHash: 'H3', ok: true, value: true }, [old, new Error('NEAR RPC: HTTP 502')]));
  assert.match(String(readFails), /^Error: refresh_prices ran in H3: NEAR RPC: HTTP 502/);
  assert.equal(refreshLanded(readFails), true);
  // Not on chain: the read before the call, a refusal, a call that failed on chain (state reverted).
  const before = await refreshError(refreshChain({ txHash: 'H4', ok: true, value: true }, [new Error('NEAR RPC: HTTP 503')]));
  assert.equal(refreshLanded(before), false, String(before));
  const refused = await refreshError(refreshChain({ txHash: 'H5', ok: false, failure: '{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: E_NOT_ALLOWED: no desk"}}}}' }, [old]));
  assert.equal(refreshLanded(refused), false, String(refused));
  const reverted = await refreshError(refreshChain({ txHash: 'H6', ok: false, failure: '{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Exceeded the prepaid gas."}}}}' }, [old]));
  assert.match(String(reverted), /refresh_prices failed in transaction H6/);
  assert.equal(refreshLanded(reverted), false);
  // Sent with no final outcome (the transport's OutcomeUnknown): it may have run, so it blocks the next 30 s.
  const lost = await refreshError(refreshChain(new OutcomeUnknown('refresh_prices', 'no final outcome of NEAR transaction H7 after 60 s', { nearTx: 'H7' }), [old]));
  assert.ok(lost instanceof OutcomeUnknown);
  assert.equal(refreshLanded(lost), true);
  assert.equal(refreshLanded(new OutcomeUnknown('refresh_prices', 'failed without a refusal code: Exceeded the prepaid gas.', { nearTx: 'H8' })), false, 'an on-chain failure reverted its state');
  assert.equal(refreshLanded(new Error('some refresh_prices ran in H9: elsewhere')), false, 'only the near-client\'s own prefix');
});

test('an open refuses beside resting Hyperliquid orders for the coin; other coins, or none, pass; an unreadable answer refuses', () => {
  assert.equal(restingOrdersRefusal([], 'ETH'), null);
  assert.equal(restingOrdersRefusal([{ coin: 'BTC', side: 'A', sz: '0.001', oid: 1 }], 'ETH'), null);
  assert.match(restingOrdersRefusal([{ coin: 'ETH', side: 'A', sz: '0.005', oid: 77 }, { coin: 'BTC', side: 'B', sz: '1', oid: 2 }], 'ETH')!,
    /^Hyperliquid has 1 resting ETH order\(s\) \(SELL 0\.005 \(oid 77\)\): an earlier run's order could fill outside the target net/);
  assert.match(restingOrdersRefusal('hyperliquid /info openOrders: HTTP 500', 'ETH')!, /open orders cannot be read/);
});

test('the legs\' price read refreshes only once trading: planning reads the stored price as it is', async () => {
  const p = prices({ ages: { ETH: [895] } });
  let trading = false;
  const oraclePx = oraclePxOf(p.d, 'ETH', () => trading);
  assert.equal(await oraclePx(), 2500);
  assert.deepEqual(p.refreshes, [], 'a stale price while planning is not refreshed (the refusals are not checked yet)');
  trading = true;
  assert.equal(await oraclePx(), 2500);
  assert.deepEqual(p.refreshes, ['ETH 870'], 'once trading, an order finding it within 30 s of stale refreshes it');
  const none = prices({ ages: { ETH: [null] } });
  await assert.rejects(oraclePxOf(none.d, 'ETH', () => false)(), /no stored ETH price/);
});

const ACCOUNT: PhoenixCrossView = {
  cross: { equityUsd: 30, maintenanceMarginUsd: 1 },
  positions: [
    { symbol: 'ETH', size: 0.008, notionalUsd: 20, subaccountIndex: 0 },
    { symbol: 'SOL', size: 1, notionalUsd: 500, subaccountIndex: 1 },     // isolated: its own collateral
  ],
};

test('a Phoenix withdrawal: unread is refused, only an unregistered trader passes unread; the cross subaccount at the mark', async () => {
  const reads = (state: () => Promise<string | null>, account: () => Promise<PhoenixCrossView> = async () => ACCOUNT) => ({ state, account });
  assert.deepEqual(await withdrawKeepsLegs(reads(async () => 'uninitialized'), true, 0), []);
  assert.match((await withdrawKeepsLegs(reads(async () => null), true, 0)).join(), /trader state is unknown/);
  assert.match((await withdrawKeepsLegs(reads(async () => { throw new Error('HTTP 502'); }), true, 0)).join(), /cannot be read \(HTTP 502\)/);
  assert.match((await withdrawKeepsLegs(reads(async () => 'active', async () => { throw new Error('HTTP 429'); }), false, 1)).join(), /account cannot be read/);
  assert.match((await withdrawKeepsLegs(reads(async () => 'active'), true, 0)).join(), /defund-phoenix all would take/);
  // 30 cross equity against 20 at the mark: 10 can go (20 x 1.5 >= 20); 20 cannot (10 x 1.5 < 20).
  assert.deepEqual(await withdrawKeepsLegs(reads(async () => 'active'), false, 10), []);
  const over = await withdrawKeepsLegs(reads(async () => 'active'), false, 20);
  assert.match(over.join(), /\$10\.0000 against \$20\.0000 open at the mark .*over 1\.5x/);
  const flat = { ...ACCOUNT, positions: [] };
  assert.deepEqual(await withdrawKeepsLegs(reads(async () => 'active', async () => flat), true, 0), []);
});

test('cross margin: Hyperliquid from crossMarginSummary and cross positionValue; Phoenix from subaccount 0', () => {
  const raw = {
    marginSummary: { accountValue: '100' }, crossMarginSummary: { accountValue: '60.5' }, crossMaintenanceMarginUsed: '1.25',
    assetPositions: [
      { position: { coin: 'ETH', positionValue: '30.0', leverage: { type: 'cross', value: 5 } } },
      { position: { coin: 'BTC', positionValue: '40.0', leverage: { type: 'isolated', value: 3 } } },
    ],
  };
  assert.deepEqual(hlCross(raw), { equityUsd: 60.5, maintenanceUsd: 1.25, notionalUsd: 30 });
  assert.throws(() => hlCross({ assetPositions: [] }), /crossMarginSummary/);
  // null reads as 0 through Number(): refused, as is an empty string.
  assert.throws(() => hlCross({ ...raw, crossMarginSummary: { accountValue: null } }), /crossMarginSummary/);
  assert.throws(() => hlCross({ ...raw, crossMaintenanceMarginUsed: '' }), /crossMaintenanceMarginUsed/);
  assert.throws(() => hlCross({ ...raw, assetPositions: [{ position: { positionValue: null, leverage: { type: 'cross' } } }] }), /positionValue null/);
  assert.equal(hlCross({ ...raw, crossMaintenanceMarginUsed: 2 }).maintenanceUsd, 2, 'a number is taken as it is');
  assert.deepEqual(phoenixCross(ACCOUNT), { equityUsd: 30, maintenanceUsd: 1, notionalUsd: 20 });
});

test('the Phoenix IOC after a late maker fill: back to the target net in whole lots, reduce-only when it only shrinks', () => {
  const lot = toQty('0.001');
  assert.deepEqual(residualHedge(toQty('-0.003'), toQty('0.002'), lot, 0n), { side: 'BUY', size: toQty('0.001'), reduceOnly: false });
  assert.deepEqual(residualHedge(toQty('-0.001'), toQty('0.002'), lot, 0n), { side: 'SELL', size: toQty('0.001'), reduceOnly: true });
  assert.equal(residualHedge(toQty('-0.0024'), toQty('0.002'), lot, 0n), null, 'under one Phoenix lot off: nothing to send');
  assert.equal(residualHedge(toQty('-0.002'), toQty('0.002'), lot, 0n), null);
  assert.deepEqual(residualHedge(toQty('0.001'), toQty('0.002'), lot, 0n), { side: 'SELL', size: toQty('0.003'), reduceOnly: false }, 'past zero: not reduce-only');
  // An open found the pair 0.001 long net (an older run): that stays; only this run's late fill is matched.
  assert.equal(residualHedge(toQty('-0.005'), toQty('0.006'), lot, toQty('0.001')), null, 'at the target net: nothing to trade away');
  assert.deepEqual(residualHedge(toQty('-0.006'), toQty('0.006'), lot, toQty('0.001')), { side: 'BUY', size: toQty('0.001'), reduceOnly: false });
});

test('finish() after cancelPending: the hedge goes only when every condition holds; the alert clears only when the legs offset', () => {
  const base: ResidualInput = {
    left: 0, phoenixUnsettled: false, send: true, trading: true, hl: toQty('-0.003'), px: toQty('0.002'), lot: toQty('0.001'),
    targetNet: 0n, symbol: 'ETH', unhedged: 'unhedged: from the pair',
  };
  const go = residualPlan(base);
  assert.deepEqual(go.hedge, { side: 'BUY', size: toQty('0.001'), reduceOnly: false });
  assert.equal(go.held, null);
  assert.equal(go.unhedged, 'unhedged: hyperliquid ETH -0.003, phoenix ETH 0.002 against a target net of 0: 0.001 ETH short is not offset');
  const held = (over: Partial<ResidualInput>, why: RegExp) => {
    const p = residualPlan({ ...base, ...over });
    assert.equal(p.hedge, null, String(why));
    assert.match(p.held ?? '', why);
    assert.match(p.unhedged ?? '', /0\.00(1|04) ETH short is not offset$/, 'still off: the exact amount is the alert');
  };
  held({ left: 1 }, /1 post-only order\(s\) are still unsettled/);
  held({ phoenixUnsettled: true }, /Phoenix has an order with no answer/);
  held({ send: false }, /outside a trading --send run/);
  held({ trading: false }, /outside a trading --send run/);
  held({ hl: toQty('-0.0024') }, /under one Phoenix lot/);
  // At the target net: nothing to send; the alert clears only with no post-only order left to fill.
  const even = residualPlan({ ...base, hl: toQty('-0.002') });
  assert.deepEqual([even.hedge, even.held, even.unhedged], [null, null, null]);
  const evenLeft = residualPlan({ ...base, hl: toQty('-0.002'), left: 1 });
  assert.equal(evenLeft.unhedged, 'unhedged: from the pair', 'a post-only order left may still fill: the alert stands');
  const older = residualPlan({ ...base, hl: toQty('-0.005'), px: toQty('0.006'), targetNet: toQty('0.001') });
  assert.deepEqual([older.hedge, older.unhedged], [null, null], 'an open keeps an older imbalance: it is the target, not something to fix');
});

test('a close that started imbalanced targets flat: the residual hedge never leaves Phoenix naked against a flat Hyperliquid', () => {
  // An older run left hl -0.005, px +0.006; the close targets [0, 0], so its target net is 0, not the 0.001 it found.
  const close: ResidualInput = {
    left: 0, phoenixUnsettled: false, send: true, trading: true, hl: 0n, px: 0n, lot: toQty('0.001'), targetNet: 0n, symbol: 'ETH', unhedged: null,
  };
  // Both legs flat after cancelPending settled a post-only order: nothing to send (a 0.001 target would buy 0.001 naked).
  assert.deepEqual(residualPlan(close), { hedge: null, held: null, unhedged: null });
  assert.deepEqual(residualPlan({ ...close, targetNet: toQty('0.001') }).hedge, { side: 'BUY', size: toQty('0.001'), reduceOnly: false }, 'the old bug: hl + px at the start');
  // Hyperliquid flat, Phoenix still +0.006: sell all of it, reduce-only (a 0.001 target would sell 0.005 and keep 0.001 long).
  const pxLeft = residualPlan({ ...close, px: toQty('0.006') });
  assert.deepEqual(pxLeft.hedge, { side: 'SELL', size: toQty('0.006'), reduceOnly: true });
  assert.match(pxLeft.unhedged!, /against a target net of 0: 0\.006 ETH long is not offset$/);
  assert.deepEqual(residualPlan({ ...close, px: toQty('0.006'), targetNet: toQty('0.001') }).hedge, { side: 'SELL', size: toQty('0.005'), reduceOnly: true }, 'the old bug');
});

/** settleResidual's reads and sends: `reads` answer readLegs in turn (null: cannot be read), `outcome` the hedge. */
function residualDeps(reads: ({ hl: string; px: string } | null)[], outcome?: (side: LegSide, size: bigint) => LegOutcome) {
  const said: string[] = [];
  const opened: string[] = [];
  const hedges: string[] = [];
  const d: ResidualDeps = {
    readLegs: async () => {
      const r = reads.shift();
      if (r === undefined) throw new Error('readLegs read once too often');
      return r === null ? null : { hl: toQty(r.hl), px: toQty(r.px) };
    },
    hedge: async (side, size, reduceOnly) => {
      hedges.push(`${side} ${size}${reduceOnly ? ' reduce-only' : ''}`);
      if (outcome === undefined) throw new Error('no hedge expected');
      return outcome(side, size);
    },
    say: (l) => said.push(l),
    open: (l) => opened.push(l),
  };
  return { d, said, opened, hedges };
}

const REF = { venue: 'phoenix' as const, side: 'BUY' as const, size: '0.001', reduceOnly: false, orderId: 'SIG', clientId: null, tx: [], sentAt: 0 };
const filled = (_side: LegSide, size: bigint): LegOutcome => ({ kind: 'filled', filled: size, avgPx: 2500, ref: REF });
const lostOrder = (): LegOutcome => ({ kind: 'unknown', error: new Error('no answer'), ref: REF, expiresAt: null });

test('settleResidual: the hedge and the read after it; one with no answer keeps the alert and an open: line', async () => {
  const base = { left: 0, phoenixUnsettled: false, send: true, trading: true, lot: toQty('0.001'), targetNet: 0n, symbol: 'ETH', unhedged: 'unhedged: from the pair' };
  // Filled: read again at the target net, the alert clears.
  const ok = residualDeps([{ hl: '-0.003', px: '0.002' }, { hl: '-0.003', px: '0.003' }], filled);
  assert.equal(await settleResidual(base, ok.d), null);
  assert.deepEqual(ok.hedges, [`BUY ${toQty('0.001')}`]);
  assert.ok(ok.said.some((l) => /back to the target net against hyperliquid -0\.003/.test(l)));
  assert.deepEqual(ok.opened, []);
  // No answer: an open: line; the second plan counts Phoenix as unsettled, so the alert is the exact amount still off.
  const lost = residualDeps([{ hl: '-0.003', px: '0.002' }, { hl: '-0.003', px: '0.002' }], lostOrder);
  assert.match((await settleResidual(base, lost.d))!, /0\.001 ETH short is not offset$/);
  assert.equal(lost.hedges.length, 1, 'one hedge only');
  assert.equal(lost.opened.length, 1);
  assert.match(lost.opened[0]!, /the phoenix hedge BUY 0\.001 ETH \(SIG\) has no proven outcome/);
  // The order with no answer ran after all and the second read is at the target: the alert clears, the open: line stays.
  const ranLate = residualDeps([{ hl: '-0.003', px: '0.002' }, { hl: '-0.003', px: '0.003' }], lostOrder);
  assert.equal(await settleResidual(base, ranLate.d), null);
  assert.equal(ranLate.opened.length, 1);
  // A failed hedge (nothing ran): read again, still off, no open: line from the hedge.
  const failed = residualDeps([{ hl: '-0.003', px: '0.002' }, { hl: '-0.003', px: '0.002' }], () => ({ kind: 'failed', error: new Error('slippage'), ref: REF }));
  assert.match((await settleResidual(base, failed.d))!, /0\.001 ETH short is not offset$/);
  assert.deepEqual(failed.opened, []);
});

test('settleResidual: legs that cannot be read before or after the hedge, and a held hedge', async () => {
  const base = { left: 0, phoenixUnsettled: false, send: true, trading: true, lot: toQty('0.001'), targetNet: 0n, symbol: 'ETH', unhedged: null };
  const after = residualDeps([{ hl: '-0.003', px: '0.002' }, null], filled);
  assert.equal(await settleResidual(base, after.d), 'the legs cannot be read after the hedge: check hyperliquid and phoenix ETH by hand');
  assert.equal(after.hedges.length, 1);
  const before = residualDeps([null]);
  assert.equal(await settleResidual(base, before.d), 'the legs cannot be read after the cancel: check hyperliquid and phoenix ETH by hand');
  assert.deepEqual(before.hedges, [], 'nothing is sent without a read');
  // A post-only order still unsettled: no hedge, one read, the exact amount is the alert.
  const held = residualDeps([{ hl: '-0.003', px: '0.002' }]);
  assert.match((await settleResidual({ ...base, left: 1 }, held.d))!, /0\.001 ETH short is not offset$/);
  assert.ok(held.said.some((l) => /not sent: 1 post-only order/.test(l)));
  assert.deepEqual(held.hedges, []);
  // At the target net already: no hedge, the alert clears.
  const even = residualDeps([{ hl: '-0.002', px: '0.002' }]);
  assert.equal(await settleResidual({ ...base, unhedged: 'unhedged: before' }, even.d), null);
});
