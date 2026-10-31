// NearTransport over near-api-js: the operator's FunctionCall key signs, the RPC carries. The transaction hash is
// computed before sending, and once the signed bytes may have left the process the outcome is only ever read from
// that hash:
//   - the RPC answered with the final outcome: done;
//   - the network refused the transaction itself (a bad signature, not enough balance or allowance, ...): nothing
//     ran, the error is thrown as is;
//   - InvalidNonce: the key's nonce moved past this transaction's, so it can never run now. near-api-js re-sends
//     after a 408 by itself, so that may be the first copy having landed: the hash is looked up first, and only
//     when it is absent is a new transaction signed (a fresh nonce);
//   - anything else (fetch failed, a 429 or 5xx, the RPC's own timeout, a slow MPC signature that outlives the
//     wait): the same hash is followed, the same signed bytes rebroadcast while the RPC does not know them. If no
//     final outcome shows up within followMs, OutcomeUnknown with the hash: never a second transaction that would
//     ask for a second signature.
// Error texts never carry NEAR_RPC_URL's path or query, where providers put API keys.

import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPairSigner, actions } from 'near-api-js';
import type { KeyPairString, Provider, SignedTransaction } from 'near-api-js';
import {
  AccessKeyDepositWithFunctionCallActionError, AccessKeyMethodNameMismatchActionError, AccessKeyNotEnoughAllowanceActionError,
  AccessKeyNotFoundActionError, AccessKeyReceiverMismatchActionError, AccessKeyRequiresFullAccessActionError, CostOverflowError,
  InvalidChainError, InvalidNonceError, InvalidReceiverIdError, InvalidSignatureError, InvalidSignerIdError,
  InvalidTransactionVersionError, LackBalanceForStateActionError, NonceTooLargeError, NotEnoughBalanceError, ShardCongestedError,
  ShardStuckError, SignerDoesNotExistError, TransactionExpiredError, TransactionSizeExceededError, UnknownTransactionError,
} from 'near-api-js/rpc-errors';
import { base58 } from '../venues/orderly-signer.ts';
import type { NearCallOutcome, NearNetwork, NearTransport } from './near-client.ts';
import { nearTxRef } from './near-client.ts';
import { OutcomeUnknown } from './types.ts';

export const NEAR_RPC_URLS: Record<NearNetwork, string> = {
  mainnet: 'https://free.rpc.fastnear.com',
  testnet: 'https://test.rpc.fastnear.com',
};

const TGAS = 10n ** 12n;

/** The provider methods the transports use; JsonRpcProvider has them all, tests pass a fake. */
export type NearRpc = Pick<Provider,
  'sendTransactionUntil' | 'viewTransactionStatus' | 'callFunction' | 'viewAccount' | 'viewAccessKey' | 'viewBlock'>;

export interface NearViewTransportOptions {
  network: NearNetwork;
  rpcUrl?: string;
  /** The account whose balance account() reads; views need none. */
  accountId?: string;
  /** In place of a JsonRpcProvider on rpcUrl: tests. */
  provider?: NearRpc;
}

export interface NearApiTransportOptions extends NearViewTransportOptions {
  /** The account that holds the operator key (the desk owner, or the desk's operator account). */
  accountId: string;
  /** `ed25519:<base58>` secret key of the operator's FunctionCall key; never logged. */
  privateKey: string;
  /** How long to follow a sent transaction before its outcome counts as unknown; default 6 min. */
  followMs?: number;
  /** Between status reads while following; default 3 s. */
  pollMs?: number;
  /** The same signed bytes go out again when the RPC still does not know the hash after this long; default 10 s. */
  rebroadcastMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface RpcStatus {
  status?: unknown;
  transaction_outcome?: { id?: string };
  final_execution_status?: string;
}

/**
 * Views only: the contract's views and the account's balance, with no key loaded. `serve` uses it, so a process that
 * only reads never holds OPERATOR_PRIVATE_KEY; call() and allowance() refuse.
 */
export class NearViewTransport implements NearTransport {
  readonly accountId: string;
  protected readonly provider: NearRpc;
  protected readonly rpcUrl: string;

  constructor(options: NearViewTransportOptions) {
    this.accountId = options.accountId ?? '';
    this.rpcUrl = options.rpcUrl ?? NEAR_RPC_URLS[options.network];
    this.provider = options.provider ?? new JsonRpcProvider({ url: this.rpcUrl });
  }

