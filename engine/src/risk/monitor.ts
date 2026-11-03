// The live pair's monitor, read-only: one line per leg (size, mark, liquidation price, distance, margin) and whether
// the legs offset each other, and an alert when a leg is closer to liquidation than ALERT_DISTANCE_PCT (25 %, the
// human's line for the live pair, above the risk engine's own watch and rescue lines). serve prints the lines every
// MONITOR_EVERY_MS and checks the alert on every risk read; the alert goes to the journal (`error`) and the console
// when a leg crosses under the line, again every MONITOR_EVERY_MS while it stays under, and the console says when it
// is back above the line plus ALERT_HYSTERESIS_PTS. `npm run monitor -w engine -- --mainnet` prints the same lines once.

import type { DeskState, JournalEntry, Leg } from '@gimbal/shared';

export const ALERT_DISTANCE_PCT = 25;
export const ALERT_HYSTERESIS_PTS = 1;
export const MONITOR_EVERY_MS = 30 * 60_000;

/** One leg as the monitor prints it. */
export function legLine(l: Leg): string {
  const d = l.distanceToLiqPct;
  return `${l.venue} ${l.symbol} ${l.side} ${l.size} at mark ${l.mark}, liq ${l.liqPx ?? 'none'}, `
    + `${d === null ? 'distance unknown' : `${d.toFixed(2)} % from liquidation`}, margin ${l.marginUsd.toFixed(2)} USD`
    + (d !== null && d < ALERT_DISTANCE_PCT ? ` (UNDER ${ALERT_DISTANCE_PCT} %)` : '');
}

/**
 * The legs offset each other: the net delta (a float sum of leg sizes) is zero within a billionth (1e-9) of the
 * largest leg, and never less than 1e-9 base units, so the float sum's rounding never reads as an unhedged pair.
 */
export function isHedged(desk: Pick<DeskState, 'netDelta' | 'legs'>): boolean {
  const largest = desk.legs.reduce((m, l) => Math.max(m, Math.abs(l.size)), 0);
  return Math.abs(desk.netDelta) <= Math.max(1e-9, largest * 1e-9);
}

/** The monitor's lines for a desk state: each leg, then the net. */
export function monitorLines(desk: DeskState): string[] {
  if (desk.legs.length === 0) return [`monitor   ${desk.deskId}: no open legs (equity ${desk.equityUsd.toFixed(2)} USD, reserve ${desk.reserveUsd.toFixed(2)} USD)`];
  const out = desk.legs.map((l) => `monitor   ${legLine(l)}`);
  out.push(`monitor   net delta ${desk.netDelta}${isHedged(desk) ? ' (hedged)' : ' (NOT hedged)'}, health ${desk.health}${desk.paused === null ? '' : ', PAUSED'}, `
    + `funding ${desk.pnl.fundingUsd.toFixed(4)} USD, equity ${desk.equityUsd.toFixed(2)} USD`);
  return out;
}

/** Legs under the alert line (distance known and below it). */
export function legsUnder(desk: DeskState, linePct = ALERT_DISTANCE_PCT): Leg[] {
  return desk.legs.filter((l) => l.distanceToLiqPct !== null && l.distanceToLiqPct < linePct);
}

export interface AlertOutput {
  journal: Omit<JournalEntry, 'id'>[];
  console: string[];
}

/** The 25 % alert across desk reads (see the header). */
export class LiquidationAlert {
  readonly linePct: number;
  readonly #everyMs: number;
  /** Per leg (venue symbol): when the alert was last journaled while it stays under the line. */
  readonly #under = new Map<string, number>();

  constructor(options: { linePct?: number; everyMs?: number } = {}) {
    this.linePct = options.linePct ?? ALERT_DISTANCE_PCT;
    this.#everyMs = options.everyMs ?? MONITOR_EVERY_MS;
  }

  observe(desk: DeskState, now: number): AlertOutput {
    const out: AlertOutput = { journal: [], console: [] };
    const seen = new Set<string>();
    for (const l of desk.legs) {
      const k = `${l.venue} ${l.symbol}`;
      seen.add(k);
      const d = l.distanceToLiqPct;
      const last = this.#under.get(k);
      // A distance that cannot be read (null) is no recovery: a leg under the line stays under until one reads above.
      if (d !== null && d < this.linePct) {
        if (last !== undefined && now - last < this.#everyMs) continue;
        this.#under.set(k, now);
        const summary = `liquidation alert: ${legLine(l)}, under the ${this.linePct} % line${last === undefined ? '' : ' (still)'}`;
        out.journal.push({ t: now, kind: 'error', summary, numbers: { venue: l.venue, distancePct: Math.round(d * 100) / 100, alertPct: this.linePct }, tx: [] });
        out.console.push(`ALERT     ${summary}`);
      } else if (last !== undefined && d !== null && d >= this.linePct + ALERT_HYSTERESIS_PTS) {
        this.#under.delete(k);
        out.console.push(`monitor   ${k} is back above the ${this.linePct} % liquidation line: ${legLine(l)}`);
      }
    }
    for (const k of [...this.#under.keys()]) {
      if (seen.has(k)) continue;
      this.#under.delete(k);
      out.console.push(`monitor   ${k} is no longer open: the ${this.linePct} % alert ends`);
    }
    return out;
  }
}
