// The desk with no pair open: the cool-down it may be in, what it waits for, and the markets against the owner's
// minimum. Pure functions over the stream, so every figure and wording is tested.
import type { JournalEntry, StrategyConfig, StrategyDecision, Window as FundingWindow } from '@gimbal/shared';
import { pct, venueName } from '../windows/format.ts';
import { isOpenToDesk } from '../windows/markets.ts';
import { bestEnterable, hasHistory, sortWindows } from '../windows/model.ts';

const HOUR = 3_600_000;

/**
 * How long the engine opens nothing after an exit, hours. The engine's own rule (engine/src/strategy/decide.ts,
 * LOOP_RULES.cooldownHours): it is not in the payload, so it is repeated here and a test reads the engine's value.
 */
export const COOLDOWN_HOURS = 6;

/** What the loop says while it cools down (decide.ts, decideFlat): the hours left, to one decimal. */
const COOLING = /^Cooling down after the exit, (\d+(?:\.\d+)?) h left/;
/** `3 of 3 hours above`: the hourly checks the pair it waits for has passed. */
const PASSED = /(\d+) of (\d+) hours above/;

export interface CoolDown {
  /** When the last pair closed, ms. */
  exitAt: number;
  /** When an entry is possible again, ms. */
  until: number;
  /** The exit is the journal's own line, to the second; else it is `until` less the cool-down, good to a few minutes. */
  exact: boolean;
}

/**
 * The cool-down the desk is in, or null. The loop says the hours left to one decimal, so one line places the end
 * within six minutes; every other cooling line on the journal's page narrows it, down to the minute between two lines
 * where the figure changed.
 */
export function coolDownOf(decision: StrategyDecision | null, journal: readonly JournalEntry[], now: number): CoolDown | null {
  if (decision === null || decision.action !== 'wait') return null;
  const said = COOLING.exec(decision.reason);
  if (said === null) return null;
  const span = (t: number, left: number): [number, number] => [t + (left - 0.05) * HOUR, t + (left + 0.05) * HOUR];
  let [lo, hi] = span(decision.at, Number(said[1]));
  for (const e of journal) {
    if (e.kind !== 'wait' || decision.at - e.t > COOLDOWN_HOURS * HOUR || e.t > decision.at) continue;
    const m = COOLING.exec(e.summary);
    if (m === null) continue;
    const [a, b] = span(e.t, Number(m[1]));
    // A line that cannot be about the same cool-down (an older exit) is left out.
    if (Math.max(lo, a) > Math.min(hi, b)) continue;
    lo = Math.max(lo, a);
    hi = Math.min(hi, b);
  }
  const until = Math.round((lo + hi) / 2);
  if (until <= now) return null;
  const exit = journal.find((e) => e.kind === 'exit' && e.t < until && until - e.t < 2 * COOLDOWN_HOURS * HOUR);
  return exit ? { exitAt: exit.t, until, exact: true } : { exitAt: until - COOLDOWN_HOURS * HOUR, until, exact: false };
}

/** `1 h 48 min`, `40 min`, `2 h`: a length of time said in full. */
export function spanText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** `03:34` UTC. */
export const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

export interface Condition {
  done: boolean;
  /** Where it stands, in mono: `MON, 25.6% a year after costs`, `3 of 3`, `1 h 48 min left, until 03:34 UTC`. */
  value: string;
  /** What has to be true. */
  text: string;
}

const minText = (minimum: number): string => `${Number(minimum.toFixed(1))}%`;

interface WaitInput {
  decision: StrategyDecision | null;
  windows: readonly FundingWindow[];
  strategy: StrategyConfig | null;
  cool: CoolDown | null;
  now: number;
}

/** The market the desk waits for: the one the loop names, else the first it could enter, else the best open to it. */
export function waitedFor(decision: StrategyDecision | null, windows: readonly FundingWindow[]): FundingWindow | null {
  const named = decision?.windowId ? windows.find((w) => w.id === decision.windowId) ?? null : null;
  return named ?? bestEnterable(windows) ?? sortWindows(windows.filter((w) => w.held === null && isOpenToDesk(w) && hasHistory(w)))[0] ?? null;
}

