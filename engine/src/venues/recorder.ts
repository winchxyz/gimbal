// Wraps a reader and writes every call it answers (or fails) as one JSON line, gzipped.
// Line format (docs/interfaces.md section 3): {"t", "venue", "method", "args", "result"}, plus
// "ms" (how long the venue took) and "error" in place of "result" when the call threw, so a
// replay reproduces outages as well as data.
//
// recordingFetch records one level lower: the raw HTTP exchanges a reader makes, so a test can run the
// reader's own parsing and paging against what the venue really answered (see replayFetch).
// recordingWsRequester does the same for request/answer frames over a WebSocket (Orderly's public book).

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants, createGzip } from 'node:zlib';
import type { VenueId } from '@gimbal/shared';
import type {
  AccountState, Book, Clock, FundingHistorySource, FundingPayment, Market, MarketFunding, VenueMethod, VenueReader,
} from './venue.ts';
import { systemClock } from './venue.ts';
import type { WsRequester } from './ws.ts';

export interface RecordLine {
  t: number;                     // ms, when the answer arrived: replay serves it from this moment on
  venue: VenueId;
  method: VenueMethod;
  args: unknown[];
  ms: number;
  result?: unknown;
  error?: string;
}

/**
 * One exchange and the answer to it, whatever its status: an HTTP POST with a JSON body, an HTTP GET (the query is
 * part of `url`), or one request frame sent over a WebSocket and the frame that answered it.
 */
export interface WireLine {
  t: number;                     // ms, when the answer arrived
  method?: 'POST' | 'GET' | 'WS';   // absent on lines recorded before GET support: POST
  url: string;
  request: unknown;              // POST: the parsed JSON body; GET: null; WS: the frame sent, without its `id`
  status: number;                // HTTP status; 101 for a WS answer
  ms: number;
  response: unknown;             // parsed JSON when the body was JSON, the text otherwise; WS: the answer, without its `id`
}

export interface LineSink<L> {
  write(line: L): void;
}

export type RecordSink = LineSink<RecordLine>;

export class RecordingVenue implements VenueReader, FundingHistorySource {
  readonly id: VenueId;
  readonly #inner: VenueReader & Partial<FundingHistorySource>;
  readonly #sink: RecordSink;
  readonly #clock: Clock;

  constructor(inner: VenueReader & Partial<FundingHistorySource>, sink: RecordSink, clock: Clock = systemClock) {
    this.id = inner.id;
    this.#inner = inner;
    this.#sink = sink;
    this.#clock = clock;
  }

  markets(): Promise<Market[]> {
    return this.#call('markets', [], () => this.#inner.markets());
  }

  funding(): Promise<MarketFunding[]> {
    return this.#call('funding', [], () => this.#inner.funding());
  }

  book(symbol: string, depth?: number): Promise<Book> {
    const args = depth === undefined ? [symbol] : [symbol, depth];
    return this.#call('book', args, () => this.#inner.book(symbol, depth));
  }

  account(address: string): Promise<AccountState> {
    return this.#call('account', [address], () => this.#inner.account(address));
  }

  async userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> {
    const inner = this.#inner;
    if (inner.userFunding === undefined) throw new Error(`${this.id}: this reader has no userFunding`);
    const args = endTime === undefined ? [address, startTime] : [address, startTime, endTime];
    return this.#call('userFunding', args, () => inner.userFunding!(address, startTime, endTime));
  }

  async #call<T>(method: VenueMethod, args: unknown[], run: () => Promise<T>): Promise<T> {
    const started = this.#clock.now();
    let result: T;
    try {
      result = await run();
    } catch (err) {
      const t = this.#clock.now();
      this.#sink.write({ t, venue: this.id, method, args, ms: t - started, error: errorMessage(err) });
      throw err;
    }
    const t = this.#clock.now();
    this.#sink.write({ t, venue: this.id, method, args, ms: t - started, result });
    return result;
  }
}

/**
 * Wraps `fetch` and writes each exchange it answers, with its status, to `sink`. The caller gets the real
 * response back untouched. Supported: POST with a JSON string body (Hyperliquid's /info) and GET without a body
 * (Phoenix, Orderly public REST). Request headers are not recorded: a recording never holds a signature.
 */
export function recordingFetch(inner: typeof fetch, sink: LineSink<WireLine>, clock: Clock = systemClock): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    const { method, request } = wireRequest(url, init, 'recordingFetch');
    const started = clock.now();
    const res = await inner(input, init);
    const response = parseBody(await res.clone().text());
    const t = clock.now();
    sink.write(method === 'POST'
      ? { t, url, request, status: res.status, ms: t - started, response }
      : { t, method, url, request, status: res.status, ms: t - started, response });
    return res;
  };
}

export function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** The method and recorded request of a fetch call, or an error for a shape recordings do not support. */
export function wireRequest(url: string, init: RequestInit | undefined, who: string): { method: 'POST' | 'GET'; request: unknown } {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'POST' && typeof init?.body === 'string') return { method: 'POST', request: JSON.parse(init.body) as unknown };
  if (method === 'GET' && (init?.body === undefined || init.body === null)) return { method: 'GET', request: null };
  throw new Error(`${who}: ${url}: only POST with a JSON string body or GET without one`);
}

/** Parsed JSON when the text is JSON, the text itself otherwise. */
export function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Wraps a WebSocket requester and writes each request frame and its answer as a WireLine with method "WS".
 * The client-chosen `id` is dropped from both, so a replay matches on what was asked, not on a counter.
 */
export function recordingWsRequester(inner: WsRequester, sink: LineSink<WireLine>, clock: Clock = systemClock): WsRequester {
  return async (url, frame) => {
    const started = clock.now();
    const answer = await inner(url, frame);
    const t = clock.now();
    sink.write({ t, method: 'WS', url, request: withoutId(frame), status: 101, ms: t - started, response: withoutId(answer) });
    return answer;
  };
}

export function withoutId(frame: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = frame;
  return rest;
}

/** Gzipped JSONL file. Refuses to touch an existing file, so a committed fixture is never extended by accident. */
export class JsonlGzWriter<L = RecordLine> implements LineSink<L> {
  readonly path: string;
  readonly #gzip = createGzip({ level: 9 });
  readonly #done: Promise<void>;
  #lines = 0;
  #closed = false;

  constructor(path: string) {
    if (existsSync(path)) throw new Error(`${path} already exists; pick another name or delete it first`);
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.#done = pipeline(this.#gzip, createWriteStream(path, { flags: 'wx' }));
    // Without a listener a write error would surface only at close(); keep it for close() to report.
    this.#done.catch(() => {});
  }

  get lines(): number {
    return this.#lines;
  }

  write(line: L): void {
    if (this.#closed) throw new Error(`${this.path}: write after close`);
    this.#gzip.write(JSON.stringify(line) + '\n');
    this.#lines++;
  }

  /** Pushes buffered lines to disk so a crash loses at most what came after the last flush. */
  flush(): Promise<void> {
    return new Promise((resolve) => this.#gzip.flush(constants.Z_SYNC_FLUSH, () => resolve()));
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#gzip.end();
    }
    await this.#done;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
