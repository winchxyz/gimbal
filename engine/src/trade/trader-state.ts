// serve's pair trader on disk, so a restart forgets neither an order that may still run nor how many ADL unwind
// attempts the pair has left. One JSON file per mode, contract, desk and desk EVM address, in GIMBAL_STATE_DIR (by
// default the per-user state directory, outside any checkout, so another worktree or a `git clean` cannot lose it).
// A save writes a temporary file, fsyncs it and renames it over the old one, synchronously: the trader saves before
// every order (the order in flight) and again once the trader has recorded the order's result, and sends no order
// unless the save before it succeeded.
//
// What it keeps: the pair's symbol; the trader's intents, baselines, known positions, net and alert, and every order
// with no answer that may still run (its ids and window: PairTraderState); Hyperliquid post-only orders a maker order
// could not settle; the orders in flight (each order sent since the trader last recorded a result, one entry per
// order, so each leg has its own); the ADL state (attempts left, pause, an event in progress). Everything in it is
// public on chain or at the venues once signed: no key, no secret.
//
// A file that is missing, cannot be read, names another contract, desk or EVM address, or does not pass
// parseTraderState is never taken as "nothing in flight": serve's trader then does not trade (alert only) and says
// so. A first run needs GIMBAL_TRADER_FRESH=<contract>/<desk>, which adopts the venues' positions and writes a new
// state (trade/protected-pair.ts startPlan: any other value is ignored, and it is refused over a usable state that
// holds anything a restart must not forget).
//
// One trader per mode, contract and desk on this machine: it trades only with an exclusive lock file at a fixed
// per-user path, which pair-mainnet --send takes too, for its whole run. A lock file that holds no pid (its holder is
// between creating and writing it) counts as held. The lock names its process by pid, start time, a random id and the
// host's boot id: in a container node runs as pid 1 every time, so after a kill the next container finds a lock of
// "pid 1" on the volume. Its holder touches it every LOCK_HEARTBEAT_MS (the file's mtime is the heartbeat). A lock
// of a live other pid here is held. Any other lock (another boot id, a pid not running here, this very pid in another
// process) is stale only once its heartbeat is older than LOCK_STALE_MS: a container may have a boot id and a pid
// namespace of its own, so an overlapping container waits rather than taking over. A stale lock is taken over under a
// second exclusive file (`<lock>.takeover`, holding its maker's token and removed only by it), so two starters that
// read the same stale lock cannot both take it; the takeover is said in the TraderLock's `tookOver`.
//
// The conventions (and userStateDir, the lock) follow the rescuer's state of PR #63 (rescue/state.ts, rescue/lock.ts);
// TODO(dedupe): once both are merged, share userStateDir, the atomic save and the lock with those files.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Mode, TxRef, VenueId } from '@gimbal/shared';
import type { AdlEvent, AdlState } from '../risk/adl.ts';
import { ADL_ATTEMPTS } from '../risk/adl.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { LegRef, LegSide, PendingMakerOrder } from './legs.ts';
import type { PairTraderState } from './pair.ts';

export const TRADER_STATE_VERSION = 1;

const README = 'Gimbal pair trader state (serve): orders that may still run, the ADL unwind budget and pause. '
  + 'Never delete this file to clear something: a missing file stops serve from trading. To start over after '
  + 'reconciling both legs on the venues, stop the engine and start it once with GIMBAL_TRADER_FRESH=<contract>/<desk>.';

/** Whose state it is: the file is refused for any other contract, desk or desk EVM address. */
export interface TraderIdentity {
  contractId: string;
  deskId: string;
  /** The desk's EVM address, lowercase. */
  evm: string;
}

/**
 * An order sent since the trader last recorded a result: its outcome may be known only in memory. `op`: sent while a
 * protection's close ran (`close`: that close's result records it) or by one of the trader's watch checks (`watch`:
 * the check's report records it).
 */
export interface InFlightOrder {
  index: 0 | 1;
  venue: VenueId;
  side: LegSide;
  size: string;
  reduceOnly: boolean;
  reason: string;
  at: number;
  op: 'close' | 'watch';
}

export interface TraderFileState {
  version: typeof TRADER_STATE_VERSION;
  savedAt: number;
  /** The pair's base (null: no pair was adopted). */
  symbol: string | null;
  trader: PairTraderState | null;
  pendingMaker: PendingMakerOrder[];
  /** Orders whose outcome no saved result holds yet; empty: none. */
  inFlight: InFlightOrder[];
  adl: AdlState;
}

