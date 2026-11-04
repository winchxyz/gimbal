// What the status line says for a desk (design/HANDOFF.md, Desk: Status line). Pure, so it is tested.
import type { DeskState, Leg, Mode, VenueId } from '@gimbal/shared';
import { dayMonthTime, sentence } from '../windows/format.ts';

export type StatusTone = 'level' | 'watch' | 'rescuing' | 'needs' | 'paused' | 'waiting' | 'down';

export interface StatusView {
  tone: StatusTone;
  word: string;
  sentence: string;
  /** A second sentence in grey: the engine's own words about a failed rescue. */
  detail?: string;
}

export const VENUE_NAMES: Record<VenueId, string> = {
  hyperliquid: 'Hyperliquid',
  phoenix: 'Phoenix',
  orderly: 'Orderly',
};

/** What the status line cannot know from the desk alone. Every field is optional: without it the plain wording is used. */
export interface StatusContext {
  /** Venues the desk has a leg on and the engine cannot read right now (`downVenues`). */
  down?: readonly VenueId[];
  /** The owner's minimum and the best window open to the desk, for the Waiting sentence. */
  minNetAprPct?: number | null;
  bestNetAprPct?: number | null;
  /** `StrategyConfig.auto`: with it off, Waiting says the desk is only watching. */
  auto?: boolean | null;
  /**
   * A remote read-only view: the engine masks the owner's and the operator's account ids there ("gimb…near"), so
   * `paused.by` is a label to show as it came, never something to compare with `owner` to say "you".
   */
  remote?: boolean;
}

/**
 * The first line that applies wins, in the order of docs/interfaces.md §2 next to `RescueFailure`:
 * Needs you, Paused, Rescuing, Watch, Waiting (no legs), Level. One state is added in front of that list
 * after Needs you: a venue that does not answer (a red line that names it), because the numbers for that
 * leg are then the last ones read. It only applies when `context.down` is given.
 */
export function statusOf(desk: DeskState, context: StatusContext = {}): StatusView {
  const nearest = nearestToLiquidation(desk.legs);
  const leg = nearest ? `${VENUE_NAMES[nearest.venue]} ${nearest.side}` : null;

  if (desk.rescueFailure) {
    const f = desk.rescueFailure;
    const where =
      nearest && leg
        ? nearest.distanceToLiqPct === null
          ? ` The ${leg} is close to liquidation.`
          : ` The ${leg} is now ${nearest.distanceToLiqPct.toFixed(1)}% from liquidation.`
        : '';
    return {
      tone: 'needs',
      word: 'Needs you',
      sentence: `The rescue could not finish.${where}`,
      detail: `${sentence(f.reason)} Tried ${f.tries} ${f.tries === 1 ? 'time' : 'times'}. ${sentence(f.next)}`,
    };
  }

  const down = context.down ?? [];
  const lost = desk.legs.filter((l) => down.includes(l.venue));
  if (lost.length > 0) {
    const names = joinNames(lost.map((l) => VENUE_NAMES[l.venue]));
    return {
      tone: 'down',
      word: `${names} not answering`,
      sentence: `Its figures may be old. Your ${joinNames(lost.map((l) => l.side))} ${lost.length === 1 ? 'is' : 'are'} still open on the exchange and the contract still enforces your policy.`,
    };
  }

  if (desk.paused) {
    const by = !context.remote && desk.paused.by === desk.owner ? 'you' : desk.paused.by;
    return {
      tone: 'paused',
      word: 'Paused',
      sentence: `Paused by ${by} on ${dayMonthTime(desk.paused.at)} UTC. No new position opens. Rescues and closing still work.`,
    };
  }

  if (desk.health === 'rescue') {
    return {
      tone: 'rescuing',
      word: 'Rescuing',
      sentence: leg ? `The desk is moving margin to the ${leg} now.` : 'The desk is moving margin now.',
    };
  }

  if (desk.health === 'watch') {
    return {
      tone: 'watch',
      word: 'Watch',
      sentence:
        !nearest || !leg
          ? 'A leg is close to liquidation.'
          : nearest.distanceToLiqPct === null
            ? `The ${leg} is close to liquidation.`
            : `The ${leg} is ${nearest.distanceToLiqPct.toFixed(1)}% from liquidation.`,
    };
  }

  if (!nearest) return { tone: 'waiting', word: 'Waiting', sentence: waitingSentence(context) };

  const both = desk.legs.length === 2 && desk.legs.every((l) => l.fundingEarnedUsd > 0);
  return {
    tone: 'level',
    word: 'Level',
    sentence: both ? 'Both legs are safe. Funding is coming in on both sides.' : 'Both legs are safe.',
  };
}

