// A one-shot Orderly withdrawal, asked for with GIMBAL_ORDERLY_WITHDRAW=<contract>/<desk>/<amount USDC>/<run-id> and run
// by serve only with GIMBAL_SETUP=1 (serve-setup.ts). It exists because Orderly takes the desk's key only from the
// engine's own IPs once an IP list is applied: no other machine can post the withdrawal, and the engine's control
// routes are loopback only. The money goes to the desk's own EVM address on Arbitrum (the contract signs no other
// receiver); tools/mainnet/hl-return.mjs `bridge` then brings it to the contract on NEAR.
//
//   1  a marker for this run-id in the state directory: log what it says, do nothing (at most once per run-id)
//   2  get_desk: the contract and desk are the engine's; a paused or closing desk stops here (operator path)
//   3  the operator's minimum and the hourly cap, then signed reads: every Orderly position flat, amount <= free USDC
//   4  marker `started` (fsynced before anything that moves money is signed)
//   5  OrderlyDeskClient.withdraw: settle_pnl, then withdraw_request
//   6  marker `done` with the report, or `failed` with the error; never retried
//
// A refusal in 1-3 writes no marker, so the same run-id runs once the cause is fixed. A `started` marker with no
// outcome (the process died in step 5) is an unknown outcome: nothing runs again for that run-id.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TxRef } from '@gimbal/shared';
import type { ContractClient, DeskView } from '../contract/types.ts';
import { fsyncDir, writeAtomic } from '../book/store.ts';
import type { OrderlyWithdrawReport } from '../venues/orderly-actions.ts';
import { OrderlyDeskClient } from '../venues/orderly-actions.ts';
import type { OrderlyNetwork } from '../venues/orderly-http.ts';
import type { OrderlySigner } from '../venues/orderly-signer.ts';
import { parseBalance, parseRestHolding, parseRestPositions } from '../venues/orderly-stream.ts';
import { errorMessage } from '../venues/recorder.ts';
import { collectingSigner } from './service.ts';

export const ORDERLY_WITHDRAW_ENV = 'GIMBAL_ORDERLY_WITHDRAW';
const PREFIX = 'orderly withdraw:';
const E6 = 1_000_000n;
/** The contract's floor for the operator's withdrawal: max(10 x max_transfer_cost_flat_e6, 10 USDC). */
const OPERATOR_MIN_FLOOR_E6 = 10n * E6;
const UNKNOWN_HINT = 'unknown outcome, check the desk EVM on Arbitrum and nearblocks; set a new run-id only after checking';

export interface OrderlyWithdrawAsk {
  contractId: string;
  deskId: string;
  /** Canonical USDC decimal (at most 6 decimals, no trailing zeros), as orderly_withdraw takes it. */
  amount: string;
  amountE6: bigint;
  runId: string;
}

/** Parses `<contract>/<desk>/<amount USDC>/<run-id>`; throws saying what is wrong. */
export function parseOrderlyWithdraw(value: string): OrderlyWithdrawAsk {
  const parts = value.trim().split('/');
  if (parts.length !== 4) throw new Error(`${ORDERLY_WITHDRAW_ENV} must be <contract>/<desk>/<amount USDC>/<run-id>, got ${parts.length} part(s)`);
  const [contractId, deskId, amountText, runId] = parts as [string, string, string, string];
  if (!/^[a-z0-9._-]{2,64}$/.test(contractId)) throw new Error(`${ORDERLY_WITHDRAW_ENV}: contract ${JSON.stringify(contractId)} is not a NEAR account id`);
  if (!/^[a-z0-9-]{1,32}$/.test(deskId)) throw new Error(`${ORDERLY_WITHDRAW_ENV}: desk ${JSON.stringify(deskId)} is not [a-z0-9-]{1,32}`);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(runId)) throw new Error(`${ORDERLY_WITHDRAW_ENV}: run-id ${JSON.stringify(runId)} is not [A-Za-z0-9_-]{1,40}`);
  const amountE6 = usdcE6(amountText);
  if (amountE6 === null || amountE6 <= 0n) {
    throw new Error(`${ORDERLY_WITHDRAW_ENV}: amount ${JSON.stringify(amountText)} is not a positive USDC amount with at most 6 decimals`);
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
  desk(): Promise<DeskView | null>;
  orderly(desk: DeskView): OrderlyWithdrawClient;
  /** The NEAR transactions of the contract's signatures so far (collectingSigner). */
  takeTx?: () => TxRef[];
  /** Whether the EIP-712 Withdraw was asked of the contract yet: from then on Orderly may hold the request. Absent: assumed yes. */
  withdrawSigned?: () => boolean;
  log(line: string): void;
  now?: () => number;
}

export type OrderlyWithdrawResult =
  | { status: 'marker'; marker: string; was: string }
  | { status: 'refused'; reason: string }
  | { status: 'done'; report: OrderlyWithdrawReport; tx: TxRef[] }
  | { status: 'failed'; error: string; withdrawSigned: boolean; tx: TxRef[] };

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
  withdrawSigned?: boolean;
  tx?: TxRef[];
}

