// The scanner: reads every venue's funding, pairs the same base across venues, prices each direction at the desk's
// leg size and ranks the windows. One scan is one call to scan(); the server calls it every 5 s.
//
// What a scan does, in order:
// 1. funding() of every reader at once; a reader that fails or times out is listed in ScanStatus.failed and its last
//    good read (if not older than dropAfterMs) is used, marked stale;
// 2. legs: one per venue and base, marks checked against the other venues, open-interest floor (pairs.ts);
// 3. pairs in both directions; kept: gross > 0, and the held window whatever its sign;
// 4. books of the desk legs those pairs need, read again once older than bookTtlMs (a failed read keeps the last
//    book, marked stale, and lists the venue as failed); a desk pair with no book ever read is left out;
// 5. each window priced (price.ts); the 7-day gross and intervalsAbove from the hourly rate store, which a few
//    public history reads per scan fill;
// 6. ranked: tradable windows by net APR, then the rest by gross APR (their net is not complete).

import type { ScanStatus, ScanVenueId, StrategyConfig, Window as FundingWindow, WindowHistory } from '@gimbal/shared';
import type { Book, Clock, MarketFunding, MarketHistorySource, VenueReader, WatchReader } from '../venues/venue.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { ScannerConfig } from './config.ts';
import { HOUR_MS, RateStore, WEEK_HOURS, grossApr7d, hourStart, intervalsAbove, netAprSeries, round } from './history.ts';
import type { DropReason, LegKind, Pair, ScanLeg } from './pairs.ts';
import { filterLegs, pairLegs, toLeg } from './pairs.ts';
import type { BookRead, PricedWindow } from './price.ts';
import { priceWindow, switchCostUsd } from './price.ts';

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
  /** Where notes go (a failed read, a skipped book); default nowhere. */
  onNote?: (note: string) => void;
}

