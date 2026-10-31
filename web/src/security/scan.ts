// Finds, for every refusal code, the lines of the contract's tests that name it. Pure on `SourceFile`s, so the rules are
// tested on small fixtures; `readContractSources` reads the real ones (the build and one test call it, the page never).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { TestLink } from './refusals.ts';

export interface SourceFile {
  /** Relative to the repository root, with forward slashes: `contract/src/tests.rs`. */
  path: string;
  text: string;
}

/** How many links one code gets: enough to see the contract's own test and the logic's, not a wall of lines. */
const MAX_LINKS = 3;

/** The files that hold only tests: everything in them is test code. */
const isTestFile = (path: string): boolean => /(^|\/)tests\//.test(path) || path === 'contract/src/tests.rs';

/**
 * Where a code is asserted, best first: the contract's own tests (a refusal its methods return), then its other
 * modules, then the pure logic in `contract/core`, then the vectors that venue SDKs produced.
 */
function rankOf(path: string): number {
  if (path === 'contract/src/tests.rs' || path.startsWith('contract/src/tests/')) return 0;
  if (path.startsWith('contract/src/')) return 1;
  if (path.startsWith('contract/core/src/')) return 2;
  return 3;
}

/** The file that defines the codes: its own tests only check how a refusal prints. */
const DEFINITION = 'contract/core/src/errors.rs';

const ASSERTS = /assert|should_panic|starts_with|\.code\b|expected/;

interface Hit {
  path: string;
  line: number;
  asserts: boolean;
}

/** The test lines of one file that name one of the codes, found in one pass. `use` lists and comments are not tests. */
function hitsIn(file: SourceFile, codes: readonly string[]): Map<string, Hit[]> {
  const out = new Map<string, Hit[]>();
  if (file.path === DEFINITION) return out;
  const lines = file.text.split(/\r?\n/);
  // Outside a tests folder, test code starts at the first `#[cfg(test)]` of the file.
  const from = isTestFile(file.path) ? 0 : lines.findIndex((l) => l.trim() === '#[cfg(test)]');
  if (from < 0) return out;
  let inUse = false;
  for (let i = from; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (/^(pub\s+)?use\s/.test(text)) inUse = true;
    const skip = inUse || text.startsWith('//');
    if (inUse && text.includes(';')) inUse = false;
    if (skip) continue;
    for (const code of codes) {
      if (!new RegExp(`\\b${code}\\b`).test(text)) continue;
      const list = out.get(code) ?? [];
      list.push({ path: file.path, line: i + 1, asserts: ASSERTS.test(text) });
      out.set(code, list);
    }
  }
  return out;
}

/** Up to `MAX_LINKS` links per code, in ranked order; a code no test names maps to an empty list. */
export function findRefusalTests(files: readonly SourceFile[], codes: readonly string[]): Record<string, TestLink[]> {
  const byCode = new Map<string, Hit[]>(codes.map((c) => [c, []]));
  for (const file of files) for (const [code, hits] of hitsIn(file, codes)) byCode.get(code)!.push(...hits);

  const result: Record<string, TestLink[]> = {};
  for (const code of codes) {
    // The best line of each file: the first one that asserts, else the first one.
    const perFile = new Map<string, Hit>();
    for (const hit of byCode.get(code)!) {
      const have = perFile.get(hit.path);
      if (have === undefined || (!have.asserts && hit.asserts)) perFile.set(hit.path, hit);
    }
    const ranked = [...perFile.values()].sort((a, b) => rankOf(a.path) - rankOf(b.path) || (a.path < b.path ? -1 : 1));
    // One per rank first, so the three links are three kinds of test; then the rest in order.
    const picked: Hit[] = [];
    for (const rank of [0, 1, 2, 3]) {
      const first = ranked.find((h) => rankOf(h.path) === rank);
      if (first) picked.push(first);
    }
    for (const hit of ranked) if (picked.length < MAX_LINKS && !picked.includes(hit)) picked.push(hit);
    result[code] = picked
      .slice(0, MAX_LINKS)
      .sort((a, b) => rankOf(a.path) - rankOf(b.path) || (a.path < b.path ? -1 : 1))
      .map((h) => ({ path: h.path, line: h.line }));
  }
  return result;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'target' || name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.rs')) out.push(path);
  }
  return out;
}

/** Every Rust source under `contract/` of the checkout at `root`. */
export function readContractSources(root: string): SourceFile[] {
  return walk(join(root, 'contract'))
    .map((full) => ({ path: relative(root, full).replaceAll('\\', '/'), text: readFileSync(full, 'utf8') }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}
