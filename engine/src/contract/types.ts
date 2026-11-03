// The engine's view of the gimbal contract (docs/interfaces.md §1.3–1.5 and §3): what its methods take, what they
// return, and how a refusal reaches the engine. NearContractClient (the chain) and ReplayContractClient (the demo and
// tests) both implement ContractClient, so the relayer cannot tell them apart.

import { createHash } from 'node:crypto';
import type { ContractPolicy, TxRef } from '@gimbal/shared';
import type { OrderlySigner } from '../venues/orderly-signer.ts';

export interface Secp256k1Signature {
  scheme: 'Secp256k1';
  big_r: { affine_point: string };      // 33-byte compressed point, hex: 02/03 then r
  s: { scalar: string };                // 32 bytes, hex
  recovery_id: number;                  // 0 or 1
}

export interface Ed25519Signature {
  scheme: 'Ed25519';
  signature: number[];                  // 64 bytes
}

/** interfaces 1.4: what every action method returns; the engine submits it as is. */
export interface SignedAction<P = unknown, S = Secp256k1Signature | Ed25519Signature> {
  desk_id: string;
  request_id: number;
  venue: string;
  kind: string;
  payload: P;
  signature: S;
  /** Engine side only, never from the contract: the NEAR transaction that produced the signature. */
  nearTx?: TxRef;
  /** Engine side only: ReplayContractClient made it; the signature is not a real MPC signature. */
  replay?: true;
}

/** interfaces 1.3 `HlOrder`. */
export interface HlOrder {
  asset: number;
  is_buy: boolean;
  px: string;
  sz: string;
  reduce_only: boolean;
  tif: 'Ioc' | 'Gtc' | 'Alo';
  cloid: string | null;
}

/** A Hyperliquid `/exchange` body without its signature (interfaces 1.4): L1 actions carry `vaultAddress: null`. */
export interface HlPayload {
  action: Record<string, unknown> & { type: string };
  nonce: number;
  vaultAddress?: null;
  /** From C6: orders and cancels carry block time + 60 s (ms); Hyperliquid refuses the action after it. */
  expiresAfter?: number;
}

/** `sol_sign` and friends: the message exactly as signed. */
export interface SolPayload {
  message_b64: string;
}

/** `evm_usdc_to_intents` (interfaces 1.4): the EIP-3009 typed message plus the token and chain it is for. */
export interface Eip3009Payload {
  from: string;
  to: string;
  value: string;                       // raw USDC units (6 decimals), decimal string
  validAfter: string | number;
  validBefore: string | number;
  nonce: string;                       // 0x + 32 bytes
  token: string;                       // the USDC contract
  chainId: number;
}

export type HlSignedAction = SignedAction<HlPayload, Secp256k1Signature>;
export type SolSignedAction = SignedAction<SolPayload, Ed25519Signature>;
export type Eip3009SignedAction = SignedAction<Eip3009Payload, Secp256k1Signature>;

/** A 1Click quote and its signature, as `fund_venue`, `hl_send_to_intents` and the other rescue methods take them. */
export interface SignedQuote {
  quote: unknown;
  quote_signature: string;
}

/** `get_desk(desk_id)`: the fields the engine reads. Ledger amounts are USDC in 1e-6. */
export interface DeskView {
  owner: string;
  operator: string | null;
  paused: boolean;
  policy: ContractPolicy;
  evm_address: string;
  solana: { authority: string; usdc_ata: string; phusd_ata: string; phoenix_trader: string };
  orderly_receiver: string | null;
  /** true from panic_close until set_paused(false): the engine closes every leg reduce-only and opens nothing. */
  closing?: boolean;
  /** keccak of the desk EVM address and the broker hash, fixed at create_desk (interfaces 1.3). */
  orderly_account_id?: string;
  /** The relayer IPs the owner set with set_orderly_ips (C6); absent or null when none are set. */
  orderly_ips?: string[] | null;
  // u128 in the contract: JSON numbers today, which JavaScript reads exactly only below 2^53 (9e9 USDC)
  ledger: { deposited: number | string; withdrawn: number | string; fees_paid: number | string; hwm: number | string; idle_usdc: number | string };
}

