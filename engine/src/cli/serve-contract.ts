// The contract side of `serve` in the live modes: when GIMBAL_CONTRACT_ID and DESK_ID are set, the engine reads the
// desk from the contract instead of a policy file and feeds the scanner the contract's own numbers:
//   - the policy: get_desk(DESK_ID).policy (GIMBAL_POLICY_FILE is then ignored);
//   - the oracle: prices(), read every 10 s, so a priced desk leg passes E_ORACLE_STALE exactly when the contract's
//     check would;
//   - marginHeldAt: the venues where the desk holds margin now (DeskState legs), so entering there moves nothing;
//   - health: NEAR's state (the operator key's budget, slow signatures) next to the venues the last scan missed.
// serve signs nothing: it reads views over a keyless transport and never loads OPERATOR_PRIVATE_KEY. relay-hl, which
// signs, asks contractEnv for the key. Either way NEAR_NETWORK, the mode (GIMBAL_MODE) and the contract's own
// config().network must name the same network, or nothing starts.

import type { ContractPolicy, DeskState, HealthMap, Mode, ScanStatus, VenueId } from '@gimbal/shared';
import type { NearHealth } from '../contract/budget.ts';
import type { NearNetwork, NearTransport } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { NearViewTransport } from '../contract/near-transport.ts';
import { ContractPriceCache } from '../contract/prices.ts';
import type { DeskView } from '../contract/types.ts';
import { parseContractPolicy } from '../scanner/config.ts';

export interface ContractEnv {
  contractId: string;
  deskId: string;
  network: NearNetwork;
  rpcUrl: string | undefined;
  /** OPERATOR_ACCOUNT_ID or OWNER_ACCOUNT_ID; optional for views. */
  accountId: string | undefined;
  /** ed25519:<base58>, only when asked for with `signing`; never printed. */
  privateKey?: string;
}

/**
 * The contract settings from the environment: null in replay or without GIMBAL_CONTRACT_ID; an error naming the
 * missing variables (never their values) when only some are set, or when NEAR_NETWORK, the mode and the contract id
 * disagree on the network. OPERATOR_PRIVATE_KEY is read only with `signing`.
 */
export function contractEnv(env: (name: string) => string | undefined, mode: Mode, options: { signing?: boolean } = {}): ContractEnv | null {
  if (mode === 'replay') return null;
  const contractId = env('GIMBAL_CONTRACT_ID');
  if (contractId === undefined) return null;
  const deskId = env('DESK_ID');
  const accountId = env('OPERATOR_ACCOUNT_ID') ?? env('OWNER_ACCOUNT_ID');
  const privateKey = options.signing === true ? env('OPERATOR_PRIVATE_KEY') : undefined;
  const missing = [
    deskId === undefined ? 'DESK_ID' : null,
    options.signing === true && accountId === undefined ? 'OWNER_ACCOUNT_ID (or OPERATOR_ACCOUNT_ID)' : null,
    options.signing === true && privateKey === undefined ? 'OPERATOR_PRIVATE_KEY' : null,
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) throw new Error(`GIMBAL_CONTRACT_ID is set, so these are needed too: ${missing.join(', ')}`);
  const nearNetwork = env('NEAR_NETWORK');
  if (nearNetwork !== undefined && nearNetwork !== 'mainnet' && nearNetwork !== 'testnet') {
    throw new Error(`NEAR_NETWORK must be mainnet or testnet, got ${nearNetwork}`);
  }
  if (nearNetwork !== undefined && nearNetwork !== mode) {
    throw new Error(`NEAR_NETWORK is ${nearNetwork} but the engine runs in ${mode} mode (GIMBAL_MODE): a ${nearNetwork} contract would sign for ${mode} venues. Set both to the same network.`);
  }
  const network = mode as NearNetwork;
  const suffix = /\.(near|testnet)$/.exec(contractId)?.[1];
  if (suffix !== undefined && (suffix === 'near' ? 'mainnet' : 'testnet') !== network) {
    throw new Error(`GIMBAL_CONTRACT_ID ${contractId} is a ${suffix === 'near' ? 'mainnet' : 'testnet'} account, but the engine runs on ${network}`);
  }
  return {
    contractId, deskId: deskId!, network, rpcUrl: env('NEAR_RPC_URL'), accountId,
    ...(privateKey === undefined ? {} : { privateKey }),
  };
}

/** Refuses a contract whose config().network is not the engine's network (or does not say). */
export function checkContractNetwork(contractId: string, config: { network?: unknown }, network: NearNetwork): void {
  const said = typeof config.network === 'string' ? config.network.toLowerCase() : null;
  if (said === null) throw new Error(`${contractId}: config() names no network, so it cannot be checked against ${network}; not starting`);
  if (said !== network) throw new Error(`${contractId} is a ${said} contract (config().network), but the engine runs on ${network}; not starting`);
}

export interface ContractSide {
  client: NearContractClient;
  desk: DeskView;
  policy: ContractPolicy;
  prices: ContractPriceCache;
}

/** Connects, reads the desk and its policy, and starts the price cache (first read awaited). */
export async function connectContract(cfg: ContractEnv, options: {
  onHealth?: (status: NearHealth, detail: string) => void;
  onError?: (message: string) => void;
  transport?: NearTransport;
  refreshMs?: number;
} = {}): Promise<ContractSide> {
  // Views only: no key is loaded, whatever the environment holds.
  const transport = options.transport ?? new NearViewTransport({
    network: cfg.network, ...(cfg.accountId === undefined ? {} : { accountId: cfg.accountId }), ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }),
  });
  const client = new NearContractClient({
    contractId: cfg.contractId, network: cfg.network, transport, ...(options.onHealth === undefined ? {} : { onHealth: options.onHealth }),
  });
  checkContractNetwork(cfg.contractId, await client.config(), cfg.network);
  const desk = await client.getDesk(cfg.deskId);
  if (desk === null) throw new Error(`${cfg.contractId} has no desk ${cfg.deskId}`);
  let policy: ContractPolicy;
  try {
    policy = parseContractPolicy(desk.policy);
  } catch (err) {
    throw new Error(`get_desk(${cfg.deskId}).policy: ${(err as Error).message}`);
  }
  const prices = new ContractPriceCache({
    client, ...(options.refreshMs === undefined ? {} : { refreshMs: options.refreshMs }), ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  await prices.refresh();
  prices.start();
  return { client, desk, policy, prices };
}

/** The desk venues holding margin now: every leg with margin on it. */
export function marginVenues(desk: DeskState | null): ReadonlySet<VenueId> {
  return new Set((desk?.legs ?? []).filter((l) => l.marginUsd > 0).map((l) => l.venue));
}

const DESK_VENUES: readonly VenueId[] = ['hyperliquid', 'phoenix', 'orderly'];

/**
 * The HealthMap from the last scan and NEAR's state. A desk venue the scan could not read is 'down'. Intents is not
 * probed by the engine yet and reads 'ok'.
 */
export function healthMap(scan: ScanStatus | null, near: NearHealth): HealthMap {
  const failed = new Set(scan?.failed ?? []);
  const map = { intents: 'ok', near } as HealthMap;
  for (const v of DESK_VENUES) map[v] = failed.has(v) ? 'down' : 'ok';
  return map;
}

/** Whether two health maps differ (publish only changes). */
export function healthChanged(a: HealthMap | null, b: HealthMap): boolean {
  if (a === null) return true;
  return (Object.keys(b) as (keyof HealthMap)[]).some((k) => a[k] !== b[k]);
}
