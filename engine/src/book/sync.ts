// Ledger sync: reads the venues' own ledgers for the desk's addresses and turns what is new into book events. Read
// only: every call here is a venue's public info / history endpoint, nothing signs.
//
// Funding. Per venue, the read runs from the last good read's end less OVERLAP_MS (a restart, a late booking and an
// overlapping read all land on payments already stored, which the key drops) back to no earlier than the first hold
// that still needs it, up to now. A venue is read while a position on it is open or closed less than
// READ_AFTER_EXIT_MS before the last read: payments a venue books late for an hour of the hold still come in.
//
// Each payment is stored once, keyed venue|time|symbol. Rows one read gives twice for a key (a Phoenix trader's cross
// and isolated subaccounts in the same hour) are summed into one payment; when a later read sums a stored key
// differently (a subaccount's row showed up late), the difference is stored as an adjustment of that key.
//
// A venue's aggregated row (Hyperliquid: one row per UTC day after a week, `samples` hourly payments) stands for the
// hours of its UTC day. Hourly rows win: an aggregate is stored for the hours of its day no hourly row of that venue
// and symbol covers (its amount pro rata), and dropped when they cover them all; an hourly row on a day that already
// holds an aggregate is dropped. A long-offline catch-up cannot count an hour twice.
//
// What is known of the aggregate rows (a public mainnet userFunding answer read by hand, 2026-11-04): a row at 00:00:00
// UTC with nSamples 24 and the hourly fields (coin, usdc, szi, fundingRate); the last one sits at D 00:00 and the first
// hourly row after it at D+1 00:00, so a row stands for the 24 hours of its own UTC day. That its usdc is the sum of
// those hours, and how a partial day looks, are not verified: amounts from aggregate rows are marked as estimated
// (numbers.estimated = 1 in the funding entry, and the report says so).
//
// Payments no position's hold covers are not stored (counted as ignored).
//
// The sync line (the read's window and counts) is what tells the next read where to start. It is written when the read
// stored something, for a ledger's first read, and when the read crosses a position's settle or stop time; other
// reads move the cursor in memory only (the book's overlay), so an idle hour adds nothing to the file.

import type { TxRef } from '@gimbal/shared';
import type { FundingPayment } from '../venues/venue.ts';
import { errorMessage } from '../venues/recorder.ts';
import { HOUR_MS, SETTLE_MS, attribute, cursors, hourOf, positionsOf, spans } from './derive.ts';
import type {
  BookEvent, BookFill, BookRecord, FeeEvent, FundingEvent, HlLedgerRow, SyncEvent, TransferEvent,
} from './types.ts';

export const OVERLAP_MS = 24 * HOUR_MS;
/** A closed position's venues are read until this long after its exit. */
export const READ_AFTER_EXIT_MS = 24 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;
/** A fill fee missing from a record is asked of the venue for this long after the act. */
export const FEE_LOOKUP_MS = 24 * HOUR_MS;
/** The desk's non-funding ledger is read from this long before the first position. */
export const LEDGER_LEAD_MS = 24 * HOUR_MS;
export const HL_LEDGER = 'hyperliquid-ledger';

export interface FillFeeQuery {
  venue: string;
  address: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  /** When the act began (the record's startedAt); null for a record without one. */
  startedAt: number | null;
  /** When the act's record was written (its fills came before). */
  at: number;
  tx: TxRef[];
}

/** Where the book reads the ledgers. Every method only reads. */
export interface BookSources {
  /** Per venue id: the venue's funding ledger (VenueReader.userFunding). */
  funding: Partial<Record<string, { userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]> }>>;
  /** Hyperliquid userNonFundingLedgerUpdates of the desk, oldest first. */
  hlLedger?: (user: string, startTime: number, endTime: number) => Promise<HlLedgerRow[]>;
  /** What the venue charged for an act's fills on one venue and side (> 0 a cost), or null when it cannot say. */
  fillFee?: (q: FillFeeQuery) => Promise<number | null>;
  /** Tx refs for the Hyperliquid ledger rows. */
  hlTxRef?: (hash: string) => TxRef;
  /**
   * The desk's fills on one venue, symbol and side in [from, to], summed (size-weighted price, the venue's fee charge)
   * with the last fill's time; null when there are none. For a close made outside the loop with no close report.
   */
  closeFills?: (q: CloseFillQuery) => Promise<{ fill: BookFill; at: number } | null>;
}

export interface CloseFillQuery {
  venue: string;
  address: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  from: number;
  to: number;
}

export interface SyncLine {
  ledger: string;
  ok: boolean;
  text: string;
}

