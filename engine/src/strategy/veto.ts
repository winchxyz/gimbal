// The NEAR AI risk check before an enter or a rotate (docs/interfaces.md §3 "Strategy loop"; internal names keep
// "veto", every text the owner reads says "NEAR AI risk check"): the window's facts go to the
// same client, endpoint, key and model as POST /policy/draft, and the model answers {verdict: 'pass' | 'veto',
// reasons}, before every enter and every rotate. A veto can only remove a window: nothing the model says changes the
// window, the size or the leverage, or is sent to the contract or a venue.
//
// It fails closed: only a readable "pass" lets the act go ahead. No answer within LOOP_RULES.vetoTimeoutMs, or NEAR AI
// down (a transport or HTTP error), is asked once more (LOOP_RULES.vetoAttempts tries in all); still no answer, and the
// act is held ("the NEAR AI risk check did not answer"): not carried out, and asked again at the next hourly check. A
// held act is not a refusal: it starts no LOOP_RULES.vetoHoldHours hold-out. No key, or a key NEAR AI rejects (401 or
// 403, asked once: it never heals by itself), holds it too, said on every decision. A reply that came but cannot be
// read as one verdict (not JSON, no verdict, more than one JSON object, text around it, a key given twice, a "veto"
// inside a "pass", cut off at its token limit) is a veto, "unreadable reply", with its hold-out.
//
// Replay only (`npm run demo`: RecordedVeto with replayPassUnrecorded, which serve sets in replay mode alone): a prompt
// with no recorded reply passes, and its line says this is replay-only behaviour and that live the entry would wait.
//
// The prompt is built from the facts alone (no clock, no ids that change between runs), so a recorded exchange is
// found again by its prompt: RecordedVeto plays a recording back without a key (replay mode, tests). checkVeto returns
// the exchange it made (the exact messages, the raw reply, the latency), for loop.ts to journal and book; riskCheckWhy
// is the one line every decision then carries. Facts no venue gave are null in the prompt, which calls them unknown.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Mode, Window as FundingWindow } from '@gimbal/shared';
import { NEAR_AI_MODEL, NearAiUnavailable, completionContent, parseJsonObject } from '../nearai/client.ts';
import type { ChatMessage, Completion } from '../nearai/client.ts';
import { errorMessage } from '../venues/recorder.ts';
import { LOOP_RULES } from './decide.ts';

export type Veto = NonNullable<FundingWindow['veto']>;

/** What answers the veto: NearAiClient (live), or RecordedVeto (a recording). */
export interface VetoSource {
  readonly model: string;
  readonly configured: boolean;
  /**
   * Replay only: a prompt with no recorded reply (complete() throws UnrecordedPrompt) passes, labelled replay-only.
   * Absent or false (every live and testnet source): no answer, and the act is held.
   */
  readonly replayPassUnrecorded?: boolean;
  /**
   * A recording may say how long the answer took when it was recorded (`latencyMs`); a live call is timed here.
   * `signal`: checkVeto aborts it when an attempt times out or the act is cancelled, so a retry never overlaps it.
   */
  complete(messages: readonly ChatMessage[], options?: { json?: boolean; maxTokens?: number; signal?: AbortSignal }): Promise<Completion & { latencyMs?: number }>;
}

export interface VetoLeg {
  venue: string;
  side: 'long' | 'short';
  openInterestUsd: number | null;   // the leg market's open interest (scanner.carry(id).long/short.oiUsd)
  bookDepthUsd: number | null;      // USD on the side the leg fills (asks for a long, bids for a short) within the
                                    // book levels read; null = not known
  fillImpactBps: number | null;     // how far the leg's whole size fills from the mid, bps, walking those levels;
                                    // null = not known, or the levels read do not hold the size
  priceMove24hPct: number | null;   // the leg market's mark against its price 24 h ago, signed, as the venue gives it
  daysSinceListing: number | null;  // where the venue says when it listed the market (Orderly); null = it does not
}

/** The leg facts vetoFacts takes; whatever is not passed is unknown (null). */
export type VetoLegFacts = Partial<Omit<VetoLeg, 'venue' | 'side'>>;

