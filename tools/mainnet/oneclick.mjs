// NEAR Intents 1Click for the money scripts: quote requests, the canonical JSON the contract hashes, the signature
// check and the contract's field rules (contract/core/src/oneclick.rs), ported so a quote is refused here, before
// anything is signed, for the same reasons the contract would refuse it. The engine has no 1Click client of its
// own yet; tests run this port against contract/core/tests/vectors/oneclick-live.json and oneclick.json, the
// vectors the contract's own tests use.
//
// No keys: quotes are public; ONECLICK_API_KEY (from .env, never printed) only lowers 1Click's fee.

import { createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto';
import { b58decode, b58encode } from '../testnet/near.mjs';

export const ONECLICK_API = 'https://1click.chaindefuser.com/v0';
/** 1Click's quote signing key (CLAUDE.md), base58. */
export const ONECLICK_PUBLIC_KEY = 'reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

/** 1Click asset ids (contract/core/src/oneclick.rs). */
export const ASSETS = {
  hypercoreUsdc: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054',
  solanaUsdc: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  arbitrumUsdc: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  nearUsdc: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
};
export const DECIMALS = {
  [ASSETS.hypercoreUsdc]: 8, [ASSETS.solanaUsdc]: 6, [ASSETS.arbitrumUsdc]: 6, [ASSETS.nearUsdc]: 6,
};

/** The least minAmountOut into the Orderly receiver, USDC x 1e6 (Orderly loses a deposit under 5). */
export const ORDERLY_MIN_OUT_E6 = 6_000_000n;
/** The least room a fund_venue quote leaves between amountOut and minAmountOut, bps of amountOut. */
export const FUND_VENUE_MIN_ROOM_BPS = 50n;
export const QUOTE_MAX_AGE_MS = 3_600_000;
export const QUOTE_MAX_AHEAD_MS = 300_000;

export const METHODS = {
  sol_sign_rescue: { origin: ASSETS.solanaUsdc, rescue: true },
  hl_send_to_intents: { origin: ASSETS.hypercoreUsdc, rescue: true },
  evm_usdc_to_intents: { origin: ASSETS.arbitrumUsdc, rescue: true },
  fund_venue: { origin: ASSETS.nearUsdc, rescue: false },
};

/** The fields 1Click signs (oneclick-live.json signed_fields). */
export const SIGNED_FIELDS = {
  request: ['dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline'],
  requestIfTruthy: ['quoteWaitingTimeMs', 'referral', 'virtualChainRecipient', 'virtualChainRefundRecipient', 'customRecipientMsg'],
  quote: ['amountIn', 'amountInFormatted', 'amountInUsd', 'minAmountIn', 'amountOut', 'amountOutFormatted', 'amountOutUsd', 'minAmountOut'],
  quoteIfTruthy: ['depositAddress', 'depositMemo', 'deadline', 'timeWhenInactive', 'timeEstimate', 'refundFee', 'withdrawFee'],
};

/** A refusal with the contract's code: `E_QUOTE_FIELDS: ...`. */
export class QuoteRefusal extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
const fields = (msg) => new QuoteRefusal('E_QUOTE_FIELDS', msg);

/** json-stable-stringify: sorted keys, no spaces, undefined members dropped (null in arrays). */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * The exact string the contract takes as `quote`: the signed request fields (from 1Click's echoed quoteRequest),
 * the signed quote fields (a live quote's own deadline replaces the requested one) and the timestamp.
 */
export function canonicalQuote(response) {
  const req = response?.quoteRequest;
  const q = response?.quote;
  if (req === null || typeof req !== 'object' || q === null || typeof q !== 'object' || typeof response.timestamp !== 'string') {
    throw new Error('1Click answer: no quote, quoteRequest or timestamp');
  }
  const out = {};
  for (const k of SIGNED_FIELDS.request) out[k] = req[k];
  for (const k of SIGNED_FIELDS.requestIfTruthy) if (req[k]) out[k] = req[k];
  for (const k of SIGNED_FIELDS.quote) out[k] = q[k];
  // A dry quote's message has none of the live fields, even those it echoes (timeEstimate, the fees).
  if (req.dry !== true) for (const k of SIGNED_FIELDS.quoteIfTruthy) if (q[k]) out[k] = q[k];
  out.timestamp = response.timestamp;
  return stableStringify(out);
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const sha256 = (b) => createHash('sha256').update(b).digest();

/** `E_QUOTE_SIGNATURE` unless `signature` is 1Click's over the UTF-8 of base58(sha256(quote)). */
export function checkQuoteSignature(quote, signature) {
  const bad = (msg) => new QuoteRefusal('E_QUOTE_SIGNATURE', msg);
  if (typeof signature !== 'string' || !signature.startsWith('ed25519:')) throw bad('quote_signature is not ed25519:<base58>');
  const encoded = signature.slice('ed25519:'.length);
  let raw;
  try {
    raw = encoded.length > 88 ? null : b58decode(encoded);
  } catch {
    raw = null;
  }
  if (raw === null || raw.length !== 64) throw bad('quote_signature is not 64 bytes of base58');
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, b58decode(ONECLICK_PUBLIC_KEY)]), format: 'der', type: 'spki' });
  const message = Buffer.from(b58encode(sha256(Buffer.from(quote, 'utf8'))), 'utf8');
  if (!ed25519Verify(null, message, key, raw)) throw bad('quote_signature is not 1Click\'s signature of this quote (it covers the exact string)');
}

