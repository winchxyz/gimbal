// The scanner: reads every venue's funding, pairs the same base across venues, prices each direction at the desk's
// leg size and ranks the windows. One scan is one call to scan(); the server calls it every 5 s.
//
// What a scan does, in order:
// 1. funding() of every reader at once; a reader that fails or times out is listed in ScanStatus.failed and its last
//    good read (if not older than dropAfterMs) is used, marked stale; a reader that answers with rates from an
//    earlier read (rateReadAt: its refresh of them failed) is used marked stale too, dated that read, and noted;
// 2. legs: one per venue and base, marks checked against the other venues; a watch leg needs the open-interest floor,
//    a desk leg at most deskMaxOiShare of its open interest (pairs.ts); the held window's legs are never dropped, they
//    fail a check instead;
// 3. pairs in both directions; kept: the held window whatever its sign; a watch pair with gross > 0 now; a desk pair in
//    the direction its multi-day spread pays (its 7- and 14-day means of one sign, the smaller of them; the 7 days
//    while the week before loads, or alone when it cannot be had), whatever this hour says, or with gross > 0 now
//    until its history is known; never one whose 7 and 14 days disagree in sign; a desk pair with a leg over its
//    share of the open interest only on a multi-day spread that pays its fees over the hold (carry.ts);
// 4. books of the desk legs those pairs need, read again once older than bookTtlMs, or offDeskBookTtlMs for a leg that
//    is neither the held window's nor a market of the desk's policy (a failed read keeps the last book, marked stale,
//    and lists the venue as failed); a venue whose funding failed this scan is not asked for
//    books; a desk pair with no book ever read is left out. They are asked for in order: the held window's legs, the
//    policy's markets, then the other legs by the gross funding of their best pair, so that a venue's request budget
//    (venues/http-budget.ts: Phoenix) goes to them first. A read the budget skips is not sent and its last book is
//    stale (the numbers are from the last good read, so its windows cannot be entered on it); in a cool-down after a
//    429 the venue also counts as failed, while a skip because only this scan's budget is spent does not. Either way
//    the venue's other books wait for the next scan;
// 5. each window priced (price.ts); the 7-day gross and intervalsAbove from the hourly rate store, which a few
//    public history reads per scan fill in the background (a scan never waits on them);
// 6. ranked: enterable windows, then the other desk windows, each by the spread expected over the hold minus the
//    round trip (carry.ts; windows without a multi-day figure after those with one, by net APR), then watch-only
//    windows by gross APR (their net is not complete), the best maxWatchWindows of them: within those, first the
//    windows whose legs pass every quality check (quality.ts), then the rest.

import type {
  ContractPolicy, ScanStatus, ScanVenueId, StrategyConfig, VenueId, Window as FundingWindow, WindowHistory,
} from '@gimbal/shared';
import type { Book, Clock, MarketFunding, MarketHistorySource, VenueReader, WatchReader } from '../venues/venue.ts';
import type { ReadSkipped } from '../venues/http-budget.ts';
import { isReadSkipped, scanRead } from '../venues/http-budget.ts';
import { venueName } from '../venues/names.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { ScannerConfig } from './config.ts';
import type { CarryEstimate, MultiDay } from './carry.ts';
import { DEAD_BAND_APR_PCT, carryChecks, carryEstimate, listingApr, multiDay, roundTrip, spreadOverHoldUsd } from './carry.ts';
import { HOURS_PER_YEAR, aprPct, basisCostUsd, fillFeeBps, oneOffAprPct, takerFeesUsd } from './costs.ts';
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
  /** Prints the last week read answered with. */
  points: number;
}

