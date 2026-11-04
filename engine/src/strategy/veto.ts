// The NEAR AI risk check before an enter or a rotate (docs/interfaces.md §3 "Strategy loop"; internal names keep
// "veto", every text the owner reads says "NEAR AI risk check"): the window's facts go to the
// same client, endpoint, key and model as POST /policy/draft, and the model answers {verdict: 'pass' | 'veto',
// reasons}, before every enter and every rotate. A veto can only remove a window: nothing the model says changes the
// window, the size or the leverage, or is sent to the contract or a venue. No key, no answer within
// LOOP_RULES.vetoTimeoutMs, or NEAR AI down (a transport or HTTP error): the window passes, and the journal line says
// "no NEAR AI risk check" (a 401 or 403 says "NEAR AI key rejected", so a bad key shows on every decision). A reply that
// came but cannot be read as one verdict (not JSON, no verdict, more than one JSON object, text around it, a key
// given twice, a "veto" inside a "pass", cut off at its token limit) fails closed: it is a veto, "unreadable reply".
//
// The prompt is built from the facts alone (no clock, no ids that change between runs), so a recorded exchange is
// found again by its prompt: RecordedVeto plays a recording back without a key (replay mode, tests). checkVeto returns
// the exchange it made (the exact messages, the raw reply, the latency), for loop.ts to journal and book; riskCheckWhy
// is the one line every decision then carries. Facts no venue gave are null in the prompt, which calls them unknown.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Window as FundingWindow } from '@gimbal/shared';
import { NEAR_AI_MODEL, NearAiUnavailable, completionContent, parseJsonObject } from '../nearai/client.ts';
import type { ChatMessage, Completion } from '../nearai/client.ts';
import { withTimeout } from '../scanner/scanner.ts';
import { errorMessage } from '../venues/recorder.ts';
import { LOOP_RULES } from './decide.ts';

export type Veto = NonNullable<FundingWindow['veto']>;

