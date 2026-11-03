// The strategy loop's decision (docs/interfaces.md §3 "Strategy loop"): what the desk does next, from the scan, the
// held pair and the owner's StrategyConfig. Pure: the time, the veto answer and the saved counters come in as
// arguments, and nothing here signs, sends or reads a venue. loop.ts (serve) carries the decision out.
//
// The rules, in the order decide() applies them:
// - off: strategy.auto false. The counters still move, so turning auto on does not wait out the hours again.
// - held, at once: drawdown (held.pnlUsd against held.legUsd) at stopDrawdownPct, or the maxHoldDays time stop: exit.
// - held, counted: rotate into another window that beat the held one by rotate.minGainPts for rotate.forHours hourly
//   checks in a row and whose switchCostUsd pays back within the rest of the hold at that gain (windows on the
//   held pair's venues first, at most maxRotationsPerDay in 24 h); else exit after exitAfterChecks hourly checks in a
//   row of compression (net over the rest of the hold < 0 or under minNetAprPct) or a flipped spread; else hold.
// - flat: after an exit, nothing for cooldownHours; then the top of the scanner's ranked list among the windows that
//   passed the entry rules for enterAfterChecks hourly checks in a row: enter it, sized by sizeFor; if it cannot be
//   sized, wait. Else wait, saying what it waits for.
// No model picks the window, the size or the leverage: the NEAR AI veto (veto.ts) can only drop a window.
//
// Counters move only on hourly checks (one after each funding payment): a 5 s scan event can act on counts already
// reached, never add to them. The counters a Decision returns assume its `act` is carried out; when the veto refuses
// it or it fails, save skipAct(decision) instead.

import type { StrategyConfig, StrategyDecision, Window as FundingWindow } from '@gimbal/shared';
import { DEFAULT_SCANNER_CONFIG } from '../scanner/config.ts';
import { HOURS_PER_YEAR } from '../scanner/costs.ts';
import { isEnterable } from '../scanner/price.ts';
import { MAX_LEVERAGE, NO_RESCUE_MAX_LEVERAGE } from '../trade/carry-plan.ts';
import { commonLot, floorToLot, qtyNumber, qtyString, toQty } from '../trade/lots.ts';
import { venueName } from '../venues/names.ts';

/** The rules StrategyConfig does not carry: engine constants, proposed for E10 and printed at start. */
export const LOOP_RULES = {
  enterAfterChecks: 3,        // hourly checks in a row a window must hold before entry
  exitAfterChecks: 3,         // hourly checks in a row of compression or a sign flip before exit
  cooldownHours: 6,           // after an exit, no new entry for this long
  maxHoldDays: 14,            // time stop
  maxRotationsPerDay: 2,
  vetoTimeoutMs: 5_000,       // NEAR AI veto: no answer in time = pass, journaled as "no veto check"
} as const;

/** The pair the desk holds, as the loop sees it. */
export interface HeldPair {
  windowId: string;
  symbol: string;
  since: number;              // ms, when it was entered
  legUsd: number;
  entryNetAprPct: number;
  pnlUsd: number;             // open P&L of both legs plus funding received, net of fees paid, since entry
}

/** What decide() remembers between checks; loop.ts saves it to disk so a restart keeps the counts. */
export interface LoopCounters {
  aboveByWindow: Record<string, number>;   // window id -> hourly checks in a row it passed the entry rules
  badChecks: number;                       // hourly checks in a row the held window compressed or flipped
  betterByWindow: Record<string, number>;  // window id -> hourly checks in a row it beat the held one by minGainPts
  lastExitAt: number | null;               // ms
  rotationsAt: number[];                   // ms of the rotations in the last 24 h
  lastHourlyAt: number | null;             // ms of the last hourly check (counters move only on those)
  lastWaitReason: string | null;           // a wait is journaled only when this changes
}

export const NO_COUNTERS: LoopCounters = {
  aboveByWindow: {}, badChecks: 0, betterByWindow: {}, lastExitAt: null, rotationsAt: [], lastHourlyAt: null,
  lastWaitReason: null,
};

