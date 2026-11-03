// NEAR Intents 1Click for the rescue (CLAUDE.md, docs/interfaces.md §1.3 "1Click quotes"): the quote request, the
// canonical JSON the contract hashes, 1Click's signature, the contract's field rules, and the three calls a transfer
// makes (POST /quote, POST /deposit/submit, GET /status). Ported from the money scripts' tools/mainnet/oneclick.mjs
// (itself a port of contract/core/src/oneclick.rs) so a quote is refused here, before anything is signed, for the same
// reasons the contract would refuse it. Tests run it against the contract's own live vectors.
//
// The API sits behind OneClickApi: HttpOneClick on mainnet, RecordedOneClick (recorded.ts) on testnet and in replay,
// where 1Click has no network to answer. A key (ONECLICK_API_KEY) only lowers 1Click's fee; it goes in a header and is
// never printed.

import { createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto';
import { base58 } from '../venues/orderly-signer.ts';
import { base58Decode } from '../relayer/solana.ts';

export const ONECLICK_API = 'https://1click.chaindefuser.com/v0';
/** 1Click's quote signing key (CLAUDE.md), base58. */
export const ONECLICK_PUBLIC_KEY = 'reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

/** 1Click asset ids (contract/core/src/oneclick.rs). */
export const ASSETS = {
  hypercoreUsdc: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054',
  solanaUsdc: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  arbitrumUsdc: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  nearUsdc: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
} as const;
export const DECIMALS: Record<string, number> = {
  [ASSETS.hypercoreUsdc]: 8, [ASSETS.solanaUsdc]: 6, [ASSETS.arbitrumUsdc]: 6, [ASSETS.nearUsdc]: 6,
};

/** The least minAmountOut into the Orderly receiver, USDC × 1e6 (Orderly loses a deposit under 5). */
export const ORDERLY_MIN_OUT_E6 = 6_000_000n;
/** The least a transfer into HyperCore may deliver: 0.5 USDC in HyperCore's 8 decimals (1Click's minimum there). */
export const HYPERCORE_MIN_E8 = 50_000_000n;
/** fund_venue: amountOut − minAmountOut ≥ this share of amountOut, bps. */
export const FUND_VENUE_MIN_ROOM_BPS = 50n;
export const QUOTE_MAX_AGE_MS = 3_600_000;
export const QUOTE_MAX_AHEAD_MS = 300_000;

/** The contract methods that pay a quote, and the asset each one sends. */
export type QuotedMethod = 'sol_sign_rescue' | 'hl_send_to_intents' | 'evm_usdc_to_intents' | 'fund_venue';
export const METHOD_ORIGIN: Record<QuotedMethod, string> = {
  sol_sign_rescue: ASSETS.solanaUsdc,
  hl_send_to_intents: ASSETS.hypercoreUsdc,
  evm_usdc_to_intents: ASSETS.arbitrumUsdc,
  fund_venue: ASSETS.nearUsdc,
};

/** The fields 1Click signs (contract/core/tests/vectors/oneclick-live.json, signed_fields). */
const SIGNED_REQUEST = ['dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline'];
const SIGNED_REQUEST_IF_TRUTHY = ['quoteWaitingTimeMs', 'referral', 'virtualChainRecipient', 'virtualChainRefundRecipient', 'customRecipientMsg'];
const SIGNED_QUOTE = ['amountIn', 'amountInFormatted', 'amountInUsd', 'minAmountIn', 'amountOut', 'amountOutFormatted', 'amountOutUsd', 'minAmountOut'];
const SIGNED_QUOTE_IF_TRUTHY = ['depositAddress', 'depositMemo', 'deadline', 'timeWhenInactive', 'timeEstimate', 'refundFee', 'withdrawFee'];

/** POST /quote's body (the fields Gimbal sends; no appFees). */
export interface QuoteRequest {
  dry: boolean;
  swapType: 'EXACT_INPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: 'ORIGIN_CHAIN';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  customRecipientMsg?: string;
  deadline: string;
}

/** 1Click's answer to a quote: the echoed request, the quote, its signature and when it signed. */
export interface QuoteResponse {
  quote: Record<string, unknown>;
  quoteRequest: Record<string, unknown>;
  signature: string;
  timestamp: string;
}

/** A quote answer: a signed quote, or 1Click's refusal ("Quoting for this pair is not available" is a normal one). */
export type QuoteAnswer = { ok: true; response: QuoteResponse } | { ok: false; status: number; message: string };

/** GET /status: the status word and the body (swapDetails carries the delivery's transactions). */
export interface StatusAnswer {
  status: string;
  body: Record<string, unknown> | null;
}

/** Statuses that end a transfer (INCOMPLETE_DEPOSIT: less than amountIn arrived; 1Click refunds it). */
export const FINAL_STATUSES: readonly string[] = ['SUCCESS', 'REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'];

export interface OneClickApi {
  /** Where the answers come from, for the journal: 'live' or a recording's name. */
  readonly source: string;
  quote(body: QuoteRequest): Promise<QuoteAnswer>;
  submitDeposit(txHash: string, depositAddress: string): Promise<{ status: number }>;
  status(depositAddress: string): Promise<StatusAnswer>;
  /** Recorded mode: the time a recorded quote is checked at (its own signing time), so its age rule still holds. */
  verifyAt?(response: QuoteResponse): number;
  /** The key quotes are signed with when it is not 1Click's (tests sign their own quotes). */
  readonly publicKey?: string;
}

/** A refusal with the contract's code: `E_QUOTE_FIELDS: …`. */
export class QuoteRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'QuoteRefusal';
    this.code = code;
  }
}
const fields = (msg: string) => new QuoteRefusal('E_QUOTE_FIELDS', msg);

