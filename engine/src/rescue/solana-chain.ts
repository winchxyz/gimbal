// What the rescue reads on Solana to tell whether a sol_sign_rescue that may have been signed can still land (E9).
// A Solana transaction carries a recent blockhash and is accepted only while the cluster's block height is at most
// that blockhash's lastValidBlockHeight. Once the finalized height is past it, the transaction can never be included
// in a later block; if the cluster then does not know its signature (searching its history), it never landed and
// never will. The rescuer saves lastValidBlockHeight before it asks the contract to sign (the payer's prepare) and the
// signature once it has it. The status must come from a node at or past the slot the height was read at (its answer's
// context slot), as relayer/solana.ts checks: a lagging node's "unknown" is no proof. Read-only.
//
// RpcSolanaReads is the live reader on a Solana JSON-RPC URL; SimulatedSolana is the same in memory for the recorded
// worlds and the tests.

import { redactError } from '../redact.ts';
import type { Clock } from '../venues/venue.ts';

export interface SolanaReads {
  /** The cluster's finalized block height, and the slot it was read at. */
  finalized(): Promise<{ height: number; slot: number }>;
  /**
   * Whether the cluster knows the transaction signature (landed, ok or failed), searching its history, and the slot
   * the answering node read it at (null: its answer gave none).
   */
  signatureStatus(signature: string): Promise<{ known: boolean; slot: number | null }>;
}

/**
 * Solana JSON-RPC (getEpochInfo, getSignatureStatuses); every answer that is not the expected shape is an error.
 * The URL must serve transaction history (searchTransactionHistory): a node that keeps only its recent status cache
 * answers null for an older signature that did land, which would read as never landed.
 */
export class RpcSolanaReads implements SolanaReads {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  #id = 0;

  constructor(options: { rpcUrl: string; fetch?: typeof fetch }) {
    this.#url = options.rpcUrl;
    this.#fetch = options.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  async #call(method: string, params: unknown[]): Promise<unknown> {
    try {
      const res = await this.#fetch(this.#url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
      });
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const body = await res.json() as { result?: unknown; error?: { message?: unknown } };
      if (body.error !== undefined) throw new Error(`${method}: ${String(body.error.message ?? JSON.stringify(body.error))}`);
      return body.result;
    } catch (err) {
      throw redactError(err, this.#url);
    }
  }

  async finalized(): Promise<{ height: number; slot: number }> {
    const r = await this.#call('getEpochInfo', [{ commitment: 'finalized' }]) as { blockHeight?: unknown; absoluteSlot?: unknown } | null;
    const { blockHeight, absoluteSlot } = r ?? {};
    if (!Number.isSafeInteger(blockHeight) || !Number.isSafeInteger(absoluteSlot) || (blockHeight as number) < 0) {
      throw new Error('getEpochInfo: not a block height and slot');
    }
    return { height: blockHeight as number, slot: absoluteSlot as number };
  }

  async signatureStatus(signature: string): Promise<{ known: boolean; slot: number | null }> {
    const r = await this.#call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]) as { context?: { slot?: unknown }; value?: unknown };
    if (!Array.isArray(r?.value) || r.value.length !== 1) throw new Error('getSignatureStatuses: not one status');
    const slot = r.context?.slot;
    return { known: r.value[0] !== null, slot: Number.isSafeInteger(slot) ? slot as number : null };
  }
}

/** Solana in memory: a block height (and slot) that grows with the clock (one per 400 ms, finalized 32 behind) and landed signatures. */
export class SimulatedSolana implements SolanaReads {
  readonly #clock: Clock;
  readonly #landed = new Set<string>();
  /** Reads fail while set. */
  down: string | null = null;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** The height of the newest block now (what a fresh blockhash's lastValidBlockHeight is counted from). */
  heightNow(): number {
    return Math.floor(this.#clock.now() / 400);
  }

  land(signature: string): void {
    this.#landed.add(signature);
  }

  /** The slot the status answers come from, relative to the finalized one (a lagging node: negative). */
  statusLag = 0;

  async finalized(): Promise<{ height: number; slot: number }> {
    if (this.down !== null) throw new Error(this.down);
    return { height: this.heightNow() - 32, slot: this.heightNow() - 32 };
  }

  async signatureStatus(signature: string): Promise<{ known: boolean; slot: number | null }> {
    if (this.down !== null) throw new Error(this.down);
    return { known: this.#landed.has(signature), slot: this.heightNow() - 32 + this.statusLag };
  }
}
