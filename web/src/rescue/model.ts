// What the Rescue screen says, worked out from `RescueProgress` and the desk (design/HANDOFF.md, Rescue). Pure, so the
// step mapping, the timer and the Stress rule are tested without a browser.
//
// What the stream gives: one `RescueProgress` per change (the step it is on, the seconds so far, the transactions so
// far) and, for a failure, `DeskState.rescueFailure` (which step, why, how many tries, what happens next). It gives no
// time per step, so the page notes the seconds at which it saw each step begin (`observe`).
import type { DeskState, JournalEntry, Leg, Mode, RescueFailure, RescueProgress, TxRef, VenueId } from '@gimbal/shared';
import { numberOf, proofLinks, type ProofLink } from '../journal/entry.ts';
import { VENUE_NAMES } from '../shell/status.ts';
import type { ActionResult } from '../stream/api.ts';
import { reasonText } from '../windows/manual.ts';
import { dayMonth, usd } from '../windows/format.ts';

// ---------- the seven steps ----------

export const STEPS = ['detect', 'source', 'quote', 'verify', 'sign', 'deposit', 'landed'] as const;
export type StepId = (typeof STEPS)[number];
export type StepState = 'done' | 'now' | 'todo' | 'fail';

export const STEP_TITLES: Record<StepId, string> = {
  detect: 'Detect',
  source: 'Source',
  quote: 'Quote',
  verify: 'Verify',
  sign: 'Sign',
  deposit: 'Deposit',
  landed: 'Landed',
};

export const isRunning = (p: Pick<RescueProgress, 'step'>): boolean => p.step !== 'landed' && p.step !== 'failed';

/**
 * The state of each step. A running rescue has the steps before its own done, its own now, the rest to do. A landed
 * one has all seven done. A failed one has the steps before the failed step done, that one failed and the rest not
 * started; when the failed step is unknown nothing is claimed, so every step stays to do.
 */
export function stepStates(step: RescueProgress['step'], failedAt: StepId | null): Record<StepId, StepState> {
  const out = {} as Record<StepId, StepState>;
  const at = step === 'landed' ? STEPS.length : step === 'failed' ? (failedAt === null ? -1 : STEPS.indexOf(failedAt)) : STEPS.indexOf(step);
  STEPS.forEach((id, i) => {
    out[id] = step === 'landed' || i < at ? 'done' : i === at ? (step === 'failed' ? 'fail' : 'now') : 'todo';
  });
  return out;
}

// ---------- when each step began ----------

/** The seconds (on the engine's clock, since detection) at which this page saw each step of one rescue begin. */
export interface StepBook {
  id: string;
  starts: Partial<Record<StepId, number>>;
  /** The last step seen before the rescue ended: where a failure happened when the desk does not say. */
  last: StepId | null;
}

export const emptyBook: StepBook = { id: '', starts: {}, last: null };

/**
 * Notes a progress event. A step's start is only known when the page saw it begin: the page opened mid-step can only
 * count from the next one, and a step the stream skipped has no time of its own. A new rescue id starts a new book.
 */
export function observe(book: StepBook, p: RescueProgress): StepBook {
  const fresh = book.id !== p.id;
  const base: StepBook = fresh ? { id: p.id, starts: {}, last: null } : book;
  // The same step again (the engine repeats it as the count moves) changes nothing.
  if (p.step === 'failed' || base.last === p.step) return base;
  // The first event of a rescue is its beginning only when it is the first step; later it is where the page joined.
  const sawBegin = base.last !== null || p.step === 'detect';
  if (!sawBegin) return { ...base, last: p.step };
  return { ...base, starts: { ...base.starts, [p.step]: p.step === 'detect' ? 0 : p.elapsedS }, last: p.step };
}

