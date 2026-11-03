// ReplayContractClient: the contract without a chain, for `npm run demo` and for tests (docs/interfaces.md §3). It
// holds desks and stored prices in memory, runs the contract's checks and refusal codes (replay-checks.ts), builds
// the same payloads the contract builds (Hyperliquid actions, Orderly REST calls, EIP-3009 messages) and returns
// them as SignedActions marked `replay: true`.
//
// Signatures: with test keys (`keys`) it signs for real, so a test can push its actions through the venue
// submitters and see them verify; without keys the signatures are well-formed fakes that verify nowhere. The
// Solana instruction rules (gimbal-core's Phoenix parser) are not ported: sol_sign checks the envelope only.

import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import type { TxRef } from '@gimbal/shared';
import { keccak256, toBytes } from 'viem';
import type { Hex } from 'viem';
import { sign as secpSign, signTypedData } from 'viem/accounts';
import { l1Digest, userSignedDigest } from '../relayer/hl-wire.ts';
import type { MsgpackValue } from '../relayer/hl-wire.ts';
import type { OrderlyEip712Action, OrderlyRequest, OrderlyRestAction } from '../venues/orderly-signer.ts';
import { ORDERLY_WS_AUTH_KIND, base58, orderlyRestMessage } from '../venues/orderly-signer.ts';
import { checkDeskId, checkHlOrder, checkReason, checkUsdcAmount, parseE8 } from './replay-checks.ts';
import type {
  ContractClient, DeskView, Ed25519Signature, Eip3009SignedAction, HlOrder, HlPayload, HlSignedAction, Secp256k1Signature,
  SignedAction, SignedQuote, SolSignedAction, StoredPrice,
} from './types.ts';
import { ContractRefusal } from './types.ts';

export type ReplayNetwork = 'mainnet' | 'testnet';

export interface ReplayContractConfig {
  network: ReplayNetwork;
  /** Treasury.hl_builder, lowercase 0x address. */
  hlBuilder: string;
  /** FeeConfig.hl_builder_tenth_bps. */
  hlBuilderTenthBps: number;
  /** ReferralCodes.hyperliquid / .orderly; null = that step is refused (E_ARGS), as the contract does. */
  hlReferralCode?: string | null;
  orderlyReferralCode?: string | null;
  /** OrderlyConfig. */
  orderlyBrokerId?: string;
  orderlyChainId?: number;
  /** C6 and later: orders and cancels carry expiresAfter = block time + this (60 s); unset = C5, no expiry. */
  hlExpiresAfterMs?: number;
}

export interface ReplayKeys {
  /** secp256k1 private key standing in for the desk's MPC EVM key (0x + 32 bytes). */
  evm?: Hex;
  /** Ed25519 seed standing in for the desk's MPC Solana / Orderly key (32 bytes). */
  sol?: Uint8Array;
}

export interface ReplayContractClientOptions {
  config: ReplayContractConfig;
  desks?: Record<string, DeskView>;
  prices?: StoredPrice[];
  keys?: Record<string, ReplayKeys>;
  now?: () => number;
}