  async call(_contractId: string, method: string, _args: object, _tgas: number, _nonceRetries?: number): Promise<NearCallOutcome> {
    throw new Error(`${method}: this NEAR transport only reads views; it holds no key`);
  }

  async view<T>(contractId: string, method: string, args: object): Promise<T> {
    return this.safe(this.provider.callFunction({ contractId, method, args: args as Record<string, unknown> })) as Promise<T>;
  }

  async account(): Promise<{ amount: bigint; locked: bigint; storageUsage: number }> {
    if (this.accountId === '') throw new Error('no NEAR account configured');
    const a = await this.safe(this.provider.viewAccount({ accountId: this.accountId }));
    return { amount: BigInt(a.amount), locked: BigInt(a.locked), storageUsage: Number(a.storage_usage) };
  }

  async allowance(): Promise<bigint | null> {
    throw new Error('this NEAR transport holds no key, so it has no allowance');
  }

  /** The promise's error with the RPC URL's path and query taken out of its text. */
  protected async safe<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (err) {
      throw redactError(err, this.rpcUrl);
    }
  }
}

export class NearApiTransport extends NearViewTransport {
  readonly #account: Account;
  readonly #signer: KeyPairSigner;
  readonly #network: NearNetwork;
  readonly #followMs: number;
  readonly #pollMs: number;
  readonly #rebroadcastMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #publicKey: string | null = null;

