// NearContractClient: the gimbal contract's operator methods over NEAR, through the operator's FunctionCall key
// (docs/interfaces.md §1.3). Every action method runs the same steps:
//   1. the signature budget (budget.ts) admits the call, after reading the balance and the key's allowance;
//   2. one transaction of 300 TGas to the contract; its result is on_signed's SignedAction (§1.4);
//   3. a refusal comes back as ContractRefusal with its E_* code; an MPC timeout ("Request has timed out", E_MPC) is
//      retried once where the client can make the inputs fresh itself, else thrown as MpcTimeoutError for the
//      caller that owns them.
// The chain is behind NearTransport (near-transport.ts in production, a fake in tests), so nothing here needs keys.

import type { TxRef } from '@gimbal/shared';
import type { OrderlyEip712Action, OrderlyRequest, OrderlyRestAction } from '../venues/orderly-signer.ts';
import type { NearHealth } from './budget.ts';
import { DEFAULT_CALL_TGAS, SignatureBudget } from './budget.ts';
import type {
  ContractClient, DeskView, Eip3009SignedAction, HlOrder, HlSignedAction, SignedAction, SignedQuote, SolSignedAction,
  StoredPrice,
} from './types.ts';
import { ContractRefusal, MpcTimeoutError, isMpcTimeout, parseRefusal } from './types.ts';

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
  | 'same'          // the contract stamps its own nonce or block time: the same arguments sign something fresh
  | 'fresh'         // the arguments carry a timestamp the client renews (orderly_request)
  | 'caller';       // only the caller can renew the input (a Solana blockhash, an Orderly registration nonce)

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
    });
    this.#slowMs = options.slowMs ?? 30_000;
    this.#now = options.now ?? Date.now;
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

  async refreshPrices(assets: string[]): Promise<TxRef[]> {
    const r = await this.#call('refresh_prices', () => ({ assets }), 'same');
    return [nearTxRef(this.network, r.txHash)];
  }

  async pause(deskId: string): Promise<TxRef[]> {
    const r = await this.#call('set_paused', () => ({ desk_id: deskId, paused: true }), 'same');
    return [nearTxRef(this.network, r.txHash)];
  }

  // ---- Hyperliquid ----

  hlOrder(deskId: string, order: HlOrder, reason: string): Promise<HlSignedAction> {
    return this.#signed('hl_order', () => ({ desk_id: deskId, order, reason }), 'same', deskId);
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
    return this.#signed('hl_usd_class_transfer', () => ({ desk_id: deskId, amount, to_perp: toPerp, reason }), 'same', deskId);
  }

  hlSendToIntents(deskId: string, quote: SignedQuote, reason: string): Promise<HlSignedAction> {
    return this.#signed('hl_send_to_intents', () => ({ desk_id: deskId, quote: quote.quote, quote_signature: quote.quote_signature, reason }), 'same', deskId);
  }

  // ---- Solana: the message carries a blockhash that a 120 s timeout outlives, so the caller rebuilds it ----

  solSign(deskId: string, messageB64: string, reason: string): Promise<SolSignedAction> {
    return this.#signed('sol_sign', () => ({ desk_id: deskId, message_b64: messageB64, reason }), 'caller', deskId);
  }

  solSignRegister(deskId: string, messageB64: string): Promise<SolSignedAction> {
    return this.#signed('sol_sign_register', () => ({ desk_id: deskId, message_b64: messageB64 }), 'caller', deskId);
  }

  solSignRescue(deskId: string, messageB64: string, quote: SignedQuote, reason: string): Promise<SolSignedAction> {
    return this.#signed('sol_sign_rescue', () => ({
      desk_id: deskId, message_b64: messageB64, quote: quote.quote, quote_signature: quote.quote_signature, reason,
    }), 'caller', deskId);
  }

  // ---- Orderly (OrderlySigner) ----

  orderlyRequest(deskId: string, req: OrderlyRequest, reason: string): Promise<OrderlyRestAction> {
    // A retry renews the timestamp: Orderly takes a signed call for 300 s, and the first try may have used 120 s.
    let first = true;
    return this.#signed('orderly_request', () => {
      const r = first ? req : { ...req, timestamp_ms: this.#now() };
      first = false;
      return { desk_id: deskId, req: r, reason };
    }, 'fresh', deskId);
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
    return this.#signed('orderly_settle_pnl', () => ({ desk_id: deskId, settle_nonce: settleNonce }), 'same', deskId);
  }

  orderlyWithdraw(deskId: string, amount: string, withdrawNonce: number): Promise<OrderlyEip712Action> {
    return this.#signed('orderly_withdraw', () => ({ desk_id: deskId, amount, withdraw_nonce: withdrawNonce }), 'same', deskId);
  }

  // ---- Arbitrum and NEAR money paths ----

  evmUsdcToIntents(deskId: string, quote: SignedQuote, reason: string): Promise<Eip3009SignedAction> {
    return this.#signed('evm_usdc_to_intents', () => ({ desk_id: deskId, quote: quote.quote, quote_signature: quote.quote_signature, reason }), 'same', deskId);
  }

  async fundVenue(deskId: string, quote: SignedQuote, reason: string): Promise<TxRef[]> {
    const r = await this.#call('fund_venue', () => ({ desk_id: deskId, quote: quote.quote, quote_signature: quote.quote_signature, reason }), 'same');
    return [nearTxRef(this.network, r.txHash)];
  }

  // ---- the steps every call shares ----

  async #signed<A extends SignedAction>(method: string, args: () => object, retry: Retry, deskId: string): Promise<A> {
    const r = await this.#call(method, args, retry);
    const action = parseSignedAction(method, r.value, deskId);
    return { ...action, nearTx: nearTxRef(this.network, r.txHash) } as A;
  }

  async #call(method: string, args: () => object, retry: Retry): Promise<{ txHash: string; value: unknown }> {
    const attempts = retry === 'caller' ? 1 : 2;
    let last: MpcTimeoutError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const release = await this.#budget.acquire(this.#tgas);
      const started = this.#now();
      let outcome: NearCallOutcome;
      try {
        outcome = await this.#transport.call(this.contractId, method, args(), this.#tgas);
      } finally {
        release();
      }
      const took = this.#now() - started;
      if (took > this.#slowMs) this.#setHealth('slow', `${method} took ${Math.round(took / 1000)} s to sign`);
      else if (this.#health === 'slow') this.#setHealth('ok', `${method} signed in ${Math.round(took / 1000)} s`);
      if (outcome.ok) return { txHash: outcome.txHash, value: outcome.value };
      if (isMpcTimeout(outcome.failure)) {
        last = new MpcTimeoutError(method, oneLine(outcome.failure), outcome.txHash);
        continue;
      }
      const refusal = parseRefusal(outcome.failure);
      if (refusal !== null) throw new ContractRefusal(refusal.code, refusal.message, outcome.txHash);
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
