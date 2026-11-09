// The Journal as a story (UX, Journal): one line per holding period instead of one per check, funding in words, and
// an error as an incident with its recovery. The Desk's "Latest" reads the same lines. Pure, so it is tested.
//
// The engine journals a `wait` at every check of a held pair ("Hold MON: 49.0 % net of the exit…"), and on a quiet
// desk at every change of its reason to wait. Those are folded:
// - every hold check of one pair (`numbers.window`, the same `hoursHeld` clock) becomes one holding period, whatever
//   funding or incidents happened in between. The period starts when the pair opened, worked out from the newest
//   check's `hoursHeld`, not from the oldest check on the page;
// - a run of other waits in a row (no pair held) stays one "Waiting" run, as before (waits.ts).
// A check whose numbers were stale for that scan is counted as a check and never shown in words: it is the engine's own
// state, not something a visitor needs (UX, Rules).
import type { JournalEntry } from '@gimbal/shared';
import { venueName } from '../windows/format.ts';
import { clock, numberOf } from './entry.ts';

const HOUR_MS = 3_600_000;
/** Two hold checks belong to one period when the opening times their `hoursHeld` gives are this close. */
const SAME_OPEN_MS = 10 * 60_000;
const MINUS = '−';

export type StoryItem =
  | {
      type: 'hold';
      id: string;
      /** The newest check: where the line sits in the feed, newest first. */
      t: number;
      /** When the pair opened (from `hoursHeld`), or the oldest check when the engine sent no clock. */
      from: number;
      /** The oldest check on the page. */
      firstCheck: number;
      symbol: string;
      checks: number;
      /** Still held: the newest check is the newest hold check on the page and the desk still holds the window. */
      ongoing: boolean;
      text: string;
      entries: JournalEntry[];
    }
  | { type: 'waits'; id: string; t: number; entries: JournalEntry[] }
  | { type: 'incident'; id: string; t: number; text: string; entry: JournalEntry; recovery: JournalEntry | null }
  | { type: 'funding'; id: string; t: number; text: string; usd: number | null; entry: JournalEntry }
  | { type: 'entry'; id: string; t: number; entry: JournalEntry };

/** `+$0.0016`, `−$0.30`: four decimals under a cent, so a small funding payment is never `$0.00`. */
export function smallUsd(value: number): string {
  const abs = Math.abs(value);
  const text = abs < 0.01 ? abs.toFixed(4) : abs.toFixed(2);
  if (Number(text) === 0) return `$${text}`;
  return `${value < 0 ? MINUS : '+'}$${text}`;
}

/** A hold check (`numbers.action` "hold" with the window it holds). */
export const isHoldCheck = (e: JournalEntry): boolean => e.kind === 'wait' && e.numbers.action === 'hold' && typeof e.numbers.window === 'string';

/** A venue that answers again after it did not (`numbers.venue`, `downS`, "answering again"). */
export const isRecovery = (e: JournalEntry): boolean =>
  e.kind === 'wait' && typeof e.numbers.venue === 'string' && numberOf(e, 'downS') !== null && /answering again/.test(e.summary);

/** A venue that did not answer (`error` with `numbers.venue` and `downS`). */
export const isOutage = (e: JournalEntry): boolean => e.kind === 'error' && typeof e.numbers.venue === 'string' && numberOf(e, 'downS') !== null;

/** `Funding paid +$0.0016: Phoenix +$0.0014, Hyperliquid +$0.0001`, the largest first. */
export function fundingText(e: JournalEntry): string {
  const total = numberOf(e, 'usd');
  const parts = Object.keys(e.numbers)
    .filter((k) => k.endsWith('Usd') && k !== 'usd' && k !== 'feeUsd')
    .map((k) => ({ venue: venueName(k.slice(0, -3)), usd: numberOf(e, k) }))
    // A leg that rounds to $0.0000 says nothing: it is left out of the words.
    .filter((p): p is { venue: string; usd: number } => p.usd !== null && Number(Math.abs(p.usd).toFixed(4)) !== 0)
    .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));
  const head = total === null ? 'Funding' : total < 0 ? `Funding cost ${smallUsd(total)}` : `Funding paid ${smallUsd(total)}`;
  return parts.length === 0 ? head : `${head}: ${parts.map((p) => `${p.venue} ${smallUsd(p.usd)}`).join(', ')}`;
}

/** `Hyperliquid did not answer for 33 s; read again at 04:24`. */
export function incidentText(e: JournalEntry, recovery: JournalEntry | null): string {
  const venue = venueName(String(e.numbers.venue));
  const down = numberOf(e, 'downS');
  const head = `${venue} did not answer${down === null ? '' : ` for ${Math.round(down)} s`}`;
  return recovery === null ? head : `${head}; read again at ${clock(recovery.t)}`;
}

const symbolOf = (e: JournalEntry): string => {
  const m = /^Hold ([A-Za-z0-9]+)/.exec(e.summary);
  if (m?.[1]) return m[1];
  return String(e.numbers.window).split('-')[0]!.toUpperCase();
};

const openedAt = (e: JournalEntry): number | null => {
  const h = numberOf(e, 'hoursHeld');
  return h === null ? null : e.t - h * HOUR_MS;
};

/** `checked 46 times`, `checked once` */
const checksText = (n: number): string => (n === 1 ? 'checked once' : `checked ${n} times`);

