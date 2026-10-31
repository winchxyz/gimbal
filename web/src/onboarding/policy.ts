// The rules form: a `PolicyDraft` (docs/interfaces.md §2) as two separate parts the owner edits as numbers, "enforced
// by the contract" (`policy`, becomes real only through `set_policy`) and "engine rules" (`strategy`, saved with
// `PUT /strategy`). Pure functions on plain objects: every edit returns a new value, and every check mirrors the rule
// that refuses it (the contract's `Policy::validate`, the engine's `parseStrategyConfig`), so the owner sees a problem
// before the wallet opens, not after.
import type { ContractPolicy, StrategyConfig } from '@gimbal/shared';
import { isCanonical, maxSzForUsd, MAX_SAFE, parseE8, usdForSz } from './decimal.ts';
import { b58decode } from './derive.ts';

/** Where a field problem shows: the field's id in the form, and one plain sentence. */
export interface Problem {
  field: string;
  message: string;
}

// ---------- the policy a desk starts with ----------

/**
 * `create_desk` needs a policy before the owner has written any. This one lets the desk do nothing: no assets, no
 * order size, no rescue budget. The owner's rules replace it with `set_policy` (the last two steps of onboarding).
 */
export function starterPolicy(): ContractPolicy {
  return {
    hl_assets: [],
    phoenix_markets: [],
    orderly_symbols: [],
    max_notional_usd: 0,
    price_band_bps: 100,
    oracle_max_age_s: 60,
    rescue_cap_usd_per_hour: 0,
    max_transfer_cost_bps: 100,
    max_transfer_cost_flat_e6: 500_000,
    unpriced: [],
    unpriced_max_notional_usd: 0,
  };
}

// ---------- checks ----------

// The contract's limits (contract/core/src/limits.rs).
const MAX_LIST = 32;
const MAX_SYMBOL = 32;
const MAX_SZ_DECIMALS = 6;

const safeInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const symbolOk = (s: string): boolean => s.length >= 1 && s.length <= MAX_SYMBOL && /^[\x21-\x7e]+$/.test(s);
const perpOk = (s: string): boolean => s.length <= MAX_SYMBOL && /^PERP_[A-Z0-9]+_USDC$/.test(s);
const base58Of32 = (s: string): boolean => {
  try {
    return b58decode(s).length === 32;
  } catch {
    return false;
  }
};

