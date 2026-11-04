// A one-shot Orderly withdrawal, asked for with GIMBAL_ORDERLY_WITHDRAW=<contract>/<desk>/<amount USDC | all>/<run-id>
// and run by serve only with GIMBAL_SETUP=1 (serve-setup.ts). It exists because Orderly takes the desk's key only from
// the engine's own IPs once an IP list is applied: no other machine can post the withdrawal, and the engine's control
// routes are loopback only. The money goes to the desk's own EVM address on Arbitrum (the contract signs no other
// receiver); tools/mainnet/hl-return.mjs `bridge` then brings it to the contract on NEAR.
//
//   1  a marker for this run-id in the state directory: log what it says, do nothing (at most once per run-id)
//   2  the engine's `auto` is off; get_desk: the contract and desk are the engine's, the desk running (operator path)
//   3  get_desk_counters: what is left of the hourly rescue cap and cost budget; signed reads: every Orderly position
//      flat, and the amount within what can leave (holding - frozen, less any unsettled loss, at most free_collateral)
//   4  `auto` checked again, then the marker `started`, created exclusively and fsynced before anything that moves
//      money is signed
//   5  OrderlyDeskClient.withdraw: settle_pnl, then withdraw_request
//   6  marker `done` with the report, or `failed` with the error and what Orderly got; never retried
//
// A refusal in 1-4 writes no marker, so the same run-id runs once the cause is fixed. A `started` marker with no
// outcome (the process died in step 5) is an unknown outcome: nothing runs again for that run-id. serve's shutdown
// drains the run: before step 4 it stops (no marker), from step 4 on it is waited for.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TxRef } from '@gimbal/shared';
import type { ContractClient, DeskView } from '../contract/types.ts';
import { fsyncDir, writeAtomic } from '../book/store.ts';
import type { OrderlyWithdrawReport } from '../venues/orderly-actions.ts';
import { OrderlyDeskClient } from '../venues/orderly-actions.ts';
import type { OrderlyNetwork } from '../venues/orderly-http.ts';
import { OrderlyApiError } from '../venues/orderly-http.ts';
import type { OrderlySigner } from '../venues/orderly-signer.ts';
import { parseBalance, parseRestHolding, parseRestPositions, streamNumber } from '../venues/orderly-stream.ts';
import { errorMessage } from '../venues/recorder.ts';
import { collectingSigner } from './service.ts';

export const ORDERLY_WITHDRAW_ENV = 'GIMBAL_ORDERLY_WITHDRAW';
const PREFIX = 'orderly withdraw:';
const E6 = 1_000_000n;
/** The contract's floor for the operator's withdrawal: max(10 x max_transfer_cost_flat_e6, 10 USDC). */
const OPERATOR_MIN_FLOOR_E6 = 10n * E6;
/** Orderly's fee per withdrawal, USD x 1e8, as the contract counts it against the hourly cost budget (VENUE_FEE_E8). */
const VENUE_FEE_E8 = 100_000_000n;
const UNKNOWN_HINT = 'unknown outcome, check the desk EVM on Arbitrum and nearblocks; set a new run-id only after checking '
  + '(wait about 30 min, then look at the desk EVM\'s USDC on arbiscan)';

export interface OrderlyWithdrawAsk {
  contractId: string;
  deskId: string;
  /** Canonical USDC decimal (at most 6 decimals, no trailing zeros), as orderly_withdraw takes it; or `all`. */
  amount: string;
  /** null: `all`, what can leave Orderly at step 3. */
  amountE6: bigint | null;
  runId: string;
}

/** Parses `<contract>/<desk>/<amount USDC | all>/<run-id>`; throws saying what is wrong. */
export function parseOrderlyWithdraw(value: string): OrderlyWithdrawAsk {
  const parts = value.trim().split('/');
  if (parts.length !== 4) throw new Error(`${ORDERLY_WITHDRAW_ENV} must be <contract>/<desk>/<amount USDC | all>/<run-id>, got ${parts.length} part(s)`);
  const [contractId, deskId, amountText, runId] = parts as [string, string, string, string];
  if (!/^[a-z0-9._-]{2,64}$/.test(contractId)) throw new Error(`${ORDERLY_WITHDRAW_ENV}: contract ${JSON.stringify(contractId)} is not a NEAR account id`);
  if (!/^[a-z0-9-]{1,32}$/.test(deskId)) throw new Error(`${ORDERLY_WITHDRAW_ENV}: desk ${JSON.stringify(deskId)} is not [a-z0-9-]{1,32}`);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(runId)) throw new Error(`${ORDERLY_WITHDRAW_ENV}: run-id ${JSON.stringify(runId)} is not [A-Za-z0-9_-]{1,40}`);
  if (amountText === 'all') return { contractId, deskId, amount: 'all', amountE6: null, runId };
  const amountE6 = usdcE6(amountText);
  if (amountE6 === null || amountE6 <= 0n) {
    throw new Error(`${ORDERLY_WITHDRAW_ENV}: amount ${JSON.stringify(amountText)} is not \`all\` nor a positive USDC amount with at most 6 decimals`);
  }
  return { contractId, deskId, amount: formatE6(amountE6), amountE6, runId };
}

