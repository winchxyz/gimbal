// Runs the engine server: the scanner and the HTTP/SSE side (src/server.ts) on ENGINE_PORT (default 8790).
//   GIMBAL_MODE=replay  npm run serve -w engine [-- --replay <recording.jsonl.gz>] [--speed 10]
//   GIMBAL_MODE=mainnet npm run serve -w engine [-- --record fixtures/replay/<name>.jsonl.gz --minutes 65]
//                       (mainnet also reads the 23 watch-only venues, src/venues/watch; testnet does not)
//   GIMBAL_MODE=testnet npm run serve -w engine
// Options (and the environment variables they override):
//   --port <n>          ENGINE_PORT, default 8790
//   --host <addr>       GIMBAL_HOST: the address to listen on, default 127.0.0.1 (this machine only)
//   --replay <file>     GIMBAL_REPLAY_FILE: a recording made with --record; default the newest scan-*.jsonl.gz
//                       in fixtures/replay/
//   --speed <x>         GIMBAL_REPLAY_SPEED: replay time runs x times faster than real time, default 1
//   --policy <file>     GIMBAL_POLICY_FILE: the desk's ContractPolicy as JSON (get_desk's policy), checked at start;
//                       default none (every desk window is refused E_NO_DESK); ignored when the contract is set
//   --record <file>     live modes only: write every venue answer the scanner gets, for replay (funding and books
//                       at most every 30 s per market, so an hour stays a few MB)
//   --minutes <n>       with --record: stop after n minutes and close the file
//   --state-dir <dir>   GIMBAL_STATE_DIR: where the confirmed engine rules (PUT /strategy) are kept across restarts,
//                       one file per mode and desk; default engine/state/ (gitignored)
// NEAR_AI_API_KEY turns on POST /policy/draft (src/nearai/); without it the route answers 503, drafting unavailable.
// The contract (testnet and mainnet, src/cli/serve-contract.ts): with GIMBAL_CONTRACT_ID and DESK_ID set (and
// OWNER_ACCOUNT_ID or OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY, optional NEAR_NETWORK / NEAR_RPC_URL), the policy
// is get_desk's, the oracle is the contract's stored prices, and a `health` event carries NEAR's state. Views
// only: serve signs nothing. Without it the live modes read no oracle prices, so every priced desk leg is refused
// E_ORACLE_STALE, as the contract would refuse it, and the venue reads are public: no keys. Replay stands in the
// contract's Mock prices: the recording's Hyperliquid oracle prices, dated by the replay clock the scanner runs on.

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ContractPolicy, HealthMap, Mode } from '@gimbal/shared';
import type { NearHealth } from '../contract/budget.ts';
import { ReplayOracle } from '../contract/replay-oracle.ts';
import { NearAiClient } from '../nearai/client.ts';
import { PolicyDrafter, deskMarkets } from '../nearai/draft-route.ts';
import { StrategyStore, strategyFile } from '../strategy-store.ts';
import { liveReaders, replayReaders } from '../readers.ts';
import type { Readers } from '../readers.ts';
import { DEFAULT_STRATEGY, ORDERLY_BROKERS, scannerConfigFor } from '../scanner/config.ts';
import { Scanner } from '../scanner/scanner.ts';
import type { ScanResult } from '../scanner/scanner.ts';
import { DEFAULT_ENGINE_HOST, DEFAULT_ENGINE_PORT, EngineServer } from '../server.ts';
import type { RecordLine } from '../venues/recorder.ts';
import { JsonlGzWriter, RecordingVenue, errorMessage } from '../venues/recorder.ts';
import { ScaledClock, readRecording } from '../venues/replay.ts';
import { watchReaders } from '../venues/watch/index.ts';
import type { Clock } from '../venues/venue.ts';
import type { ContractSide } from './serve-contract.ts';
import { connectContract, contractEnv, healthChanged, healthMap, marginVenues } from './serve-contract.ts';
import { ThinningSink, loadPolicyFile, replayStart, scanLine } from './serve-replay.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    replay: { type: 'string' },
    speed: { type: 'string' },
    policy: { type: 'string' },
    record: { type: 'string' },
    minutes: { type: 'string' },
    'state-dir': { type: 'string' },
  },
});

