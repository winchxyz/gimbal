// The position book's shapes. What the strategy loop hands the book (BookRecord, BookFill, MarginMove, BookSink) is
// the loop's own (engine/src/strategy/loop.ts); the book adds only optional fields the loop's record does not carry.
//
// BookFill.feeUsd is what the venue charged for the fills (Hyperliquid userFills "fee", Phoenix trades-history
// "fees", as trade/legs.ts reads them): > 0 a cost, < 0 a maker rebate. The book turns it into signed money (a cost
// < 0). A MarginMove's feeUsd sign is not trusted: the book counts |feeUsd| as a cost.

import type { JournalEntry, Mode, TxRef } from '@gimbal/shared';
import type { BookFill, BookRecord as LoopBookRecord, BookSink as LoopBookSink, MarginMove } from '../strategy/loop.ts';

export type { BookFill, MarginMove };

/** The loop's record, plus what a caller may know that it does not carry (yet). */
export interface BookRecord extends LoopBookRecord {
  /** Notional per leg the act sized, USD; absent = the fills' qty x avgPx. */
  legUsd?: number | null;
  leverage?: number | null;
  /** Margin posted for the pair (both legs), USD. */
  marginUsd?: number | null;
}

/** The loop's sink. PositionBook.record takes the loop's record as is (the extra fields are optional). */
export type BookSink = LoopBookSink;

/** A transfer made outside the loop (a rescue, the manual fund scripts), for PositionBook.addTransfer. */
export interface TransferInput {
  /** ms; default now. */
  at?: number;
  from: string;
  to: string;
  /** USD moved. Moving the desk's own money is not a cost; only `feeUsd` is. */
  usd: number;
  /** What it cost, USD, ≤ 0 (income > 0, costs < 0, as the journal counts money). */
  feeUsd: number;
  tx: TxRef[];
  /** The position it was for: an id, 'open' for the position open now (none open: the desk), or null for the desk. */
  positionId?: string | 'open' | null;
  source: 'rescue' | 'manual' | 'fund';
  note?: string;
}

/** Hyperliquid's userNonFundingLedgerUpdates row, the fields the book reads. */
export interface HlLedgerRow {
  time: number;
  hash: string;
  delta: {
    type: string;
    usdc?: string; amount?: string; token?: string; fee?: string;
    destination?: string; user?: string; toPerp?: boolean;
  };
}

export const BOOK_VERSION = 1;

// The JSONL lines. Each one is appended once and never changed; everything the book reports is derived from them.
export type BookEvent =
  | DeskEvent | EnterEvent | ExitEvent | FundingEvent | FeeEvent | TransferEvent | SyncEvent | JournalEvent;

/** The first line: which desk this book is, and the addresses its ledgers are read for. */
export interface DeskEvent {
  v: 1; type: 'desk'; at: number;
  mode: Mode; contract: string | null; desk: string | null;
  addresses: Record<string, string>;
}

export interface EnterEvent {
  v: 1; type: 'enter'; at: number;
  positionId: string;
  record: BookRecord;
  /** Opened outside the loop and adopted from the venues: no fills, entry time = when it was adopted. */
  adopted: boolean;
}

export interface ExitEvent {
  v: 1; type: 'exit'; at: number;
  /** null: an exit of a position the book never saw enter. */
  positionId: string | null;
  record: BookRecord;
}

/** One payment from a venue's own funding ledger, stored once (key = venue|time|symbol). */
export interface FundingEvent {
  v: 1; type: 'funding'; at: number;
  key: string;
  venue: string;
  symbol: string;
  /** ms, when the venue booked it. */
  time: number;
  /** Received > 0, paid < 0. */
  usd: number;
  /** Position size then, base units, signed. */
  size: number;
  ratePerHour: number;
  /** Hourly payments a venue-aggregated row sums; null on an hourly row. */
  samples: number | null;
  /** The position it was attributed to when stored (derive attributes again from the times). */
  positionId: string;
}

/** A fill fee read from the venue because the record did not carry it. */
export interface FeeEvent {
  v: 1; type: 'fee'; at: number;
  positionId: string;
  stage: 'enter' | 'exit';
  venue: string;
  /** Signed: a cost < 0. */
  usd: number;
  source: 'venue';
}

export interface TransferEvent {
  v: 1; type: 'transfer'; at: number;
  id: string;
  /** ms, when the transfer happened. */
  time: number;
  /** null: the desk's, not a position's. */
  positionId: string | null;
  from: string; to: string;
  /** Signed for the desk: in > 0, out < 0; 0 for a move between the desk's own accounts. */
  usd: number;
  /** ≤ 0. */
  feeUsd: number;
  tx: TxRef[];
  source: 'loop' | 'rescue' | 'manual' | 'fund' | 'hl-ledger';
  note: string | null;
}

/** A ledger read that went through: the next one starts from `to` less the overlap. */
export interface SyncEvent {
  v: 1; type: 'sync'; at: number;
  /** A venue id, or 'hyperliquid-ledger' for the non-funding ledger. */
  ledger: string;
  from: number; to: number;
  stored: number; duplicates: number; ignored: number;
}

/** A journal entry the book published, kept so a restart does not publish it again. */
export interface JournalEvent {
  v: 1; type: 'journal'; at: number;
  entry: JournalEntry;
  /** Funding entries: the position, the hour and the payment keys it covered. */
  positionId?: string;
  hour?: number;
  keys?: string[];
  late?: boolean;
}
