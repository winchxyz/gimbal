// The rescuer's holds and counters on disk (E9), so a restart neither forgets money that may still move nor frees
// the rescue cap early. One JSON file per mode, contract, desk and desk EVM address, in GIMBAL_STATE_DIR (on mainnet
// by default the per-user directory of lock.ts, outside any checkout, so another worktree or a `git clean` cannot
// lose it). A save writes a temporary file, fsyncs it and renames it over the old one, synchronously: the rescuer
// saves before it signs or withdraws, and asks for no signature and sends no withdraw unless that save succeeded.
//
// What it keeps: the transfer holds (deposit address, the verified quote, amounts, a signed EIP-3009 authorization's
// from / nonce / validBefore, the desk's EIP-3009 counter and the Arbitrum block before signing, 1Click's last
// status), an OutcomeUnknown, the USDC the rescuer's own hl_withdraws left on Arbitrum and a withdraw still on its
// way, the cap meter's sliding hour, and the ledger entries and Arbitrum logs already matched. Everything in it is
// public on chain or at 1Click once signed: no key, no secret.
//
// A file that is missing, cannot be read, names another contract, desk or EVM address, or does not pass
// parseRescueState is never taken as "no holds": the rescuer then holds every transfer and says so (rescuer.ts).
// A first run needs GIMBAL_RESCUE_FRESH=1, which writes an empty state.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Mode, VenueId } from '@gimbal/shared';
import { errorMessage } from '../venues/recorder.ts';
import type { QuotedMethod, VerifiedQuote } from './oneclick.ts';

export const RESCUE_STATE_VERSION = 1;

/** How a held transfer or an unknown outcome is cleared by hand once reconciled (also in the file's `_readme`). */
export const MANUAL_CLEAR = 'stop the engine, delete that hold from "holds" (or set "unknown" to null) in the state file, and start it again';

const README = 'Gimbal rescuer state: transfers that may still move, the rescue cap meter and Arbitrum USDC of its own. '
  + 'Never delete this file to clear a hold: a missing file holds every transfer. To clear one hold after reconciling it '
  + `(1Click status, the Arbitrum and NEAR transactions): ${MANUAL_CLEAR}.`;

/** Whose state it is: the file is refused for any other contract, desk or desk EVM address. */
export interface RescueIdentity {
  contractId: string;
  deskId: string;
  /** The desk's EVM address, lowercase. */
  evm: string;
}

/** The file that keeps `mode`'s rescuer state for one contract, desk and desk EVM address. */
export function rescueStateFile(dir: string, mode: Mode, id: RescueIdentity): string {
  if (!/^[a-z0-9._-]{1,64}$/.test(id.contractId)) throw new Error(`contract id ${JSON.stringify(id.contractId)} is not [a-z0-9._-]{1,64}`);
  if (!/^[a-z0-9-]{1,32}$/.test(id.deskId)) throw new Error(`desk id ${JSON.stringify(id.deskId)} is not [a-z0-9-]{1,32}`);
  if (!/^0x[0-9a-f]{40}$/.test(id.evm)) throw new Error(`desk EVM address ${JSON.stringify(id.evm)} is not lowercase 0x + 40 hex`);
  return join(dir, `rescue-${mode}-${id.contractId}-${id.deskId}-${id.evm}.json`);
}

/** A signed EIP-3009 authorization as far as telling whether it can still run needs: public once signed. */
export interface Eip3009Ref {
  from: string;
  nonce: string;
  /** Unix seconds. */
  validBefore: number;
}

export interface SavedQuote {
  method: QuotedMethod;
  quote: string;
  signature: string;
  depositAddress: string;
  amountIn: string;
  amountInE8: string;
  amountOut: string;
  minAmountOut: string;
  minAmountOutE8: string;
  destinationAsset: string;
  recipient: string;
  costE8: string;
  signedAtMs: number;
  timeEstimateS: number | null;
}

