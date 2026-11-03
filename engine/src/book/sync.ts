// Ledger sync: reads the venues' own ledgers for the desk's addresses and turns what is new into book events. Read
// only: every call here is a venue's public info / history endpoint, nothing signs.
//
// Funding. Per venue, the read runs from the last good read's end less OVERLAP_MS (a restart, a late booking and an
// overlapping read all land on payments already stored, which the key drops) back to no earlier than the first hold
// that still needs it, up to now. A venue is read only while a position on it is open or closed less than SETTLE_MS
// before the last read. Each payment is stored once, keyed venue|time|symbol; rows one read gives twice for a key (a
// Phoenix trader's cross and isolated subaccounts in the same hour) are summed into one payment. A venue's daily
// aggregate row (Hyperliquid, after a week) is dropped when the book already holds hourly rows of that venue and
// symbol within a day of it, so a long-offline catch-up cannot count an hour twice. Payments no position's hold covers
// are not stored (counted as ignored).

import type { FundingPayment } from '../venues/venue.ts';
import { errorMessage } from '../venues/recorder.ts';
import { HOUR_MS, attribute, cursors, positionsOf, spans } from './derive.ts';
import type { BookEvent, BookRecord, FeeEvent, FundingEvent, HlLedgerRow, SyncEvent, TransferEvent } from './types.ts';
import type { TxRef } from '@gimbal/shared';

export const OVERLAP_MS = 6 * HOUR_MS;
export const SETTLE_MS = 2 * HOUR_MS;
export const AGGREGATE_GUARD_MS = 24 * HOUR_MS;
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
  /** What the venue charged for a record's fills on one leg (> 0 a cost), or null when it cannot say. */
  fillFee?: (q: FillFeeQuery) => Promise<number | null>;
  /** Tx refs for the Hyperliquid ledger rows. */
  hlTxRef?: (hash: string) => TxRef;
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
export function fundingWindow(events: readonly BookEvent[], venue: string, now: number): { from: number; to: number } | null {
  const cursor = cursors(events)[venue];
  const all = positionsOf(events);
  const bySpan = spans(all);
  let lo = Infinity;
  for (const list of bySpan.values()) {
    for (const s of list) {
      if (!s.position.legs.some((l) => l.venue === venue)) continue;
      const closed = s.position.exit?.record.at;
      if (closed !== undefined && cursor !== undefined && cursor >= closed + SETTLE_MS) continue;
      lo = Math.min(lo, s.lo);
    }
  }
  if (lo === Infinity) return null;
  const from = Math.max(0, Math.floor(cursor === undefined ? lo : Math.max(lo, cursor - OVERLAP_MS)));
  return from > now ? null : { from, to: Math.floor(now) };
}

/** New funding events from one read of `venue`'s ledger (pure: the read is passed in). */
export function fundingEvents(events: readonly BookEvent[], venue: string, rows: readonly FundingPayment[], read: { from: number; to: number }, now: number): BookEvent[] {
  const known = new Set<string>();
  const hourly: { symbol: string; time: number }[] = [];
  for (const e of events) {
    if (e.type !== 'funding') continue;
    known.add(e.key);
    if (e.venue === venue && e.samples === null) hourly.push({ symbol: e.symbol, time: e.time });
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
  const bySpan = spans(positionsOf(events));
  const out: FundingEvent[] = [];
  let duplicates = 0;
  let ignored = 0;
  for (const [key, r] of merged) {
    if (known.has(key)) {
      duplicates++;
      continue;
    }
    if (r.samples !== null && hourly.some((h) => h.symbol === r.symbol && Math.abs(h.time - r.time) <= AGGREGATE_GUARD_MS)) {
      duplicates++;
      continue;
    }
    const p = attribute({ venue, symbol: r.symbol, time: r.time, size: r.size }, bySpan);
    if (p === null) {
      ignored++;
      continue;
    }
    out.push({
      v: 1, type: 'funding', at: now, key, venue, symbol: r.symbol, time: r.time, usd: r.fundingUsd, size: r.size,
      ratePerHour: r.ratePerHour, samples: r.samples, positionId: p.id,
    });
  }
  out.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
  const sync: SyncEvent = { v: 1, type: 'sync', at: now, ledger: venue, from: read.from, to: read.to, stored: out.length, duplicates, ignored };
  return [...out, sync];
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
export function ledgerWindow(events: readonly BookEvent[], now: number): { from: number; to: number } | null {
  const cursor = cursors(events)[HL_LEDGER];
  const first = positionsOf(events).find((p) => p.legs.some((l) => l.venue === 'hyperliquid'));
  if (first === undefined) return null;
  const from = Math.max(0, Math.floor(cursor === undefined ? first.enter.record.at - LEDGER_LEAD_MS : cursor - OVERLAP_MS));
  return from > now ? null : { from, to: Math.floor(now) };
}

export function ledgerEvents(events: readonly BookEvent[], rows: readonly HlLedgerRow[], desk: string, read: { from: number; to: number }, txRef: (hash: string) => TxRef | null, now: number): BookEvent[] {
  const known = new Set(events.filter((e) => e.type === 'transfer').map((e) => (e as TransferEvent).id));
  const out: TransferEvent[] = [];
  let duplicates = 0;
  for (const r of rows) {
    const t = hlLedgerTransfer(r, desk, txRef, now);
    if (known.has(t.id)) {
      duplicates++;
      continue;
    }
    known.add(t.id);
    out.push(t);
  }
  return [...out, { v: 1, type: 'sync', at: now, ledger: HL_LEDGER, from: read.from, to: read.to, stored: out.length, duplicates, ignored: 0 }];
}

/** The fills whose fee is missing and not read yet: position, stage, venue, record. */
export function missingFees(events: readonly BookEvent[], now: number): { positionId: string; stage: 'enter' | 'exit'; venue: string; symbol: string; record: BookRecord }[] {
  const have = new Set((events.filter((e) => e.type === 'fee') as FeeEvent[]).map((f) => `${f.positionId}|${f.stage}|${f.venue}`));
  const out: { positionId: string; stage: 'enter' | 'exit'; venue: string; symbol: string; record: BookRecord }[] = [];
  for (const e of events) {
    if ((e.type !== 'enter' && e.type !== 'exit') || e.positionId === null) continue;
    if (e.type === 'enter' && e.adopted) continue;
    if (now - e.record.at > FEE_LOOKUP_MS) continue;
    for (const f of e.record.legs) {
      if (f.feeUsd !== null || have.has(`${e.positionId}|${e.type}|${f.venue}`)) continue;
      out.push({ positionId: e.positionId, stage: e.type, venue: f.venue, symbol: e.record.symbol, record: e.record });
    }
  }
  return out;
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
