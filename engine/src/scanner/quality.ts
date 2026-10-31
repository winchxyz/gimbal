// How good a reference a watch-only window's legs are. The watch-unit audit of 2026-10-31 found every watch window
// above 200 % gross to be a real rate, not a unit slip, yet many of them no window to rank first: a market that
// barely trades, a rate pinned at a venue's cap, a relayed reading nothing else confirms, a default where every other
// venue agrees on something else, a stock perp read while its exchange is shut. Each finding is a failing check on
// the window, and a window with one ranks after the clean watch windows. Nothing here drops a leg or a window: watch
// windows are reference only. Desk windows are judged by their books, the policy and the oracle instead.
//
// One finding per leg and kind, at most:
// - Thin: the leg traded under minVolume24hUsd in 24 h. Where the venue publishes no volume, its open interest
//   (already held to the floor in filterLegs) stands in; a leg with a price but neither is thin too.
// - At the cap: the rate sits on its market's funding cap or floor (the market's own, from the venue's answer, each
//   side on its own; else config FUNDING_LIMITS), or 3+ venues print the same rate, well off the baseline, to the
//   digit: free premiums never agree that closely, a shared clamp does (Q settled at the -2 % per 4 h floor on five
//   venues at once).
// - Unconfirmed: a leg with no mark, no open interest and no history of its own (Binance and Bybit, relayed by
//   Hyperliquid's predictedFundings) whose rate no venue with data of its own reads too.
// - Lone baseline: such a relayed leg at its venue's quiet pin (the rate most of its markets sit at, about 0.01 % per
//   8 h) while a crowd of other venues agrees far from it (BLUR on Bybit): more likely a default than the market's
//   rate. A venue with data of its own at the pin is not flagged: its premium sits inside the clamp, and the carry
//   against the crowd is real.
// - Market closed: a stock perp read while its own exchange is shut (New York's hours unless config lists the share
//   elsewhere: Samsung keeps Seoul's), or a commodity, index or FX market of a traditional-only venue (hl-xyz) over
//   the futures weekend: its rate is not set by a live market (a Kraken rate against 0 elsewhere on a Saturday). A
//   stock or ETF on hl-xyz is a stock perp too. A listing names a leg's market only when their marks agree, never
//   by ticker alone: Bitget's DASHSTOCKUSDT is DoorDash, not the Dash coin.
// Pure: the legs, the time and the tables come in as arguments.

import type { ScanVenueId, Window as FundingWindow } from '@gimbal/shared';
import { venueName, venueNames } from '../venues/names.ts';
import { normalizeBase } from '../venues/watch/symbols.ts';
import type { MarketSession, QualityConfig } from './config.ts';
import type { LegDrop, Pair, ScanLeg } from './pairs.ts';
import { usd } from './price.ts';

/** The 0.01 % per 8 h baseline most venues pin quiet markets at, per hour. */
const BASELINE_PER_HOUR = 0.0001 / 8;
/** Coincidences and crowds count only rates at least this far from zero (4 x the baseline, about 44 % APR). */
const FAR_PER_HOUR = 4 * BASELINE_PER_HOUR;
/** Venues that must print one rate to the digit for it to count as a shared cap. */
const MIN_SAME_RATE = 3;
/** Markets a venue's settlement group needs on one rate for that rate to be its quiet pin. */
const MIN_PINNED = 10;
/** Venues a crowd needs, agreeing with each other, to make a baseline reading lone. */
const MIN_CROWD = 4;

/** Every check a finding writes starts with one of these. */
export const QUALITY_PREFIXES = ['Thin:', 'At the cap:', 'Unconfirmed:', 'Lone baseline:', 'Market closed:'] as const;

/** Whether a window carries a quality finding (and so ranks after the clean watch windows). */
export function hasQualityFinding(w: Pick<FundingWindow, 'checks'>): boolean {
  return w.checks.some((c) => !c.ok && QUALITY_PREFIXES.some((p) => c.text.startsWith(p)));
}

/** A rate as "x % per hour", 3 significant figures. */
export function perHour(rate: number): string {
  return `${Number((rate * 100).toPrecision(3))} % per hour`;
}

const sameRate = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
/** Two readings of one market agree: within half of the larger, or within half the baseline near zero. */
const agrees = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.5 * Math.max(Math.abs(a), Math.abs(b)), BASELINE_PER_HOUR / 2);
const near = (a: number, b: number) => Math.abs(a - b) <= 0.02 * Math.abs(b);

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formats = new Map<string, Intl.DateTimeFormat>();

