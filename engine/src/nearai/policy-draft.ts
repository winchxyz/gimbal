// "Rules in plain words" (NEAR AI feature 1): the owner's sentence -> a PolicyDraft the owner edits and confirms.
// The model never writes the policy. It answers a small, flat JSON object (SYSTEM_PROMPT); parseDraftAnswer checks
// every field's type, and buildPolicyDraft builds the ContractPolicy and the StrategyConfig from it:
// - symbols come only from the assets the contract prices (ORACLE_ASSETS); any other symbol goes to the notes, and
//   enters `policy.unpriced` only when the owner's own words ask for it without price protection;
// - venue indexes, orderbooks and lots come from the venues' market lists, never from the model;
// - every number is checked against the contract's bounds (contract/core/src/policy.rs) and the engine's
//   (STRATEGY_LIMITS): out of range is clamped or refused, and the notes say which;
// - fields the owner did not mention get the defaults below.
// The draft goes back to the owner only: the engine never sends it to the contract (docs/interfaces.md §2).

import type { ContractPolicy, PolicyDraft, StrategyConfig, VenueId } from '@gimbal/shared';
import { DEFAULT_STRATEGY, STRATEGY_LIMITS, parseContractPolicy, parseStrategyConfig } from '../scanner/config.ts';
import { orderlySymbol } from '../venues/orderly.ts';
import type { Market } from '../venues/venue.ts';
import type { ChatMessage } from './client.ts';
import { NearAiUnavailable } from './client.ts';

/** The assets the contract prices, by ticker: their OutLayer token ids. Nothing else is ever drafted as priced. */
export const ORACLE_ASSETS: Readonly<Record<string, string>> = {
  ETH: 'eth.bridge.near',
  BTC: 'nbtc.bridge.near',
  SOL: '22.contract.portalbridge.near',
  DOGE: 'doge.omft.near',
  LTC: 'ltc.omft.near',
};
const PRICED = Object.keys(ORACLE_ASSETS);

/** The contract's own bounds on a Policy (contract/core/src/policy.rs, `Policy::validate`). */
export const POLICY_LIMITS = {
  /** Every u64 in a policy: 2^53 − 1, the largest integer JavaScript reads exactly. */
  maxSafeInteger: Number.MAX_SAFE_INTEGER,
  maxListLen: 32,
  maxSymbolLen: 32,
  hlMaxSzDecimals: 6,
  maxPriceBandBps: 10_000,
  maxOracleAgeS: 3_600,
  maxTransferCostBps: 10_000,
} as const;

/** The policy fields a new draft gets when the owner's words do not set them. */
export const DRAFT_DEFAULTS = {
  /** An order may sit 1 % from the oracle price: room for an IOC through the book on the majors. */
  priceBandBps: 100,
  /** Two minutes: the engine refreshes prices on demand before it orders. */
  oracleMaxAgeS: 120,
  /** docs/interfaces.md §1.2 defaults: 1 % or 0.5 USDC per transfer (1Click measured 0.21–0.32 on 4–7 USDC). */
  maxTransferCostBps: 100,
  maxTransferCostFlatE6: 500_000,
  /** docs/interfaces.md §1.2 default cap per leg for symbols without an oracle price. */
  unpricedMaxNotionalUsd: 100,
} as const;

/** The desk venues, in policy order, with the names the notes use. */
const VENUES: readonly { id: VenueId; name: string }[] = [
  { id: 'hyperliquid', name: 'Hyperliquid' },
  { id: 'phoenix', name: 'Phoenix' },
  { id: 'orderly', name: 'Orderly' },
];

/** Most notes taken from the model's `unmapped` list, and the longest. */
const MAX_UNMAPPED = 10;
const MAX_NOTE_TEXT = 200;

