// Cross-venue self-check of funding units. The same coin pays roughly the same funding everywhere: arbitrage keeps
// venues within a few times of each other and mostly on the same side. A reader that slips a unit (per 8 h read
// as per hour, a percent read as a fraction, an annualised rate left annualised) or flips the sign stands out
// against the median of every other venue at once:
//   - sign agreement: the share of shared coins where the venue's rate has the sign of the others' median;
//   - median ratio: the median over shared coins of |venue rate| / |others' median|.
// A healthy venue agrees on most signs and has a median ratio within a few times of 1; a slipped one lands near
// 8, 24, 100 or 8760 (or their inverses), and a flipped one near 0% agreement.
//
// The median ratio is too coarse for a slip by 4 (a 4 h rate read per hour lands at 4, inside the band that
// venues paying premium only need) and blind to a slip in one settlement group of a venue. The quiet pin is
// exact: per venue and settlement period, the most common nonzero rate is where its quiet coins sit, the
// 0.01% per 8 h baseline (0.0000125 per hour) on most venues. A group read with the wrong period moves that pin
// to 4, 8 or 24 times the baseline (or a quarter, an eighth, a 24th of it) while every other group stays put.

import type { ScanVenueId } from '@gimbal/shared';
import type { MarketFunding } from '../venue.ts';
import { baseOf } from './sweep.ts';
import { HOURS_PER_YEAR, type Settlement } from './units.ts';

export interface AgreementOptions {
  minOthers: number;             // a coin is compared only where at least this many other venues list it
  minRefPerHour: number;         // ... and the others' median is at least this far from 0 (per hour)
}

/**
 * Coins at 0 or within ~1% APR of it say nothing about a unit. The floor sits well under the 0.01% per 8 h
 * baseline most venues sit at on quiet coins (0.0000125 per hour, 11% APR), which is the clearest unit signal.
 */
export const DEFAULT_AGREEMENT: AgreementOptions = { minOthers: 3, minRefPerHour: 0.01 / HOURS_PER_YEAR };

export interface VenueAgreement {
  venue: ScanVenueId;
  compared: number;              // shared coins that passed the filters
  signAgreement: number;         // 0..1
  medianRatio: number;           // median |own| / |others' median|; NaN with nothing compared
}

/** One rate per venue and coin: the median of the venue's markets on that coin (most venues list one). */
export function ratesByBase(byVenue: ReadonlyMap<ScanVenueId, readonly MarketFunding[]>): Map<string, Map<ScanVenueId, number>> {
  const lists = new Map<string, Map<ScanVenueId, number[]>>();
  for (const [venue, markets] of byVenue) {
    for (const f of markets) {
      const base = baseOf(f);
      let perVenue = lists.get(base);
      if (perVenue === undefined) lists.set(base, (perVenue = new Map()));
      const rates = perVenue.get(venue) ?? [];
      rates.push(f.ratePerHour);
      perVenue.set(venue, rates);
    }
  }
  const out = new Map<string, Map<ScanVenueId, number>>();
  for (const [base, perVenue] of lists) out.set(base, new Map([...perVenue].map(([v, rates]) => [v, median(rates)])));
  return out;
}

/** Sign agreement and median ratio of every venue against the median of the other venues, coin by coin. */
export function agreement(
  byVenue: ReadonlyMap<ScanVenueId, readonly MarketFunding[]>,
  options: AgreementOptions = DEFAULT_AGREEMENT,
  references: ReadonlySet<ScanVenueId> | null = null,
): VenueAgreement[] {
  const rates = ratesByBase(byVenue);
  const out: VenueAgreement[] = [];
  for (const venue of byVenue.keys()) {
    let compared = 0;
    let agree = 0;
    const ratios: number[] = [];
    for (const perVenue of rates.values()) {
      const own = perVenue.get(venue);
      if (own === undefined || own === 0) continue;
      const others = [...perVenue].filter(([v]) => v !== venue && (references === null || references.has(v))).map(([, r]) => r);
      if (others.length < options.minOthers) continue;
      const ref = median(others);
      if (Math.abs(ref) < options.minRefPerHour) continue;
      compared += 1;
      if (Math.sign(own) === Math.sign(ref)) agree += 1;
      ratios.push(Math.abs(own) / Math.abs(ref));
    }
    out.push({ venue, compared, signAgreement: compared === 0 ? NaN : agree / compared, medianRatio: ratios.length === 0 ? NaN : median(ratios) });
  }
  return out;
}

