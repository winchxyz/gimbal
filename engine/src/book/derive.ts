// Pure: the book's events -> positions and their results. Nothing here reads a clock, a file or a venue.
//
// The hold. A position's hold starts at its entry record's `startedAt` (when the act began, before its first order)
// or, for a record without one, at its `at` less ENTRY_SLACK_MS (written once the open has finished, and a fill can
// precede a funding time by a few minutes); never before the previous exit on the same venue and symbol. It ends at
// the exit record's `at`. An adopted position starts at its adoption time.
//
// Attribution. A funding payment belongs to the position with a leg on its venue and symbol whose hold covers its time
// and whose leg side agrees with the payment's signed size (a short leg takes only rows with size < 0). Everything else
// is not this position's: it is never counted.
//
// Results, per position. Money is signed: income > 0, costs < 0.
// - funding: the venue ledgers' own payments, per leg and in total, as read so far (`fundingThrough`: the earliest of
//   its legs' last ledger reads, within the hold);
// - fees: every fill's fee: the entry's, the exit's and those of acts on it that did not end as asked (`fill`
//   records). The record's, else the venue's read later; unknown ones are counted apart, never as 0 silently. A record
//   with no fills keeps its own fee sum, as charged (a rebate stays a rebate);
// - transfers: the fees of margin moves tied to the position (the loop's and addTransfer's); moving the desk's own
//   money is not a cost;
// - price: once closed, every fill's cash flow (a sell + qty x price, a buy - qty x price) when each venue nets to
//   flat and every fill is priced: the slippage and basis the forecast priced in; null otherwise;
// - net = funding + fees + transfers + price;
// - actual APR, on the forecast's basis: (funding + fees + price) / leg notional, annualised over the hours the
//   ledgers have been read for (`aprHours`), open or closed: the APR never counts hours whose funding is not read yet.
//   The forecast's net APR leaves margin moves out (Window.costs), so transfers are left out here too; they are in
//   net. Leg notional = the record's legUsd, else the mean of the legs' entry qty x price.
// - settled: closed, and every leg's ledger read past the exit + SETTLE_MS: the numbers are final.

import type { TxRef } from '@gimbal/shared';
import type {
  BookEvent, BookFill, BookRecord, DeskEvent, EnterEvent, ExitEvent, FillEvent, FundingEvent, TransferEvent,
} from './types.ts';

export const HOUR_MS = 3_600_000;
export const HOURS_A_YEAR = 8760;
export const ENTRY_SLACK_MS = 10 * 60_000;
/** A closed position's numbers are final once each leg's ledger is read this long past the exit. */
export const SETTLE_MS = 2 * HOUR_MS;

/**
 * Venues that pay once per funding period, not every hour (Orderly: 8 h, 4 h on some symbols). Their row is one exact
 * payment standing for `samples` hours: never an estimate, and an hour without one is not a missing payment.
 */
export const PERIODIC_FUNDING_VENUES: ReadonlySet<string> = new Set(['orderly']);

/** A row whose amount stands for hours the venue aggregated (Hyperliquid's daily rows): an estimate per hour. */
export function isEstimate(f: { venue: string; samples: number | null }): boolean {
  return f.samples !== null && !PERIODIC_FUNDING_VENUES.has(f.venue);
}

export interface Position {
  id: string;
  windowId: string;
  symbol: string;
  enter: EnterEvent;
  exit: ExitEvent | null;
  /** Fills of acts on it that did not end as asked. */
  fills: FillEvent[];
  legs: { venue: string; side: 'long' | 'short' }[];
}

export interface LegResult {
  venue: string;
  side: 'long' | 'short';
  /** Base units opened. */
  qty: number | null;
  entryPx: number | null;
  /** The size-weighted price of the fills that reduced it (partial closes and the exit). */
  exitPx: number | null;
  /** Signed (a cost < 0); null when a fill's fee is unknown. */
  entryFeeUsd: number | null;
  /** Every later fill's fees (fill records and the exit); null when there are none or one is unknown. */
  exitFeeUsd: number | null;
  fundingUsd: number;
  payments: number;
  /** Hours with a payment booked (an aggregated row counts its samples). */
  paidHours: number;
  /** Of fundingUsd: what Hyperliquid's daily aggregate rows give (their split per hour is not verified: an estimate). */
  estimatedUsd: number;
  /** Hours paid through aggregate rows. */
  estimatedHours: number;
  /** Funding times (top of the hour) inside the hold, up to the last read of this venue's ledger. */
  hours: number;
  /**
   * A venue paying once per funding period only (PERIODIC_FUNDING_VENUES): its latest period (from its payments, else
   * the default), the funding times inside the hold up to the last read (each interval on its own period), and
   * whether its ledger was read.
   */
  periodic?: { periodHours: number; due: number; read: boolean };
}

