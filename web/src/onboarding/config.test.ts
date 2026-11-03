import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAINNET_USDC_TOKEN, networkOf, onboardingConfig, TESTNET_CONTRACT_ID } from './config.ts';
import { DEFAULT_ALLOWANCE_NEAR } from './operator.ts';

test('the engine’s mode picks the network; a replay has no wallet network', () => {
  assert.equal(networkOf('testnet'), 'testnet');
  assert.equal(networkOf('mainnet'), 'mainnet');
  assert.equal(networkOf('replay'), null);
  assert.equal(networkOf(null), null);
});

test('testnet defaults to the deployed contract and leaves the USDC token to the environment', () => {
  const c = onboardingConfig('testnet', {});
  assert.equal(c.contractId, TESTNET_CONTRACT_ID);
  assert.equal(c.usdcToken, null);
  assert.equal(c.operatorKey, null);
  assert.equal(c.allowanceNear, DEFAULT_ALLOWANCE_NEAR);
});

test('mainnet has the real USDC token and no contract until one is configured', () => {
  const c = onboardingConfig('mainnet', {});
  assert.equal(c.contractId, null);
  assert.equal(c.usdcToken, MAINNET_USDC_TOKEN);
});

test('the environment overrides, blanks do not, and a bad allowance falls back to the default', () => {
  const c = onboardingConfig('testnet', {
    VITE_GIMBAL_CONTRACT: ' my.testnet ',
    VITE_USDC_TOKEN: 'usdc.testnet',
    VITE_OPERATOR_PUBLIC_KEY: 'ed25519:abc',
    VITE_OPERATOR_ALLOWANCE_NEAR: '2.5',
  });
  assert.deepEqual(c, { network: 'testnet', contractId: 'my.testnet', usdcToken: 'usdc.testnet', operatorKey: 'ed25519:abc', allowanceNear: '2.5', relayerIps: [] });
  assert.equal(onboardingConfig('testnet', { VITE_GIMBAL_CONTRACT: '  ' }).contractId, TESTNET_CONTRACT_ID);
  assert.equal(onboardingConfig('testnet', { VITE_OPERATOR_ALLOWANCE_NEAR: 'lots' }).allowanceNear, DEFAULT_ALLOWANCE_NEAR);
  assert.equal(onboardingConfig('testnet', { VITE_OPERATOR_ALLOWANCE_NEAR: '0' }).allowanceNear, DEFAULT_ALLOWANCE_NEAR);
});

test('the engine’s IP comes from VITE_RELAYER_IP, canonical; anything that is not an IP leaves it unknown', () => {
  assert.deepEqual(onboardingConfig('mainnet', { VITE_RELAYER_IP: ' 198.51.100.20, 2001:DB8::20 ' }).relayerIps, ['198.51.100.20', '2001:db8::20']);
  assert.deepEqual(onboardingConfig('mainnet', { VITE_RELAYER_IP: '198.51.100.20 engine-host' }).relayerIps, []);
  assert.deepEqual(onboardingConfig('mainnet', {}).relayerIps, []);
});
