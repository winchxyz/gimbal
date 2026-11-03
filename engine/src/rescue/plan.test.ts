// Where a rescue's margin comes from: the reserve first, then the other leg's free margin (never Orderly), then a
// reduce of both legs; the hourly cap (Hyperliquid's route counting about twice), the fee share and the cost bound
// each pass a source over with a note.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanInput } from './plan.ts';
import { CapLedger, HL_WITHDRAW_FEE_USD, MAX_FEE_SHARE, amountInFor, expectedFeeUsd, planRescue } from './plan.ts';

const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  target: { venue: 'hyperliquid', symbol: 'ETH', amountUsd: 40, marginUsd: 200 },
  reserveUsd: 100,
  freeMargin: { phoenix: 300, hyperliquid: 10 },
  legVenues: ['hyperliquid', 'phoenix'],
  capUsd: 500, capUsedUsd: 0,
  route: () => null,
  reduce: null,
  keyed: true,
  maxCostBps: 100, maxCostFlatE6: 1_000_000,
  ...over,
});

test('source order: the reserve first, then the other leg, then a reduce', () => {
  const r = planRescue(base());
  assert.equal(r.kind, 'transfer');
  assert.equal(r.kind === 'transfer' && r.from, 'reserve');
  assert.equal(r.kind === 'transfer' && r.capUsd, 0, 'fund_venue is not in the rescue cap');

  const p = planRescue(base({ reserveUsd: 5 }));
  assert.equal(p.kind === 'transfer' && p.from, 'phoenix');
  assert.match(p.notes.join(' '), /reserve: 5.00 USD idle on NEAR/);

  const reduce = planRescue(base({ reserveUsd: 5, freeMargin: { phoenix: 3 } }));
  assert.equal(reduce.kind, 'reduce');
  assert.match(reduce.notes.join(' '), /phoenix: 3.00 USD free/);
  // 40 × 1.1 more margin on 200 held: cut 44 / 244 of each leg.
  assert.ok(reduce.kind === 'reduce' && Math.abs(reduce.fraction - 44 / 244) < 1e-9);

  const none = planRescue(base({ reserveUsd: 5, freeMargin: { phoenix: 3 }, reduce: 'no pair trader holds the legs here' }));
  assert.equal(none.kind, 'none');
  assert.match(none.kind === 'none' ? none.reason : '', /cannot be reduced: no pair trader/);
});

test('Orderly is never a source, even with free margin; the target leg is not its own source', () => {
  const r = planRescue(base({ target: { venue: 'phoenix', symbol: 'ETH', amountUsd: 40, marginUsd: 200 }, reserveUsd: 0, freeMargin: { orderly: 1000, phoenix: 1000 }, legVenues: ['phoenix', 'orderly'] }));
  assert.equal(r.kind, 'reduce');
  assert.doesNotMatch(r.notes.join(' '), /orderly:/);
});

test('the cap: a source over what is left of the hour is passed over; Hyperliquid counts withdraw + bridge', () => {
  const capped = planRescue(base({ reserveUsd: 0, capUsd: 50, capUsedUsd: 20 }));
  assert.equal(capped.kind, 'reduce');
  assert.match(capped.notes.join(' '), /phoenix: over the rescue cap: it would count 40\.\d\d USD, and 30.00 of the 50 USD an hour is left/);

  const hl = planRescue(base({ target: { venue: 'phoenix', symbol: 'ETH', amountUsd: 40, marginUsd: 200 }, reserveUsd: 0, freeMargin: { hyperliquid: 500 }, capUsd: 1000 }));
  assert.equal(hl.kind, 'transfer');
  if (hl.kind !== 'transfer') return;
  assert.equal(hl.from, 'hyperliquid');
  assert.ok(Math.abs(hl.withdrawUsd! - (hl.amountInUsd + HL_WITHDRAW_FEE_USD)) < 0.011);
  assert.ok(Math.abs(hl.capUsd - (hl.withdrawUsd! + hl.amountInUsd)) < 1e-9, 'about twice its size');

  const tooBig = planRescue(base({ target: { venue: 'phoenix', symbol: 'ETH', amountUsd: 40, marginUsd: 200 }, reserveUsd: 0, freeMargin: { hyperliquid: 500 }, capUsd: 60 }));
  assert.equal(tooBig.kind, 'reduce');
  assert.match(tooBig.notes.join(' '), /hl_withdraw and the bridge both count/);
});

test('Hyperliquid keeps amount + 1 USDC within the withdrawable', () => {
  const amountIn = amountInFor('hyperliquid', 'phoenix', 40, true);
  const withdraw = Math.ceil((amountIn + 1) * 100 - 1e-6) / 100;
  const just = planRescue(base({ target: { venue: 'phoenix', symbol: 'ETH', amountUsd: 40, marginUsd: 200 }, reserveUsd: 0, freeMargin: { hyperliquid: withdraw + 1 } }));
  assert.equal(just.kind, 'transfer');
  const short = planRescue(base({ target: { venue: 'phoenix', symbol: 'ETH', amountUsd: 40, marginUsd: 200 }, reserveUsd: 0, freeMargin: { hyperliquid: withdraw + 0.99 } }));
  assert.equal(short.kind, 'reduce');
});

