// Plays a recording back as a venue. Each call returns the latest recorded answer to the same
// call at or before the clock's current time, so the same clock steps always give the same
// answers: replay is deterministic by construction, with no timers and no network.

import { readFileSync } from 'node:fs';
import { constants, gunzipSync } from 'node:zlib';
import type { VenueId } from '@gimbal/shared';
import type { RecordLine } from './recorder.ts';
import type { AccountState, Book, Clock, Market, MarketFunding, VenueMethod, VenueReader } from './venue.ts';
import { systemClock, trimBook } from './venue.ts';

const METHODS: readonly VenueMethod[] = ['markets', 'funding', 'book', 'account'];

/** A call the recording cannot answer: nothing recorded for it at or before the clock's time. */
export class ReplayMissError extends Error {
  name = 'ReplayMissError';
}

/** Manual clock for replays and tests: time moves only when told to, and never backwards. */
export class VirtualClock implements Clock {
  #t: number;

  constructor(start: number) {
    if (!Number.isFinite(start)) throw new RangeError(`virtual clock start must be a finite ms value, got ${start}`);
    this.#t = start;
  }

  now(): number {
    return this.#t;
  }

  set(t: number): void {
    if (!(t >= this.#t)) throw new RangeError(`virtual clock cannot go back from ${this.#t} to ${t}`);
    this.#t = t;
  }

  advance(ms: number): void {
    this.set(this.#t + ms);
  }
}

/** Virtual time running `speed` times faster than `real`, from `start`: the demo's ×N playback. */
export class ScaledClock implements Clock {
  readonly #start: number;
  readonly #speed: number;
  readonly #real: Clock;
  readonly #realStart: number;

  constructor(start: number, speed: number, real: Clock = systemClock) {
    if (!(speed > 0)) throw new RangeError(`replay speed must be > 0, got ${speed}`);
    this.#start = start;
    this.#speed = speed;
    this.#real = real;
    this.#realStart = real.now();
  }

  now(): number {
    return this.#start + Math.floor((this.#real.now() - this.#realStart) * this.#speed);
  }
}

/**
 * Reads a .jsonl.gz recording. A file cut off by a killed recorder still loads: decoding stops at
 * the last complete line instead of failing.
 */
export function readRecording(path: string): RecordLine[] {
  const text = gunzipSync(readFileSync(path), { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8');
  return parseRecording(text, path);
}

export function parseRecording(text: string, source = 'recording'): RecordLine[] {
  const raw = text.split('\n');
  const out: RecordLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (s === undefined || s === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(s);
    } catch {
      // Only the very last line may be partial (no newline after it yet).
      if (i === raw.length - 1) break;
      throw new Error(`${source}:${i + 1}: not JSON`);
    }
    out.push(checkLine(value, `${source}:${i + 1}`));
  }
  return out;
}

function checkLine(v: unknown, where: string): RecordLine {
  if (typeof v !== 'object' || v === null) throw new Error(`${where}: not an object`);
  const o = v as Record<string, unknown>;
  if (typeof o.t !== 'number' || !Number.isFinite(o.t)) throw new Error(`${where}: t must be a number`);
  if (typeof o.venue !== 'string') throw new Error(`${where}: venue must be a string`);
  if (!METHODS.includes(o.method as VenueMethod)) throw new Error(`${where}: unknown method ${String(o.method)}`);
  if (!Array.isArray(o.args)) throw new Error(`${where}: args must be an array`);
  if (!('result' in o) && typeof o.error !== 'string') throw new Error(`${where}: needs result or error`);
  return v as RecordLine;
}

export class ReplayVenue implements VenueReader {
  readonly id: VenueId;
  readonly start: number;          // first answer in the recording, ms
  readonly end: number;            // last answer, ms
  readonly #clock: Clock;
  readonly #byCall = new Map<string, RecordLine[]>();

  constructor(lines: readonly RecordLine[], clock: Clock, venue?: VenueId) {
    const id = venue ?? lines[0]?.venue;
    if (id === undefined) throw new Error('replay: empty recording');
    const mine = lines.filter((l) => l.venue === id);
    if (mine.length === 0) throw new Error(`replay: no ${id} lines in the recording`);
    // Stable sort: two answers in the same ms keep file order, and the later one wins.
    mine.sort((a, b) => a.t - b.t);
    for (const line of mine) {
      const key = callKey(line.method, line.args);
      const list = this.#byCall.get(key);
      if (list === undefined) this.#byCall.set(key, [line]);
      else list.push(line);
    }
    this.id = id;
    this.#clock = clock;
    this.start = mine[0]!.t;
    this.end = mine[mine.length - 1]!.t;
  }

  static fromFile(path: string, clock: Clock, venue?: VenueId): ReplayVenue {
    return new ReplayVenue(readRecording(path), clock, venue);
  }

  /** Every distinct time a call was answered (all calls, or one method), ascending. */
  times(method?: VenueMethod): number[] {
    const set = new Set<number>();
    for (const list of this.#byCall.values()) {
      for (const l of list) if (method === undefined || l.method === method) set.add(l.t);
    }
    return [...set].sort((a, b) => a - b);
  }

  async markets(): Promise<Market[]> {
    return this.#answer<Market[]>('markets', []);
  }

  async funding(): Promise<MarketFunding[]> {
    return this.#answer<MarketFunding[]>('funding', []);
  }

  async book(symbol: string, depth?: number): Promise<Book> {
    return trimBook(this.#answer<Book>('book', [symbol]), depth);
  }

  async account(address: string): Promise<AccountState> {
    return this.#answer<AccountState>('account', [address]);
  }

  #answer<T>(method: VenueMethod, args: unknown[]): T {
    const now = this.#clock.now();
    const line = latestAtOrBefore(this.#byCall.get(callKey(method, args)), now);
    if (line === undefined) {
      throw new ReplayMissError(`replay ${this.id}: no ${method}(${args.map((a) => JSON.stringify(a)).join(', ')}) at or before ${now}`);
    }
    if (line.error !== undefined) throw new Error(line.error);
    // A copy, so a caller that mutates an answer cannot change what the next call gets.
    return structuredClone(line.result) as T;
  }
}

// A book is keyed by symbol alone: depth only trims, and replay trims the recorded levels itself.
function callKey(method: VenueMethod, args: readonly unknown[]): string {
  return `${method} ${JSON.stringify(method === 'book' ? args.slice(0, 1) : args)}`;
}

function latestAtOrBefore(list: RecordLine[] | undefined, t: number): RecordLine | undefined {
  if (list === undefined) return undefined;
  let lo = 0;
  let hi = list.length;               // first index with list[i].t > t
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? undefined : list[lo - 1];
}
