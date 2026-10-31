// POST /policy/draft and the persisted PUT /strategy, through the engine server: 200 with a draft, 503 whenever NEAR
// AI cannot draft (no key, down, garbage), 400 for a body that is not { text }.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ContractPolicy, PolicyDraft, StrategyConfig } from '@gimbal/shared';
import { DEFAULT_STRATEGY } from '../scanner/config.ts';
import type { Scanner } from '../scanner/scanner.ts';
import { EngineServer } from '../server.ts';
import { StrategyStore, strategyFile } from '../strategy-store.ts';
import { NearAiClient } from './client.ts';
import { PolicyDrafter, deskMarkets, policyDraftRoute } from './draft-route.ts';
import { ETH_BTC_SENTENCE, ethBtcReplies } from './recorded.ts';
import { completion, fixedFetch, fixtureBody, marketReaders } from './test-helpers.ts';

const KEY = 'test-key-0123456789abcdef';
const T0 = Date.UTC(2026, 9, 31, 12);
const POLICY: ContractPolicy = {
  hl_assets: [], phoenix_markets: [], orderly_symbols: [], max_notional_usd: 5000, price_band_bps: 100, oracle_max_age_s: 60,
  rescue_cap_usd_per_hour: 0, unpriced: [], unpriced_max_notional_usd: 0, max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 0,
};

/** The scanner is not under test here: one empty scan. */
const scanner = {
  scan: async () => ({ scan: { venues: 0, failed: [], at: T0 }, windows: [], notes: {} }),
  history: () => null,
} as unknown as Scanner;

