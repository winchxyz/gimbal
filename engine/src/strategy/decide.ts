// The strategy loop's decision (docs/interfaces.md §3 "Strategy loop"): what the desk does next, from the scan, the
// held pair and the owner's StrategyConfig. Pure: the time, the veto answer and the saved counters come in as
// arguments, and nothing here signs, sends or reads a venue. loop.ts (serve) carries the decision out.
//
// The rules, in the order decide() applies them:
// - off: strategy.auto false. The counters still move, so turning auto on does not wait out the hours again.
// - held, at once, first: the maxHoldDays time stop (needs only a finite held.since), or drawdown at stopDrawdownPct
//   (needs a finite held.pnlUsd, held.legUsd > 0 and a finite stop): exit. Drawdown is the held pair's P&L
//   (held.pnlUsd) against one leg's notional (held.legUsd): -1.20 USD on a 12 USD leg is 10 %. No other number,
//   known or not, keeps a stop from firing.
// - held, numbers unknown: past the stops, a P&L, leg size, net or rule that is not a finite number (or a leg size
//   <= 0) means no act: wait, "held pair numbers unknown", and the held window is never counted healthy that hour.
// - held, counted: rotate into another window that beat the held one by rotate.minGainPts for rotate.forHours hourly
//   checks in a row and whose switchCostUsd pays back within the rest of the hold at that gain on the new leg's size
//   (windows on the held pair's venues first, at most maxRotationsPerDay in 24 h); else exit after exitAfterChecks
//   hourly checks in a row of compression or a flipped spread; else hold. The held window is measured from here
//   (heldForwardAprPct): its multi-day gross less the exit still to pay (half the fills and slippage plus the basis
//   buffer, a constant number of points as the scanner spread them over its hold, never re-spread over the hours
//   left: the exit is paid whenever the pair leaves); the opening fills are sunk. Compression holds that to
//   minNetAprPct; a challenger's gain is its net APR less that.
// - flat: after an exit, nothing for cooldownHours; then the top of the scanner's ranked list among the windows that
//   pass the entry rules now: once it has passed them for enterAfterChecks hourly checks in a row, enter it, sized by
//   sizeFor; until then, or if it cannot be sized, wait. A lower window is never entered in its place.
// No model picks the window, the size or the leverage: the NEAR AI veto (veto.ts) can only drop a window. A vetoed
// window is held out for LOOP_RULES.vetoHoldHours (skipAct with { vetoed: true }), so the veto is not asked again
// until it passes.
//
// Counters move only on hourly checks (one after each funding payment): a 5 s scan event can act on counts already
// reached, never add to them. The counters a Decision returns assume its `act` is carried out; when the veto refuses
// it or it fails, save skipAct(input, decision, ...) instead.
//
// The executor (loop.ts) opens `qty` base units a leg, as given: it never derives a size again from legUsd. `qty` is
// a maximum: the contract values an order at sz x max(limit, oracle), so at order time the executor checks that
// against the cap again and, if a price rise put it over, rounds `qty` down (never up) to whole common lots, the
// same on both legs, before either leg is sent. On a rotate it sets HeldPair.since to the rotation time, so the time
// stop and the payback horizon start again.

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
  vetoTimeoutMs: 5_000,       // NEAR AI veto: no answer in time = pass, journaled as "no NEAR AI risk check"
  vetoHoldHours: 6,           // a window NEAR AI risk check refused is not entered or rotated into for this long
} as const;

/** The pair the desk holds, as the loop sees it. */
export interface HeldPair {
  windowId: string;
  symbol: string;
  since: number;              // ms, when it was entered, or rotated into (loop.ts sets it on a rotate)
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
  vetoedUntil: Record<string, number>;     // window id -> ms until which a NEAR AI veto holds it out
  vetoWhy?: Record<string, string>;        // window id -> the risk check's why line for that hold-out (absent: none kept)
}

