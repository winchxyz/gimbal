// Markets (UX, Markets): only what the desk may trade right now, best net first; everything else in one collapsed
// section with a plain reason each; one sentence on top. Pure, so the grouping and the words are tested.
import type { Window as FundingWindow } from '@gimbal/shared';
import { ratePct, rateTone, type Tone } from '../desk/answer.ts';
import { venueName } from './format.ts';
import { hasHistory, isNoDesk, sortWindows } from './model.ts';

/**
 * Open to the desk: on venues it trades, not refused by the contract and not held back by the NEAR AI risk check. A
 * window refused only because no desk exists yet stays in the list (its numbers are real). A window whose numbers
 * are from an earlier scan stays too: the list never says "stale", the next scan reads it again. The held window always
 * stays, whatever the contract or the risk check says of a new entry into it: its detail and Close must be reachable.
 */
export const isOpenToDesk = (w: FundingWindow): boolean =>
  w.held !== null || (w.tradable && (!w.refused || isNoDesk(w)) && w.veto?.verdict !== 'veto');

/** The plain reason a window is not open to the desk, by the contract's refusal code where there is one. */
const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  E_ASSET: 'Not allowed by your policy',
  E_ORACLE_STALE: 'No trusted price right now',
  E_SIZE: 'Above the leg size your policy allows',
  E_PRICE_BAND: 'Price outside the band your policy allows',
  E_RESCUE_CAP: 'Above the rescue cap in your policy',
  E_PAUSED: 'The desk is paused',
};

export type ClosedKey = string;

export interface ClosedGroup {
  key: ClosedKey;
  /** `Not allowed by your policy` */
  reason: string;
  windows: FundingWindow[];
}

const reasonOf = (w: FundingWindow): { key: ClosedKey; reason: string } => {
  if (!w.tradable) return { key: 'watch', reason: 'Watch-only: venues the desk cannot trade' };
  if (w.refused && !isNoDesk(w)) {
    const words = REFUSAL_WORDS[w.refused.code];
    return words ? { key: w.refused.code, reason: words } : { key: 'refused', reason: 'Refused by the contract' };
  }
  return { key: 'risk', reason: 'Held back by the NEAR AI risk check' };
};

/** Group order: the owner's own rules first, then the risk check, then the venues the desk cannot trade. */
const ORDER = ['E_ASSET', 'E_SIZE', 'E_PRICE_BAND', 'E_RESCUE_CAP', 'E_ORACLE_STALE', 'E_PAUSED', 'refused', 'risk', 'watch'];

