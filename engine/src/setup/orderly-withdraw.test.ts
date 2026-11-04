// GIMBAL_ORDERLY_WITHDRAW: the one-shot Orderly withdrawal serve runs under GIMBAL_SETUP=1. Every refusal leaves no
// marker and signs nothing that moves money; a run that started never runs again for its run-id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeskView } from '../contract/types.ts';
import { ReplayContractClient } from '../contract/replay-client.ts';
import { stubFetch, TEST_CONFIG, TEST_EVM_ADDRESS, TEST_EVM_KEY, TEST_SOL_SEED, testDesk } from '../relayer/test-helpers.ts';
import type { StubCall } from '../relayer/test-helpers.ts';
import type { OrderlyWithdrawReport } from '../venues/orderly-actions.ts';
import type { OrderlyWithdrawClient, OrderlyWithdrawDeps } from './orderly-withdraw.ts';
import {
  formatE6, freeUsdc, operatorMinE6, orderlyWithdrawMarker, parseOrderlyWithdraw, runOrderlyWithdraw, startOrderlyWithdraw,
} from './orderly-withdraw.ts';
import { setupFromEnv } from './serve-setup.ts';

const NOW = Date.UTC(2026, 10, 4, 12);
const CONTRACT = 'gimbal_dex.near';
const DESK = 'carry';
const OPERATOR = 'owner.near';
const ENGINE = { contractId: CONTRACT, deskId: DESK, operatorAccount: OPERATOR };
const REPORT: OrderlyWithdrawReport = { settleNonce: 17, withdrawNonce: 41, settled: { settle_pnl_id: 3 }, withdraw: { withdraw_id: 9 } };

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-orderly-withdraw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (data: unknown) => ({ success: true, data, timestamp: NOW });
const flat = { rows: [{ symbol: 'PERP_ETH_USDC', position_qty: 0, cost_position: 0, last_sum_unitary_funding: 0, average_open_price: 0, est_liq_price: 0 }] };
const holding = (h: number, frozen = 0) => ({ holding: [{ token: 'USDC', holding: h, frozen }] });

/** A fake desk client: what it reads, and what withdraw() does; `calls` lists every call. */
function fakeClient(o: { positions?: unknown; holding?: unknown; withdraw?: () => Promise<OrderlyWithdrawReport> } = {}) {
  const calls: string[] = [];
  const client: OrderlyWithdrawClient = {
    evmAddress: TEST_EVM_ADDRESS,
    positions: async () => { calls.push('positions'); return o.positions ?? flat; },
    holding: async () => { calls.push('holding'); return o.holding ?? holding(25); },
    withdraw: async (amount) => { calls.push(`withdraw:${amount}`); return (o.withdraw ?? (async () => REPORT))(); },
  };
  return { client, calls };
}

function deps(stateDir: string, o: {
  value?: string; desk?: DeskView | null; client?: OrderlyWithdrawClient; withdrawSigned?: () => boolean;
} = {}): { d: OrderlyWithdrawDeps; lines: string[]; deskReads: () => number } {
  const lines: string[] = [];
  let reads = 0;
  const d: OrderlyWithdrawDeps = {
    ask: parseOrderlyWithdraw(o.value ?? `${CONTRACT}/${DESK}/12/run-1`),
    engine: ENGINE, stateDir,
    desk: async () => { reads++; return o.desk === undefined ? testDesk({ owner: OPERATOR, operator: OPERATOR }) : o.desk; },
    orderly: () => o.client ?? fakeClient().client,
    takeTx: () => [{ chain: 'near', id: 'nearTxA', url: 'https://nearblocks.io/txns/nearTxA' }],
    log: (line) => lines.push(line),
    now: () => NOW,
    ...(o.withdrawSigned === undefined ? {} : { withdrawSigned: o.withdrawSigned }),
  };
  return { d, lines, deskReads: () => reads };
}

const marker = (dir: string, runId = 'run-1') => orderlyWithdrawMarker(dir, { contractId: CONTRACT, deskId: DESK, runId });
const readMarker = (dir: string, runId = 'run-1') => JSON.parse(readFileSync(marker(dir, runId), 'utf8')) as Record<string, unknown>;