/** A desk pair's multi-day gross this scan (APR, rounded as shown), read once per scan. */
interface DeskHistory {
  d7: number | null;
  d14: number | null;
  m: MultiDay;
  /** Why no 14-day mean is coming, when none is: said on the 7-day line. */
  why: string | null;
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
 * historyRetryMs, doubling up to OLDER_RETRY_MAX_MS, and is still tried after it has failed for good, in case it
 * answers. It fails for good, and the leg's windows are judged on their 7 days alone, saying why, when the venue has
 * refused it (an HTTP 4xx other than 408 and 429) without a break for OLDER_REFUSED_MS, or when it has failed in any
 * way (5xx, network, timeout, 429) for OLDER_FAILING_MS: a burst of 429s at startup never lets a window in on 7 days.
 */
const OLDER_REFUSED_MS = HOUR_MS;
const OLDER_FAILING_MS = 24 * HOUR_MS;
const OLDER_RETRY_MAX_MS = 15 * 60_000;

interface OlderState {
  done: boolean;
  failures: number;
  /** Since when the venue has refused it, with no other failure or any successful read of the leg since; else null. */
  refusedSince: number | null;
  /** Since when it has failed, in any way; null once it answers. */
  failingSince: number | null;
  /** Why it failed for good: judged on 7 days until the read answers. */
  givenUp: 'refused' | 'failing' | null;
  retryAt: number;
}

/** The venue saying no: an HTTP status 4xx other than 408 (timeout) and 429 (rate limit). Anything else may pass. */
export function isRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const legKey = (leg: Pick<ScanLeg, 'venue' | 'symbol'>): string => `${leg.venue}|${leg.symbol}`;

/** A desk leg whose book a listed pair needs: tier 0 the held window's, 1 a policy market, 2 the rest. */
interface BookWant {
  key: string;
  leg: ScanLeg;
  tier: number;
  /** The largest |gross per hour| of a listed pair it is a leg of. */
  gross: number;
}

/** The leg keys (venue|symbol) of the markets the desk's policy allows, on each desk venue. */
function policyLegKeys(policy: ContractPolicy | null): Set<string> {
  if (policy === null) return new Set();
  return new Set([
    ...policy.hl_assets.map((a) => legKey({ venue: 'hyperliquid', symbol: a.symbol })),
    ...policy.phoenix_markets.map((m) => legKey({ venue: 'phoenix', symbol: m.symbol })),
    ...policy.orderly_symbols.map((s) => legKey({ venue: 'orderly', symbol: s })),
  ]);
}

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
      for (const [key, o] of this.#older) {
        // A wait or a give-up clock dated in the future: from now instead, so none outlasts what it was meant to.
        this.#older.set(key, {
          ...o,
          retryAt: o.retryAt > now + OLDER_RETRY_MAX_MS ? 0 : o.retryAt,
          refusedSince: o.refusedSince !== null && o.refusedSince > now ? now : o.refusedSince,
          failingSince: o.failingSince !== null && o.failingSince > now ? now : o.failingSince,
        });
      }
    }
    // A jump forward of an hour or more (a machine waking from sleep) is no evidence the venue kept failing: the
    // older reads' give-up clocks start again from now.
    if (this.#lastAt > 0 && now - this.#lastAt >= HOUR_MS) {
      this.#note(`the clock went forward ${Math.round((now - this.#lastAt) / 60_000)} min: the older history reads' give-up clocks start again`);
      for (const [key, o] of this.#older) {
        if (o.done || o.givenUp !== null) continue;
        this.#older.set(key, {
          ...o, refusedSince: o.refusedSince === null ? null : now, failingSince: o.failingSince === null ? null : now,
        });
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
        const rows = await withTimeout(this.#once(`funding ${s.id}`, () => scanRead(() => s.funding())), config.readTimeoutMs, `${s.id} funding`);
        if (!Array.isArray(rows)) throw new Error(`${s.id} funding: not a list`);
        // Rates the venue could not refresh: the answer is as old as its oldest rate, and stale.
        const ratesAt = rows.reduce((m: number, r: MarketFunding) => (typeof r.rateReadAt === 'number' && Number.isFinite(r.rateReadAt) ? Math.min(m, r.rateReadAt) : m), Infinity);
        const at = Math.min(now, ratesAt);
        this.#lastGood.set(s.id, { rows, at });
        if (ratesAt === Infinity) return { source: s, rows, at, stale: false };
        this.#note(`${s.id} funding: the rates are from ${Math.max(0, Math.round((now - at) / 1000))} s ago, its refresh of them failed`);
        return { source: s, rows, at, stale: true };
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

    // 4. books, the ones that matter first: the held window's legs, the policy's markets, then by gross funding.
    const wanted = new Map<string, BookWant>();
    const policyLegs = policyLegKeys(config.policy);
    for (const p of pairs) {
      if (!p.desk) continue;
      for (const leg of [p.long, p.short]) {
        const key = legKey(leg);
        const tier = p.id === heldId ? 0 : policyLegs.has(key) ? 1 : 2;
        const gross = Math.abs(p.grossPerHour);
        const w = wanted.get(key);
        if (w === undefined) wanted.set(key, { key, leg, tier, gross });
        else wanted.set(key, { ...w, tier: Math.min(w.tier, tier), gross: Math.max(w.gross, gross) });
      }
    }
    const skipped = new Set<ScanVenueId>();
    const due = [...wanted.values()].filter((w) => {
      const { key, leg } = w;
      const b = this.#books.get(key);
      // Without a policy (no desk yet, replay without one) every leg counts as the desk's.
      const offDesk = config.policy !== null && w.tier === 2;
      const ttl = offDesk ? Math.max(config.bookTtlMs, config.offDeskBookTtlMs) : config.bookTtlMs;
      if (!(b === undefined || b.stale || b.readAt > now || now - b.readAt >= ttl)) return false;
      // A venue that did not answer for funding is likely down: its book reads would only hold the scan up.
      if (fundingFailed.has(leg.venue)) {
        skipped.add(leg.venue);
        return false;
      }
      return true;
    }).sort((a, b) => a.tier - b.tier || b.gross - a.gross || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const v of skipped) this.#note(`${v} books not read: its funding read failed this scan`);
    // The first read a venue's budget skips this scan; its later books are not asked for until the next scan.
    const deferred = new Map<ScanVenueId, { first: ReadSkipped; count: number }>();
    const defer = (w: BookWant, why: ReadSkipped) => {
      const d = deferred.get(w.leg.venue);
      if (d === undefined) deferred.set(w.leg.venue, { first: why, count: 1 });
      else d.count++;
      this.#deferBook(w.key, now);
    };
    await pool(due.map((w) => async () => {
      const { key, leg } = w;
      const src = sourceById.get(leg.venue);
      if (src?.book === undefined) return;
      const held = deferred.get(leg.venue);
      if (held !== undefined) return defer(w, held.first);
      try {
        const read = this.#once(`book ${key}`, () => scanRead(() => src.book!(leg.symbol, config.bookDepth)));
        const book = await withTimeout(read, config.bookTimeoutMs, `${leg.venue} book ${leg.symbol}`);
        // Dated when it answered: a book read late in a slow scan is that much younger than the scan's start.
        this.#books.set(key, { book, readAt: clock.now(), stale: false });
      } catch (err) {
        if (isReadSkipped(err)) return defer(w, err);
        failed.add(leg.venue);
        this.#note(`${leg.venue} book ${leg.symbol} failed: ${errorMessage(err)}`);
        const last = this.#books.get(key);
        if (last !== undefined) {
          if (now - last.readAt > config.dropAfterMs) this.#books.delete(key);
          else this.#books.set(key, { ...last, stale: true });
        }
      }
    }), 6);
    for (const [venue, d] of deferred) {
      // A cool-down means the venue refused us a moment ago: it did not answer this scan.
      if (d.first.reason === 'cooling') failed.add(venue);
      this.#note(`${venue} books: ${d.count} not read this scan (${d.first.message})`);
    }

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
      historyReads = this.#loadHistory(priced, all.filter((p) => p.desk), now, heldId);
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
      if (dh === undefined) {
        w.intervalsAbove = intervalsAbove(this.#rates, longKey, shortKey, now, w.grossAprPct, pw.costsApr, strategy.minNetAprPct);
        continue;
      }
      const b = pw.breakdown;
      const rt = roundTrip(strategy.legUsd, b.feesUsd ?? 0, b.slippageUsd ?? 0, b.basisUsd ?? 0, b.timingUsd, config.costs.basisBufferBps);
      const estimate = carryEstimate({
        legUsd: strategy.legUsd, holdHours: config.costs.holdHours, grossNowAprPct: w.grossAprPct,
        gross7dAprPct: dh.d7, gross14dAprPct: dh.d14, multiDay: dh.m, roundTrip: rt, minNetAprPct: strategy.minNetAprPct,
        noFortnightWhy: dh.why,
      });
      w.checks.push(...carryChecks(estimate));
      // Once its 7 days are in, a desk window's figures are days of funding against the round trip, the numbers the
      // gate holds to the owner's minimum: its costs are the round trip spread over the hold, and its net APR the
      // multi-day spread (the 7 days while the week before loads or when the two weeks disagree) minus them. So the
      // list, the minimum line and the rotation gap compare what the gate does, never one hour's swing. The margin
      // moves and the rescue reserve are one-off costs shown apart (the checks above, `npm run windows`).
      const basisApr = dh.m.state === 'mixed' ? dh.m.d7AprPct : listingApr(dh.m);
      if (basisApr !== null) {
        const apr = (usd: number) => round(oneOffAprPct(usd, strategy.legUsd, config.costs.holdHours), 3);
        w.costs = { feesPct: apr(rt.feesUsd), slippagePct: apr(rt.slippageUsd), basisPct: apr(rt.basisBufferUsd), rescueReservePct: 0 };
        pw.costsApr = round(w.costs.feesPct + w.costs.slippagePct + w.costs.basisPct, 3);
        w.netAprPct = round(basisApr - pw.costsApr, 3);
        w.usdPerDayPer1k = round((w.netAprPct / 100 / 365) * 1000, 4);
      }
      w.intervalsAbove = intervalsAbove(this.#rates, longKey, shortKey, now, w.grossAprPct, pw.costsApr, strategy.minNetAprPct);
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
    // The dead band too, so the 7 days shown and the check lines are what the pair was judged on.
    const d7 = g7 === null ? null : Math.abs(g7) < DEAD_BAND_APR_PCT ? 0 : round(g7, 3);
    const d14 = g14 === null ? null : round(g14, 3);
    const pending = this.#fortnightPending(p.long) || this.#fortnightPending(p.short);
    const why = d14 !== null || pending ? null : (this.#noFortnightWhy(p.long, now) ?? this.#noFortnightWhy(p.short, now));
    return { d7, d14, m: multiDay(d7, d14, pending), why };
  }

  /** Why a leg has no 14-day mean coming, or null when it may still come (or has come). */
  #noFortnightWhy(leg: ScanLeg, now: number): string | null {
    // A leg with its own 14 days is not the reason.
    if (legAprOver(this.#rates, longSide(leg), now, FORTNIGHT_HOURS) !== null) return null;
    const venue = venueName(leg.venue);
    if (this.#sources.find((s) => s.id === leg.venue)?.history === undefined) return `${venue} publishes no funding history`;
    if ((this.#history.get(legKey(leg))?.loadedHour ?? null) === null) return `${venue}'s week of history has not loaded`;
    const o = this.#older.get(legKey(leg));
    if (o === undefined) return null;
    if (o.done) return `${venue} ${leg.symbol} is younger than 14 days`;
    if (o.givenUp === 'refused') return `${venue} has refused the week before for an hour`;
    if (o.givenUp === 'failing') return `reading the week before from ${venue} has failed for 24 h`;
    return null;
  }

  /**
   * Whether a leg's 14-day mean may still come: its venue publishes history, its week has loaded, and the older read
   * has neither answered nor failed for good. Once it answered, a 14-day mean still missing means the market is
   * younger.
   */
  #fortnightPending(leg: ScanLeg): boolean {
    if (this.#sources.find((s) => s.id === leg.venue)?.history === undefined) return false;
    // The older read follows the week's: while the week has never loaded it is not coming, as with no history.
    if ((this.#history.get(legKey(leg))?.loadedHour ?? null) === null) return false;
    const o = this.#older.get(legKey(leg));
    return o === undefined || (!o.done && o.givenUp === null);
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
  #loadHistory(priced: readonly PricedWindow[], deskPairs: readonly Pair[], now: number, heldId: string | null): number {
    if (this.#historyRun !== null) return 0;
    const { config } = this.#options;
    const current = hourStart(now);
    const held = (pw: PricedWindow) => Number(pw.pair.id === heldId);
    const order = [...priced].sort((a, b) => held(b) - held(a) || Number(b.pair.desk) - Number(a.pair.desk) || b.window.netAprPct - a.window.netAprPct);
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
      // Due alongside the leg's week read if need be: a week read that keeps failing must not starve it.
      if (leg.kind !== 'desk') continue;
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
    // Reads the venue's request budget did not send: one note a venue, and they come back one scan apart, not at once.
    const skipped = new Map<ScanVenueId, { first: ReadSkipped; count: number }>();
    const run: Promise<void> = pool(todo.map(({ leg, src, older }) => async () => {
      const key = legKey(leg);
      const what = `${leg.venue} ${older ? 'older history' : 'history'} ${leg.symbol}`;
      // Aborted when the scanner stops waiting, so a read that timed out does not run on in the background.
      const abort = new AbortController();
      try {
        const read = scanRead(() => src.history!(leg.symbol, older ? olderStart : start, older ? olderEnd : end, abort.signal));
        const points = await withTimeout(read, config.readTimeoutMs * 2, what).catch((err: unknown) => {
          abort.abort(err);
          throw err;
        });
        this.#rates.recordBooked(longSide(leg), points);
        this.#rates.recordBooked(shortSide(leg), points);
        if (older) {
          this.#older.set(key, { done: true, failures: 0, refusedSince: null, failingSince: null, givenUp: null, retryAt: 0 });
          const week = this.#history.get(key)?.points ?? 0;
          if (points.length < 0.5 * week) {
            this.#note(`${what}: ${points.length} prints against ${week} for the week after it: a market younger than 14 days`);
          }
        } else {
          this.#history.set(key, { loadedHour: current, retryAt: 0, points: points.length });
          // The venue answers for this leg after all: its refusals of the week before start counting again.
          const o = this.#older.get(key);
          if (o !== undefined && o.refusedSince !== null) this.#older.set(key, { ...o, refusedSince: null });
        }
      } catch (err) {
        if (isReadSkipped(err)) {
          // Nothing reached the venue: no failure of it, only a later try, spread over the scans that follow.
          const d = skipped.get(leg.venue) ?? { first: err, count: 0 };
          d.count++;
          skipped.set(leg.venue, d);
          const retryAt = Math.max(now + config.historyRetryMs, err.retryAt ?? 0) + (d.count - 1) * config.intervalMs;
          if (older) {
            const o = this.#older.get(key);
            this.#older.set(key, {
              done: false, failures: o?.failures ?? 0, refusedSince: o?.refusedSince ?? null, failingSince: o?.failingSince ?? null,
              givenUp: o?.givenUp ?? null, retryAt,
            });
          } else {
            const st = this.#history.get(key);
            this.#history.set(key, { loadedHour: st?.loadedHour ?? null, retryAt, points: st?.points ?? 0 });
          }
          return;
        }
        this.#note(`${what} failed: ${errorMessage(err)}`);
        if (older) {
          const o = this.#older.get(key);
          const failures = (o?.failures ?? 0) + 1;
          // A refusal clock runs only through refusals: any other failure starts it again at the next refusal.
          const refusedSince = isRefusal(err) ? (o?.refusedSince ?? now) : null;
          const failingSince = o?.failingSince ?? now;
          const givenUp = o?.givenUp
            ?? (refusedSince !== null && now - refusedSince >= OLDER_REFUSED_MS ? 'refused'
              : now - failingSince >= OLDER_FAILING_MS ? 'failing' : null);
          const backoff = Math.min(OLDER_RETRY_MAX_MS, config.historyRetryMs * 2 ** (failures - 1));
          this.#older.set(key, { done: false, failures, refusedSince, failingSince, givenUp, retryAt: now + backoff });
        } else {
          const st = this.#history.get(key);
          this.#history.set(key, { loadedHour: st?.loadedHour ?? null, retryAt: now + config.historyRetryMs, points: st?.points ?? 0 });
        }
      }
    }), 2).then(() => {
      for (const [venue, d] of skipped) this.#note(`${venue} history: ${d.count} read(s) not sent, tried again over the next scans (${d.first.message})`);
      if (this.#historyRun === run) this.#historyRun = null;
    });
    this.#historyRun = run;
    return todo.length;
  }

  /**
   * A due book whose read the venue's budget did not send, for a cool-down or a spent budget alike. A book never
   * read stays missing (its pairs are left out); the last one is stale, so the windows on it show their numbers but
   * cannot be entered, until a read is answered (it is due again next scan).
   */
  #deferBook(key: string, now: number): void {
    const { config } = this.#options;
    const last = this.#books.get(key);
    if (last === undefined) return;
    if (now - last.readAt > config.dropAfterMs) {
      this.#books.delete(key);
      return;
    }
    if (!last.stale) this.#books.set(key, { ...last, stale: true });
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
