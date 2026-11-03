// What every venue reader exposes (docs/interfaces.md section 3). Readers only read: orders and
// transfers go through the contract, never through a reader.

import type { FundingRate, ScanVenueId, VenueId } from '@gimbal/shared';

/** The venues a desk trades; every other venue the scanner reads is watch-only. */
export const DESK_VENUE_IDS: readonly VenueId[] = ['hyperliquid', 'phoenix', 'orderly'];

export function isDeskVenueId(venue: ScanVenueId): venue is VenueId {
  return (DESK_VENUE_IDS as readonly string[]).includes(venue);
}

/** A perp market as the venue lists it. Static between listings; read once per session. */
export interface Market {
  venue: VenueId;
  symbol: string;              // the venue's own name for the base asset ("BTC", "kPEPE"); no cross-venue mapping here
  assetIndex: number | null;   // the venue's numeric market id (Hyperliquid asset index); null where there is none
  szDecimals: number;          // sizes are multiples of 10^-szDecimals
  lotSize: number;             // smallest size step in base units (10^-szDecimals unless the venue says otherwise)
  tickSize: number | null;     // fixed price step; null when the venue rounds by significant figures (Hyperliquid)
  maxPxDecimals: number;       // most decimals a price may carry (Hyperliquid: 6 - szDecimals)
  maxLeverage: number;
  isolatedOnly: boolean;       // cannot use cross margin
  delisted: boolean;
}

/**
 * The current funding rate of one market, with the prices it applies to. Extends the shared
 * FundingRate so the scanner can price basis and size from one read instead of one book per market.
 */
export interface MarketFunding extends FundingRate {
  markPx: number | null;
  oraclePx: number | null;
  openInterest: number | null;   // units of `symbol` (what markPx prices); USD = openInterest × markPx
  volume24hUsd: number | null;
  base?: string;                 // the cross-venue key the scanner pairs on: quote, suffixes and broker tags stripped,
                                 // aliases applied ("kPEPE" → "PEPE", "PERP_SOL_USDC" → "SOL", "XBT" → "BTC");
                                 // absent = the scanner uses `symbol` as is
  multiplier?: number;           // base units per unit of `symbol` ("kPEPE" 1000); absent = 1
  shortRatePerHour?: number;     // what a short receives per hour where it differs from ratePerHour (GMX v2 per-side
                                 // funding plus borrow); absent = the same as ratePerHour
  fundingCapPerHour?: number;    // the venue's own per-market rate limits, per hour, from the same answer where it
  fundingFloorPerHour?: number;  // gives them; absent = unknown (the scanner falls back to its sourced caps)
  rateReadAt?: number;           // ms: the rate is from this earlier read, because the venue's latest refresh of it
                                 // failed (Phoenix serves its last hourly overview a few minutes); the scanner counts
                                 // the row stale. Absent = read now
}

/**
 * A watch-only venue: public funding and marks only, no account, no orders. The scanner ranks its
 * windows next to the tradable ones but the desk never trades them (interfaces section 3).
 */
export interface WatchReader {
  readonly id: ScanVenueId;      // lowercase, e.g. "pacifica", "hl-xyz", "okx"
  readonly kind: 'dex' | 'cex';  // CEX legs are reference only: CEX-vs-CEX pairs are not ranked
  funding(): Promise<MarketFunding[]>;
}

export interface BookLevel {
  px: number;
  sz: number;                    // base units
}

export interface Book {
  venue: VenueId;
  symbol: string;
  time: number;                  // the venue's own timestamp, ms
  bids: BookLevel[];             // best first
  asks: BookLevel[];             // best first
}

export interface Position {
  symbol: string;
  size: number;                  // base units, signed: > 0 long, < 0 short
  entryPx: number;
  liqPx: number | null;
  marginUsd: number;
  unrealizedPnlUsd: number;
  leverage: number;
  fundingSinceOpenUsd: number;   // settled funding since the position opened: received > 0, paid < 0
  unsettledFundingUsd: number;   // accrued but not settled yet (Phoenix settles daily); 0 where it settles as it accrues
}

export interface AccountState {
  venue: VenueId;
  address: string;
  time: number;                  // ms
  equityUsd: number;             // account value including unrealized PnL
  freeMarginUsd: number;         // what could be withdrawn now
  maintenanceMarginUsd: number;
  positions: Position[];
}

/** One funding payment the venue booked to an account. */
export interface FundingPayment {
  time: number;                  // ms, when the venue booked it
  symbol: string;
  fundingUsd: number;            // received > 0, paid < 0: the same sign as Position.fundingSinceOpenUsd
  size: number;                  // position size at that time, base units, signed
  ratePerHour: number;           // the rate it was priced at; > 0 means longs pay shorts
  samples: number | null;        // a row the venue aggregated (older history is one row per day): how many hourly
                                 // payments it sums, 24 for a full day; null on an ordinary hourly row
}

/** A venue's per-account funding history; every VenueReader has one (interfaces section 3). */
export interface FundingHistorySource {
  /** Every payment with `startTime <= time <= endTime` (ms; no end = up to now), oldest first, deduplicated across pages. */
  userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]>;
}

export interface VenueReader extends FundingHistorySource {
  readonly id: VenueId;
  markets(): Promise<Market[]>;
  funding(): Promise<MarketFunding[]>;
  /** Best levels first; `depth` caps the levels per side (the venue's own maximum otherwise). */
  book(symbol: string, depth?: number): Promise<Book>;
  account(address: string): Promise<AccountState>;
}

/**
 * One funding print of a market from the venue's public history: the rate a position held over the period that
 * ends at `time` was priced at. Engine-internal: the scanner's 7-day gross APR and the window history.
 */
export interface MarketFundingPoint {
  time: number;                  // ms, when the period ended (the venue books it then)
  symbol: string;                // the venue's own symbol
  ratePerHour: number;           // fraction per hour; > 0 means longs pay shorts
  periodHours: number;           // hours the print covers: 1 on Hyperliquid and Phoenix, 4 or 8 on Orderly
}

/** Public funding history of one market, oldest first, with `startTime <= time <= endTime` (ms). */
export interface MarketHistorySource {
  /** `signal` aborts the request (the scanner's timeout); a reader that cannot abort still ends at its own timeout. */
  marketFundingHistory(symbol: string, startTime: number, endTime: number, signal?: AbortSignal): Promise<MarketFundingPoint[]>;
}

export type VenueMethod = 'markets' | 'funding' | 'book' | 'account' | 'userFunding' | 'marketFundingHistory';

/** Time source shared by readers, the recorder and replay, so replay can swap in a virtual clock. */
export interface Clock {
  now(): number;                 // ms since the epoch
}

export const systemClock: Clock = { now: () => Date.now() };

/** Keeps the first `depth` levels of each side; no-op without a depth. */
export function trimBook(book: Book, depth?: number): Book {
  if (depth === undefined) return book;
  if (!Number.isInteger(depth) || depth < 1) throw new RangeError(`book depth must be a positive integer, got ${depth}`);
  return { ...book, bids: book.bids.slice(0, depth), asks: book.asks.slice(0, depth) };
}