export const SYSTEM_PROMPT = `You turn the owner's words about their trading desk into a JSON draft of its rules. You never trade: the owner reviews and edits every field before anything takes effect.

The desk is delta-neutral: it holds one long and one short perpetual leg of the same asset on two venues (hyperliquid, phoenix, orderly) and earns the funding-rate difference.

Answer with one JSON object and nothing else, with these keys. Use null for anything the owner did not say. Never guess a number they did not give. Percentages are plain numbers without the % sign.

- "symbols": the assets the owner wants to trade, as upper-case tickers ("ETH", "BTC"). Write only assets they name. Only ETH, BTC, SOL, DOGE and LTC have an oracle price.
- "venues": the venues the owner limits trading to, from "hyperliquid", "phoenix", "orderly"; null when they do not limit them.
- "max_notional_usd": the most USD per leg.
- "leg_usd": the USD size of each leg to open. When the owner gives one amount per leg ("at most $500 per leg", "$500 legs"), put it in both max_notional_usd and leg_usd.
- "max_leverage": leverage per leg ("3x" is 3).
- "stop_drawdown_pct": the loss of the desk, in percent, at which to close both legs ("stop if I lose 10%" is 10); the string "none" when the owner says never to stop.
- "min_net_apr_pct": the lowest net APR, in percent, at which to enter ("only above 15% net APR" is 15).
- "auto": true when the owner wants the desk to enter, exit and rotate by itself; false when they want to act by hand.
- "rotate_min_gain_pts": rotate into a better window only when it beats the held one by this many points of net APR.
- "rotate_for_hours": and only after it has done so for this many hours in a row.
- "watch_distance_pct": a leg this close to liquidation, in percent, is watched.
- "rescue_distance_pct": a leg this close to liquidation, in percent, is rescued with more margin.
- "price_band_pct": how far an order price may be from the oracle price, in percent.
- "oracle_max_age_s": the oldest oracle price, in seconds, an order may be checked against.
- "rescue_cap_usd_per_hour": the most USD the desk may move per hour to rescue a leg.
- "max_transfer_cost_pct": the most a transfer between venues may cost, in percent of it.
- "max_transfer_cost_flat_usd": the most a transfer between venues may cost, in USD.
- "unpriced": assets without an oracle price that the owner explicitly asks to trade without price protection, each as {"symbol": "HYPE", "max_usd": 50} with the USD cap per order they gave (null if they gave none). An empty list unless the owner asks for it in so many words.
- "unpriced_max_notional_usd": the most USD per leg for those unpriced assets.
- "unmapped": short phrases, in the owner's words, for every request that fits none of the keys above.`;

/** The messages that ask for a draft of `text`. */
export function draftMessages(text: string): ChatMessage[] {
  return [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: text }];
}

/** The number fields of the model's answer, in the units the prompt asks for. */
const NUMBER_KEYS = [
  'max_notional_usd', 'leg_usd', 'max_leverage', 'min_net_apr_pct', 'rotate_min_gain_pts', 'rotate_for_hours',
  'watch_distance_pct', 'rescue_distance_pct', 'price_band_pct', 'oracle_max_age_s', 'rescue_cap_usd_per_hour',
  'max_transfer_cost_pct', 'max_transfer_cost_flat_usd', 'unpriced_max_notional_usd',
] as const;
type NumberKey = (typeof NUMBER_KEYS)[number];
const OTHER_KEYS = ['symbols', 'venues', 'unpriced', 'stop_drawdown_pct', 'auto', 'unmapped'] as const;
const ANSWER_KEYS: readonly string[] = [...NUMBER_KEYS, ...OTHER_KEYS];

/** The model's answer after the type checks: every field is either what the prompt asked for, or absent. */
export interface DraftAnswer {
  symbols: string[];
  /** null = not limited. */
  venues: string[] | null;
  unpriced: { symbol: string; maxUsd: number | null }[];
  /** Only the fields given as finite numbers. */
  numbers: Partial<Record<NumberKey, number>>;
  /** 'none' = the owner said never to stop; null = not said. */
  stopDrawdown: number | 'none' | null;
  auto: boolean | null;
  unmapped: string[];
}

