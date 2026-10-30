// Wraps a reader and writes every call it answers (or fails) as one JSON line, gzipped.
// Line format (docs/interfaces.md section 3): {"t", "venue", "method", "args", "result"}, plus
// "ms" (how long the venue took) and "error" in place of "result" when the call threw, so a
// replay reproduces outages as well as data.
//
// recordingFetch records one level lower: the raw HTTP exchanges a reader makes, so a test can run the
// reader's own parsing and paging against what the venue really answered (see replayFetch).

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants, createGzip } from 'node:zlib';
import type { VenueId } from '@gimbal/shared';
import type {
  AccountState, Book, Clock, FundingHistorySource, FundingPayment, Market, MarketFunding, VenueMethod, VenueReader,
} from './venue.ts';
import { systemClock } from './venue.ts';

export interface RecordLine {
  t: number;                     // ms, when the answer arrived: replay serves it from this moment on
  venue: VenueId;
  method: VenueMethod;
  args: unknown[];
  ms: number;
  result?: unknown;
  error?: string;
}

/** One HTTP exchange: a POST with a JSON body and the answer to it, whatever its status. */
export interface WireLine {
  t: number;                     // ms, when the answer arrived
  url: string;
  request: unknown;              // the parsed JSON body
  status: number;
  ms: number;
  response: unknown;             // parsed JSON when the body was JSON, the text otherwise
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
 * Wraps `fetch` and writes each POST it answers, with its status, to `sink`. The caller gets the real
 * response back untouched. Only POSTs with a JSON string body are supported: that is all /info takes.
 */
export function recordingFetch(inner: typeof fetch, sink: LineSink<WireLine>, clock: Clock = systemClock): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init?.method !== 'POST' || typeof init.body !== 'string') throw new Error(`recordingFetch: ${url}: only POST with a JSON string body`);
    const started = clock.now();
    const res = await inner(input, init);
    const text = await res.clone().text();
    let response: unknown = text;
    try {
      response = JSON.parse(text);
    } catch {
      // not JSON: keep the text
    }
    const t = clock.now();
    sink.write({ t, url, request: JSON.parse(init.body) as unknown, status: res.status, ms: t - started, response });
    return res;
  };
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
