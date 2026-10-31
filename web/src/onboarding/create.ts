// Where onboarding gets its parts: the real wallet, chain, engine, 1Click and exchange data for the engine's network.
// The development fake (`?ob=<stage>`) is behind `import.meta.env.DEV` and a dynamic import, so a production build
// does not carry it.
import type { Mode } from '@gimbal/shared';
import { stream } from '../stream/hub.ts';
import { rpcChain } from './chain.ts';
import { networkOf, onboardingConfig } from './config.ts';
import { httpOnboardingEngine } from './engine.ts';
import { OnboardingFlow } from './flow.ts';
import { oneClick } from './intents.ts';
import { hyperliquidData } from './marks.ts';
import { nearWallet } from './near-wallet.ts';

/** The stage a development address asks for, or null: `?ob=rules-draft`. */
export const pickStage = (search: string): string | null => new URLSearchParams(search).get('ob');

export function realFlow(mode: Mode | null): OnboardingFlow | null {
  const network = networkOf(mode);
  if (network === null) return null;
  return new OnboardingFlow({
    wallet: nearWallet(network),
    chain: rpcChain(network),
    engine: httpOnboardingEngine(),
    intents: oneClick(),
    venue: hyperliquidData(network),
    config: onboardingConfig(network, import.meta.env),
    // The engine's `setup` events arrive on the page's one stream.
    setupFeed: { get: () => stream.getState().setup, subscribe: (listener) => stream.subscribe(listener) },
  });
}

/** The fake world at a stage, for the design check and for working on the page without an engine or a wallet. */
export async function devFlow(stage: string, search: string): Promise<OnboardingFlow> {
  // The build replaces DEV with false, so this branch and the fake behind it are not in a production bundle.
  if (import.meta.env.DEV) {
    const { presetFlow } = await import('./dev.ts');
    return presetFlow(stage, new URLSearchParams(search).get('net') === 'mainnet' ? 'mainnet' : 'testnet');
  }
  throw new Error('the development fake is not part of a production build');
}
