// The signature budget: at most min(spendable, allowance) / 0.3 NEAR calls in flight, a wait when the slots are
// taken, and a 'down' health event plus SignatureBudgetError when not even one call fits.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignatureBudget, YOCTO_PER_NEAR, formatNear, reserveFor, spendable } from './budget.ts';
import { SignatureBudgetError } from './types.ts';

const near = (n: number): bigint => BigInt(Math.round(n * 1000)) * (YOCTO_PER_NEAR / 1000n);

function reads(state: { amount: bigint; allowance: bigint | null; storage?: number }) {
  return {
    account: async () => ({ amount: state.amount, locked: 0n, storageUsage: state.storage ?? 0 }),
    allowance: async () => state.allowance,
  };
}

const instant = { sleep: () => new Promise<void>((r) => setImmediate(r)), pollMs: 0 };

test('a 300 TGas call reserves 0.3 NEAR; storage staking is not spendable', () => {
  assert.equal(reserveFor(300), near(0.3));
  assert.equal(spendable({ amount: near(1), locked: 0n, storageUsage: 10_000 }), near(0.9));
  assert.equal(spendable({ amount: near(1), locked: near(1), storageUsage: 10_000 }), near(1));
  assert.equal(spendable({ amount: near(0.05), locked: 0n, storageUsage: 10_000 }), 0n);
  assert.equal(formatNear(near(4.7)), '4.700 NEAR');
});

test('admits calls while both the balance and the allowance cover them, then makes the next one wait', async () => {
  const state = { amount: near(10), allowance: near(1) as bigint | null };
  let releasedWaiter = false;
  const budget = new SignatureBudget({ reads: reads(state), ...instant, maxWaitMs: 60_000 });
  const a = await budget.acquire();
  const b = await budget.acquire();
  const c = await budget.acquire();
  assert.equal(budget.inFlight, 3);               // 0.9 of a 1 NEAR allowance
  const waiting = budget.acquire().then((release) => {
    releasedWaiter = true;
    return release;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(releasedWaiter, false);
  a();
  const d = await waiting;
  assert.equal(releasedWaiter, true);
  for (const release of [b, c, d]) release();
  assert.equal(budget.inFlight, 0);
  // A FunctionCall key without an allowance limit is bounded by the balance alone.
  state.allowance = null;
  state.amount = near(0.6);
  const e = await budget.acquire();
  const f = await budget.acquire();
  assert.equal(budget.inFlight, 2);
  e();
  f();
});

test('below one call with nothing in flight it raises down and stops; a top-up brings it back', async () => {
  const state = { amount: near(5), allowance: near(0.29) as bigint | null };
  const health: string[] = [];
  const budget = new SignatureBudget({ reads: reads(state), ...instant, onHealth: (s, d) => health.push(`${s}: ${d}`) });
  await assert.rejects(budget.acquire(), (err: unknown) => {
    assert.ok(err instanceof SignatureBudgetError);
    assert.match(String(err.message), /cannot pay for one more signature \(0\.300 NEAR each\).*allowance 0\.290 NEAR/);
    return true;
  });
  assert.equal(health.length, 1);
  assert.match(health[0]!, /^down: /);
  state.allowance = near(2);
  const release = await budget.acquire();
  assert.match(health[1]!, /^ok: operator key can pay for signatures again/);
  release();
});

test('a call that waits too long for a slot gives up with the reason', async () => {
  let t = 0;
  const state = { amount: near(0.3), allowance: near(5) as bigint | null };
  const budget = new SignatureBudget({ reads: reads(state), sleep: async () => { t += 1_000; }, pollMs: 1, maxWaitMs: 5_000, now: () => t });
  const held = await budget.acquire();
  await assert.rejects(budget.acquire(), /waited \d+ s for a signature slot/);
  held();
});

test('with nothing in flight it reads once more before down: a refund still pending does not trip it', async () => {
  let reads = 0;
  const health: string[] = [];
  const budget = new SignatureBudget({
    reads: {
      account: async () => ({ amount: near(5), locked: 0n, storageUsage: 0 }),
      // The last call's 0.3 NEAR is still held on the first read; the refund shows on the second.
      allowance: async () => (++reads === 1 ? near(0.2) : near(0.5)),
    },
    ...instant, onHealth: (s) => health.push(s),
  });
  const release = await budget.acquire();
  assert.equal(reads, 2);
  assert.deepEqual(health, []);
  release();
});
