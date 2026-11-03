// The NEAR reads the rescue decides with: get_desk_counters as parsed (C10's DeskCountersView, absent before C10, and
// null only for a desk that exists), the fund_venue record read from the contract state, the rings' keys and bounds,
// a transaction's final outcome, the live reader asking everything at the block whose time it reports, and serve's
// GIMBAL_RESCUE_FRESH check: it names the desk, and is refused while the contract counted a rescue or a fund_venue in
// the last 65 min or the state directory shows a rescuer of the desk in that time (or no trace at all, until 65 min
// after the first refused FRESH).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { NearRpc } from '../contract/near-transport.ts';
import {
  CANARY_COUNTERS_BYTES, DESK_COUNTERS_PREFIX, FINAL_COUNTERS_BYTES, FUND_COUNTERS_PREFIX, NearDeskReads, SimulatedNear, decodeCountersRecord, depositKey,
  deskRecordKey, parseDeskCounters, recentRescue, ringEntry, ringHolds, txFactsOf,
} from './near-chain.ts';
import type { NearDeskCounters, NearRead } from './near-chain.ts';
import { freshStart } from './serve-rescue.ts';
import type { RescueIdentity } from './state.ts';
import { freshEvidence, rescueStateFile } from './state.ts';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const EVM_DEPOSIT = '0xAbCdEf0000000000000000000000000000001234';
const SOL_DEPOSIT = 'So1aNaDepoSiTAddre55111111111111111111111';
const NEAR_DEPOSIT = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
const EMPTY = (): NearDeskCounters => ({ eip3009Next: 0n, rescueAtMs: 0, deposits: [], depositPaidMs: [] });

/** A DeskCountersView as the contract's JSON gives it: 32 slots, numbers as JSON numbers. */
function view(over: Record<string, unknown> = {}) {
  const deposits: (string | null)[] = Array.from({ length: 32 }, () => null);
  const paid: number[] = Array.from({ length: 32 }, () => 0);
  deposits[0] = sha(EVM_DEPOSIT.toLowerCase());
  paid[0] = 1_793_000_000_000;
  return { eip3009_next: 3, rescue_at_ms: 1_793_000_000_000, deposits, deposit_paid_ms: paid, deposit_next: 1, rescued_e8: 0, ...over };
}

/**
 * A DeskCounters record in the final (C10) layout, with `slots` [sha256 hex, paid ms] from slot 0: what the
 * synthetic cases below need. The layouts themselves are pinned by the contract's own bytes (FIXTURE).
 */
function record(o: { at?: number; next?: bigint; slots?: [string, number][] } = {}): Buffer {
  const b = Buffer.alloc(FINAL_COUNTERS_BYTES);
  b.writeBigUInt64LE(BigInt(o.at ?? 0), 0);
  b.writeBigUInt64LE(o.next ?? 0n, 56);
  (o.slots ?? []).forEach(([hex, ms], i) => {
    Buffer.from(hex, 'hex').copy(b, 64 + 32 * i);
    b.writeBigUInt64LE(BigInt(ms), 1089 + 8 * i);
  });
  b.writeUInt8((o.slots ?? []).length % 32, 1088);
  return b;
}

/** DeskCounters records the contract wrote: the canary's from mainnet (C8), and the final layout's (C10). */
const FIXTURE = JSON.parse(readFileSync(new URL('../../fixtures/near/counters-records.json', import.meta.url), 'utf8')) as {
  canary: { contract: string; desk: string; block: number; deskCounters: { key: string; value: string }; fundCounters: { key: string; value: string } };
  final: { record: string };
};
/** The canary's fund_venue transaction, as EXPERIMENTAL_tx_status answered it. */
const FUND_TX = JSON.parse(readFileSync(new URL('../../fixtures/near/fund-venue-tx-mainnet.json', import.meta.url), 'utf8')) as { result: Record<string, unknown> };
const FUND_TX_DEPOSIT = '9b89bab2bd8b66704184328bb4d47483b93ad0da2d2ec89ddd19c1bf44a5fb31';

