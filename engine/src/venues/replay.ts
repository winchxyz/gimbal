// Plays a recording back as a venue. Each call returns the latest recorded answer to the same
// call at or before the clock's current time, so the same clock steps always give the same
// answers: replay is deterministic by construction, with no timers and no network.

import { readFileSync } from 'node:fs';
import { constants, gunzipSync } from 'node:zlib';
import type { ScanVenueId, VenueId } from '@gimbal/shared';
import type { RecordLine, WireLine } from './recorder.ts';
import { requestUrl, wireRequest, withoutId } from './recorder.ts';
import type { WsRequester } from './ws.ts';
import type {
  AccountState, Book, Clock, FundingHistorySource, FundingPayment, Market, MarketFunding, MarketFundingPoint,
  MarketHistorySource, VenueMethod, VenueReader, WatchReader,
} from './venue.ts';
import { isDeskVenueId, systemClock, trimBook } from './venue.ts';

const METHODS: readonly VenueMethod[] = ['markets', 'funding', 'book', 'account', 'userFunding', 'marketFundingHistory'];

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
  return parseRecording(gunzipFile(path), path);
}

/** Reads a recording of raw HTTP exchanges (recordingFetch), cut-off tolerant like readRecording. */
export function readWireRecording(path: string): WireLine[] {
  return parseJsonl(gunzipFile(path), path, checkWireLine);
}

function gunzipFile(path: string): string {
  return gunzipSync(readFileSync(path), { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8');
}

export function parseRecording(text: string, source = 'recording'): RecordLine[] {
  return parseJsonl(text, source, checkLine);
}

function parseJsonl<L>(text: string, source: string, check: (v: unknown, where: string) => L): L[] {
  const raw = text.split('\n');
  const out: L[] = [];
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
    out.push(check(value, `${source}:${i + 1}`));
  }
  return out;
}

function checkWireLine(v: unknown, where: string): WireLine {
  if (typeof v !== 'object' || v === null) throw new Error(`${where}: not an object`);
  const o = v as Record<string, unknown>;
  if (typeof o.t !== 'number' || !Number.isFinite(o.t)) throw new Error(`${where}: t must be a number`);
  if (typeof o.url !== 'string') throw new Error(`${where}: url must be a string`);
  if (typeof o.status !== 'number') throw new Error(`${where}: status must be a number`);
  if (!('request' in o) || !('response' in o)) throw new Error(`${where}: needs request and response`);
  if ('method' in o && o.method !== 'POST' && o.method !== 'GET' && o.method !== 'WS') throw new Error(`${where}: unknown method ${String(o.method)}`);
  return v as WireLine;
}

/**
 * A `fetch` that answers from a wire recording: the same method, url and JSON body (key order ignored) get the
 * recorded status and body, and the same call made again gets the next recorded answer (the last one repeats).
 * A call nothing was recorded for throws ReplayMissError, so a reader that changes what it asks fails its test.
 */
export function replayFetch(lines: readonly WireLine[]): typeof fetch {
  const next = answersByCall(lines.filter((l) => (l.method ?? 'POST') !== 'WS'));
  return async (input, init) => {
    const url = requestUrl(input);
    const { method, request } = wireRequest(url, init, 'replayFetch');
    const line = next(wireKey(method, url, request));
    const body = typeof line.response === 'string' ? line.response : JSON.stringify(line.response);
    return new Response(body, { status: line.status });
  };
}

/** A WebSocket requester answering from the WS lines of a wire recording; the answer carries the caller's id. */
export function replayWsRequester(lines: readonly WireLine[]): WsRequester {
  const next = answersByCall(lines.filter((l) => l.method === 'WS'));
  return async (url, frame) => {
    const line = next(wireKey('WS', url, withoutId(frame)));
    return { id: frame.id, ...(line.response as Record<string, unknown>) };
  };
}

function answersByCall(lines: readonly WireLine[]): (key: string) => WireLine {
  const byCall = new Map<string, WireLine[]>();
  for (const line of lines) {
    const key = wireKey(line.method ?? 'POST', line.url, line.request);
    const list = byCall.get(key);
    if (list === undefined) byCall.set(key, [line]);
    else list.push(line);
  }
  const served = new Map<string, number>();
  return (key) => {
    const list = byCall.get(key);
    if (list === undefined) throw new ReplayMissError(`replay: nothing recorded for ${key}`);
    const n = served.get(key) ?? 0;
    served.set(key, n + 1);
    return list[Math.min(n, list.length - 1)]!;
  };
}

function wireKey(method: string, url: string, request: unknown): string {
  return `${method} ${url} ${stableJson(request)}`;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
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

export class ReplayVenue implements VenueReader, FundingHistorySource, MarketHistorySource {
  readonly id: VenueId;
  readonly start: number;          // first answer in the recording, ms
  readonly end: number;            // last answer, ms
  readonly #clock: Clock;
  readonly #byCall = new Map<string, RecordLine[]>();

  constructor(lines: readonly RecordLine[], clock: Clock, venue?: VenueId) {
    const id = venue ?? lines.find((l) => isDeskVenueId(l.venue))?.venue as VenueId | undefined;
    if (id === undefined) throw new Error(lines.length === 0 ? 'replay: empty recording' : 'replay: no desk venue in the recording');
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

  /** Only a window that was recorded is answered: the same address, startTime and endTime (or none). */
  async userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> {
    return this.#answer<FundingPayment[]>('userFunding', endTime === undefined ? [address, startTime] : [address, startTime, endTime]);
  }

  /** Only a window that was recorded is answered: the same symbol, startTime and endTime. */
  async marketFundingHistory(symbol: string, startTime: number, endTime: number): Promise<MarketFundingPoint[]> {
    return this.#answer<MarketFundingPoint[]>('marketFundingHistory', [symbol, startTime, endTime]);
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

/**
 * A watch-only venue played back from a recording (RecordingWatch's `funding` lines): each sweep answers with the
 * latest recorded one at or before the clock, an outage with its recorded error. `kind` is not in the recording:
 * it is the live reader's.
 */
export class ReplayWatch implements WatchReader {
  readonly id: ScanVenueId;
  readonly kind: WatchReader['kind'];
  readonly #clock: Clock;
  readonly #sweeps: RecordLine[];

  constructor(lines: readonly RecordLine[], clock: Clock, venue: ScanVenueId, kind: WatchReader['kind']) {
    if (isDeskVenueId(venue)) throw new Error(`replay: ${venue} is a desk venue, not a watch-only one`);
    // Stable sort: two answers in the same ms keep file order, and the later one wins.
    this.#sweeps = lines.filter((l) => l.venue === venue && l.method === 'funding').sort((a, b) => a.t - b.t);
    if (this.#sweeps.length === 0) throw new Error(`replay: no ${venue} funding lines in the recording`);
    this.id = venue;
    this.kind = kind;
    this.#clock = clock;
  }

  async funding(): Promise<MarketFunding[]> {
    const now = this.#clock.now();
    const line = latestAtOrBefore(this.#sweeps, now);
    if (line === undefined) throw new ReplayMissError(`replay ${this.id}: no funding() at or before ${now}`);
    if (line.error !== undefined) throw new Error(line.error);
    return structuredClone(line.result) as MarketFunding[];
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