export interface LoadedTraderFile extends TraderFileState {
  identity: TraderIdentity;
}

export type LoadedTraderState =
  | { kind: 'none' }
  | { kind: 'loaded'; state: LoadedTraderFile }
  | { kind: 'unusable'; problem: string };

/**
 * The per-user state directory: %LOCALAPPDATA%/gimbal/state on Windows, else $XDG_STATE_HOME/gimbal or
 * ~/.local/state/gimbal (a copy of rescue/lock.ts userStateDir from PR #63).
 */
export function userStateDir(env: (name: string) => string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const local = env('LOCALAPPDATA');
    return join(local !== undefined && local !== '' ? local : join(homedir(), 'AppData', 'Local'), 'gimbal', 'state');
  }
  const xdg = env('XDG_STATE_HOME');
  return join(xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'state'), 'gimbal');
}

function checkIdentity(id: TraderIdentity): void {
  if (!/^[a-z0-9._-]{1,64}$/.test(id.contractId)) throw new Error(`contract id ${JSON.stringify(id.contractId)} is not [a-z0-9._-]{1,64}`);
  if (!/^[a-z0-9-]{1,32}$/.test(id.deskId)) throw new Error(`desk id ${JSON.stringify(id.deskId)} is not [a-z0-9-]{1,32}`);
  if (!/^0x[0-9a-f]{40}$/.test(id.evm)) throw new Error(`desk EVM address ${JSON.stringify(id.evm)} is not lowercase 0x + 40 hex`);
}

/** The file that keeps `mode`'s trader state for one contract, desk and desk EVM address. */
export function traderStateFile(dir: string, mode: Mode, id: TraderIdentity): string {
  checkIdentity(id);
  return join(dir, `trader-${mode}-${id.contractId}-${id.deskId}-${id.evm}.json`);
}

/** The lock of `mode`'s trading process for one contract and desk (always in the per-user directory). */
export function traderLockPath(env: (name: string) => string | undefined, mode: Mode, contractId: string, deskId: string): string {
  for (const [what, v] of [['contract id', contractId], ['desk id', deskId]] as const) {
    if (!/^[a-z0-9._-]{1,64}$/.test(v)) throw new Error(`${what} ${JSON.stringify(v)} is not [a-z0-9._-]{1,64}`);
  }
  return join(userStateDir(env), 'locks', `trader-${mode}-${contractId}-${deskId}.lock`);
}

// ---- serialising: bigints as decimal strings ----

function q(v: bigint | null): string | null {
  return v === null ? null : v.toString();
}

function refJson(r: LegRef): Record<string, unknown> {
  return {
    venue: r.venue, side: r.side, size: r.size, reduceOnly: r.reduceOnly, orderId: r.orderId, clientId: r.clientId, tx: r.tx, sentAt: r.sentAt,
    ...(r.settledAt === undefined ? {} : { settledAt: r.settledAt }), ...(r.expiresAfter === undefined ? {} : { expiresAfter: r.expiresAfter }),
  };
}

function eventJson(e: AdlEvent): Record<string, unknown> {
  return { at: e.at, reference: e.reference.map(String), seen: e.seen.map(String), attempts: e.attempts, nextAt: e.nextAt, alerted: e.alerted };
}

export function traderStateJson(s: TraderFileState): Record<string, unknown> {
  const t = s.trader;
  return {
    version: s.version, savedAt: s.savedAt, symbol: s.symbol,
    trader: t === null ? null : {
      intents: t.intents.map(q), baselines: t.baselines.map(q), known: t.known.map(q), net: t.net.toString(), unhedged: t.unhedged,
      unsettled: t.unsettled.map((u) => ({
        index: u.index, refs: u.refs.map(refJson), until: u.until, from: u.from.toString(),
        unwind: u.unwind === null ? null : { to: u.unwind.to.toString(), reason: u.unwind.reason, failed: u.unwind.failed },
      })),
    },
    pendingMaker: s.pendingMaker.map((p) => ({ cloid: p.cloid, oid: p.oid, side: p.side, size: p.size })),
    inFlight: s.inFlight.map((f) => ({ ...f })),
    adl: { attemptsLeft: s.adl.attemptsLeft, paused: s.adl.paused, event: s.adl.event === null ? null : eventJson(s.adl.event) },
  };
}