/** The period assumed for a periodic venue's leg before any payment says otherwise (Orderly's usual 8 h). */
export const DEFAULT_FUNDING_PERIOD_HOURS = 8;

type PeriodRow = { time: number; samples: number | null; adjusts?: string };

/** A periodic venue's payments that state a period, oldest first. */
function periodRows(rows: readonly PeriodRow[]): PeriodRow[] {
  return rows.filter((r) => r.adjusts === undefined && r.samples !== null && r.samples > 0).sort((a, b) => a.time - b.time);
}

/**
 * The period in force at `t`: that of the first payment at or after it (the payment that ends its interval), else
 * that of the last one before it, else the default.
 */
export function fundingPeriodAt(rows: readonly PeriodRow[], t: number): number {
  const pays = periodRows(rows);
  return (pays.find((r) => r.time >= t) ?? pays.at(-1))?.samples ?? DEFAULT_FUNDING_PERIOD_HOURS;
}

/** The funding times in (from, to], each payment interval counted on its own payment's period. */
export function periodicOf(rows: readonly FundingEvent[], from: number, to: number, read: boolean): { periodHours: number; due: number; read: boolean } {
  const pays = periodRows(rows);
  let due = 0;
  let at = from;
  for (const r of pays) {
    if (r.time <= at) continue;
    const end = Math.min(r.time, to);
    due += periodTimesIn(at, end, r.samples!);
    at = end;
    if (at >= to) break;
  }
  const last = pays.at(-1)?.samples ?? DEFAULT_FUNDING_PERIOD_HOURS;
  if (at < to) due += periodTimesIn(at, to, last);
  return { periodHours: last, due, read };
}

/** Funding times on a UTC grid of `periodHours` in (from, to]. */
export function periodTimesIn(from: number, to: number, periodHours: number): number {
  const p = periodHours * HOUR_MS;
  if (!(to > from)) return 0;
  return Math.floor(to / p) - Math.floor(from / p);
}

export interface PositionResult {
  id: string;
  windowId: string;
  symbol: string;
  open: boolean;
  adopted: boolean;
  legs: LegResult[];
  /** When the act began (the record's startedAt, else its time): held and APR hours count from here. */
  startedAt: number;
  enteredAt: number;
  exitedAt: number | null;
  heldHours: number;
  /** The hours the APR is annualised over: from the start to `fundingThrough`. */
  aprHours: number;
  /** ms: every leg's funding is read up to here (within the hold); null before every leg's ledger was read. */
  fundingThrough: number | null;
  /** Closed and every leg read past exit + SETTLE_MS: the numbers are final. */
  settled: boolean;
  /** When the settled (final) journal entry was written; null before it. */
  finalAt: number | null;
  /** Funding booked after the final entry (a late booking): an adjustment against it, in fundingUsd and net. */
  afterFinalUsd: number;
  /** Of fundingUsd: from aggregate rows (estimated). */
  estimatedUsd: number;
  by: 'auto' | 'manual';
  exitBy: 'auto' | 'manual' | null;
  exitReason: string | null;
  /** The exit's closing fills were never read (BookRecord.fillsUnread): its price and close fees are unknown. */
  fillsUnread: boolean;
  /** The position this one was rotated out of / into (position ids; a window id when the other side is not booked). */
  rotatedFrom: string | null;
  rotatedTo: string | null;
  entryTx: TxRef[];
  exitTx: TxRef[];
  /** Acts on it that did not end as asked but filled something. */
  partialFills: number;
  forecastNetAprPct: number | null;
  legUsd: number | null;
  leverage: number | null;
  marginUsd: number | null;
  fundingUsd: number;
  entryFeesUsd: number;
  exitFeesUsd: number;
  feesUsd: number;
  /** Fills whose fee neither the record nor the venue gave. */
  unknownFees: number;
  transferCostUsd: number;
  transfers: number;
  priceUsd: number | null;
  /** funding + fees + price (price only once closed): what the APR is computed on. */
  carryUsd: number;
  netUsd: number;
  actualAprPct: number | null;
  netOnMarginPct: number | null;
}

