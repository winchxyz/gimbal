// Hourly funding rates per leg, from the venues' public history and from the scanner's own reads, and what the
// windows derive from them: the 7-day gross APR, how many hours in a row a window has cleared the owner's minimum,
// and the hourly net APR series GET /windows/history serves.
//
// An hour is keyed by its start (ms, a multiple of one hour). A rate booked at time T for a period of P hours covers
// the P hours that end at T.

import type { MarketFundingPoint } from '../venues/venue.ts';
import { aprPct } from './costs.ts';

export const HOUR_MS = 3_600_000;
export const WEEK_HOURS = 168;
/** Two weeks: the 14-day average a desk window's expected carry prefers when the store holds it. */
export const FORTNIGHT_HOURS = 2 * WEEK_HOURS;
/** A 7-day (or 14-day) figure needs at least this share of its hours on both legs; a newer market shows null. */
export const WEEK_COVERAGE = 0.9;
const KEEP_HOURS = FORTNIGHT_HOURS + 12;

export function hourStart(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

/** The hours a booked print covers, by their start: a print at 10:00:00.059 for one hour covers the 09:00 hour. */
export function hoursCovered(point: Pick<MarketFundingPoint, 'time' | 'periodHours'>): number[] {
  const end = Math.round(point.time / HOUR_MS) * HOUR_MS;
  const n = Math.max(1, Math.round(point.periodHours));
  return Array.from({ length: n }, (_, i) => end - (n - i) * HOUR_MS);
}

interface LegRates {
  booked: Map<number, number>;   // hour start -> rate per hour, from the venue's history
  live: Map<number, number>;     // hour start -> the last rate the scanner read in that hour
}

/** Hourly rates per leg (`venue|symbol`). Booked rates win over the scanner's own reads of the same hour. */
export class RateStore {
  readonly #legs = new Map<string, LegRates>();

  #leg(key: string): LegRates {
    let leg = this.#legs.get(key);
    if (leg === undefined) {
      leg = { booked: new Map(), live: new Map() };
      this.#legs.set(key, leg);
    }
    return leg;
  }

  /** The rate the scanner read now counts for the hour it was read in (the venue's current rate). */
  recordLive(key: string, at: number, ratePerHour: number): void {
    this.#leg(key).live.set(hourStart(at), ratePerHour);
  }

  recordBooked(key: string, points: readonly MarketFundingPoint[]): void {
    const leg = this.#leg(key);
    for (const p of points) for (const h of hoursCovered(p)) leg.booked.set(h, p.ratePerHour);
  }

  /**
   * Booked rates from a history cache (history-cache.ts): `rates[i]` is the rate of the hour starting at
   * `from + i` hours. The caller has checked the hours.
   */
  restoreBooked(key: string, from: number, rates: readonly number[]): void {
    const leg = this.#leg(key);
    rates.forEach((r, i) => leg.booked.set(from + i * HOUR_MS, r));
  }

  /**
   * A leg's booked hours from its first to its last, for the history cache: `rates[i]` is the hour starting at
   * `from + i` hours, null where the venue booked nothing. Null when it has none.
   */
  bookedRun(key: string): { from: number; rates: (number | null)[] } | null {
    const booked = this.#legs.get(key)?.booked;
    if (booked === undefined || booked.size === 0) return null;
    let from = Infinity;
    let to = -Infinity;
    for (const h of booked.keys()) {
      if (h < from) from = h;
      if (h > to) to = h;
    }
    const rates: (number | null)[] = [];
    for (let h = from; h <= to; h += HOUR_MS) rates.push(booked.get(h) ?? null);
    return { from, rates };
  }

  rate(key: string, hour: number): number | null {
    const leg = this.#legs.get(key);
    if (leg === undefined) return null;
    return leg.booked.get(hour) ?? leg.live.get(hour) ?? null;
  }

  /** Forgets hours older than two weeks (plus a margin) before `now`. */
  prune(now: number): void {
    const oldest = hourStart(now) - KEEP_HOURS * HOUR_MS;
    for (const leg of this.#legs.values()) {
      for (const m of [leg.booked, leg.live]) for (const h of m.keys()) if (h < oldest) m.delete(h);
    }
  }
}