/**
 * The holding period's line. Ongoing: `Holding MON since 03:08, checked 46 times`. Ended: `Held MON from 03:08 to
 * 09:10, checked 46 times`. When the checks on the page start after the pair opened (older pages not loaded yet), the
 * count says from when: `checked 46 times since 03:56`.
 */
export function holdText(item: Pick<Extract<StoryItem, { type: 'hold' }>, 'symbol' | 'from' | 'firstCheck' | 't' | 'checks' | 'ongoing'>): string {
  const partial = item.firstCheck - item.from > SAME_OPEN_MS;
  const count = `${checksText(item.checks)}${partial ? ` since ${clock(item.firstCheck)}` : ''}`;
  return item.ongoing
    ? `Holding ${item.symbol} since ${clock(item.from)}, ${count}`
    : `Held ${item.symbol} from ${clock(item.from)} to ${clock(item.t)}, ${count}`;
}

/**
 * The entries (newest first, as the engine sends them) as story lines, newest first. `heldWindowId` is the window the
 * desk holds now (`Window.held`), so the newest period of that window reads "Holding"; null when nothing is held.
 * `heldSymbol` is the symbol of the desk's open legs: it stands in while the windows are not read yet (right after the
 * engine restarts), so a pair still held never reads "Held … to …" for that minute. The window, once known, wins.
 */
export function storyOf(entries: readonly JournalEntry[], heldWindowId: string | null = null, heldSymbol: string | null = null): StoryItem[] {
  const items: StoryItem[] = [];

  // Holding periods: by window, then by the opening time the checks give.
  const periods: { window: string; opened: number | null; entries: JournalEntry[] }[] = [];
  for (const e of entries) {
    if (!isHoldCheck(e)) continue;
    const window = String(e.numbers.window);
    const opened = openedAt(e);
    const into = periods.find((p) => p.window === window && (p.opened === null || opened === null || Math.abs(p.opened - opened) <= SAME_OPEN_MS));
    if (into) into.entries.push(e);
    else periods.push({ window, opened, entries: [e] });
  }
  const newestPeriodOf = new Map<string, number>();
  for (const p of periods) newestPeriodOf.set(p.window, Math.max(newestPeriodOf.get(p.window) ?? -Infinity, p.entries[0]!.t));
  // Without the window: the newest period of the held symbol, across that symbol's windows.
  const newestOfSymbol = heldWindowId === null && heldSymbol !== null
    ? Math.max(-Infinity, ...periods.filter((p) => symbolOf(p.entries[0]!) === heldSymbol).map((p) => p.entries[0]!.t))
    : null;
  for (const p of periods) {
    const newest = p.entries[0]!;
    const oldest = p.entries[p.entries.length - 1]!;
    const from = p.opened ?? oldest.t;
    const symbol = symbolOf(newest);
    const base = {
      symbol,
      from: Math.min(from, oldest.t),
      firstCheck: oldest.t,
      t: newest.t,
      checks: p.entries.length,
      ongoing: heldWindowId !== null
        ? p.window === heldWindowId && newestPeriodOf.get(p.window) === newest.t
        : symbol === heldSymbol && newestOfSymbol === newest.t,
    };
    items.push({ type: 'hold', id: `hold-${oldest.id}`, ...base, text: holdText(base), entries: p.entries });
  }

  // Outages with the recovery that followed (the first one for that venue after it).
  const recoveries = entries.filter(isRecovery);
  const used = new Set<string>();
  for (const e of entries) {
    if (!isOutage(e)) continue;
    const recovery = recoveries.filter((r) => r.numbers.venue === e.numbers.venue && r.t > e.t).sort((a, b) => a.t - b.t)[0] ?? null;
    if (recovery) used.add(recovery.id);
    items.push({ type: 'incident', id: e.id, t: e.t, text: incidentText(e, recovery), entry: e, recovery });
  }

  // Everything else in order; other waits fold into runs of consecutive ones (holds and recoveries do not break a run).
  let run: JournalEntry[] = [];
  const flush = () => {
    if (run.length > 0) items.push({ type: 'waits', id: run[run.length - 1]!.id, t: run[0]!.t, entries: run });
    run = [];
  };
  for (const e of entries) {
    if (isHoldCheck(e) || isOutage(e)) continue;
    if (isRecovery(e)) {
      // A recovery whose outage is not on the page still says so.
      if (!used.has(e.id)) {
        flush();
        items.push({ type: 'incident', id: e.id, t: e.t, text: `${venueName(String(e.numbers.venue))} answers again after ${Math.round(numberOf(e, 'downS') ?? 0)} s`, entry: e, recovery: e });
      }
      continue;
    }
    if (e.kind === 'wait' && e.numbers.stage !== 'attestation') {
      run.push(e);
      continue;
    }
    flush();
    if (e.kind === 'funding') items.push({ type: 'funding', id: e.id, t: e.t, text: fundingText(e), usd: numberOf(e, 'usd'), entry: e });
    else items.push({ type: 'entry', id: e.id, t: e.t, entry: e });
  }
  flush();

  return items.sort((a, b) => b.t - a.t);
}

/**
 * The Desk's Latest: the three newest lines, leaving out the NEAR AI attestation record (a long technical line that
 * belongs in the Journal, where it stays).
 */
export const latestOf = (items: readonly StoryItem[], n = 3): StoryItem[] =>
  items.filter((i) => !(i.type === 'entry' && i.entry.numbers.stage === 'attestation')).slice(0, n);

/** The time a line shows: a holding period shows when it began; everything else its own time. */
export const storyTime = (item: StoryItem): number => (item.type === 'hold' ? item.from : item.t);
