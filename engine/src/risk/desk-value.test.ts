// The desk value (DeskState.equityUsd): the reserve plus every venue account's equity, each account once, with or
// without a position. A flat desk counts its idle venue money too; an account never read adds nothing and is listed as
// unread (equityUsd null); a failed read keeps the account's last equity. And the journal of an account read that fails
// while its private session is in its first open (serve starting): a wait, not "not answering".

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeskState, StreamEvent, VenueId } from '@gimbal/shared';
import { DEFAULT_STRATEGY } from '../scanner/config.ts';
import type { AccountState, Position } from '../venues/venue.ts';
import { SESSION_STARTING } from '../venues/venue.ts';
import { RiskEngine } from './engine.ts';
import { AccountsDeskSource } from './sources.ts';
import { VenueHealth } from './venue-health.ts';

const RESERVE = 7.68;

function account(venue: VenueId, equityUsd: number, positions: Position[] = []): AccountState {
  return { venue, address: venue, time: 1, equityUsd, freeMarginUsd: equityUsd, maintenanceMarginUsd: 0, positions };
}

function position(symbol: string, size: number): Position {
  return { symbol, size, entryPx: 100, liqPx: null, marginUsd: 5, unrealizedPnlUsd: 0, leverage: 2, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0 };
}

/** A desk on three venue accounts; `reads[venue]` answers the next read (an Error fails it). */
function desk(reads: Record<VenueId, () => AccountState | Error>) {
  const reader = (id: VenueId) => ({
    reader: {
      id,
      account: async () => {
        const r = reads[id]();
        if (r instanceof Error) throw r;
        return r;
      },
    },
    address: id,
  });
  const source = new AccountsDeskSource({
    deskId: 'carry', owner: 'owner.near', contract: 'gimbal.near',
    accounts: [reader('hyperliquid'), reader('phoenix'), reader('orderly')],
    desk: async () => ({ reserveUsd: RESERVE, paused: null }),
  });
  const events: StreamEvent[] = [];
  let t = 1_000_000;
  const risk = new RiskEngine({
    mode: 'mainnet', source, strategy: () => DEFAULT_STRATEGY, health: new VenueHealth(), publish: (e) => events.push(e),
    clock: { now: () => (t += 5_000) },
  });
  return { risk, events };
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const byVenue = (d: DeskState) => Object.fromEntries((d.accounts ?? []).map((a) => [a.venue, a.equityUsd]));

test('flat, every venue read: the value is the reserve plus each account, not the reserve alone', async () => {
  const { risk } = desk({
    hyperliquid: () => account('hyperliquid', 7.68),
    phoenix: () => account('phoenix', 0.02),
    orderly: () => account('orderly', 13.05),
  });
  const d = (await risk.tick())!;
  assert.equal(d.legs.length, 0);
  close(d.equityUsd, RESERVE + 7.68 + 0.02 + 13.05);
  close(d.reserveUsd, RESERVE);
  assert.deepEqual(byVenue(d), { hyperliquid: 7.68, phoenix: 0.02, orderly: 13.05 });
  assert.ok(d.accounts!.every((a) => a.at === d.updatedAt));
});

test('one venue never read: it adds nothing and is listed as unread; a later read counts it; a failed read keeps it', async () => {
  let orderly: AccountState | Error = new Error('orderly account unknown: the private session is opening');
  const { risk } = desk({
    hyperliquid: () => account('hyperliquid', 7.68),
    phoenix: () => account('phoenix', 0),
    orderly: () => orderly,
  });
  const first = (await risk.tick())!;
  close(first.equityUsd, RESERVE + 7.68);
  assert.deepEqual(byVenue(first), { hyperliquid: 7.68, phoenix: 0, orderly: null });
  assert.equal(first.accounts!.find((a) => a.venue === 'orderly')!.at, null);

  orderly = account('orderly', 13);
  const second = (await risk.tick())!;
  close(second.equityUsd, RESERVE + 7.68 + 13);
  const readAt = second.accounts!.find((a) => a.venue === 'orderly')!.at;
  assert.equal(readAt, second.updatedAt);

  // The session drops: Orderly keeps its last equity and the time it was read.
  orderly = new Error('orderly account unknown: the private session is down');
  const third = (await risk.tick())!;
  close(third.equityUsd, RESERVE + 7.68 + 13);
  assert.equal(third.accounts!.find((a) => a.venue === 'orderly')!.at, readAt);
  assert.ok(third.updatedAt > readAt!);
});

test('holding a pair: each account counted once (two positions on one venue too), and a flat third account counts', async () => {
  const { risk } = desk({
    // Short on Hyperliquid, and a stray second position on the same account: one account, one equity.
    hyperliquid: () => account('hyperliquid', 20, [position('ETH', -0.1), position('BTC', 0.001)]),
    phoenix: () => account('phoenix', 4),
    orderly: () => account('orderly', 18, [position('PERP_ETH_USDC', 0.1)]),
  });
  const d = (await risk.tick())!;
  assert.equal(d.legs.length, 3);
  close(d.equityUsd, RESERVE + 20 + 4 + 18);
  assert.deepEqual(byVenue(d), { hyperliquid: 20, phoenix: 4, orderly: 18 });
});

test('a venue whose session is in its first open is journaled once as starting (a wait); if that open fails, an error follows', async () => {
  let orderly: AccountState | Error = new Error(`orderly account unknown: ${SESSION_STARTING} (its first open runs)`);
  const { risk, events } = desk({
    hyperliquid: () => account('hyperliquid', 7.68),
    phoenix: () => account('phoenix', 0),
    orderly: () => orderly,
  });
  const journal = () => events.flatMap((e) => (e.type === 'journal' && e.data.numbers.venue === 'orderly' ? [`${e.data.kind}: ${e.data.summary}`] : []));
  await risk.tick();
  await risk.tick();
  assert.deepEqual(journal(), [`wait: orderly session starting: its account is read once the session is up (orderly account unknown: ${SESSION_STARTING} (its first open runs))`]);
  // The open failed: the word stays down, the reason is now a failure, journaled once the spell (from the start of
  // the wait) lasted DOWN_JOURNAL_AFTER_MS: no leg is held there, so nothing is judged on stale numbers meanwhile.
  orderly = new Error('orderly account unknown: the private session is down (login refused)');
  await risk.tick();
  await risk.tick();
  assert.equal(journal().length, 1, '20 s in: not yet');
  for (let i = 0; i < 3; i++) await risk.tick();
  assert.equal(journal().length, 2);
  assert.equal(journal()[1], 'error: orderly not answering for 30 s: orderly account unknown: the private session is down (login refused)');
  // Up: the outage's end, with its length. Then a drop: an error again once it lasts (never "starting" after the
  // first open).
  orderly = account('orderly', 13);
  await risk.tick();
  assert.match(journal()[2]!, /^wait: orderly answering again after 35 s unreadable/);
  orderly = new Error('orderly account unknown: the private session is down (closed 1006)');
  for (let i = 0; i < 7; i++) await risk.tick();
  assert.equal(journal().length, 4);
  assert.match(journal()[3]!, /^error: orderly not answering for 30 s: .*closed 1006/);
});