export function fundingKey(venue: string, time: number, symbol: string): string {
  return `${venue}|${time}|${symbol}`;
}

/** The read window for one venue's funding, or null when no position needs it. */
export function fundingWindow(
  events: readonly BookEvent[], venue: string, now: number, overlay: Readonly<Record<string, number>> = {},
): { from: number; to: number } | null {
  const cursor = cursors(events, overlay)[venue];
  let lo = Infinity;
  for (const list of spans(positionsOf(events)).values()) {
    for (const s of list) {
      if (!s.position.legs.some((l) => l.venue === venue)) continue;
      const closed = s.position.exit?.record.at;
      if (closed !== undefined && cursor !== undefined && cursor >= closed + READ_AFTER_EXIT_MS) continue;
      lo = Math.min(lo, s.lo);
    }
  }
  if (lo === Infinity) return null;
  const from = Math.max(0, Math.floor(cursor === undefined ? lo : Math.max(lo, cursor - OVERLAP_MS)));
  return from > now ? null : { from, to: Math.floor(now) };
}

const dayOf = (t: number) => Math.floor(hourOf(t) / DAY_MS) * DAY_MS;
const EPS = 1e-9;

/** New funding events from one read of `venue`'s ledger, then its sync line (pure: the read is passed in). */
export function fundingEvents(
  events: readonly BookEvent[], venue: string, rows: readonly FundingPayment[], read: { from: number; to: number }, now: number,
): BookEvent[] {
  // What is stored per key: the original row's amount plus its adjustments.
  const stored = new Map<string, { usd: number; samples: number | null; adjustments: number }>();
  const hourlyDays = new Map<string, Set<number>>();   // symbol|day -> hours with an hourly row
  const aggregateDays = new Set<string>();             // symbol|day with an aggregate stored
  const noteHour = (symbol: string, time: number) => {
    const k = `${symbol}|${dayOf(time)}`;
    const set = hourlyDays.get(k) ?? new Set<number>();
    set.add(hourOf(time));
    hourlyDays.set(k, set);
  };
  for (const e of events) {
    if (e.type !== 'funding' || e.venue !== venue) continue;
    const base = e.adjusts ?? e.key;
    const s = stored.get(base) ?? { usd: 0, samples: e.samples, adjustments: 0 };
    s.usd += e.usd;
    if (e.adjusts !== undefined) s.adjustments++;
    stored.set(base, s);
    if (e.adjusts === undefined) {
      if (e.samples === null) noteHour(e.symbol, e.time);
      else aggregateDays.add(`${e.symbol}|${dayOf(e.time)}`);
    }
  }
  const merged = new Map<string, FundingPayment>();
  for (const r of rows) {
    const k = fundingKey(venue, r.time, r.symbol);
    const m = merged.get(k);
    merged.set(k, m === undefined ? { ...r } : {
      ...m, fundingUsd: m.fundingUsd + r.fundingUsd, size: m.size + r.size,
      samples: m.samples === null && r.samples === null ? null : (m.samples ?? 1) + (r.samples ?? 1),
    });
  }
  for (const r of merged.values()) if (r.samples === null) noteHour(r.symbol, r.time);

  const bySpan = spans(positionsOf(events));
  const out: FundingEvent[] = [];
  let duplicates = 0;
  let ignored = 0;
  for (const [key, r] of merged) {
    const was = stored.get(key);
    if (was !== undefined) {
      // Hourly rows only: an aggregate is stored pro rata, its amount is not the row's.
      if (r.samples === null && Math.abs(r.fundingUsd - was.usd) > EPS * Math.max(1, Math.abs(r.fundingUsd))) {
        const p = attribute({ venue, symbol: r.symbol, time: r.time, size: r.size }, bySpan);
        if (p !== null) {
          out.push({
            v: 1, type: 'funding', at: now, key: `${key}|adj${was.adjustments + 1}`, venue, symbol: r.symbol, time: r.time,
            usd: r.fundingUsd - was.usd, size: r.size, ratePerHour: r.ratePerHour, samples: null, positionId: p.id, adjusts: key,
          });
          continue;
        }
      }
      duplicates++;
      continue;
    }
    let usd = r.fundingUsd;
    let samples = r.samples;
    const day = `${r.symbol}|${dayOf(r.time)}`;
    if (samples === null) {
      if (aggregateDays.has(day)) {
        duplicates++;
        continue;
      }
    } else {
      const covered = Math.min(hourlyDays.get(day)?.size ?? 0, samples);
      if (covered >= samples) {
        duplicates++;
        continue;
      }
      usd = (r.fundingUsd * (samples - covered)) / samples;
      samples -= covered;
    }
    const p = attribute({ venue, symbol: r.symbol, time: r.time, size: r.size }, bySpan);
    if (p === null) {
      ignored++;
      continue;
    }
    out.push({
      v: 1, type: 'funding', at: now, key, venue, symbol: r.symbol, time: r.time, usd, size: r.size,
      ratePerHour: r.ratePerHour, samples, positionId: p.id,
    });
  }
  out.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
  const sync: SyncEvent = { v: 1, type: 'sync', at: now, ledger: venue, from: read.from, to: read.to, stored: out.length, duplicates, ignored };
  return [...out, sync];
}

