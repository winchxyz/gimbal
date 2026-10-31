// POST /setup { deskId }: starts venue setup for a desk and answers at once, the dashboard's convention:
//   200 { ok: true }            the run started; progress arrives as `setup` events (SetupProgress)
//   200 { ok: false, reason }   it did not start (a run is already going, no such desk, setup is off, ...)
//   400 { error }               the body is not { deskId }
// A starter of null means setup is off in this engine.

import type { SetupProgress } from '@gimbal/shared';
import { errorMessage } from '../venues/recorder.ts';

export interface RouteAnswer {
  status: number;
  body: unknown;
}

export interface SetupStarter {
  start(deskId: string, publish: (progress: SetupProgress) => void): Promise<RouteAnswer>;
}

/** A run that did not start: still 200, the reason is for the owner. */
export function refused(reason: string): RouteAnswer {
  return { status: 200, body: { ok: false, reason } };
}

/** Desk ids as create_desk takes them: short, no spaces or slashes. */
const DESK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function setupRoute(
  read: () => Promise<string>, starter: SetupStarter | null, publish: (progress: SetupProgress) => void,
): Promise<RouteAnswer> {
  const bad = (error: string): RouteAnswer => ({ status: 400, body: { error } });
  let body: unknown;
  try {
    body = JSON.parse(await read());
  } catch (err) {
    return bad(`POST /setup: ${errorMessage(err)}`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('POST /setup takes { "deskId": "<desk id>" }');
  const extra = Object.keys(body).filter((k) => k !== 'deskId');
  if (extra.length > 0) return bad(`POST /setup: unknown field ${extra[0]}`);
  const deskId = (body as { deskId?: unknown }).deskId;
  if (typeof deskId !== 'string' || !DESK_ID.test(deskId)) return bad('POST /setup: deskId must be a desk id');
  if (starter === null) return refused('venue setup is off: the engine runs without the operator key (GIMBAL_SETUP=1)');
  return starter.start(deskId, publish);
}
