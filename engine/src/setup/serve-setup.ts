// serve's POST /setup: on only with GIMBAL_SETUP=1, since it is the one part of serve that signs. It loads the
// operator key by name (OPERATOR_PRIVATE_KEY, never printed) and checks the contract and every venue URL are on the
// engine's network before anything can be signed.

import { resolve } from 'node:path';
import type { Mode } from '@gimbal/shared';
import type { NearTransport } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport } from '../contract/near-transport.ts';
import { checkContractNetwork, contractEnv } from '../cli/serve-contract.ts';
import { ConfigError } from '../cli/start-errors.ts';
import { HL_MAINNET_URL, HL_TESTNET_URL } from '../venues/hyperliquid.ts';
import { ORDERLY_ENDPOINTS } from '../venues/orderly-http.ts';
import { userStateDir } from '../trade/trader-state.ts';
import { ORDERLY_WITHDRAW_ENV, startOrderlyWithdraw } from './orderly-withdraw.ts';
import { publicIpLookup } from './public-ip.ts';
import { SetupService } from './service.ts';

export interface SetupFromEnvOptions {
  /** The engine rules' `auto` now: GIMBAL_ORDERLY_WITHDRAW refuses while it is on (orderly-withdraw.ts). */
  autoOn?: () => boolean;
  /** Tests: the NEAR transport (else one on OPERATOR_PRIVATE_KEY) and the venues' fetch. */
  transport?: NearTransport;
  fetch?: typeof fetch;
}

/** The service for POST /setup, or null when GIMBAL_SETUP is not 1; its `orderlyWithdraw` is a run serve's shutdown drains. */
export async function setupFromEnv(
  mode: Mode, env: (name: string) => string | undefined, log: (line: string) => void, options: SetupFromEnvOptions = {},
): Promise<SetupService | null> {
  const withdraw = env(ORDERLY_WITHDRAW_ENV);
  if (env('GIMBAL_SETUP') !== '1') {
    if (withdraw !== undefined) log(`orderly withdraw: ignored: ${ORDERLY_WITHDRAW_ENV} runs only with GIMBAL_SETUP=1 (it signs with the operator key)`);
    return null;
  }
  if (mode === 'replay') throw new ConfigError('GIMBAL_SETUP=1 needs GIMBAL_MODE testnet or mainnet: replay signs nothing');
  const cfg = contractEnv(env, mode, { signing: true });
  if (cfg === null) throw new ConfigError('GIMBAL_SETUP=1 needs GIMBAL_CONTRACT_ID and the operator key');
  const network = cfg.network;
  const hlUrl = (env('HL_API_URL') ?? (network === 'mainnet' ? HL_MAINNET_URL : HL_TESTNET_URL)).replace(/\/+$/, '').replace(/\/info$/, '');
  const orderlyUrl = (env('ORDERLY_API_URL') ?? ORDERLY_ENDPOINTS[network].api).replace(/\/+$/, '');
  // A testnet desk must never be set up against a mainnet venue, nor the other way round.
  for (const [name, url] of [['HL_API_URL', hlUrl], ['ORDERLY_API_URL', orderlyUrl]] as const) {
    if (/testnet/.test(url) !== (network === 'testnet')) throw new ConfigError(`${name} ${url} is not a ${network} URL`);
  }
  // A transport of its own on the operator key, not serve's operator client (cli/serve-orderly.ts operatorClient): the
  // owner starts setup and the withdraw by hand; a nonce collision with the engine's signatures costs a retry.
  const transport = options.transport ?? new NearApiTransport({
    network, accountId: cfg.accountId!, privateKey: cfg.privateKey!, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }),
  });
  const contract = new NearContractClient({ contractId: cfg.contractId, network, transport, onHealth: (status, detail) => log(`setup near ${status}: ${detail}`) });
  const config = await contract.config();
  checkContractNetwork(cfg.contractId, config, network);
  const solanaRpcUrl = env('SOLANA_RPC_URL');
  // Checked against a desk's Orderly IP list before setup applies it; a bad GIMBAL_PUBLIC_IP stops serve here.
  const publicIps = publicIpLookup({ override: env('GIMBAL_PUBLIC_IP') });
  log(`venue setup: on (POST /setup), operator ${cfg.accountId}, ${network}`);
  const service = new SetupService({
    network, contract, operatorAccount: cfg.accountId!, config, hlUrl, orderlyUrl, log, publicIps,
    ...(solanaRpcUrl === undefined ? {} : { solanaRpcUrl }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  // GIMBAL_ORDERLY_WITHDRAW: a one-shot withdrawal in the background (orderly-withdraw.ts); serve's start does not wait
  // for it, its shutdown does.
  if (withdraw !== undefined) {
    const stateDirEnv = env('GIMBAL_STATE_DIR');
    service.orderlyWithdraw = startOrderlyWithdraw({
      value: withdraw, network, contract, orderlyUrl, log,
      counters: (deskId) => transport.view<unknown>(cfg.contractId, 'get_desk_counters', { desk_id: deskId }),
      engine: { contractId: cfg.contractId, deskId: cfg.deskId, operatorAccount: cfg.accountId! },
      stateDir: stateDirEnv === undefined ? userStateDir(env) : resolve(stateDirEnv),
      ...(options.autoOn === undefined ? {} : { autoOn: options.autoOn }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }
  return service;
}