// ---- checks: a field that is not exactly what a save writes makes the whole file unusable ----

const VENUES: readonly VenueId[] = ['hyperliquid', 'phoenix', 'orderly'];
const SIDES: readonly LegSide[] = ['BUY', 'SELL'];
const CHAINS: readonly TxRef['chain'][] = ['near', 'hyperliquid', 'solana', 'arbitrum'];
const OPS: readonly InFlightOrder['op'][] = ['close', 'watch'];

function bad(path: string, what: string): never {
  throw new Error(`${path}: ${what}`);
}
function obj(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) bad(path, 'not an object');
  return v as Record<string, unknown>;
}
function list(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) bad(path, 'not a list');
  return v;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') bad(path, 'not a string');
  return v;
}
function time(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) bad(path, 'not a time in ms');
  return v;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') bad(path, 'not a boolean');
  return v;
}
/** A size as qtyString writes it: a positive decimal with at most 8 decimals and no trailing zero. */
function size(v: unknown, path: string): string {
  const s = str(v, path);
  if (!/^(0|[1-9]\d{0,29})(\.\d{0,7}[1-9])?$/.test(s) || s === '0') bad(path, 'not a size (a positive decimal quantity as a save writes it)');
  return s;
}
function int(v: unknown, path: string): bigint {
  const s = str(v, path);
  if (!/^-?(0|[1-9]\d{0,38})$/.test(s)) bad(path, 'not an integer quantity');
  return BigInt(s);
}
function nullable<T>(v: unknown, path: string, f: (v: unknown, path: string) => T): T | null {
  return v === null ? null : f(v, path);
}
function oneOf<T extends string>(v: unknown, path: string, options: readonly T[]): T {
  if (typeof v !== 'string' || !(options as readonly string[]).includes(v)) bad(path, `not one of ${options.join(', ')}`);
  return v as T;
}
function index(v: unknown, path: string): 0 | 1 {
  if (v !== 0 && v !== 1) bad(path, 'not 0 or 1');
  return v;
}
function two<T>(v: unknown, path: string, f: (v: unknown, path: string) => T): [T, T] {
  const a = list(v, path);
  if (a.length !== 2) bad(path, 'not two entries');
  return [f(a[0], `${path}[0]`), f(a[1], `${path}[1]`)];
}

function parseTx(v: unknown, path: string): TxRef {
  const t = obj(v, path);
  return { chain: oneOf(t.chain, `${path}.chain`, CHAINS), id: str(t.id, `${path}.id`), url: str(t.url, `${path}.url`) };
}

function parseRef(v: unknown, path: string): LegRef {
  const r = obj(v, path);
  const ref: LegRef = {
    venue: oneOf(r.venue, `${path}.venue`, VENUES), side: oneOf(r.side, `${path}.side`, SIDES), size: size(r.size, `${path}.size`),
    reduceOnly: bool(r.reduceOnly, `${path}.reduceOnly`), orderId: nullable(r.orderId, `${path}.orderId`, str), clientId: nullable(r.clientId, `${path}.clientId`, str),
    tx: list(r.tx, `${path}.tx`).map((t, i) => parseTx(t, `${path}.tx[${i}]`)), sentAt: time(r.sentAt, `${path}.sentAt`),
  };
  if (r.settledAt !== undefined) ref.settledAt = time(r.settledAt, `${path}.settledAt`);
  if (r.expiresAfter !== undefined) ref.expiresAfter = time(r.expiresAfter, `${path}.expiresAfter`);
  return ref;
}

function parseTrader(v: unknown, path: string): PairTraderState {
  const t = obj(v, path);
  const qty = (x: unknown, p: string) => nullable(x, p, int);
  return {
    intents: two(t.intents, `${path}.intents`, qty), baselines: two(t.baselines, `${path}.baselines`, qty), known: two(t.known, `${path}.known`, qty),
    net: int(t.net, `${path}.net`), unhedged: nullable(t.unhedged, `${path}.unhedged`, str),
    unsettled: list(t.unsettled, `${path}.unsettled`).map((x, i) => {
      const p = `${path}.unsettled[${i}]`;
      const u = obj(x, p);
      const refs = list(u.refs, `${p}.refs`).map((r, j) => parseRef(r, `${p}.refs[${j}]`));
      if (refs.length === 0) bad(`${p}.refs`, 'empty');
      return {
        index: index(u.index, `${p}.index`), refs, until: time(u.until, `${p}.until`), from: int(u.from, `${p}.from`),
        unwind: nullable(u.unwind, `${p}.unwind`, (w, wp) => {
          const o = obj(w, wp);
          return { to: int(o.to, `${wp}.to`), reason: str(o.reason, `${wp}.reason`), failed: bool(o.failed, `${wp}.failed`) };
        }),
      };
    }),
  };
}