/** What `Policy::validate` would refuse with `E_ARGS`, in the owner's words. Empty means the contract accepts it. */
export function policyProblems(p: ContractPolicy): Problem[] {
  const out: Problem[] = [];
  const add = (field: string, message: string): number => out.push({ field, message });

  if (p.hl_assets.length > MAX_LIST) add('assets', `Hyperliquid lists ${p.hl_assets.length} assets; the contract takes at most ${MAX_LIST}.`);
  p.hl_assets.forEach((a, i) => {
    if (!symbolOk(a.symbol)) add('assets', `Hyperliquid asset ${i + 1} has no valid symbol.`);
    if (!safeInt(a.index)) add('assets', `${a.symbol} has no valid Hyperliquid index.`);
    if (!safeInt(a.sz_decimals) || a.sz_decimals > MAX_SZ_DECIMALS) add('assets', `${a.symbol} has more than ${MAX_SZ_DECIMALS} size decimals.`);
    if (p.hl_assets.findIndex((b) => b.index === a.index) !== i) add('assets', `Hyperliquid lists index ${a.index} twice.`);
    if (p.hl_assets.findIndex((b) => b.symbol === a.symbol) !== i) add('assets', `Hyperliquid lists ${a.symbol} twice.`);
  });
  if (p.phoenix_markets.length > MAX_LIST) add('assets', `Phoenix lists ${p.phoenix_markets.length} markets; the contract takes at most ${MAX_LIST}.`);
  p.phoenix_markets.forEach((m, i) => {
    if (!symbolOk(m.symbol)) add('assets', `Phoenix market ${i + 1} has no valid symbol.`);
    if (!base58Of32(m.orderbook)) add('assets', `The Phoenix book of ${m.symbol} is not a 32-byte address.`);
    if (!safeInt(m.base_lot_e8) || m.base_lot_e8 === 0 || !safeInt(m.tick_e8) || m.tick_e8 === 0) add('assets', `The Phoenix lot or tick of ${m.symbol} is zero.`);
    if (p.phoenix_markets.findIndex((b) => b.symbol === m.symbol) !== i) add('assets', `Phoenix lists ${m.symbol} twice.`);
    if (p.phoenix_markets.findIndex((b) => b.orderbook === m.orderbook) !== i) add('assets', `Phoenix lists one book twice.`);
  });
  if (p.orderly_symbols.length > MAX_LIST) add('assets', `Orderly lists ${p.orderly_symbols.length} symbols; the contract takes at most ${MAX_LIST}.`);
  p.orderly_symbols.forEach((s, i) => {
    if (!perpOk(s)) add('assets', `${s} is not an Orderly perpetual (PERP_<COIN>_USDC).`);
    if (p.orderly_symbols.indexOf(s) !== i) add('assets', `Orderly lists ${s} twice.`);
  });

  if (p.unpriced.length > MAX_LIST) add('unpriced', `${p.unpriced.length} assets without a price; the contract takes at most ${MAX_LIST}.`);
  p.unpriced.forEach((u, i) => {
    if (!symbolOk(u.symbol)) add('unpriced', `Asset ${i + 1} without a price has no valid symbol.`);
    if (p.unpriced.findIndex((b) => b.symbol === u.symbol) !== i) add('unpriced', `${u.symbol} is listed twice.`);
    const sz = parseE8(u.max_sz);
    if (!isCanonical(u.max_sz) || sz === null) add('unpriced', `The size cap of ${u.symbol} is not a plain decimal (${u.max_sz}).`);
    else if (sz > MAX_SAFE * 10n ** 8n) add('unpriced', `The size cap of ${u.symbol} is too large.`);
  });

  if (!safeInt(p.price_band_bps) || p.price_band_bps < 1 || p.price_band_bps > 10_000) add('band', 'The price band must be between 0.01% and 100% of the oracle price.');
  if (!safeInt(p.oracle_max_age_s) || p.oracle_max_age_s < 1 || p.oracle_max_age_s > 3_600) add('age', 'The oracle price may be 1 to 3,600 seconds old.');
  if (!safeInt(p.max_transfer_cost_bps) || p.max_transfer_cost_bps > 10_000) add('transfer', 'A transfer may cost at most 100% of its amount.');
  for (const [field, value, label] of [
    ['size', p.max_notional_usd, 'The size per leg'],
    ['rescue', p.rescue_cap_usd_per_hour, 'The rescue budget'],
    ['transfer-flat', p.max_transfer_cost_flat_e6, 'The flat transfer cost'],
    ['unpriced-cap', p.unpriced_max_notional_usd, 'The cap for assets without a price'],
  ] as const) {
    if (!safeInt(value)) add(field, `${label} must be a whole number, at most ${Number.MAX_SAFE_INTEGER.toLocaleString('en-US')}.`);
  }
  return out;
}

/** The limits `PUT /strategy` enforces (engine/src/scanner/config.ts, STRATEGY_LIMITS), plus the policy's size cap. */
export const STRATEGY_LIMITS = { minLegUsd: 10, maxLegUsd: 100_000, maxLeverage: 10, maxMinNetAprPct: 1_000, maxRotateGainPts: 1_000, maxRotateHours: 24 * 30 } as const;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const between = (n: unknown, lo: number, hi: number): n is number => finite(n) && n >= lo && n <= hi;

