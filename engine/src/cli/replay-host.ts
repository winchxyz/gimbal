// The hosted replay (docs/deploy-replay.md): `npm run demo` for anyone with a browser, on one public port.
//   node engine/src/cli/replay-host.ts [--speed 10] [--pause 45] [--engine-ports 18790,18791] [--replay <file>]
// It listens on $PORT (default 8080) on every address and serves, on that one origin, the built dashboard (web/dist,
// built first if missing) and the replay engine's read routes. The engine is `serve` in replay mode, as `npm run demo`
// starts it (the final mainnet policy, the demo's rules from tools/demo-strategy.json, a fresh temp state folder), on
// loopback only, with every outbound connection refused in its process (no-egress.ts) and none of this host's
// variables but the system's own (replay-host-lib.ts childEnv): no key, no token, nothing live, nothing signed.
// Once the recorded hour has played and the flat desk has shown its realized P&L for --pause seconds, a fresh engine
// starts on the other internal port, takes over, and the old one stops: the page's stream reconnects to the new run.
// Read-only for visitors: every write route is refused here (replay-host-lib.ts hostedRoute) and never reaches the
// engine; the replay script drives the loop inside the engine. POST /stress passes, one at a time, one a minute, and
// only while a pair is held (StressGate). GET /healthz answers 200 once a run serves.

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readRecording } from '../venues/replay.ts';
import { replayStart } from './serve-replay.ts';
import type { ReplayEngine } from './replay-host-lib.ts';
import { ReplayCycler, StressGate, childEnv, createHostServer } from './replay-host-lib.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const engineDir = join(root, 'engine');
const webDir = join(root, 'web', 'dist');
const STOP_WAIT_MS = 10_000;

const { values } = parseArgs({
  options: {
    speed: { type: 'string', default: '10' },
    pause: { type: 'string', default: '45' },
    'engine-ports': { type: 'string', default: '18790,18791' },
    replay: { type: 'string' },
    host: { type: 'string', default: '0.0.0.0' },
  },
});
const speed = Number(values.speed);
if (!(speed > 0)) fail('--speed must be > 0');
const pauseS = Number(values.pause);
if (!(pauseS >= 0)) fail('--pause must be a number of seconds');
const ports = values['engine-ports'].split(',').map(Number);
if (ports.length !== 2 || ports.some((p) => !Number.isInteger(p) || p <= 0 || p > 65535) || ports[0] === ports[1]) fail('--engine-ports must be two different ports, a,b');
const publicPort = Number(process.env.PORT ?? '8080');
if (!Number.isInteger(publicPort) || publicPort < 0 || publicPort > 65535) fail(`bad PORT ${process.env.PORT}`);
if (ports.includes(publicPort)) fail(`PORT ${publicPort} is one of --engine-ports`);

const file = values.replay ?? newestRecording();
let cycleMs: number;
{
  // Read once here, as serve reads it: where the replay starts and ends sets how long one run plays.
  const lines = readRecording(file);
  if (lines.length === 0) fail(`${file}: empty recording`);
  const start = replayStart(lines);
  const end = lines.reduce((m, l) => Math.max(m, l.t), 0);
  cycleMs = Math.ceil((end - start) / speed);
  log(`recording ${relative(root, file).replace(/\\/g, '/')}: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}, x${speed}: `
    + `one run plays ${Math.round(cycleMs / 1000)} s, then ${pauseS} s on the finished desk, then the next run`);
}
const strategy: unknown = JSON.parse(readFileSync(join(root, 'tools', 'demo-strategy.json'), 'utf8'));
const policy = join(root, 'tools', 'mainnet-final-policy.json');
const kept = Object.keys(childEnv(process.env)).length - 2;
log(`engine environment: ${kept} system variables kept, the host's other ${Object.keys(process.env).length - kept} not passed on; GIMBAL_MODE=replay GIMBAL_TRADE=1 set`);

ensureWebBuild();

const gate = new StressGate();
let servingSince = 0;
const cycler = new ReplayCycler({
  ports: [ports[0]!, ports[1]!],
  start: startEngine,
  cycleMs,
  pauseMs: pauseS * 1000,
  log,
  onSwitch: () => {
    servingSince = Date.now();
    gate.reset();
    server.dropStreams();
  },
  fatal: (reason) => {
    log(`fatal: ${reason}`);
    void shutdown(1);
  },
});
const server = createHostServer({
  webDir,
  target: () => cycler.target,
  gate,
  log,
  status: () => ({ run: cycler.serving, servingS: servingSince === 0 ? 0 : Math.round((Date.now() - servingSince) / 1000), runS: Math.round((cycleMs + pauseS * 1000) / 1000) }),
});
server.listen(publicPort, values.host, () => {
  const a = server.address();
  log(`hosted replay on http://${values.host}:${a !== null && typeof a === 'object' ? a.port : publicPort}: the dashboard and the engine's read routes; writes refused, POST /stress gated`);
});
void cycler.start();