function parseEvent(v: unknown, path: string): AdlEvent {
  const e = obj(v, path);
  const attempts = e.attempts;
  if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0) bad(`${path}.attempts`, 'not a count');
  return {
    at: time(e.at, `${path}.at`), reference: two(e.reference, `${path}.reference`, int), seen: two(e.seen, `${path}.seen`, int),
    attempts, nextAt: nullable(e.nextAt, `${path}.nextAt`, time), alerted: bool(e.alerted, `${path}.alerted`),
  };
}

/** The state as a save wrote it; throws, naming the field, on anything else. */
export function parseTraderState(v: unknown): LoadedTraderFile {
  const s = obj(v, 'state');
  if (s.version !== TRADER_STATE_VERSION) bad('state.version', `not ${TRADER_STATE_VERSION}`);
  const id = obj(s.identity, 'state.identity');
  const adl = obj(s.adl, 'state.adl');
  const left = adl.attemptsLeft;
  if (typeof left !== 'number' || !Number.isSafeInteger(left) || left < 0 || left > ADL_ATTEMPTS) bad('state.adl.attemptsLeft', `not 0..${ADL_ATTEMPTS}`);
  return {
    version: TRADER_STATE_VERSION,
    identity: { contractId: str(id.contractId, 'state.identity.contractId'), deskId: str(id.deskId, 'state.identity.deskId'), evm: str(id.evm, 'state.identity.evm') },
    savedAt: time(s.savedAt, 'state.savedAt'),
    symbol: nullable(s.symbol, 'state.symbol', str),
    trader: nullable(s.trader, 'state.trader', parseTrader),
    pendingMaker: list(s.pendingMaker, 'state.pendingMaker').map((x, i) => {
      const p = obj(x, `state.pendingMaker[${i}]`);
      const oid = p.oid;
      if (oid !== null && (typeof oid !== 'number' || !Number.isSafeInteger(oid) || oid < 0)) bad(`state.pendingMaker[${i}].oid`, 'not an oid or null');
      return { cloid: str(p.cloid, `state.pendingMaker[${i}].cloid`), oid: oid as number | null, side: oneOf(p.side, `state.pendingMaker[${i}].side`, SIDES), size: size(p.size, `state.pendingMaker[${i}].size`) };
    }),
    inFlight: list(s.inFlight, 'state.inFlight').map((x, i) => {
      const p = `state.inFlight[${i}]`;
      const f = obj(x, p);
      return {
        index: index(f.index, `${p}.index`), venue: oneOf(f.venue, `${p}.venue`, VENUES), side: oneOf(f.side, `${p}.side`, SIDES), size: size(f.size, `${p}.size`),
        reduceOnly: bool(f.reduceOnly, `${p}.reduceOnly`), reason: str(f.reason, `${p}.reason`), at: time(f.at, `${p}.at`), op: oneOf(f.op, `${p}.op`, OPS),
      };
    }),
    adl: { attemptsLeft: left, paused: nullable(adl.paused, 'state.adl.paused', str), event: nullable(adl.event, 'state.adl.event', parseEvent) },
  };
}

/** Blocks the thread for `ms`: a save is synchronous so that nothing is signed before it is on disk. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RETRIED_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface TraderStateStoreOptions {
  /** fs.renameSync in place: tests make it fail. */
  rename?: (from: string, to: string) => void;
  /** Tries of the rename on EPERM, EBUSY or EACCES (Windows: a reader or a scanner has the file open); default 5. */
  renameTries?: number;
}

export class TraderStateStore {
  readonly path: string;
  readonly identity: TraderIdentity;
  readonly #rename: (from: string, to: string) => void;
  readonly #tries: number;

  constructor(path: string, identity: TraderIdentity, options: TraderStateStoreOptions = {}) {
    this.path = path;
    this.identity = { ...identity, evm: identity.evm.toLowerCase() };
    checkIdentity(this.identity);
    this.#rename = options.rename ?? renameSync;
    this.#tries = options.renameTries ?? 5;
  }

