// The sentence that opens Safety (UX, Safety: "how far from liquidation, and who can do what"): the nearest leg's
// distance to liquidation, then "Standing by" or the rescue in progress. Pure, so the words and colours are tested.
import type { DeskState, RescueProgress, StrategyConfig } from '@gimbal/shared';
import { distanceTone, type Tone } from '../desk/answer.ts';
import { VENUE_NAMES } from '../shell/status.ts';

export interface SafetyAnswer {
  /** Before the figure: `The nearest leg is ` */
  lead: string;
  /** `52%`, coloured by `tone`; null when there is no figure in the sentence. */
  figure: string | null;
  tone: Tone;
  /** After the figure: ` from liquidation. Standing by.` */
  rest: string;
}

/** `52%`: whole, as the Desk row shows it. */
const whole = (v: number): string => `${Math.round(v)}%`;

export function safetyAnswer({
  desk,
  rescue,
  risk,
}: {
  desk: Pick<DeskState, 'legs' | 'rescueFailure'> | null;
  rescue: Pick<RescueProgress, 'step' | 'to'> | null;
  risk: StrategyConfig['risk'] | null;
}): SafetyAnswer {
  const plain = (rest: string): SafetyAnswer => ({ lead: '', figure: null, tone: null, rest });
  if (desk?.rescueFailure) return plain('A rescue could not finish and needs the owner.');
  if (rescue && rescue.step !== 'landed' && rescue.step !== 'failed') return plain(`A rescue is moving margin to ${VENUE_NAMES[rescue.to]} now.`);
  if (desk === null) return plain('No desk yet, so there is nothing to rescue.');
  const measured = desk.legs.filter((l) => l.distanceToLiqPct !== null);
  if (desk.legs.length === 0) return plain('No position is open. Standing by.');
  if (measured.length === 0) return plain('Standing by. The distance to liquidation is not read yet.');
  const nearest = measured.reduce((a, b) => (b.distanceToLiqPct! < a.distanceToLiqPct! ? b : a));
  const d = nearest.distanceToLiqPct!;
  const both = desk.legs.length >= 2;
  // Every leg read and above the watch line: the book's sentence, no figure (the legs under it give each one).
  if (risk !== null && measured.length === desk.legs.length && d > risk.watchDistancePct) {
    return plain(both ? 'Both legs are far from liquidation. The rescue stands by.' : 'The leg is far from liquidation. The rescue stands by.');
  }
  const which = both ? `The ${VENUE_NAMES[nearest.venue]} leg is ` : 'The leg is ';
  if (risk === null) return { lead: which, figure: whole(d), tone: null, rest: ' from liquidation. Standing by.' };
  const tone = distanceTone(d, risk);
  // The nearest leg read is far, but another is not read yet: never "inside the watch line", never "both far".
  if (d > risk.watchDistancePct) return { lead: which, figure: whole(d), tone, rest: ' from liquidation; the other leg is not read yet. Standing by.' };
  return {
    lead: which,
    figure: whole(d),
    tone,
    rest:
      d > risk.rescueDistancePct
        ? ` from liquidation, inside the ${risk.watchDistancePct}% watch line. The rescue is ready.`
        : ` from liquidation, under the ${risk.rescueDistancePct}% rescue line.`,
  };
}

/**
 * What a rescue of the held pair would move and cost, from the engine's own check on the window ("Rescue of $0.84 from
 * the reserve costs up to $0.32 a move"). Null when the window has no such check: nothing is worked out here.
 */
export function rescueEstimate(checks: readonly { text: string }[] | null | undefined): { amountUsd: number; costUsd: number } | null {
  for (const c of checks ?? []) {
    const m = /^Rescue of \$([0-9.]+) from the reserve costs up to \$([0-9.]+) a move/.exec(c.text);
    if (m) return { amountUsd: Number(m[1]), costUsd: Number(m[2]) };
  }
  return null;
}

export const safetyText = (a: SafetyAnswer): string => `${a.lead}${a.figure ?? ''}${a.rest}`;