const REQUIRED = ['dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient',
  'recipientType', 'deadline', 'amountIn', 'amountInFormatted', 'amountInUsd', 'minAmountIn', 'amountOut', 'amountOutFormatted', 'amountOutUsd', 'minAmountOut', 'timestamp'];
const OPTIONAL = ['quoteWaitingTimeMs', 'referral', 'virtualChainRecipient', 'virtualChainRefundRecipient', 'customRecipientMsg', 'depositAddress', 'depositMemo',
  'timeWhenInactive', 'timeEstimate', 'refundFee', 'withdrawFee'];
const STRINGS = ['swapType', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline',
  'amountIn', 'amountOut', 'minAmountOut', 'timestamp'];

function parseFields(quote) {
  let f;
  try {
    f = JSON.parse(quote);
  } catch (e) {
    throw fields(`the quote is not a 1Click quote: ${e.message}`);
  }
  if (f === null || typeof f !== 'object' || Array.isArray(f)) throw fields('the quote is not a 1Click quote: not an object');
  for (const k of Object.keys(f)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) throw fields(`the quote is not a 1Click quote: unknown field \`${k}\``);
  for (const k of REQUIRED) if (!(k in f)) throw fields(`the quote is not a 1Click quote: missing field \`${k}\``);
  if (typeof f.dry !== 'boolean') throw fields('the quote is not a 1Click quote: dry is not a boolean');
  for (const k of STRINGS) if (typeof f[k] !== 'string') throw fields(`the quote is not a 1Click quote: ${k} is not a string`);
  for (const k of ['customRecipientMsg', 'depositAddress']) {
    if (f[k] === null) delete f[k];
    else if (f[k] !== undefined && typeof f[k] !== 'string') throw fields(`the quote is not a 1Click quote: ${k} is not a string`);
  }
  return f;
}

const sameEvm = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** A base-unit amount: decimal digits, no leading zeros. */
function integer(field, s) {
  if (typeof s !== 'string' || !/^(0|[1-9]\d*)$/.test(s) || BigInt(s) >= 2n ** 128n) throw fields(`${field} ${JSON.stringify(s)} is not an amount`);
  return BigInt(s);
}

/** An amount in an asset of `decimals` (at most 8) as USDC x 1e8. */
export const toE8 = (amount, decimals) => BigInt(amount) * 10n ** BigInt(Math.max(0, 8 - decimals));

/** `YYYY-MM-DDTHH:MM:SS[.f{1,3}]Z` as ms, years 1970 to 9999; null otherwise (oneclick.rs parse_time_ms). */
export function parseTimeMs(s) {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(s) : null;
  if (m === null) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] || h > 23 || mi > 59 || se > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi, se, ms);
}

/** E_QUOTE_FIELDS unless signed at most 1 h before `nowMs` and at most 5 min after it. */
export function checkQuoteAge(signedAtMs, nowMs) {
  if (nowMs - signedAtMs > QUOTE_MAX_AGE_MS) {
    throw fields(`the quote was signed at ${signedAtMs} ms, more than 1 h before the block time ${nowMs} ms: a quote is paid within the hour after 1Click signed it`);
  }
  if (signedAtMs - nowMs > QUOTE_MAX_AHEAD_MS) throw fields(`the quote was signed at ${signedAtMs} ms, more than 5 min after the block time ${nowMs} ms`);
}