export interface CheckLimits {
  minCompared: number;           // venues comparing fewer coins are printed, not judged
  minSignAgreement: number;      // below this the venue's sign is suspect
  ratioBand: [number, number];   // a healthy median ratio lies inside
  slipFactors: readonly number[];   // unit slips named in the message, with their inverses
  slipTolerance: number;         // a ratio within this factor of a slip factor is named as that slip
  minPinned: number;             // settlement groups whose quiet pin holds fewer markets are printed, not judged
  pinBand: [number, number];     // a healthy quiet pin lies within this multiple of the baseline
}

/**
 * Measured on the recorded sweep (24 venues): median ratio 0.96-1.04 on the venues that pin quiet coins at the
 * 0.01% per 8 h baseline, up to 4.7 on those that do not (Kraken: premium only, larger on its alts; GMX: funding
 * plus borrow). A slip by 8 moves the lowest healthy ratio to 7.7 and the highest to 0.58: the band sits between.
 * Sign agreement is 60-91%, and 52% on hl-xyz, whose equities trade through the weekend while the other venues
 * hold equity funding at 0; a flip turns p% into (100 - p)%, so any venue at 60% or more drops under the limit.
 * Quiet pins sit at 0.96-1.04 x the baseline, at 0.5 x on hl-xyz (half the baseline on its equities, settled so
 * in its own history), and MEXC's 8 h group is split between 1 x and 2 x (stock perps capped at 0.02% per 8 h):
 * the pin band takes 1/2..2 and leaves out 4 and 1/4, the nearest slips.
 */
export const DEFAULT_LIMITS: CheckLimits = {
  minCompared: 10,
  minSignAgreement: 0.45,
  ratioBand: [0.7, 6],
  slipFactors: [4, 8, 24, 100, HOURS_PER_YEAR],
  slipTolerance: 1.5,
  minPinned: 10,
  pinBand: [1 / 3, 3],
};

/** The 0.01% per 8 h baseline most venues pin quiet coins at, per hour (10.95% APR). */
export const BASELINE_PER_HOUR = 0.0001 / 8;

export interface QuietPin {
  venue: ScanVenueId;
  settlement: Settlement;
  ratePerHour: number;           // the most common nonzero rate of the group
  markets: number;               // how many of the group's markets sit at exactly that rate
  ofBaseline: number;            // ratePerHour / BASELINE_PER_HOUR
}

/** Per venue and settlement period, the most common nonzero rate and how many markets sit at it exactly. */
export function quietPins(byVenue: ReadonlyMap<ScanVenueId, readonly MarketFunding[]>): QuietPin[] {
  const out: QuietPin[] = [];
  for (const [venue, markets] of byVenue) {
    const groups = new Map<Settlement, Map<number, number>>();
    for (const f of markets) {
      if (f.ratePerHour === 0) continue;
      const counts = groups.get(f.settlement) ?? new Map<number, number>();
      counts.set(f.ratePerHour, (counts.get(f.ratePerHour) ?? 0) + 1);
      groups.set(f.settlement, counts);
    }
    for (const [settlement, counts] of groups) {
      let [ratePerHour, markets] = [NaN, 0];
      for (const [r, n] of counts) if (n > markets) [ratePerHour, markets] = [r, n];
      out.push({ venue, settlement, ratePerHour, markets, ofBaseline: ratePerHour / BASELINE_PER_HOUR });
    }
  }
  return out;
}

/** What is wrong with a group's quiet pin, one line; empty when it sits near the baseline or is not judged. */
export function pinProblems(p: QuietPin, limits: CheckLimits = DEFAULT_LIMITS): string[] {
  if (p.markets < limits.minPinned) return [];
  const [lo, hi] = limits.pinBand;
  if (p.ofBaseline >= lo && p.ofBaseline <= hi) return [];
  const near = nearSlip(Math.abs(p.ofBaseline), limits);
  const slip = near === undefined ? '' : `, near ${near >= 1 ? near : `1/${Math.round(1 / near)}`}: a period slip?`;
  return [`${p.venue} ${p.settlement}: ${p.markets} markets sit at ${p.ratePerHour} per hour, ${fmtRatio(p.ofBaseline)} x the 0.01% per 8 h baseline (want ${fmtRatio(lo)}..${hi})${slip}`];
}

