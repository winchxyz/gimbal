// The decision line under the detail stage: what the desk will do about the selected window, and why.
// Pure, so every wording is tested. It states what the types say: the owner's minimum, whether auto is on
// (`StrategyConfig.auto`), the rotation rule (`StrategyConfig.rotate`), the held window, `switchCostUsd` and the leg
// size. With no strategy read it gives the numbers and does not claim what auto will do.
import type { StrategyConfig, Window as FundingWindow } from '@gimbal/shared';
import { dayMonthTime, duration, list, pct, plain, sentence, usd } from './format.ts';
import { bestEnterable, isBelow, isEnterable, isNoDesk, untradableVenues } from './model.ts';

export interface Decision {
  text: string;
  /** Manual rotation from the held window into the selected one, with its cost. */
  rotate: { from: FundingWindow; to: FundingWindow; costUsd: number | null } | null;
  /** "Alert me if it passes DOGE": offered when the selected window is below the held one. */
  alert: { over: FundingWindow } | null;
  /** The selected window is the held one: "Held since … · Close position". */
  close: boolean;
}

export interface DecisionInput {
  selected: FundingWindow;
  windows: readonly FundingWindow[];
  strategy: StrategyConfig | null;
  now: number;
}

const none = (text: string): Decision => ({ text, rotate: null, alert: null, close: false });

/** Why the engine would not open a window: its first failing check (the carry gate, the open-interest share, ...). */
function notEnterable(w: FundingWindow): string {
  const failing = w.checks.find((c) => !c.ok);
  if (failing) return sentence(failing.text);
  return w.stale ? 'its numbers are from an older read.' : 'it is not open to the desk.';
}

/** `3`, `2.5`: a whole number without its decimal. */
const count = (n: number): string => plain(n, Number.isInteger(n) ? 0 : 1);
const hoursText = (h: number): string => `${count(h)} ${h === 1 ? 'hour' : 'hours'}`;
const checksText = (n: number): string => `${count(n)} hourly ${n === 1 ? 'check' : 'checks'}`;

/** The rotation rule in the owner's words: "3 points of net APR for 4 hours in a row". */
const ruleText = (rotate: StrategyConfig['rotate']): string => `${count(rotate.minGainPts)} points of net APR for ${hoursText(rotate.forHours)} in a row`;

export function decide({ selected, windows, strategy, now }: DecisionInput): Decision {
  const held = windows.find((w) => w.held) ?? null;
  const minimum = strategy?.minNetAprPct ?? null;
  const auto = strategy?.auto ?? null; // null: the rules could not be read

  if (selected.held) {
    const since = `Held since ${dayMonthTime(selected.held.since)} UTC · ${duration(now - selected.held.since)}.`;
    const rule =
      strategy === null
        ? ''
        : strategy.auto
          ? ` Auto moves out of it when another window beats it by ${ruleText(strategy.rotate)}, and exits after ${checksText(strategy.exitAfterChecks)} in a row under your minimum or with the spread flipped.`
          : ' Auto is off, so the engine will not exit or rotate it by itself.';
    return { ...none(`${since}${rule}`), close: true };
  }

  if (!selected.tradable) {
    const venues = untradableVenues(selected);
    return none(
      venues.length > 0
        ? `Watch-only: the desk can’t trade on ${list(venues)}. It is shown so you can see where the funding is.`
        : 'Watch-only: the desk can’t trade this window. It is shown so you can see where the funding is.',
    );
  }

  if (isNoDesk(selected)) {
    return none('No desk is loaded, so nothing can be entered, by auto or by hand. It enters windows once a desk exists.');
  }

  if (selected.refused) {
    return none(`The contract would refuse this window under your policy: ${sentence(selected.refused.reason)} Auto will not enter it.`);
  }

  if (selected.veto?.verdict === 'veto') {
    const why = selected.veto.reasons[0];
    return none(
      `The NEAR AI risk check refused it${why ? `: ${sentence(why)}` : '.'} It can only remove a window, so auto will not enter it.`,
    );
  }

  if (held) return againstHeld(selected, held, strategy);

  if (minimum === null) return none('Nothing is held. Your minimum could not be read, so no entry is shown.');
  if (auto === false) {
    return none('Nothing is held. Auto is off, so the desk only watches and rescues; it enters nothing by itself.');
  }
  if (isBelow(selected, minimum)) {
    return none(`Nothing is held. ${selected.symbol} is under your ${plain(minimum, 0)}% minimum, so auto will not enter it.`);
  }
  if (!isEnterable(selected)) return none(`Nothing is held. Auto will not enter ${selected.symbol}: ${notEnterable(selected)}`);
  const best = bestEnterable(windows.filter((w) => !isBelow(w, minimum)));
  if (best && best.id !== selected.id) {
    return none(
      `Nothing is held. Auto enters ${best.symbol} first: ${pct(best.netAprPct)} against ${pct(selected.netAprPct)} here.`,
    );
  }
  const after = strategy === null ? '' : ` It enters once it has passed ${checksText(strategy.enterAfterChecks)} in a row.`;
  return none(`Nothing is held. Auto enters ${selected.symbol}: it is the best window that clears your ${plain(minimum, 0)}% minimum.${after}`);
}

