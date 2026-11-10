// The scanner's funding history on disk, so a restart does not read every leg's two weeks from the venues again.
//
// Why: serve restarts on every deploy, and a cold scanner reads each leg's week and then each desk leg's week before
// through the hosts' request budgets (venues/http-budget.ts), which on mainnet took 45 minutes and more; until both
// weeks are in, no desk pair passes its entry gate (carry.ts). With this cache the scanner starts with what it held.
//
// The file (one per mode, contract and desk, as the journal's: history-<mode>[-<contract>-<desk>].json in the state
// directory) is one JSON object:
//   { "version": 1, "savedAt": <ms>, "legs": [ { "key": "<venue>|<symbol>", "loadedHour": <ms>, "points": <n>,
//     "olderDone": <bool>, "from": <ms>, "rates": [<rate per hour>, ...] } ] }
// `rates[i]` is the booked rate of the hour starting at `from + i` hours (null where the venue booked none);
// `loadedHour` is the hour the leg's last week read was for; `points` the prints that read answered with;
// `olderDone` whether the week before it has been read.
//
// Loading is strict, per leg: a leg that is not exactly that shape, whose hours are not on the hour or lie in the
// future, whose week was last read more than a week ago, whose kept hours stop short of what the next week read
// covers, or that has a hole (a null) in the hours kept, is dropped, and the scanner reads it again as without a
// cache. A file that cannot be parsed, has another version or was saved in the future is dropped whole. Hours older
// than the two weeks (and the 8 h the reads overlap) are left out.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mode } from '@gimbal/shared';
import { writeAtomic } from '../book/store.ts';
import { FORTNIGHT_HOURS, HOUR_MS, WEEK_HOURS, hourStart } from './history.ts';

export const HISTORY_CACHE_VERSION = 1;
/** The scanner writes the cache at most this often, and only after a history read has changed it. */
export const HISTORY_SAVE_EVERY_MS = 30_000;
/** The reads overlap the hours before them by this much (Orderly's 8 h prints): kept on load too. */
const OVERLAP_HOURS = 8;
const SAFE = /^[a-z0-9._-]{1,64}$/;
const LEG_KEY = /^[a-z0-9._-]{1,64}\|[^|]{1,128}$/;

/** One leg as the cache keeps it (see the file comment). */
export interface CachedLeg {
  key: string;
  loadedHour: number;
  points: number;
  olderDone: boolean;
  from: number;
  rates: number[];
}

export interface HistoryCacheLoad {
  legs: CachedLeg[];
  /** Legs in the file left out (bad shape, stale, a hole, a duplicate). */
  dropped: number;
  /** Why the whole file was left out, or null. */
  problem: string | null;
}

/** Where the scanner keeps its history cache: read whole, written whole and atomically. */
export interface HistoryStore {
  readonly path: string;
  /** The file's text, or null when there is none yet. Throws when it cannot be read. */
  read(): string | null;
  /** Replaces the file (a temporary file, then a rename). Throws on failure. */
  write(text: string): void;
}

/** The cache's path: one per mode, contract and desk, named as the journal's (journal-store.ts). */
export function historyCacheFile(dir: string, mode: Mode, contractId: string | null, deskId: string | null): string {
  const part = (v: string, what: string) => {
    if (!SAFE.test(v)) throw new Error(`${what} ${JSON.stringify(v)} cannot name a history cache file`);
    return v;
  };
  const id = contractId === null || deskId === null ? '' : `-${part(contractId, 'contract')}-${part(deskId, 'desk')}`;
  return join(dir, `history-${mode}${id}.json`);
}

