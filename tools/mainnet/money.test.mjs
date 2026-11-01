import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TGAS, FUND_TGAS, WITHDRAW_TGAS, eventsOf, expectedPayout, ledgerOf, parseUsdc, usdcText } from './money.mjs';

const USDC = 1_000_000n;
const BPS = 1000;

test('USDC amounts: up to 6 decimals, above 0; printed without trailing zeros', () => {
  assert.equal(parseUsdc('12.5'), 12_500_000n);
  assert.equal(parseUsdc('30'), 30n * USDC);
  assert.equal(parseUsdc('0.000001'), 1n);
  for (const bad of ['0', '0.0', '-1', '1.0000001', '1e3', '', ' 1', '.5', undefined]) assert.throws(() => parseUsdc(bad), /not a USDC amount|above 0/, String(bad));
  assert.equal(usdcText(12_500_000n), '12.5');
  assert.equal(usdcText(30n * USDC), '30');
  assert.equal(usdcText(-519_049n), '-0.519049');
  assert.equal(usdcText(0n), '0');
});

test('the gas the scripts attach is over the C8 contract\'s floors', () => {
  assert.deepEqual(MIN_TGAS, { refresh_prices: 240, fund_venue: 115, withdraw_to_owner: 150, create_desk: 64 });
  assert.ok(FUND_TGAS >= BigInt(MIN_TGAS.fund_venue));
  assert.ok(WITHDRAW_TGAS >= BigInt(MIN_TGAS.withdraw_to_owner));
  assert.ok(FUND_TGAS <= 300n && WITHDRAW_TGAS <= 300n, 'NEAR caps a transaction at 300 TGas');
});

/** Books of contract/core/src/fees.rs, as the tests there drive them. */
function books() {
  const b = { deposited: 0n, withdrawn: 0n, fees_paid: 0n, hwm: 0n, idle_usdc: 0n };
  return {
    b,
    principal(v) { b.deposited += v; b.idle_usdc += v; },
    back(v) { b.idle_usdc += v; },
    pay(v) {
      assert.ok(v <= b.idle_usdc);
      const p = expectedPayout(b, v, BPS);
      b.idle_usdc -= p.amount;
      b.withdrawn += p.amount;
      b.fees_paid += p.fee;
      b.hwm = p.hwmAfter;
      return p.fee;
    },
  };
}

test('the payout port gives fees.rs\'s answers: the high-water mark across profit, loss, recovery and new profit', () => {
  const k = books();
  k.principal(100n * USDC);
  k.b.idle_usdc = 0n;
  k.back(110n * USDC);
  assert.equal(k.pay(110n * USDC), USDC);
  assert.deepEqual([k.b.withdrawn, k.b.fees_paid, k.b.hwm], [110n * USDC, USDC, 10n * USDC]);
  k.principal(100n * USDC);
  k.b.idle_usdc = 0n;
  k.back(80n * USDC);
  assert.equal(k.pay(80n * USDC), 0n);
  assert.equal(k.b.hwm, 10n * USDC, 'a loss leaves the mark');
  assert.equal(expectedPayout(k.b, 0n, BPS).profit, -10n * USDC);
  k.principal(100n * USDC);
  k.b.idle_usdc = 0n;
  k.back(120n * USDC);
  assert.equal(k.pay(120n * USDC), 0n);
  k.principal(100n * USDC);
  k.b.idle_usdc = 0n;
  k.back(105n * USDC);
  assert.equal(k.pay(105n * USDC), USDC / 2n);
  assert.equal(k.b.hwm, 15n * USDC);
  assert.equal(k.b.fees_paid, USDC + USDC / 2n);
});

test('the payout port: partial payouts, returns, the principal back, rounding to the owner', () => {
  const k = books();
  k.principal(100n * USDC);
  k.back(20n * USDC);
  assert.equal(k.pay(60n * USDC), 0n);
  assert.equal(k.pay(40n * USDC), 0n, 'exactly the principal back');
  assert.equal(k.pay(20n * USDC), 2n * USDC);
  assert.equal(k.b.hwm, 20n * USDC);

  const r = books();
  r.principal(50n * USDC);
  r.back(7n * USDC);
  assert.equal(r.pay(57n * USDC), 700_000n, 'a return counts as profit when paid out');

  const free = books();
  free.principal(100n * USDC);
  for (let i = 0; i < 4; i++) assert.equal(free.pay(25n * USDC), 0n);

  const split = books();
  split.principal(1n);
  split.back(19n);
  assert.equal(expectedPayout(split.b, 20n, BPS).fee, 1n);
  let total = 0n;
  for (let i = 0; i < 20; i++) total += split.pay(1n);
  assert.equal(total, 1n);
  assert.equal(split.b.hwm, 19n);

  const e = books();
  e.principal(100n);
  e.back(20n);
  assert.equal(e.pay(115n), 1n);
  assert.equal(e.pay(5n), 1n);
  const c = books();
  c.back(10n);
  assert.equal(expectedPayout(c.b, 10n, 3333).fee, 3n);
  assert.equal(expectedPayout(c.b, 10n, 10_000).fee, 10n);
  assert.equal(expectedPayout(c.b, 4n, 10_000).fee, 4n);
  assert.equal(expectedPayout(c.b, 10n, 0).fee, 0n);
});

test('a canary withdrawal with no profit pays no fee', () => {
  const l = ledgerOf({ ledger: { deposited: 30_000_000, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 18_000_000 } });
  const p = expectedPayout(l, 5n * USDC, BPS);
  assert.deepEqual(p, { amount: 5n * USDC, fee: 0n, toOwner: 5n * USDC, profit: -25n * USDC, hwmBefore: 0n, hwmAfter: 0n });
  assert.deepEqual(ledgerOf(null), { deposited: 0n, withdrawn: 0n, fees_paid: 0n, hwm: 0n, idle_usdc: 0n });
});

test('events: only the contract\'s NEP-297 standard, each data entry on its own', () => {
  const logs = [
    'plain log',
    'EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"payout","data":[{"desk_id":"c","amount":"5000000"}]}',
    'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"amount":"1"}]}',
    'EVENT_JSON:{"standard":"gimbal","event":"fee_charged","data":[{"fee":"0"},{"fee":"1"}]}',
    'EVENT_JSON:not json',
  ];
  assert.deepEqual(eventsOf(logs), [
    { event: 'payout', data: { desk_id: 'c', amount: '5000000' } },
    { event: 'fee_charged', data: { fee: '0' } },
    { event: 'fee_charged', data: { fee: '1' } },
  ]);
  assert.deepEqual(eventsOf(undefined), []);
});