test('parseDeskCounters: C10\'s view; null (no counters record) and a bad shape are errors, never an empty ring', () => {
  const c = parseDeskCounters(view());
  assert.equal(c.eip3009Next, 3n);
  assert.equal(c.rescueAtMs, 1_793_000_000_000);
  assert.equal(c.deposits.length, 32);
  assert.equal(c.deposits[0], sha(EVM_DEPOSIT.toLowerCase()));
  assert.equal(c.deposits[1], null);
  assert.equal(parseDeskCounters(view({ eip3009_next: '18446744073709551615' })).eip3009Next, 18_446_744_073_709_551_615n, 'a u64 past 2^53 as a string');
  assert.equal(parseDeskCounters(view({ deposits: [sha('x').toUpperCase()], deposit_paid_ms: [5] })).deposits[0], sha('x'), 'hex read in lowercase');
  assert.throws(() => parseDeskCounters(null), /answered null/);
  for (const [bad, why] of [
    ['x', /not an object/],
    [view({ eip3009_next: -1 }), /eip3009_next/],
    [view({ eip3009_next: 1.5 }), /eip3009_next/],
    [view({ rescue_at_ms: '-3' }), /rescue_at_ms/],
    [view({ deposits: [null], deposit_paid_ms: [] }), /two lists of one length/],
    [view({ deposits: 'none' }), /two lists/],
    [view({ deposits: ['abc'], deposit_paid_ms: [1] }), /deposits\[0\] is not sha256 hex/],
    [view({ deposits: [null], deposit_paid_ms: [2 ** 60] }), /deposit_paid_ms\[0\]/],
  ] as const) assert.throws(() => parseDeskCounters(bad), why);
});

test('decodeCountersRecord: the contract\'s borsh DeskCounters in both layouts, by length (C8 1329, C10 1369), zero hashes as empty slots; any other size is an error', () => {
  // The final layout, as the contract test counters_record_bytes_are_the_engine_fixture serializes it.
  const fin = Buffer.from(FIXTURE.final.record, 'base64');
  assert.equal(fin.length, FINAL_COUNTERS_BYTES);
  const c = decodeCountersRecord(fin);
  assert.equal(c.rescueAtMs, 1_793_460_600_000);
  assert.equal(c.eip3009Next, 7n, 'after rescue_quote_e8');
  assert.equal(c.deposits.length, 32);
  assert.deepEqual(c.deposits.slice(0, 3), [sha('0x00000000000000000000000000000000000000d1'), sha('0x00000000000000000000000000000000000000d2'), null]);
  assert.deepEqual(c.depositPaidMs.slice(0, 3), [1_793_460_540_000, 1_793_460_600_000, 0], 'before the notional meter');
  assert.deepEqual(c.depositPaidMs.slice(2), Array.from({ length: 30 }, () => 0));
  // The canary (C8) as mainnet holds it: its rescue ring (two hl rescues signed) and its fund_venue ring (one funding).
  const desk = decodeCountersRecord(Buffer.from(FIXTURE.canary.deskCounters.value, 'base64'));
  assert.equal(Buffer.from(FIXTURE.canary.deskCounters.value, 'base64').length, CANARY_COUNTERS_BYTES);
  assert.equal(desk.eip3009Next, 2n);
  assert.equal(desk.rescueAtMs, 1_793_670_925_206);
  assert.deepEqual(desk.depositPaidMs.slice(0, 3), [1_793_670_752_854, 1_793_670_925_206, 0]);
  assert.equal(desk.deposits.filter((d) => d !== null).length, 2);
  const fund = decodeCountersRecord(Buffer.from(FIXTURE.canary.fundCounters.value, 'base64'));
  assert.equal(fund.rescueAtMs, 1_793_570_943_206);
  assert.deepEqual(ringEntry(fund, depositKey('fund_venue', FUND_TX_DEPOSIT)), { paidMs: 1_793_570_943_206 }, 'its funding\'s deposit address (the recorded fund_venue)');
  assert.equal(fund.deposits.filter((d) => d !== null).length, 1);
  // The keys: the StorageKey byte and the desk id as a borsh string.
  assert.equal(deskRecordKey(DESK_COUNTERS_PREFIX, FIXTURE.canary.desk).toString('base64'), FIXTURE.canary.deskCounters.key);
  assert.equal(deskRecordKey(FUND_COUNTERS_PREFIX, FIXTURE.canary.desk).toString('base64'), FIXTURE.canary.fundCounters.key);
  assert.deepEqual(deskRecordKey(FUND_COUNTERS_PREFIX, 'canary'), Buffer.from([8, 6, 0, 0, 0, ...Buffer.from('canary')]));
  for (const n of [0, 1328, 1330, 1368, 1370]) assert.throws(() => decodeCountersRecord(Buffer.alloc(n)), new RegExp(`is ${n} bytes, neither 1329 \\(C8\\) nor 1369 \\(C10\\)`), String(n));
});

