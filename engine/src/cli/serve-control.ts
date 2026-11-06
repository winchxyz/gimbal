// A one-shot call of one of the engine's own control routes, asked for with GIMBAL_CONTROL and run by serve in the
// background. It exists because the control routes answer on loopback only and a container with static outbound IPs
// (which Orderly's key restriction needs) has no `railway ssh`: without it the owner could not enter, close or change
// the engine rules at all. It adds no route and no check of its own: it sends the request to the engine's own HTTP
// server on loopback, so the route's handler, its checks and its answer are exactly those of a request made from
// inside the container.
//
//   GIMBAL_CONTROL={"id":"<run-id>","method":"POST","path":"/rotate","body":{"windowId":"<window id>"},"until":"<ISO time>"}
//
// Allowed: POST /rotate {windowId} or {windowId, demo: {maxLossUsd}} (an owner demo entry: the route and the strategy
// loop check `demo`, this passes the body through as given), POST /close (no body), PUT /strategy <the whole
// StrategyConfig> (the engine rules, the risk lines strategy.risk.watchDistancePct and rescueDistancePct among them).
// Anything else is refused.
// `until` (optional): past that time the run is refused, with no marker, so a variable left set never acts on a
// later deploy (a new volume has no marker to stop it).
//
//   1  a marker <state dir>/control-<run-id>.json: log what it says, do nothing (at most once per run-id); a marker
//      of a different request under that run-id is logged as such, loudly, and nothing runs either
//   2  POST /rotate and /close need GIMBAL_TRADE=1 (the route refuses without it): refused here, before any wait;
//      past `until`: refused
//   3  wait, at most CONTROL_WAIT_MS, until the engine is ready for the route: the first scan for PUT /strategy; also
//      the pair's start confirmed and the strategy loop's first check of a scan for /rotate and /close (so /rotate
//      sees the window and the free margin). Past the wait: the marker `failed`, never retried
//   3b POST /rotate, within the same CONTROL_WAIT_MS: until the route would start it, asked of the route's own check
//      (StrategyLoop.rotateRefusal, which rotate() answers on, the demo waiver of the profit checks included) once a
//      poll. A restart reads the funding history again, and for a minute or so a window has no 7-day history: the
//      call would be refused for that alone. Nothing is waived here that the route does not waive. A `waiting for
//      <window>` line when the reason changes, else at most once a minute. Past the wait: the marker `failed` with
//      the reason that never cleared, nothing called, never retried
//   4  the engine rules as GET /strategy answers them, logged; then the marker `started`, created exclusively and
//      fsynced before the call
//   5  the call over loopback; the marker `done` with the route's status and body, or `failed` with the error
//
// A refusal in 1-2, a value that cannot be parsed, and a shutdown during the wait write no marker: the same run-id
// runs at the next start. A `started` marker with no outcome (the process died during the call) is an unknown
// outcome: nothing runs again for that run-id. serve's shutdown drains the run: during the wait it stops, from the
// marker on it is waited for. A /rotate the route accepted runs in the strategy loop, whose progress goes to the
// journal (and its `journal` lines to the log) as for any POST /rotate; the shutdown waits for it as for any act.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fsyncDir, writeAtomic } from '../book/store.ts';
import { reasonCategory } from '../strategy/loop.ts';
import { errorMessage } from '../venues/recorder.ts';

export const CONTROL_ENV = 'GIMBAL_CONTROL';
/** How long a run waits for the engine to be ready for its route; a pair that is taken over goes live in 90 s to 3 min. */
export const CONTROL_WAIT_MS = 10 * 60_000;
const POLL_MS = 1_000;
/** While POST /rotate waits for its window (3b): a line when the reason changes, else one at most this often. */
const WAIT_LINE_MS = 60_000;
/** One loopback request: the routes answer at once (a rotate's act runs after the answer). */
const CALL_TIMEOUT_MS = 30_000;
const PREFIX = 'control:';
const UNKNOWN_HINT = 'unknown outcome: the call may or may not have reached the route; check the journal (`journal` and `decision` lines), '
  + 'the desk and the engine rules before a new run-id';

