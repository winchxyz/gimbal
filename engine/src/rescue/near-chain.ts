// What the rescue reads on NEAR to tell whether a held payment was ever signed or paid (E9), all at one final block:
// the block's time; the desk's get_desk_counters (C10), its deposit ring (sha256 hex of the deposit address of each of
// the desk's last 32 rescues, as the contract's verified quote has it: lowercase for EVM, base58 for Solana) with when
// each was paid, the rescue window's start and the next EIP-3009 counter; and the desk's fund_venue ring (the same
// record shape, kept apart by the contract so funding never uses up the rescues' ring), read from the contract state
// (view_state, FundCounters) because no view method returns it. And, for a fund_venue whose transaction is known, that
// transaction's final outcome: whether a USDC transfer to the deposit address ran in it. Read-only.
//
// A ring is written when the contract counts a payment (rescue signed, fund_venue sent), and a quote pays once: an
// address in the ring was counted exactly once, at its paid time. A slot is reused only by a later payment, in ring
// order, so an address that is no longer there was pushed out by 32 later ones; while any slot is empty or older than
// a hold, the hold's address cannot have been pushed out. Before C10 is deployed the view is absent (counters null);
// the fund_venue ring is in the state since C8.
//
// get_desk_counters answers null both for a desk with no counters yet and for a desk the contract does not have, so a
// null is read as an empty ring only after get_desk at the same block shows the desk; otherwise it is an error.

import { createHash } from 'node:crypto';
import { NearViewTransport } from '../contract/near-transport.ts';
import type { NearViewTransportOptions } from '../contract/near-transport.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';

/** A first run waits this long after the desk's last payment or rescuer trace: a NEAR call sent before then lands by signedAt + 65 min (the contract's QUOTE_PAYABLE_MS). */
export const FRESH_WAIT_MS = 65 * 60_000;
/** The contract's storage prefix of the fund_venue counters (contract/src/lib.rs StorageKey::FundCounters). */
export const FUND_COUNTERS_PREFIX = 8;
/** The borsh size of one DeskCounters record (contract/src/rescue.rs). */
export const COUNTERS_RECORD_BYTES = 1329;

/** A desk's counters as the rescue reads them: get_desk_counters, or the fund_venue record. */
export interface NearDeskCounters {
  eip3009Next: bigint;
  /** The meters' window start (the last payment counted), ms; 0 before the first. */
  rescueAtMs: number;
  /** sha256 hex of each slot's deposit address; null for a slot never used. */
  deposits: (string | null)[];
  /** When each slot was paid, ms (NEAR block time). */
  depositPaidMs: number[];
}

/** One NEAR read: a final block's height and time, and the desk's rings at that block. */
export interface NearRead {
  height: number;
  timeMs: number;
  /** get_desk_counters; null: the contract has no such view (before C10). A desk with no counters yet reads as an empty ring. */
  counters: NearDeskCounters | null;
  /** The fund_venue ring; null: it could not be read (fundError says why). A desk with no fund_venue yet reads as an empty ring. */
  fund: NearDeskCounters | null;
  fundError: string | null;
}

/** One USDC (NEP-141) transfer a NEAR transaction made, from its receipts' ft_transfer events. */
export interface FtTransfer {
  from: string;
  to: string;
  amount: bigint;
}

/** A NEAR transaction's outcome as the rescue needs it. */
export interface NearTxFacts {
  /** Every receipt of it executed and final: nothing more of it can run. */
  final: boolean;
  /** The ft_transfer events of its receipts that succeeded. */
  ftTransfers: FtTransfer[];
}

const EMPTY = (): NearDeskCounters => ({ eip3009Next: 0n, rescueAtMs: 0, deposits: [], depositPaidMs: [] });

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
  return c.deposits.length === 0 || c.deposits.some((d, i) => d === null || (c.depositPaidMs[i] ?? 0) < sinceMs);
}

/**
 * Why GIMBAL_RESCUE_FRESH must not start an empty state now: a rescue or a fund_venue counted within `withinMs` of the
 * block time, or the fund_venue ring unreadable. Null: nothing recent (or no view: serve warns).
 */
export function recentRescue(n: NearRead, withinMs = FRESH_WAIT_MS): string | null {
  const min = Math.round(withinMs / 60_000);
  if (n.fund === null) return `the desk's fund_venue ring on NEAR could not be read (${n.fundError ?? 'unknown'}), so a fund_venue of the last ${min} min cannot be ruled out`;
  const recent: [string, number][] = [];
  for (const [what, c] of [['rescue', n.counters], ['fund_venue', n.fund]] as const) {
    if (c === null) continue;
    for (const t of [c.rescueAtMs, ...c.depositPaidMs]) if (t > 0 && n.timeMs - t < withinMs) recent.push([what, t]);
  }
  if (recent.length === 0) return null;
  const [what, last] = recent.reduce((a, b) => (b[1] > a[1] ? b : a));
  return `the contract counted a ${what} of this desk at ${new Date(last).toISOString()}, under ${min} min before NEAR block ${n.height}: `
    + `a payment of an earlier run may still be held; reconcile it, then start with GIMBAL_RESCUE_FRESH once ${min} min have passed`;
}