/** The weekday (0 = Sunday) and minutes since midnight at `t` in `timeZone`. */
export function localTime(t: number, timeZone: string): { day: number; minutes: number } {
  let f = formats.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formats.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { day: DAYS.indexOf(parts.weekday!), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function inSession(s: MarketSession, t: number): boolean {
  const { day, minutes } = localTime(t, s.timeZone);
  if (day < 1 || day > 5 || minutes < minutesOf(s.open) || minutes >= minutesOf(s.close)) return false;
  return !(s.breaks ?? []).some((b) => minutes >= minutesOf(b.from) && minutes < minutesOf(b.to));
}

/** True from Friday `close` to Sunday `open` in the zone given (the futures and FX weekend). */
export function inTraditionalWeekend(w: QualityConfig['traditionalWeekend'], t: number): boolean {
  const { day, minutes } = localTime(t, w.timeZone);
  return (day === 5 && minutes >= minutesOf(w.close)) || day === 6 || (day === 0 && minutes < minutesOf(w.open));
}

export interface QualityInput {
  now: number;
  /** Every leg read this scan, before filterLegs: quiet pins and stock-perp names come from the whole listing. */
  listed: readonly ScanLeg[];
  /** The legs filterLegs kept: the readings compared with each other. */
  kept: readonly ScanLeg[];
  /** What filterLegs dropped: a leg dropped as a duplicate or a mark outlier is another asset, and says nothing. */
  dropped: readonly LegDrop[];
  /** The mark check of filterLegs: a stock listing names a leg's market only if their marks agree this closely. */
  maxMarkDeviation: number;
  /** Whether a venue publishes funding history the scanner reads. */
  hasHistory: (venue: ScanVenueId) => boolean;
  config: QualityConfig;
}

/** A listing that says what kind of market a base is: a venue's stock-perp symbol, or a traditional-only venue's. */
interface Listing {
  leg: ScanLeg & { markPx: number };
  /** A stock or ETF: a venue's stock-perp symbol, or a traditional-only venue's equity. Else a commodity, index or FX. */
  stock: boolean;
}

/** The quality findings of one scan's legs; built once per scan, asked once per watch-only window. */
export class WatchQuality {
  readonly #input: QualityInput;
  readonly #byBase = new Map<string, ScanLeg[]>();
  readonly #pins = new Map<string, number>();
  /**
   * Base -> the listings that say what it is, stock-perp symbols first. A ticker is not a market: Bitget's
   * DASHSTOCKUSDT is DoorDash at 179 USD, not the Dash coin at 49, so a listing counts for a leg only when their
   * marks agree (#listing).
   */
  readonly #listings = new Map<string, Listing[]>();
  /** Base -> the median mark of its kept legs: what a leg without a mark of its own is compared at. */
  readonly #refMark = new Map<string, number>();
  readonly #weekend: boolean;
  readonly #findings = new Map<ScanLeg, string[]>();

  constructor(input: QualityInput) {
    this.#input = input;
    const { config, now } = input;
    for (const leg of input.kept) {
      const list = this.#byBase.get(leg.base);
      if (list === undefined) this.#byBase.set(leg.base, [leg]);
      else list.push(leg);
    }
    for (const [base, legs] of this.#byBase) {
      const marks = legs.map((l) => l.markPx).filter((m): m is number => m !== null);
      if (marks.length > 0) this.#refMark.set(base, median(marks));
    }
    // A venue's quiet pin: the one rate 10+ markets of a settlement group share, if it lies near the baseline (on a
    // weekend a venue's stock perps can make 0 its most common rate, which is not a pin).
    const counts = new Map<string, Map<number, number>>();
    for (const leg of input.listed) {
      const group = `${leg.venue}|${leg.settlement}`;
      const c = counts.get(group) ?? new Map<number, number>();
      c.set(leg.ratePerHour, (c.get(leg.ratePerHour) ?? 0) + 1);
      counts.set(group, c);
    }
    for (const [group, c] of counts) {
      const [rate, n] = [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
      if (n >= MIN_PINNED && rate >= 0.4 * BASELINE_PER_HOUR && rate <= 2.5 * BASELINE_PER_HOUR) this.#pins.set(group, rate);
    }
    // A listing filterLegs dropped as a duplicate (Bitget lists DASHUSDT and DASHSTOCKUSDT under one base) or a mark
    // outlier (hl-xyz's QNT, Quant Corp at 34 USD, against the Quant coin at 194) is another asset's.
    const otherAsset = new Set(input.dropped.filter((d) => d.reason === 'duplicate' || d.reason === 'mark-outlier').map((d) => `${d.venue}|${d.symbol}`));
    const add = (leg: ScanLeg, stock: boolean) => {
      if (leg.markPx === null || otherAsset.has(`${leg.venue}|${leg.symbol}`)) return;
      const list = this.#listings.get(leg.base) ?? [];
      list.push({ leg: { ...leg, markPx: leg.markPx }, stock });
      this.#listings.set(leg.base, list);
    };
    for (const leg of input.listed) {
      const m = config.equityMarkers[leg.venue]?.exec(leg.symbol);
      if (m?.[1] !== undefined && normalizeBase(m[1]).base === leg.base) add(leg, true);
    }
    // A traditional-only venue's listing of a stock or ETF names a stock too; its commodities, indices and FX do not.
    for (const leg of input.listed) {
      if (config.traditionalVenues.includes(leg.venue)) add(leg, !config.traditionalNonEquity.includes(leg.base));
    }
    this.#weekend = inTraditionalWeekend(config.traditionalWeekend, now);
  }

  /** The failing checks for a watch-only pair: each leg's findings, each line once (a closed market names the base). */
  checks(pair: Pair): FundingWindow['checks'] {
    const lines = [...this.legFindings(pair.long), ...this.legFindings(pair.short)];
    return [...new Set(lines)].map((text) => ({ ok: false, text }));
  }

  legFindings(leg: ScanLeg): string[] {
    let out = this.#findings.get(leg);
    if (out === undefined) {
      // A lone baseline reading is also unconfirmed: the more specific line stands alone.
      const lone = this.#loneBaseline(leg);
      out = [this.#thin(leg), this.#atCap(leg), lone ?? this.#unconfirmed(leg), this.#closed(leg)]
        .filter((x): x is string => x !== null);
      this.#findings.set(leg, out);
    }
    return out;
  }

  #thin(leg: ScanLeg): string | null {
    const min = this.#input.config.minVolume24hUsd;
    if (leg.volume24hUsd !== null) {
      return leg.volume24hUsd < min ? `Thin: ${venueName(leg.venue)} ${leg.symbol} traded ${usd(leg.volume24hUsd)} in 24 h, under the ${usd(min)} floor` : null;
    }
    // A leg without volume, open interest or a mark is a bare relayed rate: #unconfirmed judges that one.
    if (leg.oiUsd === null && leg.markPx !== null) return `Thin: ${venueName(leg.venue)} ${leg.symbol} publishes neither 24 h volume nor open interest: nothing shows it trades`;
    return null;
  }

  /**
   * One side of the limits a leg's rate is held to: the market's own where the venue's answer gives it, else the
   * sourced table. Each side stands alone: a venue may give a cap and no floor.
   */
  #limit(leg: ScanLeg, side: 'cap' | 'floor'): { perHour: number; whose: string } | null {
    const own = side === 'cap' ? leg.fundingCapPerHour : leg.fundingFloorPerHour;
    if (own !== undefined) return { perHour: own, whose: "its market's" };
    const v = this.#input.config.fundingLimits[leg.venue];
    const lim = v === undefined ? null : v.bySymbol?.[leg.symbol] ?? v.all;
    return lim === null ? null : { perHour: side === 'cap' ? lim.capPerHour : lim.floorPerHour, whose: "its venue's" };
  }

  #atCap(leg: ScanLeg): string | null {
    const r = leg.ratePerHour;
    const where = `${venueName(leg.venue)} ${leg.symbol}`;
    const cap = this.#limit(leg, 'cap');
    if (cap !== null && r >= cap.perHour * (1 - 1e-6)) return `At the cap: ${where} reads ${perHour(r)}, ${cap.whose} funding cap of ${perHour(cap.perHour)}`;
    const floor = this.#limit(leg, 'floor');
    if (floor !== null && r <= floor.perHour * (1 - 1e-6)) return `At the cap: ${where} reads ${perHour(r)}, ${floor.whose} funding floor of ${perHour(floor.perHour)}`;
    if (Math.abs(r) < FAR_PER_HOUR) return null;
    const venues = [...new Set((this.#byBase.get(leg.base) ?? []).filter((o) => sameRate(o.ratePerHour, r)).map((o) => o.venue))].sort();
    if (venues.length < MIN_SAME_RATE) return null;
    return `At the cap: ${venueNames(venues)} all read ${leg.base} at exactly ${perHour(r)}: ${venues.length} venues sharing one rate to the digit is a funding cap or floor, not the market's premium`;
  }

  #noData(leg: ScanLeg): boolean {
    return leg.markPx === null && leg.oiUsd === null && !this.#input.hasHistory(leg.venue);
  }

  #unconfirmed(leg: ScanLeg): string | null {
    if (!this.#noData(leg)) return null;
    const second = (this.#byBase.get(leg.base) ?? []).some((o) => o.venue !== leg.venue && !this.#noData(o) && agrees(o.ratePerHour, leg.ratePerHour));
    if (second) return null;
    return `Unconfirmed: ${venueName(leg.venue)} ${leg.symbol} has no mark, open interest or history of its own, and no venue with data of its own reads ${leg.base} near ${perHour(leg.ratePerHour)}`;
  }

  #atBaseline(leg: ScanLeg): boolean {
    const pin = this.#pins.get(`${leg.venue}|${leg.settlement}`);
    return near(leg.ratePerHour, BASELINE_PER_HOUR) || (pin !== undefined && near(leg.ratePerHour, pin));
  }

  #loneBaseline(leg: ScanLeg): string | null {
    // Only a relayed reading: a venue with a mark and open interest of its own that pins at the baseline does so
    // because its premium sits inside the clamp (Hyperliquid's TRX against negative CEX rates is real carry).
    if (!this.#noData(leg) || !this.#atBaseline(leg)) return null;
    const all = this.#byBase.get(leg.base) ?? [];
    const crowd = all.filter((o) => o.venue !== leg.venue && !this.#atBaseline(o)).map((o) => o.ratePerHour);
    if (crowd.length < MIN_CROWD) return null;
    const m = median(crowd);
    if (Math.abs(m) < FAR_PER_HOUR) return null;
    const agreeing = crowd.filter((r) => Math.sign(r) === Math.sign(m) && Math.abs(r) >= Math.abs(m) / 3 && Math.abs(r) <= 3 * Math.abs(m));
    const atBaseline = all.filter((o) => this.#atBaseline(o)).length;
    if (agreeing.length < MIN_CROWD || agreeing.length < 3 * atBaseline) return null;
    return `Lone baseline: ${venueName(leg.venue)} ${leg.symbol} reads the quiet ${perHour(leg.ratePerHour)} while ${agreeing.length} other venues agree near ${perHour(m)}: more likely a default than the market's rate`;
  }

  /**
   * The first listing of `leg`'s base, of the kind asked, whose mark agrees with the leg's own (or, for a leg without
   * one, with its base's median mark) within maxMarkDeviation; null when none does.
   */
  #listing(leg: ScanLeg, stock: boolean): Listing | null {
    const ref = leg.markPx ?? this.#refMark.get(leg.base) ?? null;
    if (ref === null) return null;
    const max = this.#input.maxMarkDeviation;
    return (this.#listings.get(leg.base) ?? []).find((l) => l.stock === stock && Math.abs(l.leg.markPx / ref - 1) <= max) ?? null;
  }

  #closed(leg: ScanLeg): string | null {
    const when = `${DAYS[new Date(this.#input.now).getUTCDay()]} ${new Date(this.#input.now).toISOString().slice(11, 16)} UTC`;
    const stock = this.#listing(leg, true);
    if (stock !== null) {
      const { config } = this.#input;
      const exchange = config.stockExchanges[config.stockExchangeOf[leg.base] ?? config.defaultStockExchange];
      if (exchange === undefined) throw new Error(`quality: no session for the exchange of ${leg.base}`);
      return inSession(exchange, this.#input.now)
        ? null
        : `Market closed: ${leg.base} is a stock perp (${venueName(stock.leg.venue)} ${stock.leg.symbol}) and ${exchange.name}, whose hours it keeps, is not in session at ${when}: its rates are not set by a live market`;
    }
    const traditional = this.#listing(leg, false);
    if (traditional !== null && this.#weekend) {
      return `Market closed: ${leg.base} is a commodity, index or FX market (${venueName(traditional.leg.venue)} ${traditional.leg.symbol}) and its futures are shut for the weekend at ${when}: its rates are not set by a live market`;
    }
    return null;
  }
}
