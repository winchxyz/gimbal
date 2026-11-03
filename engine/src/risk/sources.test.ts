// AccountsDeskSource: every open position on the desk's accounts is a leg; a failed account read is reported with
// how long it took, and the others still come in; a read held up by a venue's request budget gives up at its deadline.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeskState } from '@gimbal/shared';
import { HostBudget, PHOENIX_BUDGET, readClass } from '../venues/http-budget.ts';
import type { AccountState } from '../venues/venue.ts';
import { ACCOUNT_READ_DEADLINE_MS, AccountsDeskSource } from './sources.ts';

test('an account read past its deadline fails that venue for the tick: the snapshot is not held up', async () => {
  // A Phoenix budget in a cool-down that a critical read would wait out (10 s), and a reader that never answers.
  const budget = new HostBudget('phoenix-test', { ...PHOENIX_BUDGET, random: () => 0 });
  await budget.run('book', async () => new Response('{}', { status: 429, headers: { 'retry-after': '10' } }));
  const hl: AccountState = { venue: 'hyperliquid', address: '0xdesk', time: 1, equityUsd: 1, freeMarginUsd: 1, maintenanceMarginUsd: 0, positions: [] };
  let sent = 0;
  const source = new AccountsDeskSource({
    deskId: 'alpha', owner: 'owner.near', contract: 'gimbal.near', readDeadlineMs: 150,
    accounts: [
      { reader: { id: 'hyperliquid', account: () => new Promise<AccountState>(() => {}) }, address: '0xdesk' },
      {
        reader: {
          id: 'phoenix',
          account: async () => {
            await budget.run(readClass('account'), async () => {
              sent++;
              return new Response('{}', { status: 200 });
            });
            return hl;
          },
        },
        address: 'Auth111',
      },
    ],
  });
  const t0 = Date.now();
  const snap = await source.read();
  assert.ok(Date.now() - t0 < 1_000, `${Date.now() - t0} ms`);
  assert.deepEqual(snap.reads.map((r) => r.venue), ['hyperliquid', 'phoenix']);
  assert.equal(snap.reads[0]!.error, 'hyperliquid account read gave up after 0.15 s');
  // The budgeted read heard the deadline itself: skipped, nothing sent.
  assert.match(snap.reads[1]!.error ?? '', /phoenix-test critical read skipped: rate-limit cool-down/);
  assert.equal(sent, 0);
  assert.ok(ACCOUNT_READ_DEADLINE_MS > 5_000 && ACCOUNT_READ_DEADLINE_MS < PHOENIX_BUDGET.maxWaitMs.critical);
});

test('accounts: open positions become legs, a flat one does not, a failed read is reported per venue', async () => {
  let t = 0;
  const hl: AccountState = {
    venue: 'hyperliquid', address: '0xdesk', time: 1, equityUsd: 400, freeMarginUsd: 100, maintenanceMarginUsd: 40,
    positions: [
      { symbol: 'ETH', size: -1, entryPx: 2000, liqPx: 2350, marginUsd: 400, unrealizedPnlUsd: 0, leverage: 5, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0 },
      { symbol: 'BTC', size: 0, entryPx: 0, liqPx: null, marginUsd: 0, unrealizedPnlUsd: 0, leverage: 1, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0 },
    ],
  };
  const asked: string[] = [];
  const source = new AccountsDeskSource({
    deskId: 'alpha', owner: 'owner.near', contract: 'gimbal.near', desk: async () => ({ reserveUsd: 12.5, paused: null }), now: () => t,
    lotSize: (venue, symbol) => (venue === 'hyperliquid' && symbol === 'ETH' ? 1e-4 : 1e-8),
    accounts: [
      { reader: { id: 'hyperliquid', account: async (a) => { asked.push(a); t += 150; return hl; } }, address: '0xdesk' },
      { reader: { id: 'phoenix', account: async (a) => { asked.push(a); t += 2_000; throw new Error('phoenix trader: 503'); } }, address: 'Auth111' },
    ],
  });
  const snap = await source.read();
  assert.deepEqual(asked, ['0xdesk', 'Auth111']);
  assert.deepEqual(snap.legs.map((l) => [l.venue, l.symbol, l.position.size, l.lotSize]), [['hyperliquid', 'ETH', -1, 1e-4]]);
  assert.equal(snap.reserveUsd, 12.5);
  assert.deepEqual(snap.reads.map((r) => [r.venue, r.error]), [['hyperliquid', null], ['phoenix', 'phoenix trader: 503']]);
});

test('the reserve and the pause are read again with every snapshot; a read that throws keeps the last answer', async () => {
  const answers: (() => { reserveUsd: number; paused: DeskState['paused'] })[] = [
    () => ({ reserveUsd: 20, paused: null }),
    () => ({ reserveUsd: 5, paused: { by: 'owner', at: 7 } }),
    () => { throw new Error('near rpc: 502'); },
  ];
  const lines: string[] = [];
  let reads = 0;
  const source = new AccountsDeskSource({
    deskId: 'alpha', owner: 'owner.near', contract: 'gimbal.near', accounts: [], log: (l) => lines.push(l),
    desk: async () => answers[reads++]!(),
  });
  const first = await source.read();
  assert.deepEqual([first.reserveUsd, first.paused], [20, null]);
  const second = await source.read();
  assert.deepEqual([second.reserveUsd, second.paused], [5, { by: 'owner', at: 7 }]);
  const third = await source.read();
  assert.deepEqual([third.reserveUsd, third.paused], [5, { by: 'owner', at: 7 }]);
  assert.equal(reads, 3);
  assert.match(lines.join(' | '), /desk view could not be read, keeping the last one: near rpc: 502/);
});

test('a slow get_desk does not hold the snapshot: it waits at most deskWaitMs, says how late, and reads one at a time', async () => {
  let calls = 0;
  let answer!: (d: { reserveUsd: number; paused: DeskState['paused'] }) => void;
  let t = 50_000;
  const source = new AccountsDeskSource({
    deskId: 'alpha', owner: 'owner.near', contract: 'gimbal.near', accounts: [], now: () => t, deskWaitMs: 20,
    desk: () => { calls++; return calls === 1 ? new Promise((r) => { answer = r; }) : Promise.resolve({ reserveUsd: 31, paused: null }); },
  });
  const started = Date.now();
  const first = await source.read();
  assert.ok(Date.now() - started < 1_000, 'not stalled');
  assert.deepEqual([first.reserveUsd, first.paused], [0, null]);
  assert.deepEqual(first.deskView, { at: null, error: 'get_desk has not answered for 0 s' });
  t += 7_000;
  const second = await source.read();
  assert.equal(calls, 1, 'no second read while one is out');
  assert.match(second.deskView!.error!, /has not answered for 7 s/);
  answer({ reserveUsd: 30, paused: null });
  await new Promise((r) => setImmediate(r));
  const third = await source.read();
  assert.equal(calls, 2, 'a fresh read starts with the next snapshot');
  assert.equal(third.reserveUsd, 31);
  assert.deepEqual(third.deskView, { at: t, error: null });
});