test('the value parses into contract, desk, a canonical amount and a run-id; anything else is refused', () => {
  assert.deepEqual(parseOrderlyWithdraw('gimbal_dex.near/carry/12.50/a1'), { contractId: 'gimbal_dex.near', deskId: 'carry', amount: '12.5', amountE6: 12_500_000n, runId: 'a1' });
  assert.equal(parseOrderlyWithdraw('c.near/d/10.000001/x').amount, '10.000001');
  for (const bad of ['c.near/d/12', 'c.near/d/12/r/x', 'c.near/d/0/r', 'c.near/d/-1/r', 'c.near/d/1.0000001/r', 'c.near/d/1e3/r', 'C.near/d/1/r', 'c.near/D!/1/r', 'c.near/d/1/r id']) {
    assert.throws(() => parseOrderlyWithdraw(bad), /GIMBAL_ORDERLY_WITHDRAW/, bad);
  }
  assert.equal(formatE6(10_000_000n), '10');
  assert.equal(formatE6(1_230_000n), '1.23');
  assert.equal(operatorMinE6(testDesk()), 10_000_000n, '10 x 1 USDC flat');
  assert.equal(operatorMinE6({ policy: { ...testDesk().policy, max_transfer_cost_flat_e6: 2_500_000 } }), 25_000_000n);
  assert.equal(operatorMinE6({ policy: { ...testDesk().policy, max_transfer_cost_flat_e6: 300_000 } }), 10_000_000n, 'never under 10 USDC');
  assert.deepEqual(freeUsdc(holding(25.5, 3.25)), { freeE6: 22_250_000n, holding: 25.5, frozen: 3.25 });
  assert.deepEqual(freeUsdc({ holding: [] }), { freeE6: 0n, holding: 0, frozen: 0 }, 'Orderly leaves an empty token out');
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

test('a value that does not parse is logged and starts nothing', (t) => {
  const lines: string[] = [];
  const contract = new ReplayContractClient({ config: TEST_CONFIG, desks: {}, prices: [], now: () => NOW });
  const run = startOrderlyWithdraw({
    value: 'gimbal_dex.near/carry/12', network: 'mainnet', contract, engine: ENGINE, orderlyUrl: 'https://api.orderly.org',
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
    ['failed', JSON.stringify({ status: 'failed', amount: '12', startedAt: 'a', finishedAt: 'b', error: 'boom', withdrawSigned: true }), /failed at b \(boom\); never retried: unknown outcome/],
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

test('refused, no marker, no withdraw: another contract or desk, a desk the key does not act for, positions open, more than the free USDC, under the minimum, over the hourly cap, reads failing', async (t) => {
  const own = { owner: OPERATOR, operator: OPERATOR };
  const cases: { name: string; value?: string; desk?: DeskView | null; client?: ReturnType<typeof fakeClient>; reason: RegExp; reads: string[] }[] = [
    { name: 'other contract', value: `other.near/${DESK}/12/run-1`, reason: /names other\.near\/carry, but this engine runs gimbal_dex\.near\/carry/, reads: [] },
    { name: 'other desk', value: `${CONTRACT}/hedge/12/run-1`, reason: /names gimbal_dex\.near\/hedge/, reads: [] },
    { name: 'no desk', desk: null, reason: /the contract has no desk carry/, reads: [] },
    { name: 'not ours', desk: testDesk({ owner: 'someone.near', operator: null }), reason: /belongs to someone\.near; the operator key is on owner\.near/, reads: [] },
    {
      name: 'not flat',
      client: fakeClient({ positions: { rows: [...flat.rows, { symbol: 'PERP_BTC_USDC', position_qty: -0.001, cost_position: 1, last_sum_unitary_funding: 0, average_open_price: 1, est_liq_price: 0 }] } }),
      reason: /Orderly positions are not flat \(PERP_BTC_USDC -0\.001\): close them first/, reads: ['positions'],
    },
    { name: 'too much', client: fakeClient({ holding: holding(15, 4) }), reason: /12 USDC is over the free USDC on Orderly, 11 \(holding 15, frozen 4\)/, reads: ['positions', 'holding'] },
    { name: 'no USDC row', client: fakeClient({ holding: { holding: [] } }), reason: /over the free USDC on Orderly, 0 /, reads: ['positions', 'holding'] },
    { name: 'under the minimum', value: `${CONTRACT}/${DESK}/9.99/run-1`, reason: /9\.99 USDC is under the operator's minimum of 10 USDC \(max\(10 x max_transfer_cost_flat_e6, 10 USDC\)\)/, reads: [] },
    {
      name: 'under a higher minimum', desk: testDesk({ ...own, policy: { ...testDesk().policy, max_transfer_cost_flat_e6: 2_000_000 } }),
      reason: /12 USDC is under the operator's minimum of 20 USDC/, reads: [],
    },
    {
      name: 'over the hourly cap', desk: testDesk({ ...own, policy: { ...testDesk().policy, rescue_cap_usd_per_hour: 11 } }),
      reason: /over the hourly rescue cap of 11 USD/, reads: [],
    },
    { name: 'read fails', client: { client: { ...fakeClient().client, positions: async () => { throw new Error('HTTP 401 IP not allowed'); } }, calls: [] }, reason: /the signed Orderly reads failed: HTTP 401 IP not allowed/, reads: [] },
  ];
  for (const c of cases) {
    const dir = tempDir(t);
    const fake = c.client ?? fakeClient();
    const { d, lines } = deps(dir, { ...(c.value === undefined ? {} : { value: c.value }), ...(c.desk === undefined ? {} : { desk: c.desk }), client: fake.client });
    const r = await runOrderlyWithdraw(d);
    assert.equal(r.status, 'refused', c.name);
    assert.match(lines.at(-1)!, /^orderly withdraw: refused: /, c.name);
    assert.match(lines.at(-1)!, c.reason, c.name);
    assert.deepEqual(fake.calls, c.reads, c.name);
    assert.equal(existsSync(marker(dir, parseOrderlyWithdraw(c.value ?? `${CONTRACT}/${DESK}/12/run-1`).runId)), false, c.name);
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
  assert.match(lines.find((l) => l.includes('checks passed'))!, /positions flat, free USDC 25, operator minimum 10, hourly cap 2000/);
  assert.match(lines.find((l) => l.includes(': started:'))!, /marker .*orderly-withdraw-gimbal_dex\.near-carry-run-1\.json/);
  assert.match(lines.at(-1)!, /done: Orderly took the withdrawal of 12 USDC to 0x.* on Arbitrum \(settle \{"settle_pnl_id":3\}, withdraw \{"withdraw_id":9\}; NEAR nearTxA\)/);

  const again = deps(dir, { client: fake.client });
  assert.equal((await runOrderlyWithdraw(again.d)).status, 'marker');
  assert.deepEqual(fake.calls, ['positions', 'holding', 'withdraw:12'], 'no second withdrawal');
  assert.match(again.lines[0]!, /done at .* unset GIMBAL_ORDERLY_WITHDRAW/);
});

test('failure mid-way: marker failed with the error, said whether the Withdraw was signed; never retried', async (t) => {
  for (const signed of [false, true]) {
    const dir = tempDir(t);
    const fake = fakeClient({ withdraw: async () => { throw Object.assign(new Error('orderly withdraw_request: HTTP 500'), { tx: [{ chain: 'near', id: 'nearTxW', url: 'u' }] }); } });
    const { d, lines } = deps(dir, { client: fake.client, withdrawSigned: () => signed });
    const r = await runOrderlyWithdraw(d);
    assert.equal(r.status, 'failed');
    const m = readMarker(dir);
    assert.equal(m.status, 'failed');
    assert.equal(m.error, 'orderly withdraw_request: HTTP 500');
    assert.equal(m.withdrawSigned, signed);
    assert.deepEqual((m.tx as { id: string }[]).map((x) => x.id), ['nearTxW', 'nearTxA']);
    assert.match(lines.at(-1)!, /^orderly withdraw: failed: orderly withdraw_request: HTTP 500; NEAR nearTxW, nearTxA; not retried: /);
    assert.match(lines.at(-1)!, signed ? /Orderly may have taken it: unknown outcome, check the desk EVM on Arbitrum and nearblocks/ : /no USDC left Orderly .*set a new run-id to try again/);

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
  for (let i = 0; i < 50 && !fake.calls.includes('withdraw:12'); i++) await new Promise((r) => setImmediate(r));
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

test('startOrderlyWithdraw end to end: the replay contract signs settle and withdraw for the desk EVM, Orderly answers from stubs', async (t) => {
  const ACCOUNT = `0x${'5e'.repeat(32)}`;
  const ORDERLY = 'https://api.orderly.org';
  const contract = new ReplayContractClient({
    config: TEST_CONFIG,
    desks: { [DESK]: testDesk({ owner: OPERATOR, operator: OPERATOR, orderly_account_id: ACCOUNT }) },
    prices: [], keys: { [DESK]: { evm: TEST_EVM_KEY, sol: TEST_SOL_SEED } }, now: () => NOW,
  });
  const api = stubFetch((call: StubCall) => {
    switch (new URL(call.url).pathname) {
      case '/v1/positions': return ok(flat);
      case '/v1/client/holding': return ok(holding(30));
      case '/v1/settle_nonce': return ok({ settle_nonce: '17' });
      case '/v1/settle_pnl': return ok({ settle_pnl_id: 3 });
      case '/v1/withdraw_nonce': return ok({ withdraw_nonce: '41' });
      case '/v1/withdraw_request': return ok({ withdraw_id: 9 });
    }
    return new Response(`no stub for ${call.method} ${call.url}`, { status: 404 });
  });
  const dir = tempDir(t);
  const lines: string[] = [];
  const r = await startOrderlyWithdraw({
    value: `${CONTRACT}/${DESK}/12.5/r1`, network: 'mainnet', contract, engine: ENGINE, orderlyUrl: ORDERLY, stateDir: dir,
    log: (l) => lines.push(l), fetch: api.fetch, now: () => NOW,
  });
  assert.equal(r?.status, 'done', lines.join('\n'));
  assert.deepEqual(contract.calls.map((c) => c.method), [
    'orderly_request', 'orderly_request', 'orderly_request', 'orderly_settle_pnl', 'orderly_request', 'orderly_request', 'orderly_withdraw', 'orderly_request',
  ]);
  assert.deepEqual(contract.calls.find((c) => c.method === 'orderly_withdraw')!.args, { desk_id: DESK, amount: '12.5', withdraw_nonce: 41 });
  assert.deepEqual(api.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    'GET /v1/positions', 'GET /v1/client/holding', 'GET /v1/settle_nonce', 'POST /v1/settle_pnl', 'GET /v1/withdraw_nonce', 'POST /v1/withdraw_request',
  ]);
  const m = JSON.parse(readFileSync(orderlyWithdrawMarker(dir, { contractId: CONTRACT, deskId: DESK, runId: 'r1' }), 'utf8')) as { status: string; report: OrderlyWithdrawReport };
  assert.equal(m.status, 'done');
  assert.deepEqual(m.report.withdraw, { withdraw_id: 9 });
});

test('startOrderlyWithdraw: Orderly refusing the withdraw after the contract signed it is failed, Withdraw signed, not retried', async (t) => {
  const ACCOUNT = `0x${'5e'.repeat(32)}`;
  const contract = new ReplayContractClient({
    config: TEST_CONFIG,
    desks: { [DESK]: testDesk({ owner: OPERATOR, operator: OPERATOR, orderly_account_id: ACCOUNT }) },
    prices: [], keys: { [DESK]: { evm: TEST_EVM_KEY, sol: TEST_SOL_SEED } }, now: () => NOW,
  });
  const api = stubFetch((call: StubCall) => {
    switch (new URL(call.url).pathname) {
      case '/v1/positions': return ok(flat);
      case '/v1/client/holding': return ok(holding(30));
      case '/v1/settle_nonce': return ok({ settle_nonce: '17' });
      case '/v1/settle_pnl': return ok({ settle_pnl_id: 3 });
      case '/v1/withdraw_nonce': return ok({ withdraw_nonce: '41' });
      case '/v1/withdraw_request': return new Response(JSON.stringify({ success: false, code: -1103, message: 'insufficient balance' }), { status: 400 });
    }
    return new Response('no stub', { status: 404 });
  });
  const dir = tempDir(t);
  const lines: string[] = [];
  const start = () => startOrderlyWithdraw({
    value: `${CONTRACT}/${DESK}/12/r1`, network: 'mainnet', contract, engine: ENGINE, orderlyUrl: 'https://api.orderly.org', stateDir: dir,
    log: (l) => lines.push(l), fetch: api.fetch, now: () => NOW,
  });
  const r = await start();
  assert.equal(r?.status, 'failed', lines.join('\n'));
  assert.equal(r?.status === 'failed' && r.withdrawSigned, true);
  const posts = api.calls.length;
  assert.equal((await start())?.status, 'marker');
  assert.equal(api.calls.length, posts, 'nothing sent on the restart');
});