  constructor(options: NearApiTransportOptions) {
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(options.privateKey)) {
      throw new Error('OPERATOR_PRIVATE_KEY must be an ed25519:<base58> secret key');
    }
    super(options);
    this.#network = options.network;
    this.#signer = KeyPairSigner.fromSecretKey(options.privateKey as KeyPairString);
    this.#account = new Account(options.accountId, this.provider as Provider, this.#signer);
    this.#followMs = options.followMs ?? 360_000;
    this.#pollMs = options.pollMs ?? 3_000;
    this.#rebroadcastMs = options.rebroadcastMs ?? 10_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = options.now ?? Date.now;
  }

  async publicKey(): Promise<string> {
    if (this.#publicKey === null) this.#publicKey = (await this.#signer.getPublicKey()).toString();
    return this.#publicKey;
  }

  override async call(contractId: string, method: string, args: object, tgas: number, nonceRetries = 3): Promise<NearCallOutcome> {
    // Nothing has left the process until sendTransactionUntil: an error here is a plain error.
    const signed = await this.safe(this.#account.createSignedTransaction({
      receiverId: contractId,
      actions: [actions.functionCall(method, args, BigInt(tgas) * TGAS, 0n)],
    }));
    const txHash = base58(createHash('sha256').update(signed.transaction.encode()).digest());
    let result: RpcStatus | null = null;
    let sendError: unknown = null;
    try {
      result = await this.provider.sendTransactionUntil(signed, 'EXECUTED_OPTIMISTIC') as RpcStatus;
    } catch (err) {
      sendError = err;
    }
    if (sendError !== null) {
      if (isRejected(sendError)) throw redactError(sendError, this.rpcUrl);
      if (sendError instanceof InvalidNonceError) {
        const seen = await this.#lookup(txHash);
        if (seen === 'absent') {
          if (nonceRetries <= 0) throw redactError(sendError, this.rpcUrl);
          // Another process used the key, or the cached nonce went stale; this transaction can never run now.
          await (this.#account as unknown as { nonceManager?: { invalidate(pk: unknown): Promise<void> } })
            .nonceManager?.invalidate(signed.transaction.publicKey);
          return this.call(contractId, method, args, tgas, nonceRetries - 1);
        }
      }
    }
    if (result === null || !isFinal(result)) result = await this.#follow(method, signed, txHash, sendError);
    return outcomeOf(txHash, result);
  }

  /** Whether the RPC knows the transaction: three reads 3 s apart must all say "unknown" for 'absent'. */
  async #lookup(txHash: string): Promise<'seen' | 'absent' | 'error'> {
    for (let i = 0; i < 3; i++) {
      try {
        await this.provider.viewTransactionStatus({ txHash, accountId: this.accountId, waitUntil: 'NONE' });
        return 'seen';
      } catch (err) {
        if (!(err instanceof UnknownTransactionError)) return 'error';
      }
      if (i < 2) await this.#sleep(this.#pollMs);
    }
    return 'absent';
  }

  /** The final outcome of `txHash`, rebroadcasting the same bytes while the RPC does not know it; else OutcomeUnknown. */
  async #follow(method: string, signed: SignedTransaction, txHash: string, why: unknown): Promise<RpcStatus> {
    const until = this.#now() + this.#followMs;
    let last = why === null ? 'the RPC answered before the final outcome' : errorText(why);
    let sentAt = this.#now();
    for (;;) {
      try {
        const r = await this.provider.viewTransactionStatus({ txHash, accountId: this.accountId, waitUntil: 'EXECUTED_OPTIMISTIC' }) as RpcStatus;
        if (isFinal(r)) return r;
      } catch (err) {
        last = errorText(err);
        if (err instanceof UnknownTransactionError && this.#now() - sentAt >= this.#rebroadcastMs) {
          // The first send may never have reached a node: the same bytes, so at most one of them ever runs.
          sentAt = this.#now();
          try {
            await this.provider.sendTransactionUntil(signed, 'NONE');
          } catch (e) {
            last = errorText(e);
          }
        }
      }
      if (this.#now() >= until) break;
      await this.#sleep(this.#pollMs);
    }
    throw new OutcomeUnknown(method, redact(`no final outcome of NEAR transaction ${txHash} after ${Math.round(this.#followMs / 1000)} s (last: ${last})`, this.rpcUrl),
      { nearTx: txHash }, [nearTxRef(this.#network, txHash)]);
  }

  override async allowance(): Promise<bigint | null> {
    const key = await this.safe(this.provider.viewAccessKey({ accountId: this.accountId, publicKey: await this.publicKey() }));
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
  const s = r?.status;
  return typeof s === 'object' && s !== null && ('SuccessValue' in s || 'Failure' in s);
}

/**
 * The network refused these signed bytes as a transaction (InvalidTxError other than InvalidNonce): nothing ran and
 * nothing can. nearcore checks the nonce before balance and allowance, so a copy that already landed would answer
 * InvalidNonce, never one of these.
 */
const REJECTED = [
  InvalidSignatureError, CostOverflowError, InvalidChainError, TransactionExpiredError, InvalidTransactionVersionError,
  InvalidSignerIdError, SignerDoesNotExistError, NonceTooLargeError, InvalidReceiverIdError, NotEnoughBalanceError,
  LackBalanceForStateActionError, TransactionSizeExceededError, ShardCongestedError, ShardStuckError,
  AccessKeyNotFoundActionError, AccessKeyReceiverMismatchActionError, AccessKeyMethodNameMismatchActionError,
  AccessKeyRequiresFullAccessActionError, AccessKeyNotEnoughAllowanceActionError, AccessKeyDepositWithFunctionCallActionError,
];

function isRejected(err: unknown): boolean {
  return REJECTED.some((cls) => err instanceof cls);
}

function errorText(err: unknown): string {
  const name = (err as { constructor?: { name?: string } })?.constructor?.name;
  const message = String((err as Error)?.message ?? err);
  return name !== undefined && name !== 'Error' && !message.startsWith(name) ? `${name}: ${message}` : message;
}

/** What may be shown of an RPC URL: its origin, with "/…" when a path or query (where API keys go) was cut. */
export function rpcLabel(url: string): string {
  try {
    const u = new URL(url);
    const hidden = u.pathname.replace(/\/+$/, '') !== '' || u.search !== '' || u.username !== '' || u.password !== '';
    return hidden ? `${u.protocol}//${u.host}/…` : `${u.protocol}//${u.host}`;
  } catch {
    return '<NEAR RPC>';
  }
}

/** `text` with the RPC URL shown only as rpcLabel(url), and its path, query and credentials cut wherever they appear. */
export function redact(text: string, url: string): string {
  let out = text.split(url).join(rpcLabel(url));
  try {
    const u = new URL(url);
    const secrets = [u.href, `${u.pathname}${u.search}`, u.pathname, u.search, u.username, u.password,
      ...[...u.searchParams.values()], ...u.pathname.split('/')]
      .filter((s) => s.length >= 6 && s !== '/');
    for (const s of secrets.sort((a, b) => b.length - a.length)) out = out.split(s).join('…');
  } catch {
    // not a URL: nothing more to cut
  }
  return out;
}

/** The error itself when its text holds nothing of the URL to hide; else an Error of the same name with the text cut. */
export function redactError(err: unknown, url: string): unknown {
  if (!(err instanceof Error)) return err;
  const text = redact(err.message, url);
  if (text === err.message) return err;
  const safe = new Error(text);
  safe.name = err.name;
  return safe;
}
