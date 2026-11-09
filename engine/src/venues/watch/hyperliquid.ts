// Watch-only readers on Hyperliquid's public /info endpoint: the HIP-3 builder dexes (one `metaAndAssetCtxs` call
// with `dex` each) and the Binance and Bybit rates Hyperliquid itself publishes for its listed coins
// (`predictedFundings`). The desk trades only the main dex; these are ranked, never traded. Their requests weigh 20
// each and go through the host's weight budget with every other reader of it (hyperliquid.ts, http-budget.ts
// HL_BUDGET), as scanner funding reads; a reader given its own fetch (tests, capture) goes without one.

import type { ScanVenueId } from '@gimbal/shared';
import type { HostBudget } from '../http-budget.ts';
import { isReadSkipped } from '../http-budget.ts';
import { HL_MAINNET_INFO_URL, hlBudgetedSend, hlHostBudget } from '../hyperliquid.ts';
import type { MarketFunding, WatchReader } from '../venue.ts';
import type { WatchReaderOptions } from './http.ts';
import { WatchHttp, WatchVenueError, collect, list, optNum, optPrice, record } from './http.ts';
import { baseFields } from './symbols.ts';
import { hlDexRatePerHour, nextAtOr, nextBoundary, predictedRatePerHour, settlementForHours } from './units.ts';

/** The live HIP-3 dexes the scanner watches; the other six listed by `perpDexs` have every market delisted. */
export const HL_WATCH_DEXES = ['xyz', 'para', 'mkts', 'io'] as const;
export type HlWatchDex = (typeof HL_WATCH_DEXES)[number];

/**
 * Markets whose price is not the asset's own: `mkts:US500` quotes the S&P 500 index divided by 10, so one unit is
 * 0.1 index units. It pairs with the index elsewhere (SPX500) and the scanner divides its price by 0.1.
 */
export const HL_DEX_OVERRIDES: Readonly<Record<string, { base: string; multiplier: number }>> = {
  'mkts:US500': { base: 'SPX500', multiplier: 0.1 },
};

/** A watch reader's options on Hyperliquid: the /info URL and the weight budget (default: the host's, unless `fetch`). */
export type HlWatchOptions = WatchReaderOptions & { url?: string; budget?: HostBudget | null };

function watchBudget(options: HlWatchOptions, url: string): HostBudget | null {
  return options.budget !== undefined ? options.budget : options.fetch === undefined ? hlHostBudget(url) : null;
}

interface DexAsset { name: string; isDelisted?: boolean }
interface DexCtx { funding: string; openInterest: string; markPx: string; oraclePx: string; dayNtlVlm: string }

export class HlDexReader implements WatchReader {
  readonly id: ScanVenueId;
  readonly kind = 'dex' as const;
  readonly dex: HlWatchDex;
  readonly #http: WatchHttp;
  readonly #url: string;
  readonly #budget: HostBudget | null;

  constructor(dex: HlWatchDex, options: HlWatchOptions = {}) {
    this.dex = dex;
    this.id = `hl-${dex}`;
    this.#http = new WatchHttp(this.id, options);
    this.#url = options.url ?? HL_MAINNET_INFO_URL;
    this.#budget = watchBudget(options, this.#url);
  }

  async funding(): Promise<MarketFunding[]> {
    const body = { type: 'metaAndAssetCtxs', dex: this.dex };
    const answer = await this.#http.post(this.#url, body, (send) => hlBudgetedSend(this.#budget, body, send));
    return parseHlDex(this.id, this.dex, answer, this.#http.clock.now());
  }
}

/** Delisted markets are left out: they keep a context (a stale mark, zero OI) but nobody can open a leg there. */
export function parseHlDex(venue: ScanVenueId, dex: string, answer: unknown, now: number): MarketFunding[] {
  const pair = list(venue, answer, 'metaAndAssetCtxs');
  const universe = list<DexAsset>(venue, record(venue, pair[0], 'meta').universe, 'meta.universe');
  const ctxs = list<DexCtx>(venue, pair[1], 'asset contexts');
  if (ctxs.length !== universe.length) throw new WatchVenueError(venue, `${universe.length} assets but ${ctxs.length} contexts`);
  const nextAt = nextBoundary(now, 1);
  const prefix = `${dex}:`;
  return collect(venue, universe.map((asset, i) => ({ asset, ctx: ctxs[i]! })), ({ asset, ctx }) => {
    if (asset.isDelisted === true) return null;
    if (!asset.name.startsWith(prefix)) throw new Error(`${asset.name} is not on dex ${dex}`);
    const override = HL_DEX_OVERRIDES[asset.name];
    return {
      venue,
      symbol: asset.name,
      ratePerHour: hlDexRatePerHour(ctx.funding),
      settlement: 'hourly',
      nextAt,
      markPx: optPrice(ctx.markPx),
      oraclePx: optPrice(ctx.oraclePx),
      openInterest: optNum(ctx.openInterest),
      volume24hUsd: optNum(ctx.dayNtlVlm),
      ...(override ?? baseFields(asset.name.slice(prefix.length))),
    };
  });
}

/** The venue key in a `predictedFundings` row. */
export const PREDICTED_VENUE_KEYS = { binance: 'BinPerp', bybit: 'BybitPerp' } as const;
export type PredictedVenue = keyof typeof PREDICTED_VENUE_KEYS;

/**
 * One `predictedFundings` call shared by the Binance and Bybit readers of a sweep: a call made while another is
 * in flight gets the same answer instead of asking again.
 */
export class HlPredictedFeed {
  readonly #http: WatchHttp;
  readonly #url: string;
  readonly #budget: HostBudget | null;
  #inFlight: Promise<unknown> | null = null;

