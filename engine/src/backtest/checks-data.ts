// The data the entry/exit-checks backtest runs on: each policy leg's public hourly funding history, and one snapshot
// of today's markets, books, marks and open interest (the scanner prices slippage on today's book, as live). Read once
// through the engine's own venue readers, public endpoints only (no keys, no account, nothing signed), and cached as
// JSON in a local folder so a rerun reads nothing from the network.
//
// Phoenix allows about 1 request a second per IP (burst about 20) and answers 429 with Retry-After 2: its reads are
// paced at one per PHOENIX_GAP_MS (at most 0.77 a second), and the reader's own host budget retries a 429.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractPolicy, VenueId } from '@gimbal/shared';
import { HyperliquidReader } from '../venues/hyperliquid.ts';
import { OrderlyReader } from '../venues/orderly.ts';
import { PhoenixReader } from '../venues/phoenix.ts';
import type { Book, Market, MarketFunding, MarketFundingPoint, MarketHistorySource, VenueReader } from '../venues/venue.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Phoenix: at most 0.77 requests a second from this tool, under the venue's 1 a second. */
export const PHOENIX_GAP_MS = 1_300;
// Hyperliquid weighs a fundingHistory read at 20 of its 1200 a minute per IP: one a second at most, so 1.2 s here.
const GAP_MS: Record<VenueId, number> = { hyperliquid: 1_200, phoenix: PHOENIX_GAP_MS, orderly: 500 };
/** A 429 that got past the reader is waited out this long, then tried again, at most RETRIES times. */
const RETRY_MS = 10_000;
const RETRIES = 6;
/** Phoenix answers at most 31 days a request; older history is read back in chunks of this. */
const CHUNK_MS: Record<VenueId, number> = { hyperliquid: 30 * DAY_MS, phoenix: 30 * DAY_MS, orderly: 30 * DAY_MS };
/** How far back history is read at most, per venue. */
export const MAX_DAYS = 400;

/** One leg's history in the cache: oldest first, one point per booked time. */
export interface LegHistory {
  venue: VenueId;
  symbol: string;
  fetchedAt: number;
  points: MarketFundingPoint[];
}

/** Today's markets on each venue: the rows, lots and books the scanner prices on. */
export interface Snapshot {
  takenAt: number;
  funding: Record<VenueId, MarketFunding[]>;
  markets: Record<VenueId, Market[]>;
  books: Record<string, Book>;       // `${venue}|${symbol}`
}

export interface BacktestData {
  snapshot: Snapshot;
  history: LegHistory[];
}

