// The public live view's owner unlock: the token checked with GET /owner before it is kept, kept in sessionStorage only,
// sent in its header on writes only, and the write controls it turns on (and only those).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpApi } from '../stream/api.ts';
import { forgetOwnerToken, OWNER_HEADER, OWNER_KEY, ownerAnswer, parseOwnerToken, readOwnerToken, setOwnerTokenForTests, unlockOwner } from './owner.ts';
import { isOwnerUnlocked, setHostedLiveForTests, setRemoteSettingsForTests, writeControls, writeControlsFor } from './readonly.ts';
import { ownerApi, readOnlyApi } from './stream.ts';
import type { KeyStore } from './settings.ts';

const TOKEN = '7d1e9a4c2b8f6e0d3a5c9b1f7e2d4a6c8b0e3f5a';

function memory(): KeyStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

interface Sent { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(reply: (url: string) => Response): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: (async (input: unknown, init?: RequestInit) => {
      sent.push({
        url: String(input), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string> | undefined) },
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return reply(String(input));
    }) as typeof fetch,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('a token the engine takes (204) is kept in the tab\'s session store, under its key, and nowhere else', async () => {
  const session = memory();
  const f = fakeFetch(() => new Response(null, { status: 204 }));
  assert.deepEqual(await unlockOwner(`  ${TOKEN}\n`, { session, fetch: f.fetch }), { ok: true });
  assert.deepEqual([...session.data.entries()], [[OWNER_KEY, TOKEN]]);
  // The check: GET /owner on this origin, the token in its header, never in the address.
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.url, '/owner');
  assert.equal(f.sent[0]!.method, 'GET');
  assert.equal(f.sent[0]!.headers[OWNER_HEADER], TOKEN);
  assert.ok(!f.sent[0]!.url.includes(TOKEN));
  assert.equal(readOwnerToken(session), TOKEN);
  forgetOwnerToken(session);
  assert.equal(session.data.size, 0);
  assert.equal(readOwnerToken(session), null);
});

test('a token that is refused, or cannot be checked, is never kept', async () => {
  for (const [reply, reason] of [
    [json(403, { ok: false, error: 'owner', reason: 'the owner token was not accepted' }), /did not accept this owner token/],
    [json(403, { ok: false, error: 'owner-off' }), /off on the live engine/],
    [json(404, { ok: false, error: 'not found' }), /off on this site/],
    [json(403, { ok: false, error: 'read-only' }), /off on this site/],
    [json(429, { ok: false, error: 'owner locked' }, { 'retry-after': '900' }), /Too many tries.*about 15 min/],
    [json(502, { ok: false }), /not answering/],
  ] as const) {
    const session = memory();
    const answer = await unlockOwner(TOKEN, { session, fetch: fakeFetch(() => reply).fetch });
    assert.equal(answer.ok, false);
    assert.match((answer as { reason: string }).reason, reason);
    assert.equal(session.data.size, 0);
  }
  const session = memory();
  const down = await unlockOwner(TOKEN, { session, fetch: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch });
  assert.deepEqual(down, { ok: false, reason: 'This page could not reach the site. Nothing was unlocked.' });
  assert.equal(session.data.size, 0);
  // Not even asked for: too short, spaces, empty. The reason never quotes the value.
  for (const text of ['', 'short', `${TOKEN.slice(0, 20)} ${TOKEN.slice(20)}`]) {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    const r = await unlockOwner(text, { session, fetch: f.fetch });
    assert.equal(r.ok, false);
    assert.equal(f.sent.length, 0);
    assert.ok(text === '' || !(r as { reason: string }).reason.includes(text));
  }
  assert.equal(parseOwnerToken(TOKEN).ok, true);
  assert.equal(ownerAnswer(204, null, null).ok, true);
});

test('the token lives in sessionStorage only: no localStorage, cookie or address anywhere in the owner code', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of ['owner.ts', 'OwnerUnlock.tsx']) {
    // The code only: the comments say where the token is never kept.
    const code = readFileSync(join(here, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    assert.doesNotMatch(code, /localStorage|document\.cookie|location\.search|searchParams|history\.(push|replace)State/, file);
  }
  assert.match(readFileSync(join(here, 'owner.ts'), 'utf8'), /browserStores\(\)\.session/);
});

test('unlocked on the live view: rotate, close and the owner entry are drawn; nothing else; locked: none, as before', () => {
  try {
    setHostedLiveForTests(true);
    setRemoteSettingsForTests(undefined);
    setOwnerTokenForTests(null);
    assert.equal(isOwnerUnlocked(), false);
    assert.deepEqual(writeControls(), { close: false, rotate: false, enter: false, stress: false, owner: false, money: false, onboarding: false });
    setOwnerTokenForTests(TOKEN);
    assert.equal(isOwnerUnlocked(), true);
    assert.deepEqual(writeControls(), { close: true, rotate: true, enter: true, stress: false, owner: false, money: false, onboarding: false });
    assert.deepEqual(writeControls(), writeControlsFor(true, false, true));
    // A token in the tab means nothing off the live view (a remote engine's read-only page, the local dashboard).
    setHostedLiveForTests(false);
    setRemoteSettingsForTests({ base: 'https://engine.example', token: 'x'.repeat(40) });
    assert.equal(isOwnerUnlocked(), false);
    assert.equal(Object.values(writeControls()).some(Boolean), false);
  } finally {
    setHostedLiveForTests(undefined);
    setRemoteSettingsForTests(undefined);
    setOwnerTokenForTests(undefined);
  }
});

test('the owner API sends the owner header on rotate and close only, the demo entry in the body; reads carry none', async () => {
  const f = fakeFetch((url) => (url === '/strategy' ? json(200, {}) : json(200, { ok: true })));
  const real = globalThis.fetch;
  globalThis.fetch = f.fetch;
  try {
    const api = ownerApi(httpApi('', { [OWNER_HEADER]: TOKEN }));
    assert.deepEqual(await api.rotate('sol-phoenix-orderly', { maxLossUsd: 1 }), { ok: true });
    assert.deepEqual(await api.close(), { ok: true });
    await api.strategy().catch(() => undefined);
    assert.deepEqual(f.sent.map((s) => [s.method, s.url, s.headers[OWNER_HEADER] ?? null, s.body ?? null]), [
      ['POST', '/rotate', TOKEN, { windowId: 'sol-phoenix-orderly', demo: { maxLossUsd: 1 } }],
      ['POST', '/close', TOKEN, {}],
      ['GET', '/strategy', null, null],
    ]);
    // The stress test stays refused in the page; the locked live view refuses every write without a request.
    const before = f.sent.length;
    assert.equal((await api.stress()).ok, false);
    const locked = readOnlyApi(httpApi());
    assert.equal((await locked.rotate('sol-phoenix-orderly', { maxLossUsd: 1 })).ok, false);
    assert.equal((await locked.close()).ok, false);
    assert.equal(f.sent.length, before);
  } finally {
    globalThis.fetch = real;
  }
});
