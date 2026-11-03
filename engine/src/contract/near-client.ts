// NearContractClient: the gimbal contract's operator methods over NEAR, through the operator's FunctionCall key
// (docs/interfaces.md §1.3). Every action method runs the same steps:
//   1. the signature budget (budget.ts) admits the call, after reading the balance and the key's allowance;
//   2. one transaction of 300 TGas to the contract; its result is on_signed's SignedAction (§1.4);
//   3. a refusal comes back as ContractRefusal with its E_* code. An MPC timeout ("Request has timed out", E_MPC)
//      on a read-only or idempotent method is retried once (with a fresh timestamp where the client owns one);
//      where only the caller can renew the input (a blockhash) it is MpcTimeoutError. On a method that moves money
//      or opens a position it is OutcomeUnknown: the contract takes a fresh Hyperliquid nonce or EIP-3009 counter
//      in the first receipt, so a retry would sign a second action, while a late MPC `respond` can still publish
//      the first signature for anyone to post. A Solana signature (sol_sign*) stays postable while its blockhash
//      lives: an MPC timeout is MpcTimeoutError (the relayer signs a new message only once the first is proven
//      expired), and any other failure, or an answer that cannot be read, is OutcomeUnknown.
// set_paused is the exception to step 1: its own gas, past the budget's queue and its 'down' refusal, so a pause
// always goes out.
// The chain is behind NearTransport (near-transport.ts in production, a fake in tests), so nothing here needs keys.

import type { TxRef } from '@gimbal/shared';
import type { OrderlyEip712Action, OrderlyRequest, OrderlyRestAction } from '../venues/orderly-signer.ts';
import type { NearHealth } from './budget.ts';
import { DEFAULT_CALL_TGAS, SignatureBudget } from './budget.ts';
import type {
  ContractClient, DeskView, Eip3009SignedAction, HlOrder, HlSignedAction, OutcomeIds, SignedAction, SignedQuote,
  SolSignedAction, StoredPrice,
} from './types.ts';
import { ContractRefusal, MpcTimeoutError, OutcomeUnknown, isMpcTimeout, parseRefusal, solMessageDigest } from './types.ts';

/**
 * set_paused writes one flag and logs one event. Not measured yet, so 30 TGas: headroom over the few it should
 * burn, still a tenth of an MPC call's 300, and outside the budget either way.
 */
export const PAUSE_TGAS = 30;

/** How often prices() is read back after refresh_prices. */
export const PRICE_POLL_MS = 1_000;
/**
 * How long prices() is read back before a price counts as missing: the contract skips an asset asked for under 30 s
 * ago, so an earlier ask's oracle answer can take that long to land; 5 s more covers block lag.
 */
export const PRICE_POLL_WINDOW_MS = 35_000;

export type NearNetwork = 'mainnet' | 'testnet';

export type NearCallOutcome =
  | { txHash: string; ok: true; value: unknown }
  | { txHash: string; ok: false; failure: string };

/** The chain as the client sees it: one function call, one view, and the two reads the budget needs. */
export interface NearTransport {
  /** The account that holds the operator key: the desk owner's, or a separate operator account. */
  readonly accountId: string;
  /** Signs and sends one FunctionCall with no deposit; resolves once the transaction has its final outcome. */
  call(contractId: string, method: string, args: object, tgas: number): Promise<NearCallOutcome>;
  view<T>(contractId: string, method: string, args: object): Promise<T>;
  account(): Promise<{ amount: bigint; locked: bigint; storageUsage: number }>;
  allowance(): Promise<bigint | null>;
}

/** How a method is retried after an MPC timeout. */
type Retry =
  | 'same'          // read-only or idempotent (a cancel, a fee approval, prices): signing the same arguments twice is harmless
  | 'fresh'         // the same, with a timestamp the client renews (orderly_request other than an order)
  | 'caller'        // only the caller can renew the input (an Orderly registration nonce, a ws auth timestamp)
  | 'blockhash'     // a Solana message: MpcTimeoutError for the caller, as 'caller'; any other failure is OutcomeUnknown
  | 'never';        // moves money or opens a position: an MPC timeout, or any failure that is not a refusal, is OutcomeUnknown