function againstHeld(selected: FundingWindow, held: FundingWindow, strategy: StrategyConfig | null): Decision {
  const gap = selected.netAprPct - held.netAprPct;
  if (!isEnterable(selected)) {
    return {
      text: `${held.symbol} stays: auto will not enter ${selected.symbol}: ${notEnterable(selected)}`,
      rotate: null,
      alert: gap <= 0 ? { over: held } : null,
      close: false,
    };
  }
  const cost = selected.switchCostUsd;
  const costText = cost === null ? '' : ` Switching now costs about ${usd(cost)}.`;
  const rotate = isEnterable(selected) ? { from: held, to: selected, costUsd: cost } : null;
  const off = strategy?.auto === false;

  if (gap <= 0) {
    return {
      text: off
        ? `Auto is off, so ${held.symbol} stays until you act: ${selected.symbol} is ${plain(-gap)} points lower.${costText}`
        : `Auto keeps ${held.symbol}: ${selected.symbol} is ${plain(-gap)} points lower.${costText}`,
      rotate,
      alert: { over: held },
      close: false,
    };
  }

  // Higher than the held window: the numbers, how long the extra pay takes to earn the cost back, and the rule.
  const extraPerDay = strategy ? ((selected.usdPerDayPer1k - held.usdPerDayPer1k) * strategy.legUsd) / 1000 : null;
  const payback =
    cost !== null && extraPerDay !== null && extraPerDay > 0
      ? ` The extra ${usd(extraPerDay)} a day earns that back in ${paybackText(cost / extraPerDay)}.`
      : '';
  const rule =
    strategy === null
      ? ''
      : off
        ? ' Auto is off, so nothing rotates unless you do.'
        : gap >= strategy.rotate.minGainPts
          ? ` That clears auto’s rule of ${ruleText(strategy.rotate)}, so it rotates if the gap holds.`
          : ` That is under auto’s rule of ${ruleText(strategy.rotate)}, so it stays in ${held.symbol}.`;
  return {
    text: `${selected.symbol} is ${plain(gap)} points above ${held.symbol}.${costText}${payback}${rule}`,
    rotate,
    alert: null,
    close: false,
  };
}

function paybackText(days: number): string {
  if (days < 1) return 'under a day';
  const d = Math.round(days);
  return d === 1 ? 'a day' : `${d} days`;
}

/** "≈ $0.28 a day on $1,200 legs": the window's $/day per $1k at the strategy's leg size. */
export function perDayOnLegs(w: FundingWindow, legUsd: number): number {
  return (w.usdPerDayPer1k * legUsd) / 1000;
}