test('depositKey: the bytes the contract hashes; EVM addresses (Arbitrum and Hyperliquid routes) in lowercase, Solana and NEAR as given', () => {
  assert.equal(depositKey('evm_usdc_to_intents', EVM_DEPOSIT), sha(EVM_DEPOSIT.toLowerCase()));
  assert.equal(depositKey('hl_send_to_intents', EVM_DEPOSIT), sha(EVM_DEPOSIT.toLowerCase()));
  assert.equal(depositKey('sol_sign_rescue', SOL_DEPOSIT), sha(SOL_DEPOSIT));
  assert.notEqual(depositKey('sol_sign_rescue', SOL_DEPOSIT), sha(SOL_DEPOSIT.toLowerCase()), 'base58 is case-sensitive');
  assert.equal(depositKey('fund_venue', NEAR_DEPOSIT), sha(NEAR_DEPOSIT));
});

test('ringEntry and ringHolds: an address in the ring with its paid time; the ring proves absence only while some slot is empty or older than the hold', () => {
  const c = parseDeskCounters(view());
  assert.deepEqual(ringEntry(c, depositKey('evm_usdc_to_intents', EVM_DEPOSIT)), { paidMs: 1_793_000_000_000 });
  assert.equal(ringEntry(c, depositKey('evm_usdc_to_intents', '0x00000000000000000000000000000000000000d1')), null);
  assert.equal(ringHolds(c, 1_793_000_000_000), true, 'empty slots');
  assert.equal(ringHolds(EMPTY(), 0), true, 'a desk with no record: nothing was ever paid');
  const full: NearDeskCounters = { eip3009Next: 0n, rescueAtMs: 0, deposits: Array.from({ length: 32 }, (_, i) => sha(String(i))), depositPaidMs: Array.from({ length: 32 }, (_, i) => 1_000 + i) };
  assert.equal(ringHolds(full, 1_000), false, 'every slot written at or after the hold: the address may have been pushed out');
  assert.equal(ringHolds(full, 1_001), true, 'slot 0 is older than the hold: nothing paid since was pushed out');
  // The simulated rings turn over in order, as the contract's do, each on its own.
  const near = new SimulatedNear({ now: () => 5_000 });
  near.spend('evm_usdc_to_intents', EVM_DEPOSIT, 10);
  for (let i = 0; i < 32; i++) near.spend('sol_sign_rescue', `S${i}`, 20 + i);
  assert.equal(near.deposits.includes(depositKey('evm_usdc_to_intents', EVM_DEPOSIT)), false, 'pushed out by 32 later rescues');
  assert.equal(near.eip3009Next, 1n, 'only an EIP-3009 signature moves the counter');
  assert.equal(near.rescueAtMs, 51);
  near.fundSpend(NEAR_DEPOSIT, 60);
  assert.equal(near.rescueAtMs, 51, 'fund_venue never touches the rescues\' record');
});

