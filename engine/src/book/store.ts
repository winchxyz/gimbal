// The book on disk: an append-only JSONL of BookEvents (the record) and a derived summary JSON next to it, both
// written atomically: a temporary file with the whole new content, fsynced, then renamed over the old one. A crash
// before the rename leaves the old file whole (and a stray .tmp, which the next write replaces); the summary is
// always derived again from the JSONL on load, so a crash between the two renames only leaves a stale summary.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Mode } from '@gimbal/shared';
import type { BookEvent } from './types.ts';
import { BOOK_VERSION } from './types.ts';

const SAFE = /^[a-z0-9._-]{1,64}$/;

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

/** Hooks for tests: called after the temporary file is written and fsynced, before the rename. */
export interface StoreHooks {
  beforeRename?: (tmp: string, target: string) => void;
}

/** Atomic: the whole content to `<path>.tmp`, fsynced, renamed over `path`. Throws when it could not. */
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
}

/** Parses a book's JSONL. Every line must be a whole event: a book is never trimmed to make it readable. */
export function parseBook(text: string, source = 'book'): BookEvent[] {
  const out: BookEvent[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch (err) {
      throw new Error(`${source}:${i + 1}: not JSON (${(err as Error).message})`);
    }
    const o = v as { v?: unknown; type?: unknown } | null;
    if (o === null || typeof o !== 'object') throw new Error(`${source}:${i + 1}: not an object`);
    if (o.v !== BOOK_VERSION) throw new Error(`${source}:${i + 1}: version ${JSON.stringify(o.v)}, not ${BOOK_VERSION}`);
    if (!['desk', 'enter', 'exit', 'funding', 'fee', 'transfer', 'sync', 'journal'].includes(String(o.type))) {
      throw new Error(`${source}:${i + 1}: unknown event type ${JSON.stringify(o.type)}`);
    }
    out.push(v as BookEvent);
  });
  return out;
}

export class BookStore {
  readonly path: string;
  readonly summaryPath: string;
  readonly #hooks: StoreHooks;
  #text = '';
  #events: BookEvent[] = [];

  constructor(path: string, hooks: StoreHooks = {}) {
    this.path = path;
    this.summaryPath = summaryFile(path);
    this.#hooks = hooks;
  }

  /** Reads the JSONL; a missing file is an empty book. Throws on an unreadable one (never starts it over). */
  load(): BookEvent[] {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      text = '';
    }
    this.#events = parseBook(text, this.path);
    this.#text = text === '' || text.endsWith('\n') ? text : `${text}\n`;
    return [...this.#events];
  }

  get events(): readonly BookEvent[] {
    return this.#events;
  }

  /** Appends events: the old lines unchanged plus the new ones, written atomically. Memory moves only once on disk. */
  append(events: readonly BookEvent[]): void {
    if (events.length === 0) return;
    const text = this.#text + events.map((e) => `${JSON.stringify(e)}\n`).join('');
    writeAtomic(this.path, text, this.#hooks);
    this.#text = text;
    this.#events = [...this.#events, ...events];
  }

  writeSummary(summary: unknown): void {
    writeAtomic(this.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, this.#hooks);
  }
}
