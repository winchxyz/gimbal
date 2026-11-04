// GIMBAL_ORDERLY_WITHDRAW: the one-shot Orderly withdrawal serve runs under GIMBAL_SETUP=1. Every refusal leaves no
// marker and signs nothing that moves money; a run that started never runs again for its run-id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NearTransport } from '../contract/near-client.ts';
import type { DeskView } from '../contract/types.ts';
import { ContractRefusal } from '../contract/types.ts';
import { ReplayContractClient } from '../contract/replay-client.ts';
import { stubFetch, TEST_CONFIG, TEST_EVM_ADDRESS, TEST_EVM_KEY, TEST_SOL_SEED, testDesk } from '../relayer/test-helpers.ts';
import type { StubCall } from '../relayer/test-helpers.ts';
import type { OrderlyWithdrawReport } from '../venues/orderly-actions.ts';
import type { OrderlySigner } from '../venues/orderly-signer.ts';
import type { OrderlyWithdrawClient, OrderlyWithdrawDeps, OrderlyWithdrawStart } from './orderly-withdraw.ts';
import {
  formatE6, freeUsdc, hourlyRoom, operatorMinE6, orderlyWithdrawMarker, parseOrderlyWithdraw, runOrderlyWithdraw, startOrderlyWithdraw, withdrawable,
} from './orderly-withdraw.ts';
import { setupFromEnv } from './serve-setup.ts';

const NOW = Date.UTC(2026, 10, 4, 12);
const CONTRACT = 'gimbal_dex.near';
const DESK = 'carry';
const OPERATOR = 'owner.near';
const ACCOUNT = `0x${'5e'.repeat(32)}`;
const ORDERLY = 'https://api.orderly.org';
const ENGINE = { contractId: CONTRACT, deskId: DESK, operatorAccount: OPERATOR };
const REPORT: OrderlyWithdrawReport = { settleNonce: 17, withdrawNonce: 41, settled: { settle_pnl_id: 3 }, withdraw: { withdraw_id: 9 } };

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-orderly-withdraw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (data: unknown) => ({ success: true, data, timestamp: NOW });
const row = (symbol: string, qty: number, unsettled = 0) => ({
  symbol, position_qty: qty, cost_position: 0, last_sum_unitary_funding: 0, average_open_price: 0, est_liq_price: 0, unsettled_pnl: unsettled,
});
const flat = { rows: [row('PERP_ETH_USDC', 0)] };
const holding = (h: number, frozen = 0) => ({ holding: [{ token: 'USDC', holding: h, frozen }] });
const own = () => testDesk({ owner: OPERATOR, operator: OPERATOR, orderly_account_id: ACCOUNT });

/** A fake desk client: what it reads, and what withdraw() does; `calls` lists every call. */
function fakeClient(o: { positions?: unknown; holding?: unknown; beforeHolding?: () => Promise<void>; withdraw?: () => Promise<OrderlyWithdrawReport> } = {}) {
  const calls: string[] = [];
  const client: OrderlyWithdrawClient = {
    evmAddress: TEST_EVM_ADDRESS,
    positions: async () => { calls.push('positions'); return o.positions ?? flat; },
    holding: async () => { calls.push('holding'); await o.beforeHolding?.(); return o.holding ?? holding(25); },
    withdraw: async (amount) => { calls.push(`withdraw:${amount}`); return (o.withdraw ?? (async () => REPORT))(); },
  };
  return { client, calls };
}

function deps(stateDir: string, o: {
  value?: string; desk?: DeskView | null; client?: OrderlyWithdrawClient; counters?: unknown; autoOn?: (() => boolean) | null; withdrawPosted?: () => boolean;
} = {}): { d: OrderlyWithdrawDeps; lines: string[]; deskReads: () => number } {
  const lines: string[] = [];
  let reads = 0;
  const d: OrderlyWithdrawDeps = {
    ask: parseOrderlyWithdraw(o.value ?? `${CONTRACT}/${DESK}/12/run-1`),
    engine: ENGINE, stateDir,
    desk: async () => { reads++; return o.desk === undefined ? own() : o.desk; },
    counters: async () => (o.counters === undefined ? null : o.counters),
    orderly: () => o.client ?? fakeClient().client,
    takeTx: () => [{ chain: 'near', id: 'nearTxA', url: 'https://nearblocks.io/txns/nearTxA' }],
    log: (line) => lines.push(line),
    now: () => NOW,
    ...(o.autoOn === null ? {} : { autoOn: o.autoOn ?? (() => false) }),
    ...(o.withdrawPosted === undefined ? {} : { withdrawPosted: o.withdrawPosted }),
  };
  return { d, lines, deskReads: () => reads };
}

const marker = (dir: string, runId = 'run-1') => orderlyWithdrawMarker(dir, { contractId: CONTRACT, deskId: DESK, runId });
const readMarker = (dir: string, runId = 'run-1') => JSON.parse(readFileSync(marker(dir, runId), 'utf8')) as Record<string, unknown>;
const tick = () => new Promise((r) => setImmediate(r));

