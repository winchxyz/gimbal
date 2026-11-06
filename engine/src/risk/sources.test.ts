// AccountsDeskSource: every open position on the desk's accounts is a leg; a failed account read is reported with
// how long it took, and the others still come in; a read held up by a venue's request budget gives up at its deadline;
// a leg's fees are the book's for its open position (the `fees` option), else 0.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeskState } from '@gimbal/shared';
import { DEFAULT_STRATEGY } from '../scanner/config.ts';
import { HostBudget, PHOENIX_BUDGET, readClass } from '../venues/http-budget.ts';
import type { AccountState } from '../venues/venue.ts';
import { RiskEngine } from './engine.ts';
import type { AccountsDeskSourceOptions } from './sources.ts';
import { ACCOUNT_READ_DEADLINE_MS, AccountsDeskSource } from './sources.ts';
import { VenueHealth } from './venue-health.ts';

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

/** The live XLM pair: short 74 on Hyperliquid, long 74 on Phoenix, marked at entry; plus an ETH short the book never entered. */
function xlmAccounts(): AccountsDeskSourceOptions['accounts'] {
  const position = (symbol: string, size: number, entryPx: number, fundingSinceOpenUsd: number) => ({
    symbol, size, entryPx, liqPx: null, marginUsd: 10, unrealizedPnlUsd: 0, leverage: 1, fundingSinceOpenUsd, unsettledFundingUsd: 0,
  });
  const hl: AccountState = {
    venue: 'hyperliquid', address: '0xdesk', time: 1, equityUsd: 20, freeMarginUsd: 10, maintenanceMarginUsd: 0.5,
    positions: [position('XLM', -74, 0.27, 0.004), position('ETH', -0.001, 3000, 0)],
  };
  const px: AccountState = {
    venue: 'phoenix', address: 'Auth111', time: 1, equityUsd: 20, freeMarginUsd: 10, maintenanceMarginUsd: 0.5, positions: [position('XLM', 74, 0.27, -0.001)],
  };
  return [
    { reader: { id: 'hyperliquid', account: async () => hl }, address: '0xdesk' },
    { reader: { id: 'phoenix', account: async () => px }, address: 'Auth111' },
  ];
}

async function deskOf(source: AccountsDeskSource): Promise<DeskState> {
  let t = 1_000_000;
  const risk = new RiskEngine({
    mode: 'mainnet', source, strategy: () => DEFAULT_STRATEGY, health: new VenueHealth(), publish: () => {}, clock: { now: () => (t += 5_000) },
  });
  try {
    return (await risk.tick())!;
  } finally {
    await risk.stop();
  }
}

test('live legs carry the fees the book booked for the open position: in each leg, pnl.feesUsd and pnl.netUsd', async () => {
  const asked: string[] = [];
  const booked: Record<string, number> = { 'hyperliquid XLM short': -0.0041, 'phoenix XLM long': -0.0027 };
  const d = await deskOf(new AccountsDeskSource({
    deskId: 'alpha', owner: 'owner.near', contract: 'gimbal.near', accounts: xlmAccounts(),
    fees: (venue, symbol, side) => {
      asked.push(`${venue} ${symbol} ${side}`);
      const usd = booked[`${venue} ${symbol} ${side}`];
      return usd === undefined ? null : { usd, positionId: 'xlm@1' };
    },
  }));
  // Each leg asked with the side of the venue position's sign.
  assert.deepEqual(asked, ['hyperliquid XLM short', 'hyperliquid ETH short', 'phoenix XLM long']);
  assert.deepEqual(d.legs.map((l) => [l.venue, l.symbol, l.feesUsd, l.feesPositionId]), [
    ['hyperliquid', 'XLM', -0.0041, 'xlm@1'], ['hyperliquid', 'ETH', 0, undefined], ['phoenix', 'XLM', -0.0027, 'xlm@1'],
  ]);
  assert.ok(!('feesPositionId' in d.legs[1]!), 'no position named where the book has none');
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);
  near(d.pnl.feesUsd, -0.0068, 'fees');
  near(d.pnl.fundingUsd, 0.003, 'funding');
  near(d.pnl.netUsd, 0.003 - 0.0068 + d.pnl.priceUsd, 'net');
});

test('live legs with no book, no open position booked, or a book that throws: fees 0, nothing invented', async () => {
  const base = { deskId: 'alpha', owner: 'owner.near', contract: 'gimbal.near' };
  const lines: string[] = [];
  const sources = {
    'no book (monitor)': new AccountsDeskSource({ ...base, accounts: xlmAccounts() }),
    'book not loaded yet, or nothing open': new AccountsDeskSource({ ...base, accounts: xlmAccounts(), fees: () => null }),
    'not a number': new AccountsDeskSource({ ...base, accounts: xlmAccounts(), fees: () => ({ usd: Number.NaN, positionId: 'xlm@1' }) }),
    'throws': new AccountsDeskSource({ ...base, accounts: xlmAccounts(), log: (l) => lines.push(l), fees: () => { throw new Error('book: torn line'); } }),
  };
  for (const [what, source] of Object.entries(sources)) {
    const d = await deskOf(source);
    assert.deepEqual(d.legs.map((l) => [l.feesUsd, l.feesPositionId]), [[0, undefined], [0, undefined], [0, undefined]], what);
    assert.equal(d.pnl.feesUsd, 0, what);
    assert.equal(d.pnl.netUsd, d.pnl.fundingUsd + d.pnl.priceUsd, what);
  }
  // Logged once per message, not once per leg and tick.
  assert.deepEqual(lines, ['risk: the hyperliquid XLM leg\'s fees could not be read from the book, shown as 0: book: torn line']);
});

test('a fees error is logged once while it lasts; after a read whose fees all came through, the same error is logged again', async () => {
  const lines: string[] = [];
  let failing = true;
  const source = new AccountsDeskSource({
    deskId: 'alpha', owner: 'owner.near', contract: 'gimbal.near', accounts: xlmAccounts(), log: (l) => lines.push(l),
    fees: () => {
      if (failing) throw new Error('book: torn line');
      return null;
    },
  });
  await source.read();
  await source.read();
  assert.equal(lines.length, 1, 'once while it lasts');
  failing = false;
  await source.read();
  failing = true;
  await source.read();
  assert.equal(lines.length, 2, 'again after the recovery');
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