/** json-stable-stringify: sorted keys, no spaces, undefined members dropped (null in arrays). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * The exact string the contract takes as `quote`: the signed request fields (from 1Click's echoed quoteRequest), the
 * signed quote fields (a live quote's own deadline replaces the requested one) and the timestamp.
 */
export function canonicalQuote(response: QuoteResponse): string {
  const req = response.quoteRequest;
  const q = response.quote;
  if (req === null || typeof req !== 'object' || q === null || typeof q !== 'object' || typeof response.timestamp !== 'string') {
    throw new Error('1Click answer: no quote, quoteRequest or timestamp');
  }
  const out: Record<string, unknown> = {};
  for (const k of SIGNED_REQUEST) out[k] = req[k];
  for (const k of SIGNED_REQUEST_IF_TRUTHY) if (req[k]) out[k] = req[k];
  for (const k of SIGNED_QUOTE) out[k] = q[k];
  // A dry quote's message has none of the live fields, even those it echoes.
  if (req.dry !== true) for (const k of SIGNED_QUOTE_IF_TRUTHY) if (q[k]) out[k] = q[k];
  out.timestamp = response.timestamp;
  return stableStringify(out);
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest();

/** E_QUOTE_SIGNATURE unless `signature` is `publicKey`'s over the UTF-8 of base58(sha256(quote)). */
export function checkQuoteSignature(quote: string, signature: string, publicKey: string = ONECLICK_PUBLIC_KEY): void {
  const bad = (msg: string) => new QuoteRefusal('E_QUOTE_SIGNATURE', msg);
  if (typeof signature !== 'string' || !signature.startsWith('ed25519:')) throw bad('quote_signature is not ed25519:<base58>');
  let raw: Buffer | null;
  try {
    const encoded = signature.slice('ed25519:'.length);
    raw = encoded.length > 88 ? null : base58Decode(encoded);
  } catch {
    raw = null;
  }
  if (raw === null || raw.length !== 64) throw bad('quote_signature is not 64 bytes of base58');
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, base58Decode(publicKey)]), format: 'der', type: 'spki' });
  const message = Buffer.from(base58(sha256(Buffer.from(quote, 'utf8'))), 'utf8');
  if (!ed25519Verify(null, message, key, raw)) throw bad('quote_signature is not 1Click\'s signature of this quote (it covers the exact string)');
}