/** Hourly gross of a window (APR points) for the hour starting at `hour`; null when either leg has no rate for it. */
export function hourlyGrossApr(store: RateStore, longKey: string, shortKey: string, hour: number): number | null {
  const long = store.rate(longKey, hour);
  const short = store.rate(shortKey, hour);
  if (long === null || short === null) return null;
  return aprPct(short - long);
}

/**
 * Mean hourly gross APR over the `hours` complete hours before the current one; null when fewer than 90 % of them
 * have both legs' rates (a market listed since, or history not loaded yet).
 */
export function grossAprOver(store: RateStore, longKey: string, shortKey: string, now: number, hours: number): number | null {
  const current = hourStart(now);
  let sum = 0;
  let n = 0;
  for (let i = 1; i <= hours; i++) {
    const g = hourlyGrossApr(store, longKey, shortKey, current - i * HOUR_MS);
    if (g === null) continue;
    sum += g;
    n++;
  }
  return n >= Math.ceil(hours * WEEK_COVERAGE) ? sum / n : null;
}

/** grossAprOver the 168 hours of the last week. */
export function grossApr7d(store: RateStore, longKey: string, shortKey: string, now: number): number | null {
  return grossAprOver(store, longKey, shortKey, now, WEEK_HOURS);
}

/** grossAprOver the 336 hours of the last two weeks. */
export function grossApr14d(store: RateStore, longKey: string, shortKey: string, now: number): number | null {
  return grossAprOver(store, longKey, shortKey, now, FORTNIGHT_HOURS);
}

/** One leg's mean rate over the `hours` complete hours before the current one, as APR; null under 90 % coverage. */
export function legAprOver(store: RateStore, key: string, now: number, hours: number): number | null {
  const current = hourStart(now);
  let sum = 0;
  let n = 0;
  for (let i = 1; i <= hours; i++) {
    const r = store.rate(key, current - i * HOUR_MS);
    if (r === null) continue;
    sum += r;
    n++;
  }
  return n >= Math.ceil(hours * WEEK_COVERAGE) ? aprPct(sum / n) : null;
}

/**
 * Hours in a row, newest first, in which the window's net APR (that hour's gross minus today's costs) was at least
 * `minNetAprPct`. The current hour is priced at `grossNowApr` (the live rates); the walk stops at the first hour below
 * the minimum or without data. At most 168.
 */
export function intervalsAbove(
  store: RateStore, longKey: string, shortKey: string, now: number, grossNowApr: number, costsApr: number, minNetAprPct: number,
): number {
  if (grossNowApr - costsApr < minNetAprPct) return 0;
  const current = hourStart(now);
  let n = 1;
  for (let i = 1; i < WEEK_HOURS; i++) {
    const g = hourlyGrossApr(store, longKey, shortKey, current - i * HOUR_MS);
    if (g === null || g - costsApr < minNetAprPct) break;
    n++;
  }
  return n;
}

/** Hourly net APR (that hour's gross minus today's costs) for the last 168 hours, oldest first; hours without data are left out. */
export function netAprSeries(
  store: RateStore, longKey: string, shortKey: string, now: number, grossNowApr: number, costsApr: number,
): { t: number; netAprPct: number }[] {
  const current = hourStart(now);
  const points: { t: number; netAprPct: number }[] = [];
  for (let i = WEEK_HOURS - 1; i >= 1; i--) {
    const t = current - i * HOUR_MS;
    const g = hourlyGrossApr(store, longKey, shortKey, t);
    if (g !== null) points.push({ t, netAprPct: round(g - costsApr, 3) });
  }
  points.push({ t: current, netAprPct: round(grossNowApr - costsApr, 3) });
  return points;
}

export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f || 0;
}
