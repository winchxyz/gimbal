// The rescuer's holds and counters on disk (E9), so a restart neither forgets money that may still move nor frees
// the rescue cap early. One JSON file per mode and desk in GIMBAL_STATE_DIR (default engine/state/, gitignored), next
// to the strategy store's. A save writes a temporary file and renames it over the old one, synchronously: the rescuer
// saves before it signs or withdraws, and signs nothing unless the save succeeded.
//
// What it keeps: the transfer holds (deposit address, the verified quote, amounts, a signed EIP-3009 authorization's
// from / nonce / validBefore, 1Click's last status), an OutcomeUnknown, the USDC the rescuer's own hl_withdraws left
// on Arbitrum and a withdraw still on its way, the cap meter's sliding hour, and the ledger entries already matched.
// Everything in it is public on chain or at 1Click once signed: no key, no secret.
//
// A file that cannot be read or does not pass parseRescueState is never taken as "no holds": the rescuer then holds
// every transfer and says so (rescuer.ts). Only a missing file means a first run (or an owner who removed it after
// reconciling).

import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Mode, VenueId } from '@gimbal/shared';
import { errorMessage } from '../venues/recorder.ts';
import type { QuotedMethod, VerifiedQuote } from './oneclick.ts';

export const RESCUE_STATE_VERSION = 1;

/** Desk ids are [a-z0-9-]{1,32} (docs/interfaces.md §1.5), so one is safe in a file name. */
const DESK_ID = /^[a-z0-9-]{1,32}$/;

/** The file that keeps `mode`'s rescuer state for `deskId`. */
export function rescueStateFile(dir: string, mode: Mode, deskId: string): string {
  if (!DESK_ID.test(deskId)) throw new Error(`desk id ${JSON.stringify(deskId)} is not [a-z0-9-]{1,32}`);
  return join(dir, `rescue-${mode}-${deskId}.json`);
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
  /** The rescue was still paying it when this was saved: after a restart it may have been signed or sent. */
  paying: boolean;
  /** The payment failed to send (null: sent, or not known to be unsent); deadAt: when it read as never able to run. */
  unsent: { deadAt: number | null } | null;
  authorization: Eip3009Ref | null;
  /** The rescuer's Arbitrum USDC set aside for this payment, × 1e6 (given back if it expires unused). */
  reservedE6: string;
  /** 1Click's last status for the deposit address (null: not read yet). */
  status: string | null;
}

export interface SavedWithdraw {
  rescueId: string;
  /** What arrives on Arbitrum (the amount less Hyperliquid's 1 USDC), × 1e6. */
  amountE6: string;
  /** The Arbitrum balance it arrives on top of, × 1e6. */
  baseE6: string;
  acceptedAt: number;
  untilMs: number;
}

export interface RescueState {
  version: typeof RESCUE_STATE_VERSION;
  savedAt: number;
  unknown: string | null;
  holds: SavedHold[];
  hl: { strandedE6: string; inFlight: SavedWithdraw | null };
  cap: { usd: number; at: number }[];
  seen: string[];
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
    reservedE6: units(h.reservedE6, `${path}.reservedE6`), status: nullable(h.status, `${path}.status`, str),
  };
}

function parseWithdraw(v: unknown, path: string): SavedWithdraw {
  const w = obj(v, path);
  return {
    rescueId: nonEmpty(w.rescueId, `${path}.rescueId`), amountE6: units(w.amountE6, `${path}.amountE6`), baseE6: units(w.baseE6, `${path}.baseE6`),
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
  return {
    version: RESCUE_STATE_VERSION,
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

export class RescueStateStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The saved state; `none` only when there is no file at all. */
  load(): LoadedState {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
      return { kind: 'unusable', problem: `${this.path} could not be read: ${errorMessage(err)}` };
    }
    try {
      return { kind: 'loaded', state: parseRescueState(JSON.parse(text)) };
    } catch (err) {
      return { kind: 'unusable', problem: `${this.path} is not a rescuer state this engine wrote: ${errorMessage(err)}` };
    }
  }

  /** Writes `state` atomically (a temporary file renamed over the old one); throws when it could not. */
  save(state: RescueState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
  }
}
