// The scanner: reads every venue's funding, pairs the same base across venues, prices each direction at the desk's
// leg size and ranks the windows. One scan is one call to scan(); the server calls it every 5 s.
//
// What a scan does, in order:
// 1. funding() of every reader at once; a reader that fails or times out is listed in ScanStatus.failed and its last
//    good read (if not older than dropAfterMs) is used, marked stale;
// 2. legs: one per venue and base, marks checked against the other venues; a watch leg needs the open-interest floor,
//    a desk leg at most deskMaxOiShare of its open interest (pairs.ts); the held window's legs are never dropped, they
//    fail a check instead;
// 3. pairs in both directions; kept: the held window whatever its sign; a watch pair with gross > 0 now; a desk pair in
//    the direction its multi-day spread pays (its 7- and 14-day means of one sign, the smaller of them; the 7 days
//    while the week before loads, or alone when it cannot be had), whatever this hour says, or with gross > 0 now
//    until its history is known; never one whose 7 and 14 days disagree in sign; a desk pair with a leg over its
//    share of the open interest only on a multi-day spread that pays its fees over the hold (carry.ts);
// 4. books of the desk legs those pairs need, read again once older than bookTtlMs (a failed read keeps the last
//    book, marked stale, and lists the venue as failed); a venue whose funding failed this scan is not asked for
//    books; a desk pair with no book ever read is left out;
// 5. each window priced (price.ts); the 7-day gross and intervalsAbove from the hourly rate store, which a few
//    public history reads per scan fill in the background (a scan never waits on them);
// 6. ranked: enterable windows, then the other desk windows, each by the spread expected over the hold minus the
//    round trip (carry.ts; windows without a multi-day figure after those with one, by net APR), then watch-only
//    windows by gross APR (their net is not complete), the best maxWatchWindows of them: within those, first the
//    windows whose legs pass every quality check (quality.ts), then the rest.

import type { ScanStatus, ScanVenueId, StrategyConfig, VenueId, Window as FundingWindow, WindowHistory } from '@gimbal/shared';
import type { Book, Clock, MarketFunding, MarketHistorySource, VenueReader, WatchReader } from '../venues/venue.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { ScannerConfig } from './config.ts';
import type { CarryEstimate, MultiDay } from './carry.ts';
import { carryChecks, carryEstimate, listingApr, multiDay, roundTrip, spreadOverHoldUsd } from './carry.ts';
import { HOURS_PER_YEAR, aprPct, basisCostUsd, fillFeeBps, takerFeesUsd } from './costs.ts';
import {
  FORTNIGHT_HOURS, HOUR_MS, RateStore, WEEK_HOURS, grossApr7d, grossAprOver, hourStart, intervalsAbove, legAprOver,
  netAprSeries, round,
} from './history.ts';
import type { DropReason, LegKind, Pair, ScanLeg } from './pairs.ts';
import { filterLegs, heldLegKeys, pairLegs, toLeg } from './pairs.ts';
import type { BookRead, CostBreakdown, OracleSource, PricedWindow, PricingContext } from './price.ts';
import { NO_BREAKEVEN_TEXT, isEnterable, priceWindow, switchCostUsd } from './price.ts';
import { WatchQuality } from './quality.ts';

export interface HeldWindow {
  windowId: string;
  since: number;                 // ms
}

export interface ScannerOptions {
  config: ScannerConfig;
  clock: Clock;
  /** The engine rules now (legUsd, maxLeverage, risk, minNetAprPct); read at the start of every scan. */
  strategy: () => StrategyConfig;
  /** The window the desk holds now, if any. */
  held?: () => HeldWindow | null;
  /**
   * The contract's stored oracle prices. The contract client provides them; without one (today) every priced desk leg
   * is refused E_ORACLE_STALE, as the contract would refuse it.
   */
  oracle?: OracleSource | null;
  /** Desk venues that already hold the desk's margin; default none (the desk keeps it in the reserve between holds). */
  marginHeldAt?: () => ReadonlySet<VenueId>;
  /** Where notes go (a failed read, a skipped book); default nowhere. */
  onNote?: (note: string) => void;
}

/** Diagnostics of one scan, for logs: never sent to the web. */
export interface ScanNotes {
  dropped: Partial<Record<DropReason, number>>;
  /** Desk pairs that could not be priced this scan, and why. */
  unpriced: { id: string; reason: string }[];
  /** History reads started this scan; they answer in the background. */
  historyReads: number;
  ms: number;
}