/**
 * Whether a read's sync line goes to the file: it stored something, it is the ledger's first, or it crosses a
 * position's settle (exit + SETTLE_MS) or stop (exit + READ_AFTER_EXIT_MS) time on that ledger's venue.
 */
export function keepSync(events: readonly BookEvent[], sync: SyncEvent): boolean {
  if (sync.stored > 0) return true;
  const was = cursors(events)[sync.ledger];
  if (was === undefined) return true;
  for (const p of positionsOf(events)) {
    if (p.exit === null || !p.legs.some((l) => l.venue === sync.ledger)) continue;
    for (const edge of [p.exit.record.at + SETTLE_MS, p.exit.record.at + READ_AFTER_EXIT_MS]) {
      if (was < edge && sync.to >= edge) return true;
    }
  }
  return false;
}

const ZERO_HASH = /^0x0*$/i;

/** Every tx id the book already holds for a transfer: transfer events' and the records' margin moves'. Lower case. */
export function knownTxIds(events: readonly BookEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (refs: readonly TxRef[], id: string) => {
    for (const t of refs) if (t.id !== '' && !ZERO_HASH.test(t.id) && !out.has(t.id.toLowerCase())) out.set(t.id.toLowerCase(), id);
  };
  for (const e of events) {
    if (e.type === 'transfer') add(e.tx, e.id);
    else if (e.type === 'enter' || e.type === 'exit' || e.type === 'fill') {
      e.record.marginMoves.forEach((m, i) => add(m.tx, `loop:${e.record.windowId}:${e.record.kind}:${e.record.at}:${i}`));
    }
  }
  return out;
}

/** A Hyperliquid ledger row as the desk's transfer: in > 0, out < 0, a move between its own accounts 0. */
export function hlLedgerTransfer(row: HlLedgerRow, desk: string, txRef: (hash: string) => TxRef | null, now: number): TransferEvent {
  const d = row.delta;
  const me = desk.toLowerCase();
  const num = (s: string | undefined) => {
    const n = Number(s);
    return s === undefined || s === '' || !Number.isFinite(n) ? 0 : n;
  };
  const usdc = d.usdc !== undefined ? num(d.usdc) : d.token === undefined || d.token === 'USDC' ? num(d.amount) : 0;
  const fee = -Math.abs(num(d.fee));
  const to = d.destination?.toLowerCase();
  const from = d.user?.toLowerCase();
  let usd = 0;
  let note = d.type;
  let src = 'hyperliquid';
  let dst = 'hyperliquid';
  switch (d.type) {
    case 'deposit':
      usd = usdc;
      src = 'bridge';
      break;
    case 'withdraw':
      usd = -Math.abs(usdc);
      dst = 'bridge';
      break;
    case 'send': case 'internalTransfer': case 'spotTransfer':
      if (from === me && to !== me) {
        usd = -Math.abs(usdc);
        dst = d.destination ?? 'unknown';
      } else if (to === me && from !== me) {
        usd = Math.abs(usdc);
        src = d.user ?? 'unknown';
      }
      if (d.token !== undefined && d.token !== 'USDC') note = `${d.type} ${d.token}: not counted`;
      break;
    case 'accountClassTransfer':
      note = `accountClassTransfer ${d.toPerp === true ? 'spot -> perp' : 'perp -> spot'}`;
      break;
    default:
      note = `${d.type}: not counted`;
  }
  const ref = txRef(row.hash);
  return {
    v: 1, type: 'transfer', at: now, id: `hl:${row.hash}:${row.time}:${d.type}`, time: row.time, positionId: null,
    from: src, to: dst, usd, feeUsd: usd === 0 ? 0 : fee || 0, tx: ref === null ? [] : [ref], source: 'hl-ledger', note,
  };
}