export interface DeskTransfers {
  inUsd: number;
  outUsd: number;
  feeUsd: number;
  count: number;
}

/** Fills of acts that left no position (a failed open that ended flat): the desk's cost. */
export interface StrayFills {
  count: number;
  feesUsd: number;
  unknownFees: number;
  /** Their cash flow when every venue nets to flat and every fill is priced; else null. */
  priceUsd: number | null;
}

export interface BookTotals {
  positions: number;
  open: number;
  fundingUsd: number;
  fundingByVenue: Record<string, number>;
  /** Positions' fees and the stray fills'. */
  feesUsd: number;
  transferCostUsd: number;
  priceUsd: number;
  netUsd: number;
  heldHours: number;
}

export interface BookSummary {
  version: 1;
  at: number;
  desk: { mode: string; contract: string | null; desk: string | null; addresses: Record<string, string> } | null;
  positions: PositionResult[];
  totals: BookTotals;
  /** Deposits, withdrawals and transfers not tied to a position (the desk's), and their fees. */
  deskTransfers: DeskTransfers;
  strayFills: StrayFills;
  /** Exits of positions the book never saw enter. */
  orphanExits: { windowId: string; at: number; exitReason: string | null }[];
  /** Per ledger: the end of the last read that went through (ms). */
  cursors: Record<string, number>;
  events: number;
}

