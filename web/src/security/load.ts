// Everything the Security screen reads from the chain, in one call: the contract's `config()`, the desk (`get_desk`) and
// the access keys of the owner's account. It goes through the same `Chain` seam as onboarding, so the fake world and the
// real RPC look alike to it. Reads need no wallet.
import type { Mode } from '@gimbal/shared';
import { readDesk, type Chain, type ChainDesk } from '../onboarding/chain.ts';
import { parsePolicy } from '../onboarding/engine.ts';
import type { AccessKeyInfo } from '../onboarding/operator.ts';
import { parseConfig, type ContractConfig } from './contract-config.ts';
import { maskAccount, maskIf, maskIn } from '../remote/mask.ts';
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
 * Reads the contract, the desk and the owner's keys. With `mask` (the remote view) the owner's and the operator's ids come back
 * masked as the engine masks them (remote/mask.ts), and nothing built from them is a link.
 * `null` is "the contract has no such desk". Throws with what failed:
 * an RPC that did not answer, a contract that does not answer like a gimbal contract, or one on the other network.
 */
export async function loadSecurity(chain: Chain, target: SecurityTarget, now = Date.now(), options: { mask?: boolean } = {}): Promise<SecurityData | null> {
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
  const secret = [checked.owner, checked.operator];
  // The keys are read for the real owner; what is kept and shown carries the mask.
  const keys = await chain.accessKeys(checked.owner).catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(options.mask ? maskIn(text, secret) : text);
  });
  if (!options.mask) return { target, config, desk: checked, keys, at: now };
  const hide = (id: string): string => maskIf(id, secret);
  return {
    target,
    config: {
      ...config,
      treasury: hide(config.treasury),
      mpc: hide(config.mpc),
      oracle: config.oracle.kind === 'outlayer' ? { kind: 'outlayer', contract: hide(config.oracle.contract) } : config.oracle,
    },
    desk: { ...checked, owner: maskAccount(checked.owner), operator: checked.operator === null ? null : maskAccount(checked.operator) },
    keys,
    at: now,
  };
}
