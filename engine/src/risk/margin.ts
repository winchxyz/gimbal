// Per-leg margin ratio and distance to liquidation, from what the venue readers return (AccountState, Position).
//
// The desk holds one leg per venue account, so a leg's margin is its account's equity and its maintenance is the
// account's maintenance margin. All three venues liquidate on the same rule, equity below maintenance:
//   - Hyperliquid (cross): accountValue < crossMaintenanceMarginUsed; maintenance is half the initial margin at the
//     asset's max leverage, a fixed fraction m of the notional;
//   - Phoenix: portfolio value < the margin engine's maintenance margin (rise SDK, summed over subaccounts);
//   - Orderly: total collateral < notional × MMR (the position's mmr, or base_mmr scaled by imr_factor).
// With equity E, size q (signed), mark P and m = maintenance / notional, the price P' where E + q(P' − P) = m|q|P':
//   long:  P' = (qP − E) / (q(1 − m))       distance (P − P') / P = (e − m) / (1 − m)
//   short: P' = (E + |q|P) / (|q|(1 + m))   distance (P' − P) / P = (e − m) / (1 + m)
// where e = E / (|q|P), the inverse of the account's leverage. m is held constant as the price moves (one tier).
//
// Each venue also states a liquidation price (HL liquidationPx, Phoenix's SDK liquidationPriceUsd, Orderly
// estLiqPrice). The leg uses the nearer of the venue's price and the computed one: both are estimates, and the
// one closer to the mark is the one that would bite first. On an account with more than one position the computed
// price does not apply (other positions move its equity), so only the venue's is used. When the venue gives none
// either, the distance comes from the account's margin: (equity − maintenance) ÷ the account's whole notional, the
// move that would take the account to its maintenance if every position on it moved against it together (for a lone
// position this is (e − m), within a factor 1 ± m of the exact distance). An unknown distance never reads as safe:
// `distanceBasis` says where the number came from, and only 'none' (a long that price alone cannot liquidate) means
// there is no liquidation to watch.

import type { VenueId } from '@gimbal/shared';
import type { AccountState, Position } from '../venues/venue.ts';

export interface LegRiskInput {
  venue: VenueId;
  account: AccountState;
  position: Position;
  /** USD per base unit; null: derived from the position (entry + unrealized PnL / size). */
  markPx: number | null;
}

export interface LegRisk {
  mark: number;
  /** The liquidation price used: the nearer of the venue's and the computed one; null when there is none. */
  liqPx: number | null;
  venueLiqPx: number | null;
  computedLiqPx: number | null;
  /** Maintenance ÷ equity: 1 = liquidation (and above, already past it). */
  marginRatio: number;
  /**
   * How far the mark must move to reach liqPx, in percent (0 when it is already there); without a liqPx on an account
   * with other positions, the account-margin estimate (see the header); null only when there is no liquidation price.
   */
  distanceToLiqPct: number | null;
  /** 'price': from liqPx; 'account': the account-margin estimate; 'none': price cannot liquidate it; 'unknown': no mark. */
  distanceBasis: 'price' | 'account' | 'none' | 'unknown';
  /** Maintenance ÷ notional (m above). */
  maintenanceFraction: number;
  /** Equity ÷ notional (e above). */
  equityFraction: number;
  notionalUsd: number;
}

/** The mark: the given one, or entry + uPnL / size (every reader computes uPnL at the venue's own mark). */
export function legMark(position: Position, markPx: number | null): number {
  if (markPx !== null && markPx > 0) return markPx;
  if (position.size === 0) return position.entryPx;
  return position.entryPx + position.unrealizedPnlUsd / position.size;
}