export type ControlMethod = 'POST' | 'PUT';
export type ControlPath = '/rotate' | '/close' | '/strategy';
/** The routes GIMBAL_CONTROL may call, and nothing else. */
export const CONTROL_ROUTES: readonly (readonly [ControlMethod, ControlPath])[] = [['POST', '/rotate'], ['POST', '/close'], ['PUT', '/strategy']];

export interface ControlAsk {
  runId: string;
  method: ControlMethod;
  path: ControlPath;
  /** The JSON body as given; absent for POST /close. */
  body?: Record<string, unknown>;
  /** ms: past this the run is refused (the optional `until`). */
  until?: number;
}

/** Parses GIMBAL_CONTROL; throws saying what is wrong (an unknown route included). */
export function parseControl(value: string): ControlAsk {
  let v: unknown;
  try {
    v = JSON.parse(value);
  } catch (err) {
    throw new Error(`${CONTROL_ENV} is not JSON: ${errorMessage(err)}`);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${CONTROL_ENV} must be a JSON object {"id","method","path","body","until"}`);
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['id', 'method', 'path', 'body', 'until'].includes(k));
  if (extra.length > 0) throw new Error(`${CONTROL_ENV}: unknown field ${JSON.stringify(extra[0])}`);
  const { id, method, path, body, until } = o;
  let untilMs: number | undefined;
  if (until !== undefined) {
    untilMs = typeof until === 'string' ? isoWithZone(until) : NaN;
    if (!Number.isFinite(untilMs)) throw new Error(`${CONTROL_ENV}: until ${JSON.stringify(until)} is not an ISO time with a zone, e.g. "2026-11-06T18:00:00Z"`);
  }
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error(`${CONTROL_ENV}: id ${JSON.stringify(id)} is not [A-Za-z0-9_-]{1,40}`);
  const route = CONTROL_ROUTES.find(([m, p]) => m === method && p === path);
  if (route === undefined) {
    throw new Error(`${CONTROL_ENV}: ${String(method)} ${String(path)} is not allowed; only ${CONTROL_ROUTES.map(([m, p]) => `${m} ${p}`).join(', ')}`);
  }
  const [m, p] = route;
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) throw new Error(`${CONTROL_ENV}: body must be a JSON object`);
  if (p === '/close' && body !== undefined && Object.keys(body).length > 0) throw new Error(`${CONTROL_ENV}: POST /close takes no body`);
  if (p !== '/close' && body === undefined) throw new Error(`${CONTROL_ENV}: ${m} ${p} needs a body (${p === '/rotate' ? '{"windowId":"<window id>"}' : 'the whole engine rules, as GET /strategy answers them'})`);
  return {
    runId: id, method: m, path: p, ...(p === '/close' ? {} : { body: body as Record<string, unknown> }),
    ...(untilMs === undefined ? {} : { until: untilMs }),
  };
}

/**
 * ms of an ISO time with a date, a time and a zone (Z or an offset; never a local time each host reads its own way),
 * or NaN. The date and time must exist: Date.parse rolls 2026-02-30 over into March, so the parsed time is written
 * back in the given zone and must read as given.
 */
export function isoWithZone(text: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(text);
  if (m === null) return NaN;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return NaN;
  const offsetMin = m[4] === 'Z' ? 0 : (m[5] === '-' ? -1 : 1) * (Number(m[6]) * 60 + Number(m[7]));
  if (m[4] !== 'Z' && (Number(m[6]) > 23 || Number(m[7]) > 59)) return NaN;
  const wall = new Date(ms + offsetMin * 60_000).toISOString();   // YYYY-MM-DDTHH:MM:SS.mmmZ, in the given zone
  const given = `${m[1]}:${m[2] ?? '00'}.${(m[3] ?? '').padEnd(3, '0')}`;
  return wall.slice(0, 23) === given ? ms : NaN;
}

/** The request a run sends, as one string: method, path and body with its keys sorted (a marker is matched on it). */
export function requestKey(r: { method: string; path: string; body?: unknown }): string {
  return `${r.method} ${r.path} ${stableJson(r.body ?? {})}`;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function controlMarker(stateDir: string, runId: string): string {
  return join(stateDir, `control-${runId}.json`);
}

/** What a route answered: its HTTP status and its JSON body. */
export interface RouteAnswer {
  status: number;
  body: unknown;
}

/** Sends one request to the engine's own server: the routes' handlers as a loopback client reaches them. */
export type RouteCall = (method: 'GET' | ControlMethod, path: string, body?: unknown) => Promise<RouteAnswer>;

export interface ControlDeps {
  ask: ControlAsk;
  stateDir: string;
  /** GIMBAL_TRADE=1: POST /rotate and /close move money only with it. */
  trade: boolean;
  /** What the engine still lacks for this route (the first scan, the pair's start, the loop's first check), or null when ready. */
  waitingFor(path: ControlPath): string | null;
  call: RouteCall;
  /**
   * Why POST /rotate (windowId, demo as the handler passes them: demo undefined when not sent) would be refused now, or
   * null when it would be started: the strategy loop's rotateRefusal, the route's own check. Absent: no such wait.
   */
  rotateRefusal?: (windowId: unknown, demo: unknown) => string | null;
  /** serve is shutting down: a run still waiting stops (no marker). */
  stopping?: () => boolean;
  /** Called once the `started` marker is on disk. */
  onStarted?: () => void;
  log(line: string): void;
  now?: () => number;
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type ControlResult =
  | { status: 'marker'; marker: string; was: string }
  | { status: 'refused'; reason: string }
  | { status: 'stopped' }
  | { status: 'done'; answer: RouteAnswer }
  | { status: 'failed'; error: string };

interface Marker {
  status: 'started' | 'done' | 'failed';
  runId: string;
  method: ControlMethod;
  path: ControlPath;
  body?: Record<string, unknown>;
  /** The request's until, ISO (kept for the record; never extends a run). */
  until?: string;
  startedAt?: string;
  finishedAt?: string;
  answer?: RouteAnswer;
  error?: string;
}

export async function runControl(d: ControlDeps): Promise<ControlResult> {
  const { ask } = d;
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  const say = (line: string) => d.log(`${PREFIX} ${line}`);
  const what = `${ask.method} ${ask.path}${ask.body === undefined ? '' : ` ${JSON.stringify(ask.body)}`}`;
  const path = controlMarker(d.stateDir, ask.runId);
  const base: Marker = {
    status: 'started', runId: ask.runId, method: ask.method, path: ask.path, ...(ask.body === undefined ? {} : { body: ask.body }),
    ...(ask.until === undefined ? {} : { until: new Date(ask.until).toISOString() }),
  };

  // 1. At most once per run-id, across restarts. The marker names the request it was for: another request under a
  // used run-id is not run either, and says so loudly (the owner changed the request and kept the run-id).
  const seen = readMarker(path);
  if (seen !== null) {
    if (seen.kind === 'ok' && typeof seen.marker.method === 'string' && requestKey(seen.marker) !== requestKey(ask)) {
      say(`DIFFERENT request under used run-id ${ask.runId}: NOT run. The marker ${path} (${seen.marker.status}) is for ${requestKey(seen.marker)}; `
        + `${CONTROL_ENV} asks ${requestKey(ask)}. Pick a new run-id for a new request`);
      return { status: 'marker', marker: path, was: 'different' };
    }
    say(describeMarker(seen, path, ask.runId));
    return { status: 'marker', marker: path, was: seen.kind === 'ok' ? seen.marker.status : 'unreadable' };
  }
  say(`run ${ask.runId}: ${what}${ask.until === undefined ? '' : `, until ${new Date(ask.until).toISOString()}`}; no marker at ${path}`);

  // 2. What the route would refuse anyway, and an expired value, before any wait.
  const expired = (): ControlResult | null => {
    if (ask.until === undefined || now() <= ask.until) return null;
    const reason = `its until, ${new Date(ask.until).toISOString()}, has passed`;
    say(`refused: ${reason}; nothing was called and no marker was written: unset ${CONTROL_ENV}, or set it again with a new until`);
    return { status: 'refused', reason };
  };
  const late = expired();
  if (late !== null) return late;
  if (ask.path !== '/strategy' && !d.trade) {
    const reason = `GIMBAL_TRADE is not 1: POST ${ask.path} trades nothing in this engine`;
    say(`refused: ${reason}; nothing was called and no marker was written: set GIMBAL_TRADE=1 (the same run-id runs then), or unset ${CONTROL_ENV}`);
    return { status: 'refused', reason };
  }

  // 3. Ready for the route, within the bound.
  const waitMs = d.waitMs ?? CONTROL_WAIT_MS;
  const until = now() + waitMs;
  let lastWait: string | null = null;
  for (;;) {
    if (d.stopping?.() === true) {
      say(`stopped: serve is stopping before the call; nothing was called and no marker was written, so ${ask.runId} runs at the next start`);
      return { status: 'stopped' };
    }
    const waiting = d.waitingFor(ask.path);
    if (waiting === null) break;
    if (waiting !== lastWait) {
      say(`waiting for ${waiting} (at most ${Math.round(waitMs / 1000)} s in all)`);
      lastWait = waiting;
    }
    if (now() >= until) {
      const error = `the engine was not ready for ${ask.method} ${ask.path} within ${Math.round(waitMs / 1000)} s: still waiting for ${waiting}`;
      try {
        createExclusive(path, `${JSON.stringify({ ...base, status: 'failed', finishedAt: new Date(now()).toISOString(), error }, null, 2)}\n`);
      } catch (err) {
        say(`could not write the marker ${path}: ${errorMessage(err)}`);
      }
      say(`failed: ${error}; nothing was called; marker ${path}; not retried: pick a new run-id once the engine is ready`);
      return { status: 'failed', error };
    }
    await sleep(d.pollMs ?? POLL_MS);
  }

  // 3b. POST /rotate: within the same bound, until the route would start it. Asked of the route's own check (the
  // strategy loop's rotateRefusal, the demo waiver included), with the arguments the /rotate handler passes it.
  if (ask.path === '/rotate' && d.rotateRefusal !== undefined) {
    const body = ask.body ?? {};
    const windowId = body.windowId;
    const demoSent = Object.prototype.hasOwnProperty.call(body, 'demo');
    const label = typeof windowId === 'string' ? windowId : JSON.stringify(windowId) ?? 'no windowId';
    let lastCategory: string | null = null;
    let lastLineAt = 0;
    for (;;) {
      if (d.stopping?.() === true) {
        say(`stopped: serve is stopping before the call; nothing was called and no marker was written, so ${ask.runId} runs at the next start`);
        return { status: 'stopped' };
      }
      const late3b = expired();
      if (late3b !== null) return late3b;
      const reason = d.rotateRefusal(windowId, demoSent ? body.demo : undefined);
      if (reason === null) {
        if (lastCategory !== null) say(`${label} passes every check POST /rotate does not waive${demoSent ? ' (the profit checks a demo entry waives are not waited on)' : ''}: calling it`);
        break;
      }
      const category = reasonCategory(reason);
      if (now() >= until) {
        const error = `POST /rotate ${label} would still be refused after ${Math.round(waitMs / 1000)} s: ${reason}`;
        try {
          createExclusive(path, `${JSON.stringify({ ...base, status: 'failed', finishedAt: new Date(now()).toISOString(), error }, null, 2)}\n`);
        } catch (err) {
          say(`could not write the marker ${path}: ${errorMessage(err)}`);
        }
        say(`failed: ${error}; nothing was called; marker ${path}; not retried: pick a new run-id once it passes`);
        return { status: 'failed', error };
      }
      if (category !== lastCategory || now() - lastLineAt >= WAIT_LINE_MS) {
        const first = lastCategory === null;
        say(`waiting for ${label}: POST /rotate would be refused now (${reason}); asked again every ${Math.round((d.pollMs ?? POLL_MS) / 1000)} s, `
          + `at most ${Math.round(waitMs / 1000)} s in all${first && demoSent ? '; a demo entry waives the profit checks only, so they are not waited on' : ''}`);
        lastCategory = category;
        lastLineAt = now();
      }
      await sleep(d.pollMs ?? POLL_MS);
    }
  }

  // 4. The rules before the call (the whole config PUT /strategy takes back), then the marker.
  const expiredReady = expired();
  if (expiredReady !== null) return expiredReady;
  try {
    const rules = await d.call('GET', '/strategy');
    say(`engine rules before the call (GET /strategy ${rules.status}): ${JSON.stringify(rules.body)}`);
  } catch (err) {
    say(`engine rules before the call: GET /strategy failed (${errorMessage(err)})`);
  }
  if (d.stopping?.() === true) {
    say(`stopped: serve is stopping before the call; nothing was called and no marker was written, so ${ask.runId} runs at the next start`);
    return { status: 'stopped' };
  }
  const expiredNow = expired();
  if (expiredNow !== null) return expiredNow;
  const started: Marker = { ...base, startedAt: new Date(now()).toISOString() };
  try {
    createExclusive(path, `${JSON.stringify(started, null, 2)}\n`);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === 'EEXIST'
      ? `another run of ${ask.runId} created the marker ${path} meanwhile`
      : `could not write the marker ${path}: ${errorMessage(err)}`;
    say(`refused: ${reason}; nothing was called`);
    return { status: 'refused', reason };
  }
  d.onStarted?.();
  say(`started: marker ${path}; calling ${ask.method} ${ask.path} on the engine's own loopback server`);

  // 5. Exactly one call.
  const finish = (m: Marker) => {
    try {
      writeAtomic(path, `${JSON.stringify(m, null, 2)}\n`);
    } catch (err) {
      say(`could not write the outcome to ${path} (${errorMessage(err)}); it still says started, so this run-id never runs again`);
    }
  };
  let answer: RouteAnswer;
  try {
    answer = await d.call(ask.method, ask.path, ask.body ?? {});
  } catch (err) {
    const error = errorMessage(err);
    finish({ ...started, status: 'failed', finishedAt: new Date(now()).toISOString(), error });
    say(`failed: ${error}; not retried: ${UNKNOWN_HINT}`);
    return { status: 'failed', error };
  }
  finish({ ...started, status: 'done', finishedAt: new Date(now()).toISOString(), answer });
  // 200 from /rotate or /close is "accepted", not "carried out": the act runs in the strategy loop after the answer.
  const next = answer.status === 200 && ask.path !== '/strategy'
    ? `; ACCEPTED, not yet carried out: the ${ask.path === '/rotate' ? 'rotate' : 'close'} runs in the strategy loop now; `
      + 'wait for its result line (`journal   enter|rotate|exit|error|refused: ...`) before any redeploy'
    : '';
  say(`done: ${ask.method} ${ask.path} answered ${answer.status} ${JSON.stringify(answer.body)}${next}`);
  return { status: 'done', answer };
}

/** A started run: `done` settles with its result; `drain()` (serve's shutdown) stops it while it waits, then waits for it. */
export interface ControlRun {
  done: Promise<ControlResult | null>;
  drain(): Promise<ControlResult | null>;
  /** Past its `started` marker with no outcome yet: a process that exits now leaves an unknown outcome. */
  inFlight(): boolean;
}

export interface ControlStart extends Omit<ControlDeps, 'ask' | 'onStarted'> {
  /** GIMBAL_CONTROL as set (never undefined here: unset means this is not called). */
  value: string;
}

/**
 * Starts the run in the background (serve does not wait for it); null when the value cannot be parsed or names a
 * route that is not allowed, which is logged and changes nothing else in serve.
 */
export function startControl(o: ControlStart): ControlRun | null {
  let ask: ControlAsk;
  try {
    ask = parseControl(o.value);
  } catch (err) {
    o.log(`${PREFIX} refused: ${errorMessage(err)}; nothing was called and no marker was written`);
    return null;
  }
  let phase: 'waiting' | 'started' | 'over' = 'waiting';
  let stopping = false;
  const { value: _value, stopping: serveStopping, ...deps } = o;
  const done = runControl({
    ...deps, ask,
    // serve's own flag (set the moment its shutdown starts) or this run's drain, whichever comes first.
    stopping: () => stopping || serveStopping?.() === true,
    onStarted: () => { phase = 'started'; },
  }).catch((err: unknown) => {
    o.log(`${PREFIX} stopped: ${errorMessage(err)}; if its marker says started: ${UNKNOWN_HINT}`);
    return null;
  }).finally(() => { phase = 'over'; });
  return {
    done,
    drain: () => {
      stopping = true;
      return done;
    },
    inFlight: () => phase === 'started',
  };
}

/** serve's entry: null, with nothing logged, read or written, when GIMBAL_CONTROL is not set (or empty). */
export function controlFromEnv(env: (name: string) => string | undefined, o: Omit<ControlStart, 'value'>): ControlRun | null {
  const value = env(CONTROL_ENV);
  if (value === undefined || value.trim() === '') return null;
  return startControl({ ...o, value });
}

/**
 * Where a loopback client reaches a server listening on `host`: a wildcard address is reached on its loopback, a
 * named one as is (a server that is not on loopback answers /rotate and /close 403, as to any other client).
 */
export function controlAddress(host: string): string {
  if (host === '0.0.0.0' || host === '') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  return host.replace(/^\[|\]$/g, '');
}

/**
 * One request to the engine's server, as a client in the container would send it: JSON content type, a Host that
 * names the address, no Origin. node:http, not fetch: no proxy variable can send it anywhere else.
 */
export function loopbackCall(host: string, port: number, timeoutMs = CALL_TIMEOUT_MS): RouteCall {
  const address = controlAddress(host);
  const hostHeader = `${address.includes(':') ? `[${address}]` : address}:${port}`;
  return (method, path, body) => new Promise<RouteAnswer>((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = { host: hostHeader };
    if (text !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(text);
    }
    const req = request({ host: address, port, path, method, headers, setHost: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (data += c));
      res.on('end', () => {
        let parsed: unknown = data;
        try {
          parsed = data === '' ? null : JSON.parse(data);
        } catch {
          // Not JSON: kept as the text it was.
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${path}: no answer within ${timeoutMs / 1000} s`)));
    req.on('error', reject);
    if (text !== undefined) req.write(text);
    req.end();
  });
}

type SeenMarker = { kind: 'ok'; marker: Marker } | { kind: 'unreadable'; problem: string };

function readMarker(path: string): SeenMarker | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { kind: 'unreadable', problem: errorMessage(err) };
  }
  try {
    const m = JSON.parse(text) as Marker;
    if (m === null || typeof m !== 'object' || !['started', 'done', 'failed'].includes(m.status)) return { kind: 'unreadable', problem: 'no status started, done or failed' };
    return { kind: 'ok', marker: m };
  } catch (err) {
    return { kind: 'unreadable', problem: errorMessage(err) };
  }
}

function describeMarker(seen: SeenMarker, path: string, runId: string): string {
  const base = `run ${runId} has a marker (${path}), so nothing runs`;
  if (seen.kind === 'unreadable') return `${base}: it cannot be read (${seen.problem}): ${UNKNOWN_HINT}`;
  const m = seen.marker;
  const call = `${m.method} ${m.path}`;
  switch (m.status) {
    case 'done':
      return `${base}: done at ${m.finishedAt ?? '?'}, ${call} answered ${m.answer?.status ?? '?'} ${JSON.stringify(m.answer?.body ?? null)}; unset ${CONTROL_ENV}`;
    case 'failed':
      return `${base}: failed at ${m.finishedAt ?? '?'} (${m.error ?? 'no error kept'}); never retried: pick a new run-id`;
    default:
      return `${base}: ${call} started at ${m.startedAt ?? '?'} with no outcome written; not retried: ${UNKNOWN_HINT}`;
  }
}

/** Creates `path` only when it does not exist, its content fsynced (a second writer fails with EEXIST). */
function createExclusive(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDir(dirname(path));
}