const HL_SIGNATURE_CHAIN_ID = '0x66eee';
const USDC_ARBITRUM: Record<ReplayNetwork, { token: string; chainId: number }> = {
  mainnet: { token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', chainId: 42161 },
  testnet: { token: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', chainId: 421614 },
};
const ORDERLY_LEDGER: Record<ReplayNetwork, string> = {
  mainnet: '0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203',
  testnet: '0x1826B75e2ef249173FC735149AE4B8e9ea10abff',
};
const ORDERLY_OFF_CHAIN = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
/** Orderly's limit on a client_order_id. */
export const ORDERLY_CLIENT_ORDER_ID_MAX = 36;

/** How far past the block time an Orderly request timestamp may be (the contract's MAX_AHEAD_MS). */
export const ORDERLY_MAX_AHEAD_MS = 5_000;

/**
 * The client_order_id the contract sets on the order it signs with `requestId`: `g<request_id>`, as orderly.json
 * pins it (request_rules.client_order_id). It is never the caller's: the contract refuses one with E_ARGS.
 */
export function standInClientOrderId(requestId: number): string {
  return `g${requestId}`;
}
/** EIP-3009 authorizations are valid for at most this long (contract rule, eip3009.json). */
const EIP3009_VALID_S = 1800;

const ORDERLY_TYPES = {
  Registration: [
    { name: 'brokerId', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'timestamp', type: 'uint64' },
    { name: 'registrationNonce', type: 'uint256' },
  ],
  AddOrderlyKey: [
    { name: 'brokerId', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'orderlyKey', type: 'string' },
    { name: 'scope', type: 'string' }, { name: 'timestamp', type: 'uint64' }, { name: 'expiration', type: 'uint64' },
  ],
  Withdraw: [
    { name: 'brokerId', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'receiver', type: 'address' },
    { name: 'token', type: 'string' }, { name: 'amount', type: 'uint256' }, { name: 'withdrawNonce', type: 'uint64' },
    { name: 'timestamp', type: 'uint64' },
  ],
  SettlePnl: [
    { name: 'brokerId', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'settleNonce', type: 'uint64' },
    { name: 'timestamp', type: 'uint64' },
  ],
} as const;

export class ReplayContractClient implements ContractClient {
  readonly contractId = 'replay';
  readonly #config: ReplayContractConfig;
  readonly #desks = new Map<string, DeskView>();
  readonly #prices = new Map<string, StoredPrice>();
  readonly #keys: Record<string, ReplayKeys>;
  readonly #now: () => number;
  readonly #hlNonces = new Map<string, number>();
  readonly #rescueSpent = new Map<string, { e8: bigint; at: number }>();
  readonly #evmCounters = new Map<string, bigint>();
  #requestId = 0;
  /** Every action method call, in order: what a test asserts on. */
  readonly calls: { method: string; args: unknown }[] = [];

  constructor(options: ReplayContractClientOptions) {
    this.#config = options.config;
    for (const [id, desk] of Object.entries(options.desks ?? {})) this.#desks.set(id, structuredClone(desk));
    for (const p of options.prices ?? []) this.#prices.set(p.asset, p);
    this.#keys = options.keys ?? {};
    this.#now = options.now ?? Date.now;
  }

  // ---- state the demo and tests drive ----

  setDesk(deskId: string, desk: DeskView): void {
    this.#desks.set(deskId, structuredClone(desk));
  }

  /** The request_id the next signature gets (the contract's next_request_id), e.g. a vector's. */
  setNextRequestId(requestId: number): void {
    this.#requestId = requestId - 1;
  }

  /** set_mock_price: the contract owner's Mock price source. */
  setPrice(asset: string, priceE8: number | string, atMs: number = this.#now()): void {
    this.#prices.set(asset, { asset, price_e8: priceE8, at_ms: atMs });
  }

  // ---- views ----

  async getDesk(deskId: string): Promise<DeskView | null> {
    const d = this.#desks.get(deskId);
    return d === undefined ? null : structuredClone(d);
  }

  async prices(): Promise<StoredPrice[]> {
    return [...this.#prices.values()].map((p) => ({ ...p }));
  }

  // ---- prices and pause ----

  /** The Mock source has no oracle to ask: a refresh stamps the stored prices of these assets as read now. */
  async refreshPrices(assets: string[]): Promise<TxRef[]> {
    this.calls.push({ method: 'refresh_prices', args: { assets } });
    for (const a of assets) {
      const p = this.#prices.get(a);
      if (p !== undefined) this.#prices.set(a, { ...p, at_ms: this.#now() });
    }
    return [];
  }

  async pause(deskId: string): Promise<TxRef[]> {
    this.calls.push({ method: 'set_paused', args: { desk_id: deskId, paused: true } });
    this.#desk(deskId).paused = true;
    return [];
  }

  // ---- Hyperliquid ----

  async hlOrder(deskId: string, order: HlOrder, reason: string): Promise<HlSignedAction> {
    this.calls.push({ method: 'hl_order', args: { desk_id: deskId, order, reason } });
    const desk = this.#gate(deskId, order.reduce_only ? 'reduces-risk' : 'running');
    checkReason(reason);
    const checked = checkHlOrder(desk.policy, order, (symbol) => this.#reference(symbol, desk.policy.oracle_max_age_s));
    const wire: Record<string, MsgpackValue> = {
      a: order.asset, b: order.is_buy, p: order.px, s: order.sz, r: order.reduce_only, t: { limit: { tif: order.tif } },
    };
    if (checked.cloid !== null) wire.c = checked.cloid;
    const action = {
      type: 'order', orders: [wire], grouping: 'na',
      builder: { b: this.#config.hlBuilder, f: this.#config.hlBuilderTenthBps },
    };
    return this.#hlL1(deskId, 'order', action);
  }

  async hlCancel(deskId: string, asset: number, oid: number, reason: string): Promise<HlSignedAction> {
    this.calls.push({ method: 'hl_cancel', args: { desk_id: deskId, asset, oid, reason } });
    this.#gate(deskId, 'reduces-risk');
    checkReason(reason);
    return this.#hlL1(deskId, 'cancel', { type: 'cancel', cancels: [{ a: asset, o: oid }] });
  }

  async hlSetReferrer(deskId: string): Promise<HlSignedAction> {
    this.calls.push({ method: 'hl_set_referrer', args: { desk_id: deskId } });
    this.#gate(deskId, 'running');
    const code = this.#config.hlReferralCode ?? null;
    if (code === null) throw new ContractRefusal('E_ARGS', 'no Hyperliquid referral code is configured');
    return this.#hlL1(deskId, 'setReferrer', { type: 'setReferrer', code });
  }

  async hlApproveBuilderFee(deskId: string): Promise<HlSignedAction> {
    this.calls.push({ method: 'hl_approve_builder_fee', args: { desk_id: deskId } });
    this.#gate(deskId, 'running');
    const nonce = this.#hlNonce(deskId);
    const tenth = this.#config.hlBuilderTenthBps;
    return this.#hlUser(deskId, 'approveBuilderFee', {
      type: 'approveBuilderFee', signatureChainId: HL_SIGNATURE_CHAIN_ID, hyperliquidChain: this.#hlChain(),
      maxFeeRate: `${formatTenthBps(tenth)}%`, builder: this.#config.hlBuilder, nonce,
    }, nonce);
  }

  async hlUsdClassTransfer(deskId: string, amount: string, toPerp: boolean, reason: string): Promise<HlSignedAction> {
    this.calls.push({ method: 'hl_usd_class_transfer', args: { desk_id: deskId, amount, to_perp: toPerp, reason } });
    this.#gate(deskId, 'running');
    checkReason(reason);
    checkUsdcAmount(amount);
    const nonce = this.#hlNonce(deskId);
    return this.#hlUser(deskId, 'usdClassTransfer', {
      type: 'usdClassTransfer', signatureChainId: HL_SIGNATURE_CHAIN_ID, hyperliquidChain: this.#hlChain(), amount, toPerp, nonce,
    }, nonce);
  }

  /** withdraw3 to the desk's own EVM address; allowed on a paused desk (it reduces nothing, but a rescue needs it). */
  async hlWithdraw(deskId: string, amount: string): Promise<HlSignedAction> {
    this.calls.push({ method: 'hl_withdraw', args: { desk_id: deskId, amount } });
    const desk = this.#gate(deskId, 'reduces-risk');
    // The operator's hl_withdraw counts against the hourly rescue cap, as the contract counts it (C9).
    this.#countRescue(deskId, desk, checkUsdcAmount(amount), 'hl_withdraw');
    const nonce = this.#hlNonce(deskId);
    return this.#hlUser(deskId, 'withdraw3', {
      type: 'withdraw3', signatureChainId: HL_SIGNATURE_CHAIN_ID, hyperliquidChain: this.#hlChain(), destination: desk.evm_address.toLowerCase(), amount, time: nonce,
    }, nonce);
  }

  /** sendAsset to the quote's deposit address; the 1Click quote signature is not verified in replay. */
  async hlSendToIntents(deskId: string, quote: SignedQuote, reason: string): Promise<HlSignedAction> {
    this.calls.push({ method: 'hl_send_to_intents', args: { desk_id: deskId, quote, reason } });
    this.#gate(deskId, 'reduces-risk');
    checkReason(reason);
    const q = quoteFields(quote);
    const nonce = this.#hlNonce(deskId);
    return this.#hlUser(deskId, 'sendAsset', {
      type: 'sendAsset', signatureChainId: HL_SIGNATURE_CHAIN_ID, hyperliquidChain: this.#hlChain(),
      destination: q.depositAddress.toLowerCase(), sourceDex: '', destinationDex: 'spot',
      token: this.#config.network === 'mainnet' ? 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054' : 'USDC:0xeb62eee3685fc4c43992febcd9e75443',
      // HyperCore USDC has 8 decimals in 1Click quotes, as the contract reads amountIn.
      amount: unitsToDecimal(q.amountIn, 8), fromSubAccount: '', nonce,
    }, nonce);
  }

  // ---- Solana ----

  async solSign(deskId: string, messageB64: string, reason: string): Promise<SolSignedAction> {
    this.calls.push({ method: 'sol_sign', args: { desk_id: deskId, message_b64: messageB64, reason } });
    const desk = this.#gate(deskId, 'reduces-risk');
    checkReason(reason);
    return this.#sol(deskId, desk, 'transaction', messageB64, 1);
  }

  async solSignRegister(deskId: string, messageB64: string): Promise<SolSignedAction> {
    this.calls.push({ method: 'sol_sign_register', args: { desk_id: deskId, message_b64: messageB64 } });
    const desk = this.#gate(deskId, 'running');
    return this.#sol(deskId, desk, 'register', messageB64, 2);
  }

  async solSignRescue(deskId: string, messageB64: string, quote: SignedQuote, reason: string): Promise<SolSignedAction> {
    this.calls.push({ method: 'sol_sign_rescue', args: { desk_id: deskId, message_b64: messageB64, quote, reason } });
    const desk = this.#gate(deskId, 'reduces-risk');
    checkReason(reason);
    this.#countRescue(deskId, desk, BigInt(quoteFields(quote).amountIn) * 100n, 'sol_sign_rescue');
    return this.#sol(deskId, desk, 'rescue', messageB64, 1);
  }

  // ---- Orderly ----

  async orderlyRequest(deskId: string, req: OrderlyRequest, reason: string): Promise<OrderlyRestAction> {
    this.calls.push({ method: 'orderly_request', args: { desk_id: deskId, req, reason } });
    const desk = this.#gate(deskId, req.kind === 'order' && !req.reduce_only ? 'running' : 'reduces-risk');
    checkReason(reason);
    checkOrderlyTimestamp('timestamp_ms', req.timestamp_ms, this.#now());
    if (req.client_order_id !== undefined && req.client_order_id !== null) {
      throw new ContractRefusal('E_ARGS', 'client_order_id is the contract\'s (g<request_id>), never the caller\'s: leave it null');
    }
    const route = this.#orderlyRoute(deskId, desk, req);
    const message = orderlyRestMessage(req.timestamp_ms, route.method, route.path, route.body);
    return this.#orderlyRest(deskId, req.kind, { ...route, timestamp: req.timestamp_ms, message });
  }

  async orderlyWsAuth(deskId: string, timestamp: number): Promise<OrderlyRestAction> {
    this.calls.push({ method: 'orderly_ws_auth', args: { desk_id: deskId, timestamp } });
    this.#gate(deskId, 'reduces-risk');
    checkOrderlyTimestamp('timestamp', timestamp, this.#now());
    // The contract's ws auth payload has no HTTP method: "".
    return this.#orderlyRest(deskId, ORDERLY_WS_AUTH_KIND, { method: '', path: '', body: '', timestamp, message: String(timestamp) });
  }

  async orderlyRegister(deskId: string, registrationNonce: string): Promise<OrderlyEip712Action> {
    this.calls.push({ method: 'orderly_register', args: { desk_id: deskId, registration_nonce: registrationNonce } });
    this.#gate(deskId, 'running');
    if (!/^\d+$/.test(registrationNonce)) throw new ContractRefusal('E_ARGS', 'registration_nonce must be decimal digits');
    return this.#orderlyEip712(deskId, 'register', 'Registration', {
      brokerId: this.#brokerId(), chainId: this.#orderlyChainId(), timestamp: this.#now(), registrationNonce,
    });
  }

  async orderlyAddKey(deskId: string, expirationMs: number): Promise<OrderlyEip712Action> {
    this.calls.push({ method: 'orderly_add_key', args: { desk_id: deskId, expiration_ms: expirationMs } });
    const desk = this.#gate(deskId, 'running');
    const now = this.#now();
    if (expirationMs <= now || expirationMs - now > 365 * 86_400_000) throw new ContractRefusal('E_ARGS', 'expiration_ms must be within 365 days from now');
    return this.#orderlyEip712(deskId, 'add_key', 'AddOrderlyKey', {
      brokerId: this.#brokerId(), chainId: this.#orderlyChainId(), orderlyKey: `ed25519:${desk.solana.authority}`,
      scope: 'read,trading', timestamp: now, expiration: expirationMs,
    });
  }

  async orderlySettlePnl(deskId: string, settleNonce: number): Promise<OrderlyEip712Action> {
    this.calls.push({ method: 'orderly_settle_pnl', args: { desk_id: deskId, settle_nonce: settleNonce } });
    this.#gate(deskId, 'reduces-risk');
    return this.#orderlyEip712(deskId, 'settle_pnl', 'SettlePnl', {
      brokerId: this.#brokerId(), chainId: this.#orderlyChainId(), settleNonce, timestamp: this.#now(),
    });
  }

  async orderlyWithdraw(deskId: string, amount: string, withdrawNonce: number): Promise<OrderlyEip712Action> {
    this.calls.push({ method: 'orderly_withdraw', args: { desk_id: deskId, amount, withdraw_nonce: withdrawNonce } });
    const desk = this.#gate(deskId, 'reduces-risk');
    const units = checkUsdcAmount(amount) / 100n;          // 1e-8 -> USDC's 1e-6
    return this.#orderlyEip712(deskId, 'withdraw', 'Withdraw', {
      brokerId: this.#brokerId(), chainId: this.#orderlyChainId(), receiver: desk.evm_address, token: 'USDC',
      amount: units.toString(), withdrawNonce, timestamp: this.#now(),
    });
  }

  // ---- Arbitrum and NEAR money paths ----

  async evmUsdcToIntents(deskId: string, quote: SignedQuote, reason: string): Promise<Eip3009SignedAction> {
    this.calls.push({ method: 'evm_usdc_to_intents', args: { desk_id: deskId, quote, reason } });
    const desk = this.#gate(deskId, 'reduces-risk');
    checkReason(reason);
    const q = quoteFields(quote);
    this.#countRescue(deskId, desk, BigInt(q.amountIn) * 100n, 'evm_usdc_to_intents');
    const counter = this.#evmCounters.get(deskId) ?? 0n;
    this.#evmCounters.set(deskId, counter + 1n);
    const usdc = USDC_ARBITRUM[this.#config.network];
    const message = {
      from: desk.evm_address, to: q.depositAddress, value: q.amountIn, validAfter: '0',
      validBefore: String(Math.floor(this.#now() / 1000) + EIP3009_VALID_S), nonce: eip3009Nonce(deskId, counter),
    };
    const key = this.#keys[deskId]?.evm;
    const signature = key === undefined ? fakeSecp(JSON.stringify(message)) : toMpc(await signTypedData({
      privateKey: key,
      domain: { name: 'USD Coin', version: '2', chainId: usdc.chainId, verifyingContract: usdc.token as Hex },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: message.from as Hex, to: message.to as Hex, value: BigInt(message.value), validAfter: 0n,
        validBefore: BigInt(message.validBefore), nonce: message.nonce,
      },
    }));
    return this.#action(deskId, 'arbitrum', 'transfer_with_authorization', { ...message, token: usdc.token, chainId: usdc.chainId }, signature);
  }

  async fundVenue(deskId: string, quote: SignedQuote, reason: string): Promise<TxRef[]> {
    this.calls.push({ method: 'fund_venue', args: { desk_id: deskId, quote, reason } });
    this.#gate(deskId, 'reduces-risk');
    checkReason(reason);
    quoteFields(quote);
    return [];
  }

  // ---- internals ----

  /** The contract's hourly rescue meter: what was spent decays linearly over an hour (rescue.rs DeskCounters). */
  #countRescue(deskId: string, desk: DeskView, amountE8: bigint, method: string): void {
    const now = this.#now();
    const cap = BigInt(Math.round(desk.policy.rescue_cap_usd_per_hour * 1e6)) * 100n;
    const prev = this.#rescueSpent.get(deskId);
    const left = prev === undefined ? 0n : BigInt(Math.max(0, 3_600_000 - (now - prev.at)));
    const spent = prev === undefined ? 0n : (prev.e8 * left) / 3_600_000n;
    if (spent + amountE8 > cap) {
      throw new ContractRefusal('E_RESCUE_CAP', `${method} of ${amountE8} (USD × 1e8) is over what is left of the hourly rescue cap (${cap - spent})`);
    }
    this.#rescueSpent.set(deskId, { e8: spent + amountE8, at: now });
  }

  #desk(deskId: string): DeskView {
    checkDeskId(deskId);
    const desk = this.#desks.get(deskId);
    if (desk === undefined) throw new ContractRefusal('E_NO_DESK', `no desk ${deskId}`);
    return desk;
  }

  #gate(deskId: string, gate: 'running' | 'reduces-risk'): DeskView {
    const desk = this.#desk(deskId);
    if (desk.paused && gate === 'running') throw new ContractRefusal('E_PAUSED', `desk ${deskId} is paused`);
    return desk;
  }

  /** prices.rs reference_price: the stored price of `symbol` if it is at most max_age_s old (the edge allowed). */
  #reference(symbol: string, maxAgeS: number): bigint | null {
    const p = this.#prices.get(symbol);
    if (p === undefined) return null;
    const age = Math.max(0, this.#now() - p.at_ms);
    return age <= maxAgeS * 1000 ? BigInt(p.price_e8) : null;
  }

  /** The contract's per-desk nonce: max(block ms, last + 1). */
  #hlNonce(deskId: string): number {
    const n = Math.max(this.#now(), (this.#hlNonces.get(deskId) ?? 0) + 1);
    this.#hlNonces.set(deskId, n);
    return n;
  }

  #hlChain(): 'Mainnet' | 'Testnet' {
    return this.#config.network === 'mainnet' ? 'Mainnet' : 'Testnet';
  }

  async #hlL1(deskId: string, kind: string, action: Record<string, MsgpackValue> & { type: string }): Promise<HlSignedAction> {
    const nonce = this.#hlNonce(deskId);
    const expires = this.#config.hlExpiresAfterMs !== undefined && (kind === 'order' || kind === 'cancel') ? this.#now() + this.#config.hlExpiresAfterMs : undefined;
    const digest = l1Digest(action, nonce, this.#config.network, expires);
    const payload: HlPayload = expires === undefined ? { action, nonce, vaultAddress: null } : { action, nonce, vaultAddress: null, expiresAfter: expires };
    return this.#action(deskId, 'hyperliquid', kind, payload, await this.#secp(deskId, digest)) as HlSignedAction;
  }

  async #hlUser(deskId: string, kind: string, action: Record<string, unknown> & { type: string }, nonce: number): Promise<HlSignedAction> {
    const digest = userSignedDigest(action);
    return this.#action(deskId, 'hyperliquid', kind, { action, nonce }, await this.#secp(deskId, digest)) as HlSignedAction;
  }

  async #secp(deskId: string, digest: Hex): Promise<Secp256k1Signature> {
    const key = this.#keys[deskId]?.evm;
    if (key === undefined) return fakeSecp(digest);
    return toMpc(await secpSign({ hash: digest, privateKey: key, to: 'hex' }));
  }

  #sol(deskId: string, desk: DeskView, kind: string, messageB64: string, signers: number): SolSignedAction {
    const message = Buffer.from(messageB64, 'base64');
    if (message.length === 0 || message.toString('base64') !== messageB64) throw new ContractRefusal('E_ARGS', 'message_b64 is not standard base64 with padding');
    if (message.length > 1232 - 1 - 64 * signers) throw new ContractRefusal('E_SOL_MESSAGE', `message of ${message.length} bytes does not fit a transaction`);
    const legacy = message[0]! < 0x80;
    const header = legacy ? 0 : 1;
    if (message[header] !== signers) throw new ContractRefusal('E_SOL_MESSAGE', `the message has ${message[header]} signers, expected ${signers}`);
    const keyAt = header + 3 + 1;
    const feePayer = base58(message.subarray(keyAt, keyAt + 32));
    if (feePayer !== desk.solana.authority) throw new ContractRefusal('E_SOL_MESSAGE', 'keys[0] is not the desk authority');
    const seed = this.#keys[deskId]?.sol;
    const signature: Ed25519Signature = seed === undefined ? fakeEd(message) : { scheme: 'Ed25519', signature: [...ed25519Sign(seed, message)] };
    return this.#action(deskId, 'phoenix', kind, { message_b64: messageB64 }, signature) as SolSignedAction;
  }

  #brokerId(): string {
    return this.#config.orderlyBrokerId ?? (this.#config.network === 'mainnet' ? 'gimbal_dex' : 'woofi_dex');
  }

  #orderlyChainId(): number {
    return this.#config.orderlyChainId ?? USDC_ARBITRUM[this.#config.network].chainId;
  }

  /** The path and body the contract builds for each kind (orderly.json request_rules). */
  #orderlyRoute(deskId: string, desk: DeskView, req: OrderlyRequest): { method: string; path: string; body: string } {
    const symbol = (): string => {
      const s = req.symbol ?? '';
      if (!desk.policy.orderly_symbols.includes(s)) throw new ContractRefusal('E_ASSET', `Orderly symbol ${s} is not in the desk's policy`);
      return s;
    };
    switch (req.kind) {
      case 'order': {
        const s = symbol();
        const type = req.order_type ?? 'IOC';
        const fields: string[] = [`"symbol":${JSON.stringify(s)}`];
        // The contract's id, from the request_id this signature gets.
        fields.push(`"client_order_id":${JSON.stringify(standInClientOrderId(this.#requestId + 1))}`);
        fields.push(`"order_type":${JSON.stringify(type)}`);
        if (type !== 'MARKET') fields.push(`"order_price":${decimalNumber('price', req.price)}`);
        fields.push(`"order_quantity":${decimalNumber('quantity', req.quantity)}`);
        fields.push(`"side":${JSON.stringify(req.side ?? 'BUY')}`);
        if (req.reduce_only) fields.push('"reduce_only":true');
        return { method: 'POST', path: '/v1/order', body: `{${fields.join(',')}}` };
      }
      case 'cancel': return { method: 'DELETE', path: `/v1/order?order_id=${req.order_id ?? 0}&symbol=${symbol()}`, body: '' };
      case 'cancel_all': return { method: 'DELETE', path: `/v1/orders?symbol=${symbol()}`, body: '' };
      case 'receiver_address': return { method: 'GET', path: `/v1/client/asset/receiver_address?chain_id=${this.#orderlyChainId()}&token=USDC`, body: '' };
      case 'settle_nonce': return { method: 'GET', path: '/v1/settle_nonce', body: '' };
      case 'withdraw_nonce': return { method: 'GET', path: '/v1/withdraw_nonce', body: '' };
      case 'referral_bind': {
        const code = this.#config.orderlyReferralCode ?? null;
        if (code === null) throw new ContractRefusal('E_ARGS', 'no Orderly referral code is configured');
        return { method: 'POST', path: '/v1/referral/bind', body: JSON.stringify({ referral_code: code }) };
      }
      case 'funding_fee_history': {
        // As the contract: the fields given, in this order.
        const params = (['symbol', 'start_t', 'end_t', 'page', 'size'] as const)
          .filter((k) => req[k] !== undefined && req[k] !== null)
          .map((k) => `${k}=${req[k]}`);
        return { method: 'GET', path: `/v1/funding_fee/history${params.length === 0 ? '' : `?${params.join('&')}`}`, body: '' };
      }
      case 'positions': return { method: 'GET', path: '/v1/positions', body: '' };
      case 'holding': return { method: 'GET', path: '/v1/client/holding', body: '' };
      case 'ip_restriction': {
        // As interfaces 1.3: the body comes from the desk's orderly key and its set_orderly_ips list, never the caller.
        const ips = desk.orderly_ips ?? [];
        if (ips.length === 0) throw new ContractRefusal('E_ARGS', 'no Orderly IP list is set for this desk (set_orderly_ips)');
        const body = JSON.stringify({ orderly_key: `ed25519:${desk.solana.authority}`, ip_restriction_list: ips.join(',') });
        return { method: 'POST', path: '/v1/client/set_orderly_key_ip_restriction', body };
      }
      case 'settle_pnl': case 'withdraw_request': {
        const ledger = ORDERLY_LEDGER[this.#config.network];
        const ts = req.signed_at_ms ?? 0;
        const message = req.kind === 'settle_pnl'
          ? { brokerId: this.#brokerId(), chainId: this.#orderlyChainId(), settleNonce: req.nonce, timestamp: ts }
          : {
            brokerId: this.#brokerId(), chainId: this.#orderlyChainId(), receiver: desk.evm_address, token: 'USDC',
            amount: (checkUsdcAmount(req.amount ?? '') / 100n).toString(), withdrawNonce: req.nonce, timestamp: ts,
          };
        const body = JSON.stringify({ message, signature: req.eip712_signature, userAddress: desk.evm_address, verifyingContract: ledger });
        return { method: 'POST', path: req.kind === 'settle_pnl' ? '/v1/settle_pnl' : '/v1/withdraw_request', body };
      }
      default: throw new ContractRefusal('E_ARGS', `unknown Orderly request kind ${String(req.kind)}`);
    }
  }

  #orderlyRest(deskId: string, kind: string, payload: OrderlyRestAction['payload']): OrderlyRestAction {
    const seed = this.#keys[deskId]?.sol;
    const bytes = Buffer.from(payload.message, 'utf8');
    const signature: Ed25519Signature = seed === undefined ? fakeEd(bytes) : { scheme: 'Ed25519', signature: [...ed25519Sign(seed, bytes)] };
    return this.#action(deskId, 'orderly', kind, payload, signature) as OrderlyRestAction;
  }

  async #orderlyEip712(deskId: string, kind: string, type: keyof typeof ORDERLY_TYPES, message: Record<string, unknown> & { timestamp: number }): Promise<OrderlyEip712Action> {
    const desk = this.#desk(deskId);
    const key = this.#keys[deskId]?.evm;
    const onChain = type === 'Withdraw' || type === 'SettlePnl';
    const signature = key === undefined ? fakeSecp(JSON.stringify(message)) : toMpc(await signTypedData({
      privateKey: key,
      domain: { name: 'Orderly', version: '1', chainId: this.#orderlyChainId(), verifyingContract: (onChain ? ORDERLY_LEDGER[this.#config.network] : ORDERLY_OFF_CHAIN) as Hex },
      types: { [type]: ORDERLY_TYPES[type] },
      primaryType: type,
      message: Object.fromEntries(ORDERLY_TYPES[type].map((f) => [f.name, f.type.startsWith('uint') ? BigInt(message[f.name] as number | string) : message[f.name]])),
    }));
    return this.#action(deskId, 'orderly', kind, { message, userAddress: desk.evm_address }, signature) as OrderlyEip712Action;
  }

  #action<P, S extends Secp256k1Signature | Ed25519Signature>(deskId: string, venue: string, kind: string, payload: P, signature: S): SignedAction<P, S> {
    return { desk_id: deskId, request_id: ++this.#requestId, venue, kind, payload, signature, replay: true };
  }
}