interface CallOptions {
  tgas?: number;
  /** false: no budget slot (set_paused), so neither the queue nor the 'down' refusal can hold it back. */
  budget?: boolean;
  /** Ids an OutcomeUnknown carries next to the NEAR transaction (a Solana message's digest). */
  ids?: OutcomeIds;
}

export interface NearContractClientOptions {
  contractId: string;
  network: NearNetwork;
  transport: NearTransport;
  /** Default: a SignatureBudget over the transport's reads. */
  budget?: SignatureBudget;
  /** NEAR's health for the HealthMap: 'down' when the key cannot pay, 'slow' after a signature over slowMs. */
  onHealth?: (status: NearHealth, detail: string) => void;
  /** A signature slower than this marks NEAR 'slow' (MPC usually signs in 5–6 s); default 30 s. */
  slowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tgas?: number;
}

/** The parts of `config()` the engine reads; every field optional, since the view's exact JSON is the contract's. */
export interface ContractConfigView {
  network?: string;
  treasury?: { near?: string; hl_builder?: string; referral_codes?: Record<string, string | null> };
  fees?: { performance_bps?: number; hl_builder_tenth_bps?: number };
  orderly?: { broker_id?: string; chain_id?: number };
  [field: string]: unknown;
}

export function nearTxRef(network: NearNetwork, hash: string): TxRef {
  return { chain: 'near', id: hash, url: `https://${network === 'mainnet' ? '' : 'testnet.'}nearblocks.io/txns/${hash}` };
}

export class NearContractClient implements ContractClient {
  readonly contractId: string;
  readonly network: NearNetwork;
  readonly #transport: NearTransport;
  readonly #budget: SignatureBudget;
  readonly #onHealth: (status: NearHealth, detail: string) => void;
  readonly #slowMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #tgas: number;
  #health: NearHealth = 'ok';

