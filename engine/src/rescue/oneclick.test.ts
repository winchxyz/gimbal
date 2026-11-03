// The rescue's 1Click checks against the recorded live mainnet quotes (fixtures/oneclick, copied from the contract's
// vectors): the exact string the contract hashes, 1Click's real signature, and the contract's field rules (the
// 5 USDC Orderly quote is refused for its minAmountOut under 6), plus the cap and the cost bound.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { QuoteResponse } from './oneclick.ts';
import { QuoteRefusal, canonicalQuote, parseTimeMs, stableStringify, verifyQuote } from './oneclick.ts';
import { loadRescueRecording } from './recorded.ts';

const rec = loadRescueRecording();
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/oneclick/rescue-mainnet-2026-10-31.json', import.meta.url), 'utf8')) as {
  refused: { method: 'sol_sign_rescue'; response: QuoteResponse };
};
const ctx = (r: QuoteResponse, over: Partial<Parameters<typeof verifyQuote>[2]> = {}) => ({
  desk: rec.desk, nowMs: parseTimeMs(r.timestamp)!, maxCostBps: 100, maxCostFlatE6: 1_000_000, remainingCapE8: 50n * 100_000_000n, ...over,
});

test('stableStringify sorts keys and drops undefined members', () => {
  assert.equal(stableStringify({ b: 1, a: [1, undefined], c: undefined, d: { z: 'x', y: null } }), '{"a":[1,null],"b":1,"d":{"y":null,"z":"x"}}');
});

test('every recorded route verifies: the canonical string, 1Click\'s real signature and the field rules', () => {
  assert.equal(rec.routes.length, 4);
  for (const r of rec.routes) {
    const q = verifyQuote(r.response, r.method, ctx(r.response));
    assert.equal(q.quote, canonicalQuote(r.response), r.name);
    assert.ok(q.costE8 > 0n && q.minAmountOutE8 < q.amountInE8, r.name);
    assert.equal(q.depositAddress, (r.response.quote as { depositAddress: string }).depositAddress);
  }
});

test('the 5 USDC quote into the Orderly receiver is refused: minAmountOut under 6 USDC', () => {
  assert.throws(() => verifyQuote(fixture.refused.response, fixture.refused.method, ctx(fixture.refused.response)),
    (e: unknown) => e instanceof QuoteRefusal && e.code === 'E_QUOTE_FIELDS' && /below 6 USDC/.test(e.message));
});

test('a changed quote, another method, a stranger\'s refund, the cap, the cost bound and the age are refused', () => {
  const r = rec.routes.find((x) => x.from === 'phoenix' && x.to === 'hyperliquid')!;
  const changed = structuredClone(r.response);
  (changed.quote as Record<string, unknown>).minAmountOut = '100';
  assert.throws(() => verifyQuote(changed, 'sol_sign_rescue', ctx(changed)), /E_QUOTE_SIGNATURE/);
  assert.throws(() => verifyQuote(r.response, 'evm_usdc_to_intents', ctx(r.response)), /originAsset/);
  assert.throws(() => verifyQuote(r.response, 'sol_sign_rescue', ctx(r.response, { desk: { ...rec.desk, sol: 'someone-else' } })), /refundTo/);
  assert.throws(() => verifyQuote(r.response, 'sol_sign_rescue', ctx(r.response, { remainingCapE8: 3n * 100_000_000n })),
    (e: unknown) => e instanceof QuoteRefusal && e.code === 'E_RESCUE_CAP');
  assert.throws(() => verifyQuote(r.response, 'sol_sign_rescue', ctx(r.response, { maxCostBps: 10, maxCostFlatE6: 100_000 })), /over the policy/);
  assert.throws(() => verifyQuote(r.response, 'sol_sign_rescue', ctx(r.response, { nowMs: parseTimeMs(r.response.timestamp)! + 3_600_001 })), /more than 1 h ago/);
  // fund_venue is not a rescue method: the cap does not apply to it.
  const f = rec.routes.find((x) => x.from === 'reserve' && x.to === 'hyperliquid')!;
  assert.doesNotThrow(() => verifyQuote(f.response, 'fund_venue', ctx(f.response, { remainingCapE8: 0n })));
});

test('into HyperCore minAmountOut must be at least 1.31 USDC, 1Click\'s minimum (dry quotes 2026-11-03)', async () => {
  const { testQuote, testSigner } = await import('./test-quotes.ts');
  const { ASSETS, HYPERCORE_MIN_E8 } = await import('./oneclick.ts');
  assert.equal(HYPERCORE_MIN_E8, 131_000_000n);
  const signer = testSigner();
  const now = Date.parse('2026-11-03T12:00:00Z');
  const body = (amount: string) => ({
    dry: false, swapType: 'EXACT_INPUT' as const, slippageTolerance: 55, originAsset: ASSETS.solanaUsdc, depositType: 'ORIGIN_CHAIN' as const,
    destinationAsset: ASSETS.hypercoreUsdc, amount, refundTo: rec.desk.sol, refundType: 'ORIGIN_CHAIN' as const, recipient: rec.desk.evm,
    recipientType: 'DESTINATION_CHAIN' as const, deadline: new Date(now + 30 * 60_000).toISOString(),
  });
  const check = (r: QuoteResponse) => verifyQuote(r, 'sol_sign_rescue', ctx(r, { publicKey: signer.publicKey }));
  // 1.50 sent at a 20 % cost: about 1.19 arrives at least, under 1.31.
  assert.throws(() => check(testQuote(signer, body('1500000'), now, 0.2)), /minAmountOut 1\.19\d* is below the 1\.31 USDC 1Click delivers into HyperCore/);
  assert.equal(check(testQuote(signer, body('1700000'), now, 0.2)).minAmountOutE8 >= HYPERCORE_MIN_E8, true);
});