export interface ScanResult {
  windows: FundingWindow[];
  scan: ScanStatus;
  notes: ScanNotes;
}

interface Source {
  id: ScanVenueId;
  kind: LegKind;
  funding(): Promise<MarketFunding[]>;
  book?: (symbol: string, depth?: number) => Promise<Book>;
  history?: MarketHistorySource['marketFundingHistory'];
}

interface HistoryState {
  loadedHour: number | null;
  retryAt: number;
}

/** A desk pair's multi-day gross this scan (APR, rounded as shown), read once per scan. */
interface DeskHistory {
  d7: number | null;
  d14: number | null;
  m: MultiDay;
}

/** One leg of a desk window: the venue's rate now and its 7- and 14-day means, APR (> 0 means longs pay shorts). */
export interface LegRates {
  venue: ScanVenueId;
  symbol: string;
  nowAprPct: number;
  d7AprPct: number | null;
  d14AprPct: number | null;
  oiUsd: number | null;          // open interest in USD
}

/** What the last scan expects of a desk window over the hold, with the legs' rates behind it. */
export interface WindowCarry {
  estimate: CarryEstimate;
  long: LegRates;
  short: LegRates;
  breakdown: CostBreakdown;
}

/**
 * The second week of a desk leg's history is read once (its hours never change). A failed read is tried again after
 * historyRetryMs; after OLDER_MAX_TRIES failures in a row the leg's windows are judged on their 7 days alone, and the
 * read is still tried once every OLDER_RETRY_MS.
 */
const OLDER_MAX_TRIES = 3;
const OLDER_RETRY_MS = HOUR_MS;

interface OlderState {
  done: boolean;
  failures: number;
  retryAt: number;
}

const legKey = (leg: Pick<ScanLeg, 'venue' | 'symbol'>): string => `${leg.venue}|${leg.symbol}`;
/**
 * The rate store keeps each side of a leg apart: on GMX a short receives a different rate from what a long pays.
 * A history point carries one rate, which is both sides' on every venue that publishes history.
 */
const longSide = (leg: Pick<ScanLeg, 'venue' | 'symbol'>): string => legKey(leg);
const shortSide = (leg: Pick<ScanLeg, 'venue' | 'symbol'>): string => `${legKey(leg)}|short`;

