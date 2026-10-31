import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REFUSAL_CODES, REFUSALS, REPO_BLOB, testLabel, testUrl } from './refusals.ts';
import { findRefusalTests, readContractSources, type SourceFile } from './scan.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');

test('the table has the contract’s codes, in the contract’s order (contract/core/src/errors.rs, ALL)', () => {
  const source = read('contract/core/src/errors.rs');
  const all = /pub const ALL: \[&str; (\d+)\] = \[([^\]]*)\]/.exec(source);
  assert.ok(all, 'ALL is in errors.rs');
  const names = all[2]!
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');
  assert.equal(names.length, Number(all[1]));
  assert.deepEqual([...REFUSAL_CODES], names);
});

test('the table has the codes of docs/interfaces.md §1.5, in its order', () => {
  const doc = read('docs/interfaces.md');
  const start = doc.indexOf('### 1.5 Refusals');
  const end = doc.indexOf('\n### 1.6', start);
  assert.ok(start >= 0 && end > start);
  const codes: string[] = [];
  for (const line of doc.slice(start, end).split('\n')) {
    const cell = line.split('|')[1]?.trim() ?? '';
    // A row can name two codes: "`E_NO_DESK` / `E_DESK_EXISTS`".
    for (const m of cell.matchAll(/`(E_[A-Z_]+)`/g)) codes.push(m[1]!);
  }
  assert.deepEqual([...REFUSAL_CODES], codes);
});

test('every code has one plain sentence, and no two say the same', () => {
  assert.equal(REFUSALS.length, 18);
  assert.equal(new Set(REFUSAL_CODES).size, REFUSALS.length);
  assert.equal(new Set(REFUSALS.map((r) => r.meaning)).size, REFUSALS.length);
  for (const r of REFUSALS) {
    assert.match(r.meaning, /^[A-Z].*\.$/, r.code);
    assert.ok(r.meaning.length < 140, `${r.code}: one line`);
    assert.doesNotMatch(r.meaning, /E_[A-Z]/, `${r.code}: the meaning does not name a code`);
  }
});

test('a link is the repository’s default branch, the file and the line', () => {
  assert.equal(REPO_BLOB, 'https://github.com/winchxyz/gimbal/blob/main/');
  assert.equal(testUrl({ path: 'contract/src/tests.rs', line: 777 }), 'https://github.com/winchxyz/gimbal/blob/main/contract/src/tests.rs#L777');
  assert.equal(testLabel({ path: 'contract/src/tests.rs', line: 777 }), 'tests.rs:777');
  assert.equal(testLabel({ path: 'contract/src/hl.rs', line: 341 }), 'hl.rs:341');
  assert.equal(testLabel({ path: 'contract/src/tests/hl.rs', line: 12 }), 'tests/hl.rs:12', 'not the same file as src/hl.rs');
  assert.equal(testLabel({ path: 'contract/core/src/hl.rs', line: 247 }), 'core/hl.rs:247', 'not the same file as src/hl.rs');
  assert.equal(testLabel({ path: 'contract/core/tests/hl_vectors.rs', line: 619 }), 'core/hl_vectors.rs:619');
  assert.equal(testLabel({ path: 'lib.rs', line: 3 }), 'lib.rs:3');
});

// ---- the scan, on small fixtures ----

const file = (path: string, ...lines: string[]): SourceFile => ({ path, text: lines.join('\n') });
const CODES = ['E_PAUSED', 'E_SIZE', 'E_ARGS'];

test('a code in a tests folder is found at its line', () => {
  const found = findRefusalTests([file('contract/src/tests.rs', 'fn a() {', '    assert_refused(r, "E_PAUSED");', '}')], CODES);
  assert.deepEqual(found.E_PAUSED, [{ path: 'contract/src/tests.rs', line: 2 }]);
  assert.deepEqual(found.E_SIZE, []);
  assert.deepEqual(Object.keys(found), CODES, 'every code is a key, found or not');
});