function num(v: unknown, what: string): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error(`get_desk_counters: ${what} is not a whole number`);
  return n;
}

/** get_desk_counters' JSON (C10's DeskCountersView) as the rescue reads it; null or anything else is an error. */
export function parseDeskCounters(raw: unknown): NearDeskCounters {
  if (raw === null || raw === undefined) throw new Error('get_desk_counters answered null');
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

/**
 * One DeskCounters record as the contract stores it (borsh, contract/src/rescue.rs): rescue_at_ms u64, two u128
 * meters, eip3009_next u64, 32 sha256 deposits (all zero: unused), deposit_next u8, 32 paid times u64.
 */
export function decodeCountersRecord(buf: Uint8Array): NearDeskCounters {
  if (buf.length !== COUNTERS_RECORD_BYTES) throw new Error(`a counters record is ${buf.length} bytes, not ${COUNTERS_RECORD_BYTES}`);
  const v = Buffer.from(buf.buffer, buf.byteOffset, buf.length);
  const time = (n: bigint, what: string): number => {
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`a counters record's ${what} ${n} is not a time in ms`);
    return Number(n);
  };
  const deposits: (string | null)[] = [];
  const depositPaidMs: number[] = [];
  for (let i = 0; i < 32; i++) {
    const h = v.subarray(48 + 32 * i, 80 + 32 * i);
    deposits.push(h.every((b) => b === 0) ? null : h.toString('hex'));
    depositPaidMs.push(time(v.readBigUInt64LE(1073 + 8 * i), `deposit_paid_ms[${i}]`));
  }
  return { eip3009Next: v.readBigUInt64LE(40), rescueAtMs: time(v.readBigUInt64LE(0), 'rescue_at_ms'), deposits, depositPaidMs };
}