/** What a model value looks like in a note: short, one line, never the whole thing. */
function shown(v: unknown): string {
  let text: string;
  try {
    text = String(JSON.stringify(v));
  } catch {
    text = typeof v;
  }
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One line of the model's own text, safe to show: control characters out, trimmed, capped. */
function noteText(s: string): string {
  const line = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > MAX_NOTE_TEXT ? `${line.slice(0, MAX_NOTE_TEXT)}…` : line;
}

/**
 * The model's JSON object, type-checked field by field. A field of the wrong type is dropped with a note, and so
 * is a field the draft has no place for; an object with none of the draft's fields is not a draft at all
 * (NearAiUnavailable, so the HTTP side answers 503).
 */
export function parseDraftAnswer(value: Record<string, unknown>): { answer: DraftAnswer; notes: string[] } {
  const notes: string[] = [];
  const keys = Object.keys(value);
  if (!keys.some((k) => ANSWER_KEYS.includes(k))) {
    throw new NearAiUnavailable('the model\'s reply is not a draft: it has none of the draft\'s fields');
  }
  const extra = keys.filter((k) => !ANSWER_KEYS.includes(k));
  if (extra.length > 0) {
    const names = extra.slice(0, 5).map((k) => (/^[A-Za-z0-9_]{1,40}$/.test(k) ? k : shown(k)));
    notes.push(`The model returned fields a draft has no place for (${names.join(', ')}${extra.length > 5 ? ', …' : ''}): ignored.`);
  }
  const wrong = (key: string, v: unknown, want: string) => notes.push(`The model's ${key} was ${shown(v)}, not ${want}: ignored.`);

  const strings = (key: string): string[] | null => {
    const v = value[key];
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v)) {
      wrong(key, v, 'a list');
      return null;
    }
    const out = v.filter((x): x is string => typeof x === 'string');
    if (out.length < v.length) notes.push(`The model's ${key} held entries that are not text: ignored.`);
    return out;
  };

  const numbers: Partial<Record<NumberKey, number>> = {};
  for (const key of NUMBER_KEYS) {
    const v = value[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) wrong(key, v, 'a number');
    else numbers[key] = v;
  }

  let stopDrawdown: DraftAnswer['stopDrawdown'] = null;
  const stop = value.stop_drawdown_pct;
  if (typeof stop === 'number' && Number.isFinite(stop)) stopDrawdown = stop;
  else if (typeof stop === 'string' && stop.trim().toLowerCase() === 'none') stopDrawdown = 'none';
  else if (stop !== undefined && stop !== null) wrong('stop_drawdown_pct', stop, 'a number or "none"');

  let auto: boolean | null = null;
  if (typeof value.auto === 'boolean') auto = value.auto;
  else if (value.auto !== undefined && value.auto !== null) wrong('auto', value.auto, 'true or false');

  const unpriced: DraftAnswer['unpriced'] = [];
  const rawUnpriced = value.unpriced;
  if (Array.isArray(rawUnpriced)) {
    for (const u of rawUnpriced) {
      const maxUsd = isObject(u) ? u.max_usd : undefined;
      if (!isObject(u) || typeof u.symbol !== 'string' || (maxUsd !== null && maxUsd !== undefined && (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd)))) {
        wrong('unpriced entry', u, '{ symbol, max_usd }');
        continue;
      }
      unpriced.push({ symbol: u.symbol, maxUsd: typeof maxUsd === 'number' ? maxUsd : null });
    }
  } else if (rawUnpriced !== undefined && rawUnpriced !== null) {
    wrong('unpriced', rawUnpriced, 'a list');
  }

  return {
    answer: {
      symbols: strings('symbols') ?? [],
      venues: strings('venues'),
      unpriced,
      numbers,
      stopDrawdown,
      auto,
      unmapped: (strings('unmapped') ?? []).map(noteText).filter((s) => s !== ''),
    },
    notes,
  };
}

/** The desk venues' market lists: a venue whose list could not be read is in `failed` with the reason. */
export interface DeskMarkets {
  markets: Partial<Record<VenueId, readonly Market[]>>;
  failed: Partial<Record<VenueId, string>>;
}

export interface BuildContext {
  /** The owner's own words: an unpriced symbol must be asked for in them, not only in the model's answer. */
  ownerText: string;
  markets: DeskMarkets;
  model: string;
}

const ALIASES: Readonly<Record<string, string>> = {
  BITCOIN: 'BTC', XBT: 'BTC', ETHER: 'ETH', ETHEREUM: 'ETH', SOLANA: 'SOL', DOGECOIN: 'DOGE', LITECOIN: 'LTC',
};

/** A ticker from the model: "$eth", "ETH-PERP", "PERP_ETH_USDC" and "Ethereum" are all ETH; null if it is no ticker. */
export function normalizeSymbol(raw: string): string | null {
  let s = raw.trim().toUpperCase().replace(/^\$/, '');
  s = s.replace(/^PERP_(.+)_USDC$/, '$1').replace(/-(PERP|USD|USDC)$/, '');
  s = ALIASES[s] ?? s;
  return /^[A-Z0-9]{1,20}$/.test(s) ? s : null;
}

