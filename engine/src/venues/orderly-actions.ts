// Orderly writes and signed reads for one desk, built on an injected OrderlySigner (the contract client). The engine
// never signs and never builds a signed body: the contract returns each request signed, this client checks it and
// sends it with Orderly's headers. Setup and money-out run in the fixed orders of interfaces 1.3.
//
//   setup:     registration_nonce -> orderly_register -> POST /v1/register_account
//              orderly_add_key -> POST /v1/orderly_key
//              receiver_address (the owner then pins it with set_orderly_receiver)
//              referral_bind (skipped when no referral code is configured)
//   money out: settle_nonce -> orderly_settle_pnl -> settle_pnl -> withdraw_nonce -> orderly_withdraw -> withdraw_request
//              (always settle first, or the withdrawable balance is short)

import type { Clock } from './venue.ts';
import { systemClock } from './venue.ts';
import type { OrderlyEndpoints, OrderlyNetwork } from './orderly-http.ts';
import { ORDERLY_ENDPOINTS, normalizeAccountId, readOrderlyData } from './orderly-http.ts';
import type { OrderlyEip712Action, OrderlyRequest, OrderlyRequestKind, OrderlySigner } from './orderly-signer.ts';
import { checkEip712Action, evmSignatureHex, isOrderlyKeyString } from './orderly-signer.ts';
import { MpcTimeoutError } from '../contract/types.ts';
import { sendOrderlyRest } from '../relayer/orderly.ts';

const DAY_MS = 86_400_000;
/** Kinds that move money out; request() refuses them so they only run in withdraw()'s settle-first order. */
const MONEY_OUT_KINDS: ReadonlySet<OrderlyRequestKind> = new Set(['settle_pnl', 'withdraw_request']);
/** AddOrderlyKey allows at most 365 days; ask for a day less so a slow signature cannot cross the limit. */
export const ORDERLY_KEY_LIFETIME_MS = 364 * DAY_MS;

export interface OrderlyDeskConfig {
  deskId: string;
  network?: OrderlyNetwork;
  apiUrl?: string;
  accountId: string;             // the desk's Orderly account id (known before registration: keccak(address, broker))
  orderlyKey: string;            // "ed25519:<base58>" of the desk's Ed25519 MPC key
  evmAddress: string;            // the desk's EVM address, owner of the Orderly account
  referralCode: string | null;   // treasury.referral_codes.orderly; null skips referral_bind
  signer: OrderlySigner;
  fetch?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;
}

export interface OrderlySetupReport {
  accountId: string;
  orderlyKey: string;
  receiverAddress: unknown;      // the answer's data as Orderly gives it; the owner pins its address
  referral: 'bound' | 'skipped';
}

export interface OrderlyWithdrawReport {
  settleNonce: number;
  withdrawNonce: number;
  settled: unknown;
  withdraw: unknown;
}

/** One row of GET /v1/funding_fee/history. Only the fields the reader uses; numbers as Orderly sends them. */
export interface OrderlyFundingFeeRow {
  symbol: string;
  funding_rate: number;          // per funding period
  mark_price: number;
  funding_fee: number;
  payment_type: string;          // "Pay" | "Receive"
  created_time: number;          // ms
}

export interface OrderlyFundingFeePage {
  rows: OrderlyFundingFeeRow[];
  meta?: { total?: number; records_per_page?: number; current_page?: number };
}

export class OrderlyDeskClient {
  readonly deskId: string;
  readonly accountId: string;
  readonly orderlyKey: string;
  readonly evmAddress: string;
  readonly #endpoints: OrderlyEndpoints;
  readonly #apiUrl: string;
  readonly #referralCode: string | null;
  readonly #signer: OrderlySigner;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #timeoutMs: number;

