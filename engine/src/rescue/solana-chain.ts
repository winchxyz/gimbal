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

  /**
   * Why this RPC cannot back the Solana hold rule, or null when it can: it must find, with searchTransactionHistory,
   * a finalized signature at least HISTORY_PROBE_MIN_AGE_SLOTS old, far past any node's recent status cache (300
   * slots). The signature is the oldest of the last 1,000 that name `probeAddress` (default Phoenix's withdraw queue:
   * a few hundred a day, so the oldest is days old); a node without history answers null for it.
   */
  async historyProblem(probeAddress = HISTORY_PROBE_ADDRESS): Promise<string | null> {
    try {
      const f = await this.finalized();
      let before: string | undefined;
      for (let page = 0; page < 3; page++) {
        const list = await this.#call('getSignaturesForAddress', [probeAddress, { limit: 1000, commitment: 'finalized', ...(before === undefined ? {} : { before }) }]);
        if (!Array.isArray(list) || list.length === 0) return `getSignaturesForAddress(${probeAddress}) gave no signatures to probe the history with`;
        const oldest = list.at(-1) as { signature?: unknown; slot?: unknown };
        if (typeof oldest.signature !== 'string' || !Number.isSafeInteger(oldest.slot)) return 'getSignaturesForAddress: not a signature and slot';
        const age = f.slot - (oldest.slot as number);
        if (age < HISTORY_PROBE_MIN_AGE_SLOTS) {
          before = oldest.signature;
          continue;
        }
        const st = await this.signatureStatus(oldest.signature);
        if (!st.known) return `getSignatureStatuses with searchTransactionHistory does not find ${oldest.signature} (${age} slots old): this RPC serves no transaction history`;
        return null;
      }
      return `no signature of ${probeAddress} at least ${HISTORY_PROBE_MIN_AGE_SLOTS} slots old among its last 3,000: the history could not be probed`;
    } catch (err) {
      return `the history probe failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/** Phoenix's withdraw queue (phoenix-tx.ts PHOENIX_MAINNET.withdrawQueue): the history probe's address. */
export const HISTORY_PROBE_ADDRESS = '3c3NTwpg7yW91FxijkHBXwVH1xUifun3Z8TC5eW5Si3K';
/** How old the probed signature must be, slots (about 67 min): far past a node's recent status cache. */
export const HISTORY_PROBE_MIN_AGE_SLOTS = 10_000;

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
