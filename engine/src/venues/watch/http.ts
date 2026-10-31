// What every watch-only reader shares: one HTTP client with clear errors, number parsing that refuses
// garbage, a small cache for listing data, and the rule that a venue that answers nothing usable is down.
//
// A venue that does not answer, answers with an HTML page (a WAF block, a region page, a maintenance page)
// or answers JSON of another shape makes funding() throw. A reader never returns an empty or zeroed list
// as if the venue were healthy.

import type { ScanVenueId } from '@gimbal/shared';
import type { Clock, MarketFunding } from '../venue.ts';
import { systemClock } from '../venue.ts';

export interface WatchReaderOptions {
  fetch?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;            // per request; default 15 s
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** A venue answered, but not with usable market data: non-2xx, not JSON, an HTML page, or another shape. */
export class WatchVenueError extends Error {
  readonly venue: ScanVenueId;
  readonly status: number | null;  // HTTP status when there was an answer
  constructor(venue: ScanVenueId, message: string, status: number | null = null) {
    super(`${venue}: ${message}`);
    this.name = 'WatchVenueError';
    this.venue = venue;
    this.status = status;
  }
}

/** GET and POST of JSON for one venue, through an injected fetch (tests replay recordings through it). */
export class WatchHttp {
  readonly venue: ScanVenueId;
  readonly clock: Clock;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(venue: ScanVenueId, options: WatchReaderOptions = {}) {
    this.venue = venue;
    this.clock = options.clock ?? systemClock;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get<T = unknown>(url: string, headers: Record<string, string> = {}): Promise<T> {
    return this.#send<T>(url, { method: 'GET', headers: { accept: 'application/json', ...headers } });
  }

  post<T = unknown>(url: string, body: unknown): Promise<T> {
    return this.#send<T>(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async #send<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
      text = await res.text();
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new WatchVenueError(this.venue, `no answer within ${this.#timeoutMs} ms from ${url}`);
      throw new WatchVenueError(this.venue, `request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parseAnswer<T>(this.venue, url, res.status, text);
  }
}

/** The parsed JSON of an answer, or a WatchVenueError saying what came back instead. */
export function parseAnswer<T>(venue: ScanVenueId, url: string, status: number, text: string): T {
  const page = htmlPage(text);
  if (page !== null) {
    throw new WatchVenueError(venue, `HTTP ${status} from ${url} is an HTML page${page === '' ? '' : ` ("${page}")`}, not market data: blocked, region page or maintenance`, status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WatchVenueError(venue, `HTTP ${status} from ${url} is not JSON: ${snippet(text)}`, status);
  }
  if (status < 200 || status > 299) throw new WatchVenueError(venue, `HTTP ${status} from ${url}: ${snippet(text)}`, status);
  return parsed as T;
}

/** The <title> of an HTML body ('' when it has none), or null when the body is not HTML. */
export function htmlPage(text: string): string | null {
  const head = text.trimStart().slice(0, 512).toLowerCase();
  if (!head.startsWith('<')) return null;
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(text.slice(0, 8192));
  return m === null ? '' : m[1]!.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function snippet(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s === '' ? '(empty body)' : s.slice(0, 160);
}

/**
 * Keeps one value for `ttlMs` on the reader's clock: listing data (status, intervals, contract sizes) that
 * changes only with a listing, so a sweep makes 1-3 calls instead of re-reading it every time. A failed read
 * is not kept, so the next call asks again.
 */
export class TtlCache<T> {
  readonly #ttlMs: number;
  readonly #clock: Clock;
  #entry: { at: number; value: Promise<T> } | null = null;

  constructor(ttlMs: number, clock: Clock) {
    this.#ttlMs = ttlMs;
    this.#clock = clock;
  }

  get(load: () => Promise<T>): Promise<T> {
    const now = this.#clock.now();
    if (this.#entry !== null && now - this.#entry.at < this.#ttlMs) return this.#entry.value;
    const entry = { at: now, value: load() };
    this.#entry = entry;
    entry.value.catch(() => {
      if (this.#entry === entry) this.#entry = null;
    });
    return entry.value;
  }
}

/** Listing data is re-read this often. */
export const LISTING_TTL_MS = 10 * 60_000;

/** A finite number from a JSON number or decimal string; throws on anything else (missing, '', NaN). */
export function num(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${field} is not a number: ${JSON.stringify(value)}`);
  return n || 0;                 // no negative zero
}

/** Like num, but null for a missing or unreadable value: for fields a venue leaves out on some markets. */
export function optNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n || 0 : null;
}

/** A positive price, or null (a venue sends 0 for a market with no price yet). */
export function optPrice(value: unknown): number | null {
  const n = optNum(value);
  return n !== null && n > 0 ? n : null;
}

/** `value` when it is an array, else a WatchVenueError naming what was expected: the shape changed. */
export function list<T = unknown>(venue: ScanVenueId, value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new WatchVenueError(venue, `${what} is not a list (the answer changed shape): ${snippet(JSON.stringify(value) ?? String(value))}`);
  return value as T[];
}

/** `value` when it is a plain object, else a WatchVenueError. */
export function record(venue: ScanVenueId, value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WatchVenueError(venue, `${what} is not an object (the answer changed shape): ${snippet(JSON.stringify(value) ?? String(value))}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Parses every row; `parse` returns null for a row that is not a live perp (left out on purpose) and throws for
 * a row it cannot read. A few unreadable rows are left out; if half or more are, the venue changed its shape
 * and the whole read fails. No market at all is a failure too, never an empty healthy answer.
 */
export function collect<R>(venue: ScanVenueId, rows: readonly R[], parse: (row: R) => MarketFunding | null): MarketFunding[] {
  const out: MarketFunding[] = [];
  const errors: string[] = [];
  for (const row of rows) {
    try {
      const f = parse(row);
      if (f !== null) out.push(f);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0 && errors.length * 2 >= rows.length) {
    throw new WatchVenueError(venue, `${errors.length} of ${rows.length} rows unreadable (the answer changed shape?), first: ${errors[0]}`);
  }
  if (out.length === 0) throw new WatchVenueError(venue, `no live market in the answer (${rows.length} rows)${errors.length > 0 ? `, first error: ${errors[0]}` : ''}`);
  return out;
}

/**
 * Keeps one row per base: the first by `rank` (lower wins), then the larger open interest in USD (24 h volume
 * where the venue gives no open interest).
 */
export function onePerBase(rows: readonly MarketFunding[], rank: (f: MarketFunding) => number = () => 0): MarketFunding[] {
  const best = new Map<string, MarketFunding>();
  const usd = (f: MarketFunding) => (f.openInterest !== null && f.markPx !== null ? f.openInterest * f.markPx : f.volume24hUsd ?? 0);
  for (const f of rows) {
    const key = f.base ?? f.symbol;
    const prev = best.get(key);
    if (prev === undefined || rank(f) < rank(prev) || (rank(f) === rank(prev) && usd(f) > usd(prev))) best.set(key, f);
  }
  return [...best.values()];
}