/** The windows not open to the desk, grouped by their plain reason; each group best first (net, or gross for watch-only). */
export function closedGroups(windows: readonly FundingWindow[]): ClosedGroup[] {
  const groups = new Map<ClosedKey, ClosedGroup>();
  for (const w of sortWindows(windows.filter((x) => !isOpenToDesk(x)))) {
    const { key, reason } = reasonOf(w);
    const group = groups.get(key) ?? { key, reason, windows: [] };
    group.windows.push(w);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
}

/** `MON, ETH, XRP and 12 more` */
export function coinsText(windows: readonly FundingWindow[], shown = 6): string {
  const coins = [...new Set(windows.map((w) => w.symbol))];
  if (coins.length <= shown) return coins.length <= 1 ? (coins[0] ?? '') : `${coins.slice(0, -1).join(', ')} and ${coins[coins.length - 1]}`;
  return `${coins.slice(0, shown).join(', ')} and ${coins.length - shown} more`;
}

export interface MarketsAnswer {
  lead: string;
  rate: string | null;
  tone: Tone;
  rest: string;
}

/**
 * The sentence on top: the best market open to the desk and what it pays a year after costs, or why none is.
 * Only a window with a 7-day spread counts: without one the engine never enters it.
 */
export function marketsAnswer(windows: readonly FundingWindow[], minimum: number | null): MarketsAnswer {
  const open = sortWindows(windows.filter((w) => isOpenToDesk(w) && hasHistory(w)));
  const top = open[0];
  if (!top) {
    // Open, but too new to judge: the engine has not read its 7 days yet (a fresh listing, or the minutes after a restart).
    const fresh = windows.filter((w) => isOpenToDesk(w) && w.tradable).length;
    if (fresh > 0) {
      return { lead: `${fresh === 1 ? 'One market is' : `${fresh} markets are`} open to the desk, but ${fresh === 1 ? 'its' : 'their'} 7 days of funding are not read yet.`, rate: null, tone: null, rest: '' };
    }
    return { lead: 'No market is open to the desk right now.', rate: null, tone: null, rest: '' };
  }
  if (minimum !== null && top.netAprPct < minimum) {
    return { lead: `None pays your ${Number.isInteger(minimum) ? `${minimum}%` : ratePct(minimum)} minimum. The best, ${top.symbol}, pays `, rate: ratePct(top.netAprPct), tone: rateTone(top.netAprPct), rest: ' a year.' };
  }
  if (top.netAprPct < 0) return { lead: `Every market costs more than it pays; ${top.symbol} loses least, `, rate: ratePct(top.netAprPct), tone: 'down', rest: ' a year.' };
  // A pair held (brand book C, Markets): the sentence is about what comes next to it.
  const held = windows.find((w) => w.held !== null) ?? null;
  if (held !== null) {
    if (top.id === held.id) {
      const next = open[1];
      if (!next || (minimum !== null && next.netAprPct < minimum)) {
        return { lead: `${held.symbol}, held, pays the most: `, rate: ratePct(top.netAprPct), tone: rateTone(top.netAprPct), rest: ' a year after costs.' };
      }
      return { lead: `Next best is ${nameBeside(next, held)} at `, rate: ratePct(next.netAprPct), tone: rateTone(next.netAprPct), rest: ` a year. ${held.symbol}, held, still leads.` };
    }
    return {
      lead: `${nameBeside(top, held)} pays the most: `,
      rate: ratePct(top.netAprPct),
      tone: rateTone(top.netAprPct),
      rest: ` a year after costs. ${held.symbol}, held, pays ${ratePct(held.netAprPct)}.`,
    };
  }
  return { lead: `${top.symbol} pays the most: `, rate: ratePct(top.netAprPct), tone: rateTone(top.netAprPct), rest: ' a year after costs.' };
}

/** A market's name in a sentence beside the held one: its venues too when the coin is the same. */
const nameBeside = (w: FundingWindow, held: FundingWindow): string =>
  w.symbol === held.symbol ? `${w.symbol} on ${venueName(w.longVenue)} and ${venueName(w.shortVenue)}` : w.symbol;

/**
 * The funding a market's net was worked out on, so funding, costs and net add up: the net plus today's costs. For a
 * desk window with its 7 days in that is the engine's multi-day basis, not this hour's or the plain 7-day gross.
 */
export function nettedFunding(w: FundingWindow): { pct: number; multiDay: boolean } {
  const c = w.costs;
  return { pct: w.netAprPct + c.feesPct + c.slippagePct + c.basisPct + c.rescueReservePct, multiDay: w.tradable && w.grossApr7dPct !== null };
}

export const marketsText = (a: MarketsAnswer): string => `${a.lead}${a.rate ?? ''}${a.rest}`;

/** `7 of 7 checks passed` */
export function checksSummary(lines: readonly { ok: boolean; text?: string }[]): string {
  const passed = lines.filter((l) => l.ok).length;
  if (lines.length === 0) return 'Not checked yet';
  const head = `${passed} of ${lines.length} ${lines.length === 1 ? 'check' : 'checks'} passed`;
  // Every check that did not pass is the history still being read: say so, it is a wait, not a refusal.
  const failed = lines.filter((l) => !l.ok);
  if (failed.length > 0 && failed.every((l) => /history loading/i.test(l.text ?? ''))) {
    return `${head} · ${failed.length === 1 ? 'one waits' : `${failed.length} wait`} for history`;
  }
  return head;
}
