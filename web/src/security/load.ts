// Everything the Security screen reads from the chain, in one call: the contract's `config()`, the desk (`get_desk`) and
// the access keys of the owner's account. It goes through the same `Chain` seam as onboarding, so the fake world and the
// real RPC look alike to it. Reads need no wallet.
import type { Mode } from '@gimbal/shared';
import { readDesk, type Chain, type ChainDesk } from '../onboarding/chain.ts';
import { parsePolicy } from '../onboarding/engine.ts';
import type { AccessKeyInfo } from '../onboarding/operator.ts';
import { parseConfig, type ContractConfig } from './contract-config.ts';
import { netOf } from './explorer.ts';

export interface SecurityTarget {
  contractId: string;
  deskId: string;
  mode: Mode;
}

export interface SecurityData {
  target: SecurityTarget;
  config: ContractConfig;
  desk: ChainDesk;
  /** Every access key of the desk's owner: the keys that can call this contract are picked out in `readKeys`. */
  keys: AccessKeyInfo[];
  /** When it was read, ms. */
  at: number;
}

/**
 * Reads the contract, the desk and the owner's keys. `null` is "the contract has no such desk". Throws with what failed:
 * an RPC that did not answer, a contract that does not answer like a gimbal contract, or one on the other network.
 */
export async function loadSecurity(chain: Chain, target: SecurityTarget, now = Date.now()): Promise<SecurityData | null> {
  const [config, desk] = await Promise.all([
    chain.view(target.contractId, 'config').then(parseConfig),
    readDesk(chain, target.contractId, target.deskId),
  ]);
  if (config.network.toLowerCase() !== netOf(target.mode)) {
    throw new Error(`${target.contractId} runs on ${config.network}, but the engine is on ${netOf(target.mode)}`);
  }
  if (desk === null) return null;
  // `get_desk` is the contract's own word, but the screen draws every field: a policy that is not one is refused here.
  const checked: ChainDesk = { ...desk, policy: parsePolicy(desk.policy) };
  const keys = await chain.accessKeys(checked.owner);
  return { target, config, desk: checked, keys, at: now };
}