/** Words that ask, in so many words, to trade a symbol without the oracle's price protection. */
const UNPRICED_INTENT = /\bunpriced\b|without (?:any |a |an |the )?(?:oracle|price)|\bno (?:oracle|price)|price protection|price feed/i;

/** Whether the owner's own words name `symbol` and ask for trading without price protection. */
export function asksUnpriced(ownerText: string, symbol: string): boolean {
  // `symbol` is [A-Z0-9]+ (normalizeSymbol), so it needs no escaping.
  return new RegExp(`(^|[^A-Za-z0-9])${symbol}($|[^A-Za-z0-9])`, 'i').test(ownerText) && UNPRICED_INTENT.test(ownerText);
}

const fmt = (x: number): string => (Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(6))));
const MAX_SAFE_TEXT = '2^53 − 1, the largest number the contract takes';

/** Records a value kept inside [lo, hi] (and says so when it was outside). */
function clamp(label: string, v: number, lo: number, hi: number, notes: string[]): number {
  if (v < lo) {
    notes.push(`${label}: ${fmt(v)} is under ${fmt(lo)}, the least allowed; raised to ${fmt(lo)}.`);
    return lo;
  }
  if (v > hi) {
    notes.push(`${label}: ${fmt(v)} is over ${fmt(hi)}, the most allowed; lowered to ${fmt(hi)}.`);
    return hi;
  }
  return v;
}

function refuse(label: string, v: number, why: string, fallback: number | null, notes: string[]): typeof fallback {
  notes.push(`${label}: ${fmt(v)} ${why}; kept the default${fallback === null ? ' (no stop)' : ` ${fmt(fallback)}`}.`);
  return fallback;
}

/** A u64 of the contract: whole, ≥ 0, ≤ 2^53 − 1. A negative or huge value is refused, a fraction rounded down. */
function u64(label: string, v: number | undefined, fallback: number, notes: string[]): number {
  if (v === undefined) return fallback;
  if (v < 0) return refuse(label, v, 'is negative', fallback, notes)!;
  if (v > POLICY_LIMITS.maxSafeInteger) return refuse(label, v, `is over ${MAX_SAFE_TEXT}`, fallback, notes)!;
  if (!Number.isInteger(v)) {
    const whole = Math.floor(v);
    notes.push(`${label}: ${fmt(v)} is not a whole number; rounded down to ${whole}.`);
    return whole;
  }
  return v;
}

/**
 * A percentage the contract takes in basis points (both bps fields allow at most 10 000): a negative one is refused,
 * and so is 0 when the least allowed is above 0; anything else is clamped to [lo, 10 000].
 */
function bps(label: string, pct: number | undefined, fallback: number, lo: number, notes: string[]): number {
  if (pct === undefined) return fallback;
  if (pct < 0 || (lo > 0 && pct === 0)) {
    notes.push(`${label}: ${fmt(pct)} % is ${lo > 0 ? 'not above 0' : 'negative'}; kept the default ${fallback} bps.`);
    return fallback;
  }
  const hi = POLICY_LIMITS.maxPriceBandBps;
  const v = Math.round(pct * 100);
  if (v < lo) {
    notes.push(`${label}: ${fmt(pct)} % is under ${lo} bps, the least allowed; raised to ${lo} bps.`);
    return lo;
  }
  if (v > hi) {
    notes.push(`${label}: ${fmt(pct)} % is over 100 %, the most allowed; lowered to ${hi} bps.`);
    return hi;
  }
  return v;
}

/**
 * The PolicyDraft for a checked answer: the contract part built from the oracle list, the market lists and the
 * owner's numbers within the contract's bounds; the engine part within STRATEGY_LIMITS and the policy's cap.
 */
