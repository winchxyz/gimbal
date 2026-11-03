// Pure: the book's events -> positions and their results. Nothing here reads a clock, a file or a venue.
//
// Attribution. A funding payment belongs to the position with a leg on its venue and symbol whose hold covers its time:
// from the entry (less ENTRY_SLACK_MS, as the record is written once the open has finished and a fill can precede a
// funding time by a few minutes; never before the previous position's exit on the same venue and symbol) to the exit,
// and whose leg side agrees with the payment's signed size (a short leg takes only rows with size < 0). Everything
// else is not this position's: it is never counted.
//
// Results, per position. Money is signed: income > 0, costs < 0.
// - funding: the venue ledgers' own payments, per leg and in total;
// - fees: each leg's fill fees at entry and exit (the record's, else the venue's read later; unknown ones are counted
//   apart, never as 0 silently);
// - transfers: the fees of margin moves tied to the position (the loop's and addTransfer's); moving the desk's own
//   money is not a cost;
// - price: closed positions only, each leg's exit fill against its entry fill (the slippage and basis the forecast
//   priced in); null while open or when a fill price is missing;
// - net = funding + fees + transfers + price;
// - actual APR, on the forecast's basis: (funding + fees + price) / leg notional, annualised over the hours held. The
//   forecast's net APR leaves margin moves out (Window.costs), so transfers are left out here too; they are in net.
//   Leg notional = the record's legUsd, else the mean of the legs' entry qty × price.

import type { TxRef } from '@gimbal/shared';
import type { BookEvent, BookFill, DeskEvent, EnterEvent, ExitEvent, FeeEvent, FundingEvent, TransferEvent } from './types.ts';

export const HOUR_MS = 3_600_000;
export const HOURS_A_YEAR = 8760;
export const ENTRY_SLACK_MS = 10 * 60_000;

export interface Position {
  id: string;
  windowId: string;
  symbol: string;
  enter: EnterEvent;
  exit: ExitEvent | null;
  legs: { venue: string; side: 'long' | 'short' }[];
}

export interface LegResult {
  venue: string;
  side: 'long' | 'short';
  qty: number | null;
  entryPx: number | null;
  exitPx: number | null;
  /** Signed (a cost < 0); null when unknown. */
  entryFeeUsd: number | null;
  exitFeeUsd: number | null;
  fundingUsd: number;
  payments: number;
  /** Hours with a payment booked (an aggregated row counts its samples). */
  paidHours: number;
  /** Funding times (top of the hour) inside the hold, up to the last read of this venue's ledger. */
  hours: number;
}

