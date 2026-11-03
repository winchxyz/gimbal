// The risk engine (E8): every interval it reads the desk's legs from the venues, computes each leg's margin ratio
// and distance to liquidation (margin.ts), sets its level against the owner's lines sized for a slow rescue
// (thresholds.ts), and publishes:
//   - `desk`: DeskState with the legs and the desk's health (the worst leg's level);
//   - `health`: the HealthMap, when a venue, 1Click or NEAR changes state (venue-health.ts);
//   - `journal`: `rescue` for each rescue trigger, `adl` when a leg shrank without an order of ours (adl.ts),
//     `error` when a venue stops answering;
//   - `rescue`: a RescueProgress at step `detect` for each rescue trigger, unless a rescuer (E9) takes the trigger.
//
// Rescue triggers are per leg. A leg that reaches rescue is triggered once; while it stays in rescue it is triggered
// again only when its rescue failed (rescueEnded(id, false)) or lapsed (no end reported within RESCUE_LAPSE_MS while the
// rescuer is not running it: a real rescue can outlast the lapse, and its end then counts), after
// a backoff of RESCUE_RETRY_MS doubling up to RESCUE_RETRY_MAX_MS. A leg that leaves rescue starts afresh.
//
// The ADL check runs beside the reads, never inside them: its response trades (an MPC signature can take 120 s, a
// close several), and reads, rescue triggers and POST /stress must go on meanwhile. One check runs at a time.
//
// The desk's own view (reserve, pause: get_desk on NEAR) is read by the source off the venue reads' path; a view that
// was never read, or is older than DESK_VIEW_STALE_MS, marks NEAR down in the health map and keeps the desk at watch
// at least (DeskState has no "unknown" reserve or pause, so the reserve reads 0 and the pause null until it is read).
//
// stop() is final: no tick, ADL check or stress starts after it; a tick in flight publishes and triggers nothing
// once its read returns, and the ADL watch is stopped too (a check in flight sends nothing more, adl.ts).
//
// Stress (POST /stress, testnet and replay only): raises the rescue line of the nearest leg above its distance, so it
// goes to rescue on the next read and its rescue starts; cleared with { "on": false }. On mainnet it is refused,
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
import { RESCUE_HORIZON_S, Volatility, levelFor, riskLines, worst } from './thresholds.ts';
import type { VenueHealth } from './venue-health.ts';

/** The stress line sits this many points above the nearest leg's distance, so price noise does not end it. */
export const STRESS_MARGIN_PTS = 5;
export const RISK_INTERVAL_MS = 5_000;
/** A rescue with no end reported this long after its trigger counts as lapsed: twice the slow case. */
export const RESCUE_LAPSE_MS = 2 * RESCUE_HORIZON_S * 1000;
/** A failed or lapsed rescue of a leg still in rescue is triggered again after this, doubling, up to the max. */
export const RESCUE_RETRY_MS = 30_000;
export const RESCUE_RETRY_MAX_MS = 10 * 60_000;
/** The desk's view (get_desk) older than this marks NEAR down; any failed or late read in between marks it slow. */
export const DESK_VIEW_STALE_MS = 60_000;

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
  /**
   * The desk's own view (reserve, pause), when the source reads one: when it was last read (null: never) and why the
   * latest read failed or is late (null: it answered). Absent: the source has no such view (replay), always known.
   */
  deskView?: { at: number | null; error: string | null };
}

export interface DeskSource {
  read(): Promise<DeskSnapshot>;
}

/** What starts a rescue: a leg under its rescue line, and the margin that brings it back. */
export interface RescueTrigger {
  id: string;
  venue: VenueId;
  symbol: string;
  distancePct: number;
  rescuePct: number;
  watchPct: number;
  /** Margin that brings the leg back to its watch line (marginToReach); 0 when amountKnown is false. */
  amountUsd: number;
  /** false: there was neither a mark nor an entry price to size it by; E9 must size it itself. */
  amountKnown: boolean;
  /** Where the margin would come from, by the simple rule here; E9 plans the real route. */
  from: VenueId | 'reserve';
  stress: boolean;
  /** 0 on the first trigger of this leg's rescue; n after n failed or lapsed ones. */
  attempt: number;
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
  /** E9: takes a trigger and runs the rescue, then calls rescueEnded. Without it the trigger is published at `detect`. */
  rescuer?: (trigger: RescueTrigger) => void;
  /** E9: the id of the rescue the rescuer is running now; a running rescue never lapses (a real one can take 10 min). */
  rescuerRunning?: () => string | null;
  log?: (line: string) => void;
}