/**
 * What has to be true before the desk opens the next pair, and where each stands: a market above the minimum, its
 * hourly checks in a row, and the cool-down while one runs. With Auto off the desk opens nothing by itself, which
 * comes first.
 */
export function conditionsOf({ decision, windows, strategy, cool, now }: WaitInput): Condition[] {
  const out: Condition[] = [];
  if (strategy?.auto === false) {
    out.push({ done: false, value: 'Auto is off', text: 'The desk opens a pair by itself only while Auto is on' });
  }
  const minimum = strategy?.minNetAprPct ?? null;
  const w = waitedFor(decision, windows);
  out.push({
    done: w !== null && minimum !== null && w.netAprPct >= minimum,
    value: w === null ? 'None open to the desk' : `${w.symbol}, ${pct(w.netAprPct)} a year after costs`,
    text: minimum === null ? 'A market pays more than your minimum' : `A market pays more than your ${minText(minimum)} minimum`,
  });
  const passed = decision === null || decision.action !== 'wait' || decision.windowId === null ? null : PASSED.exec(decision.reason);
  const need = passed ? Number(passed[2]) : strategy?.enterAfterChecks ?? null;
  if (need !== null) {
    const have = passed ? Number(passed[1]) : 0;
    out.push({
      done: have >= need,
      value: `${have} of ${need}`,
      text: `It stays there for ${need} hourly ${need === 1 ? 'check' : 'checks'} in a row`,
    });
  }
  if (cool !== null) {
    out.push({
      done: false,
      value: `${spanText(cool.until - now)} left, until ${hhmm(cool.until)} UTC`,
      text: `The ${COOLDOWN_HOURS}-hour cool-down after the last exit is over`,
    });
  }
  return out;
}

export interface MarketRow {
  id: string;
  symbol: string;
  /** `Phoenix / Hyperliquid`: long, then short. */
  venues: string;
  netAprPct: number;
  held: boolean;
  /** Under the owner's minimum: drawn quieter. */
  under: boolean;
}

export interface MarketsPlot {
  rows: MarketRow[];
  /** Markets open to the desk with their 7 days in, and how many of them pay the minimum. */
  open: number;
  above: number | null;
}

/**
 * The markets open to the desk on one scale, best first: what the dot plot draws. The held pair is always among them.
 * Only markets with their 7 days in have a net that can be held against the minimum.
 */
export function marketsPlot(windows: readonly FundingWindow[], minimum: number | null, limit = 6): MarketsPlot {
  const open = windows.filter((w) => isOpenToDesk(w) && w.tradable && hasHistory(w));
  const ranked = [...open].sort((a, b) => b.netAprPct - a.netAprPct || a.id.localeCompare(b.id));
  const top = ranked.slice(0, limit);
  const held = ranked.find((w) => w.held !== null);
  if (held && !top.includes(held)) top[top.length - 1] = held;
  return {
    rows: top.map((w) => ({
      id: w.id,
      symbol: w.symbol,
      venues: `${venueName(w.longVenue)} / ${venueName(w.shortVenue)}`,
      netAprPct: w.netAprPct,
      held: w.held !== null,
      under: minimum !== null && w.netAprPct < minimum,
    })),
    open: open.length,
    above: minimum === null ? null : open.filter((w) => w.netAprPct >= minimum).length,
  };
}

/** `4 of 26 open markets pay more than 5%`: the dot plot's note. */
export function marketsNote(plot: MarketsPlot, minimum: number | null): string {
  if (plot.open === 0) return 'no market is open to the desk';
  if (minimum === null || plot.above === null) return `${plot.open} open to the desk`;
  return `${plot.above} of ${plot.open} open markets pay more than ${minText(minimum)}`;
}