/** Orderly as the stubs answer it; `gate` holds the withdraw_request's answer until released. */
function orderlyApi(o: { withdrawAnswer?: () => unknown; gate?: Promise<void> } = {}) {
  const api = stubFetch((call: StubCall) => {
    switch (new URL(call.url).pathname) {
      case '/v1/positions': return ok(flat);
      case '/v1/client/holding': return ok(holding(30));
      case '/v1/settle_nonce': return ok({ settle_nonce: '17' });
      case '/v1/settle_pnl': return ok({ settle_pnl_id: 3 });
      case '/v1/withdraw_nonce': return ok({ withdraw_nonce: '41' });
      case '/v1/withdraw_request': return o.withdrawAnswer?.() ?? ok({ withdraw_id: 9 });
    }
    return new Response(`no stub for ${call.method} ${call.url}`, { status: 404 });
  });
  let asked = false;
  const gated: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/v1/withdraw_request')) {
      asked = true;
      await o.gate;
    }
    return api.fetch(input, init);
  };
  return { fetch: gated, calls: api.calls, withdrawAsked: () => asked };
}

function replay(desk: DeskView = own()) {
  return new ReplayContractClient({ config: TEST_CONFIG, desks: { [DESK]: desk }, prices: [], keys: { [DESK]: { evm: TEST_EVM_KEY, sol: TEST_SOL_SEED } }, now: () => NOW });
}

/** The replay contract's methods, with some replaced. */
function delegate(c: ReplayContractClient, over: Partial<OrderlyWithdrawStart['contract']> = {}): OrderlyWithdrawStart['contract'] {
  const signer: OrderlySigner = {
    orderlyRequest: (d, r, why) => c.orderlyRequest(d, r, why),
    orderlyWsAuth: (d, ts) => c.orderlyWsAuth(d, ts),
    orderlyRegister: (d, n) => c.orderlyRegister(d, n),
    orderlyAddKey: (d, ms) => c.orderlyAddKey(d, ms),
    orderlySettlePnl: (d, n) => c.orderlySettlePnl(d, n),
    orderlyWithdraw: (d, a, n) => c.orderlyWithdraw(d, a, n),
  };
  return { getDesk: (id) => c.getDesk(id), ...signer, ...over };
}

function start(dir: string, contract: OrderlyWithdrawStart['contract'], f: typeof fetch, lines: string[], o: { value?: string; autoOn?: () => boolean } = {}) {
  return startOrderlyWithdraw({
    value: o.value ?? `${CONTRACT}/${DESK}/12/r1`, network: 'mainnet', contract, counters: async () => null, autoOn: o.autoOn ?? (() => false),
    engine: ENGINE, orderlyUrl: ORDERLY, stateDir: dir, log: (l) => lines.push(l), fetch: f, now: () => NOW,
  })!;
}

test('the value parses into contract, desk, a canonical amount (or all) and a run-id; the bounds and reads parse', () => {
  assert.deepEqual(parseOrderlyWithdraw('gimbal_dex.near/carry/12.50/a1'), { contractId: 'gimbal_dex.near', deskId: 'carry', amount: '12.5', amountE6: 12_500_000n, runId: 'a1' });
  assert.deepEqual(parseOrderlyWithdraw('gimbal_dex.near/carry/all/a1'), { contractId: 'gimbal_dex.near', deskId: 'carry', amount: 'all', amountE6: null, runId: 'a1' });
  for (const bad of ['c.near/d/12', 'c.near/d/12/r/x', 'c.near/d/0/r', 'c.near/d/-1/r', 'c.near/d/1.0000001/r', 'c.near/d/1e3/r', 'C.near/d/1/r', 'c.near/D!/1/r', 'c.near/d/1/r id', 'c.near/d/ALL/r']) {
    assert.throws(() => parseOrderlyWithdraw(bad), /GIMBAL_ORDERLY_WITHDRAW/, bad);
  }
  assert.equal(formatE6(10_000_000n), '10');
  assert.equal(formatE6(1_230_000n), '1.23');
  assert.equal(operatorMinE6(testDesk()), 10_000_000n, '10 x 1 USDC flat');
  assert.equal(operatorMinE6({ policy: { ...testDesk().policy, max_transfer_cost_flat_e6: 2_500_000 } }), 25_000_000n);
  assert.equal(operatorMinE6({ policy: { ...testDesk().policy, max_transfer_cost_flat_e6: 300_000 } }), 10_000_000n, 'never under 10 USDC');
  assert.deepEqual(freeUsdc(holding(25.5, 3.25)), { freeE6: 22_250_000n, holding: 25.5, frozen: 3.25 });
  assert.deepEqual(freeUsdc({ holding: [] }), { freeE6: 0n, holding: 0, frozen: 0 }, 'Orderly leaves an empty token out');
  assert.equal(withdrawable(flat, holding(12.345678)).availableE6, 12_345_678n);
  assert.equal(withdrawable({ rows: [row('A', 0, -2.5), row('B', 0, 1)] }, holding(25)).availableE6, 23_500_000n, 'a net loss comes off');
  assert.equal(withdrawable({ rows: [row('A', 0, 3)] }, holding(25)).availableE6, 25_000_000n, 'a gain does not add');
  assert.equal(withdrawable({ rows: [], free_collateral: 20.1 }, holding(25)).availableE6, 20_100_000n, 'at most free_collateral');
  assert.throws(() => withdrawable({ rows: [{ symbol: 'A', position_qty: 0 }] }, holding(25)), /A has no unsettled_pnl/);
  assert.deepEqual(hourlyRoom(null, 50), { capLeftE6: 50_000_000n, costLeftE8: null });
  assert.deepEqual(hourlyRoom({ rescue_cap_left_e8: '1100000000', rescue_cost_left_e8: 50_000_000 }, 50), { capLeftE6: 11_000_000n, costLeftE8: 50_000_000n });
  assert.throws(() => hourlyRoom({ rescue_cap_left_e8: '1' }, 50), /rescue_cost_left_e8 is missing/);
});