test('recentRescue: a rescue or a fund_venue counted under 65 min before the block refuses a fresh start; an unreadable fund_venue ring refuses too', async () => {
  const at = 1_793_000_000_000;
  const read = (timeMs: number, counters: NearDeskCounters | null, fund: NearDeskCounters | null = EMPTY()): NearRead => ({ height: 190_000_000, timeMs, counters, fund, fundError: fund === null ? 'view_state: too large' : null });
  const c = parseDeskCounters(view());
  assert.match(recentRescue(read(at + 64 * 60_000, c)) ?? '', /counted a rescue of this desk at 2026-\S+Z, under 65 min before NEAR block 190000000/);
  assert.equal(recentRescue(read(at + 65 * 60_000, c)), null);
  assert.equal(recentRescue(read(at, EMPTY())), null, 'never rescued');
  assert.equal(recentRescue(read(at, null)), null, 'no view: serve warns instead');
  // An hl_withdraw counts in rescue_at_ms without a ring slot.
  assert.ok(recentRescue(read(at + 10 * 60_000, { ...EMPTY(), rescueAtMs: at })) !== null);
  // fund_venue rescues touch only their own record.
  const fund = decodeCountersRecord(record({ at, slots: [[sha(NEAR_DEPOSIT), at]] }));
  assert.match(recentRescue(read(at + 30 * 60_000, EMPTY(), fund)) ?? '', /counted a fund_venue of this desk/);
  assert.match(recentRescue(read(at + 30 * 60_000, null, fund)) ?? '', /fund_venue/, 'read before C10 too');
  assert.match(recentRescue(read(at, EMPTY(), null)) ?? '', /fund_venue ring on NEAR could not be read \(view_state: too large\)/);
});

/** The recorded fund_venue outcome, each receipt changed by `edit(method, outcome)` (method: what the receipt called). */
function fundTx(edit: (method: string | undefined, o: { status: unknown; logs: string[] }) => void = () => {}): Record<string, unknown> {
  const r = JSON.parse(JSON.stringify(FUND_TX.result)) as {
    receipts: { receipt_id: string; receipt: { Action?: { actions: { FunctionCall?: { method_name: string } }[] } } }[];
    receipts_outcome: { id: string; outcome: { status: unknown; logs: string[] } }[];
  };
  const method = new Map(r.receipts.map((x) => [x.receipt_id, x.receipt.Action?.actions[0]?.FunctionCall?.method_name]));
  for (const o of r.receipts_outcome) edit(method.get(o.id), o.outcome);
  return r as unknown as Record<string, unknown>;
}

