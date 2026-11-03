// What `npm run report` prints: one block per position and the desk's totals, from a BookSummary. Pure.

import type { BookSummary, LegResult, PositionResult } from './derive.ts';
import { signed } from './journal.ts';

function when(t: number): string {
  return new Date(t).toISOString().replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, ' UTC');
}

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${x.toFixed(2)} %`;
}

function px(x: number | null): string {
  return x === null ? '?' : String(Number(x.toPrecision(6)));
}

function hoursText(h: number): string {
  return `${h.toFixed(1)} h`;
}

function legLine(l: LegResult, open: boolean): string {
  const size = l.qty === null ? 'size ?' : String(l.qty);
  return `${l.venue} ${l.side} ${size} @ ${px(l.entryPx)}${open ? '' : ` -> ${px(l.exitPx)}`}`;
}

function fundingPart(l: LegResult): string {
  const missing = l.hours - l.paidHours;
  const estimated = l.estimatedHours > 0 ? `, ${l.estimatedHours} h ${signed(l.estimatedUsd)} estimated from daily aggregates` : '';
  return `${l.venue} ${signed(l.fundingUsd)} (${l.paidHours} of ${l.hours} h paid${missing > 0 ? `, ${missing} h with no payment booked` : ''}${estimated})`;
}

function settledText(p: PositionResult): string {
  if (!p.settled && p.finalAt === null) return 'not yet: the venues may still book the last hours';
  const asOf = p.finalAt === null ? 'every ledger read past the exit + 2 h (the final entry not written yet)' : `final as of ${when(p.finalAt)}`;
  const later = p.afterFinalUsd === 0 ? '' : `; booked late after it: ${signed(p.afterFinalUsd)} (an adjustment to the final, in the numbers here)`;
  return `yes: ${asOf}${later}`;
}

export function positionBlock(p: PositionResult): string[] {
  const venues = p.legs.map((l) => `${l.side} ${l.venue}`).join(', ');
  const out: string[] = [];
  out.push(`${p.symbol}  ${venues}  ${p.open ? 'OPEN' : 'closed'}${p.adopted ? ' (adopted: opened outside the loop)' : ''}`);
  out.push(`  position   ${p.id}`);
  out.push(`  entered    ${when(p.enteredAt)} by ${p.by} (hold from ${when(p.startedAt)})${p.rotatedFrom === null ? '' : `, rotated in from ${p.rotatedFrom}`}`);
  if (p.open) out.push(`  held       ${hoursText(p.heldHours)} so far (running numbers)`);
  else {
    out.push(`  held       ${hoursText(p.heldHours)}, exited ${when(p.exitedAt!)} by ${p.exitBy ?? '?'}${p.rotatedTo === null ? '' : `, rotated out to ${p.rotatedTo}`}`);
    out.push(`  exit       ${p.exitReason ?? 'no reason recorded'}${p.fillsUnread ? ' (its fills were never read: price and close fees unknown, the numbers are estimated)' : ''}`);
    out.push(`  settled    ${settledText(p)}`);
  }
  out.push(`  legs       ${p.legs.map((l) => legLine(l, p.open)).join('; ')}`);
  const sizing = [
    `notional ${p.legUsd === null ? '?' : p.legUsd.toFixed(2)} USD a leg`,
    p.leverage === null ? null : `leverage ${p.leverage}x`,
    p.marginUsd === null ? null : `margin ${p.marginUsd.toFixed(2)} USD`,
  ].filter((s) => s !== null);
  out.push(`  size       ${sizing.join(', ')}`);
  out.push(`  funding    ${p.legs.map(fundingPart).join(', ')}; total ${signed(p.fundingUsd)}`);
  const later = p.partialFills > 0 ? `, later fills ${signed(p.exitFeesUsd)} (${p.partialFills} partial act(s)${p.open ? '' : ' and the close'})` : `, close ${p.open ? 'not yet' : signed(p.exitFeesUsd)}`;
  out.push(`  fees       open ${signed(p.entryFeesUsd)}${later}, total ${signed(p.feesUsd)}`
    + `${p.unknownFees > 0 ? ` (${p.unknownFees} fill(s) with no fee known: not counted)` : ''}`);
  out.push(`  transfers  ${signed(p.transferCostUsd)}${p.transfers > 0 ? ` (${p.transfers} transfer(s))` : ''}`);
  out.push(`  price      ${p.priceUsd === null ? (p.open ? 'at the close' : 'unknown (a fill price is missing, or a venue did not net to flat)') : `${signed(p.priceUsd)} (every fill's cash flow, open to close)`}`);
  out.push(`  net        ${signed(p.netUsd)} USD${p.netOnMarginPct === null ? '' : `, ${pct(p.netOnMarginPct)} of margin`}`);
  out.push(`  APR        actual ${pct(p.actualAprPct)} vs forecast ${pct(p.forecastNetAprPct)}`
    + ` (funding + fees${p.open ? '' : ' + price'} over leg notional, ${hoursText(p.aprHours)} to funding read ${p.fundingThrough === null ? 'never' : when(p.fundingThrough)} annualised;`
    + ' transfers left out, as the forecast)');
  return out;
}

export function bookReport(s: BookSummary, notes: readonly string[] = []): string {
  const out: string[] = [];
  const desk = s.desk === null ? 'unknown desk' : `${s.desk.mode} ${s.desk.contract ?? '-'} / ${s.desk.desk ?? '-'}`;
  out.push(`position book: ${desk}, as of ${when(s.at)} (${s.events} events)`);
  for (const n of notes) out.push(n);
  const cursors = Object.entries(s.cursors);
  out.push(`ledgers read up to: ${cursors.length === 0 ? 'never synced' : cursors.map(([k, t]) => `${k} ${when(t)}`).join(', ')}`);
  out.push('');
  if (s.positions.length === 0) out.push('no positions booked yet');
  for (const p of s.positions) {
    out.push(...positionBlock(p));
    out.push('');
  }
  for (const o of s.orphanExits) out.push(`exit of ${o.windowId} at ${when(o.at)} with no booked entry: ${o.exitReason ?? 'no reason'}`);
  if (s.orphanExits.length > 0) out.push('');
  const t = s.totals;
  out.push('desk totals');
  out.push(`  positions  ${t.positions} (${t.open} open), ${hoursText(t.heldHours)} held in all`);
  const byVenue = Object.entries(t.fundingByVenue).map(([v, x]) => `${v} ${signed(x)}`).join(', ');
  out.push(`  funding    ${byVenue === '' ? '' : `${byVenue}; `}total ${signed(t.fundingUsd)}`);
  out.push(`  fees       ${signed(t.feesUsd)}`);
  const st = s.strayFills;
  if (st.count > 0) {
    out.push(`  stray fills ${st.count} act(s) that left no position: fees ${signed(st.feesUsd)}, price ${st.priceUsd === null ? 'unknown' : signed(st.priceUsd)}`
      + `${st.unknownFees > 0 ? ` (${st.unknownFees} fill(s) with no fee known)` : ''}; in the totals`);
  }
  out.push(`  transfers  ${signed(t.transferCostUsd)}`);
  out.push(`  price      ${signed(t.priceUsd)} (closed positions)`);
  out.push(`  net        ${signed(t.netUsd)} USD`);
  const d = s.deskTransfers;
  out.push(`  desk ledger ${d.count} entr${d.count === 1 ? 'y' : 'ies'} not tied to a position: in ${signed(d.inUsd, 2)}, out ${signed(d.outUsd, 2)}, fees ${signed(d.feeUsd)}`);
  out.push('');
  out.push('NEAR AI risk check ledger (helped / hurt)');
  out.push('  -- not recorded yet: this section joins when the risk check outcomes are booked --');
  return `${out.join('\n')}\n`;
}
