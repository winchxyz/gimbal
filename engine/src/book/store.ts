// The book on disk: an append-only JSONL of BookEvents (the record) and a derived summary JSON next to it.
//
// The JSONL is appended to, never rewritten: the new lines in one write, then fsync (and the directory's fsync when
// the write created the file). A crash in that write can leave the last line torn (no newline, not JSON): load drops
// it and cuts the file back to the last whole line, so the next append starts clean. Any other line that is not a
// whole event is refused: a book is never trimmed in the middle to make it readable.
//
// The summary is written atomically (the whole content to a temporary file, fsync, rename, then the directory's
// fsync): a crash before the rename leaves the old summary whole. It is always derived again from the JSONL, so a
// stale one is only stale.

import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, truncateSync, unlinkSync, writeSync,
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

/** Hooks for tests: called after the summary's temporary file is written and fsynced, before the rename. */
export interface StoreHooks {
  beforeRename?: (tmp: string, target: string) => void;
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
    this.#events = parsed.events;
    this.repaired = null;
    this.#needsNewline = false;
    if (parsed.torn > 0) {
      this.repaired = `dropped a torn last line (${parsed.torn} bytes, a write cut off)`;
      if (options.repair !== false) truncateSync(this.path, Buffer.byteLength(text) - parsed.torn);
    } else {
      this.#needsNewline = text !== '' && !text.endsWith('\n');
    }
    return [...this.#events];
  }

  get events(): readonly BookEvent[] {
    return this.#events;
  }

  /**
   * Appends events in one write, fsynced; memory moves only once the write went through. `persist` false: memory only
   * (a reader that must not write, the report's --sync).
   */
  append(events: readonly BookEvent[], persist = true): void {
    if (events.length === 0) return;
    if (!persist) {
      this.#events.push(...events);
      return;
    }
    const text = `${this.#needsNewline ? '\n' : ''}${events.map((e) => `${JSON.stringify(e)}\n`).join('')}`;
    mkdirSync(dirname(this.path), { recursive: true });
    let created = false;
    let fd: number;
    try {
      fd = openSync(this.path, 'wx');
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      fd = openSync(this.path, 'a');
    }
    try {
      writeSync(fd, text);
      fsyncSync(fd);
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