/** `YYYY-MM-DDTHH:MM:SS[.f{1,3}]Z` as ms; null otherwise (oneclick.rs parse_time_ms). */
export function parseTimeMs(s: unknown): number | null {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(s) : null;
  if (m === null) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > days[mo - 1]! || h > 23 || mi > 59 || se > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi, se, ms);
}

/** An amount in an asset of `decimals` (at most 8) as USDC × 1e8. */
export const toE8 = (amount: bigint, decimals: number): bigint => amount * 10n ** BigInt(Math.max(0, 8 - decimals));

/** USD × 1e8 as text: 0.3557 */
export function e8Text(e8: bigint): string {
  const neg = e8 < 0n;
  const v = neg ? -e8 : e8;
  const frac = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${v / 100_000_000n}${frac === '' ? '' : `.${frac}`}`;
}

/** Where a quote may deliver for this desk (the contract's recipient rule) and who may get its refund. */
export interface DeskAddresses {
  deskId: string;
  /** The gimbal contract: the recipient of a return to NEAR, with customRecipientMsg {"desk_id"}. */
  contract: string;
  owner: string;
  evm: string;
  sol: string;
  orderlyReceiver: string | null;
}

/** A quote the field rules accept: the canonical string, its signature and what the contract will read from it. */
export interface VerifiedQuote {
  method: QuotedMethod;
  quote: string;
  signature: string;
  depositAddress: string;
  amountIn: bigint;
  amountInE8: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  minAmountOutE8: bigint;
  destinationAsset: string;
  recipient: string;
  /** amountIn − minAmountOut, USD × 1e8: what the contract counts as the transfer's cost. */
  costE8: bigint;
  signedAtMs: number;
  /** 1Click's own estimate, s. */
  timeEstimateS: number | null;
}

export interface QuoteCheck {
  desk: DeskAddresses;
  nowMs: number;
  /** policy.max_transfer_cost_bps / _flat_e6: the cost bound every quote must fit. */
  maxCostBps: number;
  maxCostFlatE6: number;
  /** What is left of the hourly rescue cap, USD × 1e8 (rescue methods only). */
  remainingCapE8: bigint | null;
  /** 1Click's verifying key; default ONECLICK_PUBLIC_KEY (tests sign synthetic routes with a key of their own). */
  publicKey?: string;
}

const sameEvm = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function amount(field: string, s: unknown): bigint {
  if (typeof s !== 'string' || !/^(0|[1-9]\d*)$/.test(s) || BigInt(s) >= 2n ** 128n) throw fields(`${field} ${JSON.stringify(s)} is not an amount`);
  return BigInt(s);
}

/**
 * verify_quote of contract/core/src/oneclick.rs for a live quote: the signature, then the field rules, then the
 * cost bound and (for a rescue method) the hourly cap. Throws QuoteRefusal with the contract's code.
 */
export function verifyQuote(response: QuoteResponse, method: QuotedMethod, ctx: QuoteCheck): VerifiedQuote {
  if (typeof response?.signature !== 'string') throw new QuoteRefusal('E_QUOTE_SIGNATURE', '1Click answered without a signature');
  const quote = canonicalQuote(response);
  checkQuoteSignature(quote, response.signature, ctx.publicKey);
  const f = JSON.parse(quote) as Record<string, unknown>;
  if (f.dry !== false || typeof f.depositAddress !== 'string') throw fields('not a live quote with a deposit address (a dry quote cannot be paid)');
  const origin = METHOD_ORIGIN[method];
  if (f.originAsset !== origin) throw fields(`originAsset ${JSON.stringify(f.originAsset)} is not what ${method} sends (${origin})`);
  if (f.destinationAsset === f.originAsset) throw fields('destinationAsset is the originAsset: a transfer into the same asset only pays fees');
  const d = ctx.desk;
  const refundOk = method === 'sol_sign_rescue' ? f.refundTo === d.sol : method === 'fund_venue' ? f.refundTo === d.owner : sameEvm(f.refundTo, d.evm);
  if (!refundOk) throw fields(`refundTo ${JSON.stringify(f.refundTo)} is not where ${method} takes money from`);
  if (f.recipientType !== 'DESTINATION_CHAIN') throw fields('recipientType is not DESTINATION_CHAIN');
  const minAmountOut = amount('minAmountOut', f.minAmountOut);
  const dest = f.destinationAsset;
  const to = f.recipient;
  if (to === d.contract && dest === ASSETS.nearUsdc) {
    if (f.customRecipientMsg !== JSON.stringify({ desk_id: d.deskId })) throw fields('customRecipientMsg must name this desk exactly');
  } else if (f.customRecipientMsg !== undefined) {
    throw fields('customRecipientMsg goes only with the contract as recipient');
  } else if (d.orderlyReceiver !== null && sameEvm(to, d.orderlyReceiver) && dest === ASSETS.arbitrumUsdc) {
    if (minAmountOut < ORDERLY_MIN_OUT_E6) throw fields(`minAmountOut ${e8Text(minAmountOut * 100n)} is below 6 USDC for the Orderly receiver (Orderly loses a deposit under 5)`);
  } else if (!((sameEvm(to, d.evm) && dest === ASSETS.hypercoreUsdc) || (to === d.sol && dest === ASSETS.solanaUsdc))) {
    throw fields(`recipient ${JSON.stringify(to)} with ${JSON.stringify(dest)} is not a desk address`);
  } else if (dest === ASSETS.hypercoreUsdc && minAmountOut < HYPERCORE_MIN_E8) {
    // The engine's own rule (the contract does not have it): under 1Click's minimum the delivery fails and refunds.
    throw fields(`minAmountOut ${e8Text(minAmountOut)} is below the 0.5 USDC HyperCore takes`);
  }
  const amountOut = amount('amountOut', f.amountOut);
  if (method === 'fund_venue') {
    const room = amountOut > minAmountOut ? amountOut - minAmountOut : 0n;
    if (room * 10_000n < amountOut * FUND_VENUE_MIN_ROOM_BPS) throw fields('minAmountOut leaves less than 0.5 % below amountOut (fund_venue\'s room rule)');
  }
  if (f.swapType !== 'EXACT_INPUT') throw fields('swapType is not EXACT_INPUT');
  if (f.depositType !== 'ORIGIN_CHAIN' || f.refundType !== 'ORIGIN_CHAIN') throw fields('depositType and refundType must be ORIGIN_CHAIN');
  if (f.depositMemo !== undefined) throw fields('a deposit memo cannot be paid');
  const amountIn = amount('amountIn', f.amountIn);
  if (f.amount !== f.amountIn || amountIn === 0n) throw fields('amountIn must equal the requested amount and not be zero');
  const deadlineMs = parseTimeMs(f.deadline);
  if (deadlineMs === null || ctx.nowMs >= deadlineMs) throw fields(`deadline ${String(f.deadline)} is not a UTC time ahead of now`);
  const signedAtMs = parseTimeMs(f.timestamp);
  if (signedAtMs === null) throw fields('timestamp is not a UTC time');
  if (ctx.nowMs - signedAtMs > QUOTE_MAX_AGE_MS) throw fields('the quote was signed more than 1 h ago');
  if (signedAtMs - ctx.nowMs > QUOTE_MAX_AHEAD_MS) throw fields('the quote was signed more than 5 min ahead of now');
  const amountInE8 = toE8(amountIn, DECIMALS[origin] ?? 6);
  const minAmountOutE8 = toE8(minAmountOut, DECIMALS[String(dest)] ?? 6);
  const costE8 = amountInE8 > minAmountOutE8 ? amountInE8 - minAmountOutE8 : 0n;
  const allowed = allowedCostE8(amountInE8, ctx.maxCostBps, ctx.maxCostFlatE6);
  if (costE8 > allowed) throw fields(`the transfer may cost ${e8Text(costE8)} USDC (amountIn − minAmountOut), over the policy's ${e8Text(allowed)}`);
  if (method !== 'fund_venue' && ctx.remainingCapE8 !== null && amountInE8 > ctx.remainingCapE8) {
    throw new QuoteRefusal('E_RESCUE_CAP', `amountIn ${e8Text(amountInE8)} USDC is over what is left of the hourly rescue cap, ${e8Text(ctx.remainingCapE8)} USD`);
  }
  const te = response.quote.timeEstimate;
  return {
    method, quote, signature: response.signature, depositAddress: f.depositAddress, amountIn, amountInE8, amountOut, minAmountOut, minAmountOutE8,
    destinationAsset: String(dest), recipient: String(to), costE8, signedAtMs, timeEstimateS: typeof te === 'number' ? te : null,
  };
}