  constructor(options: NearContractClientOptions) {
    this.contractId = options.contractId;
    this.network = options.network;
    this.#transport = options.transport;
    this.#onHealth = options.onHealth ?? (() => {});
    this.#budget = options.budget ?? new SignatureBudget({
      reads: { account: () => this.#transport.account(), allowance: () => this.#transport.allowance() },
      onHealth: (status, detail) => this.#setHealth(status, detail),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    this.#slowMs = options.slowMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#tgas = options.tgas ?? DEFAULT_CALL_TGAS;
  }

  get inFlight(): number {
    return this.#budget.inFlight;
  }

  // ---- views ----

  async getDesk(deskId: string): Promise<DeskView | null> {
    return (await this.#transport.view<DeskView | null>(this.contractId, 'get_desk', { desk_id: deskId })) ?? null;
  }

  async prices(): Promise<StoredPrice[]> {
    return parseStoredPrices(await this.#transport.view<unknown>(this.contractId, 'prices', {}));
  }

  /** The contract's Config (docs/interfaces.md §1.1) as `config()` returns it: network, treasury, fees, Orderly. */
  async config(): Promise<ContractConfigView> {
    return (await this.#transport.view<ContractConfigView | null>(this.contractId, 'config', {})) ?? {};
  }

  /** NEAR's health as the budget and the last signatures left it. */
  get health(): NearHealth {
    return this.#health;
  }

  // ---- prices and pause ----

  /**
   * refresh_prices, then prices() must show, for every asset asked for, a newer stored price or one younger than
   * `maxAgeS`, which the caller must give (what its next call needs: under the desk's oracle_max_age_s, with room for
   * that call; there is no default, so a 15-minute-old price is never "fresh" by accident). Age is against the local
   * clock: the transport reads no block time, and NEAR's block time runs within a second or two of it. The contract answers `true` without asking the oracle when every asset had a
   * price stored, or was asked for, under 30 s ago (interfaces §1.3): the first case is fresh at once; in the second
   * the earlier ask's answer is still on its way, so prices() is polled every PRICE_POLL_MS for up to
   * PRICE_POLL_WINDOW_MS (the contract's 30 s ask window plus a margin) before it counts as missing.
   */
  async refreshPrices(assets: string[], options: { maxAgeS: number }): Promise<TxRef[]> {
    if (!(options.maxAgeS > 0)) throw new Error(`refreshPrices: maxAgeS must be > 0, got ${options.maxAgeS}`);
    const maxAgeMs = options.maxAgeS * 1000;
    const before = new Map((await this.prices()).map((p) => [p.asset, p.at_ms]));
    const r = await this.#call('refresh_prices', () => ({ assets }), 'same');
    // From here the call is on chain (the contract recorded the ask and skips another for 30 s): every error says so,
    // in one form a caller can tell from an error before or in the call (pair-mainnet-lib refreshLanded).
    try {
      if (r.value === false) throw new Error('it returned false (the oracle answered no price for an asset asked for)');
      let missing: string[] = assets;
      for (let i = 0; i <= PRICE_POLL_WINDOW_MS / PRICE_POLL_MS; i++) {
        if (i > 0) await this.#sleep(PRICE_POLL_MS);
        const after = new Map((await this.prices()).map((p) => [p.asset, p.at_ms]));
        const now = this.#now();
        missing = assets.filter((a) => {
          const at = after.get(a);
          if (at === undefined) return true;
          const newer = !before.has(a) || at > before.get(a)!;
          return !newer && now - at > maxAgeMs;
        });
        if (missing.length === 0) return [nearTxRef(this.network, r.txHash)];
      }
      throw new Error(`prices() has no newer price, nor one under ${maxAgeMs / 1000} s old, for ${missing.join(', ')} after ${PRICE_POLL_WINDOW_MS / 1000} s`);
    } catch (err) {
      throw new Error(`refresh_prices ran in ${r.txHash}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  /**
   * set_paused(desk, true) at PAUSE_TGAS, past the signature budget: it must go out even when MPC calls fill every
   * slot or the budget is 'down'. It returns nothing, so success is read back: get_desk must say paused.
   */
  async pause(deskId: string): Promise<TxRef[]> {
    const r = await this.#call('set_paused', () => ({ desk_id: deskId, paused: true }), 'same', { tgas: PAUSE_TGAS, budget: false });
    if (r.value !== null && r.value !== undefined) throw new Error(`set_paused returned ${JSON.stringify(r.value)} in ${r.txHash}, not nothing`);
    const notPaused = await this.#retryRead(async () => ((await this.getDesk(deskId))?.paused === true ? null : true));
    if (notPaused !== null) throw new Error(`set_paused ran in ${r.txHash} but get_desk(${deskId}) does not say paused`);
    return [nearTxRef(this.network, r.txHash)];
  }

  /** A view check right after a transaction, read up to 3 times 1 s apart (an RPC node may lag one block). */
  async #retryRead<T>(check: () => Promise<T | null>): Promise<T | null> {
    let last: T | null = null;
    for (let i = 0; i < 3; i++) {
      last = await check();
      if (last === null) return null;
      if (i < 2) await this.#sleep(1_000);
    }
    return last;
  }

  // ---- Hyperliquid ----

  hlOrder(deskId: string, order: HlOrder, reason: string): Promise<HlSignedAction> {
    return this.#signed('hl_order', () => ({ desk_id: deskId, order, reason }), 'never', deskId);
  }

  hlCancel(deskId: string, asset: number, oid: number, reason: string): Promise<HlSignedAction> {
    return this.#signed('hl_cancel', () => ({ desk_id: deskId, asset, oid, reason }), 'same', deskId);
  }

  hlSetReferrer(deskId: string): Promise<HlSignedAction> {
    return this.#signed('hl_set_referrer', () => ({ desk_id: deskId }), 'same', deskId);
  }

  hlApproveBuilderFee(deskId: string): Promise<HlSignedAction> {
    return this.#signed('hl_approve_builder_fee', () => ({ desk_id: deskId }), 'same', deskId);
  }

  hlUsdClassTransfer(deskId: string, amount: string, toPerp: boolean, reason: string): Promise<HlSignedAction> {
    return this.#signed('hl_usd_class_transfer', () => ({ desk_id: deskId, amount, to_perp: toPerp, reason }), 'never', deskId);
  }

  // Money out of Hyperliquid: never retried (a second withdraw3 could be posted while the first may still land).
  hlWithdraw(deskId: string, amount: string): Promise<HlSignedAction> {
    return this.#signed('hl_withdraw', () => ({ desk_id: deskId, amount }), 'never', deskId);
  }

  hlSendToIntents(deskId: string, quote: SignedQuote, reason: string): Promise<HlSignedAction> {
    return this.#signed('hl_send_to_intents', () => ({ desk_id: deskId, quote: quote.quote, quote_signature: quote.quote_signature, reason }), 'never', deskId);
  }

  // ---- Solana: the message carries a blockhash that a 120 s timeout outlives, so the caller rebuilds it ----

  solSign(deskId: string, messageB64: string, reason: string): Promise<SolSignedAction> {
    return this.#signed('sol_sign', () => ({ desk_id: deskId, message_b64: messageB64, reason }), 'blockhash', deskId,
      { solMessage: solMessageDigest(messageB64) });
  }

  solSignRegister(deskId: string, messageB64: string): Promise<SolSignedAction> {
    return this.#signed('sol_sign_register', () => ({ desk_id: deskId, message_b64: messageB64 }), 'blockhash', deskId,
      { solMessage: solMessageDigest(messageB64) });
  }

  solSignRescue(deskId: string, messageB64: string, quote: SignedQuote, reason: string): Promise<SolSignedAction> {
    return this.#signed('sol_sign_rescue', () => ({
      desk_id: deskId, message_b64: messageB64, quote: quote.quote, quote_signature: quote.quote_signature, reason,
    }), 'blockhash', deskId, { solMessage: solMessageDigest(messageB64) });
  }

  // ---- Orderly (OrderlySigner) ----

  orderlyRequest(deskId: string, req: OrderlyRequest, reason: string): Promise<OrderlyRestAction> {
    // A retry renews the timestamp: Orderly takes a signed call for 300 s, and the first try may have used 120 s.
    // Not for an order: the first signature, published late, stays postable for those 300 s.
    let first = true;
    return this.#signed('orderly_request', () => {
      const r = first ? req : { ...req, timestamp_ms: this.#now() };
      first = false;
      return { desk_id: deskId, req: r, reason };
    }, req.kind === 'order' ? 'never' : 'fresh', deskId);
  }

  orderlyWsAuth(deskId: string, timestamp: number): Promise<OrderlyRestAction> {
    // The stream checks the signed timestamp is the one it asked for; it reconnects with a fresh one on a timeout.
    return this.#signed('orderly_ws_auth', () => ({ desk_id: deskId, timestamp }), 'caller', deskId);
  }

  orderlyRegister(deskId: string, registrationNonce: string): Promise<OrderlyEip712Action> {
    // Registration nonces live 2 min: OrderlyDeskClient.register fetches a new one and calls again.
    return this.#signed('orderly_register', () => ({ desk_id: deskId, registration_nonce: registrationNonce }), 'caller', deskId);
  }

  orderlyAddKey(deskId: string, expirationMs: number): Promise<OrderlyEip712Action> {
    return this.#signed('orderly_add_key', () => ({ desk_id: deskId, expiration_ms: expirationMs }), 'same', deskId);
  }

  orderlySettlePnl(deskId: string, settleNonce: number): Promise<OrderlyEip712Action> {
    return this.#signed('orderly_settle_pnl', () => ({ desk_id: deskId, settle_nonce: settleNonce }), 'never', deskId);
  }

  orderlyWithdraw(deskId: string, amount: string, withdrawNonce: number): Promise<OrderlyEip712Action> {
    return this.#signed('orderly_withdraw', () => ({ desk_id: deskId, amount, withdraw_nonce: withdrawNonce }), 'never', deskId);
  }

  // ---- Arbitrum and NEAR money paths ----

  evmUsdcToIntents(deskId: string, quote: SignedQuote, reason: string): Promise<Eip3009SignedAction> {
    return this.#signed('evm_usdc_to_intents', () => ({ desk_id: deskId, quote: quote.quote, quote_signature: quote.quote_signature, reason }), 'never', deskId);
  }

  /**
   * fund_venue, checked by the desk's ledger rather than by a return value the contract has not pinned yet: idle_usdc
   * must have dropped by the quote's amountIn. Anything else after the transaction ran is OutcomeUnknown.
   */
  async fundVenue(deskId: string, quote: SignedQuote, reason: string): Promise<TxRef[]> {
    const idle = async () => {
      const d = await this.getDesk(deskId);
      if (d === null) throw new Error(`fund_venue: the contract has no desk ${deskId}`);
      return BigInt(String(d.ledger.idle_usdc));
    };
    // The contract takes `quote` as the canonical JSON string 1Click signed; an object is read as is.
    const fields = typeof quote.quote === 'string' ? (JSON.parse(quote.quote) as unknown) : quote.quote;
    const amountIn = String((fields as { amountIn?: unknown } | null)?.amountIn ?? '');
    if (!/^[1-9]\d*$/.test(amountIn)) throw new Error('fund_venue: the quote has no amountIn');
    const before = await idle();
    const r = await this.#call('fund_venue', () => ({ desk_id: deskId, quote: quote.quote, quote_signature: quote.quote_signature, reason }), 'never');
    const ref = nearTxRef(this.network, r.txHash);
    let after: bigint | null = null;
    const short = await this.#retryRead(async () => {
      after = await idle().catch(() => null);
      return after !== null && r.value !== false && before - after >= BigInt(amountIn) ? null : true;
    });
    if (short !== null) {
      throw new OutcomeUnknown('fund_venue', `returned ${JSON.stringify(r.value)}; the desk's idle USDC went from ${before} to ${String(after ?? 'unread')}, the quote sends ${amountIn}`, { nearTx: r.txHash }, [ref]);
    }
    return [ref];
  }

  // ---- the steps every call shares ----

  async #signed<A extends SignedAction>(method: string, args: () => object, retry: Retry, deskId: string, ids: OutcomeIds = {}): Promise<A> {
    const r = await this.#call(method, args, retry, { ids });
    let action: SignedAction;
    try {
      action = parseSignedAction(method, r.value, deskId);
    } catch (err) {
      // The transaction ran, so a signature may be on chain even though this one cannot be read.
      if (unknownOnFailure(retry)) {
        throw new OutcomeUnknown(method, `${(err as Error).message}${signatureMayBePublic(retry)}`, { ...ids, nearTx: r.txHash }, [nearTxRef(this.network, r.txHash)]);
      }
      throw err;
    }
    return { ...action, nearTx: nearTxRef(this.network, r.txHash) } as A;
  }

  async #call(method: string, args: () => object, retry: Retry, options: CallOptions = {}): Promise<{ txHash: string; value: unknown }> {
    const tgas = options.tgas ?? this.#tgas;
    const attempts = retry === 'same' || retry === 'fresh' ? 2 : 1;
    let last: MpcTimeoutError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const release = options.budget === false ? () => {} : await this.#budget.acquire(tgas);
      const started = this.#now();
      let outcome: NearCallOutcome;
      try {
        // OutcomeUnknown from the transport (sent, no final outcome) goes up as is: never a second transaction.
        outcome = await this.#transport.call(this.contractId, method, args(), tgas);
      } finally {
        release();
      }
      const took = this.#now() - started;
      if (took > this.#slowMs) this.#setHealth('slow', `${method} took ${Math.round(took / 1000)} s to sign`);
      else if (this.#health === 'slow') this.#setHealth('ok', `${method} signed in ${Math.round(took / 1000)} s`);
      if (outcome.ok) return { txHash: outcome.txHash, value: outcome.value };
      const ref = [nearTxRef(this.network, outcome.txHash)];
      const ids = { ...options.ids, nearTx: outcome.txHash };
      if (isMpcTimeout(outcome.failure)) {
        if (retry === 'never') {
          throw new OutcomeUnknown(method, `the MPC network did not sign in time (${oneLine(outcome.failure)}); a late signature may still be published and posted`, ids, ref);
        }
        last = new MpcTimeoutError(method, oneLine(outcome.failure), outcome.txHash);
        continue;
      }
      const refusal = parseRefusal(outcome.failure);
      if (refusal !== null) throw new ContractRefusal(refusal.code, refusal.message, outcome.txHash);
      if (unknownOnFailure(retry)) {
        // Not a refusal: the failure may have come after the MPC network signed (in the callback).
        throw new OutcomeUnknown(method, `failed without a refusal code: ${oneLine(outcome.failure)}${signatureMayBePublic(retry)}`, ids, ref);
      }
      throw new Error(`${method} failed in transaction ${outcome.txHash}: ${oneLine(outcome.failure)}`);
    }
    throw last!;
  }

  #setHealth(status: NearHealth, detail: string): void {
    if (status === this.#health && status !== 'down') return;
    this.#health = status;
    this.#onHealth(status, detail);
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 400);
}

/** Whether a failure that is no refusal (or an unreadable answer) leaves a signature that may be posted. */
function unknownOnFailure(retry: Retry): boolean {
  return retry === 'never' || retry === 'blockhash';
}

function signatureMayBePublic(retry: Retry): string {
  return retry === 'blockhash'
    ? '; a signature of this message may be public while its blockhash lives, so no new message until it is proven expired'
    : '';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The SignedAction an action method returned, checked for the fields the relayer relies on. The contract on main
 * still returns UnsignedAction (no MPC call yet): that is a clear error, not a payload posted without a signature.
 */
export function parseSignedAction(method: string, value: unknown, deskId: string): SignedAction {
  if (!isObject(value)) throw new Error(`${method}: the contract returned ${JSON.stringify(value)?.slice(0, 120)}, not a SignedAction`);
  if ('sign_request' in value && !('signature' in value)) {
    throw new Error(`${method}: the contract returned an UnsignedAction: this deploy does not call the MPC network yet`);
  }
  const { desk_id, request_id, venue, kind, payload, signature } = value;
  if (desk_id !== deskId) throw new Error(`${method}: signed for desk ${String(desk_id)}, not ${deskId}`);
  if (typeof venue !== 'string' || typeof kind !== 'string') throw new Error(`${method}: the SignedAction has no venue or kind`);
  if (!Number.isSafeInteger(request_id)) throw new Error(`${method}: the SignedAction has no request_id`);
  if (!isObject(payload)) throw new Error(`${method}: the SignedAction has no payload`);
  if (!isObject(signature) || (signature.scheme !== 'Secp256k1' && signature.scheme !== 'Ed25519')) {
    throw new Error(`${method}: the SignedAction has no Secp256k1 or Ed25519 signature`);
  }
  return value as unknown as SignedAction;
}

/**
 * `prices()` as a list of { asset, price_e8, at_ms }: the shape of the `prices` event. A map from asset to
 * { price_e8, at_ms } is read too, so either way the view lands works.
 */
export function parseStoredPrices(value: unknown): StoredPrice[] {
  if (value === null || value === undefined) return [];
  const rows: unknown[] = Array.isArray(value)
    ? value
    : isObject(value) ? Object.entries(value).map(([asset, v]) => (isObject(v) ? { asset, ...v } : null)) : [];
  const out: StoredPrice[] = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    const { asset, price_e8, at_ms } = row;
    const okPrice = (typeof price_e8 === 'number' && Number.isFinite(price_e8) && price_e8 > 0)
      || (typeof price_e8 === 'string' && /^[1-9]\d*$/.test(price_e8));
    if (typeof asset !== 'string' || !okPrice || typeof at_ms !== 'number' || !Number.isFinite(at_ms)) continue;
    out.push({ asset, price_e8: price_e8 as number | string, at_ms });
  }
  return out;
}
