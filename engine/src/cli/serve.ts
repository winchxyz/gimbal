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
//   --record <file>     live modes only: write every venue answer the scanner gets, for replay (desk funding and
//                       books at most every 30 s per market, each watch-only venue's sweep every 10 min, so an hour
//                       stays a few MB)
//   --minutes <n>       with --record: stop after n minutes and close the file
//   --state-dir <dir>   GIMBAL_STATE_DIR: where the confirmed engine rules (PUT /strategy), the pair trader's state
//                       and a live rescuer's holds and cap meter are kept across restarts, one file per mode and desk;
//                       default engine/state/ (gitignored) for the rules, and for the pair trader and the live rescuer
//                       the per-user state directory outside any checkout (trade/trader-state.ts and rescue/lock.ts
//                       userStateDir), so another worktree or a clean cannot lose them
//   --once              start, adopt the pair, print what is live, read the desk once, and exit (no HTTP server);
//                       always alert only: GIMBAL_TRADE and GIMBAL_RESCUE are ignored (it exits after one read, and
//                       must not leave a close or a transfer half done)
// NEAR_AI_API_KEY turns on POST /policy/draft (src/nearai/); without it the route answers 503, drafting unavailable.
// GIMBAL_SETUP=1 turns on POST /setup (src/setup/): venue setup signs through the operator key (OPERATOR_PRIVATE_KEY).
// The contract (testnet and mainnet, src/cli/serve-contract.ts): with GIMBAL_CONTRACT_ID and DESK_ID set (and
// OWNER_ACCOUNT_ID or OPERATOR_ACCOUNT_ID, OPERATOR_PRIVATE_KEY, optional NEAR_NETWORK / NEAR_RPC_URL), the policy
// is get_desk's, the oracle is the contract's stored prices, and a `health` event carries NEAR's state. Views
// only: serve signs nothing. Without it the live modes read no oracle prices, so every priced desk leg is refused
// E_ORACLE_STALE, as the contract would refuse it, and the venue reads are public: no keys. Replay stands in the
// contract's Mock prices: the recording's Hyperliquid oracle prices, dated by the replay clock the scanner runs on.
// The pair (mainnet, src/cli/serve-pair.ts): the carry pair pair-mainnet opened is adopted from the venues at start and
// held by a PairTrader whose orders are all reduce-only: panic_close closes both legs, a rescue's reduce makes both
// smaller, a confirmed ADL pauses the pair and unwinds both (risk/adl.ts). It trades only with GIMBAL_TRADE=1 (the
// operator key, the per-desk lock, never in a linked worktree, never with --once); otherwise it only alerts.
// GIMBAL_TRADER_FRESH=<contract>/<desk> starts its state anew from the venues' positions when the state file is
// missing or unusable (a missing file is not a fresh start without it; a usable file is always used). On SIGINT or
// SIGTERM serve waits up to SHUTDOWN_WAIT_MS, in all, for the risk engine, a close in flight (panic_close, a
// rescue's reduce, an ADL unwind) and a running rescue (it signs nothing new, and one already signing goes on until its
// payment is sent and saved as held) before it releases the locks and exits.
// The strategy loop (src/strategy/loop.ts, serve-loop.ts): after each funding payment and each scan it runs decide()
// and, with GIMBAL_TRADE=1 and auto on (PUT /strategy; off by default and kept as the owner set it), carries the act
// out through the pair (mainnet: pair-mainnet's open and close, pair-ops.ts); otherwise it publishes `off`. POST
// /rotate {windowId} goes the same way and needs auto on ("auto is off" otherwise: nothing new opens until the owner
// sets auto=true); POST /close works with auto on or off. Both only with GIMBAL_TRADE=1 and only while the engine
// listens on loopback. Nothing is sent while a rescue (its fund_venue step too), an ADL unwind or panic_close runs:
// checked at each decision and again right before every close and open. Its counters and the pair it entered are
// kept next to the trader state, loop-<mode>-<contract>-<desk>.json.
// The monitor (src/risk/monitor.ts): every 30 min the legs, their distance to liquidation and the net; an alert to the
// journal and the console when a leg is under 25 % from liquidation. `npm run monitor -w engine -- --mainnet` is the
// one-shot form.
// The risk engine (src/risk/) reads the desk every 5 s: with the contract, the desk's Hyperliquid and Phoenix accounts;
// in replay, a scripted desk priced by the recording. It publishes `desk`, `health`, `journal` and `rescue`, and answers
// POST /stress (testnet and replay; refused on mainnet). `health` is published in every mode: the venues the last
// scan or account read missed, 1Click (probed every minute in the live modes) and NEAR.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ContractPolicy, DeskState, Mode, StreamEvent } from '@gimbal/shared';
import { ReplayOracle } from '../contract/replay-oracle.ts';
import { NearAiClient } from '../nearai/client.ts';
import { PolicyDrafter, deskMarkets } from '../nearai/draft-route.ts';
import { StrategyStore, strategyFile } from '../strategy-store.ts';
import { setupFromEnv } from '../setup/serve-setup.ts';
import { liveReaders, replayReaders } from '../readers.ts';
import type { Readers } from '../readers.ts';
import { DEFAULT_STRATEGY, ORDERLY_BROKERS, scannerConfigFor } from '../scanner/config.ts';
import { Scanner } from '../scanner/scanner.ts';
import { DEFAULT_ENGINE_HOST, DEFAULT_ENGINE_PORT, EngineServer } from '../server.ts';
import type { RecordLine } from '../venues/recorder.ts';
import { JsonlGzWriter, RecordingVenue, RecordingWatch, errorMessage } from '../venues/recorder.ts';
import { ScaledClock, readRecording } from '../venues/replay.ts';
import { watchReaders } from '../venues/watch/index.ts';
import type { AccountState, Clock } from '../venues/venue.ts';
import { RiskEngine } from '../risk/engine.ts';
import type { DeskSource } from '../risk/engine.ts';
import { AccountsDeskSource, ReplayDesk } from '../risk/sources.ts';
import type { ClosingWatch } from '../rescue/closing.ts';
import { serveRescue } from '../rescue/serve-rescue.ts';
import { VenueHealth, probeIntents } from '../risk/venue-health.ts';
import { ALERT_DISTANCE_PCT, LiquidationAlert, MONITOR_EVERY_MS, monitorLines } from '../risk/monitor.ts';
import type { ServePair } from './serve-pair.ts';
import { liveLines, servePair } from './serve-pair.ts';
import type { ContractSide } from './serve-contract.ts';
import { connectContract, contractEnv, marginVenues } from './serve-contract.ts';
import { serveLoop } from './serve-loop.ts';
import { ConfigError, retryStart } from './start-errors.ts';
import type { StrategyLoop } from '../strategy/loop.ts';
import { ThinningSink, WATCH_RECORD_GAPS, loadPolicyFile, replayStart, scanLine } from './serve-replay.ts';

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
    once: { type: 'boolean' },
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
// Before connectContract: its price cache can report a failed first read through noteOnce.
const seenNotes = new Map<string, number>();
let contract: ContractSide | null = null;
let deskId: string | null = null;
const venueHealth = new VenueHealth();
let risk: RiskEngine | null = null;
try {
  const cfg = contractEnv(envVar, mode);
  if (cfg !== null) {
    deskId = cfg.deskId;
    // Review S1: a NEAR RPC that does not answer is tried again (backoff up to 60 s), never an exit; the desk names
    // every account serve watches, so nothing else starts before it. A configuration error still stops serve.
    contract = await retryStart(`contract ${cfg.contractId}`, () => connectContract(cfg, {
      onHealth: (status, detail) => {
        venueHealth.near(status);
        log(`near ${status}: ${detail}`);
        publishHealth();
      },
      onError: (message) => noteOnce(message),
    }), { log });
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
  log(`replay ${file}: ${lines.length} answers from ${readers.venues.map((v) => v.id).join(', ')}`
    + `${readers.watch.length > 0 ? ` and ${readers.watch.length} watch-only venues` : ''}, ${new Date(start).toISOString()} to ${new Date(end).toISOString()}, x${speed}`);
} else {
  clock = { now: () => Date.now() };
  // The watch-only venues are mainnet feeds. On testnet the desk venues' marks are testnet prices, so the mark
  // check would drop them against the 23 mainnet feeds: testnet scans the desk venues alone.
  const watch = mode === 'mainnet' ? watchReaders({ clock }) : [];
  readers = liveReaders(mode, clock, watch);
  if (recordPath !== undefined) {
    writer = new JsonlGzWriter(resolve(recordPath));
    const sink = new ThinningSink(writer, { funding: 30_000, book: 30_000 });
    const watchSink = new ThinningSink(writer, WATCH_RECORD_GAPS);
    readers = {
      ...readers,
      venues: readers.venues.map((v) => new RecordingVenue(v, sink, clock)),
      watch: readers.watch.map((w) => new RecordingWatch(w, watchSink, clock)),
    };
    log(`recording to ${recordPath}${minutes === null ? '' : ` for ${minutes} min`}`
      + (readers.watch.length > 0 ? `, with ${readers.watch.length} watch-only venues` : ''));
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
  held: () => loop?.heldWindow() ?? null,
});
let loop: StrategyLoop | null = null;

let scans = 0;
/** What the start could not do (a read that failed, not a configuration error): journaled once the server runs. */
const startNotes: string[] = [];
/** A `health` event whenever a desk venue's, 1Click's or NEAR's state changes (with the risk engine: and a journal line). */
function publishHealth(): void {
  if (server === null) return;
  if (risk !== null) return risk.healthChanged();
  const next = venueHealth.changed();
  if (next !== null) server.publish({ type: 'health', data: next });
}
// The confirmed engine rules survive a restart; a file that no longer passes the checks falls back to the defaults.
const stateDirSet = values['state-dir'] ?? envVar('GIMBAL_STATE_DIR');
const stateDir = stateDirSet ?? fileURLToPath(new URL('../../state/', import.meta.url));
let strategyStore: StrategyStore;
try {
  strategyStore = new StrategyStore(strategyFile(resolve(stateDir), mode, deskId));
} catch (err) {
  fail(errorMessage(err));
}
const saved = strategyStore.load(policy);
if (saved.problem !== null) log(`engine rules not loaded, starting from the defaults (auto off): ${saved.problem}`);
else if (saved.strategy !== null) log(`engine rules from ${strategyStore.path}`);
// One NEAR AI client: policy drafts, and the strategy loop's veto before an enter or a rotate.
const nearAi = new NearAiClient({ apiKey: envVar('NEAR_AI_API_KEY') });
const drafter = new PolicyDrafter({ client: nearAi, markets: deskMarkets(readers.venues) });
log(drafter.configured ? `policy drafts: NEAR AI ${drafter.model}` : 'policy drafts: off (NEAR_AI_API_KEY is not set), POST /policy/draft answers 503');
const setup = await setupFromEnv(mode, envVar, log).catch((err: unknown) => {
  if (err instanceof ConfigError) fail(`setup: ${errorMessage(err)}`);
  // Review S1: NEAR not answering at start turns POST /setup off for this run instead of stopping serve.
  const note = `venue setup: off for this run (POST /setup answers 503): its start read failed (${errorMessage(err)}); restart serve to try again`;
  log(note);
  startNotes.push(note);
  return null;
});

// The 25 % liquidation alert rides on every `desk` event the risk engine publishes (risk/monitor.ts).
const liquidation = new LiquidationAlert();
let lastDesk: DeskState | null = null;
let monitorSeq = 0;
const publish = (event: StreamEvent) => {
  server?.publish(event);
  if (event.type !== 'desk') return;
  lastDesk = event.data;
  const alert = liquidation.observe(event.data, clock.now());
  for (const line of alert.console) log(line);
  for (const j of alert.journal) server?.publish({ type: 'journal', data: { id: `monitor-${j.t.toString(36)}-${++monitorSeq}`, ...j } });
};
let deskSource: DeskSource | null = null;
let replayDesk: ReplayDesk | null = null;
// panic_close: every get_desk read tells it whether the desk is closing (rescue/closing.ts).
let closingWatch: ClosingWatch | null = null;
// The rescuer's shutdown (serve-rescue.ts stop) and the id of the rescue running, for the shutdown's wait.
let rescueStop: (() => Promise<void>) | null = null;
let rescueRunning: (() => string | null) | null = null;
let rescueLive = false;
// The desk's venue accounts, for the strategy loop's free margin.
const loopAccounts: { venue: string; read: () => Promise<AccountState> }[] = [];
if (mode === 'replay') {
  deskSource = replayDesk = new ReplayDesk({
    venues: readers.venues, clock, strategy: () => server?.strategy ?? DEFAULT_STRATEGY,
    onOpen: (summary) => {
      log(summary);
      publish({ type: 'journal', data: { id: `replay-desk-${clock.now().toString(36)}`, t: clock.now(), kind: 'enter', summary, numbers: {}, tx: [] } });
    },
  });
} else if (contract !== null) {
  const side = contract;
  const reader = (id: string) => readers.venues.find((v) => v.id === id);
  const accounts = [
    { reader: reader('hyperliquid'), address: side.desk.evm_address },
    { reader: reader('phoenix'), address: side.desk.solana.authority },
  ].filter((a): a is { reader: NonNullable<typeof a.reader>; address: string } => a.reader !== undefined && a.address !== '');
  for (const a of accounts) loopAccounts.push({ venue: a.reader.id, read: () => a.reader.account(a.address) });
  // get_desk says only whether the desk is paused, not who paused it or when (that is in its `paused` event): `at` is
  // when this engine first saw it paused, `by` is unknown.
  let pausedSince: number | null = null;
  deskSource = new AccountsDeskSource({
    deskId: deskId!, owner: side.desk.owner, contract: side.client.contractId, accounts, log,
    desk: async () => {
      const view = await side.client.getDesk(deskId!);
      if (view === null) throw new Error(`get_desk(${deskId}) answered null`);
      pausedSince = view.paused ? (pausedSince ?? Date.now()) : null;
      closingWatch?.observe(view.closing === true);
      return { reserveUsd: Number(view.ledger.idle_usdc) / 1e6, paused: pausedSince === null ? null : { by: 'unknown', at: pausedSince } };
    },
  });
  log(`risk: reading the desk's ${accounts.map((a) => a.reader.id).join(' and ')} accounts every 5 s (Orderly legs need its private stream, which serve does not open)`);
}
let pair: ServePair | null = null;
if (contract !== null && deskId !== null) {
  const side = contract;
  const id = deskId;
  pair = await servePair({
    mode, env: envVar, side, deskId: id, clock, log, publish, linkedWorktree: linkedWorktree(), once: values.once === true,
    ...(stateDirSet === undefined ? {} : { stateDir: resolve(stateDirSet) }),
    // Review S1: a start read that fails degrades the pair (alert only, legs unknown, retried); health says which venue.
    health: (venue, status, detail) => {
      venueHealth.pairStart(venue, status, detail);
      publishHealth();
    },
  }).catch((err: unknown) => fail(`pair: ${errorMessage(err)}`));
}
// --once is alert only: nothing it starts may be cut off by its exit (a rescue's transfer included).
const rescueEnv = values.once === true ? (name: string) => (name === 'GIMBAL_RESCUE' ? undefined : envVar(name)) : envVar;
if (deskSource !== null) {
  // E9: the rescue executor takes the risk engine's triggers (recorded 1Click answers off mainnet, live only with
  // GIMBAL_RESCUE=1 on mainnet); its reduce and panic_close trade through the pair when it trades.
  const side = contract;
  const servedPair = pair;
  const rescueInput = (env: (name: string) => string | undefined): Parameters<typeof serveRescue>[0] => ({
    mode, env, clock, publish, log, risk: () => risk, policy, reducer: () => pair?.reducer() ?? null,
    ...(stateDirSet === undefined ? {} : { stateDir: resolve(stateDirSet) }),
    closing: {
      notTrading: () => servedPair?.notTrading() ?? null,
      ...(servedPair?.cancelResting === undefined ? {} : { cancelResting: servedPair.cancelResting }),
    },
    ...(replayDesk === null ? {} : { replayDesk }),
    ...(side === null ? {} : {
      getDesk: async () => {
        const view = await side.client.getDesk(deskId!);
        if (view === null) throw new Error(`get_desk(${deskId}) answered null`);
        return view;
      },
    }),
  });
  // Review S1: a live rescuer whose start read fails (NEAR RPC, Phoenix, Solana) does not stop serve: the rescue runs
  // detect only for this run, and the owner hears of it. A configuration error still stops serve.
  const rescue = await serveRescue(rescueInput(rescueEnv)).catch(async (err: unknown) => {
    if (err instanceof ConfigError) fail(`rescue: ${errorMessage(err)}`);
    const note = `rescue: the live rescuer did not start (${errorMessage(err)}): detect only for this run, triggers are journaled and the owner acts; restart serve to try the live rescuer again`;
    log(note);
    startNotes.push(note);
    return serveRescue(rescueInput((name) => (name === 'GIMBAL_RESCUE' ? undefined : rescueEnv(name))));
  }).catch((err: unknown) => fail(`rescue: ${errorMessage(err)}`));
  closingWatch = rescue.closing;
  rescueStop = rescue.stop;
  rescueRunning = rescue.running;
  rescueLive = mode === 'mainnet' && rescue.rescuer !== undefined;
  log(rescue.summary);
  for (const line of rescue.routes) log(line);
  risk = new RiskEngine({
    mode, source: deskSource, strategy: () => server?.strategy ?? DEFAULT_STRATEGY, health: venueHealth, publish, clock, log,
    ...(rescue.rescuer === undefined ? {} : { rescuer: rescue.rescuer, rescuerRunning: rescue.running }),
    ...(pair?.adl === undefined ? {} : { adl: pair.adl }),
  });
  if (pair !== null) {
    const lines = liveLines({
      pair, rescueSummary: rescue.summary, rescueLive: mode === 'mainnet' && rescue.rescuer !== undefined, mode,
      alertPct: ALERT_DISTANCE_PCT, monitorMin: MONITOR_EVERY_MS / 60_000,
    });
    for (const line of lines) log(line);
  }
}
if (values.once === true) {
  // One read of the desk (the alert included), the monitor lines, and out: nothing listens, nothing is left running.
  // Nothing trades either (servePair and serveRescue were started alert only), so the exit cuts nothing off.
  await risk?.tick();
  await risk?.adlRunning;
  await closingWatch?.current;
  for (const line of lastDesk === null ? ['monitor   no desk read'] : monitorLines(lastDesk)) log(line);
  await risk?.stop();
  pair?.stop();
  contract?.prices.stop();
  readers.close();
  log('--once: done');
  process.exit(0);
}

/** A protection runs (a rescue, its fund_venue step included; an ADL unwind; panic_close): no order of the loop goes out. */
function protectionRunning(): string | null {
  const rescuing = rescueRunning?.() ?? null;
  if (rescuing !== null) return `rescue ${rescuing} runs`;
  if (risk?.adlRunning != null) return 'an ADL unwind runs';
  if (closingWatch?.current != null) return 'panic_close runs';
  return null;
}

loop = serveLoop({
  mode, env: envVar, once: false, contractId: contract?.client.contractId ?? null, deskId, pair, lastDesk: () => lastDesk,
  accounts: loopAccounts, rescueLive, windows: () => server?.state().windows ?? null,
  carry: (id) => scanner.carry(id), venues: readers.venues, veto: nearAi,
  strategy: () => server?.strategy ?? saved.strategy ?? DEFAULT_STRATEGY, policy: () => policy, publish, clock, log,
  ...(stateDirSet === undefined ? {} : { stateDir: resolve(stateDirSet) }),
  busy: () => protectionRunning() ?? (pair?.pair?.closing === true ? 'a close of the pair runs' : null),
  orderGate: protectionRunning,
});
log(loop.startLine());
const strategyLoop = loop;

server = new EngineServer({
  mode,
  scanner,
  strategyLoop,
  onStrategy: () => strategyLoop.onScan(),
  strategy: saved.strategy ?? DEFAULT_STRATEGY,
  saveStrategy: (s) => strategyStore.save(s),
  drafter,
  ...(setup === null ? {} : { setup }),
  ...(risk === null ? {} : { stress: risk }),
  policy,
  intervalMs: scannerConfig.intervalMs,
  log,
  onScan: (r) => {
    scans++;
    if (scans === 1 || scans % 12 === 0) log(scanLine(scans, r));
    if (writer !== null && scans % 12 === 0) void writer.flush();
    venueHealth.scan(r.scan);
    publishHealth();
    strategyLoop.onScan();
  },
});

const listening = await server.start(port, host);
risk?.start();
publishHealth();
for (const [i, summary] of startNotes.entries()) {
  const t = clock.now();
  server.publish({ type: 'journal', data: { id: `start-${t.toString(36)}-${i}`, t, kind: 'error', summary, numbers: { stage: 'start' }, tx: [] } });
}
let intentsTimer: ReturnType<typeof setInterval> | undefined;
if (mode !== 'replay') {
  // 1Click has no testnet: its mainnet API is probed in both live modes (a public GET, no key, nothing sent).
  const probe = async () => {
    const r = await probeIntents();
    venueHealth.intents(r.status, r.detail);
    publishHealth();
  };
  void probe();
  intentsTimer = setInterval(() => void probe(), 60_000);
  intentsTimer.unref();
}
// The monitor: the legs, their distance to liquidation and the net, every 30 min (read-only).
const monitorTimer = setInterval(() => {
  for (const line of lastDesk === null ? ['monitor   no desk read yet'] : monitorLines(lastDesk)) log(line);
}, MONITOR_EVERY_MS);
monitorTimer.unref();
const shown = host.includes(':') ? `[${host}]` : host;
log(`engine ${mode} on http://${shown}:${listening}: GET /events /state /windows/history?id= /strategy /journal, PUT /strategy, POST /rotate /close`);

let stopping = false;
/** How long a shutdown waits for a close in flight: one MPC signature can take 120 s, and a close is one per leg plus a retry. */
const SHUTDOWN_WAIT_MS = 180_000;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  clearInterval(intentsTimer);
  clearInterval(monitorTimer);
  // The loop starts nothing new; an open or close it runs is waited for with the rest, under the same deadline.
  strategyLoop.stop();
  // No new trigger or desk read after this; a close already running (panic_close, a rescue's reduce, an ADL unwind)
  // is waited for, bounded, before the lock is released: pair-mainnet must not start next to it. One deadline covers
  // it all: risk.stop() (it waits for an ADL attempt that is running) and the closes.
  const deadline = new Promise<false>((r) => setTimeout(() => r(false), SHUTDOWN_WAIT_MS).unref());
  if (pair?.pair?.closing === true || closingWatch?.current != null || risk?.adlRunning != null) {
    log(`stopping: waiting up to ${SHUTDOWN_WAIT_MS / 1000} s for the close in flight before the trader lock is released`);
  }
  // A running rescue signs nothing new from here; one that is signing or sending goes on until its payment is saved
  // (the hold keeps it for the next start), then stops waiting for 1Click. Asked before risk.stop(), which waits too.
  const rescueId = rescueRunning?.() ?? null;
  const rescueDone = rescueStop?.() ?? Promise.resolve();
  if (rescueId !== null) log(`stopping: waiting up to ${SHUTDOWN_WAIT_MS / 1000} s for rescue ${rescueId} to save its payment before the rescue lock is released`);
  const drained = await Promise.race([
    (async () => {
      try {
        await risk?.stop();
      } catch (err) {
        log(`stopping: the risk engine stopped with an error (${err instanceof Error ? err.message : String(err)})`);
      }
      await Promise.allSettled([closingWatch?.current ?? Promise.resolve(), strategyLoop.idle(SHUTDOWN_WAIT_MS), pair?.drain(SHUTDOWN_WAIT_MS) ?? Promise.resolve(true), rescueDone]);
      return pair?.pair?.closing !== true && rescueRunning?.() == null;
    })(),
    deadline,
  ]);
  const stillRescuing = rescueRunning?.() ?? null;
  if (!drained && stillRescuing !== null) log(`stopping: rescue ${stillRescuing} is still running after ${SHUTDOWN_WAIT_MS / 1000} s; exiting anyway: a payment it signed was saved as held before signing, and the next start reads it at 1Click and on chain`);
  if (!drained && (stillRescuing === null || pair?.pair?.closing === true)) log(`stopping: a close is still running after ${SHUTDOWN_WAIT_MS / 1000} s; exiting anyway: its orders are saved as in flight (the next start only alerts on ADL until a close result); check both legs by hand`);
  pair?.stop();
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

function noteOnce(note: string): void {
  // The same failure every 5 s would flood the log: one line per kind of note a minute.
  const kind = note.replace(/\d+/g, '#');
  const at = Date.now();
  if ((seenNotes.get(kind) ?? 0) > at - 60_000) return;
  seenNotes.set(kind, at);
  log(note);
}

/** The repo root's .git is a file in a linked worktree (GIMBAL_TRADE=1 refuses there, as pair-mainnet --send does). */
function linkedWorktree(): boolean {
  const git = fileURLToPath(new URL('../../../.git', import.meta.url));
  return existsSync(git) && statSync(git).isFile();
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
