// The client for the engine's read-only view (engine/src/view/view-server.ts): bearer-token GETs, the ticket that lets
// an EventSource in without a header, and the plain-words reading of every refusal. Nothing here writes: the view
// answers GET only. Credentials and cookies are never sent (`credentials: 'omit'`), and the token goes in one header,
// never in an address.

export type ViewErrorKind =
  /** No token entered in this tab. */
  | 'needs-token'
  /** 401: the engine did not accept the token. */
  | 'token'
  /** 403: this site's origin is not in the engine's GIMBAL_VIEW_ORIGINS. */
  | 'origin'
  /** 429: too many failed tries; wait. */
  | 'limited'
  /** 503 on /events: the engine holds as many streams as it allows. */
  | 'streams'
  /** No answer at all. */
  | 'unreachable'
  /** Anything else the engine answered. */
  | 'status';

export class ViewError extends Error {
  override name = 'ViewError';
  readonly kind: ViewErrorKind;
  /** For `limited`: how long the engine asked us to wait. */
  readonly retryAfterMs: number | undefined;
  constructor(kind: ViewErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** What the page says for each kind: a short title and one sentence on what to do. */
export function viewErrorText(error: ViewError): { title: string; text: string } {
  switch (error.kind) {
    case 'needs-token':
      return { title: 'View token needed', text: 'Enter the view token to read this engine.' };
    case 'token':
      return { title: 'Token rejected', text: 'The engine did not accept the view token. Enter it again.' };
    case 'origin':
      return { title: 'Not allowed', text: 'This site is not allowed by the engine. Its address has to be in the engine’s list of allowed origins.' };
    case 'limited': {
      const s = Math.max(1, Math.ceil((error.retryAfterMs ?? 0) / 1000));
      return { title: 'Too many tries', text: `The engine asked this page to wait ${s} s. It tries again by itself.` };
    }
    case 'streams':
      return { title: 'Too many streams open', text: 'The engine is already serving as many live streams as it allows. This page tries again by itself.' };
    case 'unreachable':
      return { title: 'Engine not reachable', text: 'This page cannot reach the engine. It keeps trying.' };
    case 'status':
      return { title: 'Engine error', text: `${error.message}. This page tries again by itself.` };
  }
}

export function toViewError(error: unknown): ViewError {
  return error instanceof ViewError ? error : new ViewError('status', error instanceof Error ? error.message : String(error));
}

/** Used when the engine's 429 carries no usable Retry-After; the engine's own failure window. */
export const DEFAULT_RETRY_MS = 60_000;
const MAX_RETRY_MS = 5 * 60_000;

/** `Retry-After`: whole seconds, or an HTTP date. Missing or unreadable, the engine's window; never more than 5 minutes. */
export function retryAfterMs(header: string | null, now: number): number {
  if (header === null) return DEFAULT_RETRY_MS;
  const text = header.trim();
  const ms = /^\d{1,7}$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  if (!Number.isFinite(ms)) return DEFAULT_RETRY_MS;
  return Math.min(MAX_RETRY_MS, Math.max(1000, ms));
}

export interface ViewTarget {
  /** `https://host`, no trailing slash. */
  base: string;
  token: string;
}

export interface ViewDeps {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export const VIEW_TIMEOUT_MS = 10_000;
const PING_TIMEOUT_MS = 5000;

/**
 * `GET /healthz` needs no token and answers without CORS headers, so a page can learn one thing from it: whether
 * anything answers. A `no-cors` request settles when the engine replies at all (the reply is opaque) and fails when
 * it cannot connect.
 */
export async function engineReachable(base: string, deps: ViewDeps = {}): Promise<boolean> {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  try {
    await doFetch(`${base}/healthz`, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

export interface ViewClient {
  readonly base: string;
  getJson(path: string): Promise<unknown>;
  /** `GET /view-ticket`: a ticket for one `/events` connection, good for 30 s. */
  ticket(): Promise<string>;
  /** The address `new EventSource(...)` opens. */
  eventsUrl(ticket: string): string;
  /** Opens `/events` once with a ticket only to read the status the browser's EventSource hides; closes it at once. */
  probeStream(ticket: string): Promise<void>;
}

export function createViewClient(target: ViewTarget, deps: ViewDeps = {}): ViewClient {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? VIEW_TIMEOUT_MS;
  const { base, token } = target;
  /** After a 429 nothing is sent until this time: the wait the engine asked for is kept, not tested again. */
  let blockedUntil = 0;
  /**
   * Once the engine has said the token is wrong, nothing more is sent with it: every further try is another failure on
   * the engine's count of ten a minute, and the next answer would be a 429 that hides the real reason. Entering a token
   * again reloads the page and starts clean.
   */
  let rejected = false;

  /**
   * A browser hides a refusal that has no CORS headers (the engine's 403 for an origin it does not list) as a plain
   * network failure. If the engine answers `/healthz` it is up and the refusal is the origin; if not, it is down.
   */
  async function explain(failure: unknown): Promise<ViewError> {
    const name = failure instanceof Error ? failure.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return new ViewError('unreachable', 'the engine did not answer in time');
    return (await engineReachable(base, deps))
      ? new ViewError('origin', 'the engine refused this site')
      : new ViewError('unreachable', 'the engine did not answer');
  }

  function refusal(response: Response, route: string): ViewError {
    const status = response.status;
    // A ticket the engine will not take (spent, expired, voided by a restart, or refused at the stream cap, which answers 401 to
    // bad credentials before 503) is not a rejected token: ask for a new one.
    if (status === 401) {
      if (route === '/events') return new ViewError('status', 'the engine did not take the stream ticket');
      rejected = true;
      return new ViewError('token', 'the engine answered 401');
    }
    if (status === 403) return new ViewError('origin', 'the engine answered 403');
    if (status === 429) {
      const wait = retryAfterMs(response.headers.get('retry-after'), now());
      blockedUntil = now() + wait;
      return new ViewError('limited', 'the engine answered 429', wait);
    }
    if (status === 503 && route === '/events') return new ViewError('streams', 'the engine answered 503');
    return new ViewError('status', `${route}: the engine answered ${status}`);
  }

  async function get(path: string): Promise<Response> {
    if (rejected) throw new ViewError('token', 'the engine did not accept the token');
    const wait = blockedUntil - now();
    if (wait > 0) throw new ViewError('limited', 'the engine asked for a pause', wait);
    // /events takes its ticket in the address; every other route takes the token in one header.
    const events = path.startsWith('/events');
    const headers: Record<string, string> = events ? { accept: 'text/event-stream' } : { accept: 'application/json', authorization: `Bearer ${token}` };
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        headers,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (failure) {
      throw await explain(failure);
    }
    if (!response.ok) throw refusal(response, path.split('?')[0] ?? path);
    return response;
  }

  async function getJson(path: string): Promise<unknown> {
    const response = await get(path);
    try {
      return await response.json();
    } catch {
      throw new ViewError('status', `${path.split('?')[0]}: the answer was not JSON`);
    }
  }

  return {
    base,
    getJson,
    async ticket() {
      const body = await getJson('/view-ticket');
      const ticket = typeof body === 'object' && body !== null ? (body as { ticket?: unknown }).ticket : undefined;
      if (typeof ticket !== 'string' || ticket === '') throw new ViewError('status', 'GET /view-ticket: no ticket in the answer');
      return ticket;
    },
    eventsUrl: (ticket) => `${base}/events?ticket=${encodeURIComponent(ticket)}`,
    async probeStream(ticket) {
      const response = await get(`/events?ticket=${encodeURIComponent(ticket)}`);
      // Accepted: the status was all we wanted, so the stream is not read.
      await response.body?.cancel().catch(() => undefined);
    },
  };
}
