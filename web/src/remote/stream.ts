// The remote view as the app's one stream and its HTTP side. The stream is the local one (stream/sse.ts) with three
// differences: each attempt first fetches a one-use ticket (EventSource cannot send a header), a failed attempt waits
// 1 s, 2 s ... up to 30 s, and a refusal changes the wait: 401 stops for good (a rejected token must not be retried),
// 429 waits as long as the engine asked.
import type { EngineState } from '@gimbal/shared';
import { parseEngineState, readApi, type ActionResult, type EngineApi } from '../stream/api.ts';
import { backoffUpTo30s, connectSse, type EventSourceLike, type FailureVerdict } from '../stream/sse.ts';
import type { StreamAction } from '../stream/store.ts';
import { clearProblem, reportProblem } from './problem.ts';
import { READ_ONLY_TEXT } from './readonly.ts';
import { createViewClient, toViewError, ViewError, type ViewClient, type ViewDeps, type ViewTarget } from './view.ts';

/** What a failed attempt means for the next one. */
export function verdictFor(error: unknown): FailureVerdict | undefined {
  const e = toViewError(error);
  if (e.kind === 'token') return { stop: true };
  if (e.kind === 'limited' && e.retryAfterMs !== undefined) return { waitMs: e.retryAfterMs };
  return undefined;
}

export interface RemoteStreamDeps extends ViewDeps {
  /** Opens the stream; the browser's `EventSource` unless a test says otherwise. */
  open?: (url: string) => EventSourceLike;
  backoff?: (attempt: number) => number;
  client?: ViewClient;
}

/**
 * Keeps the remote stream open. Each attempt: `GET /view-ticket`, then `EventSource(/events?ticket=...)`, then
 * `GET /state` once it is open. After a failure the ticket is fetched again and the state read again, so a page that
 * missed events (or an engine that restarted and voided every ticket) comes back whole.
 */
export function startRemoteStream(dispatch: (action: StreamAction) => void, target: ViewTarget, deps: RemoteStreamDeps = {}): () => void {
  const client = deps.client ?? createViewClient(target, deps);
  return connectSse(dispatch, {
    backoff: deps.backoff ?? backoffUpTo30s,
    ...(deps.open === undefined ? {} : { open: deps.open }),
    address: async () => client.eventsUrl(await client.ticket()),
    explain: async () => client.probeStream(await client.ticket()),
    readState: async (): Promise<EngineState> => {
      const state = parseEngineState(await client.getJson('/state'));
      clearProblem();
      return state;
    },
    onFailure: (error) => {
      reportProblem(error);
      return verdictFor(error);
    },
  });
}

const refused = (): Promise<ActionResult> => Promise.resolve({ ok: false, reason: READ_ONLY_TEXT });

/** The engine's HTTP side over the view: the four reads with the token, and writes that are refused without a request. */
export function remoteApi(target: ViewTarget, deps: ViewDeps & { client?: ViewClient } = {}): EngineApi {
  const client = deps.client ?? createViewClient(target, deps);
  return {
    ...readApi(async (path) => {
      try {
        const body = await client.getJson(path);
        // An answer proves the engine is up and takes this token: whatever the line under the header said is over.
        clearProblem();
        return body;
      } catch (error) {
        reportProblem(error);
        throw error;
      }
    }),
    rotate: refused,
    close: refused,
    stress: refused,
  };
}

/**
 * An API whose writes are refused in the page, without a request: the public live view's (its host refuses every
 * write too, and never forwards one to the engine).
 */
export function readOnlyApi(api: EngineApi): EngineApi {
  return { ...api, rotate: refused, close: refused, stress: refused };
}

/**
 * The public live view unlocked by its owner (remote/owner.ts): the same reads, and rotate and close sent with the owner
 * header (the host forwards those only; the engine checks the token and its routes check the rest). The stress test
 * stays refused in the page.
 */
export function ownerApi(api: EngineApi): EngineApi {
  return { ...api, stress: refused };
}

/** The API of a remote page with no token yet: every read says so. */
export function lockedApi(): EngineApi {
  const locked = <T>(): Promise<T> => Promise.reject(new ViewError('needs-token', 'no view token entered'));
  return { strategy: locked, windowHistory: locked, journal: locked, journalBefore: locked, rotate: refused, close: refused, stress: refused };
}