export interface PositionResult {
  id: string;
  windowId: string;
  symbol: string;
  open: boolean;
  adopted: boolean;
  legs: LegResult[];
  enteredAt: number;
  exitedAt: number | null;
  heldHours: number;
  /**
   * The hours the APR is annualised over: the hold, or for an open position the hold up to the last ledger read of
   * its venues (funding after it is not booked yet).
   */
  aprHours: number;
  by: 'auto' | 'manual';
  exitBy: 'auto' | 'manual' | null;
  exitReason: string | null;
  /** The position this one was rotated out of / into (position ids; a window id when the other side is not booked). */
  rotatedFrom: string | null;
  rotatedTo: string | null;
  entryTx: TxRef[];
  exitTx: TxRef[];
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

export interface BookTotals {
  positions: number;
  open: number;
  fundingUsd: number;
  fundingByVenue: Record<string, number>;
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

export function positionsOf(events: readonly BookEvent[]): Position[] {
  const out: Position[] = [];
  const byId = new Map<string, Position>();
  for (const e of events) {
    if (e.type === 'enter') {
      const p: Position = {
        id: e.positionId, windowId: e.record.windowId, symbol: e.record.symbol, enter: e, exit: null,
        legs: e.record.legs.map((l) => ({ venue: l.venue, side: legSide(l) })),
      };
      out.push(p);
      byId.set(p.id, p);
    } else if (e.type === 'exit' && e.positionId !== null) {
      const p = byId.get(e.positionId);
      if (p !== undefined && p.exit === null) p.exit = e;
    }
  }
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

interface Span { position: Position; side: 'long' | 'short'; lo: number; hi: number }

/** Each position's attribution span per venue and symbol. */
export function spans(positions: readonly Position[]): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  for (const p of positions) {
    for (const leg of p.legs) {
      const key = `${leg.venue}|${p.symbol}`;
      const list = out.get(key) ?? [];
      // The latest exit before this entry on the same venue and symbol bounds the slack.
      let floor = -Infinity;
      for (const s of list) if (s.hi <= p.enter.record.at && s.hi > floor) floor = s.hi;
      const lo = Math.max(p.enter.record.at - (p.enter.adopted ? 0 : ENTRY_SLACK_MS), floor);
      list.push({ position: p, side: leg.side, lo, hi: p.exit?.record.at ?? Infinity });
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

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** The entry fills' notional per leg, averaged; null when a leg's size or price is unknown. */
function fillNotional(fills: readonly BookFill[]): number | null {
  if (fills.length === 0) return null;
  const each = fills.map((f) => (f.avgPx === null ? null : Number(f.qty) * f.avgPx));
  if (each.some((x) => x === null || !Number.isFinite(x) || x <= 0)) return null;
  return sum(each as number[]) / each.length;
}

/** A fill's fee as signed money (the venue's charge is > 0 for a cost), else the venue's read later, else null. */
function feeOf(fill: BookFill, stage: 'enter' | 'exit', venue: string, positionId: string, fees: readonly FeeEvent[]): number | null {
  if (fill.feeUsd !== null) return -fill.feeUsd || 0;
  const read = fees.find((f) => f.positionId === positionId && f.stage === stage && f.venue === venue);
  return read === undefined ? null : read.usd;
}

/** A record's fee when it has no legs: the loop's sum, counted as a cost whatever its sign. */
function legsLessFee(record: { legs: BookFill[]; feeUsd: number }): number {
  return record.legs.length === 0 && Number.isFinite(record.feeUsd) ? -Math.abs(record.feeUsd) : 0;
}

export function positionResult(p: Position, events: readonly BookEvent[], now: number, all: readonly Position[]): PositionResult {
  const bySpan = spans(all);
  const payments = (events.filter((e) => e.type === 'funding') as FundingEvent[])
    .filter((f) => attribute(f, bySpan)?.id === p.id);
  const fees = events.filter((e) => e.type === 'fee') as FeeEvent[];
  const transfers = (events.filter((e) => e.type === 'transfer') as TransferEvent[]).filter((t) => t.positionId === p.id);
  const enter = p.enter.record;
  const exit = p.exit?.record ?? null;
  const end = exit?.at ?? now;
  const open = exit === null;
  const read = cursors(events);
  /** Where a venue's ledger has been read to, within the hold. */
  const readTo = (venue: string) => Math.min(end, read[venue] ?? end);

  let unknownFees = 0;
  const legs: LegResult[] = p.legs.map((leg) => {
    const inFill = enter.legs.find((f) => f.venue === leg.venue);
    const outFill = exit?.legs.find((f) => f.venue === leg.venue);
    // An adopted position's opening fills are not the book's to know; a record without legs carries its fee whole
    // (legsLessFee); a venue missing from a record's legs filled nothing there.
    const entryFeeUsd = p.enter.adopted || inFill === undefined ? 0 : feeOf(inFill, 'enter', leg.venue, p.id, fees);
    const exitFeeUsd = exit === null ? null : outFill === undefined ? 0 : feeOf(outFill, 'exit', leg.venue, p.id, fees);
    if (entryFeeUsd === null) unknownFees++;
    if (exit !== null && exitFeeUsd === null) unknownFees++;
    const mine = payments.filter((f) => f.venue === leg.venue);
    const hourly = new Set(mine.filter((f) => f.samples === null).map((f) => hourOf(f.time)));
    const aggregated = sum(mine.filter((f) => f.samples !== null).map((f) => f.samples!));
    const qty = inFill === undefined || inFill.qty === '' ? null : Number(inFill.qty);
    return {
      venue: leg.venue, side: leg.side,
      qty: qty !== null && Number.isFinite(qty) && qty > 0 ? qty : null,
      entryPx: inFill?.avgPx ?? null, exitPx: outFill?.avgPx ?? null,
      entryFeeUsd, exitFeeUsd,
      fundingUsd: sum(mine.map((f) => f.usd)), payments: mine.length, paidHours: hourly.size + aggregated,
      hours: hoursIn(enter.at, readTo(leg.venue)),
    };
  });

  const entryFeesUsd = sum(legs.map((l) => l.entryFeeUsd ?? 0)) + legsLessFee(enter);
  const exitFeesUsd = exit === null ? 0 : sum(legs.map((l) => l.exitFeeUsd ?? 0)) + legsLessFee(exit);
  const feesUsd = entryFeesUsd + exitFeesUsd;
  const moves = [...enter.marginMoves, ...(exit?.marginMoves ?? [])];
  const transferCostUsd = sum(moves.map((m) => -Math.abs(m.feeUsd) || 0)) + sum(transfers.map((t) => t.feeUsd));
  const fundingUsd = sum(legs.map((l) => l.fundingUsd));

  let priceUsd: number | null = null;
  if (!open && !p.enter.adopted && legs.length > 0 && legs.every((l) => l.qty !== null && l.entryPx !== null && l.exitPx !== null)) {
    priceUsd = sum(legs.map((l) => (l.side === 'long' ? 1 : -1) * (l.exitPx! - l.entryPx!) * l.qty!));
  }
  const carryUsd = fundingUsd + feesUsd + (priceUsd ?? 0);
  const netUsd = carryUsd + transferCostUsd;
  const heldHours = Math.max(0, end - enter.at) / HOUR_MS;
  const legUsd = positiveOrNull(enter.legUsd) ?? fillNotional(enter.legs);
  const marginUsd = positiveOrNull(enter.marginUsd);
  const aprHours = open && p.legs.length > 0 ? Math.max(0, Math.min(...p.legs.map((l) => readTo(l.venue))) - enter.at) / HOUR_MS : heldHours;
  const actualAprPct = legUsd !== null && aprHours > 0 ? (carryUsd / legUsd) * (HOURS_A_YEAR / aprHours) * 100 : null;

  const rotatedFrom = enter.rotation === null ? null
    : all.find((q) => q.windowId === enter.rotation!.fromId && q.exit?.record.rotation?.toId === enter.rotation!.toId)?.id ?? enter.rotation.fromId;
  const rotatedTo = exit?.rotation === null || exit === null ? null
    : all.find((q) => q.windowId === exit.rotation!.toId && q.enter.record.rotation?.fromId === exit.rotation!.fromId && q.enter.record.at >= exit.at)?.id ?? exit.rotation!.toId;

  return {
    id: p.id, windowId: p.windowId, symbol: p.symbol, open, adopted: p.enter.adopted, legs,
    enteredAt: enter.at, exitedAt: exit?.at ?? null, heldHours, aprHours, by: enter.by, exitBy: exit?.by ?? null,
    exitReason: exit?.exitReason ?? null, rotatedFrom, rotatedTo, entryTx: enter.tx, exitTx: exit?.tx ?? [],
    forecastNetAprPct: finiteOrNull(enter.forecastNetAprPct), legUsd, leverage: positiveOrNull(enter.leverage), marginUsd,
    fundingUsd, entryFeesUsd, exitFeesUsd, feesUsd, unknownFees,
    transferCostUsd, transfers: moves.length + transfers.length,
    priceUsd, carryUsd, netUsd, actualAprPct,
    netOnMarginPct: marginUsd === null ? null : (netUsd / marginUsd) * 100,
  };
}

function positiveOrNull(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null;
}

function finiteOrNull(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** The end of the last read that went through, per ledger. */
export function cursors(events: readonly BookEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) if (e.type === 'sync' && (out[e.ledger] === undefined || e.to > out[e.ledger]!)) out[e.ledger] = e.to;
  return out;
}

export function summarize(events: readonly BookEvent[], now: number): BookSummary {
  const all = positionsOf(events);
  const positions = all.map((p) => positionResult(p, events, now, all));
  const desk = events.find((e): e is DeskEvent => e.type === 'desk') ?? null;
  const fundingByVenue: Record<string, number> = {};
  for (const p of positions) for (const l of p.legs) fundingByVenue[l.venue] = (fundingByVenue[l.venue] ?? 0) + l.fundingUsd;
  const deskOwn = (events.filter((e) => e.type === 'transfer') as TransferEvent[]).filter((t) => t.positionId === null);
  return {
    version: 1, at: now,
    desk: desk === null ? null : { mode: desk.mode, contract: desk.contract, desk: desk.desk, addresses: desk.addresses },
    positions,
    totals: {
      positions: positions.length, open: positions.filter((p) => p.open).length,
      fundingUsd: sum(positions.map((p) => p.fundingUsd)), fundingByVenue,
      feesUsd: sum(positions.map((p) => p.feesUsd)), transferCostUsd: sum(positions.map((p) => p.transferCostUsd)),
      priceUsd: sum(positions.map((p) => p.priceUsd ?? 0)), netUsd: sum(positions.map((p) => p.netUsd)),
      heldHours: sum(positions.map((p) => p.heldHours)),
    },
    deskTransfers: {
      inUsd: sum(deskOwn.filter((t) => t.usd > 0).map((t) => t.usd)),
      outUsd: sum(deskOwn.filter((t) => t.usd < 0).map((t) => t.usd)),
      feeUsd: sum(deskOwn.map((t) => t.feeUsd)), count: deskOwn.length,
    },
    orphanExits: (events.filter((e) => e.type === 'exit') as ExitEvent[]).filter((e) => e.positionId === null)
      .map((e) => ({ windowId: e.record.windowId, at: e.record.at, exitReason: e.record.exitReason })),
    cursors: cursors(events),
    events: events.length,
  };
}