const servers: EngineServer[] = [];
const dirs: string[] = [];
after(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function serve(options: Partial<ConstructorParameters<typeof EngineServer>[0]> = {}): Promise<{ base: string; server: EngineServer }> {
  const server = new EngineServer({
    mode: 'replay', scanner, strategy: DEFAULT_STRATEGY, policy: POLICY, intervalMs: 3_600_000, now: () => T0, ...options,
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${await server.start(0)}`, server };
}

/** A drafter whose NEAR AI answers `body`; `keyed` false = no NEAR_AI_API_KEY. */
function drafterWith(body: unknown, keyed = true): { drafter: PolicyDrafter; sent: unknown[] } {
  const { fetch, sent } = fixedFetch(body);
  const client = new NearAiClient({ apiKey: keyed ? KEY : undefined, fetch });
  return { drafter: new PolicyDrafter({ client, markets: deskMarkets(marketReaders().readers) }), sent };
}

function call(base: string, method: string, path: string, body?: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: text === '' ? null : JSON.parse(text) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const ask = (text: unknown) => JSON.stringify({ text });

test('POST /policy/draft: the recorded reply gives the draft; nothing else changes', async () => {
  const { drafter, sent } = drafterWith(fixtureBody(ethBtcReplies()[0]!.file));
  const { base, server } = await serve({ drafter });
  const res = await call(base, 'POST', '/policy/draft', ask(ETH_BTC_SENTENCE));
  assert.equal(res.status, 200);
  const draft = res.json as PolicyDraft;
  assert.equal(draft.policy.max_notional_usd, 500);
  assert.deepEqual(draft.policy.hl_assets.map((a) => a.symbol), ['ETH', 'BTC']);
  assert.equal(draft.strategy.legUsd, 500);
  assert.equal(draft.model, 'Qwen/Qwen3-VL-30B-A3B-Instruct');
  assert.equal(sent.length, 1);
  // A draft is only a proposal: the engine's rules stay as they were until the owner confirms them.
  assert.deepEqual(server.strategy, DEFAULT_STRATEGY);
  assert.equal((await call(base, 'GET', '/policy/draft')).status, 405);
});

test('POST /policy/draft without a key: 503, drafting unavailable, and NEAR AI is never called', async () => {
  const { drafter, sent } = drafterWith(completion({ symbols: ['ETH'] }), false);
  const { base } = await serve({ drafter });
  const res = await call(base, 'POST', '/policy/draft', ask('Trade ETH'));
  assert.equal(res.status, 503);
  assert.deepEqual(res.json, { error: 'drafting is unavailable: NEAR_AI_API_KEY is not set' });
  assert.equal(sent.length, 0);
  // A server with no drafter at all says the same kind of thing.
  const bare = await serve();
  assert.deepEqual(await call(bare.base, 'POST', '/policy/draft', ask('Trade ETH')), {
    status: 503, json: { error: 'drafting is unavailable: NEAR AI is not set up' },
  });
});

test('POST /policy/draft when NEAR AI answers garbage: 503 with the reason, never a half-read draft', async () => {
  const garbage: [unknown, RegExp][] = [
    [completion('{"symbols": ["ETH", "BTC"], "max_notional_usd": 5'), /the model's reply is not JSON/],
    [completion('{"reply": "ETH and BTC sound good!"}'), /the model's reply is not a draft/],
    ['<html>502 Bad Gateway</html>', /NEAR AI answered something that is not JSON/],
    [{ object: 'error' }, /not a chat completion/],
  ];
  for (const [body, why] of garbage) {
    const { drafter } = drafterWith(body);
    const { base } = await serve({ drafter });
    const res = await call(base, 'POST', '/policy/draft', ask('Trade ETH and BTC'));
    assert.equal(res.status, 503, String(why));
    assert.match((res.json as { error: string }).error, /^drafting is unavailable: /);
    assert.match((res.json as { error: string }).error, why);
  }
  // NEAR AI down: the same 503.
  const down = new PolicyDrafter({
    client: new NearAiClient({ apiKey: KEY, fetch: fixedFetch({ error: { message: 'overloaded' } }, 503).fetch }),
    markets: deskMarkets(marketReaders().readers),
  });
  const { base } = await serve({ drafter: down });
  assert.deepEqual(await call(base, 'POST', '/policy/draft', ask('Trade ETH')), {
    status: 503, json: { error: 'drafting is unavailable: NEAR AI answered HTTP 503: overloaded' },
  });
});

test('POST /policy/draft takes { text } only: 400 otherwise, before NEAR AI is asked', async () => {
  const lines: string[] = [];
  const { drafter, sent } = drafterWith(completion({ symbols: ['ETH'] }));
  const bad: [string, RegExp][] = [
    ['not json', /^POST \/policy\/draft: /],
    ['[]', /takes \{ "text": "<your rules>" \}/],
    [JSON.stringify({ text: 'Trade ETH', policy: {} }), /unknown field policy/],
    [ask(''), /text must be your rules in words/],
    [ask(42), /text must be your rules in words/],
    [ask('x'.repeat(2001)), /2001 characters, over 2000/],
  ];
  for (const [body, why] of bad) {
    const res = await policyDraftRoute(async () => body, drafter, (l) => lines.push(l));
    assert.equal(res.status, 400, body);
    assert.match((res.body as { error: string }).error, why);
  }
  assert.equal(sent.length, 0);
  assert.equal(lines.length, 0);
  // A NEAR AI failure is logged, in its one line.
  const off = await policyDraftRoute(async () => ask('Trade ETH'), drafterWith(completion('{}'), false).drafter, (l) => lines.push(l));
  assert.equal(off.status, 503);
  assert.deepEqual(lines, ['POST /policy/draft: drafting unavailable: NEAR_AI_API_KEY is not set']);
});

test('PUT /strategy is saved before it takes effect, and a restart reads it back; a failed save changes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-strategy-'));
  dirs.push(dir);
  const store = new StrategyStore(strategyFile(dir, 'replay', null));
  const { base } = await serve({ saveStrategy: (s) => store.save(s) });
  const next: StrategyConfig = { ...DEFAULT_STRATEGY, auto: true, minNetAprPct: 15, legUsd: 500 };
  const put = await call(base, 'PUT', '/strategy', JSON.stringify(next));
  assert.equal(put.status, 200);
  assert.deepEqual(store.load(POLICY), { strategy: next, problem: null });
  // The restart: the saved rules are the server's, and /state carries them.
  const restarted = await serve({ strategy: store.load(POLICY).strategy!, saveStrategy: (s) => store.save(s) });
  assert.deepEqual((await call(restarted.base, 'GET', '/strategy')).json, next);
  assert.deepEqual(((await call(restarted.base, 'GET', '/state')).json as { strategy: unknown }).strategy, next);

  const broken = await serve({ saveStrategy: async () => { throw new Error('disk full'); } });
  const res = await call(broken.base, 'PUT', '/strategy', JSON.stringify(next));
  assert.equal(res.status, 500);
  assert.deepEqual(res.json, { error: 'PUT /strategy: not saved, so nothing changed: disk full' });
  assert.deepEqual((await call(broken.base, 'GET', '/strategy')).json, DEFAULT_STRATEGY);
});
