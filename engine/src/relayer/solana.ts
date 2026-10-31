// Solana submitter: the contract signed a message for the desk's authority (`sol_sign`, `sol_sign_rescue`); this
// sends it as `[1][signature][message]` and keeps sending it until it lands or its blockhash expires
// (docs/interfaces.md §1.4, CLAUDE.md "Phoenix"):
//   - the signature must verify against keys[0] (the desk authority), or nothing is sent;
//   - the message must set a compute-unit limit and a priority fee: Phoenix orders need ~190k CU, and public RPCs
//     drop transactions without a fee. The engine builds messages with computeBudgetInstructions() (400k, 100,000
//     µlamports per CU);
//   - sent with skipPreflight and maxRetries 0, then rebroadcast every 2 s while the status is polled;
//   - NothingExecuted only with proof: the transaction landed with an error (confirmed), or the chain is past the
//     message's lastValidBlockHeight (getEpochInfo: a block height and its slot, from one node) AND a history
//     lookup of the signature succeeded, found nothing, and answered from a slot at or past that one. Behind a load
//     balancer the two reads may hit different nodes; a lagging node's empty lookup proves nothing. Then it can
//     never run, and the caller may build a new one;
//   - anything short of that (an RPC error on the status or the height, a lookup from a node behind the height
//     read, no lastValidBlockHeight, maxWaitMs reached) is OutcomeUnknown with the signature: the caller reconciles
//     before it sends anything else.
// sol_sign_register transactions have two signers and are sent by Phoenix's API, not here.

import { createPublicKey, verify as edVerify } from 'node:crypto';
import type { TxRef } from '@gimbal/shared';
import type { SolSignedAction } from '../contract/types.ts';
import { OutcomeUnknown } from '../contract/types.ts';
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
  /** From the getLatestBlockhash the message was built with; without it expiry is never proven (OutcomeUnknown). */
  lastValidBlockHeight?: number;
  /** The desk's Solana authority: keys[0] must be it, or nothing is sent. */
  authority?: string;
}

