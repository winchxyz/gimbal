// The remote stream: a ticket for every connection, a fresh ticket and a fresh /state after every drop, a wait that
// grows from 1 s to 30 s, and what each refusal does to the retries.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { EngineState } from '@gimbal/shared';
import type { EventSourceLike } from '../stream/sse.ts';
import { initialStreamState, reduceStream, type StreamAction } from '../stream/store.ts';
import { clearProblem, problemStore } from './problem.ts';
import { lockedApi, remoteApi, startRemoteStream, verdictFor } from './stream.ts';
import { ViewError } from './view.ts';

const BASE = 'https://engine.test';
const TOKEN = 'tok-0123456789abcdef0123456789abcdef';

class FakeSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.(new Event('open'));
  }
  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

const state = (at: number): EngineState => ({
  mode: 'replay', windows: null, scan: null, strategy: null, desk: null, journal: [], rescue: null, setup: null, health: null, decision: null, at,
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Rig {
  requests: { path: string; authorization: string | undefined }[];
  sources: FakeSource[];
  actions: StreamAction[];
  stop: () => void;
  /** Paths asked for, in order, without the query. */
  paths: () => string[];
  final: () => ReturnType<typeof initialStreamState>;
  connections: () => string[];
}

/** A stand-in engine: `answer` gets the path and returns the response; /state defaults to a state that counts its reads. */
function rig(answer: (path: string, n: number) => Response | Error | undefined): Rig {
  const requests: Rig['requests'] = [];
  const counts = new Map<string, number>();
  let tickets = 0;
  const fetchStub = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    requests.push({ path: path + url.search, authorization: (init.headers as Record<string, string> | undefined)?.authorization });
    const n = (counts.get(path) ?? 0) + 1;
    counts.set(path, n);
    const given = answer(path, n);
    if (given instanceof Error) throw given;
    return given ?? (path === '/view-ticket' ? json({ ticket: `t${++tickets}`, expiresAt: 1 }) : json(state(n)));
  }) as typeof fetch;
  const sources: FakeSource[] = [];
  const actions: StreamAction[] = [];
  const stop = startRemoteStream((a) => actions.push(a), { base: BASE, token: TOKEN }, {
    fetch: fetchStub,
    now: () => clock,
    open: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
  });
  return {
    requests, sources, actions, stop,
    paths: () => requests.map((r) => r.path.split('?')[0]!),
    final: () => actions.reduce(reduceStream, initialStreamState()),
    connections: () => actions.flatMap((a) => (a.kind === 'connection' ? [a.connection] : [])),
  };
}

/** The default answer: a ticket for /view-ticket, a state for /state. */
const ok = (): undefined => undefined;

/** The page's clock for these tests: the 429 wait is measured on it, and `tick` moves it together with the timers. */
let clock = 1_000_000;
const tick = async (ms: number): Promise<void> => {
  clock += ms;
  mock.timers.tick(ms);
  await flush();
};

const withTimers = async (run: () => Promise<void>): Promise<void> => {
  mock.timers.enable({ apis: ['setTimeout'] });
  clearProblem();
  clock = 1_000_000;
  try {
    await run();
  } finally {
    mock.timers.reset();
  }
};

test('a connection fetches a ticket, opens the stream with it, and reads the state once the stream is open', () =>
  withTimers(async () => {
    const r = rig(ok);
    await flush();
    assert.deepEqual(r.paths(), ['/view-ticket']);
    assert.equal(r.requests[0]?.authorization, `Bearer ${TOKEN}`);
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0]?.url, `${BASE}/events?ticket=t1`);
    assert.ok(!r.sources[0]!.url.includes(TOKEN));

    r.sources[0]?.open();
    await flush();
    assert.deepEqual(r.paths(), ['/view-ticket', '/state']);
    assert.equal(r.requests[1]?.authorization, `Bearer ${TOKEN}`);
    assert.equal(r.final().connection, 'open');
    assert.equal(r.final().mode, 'replay');
    r.stop();
  }));

test('after a drop the stream is closed, a fresh ticket is fetched, the state is read again and a new stream opens', () =>
  withTimers(async () => {
    const r = rig(ok);
    await flush();
    r.sources[0]?.open();
    await flush();

    r.sources[0]?.fail();
    assert.equal(r.sources[0]?.closed, true);
    assert.equal(r.final().connection, 'retrying');
    await tick(999);
    assert.equal(r.paths().filter((p) => p === '/view-ticket').length, 1, 'nothing before the first second is up');
    await tick(1);
    assert.equal(r.paths().filter((p) => p === '/view-ticket').length, 2, 'a new ticket');
    assert.equal(r.sources.length, 2);
    assert.equal(r.sources[1]?.url, `${BASE}/events?ticket=t2`, 'a ticket works for one connection, so the next one carries the next');
    r.sources[1]?.open();
    await flush();
    assert.equal(r.paths().filter((p) => p === '/state').length, 2, 'the state is read again, so nothing missed while down is lost');
    assert.equal(r.final().connection, 'open');
    r.stop();
  }));