/** The read window of the desk's Hyperliquid ledger, or null without positions. */
export function ledgerWindow(events: readonly BookEvent[], now: number, overlay: Readonly<Record<string, number>> = {}): { from: number; to: number } | null {
  const cursor = cursors(events, overlay)[HL_LEDGER];
  const first = positionsOf(events).find((p) => p.legs.some((l) => l.venue === 'hyperliquid'));
  if (first === undefined) return null;
  const from = Math.max(0, Math.floor(cursor === undefined ? first.enter.record.at - LEDGER_LEAD_MS : cursor - OVERLAP_MS));
  return from > now ? null : { from, to: Math.floor(now) };
}

/**
 * New transfers from one read of the desk's Hyperliquid ledger, then its sync line. A row is the same transfer as one
 * the book holds when its id is, or when its hash is a tx the book already holds from addTransfer or the loop's margin
 * moves: it is never counted twice.
 */
export function ledgerEvents(
  events: readonly BookEvent[], rows: readonly HlLedgerRow[], desk: string, read: { from: number; to: number },
  txRef: (hash: string) => TxRef | null, now: number,
): BookEvent[] {
  const known = new Set(events.filter((e): e is TransferEvent => e.type === 'transfer').map((e) => e.id));
  const txIds = knownTxIds(events.filter((e) => e.type !== 'transfer' || e.source !== 'hl-ledger'));
  const out: TransferEvent[] = [];
  let duplicates = 0;
  for (const r of rows) {
    const t = hlLedgerTransfer(r, desk, txRef, now);
    if (known.has(t.id) || txIds.has(r.hash.toLowerCase())) {
      duplicates++;
      continue;
    }
    known.add(t.id);
    out.push(t);
  }
  return [...out, { v: 1, type: 'sync', at: now, ledger: HL_LEDGER, from: read.from, to: read.to, stored: out.length, duplicates, ignored: 0 }];
}

/** Fills of one record on one venue and side whose fee is missing and not read yet. */
export interface MissingFee {
  positionId: string | null;
  stage: 'enter' | 'exit' | 'fill';
  venue: string;
  side: 'BUY' | 'SELL';
  symbol: string;
  record: BookRecord;
  /** The fills' indexes in record.legs. */
  indexes: number[];
}

/** The records' fills with no fee, per record, venue and side (one venue read covers them all). */
export function missingFees(events: readonly BookEvent[], now: number): MissingFee[] {
  const have = new Set(events.filter((e): e is FeeEvent => e.type === 'fee').map((f) => `${f.positionId}|${f.recordAt}|${f.index}`));
  const out: MissingFee[] = [];
  for (const e of events) {
    if (e.type !== 'enter' && e.type !== 'exit' && e.type !== 'fill') continue;
    if (e.type === 'enter' && e.adopted) continue;
    if (now - e.record.at > FEE_LOOKUP_MS) continue;
    const groups = new Map<string, MissingFee>();
    e.record.legs.forEach((f, i) => {
      if (f.feeUsd !== null || have.has(`${e.positionId}|${e.record.at}|${i}`)) return;
      const q = Number(f.qty);
      if (!Number.isFinite(q) || q <= 0) return;
      const k = `${f.venue}|${f.side}`;
      const g = groups.get(k) ?? { positionId: e.positionId, stage: e.type, venue: f.venue, side: f.side, symbol: e.record.symbol, record: e.record, indexes: [] };
      g.indexes.push(i);
      groups.set(k, g);
    });
    out.push(...groups.values());
  }
  return out;
}

/** The fee events for a group, the venue's charge split over its fills by size (signed: a cost < 0). */
export function feeEvents(m: MissingFee, charged: number, now: number): FeeEvent[] {
  const qty = m.indexes.map((i) => Number(m.record.legs[i]!.qty));
  const total = qty.reduce((a, b) => a + b, 0);
  return m.indexes.map((index, k) => ({
    v: 1, type: 'fee', at: now, positionId: m.positionId, stage: m.stage, recordAt: m.record.at, index, venue: m.venue,
    usd: -(charged * (total > 0 ? qty[k]! / total : 1 / m.indexes.length)) || 0, source: 'venue',
  }));
}

/** One line for the log about a read. */
export function syncLine(ledger: string, added: readonly BookEvent[]): SyncLine {
  const s = added.find((e): e is SyncEvent => e.type === 'sync');
  if (s === undefined) return { ledger, ok: true, text: `${ledger}: nothing to read` };
  return {
    ledger, ok: true,
    text: `${ledger}: ${new Date(s.from).toISOString()} .. ${new Date(s.to).toISOString()}: ${s.stored} new, ${s.duplicates} already booked${s.ignored > 0 ? `, ${s.ignored} outside every hold` : ''}`,
  };
}

export function failedLine(ledger: string, err: unknown): SyncLine {
  return { ledger, ok: false, text: `${ledger}: not read (${errorMessage(err)}); the next sync starts from the last good read` };
}