/** The legs the policy allows: every venue symbol of every policy market (Orderly where it lists the base). */
export function policyLegs(policy: ContractPolicy): { venue: VenueId; symbol: string }[] {
  return [
    ...policy.hl_assets.map((a) => ({ venue: 'hyperliquid' as const, symbol: a.symbol })),
    ...policy.phoenix_markets.map((m) => ({ venue: 'phoenix' as const, symbol: m.symbol })),
    ...policy.orderly_symbols.map((s) => ({ venue: 'orderly' as const, symbol: s })),
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spaces a venue's requests at least its gap apart. */
class Pacer {
  readonly #last = new Map<VenueId, number>();
  async wait(venue: VenueId): Promise<void> {
    const last = this.#last.get(venue) ?? 0;
    const due = last + GAP_MS[venue];
    const now = Date.now();
    if (now < due) await sleep(due - now);
    this.#last.set(venue, Date.now());
  }
}

/**
 * One leg's history, read back from now in chunks until a chunk is empty (the market's start) or MAX_DAYS.
 * Phoenix's history read is one HTTP request a chunk; Hyperliquid and Orderly page inside their reader.
 */
async function readHistory(reader: MarketHistorySource, venue: VenueId, symbol: string, pacer: Pacer, now: number, log: (s: string) => void): Promise<MarketFundingPoint[]> {
  const byTime = new Map<number, MarketFundingPoint>();
  let end = now;
  const oldest = now - MAX_DAYS * DAY_MS;
  while (end > oldest) {
    const start = Math.max(oldest, end - CHUNK_MS[venue]);
    let points: MarketFundingPoint[] | null = null;
    for (let attempt = 0; points === null; attempt++) {
      await pacer.wait(venue);
      try {
        points = await reader.marketFundingHistory(symbol, Math.floor(start), Math.floor(end));
      } catch (err) {
        if ((err as { status?: unknown }).status !== 429 || attempt >= RETRIES) throw err;
        log(`  ${venue} ${symbol}: 429, waiting ${RETRY_MS / 1000} s`);
        await sleep(RETRY_MS);
      }
    }
    for (const p of points) byTime.set(p.time, p);
    log(`  ${venue} ${symbol}: ${new Date(start).toISOString().slice(0, 10)}..${new Date(end).toISOString().slice(0, 10)} ${points.length} prints`);
    if (points.length === 0) break;
    end = start - 1;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** The cached data, or read now and cached. `allowFetch` false: a missing cache file is an error. */
export async function loadData(
  cacheDir: string, policy: ContractPolicy, options: { allowFetch: boolean; log: (s: string) => void },
): Promise<BacktestData> {
  mkdirSync(cacheDir, { recursive: true });
  const legs = policyLegs(policy);
  const snapFile = join(cacheDir, 'snapshot.json');
  const files = legs.map((l) => join(cacheDir, `history-${l.venue}-${l.symbol}.json`));
  const missing = [snapFile, ...files].filter((f) => !existsSync(f));
  if (missing.length > 0 && !options.allowFetch) throw new Error(`cache incomplete (${missing.length} files missing) and fetching is off`);

  let readers: { hyperliquid: HyperliquidReader; phoenix: PhoenixReader; orderly: OrderlyReader } | null = null;
  const reader = (v: VenueId): VenueReader & MarketHistorySource => {
    readers ??= { hyperliquid: new HyperliquidReader({ network: 'mainnet' }), phoenix: new PhoenixReader(), orderly: new OrderlyReader({ network: 'mainnet' }) };
    return readers[v];
  };
  const pacer = new Pacer();
  try {
    let snapshot: Snapshot;
    if (existsSync(snapFile)) {
      snapshot = JSON.parse(readFileSync(snapFile, 'utf8')) as Snapshot;
    } else {
      options.log('reading today\'s snapshot (funding rows, markets, books)');
      const funding = {} as Snapshot['funding'];
      const markets = {} as Snapshot['markets'];
      const books: Snapshot['books'] = {};
      for (const v of ['hyperliquid', 'phoenix', 'orderly'] as const) {
        const mine = new Set(legs.filter((l) => l.venue === v).map((l) => l.symbol));
        await pacer.wait(v);
        funding[v] = (await reader(v).funding()).filter((r) => mine.has(r.symbol));
        await pacer.wait(v);
        markets[v] = (await reader(v).markets()).filter((m) => mine.has(m.symbol));
        for (const s of mine) {
          await pacer.wait(v);
          books[`${v}|${s}`] = await reader(v).book(s, 20);
        }
      }
      snapshot = { takenAt: Date.now(), funding, markets, books };
      writeFileSync(snapFile, JSON.stringify(snapshot));
    }
    const history: LegHistory[] = [];
    for (const [i, leg] of legs.entries()) {
      const file = files[i]!;
      if (existsSync(file)) {
        history.push(JSON.parse(readFileSync(file, 'utf8')) as LegHistory);
        continue;
      }
      options.log(`reading ${leg.venue} ${leg.symbol} history`);
      // Up to the last whole hour of the snapshot, so every leg ends at the same booked hour.
      const end = Math.floor(snapshot.takenAt / HOUR_MS) * HOUR_MS;
      const points = await readHistory(reader(leg.venue), leg.venue, leg.symbol, pacer, end, options.log);
      const h: LegHistory = { venue: leg.venue, symbol: leg.symbol, fetchedAt: Date.now(), points };
      writeFileSync(file, JSON.stringify(h));
      history.push(h);
    }
    return { snapshot, history };
  } finally {
    const r = readers as { phoenix: PhoenixReader; orderly: OrderlyReader } | null;
    r?.phoenix.close();
    r?.orderly.close();
  }
}