/** Seconds a step took or has taken so far, or null when the page did not see both ends of it. */
export function stepSeconds(book: StepBook, id: StepId, state: StepState, p: RescueProgress, nowS: number): number | null {
  const start = book.starts[id];
  if (start === undefined) return null;
  if (state === 'now') return Math.max(0, nowS - start);
  if (state === 'fail') return Math.max(0, p.elapsedS - start);
  if (state !== 'done') return null;
  if (id === 'landed') return null;
  const next = book.starts[STEPS[STEPS.indexOf(id) + 1] ?? 'landed'];
  return next === undefined ? null : Math.max(0, next - start);
}

/**
 * The step a failed rescue stopped at: the desk's own word first (`RescueFailure.step`, for this rescue), else the last
 * step this page saw, else nobody knows.
 */
export function failedStep(p: RescueProgress, failure: RescueFailure | null, book: StepBook): StepId | null {
  if (p.step !== 'failed') return null;
  if (failure && failure.rescueId === p.id) return failure.step;
  return book.id === p.id ? book.last : null;
}

/** The failure that belongs to this rescue: `DeskState.rescueFailure` is cleared once margin is safe again. */
export const failureOf = (p: RescueProgress, desk: DeskState | null): RescueFailure | null =>
  desk?.rescueFailure && desk.rescueFailure.rescueId === p.id ? desk.rescueFailure : null;

// ---------- the timer ----------

/**
 * Seconds since the rescue was detected: the engine's own count while it runs (never behind it) or after it ended. `now`
 * is the engine's clock (`useNow`), so a replay counts from its recording's time.
 */
export function timerSeconds(p: RescueProgress, now: number): number {
  if (!isRunning(p)) return Math.max(0, p.elapsedS);
  return Math.max(p.elapsedS, (now - p.startedAt) / 1000, 0);
}

