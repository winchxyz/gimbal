// The confirmed engine rules on disk: one file per mode and desk, written whole, read back only when they still pass.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ContractPolicy, StrategyConfig } from '@gimbal/shared';
import { DEFAULT_STRATEGY } from './scanner/config.ts';
import { StrategyStore, strategyFile } from './strategy-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'gimbal-store-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const POLICY: ContractPolicy = {
  hl_assets: [], phoenix_markets: [], orderly_symbols: [], max_notional_usd: 500, price_band_bps: 100, oracle_max_age_s: 60,
  rescue_cap_usd_per_hour: 0, unpriced: [], unpriced_max_notional_usd: 0, max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 0,
};

test('one file per mode and desk; a desk id that is not a desk id is refused', () => {
  assert.equal(strategyFile(dir, 'mainnet', 'alpha-1'), join(dir, 'strategy-mainnet-alpha-1.json'));
  assert.equal(strategyFile(dir, 'replay', null), join(dir, 'strategy-replay.json'));
  assert.throws(() => strategyFile(dir, 'testnet', '../etc'), /is not \[a-z0-9-\]\{1,32\}/);
});

test('no file yet: nothing to load and nothing wrong; a save is read back, and a second save replaces it whole', async () => {
  const store = new StrategyStore(join(dir, 'nested', 'strategy-testnet-alpha.json'));
  assert.deepEqual(store.load(POLICY), { strategy: null, problem: null });
  const first: StrategyConfig = { ...DEFAULT_STRATEGY, legUsd: 400 };
  const second: StrategyConfig = { ...DEFAULT_STRATEGY, legUsd: 300, auto: true, stopDrawdownPct: null };
  await Promise.all([store.save(first), store.save(second)]);
  assert.deepEqual(store.load(POLICY), { strategy: second, problem: null });
  // Only the file itself is left: no temporary files.
  assert.deepEqual(readdirSync(join(dir, 'nested')), ['strategy-testnet-alpha.json']);
});

test('a file that does not parse, or no longer fits the policy, is not used, and says why', async () => {
  const broken = join(dir, 'strategy-mainnet-broken.json');
  writeFileSync(broken, '{"auto": tru');
  const a = new StrategyStore(broken).load(POLICY);
  assert.equal(a.strategy, null);
  assert.match(a.problem!, /strategy-mainnet-broken\.json: /);

  const store = new StrategyStore(join(dir, 'strategy-mainnet-capped.json'));
  await store.save({ ...DEFAULT_STRATEGY, legUsd: 1000 });
  // The owner lowered the policy cap to 500 since: a 1000 USD leg would be refused by the contract.
  const b = store.load(POLICY);
  assert.equal(b.strategy, null);
  assert.match(b.problem!, /legUsd 1000 is over the policy cap of 500 USD per leg/);
  // Without a policy the same file is fine.
  assert.equal(store.load(null).strategy!.legUsd, 1000);
});
