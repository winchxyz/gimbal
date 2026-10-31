import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry, TxRef } from '@gimbal/shared';
import { amountUsd, clock, contractUrl, externalUrl, feeUsd, isAccountId, numberOf, proofLinks, shortId, unprotectedText } from './entry.ts';

const entry = (numbers: JournalEntry['numbers']): Pick<JournalEntry, 'numbers'> => ({ numbers });

test('numbers are read as numbers, from a number or from text that is one, and anything else is absent', () => {
  assert.equal(amountUsd(entry({ usd: -1.47 })), -1.47);
  assert.equal(amountUsd(entry({ usd: '1050.00' })), 1050);
  assert.equal(amountUsd(entry({ usd: ' -0.31 ' })), -0.31);
  assert.equal(amountUsd(entry({ usd: 'lots' })), null);
  assert.equal(amountUsd(entry({ usd: '' })), null);
  assert.equal(amountUsd(entry({ usd: Number.NaN })), null);
  assert.equal(amountUsd(entry({ usd: Number.POSITIVE_INFINITY })), null);
  assert.equal(amountUsd(entry({})), null);
  assert.equal(feeUsd(entry({ feeUsd: -0.14 })), -0.14);
  assert.equal(numberOf(entry({ signedS: 6.1 }), 'signedS'), 6.1);
});

test('an order without the price band is flagged, and names its venue when it can', () => {
  assert.equal(unprotectedText(entry({ unpriced: 1, venue: 'phoenix' })), 'Phoenix leg sent without price protection');
  assert.equal(unprotectedText(entry({ unpriced: '1' })), 'Sent without price protection');
  assert.equal(unprotectedText(entry({ unpriced: 'true', venue: '' })), 'Sent without price protection');
  assert.equal(unprotectedText(entry({ unpriced: 0 })), null);
  assert.equal(unprotectedText(entry({})), null);
});

test('the time of day is UTC with two digits each', () => {
  assert.equal(clock(Date.UTC(2026, 9, 27, 14, 0)), '14:00');
  assert.equal(clock(Date.UTC(2026, 9, 27, 0, 5)), '00:05');
  assert.equal(clock(Date.UTC(2026, 9, 27, 23, 59, 59)), '23:59');
});

test('a hash is cut to what tells two apart, and a short one is left whole', () => {
  assert.equal(shortId('9xQeBnP2c8vT3yUw5aZ7Rk1LmN4oHsD6fGjXe9VtYq4Ta1'), '9xQe…4Ta1');
  assert.equal(shortId('0x88b2e1c57d09aa3f14d0'), '0x88b2…14d0');
  assert.equal(shortId('abc123'), 'abc123');
  assert.equal(shortId('0x1234abcd'), '0x1234abcd');
  assert.equal(shortId(''), '');
});

test('only web addresses open: anything else from the engine is dropped', () => {
  assert.equal(externalUrl('https://nearblocks.io/txns/abc'), 'https://nearblocks.io/txns/abc');
  assert.equal(externalUrl('http://localhost:3000/tx/1'), 'http://localhost:3000/tx/1');
  assert.equal(externalUrl('javascript:alert(1)'), null);
  assert.equal(externalUrl('data:text/html,<b>x</b>'), null);
  assert.equal(externalUrl('/relative/path'), null);
  assert.equal(externalUrl(''), null);
});

test('a link is built from the transaction’s own url; the chain only picks the word', () => {
  const tx: TxRef[] = [
    { chain: 'near', id: 'Jd5cLongNearHashw2Lp', url: 'https://nearblocks.io/txns/Jd5cLongNearHashw2Lp' },
    { chain: 'hyperliquid', id: '0x88b2e1c57d09aa3f14d0', url: 'https://app.hyperliquid.xyz/explorer/tx/0x88b2e1c57d09aa3f14d0' },
    { chain: 'solana', id: '2rTqSolanaSignaturekF8m', url: 'https://solscan.io/tx/2rTqSolanaSignaturekF8m' },
    { chain: 'arbitrum', id: '0xabc', url: 'https://arbiscan.io/tx/0xabc' },
    { chain: 'near', id: 'bad', url: 'javascript:void(0)' },
  ];
  const links = proofLinks(tx);
  assert.deepEqual(links.map((l) => [l.chain, l.label, l.short, l.href]), [
    ['near', 'NEAR', 'Jd5c…w2Lp', 'https://nearblocks.io/txns/Jd5cLongNearHashw2Lp'],
    ['hyperliquid', 'Hyperliquid', '0x88b2…14d0', 'https://app.hyperliquid.xyz/explorer/tx/0x88b2e1c57d09aa3f14d0'],
    ['solana', 'Solscan', '2rTq…kF8m', 'https://solscan.io/tx/2rTqSolanaSignaturekF8m'],
    ['arbitrum', 'Arbiscan', '0xabc', 'https://arbiscan.io/tx/0xabc'],
  ]);
  assert.deepEqual(proofLinks([]), []);
});

// The repo's own testnet contract: the tests build addresses from it and never name an account that is not ours.
const CONTRACT = 'gimbal-fcf135.testnet';

test('the contract’s page opens on the explorer of its network, and a replay plays mainnet', () => {
  assert.equal(contractUrl(CONTRACT, 'testnet'), `https://testnet.nearblocks.io/address/${CONTRACT}`);
  assert.equal(contractUrl(CONTRACT, 'mainnet'), `https://nearblocks.io/address/${CONTRACT}`);
  assert.equal(contractUrl(CONTRACT, 'replay'), `https://nearblocks.io/address/${CONTRACT}`);
});

test('a name that is not an account id gets no explorer link, so a fake never points at a real account', () => {
  for (const label of ['Demo contract (fake)', '(test contract)', 'Gimbal', '', 'a', '.near', 'near.', 'a..near', '-a.near', 'a.near/x']) {
    assert.equal(isAccountId(label), false, label);
    assert.equal(contractUrl(label, 'mainnet'), null, label);
  }
  for (const id of [CONTRACT, 'ab', 'a-b_c.d1.near', '0'.repeat(64)]) assert.equal(isAccountId(id), true, id);
  assert.equal(isAccountId('a'.repeat(65)), false);
});
