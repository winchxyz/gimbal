import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Leg } from '@gimbal/shared';
import { rescueEstimate, safetyAnswer, safetyText } from './answer.ts';

const RISK = { watchDistancePct: 15, rescueDistancePct: 8 };
const leg = (venue: Leg['venue'], distanceToLiqPct: number | null): Leg => ({
  venue, symbol: 'MON', side: 'short', size: 716, lotSize: 1, entry: 0.016, mark: 0.016, liqPx: 0.024, marginUsd: 8, marginRatio: 0.15,
  distanceToLiqPct, fundingEarnedUsd: 0, unsettledFundingUsd: 0, feesUsd: 0, unpriced: false,
});

test('standing by: both legs far, or the nearer one named and coloured by the owner thresholds', () => {
  const far = safetyAnswer({ desk: { legs: [leg('hyperliquid', 52.4), leg('phoenix', 83)], rescueFailure: null }, rescue: null, risk: RISK });
  assert.equal(safetyText(far), 'Both legs are far from liquidation. The rescue stands by.');
  assert.equal(far.figure, null);
  const watch = safetyAnswer({ desk: { legs: [leg('hyperliquid', 12), leg('phoenix', 83)], rescueFailure: null }, rescue: null, risk: RISK });
  assert.equal(safetyText(watch), 'The Hyperliquid leg is 12% from liquidation, inside the 15% watch line. The rescue is ready.');
  assert.equal(watch.tone, 'watch-t');
  const under = safetyAnswer({ desk: { legs: [leg('hyperliquid', 6)], rescueFailure: null }, rescue: null, risk: RISK });
  assert.equal(safetyText(under), 'The leg is 6% from liquidation, under the 8% rescue line.');
  assert.equal(under.tone, 'down');
  // No thresholds read: the figure, uncoloured.
  const plain = safetyAnswer({ desk: { legs: [leg('hyperliquid', 52)], rescueFailure: null }, rescue: null, risk: null });
  assert.equal(safetyText(plain), 'The leg is 52% from liquidation. Standing by.');
  assert.equal(plain.tone, null);
  // One leg not read yet: never "both far".
  assert.equal(
    safetyText(safetyAnswer({ desk: { legs: [leg('hyperliquid', 60), leg('phoenix', null)], rescueFailure: null }, rescue: null, risk: RISK })),
    'The Hyperliquid leg is 60% from liquidation; the other leg is not read yet. Standing by.',
  );
});

test('the rescue estimate is the engine check, read as it is', () => {
  assert.deepEqual(rescueEstimate([{ text: 'Capacity $40k' }, { text: 'Rescue of $0.84 from the reserve costs up to $0.32 a move (Intents)' }]), { amountUsd: 0.84, costUsd: 0.32 });
  assert.equal(rescueEstimate([{ text: 'Capacity $40k' }]), null);
  assert.equal(rescueEstimate(null), null);
});

test('a rescue, a failed rescue, no position, no desk', () => {
  const legs = [leg('hyperliquid', 6), leg('phoenix', 83)];
  assert.equal(safetyText(safetyAnswer({ desk: { legs, rescueFailure: null }, rescue: { step: 'quote', to: 'hyperliquid' }, risk: RISK })), 'A rescue is moving margin to Hyperliquid now.');
  // A landed rescue is history: the sentence is back to the legs.
  assert.equal(safetyText(safetyAnswer({ desk: { legs, rescueFailure: null }, rescue: { step: 'landed', to: 'hyperliquid' }, risk: RISK })), 'The Hyperliquid leg is 6% from liquidation, under the 8% rescue line.');
  const failure = { rescueId: 'r', step: 'quote' as const, reason: 'x', at: 0 };
  assert.equal(safetyText(safetyAnswer({ desk: { legs, rescueFailure: failure } as never, rescue: null, risk: RISK })), 'A rescue could not finish and needs the owner.');
  assert.equal(safetyText(safetyAnswer({ desk: { legs: [], rescueFailure: null }, rescue: null, risk: RISK })), 'No position is open. Standing by.');
  assert.equal(safetyText(safetyAnswer({ desk: null, rescue: null, risk: RISK })), 'No desk yet, so there is nothing to rescue.');
});