/** The window's facts the model judges. Unknown = null, and the prompt says so rather than guessing. */
export interface VetoFacts {
  kind: 'enter' | 'rotate';
  symbol: string;
  longVenue: string;
  shortVenue: string;
  grossAprPct: number;              // this hour
  grossApr7dPct: number | null;
  grossApr14dPct: number | null;
  netAprPct: number;                // what the gate holds to the minimum
  minNetAprPct: number;
  hoursAbove: number;               // hourly checks in a row it passed the entry rules (or beat the held window)
  legUsd: number;
  leverage: number;
  legs: [VetoLeg, VetoLeg];
  /**
   * The owner asked for this act by hand (POST /rotate): it skips the minimum and the streak, so the prompt says the
   * minimum is waived and leaves the streak out, rather than show a minimum the act was never held to. Absent: auto.
   */
  manual?: boolean;
  /**
   * An owner demo entry (POST /rotate with demo, always manual): its profit checks are waived, and the owner accepted
   * a round-trip cost estimate of at most maxLossUsd (the window's estimate: roundTripUsd); funding during the hold is
   * expected positive (the spread must be) and is not part of that bound. The prompt says so. Absent: none.
   */
  demo?: { maxLossUsd: number; roundTripUsd: number };
}

/** What a manual act's prompt says in place of the owner's minimum. */
export const MANUAL_MINIMUM = 'waived: the owner asked for this trade';
/** What a demo entry's prompt says it is. */
export const DEMO_ENTRY_TEXT = 'an owner-requested demonstration entry: the profit checks (the owner minimum, the round trip paid back, break-even) '
  + 'are waived; every other check passed, the expected funding spread over the hold included, which must be positive. '
  + 'owner_accepted_cost_usd bounds the estimated round-trip cost (fees, slippage, basis buffer) only: funding during the '
  + 'hold is expected positive and is not part of that bound';

/**
 * What a manual act's prompt says about `computed`: the comparisons the red flags turn on, worked out by the engine
 * from the same numbers, so the model reads a result instead of comparing two numbers itself (it has called an
 * $11,224.94 book smaller than a $10.63 leg, and a 0.07 % move a liquidation risk). Manual prompts only: an auto
 * act's prompt is unchanged, since recorded replies are found by it.
 */
export const COMPUTED_NOTE = 'worked out by the engine from the numbers above: rely on these results instead of comparing the raw numbers yourself. '
  + 'null means not known';

const ratio = (a: number | null, b: number | null): number | null => (a === null || b === null || b === 0 ? null : Math.round((a / b) * 100) / 100);

/** The red flags' comparisons, computed: ratios to two decimals, booleans, null where a number is not known. */
export function computedFacts(facts: VetoFacts): Record<string, unknown> {
  const { grossAprPct: now, grossApr7dPct: d7, grossApr14dPct: d14, legUsd } = facts;
  return {
    note: COMPUTED_NOTE,
    this_hour_spread_over_7d_mean: ratio(now, d7),
    this_hour_spread_over_14d_mean: ratio(now, d14),
    spread_7d_and_14d_same_direction: d7 === null || d14 === null ? null : d7 * d14 > 0,
    legs: facts.legs.map((l) => ({
      venue: l.venue,
      side: l.side,
      book_depth_is_at_least_leg: l.bookDepthUsd === null ? null : l.bookDepthUsd >= legUsd,
      book_depth_over_leg: ratio(l.bookDepthUsd, legUsd),
      open_interest_over_leg: ratio(l.openInterestUsd, legUsd),
      fill_impact_is_50_bps_or_less: l.fillImpactBps === null ? null : l.fillImpactBps <= 50,
      price_move_24h_is_within_15_pct: l.priceMove24hPct === null ? null : Math.abs(l.priceMove24hPct) <= 15,
      listed_14_days_or_more: l.daysSinceListing === null ? null : l.daysSinceListing >= 14,
    })),
  };
}

/** The most reasons kept from a reply, and the longest. */
const MAX_REASONS = 3;
const MAX_REASON_TEXT = 200;
/** A verdict is a few dozen tokens. */
export const VETO_MAX_TOKENS = 300;
const MAX_TOKENS = VETO_MAX_TOKENS;