/** A USDC decimal string in units of 1e-6, or null when it is not one (more than 6 decimals, signs, exponents). */
export function usdcE6(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (m === null) return null;
  return BigInt(m[1]!) * E6 + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** Units of 1e-6 as a canonical decimal: no trailing zeros, no trailing dot. */
export function formatE6(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % E6).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / E6}${frac === '' ? '' : `.${frac}`}`;
}

export function orderlyWithdrawMarker(stateDir: string, ask: Pick<OrderlyWithdrawAsk, 'contractId' | 'deskId' | 'runId'>): string {
  return join(stateDir, `orderly-withdraw-${ask.contractId}-${ask.deskId}-${ask.runId}.json`);
}

/** What serve's client gives this run: the desk's Orderly signed reads and its settle-first withdrawal. */
export interface OrderlyWithdrawClient {
  readonly evmAddress: string;
  positions(reason?: string): Promise<unknown>;
  holding(reason?: string): Promise<unknown>;
  withdraw(amount: string, reason?: string): Promise<OrderlyWithdrawReport>;
}

export interface OrderlyWithdrawDeps {
  ask: OrderlyWithdrawAsk;
  /** The engine's own GIMBAL_CONTRACT_ID and DESK_ID, and the NEAR account the operator key is on. */
  engine: { contractId: string; deskId: string; operatorAccount: string };
  stateDir: string;
  /** Whether the strategy loop may open a leg by itself (the engine rules' `auto`). Absent: unknown, so refused. */
  autoOn?: () => boolean;
  /** serve is shutting down: a run that has not written its marker yet stops. */
  stopping?: () => boolean;
  desk(): Promise<DeskView | null>;
  /** get_desk_counters(desk), as the contract answers it (null: no counters yet). */
  counters(): Promise<unknown>;
  orderly(desk: DeskView): OrderlyWithdrawClient;
  /** The NEAR transactions of the contract's signatures so far (collectingSigner). */
  takeTx?: () => TxRef[];
  /** Whether the withdraw_request went out to Orderly. Absent: assumed yes (an error is then an unknown outcome). */
  withdrawPosted?: () => boolean;
  log(line: string): void;
  now?: () => number;
}

/** What a failed run left behind: nothing sent to Orderly, a definite rejection by Orderly, or not known. */
export type WithdrawFailure = 'not_sent' | 'rejected' | 'unknown';

export type OrderlyWithdrawResult =
  | { status: 'marker'; marker: string; was: string }
  | { status: 'refused'; reason: string }
  | { status: 'done'; amount: string; report: OrderlyWithdrawReport; tx: TxRef[] }
  | { status: 'failed'; error: string; outcome: WithdrawFailure; tx: TxRef[] };

interface Marker {
  status: 'started' | 'done' | 'failed';
  contractId: string;
  deskId: string;
  runId: string;
  amount: string;
  evmAddress: string;
  startedAt: string;
  finishedAt?: string;
  report?: OrderlyWithdrawReport;
  error?: string;
  outcome?: WithdrawFailure;
  tx?: TxRef[];
}

export async function runOrderlyWithdraw(d: OrderlyWithdrawDeps): Promise<OrderlyWithdrawResult> {
  const { ask, engine } = d;
  const now = d.now ?? Date.now;
  const say = (line: string) => d.log(`${PREFIX} ${line}`);
  const refuse = (reason: string, marker = 'no marker was written'): OrderlyWithdrawResult => {
    say(`refused: ${reason}; nothing that moves money was signed and ${marker}: fix it and restart (the same run-id ${ask.runId} runs then), or unset ${ORDERLY_WITHDRAW_ENV}`);
    return { status: 'refused', reason };
  };
  /** The strategy loop could open an Orderly leg between the flat check and the withdrawal: only with auto off. */
  const autoProblem = (): string | null => {
    if (d.stopping?.() === true) return 'serve is stopping';
    if (d.autoOn === undefined) return 'the engine\'s auto setting cannot be read here, so a leg the strategy loop opens meanwhile cannot be ruled out';
    return d.autoOn() ? 'the engine\'s auto is on: the strategy loop could open an Orderly leg between the flat check and the withdrawal; turn auto off (PUT /strategy) first' : null;
  };
  const path = orderlyWithdrawMarker(d.stateDir, ask);

  // 1. At most once per run-id, across restarts.
  const seen = readMarker(path);
  if (seen !== null) {
    say(describeMarker(seen, path, ask.runId));
    return { status: 'marker', marker: path, was: seen.kind === 'ok' ? seen.marker.status : 'unreadable' };
  }
  say(`run ${ask.runId}: ${ask.amount} USDC from Orderly for desk ${ask.deskId} on ${ask.contractId}; no marker at ${path}, checking`);

  // 2. The engine's own rules and the desk, as the contract has it now.
  if (ask.contractId !== engine.contractId || ask.deskId !== engine.deskId) {
    return refuse(`it names ${ask.contractId}/${ask.deskId}, but this engine runs ${engine.contractId}/${engine.deskId} (GIMBAL_CONTRACT_ID, DESK_ID)`);
  }
  const auto = autoProblem();
  if (auto !== null) return refuse(auto);
  let desk: DeskView | null;
  try {
    desk = await d.desk();
  } catch (err) {
    return refuse(`get_desk(${ask.deskId}) failed: ${errorMessage(err)}`);
  }
  if (desk === null) return refuse(`the contract has no desk ${ask.deskId}`);
  if (desk.owner !== engine.operatorAccount && desk.operator !== engine.operatorAccount) {
    return refuse(`desk ${ask.deskId} belongs to ${desk.owner}; the operator key is on ${engine.operatorAccount}`);
  }
  if (desk.paused || desk.closing === true) {
    return refuse(`desk ${ask.deskId} is ${desk.closing === true ? 'closing (panic_close)' : 'paused'}: the operator's orderly_withdraw needs the desk running; unpause it first (strategy auto off), then restart`);
  }
  say(`desk ${ask.deskId} is running; desk EVM ${desk.evm_address}`);

  // 3. The contract's own bounds first (no gas spent on reads that could not help), then Orderly's account.
  const min = operatorMinE6(desk);
  const minText = `the operator's minimum of ${formatE6(min)} USDC (max(10 x max_transfer_cost_flat_e6, 10 USDC))`;
  if (ask.amountE6 !== null && ask.amountE6 < min) return refuse(`${ask.amount} USDC is under ${minText}`);
  let room: { capLeftE6: bigint; costLeftE8: bigint | null };
  try {
    room = hourlyRoom(await d.counters(), desk.policy.rescue_cap_usd_per_hour);
  } catch (err) {
    return refuse(`get_desk_counters(${ask.deskId}): ${errorMessage(err)}`);
  }
  if (room.costLeftE8 !== null && room.costLeftE8 < VENUE_FEE_E8) {
    return refuse(`Orderly's 1 USDC fee is over what is left of the hourly rescue cost budget (${formatE6(room.costLeftE8 / 100n)} USD): try again in an hour`);
  }
  if (ask.amountE6 !== null && ask.amountE6 > room.capLeftE6) {
    return refuse(`${ask.amount} USDC is over what is left of the hourly rescue cap, ${formatE6(room.capLeftE6)} USD, which the operator's withdrawal counts against: withdraw at most that, or wait for the cap to free up`);
  }
  let client: OrderlyWithdrawClient;
  try {
    client = d.orderly(desk);
  } catch (err) {
    return refuse(`the desk's Orderly client: ${errorMessage(err)}`);
  }
  let out: OrderlyOut;
  try {
    const positionsData = await client.positions('orderly withdraw: are all positions flat');
    const open = parseRestPositions(positionsData).filter((p) => p.positionQty !== 0);
    if (open.length > 0) {
      return refuse(`Orderly positions are not flat (${open.map((p) => `${p.symbol} ${p.positionQty}`).join(', ')}): close them first`);
    }
    out = withdrawable(positionsData, await client.holding('orderly withdraw: free USDC'));
  } catch (err) {
    return refuse(`the signed Orderly reads failed: ${errorMessage(err)}`);
  }
  const amountE6 = ask.amountE6 ?? out.availableE6;
  const amount = formatE6(amountE6);
  if (ask.amountE6 === null && amountE6 < min) return refuse(`all that can leave Orderly, ${amount} USDC (${out.text}), is under ${minText}`);
  if (amountE6 > out.availableE6) return refuse(`${amount} USDC is over what can leave Orderly, ${formatE6(out.availableE6)} USDC (${out.text})`);
  if (amountE6 > room.capLeftE6) {
    return refuse(`${amount} USDC is over what is left of the hourly rescue cap, ${formatE6(room.capLeftE6)} USD: withdraw at most that now and the rest an hour later`);
  }
  const left = out.availableE6 - amountE6;
  say(`checks passed: auto off, positions flat, ${formatE6(out.availableE6)} USDC can leave (${out.text}), operator minimum ${formatE6(min)}, `
    + `hourly cap left ${formatE6(room.capLeftE6)}; ${formatE6(left)} USDC stays on Orderly`
    + (left > 0n && left < min ? `, under the operator's minimum: only the owner's path can take it out later, and that too only from the engine's IPs` : ''));

  // 4. auto once more (PUT /strategy may have turned it on during the reads), then the marker, before anything that
  // moves money is signed. A marker another run created meanwhile stops this one.
  const late = autoProblem();
  if (late !== null) return refuse(late);
  const started: Marker = {
    status: 'started', contractId: ask.contractId, deskId: ask.deskId, runId: ask.runId, amount,
    evmAddress: client.evmAddress, startedAt: new Date(now()).toISOString(),
  };
  try {
    createExclusive(path, `${JSON.stringify(started, null, 2)}\n`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return refuse(`another run of ${ask.runId} created the marker ${path} meanwhile`, 'that run holds the marker; this one does nothing more');
    }
    return refuse(`could not write the marker ${path}: ${errorMessage(err)}`);
  }
  say(`started: marker ${path}; settle_pnl, then a withdraw of ${amount} USDC to ${client.evmAddress} on Arbitrum`);

  // 5 and 6. Exactly one attempt.
  const finish = (m: Marker) => {
    try {
      writeAtomic(path, `${JSON.stringify(m, null, 2)}\n`);
    } catch (err) {
      say(`could not write the outcome to ${path} (${errorMessage(err)}); it still says started, so this run-id never runs again`);
    }
  };
  try {
    const report = await client.withdraw(amount, `orderly withdraw run ${ask.runId}`);
    const tx = d.takeTx?.() ?? [];
    finish({ ...started, status: 'done', finishedAt: new Date(now()).toISOString(), report, tx });
    say(`done: Orderly took the withdrawal of ${amount} USDC to ${client.evmAddress} on Arbitrum (settle ${short(report.settled)}, withdraw ${short(report.withdraw)}; NEAR ${txList(tx)}). `
      + `Orderly's 1 USDC fee comes out of it, so ${formatE6(amountE6 - E6)} USDC lands on Arbitrum within minutes. Next: unset ${ORDERLY_WITHDRAW_ENV}, then bridge it with hl-return.mjs`);
    return { status: 'done', amount, report, tx };
  } catch (err) {
    const tx = [...(Array.isArray((err as { tx?: unknown }).tx) ? (err as { tx: TxRef[] }).tx : []), ...(d.takeTx?.() ?? [])];
    const posted = d.withdrawPosted?.() ?? true;
    // A definite refusal is OrderlyApiError; a lost answer is OutcomeUnknown, anything else is not known either.
    const outcome: WithdrawFailure = !posted ? 'not_sent' : err instanceof OrderlyApiError ? 'rejected' : 'unknown';
    const error = errorMessage(err);
    finish({ ...started, status: 'failed', finishedAt: new Date(now()).toISOString(), error, outcome, tx });
    say(`failed: ${error}; NEAR ${txList(tx)}; not retried: ${failureText(outcome)}`);
    return { status: 'failed', error, outcome, tx };
  }
}