// A variable left empty (as .env.example has most of them) means "not set".
function envVar(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v;
}
const mode = (envVar('GIMBAL_MODE') ?? 'replay') as Mode;
if (!['replay', 'testnet', 'mainnet'].includes(mode)) fail(`GIMBAL_MODE must be replay, testnet or mainnet, got ${mode}`);
const port = Number(values.port ?? envVar('ENGINE_PORT') ?? DEFAULT_ENGINE_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`bad port ${values.port ?? envVar('ENGINE_PORT')}`);
const host = values.host ?? envVar('GIMBAL_HOST') ?? DEFAULT_ENGINE_HOST;
if (host.trim() === '') fail('--host must not be empty');
const policyFile = values.policy ?? envVar('GIMBAL_POLICY_FILE');
let policy: ContractPolicy | null = null;
if (policyFile !== undefined && policyFile !== '') {
  try {
    policy = loadPolicyFile(policyFile);
  } catch (err) {
    fail(errorMessage(err));
  }
}
let contract: ContractSide | null = null;
let nearHealth: NearHealth = 'ok';
let deskId: string | null = null;
try {
  const cfg = contractEnv(envVar, mode);
  if (cfg !== null) {
    deskId = cfg.deskId;
    contract = await connectContract(cfg, {
      onHealth: (status, detail) => {
        nearHealth = status;
        log(`near ${status}: ${detail}`);
        publishHealth();
      },
      onError: (message) => noteOnce(message),
    });
    if (policy !== null) log(`${policyFile}: ignored, the policy is get_desk(${cfg.deskId})'s`);
    policy = contract.policy;
    log(`contract ${cfg.contractId} (${cfg.network}), desk ${cfg.deskId}: policy read, ${contract.prices.size} stored prices`);
  }
} catch (err) {
  fail(`contract: ${errorMessage(err)}`);
}
const recordPath = values.record;
if (recordPath !== undefined && mode === 'replay') fail('--record needs GIMBAL_MODE=mainnet or testnet');
if (recordPath !== undefined && !recordPath.endsWith('.jsonl.gz')) fail('--record must end in .jsonl.gz');
const minutes = values.minutes === undefined ? null : Number(values.minutes);
if (minutes !== null && !(minutes > 0)) fail('--minutes must be a positive number');

let clock: Clock;
let readers: Readers;
let writer: JsonlGzWriter | null = null;
let replayEnd: number | null = null;
let replayOracle: ReplayOracle | null = null;

if (mode === 'replay') {
  const file = values.replay ?? envVar('GIMBAL_REPLAY_FILE') ?? newestRecording();
  const speed = Number(values.speed ?? envVar('GIMBAL_REPLAY_SPEED') ?? '1');
  if (!(speed > 0)) fail('--speed must be > 0');
  const lines: RecordLine[] = readRecording(file);
  if (lines.length === 0) fail(`${file}: empty recording`);
  const start = replayStart(lines);
  replayEnd = lines.reduce((m, l) => Math.max(m, l.t), 0);
  const scaled = new ScaledClock(start, speed);
  const end = replayEnd;
  // The recording ends: time stops there, so the windows keep their last real numbers and timestamps.
  clock = { now: () => Math.min(scaled.now(), end) };
  readers = replayReaders(lines, clock);
  // The contract's Mock prices in replay: the recording's Hyperliquid oracle prices, dated by the replay clock.
  replayOracle = new ReplayOracle(clock);
  const tapped = replayOracle;
  readers = { ...readers, venues: readers.venues.map((v) => tapped.tap(v)) };
  log(`replay ${file}: ${lines.length} answers from ${readers.venues.map((v) => v.id).join(', ')}, ${new Date(start).toISOString()} to ${new Date(end).toISOString()}, x${speed}`);
} else {
  clock = { now: () => Date.now() };
  // The watch-only venues are mainnet feeds. On testnet the desk venues' marks are testnet prices, so the mark
  // check would drop them against the 23 mainnet feeds: testnet scans the desk venues alone.
  const watch = mode === 'mainnet' ? watchReaders({ clock }) : [];
  readers = liveReaders(mode, clock, watch);
  if (recordPath !== undefined) {
    // Only the desk venues are recorded; the watch-only feeds are not part of a replay yet.
    writer = new JsonlGzWriter(resolve(recordPath));
    const sink = new ThinningSink(writer, { funding: 30_000, book: 30_000 });
    readers = { ...readers, venues: readers.venues.map((v) => new RecordingVenue(v, sink, clock)) };
    log(`recording to ${recordPath}${minutes === null ? '' : ` for ${minutes} min`}`);
  }
}