export const VETO_SYSTEM_PROMPT = `You review one funding-rate carry trade before an automated desk opens it. The desk holds a long perpetual leg on one venue and a short perpetual leg of the same asset on another, and earns the difference in funding. You cannot approve, size or change the trade: you can only veto it. The trade goes ahead unless you veto it.

Veto only on a concrete red flag in the facts, for example:
- the funding spread this hour is far above its 7-day mean, so it looks like a spike that will not last;
- the 7-day and 14-day spreads disagree, or the spread is shrinking fast;
- a leg's open interest is small next to the leg size, or its book cannot fill the leg (book_depth_usd under leg_usd, or fill_impact_bps above 50);
- a leg's price moved more than 15 % in 24 hours, so a leg is near liquidation risk;
- a leg's market was listed less than 14 days ago.
Facts given as null are unknown: never veto because a fact is unknown.

Answer with one JSON object and nothing else: {"verdict": "pass" or "veto", "reasons": [up to 3 short sentences, each naming the fact and its number]}. With "pass", reasons may be empty.`;

const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** The messages that ask for a verdict on `facts`: deterministic, so a recording is found again by them. */
export function vetoMessages(facts: VetoFacts): ChatMessage[] {
  const trade = facts.kind === 'enter' ? 'open a new pair' : 'rotate the held pair into this one';
  // An auto act's prompt is unchanged (recorded replies are found by it); a manual one says the minimum is waived and
  // carries no streak (the owner's ask skips both).
  const gate = facts.manual === true
    ? { manual: true, owner_minimum_net_apr_pct: MANUAL_MINIMUM }
    : { owner_minimum_net_apr_pct: r2(facts.minNetAprPct), hours_in_a_row_above_minimum: facts.hoursAbove };
  // A demo entry says what it is and what it may cost: the owner accepted that cost; the risks are judged as ever.
  const demo = facts.demo === undefined ? {} : {
    demo_entry: DEMO_ENTRY_TEXT, expected_round_trip_cost_usd: r4(facts.demo.roundTripUsd), owner_accepted_cost_usd: r4(facts.demo.maxLossUsd),
  };
  const f = {
    trade: facts.demo !== undefined ? `${trade} (an owner-requested demonstration entry, asked by hand)` : facts.manual === true ? `${trade} (asked by the owner by hand)` : trade,
    asset: facts.symbol,
    long_venue: facts.longVenue,
    short_venue: facts.shortVenue,
    gross_apr_pct_this_hour: r2(facts.grossAprPct),
    gross_apr_pct_7d: r2(facts.grossApr7dPct),
    gross_apr_pct_14d: r2(facts.grossApr14dPct),
    net_apr_pct_after_costs: r2(facts.netAprPct),
    ...gate,
    ...demo,
    leg_usd: r2(facts.legUsd),
    leverage: r2(facts.leverage),
    legs: facts.legs.map((l) => ({
      venue: l.venue, side: l.side, open_interest_usd: r2(l.openInterestUsd), book_depth_usd: r2(l.bookDepthUsd),
      fill_impact_bps: r2(l.fillImpactBps), price_move_24h_pct: r2(l.priceMove24hPct), days_since_listing: r2(l.daysSinceListing),
    })),
    ...(facts.manual === true ? { computed: computedFacts(facts) } : {}),
  };
  return [{ role: 'system', content: VETO_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(f) }];
}

/** The facts of a window, with what Window does not carry passed in (null where not known). */
export function vetoFacts(
  w: FundingWindow,
  extra: {
    kind: 'enter' | 'rotate'; legUsd: number; leverage: number; minNetAprPct: number; hoursAbove: number;
    grossApr14dPct?: number | null; legs?: { long?: VetoLegFacts; short?: VetoLegFacts }; manual?: boolean;
    demo?: { maxLossUsd: number; roundTripUsd: number };
  },
): VetoFacts {
  const leg = (venue: string, side: 'long' | 'short', x: VetoLegFacts | undefined): VetoLeg => ({
    venue, side, openInterestUsd: x?.openInterestUsd ?? null, bookDepthUsd: x?.bookDepthUsd ?? null,
    fillImpactBps: x?.fillImpactBps ?? null, priceMove24hPct: x?.priceMove24hPct ?? null, daysSinceListing: x?.daysSinceListing ?? null,
  });
  return {
    kind: extra.kind, symbol: w.symbol, longVenue: w.longVenue, shortVenue: w.shortVenue,
    grossAprPct: w.grossAprPct, grossApr7dPct: w.grossApr7dPct, grossApr14dPct: extra.grossApr14dPct ?? null,
    netAprPct: w.netAprPct, minNetAprPct: extra.minNetAprPct, hoursAbove: extra.hoursAbove,
    legUsd: extra.legUsd, leverage: extra.leverage,
    legs: [leg(w.longVenue, 'long', extra.legs?.long), leg(w.shortVenue, 'short', extra.legs?.short)],
    ...(extra.manual === true ? { manual: true } : {}),
    ...(extra.demo === undefined ? {} : { demo: extra.demo }),
  };
}

