// What the rescue reads on NEAR to tell whether a held payment was ever signed (E9): the time of a final block and,
// at that same block, the desk's get_desk_counters (C10): its deposit ring (sha256 hex of the deposit address of each
// of the desk's last 32 rescues, as the contract's verified quote has it: lowercase for EVM, base58 for Solana) with
// when each was paid, the rescue window's start and the next EIP-3009 counter. Read-only.
//
// The ring is written when the contract signs a rescue (spend), and a quote pays once: an address in the ring was
// signed exactly once, at its paid time. A slot is reused only by a later rescue, in ring order, so an address that
// is no longer there was pushed out by 32 later ones; while any slot is empty or older than a hold, the hold's address
// cannot have been pushed out. Before C10 is deployed the view is absent (counters null) and only the block time is
// read.

import { createHash } from 'node:crypto';
import { NearViewTransport } from '../contract/near-transport.ts';
import type { NearViewTransportOptions } from '../contract/near-transport.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';

/** get_desk_counters as the rescue reads it. */
export interface NearDeskCounters {
  eip3009Next: bigint;
  /** The rescue window's start (the last rescue or hl_withdraw counted), ms; 0 before the first. */
  rescueAtMs: number;
  /** sha256 hex of each slot's deposit address; null for a slot never used. */
  deposits: (string | null)[];
  /** When each slot was paid, ms (NEAR block time). */
  depositPaidMs: number[];
}

/** One NEAR read: a final block's height and time, and the desk's counters at that block. */
export interface NearRead {
  height: number;
  timeMs: number;
  /** null: the contract has no get_desk_counters (before C10). A desk with no counters yet reads as an empty ring. */
  counters: NearDeskCounters | null;
}

/** The ring's key for a deposit address: sha256 hex of its bytes as the contract's verified quote has them. */
export function depositKey(method: string, depositAddress: string): string {
  const form = method === 'evm_usdc_to_intents' || method === 'hl_send_to_intents' ? depositAddress.toLowerCase() : depositAddress;
  return createHash('sha256').update(form, 'utf8').digest('hex');
}

/** The ring slot of a deposit address, with when it was paid; null: not in the ring. */
export function ringEntry(c: NearDeskCounters, key: string): { paidMs: number } | null {
  const i = c.deposits.findIndex((d) => d !== null && d.toLowerCase() === key);
  return i === -1 ? null : { paidMs: c.depositPaidMs[i] ?? 0 };
}

/** Whether an address paid at or after `sinceMs` would still be in the ring: some slot is empty or older. */
export function ringHolds(c: NearDeskCounters, sinceMs: number): boolean {
  return c.deposits.some((d, i) => d === null || (c.depositPaidMs[i] ?? 0) < sinceMs);
}

/** Why GIMBAL_RESCUE_FRESH must not start an empty state now: a rescue counted within `withinMs` of the block time. */
export function recentRescue(n: NearRead, withinMs = 3_600_000): string | null {
  const c = n.counters;
  if (c === null) return null;
  const recent = [c.rescueAtMs, ...c.depositPaidMs].filter((t) => t > 0 && n.timeMs - t < withinMs);
  if (recent.length === 0) return null;
  const last = Math.max(...recent);
  return `the contract counted a rescue of this desk at ${new Date(last).toISOString()}, under ${Math.round(withinMs / 60_000)} min before NEAR block ${n.height}: `
    + 'a payment of an earlier run may still be held; reconcile it, then start with GIMBAL_RESCUE_FRESH after that hour';
}

function num(v: unknown, what: string): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error(`get_desk_counters: ${what} is not a whole number`);
  return n;
}

