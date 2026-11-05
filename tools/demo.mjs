#!/usr/bin/env node
// `npm run demo`: the engine in replay mode plus the dashboard, with no keys and no chain.
//
// It builds `shared/` when its dist/ is missing, starts `serve` (GIMBAL_MODE=replay, the final mainnet policy, replay
// time x10) and the Vite dev server, waits until both answer, sets the demo's engine rules, and prints the URL.
// Ctrl+C stops both.
//
// The engine plays the newest recording in engine/fixtures/replay/ (about an hour of real mainnet venue answers)
// through the real scanner, strategy loop and risk engine. Nothing is signed or sent: replay has no contract client,
// and every GIMBAL_* / NEAR_* / venue / key variable of the calling shell is dropped, so a mainnet environment cannot
// leak into the demo. The strategy loop runs (GIMBAL_TRADE=1) on a simulated replay desk (40 USD deposited, 10 USD on
// Hyperliquid and on Phoenix, fills at the recorded best bid / ask): a short script plays the owner's demo entry and
// close, so the recorded hour shows the whole loop (window, checks, both legs, hourly funding, exit, realized PnL).
// The engine's state lives in a fresh temp folder, removed on exit, so every run starts the same and the
// user's own state/ is never touched. The rules are set to legs of 12 USD with auto on, the size the final policy
// (max 20 USD an order) lets through; the engine's default of 1000 USD would be refused E_SIZE everywhere.
// Plain node and the repo's own node_modules only; no shell, so it runs the same on Windows and Linux.
//
//   npm run demo [-- --speed 10] [--web-port 5190] [--engine-port 8790]
// Neither port may answer before the start. --web-port moves the dashboard (Vite's --port; strictPort stays from
// web/vite.config.ts) and the engine's allowed browser Origin with it (serve --web-port), so the two always match.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const START_TIMEOUT_MS = 90_000;
// The demo's engine rules (PUT /strategy): the engine's defaults, with legs the final policy accepts and auto on.
const DEMO_STRATEGY = {
  auto: true,
  minNetAprPct: 5,
  legUsd: 12,
  maxLeverage: 3,
  stopDrawdownPct: 10,
  rotate: { minGainPts: 3, forHours: 4 },
  risk: { watchDistancePct: 15, rescueDistancePct: 8 },
};

const { values } = parseArgs({
  options: {
    speed: { type: 'string', default: '10' },
    'engine-port': { type: 'string', default: '8790' },
    'web-port': { type: 'string', default: '5190' },
  },
});
const speed = values.speed;
const enginePort = Number(values['engine-port']);
const WEB_PORT = Number(values['web-port']);

// Variables that would point serve at a chain, a venue account or a key. Replay needs none of them.
const DROP = /^(GIMBAL_|NEAR_|OPERATOR_|OWNER_|DESK_ID$|ORDERLY_|HL_|PHOENIX_|SOLANA_|ARBITRUM_|RELAYER_|ONECLICK_|ENGINE_PORT$|VITE_)/;
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROP.test(k)));

const children = [];
let stopping = false;
let stateDir = null;

/** Thrown by fail() so the start stops where it failed: nothing is spawned or sent after it. */
class Halt extends Error {}

// Says why, starts the cleanup (stop) and ends the start's flow. Event handlers call abort(), which does not throw.
function fail(msg) {
  abort(msg);
  throw new Halt(msg);
}

function abort(msg) {
  console.error(`demo: ${msg}`);
  stop(1);
}

// How a child ended: its signal, else its exit code; Windows reports a killed process as 4294967295, the unsigned -1.
function endText(code, signal) {
  if (signal !== null && signal !== undefined) return signal;
  if (code === null || code === undefined) return 'no exit code';
  return code > 0x7fffffff ? `code ${code | 0} (0x${(code >>> 0).toString(16).toUpperCase()})` : `code ${code}`;
}

const STOP_WAIT_MS = 3000;