test('the fee share: a rescue whose fees are over 10 % of what it sends reduces the legs instead', () => {
  // 1.50 USD into HyperCore: about 0.32 of fees on ~1.83 sent.
  const r = planRescue(base({ target: { venue: 'hyperliquid', symbol: 'ETH', amountUsd: 1.5, marginUsd: 200 } }));
  assert.equal(r.kind, 'reduce');
  assert.match(r.notes.join(' '), new RegExp(`reserve: fees of about 0.32 USD are \\d+ % of the .* over the ${MAX_FEE_SHARE * 100} %`));
  // Without a 1Click key the fee is 0.2 % more.
  assert.ok(expectedFeeUsd('reserve', 'orderly', 100, false) - expectedFeeUsd('reserve', 'orderly', 100, true) > 0.19);
});

test('the cost bound: a policy too tight for the fee and 50 bps of slippage passes the source over', () => {
  const r = planRescue(base({ maxCostBps: 10, maxCostFlatE6: 100_000 }));
  assert.equal(r.kind, 'reduce');
  assert.match(r.notes.join(' '), /reserve: the policy's transfer cost bound \(0.10 USD on 40.\d\d\) leaves 0 bps/);
  assert.match(r.notes.join(' '), /phoenix: the policy's transfer cost bound/);
});

test('route problems and held transfers leave notes; held transfers only reduce', () => {
  const r = planRescue(base({ route: (from) => (from === 'reserve' ? 'fund_venue is not wired' : null) }));
  assert.equal(r.kind === 'transfer' && r.from, 'phoenix');
  assert.match(r.notes[0]!, /reserve: fund_venue is not wired/);
  const held = planRescue(base({ transfersHeld: 'an earlier transfer\'s outcome is unknown' }));
  assert.equal(held.kind, 'reduce');
  assert.match(held.notes.join(' '), /no transfer: an earlier/);
});

test('the Orderly receiver takes at least 6.20 sent; HyperCore at least 1', () => {
  assert.equal(amountInFor('reserve', 'orderly', 1, true), 6.2);
  assert.ok(amountInFor('reserve', 'hyperliquid', 0.1, true) >= 1);
});

test('the cap ledger is a sliding hour', () => {
  const c = new CapLedger();
  c.add(40, 0);
  assert.equal(c.used(0), 40);
  assert.equal(c.used(30 * 60_000), 20);
  assert.equal(c.used(3_600_000), 0);
});

test('stranded Arbitrum USDC: no withdraw fee in its fee share, spent in part when short, and an unread balance stops Hyperliquid', () => {
  const into = (over: Partial<PlanInput>) => planRescue(base({ target: { venue: 'phoenix', symbol: 'ETH', amountUsd: 5, marginUsd: 200 }, reserveUsd: 0, freeMargin: { hyperliquid: 500 }, ...over }));
  // 5 USD: with the 1 USDC withdraw fee it is about 21 %, over the share; from Arbitrum it is about 1 %.
  const withdraw = into({});
  assert.equal(withdraw.kind, 'reduce');
  assert.match(withdraw.notes.join(' '), /hyperliquid: fees of about 1.05 USD/);
  const stranded = into({ arbitrumUsd: 20 });
  assert.ok(stranded.kind === 'transfer' && stranded.withdrawUsd === null && stranded.from === 'hyperliquid');
  assert.ok(stranded.kind === 'transfer' && Math.abs(stranded.feeUsd - 0.05) < 1e-9, 'no withdraw fee');
  // Short: what is there is bridged first, even while withdraws are held.
  const partial = into({ arbitrumUsd: 3.456, hlWithdrawHeld: 'an earlier withdraw' });
  assert.ok(partial.kind === 'transfer' && partial.withdrawUsd === null && partial.amountInUsd === 3.45 && partial.capUsd === 3.45);
  assert.match(partial.notes.join(' '), /only 3.45 of the 5.\d\d USD is on Arbitrum/);
  // Dust under the fee share falls through to the withdraw rule.
  const dust = into({ arbitrumUsd: 0.2, hlWithdrawHeld: 'an earlier withdraw', target: { venue: 'phoenix', symbol: 'ETH', amountUsd: 40, marginUsd: 200 } });
  assert.equal(dust.kind, 'reduce');
  assert.match(dust.notes.join(' '), /the 0.20 USDC on Arbitrum\): fees of about 0.05.*no new hl_withdraw: an earlier withdraw/);
  const unread = into({ arbitrumUsd: null, target: { venue: 'phoenix', symbol: 'ETH', amountUsd: 40, marginUsd: 200 } });
  assert.equal(unread.kind, 'reduce');
  assert.match(unread.notes.join(' '), /hyperliquid: the desk's Arbitrum USDC could not be read/);
});