/** One stored oracle price (`prices()`, and the `prices` event): USD × 1e8 per unit of `asset`, and when. */
export interface StoredPrice {
  asset: string;
  price_e8: number | string;           // a JSON number below 2^53, or a decimal string
  at_ms: number;
}

/**
 * A refusal: the contract panicked with a stable code first (interfaces 1.5), or the call never reached the method
 * ("Failed to deserialize input from JSON", read as E_ARGS). `txHash` is the NEAR transaction when there was one.
 */
export class ContractRefusal extends Error {
  readonly code: string;
  readonly txHash: string | null;
  constructor(code: string, message: string, txHash: string | null = null) {
    super(`${code}: ${message}`);
    this.name = 'ContractRefusal';
    this.code = code;
    this.txHash = txHash;
  }
}

/**
 * The MPC network did not sign in time ("Request has timed out" after ~120 s, or E_MPC). The client already retried
 * once where it could make the inputs fresh itself; a caller that owns the inputs (a Solana blockhash, an Orderly
 * registration nonce) retries once with fresh ones.
 */
export class MpcTimeoutError extends Error {
  readonly method: string;
  readonly txHash: string | null;
  constructor(method: string, detail: string, txHash: string | null = null) {
    super(`${method}: the MPC network did not sign: ${detail}`);
    this.name = 'MpcTimeoutError';
    this.method = method;
    this.txHash = txHash;
  }
}

/** Every id the engine holds for an action whose outcome it cannot prove: what reconciliation looks up. */
export interface OutcomeIds {
  /** The NEAR transaction that asked for the signature. */
  nearTx?: string;
  /** Hyperliquid: the order's client order id (orderStatus by cloid) and the action's nonce. */
  hlCloid?: string;
  hlNonce?: number;
  /** The signed action's expiresAfter (ms): after it Hyperliquid refuses every copy, so the outcome is final. */
  hlExpiresAfter?: number;
  /** Solana: the transaction signature (getSignatureStatuses with history). */
  solSignature?: string;
  /**
   * Solana, when the signature itself is not known: sha256 (hex) of the message the contract was asked to sign
   * (find it among the desk authority's transactions), and the height after which it can no longer land.
   */
  solMessage?: string;
  solLastValidBlockHeight?: number;
  /** Arbitrum: the transaction hash, and the EIP-3009 nonce (USDC authorizationState). */
  arbitrumTx?: string;
  eip3009Nonce?: string;
  /** Orderly: the order's contract-derived client_order_id (GET /v1/client/order/{id}), a withdrawal's nonce. */
  orderlyClientOrderId?: string;
  orderlyWithdrawNonce?: number;
}

/** OutcomeIds.solMessage of a base64 Solana message. */
export function solMessageDigest(messageB64: string): string {
  return createHash('sha256').update(Buffer.from(messageB64, 'base64')).digest('hex');
}

/**
 * Sent, and no proof either way: the action may have executed, or may still execute (a transaction still in a
 * mempool, a late MPC signature someone posts). Callers reconcile from the venue's state by these ids before doing
 * anything else; they never retry on this error and never build a fresh action in its place.
 */
export class OutcomeUnknown extends Error {
  readonly what: string;
  readonly detail: string;
  readonly ids: OutcomeIds;
  readonly tx: TxRef[];
  constructor(what: string, detail: string, ids: OutcomeIds, tx: TxRef[] = []) {
    super(`${what}: outcome unknown, reconcile before acting (${describeIds(ids)}): ${detail}`);
    this.name = 'OutcomeUnknown';
    this.what = what;
    this.detail = detail;
    this.ids = ids;
    this.tx = tx;
  }

  /** The same error with ids (and transactions) a caller knows on top: the cloid it chose, the NEAR transaction. */
  with(ids: OutcomeIds, tx: TxRef[] = []): OutcomeUnknown {
    const known = new Set(this.tx.map((t) => `${t.chain} ${t.id}`));
    return new OutcomeUnknown(this.what, this.detail, { ...ids, ...this.ids }, [...tx.filter((t) => !known.has(`${t.chain} ${t.id}`)), ...this.tx]);
  }
}

