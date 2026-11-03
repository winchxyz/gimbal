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
// between creating and writing it) counts as held.
//
// The conventions (and userStateDir, the lock) follow the rescuer's state of PR #63 (rescue/state.ts, rescue/lock.ts);
// TODO(dedupe): once both are merged, share userStateDir, the atomic save and the lock with those files.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
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

/**
 * Who holds the lock at `path`: a running process's pid; 'unknown' for a file with no pid in it (its holder is between
 * creating and writing it, or crashed there: held until removed by hand) or one that cannot be read; null when there
 * is no lock or its process is gone.
 */
export function lockHolder(path: string): number | 'unknown' | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unknown';
  }
  if (!/^\d+$/.test(text)) return 'unknown';
  const pid = Number(text);
  return alive(pid) ? pid : null;
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
  release(): void;
}

/** Takes the lock or throws why not; `onExit` false leaves removing it to the caller (tests). */
export function acquireTraderLock(path: string, options: { onExit?: boolean } = {}): TraderLock {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`the trader lock ${path} could not be made: ${(err as Error).message}`);
      let text = '';
      try {
        text = readFileSync(path, 'utf8').trim();
      } catch {
        continue;      // removed meanwhile: try again
      }
      const pid = /^\d+$/.test(text) ? Number(text) : null;
      if (pid === null) throw new Error(`the trader lock ${path} holds no pid (${JSON.stringify(text.slice(0, 40))}): another process may be taking it now, so it counts as held; if no serve or pair-mainnet runs for this desk, remove it`);
      if (pid === process.pid || alive(pid)) throw new Error(`another process (pid ${pid}) trades this desk and holds ${path}: one trader per desk; stop it first`);
      try {
        unlinkSync(path);       // stale: its process is gone
      } catch {
        // Someone else took it over first; the next open says who.
      }
      continue;
    }
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
      } catch {
        // Already gone.
      }
    };
    if (options.onExit !== false) process.once('exit', release);
    return { path, release };
  }
  throw new Error(`the trader lock ${path} could not be taken`);
}
