// Shared wiring of the engine's live testnet checks (orderly-session, pair-live): the repo's .env, the operator key
// through contractEnv, the contract client, and the desk's Hyperliquid and Orderly clients. Testnet only: a mainnet
// NEAR network, contract or venue URL is refused before anything is signed. Values from .env are never printed.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TxRef } from '@gimbal/shared';
import { formatNear } from '../contract/budget.ts';
import type { ContractConfigView } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport } from '../contract/near-transport.ts';
import type { DeskView } from '../contract/types.ts';
import { ContractRefusal, OutcomeUnknown } from '../contract/types.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import { HL_TESTNET_URL } from '../venues/hyperliquid.ts';
import { OrderlyDeskClient } from '../venues/orderly-actions.ts';
import { ORDERLY_ENDPOINTS } from '../venues/orderly-http.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { ContractEnv } from './serve-contract.ts';
import { checkContractNetwork, contractEnv } from './serve-contract.ts';

export interface LiveTestnet {
  cfg: ContractEnv;
  transport: NearApiTransport;
  client: NearContractClient;
  config: ContractConfigView;
  desk: DeskView;
  hlUrl: string;                 // Hyperliquid testnet API root, no /info
  orderlyUrl: string;            // Orderly testnet REST root
  orderly: OrderlyDeskClient;
  brokerId: string;
}

/** Loads .env, refuses anything but testnet, and reads the contract's config and the desk. */
export async function liveTestnet(tag: string, deskId?: string): Promise<LiveTestnet> {
  const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const cfg0 = contractEnv(envVar, 'testnet', { signing: true });
  if (cfg0 === null) throw new Error('GIMBAL_CONTRACT_ID is not set (the testnet contract)');
  const cfg: ContractEnv = deskId === undefined ? cfg0 : { ...cfg0, deskId };
  if (cfg.network !== 'testnet') throw new Error('testnet only: NEAR_NETWORK must be testnet');
  if (cfg.privateKey === undefined || cfg.accountId === undefined) throw new Error('OPERATOR_PRIVATE_KEY and OWNER_ACCOUNT_ID are needed to sign');
  const hlUrl = (envVar('HL_API_URL') ?? HL_TESTNET_URL).replace(/\/+$/, '').replace(/\/info$/, '');
  if (!/testnet/.test(hlUrl)) throw new Error(`testnet only: HL_API_URL ${hlUrl} is not a Hyperliquid testnet URL`);
  const orderlyUrl = (envVar('ORDERLY_API_URL') ?? ORDERLY_ENDPOINTS.testnet.api).replace(/\/+$/, '');
  if (!/testnet/.test(orderlyUrl)) throw new Error(`testnet only: ORDERLY_API_URL ${orderlyUrl} is not an Orderly testnet URL`);

  const transport = new NearApiTransport({
    network: 'testnet', accountId: cfg.accountId, privateKey: cfg.privateKey, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }),
  });
  const client = new NearContractClient({
    contractId: cfg.contractId, network: 'testnet', transport, onHealth: (status, detail) => log(tag, `near ${status}: ${detail}`),
  });
  const config = await client.config();
  checkContractNetwork(cfg.contractId, config, 'testnet');
  const desk = await client.getDesk(cfg.deskId);
  if (desk === null) throw new Error(`desk ${cfg.deskId} does not exist on ${cfg.contractId}`);
  const [account, allowance] = await Promise.all([transport.account(), transport.allowance()]);
  log(tag, `contract ${cfg.contractId}, desk ${cfg.deskId} (${desk.paused ? 'PAUSED' : 'running'}), EVM ${desk.evm_address}`);
  log(tag, `operator ${cfg.accountId}: ${formatNear(account.amount)} balance, allowance ${allowance === null ? 'unlimited' : formatNear(allowance)}`);
  const brokerId = config.orderly?.broker_id;
  if (brokerId === undefined) throw new Error('config().orderly.broker_id is missing');
  if (desk.orderly_account_id === undefined) throw new Error('get_desk returned no orderly_account_id');
  const orderly = new OrderlyDeskClient({
    deskId: cfg.deskId, network: 'testnet', apiUrl: orderlyUrl, accountId: desk.orderly_account_id,
    orderlyKey: `ed25519:${desk.solana.authority}`, evmAddress: desk.evm_address,
    referralCode: config.treasury?.referral_codes?.orderly ?? null, signer: client,
  });
  return { cfg, transport, client, config, desk, hlUrl, orderlyUrl, orderly, brokerId };
}

export function envVar(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

/** Prints why a live check stopped; an OutcomeUnknown sets exit code 3 (reconcile before anything else). */
export function reportFailure(tag: string, err: unknown): void {
  if (err instanceof OutcomeUnknown) {
    console.error(`[${tag}] OUTCOME UNKNOWN: stop and reconcile before sending anything else.\n  ${err.message}${err.tx.length > 0 ? `\n  ${refs(err.tx)}` : ''}`);
    process.exitCode = 3;
    return;
  }
  if (err instanceof ContractRefusal) console.error(`[${tag}] refused by the contract: ${err.message}${err.txHash === null ? '' : ` (tx ${err.txHash})`}`);
  else if (err instanceof NothingExecuted) console.error(`[${tag}] ${err.message}${err.tx.length > 0 ? `\n  ${refs(err.tx)}` : ''}`);
  else console.error(`[${tag}] failed: ${errorMessage(err)}`);
  process.exitCode = 1;
}

export function refs(tx: TxRef[]): string {
  return tx.length === 0 ? '(none)' : tx.map((t) => t.url).join('  ');
}

export function log(tag: string, line: string): void {
  console.log(`[${tag} ${new Date().toISOString()}] ${line}`);
}
