// Health level / watch / rescue for a leg, from its distance to liquidation and the owner's lines
// (strategy.risk.watchDistancePct, rescueDistancePct).
//
// Sizing the rescue line for the slow case. A rescue is one MPC signature and one 1Click transfer before the margin
// lands. Measured on mainnet 2026-10-27: signatures usually take 5–6 s but one took 120 s; 1Click took 65 s Phoenix →
// Hyperliquid (its quote said ~30 s) and 54 s Hyperliquid → 1Click. So a rescue that starts now can land ~3 minutes
// later (the slow signature plus the slow transfer: RESCUE_HORIZON_S = 120 s + 65 s = 185 s, about 3 minutes), and
// the leg must survive the price move of those 3 minutes. Over a horizon T the move has a standard deviation σ·√T,
// with σ the recent volatility per √second (realised, from the marks the engine reads). The rescue line is therefore
//     rescueLine = max(rescueDistancePct, (exp(RESCUE_Z × σ × √185 s) − 1) × 100)
// (a log move of x lifts the price by exp(x) − 1, more than x: the line covers a short's rise, the worse side).
// with RESCUE_Z = 4: a 4σ move in 3 minutes, which under a normal law happens about once in 30,000 rescues, and still
// leaves room for crypto's fat tails. The owner's line is the floor: in a calm market (ETH at 60 % a year is σ ≈
// 1.1e-4 /√s, so 4σ√185 ≈ 0.6 %) the default 8 % governs; the volatility term takes over only when 3-minute moves
// get large (σ ≈ 1.5e-3 /√s, a 1.2 % standard move per minute, puts it at 8.5 %). The watch line keeps its gap above the rescue
// line: watchLine = max(watchDistancePct, rescueLine + (watchDistancePct − rescueDistancePct)).
//
// A level is left only once the distance clears its line by HYSTERESIS_PTS, so a mark hovering on a line does not
// flap the desk between two states every read.

import type { DeskState, StrategyConfig } from '@gimbal/shared';

export type HealthLevel = DeskState['health'];

/** The slowest MPC signature measured on mainnet (2026-10-27); a request also times out after 120 s. */
export const MPC_SLOW_S = 120;
/** The slowest 1Click transfer measured on mainnet (2026-10-27): Phoenix → Hyperliquid, its quote said ~30 s. */
export const ONE_CLICK_SLOW_S = 65;
/** Seconds from the rescue's start until its margin lands, in the slow case (see the header): about 3 minutes. */
export const RESCUE_HORIZON_S = MPC_SLOW_S + ONE_CLICK_SLOW_S;
/** Standard deviations of the horizon's price move the rescue line leaves room for. */
export const RESCUE_Z = 4;
/** Percentage points past a line before a leg leaves the level that line set. */
export const HYSTERESIS_PTS = 1;
/** Volatility is estimated over this much recent history. */
export const VOL_WINDOW_MS = 30 * 60_000;
/** Fewer returns than this: no volatility estimate, the owner's lines alone apply. */
export const VOL_MIN_RETURNS = 10;

export interface Lines {
  watchPct: number;
  rescuePct: number;
  /** σ per √s the lines were sized with; null when there was no estimate. */
  sigmaPerSqrtS: number | null;
  /** The volatility term (exp(RESCUE_Z × σ × √RESCUE_HORIZON_S) − 1), in percent; 0 without an estimate. */
  volPct: number;
}

/** The watch and rescue lines for a leg, from the owner's lines and the leg's recent volatility (see the header). */
export function riskLines(risk: StrategyConfig['risk'], sigmaPerSqrtS: number | null): Lines {
  const volPct = sigmaPerSqrtS === null ? 0 : Math.expm1(RESCUE_Z * sigmaPerSqrtS * Math.sqrt(RESCUE_HORIZON_S)) * 100;
  const rescuePct = Math.max(risk.rescueDistancePct, volPct);
  const watchPct = Math.max(risk.watchDistancePct, rescuePct + (risk.watchDistancePct - risk.rescueDistancePct));
  return { watchPct, rescuePct, sigmaPerSqrtS, volPct };
}

/**
 * The level for a distance, given the level before (for hysteresis). A distance that is unknown (no liquidation
 * price: the leg cannot be liquidated by price) is level.
 */
export function healthFor(distancePct: number | null, lines: Pick<Lines, 'watchPct' | 'rescuePct'>, before: HealthLevel = 'level'): HealthLevel {
  if (distancePct === null) return 'level';
  if (distancePct < lines.rescuePct) return 'rescue';
  if (before === 'rescue' && distancePct < lines.rescuePct + HYSTERESIS_PTS) return 'rescue';
  if (distancePct < lines.watchPct) return 'watch';
  if (before !== 'level' && distancePct < lines.watchPct + HYSTERESIS_PTS) return 'watch';
  return 'level';
}

/**
 * A leg's level from its risk: healthFor on its distance, except that equity at or under maintenance (margin ratio
 * ≥ 1) is rescue whatever the distance says, and a distance that is not known is watched, never level; only a leg
 * that price alone cannot liquidate (basis 'none') is level without a distance.
 */
export function levelFor(
  risk: { distanceToLiqPct: number | null; distanceBasis: 'price' | 'account' | 'none' | 'unknown'; marginRatio: number },
  lines: Pick<Lines, 'watchPct' | 'rescuePct'>,
  before: HealthLevel = 'level',
): HealthLevel {
  if (risk.marginRatio >= 1) return 'rescue';
  if (risk.distanceToLiqPct === null) return risk.distanceBasis === 'none' ? 'level' : worst([before, 'watch']);
  return healthFor(risk.distanceToLiqPct, lines, before);
}

const RANK: Record<HealthLevel, number> = { level: 0, watch: 1, rescue: 2 };

export function worst(levels: readonly HealthLevel[]): HealthLevel {
  return levels.reduce<HealthLevel>((w, l) => (RANK[l] > RANK[w] ? l : w), 'level');
}

/**
 * Realised volatility per √second from timed marks: the sum of squared log returns over the time they span, so
 * uneven gaps between reads weigh by their length. Keeps VOL_WINDOW_MS of history.
 */
export class Volatility {
  readonly #windowMs: number;
  readonly #minReturns: number;
  #marks: { t: number; px: number }[] = [];

  constructor(options: { windowMs?: number; minReturns?: number } = {}) {
    this.#windowMs = options.windowMs ?? VOL_WINDOW_MS;
    this.#minReturns = options.minReturns ?? VOL_MIN_RETURNS;
  }

  add(t: number, px: number): void {
    if (!(px > 0) || !Number.isFinite(t)) return;
    const last = this.#marks.at(-1);
    if (last !== undefined && t <= last.t) return;         // same read twice, or a clock step back
    this.#marks.push({ t, px });
    const from = t - this.#windowMs;
    while (this.#marks.length > 0 && this.#marks[0]!.t < from) this.#marks.shift();
  }

  /** σ per √s, or null with fewer than minReturns returns. */
  sigmaPerSqrtS(): number | null {
    const n = this.#marks.length - 1;
    if (n < this.#minReturns) return null;
    let sq = 0;
    for (let i = 1; i < this.#marks.length; i++) {
      const r = Math.log(this.#marks[i]!.px / this.#marks[i - 1]!.px);
      sq += r * r;
    }
    const spanS = (this.#marks.at(-1)!.t - this.#marks[0]!.t) / 1000;
    return spanS > 0 ? Math.sqrt(sq / spanS) : null;
  }
}
