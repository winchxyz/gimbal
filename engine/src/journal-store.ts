// The journal on disk, so its history survives a restart: every entry serve publishes, one JSON line each, in
// journal-<mode>[-<contract>-<desk>].jsonl under the state directory, next to the book and the risk check ledger.
// Testnet and mainnet keep it; replay does not (it plays the same recording again, and its clock is not real time).
//
// The file is appended to, one line per entry, fsynced. At start serve loads the newest JOURNAL_FILE_MAX_ENTRIES
// entries no older than JOURNAL_FILE_MAX_AGE_DAYS and the server serves them as if they had been published in this
// run, in the order they were written, with their own ids (so the web, which merges by id, shows no duplicates).
//
// The bound: at most JOURNAL_FILE_MAX_ENTRIES (5 000) entries and 30 days, whichever keeps fewer. The file may run up
// to JOURNAL_TRIM_SLACK (1 000) lines past the cap before it is rewritten to the newest entries within it, so a
// rewrite comes once per thousand entries, not on every one. Load trims the same way. A rewrite is atomic (the whole
// content to a temporary file, fsync, rename): a crash in it leaves the old file whole.
//
// Nothing here may stop the engine: a file that cannot be read is logged and the journal starts empty; a line that is
// not a whole entry (a torn last line after a crash, or anything else) is skipped and counted, and the next rewrite
// drops it; an append or a rewrite that fails is logged (at most once a minute) and the entry stays in memory only.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JournalEntry, Mode } from '@gimbal/shared';
import { writeAtomic } from './book/store.ts';

const DAY_MS = 86_400_000;
export const JOURNAL_FILE_MAX_ENTRIES = 5_000;
export const JOURNAL_FILE_MAX_AGE_DAYS = 30;
export const JOURNAL_TRIM_SLACK = 1_000;
/** A failing disk is logged at most this often (a journal entry can come every few seconds). */
const FAIL_LOG_EVERY_MS = 60_000;
const SAFE = /^[a-z0-9._-]{1,64}$/;

const KINDS: ReadonlySet<string> = new Set<JournalEntry['kind']>([
  'window', 'enter', 'exit', 'rotate', 'rescue', 'refused', 'veto', 'adl', 'error', 'funding', 'deposit', 'withdraw', 'fee', 'wait',
]);

/** The journal's path: one per mode, contract and desk, as the book's and the risk check ledger's. */
export function journalFile(dir: string, mode: Mode, contractId: string | null, deskId: string | null): string {
  const part = (v: string, what: string) => {
    if (!SAFE.test(v)) throw new Error(`${what} ${JSON.stringify(v)} cannot name a journal file`);
    return v;
  };
  const id = contractId === null || deskId === null ? '' : `-${part(contractId, 'contract')}-${part(deskId, 'desk')}`;
  return join(dir, `journal-${mode}${id}.jsonl`);
}

/** The entry a parsed line holds, or null when it is not a whole JournalEntry. */
export function journalEntryOf(v: unknown): JournalEntry | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id === '') return null;
  if (typeof e.t !== 'number' || !Number.isFinite(e.t)) return null;
  if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) return null;
  if (typeof e.summary !== 'string') return null;
  if (e.why !== undefined && typeof e.why !== 'string') return null;
  if (e.numbers === null || typeof e.numbers !== 'object' || Array.isArray(e.numbers)) return null;
  if (!Object.values(e.numbers).every((n) => typeof n === 'string' || (typeof n === 'number' && Number.isFinite(n)))) return null;
  if (!Array.isArray(e.tx) || !e.tx.every((t) => t !== null && typeof t === 'object' && !Array.isArray(t))) return null;
  return v as JournalEntry;
}

export interface JournalLoad {
  /** Oldest first, in the order they were written; one per id (the last copy written). */
  entries: JournalEntry[];
  /** Lines that were not a whole entry (a torn last line included). */
  skipped: number;
  /** Whole entries left out: older copies of an id, past the age, or past the cap. */
  dropped: number;
  /** Why the file could not be read (the journal starts empty), or null. */
  problem: string | null;
}