export interface SavedHold {
  why: string;
  rescueId: string;
  venue: VenueId;
  quote: SavedQuote;
  sinceMs: number;
  heldAt: number;
  reconcileSaid: boolean;
  /** Signing or sending may have run with no answer seen (a crash, or an OutcomeUnknown). */
  paying: boolean;
  /** The payment failed to send (null: sent, or not known to be unsent); deadAt: when it read as never able to run. */
  unsent: { deadAt: number | null } | null;
  authorization: Eip3009Ref | null;
  /** The desk's eip3009_next before signing (null: not read, or not an EIP-3009 payment). */
  counter: string | null;
  /** The Arbitrum head before signing, where a payment's Transfer log would start (null: not read). */
  arbBlock: string | null;
  /** The rescuer's Arbitrum USDC set aside for this payment, × 1e6 (given back if it can never run). */
  reservedE6: string;
  /** 1Click's last status for the deposit address (null: not read yet). */
  status: string | null;
}

export interface SavedWithdraw {
  rescueId: string;
  /** What arrives on Arbitrum (the amount less Hyperliquid's 1 USDC), × 1e6: exactly the Bridge2 Transfer's value. */
  amountE6: string;
  /** The Arbitrum head before the withdraw: its Transfer log is looked for from there. */
  fromBlock: string;
  acceptedAt: number;
  untilMs: number;
}

/** What a save writes, less the identity and the readme the store adds. */
export interface RescueSnapshot {
  version: typeof RESCUE_STATE_VERSION;
  savedAt: number;
  unknown: string | null;
  holds: SavedHold[];
  hl: { strandedE6: string; inFlight: SavedWithdraw | null };
  cap: { usd: number; at: number }[];
  /** Ledger entry ids and Arbitrum log ids (`arb:` + tx:index) already matched to a delivery or a withdraw. */
  seen: string[];
}

export interface RescueState extends RescueSnapshot {
  identity: RescueIdentity;
}

export function saveQuote(q: VerifiedQuote): SavedQuote {
  return {
    method: q.method, quote: q.quote, signature: q.signature, depositAddress: q.depositAddress, amountIn: q.amountIn.toString(), amountInE8: q.amountInE8.toString(),
    amountOut: q.amountOut.toString(), minAmountOut: q.minAmountOut.toString(), minAmountOutE8: q.minAmountOutE8.toString(), destinationAsset: q.destinationAsset,
    recipient: q.recipient, costE8: q.costE8.toString(), signedAtMs: q.signedAtMs, timeEstimateS: q.timeEstimateS,
  };
}

export function loadQuote(q: SavedQuote): VerifiedQuote {
  return {
    method: q.method, quote: q.quote, signature: q.signature, depositAddress: q.depositAddress, amountIn: BigInt(q.amountIn), amountInE8: BigInt(q.amountInE8),
    amountOut: BigInt(q.amountOut), minAmountOut: BigInt(q.minAmountOut), minAmountOutE8: BigInt(q.minAmountOutE8), destinationAsset: q.destinationAsset,
    recipient: q.recipient, costE8: BigInt(q.costE8), signedAtMs: q.signedAtMs, timeEstimateS: q.timeEstimateS,
  };
}

// ---- checks: a field that is not exactly what a save writes makes the whole file unusable ----

const METHODS: readonly QuotedMethod[] = ['sol_sign_rescue', 'hl_send_to_intents', 'evm_usdc_to_intents', 'fund_venue'];
const VENUES: readonly VenueId[] = ['hyperliquid', 'phoenix', 'orderly'];

function bad(path: string, what: string): never {
  throw new Error(`${path}: ${what}`);
}
function obj(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) bad(path, 'not an object');
  return v as Record<string, unknown>;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') bad(path, 'not a string');
  return v;
}
function nonEmpty(v: unknown, path: string): string {
  const s = str(v, path);
  if (s === '') bad(path, 'empty');
  return s;
}
function time(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) bad(path, 'not a time in ms');
  return v;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') bad(path, 'not a boolean');
  return v;
}
function units(v: unknown, path: string): string {
  const s = str(v, path);
  if (!/^(0|[1-9]\d{0,38})$/.test(s)) bad(path, 'not a non-negative integer amount');
  return s;
}
function nullable<T>(v: unknown, path: string, f: (v: unknown, path: string) => T): T | null {
  return v === null ? null : f(v, path);
}
function oneOf<T extends string>(v: unknown, path: string, list: readonly T[]): T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) bad(path, `not one of ${list.join(', ')}`);
  return v as T;
}