test('unset: setupFromEnv is what it was, with no line about the withdrawal; set without GIMBAL_SETUP=1 it is ignored, said once', async () => {
  const quiet: string[] = [];
  assert.equal(await setupFromEnv('mainnet', () => undefined, (l) => quiet.push(l)), null);
  assert.deepEqual(quiet, []);
  const lines: string[] = [];
  const env = (name: string) => (name === 'GIMBAL_ORDERLY_WITHDRAW' ? `${CONTRACT}/${DESK}/12/run-1` : undefined);
  assert.equal(await setupFromEnv('mainnet', env, (l) => lines.push(l)), null);
  assert.deepEqual(lines, ['orderly withdraw: ignored: GIMBAL_ORDERLY_WITHDRAW runs only with GIMBAL_SETUP=1 (it signs with the operator key)']);
});

test('setupFromEnv with GIMBAL_SETUP=1 and the variable starts a run in GIMBAL_STATE_DIR; unset, no run', async (t) => {
  const views: string[] = [];
  const transport = (desk: DeskView): NearTransport => ({
    accountId: OPERATOR,
    call: async () => { throw new Error('nothing is signed in this test'); },
    view: async <T>(_c: string, method: string) => {
      views.push(method);
      if (method === 'config') return { network: 'mainnet', orderly: { broker_id: 'gimbal_dex', chain_id: 42161 } } as T;
      if (method === 'get_desk') return desk as T;
      return null as T;
    },
    account: async () => ({ amount: 0n, locked: 0n, storageUsage: 0 }),
    allowance: async () => null,
  });
  const envOf = (dir: string, withdraw: string | undefined) => (name: string): string | undefined => ({
    GIMBAL_SETUP: '1', GIMBAL_CONTRACT_ID: CONTRACT, DESK_ID: DESK, OPERATOR_ACCOUNT_ID: OPERATOR, OPERATOR_PRIVATE_KEY: 'ed25519:not-used-here',
    NEAR_NETWORK: 'mainnet', GIMBAL_STATE_DIR: dir, GIMBAL_ORDERLY_WITHDRAW: withdraw,
  } as Record<string, string | undefined>)[name];

  // Unset: the service as before, no run.
  const plain = await setupFromEnv('mainnet', envOf(tempDir(t), undefined), () => {}, { transport: transport(own()) });
  assert.equal(plain?.orderlyWithdraw, null);

  // A marker in GIMBAL_STATE_DIR is found there: the run started and looked in that directory.
  const dir = tempDir(t);
  writeFileSync(marker(dir), JSON.stringify({ status: 'done', amount: '12', evmAddress: TEST_EVM_ADDRESS, startedAt: 'a', finishedAt: 'b', tx: [] }));
  const lines: string[] = [];
  const svc = await setupFromEnv('mainnet', envOf(dir, `${CONTRACT}/${DESK}/12/run-1`), (l) => lines.push(l), { transport: transport(own()), autoOn: () => false });
  assert.equal((await svc!.orderlyWithdraw!.done)?.status, 'marker');
  assert.ok(lines.some((l) => l.includes(`has a marker (${marker(dir)})`)), lines.join('\n'));

  // No marker: it reads get_desk through the contract and stops on a paused desk, leaving no marker.
  const dir2 = tempDir(t);
  const lines2: string[] = [];
  views.length = 0;
  const svc2 = await setupFromEnv('mainnet', envOf(dir2, `${CONTRACT}/${DESK}/12/run-1`), (l) => lines2.push(l), {
    transport: transport(testDesk({ owner: OPERATOR, operator: OPERATOR, paused: true })), autoOn: () => false,
  });
  assert.equal((await svc2!.orderlyWithdraw!.done)?.status, 'refused');
  assert.ok(views.includes('get_desk'));
  assert.match(lines2.at(-1)!, /refused: desk carry is paused/);
  assert.equal(existsSync(marker(dir2)), false);
});