export function buildPolicyDraft(parsed: { answer: DraftAnswer; notes: string[] }, ctx: BuildContext): PolicyDraft {
  const { answer } = parsed;
  const notes = [...parsed.notes];
  const n = answer.numbers;
  const L = STRATEGY_LIMITS;

  // Venues: all three unless the owner limited them.
  let venues = VENUES;
  if (answer.venues !== null && answer.venues.length > 0) {
    const named = answer.venues.map((v) => v.trim().toLowerCase());
    const unknown = named.filter((v) => !VENUES.some((x) => x.id === v));
    if (unknown.length > 0) notes.push(`Not a desk venue: ${unknown.map(shown).join(', ')}. The desk trades on Hyperliquid, Phoenix and Orderly only.`);
    const kept = VENUES.filter((x) => named.includes(x.id));
    if (kept.length > 0) venues = kept;
  }
  if (venues.length < 2) notes.push(`Only ${venues[0]!.name} is allowed: a window needs a long and a short on two venues, so the desk can open nothing.`);

  // Symbols: priced ones from the oracle list only; any other is a note unless the owner asked for it unpriced.
  const priced: string[] = [];
  const others: string[] = [];
  for (const raw of answer.symbols) {
    const s = normalizeSymbol(raw);
    if (s === null) notes.push(`The model listed ${shown(raw)}, which is not a ticker: left out.`);
    else if (PRICED.includes(s)) {
      if (!priced.includes(s)) priced.push(s);
    } else if (!others.includes(s)) others.push(s);
  }

  // Caps, in the order they depend on each other: the per-leg cap bounds the leg size and the unpriced caps.
  let maxNotional: number;
  const givenLeg = n.leg_usd !== undefined && n.leg_usd >= L.minLegUsd && n.leg_usd <= L.maxLegUsd ? n.leg_usd : null;
  const notionalDefault = givenLeg !== null ? Math.ceil(givenLeg) : DEFAULT_STRATEGY.legUsd;
  maxNotional = u64('policy.max_notional_usd', n.max_notional_usd, notionalDefault, notes);
  if (maxNotional < L.minLegUsd) {
    notes.push(`policy.max_notional_usd: ${maxNotional} is under $${L.minLegUsd}, the smallest order Hyperliquid and Orderly take; raised to ${L.minLegUsd}.`);
    maxNotional = L.minLegUsd;
  }
  const unpricedMax = u64('policy.unpriced_max_notional_usd', n.unpriced_max_notional_usd, DRAFT_DEFAULTS.unpricedMaxNotionalUsd, notes);
  const rescueCap = u64('policy.rescue_cap_usd_per_hour', n.rescue_cap_usd_per_hour, maxNotional, notes);
  let flatE6: number = DRAFT_DEFAULTS.maxTransferCostFlatE6;
  if (n.max_transfer_cost_flat_usd !== undefined) {
    const usd = n.max_transfer_cost_flat_usd;
    if (usd < 0) refuse('policy.max_transfer_cost_flat_e6', usd, 'USD is negative', flatE6, notes);
    else if (Math.round(usd * 1e6) > POLICY_LIMITS.maxSafeInteger) refuse('policy.max_transfer_cost_flat_e6', usd, `USD is over ${MAX_SAFE_TEXT} in units of 1e-6`, flatE6, notes);
    else flatE6 = Math.round(usd * 1e6);
  }
  const transferBps = bps('policy.max_transfer_cost_bps', n.max_transfer_cost_pct, DRAFT_DEFAULTS.maxTransferCostBps, 0, notes);
  const bandBps = bps('policy.price_band_bps', n.price_band_pct, DRAFT_DEFAULTS.priceBandBps, 1, notes);
  let oracleAge: number = DRAFT_DEFAULTS.oracleMaxAgeS;
  if (n.oracle_max_age_s !== undefined) {
    if (n.oracle_max_age_s <= 0) refuse('policy.oracle_max_age_s', n.oracle_max_age_s, 'is not above 0 s', oracleAge, notes);
    else oracleAge = clamp('policy.oracle_max_age_s', Math.max(1, Math.round(n.oracle_max_age_s)), 1, POLICY_LIMITS.maxOracleAgeS, notes);
  }

  // Unpriced symbols: the owner's own words must ask for each one; the cap they gave goes to the notes, since the
  // form converts it to max_sz at the current mark. Until then max_sz is 0, which refuses every order.
  const unpricedCap = Math.min(maxNotional, unpricedMax);
  const unpriced: ContractPolicy['unpriced'] = [];
  const accepted = new Set<string>();
  for (const u of answer.unpriced) {
    const s = normalizeSymbol(u.symbol);
    if (s === null) {
      notes.push(`The model listed ${shown(u.symbol)} as unpriced, which is not a ticker: left out.`);
      continue;
    }
    if (PRICED.includes(s)) {
      if (!priced.includes(s)) priced.push(s);
      notes.push(`${s} has an oracle price: it stays price-protected, not unpriced.`);
      continue;
    }
    if (accepted.has(s)) continue;
    if (!asksUnpriced(ctx.ownerText, s)) {
      notes.push(`${s}: not added as unpriced, because your words do not ask for it without price protection.`);
      continue;
    }
    if (priced.length + unpriced.length >= POLICY_LIMITS.maxListLen) {
      notes.push(`${s}: not added, a policy lists at most ${POLICY_LIMITS.maxListLen} symbols per venue.`);
      continue;
    }
    let cap = u.maxUsd;
    if (cap === null || cap <= 0) {
      notes.push(`${s}: no USD cap given; the form starts from the unpriced cap of $${unpricedCap} per order.`);
      cap = unpricedCap;
    } else if (cap > unpricedCap) {
      notes.push(`${s}: the cap of $${fmt(cap)} is over the unpriced cap of $${unpricedCap} per leg; lowered to $${unpricedCap}.`);
      cap = unpricedCap;
    }
    accepted.add(s);
    unpriced.push({ symbol: s, max_sz: '0' });
    notes.push(`${s} has no oracle price: it is in policy.unpriced with no price protection, capped at $${fmt(cap)} per order. `
      + 'max_sz stays 0 (every order refused) until the form converts that cap at the current mark.');
  }
  for (const s of others) {
    if (accepted.has(s)) continue;
    notes.push(`${s} has no oracle price, so it is not in the policy: the contract prices only ${PRICED.join(', ')}. `
      + `To trade ${s} anyway, ask for it without price protection and give a cap in USD.`);
  }
  const symbols = [...priced, ...unpriced.map((u) => u.symbol)];
  if (symbols.length === 0) notes.push(`No asset to trade: name at least one of ${PRICED.join(', ')}.`);

  const filled = fillVenues(symbols, venues, ctx.markets, notes);
  const policy: ContractPolicy = {
    ...filled,
    max_notional_usd: maxNotional,
    price_band_bps: bandBps,
    oracle_max_age_s: oracleAge,
    rescue_cap_usd_per_hour: rescueCap,
    unpriced,
    unpriced_max_notional_usd: unpricedMax,
    max_transfer_cost_bps: transferBps,
    max_transfer_cost_flat_e6: flatE6,
  };

  const strategy = buildStrategy(answer, maxNotional, notes);
  for (const line of answer.unmapped.slice(0, MAX_UNMAPPED)) notes.push(`Not mapped: ${line}`);
  if (answer.unmapped.length > MAX_UNMAPPED) notes.push(`…and ${answer.unmapped.length - MAX_UNMAPPED} more the model could not map.`);

  // Built within the bounds above, so these hold; if one ever fails, it is a bug here, not a bad answer.
  assertPolicyBounds(policy);
  return { policy: parseContractPolicy(policy), strategy: parseStrategyConfig(strategy, policy), notes, model: ctx.model };
}

