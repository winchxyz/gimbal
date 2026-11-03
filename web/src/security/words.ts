// The contract's numbers as sentences an owner can check against their own wallet. Pure, so it is tested.
//
// Only what the contract enforces is said here (docs/interfaces.md §1.2, `Policy`). Leverage and the minimum net APR
// are engine rules the contract never sees, so they are not listed as protections.
import type { ContractPolicy } from '@gimbal/shared';
import { coinOfPerp, unpricedCapUsd } from '../onboarding/policy.ts';
import { usd } from '../windows/format.ts';

/** `1`, `0.5`, `1.25`: a number with up to `decimals` decimals and no trailing zeros. */
export function trimmed(value: number, decimals = 3): string {
  return String(Number(value.toFixed(decimals)));
}

/** Basis points as a percentage: 100 → `1%`, 50 → `0.5%`, 1000 → `10%`. */
export const bpsPct = (bps: number): string => `${trimmed(bps / 100, 2)}%`;

/** A number of seconds the way an owner would say it: 900 → `15 minutes`, 60 → `1 minute`, 45 → `45 seconds`. */
export function ageWords(seconds: number): string {
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (seconds >= 3600 && seconds % 3600 === 0) return plural(seconds / 3600, 'hour');
  if (seconds >= 60 && seconds % 60 === 0) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}

/** `2000000` → `2,000,000`; a canonical decimal keeps its fraction as written, so no float rounds a size. */
export function groupDecimal(text: string): string {
  const [whole = '', fraction] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export interface PolicyLine {
  key: string;
  text: string;
  /** `watch`: the owner allowed something with no price protection, which is the one state a policy line can be in. */
  tone?: 'watch';
}

const assetsLine = (key: string, venue: string, symbols: readonly string[]): PolicyLine => ({
  key,
  text: symbols.length === 0 ? `${venue}: nothing allowed` : `${venue}: ${symbols.join(', ')}`,
});

/**
 * What the quotes of the hourly rescue cost budget may cost per hour, in USD (the contract's `rescue_quote_budget_e8`): the
 * larger of the bps share of the cap and twice the flat part. The whole budget adds room for 4 venue fees of 1 USDC.
 */
export function hourlyCostBudgetUsd(p: ContractPolicy): number {
  return Math.max((p.rescue_cap_usd_per_hour * p.max_transfer_cost_bps) / 10_000, (2 * p.max_transfer_cost_flat_e6) / 1e6);
}

/** The policy in plain words, one line per rule, in the order the contract checks an order. */
export function policyLines(p: ContractPolicy, owner: string): PolicyLine[] {
  const lines: PolicyLine[] = [
    assetsLine('hyperliquid', 'Hyperliquid', p.hl_assets.map((a) => a.symbol)),
    assetsLine('phoenix', 'Phoenix', p.phoenix_markets.map((m) => m.symbol)),
    assetsLine('orderly', 'Orderly', p.orderly_symbols.map(coinOfPerp)),
    { key: 'size', text: p.max_notional_usd === 0 ? 'No leg size is allowed: every order is refused' : `Each leg up to ${usd(p.max_notional_usd, 0)}` },
    { key: 'band', text: `Orders within ${bpsPct(p.price_band_bps)} of the oracle price` },
    { key: 'age', text: `Oracle price no older than ${ageWords(p.oracle_max_age_s)}` },
  ];

  if (p.rescue_cap_usd_per_hour === 0) {
    lines.push({ key: 'rescue', text: 'No margin moves out of an exchange are allowed' });
  } else {
    lines.push({ key: 'rescue', text: `Margin moves out of an exchange: up to ${usd(p.rescue_cap_usd_per_hour, 0)} an hour` });
    lines.push({
      key: 'cost',
      text: `A move may cost at most ${bpsPct(p.max_transfer_cost_bps)} of its amount, or ${usd(p.max_transfer_cost_flat_e6 / 1e6)} if that is more; ${usd(hourlyCostBudgetUsd(p))} an hour in all, plus up to 4 USDC of venue fees`,
    });
  }

  if (p.unpriced.length === 0) {
    lines.push({ key: 'unpriced', text: 'No assets without a trusted price' });
  } else {
    const cap = unpricedCapUsd(p);
    for (const u of p.unpriced) {
      lines.push({
        key: `unpriced-${u.symbol}`,
        tone: 'watch',
        text:
          cap === 0
            ? `${u.symbol} has no price protection, and its cap is $0, so no order can pass`
            : `${u.symbol} has no price protection: up to ${groupDecimal(u.max_sz)} ${u.symbol}, and no more than ${usd(cap, 0)} a leg`,
      });
    }
  }

  lines.push({ key: 'out', text: `Money out only to ${owner}` });
  return lines;
}

/** What the oracle bullet under "What you still trust" says, from the same two numbers the policy sets. */
export const oracleTrust = (p: ContractPolicy): string => `The oracle price, within the ${bpsPct(p.price_band_bps)} band and ${ageWords(p.oracle_max_age_s)} age`;

export interface Fees {
  performanceBps: number;
  hlBuilderTenthBps: number;
}

/** The owner account's full-access keys, in a sentence: they are the keys that can call everything, so they are counted, not hidden. */
export function fullAccessText(owner: string, count: number): string {
  if (count === 0) return `${owner} has no full-access key, so nobody can call the owner-only methods.`;
  return `${owner} has ${count} full-access ${count === 1 ? 'key; whoever holds it' : 'keys; whoever holds them'} can call everything.`;
}

/** The first sentence of the error state, from the failure's own words and the time (`21:00`). A down RPC and a wrong contract are different things to say. */
export function readFailureText(message: string, time: string): string {
  const down = 'NEAR RPC did not answer';
  if (!message.startsWith(down)) return `The contract could not be read at ${time} UTC (${message}).`;
  const detail = message.slice(down.length).replace(/^:\s*/, '');
  return detail === '' ? `The NEAR RPC didn’t answer at ${time} UTC.` : `The NEAR RPC didn’t answer at ${time} UTC (${detail}).`;
}

/** A Hyperliquid builder fee is in tenths of a basis point: 10 → `1 bp (0.01%)`, 5 → `0.5 bp (0.005%)`. */
export function builderFeeText(tenthBps: number): string {
  const bp = tenthBps / 10;
  return `${trimmed(bp)} bp (${trimmed(bp / 100, 4)}%)`;
}

/** The fees the contract takes, in plain words (`FeeConfig`, docs/interfaces.md §1.1). */
export function feeLines(f: Fees): string[] {
  return [
    f.performanceBps === 0
      ? 'No performance fee'
      : `${bpsPct(f.performanceBps)} of the profit above your high-water mark, taken when you withdraw`,
    `${builderFeeText(f.hlBuilderTenthBps)} of every Hyperliquid fill, as the builder fee`,
    'Nothing on deposits, rescues or losses',
  ];
}