/** Diagnostics of one scan, for logs: never sent to the web. */
export interface ScanNotes {
  dropped: Partial<Record<DropReason, number>>;
  /** Desk pairs that could not be priced this scan, and why. */
  unpriced: { id: string; reason: string }[];
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

const legKey = (leg: Pick<ScanLeg, 'venue' | 'symbol'>): string => `${leg.venue}|${leg.symbol}`;

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
    if (now < this.#lastAt) throw new Error(`scanner: the clock went back from ${this.#lastAt} to ${now}`);
    this.#lastAt = now;
    const strategy = this.#options.strategy();
    const heldNow = this.#options.held?.() ?? null;
    const failed = new Set<ScanVenueId>();

    // 1. funding
    const reads = await Promise.all(this.#sources.map(async (s) => {
      try {
        const rows = await withTimeout(s.funding(), config.readTimeoutMs, `${s.id} funding`);
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
    const { kept, dropped } = filterLegs(legs, { oiFloorUsd: config.oiFloorUsd, maxMarkDeviation: config.maxMarkDeviation });
    const droppedCount: ScanNotes['dropped'] = {};
    for (const d of dropped) droppedCount[d.reason] = (droppedCount[d.reason] ?? 0) + 1;

    // 3. pairs
    const pairs = pairLegs(kept).filter((p) => p.grossPerHour > 0 || p.id === heldNow?.windowId);

    // 4. books
    const sourceById = new Map(this.#sources.map((s) => [s.id, s]));
    const wanted = new Map<string, ScanLeg>();
    for (const p of pairs) if (p.desk) for (const leg of [p.long, p.short]) wanted.set(legKey(leg), leg);
    const due = [...wanted.entries()].filter(([key]) => {
      const b = this.#books.get(key);
      return b === undefined || b.stale || now - b.readAt >= config.bookTtlMs;
    });
    await pool(due.map(([key, leg]) => async () => {
      const src = sourceById.get(leg.venue);
      if (src?.book === undefined) return;
      try {
        const book = await withTimeout(src.book(leg.symbol, config.bookDepth), config.bookTimeoutMs, `${leg.venue} book ${leg.symbol}`);
        this.#books.set(key, { book, readAt: now, stale: false });
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
    const ctx = {
      now,
      strategy,
      costs: config.costs,
      policy: config.policy,
      oracleSymbols: new Set(config.oracleSymbols),
      book: (leg: ScanLeg) => this.#books.get(legKey(leg)) ?? null,
    };
    const priced: PricedWindow[] = [];
    const unpriced: ScanNotes['unpriced'] = [];
    for (const p of pairs) {
      const r = priceWindow(p, ctx);
      if (r.ok) priced.push(r.priced);
      else unpriced.push({ id: p.id, reason: `${r.reason} on ${r.venue}` });
    }

    // History: the scanner's own reads count for this hour; a few public history reads per scan fill the week.
    for (const pw of priced) {
      this.#rates.recordLive(legKey(pw.pair.long), now, pw.pair.long.ratePerHour);
      this.#rates.recordLive(legKey(pw.pair.short), now, pw.pair.short.ratePerHour);
    }
    const historyReads = await this.#loadHistory(priced, now);
    this.#rates.prune(now);

    for (const pw of priced) {
      const w = pw.window;
      const longKey = legKey(pw.pair.long);
      const shortKey = legKey(pw.pair.short);
      const g7 = grossApr7d(this.#rates, longKey, shortKey, now);
      w.grossApr7dPct = g7 === null ? null : round(g7, 3);
      w.intervalsAbove = intervalsAbove(this.#rates, longKey, shortKey, now, w.grossAprPct, pw.costsApr, strategy.minNetAprPct);
    }

    const heldPriced = heldNow === null ? undefined : priced.find((pw) => pw.pair.id === heldNow.windowId);
    if (heldNow !== null && heldPriced !== undefined) heldPriced.window.held = { since: heldNow.since };
    if (heldPriced !== undefined) {
      for (const pw of priced) {
        if (pw === heldPriced || !pw.pair.desk) continue;
        pw.window.switchCostUsd = switchCostUsd(heldPriced, pw, strategy.legUsd, strategy.maxLeverage, config.costs);
      }
    }

    // 6. rank
    const byId = (a: PricedWindow, b: PricedWindow) => (a.pair.id < b.pair.id ? -1 : a.pair.id > b.pair.id ? 1 : 0);
    const tradable = priced.filter((pw) => pw.window.tradable).sort((a, b) => b.window.netAprPct - a.window.netAprPct || byId(a, b));
    const deskOther = priced.filter((pw) => !pw.window.tradable && pw.pair.desk);
    const watch = priced.filter((pw) => !pw.pair.desk)
      .sort((a, b) => b.window.grossAprPct - a.window.grossAprPct || byId(a, b))
      .slice(0, config.maxWatchWindows);
    const rest = [...deskOther, ...watch].sort((a, b) => b.window.grossAprPct - a.window.grossAprPct || byId(a, b));
    const ranked = [...tradable, ...rest];
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
    const points = netAprSeries(this.#rates, legKey(pw.pair.long), legKey(pw.pair.short), this.#lastAt, pw.window.grossAprPct, pw.costsApr);
    return { windowId, points };
  }

  /**
   * Reads public funding history for the legs that need it: desk windows first, best net first, at most
   * historyPerScan reads. A leg is read again once a new hour has begun (and a minute has passed, so the venue has
   * booked it); the window asked for is aligned to the hour, so a replay asks exactly what the recording asked.
   */
  async #loadHistory(priced: readonly PricedWindow[], now: number): Promise<number> {
    const { config } = this.#options;
    const current = hourStart(now);
    const order = [...priced].sort((a, b) => Number(b.pair.desk) - Number(a.pair.desk) || b.window.netAprPct - a.window.netAprPct);
    const todo: ScanLeg[] = [];
    const seen = new Set<string>();
    for (const pw of order) {
      for (const leg of [pw.pair.long, pw.pair.short]) {
        const key = legKey(leg);
        if (seen.has(key)) continue;
        seen.add(key);
        const src = this.#sources.find((s) => s.id === leg.venue);
        if (src?.history === undefined) continue;
        const st = this.#history.get(key);
        if (st !== undefined && (st.loadedHour === current || now < st.retryAt)) continue;
        if (st !== undefined && st.loadedHour !== null && now - current < 60_000) continue;
        todo.push(leg);
        if (todo.length >= config.historyPerScan) break;
      }
      if (todo.length >= config.historyPerScan) break;
    }
    // From 8 h before the week (Orderly's 8 h prints cover the hours before them) to the end of the current hour.
    const start = current - (WEEK_HOURS + 8) * HOUR_MS;
    const end = current + HOUR_MS - 1;
    let reads = 0;
    await pool(todo.map((leg) => async () => {
      const key = legKey(leg);
      const src = this.#sources.find((s) => s.id === leg.venue)!;
      reads++;
      try {
        const points = await withTimeout(src.history!(leg.symbol, start, end), config.readTimeoutMs * 2, `${leg.venue} history ${leg.symbol}`);
        this.#rates.recordBooked(key, points);
        this.#history.set(key, { loadedHour: current, retryAt: 0 });
      } catch (err) {
        this.#note(`${leg.venue} history ${leg.symbol} failed: ${errorMessage(err)}`);
        const st = this.#history.get(key);
        this.#history.set(key, { loadedHour: st?.loadedHour ?? null, retryAt: now + config.historyRetryMs });
      }
    }), 2);
    return reads;
  }

  #note(note: string): void {
    this.#options.onNote?.(note);
  }
}