let server: EngineServer | null = null;
// The costs of the network the desk trades on: testnet prices Orderly under woofi_dex, mainnet and replay (recorded
// mainnet answers) under gimbal_dex.
const scannerConfig = { ...scannerConfigFor(mode), policy };
const fees = scannerConfig.costs.fees;
const fill = (v: keyof typeof fees) => `${v} ${fees[v].takerBps + fees[v].extraBps} bps`;
log(`scanner costs (${mode}): taker fill ${fill('hyperliquid')}, ${fill('phoenix')}, ${fill('orderly')} `
  + `(Orderly broker ${ORDERLY_BROKERS[mode === 'testnet' ? 'testnet' : 'mainnet'].brokerId})`);
const scanner = new Scanner(readers.venues, readers.watch, {
  config: scannerConfig,
  clock,
  oracle: contract?.prices ?? replayOracle,
  marginHeldAt: () => marginVenues(server?.state().desk ?? null),
  strategy: () => server?.strategy ?? DEFAULT_STRATEGY,
  onNote: (note) => noteOnce(note),
});

let scans = 0;
let lastScan: ScanResult['scan'] | null = null;
let health: HealthMap | null = null;
/** With the contract set: a `health` event whenever NEAR's state or a desk venue's changes. */
function publishHealth(): void {
  if (contract === null || server === null) return;
  const next = healthMap(lastScan, nearHealth);
  if (!healthChanged(health, next)) return;
  health = next;
  server.publish({ type: 'health', data: next });
}
// The confirmed engine rules survive a restart; a file that no longer passes the checks falls back to the defaults.
const stateDir = values['state-dir'] ?? envVar('GIMBAL_STATE_DIR') ?? fileURLToPath(new URL('../../state/', import.meta.url));
let strategyStore: StrategyStore;
try {
  strategyStore = new StrategyStore(strategyFile(resolve(stateDir), mode, deskId));
} catch (err) {
  fail(errorMessage(err));
}
const saved = strategyStore.load(policy);
if (saved.problem !== null) log(`engine rules not loaded, starting from the defaults (auto off): ${saved.problem}`);
else if (saved.strategy !== null) log(`engine rules from ${strategyStore.path}`);
const drafter = new PolicyDrafter({ client: new NearAiClient({ apiKey: envVar('NEAR_AI_API_KEY') }), markets: deskMarkets(readers.venues) });
log(drafter.configured ? `policy drafts: NEAR AI ${drafter.model}` : 'policy drafts: off (NEAR_AI_API_KEY is not set), POST /policy/draft answers 503');

server = new EngineServer({
  mode,
  scanner,
  strategy: saved.strategy ?? DEFAULT_STRATEGY,
  saveStrategy: (s) => strategyStore.save(s),
  drafter,
  policy,
  intervalMs: scannerConfig.intervalMs,
  log,
  onScan: (r) => {
    scans++;
    if (scans === 1 || scans % 12 === 0) log(scanLine(scans, r));
    if (writer !== null && scans % 12 === 0) void writer.flush();
    lastScan = r.scan;
    publishHealth();
  },
});

const listening = await server.start(port, host);
const shown = host.includes(':') ? `[${host}]` : host;
log(`engine ${mode} on http://${shown}:${listening}: GET /events /state /windows/history?id= /strategy /journal, PUT /strategy`);

let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  await server!.stop();
  contract?.prices.stop();
  readers.close();
  if (writer !== null) {
    await writer.close();
    log(`recorded ${writer.lines} answers, ${(statSync(writer.path).size / 1024).toFixed(1)} KiB -> ${writer.path}`);
  }
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
if (minutes !== null) setTimeout(() => void shutdown(`${minutes} min done`), minutes * 60_000).unref();

const seenNotes = new Map<string, number>();
function noteOnce(note: string): void {
  // The same failure every 5 s would flood the log: one line per kind of note a minute.
  const kind = note.replace(/\d+/g, '#');
  const at = Date.now();
  if ((seenNotes.get(kind) ?? 0) > at - 60_000) return;
  seenNotes.set(kind, at);
  log(note);
}

function newestRecording(): string {
  const dir = fileURLToPath(new URL('../../fixtures/replay/', import.meta.url));
  const files = readdirSync(dir).filter((f) => /^scan-.*\.jsonl\.gz$/.test(f)).sort();
  if (files.length === 0) fail(`no scan-*.jsonl.gz recording in ${dir}; pass --replay <file>`);
  return join(dir, files.at(-1)!);
}

function log(line: string): void {
  console.log(`[engine ${new Date().toISOString()}] ${line}`);
}

function fail(msg: string): never {
  console.error(`serve: ${msg}`);
  process.exit(2);
}
