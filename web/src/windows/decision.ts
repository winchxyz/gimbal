// The decision line on a pair's page: what the desk will do about this pair, and why.
// Pure, so every wording is tested. It states what the types say: the owner's minimum, whether auto is on
// (`StrategyConfig.auto`), the rotation rule (`StrategyConfig.rotate`), the held pair, `switchCostUsd` and the leg
// size, and, while the desk is flat, what the strategy loop itself last said (`StrategyDecision`): a cool-down after
// an exit, the hours a pair has counted, trading switched off. With no strategy read it gives the numbers and does
// not claim what auto will do.
import type { StrategyConfig, StrategyDecision, Window as FundingWindow } from '@gimbal/shared';
import { waitCopy } from '../ui/waitCopy.ts';
import { dayMonthTime, duration, list, pct, plain, sentence, usd } from './format.ts';
import { bestEnterable, isBelow, isEnterable, isNoDesk, untradableVenues } from './model.ts';

export interface Decision {
  text: string;
  /** Manual rotation from the held pair into the selected one, with its cost. */
  rotate: { from: FundingWindow; to: FundingWindow; costUsd: number | null } | null;
  /** "Alert me if it passes DOGE": offered when the selected pair is below the held one. */
  alert: { over: FundingWindow } | null;
  /** The selected pair is the held one: "Held since … · Close position". */
  close: boolean;
}

export interface DecisionInput {
  selected: FundingWindow;
  windows: readonly FundingWindow[];
  strategy: StrategyConfig | null;
  now: number;
  /** The strategy loop's latest decision, when the stream has one: it knows what the page cannot work out. */
  engine?: StrategyDecision | null;
}

const none = (text: string): Decision => ({ text, rotate: null, alert: null, close: false });

/** Why the engine would not open a pair: its first failing check (the carry gate, the open-interest share, ...). */
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

/** `1.8 h`, `40 min`: what is left of a cool-down. */
const leftText = (h: number): string => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${plain(h, 1)} h`);

/**
 * What the loop says while the desk is flat (engine/src/strategy/decide.ts: decideFlat): the hours left of the
 * cool-down after an exit, and the hourly checks the pair it waits for has passed.
 */
function waitingOn(engine: StrategyDecision | null | undefined, selected: FundingWindow): { coolHours: number | null; passed: number | null } {
  if (!engine || engine.action !== 'wait') return { coolHours: null, passed: null };
  const cool = engine.reason.match(/^Cooling down after the exit, (\d+(?:\.\d+)?) h left/);
  const hours = engine.windowId === selected.id ? engine.reason.match(/(\d+) of \d+ hours above/) : null;
  return { coolHours: cool ? Number(cool[1]) : null, passed: hours ? Number(hours[1]) : null };
}

export function decide({ selected, windows, strategy, now, engine = null }: DecisionInput): Decision {
  const held = windows.find((w) => w.held) ?? null;
  const minimum = strategy?.minNetAprPct ?? null;
  const auto = strategy?.auto ?? null; // null: the rules could not be read

  if (selected.held) {
    const since = `Held since ${dayMonthTime(selected.held.since)} UTC · ${duration(now - selected.held.since)}.`;
    const rule =
      strategy === null
        ? ''
        : strategy.auto
          ? ` Auto moves out of it when another pair beats it by ${ruleText(strategy.rotate)}, and exits after ${checksText(strategy.exitAfterChecks)} in a row under your minimum or with the spread flipped.`
          : ' Auto is off, so the engine will not exit or rotate it by itself.';
    return { ...none(`${since}${rule}`), close: true };
  }

  if (!selected.tradable) {
    const venues = untradableVenues(selected);
    return none(
      venues.length > 0
        ? `Watch-only: the desk can’t trade on ${list(venues)}. It is shown so you can see where the funding is.`
        : 'Watch-only: the desk can’t trade this pair. It is shown so you can see where the funding is.',
    );
  }

  if (isNoDesk(selected)) {
    return none('No desk is loaded, so nothing can be entered, by auto or by hand. Pairs open for entry once a desk exists.');
  }

  if (selected.refused) {
    return none(`The contract would refuse this pair under your policy: ${sentence(selected.refused.reason)} Auto will not enter it.`);
  }

  if (selected.veto?.verdict === 'veto') {
    const why = selected.veto.reasons[0];
    return none(
      `The NEAR AI risk check refused it${why ? `: ${sentence(why)}` : '.'} It can only take a pair off the list, so auto will not enter it.`,
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
  // The loop's own word when it is not trading at all (auto off in its rules, or trading not enabled on this engine).
  if (engine?.action === 'off') return none(`Nothing is held. ${waitCopy(engine.reason).text}`);
  const waiting = waitingOn(engine, selected);
  const cool = waiting.coolHours === null ? '' : ` The desk is cooling down after its last exit: ${leftText(waiting.coolHours)} left.`;
  const enters = waiting.coolHours === null ? 'Auto enters' : 'After that auto enters';
  const best = bestEnterable(windows.filter((w) => !isBelow(w, minimum)));
  if (best && best.id !== selected.id) {
    return none(
      `Nothing is held.${cool} ${enters} ${best.symbol} first: ${pct(best.netAprPct)} against ${pct(selected.netAprPct)} here.`,
    );
  }
  const need = strategy?.enterAfterChecks ?? null;
  const after = need === null
    ? ''
    : waiting.passed !== null && waiting.passed >= need
      ? ` It has passed its ${checksText(need)} in a row.`
      : ` It enters once it has passed ${checksText(need)} in a row${waiting.passed === null ? '' : `: ${waiting.passed} so far`}.`;
  return none(`Nothing is held.${cool} ${enters} ${selected.symbol}: it is the best pair that clears your ${plain(minimum, 0)}% minimum.${after}`);
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

  // Higher than the held pair: the numbers, how long the extra pay takes to earn the cost back, and the rule.
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

/** "≈ $0.28 a day on $1,200 legs": the pair's $/day per $1k at the strategy's leg size. */
export function perDayOnLegs(w: FundingWindow, legUsd: number): number {
  return (w.usdPerDayPer1k * legUsd) / 1000;
}
