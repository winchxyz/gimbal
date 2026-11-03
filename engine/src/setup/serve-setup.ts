// serve's POST /setup: on only with GIMBAL_SETUP=1, since it is the one part of serve that signs. It loads the
// operator key by name (OPERATOR_PRIVATE_KEY, never printed) and checks the contract and every venue URL are on the
// engine's network before anything can be signed.

import type { Mode } from '@gimbal/shared';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport } from '../contract/near-transport.ts';
import { checkContractNetwork, contractEnv } from '../cli/serve-contract.ts';
import { HL_MAINNET_URL, HL_TESTNET_URL } from '../venues/hyperliquid.ts';
import { ORDERLY_ENDPOINTS } from '../venues/orderly-http.ts';
import { publicIpLookup } from './public-ip.ts';
import { SetupService } from './service.ts';

export async function setupFromEnv(mode: Mode, env: (name: string) => string | undefined, log: (line: string) => void): Promise<SetupService | null> {
  if (env('GIMBAL_SETUP') !== '1') return null;
  if (mode === 'replay') throw new Error('GIMBAL_SETUP=1 needs GIMBAL_MODE testnet or mainnet: replay signs nothing');
  const cfg = contractEnv(env, mode, { signing: true });
  if (cfg === null) throw new Error('GIMBAL_SETUP=1 needs GIMBAL_CONTRACT_ID and the operator key');
  const network = cfg.network;
  const hlUrl = (env('HL_API_URL') ?? (network === 'mainnet' ? HL_MAINNET_URL : HL_TESTNET_URL)).replace(/\/+$/, '').replace(/\/info$/, '');
  const orderlyUrl = (env('ORDERLY_API_URL') ?? ORDERLY_ENDPOINTS[network].api).replace(/\/+$/, '');
  // A testnet desk must never be set up against a mainnet venue, nor the other way round.
  for (const [name, url] of [['HL_API_URL', hlUrl], ['ORDERLY_API_URL', orderlyUrl]] as const) {
    if (/testnet/.test(url) !== (network === 'testnet')) throw new Error(`${name} ${url} is not a ${network} URL`);
  }
  const transport = new NearApiTransport({
    network, accountId: cfg.accountId!, privateKey: cfg.privateKey!, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }),
  });
  const contract = new NearContractClient({ contractId: cfg.contractId, network, transport, onHealth: (status, detail) => log(`setup near ${status}: ${detail}`) });
  const config = await contract.config();
  checkContractNetwork(cfg.contractId, config, network);
  const solanaRpcUrl = env('SOLANA_RPC_URL');
  // Checked against a desk's Orderly IP list before setup applies it; a bad GIMBAL_PUBLIC_IP stops serve here.
  const publicIps = publicIpLookup({ override: env('GIMBAL_PUBLIC_IP') });
  log(`venue setup: on (POST /setup), operator ${cfg.accountId}, ${network}`);
  return new SetupService({
    network, contract, operatorAccount: cfg.accountId!, config, hlUrl, orderlyUrl, log, publicIps,
    ...(solanaRpcUrl === undefined ? {} : { solanaRpcUrl }),
  });
}
