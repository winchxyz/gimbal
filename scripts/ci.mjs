#!/usr/bin/env node
// Local CI: the same checks the GitHub workflow runs, for machines where Actions does not start.
// Prints one line when everything is green; otherwise the failing step's tail, and exits 1.
//
//   npm run ci                    all steps (contract steps only when contract/Cargo.toml exists)
//   npm run ci -- --only npm      install, build, test, typecheck
//   npm run ci -- --only contract fmt, clippy, tests, wasm

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contractDir = join(root, 'contract');
const TAIL_LINES = 60;

const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? null : process.argv[onlyAt + 1];
if (only !== null && only !== 'npm' && only !== 'contract') {
  console.error('usage: node scripts/ci.mjs [--only npm|contract]');
  process.exit(2);
}

// On Windows the near-sdk tests and clippy need the MSVC toolchain in a separate target dir, while the
// wasm build keeps the default (gnu) toolchain and target dir. Elsewhere the default toolchain does both.
const windows = process.platform === 'win32';
const msvc = windows ? '+stable-x86_64-pc-windows-msvc ' : '';
const msvcEnv = windows ? { AWS_LC_SYS_PREBUILT_NASM: '1', CARGO_TARGET_DIR: 'target/msvc' } : {};

const steps = [];
if (only !== 'contract') {
  steps.push(
    { name: 'npm ci', cmd: 'npm ci --no-audit --no-fund' },
    { name: 'build', cmd: 'npm run build' },
    { name: 'test', cmd: 'npm test', check: nodeTestCounts },
    { name: 'typecheck', cmd: 'npm run typecheck' },
  );
}
if (only !== 'npm' && existsSync(join(contractDir, 'Cargo.toml'))) {
  steps.push(
    { name: 'cargo fmt', cmd: 'cargo fmt --all --check', cwd: contractDir },
    {
      name: 'clippy',
      cmd: `cargo ${msvc}clippy --workspace --all-targets -- -D warnings`,
      cwd: contractDir,
      env: msvcEnv,
    },
    { name: 'cargo test', cmd: `cargo ${msvc}test --workspace`, cwd: contractDir, env: msvcEnv, check: cargoTestCount },
    {
      name: 'wasm',
      cmd: 'cargo near build non-reproducible-wasm --no-abi',
      cwd: contractDir,
      env: { CARGO_TARGET_DIR: undefined },
      check: wasmSize,
    },
  );
}

const started = Date.now();
const notes = [];
for (const step of steps) {
  const env = { ...process.env, ...step.env };
  for (const [k, v] of Object.entries(step.env ?? {})) if (v === undefined) delete env[k];
  // `2>&1` works in both cmd.exe and sh, and keeps stdout and stderr in the order they were written.
  const run = spawnSync(`${step.cmd} 2>&1`, {
    cwd: step.cwd ?? root,
    env,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  const output = (run.stdout ?? '') + (run.stderr ?? '');
  let failure = run.error ? String(run.error) : run.status !== 0 ? `exit code ${run.status}` : null;
  if (!failure && step.check) {
    const result = step.check(output);
    if (result.error) failure = result.error;
    else if (result.note) notes.push(result.note);
  }
  if (failure) {
    const tail = output.trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join('\n');
    console.log(`${tail}\n\nci: FAILED at "${step.name}" (${step.cmd}): ${failure}`);
    process.exit(1);
  }
}

const seconds = Math.round((Date.now() - started) / 1000);
console.log(`ci: green - ${steps.map((s) => s.name).join(', ')}${notes.length ? ` (${notes.join('; ')})` : ''} in ${seconds} s`);

// npm scripts run under cmd.exe on Windows, where a single-quoted glob matches nothing and node --test
// then passes with zero tests. Every workspace's summary must count at least one test.
function nodeTestCounts(output) {
  const counts = [...output.matchAll(/^\S*\s*tests (\d+)\s*$/gm)].map((m) => Number(m[1]));
  if (counts.length === 0) return { error: 'no "tests N" summary in the output' };
  if (counts.some((n) => n === 0)) return { error: `a workspace ran 0 tests (counts: ${counts.join(', ')})` };
  return { note: `node tests ${counts.join(' + ')}` };
}

function cargoTestCount(output) {
  const passed = [...output.matchAll(/^test result: ok\. (\d+) passed/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
  if (passed === 0) return { error: 'cargo ran 0 tests' };
  return { note: `cargo tests ${passed}` };
}

function wasmSize() {
  const wasm = join(contractDir, 'target', 'near', 'gimbal.wasm');
  if (!existsSync(wasm)) return { error: `${wasm} was not written` };
  return { note: `wasm ${statSync(wasm).size.toLocaleString('en-US')} bytes` };
}
