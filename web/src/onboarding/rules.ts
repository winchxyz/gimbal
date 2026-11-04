// The rules as the screen shows them: a draft (the contract's policy and the engine's rules, kept apart), the rows that
// describe each part in plain words with where every number came from, and the edits the owner can make to a number.
// Pure, so the wording and the arithmetic are tested without a browser.
import type { ContractPolicy, PolicyDraft, StrategyConfig } from '@gimbal/shared';
import { usdForSz } from './decimal.ts';
import {
  coinsOf,
  sentenceWithCoin,
  sourceOfNumber,
  unpricedCapUsd,
  venuesOf,
  VENUE_NAMES,
  type Source,
} from './policy.ts';

export interface RulesDraft {
  policy: ContractPolicy;
  strategy: StrategyConfig;
  /** What the model could not map ("could not map: ..."), kept as it came. */
  notes: string[];
  /** The model that drafted it; null when the owner fills the form by hand. */
  model: string | null;
}

export const draftOf = (d: PolicyDraft): RulesDraft => ({ policy: d.policy, strategy: d.strategy, notes: d.notes, model: d.model });

/** The engine's own defaults (docs/interfaces.md §2): a form filled by hand starts here, and the owner changes what they want. */
export function defaultStrategy(): StrategyConfig {
  return {
    auto: true,
    minNetAprPct: 5,
    legUsd: 100,
    maxLeverage: 3,
    stopDrawdownPct: null,
    rotate: { minGainPts: 3, forHours: 6 },
    risk: { watchDistancePct: 15, rescueDistancePct: 8 },
    enterAfterChecks: 3,
    exitAfterChecks: 6,
  };
}

/** Every number the owner can change, by id; the id is also the field's id in `Problem.field`. */
export type EditId =
  | 'size'
  | 'band'
  | 'age'
  | 'rescue'
  | 'unpriced-cap'
  | 'transfer'
  | 'transfer-flat'
  | 'min-apr'
  | 'leg'
  | 'leverage'
  | 'stop'
  | 'rotate-gain'
  | 'rotate-hours'
  | 'enter-checks'
  | 'exit-checks'
  | 'watch-distance'
  | 'rescue-distance';

interface EditDef {
  label: string;
  unit: string;
  /** Whole numbers only (the contract stores integers). */
  whole: boolean;
  /** An empty box means "off" instead of a mistake. */
  optional?: boolean;
  get(d: RulesDraft): number | null;
  set(d: RulesDraft, n: number | null): RulesDraft;
}

const withPolicy = (d: RulesDraft, p: Partial<ContractPolicy>): RulesDraft => ({ ...d, policy: { ...d.policy, ...p } });
const withStrategy = (d: RulesDraft, s: Partial<StrategyConfig>): RulesDraft => ({ ...d, strategy: { ...d.strategy, ...s } });

