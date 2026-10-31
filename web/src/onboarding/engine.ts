// The engine calls onboarding makes (docs/interfaces.md §2): `POST /policy/draft`, `PUT /strategy` and `POST /setup`.
// `OnboardingEngine` is the seam: the page sees only this, the fake and the engine look alike to it, and the
// engine's side is built in parallel to the shapes in shared/src/types.ts.
import type { ContractPolicy, PolicyDraft, StrategyConfig } from '@gimbal/shared';
import { parseStrategy, REQUEST_TIMEOUT_MS } from '../stream/api.ts';

/** The engine's own words for a refusal or an outage, kept as they came. */
export class EngineError extends Error {
  override name = 'EngineError';
}

/** `POST /policy/draft` answered 503: NEAR AI is not available, so the owner fills the form by hand (§2, NEAR AI rule). */
export class DraftUnavailable extends EngineError {
  override name = 'DraftUnavailable';
}

/** The engine did not answer in time or at all: nothing was applied. */
export class EngineSilent extends EngineError {
  override name = 'EngineSilent';
}

export interface OnboardingEngine {
  /** NEAR AI turns the owner's words into a draft. Nothing is applied. Rejects with `DraftUnavailable` on 503. */
  draftPolicy(text: string): Promise<PolicyDraft>;
  /** Saves the confirmed engine rules; resolves with what the engine now holds, rejects with its reason on a 400. */
  putStrategy(strategy: StrategyConfig): Promise<StrategyConfig>;
  /** Starts venue setup for a desk; progress arrives as `setup` stream events. Rejects with the engine's reason. */
  startSetup(deskId: string): Promise<void>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === 'string';

/** Checks the `policy` of a draft; throws with the first thing wrong. A policy without `unpriced` has none. */
export function parsePolicy(value: unknown): ContractPolicy {
  if (!isObject(value)) throw new Error('policy: not an object');
  const list = (name: string): unknown[] => {
    const v = value[name];
    if (!Array.isArray(v)) throw new Error(`policy: ${name} is not a list`);
    return v;
  };
  const num = (name: string): number => {
    const v = value[name];
    if (!isNumber(v)) throw new Error(`policy: ${name} is not a number`);
    return v;
  };
  return {
    hl_assets: list('hl_assets').map((a, i) => {
      if (!isObject(a) || !isNumber(a.index) || !isText(a.symbol) || !isNumber(a.sz_decimals)) throw new Error(`policy: hl_assets[${i}] needs index, symbol and sz_decimals`);
      return { index: a.index, symbol: a.symbol, sz_decimals: a.sz_decimals };
    }),
    phoenix_markets: list('phoenix_markets').map((m, i) => {
      if (!isObject(m) || !isText(m.symbol) || !isText(m.orderbook) || !isNumber(m.base_lot_e8) || !isNumber(m.tick_e8)) {
        throw new Error(`policy: phoenix_markets[${i}] needs symbol, orderbook, base_lot_e8 and tick_e8`);
      }
      return { symbol: m.symbol, orderbook: m.orderbook, base_lot_e8: m.base_lot_e8, tick_e8: m.tick_e8 };
    }),
    orderly_symbols: list('orderly_symbols').map((s, i) => {
      if (!isText(s)) throw new Error(`policy: orderly_symbols[${i}] is not text`);
      return s;
    }),
    max_notional_usd: num('max_notional_usd'),
    price_band_bps: num('price_band_bps'),
    oracle_max_age_s: num('oracle_max_age_s'),
    rescue_cap_usd_per_hour: num('rescue_cap_usd_per_hour'),
    max_transfer_cost_bps: num('max_transfer_cost_bps'),
    max_transfer_cost_flat_e6: num('max_transfer_cost_flat_e6'),
    unpriced: (value.unpriced === undefined ? [] : list('unpriced')).map((u, i) => {
      if (!isObject(u) || !isText(u.symbol) || !isText(u.max_sz)) throw new Error(`policy: unpriced[${i}] needs symbol and max_sz`);
      return { symbol: u.symbol, max_sz: u.max_sz };
    }),
    unpriced_max_notional_usd: value.unpriced_max_notional_usd === undefined ? 0 : num('unpriced_max_notional_usd'),
  };
}

/** Checks the body of `POST /policy/draft`: a `PolicyDraft`. */
export function parsePolicyDraft(value: unknown): PolicyDraft {
  if (!isObject(value)) throw new Error('POST /policy/draft: not an object');
  const { notes, model } = value;
  if (!Array.isArray(notes) || !notes.every(isText)) throw new Error('POST /policy/draft: notes is not a list of text');
  if (!isText(model)) throw new Error('POST /policy/draft: model is not text');
  return { policy: parsePolicy(value.policy), strategy: parseStrategy(value.strategy), notes, model };
}

/** The reason an answer gives for a refusal: `error`, or `reason`, else the status. */
function reasonOf(body: unknown, status: number): string {
  if (isObject(body)) {
    for (const key of ['error', 'reason'] as const) {
      const text = body[key];
      if (isText(text) && text.trim() !== '') return text.trim();
    }
  }
  return `the engine answered ${status}`;
}

async function call(method: 'POST' | 'PUT', url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new EngineSilent(`${method} ${url}: the engine did not answer in ${REQUEST_TIMEOUT_MS / 1000} s`);
  }
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** The real engine, through the dev proxy or the same origin in production. */
export function httpOnboardingEngine(base = ''): OnboardingEngine {
  return {
    async draftPolicy(text) {
      const { status, body } = await call('POST', `${base}/policy/draft`, { text });
      if (status === 503) throw new DraftUnavailable(reasonOf(body, status));
      if (status >= 300) throw new EngineError(reasonOf(body, status));
      return parsePolicyDraft(body);
    },
    async putStrategy(strategy) {
      const { status, body } = await call('PUT', `${base}/strategy`, strategy);
      if (status >= 300) throw new EngineError(reasonOf(body, status));
      return parseStrategy(body);
    },
    async startSetup(deskId) {
      const { status, body } = await call('POST', `${base}/setup`, { deskId });
      // The engine answers `{ ok: true }` or `{ ok: false, reason }` like /rotate and /close, or `{ error }` when it refuses
      // the request itself; a plain 2xx with no body counts as started.
      if (status >= 300 || (isObject(body) && body.ok === false)) throw new EngineError(reasonOf(body, status));
    },
  };
}
