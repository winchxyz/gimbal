import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState, Leg, Window as FundingWindow } from '@gimbal/shared';
import { statusOf } from '../shell/status.ts';
import { answerText, deskAnswer, distanceTone, downSentence, moneyTone, ratePct, rateTone } from './answer.ts';

const RISK = { watchDistancePct: 15, rescueDistancePct: 8 };

const leg = (venue: Leg['venue'], side: Leg['side'], distanceToLiqPct: number): Leg => ({
  venue, symbol: 'MON', side, size: 716, lotSize: 1, entry: 0.016, mark: 0.016, liqPx: 0.024, marginUsd: 8, marginRatio: 0.15,
  distanceToLiqPct, fundingEarnedUsd: 0, unsettledFundingUsd: 0, feesUsd: -0.003, unpriced: false,
});

const desk = (health: DeskState['health'], legs: Leg[]): DeskState => ({
  deskId: 'carry', owner: 'o.near', contract: 'c.near', mode: 'mainnet', legs, netDelta: 0, equityUsd: 38.08, reserveUsd: 7.68,
  pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 }, health, paused: null, rescueFailure: null, updatedAt: 0,
});

const held = (netAprPct: number): FundingWindow => ({ symbol: 'MON', netAprPct } as FundingWindow);

const answer = (health: DeskState['health'], legs: Leg[], net: number | null) => {
  const d = desk(health, legs);
  return deskAnswer({ desk: d, held: net === null ? null : held(net), view: statusOf(d) });
};

test('level: the rate earns in mint and both legs are safe', () => {
  const a = answer('level', [leg('hyperliquid', 'short', 52), leg('phoenix', 'long', 83)], 43.2);
  assert.equal(answerText(a), 'Earning 43% a year on MON. Both legs are safe.');
  assert.equal(a.tone, 'up');
});

test('loss: the held pair loses, so the sentence says Losing and the rate is coral', () => {
  const a = answer('level', [leg('hyperliquid', 'short', 52), leg('phoenix', 'long', 83)], -12.4);
  assert.equal(answerText(a), 'Losing 12% a year on MON. Both legs are safe.');
  assert.equal(a.tone, 'down');
});

test('watch and danger: the safety sentence follows the desk state', () => {
  assert.equal(answerText(answer('watch', [leg('hyperliquid', 'short', 14), leg('phoenix', 'long', 83)], 43)), 'Earning 43% a year on MON. One leg needs watching.');
  assert.equal(answerText(answer('rescue', [leg('hyperliquid', 'short', 6), leg('phoenix', 'long', 83)], 43)), 'Earning 43% a year on MON. A rescue is moving margin now.');
  assert.equal(answerText(answer('level', [], null)), 'No position is open.');
  assert.equal(answerText(answer('level', [leg('hyperliquid', 'short', 52)], null)), 'Holding MON. The leg is safe.');
});

test('distance to liquidation: mint above the watch line, amber between the lines, coral under the rescue line', () => {
  assert.equal(distanceTone(52, RISK), 'up');
  assert.equal(distanceTone(14, RISK), 'watch-t');
  assert.equal(distanceTone(8.5, RISK), 'watch-t');
  assert.equal(distanceTone(6, RISK), 'down');
  assert.equal(distanceTone(null, RISK), null);
  assert.equal(distanceTone(52, null), null, 'no thresholds read yet: no colour that may be wrong');
});

test('money and rates: mint earned, coral lost, nothing for zero', () => {
  assert.equal(moneyTone(0.01), 'up');
  assert.equal(moneyTone(-0.004, 3), 'down');
  assert.equal(moneyTone(0.0001), null, 'rounds to $0.00');
  assert.equal(moneyTone(null), null);
  assert.equal(rateTone(19), 'up');
  assert.equal(rateTone(-2), 'down');
  assert.equal(rateTone(0), null);
  assert.equal(ratePct(43.2), '43%');
  assert.equal(ratePct(-4.46), '4.5%');
});

test('a venue down: the desk holds and reads it again', () => {
  assert.equal(downSentence('Hyperliquid not answering'), 'Hyperliquid is not answering; the desk holds and reads it again.');
  assert.equal(downSentence('Hyperliquid and Phoenix not answering'), 'Hyperliquid and Phoenix are not answering; the desk holds and reads them again.');
});
