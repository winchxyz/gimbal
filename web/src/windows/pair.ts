// One pair's page in words: the sentence on top, and the sentence that reads the two rates under the scale. Pure, so
// every wording is tested.
import type { Window as FundingWindow } from '@gimbal/shared';
import { ratePct, rateTone, type Tone } from '../desk/answer.ts';
import { rate, venueName } from './format.ts';
import { closedGroups, isOpenToDesk } from './markets.ts';
import { hasHistory, isNoDesk, plainNote } from './model.ts';
import type { LegView, PairRow } from './scanner.ts';

export interface PairAnswer {
  lead: string;
  /** The figure that carries the state colour; null when the sentence has none. */
  rate: string | null;
  tone: Tone;
  rest: string;
}

/** Held, no desk yet, or what keeps the desk out, as a sentence; empty for a pair open to the desk. */
export function statusSentence(w: FundingWindow): string {
  if (w.held) return '';
  if (isNoDesk(w)) return 'No desk exists yet, so nothing can be entered.';
  if (!w.tradable) return '';
  if (!isOpenToDesk(w)) {
    const reason = closedGroups([w])[0]?.reason;
    return reason ? `${reason}.` : '';
  }
  return w.note ? `${plainNote(w.note)}.` : '';
}

/** The sentence a pair's page opens with: what it pays, or what it shows and why that is not a net. */
export function pairAnswer(w: FundingWindow): PairAnswer {
  if (!w.tradable) {
    return { lead: `${w.symbol} shows a `, rate: rate(w.grossAprPct), tone: null, rest: ' spread this hour. The desk only watches it.' };
  }
  const status = statusSentence(w);
  const tail = status === '' ? '' : ` ${status}`;
  if (w.held) return { lead: `The desk holds ${w.symbol}: `, rate: ratePct(w.netAprPct), tone: rateTone(w.netAprPct), rest: ' a year after costs.' };
  if (!hasHistory(w)) {
    return { lead: `${w.symbol} shows `, rate: rate(w.netAprPct), tone: null, rest: ` a year after costs this hour. Its 7 days are still being read.${tail}` };
  }
  if (w.netAprPct < 0) return { lead: `${w.symbol} costs more than it pays: `, rate: rate(w.netAprPct), tone: 'down', rest: ` a year.${tail}` };
  return { lead: `${w.symbol} pays `, rate: ratePct(w.netAprPct), tone: rateTone(w.netAprPct), rest: ` a year after costs.${tail}` };
}

export const pairAnswerText = (a: PairAnswer): string => `${a.lead}${a.rate ?? ''}${a.rest}`;

/** `is paid 3.2%`, `pays 8.8%`, `pays nothing`: what a side does at its venue's rate. A long pays a positive rate, a short is paid it. */
function sideDoes(leg: LegView, long: boolean): string {
  const paid = long ? leg.aprPct < 0 : leg.aprPct > 0;
  const size = rate(Math.abs(leg.aprPct));
  if (Number(Math.abs(leg.aprPct).toFixed(1)) === 0) return 'pays nothing';
  return paid ? `is paid ${size}` : `pays ${size}`;
}

/**
 * The scale read aloud: what each side pays or is paid at this hour's rate, and what the two make together.
 * `At this hour's rate the long on Phoenix is paid 3.2% a year and the short on Hyperliquid is paid 31.8%: together 35.0%, before costs.`
 */
export function legsSentence(row: PairRow): string {
  const { long, short, w } = row;
  if (long === null || short === null) return `The spread between ${venueName(w.longVenue)} and ${venueName(w.shortVenue)} is ${rate(w.grossAprPct)} a year at this hour's rates.`;
  const together = w.grossAprPct < 0 ? `together the pair pays out ${rate(Math.abs(w.grossAprPct))}` : `together ${rate(w.grossAprPct)}`;
  return `At this hour’s rate the long on ${long.name} ${sideDoes(long, true)} a year and the short on ${short.name} ${sideDoes(short, false)}: ${together}, before costs.`;
}
