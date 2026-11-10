import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Leg } from '@gimbal/shared';
import { linesSentence, noRoomText, roomOf, roomSentence, roomTone } from './room.ts';

const RISK = { watchDistancePct: 15, rescueDistancePct: 8 };

const leg = (over: Partial<Leg>): Leg => ({
  venue: 'phoenix',
  symbol: 'MON',
  side: 'long',
  size: 100,
  lotSize: 1,
  entry: 1,
  mark: 1,
  liqPx: 0.2,
  marginUsd: 10,
  marginRatio: 0.3,
  distanceToLiqPct: 80,
  fundingEarnedUsd: 0,
  unsettledFundingUsd: 0,
  feesUsd: 0,
  unpriced: false,
  ...over,
});
const short = (distanceToLiqPct: number | null, over: Partial<Leg> = {}): Leg =>
  leg({ venue: 'hyperliquid', side: 'short', size: -100, liqPx: distanceToLiqPct === null ? null : 1.6, distanceToLiqPct, ...over });

test('a level pair says how far the price can go before a rescue, rounded toward the safe side', () => {
  const room = roomOf([leg({}), short(60)], RISK)!;
  assert.equal(room.symbol, 'MON');
  assert.equal(room.corridor.lo, -80);
  assert.equal(room.corridor.hi, 60);
  assert.equal(roomSentence(room, RISK), 'MON can rise 48% or fall 78% before a rescue starts.');
  assert.equal(roomTone(room, RISK), 'up');
  assert.equal(linesSentence(RISK), 'A leg is watched once it is within 15% of its liquidation price and rescued at 8%.');
});

test('a leg inside a line is named with its distance and the line it crossed', () => {
  const watched = roomOf([leg({}), short(12.4)], RISK)!;
  assert.equal(
    roomSentence(watched, RISK),
    'The short on Hyperliquid is 12.4% from its liquidation price, inside the 15% watch line; a rescue starts if MON rises another 4%.',
  );
  assert.equal(roomTone(watched, RISK), 'watch-t');
  const rescued = roomOf([leg({}), short(6.1)], RISK)!;
  assert.equal(roomSentence(rescued, RISK), 'The short on Hyperliquid is 6.1% from its liquidation price, inside the 8% rescue line.');
  assert.equal(roomTone(rescued, RISK), 'down');
});

test('without the owner’s rules only the two ends are said, and nothing is coloured', () => {
  const room = roomOf([leg({}), short(60)], null)!;
  assert.equal(roomSentence(room, null), 'MON would have to rise 60% or fall 80% to liquidate a leg.');
  assert.equal(roomTone(room, null), null);
  assert.equal(linesSentence(null), null);
});

test('half a corridor is never drawn: one leg, or a venue with no liquidation price', () => {
  assert.equal(roomOf([leg({})], RISK), null);
  assert.match(noRoomText([leg({})]), /^Only one leg is open/);
  const silent = [leg({}), short(null)];
  assert.equal(roomOf(silent, RISK), null);
  assert.match(noRoomText(silent), /^Hyperliquid gives no liquidation price right now/);
});