function buildStrategy(answer: DraftAnswer, maxNotional: number, notes: string[]): StrategyConfig {
  const n = answer.numbers;
  const L = STRATEGY_LIMITS;
  const D = DEFAULT_STRATEGY;

  let minNetAprPct = D.minNetAprPct;
  if (n.min_net_apr_pct !== undefined) {
    minNetAprPct = n.min_net_apr_pct < 0
      ? refuse('strategy.minNetAprPct', n.min_net_apr_pct, 'is negative', D.minNetAprPct, notes)!
      : clamp('strategy.minNetAprPct', n.min_net_apr_pct, 0, L.maxMinNetAprPct, notes);
  }

  const legCap = Math.min(L.maxLegUsd, maxNotional);
  let legUsd = Math.min(D.legUsd, legCap);
  if (n.leg_usd !== undefined) {
    if (n.leg_usd <= 0) {
      refuse('strategy.legUsd', n.leg_usd, 'is not above 0', legUsd, notes);
    } else {
      legUsd = clamp('strategy.legUsd', n.leg_usd, L.minLegUsd, L.maxLegUsd, notes);
      if (legUsd > maxNotional) {
        notes.push(`strategy.legUsd: ${fmt(legUsd)} is over policy.max_notional_usd ${maxNotional}, the contract's cap per leg; lowered to ${maxNotional}.`);
        legUsd = maxNotional;
      }
    }
  }

  const maxLeverage = n.max_leverage === undefined ? D.maxLeverage : clamp('strategy.maxLeverage', n.max_leverage, 1, L.maxLeverage, notes);

  let stopDrawdownPct = D.stopDrawdownPct;
  if (answer.stopDrawdown === 'none') stopDrawdownPct = null;
  else if (answer.stopDrawdown !== null) {
    stopDrawdownPct = answer.stopDrawdown <= 0
      ? refuse('strategy.stopDrawdownPct', answer.stopDrawdown, 'is not above 0 %', D.stopDrawdownPct, notes)
      : clamp('strategy.stopDrawdownPct', answer.stopDrawdown, 0, 100, notes);
  }

  const nonNegative = (label: string, v: number | undefined, fallback: number, hi: number): number => {
    if (v === undefined) return fallback;
    if (v < 0) return refuse(label, v, 'is negative', fallback, notes)!;
    return clamp(label, v, 0, hi, notes);
  };
  const rotate = {
    minGainPts: nonNegative('strategy.rotate.minGainPts', n.rotate_min_gain_pts, D.rotate.minGainPts, L.maxRotateGainPts),
    forHours: nonNegative('strategy.rotate.forHours', n.rotate_for_hours, D.rotate.forHours, L.maxRotateHours),
  };

  // Distances to liquidation: each strictly between 0 and 100, and the rescue one inside the watch one.
  const distance = (label: string, v: number | undefined, fallback: number): number => {
    if (v === undefined) return fallback;
    if (v <= 0 || v >= 100) return refuse(label, v, 'is not between 0 and 100 %', fallback, notes)!;
    return v;
  };
  let risk = {
    watchDistancePct: distance('strategy.risk.watchDistancePct', n.watch_distance_pct, D.risk.watchDistancePct),
    rescueDistancePct: distance('strategy.risk.rescueDistancePct', n.rescue_distance_pct, D.risk.rescueDistancePct),
  };
  if (!(risk.rescueDistancePct < risk.watchDistancePct)) {
    notes.push(`strategy.risk: a rescue at ${fmt(risk.rescueDistancePct)} % is not inside the watch at ${fmt(risk.watchDistancePct)} %; `
      + `kept the defaults (watch ${D.risk.watchDistancePct} %, rescue ${D.risk.rescueDistancePct} %).`);
    risk = { ...D.risk };
  }

  return { auto: answer.auto ?? D.auto, minNetAprPct, legUsd, maxLeverage, stopDrawdownPct, rotate, risk };
}

