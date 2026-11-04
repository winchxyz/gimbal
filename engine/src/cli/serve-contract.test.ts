// serve's contract side: which variables turn it on, the policy and prices it reads, the venues holding margin,
// and the HealthMap it publishes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeskState, Leg } from '@gimbal/shared';
import type { NearCallOutcome, NearTransport } from '../contract/near-client.ts';
import { testDesk } from '../relayer/test-helpers.ts';
import { checkContractNetwork, connectContract, contractEnv, healthChanged, healthMap, marginVenues } from './serve-contract.ts';

const KEY = `ed25519:${'3'.repeat(88)}`;
const env = (vars: Record<string, string>) => (name: string) => vars[name];

test('contractEnv: off in replay and without GIMBAL_CONTRACT_ID; names what is missing, never a value', () => {
  assert.equal(contractEnv(env({ GIMBAL_CONTRACT_ID: 'g.testnet' }), 'replay'), null);
  assert.equal(contractEnv(env({ DESK_ID: 'alpha' }), 'testnet'), null);
  assert.throws(() => contractEnv(env({ GIMBAL_CONTRACT_ID: 'g.testnet', OPERATOR_PRIVATE_KEY: KEY }), 'testnet', { signing: true }), (err: unknown) => {
    assert.match(String(err), /DESK_ID, OWNER_ACCOUNT_ID \(or OPERATOR_ACCOUNT_ID\)$/);
    assert.ok(!String(err).includes(KEY));
    return true;
  });
  const all = { GIMBAL_CONTRACT_ID: 'g.testnet', DESK_ID: 'alpha', OWNER_ACCOUNT_ID: 'owner.testnet', OPERATOR_PRIVATE_KEY: KEY };
  assert.deepEqual(contractEnv(env(all), 'testnet', { signing: true }), {
    contractId: 'g.testnet', deskId: 'alpha', network: 'testnet', rpcUrl: undefined, accountId: 'owner.testnet', privateKey: KEY,
  });
  assert.equal(contractEnv(env({ ...all, OPERATOR_ACCOUNT_ID: 'op.testnet' }), 'testnet')?.accountId, 'op.testnet');
  assert.throws(() => contractEnv(env({ ...all, NEAR_NETWORK: 'betanet' }), 'testnet'), /NEAR_NETWORK/);
});

test('contractEnv for serve: views only, so OPERATOR_PRIVATE_KEY is never read, and no account is needed', () => {
  const read: string[] = [];
  const vars: Record<string, string> = { GIMBAL_CONTRACT_ID: 'g.testnet', DESK_ID: 'alpha', OPERATOR_PRIVATE_KEY: KEY };
  const cfg = contractEnv((name) => { read.push(name); return vars[name]; }, 'testnet');
  assert.deepEqual(cfg, { contractId: 'g.testnet', deskId: 'alpha', network: 'testnet', rpcUrl: undefined, accountId: undefined });
  assert.ok(!read.includes('OPERATOR_PRIVATE_KEY'));
});

test('contractEnv: NEAR_NETWORK, the mode and the contract account must name one network', () => {
  const all = { GIMBAL_CONTRACT_ID: 'g.testnet', DESK_ID: 'alpha' };
  assert.throws(() => contractEnv(env({ ...all, NEAR_NETWORK: 'testnet' }), 'mainnet'),
    /NEAR_NETWORK is testnet but the engine runs in mainnet mode \(GIMBAL_MODE\).*Set both to the same network/);
  assert.throws(() => contractEnv(env({ ...all, NEAR_NETWORK: 'mainnet' }), 'testnet'), /NEAR_NETWORK is mainnet/);
  assert.throws(() => contractEnv(env(all), 'mainnet'), /g\.testnet is a testnet account, but the engine runs on mainnet/);
  assert.throws(() => contractEnv(env({ ...all, GIMBAL_CONTRACT_ID: 'gimbal.near' }), 'testnet'), /is a mainnet account/);
  assert.equal(contractEnv(env({ ...all, NEAR_NETWORK: 'testnet' }), 'testnet')?.network, 'testnet');
});

