// Runs the engine server: the scanner and the HTTP/SSE side (src/server.ts) on ENGINE_PORT (default 8790).
//   GIMBAL_MODE=replay  npm run serve -w engine [-- --replay <recording.jsonl.gz>] [--speed 10]
//   GIMBAL_MODE=mainnet npm run serve -w engine [-- --record fixtures/replay/<name>.jsonl.gz --minutes 65]
//   GIMBAL_MODE=testnet npm run serve -w engine
// Options (and the environment variables they override):
//   --port <n>          ENGINE_PORT, default 8790
//   --replay <file>     GIMBAL_REPLAY_FILE: a recording made with --record; default the newest scan-*.jsonl.gz
//                       in fixtures/replay/
//   --speed <x>         GIMBAL_REPLAY_SPEED: replay time runs x times faster than real time, default 1
//   --policy <file>     GIMBAL_POLICY_FILE: the desk's ContractPolicy as JSON (get_desk's policy); default none
//   --oracle <list>     GIMBAL_ORACLE_SYMBOLS: base symbols with an oracle price, comma-separated
//   --record <file>     live modes only: write every venue answer the scanner gets, for replay (funding and books
//                       at most every 30 s per market, so an hour stays a few MB)
//   --minutes <n>       with --record: stop after n minutes and close the file
// Public reads only: no keys.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ContractPolicy, Mode } from '@gimbal/shared';
import { liveReaders, replayReaders } from '../readers.ts';
import type { Readers } from '../readers.ts';
import { DEFAULT_ORACLE_SYMBOLS, DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from '../scanner/config.ts';
import { Scanner } from '../scanner/scanner.ts';
import { DEFAULT_ENGINE_PORT, EngineServer } from '../server.ts';
import type { RecordLine } from '../venues/recorder.ts';
import { JsonlGzWriter, RecordingVenue } from '../venues/recorder.ts';
import { ScaledClock, readRecording } from '../venues/replay.ts';
import type { Clock } from '../venues/venue.ts';
import { ThinningSink, replayStart } from './serve-replay.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    replay: { type: 'string' },
    speed: { type: 'string' },
    policy: { type: 'string' },
    oracle: { type: 'string' },
    record: { type: 'string' },
    minutes: { type: 'string' },
  },
});

const env = process.env;
const mode = (env.GIMBAL_MODE ?? 'replay') as Mode;
if (!['replay', 'testnet', 'mainnet'].includes(mode)) fail(`GIMBAL_MODE must be replay, testnet or mainnet, got ${mode}`);
const port = Number(values.port ?? env.ENGINE_PORT ?? DEFAULT_ENGINE_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`bad port ${values.port ?? env.ENGINE_PORT}`);
const policyFile = values.policy ?? env.GIMBAL_POLICY_FILE;
const policy = policyFile === undefined ? null : (JSON.parse(readFileSync(policyFile, 'utf8')) as ContractPolicy);
const oracleText = values.oracle ?? env.GIMBAL_ORACLE_SYMBOLS;
const oracleSymbols = oracleText === undefined ? DEFAULT_ORACLE_SYMBOLS : oracleText.split(',').map((s) => s.trim()).filter((s) => s !== '');
const recordPath = values.record;
if (recordPath !== undefined && mode === 'replay') fail('--record needs GIMBAL_MODE=mainnet or testnet');
if (recordPath !== undefined && !recordPath.endsWith('.jsonl.gz')) fail('--record must end in .jsonl.gz');
const minutes = values.minutes === undefined ? null : Number(values.minutes);
if (minutes !== null && !(minutes > 0)) fail('--minutes must be a positive number');

let clock: Clock;
let readers: Readers;
let writer: JsonlGzWriter | null = null;
let replayEnd: number | null = null;

if (mode === 'replay') {
  const file = values.replay ?? env.GIMBAL_REPLAY_FILE ?? newestRecording();
  const speed = Number(values.speed ?? env.GIMBAL_REPLAY_SPEED ?? '1');
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
  log(`replay ${file}: ${lines.length} answers from ${readers.venues.map((v) => v.id).join(', ')}, ${new Date(start).toISOString()} to ${new Date(end).toISOString()}, x${speed}`);
} else {
  clock = { now: () => Date.now() };
  readers = liveReaders(mode, clock);
  if (recordPath !== undefined) {
    writer = new JsonlGzWriter(resolve(recordPath));
    const sink = new ThinningSink(writer, { funding: 30_000, book: 30_000 });
    readers = { ...readers, venues: readers.venues.map((v) => new RecordingVenue(v, sink, clock)) };
    log(`recording to ${recordPath}${minutes === null ? '' : ` for ${minutes} min`}`);
  }
}

let server: EngineServer | null = null;
const scanner = new Scanner(readers.venues, readers.watch, {
  config: { ...DEFAULT_SCANNER_CONFIG, policy, oracleSymbols },
  clock,
  strategy: () => server?.strategy ?? DEFAULT_STRATEGY,
  onNote: (note) => noteOnce(note),
});

let scans = 0;
server = new EngineServer({
  mode,
  scanner,
  strategy: DEFAULT_STRATEGY,
  policy,
  intervalMs: DEFAULT_SCANNER_CONFIG.intervalMs,
  log,
  onScan: (r) => {
    scans++;
    if (scans === 1 || scans % 12 === 0) {
      const tradable = r.windows.filter((w) => w.tradable);
      const top = tradable[0];
      log(`scan ${scans}: ${r.windows.length} windows (${tradable.length} tradable), failed [${r.scan.failed.join(', ')}], ${r.notes.ms} ms`
        + `${top === undefined ? '' : `, best ${top.id} ${top.netAprPct.toFixed(2)} % net`}`
        + `${r.notes.unpriced.length > 0 ? `, ${r.notes.unpriced.length} unpriced` : ''}, ${r.notes.historyReads} history reads`);
    }
    if (writer !== null && scans % 12 === 0) void writer.flush();
  },
});

const listening = await server.start(port);
log(`engine ${mode} on http://localhost:${listening}: GET /events /state /windows/history?id= /strategy, PUT /strategy`);

let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  await server!.stop();
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