test('a value that does not parse is logged and starts nothing', (t) => {
  const lines: string[] = [];
  const contract = replay();
  const run = startOrderlyWithdraw({
    value: 'gimbal_dex.near/carry/12', network: 'mainnet', contract, counters: async () => null, engine: ENGINE, orderlyUrl: ORDERLY,
    stateDir: tempDir(t), log: (l) => lines.push(l),
  });
  assert.equal(run, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^orderly withdraw: ignored: GIMBAL_ORDERLY_WITHDRAW must be/);
  assert.deepEqual(contract.calls, []);
});

test('a marker for the run-id means nothing runs: done, failed, started (unknown) or unreadable; get_desk is not even read', async (t) => {
  const cases: [string, string, RegExp][] = [
    ['done', JSON.stringify({ status: 'done', amount: '12', evmAddress: TEST_EVM_ADDRESS, startedAt: 'a', finishedAt: 'b', report: REPORT, tx: [] }), /done at b, 12 USDC .*unset GIMBAL_ORDERLY_WITHDRAW/],
    ['failed', JSON.stringify({ status: 'failed', amount: '12', startedAt: 'a', finishedAt: 'b', error: 'boom', outcome: 'unknown' }), /failed at b \(boom\); never retried: .*unknown outcome/],
    ['failed not sent', JSON.stringify({ status: 'failed', amount: '12', startedAt: 'a', finishedAt: 'b', error: 'E_RESCUE_CAP', outcome: 'not_sent' }), /never went to Orderly, so no USDC left Orderly/],
    ['started', JSON.stringify({ status: 'started', amount: '12', startedAt: 'a' }), /started at a for 12 USDC with no outcome written: unknown outcome, check the desk EVM on Arbitrum and nearblocks; set a new run-id only after checking/],
    ['unreadable', '{"status":', /cannot be read .*unknown outcome/],
  ];
  for (const [name, content, line] of cases) {
    const dir = tempDir(t);
    writeFileSync(marker(dir), content);
    const fake = fakeClient();
    const { d, lines, deskReads } = deps(dir, { client: fake.client });
    const r = await runOrderlyWithdraw(d);
    assert.equal(r.status, 'marker', name);
    assert.equal(lines.length, 1, name);
    assert.match(lines[0]!, line, name);
    assert.match(lines[0]!, /^orderly withdraw: run run-1 has a marker/, name);
    assert.equal(deskReads(), 0, name);
    assert.deepEqual(fake.calls, [], name);
    assert.equal(readFileSync(marker(dir), 'utf8'), content, `${name}: the marker is left as it was`);
  }
});

