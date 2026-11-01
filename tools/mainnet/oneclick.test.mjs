import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ASSETS, ONECLICK_PUBLIC_KEY, QuoteRefusal, allowedCostE8, canonicalQuote, checkCost, checkQuoteSignature, fundCostBudgetE8, requestQuote,
  rescueCostBudgetE8, stableStringify, transferCostE8, verifyQuote,
} from './oneclick.mjs';
import { ASSETS as CHECKS_ASSETS } from './checks.mjs';

const vectors = (file) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../contract/core/tests/vectors/${file}`, import.meta.url)), 'utf8'));
const FILES = ['oneclick-live.json', 'oneclick.json'];

test('the canonical quote of every recorded answer is the one 1Click signed (dry quotes sign no live extras)', () => {
  for (const file of FILES) {
    const v = vectors(file);
    assert.equal(v.public_key, `ed25519:${ONECLICK_PUBLIC_KEY}`, file);
    assert.ok(v.quotes.length >= 8, file);
    for (const q of v.quotes) {
      assert.equal(canonicalQuote(q.response), q.canonical_json, `${file}: ${q.name}`);
      assert.equal(q.signature_valid, true);
      checkQuoteSignature(q.canonical_json, q.signature);
    }
  }
});

test('every field case of the contract\'s vectors gets the contract\'s verdict', () => {
  for (const file of FILES) {
    const v = vectors(file);
    const byName = new Map(v.quotes.map((q) => [q.name, q]));
    assert.ok(v.field_cases.length >= 39, file);
    for (const c of v.field_cases) {
      const q = byName.get(c.quote);
      const ctx = { ...c.ctx, remaining_cap_e8: BigInt(c.ctx.remaining_cap_usd) * 100_000_000n };
      let got;
      try {
        verifyQuote(c.canonical_json ?? q.canonical_json, c.signature ?? q.signature, c.method, ctx);
        got = { ok: true };
      } catch (e) {
        assert.ok(e instanceof QuoteRefusal, `${file}: ${c.name}: ${e.message}`);
        got = { ok: false, code: e.code };
      }
      assert.deepEqual(got, c.expect.ok ? { ok: true } : { ok: false, code: c.expect.code }, `${file}: ${c.name}`);
    }
  }
});

test('a tampered quote fails the signature', () => {
  for (const file of FILES) {
    for (const t of vectors(file).tampered) {
      assert.equal(t.expect, 'E_QUOTE_SIGNATURE');
      assert.throws(() => checkQuoteSignature(t.canonical_json, t.signature), (e) => e instanceof QuoteRefusal && e.code === 'E_QUOTE_SIGNATURE', `${file}: ${t.name}`);
    }
  }
});

test('stable stringify: sorted keys, no spaces, undefined dropped', () => {
  assert.equal(stableStringify({ b: 1, a: [true, null, { d: undefined, c: 'x' }], e: undefined }), '{"a":[true,null,{"c":"x"}],"b":1}');
});

test('the cost rules are check_cost / fund_cost_budget_e8 / rescue_cost_budget_e8 of contract/core/src/oneclick.rs', () => {
  // The canary policy: 300 bps or 1 USDC, whichever is more; the flat amount decides below 33.3 USDC.
  assert.equal(allowedCostE8(20n * 10n ** 8n, 300, 1_000_000), 100_000_000n);
  assert.equal(allowedCostE8(50n * 10n ** 8n, 300, 1_000_000), 150_000_000n);
  assert.equal(fundCostBudgetE8(20, 300, 1_000_000), 400_000_000n, 'four transfers at 1 USDC an hour');
  assert.equal(rescueCostBudgetE8(50, 300, 1_000_000), 200_000_000n, 'two transfers at 1 USDC an hour');
  // The Rust test values.
  assert.equal(rescueCostBudgetE8(50, 100, 500_000), 100_000_000n);
  assert.equal(rescueCostBudgetE8(1000, 100, 500_000), 1_000_000_000n);
  assert.equal(rescueCostBudgetE8(0, 100, 0), 0n);
  // The recorded live fund_venue to Hyperliquid: 20 USDC in, 19.480951 minimum out.
  const v = vectors('oneclick-live.json');
  const q = v.quotes.find((x) => x.method === 'fund_venue' && x.response.quoteRequest.destinationAsset === ASSETS.hypercoreUsdc);
  const c = v.field_cases.find((x) => x.quote === q.name && x.expect.ok);
  const verified = verifyQuote(q.canonical_json, q.signature, 'fund_venue', { ...c.ctx, remaining_cap_e8: 0n });
  assert.equal(transferCostE8(verified), BigInt(q.signed_cost_e8));
  assert.equal(transferCostE8(verified), 51_904_900n);
  checkCost(verified, 300, 1_000_000);
  assert.throws(() => checkCost(verified, 100, 500_000), (e) => e.code === 'E_QUOTE_FIELDS' && /over the policy's 0\.5 USDC/.test(e.message), 'the old 100 bps / 0.5 USDC policy refuses it');
});

test('the assets are the ones checks.mjs quotes with', () => {
  for (const k of Object.keys(CHECKS_ASSETS)) assert.equal(ASSETS[k], CHECKS_ASSETS[k], k);
  assert.equal(ASSETS.arbitrumUsdc, 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near');
});

test('the API key goes in the authorization header only, never in the body or the URL', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response('{"quote":{}}', { status: 201 });
  };
  await requestQuote(fetchImpl, { dry: true }, 'k-123');
  assert.equal(seen[0].init.headers.authorization, 'Bearer k-123');
  assert.doesNotMatch(seen[0].url + seen[0].init.body, /k-123/);
  await requestQuote(fetchImpl, { dry: true }, null);
  assert.equal(seen[1].init.headers.authorization, undefined);
});