/**
 * One question and its answer, plain JSON: the prompt's key, the messages sent and the response body exactly as
 * NEAR AI sent it (null when none came back). A replay fixture is `{ "exchanges": VetoExchange[] }`; a journal entry
 * takes it through vetoJournalNumbers.
 */
export interface VetoExchange {
  key: string;
  model: string;
  messages: ChatMessage[];
  response: unknown;
  /** How long NEAR AI took to answer (ms); null or absent when no answer came or it was not timed. */
  latencyMs?: number | null;
}

/**
 * How a check ended: passed or refused on a readable verdict; refused on an unreadable reply; held for want of an
 * answer (timed out, NEAR AI unavailable, no key, the key rejected); or, in replay only, passed on a prompt with no
 * recorded reply.
 */
export type RiskCheckOutcome = 'passed' | 'refused' | 'unreadable' | 'timeout' | 'unavailable' | 'no-key' | 'key-rejected' | 'replay-unrecorded';

export interface VetoResult {
  /**
   * The verdict as Window.veto shows it. A held check carries "veto" (fail closed: whatever reads only this refuses the
   * act); loop.ts tells it apart by `held`, and neither shows it on the window nor holds the window out.
   */
  veto: Veto;
  /** true = a reply came (a readable verdict, or an unreadable reply, which is refused). */
  checked: boolean;
  /**
   * true = no readable verdict came (no answer after LOOP_RULES.vetoAttempts tries, no key, the key rejected): the act
   * is not carried out and waits for the next hourly check. Not a refusal: no LOOP_RULES.vetoHoldHours hold-out.
   */
  held: boolean;
  outcome: RiskCheckOutcome;
  /** The one-line reason: the model's reasons joined, or why no verdict came. */
  reason: string;
  /** How long the answer took (ms); null when no answer came. */
  latencyMs: number | null;
  /** How many times NEAR AI was asked (0: no key, nothing sent). */
  attempts: number;
  /**
   * One line for the journal: "NEAR AI passed …", "NEAR AI risk check refused …: <reason>", "the NEAR AI risk check did
   * not answer on …: <why>: held, …", or (replay only) "…: passed in replay only; live, the entry would wait".
   */
  line: string;
  /** What was asked and what came back; null only when nothing was asked (no key). */
  exchange: VetoExchange | null;
}

/**
 * The exchange as JournalEntry.numbers keys (strings): vetoModel, vetoKey, vetoPrompt (the facts sent: the system
 * prompt is fixed and named by the key) and vetoReply (the model's text as it came, or "" when none came back).
 */
export function vetoJournalNumbers(e: VetoExchange): Record<string, string | number> {
  return {
    vetoModel: e.model, vetoKey: e.key, vetoSystem: e.messages.find((m) => m.role === 'system')?.content ?? '',
    vetoPrompt: e.messages.at(-1)?.content ?? '', vetoReply: replyText(e),
    ...(e.latencyMs === null || e.latencyMs === undefined ? {} : { vetoMs: Math.round(e.latencyMs) }),
  };
}

/** The model's text as it came ("" when none came back; the body itself when it is not a chat completion). */
export function replyText(e: Pick<VetoExchange, 'response'>): string {
  if (e.response === null || e.response === undefined) return '';
  try {
    return completionContent(e.response);
  } catch {
    return JSON.stringify(e.response);
  }
}

/** What every held line ends with: the act waits; it is not refused. */
export const HELD_TAIL = 'held, not passed: the act waits';
/** riskCheckWhy of a check with no key: it can never answer, so every enter and rotate is held. */
export const NO_KEY_WHY = `no NEAR AI key, so the NEAR AI risk check cannot answer: ${HELD_TAIL}`;
/** What a replay-only pass says (live and testnet, such a prompt is no answer, and the act is held). */
export const REPLAY_UNRECORDED = 'no recorded NEAR AI risk check reply for this prompt: passed in replay only; live, the entry would wait';

