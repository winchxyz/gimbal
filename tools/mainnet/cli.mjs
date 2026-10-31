// Shared plumbing of the mainnet scripts: flag parsing, reading names from the environment or the repo's .env
// (values are returned, never printed), and the run wrapper that turns a refusal into an exit code.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './near.mjs';

/** A bad command line: printed with the usage, exit code 2. */
export class UsageError extends Error {}

/**
 * Parses `argv` against `spec` ({ '--name': 'value' | 'switch' }): unknown flags, a flag given twice and a value
 * flag without its value are usage errors. Returns { positional, values }.
 */
export function parseFlags(argv, spec) {
  const values = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const kind = spec[a];
    if (kind === undefined) throw new UsageError(`unknown option ${a}`);
    if (a in values) throw new UsageError(`${a} is given twice`);
    if (kind === 'switch') {
      values[a] = true;
    } else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      values[a] = v;
      i++;
    }
  }
  return { positional, values };
}

/** KEY=value lines as Node's --env-file reads them: comments, `export`, quotes, inline ` # comments`. */
export function parseDotEnv(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const q = /^(["'`])(.*?)\1/.exec(v);
    if (q) v = q[2];
    else v = v.replace(/(^|\s)#.*$/, '').trim();
    out.set(m[1], v);
  }
  return out;
}

export const DOT_ENV = join(ROOT, '.env');

/**
 * Each name's value and where it came from: the environment wins over .env (as with node --env-file), an empty
 * value counts as not set. Returns Map name -> { value: string | null, from: 'the environment' | '.env' | null }.
 */
export function envValues(names, { file = DOT_ENV, env = process.env } = {}) {
  const dot = existsSync(file) ? parseDotEnv(readFileSync(file, 'utf8')) : new Map();
  const out = new Map();
  for (const name of names) {
    const fromEnv = env[name]?.trim();
    const fromFile = dot.get(name)?.trim();
    if (fromEnv) out.set(name, { value: fromEnv, from: 'the environment' });
    else if (fromFile) out.set(name, { value: fromFile, from: '.env' });
    else out.set(name, { value: null, from: null });
  }
  return out;
}

/**
 * The printout of public settings that new() fixes for good (the broker id, the referral codes): each value in
 * plain text, quoted so stray spaces show, with where it came from; and a warning for every value the shell
 * environment set over .env (the shell wins, so what .env says is not what is used). Never for secrets.
 */
export function envReport(env) {
  const lines = [];
  for (const [name, e] of env) lines.push(`env       ${name} ${e.value === null ? 'empty (null)' : `${JSON.stringify(e.value)} (from ${e.from})`}`);
  for (const [name, e] of env) {
    if (e.from === 'the environment') lines.push(`warning   ${name} comes from the shell environment, not .env: the shell wins over .env, so check this value, not the file's`);
  }
  return lines;
}

/** Whether the module at `url` is the script node was started with. */
export function isMain(url) {
  return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === url;
}

/** Runs a script body: a usage error exits 2 with the usage, a refusal exits 1 with its reason. */
export async function run(body, usage) {
  try {
    await body();
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${usage}`);
      process.exit(2);
    }
    console.error(`\nrefused: ${e.message}`);
    process.exit(1);
  }
}
