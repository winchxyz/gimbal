import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftUnavailable, EngineError, EngineSilent, httpOnboardingEngine, parsePolicy, parsePolicyDraft } from './engine.ts';
import { fakeDraft } from './fakes.ts';
import { defaultStrategy } from './rules.ts';

/** Replaces the global fetch for one test with canned answers, and records what was sent. */
async function withFetch<T>(answers: { status: number; body: unknown }[] | Error, body: (sent: { url: string; method: string; json: unknown }[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const sent: { url: string; method: string; json: unknown }[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? 'GET', json: init?.body ? JSON.parse(String(init.body)) : null });
    if (answers instanceof Error) throw answers;
    const a = answers[i++]!;
    return { ok: a.status < 300, status: a.status, json: async () => a.body } as Response;
  }) as typeof fetch;
  try {
    return await body(sent);
  } finally {
    globalThis.fetch = original;
  }
}

const DRAFT = fakeDraft('BTC and ETH, $1,500 a side, 3x');

test('a draft from the engine is read into policy, strategy, notes and model', () => {
  const draft = parsePolicyDraft(JSON.parse(JSON.stringify(DRAFT)));
  assert.deepEqual(draft.policy, DRAFT.policy);
  assert.deepEqual(draft.strategy, DRAFT.strategy);
  assert.equal(draft.model, 'fake-model-1');
});

test('a policy without unpriced assets has none; the rest must be there', () => {
  const { unpriced: _u, unpriced_max_notional_usd: _n, ...old } = DRAFT.policy;
  const policy = parsePolicy(old);
  assert.deepEqual(policy.unpriced, []);
  assert.equal(policy.unpriced_max_notional_usd, 0);
  assert.throws(() => parsePolicy({ ...old, hl_assets: 'BTC' }), /hl_assets is not a list/);
  assert.throws(() => parsePolicy({ ...old, hl_assets: [{ symbol: 'BTC' }] }), /hl_assets\[0\] needs/);
  assert.throws(() => parsePolicy({ ...old, max_notional_usd: '1500' }), /max_notional_usd is not a number/);
  assert.throws(() => parsePolicy({ ...old, phoenix_markets: [{ symbol: 'SOL' }] }), /phoenix_markets\[0\] needs/);
  assert.throws(() => parsePolicy({ ...old, orderly_symbols: [1] }), /orderly_symbols\[0\]/);
  assert.throws(() => parsePolicy(null), /not an object/);
});

test('a draft that is not a draft is refused with what is wrong', () => {
  assert.throws(() => parsePolicyDraft(null), /not an object/);
  assert.throws(() => parsePolicyDraft({ ...DRAFT, notes: 'x' }), /notes/);
  assert.throws(() => parsePolicyDraft({ ...DRAFT, model: 3 }), /model/);
  assert.throws(() => parsePolicyDraft({ ...DRAFT, strategy: { auto: true } }), /strategy|minNetAprPct|legUsd/);
});

test('POST /policy/draft sends the words and returns the draft', async () => {
  await withFetch([{ status: 200, body: DRAFT }], async (sent) => {
    const draft = await httpOnboardingEngine('').draftPolicy('BTC and ETH');
    assert.equal(draft.policy.max_notional_usd, 1500);
    assert.deepEqual(sent[0], { url: '/policy/draft', method: 'POST', json: { text: 'BTC and ETH' } });
  });
});

test('a 503 from /policy/draft is "drafting unavailable", not a failure of the owner’s words', async () => {
  await withFetch([{ status: 503, body: { error: 'NEAR AI is not configured' } }], async () => {
    await assert.rejects(httpOnboardingEngine().draftPolicy('x'), (e: unknown) => e instanceof DraftUnavailable && /not configured/.test((e as Error).message));
  });
});

test('another refusal from /policy/draft is an engine error with its reason', async () => {
  await withFetch([{ status: 400, body: { error: 'text is empty' } }], async () => {
    await assert.rejects(httpOnboardingEngine().draftPolicy(''), (e: unknown) => e instanceof EngineError && !(e instanceof DraftUnavailable) && /text is empty/.test((e as Error).message));
  });
});

test('PUT /strategy sends the strategy, returns what the engine holds, and shows a refusal’s reason', async () => {
  await withFetch([{ status: 200, body: defaultStrategy() }, { status: 400, body: { error: 'legUsd must be from 10 to 100000' } }], async (sent) => {
    const engine = httpOnboardingEngine();
    assert.deepEqual(await engine.putStrategy(defaultStrategy()), defaultStrategy());
    assert.deepEqual(sent[0], { url: '/strategy', method: 'PUT', json: defaultStrategy() });
    await assert.rejects(engine.putStrategy({ ...defaultStrategy(), legUsd: 1 }), /legUsd must be/);
  });
});

test('POST /setup: ok starts it; ok:false and an error body are the engine’s words; a bare 2xx counts as started', async () => {
  await withFetch(
    [
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: false, reason: 'the strategy engine is not running yet' } },
      { status: 409, body: { error: 'the engine key is not on the account' } },
      { status: 202, body: null },
    ],
    async (sent) => {
      const engine = httpOnboardingEngine();
      await engine.startSetup('desk-07');
      assert.deepEqual(sent[0], { url: '/setup', method: 'POST', json: { deskId: 'desk-07' } });
      await assert.rejects(engine.startSetup('desk-07'), /not running yet/);
      await assert.rejects(engine.startSetup('desk-07'), /key is not on the account/);
      await engine.startSetup('desk-07');
    },
  );
});

test('an engine that does not answer is "silent", with nothing applied', async () => {
  await withFetch(new Error('fetch failed'), async () => {
    await assert.rejects(httpOnboardingEngine().putStrategy(defaultStrategy()), (e: unknown) => e instanceof EngineSilent && /did not answer/.test((e as Error).message));
  });
});

test('a refusal without a reason is named by its status', async () => {
  await withFetch([{ status: 500, body: null }], async () => {
    await assert.rejects(httpOnboardingEngine().startSetup('d'), /the engine answered 500/);
  });
});