interface LegView {
  leg: Leg;
  risk: LegRisk | null;
  lines: Lines;
  level: HealthLevel;
  freeMarginUsd: number;
}

/** A leg's rescue: the last trigger, when it ended (null: running), and how many came before it. */
interface LegRescue {
  trigger: RescueTrigger;
  endedAt: number | null;
  attempt: number;
}

export class RiskEngine {
  readonly #o: RiskEngineOptions;
  readonly #clock: Clock;
  readonly #vol = new Map<string, Volatility>();
  readonly #levels = new Map<string, HealthLevel>();
  readonly #rescues = new Map<string, LegRescue>();
  #views: LegView[] = [];
  #desk: DeskState | null = null;
  #failure: DeskState['rescueFailure'] = null;
  #stress: { key: string; rescuePct: number; at: number } | null = null;
  #seq = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #ticking: Promise<DeskState | null> | null = null;
  #adlRun: Promise<void> | null = null;
  #stopped = false;
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

  /** The running ADL check, if any (tests wait on it). */
  get adlRunning(): Promise<void> | null {
    return this.#adlRun;
  }

  /** E9: the legs and each leg venue's free margin, as last read (the rescue plans its sources on them). */
  legView(): { legs: Leg[]; freeMargin: Partial<Record<VenueId, number>> } {
    const freeMargin: Partial<Record<VenueId, number>> = {};
    for (const v of this.#views) freeMargin[v.leg.venue] = v.freeMarginUsd;
    return { legs: this.#views.map((v) => v.leg), freeMargin };
  }

  /** E9: a rescue failed and the owner must act (null: it landed). Shown in DeskState until no leg is in rescue. */
  setRescueFailure(f: DeskState['rescueFailure']): void {
    this.#failure = f;
    if (this.#desk !== null) {
      this.#desk = { ...this.#desk, rescueFailure: f };
      this.#o.publish({ type: 'desk', data: this.#desk });
    }
  }

  /** The lines each leg was last judged by. */
  lines(): { venue: VenueId; symbol: string; lines: Lines; level: HealthLevel }[] {
    return this.#views.map((v) => ({ venue: v.leg.venue, symbol: v.leg.symbol, lines: v.lines, level: v.level }));
  }

  start(): void {
    if (this.#running || this.#stopped) return;
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

  /** Final: nothing reads, triggers, checks ADL or stresses after it (a late POST /stress included). */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#running = false;
    this.#o.adl?.stop?.();
    clearTimeout(this.#timer);
    await this.#ticking;
    await this.#adlRun;
  }

  /** One read of the desk, published. Ticks never overlap: a call during one waits for it and runs after. */
  async tick(): Promise<DeskState | null> {
    while (this.#ticking !== null) await this.#ticking;
    if (this.#stopped) return this.#desk;
    this.#ticking = this.#tick();
    try {
      return await this.#ticking;
    } finally {
      this.#ticking = null;
    }
  }

  /** E9: a rescue ended. Landed: the leg starts afresh; failed: it is triggered again after the backoff if still in rescue. */
  rescueEnded(id: string, landed: boolean): void {
    for (const [k, r] of this.#rescues) {
      if (r.trigger.id !== id) continue;
      if (landed) this.#rescues.delete(k);
      else r.endedAt = this.#clock.now();
    }
  }

  /**
   * POST /stress: on = raise the nearest leg's rescue line above its distance; off = back to the owner's lines.
   * Refused on mainnet and when no leg is open. Runs a tick, so the answer carries the health it led to.
   */
  async stress(on: boolean): Promise<{ health: HealthLevel; rescueDistancePct: number | null }> {
    if (this.#o.mode === 'mainnet') {
      throw new StressRefused('POST /stress is refused on mainnet: it would start a real rescue that moves real money. It runs on testnet and in replay only.', 403);
    }
    if (this.#stopped) throw new StressRefused('the risk engine has stopped', 503);
    if (!on) {
      this.#stress = null;
      this.#log('stress off: the owner\'s lines again');
      const desk = await this.tick();
      return { health: desk?.health ?? 'level', rescueDistancePct: null };
    }
    if (this.#desk === null) await this.tick();
    const nearest = this.#views.reduce<LegView | null>((m, v) => {
      const d = v.leg.distanceToLiqPct;
      return d === null ? m : m === null || d < m.leg.distanceToLiqPct! ? v : m;
    }, null);
    if (nearest === null) {
      throw new StressRefused(this.#views.length === 0 ? 'no leg is open: there is no margin to stress' : 'no leg has a liquidation price: there is no margin to stress', 409);
    }
    const d = nearest.leg.distanceToLiqPct!;
    this.#stress = { key: key(nearest.leg.venue, nearest.leg.symbol), rescuePct: d + STRESS_MARGIN_PTS, at: this.#clock.now() };
    this.#log(`stress on: ${nearest.leg.venue} ${nearest.leg.symbol} rescue line ${this.#stress.rescuePct.toFixed(2)} %, ${STRESS_MARGIN_PTS} points over its ${d.toFixed(2)} %`);
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
    if (this.#stopped) return this.#desk;
    const t = this.#clock.now();
    for (const r of snap.reads) {
      if (r.error === null) this.#o.health.readOk(r.venue, r.ms);
      else this.#o.health.readFailed(r.venue, new Error(r.error));
    }
    const view = snap.deskView;
    const viewUnknown = view !== undefined && (view.at === null || t - view.at >= DESK_VIEW_STALE_MS);
    if (view !== undefined) {
      const status = viewUnknown ? 'down' : view.error !== null ? 'slow' : 'ok';
      const age = view.at === null ? 'never read' : `${Math.round((t - view.at) / 1000)} s old`;
      this.#o.health.deskView(status, status === 'ok' ? null : `the desk view (get_desk) is ${age}${view.error === null ? '' : `: ${view.error}`}`);
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
    this.#views = views;
    const desk = this.#deskState(snap, views, t);
    // Reserve and pause unknown: not shown as a level, running desk.
    if (viewUnknown) desk.health = worst([desk.health, 'watch']);
    this.#desk = desk;
    this.#o.publish({ type: 'desk', data: desk });
    this.#triggers(views, t);
    this.#startAdl();
    return desk;
  }

  /** Starts the ADL check beside the reads when none runs (see the header). */
  #startAdl(): void {
    const adl = this.#o.adl;
    if (adl === undefined || this.#adlRun !== null || this.#stopped) return;
    this.#adlRun = (async () => {
      try {
        const report = await adl.check();
        // One event, one journal line: a retry after a backoff is journaled only when it brought the pair level.
        if (report !== null && (report.retry === 0 || report.reached)) {
          this.#journal({ ...adlJournal(report, this.#clock.now()) });
        }
        if (report?.gaveUp === true) {
          const f = report.findings[0]!;
          this.#journal({ t: this.#clock.now(), kind: 'error', summary: `ADL on ${f.leg.venue} ${f.leg.symbol}: no more tries, only the owner can act now (${report.summary})`, numbers: { venue: f.leg.venue, tries: report.retry + 1 }, tx: report.result?.tx ?? [] });
        }
      } catch (err) {
        this.#log(`adl check failed: ${errorMessage(err)}`);
      } finally {
        this.#adlRun = null;
      }
    })();
  }

  #view(input: LegInput, strategy: StrategyConfig, t: number): LegView {
    const k = key(input.venue, input.symbol);
    const risk = legRisk({ venue: input.venue, account: input.account, position: input.position, markPx: input.markPx });
    let vol = this.#vol.get(k);
    if (vol === undefined) this.#vol.set(k, (vol = new Volatility()));
    vol.add(t, risk.mark);
    const lines = riskLines(strategy.risk, vol.sigmaPerSqrtS());
    if (this.#stress !== null && this.#stress.key === k && this.#stress.rescuePct > lines.rescuePct) {
      const gap = strategy.risk.watchDistancePct - strategy.risk.rescueDistancePct;
      lines.rescuePct = this.#stress.rescuePct;
      lines.watchPct = Math.max(lines.watchPct, lines.rescuePct + gap);
    }
    const level = levelFor(risk, lines, this.#levels.get(k) ?? 'level');
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
      // A failure stays shown while a leg is in rescue; once none is, margin is safe again and it clears.
      rescueFailure: views.some((v) => v.level === 'rescue') ? this.#failure : (this.#failure = null),
      updatedAt: t,
    };
  }

  /** Per leg (see the header): a first trigger, or another after a failed or lapsed one and its backoff. */
  #triggers(views: LegView[], t: number): void {
    const inRescue = new Set<string>();
    // Nearest its line first, so the leg that bites first is rescued first.
    const due = views
      .filter((v) => v.level === 'rescue' && v.risk !== null)
      .sort((a, b) => gapToLine(a) - gapToLine(b));
    for (const v of due) {
      const k = key(v.leg.venue, v.leg.symbol);
      inRescue.add(k);
      const r = this.#rescues.get(k);
      if (r === undefined) {
        this.#fire(v, views, t, 0);
        continue;
      }
      const backoff = Math.min(RESCUE_RETRY_MAX_MS, RESCUE_RETRY_MS * 2 ** r.attempt);
      // Lapsed: no end reported in time, and the rescuer is not still running it (it reports its end when it ends).
      const lapsed = t - r.trigger.at >= RESCUE_LAPSE_MS && (this.#o.rescuerRunning?.() ?? null) !== r.trigger.id;
      const ended = r.endedAt ?? (lapsed ? r.trigger.at + RESCUE_LAPSE_MS : null);
      if (ended !== null && t >= ended + backoff) {
        this.#log(`rescue ${r.trigger.id} of ${k} ${r.endedAt === null ? 'lapsed (no end reported)' : 'failed'}; the leg is still in rescue: again`);
        this.#fire(v, views, t, r.attempt + 1);
      }
    }
    for (const k of this.#rescues.keys()) if (!inRescue.has(k)) this.#rescues.delete(k);
  }

  #fire(v: LegView, views: LegView[], t: number, attempt: number): void {
    const distance = v.leg.distanceToLiqPct ?? 0;
    // Up to the cent (less a hair of float noise, so 180.6 stays 180.60).
    const sized = this.#amount(v);
    const amountUsd = Math.max(0, Math.ceil(sized.usd * 100 - 1e-6) / 100);
    // Orderly is never a source (four signatures and several hops); the partner leg's venue when its free margin
    // covers the amount, else the reserve.
    const partner = views.find((o) => o !== v && o.leg.venue !== 'orderly' && o.leg.venue !== v.leg.venue && o.freeMarginUsd >= amountUsd);
    const k = key(v.leg.venue, v.leg.symbol);
    const stress = this.#stress !== null && this.#stress.key === k && v.lines.rescuePct === this.#stress.rescuePct;
    const trigger: RescueTrigger = {
      id: `rescue-${t.toString(36)}-${++this.#seq}`,
      venue: v.leg.venue, symbol: v.leg.symbol,
      distancePct: distance, rescuePct: v.lines.rescuePct, watchPct: v.lines.watchPct,
      amountUsd, amountKnown: sized.known, from: partner?.leg.venue ?? 'reserve', stress, attempt, at: t,
    };
    this.#rescues.set(k, { trigger, endedAt: null, attempt });
    const volNote = v.lines.volPct > 0 ? `, volatility term ${v.lines.volPct.toFixed(2)} %` : '';
    const again = attempt > 0 ? ` (again: attempt ${attempt + 1})` : '';
    const amountText = !sized.known
      ? 'the amount is unknown (no mark, no entry price): the rescue must size it'
      : `${amountUsd.toFixed(2)} USD from ${trigger.from}${sized.note} brings it back to ${trigger.watchPct.toFixed(2)} %`;
    this.#journal({
      t, kind: 'rescue',
      summary: `health rescue${again}: ${v.leg.venue} ${v.leg.symbol} ${v.leg.side} is ${distance.toFixed(2)} % from liquidation, under the ${trigger.rescuePct.toFixed(2)} % rescue line${stress ? ' (stress test)' : ''}${volNote}; ${amountText}`,
      numbers: {
        venue: v.leg.venue, distancePct: round2(distance), rescuePct: round2(trigger.rescuePct),
        watchPct: round2(trigger.watchPct), amountUsd: trigger.amountUsd, from: trigger.from, ...(sized.known ? {} : { amountKnown: 0 }),
        ...(stress ? { stress: 1 } : {}), ...(attempt > 0 ? { attempt: attempt + 1 } : {}),
      },
      tx: [],
    });
    this.#log(`rescue trigger ${trigger.id}: ${trigger.venue} ${trigger.symbol} at ${distance.toFixed(2)} % < ${trigger.rescuePct.toFixed(2)} %, ${amountUsd} USD from ${trigger.from}${again}`);
    if (this.#o.rescuer !== undefined) {
      // A rescuer that throws must not end the tick (the ADL check and the cleanup of legs that left rescue follow):
      // the trigger counts as failed, so it is tried again after the backoff.
      try {
        this.#o.rescuer(trigger);
      } catch (err) {
        this.#rescues.get(k)!.endedAt = t;
        this.#log(`rescue ${trigger.id}: the rescuer threw: ${errorMessage(err)}`);
        this.#journal({ t, kind: 'error', summary: `rescue ${trigger.id} of ${v.leg.venue} ${v.leg.symbol} could not start: ${errorMessage(err)}`, numbers: { venue: v.leg.venue }, tx: [] });
      }
      return;
    }
    const progress: RescueProgress = {
      id: trigger.id, from: trigger.from, to: trigger.venue, amountUsd, step: 'detect', startedAt: t, elapsedS: 0, tx: [],
    };
    this.#o.publish({ type: 'rescue', data: progress });
  }

  /**
   * The margin a rescue adds (marginToReach to the watch line). With no mark it cannot be told: estimated on the
   * entry price instead (maintenance plus the watch distance of the notional at entry, less equity), and unknown when
   * there is no entry price either. Never NaN.
   */
  #amount(v: LegView): { usd: number; known: boolean; note: string } {
    const exact = marginToReach(v.risk!, v.leg.side, v.lines.watchPct);
    if (exact !== null) return { usd: exact, known: true, note: '' };
    const r = v.risk!;
    const notional = v.leg.size * v.leg.entry + (r.otherPositions > 0 ? r.accountNotionalUsd : 0);
    const est = r.maintenanceUsd + (v.lines.watchPct / 100) * notional - r.equityUsd;
    if (notional > 0 && Number.isFinite(est)) return { usd: Math.max(0, est), known: true, note: ' (estimated on the entry price: no mark)' };
    return { usd: 0, known: false, note: '' };
  }

  #publishHealth(t: number): void {
    const map = this.#o.health.changed();
    if (map === null) return;
    this.#o.publish({ type: 'health', data: map });
    for (const [k, status] of Object.entries(map)) {
      if (status === 'down' && !this.#down.has(k)) {
        this.#down.add(k);
        const why = k === 'intents' ? this.#o.health.intentsDetail : k === 'near' ? this.#o.health.nearDetail : this.#o.health.detail(k as VenueId).readError;
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

/** How far under its rescue line a leg is (more negative = nearer liquidation relative to its line). */
function gapToLine(v: LegView): number {
  return (v.leg.distanceToLiqPct ?? 0) - v.lines.rescuePct;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
