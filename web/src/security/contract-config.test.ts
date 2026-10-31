import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './contract-config.ts';

const MAINNET = {
  network: 'Mainnet',
  mpc: 'v1.signer',
  price_source: { OutLayer: { contract: 'price-oracle.near' } },
  treasury: { near: 'treasury.near', hl_builder: '0x0000000000000000000000000000000000b1de00', referral_codes: { hyperliquid: null, orderly: null, phoenix: null } },
  fees: { performance_bps: 1000, hl_builder_tenth_bps: 10 },
  orderly: { broker_id: 'gimbal_dex', chain_id: 42161 },
};

test('a mainnet config: the MPC contract, the OutLayer oracle, the treasury and the fees', () => {
  assert.deepEqual(parseConfig(MAINNET), {
    network: 'Mainnet',
    mpc: 'v1.signer',
    oracle: { kind: 'outlayer', contract: 'price-oracle.near' },
    treasury: 'treasury.near',
    fees: { performanceBps: 1000, hlBuilderTenthBps: 10 },
  });
});

test('a testnet config with owner-set prices reads as a mock oracle', () => {
  const config = parseConfig({ ...MAINNET, network: 'Testnet', mpc: 'v1.signer-prod.testnet', price_source: 'Mock' });
  assert.equal(config.network, 'Testnet');
  assert.deepEqual(config.oracle, { kind: 'mock' });
});

test('an answer that is not a gimbal config is refused with what is wrong', () => {
  assert.throws(() => parseConfig(null), /not an object/);
  assert.throws(() => parseConfig([]), /not an object/);
  assert.throws(() => parseConfig({ ...MAINNET, network: 'Localnet' }), /neither Mainnet nor Testnet/);
  assert.throws(() => parseConfig({ ...MAINNET, mpc: '' }), /mpc is not text/);
  assert.throws(() => parseConfig({ ...MAINNET, price_source: 'Pyth' }), /price_source/);
  assert.throws(() => parseConfig({ ...MAINNET, price_source: { OutLayer: {} } }), /OutLayer\.contract/);
  assert.throws(() => parseConfig({ ...MAINNET, treasury: undefined }), /no treasury/);
  assert.throws(() => parseConfig({ ...MAINNET, treasury: { near: 3 } }), /treasury\.near/);
  assert.throws(() => parseConfig({ ...MAINNET, fees: undefined }), /no fees/);
  assert.throws(() => parseConfig({ ...MAINNET, fees: { performance_bps: -1, hl_builder_tenth_bps: 10 } }), /performance_bps/);
  assert.throws(() => parseConfig({ ...MAINNET, fees: { performance_bps: 10, hl_builder_tenth_bps: 1.5 } }), /hl_builder_tenth_bps/);
});