test('a paused or closing desk stops before any Orderly read: unpause first; no marker', async (t) => {
  for (const desk of [testDesk({ owner: OPERATOR, operator: OPERATOR, paused: true }), testDesk({ owner: OPERATOR, operator: OPERATOR, paused: true, closing: true })]) {
    const dir = tempDir(t);
    const fake = fakeClient();
    const { d, lines } = deps(dir, { desk, client: fake.client });
    const r = await runOrderlyWithdraw(d);
    assert.equal(r.status, 'refused');
    assert.match(lines.at(-1)!, /orderly withdraw: refused: desk carry is (paused|closing \(panic_close\)): the operator's orderly_withdraw needs the desk running; unpause it first \(strategy auto off\)/);
    assert.match(lines.at(-1)!, /no marker was written/);
    assert.deepEqual(fake.calls, []);
    assert.equal(existsSync(marker(dir)), false);
  }
});

test('auto on refuses before get_desk; auto turned on during the reads refuses before the marker; auto unknown refuses', async (t) => {
  const on = deps(tempDir(t), { autoOn: () => true });
  assert.equal((await runOrderlyWithdraw(on.d)).status, 'refused');
  assert.equal(on.deskReads(), 0);
  assert.match(on.lines.at(-1)!, /refused: the strategy loop trades \(GIMBAL_TRADE=1 and auto on\) and could open an Orderly leg between the flat check and the withdrawal: unset GIMBAL_TRADE for the withdrawal \(railway variable delete GIMBAL_TRADE\) and set it back after/);

  const dir = tempDir(t);
  const fake = fakeClient();
  let asked = 0;
  const late = deps(dir, { client: fake.client, autoOn: () => ++asked > 1 });
  assert.equal((await runOrderlyWithdraw(late.d)).status, 'refused');
  assert.deepEqual(fake.calls, ['positions', 'holding'], 'checked, then refused: no withdraw');
  assert.equal(asked, 2);
  assert.equal(existsSync(marker(dir)), false);

  const unknown = deps(tempDir(t), { autoOn: null });
  assert.equal((await runOrderlyWithdraw(unknown.d)).status, 'refused');
  assert.match(unknown.lines.at(-1)!, /auto setting cannot be read here/);
});

test('refused, no marker, no withdraw: another contract or desk, a desk the key does not act for, positions open, more than can leave, an unsettled loss, under the minimum, the hourly cap or cost budget short, reads failing', async (t) => {
  const cases: { name: string; value?: string; desk?: DeskView | null; client?: ReturnType<typeof fakeClient>; counters?: unknown; reason: RegExp; reads: string[] }[] = [
    { name: 'other contract', value: `other.near/${DESK}/12/run-1`, reason: /names other\.near\/carry, but this engine runs gimbal_dex\.near\/carry/, reads: [] },
    { name: 'other desk', value: `${CONTRACT}/hedge/12/run-1`, reason: /names gimbal_dex\.near\/hedge/, reads: [] },
    { name: 'no desk', desk: null, reason: /the contract has no desk carry/, reads: [] },
    { name: 'not ours', desk: testDesk({ owner: 'someone.near', operator: null }), reason: /belongs to someone\.near; the operator key is on owner\.near/, reads: [] },
    {
      name: 'not flat', client: fakeClient({ positions: { rows: [row('PERP_ETH_USDC', 0), row('PERP_BTC_USDC', -0.001)] } }),
      reason: /Orderly positions are not flat \(PERP_BTC_USDC -0\.001\): close them first/, reads: ['positions'],
    },
    { name: 'too much', client: fakeClient({ holding: holding(15, 4) }), reason: /12 USDC is over what can leave Orderly, 11 USDC \(holding 15, frozen 4, unsettled PnL 0\)/, reads: ['positions', 'holding'] },
    { name: 'no USDC row', client: fakeClient({ holding: { holding: [] } }), reason: /over what can leave Orderly, 0 USDC/, reads: ['positions', 'holding'] },
    {
      name: 'unsettled loss', client: fakeClient({ positions: { rows: [row('PERP_ETH_USDC', 0, -14)] } }),
      reason: /12 USDC is over what can leave Orderly, 11 USDC \(holding 25, frozen 0, unsettled PnL -14\)/, reads: ['positions', 'holding'],
    },
    { name: 'free_collateral', client: fakeClient({ positions: { ...flat, free_collateral: 11.5 } }), reason: /over what can leave Orderly, 11\.5 USDC .*free_collateral 11\.5/, reads: ['positions', 'holding'] },
    {
      name: 'no unsettled_pnl', client: fakeClient({ positions: { rows: [{ symbol: 'X', position_qty: 0, cost_position: 0, last_sum_unitary_funding: 0, average_open_price: 0, est_liq_price: 0 }] } }),
      reason: /X has no unsettled_pnl/, reads: ['positions', 'holding'],
    },
    { name: 'all under the minimum', value: `${CONTRACT}/${DESK}/all/run-1`, client: fakeClient({ holding: holding(9.5) }), reason: /all that can leave Orderly, 9\.5 USDC .* is under the operator's minimum of 10 USDC/, reads: ['positions', 'holding'] },
    { name: 'under the minimum', value: `${CONTRACT}/${DESK}/9.99/run-1`, reason: /9\.99 USDC is under the operator's minimum of 10 USDC \(max\(10 x max_transfer_cost_flat_e6, 10 USDC\)\)/, reads: [] },
    {
      name: 'under a higher minimum', desk: testDesk({ owner: OPERATOR, operator: OPERATOR, policy: { ...testDesk().policy, max_transfer_cost_flat_e6: 2_000_000 } }),
      reason: /12 USDC is under the operator's minimum of 20 USDC/, reads: [],
    },
    { name: 'cap left short', counters: { rescue_cap_left_e8: '1100000000', rescue_cost_left_e8: '500000000' }, reason: /over what is left of the hourly rescue cap, 11 USD/, reads: [] },
    {
      name: 'all over the cap left', value: `${CONTRACT}/${DESK}/all/run-1`, counters: { rescue_cap_left_e8: '2000000000', rescue_cost_left_e8: '500000000' },
      reason: /25 USDC is over what is left of the hourly rescue cap, 20 USD: withdraw at most that now/, reads: ['positions', 'holding'],
    },
    { name: 'cost budget short', counters: { rescue_cap_left_e8: '5000000000', rescue_cost_left_e8: '50000000' }, reason: /1 USDC fee is over what is left of the hourly rescue cost budget \(0\.5 USD\)/, reads: [] },
    { name: 'counters unreadable', counters: { rescue_cap_left_e8: '5000000000' }, reason: /get_desk_counters\(carry\): rescue_cost_left_e8 is missing/, reads: [] },
    { name: 'read fails', client: { client: { ...fakeClient().client, positions: async () => { throw new Error('HTTP 401 IP not allowed'); } }, calls: [] }, reason: /the signed Orderly reads failed: HTTP 401 IP not allowed/, reads: [] },
  ];
  for (const c of cases) {
    const dir = tempDir(t);
    const fake = c.client ?? fakeClient();
    const { d, lines } = deps(dir, {
      ...(c.value === undefined ? {} : { value: c.value }), ...(c.desk === undefined ? {} : { desk: c.desk }),
      ...(c.counters === undefined ? {} : { counters: c.counters }), client: fake.client,
    });
    const r = await runOrderlyWithdraw(d);
    assert.equal(r.status, 'refused', c.name);
    assert.match(lines.at(-1)!, /^orderly withdraw: refused: .*no marker was written/, c.name);
    assert.match(lines.at(-1)!, c.reason, c.name);
    assert.deepEqual(fake.calls, c.reads, c.name);
    assert.equal(existsSync(marker(dir)), false, c.name);
  }
});

test('success: marker started before the withdraw, then done with the report; the same run-id never runs again', async (t) => {
  const dir = tempDir(t);
  let seenAtWithdraw: unknown = null;
  const fake = fakeClient({
    withdraw: async () => {
      seenAtWithdraw = readMarker(dir).status;
      return REPORT;
    },
  });
  const { d, lines } = deps(dir, { client: fake.client });
  const r = await runOrderlyWithdraw(d);
  assert.equal(r.status, 'done');
  assert.equal(seenAtWithdraw, 'started', 'the marker is on disk before anything that moves money');
  assert.deepEqual(fake.calls, ['positions', 'holding', 'withdraw:12']);
  const m = readMarker(dir);
  assert.equal(m.status, 'done');
  assert.equal(m.amount, '12');
  assert.equal(m.evmAddress, TEST_EVM_ADDRESS);
  assert.equal(m.startedAt, new Date(NOW).toISOString());
  assert.deepEqual(m.report, REPORT);
  assert.deepEqual((m.tx as { id: string }[]).map((x) => x.id), ['nearTxA']);
  assert.ok(lines.every((l) => l.startsWith('orderly withdraw: ')));
  assert.match(lines.find((l) => l.includes('checks passed'))!, /no trading loop, positions flat, 25 USDC can leave .*operator minimum 10, hourly cap left 2000; 13 USDC stays on Orderly$/);
  assert.match(lines.find((l) => l.includes(': started:'))!, /marker .*orderly-withdraw-gimbal_dex\.near-carry-run-1\.json/);
  assert.match(lines.at(-1)!, /done: Orderly took the withdrawal of 12 USDC to 0x.* on Arbitrum \(settle \{"settle_pnl_id":3\}, withdraw \{"withdraw_id":9\}; NEAR nearTxA\)\. Orderly's 1 USDC fee comes out of it, so 11 USDC lands/);

  const again = deps(dir, { client: fake.client });
  assert.equal((await runOrderlyWithdraw(again.d)).status, 'marker');
  assert.deepEqual(fake.calls, ['positions', 'holding', 'withdraw:12'], 'no second withdrawal');
  assert.match(again.lines[0]!, /done at .* unset GIMBAL_ORDERLY_WITHDRAW/);
});

test('all withdraws what can leave, net of an unsettled loss; a remainder under the minimum is called out', async (t) => {
  const dir = tempDir(t);
  const fake = fakeClient({ positions: { rows: [row('PERP_ETH_USDC', 0, -1.25)] }, holding: holding(20) });
  const { d, lines } = deps(dir, { client: fake.client, value: `${CONTRACT}/${DESK}/all/run-1` });
  const r = await runOrderlyWithdraw(d);
  assert.equal(r.status === 'done' && r.amount, '18.75');
  assert.deepEqual(fake.calls, ['positions', 'holding', 'withdraw:18.75']);
  assert.equal(readMarker(dir).amount, '18.75');
  assert.match(lines.find((l) => l.includes('checks passed'))!, /; 0 USDC stays on Orderly$/);

  const part = deps(tempDir(t), { client: fakeClient({ holding: holding(17) }).client });
  await runOrderlyWithdraw(part.d);
  assert.match(part.lines.find((l) => l.includes('checks passed'))!, /5 USDC stays on Orderly, under the operator's minimum: only the owner's path can take it out later/);
});

test('two runs of one run-id at once: one holds the marker and withdraws, the other refuses without touching it', async (t) => {
  const dir = tempDir(t);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const a = fakeClient({ beforeHolding: () => gate });
  const b = fakeClient({ beforeHolding: () => gate });
  const ra = deps(dir, { client: a.client });
  const rb = deps(dir, { client: b.client });
  const both = Promise.all([runOrderlyWithdraw(ra.d), runOrderlyWithdraw(rb.d)]);
  for (let i = 0; i < 10; i++) await tick();
  release();
  const [x, y] = await both;
  assert.deepEqual([x.status, y.status].sort(), ['done', 'refused']);
  assert.equal([...a.calls, ...b.calls].filter((c) => c.startsWith('withdraw')).length, 1);
  const loser = x.status === 'refused' ? ra : rb;
  assert.match(loser.lines.at(-1)!, /refused: another run of run-1 created the marker .* meanwhile; nothing that moves money was signed and that run holds the marker; this one does nothing more/);
  assert.equal(readMarker(dir).status, 'done');
});

test('failure mid-way: marker failed with the error and what Orderly got; never retried', async (t) => {
  for (const posted of [false, true]) {
    const dir = tempDir(t);
    const fake = fakeClient({ withdraw: async () => { throw Object.assign(new Error('orderly withdraw_request: no answer'), { tx: [{ chain: 'near', id: 'nearTxW', url: 'u' }] }); } });
    const { d, lines } = deps(dir, { client: fake.client, withdrawPosted: () => posted });
    const r = await runOrderlyWithdraw(d);
    assert.equal(r.status, 'failed');
    const m = readMarker(dir);
    assert.equal(m.status, 'failed');
    assert.equal(m.error, 'orderly withdraw_request: no answer');
    assert.equal(m.outcome, posted ? 'unknown' : 'not_sent');
    assert.deepEqual((m.tx as { id: string }[]).map((x) => x.id), ['nearTxW', 'nearTxA']);
    assert.match(lines.at(-1)!, /^orderly withdraw: failed: orderly withdraw_request: no answer; NEAR nearTxW, nearTxA; not retried: /);
    assert.match(lines.at(-1)!, posted ? /no definite answer: unknown outcome, check the desk EVM on Arbitrum and nearblocks/ : /never went to Orderly, so no USDC left Orderly .*a new run-id may try again/);

    const again = deps(dir, { client: fake.client });
    assert.equal((await runOrderlyWithdraw(again.d)).status, 'marker');
    assert.equal(fake.calls.filter((c) => c.startsWith('withdraw')).length, 1, 'never retried');
  }
});

test('started without an outcome (the process died mid-withdraw): unknown, nothing runs, the marker stays', async (t) => {
  const dir = tempDir(t);
  // The first run dies inside withdraw(): its promise never settles, the marker says started.
  const fake = fakeClient({ withdraw: () => new Promise<OrderlyWithdrawReport>(() => {}) });
  void runOrderlyWithdraw(deps(dir, { client: fake.client }).d);
  for (let i = 0; i < 50 && !fake.calls.includes('withdraw:12'); i++) await tick();
  assert.equal(readMarker(dir).status, 'started');

  const restart = fakeClient();
  const { d, lines, deskReads } = deps(dir, { client: restart.client });
  assert.equal((await runOrderlyWithdraw(d)).status, 'marker');
  assert.match(lines[0]!, /started at .* with no outcome written: unknown outcome, check the desk EVM on Arbitrum and nearblocks; set a new run-id only after checking/);
  assert.deepEqual(restart.calls, []);
  assert.equal(deskReads(), 0);
  assert.equal(readMarker(dir).status, 'started');

  // A new run-id runs (after the owner checked), with its own marker.
  const next = deps(dir, { client: restart.client, value: `${CONTRACT}/${DESK}/12/run-2` });
  assert.equal((await runOrderlyWithdraw(next.d)).status, 'done');
  assert.equal(readMarker(dir, 'run-2').status, 'done');
  assert.equal(readMarker(dir).status, 'started');
});

test('end to end: the replay contract signs settle and withdraw for the desk EVM, Orderly answers from stubs', async (t) => {
  const contract = replay();
  const api = orderlyApi();
  const dir = tempDir(t);
  const lines: string[] = [];
  const r = await start(dir, contract, api.fetch, lines, { value: `${CONTRACT}/${DESK}/12.5/r1` }).done;
  assert.equal(r?.status, 'done', lines.join('\n'));
  assert.deepEqual(contract.calls.map((c) => c.method), [
    'orderly_request', 'orderly_request', 'orderly_request', 'orderly_settle_pnl', 'orderly_request', 'orderly_request', 'orderly_withdraw', 'orderly_request',
  ]);
  assert.deepEqual(contract.calls.find((c) => c.method === 'orderly_withdraw')!.args, { desk_id: DESK, amount: '12.5', withdraw_nonce: 41 });
  assert.deepEqual(api.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    'GET /v1/positions', 'GET /v1/client/holding', 'GET /v1/settle_nonce', 'POST /v1/settle_pnl', 'GET /v1/withdraw_nonce', 'POST /v1/withdraw_request',
  ]);
  const m = readMarker(dir, 'r1') as { status: string; report: OrderlyWithdrawReport };
  assert.equal(m.status, 'done');
  assert.deepEqual(m.report.withdraw, { withdraw_id: 9 });
});

test('end to end: Orderly rejecting the withdraw_request is failed, rejected (nothing left Orderly), not retried', async (t) => {
  const contract = replay();
  const api = orderlyApi({ withdrawAnswer: () => new Response(JSON.stringify({ success: false, code: -1103, message: 'insufficient balance' }), { status: 400 }) });
  const dir = tempDir(t);
  const lines: string[] = [];
  const r = await start(dir, contract, api.fetch, lines).done;
  assert.equal(r?.status === 'failed' && r.outcome, 'rejected', lines.join('\n'));
  assert.match(lines.at(-1)!, /Orderly rejected the withdraw_request, so nothing left Orderly; a new run-id may try again/);
  const posts = api.calls.length;
  assert.equal((await start(dir, contract, api.fetch, lines).done)?.status, 'marker');
  assert.equal(api.calls.length, posts, 'nothing sent on the restart');
});

test('end to end: the contract refusing orderly_withdraw (E_RESCUE_CAP) is failed, not sent: nothing left Orderly', async (t) => {
  const contract = delegate(replay(), {
    orderlyWithdraw: async () => { throw new ContractRefusal('E_RESCUE_CAP', 'orderly_withdraw of 12 USDC is over what is left of the hourly rescue cap', 'nearTxR'); },
  });
  const api = orderlyApi();
  const dir = tempDir(t);
  const lines: string[] = [];
  const r = await start(dir, contract, api.fetch, lines).done;
  assert.equal(r?.status === 'failed' && r.outcome, 'not_sent', lines.join('\n'));
  assert.ok(!api.calls.some((x) => x.url.includes('/v1/withdraw_request')));
  assert.match(lines.at(-1)!, /failed: E_RESCUE_CAP: .*; not retried: the withdraw_request never went to Orderly, so no USDC left Orderly/);
  assert.equal(readMarker(dir, 'r1').outcome, 'not_sent');
});

test('shutdown drains the run: before the marker it stops with none; during the withdrawal it waits for the outcome', async (t) => {
  // Draining while get_desk is read: the run stops at the marker step, nothing signed beyond the reads.
  const c = replay();
  let deskRelease!: () => void;
  const deskGate = new Promise<void>((r) => (deskRelease = r));
  const gated = delegate(c, { getDesk: async (id) => { await deskGate; return c.getDesk(id); } });
  const dir = tempDir(t);
  const lines: string[] = [];
  const run = start(dir, gated, orderlyApi().fetch, lines);
  await tick();
  const drained = run.drain();
  deskRelease();
  assert.equal((await drained)?.status, 'refused');
  assert.match(lines.at(-1)!, /refused: serve is stopping; .*no marker was written/);
  assert.equal(existsSync(marker(dir, 'r1')), false);
  assert.ok(!c.calls.some((x) => x.method === 'orderly_settle_pnl' || x.method === 'orderly_withdraw'));

  // Draining while the withdraw_request is out: the drain resolves only with the outcome, written as done.
  let answer!: () => void;
  const gate = new Promise<void>((r) => (answer = r));
  const api = orderlyApi({ gate });
  const dir2 = tempDir(t);
  const run2 = start(dir2, replay(), api.fetch, []);
  for (let i = 0; i < 500 && !api.withdrawAsked(); i++) await tick();
  assert.ok(api.withdrawAsked());
  assert.equal(run2.inFlight(), true, 'past its marker, no outcome yet: serve says so if it exits now');
  let settled = false;
  const waiting = run2.drain().then((x) => { settled = true; return x; });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(settled, false, 'the drain waits for the withdrawal in flight');
  answer();
  assert.equal((await waiting)?.status, 'done');
  assert.equal(readMarker(dir2, 'r1').status, 'done');
  assert.equal(run2.inFlight(), false);
  assert.equal(run.inFlight(), false, 'a run stopped before its marker was never in flight');
});

test('a withdraw_request whose fetch throws after it was called is unknown, also under a prefixed ORDERLY_API_URL', async (t) => {
  const prefixed = `${ORDERLY}/gateway`;
  const api = orderlyApi();
  const f: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/v1/withdraw_request')) throw new TypeError('fetch failed: socket hang up');
    return api.fetch(String(input).replace(prefixed, ORDERLY), init);
  };
  const dir = tempDir(t);
  const lines: string[] = [];
  const r = await startOrderlyWithdraw({
    value: `${CONTRACT}/${DESK}/12/r1`, network: 'mainnet', contract: replay(), counters: async () => null, autoOn: () => false,
    engine: ENGINE, orderlyUrl: prefixed, stateDir: dir, log: (l) => lines.push(l), fetch: f, now: () => NOW,
  })!.done;
  assert.equal(r?.status === 'failed' && r.outcome, 'unknown', lines.join('\n'));
  assert.equal(readMarker(dir, 'r1').outcome, 'unknown');
  assert.match(lines.at(-1)!, /no definite answer: unknown outcome, check the desk EVM on Arbitrum and nearblocks/);
});
