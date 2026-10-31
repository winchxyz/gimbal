// Development only: a fake chain for the Security screen, so every state of the design can be seen without an engine,
// a wallet or a testnet account. It is the onboarding fake world (onboarding/fakes.ts) with a desk made the way the
// page makes one, then given a policy that shows the screen's range. Nothing here is a real address or balance.
// Reached only from `useSecurity` behind `import.meta.env.DEV`, so a production build does not carry it.
import type { ContractPolicy } from '@gimbal/shared';
import type { Chain } from '../onboarding/chain.ts';
import { FakeWorld, FAKE_RECEIVER, fakeEd25519 } from '../onboarding/fakes.ts';
import { OnboardingFlow } from '../onboarding/flow.ts';
import type { NearNetwork } from '../onboarding/wallet.ts';
import { netOf } from './explorer.ts';
import type { SecurityTarget } from './load.ts';

/** A policy with a few of everything: assets on all three exchanges, a rescue budget, no unpriced asset. */
export function fakePolicy(unpriced: boolean): ContractPolicy {
  return {
    hl_assets: [
      { index: 0, symbol: 'BTC', sz_decimals: 5 },
      { index: 1, symbol: 'ETH', sz_decimals: 4 },
      { index: 5, symbol: 'SOL', sz_decimals: 2 },
      { index: 6, symbol: 'AVAX', sz_decimals: 2 },
      { index: 7, symbol: 'LTC', sz_decimals: 2 },
      { index: 12, symbol: 'DOGE', sz_decimals: 0 },
      { index: 34, symbol: 'NEAR', sz_decimals: 1 },
    ],
    phoenix_markets: [
      { symbol: 'SOL', orderbook: fakeEd25519('phoenix sol book').slice('ed25519:'.length), base_lot_e8: 1_000_000, tick_e8: 1_000_000 },
      { symbol: 'DOGE', orderbook: fakeEd25519('phoenix doge book').slice('ed25519:'.length), base_lot_e8: 100_000_000_000, tick_e8: 100_000 },
    ],
    orderly_symbols: ['PERP_BTC_USDC', 'PERP_ETH_USDC', 'PERP_SOL_USDC', 'PERP_NEAR_USDC'],
    max_notional_usd: 1_500,
    price_band_bps: 100,
    oracle_max_age_s: 900,
    rescue_cap_usd_per_hour: 500,
    max_transfer_cost_bps: 100,
    max_transfer_cost_flat_e6: 500_000,
    unpriced: unpriced ? [{ symbol: 'kPEPE', max_sz: '2000000' }] : [],
    unpriced_max_notional_usd: unpriced ? 300 : 0,
  };
}

export interface FakeSecurityOptions {
  /** The desk's owner as the stream names it. */
  owner: string;
  /** A policy with an asset that has no oracle price. */
  unpriced: boolean;
  /** No desk on the contract: the screen's empty state. */
  noDesk: boolean;
}

/** A world with the page's own desk, its operator key and the owner's wallet key, ready to be read. */
export async function fakeSecurityWorld(target: SecurityTarget, options: FakeSecurityOptions): Promise<FakeWorld> {
  const network: NearNetwork = netOf(target.mode);
  const world = new FakeWorld({ network, contractId: target.contractId, account: options.owner });
  if (options.noDesk) return world;

  const flow = new OnboardingFlow(world.deps());
  await flow.connect();
  await flow.setDeskId(target.deskId);
  await flow.createDesk();
  await flow.addEngineKey();
  const desk = world.desks.get(target.deskId);
  if (!desk) throw new Error(`the fake world did not make ${target.deskId}`);
  desk.policy = fakePolicy(options.unpriced);
  desk.orderly_receiver = FAKE_RECEIVER;
  // The owner's wallet: a full-access key beside the engine's restricted one.
  world.keys.set(options.owner, [{ publicKey: fakeEd25519('owner wallet'), permission: 'FullAccess' }, ...(world.keys.get(options.owner) ?? [])]);
  return world;
}

/** `?state=loading|empty|error` and `?sec=unpriced` pick what the fake chain does. */
export async function fakeSecurityChain(target: SecurityTarget & { owner: string }, search: string): Promise<Chain> {
  const params = new URLSearchParams(search);
  const state = params.get('state');
  if (state === 'error') {
    const down = async (): Promise<never> => {
      throw new Error('NEAR RPC did not answer: https://rpc.mainnet.near.org: the request timed out');
    };
    return { view: down, accessKeys: down };
  }
  if (state === 'loading') {
    const never = (): Promise<never> => new Promise(() => undefined);
    return { view: never, accessKeys: never };
  }
  const world = await fakeSecurityWorld(target, { owner: target.owner, unpriced: params.get('sec') === 'unpriced', noDesk: state === 'empty' });
  return world.chain;
}
