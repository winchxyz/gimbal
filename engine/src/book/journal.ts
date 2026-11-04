// The journal entries the book writes (kinds that already exist in shared JournalEntry): `funding` once per synced
// hour per position, `fee` for fees the loop's own enter / exit entries do not carry, `deposit` / `withdraw` for the
// desk's Hyperliquid ledger. The loop journals `enter` and `exit` itself; entryNumbers / exitNumbers are what serve
// merges into those.
//
// A closed position's numbers settle after its exit entry: the venues book the last hours' funding later. The exit
// entry carries what was read by then (`fundingThrough`, `settling` 1, and its summary says so). Once every leg's
// ledger is read past exit + SETTLE_MS, the book writes ONE settled entry with the final numbers: kind `funding` (not
// a second `exit`, which the web would count as another close), `final` 1 and `settled` 1, and no `usd`: the hourly
// funding entries already carry the money, so a day's total does not count it twice.

import type { JournalEntry, TxRef } from '@gimbal/shared';
import type { PositionResult } from './derive.ts';
import { HOUR_MS, PERIODIC_FUNDING_VENUES, attribute, fundingPeriodAt, hourOf, isEstimate, positionsOf, spans } from './derive.ts';
import type { MissingFee } from './sync.ts';
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

/** `14:00`, UTC. */
export function hhmm(t: number): string {
  return new Date(t).toISOString().slice(11, 16);
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
  const finals = new Set(journals.filter((j) => j.settled === true && j.positionId !== undefined).map((j) => j.positionId!));
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
    // A venue that pays once per funding period is waited for, and missing, only on its funding times (the period of
    // the payment interval the hour is in, from the payments booked on the symbol, else the default); in the hours
    // between them it owes nothing.
    const periodic = (v: string) => PERIODIC_FUNDING_VENUES.has(v);
    const owes = (v: string) => {
      if (!periodic(v)) return true;
      const p = fundingPeriodAt(events.filter((e): e is FundingEvent => e.type === 'funding' && e.venue === v && e.symbol === g.position.symbol), g.hour);
      return g.hour % (p * HOUR_MS) === 0;
    };
    if (!late && !venues.every((v) => !owes(v) || paid.has(v)) && now - g.hour < JOURNAL_GRACE_MS) continue;
    const total = g.rows.reduce((s, r) => s + r.usd, 0);
    const numbers: Record<string, number | string> = {
      usd: round6(total), position: g.position.id, window: g.position.windowId, symbol: g.position.symbol, hour: iso(g.hour),
    };
    const parts: string[] = [];
    for (const v of late ? [...paid] : venues) {
      const rows = g.rows.filter((r) => r.venue === v);
      if (rows.length === 0) {
        if (!owes(v)) continue;
        parts.push(`${v} no payment`);
        numbers[`${v}Usd`] = 'missing';
        continue;
      }
      const usd = rows.reduce((s, r) => s + r.usd, 0);
      numbers[`${v}Usd`] = round6(usd);
      numbers[`${v}RatePerHour`] = rows[0]!.ratePerHour;
      const samples = rows.reduce((s, r) => s + (r.samples ?? 0), 0);
      if (samples > 0) numbers[`${v}Hours`] = samples;
      const note = samples === 0 ? '' : periodic(v) ? ` (its ${samples} h funding period)` : ` (${samples} h aggregated, estimated)`;
      parts.push(`${v} ${signed(usd)}${note}`);
    }
    if (late) numbers.late = 1;
    // A daily aggregate's amount per hour is not verified against a real row: marked as an estimate.
    if (g.rows.some(isEstimate)) numbers.estimated = 1;
    // Booked after the position's final entry: an adjustment against it.
    const afterFinal = late && finals.has(g.position.id);
    if (afterFinal) numbers.afterFinal = 1;
    const when = afterFinal ? ` (booked late, after the final entry of ${g.position.id}: an adjustment to it)` : late ? ' (booked late)' : '';
    const summary = `funding ${g.position.symbol} ${iso(g.hour)}${when}: ${parts.join(', ')}; ${signed(total)} USD`;
    // A late entry's id names its first payment time and, for an adjustment of a stored hour, its index (adjN).
    const adj = Math.max(0, ...g.rows.map((r) => Number(/\|adj(\d+)$/.exec(r.key)?.[1] ?? 0)));
    const id = `book-funding-${g.position.id}-${g.hour}${late ? `-late-${g.rows.map((r) => r.time).sort()[0]}${adj > 0 ? `-adj${adj}` : ''}` : ''}`;
    out.push({
      v: 1, type: 'journal', at: now, entry: entry(id, now, 'funding', summary, numbers),
      positionId: g.position.id, hour: g.hour, keys: g.rows.map((r) => r.key), ...(late ? { late: true } : {}),
    });
  }
  return out;
}

const STAGE = { enter: 'open', exit: 'close', fill: 'partial fill' } as const;

