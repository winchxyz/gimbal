// Hyperliquid submitter: posts a contract-signed action to /exchange (docs/interfaces.md §1.4) and confirms it.
//   1. the signature is turned into {r, s, v} and recovered over the digest of the payload it came with; it must be
//      the desk's master address, or nothing is posted;
//   2. POST /exchange with the payload as the contract returned it, plus the signature;
//   3. the answer is read per action: an order's status (filled / resting / error), a cancel's, or "ok";
//   4. a fill is confirmed in userFillsByTime (its transaction hash is the explorer link); a transfer in the ledger.
// An order that filled nothing (an IOC with no match, a size under the minimum) is NothingExecuted. Hyperliquid's
// own refusal ({"status":"err"}, an HTTP 4xx) is HlExchangeError. When /exchange gives no answer (a timeout, a
// dropped connection, a 5xx, a body that is not JSON) the action may have run: OutcomeUnknown with its cloid and
// nonce. Once /exchange has answered, a failing /info read only leaves the result unconfirmed (confirmed: false).
// Every post (the /exchange one and the confirming /info reads) is charged to the host's weight budget as it goes,
// never waiting for it (HyperliquidSubmitterOptions.budget).

import type { TxRef } from '@gimbal/shared';
import type { HlSignedAction, OutcomeIds } from '../contract/types.ts';
import { OutcomeUnknown } from '../contract/types.ts';
import type { HostBudget } from '../venues/http-budget.ts';
import { HL_MAINNET_URL, HL_TESTNET_URL, hlMeteredFetch, hlTradeFetch } from '../venues/hyperliquid.ts';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import type { HlNetwork } from './hl-wire.ts';
import { exchangeBody, hlSignature, payloadDigest, recoverSigner } from './hl-wire.ts';
import { NothingExecuted, hyperliquidTxRef, sleep } from './tx.ts';

export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: string;                 // "B" buy, "A" sell
  time: number;
  hash: string;
  oid: number;
  tid?: number;
  fee?: string;
  builderFee?: string;
  cloid?: string | null;
}

export interface HlSubmitResult {
  kind: string;
  /** The per-item statuses Hyperliquid answered (orders and cancels); [] for other actions. */
  statuses: unknown[];
  /** The order id of a single order, filled or resting. */
  oid: number | null;
  /** What the first order filled, as Hyperliquid's answer says. */
  filled: { totalSz: string; avgPx: string } | null;
  resting: boolean;
  /** The fills found in userFillsByTime for that order. */
  fills: HlFill[];
  /** The NEAR signature first, then the Hyperliquid transactions it produced. */
  tx: TxRef[];
  /** False when Hyperliquid accepted it but the fill or ledger entry did not show up within confirmMs (or /info failed). */
  confirmed: boolean;
  /** The signed action's expiresAfter (ms; the contract stamps orders and cancels from C6 on), null without one. */
  expiresAfter: number | null;
}

/** Hyperliquid refused the whole action (`{"status":"err"}`) or did not answer as expected. */
export class HlExchangeError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'HlExchangeError';
    this.status = status;
    this.body = body;
  }
}

export interface HyperliquidSubmitterOptions {
  network: HlNetwork;
  /** API root, without /exchange; default by network. */
  apiUrl?: string;
  fetch?: typeof fetch;
  /**
   * The host's weight budget, which every post here is charged to without waiting for it (venues/hyperliquid.ts
   * hlMeteredFetch): an order or cancel is never held up, but the scanner's reads back off after it. Default: the
   * one the host's readers share in this process, unless a `fetch` is passed (tests), which then goes without one;
   * null: none.
   */
  budget?: HostBudget | null;
  clock?: Clock;
  timeoutMs?: number;
  /** How long to look for the fill or ledger entry after a success; default 15 s. */
  confirmMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const ZERO_HASH = /^0x0{64}$/;

export class HyperliquidSubmitter {
  readonly network: HlNetwork;
  readonly apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #confirmMs: number;
  readonly #pollMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: HyperliquidSubmitterOptions) {
    this.network = options.network;
    this.apiUrl = (options.apiUrl ?? (options.network === 'mainnet' ? HL_MAINNET_URL : HL_TESTNET_URL)).replace(/\/+$/, '');
    const inner = options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
    this.#fetch = options.budget !== undefined ? hlMeteredFetch(options.budget, inner)
      : options.fetch === undefined ? hlTradeFetch(this.apiUrl, inner) : inner;
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#confirmMs = options.confirmMs ?? 15_000;
    this.#pollMs = options.pollMs ?? 1_000;
    this.#sleep = options.sleep ?? sleep;
  }

