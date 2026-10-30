// The engine's HTTP reads the Windows screen needs (docs/interfaces.md §2): `GET /strategy` and
// `GET /windows/history?id=`. This is the seam: the screen only sees `EngineApi`, so swapping the fake
// for the engine changes one place (`engineApi()` in start.ts). Pure apart from `fetch`, so the parsers are tested.
import type { StrategyConfig, WindowHistory } from '@gimbal/shared';

export interface EngineApi {
  /** The owner's engine rules, as `GET /strategy` returns them. */
  strategy(): Promise<StrategyConfig>;
  /** Hourly net APR of one window over the last 7 days. Rejects when the engine has no history for it. */
  windowHistory(id: string): Promise<WindowHistory>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Checks the body of `GET /strategy`; throws with what is wrong, so the screen can say so. */
export function parseStrategy(value: unknown): StrategyConfig {
  if (!isObject(value)) throw new Error('GET /strategy: not an object');
  const { auto, minNetAprPct, legUsd, maxLeverage, stopDrawdownPct, rotate } = value;
  if (typeof auto !== 'boolean') throw new Error('GET /strategy: auto is not a boolean');
  if (!isNumber(minNetAprPct)) throw new Error('GET /strategy: minNetAprPct is not a number');
  if (!isNumber(legUsd)) throw new Error('GET /strategy: legUsd is not a number');
  if (!isNumber(maxLeverage)) throw new Error('GET /strategy: maxLeverage is not a number');
  if (stopDrawdownPct !== null && !isNumber(stopDrawdownPct)) throw new Error('GET /strategy: stopDrawdownPct is neither a number nor null');
  if (!isObject(rotate) || !isNumber(rotate.minGainPts) || !isNumber(rotate.forHours)) {
    throw new Error('GET /strategy: rotate needs minGainPts and forHours');
  }
  return { auto, minNetAprPct, legUsd, maxLeverage, stopDrawdownPct, rotate: { minGainPts: rotate.minGainPts, forHours: rotate.forHours } };
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
  };
}
