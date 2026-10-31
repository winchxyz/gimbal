// Export CSV (design/HANDOFF.md, Journal): the entries of the current filter as a file the owner can open in a
// spreadsheet. Pure, so the quoting is tested.
import type { JournalEntry } from '@gimbal/shared';
import { amountUsd } from './entry.ts';
import { KINDS, type FilterId } from './kinds.ts';

export const CSV_HEADER = ['time_utc', 'kind', 'summary', 'amount_usd', 'why', 'numbers', 'transactions'] as const;

/**
 * One cell. Text that starts with `=`, `+`, `-`, `@` or a control character would run as a formula in a
 * spreadsheet, and the summary and the reason are written by the engine and a model, so such text gets a leading
 * apostrophe. Quotes are doubled and a cell with a comma, quote or line break is quoted (RFC 4180).
 */
export function cell(text: string): string {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** `2026-10-27T14:00:00Z`: second precision, always UTC. */
export const isoTime = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function row(entry: JournalEntry): string {
  const amount = amountUsd(entry);
  return [
    isoTime(entry.t),
    KINDS[entry.kind].label,
    cell(entry.summary),
    amount === null ? '' : amount.toFixed(2), // a number, not text: a minus sign here is not a formula
    cell(entry.why ?? ''),
    cell(JSON.stringify(entry.numbers)),
    cell(entry.tx.map((t) => `${t.chain}:${t.url}`).join(' ')),
  ].join(',');
}

/** The file's text: a header and one line per entry, oldest first so a spreadsheet reads in time order. */
export function toCsv(entries: readonly JournalEntry[]): string {
  const lines = [CSV_HEADER.join(','), ...[...entries].reverse().map(row)];
  return `${lines.join('\r\n')}\r\n`;
}

/** `gimbal-journal-funding-2026-10-27.csv` */
export function csvName(filter: FilterId, now: number): string {
  return `gimbal-journal-${filter}-${new Date(now).toISOString().slice(0, 10)}.csv`;
}
