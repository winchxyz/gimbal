// How many contract calls the operator key may have in flight (docs/interfaces.md §1.3). A 300 TGas call reserves
// ~0.3 NEAR of attached gas up front (measured on mainnet 2026-10-27; the real fee is ~0.001 NEAR and the rest comes
// back), and the same 0.3 NEAR is held against the key's allowance until the refund. So before every signature the
// budget reads the account's spendable balance and the key's remaining allowance and admits the call only if both
// cover it on top of the calls already in flight; below one call with nothing in flight it stops and says so.
//
// The reads already show the reservations of in-flight calls that reached a block, so counting every in-flight call
// again is conservative: with 1 NEAR free the budget admits 2 calls at once, not 3. It never admits one too many.

import { SignatureBudgetError } from './types.ts';

export const YOCTO_PER_NEAR = 10n ** 24n;
/** NEAR's storage staking: 1e19 yocto (0.00001 NEAR) per byte the account stores. */
export const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
/** What a 300 TGas call holds while it runs: ~0.3 NEAR, i.e. 0.001 NEAR per TGas attached. */
export const RESERVE_YOCTO_PER_TGAS = YOCTO_PER_NEAR / 1000n;
export const DEFAULT_CALL_TGAS = 300;

export interface BudgetReads {
  /** view_account of the account that holds the operator key. */
  account(): Promise<{ amount: bigint; locked: bigint; storageUsage: number }>;
  /** view_access_key of the operator key: its remaining allowance; null = no allowance limit (a full-access key). */
  allowance(): Promise<bigint | null>;
}

export type NearHealth = 'ok' | 'slow' | 'down';

export interface SignatureBudgetOptions {
  reads: BudgetReads;
  /** Called when the budget runs out ('down') and when a later read shows room again ('ok'). */
  onHealth?: (status: NearHealth, detail: string) => void;
  /** How long a call may wait for an in-flight one to finish before it gives up; default 5 min. */
  maxWaitMs?: number;
  /** How often a waiting call reads again when nothing finished; default 2 s. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface BudgetRoom {
  spendable: bigint;             // balance minus storage staking, yocto
  allowance: bigint | null;      // the key's remaining allowance, yocto; null = unlimited
  room: bigint;                  // min of the two
  inFlight: number;
}

/** Spendable balance: what the account holds above its storage staking (locked stake counts towards that). */
export function spendable(account: { amount: bigint; locked: bigint; storageUsage: number }): bigint {
  const staking = BigInt(account.storageUsage) * STORAGE_YOCTO_PER_BYTE;
  const owed = staking > account.locked ? staking - account.locked : 0n;
  return account.amount > owed ? account.amount - owed : 0n;
}

export function reserveFor(tgas: number): bigint {
  return BigInt(Math.ceil(tgas)) * RESERVE_YOCTO_PER_TGAS;
}

export function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const milli = (yocto % YOCTO_PER_NEAR) / (YOCTO_PER_NEAR / 1000n);
  return `${whole}.${milli.toString().padStart(3, '0')} NEAR`;
}

export class SignatureBudget {
  readonly #reads: BudgetReads;
  readonly #onHealth: (status: NearHealth, detail: string) => void;
  readonly #maxWaitMs: number;
  readonly #pollMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #inFlight: bigint[] = [];
  #down = false;
  #waiters: (() => void)[] = [];

  constructor(options: SignatureBudgetOptions) {
    this.#reads = options.reads;
    this.#onHealth = options.onHealth ?? (() => {});
    this.#maxWaitMs = options.maxWaitMs ?? 300_000;
    this.#pollMs = options.pollMs ?? 2_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = options.now ?? Date.now;
  }

  get inFlight(): number {
    return this.#inFlight.length;
  }

  /** The room a call would see now. */
  async room(): Promise<BudgetRoom> {
    const [account, allowance] = await Promise.all([this.#reads.account(), this.#reads.allowance()]);
    const free = spendable(account);
    const room = allowance === null || free < allowance ? free : allowance;
    return { spendable: free, allowance, room, inFlight: this.#inFlight.length };
  }

  /**
   * Waits until a call of `tgas` fits, then counts it in flight; the returned function releases it (call it once the
   * transaction has its outcome, success or not). Throws SignatureBudgetError, after raising 'down', when even one
   * call does not fit with nothing in flight, or when the wait runs past maxWaitMs.
   */
  async acquire(tgas: number = DEFAULT_CALL_TGAS): Promise<() => void> {
    const need = reserveFor(tgas);
    const started = this.#now();
    for (;;) {
      const r = await this.room();
      const held = this.#inFlight.reduce((sum, x) => sum + x, 0n);
      if (r.room >= held + need) {
        if (this.#down) {
          this.#down = false;
          this.#onHealth('ok', `operator key can pay for signatures again: ${describe(r)}`);
        }
        this.#inFlight.push(need);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const i = this.#inFlight.indexOf(need);
          if (i >= 0) this.#inFlight.splice(i, 1);
          const waiters = this.#waiters;
          this.#waiters = [];
          for (const w of waiters) w();
        };
      }
      if (this.#inFlight.length === 0) {
        const detail = `operator key cannot pay for one more signature (${formatNear(need)} each): ${describe(r)}`;
        this.#down = true;
        this.#onHealth('down', detail);
        throw new SignatureBudgetError(detail);
      }
      if (this.#now() - started > this.#maxWaitMs) {
        throw new SignatureBudgetError(`waited ${Math.round((this.#now() - started) / 1000)} s for a signature slot: ${describe(r)}`);
      }
      // A slot frees when an in-flight call ends; read again then, or after pollMs (a top-up, a refund).
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        this.#waiters.push(finish);
        void this.#sleep(this.#pollMs).then(finish);
      });
    }
  }
}

function describe(r: BudgetRoom): string {
  const allowance = r.allowance === null ? 'no allowance limit' : `allowance ${formatNear(r.allowance)}`;
  return `spendable ${formatNear(r.spendable)}, ${allowance}, ${r.inFlight} in flight`;
}
