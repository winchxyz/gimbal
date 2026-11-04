// The engine's HTTP side (docs/interfaces.md §2) as the screens use it: `GET /strategy`, `GET /windows/history?id=`,
// `GET /state`, `GET /journal?before=`, `POST /rotate`, `POST /close` and `POST /stress`. This is the seam: a screen only sees
// `EngineApi`, so the fake and the engine look alike to it, and `engineApi()` in start.ts picks one. Pure apart from
// `fetch`, so the parsers are tested.
import type { EngineState, JournalEntry, Mode, StrategyConfig, WindowHistory } from '@gimbal/shared';
import { KINDS } from '../journal/kinds.ts';
import { isStreamData, type StreamType } from './store.ts';

/** What `POST /rotate` and `POST /close` answer at once: done, or refused with the reason a check gave. */
export type ActionResult = { ok: true } | { ok: false; reason: string };

export interface EngineApi {
  /** The owner's engine rules, as `GET /strategy` returns them. */
  strategy(): Promise<StrategyConfig>;
  /** Hourly net APR of one window over the last 7 days. Rejects when the engine has no history for it. */
  windowHistory(id: string): Promise<WindowHistory>;
  /** The most recent journal entries the engine holds (`EngineState.journal`), newest first, at most 100. */
  journal(): Promise<JournalEntry[]>;
  /** Up to 100 entries older than `before`, newest first; `[]` past the oldest or for an id the engine no longer holds. */
  journalBefore(before: string): Promise<JournalEntry[]>;
  /** Manual override: close the held window and open this one. Rejects when the engine does not answer. */
  rotate(windowId: string): Promise<ActionResult>;
  /** Close both legs with reduce-only orders. Rejects when the engine does not answer. */
  close(): Promise<ActionResult>;
  /** Testnet and replay only: tighten the margin threshold so a leg crosses the rescue line. Rejects when the engine does not answer. */
  stress(): Promise<ActionResult>;
}

/** How many entries the engine sends per page (`GET /state`, `GET /journal?before=`): a shorter page is the last. */
export const JOURNAL_PAGE = 100;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Checks the body of `GET /strategy`; throws with what is wrong, so the screen can say so. */
export function parseStrategy(value: unknown): StrategyConfig {
  if (!isObject(value)) throw new Error('GET /strategy: not an object');
  const { auto, minNetAprPct, legUsd, maxLeverage, stopDrawdownPct, rotate, risk } = value;
  if (typeof auto !== 'boolean') throw new Error('GET /strategy: auto is not a boolean');
  if (!isNumber(minNetAprPct)) throw new Error('GET /strategy: minNetAprPct is not a number');
  if (!isNumber(legUsd)) throw new Error('GET /strategy: legUsd is not a number');
  if (!isNumber(maxLeverage)) throw new Error('GET /strategy: maxLeverage is not a number');
  if (stopDrawdownPct !== null && !isNumber(stopDrawdownPct)) throw new Error('GET /strategy: stopDrawdownPct is neither a number nor null');
  if (!isObject(rotate) || !isNumber(rotate.minGainPts) || !isNumber(rotate.forHours)) {
    throw new Error('GET /strategy: rotate needs minGainPts and forHours');
  }
  if (!isObject(risk) || !isNumber(risk.watchDistancePct) || !isNumber(risk.rescueDistancePct)) {
    throw new Error('GET /strategy: risk needs watchDistancePct and rescueDistancePct');
  }
  return {
    auto, minNetAprPct, legUsd, maxLeverage, stopDrawdownPct,
    rotate: { minGainPts: rotate.minGainPts, forHours: rotate.forHours },
    risk: { watchDistancePct: risk.watchDistancePct, rescueDistancePct: risk.rescueDistancePct },
  };
}

/** Checks the body of `GET /windows/history`; the points are returned oldest first whatever the order sent. */
export function parseHistory(value: unknown): WindowHistory {
  if (!isObject(value)) throw new Error('GET /windows/history: not an object');
  const { windowId, points } = value;
  if (typeof windowId !== 'string') throw new Error('GET /windows/history: windowId is not a string');
  if (!Array.isArray(points)) throw new Error('GET /windows/history: points is not an array');
  const clean = points.map((p: unknown) => {
    if (!isObject(p) || !isNumber(p.t) || !isNumber(p.netAprPct)) throw new Error('GET /windows/history: a point has no t and netAprPct');
    return { t: p.t, netAprPct: p.netAprPct };
  });
  return { windowId, points: clean.sort((a, b) => a.t - b.t) };
}

const CHAINS = ['near', 'hyperliquid', 'solana', 'arbitrum'] as const;