// ---- helpers ----

/** As the contract: an Orderly timestamp at most ORDERLY_MAX_AHEAD_MS past the block time (E_ARGS). */
function checkOrderlyTimestamp(field: string, timestamp: number, blockMs: number): void {
  if (timestamp > blockMs + ORDERLY_MAX_AHEAD_MS) {
    throw new ContractRefusal('E_ARGS', `${field} ${timestamp} is more than ${ORDERLY_MAX_AHEAD_MS / 1000} s after the block time ${blockMs}`);
  }
}

function quoteFields(quote: SignedQuote): { depositAddress: string; amountIn: string } {
  // The contract takes the canonical JSON string 1Click signed; older callers pass the object.
  const raw = typeof quote.quote === 'string' ? (() => { try { return JSON.parse(quote.quote as string) as unknown; } catch { return {}; } })() : quote.quote;
  const q = (raw ?? {}) as { quote?: { depositAddress?: unknown; amountIn?: unknown }; depositAddress?: unknown; amountIn?: unknown };
  const inner = (q.quote ?? q) as { depositAddress?: unknown; amountIn?: unknown };
  if (typeof inner.depositAddress !== 'string' || typeof inner.amountIn !== 'string' || !/^\d+$/.test(inner.amountIn)) {
    throw new ContractRefusal('E_QUOTE_FIELDS', 'the quote has no depositAddress or amountIn');
  }
  if (typeof quote.quote_signature !== 'string' || quote.quote_signature === '') throw new ContractRefusal('E_QUOTE_SIGNATURE', 'the quote has no signature');
  return { depositAddress: inner.depositAddress, amountIn: inner.amountIn };
}

