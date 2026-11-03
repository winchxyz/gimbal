// The NEAR reads the rescue decides with: get_desk_counters as parsed (C10's DeskCountersView, and absent before C10),
// the deposit ring's keys and bounds, the live reader asking the view at the block whose time it reports, and serve's
// GIMBAL_RESCUE_FRESH check, which names the desk and refuses while the contract counted a rescue in the last hour.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { NearRpc } from '../contract/near-transport.ts';
import { NearDeskReads, SimulatedNear, depositKey, parseDeskCounters, recentRescue, ringEntry, ringHolds } from './near-chain.ts';
import type { NearDeskCounters, NearRead } from './near-chain.ts';
import { freshStart } from './serve-rescue.ts';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const EVM_DEPOSIT = '0xAbCdEf0000000000000000000000000000001234';
const SOL_DEPOSIT = 'So1aNaDepoSiTAddre55111111111111111111111';

/** A DeskCountersView as the contract's JSON gives it: 32 slots, numbers as JSON numbers. */
function view(over: Record<string, unknown> = {}) {
  const deposits: (string | null)[] = Array.from({ length: 32 }, () => null);
  const paid: number[] = Array.from({ length: 32 }, () => 0);
  deposits[0] = sha(EVM_DEPOSIT.toLowerCase());
  paid[0] = 1_793_000_000_000;
  return { eip3009_next: 3, rescue_at_ms: 1_793_000_000_000, deposits, deposit_paid_ms: paid, deposit_next: 1, rescued_e8: 0, ...over };
}