/** The venue entries of `symbols` from the market lists: the engine's numbers, never the model's. */
function fillVenues(
  symbols: readonly string[], venues: readonly { id: VenueId; name: string }[], m: DeskMarkets, notes: string[],
): Pick<ContractPolicy, 'hl_assets' | 'phoenix_markets' | 'orderly_symbols'> {
  const out: Pick<ContractPolicy, 'hl_assets' | 'phoenix_markets' | 'orderly_symbols'> = { hl_assets: [], phoenix_markets: [], orderly_symbols: [] };
  if (symbols.length === 0) return out;
  const MAX = POLICY_LIMITS.maxSafeInteger;
  for (const venue of venues) {
    const list = m.markets[venue.id];
    if (list === undefined) {
      notes.push(`${venue.name}'s market list could not be read (${m.failed[venue.id] ?? 'no reader'}): its entries are left out. Draft again once it answers.`);
      continue;
    }
    const missing: string[] = [];
    for (const s of symbols) {
      if (venue.id === 'hyperliquid') {
        const mk = list.find((x) => x.symbol === s && !x.delisted);
        if (mk === undefined || !Number.isInteger(mk.assetIndex) || mk.assetIndex! < 0 || mk.assetIndex! > 0xffff_ffff
          || !Number.isInteger(mk.szDecimals) || mk.szDecimals < 0 || mk.szDecimals > POLICY_LIMITS.hlMaxSzDecimals) {
          missing.push(s);
        } else {
          out.hl_assets.push({ index: mk.assetIndex!, symbol: s, sz_decimals: mk.szDecimals });
        }
      } else if (venue.id === 'phoenix') {
        const mk = list.find((x) => x.symbol === s && !x.delisted) as (Market & { orderbook?: unknown }) | undefined;
        const baseLot = mk === undefined ? NaN : Math.round(mk.lotSize * 1e8);
        const tick = mk === undefined || mk.tickSize === null ? NaN : Math.round(mk.tickSize * 1e8);
        const book = mk?.orderbook;
        if (typeof book !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(book)
          || !(baseLot >= 1 && baseLot <= MAX) || !(tick >= 1 && tick <= MAX)) {
          missing.push(s);
        } else {
          out.phoenix_markets.push({ symbol: s, orderbook: book, base_lot_e8: baseLot, tick_e8: tick });
        }
      } else {
        const name = orderlySymbol(s);
        if (list.some((x) => x.symbol === name && !x.delisted)) out.orderly_symbols.push(name);
        else missing.push(s);
      }
    }
    if (missing.length > 0) notes.push(`${venue.name} lists no ${missing.join(', ')} market the desk can trade: left out there.`);
  }
  return out;
}

