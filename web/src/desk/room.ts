// The held pair as a measurement: how far the price can move before a leg is watched, rescued or liquidated, and what
// the desk says about it. Pure, so the geometry and every wording are tested.
import type { Leg, StrategyConfig } from '@gimbal/shared';
import { VENUE_NAMES } from '../shell/status.ts';
import { corridor, type Corridor } from '../ui/scale.ts';
import { placeLegs } from './model.ts';

type Risk = StrategyConfig['risk'];

export interface Room {
  symbol: string;
  long: Leg & { distanceToLiqPct: number; liqPx: number };
  short: Leg & { distanceToLiqPct: number; liqPx: number };
  /** The price move from now, in percent, at which each leg is watched, rescued and liquidated. */
  corridor: Corridor;
  /** The pair's price now: the middle of the two marks. */
  mark: number;
}

const measured = (leg: Leg | null): leg is Leg & { distanceToLiqPct: number; liqPx: number } =>
  leg !== null && leg.distanceToLiqPct !== null && leg.liqPx !== null;

/**
 * The room of a pair: both legs open and both venues giving a liquidation price. Null otherwise (one leg only, or a
 * venue that reports no liquidation price), since half a corridor would be a wrong picture. Without the owner's
 * distances (`risk` null) the zones have no length and only the two ends are drawn.
 */
export function roomOf(legs: readonly Leg[], risk: Risk | null): Room | null {
  const { left: short, right: long } = placeLegs(legs);
  if (!measured(long) || !measured(short)) return null;
  return {
    symbol: long.symbol,
    long,
    short,
    corridor: corridor(long.distanceToLiqPct, short.distanceToLiqPct, risk ?? { watchDistancePct: 0, rescueDistancePct: 0 }),
    mark: (long.mark + short.mark) / 2,
  };
}

/** Why there is no corridor to draw, in a sentence. */
export function noRoomText(legs: readonly Leg[]): string {
  const { left: short, right: long } = placeLegs(legs);
  if (short === null || long === null) return 'Only one leg is open, so the desk is not hedged: a price move is not cancelled out.';
  const silent = [long, short].filter((l) => !measured(l)).map((l) => VENUE_NAMES[l.venue]);
  return `${silent.join(' and ')} ${silent.length === 1 ? 'gives' : 'give'} no liquidation price right now, so the room cannot be drawn. The legs’ own figures are below.`;
}

/** `40%`, rounded toward the safe side; a move under one percent is said so. */
const whole = (movePct: number): string => (movePct < 1 ? 'less than 1%' : `${Math.floor(movePct)}%`);
const at = (n: number): string => `${Number(n.toFixed(1))}%`;
const legWords = (leg: Leg): string => `The ${leg.side} on ${VENUE_NAMES[leg.venue]}`;

/**
 * The corridor read aloud. Level: `MON can rise 40% or fall 82% before a rescue starts.` A leg inside a zone is named
 * with its distance and the line it has crossed.
 */
export function roomSentence(room: Room, risk: Risk | null): string {
  const { symbol, long, short, corridor: k } = room;
  if (risk === null) return `${symbol} would have to rise ${whole(short.distanceToLiqPct)} or fall ${whole(long.distanceToLiqPct)} to liquidate a leg.`;
  const inside = (leg: Leg & { distanceToLiqPct: number }, line: number): boolean => leg.distanceToLiqPct <= line;
  const rescued = [long, short].filter((l) => inside(l, risk.rescueDistancePct));
  if (rescued.length > 0) {
    return rescued
      .map((l) => `${legWords(l)} is ${at(l.distanceToLiqPct)} from its liquidation price, inside the ${at(risk.rescueDistancePct)} rescue line.`)
      .join(' ');
  }
  const watched = [long, short].filter((l) => inside(l, risk.watchDistancePct));
  if (watched.length > 0) {
    return watched
      .map((l) => {
        const more = l.side === 'short' ? `rises another ${whole(k.shortRescue)}` : `falls another ${whole(-k.longRescue)}`;
        return `${legWords(l)} is ${at(l.distanceToLiqPct)} from its liquidation price, inside the ${at(risk.watchDistancePct)} watch line; a rescue starts if ${symbol} ${more}.`;
      })
      .join(' ');
  }
  return `${symbol} can rise ${whole(k.shortRescue)} or fall ${whole(-k.longRescue)} before a rescue starts.`;
}

/** `A leg is watched once it is within 15% of its liquidation price and rescued at 8%.` Null until the rules are read. */
export function linesSentence(risk: Risk | null): string | null {
  if (risk === null) return null;
  return `A leg is watched once it is within ${at(risk.watchDistancePct)} of its liquidation price and rescued at ${at(risk.rescueDistancePct)}.`;
}

/** The state colour of the pair's needle: the leg nearer its liquidation decides. */
export function roomTone(room: Room, risk: Risk | null): 'up' | 'watch-t' | 'down' | null {
  if (risk === null) return null;
  const nearest = Math.min(room.long.distanceToLiqPct, room.short.distanceToLiqPct);
  return nearest <= risk.rescueDistancePct ? 'down' : nearest <= risk.watchDistancePct ? 'watch-t' : 'up';
}
