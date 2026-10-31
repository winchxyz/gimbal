// POST /policy/draft { text } -> PolicyDraft (docs/interfaces.md §2). The server registers the route and does the
// HTTP; this module reads the body, asks the drafter and says which status to answer:
//   200 the draft (nothing is applied: the owner signs set_policy and confirms the engine rules with PUT /strategy)
//   400 a body that is not { text } with 1 to MAX_DRAFT_TEXT characters
//   503 drafting is unavailable: no NEAR_AI_API_KEY, NEAR AI did not answer, or it answered something that is not a
//       draft; `error` says which, so the dashboard can say drafting is off
// The drafter asks the model and reads the desk venues' market lists at the same time: the venue entries of the
// policy come from those lists (policy-draft.ts).

import type { PolicyDraft, VenueId } from '@gimbal/shared';
import { withTimeout } from '../scanner/scanner.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Market, VenueReader } from '../venues/venue.ts';
import type { NearAiClient } from './client.ts';
import { NearAiUnavailable } from './client.ts';
import type { DeskMarkets } from './policy-draft.ts';
import { buildPolicyDraft, draftMessages, parseDraftAnswer } from './policy-draft.ts';

/** Longest owner text a draft takes: a few sentences of rules, not a document. */
export const MAX_DRAFT_TEXT = 2_000;
/** Market lists change only with a listing: one read serves drafts for this long. */
const MARKETS_TTL_MS = 10 * 60_000;
const MARKETS_TIMEOUT_MS = 8_000;

export type MarketsSource = () => Promise<DeskMarkets>;

/**
 * The desk venues' market lists, read on demand and kept for `ttlMs`; a venue that fails is read again on the next
 * draft. Replay recordings without a `markets` answer simply fail here, and the draft says so in its notes.
 */
export function deskMarkets(
  venues: readonly VenueReader[], options: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {},
): MarketsSource {
  const ttl = options.ttlMs ?? MARKETS_TTL_MS;
  const timeout = options.timeoutMs ?? MARKETS_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const kept = new Map<VenueId, { at: number; markets: readonly Market[] }>();
  return async () => {
    const out: DeskMarkets = { markets: {}, failed: {} };
    await Promise.all(venues.map(async (v) => {
      const hit = kept.get(v.id);
      if (hit !== undefined && now() - hit.at < ttl) {
        out.markets[v.id] = hit.markets;
        return;
      }
      try {
        const markets = await withTimeout(v.markets(), timeout, `${v.id} markets`);
        kept.set(v.id, { at: now(), markets });
        out.markets[v.id] = markets;
      } catch (err) {
        out.failed[v.id] = errorMessage(err);
      }
    }));
    return out;
  };
}

export interface PolicyDrafterOptions {
  client: NearAiClient;
  markets: MarketsSource;
}

/** The owner's words -> a PolicyDraft, through NEAR AI. Throws NearAiUnavailable when it cannot draft. */
export class PolicyDrafter {
  readonly #client: NearAiClient;
  readonly #markets: MarketsSource;

  constructor(options: PolicyDrafterOptions) {
    this.#client = options.client;
    this.#markets = options.markets;
  }

  get model(): string {
    return this.#client.model;
  }

  /** Whether a key is set; without one every draft is NearAiUnavailable. */
  get configured(): boolean {
    return this.#client.configured;
  }

  async draft(text: string): Promise<PolicyDraft> {
    if (!this.#client.configured) throw new NearAiUnavailable('NEAR_AI_API_KEY is not set');
    const [reply, markets] = await Promise.all([this.#client.completeJson(draftMessages(text)), this.#markets()]);
    return buildPolicyDraft(parseDraftAnswer(reply.value), { ownerText: text, markets, model: this.#client.model });
  }
}

export interface RouteAnswer {
  status: number;
  body: unknown;
}

/**
 * POST /policy/draft: `read` gives the request body. A drafter of null means NEAR AI is not set up at all. Errors
 * other than NearAiUnavailable are bugs and are thrown to the server (500).
 */
export async function policyDraftRoute(
  read: () => Promise<string>, drafter: Pick<PolicyDrafter, 'draft'> | null, log?: (line: string) => void,
): Promise<RouteAnswer> {
  const bad = (error: string): RouteAnswer => ({ status: 400, body: { error } });
  let body: unknown;
  try {
    body = JSON.parse(await read());
  } catch (err) {
    return bad(`POST /policy/draft: ${errorMessage(err)}`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('POST /policy/draft takes { "text": "<your rules>" }');
  const extra = Object.keys(body).filter((k) => k !== 'text');
  if (extra.length > 0) return bad(`POST /policy/draft: unknown field ${extra[0]}`);
  const text = (body as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim() === '') return bad('POST /policy/draft: text must be your rules in words');
  if (text.length > MAX_DRAFT_TEXT) return bad(`POST /policy/draft: text is ${text.length} characters, over ${MAX_DRAFT_TEXT}`);
  if (drafter === null) return { status: 503, body: { error: 'drafting is unavailable: NEAR AI is not set up' } };
  try {
    return { status: 200, body: await drafter.draft(text.trim()) };
  } catch (err) {
    if (!(err instanceof NearAiUnavailable)) throw err;
    log?.(`POST /policy/draft: drafting unavailable: ${err.message}`);
    return { status: 503, body: { error: `drafting is unavailable: ${err.message}` } };
  }
}
