// NEAR AI Cloud's chat completions (OpenAI-compatible), for the parts of Gimbal a model may help with: policy
// drafts (policy-draft.ts) and, later, journal text. The model drafts and refuses, never acts (docs/interfaces.md
// §2, "NEAR AI rule"): nothing returned here goes to the contract or a venue.
//
// Every way NEAR AI can fail, including no key at all, is one error type, NearAiUnavailable, whose message says why
// in one line: the HTTP side answers 503 with it, so the dashboard says drafting is unavailable. The key travels only
// in the Authorization header and is cut from every text this module builds (redactSecret).

import { redactSecret } from '../redact.ts';
import { errorMessage } from '../venues/recorder.ts';

export const NEAR_AI_URL = 'https://cloud-api.near.ai/v1/chat/completions';
/** A NEAR AI Cloud TEE model with JSON output, no reasoning, ~1 s (docs/interfaces.md §2). */
export const NEAR_AI_MODEL = 'Qwen/Qwen3-VL-30B-A3B-Instruct';
const DEFAULT_TIMEOUT_MS = 20_000;
/** A draft is a few hundred tokens; the cap bounds the time and cost of a reply that runs on. */
const DEFAULT_MAX_TOKENS = 1_024;
/** Characters of an error body quoted in the reason. */
const ERROR_EXCERPT = 200;

/** NEAR AI could not give an answer: no key, no answer, an HTTP error, or a reply that is not what was asked for. */
export class NearAiUnavailable extends Error {
  override name = 'NearAiUnavailable';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface NearAiClientOptions {
  /** NEAR_AI_API_KEY; undefined or empty = not configured, and every call throws NearAiUnavailable. */
  apiKey: string | undefined;
  url?: string;
  model?: string;
  /** Requests go through this fetch (tests, the recorder) instead of the global one. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface Completion {
  /** The assistant message's text. */
  content: string;
  /** The whole response body as NEAR AI sent it (the recorder writes it to a fixture). */
  raw: unknown;
}

export class NearAiClient {
  readonly model: string;
  readonly url: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: NearAiClientOptions) {
    const key = options.apiKey?.trim();
    this.#apiKey = key === undefined || key === '' ? undefined : key;
    this.url = options.url ?? NEAR_AI_URL;
    this.model = options.model ?? NEAR_AI_MODEL;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Whether a key is set (it says nothing about whether NEAR AI answers). */
  get configured(): boolean {
    return this.#apiKey !== undefined;
  }

  /** One completion at temperature 0; `json` asks for a JSON object (response_format json_object). */
  async complete(messages: readonly ChatMessage[], options: { json?: boolean; maxTokens?: number } = {}): Promise<Completion> {
    const key = this.#apiKey;
    if (key === undefined) throw new NearAiUnavailable('NEAR_AI_API_KEY is not set');
    const body = {
      model: this.model,
      messages,
      temperature: 0,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(options.json === true ? { response_format: { type: 'json_object' } } : {}),
    };
    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const why = err instanceof Error && err.name === 'TimeoutError' ? `no answer within ${this.#timeoutMs / 1000} s` : errorMessage(err);
      throw new NearAiUnavailable(redactSecret(`NEAR AI did not answer: ${why}`, key));
    }
    if (!res.ok) {
      const excerpt = errorExcerpt(text);
      throw new NearAiUnavailable(redactSecret(`NEAR AI answered HTTP ${res.status}${excerpt === '' ? '' : `: ${excerpt}`}`, key));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new NearAiUnavailable('NEAR AI answered something that is not JSON');
    }
    return { content: completionContent(raw), raw };
  }

  /** A completion whose text must be one JSON object; anything else is NearAiUnavailable. */
  async completeJson(messages: readonly ChatMessage[], options: { maxTokens?: number } = {}): Promise<{ value: Record<string, unknown>; raw: unknown }> {
    const { content, raw } = await this.complete(messages, { ...options, json: true });
    return { value: parseJsonObject(content), raw };
  }
}

/** The assistant text of a chat-completions body; NearAiUnavailable when the body is not one. */
export function completionContent(raw: unknown): string {
  const choice = isObject(raw) && Array.isArray(raw.choices) ? raw.choices[0] : undefined;
  const message = isObject(choice) ? choice.message : undefined;
  const content = isObject(message) ? message.content : undefined;
  if (typeof content !== 'string') throw new NearAiUnavailable('NEAR AI\'s answer is not a chat completion (no choices[0].message.content)');
  // A reply cut at max_tokens is not the whole answer, whatever it looks like.
  if (isObject(choice) && choice.finish_reason === 'length') throw new NearAiUnavailable('the model\'s reply was cut off at its token limit');
  return content;
}

/** `text` as one JSON object; NearAiUnavailable when it is not JSON, or JSON of another kind. */
export function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new NearAiUnavailable('the model\'s reply is not JSON');
  }
  if (!isObject(value)) throw new NearAiUnavailable('the model\'s reply is JSON but not an object');
  return value;
}

/** What an error body says, short: OpenAI-style `error.message`, else `detail` or `message`, else nothing. */
function errorExcerpt(text: string): string {
  let said: unknown;
  try {
    const body: unknown = JSON.parse(text);
    if (isObject(body)) {
      said = isObject(body.error) ? body.error.message : body.error;
      if (typeof said !== 'string') said = typeof body.detail === 'string' ? body.detail : body.message;
    }
  } catch {
    return '';
  }
  if (typeof said !== 'string') return '';
  const line = said.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return line.length > ERROR_EXCERPT ? `${line.slice(0, ERROR_EXCERPT)}…` : line;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