/** "10" tenths of a bp -> "0.01" (percent). */
function formatTenthBps(tenth: number): string {
  return unitsToDecimal(String(tenth), 3);
}

function unitsToDecimal(units: string, decimals: number): string {
  const n = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  const frac = (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac === '' ? (n / scale).toString() : `${n / scale}.${frac}`;
}

/** A canonical decimal written as a bare JSON number, as the contract writes Orderly prices and quantities. */
function decimalNumber(field: string, value: string | null | undefined): string {
  if (value === null || value === undefined) throw new ContractRefusal('E_ARGS', `orderly order needs ${field}`);
  parseE8(field, value);
  return value;
}

/** keccak256(utf8(desk_id) ‖ counter as u64 big-endian): the contract's EIP-3009 nonce rule. */
export function eip3009Nonce(deskId: string, counter: bigint): Hex {
  const id = toBytes(deskId);
  const bytes = new Uint8Array(id.length + 8);
  bytes.set(id, 0);
  for (let i = 0; i < 8; i++) bytes[id.length + 7 - i] = Number((counter >> BigInt(8 * i)) & 0xffn);
  return keccak256(bytes);
}

/** A viem signature (r ‖ s ‖ v hex) in the MPC network's shape. */
export function toMpc(hex: Hex): Secp256k1Signature {
  const h = hex.slice(2);
  const v = Number.parseInt(h.slice(128, 130), 16);
  const recovery = v >= 27 ? v - 27 : v;
  return { scheme: 'Secp256k1', big_r: { affine_point: `${recovery === 0 ? '02' : '03'}${h.slice(0, 64)}` }, s: { scalar: h.slice(64, 128) }, recovery_id: recovery };
}

const sha256 = (data: string | Uint8Array): Buffer => createHash('sha256').update(data).digest();

function fakeSecp(seed: string): Secp256k1Signature {
  const r = sha256(`replay r ${seed}`).toString('hex');
  const s = `0${sha256(`replay s ${seed}`).toString('hex').slice(1)}`;
  return { scheme: 'Secp256k1', big_r: { affine_point: `02${r}` }, s: { scalar: s }, recovery_id: 0 };
}

function fakeEd(message: Uint8Array): Ed25519Signature {
  return { scheme: 'Ed25519', signature: [...sha256(Buffer.concat([Buffer.from('replay a '), message])), ...sha256(Buffer.concat([Buffer.from('replay b '), message]))] };
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function ed25519Sign(seed: Uint8Array, message: Uint8Array): Buffer {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  return edSign(null, message, key);
}
