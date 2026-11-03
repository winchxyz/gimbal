// The NEAR AI veto before an enter or a rotate (docs/interfaces.md §3 "Strategy loop"): the window's facts go to the
// same client, endpoint, key and model as POST /policy/draft, and the model answers {verdict: 'pass' | 'veto',
// reasons}, before every enter and every rotate. A veto can only remove a window: nothing the model says changes the
// window, the size or the leverage, or is sent to the contract or a venue. No key, no
// answer within LOOP_RULES.vetoTimeoutMs, NEAR AI down, or a reply that is not a verdict: the window passes, and the
// journal line says "no veto check".
//
// The prompt is built from the facts alone (no clock, no ids that change between runs), so a recorded exchange is
// found again by its prompt: RecordedVeto plays a recording back without a key (replay mode, tests). checkVeto returns
// the exchange it made, for loop.ts to record.

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
  complete(messages: readonly ChatMessage[], options?: { json?: boolean; maxTokens?: number }): Promise<Completion>;
}

export interface VetoLeg {
  venue: string;
  side: 'long' | 'short';
  openInterestUsd: number | null;   // the leg market's open interest (scanner.carry(id).long/short.oiUsd)
  bookDepthUsd: number | null;      // USD on the side the leg fills within the book levels read; null = not known
}

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
  priceMove24hPct: number | null;   // the mark's move over 24 h, signed
  daysSinceListing: number | null;  // of the younger leg market, where a venue says
}

/** The most reasons kept from a reply, and the longest. */
const MAX_REASONS = 3;
const MAX_REASON_TEXT = 200;
/** A verdict is a few dozen tokens. */
const MAX_TOKENS = 300;

