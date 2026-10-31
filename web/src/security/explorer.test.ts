import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arbiscanUrl, hyperliquidUrl, nearUrl, netOf, shortAddress, solscanUrl } from './explorer.ts';

const EVM = '0x5e1d7a03c09a4f8e2b6d0a91c3f7e48b2d65c09a';
const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

test('a replay and a live mainnet desk link the mainnet explorers; only testnet links the testnet ones', () => {
  assert.equal(netOf('replay'), 'mainnet');
  assert.equal(netOf('mainnet'), 'mainnet');
  assert.equal(netOf('testnet'), 'testnet');
});

test('NEAR accounts open on nearblocks', () => {
  assert.equal(nearUrl('gimbal.near', 'mainnet'), 'https://nearblocks.io/address/gimbal.near');
  assert.equal(nearUrl('gimbal-c6-fcf135.testnet', 'testnet'), 'https://testnet.nearblocks.io/address/gimbal-c6-fcf135.testnet');
});

test('Hyperliquid addresses open on the exchange’s own explorer', () => {
  assert.equal(hyperliquidUrl(EVM, 'mainnet'), `https://app.hyperliquid.xyz/explorer/address/${EVM}`);
  assert.equal(hyperliquidUrl(EVM, 'testnet'), `https://app.hyperliquid-testnet.xyz/explorer/address/${EVM}`);
});

test('Solana accounts open on Solscan, the testnet desk on devnet', () => {
  assert.equal(solscanUrl(SOL, 'mainnet'), `https://solscan.io/account/${SOL}`);
  assert.equal(solscanUrl(SOL, 'testnet'), `https://solscan.io/account/${SOL}?cluster=devnet`);
});

test('Arbitrum addresses open on Arbiscan, the testnet desk on Sepolia', () => {
  assert.equal(arbiscanUrl(EVM, 'mainnet'), `https://arbiscan.io/address/${EVM}`);
  assert.equal(arbiscanUrl(EVM, 'testnet'), `https://sepolia.arbiscan.io/address/${EVM}`);
});

test('an address that is not the shape of its chain gets no link rather than a page that says "not found"', () => {
  assert.equal(nearUrl('', 'mainnet'), null);
  assert.equal(nearUrl('Not An Account', 'mainnet'), null);
  assert.equal(hyperliquidUrl('0x1234', 'mainnet'), null);
  assert.equal(hyperliquidUrl(SOL, 'mainnet'), null);
  assert.equal(arbiscanUrl('not-hex', 'testnet'), null);
  assert.equal(solscanUrl(EVM, 'mainnet'), null, '0x… has characters a base58 string never has');
  assert.equal(solscanUrl('short', 'mainnet'), null);
});

test('a phone row shows the head and the tail of an address', () => {
  assert.equal(shortAddress(EVM), '0x5e1d…c09a');
  assert.equal(shortAddress('short'), 'short');
});