  /** The saved state; `none` only when there is no file at all. A failed read is tried once more first. */
  load(): LoadedTraderState {
    this.#cleanTemps();
    let text: string | null = null;
    let problem = '';
    for (let attempt = 0; attempt < 2 && text === null; attempt++) {
      try {
        text = readFileSync(this.path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
        problem = errorMessage(err);
        if (attempt === 0) pause(200);
      }
    }
    if (text === null) return { kind: 'unusable', problem: `${this.path} could not be read: ${problem}` };
    let state: LoadedTraderFile;
    try {
      state = parseTraderState(JSON.parse(text));
    } catch (err) {
      return { kind: 'unusable', problem: `${this.path} is not a trader state this engine wrote: ${errorMessage(err)}` };
    }
    const want = this.identity;
    const got = state.identity;
    if (got.contractId !== want.contractId || got.deskId !== want.deskId || got.evm.toLowerCase() !== want.evm) {
      return { kind: 'unusable', problem: `${this.path} belongs to contract ${got.contractId}, desk ${got.deskId}, EVM ${got.evm}, not ${want.contractId}, ${want.deskId}, ${want.evm}` };
    }
    return { kind: 'loaded', state };
  }

  /** Writes `state` atomically: a temporary file, fsynced, then renamed over the old one. Throws when it could not. */
  save(state: TraderFileState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const body = `${JSON.stringify({ _readme: README, ...traderStateJson(state), identity: this.identity }, null, 2)}\n`;
    try {
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      for (let attempt = 1; ; attempt++) {
        try {
          this.#rename(tmp, this.path);
          syncDir(dirname(this.path));
          return;
        } catch (err) {
          if (attempt >= this.#tries || !RETRIED_RENAME.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
          pause(50 * attempt);
        }
      }
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // Never made, or gone already.
      }
      throw err;
    }
  }

  /**
   * Temporary files a crash left next to the state file: this process's own, and those of a pid that no longer runs.
   * Readers load too (monitor, an alert-only serve), and none may remove a live trader's file between its fsync and
   * its rename.
   */
  #cleanTemps(): void {
    let names: string[];
    try {
      names = readdirSync(dirname(this.path));
    } catch {
      return;
    }
    const base = basename(this.path);
    for (const n of names) {
      const m = n.startsWith(`${base}.`) ? /^\.(\d+)\.tmp$/.exec(n.slice(base.length)) : null;
      if (m === null) continue;
      const pid = Number(m[1]);
      if (pid !== process.pid && alive(pid)) continue;
      try {
        unlinkSync(join(dirname(this.path), n));
      } catch {
        // Left for the next start.
      }
    }
  }
}

// ---- one trader per desk ----