/** What `PUT /strategy` would refuse, against the policy the owner is about to sign. Empty means it takes it. */
export function strategyProblems(s: StrategyConfig, policy: ContractPolicy): Problem[] {
  const L = STRATEGY_LIMITS;
  const out: Problem[] = [];
  const add = (field: string, message: string): number => out.push({ field, message });
  if (!between(s.minNetAprPct, 0, L.maxMinNetAprPct)) add('min-apr', `The minimum must be from 0 to ${L.maxMinNetAprPct}% a year.`);
  if (!between(s.legUsd, L.minLegUsd, L.maxLegUsd)) add('leg', `The size per leg must be from $${L.minLegUsd} to $${L.maxLegUsd.toLocaleString('en-US')}: the exchanges refuse smaller orders.`);
  else if (s.legUsd > policy.max_notional_usd) add('leg', `The engine opens $${s.legUsd.toLocaleString('en-US')} a leg, over the contract’s cap of $${policy.max_notional_usd.toLocaleString('en-US')}: the contract would refuse every order.`);
  if (!between(s.maxLeverage, 1, L.maxLeverage)) add('leverage', `Leverage must be from 1 to ${L.maxLeverage}×.`);
  if (s.stopDrawdownPct !== null && !(finite(s.stopDrawdownPct) && s.stopDrawdownPct > 0 && s.stopDrawdownPct <= 100)) add('stop', 'The stop must be a drawdown above 0% and at most 100%, or off.');
  if (!between(s.rotate.minGainPts, 0, L.maxRotateGainPts)) add('rotate-gain', `A rotation gain must be from 0 to ${L.maxRotateGainPts} points.`);
  if (!between(s.rotate.forHours, 0, L.maxRotateHours)) add('rotate-hours', `A rotation wait must be from 0 to ${L.maxRotateHours} hours.`);
  const { watchDistancePct: watch, rescueDistancePct: rescue } = s.risk;
  if (!(finite(watch) && finite(rescue) && rescue > 0 && rescue < watch && watch < 100)) add('risk', 'The rescue distance must be above 0 and below the watch distance, and the watch distance below 100%.');
  return out;
}

// ---------- reading a policy ----------

/** The coin of an Orderly symbol: PERP_SOL_USDC → SOL. */
export const coinOfPerp = (symbol: string): string => symbol.replace(/^PERP_/, '').replace(/_USDC$/, '');

/** Every coin the policy lists on any exchange, in the order they first appear (Hyperliquid, Phoenix, Orderly). */
export function coinsOf(p: ContractPolicy): string[] {
  const all = [...p.hl_assets.map((a) => a.symbol), ...p.phoenix_markets.map((m) => m.symbol), ...p.orderly_symbols.map(coinOfPerp)];
  return [...new Set(all)];
}

export type VenueKey = 'hyperliquid' | 'phoenix' | 'orderly';
export const VENUE_NAMES: Record<VenueKey, string> = { hyperliquid: 'Hyperliquid', phoenix: 'Phoenix', orderly: 'Orderly' };

/** The exchanges the policy lists something on. */
export function venuesOf(p: ContractPolicy): VenueKey[] {
  const out: VenueKey[] = [];
  if (p.hl_assets.length > 0) out.push('hyperliquid');
  if (p.phoenix_markets.length > 0) out.push('phoenix');
  if (p.orderly_symbols.length > 0) out.push('orderly');
  return out;
}

// ---------- editing a policy ----------

/** Takes a coin out of every exchange's list. The form cannot add one: an asset needs its exchange's own ids. */
export function removeCoin(p: ContractPolicy, coin: string): ContractPolicy {
  return {
    ...p,
    hl_assets: p.hl_assets.filter((a) => a.symbol !== coin),
    phoenix_markets: p.phoenix_markets.filter((m) => m.symbol !== coin),
    orderly_symbols: p.orderly_symbols.filter((s) => coinOfPerp(s) !== coin),
  };
}

/** Takes an exchange out of the policy: its list becomes empty and the contract refuses every order there. */
export function removeVenue(p: ContractPolicy, venue: VenueKey): ContractPolicy {
  return venue === 'hyperliquid' ? { ...p, hl_assets: [] } : venue === 'phoenix' ? { ...p, phoenix_markets: [] } : { ...p, orderly_symbols: [] };
}