function parseQuote(v: unknown, path: string): SavedQuote {
  const q = obj(v, path);
  const te = q.timeEstimateS;
  if (te !== null && (typeof te !== 'number' || !Number.isFinite(te))) bad(`${path}.timeEstimateS`, 'not a number or null');
  return {
    method: oneOf(q.method, `${path}.method`, METHODS), quote: nonEmpty(q.quote, `${path}.quote`), signature: nonEmpty(q.signature, `${path}.signature`),
    depositAddress: nonEmpty(q.depositAddress, `${path}.depositAddress`), amountIn: units(q.amountIn, `${path}.amountIn`), amountInE8: units(q.amountInE8, `${path}.amountInE8`),
    amountOut: units(q.amountOut, `${path}.amountOut`), minAmountOut: units(q.minAmountOut, `${path}.minAmountOut`), minAmountOutE8: units(q.minAmountOutE8, `${path}.minAmountOutE8`),
    destinationAsset: nonEmpty(q.destinationAsset, `${path}.destinationAsset`), recipient: nonEmpty(q.recipient, `${path}.recipient`), costE8: units(q.costE8, `${path}.costE8`),
    signedAtMs: time(q.signedAtMs, `${path}.signedAtMs`), timeEstimateS: te as number | null,
  };
}

function parseAuthorization(v: unknown, path: string): Eip3009Ref {
  const a = obj(v, path);
  const vb = a.validBefore;
  if (typeof vb !== 'number' || !Number.isSafeInteger(vb) || vb < 0) bad(`${path}.validBefore`, 'not unix seconds');
  return { from: nonEmpty(a.from, `${path}.from`), nonce: nonEmpty(a.nonce, `${path}.nonce`), validBefore: vb };
}

function parseHold(v: unknown, path: string): SavedHold {
  const h = obj(v, path);
  return {
    why: nonEmpty(h.why, `${path}.why`), rescueId: nonEmpty(h.rescueId, `${path}.rescueId`), venue: oneOf(h.venue, `${path}.venue`, VENUES),
    quote: parseQuote(h.quote, `${path}.quote`), sinceMs: time(h.sinceMs, `${path}.sinceMs`), heldAt: time(h.heldAt, `${path}.heldAt`),
    reconcileSaid: bool(h.reconcileSaid, `${path}.reconcileSaid`), paying: bool(h.paying, `${path}.paying`),
    unsent: nullable(h.unsent, `${path}.unsent`, (u, p) => ({ deadAt: nullable(obj(u, p).deadAt, `${p}.deadAt`, time) })),
    authorization: nullable(h.authorization, `${path}.authorization`, parseAuthorization),
    counter: nullable(h.counter, `${path}.counter`, units), arbBlock: nullable(h.arbBlock, `${path}.arbBlock`, units),
    reservedE6: units(h.reservedE6, `${path}.reservedE6`), status: nullable(h.status, `${path}.status`, str),
  };
}

function parseWithdraw(v: unknown, path: string): SavedWithdraw {
  const w = obj(v, path);
  return {
    rescueId: nonEmpty(w.rescueId, `${path}.rescueId`), amountE6: units(w.amountE6, `${path}.amountE6`), fromBlock: units(w.fromBlock, `${path}.fromBlock`),
    acceptedAt: time(w.acceptedAt, `${path}.acceptedAt`), untilMs: time(w.untilMs, `${path}.untilMs`),
  };
}