function describeIds(ids: OutcomeIds): string {
  const parts = Object.entries(ids).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k} ${String(v)}`);
  return parts.length === 0 ? 'no ids' : parts.join(', ');
}

/** The operator account cannot pay for one more signature (gas reservation or key allowance below one call). */
export class SignatureBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureBudgetError';
  }
}

/** A refusal code at the start of a panic message, anywhere in a NEAR failure text. */
export const REFUSAL_CODE = /\b(E_[A-Z][A-Z0-9_]*)\b/;

/**
 * The code and the readable part of a NEAR failure text, e.g. `Smart contract panicked: E_PRICE_BAND: px 2500 …`.
 * near-sdk's own deserialization panic has no code and counts as E_ARGS (interfaces 1.5).
 */
export function parseRefusal(text: string): { code: string; message: string } | null {
  const m = REFUSAL_CODE.exec(text);
  if (m !== null) {
    const rest = text.slice(m.index + m[1]!.length).replace(/^[:\s]+/, '');
    return { code: m[1]!, message: rest.replace(/["}\]]+$/, '').trim() };
  }
  if (/Failed to deserialize input from JSON/i.test(text)) return { code: 'E_ARGS', message: text.trim() };
  return null;
}

/**
 * True when a NEAR failure means the MPC network gave no signature: E_MPC from the callback, or a bare "timed out"
 * with no refusal code. A refusal is read first, so `E_ORACLE_STALE: … timed out` stays a refusal.
 */
export function isMpcTimeout(text: string): boolean {
  const refusal = parseRefusal(text);
  if (refusal !== null) return refusal.code === 'E_MPC';
  return /timed out/i.test(text);
}

/**
 * The gimbal contract's operator methods and views, one method each (interfaces §3). Action methods return the
 * SignedAction of `on_signed`; `nearTx` is set when it came from the chain. The Orderly methods are OrderlySigner's.
 */
export interface ContractClient extends OrderlySigner {
  readonly contractId: string;

  // views
  getDesk(deskId: string): Promise<DeskView | null>;
  prices(): Promise<StoredPrice[]>;

  // prices and pause
  /** `maxAgeS`: a stored price this young counts as refreshed (the contract skips an asset asked for under 30 s ago). */
  refreshPrices(assets: string[], options: { maxAgeS: number }): Promise<TxRef[]>;
  pause(deskId: string): Promise<TxRef[]>;

  // Hyperliquid
  hlOrder(deskId: string, order: HlOrder, reason: string): Promise<HlSignedAction>;
  hlCancel(deskId: string, asset: number, oid: number, reason: string): Promise<HlSignedAction>;
  hlSetReferrer(deskId: string): Promise<HlSignedAction>;
  hlApproveBuilderFee(deskId: string): Promise<HlSignedAction>;
  hlUsdClassTransfer(deskId: string, amount: string, toPerp: boolean, reason: string): Promise<HlSignedAction>;
  hlSendToIntents(deskId: string, quote: SignedQuote, reason: string): Promise<HlSignedAction>;
  /** withdraw3 of `amount` (canonical USDC decimal; Hyperliquid's 1 USDC fee comes out of it) to the desk's own EVM address on Arbitrum; the operator's counts against the rescue cap. */
  hlWithdraw(deskId: string, amount: string): Promise<HlSignedAction>;

  // Solana
  solSign(deskId: string, messageB64: string, reason: string): Promise<SolSignedAction>;
  solSignRegister(deskId: string, messageB64: string): Promise<SolSignedAction>;
  solSignRescue(deskId: string, messageB64: string, quote: SignedQuote, reason: string): Promise<SolSignedAction>;

  // Arbitrum and NEAR money paths
  evmUsdcToIntents(deskId: string, quote: SignedQuote, reason: string): Promise<Eip3009SignedAction>;
  fundVenue(deskId: string, quote: SignedQuote, reason: string): Promise<TxRef[]>;
}