/** `0:31`, `1:12`, `1:02:03` */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** `0.4 s`, `42 s`, `1 min 47 s` */
export function durationText(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const rest = s % 60;
  return rest === 0 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 60)} min ${rest} s`;
}

// ---------- the words ----------

export const venueLabel = (v: VenueId | 'reserve'): string => (v === 'reserve' ? 'The reserve' : VENUE_NAMES[v]);

/** The leg a rescue feeds: the one on the venue the margin goes to. */
export const targetLeg = (desk: DeskState | null, p: RescueProgress): Leg | null => desk?.legs.find((l) => l.venue === p.to) ?? null;

/** What the risk engine journaled when it started this rescue (its `rescue` entry just before `startedAt`). */
export interface TriggerFacts {
  /** When the risk engine journaled it: earlier rescues are the ones before this. */
  t: number;
  /** The line the leg came under, in percent: the owner's, or higher (a stress test, or the venue's volatility). */
  rescuePct: number;
  /** A stress test raised the line to just over the leg's distance. */
  stress: boolean;
  /** What the leg needed, before a transfer was planned. */
  needUsd: number | null;
  /** The leg's distance to liquidation when the trigger fired, in percent. */
  distancePct: number | null;
}

/** How long before the rescuer starts the risk engine's trigger line can be: the rescuer takes it on its next tick. */
export const TRIGGER_LEAD_MS = 60_000;

/**
 * The risk engine's trigger entry for this rescue (the newest `rescue` line with a `rescuePct` at or up to a minute
 * before `startedAt`), or null when the page does not hold it.
 */
export function triggerOf(journal: readonly JournalEntry[], p: Pick<RescueProgress, 'startedAt'>): TriggerFacts | null {
  let e: JournalEntry | undefined;
  for (const x of journal) {
    if (x.kind !== 'rescue' || numberOf(x, 'rescuePct') === null || x.t > p.startedAt || p.startedAt - x.t > TRIGGER_LEAD_MS) continue;
    if (e === undefined || x.t > e.t) e = x;
  }
  if (!e) return null;
  return { t: e.t, rescuePct: numberOf(e, 'rescuePct')!, stress: numberOf(e, 'stress') === 1, needUsd: numberOf(e, 'amountUsd'), distancePct: numberOf(e, 'distancePct') };
}

/** The line a rescue is measured against: the owner's, unless the trigger came under a raised one. */
export interface RescueLine {
  /** The percent the distance is compared with, or null before the owner's line is read. */
  pct: number | null;
  /** How the detect step names it: "your 8% rescue line", or "your 8% rescue line, raised to 11.5% for the venue's volatility". */
  text: string;
  /** How the hero names it: "the 87.32% line the stress test set". */
  short: string;
  /**
   * The detect step's whole sentence when a stress test raised the line: "The stress test raised this leg's rescue line
   * from your 8% to 87.32% (5 points above its 82.29% distance), so a rescue starts". Null otherwise.
   */
  raised: string | null;
}

const pctText = (n: number): string => `${Number(n.toFixed(2))}%`;

export function rescueLine(owner: number | null, trigger: TriggerFacts | null): RescueLine {
  const own = owner === null ? 'your rescue line' : `your ${pctText(owner)} rescue line`;
  if (trigger === null || (owner !== null && trigger.rescuePct <= owner + 1e-9)) return { pct: owner, text: own, short: own, raised: null };
  const at = pctText(trigger.rescuePct);
  if (!trigger.stress) return { pct: trigger.rescuePct, text: `${own}, raised to ${at} for the venue’s volatility`, short: `the ${at} line the venue’s volatility set`, raised: null };
  const from = owner === null ? '' : ` from your ${pctText(owner)}`;
  const d = trigger.distancePct;
  const above = d === null ? '' : ` (${Number((trigger.rescuePct - d).toFixed(1))} points above its ${pctText(d)} distance)`;
  return {
    pct: trigger.rescuePct, text: `${own}, raised to ${at} by the stress test`, short: `the ${at} line the stress test set`,
    raised: `The stress test raised this leg’s rescue line${from} to ${at}${above}, so a rescue starts`,
  };
}

export interface StepContext {
  p: RescueProgress;
  leg: Leg | null;
  /** The line the rescue is measured against (`rescueLine`). */
  line: RescueLine;
  /** A replay has no contract and signs nothing: the verify and sign steps say what the contract would do. */
  mode?: Mode | null;
}

const REPLAY_NOTHING = '(replay: no contract, nothing signed)';

/** The sentence under each step's title. */
export function stepText(id: StepId, { p, leg, line, mode = null }: StepContext): string {
  const to = VENUE_NAMES[p.to];
  const replay = mode === 'replay';
  switch (id) {
    case 'detect':
      if (line.raised !== null) return line.raised;
      return leg ? `The ${to} ${leg.side} came inside ${line.text}` : `A leg on ${to} came inside ${line.text}`;
    case 'source':
      return p.from === 'reserve' ? 'The reserve pays. Both legs keep their margin.' : `${VENUE_NAMES[p.from]} free margin pays. The reserve is kept.`;
    case 'quote':
      // What was quoted and sent; once landed, amountUsd is what arrived after fees, so the row keeps sentUsd.
      return `NEAR Intents: ${usd(p.sentUsd ?? p.amountUsd)} to ${to} margin`;
    case 'verify':
      return replay
        ? `Live, the contract would check the quote signature and the deposit address ${REPLAY_NOTHING}`
        : 'The contract checks the quote signature and the deposit address';
    case 'sign':
      // fund_venue is one contract call that sends the reserve's USDC on NEAR itself: no MPC signature.
      if (replay) {
        return p.from === 'reserve'
          ? `Live, the contract would pay the Intents deposit address from the reserve (fund_venue) ${REPLAY_NOTHING}`
          : `Live, NEAR MPC would sign the transfer ${REPLAY_NOTHING}`;
      }
      return p.from === 'reserve' ? 'The contract pays the Intents deposit address from the reserve (fund_venue)' : 'NEAR MPC signs the transfer';
    case 'deposit':
      return replay ? `The recorded quote’s deposit, played on the replay desk ${REPLAY_NOTHING}` : 'Sent to the Intents deposit address';
    case 'landed':
      return `Credited to ${to} margin`;
  }
}

/** What the failed step says in place of its usual sentence: why, and how many tries. */
export function failText(failure: RescueFailure | null): string {
  if (!failure) return 'The desk did not say why it stopped.';
  return sentenceOf(failure.reason);
}

export const triesText = (tries: number): string => `${tries} ${tries === 1 ? 'try' : 'tries'}`;

const sentenceOf = (text: string): string => {
  const t = text.trim();
  return t === '' ? t : /[.!?]$/.test(t) ? t : `${t}.`;
};

/** The failure's own next line, ending in a full stop. */
export const nextText = (failure: RescueFailure | null): string =>
  failure ? sentenceOf(failure.next) : 'Only you can act now: add margin or close both legs.';

/** The hero's middle: what is moving (or moved, or what the desk tries next). */
export interface MovingView {
  label: string;
  /** The amount, or null where the sentence stands alone (a failed rescue's next line). */
  amount: string | null;
  text: string;
}

/**
 * The engine's amount means what the step can say (RescueProgress.amountUsd): at detect what the leg needs, before
 * a transfer is planned; from source on what the transfer sends; once landed what reached the margin after fees.
 * When the transfer is not what the leg needed (`needUsd`, from the trigger), the text says why in plain words: a
 * replay or testnet plays a recorded quote of a fixed size; elsewhere the caps and the source's free margin limit it.
 */
export function movingOf(p: RescueProgress, failure: RescueFailure | null, needUsd: number | null = null, mode: Mode | null = null): MovingView {
  const route = `${p.from === 'reserve' ? 'Reserve' : `${VENUE_NAMES[p.from]} free margin`} → ${VENUE_NAMES[p.to]} margin, through NEAR Intents`;
  if (p.step === 'failed') return { label: 'The desk tries next', amount: null, text: nextText(failure) };
  const label = p.step === 'detect' ? 'The leg needs' : p.step === 'landed' ? 'Moved' : 'Moving';
  const sent = p.sentUsd ?? p.amountUsd;
  if (p.step === 'detect' || needUsd === null || Math.abs(sent - needUsd) < 0.005) return { label, amount: usd(p.amountUsd), text: route };
  const recorded = mode === 'replay' || mode === 'testnet';
  const why =
    sent > needUsd
      ? recorded
        ? `The leg needs ${usd(needUsd)}; the recorded mainnet quote this ${mode === 'replay' ? 'replay' : 'test'} plays moves a fixed ${usd(sent)}.`
        : `The leg needs ${usd(needUsd)}; the transfer sends ${usd(sent)} with its fees.`
      : `The leg needs ${usd(needUsd)}; the rescue cap and the source’s free margin limit this transfer to ${usd(sent)}.`;
  return { label, amount: usd(p.amountUsd), text: `${route}. ${why}` };
}

/** The line under the distance in the hero, against the line the rescue is measured with (`rescueLine`). */
export function distanceNote(distance: number | null, line: RescueLine): string {
  if (distance === null) return 'the venue gives no distance right now';
  if (line.pct === null) return 'to liquidation';
  return distance < line.pct ? `inside ${line.short}` : `clear of ${line.short}`;
}

// ---------- transactions ----------

/**
 * The step each transaction belongs to. `TxRef` carries no step, so it is read from the chain: a NEAR transaction is the
 * contract call that signs; the first other one is the deposit into the Intents address; a later one on the venue the
 * margin goes to is the landing. Paid from the reserve, the deposit is that NEAR call itself (fund_venue): its link
 * shows at both steps, and the first transaction on the venue's chain is already the landing. A transaction shows only
 * once its step has been reached.
 */
export function txByStep(p: RescueProgress, destinationChain: TxRef['chain'] | null): Record<StepId, ProofLink[]> {
  const out = Object.fromEntries(STEPS.map((id) => [id, [] as ProofLink[]])) as Record<StepId, ProofLink[]>;
  const reserve = p.from === 'reserve';
  let deposited = reserve;
  let fundVenue = reserve;
  for (const t of p.tx) {
    const link = proofLinks([t])[0];
    if (!link) continue;
    const step: StepId = t.chain === 'near' ? 'sign' : deposited && t.chain === destinationChain ? 'landed' : 'deposit';
    if (t.chain !== 'near') deposited = true;
    out[step].push(link);
    if (fundVenue && t.chain === 'near') {
      out.deposit.push(link);
      fundVenue = false;
    }
  }
  return out;
}

/** The chain a venue's transactions are on. */
export const CHAIN_OF: Record<VenueId, TxRef['chain']> = { hyperliquid: 'hyperliquid', phoenix: 'solana', orderly: 'arbitrum' };

// ---------- earlier rescues ----------

export interface EarlierRow {
  id: string;
  date: string;
  text: string;
  /** The seconds until the margin landed, as the journal says. */
  seconds: number | null;
}

const rescues = (journal: readonly JournalEntry[], before: number | null): JournalEntry[] =>
  journal.filter((e) => e.kind === 'rescue' && (before === null || e.t < before));

/** The three newest rescues in the journal, older than this one when `before` is given. */
export function earlierRows(journal: readonly JournalEntry[], before: number | null, limit = 3): EarlierRow[] {
  return rescues(journal, before)
    .slice()
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((e) => ({ id: e.id, date: dayMonth(e.t), text: e.summary, seconds: numberOf(e, 'landedS') }));
}

/** "Usually done in": the median of the seconds past rescues took to land, or null when there are none. */
export function usualSeconds(journal: readonly JournalEntry[], before: number | null): number | null {
  const all = rescues(journal, before)
    .map((e) => numberOf(e, 'landedS'))
    .filter((s): s is number => s !== null && s > 0)
    .sort((a, b) => a - b);
  if (all.length === 0) return null;
  const mid = Math.floor(all.length / 2);
  return all.length % 2 === 1 ? all[mid]! : (all[mid - 1]! + all[mid]!) / 2;
}

/** `Fees were $0.21 to $0.32 each.` from what the journal lists, or null when it lists none. */
export function feesText(journal: readonly JournalEntry[], before: number | null): string | null {
  const fees = rescues(journal, before)
    .map((e) => numberOf(e, 'usd'))
    .filter((v): v is number => v !== null && v < 0)
    .map((v) => -v)
    .sort((a, b) => a - b);
  if (fees.length === 0) return null;
  const lo = fees[0]!;
  const hi = fees[fees.length - 1]!;
  return lo === hi ? `The fee was ${usd(lo)}.` : `Fees were ${usd(lo)} to ${usd(hi)} each.`;
}

// ---------- the stress test ----------

/** The Stress button exists on testnet and in replay only. An unknown network gets none: it is never mainnet by default. */
export const canStress = (mode: Mode | null): boolean => mode === 'testnet' || mode === 'replay';

export interface StressView {
  /** The button, or null where there must be none (mainnet, or the network is not known yet). */
  button: { label: string; disabled: boolean } | null;
  /** The line under it. */
  note: string;
}

export function stressView(mode: Mode | null, running: boolean, sending: boolean): StressView {
  if (!canStress(mode)) {
    return {
      button: null,
      note: mode === 'mainnet' ? 'You are on mainnet, where a stress test never runs. Switch to testnet or a replay to run one.' : 'Waiting for the network.',
    };
  }
  return {
    button: { label: sending ? 'Sending…' : 'Run a stress test', disabled: running || sending },
    note: running ? 'A rescue is running now. Run a stress test once it ends.' : '',
  };
}

/** What the owner is told after Run a stress test was sent: the engine's answer, or that it gave none (`answer` is an `Error`). */
export function stressOutcome(answer: ActionResult | Error): { tone: 'sent' | 'refused' | 'unknown'; title: string; text: string } {
  if (answer instanceof Error) {
    return { tone: 'unknown', title: 'No answer', text: 'The engine did not answer, so this page cannot tell whether the stress test started. Check this screen before you try again.' };
  }
  if (answer.ok) {
    return { tone: 'sent', title: 'Sent', text: 'The engine pushes one leg past the rescue line. The steps appear here as they run.' };
  }
  return { tone: 'refused', title: 'Not sent', text: `The engine refused it. ${reasonText(answer.reason)} Nothing changed.` };
}
