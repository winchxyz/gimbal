// What `npm run report` takes from serve's own summary of a book (<book>.summary.json, written after every sync).
//
// The JSONL keeps a ledger read's sync line only when it stored something (or moved past a position's settle edge):
// an hourly read that found nothing new moves serve's cursor in memory alone, and that cursor is in the summary serve
// writes after the sync. So a report built from the JSONL alone says the ledgers were last read when they last
// brought a payment, hours behind serve; with the summary it says when serve last read them. A book with no position
// has no ledger to read at all: the summary says when serve last looked, and the report says why nothing was read.

import { readFileSync } from 'node:fs';
import type { BookSummary } from './derive.ts';
import { summaryFile } from './store.ts';

export interface ServeSummary {
  /** ms: when serve wrote it (its last sync, or its last record). */
  at: number;
  cursors: Record<string, number>;
  positions: number;
}

/** serve's summary next to the book at `bookPath`; null when there is none or it does not parse. */
export function readServeSummary(bookPath: string): ServeSummary | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(summaryFile(bookPath), 'utf8'));
  } catch {
    return null;
  }
  const s = raw as { at?: unknown; cursors?: unknown; positions?: unknown };
  if (typeof s.at !== 'number' || !Number.isFinite(s.at)) return null;
  const cursors: Record<string, number> = {};
  if (s.cursors !== null && typeof s.cursors === 'object') {
    for (const [k, v] of Object.entries(s.cursors as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) cursors[k] = v;
  }
  return { at: s.at, cursors, positions: Array.isArray(s.positions) ? s.positions.length : 0 };
}

/** The report's summary with serve's cursors where they are later, and the lines that say what serve's summary adds. */
export function withServeSummary(summary: BookSummary, serve: ServeSummary | null): { summary: BookSummary; notes: string[] } {
  if (serve === null) return { summary, notes: [] };
  const cursors = { ...summary.cursors };
  for (const [k, t] of Object.entries(serve.cursors)) if (cursors[k] === undefined || t > cursors[k]!) cursors[k] = t;
  const notes = [`serve's summary of ${new Date(serve.at).toISOString()}: its ledger reads that found nothing new are counted`];
  if (Object.keys(cursors).length === 0 && summary.positions.length === 0) {
    notes.push('no ledger read yet: no position is booked, so there is none to read (serve reads them once one is, then every hour)');
  }
  return { summary: { ...summary, cursors }, notes };
}