/** get_desk_counters' JSON (C10's DeskCountersView) as the rescue reads it; null (no desk counters yet): an empty ring. */
export function parseDeskCounters(raw: unknown): NearDeskCounters {
  if (raw === null || raw === undefined) return { eip3009Next: 0n, rescueAtMs: 0, deposits: [], depositPaidMs: [] };
  if (typeof raw !== 'object') throw new Error('get_desk_counters: not an object');
  const r = raw as Record<string, unknown>;
  const next = r.eip3009_next;
  // A JSON number (C10 writes the u64 as one) must be a safe whole number; a string is taken as decimal digits.
  if (!((typeof next === 'number' && Number.isSafeInteger(next) && next >= 0) || (typeof next === 'string' && /^\d+$/.test(next)))) {
    throw new Error('get_desk_counters: eip3009_next is not a whole number');
  }
  if (!Array.isArray(r.deposits) || !Array.isArray(r.deposit_paid_ms) || r.deposits.length !== r.deposit_paid_ms.length) {
    throw new Error('get_desk_counters: deposits and deposit_paid_ms are not two lists of one length');
  }
  const deposits = r.deposits.map((d, i) => {
    if (d === null) return null;
    if (typeof d !== 'string' || !/^[0-9a-f]{64}$/i.test(d)) throw new Error(`get_desk_counters: deposits[${i}] is not sha256 hex`);
    return d.toLowerCase();
  });
  return {
    eip3009Next: BigInt(String(next)), rescueAtMs: num(r.rescue_at_ms, 'rescue_at_ms'), deposits,
    depositPaidMs: r.deposit_paid_ms.map((t, i) => num(t, `deposit_paid_ms[${i}]`)),
  };
}

/** The live reader: viewBlock final, then get_desk_counters at that block. */
export class NearDeskReads extends NearViewTransport {
  readonly #contractId: string;
  readonly #deskId: string;

  constructor(options: NearViewTransportOptions & { contractId: string; deskId: string }) {
    super(options);
    this.#contractId = options.contractId;
    this.#deskId = options.deskId;
  }

  async read(): Promise<NearRead> {
    const b = await this.safe(this.provider.viewBlock({ finality: 'final' }));
    const height = Number(b.header.height);
    const timeMs = Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
    let counters: NearDeskCounters | null;
    try {
      const raw = await this.safe(this.provider.callFunction({ contractId: this.#contractId, method: 'get_desk_counters', args: { desk_id: this.#deskId }, blockQuery: { blockId: height } }));
      counters = parseDeskCounters(raw ?? null);
    } catch (err) {
      // Before C10 the contract has no such view: only the block time is read.
      if (!/MethodNotFound|MethodResolveError/.test(errorMessage(err))) throw err;
      counters = null;
    }
    return { height, timeMs, counters };
  }
}

/** NEAR in memory for the recorded worlds and the tests: the clock is the block time, the ring is written by spend(). */
export class SimulatedNear {
  readonly #clock: Clock;
  /** false: the contract has no get_desk_counters (before C10). */
  view = true;
  /** Reads fail while set. */
  down: string | null = null;
  eip3009Next = 0n;
  rescueAtMs = 0;
  readonly deposits: (string | null)[] = Array.from({ length: 32 }, () => null);
  readonly depositPaidMs: number[] = Array.from({ length: 32 }, () => 0);
  #next = 0;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** The contract counted a rescue of `depositAddress` (its sign call ran), now or at `atMs`. */
  spend(method: string, depositAddress: string, atMs?: number): void {
    const at = atMs ?? this.#clock.now();
    this.deposits[this.#next] = depositKey(method, depositAddress);
    this.depositPaidMs[this.#next] = at;
    this.#next = (this.#next + 1) % this.deposits.length;
    this.rescueAtMs = at;
    if (method === 'evm_usdc_to_intents') this.eip3009Next++;
  }

  async read(): Promise<NearRead> {
    if (this.down !== null) throw new Error(this.down);
    const timeMs = this.#clock.now();
    return {
      height: Math.floor(timeMs / 1000), timeMs,
      counters: this.view ? { eip3009Next: this.eip3009Next, rescueAtMs: this.rescueAtMs, deposits: [...this.deposits], depositPaidMs: [...this.depositPaidMs] } : null,
    };
  }
}
