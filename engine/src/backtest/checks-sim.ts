// The entry/exit-checks backtest: the real scanner and the real decide() stepped hour by hour over recorded public
// funding history, with LOOP_RULES' enterAfterChecks and exitAfterChecks made parameters (DecideInput.rules).
//
// Nothing here reads a venue. Each desk venue is a HistoryVenue: at the virtual clock's time it answers funding() with
// the last booked rate (the rate of the hour that just ended: no lookahead), its public history only up to now, and
// today's markets, books, marks and open interest from one snapshot (the scanner prices slippage on today's book, as
// live). The scanner runs with its live mainnet costs and the desk policy; decide() gets the live engine rules.
//
// Per hour: two scans (the first loads the hour's history, the second is priced on it, as the live scanner has its
// history back long before the hourly check), then one hourly check. A pair held over an hour books that hour's
// funding on both legs, from the venues' booked rates: legUsd x (short leg's rate - long leg's rate). Each entry and
// each rotation books the round trip the scanner priced for the window (fills on 4 fills, slippage on today's books,
// basis buffer), at the size decide() opened. Price P&L is not counted: both legs are the same notional of one base.

import type { ContractPolicy, StrategyConfig, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { DEFAULT_SCANNER_CONFIG, MAINNET_COSTS } from '../scanner/config.ts';
import type { ScannerConfig } from '../scanner/config.ts';
import { RateStore, hourStart } from '../scanner/history.ts';
import type { OracleSource } from '../scanner/price.ts';
import { Scanner } from '../scanner/scanner.ts';
import { HOUR_GRACE_MS } from '../strategy/loop.ts';
import { NO_COUNTERS, decide, sizeFor } from '../strategy/decide.ts';
import type { DecideInput, HeldPair, LoopCounters } from '../strategy/decide.ts';
import { LIVE_RESCUE } from '../trade/carry-plan.ts';
import { VirtualClock } from '../venues/replay.ts';
import type { Book, Clock, Market, MarketFunding, MarketFundingPoint, MarketHistorySource, VenueReader } from '../venues/venue.ts';
import type { BacktestData, LegHistory, Snapshot } from './checks-data.ts';

export const HOUR_MS = 3_600_000;
/** A venue print older than this many of its periods means the market was not listed (or not booking) then. */
const STALE_PERIODS = 2;

/** One desk venue over recorded history, at the virtual clock's time. */
export class HistoryVenue implements VenueReader, MarketHistorySource {
  readonly id: VenueId;
  readonly #clock: Clock;
  readonly #rows: MarketFunding[];
  readonly #markets: Market[];
  readonly #books: Map<string, Book>;
  readonly #points = new Map<string, { t: number[]; p: MarketFundingPoint[] }>();

  constructor(venue: VenueId, snapshot: Snapshot, history: readonly LegHistory[], clock: Clock) {
    this.id = venue;
    this.#clock = clock;
    this.#rows = snapshot.funding[venue] ?? [];
    this.#markets = snapshot.markets[venue] ?? [];
    this.#books = new Map(Object.entries(snapshot.books).filter(([k]) => k.startsWith(`${venue}|`)).map(([k, b]) => [k.slice(venue.length + 1), b]));
    for (const h of history) {
      if (h.venue !== venue) continue;
      const p = [...h.points].sort((a, b) => a.time - b.time);
      this.#points.set(h.symbol, { t: p.map((x) => x.time), p });
    }
  }

  /** Index of the first point after `t` (binary search). */
  #after(symbol: string, t: number): number {
    const s = this.#points.get(symbol);
    if (s === undefined) return 0;
    let lo = 0;
    let hi = s.t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.t[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  async funding(): Promise<MarketFunding[]> {
    const now = this.#clock.now();
    const out: MarketFunding[] = [];
    for (const row of this.#rows) {
      const s = this.#points.get(row.symbol);
      if (s === undefined) continue;
      const i = this.#after(row.symbol, now) - 1;
      if (i < 0) continue;
      const last = s.p[i]!;
      const period = last.periodHours * HOUR_MS;
      if (now - last.time > STALE_PERIODS * period) continue;
      let nextAt = last.time + period;
      while (nextAt <= now) nextAt += period;
      const { rateReadAt: _r, shortRatePerHour: _s, ...rest } = row;
      out.push({ ...rest, ratePerHour: last.ratePerHour, nextAt });
    }
    return out;
  }

  async book(symbol: string, depth?: number): Promise<Book> {
    const b = this.#books.get(symbol);
    if (b === undefined) throw new Error(`${this.id} ${symbol}: no book in the snapshot`);
    const d = depth ?? b.bids.length;
    return { ...b, time: this.#clock.now(), bids: b.bids.slice(0, d), asks: b.asks.slice(0, d) };
  }

  async markets(): Promise<Market[]> {
    return this.#markets;
  }

  async marketFundingHistory(symbol: string, startTime: number, endTime: number): Promise<MarketFundingPoint[]> {
    const s = this.#points.get(symbol);
    if (s === undefined) return [];
    const to = Math.min(endTime, this.#clock.now());
    return s.p.slice(this.#after(symbol, startTime - 1), this.#after(symbol, to));
  }

  account(): never {
    throw new Error('backtest: no accounts');
  }

  userFunding(): never {
    throw new Error('backtest: no accounts');
  }
}

/** Which windows the desk may open: `live` long Phoenix / short Hyperliquid only (as serve opens), `all` any. */
export type Scope = 'live' | 'all';

export interface SimConfig {
  enterAfterChecks: number;
  exitAfterChecks: number;
  strategy: StrategyConfig;
  policy: ContractPolicy;
  scope: Scope;
  /** Desk venues read (the scanner pairs every two of them). */
  venues: readonly VenueId[];
  /** First and last hourly check (hour starts, ms); the history must start 14 days before `start`. */
  start: number;
  end: number;
  scanner?: Partial<ScannerConfig>;
}

export interface Trade {
  windowId: string;
  symbol: string;
  longVenue: string;
  shortVenue: string;
  how: 'enter' | 'rotate';
  enteredAt: number;
  exitedAt: number | null;      // null: still held at the end
  exit: 'exit' | 'rotate' | 'end';
  exitReason: string;
  legUsd: number;
  hours: number;
  fundingUsd: number;
  costUsd: number;
  netUsd: number;
  /** Funding the hours waited before the entry would have paid (from the first passing check), USD at legUsd. */
  waitedHours: number;
  waitedFundingUsd: number;
  /** A counted exit: hours held from the first bad check of its run to the exit, and the funding they booked. */
  badHours: number;
  badFundingUsd: number;
}

/** A gate-passing run of the top window, while the desk was flat and out of cooldown, that ended before the entry. */
export interface MissedStreak {
  windowId: string;
  startedAt: number;
  hours: number;
}

export interface SimResult {
  enterAfterChecks: number;
  exitAfterChecks: number;
  trades: Trade[];
  entries: number;
  exits: number;
  rotations: number;
  hoursHeld: number;
  grossUsd: number;
  costUsd: number;
  netUsd: number;
  missed: MissedStreak[];
  /** Runs of bad checks on the held pair that recovered before exitAfterChecks: held through. */
  recovered: number;
  /** Hours whose funding was missing on a held leg (booked as 0). */
  missingHours: number;
  checks: number;
}

const legKey = (venue: string, symbol: string) => `${venue}|${symbol}`;

/** Realized funding: every booked rate of every leg, by hour. */
export class Realized {
  readonly #store = new RateStore();
  readonly #symbol = new Map<string, string>();    // venue|base -> venue symbol

  constructor(data: BacktestData) {
    for (const h of data.history) this.#store.recordBooked(legKey(h.venue, h.symbol), h.points);
    for (const [venue, rows] of Object.entries(data.snapshot.funding)) {
      for (const r of rows) this.#symbol.set(legKey(venue, (r.base ?? r.symbol).toUpperCase()), r.symbol);
    }
  }

  venueSymbol(venue: string, base: string): string | null {
    return this.#symbol.get(legKey(venue, base.toUpperCase())) ?? null;
  }

  /** USD a pair of `legUsd` a leg earned over the hour starting at `hour`; null when a leg has no booked rate. */
  hourUsd(w: Pick<FundingWindow, 'longVenue' | 'shortVenue' | 'symbol'>, legUsd: number, hour: number): number | null {
    const ls = this.venueSymbol(w.longVenue, w.symbol);
    const ss = this.venueSymbol(w.shortVenue, w.symbol);
    if (ls === null || ss === null) return null;
    const long = this.#store.rate(legKey(w.longVenue, ls), hour);
    const short = this.#store.rate(legKey(w.shortVenue, ss), hour);
    if (long === null || short === null) return null;
    return legUsd * (short - long);
  }

  sumUsd(w: Pick<FundingWindow, 'longVenue' | 'shortVenue' | 'symbol'>, legUsd: number, from: number, to: number): number {
    let sum = 0;
    for (let h = from; h < to; h += HOUR_MS) sum += this.hourUsd(w, legUsd, h) ?? 0;
    return sum;
  }
}

/** A window of the scope: `live` keeps long Phoenix / short Hyperliquid (serve-loop.ts windowSymbol). */
export function inScope(w: FundingWindow, scope: Scope): boolean {
  if (!w.tradable) return false;
  return scope === 'all' || (w.longVenue === 'phoenix' && w.shortVenue === 'hyperliquid');
}

/** One run over the hours, for one pair of counts. */
export async function simulate(data: BacktestData, cfg: SimConfig, realized: Realized = new Realized(data)): Promise<SimResult> {
  const clock = new VirtualClock(cfg.start);
  const venues = cfg.venues.map((v) => new HistoryVenue(v, data.snapshot, data.history, clock));
  const markets = new Map<string, Market>();
  for (const [venue, list] of Object.entries(data.snapshot.markets)) for (const m of list) markets.set(legKey(venue, m.symbol), m);
  const marks = new Map<string, number>();
  for (const [venue, rows] of Object.entries(data.snapshot.funding)) {
    for (const r of rows) if (r.markPx !== null && r.markPx > 0) marks.set(legKey(venue, r.symbol), r.markPx);
  }
  // The contract's stored prices: fresh at every scan (serve refreshes them at the open). Today's mark stands in.
  const oracle: OracleSource = { price: (venue, symbol) => {
    const px = marks.get(legKey(venue, symbol));
    return px === undefined ? null : { px, at: clock.now() };
  } };
  const config: ScannerConfig = {
    ...DEFAULT_SCANNER_CONFIG, costs: MAINNET_COSTS, policy: cfg.policy, historyPerScan: 200, ...cfg.scanner,
  };
  const strategy: StrategyConfig = { ...cfg.strategy, auto: true };
  type Held = HeldPair & { w: FundingWindow; trade: Trade; fromHour: number; costUsd: number };
  // Cast so the closures below that set it do not leave it narrowed to null in the loop.
  let held = null as Held | null;
  const scanner = new Scanner(venues, [], {
    config, clock, strategy: () => strategy, oracle, oracleRefreshAtOpen: () => true,
    held: () => (held === null ? null : { windowId: held.windowId, since: held.since }),
    // The desk's margin sits on its venues between holds: no 1Click move is priced into a switch.
    marginHeldAt: () => new Set(cfg.venues),
  });
  const free = Object.fromEntries(cfg.venues.map((v) => [v, 1e9]));
  const trades: Trade[] = [];
  const missed: MissedStreak[] = [];
  let counters: LoopCounters = NO_COUNTERS;
  let recovered = 0;
  let missingHours = 0;
  let checks = 0;
  let badSince: number | null = null;
  /** The first check of the desk's current run flat and out of cooldown; null while it holds or cools down. */
  let freeSince: number | null = null;
  /** Per window: the hour its current gate-passing run started, and whether it counts as a wait (top, desk flat). */
  const streaks = new Map<string, { start: number; eligible: boolean; entered: boolean; deskActed: boolean }>();

  const open = (w: FundingWindow, legUsd: number, now: number, hour: number, how: Trade['how']) => {
    const rt = scanner.carry(w.id)?.estimate.roundTrip.totalUsd;
    if (rt === undefined) throw new Error(`backtest: no round trip for ${w.id}`);
    const costUsd = rt * (legUsd / strategy.legUsd);
    const s = streaks.get(w.id);
    // An entry waited from the first check of the window's passing run; a rotation is counted on other hours.
    // Only the hours the desk was free to enter count: a run that began while it held a pair or cooled down waited
    // on those, not on the count.
    const waitedFrom = how === 'enter' ? Math.min(Math.max(s?.start ?? hour, freeSince ?? hour), hour) : hour;
    const trade: Trade = {
      windowId: w.id, symbol: w.symbol, longVenue: w.longVenue, shortVenue: w.shortVenue, how, enteredAt: hour, exitedAt: null, exit: 'end',
      exitReason: 'still held at the end', legUsd, hours: 0, fundingUsd: 0, costUsd, netUsd: -costUsd,
      waitedHours: (hour - waitedFrom) / HOUR_MS, waitedFundingUsd: realized.sumUsd(w, legUsd, waitedFrom, hour), badHours: 0, badFundingUsd: 0,
    };
    trades.push(trade);
    if (s !== undefined) s.entered = true;
    held = { windowId: w.id, symbol: w.symbol, since: now, legUsd, entryNetAprPct: w.netAprPct, pnlUsd: -costUsd / 2, w, trade, fromHour: hour, costUsd };
    badSince = null;
  };
  const close = (hour: number, exit: Trade['exit'], reason: string, counted: boolean) => {
    const t = held!.trade;
    t.exitedAt = hour;
    t.exit = exit;
    t.exitReason = reason;
    if (counted && badSince !== null) {
      t.badHours = (hour - badSince) / HOUR_MS;
      t.badFundingUsd = realized.sumUsd(held!.w, t.legUsd, badSince, hour);
    }
    held = null;
    badSince = null;
  };

  for (let hour = cfg.start; hour <= cfg.end; hour += HOUR_MS) {
    // The hour that just ended, booked to the pair held through it.
    if (held !== null && hour - HOUR_MS >= held.fromHour) {
      const usd = realized.hourUsd(held.w, held.legUsd, hour - HOUR_MS);
      if (usd === null) missingHours++;
      held.trade.fundingUsd += usd ?? 0;
      held.trade.hours++;
      held.trade.netUsd = held.trade.fundingUsd - held.trade.costUsd;
      held.pnlUsd = held.trade.fundingUsd - held.costUsd / 2;
    }
    clock.set(hour + HOUR_GRACE_MS + 1_000);
    await scanner.scan();
    await scanner.idle();
    const now = hour + HOUR_GRACE_MS + 6_000;
    clock.set(now);
    const r = await scanner.scan();
    await scanner.idle();
    const windows = r.windows.filter((w) => inScope(w, cfg.scope));
    if (held !== null) {
      const hw = windows.find((w) => w.id === held!.windowId);
      if (hw !== undefined) held.w = hw;
    }
    const gross14dAprPct: Record<string, number | null> = {};
    const lots: NonNullable<DecideInput['lots']> = {};
    for (const w of windows) {
      gross14dAprPct[w.id] = scanner.carry(w.id)?.estimate.gross.d14AprPct ?? null;
      const ls = realized.venueSymbol(w.longVenue, w.symbol);
      const ss = realized.venueSymbol(w.shortVenue, w.symbol);
      const lm = ls === null ? undefined : markets.get(legKey(w.longVenue, ls));
      const sm = ss === null ? undefined : markets.get(legKey(w.shortVenue, ss));
      const lp = ls === null ? undefined : marks.get(legKey(w.longVenue, ls));
      const sp = ss === null ? undefined : marks.get(legKey(w.shortVenue, ss));
      if (lm === undefined || sm === undefined || lp === undefined || sp === undefined) continue;
      lots[w.id] = { longLot: lm.lotSize, shortLot: sm.lotSize, px: (lp + sp) / 2 };
    }
    const heldPair: HeldPair | null = held === null
      ? null
      : { windowId: held.windowId, symbol: held.symbol, since: held.since, legUsd: held.legUsd, entryNetAprPct: held.entryNetAprPct, pnlUsd: held.pnlUsd };
    const input: DecideInput = {
      now, hourly: true, windows, held: heldPair, strategy, maxNotionalUsd: cfg.policy.max_notional_usd, freeMarginUsd: free,
      liveRescue: LIVE_RESCUE, counters, priceBandBps: cfg.policy.price_band_bps, gross14dAprPct, lots,
      rules: { enterAfterChecks: cfg.enterAfterChecks, exitAfterChecks: cfg.exitAfterChecks },
    };
    const d = decide(input);
    checks++;
    const flatFree = held === null && !d.decision.reason.startsWith('Cooling down');
    freeSince = flatFree ? (freeSince ?? hour) : null;

    // Gate-passing runs: begun this check (count 1), ended (no count), or acted on.
    const above = d.counters.aboveByWindow;
    for (const [id, s] of [...streaks]) {
      if (above[id] !== undefined) continue;
      streaks.delete(id);
      if (s.eligible && !s.entered && !s.deskActed) missed.push({ windowId: id, startedAt: s.start, hours: (hour - s.start) / HOUR_MS });
    }
    for (const [id, n] of Object.entries(above)) {
      if (n === 1 || !streaks.has(id)) {
        // A wait only when the desk could have entered it: flat, out of cooldown, the top window, and sizable (a
        // window one common lot of which is over the leg or under 10 USD is never entered, whatever the count).
        const w = windows.find((x) => x.id === id);
        const eligible = flatFree && d.decision.windowId === id && w !== undefined && sizeFor(w, input).ok;
        streaks.set(id, { start: hour - (n - 1) * HOUR_MS, eligible, entered: false, deskActed: false });
      }
    }
    // An exit or a rotation resets the count in d.counters: only a check that keeps the pair says how its run went.
    if (held !== null && d.act === null && d.counters.badChecks > 0 && badSince === null) badSince = hour;
    if (held !== null && d.act === null && d.counters.badChecks === 0 && badSince !== null) {
      recovered++;
      badSince = null;
    }

    counters = d.counters;
    const act = d.act;
    if (act === null) continue;
    for (const s of streaks.values()) s.deskActed = true;
    if (act.kind === 'enter') {
      const w = windows.find((x) => x.id === act.windowId)!;
      open(w, act.legUsd, now, hour, 'enter');
    } else if (act.kind === 'exit') {
      const counted = / in a row$/.test(act.reason);
      close(hour, 'exit', act.reason, counted);
    } else {
      close(hour, 'rotate', `rotate to ${act.toId}`, false);
      const w = windows.find((x) => x.id === act.toId)!;
      open(w, act.legUsd, now, hour, 'rotate');
    }
  }
  const sum = (f: (t: Trade) => number) => trades.reduce((s, t) => s + f(t), 0);
  return {
    enterAfterChecks: cfg.enterAfterChecks, exitAfterChecks: cfg.exitAfterChecks, trades,
    entries: trades.filter((t) => t.how === 'enter').length,
    exits: trades.filter((t) => t.exit === 'exit').length,
    rotations: trades.filter((t) => t.how === 'rotate').length,
    hoursHeld: sum((t) => t.hours), grossUsd: sum((t) => t.fundingUsd), costUsd: sum((t) => t.costUsd), netUsd: sum((t) => t.netUsd),
    missed, recovered, missingHours, checks,
  };
}

/** The first hour a 14-day history gate can pass: 14 days and a few hours after every leg of `venues` has prints. */
export function firstCheckHour(data: BacktestData, venues: readonly VenueId[]): number {
  // Each venue's history starts with its oldest market; a market listed later is a younger market, as live.
  // A print covers the period before its time: the first hour it covers is the start.
  const covered = (p: MarketFundingPoint) => p.time - p.periodHours * HOUR_MS;
  const starts = venues.map((v) => Math.min(...data.history.filter((h) => h.venue === v && h.points.length > 0).map((h) => covered(h.points[0]!))));
  return hourStart(Math.max(...starts)) + (14 * 24 + 12) * HOUR_MS;
}

/** The last hourly check the data covers: every leg of `venues` booked up to it. */
export function lastCheckHour(data: BacktestData, venues: readonly VenueId[]): number {
  const ends = data.history.filter((h) => venues.includes(h.venue) && h.points.length > 0).map((h) => h.points.at(-1)!.time);
  return hourStart(Math.min(...ends));
}