/** A position's id: its window and the entry time (ISO, to the second). */
export function positionIdOf(windowId: string, at: number): string {
  return `${windowId}@${new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

/** BUY opens a long, SELL a short. */
export function legSide(fill: BookFill): 'long' | 'short' {
  return fill.side === 'BUY' ? 'long' : 'short';
}

/** The hour a payment is for: venues book at the top of the hour, a few ms or s either way. */
export function hourOf(time: number): number {
  return Math.round(time / HOUR_MS) * HOUR_MS;
}

/** Funding times (whole hours) in (from, to]. */
export function hoursIn(from: number, to: number): number {
  if (!(to > from)) return 0;
  return Math.floor(to / HOUR_MS) - Math.floor(from / HOUR_MS);
}

/** Where an entry's hold starts, before the previous exit's floor. */
export function holdStart(e: EnterEvent): number {
  const r = e.record;
  if (e.adopted) return r.at;
  const s = r.startedAt;
  return typeof s === 'number' && Number.isFinite(s) && s <= r.at ? s : r.at - ENTRY_SLACK_MS;
}

/** When the act began: startedAt, else the record time (an adopted position: its adoption time). */
export function actStart(e: EnterEvent): number {
  const r = e.record;
  const s = r.startedAt;
  return !e.adopted && typeof s === 'number' && Number.isFinite(s) && s <= r.at ? s : r.at;
}

export function positionsOf(events: readonly BookEvent[]): Position[] {
  const out: Position[] = [];
  const byId = new Map<string, Position>();
  for (const e of events) {
    if (e.type === 'enter') {
      const p: Position = {
        id: e.positionId, windowId: e.record.windowId, symbol: e.record.symbol, enter: e, exit: null, fills: [],
        legs: dedupeLegs(e.record.legs),
      };
      out.push(p);
      byId.set(p.id, p);
    } else if (e.type === 'exit' && e.positionId !== null) {
      const p = byId.get(e.positionId);
      if (p !== undefined && p.exit === null) p.exit = e;
    } else if (e.type === 'fill' && e.positionId !== null) {
      byId.get(e.positionId)?.fills.push(e);
    }
  }
  return out;
}

/** One leg per venue: the side of its first fill. */
function dedupeLegs(fills: readonly BookFill[]): { venue: string; side: 'long' | 'short' }[] {
  const out: { venue: string; side: 'long' | 'short' }[] = [];
  for (const f of fills) if (!out.some((l) => l.venue === f.venue)) out.push({ venue: f.venue, side: legSide(f) });
  return out;
}

/** The open position with this window id, else null (the latest one if several, which the loop never makes). */
export function openPosition(positions: readonly Position[], windowId?: string): Position | null {
  for (let i = positions.length - 1; i >= 0; i--) {
    const p = positions[i]!;
    if (p.exit === null && (windowId === undefined || p.windowId === windowId)) return p;
  }
  return null;
}

export interface Span { position: Position; side: 'long' | 'short'; lo: number; hi: number }

/** Each position's attribution span per venue and symbol. */
export function spans(positions: readonly Position[]): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  for (const p of positions) {
    for (const leg of p.legs) {
      const key = `${leg.venue}|${p.symbol}`;
      const list = out.get(key) ?? [];
      // The latest exit before this entry on the same venue and symbol bounds the start.
      let floor = -Infinity;
      for (const s of list) if (s.hi <= p.enter.record.at && s.hi > floor) floor = s.hi;
      list.push({ position: p, side: leg.side, lo: Math.max(holdStart(p.enter), floor), hi: p.exit?.record.at ?? Infinity });
      out.set(key, list);
    }
  }
  return out;
}

/** The position a payment belongs to, or null. */
export function attribute(
  payment: { venue: string; symbol: string; time: number; size: number },
  bySpan: Map<string, Span[]>,
): Position | null {
  const list = bySpan.get(`${payment.venue}|${payment.symbol}`);
  if (list === undefined) return null;
  let hit: Span | null = null;
  for (const s of list) {
    if (payment.time < s.lo || payment.time >= s.hi) continue;
    if (payment.size !== 0 && (payment.size < 0) !== (s.side === 'short')) continue;
    if (hit === null || s.lo > hit.lo) hit = s;
  }
  return hit?.position ?? null;
}

/** The end of the last read that went through, per ledger: the stored sync lines, then `overlay` (reads kept in memory). */
export function cursors(events: readonly BookEvent[], overlay: Readonly<Record<string, number>> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) if (e.type === 'sync' && (out[e.ledger] === undefined || e.to > out[e.ledger]!)) out[e.ledger] = e.to;
  for (const [k, t] of Object.entries(overlay)) if (out[k] === undefined || t > out[k]!) out[k] = t;
  return out;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** Which fill a fee belongs to: the record (position, stage time) and the fill's index in its legs. */
export const feeKey = (positionId: string | null, recordAt: number, index: number) => `${positionId}|${recordAt}|${index}`;

/** Everything positionResult reads, indexed once. */
export interface BookIndex {
  all: Position[];
  bySpan: Map<string, Span[]>;
  funding: Map<string, FundingEvent[]>;
  fees: Map<string, number>;
  transfers: Map<string, TransferEvent[]>;
  cursors: Record<string, number>;
  /** Position id -> when its settled (final) journal entry was written. */
  finals: Map<string, number>;
}

export function indexBook(events: readonly BookEvent[], overlay: Readonly<Record<string, number>> = {}): BookIndex {
  const all = positionsOf(events);
  const bySpan = spans(all);
  const funding = new Map<string, FundingEvent[]>();
  const fees = new Map<string, number>();
  const transfers = new Map<string, TransferEvent[]>();
  const finals = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'funding') {
      const p = attribute(e, bySpan);
      if (p === null) continue;
      const list = funding.get(p.id) ?? [];
      list.push(e);
      funding.set(p.id, list);
    } else if (e.type === 'fee') {
      fees.set(feeKey(e.positionId, e.recordAt, e.index), e.usd);
    } else if (e.type === 'transfer' && e.positionId !== null) {
      const list = transfers.get(e.positionId) ?? [];
      list.push(e);
      transfers.set(e.positionId, list);
    } else if (e.type === 'journal' && e.settled === true && e.positionId !== undefined && !finals.has(e.positionId)) {
      finals.set(e.positionId, e.at);
    }
  }
  return { all, bySpan, funding, fees, transfers, cursors: cursors(events, overlay), finals };
}

interface Costs { usd: number; unknown: number }

/**
 * A record's fill fees, signed (a cost < 0): every fill on `venue` (all venues when undefined). A record with no fills
 * keeps the loop's own sum, as charged (> 0 a cost, so a rebate stays a rebate); it is counted when `venue` is
 * undefined only.
 */
export function recordFees(record: BookRecord, positionId: string | null, fees: Map<string, number>, venue?: string): Costs {
  if (record.legs.length === 0) {
    const usd = venue === undefined && Number.isFinite(record.feeUsd) && record.feeUsd !== 0 ? -record.feeUsd : 0;
    return { usd, unknown: 0 };
  }
  let usd = 0;
  let unknown = 0;
  record.legs.forEach((f, i) => {
    if (venue !== undefined && f.venue !== venue) return;
    if (f.feeUsd !== null && Number.isFinite(f.feeUsd)) {
      if (f.feeUsd !== 0) usd -= f.feeUsd;
      return;
    }
    const read = fees.get(feeKey(positionId, record.at, i));
    if (read === undefined) unknown++;
    else usd += read;
  });
  return { usd, unknown };
}

/** Every fill's cash flow (a sell brings qty x price in, a buy pays it) and whether each venue nets to flat. */
export function cashFlow(records: readonly BookRecord[]): { usd: number | null; flat: boolean } {
  const net = new Map<string, { qty: number; gross: number }>();
  let usd = 0;
  let priced = true;
  for (const r of records) {
    for (const f of r.legs) {
      const q = Number(f.qty);
      if (!Number.isFinite(q) || q <= 0) continue;
      const sign = f.side === 'SELL' ? 1 : -1;
      if (f.avgPx === null || !Number.isFinite(f.avgPx)) priced = false;
      else usd += sign * q * f.avgPx;
      const n = net.get(f.venue) ?? { qty: 0, gross: 0 };
      n.qty -= sign * q;
      n.gross += q;
      net.set(f.venue, n);
    }
  }
  const flat = [...net.values()].every((n) => Math.abs(n.qty) <= 1e-9 * Math.max(1, n.gross));
  return { usd: priced ? usd : null, flat };
}

function weightedPx(fills: readonly BookFill[]): number | null {
  let q = 0;
  let n = 0;
  for (const f of fills) {
    const x = Number(f.qty);
    if (!Number.isFinite(x) || x <= 0 || f.avgPx === null) continue;
    q += x;
    n += x * f.avgPx;
  }
  return q > 0 ? n / q : null;
}

function positiveOrNull(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null;
}

function finiteOrNull(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** The records after the entry: fill records, then the exit. */
function laterRecords(p: Position): BookRecord[] {
  return [...p.fills.map((f) => f.record), ...(p.exit === null ? [] : [p.exit.record])];
}

export function positionResult(p: Position, ix: BookIndex, now: number): PositionResult {
  const payments = ix.funding.get(p.id) ?? [];
  const transfers = ix.transfers.get(p.id) ?? [];
  const enter = p.enter.record;
  const exit = p.exit?.record ?? null;
  const later = laterRecords(p);
  const end = exit?.at ?? now;
  const open = exit === null;
  // Attribution and the funding hours count from the span's start (the slack included); held and APR hours from the
  // act's own start when the record has it, else from the record time.
  const start = p.legs.length === 0 ? holdStart(p.enter)
    : ix.bySpan.get(`${p.legs[0]!.venue}|${p.symbol}`)?.find((s) => s.position === p)?.lo ?? holdStart(p.enter);
  const began = Math.max(start, actStart(p.enter));
  /** Where a venue's ledger has been read to, within the hold (the start when never read). */
  const readTo = (venue: string) => Math.max(start, Math.min(end, ix.cursors[venue] ?? start));
  const entryCosts = (venue?: string): Costs => (p.enter.adopted ? { usd: 0, unknown: 0 } : recordFees(enter, p.id, ix.fees, venue));

  const legs: LegResult[] = p.legs.map((leg) => {
    const opening = enter.legs.filter((f) => f.venue === leg.venue);
    const reducing = later.flatMap((r) => r.legs).filter((f) => f.venue === leg.venue && legSide(f) !== leg.side);
    const entry = entryCosts(leg.venue);
    const exits = later.map((r) => recordFees(r, p.id, ix.fees, leg.venue));
    const mine = payments.filter((f) => f.venue === leg.venue);
    const hourly = new Set(mine.filter((f) => f.samples === null).map((f) => hourOf(f.time)));
    const aggregated = sum(mine.filter((f) => f.samples !== null && f.adjusts === undefined).map((f) => f.samples!));
    const qty = sum(opening.map((f) => Number(f.qty)).filter((x) => Number.isFinite(x) && x > 0));
    return {
      venue: leg.venue, side: leg.side, qty: qty > 0 ? qty : null,
      entryPx: weightedPx(opening), exitPx: weightedPx(reducing),
      entryFeeUsd: entry.unknown > 0 ? null : entry.usd,
      exitFeeUsd: later.length === 0 || exits.some((x) => x.unknown > 0) ? null : sum(exits.map((x) => x.usd)),
      fundingUsd: sum(mine.map((f) => f.usd)), payments: mine.filter((f) => f.adjusts === undefined).length,
      paidHours: hourly.size + aggregated, hours: hoursIn(start, readTo(leg.venue)),
      estimatedUsd: sum(mine.filter(isEstimate).map((f) => f.usd)),
      estimatedHours: sum(mine.filter((f) => isEstimate(f) && f.adjusts === undefined).map((f) => f.samples!)),
      ...(PERIODIC_FUNDING_VENUES.has(leg.venue) ? { periodic: periodicOf(mine, start, readTo(leg.venue), ix.cursors[leg.venue] !== undefined) } : {}),
    };
  });

  const entry = entryCosts();
  const exits = later.map((r) => recordFees(r, p.id, ix.fees));
  const entryFeesUsd = entry.usd;
  const exitFeesUsd = sum(exits.map((x) => x.usd));
  const feesUsd = entryFeesUsd + exitFeesUsd;
  const unknownFees = entry.unknown + sum(exits.map((x) => x.unknown));
  const moves = [...enter.marginMoves, ...later.flatMap((r) => r.marginMoves)];
  const transferCostUsd = sum(moves.map((m) => -Math.abs(m.feeUsd) || 0)) + sum(transfers.map((t) => t.feeUsd));
  const fundingUsd = sum(legs.map((l) => l.fundingUsd));

  let priceUsd: number | null = null;
  if (!open && !p.enter.adopted) {
    const flow = cashFlow([enter, ...later]);
    if (flow.flat && flow.usd !== null) priceUsd = flow.usd;
  }
  const carryUsd = fundingUsd + feesUsd + (priceUsd ?? 0);
  const netUsd = carryUsd + transferCostUsd;
  const heldHours = Math.max(0, end - began) / HOUR_MS;
  const fundingThrough = p.legs.length === 0 || p.legs.some((l) => ix.cursors[l.venue] === undefined)
    ? null : Math.min(...p.legs.map((l) => readTo(l.venue)));
  const aprHours = fundingThrough === null ? 0 : Math.max(0, fundingThrough - began) / HOUR_MS;
  const legUsd = positiveOrNull(enter.legUsd) ?? entryNotional(enter.legs);
  const marginUsd = positiveOrNull(enter.marginUsd);
  const actualAprPct = legUsd !== null && aprHours > 0 ? (carryUsd / legUsd) * (HOURS_A_YEAR / aprHours) * 100 : null;
  const settled = exit !== null && p.legs.length > 0
    && p.legs.every((l) => (ix.cursors[l.venue] ?? -Infinity) >= exit.at + SETTLE_MS);

  const rotatedFrom = enter.rotation === null ? null
    : ix.all.find((q) => q.windowId === enter.rotation!.fromId && q.exit?.record.rotation?.toId === enter.rotation!.toId)?.id ?? enter.rotation.fromId;
  const rotatedTo = exit === null || exit.rotation === null ? null
    : ix.all.find((q) => q.windowId === exit.rotation!.toId && q.enter.record.rotation?.fromId === exit.rotation!.fromId && q.enter.record.at >= exit.at)?.id ?? exit.rotation.toId;

  return {
    id: p.id, windowId: p.windowId, symbol: p.symbol, open, adopted: p.enter.adopted, legs,
    startedAt: began, enteredAt: enter.at, exitedAt: exit?.at ?? null, heldHours, aprHours, fundingThrough, settled,
    finalAt: ix.finals.get(p.id) ?? null,
    afterFinalUsd: ix.finals.has(p.id) ? sum(payments.filter((f) => f.at > ix.finals.get(p.id)!).map((f) => f.usd)) : 0,
    estimatedUsd: sum(legs.map((l) => l.estimatedUsd)),
    by: enter.by, exitBy: exit?.by ?? null, exitReason: exit?.exitReason ?? null, fillsUnread: exit?.fillsUnread === true, rotatedFrom, rotatedTo,
    entryTx: enter.tx, exitTx: exit?.tx ?? [], partialFills: p.fills.length,
    forecastNetAprPct: finiteOrNull(enter.forecastNetAprPct), legUsd, leverage: positiveOrNull(enter.leverage), marginUsd,
    fundingUsd, entryFeesUsd, exitFeesUsd, feesUsd, unknownFees,
    transferCostUsd, transfers: moves.length + transfers.length,
    priceUsd, carryUsd, netUsd, actualAprPct,
    netOnMarginPct: marginUsd === null ? null : (netUsd / marginUsd) * 100,
  };
}

/** The entry fills' notional per venue, averaged over the venues; null when one is unknown. */
function entryNotional(fills: readonly BookFill[]): number | null {
  const byVenue = new Map<string, number>();
  for (const f of fills) {
    const q = Number(f.qty);
    if (f.avgPx === null || !Number.isFinite(q) || q <= 0) return null;
    byVenue.set(f.venue, (byVenue.get(f.venue) ?? 0) + q * f.avgPx);
  }
  if (byVenue.size === 0) return null;
  return sum([...byVenue.values()]) / byVenue.size;
}

/** Fill records with no position (a failed open that left the desk flat): their fees and cash flow. */
export function strayFills(events: readonly BookEvent[], fees: Map<string, number>): StrayFills {
  const records = events.filter((e): e is FillEvent => e.type === 'fill' && e.positionId === null).map((e) => e.record);
  let feesUsd = 0;
  let unknownFees = 0;
  for (const r of records) {
    const c = recordFees(r, null, fees);
    feesUsd += c.usd;
    unknownFees += c.unknown;
  }
  const flow = cashFlow(records);
  return { count: records.length, feesUsd, unknownFees, priceUsd: records.length === 0 ? 0 : flow.flat ? flow.usd : null };
}

export function summarize(events: readonly BookEvent[], now: number, overlay: Readonly<Record<string, number>> = {}): BookSummary {
  const ix = indexBook(events, overlay);
  const positions = ix.all.map((p) => positionResult(p, ix, now));
  const desk = events.find((e): e is DeskEvent => e.type === 'desk') ?? null;
  const fundingByVenue: Record<string, number> = {};
  for (const p of positions) for (const l of p.legs) fundingByVenue[l.venue] = (fundingByVenue[l.venue] ?? 0) + l.fundingUsd;
  const deskOwn = events.filter((e): e is TransferEvent => e.type === 'transfer' && e.positionId === null);
  const stray = strayFills(events, ix.fees);
  const strayUsd = stray.feesUsd + (stray.priceUsd ?? 0);
  return {
    version: 1, at: now,
    desk: desk === null ? null : { mode: desk.mode, contract: desk.contract, desk: desk.desk, addresses: desk.addresses },
    positions,
    totals: {
      positions: positions.length, open: positions.filter((p) => p.open).length,
      fundingUsd: sum(positions.map((p) => p.fundingUsd)), fundingByVenue,
      feesUsd: sum(positions.map((p) => p.feesUsd)) + stray.feesUsd,
      transferCostUsd: sum(positions.map((p) => p.transferCostUsd)),
      priceUsd: sum(positions.map((p) => p.priceUsd ?? 0)) + (stray.priceUsd ?? 0),
      netUsd: sum(positions.map((p) => p.netUsd)) + strayUsd,
      heldHours: sum(positions.map((p) => p.heldHours)),
    },
    deskTransfers: {
      inUsd: sum(deskOwn.filter((t) => t.usd > 0).map((t) => t.usd)),
      outUsd: sum(deskOwn.filter((t) => t.usd < 0).map((t) => t.usd)),
      feeUsd: sum(deskOwn.map((t) => t.feeUsd)), count: deskOwn.length,
    },
    strayFills: stray,
    orphanExits: events.filter((e): e is ExitEvent => e.type === 'exit' && e.positionId === null)
      .map((e) => ({ windowId: e.record.windowId, at: e.record.at, exitReason: e.record.exitReason })),
    cursors: ix.cursors,
    events: events.length,
  };
}

/** The positions closed with every leg's ledger read past exit + SETTLE_MS that have no settled journal entry yet. */
export function unsettledJournals(events: readonly BookEvent[], results: readonly PositionResult[]): PositionResult[] {
  const done = new Set<string>();
  for (const e of events) if (e.type === 'journal' && e.settled === true && e.positionId !== undefined) done.add(e.positionId);
  return results.filter((r) => r.settled && !done.has(r.id));
}
