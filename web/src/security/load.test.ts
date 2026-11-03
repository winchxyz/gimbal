import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chain } from '../onboarding/chain.ts';
import { fakeSecurityWorld } from './dev.ts';
import { loadSecurity, type SecurityTarget } from './load.ts';
import { readKeys } from './keys.ts';

const OWNER = 'ada.testnet';
const TARGET: SecurityTarget = { contractId: 'gimbal-c6-fcf135.testnet', deskId: 'main', mode: 'testnet' };

test('a desk is read in full: the config, the desk with its policy, and the owner’s keys', async () => {
  const world = await fakeSecurityWorld(TARGET, { owner: OWNER, unpriced: false, noDesk: false });
  const data = await loadSecurity(world.chain, TARGET, 1_000);
  assert.ok(data);
  assert.equal(data.at, 1_000);
  assert.equal(data.config.network, 'Testnet');
  assert.equal(data.config.mpc, world.mpc);
  assert.equal(data.desk.owner, OWNER);
  assert.equal(data.desk.policy.max_notional_usd, 1_500);
  assert.match(data.desk.evm_address, /^0x[0-9a-f]{40}$/);

  const read = readKeys(data.keys, TARGET.contractId);
  assert.equal(read.keys.length, 1, 'the engine’s operator key');
  assert.equal(read.fullAccess, 1, 'the owner’s wallet');
  assert.equal(read.keys[0]!.methods.length, 21);
});

test('a contract with no such desk is "no desk", not an error, and the owner’s keys are not read', async () => {
  const world = await fakeSecurityWorld(TARGET, { owner: OWNER, unpriced: false, noDesk: true });
  let keysRead = 0;
  const chain: Chain = {
    view: (...args) => world.chain.view(...args),
    accessKeys: (account) => {
      keysRead += 1;
      return world.chain.accessKeys(account);
    },
  };
  assert.equal(await loadSecurity(chain, TARGET), null);
  assert.equal(keysRead, 0);
});

test('a contract on the other network is refused, saying which is which', async () => {
  const world = await fakeSecurityWorld(TARGET, { owner: OWNER, unpriced: false, noDesk: false });
  await assert.rejects(loadSecurity(world.chain, { ...TARGET, mode: 'mainnet' }), /runs on Testnet, but the engine is on mainnet/);
});

test('an RPC that fails is an error with its own words', async () => {
  const down: Chain = {
    view: async () => {
      throw new Error('NEAR RPC did not answer: timed out');
    },
    accessKeys: async () => [],
  };
  await assert.rejects(loadSecurity(down, TARGET), /did not answer/);
});

test('a contract that does not answer like a gimbal contract is refused, not drawn', async () => {
  const world = await fakeSecurityWorld(TARGET, { owner: OWNER, unpriced: false, noDesk: false });
  const odd: Chain = { view: async () => ({ hello: 'world' }), accessKeys: world.chain.accessKeys };
  await assert.rejects(loadSecurity(odd, TARGET), /config\(\)/);
});

test('a desk whose policy is not a policy is refused rather than drawn half-way', async () => {
  const world = await fakeSecurityWorld(TARGET, { owner: OWNER, unpriced: false, noDesk: false });
  const desk = world.desks.get(TARGET.deskId);
  assert.ok(desk);
  (desk as { policy: unknown }).policy = { hl_assets: 'BTC' };
  await assert.rejects(loadSecurity(world.chain, TARGET));
});
