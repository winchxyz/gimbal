import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeOf, reasonText } from './manual.ts';

const rotate = { kind: 'rotate', from: 'DOGE', to: 'NEAR', windowId: 'near-phoenix-orderly' } as const;
const close = { kind: 'close', symbol: 'DOGE' } as const;

test('the engine’s reason is shown as a sentence', () => {
  assert.equal(reasonText('the strategy engine is not running yet: nothing is entered or closed'), 'The strategy engine is not running yet: nothing is entered or closed.');
  assert.equal(reasonText('  switch costs more than it earns. '), 'Switch costs more than it earns.');
  assert.equal(reasonText('Already closed!'), 'Already closed!');
});

test('a refusal says what the engine said and that nothing changed', () => {
  const refused = outcomeOf(rotate, { ok: false, reason: 'NEAR is vetoed' });
  assert.deepEqual(refused, { tone: 'refused', title: 'Not sent', text: 'The engine refused it. NEAR is vetoed. DOGE is still held.' });
  assert.equal(outcomeOf(close, { ok: false, reason: 'nothing is held' }).text, 'The engine refused it. Nothing is held. Both DOGE legs are still open.');
  assert.equal(outcomeOf({ kind: 'close', symbol: null }, { ok: false, reason: 'paused' }).text, 'The engine refused it. Paused. Both legs are still open.');
});

test('an accepted request says where the rest of it shows up', () => {
  assert.deepEqual(outcomeOf(rotate, { ok: true }), {
    tone: 'sent',
    title: 'Sent',
    text: 'The engine checks the rotation again, then closes DOGE and opens NEAR. Follow it in the Journal.',
  });
  assert.equal(outcomeOf(close, { ok: true }).text, 'The engine closes both legs with reduce-only orders. Follow it in the Journal.');
});

test('no answer at all does not claim either way', () => {
  const unknown = outcomeOf(close, new Error('POST /close: the engine did not answer'));
  assert.equal(unknown.tone, 'unknown');
  assert.equal(unknown.title, 'No answer');
  assert.match(unknown.text, /cannot tell whether it was sent\. Check the Journal before you try again\.$/);
});

// ---------- the two POST calls, through the real HTTP client with a fake fetch ----------

import { httpApi } from '../stream/api.ts';
import { confirmText, sendVia } from './manual.ts';

interface Sent { url: string; method: string | undefined; body: unknown }

/** Runs `run` with `fetch` replaced by `reply`; returns what it gave back and what was sent. */
async function withFetch<T>(reply: (url: string) => Response | Promise<Response>, run: () => Promise<T>): Promise<{ sent: Sent[]; result: T }> {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return reply(String(input));
  }) as typeof fetch;
  try {
    return { sent, result: await run() };
  } finally {
    globalThis.fetch = real;
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the confirm questions name what is closed and what replaces it', () => {
  assert.equal(confirmText(close), 'Close both legs now?');
  assert.equal(confirmText(rotate), 'Rotate DOGE to NEAR? Both DOGE legs close and NEAR opens.');
});

test('POST /close: the engine takes it', async () => {
  const { sent, result } = await withFetch(() => json(200, { ok: true }), () => sendVia(httpApi(), close));
  assert.deepEqual(sent.map((s) => [s.url, s.method]), [['/close', 'POST']]);
  assert.equal(result.tone, 'sent');
});

test('POST /rotate: sends the window id, and a refusal comes back with its reason', async () => {
  const { sent, result } = await withFetch(() => json(200, { ok: false, reason: 'switch costs more than it earns' }), () => sendVia(httpApi(), rotate));
  assert.deepEqual(sent.map((s) => [s.url, s.method, s.body]), [['/rotate', 'POST', { windowId: 'near-phoenix-orderly' }]]);
  assert.equal(result.tone, 'refused');
  assert.match(result.text, /Switch costs more than it earns\./);
  assert.match(result.text, /DOGE is still held/);
});

test('a route the engine does not serve (non-2xx with its reason) is a refusal, not a crash', async () => {
  const { result } = await withFetch(() => json(501, { ok: false, reason: 'replay is read-only' }), () => sendVia(httpApi(), close));
  assert.equal(result.tone, 'refused');
  assert.match(result.text, /Replay is read-only\./);
});

test('a non-2xx with no usable body, and a network error, both say there was no answer and never throw', async () => {
  const page = await withFetch(() => new Response('<html>not found</html>', { status: 404 }), () => sendVia(httpApi(), close));
  assert.equal(page.result.tone, 'unknown');
  const down = await withFetch(() => Promise.reject(new TypeError('fetch failed')), () => sendVia(httpApi(), rotate));
  assert.equal(down.result.tone, 'unknown');
  assert.match(down.result.text, /did not answer/);
});

test('a rotate refused for an Orderly leg reads as sentences, and says the pair is still held', () => {
  const reason = "not rotated: the held XLM pair has an Orderly leg (PERP_XLM_USDC): its close arms the trader's replay watch (Orderly takes a signed copy of an order for up to 300 s), so no other pair could open after it and the rotate would leave the desk flat";
  const out = outcomeOf(rotate, { ok: false, reason });
  assert.equal(out.tone, 'refused');
  assert.match(out.text, /^The engine refused it\. The held XLM pair has an Orderly leg\. .* The pair exits on its own rules instead\. DOGE is still held\.$/);
});
