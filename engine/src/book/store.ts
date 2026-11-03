// The book on disk: an append-only JSONL of BookEvents (the record) and a derived summary JSON next to it.
//
// The JSONL is appended to, never rewritten: the new lines in one write, then fsync (and the directory's fsync when
// the write created the file). A crash in that write can leave the last line torn (no newline, not JSON): load drops
// it and cuts the file back to the last whole line, so the next append starts clean. Any other line that is not a
// whole event is refused: a book is never trimmed in the middle to make it readable.
//
// A write that fails is undone: the file's size is taken before it, and a short write (a full disk) or a failed fsync
// cuts the file back to that size and throws. So the next append never lands after torn bytes, and what the caller
// takes as not written (and writes again) is not on disk. Should the cut fail too, the store goes read only until
// the process restarts (every later append throws, `readOnly` says why): torn bytes may sit at the end, and only a
// load cuts them. Load also keeps the first copy of an event with the same identity (a funding key, a fee's fill, a
// transfer id, a journal entry id, a position's enter or exit, a fill record) and says how many it dropped.
//
// The summary is written atomically (the whole content to a temporary file, fsync, rename, then the directory's
// fsync): a crash before the rename leaves the old summary whole. It is always derived again from the JSONL, so a
// stale one is only stale.

import {
  closeSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, truncateSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Mode } from '@gimbal/shared';
import type { BookEvent } from './types.ts';
import { BOOK_VERSION } from './types.ts';

const SAFE = /^[a-z0-9._-]{1,64}$/;
const TYPES = ['desk', 'enter', 'exit', 'fill', 'funding', 'fee', 'transfer', 'sync', 'journal'];

/** The book's JSONL path: one per mode, contract and desk, next to the loop and trader state. */
export function bookFile(dir: string, mode: Mode, contractId: string | null, deskId: string | null): string {
  const part = (v: string, what: string) => {
    if (!SAFE.test(v)) throw new Error(`${what} ${JSON.stringify(v)} cannot name a book file`);
    return v;
  };
  const id = contractId === null || deskId === null ? '' : `-${part(contractId, 'contract')}-${part(deskId, 'desk')}`;
  return join(dir, `book-${mode}${id}.jsonl`);
}

/** The summary's path for a book's JSONL path. */
export function summaryFile(path: string): string {
  return path.replace(/\.jsonl$/, '.summary.json');
}

/** Every book JSONL in a directory, sorted by name. */
export function bookFilesIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((n) => /^book-.*\.jsonl$/.test(n)).sort().map((n) => join(dir, n));
}

/** Hooks for tests: the summary's rename, and the JSONL append's write and fsync (default node:fs). */
export interface StoreHooks {
  /** Called after the summary's temporary file is written and fsynced, before the rename. */
  beforeRename?: (tmp: string, target: string) => void;
  /** Writes `text` to the JSONL at byte `position`; returns the bytes written. */
  write?: (fd: number, text: string, position: number) => number;
  fsync?: (fd: number) => void;
  /** Cuts the JSONL back to `size` after a failed write (default ftruncateSync). */
  truncate?: (fd: number, size: number) => void;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What makes an event the same one when it shows twice; null: no identity (a desk or sync line may repeat). */
export function eventIdentity(e: BookEvent): string | null {
  switch (e.type) {
    case 'enter': return `enter|${e.positionId}`;
    case 'exit': return e.positionId === null ? `exit|-|${e.record.windowId}|${e.record.at}` : `exit|${e.positionId}`;
    case 'fill': return `fill|${e.positionId}|${e.record.windowId}|${e.record.at}`;
    case 'funding': return `funding|${e.key}`;
    case 'fee': return `fee|${e.positionId}|${e.recordAt}|${e.index}`;
    case 'transfer': return `transfer|${e.id}`;
    case 'journal': return `journal|${e.entry.id}`;
    default: return null;
  }
}

/** The events with every later copy of one identity dropped, and how many were. */
export function dedupeEvents(events: readonly BookEvent[]): { events: BookEvent[]; dropped: number } {
  const seen = new Set<string>();
  const out: BookEvent[] = [];
  for (const e of events) {
    const id = eventIdentity(e);
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(e);
  }
  return { events: out, dropped: events.length - out.length };
}

/** fsync a directory, so a created or renamed entry in it survives a power cut. Windows cannot: skipped there. */
export function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Atomic: the whole content to `<path>.tmp`, fsynced, renamed over `path`, the directory fsynced. Throws when it could not. */
export function writeAtomic(path: string, content: string, hooks: StoreHooks = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  hooks.beforeRename?.(tmp, path);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // the rename's error is the one to report
    }
    throw err;
  }
  fsyncDir(dirname(path));
}

function parseLine(line: string, where: string): BookEvent {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch (err) {
    throw new Error(`${where}: not JSON (${(err as Error).message})`);
  }
  const o = v as { v?: unknown; type?: unknown } | null;
  if (o === null || typeof o !== 'object') throw new Error(`${where}: not an object`);
  if (o.v !== BOOK_VERSION) throw new Error(`${where}: version ${JSON.stringify(o.v)}, not ${BOOK_VERSION}`);
  if (!TYPES.includes(String(o.type))) throw new Error(`${where}: unknown event type ${JSON.stringify(o.type)}`);
  return v as BookEvent;
}