test('outside a tests folder only the #[cfg(test)] part of a file counts', () => {
  const src = file('contract/src/hl.rs', 'fn f() { refuse(E_SIZE, "too big"); }', '#[cfg(test)]', 'mod tests {', '    fn t() { assert_eq!(r.code, E_SIZE); }', '}');
  assert.deepEqual(findRefusalTests([src], CODES).E_SIZE, [{ path: 'contract/src/hl.rs', line: 4 }]);
  assert.deepEqual(findRefusalTests([file('contract/src/hl.rs', 'fn f() { refuse(E_SIZE, "x"); }')], CODES).E_SIZE, [], 'no test part, no link');
});

test('use lists, comments and the file that defines the codes are not tests', () => {
  const files = [
    file('contract/src/tests.rs', 'use gimbal_core::errors::{', '    E_SIZE,', '};', '// E_SIZE is refused when the order is zero', '#[test]', 'fn z() { assert!(m.starts_with("E_SIZE")); }'),
    file('contract/core/src/errors.rs', '#[cfg(test)]', 'mod tests { fn t() { assert_eq!(E_SIZE, "E_SIZE"); } }'),
  ];
  assert.deepEqual(findRefusalTests(files, CODES).E_SIZE, [{ path: 'contract/src/tests.rs', line: 6 }]);
});

test('a code is matched whole: E_ARGS is not found inside E_ARGS_MORE', () => {
  const found = findRefusalTests([file('contract/src/tests.rs', 'assert!(m.contains("E_ARGS_MORE"));')], CODES);
  assert.deepEqual(found.E_ARGS, []);
});

test('per file the first asserting line wins over an earlier line that only names the code', () => {
  const found = findRefusalTests([file('contract/src/tests.rs', 'let code = "E_PAUSED";', 'assert_refused(r, "E_PAUSED");')], CODES);
  assert.deepEqual(found.E_PAUSED, [{ path: 'contract/src/tests.rs', line: 2 }]);
});

test('links come best first, one kind of test each, and at most three', () => {
  const line = 'assert_refused(r, "E_PAUSED");';
  const found = findRefusalTests(
    [
      file('contract/core/tests/vectors.rs', line),
      file('contract/core/src/policy.rs', '#[cfg(test)]', line),
      file('contract/src/sol.rs', '#[cfg(test)]', line),
      file('contract/src/tests/pause.rs', line),
      file('contract/src/tests/rescue.rs', line),
      file('contract/src/tests.rs', line),
    ],
    CODES,
  );
  // The contract's own tests, then another of its modules, then the core's logic; the vectors and the second file of
  // the contract's own tests make way.
  assert.deepEqual(
    found.E_PAUSED!.map((t) => t.path),
    ['contract/src/tests.rs', 'contract/src/sol.rs', 'contract/core/src/policy.rs'],
  );
});

// ---- the contract as it is checked out ----

test('every code has at least one test link in the contract as checked out, and each link points at a line that names it', () => {
  const sources = readContractSources(ROOT);
  assert.ok(sources.length > 5, 'the scan found the contract’s sources');
  assert.ok(sources.every((s) => s.path.startsWith('contract/') && !s.path.includes('\\')));
  const found = findRefusalTests(sources, REFUSAL_CODES);
  for (const code of REFUSAL_CODES) {
    const links = found[code]!;
    assert.ok(links.length >= 1, `${code} has no test that names it`);
    assert.ok(links.length <= 3, `${code} has ${links.length} links`);
    for (const link of links) {
      assert.ok(existsSync(`${ROOT}${link.path}`), `${link.path} exists`);
      const lines = read(link.path).split(/\r?\n/);
      assert.ok(link.line >= 1 && link.line <= lines.length, `${link.path}:${link.line} is inside the file`);
      assert.match(lines[link.line - 1]!, new RegExp(`\\b${code}\\b`), `${link.path}:${link.line} names ${code}`);
    }
    assert.equal(new Set(links.map((l) => `${l.path}:${l.line}`)).size, links.length, `${code}: no link twice`);
  }
});
