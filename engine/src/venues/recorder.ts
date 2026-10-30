// Wraps a reader and writes every call it answers (or fails) as one JSON line, gzipped.
// Line format (docs/interfaces.md section 3): {"t", "venue", "method", "args", "result"}, plus
// "ms" (how long the venue took) and "error" in place of "result" when the call threw, so a
// replay reproduces outages as well as data.

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants, createGzip } from 'node:zlib';
import type { VenueId } from '@gimbal/shared';
import type { AccountState, Book, Clock, Market, MarketFunding, VenueMethod, VenueReader } from './venue.ts';
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

export interface RecordSink {
  write(line: RecordLine): void;
}

export class RecordingVenue implements VenueReader {
  readonly id: VenueId;
  readonly #inner: VenueReader;
  readonly #sink: RecordSink;
  readonly #clock: Clock;

  constructor(inner: VenueReader, sink: RecordSink, clock: Clock = systemClock) {
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

/** Gzipped JSONL file. Refuses to touch an existing file, so a committed fixture is never extended by accident. */
export class JsonlGzWriter implements RecordSink {
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

  write(line: RecordLine): void {
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
