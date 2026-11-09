// The sentence that opens the Desk (UX, Desk: "Earning 43 % a year on MON. Both legs are safe."), and the state colour
// of each figure on it. Pure, so the words and the colour rules are tested.
//
// Colour rules (brand book C, approved states): mint (--level) marks what is fine, amber (--watch) what needs watching,
// coral (--danger) a loss or a danger. Fees and other expected costs stay neutral. The colour sits on the number or
// word it is about, never on a fill, a background or a button.
import type { DeskState, Leg, StrategyConfig, Window as FundingWindow } from '@gimbal/shared';
import type { StatusView } from '../shell/status.ts';

/** The class that colours a figure: `up` mint, `watch-t` amber, `down` coral; null stays neutral. */
export type Tone = 'up' | 'watch-t' | 'down' | null;

/** `43%`, `4.5%`: a rate in a sentence, whole from 10 up, without its sign (the verb says which way). */
export const ratePct = (value: number): string => {
  const abs = Math.abs(value);
  return `${abs >= 10 ? abs.toFixed(0) : abs.toFixed(1)}%`;
};

/** A rate a year: mint while it earns, coral while it loses. */
export const rateTone = (netAprPct: number | null): Tone => (netAprPct === null || netAprPct === 0 ? null : netAprPct > 0 ? 'up' : 'down');

/** Money earned or lost (a day's net, a pair's P&L): mint when positive, coral when negative. Never for a fee. */
export const moneyTone = (usd: number | null, decimals = 2): Tone => {
  if (usd === null || Number(Math.abs(usd).toFixed(decimals)) === 0) return null;
  return usd > 0 ? 'up' : 'down';
};

/** A leg's distance to liquidation: mint above the watch line, amber down to the rescue line, coral under it. */
export function distanceTone(distance: number | null, risk: StrategyConfig['risk'] | null): Tone {
  if (distance === null || risk === null) return null;
  return distance > risk.watchDistancePct ? 'up' : distance > risk.rescueDistancePct ? 'watch-t' : 'down';
}

/** The second sentence: is the money safe. From the status line's state, in plain words. */
export function safetySentence(view: StatusView, legs: readonly Leg[]): string {
  switch (view.tone) {
    case 'level':
      return legs.length >= 2 ? 'Both legs are safe.' : 'The leg is safe.';
    case 'watch':
      return 'One leg needs watching.';
    case 'rescuing':
      return 'A rescue is moving margin now.';
    case 'needs':
      return 'A rescue could not finish and needs the owner.';
    case 'down':
      // `Hyperliquid not answering`: the desk holds, decides nothing on it and reads it again (brand book C, states).
      return downSentence(view.word);
    case 'paused':
      return 'Paused: nothing new opens.';
    case 'waiting':
      return view.sentence;
  }
}

/** `Hyperliquid is not answering; the desk holds and reads it again.` from the status word `Hyperliquid not answering`. */
export function downSentence(word: string): string {
  const who = word.replace(/ not answering$/, '');
  if (who === word) return `${word}; the legs stay open.`;
  const many = / and /.test(who);
  return `${who} ${many ? 'are' : 'is'} not answering; the desk holds and reads ${many ? 'them' : 'it'} again.`;
}

export interface DeskAnswer {
  /** `Earning`, `Losing`, `Holding`; null when no pair is held (the whole sentence is `rest`). */
  verb: 'Earning' | 'Losing' | 'Holding' | null;
  /** `43%`, coloured by `tone`; null when the held market is not known. */
  rate: string | null;
  tone: Tone;
  /** What follows the rate: ` a year on MON. Both legs are safe.` */
  rest: string;
}

/** The sentence, in parts, so the rate alone carries its colour. */
export function deskAnswer({ desk, held, view }: { desk: DeskState; held: FundingWindow | null; view: StatusView }): DeskAnswer {
  if (desk.legs.length === 0) return { verb: null, rate: null, tone: null, rest: view.sentence };
  const symbol = held?.symbol ?? desk.legs[0]!.symbol;
  const safety = safetySentence(view, desk.legs);
  if (held === null || held.netAprPct === 0) return { verb: 'Holding', rate: null, tone: null, rest: ` ${symbol}. ${safety}` };
  return {
    verb: held.netAprPct > 0 ? 'Earning' : 'Losing',
    rate: ratePct(held.netAprPct),
    tone: rateTone(held.netAprPct),
    rest: ` a year on ${symbol}. ${safety}`,
  };
}

/** The whole sentence as text (the page title, a test). */
export const answerText = (a: DeskAnswer): string => (a.verb === null ? a.rest : a.rate === null ? `${a.verb}${a.rest}` : `${a.verb} ${a.rate}${a.rest}`);
