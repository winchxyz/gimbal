// AccountsDeskSource: every open position on the desk's accounts is a leg; a failed account read is reported with
// how long it took, and the others still come in.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeskState } from '@gimbal/shared';
import type { AccountState } from '../venues/venue.ts';
import { AccountsDeskSource } from './sources.ts';

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