/** The most one transfer may cost under the policy, USD × 1e8: max(amountIn × bps, flat). */
export function allowedCostE8(amountInE8: bigint, maxBps: number, maxFlatE6: number): bigint {
  const share = (amountInE8 * BigInt(maxBps)) / 10_000n;
  const flat = BigInt(maxFlatE6) * 100n;
  return share > flat ? share : flat;
}

/** USDC in an asset's base units from USD (rounded down to the base unit). */
export function unitsOf(usd: number, asset: string): bigint {
  const decimals = DECIMALS[asset] ?? 6;
  return BigInt(Math.floor(usd * 10 ** decimals + 1e-6));
}

/** The 1Click status body's delivery transactions (swapDetails.destinationChainTxHashes). */
export function deliveryHashes(body: Record<string, unknown> | null): string[] {
  const list = (body?.swapDetails as { destinationChainTxHashes?: unknown } | undefined)?.destinationChainTxHashes;
  return Array.isArray(list) ? list.map((h) => (typeof h === 'string' ? h : (h as { hash?: unknown })?.hash)).filter((h): h is string => typeof h === 'string' && h !== '') : [];
}

// ---- the live API ----

export interface HttpOneClickOptions {
  fetch?: typeof fetch;
  apiKey?: string | null;
  apiUrl?: string;
  timeoutMs?: number;
}