/** `promise`, or a rejection after `ms`; the timer never outlives the race. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Runs `tasks` with at most `limit` in flight; results in task order. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

export class Scanner {
  readonly #sources: Source[];
  readonly #options: ScannerOptions;
  readonly #lastGood = new Map<ScanVenueId, { rows: MarketFunding[]; at: number }>();
  readonly #books = new Map<string, BookRead>();
  readonly #rates = new RateStore();
  readonly #history = new Map<string, HistoryState>();
  readonly #older = new Map<string, OlderState>();
  #carry = new Map<string, WindowCarry>();
  readonly #inFlight = new Map<string, Promise<unknown>>();
  #historyRun: Promise<void> | null = null;
  #priced = new Map<string, PricedWindow>();
  #lastAt = 0;

  constructor(venues: readonly VenueReader[], watch: readonly WatchReader[], options: ScannerOptions) {
    const ids = new Set<string>();
    const sources: Source[] = [];
    for (const v of venues) {
      const history = (v as VenueReader & Partial<MarketHistorySource>).marketFundingHistory;
      sources.push({
        id: v.id, kind: 'desk', funding: () => v.funding(), book: (s, d) => v.book(s, d),
        ...(typeof history === 'function' ? { history: history.bind(v) } : {}),
      });
    }
    for (const w of watch) {
      const history = (w as WatchReader & Partial<MarketHistorySource>).marketFundingHistory;
      sources.push({
        id: w.id, kind: w.kind, funding: () => w.funding(),
        ...(typeof history === 'function' ? { history: history.bind(w) } : {}),
      });
    }
    for (const s of sources) {
      if (ids.has(s.id)) throw new Error(`scanner: two readers for ${s.id}`);
      ids.add(s.id);
    }
    this.#sources = sources;
    this.#options = options;
  }

  get venueCount(): number {
    return this.#sources.length;
  }

  async scan(): Promise<ScanResult> {
    const { config, clock } = this.#options;
    const started = Date.now();
    const now = clock.now();
    // A wall clock can step back (an NTP correction). Throwing would stop every scan until it caught up; instead
    // this scan reads books and watch venues again (their read times are now in the future, so their age would be
    // negative) and leaves the hourly history alone, whose hours it would otherwise write out of order.
    const steppedBack = now < this.#lastAt;
    if (steppedBack) {
      this.#note(`the clock went back ${this.#lastAt - now} ms: books and watch venues read again, history left alone this scan`);
      for (const [key, st] of this.#history) {
        if (st.retryAt > now + config.historyRetryMs) this.#history.set(key, { ...st, retryAt: 0 });
      }
    }
    this.#lastAt = now;
    const strategy = this.#options.strategy();
    const heldNow = this.#options.held?.() ?? null;
    const heldId = heldNow?.windowId ?? null;
    const failed = new Set<ScanVenueId>();

    // 1. funding
    const reads = await Promise.all(this.#sources.map(async (s) => {
      // A watch-only venue is read every watchIntervalMs, not every scan: its rates are reference only, and some
      // of these public APIs rate-limit a 5 s poll. Between reads its last answer stands, dated when it was read.
      const recent = this.#lastGood.get(s.id);
      if (s.kind !== 'desk' && recent !== undefined && now >= recent.at && now - recent.at < config.watchIntervalMs) {
        return { source: s, rows: recent.rows, at: recent.at, stale: false };
      }
      try {
        const rows = await withTimeout(this.#once(`funding ${s.id}`, () => s.funding()), config.readTimeoutMs, `${s.id} funding`);
        if (!Array.isArray(rows)) throw new Error(`${s.id} funding: not a list`);
        this.#lastGood.set(s.id, { rows, at: now });
        return { source: s, rows, at: now, stale: false };
      } catch (err) {
        failed.add(s.id);
        this.#note(`${s.id} funding failed: ${errorMessage(err)}`);
        const last = this.#lastGood.get(s.id);
        if (last === undefined || now - last.at > config.dropAfterMs) return null;
        return { source: s, rows: last.rows, at: last.at, stale: true };
      }
    }));
    const fundingFailed = new Set(failed);

    // 2. legs
    const legs: ScanLeg[] = [];
    for (const r of reads) {
      if (r === null) continue;
      for (const row of r.rows) {
        // A reader answers for itself: a row naming another venue is not trusted to be that venue's.
        if (row.venue !== r.source.id) continue;
        const leg = toLeg(row, r.source.kind, r.at, r.stale);
        if (leg !== null) legs.push(leg);
      }
    }
    const filter = {
      oiFloorUsd: config.oiFloorUsd, maxMarkDeviation: config.maxMarkDeviation, deskLegUsd: strategy.legUsd, deskMaxOiShare: config.deskMaxOiShare,
    };
    const { kept, dropped } = filterLegs(legs, filter, heldLegKeys(legs, heldId));
    const sourceById = new Map(this.#sources.map((s) => [s.id, s]));
    const quality = new WatchQuality({
      now, listed: legs, kept, dropped, maxMarkDeviation: config.maxMarkDeviation, config: config.quality,
      hasHistory: (v) => sourceById.get(v)?.history !== undefined,
    });
    const droppedCount: ScanNotes['dropped'] = {};
    for (const d of dropped) droppedCount[d.reason] = (droppedCount[d.reason] ?? 0) + 1;

    // 3. pairs. A desk pair's multi-day figure is read once here and used for its listing, its gate and its rank.
    const all = pairLegs(kept, heldId);
    const multi = new Map<string, DeskHistory>();
    for (const p of all) if (p.desk) multi.set(p.id, this.#deskHistory(p, now));
    const pairs = all.filter((p) => this.#listed(p, heldId, multi.get(p.id) ?? null, strategy.legUsd));

    // 4. books
    const wanted = new Map<string, ScanLeg>();
    for (const p of pairs) if (p.desk) for (const leg of [p.long, p.short]) wanted.set(legKey(leg), leg);
    const skipped = new Set<ScanVenueId>();
    const due = [...wanted.entries()].filter(([key, leg]) => {
      const b = this.#books.get(key);
      if (!(b === undefined || b.stale || b.readAt > now || now - b.readAt >= config.bookTtlMs)) return false;
      // A venue that did not answer for funding is likely down: its book reads would only hold the scan up.
      if (fundingFailed.has(leg.venue)) {
        skipped.add(leg.venue);
        return false;
      }
      return true;
    });
    for (const v of skipped) this.#note(`${v} books not read: its funding read failed this scan`);
    await pool(due.map(([key, leg]) => async () => {
      const src = sourceById.get(leg.venue);
      if (src?.book === undefined) return;
      try {
        const read = this.#once(`book ${key}`, () => src.book!(leg.symbol, config.bookDepth));
        const book = await withTimeout(read, config.bookTimeoutMs, `${leg.venue} book ${leg.symbol}`);
        // Dated when it answered: a book read late in a slow scan is that much younger than the scan's start.
        this.#books.set(key, { book, readAt: clock.now(), stale: false });
      } catch (err) {
        failed.add(leg.venue);
        this.#note(`${leg.venue} book ${leg.symbol} failed: ${errorMessage(err)}`);
        const last = this.#books.get(key);
        if (last !== undefined) {
          if (now - last.readAt > config.dropAfterMs) this.#books.delete(key);
          else this.#books.set(key, { ...last, stale: true });
        }
      }
    }), 6);

    // 5. price
    const ctx: PricingContext = {
      now,
      strategy,
      costs: config.costs,
      policy: config.policy,
      oracle: this.#options.oracle ?? null,
      book: (leg: ScanLeg) => this.#books.get(legKey(leg)) ?? null,
      marginHeldAt: this.#options.marginHeldAt?.() ?? new Set(),
      quality: (pair) => quality.checks(pair),
    };
    const priced: PricedWindow[] = [];
    const unpriced: ScanNotes['unpriced'] = [];
    for (const p of pairs) {
      const r = priceWindow(p, ctx);
      if (r.ok) priced.push(r.priced);
      else unpriced.push({ id: p.id, reason: `${r.reason} on ${r.venue}` });
    }

    // History: the scanner's own reads count for this hour; a few public history reads per scan fill the week.
    let historyReads = 0;
    if (!steppedBack) {
      for (const pw of priced) {
        for (const leg of [pw.pair.long, pw.pair.short]) {
          this.#rates.recordLive(longSide(leg), now, leg.ratePerHour);
          this.#rates.recordLive(shortSide(leg), now, leg.shortRatePerHour);
        }
      }
      historyReads = this.#loadHistory(priced, all.filter((p) => p.desk), now);
    }
    this.#rates.prune(now);

    const carry = new Map<string, WindowCarry>();
    for (const pw of priced) {
      const w = pw.window;
      const longKey = longSide(pw.pair.long);
      const shortKey = shortSide(pw.pair.short);
      const dh = pw.pair.desk ? multi.get(pw.pair.id) : undefined;
      if (dh === undefined) {
        const g7 = grossApr7d(this.#rates, longKey, shortKey, now);
        w.grossApr7dPct = g7 === null ? null : round(g7, 3);
      } else {
        w.grossApr7dPct = dh.d7;
      }
      w.intervalsAbove = intervalsAbove(this.#rates, longKey, shortKey, now, w.grossAprPct, pw.costsApr, strategy.minNetAprPct);
      if (dh === undefined) continue;
      const b = pw.breakdown;
      const rt = roundTrip(strategy.legUsd, b.feesUsd ?? 0, b.slippageUsd ?? 0, b.basisUsd ?? 0, b.timingUsd, config.costs.basisBufferBps);
      const estimate = carryEstimate({
        legUsd: strategy.legUsd, holdHours: config.costs.holdHours, grossNowAprPct: w.grossAprPct,
        gross7dAprPct: dh.d7, gross14dAprPct: dh.d14, multiDay: dh.m, roundTrip: rt, minNetAprPct: strategy.minNetAprPct,
      });
      w.checks.push(...carryChecks(estimate));
      // Once the multi-day spread is known, the window's net APR is that spread minus its costs, so the list, the
      // owner's minimum and the rotation rule all compare days of funding, never one hour's swing.
      if (estimate.expectedAprPct !== null) {
        w.netAprPct = round(estimate.expectedAprPct - pw.costsApr, 3);
        w.usdPerDayPer1k = round((w.netAprPct / 100 / 365) * 1000, 4);
      }
      // Break-even on the same multi-day spread as the gate, against the same round trip (the 1Click margin moves and
      // the rescue reserve are shown apart, never gated on): this hour alone says little about a hold of days.
      if (estimate.expectedAprPct !== null) {
        const days = estimate.breakevenDays;
        const hours = days === null ? null : days * 24;
        w.checks = w.checks.filter((c) => c.text !== NO_BREAKEVEN_TEXT);
        if (hours === null || hours > HOURS_PER_YEAR) {
          const label = estimate.basis === '14d' ? '14-day' : '7-day';
          w.checks.push({ ok: false, text: `Does not break even within a year on its ${label} spread` });
        }
        w.breakevenHours = hours === null ? HOURS_PER_YEAR : round(Math.min(hours, HOURS_PER_YEAR), 1);
      }
      carry.set(pw.pair.id, {
        estimate, breakdown: b,
        long: this.#legRates(pw.pair.long, longKey, pw.pair.long.ratePerHour, now),
        short: this.#legRates(pw.pair.short, shortKey, pw.pair.short.shortRatePerHour, now),
      });
    }
    this.#carry = carry;

    const heldPriced = heldNow === null ? undefined : priced.find((pw) => pw.pair.id === heldNow.windowId);
    if (heldNow !== null && heldPriced !== undefined) heldPriced.window.held = { since: heldNow.since };
    if (heldPriced !== undefined) {
      for (const pw of priced) {
        if (pw === heldPriced || !pw.pair.desk) continue;
        pw.window.switchCostUsd = switchCostUsd(heldPriced, pw);
      }
    }

    // 6. rank
    const byId = (a: PricedWindow, b: PricedWindow) => (a.pair.id < b.pair.id ? -1 : a.pair.id > b.pair.id ? 1 : 0);
    const byNet = (a: PricedWindow, b: PricedWindow) => b.window.netAprPct - a.window.netAprPct || byId(a, b);
    // A desk window with a multi-day average ranks by what it is expected to earn over the hold, net of the round
    // trip; one still without (its history loading) follows, by net APR.
    const byCarry = (a: PricedWindow, b: PricedWindow) => {
      const x = carry.get(a.pair.id)?.estimate.netUsd ?? null;
      const y = carry.get(b.pair.id)?.estimate.netUsd ?? null;
      if (x !== null && y !== null) return y - x || byNet(a, b);
      if (x !== null || y !== null) return x !== null ? -1 : 1;
      return byNet(a, b);
    };
    const enterable = priced.filter((pw) => isEnterable(pw.window)).sort(byCarry);
    const deskOther = priced.filter((pw) => pw.pair.desk && !isEnterable(pw.window)).sort(byCarry);
    // The watch windows sent are the maxWatchWindows best by gross, whatever their checks say: a finding ranks a
    // window, it never keeps it from the reader. Inside that cut a window with a quality finding (a thin leg, a capped
    // or unconfirmed rate, a closed market) never leads a clean one, however large its gross.
    const byGross = (a: PricedWindow, b: PricedWindow) => b.window.grossAprPct - a.window.grossAprPct || byId(a, b);
    const watch = priced.filter((pw) => !pw.pair.desk).sort(byGross).slice(0, config.maxWatchWindows)
      .sort((a, b) => Number(a.flagged) - Number(b.flagged) || byGross(a, b));
    const ranked = [...enterable, ...deskOther, ...watch];
    this.#priced = new Map(ranked.map((pw) => [pw.pair.id, pw]));

    return {
      windows: ranked.map((pw) => pw.window),
      scan: { venues: this.#sources.length, failed: [...failed].sort(), at: now },
      notes: { dropped: droppedCount, unpriced, historyReads, ms: Date.now() - started },
    };
  }

  /** Hourly net APR of a window over the last 7 days (today's costs), or null when the last scan did not list it. */
  history(windowId: string): WindowHistory | null {
    const pw = this.#priced.get(windowId);
    if (pw === undefined) return null;
    const points = netAprSeries(this.#rates, longSide(pw.pair.long), shortSide(pw.pair.short), this.#lastAt, pw.window.grossAprPct, pw.costsApr);
    return { windowId, points };
  }

  /** The expected carry of a desk window the last scan listed, with its legs' rates; null for any other id. */
  carry(windowId: string): WindowCarry | null {
    return this.#carry.get(windowId) ?? null;
  }

  /**
   * Whether a pair is listed this scan (step 3). A desk pair goes by its multi-day spread, so the direction shown is
   * the one that has paid over days, not the one this hour happens to favour; the reverse direction's average is
   * this one's negative, so at most one of the two is listed once history is in.
   */
  #listed(p: Pair, heldId: string | null, dh: DeskHistory | null, legUsd: number): boolean {
    if (p.id === heldId) return true;
    if (!p.desk || dh === null) return p.grossPerHour > 0;
    const thin = p.long.deskOnly !== undefined || p.short.deskOnly !== undefined;
    if (dh.m.state === 'mixed') return false;
    const m = listingApr(dh.m);
    if (m === null) return !thin && p.grossPerHour > 0;
    if (!(m > 0)) return false;
    if (!thin) return true;
    // A leg over its share of the open interest has its book read only when its spread can pay what is known before
    // any book: the fees on the 4 fills, the adverse gap between the marks and the exit buffer.
    const c = this.#options.config.costs;
    const fees = takerFeesUsd(legUsd, fillFeeBps(c.fees[p.long.venue as VenueId]), fillFeeBps(c.fees[p.short.venue as VenueId]));
    const gap = p.long.markPx !== null && p.short.markPx !== null ? basisCostUsd(p.long.markPx, p.short.markPx, legUsd) : 0;
    return spreadOverHoldUsd(m, legUsd, c.holdHours) > fees + gap + (legUsd * c.basisBufferBps) / 1e4;
  }

  /** A desk pair's 7- and 14-day gross in its direction this scan, and what they say (carry.ts multiDay). */
  #deskHistory(p: Pair, now: number): DeskHistory {
    const longKey = longSide(p.long);
    const shortKey = shortSide(p.short);
    const g7 = grossAprOver(this.#rates, longKey, shortKey, now, WEEK_HOURS);
    const g14 = grossAprOver(this.#rates, longKey, shortKey, now, FORTNIGHT_HOURS);
    const d7 = g7 === null ? null : round(g7, 3);
    const d14 = g14 === null ? null : round(g14, 3);
    return { d7, d14, m: multiDay(d7, d14, this.#fortnightPending(p.long) || this.#fortnightPending(p.short)) };
  }

  /**
   * Whether a leg's 14-day mean may still come: its venue publishes history and the older read has neither answered
   * nor failed OLDER_MAX_TRIES times. Once it answered, a 14-day mean still missing means the market is younger.
   */
  #fortnightPending(leg: ScanLeg): boolean {
    if (this.#sources.find((s) => s.id === leg.venue)?.history === undefined) return false;
    const o = this.#older.get(legKey(leg));
    return o === undefined || (!o.done && o.failures < OLDER_MAX_TRIES);
  }

  #legRates(leg: ScanLeg, key: string, ratePerHour: number, now: number): LegRates {
    const d7 = legAprOver(this.#rates, key, now, WEEK_HOURS);
    const d14 = legAprOver(this.#rates, key, now, FORTNIGHT_HOURS);
    return {
      venue: leg.venue, symbol: leg.symbol, nowAprPct: round(aprPct(ratePerHour), 3),
      d7AprPct: d7 === null ? null : round(d7, 3), d14AprPct: d14 === null ? null : round(d14, 3), oiUsd: leg.oiUsd,
    };
  }

  /** Resolves once the history reads started so far have answered or failed. */
  async idle(): Promise<void> {
    while (this.#historyRun !== null) await this.#historyRun;
  }

  /**
   * Starts public funding history reads for the legs that need them, in the background: the listed desk windows'
   * legs first (best net first), then the legs of every other desk pair (a pair whose direction or listing waits on
   * its history), then the watch windows', at most historyPerScan reads, and no new batch while one is still out (a
   * slow venue never has reads piling up). A leg is read again once a new hour has begun (and a minute has passed, so
   * the venue has booked it); the window asked for is aligned to the hour, so a replay asks exactly what the
   * recording asked. Once a desk leg's week is in, the week before it is read once too, for the 14-day average. Until
   * a leg's history arrives its windows show grossApr7dPct null. Returns how many reads it started.
   */
  #loadHistory(priced: readonly PricedWindow[], deskPairs: readonly Pair[], now: number): number {
    if (this.#historyRun !== null) return 0;
    const { config } = this.#options;
    const current = hourStart(now);
    const order = [...priced].sort((a, b) => Number(b.pair.desk) - Number(a.pair.desk) || b.window.netAprPct - a.window.netAprPct);
    const legs: ScanLeg[] = [];
    for (const pw of order) if (pw.pair.desk) legs.push(pw.pair.long, pw.pair.short);
    for (const p of deskPairs) legs.push(p.long, p.short);
    for (const pw of order) if (!pw.pair.desk) legs.push(pw.pair.long, pw.pair.short);
    const unique: { leg: ScanLeg; src: Source }[] = [];
    const seen = new Set<string>();
    for (const leg of legs) {
      const key = legKey(leg);
      if (seen.has(key)) continue;
      seen.add(key);
      const src = this.#sources.find((s) => s.id === leg.venue);
      if (src?.history !== undefined) unique.push({ leg, src });
    }
    const todo: { leg: ScanLeg; src: Source; older: boolean }[] = [];
    for (const { leg, src } of unique) {
      if (todo.length >= config.historyPerScan) break;
      const st = this.#history.get(legKey(leg));
      if (st !== undefined && (st.loadedHour === current || now < st.retryAt)) continue;
      if (st !== undefined && st.loadedHour !== null && now - current < 60_000) continue;
      todo.push({ leg, src, older: false });
    }
    for (const { leg, src } of unique) {
      if (todo.length >= config.historyPerScan) break;
      if (leg.kind !== 'desk' || todo.some((t) => t.leg === leg)) continue;
      const key = legKey(leg);
      if ((this.#history.get(key)?.loadedHour ?? null) === null) continue;
      const o = this.#older.get(key);
      if (o !== undefined && (o.done || now < o.retryAt)) continue;
      todo.push({ leg, src, older: true });
    }
    if (todo.length === 0) return 0;
    // From 8 h before the week (Orderly's 8 h prints cover the hours before them) to the end of the current hour; for
    // the older read, the week before that, overlapping it by 8 h.
    const start = current - (WEEK_HOURS + 8) * HOUR_MS;
    const end = current + HOUR_MS - 1;
    const olderStart = current - (FORTNIGHT_HOURS + 8) * HOUR_MS;
    const olderEnd = current - WEEK_HOURS * HOUR_MS;
    const run: Promise<void> = pool(todo.map(({ leg, src, older }) => async () => {
      const key = legKey(leg);
      const what = `${leg.venue} ${older ? 'older history' : 'history'} ${leg.symbol}`;
      try {
        const points = await withTimeout(src.history!(leg.symbol, older ? olderStart : start, older ? olderEnd : end), config.readTimeoutMs * 2, what);
        this.#rates.recordBooked(longSide(leg), points);
        this.#rates.recordBooked(shortSide(leg), points);
        if (older) this.#older.set(key, { done: true, failures: 0, retryAt: 0 });
        else this.#history.set(key, { loadedHour: current, retryAt: 0 });
      } catch (err) {
        this.#note(`${what} failed: ${errorMessage(err)}`);
        if (older) {
          const failures = (this.#older.get(key)?.failures ?? 0) + 1;
          this.#older.set(key, { done: false, failures, retryAt: now + (failures < OLDER_MAX_TRIES ? config.historyRetryMs : OLDER_RETRY_MS) });
        } else {
          const st = this.#history.get(key);
          this.#history.set(key, { loadedHour: st?.loadedHour ?? null, retryAt: now + config.historyRetryMs });
        }
      }
    }), 2).then(() => {
      if (this.#historyRun === run) this.#historyRun = null;
    });
    this.#historyRun = run;
    return todo.length;
  }

  /**
   * The read still running for `key`, or a new one. A read that outlived its scan's timeout is waited on again by
   * the next scan instead of being asked a second time, so a slow venue never has requests piling up.
   */
  #once<T>(key: string, start: () => Promise<T>): Promise<T> {
    const running = this.#inFlight.get(key);
    if (running !== undefined) return running as Promise<T>;
    const p = start().finally(() => this.#inFlight.delete(key));
    // The rejection is handled by the caller that awaits it; this copy only keeps an unawaited one quiet.
    p.catch(() => {});
    this.#inFlight.set(key, p);
    return p;
  }

  #note(note: string): void {
    this.#options.onNote?.(note);
  }
}