  /** Checks, posts and confirms one signed action of the desk whose master address is `deskAddress`. */
  async submit(signed: HlSignedAction, deskAddress: string): Promise<HlSubmitResult> {
    if (signed.venue !== 'hyperliquid') throw new Error(`hyperliquid: the signed action is for ${signed.venue}`);
    const nearTx = signed.nearTx === undefined ? [] : [signed.nearTx];
    const signature = hlSignature(signed.signature);
    const digest = payloadDigest(signed.payload, this.network);
    const signer = await recoverSigner(digest, signature);
    if (signer !== deskAddress.toLowerCase()) {
      throw new Error(`hyperliquid ${signed.kind}: the signature recovers to ${signer}, not the desk's ${deskAddress.toLowerCase()}; nothing posted`);
    }
    const postedAt = this.#clock.now();
    let answer: unknown;
    try {
      answer = await this.#post('/exchange', exchangeBody(signed.payload, signature));
    } catch (err) {
      if (err instanceof HlExchangeError && err.status >= 400 && err.status < 500) throw err;
      throw new OutcomeUnknown(`hyperliquid ${signed.kind}`, `/exchange gave no answer: ${(err as Error).message ?? String(err)}`, hlIds(signed), nearTx);
    }
    const response = readResponse(answer, signed.kind);
    const actionType = signed.payload.action.type;
    const result: HlSubmitResult = {
      kind: signed.kind, statuses: response.statuses, oid: null, filled: null, resting: false, fills: [], tx: nearTx, confirmed: true,
      expiresAfter: typeof signed.payload.expiresAfter === 'number' ? signed.payload.expiresAfter : null,
    };

    if (actionType === 'order') {
      const first = response.statuses[0] as Record<string, unknown> | undefined;
      const error = response.statuses.map(statusError).find((e) => e !== null) ?? null;
      if (first === undefined || (error !== null && response.statuses.length === 1)) {
        throw new NothingExecuted('hyperliquid', error ?? 'no order status in the answer', nearTx);
      }
      const filled = first.filled as { totalSz?: unknown; avgPx?: unknown; oid?: unknown } | undefined;
      const resting = first.resting as { oid?: unknown } | undefined;
      result.oid = Number(filled?.oid ?? resting?.oid ?? Number.NaN);
      if (!Number.isSafeInteger(result.oid)) result.oid = null;
      if (filled !== undefined) {
        result.filled = { totalSz: String(filled.totalSz), avgPx: String(filled.avgPx) };
        if (result.oid !== null) {
          result.fills = await this.#fillsOf(deskAddress, result.oid, Number(filled.totalSz), postedAt);
          const hashes = [...new Set(result.fills.map((f) => f.hash).filter((h) => !ZERO_HASH.test(h)))];
          result.tx = [...nearTx, ...hashes.map((h) => hyperliquidTxRef(this.network, h))];
          result.confirmed = result.fills.length > 0;
        }
      } else {
        result.resting = resting !== undefined;
      }
      return result;
    }

    if (actionType === 'cancel') {
      const error = response.statuses.map(statusError).find((e) => e !== null) ?? null;
      if (error !== null) throw new NothingExecuted('hyperliquid', error, nearTx);
      return result;
    }

    if (actionType === 'usdClassTransfer' || actionType === 'sendAsset' || actionType === 'withdraw3') {
      const hash = await this.#ledgerHash(deskAddress, signed.payload.action, postedAt);
      result.tx = hash === null ? nearTx : [...nearTx, hyperliquidTxRef(this.network, hash)];
      result.confirmed = hash !== null;
    }
    return result;
  }

  /** The desk's fills of order `oid` since shortly before it was posted, once they add up to `totalSz`. */
  async #fillsOf(user: string, oid: number, totalSz: number, postedAt: number): Promise<HlFill[]> {
    const until = this.#clock.now() + this.#confirmMs;
    let fills: HlFill[] = [];
    for (;;) {
      try {
        const rows = await this.#info<HlFill[]>({ type: 'userFillsByTime', user: user.toLowerCase(), startTime: postedAt - 60_000, aggregateByTime: false });
        fills = (Array.isArray(rows) ? rows : []).filter((f) => Number(f.oid) === oid);
      } catch {
        // a 429 or a timeout on /info: read again until confirmMs, then return what was found
      }
      const sz = fills.reduce((sum, f) => sum + Number(f.sz), 0);
      if (fills.length > 0 && sz + 1e-12 >= totalSz) return fills;
      if (this.#clock.now() >= until) return fills;
      await this.#sleep(this.#pollMs);
    }
  }