/** Whether `pid` runs (EPERM: it runs as another user). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The host's boot id (Linux), or null: a lock of another boot is stale, whatever its pid. */
function readBootId(): string | null {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return /^[0-9a-f-]{8,64}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** This process in a lock file: its pid, when it started (ms), a random id of its own and the host's boot id. */
export interface LockOwner {
  pid: number;
  startedMs: number | null;
  id: string | null;
  boot: string | null;
}

/** This process, as its locks name it. */
export const THIS_PROCESS: LockOwner = {
  pid: process.pid,
  startedMs: Math.floor(Date.now() - process.uptime() * 1000),
  id: randomUUID(),
  boot: readBootId(),
};

/** A lock file's text: `<pid>` then `started=<ms> id=<uuid> boot=<id|->` on a second line (an older lock is a bare pid). */
export function lockText(owner: LockOwner): string {
  return `${owner.pid}\nstarted=${owner.startedMs ?? '-'} id=${owner.id ?? '-'} boot=${owner.boot ?? '-'}\n`;
}

/** The owner a lock file names; null when it names none (empty, or cut short before its pid). */
export function parseLockText(text: string): LockOwner | null {
  const [first, second] = text.trim().split('\n');
  if (first === undefined || !/^\d+$/.test(first.trim())) return null;
  const field = (name: string): string | null => {
    const m = new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(second ?? '');
    return m === null || m[1] === '-' ? null : m[1]!;
  };
  const started = field('started');
  return {
    pid: Number(first.trim()),
    startedMs: started !== null && /^\d+$/.test(started) ? Number(started) : null,
    id: field('id'),
    boot: field('boot'),
  };
}

/** How often the holder touches its lock (the mtime is the heartbeat). */
export const LOCK_HEARTBEAT_MS = 30_000;
/** A lock of this pid (or of another pid namespace) is stale only once its heartbeat is older than this: 3 beats. */
export const LOCK_STALE_MS = 3 * LOCK_HEARTBEAT_MS;
/** A takeover guard (`<lock>.takeover`) older than this was left by a starter that died while taking over. */
const TAKEOVER_GUARD_STALE_MS = LOCK_HEARTBEAT_MS;

/**
 * Whose a lock is, from `me`'s side: `mine` (this very process), `held` (a live other process, or one that cannot be
 * told apart from one), or `stale` with why (its process is gone: safe to take over). `beatAgeMs` is how long ago its
 * holder last touched it (null: unknown, read as fresh).
 *
 * Nothing seen from this process proves another process gone while its lock still beats: a container may have a boot
 * id of its own, and a pid that reads as not running here may run in another pid namespace. So every rule that would
 * call a lock stale (another boot, a pid not running here, this very pid in another process) also needs its heartbeat
 * older than LOCK_STALE_MS. Only a live pid here is held without looking at the heartbeat.
 */
export function lockStatus(
  owner: LockOwner, me: LockOwner = THIS_PROCESS, isAlive: (pid: number) => boolean = alive, beatAgeMs: number | null = null,
): { kind: 'mine' } | { kind: 'held'; why: string } | { kind: 'stale'; why: string } {
  if (owner.id !== null && owner.id === me.id) return { kind: 'mine' };
  const beat = beatAgeMs === null ? 'no heartbeat time' : `its last heartbeat ${Math.round(beatAgeMs / 1000)} s ago`;
  const silent = beatAgeMs !== null && beatAgeMs > LOCK_STALE_MS;
  const wait = `${beat}: taken over only after ${LOCK_STALE_MS / 1000} s without one`;
  if (owner.boot !== null && me.boot !== null && owner.boot !== me.boot) {
    return silent
      ? { kind: 'stale', why: `it was taken under another boot id (${owner.boot}: an earlier boot of this host, or another container) and ${beat}, over ${LOCK_STALE_MS / 1000} s: its process is gone` }
      : { kind: 'held', why: `pid ${owner.pid} under another boot id (${owner.boot}: another container?), ${wait}` };
  }
  if (owner.pid === me.pid) {
    // This pid is this process, so the lock's holder is another process with the same pid: one that ran before this
    // one (a container restart: node is pid 1 each time) or one in another pid namespace on the same volume (an
    // overlapping container). Which, cannot be told from here: it is stale only once it stopped beating.
    return silent
      ? { kind: 'stale', why: `it names pid ${owner.pid}, this process's own pid (a restart, or another container), and ${beat}, over ${LOCK_STALE_MS / 1000} s: that process is gone` }
      : { kind: 'held', why: `pid ${owner.pid}, this process's own pid in another process (an overlapping container?), ${wait}` };
  }
  if (isAlive(owner.pid)) return { kind: 'held', why: `pid ${owner.pid}` };
  // Not running here: gone, or running in another pid namespace (another container on the same volume).
  return silent
    ? { kind: 'stale', why: `its process (pid ${owner.pid}) does not run here and ${beat}, over ${LOCK_STALE_MS / 1000} s: it is gone` }
    : { kind: 'held', why: `pid ${owner.pid}, not running here but maybe in another container, ${wait}` };
}

/** How long ago the lock at `path` was last touched by its holder, or null when that cannot be read. */
function beatAge(path: string, now: number): number | null {
  try {
    return Math.max(0, now - statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Who holds the lock at `path`: a running process's pid; 'unknown' for a file with no pid in it (its holder is between
 * creating and writing it, or crashed there: held until removed by hand) or one that cannot be read; null when there
 * is no lock or it is stale. This process's own lock names its pid.
 */
export function lockHolder(path: string): number | 'unknown' | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unknown';
  }
  const owner = parseLockText(text);
  if (owner === null) return 'unknown';
  return lockStatus(owner, THIS_PROCESS, alive, beatAge(path, Date.now())).kind === 'stale' ? null : owner.pid;
}

/** The directory entry of a renamed file reaches the disk too (POSIX; Windows cannot open a directory for that). */
function syncDir(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Some file systems refuse fsync on a directory; the rename itself is done.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface TraderLock {
  readonly path: string;
  /** A stale lock this one replaced: whose it was and why it was stale (serve journals it); null when none was there. */
  readonly tookOver: string | null;
  /**
   * Touches the lock now (the timer does every LOCK_HEARTBEAT_MS). false when nothing was touched: released, the lock
   * names another holder (the heartbeat stops for good), or it could not be read or touched now (a transient EIO or
   * EMFILE: the heartbeat goes on and tries again at the next beat).
   */
  beat(): boolean;
  /** Whether the heartbeat runs: until release(), or until the lock is read and names another holder. */
  beating(): boolean;
  release(): void;
}

export interface LockTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(t: unknown): void;
}

const lockTimers: LockTimers = {
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref();
    return t;
  },
  clearInterval: (t) => clearInterval(t as NodeJS.Timeout),
};