export class HttpOneClick implements OneClickApi {
  readonly source = 'live';
  readonly #fetch: typeof fetch;
  readonly #apiKey: string | null;
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(options: HttpOneClickOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#apiKey = options.apiKey ?? null;
    this.#url = (options.apiUrl ?? ONECLICK_API).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  #headers(): Record<string, string> {
    return { 'content-type': 'application/json', accept: 'application/json', ...(this.#apiKey === null ? {} : { authorization: `Bearer ${this.#apiKey}` }) };
  }

  async quote(body: QuoteRequest): Promise<QuoteAnswer> {
    const res = await this.#fetch(`${this.#url}/quote`, { method: 'POST', headers: this.#headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(this.#timeoutMs) });
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (res.ok && json !== null && typeof json.quote === 'object' && json.quote !== null) return { ok: true, response: json as unknown as QuoteResponse };
    return { ok: false, status: res.status, message: typeof json?.message === 'string' ? json.message : `HTTP ${res.status}` };
  }

  async submitDeposit(txHash: string, depositAddress: string): Promise<{ status: number }> {
    const res = await this.#fetch(`${this.#url}/deposit/submit`, {
      method: 'POST', headers: this.#headers(), body: JSON.stringify({ txHash, depositAddress }), signal: AbortSignal.timeout(this.#timeoutMs),
    });
    await res.text().catch(() => '');
    return { status: res.status };
  }

  async status(depositAddress: string): Promise<StatusAnswer> {
    const res = await this.#fetch(`${this.#url}/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: this.#headers(), signal: AbortSignal.timeout(this.#timeoutMs) });
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    return { status: typeof body?.status === 'string' ? body.status : `HTTP ${res.status}`, body };
  }
}