function failureText(outcome: WithdrawFailure | undefined): string {
  switch (outcome) {
    case 'not_sent': return 'the withdraw_request never went to Orderly, so no USDC left Orderly (a settle_pnl only books PnL inside the account); a new run-id may try again';
    case 'rejected': return 'Orderly rejected the withdraw_request, so nothing left Orderly; a new run-id may try again';
    default: return `the withdraw_request went to Orderly with no definite answer: ${UNKNOWN_HINT}`;
  }
}

/** A started run: `done` settles with its result; `drain()` (serve's shutdown) stops it unless it is past its marker, then waits. */
export interface OrderlyWithdrawRun {
  done: Promise<OrderlyWithdrawResult | null>;
  drain(): Promise<OrderlyWithdrawResult | null>;
}

export interface OrderlyWithdrawStart {
  /** GIMBAL_ORDERLY_WITHDRAW as set (never undefined here: unset means this is not called). */
  value: string;
  network: OrderlyNetwork;
  /** The contract client on the operator key: get_desk and the Orderly signatures. */
  contract: Pick<ContractClient, 'getDesk'> & OrderlySigner;
  /** get_desk_counters(desk_id) through the contract's view. */
  counters(deskId: string): Promise<unknown>;
  autoOn?: () => boolean;
  engine: OrderlyWithdrawDeps['engine'];
  orderlyUrl: string;
  stateDir: string;
  log(line: string): void;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Starts the run in the background (serve does not wait for it at start); null when the value cannot be parsed,
 * which is logged and changes nothing else in serve.
 */
export function startOrderlyWithdraw(o: OrderlyWithdrawStart): OrderlyWithdrawRun | null {
  let ask: OrderlyWithdrawAsk;
  try {
    ask = parseOrderlyWithdraw(o.value);
  } catch (err) {
    o.log(`${PREFIX} ignored: ${errorMessage(err)}`);
    return null;
  }
  const collected = collectingSigner(o.contract);
  // Set as the withdraw_request leaves for Orderly: before that, no failure can have moved money.
  let posted = false;
  const base = o.fetch ?? fetch;
  const watched: typeof fetch = (input, init) => {
    if (new URL(String(input instanceof Request ? input.url : input)).pathname === '/v1/withdraw_request') posted = true;
    return base(input, init);
  };
  let stopping = false;
  const done = runOrderlyWithdraw({
    ask, engine: o.engine, stateDir: o.stateDir, log: o.log,
    stopping: () => stopping,
    ...(o.autoOn === undefined ? {} : { autoOn: o.autoOn }),
    desk: () => o.contract.getDesk(ask.deskId),
    counters: () => o.counters(ask.deskId),
    orderly: (desk) => {
      if (desk.orderly_account_id === undefined) throw new Error(`get_desk(${ask.deskId}) has no orderly_account_id`);
      return new OrderlyDeskClient({
        deskId: ask.deskId, network: o.network, apiUrl: o.orderlyUrl, accountId: desk.orderly_account_id,
        orderlyKey: `ed25519:${desk.solana.authority}`, evmAddress: desk.evm_address, referralCode: null, signer: collected.signer,
        fetch: watched, ...(o.now === undefined ? {} : { clock: { now: o.now } }),
      });
    },
    takeTx: collected.take,
    withdrawPosted: () => posted,
    ...(o.now === undefined ? {} : { now: o.now }),
  }).catch((err: unknown) => {
    o.log(`${PREFIX} stopped: ${errorMessage(err)}; if a marker says started: ${UNKNOWN_HINT}`);
    return null;
  });
  return {
    done,
    drain: () => {
      stopping = true;
      return done;
    },
  };
}

/** max(10 x max_transfer_cost_flat_e6, 10 USDC), in units of 1e-6: the contract's E_SIZE floor for the operator. */
export function operatorMinE6(desk: Pick<DeskView, 'policy'>): bigint {
  const flat = BigInt(Math.max(0, Math.floor(desk.policy.max_transfer_cost_flat_e6)));
  const ten = 10n * flat;
  return ten > OPERATOR_MIN_FLOOR_E6 ? ten : OPERATOR_MIN_FLOOR_E6;
}

/**
 * What is left of the hourly rescue cap (USDC x 1e6) and cost budget (USD x 1e8) from get_desk_counters. null (a desk
 * with no counters yet): the whole cap, and a budget that always has room for the venue fees (null here).
 */
export function hourlyRoom(counters: unknown, capUsd: number): { capLeftE6: bigint; costLeftE8: bigint | null } {
  if (counters === null || counters === undefined) return { capLeftE6: BigInt(Math.floor(capUsd)) * E6, costLeftE8: null };
  const c = counters as Record<string, unknown>;
  const e8 = (field: string): bigint => {
    const v = c[field];
    if ((typeof v === 'string' && /^\d+$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) return BigInt(v);
    throw new Error(`${field} is ${v === undefined ? 'missing' : `not a whole number (${JSON.stringify(v)})`}`);
  };
  return { capLeftE6: e8('rescue_cap_left_e8') / 100n, costLeftE8: e8('rescue_cost_left_e8') };
}

/** USDC holding - frozen from GET /v1/client/holding `data`; a missing USDC row is 0 (Orderly leaves empty tokens out). */
export function freeUsdc(data: unknown): { freeE6: bigint; holding: number; frozen: number } {
  const row = parseRestHolding(data).find(([token]) => token === 'USDC');
  if (row === undefined) return { freeE6: 0n, holding: 0, frozen: 0 };
  const b = parseBalance(row[1]);
  const freeE6 = floorE6(b.holding) - ceilE6(b.frozen);
  return { freeE6: freeE6 > 0n ? freeE6 : 0n, holding: b.holding, frozen: b.frozen };
}

interface OrderlyOut {
  availableE6: bigint;
  text: string;
}

/**
 * What can leave Orderly after settle_pnl: holding - frozen plus the rows' unsettled PnL when it is a loss (a gain is
 * not counted), and at most Orderly's own free_collateral when it gives one. Every row must carry unsettled_pnl.
 */
export function withdrawable(positionsData: unknown, holdingData: unknown): OrderlyOut {
  const rows = (positionsData as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new Error('positions: data.rows is not a list');
  let unsettled = 0;
  for (const row of rows as Record<string, unknown>[]) {
    const n = streamNumber(row?.unsettled_pnl);
    if (n === undefined) throw new Error(`positions: ${String(row?.symbol)} has no unsettled_pnl, so the settled balance cannot be told`);
    unsettled += n;
  }
  const free = freeUsdc(holdingData);
  const loss = unsettled < 0 ? ceilE6(-unsettled) : 0n;
  let available = free.freeE6 - loss;
  const fc = streamNumber((positionsData as Record<string, unknown>).free_collateral);
  if (fc !== undefined && floorE6(fc) < available) available = floorE6(fc);
  if (available < 0n) available = 0n;
  return {
    availableE6: available,
    text: `holding ${free.holding}, frozen ${free.frozen}, unsettled PnL ${round6(unsettled)}${fc === undefined ? '' : `, free_collateral ${fc}`}`,
  };
}

function floorE6(n: number): bigint {
  return BigInt(Math.floor(n * 1e6 + 1e-6));
}

function ceilE6(n: number): bigint {
  return BigInt(Math.ceil(n * 1e6 - 1e-6));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

type SeenMarker = { kind: 'ok'; marker: Marker } | { kind: 'unreadable'; problem: string };

function readMarker(path: string): SeenMarker | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { kind: 'unreadable', problem: errorMessage(err) };
  }
  try {
    const m = JSON.parse(text) as Marker;
    if (m === null || typeof m !== 'object' || !['started', 'done', 'failed'].includes(m.status)) return { kind: 'unreadable', problem: 'no status started, done or failed' };
    return { kind: 'ok', marker: m };
  } catch (err) {
    return { kind: 'unreadable', problem: errorMessage(err) };
  }
}

function describeMarker(seen: SeenMarker, path: string, runId: string): string {
  const base = `run ${runId} has a marker (${path}), so nothing runs`;
  if (seen.kind === 'unreadable') return `${base}: it cannot be read (${seen.problem}): ${UNKNOWN_HINT}`;
  const m = seen.marker;
  switch (m.status) {
    case 'done':
      return `${base}: done at ${m.finishedAt ?? '?'}, ${m.amount} USDC to ${m.evmAddress} (withdraw ${short(m.report?.withdraw)}; NEAR ${txList(m.tx ?? [])}); unset ${ORDERLY_WITHDRAW_ENV}`;
    case 'failed':
      return `${base}: failed at ${m.finishedAt ?? '?'} (${m.error ?? 'no error kept'}); never retried: ${failureText(m.outcome)}`;
    default:
      return `${base}: started at ${m.startedAt} for ${m.amount} USDC with no outcome written: ${UNKNOWN_HINT}`;
  }
}

/** Creates `path` only when it does not exist, its content fsynced (a second writer fails with EEXIST). */
function createExclusive(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDir(dirname(path));
}

function short(v: unknown): string {
  return v === undefined ? '?' : JSON.stringify(v).slice(0, 160);
}

function txList(tx: TxRef[]): string {
  return tx.length === 0 ? 'none seen' : tx.map((t) => t.id).join(', ');
}
