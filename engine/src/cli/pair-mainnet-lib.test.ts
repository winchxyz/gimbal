// pair-mainnet's decisions without a network: the order options a bare command line gets (the taker fallback is off),
// a maker timeout that must fit the life of a fresh stored price, when the stored price is refreshed (once for
// concurrent callers, per symbol, never within 30 s of the last that landed, never while planning) and checked after,
// what a Phoenix withdrawal must leave, both venues' cross margin, and what finish() does after a late maker fill.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TxRef } from '@gimbal/shared';
import { toQty } from '../trade/lots.ts';
import type { PhoenixCrossView, PriceDeps, ResidualInput, StoredPrice } from './pair-mainnet-lib.ts';
import {
  DEFAULT_MAKER_TIMEOUT_S, PRICE_MARGIN_S, UsageError, ensureFresh, hlCross, newPriceState, oraclePxOf, orderOptions, parseArgs, phoenixCross,
  priceFitRefusal, priceLifeS, residualHedge, residualPlan, withdrawKeepsLegs,
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
  landed.d.landed = (err) => /ran in/.test(String(err));
  landed.d.refresh = async () => { throw new Error('refresh_prices ran in T but prices() has no newer price'); };
  await assert.rejects(ensureFresh(landed.d, 'ETH', 240), /ran in/);
  assert.equal(landed.d.lastRefreshAt.has('ETH'), true);
  landed.d.refresh = async () => { throw new Error('must not be sent'); };
  await assert.rejects(ensureFresh(landed.d, 'ETH', 240), /700 s old/);
  assert.ok(landed.logs.some((l) => /not sent again/.test(l)));
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

test('the Phoenix IOC after a late maker fill: back to the starting net in whole lots, reduce-only when it only shrinks', () => {
  const lot = toQty('0.001');
  assert.deepEqual(residualHedge(toQty('-0.003'), toQty('0.002'), lot, 0n), { side: 'BUY', size: toQty('0.001'), reduceOnly: false });
  assert.deepEqual(residualHedge(toQty('-0.001'), toQty('0.002'), lot, 0n), { side: 'SELL', size: toQty('0.001'), reduceOnly: true });
  assert.equal(residualHedge(toQty('-0.0024'), toQty('0.002'), lot, 0n), null, 'under one Phoenix lot off: nothing to send');
  assert.equal(residualHedge(toQty('-0.002'), toQty('0.002'), lot, 0n), null);
  assert.deepEqual(residualHedge(toQty('0.001'), toQty('0.002'), lot, 0n), { side: 'SELL', size: toQty('0.003'), reduceOnly: false }, 'past zero: not reduce-only');
  // An older run left the pair 0.001 long net: that stays; only this run's late fill is matched.
  assert.equal(residualHedge(toQty('-0.005'), toQty('0.006'), lot, toQty('0.001')), null, 'at the starting net: nothing to trade away');
  assert.deepEqual(residualHedge(toQty('-0.006'), toQty('0.006'), lot, toQty('0.001')), { side: 'BUY', size: toQty('0.001'), reduceOnly: false });
});

test('finish() after cancelPending: the hedge goes only when every condition holds; the alert clears only when the legs offset', () => {
  const base: ResidualInput = {
    left: 0, phoenixUnsettled: false, send: true, trading: true, hl: toQty('-0.003'), px: toQty('0.002'), lot: toQty('0.001'),
    startNet: 0n, symbol: 'ETH', unhedged: 'unhedged: from the pair',
  };
  const go = residualPlan(base);
  assert.deepEqual(go.hedge, { side: 'BUY', size: toQty('0.001'), reduceOnly: false });
  assert.equal(go.held, null);
  assert.equal(go.unhedged, 'unhedged: hyperliquid ETH -0.003, phoenix ETH 0.002 against a starting net of 0: 0.001 ETH short is not offset');
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
  // Offset (net of the start): nothing to send; the alert clears only with no post-only order left to fill.
  const even = residualPlan({ ...base, hl: toQty('-0.002') });
  assert.deepEqual([even.hedge, even.held, even.unhedged], [null, null, null]);
  const evenLeft = residualPlan({ ...base, hl: toQty('-0.002'), left: 1 });
  assert.equal(evenLeft.unhedged, 'unhedged: from the pair', 'a post-only order left may still fill: the alert stands');
  const older = residualPlan({ ...base, hl: toQty('-0.005'), px: toQty('0.006'), startNet: toQty('0.001') });
  assert.deepEqual([older.hedge, older.unhedged], [null, null], 'an older imbalance is the start, not something to fix');
});
