// The risk engine (E8): every interval it reads the desk's legs from the venues, computes each leg's margin ratio
// and distance to liquidation (margin.ts), sets its level against the owner's lines sized for a slow rescue
// (thresholds.ts), and publishes:
//   - `desk`: DeskState with the legs and the desk's health (the worst leg's level);
//   - `health`: the HealthMap, when a venue, 1Click or NEAR changes state (venue-health.ts);
//   - `journal`: `rescue` when the desk enters rescue, `adl` when a leg shrank without an order of ours (adl.ts),
//     `error` when a venue stops answering;
//   - `rescue`: a RescueProgress at step `detect` for each rescue trigger, unless a rescuer (E9) takes the trigger.
//
// Stress (POST /stress, testnet and replay only): raises the rescue line above the nearest leg's distance, so the
// desk goes to rescue on the next read and the rescue starts; cleared with { "on": false }. On mainnet it is refused,
// whatever the request: a stress there would move real money.

import type { DeskState, JournalEntry, Leg, Mode, RescueProgress, StrategyConfig, StreamEvent, VenueId } from '@gimbal/shared';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import type { AccountState, Position } from '../venues/venue.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { AdlWatch } from './adl.ts';
import { adlJournal } from './adl.ts';
import type { LegRisk } from './margin.ts';
import { legRisk, marginToReach } from './margin.ts';
import type { HealthLevel, Lines } from './thresholds.ts';
import { Volatility, healthFor, riskLines, worst } from './thresholds.ts';
import type { VenueHealth } from './venue-health.ts';

/** The stress line sits this many points above the nearest leg's distance, so price noise does not end it. */
export const STRESS_MARGIN_PTS = 5;
export const RISK_INTERVAL_MS = 5_000;

/** One desk leg as a source read it: the venue account that holds it and the position. */
export interface LegInput {
  venue: VenueId;
  symbol: string;
  lotSize: number;
  account: AccountState;
  position: Position;
  /** USD per base unit; null: derived from the position. */
  markPx: number | null;
  feesUsd: number;
  unpriced: boolean;
}

export interface DeskSnapshot {
  deskId: string;
  owner: string;
  contract: string;
  reserveUsd: number;
  paused: DeskState['paused'];
  legs: LegInput[];
  /** Each venue read this time: how long it took, or why it failed. */
  reads: { venue: VenueId; ms: number; error: string | null }[];
}

export interface DeskSource {
  read(): Promise<DeskSnapshot>;
}

/** What starts a rescue: the leg nearest liquidation under its rescue line, and the margin that brings it back. */
export interface RescueTrigger {
  id: string;
  venue: VenueId;
  symbol: string;
  distancePct: number;
  rescuePct: number;
  watchPct: number;
  /** Margin that brings the leg back to its watch line (marginToReach). */
  amountUsd: number;
  /** Where the margin would come from, by the simple rule here; E9 plans the real route. */
  from: VenueId | 'reserve';
  stress: boolean;
  at: number;
}

export class StressRefused extends Error {
  name = 'StressRefused';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface RiskEngineOptions {
  mode: Mode;
  source: DeskSource;
  strategy: () => StrategyConfig;
  health: VenueHealth;
  publish: (event: StreamEvent) => void;
  clock?: Clock;
  intervalMs?: number;
  adl?: AdlWatch;
  /** E9: takes a trigger and runs the rescue. Without it the engine publishes the trigger as a `detect` step. */
  rescuer?: (trigger: RescueTrigger) => void;
  log?: (line: string) => void;
}

interface LegView {
  leg: Leg;
  risk: LegRisk | null;
  lines: Lines;
  level: HealthLevel;
  freeMarginUsd: number;
}

export class RiskEngine {
  readonly #o: RiskEngineOptions;
  readonly #clock: Clock;
  readonly #vol = new Map<string, Volatility>();
  readonly #levels = new Map<string, HealthLevel>();
  #views: LegView[] = [];
  #desk: DeskState | null = null;
  #stress: { rescuePct: number; at: number } | null = null;
  #seq = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #ticking: Promise<DeskState | null> | null = null;
  readonly #down = new Set<string>();