/** The fees read from a venue for one record's fills on one venue and side. */
export function feeJournal(m: MissingFee, fees: readonly FeeEvent[], now: number): JournalEvent {
  const usd = fees.reduce((a, f) => a + f.usd, 0);
  const summary = `fee ${m.venue} ${m.symbol} ${STAGE[m.stage]}: ${signed(usd)} USD, read from the venue's fills (the record had none)`
    + `${m.positionId === null ? ' (desk: no position)' : ''}`;
  return {
    v: 1, type: 'journal', at: now, ...(m.positionId === null ? {} : { positionId: m.positionId }),
    entry: entry(`book-fee-${m.positionId ?? 'desk'}-${m.stage}-${m.record.at}-${m.venue}-${m.side}`, now, 'fee', summary, {
      usd: round6(usd), ...(m.positionId === null ? {} : { position: m.positionId }), venue: m.venue, stage: m.stage, fills: fees.length,
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

/** The position's results: funding (per leg), fees, transfers, price, net, hours and the APR over the hours read. */
function resultNumbers(r: PositionResult): Record<string, number | string> {
  const out: Record<string, number | string> = {
    position: r.id, window: r.windowId, symbol: r.symbol,
    fundingUsd: round6(r.fundingUsd), feesUsd: round6(r.feesUsd), transferCostUsd: round6(r.transferCostUsd),
    netUsd: round6(r.netUsd), heldH: Math.round(r.heldHours * 100) / 100, aprH: Math.round(r.aprHours * 100) / 100,
    fundingThrough: r.fundingThrough === null ? 'none' : new Date(r.fundingThrough).toISOString(),
  };
  if (r.priceUsd !== null) out.priceUsd = round6(r.priceUsd);
  if (r.actualAprPct !== null) out.actualAprPct = Math.round(r.actualAprPct * 100) / 100;
  if (r.forecastNetAprPct !== null) out.forecastNetAprPct = r.forecastNetAprPct;
  if (r.netOnMarginPct !== null) out.netOnMarginPct = Math.round(r.netOnMarginPct * 100) / 100;
  if (r.unknownFees > 0) out.unknownFees = r.unknownFees;
  if (r.partialFills > 0) out.partialFills = r.partialFills;
  for (const l of r.legs) out[`${l.venue}FundingUsd`] = round6(l.fundingUsd);
  return out;
}

/** What the exit entry says of the funding read so far: `funding read to 14:00, settling`; null once settled. */
export function settlingNote(r: PositionResult): string | null {
  if (r.open || r.settled) return null;
  return `funding read to ${r.fundingThrough === null ? 'none yet' : hhmm(r.fundingThrough)}, settling`;
}

/** The position's settled entry: its final numbers, once (see the header). */
export function settledJournal(r: PositionResult, now: number): JournalEvent {
  const numbers: Record<string, number | string> = { ...resultNumbers(r), final: 1, settled: 1 };
  if (r.estimatedUsd !== 0) {
    numbers.estimated = 1;
    numbers.estimatedUsd = round6(r.estimatedUsd);
  }
  if (r.fillsUnread) {
    numbers.estimated = 1;
    numbers.fillsUnread = 1;
  }
  const apr = r.actualAprPct === null ? 'n/a' : `${r.actualAprPct.toFixed(2)} %`;
  const summary = `settled ${r.symbol} ${r.id}: funding ${signed(r.fundingUsd)}, fees ${signed(r.feesUsd)}`
    + `${r.priceUsd === null ? '' : `, price ${signed(r.priceUsd)}`}, net ${signed(r.netUsd)} USD; actual APR ${apr}`
    + ` over ${r.aprHours.toFixed(1)} h, funding read to ${r.fundingThrough === null ? 'none' : hhmm(r.fundingThrough)}`
    + `${r.estimatedUsd === 0 ? '' : ` (${signed(r.estimatedUsd)} of the funding estimated from daily aggregates)`}`
    + `${r.fillsUnread ? "; the exit's fills were never read: price and close fees unknown, estimated" : ''}; final as of ${hhmm(now)}`;
  return {
    v: 1, type: 'journal', at: now, positionId: r.id, settled: true,
    entry: entry(`book-settled-${r.id}`, now, 'funding', summary, numbers),
  };
}

/** What serve merges into the loop's `exit` entry: the position's results at the close, as read so far. */
export function exitNumbers(r: PositionResult): Record<string, number | string> {
  const out: Record<string, number | string> = { ...resultNumbers(r), feeUsd: round6(r.exitFeesUsd) };
  if (!r.settled) out.settling = 1;
  for (const l of r.legs) {
    if (l.exitPx !== null) out[`${l.venue}ExitPx`] = l.exitPx;
    out[`${l.venue}FeeUsd`] = l.exitFeeUsd === null ? 'unknown' : round6(l.exitFeeUsd);
  }
  if (r.exitReason !== null) out.exitReason = r.exitReason;
  if (r.rotatedTo !== null) out.rotatedTo = r.rotatedTo;
  return out;
}
