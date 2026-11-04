// The view client: what each request carries (a bearer header, no credentials, no token in the address) and how each
// refusal is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createViewClient, engineReachable, retryAfterMs, viewErrorText, ViewError, type ViewClient } from './view.ts';

const BASE = 'https://engine.test';
const TOKEN = 'tok-0123456789abcdef0123456789abcdef';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response> | Error) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    const result = await answer(call);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { calls, fn };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const clientOf = (answer: (call: Call) => Response | Promise<Response> | Error, now = () => 1_000_000): { client: ViewClient; calls: Call[] } => {
  const f = fakeFetch(answer);
  return { client: createViewClient({ base: BASE, token: TOKEN }, { fetch: f.fn, now }), calls: f.calls };
};

const failure = async (promise: Promise<unknown>): Promise<ViewError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ViewError, 'a ViewError');
    return error;
  }
  throw new Error('expected a refusal');
};

test('a read sends the bearer token in one header, no credentials, and no token in the address', async () => {
  const { client, calls } = clientOf(() => json({ ok: 1 }));
  await client.getJson('/state');
  await client.getJson('/journal?before=abc');
  await client.getJson('/strategy');
  await client.getJson('/windows/history?id=w1');
  assert.deepEqual(calls.map((c) => c.url), [`${BASE}/state`, `${BASE}/journal?before=abc`, `${BASE}/strategy`, `${BASE}/windows/history?id=w1`]);
  for (const { url, init } of calls) {
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.method, undefined, 'GET');
    assert.ok(!url.includes(TOKEN) && !/token=/i.test(url));
  }
});

test('the ticket comes from /view-ticket with the bearer header, and the stream address carries the ticket, never the token', async () => {
  const { client, calls } = clientOf(() => json({ ticket: 'a.b/c+d', expiresAt: 5 }));
  const ticket = await client.ticket();
  assert.equal(ticket, 'a.b/c+d');
  assert.equal(calls[0]?.url, `${BASE}/view-ticket`);
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
  const url = client.eventsUrl(ticket);
  assert.equal(url, `${BASE}/events?ticket=a.b%2Fc%2Bd`);
  assert.ok(!url.includes(TOKEN));
});

test('an answer with no ticket is an error, not an empty address', async () => {
  const { client } = clientOf(() => json({ expiresAt: 5 }));
  assert.equal((await failure(client.ticket())).kind, 'status');
});

test('401 reads as a rejected token; 403 as a site the engine does not list', async () => {
  const a = await failure(clientOf(() => json({ error: 'unauthorized' }, 401)).client.getJson('/state'));
  assert.equal(a.kind, 'token');
  assert.equal(viewErrorText(a).title, 'Token rejected');
  const b = await failure(clientOf(() => json({ error: 'origin not allowed' }, 403)).client.getJson('/state'));
  assert.equal(b.kind, 'origin');
  assert.match(viewErrorText(b).text, /This site is not allowed by the engine/);
});

test('after a 401 nothing more is sent with that token, so the engine’s count of failures stops at one', async () => {
  const { client, calls } = clientOf(() => json({ error: 'unauthorized' }, 401));
  assert.equal((await failure(client.getJson('/state'))).kind, 'token');
  for (const path of ['/strategy', '/journal?before=a', '/view-ticket']) assert.equal((await failure(client.getJson(path))).kind, 'token');
  assert.equal(calls.length, 1);
});

test('a 401 on the stream is a ticket the engine did not take, not a rejected token', async () => {
  const { client } = clientOf(() => json({ error: 'ticket not valid' }, 401));
  assert.equal((await failure(client.probeStream('t'))).kind, 'status');
});

test('503 on /events reads as too many streams; 503 elsewhere is just an engine error', async () => {
  const { client } = clientOf(() => json({ error: 'too many streams open' }, 503));
  const e = await failure(client.probeStream('t'));
  assert.equal(e.kind, 'streams');
  assert.equal(viewErrorText(e).title, 'Too many streams open');
  assert.equal((await failure(client.getJson('/state'))).kind, 'status');
});

test('a probe that is accepted ends the stream at once', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel: () => void (cancelled = true) });
  const { client, calls } = clientOf(() => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  await client.probeStream('t');
  assert.equal(cancelled, true);
  assert.equal(calls[0]?.url, `${BASE}/events?ticket=t`);
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, undefined, 'the stream takes its ticket in the address, not the token');
});

test('429 waits for Retry-After and sends nothing meanwhile', async () => {
  let clock = 1_000_000;
  const { client, calls } = clientOf(() => json({ error: 'slow down' }, 429, { 'retry-after': '12' }), () => clock);
  const e = await failure(client.getJson('/state'));
  assert.equal(e.kind, 'limited');
  assert.equal(e.retryAfterMs, 12_000);
  assert.match(viewErrorText(e).text, /wait 12 s/);
  assert.equal(calls.length, 1);

  clock += 5000;
  const again = await failure(client.getJson('/strategy'));
  assert.equal(again.kind, 'limited');
  assert.equal(again.retryAfterMs, 7000, 'what is left of the wait');
  assert.equal(calls.length, 1, 'no request went out inside the wait');

  clock += 7000;
  await failure(client.getJson('/state'));
  assert.equal(calls.length, 2, 'after the wait the next read goes out');
});

test('Retry-After: seconds, a date, nothing, nonsense', () => {
  assert.equal(retryAfterMs('7', 0), 7000);
  assert.equal(retryAfterMs('0', 0), 1000);
  assert.equal(retryAfterMs(new Date(30_000).toUTCString(), 0), 30_000);
  assert.equal(retryAfterMs(null, 0), 60_000);
  assert.equal(retryAfterMs('soon', 0), 60_000);
  assert.equal(retryAfterMs('999999', 0), 300_000, 'never more than five minutes');
});

test('a request that cannot be read is told apart by /healthz: the engine answers, so the site is refused; it does not, so it is down', async () => {
  const refused = clientOf((call) => (call.url.endsWith('/healthz') ? new Response(null, { status: 200 }) : new TypeError('Failed to fetch')));
  const a = await failure(refused.client.getJson('/state'));
  assert.equal(a.kind, 'origin');
  const health = refused.calls.find((c) => c.url.endsWith('/healthz'));
  assert.equal(health?.init.mode, 'no-cors');
  assert.equal(health?.init.credentials, 'omit');
  assert.equal((health?.init.headers as unknown), undefined, 'no token goes to /healthz');

  const down = clientOf(() => new TypeError('Failed to fetch'));
  const b = await failure(down.client.getJson('/state'));
  assert.equal(b.kind, 'unreachable');
  assert.equal(viewErrorText(b).title, 'Engine not reachable');
});

test('a request that times out is not reachable, whatever /healthz says', async () => {
  const slow = clientOf((call) => (call.url.endsWith('/healthz') ? new Response(null, { status: 200 }) : new DOMException('timeout', 'TimeoutError')));
  assert.equal((await failure(slow.client.getJson('/state'))).kind, 'unreachable');
});

test('engineReachable only asks whether anything answers', async () => {
  assert.equal(await engineReachable(BASE, { fetch: fakeFetch(() => new Response(null)).fn }), true);
  assert.equal(await engineReachable(BASE, { fetch: fakeFetch(() => new TypeError('x')).fn }), false);
});