/** Checks a list of journal entries; `source` names where it came from, so an error says what to look at. */
function parseEntries(list: unknown[], source: string): JournalEntry[] {
  return list.map((item: unknown, at) => {
    const where = `${source}[${at}]`;
    if (!isObject(item)) throw new Error(`${where} is not an object`);
    const { id, t, kind, summary, why, numbers, tx } = item;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${where} has no id`);
    if (!isNumber(t)) throw new Error(`${where} has no time`);
    if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) throw new Error(`${where} has an unknown kind`);
    if (typeof summary !== 'string') throw new Error(`${where} has no summary`);
    if (why !== undefined && typeof why !== 'string') throw new Error(`${where} has a why that is not text`);
    if (!isObject(numbers)) throw new Error(`${where} has no numbers`);
    const clean: Record<string, number | string> = {};
    for (const [key, number] of Object.entries(numbers)) {
      if (typeof number === 'string' || isNumber(number)) clean[key] = number;
      else throw new Error(`${where} has a number named ${key} that is neither a number nor text`);
    }
    if (!Array.isArray(tx)) throw new Error(`${where} has no transactions list`);
    const refs = tx.map((ref: unknown) => {
      if (!isObject(ref) || typeof ref.id !== 'string' || typeof ref.url !== 'string' || !(CHAINS as readonly unknown[]).includes(ref.chain)) {
        throw new Error(`${where} has a transaction without chain, id and url`);
      }
      return { chain: ref.chain as (typeof CHAINS)[number], id: ref.id, url: ref.url };
    });
    return { id, t, kind: kind as JournalEntry['kind'], summary, ...(why === undefined ? {} : { why }), numbers: clean, tx: refs };
  });
}

/** Checks the `journal` of `GET /state`; throws with what is wrong, so the screen can say so. */
export function parseJournal(value: unknown): JournalEntry[] {
  if (!isObject(value)) throw new Error('GET /state: not an object');
  const { journal } = value;
  if (!Array.isArray(journal)) throw new Error('GET /state: journal is not an array');
  return parseEntries(journal, 'GET /state: journal');
}

/** Checks the body of `GET /journal?before=`: a list of entries, possibly empty. */
export function parseJournalPage(value: unknown): JournalEntry[] {
  if (!Array.isArray(value)) throw new Error('GET /journal: not an array');
  return parseEntries(value, 'GET /journal: entry');
}

const MODES: readonly string[] = ['replay', 'testnet', 'mainnet'] satisfies Mode[];
const STATE_SLOTS = ['windows', 'scan', 'desk', 'rescue', 'setup', 'health', 'decision'] as const satisfies readonly StreamType[];

/**
 * Checks the body of `GET /state`. The journal is read entry by entry and the strategy field by field; each of the
 * other latest values only has its envelope checked (a list for `windows`, an object for the rest), as an SSE
 * message does: the engine is typed against the same shared types. `null` is "not produced yet".
 */
export function parseEngineState(value: unknown): EngineState {
  if (!isObject(value)) throw new Error('GET /state: not an object');
  const { mode, strategy, at } = value;
  if (typeof mode !== 'string' || !MODES.includes(mode)) throw new Error('GET /state: mode is not replay, testnet or mainnet');
  if (!isNumber(at)) throw new Error('GET /state: at is not a number');
  const slots: Record<string, unknown> = {};
  for (const slot of STATE_SLOTS) {
    const data = value[slot] ?? null;
    if (data !== null && !isStreamData(slot, data)) {
      throw new Error(`GET /state: ${slot} is not ${slot === 'windows' ? 'a list' : 'an object'}`);
    }
    slots[slot] = data;
  }
  return {
    mode: mode as Mode,
    at,
    strategy: strategy === null || strategy === undefined ? null : parseStrategy(strategy),
    journal: parseJournal(value),
    ...slots,
  } as EngineState;
}

const NO_REASON = 'the engine did not say why';

/**
 * Reads the answer to `POST /rotate` or `POST /close` (`{ ok: true }` or `{ ok: false, reason }`). The engine's own
 * refusals of a request (`{ error }`: a foreign origin, a body that is not JSON) are read as refusals too. Anything
 * else is not an answer, and throws.
 */
export function parseActionResult(status: number, body: unknown, route: string): ActionResult {
  if (isObject(body)) {
    if (body.ok === true && status < 300) return { ok: true };
    if (body.ok === false) {
      const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : NO_REASON;
      return { ok: false, reason };
    }
    if (typeof body.error === 'string' && body.error.trim() !== '') return { ok: false, reason: body.error.trim() };
  }
  throw new Error(`POST ${route}: ${status} and no { ok } in the answer`);
}

/** How long a request waits for the engine before it counts as not answering. */
export const REQUEST_TIMEOUT_MS = 10_000;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GET ${url.split('?')[0]}: ${response.status}`);
  return response.json();
}

async function postJson(url: string, body: unknown): Promise<ActionResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`POST ${url}: the engine did not answer`);
  }
  const answer: unknown = await response.json().catch(() => null);
  return parseActionResult(response.status, answer, url);
}

/** `GET /state`: what the stream seeds from each time it connects. */
export async function readEngineState(base = ''): Promise<EngineState> {
  return parseEngineState(await getJson(`${base}/state`));
}

/** The four reads, over any way of getting JSON by path: the local engine's, or the remote view's with its token. */
export function readApi(get: (path: string) => Promise<unknown>): Pick<EngineApi, 'strategy' | 'windowHistory' | 'journal' | 'journalBefore'> {
  return {
    strategy: async () => parseStrategy(await get('/strategy')),
    windowHistory: async (id) => parseHistory(await get(`/windows/history?id=${encodeURIComponent(id)}`)),
    journal: async () => parseJournal(await get('/state')),
    journalBefore: async (before) => parseJournalPage(await get(`/journal?before=${encodeURIComponent(before)}`)),
  };
}

/** The real engine, through the dev proxy or the same origin in production. */
export function httpApi(base = ''): EngineApi {
  return {
    ...readApi((path) => getJson(`${base}${path}`)),
    rotate: (windowId) => postJson(`${base}/rotate`, { windowId }),
    close: () => postJson(`${base}/close`, {}),
    stress: () => postJson(`${base}/stress`, {}),
  };
}
