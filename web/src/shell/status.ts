// What the status line says for a desk (design/HANDOFF.md, Desk: Status line). Pure, so it is tested.
import type { DeskState, Leg, VenueId } from '@gimbal/shared';

export type StatusTone = 'level' | 'watch' | 'rescuing' | 'waiting';

export interface StatusView {
  tone: StatusTone;
  word: string;
  sentence: string;
}

export const VENUE_NAMES: Record<VenueId, string> = {
  hyperliquid: 'Hyperliquid',
  phoenix: 'Phoenix',
  orderly: 'Orderly',
};

// Paused and Needs you come with the Desk screen: DeskState carries no pause flag or rescue failure yet.
export function statusOf(desk: DeskState): StatusView {
  const nearest = nearestToLiquidation(desk.legs);
  if (!nearest) return { tone: 'waiting', word: 'Waiting', sentence: 'No position is open.' };
  const leg = `${VENUE_NAMES[nearest.venue]} ${nearest.side}`;
  switch (desk.health) {
    case 'rescue':
      return { tone: 'rescuing', word: 'Rescuing', sentence: `The desk is moving margin to the ${leg} now.` };
    case 'watch':
      return {
        tone: 'watch',
        word: 'Watch',
        sentence:
          nearest.distanceToLiqPct === null
            ? `The ${leg} is close to liquidation.`
            : `The ${leg} is ${nearest.distanceToLiqPct.toFixed(1)}% from liquidation.`,
      };
    case 'level':
      return { tone: 'level', word: 'Level', sentence: 'Both legs are safe.' };
  }
}

function nearestToLiquidation(legs: Leg[]): Leg | undefined {
  return legs.reduce<Leg | undefined>((best, leg) => {
    if (!best) return leg;
    return (leg.distanceToLiqPct ?? Infinity) < (best.distanceToLiqPct ?? Infinity) ? leg : best;
  }, undefined);
}
