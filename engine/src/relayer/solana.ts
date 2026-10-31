// Solana submitter: the contract signed a message for the desk's authority (`sol_sign`, `sol_sign_rescue`); this
// sends it as `[1][signature][message]` and keeps sending it until it lands or its blockhash expires
// (docs/interfaces.md §1.4, CLAUDE.md "Phoenix"):
//   - the signature must verify against keys[0] (the desk authority), or nothing is sent;
//   - the message must set a compute-unit limit and a priority fee: Phoenix orders need ~190k CU, and public RPCs
//     drop transactions without a fee. The engine builds messages with computeBudgetInstructions() (400k, 100,000
//     µlamports per CU);
//   - sent with skipPreflight and maxRetries 0, then rebroadcast every 2 s while the status is polled;
//   - once the blockhash is past lastValidBlockHeight (or no longer valid) and the signature never landed, it is
//     NothingExecuted: the transaction can no longer run, so the caller may build a new one.
// sol_sign_register transactions have two signers and are sent by Phoenix's API, not here.

import { createPublicKey, verify as edVerify } from 'node:crypto';
import type { TxRef } from '@gimbal/shared';
import type { SolSignedAction } from '../contract/types.ts';
import { base58 } from '../venues/orderly-signer.ts';
import type { ChainNetwork } from './tx.ts';
import { NothingExecuted, sleep, solanaTxRef } from './tx.ts';

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const SOLANA_COMPUTE_UNITS = 400_000;
export const SOLANA_PRIORITY_MICROLAMPORTS = 100_000;

/** The two compute-budget instructions every desk transaction starts with: SetComputeUnitLimit, SetComputeUnitPrice. */
export function computeBudgetInstructions(units = SOLANA_COMPUTE_UNITS, microLamports = SOLANA_PRIORITY_MICROLAMPORTS): {
  programAddress: string; data: Uint8Array;
}[] {
  const limit = Buffer.alloc(5);
  limit.writeUInt8(2, 0);
  limit.writeUInt32LE(units, 1);
  const price = Buffer.alloc(9);
  price.writeUInt8(3, 0);
  price.writeBigUInt64LE(BigInt(microLamports), 1);
  return [{ programAddress: COMPUTE_BUDGET_PROGRAM, data: Uint8Array.from(limit) }, { programAddress: COMPUTE_BUDGET_PROGRAM, data: Uint8Array.from(price) }];
}

export interface ParsedMessage {
  version: 'legacy' | 0;
  signers: number;
  keys: string[];                // base58
  blockhash: string;             // base58
  instructions: { program: string; data: Uint8Array }[];
  computeUnitLimit: number | null;
  computeUnitPrice: bigint | null;
}

/** Enough of a Solana message to check it before sending: header, keys, blockhash, instructions. */
export function parseMessage(message: Uint8Array): ParsedMessage {
  let at = 0;
  const need = (n: number) => {
    if (at + n > message.length) throw new Error('solana: the message is truncated');
  };
  const byte = () => {
    need(1);
    return message[at++]!;
  };
  const compactU16 = () => {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = byte();
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value;
    }
    throw new Error('solana: bad compact-u16');
  };
  const bytes = (n: number) => {
    need(n);
    const out = message.subarray(at, at + n);
    at += n;
    return out;
  };
  let version: 'legacy' | 0 = 'legacy';
  if ((message[0]! & 0x80) !== 0) {
    const v = byte() & 0x7f;
    if (v !== 0) throw new Error(`solana: message version ${v} is not supported`);
    version = 0;
  }
  const signers = byte();
  byte();
  byte();
  const keyCount = compactU16();
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i++) keys.push(base58(bytes(32)));
  const blockhash = base58(bytes(32));
  const ixCount = compactU16();
  const instructions: ParsedMessage['instructions'] = [];
  let computeUnitLimit: number | null = null;
  let computeUnitPrice: bigint | null = null;
  for (let i = 0; i < ixCount; i++) {
    const programIndex = byte();
    const accounts = compactU16();
    bytes(accounts);
    const data = bytes(compactU16());
    const program = keys[programIndex];
    if (program === undefined) throw new Error(`solana: instruction ${i} names program index ${programIndex} outside the keys`);
    instructions.push({ program, data });
    if (program === COMPUTE_BUDGET_PROGRAM && data[0] === 2 && data.length === 5) computeUnitLimit = Buffer.from(data).readUInt32LE(1);
    if (program === COMPUTE_BUDGET_PROGRAM && data[0] === 3 && data.length === 9) computeUnitPrice = Buffer.from(data).readBigUInt64LE(1);
  }
  return { version, signers, keys, blockhash, instructions, computeUnitLimit, computeUnitPrice };
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyEd25519(publicKeyB58: string, message: Uint8Array, signature: Uint8Array): boolean {
  const pub = base58Decode(publicKeyB58);
  if (pub.length !== 32 || signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, pub]), format: 'der', type: 'spki' });
  return edVerify(null, message, key, signature);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`base58: bad character ${c}`);
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Buffer.from(out);
}