  constructor(config: OrderlyDeskConfig) {
    if (!isOrderlyKeyString(config.orderlyKey)) throw new Error(`orderly: orderly key must be ed25519:<base58>, got ${config.orderlyKey}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(config.evmAddress)) throw new Error(`orderly: not an EVM address: ${config.evmAddress}`);
    this.deskId = config.deskId;
    this.accountId = normalizeAccountId(config.accountId);
    this.orderlyKey = config.orderlyKey;
    this.evmAddress = config.evmAddress;
    this.#endpoints = ORDERLY_ENDPOINTS[config.network ?? 'mainnet'];
    this.#apiUrl = (config.apiUrl ?? this.#endpoints.api).replace(/\/+$/, '');
    this.#referralCode = config.referralCode;
    this.#signer = config.signer;
    this.#fetch = config.fetch ?? fetch;
    this.#clock = config.clock ?? systemClock;
    this.#timeoutMs = config.timeoutMs ?? 10_000;
  }

  /**
   * Has the contract sign one private REST request, checks it, sends it with Orderly's headers, returns `data`.
   * settle_pnl and withdraw_request are refused here: they only run inside withdraw(), settle first.
   */
  request<T = unknown>(kind: OrderlyRequestKind, fields: Partial<OrderlyRequest> = {}, reason: string = kind): Promise<T> {
    if (MONEY_OUT_KINDS.has(kind)) return Promise.reject(new Error(`orderly: ${kind} only runs inside withdraw(), after settle_pnl`));
    return this.#request<T>(kind, fields, reason);
  }

  async #request<T>(kind: OrderlyRequestKind, fields: Partial<OrderlyRequest>, reason: string): Promise<T> {
    if (kind === 'order' && fields.client_order_id !== undefined && fields.client_order_id !== null) {
      throw new Error('orderly: the contract derives an order\'s client_order_id from its request_id; do not pass one');
    }
    const req: OrderlyRequest = { reduce_only: false, ...fields, kind, timestamp_ms: this.#clock.now() };
    const action = await this.#signer.orderlyRequest(this.deskId, req, reason);
    return sendOrderlyRest<T>(action, kind, {
      apiUrl: this.#apiUrl, deskId: this.deskId, accountId: this.accountId, orderlyKey: this.orderlyKey,
      fetch: this.#fetch, now: () => this.#clock.now(), timeoutMs: this.#timeoutMs,
    });
  }

  // ---- setup ----

  /**
   * Registers the desk's EVM address with the broker; returns the account id Orderly assigned. A registration nonce
   * lives 2 min and an MPC signature can take 120 s, so after an MPC timeout it fetches a fresh nonce and signs once more.
   */
  async register(): Promise<string> {
    let action: OrderlyEip712Action;
    let registrationNonce: string;
    for (let attempt = 1; ; attempt++) {
      const nonce = await this.#public<{ registration_nonce: string | number }>('GET', '/v1/registration_nonce', undefined, 'registration_nonce');
      registrationNonce = String(nonce.registration_nonce);
      try {
        action = await this.#signer.orderlyRegister(this.deskId, registrationNonce);
        break;
      } catch (err) {
        if (attempt >= 2 || !(err instanceof MpcTimeoutError)) throw err;
      }
    }
    checkEip712Action(action, this.deskId, 'register', { registrationNonce });
    const data = await this.#public<{ account_id: string }>('POST', '/v1/register_account', this.#eip712Body(action), 'register_account');
    const accountId = normalizeAccountId(data.account_id);
    if (accountId !== this.accountId) throw new Error(`orderly register: Orderly assigned ${accountId}, the desk expects ${this.accountId}`);
    return accountId;
  }

  /** Adds the desk's Ed25519 MPC key as its orderly key (scope read,trading), valid until `expirationMs`. */
  async addKey(expirationMs = this.#clock.now() + ORDERLY_KEY_LIFETIME_MS): Promise<string> {
    if (expirationMs - this.#clock.now() > 365 * DAY_MS) throw new RangeError('orderly add key: an orderly key lives at most 365 days');
    const action = await this.#signer.orderlyAddKey(this.deskId, expirationMs);
    checkEip712Action(action, this.deskId, 'add key', { orderlyKey: this.orderlyKey, expiration: expirationMs });
    const data = await this.#public<{ orderly_key?: string }>('POST', '/v1/orderly_key', this.#eip712Body(action), 'orderly_key');
    if (data.orderly_key !== undefined && data.orderly_key !== this.orderlyKey) {
      throw new Error(`orderly add key: Orderly registered ${data.orderly_key}, the desk's key is ${this.orderlyKey}`);
    }
    return this.orderlyKey;
  }

  /** The account's exclusive receiver address on Arbitrum, as Orderly answers it; the owner pins it. */
  receiverAddress(): Promise<unknown> {
    return this.request('receiver_address', {}, 'look up the Orderly receiver address');
  }

