// The public live view (docs/deploy-live-view.md): the real mainnet desk, read-only, for anyone with a browser.
//   node engine/src/cli/live-host.ts [--host 0.0.0.0]
// It listens on $PORT (default 8080) on every address and serves, on that one origin, the built dashboard
// (web/dist-live, the hosted-live build, built first if missing; a folder of its own, so the replay's web/dist is never
// overwritten) and a read-only proxy to the live engine's view (engine/src/view/): GIMBAL_LIVE_URL is the view's
// address, GIMBAL_VIEW_TOKEN its bearer token. The token is added here, server-side, and never reaches a browser, a
// response or a log line. Without either variable the page still serves and says the live engine is not configured.
//
// Read-only for visitors: only the reads the dashboard needs (GET /state, /strategy, /journal?before=,
// /windows/history?id=, /events) are forwarded; every write is refused here (live-host-lib.ts liveRoute) and never
// reaches the engine. The one exception is opt in, GIMBAL_OWNER_WRITES=1: a request carrying the owner token in its
// own header (POST /rotate, POST /close, PUT /strategy, and GET /owner to check an unlock) is forwarded, from this
// site's own page only; the engine checks that token (GIMBAL_OWNER_TOKEN there) and its routes check the rest. The
// host never stores, caches or logs the owner token. The engine is protected from the crowd: one upstream event stream fanned out to every visitor
// (capped), GET answers cached (a stale one served when a fresh one cannot be had), one request per key at a time, the
// reads asked for by id held to ids the engine listed and to a budget per visitor and in all. GET /healthz answers
// 200 with the upstream's state.
//
// The replay is not this: `npm run demo` (locally) or engine/src/cli/replay-host.ts (docs/deploy-replay.md).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LiveUpstream, createLiveHostServer, isLiveBuild, liveConfigFromEnv, ownerWritesFromEnv } from './live-host-lib.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webDir = join(root, 'web', 'dist-live');

const { values } = parseArgs({ options: { host: { type: 'string', default: '0.0.0.0' } } });
const publicPort = Number(process.env.PORT ?? '8080');
if (!Number.isInteger(publicPort) || publicPort < 0 || publicPort > 65535) fail(`bad PORT ${process.env.PORT}`);

ensureWebBuild();

const cfg = liveConfigFromEnv((name) => process.env[name]);
let upstream: LiveUpstream | null = null;
if ('config' in cfg) {
  upstream = new LiveUpstream({ ...cfg.config, log });
  log(`live engine: ${new URL(cfg.config.base).host} (the read-only view; token from GIMBAL_VIEW_TOKEN, added server-side)`);
} else {
  log(`live engine not configured: ${cfg.off}; serving the page with that state`);
}
// GIMBAL_OWNER_WRITES=1: the owner's requests (with the owner header) are forwarded; the engine checks the owner token.
const ownerWrites = ownerWritesFromEnv((name) => process.env[name]);
log(ownerWrites
  ? 'owner writes: on (GET /owner, POST /rotate, POST /close, PUT /strategy with the owner header, from this site\'s own page; the engine checks the owner token)'
  : 'owner writes: off (GIMBAL_OWNER_WRITES is not 1): every write is refused');
const server = createLiveHostServer({ webDir, upstream, offReason: 'off' in cfg ? cfg.off : null, ownerWrites, log });
server.listen(publicPort, values.host, () => {
  const a = server.address();
  log(`live view on http://${values.host}:${a !== null && typeof a === 'object' ? a.port : publicPort}: the dashboard and the live engine's reads; ${ownerWrites ? 'visitors\' writes refused, the owner\'s forwarded' : 'every write refused'}`);
});
upstream?.start();

let stopping = false;
function shutdown(code: number): void {
  if (stopping) return;
  stopping = true;
  log('stopping');
  upstream?.stop();
  server.dropStreams();
  server.close();
  server.closeAllConnections();
  setTimeout(() => process.exit(code), 500).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => shutdown(0));

/** web/dist-live: built here as the hosted-live build when missing or another build. */
function ensureWebBuild(): void {
  const index = join(webDir, 'index.html');
  if (existsSync(index) && isLiveBuild(readFileSync(index, 'utf8'))) return;
  log(`web/dist-live ${existsSync(index) ? 'is not the hosted-live build (no hosted-live marker)' : 'is missing'}: building the hosted-live dashboard once (production build)`);
  const require = createRequire(join(root, 'package.json'));
  if (!existsSync(join(root, 'shared', 'dist', 'index.js'))) {
    const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    if (spawnSync(process.execPath, [tsc, '-p', join(root, 'shared', 'tsconfig.json')], { stdio: 'inherit' }).status !== 0) fail('building shared/ failed');
  }
  const vite = [join(root, 'web', 'node_modules', 'vite', 'bin', 'vite.js'), join(root, 'node_modules', 'vite', 'bin', 'vite.js')].find((f) => existsSync(f));
  if (vite === undefined) fail('vite is not installed; run `npm ci`');
  // The hosted-live build: the page opens on this origin, read-only, and leaves out every control that would act
  // (web/src/remote/readonly.ts). Only this host sets the flag. The token is not in the build's environment.
  const env: Record<string, string | undefined> = { ...process.env, VITE_HOSTED_LIVE: '1' };
  delete env.GIMBAL_VIEW_TOKEN;
  delete env.GIMBAL_LIVE_URL;
  if (spawnSync(process.execPath, [vite, 'build', '--outDir', 'dist-live', '--emptyOutDir'], { cwd: join(root, 'web'), stdio: 'inherit', env }).status !== 0) fail('building web/ failed');
}

function log(line: string): void {
  console.log(`[live ${new Date().toISOString()}] ${line}`);
}

function fail(msg: string): never {
  console.error(`live-host: ${msg}`);
  process.exit(2);
}