let stopping = false;
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('stopping');
  server.dropStreams();
  server.close();
  await cycler.stop();
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => void shutdown(0));

/** One replay engine: serve in replay mode on 127.0.0.1:`port`, its own temp state folder, the demo's rules. */
function startEngine(port: number, run: number): ReplayEngine {
  const stateDir = mkdtempSync(join(tmpdir(), 'gimbal-hosted-'));
  const args = [
    '--import', pathToFileURL(join(engineDir, 'src', 'cli', 'no-egress-preload.ts')).href,
    join(engineDir, 'src', 'cli', 'serve.ts'),
    '--replay', file, '--speed', String(speed), '--port', String(port), '--host', '127.0.0.1',
    '--policy', policy, '--state-dir', stateDir,
  ];
  const child: ChildProcess = spawn(process.execPath, args, { cwd: engineDir, env: childEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (d: Buffer) => d.toString().split(/\r?\n/).filter((l) => l !== '').map((l) => `[run ${run}] ${l}`).join('\n');
  child.stdout?.on('data', (d: Buffer) => console.log(prefix(d)));
  child.stderr?.on('data', (d: Buffer) => console.error(prefix(d)));
  const exited = new Promise<string>((r) => {
    child.once('exit', (code, signal) => r(signal ?? `code ${code}`));
    child.once('error', (err) => r(`could not start: ${err.message}`));
  });
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const base = `http://127.0.0.1:${port}`;
  const ready = (async () => {
    for (;;) {
      if (gone) throw new Error('the engine exited');
      try {
        const r = await fetch(`${base}/state`, { signal: AbortSignal.timeout(2_000) });
        if (r.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    // The replay script tries no entry until the owner's rules are in force, as in `npm run demo`. Over loopback,
    // from this process: the public port refuses PUT /strategy.
    const put = await fetch(`${base}/strategy`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(strategy), signal: AbortSignal.timeout(5_000),
    });
    const text = await put.text();
    if (!put.ok) throw new Error(`PUT /strategy failed (${put.status}): ${text.slice(0, 300)}`);
    log(`run ${run}: engine rules set (tools/demo-strategy.json)`);
  })();
  ready.catch(() => {});
  return {
    port,
    ready,
    exited,
    stop: async () => {
      if (!gone) {
        child.kill('SIGTERM');
        const killer = setTimeout(() => child.kill('SIGKILL'), STOP_WAIT_MS);
        await exited;
        clearTimeout(killer);
      }
      try {
        rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {}
      log(`run ${run}: stopped`);
    },
  };
}

/** web/dist from the image's build; built here when missing (a host that ran the plain Dockerfile). */
function ensureWebBuild(): void {
  if (existsSync(join(webDir, 'index.html'))) return;
  log('web/dist is missing: building the dashboard once (production build)');
  const require = createRequire(join(root, 'package.json'));
  if (!existsSync(join(root, 'shared', 'dist', 'index.js'))) {
    const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    if (spawnSync(process.execPath, [tsc, '-p', join(root, 'shared', 'tsconfig.json')], { stdio: 'inherit' }).status !== 0) fail('building shared/ failed');
  }
  const vite = [join(root, 'web', 'node_modules', 'vite', 'bin', 'vite.js'), join(root, 'node_modules', 'vite', 'bin', 'vite.js')].find((f) => existsSync(f));
  if (vite === undefined) fail('vite is not installed; run `npm ci`');
  if (spawnSync(process.execPath, [vite, 'build'], { cwd: join(root, 'web'), stdio: 'inherit' }).status !== 0) fail('building web/ failed');
}

function newestRecording(): string {
  const dir = join(engineDir, 'fixtures', 'replay');
  const files = readdirSync(dir).filter((f) => /^scan-.*\.jsonl\.gz$/.test(f)).sort();
  if (files.length === 0) fail(`no scan-*.jsonl.gz recording in ${dir}; pass --replay <file>`);
  return join(dir, files.at(-1)!);
}

function log(line: string): void {
  console.log(`[host ${new Date().toISOString()}] ${line}`);
}

function fail(msg: string): never {
  console.error(`replay-host: ${msg}`);
  process.exit(2);
}