export const usdE8Text = (e8) => {
  const v = BigInt(e8);
  const frac = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${v / 100_000_000n}${frac === '' ? '' : `.${frac}`}`;
};

function checkRecipient(f, minAmountOut, ctx) {
  const to = f.recipient;
  const dest = f.destinationAsset;
  if (to === ctx.contract && dest === ASSETS.nearUsdc) {
    const want = `{"desk_id":"${ctx.desk.desk_id}"}`;
    if (f.customRecipientMsg !== want) throw fields(`customRecipientMsg must name this desk exactly, ${want}`);
    return;
  }
  if (f.customRecipientMsg !== undefined) throw fields('customRecipientMsg goes only with the contract as recipient');
  if (ctx.desk.orderly_receiver && sameEvm(to, ctx.desk.orderly_receiver) && dest === ASSETS.arbitrumUsdc) {
    if (minAmountOut < ORDERLY_MIN_OUT_E6) {
      throw fields(`minAmountOut ${usdE8Text(minAmountOut * 100n)} is below 6 USDC for the Orderly receiver (Orderly loses a deposit under 5)`);
    }
    return;
  }
  if ((sameEvm(to, ctx.desk.evm) && dest === ASSETS.hypercoreUsdc) || (to === ctx.desk.sol && dest === ASSETS.solanaUsdc)) return;
  throw fields(`recipient ${JSON.stringify(to)} with destinationAsset ${JSON.stringify(dest)} is not a desk address (desk EVM on HyperCore, desk Solana `
    + 'authority, the pinned Orderly receiver on Arbitrum, the contract on NEAR)');
}

/** fund_venue's room rule: amountOut - minAmountOut >= amountOut x 0.5 %. */
export function checkRoom(amountOut, minAmountOut) {
  const room = amountOut > minAmountOut ? amountOut - minAmountOut : 0n;
  if (room * 10_000n < amountOut * FUND_VENUE_MIN_ROOM_BPS) {
    throw fields(`minAmountOut ${minAmountOut} leaves less than 0.5% below amountOut ${amountOut}: a swap held that tight is likely to fail, and fund_venue's refund goes to the owner`);
  }
}

/**
 * verify_quote of contract/core/src/oneclick.rs: the signature, then the field rules in the contract's order.
 * ctx: { desk: { desk_id, evm, sol, orderly_receiver, owner }, contract, now_ms, remaining_cap_e8 (bigint), dry_ok }.
 * Returns the verified quote (amounts as bigint) or throws a QuoteRefusal.
 */
export function verifyQuote(quote, signature, method, ctx) {
  const m = METHODS[method];
  if (m === undefined) throw new Error(`unknown quoted method ${method}`);
  checkQuoteSignature(quote, signature);
  const f = parseFields(quote);
  let depositAddress;
  if (f.depositAddress !== undefined && f.dry === false) depositAddress = f.depositAddress;
  else if (f.depositAddress === undefined && f.dry === true && ctx.dry_ok) depositAddress = null;
  else throw fields('not a live quote with a deposit address (a dry quote cannot be paid)');

  if (f.originAsset !== m.origin) throw fields(`originAsset ${JSON.stringify(f.originAsset)} is not what ${method} sends (${m.origin})`);
  if (f.destinationAsset === f.originAsset) throw fields(`destinationAsset is the originAsset ${m.origin}: a transfer into the same asset only pays fees`);
  const refundOk = method === 'sol_sign_rescue' ? f.refundTo === ctx.desk.sol
    : method === 'fund_venue' ? f.refundTo === ctx.desk.owner
      : sameEvm(f.refundTo, ctx.desk.evm);
  if (!refundOk) throw fields(`refundTo ${JSON.stringify(f.refundTo)} is not where ${method} takes money from`);
  if (f.recipientType !== 'DESTINATION_CHAIN') throw fields(`recipientType ${JSON.stringify(f.recipientType)} is not DESTINATION_CHAIN`);
  const minAmountOut = integer('minAmountOut', f.minAmountOut);
  checkRecipient(f, minAmountOut, ctx);
  // Only fund_venue reads amountOut (its room rule), as in the contract.
  let amountOut = /^(0|[1-9]\d*)$/.test(f.amountOut) ? BigInt(f.amountOut) : null;
  if (method === 'fund_venue') {
    amountOut = integer('amountOut', f.amountOut);
    checkRoom(amountOut, minAmountOut);
  }
  if (f.swapType !== 'EXACT_INPUT') throw fields(`swapType ${JSON.stringify(f.swapType)} is not EXACT_INPUT`);
  if (f.depositType !== 'ORIGIN_CHAIN' || f.refundType !== 'ORIGIN_CHAIN') throw fields('depositType and refundType must be ORIGIN_CHAIN');
  if (f.depositMemo !== undefined) throw fields('a deposit memo cannot be paid');
  if (f.virtualChainRecipient !== undefined || f.virtualChainRefundRecipient !== undefined) throw fields('virtual chain recipients are not desk addresses');
  const amountIn = integer('amountIn', f.amountIn);
  if (f.amount !== f.amountIn || amountIn === 0n) throw fields(`amountIn ${JSON.stringify(f.amountIn)} must equal the requested amount ${JSON.stringify(f.amount)} and not be zero`);
  if (depositAddress !== null && method !== 'sol_sign_rescue' && method !== 'fund_venue') {
    depositAddress = depositAddress.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(depositAddress)) throw fields(`depositAddress ${JSON.stringify(f.depositAddress)} is not an EVM address`);
  } else if (depositAddress !== null && method === 'sol_sign_rescue') {
    let ok = false;
    try {
      ok = b58decode(depositAddress).length === 32;
    } catch {
      ok = false;
    }
    if (!ok) throw fields(`depositAddress ${JSON.stringify(depositAddress)} is not a Solana address`);
  }
  const deadlineMs = parseTimeMs(f.deadline);
  if (deadlineMs === null) throw fields(`deadline ${JSON.stringify(f.deadline)} is not a UTC time`);
  if (ctx.now_ms >= deadlineMs) throw fields(`deadline ${f.deadline} passed (now ${ctx.now_ms} ms)`);
  const signedAtMs = parseTimeMs(f.timestamp);
  if (signedAtMs === null) throw fields(`timestamp ${JSON.stringify(f.timestamp)} is not a UTC time`);
  checkQuoteAge(signedAtMs, ctx.now_ms);
  const amountInE8 = toE8(amountIn, DECIMALS[m.origin] ?? 6);
  if (m.rescue && amountInE8 > BigInt(ctx.remaining_cap_e8)) {
    throw new QuoteRefusal('E_RESCUE_CAP', `amountIn ${usdE8Text(amountInE8)} USDC is over what is left of the hourly rescue cap, ${usdE8Text(ctx.remaining_cap_e8)} USD`);
  }
  return {
    method,
    depositAddress,
    amountIn,
    amountInE8,
    amountOut,
    minAmountOut,
    minAmountOutE8: toE8(minAmountOut, DECIMALS[f.destinationAsset] ?? 6),
    destinationAsset: f.destinationAsset,
    recipient: f.recipient,
    refundTo: f.refundTo,
    deadlineMs,
    signedAtMs,
  };
}

