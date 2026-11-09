// Hyperliquid order numbers: every price and size planIoc makes passes the contract's own checks (replay-checks.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBand, checkPx, checkSz, parseE8 } from '../contract/replay-checks.ts';
import { hlPx, hlSz, planIoc } from './hl-order.ts';

test('prices: 5 significant figures, 6 - szDecimals decimals, integers always; sizes in lots', () => {
  assert.equal(hlPx(2512.3456, 4, 'down'), '2512.3');
  assert.equal(hlPx(2512.3456, 4, 'up'), '2512.4');
  assert.equal(hlPx(81250.7, 5, 'down'), '81250');
  assert.equal(hlPx(123456.7, 0, 'up'), '123457');
  assert.equal(hlPx(0.0123456, 0, 'down'), '0.012345');
  assert.equal(hlPx(0.0123456, 2, 'down'), '0.0123');
  assert.equal(hlPx(39.9, 2, 'down'), '39.9');
  assert.equal(hlPx(2500, 4, 'down'), '2500');
  assert.equal(hlSz(0.0043999, 4, 'up'), '0.0044');
  assert.equal(hlSz(3.0000000001, 2, 'up'), '3');
  assert.equal(hlSz(150.2, 0, 'down'), '150');
});

test('planIoc: crosses the book inside the band, at least 10 USD, and passes the contract checks', () => {
  for (const [side, bookPx, oraclePx] of [['buy', 2501.3, 2500], ['sell', 2498.7, 2500], ['buy', 2545, 2500], ['sell', 101.2, 101.4]] as const) {
    const plan = planIoc({ asset: 1, szDecimals: 4, side, oraclePx, bandBps: 200, bookPx, maxNotionalUsd: 1000 });
    checkPx(plan.order.px, 4);
    checkSz(plan.order.sz, 4);
    checkBand(parseE8('px', plan.order.px), parseE8('oracle', String(oraclePx)), 200);
    assert.ok(side === 'buy' ? plan.px >= bookPx : plan.px <= bookPx, `${side} ${plan.order.px} vs ${bookPx}`);
    assert.ok(plan.notionalUsd >= 10 && plan.notionalUsd < 12, String(plan.notionalUsd));
    assert.equal(plan.order.tif, 'Ioc');
  }
});

test('planIoc refuses what could not fill or the policy would refuse', () => {
  assert.throws(() => planIoc({ asset: 1, szDecimals: 4, side: 'buy', oraclePx: 2500, bandBps: 200, bookPx: 2560, maxNotionalUsd: 1000 }), /outside the contract's band/);
  assert.throws(() => planIoc({ asset: 1, szDecimals: 4, side: 'buy', oraclePx: 2500, bandBps: 200, bookPx: 2500, maxNotionalUsd: 5 }), /over policy.max_notional_usd/);
  const close = planIoc({ asset: 1, szDecimals: 4, side: 'sell', oraclePx: 2500, bandBps: 200, bookPx: 2499, maxNotionalUsd: 1000, sz: '0.0002', reduceOnly: true });
  assert.equal(close.order.sz, '0.0002');
  assert.equal(close.order.reduce_only, true);
});

test('every planned IOC carries a fresh cloid; an unpriced asset has no band but its max_sz', () => {
  const a = planIoc({ asset: 1, szDecimals: 4, side: 'buy', oraclePx: 2500, bandBps: 200, bookPx: 2501, maxNotionalUsd: 1000 });
  const b = planIoc({ asset: 1, szDecimals: 4, side: 'buy', oraclePx: 2500, bandBps: 200, bookPx: 2501, maxNotionalUsd: 1000 });
  assert.match(a.order.cloid!, /^0x[0-9a-f]{32}$/);
  assert.notEqual(a.order.cloid, b.order.cloid);
  assert.equal(planIoc({ asset: 1, szDecimals: 4, side: 'buy', oraclePx: 2500, bandBps: 200, bookPx: 2501, maxNotionalUsd: 1000, cloid: '0xab' }).order.cloid, '0xab');
  // Unpriced: the limit is the book plus slippage, wherever the (absent) oracle would be.
  const u = planIoc({ asset: 1, szDecimals: 4, side: 'buy', oraclePx: null, bandBps: 200, bookPx: 2600, maxNotionalUsd: 100, maxSz: '3' });
  assert.equal(u.order.px, '2613');
  assert.throws(() => planIoc({ asset: 1, szDecimals: 1, side: 'buy', oraclePx: null, bandBps: 200, bookPx: 1, maxNotionalUsd: 100, notionalUsd: 50, maxSz: '3' }), /over the unpriced asset's max_sz 3/);
});

test('planIoc with a mark (the owner entry’s taker fallback): the limit is held within mark ± bps, unpriced too', () => {
  const unpriced = { asset: 1, szDecimals: 4, oraclePx: null, bandBps: 200, maxNotionalUsd: 100, maxSz: '3' } as const;
  // Unpriced, the book alone would allow 2613; the mark 2595 + 50 bps holds it at 2607.975, rounded down.
  const buy = planIoc({ ...unpriced, side: 'buy', bookPx: 2600, mark: { px: 2595, bps: 50 } });
  assert.ok(buy.px <= 2595 * 1.005 && buy.px >= 2600, `buy limit ${buy.px}`);
  assert.equal(buy.order.px, '2607.9');
  // A sell: book 2600 - 50 bps = 2587, the mark 2605 - 50 bps = 2591.975, rounded up.
  const sell = planIoc({ ...unpriced, side: 'sell', bookPx: 2600, mark: { px: 2605, bps: 50 } });
  assert.ok(sell.px >= 2605 * 0.995 && sell.px <= 2600, `sell limit ${sell.px}`);
  // The tighter of the two wins: a mark far away leaves the book's own slippage bound.
  assert.equal(planIoc({ ...unpriced, side: 'buy', bookPx: 2600, mark: { px: 2700, bps: 50 } }).order.px, '2613');
  // A touch already past the mark's bound could not fill within it, and no mark at all is refused: nothing is planned.
  assert.throws(() => planIoc({ ...unpriced, side: 'buy', bookPx: 2620, mark: { px: 2595, bps: 50 } }), /more than 50 bps from the mark 2595/);
  assert.throws(() => planIoc({ ...unpriced, side: 'sell', bookPx: 2580, mark: { px: 2605, bps: 50 } }), /more than 50 bps from the mark 2605/);
  assert.throws(() => planIoc({ ...unpriced, side: 'buy', bookPx: 2600, mark: { px: 0, bps: 50 } }), /no usable mark price/);
  assert.throws(() => planIoc({ ...unpriced, side: 'buy', bookPx: 2600, mark: { px: Number.NaN, bps: 50 } }), /no usable mark price/);
  // Priced: the band still applies, and the tightest of the book (2513.5), the band (2547.5) and the mark (2512.5) wins.
  const priced = planIoc({ asset: 1, szDecimals: 4, side: 'buy', oraclePx: 2500, bandBps: 200, bookPx: 2501, maxNotionalUsd: 1000, mark: { px: 2500, bps: 50 } });
  assert.equal(priced.order.px, '2512.5');
  assert.throws(() => planIoc({ asset: 1, szDecimals: 4, side: 'buy', oraclePx: 2500, bandBps: 200, bookPx: 2560, maxNotionalUsd: 1000, mark: { px: 2560, bps: 50 } }), /outside the contract's band/);
});