/** Lets the desk trade a Hyperliquid asset by its listing (index and size decimals come from Hyperliquid's `meta`). */
export function addHlAsset(p: ContractPolicy, asset: { index: number; symbol: string; sz_decimals: number }): { policy: ContractPolicy } | { error: string } {
  if (p.hl_assets.some((a) => a.symbol === asset.symbol || a.index === asset.index)) return { error: `${asset.symbol} is already on the list.` };
  if (p.hl_assets.length >= MAX_LIST) return { error: `The contract takes at most ${MAX_LIST} Hyperliquid assets.` };
  return { policy: { ...p, hl_assets: [...p.hl_assets, asset] } };
}

export function removeUnpriced(p: ContractPolicy, symbol: string): ContractPolicy {
  return { ...p, unpriced: p.unpriced.filter((u) => u.symbol !== symbol) };
}

/**
 * Lets an asset without an oracle price trade under a size cap: the owner types a USD cap, and it becomes `max_sz`
 * at the current mark (docs/interfaces.md §1.2, "Unpriced assets"). Returns the policy, or the reason it cannot.
 */
export function addUnpriced(p: ContractPolicy, symbol: string, usdCap: number, mark: number): { policy: ContractPolicy } | { error: string } {
  const sym = symbol.trim();
  if (!symbolOk(sym)) return { error: 'Type the asset’s symbol as the exchange spells it, for example kPEPE.' };
  if (p.unpriced.some((u) => u.symbol === sym)) return { error: `${sym} is already on the list.` };
  if (!(usdCap > 0)) return { error: 'Type a cap in dollars above zero.' };
  if (!(mark > 0)) return { error: `There is no mark price for ${sym} to convert the cap with.` };
  const maxSz = maxSzForUsd(usdCap, mark);
  if (maxSz === null) return { error: `$${usdCap} at a mark of $${mark} is not a size the contract can hold.` };
  return { policy: { ...p, unpriced: [...p.unpriced, { symbol: sym, max_sz: maxSz }] } };
}

/** What an unpriced asset's size cap is worth at the mark, for "up to X (about $Y)"; null without a mark. */
export const unpricedUsd = (maxSz: string, mark: number | undefined): number | null => (mark === undefined ? null : usdForSz(maxSz, mark));

/**
 * The most an unpriced order may be worth: it has to fit both `max_notional_usd` and `unpriced_max_notional_usd`
 * (docs/interfaces.md §1.2), so the smaller one is the cap the owner actually gets.
 */
export const unpricedCapUsd = (p: ContractPolicy): number => Math.min(p.max_notional_usd, p.unpriced_max_notional_usd);

// ---------- the rules as rows ----------

/** Where a rule's number came from: the owner's own words, or something the model supplied. */
export type Source = { kind: 'words'; quote: string } | { kind: 'ai'; note: string } | { kind: 'fixed'; note: string };

const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s !== '');

/** How a number may be written in the owner's words: 1500, 1,500, 1.5k; and 3 as "3x" or "3×". */
function formsOf(n: number): string[] {
  const forms = [String(n), n.toLocaleString('en-US')];
  if (n >= 1000 && n % 100 === 0) forms.push(`${n / 1000}k`, `${n / 1000}K`);
  return [...new Set(forms)];
}

/** The sentence of the owner's words that holds this number, or null: the number is not in what they wrote. */
export function sentenceWith(text: string, n: number): string | null {
  const forms = formsOf(n).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<![\\d.,])(?:${forms.join('|')})(?!\\d|[.,]\\d)`, 'i');
  return sentencesOf(text).find((s) => pattern.test(s)) ?? null;
}

/** The sentence that names this coin, as a whole word, or null. */
export function sentenceWithCoin(text: string, coin: string): string | null {
  const pattern = new RegExp(`(?<![A-Za-z0-9])${coin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`);
  return sentencesOf(text).find((s) => pattern.test(s)) ?? null;
}

const quoteOf = (sentence: string): string => (sentence.length > 70 ? `${sentence.slice(0, 67).trimEnd()}…` : sentence).replace(/[.!?]$/, '');

/** A number traced to the owner's words, or marked as the model's. */
export function sourceOfNumber(text: string, n: number, what: string): Source {
  const sentence = sentenceWith(text, n);
  return sentence === null ? { kind: 'ai', note: `${what}, not a number in your words` } : { kind: 'words', quote: quoteOf(sentence) };
}