export interface DecideInput {
  now: number;                             // ms
  hourly: boolean;                         // this check is the hourly one (after a funding payment), not a scan event
  windows: readonly FundingWindow[];       // the latest scan
  held: HeldPair | null;
  strategy: StrategyConfig;
  maxNotionalUsd: number;                  // the desk policy's max_notional_usd
  freeMarginUsd: Record<string, number>;   // venue id -> free margin there now
  liveRescue: Record<string, boolean>;     // venue id -> a live rescue route covers a leg there
  counters: LoopCounters;
  /**
   * The desk policy's price_band_bps: a leg is capped at max_notional_usd less the band, as pair-mainnet caps it.
   * Absent = DEFAULT_PRICE_BAND_BPS.
   */
  priceBandBps?: number;
  /**
   * Window id -> its 14-day gross APR in its listed direction (scanner.carry(id)?.estimate.gross.d14AprPct). Window
   * carries only the 7 days. Absent or null for a window = not known here: the scanner already drops a desk window
   * whose 7 and 14 days disagree (it is not listed, and its carry gate fails), so only a known 14 days is checked.
   */
  gross14dAprPct?: Record<string, number | null>;
  /**
   * Window id -> each leg's lot (base units per lot on its venue, Market.lotSize) and the price the size is taken at
   * (USD per base unit: the mid pair-mainnet sizes on). A leg is rounded down to whole lots of the two venues'
   * common lot, as pair-mainnet rounds it. A window with no entry here is not entered: its size cannot be rounded.
   */
  lots?: Record<string, { longLot: number | string; shortLot: number | string; px: number }>;
}

export interface Decision {
  decision: StrategyDecision;              // published as the `decision` event when it changes
  counters: LoopCounters;                  // to save
  act:                                     // what loop.ts carries out; null = nothing to sign
    | { kind: 'enter'; windowId: string; legUsd: number; leverage: number }
    | { kind: 'exit'; reason: string }
    | { kind: 'rotate'; fromId: string; toId: string; legUsd: number; leverage: number }
    | null;
  vetoCandidate: string | null;            // enter/rotate target that still needs the NEAR AI veto before `act` runs
}

const HOUR_MS = 3_600_000;
/** pair-mainnet's band when the policy's is not passed: the draft default, and the mainnet desk's. */
export const DEFAULT_PRICE_BAND_BPS = 100;
/** The smallest leg worth opening: Hyperliquid refuses an order under 10 USD of value. */
export const MIN_LEG_USD = 10;
/** An hourly check this soon after the last one counts as a scan event: a restart must not count an hour twice. */
const MIN_HOURLY_GAP_MS = HOUR_MS / 2;
/** Hourly checks further apart than this are not "in a row": the counts start again. */
const MAX_HOURLY_GAP_MS = 2 * HOUR_MS;

// ---- formatting: one line a person reads, with the numbers ----

