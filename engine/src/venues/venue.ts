// What every venue reader exposes (docs/interfaces.md section 3). Readers only read: orders and
// transfers go through the contract, never through a reader.

import type { FundingRate, VenueId } from '@gimbal/shared';

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
  openInterest: number | null;   // base units
  volume24hUsd: number | null;
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

export interface VenueReader {
  readonly id: VenueId;
  markets(): Promise<Market[]>;
  funding(): Promise<MarketFunding[]>;
  /** Best levels first; `depth` caps the levels per side (the venue's own maximum otherwise). */
  book(symbol: string, depth?: number): Promise<Book>;
  account(address: string): Promise<AccountState>;
}

export type VenueMethod = 'markets' | 'funding' | 'book' | 'account';

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