/** The contract-state key of a desk's record under `prefix`: the prefix byte, then the desk id as a borsh string. */
export function deskRecordKey(prefix: number, deskId: string): Buffer {
  const id = Buffer.from(deskId, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(id.length);
  return Buffer.concat([Buffer.from([prefix]), len, id]);
}

/** A NEAR transaction's final outcome (the `tx` RPC answer) as NearTxFacts. */
export function txFactsOf(raw: unknown): NearTxFacts {
  const r = (raw ?? {}) as { final_execution_status?: unknown; receipts_outcome?: unknown };
  if (!Array.isArray(r.receipts_outcome)) throw new Error('the transaction outcome has no receipts_outcome');
  const ftTransfers: FtTransfer[] = [];
  for (const ro of r.receipts_outcome as { outcome?: { status?: unknown; logs?: unknown } }[]) {
    const status = ro.outcome?.status;
    // A receipt that failed changed nothing, whatever it logged before it failed.
    const ok = typeof status === 'object' && status !== null && ('SuccessValue' in status || 'SuccessReceiptId' in status);
    const logs = ro.outcome?.logs;
    if (!ok || !Array.isArray(logs)) continue;
    for (const log of logs) {
      if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
      let e: { standard?: unknown; event?: unknown; data?: unknown };
      try {
        e = JSON.parse(log.slice('EVENT_JSON:'.length)) as typeof e;
      } catch {
        continue;
      }
      if (e.standard !== 'nep141' || e.event !== 'ft_transfer' || !Array.isArray(e.data)) continue;
      for (const d of e.data as Record<string, unknown>[]) {
        if (typeof d.old_owner_id !== 'string' || typeof d.new_owner_id !== 'string' || typeof d.amount !== 'string' || !/^\d+$/.test(d.amount)) continue;
        ftTransfers.push({ from: d.old_owner_id, to: d.new_owner_id, amount: BigInt(d.amount) });
      }
    }
  }
  return { final: r.final_execution_status === 'FINAL', ftTransfers };
}

/** view_state, which the transports' provider type leaves out (JsonRpcProvider has it as query). */
interface StateQuery {
  query(params: Record<string, unknown>): Promise<{ values?: { key: string; value: string }[] }>;
}

/** The live reader: viewBlock final, then get_desk_counters and the fund_venue record at that block. */
export class NearDeskReads extends NearViewTransport {
  readonly #contractId: string;
  readonly #deskId: string;
  readonly #signerId: string | null;

  constructor(options: NearViewTransportOptions & { contractId: string; deskId: string; signerId?: string }) {
    super(options);
    this.#contractId = options.contractId;
    this.#deskId = options.deskId;
    this.#signerId = options.signerId ?? null;
  }

  async read(): Promise<NearRead> {
    const b = await this.safe(this.provider.viewBlock({ finality: 'final' }));
    const height = Number(b.header.height);
    const timeMs = Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
    const at = { blockQuery: { blockId: height } };
    let counters: NearDeskCounters | null;
    try {
      const raw = await this.safe(this.provider.callFunction({ contractId: this.#contractId, method: 'get_desk_counters', args: { desk_id: this.#deskId }, ...at }));
      if (raw === null || raw === undefined) {
        // No counters record: a desk never rescued, or no such desk. Only the first is an empty ring.
        const desk = await this.safe(this.provider.callFunction({ contractId: this.#contractId, method: 'get_desk', args: { desk_id: this.#deskId }, ...at }));
        if (desk === null || desk === undefined) throw new Error(`get_desk_counters: the contract ${this.#contractId} has no desk ${this.#deskId}`);
        counters = EMPTY();
      } else {
        counters = parseDeskCounters(raw);
      }
    } catch (err) {
      // Before C10 the contract has no such view: only the block time and the fund_venue ring are read.
      if (!/MethodNotFound|MethodResolveError/.test(errorMessage(err))) throw err;
      counters = null;
    }
    let fund: NearDeskCounters | null = null;
    let fundError: string | null = null;
    try {
      fund = await this.#fundRing(height);
    } catch (err) {
      fundError = errorMessage(err);
    }
    return { height, timeMs, counters, fund, fundError };
  }

  /** The desk's fund_venue record at `height`, from the contract state; none yet: an empty ring. */
  async #fundRing(height: number): Promise<NearDeskCounters> {
    const key = deskRecordKey(FUND_COUNTERS_PREFIX, this.#deskId);
    const q = this.provider as unknown as StateQuery;
    const r = await this.safe(q.query({ request_type: 'view_state', account_id: this.#contractId, prefix_base64: key.toString('base64'), block_id: height }));
    if (!Array.isArray(r.values)) throw new Error('view_state answered no values');
    const hit = r.values.filter((v) => Buffer.from(v.key, 'base64').equals(key));
    if (hit.length > 1) throw new Error('view_state answered two fund_venue records for one desk');
    return hit.length === 0 ? EMPTY() : decodeCountersRecord(Buffer.from(hit[0]!.value, 'base64'));
  }

  /** The final outcome of a transaction the operator sent (waits for FINAL; an RPC timeout is an error, never "not final"). */
  async txFacts(hash: string): Promise<NearTxFacts> {
    if (this.#signerId === null) throw new Error('no signer account to read its transactions by');
    return txFactsOf(await this.safe(this.provider.viewTransactionStatus({ txHash: hash, accountId: this.#signerId, waitUntil: 'FINAL' })));
  }
}

/** One ring in memory, written in slot order like the contract's. */
class SimulatedRing {
  readonly deposits: (string | null)[] = Array.from({ length: 32 }, () => null);
  readonly depositPaidMs: number[] = Array.from({ length: 32 }, () => 0);
  atMs = 0;
  #next = 0;

  spend(key: string, at: number): void {
    this.deposits[this.#next] = key;
    this.depositPaidMs[this.#next] = at;
    this.#next = (this.#next + 1) % this.deposits.length;
    this.atMs = at;
  }
}

/** NEAR in memory for the recorded worlds and the tests: the clock is the block time, the rings are written by spend(). */
export class SimulatedNear {
  readonly #clock: Clock;
  /** false: the contract has no get_desk_counters (before C10). */
  view = true;
  /** Reads fail while set. */
  down: string | null = null;
  /** The fund_venue ring's read fails while set. */
  fundDown: string | null = null;
  eip3009Next = 0n;
  readonly #rescue = new SimulatedRing();
  readonly #fund = new SimulatedRing();
  /** Transactions by hash, as txFacts answers them. */
  readonly txs = new Map<string, NearTxFacts>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  get deposits(): readonly (string | null)[] {
    return this.#rescue.deposits;
  }

  get rescueAtMs(): number {
    return this.#rescue.atMs;
  }

  /** The contract counted a rescue of `depositAddress` (its sign call ran), now or at `atMs`. */
  spend(method: string, depositAddress: string, atMs?: number): void {
    this.#rescue.spend(depositKey(method, depositAddress), atMs ?? this.#clock.now());
    if (method === 'evm_usdc_to_intents') this.eip3009Next++;
  }

  /** The contract counted a fund_venue to `depositAddress` (its call ran up to the transfer), now or at `atMs`. */
  fundSpend(depositAddress: string, atMs?: number): void {
    this.#fund.spend(depositKey('fund_venue', depositAddress), atMs ?? this.#clock.now());
  }

  async read(): Promise<NearRead> {
    if (this.down !== null) throw new Error(this.down);
    const timeMs = this.#clock.now();
    const ring = (r: SimulatedRing, next: bigint): NearDeskCounters => ({ eip3009Next: next, rescueAtMs: r.atMs, deposits: [...r.deposits], depositPaidMs: [...r.depositPaidMs] });
    return {
      height: Math.floor(timeMs / 1000), timeMs,
      counters: this.view ? ring(this.#rescue, this.eip3009Next) : null,
      fund: this.fundDown === null ? ring(this.#fund, 0n) : null,
      fundError: this.fundDown,
    };
  }

  async txFacts(hash: string): Promise<NearTxFacts> {
    if (this.down !== null) throw new Error(this.down);
    const f = this.txs.get(hash);
    if (f === undefined) throw new Error(`no transaction ${hash}`);
    return f;
  }
}
