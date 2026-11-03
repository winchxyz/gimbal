// Reading NEAR: view calls and access keys over JSON-RPC, and the contract's views (`get_desk`, `desks_of`, `config`)
// and the MPC contract's `derived_public_key` on top of them. Reads need no wallet. `Chain` is the seam the tests fake.
import type { ContractPolicy } from '@gimbal/shared';
import { addressesFrom, DOMAIN_ED25519, DOMAIN_SECP256K1, evmPath, solPath, type DerivedAddresses, type SolanaAccounts } from './derive.ts';
import type { AccessKeyInfo } from './operator.ts';
import type { NearNetwork } from './wallet.ts';

export interface Chain {
  /** A view call (`call_function`): JSON in, JSON out. Rejects with the contract's own message when the call fails. */
  view(contract: string, method: string, args?: object): Promise<unknown>;
  /** The access keys of an account (`view_access_key_list`). */
  accessKeys(accountId: string): Promise<AccessKeyInfo[]>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Public RPC endpoints, tried in order; a failed one is skipped. FastNEAR first on both networks, as the engine uses:
 * the near.org endpoints are deprecated and rate-limited, and stay only as the fallback for these reads.
 */
export const RPC_URLS: Record<NearNetwork, readonly string[]> = {
  mainnet: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
  testnet: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
};

/** The real chain, over JSON-RPC. `fetcher` is injectable for tests. */
export function rpcChain(network: NearNetwork, urls: readonly string[] = RPC_URLS[network], fetcher: typeof fetch = fetch): Chain {
  async function rpc(method: string, params: object): Promise<Record<string, unknown>> {
    let last: unknown = new Error('no RPC endpoint is configured');
    for (const url of urls) {
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'gimbal', method, params }),
          signal: AbortSignal.timeout(15_000),
        });
        const body: unknown = await response.json();
        if (!isObject(body)) throw new Error(`${url}: not a JSON-RPC answer`);
        if (isObject(body.error)) {
          const cause = isObject(body.error.cause) ? body.error.cause : {};
          // A failed view is the contract's answer, not an outage: do not try another endpoint for it.
          const name = typeof cause.name === 'string' ? cause.name : '';
          if (name !== '' && name !== 'UNKNOWN_BLOCK' && name !== 'NO_SYNCED_BLOCKS') {
            throw new RpcRefusal(typeof body.error.data === 'string' ? body.error.data : JSON.stringify(body.error));
          }
          throw new Error(`${url}: ${JSON.stringify(body.error)}`);
        }
        if (!isObject(body.result)) throw new Error(`${url}: no result`);
        if (typeof body.result.error === 'string') throw new RpcRefusal(body.result.error);
        return body.result;
      } catch (error) {
        if (error instanceof RpcRefusal) throw new Error(error.message);
        last = error;
      }
    }
    throw new Error(`NEAR RPC did not answer: ${last instanceof Error ? last.message : String(last)}`);
  }

  return {
    async view(contract, method, args = {}) {
      const result = await rpc('query', {
        request_type: 'call_function',
        finality: 'final',
        account_id: contract,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      });
      if (!Array.isArray(result.result)) throw new Error(`${contract}.${method}: no result`);
      const text = new TextDecoder().decode(Uint8Array.from(result.result as number[]));
      return text === '' ? null : JSON.parse(text);
    },
    async accessKeys(accountId) {
      const result = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: accountId });
      const keys = Array.isArray(result.keys) ? result.keys : [];
      return keys.flatMap((entry: unknown): AccessKeyInfo[] => {
        if (!isObject(entry) || typeof entry.public_key !== 'string' || !isObject(entry.access_key)) return [];
        const permission = entry.access_key.permission;
        if (permission === 'FullAccess') return [{ publicKey: entry.public_key, permission: 'FullAccess' }];
        const call = isObject(permission) && isObject(permission.FunctionCall) ? permission.FunctionCall : null;
        if (!call || typeof call.receiver_id !== 'string') return [];
        const methods = Array.isArray(call.method_names) ? call.method_names.filter((m): m is string => typeof m === 'string') : [];
        return [{ publicKey: entry.public_key, permission: { receiverId: call.receiver_id, methodNames: methods, allowance: typeof call.allowance === 'string' ? call.allowance : null } }];
      });
    },
  };
}

