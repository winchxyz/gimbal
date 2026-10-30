// The decision line under the detail stage: what the desk will do about the selected window, and why.
// Pure, so every wording is tested. It states only what the types say: the owner's minimum, the held window,
// `switchCostUsd` and the leg size. The engine's rotation rule is not in `StrategyConfig`, so when another
// window is above the held one the line gives the numbers and does not claim what auto will do.
import type { StrategyConfig, Window as FundingWindow } from '@gimbal/shared';
import { dayMonthTime, duration, list, pct, plain, sentence, usd } from './format.ts';
import { bestEnterable, isBelow, isEnterable, untradableVenues } from './model.ts';

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

export function decide({ selected, windows, strategy, now }: DecisionInput): Decision {
  const held = windows.find((w) => w.held) ?? null;
  const minimum = strategy?.minNetAprPct ?? null;

  if (selected.held) {
    return {
      ...none(`Held since ${dayMonthTime(selected.held.since)} UTC · ${duration(now - selected.held.since)}.`),
      close: true,
    };
  }

  if (!selected.tradable) {
    const venues = untradableVenues(selected);
    return none(
      venues.length > 0
        ? `Watch-only: the desk can’t trade on ${list(venues)}. It is shown so you can see where the funding is.`
        : 'Watch-only: the desk can’t trade this window. It is shown so you can see where the funding is.',
    );
  }

  if (selected.refused) {
    return none(`The contract would refuse this window under your policy: ${sentence(selected.refused.reason)} Auto will not enter it.`);
  }

  if (selected.veto?.verdict === 'veto') {
    const why = selected.veto.reasons[0];
    return none(
      `NEAR AI vetoed it${why ? `: ${sentence(why)}` : '.'} A veto only removes a window, so auto will not enter it.`,
    );
  }

  if (held) return againstHeld(selected, held, strategy);

  if (minimum === null) return none('Nothing is held. Your minimum could not be read, so no entry is shown.');
  if (isBelow(selected, minimum)) {
    return none(`Nothing is held. ${selected.symbol} is under your ${plain(minimum, 0)}% minimum, so auto will not enter it.`);
  }
  const best = bestEnterable(windows.filter((w) => !isBelow(w, minimum)));
  if (best && best.id !== selected.id) {
    return none(
      `Nothing is held. Auto enters ${best.symbol} first: ${pct(best.netAprPct)} against ${pct(selected.netAprPct)} here.`,
    );
  }
  return none(`Nothing is held. Auto enters ${selected.symbol}: it is the best window that clears your ${plain(minimum, 0)}% minimum.`);
}

function againstHeld(selected: FundingWindow, held: FundingWindow, strategy: StrategyConfig | null): Decision {
  const gap = selected.netAprPct - held.netAprPct;
  const cost = selected.switchCostUsd;
  const costText = cost === null ? '' : ` Switching now costs about ${usd(cost)}.`;
  const rotate = isEnterable(selected) ? { from: held, to: selected, costUsd: cost } : null;

  if (gap <= 0) {
    return {
      text: `Auto keeps ${held.symbol}: ${selected.symbol} is ${plain(-gap)} points lower.${costText}`,
      rotate,
      alert: { over: held },
      close: false,
    };
  }

  // Higher than the held window: the numbers, and how long the extra pay takes to earn the cost back.
  const extraPerDay = strategy ? ((selected.usdPerDayPer1k - held.usdPerDayPer1k) * strategy.legUsd) / 1000 : null;
  const payback =
    cost !== null && extraPerDay !== null && extraPerDay > 0
      ? ` The extra ${usd(extraPerDay)} a day earns that back in ${paybackText(cost / extraPerDay)}.`
      : '';
  return {
    text: `${selected.symbol} is ${plain(gap)} points above ${held.symbol}.${costText}${payback}`,
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