function nearSlip(ratio: number, limits: CheckLimits): number | undefined {
  return limits.slipFactors.flatMap((k) => [k, 1 / k])
    .find((f) => ratio >= f / limits.slipTolerance && ratio <= f * limits.slipTolerance);
}

/** What is wrong with a venue's agreement, one line per problem; empty when it looks healthy or is not judged. */
export function agreementProblems(a: VenueAgreement, limits: CheckLimits = DEFAULT_LIMITS): string[] {
  if (a.compared < limits.minCompared) return [];
  const problems: string[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  if (!(a.signAgreement >= limits.minSignAgreement)) {
    problems.push(`${a.venue}: sign agrees on ${pct(a.signAgreement)} of ${a.compared} coins (want >= ${pct(limits.minSignAgreement)}): sign flipped?`);
  }
  const [lo, hi] = limits.ratioBand;
  if (!(a.medianRatio >= lo && a.medianRatio <= hi)) {
    const near = nearSlip(a.medianRatio, limits);
    const slip = near === undefined ? '' : `, near ${near >= 1 ? near : `1/${Math.round(1 / near)}`}: a unit slip?`;
    problems.push(`${a.venue}: median ratio ${fmtRatio(a.medianRatio)} is outside ${lo}..${hi}${slip}`);
  }
  return problems;
}

/** The rate per hour of each coin on each venue, or undefined where the venue does not list it. */
export function majors(byVenue: ReadonlyMap<ScanVenueId, readonly MarketFunding[]>, coins: readonly string[]): Map<ScanVenueId, (number | undefined)[]> {
  const rates = ratesByBase(byVenue);
  return new Map([...byVenue.keys()].map((v) => [v, coins.map((c) => rates.get(c)?.get(v))]));
}

/**
 * The whole self-check as printable lines: the majors table, then each venue's agreement, its quiet pins (the
 * groups holding `minPinned` markets or more, as a multiple of the baseline) and any problem.
 */
export function selfCheckReport(
  byVenue: ReadonlyMap<ScanVenueId, readonly MarketFunding[]>,
  options: AgreementOptions = DEFAULT_AGREEMENT,
  limits: CheckLimits = DEFAULT_LIMITS,
): { lines: string[]; problems: string[] } {
  const coins = ['BTC', 'ETH', 'SOL'];
  const width = Math.max(...[...byVenue.keys()].map((v) => v.length));
  const lines = [`${'venue'.padEnd(width)}  ${coins.map((c) => `${c} %APR`.padStart(10)).join('')}   coins  sign  ratio  quiet pins`];
  const table = majors(byVenue, coins);
  const stats = new Map(agreement(byVenue, options).map((a) => [a.venue, a]));
  const pins = quietPins(byVenue);
  const problems: string[] = [];
  for (const [venue, row] of table) {
    const a = stats.get(venue)!;
    const cells = row.map((r) => (r === undefined ? '-' : (r * HOURS_PER_YEAR * 100).toFixed(2)).padStart(10)).join('');
    const judged = a.compared >= limits.minCompared;
    const sign = Number.isNaN(a.signAgreement) ? '-' : `${(a.signAgreement * 100).toFixed(0)}%`;
    const own = pins.filter((p) => p.venue === venue && p.markets >= limits.minPinned);
    const pinCells = own.map((p) => `${p.settlement} ${fmtRatio(p.ofBaseline)}x${p.markets}`).join(' ') || '-';
    lines.push(`${venue.padEnd(width)}  ${cells}   ${String(a.compared).padStart(5)}  ${sign.padStart(4)}  ${fmtRatio(a.medianRatio).padStart(5)}  ${pinCells}${judged ? '' : '  (ratio not judged)'}`);
    problems.push(...agreementProblems(a, limits), ...own.flatMap((p) => pinProblems(p, limits)));
  }
  return { lines, problems };
}

function fmtRatio(r: number): string {
  return Number.isNaN(r) ? '-' : r >= 100 ? r.toFixed(0) : r.toFixed(2);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
