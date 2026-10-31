// The engine's HTTP reads the screens need (docs/interfaces.md §2): `GET /strategy`, `GET /windows/history?id=`
// and `GET /state` (for the Journal's backlog). This is the seam: a screen only sees `EngineApi`, so swapping the
// fake for the engine changes one place (`engineApi()` in start.ts). Pure apart from `fetch`, so the parsers are tested.
import type { JournalEntry, StrategyConfig, WindowHistory } from '@gimbal/shared';
import { KINDS } from '../journal/kinds.ts';

export interface EngineApi {
  /** The owner's engine rules, as `GET /strategy` returns them. */
  strategy(): Promise<StrategyConfig>;
  /** Hourly net APR of one window over the last 7 days. Rejects when the engine has no history for it. */
  windowHistory(id: string): Promise<WindowHistory>;
  /** The most recent journal entries the engine holds (`EngineState.journal`), newest first, at most 100. */
  journal(): Promise<JournalEntry[]>;
}

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

/** Checks the `journal` of `GET /state`; throws with what is wrong, so the screen can say so. */
export function parseJournal(value: unknown): JournalEntry[] {
  if (!isObject(value)) throw new Error('GET /state: not an object');
  const { journal } = value;
  if (!Array.isArray(journal)) throw new Error('GET /state: journal is not an array');
  return journal.map((item: unknown, at) => {
    const where = `GET /state: journal[${at}]`;
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

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${url.split('?')[0]}: ${response.status}`);
  return response.json();
}

/** The real engine, through the dev proxy or the same origin in production. */
export function httpApi(base = ''): EngineApi {
  return {
    strategy: async () => parseStrategy(await getJson(`${base}/strategy`)),
    windowHistory: async (id) => parseHistory(await getJson(`${base}/windows/history?id=${encodeURIComponent(id)}`)),
    journal: async () => parseJournal(await getJson(`${base}/state`)),
  };
}