export const EDITS: Record<EditId, EditDef> = {
  size: { label: 'Size per leg', unit: '$', whole: true, get: (d) => d.policy.max_notional_usd, set: (d, n) => withPolicy(d, { max_notional_usd: n ?? 0 }) },
  band: { label: 'Price band', unit: '%', whole: false, get: (d) => d.policy.price_band_bps / 100, set: (d, n) => withPolicy(d, { price_band_bps: Math.round((n ?? 0) * 100) }) },
  age: { label: 'Oracle age', unit: 's', whole: true, get: (d) => d.policy.oracle_max_age_s, set: (d, n) => withPolicy(d, { oracle_max_age_s: n ?? 0 }) },
  rescue: { label: 'Rescue budget', unit: '$ an hour', whole: true, get: (d) => d.policy.rescue_cap_usd_per_hour, set: (d, n) => withPolicy(d, { rescue_cap_usd_per_hour: n ?? 0 }) },
  'unpriced-cap': { label: 'Cap without a price', unit: '$', whole: true, get: (d) => d.policy.unpriced_max_notional_usd, set: (d, n) => withPolicy(d, { unpriced_max_notional_usd: n ?? 0 }) },
  transfer: { label: 'Transfer cost', unit: '%', whole: false, get: (d) => d.policy.max_transfer_cost_bps / 100, set: (d, n) => withPolicy(d, { max_transfer_cost_bps: Math.round((n ?? 0) * 100) }) },
  'transfer-flat': { label: 'Flat transfer cost', unit: '$', whole: false, get: (d) => d.policy.max_transfer_cost_flat_e6 / 1e6, set: (d, n) => withPolicy(d, { max_transfer_cost_flat_e6: Math.round((n ?? 0) * 1e6) }) },
  'min-apr': { label: 'Minimum to enter', unit: '% a year', whole: false, get: (d) => d.strategy.minNetAprPct, set: (d, n) => withStrategy(d, { minNetAprPct: n ?? 0 }) },
  leg: { label: 'Size per leg', unit: '$', whole: false, get: (d) => d.strategy.legUsd, set: (d, n) => withStrategy(d, { legUsd: n ?? 0 }) },
  leverage: { label: 'Leverage', unit: '×', whole: false, get: (d) => d.strategy.maxLeverage, set: (d, n) => withStrategy(d, { maxLeverage: n ?? 0 }) },
  stop: { label: 'Stop at a drawdown of', unit: '%', whole: false, optional: true, get: (d) => d.strategy.stopDrawdownPct, set: (d, n) => withStrategy(d, { stopDrawdownPct: n }) },
  'rotate-gain': { label: 'Rotate for a gain of', unit: 'points', whole: false, get: (d) => d.strategy.rotate.minGainPts, set: (d, n) => withStrategy(d, { rotate: { ...d.strategy.rotate, minGainPts: n ?? 0 } }) },
  'rotate-hours': { label: 'Rotate after', unit: 'hours', whole: false, get: (d) => d.strategy.rotate.forHours, set: (d, n) => withStrategy(d, { rotate: { ...d.strategy.rotate, forHours: n ?? 0 } }) },
  'enter-checks': { label: 'Enter after', unit: 'hourly checks', whole: true, get: (d) => d.strategy.enterAfterChecks, set: (d, n) => withStrategy(d, { enterAfterChecks: n ?? 0 }) },
  'exit-checks': { label: 'Exit after', unit: 'hourly checks', whole: true, get: (d) => d.strategy.exitAfterChecks, set: (d, n) => withStrategy(d, { exitAfterChecks: n ?? 0 }) },
  'watch-distance': { label: 'Watch below', unit: '% from liquidation', whole: false, get: (d) => d.strategy.risk.watchDistancePct, set: (d, n) => withStrategy(d, { risk: { ...d.strategy.risk, watchDistancePct: n ?? 0 } }) },
  'rescue-distance': { label: 'Rescue below', unit: '% from liquidation', whole: false, get: (d) => d.strategy.risk.rescueDistancePct, set: (d, n) => withStrategy(d, { risk: { ...d.strategy.risk, rescueDistancePct: n ?? 0 } }) },
};

/** A number as an input shows it: no trailing zeros, no exponent. */
export const numberText = (n: number | null): string => (n === null ? '' : String(Number(n.toFixed(6))));

/** The current value of an edit, as the input shows it. */
export const editText = (d: RulesDraft, id: EditId): string => numberText(EDITS[id].get(d));

/** Applies what the owner typed; an answer that is not a number says so and changes nothing. */
export function applyEdit(d: RulesDraft, id: EditId, raw: string): { draft: RulesDraft } | { error: string } {
  const def = EDITS[id];
  const text = raw.trim().replace(/,/g, '');
  if (text === '') return def.optional ? { draft: def.set(d, null) } : { error: `Type a number for “${def.label}”.` };
  if (!/^\d+(\.\d+)?$/.test(text)) return { error: `“${raw.trim()}” is not a number.` };
  const n = Number(text);
  if (def.whole && !Number.isInteger(n)) return { error: `“${def.label}” is a whole number.` };
  return { draft: def.set(d, n) };
}

export function setAuto(d: RulesDraft, auto: boolean): RulesDraft {
  return withStrategy(d, { auto });
}