test('txFactsOf on the canary\'s recorded fund_venue: paid to its deposit address, no proof of no payment; proof only from a failed call, a failed ft_transfer receipt or on_fund_venue false', () => {
  const C = 'gimbal-canary2.near';
  assert.deepEqual(txFactsOf(FUND_TX.result, C), { final: true, paidTo: [FUND_TX_DEPOSIT], noPay: null });
  // The transfer failed: its receipt fails, its event is gone, on_fund_venue answers false.
  const failedTransfer = txFactsOf(fundTx((m, o) => {
    if (m === 'ft_transfer') {
      o.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: The account doesn\'t have enough balance' } } } } };
      o.logs = [];
    }
    if (m === 'on_fund_venue') o.status = { SuccessValue: Buffer.from('false').toString('base64') };
  }), C);
  assert.deepEqual(failedTransfer.paidTo, []);
  assert.match(failedTransfer.noPay ?? '', /its USDC ft_transfer receipt \S+ failed .*; on_fund_venue returned false: the transfer failed and the USDC is back in idle_usdc/);
  // on_fund_venue false alone is proof too.
  assert.match(txFactsOf(fundTx((m, o) => { if (m === 'on_fund_venue') o.status = { SuccessValue: Buffer.from('false').toString('base64') }; }), C).noPay ?? '', /^on_fund_venue returned false/);
  // The call itself refused (E_SIZE): nothing counted or sent.
  const refused = txFactsOf(fundTx((m, o) => {
    if (m === 'fund_venue') o.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_SIZE' } } } } };
    else { o.status = { SuccessValue: '' }; o.logs = []; }
  }), C);
  assert.match(refused.noPay ?? '', /^the fund_venue call failed .*E_SIZE.*: the contract refused it, so nothing was counted or sent$/);
  // No transfer log and no proof (a log the RPC left out, a receipt not shown): no proof at all, never "unpaid".
  const silent = txFactsOf(fundTx((_m, o) => { o.logs = []; }), C);
  assert.deepEqual(silent, { final: true, paidTo: [], noPay: null });
  // A transfer of any amount to any account is listed; a failed receipt's events are not.
  const odd = txFactsOf(fundTx((m, o) => {
    if (m === 'ft_transfer') o.logs = [o.logs[0]!.replace('"amount":"12000000"', '"amount":"1"')];
    if (m === 'storage_deposit') { o.status = { Failure: {} }; o.logs = [`EVENT_JSON:${JSON.stringify({ standard: 'nep141', event: 'ft_transfer', data: [{ new_owner_id: 'other.near', amount: '5' }] })}`]; }
  }), C);
  assert.deepEqual(odd.paidTo, [FUND_TX_DEPOSIT]);
  // Another contract's receipts prove nothing for this one.
  assert.equal(txFactsOf(fundTx((m, o) => { if (m === 'on_fund_venue') o.status = { SuccessValue: Buffer.from('false').toString('base64') }; }), 'other.near').noPay, null);
  assert.equal(txFactsOf({ ...FUND_TX.result, final_execution_status: 'EXECUTED_OPTIMISTIC' }, C).final, false);
  assert.throws(() => txFactsOf({ final_execution_status: 'FINAL' }, C), /no receipts_outcome/);
  assert.throws(() => txFactsOf({ final_execution_status: 'FINAL', receipts_outcome: [] }, C), /no receipts \(EXPERIMENTAL_tx_status gives them\)/);
});