class RpcRefusal extends Error {}

// ---------- the contract's views ----------

/** `get_desk` as the page reads it: the fields onboarding uses (docs/interfaces.md §1.2); u128 amounts arrive as strings. */
export interface ChainDesk {
  owner: string;
  operator: string | null;
  paused: boolean;
  policy: ContractPolicy;
  evm_address: string;
  solana: SolanaAccounts;
  orderly_account_id: string;
  orderly_receiver: string | null;
  ledger: { deposited: bigint; idle_usdc: bigint };
}

const asString = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value === '') throw new Error(`get_desk: ${what} is not text`);
  return value;
};
const asBig = (value: unknown, what: string): bigint => {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`get_desk: ${what} is not an amount`);
};

/** Checks one `get_desk` answer; throws with what is wrong, so the screen can say so. `null` is "no such desk". */
export function parseDesk(value: unknown): ChainDesk | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw new Error('get_desk: not an object');
  const { solana, policy, ledger } = value;
  if (!isObject(solana) || !isObject(policy) || !isObject(ledger)) throw new Error('get_desk: no solana, policy or ledger');
  return {
    owner: asString(value.owner, 'owner'),
    operator: typeof value.operator === 'string' ? value.operator : null,
    paused: value.paused === true,
    policy: policy as unknown as ContractPolicy,
    evm_address: asString(value.evm_address, 'evm_address'),
    solana: {
      authority: asString(solana.authority, 'solana.authority'),
      usdc_ata: asString(solana.usdc_ata, 'solana.usdc_ata'),
      phusd_ata: asString(solana.phusd_ata, 'solana.phusd_ata'),
      phoenix_trader: asString(solana.phoenix_trader, 'solana.phoenix_trader'),
    },
    orderly_account_id: asString(value.orderly_account_id, 'orderly_account_id'),
    orderly_receiver: typeof value.orderly_receiver === 'string' ? value.orderly_receiver : null,
    ledger: { deposited: asBig(ledger.deposited, 'ledger.deposited'), idle_usdc: asBig(ledger.idle_usdc, 'ledger.idle_usdc') },
  };
}

export async function readDesk(chain: Chain, contractId: string, deskId: string): Promise<ChainDesk | null> {
  return parseDesk(await chain.view(contractId, 'get_desk', { desk_id: deskId }));
}

export async function desksOf(chain: Chain, contractId: string, owner: string): Promise<string[]> {
  const ids = await chain.view(contractId, 'desks_of', { owner });
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** What `config()` says the page needs: which network the contract runs on and which MPC contract signs for it. */
export async function readConfig(chain: Chain, contractId: string): Promise<{ network: 'Mainnet' | 'Testnet'; mpc: string }> {
  const config = await chain.view(contractId, 'config');
  if (!isObject(config) || (config.network !== 'Mainnet' && config.network !== 'Testnet') || typeof config.mpc !== 'string') {
    throw new Error(`${contractId} did not answer config() like a gimbal contract`);
  }
  return { network: config.network, mpc: config.mpc };
}

/** The desk's two MPC keys, derived for the gimbal contract as predecessor (docs/interfaces.md §1.2), as addresses. */
export async function deriveAddresses(chain: Chain, mpc: string, contractId: string, deskId: string): Promise<DerivedAddresses> {
  const [evm, sol] = await Promise.all([
    chain.view(mpc, 'derived_public_key', { path: evmPath(deskId), predecessor: contractId, domain_id: DOMAIN_SECP256K1 }),
    chain.view(mpc, 'derived_public_key', { path: solPath(deskId), predecessor: contractId, domain_id: DOMAIN_ED25519 }),
  ]);
  if (typeof evm !== 'string' || typeof sol !== 'string') throw new Error('the MPC contract did not answer with keys');
  return addressesFrom(evm, sol);
}

/** An account's balance of a fungible token (`ft_balance_of`), in the token's smallest unit. */
export async function tokenBalance(chain: Chain, token: string, account: string): Promise<bigint> {
  const raw = await chain.view(token, 'ft_balance_of', { account_id: account });
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw);
  throw new Error(`${token}.ft_balance_of did not answer with an amount`);
}
