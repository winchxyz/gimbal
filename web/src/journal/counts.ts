// The Journal's counters, true: the engine counts every entry it holds (`EngineState.journalCounts`), not only the
// newest page the screen loaded, and the page adds each new entry it hears on the stream. An engine from before
// the field has no counts, and the page falls back to counting what it loaded, saying since when. Pure, so tested.
import type { JournalCounts, JournalEntry } from '@gimbal/shared';
import { KINDS, type FilterId, type Kind } from './kinds.ts';
import { countsOf, filterCounts, type Counts } from './model.ts';

export interface TrueCounts extends Counts {
  filters: Record<FilterId, number>;
  /** Errors the engine journaled: a venue that did not answer, a leg it could not read (each an incident). */
  incidents: number;
  /** The oldest entry counted (ms), or null for an empty journal. */
  since: number | null;
  /** true: every entry the engine holds; false: only the entries this page loaded. */
  complete: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** `EngineState.journalCounts` checked, or null when it is absent or not counts (an older engine). */
export function parseJournalCounts(value: unknown): JournalCounts | null {
  if (!isObject(value)) return null;
  const { entries, since, kinds, refusedHeld, refusedCancelled } = value;
  if (!isCount(entries) || !isCount(refusedHeld) || !isCount(refusedCancelled) || !isObject(kinds)) return null;
  if (since !== null && (typeof since !== 'number' || !Number.isFinite(since))) return null;
  const clean: JournalCounts['kinds'] = {};
  for (const [kind, n] of Object.entries(kinds)) if (kind in KINDS && isCount(n)) clean[kind as Kind] = n;
  return { entries, since, kinds: clean, refusedHeld, refusedCancelled };
}

/** The counts with one more entry (a new one heard on the stream). */
export function withEntry(counts: JournalCounts, entry: JournalEntry): JournalCounts {
  const held = entry.kind === 'refused' && Number(entry.numbers.held) === 1;
  const cancelled = entry.kind === 'refused' && !held && Number(entry.numbers.cancelled) === 1;
  return {
    entries: counts.entries + 1,
    since: counts.since === null ? entry.t : Math.min(counts.since, entry.t),
    kinds: { ...counts.kinds, [entry.kind]: (counts.kinds[entry.kind] ?? 0) + 1 },
    refusedHeld: counts.refusedHeld + (held ? 1 : 0),
    refusedCancelled: counts.refusedCancelled + (cancelled ? 1 : 0),
  };
}

/** The counters from the engine's counts, or from the loaded entries when it sent none. */
export function trueCounts(engine: JournalCounts | null, loaded: readonly JournalEntry[]): TrueCounts {
  if (engine === null) {
    const c = countsOf(loaded);
    const incidents = loaded.filter((e) => e.kind === 'error').length;
    return { ...c, filters: filterCounts(loaded), incidents, since: loaded[loaded.length - 1]?.t ?? null, complete: false };
  }
  const filters: Record<FilterId, number> = { all: engine.entries, trades: 0, funding: 0, money: 0, rescue: 0, refused: 0 };
  let signed = 0;
  for (const [kind, n] of Object.entries(engine.kinds) as [Kind, number][]) {
    const info = KINDS[kind];
    if (info.filter !== null) filters[info.filter] += n;
    if (info.signed) signed += n;
  }
  const refused = (engine.kinds.refused ?? 0) - engine.refusedHeld - engine.refusedCancelled;
  return { signed, refused: Math.max(0, refused), vetoed: engine.kinds.veto ?? 0, held: engine.refusedHeld, filters, incidents: engine.kinds.error ?? 0, since: engine.since, complete: true };
}

/** The Journal's sentence: what the contract signed, and that no private key signed anything. */
export function journalAnswer(c: Pick<TrueCounts, 'signed'> & { complete?: boolean }, replay: boolean): string {
  // Counted over the loaded page only (an engine without journalCounts): no total it cannot stand behind.
  if (c.complete === false) return replay ? 'A replay: nothing is signed or sent.' : 'No action of this desk was signed by a private key.';
  const n = c.signed.toLocaleString('en-US');
  if (replay) return `${n} simulated ${c.signed === 1 ? 'action' : 'actions'}. Nothing signed or sent.`;
  return `${n} ${c.signed === 1 ? 'action' : 'actions'} signed by the contract. None by a private key.`;
}