  constructor(options: HlWatchOptions = {}) {
    this.#http = new WatchHttp('hyperliquid', options);
    this.#url = options.url ?? HL_MAINNET_INFO_URL;
    this.#budget = watchBudget(options, this.#url);
  }

  get clock() {
    return this.#http.clock;
  }

  read(): Promise<unknown> {
    if (this.#inFlight !== null) return this.#inFlight;
    const body = { type: 'predictedFundings' };
    const p = this.#http.post(this.#url, body, (send) => hlBudgetedSend(this.#budget, body, send));
    this.#inFlight = p;
    const clear = () => {
      if (this.#inFlight === p) this.#inFlight = null;
    };
    p.then(clear, clear);
    return p;
  }
}

/**
 * Binance or Bybit funding for the coins Hyperliquid lists, as Hyperliquid predicts it. A reference leg only: no
 * mark, no open interest, no volume. Symbols are Hyperliquid's coin names ("kPEPE" is Binance's 1000PEPEUSDT).
 */
export class HlPredictedReader implements WatchReader {
  readonly id: PredictedVenue;
  readonly kind = 'cex' as const;
  readonly #feed: HlPredictedFeed;

  constructor(venue: PredictedVenue, feed: HlPredictedFeed) {
    this.id = venue;
    this.#feed = feed;
  }

  async funding(): Promise<MarketFunding[]> {
    let answer: unknown;
    try {
      answer = await this.#feed.read();
    } catch (err) {
      // Not sent (the host's budget): said as such, so the scanner does not count the venue as down.
      if (isReadSkipped(err)) throw err;
      // The feed is Hyperliquid's: say whose rates are missing, and through which venue.
      throw new WatchVenueError(this.id, `via hyperliquid predictedFundings: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parsePredicted(this.id, answer, this.#feed.clock.now());
  }
}

type PredictedRow = [string, [string, { fundingRate?: string; fundingIntervalHours?: number; nextFundingTime?: number } | null][]];

/**
 * A coin the venue does not list carries null; a row without an interval (Binance's delisted contracts, rate 0)
 * cannot be scaled to an hour and is left out, as is a prediction whose next funding time has passed.
 */
export function parsePredicted(venue: PredictedVenue, answer: unknown, now: number): MarketFunding[] {
  const key = PREDICTED_VENUE_KEYS[venue];
  const rows = list<PredictedRow>(venue, answer, 'predictedFundings');
  return collect(venue, rows, ([coin, venues]) => {
    if (typeof coin !== 'string' || !Array.isArray(venues)) throw new Error(`malformed row ${JSON.stringify([coin]).slice(0, 60)}`);
    const entry = venues.find((v) => Array.isArray(v) && v[0] === key)?.[1] ?? null;
    if (entry === null || entry.fundingIntervalHours === undefined || entry.fundingIntervalHours === null) return null;
    const hours = entry.fundingIntervalHours;
    const nextFundingTime = optNum(entry.nextFundingTime);
    if (nextFundingTime !== null && nextFundingTime < now - 60_000) return null;
    return {
      venue,
      symbol: coin,
      ratePerHour: predictedRatePerHour(entry.fundingRate, hours),
      settlement: settlementForHours(hours),
      nextAt: nextAtOr(nextFundingTime, now, hours),
      markPx: null,
      oraclePx: null,
      openInterest: null,
      volume24hUsd: null,
      ...baseFields(coin),
    };
  });
}
