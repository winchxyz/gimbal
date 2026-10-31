// ContractPriceCache: the scanner's oracle from the contract's stored prices, by venue symbol or its base.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractPriceCache, priceUsd } from './prices.ts';
import type { StoredPrice } from './types.ts';

const ROWS: StoredPrice[] = [
  { asset: 'ETH', price_e8: '250000000000', at_ms: 1_000 },
  { asset: 'SOL', price_e8: 10_380_000_000, at_ms: 2_000 },
  { asset: 'PEPE', price_e8: '1200', at_ms: 3_000 },
  { asset: 'BAD', price_e8: 'nope', at_ms: 4_000 },
];

test('a symbol with its own price, then its cross-venue base scaled by the units per symbol', () => {
  const cache = new ContractPriceCache({ client: { prices: async () => [] } });
  cache.set(ROWS);
  assert.equal(cache.size, 3);
  assert.deepEqual(cache.price('hyperliquid', 'ETH'), { px: 2500, at: 1_000 });
  assert.deepEqual(cache.price('orderly', 'PERP_SOL_USDC'), { px: 103.8, at: 2_000 });
  const kPepe = cache.price('hyperliquid', 'kPEPE');
  assert.ok(kPepe !== null && Math.abs(kPepe.px - 0.012) < 1e-12 && kPepe.at === 3_000);
  assert.equal(cache.price('hyperliquid', 'DOGE'), null);
  assert.equal(cache.price('hyperliquid', 'BAD'), null);
  assert.equal(priceUsd('8125000000000'), 81_250);
});

test('refresh reads prices(); a failed read keeps the last prices and reports once', async () => {
  let fail = false;
  const errors: string[] = [];
  const cache = new ContractPriceCache({
    client: { prices: async () => { if (fail) throw new Error('RPC 503'); return ROWS; } },
    onError: (m) => errors.push(m),
  });
  await cache.refresh();
  assert.equal(cache.size, 3);
  fail = true;
  await cache.refresh();
  await cache.refresh();
  assert.equal(cache.size, 3);
  assert.deepEqual(errors, ['contract prices(): RPC 503']);
});
