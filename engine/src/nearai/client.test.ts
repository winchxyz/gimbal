// The NEAR AI client: what it sends, and that every failure is NearAiUnavailable with a reason that never holds the key.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEAR_AI_MODEL, NEAR_AI_URL, NearAiClient, NearAiUnavailable } from './client.ts';
import { completion, fixedFetch } from './test-helpers.ts';

const KEY = 'test-key-0123456789abcdef';
const ASK = [{ role: 'user' as const, content: 'hello' }];

test('sends the chat completion NEAR AI Cloud takes: the model, JSON output, temperature 0, the key as a Bearer header', async () => {
  const { fetch, sent } = fixedFetch(completion({ ok: true }));
  const client = new NearAiClient({ apiKey: KEY, fetch });
  const { value, raw } = await client.completeJson(ASK);
  assert.deepEqual(value, { ok: true });
  assert.equal((raw as { object: string }).object, 'chat.completion');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, NEAR_AI_URL);
  assert.equal(NEAR_AI_URL, 'https://cloud-api.near.ai/v1/chat/completions');
  assert.equal(sent[0]!.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent[0]!.headers['content-type'], 'application/json');
  assert.equal(sent[0]!.body.model, 'Qwen/Qwen3-VL-30B-A3B-Instruct');
  assert.equal(NEAR_AI_MODEL, 'Qwen/Qwen3-VL-30B-A3B-Instruct');
  assert.deepEqual(sent[0]!.body.response_format, { type: 'json_object' });
  assert.equal(sent[0]!.body.temperature, 0);
  assert.deepEqual(sent[0]!.body.messages, ASK);
  // Plain text (journal lines, later) asks for no JSON format.
  await client.complete(ASK);
  assert.equal(sent[1]!.body.response_format, undefined);
});

test('no key: unavailable at once, and nothing is sent', async () => {
  for (const apiKey of [undefined, '', '   ']) {
    const { fetch, sent } = fixedFetch(completion({}));
    const client = new NearAiClient({ apiKey, fetch });
    assert.equal(client.configured, false);
    await assert.rejects(client.completeJson(ASK), (err: unknown) => err instanceof NearAiUnavailable && /NEAR_AI_API_KEY is not set/.test(err.message));
    assert.equal(sent.length, 0);
  }
});

test('an HTTP error says its status and message, with the key cut out', async () => {
  const { fetch } = fixedFetch({ error: { message: `Invalid API key ${KEY} for this project` } }, 401);
  const client = new NearAiClient({ apiKey: KEY, fetch });
  await assert.rejects(client.completeJson(ASK), (err: unknown) => {
    assert.ok(err instanceof NearAiUnavailable);
    assert.match(err.message, /^NEAR AI answered HTTP 401: Invalid API key … for this project$/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
  const html = new NearAiClient({ apiKey: KEY, fetch: fixedFetch('<html>Bad gateway</html>', 502).fetch });
  await assert.rejects(html.completeJson(ASK), /^NearAiUnavailable: NEAR AI answered HTTP 502$/);
});

test('no answer: a network error or a timeout is unavailable, with the key cut out', async () => {
  const down = (async () => {
    throw new TypeError(`fetch failed (key ${KEY})`);
  }) as unknown as typeof fetch;
  await assert.rejects(new NearAiClient({ apiKey: KEY, fetch: down }).completeJson(ASK), (err: unknown) => {
    assert.ok(err instanceof NearAiUnavailable);
    assert.equal(err.message, 'NEAR AI did not answer: fetch failed (key …)');
    return true;
  });
  const hang = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as unknown as typeof fetch;
  await assert.rejects(new NearAiClient({ apiKey: KEY, fetch: hang, timeoutMs: 20 }).completeJson(ASK), /did not answer: no answer within 0\.02 s/);
});

test('garbage: a body that is not JSON or not a chat completion, a cut-off reply, a reply that is not one JSON object', async () => {
  const cases: [unknown, RegExp][] = [
    ['<html>maintenance</html>', /answered something that is not JSON/],
    [{ data: [] }, /not a chat completion/],
    [{ choices: [{ message: { content: null } }] }, /not a chat completion/],
    [completion('{"symbols": ["ETH"', 'length'), /cut off at its token limit/],
    [completion('Sure! Here is your policy: ETH and BTC.'), /reply is not JSON/],
    [completion('["ETH", "BTC"]'), /JSON but not an object/],
  ];
  for (const [body, why] of cases) {
    const client = new NearAiClient({ apiKey: KEY, fetch: fixedFetch(body).fetch });
    await assert.rejects(client.completeJson(ASK), (err: unknown) => err instanceof NearAiUnavailable && why.test(err.message), String(why));
  }
});