test('the live reader: everything at the final block\'s height; a null view is an empty ring only for a desk that exists; no such method (before C10) is no counters', async () => {
  const calls: unknown[] = [];
  let answer: () => unknown = () => view();
  let desk: unknown = { owner: 'o.near' };
  const row = (prefix: number, value: Buffer) => ({ key: deskRecordKey(prefix, 'canary').toString('base64'), value: value.toString('base64') });
  let records: Record<number, Buffer | null> = { [DESK_COUNTERS_PREFIX]: record(), [FUND_COUNTERS_PREFIX]: record({ at: 5, slots: [[sha(NEAR_DEPOSIT), 5]] }) };
  let state: (prefix: number) => unknown = (prefix) => ({ values: records[prefix] === null || records[prefix] === undefined ? [] : [row(prefix, records[prefix]!)] });
  const provider = {
    viewBlock: async (q: unknown) => {
      calls.push(['block', q]);
      return { header: { height: 190_000_123, timestamp_nanosec: '1793000123456789012' } };
    },
    callFunction: async (q: { method: string }) => {
      calls.push(['call', q]);
      return q.method === 'get_desk' ? desk : answer();
    },
    query: async (q: { prefix_base64: string }) => {
      calls.push(['state', q]);
      return state(Buffer.from(q.prefix_base64, 'base64')[0]!);
    },
    viewTransactionStatusWithReceipts: async (q: unknown) => {
      calls.push(['tx', q]);
      return FUND_TX.result;
    },
  } as unknown as NearRpc;
  const reads = new NearDeskReads({ network: 'mainnet', provider, contractId: 'gimbal-canary2.near', deskId: 'canary', signerId: 'operator.near' });
  const r = await reads.read();
  assert.equal(r.height, 190_000_123);
  assert.equal(r.timeMs, 1_793_000_123_456);
  assert.equal(r.counters?.eip3009Next, 3n);
  assert.equal(r.fund?.deposits[0], sha(NEAR_DEPOSIT));
  assert.equal(r.fundError, null);
  assert.deepEqual(calls, [
    ['block', { finality: 'final' }],
    ['call', { contractId: 'gimbal-canary2.near', method: 'get_desk_counters', args: { desk_id: 'canary' }, blockQuery: { blockId: 190_000_123 } }],
    ['state', { request_type: 'view_state', account_id: 'gimbal-canary2.near', prefix_base64: deskRecordKey(5, 'canary').toString('base64'), block_id: 190_000_123 }],
    ['state', { request_type: 'view_state', account_id: 'gimbal-canary2.near', prefix_base64: deskRecordKey(8, 'canary').toString('base64'), block_id: 190_000_123 }],
  ]);
  answer = () => null;
  calls.length = 0;
  assert.deepEqual((await reads.read()).counters?.deposits, [], 'a desk with no counters yet');
  assert.deepEqual(calls[2], ['call', { contractId: 'gimbal-canary2.near', method: 'get_desk', args: { desk_id: 'canary' }, blockQuery: { blockId: 190_000_123 } }], 'get_desk at the same block');
  // The canary's own records (C8 layout), as mainnet holds them.
  answer = () => view();
  records = { [DESK_COUNTERS_PREFIX]: Buffer.from(FIXTURE.canary.deskCounters.value, 'base64'), [FUND_COUNTERS_PREFIX]: Buffer.from(FIXTURE.canary.fundCounters.value, 'base64') };
  assert.equal((await reads.read()).fund?.rescueAtMs, 1_793_570_943_206);
  // A missing fund_venue record is never an empty ring: write_desk stores both; nor is a missing DeskCounters record.
  records = { [DESK_COUNTERS_PREFIX]: record(), [FUND_COUNTERS_PREFIX]: null };
  assert.match((await reads.read()).fundError ?? '', /has the desk's DeskCounters but no fund_venue record at block 190000123: write_desk stores both/);
  records = { [DESK_COUNTERS_PREFIX]: null, [FUND_COUNTERS_PREFIX]: null };
  assert.match((await reads.read()).fundError ?? '', /no DeskCounters record of desk canary at block 190000123 \(no such desk, or a key encoding this reader does not know\)/);
  records = { [DESK_COUNTERS_PREFIX]: Buffer.from(FIXTURE.canary.deskCounters.value, 'base64'), [FUND_COUNTERS_PREFIX]: record() };
  assert.match((await reads.read()).fundError ?? '', /DeskCounters record is 1329 bytes and its fund_venue record 1369: not one layout/);
  records = { [DESK_COUNTERS_PREFIX]: Buffer.alloc(1400), [FUND_COUNTERS_PREFIX]: Buffer.alloc(1400) };
  assert.match((await reads.read()).fundError ?? '', /1400 bytes, neither 1329/);
  records = { [DESK_COUNTERS_PREFIX]: record(), [FUND_COUNTERS_PREFIX]: record({ at: 5, slots: [[sha(NEAR_DEPOSIT), 5]] }) };
  answer = () => null;
  desk = { owner: 'o.near' };
  desk = null;
  await assert.rejects(reads.read(), /the contract gimbal-canary2\.near has no desk canary/);
  answer = () => { throw new Error('wasm execution failed with error: MethodResolveError(MethodNotFound)'); };
  assert.equal((await reads.read()).counters, null);
  answer = () => { throw new Error('connect ECONNREFUSED'); };
  await assert.rejects(reads.read(), /ECONNREFUSED/);
  answer = () => view({ deposits: [1], deposit_paid_ms: [1] });
  await assert.rejects(reads.read(), /deposits\[0\] is not sha256 hex/);
  answer = () => view();
  records = { [DESK_COUNTERS_PREFIX]: record(), [FUND_COUNTERS_PREFIX]: record() };
  assert.deepEqual((await reads.read()).fund?.deposits, Array.from({ length: 32 }, () => null), 'no fund_venue yet: the stored record is empty');
  // An account whose state is over about 50 kB: the RPC refuses view_state, and the ring is unreadable (fails closed).
  state = () => { throw new Error('State of contract is too large to be viewed'); };
  const down = await reads.read();
  assert.equal(down.fund, null);
  assert.match(down.fundError ?? '', /too large/);
  assert.equal(down.counters?.eip3009Next, 3n, 'the rest is still read');
  calls.length = 0;
  assert.deepEqual(await reads.txFacts('Hash1'), { final: true, paidTo: [FUND_TX_DEPOSIT], noPay: null }, 'read with its receipts, for gimbal-canary2.near');
  assert.deepEqual(calls, [['tx', { txHash: 'Hash1', accountId: 'operator.near', waitUntil: 'FINAL' }]]);
  await assert.rejects(new NearDeskReads({ network: 'mainnet', provider, contractId: 'c.near', deskId: 'd' }).txFacts('h'), /no signer account/);
});

test('GIMBAL_RESCUE_FRESH: only the desk\'s own <contract>/<desk>; refused while NEAR shows a payment of the last 65 min, or the state dir a rescuer of the desk; no trace waits 65 min from the first ask', async () => {
  const want = 'gimbal-canary2.near/canary';
  const id: RescueIdentity = { contractId: 'gimbal-canary2.near', deskId: 'canary', evm: '0x1a642f0e3c3af545e7acbd38b07251b3990914f1' };
  const at = 1_793_000_000_000;
  const now = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-fresh-'));
  const ev = () => freshEvidence(dir, 'mainnet', id);
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const quiet = async (): Promise<NearRead> => ({ height: 1, timeMs: at + 2 * 3_600_000, counters: parseDeskCounters(view()), fund: EMPTY(), fundError: null });
  let reads = 0;
  const counted = async () => {
    reads++;
    return quiet();
  };
  assert.equal(await freshStart(undefined, want, counted, log, ev(), now), false);
  assert.equal(await freshStart('', want, counted, log, ev(), now), false);
  for (const v of ['1', 'true', 'gimbal-canary2.near/other', 'gimbal-canary3.near/canary']) {
    lines.length = 0;
    assert.equal(await freshStart(v, want, counted, log, ev(), now), false, v);
    assert.match(lines.join('\n'), /is ignored: a first run is asked for by naming the desk, GIMBAL_RESCUE_FRESH=gimbal-canary2\.near\/canary/);
  }
  assert.equal(reads, 0, 'not asked: NEAR is not read');
  // On chain: refused first, whatever the directory shows.
  assert.equal(await freshStart(want, want, async () => ({ ...(await quiet()), timeMs: at + 30 * 60_000 }), log, ev(), now), false);
  assert.match(lines.at(-1)!, /GIMBAL_RESCUE_FRESH is refused: the contract counted a rescue of this desk at .* under 65 min before NEAR block 1/);
  const fund = decodeCountersRecord(record({ at: at + 7_000_000, slots: [[sha(NEAR_DEPOSIT), at + 7_000_000]] }));
  assert.equal(await freshStart(want, want, async () => ({ ...(await quiet()), fund }), log, ev(), now), false);
  assert.match(lines.at(-1)!, /refused: the contract counted a fund_venue of this desk/);
  assert.equal(await freshStart(want, want, async () => ({ ...(await quiet()), fund: null, fundError: 'rpc down' }), log, ev(), now), false);
  assert.match(lines.at(-1)!, /fund_venue ring on NEAR could not be read \(rpc down\)/);
  assert.equal(await freshStart(want, want, async () => { throw new Error('rpc down'); }, log, ev(), now), false);
  assert.match(lines.at(-1)!, /GIMBAL_RESCUE_FRESH is refused: the desk's counters on NEAR could not be read \(rpc down\)/);
  assert.equal(existsSync(join(dir, 'rescue-mainnet-gimbal-canary2.near-canary.fresh')), false, 'no marker for a chain refusal');

  // No trace: the first ask writes the marker and is refused; under 65 min after it, refused; then allowed, marker gone.
  const marker = join(dir, 'rescue-mainnet-gimbal-canary2.near-canary.fresh');
  assert.equal(await freshStart(want, want, quiet, log, ev(), now), false);
  assert.match(lines.at(-1)!, /holds no trace of when a rescuer of this desk last ran .* A marker was written now: start again with GIMBAL_RESCUE_FRESH=gimbal-canary2\.near\/canary after \S+, and run no rescuer of this desk anywhere until then/);
  assert.equal(existsSync(marker), true);
  assert.equal(await freshStart(want, want, quiet, log, ev(), now + 64 * 60_000), false);
  assert.match(lines.at(-1)!, /\.fresh was written at .* under 65 min ago/);
  utimesSync(marker, (now - 66 * 60_000) / 1000, (now - 66 * 60_000) / 1000);
  lines.length = 0;
  assert.equal(await freshStart(want, want, quiet, log, ev(), now), true);
  assert.deepEqual(lines, []);
  assert.equal(existsSync(marker), false, 'the marker is used once');

  // A state file of the desk under another EVM address (or a crash's temp file) written under 65 min ago refuses.
  const other = rescueStateFile(dir, 'mainnet', { ...id, evm: `0x${'22'.repeat(20)}` });
  writeFileSync(`${other}.123.tmp`, '{}');
  assert.equal(await freshStart(want, want, quiet, log, ev(), now), false);
  assert.match(lines.at(-1)!, /rescue-mainnet-gimbal-canary2\.near-canary-0x2{40}\.json\.123\.tmp was written at/);
  utimesSync(`${other}.123.tmp`, (now - 70 * 60_000) / 1000, (now - 70 * 60_000) / 1000);
  // Any file named with the desk's stem is a trace (a copy such as .json.bak too); another desk's files are not.
  const bak = `${rescueStateFile(dir, 'mainnet', id)}.bak`;
  writeFileSync(bak, '{}');
  assert.equal(await freshStart(want, want, quiet, log, ev(), now), false);
  assert.match(lines.at(-1)!, /rescue-mainnet-gimbal-canary2\.near-canary-0x1a642f0e3c3af545e7acbd38b07251b3990914f1\.json\.bak was written at/);
  utimesSync(bak, (now - 70 * 60_000) / 1000, (now - 70 * 60_000) / 1000);
  writeFileSync(rescueStateFile(dir, 'mainnet', { ...id, deskId: 'other' }), '{}');
  assert.equal(await freshStart(want, want, quiet, log, ev(), now), true);
  // A desk whose id extends this one's shares the stem: counted too, which only makes the wait longer.
  const longer = rescueStateFile(dir, 'mainnet', { ...id, deskId: 'canary-2' });
  writeFileSync(longer, '{}');
  assert.equal(await freshStart(want, want, quiet, log, ev(), now), false);
  utimesSync(longer, (now - 70 * 60_000) / 1000, (now - 70 * 60_000) / 1000);
  // Its own state file: the rescuer loads it (and says FRESH is ignored); NEAR is not read.
  writeFileSync(rescueStateFile(dir, 'mainnet', id), '{}');
  reads = 0;
  assert.equal(await freshStart(want, want, counted, log, ev(), now), true);
  assert.equal(reads, 0);
  // Before C10: allowed with a warning once the directory allows it.
  utimesSync(rescueStateFile(dir, 'mainnet', id), (now - 70 * 60_000) / 1000, (now - 70 * 60_000) / 1000);
  const before = mkdtempSync(join(tmpdir(), 'gimbal-fresh-'));
  const e = freshEvidence(before, 'mainnet', id);
  e.mark();
  utimesSync(join(before, 'rescue-mainnet-gimbal-canary2.near-canary.fresh'), (now - 70 * 60_000) / 1000, (now - 70 * 60_000) / 1000);
  lines.length = 0;
  assert.equal(await freshStart(want, want, async () => ({ ...(await quiet()), counters: null }), log, freshEvidence(before, 'mainnet', id), now), true);
  assert.match(lines.join('\n'), /no get_desk_counters yet, so a rescue of the last hour cannot be ruled out on chain here; reconcile by hand first/);
});