test('while the engine does not answer the wait grows 1 s, 2 s, 4 s, 8 s, 16 s and stops at 30 s', () =>
  withTimers(async () => {
    const r = rig((path) => (path === '/view-ticket' || path === '/healthz' ? new TypeError('Failed to fetch') : ok()));
    // The engine is down: the ticket cannot be fetched, and /healthz (no-cors) fails too.
    await flush();
    const tries = () => r.paths().filter((p) => p === '/view-ticket').length;
    assert.equal(tries(), 1);
    let waited = 0;
    for (const wait of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      await tick(wait - 1);
      const before = tries();
      await tick(1);
      assert.equal(tries(), before + 1, `${wait} ms`);
      waited += wait;
    }
    assert.equal(waited, 91_000);
    assert.equal(r.sources.length, 0, 'no stream without a ticket');
    assert.equal(problemStore.getState()?.kind, 'unreachable');
    r.stop();
  }));

test('a rejected token stops the retries: no loop', () =>
  withTimers(async () => {
    const r = rig((path) => (path === '/view-ticket' ? json({ error: 'unauthorized' }, 401) : ok()));
    await flush();
    assert.equal(problemStore.getState()?.kind, 'token');
    assert.equal(problemStore.getState()?.title, 'Token rejected');
    assert.equal(r.final().connection, 'idle');
    const sent = r.requests.length;
    await tick(10 * 60_000);
    assert.equal(r.requests.length, sent, 'nothing more is sent');
    r.stop();
  }));

test('429 waits for the Retry-After the engine sent, not the usual second', () =>
  withTimers(async () => {
    const r = rig((path, n) => (path === '/view-ticket' && n === 1 ? json({ error: 'slow' }, 429, { 'retry-after': '45' }) : ok()));
    await flush();
    assert.equal(problemStore.getState()?.kind, 'limited');
    assert.match(problemStore.getState()?.text ?? '', /45 s/);
    await tick(44_999);
    assert.equal(r.sources.length, 0);
    assert.equal(r.requests.length, 1, 'nothing goes out inside the wait');
    await tick(1);
    assert.equal(r.sources.length, 1);
    r.sources[0]?.open();
    await flush();
    assert.equal(problemStore.getState(), null, 'the line is gone once the engine answers');
    r.stop();
  }));

test('a stream that never opens is asked why: 503 on /events reads as too many streams, and the retries go on', () =>
  withTimers(async () => {
    let events = 0;
    const r = rig((path) => {
      if (path === '/events') {
        events += 1;
        return json({ error: 'too many streams open' }, 503);
      }
      return ok();
    });
    await flush();
    r.sources[0]?.fail();
    await flush();
    assert.equal(events, 1, 'the probe');
    assert.equal(problemStore.getState()?.kind, 'streams');
    assert.equal(problemStore.getState()?.title, 'Too many streams open');
    assert.equal(r.final().connection, 'retrying');
    await tick(1000);
    assert.equal(r.sources.length, 2, 'it tries again by itself');
    r.stop();
  }));

test('a stream that opened and then dropped is not probed', () =>
  withTimers(async () => {
    const r = rig(ok);
    await flush();
    r.sources[0]?.open();
    await flush();
    r.sources[0]?.fail();
    await flush();
    assert.ok(!r.paths().includes('/events'));
    r.stop();
  }));

test('the verdicts: 401 stops, 429 waits what it was told, the rest use the usual wait', () => {
  assert.deepEqual(verdictFor(new ViewError('token', 'x')), { stop: true });
  assert.deepEqual(verdictFor(new ViewError('limited', 'x', 12_000)), { waitMs: 12_000 });
  assert.equal(verdictFor(new ViewError('origin', 'x')), undefined);
  assert.equal(verdictFor(new ViewError('streams', 'x')), undefined);
  assert.equal(verdictFor(new Error('GET /state: 500')), undefined);
});

test('the remote API reads with the token and refuses every write without a request', async () => {
  clearProblem();
  const seen: string[] = [];
  const api = remoteApi({ base: BASE, token: TOKEN }, {
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(`${String(input)} ${(init.headers as Record<string, string>).authorization}`);
      return json({ auto: false, minNetAprPct: 5, legUsd: 10, maxLeverage: 2, stopDrawdownPct: null, rotate: { minGainPts: 1, forHours: 2 }, risk: { watchDistancePct: 20, rescueDistancePct: 10 } });
    }) as typeof fetch,
  });
  assert.equal((await api.strategy()).minNetAprPct, 5);
  assert.deepEqual(seen, [`${BASE}/strategy Bearer ${TOKEN}`]);
  for (const write of [await api.rotate('w'), await api.close(), await api.stress()]) {
    assert.equal(write.ok, false);
    if (!write.ok) assert.match(write.reason, /Read-only view/);
  }
  assert.equal(seen.length, 1, 'the refused writes sent nothing');
});

test('a remote API with no token says so on every read', async () => {
  const api = lockedApi();
  await assert.rejects(api.strategy(), (e: unknown) => e instanceof ViewError && e.kind === 'needs-token');
  assert.equal((await api.close()).ok, false);
});

test('a refused read puts its reason in the problem line', async () => {
  clearProblem();
  const api = remoteApi({ base: BASE, token: TOKEN }, { fetch: (async () => json({ error: 'unauthorized' }, 401)) as typeof fetch });
  await assert.rejects(api.journal());
  assert.equal(problemStore.getState()?.kind, 'token');
  clearProblem();
});