export class FileHistoryStore implements HistoryStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  read(): string | null {
    try {
      return readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  write(text: string): void {
    // Creates the directory, writes and fsyncs a temporary file, renames it over the old one.
    writeAtomic(this.path, text);
  }
}

/**
 * serve's history store: in testnet and mainnet, the file under `dir` next to the journal; in replay none (it plays a
 * recording, and its clock is not real time). Never throws: a file it cannot name is logged, and the scanner reads
 * every leg's history from the venues as without a cache.
 */
export function openHistoryStore(mode: Mode, dir: string, contractId: string | null, deskId: string | null, log: (line: string) => void): HistoryStore | null {
  if (mode === 'replay') return null;
  try {
    return new FileHistoryStore(historyCacheFile(dir, mode, contractId, deskId));
  } catch (err) {
    log(`history: NOT kept on disk (${err instanceof Error ? err.message : String(err)}); read from the venues on every start`);
    return null;
  }
}

/** serve's start line for what the scanner restored (Scanner.restoreHistory), or null without a store. */
export function historyLoadLine(r: { path: string | null; legs: number; dropped: number; problem: string | null }): string | null {
  if (r.path === null) return null;
  if (r.problem !== null) return `history: none loaded from ${r.path}, ${r.problem}; every leg read from the venues`;
  return `history: ${r.legs} legs loaded from ${r.path}${r.dropped > 0 ? `; ${r.dropped} left out (stale, a gap or unreadable), read from the venues` : ''}`;
}

export function serializeHistoryCache(savedAt: number, legs: readonly { key: string; loadedHour: number; points: number; olderDone: boolean; from: number; rates: readonly (number | null)[] }[]): string {
  return JSON.stringify({ version: HISTORY_CACHE_VERSION, savedAt, legs });
}

const isHour = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v % HOUR_MS === 0;

/** The legs of a cache file that can be used at `now` (see the file comment); never throws. */
export function parseHistoryCache(text: string, now: number): HistoryCacheLoad {
  const none = (problem: string): HistoryCacheLoad => ({ legs: [], dropped: 0, problem });
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    return none(`not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return none('not an object');
  const file = v as Record<string, unknown>;
  if (file.version !== HISTORY_CACHE_VERSION) return none(`version ${JSON.stringify(file.version)}, expected ${HISTORY_CACHE_VERSION}`);
  if (typeof file.savedAt !== 'number' || !Number.isFinite(file.savedAt)) return none('no savedAt');
  if (file.savedAt > now) return none(`saved in the future (${new Date(file.savedAt).toISOString()})`);
  if (!Array.isArray(file.legs)) return none('no legs');
  const current = hourStart(now);
  const keepFrom = current - (FORTNIGHT_HOURS + OVERLAP_HOURS) * HOUR_MS;
  // The next week read covers from here: kept hours must reach it, or a hole would open between them.
  const weekReadFrom = current - (WEEK_HOURS + OVERLAP_HOURS) * HOUR_MS;
  const legs: CachedLeg[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of file.legs) {
    const leg = parseLeg(raw, current, keepFrom, weekReadFrom);
    if (leg === null || seen.has(leg.key)) {
      dropped++;
      continue;
    }
    seen.add(leg.key);
    legs.push(leg);
  }
  return { legs, dropped, problem: null };
}

function parseLeg(raw: unknown, current: number, keepFrom: number, weekReadFrom: number): CachedLeg | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.key !== 'string' || !LEG_KEY.test(l.key)) return null;
  // Read in the future, or more than a week ago: the week read would leave a hole behind the kept hours.
  if (!isHour(l.loadedHour) || l.loadedHour > current || l.loadedHour < current - WEEK_HOURS * HOUR_MS) return null;
  if (typeof l.points !== 'number' || !Number.isSafeInteger(l.points) || l.points < 0) return null;
  if (typeof l.olderDone !== 'boolean') return null;
  if (!isHour(l.from) || !Array.isArray(l.rates)) return null;
  const rates: unknown[] = l.rates;
  // A hole, or anything but a finite rate.
  if (!rates.every((r) => typeof r === 'number' && Number.isFinite(r))) return null;
  const last = l.from + (rates.length - 1) * HOUR_MS;
  // No hour after the read that booked it (nor, so, in the future).
  if (rates.length > 0 && last > l.loadedHour) return null;
  const skip = Math.max(0, Math.round((keepFrom - l.from) / HOUR_MS));
  const kept = rates.slice(skip) as number[];
  if (rates.length > 0) {
    // All of it older than two weeks, or stopping short of what the next week read covers.
    if (kept.length === 0 || last < weekReadFrom) return null;
  }
  return {
    key: l.key, loadedHour: l.loadedHour, points: l.points, olderDone: l.olderDone,
    from: kept.length === 0 ? l.loadedHour : l.from + skip * HOUR_MS, rates: kept,
  };
}