/** What answers the veto: NearAiClient (live), or RecordedVeto (a recording). */
export interface VetoSource {
  readonly model: string;
  readonly configured: boolean;
  /** A recording may say how long the answer took when it was recorded (`latencyMs`); a live call is timed here. */
  complete(messages: readonly ChatMessage[], options?: { json?: boolean; maxTokens?: number }): Promise<Completion & { latencyMs?: number }>;
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

/** The messages that ask for a verdict on `facts`: deterministic, so a recording is found again by them. */
export function vetoMessages(facts: VetoFacts): ChatMessage[] {
  const f = {
    trade: facts.kind === 'enter' ? 'open a new pair' : 'rotate the held pair into this one',
    asset: facts.symbol,
    long_venue: facts.longVenue,
    short_venue: facts.shortVenue,
    gross_apr_pct_this_hour: r2(facts.grossAprPct),
    gross_apr_pct_7d: r2(facts.grossApr7dPct),
    gross_apr_pct_14d: r2(facts.grossApr14dPct),
    net_apr_pct_after_costs: r2(facts.netAprPct),
    owner_minimum_net_apr_pct: r2(facts.minNetAprPct),
    hours_in_a_row_above_minimum: facts.hoursAbove,
    leg_usd: r2(facts.legUsd),
    leverage: r2(facts.leverage),
    legs: facts.legs.map((l) => ({
      venue: l.venue, side: l.side, open_interest_usd: r2(l.openInterestUsd), book_depth_usd: r2(l.bookDepthUsd),
      fill_impact_bps: r2(l.fillImpactBps), price_move_24h_pct: r2(l.priceMove24hPct), days_since_listing: r2(l.daysSinceListing),
    })),
  };
  return [{ role: 'system', content: VETO_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(f) }];
}

/** The facts of a window, with what Window does not carry passed in (null where not known). */
export function vetoFacts(
  w: FundingWindow,
  extra: {
    kind: 'enter' | 'rotate'; legUsd: number; leverage: number; minNetAprPct: number; hoursAbove: number;
    grossApr14dPct?: number | null; legs?: { long?: VetoLegFacts; short?: VetoLegFacts };
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
 * How a check ended: passed or refused on a readable verdict; refused on an unreadable reply; or passed unchecked
 * (timed out, NEAR AI unavailable, no key, the key rejected).
 */
export type RiskCheckOutcome = 'passed' | 'refused' | 'unreadable' | 'timeout' | 'unavailable' | 'no-key' | 'key-rejected';

export interface VetoResult {
  veto: Veto;
  /** false = no NEAR AI risk check (no answer came): the window passes unchecked, and `line` says why. */
  checked: boolean;
  outcome: RiskCheckOutcome;
  /** The one-line reason: the model's reasons joined, or why it was not checked. */
  reason: string;
  /** How long the answer took (ms); null when no answer came. */
  latencyMs: number | null;
  /** One line for the journal: "NEAR AI passed …", "NEAR AI risk check refused …: <reason>", or "no NEAR AI risk check: <why>". */
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

/**
 * The risk check's part of a "why" line: its verdict and one-line reason, with the attestation for a reply that came
 * ("attested" or "not attested: <why>"), or why it was not checked.
 */
export function riskCheckWhy(r: Pick<VetoResult, 'outcome' | 'reason'>, attestation: string): string {
  switch (r.outcome) {
    case 'passed': return `NEAR AI risk check passed (${attestation}): ${r.reason === '' ? 'no red flag named' : r.reason}`;
    case 'refused':
    case 'unreadable': return `NEAR AI risk check refused (${attestation}): ${r.reason}`;
    case 'timeout': return 'risk check timed out: passed';
    case 'no-key': return 'no NEAR AI key: not checked';
    case 'key-rejected': return `${r.reason}: not checked, passed`;
    case 'unavailable': return `NEAR AI risk check unavailable (${r.reason}): passed`;
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

/**
 * Asks for a verdict on `facts`. Never throws. A timeout or a transport/HTTP error passes with "no NEAR AI risk check"; a
 * reply that came but is not a readable verdict (including one cut off at its token limit) is a veto, "unreadable
 * reply".
 */
export async function checkVeto(
  source: VetoSource, facts: VetoFacts, options: { now: number; timeoutMs?: number; timer?: () => number },
): Promise<VetoResult> {
  const timeoutMs = options.timeoutMs ?? LOOP_RULES.vetoTimeoutMs;
  const timer = options.timer ?? (() => performance.now());
  const unchecked = (why: string, outcome: RiskCheckOutcome): VetoResult => ({
    veto: { verdict: 'pass', reasons: [`no NEAR AI risk check: ${why}`], model: source.model, at: options.now },
    checked: false, outcome, reason: why, latencyMs: null,
    line: `no NEAR AI risk check on ${facts.symbol}: ${why}`,
    exchange: null,
  });
  const unreadable = (why: string, exchange: VetoExchange): VetoResult => ({
    veto: { verdict: 'veto', reasons: [UNREADABLE_REPLY], model: source.model, at: options.now },
    checked: true, outcome: 'unreadable', reason: `${UNREADABLE_REPLY} (${why})`, latencyMs: exchange.latencyMs ?? null,
    line: `NEAR AI risk check refused ${facts.symbol}: ${UNREADABLE_REPLY} (${why})`,
    exchange,
  });
  if (!source.configured) return unchecked('NEAR_AI_API_KEY is not set', 'no-key');
  const messages = vetoMessages(facts);
  const asked: VetoExchange = { key: promptKey(messages), model: source.model, messages, response: null };
  let completion: Completion & { latencyMs?: number };
  const started = timer();
  try {
    completion = await withTimeout(source.complete(messages, { json: true, maxTokens: MAX_TOKENS }), timeoutMs, 'NEAR AI risk check');
  } catch (err) {
    const message = errorMessage(err);
    if (!(err instanceof NearAiUnavailable) && /no answer within/.test(message)) {
      return { ...unchecked(`no answer within ${timeoutMs / 1000} s`, 'timeout'), exchange: asked };
    }
    if (err instanceof NearAiUnavailable && NO_ANSWER.some((p) => message.startsWith(p))) {
      // A bad key is no answer too, but it never heals by itself: it says so on every decision.
      const rejected = /^NEAR AI answered (HTTP 40[13]\b.*)$/s.exec(message);
      if (rejected !== null) return { ...unchecked(`NEAR AI key rejected (${rejected[1]})`, 'key-rejected'), exchange: asked };
      return { ...unchecked(message, message.startsWith('NEAR_AI_API_KEY') ? 'no-key' : 'unavailable'), exchange: asked };
    }
    // A reply came and could not be read (cut off, not a chat completion, not JSON): fail closed.
    return unreadable(message, { ...asked, latencyMs: timer() - started });
  }
  const latencyMs = completion.latencyMs ?? timer() - started;
  const exchange: VetoExchange = { ...asked, response: completion.raw, latencyMs };
  let verdict: ReturnType<typeof parseVerdict>;
  try {
    verdict = verdictFromReply(completion.content);
  } catch (err) {
    return unreadable(errorMessage(err), exchange);
  }
  const veto: Veto = { verdict: verdict.verdict, reasons: verdict.reasons, model: source.model, at: options.now };
  const line = verdict.verdict === 'veto'
    ? `NEAR AI risk check refused ${facts.symbol}: ${verdict.reasons.join('; ')}`
    : `NEAR AI passed ${facts.symbol}${verdict.reasons.length === 0 ? '' : `: ${verdict.reasons.join('; ')}`}`;
  return {
    veto, checked: true, outcome: verdict.verdict === 'veto' ? 'refused' : 'passed', reason: verdict.reasons.join('; '), latencyMs, line, exchange,
  };
}

/**
 * Plays recorded veto exchanges back, found by their prompt: no key, no network. A prompt with no recording is
 * NearAiUnavailable, so checkVeto passes it with "no NEAR AI risk check".
 */
export class RecordedVeto implements VetoSource {
  readonly configured = true;
  readonly model: string;
  readonly #byKey: Map<string, VetoExchange>;

  constructor(exchanges: readonly VetoExchange[], model = NEAR_AI_MODEL) {
    this.model = model;
    // An exchange with no answer recorded plays back as no answer. A later answer to the same prompt wins.
    this.#byKey = new Map(exchanges.filter((e) => e.response !== null && e.response !== undefined).map((e) => [e.key, e]));
  }

  /** A recording file: `{ "exchanges": VetoExchange[] }` (other keys, like `_comment`, are ignored). */
  static fromFile(path: string): RecordedVeto {
    return RecordedVeto.fromFiles([path]);
  }

  /** Several recordings, in order: a later file's answer to a prompt replaces an earlier one's. */
  static fromFiles(paths: readonly string[]): RecordedVeto {
    return new RecordedVeto(paths.flatMap((path) => readExchanges(path)));
  }

  /** Prompts with a recorded answer. */
  get size(): number {
    return this.#byKey.size;
  }

  async complete(messages: readonly ChatMessage[]): Promise<Completion & { latencyMs?: number }> {
    const e = this.#byKey.get(promptKey(messages));
    if (e === undefined) throw new NearAiUnavailable('no recorded NEAR AI risk check reply for this prompt');
    return { content: completionContent(e.response), raw: e.response, ...(typeof e.latencyMs === 'number' ? { latencyMs: e.latencyMs } : {}) };
  }
}

/** The exchanges of a recording file: `{ "exchanges": VetoExchange[] }`. */
export function readExchanges(path: string): VetoExchange[] {
  const body = JSON.parse(readFileSync(path, 'utf8')) as { exchanges?: VetoExchange[] };
  if (!Array.isArray(body.exchanges)) throw new Error(`${path}: no "exchanges" list`);
  return body.exchanges;
}