  /** The ledger entry a transfer made (ledgerMatches), booked after it was posted. */
  async #ledgerHash(user: string, action: Record<string, unknown>, postedAt: number): Promise<string | null> {
    const until = this.#clock.now() + this.#confirmMs;
    for (;;) {
      let rows: { time: number; hash: string; delta: Record<string, unknown> }[] = [];
      try {
        rows = await this.#info({ type: 'userNonFundingLedgerUpdates', user: user.toLowerCase(), startTime: postedAt - 60_000 });
      } catch {
        // as in #fillsOf: an /info failure only delays the confirmation
      }
      const hit = (Array.isArray(rows) ? rows : []).find((r) => ledgerMatches(action, r.delta) && !ZERO_HASH.test(r.hash));
      if (hit !== undefined) return hit.hash;
      if (this.#clock.now() >= until) return null;
      await this.#sleep(this.#pollMs);
    }
  }

  async #info<T>(body: Record<string, unknown>): Promise<T> {
    return (await this.#post('/info', body)) as T;
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new HlExchangeError(`hyperliquid ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status, text);
    try {
      return JSON.parse(text);
    } catch {
      throw new HlExchangeError(`hyperliquid ${path}: not JSON: ${text.slice(0, 200)}`, res.status, text);
    }
  }
}

const LEDGER_TYPE: Record<string, string> = { usdClassTransfer: 'accountClassTransfer', sendAsset: 'send', withdraw3: 'withdraw' };

/** USDC text (at most 6 decimals, as Hyperliquid writes it) as an integer of 1e-6 units, or null. */
function usdcMicros(value: unknown): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value ?? '').trim());
  return m === null ? null : BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/**
 * Whether a userNonFundingLedgerUpdates delta is the entry `action` made. usdClassTransfer and sendAsset: type and
 * amount. withdraw3: Hyperliquid books the action's `time` x 1000 as the entry's `nonce` (the bare time is accepted
 * too) and the amount less its fee as `usdc` ({"usdc":"10.682396","nonce":1793669928713000,"fee":"1.0"} for a
 * withdraw3 of 11.682396 at time 1793669928713); an entry without a nonce matches on usdc + fee == amount.
 */
export function ledgerMatches(action: Record<string, unknown>, delta: Record<string, unknown> | undefined): boolean {
  const type = LEDGER_TYPE[String(action.type)];
  if (type === undefined || delta?.type !== type) return false;
  if (action.type !== 'withdraw3') return Math.abs(Number(delta.usdc ?? delta.amount) - Number(action.amount)) < 1e-9;
  if (delta.nonce !== undefined && delta.nonce !== null) {
    let nonce: bigint;
    let time: bigint;
    try {
      nonce = BigInt(String(delta.nonce));
      time = BigInt(String(action.time));
    } catch {
      return false;
    }
    return nonce === time * 1000n || nonce === time;
  }
  const usdc = usdcMicros(delta.usdc);
  const fee = usdcMicros(delta.fee ?? '0');
  const amount = usdcMicros(action.amount);
  return usdc !== null && fee !== null && amount !== null && usdc + fee === amount;
}

/** What reconciles a Hyperliquid action: the NEAR transaction, the first order's cloid, the action's nonce. */
export function hlIds(signed: HlSignedAction): OutcomeIds {
  const ids: OutcomeIds = { hlNonce: signed.payload.nonce };
  if (typeof signed.payload.expiresAfter === 'number') ids.hlExpiresAfter = signed.payload.expiresAfter;
  if (signed.nearTx !== undefined) ids.nearTx = signed.nearTx.id;
  const orders = (signed.payload.action as { orders?: { c?: unknown }[] }).orders;
  const cloid = Array.isArray(orders) ? orders.find((o) => typeof o?.c === 'string')?.c : undefined;
  if (typeof cloid === 'string') ids.hlCloid = cloid;
  return ids;
}

/** `{status:"ok", response:{type, data:{statuses}}}`, or HlExchangeError with Hyperliquid's own message. */
export function readResponse(answer: unknown, kind: string): { type: string; statuses: unknown[] } {
  const a = answer as { status?: unknown; response?: unknown };
  if (a?.status !== 'ok') {
    const why = typeof a?.response === 'string' ? a.response : JSON.stringify(answer).slice(0, 200);
    throw new HlExchangeError(`hyperliquid ${kind}: refused: ${why}`, 200, JSON.stringify(answer));
  }
  const r = (a.response ?? {}) as { type?: unknown; data?: { statuses?: unknown } };
  const statuses = Array.isArray(r.data?.statuses) ? r.data.statuses : [];
  return { type: String(r.type ?? 'default'), statuses };
}

function statusError(status: unknown): string | null {
  if (typeof status === 'object' && status !== null && typeof (status as { error?: unknown }).error === 'string') {
    return (status as { error: string }).error;
  }
  return null;
}