  constructor(options: RiskEngineOptions) {
    this.#o = options;
    this.#clock = options.clock ?? systemClock;
  }

  get desk(): DeskState | null {
    return this.#desk;
  }

  get stressLine(): number | null {
    return this.#stress?.rescuePct ?? null;
  }

  /** The lines each leg was last judged by. */
  lines(): { venue: VenueId; symbol: string; lines: Lines; level: HealthLevel }[] {
    return this.#views.map((v) => ({ venue: v.leg.venue, symbol: v.leg.symbol, lines: v.lines, level: v.level }));
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const loop = (): void => {
      if (!this.#running) return;
      this.tick().catch((err: unknown) => this.#log(`risk tick failed: ${errorMessage(err)}`)).finally(() => {
        if (this.#running) {
          this.#timer = setTimeout(loop, this.#o.intervalMs ?? RISK_INTERVAL_MS);
          this.#timer.unref();
        }
      });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.#running = false;
    clearTimeout(this.#timer);
    await this.#ticking;
  }

  /** One read of the desk, published. Ticks never overlap: a call during one waits for it and runs after. */
  async tick(): Promise<DeskState | null> {
    while (this.#ticking !== null) await this.#ticking;
    this.#ticking = this.#tick();
    try {
      return await this.#ticking;
    } finally {
      this.#ticking = null;
    }
  }

  /**
   * POST /stress: on = raise the rescue line above the nearest leg; off = back to the owner's lines. Refused on
   * mainnet and when no leg is open. Runs a tick, so the answer carries the health it led to.
   */
  async stress(on: boolean): Promise<{ health: HealthLevel; rescueDistancePct: number | null }> {
    if (this.#o.mode === 'mainnet') {
      throw new StressRefused('POST /stress is refused on mainnet: it would start a real rescue that moves real money. It runs on testnet and in replay only.', 403);
    }
    if (!on) {
      this.#stress = null;
      this.#log('stress off: the owner\'s lines again');
      const desk = await this.tick();
      return { health: desk?.health ?? 'level', rescueDistancePct: null };
    }
    if (this.#desk === null) await this.tick();
    const nearest = this.#views.reduce<number | null>((m, v) => {
      const d = v.leg.distanceToLiqPct;
      return d === null ? m : m === null || d < m ? d : m;
    }, null);
    if (nearest === null) {
      throw new StressRefused(this.#views.length === 0 ? 'no leg is open: there is no margin to stress' : 'no leg has a liquidation price: there is no margin to stress', 409);
    }
    this.#stress = { rescuePct: nearest + STRESS_MARGIN_PTS, at: this.#clock.now() };
    this.#log(`stress on: rescue line ${this.#stress.rescuePct.toFixed(2)} %, ${STRESS_MARGIN_PTS} points over the nearest leg's ${nearest.toFixed(2)} %`);
    const desk = await this.tick();
    return { health: desk?.health ?? 'level', rescueDistancePct: this.#stress.rescuePct };
  }

  async #tick(): Promise<DeskState | null> {
    let snap: DeskSnapshot;
    try {
      snap = await this.#o.source.read();
    } catch (err) {
      this.#log(`risk: the desk could not be read: ${errorMessage(err)}`);
      return this.#desk;
    }
    const t = this.#clock.now();
    for (const r of snap.reads) {
      if (r.error === null) this.#o.health.readOk(r.venue, r.ms);
      else this.#o.health.readFailed(r.venue, new Error(r.error));
    }
    this.#publishHealth(t);

    const unread = new Set(snap.reads.filter((r) => r.error !== null).map((r) => r.venue));
    const strategy = this.#o.strategy();
    const views: LegView[] = [];
    for (const input of snap.legs) views.push(this.#view(input, strategy, t));
    // A leg whose venue did not answer keeps its last numbers, and is at least watched: it cannot be seen.
    for (const old of this.#views) {
      if (!unread.has(old.leg.venue) || views.some((v) => v.leg.venue === old.leg.venue && v.leg.symbol === old.leg.symbol)) continue;
      const level = worst([old.level, 'watch']);
      views.push({ ...old, level });
      this.#levels.set(key(old.leg.venue, old.leg.symbol), level);
    }
    const before = this.#desk?.health ?? 'level';
    this.#views = views;
    const desk = this.#deskState(snap, views, t);
    this.#desk = desk;
    this.#o.publish({ type: 'desk', data: desk });
    if (desk.health === 'rescue' && before !== 'rescue') this.#trigger(views, t);

    if (this.#o.adl !== undefined) {
      try {
        const report = await this.#o.adl.check();
        if (report !== null) this.#journal({ ...adlJournal(report, this.#clock.now()) });
      } catch (err) {
        this.#log(`adl check failed: ${errorMessage(err)}`);
      }
    }
    return desk;
  }

  #view(input: LegInput, strategy: StrategyConfig, t: number): LegView {
    const k = key(input.venue, input.symbol);
    const risk = legRisk({ venue: input.venue, account: input.account, position: input.position, markPx: input.markPx });
    let vol = this.#vol.get(k);
    if (vol === undefined) this.#vol.set(k, (vol = new Volatility()));
    vol.add(t, risk.mark);
    const lines = riskLines(strategy.risk, vol.sigmaPerSqrtS());
    if (this.#stress !== null && this.#stress.rescuePct > lines.rescuePct) {
      const gap = strategy.risk.watchDistancePct - strategy.risk.rescueDistancePct;
      lines.rescuePct = this.#stress.rescuePct;
      lines.watchPct = Math.max(lines.watchPct, lines.rescuePct + gap);
    }
    const level = healthFor(risk.distanceToLiqPct, lines, this.#levels.get(k) ?? 'level');
    this.#levels.set(k, level);
    const p = input.position;
    const leg: Leg = {
      venue: input.venue,
      symbol: input.symbol,
      side: p.size >= 0 ? 'long' : 'short',
      size: Math.abs(p.size),
      lotSize: input.lotSize,
      entry: p.entryPx,
      mark: risk.mark,
      liqPx: risk.liqPx,
      marginUsd: input.account.equityUsd,
      marginRatio: risk.marginRatio,
      distanceToLiqPct: risk.distanceToLiqPct,
      fundingEarnedUsd: p.fundingSinceOpenUsd,
      unsettledFundingUsd: p.unsettledFundingUsd,
      feesUsd: input.feesUsd,
      unpriced: input.unpriced,
    };
    return { leg, risk, lines, level, freeMarginUsd: input.account.freeMarginUsd };
  }

  #deskState(snap: DeskSnapshot, views: LegView[], t: number): DeskState {
    const legs = views.map((v) => v.leg);
    const fundingUsd = legs.reduce((s, l) => s + l.fundingEarnedUsd + l.unsettledFundingUsd, 0);
    const feesUsd = legs.reduce((s, l) => s + l.feesUsd, 0);
    const priceUsd = views.reduce((s, v) => s + (v.leg.mark - v.leg.entry) * v.leg.size * (v.leg.side === 'long' ? 1 : -1), 0);
    const netDelta = legs.reduce((s, l) => s + (l.side === 'long' ? l.size : -l.size), 0);
    return {
      deskId: snap.deskId, owner: snap.owner, contract: snap.contract, mode: this.#o.mode,
      legs,
      netDelta: Math.abs(netDelta) < 1e-12 ? 0 : netDelta,
      equityUsd: legs.reduce((s, l) => s + l.marginUsd, 0) + snap.reserveUsd,
      reserveUsd: snap.reserveUsd,
      pnl: { fundingUsd, feesUsd, priceUsd, netUsd: fundingUsd + feesUsd + priceUsd },
      health: worst(views.map((v) => v.level)),
      paused: snap.paused,
      rescueFailure: this.#desk?.rescueFailure ?? null,
      updatedAt: t,
    };
  }

  /** The desk entered rescue: the leg nearest its line is rescued first. */
  #trigger(views: LegView[], t: number): void {
    const rescuing = views.filter((v) => v.level === 'rescue' && v.risk !== null && v.leg.distanceToLiqPct !== null);
    if (rescuing.length === 0) return;
    const v = rescuing.reduce((a, b) => (b.leg.distanceToLiqPct! - b.lines.rescuePct < a.leg.distanceToLiqPct! - a.lines.rescuePct ? b : a));
    // Up to the cent (less a hair of float noise, so 180.6 stays 180.60).
    const amountUsd = Math.ceil(marginToReach(v.risk!, v.leg.side, v.lines.watchPct) * 100 - 1e-6) / 100;
    // Orderly is never a source (four signatures and several hops); the partner leg's venue when its free margin
    // covers the amount, else the reserve.
    const partner = views.find((o) => o !== v && o.leg.venue !== 'orderly' && o.freeMarginUsd >= amountUsd);
    const stress = this.#stress !== null && v.lines.rescuePct === this.#stress.rescuePct;
    const trigger: RescueTrigger = {
      id: `rescue-${t.toString(36)}-${++this.#seq}`,
      venue: v.leg.venue, symbol: v.leg.symbol,
      distancePct: v.leg.distanceToLiqPct!, rescuePct: v.lines.rescuePct, watchPct: v.lines.watchPct,
      amountUsd, from: partner?.leg.venue ?? 'reserve', stress, at: t,
    };
    const volNote = v.lines.volPct > 0 ? `, volatility term ${v.lines.volPct.toFixed(2)} %` : '';
    this.#journal({
      t, kind: 'rescue',
      summary: `health rescue: ${v.leg.venue} ${v.leg.symbol} ${v.leg.side} is ${trigger.distancePct.toFixed(2)} % from liquidation, under the ${trigger.rescuePct.toFixed(2)} % rescue line${stress ? ' (stress test)' : ''}${volNote}; ${amountUsd.toFixed(2)} USD from ${trigger.from} brings it back to ${trigger.watchPct.toFixed(2)} %`,
      numbers: {
        venue: v.leg.venue, distancePct: round2(trigger.distancePct), rescuePct: round2(trigger.rescuePct),
        watchPct: round2(trigger.watchPct), amountUsd: trigger.amountUsd, from: trigger.from, ...(stress ? { stress: 1 } : {}),
      },
      tx: [],
    });
    this.#log(`rescue trigger ${trigger.id}: ${trigger.venue} ${trigger.symbol} at ${trigger.distancePct.toFixed(2)} % < ${trigger.rescuePct.toFixed(2)} %, ${amountUsd} USD from ${trigger.from}`);
    if (this.#o.rescuer !== undefined) {
      this.#o.rescuer(trigger);
      return;
    }
    const progress: RescueProgress = {
      id: trigger.id, from: trigger.from, to: trigger.venue, amountUsd, step: 'detect', startedAt: t, elapsedS: 0, tx: [],
    };
    this.#o.publish({ type: 'rescue', data: progress });
  }

  #publishHealth(t: number): void {
    const map = this.#o.health.changed();
    if (map === null) return;
    this.#o.publish({ type: 'health', data: map });
    for (const [k, status] of Object.entries(map)) {
      if (status === 'down' && !this.#down.has(k)) {
        this.#down.add(k);
        const why = k === 'intents' ? this.#o.health.intentsDetail : k === 'near' ? null : this.#o.health.detail(k as VenueId).readError;
        this.#journal({ t, kind: 'error', summary: `${k} not answering${why === null ? '' : `: ${why}`}`, numbers: { venue: k }, tx: [] });
      } else if (status !== 'down') {
        this.#down.delete(k);
      }
    }
  }

  /** Publishes a health map change from outside a tick (a scan, a 1Click probe, NEAR's state). */
  healthChanged(): void {
    this.#publishHealth(this.#clock.now());
  }

  #journal(entry: Omit<JournalEntry, 'id'>): void {
    this.#o.publish({ type: 'journal', data: { id: `risk-${entry.t.toString(36)}-${++this.#seq}`, ...entry } });
  }

  #log(line: string): void {
    this.#o.log?.(line);
  }
}

function key(venue: VenueId, symbol: string): string {
  return `${venue} ${symbol}`;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
