// The journal entries the book writes (kinds that already exist in shared JournalEntry): `funding` once per synced
// hour per position, `fee` for fees the loop's own enter / exit entries do not carry, `deposit` / `withdraw` for the
// desk's Hyperliquid ledger. The loop journals `enter` and `exit` itself; entryNumbers / exitNumbers are what serve
// merges into those.

import type { JournalEntry, TxRef } from '@gimbal/shared';
import type { PositionResult } from './derive.ts';
import { HOUR_MS, attribute, hourOf, positionsOf, spans } from './derive.ts';
import type { BookEvent, FeeEvent, FundingEvent, JournalEvent, TransferEvent } from './types.ts';

/** An hour is journaled once every leg has paid it, or this long after it with what came (a missing leg says so). */
export const JOURNAL_GRACE_MS = 3 * HOUR_MS;

export const round6 = (x: number) => Math.round(x * 1e6) / 1e6 || 0;

export function signed(x: number, digits = 4): string {
  const s = Math.abs(x).toFixed(digits);
  return `${x < 0 && Number(s) !== 0 ? '-' : '+'}${s}`;
}

function iso(t: number): string {
  return new Date(t).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
}

function entry(id: string, t: number, kind: JournalEntry['kind'], summary: string, numbers: Record<string, number | string>, tx: TxRef[] = []): JournalEntry {
  return { id, t, kind, summary, numbers, tx };
}

/**
 * The funding entries due now: one per position and hour not journaled yet (once every leg paid it or the grace has
 * passed), and a `late` one for payments stored after their hour was journaled.
 */
export function fundingJournal(events: readonly BookEvent[], now: number): JournalEvent[] {
  const all = positionsOf(events);
  const bySpan = spans(all);
  const journals = events.filter((e) => e.type === 'journal') as JournalEvent[];
  const covered = new Set(journals.flatMap((j) => j.keys ?? []));
  const done = new Set(journals.filter((j) => j.hour !== undefined && j.late !== true).map((j) => `${j.positionId}|${j.hour}`));
  const groups = new Map<string, { position: (typeof all)[number]; hour: number; rows: FundingEvent[] }>();
  for (const f of events) {
    if (f.type !== 'funding' || covered.has(f.key)) continue;
    const p = attribute(f, bySpan);
    if (p === null) continue;
    const hour = hourOf(f.time);
    const k = `${p.id}|${hour}`;
    const g = groups.get(k) ?? { position: p, hour, rows: [] };
    g.rows.push(f);
    groups.set(k, g);
  }
  const out: JournalEvent[] = [];
  for (const [k, g] of [...groups].sort((a, b) => a[1].hour - b[1].hour)) {
    const late = done.has(k);
    const venues = g.position.legs.map((l) => l.venue);
    const paid = new Set(g.rows.map((r) => r.venue));
    if (!late && !venues.every((v) => paid.has(v)) && now - g.hour < JOURNAL_GRACE_MS) continue;
    const total = g.rows.reduce((s, r) => s + r.usd, 0);
    const numbers: Record<string, number | string> = {
      usd: round6(total), position: g.position.id, window: g.position.windowId, symbol: g.position.symbol, hour: iso(g.hour),
    };
    const parts: string[] = [];
    for (const v of late ? [...paid] : venues) {
      const rows = g.rows.filter((r) => r.venue === v);
      if (rows.length === 0) {
        parts.push(`${v} no payment`);
        numbers[`${v}Usd`] = 'missing';
        continue;
      }
      const usd = rows.reduce((s, r) => s + r.usd, 0);
      numbers[`${v}Usd`] = round6(usd);
      numbers[`${v}RatePerHour`] = rows[0]!.ratePerHour;
      const samples = rows.reduce((s, r) => s + (r.samples ?? 0), 0);
      if (samples > 0) numbers[`${v}Hours`] = samples;
      parts.push(`${v} ${signed(usd)}${samples > 0 ? ` (${samples} h aggregated)` : ''}`);
    }
    if (late) numbers.late = 1;
    const summary = `funding ${g.position.symbol} ${iso(g.hour)}${late ? ' (booked late)' : ''}: ${parts.join(', ')}; ${signed(total)} USD`;
    const id = `book-funding-${g.position.id}-${g.hour}${late ? `-late-${g.rows.map((r) => r.time).sort()[0]}` : ''}`;
    out.push({
      v: 1, type: 'journal', at: now, entry: entry(id, now, 'funding', summary, numbers),
      positionId: g.position.id, hour: g.hour, keys: g.rows.map((r) => r.key), ...(late ? { late: true } : {}),
    });
  }
  return out;
}