// ---------- the rows ----------

export interface RuleRow {
  /** Stable key, also the id of a problem's field. */
  id: string;
  label: string;
  /** The value in words. */
  value: string;
  source: Source;
  /** The number the row's input edits; null for a row that is read-only or edited in its own control. */
  edit: EditId | null;
}

const usd = (n: number): string => `$${n.toLocaleString('en-US')}`;
const pct = (n: number): string => `${Number(n.toFixed(4))}%`;
const list = (items: string[], none: string): string => (items.length === 0 ? none : items.join(', '));

/** Where `n` came from: the owner's words if they hold it, else the model's, else (hand-filled) the owner's own entry. */
function sourceOf(d: RulesDraft, words: string, n: number, what: string): Source {
  return d.model === null ? { kind: 'fixed', note: 'Set by you' } : sourceOfNumber(words, n, what);
}

/** "enforced by the contract": what `set_policy` writes. */
export function contractRows(d: RulesDraft, words: string, owner: string): RuleRow[] {
  const p = d.policy;
  const coins = coinsOf(p);
  const venues = venuesOf(p);
  const coinWords = coins.map((c) => sentenceWithCoin(words, c)).filter((s): s is string => s !== null);
  const rows: RuleRow[] = [
    {
      id: 'assets',
      label: 'Assets',
      value: list(coins, 'none'),
      source:
        d.model === null
          ? { kind: 'fixed', note: 'Set by you' }
          : coinWords.length > 0
            ? { kind: 'words', quote: quote(coinWords[0]!) }
            : { kind: 'ai', note: 'chosen by NEAR AI, no coin named in your words' },
      edit: null,
    },
    {
      id: 'venues',
      label: 'Exchanges',
      value: list(venues.map((v) => VENUE_NAMES[v]), 'none'),
      source: d.model === null ? { kind: 'fixed', note: 'Set by you' } : { kind: 'ai', note: venues.length === 3 ? 'all three the desk can trade on' : 'the exchanges that list your assets' },
      edit: null,
    },
    { id: 'size', label: 'Size per leg', value: `up to ${usd(p.max_notional_usd)}`, source: sourceOf(d, words, p.max_notional_usd, 'a limit'), edit: 'size' },
    {
      id: 'band',
      label: 'Price check',
      value: `within ${pct(p.price_band_bps / 100)} of the oracle, oracle under ${p.oracle_max_age_s} s old`,
      source: sourceOf(d, words, p.price_band_bps / 100, 'a safety check'),
      edit: 'band',
    },
    { id: 'age', label: 'Oracle age', value: `${p.oracle_max_age_s} s`, source: d.model === null ? { kind: 'fixed', note: 'Set by you' } : { kind: 'ai', note: 'the contract needs a limit' }, edit: 'age' },
    {
      id: 'unpriced',
      label: 'Assets without a trusted price',
      value: p.unpriced.length === 0 ? 'not allowed' : `${p.unpriced.map((u) => u.symbol).join(', ')}, up to ${usd(unpricedCapUsd(p))} an order`,
      source: p.unpriced.length === 0 ? { kind: 'fixed', note: 'the default: the desk trades only what has a price' } : { kind: 'fixed', note: 'you added these' },
      edit: p.unpriced.length === 0 ? null : 'unpriced-cap',
    },
    { id: 'rescue', label: 'Rescue budget', value: `up to ${usd(p.rescue_cap_usd_per_hour)} an hour`, source: sourceOf(d, words, p.rescue_cap_usd_per_hour, 'a safety budget'), edit: 'rescue' },
    {
      id: 'transfer',
      label: 'Cost of moving margin',
      value: `at most ${pct(p.max_transfer_cost_bps / 100)} plus ${usd(p.max_transfer_cost_flat_e6 / 1e6)} a transfer`,
      source: d.model === null ? { kind: 'fixed', note: 'Set by you' } : { kind: 'ai', note: 'the contract needs a limit' },
      edit: 'transfer',
    },
    { id: 'out', label: 'Money out', value: `only to ${owner}`, source: { kind: 'fixed', note: 'always: the contract pays out only to the owner' }, edit: null },
  ];
  return rows;
}