/** What a verified transfer may cost, USD x 1e8: amountIn - minAmountOut (0 when it pays out more). */
export const transferCostE8 = (q) => (q.amountInE8 > q.minAmountOutE8 ? q.amountInE8 - q.minAmountOutE8 : 0n);

/** The most one transfer may cost under the policy, USD x 1e8: max(amountIn x bps, flat). */
export const allowedCostE8 = (amountInE8, maxBps, maxFlatE6) => {
  const share = (BigInt(amountInE8) * BigInt(maxBps)) / 10_000n;
  const flat = BigInt(maxFlatE6) * 100n;
  return share > flat ? share : flat;
};

/** check_cost: E_QUOTE_FIELDS when the quote may cost more than the policy allows. */
export function checkCost(q, maxBps, maxFlatE6) {
  const allowed = allowedCostE8(q.amountInE8, maxBps, maxFlatE6);
  const cost = transferCostE8(q);
  if (cost > allowed) {
    throw fields(`the transfer may cost ${usdE8Text(cost)} USDC (amountIn − minAmountOut), over the policy's ${usdE8Text(allowed)} USDC`);
  }
}

/** fund_cost_budget_e8: four transfers at the per-transfer bound for the per-leg cap, USD x 1e8 an hour. */
export function fundCostBudgetE8(maxNotionalUsd, maxBps, maxFlatE6) {
  const share = (BigInt(maxNotionalUsd) * 100_000_000n * BigInt(maxBps)) / 10_000n;
  const flat = BigInt(maxFlatE6) * 100n;
  return 4n * (share > flat ? share : flat);
}

/** rescue_cost_budget_e8: max(cap x bps, 2 x flat), USD x 1e8 an hour. */
export function rescueCostBudgetE8(capUsd, maxBps, maxFlatE6) {
  const share = (BigInt(capUsd) * 100_000_000n * BigInt(maxBps)) / 10_000n;
  const two = 2n * BigInt(maxFlatE6) * 100n;
  return share > two ? share : two;
}

// --- the API ---

const headers = (apiKey) => ({
  'content-type': 'application/json',
  accept: 'application/json',
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
});

/** POST /quote; { status, body } (body null when not JSON). The key goes in a header only, never printed. */
export async function requestQuote(fetchImpl, body, apiKey = null) {
  const res = await fetchImpl(`${ONECLICK_API}/quote`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** POST /deposit/submit {txHash, depositAddress}: tells 1Click the deposit went out (it would also find it alone). */
export async function submitDeposit(fetchImpl, txHash, depositAddress, apiKey = null) {
  const res = await fetchImpl(`${ONECLICK_API}/deposit/submit`, {
    method: 'POST', headers: headers(apiKey), body: JSON.stringify({ txHash, depositAddress }), signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** GET /status?depositAddress=. */
export async function quoteStatus(fetchImpl, depositAddress, apiKey = null) {
  const res = await fetchImpl(`${ONECLICK_API}/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: headers(apiKey), signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** 1Click statuses that end a transfer. */
export const FINAL_STATUSES = ['SUCCESS', 'REFUNDED', 'FAILED'];