export interface SolanaSubmitterOptions {
  rpcUrl: string;
  network?: ChainNetwork;
  fetch?: typeof fetch;
  /** Between rebroadcasts and status polls; default 2 s. */
  rebroadcastMs?: number;
  /** Hard stop even if the RPC never says the blockhash expired; default 150 s. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

export interface SolanaSendOptions {
  /** From the getLatestBlockhash the message was built with; without it the RPC's isBlockhashValid decides. */
  lastValidBlockHeight?: number;
}

interface SignatureStatus {
  err: unknown;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
}

export class SolanaSubmitter {
  readonly #rpcUrl: string;
  readonly #network: ChainNetwork;
  readonly #fetch: typeof fetch;
  readonly #rebroadcastMs: number;
  readonly #maxWaitMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #id = 0;

  constructor(options: SolanaSubmitterOptions) {
    this.#rpcUrl = options.rpcUrl;
    this.#network = options.network ?? 'mainnet';
    this.#fetch = options.fetch ?? fetch;
    this.#rebroadcastMs = options.rebroadcastMs ?? 2_000;
    this.#maxWaitMs = options.maxWaitMs ?? 150_000;
    this.#sleep = options.sleep ?? sleep;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** The wire transaction of a one-signer message: [1][signature][message]. */
  static transaction(signed: SolSignedAction): { bytes: Buffer; signature: string; message: Buffer } {
    if (signed.signature.scheme !== 'Ed25519') throw new Error(`solana: expected an Ed25519 signature, got ${String(signed.signature.scheme)}`);
    const sig = Uint8Array.from(signed.signature.signature);
    if (sig.length !== 64 || signed.signature.signature.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
      throw new Error('solana: an Ed25519 signature is 64 bytes');
    }
    const message = Buffer.from(signed.payload.message_b64, 'base64');
    return { bytes: Buffer.concat([Buffer.from([1]), sig, message]), signature: base58(sig), message };
  }

  /** Checks, sends and rebroadcasts until confirmed; resolves with the transaction, or throws NothingExecuted. */
  async submit(signed: SolSignedAction, options: SolanaSendOptions = {}): Promise<TxRef[]> {
    const nearTx = signed.nearTx === undefined ? [] : [signed.nearTx];
    const { bytes, signature, message } = SolanaSubmitter.transaction(signed);
    const parsed = parseMessage(message);
    if (parsed.signers !== 1) throw new Error(`solana: the message needs ${parsed.signers} signatures; registration transactions go through Phoenix's API`);
    if (!verifyEd25519(parsed.keys[0]!, message, bytes.subarray(1, 65))) {
      throw new Error(`solana ${signed.kind}: the signature does not verify for ${parsed.keys[0]}; nothing sent`);
    }
    if (parsed.computeUnitLimit === null || parsed.computeUnitPrice === null || parsed.computeUnitPrice === 0n) {
      throw new Error(`solana ${signed.kind}: the message sets no compute-unit limit and priority fee; public RPCs drop it, nothing sent`);
    }
    const ref = solanaTxRef(this.#network, signature);
    const b64 = bytes.toString('base64');
    const started = this.#now();
    let lastSendError: string | null = null;
    for (;;) {
      try {
        await this.#rpc('sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]);
      } catch (err) {
        lastSendError = (err as Error).message;
      }
      const status = await this.#status(signature, false);
      if (status !== null) {
        if (status.err !== null && status.err !== undefined) {
          throw new NothingExecuted('solana', `the transaction failed on chain: ${JSON.stringify(status.err)}`, [...nearTx, ref]);
        }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return [...nearTx, ref];
      }
      if (await this.#expired(parsed.blockhash, options.lastValidBlockHeight) || this.#now() - started > this.#maxWaitMs) {
        const last = await this.#status(signature, true);
        if (last !== null && (last.err === null || last.err === undefined)
          && (last.confirmationStatus === 'confirmed' || last.confirmationStatus === 'finalized')) return [...nearTx, ref];
        const why = last?.err ? `failed on chain: ${JSON.stringify(last.err)}` : `the blockhash expired before it landed${lastSendError === null ? '' : ` (last send error: ${lastSendError})`}`;
        throw new NothingExecuted('solana', why, nearTx);
      }
      await this.#sleep(this.#rebroadcastMs);
    }
  }

  async #status(signature: string, history: boolean): Promise<SignatureStatus | null> {
    try {
      const r = await this.#rpc<{ value: (SignatureStatus | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: history }]);
      return r.value[0] ?? null;
    } catch {
      return null;
    }
  }

  async #expired(blockhash: string, lastValidBlockHeight: number | undefined): Promise<boolean> {
    try {
      if (lastValidBlockHeight !== undefined) {
        const height = await this.#rpc<number>('getBlockHeight', [{ commitment: 'confirmed' }]);
        return height > lastValidBlockHeight;
      }
      const r = await this.#rpc<{ value: boolean }>('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]);
      return r.value === false;
    } catch {
      return false;
    }
  }

  async #rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.#fetch(this.#rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const body = await res.json() as { result?: T; error?: { code?: number; message?: string } };
    if (body.error !== undefined) throw new Error(`solana ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result as T;
  }
}