/**
 * The risk check's part of a "why" line: its verdict and one-line reason, with the attestation for a reply that came
 * ("TEE attested <date> UTC" or "TEE not attested: <why>"), or why no verdict came and the act is held.
 */
export function riskCheckWhy(r: Pick<VetoResult, 'outcome' | 'reason'>, attestation: string): string {
  switch (r.outcome) {
    case 'passed': return `NEAR AI risk check passed (${attestation}): ${r.reason === '' ? 'no red flag named' : r.reason}`;
    case 'refused':
    case 'unreadable': return `NEAR AI risk check refused (${attestation}): ${r.reason}`;
    case 'timeout':
    case 'unavailable': return `the NEAR AI risk check did not answer (${r.reason}): ${HELD_TAIL}`;
    case 'no-key': return NO_KEY_WHY;
    case 'key-rejected': return `${r.reason}, so the NEAR AI risk check cannot answer: ${HELD_TAIL}`;
    case 'replay-unrecorded': return REPLAY_UNRECORDED;
  }
}

/** The key a prompt is recorded under. */
export function promptKey(messages: readonly ChatMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 24);
}

/**
 * Every top-level `{…}` in a text, in order, with where it starts and ends; NearAiUnavailable when one is never
 * closed (a reply cut short).
 */
function topLevelObjects(text: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (depth === 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) found.push({ start, end: i + 1 });
  }
  if (depth !== 0) throw new NearAiUnavailable('the model\'s reply has a JSON object that is never closed');
  return found;
}

/** The first key that appears twice in one object of a JSON text, or null. JSON.parse would keep only the last. */
function duplicateKey(json: string): string | null {
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === '{') stack.push(new Set());
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === '\\' ? 2 : 1;
      const literal = json.slice(i, j + 1);
      i = j;
      let k = j + 1;
      while (k < json.length && /\s/.test(json[k]!)) k++;
      const keys = stack.at(-1);
      if (json[k] === ':' && keys !== null && keys !== undefined) {
        const key = JSON.parse(literal) as string;
        if (keys.has(key)) return key;
        keys.add(key);
      }
    }
  }
  return null;
}