test('parseDeskCounters: C10\'s view; no counters yet reads as an empty ring; a bad shape is an error, never an empty ring', () => {
  const c = parseDeskCounters(view());
  assert.equal(c.eip3009Next, 3n);
  assert.equal(c.rescueAtMs, 1_793_000_000_000);
  assert.equal(c.deposits.length, 32);
  assert.equal(c.deposits[0], sha(EVM_DEPOSIT.toLowerCase()));
  assert.equal(c.deposits[1], null);
  assert.equal(parseDeskCounters(view({ eip3009_next: '18446744073709551615' })).eip3009Next, 18_446_744_073_709_551_615n, 'a u64 past 2^53 as a string');
  assert.equal(parseDeskCounters(view({ deposits: [sha('x').toUpperCase()], deposit_paid_ms: [5] })).deposits[0], sha('x'), 'hex read in lowercase');
  assert.deepEqual(parseDeskCounters(null), { eip3009Next: 0n, rescueAtMs: 0, deposits: [], depositPaidMs: [] });
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

test('depositKey: the bytes the contract hashes; EVM addresses (Arbitrum and Hyperliquid routes) in lowercase, Solana as given', () => {
  assert.equal(depositKey('evm_usdc_to_intents', EVM_DEPOSIT), sha(EVM_DEPOSIT.toLowerCase()));
  assert.equal(depositKey('hl_send_to_intents', EVM_DEPOSIT), sha(EVM_DEPOSIT.toLowerCase()));
  assert.equal(depositKey('sol_sign_rescue', SOL_DEPOSIT), sha(SOL_DEPOSIT));
  assert.notEqual(depositKey('sol_sign_rescue', SOL_DEPOSIT), sha(SOL_DEPOSIT.toLowerCase()), 'base58 is case-sensitive');
});

test('ringEntry and ringHolds: an address in the ring with its paid time; the ring proves absence only while some slot is empty or older than the hold', () => {
  const c = parseDeskCounters(view());
  assert.deepEqual(ringEntry(c, depositKey('evm_usdc_to_intents', EVM_DEPOSIT)), { paidMs: 1_793_000_000_000 });
  assert.equal(ringEntry(c, depositKey('evm_usdc_to_intents', '0x00000000000000000000000000000000000000d1')), null);
  assert.equal(ringHolds(c, 1_793_000_000_000), true, 'empty slots');
  const full: NearDeskCounters = { eip3009Next: 0n, rescueAtMs: 0, deposits: Array.from({ length: 32 }, (_, i) => sha(String(i))), depositPaidMs: Array.from({ length: 32 }, (_, i) => 1_000 + i) };
  assert.equal(ringHolds(full, 1_000), false, 'every slot written at or after the hold: the address may have been pushed out');
  assert.equal(ringHolds(full, 1_001), true, 'slot 0 is older than the hold: nothing paid since was pushed out');
  // The simulated ring turns over in order, as the contract's does.
  const near = new SimulatedNear({ now: () => 5_000 });
  near.spend('evm_usdc_to_intents', EVM_DEPOSIT, 10);
  for (let i = 0; i < 32; i++) near.spend('sol_sign_rescue', `S${i}`, 20 + i);
  assert.equal(near.deposits.includes(depositKey('evm_usdc_to_intents', EVM_DEPOSIT)), false, 'pushed out by 32 later rescues');
  assert.equal(near.eip3009Next, 1n, 'only an EIP-3009 signature moves the counter');
  assert.equal(near.rescueAtMs, 51);
});

test('recentRescue: a rescue counted under an hour before the block refuses a fresh start; older, none, or no view does not', () => {
  const at = 1_793_000_000_000;
  const read = (timeMs: number, counters: NearDeskCounters | null): NearRead => ({ height: 190_000_000, timeMs, counters });
  const c = parseDeskCounters(view());
  assert.match(recentRescue(read(at + 59 * 60_000, c)) ?? '', /counted a rescue of this desk at 2026-\S+Z, under 60 min before NEAR block 190000000/);
  assert.equal(recentRescue(read(at + 60 * 60_000, c)), null);
  assert.equal(recentRescue(read(at, parseDeskCounters(null))), null, 'never rescued');
  assert.equal(recentRescue(read(at, null)), null, 'no view: serve warns instead');
  // An hl_withdraw counts in rescue_at_ms without a ring slot.
  assert.ok(recentRescue(read(at + 10 * 60_000, { ...parseDeskCounters(null), rescueAtMs: at })) !== null);
});

test('the live reader: the final block\'s height and time, the view asked at that height; no such method (before C10) is no counters, other errors fail', async () => {
  const calls: unknown[] = [];
  let answer: () => unknown = () => view();
  const provider = {
    viewBlock: async (q: unknown) => {
      calls.push(['block', q]);
      return { header: { height: 190_000_123, timestamp_nanosec: '1793000123456789012' } };
    },
    callFunction: async (q: unknown) => {
      calls.push(['call', q]);
      return answer();
    },
  } as unknown as NearRpc;
  const reads = new NearDeskReads({ network: 'mainnet', provider, contractId: 'gimbal-canary2.near', deskId: 'canary' });
  const r = await reads.read();
  assert.equal(r.height, 190_000_123);
  assert.equal(r.timeMs, 1_793_000_123_456);
  assert.equal(r.counters?.eip3009Next, 3n);
  assert.deepEqual(calls, [
    ['block', { finality: 'final' }],
    ['call', { contractId: 'gimbal-canary2.near', method: 'get_desk_counters', args: { desk_id: 'canary' }, blockQuery: { blockId: 190_000_123 } }],
  ]);
  answer = () => null;
  assert.deepEqual((await reads.read()).counters?.deposits, [], 'a desk with no counters yet');
  answer = () => { throw new Error('wasm execution failed with error: MethodResolveError(MethodNotFound)'); };
  assert.equal((await reads.read()).counters, null);
  answer = () => { throw new Error('connect ECONNREFUSED'); };
  await assert.rejects(reads.read(), /ECONNREFUSED/);
  answer = () => view({ deposits: [1], deposit_paid_ms: [1] });
  await assert.rejects(reads.read(), /deposits\[0\] is not sha256 hex/);
});

test('GIMBAL_RESCUE_FRESH: only the desk\'s own <contract>/<desk> asks; refused while the counters cannot be read or a rescue was counted in the last hour', async () => {
  const want = 'gimbal-canary2.near/canary';
  const at = 1_793_000_000_000;
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const ok = async (): Promise<NearRead> => ({ height: 1, timeMs: at + 2 * 3_600_000, counters: parseDeskCounters(view()) });
  let reads = 0;
  const counted = async () => {
    reads++;
    return ok();
  };
  assert.equal(await freshStart(undefined, want, counted, log), false);
  assert.equal(await freshStart('', want, counted, log), false);
  assert.equal(reads, 0, 'not asked: NEAR is not read');
  for (const v of ['1', 'true', 'gimbal-canary2.near/other', 'gimbal-canary3.near/canary']) {
    lines.length = 0;
    assert.equal(await freshStart(v, want, counted, log), false, v);
    assert.match(lines.join('\n'), /is ignored: a first run is asked for by naming the desk, GIMBAL_RESCUE_FRESH=gimbal-canary2\.near\/canary/);
  }
  assert.equal(reads, 0);
  lines.length = 0;
  assert.equal(await freshStart(want, want, ok, log), true);
  assert.deepEqual(lines, []);
  assert.equal(await freshStart(want, want, async () => ({ height: 1, timeMs: at + 30 * 60_000, counters: parseDeskCounters(view()) }), log), false);
  assert.match(lines.at(-1)!, /GIMBAL_RESCUE_FRESH is refused: the contract counted a rescue of this desk at .* under 60 min before NEAR block 1/);
  assert.equal(await freshStart(want, want, async () => { throw new Error('rpc down'); }, log), false);
  assert.match(lines.at(-1)!, /GIMBAL_RESCUE_FRESH is refused: the desk's counters on NEAR could not be read \(rpc down\)/);
  lines.length = 0;
  assert.equal(await freshStart(want, want, async () => ({ height: 1, timeMs: at, counters: null }), log), true, 'before C10: allowed, with a warning');
  assert.match(lines.join('\n'), /no get_desk_counters yet, so a rescue of the last hour cannot be ruled out here; reconcile by hand first/);
});