const pct = (n: number) => `${n.toFixed(1)} %`;
const minimum = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} %`;
const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const lev = (n: number) => `${Number(n.toFixed(2))}x`;
const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;
const pair = (w: FundingWindow) => `${w.symbol} (long ${venueName(w.longVenue)}, short ${venueName(w.shortVenue)})`;

// ---- the entry rules ----

/** Why a window fails the entry rules now, in a few words; null when it passes them all. */
export function entryFailure(w: FundingWindow, input: Pick<DecideInput, 'strategy' | 'gross14dAprPct'>): string | null {
  const min = input.strategy.minNetAprPct;
  if (!w.tradable) return 'watch only';
  if (!isEnterable(w)) {
    if (w.refused !== undefined) return `refused ${w.refused.code}: ${w.refused.reason}`;
    if (w.stale) return 'its numbers are stale';
    if (w.veto?.verdict === 'veto') return `vetoed by NEAR AI${w.veto.reasons[0] === undefined ? '' : `: ${w.veto.reasons[0]}`}`;
    const failing = w.checks.find((c) => !c.ok);
    return failing === undefined ? 'not enterable' : failing.text;
  }
  if (w.netAprPct < min) return `${pct(w.netAprPct)} net, under your ${minimum(min)} minimum`;
  if (!(w.grossAprPct > 0)) return `this hour pays ${pct(w.grossAprPct)}: it does not agree with the multi-day spread`;
  if (w.grossApr7dPct === null) return 'no 7-day spread yet';
  if (!(w.grossApr7dPct > 0)) return `the 7-day spread is ${pct(w.grossApr7dPct)}`;
  const d14 = input.gross14dAprPct?.[w.id] ?? null;
  if (d14 !== null && !(d14 > 0)) return `the 14-day spread is ${pct(d14)}`;
  const need = input.strategy.legUsd / DEFAULT_SCANNER_CONFIG.deskMaxOiShare;
  if (w.depthUsd < need) return `capacity ${usd(w.depthUsd)}, under the ${usd(need)} a ${usd(input.strategy.legUsd)} leg needs`;
  return null;
}

/** Whether the held window compressed or flipped this check, and how, for the hold and exit lines. */
export function heldTrouble(
  w: FundingWindow, held: HeldPair, input: Pick<DecideInput, 'now' | 'strategy' | 'gross14dAprPct'>,
): string | null {
  const min = input.strategy.minNetAprPct;
  const restHours = Math.max(0, LOOP_RULES.maxHoldDays * 24 - (input.now - held.since) / HOUR_MS);
  const restUsd = (w.netAprPct / 100) * held.legUsd * (restHours / HOURS_PER_YEAR);
  if (restUsd < 0) return `${pct(w.netAprPct)} net, ${usd(restUsd)} over the ${Math.round(restHours)} h left`;
  if (w.netAprPct < min) return `${pct(w.netAprPct)} net, under your ${minimum(min)} minimum`;
  if (w.grossAprPct < 0) return `the spread flipped: this hour pays ${pct(w.grossAprPct)}`;
  if (w.grossApr7dPct !== null && !(w.grossApr7dPct > 0)) return `the spread flipped: the 7-day spread is ${pct(w.grossApr7dPct)}`;
  const d14 = input.gross14dAprPct?.[w.id] ?? null;
  if (d14 !== null && !(d14 > 0)) return `the spread flipped: the 14-day spread is ${pct(d14)}`;
  return null;
}

// ---- sizing ----

export type Sizing = { ok: true; legUsd: number; leverage: number } | { ok: false; why: string };

/**
 * The leg size and leverage for a window, deterministic (no model ever sizes): the smallest of strategy.legUsd,
 * max_notional_usd less the price band (the contract values an order at up to the band over the oracle, so
 * pair-mainnet caps a leg at 19.80 under 20 and 100 bps), each leg venue's free margin at the leverage, and the
 * depth on both legs (the leg at most deskMaxOiShare of the smaller leg's open interest); then rounded down to whole
 * common lots of the two venues. Leverage: strategy.maxLeverage, at most MAX_LEVERAGE, and at most
 * NO_RESCUE_MAX_LEVERAGE when a leg's venue has no live rescue. `freed` adds margin a close frees first (a rotation
 * closes the held legs before it opens).
 */
export function sizeFor(
  w: FundingWindow,
  input: Pick<DecideInput, 'strategy' | 'maxNotionalUsd' | 'freeMarginUsd' | 'liveRescue' | 'priceBandBps' | 'lots'>,
  freed: Record<string, number> = {},
): Sizing {
  const venues = [w.longVenue, w.shortVenue];
  const noRescue = venues.filter((v) => input.liveRescue[v] !== true);
  const leverage = Math.min(input.strategy.maxLeverage, MAX_LEVERAGE, noRescue.length > 0 ? NO_RESCUE_MAX_LEVERAGE : Infinity);
  if (!(leverage > 0)) return { ok: false, why: `leverage ${input.strategy.maxLeverage}x is not above 0` };
  const band = input.priceBandBps ?? DEFAULT_PRICE_BAND_BPS;
  const caps: { usd: number; why: string }[] = [
    { usd: input.strategy.legUsd, why: `your ${usd(input.strategy.legUsd)} leg` },
    { usd: input.maxNotionalUsd * (1 - band / 1e4), why: `the policy's ${usd(input.maxNotionalUsd)} cap less the ${band} bps band` },
  ];
  for (const v of venues) {
    const free = Math.max(0, input.freeMarginUsd[v] ?? 0) + (freed[v] ?? 0);
    caps.push({ usd: free * leverage, why: `${usd(free)} free margin on ${venueName(v)} at ${lev(leverage)}` });
  }
  caps.push({ usd: w.depthUsd * DEFAULT_SCANNER_CONFIG.deskMaxOiShare, why: `${usd(w.depthUsd)} of depth on the smaller leg` });
  const binding = caps.reduce((a, b) => (b.usd < a.usd ? b : a));
  const lots = input.lots?.[w.id];
  if (lots === undefined || !(lots.px > 0)) return { ok: false, why: `no lot sizes for ${w.symbol}: its size cannot be rounded to whole lots` };
  let lot: bigint;
  try {
    lot = commonLot(toQty(lots.longLot), toQty(lots.shortLot));
  } catch (err) {
    return { ok: false, why: `${w.symbol}'s lots cannot be combined: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (lot <= 0n) return { ok: false, why: `${w.symbol} has a lot of zero` };
  const size = floorToLot(toQty((binding.usd / lots.px).toFixed(8)), lot);
  if (size === 0n) {
    return { ok: false, why: `${binding.why} sizes a leg at ${usd(binding.usd)}, under one common lot (${qtyString(lot)} ${w.symbol} at ${lots.px})` };
  }
  const legUsd = Math.floor(qtyNumber(size) * lots.px * 100) / 100;
  if (legUsd < MIN_LEG_USD) {
    return { ok: false, why: `${binding.why} sizes a leg at ${usd(legUsd)} in whole lots, under the ${usd(MIN_LEG_USD)} minimum` };
  }
  return { ok: true, legUsd, leverage };
}

// ---- counters ----

/** Whether this check counts as hourly: flagged so, and not within half an hour of the last one. */
function countsAsHourly(input: DecideInput): boolean {
  const last = input.counters.lastHourlyAt;
  return input.hourly && (last === null || input.now - last >= MIN_HOURLY_GAP_MS);
}

function bump(previous: Record<string, number>, ids: readonly string[], broken: boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = (broken ? 0 : (previous[id] ?? 0)) + 1;
  return out;
}

/** The counters after this check's counting (before any act). */
function count(input: DecideInput, hourly: boolean, heldW: FundingWindow | null): LoopCounters {
  const c = input.counters;
  const rotationsAt = c.rotationsAt.filter((t) => input.now - t < 24 * HOUR_MS);
  if (!hourly) return { ...c, rotationsAt };
  const broken = c.lastHourlyAt !== null && input.now - c.lastHourlyAt > MAX_HOURLY_GAP_MS;
  const passing = input.windows.filter((w) => entryFailure(w, input) === null);
  const aboveByWindow = bump(c.aboveByWindow, passing.map((w) => w.id), broken);
  let badChecks = 0;
  let betterByWindow: Record<string, number> = {};
  const held = input.held;
  if (held !== null && heldW !== null && !heldW.stale) {
    badChecks = heldTrouble(heldW, held, input) === null ? 0 : (broken ? 0 : c.badChecks) + 1;
    const better = passing.filter((w) => w.id !== held.windowId && w.netAprPct - heldW.netAprPct >= input.strategy.rotate.minGainPts);
    betterByWindow = bump(c.betterByWindow, better.map((w) => w.id), broken);
  } else if (held !== null) {
    // The held window's numbers are missing or old this hour: neither for nor against it.
    badChecks = c.badChecks;
    betterByWindow = c.betterByWindow;
  }
  return { ...c, aboveByWindow, badChecks, betterByWindow, rotationsAt, lastHourlyAt: input.now };
}

// ---- decide ----

export function decide(input: DecideInput): Decision {
  const held = input.held;
  const heldW = held === null ? null : (input.windows.find((w) => w.id === held.windowId) ?? null);
  const counters = count(input, countsAsHourly(input), heldW);
  const out = (action: StrategyDecision['action'], reason: string, windowId: string | null, act: Decision['act'] = null, waitKey: string | null = null): Decision => ({
    decision: { action, reason, windowId, heldId: held?.windowId ?? null, at: input.now },
    counters: { ...afterAct(counters, act, input.now), lastWaitReason: action === 'wait' ? waitKey ?? reason : null },
    act,
    vetoCandidate: act?.kind === 'enter' ? act.windowId : act?.kind === 'rotate' ? act.toId : null,
  });

  if (!input.strategy.auto) {
    const what = held === null ? flatStatus(input, counters).line : `the desk holds ${held.symbol}`;
    return out('off', `Auto is off: the engine watches and you act by hand; ${what}`, held?.windowId ?? null);
  }
  if (held !== null) return decideHeld(input, held, heldW, counters, out);
  return decideFlat(input, counters, out);
}

type Out = (action: StrategyDecision['action'], reason: string, windowId: string | null, act?: Decision['act'], waitKey?: string | null) => Decision;

function decideHeld(input: DecideInput, held: HeldPair, heldW: FundingWindow | null, counters: LoopCounters, out: Out): Decision {
  const { strategy, now } = input;
  const heldHours = (now - held.since) / HOUR_MS;
  const day = `day ${Math.floor(heldHours / 24) + 1} of ${LOOP_RULES.maxHoldDays}`;

  // At once, whatever the counts.
  const stop = strategy.stopDrawdownPct;
  const downPct = held.legUsd > 0 ? (-held.pnlUsd / held.legUsd) * 100 : 0;
  if (stop !== null && held.pnlUsd < 0 && downPct >= stop) {
    const reason = `Exit ${held.symbol}: down ${usd(-held.pnlUsd)}, ${downPct.toFixed(1)} % of the ${usd(held.legUsd)} leg, at your ${minimum(stop)} stop`;
    return out('exit', reason, held.windowId, { kind: 'exit', reason });
  }
  if (heldHours >= LOOP_RULES.maxHoldDays * 24) {
    const reason = `Exit ${held.symbol}: held ${(heldHours / 24).toFixed(1)} days, the ${LOOP_RULES.maxHoldDays}-day time stop`;
    return out('exit', reason, held.windowId, { kind: 'exit', reason });
  }
  if (heldW === null) return out('hold', `Hold ${held.symbol}: its window is not in this scan, so nothing is decided on it; ${day}`, held.windowId);
  if (heldW.stale) return out('hold', `Hold ${held.symbol}: its numbers are stale this scan, so nothing is decided on them; ${day}`, held.windowId);

  // Rotation.
  const restHours = Math.max(0, LOOP_RULES.maxHoldDays * 24 - heldHours);
  const rot = rotation(input, held, heldW, counters, restHours);
  if (rot.kind === 'rotate') {
    const { w, size, gain, paybackHours } = rot;
    const n = counters.betterByWindow[w.id] ?? 0;
    const reason = `Rotate ${held.symbol} -> ${pair(w)}: ${pct(w.netAprPct)} net vs ${pct(heldW.netAprPct)}, +${gain.toFixed(1)} pts for `
      + `${n} of ${strategy.rotate.forHours} hours; the ${usd(w.switchCostUsd!)} switch pays back in ${(paybackHours / 24).toFixed(1)} of the `
      + `${(restHours / 24).toFixed(1)} days left; ${usd(size.legUsd)} a leg at ${lev(size.leverage)}`;
    return out('rotate', reason, w.id, { kind: 'rotate', fromId: held.windowId, toId: w.id, legUsd: size.legUsd, leverage: size.leverage });
  }

  // Counted exit.
  const trouble = heldTrouble(heldW, held, input);
  if (trouble !== null && counters.badChecks >= LOOP_RULES.exitAfterChecks) {
    const reason = `Exit ${held.symbol}: ${trouble}, ${counters.badChecks} of ${hours(LOOP_RULES.exitAfterChecks)} in a row`;
    return out('exit', reason, held.windowId, { kind: 'exit', reason });
  }
  const now_ = trouble === null
    ? `${pct(heldW.netAprPct)} net, at least your ${minimum(strategy.minNetAprPct)} minimum`
    : `${trouble}, ${counters.badChecks} of ${hours(LOOP_RULES.exitAfterChecks)} before exit`;
  return out('hold', `Hold ${held.symbol}: ${now_}; ${day}${rot.note === null ? '' : `; ${rot.note}`}`, held.windowId);
}

type Rotation =
  | { kind: 'rotate'; w: FundingWindow; size: { legUsd: number; leverage: number }; gain: number; paybackHours: number }
  | { kind: 'none'; note: string | null };

/** The rotation to make now, or a note on the closest challenger for the hold line. */
function rotation(input: DecideInput, held: HeldPair, heldW: FundingWindow, counters: LoopCounters, restHours: number): Rotation {
  const { strategy } = input;
  const heldVenues = new Set([heldW.longVenue, heldW.shortVenue]);
  const same = (w: FundingWindow) => heldVenues.has(w.longVenue) && heldVenues.has(w.shortVenue);
  const challengers = input.windows
    .filter((w) => w.id !== held.windowId && (counters.betterByWindow[w.id] ?? 0) > 0 && entryFailure(w, input) === null)
    .map((w) => ({ w, gain: w.netAprPct - heldW.netAprPct }))
    .filter((c) => c.gain >= strategy.rotate.minGainPts)
    // Windows on the venues that already hold the margin first, then in the scanner's rank (a stable sort).
    .sort((a, b) => Number(same(b.w)) - Number(same(a.w)));
  if (challengers.length === 0) return { kind: 'none', note: null };
  const recent = counters.rotationsAt.length;
  const blocked: string[] = [];
  // A rotation closes the held legs first: their margin is free again for the new legs.
  for (const { w, gain } of challengers) {
    const n = counters.betterByWindow[w.id] ?? 0;
    if (n < strategy.rotate.forHours) {
      blocked.push(`${w.symbol} beats it by ${gain.toFixed(1)} pts, ${n} of ${strategy.rotate.forHours} hours`);
      continue;
    }
    if (recent >= LOOP_RULES.maxRotationsPerDay) {
      blocked.push(`${w.symbol} beats it by ${gain.toFixed(1)} pts, but ${recent} rotations in 24 h is the most`);
      continue;
    }
    if (w.switchCostUsd === null) {
      blocked.push(`${w.symbol} beats it by ${gain.toFixed(1)} pts, but its switch cost is not known`);
      continue;
    }
    const gainUsdPerHour = (gain / 100) * strategy.legUsd / HOURS_PER_YEAR;
    const paybackHours = w.switchCostUsd / gainUsdPerHour;
    if (!(paybackHours <= restHours)) {
      blocked.push(`${w.symbol} beats it by ${gain.toFixed(1)} pts, but the ${usd(w.switchCostUsd)} switch takes ${(paybackHours / 24).toFixed(1)} days to pay back, `
        + `${(restHours / 24).toFixed(1)} are left`);
      continue;
    }
    // The held legs' leverage is not known here: the most they can run at frees the least margin.
    const freed: Record<string, number> = {};
    const heldLeverage = Math.min(strategy.maxLeverage, MAX_LEVERAGE);
    if (heldLeverage > 0) for (const v of heldVenues) freed[v] = held.legUsd / heldLeverage;
    const size = sizeFor(w, input, freed);
    // The first window the rules allow is the one: if it cannot be sized, nothing rotates this check.
    if (!size.ok) return { kind: 'none', note: `${w.symbol} beats it by ${gain.toFixed(1)} pts, but ${size.why}` };
    return { kind: 'rotate', w, size, gain, paybackHours };
  }
  return { kind: 'none', note: blocked[0] ?? null };
}

interface FlatStatus {
  line: string;          // what the best window is doing, for the wait and off lines
  key: string;           // the same, without numbers that move every scan: the wait journal key
  windowId: string | null;   // the window waited for: the best one passing the entry rules
}

/** The best window's standing against the entry rules. */
function flatStatus(input: DecideInput, counters: LoopCounters): FlatStatus {
  const min = input.strategy.minNetAprPct;
  // The scanner's rank decides which window is best: never this module's own order, never a model.
  const passing = input.windows.filter((w) => entryFailure(w, input) === null);
  const best = passing[0];
  if (best !== undefined) {
    const n = Math.min(counters.aboveByWindow[best.id] ?? 0, LOOP_RULES.enterAfterChecks);
    return {
      line: `${best.symbol} ${pct(best.netAprPct)} net, ${n} of ${LOOP_RULES.enterAfterChecks} hours above ${minimum(min)}`,
      key: `warming:${best.id}:${n}`,
      windowId: best.id,
    };
  }
  const desk = input.windows.filter((w) => w.tradable);
  const top = desk[0];
  if (top === undefined) return { line: 'no desk window in this scan', key: 'none', windowId: null };
  return {
    line: `no window clears the entry rules; best ${top.symbol} ${pct(top.netAprPct)} net: ${entryFailure(top, input)}`,
    key: `blocked:${top.id}`,
    windowId: null,
  };
}

function decideFlat(input: DecideInput, counters: LoopCounters, out: Out): Decision {
  const status = flatStatus(input, counters);
  const last = counters.lastExitAt;
  const coolUntil = last === null ? null : last + LOOP_RULES.cooldownHours * HOUR_MS;
  if (coolUntil !== null && input.now < coolUntil) {
    const left = (coolUntil - input.now) / HOUR_MS;
    return out('wait', `Cooling down after the exit, ${left.toFixed(1)} h left; ${status.line}`, status.windowId, null, `cooldown:${status.key}`);
  }
  // The top of the scanner's ranked list among the windows the rules allow: that one or none (a window that cannot
  // be sized is waited on, not swapped for the next).
  const w = input.windows
    .find((x) => entryFailure(x, input) === null && (counters.aboveByWindow[x.id] ?? 0) >= LOOP_RULES.enterAfterChecks);
  if (w === undefined) return out('wait', capitalize(status.line), status.windowId, null, status.key);
  const size = sizeFor(w, input);
  if (!size.ok) return out('wait', `${w.symbol} ${pct(w.netAprPct)} net is ready, but ${size.why}`, w.id, null, `size:${w.id}`);
  const n = counters.aboveByWindow[w.id] ?? 0;
  const reason = `Enter ${pair(w)}: ${pct(w.netAprPct)} net, ${Math.min(n, LOOP_RULES.enterAfterChecks)} of ${LOOP_RULES.enterAfterChecks} hours above `
    + `${minimum(input.strategy.minNetAprPct)}, 7-day ${pct(w.grossApr7dPct!)} and this hour ${pct(w.grossAprPct)}; ${usd(size.legUsd)} a leg at ${lev(size.leverage)}`;
  return out('enter', reason, w.id, { kind: 'enter', windowId: w.id, legUsd: size.legUsd, leverage: size.leverage });
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** The counters once `act` is carried out: the exit starts the cooldown, a rotation counts toward the day's limit. */
function afterAct(c: LoopCounters, act: Decision['act'], now: number): LoopCounters {
  if (act === null) return c;
  switch (act.kind) {
    case 'enter': return { ...c, badChecks: 0, betterByWindow: {} };
    case 'exit': return { ...c, badChecks: 0, betterByWindow: {}, lastExitAt: now };
    case 'rotate': return { ...c, badChecks: 0, betterByWindow: {}, rotationsAt: [...c.rotationsAt, now] };
  }
}

/**
 * The counters to save when a decision's act is not carried out (the veto refused it, or it failed): this check's
 * counts stay, the act's own marks (the cooldown start, the rotation slot, the reset counts) do not. An exit that
 * failed is tried again on the next check, its bad checks still counted. `input` is the one decide() was given.
 */
export function skipAct(input: DecideInput, d: Decision): LoopCounters {
  if (d.act === null) return d.counters;
  const held = input.held;
  const heldW = held === null ? null : (input.windows.find((w) => w.id === held.windowId) ?? null);
  return { ...count(input, countsAsHourly(input), heldW), lastWaitReason: d.counters.lastWaitReason };
}

/** Whether loop.ts journals this decision as a `wait`: only when its reason changed since the last check. */
export function journalWait(previous: LoopCounters, d: Decision): boolean {
  return d.decision.action === 'wait' && d.counters.lastWaitReason !== previous.lastWaitReason;
}
