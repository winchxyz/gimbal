// The NEAR AI risk check ledger: every risk check outcome, booked next to the position book under GIMBAL_STATE_DIR
// (risk-checks-<mode>[-<contract>-<desk>].jsonl), and what `npm run report` makes of it (helped / hurt).
//
// One `check` line per risk check (the exact prompt, the model, the raw reply, its latency, the verdict, the
// attestation shown with it, and the window's numbers when it was asked). For a refusal, serve then appends `hours`
// lines on every hourly check: the gross APR the refused window's legs actually paid each hour (the scanner's
// history: venue-booked rates, else its own reads), up to the hold the loop would have taken. The report prices the
// refusal from those hours alone, offline: what the refused leg would have earned, less the round trip of fills
// and slippage the scanner priced it with, marked estimated. Negative: the refusal helped (it kept the desk out of a
// loss); positive: it hurt (it gave up a gain). A pass is matched to the position the book opened in that window just
// after it, and shows that position's realised net (its running net while open).
//
// The file is appended to, never rewritten (one line per write, fsynced). A torn last line (a crash in a write) is
// dropped on load; any other line that is not one of these records is skipped and counted, never trusted.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Mode } from '@gimbal/shared';
import type { ChatMessage } from '../nearai/client.ts';
import { HOURS_PER_YEAR } from '../scanner/costs.ts';
import type { RiskCheckOutcome } from '../strategy/veto.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { PositionResult } from './derive.ts';

const HOUR_MS = 3_600_000;
const SAFE = /^[a-z0-9._-]{1,64}$/;
/** A pass is matched to a position entered in its window within this long after it. */
export const FOLLOW_MS = 30 * 60_000;

export interface RiskCheckRecord {
  v: 1;
  type: 'check';
  /** Unique in the file: `<at>-<window id>`. */
  id: string;
  at: number;
  kind: 'enter' | 'rotate';
  by: 'auto' | 'manual';
  windowId: string;
  symbol: string;
  outcome: RiskCheckOutcome;
  /** refused: the window was dropped; passed: a readable pass; unchecked: no answer, the window passed unchecked. */
  verdict: 'passed' | 'refused' | 'unchecked';
  reason: string;
  /** The why line the decision carried. */
  why: string;
  /** "attested" or "not attested: <why>", as shown with the check; null when no reply came. */
  attestation: string | null;
  model: string;
  /** The exact messages sent (null when nothing was asked: no key). */
  prompt: ChatMessage[] | null;
  /** The model's text as it came ("" when no reply came). */
  reply: string;
  latencyMs: number | null;
  legUsd: number;
  leverage: number;
  /** The window's net APR when it was asked (the scanner's forecast). */
  forecastNetAprPct: number;
  /** The fills and slippage of opening and closing the leg, USD, as the scanner priced the window. */
  roundTripCostUsd: number;
  /** The hold a refusal is priced over (hours). */
  holdHours: number;
}

export interface RiskHoursRecord {
  v: 1;
  type: 'hours';
  at: number;
  checkId: string;
  /** Hour start (ms) -> the gross APR both legs paid in that hour. */
  points: { t: number; grossAprPct: number }[];
}

export type RiskLedgerRecord = RiskCheckRecord | RiskHoursRecord;

/** The ledger's path: one per mode, contract and desk, next to the book. */
export function riskLedgerFile(dir: string, mode: Mode, contractId: string | null, deskId: string | null): string {
  const part = (v: string, what: string) => {
    if (!SAFE.test(v)) throw new Error(`${what} ${JSON.stringify(v)} cannot name a risk check ledger`);
    return v;
  };
  const id = contractId === null || deskId === null ? '' : `-${part(contractId, 'contract')}-${part(deskId, 'desk')}`;
  return join(dir, `risk-checks-${mode}${id}.jsonl`);
}

/** The ledger next to a book file (book-<x>.jsonl -> risk-checks-<x>.jsonl). */
export function ledgerForBook(bookPath: string): string {
  return join(dirname(bookPath), bookPath.slice(dirname(bookPath).length + 1).replace(/^book-/, 'risk-checks-'));
}