// Kills both children, waits (up to 3 s) for them to exit so the engine lets go of its state files, removes the temp
// state folder and exits. A second call while stopping does nothing.
function stop(code) {
  if (stopping) return;
  stopping = true;
  const alive = children.filter((c) => c.exitCode === null && c.signalCode === null);
  for (const c of alive) c.kill();
  const done = () => {
    if (stateDir !== null) {
      try { rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
    process.exit(code);
  };
  if (alive.length === 0) done();
  const exited = alive.map((c) => new Promise((r) => c.once('exit', r)));
  Promise.race([Promise.all(exited), new Promise((r) => setTimeout(r, STOP_WAIT_MS))]).then(done);
}

// Ctrl+C, a kill, a closed terminal (SIGHUP) and Ctrl+Break on Windows (SIGBREAK) all clean up the same way.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => stop(0));

// A package's folder as seen from `from` (a workspace may have its own copy, else the hoisted one). Not through
// require.resolve of a bin path: packages like typescript do not export their bin files.
function pkgDir(name, from) {
  try {
    return dirname(createRequire(join(from, 'package.json')).resolve(`${name}/package.json`));
  } catch {
    for (const dir of [join(from, 'node_modules', name), join(root, 'node_modules', name)]) {
      if (existsSync(join(dir, 'package.json'))) return dir;
    }
    fail(`${name} is not installed; run \`npm install\``);
    return '';
  }
}

// A server may listen on IPv4 only, on IPv6 `::1` only (Vite on Windows does), or on whatever `localhost` resolves
// to, so each is tried. Returns the first host that accepts a connection, else null.
const LOCAL_HOSTS = ['127.0.0.1', '::1', 'localhost'];

function acceptsOn(port, host) {
  return new Promise((resolve) => {
    const s = connect({ port, host });
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function portInUse(port) {
  for (const host of LOCAL_HOSTS) {
    if (await acceptsOn(port, host)) return host;
  }
  return null;
}

async function answers(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitFor(name, url) {
  const until = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < until) {
    if (stopping) throw new Halt('stopping');
    if (await answers(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`${name} did not answer on ${url} within ${START_TIMEOUT_MS / 1000} s`);
}

function run(name, args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const prefix = (chunk) => chunk.toString().split(/\r?\n/).filter((l) => l !== '').map((l) => `[${name}] ${l}`).join('\n');
  child.stdout.on('data', (d) => console.log(prefix(d)));
  child.stderr.on('data', (d) => console.error(prefix(d)));
  child.on('exit', (code, signal) => {
    if (!stopping) abort(`${name} exited (${endText(code, signal)})`);
  });
  return child;
}

// The start, step by step. A fail() anywhere ends it there (Halt): stop() cleans up, and nothing after it runs.
async function main() {
  if (!(Number(speed) > 0)) fail('--speed must be > 0');
  for (const [flag, port] of [['--engine-port', enginePort], ['--web-port', WEB_PORT]]) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`${flag} must be a port number`);
  }
  if (enginePort === WEB_PORT) fail('--engine-port and --web-port must differ');
  if (!existsSync(join(root, 'node_modules'))) fail('run `npm install` first');

  for (const [name, port] of [['engine', enginePort], ['web', WEB_PORT]]) {
    const host = await portInUse(port);
    if (host !== null) {
      const hint = `; or move the ${name === 'engine' ? 'engine' : 'dashboard'} with \`npm run demo -- --${name}-port <n>\``;
      fail(`port ${port} is already in use (a server answers on ${host.includes(':') ? `[${host}]` : host}:${port}); stop whatever runs there, the ${name} would clash with it${hint}`);
    }
  }

  if (!existsSync(join(root, 'shared', 'dist', 'index.js'))) {
    console.log('demo: building shared/ (first run)');
    const tsc = join(pkgDir('typescript', root), 'bin', 'tsc');
    const r = spawnSync(process.execPath, [tsc, '-p', join(root, 'shared', 'tsconfig.json')], { stdio: 'inherit' });
    if (r.status !== 0) fail('building shared/ failed');
  }

  const policy = join(root, 'tools', 'mainnet-final-policy.json');
  const vite = join(pkgDir('vite', join(root, 'web')), 'bin', 'vite.js');
  stateDir = mkdtempSync(join(tmpdir(), 'gimbal-demo-'));
  const engineArgs = ['src/cli/serve.ts', '--speed', speed, '--port', String(enginePort), '--web-port', String(WEB_PORT), '--policy', policy, '--state-dir', stateDir];
  run('engine', engineArgs, join(root, 'engine'), { ...baseEnv, GIMBAL_MODE: 'replay', GIMBAL_TRADE: '1' });
  run('web', [vite, '--port', String(WEB_PORT), '--clearScreen', 'false'], join(root, 'web'), { ...baseEnv, ENGINE_PORT: String(enginePort) });

  await waitFor('engine', `http://127.0.0.1:${enginePort}/state`);
  // The engine's replay script tries no entry until these rules are in force (serve: the owner set them).
  const put = await fetch(`http://127.0.0.1:${enginePort}/strategy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(DEMO_STRATEGY),
  }).catch((err) => ({ ok: false, status: 0, text: async () => String(err) }));
  if (stopping) throw new Halt('stopping');
  const answer = await put.text();
  if (!put.ok) fail(`PUT /strategy failed (${put.status}): ${answer.slice(0, 300)}`);
  let applied = null;
  try { applied = JSON.parse(answer); } catch {}
  if (applied?.legUsd !== DEMO_STRATEGY.legUsd || applied?.maxLeverage !== DEMO_STRATEGY.maxLeverage) {
    fail(`PUT /strategy answered rules other than the demo's: ${answer.slice(0, 300)}`);
  }
  console.log(`demo: engine rules set: legs ${DEMO_STRATEGY.legUsd} USD at up to ${DEMO_STRATEGY.maxLeverage}x, enter above ${DEMO_STRATEGY.minNetAprPct} % net APR, auto on`);
  await waitFor('web', `http://localhost:${WEB_PORT}/`);
  console.log('');
  console.log(`demo: ready. Open http://localhost:${WEB_PORT}  (replay x${speed}: nothing is signed or sent; Ctrl+C stops both)`);
  console.log('');
}

main().catch((err) => {
  if (err instanceof Halt) return;
  abort(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