export async function runOrderlyWithdraw(d: OrderlyWithdrawDeps): Promise<OrderlyWithdrawResult> {
  const { ask, engine } = d;
  const now = d.now ?? Date.now;
  const say = (line: string) => d.log(`${PREFIX} ${line}`);
  const refuse = (reason: string): OrderlyWithdrawResult => {
    say(`refused: ${reason}; nothing that moves money was signed and no marker was written: fix it and restart (the same run-id ${ask.runId} runs then), or unset ${ORDERLY_WITHDRAW_ENV}`);
    return { status: 'refused', reason };
  };
  const path = orderlyWithdrawMarker(d.stateDir, ask);

  // 1. At most once per run-id, across restarts.
  const seen = readMarker(path);
  if (seen !== null) {
    say(describeMarker(seen, path, ask.runId));
    return { status: 'marker', marker: path, was: seen.kind === 'ok' ? seen.marker.status : 'unreadable' };
  }
  say(`run ${ask.runId}: ${ask.amount} USDC from Orderly for desk ${ask.deskId} on ${ask.contractId}; no marker at ${path}, checking`);

  // 2. The desk, as the contract has it now.
  if (ask.contractId !== engine.contractId || ask.deskId !== engine.deskId) {
    return refuse(`it names ${ask.contractId}/${ask.deskId}, but this engine runs ${engine.contractId}/${engine.deskId} (GIMBAL_CONTRACT_ID, DESK_ID)`);
  }
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
  if (ask.amountE6 < min) {
    return refuse(`${ask.amount} USDC is under the operator's minimum of ${formatE6(min)} USDC (max(10 x max_transfer_cost_flat_e6, 10 USDC)); the desk needs at least that much free on Orderly`);
  }
  const capE6 = BigInt(Math.floor(desk.policy.rescue_cap_usd_per_hour)) * E6;
  if (ask.amountE6 > capE6) {
    return refuse(`${ask.amount} USDC is over the hourly rescue cap of ${formatE6(capE6)} USD, which the operator's withdrawal counts against: withdraw at most that per run-id, an hour apart`);
  }
  let client: OrderlyWithdrawClient;
  try {
    client = d.orderly(desk);
  } catch (err) {
    return refuse(`the desk's Orderly client: ${errorMessage(err)}`);
  }
  let free: { freeE6: bigint; holding: number; frozen: number };
  try {
    const positions = parseRestPositions(await client.positions('orderly withdraw: are all positions flat'));
    const open = positions.filter((p) => p.positionQty !== 0);
    if (open.length > 0) {
      return refuse(`Orderly positions are not flat (${open.map((p) => `${p.symbol} ${p.positionQty}`).join(', ')}): close them first`);
    }
    free = freeUsdc(await client.holding('orderly withdraw: free USDC'));
  } catch (err) {
    return refuse(`the signed Orderly reads failed: ${errorMessage(err)}`);
  }
  if (ask.amountE6 > free.freeE6) {
    return refuse(`${ask.amount} USDC is over the free USDC on Orderly, ${formatE6(free.freeE6)} (holding ${free.holding}, frozen ${free.frozen})`);
  }
  say(`checks passed: positions flat, free USDC ${formatE6(free.freeE6)}, operator minimum ${formatE6(min)}, hourly cap ${formatE6(capE6)}`);

  // 4. The marker goes down before anything that moves money is signed; an existing one (a race) stops here.
  const startedAt = new Date(now()).toISOString();
  const started: Marker = {
    status: 'started', contractId: ask.contractId, deskId: ask.deskId, runId: ask.runId, amount: ask.amount,
    evmAddress: client.evmAddress, startedAt,
  };
  try {
    createExclusive(path, `${JSON.stringify(started, null, 2)}\n`);
  } catch (err) {
    return refuse(`could not write the marker ${path}: ${errorMessage(err)}`);
  }
  say(`started: marker ${path}; settle_pnl, then a withdraw of ${ask.amount} USDC to ${client.evmAddress} on Arbitrum`);

  // 5 and 6. Exactly one attempt.
  const finish = (m: Marker) => {
    try {
      writeAtomic(path, `${JSON.stringify(m, null, 2)}\n`);
    } catch (err) {
      say(`could not write the outcome to ${path} (${errorMessage(err)}); it still says started, so this run-id never runs again`);
    }
  };
  try {
    const report = await client.withdraw(ask.amount, `orderly withdraw run ${ask.runId}`);
    const tx = d.takeTx?.() ?? [];
    finish({ ...started, status: 'done', finishedAt: new Date(now()).toISOString(), report, tx });
    say(`done: Orderly took the withdrawal of ${ask.amount} USDC to ${client.evmAddress} on Arbitrum (settle ${short(report.settled)}, withdraw ${short(report.withdraw)}; NEAR ${txList(tx)}). `
      + `Orderly takes its 1 USDC fee; the rest lands on Arbitrum within minutes. Next: unset ${ORDERLY_WITHDRAW_ENV}, then bridge it with hl-return.mjs`);
    return { status: 'done', report, tx };
  } catch (err) {
    const tx = [...(Array.isArray((err as { tx?: unknown }).tx) ? (err as { tx: TxRef[] }).tx : []), ...(d.takeTx?.() ?? [])];
    const withdrawSigned = d.withdrawSigned?.() ?? true;
    const error = errorMessage(err);
    finish({ ...started, status: 'failed', finishedAt: new Date(now()).toISOString(), error, withdrawSigned, tx });
    const where = withdrawSigned
      ? `the Withdraw went to the contract to be signed, so Orderly may have taken it: ${UNKNOWN_HINT}`
      : 'the contract never signed the Withdraw, so no USDC left Orderly (a settle_pnl only books PnL inside the account); set a new run-id to try again';
    say(`failed: ${error}; NEAR ${txList(tx)}; not retried: ${where}`);
    return { status: 'failed', error, withdrawSigned, tx };
  }
}