/** Heartbeats running in this process (tests: a stopped serve leaves none). */
let heartbeats = 0;
export function lockHeartbeats(): number {
  return heartbeats;
}

export interface AcquireOptions {
  /** false leaves removing it to the caller (tests). */
  onExit?: boolean;
  /** Tests: another process, its clock, its pid check and its timers. */
  me?: LockOwner;
  alive?: (pid: number) => boolean;
  now?: () => number;
  timers?: LockTimers;
  /**
   * Tests: called when a stale lock was read (`read`), when a stale takeover guard was read and is about to be checked
   * again before its removal (`stale-guard`), once the takeover guard is held (`guarded`), right before the stale lock
   * is removed (`unlink`), and right before the new lock's text is written (`write`; a throw there is a failed write).
   */
  onTakeover?: (stage: 'read' | 'stale-guard' | 'guarded' | 'unlink' | 'write') => void;
}

/**
 * Writes the lock file `path` (made with O_EXCL: `fd`) for `me`, and makes it reach the disk. A write that fails
 * removes the file: a lock half written by this process would read as held (or as this process's) for good.
 */
function writeLock(fd: number, path: string, me: LockOwner, before?: () => void): void {
  try {
    try {
      before?.();
      writeSync(fd, lockText(me));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
    throw new Error(`the trader lock ${path} could not be written: ${errorMessage(err)}`);
  }
  syncDir(dirname(path));
}

/** The guard's text, or null when it cannot be read (gone). */
function readGuard(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** A guard as read: its text and which file it is (inode and mtime, from stat); null when it cannot be read (gone). */
interface GuardSeen {
  text: string;
  ino: bigint;
  mtimeNs: bigint;
}

function seeGuard(path: string): GuardSeen | null {
  try {
    const st = statSync(path, { bigint: true });
    return { text: readFileSync(path, 'utf8'), ino: st.ino, mtimeNs: st.mtimeNs };
  } catch {
    return null;
  }
}

/**
 * Whether `now` is still the guard `seen` was: the same text, inode and mtime. The text alone cannot tell a dead
 * starter's empty guard (it died between making the file and writing its token) from a live starter's fresh one at
 * the same moment of its life.
 */
function sameGuard(seen: GuardSeen, now: GuardSeen | null): boolean {
  return now !== null && now.text === seen.text && now.ino === seen.ino && now.mtimeNs === seen.mtimeNs;
}

/** Takes the lock or throws why not. */
export function acquireTraderLock(path: string, options: AcquireOptions = {}): TraderLock {
  const me = options.me ?? THIS_PROCESS;
  const now = options.now ?? (() => Date.now());
  const guardPath = `${path}.takeover`;
  mkdirSync(dirname(path), { recursive: true });
  let tookOver: string | null = null;
  let made: number | null = null;
  for (let attempt = 0; attempt < 4 && made === null; attempt++) {
    try {
      made = openSync(path, 'wx');
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`the trader lock ${path} could not be made: ${(err as Error).message}`);
    }
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;      // removed meanwhile: try again
    }
    const owner = parseLockText(text);
    if (owner === null) throw new Error(`the trader lock ${path} holds no pid (${JSON.stringify(text.trim().slice(0, 40))}): another process may be taking it now, so it counts as held; if no serve or pair-mainnet runs for this desk, delete this file and start again (tools/mainnet/README.md, "Clear a lock file")`);
    const status = lockStatus(owner, me, options.alive, beatAge(path, now()));
    if (status.kind === 'mine') throw new Error(`this process (pid ${me.pid}) already trades this desk and holds ${path}: one trader per desk`);
    if (status.kind === 'held') throw new Error(`another process (${status.why}) trades this desk and holds ${path}: one trader per desk; stop it first`);
    options.onTakeover?.('read');
    // Stale. Only one starter takes it over: the one that makes the guard. Under it, the lock is read again (another
    // starter may have taken it over since this one read it) before it is replaced.
    // The guard holds a token of this attempt: it is removed only by its maker, or as the stale guard that was read.
    const token = `${me.pid} ${me.id ?? '-'} ${randomUUID()}\n`;
    let guard: number;
    try {
      guard = openSync(guardPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`the trader lock's takeover guard ${guardPath} could not be made: ${(err as Error).message}`);
      const seen = seeGuard(guardPath);
      const age = seen === null ? null : Math.max(0, now() - Number(seen.mtimeNs / 1_000_000n));
      if (seen !== null && age !== null && age > TAKEOVER_GUARD_STALE_MS) {
        // Left by a starter that died while taking over: removed only while it is still that guard, the same file
        // (another starter may have removed it and made its own since, empty too until its token is written).
        options.onTakeover?.('stale-guard');
        // Known window (from before the inode check): between this check and the unlink, another starter can remove
        // the stale guard and make its own, which this unlink then removes, so two starters may both hold "the"
        // guard. It takes a starter that died holding a guard, then two starters reaching its removal within the same
        // few microseconds. A rename to a private name would make the check race-free, but when the renamed file
        // turns out to be a live starter's guard it has to be renamed back, and that can race a third starter: not
        // worth it here.
        if (sameGuard(seen, seeGuard(guardPath))) {
          try {
            unlinkSync(guardPath);
          } catch {
            // Someone else removed it first.
          }
        }
        continue;
      }
      throw new Error(`another process is taking over the stale trader lock ${path} now (${guardPath}): one trader per desk; tried again`);
    }
    try {
      try {
        writeSync(guard, token);
      } finally {
        closeSync(guard);
      }
      options.onTakeover?.('guarded');
      let again: string | null;
      try {
        again = readFileSync(path, 'utf8');
      } catch {
        again = null;
      }
      if (again !== text) continue;    // it changed (taken over, or let go) since it was read: judged again
      try {
        options.onTakeover?.('unlink');
        unlinkSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;    // let go meanwhile: judged again
        throw new Error(`the stale trader lock ${path} could not be removed: ${errorMessage(err)}`);
      }
      try {
        made = openSync(path, 'wx');
      } catch {
        continue;                      // a starter without a stale lock to read made it meanwhile: judged again
      }
      tookOver = `the trader lock ${path} of pid ${owner.pid} was stale (${status.why}) and is taken over`;
    } finally {
      // Only this attempt's own guard: one removed as stale and made again by another starter is that starter's.
      if (readGuard(guardPath) === token) {
        try {
          unlinkSync(guardPath);
        } catch {
          // Already gone.
        }
      }
    }
  }
  if (made === null) throw new Error(`the trader lock ${path} could not be taken`);
  writeLock(made, path, me, () => options.onTakeover?.('write'));

  const timers = options.timers ?? lockTimers;
  let released = false;
  let timer: unknown = null;
  // Whose the lock is now: `other` only when the file was read and names another holder; `unread` when it could not
  // be read (gone, EIO, EMFILE) or names no one yet (a starter between making it and writing it).
  const whose = (): 'mine' | 'other' | 'unread' => {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return 'unread';
    }
    const owner = parseLockText(text);
    if (owner === null) return 'unread';
    return owner.id === me.id ? 'mine' : 'other';
  };
  const stopBeat = () => {
    if (timer === null) return;
    timers.clearInterval(timer);
    timer = null;
    heartbeats--;
  };
  const beat = (): boolean => {
    if (released) {
      stopBeat();
      return false;
    }
    const w = whose();
    if (w === 'other') {
      stopBeat();
      return false;
    }
    // A read that failed proves nothing: the lock is still this holder's as far as is known, so the beat goes on.
    if (w === 'unread') return false;
    const t = new Date(now());
    try {
      utimesSync(path, t, t);
      return true;
    } catch {
      return false;      // tried again at the next beat
    }
  };
  timer = timers.setInterval(() => void beat(), LOCK_HEARTBEAT_MS);
  heartbeats++;
  const release = () => {
    if (released) return;
    released = true;
    stopBeat();
    try {
      if (whose() === 'mine') unlinkSync(path);
    } catch {
      // Already gone.
    }
  };
  if (options.onExit !== false) process.once('exit', release);
  return { path, tookOver, beat, beating: () => timer !== null, release };
}
