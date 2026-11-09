// The policy.unpriced lookup per venue, as the contract resolves it: Hyperliquid and Phoenix by their policy symbol,
// Orderly by base_of(PERP_<BASE>_USDC).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContractPolicy } from '@gimbal/shared';
import { anyLegPriced, legCaps, orderlyContractBase, pairCapUsd, policySymbolOf, unpricedBySymbol, unpricedCapUsd, unpricedEntry } from './unpriced.ts';

/** The carry desk's unpriced entries on mainnet, with MON as the owner is about to add it. */
const POLICY: Pick<ContractPolicy, 'unpriced' | 'max_notional_usd' | 'unpriced_max_notional_usd'> = {
  unpriced: [{ symbol: 'ZRO', max_sz: '8.2' }, { symbol: 'ETHFI', max_sz: '25.2' }, { symbol: 'AAVE', max_sz: '0.11' }, { symbol: 'MON', max_sz: '500' }],
  max_notional_usd: 20,
  unpriced_max_notional_usd: 15,
};

test('orderlyContractBase is core/src/orderly.rs base_of: strip PERP_ and _USDC together, else the symbol as it is', () => {
  assert.equal(orderlyContractBase('PERP_ETHFI_USDC'), 'ETHFI');
  assert.equal(orderlyContractBase('PERP_1000PEPE_USDC'), '1000PEPE');
  assert.equal(orderlyContractBase('PERP_SOL_USDC_mythos'), 'PERP_SOL_USDC_mythos');
  assert.equal(orderlyContractBase('PERP_USDC'), 'PERP_USDC');
  assert.equal(orderlyContractBase('ETHFI_USDC'), 'ETHFI_USDC');
  assert.equal(orderlyContractBase('PERP__USDC'), '');
  assert.equal(orderlyContractBase('ETHFI'), 'ETHFI');
});

test('the policy symbol per venue: Orderly by its base, Hyperliquid and Phoenix by their own name', () => {
  assert.equal(policySymbolOf('orderly', 'PERP_ZRO_USDC'), 'ZRO');
  assert.equal(policySymbolOf('hyperliquid', 'kPEPE'), 'kPEPE');
  assert.equal(policySymbolOf('hyperliquid', 'xyz:GOLD'), 'xyz:GOLD');
  assert.equal(policySymbolOf('phoenix', 'MON'), 'MON');
});

test('regression (mainnet): ZRO, ETHFI and AAVE unpriced cover PERP_ZRO_USDC, PERP_ETHFI_USDC and PERP_AAVE_USDC', () => {
  for (const [base, maxSz] of [['ZRO', '8.2'], ['ETHFI', '25.2'], ['AAVE', '0.11']] as const) {
    const entry = { symbol: base, max_sz: maxSz };
    assert.deepEqual(unpricedEntry(POLICY, 'orderly', `PERP_${base}_USDC`), entry);
    assert.deepEqual(unpricedEntry(POLICY, 'hyperliquid', base), entry);
    assert.deepEqual(legCaps(POLICY, 'orderly', `PERP_${base}_USDC`), { maxNotionalUsd: 15, maxSz });
  }
  // The full Orderly name is never the key: an entry under it covers nothing the contract checks.
  const fullName = { ...POLICY, unpriced: [{ symbol: 'PERP_ETHFI_USDC', max_sz: '25.2' }] };
  assert.equal(unpricedEntry(fullName, 'orderly', 'PERP_ETHFI_USDC'), undefined);
  assert.deepEqual(legCaps(fullName, 'orderly', 'PERP_ETHFI_USDC'), { maxNotionalUsd: 20 });
});

test('Phoenix and Hyperliquid unpriced legs (MON), and a priced symbol on every venue', () => {
  assert.deepEqual(legCaps(POLICY, 'phoenix', 'MON'), { maxNotionalUsd: 15, maxSz: '500' });
  assert.deepEqual(legCaps(POLICY, 'hyperliquid', 'MON'), { maxNotionalUsd: 15, maxSz: '500' });
  assert.deepEqual(legCaps(POLICY, 'orderly', 'PERP_MON_USDC'), { maxNotionalUsd: 15, maxSz: '500' });
  for (const [venue, symbol] of [['hyperliquid', 'ETH'], ['phoenix', 'ETH'], ['orderly', 'PERP_ETH_USDC']] as const) {
    assert.equal(unpricedEntry(POLICY, venue, symbol), undefined);
    assert.deepEqual(legCaps(POLICY, venue, symbol), { maxNotionalUsd: 20 });
  }
  assert.equal(unpricedBySymbol(POLICY, 'MON')?.max_sz, '500');
  assert.equal(unpricedCapUsd({ max_notional_usd: 10, unpriced_max_notional_usd: 15 }), 10, 'both caps apply');
});

test('a pair: priced when any leg is, capped at the smallest leg cap', () => {
  const ethfi = [{ venue: 'hyperliquid', symbol: 'ETHFI' }, { venue: 'orderly', symbol: 'PERP_ETHFI_USDC' }] as const;
  assert.equal(anyLegPriced(POLICY, ethfi), false);
  assert.equal(pairCapUsd(POLICY, ethfi), 15);
  const eth = [{ venue: 'hyperliquid', symbol: 'ETH' }, { venue: 'orderly', symbol: 'PERP_ETH_USDC' }] as const;
  assert.equal(anyLegPriced(POLICY, eth), true);
  assert.equal(pairCapUsd(POLICY, eth), 20);
  // kPEPE listed, Orderly's 1000PEPE not: one leg of each, the unpriced cap binds the pair.
  const mixed = { ...POLICY, unpriced: [{ symbol: 'kPEPE', max_sz: '200000' }] };
  const pepe = [{ venue: 'hyperliquid', symbol: 'kPEPE' }, { venue: 'orderly', symbol: 'PERP_1000PEPE_USDC' }] as const;
  assert.equal(anyLegPriced(mixed, pepe), true);
  assert.equal(pairCapUsd(mixed, pepe), 15);
});