/** "engine rules": what `PUT /strategy` saves. The contract never sees them. */
export function engineRows(d: RulesDraft, words: string): RuleRow[] {
  const s = d.strategy;
  const aiOr = (n: number, what: string): Source => sourceOf(d, words, n, what);
  return [
    {
      id: 'auto',
      label: 'Who acts',
      value: s.auto ? 'the engine enters, exits and rotates by itself' : 'the engine only watches and rescues; you act by hand',
      source: d.model === null ? { kind: 'fixed', note: 'Set by you' } : { kind: 'ai', note: 'the default' },
      edit: null,
    },
    { id: 'min-apr', label: 'Minimum to enter', value: `${pct(s.minNetAprPct)} net a year after costs`, source: aiOr(s.minNetAprPct, 'you gave none, so the default'), edit: 'min-apr' },
    { id: 'leg', label: 'Size per leg', value: `${usd(s.legUsd)} on each exchange`, source: aiOr(s.legUsd, 'a size'), edit: 'leg' },
    { id: 'leverage', label: 'Leverage', value: `up to ${s.maxLeverage}×`, source: aiOr(s.maxLeverage, 'a limit'), edit: 'leverage' },
    {
      id: 'stop',
      label: 'Stop',
      value: s.stopDrawdownPct === null ? 'off' : `close both legs at a drawdown of ${pct(s.stopDrawdownPct)}`,
      source: s.stopDrawdownPct === null ? { kind: 'fixed', note: 'off unless you ask for one' } : aiOr(s.stopDrawdownPct, 'a stop'),
      edit: 'stop',
    },
    {
      id: 'rotate',
      label: 'Rotate',
      value: `to a window that is ${s.rotate.minGainPts} points better for ${s.rotate.forHours} hours in a row`,
      source: d.model === null ? { kind: 'fixed', note: 'Set by you' } : { kind: 'ai', note: 'the defaults' },
      edit: 'rotate-gain',
    },
    {
      id: 'checks',
      label: 'Hourly checks',
      value: `enter after ${s.enterAfterChecks} hours in a row that pass the entry rules, exit after ${s.exitAfterChecks} in a row under the minimum or with the spread flipped`,
      source: d.model === null ? { kind: 'fixed', note: 'Set by you' } : { kind: 'fixed', note: 'the defaults, picked on a backtest of funding history' },
      edit: 'enter-checks',
    },
    {
      id: 'risk',
      label: 'Margin watch',
      value: `watch below ${pct(s.risk.watchDistancePct)}, rescue below ${pct(s.risk.rescueDistancePct)} from liquidation`,
      source: d.model === null ? { kind: 'fixed', note: 'Set by you' } : { kind: 'ai', note: 'the defaults' },
      edit: 'watch-distance',
    },
  ];
}

/** The owner's own sentence that holds a number, shortened, for "From “...”". */
function quote(sentence: string): string {
  return (sentence.length > 70 ? `${sentence.slice(0, 67).trimEnd()}…` : sentence).replace(/[.!?]$/, '');
}

/** How a source reads under its row: “From “Never more than $1,500 a side”” or “Added by NEAR AI: ...”. */
export function sourceLine(source: Source): { text: string; ai: boolean } {
  if (source.kind === 'words') return { text: `From “${source.quote}”`, ai: false };
  if (source.kind === 'ai') return { text: `Added by NEAR AI: ${source.note}`, ai: true };
  return { text: source.note, ai: false };
}

/** An unpriced asset's cap in words: "up to 2,000,000 kPEPE (about $1,500)". */
export function unpricedLine(u: { symbol: string; max_sz: string }, mark: number | undefined): string {
  const worth = mark === undefined ? null : usdForSz(u.max_sz, mark);
  return `up to ${u.max_sz} ${u.symbol}${worth === null ? '' : ` (about ${usd(worth)})`}`;
}

/** The count in the section heading: "8 rules". */
export const countText = (n: number): string => `${n} rule${n === 1 ? '' : 's'}`;