  /** Binds the configured referral code, once per desk; nothing at all when no code is configured. */
  async bindReferral(): Promise<'bound' | 'skipped'> {
    if (this.#referralCode === null) return 'skipped';
    await this.request('referral_bind', {}, 'bind the Orderly referral code');
    return 'bound';
  }

  /** The whole venue setup, in order. */
  async setup(): Promise<OrderlySetupReport> {
    const accountId = await this.register();
    const orderlyKey = await this.addKey();
    const receiverAddress = await this.receiverAddress();
    const referral = await this.bindReferral();
    return { accountId, orderlyKey, receiverAddress, referral };
  }

  // ---- money out ----

  /** Settles PnL, then withdraws `amount` USDC (canonical decimal string) to the desk's own EVM address. */
  async withdraw(amount: string, reason = 'withdraw from Orderly'): Promise<OrderlyWithdrawReport> {
    // USDC has 6 decimals: a canonical positive decimal with at most 6 of them.
    if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amount) || /\.\d*0$/.test(amount) || Number(amount) <= 0) {
      throw new Error(`orderly withdraw: amount must be a canonical positive USDC decimal string (at most 6 decimals), got ${amount}`);
    }
    const settleNonce = nonceOf(await this.#request<{ settle_nonce: unknown }>('settle_nonce', {}, reason), 'settle_nonce');
    const settleAction = await this.#signer.orderlySettlePnl(this.deskId, settleNonce);
    checkEip712Action(settleAction, this.deskId, 'settle pnl', { settleNonce });
    const settled = await this.#request('settle_pnl', {
      nonce: settleNonce, signed_at_ms: signedAt(settleAction), eip712_signature: evmSignatureHex(settleAction.signature),
    }, reason);
    const withdrawNonce = nonceOf(await this.#request<{ withdraw_nonce: unknown }>('withdraw_nonce', {}, reason), 'withdraw_nonce');
    const withdrawAction = await this.#signer.orderlyWithdraw(this.deskId, amount, withdrawNonce);
    checkEip712Action(withdrawAction, this.deskId, 'withdraw', { withdrawNonce });
    checkWithdrawMessage(withdrawAction.payload.message, amount, this.evmAddress);
    const withdraw = await this.#request('withdraw_request', {
      amount, nonce: withdrawNonce, signed_at_ms: signedAt(withdrawAction), eip712_signature: evmSignatureHex(withdrawAction.signature),
    }, reason);
    return { settleNonce, withdrawNonce, settled, withdraw };
  }

  // ---- signed reads ----

  /** One page of the account's funding payments in [startMs, endMs]. Needs the proposed `funding_fee_history` kind. */
  fundingFeeHistory(startMs: number, endMs: number, page: number, size: number): Promise<OrderlyFundingFeePage> {
    return this.request<OrderlyFundingFeePage>('funding_fee_history', { start_t: startMs, end_t: endMs, page, size }, 'read funding history');
  }

  #eip712Body(action: OrderlyEip712Action): string {
    checkEip712Action(action, this.deskId, action.kind);
    const userAddress = action.payload.userAddress ?? this.evmAddress;
    if (userAddress.toLowerCase() !== this.evmAddress.toLowerCase()) {
      throw new Error(`orderly: the contract signed for ${userAddress}, the desk's address is ${this.evmAddress}`);
    }
    return JSON.stringify({ message: action.payload.message, signature: evmSignatureHex(action.signature), userAddress });
  }

  async #public<T>(method: 'GET' | 'POST', path: string, body: string | undefined, what: string): Promise<T> {
    const res = await this.#fetch(`${this.#apiUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    return readOrderlyData<T>(res, what);
  }
}

/**
 * The Withdraw message must carry the amount asked for, as the same decimal string or in USDC's 6-decimal units
 * (which of the two the contract writes: verify on day 5), and a receiver, when it names one, that is the desk.
 */
export function checkWithdrawMessage(message: Record<string, unknown>, amount: string, evmAddress: string): void {
  const got = message.amount;
  const [whole, frac = ''] = amount.split('.');
  const units = (BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'))).toString();
  if (got === undefined || got === null || (String(got) !== amount && String(got) !== units)) {
    throw new Error(`orderly withdraw: the contract signed amount ${JSON.stringify(got)}, the engine asked for ${amount} USDC`);
  }
  const receiver = message.receiver;
  if (receiver !== undefined && String(receiver).toLowerCase() !== evmAddress.toLowerCase()) {
    throw new Error(`orderly withdraw: the contract signed receiver ${String(receiver)}, the desk's address is ${evmAddress}`);
  }
}

function nonceOf(data: Record<string, unknown>, field: string): number {
  const v = data?.[field];
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error(`orderly: ${field} is not a nonce: ${JSON.stringify(v)}`);
  return n;
}

/** The EIP-712 message's own timestamp: the contract rebuilds the message from it (signed_at_ms). */
function signedAt(action: OrderlyEip712Action): number {
  if (action.venue !== 'orderly') throw new Error(`orderly: signed action is for ${action.venue}`);
  const t = Number(action.payload.message.timestamp);
  if (!Number.isSafeInteger(t) || t <= 0) throw new Error(`orderly: EIP-712 message has no ms timestamp: ${JSON.stringify(action.payload.message.timestamp)}`);
  return t;
}