/** The state as a save wrote it; throws, naming the field, on anything else. */
export function parseRescueState(v: unknown): RescueState {
  const s = obj(v, 'state');
  if (s.version !== RESCUE_STATE_VERSION) bad('state.version', `not ${RESCUE_STATE_VERSION}`);
  if (!Array.isArray(s.holds)) bad('state.holds', 'not a list');
  if (!Array.isArray(s.cap)) bad('state.cap', 'not a list');
  if (!Array.isArray(s.seen)) bad('state.seen', 'not a list');
  const hl = obj(s.hl, 'state.hl');
  const id = obj(s.identity, 'state.identity');
  return {
    version: RESCUE_STATE_VERSION,
    identity: { contractId: nonEmpty(id.contractId, 'state.identity.contractId'), deskId: nonEmpty(id.deskId, 'state.identity.deskId'), evm: nonEmpty(id.evm, 'state.identity.evm') },
    savedAt: time(s.savedAt, 'state.savedAt'),
    unknown: nullable(s.unknown, 'state.unknown', nonEmpty),
    holds: s.holds.map((h, i) => parseHold(h, `state.holds[${i}]`)),
    hl: { strandedE6: units(hl.strandedE6, 'state.hl.strandedE6'), inFlight: nullable(hl.inFlight, 'state.hl.inFlight', parseWithdraw) },
    cap: s.cap.map((c, i) => {
      const e = obj(c, `state.cap[${i}]`);
      if (typeof e.usd !== 'number' || !Number.isFinite(e.usd) || e.usd < 0) bad(`state.cap[${i}].usd`, 'not a non-negative number');
      return { usd: e.usd, at: time(e.at, `state.cap[${i}].at`) };
    }),
    seen: s.seen.map((x, i) => nonEmpty(x, `state.seen[${i}]`)),
  };
}

export type LoadedState =
  | { kind: 'none' }
  | { kind: 'loaded'; state: RescueState }
  | { kind: 'unusable'; problem: string };

/** Blocks the thread for `ms`: a save is synchronous so that nothing is signed before it is on disk. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RETRIED_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface RescueStateStoreOptions {
  /** fs.renameSync in place: tests make it fail. */
  rename?: (from: string, to: string) => void;
  /** Tries of the rename on EPERM, EBUSY or EACCES (Windows: a reader or a scanner has the file open); default 5. */
  renameTries?: number;
}

export class RescueStateStore {
  readonly path: string;
  readonly identity: RescueIdentity;
  readonly #rename: (from: string, to: string) => void;
  readonly #tries: number;

  constructor(path: string, identity: RescueIdentity, options: RescueStateStoreOptions = {}) {
    this.path = path;
    this.identity = { ...identity, evm: identity.evm.toLowerCase() };
    this.#rename = options.rename ?? renameSync;
    this.#tries = options.renameTries ?? 5;
  }

  /** The saved state; `none` only when there is no file at all. A failed read is tried once more first. */
  load(): LoadedState {
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
    let state: RescueState;
    try {
      state = parseRescueState(JSON.parse(text));
    } catch (err) {
      return { kind: 'unusable', problem: `${this.path} is not a rescuer state this engine wrote: ${errorMessage(err)}` };
    }
    const want = this.identity;
    const got = state.identity;
    if (got.contractId !== want.contractId || got.deskId !== want.deskId || got.evm.toLowerCase() !== want.evm) {
      return { kind: 'unusable', problem: `${this.path} belongs to contract ${got.contractId}, desk ${got.deskId}, EVM ${got.evm}, not ${want.contractId}, ${want.deskId}, ${want.evm}` };
    }
    return { kind: 'loaded', state };
  }

  /** Writes `state` atomically: a temporary file, fsynced, then renamed over the old one. Throws when it could not. */
  save(state: RescueSnapshot): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const body = `${JSON.stringify({ _readme: README, ...state, identity: this.identity }, null, 2)}\n`;
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

  /** Temporary files a crash left next to the state file (only one engine runs per desk: lock.ts). */
  #cleanTemps(): void {
    let names: string[];
    try {
      names = readdirSync(dirname(this.path));
    } catch {
      return;
    }
    const base = basename(this.path);
    for (const n of names) {
      if (!n.startsWith(`${base}.`) || !n.endsWith('.tmp')) continue;
      try {
        unlinkSync(join(dirname(this.path), n));
      } catch {
        // Left for the next start.
      }
    }
  }
}
