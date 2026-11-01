// POST /stress (docs/interfaces.md §2): testnet and replay only. Body optional: none or {} turns stress on,
// { "on": false } turns it off. Answers { ok: true } or { ok: false, reason }, as POST /rotate and /close do; what the
// stress led to arrives as `desk`, `journal` and `rescue` events.
// Mainnet is refused before anything else (403), whether or not a risk engine runs.

import type { Mode } from '@gimbal/shared';
import { errorMessage } from '../venues/recorder.ts';
import type { RiskEngine } from './engine.ts';
import { StressRefused } from './engine.ts';

export const STRESS_MAINNET_REASON = 'POST /stress is refused on mainnet: it would start a real rescue that moves real money. It runs on testnet and in replay only.';

export async function stressRoute(
  mode: Mode,
  readBody: () => Promise<string>,
  engine: Pick<RiskEngine, 'stress'> | null,
): Promise<{ status: number; body: unknown }> {
  if (mode === 'mainnet') return { status: 403, body: { ok: false, reason: STRESS_MAINNET_REASON } };
  if (engine === null) return { status: 503, body: { ok: false, reason: 'the risk engine is not running: nothing to stress' } };
  let on = true;
  try {
    const text = (await readBody()).trim();
    if (text !== '') {
      const body: unknown = JSON.parse(text);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('the body must be a JSON object');
      const extra = Object.keys(body).filter((k) => k !== 'on');
      if (extra.length > 0) throw new Error(`unknown field ${extra[0]}`);
      const v = (body as { on?: unknown }).on;
      if (v !== undefined && typeof v !== 'boolean') throw new Error('on must be true or false');
      on = v ?? true;
    }
  } catch (err) {
    return { status: 400, body: { ok: false, reason: `POST /stress: ${errorMessage(err)}` } };
  }
  try {
    await engine.stress(on);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    if (err instanceof StressRefused) return { status: err.status, body: { ok: false, reason: err.message } };
    throw err;
  }
}
