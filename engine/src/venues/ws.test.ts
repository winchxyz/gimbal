import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSocketLike, WsEvent } from './ws.ts';
import { OrderlyReader } from './orderly.ts';
import { WsRequestClient, WsTimeoutError } from './ws.ts';

type Listener = (ev: WsEvent) => void;

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  readonly url: string;
  readonly #listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] };

  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    assert.equal(this.readyState, 1, 'sent before the socket opened');
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    this.#listeners[type]!.push(listener);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
  push(data: unknown): void {
    this.emit('message', { data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  emit(type: string, ev: WsEvent): void {
    for (const l of this.#listeners[type]!) l(ev);
  }
}

function client(options: { timeoutMs?: number; idleCloseMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const c = new WsRequestClient({
    ...options,
    webSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    keepAlive: (m) => (m.event === 'ping' ? { event: 'pong', ts: m.ts } : null),
  });
  return { c, sockets };
}

test('frames wait for the socket to open, then answers are matched by id, in any order', async () => {
  const { c, sockets } = client();
  const a = c.request('wss://x/1', { id: 'a', q: 1 });
  const b = c.request('wss://x/1', { id: 'b', q: 2 });
  assert.equal(sockets.length, 1, 'one connection per URL');
  assert.deepEqual(sockets[0]!.sent, []);
  sockets[0]!.open();
  assert.deepEqual(sockets[0]!.sent, [{ id: 'a', q: 1 }, { id: 'b', q: 2 }]);
  sockets[0]!.push('not json');
  sockets[0]!.push({ id: 'zzz', r: 0 });
  sockets[0]!.push({ id: 'b', r: 2 });
  sockets[0]!.push({ id: 'a', r: 1 });
  assert.deepEqual(await Promise.all([a, b]), [{ id: 'a', r: 1 }, { id: 'b', r: 2 }]);
  // An open socket sends at once.
  const c2 = c.request('wss://x/1', { id: 'c' });
  assert.deepEqual(sockets[0]!.sent.at(-1), { id: 'c' });
  sockets[0]!.push({ id: 'c', ok: true });
  await c2;
  c.close();
});

test('keep-alive frames get their reply and resolve nothing', async () => {
  const { c, sockets } = client();
  const a = c.request('wss://x/1', { id: 'a' });
  sockets[0]!.open();
  sockets[0]!.push({ event: 'ping', ts: 9 });
  assert.deepEqual(sockets[0]!.sent, [{ id: 'a' }, { event: 'pong', ts: 9 }]);
  sockets[0]!.push({ id: 'a' });
  await a;
  c.close();
});

test('a request id already in flight is refused; a silent server times out', async () => {
  const { c, sockets } = client({ timeoutMs: 20 });
  const a = c.request('wss://x/1', { id: 'a' });
  await assert.rejects(c.request('wss://x/1', { id: 'a' }), /already in flight/);
  sockets[0]!.open();
  await assert.rejects(a, WsTimeoutError);
  await assert.rejects(a, /no answer to a within 20 ms/);
  c.close();
});

test('close, a server close and a socket error reject what is in flight; the next request reconnects', async () => {
  const { c, sockets } = client();
  const a = c.request('wss://x/1', { id: 'a' });
  c.close();
  await assert.rejects(a, /client closed/);
  const b = c.request('wss://x/1', { id: 'b' });
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  sockets[1]!.readyState = 3;
  sockets[1]!.emit('close', { code: 1006, reason: 'gone' });
  await assert.rejects(b, /closed \(1006 gone\)/);
  const d = c.request('wss://x/1', { id: 'd' });
  sockets[2]!.emit('error', { message: 'boom' });
  await assert.rejects(d, /error boom/);
  c.close();
});

test('an idle connection is closed after its last answer, so a process can exit', async () => {
  const { c, sockets } = client({ idleCloseMs: 10 });
  const a = c.request('wss://x/1', { id: 'a' });
  sockets[0]!.open();
  sockets[0]!.push({ id: 'a' });
  await a;
  assert.equal(sockets[0]!.readyState, 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sockets[0]!.readyState, 3);
  c.close();
});

test('several Orderly books at once on one client: one account id borrowed, one socket, every answer to its own request', async () => {
  const { c, sockets } = client({ timeoutMs: 1_000 });
  const account = `0x${'ab'.repeat(32)}`;
  const calls: string[] = [];
  const fetchFake = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const data = path === '/v1/public/query' ? { rows: [{ address: `0x${'12'.repeat(20)}`, broker_id: 'woofi_pro' }] } : { account_id: account };
    return new Response(JSON.stringify({ success: true, data }), { status: 200 });
  }) as typeof fetch;
  const reader = new OrderlyReader({ network: 'mainnet', fetch: fetchFake, wsRequest: c.request, publicWsUrl: 'wss://x/stream/' });
  const symbols = ['PERP_DOGE_USDC', 'PERP_LTC_USDC', 'PERP_XLM_USDC', 'PERP_ZEC_USDC'];
  const books = Promise.all(symbols.map((s) => reader.book(s, 5)));
  // The borrow answers in the background; then every request is queued on the one socket being opened.
  for (let i = 0; i < 20 && sockets.length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]!.url, `wss://x/stream/${account}`);
  sockets[0]!.open();
  const sent = sockets[0]!.sent as { id: string; params: { symbol: string } }[];
  assert.deepEqual(sent.map((f) => f.params.symbol), symbols);
  assert.equal(new Set(sent.map((f) => f.id)).size, symbols.length, 'one id per request');
  // Answered in reverse order, with a keep-alive in between.
  for (const f of [...sent].reverse()) {
    sockets[0]!.push({ event: 'ping', ts: 1 });
    sockets[0]!.push({ id: f.id, event: 'request', success: true, data: { symbol: f.params.symbol, ts: 7, bids: [[1, 2]], asks: [[1.1, 3]] } });
  }
  assert.deepEqual((await books).map((b) => b.symbol), symbols);
  assert.deepEqual(calls, ['/v1/public/query', '/v1/get_account'], 'the account id is borrowed once for all four');
  reader.close();
  c.close();
});

test('a socket that never opens is dropped when its requests time out: the next request connects again', async () => {
  const { c, sockets } = client({ timeoutMs: 20 });
  const a = c.request('wss://x/1', { id: 'a' });
  const b = c.request('wss://x/1', { id: 'b' });
  await assert.rejects(a, /no answer to a within 20 ms/);
  await assert.rejects(b, WsTimeoutError);
  assert.equal(sockets[0]!.readyState, 3, 'the stuck socket is closed');
  const d = c.request('wss://x/1', { id: 'd' });
  assert.equal(sockets.length, 2, 'a new connection');
  sockets[1]!.open();
  sockets[1]!.push({ id: 'd', ok: true });
  assert.deepEqual(await d, { id: 'd', ok: true });
  c.close();
});

test('an open socket that says nothing is dropped on a timeout; one that answers other requests is kept', async () => {
  const { c, sockets } = client({ timeoutMs: 20 });
  const a = c.request('wss://x/1', { id: 'a' });
  sockets[0]!.open();
  await assert.rejects(a, WsTimeoutError);
  assert.equal(sockets[0]!.readyState, 3);
  const b = c.request('wss://x/1', { id: 'b' });
  const e = c.request('wss://x/1', { id: 'e' });
  sockets[1]!.open();
  sockets[1]!.push({ id: 'e' });
  await e;
  await assert.rejects(b, WsTimeoutError);
  assert.equal(sockets[1]!.readyState, 1, 'it answered after b went out: kept');
  c.close();
});
