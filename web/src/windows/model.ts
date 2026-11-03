// What the Windows list shows and in which order. Pure functions over the shared `Window` type, so the
// rules in design/HANDOFF.md (Windows) are tested without a browser.
import type { ScanStatus, Window as FundingWindow } from '@gimbal/shared';
import { capital, list, sentence, venueName } from './format.ts';

export type Tab = 'tradable' | 'watch';

/** The venues a desk can trade (`VenueId` in shared); every other scanned venue is watch-only. */
export const TRADABLE_VENUES: readonly string[] = ['hyperliquid', 'phoenix', 'orderly'];

export const tabOf = (w: FundingWindow): Tab => (w.tradable ? 'tradable' : 'watch');

/** Tradable windows rank by net APR; watch-only ones have no net, so they rank by gross. */
const rankOf = (w: FundingWindow): number => (w.tradable ? w.netAprPct : w.grossAprPct);

export function sortWindows(windows: readonly FundingWindow[]): FundingWindow[] {
  // Ties fall back to the symbol and id so two equal rows never swap places between updates.
  return [...windows].sort((a, b) => rankOf(b) - rankOf(a) || a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
}

export const inTab = (windows: readonly FundingWindow[], tab: Tab): FundingWindow[] =>
  windows.filter((w) => tabOf(w) === tab);

/**
 * A window the desk could open now, as the engine judges it (engine/src/scanner/price.ts, isEnterable): tradable, not
 * refused by the contract, numbers from this scan, every engine check passed (the carry gate and the open-interest
 * share among them), and not refused by the NEAR AI risk check.
 */
export const isEnterable = (w: FundingWindow): boolean =>
  w.tradable && !w.refused && !w.stale && w.checks.every((c) => c.ok) && w.veto?.verdict !== 'veto';

/** The engine's refusal of every desk window while no desk (no policy) is loaded (docs/interfaces.md §2, `Window.refused`). */
export const NO_DESK = 'E_NO_DESK';

/** Refused only because there is no desk to trade it with: nothing is wrong with the window itself. */
export const isNoDesk = (w: FundingWindow): boolean => w.refused?.code === NO_DESK;

/**
 * No desk is loaded: the engine says so on its windows, since `DeskState` stays null both before a desk exists and
 * while the first one is still being read. Null windows (nothing scanned yet) say nothing.
 */
export const deskMissing = (windows: readonly FundingWindow[] | null): boolean => windows?.some(isNoDesk) ?? false;

/** Under the owner's minimum: shown below the rule at 40% opacity. Watch-only rows have no net to compare. */
export const isBelow = (w: FundingWindow, minimum: number | null): boolean =>
  w.tradable && minimum !== null && w.netAprPct < minimum;

export type StatusKind = 'held' | 'refused' | 'nodesk' | 'veto' | 'watch' | 'none';

export interface RowStatus {
  kind: StatusKind;
  /** The word on the row: `Held`, `Refused · no trusted price`, `Risk check · one-off spike`, `Watch-only` */
  text: string;
  /** The same for a phone row, where there is less room: a refusal is named by its code (`Refused · no price`). */
  compact: string;
}

/** Short names for the contract's refusal codes (docs/interfaces.md §1.5) that can apply to a window. */
const REFUSAL_SHORT: Readonly<Record<string, string>> = {
  E_ORACLE_STALE: 'no price',
  E_ASSET: 'not in policy',
  E_SIZE: 'size',
  E_PRICE_BAND: 'price band',
  E_RESCUE_CAP: 'rescue cap',
  E_PAUSED: 'paused',
};

const firstReason = (reasons: readonly string[]): string => reasons[0]?.trim() ?? '';
const withReason = (word: string, reason: string): string => (reason ? `${word} · ${reason}` : word);

// Held wins: the desk is in it. Then the contract's refusal (a hard stop), then the NEAR AI risk check.
export function rowStatus(w: FundingWindow): RowStatus {
  const plainStatus = (kind: StatusKind, text: string): RowStatus => ({ kind, text, compact: text });
  if (w.held) return plainStatus('held', 'Held');
  // Every desk window carries this one while no desk exists: a calm word, because the list explains it once above.
  if (isNoDesk(w)) return { kind: 'nodesk', text: 'No desk yet', compact: 'No desk' };
  if (w.refused) {
    const text = withReason('Refused', w.refused.reason.trim());
    const short = REFUSAL_SHORT[w.refused.code];
    return { kind: 'refused', text, compact: short ? `Refused · ${short}` : text };
  }
  if (w.veto?.verdict === 'veto') return plainStatus('veto', withReason('Risk check', firstReason(w.veto.reasons)));
  if (!w.tradable) return plainStatus('watch', 'Watch-only');
  return plainStatus('none', '');
}

export interface Arrangement {
  /** The rows in the order they are drawn. */
  rows: FundingWindow[];
  /** The "Your minimum" rule is drawn before `rows[ruleAt]`; `null` when there is no rule on this tab. */
  ruleAt: number | null;
}

export interface Pin {
  /** The selected row, which the pointer is over. */
  id: string;
  /** The place it has now in the drawn rows. */
  slot: number;
}

/**
 * The rows of one tab, sorted, split at the minimum. With a `pin` the selected row keeps its place while
 * the others re-sort around it, so it never moves out from under the pointer. It still stays on its side
 * of the rule: a row that falls under the minimum is shown there, next to the rule.
 */
export function arrange(
  windows: readonly FundingWindow[],
  tab: Tab,
  minimum: number | null,
  pin: Pin | null = null,
): Arrangement {
  const sorted = sortWindows(inTab(windows, tab));
  let above = sorted.filter((w) => !isBelow(w, minimum));
  let below = sorted.filter((w) => isBelow(w, minimum));

  const pinned = pin ? sorted.find((w) => w.id === pin.id) : undefined;
  if (pin && pinned) {
    above = above.filter((w) => w !== pinned);
    below = below.filter((w) => w !== pinned);
    const under = isBelow(pinned, minimum);
    const side = under ? below : above;
    const at = clamp(pin.slot - (under ? above.length : 0), 0, side.length);
    side.splice(at, 0, pinned);
  }

  return {
    rows: [...above, ...below],
    ruleAt: tab === 'tradable' && minimum !== null && sorted.length > 0 ? above.length : null,
  };
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * The window auto would open first, or null: the first enterable one in the engine's order. The engine ranks desk
 * windows by the carry it expects over the hold, net of the round trip, which the web cannot recompute from a Window,
 * so the list is not re-sorted here.
 */
export function bestEnterable(windows: readonly FundingWindow[]): FundingWindow | null {
  return windows.find(isEnterable) ?? null;
}

/**
 * Nothing to enter: no window that is open to the desk clears the minimum, and nothing is held.
 * Windows refused by the contract or the risk check do not count, however high they are.
 */
export function isEmpty(windows: readonly FundingWindow[], minimum: number | null): boolean {
  if (minimum === null) return false;
  // With no desk nothing can be entered, so "nothing clears your minimum" would be the wrong reason: show the list.
  if (deskMissing(windows)) return false;
  if (windows.some((w) => w.held)) return false;
  return !windows.some((w) => isEnterable(w) && w.netAprPct >= minimum);
}

export const heldWindow = (windows: readonly FundingWindow[]): FundingWindow | null =>
  windows.find((w) => w.held) ?? null;

/** Which row is selected: the one asked for if it is still listed, else the held one, else the first. */
export function pickSelection(rows: readonly FundingWindow[], wanted: string | null): string | null {
  if (wanted !== null && rows.some((w) => w.id === wanted)) return wanted;
  return (rows.find((w) => w.held) ?? rows[0])?.id ?? null;
}

/** ↑ and ↓: the neighbour of the selected row, stopping at both ends. */
export function stepSelection(rows: readonly FundingWindow[], selected: string | null, delta: -1 | 1): string | null {
  if (rows.length === 0) return null;
  const at = rows.findIndex((w) => w.id === selected);
  if (at === -1) return rows[delta === 1 ? 0 : rows.length - 1]?.id ?? null;
  return rows[clamp(at + delta, 0, rows.length - 1)]?.id ?? null;
}

/** Venues of a window the desk cannot trade, by display name. */
export function untradableVenues(w: FundingWindow): string[] {
  const names = [w.longVenue, w.shortVenue].filter((v, i, all) => all.indexOf(v) === i);
  return names.filter((v) => !TRADABLE_VENUES.includes(v.toLowerCase())).map(venueName);
}

/** "Watch-only 29 venues": the scanner reads 32 venues and the desk trades on three of them. */
export function watchOnlyVenues(scan: ScanStatus | null): number | null {
  return scan ? Math.max(0, scan.venues - TRADABLE_VENUES.length) : null;
}

export interface FailedScan {
  /** `3 of 32 venues didn't answer` */
  headline: string;
  /** Display names of the venues that did not answer. */
  venues: string[];
  /** The oldest read the stale rows still use, ms. */
  since: number;
}

/** The amber line under the list header, or null when every venue answered. */
export function failedScan(scan: ScanStatus | null, windows: readonly FundingWindow[]): FailedScan | null {
  if (!scan || scan.failed.length === 0) return null;
  const n = scan.failed.length;
  const stale = windows.filter((w) => w.stale).map((w) => w.updatedAt);
  return {
    headline: `${n} of ${scan.venues} venues didn’t answer`,
    venues: scan.failed.map(venueName),
    since: stale.length > 0 ? Math.min(...stale) : scan.at,
  };
}

export const venuePair = (w: FundingWindow): string => `${venueName(w.longVenue)} / ${venueName(w.shortVenue)}`;

/** All costs together, in APR points: the "−4.1 costs" on a row. */
export const totalCosts = (w: FundingWindow): number =>
  w.costs.feesPct + w.costs.slippagePct + w.costs.basisPct + w.costs.rescueReservePct;

/** `Phoenix and Lighter` */
export const venueNames = (ids: readonly string[]): string => list(ids.map(venueName));

export interface CheckLine {
  ok: boolean;
  text: string;
  /** The first failing line: why the window is not entered. */
  blocking: boolean;
}

/**
 * The lines under "Checks": NEAR AI's verdict, the contract's refusal if there is one, then what the engine
 * checked (`Window.checks`). The first failing line is marked as the reason the window is not entered.
 */
export function checkLines(w: FundingWindow): CheckLine[] {
  const lines: Omit<CheckLine, 'blocking'>[] = [];
  if (w.veto) {
    const said = w.veto.reasons.map((r) => sentence(capital(r))).join(' ');
    lines.push(
      w.veto.verdict === 'veto'
        ? { ok: false, text: `The NEAR AI risk check refused it. ${said}`.trim() }
        : { ok: true, text: said ? `NEAR AI: ${said}` : 'NEAR AI passed it.' },
    );
  }
  // No desk is not the contract's verdict on this window; the engine's own check line already says it.
  if (isNoDesk(w)) {
    if (!w.checks.some((c) => !c.ok)) lines.push({ ok: false, text: 'There is no desk to trade it with yet, so nothing can be entered.' });
  } else if (w.refused) {
    lines.push({ ok: false, text: `The contract would refuse it (${w.refused.code}): ${capital(w.refused.reason)}` });
  }
  lines.push(...w.checks);
  const blocking = lines.findIndex((l) => !l.ok);
  return lines.map((l, i) => ({ ...l, blocking: i === blocking }));
}