export function feeJournal(fee: FeeEvent, symbol: string, now: number): JournalEvent {
  const summary = `fee ${fee.venue} ${symbol} ${fee.stage === 'enter' ? 'open' : 'close'}: ${signed(fee.usd)} USD, read from the venue's fills (the record had none)`;
  return {
    v: 1, type: 'journal', at: now, positionId: fee.positionId,
    entry: entry(`book-fee-${fee.positionId}-${fee.stage}-${fee.venue}`, now, 'fee', summary, {
      usd: round6(fee.usd), position: fee.positionId, venue: fee.venue, stage: fee.stage,
    }),
  };
}

/** A transfer's journal entry: its fee as a `fee` (loop, rescue, manual, fund), or the ledger row as deposit / withdraw. */
export function transferJournal(t: TransferEvent, now: number): JournalEvent | null {
  if (t.source === 'hl-ledger') {
    if (t.usd === 0) return null;
    const kind = t.usd > 0 ? 'deposit' : 'withdraw';
    const summary = `${kind} hyperliquid ${t.note ?? ''}: ${signed(t.usd, 2)} USD${t.feeUsd !== 0 ? `, fee ${signed(t.feeUsd)}` : ''}`.replace(' :', ':');
    return {
      v: 1, type: 'journal', at: now,
      entry: entry(`book-${t.id}`, t.time, kind, summary, { usd: round6(t.usd), ...(t.feeUsd === 0 ? {} : { feeUsd: round6(t.feeUsd) }), venue: 'hyperliquid' }, t.tx),
    };
  }
  if (t.feeUsd === 0) return null;
  const summary = `fee: ${t.source} transfer ${t.from} -> ${t.to}, ${t.usd.toFixed(2)} USD moved, cost ${signed(t.feeUsd)} USD`
    + `${t.positionId === null ? ' (desk)' : ` (${t.positionId})`}${t.note === null ? '' : `; ${t.note}`}`;
  return {
    v: 1, type: 'journal', at: now, ...(t.positionId === null ? {} : { positionId: t.positionId }),
    entry: entry(`book-${t.id}`, t.time, 'fee', summary, {
      usd: round6(t.feeUsd), from: t.from, to: t.to, movedUsd: round6(t.usd), ...(t.positionId === null ? {} : { position: t.positionId }),
    }, t.tx),
  };
}

/** What serve merges into the loop's `enter` (or `rotate`) entry: the position, its legs, fees and forecast. */
export function entryNumbers(r: PositionResult): Record<string, number | string> {
  const out: Record<string, number | string> = { position: r.id, window: r.windowId, symbol: r.symbol, feeUsd: round6(r.entryFeesUsd) };
  if (r.forecastNetAprPct !== null) out.forecastNetAprPct = r.forecastNetAprPct;
  if (r.legUsd !== null) out.legUsd = round6(r.legUsd);
  if (r.leverage !== null) out.leverage = r.leverage;
  if (r.marginUsd !== null) out.marginUsd = round6(r.marginUsd);
  for (const l of r.legs) {
    out[`${l.venue}Side`] = l.side;
    if (l.qty !== null) out[`${l.venue}Qty`] = l.qty;
    if (l.entryPx !== null) out[`${l.venue}Px`] = l.entryPx;
    out[`${l.venue}FeeUsd`] = l.entryFeeUsd === null ? 'unknown' : round6(l.entryFeeUsd);
  }
  if (r.rotatedFrom !== null) out.rotatedFrom = r.rotatedFrom;
  return out;
}

/** What serve merges into the loop's `exit` entry: the position's results at the close. */
export function exitNumbers(r: PositionResult): Record<string, number | string> {
  const out: Record<string, number | string> = {
    position: r.id, window: r.windowId, symbol: r.symbol, feeUsd: round6(r.exitFeesUsd),
    fundingUsd: round6(r.fundingUsd), feesUsd: round6(r.feesUsd), transferCostUsd: round6(r.transferCostUsd),
    netUsd: round6(r.netUsd), heldH: Math.round(r.heldHours * 100) / 100,
  };
  if (r.priceUsd !== null) out.priceUsd = round6(r.priceUsd);
  if (r.actualAprPct !== null) out.actualAprPct = Math.round(r.actualAprPct * 100) / 100;
  if (r.forecastNetAprPct !== null) out.forecastNetAprPct = r.forecastNetAprPct;
  if (r.netOnMarginPct !== null) out.netOnMarginPct = Math.round(r.netOnMarginPct * 100) / 100;
  for (const l of r.legs) {
    out[`${l.venue}FundingUsd`] = round6(l.fundingUsd);
    if (l.exitPx !== null) out[`${l.venue}ExitPx`] = l.exitPx;
    out[`${l.venue}FeeUsd`] = l.exitFeeUsd === null ? 'unknown' : round6(l.exitFeeUsd);
  }
  if (r.exitReason !== null) out.exitReason = r.exitReason;
  if (r.rotatedTo !== null) out.rotatedTo = r.rotatedTo;
  return out;
}
