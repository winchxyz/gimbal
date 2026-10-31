// NearTransport over near-api-js: the operator's FunctionCall key signs, the RPC carries. The transaction hash is
// computed before sending, so a slow MPC signature (one took 120 s on mainnet) that outlives the RPC's own wait is
// followed by polling that hash, never by sending a second transaction that would ask for a second signature.

import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPairSigner, actions } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { base58 } from '../venues/orderly-signer.ts';
import type { NearCallOutcome, NearNetwork, NearTransport } from './near-client.ts';

export const NEAR_RPC_URLS: Record<NearNetwork, string> = {
  mainnet: 'https://free.rpc.fastnear.com',
  testnet: 'https://test.rpc.fastnear.com',
};

const TGAS = 10n ** 12n;

export interface NearApiTransportOptions {
  network: NearNetwork;
  rpcUrl?: string;
  /** The account that holds the operator key (the desk owner, or the desk's operator account). */
  accountId: string;
  /** `ed25519:<base58>` secret key of the operator's FunctionCall key; never logged. */
  privateKey: string;
  /** How long to follow a sent transaction before giving up on knowing its outcome; default 6 min. */
  followMs?: number;
}

interface RpcStatus {
  status?: unknown;
  transaction_outcome?: { id?: string };
  final_execution_status?: string;
}

export class NearApiTransport implements NearTransport {
  readonly accountId: string;
  readonly #provider: JsonRpcProvider;
  readonly #account: Account;
  readonly #signer: KeyPairSigner;
  readonly #followMs: number;
  #publicKey: string | null = null;

  constructor(options: NearApiTransportOptions) {
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(options.privateKey)) {
      throw new Error('OPERATOR_PRIVATE_KEY must be an ed25519:<base58> secret key');
    }
    this.accountId = options.accountId;
    this.#provider = new JsonRpcProvider({ url: options.rpcUrl ?? NEAR_RPC_URLS[options.network] });
    this.#signer = KeyPairSigner.fromSecretKey(options.privateKey as KeyPairString);
    this.#account = new Account(options.accountId, this.#provider, this.#signer);
    this.#followMs = options.followMs ?? 360_000;
  }

  async publicKey(): Promise<string> {
    if (this.#publicKey === null) this.#publicKey = (await this.#signer.getPublicKey()).toString();
    return this.#publicKey;
  }

  async call(contractId: string, method: string, args: object, tgas: number, nonceRetries = 3): Promise<NearCallOutcome> {
    const signed = await this.#account.createSignedTransaction({
      receiverId: contractId,
      actions: [actions.functionCall(method, args, BigInt(tgas) * TGAS, 0n)],
    });
    const txHash = base58(createHash('sha256').update(signed.transaction.encode()).digest());
    let result: RpcStatus;
    try {
      result = await this.#provider.sendTransactionUntil(signed, 'EXECUTED_OPTIMISTIC') as RpcStatus;
    } catch (err) {
      if (isInvalidNonce(err) && nonceRetries > 0) {
        // Another process used the key, or the cached nonce went stale: read it again and sign once more.
        await (this.#account as unknown as { nonceManager?: { invalidate(pk: unknown): Promise<void> } })
          .nonceManager?.invalidate(signed.transaction.publicKey);
        return this.call(contractId, method, args, tgas, nonceRetries - 1);
      }
      if (!isWaitTimeout(err)) throw err;
      result = await this.#follow(txHash);
    }
    return outcomeOf(txHash, result);
  }

  async #follow(txHash: string): Promise<RpcStatus> {
    const until = Date.now() + this.#followMs;
    let lastError: unknown = null;
    while (Date.now() < until) {
      try {
        const r = await this.#provider.viewTransactionStatus({ txHash, accountId: this.accountId, waitUntil: 'EXECUTED_OPTIMISTIC' }) as RpcStatus;
        if (isFinal(r)) return r;
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new Error(`transaction ${txHash}: no final outcome after ${Math.round(this.#followMs / 1000)} s${lastError === null ? '' : ` (${String((lastError as Error).message ?? lastError)})`}`);
  }

  async view<T>(contractId: string, method: string, args: object): Promise<T> {
    return (await this.#provider.callFunction({ contractId, method, args: args as Record<string, unknown> })) as T;
  }

  async account(): Promise<{ amount: bigint; locked: bigint; storageUsage: number }> {
    const a = await this.#provider.viewAccount({ accountId: this.accountId });
    return { amount: BigInt(a.amount), locked: BigInt(a.locked), storageUsage: Number(a.storage_usage) };
  }

  async allowance(): Promise<bigint | null> {
    const key = await this.#provider.viewAccessKey({ accountId: this.accountId, publicKey: await this.publicKey() });
    return allowanceOf(key.permission);
  }
}

/** The remaining allowance of a key's permission; null for a full-access key or a FunctionCall key without a limit. */
export function allowanceOf(permission: unknown): bigint | null {
  if (permission === 'FullAccess' || typeof permission !== 'object' || permission === null) return null;
  const fc = (permission as { FunctionCall?: { allowance?: unknown } }).FunctionCall;
  if (fc === undefined || fc.allowance === null || fc.allowance === undefined) return null;
  return BigInt(String(fc.allowance));
}

/** The final status of an RPC transaction answer, as the client's NearCallOutcome. */
export function outcomeOf(txHash: string, r: RpcStatus): NearCallOutcome {
  const status = r.status;
  if (typeof status === 'object' && status !== null && 'SuccessValue' in status) {
    const b64 = String((status as { SuccessValue: unknown }).SuccessValue ?? '');
    const text = Buffer.from(b64, 'base64').toString('utf8');
    let value: unknown = null;
    if (text !== '') {
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    return { txHash, ok: true, value };
  }
  if (typeof status === 'object' && status !== null && 'Failure' in status) {
    return { txHash, ok: false, failure: JSON.stringify((status as { Failure: unknown }).Failure) };
  }
  return { txHash, ok: false, failure: `no final status: ${JSON.stringify(status)}` };
}

function isFinal(r: RpcStatus): boolean {
  const s = r.status;
  return typeof s === 'object' && s !== null && ('SuccessValue' in s || 'Failure' in s);
}

function isInvalidNonce(err: unknown): boolean {
  return (err as { name?: string; constructor?: { name?: string } })?.constructor?.name === 'InvalidNonceError'
    || /InvalidNonce/.test(String((err as Error)?.message ?? ''));
}

/** The RPC stopped waiting (its own timeout, a 408, retries spent) while the transaction may still run. */
function isWaitTimeout(err: unknown): boolean {
  const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? '';
  const text = `${name} ${String((err as Error)?.message ?? err)}`;
  return /Timeout|TIMEOUT|timed out|RetriesExceeded|Exceeded \d+ attempts|408|503|502/i.test(text);
}