export interface JournalStoreOptions {
  now?: () => number;
  log?: (line: string) => void;
  maxEntries?: number;
  maxAgeMs?: number;
  slack?: number;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class JournalStore {
  readonly path: string;
  readonly maxEntries: number;
  readonly maxAgeMs: number;
  readonly #slack: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  /** Lines in the file now (whole or not): past maxEntries + slack, it is rewritten. */
  #lines = 0;
  /**
   * The file may end without a newline (a torn or failed write): the next append starts with one. True until a load
   * has looked: an empty line costs nothing, an entry glued to torn bytes is lost.
   */
  #needsNewline = true;
  #lastFailLog = -Infinity;
  #failsSinceLog = 0;

  constructor(path: string, options: JournalStoreOptions = {}) {
    this.path = path;
    this.maxEntries = options.maxEntries ?? JOURNAL_FILE_MAX_ENTRIES;
    this.maxAgeMs = options.maxAgeMs ?? JOURNAL_FILE_MAX_AGE_DAYS * DAY_MS;
    this.#slack = options.slack ?? JOURNAL_TRIM_SLACK;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  /** The kept entries, and the file trimmed to them when it held more (or lines that are not entries). Never throws. */
  load(): JournalLoad {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#needsNewline = false;
        return { entries: [], skipped: 0, dropped: 0, problem: null };
      }
      // Unreadable: leave it as it is for the owner to look at; appends still go to it, on a line of their own.
      this.#needsNewline = true;
      return { entries: [], skipped: 0, dropped: 0, problem: `${this.path}: not read (${messageOf(err)})` };
    }
    const read = this.#parse(text);
    this.#lines = read.lines;
    this.#needsNewline = text.length > 0 && !text.endsWith('\n');
    if (read.skipped > 0 || read.dropped > 0 || this.#needsNewline) this.#rewrite(read.entries);
    return { entries: read.entries, skipped: read.skipped, dropped: read.dropped, problem: null };
  }

  /** Writes one entry at the end of the file, fsynced; rewrites the file once it is past the cap. Never throws. */
  append(entry: JournalEntry): void {
    const line = `${this.#needsNewline ? '\n' : ''}${JSON.stringify(entry)}\n`;
    let fd: number | null = null;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      fd = openSync(this.path, 'a');
      // A write cut short leaves a torn line; the next one starts on a line of its own, and a load skips it.
      this.#needsNewline = true;
      writeSync(fd, line);
      fsyncSync(fd);
      this.#needsNewline = false;
      this.#lines++;
    } catch (err) {
      this.#failed(`journal: entry ${entry.id} not written to ${this.path}, kept in memory only (${messageOf(err)})`);
      return;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // the write's error, if any, is the one reported
        }
      }
    }
    if (this.#lines > this.maxEntries + this.#slack) this.#trim();
  }

  /** Reads the file again and rewrites it to the entries the bound keeps. */
  #trim(): void {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      this.#failed(`journal: ${this.path} not trimmed, not read (${messageOf(err)})`);
      return;
    }
    this.#rewrite(this.#parse(text).entries);
  }

  #rewrite(entries: readonly JournalEntry[]): void {
    try {
      writeAtomic(this.path, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
      this.#lines = entries.length;
      this.#needsNewline = false;
    } catch (err) {
      this.#failed(`journal: ${this.path} not rewritten to its newest ${entries.length} entries (${messageOf(err)})`);
    }
  }

  #parse(text: string): { entries: JournalEntry[]; skipped: number; dropped: number; lines: number } {
    const all: JournalEntry[] = [];
    let skipped = 0;
    let lines = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      lines++;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      const e = journalEntryOf(v);
      if (e === null) skipped++;
      else all.push(e);
    }
    // One per id: the last copy written, in its place.
    const lastAt = new Map<string, number>();
    all.forEach((e, i) => lastAt.set(e.id, i));
    const since = this.#now() - this.maxAgeMs;
    const kept = all.filter((e, i) => lastAt.get(e.id) === i && e.t >= since).slice(-this.maxEntries);
    return { entries: kept, skipped, dropped: all.length - kept.length, lines };
  }

  #failed(line: string): void {
    const now = this.#now();
    if (now - this.#lastFailLog < FAIL_LOG_EVERY_MS) {
      this.#failsSinceLog++;
      return;
    }
    const more = this.#failsSinceLog === 0 ? '' : ` (and ${this.#failsSinceLog} more journal write failures since the last line)`;
    this.#lastFailLog = now;
    this.#failsSinceLog = 0;
    this.#log(`${line}${more}`);
  }
}

/** What serve hands the server (EngineServer's journalHistory and keepJournal): nothing in replay or when unusable. */
export interface KeptJournal {
  journalHistory?: readonly JournalEntry[];
  keepJournal?: (entry: JournalEntry) => void;
}

/**
 * serve's journal: in testnet and mainnet, the store under `dir` loaded (its start line logged) and every entry
 * appended; in replay nothing. Never throws: a file it cannot name or read is logged and the journal starts empty.
 */
export function openJournal(mode: Mode, dir: string, contractId: string | null, deskId: string | null, log: (line: string) => void): KeptJournal {
  if (mode === 'replay') {
    log('journal: memory only in replay (it plays the recording again on every start)');
    return {};
  }
  let store: JournalStore;
  try {
    store = new JournalStore(journalFile(dir, mode, contractId, deskId), { log });
  } catch (err) {
    log(`journal: NOT kept on disk (${messageOf(err)}); memory only for this run`);
    return {};
  }
  const kept = store.load();
  const cap = `last ${store.maxEntries} entries within ${Math.round(store.maxAgeMs / DAY_MS)} days`;
  if (kept.problem !== null) log(`journal: starting empty, ${kept.problem}; new entries still go to it`);
  else {
    const left = [kept.skipped > 0 ? `${kept.skipped} unreadable line(s) skipped` : '', kept.dropped > 0 ? `${kept.dropped} entries dropped (older copies of an id, or past the bound)` : '']
      .filter((x) => x !== '').join(', ');
    log(`journal: ${kept.entries.length} entries loaded from ${store.path} (keeps the ${cap})${left === '' ? '' : `; ${left}`}`);
  }
  return { journalHistory: kept.entries, keepJournal: (entry) => store.append(entry) };
}