/** Every ledger in a directory, sorted by name. */
export function ledgerFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => /^risk-checks-.*\.jsonl$/.test(n)).sort().map((n) => join(dir, n));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function isRecord(x: unknown): x is RiskLedgerRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  if (r.v !== 1) return false;
  if (r.type === 'check') {
    return typeof r.id === 'string' && typeof r.at === 'number' && typeof r.windowId === 'string' && typeof r.verdict === 'string'
      && typeof r.legUsd === 'number' && typeof r.roundTripCostUsd === 'number' && typeof r.holdHours === 'number';
  }
  return r.type === 'hours' && typeof r.checkId === 'string' && Array.isArray(r.points);
}

/** The ledger's records; a missing file is empty. `skipped`: lines that are not records (a torn last line is not counted). */
export function loadRiskLedger(path: string): { records: RiskLedgerRecord[]; skipped: number } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], skipped: 0 };
    throw err;
  }
  const lines = text.split('\n');
  // The last segment is "" after a whole line, or a torn line after a crash in its write: dropped either way.
  lines.pop();
  const records: RiskLedgerRecord[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const r: unknown = JSON.parse(line);
      if (isRecord(r)) records.push(r);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

/** What the strategy loop books: a risk check, and the hourly prices of the refusals still inside their hold. */
export interface RiskLedgerSink {
  check(record: RiskCheckRecord): void;
  /** Appends the hours priced since the last call; `hours(windowId, fromMs, toMs)` is the scanner's grossHours. */
  hourly(now: number, hours: (windowId: string, fromMs: number, toMs: number) => { t: number; grossAprPct: number }[] | null): void;
}

/** The ledger on disk. Its failures are logged, never the act's. */
export class RiskLedger implements RiskLedgerSink {
  readonly path: string;
  readonly #log: (line: string) => void;
  readonly #checks = new Map<string, RiskCheckRecord>();
  /** Check id -> the hours already booked. */
  readonly #priced = new Map<string, Set<number>>();

  constructor(path: string, log: (line: string) => void) {
    this.path = path;
    this.#log = log;
    const { records, skipped } = loadRiskLedger(path);
    if (skipped > 0) log(`risk checks: ${skipped} line(s) of ${path} are not records: skipped`);
    for (const r of records) {
      if (r.type === 'check') this.#checks.set(r.id, r);
      else {
        const set = this.#priced.get(r.checkId) ?? new Set<number>();
        for (const p of r.points) set.add(p.t);
        this.#priced.set(r.checkId, set);
      }
    }
  }

  check(record: RiskCheckRecord): void {
    this.#checks.set(record.id, record);
    this.#append(record);
  }

  hourly(now: number, hours: (windowId: string, fromMs: number, toMs: number) => { t: number; grossAprPct: number }[] | null): void {
    for (const c of this.#checks.values()) {
      if (c.verdict !== 'refused') continue;
      const { from, to } = holdSpan(c);
      if (now < from) continue;
      const done = this.#priced.get(c.id) ?? new Set<number>();
      if (done.size >= c.holdHours) continue;
      // The scanner keeps two weeks: past that, an hour it no longer holds stays unpriced.
      const got = hours(c.windowId, from, Math.min(to, now));
      if (got === null) continue;
      const fresh = got.filter((p) => !done.has(p.t) && p.t >= from && p.t < to && Number.isFinite(p.grossAprPct));
      if (fresh.length === 0) continue;
      for (const p of fresh) done.add(p.t);
      this.#priced.set(c.id, done);
      this.#append({ v: 1, type: 'hours', at: now, checkId: c.id, points: fresh });
    }
  }

  #append(record: RiskLedgerRecord): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const fd = openSync(this.path, 'a');
      try {
        writeSync(fd, `${JSON.stringify(record)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.#log(`risk checks: not booked in ${this.path} (${errorMessage(err)})`);
    }
  }
}

/** The hours a refusal is priced over: the full hours after it was asked, for its hold. */
export function holdSpan(c: Pick<RiskCheckRecord, 'at' | 'holdHours'>): { from: number; to: number } {
  const from = Math.floor(c.at / HOUR_MS) * HOUR_MS + HOUR_MS;
  return { from, to: from + c.holdHours * HOUR_MS };
}

/** The round trip the scanner priced a window with, USD on one leg: its fills and slippage, spread back from APR points. */
export function roundTripUsd(costs: { feesPct: number; slippagePct: number }, legUsd: number, holdHours: number): number {
  return ((costs.feesPct + costs.slippagePct) / 100) * legUsd * (holdHours / HOURS_PER_YEAR);
}

// ---- the ledger as the report shows it ----

export interface RefusalResult {
  check: RiskCheckRecord;
  /** Hours priced, of holdHours. */
  hours: number;
  /** Estimated net the refused leg would have made over the hours priced, less the round trip; null with no hours. */
  counterfactualUsd: number | null;
  /** helped: the window lost money; hurt: it made money; pending: no hour priced yet. */
  call: 'helped' | 'hurt' | 'even' | 'pending';
}

export interface PassResult {
  check: RiskCheckRecord;
  position: Pick<PositionResult, 'id' | 'open' | 'netUsd'> | null;
}

export interface RiskLedgerSummary {
  refusals: RefusalResult[];
  passes: PassResult[];
  unchecked: PassResult[];
  totals: {
    checks: number;
    refused: number; helped: number; hurt: number; pending: number;
    /** Sum of the refusals' counterfactual net: < 0 = losses avoided, > 0 = gains given up. */
    refusedCounterfactualUsd: number;
    passed: number; passedNetUsd: number; passedWithPosition: number;
    unchecked: number; uncheckedNetUsd: number; uncheckedWithPosition: number;
  };
  skipped: number;
}

/** The ledger against the book's positions. Pure. */
export function riskLedgerSummary(
  records: readonly RiskLedgerRecord[], positions: readonly Pick<PositionResult, 'id' | 'windowId' | 'enteredAt' | 'open' | 'netUsd'>[], skipped = 0,
): RiskLedgerSummary {
  const checks = records.filter((r): r is RiskCheckRecord => r.type === 'check');
  const seen = new Set<string>();
  const unique = checks.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).sort((a, b) => a.at - b.at);
  const hours = new Map<string, Map<number, number>>();
  for (const r of records) {
    if (r.type !== 'hours') continue;
    const m = hours.get(r.checkId) ?? new Map<number, number>();
    for (const p of r.points) if (!m.has(p.t)) m.set(p.t, p.grossAprPct);
    hours.set(r.checkId, m);
  }
  const refusals: RefusalResult[] = [];
  const passes: PassResult[] = [];
  const unchecked: PassResult[] = [];
  const used = new Set<string>();
  for (const c of unique) {
    if (c.verdict === 'refused') {
      const { from, to } = holdSpan(c);
      const pts = [...(hours.get(c.id) ?? new Map<number, number>()).entries()].filter(([t]) => t >= from && t < to);
      if (pts.length === 0) {
        refusals.push({ check: c, hours: 0, counterfactualUsd: null, call: 'pending' });
        continue;
      }
      const funding = pts.reduce((s, [, g]) => s + (g / 100) * c.legUsd / HOURS_PER_YEAR, 0);
      const net = funding - c.roundTripCostUsd;
      refusals.push({ check: c, hours: pts.length, counterfactualUsd: net, call: net < 0 ? 'helped' : net > 0 ? 'hurt' : 'even' });
      continue;
    }
    const p = positions.find((x) => !used.has(x.id) && x.windowId === c.windowId && x.enteredAt >= c.at && x.enteredAt - c.at <= FOLLOW_MS) ?? null;
    if (p !== null) used.add(p.id);
    (c.verdict === 'passed' ? passes : unchecked).push({ check: c, position: p === null ? null : { id: p.id, open: p.open, netUsd: p.netUsd } });
  }
  const sum = (xs: readonly PassResult[]) => xs.reduce((s, x) => s + (x.position?.netUsd ?? 0), 0);
  return {
    refusals, passes, unchecked, skipped,
    totals: {
      checks: unique.length,
      refused: refusals.length,
      helped: refusals.filter((r) => r.call === 'helped').length,
      hurt: refusals.filter((r) => r.call === 'hurt').length,
      pending: refusals.filter((r) => r.call === 'pending').length,
      refusedCounterfactualUsd: refusals.reduce((s, r) => s + (r.counterfactualUsd ?? 0), 0),
      passed: passes.length, passedNetUsd: sum(passes), passedWithPosition: passes.filter((x) => x.position !== null).length,
      unchecked: unchecked.length, uncheckedNetUsd: sum(unchecked), uncheckedWithPosition: unchecked.filter((x) => x.position !== null).length,
    },
  };
}