class ViewOnly implements NearTransport {
  readonly accountId = 'owner.testnet';
  views: string[] = [];
  readonly answers: Record<string, unknown>;
  constructor(answers: Record<string, unknown>) {
    this.answers = answers;
  }
  async call(): Promise<NearCallOutcome> {
    throw new Error('serve must not sign');
  }
  async view<T>(_c: string, method: string): Promise<T> {
    this.views.push(method);
    return this.answers[method] as T;
  }
  async account() {
    return { amount: 0n, locked: 0n, storageUsage: 0 };
  }
  async allowance() {
    return null;
  }
}

test('connectContract: the policy from get_desk and the stored prices, by views only', async () => {
  const desk = testDesk();
  const t = new ViewOnly({ config: { network: 'Testnet' }, get_desk: desk, prices: [{ asset: 'ETH', price_e8: '250000000000', at_ms: 5 }] });
  const cfg = { contractId: 'g.testnet', deskId: 'alpha', network: 'testnet' as const, rpcUrl: undefined, accountId: undefined };
  const side = await connectContract(cfg, { transport: t, refreshMs: 60_000 });
  side.prices.stop();
  assert.deepEqual(side.policy, desk.policy);
  assert.deepEqual(side.prices.price('hyperliquid', 'ETH'), { px: 2500, at: 5 });
  assert.deepEqual(t.views.slice(0, 3), ['config', 'get_desk', 'prices']);
  assert.equal(side.builderTenthBps, null, 'config() gave no fees');
  const fees = new ViewOnly({ config: { network: 'Testnet', fees: { hl_builder_tenth_bps: 20 } }, get_desk: desk, prices: [] });
  const withFees = await connectContract(cfg, { transport: fees, refreshMs: 60_000 });
  withFees.prices.stop();
  assert.equal(withFees.builderTenthBps, 20, 'the builder fee the scanner prices (withBuilderFee)');
  const net = { config: { network: 'Testnet' } };
  await assert.rejects(connectContract(cfg, { transport: new ViewOnly({ ...net, get_desk: null }) }), /has no desk alpha/);
  await assert.rejects(connectContract(cfg, { transport: new ViewOnly({ ...net, get_desk: { ...desk, policy: { hl_assets: 'x' } } }) }), /get_desk\(alpha\)\.policy/);
  // A mainnet contract under a testnet engine, or one whose config() does not say: nothing starts, no desk read.
  const mainnet = new ViewOnly({ config: { network: 'Mainnet' }, get_desk: desk });
  await assert.rejects(connectContract(cfg, { transport: mainnet }), /g\.testnet is a mainnet contract \(config\(\)\.network\), but the engine runs on testnet; not starting/);
  assert.deepEqual(mainnet.views, ['config']);
  await assert.rejects(connectContract(cfg, { transport: new ViewOnly({ config: {}, get_desk: desk }) }), /names no network/);
  assert.doesNotThrow(() => checkContractNetwork('g.near', { network: 'Mainnet' }, 'mainnet'));
});

test('margin is held where a leg has margin; health marks the venues a scan missed and NEAR as reported', () => {
  const leg = (venue: Leg['venue'], marginUsd: number) => ({ venue, marginUsd }) as Leg;
  const desk = { legs: [leg('hyperliquid', 120), leg('orderly', 0)] } as DeskState;
  assert.deepEqual([...marginVenues(desk)], ['hyperliquid']);
  assert.deepEqual([...marginVenues(null)], []);
  const h = healthMap({ venues: 3, failed: ['orderly', 'gmx'], at: 1 }, 'slow');
  assert.deepEqual(h, { intents: 'ok', near: 'slow', hyperliquid: 'ok', phoenix: 'ok', orderly: 'down' });
  assert.deepEqual(healthMap(null, 'ok').near, 'ok');
  assert.equal(healthChanged(null, h), true);
  assert.equal(healthChanged(h, { ...h }), false);
  assert.equal(healthChanged(h, { ...h, near: 'down' }), true);
});