function waitingSentence({ minNetAprPct, bestNetAprPct, auto }: StatusContext): string {
  if (auto === false) return 'No position is open. Auto is off, so the desk only watches.';
  const belowMinimum = bestNetAprPct === null || bestNetAprPct === undefined || bestNetAprPct < (minNetAprPct ?? 0);
  if (typeof minNetAprPct === 'number' && minNetAprPct > 0 && belowMinimum) {
    return `No window clears your ${Number.isInteger(minNetAprPct) ? minNetAprPct : minNetAprPct.toFixed(1)}% minimum right now.`;
  }
  return 'No position is open.';
}

export function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function nearestToLiquidation(legs: Leg[]): Leg | undefined {
  return legs.reduce<Leg | undefined>((best, leg) => {
    if (!best) return leg;
    return (leg.distanceToLiqPct ?? Infinity) < (best.distanceToLiqPct ?? Infinity) ? leg : best;
  }, undefined);
}

/** The venues of this desk's legs that the engine reports as down (`HealthMap`, docs/interfaces.md §2). */
export function downVenues(desk: DeskState, health: Partial<Record<string, 'ok' | 'slow' | 'down'>> | null): VenueId[] {
  if (!health) return [];
  const venues = desk.legs.map((l) => l.venue);
  return venues.filter((v, i) => venues.indexOf(v) === i && health[v] === 'down');
}

// ---------- what the owner can do from the status line ----------

export type ActionId = 'auto' | 'pause' | 'resume' | 'close' | 'add-margin';

export interface StatusAction {
  id: ActionId;
  label: string;
  /** `quiet` has no outline, `primary` is the filled pill. */
  style: 'quiet' | 'plain' | 'primary';
}

export interface StatusActionsView {
  /** Text in place of buttons: Rescuing needs nothing from the owner. */
  note: string | null;
  buttons: StatusAction[];
}

export interface ActionsContext {
  /** `StrategyConfig.auto`, or null while it is unknown (no Auto button then). */
  auto: boolean | null;
  screen: 'desk' | 'rescue';
  mode: Mode;
}

// design/HANDOFF.md, Desk: Status line, "Actions" column. Pause and Resume are the owner's wallet signing
// `set_paused`; Close and Add margin are engine and wallet calls. None of them is connected yet, so the
// buttons say "Not sent" when pressed (StatusActions.tsx).
export function actionsOf(view: StatusView, { auto, screen, mode }: ActionsContext): StatusActionsView {
  const none: StatusActionsView = { note: null, buttons: [] };
  // A replay is read-only and has no wallet: there is nothing to pause, close or fund.
  if (mode === 'replay') return none;
  switch (view.tone) {
    case 'level':
    case 'watch':
      // On Rescue the line only reports; the owner's controls live on Desk.
      if (screen === 'rescue') return none;
      return {
        note: null,
        buttons: [
          ...(auto === null ? [] : [{ id: 'auto' as const, label: auto ? 'Auto on' : 'Auto off', style: 'quiet' as const }]),
          { id: 'pause', label: 'Pause', style: 'quiet' },
          { id: 'close', label: 'Close position', style: 'plain' },
        ],
      };
    case 'rescuing':
      return { note: 'No action needed from you', buttons: [] };
    case 'needs':
      return {
        note: null,
        buttons: [
          { id: 'add-margin', label: 'Add margin', style: 'plain' },
          { id: 'close', label: 'Close both legs', style: 'primary' },
        ],
      };
    case 'down':
      return { note: null, buttons: [{ id: 'close', label: 'Close both legs', style: 'plain' }] };
    case 'paused':
      return { note: null, buttons: [{ id: 'resume', label: 'Resume', style: 'plain' }] };
    case 'waiting':
      return none;
  }
}