/** A reply's text around its JSON object: only whitespace and ``` fences (```json) may be there. */
const FENCE_ONLY = /^(?:\s|```[A-Za-z0-9_-]*)*$/;

/** Whether any object below `value` (not `value` itself) carries a verdict that reads "veto". */
function nestedVeto(value: unknown, root = true): boolean {
  if (Array.isArray(value)) return value.some((x) => nestedVeto(x, false));
  if (typeof value !== 'object' || value === null) return false;
  const v = (value as Record<string, unknown>).verdict;
  if (!root && typeof v === 'string' && v.trim().toLowerCase() === 'veto') return true;
  return Object.values(value).some((x) => nestedVeto(x, false));
}

/**
 * The verdict in a model's whole reply: one JSON object, with nothing around it but whitespace and ``` fences.
 * NearAiUnavailable (so: a veto, "unreadable reply") when it holds no JSON object, more than one, one never closed,
 * other text around it, a key twice in one object, an object that is not a verdict, or a verdict of "veto" anywhere
 * inside a "pass".
 */
export function verdictFromReply(text: string): { verdict: 'pass' | 'veto'; reasons: string[] } {
  const objects = topLevelObjects(text);
  if (objects.length === 0) throw new NearAiUnavailable('the model\'s reply has no JSON object');
  if (objects.length > 1) throw new NearAiUnavailable(`the model's reply holds ${objects.length} JSON objects`);
  const { start, end } = objects[0]!;
  if (!FENCE_ONLY.test(text.slice(0, start)) || !FENCE_ONLY.test(text.slice(end))) {
    throw new NearAiUnavailable('the model\'s reply has text outside its JSON object');
  }
  const json = text.slice(start, end);
  const value = parseJsonObject(json);
  const twice = duplicateKey(json);
  if (twice !== null) throw new NearAiUnavailable(`the model's reply gives "${twice}" twice`);
  const verdict = parseVerdict(value);
  if (verdict.verdict === 'pass' && nestedVeto(value)) throw new NearAiUnavailable('the model\'s "pass" holds a "veto" inside it');
  return verdict;
}

/** The model's answer as a verdict (trimmed, any case); NearAiUnavailable when it is not one. */
export function parseVerdict(value: Record<string, unknown>): { verdict: 'pass' | 'veto'; reasons: string[] } {
  const v = typeof value.verdict === 'string' ? value.verdict.trim().toLowerCase() : value.verdict;
  if (v !== 'pass' && v !== 'veto') throw new NearAiUnavailable('the reply is not a verdict ("pass" or "veto")');
  const raw = Array.isArray(value.reasons) ? value.reasons : [];
  const reasons = raw
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .filter((x) => x !== '')
    .slice(0, MAX_REASONS)
    .map((x) => (x.length > MAX_REASON_TEXT ? `${x.slice(0, MAX_REASON_TEXT)}…` : x));
  return { verdict: v, reasons: v === 'veto' && reasons.length === 0 ? ['no reason given'] : reasons };
}

/** NearAiUnavailable messages that mean no reply came at all (transport, HTTP, no key, nothing recorded). */
const NO_ANSWER = ['NEAR_AI_API_KEY is not set', 'NEAR AI did not answer', 'NEAR AI answered HTTP', 'no recorded NEAR AI risk check reply'];

/** The reason a veto that fails closed carries. */
export const UNREADABLE_REPLY = 'unreadable reply';

/** RecordedVeto with replayPassUnrecorded: no reply was recorded for this prompt (replay only). */
export class UnrecordedPrompt extends Error {
  constructor() {
    super('no recorded NEAR AI risk check reply for this prompt');
    this.name = 'UnrecordedPrompt';
  }
}

/** How one ask ended without a reply: why, the outcome, and whether asking again may help. */
interface NoReply {
  why: string;
  outcome: 'timeout' | 'unavailable' | 'key-rejected';
  again: boolean;
}

/** The why of a check cancelled before NEAR AI answered (the loop's act was cancelled or serve is stopping). */
export const RISK_CHECK_CANCELLED = 'cancelled before NEAR AI answered';

/**
 * One attempt: `source.complete` with a signal that aborts at `timeoutMs` or when `cancel` aborts, so the call is
 * ended, not left running beside the retry. Rejects with "no answer within N s" at the timeout, and with
 * RISK_CHECK_CANCELLED on a cancel, whether or not the source honours the signal.
 */
async function askOnce(
  source: VetoSource, messages: readonly ChatMessage[], timeoutMs: number, cancel: AbortSignal | undefined,
): Promise<Completion & { latencyMs?: number }> {
  if (cancel?.aborted === true) throw new Error(RISK_CHECK_CANCELLED);
  const attempt = new AbortController();
  let stop: ((err: Error) => void) | null = null;
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  // `stopped` settles first, so the race ends on the timeout or cancel, not on the call's own abort error.
  const end = (err: Error) => {
    stop?.(err);
    attempt.abort(err);
  };
  const timer = setTimeout(() => end(new Error(`NEAR AI risk check: no answer within ${timeoutMs / 1000} s`)), timeoutMs);
  const onCancel = () => end(new Error(RISK_CHECK_CANCELLED));
  cancel?.addEventListener('abort', onCancel, { once: true });
  try {
    const call = source.complete(messages, { json: true, maxTokens: MAX_TOKENS, signal: attempt.signal });
    // A call that settles after the attempt ended is ignored, never unhandled.
    call.catch(() => undefined);
    return await Promise.race([call, stopped]);
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener('abort', onCancel);
  }
}

/**
 * Asks for a verdict on `facts`. Never throws. A timeout or a transport/HTTP error is asked again, up to
 * LOOP_RULES.vetoAttempts tries; still no reply, and the act is held (`held`, never a pass). No key or a rejected key
 * holds it at once. A reply that came but is not a readable verdict (including one cut off at its token limit) is a
 * veto, "unreadable reply". Replay only (source.replayPassUnrecorded): a prompt with no recording passes, said so.
 * Each attempt's call is aborted when it times out, so a retry never overlaps it. `signal` (the loop's act cancelled,
 * or serve stopping) ends the check at once, held with RISK_CHECK_CANCELLED and asked no more.
 */
export async function checkVeto(
  source: VetoSource, facts: VetoFacts, options: { now: number; timeoutMs?: number; attempts?: number; timer?: () => number; signal?: AbortSignal },
): Promise<VetoResult> {
  const timeoutMs = options.timeoutMs ?? LOOP_RULES.vetoTimeoutMs;
  const tries = Math.max(1, Math.floor(options.attempts ?? LOOP_RULES.vetoAttempts));
  const timer = options.timer ?? (() => performance.now());
  const held = (why: string, outcome: RiskCheckOutcome, attempts: number, exchange: VetoExchange | null): VetoResult => ({
    veto: { verdict: 'veto', reasons: [`the NEAR AI risk check did not answer: ${why}`], model: source.model, at: options.now },
    checked: false, held: true, outcome, reason: why, latencyMs: null, attempts,
    line: `the NEAR AI risk check did not answer on ${facts.symbol}: ${why}: ${HELD_TAIL}`,
    exchange,
  });
  const unreadable = (why: string, exchange: VetoExchange, attempts: number): VetoResult => ({
    veto: { verdict: 'veto', reasons: [UNREADABLE_REPLY], model: source.model, at: options.now },
    checked: true, held: false, outcome: 'unreadable', reason: `${UNREADABLE_REPLY} (${why})`, latencyMs: exchange.latencyMs ?? null, attempts,
    line: `NEAR AI risk check refused ${facts.symbol}: ${UNREADABLE_REPLY} (${why})`,
    exchange,
  });
  if (!source.configured) return held('NEAR_AI_API_KEY is not set', 'no-key', 0, null);
  const messages = vetoMessages(facts);
  const asked: VetoExchange = { key: promptKey(messages), model: source.model, messages, response: null };
  let completion: (Completion & { latencyMs?: number }) | null = null;
  let started = timer();
  let last: NoReply | null = null;
  let attempts = 0;
  while (completion === null && attempts < tries) {
    attempts++;
    started = timer();
    try {
      completion = await askOnce(source, messages, timeoutMs, options.signal);
    } catch (err) {
      if (options.signal?.aborted === true) return held(RISK_CHECK_CANCELLED, 'unavailable', attempts, asked);
      const message = errorMessage(err);
      if (err instanceof UnrecordedPrompt) {
        // Replay only: the demo's scripted entry has no recorded reply. Anywhere else it is no answer, as live.
        if (source.replayPassUnrecorded === true) {
          return {
            veto: { verdict: 'pass', reasons: [REPLAY_UNRECORDED], model: source.model, at: options.now },
            checked: false, held: false, outcome: 'replay-unrecorded', reason: REPLAY_UNRECORDED, latencyMs: null, attempts,
            line: `${facts.symbol}: ${REPLAY_UNRECORDED}`, exchange: asked,
          };
        }
        last = { why: message, outcome: 'unavailable', again: false };
      } else if (!(err instanceof NearAiUnavailable) && /no answer within/.test(message)) {
        last = { why: `no answer within ${timeoutMs / 1000} s`, outcome: 'timeout', again: true };
      } else if (err instanceof NearAiUnavailable && NO_ANSWER.some((p) => message.startsWith(p))) {
        if (message.startsWith('NEAR_AI_API_KEY')) return held(message, 'no-key', attempts, asked);
        // A bad key is no answer too, but it never heals by itself: asked once, and it says so on every decision.
        const rejected = /^NEAR AI answered (HTTP 40[13]\b.*)$/s.exec(message);
        if (rejected !== null) last = { why: `NEAR AI key rejected (${rejected[1]})`, outcome: 'key-rejected', again: false };
        else last = { why: message, outcome: 'unavailable', again: !message.startsWith('no recorded') };
      } else {
        // A reply came and could not be read (cut off, not a chat completion, not JSON): fail closed.
        return unreadable(message, { ...asked, latencyMs: timer() - started }, attempts);
      }
      if (!last.again) break;
    }
  }
  if (completion === null) {
    const l = last ?? { why: 'no answer', outcome: 'unavailable' as const, again: false };
    return held(attempts > 1 ? `${l.why}, asked ${attempts} times` : l.why, l.outcome, attempts, asked);
  }
  const latencyMs = completion.latencyMs ?? timer() - started;
  const exchange: VetoExchange = { ...asked, response: completion.raw, latencyMs };
  let verdict: ReturnType<typeof parseVerdict>;
  try {
    verdict = verdictFromReply(completion.content);
  } catch (err) {
    return unreadable(errorMessage(err), exchange, attempts);
  }
  const veto: Veto = { verdict: verdict.verdict, reasons: verdict.reasons, model: source.model, at: options.now };
  const line = verdict.verdict === 'veto'
    ? `NEAR AI risk check refused ${facts.symbol}: ${verdict.reasons.join('; ')}`
    : `NEAR AI passed ${facts.symbol}${verdict.reasons.length === 0 ? '' : `: ${verdict.reasons.join('; ')}`}`;
  return {
    veto, checked: true, held: false, outcome: verdict.verdict === 'veto' ? 'refused' : 'passed', reason: verdict.reasons.join('; '), latencyMs, attempts, line, exchange,
  };
}

/**
 * Plays recorded veto exchanges back, found by their prompt: no key, no network. A prompt with no recording is no
 * answer (NearAiUnavailable), so checkVeto holds the act, as live. With replayPassUnrecorded (serve sets it in replay
 * mode only) it is UnrecordedPrompt instead, which checkVeto passes with the replay-only label.
 */
export class RecordedVeto implements VetoSource {
  readonly configured = true;
  readonly model: string;
  readonly replayPassUnrecorded: boolean;
  readonly #byKey: Map<string, VetoExchange>;

  constructor(exchanges: readonly VetoExchange[], model = NEAR_AI_MODEL, options: { replayPassUnrecorded?: boolean } = {}) {
    this.model = model;
    this.replayPassUnrecorded = options.replayPassUnrecorded === true;
    // An exchange with no answer recorded plays back as no answer. A later answer to the same prompt wins.
    this.#byKey = new Map(exchanges.filter((e) => e.response !== null && e.response !== undefined).map((e) => [e.key, e]));
  }

  /** A recording file: `{ "exchanges": VetoExchange[] }` (other keys, like `_comment`, are ignored). */
  static fromFile(path: string, options: { replayPassUnrecorded?: boolean } = {}): RecordedVeto {
    return RecordedVeto.fromFiles([path], options);
  }

  /** Several recordings, in order: a later file's answer to a prompt replaces an earlier one's. */
  static fromFiles(paths: readonly string[], options: { replayPassUnrecorded?: boolean } = {}): RecordedVeto {
    return new RecordedVeto(paths.flatMap((path) => readExchanges(path)), NEAR_AI_MODEL, options);
  }

  /** Prompts with a recorded answer. */
  get size(): number {
    return this.#byKey.size;
  }

  async complete(messages: readonly ChatMessage[]): Promise<Completion & { latencyMs?: number }> {
    const e = this.#byKey.get(promptKey(messages));
    if (e === undefined) {
      if (this.replayPassUnrecorded) throw new UnrecordedPrompt();
      throw new NearAiUnavailable('no recorded NEAR AI risk check reply for this prompt');
    }
    return { content: completionContent(e.response), raw: e.response, ...(typeof e.latencyMs === 'number' ? { latencyMs: e.latencyMs } : {}) };
  }
}

/** The exchanges of a recording file: `{ "exchanges": VetoExchange[] }`. */
export function readExchanges(path: string): VetoExchange[] {
  const body = JSON.parse(readFileSync(path, 'utf8')) as { exchanges?: VetoExchange[] };
  if (!Array.isArray(body.exchanges)) throw new Error(`${path}: no "exchanges" list`);
  return body.exchanges;
}

/**
 * The risk check serve gives the strategy loop. Testnet and mainnet always get NEAR AI (`nearAi`), with or without a
 * key: no key holds every enter and rotate, never passes one. Replay with a key gets NEAR AI too. Only replay without
 * a key plays the recorded replies in `files` (read only then), and only there a prompt with no recorded reply passes,
 * labelled replay-only.
 */
export function riskCheckSource(mode: Mode, nearAi: VetoSource, files: () => readonly string[]): VetoSource {
  if (mode !== 'replay' || nearAi.configured) return nearAi;
  return RecordedVeto.fromFiles(files(), { replayPassUnrecorded: true });
}
