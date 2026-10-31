import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContractPolicy } from '@gimbal/shared';
import { fakePolicy } from './dev.ts';
import { ageWords, bpsPct, builderFeeText, feeLines, fullAccessText, groupDecimal, hourlyCostBudgetUsd, oracleTrust, policyLines, readFailureText, trimmed } from './words.ts';

const OWNER = 'ada.testnet';
const text = (p: ContractPolicy): string[] => policyLines(p, OWNER).map((l) => l.text);

test('numbers read without trailing zeros', () => {
  assert.equal(trimmed(1), '1');
  assert.equal(trimmed(0.5), '0.5');
  assert.equal(trimmed(1.2500001), '1.25');
  assert.equal(bpsPct(100), '1%');
  assert.equal(bpsPct(50), '0.5%');
  assert.equal(bpsPct(1000), '10%');
  assert.equal(bpsPct(1), '0.01%');
});

test('seconds read the way an owner says them', () => {
  assert.equal(ageWords(900), '15 minutes');
  assert.equal(ageWords(60), '1 minute');
  assert.equal(ageWords(45), '45 seconds');
  assert.equal(ageWords(1), '1 second');
  assert.equal(ageWords(3600), '1 hour');
  assert.equal(ageWords(7200), '2 hours');
  assert.equal(ageWords(90), '90 seconds', 'not a whole number of minutes: said in seconds');
});

test('a canonical decimal keeps its fraction as written; only the whole part is grouped', () => {
  assert.equal(groupDecimal('2000000'), '2,000,000');
  assert.equal(groupDecimal('999'), '999');
  assert.equal(groupDecimal('1234.50'), '1,234.50');
  assert.equal(groupDecimal('0.000123'), '0.000123');
});

test('the policy in words: assets per exchange, size, band, age, rescue, cost, payout', () => {
  const lines = text(fakePolicy(false));
  assert.deepEqual(lines, [
    'Hyperliquid: BTC, ETH, SOL, AVAX, LTC, DOGE, NEAR',
    'Phoenix: SOL, DOGE',
    'Orderly: BTC, ETH, SOL, NEAR',
    'Each leg up to $1,500',
    'Orders within 1% of the oracle price',
    'Oracle price no older than 15 minutes',
    'Margin moves out of an exchange: up to $500 an hour',
    'A move may cost at most 1% of its amount, or $0.50 if that is more; $5.00 an hour in all',
    'No assets without a trusted price',
    'Money out only to ada.testnet',
  ]);
});

test('the hourly cost budget is the larger of the share of the cap and twice the flat part', () => {
  const p = fakePolicy(false);
  assert.equal(hourlyCostBudgetUsd(p), 5, '500 × 1% = 5 beats 2 × 0.5 = 1');
  assert.equal(hourlyCostBudgetUsd({ ...p, rescue_cap_usd_per_hour: 50 }), 1, '50 × 1% = 0.5 loses to 2 × 0.5 = 1');
});

test('an unpriced asset is in the watch tone with its size, and its cap is the smaller of the two caps', () => {
  const lines = policyLines(fakePolicy(true), OWNER);
  const line = lines.find((l) => l.key === 'unpriced-kPEPE');
  assert.ok(line);
  assert.equal(line.tone, 'watch');
  assert.equal(line.text, 'kPEPE has no price protection: up to 2,000,000 kPEPE, and no more than $300 a leg');
  assert.equal(lines.filter((l) => l.tone === 'watch').length, 1, 'nothing else is in the watch tone');
});

test('an unpriced cap larger than the leg size does not raise the leg size', () => {
  const p: ContractPolicy = { ...fakePolicy(true), unpriced_max_notional_usd: 10_000 };
  assert.match(text(p).join('\n'), /no more than \$1,500 a leg/);
});

test('an unpriced asset with a cap of zero says that no order can pass', () => {
  const p: ContractPolicy = { ...fakePolicy(true), unpriced_max_notional_usd: 0 };
  assert.match(text(p).join('\n'), /kPEPE has no price protection, and its cap is \$0, so no order can pass/);
});

test('a policy that allows nothing says so rather than printing an empty list', () => {
  const p: ContractPolicy = {
    ...fakePolicy(false),
    hl_assets: [],
    phoenix_markets: [],
    orderly_symbols: [],
    max_notional_usd: 0,
    rescue_cap_usd_per_hour: 0,
  };
  const lines = text(p);
  assert.ok(lines.includes('Hyperliquid: nothing allowed'));
  assert.ok(lines.includes('Phoenix: nothing allowed'));
  assert.ok(lines.includes('Orderly: nothing allowed'));
  assert.ok(lines.includes('No leg size is allowed: every order is refused'));
  assert.ok(lines.includes('No margin moves out of an exchange are allowed'));
  assert.equal(lines.filter((l) => l.startsWith('A move may cost')).length, 0, 'no cost line when nothing may move');
});

test('leverage and the minimum APR are engine rules: the contract policy lines never mention them', () => {
  assert.doesNotMatch(text(fakePolicy(true)).join('\n'), /leverage|APR/i);
});

test('the oracle line is built from the same two numbers the policy sets', () => {
  assert.equal(oracleTrust(fakePolicy(false)), 'The oracle price, within the 1% band and 15 minutes age');
});

test('the owner’s full-access keys are counted in a sentence, none included', () => {
  assert.equal(fullAccessText('ada.near', 1), 'ada.near has 1 full-access key; whoever holds it can call everything.');
  assert.equal(fullAccessText('ada.near', 2), 'ada.near has 2 full-access keys; whoever holds them can call everything.');
  assert.equal(fullAccessText('ada.near', 0), 'ada.near has no full-access key, so nobody can call the owner-only methods.');
});

test('the error state says what failed: a down RPC, or a contract that is wrong', () => {
  assert.equal(
    readFailureText('NEAR RPC did not answer: https://rpc.mainnet.near.org: the request timed out', '21:00'),
    'The NEAR RPC didn’t answer at 21:00 UTC (https://rpc.mainnet.near.org: the request timed out).',
  );
  assert.equal(readFailureText('NEAR RPC did not answer', '21:00'), 'The NEAR RPC didn’t answer at 21:00 UTC.');
  assert.equal(
    readFailureText('gimbal.near runs on Mainnet, but the engine is on testnet', '21:00'),
    'The contract could not be read at 21:00 UTC (gimbal.near runs on Mainnet, but the engine is on testnet).',
  );
});

test('fees in plain words: the builder fee is in tenths of a basis point', () => {
  assert.equal(builderFeeText(10), '1 bp (0.01%)');
  assert.equal(builderFeeText(5), '0.5 bp (0.005%)');
  assert.deepEqual(feeLines({ performanceBps: 1000, hlBuilderTenthBps: 10 }), [
    '10% of the profit above your high-water mark, taken when you withdraw',
    '1 bp (0.01%) of every Hyperliquid fill, as the builder fee',
    'Nothing on deposits, rescues or losses',
  ]);
  assert.equal(feeLines({ performanceBps: 0, hlBuilderTenthBps: 10 })[0], 'No performance fee');
});
