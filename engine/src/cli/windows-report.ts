// What `npm run windows` prints: its options, and one block per desk window from the scanner's own numbers (the
// window and its expected carry, scanner.carry()). Pure, so the report is tested without a venue.

import type { Window as FundingWindow, VenueId } from '@gimbal/shared';
import { holdLabel, money } from '../scanner/carry.ts';
import { STRATEGY_LIMITS } from '../scanner/config.ts';
import { usd } from '../scanner/price.ts';
import type { LegRates, WindowCarry } from '../scanner/scanner.ts';
import { venueName } from '../venues/names.ts';
import { DESK_VENUE_IDS, isDeskVenueId } from '../venues/venue.ts';

export const WINDOWS_USAGE = 'usage: npm run windows -w engine -- [--mainnet] [--venues hyperliquid,phoenix] [--symbols DOGE,LTC,XLM] '
  + '[--leg-usd 20] [--policy <ContractPolicy.json>]';

export interface WindowsOptions {
  network: 'mainnet' | 'testnet';
  venues: VenueId[];
  /** Bases to keep (upper case); null = every base the venues list. */
  symbols: string[] | null;
  legUsd: number;
  policyFile: string | null;
}

export interface WindowsArgs {
  mainnet?: boolean;
  venues?: string;
  symbols?: string;
  'leg-usd'?: string;
  policy?: string;
}

const list = (s: string) => s.split(',').map((x) => x.trim()).filter((x) => x !== '');

/** Checks the command line's values; throws with the first thing wrong. */
export function windowsOptions(values: WindowsArgs, defaultLegUsd: number): WindowsOptions {
  const venues = values.venues === undefined ? [...DESK_VENUE_IDS] : list(values.venues);
  if (venues.length < 2) throw new Error('--venues needs at least two desk venues: a window is a pair');
  for (const v of venues) if (!isDeskVenueId(v)) throw new Error(`--venues: ${v} is not a desk venue (${DESK_VENUE_IDS.join(', ')})`);
  if (new Set(venues).size !== venues.length) throw new Error('--venues: a venue is named twice');
  const symbols = values.symbols === undefined ? null : list(values.symbols).map((s) => s.toUpperCase());
  if (symbols !== null && symbols.length === 0) throw new Error('--symbols: no symbol given');
  const legUsd = values['leg-usd'] === undefined ? defaultLegUsd : Number(values['leg-usd']);
  if (!(legUsd >= STRATEGY_LIMITS.minLegUsd && legUsd <= STRATEGY_LIMITS.maxLegUsd)) {
    throw new Error(`--leg-usd must be a number from ${STRATEGY_LIMITS.minLegUsd} to ${STRATEGY_LIMITS.maxLegUsd}`);
  }
  return {
    network: values.mainnet === true ? 'mainnet' : 'testnet',
    venues: venues as VenueId[], symbols, legUsd, policyFile: values.policy ?? null,
  };
}

const apr = (n: number | null) => (n === null ? '—' : n.toFixed(2));
const cell = (s: string, w: number) => s.padStart(w);

/**
 * A desk window's gross from its legs' rates: what the short receives minus what the long pays, per column; null
 * where either leg has no figure. (The scanner's own 7- and 14-day gross averages the hours both legs have, so it
 * can differ from this in the last digits.)
 */
export function legGross(long: Pick<LegRates, 'nowAprPct' | 'd7AprPct' | 'd14AprPct'>, short: Pick<LegRates, 'nowAprPct' | 'd7AprPct' | 'd14AprPct'>) {
  const d = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);
  return { now: short.nowAprPct - long.nowAprPct, d7: d(long.d7AprPct, short.d7AprPct), d14: d(long.d14AprPct, short.d14AprPct) };
}

/** The lines `npm run windows` prints for one desk window. */
export function windowBlock(w: FundingWindow, c: WindowCarry): string[] {
  const e = c.estimate;
  const rt = e.roundTrip;
  const lv = venueName(w.longVenue);
  const sv = venueName(w.shortVenue);
  const out: string[] = [];
  out.push(`${w.symbol}  long ${lv}, short ${sv}  (${w.id})`);
  out.push(`  funding, APR %        ${cell('now', 8)}${cell('7 d', 8)}${cell('14 d', 8)}`);
  for (const [leg, side] of [[c.short, 'short'], [c.long, 'long']] as const) {
    const name = `${venueName(leg.venue)} ${leg.symbol} ${side}`.padEnd(22);
    out.push(`    ${name}${cell(apr(leg.nowAprPct), 8)}${cell(apr(leg.d7AprPct), 8)}${cell(apr(leg.d14AprPct), 8)}`);
  }
  out.push(`    ${'gross (short - long)'.padEnd(22)}${cell(apr(e.gross.nowAprPct), 8)}${cell(apr(e.gross.d7AprPct), 8)}${cell(apr(e.gross.d14AprPct), 8)}`);
  out.push(`  round trip    ${money(rt.totalUsd)} = ${rt.bps.toFixed(1)} bps at ${usd(e.legUsd)} a leg `
    + `(4 fills ${money(rt.feesUsd)}, slippage ${money(rt.slippageUsd)}, basis buffer ${money(rt.basisBufferUsd)})`);
  // Paid once a hold too, but never gated on: both are shown so neither is hidden.
  const moves = c.breakdown.transferUsd ?? 0;
  const rescue = c.breakdown.rescueUsd ?? 0;
  out.push(`  one-off, not in the gate: transfers ${money(moves)} (both legs' margin moved in and out through 1Click), `
    + `rescue reserve ${money(rescue)} over the hold`);
  const hold = `over a ${holdLabel(e.holdHours)} hold`;
  if (e.state === 'none') {
    out.push(`  ${hold}  not known: no 7-day history on both legs; fails the gate`);
  } else if (e.state === 'loading') {
    out.push(`  ${hold}  not judged yet: 7 d ${apr(e.gross.d7AprPct)} %, the 14-day history is loading; fails the gate`);
  } else if (e.state === 'mixed') {
    out.push(`  ${hold}  not judged: 7 d ${apr(e.gross.d7AprPct)} % and 14 d ${apr(e.gross.d14AprPct)} % point opposite ways; fails the gate`);
  } else {
    const which = e.gross.d14AprPct === null ? '7 d alone, no 14 d to be had' : `${e.basis === '14d' ? '14 d' : '7 d'}, the smaller of 7 d and 14 d`;
    const even = e.breakevenDays === null ? 'never breaks even' : `break-even ${e.breakevenDays.toFixed(1)} days`;
    out.push(`  ${hold}  expected ${money(e.expectedUsd!)} on ${apr(e.expectedAprPct)} % APR (${which}), `
      + `${money(e.netUsd!)} after the round trip = ${apr(e.netAprPct)} % APR net (minimum ${e.minNetAprPct} %), ${even}: `
      + `${e.ok ? 'passes' : 'fails'} the gate`);
  }
  const oi = (l: LegRates) => `${venueName(l.venue)} ${l.oiUsd === null ? 'no OI published' : usd(l.oiUsd)}`;
  out.push(`  depth         ${usd(w.depthUsd)} (the smaller leg's open interest: ${oi(c.short)}, ${oi(c.long)})`);
  if (w.refused !== undefined) out.push(`  refused       ${w.refused.code}: ${w.refused.reason}`);
  for (const ch of w.checks.filter((x) => !x.ok)) out.push(`  failing       ${ch.text}`);
  return out;
}