/** An RPC read that may have failed: ok false is "no answer", never "nothing there". */
type Read<T> = { ok: true; value: T } | { ok: false; error: string };

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

  /** Checks, sends and rebroadcasts until confirmed; resolves with the transaction, or NothingExecuted / OutcomeUnknown. */
  async submit(signed: SolSignedAction, options: SolanaSendOptions = {}): Promise<TxRef[]> {
    const nearTx = signed.nearTx === undefined ? [] : [signed.nearTx];
    const { bytes, signature, message } = SolanaSubmitter.transaction(signed);
    const parsed = parseMessage(message);
    if (parsed.signers !== 1) throw new Error(`solana: the message needs ${parsed.signers} signatures; registration transactions go through Phoenix's API`);
    if (options.authority !== undefined && parsed.keys[0] !== options.authority) {
      throw new Error(`solana ${signed.kind}: the fee payer is ${parsed.keys[0]}, not the desk authority ${options.authority}; nothing sent`);
    }
    if (!verifyEd25519(parsed.keys[0]!, message, bytes.subarray(1, 65))) {
      throw new Error(`solana ${signed.kind}: the signature does not verify for ${parsed.keys[0]}; nothing sent`);
    }
    if (parsed.computeUnitLimit === null || parsed.computeUnitPrice === null || parsed.computeUnitPrice === 0n) {
      throw new Error(`solana ${signed.kind}: the message sets no compute-unit limit and priority fee; public RPCs drop it, nothing sent`);
    }
    const ref = solanaTxRef(this.#network, signature);
    const unknown = (detail: string) => new OutcomeUnknown(`solana ${signed.kind}`, detail, {
      solSignature: signature, ...(signed.nearTx === undefined ? {} : { nearTx: signed.nearTx.id }),
    }, [...nearTx, ref]);
    const b64 = bytes.toString('base64');
    const started = this.#now();
    let lastError: string | null = null;
    for (;;) {
      try {
        await this.#rpc('sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]);
      } catch (err) {
        lastError = `send: ${(err as Error).message}`;
      }
      const status = await this.#status(signature, false);
      if (!status.ok) lastError = status.error;
      const landed = status.ok ? verdict(status.value.status) : null;
      if (landed === 'confirmed') return [...nearTx, ref];
      if (landed !== null) throw new NothingExecuted('solana', `the transaction failed on chain: ${landed.failed}`, [...nearTx, ref]);

      const expiry = await this.#expired(parsed.blockhash, options.lastValidBlockHeight);
      if (!expiry.ok) lastError = expiry.error;
      if (expiry.ok && expiry.value.state !== 'valid') {
        const last = await this.#status(signature, true);
        const seen = last.ok ? verdict(last.value.status) : null;
        if (seen === 'confirmed') return [...nearTx, ref];
        if (seen !== null) throw new NothingExecuted('solana', `the transaction failed on chain: ${seen.failed}`, [...nearTx, ref]);
        const notFound = last.ok && last.value.status === null;
        if (expiry.value.state === 'past-last-valid-height' && notFound) {
          const behind = last.value.slot === null || last.value.slot < expiry.value.slot;
          if (!behind) {
            throw new NothingExecuted('solana', `the blockhash expired (past lastValidBlockHeight ${options.lastValidBlockHeight}) and the signature is not on chain${lastError === null ? '' : ` (last error: ${lastError})`}`, nearTx);
          }
          // The lookup came from a node that had not reached the slot the height was read at: no proof.
          lastError = `the history lookup answered at slot ${String(last.value.slot ?? 'unknown')}, behind slot ${expiry.value.slot} where the height passed lastValidBlockHeight (a lagging node)`;
        }
        if (expiry.value.state === 'rpc-says-invalid' && notFound) {
          throw unknown('the RPC says the blockhash is no longer valid and the signature is not found, but without lastValidBlockHeight that is no proof');
        }
        if (!last.ok) lastError = last.error;
      }
      if (this.#now() - started > this.#maxWaitMs) {
        throw unknown(`no proof either way after ${Math.round(this.#maxWaitMs / 1000)} s${lastError === null ? '' : ` (last error: ${lastError})`}`);
      }
      await this.#sleep(this.#rebroadcastMs);
    }
  }

  /**
   * Waits until the chain is proven past `lastValidBlockHeight` (a block height read that succeeded), up to
   * `maxWaitMs`; false when that was not proven in time. A message signed for that blockhash can then never run, so a
   * caller may sign a new one after an MPC timeout.
   */
  async waitPastLastValidHeight(lastValidBlockHeight: number, maxWaitMs = 90_000): Promise<boolean> {
    const until = this.#now() + maxWaitMs;
    for (;;) {
      const r = await this.#expired('', lastValidBlockHeight);
      if (r.ok && r.value.state === 'past-last-valid-height') return true;
      if (this.#now() >= until) return false;
      await this.#sleep(this.#rebroadcastMs);
    }
  }

  /** A signature's status, and the slot the answering node read it at (its context; null when it gave none). */
  async #status(signature: string, history: boolean): Promise<Read<{ status: SignatureStatus | null; slot: number | null }>> {
    try {
      const r = await this.#rpc<{ context?: { slot?: unknown }; value: (SignatureStatus | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: history }]);
      if (!Array.isArray(r?.value)) return { ok: false, error: 'getSignatureStatuses: no value list in the answer' };
      const slot = r.context?.slot;
      return { ok: true, value: { status: r.value[0] ?? null, slot: Number.isSafeInteger(slot) ? slot as number : null } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Whether the message's blockhash is still valid, with the slot the answer holds for. With lastValidBlockHeight,
   * getEpochInfo gives the height and its slot from the same node; else isBlockhashValid (a hint, never proof).
   */
  async #expired(blockhash: string, lastValidBlockHeight: number | undefined): Promise<Read<{ state: 'valid' | 'past-last-valid-height' | 'rpc-says-invalid'; slot: number }>> {
    try {
      if (lastValidBlockHeight !== undefined) {
        const info = await this.#rpc<{ absoluteSlot?: unknown; blockHeight?: unknown }>('getEpochInfo', [{ commitment: 'confirmed' }]);
        const { absoluteSlot, blockHeight } = info ?? {};
        if (!Number.isSafeInteger(blockHeight) || !Number.isSafeInteger(absoluteSlot)) {
          return { ok: false, error: `getEpochInfo answered ${JSON.stringify(info)?.slice(0, 120)}` };
        }
        return { ok: true, value: { state: (blockHeight as number) > lastValidBlockHeight ? 'past-last-valid-height' : 'valid', slot: absoluteSlot as number } };
      }
      const r = await this.#rpc<{ context?: { slot?: unknown }; value: boolean }>('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]);
      if (typeof r?.value !== 'boolean') return { ok: false, error: 'isBlockhashValid: no value in the answer' };
      return { ok: true, value: { state: r.value ? 'valid' : 'rpc-says-invalid', slot: Number(r.context?.slot ?? 0) } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async #rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.#fetch(this.#rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new Error(`solana ${method}: HTTP ${res.status}`);
    const body = await res.json() as { result?: T; error?: { code?: number; message?: string } };
    if (body.error !== undefined) throw new Error(`solana ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result as T;
  }
}

/** A landed signature's verdict: 'confirmed' (success, at least confirmed), a failure (confirmed), or null (not yet). */
function verdict(status: SignatureStatus | null): 'confirmed' | { failed: string } | null {
  if (status === null) return null;
  const settled = status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
  if (!settled) return null;
  return status.err === null || status.err === undefined ? 'confirmed' : { failed: JSON.stringify(status.err) };
}