export interface OrderlyWithdrawStart {
  /** GIMBAL_ORDERLY_WITHDRAW as set (never undefined here: unset means this is not called). */
  value: string;
  network: OrderlyNetwork;
  /** The contract client on the operator key: get_desk and the Orderly signatures. */
  contract: Pick<ContractClient, 'getDesk'> & OrderlySigner;
  engine: OrderlyWithdrawDeps['engine'];
  orderlyUrl: string;
  stateDir: string;
  log(line: string): void;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Starts the run in the background and returns its promise (serve does not wait for it); null when the value
 * cannot be parsed, which is logged and changes nothing else in serve.
 */
export function startOrderlyWithdraw(o: OrderlyWithdrawStart): Promise<OrderlyWithdrawResult | null> | null {
  let ask: OrderlyWithdrawAsk;
  try {
    ask = parseOrderlyWithdraw(o.value);
  } catch (err) {
    o.log(`${PREFIX} ignored: ${errorMessage(err)}`);
    return null;
  }
  const collected = collectingSigner(o.contract);
  let withdrawAsked = false;
  const signer: OrderlySigner = {
    ...collected.signer,
    orderlyWithdraw: (deskId, amount, nonce) => {
      withdrawAsked = true;
      return collected.signer.orderlyWithdraw(deskId, amount, nonce);
    },
  };
  const run = runOrderlyWithdraw({
    ask, engine: o.engine, stateDir: o.stateDir, log: o.log,
    desk: () => o.contract.getDesk(ask.deskId),
    orderly: (desk) => {
      if (desk.orderly_account_id === undefined) throw new Error(`get_desk(${ask.deskId}) has no orderly_account_id`);
      return new OrderlyDeskClient({
        deskId: ask.deskId, network: o.network, apiUrl: o.orderlyUrl, accountId: desk.orderly_account_id,
        orderlyKey: `ed25519:${desk.solana.authority}`, evmAddress: desk.evm_address, referralCode: null, signer,
        ...(o.fetch === undefined ? {} : { fetch: o.fetch }), ...(o.now === undefined ? {} : { clock: { now: o.now } }),
      });
    },
    takeTx: collected.take,
    withdrawSigned: () => withdrawAsked,
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  return run.catch((err: unknown) => {
    o.log(`${PREFIX} stopped: ${errorMessage(err)}; if a marker says started: ${UNKNOWN_HINT}`);
    return null;
  });
}

/** max(10 x max_transfer_cost_flat_e6, 10 USDC), in units of 1e-6: the contract's E_SIZE floor for the operator. */
export function operatorMinE6(desk: Pick<DeskView, 'policy'>): bigint {
  const flat = BigInt(Math.max(0, Math.floor(desk.policy.max_transfer_cost_flat_e6)));
  const ten = 10n * flat;
  return ten > OPERATOR_MIN_FLOOR_E6 ? ten : OPERATOR_MIN_FLOOR_E6;
}

/** USDC holding - frozen from GET /v1/client/holding `data`; a missing USDC row is 0 (Orderly leaves empty tokens out). */
export function freeUsdc(data: unknown): { freeE6: bigint; holding: number; frozen: number } {
  const row = parseRestHolding(data).find(([token]) => token === 'USDC');
  if (row === undefined) return { freeE6: 0n, holding: 0, frozen: 0 };
  const b = parseBalance(row[1]);
  const freeE6 = BigInt(Math.round(b.holding * 1e6)) - BigInt(Math.round(b.frozen * 1e6));
  return { freeE6: freeE6 > 0n ? freeE6 : 0n, holding: b.holding, frozen: b.frozen };
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
      return `${base}: failed at ${m.finishedAt ?? '?'} (${m.error ?? 'no error kept'}); never retried: ${m.withdrawSigned === false ? 'the Withdraw was never signed, so set a new run-id to try again' : UNKNOWN_HINT}`;
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