/** The contract's checks on a policy that a draft could break (contract/core/src/policy.rs); throws on the first. */
export function assertPolicyBounds(p: ContractPolicy): void {
  const P = POLICY_LIMITS;
  const fail = (what: string): never => {
    throw new Error(`policy draft out of the contract's bounds: ${what}`);
  };
  const symbolOk = (s: string) => s.length >= 1 && s.length <= P.maxSymbolLen && /^[\x21-\x7e]+$/.test(s);
  for (const [name, list] of [['hl_assets', p.hl_assets], ['phoenix_markets', p.phoenix_markets], ['orderly_symbols', p.orderly_symbols], ['unpriced', p.unpriced]] as const) {
    if (list.length > P.maxListLen) fail(`${name} has ${list.length} entries`);
  }
  const unique = (xs: readonly (string | number)[]) => new Set(xs).size === xs.length;
  if (!p.hl_assets.every((a) => symbolOk(a.symbol) && a.sz_decimals <= P.hlMaxSzDecimals) || !unique(p.hl_assets.map((a) => a.index)) || !unique(p.hl_assets.map((a) => a.symbol))) fail('hl_assets');
  if (!p.phoenix_markets.every((m) => symbolOk(m.symbol) && m.base_lot_e8 >= 1 && m.tick_e8 >= 1 && m.base_lot_e8 <= P.maxSafeInteger && m.tick_e8 <= P.maxSafeInteger)
    || !unique(p.phoenix_markets.map((m) => m.symbol)) || !unique(p.phoenix_markets.map((m) => m.orderbook))) fail('phoenix_markets');
  if (!p.orderly_symbols.every((s) => /^PERP_[A-Z0-9]+_USDC$/.test(s) && s.length <= P.maxSymbolLen) || !unique(p.orderly_symbols)) fail('orderly_symbols');
  if (!p.unpriced.every((u) => symbolOk(u.symbol) && /^(0|[1-9][0-9]*)(\.[0-9]{0,7}[1-9])?$/.test(u.max_sz)) || !unique(p.unpriced.map((u) => u.symbol))) fail('unpriced');
  if (!(p.price_band_bps >= 1 && p.price_band_bps <= P.maxPriceBandBps)) fail('price_band_bps');
  if (!(p.oracle_max_age_s >= 1 && p.oracle_max_age_s <= P.maxOracleAgeS)) fail('oracle_max_age_s');
  if (!(p.max_transfer_cost_bps >= 0 && p.max_transfer_cost_bps <= P.maxTransferCostBps)) fail('max_transfer_cost_bps');
  for (const [name, v] of [['max_notional_usd', p.max_notional_usd], ['rescue_cap_usd_per_hour', p.rescue_cap_usd_per_hour],
    ['max_transfer_cost_flat_e6', p.max_transfer_cost_flat_e6], ['unpriced_max_notional_usd', p.unpriced_max_notional_usd]] as const) {
    if (!(Number.isSafeInteger(v) && v >= 0)) fail(name);
  }
}