export const NO_COUNTERS: LoopCounters = {
  aboveByWindow: {}, badChecks: 0, betterByWindow: {}, lastExitAt: null, rotationsAt: [], lastHourlyAt: null,
  lastWaitReason: null, vetoedUntil: {},
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
  /**
   * Venue id -> the margin closing the held legs frees there (their margin plus that leg's P&L), measured by
   * loop.ts. A rotation sizes the new legs on free margin plus this. Absent = none counted.
   */
  freedMarginUsd?: Record<string, number>;
}

export interface Decision {
  decision: StrategyDecision;              // published as the `decision` event when it changes
  counters: LoopCounters;                  // to save
  act:                                     // what loop.ts carries out; null = nothing to sign
    // qty: base units a leg, whole common lots of both venues (canonical decimal), a maximum. The executor never
    // derives a size again from legUsd (qty at the price it was sized at); at order time it re-checks
    // qty x max(limit, oracle) <= the cap and only rounds qty down, the same on both legs, before either is sent.
    | { kind: 'enter'; windowId: string; legUsd: number; leverage: number; qty: string }
    | { kind: 'exit'; reason: string }
    | { kind: 'rotate'; fromId: string; toId: string; legUsd: number; leverage: number; qty: string }
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

/** A number decide() may act on: NaN and the infinities never pass a gate, a cap or a stop. */
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

// ---- formatting: one line a person reads, with the numbers ----

const pct = (n: number) => `${n.toFixed(1)} %`;
const minimum = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} %`;
const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const lev = (n: number) => `${Number(n.toFixed(2))}x`;
const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;
const pair = (w: FundingWindow) => `${w.symbol} (long ${venueName(w.longVenue)}, short ${venueName(w.shortVenue)})`;

/** Saved counters from before a field existed (vetoedUntil) read as if it were empty. */
function normalized(c: LoopCounters): LoopCounters {
  const v = (c as Partial<LoopCounters>).vetoedUntil;
  return v !== undefined && typeof v === 'object' && v !== null ? c : { ...c, vetoedUntil: {} };
}

/** The risk check's why line kept with a window's hold-out, as " (<why>)", or "". */
function vetoWhyText(c: Pick<LoopCounters, 'vetoWhy'> | undefined, id: string): string {
  const why = (c as Partial<LoopCounters> | undefined)?.vetoWhy?.[id];
  return typeof why === 'string' && why !== '' ? ` (${why})` : '';
}

/** Hours a NEAR AI veto still holds `id` out, or null. */
function vetoHoursLeft(c: Pick<LoopCounters, 'vetoedUntil'> | undefined, id: string, now: number | undefined): number | null {
  const until = (c as Partial<LoopCounters> | undefined)?.vetoedUntil?.[id];
  if (until === undefined || now === undefined || !(now < until)) return null;
  return (until - now) / HOUR_MS;
}

// ---- the entry rules ----

/** Why a window fails the entry rules: a category (the wait journal key) and a line. */
interface GateFailure { code: string; text: string }

type GateInput = Pick<DecideInput, 'strategy' | 'gross14dAprPct'> & Partial<Pick<DecideInput, 'now' | 'counters'>>;

function gate(w: FundingWindow, input: GateInput): GateFailure | null {
  const min = input.strategy.minNetAprPct;
  const legUsd = input.strategy.legUsd;
  if (!w.tradable) return { code: 'watch', text: 'watch only' };
  const vetoLeft = vetoHoursLeft(input.counters, w.id, input.now);
  if (vetoLeft !== null) return { code: 'vetoed', text: `refused by the NEAR AI risk check${vetoWhyText(input.counters, w.id)}, held out for ${vetoLeft.toFixed(1)} h more` };
  if (!isEnterable(w)) {
    if (w.refused !== undefined) return { code: 'refused', text: `refused ${w.refused.code}: ${w.refused.reason}` };
    if (w.stale) return { code: 'stale', text: 'its numbers are stale' };
    if (w.veto?.verdict === 'veto') return { code: 'vetoed', text: `refused by the NEAR AI risk check${w.veto.reasons[0] === undefined ? '' : `: ${w.veto.reasons[0]}`}` };
    const failing = w.checks.find((c) => !c.ok);
    return { code: 'check', text: failing === undefined ? 'not enterable' : failing.text };
  }
  const d14 = input.gross14dAprPct?.[w.id] ?? null;
  const numbers: [string, unknown][] = [
    ['its net APR', w.netAprPct], ['its gross APR this hour', w.grossAprPct], ['its capacity', w.depthUsd],
    ['its 7-day spread', w.grossApr7dPct ?? 0], ['its 14-day spread', d14 ?? 0], ['your minimum', min], ['your leg size', legUsd],
  ];
  for (const [name, v] of numbers) if (!finite(v)) return { code: 'numbers', text: `${name} is not a number (${String(v)})` };
  if (w.netAprPct < min) return { code: 'minimum', text: `${pct(w.netAprPct)} net, under your ${minimum(min)} minimum` };
  if (!(w.grossAprPct > 0)) return { code: 'hour', text: `this hour pays ${pct(w.grossAprPct)}: it does not agree with the multi-day spread` };
  if (w.grossApr7dPct === null) return { code: 'no7d', text: 'no 7-day spread yet' };
  if (!(w.grossApr7dPct > 0)) return { code: '7d', text: `the 7-day spread is ${pct(w.grossApr7dPct)}` };
  if (d14 !== null && !(d14 > 0)) return { code: '14d', text: `the 14-day spread is ${pct(d14)}` };
  const need = legUsd / DEFAULT_SCANNER_CONFIG.deskMaxOiShare;
  if (w.depthUsd < need) return { code: 'depth', text: `capacity ${usd(w.depthUsd)}, under the ${usd(need)} a ${usd(legUsd)} leg needs` };
  return null;
}

/** Why a window fails the entry rules now, in a few words; null when it passes them all. */
export function entryFailure(w: FundingWindow, input: GateInput): string | null {
  return gate(w, input)?.text ?? null;
}

// ---- the held pair ----

/**
 * The held window's net APR from here: its multi-day gross (Window.netAprPct plus the costs the scanner took off it)
 * less the exit still to pay (half the fees and slippage, plus the basis buffer), in the points the scanner spread
 * them over its hold. The opening fills are sunk. The exit points are a constant: the exit is paid whether the pair
 * leaves now or at the time stop, so it never times the exit. Compression holds this to minNetAprPct, and a
 * challenger's gain is its net APR less this.
 */
export function heldForwardAprPct(w: FundingWindow): number {
  const c = w.costs;
  const grossAprPct = w.netAprPct + c.feesPct + c.slippagePct + c.basisPct + c.rescueReservePct;
  const exitPts = (c.feesPct + c.slippagePct) / 2 + c.basisPct;
  return grossAprPct - exitPts;
}

/** Whether a stop can be judged: the time stop needs a finite `since`; the drawdown stop needs these. */
function drawdownKnown(held: HeldPair, stop: number | null): stop is number {
  return stop !== null && finite(stop) && finite(held.pnlUsd) && finite(held.legUsd) && held.legUsd > 0;
}

/** What about the held pair is not a number decide() can measure it by (past the stops), or null. */
function heldUnknown(held: HeldPair, heldW: FundingWindow | null, input: Pick<DecideInput, 'strategy'>): string | null {
  const { strategy } = input;
  if (!finite(held.pnlUsd)) return `${held.symbol} P&L is not a number (${String(held.pnlUsd)})`;
  if (!finite(held.legUsd) || held.legUsd <= 0) return `${held.symbol} leg size is not a positive number (${String(held.legUsd)})`;
  if (!finite(held.since)) return `${held.symbol} entry time is not a number`;
  if (strategy.stopDrawdownPct !== null && !finite(strategy.stopDrawdownPct)) return `your drawdown stop is not a number (${String(strategy.stopDrawdownPct)})`;
  if (!finite(strategy.minNetAprPct)) return `your minimum is not a number (${String(strategy.minNetAprPct)})`;
  if (heldW === null) return null;
  const numbers: [string, unknown][] = [
    ['net APR', heldW.netAprPct], ['gross APR this hour', heldW.grossAprPct], ['fees', heldW.costs.feesPct],
    ['slippage', heldW.costs.slippagePct], ['basis buffer', heldW.costs.basisPct], ['rescue reserve', heldW.costs.rescueReservePct],
    ['7-day spread', heldW.grossApr7dPct ?? 0],
  ];
  for (const [name, v] of numbers) if (!finite(v)) return `${held.symbol} ${name} is not a number (${String(v)})`;
  return null;
}

/** Whether the held window compressed or flipped this check, and how, for the hold and exit lines. */
export function heldTrouble(
  w: FundingWindow, input: Pick<DecideInput, 'strategy' | 'gross14dAprPct'>,
): string | null {
  const min = input.strategy.minNetAprPct;
  const net = heldForwardAprPct(w);
  if (net < min) return `${pct(net)} net of the exit, under your ${minimum(min)} minimum`;
  if (w.grossAprPct < 0) return `the spread flipped: this hour pays ${pct(w.grossAprPct)}`;
  if (w.grossApr7dPct !== null && !(w.grossApr7dPct > 0)) return `the spread flipped: the 7-day spread is ${pct(w.grossApr7dPct)}`;
  const d14 = input.gross14dAprPct?.[w.id] ?? null;
  if (d14 !== null && finite(d14) && !(d14 > 0)) return `the spread flipped: the 14-day spread is ${pct(d14)}`;
  return null;
}

// ---- sizing ----

export type Sizing =
  | { ok: true; legUsd: number; leverage: number; qty: string }
  | { ok: false; code: string; why: string };

/**
 * The leg size and leverage for a window, deterministic (no model ever sizes): the smallest of strategy.legUsd,
 * max_notional_usd less the price band (the contract values an order at up to the band over the oracle, so
 * pair-mainnet caps a leg at 19.80 under 20 and 100 bps), each leg venue's free margin at the leverage, and the
 * depth on both legs (the leg at most deskMaxOiShare of the smaller leg's open interest); then rounded down to whole
 * common lots of the two venues: `qty`, base units a leg. Leverage: strategy.maxLeverage, at most MAX_LEVERAGE, and
 * at most NO_RESCUE_MAX_LEVERAGE when a leg's venue has no live rescue. `freed` adds margin a close frees first (a
 * rotation closes the held legs before it opens). A cap that is not a finite number, or is <= 0, sizes nothing.
 */
export function sizeFor(
  w: FundingWindow,
  input: Pick<DecideInput, 'strategy' | 'maxNotionalUsd' | 'freeMarginUsd' | 'liveRescue' | 'priceBandBps' | 'lots'>,
  freed: Record<string, number> = {},
): Sizing {
  const fail = (code: string, why: string): Sizing => ({ ok: false, code, why });
  const venues = [w.longVenue, w.shortVenue];
  const noRescue = venues.filter((v) => input.liveRescue[v] !== true);
  const asked = input.strategy.maxLeverage;
  if (!finite(asked) || asked <= 0) return fail('leverage', `your leverage ${String(asked)}x is not a positive number`);
  const leverage = Math.min(asked, MAX_LEVERAGE, noRescue.length > 0 ? NO_RESCUE_MAX_LEVERAGE : Infinity);
  const band = input.priceBandBps ?? DEFAULT_PRICE_BAND_BPS;
  if (!finite(band) || band < 0 || band >= 1e4) return fail('band', `the policy's price band ${String(band)} bps is not usable`);
  const caps: { code: string; usd: number; why: string }[] = [
    { code: 'leg', usd: input.strategy.legUsd, why: `your ${finite(input.strategy.legUsd) ? usd(input.strategy.legUsd) : String(input.strategy.legUsd)} leg` },
    {
      code: 'policy', usd: input.maxNotionalUsd * (1 - band / 1e4),
      why: `the policy's ${finite(input.maxNotionalUsd) ? usd(input.maxNotionalUsd) : String(input.maxNotionalUsd)} cap less the ${band} bps band`,
    },
  ];
  for (const v of venues) {
    const free = (input.freeMarginUsd[v] ?? 0) + (freed[v] ?? 0);
    caps.push({ code: `margin:${v}`, usd: free * leverage, why: `${finite(free) ? usd(free) : String(free)} free margin on ${venueName(v)} at ${lev(leverage)}` });
  }
  caps.push({ code: 'depth', usd: w.depthUsd * DEFAULT_SCANNER_CONFIG.deskMaxOiShare, why: `${finite(w.depthUsd) ? usd(w.depthUsd) : String(w.depthUsd)} of depth on the smaller leg` });
  for (const c of caps) {
    if (!finite(c.usd)) return fail('numbers', `${c.why} is not a number`);
    if (c.usd <= 0) return fail(c.code, `${c.why} leaves nothing to open`);
  }
  const binding = caps.reduce((a, b) => (b.usd < a.usd ? b : a));
  const lots = input.lots?.[w.id];
  if (lots === undefined || !finite(lots.px) || lots.px <= 0) return fail('lots', `no lot sizes for ${w.symbol}: its size cannot be rounded to whole lots`);
  let lot: bigint;
  try {
    lot = commonLot(toQty(lots.longLot), toQty(lots.shortLot));
  } catch (err) {
    return fail('lots', `${w.symbol}'s lots cannot be combined: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (lot <= 0n) return fail('lots', `${w.symbol} has a lot of zero`);
  const size = floorToLot(toQty((binding.usd / lots.px).toFixed(8)), lot);
  if (size === 0n) {
    return fail(binding.code, `${binding.why} sizes a leg at ${usd(binding.usd)}, under one common lot (${qtyString(lot)} ${w.symbol} at ${lots.px})`);
  }
  const legUsd = Math.floor(qtyNumber(size) * lots.px * 100) / 100;
  if (legUsd < MIN_LEG_USD) {
    return fail(binding.code, `${binding.why} sizes a leg at ${usd(legUsd)} in whole lots, under the ${usd(MIN_LEG_USD)} minimum`);
  }
  return { ok: true, legUsd, leverage, qty: qtyString(size) };
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
  const c0 = normalized(input.counters);
  const vetoedUntil = Object.fromEntries(Object.entries(c0.vetoedUntil).filter(([, t]) => finite(t) && input.now < t));
  const why = c0.vetoWhy === undefined ? undefined : Object.fromEntries(Object.entries(c0.vetoWhy).filter(([id]) => id in vetoedUntil));
  const c: LoopCounters = {
    ...c0, vetoedUntil, ...(why === undefined ? {} : { vetoWhy: why }), rotationsAt: c0.rotationsAt.filter((t) => input.now - t < 24 * HOUR_MS),
  };
  if (!hourly) return c;
  const broken = c.lastHourlyAt !== null && input.now - c.lastHourlyAt > MAX_HOURLY_GAP_MS;
  const gated = { ...input, counters: c };
  const passing = input.windows.filter((w) => gate(w, gated) === null);
  const aboveByWindow = bump(c.aboveByWindow, passing.map((w) => w.id), broken);
  let badChecks = 0;
  let betterByWindow: Record<string, number> = {};
  const held = input.held;
  if (held !== null && heldW !== null && !heldW.stale && heldUnknown(held, heldW, input) === null) {
    badChecks = heldTrouble(heldW, input) === null ? 0 : (broken ? 0 : c.badChecks) + 1;
    const gainPts = input.strategy.rotate.minGainPts;
    const heldApr = heldForwardAprPct(heldW);
    const better = finite(gainPts) ? passing.filter((w) => w.id !== held.windowId && w.netAprPct - heldApr >= gainPts) : [];
    betterByWindow = bump(c.betterByWindow, better.map((w) => w.id), broken);
  } else if (held !== null) {
    // The held window's numbers are missing, old or not numbers this hour: neither for nor against it.
    badChecks = c.badChecks;
    betterByWindow = c.betterByWindow;
  }
  return { ...c, aboveByWindow, badChecks, betterByWindow, lastHourlyAt: input.now };
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

  // The stops first, at once, whatever the counts: each needs only its own numbers, so nothing else that is unknown
  // (a scan number, the minimum) keeps a losing or overdue pair open. Drawdown: the pair's P&L against one leg.
  const stop = strategy.stopDrawdownPct;
  if (drawdownKnown(held, stop)) {
    const downPct = (-held.pnlUsd / held.legUsd) * 100;
    if (held.pnlUsd < 0 && downPct >= stop) {
      const reason = `Exit ${held.symbol}: down ${usd(-held.pnlUsd)}, ${downPct.toFixed(1)} % of the ${usd(held.legUsd)} leg, at your ${minimum(stop)} stop`;
      return out('exit', reason, held.windowId, { kind: 'exit', reason });
    }
  }
  if (finite(held.since) && heldHours >= LOOP_RULES.maxHoldDays * 24) {
    const reason = `Exit ${held.symbol}: held ${(heldHours / 24).toFixed(1)} days, the ${LOOP_RULES.maxHoldDays}-day time stop`;
    return out('exit', reason, held.windowId, { kind: 'exit', reason });
  }

  // Past the stops, nothing is decided on a number that is not one: no compression, no rotation, no "healthy".
  const unknown = heldUnknown(held, heldW !== null && !heldW.stale ? heldW : null, input);
  if (unknown !== null) {
    return out('wait', `Held pair numbers unknown: ${unknown}; nothing is decided on ${held.symbol}`, held.windowId, null, `held-unknown:${held.windowId}`);
  }
  const day = `day ${Math.floor(Math.max(0, heldHours) / 24) + 1} of ${LOOP_RULES.maxHoldDays}`;
  if (heldW === null) return out('hold', `Hold ${held.symbol}: its window is not in this scan, so nothing is decided on it; ${day}`, held.windowId);
  if (heldW.stale) return out('hold', `Hold ${held.symbol}: its numbers are stale this scan, so nothing is decided on them; ${day}`, held.windowId);

  // Rotation, against the held window measured from here.
  // Clamped both ways: a `since` in the future (clock skew) never gives more than the whole hold.
  const restHours = Math.min(LOOP_RULES.maxHoldDays * 24, Math.max(0, LOOP_RULES.maxHoldDays * 24 - heldHours));
  const heldApr = heldForwardAprPct(heldW);
  const rot = rotation(input, held, heldW, heldApr, counters, restHours);
  if (rot.kind === 'rotate') {
    const { w, size, gain, paybackHours } = rot;
    const n = counters.betterByWindow[w.id] ?? 0;
    const reason = `Rotate ${held.symbol} -> ${pair(w)}: ${pct(w.netAprPct)} net vs ${pct(heldApr)} held, +${gain.toFixed(1)} pts for `
      + `${n} of ${strategy.rotate.forHours} hours; the ${usd(w.switchCostUsd!)} switch pays back in ${(paybackHours / 24).toFixed(1)} of the `
      + `${(restHours / 24).toFixed(1)} days left; ${usd(size.legUsd)} a leg at ${lev(size.leverage)}`;
    return out('rotate', reason, w.id, {
      kind: 'rotate', fromId: held.windowId, toId: w.id, legUsd: size.legUsd, leverage: size.leverage, qty: size.qty,
    });
  }

  // Counted exit.
  const trouble = heldTrouble(heldW, input);
  if (trouble !== null && counters.badChecks >= LOOP_RULES.exitAfterChecks) {
    const reason = `Exit ${held.symbol}: ${trouble}, ${counters.badChecks} of ${hours(LOOP_RULES.exitAfterChecks)} in a row`;
    return out('exit', reason, held.windowId, { kind: 'exit', reason });
  }
  const status = trouble === null
    ? `${pct(heldApr)} net of the exit, at least your ${minimum(strategy.minNetAprPct)} minimum`
    : `${trouble}, ${counters.badChecks} of ${hours(LOOP_RULES.exitAfterChecks)} before exit`;
  return out('hold', `Hold ${held.symbol}: ${status}; ${day}${rot.note === null ? '' : `; ${rot.note}`}`, held.windowId);
}

type Rotation =
  | { kind: 'rotate'; w: FundingWindow; size: { legUsd: number; leverage: number; qty: string }; gain: number; paybackHours: number }
  | { kind: 'none'; note: string | null };

/** The rotation to make now, or a note on the closest challenger for the hold line. */
function rotation(input: DecideInput, held: HeldPair, heldW: FundingWindow, heldAprPct: number, counters: LoopCounters, restHours: number): Rotation {
  const { strategy } = input;
  const { minGainPts, forHours } = strategy.rotate;
  if (!finite(minGainPts) || !finite(forHours)) return { kind: 'none', note: 'your rotation rule is not a number: no rotation' };
  const heldVenues = new Set([heldW.longVenue, heldW.shortVenue]);
  const same = (w: FundingWindow) => heldVenues.has(w.longVenue) && heldVenues.has(w.shortVenue);
  const gated = { ...input, counters };
  const challengers = input.windows
    .filter((w) => w.id !== held.windowId && (counters.betterByWindow[w.id] ?? 0) > 0 && gate(w, gated) === null)
    .map((w) => ({ w, gain: w.netAprPct - heldAprPct }))
    .filter((c) => c.gain >= minGainPts)
    // Windows on the venues that already hold the margin first, then in the scanner's rank (a stable sort).
    .sort((a, b) => Number(same(b.w)) - Number(same(a.w)));
  if (challengers.length === 0) return { kind: 'none', note: null };
  const recent = counters.rotationsAt.length;
  const blocked: string[] = [];
  for (const { w, gain } of challengers) {
    const n = counters.betterByWindow[w.id] ?? 0;
    if (n < forHours) {
      blocked.push(`${w.symbol} beats it by ${gain.toFixed(1)} pts, ${n} of ${forHours} hours`);
      continue;
    }
    if (recent >= LOOP_RULES.maxRotationsPerDay) {
      blocked.push(`${w.symbol} beats it by ${gain.toFixed(1)} pts, but ${recent} rotations in 24 h is the most`);
      continue;
    }
    if (w.switchCostUsd === null || !finite(w.switchCostUsd) || w.switchCostUsd < 0) {
      blocked.push(`${w.symbol} beats it by ${gain.toFixed(1)} pts, but its switch cost is not known`);
      continue;
    }
    // The first window the rules allow is sized first: if it cannot be, nothing rotates this check. The closed legs
    // free only the margin loop.ts measured (none when it did not say).
    const size = sizeFor(w, input, input.freedMarginUsd ?? {});
    if (!size.ok) return { kind: 'none', note: `${w.symbol} beats it by ${gain.toFixed(1)} pts, but ${size.why}` };
    // The gain is earned on the leg actually opened; the switch cost stays what it is (its transfers are flat).
    const gainUsdPerHour = (gain / 100) * size.legUsd / HOURS_PER_YEAR;
    const paybackHours = w.switchCostUsd / gainUsdPerHour;
    if (!(paybackHours <= restHours)) {
      blocked.push(`${w.symbol} beats it by ${gain.toFixed(1)} pts, but the ${usd(w.switchCostUsd)} switch takes ${(paybackHours / 24).toFixed(1)} days to pay back, `
        + `${(restHours / 24).toFixed(1)} are left`);
      continue;
    }
    return { kind: 'rotate', w, size, gain, paybackHours };
  }
  return { kind: 'none', note: blocked[0] ?? null };
}

interface FlatStatus {
  line: string;          // what the top window is doing, for the wait and off lines
  key: string;           // the same, without numbers that move every scan: the wait journal key
  windowId: string | null;   // the window waited for: the top one passing the entry rules
  top: FundingWindow | null;
}

/** The top window's standing against the entry rules, and any window ranked above it that NEAR AI vetoed. */
function flatStatus(input: DecideInput, counters: LoopCounters): FlatStatus {
  const min = input.strategy.minNetAprPct;
  const gated = { ...input, counters };
  // The scanner's rank decides which window is top: never this module's own order, never a model.
  const topIndex = input.windows.findIndex((w) => gate(w, gated) === null);
  const top = topIndex < 0 ? null : input.windows[topIndex]!;
  const above = topIndex < 0 ? input.windows : input.windows.slice(0, topIndex);
  const vetoed = above.find((w) => vetoHoursLeft(counters, w.id, input.now) !== null);
  const vetoNote = vetoed === undefined
    ? { line: '', key: '' }
    : { line: `; ${vetoed.symbol} refused by the NEAR AI risk check${vetoWhyText(counters, vetoed.id)}, held out for ${vetoHoursLeft(counters, vetoed.id, input.now)!.toFixed(1)} h more`, key: `:veto:${vetoed.id}` };
  if (top !== null) {
    const n = Math.min(counters.aboveByWindow[top.id] ?? 0, LOOP_RULES.enterAfterChecks);
    return {
      line: `${top.symbol} ${pct(top.netAprPct)} net, ${n} of ${LOOP_RULES.enterAfterChecks} hours above ${minimum(min)}${vetoNote.line}`,
      key: `warming:${top.id}:${n}${vetoNote.key}`,
      windowId: top.id,
      top,
    };
  }
  const first = input.windows.find((w) => w.tradable);
  if (first === undefined) return { line: 'no desk window in this scan', key: 'none', windowId: null, top: null };
  const g = gate(first, gated)!;
  return {
    line: `no window clears the entry rules; best ${first.symbol} ${finite(first.netAprPct) ? pct(first.netAprPct) : String(first.netAprPct)} net: ${g.text}`
      + (vetoed === first ? '' : vetoNote.line),
    key: `blocked:${first.id}:${g.code}${vetoed === first ? '' : vetoNote.key}`,
    windowId: null,
    top: null,
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
  // The top of the scanner's ranked list among the windows the rules allow: that one or none. Until it has its
  // hours, or when it cannot be sized, the desk waits on it; a lower window is never entered in its place.
  const w = status.top;
  if (w === null || (counters.aboveByWindow[w.id] ?? 0) < LOOP_RULES.enterAfterChecks) {
    return out('wait', capitalize(status.line), status.windowId, null, status.key);
  }
  const size = sizeFor(w, input);
  if (!size.ok) return out('wait', `${w.symbol} ${pct(w.netAprPct)} net is ready, but ${size.why}`, w.id, null, `size:${w.id}:${size.code}`);
  const n = counters.aboveByWindow[w.id] ?? 0;
  const reason = `Enter ${pair(w)}: ${pct(w.netAprPct)} net, ${Math.min(n, LOOP_RULES.enterAfterChecks)} of ${LOOP_RULES.enterAfterChecks} hours above `
    + `${minimum(input.strategy.minNetAprPct)}, 7-day ${pct(w.grossApr7dPct!)} and this hour ${pct(w.grossAprPct)}; ${usd(size.legUsd)} a leg at ${lev(size.leverage)}`;
  return out('enter', reason, w.id, { kind: 'enter', windowId: w.id, legUsd: size.legUsd, leverage: size.leverage, qty: size.qty });
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
 * With `{ vetoed: true }` (NEAR AI risk check refused the enter or rotate target) that window is held out for
 * LOOP_RULES.vetoHoldHours and its counts start again, so the veto is not asked again on the next scan; `why` (the
 * risk check's why line) is kept with the hold-out and shown on the waits while it lasts.
 */
export function skipAct(input: DecideInput, d: Decision, options: { vetoed?: boolean; why?: string } = {}): LoopCounters {
  if (d.act === null) return d.counters;
  const held = input.held;
  const heldW = held === null ? null : (input.windows.find((w) => w.id === held.windowId) ?? null);
  const counted: LoopCounters = { ...count(input, countsAsHourly(input), heldW), lastWaitReason: d.counters.lastWaitReason };
  const target = d.vetoCandidate;
  if (options.vetoed !== true || target === null) return counted;
  const { [target]: _above, ...aboveByWindow } = counted.aboveByWindow;
  const { [target]: _better, ...betterByWindow } = counted.betterByWindow;
  return {
    ...counted, aboveByWindow, betterByWindow,
    vetoedUntil: { ...counted.vetoedUntil, [target]: input.now + LOOP_RULES.vetoHoldHours * HOUR_MS },
    ...(options.why === undefined ? {} : { vetoWhy: { ...counted.vetoWhy, [target]: options.why } }),
  };
}

/** Whether loop.ts journals this decision as a `wait`: only when its reason changed since the last check. */
export function journalWait(previous: LoopCounters, d: Decision): boolean {
  return d.decision.action === 'wait' && d.counters.lastWaitReason !== previous.lastWaitReason;
}