/**
 * Parses a book's JSONL. `torn` is the byte length of a last line that has no newline and is not a whole event (a
 * write cut off by a crash); it is not in `events`. Every other line must be a whole event.
 */
export function parseBook(text: string, source = 'book'): { events: BookEvent[]; torn: number } {
  const out: BookEvent[] = [];
  const lines = text.split('\n');
  const last = lines.length - 1;
  let torn = 0;
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    if (i === last) {
      // No newline after it: the last write may have been cut off.
      try {
        out.push(parseLine(line, `${source}:${i + 1}`));
      } catch {
        torn = Buffer.byteLength(line);
      }
      return;
    }
    out.push(parseLine(line, `${source}:${i + 1}`));
  });
  return { events: out, torn };
}

export class BookStore {
  readonly path: string;
  readonly summaryPath: string;
  readonly #hooks: StoreHooks;
  #events: BookEvent[] = [];
  /** The file ends without a newline (its last line is whole): the next append starts with one. */
  #needsNewline = false;
  /** What load() repaired, for the log. */
  repaired: string | null = null;
  /** Why appends are refused until restart (a failed write that could not be cut back), or null. */
  #readOnly: string | null = null;

  constructor(path: string, hooks: StoreHooks = {}) {
    this.path = path;
    this.summaryPath = summaryFile(path);
    this.#hooks = hooks;
  }

  /**
   * Reads the JSONL; a missing file is an empty book. A torn last line is dropped and, unless `repair` is false (a
   * reader that must not write), cut from the file; `repaired` says so. Throws on any other unreadable line.
   */
  load(options: { repair?: boolean } = {}): BookEvent[] {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      text = '';
    }
    const parsed = parseBook(text, this.path);
    const unique = dedupeEvents(parsed.events);
    this.#events = unique.events;
    this.#needsNewline = false;
    const notes: string[] = [];
    if (parsed.torn > 0) {
      notes.push(`dropped a torn last line (${parsed.torn} bytes, a write cut off)`);
      if (options.repair !== false) truncateSync(this.path, Buffer.byteLength(text) - parsed.torn);
    } else {
      this.#needsNewline = text !== '' && !text.endsWith('\n');
    }
    if (unique.dropped > 0) notes.push(`dropped ${unique.dropped} event(s) written twice (a failed write that could not be cut back)`);
    this.repaired = notes.length === 0 ? null : notes.join('; ');
    return [...this.#events];
  }

  get events(): readonly BookEvent[] {
    return this.#events;
  }

  /** Why the store refuses appends until the process restarts, or null when it writes. */
  get readOnly(): string | null {
    return this.#readOnly;
  }

  /**
   * Appends events in one write, fsynced; memory moves only once the write went through. A write that fails (short,
   * or its fsync) is cut back off the file and thrown (see the header). `persist` false: memory only (a reader that
   * must not write, the report's --sync).
   */
  append(events: readonly BookEvent[], persist = true): void {
    if (events.length === 0) return;
    if (!persist) {
      this.#events.push(...events);
      return;
    }
    if (this.#readOnly !== null) throw new Error(`the book is read only until restart (${this.#readOnly})`);
    const text = `${this.#needsNewline ? '\n' : ''}${events.map((e) => `${JSON.stringify(e)}\n`).join('')}`;
    mkdirSync(dirname(this.path), { recursive: true });
    let created = false;
    let fd: number;
    try {
      fd = openSync(this.path, 'wx');
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Not 'a': a file opened to append cannot be cut back on every platform. The write goes at the end by position.
      fd = openSync(this.path, 'r+');
    }
    const write = this.#hooks.write ?? ((f: number, t: string, at: number) => writeSync(f, t, at));
    const sync = this.#hooks.fsync ?? fsyncSync;
    try {
      const size = fstatSync(fd).size;
      const bytes = Buffer.byteLength(text);
      try {
        const wrote = write(fd, text, size);
        if (wrote !== bytes) throw new Error(`short write: ${wrote} of ${bytes} bytes (disk full?)`);
        sync(fd);
      } catch (err) {
        // Undo: nothing of this write stays, so the next one starts on a whole line and nothing is booked twice.
        try {
          (this.#hooks.truncate ?? ftruncateSync)(fd, size);
          fsyncSync(fd);
        } catch (cut) {
          this.#readOnly = `${messageOf(err)}; cutting it back failed too (${messageOf(cut)})`;
          throw new Error(`${this.#readOnly}: the book is read only until restart, and load drops what it repeats`);
        }
        throw err;
      }
    } finally {
      closeSync(fd);
    }
    if (created) fsyncDir(dirname(this.path));
    this.#needsNewline = false;
    this.#events.push(...events);
  }

  writeSummary(summary: unknown): void {
    writeAtomic(this.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, this.#hooks);
  }
}