/** The computed liquidation price of a lone position (see the header); null when it cannot be liquidated by price. */
export function computedLiqPx(size: number, mark: number, equityUsd: number, maintenanceFraction: number): number | null {
  if (size === 0 || !(mark > 0)) return null;
  const m = maintenanceFraction;
  if (size > 0) {
    if (m >= 1) return null;
    const px = (size * mark - equityUsd) / (size * (1 - m));
    return px > 0 ? px : null;       // over-collateralised long: the price would have to go below 0
  }
  const s = -size;
  return (equityUsd + s * mark) / (s * (1 + m));
}

/** Percent the mark must move toward liqPx to reach it; 0 when the mark is at or past it. */
export function distancePct(side: 'long' | 'short', mark: number, liqPx: number | null): number | null {
  if (liqPx === null || !(mark > 0)) return null;
  const d = side === 'long' ? (mark - liqPx) / mark : (liqPx - mark) / mark;
  return Math.max(0, d * 100);
}

export function legRisk(input: LegRiskInput): LegRisk {
  const { account, position } = input;
  const side = position.size >= 0 ? 'long' : 'short';
  const mark = legMark(position, input.markPx);
  const notionalUsd = Math.abs(position.size) * mark;
  const equity = account.equityUsd;
  const maintenance = account.maintenanceMarginUsd;
  const others = account.positions.filter((p) => p.symbol !== position.symbol && p.size !== 0).length;
  const accountNotional = others === 0 ? notionalUsd : account.positions.reduce((s, p) => s + Math.abs(p.size) * legMark(p, p === position ? mark : null), 0);
  const m = accountNotional > 0 ? maintenance / accountNotional : 0;
  const venueLiqPx = position.liqPx !== null && position.liqPx > 0 ? position.liqPx : null;
  const computed = others === 0 ? computedLiqPx(position.size, mark, equity, m) : null;
  const venueDist = distancePct(side, mark, venueLiqPx);
  const computedDist = distancePct(side, mark, computed);
  let liqPx: number | null;
  if (venueDist === null) liqPx = computed;
  else if (computedDist === null) liqPx = venueLiqPx;
  else liqPx = computedDist < venueDist ? computed : venueLiqPx;
  const marginRatio = equity > 0 ? maintenance / equity : maintenance > 0 ? 1 : 0;
  let distanceToLiqPct: number | null;
  let distanceBasis: LegRisk['distanceBasis'];
  if (!(mark > 0)) {
    distanceToLiqPct = null;
    distanceBasis = 'unknown';
  } else if (equity <= maintenance && maintenance > 0) {
    distanceToLiqPct = 0;
    distanceBasis = 'account';
  } else if (liqPx !== null) {
    distanceToLiqPct = distancePct(side, mark, liqPx);
    distanceBasis = 'price';
  } else if (others > 0) {
    distanceToLiqPct = accountNotional > 0 ? Math.max(0, (equity - maintenance) / accountNotional) * 100 : null;
    distanceBasis = accountNotional > 0 ? 'account' : 'unknown';
  } else {
    distanceToLiqPct = null;
    distanceBasis = 'none';
  }
  return {
    mark,
    liqPx,
    venueLiqPx,
    computedLiqPx: computed,
    marginRatio: Math.max(0, marginRatio),
    distanceToLiqPct,
    distanceBasis,
    maintenanceFraction: m,
    equityFraction: notionalUsd > 0 ? equity / notionalUsd : Infinity,
    notionalUsd,
  };
}

/**
 * The margin to add to a lone leg so its distance to liquidation becomes `targetPct` (0 when it already is that far).
 * From the header: a long needs e = D(1 − m) + m, a short e = D(1 + m) + m; the margin is (e − e_now) × notional.
 */
export function marginToReach(risk: Pick<LegRisk, 'maintenanceFraction' | 'equityFraction' | 'notionalUsd'>, side: 'long' | 'short', targetPct: number): number {
  const d = targetPct / 100;
  const m = risk.maintenanceFraction;
  const e = side === 'long' ? d * (1 - m) + m : d * (1 + m) + m;
  return Math.max(0, (e - risk.equityFraction) * risk.notionalUsd);
}