export const VETO_SYSTEM_PROMPT = `You review one funding-rate carry trade before an automated desk opens it. The desk holds a long perpetual leg on one venue and a short perpetual leg of the same asset on another, and earns the difference in funding. You cannot approve, size or change the trade: you can only veto it. The trade goes ahead unless you veto it.

Veto only on a concrete red flag in the facts, for example:
- the funding spread this hour is far above its 7-day mean, so it looks like a spike that will not last;
- the 7-day and 14-day spreads disagree, or the spread is shrinking fast;
- a leg's open interest is small next to the leg size, or its book cannot fill the leg;
- the price moved more than 15 % in 24 hours, so a leg is near liquidation risk;
- the market was listed less than 14 days ago.
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
    legs: facts.legs.map((l) => ({ venue: l.venue, side: l.side, open_interest_usd: r2(l.openInterestUsd), book_depth_usd: r2(l.bookDepthUsd) })),
    price_move_24h_pct: r2(facts.priceMove24hPct),
    days_since_listing: r2(facts.daysSinceListing),
  };
  return [{ role: 'system', content: VETO_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(f) }];
}

/** The facts of a window, with what Window does not carry passed in (null where not known). */
export function vetoFacts(
  w: FundingWindow,
  extra: {
    kind: 'enter' | 'rotate'; legUsd: number; leverage: number; minNetAprPct: number; hoursAbove: number;
    grossApr14dPct?: number | null; legs?: { long: Partial<Pick<VetoLeg, 'openInterestUsd' | 'bookDepthUsd'>>; short: Partial<Pick<VetoLeg, 'openInterestUsd' | 'bookDepthUsd'>> };
    priceMove24hPct?: number | null; daysSinceListing?: number | null;
  },
): VetoFacts {
  const leg = (venue: string, side: 'long' | 'short', x: Partial<Pick<VetoLeg, 'openInterestUsd' | 'bookDepthUsd'>> | undefined): VetoLeg => ({
    venue, side, openInterestUsd: x?.openInterestUsd ?? null, bookDepthUsd: x?.bookDepthUsd ?? null,
  });
  return {
    kind: extra.kind, symbol: w.symbol, longVenue: w.longVenue, shortVenue: w.shortVenue,
    grossAprPct: w.grossAprPct, grossApr7dPct: w.grossApr7dPct, grossApr14dPct: extra.grossApr14dPct ?? null,
    netAprPct: w.netAprPct, minNetAprPct: extra.minNetAprPct, hoursAbove: extra.hoursAbove,
    legUsd: extra.legUsd, leverage: extra.leverage,
    legs: [leg(w.longVenue, 'long', extra.legs?.long), leg(w.shortVenue, 'short', extra.legs?.short)],
    priceMove24hPct: extra.priceMove24hPct ?? null, daysSinceListing: extra.daysSinceListing ?? null,
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
}

export interface VetoResult {
  veto: Veto;
  /** false = no veto check: the window passes unchecked, and `line` says why. */
  checked: boolean;
  /** One line for the journal: "NEAR AI passed …", "NEAR AI vetoed …: <reason>", or "no veto check: <why>". */
  line: string;
  /** What was asked and what came back; null only when nothing was asked (no key). */
  exchange: VetoExchange | null;
}

/**
 * The exchange as JournalEntry.numbers keys (strings): vetoModel, vetoKey, vetoPrompt (the facts sent: the system
 * prompt is fixed and named by the key) and vetoReply (the model's text as it came, or "" when none came back).
 */
export function vetoJournalNumbers(e: VetoExchange): Record<string, string> {
  let reply = '';
  try {
    reply = e.response === null ? '' : completionContent(e.response);
  } catch {
    reply = JSON.stringify(e.response);
  }
  return { vetoModel: e.model, vetoKey: e.key, vetoPrompt: e.messages.at(-1)?.content ?? '', vetoReply: reply };
}

/** The key a prompt is recorded under. */
export function promptKey(messages: readonly ChatMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 24);
}

/** The model's answer as a verdict; NearAiUnavailable when it is not one. */
export function parseVerdict(value: Record<string, unknown>): { verdict: 'pass' | 'veto'; reasons: string[] } {
  const v = value.verdict;
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

/**
 * Asks for a verdict on `facts`. Never throws: every way it cannot get one is a pass with "no veto check".
 */
export async function checkVeto(
  source: VetoSource, facts: VetoFacts, options: { now: number; timeoutMs?: number },
): Promise<VetoResult> {
  const timeoutMs = options.timeoutMs ?? LOOP_RULES.vetoTimeoutMs;
  const unchecked = (why: string): VetoResult => ({
    veto: { verdict: 'pass', reasons: [`no veto check: ${why}`], model: source.model, at: options.now },
    checked: false,
    line: `no veto check on ${facts.symbol}: ${why}`,
    exchange: null,
  });
  if (!source.configured) return unchecked('NEAR_AI_API_KEY is not set');
  const messages = vetoMessages(facts);
  const asked: VetoExchange = { key: promptKey(messages), model: source.model, messages, response: null };
  let completion: Completion;
  try {
    completion = await withTimeout(source.complete(messages, { json: true, maxTokens: MAX_TOKENS }), timeoutMs, 'NEAR AI veto');
  } catch (err) {
    const why = err instanceof NearAiUnavailable ? err.message : /no answer within/.test(errorMessage(err)) ? `no answer within ${timeoutMs / 1000} s` : errorMessage(err);
    return { ...unchecked(why), exchange: asked };
  }
  const exchange: VetoExchange = { ...asked, response: completion.raw };
  let verdict: ReturnType<typeof parseVerdict>;
  try {
    verdict = parseVerdict(parseJsonObject(completion.content));
  } catch (err) {
    return { ...unchecked(errorMessage(err)), exchange };
  }
  const veto: Veto = { verdict: verdict.verdict, reasons: verdict.reasons, model: source.model, at: options.now };
  const line = verdict.verdict === 'veto'
    ? `NEAR AI vetoed ${facts.symbol}: ${verdict.reasons.join('; ')}`
    : `NEAR AI passed ${facts.symbol}${verdict.reasons.length === 0 ? '' : `: ${verdict.reasons.join('; ')}`}`;
  return { veto, checked: true, line, exchange };
}

/**
 * Plays recorded veto exchanges back, found by their prompt: no key, no network. A prompt with no recording is
 * NearAiUnavailable, so checkVeto passes it with "no veto check".
 */
export class RecordedVeto implements VetoSource {
  readonly configured = true;
  readonly model: string;
  readonly #byKey: Map<string, unknown>;

  constructor(exchanges: readonly VetoExchange[], model = NEAR_AI_MODEL) {
    this.model = model;
    // An exchange with no answer recorded plays back as no answer.
    this.#byKey = new Map(exchanges.filter((e) => e.response !== null && e.response !== undefined).map((e) => [e.key, e.response]));
  }

  /** A recording file: `{ "exchanges": VetoExchange[] }` (other keys, like `_comment`, are ignored). */
  static fromFile(path: string): RecordedVeto {
    const body = JSON.parse(readFileSync(path, 'utf8')) as { exchanges?: VetoExchange[] };
    if (!Array.isArray(body.exchanges)) throw new Error(`${path}: no "exchanges" list`);
    return new RecordedVeto(body.exchanges);
  }

  async complete(messages: readonly ChatMessage[]): Promise<Completion> {
    const raw = this.#byKey.get(promptKey(messages));
    if (raw === undefined) throw new NearAiUnavailable('no recorded veto reply for this prompt');
    return { content: completionContent(raw), raw };
  }
}
