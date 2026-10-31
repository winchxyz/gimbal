// What onboarding needs to know that the chain and the engine do not say: which gimbal contract and which USDC token
// this page talks to, the engine's operator public key, and the operator key's allowance. They come from the page's
// environment (`VITE_*` variables, set when the page is built or served); the engine's mode says which network.
import type { Mode } from '@gimbal/shared';
import { DEFAULT_ALLOWANCE_NEAR } from './operator.ts';
import { nearToYocto } from './near.ts';
import type { NearNetwork } from './wallet.ts';

export interface OnboardingConfig {
  network: NearNetwork;
  /** The gimbal contract. Null when none is configured for this network: onboarding says so and goes no further. */
  contractId: string | null;
  /** The USDC token on NEAR the contract accepts in `ft_on_transfer`. Null when none is configured. */
  usdcToken: string | null;
  /** The engine's operator public key, `ed25519:<base58>`, when the page knows it; otherwise the owner pastes it. */
  operatorKey: string | null;
  /** NEAR the operator key may spend on gas over its life. */
  allowanceNear: string;
}

/** The deployed testnet contract (C6, 2026-10-31). Mainnet has none until the canary is deployed. */
export const TESTNET_CONTRACT_ID = 'gimbal-c6-fcf135.testnet';
/** Circle's USDC on NEAR mainnet: the asset 1Click delivers (`NEAR_USDC_ASSET`). */
export const MAINNET_USDC_TOKEN = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

type Env = Record<string, string | undefined>;
const text = (env: Env, name: string): string | null => {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? null : v;
};

/** The wallet's network for an engine mode: replay has none, because a recording has no contract. */
export function networkOf(mode: Mode | null): NearNetwork | null {
  return mode === 'testnet' ? 'testnet' : mode === 'mainnet' ? 'mainnet' : null;
}

export function onboardingConfig(network: NearNetwork, env: Env): OnboardingConfig {
  const allowance = text(env, 'VITE_OPERATOR_ALLOWANCE_NEAR');
  return {
    network,
    contractId: text(env, 'VITE_GIMBAL_CONTRACT') ?? (network === 'testnet' ? TESTNET_CONTRACT_ID : null),
    usdcToken: text(env, 'VITE_USDC_TOKEN') ?? (network === 'mainnet' ? MAINNET_USDC_TOKEN : null),
    operatorKey: text(env, 'VITE_OPERATOR_PUBLIC_KEY'),
    allowanceNear: allowance !== null && nearToYocto(allowance) !== null ? allowance : DEFAULT_ALLOWANCE_NEAR,
  };
}
